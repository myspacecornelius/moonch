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
                      grow, expand: 60000 (the time for "Load more" and scrolling; every tab gets at least 8 s) }
       signIn         'window' (default): the person signs in in a separate Chrome with no debugging channel; 'piped': in the window the
                      loader drives (the fallback; it cannot be used with platforms that refuse an automated browser)
       allowLoopback  test only: also accept http://127.0.0.1 and http://localhost links
       limits         test only, lowered never raised: { files, fileBytes, totalBytes }
       platform       test only: process.platform
     returns { start(url) -> id, get(id) -> state, continue(id) -> state, cancel(id) -> state, waitFor(id) -> final state,
               shutdown() }       one load at a time; a refusal throws LinkError with .status (400, 404, 409) and .code

   State (also what GET /api/links/:id returns; every value is plain JSON):
     { id, state, message, page: { origin, path }, toggle: { found, label, flipped, filesBefore, filesAfter, learned },
       files: [{ name, size, sha256, group, label }], skipped: [{ label, group, reason }], notes: [string], sections: [{ heading, chars }], folder, error }
     state: starting -> [needs-sign-in -> loading] -> loading -> [needs-person -> loading] -> downloading -> [needs-person -> loading]
            -> done | failed | cancelled.
            needs-sign-in: the person signs in, then presses Continue (window mode: a separate Chrome window is open; the loader's own
            Chrome is closed meanwhile). needs-person: the "show all files" control could not be found or added nothing, or no file was
            found, or some files could not be downloaded (skipped lists them); Continue goes on. cancel() shows "Cancelling..." and the
            final state comes only once Chrome is closed and the profile scrubbed, like done and failed.
     toggle.flipped: the control is on (the loader clicked it, it was already on, or the person turned it on). toggle.learned: its
            label (or id) came from, or was just stored in, <root>/private/link-mappings.json for this host. error: null, or the same
            sentence as message when failed. skipped: every file that was NOT kept, with the reason (also in page.json).
   Files land in <folder>/files/<sanitised unique name>; <folder>/page.json holds { sections: [{ heading, text }], fileList, skipped, notes,
   page, loadedAt } (text capped at 20,000 characters per section, 200 sections). Caps: 300 files, 200 MB per file, 2 GB in all.
   WHAT IS REQUESTED OR PRESSED is an allowlist (see page.cjs): a link whose address path ends in a file extension (or is exactly
   /download) with no action word in it, a link with a download attribute, a control named as a download that is not in a form, and
   controls that only show more (tabs, expanders, "Load more", pagers, the "show all files" switch). Nothing else is requested or pressed.
   Every file the page offers is downloaded or listed in skipped with the reason, never dropped without a word: a file that cannot be
   fetched, a control or link that names a file but is not clearly a download ("not clearly a download: download it yourself"), one that
   would submit a form or whose address is an action ("looks like an action"), a click that began no download (pressed once, never again),
   a row that is gone when its turn comes. notes (in the state, in page.json and at the end of the done message) says in plain
   sentences every place the loader could not cover completely: "Load more" or scrolling or a pager at its limit, a "Load more" that
   stayed on the page, a pager it did not follow, tabs or controls past the caps, a scroller that did not reach its bottom, an API request
   of the page that had not answered, a closed dialog or drawer that holds file links, a frame of another site, a page read only in part,
   rows that look different but were taken for one another, a file that was listed twice and kept once.
   How the files are found: look again after the page settled; open <details> and expanders (repeated until nothing new opens); turn on
   the "show all files" switch (also when it is learned, or already on) and open what it revealed; in the open tab and in every other
   tab press "Load more", scroll until every scroller is at its bottom and nothing new comes, and follow the pager (Next, page numbers,
   or links that change only a page parameter). A file that is a button is identified by the name or the text of its row, its heading and
   its text, remembered together with the view it was seen in (tab, page, presses, scroll steps); before each press the page is put back
   into that view and the element is found again, and activate refuses a row that is not the one that was listed.

   The link (it can carry a signature) lives in this module's memory for the length of the load: not on Chrome's command line (the
   sign-in window gets the platform's ORIGIN only), not in a log, an error, the state or a file; only origin and path are ever shown. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { findChrome, checkBinary, resolveBinary, missingChromeMessage, launchBrowser, launchWindow, syncWarning, protectStorage, holdsProfile, scrubProfile, PROFILE_IN_USE_MESSAGE } = require('./chrome.cjs');
const { Tab, safeText, cleanLabel, waitForSettled } = require('./tab.cjs');
const { takePage, pageOp, fileCandidates, droppedCandidates, findAllFilesToggle, findAllFilesState, linkVerdict, nameIsDownload, navigateKey, TOGGLE_LABEL_RE, LIMITS: PAGE_LIMITS } = require('./page.cjs');
const { classifyPage, LOGIN_PATH_RE, CHALLENGE_RE, REFUSED_RE } = require('./auth-wall.cjs');
const { DownloadManager } = require('./downloads.cjs');
const { stabilize, expandAll, gather, replay, candidateKey, tabKey, LOST, unionCandidates, unionWithCheck, unionDropped, mergeSections } = require('./discover.cjs');
const { validateLink, fileUrlAllowed } = require('./url.cjs');
const store = require('./store.cjs');
const { CdpError, sleep } = require('./cdp.cjs');

const LIMITS = { files: 300, fileBytes: 200 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024, sections: 200, sectionChars: 20000 };
const TIMEOUTS = {
  navigation: 30000, settle: 15000, signIn: 10 * 60 * 1000, person: 10 * 60 * 1000, poll: 1000, stall: 60000, file: 10 * 60 * 1000, begin: 15000,
  phase: 15 * 60 * 1000, stable: [1000, 2000], grow: 5000, expand: 60000,
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
  href: location.href, ready: document.readyState === 'complete', doc: String(globalThis.__fstDoc || ''),
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

/* The task page or a page of it: the same origin, and the same path or a path below it (a single-page app may add /all to the address). */
function withinPage(current, original) {
  try {
    const x = new URL(current); const y = new URL(original);
    return x.origin === y.origin && (x.pathname === y.pathname || x.pathname.startsWith(`${y.pathname.replace(/\/$/, '')}/`));
  } catch (e) { return false; }
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
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
    files: [], skipped: [], notes: [], sections: [], folder, error: null,
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
    /* what the loader could not do completely, told in the state, in page.json and at the end of the done message */
    const capNotes = [];
    const note = (text) => { if (!capNotes.includes(text)) { capNotes.push(text); st.notes = capNotes.slice(); } };
    /* API requests of the page that had not answered when a settle ended: looked at again when the files are listed (told only if they
       never answered by then; an answer that came in the meantime has been seen by a later look) */
    const suspects = new Set();
    const settle = async (since = 0) => {
      const r = await waitForSettled(job.tab, { maxMs: timeouts.settle, since, graceMs: since ? 350 : 0, signal });
      if (!r.settled) job.unsettled = true;
      for (const id of r.lostIds || []) suspects.add(id);
      return r;
    };
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
      let loads = 0;   /* how many times the task link has been opened: a plain button that turns the files on is pressed once per load */
      const pos = { pages: 0, url: null };   /* where the pager is: pages pressed since the load, or the address of the page of a pager made of links */
      const loadOnce = async (target = href) => {
        loads += 1;
        pos.pages = 0; pos.url = null;
        const tab = job.tab;
        let nav;
        try { nav = await tab.navigate(target, { timeout: timeouts.navigation }); }
        catch (e) { if (e.code !== 'TIMEOUT') throw e; nav = { errorText: `no answer within ${timeouts.navigation} ms`, isDownload: false }; }
        if (!nav.errorText) { try { await tab.waitForLoad({ timeout: 20000 }); } catch (e) { /* settle reports it */ } }
        const failed = Boolean(nav.errorText) && !nav.isDownload;
        if (!failed) await settle();
        let snap = null;
        if (!nav.errorText) { try { snap = await takePage(tab); } catch (e) { check(); } }
        try { const there = await job.tab.evalFn(probePage, null, { timeout: 3000, retries: 0 }); job.doc = there && there.doc ? there.doc : ''; } catch (e) { job.doc = ''; }
        const cls = classifyPage({ ignoreChallengeWords: job.said, requestedUrl: target, finalUrl: snap ? snap.url : null, hops: tab.net.hops, mainResponse: tab.net.mainResponse, api: tab.net.apiErrors, snapshot: snap, navError: failed ? safeText(nav.errorText, 80) : null });
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
          const left = await win.stop();
          /* the window visited the platform's sign-in pages: forget them (the sign-in itself stays), once nothing holds the profile */
          try { if (!left.length && !holdsProfile(profileDir)) scrubProfile(profileDir); } catch (e) { /* the final scrub tries again */ }
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
         expansion (closed <details>, expanders, repeated until nothing new opens). All snapshots are kept: the files and the text are
         the UNION of what they show. */
      /* The view a snapshot was taken in: which tab was open (a switch that is a tab changes it). */
      const viewNow = async () => {
        const open = ((await pageOp(job.tab, 'controls')).tabs || []).find((t) => t.selected);
        return { tab: open ? { label: open.label, path: open.path } : null, more: 0, scroll: 0 };
      };
      const expandNow = async () => { const total = await expandAll(job.tab, snaps, { signal, view: BASE }); if (total.lost) note(LOST('after something was opened')); };
      const stamp = (list, view) => { for (const x of list) x.view = { tab: view.tab ? { ...view.tab } : null, more: 0, scroll: 0 }; };
      const snaps = await stabilize(job.tab, page.snap, { signal, waits: timeouts.stable });
      let BASE = await viewNow();
      stamp(snaps, BASE);
      await expandNow();
      let snap = snaps[snaps.length - 1];

      /* What it took to build the list of files, for when the page has to be rebuilt (it was reloaded, or a download click left it): the
         switch, and the home tab. A candidate's own tab, "Load more" presses and scroll steps are in its view. */
      const recipe = { toggle: null, home: null, afterClick: 0, appliedAt: -1 };
      const growWait = async (than) => {   /* a page may take a few seconds to add the files */
        const end = Date.now() + timeouts.grow;
        let latest = await takePage(job.tab);
        while (fileCandidates(latest).length <= than && Date.now() < end) { check(); await sleep(400); latest = await takePage(job.tab); }
        return latest;
      };
      const sameControl = (want, t) => t.option === want.option && (want.key ? t.key === want.key : t.label === want.label);

      /* "Show all files": the control learned for this host, or one whose label says so; click it, wait for the list to grow, open what
         it revealed. A switch that is already on gets the same wait: the platform may remember it and still be fetching the files. */
      const before = fileCandidates(snap);
      const learned = store.learnedToggleInfo(mappingsFile, job.host);
      const found = findAllFilesState(snap.toggles, learned);
      const pick = found && found.toggle;
      const usedLearned = Boolean(pick && learned && ((learned.key && pick.key === learned.key) || (learned.label && pick.label.trim().toLowerCase() === learned.label.trim().toLowerCase())));
      const alreadyOn = Boolean(found && found.on);
      let list = before;
      Object.assign(st.toggle, { filesBefore: before.length, filesAfter: before.length, found: Boolean(pick), label: pick ? pick.label : '', learned: usedLearned, flipped: alreadyOn });
      if (pick) recipe.toggle = { key: pick.key, label: pick.label, path: pick.path, option: pick.option, kind: pick.kind, learned: usedLearned };
      if (pick && !alreadyOn && pick.path) {
        const clickedAt = Date.now() - 50;
        const clicked = await pageOp(job.tab, 'activate', { path: pick.path, kind: 'toggle', tkind: pick.kind || 'switch', label: pick.label, option: pick.option, learned: usedLearned });
        if (clicked.ok) {
          await settle(clickedAt);
          snap = await growWait(before.length);
          BASE = await viewNow();
          stamp([snap], BASE);
          snaps.push(snap);
          recipe.afterClick = fileCandidates(snap).length;
          recipe.appliedAt = loads;
          const now2 = snap.toggles.find((t) => t.path === pick.path && t.option === pick.option && t.label === pick.label);
          await expandNow();
          snap = snaps[snaps.length - 1];
          list = fileCandidates(snap);
          st.toggle.flipped = Boolean((now2 && now2.checked) || list.length > before.length);
          st.toggle.filesAfter = list.length;
        }
      } else if (pick && alreadyOn) {
        snap = await growWait(unionCandidates(snaps.map(fileCandidates)).length);
        stamp([snap], BASE);
        snaps.push(snap);
        recipe.afterClick = fileCandidates(snap).length;
        recipe.appliedAt = loads;
        await expandNow();
        snap = snaps[snaps.length - 1];
        list = fileCandidates(snap);
        st.toggle.filesAfter = list.length;
      }

      /* The switch is on again, the way it was when the list was built (a reload, or a page that forgot it). A control that shows its
         state (a switch, a checkbox, a pressed-button, a choice) is pressed only when it is off. A plain button never says whether it is
         on, and pressing it again may turn the files off: it is pressed once per load of the task link, and after a reload only when the
         list is shorter than it was after the first press. Never twice in one load. */
      const ensureToggle = async (current) => {
        const want = recipe.toggle;
        if (!want || want.kind === 'tab') return current;   /* a tab is a view: each candidate brings its own */
        const t = current.toggles.find((x) => sameControl(want, x)) || current.toggles.find((x) => x.label === want.label && x.option === want.option);
        if (!t || t.disabled || !t.path) return current;
        if (want.kind === 'button') {
          if (recipe.appliedAt === loads) return current;
          if (fileCandidates(current).length >= recipe.afterClick) { recipe.appliedAt = loads; return current; }
        } else if (t.checked) return current;
        const pressedAt = Date.now() - 50;
        const r = await pageOp(job.tab, 'activate', { path: t.path, kind: 'toggle', tkind: t.kind || 'switch', label: t.label, option: t.option, learned: Boolean(want.learned) });
        if (!r.ok) return current;
        recipe.appliedAt = loads;
        await settle(pressedAt);
        return growWait(Math.max(0, recipe.afterClick - 1));
      };
      /* Load an address of the task (the link itself, or a page of a pager made of links), then put the switch and the open folders back. */
      const goto = async (target) => {
        const again = await loadOnce(target);
        if (again.cls.state === 'needs-sign-in' || again.cls.state === 'needs-person') throw new LinkError(`The platform asks you to sign in again. ${IMPORT_HINT}`, 502, 'sign-in-loop');
        if (again.cls.state !== 'ready') throw new LinkError(again.cls.reason, 502, again.cls.state);
        await ensureToggle(await takePage(job.tab));
        await expandAll(job.tab, [], { signal, snapshots: false });
      };
      /* Where the page is, after the person has used the window or a download left it: back on the task page (or below it), or the
         loader goes back once, looks again and puts the switch and the open folders back. After the person has used the window the page
         they left is accepted only when it is the SAME DOCUMENT as before (the marker the loader set at its start survives a router change
         and does not survive a real navigation) or the task path or below; a page they wandered to is not the task. */
      let pageHref = href;   /* the task page: the link, or the page the person left it on */
      const backToPage = async ({ accept = false } = {}) => {
        const probe = await where();
        if (probe && withinPage(probe.href, pageHref)) return;
        if (accept && probe && probe.ready && !probe.pw && job.doc && probe.doc === job.doc && (() => { try { const x = new URL(probe.href); return x.origin === new URL(href).origin && !LOGIN_PATH_RE.test(x.pathname); } catch (e) { return false; } })()) { pageHref = probe.href; return; }
        await goto(href);
      };
      /* A click candidate again: the page is made the way it was when the candidate was seen (the switch, its tab, its "Load more"
         presses, its scroll steps), and the element is found by what it is, not where it was. */
      const findOn = (current, c) => {
        const mode = c.retried ? 'navigate' : 'click';
        const there = fileCandidates(current).filter((x) => x.mode === mode && x.path);
        const pick = (hits) => (hits.length ? hits[Math.min(Math.max(1, c.occ || 1), hits.length) - 1] : null);
        /* the live page shows one tab, the one the view put it on: the tab is not part of this comparison */
        const live = { withTab: false };
        const want = candidateKey(c.retried ? { ...c, mode: 'navigate' } : c, live);
        return pick(there.filter((x) => candidateKey(x, live) === want))
          || (c.retried ? null : pick(there.filter((x) => candidateKey(x, { withGroup: false, withTab: false }) === candidateKey(c, { withGroup: false, withTab: false }))));   /* its heading may have changed */
      };
      const locate = async (c) => {
        await backToPage();
        let current = await ensureToggle(await takePage(job.tab));
        /* the live page is trusted only when it shows the tab the candidate was seen in: the same name can be in two tabs */
        const wantTab = c.view && c.view.tab ? c.view.tab.label : null;
        const open = ((await pageOp(job.tab, 'controls')).tabs || []).find((t) => t.selected);
        let hit = !wantTab || (open && tabKey(open.label) === tabKey(wantTab)) ? findOn(current, c) : null;
        if (!hit) {
          const r = await replay(job.tab, c.view || BASE, recipe.home, { signal, pos, goto, homeUrl: href });
          if (!r.ok) return { ok: false, why: r.why };
          current = await takePage(job.tab);
          hit = findOn(current, c);
          /* a candidate with no tab on record (the page has none, or the view was not exact): every tab, one after the other */
          if (!hit && !wantTab) {
            for (const t of (await pageOp(job.tab, 'controls')).tabs) {
              const r2 = await replay(job.tab, { tab: { label: t.label, path: t.path }, more: 0, scroll: 0 }, recipe.home, { signal, pos, goto, homeUrl: href });
              if (!r2.ok) continue;
              hit = findOn(await takePage(job.tab), c);
              if (hit) break;
            }
          }
        }
        return hit ? { ok: true, path: hit.path } : { ok: false, why: 'the file is no longer on the page (its row could not be found again)' };
      };

      if (!alreadyOn && (!st.toggle.flipped || (list.length <= before.length && !usedLearned))) {
        set(job, 'needs-person', PERSON_MESSAGE);
        if (!headless) await job.tab.front();
        const baseline = snap.toggles;
        await waitPerson(async () => job.st.state !== 'needs-person', timeouts.person, `No answer within ${waited(timeouts.person)}.`);   /* continue() moves the state on */
        await backToPage({ accept: true });
        await settle();
        snap = await takePage(job.tab);
        BASE = await viewNow();
        stamp([snap], BASE);
        snaps.push(snap);
        await expandNow();
        snap = snaps[snaps.length - 1];
        list = fileCandidates(snap);
        st.toggle.filesAfter = list.length;
        const changed = changedToggle(baseline, snap.toggles);
        if (changed) {
          Object.assign(st.toggle, { found: true, label: changed.label, flipped: true });
          recipe.toggle = { key: changed.key, label: changed.label, path: changed.path, option: changed.option, kind: changed.kind, learned: true };   /* the person chose it: its label need not say "all files", but the rules about actions still hold */
          recipe.afterClick = Math.max(0, list.length - 1);
          recipe.appliedAt = loads;
          if (list.length > before.length && store.learnToggle(mappingsFile, job.host, changed.label, new Date(now()).toISOString(), changed.key)) st.toggle.learned = true;
        }
      }

      /* Tabs, "Load more", scrolling; then the files of every snapshot as one list. A limit that ended a step is told in a note. */
      set(job, 'loading', `Looking for every file.${KEEP_OPEN}`);
      const explore = async () => { const info = await gather(job.tab, snaps, { signal, budgetMs: timeouts.expand, pos, goto, homeUrl: href }); recipe.home = info.home; for (const text of info.capped) note(text); };
      /* a request that was still waiting at a settle: it answered since (take one more look, its files may be new) or it never did (say so) */
      const lateLook = async () => {
        let answered = 0; let pending = 0;
        for (const id of suspects) { const e = job.tab.net.inflight.get(id); if (e && !e.responded) pending += 1; else answered += 1; }
        suspects.clear();
        if (answered) { const late = await takePage(job.tab); stamp([late], BASE); snaps.push(late); }
        if (pending) note(LOST('when the files were listed'));
      };
      await explore();
      await lateLook();
      let { list: candidatesAll, merged: mergedRows } = unionWithCheck(snaps.map(fileCandidates));
      if (!candidatesAll.length && !snaps.some((s) => droppedCandidates(s).length)) {
        set(job, 'needs-person', NO_FILES_MESSAGE);
        if (!headless) await job.tab.front();
        await waitPerson(async () => job.st.state !== 'needs-person', timeouts.person, `No answer within ${waited(timeouts.person)}.`);
        await backToPage({ accept: true });
        await settle();
        const again = await stabilize(job.tab, await takePage(job.tab), { signal, waits: timeouts.stable });
        BASE = await viewNow();
        stamp(again, BASE);
        snaps.push(...again);
        await expandNow();
        await explore();
        await lateLook();
        ({ list: candidatesAll, merged: mergedRows } = unionWithCheck(snaps.map(fileCandidates)));
        st.toggle.filesAfter = Math.max(st.toggle.filesAfter, candidatesAll.length);
      }
      const droppedAll = unionDropped(snaps.map(droppedCandidates));
      /* what the looks saw but the loader could not use or read: hidden file links (a closed dialog, a drawer), frames of another site,
         a page read only in part */
      const cut = {}; let blockedFrames = 0; const hiddenByKey = new Map();
      for (const sn of snaps) {
        for (const k of Object.keys(sn.truncated || {})) if (sn.truncated[k]) cut[k] = true;
        blockedFrames = Math.max(blockedFrames, (sn.frames && sn.frames.blocked) || 0);
        for (const h of sn.hidden || []) hiddenByKey.set(h.button ? `b|${h.text}` : navigateKey(h.href), h);
      }
      const haveKeys = new Set(candidatesAll.filter((c) => c.mode === 'navigate').map((c) => navigateKey(c.href)));
      const haveTexts = new Set(candidatesAll.map((c) => c.text));
      let hiddenFiles = 0;
      for (const h of hiddenByKey.values()) {
        const usable = h.button ? nameIsDownload(h.names || [h.text]) : Boolean(linkVerdict(h).allow);
        if (usable && !(h.button ? haveTexts.has(h.text) : haveKeys.has(navigateKey(h.href)))) hiddenFiles += 1;
      }
      if (hiddenFiles) note(`${plural(hiddenFiles, 'file link', 'file links')} on the page ${hiddenFiles === 1 ? 'is' : 'are'} hidden (a closed dialog, drawer or panel) and ${hiddenFiles === 1 ? 'was' : 'were'} not downloaded`);
      if (blockedFrames) note(`${plural(blockedFrames, 'embedded frame', 'embedded frames')} from another site (or sandboxed) could not be read, so any files in ${blockedFrames === 1 ? 'it' : 'them'} were not seen`);
      if (cut.elements || cut.time || cut.roots) note('the page is very large or slow to read; reading stopped early, so some files or text may be missing');
      if (cut.links) note(`the page has more than ${PAGE_LIMITS.linksMax} file-like links; the rest were not read`);
      if (cut.buttons) note(`the page has more than ${PAGE_LIMITS.buttonsMax} file-like buttons; the rest were not read`);
      if (cut.toggles) note(`the page has more than ${PAGE_LIMITS.togglesMax} switches, tabs and choices; the rest were not read`);
      if (cut.sections || cut.text) note(`some of the page text was cut at the limits (${limits.sections} sections, ${limits.sectionChars} characters each)`);
      /* the backstop: more distinct rows were seen than files kept, so some rows that look different were taken for one file */
      if (mergedRows > 0) note(`${mergedRows} row${mergedRows === 1 ? '' : 's'} that look different on the page were taken for another file's row, so ${mergedRows === 1 ? 'a file' : 'files'} may be missing`);
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
      for (const d of droppedAll) st.skipped.push({ label: cleanLabel(d.label, 160), group: cleanLabel(d.group, 120), reason: d.reason });
      for (const c of wanted.slice(limits.files)) st.skipped.push({ label: cleanLabel(c.label, 160), group: cleanLabel(c.group, 120), reason: `over the limit of ${limits.files} files` });
      for (const c of candidates) c.pageTab = job.tab;
      set(job, 'downloading', candidates.length ? `Downloading ${candidates.length} file${candidates.length === 1 ? '' : 's'}.${KEEP_OPEN}` : 'No files were offered on this page.');
      if (!headless) await job.tab.front();
      fs.mkdirSync(stageDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
      const dl = new DownloadManager(job.browser.cdp, {
        stageDir, destDir, isAllowed, newWindow: job.browser.headless, ensurePage: backToPage, locate,
        limits: { maxFileBytes: limits.fileBytes, maxTotalBytes: limits.totalBytes, idleMs: timeouts.stall, fileTimeoutMs: timeouts.file, beginTimeoutMs: timeouts.begin, phaseMs: timeouts.phase },
      });
      job.dl = dl;
      let stopped = null;
      let duplicates = 0;
      if (candidates.length) {
        await dl.start();
        const out = await dl.fetchAll(candidates, {
          signal,
          onFile: (r, c) => { if (r.duplicate) { duplicates += 1; return; } if (r.state === 'done') st.files.push({ name: r.name, size: r.size, sha256: r.sha256, group: cleanLabel(c.group, 120), label: cleanLabel(c.label, 160) }); },
        });
        check();
        stopped = out.stopped;
        if (duplicates) note(`${duplicates} file${duplicates === 1 ? ' that was' : 's that were'} listed more than once (same name, same content) kept once`);
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
        fileList, skipped: st.skipped.map((s) => ({ ...s })), notes: capNotes.slice(), page: st.page, loadedAt: new Date(now()).toISOString(),
      });
      const notes = [];
      if (st.skipped.length) notes.push(`${st.skipped.length} not kept (listed in skipped)`);
      if (job.unsettled) notes.push('settled:false, the page kept changing, so some files or text may be missing');
      for (const n of capNotes) notes.push(n);
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
          : error instanceof CdpError && error.code === 'LAUNCH' ? safeText(error.message, 300)
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
      try { if (!holdsProfile(profileDir)) scrubProfile(profileDir); } catch (e) { /* the next load tries again */ }   /* every way out forgets where the profile has been */
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
