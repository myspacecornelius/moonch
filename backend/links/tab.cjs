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
    this.net = { inflight: new Map(), lastActivityAt: Date.now(), requestCount: 0, hops: [], mainResponse: null, lifecycle: {}, apiErrors: [] };
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
      net.inflight.set(p.requestId, { type: p.type, startedAt: Date.now() });
      net.requestCount += 1;
      if (p.type === 'Document' && p.frameId === this.frameId) {
        if (p.redirectResponse && net.hops.length) net.hops[net.hops.length - 1].status = p.redirectResponse.status;
        net.hops.push({ rawUrl: p.request.url, status: null });
      }
    });
    on('Network.responseReceived', (p) => {
      touch();
      if (p.type === 'Document' && p.frameId === this.frameId) {
        net.mainResponse = { status: p.response.status };
        const last = net.hops[net.hops.length - 1];
        if (last && last.status === null) last.status = p.response.status;
      }
      if ((p.type === 'XHR' || p.type === 'Fetch') && p.response.status >= 400) cap(net.apiErrors, { status: p.response.status });
    });
    on('Network.loadingFinished', (p) => { touch(); net.inflight.delete(p.requestId); });
    on('Network.loadingFailed', (p) => { touch(); net.inflight.delete(p.requestId); });
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

  /* Run code in the loader's own JS world. `expression` is source text; the value must be JSON-able. */
  async evalIsolated(expression, { timeout = 15000, retries = 1 } = {}) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const { executionContextId } = await this.s.send('Page.createIsolatedWorld', { frameId: this.frameId, worldName: WORLD });
      let r;
      try {
        r = await this.s.send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true, timeout }, { timeout: timeout + 3000 });
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
     network idle   no request in flight (long-running ones are ignored after `stalledMs`: a long poll never ends) and nothing
                    finished for `idleMs`, from the tab's own request log;
     DOM stable     the MutationObserver installed at document start has seen nothing for `quietMs`, and readyState is "complete".
   A page that never settles (a ticker, a poll) is not an error: the result says settled:false and the loader goes on with what is there. */
const IGNORED_TYPES = new Set(['WebSocket', 'EventSource', 'Ping', 'Prefetch', 'CSPViolationReport']);
const SETTLE_DOM = '({ readyState: document.readyState, quiet: performance.now() - (globalThis.__fstLast || 0), count: globalThis.__fstCount || 0 })';

async function waitForSettled(tab, { idleMs = 500, quietMs = 400, maxMs = 15000, pollMs = 80, stalledMs = 2500, signal } = {}) {
  const started = Date.now();
  let lastDom = { readyState: '?', quiet: 0, count: 0 };
  for (;;) {
    if (signal && signal.aborted) throw new CdpError('Cancelled.', { code: 'CANCELLED' });
    const now = Date.now();
    let busy = 0;
    for (const entry of tab.net.inflight.values()) if (!IGNORED_TYPES.has(entry.type) && now - entry.startedAt <= stalledMs) busy += 1;
    try { lastDom = await tab.evalIsolated(SETTLE_DOM, { timeout: 1500, retries: 0 }); }
    catch (e) { lastDom = { readyState: 'loading', quiet: 0, count: lastDom.count }; }   /* the document is being replaced: not stable yet */
    const networkIdle = busy === 0 && now - tab.net.lastActivityAt >= idleMs;
    const domStable = lastDom.readyState === 'complete' && lastDom.quiet >= quietMs;
    if (networkIdle && domStable) return { settled: true, ms: Date.now() - started };
    if (now - started >= maxMs) return { settled: false, ms: Date.now() - started };
    await sleep(pollMs);
  }
}

module.exports = { Tab, safeUrl, safeText, cleanLabel, waitForSettled, WORLD };
