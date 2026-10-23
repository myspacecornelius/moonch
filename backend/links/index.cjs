'use strict';
/* The link loader: paste a task link, get the page text and every file the page offers, on the owner's own machine.

     createLinkLoader({ root, chromePath, spawnFn, clock, headless, timeouts, signIn, allowLoopback, limits, platform })
       root           the Studio project folder; everything is written under <root>/private/ (links/<id>/, link-profile/, link-mappings.json)
       chromePath     use exactly this browser: a program, or a macOS .app folder (default: FINANCE_STUDIO_CHROME, CHROME_BIN, then Google
                      Chrome or Chromium in /Applications and ~/Applications and the usual Linux places)
       spawnFn        replaces child_process.spawn (tests; a test that runs as root adds --no-sandbox here, the product never does)
       clock          () => Date or milliseconds
       headless       false (default): visible Chrome windows, where the owner signs in once; true: no window (tests)
       timeouts       change a wait, in ms: { navigation, settle, signIn, person, poll, stall, file, begin, phase, stable: [1000, 2000],
                      grow, expand }
       signIn         'window' (default): the person signs in in a separate Chrome with no debugging channel; 'piped': in the window the
                      loader drives (the fallback; it cannot be used with platforms that refuse an automated browser)
       allowLoopback  test only: also accept http://127.0.0.1 and http://localhost links
       limits         test only, lowered never raised: { files, fileBytes, totalBytes }
       platform       test only: process.platform
     returns { start(url) -> id, get(id) -> state, continue(id) -> state, cancel(id) -> state, waitFor(id) -> final state,
               shutdown() }       one load at a time; a refusal throws LinkError with .status (400, 404, 409) and .code

   State (also what GET /api/links/:id returns; every value is plain JSON):
     { id, state, message, page: { origin, path }, toggle: { found, label, flipped, filesBefore, filesAfter, learned },
       files: [{ name, size, sha256, group, label }], skipped: [{ label, group, reason }], sections: [{ heading, chars }], folder, error }
     state: starting -> [needs-sign-in -> loading] -> loading -> [needs-person -> loading] -> downloading -> [needs-person -> loading]
            -> done | failed | cancelled.
            needs-sign-in: the person signs in, then presses Continue (window mode: a separate Chrome window is open; the loader's own
            Chrome is closed meanwhile). needs-person: the "show all files" control could not be found or added nothing, or no file was
            found, or some files could not be downloaded (skipped lists them); Continue goes on. cancel() shows "Cancelling..." and the
            final state comes only once Chrome is closed and the profile scrubbed, like done and failed.
     toggle.flipped: the control is on (the loader clicked it, it was already on, or the person turned it on). toggle.learned: its
            label (or id) came from, or was just stored in, <root>/private/link-mappings.json for this host. error: null, or the same
            sentence as message when failed. skipped: every file that was NOT kept, with the reason (also in page.json).
   Files land in <folder>/files/<sanitised unique name>; <folder>/page.json holds { sections: [{ heading, text }], fileList, skipped, page,
   loadedAt } (text capped at 20,000 characters per section, 200 sections). Caps: 300 files, 200 MB per file, 2 GB in all.

   The link (it can carry a signature) lives in this module's memory for the length of the load: not on Chrome's command line (the
   sign-in window gets the platform's ORIGIN only), not in a log, an error, the state or a file; only origin and path are ever shown. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { findChrome, checkBinary, resolveBinary, missingChromeMessage, launchBrowser, launchWindow, syncWarning, protectStorage, PROFILE_IN_USE_MESSAGE } = require('./chrome.cjs');
const { Tab, safeText, cleanLabel, waitForSettled } = require('./tab.cjs');
const { takePage, pageOp, fileCandidates, findAllFilesToggle, findAllFilesState, TOGGLE_LABEL_RE } = require('./page.cjs');
const { classifyPage, LOGIN_PATH_RE, CHALLENGE_RE, REFUSED_RE } = require('./auth-wall.cjs');
const { DownloadManager } = require('./downloads.cjs');
const { stabilize, expand, gather, unionCandidates, mergeSections } = require('./discover.cjs');
const { validateLink, fileUrlAllowed } = require('./url.cjs');
const store = require('./store.cjs');
const { CdpError, sleep } = require('./cdp.cjs');

const LIMITS = { files: 300, fileBytes: 200 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024, sections: 200, sectionChars: 20000 };
const TIMEOUTS = {
  navigation: 30000, settle: 15000, signIn: 10 * 60 * 1000, person: 10 * 60 * 1000, poll: 1000, stall: 60000, file: 10 * 60 * 1000, begin: 15000,
  phase: 15 * 60 * 1000, stable: [1000, 2000], grow: 5000, expand: 30000,
};
const ID_RE = /^lnk-[0-9a-f]{12}$/;
const FINAL = new Set(['done', 'failed', 'cancelled']);
const PERSON_MESSAGE = 'Turn on the option that shows all files in the Chrome window, then press Continue.';
const NO_FILES_MESSAGE = 'No files were found. Open the view that lists the files in the Chrome window, then press Continue.';
const SIGNIN_WINDOW_MESSAGE = 'Sign in in the Chrome window that opened (look for the new Chrome icon in the Dock if you do not see it). When the platform shows you are signed in, press Continue here.';
const WINDOW_CLOSED_MESSAGE = 'You closed the Chrome window before the load finished. Start again.';
const KEEP_OPEN = ' Leave the Chrome window open until the load finishes.';
const IMPORT_HINT = 'You can also download the files yourself and use Import from folder.';

/* A refusal with an HTTP style status: 400 for a bad link, 404 for an unknown load, 409 for a busy loader or a load that is not waiting. */
class LinkError extends Error {
  constructor(message, status = 400, code = 'refused') {
    super(message);
    this.name = 'LinkError';
    this.status = status;
    this.code = code;
  }
}

/* page-side constant function (see tab.evalFn) */
const probePage = () => ({
  href: location.href, ready: document.readyState === 'complete',
  pw: Boolean(document.querySelector('input[type=password],input[autocomplete=one-time-code],.g-recaptcha,.h-captcha,.cf-turnstile,[data-sitekey]')),
  text: (document.title + ' ' + (document.body ? document.body.innerText : '')).slice(0, 600),
});

const waited = (ms) => {
  const [n, unit] = ms >= 60000 ? [Math.round(ms / 60000), 'minute'] : [Math.max(1, Math.round(ms / 1000)), 'second'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
};

/* The control that went from off to on between two lists of controls (same element, found by path and option), or null. */
function changedToggle(before, after) {
  const key = (t, i) => (t.path ? `${t.path}#${t.option === undefined ? '' : t.option}` : `#${i}:${t.label}`);
  const was = new Map(before.map((t, i) => [key(t, i), t.checked]));
  return after.find((t, i) => t.checked && was.get(key(t, i)) === false) || null;
}

/* Same page: same origin and same path (the query and the fragment may differ). */
function samePage(a, b) {
  try { const x = new URL(a); const y = new URL(b); return x.origin === y.origin && x.pathname === y.pathname; } catch (e) { return false; }
}

const listLabels = (items, max = 5) => `${items.slice(0, max).map((i) => i.label || '(no name)').join(', ')}${items.length > max ? ` and ${items.length - max} more` : ''}`;

function createLinkLoader(options = {}) {
  if (typeof options.root !== 'string' || !path.isAbsolute(options.root)) throw new TypeError('createLinkLoader needs root, the absolute path of the Studio project folder');
  const root = path.resolve(options.root);
  const privateDir = path.join(root, 'private');
  const linksDir = path.join(privateDir, 'links');
  const profileDir = path.join(privateDir, 'link-profile');
  const mappingsFile = path.join(privateDir, 'link-mappings.json');
  const headless = options.headless === true;
  const allowLoopback = options.allowLoopback === true;
  const windowMode = options.signIn !== 'piped';
  const platform = options.platform || process.platform;
  const timeouts = { ...TIMEOUTS, ...(options.timeouts || {}) };
  const lower = (value, max) => (Number.isFinite(value) && value > 0 ? Math.min(value, max) : max);
  const limits = { ...LIMITS, files: lower((options.limits || {}).files, LIMITS.files), fileBytes: lower((options.limits || {}).fileBytes, LIMITS.fileBytes), totalBytes: lower((options.limits || {}).totalBytes, LIMITS.totalBytes) };
  const now = () => { const c = typeof options.clock === 'function' ? options.clock() : Date.now(); return c instanceof Date ? c.getTime() : Number(c); };
  const jobs = new Map();
  let current = null;

  const blank = (id, v, folder) => ({
    id, state: 'starting', message: 'Starting Chrome.', page: { origin: v.origin, path: v.path },
    toggle: { found: false, label: '', flipped: false, filesBefore: 0, filesAfter: 0, learned: false },
    files: [], skipped: [], sections: [], folder, error: null,
  });
  const need = (id) => { const job = typeof id === 'string' && ID_RE.test(id) ? jobs.get(id) : null; if (!job) throw new LinkError('There is no such load.', 404, 'unknown'); return job; };
  const view = (job) => structuredClone(job.st);

  /* The final state is only set once, by the end of run(). After cancel() the message stays "Cancelling...". */
  const set = (job, state, message) => { if (!FINAL.has(job.st.state) && !job.cancelling) { job.st.state = state; job.st.message = message; } };

  async function run(job) {
    const st = job.st;
    const signal = job.abort.signal;
    let outcome = null;
    const check = () => {
      if (job.windowClosed) throw new LinkError(WINDOW_CLOSED_MESSAGE, 409, 'window-closed');
      if (signal.aborted) throw new CdpError('Cancelled.', { code: 'CANCELLED' });
      if (job.browser && job.browser.cdp.closed) throw new CdpError('The browser closed the pipe.', { code: 'PIPE_CLOSED' });   /* Chrome died */
    };
    const settle = async () => { const r = await waitForSettled(job.tab, { maxMs: timeouts.settle, signal }); if (!r.settled) job.unsettled = true; return r; };
    const stageDir = path.join(st.folder, '.incoming');
    const destDir = path.join(st.folder, 'files');
    const href = job.href;
    const origin = new URL(href).origin;
    try {
      fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });   /* the project's own folder: created if missing, otherwise left as it is */
      store.ensurePrivateDir(linksDir);
      store.ensurePrivateDir(profileDir);
      let warning = '';
      try { warning = syncWarning(fs.realpathSync(root), undefined, platform); } catch (e) { warning = ''; }
      protectStorage({ privateDir, paths: [profileDir, linksDir], platform });
      let binary;
      if (options.chromePath) {
        binary = resolveBinary(options.chromePath);
        const verdict = checkBinary(binary);
        if (!verdict.ok) throw new LinkError(`The Chrome path cannot be used: ${verdict.why}.`, 500, 'chrome');
      } else {
        const found = findChrome();
        if (!found.binary) throw new LinkError(missingChromeMessage(found.tried), 500, 'chrome');
        binary = found.binary;
      }

      /* The loader's own Chrome: on the pipe, one tab, popups it did not open closed on sight (except while the person is using the window
         or a click is waiting for a download a window starts). */
      const openPiped = async () => {
        const browser = await launchBrowser({ binary, profileDir, headless, spawnFn: options.spawnFn });
        job.browser = browser;
        check();
        const own = new Set();
        browser.cdp.on('Target.targetCreated', (p) => {
          const info = p.targetInfo;
          if (info.type !== 'page' || !info.openerId || own.has(info.targetId)) return;
          if (job.dl && job.dl.adoptPopup(info.targetId)) return;
          if (!job.popupsOk) browser.cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
        });
        await browser.cdp.send('Target.setDiscoverTargets', { discover: true });
        /* Our own tab FIRST, then close every other page: with a visible window Chrome quits when the last tab closes. */
        const tab = await Tab.open(browser.cdp, { newWindow: browser.headless });
        job.tab = tab;
        own.add(tab.targetId);
        for (const info of (await browser.cdp.send('Target.getTargets')).targetInfos) if (info.type === 'page' && info.targetId !== tab.targetId) await browser.cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
        /* On macOS closing the window does not quit Chrome, so the pipe would stay open for ever: a closed task tab ends the load. */
        browser.cdp.on('Target.targetDestroyed', (p) => {
          if (p.targetId !== tab.targetId || tab.closed || job.closing || job.cancelling) return;
          job.windowClosed = true;
          job.abort.abort();
          if (job.wake) job.wake();
        });
        if (!headless) await tab.front();
        return browser;
      };
      const closePiped = async () => {
        const browser = job.browser;
        if (!browser) return;
        job.closing = true;
        job.browser = null; job.tab = null;
        try { await browser.close({ graceful: true, scrub: true }); } finally { job.closing = false; }
      };

      set(job, 'starting', `Starting Chrome (${binary}).${warning ? ` ${warning}` : ''}`);
      const first = await openPiped();
      set(job, 'starting', `Chrome ${first.version && first.version.product ? first.version.product : ''} is open (${binary}). Opening the task page.${warning ? ` ${warning}` : ''}`);

      /* One load: navigate, settle, read the page, classify it. */
      const loadOnce = async () => {
        const tab = job.tab;
        let nav;
        try { nav = await tab.navigate(href, { timeout: timeouts.navigation }); }
        catch (e) { if (e.code !== 'TIMEOUT') throw e; nav = { errorText: `no answer within ${timeouts.navigation} ms`, isDownload: false }; }
        if (!nav.errorText) { try { await tab.waitForLoad({ timeout: 20000 }); } catch (e) { /* settle reports it */ } }
        const failed = Boolean(nav.errorText) && !nav.isDownload;
        if (!failed) await settle();
        let snap = null;
        if (!nav.errorText) { try { snap = await takePage(tab); } catch (e) { check(); } }
        const cls = classifyPage({ ignoreChallengeWords: job.said, requestedUrl: href, finalUrl: snap ? snap.url : null, hops: tab.net.hops, mainResponse: tab.net.mainResponse, api: tab.net.apiErrors, snapshot: snap, navError: failed ? safeText(nav.errorText, 80) : null });
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
      const where = () => job.tab.evalFn(probePage, null, { timeout: 3000, retries: 0 }).catch(() => null);
      /* The piped window: "back on the task page" is the same origin AND path as the link, finished, no password, code or CAPTCHA, no
         browser-check words, on two polls in a row. Anything else (an MFA step, a callback, a home page) keeps waiting for Continue. */
      let goodPolls = 0;
      const signedInPiped = async () => {
        if (job.pressed) { job.pressed = false; job.said = true; return true; }   /* the person pressed Continue: believe it and look again */
        const probe = await where();
        if (probe && REFUSED_RE.test(probe.text)) set(job, 'needs-sign-in', 'The platform refused the sign-in in this automated window ("this browser may not be secure"). Press Cancel and start again with the separate sign-in window.');
        const good = Boolean(probe && probe.ready && !probe.pw && !CHALLENGE_RE.test(probe.text) && samePage(probe.href, href) && !LOGIN_PATH_RE.test(new URL(probe.href).pathname));
        goodPolls = good ? goodPolls + 1 : 0;
        return goodPolls >= 2;
      };
      /* The sign-in window: the loader's Chrome is closed (it flushes the profile), the same binary opens the same profile with no
         debugging channel and only the platform's origin; the person signs in and presses Continue (or quits that Chrome); the window
         is stopped with SIGINT so its cookies are written; the loader's Chrome is opened again. */
      const signInWindow = async () => {
        set(job, 'loading', 'Opening the sign-in window.');
        await closePiped();
        check();
        const win = launchWindow({ binary, profileDir, headless, spawnFn: options.spawnFn, url: `${origin}/` });
        job.windowProc = win;
        const opened = Date.now();
        set(job, 'needs-sign-in', SIGNIN_WINDOW_MESSAGE);
        try {
          await waitPerson(async () => {
            if (win.error()) throw new LinkError(`The Chrome window could not be opened: ${safeText(win.error(), 120)}`, 500, 'chrome');
            if (win.hasExited() && !job.pressed && Date.now() - opened < 4000 && /process_singleton|SingletonLock|profile.*in use/i.test(win.stderrTail())) throw new LinkError(PROFILE_IN_USE_MESSAGE, 409, 'profile-in-use');
            return job.pressed || win.hasExited();
          }, timeouts.signIn, `Sign-in did not finish within ${waited(timeouts.signIn)}.`);
        } finally {
          job.windowProc = null;
          await win.stop();
        }
        job.pressed = false; job.said = true;
        await openPiped();
      };

      let page = await loadOnce();
      const piped = !windowMode;
      const signInDeadline = now() + timeouts.signIn;
      for (let round = 1; page.cls.state === 'needs-sign-in' || page.cls.state === 'needs-person'; round += 1) {
        if (round > (piped ? 3 : 2)) throw new LinkError(`The platform still asks you to sign in. ${IMPORT_HINT}`, 502, 'sign-in-loop');
        if (windowMode) await signInWindow();
        else {
          /* While the person types a password the network domain is off, so no event can carry what was typed; it is switched on again
             after. It goes off BEFORE the state says "sign in". */
          await job.tab.pauseNetwork();
          set(job, 'needs-sign-in', page.cls.reason);
          goodPolls = 0;
          await waitPerson(signedInPiped, Math.max(0, signInDeadline - now()), `Sign-in did not finish within ${waited(timeouts.signIn)}.`);
          await job.tab.enableNetwork();
        }
        set(job, 'loading', `Signed in. Opening the task page.${KEEP_OPEN}`);
        if (!headless) await job.tab.front();
        page = await loadOnce();
      }
      if (page.cls.state !== 'ready') throw new LinkError(page.cls.reason, 502, page.cls.state);
      if (!page.snap) throw new LinkError('The link did not open a web page.', 502, 'not-a-page');
      set(job, 'loading', `Reading the page.${KEEP_OPEN}`);
      if (!headless) await job.tab.front();

      /* The page may still be filling in: look again 1 s and 3 s after it settled, until two looks in a row agree. Then the cheap
         expansion (closed <details>, expanders). All snapshots are kept: the files and the text are the UNION of what they show. */
      const snaps = await stabilize(job.tab, page.snap, { signal, waits: timeouts.stable });
      await expand(job.tab, snaps, { signal });
      let snap = snaps[snaps.length - 1];

      /* "Show all files": the control learned for this host, or one whose label says so; click it, wait for the list to grow. */
      const before = fileCandidates(snap);
      const learned = store.learnedToggleInfo(mappingsFile, job.host);
      const found = findAllFilesState(snap.toggles, learned);
      const pick = found && found.toggle;
      const usedLearned = Boolean(pick && learned && ((learned.key && pick.key === learned.key) || (learned.label && pick.label.trim().toLowerCase() === learned.label.trim().toLowerCase())));
      const alreadyOn = Boolean(found && found.on);
      let list = before;
      Object.assign(st.toggle, { filesBefore: before.length, filesAfter: before.length, found: Boolean(pick), label: pick ? pick.label : '', learned: usedLearned, flipped: alreadyOn });
      if (pick && !alreadyOn && pick.path) {
        const clicked = await pageOp(job.tab, 'activate', { path: pick.path, option: pick.option });
        if (clicked.ok) {
          await settle();
          const end = Date.now() + timeouts.grow;   /* a page may take a few seconds to add the files */
          snap = await takePage(job.tab);
          while (fileCandidates(snap).length <= before.length && Date.now() < end) { check(); await sleep(400); snap = await takePage(job.tab); }
          snaps.push(snap);
          list = fileCandidates(snap);
          const now2 = snap.toggles.find((t) => t.path === pick.path && t.option === pick.option && t.label === pick.label);
          st.toggle.flipped = Boolean((now2 && now2.checked) || list.length > before.length);
          st.toggle.filesAfter = list.length;
        }
      }
      /* Where the page is, after the person has used the window: back on the task page, or the loader goes back once and looks again. */
      const backToPage = async () => {
        const probe = await where();
        if (probe && samePage(probe.href, href)) return;
        const again = await loadOnce();
        if (again.cls.state === 'needs-sign-in' || again.cls.state === 'needs-person') throw new LinkError(`The platform asks you to sign in again. ${IMPORT_HINT}`, 502, 'sign-in-loop');
        if (again.cls.state !== 'ready') throw new LinkError(again.cls.reason, 502, again.cls.state);
      };
      if (!alreadyOn && (!st.toggle.flipped || (list.length <= before.length && !usedLearned))) {
        set(job, 'needs-person', PERSON_MESSAGE);
        if (!headless) await job.tab.front();
        const baseline = snap.toggles;
        await waitPerson(async () => job.st.state !== 'needs-person', timeouts.person, `No answer within ${waited(timeouts.person)}.`);   /* continue() moves the state on */
        await backToPage();
        await settle();
        snap = await takePage(job.tab);
        snaps.push(snap);
        list = fileCandidates(snap);
        st.toggle.filesAfter = list.length;
        const changed = changedToggle(baseline, snap.toggles);
        if (changed) {
          Object.assign(st.toggle, { found: true, label: changed.label, flipped: true });
          if (list.length > before.length && store.learnToggle(mappingsFile, job.host, changed.label, new Date(now()).toISOString(), changed.key)) st.toggle.learned = true;
        }
      }

      /* Tabs, "Load more", scrolling; then the files of every snapshot as one list. */
      set(job, 'loading', `Looking for every file.${KEEP_OPEN}`);
      await gather(job.tab, snaps, { signal, budgetMs: timeouts.expand });
      let candidatesAll = unionCandidates(snaps.map(fileCandidates));
      if (!candidatesAll.length) {
        set(job, 'needs-person', NO_FILES_MESSAGE);
        if (!headless) await job.tab.front();
        await waitPerson(async () => job.st.state !== 'needs-person', timeouts.person, `No answer within ${waited(timeouts.person)}.`);
        await backToPage();
        await settle();
        const again = await stabilize(job.tab, await takePage(job.tab), { signal, waits: timeouts.stable });
        snaps.push(...again);
        await expand(job.tab, snaps, { signal });
        await gather(job.tab, snaps, { signal, budgetMs: timeouts.expand });
        candidatesAll = unionCandidates(snaps.map(fileCandidates));
        st.toggle.filesAfter = Math.max(st.toggle.filesAfter, candidatesAll.length);
      }
      const merged = mergeSections(snaps.map((s) => s.sections), limits);
      const sections = merged.map((s) => ({ heading: cleanLabel(s.heading, 160), text: s.text }));
      st.sections = sections.map((s) => ({ heading: s.heading, chars: s.text.length }));

      /* Files: every candidate, one tab each (or a click in the task page), under the caps. A file link to an address the loader would not
         open is skipped. Whatever is not kept is listed in skipped, and the person decides whether to go on. */
      const pageUrl = new URL(href);
      const isAllowed = (u) => fileUrlAllowed(u, pageUrl, { allowLoopback });
      const allowed = (c) => c.mode === 'click' || (() => { try { return isAllowed(new URL(c.href)); } catch (e) { return false; } })();
      const wanted = candidatesAll.filter(allowed);
      const candidates = wanted.slice(0, limits.files);
      for (const c of candidatesAll) if (!allowed(c)) st.skipped.push({ label: cleanLabel(c.label, 160), group: cleanLabel(c.group, 120), reason: 'the address is not one the loader opens' });
      for (const c of wanted.slice(limits.files)) st.skipped.push({ label: cleanLabel(c.label, 160), group: cleanLabel(c.group, 120), reason: `over the limit of ${limits.files} files` });
      for (const c of candidates) c.pageTab = job.tab;
      set(job, 'downloading', candidates.length ? `Downloading ${candidates.length} file${candidates.length === 1 ? '' : 's'}.${KEEP_OPEN}` : 'No files were offered on this page.');
      if (!headless) await job.tab.front();
      fs.mkdirSync(stageDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
      const dl = new DownloadManager(job.browser.cdp, {
        stageDir, destDir, isAllowed, newWindow: job.browser.headless, ensurePage: backToPage,
        limits: { maxFileBytes: limits.fileBytes, maxTotalBytes: limits.totalBytes, idleMs: timeouts.stall, fileTimeoutMs: timeouts.file, beginTimeoutMs: timeouts.begin, phaseMs: timeouts.phase },
      });
      job.dl = dl;
      let stopped = null;
      if (candidates.length) {
        await dl.start();
        const out = await dl.fetchAll(candidates, {
          signal,
          onFile: (r, c) => { if (r.state === 'done') st.files.push({ name: r.name, size: r.size, sha256: r.sha256, group: cleanLabel(c.group, 120), label: cleanLabel(c.label, 160) }); },
        });
        check();
        stopped = out.stopped;
        for (const r of out.results) if (r.state !== 'done') st.skipped.push({ label: cleanLabel(r.candidate.label, 160), group: cleanLabel(r.candidate.group, 120), reason: r.detail ? `${r.state}: ${r.detail}` : r.state });
        for (const c of out.rest) st.skipped.push({ label: cleanLabel(c.label, 160), group: cleanLabel(c.group, 120), reason: `not tried: ${stopped}` });
      }
      await dl.stop();
      job.dl = null;

      if (st.skipped.length) {
        set(job, 'needs-person', `${st.skipped.length} file${st.skipped.length === 1 ? '' : 's'} could not be downloaded: ${listLabels(st.skipped)}.${stopped ? ` Stopped early: ${stopped}.` : ''} Download them yourself into a folder and use Import from folder, or press Continue to go on without them.`);
        if (!headless) await job.tab.front();
        await waitPerson(async () => job.st.state !== 'needs-person', timeouts.person, `No answer within ${waited(timeouts.person)}.`);
      }
      if (candidates.length && !st.files.length) throw new LinkError(`None of the ${candidates.length} files could be downloaded. ${IMPORT_HINT}`, 502, 'no-files');

      store.ensurePrivateDir(st.folder);
      const fileList = st.files.map((f) => ({ ...f }));
      store.writeJsonAtomic(path.join(st.folder, 'page.json'), {
        sections: sections.slice(0, limits.sections).map((s) => ({ heading: String(s.heading).slice(0, 160), text: String(s.text).slice(0, limits.sectionChars) })),
        fileList, skipped: st.skipped.map((s) => ({ ...s })), page: st.page, loadedAt: new Date(now()).toISOString(),
      });
      const notes = [];
      if (st.skipped.length) notes.push(`${st.skipped.length} not kept (listed in skipped)`);
      if (job.unsettled) notes.push('settled:false, the page kept changing, so some files or text may be missing');
      if (warning) notes.push(warning);
      outcome = { state: 'done', message: `${st.files.length} file${st.files.length === 1 ? '' : 's'} and ${st.sections.length} text section${st.sections.length === 1 ? '' : 's'} loaded${notes.length ? ` (${notes.join('; ')})` : ''}.` };
      set(job, 'downloading', 'Closing Chrome.');
    } catch (error) {
      if (job.windowClosed) outcome = { state: 'failed', message: WINDOW_CLOSED_MESSAGE };
      else if (job.cancelling || signal.aborted) outcome = { state: 'cancelled', message: 'Cancelled.' };
      else {
        const text = error instanceof LinkError ? error.message
          : error instanceof CdpError && error.code === 'PIPE_CLOSED' ? 'The Chrome window was closed before the load finished.'
          : error instanceof CdpError && error.code === 'PROFILE_IN_USE' ? error.message
          : error instanceof CdpError && error.code === 'SPAWN' ? safeText(error.message, 200)
          : `The load stopped: ${safeText(error && error.message, 200)}`;
        outcome = { state: 'failed', message: text };
      }
    } finally {
      /* End sequence: stop downloads and the sign-in window, ask Chrome to quit (it flushes the sign-in to disk), kill the tree, prove
         nothing is left, then forget the history of the profile. Only then is the load reported as ended. */
      job.closing = true;
      try { if (job.dl) await job.dl.stop(); } catch (e) { /* the browser is going away */ }
      try { if (job.windowProc) await job.windowProc.stop({ graceMs: 2000 }); } catch (e) { /* nothing more to do */ }
      try { if (job.browser) await job.browser.close({ graceful: true, graceMs: job.cancelling ? 2000 : 4000, scrub: true }); } catch (e) { /* nothing more to do */ }
      fs.rmSync(stageDir, { recursive: true, force: true });
      st.state = outcome ? outcome.state : 'failed';
      st.message = outcome ? outcome.message : 'The load stopped unexpectedly.';
      st.error = st.state === 'failed' ? st.message : null;
      job.href = null; job.tab = null; job.browser = null; job.dl = null; job.windowProc = null;
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
    const job = {
      id, href: v.href, host: v.host, st: blank(id, v, folder), abort: new AbortController(), running: true, wake: null, popupsOk: false, pressed: false, said: false,
      cancelling: false, closing: false, windowClosed: false, unsettled: false, tab: null, browser: null, dl: null, windowProc: null, done: null,
    };
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
    if (job.st.state === 'needs-person') set(job, 'loading', 'Continuing.');
    else job.pressed = true;
    if (job.wake) job.wake();
    return view(job);
  }

  /* Ask Chrome to quit first (it keeps a sign-in that was just made), and kill it only if it has not gone within 2 seconds. The state shows
     "Cancelling..." until run() has closed everything; then it is cancelled. */
  function cancel(id) {
    const job = need(id);
    if (FINAL.has(job.st.state) || job.cancelling) return view(job);
    job.cancelling = true;
    job.st.state = 'loading';
    job.st.message = 'Cancelling...';
    job.abort.abort();
    if (job.wake) job.wake();
    if (job.windowProc) job.windowProc.stop({ graceMs: 2000 }).catch(() => {});
    const browser = job.browser;
    if (browser) {
      browser.cdp.send('Browser.close', {}, { timeout: 2000 }).catch(() => {});
      const timer = setTimeout(() => { if (job.running && job.browser === browser) browser.kill().catch(() => {}); }, 2000);
      if (timer.unref) timer.unref();
    }
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

module.exports = { createLinkLoader, LinkError, findAllFilesToggle, findAllFilesState, TOGGLE_LABEL_RE, validateLink, LIMITS, TIMEOUTS, changedToggle, samePage };
