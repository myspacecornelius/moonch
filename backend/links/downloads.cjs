'use strict';
/* Getting files onto the disk through Chrome's own download manager, with limits the loader enforces itself.

   Mechanism, all measured in the prototype:
     Browser.setDownloadBehavior { behavior: 'allowAndName', downloadPath, eventsEnabled: true }
         browser-wide; Chrome writes <downloadPath>/<guid>.crdownload while the transfer runs and renames it to <downloadPath>/<guid>
         when it is complete. The name we keep is our choice (names.cjs); nothing a server suggests is used as a path.
     Browser.downloadWillBegin { frameId, guid, url, suggestedFilename }       url is the FINAL url after redirects; frameId is the tab
     Browser.downloadProgress  { guid, totalBytes, receivedBytes, state }      inProgress | completed (+ filePath) | canceled
         the events come in bursts, too coarse to enforce a byte cap on a fast link, so the loader also polls the size of the
         .crdownload file every 40 ms.
     Browser.cancelDownload { guid }   state canceled, the partial file is removed by Chrome.

   One tab per file. The tab is opened, the request gate (gate.cjs) is attached, the tab navigates to the file URL, and the response
   stage tells the loader the status and headers BEFORE any body byte is read:
     status >= 400                      -> no file (the error page is not saved as a file)
     Content-Length above the cap       -> refused up front
     text/html without attachment       -> not a file (an expired session answers a file URL with the login page)
     an inline type (pdf, text, image, json) without "attachment"
                                        -> Chrome would show it in the tab and no download event would ever fire. The gate adds
                                           "content-disposition: attachment" so the download manager takes it.
   Clicking an element in the task page is the other way in (buttons that build a blob: URL, a download attribute): same tracking,
   no response stage. A download nobody asked for (a page that starts one by itself) is cancelled the moment it begins.

   Exports: DownloadManager, DEFAULT_LIMITS, pickName, sha256File. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Tab, safeUrl, safeText } = require('./tab.cjs');
const { gateTab } = require('./gate.cjs');
const { sanitizeFileName, uniqueName, insideDir } = require('./names.cjs');
const { LOGIN_PATH_RE } = require('./auth-wall.cjs');
const { sleep } = require('./cdp.cjs');

const DEFAULT_LIMITS = {
  maxFileBytes: 200 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  idleMs: 60000,          /* no growth for this long: stalled */
  fileTimeoutMs: 600000,  /* wall clock for one file */
  beginTimeoutMs: 15000,  /* the click or navigation produced no download */
  navTimeoutMs: 30000,
  pollMs: 40,
};

const INLINE_TYPE = (ct) => ct.startsWith('text/') || ct.startsWith('image/') || ct.startsWith('audio/') || ct.startsWith('video/') || ct === 'application/pdf' || ct === 'application/json' || ct.endsWith('+json') || ct.endsWith('+xml') || ct === 'application/xml' || ct === 'application/javascript';

/* Chrome's placeholder for a name it could not use is the word "download" (no extension). Then the name the page showed is better, and
   a missing extension is added from the content type when it is one we know. */
const EXT_BY_TYPE = { 'application/pdf': '.pdf', 'application/zip': '.zip', 'text/csv': '.csv', 'text/plain': '.txt', 'application/json': '.json', 'image/png': '.png', 'image/jpeg': '.jpg',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx', 'application/msword': '.doc', 'application/vnd.ms-excel': '.xls' };
function pickName(suggested, candidate, contentType) {
  let name = suggested;
  if (!name || name === 'download') name = (candidate.nameHint && /\.[A-Za-z0-9]{1,8}$/.test(candidate.nameHint) ? candidate.nameHint : name) || 'download';
  const picked = sanitizeFileName(name);
  if (!/\.[A-Za-z0-9]{1,8}$/.test(picked.name) && EXT_BY_TYPE[contentType]) picked.name += EXT_BY_TYPE[contentType];
  return picked;
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => fs.createReadStream(file).on('data', (d) => hash.update(d)).on('end', resolve).on('error', reject));
  return hash.digest('hex');
}

const clickPath = (selector) => { const el = selector ? document.querySelector(selector) : null; if (!el) return false; el.click(); return true; };

class DownloadManager {
  /* cdp: the connection. stageDir: where Chrome writes (0700, private). destDir: where the kept files go (same file system).
     options: { limits, isAllowed(URL) -> boolean, newWindow } */
  constructor(cdp, { stageDir, destDir, limits = {}, isAllowed = () => true, newWindow = false } = {}) {
    this.cdp = cdp;
    this.stageDir = stageDir;
    this.destDir = destDir;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.isAllowed = isAllowed;
    this.newWindow = newWindow;
    this.jobs = new Map();       /* guid -> job */
    this.byFrame = new Map();    /* frameId -> job waiting for its download to begin */
    this.stray = 0;              /* downloads nobody asked for, cancelled */
    this.taken = new Set();
    this.totalBytes = 0;
    this.nextId = 1;
    this.off = [];
  }

  async start() {
    for (const dir of [this.stageDir, this.destDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const sub = (method, handler) => { this.cdp.on(method, handler); this.off.push(() => this.cdp.off(method, handler)); };
    sub('Browser.downloadWillBegin', (p) => this.onBegin(p));
    sub('Browser.downloadProgress', (p) => this.onProgress(p));
    await this.cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: this.stageDir, eventsEnabled: true });
  }

  /* Back to "deny", cancel what is still running, remove the stage folder. */
  async stop() {
    for (const off of this.off) off();
    this.off = [];
    for (const job of this.jobs.values()) if (!job.terminal) { job.terminal = { state: 'cancelled' }; await this.cancelInBrowser(job); }
    if (!this.cdp.closed) await this.cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true }).catch(() => {});
    fs.rmSync(this.stageDir, { recursive: true, force: true });
  }

  onBegin(p) {
    const job = this.byFrame.get(p.frameId);
    if (!job || job.guid) {
      this.stray += 1;   /* nobody asked for this one */
      this.cdp.send('Browser.cancelDownload', { guid: p.guid }).catch(() => {});
      return;
    }
    job.guid = p.guid;
    job.suggested = p.suggestedFilename;
    job.lastGrowthAt = Date.now();
    this.jobs.set(p.guid, job);
    this.byFrame.delete(p.frameId);
  }

  onProgress(p) {
    const job = this.jobs.get(p.guid);
    if (!job) return;
    job.totalBytes = p.totalBytes;
    if (p.receivedBytes > job.received) { job.received = p.receivedBytes; job.lastGrowthAt = Date.now(); }
    if (p.state === 'completed') job.completed = { filePath: p.filePath };
    else if (p.state === 'canceled') job.browserCancelled = true;
  }

  async cancelInBrowser(job) {
    if (!job.guid) return;
    if (!this.cdp.closed) {
      await this.cdp.send('Browser.cancelDownload', { guid: job.guid }).catch(() => {});
      const until = Date.now() + 1500;
      while (!job.browserCancelled && !job.completed && !this.cdp.closed && Date.now() < until) await sleep(20);
    }
    for (const name of [`${job.guid}.crdownload`, job.guid]) fs.rmSync(path.join(this.stageDir, name), { force: true });
  }

  /* The response-stage decision for a file request. Runs inside the gate, before the body is read. */
  decide(job, params, headers) {
    job.httpStatus = params.responseStatusCode;
    job.contentType = (headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    job.declared = headers['content-length'] !== undefined && /^\d+$/.test(headers['content-length']) ? Number(headers['content-length']) : null;
    const attachment = /^\s*attachment/i.test(headers['content-disposition'] || '');
    const L = this.limits;
    if (job.httpStatus >= 400) { job.terminal = { state: job.httpStatus === 401 || job.httpStatus === 403 ? 'http-denied' : 'http-error' }; return { action: 'fail' }; }
    if (job.declared !== null && job.declared > L.maxFileBytes) { job.terminal = { state: 'too-large', detail: `declared ${job.declared} bytes, cap ${L.maxFileBytes}` }; return { action: 'fail' }; }
    if (job.declared !== null && this.totalBytes + job.declared > L.maxTotalBytes) { job.terminal = { state: 'total-cap', detail: 'the total cap would be passed' }; return { action: 'fail' }; }
    if (!attachment && (job.contentType === 'text/html' || job.contentType === 'application/xhtml+xml') && !/^(html?|xhtml)$/i.test(job.candidate.ext || '')) {
      const afterLogin = (job.tab.net.hops || []).some((h, i) => { try { return i > 0 && LOGIN_PATH_RE.test(new URL(h.rawUrl).pathname); } catch (e) { return false; } });
      job.terminal = afterLogin ? { state: 'needs-sign-in', detail: 'the file link led to a sign-in page' } : { state: 'not-a-file', detail: 'the link answered with a web page, not a file' };
      return { action: 'fail' };
    }
    if (!attachment && (INLINE_TYPE(job.contentType) || job.contentType === 'text/html')) {
      return { action: 'attachment', filename: sanitizeFileName(job.candidate.nameHint || 'file').name };
    }
    return { action: 'continue' };
  }

  /* One file. candidate: { mode: 'navigate'|'click', href, path, text, nameHint, ext, pageTab? }.
     signal: AbortSignal. Resolves with a result object (never rejects for a per-file failure). */
  async fetchOne(candidate, { signal } = {}) {
    const started = Date.now();
    const job = {
      id: this.nextId++, candidate, guid: null, suggested: null, received: 0, totalBytes: 0, lastGrowthAt: started, startedAt: started,
      terminal: null, completed: null, browserCancelled: false, httpStatus: null, contentType: null, declared: null, tab: null,
    };
    const result = { id: job.id, href: safeUrl(candidate.href || ''), mode: candidate.mode, state: 'failed' };
    let tab = null; let gate = null; let ownTab = false;
    try {
      if (signal && signal.aborted) throw Object.assign(new Error('Cancelled.'), { code: 'CANCELLED' });
      if (candidate.mode === 'navigate') {
        ownTab = true;
        tab = await Tab.open(this.cdp, { newWindow: this.newWindow });
        job.tab = tab;
        gate = await gateTab(tab, {
          isAllowed: this.isAllowed,
          onBlocked: (entry) => { if (!job.terminal) job.terminal = { state: 'blocked-host', detail: `a hop went to ${safeText(entry.host, 80)}, which is not allowed` }; },
          file: { onResponse: (params, headers) => this.decide(job, params, headers) },
        });
        this.byFrame.set(tab.frameId, job);
        const nav = await tab.navigate(candidate.href, { timeout: this.limits.navTimeoutMs });
        if (nav.errorText && !nav.isDownload && !job.terminal) job.terminal = nav.errorText.includes('BLOCKED_BY_CLIENT') ? { state: 'blocked-host', detail: 'blocked by the request gate' } : { state: 'failed', detail: safeText(nav.errorText, 80) };
        if (!nav.errorText && !nav.isDownload && !job.terminal && !job.guid) job.terminal = { state: 'not-a-download', detail: 'the link opened a page instead of downloading' };   /* a page, not a file */
      } else {
        tab = candidate.pageTab;
        job.tab = tab;
        this.byFrame.set(tab.frameId, job);
        if (!(await tab.evalFn(clickPath, candidate.path))) job.terminal = { state: 'failed', detail: 'the element is gone from the page' };
      }
      await this.waitTerminal(job, signal);
      await this.finalize(job, result);
    } catch (error) {
      if (!job.terminal) job.terminal = { state: error.code === 'CANCELLED' ? 'cancelled' : error.code === 'TIMEOUT' ? 'timeout' : 'failed', detail: safeText(error.message, 120) };
      await this.cancelInBrowser(job);
    } finally {
      this.byFrame.delete(tab ? tab.frameId : '');
      if (gate) await gate.stop().catch(() => {});
      if (ownTab && tab) await tab.close();
      if (job.guid) for (const name of [`${job.guid}.crdownload`, job.guid]) fs.rmSync(path.join(this.stageDir, name), { force: true });
    }
    if (result.state === 'failed' && job.terminal) { result.state = job.terminal.state; result.detail = job.terminal.detail || null; }
    result.httpStatus = job.httpStatus;
    result.ms = Date.now() - started;
    return result;
  }

  /* Wait until the job is done one way or another, enforcing the caps while it runs. */
  async waitTerminal(job, signal) {
    const L = this.limits;
    for (;;) {
      if (job.terminal) { if (job.guid && !job.completed) await this.cancelInBrowser(job); return; }
      if (signal && signal.aborted) { job.terminal = { state: 'cancelled' }; await this.cancelInBrowser(job); return; }
      const now = Date.now();
      if (job.completed) return;
      if (job.browserCancelled) { job.terminal = { state: 'browser-cancelled', detail: 'the browser dropped the download' }; return; }
      if (job.guid) {
        const size = currentSize(this.stageDir, job.guid);
        if (size > job.received) { job.received = size; job.lastGrowthAt = now; }
        if (size > L.maxFileBytes) { job.terminal = { state: 'too-large', detail: `stopped at ${size} bytes, cap ${L.maxFileBytes}` }; await this.cancelInBrowser(job); return; }
        if (this.totalBytes + size > L.maxTotalBytes) { job.terminal = { state: 'total-cap', detail: 'the total cap was reached' }; await this.cancelInBrowser(job); return; }
        if (now - job.lastGrowthAt > L.idleMs) { job.terminal = { state: 'stalled', detail: `no data for ${L.idleMs} ms` }; await this.cancelInBrowser(job); return; }
      } else if (now - job.startedAt > L.beginTimeoutMs) {
        job.terminal = { state: 'no-download', detail: 'no download began' }; return;
      }
      if (now - job.startedAt > L.fileTimeoutMs) { job.terminal = { state: 'timeout', detail: 'the time limit for one file passed' }; await this.cancelInBrowser(job); return; }
      await sleep(L.pollMs);
    }
  }

  /* Completed: verify, name, move into place (exclusively: an existing file is never overwritten). */
  async finalize(job, result) {
    if (!job.completed) return;
    const src = job.completed.filePath;
    if (!src || !insideDir(this.stageDir, src)) { job.terminal = { state: 'failed', detail: 'the browser reported a path outside its download folder' }; return; }
    const stat = fs.lstatSync(src);
    if (!stat.isFile()) { job.terminal = { state: 'failed', detail: 'the download is not a regular file' }; return; }
    /* The polling above is fast but not instant: a small file on a fast link can finish between two polls, so the caps are checked on
       the finished file too. */
    if (stat.size > this.limits.maxFileBytes) { job.terminal = { state: 'too-large', detail: `${stat.size} bytes, cap ${this.limits.maxFileBytes}` }; fs.rmSync(src, { force: true }); return; }
    if (this.totalBytes + stat.size > this.limits.maxTotalBytes) { job.terminal = { state: 'total-cap', detail: 'the total cap was reached' }; fs.rmSync(src, { force: true }); return; }
    if (job.totalBytes > 0 && stat.size !== job.totalBytes) { job.terminal = { state: 'size-mismatch', detail: `${stat.size} bytes on disk, ${job.totalBytes} announced` }; fs.rmSync(src, { force: true }); return; }
    const sha = await sha256File(src);
    const picked = pickName(job.suggested, job.candidate, job.contentType || '');
    const name = uniqueName(picked.name, this.taken);
    const dst = path.join(this.destDir, name);
    if (!insideDir(this.destDir, dst)) { job.terminal = { state: 'failed', detail: 'the safe name was not inside the destination' }; return; }
    try { fs.linkSync(src, dst); fs.unlinkSync(src); } catch (e) {
      if (e.code === 'EXDEV') { fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL); fs.unlinkSync(src); } else throw e;
    }
    fs.chmodSync(dst, 0o600);
    this.totalBytes += stat.size;
    Object.assign(result, { state: 'done', name, size: stat.size, sha256: sha });
  }

  async fetchAll(candidates, { signal, onFile } = {}) {
    const results = [];
    for (const candidate of candidates) {
      if (signal && signal.aborted) break;
      const r = await this.fetchOne(candidate, { signal });
      results.push({ ...r, candidate });
      if (onFile) onFile(r, candidate);
    }
    return results;
  }
}

function currentSize(dir, guid) {
  for (const name of [`${guid}.crdownload`, guid]) {
    try { return fs.statSync(path.join(dir, name)).size; } catch (e) { /* next */ }
  }
  return 0;
}

module.exports = { DownloadManager, DEFAULT_LIMITS, pickName, sha256File };
