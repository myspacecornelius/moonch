'use strict';
/* One browser tab, attached over the pipe. Owns: the domains that are switched on, a small log of what the tab asked the network for
   (fixed shapes only), navigation with its redirect chain, "is the page finished?", and evaluation in an ISOLATED WORLD.

   Why an isolated world: a page can replace Array.prototype.map, JSON.stringify or Document.prototype.querySelectorAll in its own
   world. Code run through Page.createIsolatedWorld sees the same DOM with its own, untouched built-ins. It also needs no Runtime.enable,
   and Runtime.enable is never called: it is the switch some bot detectors look for. Only constant functions are evaluated; their
   arguments go in as JSON (evalFn), never as pieces of code.

   Exports: Tab, safeUrl, waitForSettled. */

const { CdpError, sleep } = require('./cdp.cjs');

const WORLD = 'fst';

/* Installed at the start of every document in the isolated world. It never touches the page's world. */
const MUTATION_SCRIPT = `(() => {
  const w = globalThis;
  if (w.__fstMo) return;
  w.__fstLast = performance.now(); w.__fstCount = 0;
  w.__fstMo = new MutationObserver((list) => { w.__fstLast = performance.now(); w.__fstCount += list.length; });
  w.__fstMo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
})();`;

/* A URL that is safe to print or keep: origin and path only. Query strings carry signatures and tokens, fragments carry state. */
function safeUrl(text) {
  try {
    const u = new URL(text);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${u.protocol}\u2026`;
    return `${u.origin}${u.pathname.length > 90 ? u.pathname.slice(0, 87) + '\u2026' : u.pathname}${u.search || u.hash ? '?\u2026' : ''}`;
  } catch (e) { return '(unreadable url)'; }
}

/* Any text that may have been built from a URL or a browser message, with every URL cut down to origin and path. */
const safeText = (text, max = 300) => String(text == null ? '' : text).replace(/\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'`<>)\]}]+/gi, (m) => safeUrl(m)).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max);

/* Text that came from a page and is shown or stored as a label, a group or a heading: no C0/C1 control, line or paragraph separator,
   zero-width, bidi or invisible-operator character (they can reorder or hide what the owner reads), runs of blanks folded, cut at max. */
const HIDDEN_CHARS = new RegExp('[' + ['\\u0000-\\u001f', '\\u007f-\\u009f', '\\u2028-\\u2029', '\\u200b-\\u200f', '\\u202a-\\u202e', '\\u2060-\\u2064', '\\u2066-\\u2069', '\\ufeff'].join('') + ']', 'g');
const cleanLabel = (text, max = 160) => String(text == null ? '' : text).replace(HIDDEN_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const cap = (list, item, max = 50) => { if (list.length < max) list.push(item); };

class Tab {
  constructor(cdp, targetId, sessionId) {
    this.cdp = cdp;
    this.targetId = targetId;
    this.frameId = targetId;                     /* for a page target the main frame id equals the target id */
    this.sessionId = sessionId;
    this.s = cdp.session(sessionId);
    this.closed = false;
    this.dialogs = [];
    this.net = { inflight: new Map(), quiet: new Set(), lastActivityAt: Date.now(), requestCount: 0, hops: [], mainResponse: null, lifecycle: {}, apiErrors: [] };
    this.navStartedAt = Date.now();
    this.unsubscribe = [];
    this.wire();
  }

  static async open(cdp, { newWindow = false } = {}) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow, background: false });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Tab(cdp, targetId, sessionId);
    await Promise.all([
      tab.s.send('Page.enable'),
      tab.enableNetwork(),
      tab.s.send('Page.setLifecycleEventsEnabled', { enabled: true }),
      /* A page in a background tab reports visibilityState hidden and its timers are throttled; this tells it it is focused. */
      tab.s.send('Emulation.setFocusEmulationEnabled', { enabled: true }),
      tab.s.send('Page.addScriptToEvaluateOnNewDocument', { source: MUTATION_SCRIPT, worldName: WORLD }),
    ]);
    return tab;
  }

  /* The network domain delivers Cookie and Authorization values and the body of a form that is being posted. While the person types a
     password the loader switches it off (pauseNetwork) and switches it on again when the person is done. */
  enableNetwork() {
    return Promise.all([
      this.s.send('Network.enable', { maxTotalBufferSize: 1024 * 1024, maxResourceBufferSize: 256 * 1024 }),
      this.s.send('Network.setCacheDisabled', { cacheDisabled: true }),
      this.s.send('Network.setBypassServiceWorker', { bypass: true }),   /* a service worker can answer from its own cache, unseen */
    ]);
  }
  pauseNetwork() { this.net.inflight.clear(); return this.s.send('Network.disable').catch(() => {}); }

  wire() {
    const on = (method, handler) => this.unsubscribe.push(this.s.on(method, handler));
    const net = this.net;
    const touch = () => { net.lastActivityAt = Date.now(); };
    /* Only fixed shapes are kept: ids, types, status codes, safe URLs (and the raw URL of a redirect hop, in memory, for the classifier). */
    on('Network.requestWillBeSent', (p) => {
      touch();
      net.inflight.set(p.requestId, { type: p.type, startedAt: Date.now(), responded: false, lastDataAt: Date.now() });
      net.requestCount += 1;
      if (p.type === 'Document' && p.frameId === this.frameId) {
        if (p.redirectResponse && net.hops.length) net.hops[net.hops.length - 1].status = p.redirectResponse.status;
        net.hops.push({ rawUrl: p.request.url, status: null });
      }
    });
    on('Network.dataReceived', (p) => { const entry = net.inflight.get(p.requestId); if (entry) entry.lastDataAt = Date.now(); });   /* a transfer that is still going */
    on('Network.responseReceived', (p) => {
      touch();
      const entry = net.inflight.get(p.requestId);
      if (entry) { entry.responded = true; entry.lastDataAt = Date.now(); }
      if (p.type === 'Document' && p.frameId === this.frameId) {
        net.mainResponse = { status: p.response.status };
        const last = net.hops[net.hops.length - 1];
        if (last && last.status === null) last.status = p.response.status;
      }
      if ((p.type === 'XHR' || p.type === 'Fetch') && p.response.status >= 400) cap(net.apiErrors, { status: p.response.status });
    });
    on('Network.loadingFinished', (p) => { touch(); net.inflight.delete(p.requestId); net.quiet.delete(p.requestId); });
    on('Network.loadingFailed', (p) => { touch(); net.inflight.delete(p.requestId); net.quiet.delete(p.requestId); });
    on('Page.lifecycleEvent', (p) => { if (p.frameId === this.frameId) net.lifecycle[p.name] = Date.now() - this.navStartedAt; });
    /* A dialog freezes the page's script until somebody answers. Never accept anything but the "leave this page?" question. */
    on('Page.javascriptDialogOpening', (p) => {
      cap(this.dialogs, { type: p.type });
      this.s.send('Page.handleJavaScriptDialog', { accept: p.type === 'beforeunload' }).catch(() => {});
    });
  }

  /* Page.navigate answers when the navigation COMMITS (after every redirect), or fails. It carries isDownload:true plus errorText
     net::ERR_ABORTED when the response turned into a download. It does not wait for load. */
  async navigate(url, { timeout = 30000 } = {}) {
    const net = this.net;
    net.hops = []; net.mainResponse = null; net.lifecycle = {}; net.apiErrors = []; net.lastActivityAt = Date.now();
    this.navStartedAt = Date.now();
    let r;
    try { r = await this.s.send('Page.navigate', { url }, { timeout }); }
    catch (error) {
      /* No answer in time: stop the load that is still pending so that later calls on this tab are not stuck behind it. */
      if (error.code === 'TIMEOUT') this.s.send('Page.stopLoading', {}, { timeout: 2000 }).catch(() => {});
      throw error;
    }
    return { errorText: r.errorText || null, isDownload: Boolean(r.isDownload) };
  }

  waitForLoad({ timeout = 20000 } = {}) {
    if (this.net.lifecycle.load !== undefined) return Promise.resolve();
    return this.s.waitFor('Page.lifecycleEvent', { filter: (p) => p.name === 'load' && p.frameId === this.frameId, timeout }).then(() => undefined);
  }

  /* Run code in the loader's own JS world. `expression` is source text; the value must be JSON-able. userGesture: the page treats the
     code as the result of a click by the person (Chrome limits the downloads a page starts by itself, and a click is not one of them). */
  async evalIsolated(expression, { timeout = 15000, retries = 1, userGesture = false } = {}) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const { executionContextId } = await this.s.send('Page.createIsolatedWorld', { frameId: this.frameId, worldName: WORLD });
      let r;
      try {
        r = await this.s.send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true, timeout, ...(userGesture ? { userGesture: true } : {}) }, { timeout: timeout + 3000 });
      } catch (error) {
        if (attempt < retries && /context/i.test(error.message)) { await sleep(30); continue; }   /* the document was replaced under us */
        throw error;
      }
      if (r.exceptionDetails) throw new CdpError(`Script error: ${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text}`, { code: 'SCRIPT' });
      return r.result.value;
    }
    throw new CdpError('The page changed while the script was starting.', { code: 'SCRIPT' });
  }

  /* A constant function and ONE JSON argument. Nothing from the page, the link or the person is ever spliced into code. */
  evalFn(fn, arg, options) { return this.evalIsolated(`(${fn.toString()})(${JSON.stringify(arg === undefined ? null : arg)})`, options); }

  /* The ids of the frames of this tab, its own first (a download that starts in an iframe names the iframe's frame). */
  async frameIds() {
    try {
      const { frameTree } = await this.s.send('Page.getFrameTree', {}, { timeout: 3000 });
      const out = [];
      const walk = (node) => { if (node && node.frame) out.push(node.frame.id); for (const child of (node && node.childFrames) || []) walk(child); };
      walk(frameTree);
      return out.length ? out : [this.frameId];
    } catch (e) { return [this.frameId]; }
  }

  /* Bring this tab's window to the front (macOS opens Chrome behind the Studio's own window). Failures are ignored. */
  async front() {
    await this.s.send('Page.bringToFront', {}, { timeout: 3000 }).catch(() => {});
    await this.cdp.send('Target.activateTarget', { targetId: this.targetId }, { timeout: 3000 }).catch(() => {});
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.unsubscribe) off();
    try { await this.cdp.send('Target.closeTarget', { targetId: this.targetId }, { timeout: 3000 }); } catch (e) { /* already gone */ }
  }
}

/* "Is the page finished?" There is no event for that. A single-page app fetches its data AFTER the HTML has loaded, renders, and then
   often fetches more. So wait for TWO quiet signals at once and give up after a hard deadline:
     network idle   nothing in flight that is still doing something, and nothing finished for `idleMs`, from the tab's own request log.
                    A request counts as busy while it is waiting for its response (`stalledMs`, or `stalledApiMs` for XHR and fetch:
                    the data of a single-page app can be slow) or, once its response has begun, while data keeps arriving (`stalledMs`
                    without a byte). A request that is past that is idle: a beacon or keepalive fetch nobody reads, a long poll. It is
                    remembered as idle (tab.net.quiet), so only the first settle pays for it, and it never makes the page "unsettled";
     DOM stable     the MutationObserver installed at document start has seen nothing for `quietMs`, and readyState is "complete".
   patientMs: past maxMs, keep waiting while an API request is still waiting for its answer, until patientMs (a tab or a "Load more" served by
   a slow API); a DOM that never goes quiet (a ticker) still ends at maxMs. lost: how many API requests that started since `since` were
   still waiting when the settle ended (their files may be missing, the caller says so). graceMs: with `since`, not settled before that long
   after it (the request a click started shows up in the log a moment later).
   A page that never settles (a ticker, a poll) is not an error: the result says settled:false and the loader goes on with what is there. */
const IGNORED_TYPES = new Set(['WebSocket', 'EventSource', 'Ping', 'Prefetch', 'CSPViolationReport']);
const SETTLE_DOM = '({ readyState: document.readyState, quiet: performance.now() - (globalThis.__fstLast || 0), count: globalThis.__fstCount || 0 })';

async function waitForSettled(tab, { idleMs = 500, quietMs = 400, maxMs = 15000, pollMs = 80, stalledMs = 2500, stalledApiMs = 20000, patientMs = 0, since = 0, graceMs = 0, signal } = {}) {
  const started = Date.now();
  const quiet = tab.net.quiet || (tab.net.quiet = new Set());
  let lastDom = { readyState: '?', quiet: 0, count: 0 };
  for (;;) {
    if (signal && signal.aborted) throw new CdpError('Cancelled.', { code: 'CANCELLED' });
    const now = Date.now();
    let busy = 0;      /* requests that still count */
    let waiting = 0;   /* of those, XHR and fetch that have not answered yet (the only ones a deadline does not hold against the page) */
    let fresh = 0;     /* of those, the ones that started since `since` (the click or the press that this settle follows) */
    for (const [id, entry] of tab.net.inflight) {
      if (IGNORED_TYPES.has(entry.type) || quiet.has(id)) continue;
      const api = entry.type === 'XHR' || entry.type === 'Fetch';
      const live = entry.responded ? now - entry.lastDataAt <= stalledMs : now - entry.startedAt <= (api ? stalledApiMs : stalledMs);
      if (!live) { quiet.add(id); continue; }
      busy += 1;
      if (api && !entry.responded) { waiting += 1; if (entry.startedAt >= since) fresh += 1; }
    }
    try { lastDom = await tab.evalIsolated(SETTLE_DOM, { timeout: 1500, retries: 0 }); }
    catch (e) { lastDom = { readyState: 'loading', quiet: 0, count: lastDom.count }; }   /* the document is being replaced: not stable yet */
    const networkIdle = busy === 0 && now - tab.net.lastActivityAt >= idleMs;
    const domStable = lastDom.readyState === 'complete' && lastDom.quiet >= quietMs;
    /* graceMs: the request that a click has just started is not in the log yet (its event is still on its way); do not call it quiet before then */
    const graced = !(graceMs && since && now - since < graceMs);
    if (graced && networkIdle && domStable) return { settled: true, ms: Date.now() - started };
    if (now - started >= maxMs) {
      if (waiting > 0 && now - started < patientMs) { await sleep(pollMs); continue; }   /* an answer is on its way: patientMs is the longest the caller will wait for one */
      /* at the deadline an API request that is still waiting is not held against the page: it may be a long poll. It is forgotten
         from now on, so the next settle does not wait for it again. */
      if (domStable && busy === waiting) {
        for (const [id, entry] of tab.net.inflight) if ((entry.type === 'XHR' || entry.type === 'Fetch') && !entry.responded) quiet.add(id);
        return { settled: true, ms: Date.now() - started, apiPending: waiting, lost: fresh };
      }
      return { settled: false, ms: Date.now() - started, lost: fresh };
    }
    await sleep(pollMs);
  }
}

module.exports = { Tab, safeUrl, safeText, cleanLabel, waitForSettled, WORLD };
