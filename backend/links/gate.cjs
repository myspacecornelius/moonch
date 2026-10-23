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
   The Fetch domain also hands over the body of a form that is posted, so it is never enabled on the task tab: only on a tab opened for
   one file, never while the person signs in. Exports: gateTab, attachmentHeader. */

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

module.exports = { gateTab, attachmentHeader };
