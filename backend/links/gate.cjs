'use strict';
/* The request gate used for FILE downloads: decide, BEFORE a request leaves the browser, whether a tab may contact a host, and (once the
   response headers are in, before one body byte is read) whether a response may become a file.

   Mechanism: the Fetch domain pauses document requests (a navigation, every redirect hop, an <a download> click) and the loader
   answers each one. Measured facts that shape it:
     - a request failed at the request stage is never sent;
     - at the response stage the loader sees status and headers first: failing there ends the transfer (a 300 MiB response with a
       Content-Length was refused after the server had sent a few MiB of kernel buffer);
     - Fetch.continueResponse can ADD "content-disposition: attachment", so that Chrome's download manager takes a file type it would
       otherwise show in the tab (text, pdf, png, json, html).
   The Fetch domain also hands over the body of a form that is posted, so it is switched on only on a tab opened for one file (gateTab) or,
   for the length of one press, on the task tab (guardWrites, which looks at the method, and at the body of a POST only to tell a data query
   from a change); never while the person signs in. Exports: gateTab, guardWrites, isReadQuery, attachmentHeader. */

const REDIRECT = new Set([301, 302, 303, 307, 308]);

/* Content-Disposition value for a name that may hold any Unicode: an ASCII fallback plus the RFC 5987 form. */
function attachmentHeader(name) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

/* options: isAllowed(url: URL) -> boolean (host and scheme policy at every hop); onBlocked({ host });
           file.onResponse(params, headers) -> { action: 'continue' } | { action: 'fail' } | { action: 'attachment', filename } */
async function gateTab(tab, { isAllowed, onBlocked = () => {}, file }) {
  const s = tab.s;
  const answer = (method, params) => s.send(method, params, { timeout: 10000 }).catch(() => { /* the tab closed or the request ended */ });
  const handler = async (p) => {
    const isResponse = p.responseStatusCode !== undefined || p.responseErrorReason !== undefined;
    if (!isResponse) {
      let url;
      try { url = new URL(p.request.url); } catch (e) { return answer('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }); }
      if (!isAllowed(url)) { onBlocked({ host: url.hostname }); return answer('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }); }
      return answer('Fetch.continueRequest', { requestId: p.requestId });
    }
    if (REDIRECT.has(p.responseStatusCode)) return answer('Fetch.continueRequest', { requestId: p.requestId });
    const headers = {};
    for (const h of p.responseHeaders || []) headers[h.name.toLowerCase()] = h.value;
    let decision;
    try { decision = await file.onResponse(p, headers); } catch (e) { decision = { action: 'fail' }; }
    if (decision.action === 'fail') return answer('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Aborted' });
    if (decision.action === 'attachment') {
      const kept = (p.responseHeaders || []).filter((h) => h.name.toLowerCase() !== 'content-disposition');
      kept.push({ name: 'content-disposition', value: attachmentHeader(decision.filename || 'file') });
      return answer('Fetch.continueResponse', { requestId: p.requestId, responseCode: p.responseStatusCode, responseHeaders: kept });
    }
    return answer('Fetch.continueRequest', { requestId: p.requestId });
  };
  const off = s.on('Fetch.requestPaused', handler);
  await s.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }, { urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }] });
  return { async stop() { off(); await s.send('Fetch.disable').catch(() => {}); } };
}

/* Whether the body of a POST is a data QUERY and not a change: a GraphQL query (JSON {"query": "query ... { ... }"}, one or a batch, or the
   raw text of one) with no "mutation" (or "subscription") anywhere in the body. Single-page apps load their lists with POST queries; a body
   that is anything else (a JSON change, a form, nothing at all) is a write. This is the only place a request body is read: for this
   decision, in memory, never kept or logged. */
function isReadQuery(postData) {
  if (typeof postData !== 'string' || !postData.trim() || postData.length > 200000) return false;
  if (/\b(mutation|subscription)\b/i.test(postData)) return false;
  const reads = (text) => /^\s*(query\b|\{|fragment\b)/.test(String(text).replace(/#[^\n]*/g, ''));
  let parsed;
  try { parsed = JSON.parse(postData); } catch (e) { return reads(postData) && !/^\s*[[{]\s*"/.test(postData); }   /* raw GraphQL text, not JSON */
  const ops = Array.isArray(parsed) ? parsed : [parsed];
  return ops.length > 0 && ops.length <= 50 && ops.every((op) => op && typeof op === 'object' && typeof op.query === 'string' && reads(op.query));
}

/* The text of a request body, from postData or from its entries (Chrome gives the bytes of a small body as base64 entries); undefined when it
   is not plain text in memory (a file, a stream, nothing). */
function bodyOf(request) {
  if (typeof request.postData === 'string') return request.postData;
  const entries = request.postDataEntries;
  if (Array.isArray(entries) && entries.length && entries.every((e) => e && typeof e.bytes === 'string')) return entries.map((e) => Buffer.from(e.bytes, 'base64').toString('utf8')).join('');
  return undefined;
}

/* A guard for the task tab while the loader PRESSES something (a tab, an expander, "Load more", a pager, the "show all files" switch, a
   download control). Pressing runs the page's own script, which can do anything; a request that is not a read (PUT, PATCH, DELETE, a POST
   that is not a data query) is failed before it leaves the browser. GET, HEAD and OPTIONS go on, and so does a POST whose body is a GraphQL
   query (isReadQuery). Guards nest: while one is on, another call joins it (the newest one is told what was stopped), and the browser's
   Fetch domain is switched off when the last one stops. onBlocked({ method }) says what was stopped. */
async function guardWrites(tab, { onBlocked = () => {} } = {}) {
  const s = tab.s;
  if (!s || typeof s.on !== 'function') return { async stop() {} };   /* a test double without a session */
  let shared = tab.writeGuard;
  if (!shared) {
    shared = { listeners: [], users: 0, off: null };
    const answer = (method, params) => s.send(method, params, { timeout: 10000 }).catch(() => { /* the tab closed or the request ended */ });
    const handler = (p) => {
      const request = p.request || {};
      const method = String(request.method || 'GET').toUpperCase();
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return answer('Fetch.continueRequest', { requestId: p.requestId });
      if (method === 'POST' && isReadQuery(bodyOf(request))) return answer('Fetch.continueRequest', { requestId: p.requestId });
      const top = shared.listeners[shared.listeners.length - 1];
      try { if (top) top({ method }); } catch (e) { /* a callback must not leave the request paused */ }
      return answer('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' });
    };
    shared.off = s.on('Fetch.requestPaused', handler);
    tab.writeGuard = shared;
    await s.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  }
  shared.users += 1;
  shared.listeners.push(onBlocked);
  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      const at = shared.listeners.lastIndexOf(onBlocked);
      if (at >= 0) shared.listeners.splice(at, 1);
      shared.users -= 1;
      if (shared.users > 0) return;
      tab.writeGuard = null;
      shared.off();
      await s.send('Fetch.disable').catch(() => {});
    },
  };
}

module.exports = { gateTab, guardWrites, isReadQuery, attachmentHeader };
