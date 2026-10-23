'use strict';
/* The link loader: paste a task link, get the page text and every file the page offers, on the owner's own machine.

     createLinkLoader({ root, chromePath, spawnFn, clock, headless, timeouts, allowLoopback, limits })
       root           the Studio project folder; everything is written under <root>/private/ (links/<id>/, link-profile/, link-mappings.json)
       chromePath     use exactly this browser (default: FINANCE_STUDIO_CHROME, CHROME_BIN, then Google Chrome or Chromium in /Applications
                      and the usual Linux places)
       spawnFn        replaces child_process.spawn (tests; a test that runs as root adds --no-sandbox here, the product never does)
       clock          () => Date or milliseconds
       headless       false (default): a visible Chrome window, where the owner signs in once; true: no window (tests)
       timeouts       lower or change a wait: { navigation, settle, signIn, person, poll, stall, file, begin } in ms
       allowLoopback  test only: also accept http://127.0.0.1 and http://localhost links
       limits         test only, lowered never raised: { files, fileBytes, totalBytes }
     returns { start(url) -> id, get(id) -> state, continue(id) -> state, cancel(id) -> state, waitFor(id) -> final state,
               shutdown() }       one load at a time; a refusal throws LinkError with .status (400, 404, 409) and .code

   State (also what GET /api/links/:id returns; every value is plain JSON):
     { id, state, message, page: { origin, path }, toggle: { found, label, flipped, filesBefore, filesAfter, learned },
       files: [{ name, size, sha256, group, label }], sections: [{ heading, chars }], folder, error }
     state: starting -> needs-sign-in (poll until the tab is back on the task page) -> loading -> needs-person (the show-all-files
            switch could not be found or did not add files; continue() when done) -> downloading -> done | failed | cancelled.
            A final state is only reported once Chrome has been closed and the profile scrubbed.
     toggle.flipped: the switch is on (the loader clicked it, or the person did). toggle.learned: its label came from, or was just
            stored in, <root>/private/link-mappings.json for this host. error: null, or the same sentence as message when failed.
   Files land in <folder>/files/<sanitised unique name>; <folder>/page.json holds { sections: [{ heading, text }], fileList, page,
   loadedAt } (text capped at 20,000 characters per section, 200 sections). Caps: 300 files, 200 MB per file, 2 GB in all.

   The link (it can carry a signature) lives in this module's memory for the length of the load: not on Chrome's command line, not in a
   log, an error, the state or a file; only origin and path are ever shown (safeUrl). */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { findChromeBinary, usableBinary, launchBrowser } = require('./chrome.cjs');
const { Tab, safeText, waitForSettled } = require('./tab.cjs');
const { takePage, fileCandidates, findAllFilesToggle, TOGGLE_LABEL_RE } = require('./page.cjs');
const { classifyPage, LOGIN_PATH_RE, CHALLENGE_RE } = require('./auth-wall.cjs');
const { DownloadManager } = require('./downloads.cjs');
const { validateLink, fileUrlAllowed } = require('./url.cjs');
const store = require('./store.cjs');
const { CdpError } = require('./cdp.cjs');

const LIMITS = { files: 300, fileBytes: 200 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024, sections: 200, sectionChars: 20000 };
const TIMEOUTS = { navigation: 30000, settle: 15000, signIn: 10 * 60 * 1000, person: 10 * 60 * 1000, poll: 1000, stall: 60000, file: 10 * 60 * 1000, begin: 15000 };
const ID_RE = /^lnk-[0-9a-f]{12}$/;
const FINAL = new Set(['done', 'failed', 'cancelled']);
const PERSON_MESSAGE = 'Turn on the option that shows all files in the Chrome window, then press Continue.';

/* A refusal with an HTTP style status: 400 for a bad link, 404 for an unknown load, 409 for a busy loader or a load that is not waiting. */
class LinkError extends Error {
  constructor(message, status = 400, code = 'refused') {
    super(message);
    this.name = 'LinkError';
    this.status = status;
    this.code = code;
  }
}

/* page-side constant functions (see tab.evalFn) */
const clickPath = (selector) => { const el = selector ? document.querySelector(selector) : null; if (!el) return false; el.click(); return true; };
const probePage = () => ({
  href: location.href, ready: document.readyState === 'complete',
  pw: Boolean(document.querySelector('input[type=password],input[autocomplete=one-time-code],.g-recaptcha,.h-captcha,.cf-turnstile,[data-sitekey]')),
  text: (document.title + ' ' + (document.body ? document.body.innerText : '')).slice(0, 600),
});

const waited = (ms) => {
  const [n, unit] = ms >= 60000 ? [Math.round(ms / 60000), 'minute'] : [Math.max(1, Math.round(ms / 1000)), 'second'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
};

/* The toggle that went from off to on between two lists of toggles (same element, found by path), or null. */
function changedToggle(before, after) {
  const key = (t, i) => t.path || `#${i}:${t.label}`;
  const was = new Map(before.map((t, i) => [key(t, i), t.checked]));
  return after.find((t, i) => t.checked && was.get(key(t, i)) === false) || null;
}

function createLinkLoader(options = {}) {
  if (typeof options.root !== 'string' || !path.isAbsolute(options.root)) throw new TypeError('createLinkLoader needs root, the absolute path of the Studio project folder');
  const root = path.resolve(options.root);
  const privateDir = path.join(root, 'private');
  const linksDir = path.join(privateDir, 'links');
  const profileDir = path.join(privateDir, 'link-profile');
  const mappingsFile = path.join(privateDir, 'link-mappings.json');
  const headless = options.headless === true;
  const allowLoopback = options.allowLoopback === true;
  const timeouts = { ...TIMEOUTS, ...(options.timeouts || {}) };
  const lower = (value, max) => (Number.isFinite(value) && value > 0 ? Math.min(value, max) : max);
  const limits = { ...LIMITS, files: lower((options.limits || {}).files, LIMITS.files), fileBytes: lower((options.limits || {}).fileBytes, LIMITS.fileBytes), totalBytes: lower((options.limits || {}).totalBytes, LIMITS.totalBytes) };
  const now = () => { const c = typeof options.clock === 'function' ? options.clock() : Date.now(); return c instanceof Date ? c.getTime() : Number(c); };
  const jobs = new Map();
  let current = null;

  const blank = (id, v, folder) => ({
    id, state: 'starting', message: 'Starting Chrome.', page: { origin: v.origin, path: v.path },
    toggle: { found: false, label: '', flipped: false, filesBefore: 0, filesAfter: 0, learned: false },
    files: [], sections: [], folder, error: null,
  });
  const need = (id) => { const job = typeof id === 'string' && ID_RE.test(id) ? jobs.get(id) : null; if (!job) throw new LinkError('There is no such load.', 404, 'unknown'); return job; };
  const view = (job) => structuredClone(job.st);

  /* The final state is only set once, by the end of run() or by cancel(). */
  const set = (job, state, message) => { if (!FINAL.has(job.st.state)) { job.st.state = state; job.st.message = message; } };

  async function run(job) {
    const st = job.st;
    const signal = job.abort.signal;
    const cancelledError = () => new CdpError('Cancelled.', { code: 'CANCELLED' });
    let browser = null; let dl = null; let outcome = null;
    const check = () => {
      if (signal.aborted) throw cancelledError();
      if (browser && browser.cdp.closed) throw new CdpError('The browser closed the pipe.', { code: 'PIPE_CLOSED' });   /* the window was closed, or Chrome died */
    };
    const settle = () => waitForSettled(job.tab, { maxMs: timeouts.settle, signal });
    const stageDir = path.join(st.folder, '.incoming');
    const destDir = path.join(st.folder, 'files');
    try {
      fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });   /* the project's own folder: created if missing, otherwise left as it is */
      store.ensurePrivateDir(linksDir);
      store.ensurePrivateDir(profileDir);
      const binary = options.chromePath || findChromeBinary();
      if (options.chromePath && !usableBinary(binary)) throw new LinkError('The Chrome path is not an executable file that only you can write to.', 500, 'chrome');
      browser = await launchBrowser({ binary, profileDir, headless, spawnFn: options.spawnFn });
      job.browser = browser;
      check();
      /* Windows the page opens by itself are closed on sight (they would run unwatched), except while the person is using the window. */
      const own = new Set();
      browser.cdp.on('Target.targetCreated', (p) => {
        const info = p.targetInfo;
        if (info.type === 'page' && info.openerId && !own.has(info.targetId) && !job.popupsOk) browser.cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
      });
      await browser.cdp.send('Target.setDiscoverTargets', { discover: true });
      /* Our own tab FIRST, then close every other page: with a visible window Chrome quits when the last tab closes. */
      const tab = await Tab.open(browser.cdp, { newWindow: browser.headless });
      job.tab = tab;
      own.add(tab.targetId);
      for (const info of (await browser.cdp.send('Target.getTargets')).targetInfos) if (info.type === 'page' && info.targetId !== tab.targetId) await browser.cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {});

      /* One load: navigate, settle, read the page, classify it. */
      const loadOnce = async () => {
        let nav;
        try { nav = await tab.navigate(job.href, { timeout: timeouts.navigation }); }
        catch (e) { if (e.code !== 'TIMEOUT') throw e; nav = { errorText: `no answer within ${timeouts.navigation} ms`, isDownload: false }; }
        if (!nav.errorText) { try { await tab.waitForLoad({ timeout: 20000 }); } catch (e) { /* settle reports it */ } }
        const failed = Boolean(nav.errorText) && !nav.isDownload;
        if (!failed) await settle();
        let snap = null;
        if (!nav.errorText) { try { snap = await takePage(tab); } catch (e) { check(); } }
        const cls = classifyPage({ ignoreChallengeWords: job.said, requestedUrl: job.href, finalUrl: snap ? snap.url : null, hops: tab.net.hops, mainResponse: tab.net.mainResponse, api: tab.net.apiErrors, snapshot: snap, navError: failed ? safeText(nav.errorText, 80) : null });
        return { snap, cls };
      };

      /* A wait for the person: poll every `poll` ms, or at once when continue() is called, until `done()` says yes or the deadline. */
      const waitPerson = async (done, ms, tooLate) => {
        const deadline = now() + ms;
        job.popupsOk = true;
        try {
          for (;;) {
            check();
            if (await done()) return;
            if (now() > deadline) throw new LinkError(tooLate, 408, 'timeout');
            await new Promise((resolve) => { const t = setTimeout(finish, timeouts.poll); function finish() { clearTimeout(t); job.wake = null; resolve(); } job.wake = finish; });
          }
        } finally { job.popupsOk = false; }
      };
      const origin = new URL(job.href).origin;
      /* "Back on the task page": the platform's own host again, not a login path, no password, code or CAPTCHA field, no browser-check
         words, the document finished. The probe reads no field values. */
      const signedIn = async () => {
        if (job.pressed) { job.pressed = false; job.said = true; return true; }   /* the person pressed Continue: believe it and look again */
        const probe = await tab.evalFn(probePage, null, { timeout: 3000, retries: 0 }).catch(() => null);
        if (!probe || !probe.ready || probe.pw || CHALLENGE_RE.test(probe.text)) return false;
        try { const u = new URL(probe.href); return u.origin === origin && !LOGIN_PATH_RE.test(u.pathname); } catch (e) { return false; }
      };

      let page = await loadOnce();
      const signInDeadline = now() + timeouts.signIn;
      for (let round = 1; page.cls.state === 'needs-sign-in' || page.cls.state === 'needs-person'; round += 1) {
        if (round > 3) throw new LinkError('The platform keeps asking for a sign-in. Sign in again and start the load again.', 502, 'sign-in-loop');
        /* While the person types a password the network domain is off, so no event can carry what was typed; it is switched on again after.
           It goes off BEFORE the state says "sign in". */
        await tab.pauseNetwork();
        set(job, 'needs-sign-in', page.cls.reason);
        await waitPerson(signedIn, Math.max(0, signInDeadline - now()), `Sign-in did not finish within ${waited(timeouts.signIn)}.`);
        await tab.enableNetwork();
        set(job, 'loading', 'Signed in. Opening the task page.');
        page = await loadOnce();
      }
      if (page.cls.state !== 'ready') throw new LinkError(page.cls.reason, 502, page.cls.state);
      if (!page.snap) throw new LinkError('The link did not open a web page.', 502, 'not-a-page');
      set(job, 'loading', 'Reading the page.');

      /* "Show all files": click the switch (learned for this host, or by its label), see whether the file list grew. */
      let snap = page.snap;
      const before = fileCandidates(snap);
      const learnedLabel = store.learnedToggle(mappingsFile, job.host);
      const pick = findAllFilesToggle(snap.toggles, learnedLabel);
      const usedLearned = Boolean(pick && learnedLabel && pick.label.trim().toLowerCase() === learnedLabel.trim().toLowerCase());
      let list = before;
      Object.assign(st.toggle, { filesBefore: before.length, filesAfter: before.length, found: Boolean(pick), label: pick ? pick.label : '', learned: usedLearned });
      if (pick && pick.path && await tab.evalFn(clickPath, pick.path)) {
        await settle();
        snap = await takePage(tab);
        list = fileCandidates(snap);
        const now2 = snap.toggles.find((t) => t.path === pick.path && t.label === pick.label);
        st.toggle.flipped = Boolean((now2 && now2.checked) || list.length > before.length);
        st.toggle.filesAfter = list.length;
      }
      if (!st.toggle.flipped || (list.length <= before.length && !usedLearned)) {
        set(job, 'needs-person', PERSON_MESSAGE);
        const baseline = snap.toggles;
        await waitPerson(async () => job.st.state !== 'needs-person', timeouts.person, `No answer within ${waited(timeouts.person)}.`);   /* continue() moves the state on */
        await settle();
        snap = await takePage(tab);
        list = fileCandidates(snap);
        st.toggle.filesAfter = list.length;
        const changed = changedToggle(baseline, snap.toggles);
        if (changed) {
          Object.assign(st.toggle, { found: true, label: changed.label, flipped: true });
          if (list.length > before.length && store.learnToggle(mappingsFile, job.host, changed.label, new Date(now()).toISOString())) st.toggle.learned = true;
        }
      }
      st.sections = snap.sections.slice(0, limits.sections).map((s) => ({ heading: s.heading, chars: Math.min(s.text.length, limits.sectionChars) }));

      /* Files: every candidate, one tab each, under the caps. A file link to an address the loader would not open is skipped. */
      const pageUrl = new URL(job.href);
      const isAllowed = (u) => fileUrlAllowed(u, pageUrl, { allowLoopback });
      const wanted = list.filter((c) => c.mode === 'click' || (() => { try { return isAllowed(new URL(c.href)); } catch (e) { return false; } })());
      const candidates = wanted.slice(0, limits.files);
      for (const c of candidates) if (c.mode === 'click') c.pageTab = tab;
      set(job, 'downloading', candidates.length ? `Downloading ${candidates.length} file${candidates.length === 1 ? '' : 's'}.` : 'No files were offered on this page.');
      fs.mkdirSync(stageDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
      dl = new DownloadManager(browser.cdp, {
        stageDir, destDir, isAllowed, newWindow: browser.headless,
        limits: { maxFileBytes: limits.fileBytes, maxTotalBytes: limits.totalBytes, idleMs: timeouts.stall, fileTimeoutMs: timeouts.file, beginTimeoutMs: timeouts.begin },
      });
      let results = [];
      if (candidates.length) {
        await dl.start();
        results = await dl.fetchAll(candidates, {
          signal,
          onFile: (r, c) => { if (r.state === 'done') st.files.push({ name: r.name, size: r.size, sha256: r.sha256, group: safeText(c.group, 120), label: safeText(c.label, 160) }); },
        });
        check();
      }
      await dl.stop();
      dl = null;
      const failedBy = {};
      for (const r of results) if (r.state !== 'done') failedBy[r.state] = (failedBy[r.state] || 0) + 1;
      const refused = list.length - wanted.length;
      const over = wanted.length - candidates.length;
      const notes = [];
      if (Object.keys(failedBy).length) notes.push(`not fetched: ${Object.entries(failedBy).map(([k, v]) => `${v} ${k}`).join(', ')}`);
      if (refused) notes.push(`${refused} link${refused === 1 ? '' : 's'} to addresses the loader does not open`);
      if (over) notes.push(`${over} more over the limit of ${limits.files} files`);
      if (candidates.length && !st.files.length) throw new LinkError(`None of the ${candidates.length} files could be downloaded (${notes.join('; ')}).`, 502, 'no-files');

      store.ensurePrivateDir(st.folder);
      const fileList = st.files.map((f) => ({ ...f }));
      store.writeJsonAtomic(path.join(st.folder, 'page.json'), {
        sections: snap.sections.slice(0, limits.sections).map((s) => ({ heading: String(s.heading).slice(0, 160), text: String(s.text).slice(0, limits.sectionChars) })),
        fileList, page: st.page, loadedAt: new Date(now()).toISOString(),
      });
      outcome = { state: 'done', message: `${st.files.length} file${st.files.length === 1 ? '' : 's'} and ${st.sections.length} text section${st.sections.length === 1 ? '' : 's'} loaded${notes.length ? ' (' + notes.join('; ') + ')' : ''}.` };
      set(job, 'downloading', 'Closing Chrome.');
    } catch (error) {
      if (signal.aborted) outcome = { state: 'cancelled', message: 'Cancelled.' };
      else {
        const text = error instanceof LinkError ? error.message
          : error instanceof CdpError && error.code === 'PIPE_CLOSED' ? 'The Chrome window was closed before the load finished.'
          : error instanceof CdpError && error.code === 'SPAWN' ? safeText(error.message, 200)
          : `The load stopped: ${safeText(error && error.message, 200)}`;
        outcome = { state: 'failed', message: text };
      }
    } finally {
      /* End sequence: stop downloads, ask Chrome to quit (it flushes the sign-in to disk), kill the tree, prove nothing is left, then forget
         the history of the profile. Only then is the load reported as ended. */
      try { if (dl) await dl.stop(); } catch (e) { /* the browser is going away */ }
      try { if (browser) await browser.close({ graceful: !signal.aborted, scrub: true }); } catch (e) { /* nothing more to do */ }
      fs.rmSync(stageDir, { recursive: true, force: true });
      if (!FINAL.has(st.state)) { st.state = outcome.state; st.message = outcome.message; if (outcome.state === 'failed') st.error = outcome.message; }
      job.href = null; job.tab = null; job.browser = null;
      job.running = false;
    }
  }

  function start(url) {
    const v = validateLink(url, { allowLoopback });
    if (!v.ok) throw new LinkError(v.message, 400, v.code);
    if (current && current.running) throw new LinkError('A link is already loading. Wait for it to finish, or cancel it.', 409, 'busy');
    const id = 'lnk-' + crypto.randomBytes(6).toString('hex');
    const folder = path.join(linksDir, id);
    try {
      fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
      store.ensurePrivateDir(linksDir);
      fs.mkdirSync(folder, { mode: 0o700 });   /* exclusive: an existing folder is an error, an id is never reused */
    } catch (e) { throw new LinkError(`The loader cannot use its private folder: ${safeText(e.message, 120)}`, 500, 'folder'); }
    const job = { id, href: v.href, host: v.host, st: blank(id, v, folder), abort: new AbortController(), running: true, wake: null, popupsOk: false, pressed: false, said: false, tab: null, browser: null, done: null };
    jobs.set(id, job);
    current = job;
    job.done = run(job).catch(() => {
      if (!FINAL.has(job.st.state)) Object.assign(job.st, { state: 'failed', message: 'The load stopped unexpectedly.', error: 'The load stopped unexpectedly.' });
      job.href = null; job.running = false;
    });
    return id;
  }

  /* "I signed in" or "I turned the switch on". */
  function proceed(id) {
    const job = need(id);
    if (job.st.state !== 'needs-sign-in' && job.st.state !== 'needs-person') throw new LinkError('Nothing is waiting for you.', 409, 'not-waiting');
    if (job.st.state === 'needs-person') set(job, 'loading', 'Reading the page again.');
    else job.pressed = true;
    if (job.wake) job.wake();
    return view(job);
  }
  function cancel(id) {
    const job = need(id);
    if (FINAL.has(job.st.state)) return view(job);
    job.st.state = 'cancelled';
    job.st.message = 'Cancelled.';
    job.abort.abort();
    if (job.wake) job.wake();
    if (job.browser) job.browser.kill().catch(() => {});
    return view(job);
  }
  return {
    start,
    get: (id) => view(need(id)),
    continue: proceed,
    cancel,
    async waitFor(id) { const job = need(id); await job.done; return view(job); },
    /* The companion is stopping: cancel what runs and wait until Chrome is gone. */
    async shutdown() { if (current && current.running) { cancel(current.id); await current.done; } },
  };
}

module.exports = { createLinkLoader, LinkError, findAllFilesToggle, TOGGLE_LABEL_RE, validateLink, LIMITS, TIMEOUTS, changedToggle };
