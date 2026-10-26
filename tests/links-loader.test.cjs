'use strict';
/* Unit tests for the link loader (backend/links/): everything that needs no browser. The real-Chrome flow is tests/links-browser.cjs.
   Nothing here opens the project's private/ folder; every file is written under a temporary folder. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { Cdp, CdpError, sleep } = require('../backend/links/cdp.cjs');
const { classifyPage } = require('../backend/links/auth-wall.cjs');
const { sanitizeFileName, uniqueName, insideDir, collisionKey } = require('../backend/links/names.cjs');
const chrome = require('../backend/links/chrome.cjs');
const { chromeArgs, browserEnv, findChromeBinary, usableBinary, prepareProfile, scrubProfile } = chrome;
const { gateTab, attachmentHeader } = require('../backend/links/gate.cjs');
const { fileCandidates, droppedCandidates, navigateKey, findAllFilesToggle, findAllFilesState, linkVerdict, nameIsDownload, TOGGLE_LABEL_RE, TOGGLE_NEVER_RE, NEVER_TEXT_RE, NEVER_HREF_RE, NOT_CLEAR } = require('../backend/links/page.cjs');
const discover = require('../backend/links/discover.cjs');
const { validateLink, fileUrlAllowed, hostProblem } = require('../backend/links/url.cjs');
const store = require('../backend/links/store.cjs');
const { Tab, safeUrl, safeText, cleanLabel } = require('../backend/links/tab.cjs');
const { DownloadManager, pickName, bestName, realExt } = require('../backend/links/downloads.cjs');
const { createLinkLoader, LinkError, changedToggle, findAllFilesToggle: exportedFinder, TOGGLE_LABEL_RE: exportedRe } = require('../backend/links/index.cjs');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'links-loader-test-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const fresh = (label) => { counter += 1; const dir = path.join(scratch, `${label}-${counter}`); fs.mkdirSync(dir, { recursive: true }); return dir; };

/* ---------------------------------------------------------------- CDP framing */
function fakeBrowser(options) {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const cdp = new Cdp(toBrowser, fromBrowser, options);
  const received = [];
  let buffer = '';
  toBrowser.on('data', (d) => { buffer += d; let i; while ((i = buffer.indexOf('\0')) >= 0) { received.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1); } });
  const reply = (obj) => fromBrowser.write(`${JSON.stringify(obj)}\0`);
  return { cdp, received, reply, fromBrowser, toBrowser };
}

test('cdp: a command gets its own reply, matched by id', async () => {
  const b = fakeBrowser();
  const p = b.cdp.send('Browser.getVersion');
  await sleep(10);
  assert.equal(b.received[0].method, 'Browser.getVersion');
  b.reply({ id: b.received[0].id, result: { product: 'Chrome/1' } });
  assert.deepEqual(await p, { product: 'Chrome/1' });
});

test('cdp: a protocol error becomes a CdpError with code and method', async () => {
  const b = fakeBrowser();
  const p = b.cdp.send('Nope.nope');
  await sleep(10);
  b.reply({ id: b.received[0].id, error: { code: -32601, message: "'Nope.nope' wasn't found" } });
  await assert.rejects(p, (e) => e instanceof CdpError && e.code === -32601 && e.method === 'Nope.nope');
});

test('cdp: a message split over several chunks, and several messages in one chunk', async () => {
  const b = fakeBrowser();
  const events = [];
  b.cdp.on('Page.loadEventFired', (p) => events.push(p.timestamp));
  const raw = JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 } }) + '\0' + JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 2 } }) + '\0';
  b.fromBrowser.write(raw.slice(0, 20));
  await sleep(5);
  b.fromBrowser.write(raw.slice(20, 70));
  b.fromBrowser.write(raw.slice(70));
  await sleep(20);
  assert.deepEqual(events, [1, 2]);
});

test('cdp: a 3 MB reply is reassembled', async () => {
  const b = fakeBrowser();
  const p = b.cdp.send('Network.getResponseBody');
  await sleep(10);
  const body = 'x'.repeat(3 * 1024 * 1024);
  const wire = Buffer.from(JSON.stringify({ id: b.received[0].id, result: { body } }) + '\0');
  for (let i = 0; i < wire.length; i += 65536) b.fromBrowser.write(wire.subarray(i, i + 65536));
  assert.equal((await p).body.length, body.length);
});

test('cdp: a NUL inside a parameter is escaped, so it can never end a frame early', async () => {
  const b = fakeBrowser();
  b.cdp.send('Runtime.evaluate', { expression: 'a\u0000b' }, { timeout: 100 }).catch(() => {});
  await sleep(10);
  assert.equal(b.received.length, 1);
  assert.equal(b.received[0].params.expression, 'a\u0000b');
});

test('cdp: events carry the session id; session() filters on it and stamps commands', async () => {
  const b = fakeBrowser();
  const one = []; const two = [];
  const s1 = b.cdp.session('S1'); const s2 = b.cdp.session('S2');
  s1.on('Network.requestWillBeSent', (p) => one.push(p.n));
  s2.on('Network.requestWillBeSent', (p) => two.push(p.n));
  b.reply({ method: 'Network.requestWillBeSent', params: { n: 1 }, sessionId: 'S1' });
  b.reply({ method: 'Network.requestWillBeSent', params: { n: 2 }, sessionId: 'S2' });
  await sleep(10);
  assert.deepEqual([one, two], [[1], [2]]);
  const sent = s1.send('Page.enable');
  await sleep(10);
  assert.equal(b.received[0].sessionId, 'S1');
  b.reply({ id: b.received[0].id, result: {} });
  await sent;
});

test('cdp: waitFor resolves on a matching event and times out otherwise', async () => {
  const b = fakeBrowser();
  const w = b.cdp.waitFor('Page.lifecycleEvent', { filter: (p) => p.name === 'load', timeout: 500 });
  b.reply({ method: 'Page.lifecycleEvent', params: { name: 'init' } });
  b.reply({ method: 'Page.lifecycleEvent', params: { name: 'load' } });
  assert.equal((await w).name, 'load');
  await assert.rejects(b.cdp.waitFor('Never.happens', { timeout: 50 }), (e) => e.code === 'TIMEOUT');
});

test('cdp: a command that is never answered times out', async () => {
  const b = fakeBrowser();
  await assert.rejects(b.cdp.send('Slow.slow', {}, { timeout: 50 }), (e) => e.code === 'TIMEOUT' && e.method === 'Slow.slow');
});

test('cdp: closing the pipe rejects what is pending and everything after', async () => {
  const b = fakeBrowser();
  const closed = new Promise((resolve) => b.cdp.once('closed', resolve));
  const p = b.cdp.send('Browser.getVersion');
  b.fromBrowser.end();
  await assert.rejects(p, (e) => e.code === 'PIPE_CLOSED');
  await closed;
  await assert.rejects(b.cdp.send('Browser.getVersion'), (e) => e.code === 'PIPE_CLOSED');
});

test('cdp: a crashed tab fails its pending commands at once and refuses new ones; other tabs are unaffected', async () => {
  const b = fakeBrowser();
  const pending = b.cdp.send('Runtime.evaluate', {}, { sessionId: 'S9', timeout: 5000 });
  await sleep(10);
  b.reply({ method: 'Inspector.targetCrashed', params: {}, sessionId: 'S9' });
  await assert.rejects(pending, (e) => e.code === 'TARGET_CRASHED');
  const t0 = Date.now();
  await assert.rejects(b.cdp.send('Runtime.evaluate', {}, { sessionId: 'S9', timeout: 5000 }), (e) => e.code === 'TARGET_CRASHED');
  assert.ok(Date.now() - t0 < 100);
  await b.cdp.send('Browser.getVersion', {}, { timeout: 30 }).catch((e) => assert.equal(e.code, 'TIMEOUT'));
});

test('cdp: a message that never ends is cut off at the size limit', async () => {
  const b = fakeBrowser({ maxMessageBytes: 1024 });
  const closed = new Promise((resolve) => b.cdp.once('closed', resolve));
  b.fromBrowser.write('x'.repeat(2048));
  assert.equal((await closed).code, 'OVERSIZE');
});

/* ---------------------------------------------------------------- the tab keeps fixed shapes, evaluates constant code */
function fakeTab() {
  const b = fakeBrowser();
  const tab = new Tab(b.cdp, 'T1', 'S1');
  return { ...b, tab };
}

test('tab: no raw network event is kept (no Cookie, Authorization, post body, response header); redirect hops and the main status are', async () => {
  const f = fakeTab();
  f.reply({ method: 'Network.requestWillBeSent', sessionId: 'S1', params: { requestId: 'r1', frameId: 'T1', type: 'Document', request: { url: 'https://tasks.atlas.example/t/1?X-Signature=CANARY', method: 'POST', headers: { Cookie: 'sid=CANARYCOOKIE', Authorization: 'Bearer CANARYBEARER' }, postData: 'password=CANARYPASSWORD' } } });
  f.reply({ method: 'Network.requestWillBeSentExtraInfo', sessionId: 'S1', params: { requestId: 'r1', associatedCookies: [{ cookie: { name: 'sid', value: 'CANARYCOOKIE' } }], headers: { cookie: 'sid=CANARYCOOKIE' } } });
  f.reply({ method: 'Network.responseReceived', sessionId: 'S1', params: { requestId: 'r1', frameId: 'T1', type: 'Document', response: { url: 'https://tasks.atlas.example/t/1', status: 302, headers: { 'Set-Cookie': 'sid=CANARYSET' } } } });
  f.reply({ method: 'Network.requestWillBeSent', sessionId: 'S1', params: { requestId: 'r2', frameId: 'T1', type: 'XHR', request: { url: 'https://tasks.atlas.example/api', method: 'GET', headers: { Cookie: 'sid=CANARYCOOKIE' } } } });
  f.reply({ method: 'Network.responseReceived', sessionId: 'S1', params: { requestId: 'r2', frameId: 'T1', type: 'XHR', response: { url: 'https://tasks.atlas.example/api', status: 401, headers: {} } } });
  await sleep(20);
  const kept = JSON.stringify(f.tab.net, (key, value) => (value instanceof Map ? [...value] : value));
  for (const secret of ['CANARYCOOKIE', 'CANARYBEARER', 'CANARYPASSWORD', 'CANARYSET', 'Authorization', 'postData']) assert.ok(!kept.includes(secret), secret);
  assert.deepEqual(f.tab.net.hops.map((h) => h.status), [302]);
  assert.deepEqual(f.tab.net.mainResponse, { status: 302 });
  assert.deepEqual(f.tab.net.apiErrors, [{ status: 401 }]);
});

test('tab: pauseNetwork sends Network.disable and forgets requests in flight; enableNetwork restores the cache and service worker switches', async () => {
  const f = fakeTab();
  f.tab.net.inflight.set('r', { type: 'XHR', startedAt: 0 });
  const done = f.tab.pauseNetwork();
  await sleep(10);
  assert.equal(f.received[0].method, 'Network.disable');
  f.reply({ id: f.received[0].id, result: {} });
  await done;
  assert.equal(f.tab.net.inflight.size, 0);
  const enabled = f.tab.enableNetwork();
  await sleep(10);
  assert.deepEqual(f.received.slice(1).map((m) => m.method), ['Network.enable', 'Network.setCacheDisabled', 'Network.setBypassServiceWorker']);
  for (const m of f.received.slice(1)) f.reply({ id: m.id, result: {} });
  await enabled;
  assert.ok(!f.received.some((m) => m.method === 'Runtime.enable'));
});

test('tab: evalFn passes its argument as JSON, so no text from a page, a link or a person can become code', () => {
  const calls = [];
  const fake = { evalIsolated: (expression) => { calls.push(expression); return expression; } };
  const hostile = '"); process.exit(1); ("\u2028\\\'`${x}</script>';
  const expression = Tab.prototype.evalFn.call(fake, (arg) => arg, { selector: hostile });
  assert.equal(JSON.stringify(vm.runInNewContext(expression, {})), JSON.stringify({ selector: hostile }), 'the argument arrives unchanged and is not executed');
  assert.equal(vm.runInNewContext(Tab.prototype.evalFn.call(fake, (arg) => arg === null, undefined), {}), true, 'an absent argument is null');
});

test('urls: safeUrl keeps origin and path, drops the query and fragment; safeText cuts every URL inside a message', () => {
  assert.equal(safeUrl('https://files.example/blob/a.docx?X-Signature=SECRET&X-Expires=1#frag'), 'https://files.example/blob/a.docx?\u2026');
  assert.equal(safeUrl('https://x.example/a'), 'https://x.example/a');
  assert.equal(safeUrl('not a url'), '(unreadable url)');
  assert.equal(safeUrl('file:///etc/passwd'), 'file:\u2026');
  assert.ok(safeUrl(`https://x.example/${'a'.repeat(200)}`).length < 130);
  const text = safeText('net::ERR_FAILED loading https://files.example/blob/a.docx?X-Signature=SECRET#frag and http://127.0.0.1:9/x?token=abc\nnext');
  assert.ok(!/SECRET|abc|frag|\n/.test(text), text);
  assert.ok(text.includes('https://files.example/blob/a.docx'));
  assert.equal(safeText(null), '');
  assert.ok(safeText('x'.repeat(1000), 50).length === 50);
});

/* ---------------------------------------------------------------- sign-in classifier */
const snap = (o = {}) => ({
  url: o.url || 'https://tasks.atlas.example/t/1', title: o.title || 'Atlas task', headings: o.headings || [{ level: 1, text: 'Atlas task' }], controlCount: o.controlCount ?? 0,
  linkCount: o.linkCount ?? 3, sections: o.sections || [{ heading: 'Atlas task', text: 'x'.repeat(500) }],
  signals: { hasPasswordField: false, hasOtpField: false, hasCaptcha: false, bodyTextChars: 500, ...(o.signals || {}) },
});
const base = { requestedUrl: 'https://tasks.atlas.example/t/1', finalUrl: 'https://tasks.atlas.example/t/1', hops: [{ rawUrl: 'https://tasks.atlas.example/t/1', status: 200 }], mainResponse: { status: 200 }, api: [], navError: null };

test('classify: an ordinary page is ready', () => {
  assert.equal(classifyPage({ ...base, snapshot: snap() }).state, 'ready');
});
test('classify: 302 to /login with a return parameter and a password field is a sign-in wall', () => {
  const r = classifyPage({ ...base, finalUrl: 'https://tasks.atlas.example/login?next=%2Ft%2F1', hops: [{ rawUrl: 'https://tasks.atlas.example/t/1', status: 302 }, { rawUrl: 'https://tasks.atlas.example/login?next=%2Ft%2F1', status: 200 }], snapshot: snap({ url: 'https://tasks.atlas.example/login?next=%2Ft%2F1', title: 'Sign in', headings: [{ level: 1, text: 'Sign in' }], signals: { hasPasswordField: true }, controlCount: 2, linkCount: 0 }) });
  assert.equal(r.state, 'needs-sign-in');
  assert.ok(['redirect-to-login-path', 'login-path', 'return-param', 'password-field', 'login-words'].every((s) => r.signals.includes(s)), r.signals.join());
});
test('classify: the sign-in form in place of the page (same URL, 200) is a wall too', () => {
  const r = classifyPage({ ...base, snapshot: snap({ title: 'Sign in', headings: [{ level: 1, text: 'Sign in' }], signals: { hasPasswordField: true }, controlCount: 2 }) });
  assert.equal(r.state, 'needs-sign-in');
  assert.ok(!r.signals.includes('url-changed'));
});
test('classify: a redirect chain through an identity provider that comes back to the page is NOT a wall', () => {
  const r = classifyPage({ ...base, hops: [{ rawUrl: 'https://tasks.atlas.example/t/1', status: 302 }, { rawUrl: 'https://login.meridian.example/idp/login?x=1', status: 302 }, { rawUrl: 'https://tasks.atlas.example/sso/callback?code=1', status: 302 }, { rawUrl: 'https://tasks.atlas.example/t/1', status: 200 }], snapshot: snap() });
  assert.equal(r.state, 'ready');
  assert.ok(r.signals.includes('passed-through-login'));
});
test('classify: the identity provider page itself is a wall, and the other host is in the signals', () => {
  const r = classifyPage({ ...base, finalUrl: 'https://login.meridian.example/idp/login?return=x', hops: [{ rawUrl: 'https://tasks.atlas.example/t/1', status: 302 }, { rawUrl: 'https://login.meridian.example/idp/login?return=x', status: 200 }], snapshot: snap({ url: 'https://login.meridian.example/idp/login?return=x', title: 'Sign in', headings: [], signals: { hasPasswordField: true }, controlCount: 2 }) });
  assert.equal(r.state, 'needs-sign-in');
  assert.ok(r.signals.includes('redirect-to-other-host') && r.signals.includes('login-host'));
});
test('classify: a page whose data calls answer 401 is a wall even without a password field', () => {
  const r = classifyPage({ ...base, api: [{ status: 401 }], snapshot: snap({ sections: [{ heading: '', text: 'Loading' }], signals: { bodyTextChars: 7 }, headings: [], linkCount: 0 }) });
  assert.equal(r.state, 'needs-sign-in');
});
test('classify: a CAPTCHA, a code field or a browser check is a wall the person must pass (needs-person)', () => {
  assert.equal(classifyPage({ ...base, snapshot: snap({ title: 'Just a moment...', sections: [{ heading: '', text: 'Verify you are human' }], signals: { hasCaptcha: true } }) }).state, 'needs-person');
  assert.equal(classifyPage({ ...base, snapshot: snap({ signals: { hasOtpField: true } }) }).state, 'needs-person');
  assert.equal(classifyPage({ ...base, snapshot: snap({ sections: [{ heading: 'Security', text: 'Enter the verification code from your authenticator app' }] }) }).state, 'needs-person');
});
test('classify: words like "verification code" are weak evidence once the person has said they finished; a CAPTCHA element or a code field still count', () => {
  const words = snap({ sections: [{ heading: 'Notes', text: 'Send the verification code to the client, then reconcile.' }] });
  assert.equal(classifyPage({ ...base, snapshot: words }).state, 'needs-person');
  assert.equal(classifyPage({ ...base, snapshot: words, ignoreChallengeWords: true }).state, 'ready');
  assert.equal(classifyPage({ ...base, snapshot: snap({ signals: { hasCaptcha: true } }), ignoreChallengeWords: true }).state, 'needs-person');
  assert.equal(classifyPage({ ...base, snapshot: snap({ signals: { hasOtpField: true } }), ignoreChallengeWords: true }).state, 'needs-person');
});
test('classify: 404 is not-found, 403 is forbidden, 500 is an error, a failed navigation is an error', () => {
  assert.equal(classifyPage({ ...base, mainResponse: { status: 404 }, snapshot: snap() }).state, 'not-found');
  assert.match(classifyPage({ ...base, mainResponse: { status: 404 }, snapshot: snap() }).reason, /404/);
  assert.equal(classifyPage({ ...base, mainResponse: { status: 403 }, snapshot: snap() }).state, 'forbidden');
  assert.equal(classifyPage({ ...base, mainResponse: { status: 503 }, snapshot: snap() }).state, 'error');
  const r = classifyPage({ ...base, finalUrl: null, snapshot: null, navError: 'net::ERR_NAME_NOT_RESOLVED' });
  assert.equal(r.state, 'error');
  assert.match(r.reason, /ERR_NAME_NOT_RESOLVED/);
});
test('classify: a settings page with a "change password" field and real content is not a wall', () => {
  assert.equal(classifyPage({ ...base, snapshot: snap({ controlCount: 9, signals: { hasPasswordField: true } }) }).state, 'ready');
});

/* ---------------------------------------------------------------- file names */
test('names: path pieces, device names, control and bidi characters, dots, empty, length', () => {
  const cases = [
    ['../../../tmp/pwned.txt', 'pwned.txt'], ['..\\..\\windows\\evil.txt', 'evil.txt'], ['/etc/cron.d/x', 'x'], ['CON.txt', '_CON.txt'], ['nul', '_nul'], ['COM1.log', '_COM1.log'],
    ['.hidden', 'hidden'], ['  spaced name .  ', 'spaced name'], ['....', 'file'], ['', 'file'], ['a\u0000b.txt', 'a_b.txt'], ['report\u202egpj.exe', 'report_gpj.exe'], ['a:b*c?.csv', 'a_b_c_.csv'],
    ['<img src=x onerror=alert(1)>.txt', '_img src=x onerror=alert(1)_.txt'],
  ];
  for (const [raw, want] of cases) assert.equal(sanitizeFileName(raw).name, want, JSON.stringify(raw));
  const long = sanitizeFileName(`${'x'.repeat(300)}.csv`).name;
  assert.ok(Buffer.byteLength(long) <= 120 && long.endsWith('.csv'));
  assert.ok(Buffer.byteLength(sanitizeFileName('\u65e5'.repeat(100) + '.xlsx').name) <= 120);
  assert.equal(sanitizeFileName(sanitizeFileName('..\\x/y z.txt').name).name, 'y z.txt', 'idempotent');
  assert.deepEqual(sanitizeFileName('a/b').reasons, ['path']);
});
test('names: unique names compare case-insensitively and keep the extension', () => {
  const taken = new Set();
  assert.deepEqual(['report.xlsx', 'report.xlsx', 'REPORT.XLSX', 'Report.xlsx'].map((n) => uniqueName(n, taken)), ['report.xlsx', 'report (2).xlsx', 'REPORT (3).XLSX', 'Report (4).xlsx']);
  assert.equal(collisionKey('Caf\u00e9'), collisionKey('Cafe\u0301'));
});
test('names: insideDir accepts one level only', () => {
  assert.ok(insideDir('/a/b', '/a/b/c.txt'));
  assert.ok(!insideDir('/a/b', '/a/b/c/d.txt') && !insideDir('/a/b', '/a/c.txt') && !insideDir('/a/b', '/a/b/../c.txt') && !insideDir('/a/b', '/a/b'));
});
test('names: Chrome\'s placeholder "download" is replaced by the page\'s name, and a missing extension is added from the type', () => {
  assert.equal(pickName('download', { nameHint: 'Q3 Bridge.xlsx' }, 'application/octet-stream').name, 'Q3 Bridge.xlsx');
  assert.equal(pickName('Atlas_Prompt', { nameHint: '' }, 'application/pdf').name, 'Atlas_Prompt.pdf');
  assert.equal(pickName('x.bin', { nameHint: 'whatever.pdf' }, 'application/pdf').name, 'x.bin');
  assert.equal(pickName('', { nameHint: '' }, 'application/zip').name, 'download.zip');
  assert.equal(pickName('../../etc/passwd', { nameHint: '' }, '').name, 'passwd');
  assert.equal(pickName('download', { nameHint: 'download', label: 'Variance_Bridge.xlsx', text: 'Variance_Bridge.xlsx' }, 'application/octet-stream').name, 'Variance_Bridge.xlsx', 'an opaque tail of the address: the link text has the real name');
  assert.equal(pickName('download', { nameHint: 'download', label: 'Grader Guideline.pdf' }, 'application/pdf').name, 'Grader Guideline.pdf', 'not download.pdf');
  assert.equal(pickName('21', { nameHint: '21', label: 'Atlas_Rows.csv 1 KB', text: 'Download' }, 'text/csv').name, '21.csv', 'no name with an extension anywhere: the content type is the last resort');
  assert.equal(pickName('', { nameHint: 'download', label: 'Row 3', text: 'Board_Memo.docx' }, 'application/octet-stream').name, 'Board_Memo.docx', 'the text counts too');
  assert.equal(pickName('download.zip', { nameHint: 'download', label: 'Archive_Pack.zip', text: 'Archive_Pack.zip' }, 'application/zip').name, 'Archive_Pack.zip', 'the extension Chrome added from the content type does not make "download" a name');
  assert.equal(pickName('download (2).pdf', { nameHint: 'x', label: 'Board Memo.pdf' }, 'application/pdf').name, 'Board Memo.pdf');
  assert.equal(pickName('download.pdf', { nameHint: 'download', label: 'Row 3', text: 'Download' }, 'application/pdf').name, 'Row 3.pdf', 'the page\'s name without an extension, plus the extension Chrome chose');
  assert.equal(pickName('download.pdf', { nameHint: 'download', text: 'Download' }, 'application/pdf').name, 'download.pdf', 'no better name on the page: it stays');
  assert.equal(pickName('download.xlsx', { nameHint: 'download', label: 'Q3 Variance Bridge', text: 'Q3 Variance Bridge' }, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').name, 'Q3 Variance Bridge.xlsx', 'a name with no extension on a type the browser does not show inline');
  assert.equal(pickName('download (2).xlsx', { nameHint: 'download', label: 'Board Memo Final', text: 'Board Memo Final' }, 'application/octet-stream').name, 'Board Memo Final.xlsx', 'Chrome\'s numbered placeholder is a placeholder too');
  assert.equal(pickName('', { nameHint: 'download', label: 'Sales Ledger', text: 'Sales Ledger' }, 'text/csv').name, 'Sales Ledger.csv', 'no name from the server: the content type gives the extension');
  assert.equal(pickName('Report.pdf', { nameHint: 'Other.pdf', label: 'Other.pdf' }, 'application/pdf').name, 'Report.pdf', 'a real name from the server wins');
  assert.equal(pickName('downloads.zip', { nameHint: 'Other.zip' }, 'application/zip').name, 'downloads.zip', '"downloads" is a name');
  assert.equal(bestName({ nameHint: 'download', label: 'Q3.pdf', text: 'Download' }), 'Q3.pdf');
  assert.equal(bestName({ nameHint: 'doc42', label: 'no extension', text: 'x' }), 'doc42');
  assert.equal(bestName({ nameHint: 'download', label: 'Policy 3.2', text: 'Policy 3.2' }, 'application/pdf'), 'Policy 3.2', 'no real extension anywhere: the first name that is not just "download"');
  assert.equal(bestName({ nameHint: 'Download', rowParts: ['Variance Bridge'], label: 'Variance Bridge updated 1 min ago', text: 'Download' }), 'Variance Bridge', 'the stable part of a row, not its time stamp');
  assert.equal(pickName('download.pdf', { nameHint: 'download', label: 'Policy 3.2', text: 'Policy 3.2' }, 'application/pdf').name, 'Policy 3.2.pdf', '"3.2" and "v2.1" are not extensions: the extension Chrome chose is added');
  assert.equal(pickName('download', { nameHint: 'download', label: 'Budget v2.1', text: 'Budget v2.1' }, 'application/pdf').name, 'Budget v2.1.pdf');
  assert.equal(pickName('download.pdf', { nameHint: 'download', label: 'Q3 Bridge.pdf', text: 'Q3 Bridge.pdf' }, 'application/pdf').name, 'Q3 Bridge.pdf');
  assert.equal(realExt('Policy 3.2', 'application/pdf'), false);
  assert.equal(realExt('Report.pdf', ''), true);
  assert.equal(realExt('Report.weird', 'application/x-weird'), false);
  assert.equal(bestName({}), '');
});

/* ---------------------------------------------------------------- links */
test('validateLink: https only, a DNS name, no user info, no hidden characters, no numbers as a host, no internal names', () => {
  const good = validateLink('  https://Tasks.Atlas.example/t/1?ref=abc#top \n');
  assert.equal(good.ok, true);
  assert.deepEqual([good.origin, good.host, good.path], ['https://tasks.atlas.example', 'tasks.atlas.example', '/t/1']);
  assert.equal(good.href, 'https://tasks.atlas.example/t/1?ref=abc#top');
  const refusals = [
    [null, 'type'], ['', 'empty'], ['   ', 'empty'], ['http://tasks.atlas.example/t', 'scheme'], ['ftp://tasks.atlas.example/t', 'scheme'], ['javascript:alert(1)', 'scheme'], ['//tasks.atlas.example/t', 'scheme'],
    ['file:///etc/passwd', 'scheme'], ['data:text/html,x', 'scheme'], ['https:tasks.atlas.example', 'scheme'], ['https://', 'no-host'], ['https:///tasks.atlas.example/t', 'no-host'],
    ['https://trusted.example@evil.example/x', 'userinfo'], ['https://:@tasks.atlas.example/', 'userinfo'], ['https://u:p@tasks.atlas.example/', 'userinfo'], ['https://tasks.atlas.example\\@evil.example/', 'backslash'],
    ['https://tasks.atlas.example%2f@evil.example/', 'userinfo'], ['https://ex%61mple.com/', 'encoded-host'], ['https://tru\tsted.example/', 'control'], ['https://tasks.atlas.example/\u202e', 'control'],
    ['https://tasks.atlas.example/a b', 'space'], ['https://127.0.0.1/t', 'reserved-name'], ['https://2130706433/t', 'reserved-name'], ['https://0x7f.1/t', 'reserved-name'], ['https://127.1/t', 'reserved-name'], ['https://0/t', 'ip-literal'], ['https://192.168.0.1/t', 'ip-literal'], ['https://0300.0250.0.1/t', 'ip-literal'],
    ['https://[::1]/t', 'ip-literal'], ['https://[fe80::1]/t', 'ip-literal'], ['https://169.254.169.254/latest', 'ip-literal'], ['https://10.1.2.3/t', 'ip-literal'],
    ['https://localhost/t', 'reserved-name'], ['https://localhost./t', 'reserved-name'], ['https://app.localhost/t', 'reserved-name'], ['https://printer.local/t', 'reserved-name'], ['https://db.internal/t', 'reserved-name'],
    ['https://wiki.corp/t', 'reserved-name'], ['https://intranet/t', 'single-label'], ['https://a..b.example/t', 'host-labels'], ['https://-atlas.example/t', 'host-labels'], ['https://under_score.example/t', 'host-chars'],
    ['https://atlas.example:80/t', 'port'], ['https://atlas.example:22/t', 'port'], ['https://atlas.example:0/t', 'port'], [`https://tasks.atlas.example/${'a'.repeat(2100)}`, 'too-long'], [`https://tasks.atlas.example/${'a'.repeat(1100)}`, 'path-too-long'],
  ];
  for (const [raw, code] of refusals) {
    const r = validateLink(raw);
    assert.equal(r.ok, false, String(raw).slice(0, 60));
    assert.equal(r.code, code, `${String(raw).slice(0, 60)} gave ${r.code}`);
    assert.ok(typeof r.message === 'string' && r.message.length > 5);
    if (typeof raw === 'string' && raw.length > 12) assert.ok(!r.message.includes(raw.trim().slice(8, 30)) || raw.trim().slice(8, 30).includes(' '), 'the message never repeats the pasted text');
  }
  assert.equal(validateLink('https://tasks.atlas.example:443/t').ok, true);
  assert.equal(validateLink('https://tasks.atlas.example:8443/t').ok, true);
  assert.equal(validateLink('https://\u4f8b\u3048.example/t').ok, true, 'an internationalised host is accepted (the parser turns it into punycode)');
});
test('validateLink: loopback and plain http only when the loader was built for tests', () => {
  assert.equal(validateLink('http://127.0.0.1:8123/t').code, 'reserved-name');
  assert.equal(validateLink('http://127.0.0.1:8123/t', { allowLoopback: true }).ok, true);
  assert.equal(validateLink('http://localhost:8123/t', { allowLoopback: true }).ok, true);
  assert.equal(validateLink('https://localhost:8123/t', { allowLoopback: true }).ok, true);
  assert.equal(validateLink('http://127.0.0.2:8123/t', { allowLoopback: true }).code, 'ip-literal', 'only 127.0.0.1 and localhost');
  assert.equal(validateLink('http://10.0.0.5/t', { allowLoopback: true }).code, 'ip-literal');
  assert.equal(validateLink('http://tasks.atlas.example/t', { allowLoopback: true }).code, 'scheme', 'plain http never reaches a real name');
});
test('fileUrlAllowed: https to a public name, the task host itself, never numbers, user info, other schemes or very long addresses', () => {
  const page = new URL('https://tasks.atlas.example/t/1');
  const ok = (u, o) => fileUrlAllowed(new URL(u), page, o);
  assert.ok(ok('https://tasks.atlas.example/files/a.pdf'));
  assert.ok(ok('https://files.borealis-cdn.example/blob/a.pdf?X-Signature=s'));
  for (const bad of ['http://files.borealis-cdn.example/a.pdf', 'https://127.0.0.2/a.pdf', 'https://10.0.0.5/a.pdf', 'https://[::1]/a.pdf', 'https://u:p@files.borealis-cdn.example/a.pdf', 'file:///etc/passwd', 'ftp://files.borealis-cdn.example/a.pdf', 'blob:https://tasks.atlas.example/uuid', 'https://printer.local/a.pdf', `https://files.borealis-cdn.example/${'a'.repeat(9000)}`]) assert.equal(ok(bad), false, bad.slice(0, 50));
  const local = new URL('http://127.0.0.1:8123/t');
  assert.ok(fileUrlAllowed(new URL('http://127.0.0.1:8123/f/a'), local, { allowLoopback: true }));
  assert.ok(fileUrlAllowed(new URL('http://localhost:9000/f/a'), local, { allowLoopback: true }));
  assert.equal(fileUrlAllowed(new URL('http://127.0.0.2:9000/f/a'), local, { allowLoopback: true }), false);
  assert.equal(fileUrlAllowed(new URL('http://localhost:9000/f/a'), local, {}), false, 'without the test option loopback is not a file host');
  assert.equal(hostProblem('files.borealis-cdn.example'), null);
});

/* ---------------------------------------------------------------- the show-all-files switch */
test('toggle label: show or view, with all or world, and files, attachments or documents (or exactly "All files"); no action word; and nothing else', () => {
  for (const yes of ['Show all files', 'show ALL files', 'All files', 'Show all attachments', 'View all documents', 'Show all\nfiles', 'View all files', 'Show world files', 'Show all 12 files', 'View every attachment', 'Show all downloads']) assert.ok(TOGGLE_LABEL_RE.test(yes) && !TOGGLE_NEVER_RE.test(yes), yes);
  for (const no of ['Advanced view', 'Dark mode', 'Notify me', 'Show all', 'Include all', 'Showall', 'All', 'Callfiles', 'overall filesystem usage?', 'Download', 'Show details', 'Show only added files', 'Show only task files', 'Remember me', '', 'worldfiles', 'Include archived',
    'Notify me about new files', 'Include all files', 'Display all files', 'World files', 'all downloads', 'Show the files', 'Show attachments', 'All files and folders', 'Include all attachments in my daily digest email']) assert.ok(!TOGGLE_LABEL_RE.test(no), no);
  assert.ok(TOGGLE_LABEL_RE.test('x'.repeat(100000) + ' show all files') && !TOGGLE_LABEL_RE.test('show all '.repeat(20000)), 'no catastrophic backtracking');
  /* a label with an action word is never the control, whatever else it says */
  for (const never of ['Clear all files', 'Delete all files', 'Remove all files', 'Reset all files', 'Archive all files', 'Archived: show all files', 'Move all files', 'Apply to all files', 'Bulk: show all files', 'Select all files', 'Discard all files', 'Detach all files', 'Unlink all files', 'Trash all files', 'Empty all files', 'Show all files in my daily digest email', 'Share all files', 'Send all files', 'Mark all files as reviewed',
    'Can view all files', 'Client access: view all files', 'Guest can see all files', 'Show all files to external users', 'Make all files public', 'Show all files publicly', 'Edit: show all files', 'Role: show all files', 'Show all files by default', 'Always show all files', 'Visible to all: files', 'Visibility: all files', 'Permission to view all files']) assert.ok(TOGGLE_NEVER_RE.test(never), never);
  assert.equal(exportedRe, TOGGLE_LABEL_RE);
  assert.equal(exportedFinder, findAllFilesToggle);
});
test('findAllFilesToggle: an unchecked, enabled control of the right kind whose label matches and names no action; the learned label first; checked and disabled ones never', () => {
  const t = (label, checked = false, extra = {}) => ({ label, checked, disabled: false, path: `#${label}`, kind: 'switch', ...extra });
  assert.equal(findAllFilesToggle([t('Dark mode', true), t('Notify me'), t('Show all files')], null).label, 'Show all files');
  assert.equal(findAllFilesToggle([t('Show all files', true)], null), null, 'already on: nothing to switch');
  assert.equal(findAllFilesToggle([t('Show all files', false, { disabled: true })], null), null);
  assert.equal(findAllFilesToggle([t('Advanced view'), t('Show all files')], 'advanced view').label, 'Advanced view', 'learned label wins, trimmed and case-insensitive');
  assert.equal(findAllFilesToggle([t('Advanced view')], null), null);
  assert.equal(findAllFilesToggle([t('Show all files')], 'Gone from the page').label, 'Show all files', 'a learned label that is no longer there falls back to the words');
  assert.equal(findAllFilesToggle([t('Advanced view', true), t('Show all files')], 'Advanced view').label, 'Show all files', 'a learned switch that is already on is not clicked again');
  assert.equal(findAllFilesToggle([t('Include all files'), t('Show all files')], null).label, 'Show all files', '"include" is not "show": only the words show or view count');
  assert.equal(findAllFilesToggle([t('View all files'), t('Show all files')], null).label, 'View all files', 'first match in page order');
  assert.equal(findAllFilesToggle([], null), null);
  assert.equal(findAllFilesToggle(null, null), null);
  assert.equal(findAllFilesToggle([null, { label: 5 }, t('Show world files')], '').label, 'Show world files');
  /* round 5: a label that names an action is never taken, learned or not; neither is a control of another kind */
  assert.equal(findAllFilesToggle([t('Clear all files', false, { kind: 'button' }), t('Delete all files'), t('Mark all files as reviewed', false, { kind: 'option' })], null), null, 'clear, delete and mark are actions');
  assert.equal(findAllFilesToggle([t('Include all attachments in my daily digest email', false, { kind: 'checkbox' }), t('Show all files')], null).label, 'Show all files', 'a settings switch that comes first is not the control');
  assert.equal(findAllFilesToggle([t('Clear all files')], 'Clear all files'), null, 'a learned label that names an action is not used either');
  assert.equal(findAllFilesToggle([t('Show all attachments and mark them reviewed', false, { kind: 'checkbox' }), t('View all files and delete the rest', false, { kind: 'button' }), t('Show all files - archive after viewing')], null), null, 'the words of the real control plus an action word: the action word wins');
  assert.equal(findAllFilesToggle([t('Delete everything', false, { key: 'id:del' })], { key: 'id:del', label: '' }), null);
  assert.equal(findAllFilesToggle([t('Everything', false, { key: 'id:ev', kind: 'checkbox' })], { key: 'id:ev', label: 'Everything' }).label, 'Everything', 'what the person taught stays usable when it names no action');
  assert.equal(findAllFilesToggle([t('Show all files', false, { kind: 'link' })], null), null, 'only a switch, checkbox, radio, tab, pressed button, choice or plain button');
  for (const kind of ['switch', 'checkbox', 'radio', 'tab', 'pressed', 'option', 'button']) assert.equal(findAllFilesToggle([t('Show all files', false, { kind })], null).kind, kind, kind);
  assert.deepEqual(findAllFilesState([t('Clear all files', true)], null), null, 'a "clear" switch that is on is not the control either');
  assert.equal(findAllFilesState([t('Show all files', true)], null).on, true);
});
test('changedToggle: the switch that went from off to on, found by its path', () => {
  const t = (label, checked, path) => ({ label, checked, path });
  const before = [t('Dark mode', true, 'a'), t('Advanced view', false, 'b'), t('Notify me', false, 'c')];
  assert.equal(changedToggle(before, [t('Dark mode', true, 'a'), t('Advanced view', true, 'b'), t('Notify me', false, 'c')]).label, 'Advanced view');
  assert.equal(changedToggle(before, [t('Dark mode', false, 'a'), t('Advanced view', false, 'b'), t('Notify me', false, 'c')]), null, 'on to off is not it');
  assert.equal(changedToggle(before, before), null);
  assert.equal(changedToggle([t('', false, null)], [t('', true, null)]).checked, true, 'no path: matched by position and label');
});

/* ---------------------------------------------------------------- file candidates */
test('candidates: files, not actions; Archive_2026.zip stays, "Delete file" and /logout go; buttons that would submit go; the group, label, kind, rule and view come along', () => {
  const link = (text, href, extra = {}) => ({ text, names: [text], href, rawHref: href, scheme: 'https:', fileLike: true, why: ['extension'], nameHint: text, ext: 'zip', path: 'a', download: null, group: 'Task files', ...extra });
  const btn = (text, label, extra = {}) => ({ text, names: [text], label, fileLike: true, disabled: false, inForm: false, scripted: false, dataUrl: null, ext: null, path: 'b', group: 'Task files', ...extra });
  const s = {
    url: 'https://x.example/t', view: { tab: null, more: 1, scroll: 2 },
    links: [link('Archive_2026.zip', 'https://x.example/f/Archive_2026.zip'), link('Delete file', 'https://x.example/f/1/delete', { why: ['path'], ext: null }), link('Sign out', 'https://x.example/logout', { why: ['path'], ext: null }), link('Approved_Budget.xlsx', 'https://x.example/f/b.xlsx', { group: 'World files' }), link('same', 'https://x.example/f/b.xlsx'),
      link('Odd', 'javascript:alert(1)', { scheme: 'javascript:' }), link('Plain page', 'https://x.example/about', { fileLike: false })],
    buttons: [btn('Download', 'Notes.txt', { dataUrl: '/f/n.txt', ext: null, path: 'button' }), btn('Download all', 'Download all', { inForm: true, path: 'b2' }), btn('Remove Notes.txt', 'Remove Notes.txt', { ext: 'txt', path: 'b3' }), btn('Gone.txt', 'Gone.txt', { disabled: true, path: 'b4' }),
      btn('Notes.txt', 'Notes.txt', { ext: 'txt', path: 'b5' }), btn('Download', 'Q4.csv', { inForm: true, path: 'b6' }), btn('Download Q5.csv', 'Q5.csv', { scripted: true, path: 'b7' })],
  };
  const list = fileCandidates(s);
  assert.deepEqual(list.map((c) => c.text), ['Archive_2026.zip', 'Approved_Budget.xlsx', 'Download']);
  assert.deepEqual(list.map((c) => [c.mode, c.kind, c.group, c.label, c.allow]), [['navigate', 'link', 'Task files', 'Archive_2026.zip', 'extension'], ['navigate', 'link', 'World files', 'Approved_Budget.xlsx', 'extension'], ['click', 'button', 'Task files', 'Notes.txt', 'download-name']]);
  assert.deepEqual(list[0].view, { tab: null, more: 1, scroll: 2 }, 'the view of the snapshot comes along');
  assert.equal(list[2].href, 'https://x.example/f/n.txt');
  assert.deepEqual(droppedCandidates(s), [
    { label: 'Remove Notes.txt', group: 'Task files', reason: 'looks like an action' }, { label: 'Gone.txt', group: 'Task files', reason: 'the button is disabled' },
    { label: 'Notes.txt', group: 'Task files', reason: NOT_CLEAR }, { label: 'Q4.csv', group: 'Task files', reason: 'would submit a form' }, { label: 'Download Q5.csv', group: 'Task files', reason: 'looks like an action' },
  ], '"Delete file" has no file name: an action, not a file; a button that only names a file is not clearly a download; the others are reported');
  assert.ok(NEVER_TEXT_RE.test('Cancel booking') && !NEVER_TEXT_RE.test('Cancelled_Orders.csv'));
  assert.ok(NEVER_TEXT_RE.test('Delete file') && NEVER_TEXT_RE.test('Sign out') && NEVER_TEXT_RE.test('Trash') && !NEVER_TEXT_RE.test('Archive_2026.zip') && !NEVER_TEXT_RE.test('Approved_Budget.xlsx'));
  for (const bad of ['/x?action=delete', '/files/12/remove', '/logout', '/files/15/submit', '/files/16/actions/run', '/files/17/cancel', '/files/18/archive', '/files/24/destroy', '/files/25/trash', '/files/26/actions', '/files/a/detach', '/files/a/share', '/x?method=delete', '/x?_method=DELETE', '/x?action=submit']) assert.ok(NEVER_HREF_RE.test(bad), bad);
  assert.ok(!NEVER_HREF_RE.test('/files/removed.csv') && !NEVER_HREF_RE.test('/files/Reset_policy.pdf'));
  assert.deepEqual(fileCandidates({ url: 'https://x.example/', links: [], buttons: [] }), []);
  assert.deepEqual(fileCandidates({ url: 'https://x.example/' }), []);
});
test('candidates: the allowlist - a path that ends in a file extension or in /download, a download attribute, a download name; an action word in a directory or a parameter stops all of them; the rest is "not clearly a download"', () => {
  const mk = (text, rawHref, extra = {}) => ({ text, names: [text], href: `https://x.test${rawHref}`, rawHref, scheme: 'https:', fileLike: true, why: ['path'], nameHint: rawHref.split('?')[0].split('/').pop(), ext: null, group: 'Files', path: 'a', download: null, ...extra });
  const verdict = (text, rawHref, extra) => linkVerdict(mk(text, rawHref, extra));
  /* allowed */
  assert.equal(verdict('Q3', '/files/9/Q3.pdf').allow, 'extension');
  assert.equal(verdict('Reset policy.pdf', '/f/Reset%20policy.pdf').allow, 'extension', 'a file NAME may hold an action word');
  assert.equal(verdict('Archive 2025 Q4.zip', '/f/Archive_2025_Q4.zip?X-Amz-Signature=abc-del-xyz&X-Amz-Expires=60').allow, 'extension', 'a signature is not read for words');
  assert.equal(verdict('Pack', '/f/pack.tar.gz').allow, 'extension');
  assert.equal(verdict('Q3 Report', '/files/12/download').allow, 'download-path', 'a REST download address');
  assert.equal(verdict('Q3', '/dl?id=3', { download: '' }).allow, 'download-attribute');
  assert.equal(verdict('Download', '/dl?token=abc').allow, 'download-name');
  assert.equal(verdict('Download Q3.pdf (120 KB)', '/dl?token=abc').allow, 'download-name');
  assert.equal(verdict('x', '/files/3?action=download&id=3', { names: ['Download file', 'x'] }).allow, 'download-name', 'an action parameter with a harmless value');
  assert.equal(linkVerdict({ text: 'x.txt', names: ['x.txt'], href: 'blob:https://x.test/abc', rawHref: 'blob:https://x.test/abc', scheme: 'blob:', download: 'x.txt' }).allow, 'download-attribute');
  /* an action in the address, whatever the link says or has */
  for (const bad of ['/api/files/13/remove', '/api/files/14/delete?filename=Q4b.pdf', '/files/15/submit', '/files/16/actions/run', '/files/17/cancel', '/files/18/archive', '/files/19?action=submit', '/files/20?method=delete', '/files/21?_method=DELETE', '/files/22/delete/now',
    '/files/23/Remove', '/files/24/destroy', '/files/25/trash', '/files/26/actions', '/files/27/revoke', '/files/28/publish', '/files/29/unsubscribe', '/f/publish/x.txt', '/files/a/detach/x.pdf', '/files/11/share-publicly', '/files/3/Q3.pdf?delete=1', '/files/submit.pdf']) {
    assert.equal(verdict('Download', bad, { download: '' }).allow, null, `${bad} with a download attribute`);
    assert.equal(verdict('Download', bad, { download: '' }).why, 'action', bad);
    assert.equal(verdict('Q3.pdf', bad).allow, null, bad);
  }
  /* not clearly a download */
  for (const unclear of ['/files/42', '/files/43?id=2', '/dl?token=abc', '/files/folder', '/f/AbC123']) { const v = verdict('Cancel policy', unclear); assert.deepEqual([v.allow, v.why], [null, 'unclear'], unclear); }
  assert.deepEqual([verdict('report.txt', '/dl?token=abc', { why: ['text-extension'] }).allow, verdict('Download app', '/app').allow], [null, null], 'a name with an extension is not enough, and "Download app" is not a download');
  const snap = { url: 'https://x.test/t', buttons: [], links: [mk('Archive of 2023 correspondence', '/files/9/download'), mk('Reset procedure', '/files/10/download'), mk('Cancel policy', '/files/42'), mk('Approval memo', '/files/45/approve'), mk('x', '/files/11/trash', { names: ['Move to trash', 'x'] }), mk('y', '/files/11/detach', { names: ['y', 'Detach from task'] }), mk('Delete log.txt', '/files/12/delete', { ext: 'txt' }), mk('report.txt', '/dl?token=a', { why: ['text-extension'] })] };
  assert.deepEqual(fileCandidates(snap).map((c) => c.label), ['Archive of 2023 correspondence', 'Reset procedure'], 'the words in the title of a file do not matter');
  assert.deepEqual(droppedCandidates(snap).map((d) => [d.label, d.reason]), [['Cancel policy', NOT_CLEAR], ['Approval memo', 'looks like an action'], ['Delete log.txt', 'looks like an action'], ['report.txt', NOT_CLEAR]], 'a row action with an icon is not a file and is not reported; what names a file and is not allowed is');
});
test('candidates: buttons - only a download name, outside a form, with no script that sends; "Export to Slack" and "Download app" are never pressed', () => {
  const btn = (text, extra = {}) => ({ text, names: [text], label: text, fileLike: true, disabled: false, inForm: false, scripted: false, dataUrl: null, ext: null, group: 'F', path: text, ...extra });
  const snap = { url: 'https://x.test/', links: [], buttons: [btn('Download', { label: 'Task_A.txt' }), btn('Download Q3.csv'), btn('Download file'), btn('Download app'), btn('Export to Slack'), btn('Download', { label: 'Task_B.txt', inForm: true, path: 'f' }), btn('Download', { label: 'Task_C.txt', scripted: true, path: 's' }),
    btn('Download', { label: 'Task_D.txt', names: ['Delete', 'Download'], path: 'd' }), btn('Task_E.txt', { ext: 'txt', path: 'e' }), btn('Delete Atlas.txt', { ext: 'txt', path: 'z' })] };
  assert.deepEqual(fileCandidates(snap).map((c) => c.label), ['Task_A.txt', 'Download Q3.csv', 'Download file']);
  assert.deepEqual(droppedCandidates(snap).map((d) => [d.label, d.reason]), [['Download app', NOT_CLEAR], ['Export to Slack', NOT_CLEAR], ['Task_B.txt', 'would submit a form'], ['Task_C.txt', 'looks like an action'], ['Task_D.txt', 'looks like an action'], ['Task_E.txt', NOT_CLEAR], ['Delete Atlas.txt', 'looks like an action']]);
  assert.equal(nameIsDownload(['Download', 'Download (12 KB)']), true);
  assert.equal(nameIsDownload(['Download', 'Remove file']), false, 'another name that says remove');
  assert.equal(nameIsDownload(['Delete', 'Download']), false);
  assert.equal(nameIsDownload(['Downloads']), false);
});
test('candidates: the same address listed twice on a page is one file; the same file signed anew in a later look is still one; two addresses that differ in a token are two files, whatever their labels; the same name in two tabs is two', () => {
  const mk = (href, text, extra = {}) => ({ text, href, rawHref: href, scheme: 'https:', fileLike: true, why: ['extension'], nameHint: text, ext: 'txt', group: 'F', path: 'a', download: null, ...extra });
  const snap = (...links) => ({ url: 'https://x.test/', buttons: [], links });
  const one = fileCandidates(snap(mk('https://x.test/f/A.txt?X-Amz-Signature=1&X-Amz-Expires=60', 'A.txt'), mk('https://x.test/f/A.txt?X-Amz-Signature=1&X-Amz-Expires=60', 'A.txt icon'), mk('https://x.test/dl/B.txt?id=1', 'B.txt'), mk('https://x.test/dl/C.txt?id=2', 'C.txt'), mk('https://x.test/dl/f.txt?token=a', 'D.txt'), mk('https://x.test/dl/f.txt?token=b', 'E.txt')));
  assert.deepEqual(one.map((c) => c.label), ['A.txt', 'B.txt', 'C.txt', 'D.txt', 'E.txt']);
  assert.equal(navigateKey('https://x.test/f/A.txt?sig=1&b=2&a=1', 'A'), navigateKey('https://x.test/f/A.txt?a=1&sig=9&b=2', 'A'));
  const later = fileCandidates(snap(mk('https://x.test/f/A.txt?X-Amz-Signature=2&X-Amz-Expires=60', 'A.txt'), mk('https://x.test/dl/B.txt?id=1', 'B.txt'), mk('https://x.test/dl/C.txt?id=2', 'C.txt'), mk('https://x.test/dl/f.txt?token=a2', 'D.txt'), mk('https://x.test/dl/f.txt?token=b2', 'E.txt')));
  const merged = discover.unionCandidates([one, later]);
  assert.deepEqual(merged.map((c) => c.label), ['A.txt', 'B.txt', 'C.txt', 'D.txt', 'E.txt'], 'a re-signed address is the same file');
  assert.match(merged[0].href, /Signature=2/, 'the newest address is kept');
  assert.match(merged[3].href, /token=a2/);
  /* three rows of bare "Download" links whose token IS the file id: three files, in every look, however the tokens are renamed */
  const row = (token, name) => mk(`https://x.test/dl?token=${token}`, 'Download', { label: name, why: ['download-attribute'], download: '', nameHint: 'Download' });
  const look1 = fileCandidates(snap(row('aaa111', 'Budget Q1'), row('bbb222', 'Budget Q2'), row('ccc333', 'Budget Q3')));
  const bare = fileCandidates(snap(mk('https://x.test/dl?token=aaa111', 'Download', { why: ['download-attribute'], download: '' }), mk('https://x.test/dl?token=bbb222', 'Download', { why: ['download-attribute'], download: '' }), mk('https://x.test/dl?token=ccc333', 'Download', { why: ['download-attribute'], download: '' })));
  assert.equal(look1.length, 3);
  assert.equal(bare.length, 3, 'no row text at all: the three are still three');
  const bare2 = fileCandidates(snap(mk('https://x.test/dl?token=aaa999', 'Download', { why: ['download-attribute'], download: '' }), mk('https://x.test/dl?token=bbb999', 'Download', { why: ['download-attribute'], download: '' }), mk('https://x.test/dl?token=ccc999', 'Download', { why: ['download-attribute'], download: '' })));
  const all = discover.unionCandidates([bare, bare2]);
  assert.equal(all.length, 3, 'and when each is signed anew they pair up by position');
  assert.deepEqual(all.map((c) => c.href.slice(-3)), ['999', '999', '999']);
  /* the same name and the same token-less address in two tabs: two files (the token is the only difference, and it is not part of the key) */
  const inTab = (label, token) => fileCandidates({ url: 'https://x.test/', buttons: [], view: { tab: { label, path: label }, more: 0, scroll: 0 }, links: [mk(`https://x.test/dl/report.txt?token=${token}`, 'report.txt'), mk(`https://x.test/dl/notes.txt?token=${token}x`, 'notes.txt')] });
  const tabs = discover.unionCandidates([inTab('Inputs', 'aaa'), inTab('Outputs', 'bbb')]);
  assert.deepEqual(tabs.map((c) => [c.view.tab.label, c.label]), [['Inputs', 'report.txt'], ['Inputs', 'notes.txt'], ['Outputs', 'report.txt'], ['Outputs', 'notes.txt']]);
  assert.equal(discover.unionCandidates([inTab('Inputs', 'aaa'), inTab('Inputs', 'ccc')]).length, 2, 'the same tab seen again with new tokens is the same two files');
});

/* ---------------------------------------------------------------- the page reader, on a tiny fake document (the real one runs in tests/links-browser.cjs) */
function fakeDocument() {
  const doc = {};
  const text = (nodeValue) => ({ nodeType: 3, nodeValue });
  const el = (tagName, attrs = {}, children = [], fields = {}) => {
    const node = {
      nodeType: 1, tagName, attrs, childNodes: children, shadowRoot: null, parentElement: null, previousElementSibling: null, id: attrs.id || '', name: attrs.name || '', autocomplete: '', title: '', labels: undefined,
      getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }, hasAttribute(name) { return name in this.attrs; }, getRootNode: () => doc, querySelector: () => null, querySelectorAll: () => [], cloneNode() { return this; }, ...fields,
    };
    Object.defineProperty(node, 'textContent', { get: () => children.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join(''), configurable: true });
    children.forEach((c) => { if (c.nodeType === 1) c.parentElement = node; });
    return node;
  };
  const flat = (node) => node.childNodes.filter((c) => c.nodeType === 1).flatMap((c) => [c, ...flat(c)]);
  const link = (label, href) => el('A', { href }, [text(label)], { href: `https://tasks.atlas.example${href}` });
  const body = el('BODY', {}, [
    el('H1', {}, [text('Atlas task')]),
    el('H2', {}, [text('Business prompt')]), el('P', {}, [text('Prepare the bridge. '), el('B', {}, [text('Be brief.')])]),
    el('SCRIPT', {}, [text('var secret = 1;')]), el('STYLE', {}, [text('p { color: red }')]), el('P', { id: 'gone' }, [text('Hidden text')], { checkVisibility: () => false }),
    el('H2', {}, [text('Notes')]),
    el('TEXTAREA', { id: 'n', name: 'note' }, [], { type: 'textarea', value: 'Check the freight credit.', labels: [el('LABEL', {}, [text('Reviewer note')])] }),
    el('INPUT', { id: 'k', name: 'account-token' }, [], { type: 'text', value: 'HIDDEN-SECRET', labels: [] }),
    el('INPUT', { id: 'pw', name: 'password' }, [], { type: 'password', value: 'hunter2', labels: [] }),
    el('H2', {}, [text('Task files')]),
    el('UL', {}, [el('LI', {}, [link('Atlas_Prompt.txt', '/files/Atlas_Prompt.txt')]), el('LI', {}, [link('About us', '/about')]), el('LI', {}, [link('Delete file', '/files/1/delete')])]),
    el('BUTTON', { role: 'switch', 'aria-checked': 'false', id: 't' }, [text('Show all files')]),
    el('BUTTON', { 'aria-pressed': 'true', id: 'p' }, [text('Compact view')]),
    el('DIV', { role: 'switch', 'aria-checked': 'false', 'aria-label': 'Advanced view', id: 'a' }, []),
    el('INPUT', { id: 'c', type: 'checkbox' }, [], { type: 'checkbox', checked: true, labels: [el('LABEL', {}, [text('Remember me')])] }),
    el('BUTTON', { id: 'dl' }, [text('Download Notes.txt')], { form: null }),
  ]);
  Object.assign(doc, { body, documentElement: body, title: 'Atlas', readyState: 'complete', querySelectorAll: (sel) => (sel === '*' ? flat(body) : []), querySelector: () => null });
  return doc;
}
test('extractPage: self-contained (it is sent to the page as text); sections at headings, hidden and script text left out, file links with their heading, switches with label and state, secret-looking fields not read', () => {
  const { extractPage, pageArgs } = require('../backend/links/page.cjs');
  const doc = fakeDocument();
  const sandbox = { document: doc, location: { href: 'https://tasks.atlas.example/t/1', origin: 'https://tasks.atlas.example' }, performance: { now: () => 0 }, CSS: { escape: (s) => s }, URL, URLSearchParams };
  const out = vm.runInNewContext(`(${extractPage.toString()})(${JSON.stringify(pageArgs())})`, sandbox);
  const result = JSON.parse(JSON.stringify(out));
  assert.deepEqual(result.sections.map((s) => s.heading), ['Atlas task', 'Business prompt', 'Notes', 'Task files']);
  const by = Object.fromEntries(result.sections.map((s) => [s.heading, s.text]));
  assert.equal(by['Business prompt'], 'Prepare the bridge. Be brief.');
  assert.ok(!JSON.stringify(result.sections).includes('Hidden text') && !JSON.stringify(result.sections).includes('var secret') && !JSON.stringify(result).includes('color: red'));
  assert.equal(by.Notes, 'Reviewer note: Check the freight credit.');
  assert.ok(!JSON.stringify(result).includes('HIDDEN-SECRET') && !JSON.stringify(result).includes('hunter2'), 'a secret-looking field and a password are never read');
  assert.match(by['Task files'], /Atlas_Prompt\.txt/);
  assert.deepEqual(result.links.map((l) => [l.text, l.group, l.fileLike, l.href]), [['Atlas_Prompt.txt', 'Task files', true, 'https://tasks.atlas.example/files/Atlas_Prompt.txt'], ['Delete file', 'Task files', true, 'https://tasks.atlas.example/files/1/delete']], 'only links that look like files; /about is not one');
  assert.deepEqual(result.toggles.map((t) => [t.label, t.checked, t.kind]), [['Show all files', false, 'switch'], ['Compact view', true, 'pressed'], ['Advanced view', false, 'switch'], ['Remember me', true, 'checkbox']]);
  assert.equal(findAllFilesToggle(result.toggles, null).label, 'Show all files');
  assert.equal(findAllFilesToggle(result.toggles, 'advanced view').label, 'Advanced view');
  assert.deepEqual(result.buttons.map((b) => [b.text, b.group, b.inForm, b.scripted]), [['Download Notes.txt', 'Task files', false, false]]);
  assert.deepEqual(fileCandidates(result).map((c) => [c.mode, c.label]), [['navigate', 'Atlas_Prompt.txt'], ['click', 'Download Notes.txt']], 'the Delete link is dropped by the candidate rules');
  assert.deepEqual(result.hidden, [], 'nothing hidden');
  assert.deepEqual(result.frames, { blocked: 0 });
  assert.deepEqual([result.signals.hasPasswordField, result.signals.hasOtpField, result.signals.hasCaptcha, result.linkCount, result.title, result.url], [true, false, false, 3, 'Atlas', 'https://tasks.atlas.example/t/1']);
  assert.ok(result.controlCount >= 1);
  assert.equal(typeof result.signals.bodyTextChars, 'number');
});

/* A richer fake document: sibling-labelled switch, <select>, radio in a label, tab, "Download" button in a table row, blob link, iframe, bidi text. */
function richDocument() {
  const doc = {};
  const text = (nodeValue) => ({ nodeType: 3, nodeValue });
  const el = (tagName, attrs = {}, children = [], fields = {}) => {
    const node = {
      nodeType: 1, tagName, attrs, childNodes: children, shadowRoot: null, parentElement: null, previousElementSibling: null, nextElementSibling: null, id: attrs.id || '', name: attrs.name || '', autocomplete: attrs.autocomplete || '', title: '', labels: undefined,
      getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }, hasAttribute(name) { return name in this.attrs; }, getRootNode: () => doc, querySelector: () => null, querySelectorAll: () => [], cloneNode() { return this; },
      closest(sel) { for (let n = this; n; n = n.parentElement) if (sel.split(',').some((q) => (q.startsWith('[role=') ? n.attrs.role === q.slice(6, -1) : n.tagName === q.toUpperCase()))) return n; return null; }, ...fields,
    };
    Object.defineProperty(node, 'textContent', { get: () => children.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join(''), configurable: true });
    children.forEach((c, i) => { if (c.nodeType === 1) { c.parentElement = node; c.previousElementSibling = children.slice(0, i).filter((x) => x.nodeType === 1).pop() || null; c.nextElementSibling = children.slice(i + 1).find((x) => x.nodeType === 1) || null; } });
    return node;
  };
  const flat = (node) => node.childNodes.filter((c) => c.nodeType === 1).flatMap((c) => [c, ...flat(c)]);
  const option = (label, selected) => ({ textContent: label, selected, disabled: false });
  const innerLink = el('A', { href: '/files/inner/Inner_Report.pdf' }, [text('Inner_Report.pdf')], { href: 'https://tasks.atlas.example/files/inner/Inner_Report.pdf' });
  const innerBody = el('BODY', {}, [el('H3', {}, [text('Inside')]), innerLink]);
  const innerDoc = { documentElement: innerBody, body: innerBody, querySelectorAll: (sel) => (sel === '*' ? flat(innerBody) : []) };
  [innerBody, innerLink].forEach((n) => { n.getRootNode = () => innerDoc; });
  innerBody.childNodes.forEach((c) => { if (c.nodeType === 1) c.getRootNode = () => innerDoc; });
  const row = el('TR', {}, [el('TD', {}, [text('Atlas_Rows.csv ')]), el('TD', {}, [text('1 KB ')]), el('TD', {}, [el('BUTTON', { id: 'rowdl', 'data-url': '/files/rows' }, [text('Download')], { form: null })])]);
  const body = el('BODY', {}, [
    el('H2', {}, [text('Files\u202e')]),
    el('DIV', {}, [el('SPAN', {}, [text('Show all files')]), el('DIV', { role: 'switch', 'aria-checked': 'false', id: 'sw1', 'data-testid': 'all-switch' }, [])]),
    el('DIV', {}, [el('DIV', { role: 'switch', 'aria-checked': 'false', id: 'sw2' }, []), el('DIV', { id: 'more' }, [text('World files Notes.txt')], { querySelector: () => ({}) })], { querySelector: () => ({}) }),
    el('SELECT', { id: 'view' }, [], { type: 'select-one', options: [option('Added files', true), option('All files', false)], selectedOptions: [option('Added files', true)], value: 'a' }),
    el('LABEL', {}, [el('INPUT', { type: 'radio', id: 'r1' }, [], { type: 'radio', checked: false, labels: [] }), text(' World files')]),
    el('BUTTON', { role: 'tab', 'aria-selected': 'false', id: 't1' }, [text('Everything')]),
    el('BUTTON', { id: 'plain' }, [text('Show all files')]),
    el('BUTTON', { id: 'dlall' }, [text('Download all files')], { form: null }),
    el('TABLE', {}, [row]),
    el('UL', {}, [el('LI', {}, [el('A', { href: 'blob:x', download: 'Atlas_Blob.txt' }, [text('Blob file')], { href: 'blob:https://tasks.atlas.example/0a1b2c' })]), el('LI', {}, [el('A', { href: '/files' }, [text('Files')], { href: 'https://tasks.atlas.example/files' })]), el('LI', {}, [el('A', { href: '/assets/' }, [text('Assets')], { href: 'https://tasks.atlas.example/assets/' })]), el('LI', {}, [el('A', { href: '/files/12' }, [text('Numbered')], { href: 'https://tasks.atlas.example/files/12' })])]),
    el('TEXTAREA', { id: 'a1', name: 'author_notes' }, [], { type: 'textarea', value: 'keep this', labels: [] }),
    el('TEXTAREA', { id: 'a2', name: 'passage' }, [], { type: 'textarea', value: 'and this', labels: [] }),
    el('INPUT', { id: 'a3', name: 'scorecard' }, [], { type: 'text', value: 'and this too', labels: [] }),
    el('INPUT', { id: 'a4', name: 'accessToken' }, [], { type: 'text', value: 'SECRET1', labels: [] }),
    el('INPUT', { id: 'a5', name: 'user[password]' }, [], { type: 'text', value: 'SECRET2', labels: [] }),
    el('INPUT', { id: 'a6', name: 'x', autocomplete: 'cc-number' }, [], { type: 'text', value: 'SECRET3', labels: [], autocomplete: 'cc-number' }),
    el('IFRAME', { id: 'frame' }, [], { contentDocument: innerDoc }),
  ]);
  Object.assign(doc, { body, documentElement: body, title: 'Atlas', readyState: 'complete', querySelectorAll: (sel) => (sel === '*' ? flat(body) : []), querySelector: () => null });
  return doc;
}
const runExtract = (doc) => {
  const { extractPage, pageArgs } = require('../backend/links/page.cjs');
  const sandbox = { document: doc, location: { href: 'https://tasks.atlas.example/t/1', origin: 'https://tasks.atlas.example' }, performance: { now: () => 0 }, CSS: { escape: (s) => s }, URL, URLSearchParams };
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${extractPage.toString()})(${JSON.stringify(pageArgs())})`, sandbox)));
};

test('extractPage: label fallbacks (the text beside a switch), <select> options, radio, tab and "show all files" button as controls, each with a stable key', () => {
  const out = runExtract(richDocument());
  const by = (kind, label) => out.toggles.find((t) => t.kind === kind && t.label === label);
  assert.deepEqual([by('switch', 'Show all files').checked, by('switch', 'Show all files').key], [false, 'id:sw1'], 'the label is the text beside the empty switch');
  assert.equal(out.toggles.find((t) => t.key === 'id:sw2').label, '', 'what the switch reveals (a block with links) is not its label');
  assert.deepEqual(out.toggles.filter((t) => t.kind === 'option').map((t) => [t.label, t.checked, t.option]), [['Added files', true, 0], ['All files', false, 1]]);
  assert.equal(by('radio', 'World files').checked, false, 'a radio in a label takes the label');
  assert.deepEqual([by('tab', 'Everything').checked, by('button', 'Show all files').kind], [false, 'button']);
  assert.ok(!out.toggles.some((t) => /Download all/.test(t.label)), 'a "Download all files" button is a download, not the switch');
  assert.equal(findAllFilesToggle(out.toggles, null).key, 'id:sw1', 'the first label that says so');
  assert.equal(findAllFilesToggle(out.toggles, { label: '', key: 'id:t1' }).kind, 'tab', 'a learned key finds a control by its id');
  assert.equal(findAllFilesToggle(out.toggles, 'all files').kind, 'option', 'a learned label finds a select option');
  assert.equal(findAllFilesState(out.toggles.map((t) => ({ ...t, checked: true })), null).on, true, 'a control that is already on is found');
});
test('extractPage: a blob link, a plain "Download" button with its row\'s text as label, /files and /assets pages are not files, bidi controls stripped, secret words only as whole words, a same-origin iframe is read', () => {
  const out = runExtract(richDocument());
  assert.equal(out.headings[0].text, 'Files', 'the bidi control is gone from the heading');
  assert.ok(!JSON.stringify(out).includes('\u202e'));
  assert.deepEqual(out.links.map((l) => [l.text, l.scheme]), [['Blob file', 'blob:'], ['Numbered', 'https:'], ['Inner_Report.pdf', 'https:']], '/files and /assets/ are pages; /files/12 is a file; the iframe\'s link is read');
  assert.equal(out.links[2].path, null, 'an element inside an iframe cannot be clicked from the task page');
  assert.deepEqual(out.buttons.map((b) => [b.text, b.label, b.nameHint, b.dataUrl]), [['Download all files', 'Download all files', 'Download all files', null], ['Download', 'Atlas_Rows.csv 1 KB', 'Atlas_Rows.csv', '/files/rows']]);
  const cands = fileCandidates({ ...out, url: 'https://tasks.atlas.example/t/1' });
  assert.deepEqual(cands.map((c) => [c.mode, c.label]), [['click', 'Blob file'], ['navigate', 'Inner_Report.pdf'], ['click', 'Atlas_Rows.csv 1 KB']], 'blob links are clicked; the "Download all" button is dropped when files are listed; /files/12 says nothing about being a download');
  assert.deepEqual(droppedCandidates({ ...out, url: 'https://tasks.atlas.example/t/1' }).map((d) => [d.label, d.reason]), [['Numbered', NOT_CLEAR]]);
  assert.equal(cands[2].href, 'https://tasks.atlas.example/files/rows');
  assert.equal(cands[2].nameHint, 'Atlas_Rows.csv');
  const only = fileCandidates({ url: 'https://x.example/', links: [], buttons: [{ text: 'Download all files', label: 'Download all files', fileLike: true, path: 'b' }] });
  assert.deepEqual(only.map((c) => c.text), ['Download all files'], 'with nothing else it stays');
  const text = JSON.stringify(out.sections);
  for (const kept of ['keep this', 'and this', 'and this too', 'Inside']) assert.ok(text.includes(kept), kept);
  for (const secret of ['SECRET1', 'SECRET2', 'SECRET3']) assert.ok(!JSON.stringify(out).includes(secret), secret);
});

function opsSandbox(elements) {
  const clicks = []; const events = [];
  const mk = (id, extra = {}) => ({ id, tagName: 'BUTTON', textContent: id, value: '', title: '', disabled: false, attrs: {}, getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }, hasAttribute(n) { return n in this.attrs; }, click() { clicks.push(id); }, dispatchEvent(e) { events.push([id, e.type]); }, querySelector: () => null, getRootNode: () => doc, ...extra });
  const nodes = Object.fromEntries(Object.entries(elements).map(([id, extra]) => [id, mk(id, extra)]));
  const doc = { querySelector: (sel) => nodes[sel.replace(/^#/, '')] || null, querySelectorAll: () => [], scrollingElement: null };
  return { nodes, clicks, events, sandbox: { document: doc, window: { innerHeight: 800 }, performance: { now: () => Date.now() }, Event: class { constructor(type) { this.type = type; } }, getComputedStyle: () => ({ overflowY: 'visible' }), CSS: { escape: (s) => s } } };
}
test('pageOps activate: every press needs a kind and the live element must still be of that kind - gone, changed, in a form, scripted, not named as a download or an action in its label are all refused; a <select> option is chosen with input and change events', () => {
  const { pageOps, RULES } = require('../backend/links/page.cjs');
  const run = (box, arg) => JSON.parse(JSON.stringify(vm.runInNewContext(`(${pageOps.toString()})(${JSON.stringify({ op: 'activate', rules: RULES, ...arg })})`, box.sandbox)));
  const box = opsSandbox({
    dl: { textContent: ' Download ' }, del: { textContent: 'Delete file' }, named: { textContent: 'Atlas_Notes.txt' }, inform: { textContent: 'Download', form: {} }, scripted: { textContent: 'Download', attrs: { onclick: "document.getElementById('f').submit()" } },
    titled: { textContent: 'Download', attrs: { title: 'Remove this file' } }, formaction: { textContent: 'Download', attrs: { formaction: '/x' } }, empty: { textContent: '' },
    sel: { tagName: 'SELECT', textContent: 'Added files All files', selectedIndex: 0, options: [{ textContent: 'Added files' }, { textContent: 'Show all files' }] },
    bulk: { tagName: 'SELECT', textContent: 'x', selectedIndex: 0, options: [{ textContent: 'Added files' }, { textContent: 'Show all files' }, { textContent: 'Mark all files as reviewed' }] },
    perm: { tagName: 'SELECT', textContent: 'x', selectedIndex: 0, options: [{ textContent: 'No access' }, { textContent: 'Can view all files' }] },
    posting: { attrs: { role: 'switch' }, textContent: 'Show all files', form: { getAttribute: (n) => (n === 'method' ? 'post' : null) } },
    submitting: { attrs: { role: 'switch', onchange: 'this.form.submit()' }, textContent: 'Show all files' },
    getform: { attrs: { role: 'switch' }, textContent: 'Show all files', form: { getAttribute: (n) => (n === 'method' ? 'GET' : null) } },
    tablink: { tagName: 'A', attrs: { role: 'tab', href: '/projects/7/trash' }, href: 'https://x.test/projects/7/trash', textContent: 'Trash' }, pagerlink: { tagName: 'A', attrs: { href: '/t?page=2' }, href: 'https://x.test/t?page=2', textContent: '2' },
    sw: { attrs: { role: 'switch', 'aria-label': 'Show all files' }, textContent: '' }, clear: { attrs: { role: 'switch', 'aria-label': 'Clear all files' }, textContent: '' }, digest: { tagName: 'INPUT', type: 'checkbox', value: 'on', textContent: '', labels: [{ textContent: 'Include all attachments in my daily digest email' }] },
    tab: { attrs: { role: 'tab' }, textContent: 'Reference' }, exp: { attrs: { 'aria-expanded': 'false' }, textContent: 'Archive' }, more: { textContent: 'Load more' }, pager: { textContent: '3' },
    plain: { textContent: 'Show all files' }, plainClear: { textContent: 'Clear all files' }, link: { tagName: 'A', textContent: 'Q3 report', href: 'https://x.test/f/Q3.pdf', attrs: { href: '/f/Q3.pdf', download: '' } }, bare: { tagName: 'A', textContent: 'Q3 report', href: 'https://x.test/f/Q3.pdf', attrs: { href: '/f/Q3.pdf' } },
  });
  assert.deepEqual(run(box, { path: '#dl', kind: 'download', label: 'Download' }), { ok: true });
  assert.deepEqual(box.clicks, ['dl']);
  assert.match(run(box, { path: '#dl', kind: 'download', label: 'Something else' }).why, /no longer the one that was listed/);
  assert.match(run(box, { path: '#dl', label: 'Download' }).why, /does not press this kind/, 'no kind, no press');
  assert.match(run(box, { path: '#dl', kind: 'delete', label: 'Download' }).why, /does not press this kind/);
  assert.match(run(box, { path: '#del', kind: 'download' }).why, /not named as a download/);
  assert.match(run(box, { path: '#named', kind: 'download' }).why, /not named as a download/, 'a button that only names a file');
  assert.match(run(box, { path: '#inform', kind: 'download' }).why, /in a form/);
  assert.match(run(box, { path: '#formaction', kind: 'download' }).why, /in a form/);
  assert.match(run(box, { path: '#scripted', kind: 'download' }).why, /script/);
  assert.match(run(box, { path: '#titled', kind: 'download' }).why, /not named as a download/, 'another name of the control says remove');
  assert.match(run(box, { path: '#gone', kind: 'download' }).why, /gone/);
  assert.match(run(box, { path: null, kind: 'download' }).why, /gone/);
  assert.deepEqual(box.clicks, ['dl']);
  /* a link pressed in the page: a download link whose address is the listed one */
  assert.equal(run(box, { path: '#link', kind: 'link', href: 'https://x.test/f/Q3.pdf' }).ok, true);
  assert.match(run(box, { path: '#link', kind: 'link', href: 'https://x.test/f/Other.pdf' }).why, /address of the link changed/);
  assert.match(run(box, { path: '#bare', kind: 'link', href: 'https://x.test/f/Q3.pdf' }).why, /not clearly a download/);
  assert.match(run(box, { path: '#bare', kind: 'link' }).why, /not a blob or data link/);
  /* navigation: tab, expander (a folder called Archive is fine), more, pager */
  assert.equal(run(box, { path: '#tab', kind: 'tab', label: 'Reference' }).ok, true);
  assert.match(run(box, { path: '#dl', kind: 'tab' }).why, /no longer a tab/);
  assert.equal(run(box, { path: '#exp', kind: 'expander', label: 'Archive' }).ok, true, 'opening a folder called Archive changes nothing');
  assert.match(run(box, { path: '#dl', kind: 'expander' }).why, /no longer an expander/);
  assert.equal(run(box, { path: '#more', kind: 'more', label: 'Load more' }).ok, true);
  assert.match(run(box, { path: '#del', kind: 'more' }).why, /no longer a "Load more"/);
  assert.equal(run(box, { path: '#pager', kind: 'pager', label: '3' }).ok, true);
  assert.match(run(box, { path: '#del', kind: 'pager' }).why, /no longer a page control/);
  /* the show-all-files control */
  assert.equal(run(box, { path: '#sw', kind: 'toggle', tkind: 'switch', label: 'Show all files' }).ok, true);
  assert.match(run(box, { path: '#clear', kind: 'toggle', tkind: 'switch', label: 'Show all files' }).why, /names an action/, 'the live label says clear, whatever was listed');
  assert.match(run(box, { path: '#digest', kind: 'toggle', tkind: 'checkbox', label: 'Show all files' }).why, /names an action/, 'a settings switch: the label of its <label> is read, not its value');
  assert.match(run(box, { path: '#dl', kind: 'toggle', tkind: 'switch', label: 'x' }).why, /no longer a switch/);
  assert.match(run(box, { path: '#del', kind: 'toggle', tkind: 'switch', label: 'x' }).why, /names an action/);
  assert.equal(run(box, { path: '#plain', kind: 'toggle', tkind: 'button', label: 'Show all files' }).ok, true);
  assert.match(run(box, { path: '#plainClear', kind: 'toggle', tkind: 'button', label: 'Show all files' }).why, /names an action/);
  assert.match(run(box, { path: '#dl', kind: 'toggle', tkind: 'button', label: 'Show all files' }).why, /no longer the "show all files" button/);
  assert.match(run(box, { path: '#sw', kind: 'toggle', tkind: 'link', label: 'Show all files' }).why, /does not press this kind/);
  assert.equal(run(box, { path: '#sel', kind: 'toggle', tkind: 'option', option: 1, label: 'Show all files' }).ok, true);
  assert.equal(box.nodes.sel.selectedIndex, 1);
  assert.deepEqual(box.events, [['sel', 'input'], ['sel', 'change']]);
  assert.match(run(box, { path: '#sel', kind: 'toggle', tkind: 'option', option: 0, label: 'Added files' }).why, /not "show all files"/);
  assert.match(run(box, { path: '#bulk', kind: 'toggle', tkind: 'option', option: 1, label: 'Show all files' }).why, /not views of the files/, 'one action in the list and the list is not the control, whichever option is asked for');
  assert.match(run(box, { path: '#bulk', kind: 'toggle', tkind: 'option', option: 2, label: 'Show all files' }).why, /names an action|not "show all files"/);
  assert.match(run(box, { path: '#perm', kind: 'toggle', tkind: 'option', option: 1, label: 'Can view all files' }).why, /names an action|not views of the files/, 'a permission list: "Can view all files" is a sharing setting');
  assert.match(run(box, { path: '#posting', kind: 'toggle', tkind: 'switch', label: 'Show all files' }).why, /form that saves something/, 'a control in a POST form');
  assert.match(run(box, { path: '#submitting', kind: 'toggle', tkind: 'switch', label: 'Show all files' }).why, /form that saves something/, 'a control whose onchange submits');
  assert.equal(run(box, { path: '#getform', kind: 'toggle', tkind: 'switch', label: 'Show all files' }).ok, true, 'a GET form only changes the view');
  /* a tab or a pager that is a link: only the address the loader looked at; a pager press never leaves the page */
  assert.match(run(box, { path: '#tablink', kind: 'tab', label: 'Trash' }).why, /link to an address the loader has not looked at/);
  assert.match(run(box, { path: '#tablink', kind: 'tab', label: 'Trash', href: 'https://x.test/elsewhere' }).why, /has not looked at/);
  assert.equal(run(box, { path: '#tablink', kind: 'tab', label: 'Trash', href: 'https://x.test/projects/7/trash' }).ok, true, 'the loader vets the address before it asks (a test of the press itself)');
  assert.match(run(box, { path: '#pagerlink', kind: 'pager', label: '2' }).why, /link that goes to another address/);
  assert.equal(run(box, { path: '#sel', kind: 'toggle', tkind: 'option', option: 0, label: 'Added files', learned: true }).ok, true, 'what the person taught needs no "all files" words, but still no action');
  assert.equal(vm.runInNewContext(`(${pageOps.toString()})(${JSON.stringify({ op: 'nothing' })})`, box.sandbox).ok, false);
});

/* a tiny DOM builder for the page-side functions: elements with a parent, siblings, text, and the few fields they read */
function tinyDom() {
  const doc = {};
  const text = (nodeValue) => ({ nodeType: 3, nodeValue });
  const el = (tagName, attrs = {}, children = [], fields = {}) => {
    const node = {
      nodeType: 1, tagName, attrs, childNodes: children, shadowRoot: null, parentElement: null, previousElementSibling: null, nextElementSibling: null, id: attrs.id || '', name: attrs.name || '', autocomplete: '', title: attrs.title || '', labels: undefined,
      getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }, hasAttribute(name) { return name in this.attrs; }, getRootNode: () => doc, querySelector: () => null, querySelectorAll: () => [], cloneNode() { return this; }, closest: () => null, ...fields,
    };
    Object.defineProperty(node, 'textContent', { get: () => children.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join(''), configurable: true });
    children.forEach((c, i) => { if (c.nodeType === 1) { c.parentElement = node; c.previousElementSibling = children.slice(0, i).filter((x) => x.nodeType === 1).pop() || null; c.nextElementSibling = children.slice(i + 1).find((x) => x.nodeType === 1) || null; } });
    return node;
  };
  const flat = (node) => node.childNodes.filter((c) => c.nodeType === 1).flatMap((c) => [c, ...flat(c)]);
  return { doc, el, text, flat };
}
test('extractPage: more controls are files - a "#" link or a link without an address called Download, an icon-only button with a title, a link named like a file whose address says nothing; javascript: code never; a button counts as submitting only when it can submit', () => {
  const { extractPage, pageArgs } = require('../backend/links/page.cjs');
  const { doc, el, text, flat } = tinyDom();
  const form = {};
  const abs = (href) => `https://tasks.atlas.example${href}`;
  const body = el('BODY', {}, [
    el('H2', {}, [text('Files')]),
    el('A', { href: '#', role: 'button' }, [text('Download')]), el('A', { role: 'button' }, [text('Download')]), el('A', { href: 'javascript:void(0)' }, [text('Download')]),
    el('A', { href: 'javascript:alert(1)', download: '' }, [text('evil.pdf')], { href: 'javascript:alert(1)' }),
    el('BUTTON', { title: 'Download the notes' }, [el('SVG', {}, [])]), el('BUTTON', { 'aria-label': 'Download Budget5.xlsx' }, []),
    el('A', { href: '/files/doc42' }, [text('Budget_2025.xlsx')], { href: abs('/files/doc42') }),
    el('A', { href: '/about' }, [text('Annual report v1.2')], { href: abs('/about') }),
    el('BUTTON', { type: 'button' }, [text('Download')], { form }), el('BUTTON', {}, [text('Download')], { form }), el('INPUT', { type: 'submit', value: 'Download' }, [], { type: 'submit', value: 'Download', form }),
    el('BUTTON', { type: 'button', formaction: '/x' }, [text('Download')], { form }), el('BUTTON', {}, [text('Download')], { form: null }), el('BUTTON', { type: 'reset' }, [text('Download')], { form }),
  ]);
  Object.assign(doc, { body, documentElement: body, title: 'T', readyState: 'complete', querySelectorAll: (sel) => (sel === '*' ? flat(body) : []), querySelector: () => null });
  const sandbox = { document: doc, location: { href: abs('/t/1'), origin: abs('') }, performance: { now: () => 0 }, CSS: { escape: (x) => x }, URL, URLSearchParams };
  const out = JSON.parse(JSON.stringify(vm.runInNewContext(`(${extractPage.toString()})(${JSON.stringify(pageArgs())})`, sandbox)));
  assert.deepEqual(out.links.map((l) => [l.text, l.why]), [['Budget_2025.xlsx', ['text-extension', 'path']]], 'a link called like a file counts; javascript: code and "Annual report v1.2" do not');
  assert.deepEqual(out.buttons.map((b) => [b.text, b.inForm]), [
    ['Download', false], ['Download', false], ['Download', false], ['Download the notes', false], ['Download Budget5.xlsx', false],
    ['Download', true], ['Download', true], ['Download', true], ['Download', true], ['Download', false], ['Download', true]], 'a control that belongs to a form is in a form, whatever its type; one with no form is not');
  assert.deepEqual(out.buttons.slice(0, 5).map((b) => b.names), [['Download'], ['Download'], ['Download'], ['Download the notes'], ['Download Budget5.xlsx']]);
  assert.deepEqual(fileCandidates({ ...out, url: abs('/t/1') }).map((c) => c.label), ['Download', 'Download', 'Download', 'Download Budget5.xlsx', 'Download'], 'only the ones outside a form, and named as a download ("Download the notes" is not');
  assert.ok(!out.buttons.some((b) => b.text === 'evil.pdf'));
});
test('extractPage: the file name of a row is the whole phrase up to the extension, not its last word; a row with no table, list or row role is the nearest ancestor with more text; a container of several buttons is not a row', () => {
  const { extractPage, pageArgs } = require('../backend/links/page.cjs');
  const { doc, el, text, flat } = tinyDom();
  const button = (extra = {}) => el('BUTTON', {}, [text('Download')], extra);
  const divRow = (name) => { const b = button(); const row = el('DIV', { class: 'row' }, [el('SPAN', {}, [text(name)]), text(' '), b], { innerText: `${name} Download`, querySelectorAll: () => [b] }); return row; };
  const tableButton = button({ closest: () => ({ innerText: 'Entity 02 Budget.txt\t1 KB\tDownload', textContent: 'Entity 02 Budget.txt 1 KB Download' }) });
  const tarButton = button({ closest: () => ({ innerText: 'archive.tar.gz\tDownload', textContent: 'archive.tar.gz Download' }) });
  const lone = button(); const other = button();
  const container = el('DIV', {}, [lone, other], { innerText: 'Download Download', querySelectorAll: () => [lone, other] });
  const wrapped = (() => { const b = button(); const actions = el('DIV', { class: 'actions' }, [b], { innerText: 'Download', querySelectorAll: () => [b] }); return el('DIV', { class: 'row' }, [el('SPAN', {}, [text('Wrapped One.pdf')]), actions], { innerText: 'Wrapped One.pdf Download', querySelectorAll: () => [b] }); })();
  const body = el('BODY', {}, [divRow('Entity 01 Budget.txt'), tableButton, tarButton, container, wrapped]);
  Object.assign(doc, { body, documentElement: body, title: 'T', readyState: 'complete', querySelectorAll: (sel) => (sel === '*' ? flat(body) : []), querySelector: () => null });
  const sandbox = { document: doc, location: { href: 'https://tasks.atlas.example/t/1', origin: 'https://tasks.atlas.example' }, performance: { now: () => 0 }, CSS: { escape: (x) => x }, URL, URLSearchParams };
  const out = JSON.parse(JSON.stringify(vm.runInNewContext(`(${extractPage.toString()})(${JSON.stringify(pageArgs())})`, sandbox)));
  assert.deepEqual(out.buttons.map((b) => [b.label, b.nameHint]), [
    ['Entity 01 Budget.txt', 'Entity 01 Budget.txt'], ['Entity 02 Budget.txt 1 KB', 'Entity 02 Budget.txt'], ['archive.tar.gz', 'archive.tar.gz'],
    ['Download', 'Download'], ['Download', 'Download'], ['Wrapped One.pdf', 'Wrapped One.pdf']], 'whole phrase; a bare container gives no row; a wrapper that holds only the button is climbed through');
});
function opsDom(setup) {
  const { doc, el, text, flat } = tinyDom();
  const clicks = [];
  const built = setup({ el, text, clicks });
  const roots = built.roots || [];
  Object.assign(doc, { querySelectorAll: (sel) => (sel === '*' ? built.all || [] : (built.by || {})[sel] || []), querySelector: (sel) => (built.find || {})[sel] || null, scrollingElement: null, documentElement: {} });
  return { sandbox: { document: doc, window: { innerHeight: 800 }, performance: { now: () => Date.now() }, Event: class { constructor(type) { this.type = type; } }, getComputedStyle: () => ({ overflowY: 'visible' }), CSS: { escape: (x) => x } }, clicks, built, flat, roots };
}
const runOp = (dom, arg) => JSON.parse(JSON.stringify(vm.runInNewContext(`(${require('../backend/links/page.cjs').pageOps.toString()})(${JSON.stringify(arg)})`, dom.sandbox)));
test('pageOps activate: a "Download" button is pressed only when its ROW is still the one that was listed (or still holds the file name); a plain file link is not refused for the words in its name', () => {
  const { RULES } = require('../backend/links/page.cjs');
  const dom = opsDom(({ el, text, clicks }) => {
    const row = (content) => ({ innerText: content, textContent: content });
    const button = (id, rowText) => el('BUTTON', { id }, [text('Download')], { click: () => clicks.push(id), closest: (sel) => (/tr,li/.test(sel) && rowText !== null ? row(rowText) : null) });
    const link = el('A', { id: 'archive', download: '', href: '/f/Archive_2025_Q4.zip' }, [text('Archive 2025 Q4.zip')], { click: () => clicks.push('archive'), href: 'https://x.test/f/Archive_2025_Q4.zip' });
    return { find: { '#b1': button('b1', 'Atlas_Rows.csv Download 1 KB'), '#b2': button('b2', 'Other_File.csv Download'), '#b3': button('b3', null), '#archive': link } };
  });
  const press = (arg) => runOp(dom, { op: 'activate', rules: RULES, kind: 'download', ...arg });
  assert.deepEqual(press({ path: '#b1', label: 'Download', row: 'Atlas_Rows.csv 1 KB' }), { ok: true });
  assert.match(press({ path: '#b2', label: 'Download', row: 'Atlas_Rows.csv 1 KB' }).why, /row of the element is no longer the one that was listed/, 'the same button text, another row: refused, not pressed');
  assert.equal(press({ path: '#b2', label: 'Download', row: 'Atlas_Rows.csv 1 KB (new)', name: 'Other_File.csv' }).ok, true, 'a row whose other words changed still holds the file name');
  assert.match(press({ path: '#b3', label: 'Download', row: 'Atlas_Rows.csv' }).why, /row of the element/, 'no row at all is no match');
  assert.deepEqual(dom.clicks, ['b1', 'b2']);
  assert.match(press({ path: '#archive', label: 'Archive 2025 Q4.zip' }).why, /is a link, not a button/, 'a link is not pressed as a button');
  assert.equal(press({ path: '#archive', kind: 'link', label: 'Archive 2025 Q4.zip', href: 'https://x.test/f/Archive_2025_Q4.zip' }).ok, true, 'a download link is pressed under its own words');
  assert.equal(press({ path: '#b1', label: 'Download', row: 'Download' }).ok, true, 'row equal to the text: no row to compare');
  assert.equal(press({ path: '#b1', label: 'Download', row: 'Atlas_Rows.csv Updated now', parts: ['Atlas_Rows.csv'] }).ok, true, 'the name cell is enough: the other cells of the row may change');
});
test('pageOps: a path is one CSS path per document joined with >>> - it goes through an iframe and through a shadow root; expand, controls and scroll look in them too; a link that goes somewhere is not a "Load more" button', () => {
  const { RULES } = require('../backend/links/page.cjs');
  const dom = opsDom(({ el, text, clicks }) => {
    const innerBtn = el('BUTTON', { id: 'inner' }, [text('Download')], { click: () => clicks.push('inner') });
    const shadowBtn = el('BUTTON', { id: 'sh' }, [text('Download')], { click: () => clicks.push('sh') });
    const frame = el('IFRAME', { id: 'f' }, [], { contentDocument: { nodeType: 9, documentElement: {}, querySelector: (sel) => (sel === '#inner' ? innerBtn : null), querySelectorAll: (sel) => (sel === '*' ? [innerBtn] : sel === 'details:not([open])' ? [details] : sel === 'button,a,[role=button],[role=link],input[type=button]' ? [moreInFrame, navMore] : []), scrollingElement: { scrollTop: 0, scrollHeight: 5000, clientHeight: 800 }, defaultView: { innerHeight: 600 } } });
    const host = el('DIV', { id: 'host' }, [], { shadowRoot: { nodeType: 11, host: null, querySelector: (sel) => (sel === '#sh' ? shadowBtn : null), querySelectorAll: (sel) => (sel === '*' ? [shadowBtn] : sel === '[aria-expanded="false"]' ? [expander] : []) } });
    const details = { open: false, tagName: 'DETAILS' };
    const expander = el('BUTTON', { 'aria-expanded': 'false' }, [text('Folder')], { click: () => clicks.push('expander') });
    const moreInFrame = el('BUTTON', {}, [text('Load more files')], { click: () => clicks.push('more') });
    const navMore = el('A', { href: '/next' }, [text('Show more')], { click: () => clicks.push('nav') });
    const tabInHost = el('BUTTON', { role: 'tab', 'aria-selected': 'false' }, [text('Archive tab')]);
    return { all: [frame, host], find: { '#f': frame, '#host': host }, by: { '[role=tab]': [] }, extra: { tabInHost } };
  });
  assert.deepEqual(runOp(dom, { op: 'activate', rules: RULES, kind: 'download', path: '#f >>> #inner', label: 'Download' }), { ok: true });
  assert.deepEqual(runOp(dom, { op: 'activate', rules: RULES, kind: 'download', path: '#host >>> #sh', label: 'Download' }), { ok: true });
  assert.match(runOp(dom, { op: 'activate', rules: RULES, kind: 'download', path: '#f >>> #nope' }).why, /gone/);
  assert.match(runOp(dom, { op: 'activate', rules: RULES, kind: 'download', path: '#nohost >>> #sh' }).why, /gone/);
  assert.deepEqual(dom.clicks, ['inner', 'sh']);
  const expanded = runOp(dom, { op: 'expand', rules: RULES });
  assert.deepEqual([expanded.opened, expanded.expanded, expanded.popups, expanded.blocked, expanded.cut, expanded.label], [1, 1, [], 0, false, 'Folder'], 'the closed <details> of the iframe and the expander of the shadow root');
  assert.deepEqual(dom.clicks.slice(2), ['expander'], 'pressed once: a second look does not press it again');
  const controls = runOp(dom, { op: 'controls', rules: RULES });
  assert.deepEqual(controls.more.map((m) => m.label), ['Load more files'], 'the wider label is a button; "Show more" that links to /next is not pressed');
  assert.equal(controls.pager.found, false);
  const scrolled = runOp(dom, { op: 'scroll', rules: RULES });
  assert.deepEqual([scrolled.moved, scrolled.atBottom], [true, false], 'the iframe scrolls too, and is not at its bottom');
});

test('pageOps expand: looks again after every press (a tree that draws itself anew has new nodes), presses the ROW of a tree item, never presses a form button, and says what it left (a menu opener that may hold files, a form button)', () => {
  const { RULES } = require('../backend/links/page.cjs');
  const open = new Set();
  const dom = opsDom(({ el, text, clicks }) => {
    const folder = (i) => el('BUTTON', { 'aria-expanded': 'false' }, [text(`Folder ${i}`)], { click: () => { open.add(i); clicks.push(`f${i}`); } });
    const row = el('DIV', { class: 'row' }, [text('Folder tree')], { click: () => clicks.push('row'), children: [], querySelector: () => null });
    const group = el('UL', { role: 'group' }, [], { children: [] });
    const treeItem = el('LI', { role: 'treeitem', 'aria-expanded': 'false' }, [row, group], { click: () => clicks.push('li'), children: [row, group] });
    const formButton = el('BUTTON', { 'aria-expanded': 'false', type: 'submit' }, [text('Archive')], { form: {}, click: () => clicks.push('form') });
    const menu = el('BUTTON', { 'aria-expanded': 'false', 'aria-haspopup': 'dialog' }, [text('Attachments (4)')], { click: () => clicks.push('menu') });
    const plainMenu = el('BUTTON', { 'aria-expanded': 'false', 'aria-haspopup': 'menu' }, [text('Sort')], { click: () => clicks.push('sort') });
    const by = new Proxy({}, { get: (_, sel) => (sel === '[aria-expanded="false"]' ? [...[0, 1, 2].filter((i) => !open.has(i)).map(folder), treeItem, formButton, menu, plainMenu] : sel === 'details:not([open])' ? [] : []) });
    return { by };
  });
  const out = runOp(dom, { op: 'expand', rules: RULES });
  assert.deepEqual(dom.clicks, ['f0', 'f1', 'f2', 'row'], 'all three folders in ONE call (a fresh look after each press), and the row of the tree item, not the item');
  assert.deepEqual([out.opened, out.expanded, out.popups, out.blocked, out.cut], [0, 4, ['Attachments (4)'], 1, false]);
  const skipped = runOp(dom, { op: 'expand', rules: RULES, skip: ['nothing'], one: true });
  assert.equal(skipped.expanded, 0);
  assert.deepEqual(runOp(dom, { op: 'expand', rules: RULES }).expanded, 0, 'the tree item, the form button and the menus are tried once per node, and the folders are all open');
});
test('pageOps scroll: reports whether every scrollable box is at its bottom and how tall the boxes are; probe measures without moving; reset goes back to the top', () => {
  const { RULES } = require('../backend/links/page.cjs');
  const box = { _t: 0, clientHeight: 800, scrollHeight: 3000, get scrollTop() { return this._t; }, set scrollTop(v) { this._t = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); } };
  const sandbox = { document: { nodeType: 9, querySelectorAll: () => [], querySelector: () => null, scrollingElement: box }, window: { innerHeight: 800 }, performance: { now: () => 0 }, getComputedStyle: () => ({ overflowY: 'visible' }), CSS: { escape: (x) => x } };
  const op = (arg) => JSON.parse(JSON.stringify(vm.runInNewContext(`(${require('../backend/links/page.cjs').pageOps.toString()})(${JSON.stringify({ op: 'scroll', rules: RULES, ...arg })})`, sandbox)));
  const seen = [];
  for (let i = 0; i < 5; i += 1) seen.push(op({}));
  assert.deepEqual(seen.map((r) => [r.moved, r.atBottom]), [[true, false], [true, false], [true, false], [true, true], [false, true]], 'it keeps moving until the bottom, then does not');
  assert.equal(seen[0].height, 3000);
  assert.deepEqual(op({ probe: true }), { moved: false, atBottom: true, height: 3000 });
  assert.equal(op({ reset: true }).moved, false);
  assert.equal(box.scrollTop, 0);
  assert.deepEqual(op({ probe: true }), { moved: false, atBottom: false, height: 3000 }, 'back at the top: not at the bottom');
});
test('pageOps controls: tabs and "Load more" with their caps, a pager made of numbers and Next (the current page found), a Next that is alone is just a "more" button, a "Next" in a form is not a pager, a menu opener that may hold files is told', () => {
  const { RULES } = require('../backend/links/page.cjs');
  const build = (withForm) => opsDom(({ el, text }) => {
    const nav = el('NAV', { 'aria-label': 'Pagination' }, [], {});
    const num = (n, extra = {}) => el('BUTTON', { id: `p${n}`, ...extra }, [text(String(n))], { closest: (sel) => (/^nav,/.test(sel) ? nav : null) });
    const next = el('BUTTON', { id: 'next', 'aria-label': 'Next page' }, [text('Next')], { closest: (sel) => (/^nav,/.test(sel) ? nav : null) });
    const alone = el('BUTTON', { id: 'alone' }, [text('Next')], { closest: (sel) => (withForm && /^nav,/.test(sel) ? form : null) });
    const form = el('FORM', {}, [alone], { closest: () => null });
    const more = el('BUTTON', { id: 'more' }, [text('Load more')], { closest: () => null });
    const view = el('BUTTON', { id: 'viewall' }, [text('View all (12)')], { closest: () => null });
    const showAll = el('BUTTON', { id: 'showall' }, [text('Show all files')], { closest: () => null });
    const clearAll = el('BUTTON', { id: 'clear' }, [text('Show all files and clear')], { closest: () => null });
    const popup = el('BUTTON', { id: 'popup', 'aria-haspopup': 'dialog' }, [text('Attachments (4)')], { closest: () => null });
    const tabs = Array.from({ length: 55 }, (_, i) => el('BUTTON', { role: 'tab', 'aria-selected': String(i === 0) }, [text(`Tab ${i}`)]));
    const all = [num(1), num(2, { 'aria-current': 'page' }), num(3), next, alone, more, view, showAll, clearAll, popup];
    return { by: { '[role=tab]': tabs, 'button,a,[role=button],[role=link],input[type=button]': all }, find: {} };
  });
  const out = runOp(build(false), { op: 'controls', rules: RULES, caps: { tabs: 50, more: 50 } });
  assert.deepEqual([out.tabs.length, out.cut.tabs], [50, 5], 'tabs past the cap are counted');
  assert.deepEqual(out.more.map((m) => m.label), ['Next', 'Load more', 'View all (12)'], 'the pager buttons are not "more"; a lone Next is');
  assert.equal(out.pager.found, true);
  assert.deepEqual([out.pager.next.label, out.pager.next.disabled, out.pager.current, out.pager.nums.map((n) => n.n)], ['Next', false, 2, [1, 2, 3]]);
  assert.deepEqual(out.popups, ['Attachments (4)']);
  assert.ok(!out.more.some((m) => /files/.test(m.label)), 'the show-all-files control and anything with an action word is not a "more" button');
  const capped = runOp(build(false), { op: 'controls', rules: RULES, caps: { tabs: 50, more: 2 } });
  assert.deepEqual([capped.more.length, capped.cut.more], [2, 1]);
  const { pagerSteps } = require('../backend/links/page.cjs');
  assert.deepEqual(pagerSteps(out.pager).map((s) => [s.how, s.label]), [['next', 'Next'], ['number', '3']]);
});
test('write guard: reads go on, a POST that is a data query goes on, every other request is failed before it leaves the browser; guards nest and the Fetch domain is off when the last one stops; a body is read only to tell a query from a change', async () => {
  const { guardWrites, isReadQuery } = require('../backend/links/gate.cjs');
  assert.equal(isReadQuery('{"query":"query Files($t: String) { files(tab: $t) { name } }","variables":{"t":"a"}}'), true);
  assert.equal(isReadQuery('[{"query":"{ files { name } }"},{"query":"# comment\\nquery A { x }"}]'), true, 'a batch of queries');
  assert.equal(isReadQuery('query { files { name } }'), true, 'the raw text of a query');
  for (const bad of ['{"query":"mutation Vote { vote(id: 1) { ok } }"}', '[{"query":"{ a }"},{"query":"mutation { b }"}]', '{"points":3}', '', 'a=1&b=2', '{"extensions":{"persistedQuery":{"sha256Hash":"x"}}}', '{"query":"{ a }","operationName":"mutation"}', '{"query":"subscription { a }"}', '{"query":5}', 'null', '[]', '{"query":"update { a }"}']) assert.equal(isReadQuery(bad), false, bad);
  assert.equal(isReadQuery('x'.repeat(300000)), false);
  const sent = []; let paused;
  const tab = { s: { on: (method, handler) => { paused = handler; return () => { paused = null; }; }, send: async (method, params) => { sent.push([method, params && params.requestId]); return {}; } } };
  const blocked = [];
  const outer = await guardWrites(tab, { onBlocked: (b) => blocked.push(['outer', b.method]) });
  const inner = await guardWrites(tab, { onBlocked: (b) => blocked.push(['inner', b.method]) });
  assert.equal(sent.filter(([m]) => m === 'Fetch.enable').length, 1, 'one Fetch.enable for both');
  const ask = (requestId, method, postData, extra = {}) => paused({ requestId, request: { method, postData, ...extra } });
  await ask('g', 'GET'); await ask('h', 'HEAD'); await ask('o', 'OPTIONS');
  await ask('q', 'POST', '{"query":"query { files { name } }"}');
  await ask('m', 'POST', '{"query":"mutation { vote }"}');
  await ask('p', 'PUT', '{"points":3}'); await ask('d', 'DELETE'); await ask('x', 'PATCH', '{}'); await ask('e', 'POST', undefined);
  await ask('b', 'POST', undefined, { postDataEntries: [{ bytes: Buffer.from('{"query":"query { a }"}').toString('base64') }] });   /* Chrome sends a small body as entries */
  await ask('c', 'POST', undefined, { postDataEntries: [{ bytes: Buffer.from('{"query":"mutation { a }"}').toString('base64') }] });
  await ask('f', 'POST', undefined, { postDataEntries: [{ file: '/tmp/x' }] });
  assert.deepEqual(sent.filter(([m]) => m === 'Fetch.continueRequest').map(([, id]) => id), ['g', 'h', 'o', 'q', 'b']);
  assert.deepEqual(sent.filter(([m]) => m === 'Fetch.failRequest').map(([, id]) => id), ['m', 'p', 'd', 'x', 'e', 'c', 'f']);
  assert.deepEqual(blocked.map(([who, method]) => `${who}:${method}`), ['inner:POST', 'inner:PUT', 'inner:DELETE', 'inner:PATCH', 'inner:POST', 'inner:POST', 'inner:POST'], 'the newest guard is told');
  await inner.stop();
  assert.ok(paused, 'the outer guard is still on');
  await ask('p2', 'PUT');
  assert.equal(blocked[blocked.length - 1][0], 'outer');
  await outer.stop();
  assert.equal(paused, null);
  assert.equal(sent.filter(([m]) => m === 'Fetch.disable').length, 1, 'off when the last one stops');
  assert.ok(!JSON.stringify(sent).includes('mutation'), 'nothing of a body is passed on');
  await outer.stop();
  assert.deepEqual(await (await guardWrites({}, {})).stop(), undefined, 'a tab without a session: nothing to guard');
});
test('discover: every press is guarded - a tab, "Load more", a pager, an expander; the control the page tried to save something with is told, is not pressed again, and its tab is not read; a tab that is a link must pass the address tests', async () => {
  const D = require('../backend/links/discover.cjs');
  const guardedTab = (script) => {
    const base = scriptedTab(script);
    let paused = null; const sent = [];
    base.tab.s = { on: (m, h) => { paused = h; return () => { paused = null; }; }, send: async (m, p) => { sent.push([m, p && p.requestId]); return {}; } };
    base.write = (method = 'PATCH', body = '{}') => paused && paused({ requestId: `r${sent.length}`, request: { method, postData: body } });
    base.sent = sent; base.isOn = () => Boolean(paused);
    return base;
  };
  /* a status picker made of tabs: pressing "In progress" PATCHes; pressing "Reference" is only a view */
  const st = { cur: 'Files' };
  const picker = guardedTab({
    snapshot: () => fileSnap(...(st.cur === 'Files' ? ['f1'] : st.cur === 'Reference' ? ['r1', 'r2'] : ['p1'])),
    op: (arg) => {
      if (arg.op === 'where') return { href: 'https://x.example/t' };
      if (arg.op === 'controls') return { tabs: ['Files', 'In progress', 'Reference'].map((l) => ({ label: l, path: `tab-${l}`, selected: st.cur === l, href: null })), more: [], pager: NOPAGER };
      if (arg.op === 'activate') { assert.ok(picker.isOn(), 'the guard is on while the press happens'); st.cur = arg.path.slice(4); if (st.cur === 'In progress') picker.write('PATCH', '{"status":"In progress"}'); return { ok: true }; }
      return IDLE;
    },
  });
  const ctx = D.newCtx();
  const said = [];
  const snaps = [fileSnap('f1')];
  const did = await D.gather(picker.tab, snaps, { ctx: { ...ctx, say: (t) => said.push(t) } });
  assert.ok(did.capped.includes("The page tried to save a change when 'In progress' was pressed; it was blocked"), did.capped.join(' | '));
  assert.ok(ctx.banned.has('tab|tab-In progress|In progress') && !ctx.banned.has('tab|tab-Reference|Reference'));
  assert.deepEqual(discover.unionCandidates(snaps.map(fileCandidates)).map((c) => c.label).sort(), ['f1', 'r1', 'r2'], 'the tab that tried to save is not read, the other one is');
  assert.equal(picker.isOn(), false, 'and the guard is off again');
  assert.deepEqual(picker.sent.filter(([m]) => m === 'Fetch.failRequest').length, 1);
  const again = await D.replay(picker.tab, { tab: { label: 'In progress', path: 'tab-In progress' }, more: 0, scroll: 0 }, null, { ctx });
  assert.equal(again.ok, false);
  assert.match(again.why, /not pressed again: the page tried to save a change/);
  /* a lone Next that saves a wizard step: pressed once (it is a "more" button), blocked, never again */
  const wiz = guardedTab({
    snapshot: () => fileSnap('w'),
    op: (arg) => {
      if (arg.op === 'controls') return { tabs: [], more: [{ label: 'Next', path: 'next' }], pager: NOPAGER };
      if (arg.op === 'activate') { wiz.write('PUT', '{"saved":true}'); return { ok: true }; }
      return IDLE;
    },
  });
  const wd = await D.gather(wiz.tab, [fileSnap('w')], {});
  assert.equal(wiz.log.filter((a) => a.op === 'activate').length, 1, 'pressed once');
  assert.ok(wd.capped.includes("The page tried to save a change when 'Next' was pressed; it was blocked"));
  /* a pager button that saves: blocked and not pressed again (the pager is not followed any further) */
  const pg = guardedTab({
    snapshot: () => fileSnap('g'),
    op: (arg) => {
      if (arg.op === 'where') return { href: 'https://x.example/t' };
      if (arg.op === 'controls') return { tabs: [], more: [], pager: { found: true, hinted: true, next: { label: 'Next', path: 'pn', href: null, disabled: false }, prev: null, nums: [], current: null } };
      if (arg.op === 'activate') { pg.write('POST', 'a=1'); return { ok: true }; }
      return IDLE;
    },
  });
  const pd = await D.gather(pg.tab, [fileSnap('g')], {});
  assert.equal(pg.log.filter((a) => a.op === 'activate').length, 1);
  assert.ok(pd.capped.some((t) => /The page tried to save a change when 'Next' was pressed/.test(t)));
  /* an expander that saves: pressed, blocked, skipped from then on */
  let presses = 0;
  const ex = guardedTab({
    snapshot: () => fileSnap('e'),
    op: (arg) => {
      if (arg.op === 'expand') { if (presses >= 1 && !(arg.skip || []).includes('exp-1')) { presses += 1; ex.write('DELETE'); return { opened: 0, expanded: 1, label: 'Folder', path: 'exp-1', popups: [], blocked: 0, cut: false }; } if (presses === 0) { presses = 1; ex.write('DELETE'); return { opened: 0, expanded: 1, label: 'Folder', path: 'exp-1', popups: [], blocked: 0, cut: false }; } return { opened: 0, expanded: 0, popups: [], blocked: 0, cut: false }; }
      return IDLE;
    },
  });
  const exctx = D.newCtx();
  const exSaid = [];
  const total = await D.expandAll(ex.tab, [], { snapshots: false, ctx: { ...exctx, say: (t) => exSaid.push(t) } });
  assert.deepEqual(exSaid, ["The page tried to save a change when 'Folder' was pressed; it was blocked"]);
  assert.deepEqual([...exctx.skip], ['exp-1']);
  assert.equal(total.expanded >= 1, true);
  assert.equal(presses, 1, 'and it was not pressed in the next pass');
  /* a tab that is a link: an action word in the address, another site, or an address that cannot be read is not followed */
  const links = guardedTab({
    snapshot: () => fileSnap('l'),
    op: (arg) => {
      if (arg.op === 'where') return { href: 'https://x.example/t' };
      if (arg.op === 'controls') return { tabs: [{ label: 'Files', path: 'a', selected: true, href: 'https://x.example/t' }, { label: 'Trash', path: 'b', selected: false, href: 'https://x.example/projects/7/trash' }, { label: 'Sharing', path: 'c', selected: false, href: 'https://x.example/projects/7/share' }, { label: 'Other', path: 'd', selected: false, href: 'https://evil.example/t' }, { label: 'View', path: 'e', selected: false, href: 'https://x.example/t/view' }], more: [], pager: NOPAGER };
      if (arg.op === 'activate') return { ok: true };
      return IDLE;
    },
  });
  const ld = await D.gather(links.tab, [fileSnap('l')], {});
  assert.deepEqual(links.log.filter((a) => a.op === 'activate' && a.kind === 'tab').map((a) => [a.path, a.href]).slice(0, 1), [['e', 'https://x.example/t/view']], 'only the harmless address is pressed, and its address goes with the press');
  const said2 = ld.capped.join(' | ');
  assert.match(said2, /the tab "Trash" is a link to an address the loader does not open \(the path has the action word "trash"\)/);
  assert.match(said2, /the tab "Sharing" is a link to an address the loader does not open \(the path has the action word "share"\)/);
  assert.match(said2, /the tab "Other" is a link to an address the loader does not open \(another site\)/);
});
test('pageOps controls: a pager needs a navigation (nav, role=navigation, or a box that says pagination) or links that stay on this list; a row of digits (points, stages) or arrows elsewhere is not one; "+1" is not "Load more"', () => {
  const { RULES } = require('../backend/links/page.cjs');
  const sel = 'button,a,[role=button],[role=link],input[type=button]';
  const ctl = (build, location) => { const dom = opsDom(build); if (location) { dom.sandbox.location = { href: location }; dom.sandbox.URL = URL; } return runOp(dom, { op: 'controls', rules: RULES, caps: { tabs: 50, more: 50 } }); };
  const points = ctl(({ el, text }) => { const ul = el('UL', { class: 'points' }, [], {}); const b = (n) => el('BUTTON', {}, [text(String(n))], { closest: (q) => (/^ul,ol$/.test(q) ? ul : null) }); return { by: { [sel]: [1, 2, 3, 5, 8].map(b) } }; });
  assert.deepEqual([points.pager.found, points.more.length], [false, 0], 'estimate points are not pages');
  const arrows = ctl(({ el, text }) => { const mk = (t, a) => el('BUTTON', { 'aria-label': a }, [text(t)], { closest: () => null }); return { by: { [sel]: [mk('\u2190', 'Move to previous stage'), mk('\u2192', 'Move to next stage')] } }; });
  assert.deepEqual([arrows.pager.found, arrows.more.length], [false, 0], 'stage arrows are not a pager and not "Load more"');
  const plus = ctl(({ el, text }) => ({ by: { [sel]: [el('BUTTON', {}, [text('+1')], { closest: () => null }), el('BUTTON', {}, [text('+5 more')], { closest: () => null }), el('BUTTON', {}, [text('Get more')], { closest: () => null })] } }));
  assert.deepEqual(plus.more.map((m) => m.label), ['+5 more'], '"+1" and "Get more" are not "Load more"; "+5 more" is');
  const numbered = (hrefs) => ({ el, text }) => { const links = hrefs.map((h, i) => el('A', { href: h }, [text(String(i + 1))], { href: h, closest: () => null })); el('DIV', {}, links); return { by: { [sel]: links } }; };
  assert.equal(ctl(numbered(['https://x.test/t?page=1', 'https://x.test/t?page=2', 'https://x.test/t?page=3']), 'https://x.test/t').pager.found, true, 'links that change only the page parameter of this list are a pager even outside a nav');
  assert.equal(ctl(numbered(['https://x.test/projects/1', 'https://x.test/projects/2', 'https://x.test/projects/3']), 'https://x.test/t').pager.found, false, 'numbered links to other pages of the site are not a pager');
  assert.equal(ctl(numbered(['https://x.test/t?page=1', 'https://x.test/t?page=2']), 'https://x.test/t').pager.nums.map((n) => n.href).every(Boolean), true);
});
test('extractPage: a switch, checkbox, tab, button or choice that saves something when it is flipped is marked unsafe - it is in a form that is not GET, or its onchange/onclick mentions submit or form - and so is a list whose options are not all views of the files', () => {
  const { extractPage, pageArgs, findAllFilesToggle } = require('../backend/links/page.cjs');
  const { doc, el, text, flat } = tinyDom();
  const post = { getAttribute: (n) => (n === 'method' ? 'post' : null) };
  const get = { getAttribute: (n) => (n === 'method' ? 'get' : null) };
  const option = (label, selected) => ({ textContent: label, selected, disabled: false });
  const box = (label, extra = {}, attrs = {}) => el('INPUT', { type: 'checkbox', ...attrs }, [], { type: 'checkbox', checked: false, labels: [el('LABEL', {}, [text(label)])], ...extra });
  const body = el('BODY', {}, [
    box('Show all files', { form: post }), box('Show all files', { form: null }, { onchange: 'this.form.submit()' }), box('Show all files', { form: get }), box('Show all files'),
    el('SELECT', { id: 'views' }, [], { type: 'select-one', options: [option('Added files', true), option('All files', false)], selectedOptions: [], value: 'a' }),
    el('SELECT', { id: 'perm' }, [], { type: 'select-one', options: [option('No access', true), option('Can view all files', false), option('Can edit', false)], selectedOptions: [], value: 'a' }),
    el('SELECT', { id: 'mixed' }, [], { type: 'select-one', options: [option('Added files', true), option('Show all files', false), option('Mark all files as reviewed', false)], selectedOptions: [], value: 'a' }),
    el('BUTTON', { 'aria-pressed': 'false', onclick: 'form.submit()' }, [text('Show all files')]),
  ]);
  Object.assign(doc, { body, documentElement: body, title: 'T', readyState: 'complete', querySelectorAll: (q) => (q === '*' ? flat(body) : []), querySelector: () => null });
  const out = JSON.parse(JSON.stringify(vm.runInNewContext(`(${extractPage.toString()})(${JSON.stringify(pageArgs())})`, { document: doc, location: { href: 'https://tasks.atlas.example/t/1', origin: 'https://tasks.atlas.example' }, performance: { now: () => 0 }, CSS: { escape: (x) => x }, URL, URLSearchParams })));
  assert.deepEqual(out.toggles.filter((t) => t.kind === 'checkbox').map((t) => Boolean(t.unsafe)), [true, true, false, false], 'a POST form, a script that submits; a GET form and a free-standing box are fine');
  assert.deepEqual(out.toggles.filter((t) => t.kind === 'option').map((t) => [t.label, Boolean(t.unsafe)]), [['Added files', false], ['All files', false], ['No access', true], ['Can view all files', true], ['Can edit', true], ['Added files', true], ['Show all files', true], ['Mark all files as reviewed', true]], 'a list of views is fine; a list with a permission or an action in it is not the control');
  assert.equal(out.toggles.find((t) => t.kind === 'pressed').unsafe, true);
  assert.equal(findAllFilesToggle(out.toggles, null).path, out.toggles[2].path, 'the first control that is safe and says so: the one in the GET form');
  assert.equal(findAllFilesToggle(out.toggles.filter((t) => t.unsafe), null), null, 'when only unsafe ones are left there is none');
});
test('pager steps and links: Next first when it is enabled, then the numbers after the current page; a link is followed only when it changes nothing but a page parameter on the same path', () => {
  const { pagerSteps, pageLinkOk } = require('../backend/links/page.cjs');
  const num = (n, extra = {}) => ({ n, label: String(n), path: `n${n}`, href: null, current: false, disabled: false, ...extra });
  assert.deepEqual(pagerSteps(null), []);
  assert.deepEqual(pagerSteps({ found: false }), []);
  assert.deepEqual(pagerSteps({ found: true, next: { label: 'Next', path: 'x', disabled: true }, nums: [num(1), num(2, { current: true })], current: 2 }), [], 'the last page');
  assert.deepEqual(pagerSteps({ found: true, next: null, nums: [num(1), num(2, { current: true }), num(3), num(4)], current: 2 }).map((s) => s.n), [3, 4]);
  assert.deepEqual(pagerSteps({ found: true, next: null, nums: [num(1), num(2)], current: null }), [], 'no idea which page is open: no step');
  assert.equal(pageLinkOk('https://x.test/t?page=2', 'https://x.test/t'), true);
  assert.equal(pageLinkOk('https://x.test/t?page=3&q=a', 'https://x.test/t?page=2&q=a'), true);
  assert.equal(pageLinkOk('https://x.test/t?offset=50#top', 'https://x.test/t'), true);
  assert.equal(pageLinkOk('https://x.test/t?page=2&sort=name', 'https://x.test/t'), false, 'another parameter');
  assert.equal(pageLinkOk('https://x.test/other?page=2', 'https://x.test/t'), false, 'another path');
  assert.equal(pageLinkOk('https://evil.test/t?page=2', 'https://x.test/t'), false, 'another site');
  assert.equal(pageLinkOk('javascript:alert(1)', 'https://x.test/t'), false);
  assert.equal(pageLinkOk('not a url', 'https://x.test/t'), false);
});
test('extractPage: what it could not use is reported - hidden file links and buttons (a closed dialog), frames of another site, and every cut (links, buttons, elements); names of a control; the name cell of a row; a control that belongs to a form or runs a script that sends', () => {
  const { extractPage, pageArgs, LIMITS } = require('../backend/links/page.cjs');
  const { doc, el, text, flat } = tinyDom();
  const abs = (href) => `https://tasks.atlas.example${href}`;
  const link = (t, href, extra = {}) => el('A', { href }, [text(t)], { href: abs(href), ...extra });
  const row = (name, ...cells) => { const b = el('BUTTON', {}, [text('Download')], { closest: (sel) => (/tr,li/.test(sel) ? { innerText: [name, ...cells, 'Download'].join('\t'), textContent: [name, ...cells, 'Download'].join(' ') } : null) }); return b; };
  const frame = (src, rect) => el('IFRAME', { src }, [], { contentDocument: null, getBoundingClientRect: () => rect });
  const body = el('BODY', {}, [
    el('H2', {}, [text('Files')]),
    link('Shown.txt', '/f/Shown.txt'), link('Hidden.txt', '/f/Hidden.txt', { checkVisibility: () => false }),
    el('BUTTON', {}, [text('Download Hidden2.txt')], { checkVisibility: () => false }),
    row('Variance Bridge', 'Processing 45%', '12 downloads', 'Ready'),
    el('BUTTON', { onclick: "document.forms[0].submit()" }, [text('Download')], { form: null }), el('BUTTON', { 'aria-label': 'Download', title: 'Remove this file' }, []), el('BUTTON', { onclick: 'save(1)' }, [text('Download')], { form: null }),
    frame('http://other.example/files', { width: 400, height: 200 }), frame('http://other.example/tiny', { width: 1, height: 1 }), frame('about:blank', { width: 400, height: 200 }), frame('https://www.google.com/recaptcha/api2/anchor', { width: 400, height: 200 }),
  ]);
  Object.assign(doc, { body, documentElement: body, title: 'T', readyState: 'complete', querySelectorAll: (sel) => (sel === '*' ? flat(body) : []), querySelector: () => null });
  const run = (limits) => JSON.parse(JSON.stringify(vm.runInNewContext(`(${extractPage.toString()})(${JSON.stringify(pageArgs({ limits: { ...LIMITS, ...limits } }))})`, { document: doc, location: { href: abs('/t/1'), origin: abs('') }, performance: { now: () => 0 }, CSS: { escape: (x) => x }, URL, URLSearchParams })));
  const out = run({});
  assert.deepEqual(out.hidden.map((h) => [h.text, Boolean(h.button)]), [['Hidden.txt', false], ['Download Hidden2.txt', true]]);
  assert.equal(out.hidden[0].href, abs('/f/Hidden.txt'));
  assert.deepEqual(out.frames, { blocked: 1 }, 'one frame of another site that is big enough and is not a CAPTCHA, a blank page or a pixel');
  assert.deepEqual(out.links.map((l) => l.text), ['Shown.txt']);
  const byLabel = out.buttons.map((b) => [b.text, b.label, b.rowParts, b.scripted, b.names]);
  assert.deepEqual(byLabel[0], ['Download', 'Variance Bridge Processing 45% 12 downloads Ready', ['Variance Bridge'], false, ['Download']], 'the name cell is the only part that identifies the row; the cells that change are in the label only');
  assert.deepEqual(byLabel.slice(1).map((x) => [x[3], x[4]]), [[true, ['Download']], [false, ['Download', 'Remove this file']], [false, ['Download']]], 'a script that submits is marked; every name the control has is listed');
  assert.deepEqual(out.truncated, {});
  const small = run({ linksMax: 0, buttonsMax: 1 });
  assert.deepEqual([small.truncated.links, small.truncated.buttons, small.links.length, small.buttons.length], [true, true, 0, 1], 'what was cut is flagged');
  const few = run({ maxElements: 3 });
  assert.equal(few.truncated.elements, true);
});

/* ---------------------------------------------------------------- several looks at a page */
test('discover: sections merge by heading and line, candidates by address; a signature changes when the page does', () => {
  const a = [{ heading: 'Files', text: 'row 1\nrow 2' }, { heading: 'Notes', text: 'one' }, { heading: 'Files', text: 'second list' }];
  const b = [{ heading: 'Files', text: 'row 2\nrow 3' }, { heading: 'Notes', text: 'one' }, { heading: 'Files', text: 'second list\nmore' }, { heading: 'New', text: 'x' }];
  assert.deepEqual(discover.mergeSections([a, b]), [{ heading: 'Files', text: 'row 1\nrow 2\nrow 3' }, { heading: 'Notes', text: 'one' }, { heading: 'Files', text: 'second list\nmore' }, { heading: 'New', text: 'x' }]);
  assert.equal(discover.mergeSections([a, b], { sections: 2 }).length, 2);
  assert.equal(discover.mergeSections([[{ heading: 'H', text: 'x'.repeat(50) }]], { sectionChars: 10 })[0].text.length, 10);
  const c = (mode, href, path, text) => ({ mode, href, path, text });
  assert.deepEqual(discover.unionCandidates([[c('navigate', 'https://x.example/a'), c('click', null, 'b#1', 'B')], [c('navigate', 'https://x.example/a'), c('navigate', 'https://x.example/c'), c('click', null, 'b#1', 'B'), c('click', null, 'b#2', 'B')]]).map((x) => x.href || x.path), ['https://x.example/a', 'b#1', 'https://x.example/c', 'b#2']);
  const snap = { sections: [{ heading: 'H', text: 'text' }], links: [{ href: 'u' }], buttons: [{ path: 'p', text: 't' }], toggles: [{ label: 'L', checked: false, path: 'p' }] };
  assert.equal(discover.signature(snap), discover.signature(JSON.parse(JSON.stringify(snap))));
  for (const change of [(x) => { x.sections[0].text = 'texT'; }, (x) => { x.links.push({ href: 'v' }); }, (x) => { x.toggles[0].checked = true; }, (x) => { x.buttons[0].text = 'u'; }]) {
    const other = JSON.parse(JSON.stringify(snap)); change(other);
    assert.notEqual(discover.signature(other), discover.signature(snap));
  }
});

test('discover: a button is the same button when the heading above it changed between two looks (a switch added a section); two files with one name in two groups at once stay two', () => {
  const b = (group, label = 'Atlas_Blob.txt') => ({ mode: 'click', kind: 'button', text: label, label, nameHint: label, href: null, group, path: 'p', view: null });
  const merged = discover.unionCandidates([[b('Task files')], [b('World files')]]);
  assert.deepEqual(merged.map((c) => [c.label, c.group]), [['Atlas_Blob.txt', 'World files']], 'one button, under the heading it has now');
  const both = discover.unionCandidates([[b('Task files'), b('World files')]]);
  assert.equal(both.length, 2, 'both there at once: two files that share a name');
  const later = discover.unionCandidates([[b('Task files'), b('World files')], [b('Task files'), b('World files')]]);
  assert.equal(later.length, 2, 'and they stay two when seen again');
  const set = new discover.CandidateSet();
  assert.equal(set.add([b('A')]), 1);
  assert.equal(set.add([b('A'), b('A', 'Other.txt')]), 1, 'add() tells how many are new');
  assert.equal(set.size, 2);
});
test('discover: the tab is part of a candidate\'s identity (one name in two tabs is two files); a tab is the same tab when its count changes; rows that look different but were merged are counted', () => {
  const b = (tab, label, extra = {}) => ({ mode: 'click', kind: 'button', text: 'Download', label, nameHint: extra.nameHint || label, href: null, group: 'Files', path: 'p', view: tab ? { tab: { label: tab, path: 't' }, more: 0, scroll: 0 } : null });
  const two = discover.unionCandidates([[b('Task', 'Data.csv')], [b('Reference', 'Data.csv')], [b('Reference (3)', 'Notes.txt')], [b('Reference (9)', 'Notes.txt')]]);
  assert.deepEqual(two.map((c) => [c.view.tab.label, c.label]), [['Task', 'Data.csv'], ['Reference', 'Data.csv'], ['Reference (3)', 'Notes.txt']], 'a count in a tab name does not make a new tab');
  assert.equal(discover.tabKey('Reference (12) 3'), 'Reference (#) #');
  const ok = discover.unionWithCheck([[b(null, 'Entity 01 Budget.txt 1 KB'), b(null, 'Entity 02 Budget.txt 2 KB')]]);
  assert.deepEqual([ok.list.length, ok.merged], [2, 0]);
  const volatile = discover.unionWithCheck([[b(null, 'report.xlsx 12 KB Updated 3 minutes ago', { nameHint: 'report.xlsx' })], [b(null, 'report.xlsx 12 KB Updated 4 minutes ago', { nameHint: 'report.xlsx' })]]);
  assert.deepEqual([volatile.list.length, volatile.merged], [1, 0], 'text after the name that changes is the same row');
  const collapsed = discover.unionWithCheck([[b(null, 'Entity 01 Budget.txt', { nameHint: 'Budget.txt' }), b(null, 'Entity 02 Budget.txt', { nameHint: 'Budget.txt' })]]);
  assert.deepEqual([collapsed.list.length, collapsed.merged], [2, 0], 'two rows with one name phrase are two candidates (the k-th occurrence)');
  const across = discover.unionWithCheck([[b(null, 'Entity 01 Budget.txt', { nameHint: 'Budget.txt' })], [b(null, 'Entity 02 Budget.txt', { nameHint: 'Budget.txt' })]]);
  assert.deepEqual([across.list.length, across.merged], [1, 1], 'seen in two looks they merge; the check says one row was swallowed');
});
test('downloads: the same file listed twice (same name, same bytes) is kept once and said so; the same name with other bytes is another file', async () => {
  const m = manager({ gapMs: 0 });
  const stage = (guid, body) => { fs.writeFileSync(path.join(m.dm.stageDir, guid), body); };
  const finish = async (guid, body, name) => {
    stage(guid, body);
    const j = job({ guid, suggested: name, contentType: 'text/plain', completed: { filePath: path.join(m.dm.stageDir, guid) }, totalBytes: body.length, candidate: { nameHint: name, label: name } });
    const result = {};
    await m.dm.finalize(j, result);
    return result;
  };
  const a = await finish('g1', 'same bytes', 'Data.csv');
  const b = await finish('g2', 'same bytes', 'Data.csv');
  const c = await finish('g3', 'other bytes', 'Data.csv');
  assert.deepEqual([a.name, a.duplicate], ['Data.csv', undefined]);
  assert.deepEqual([b.state, b.name, b.duplicate], ['done', 'Data.csv', true]);
  assert.deepEqual([c.name, c.duplicate], ['Data (2).csv', undefined]);
  assert.deepEqual(fs.readdirSync(m.dm.destDir).sort(), ['Data (2).csv', 'Data.csv']);
  assert.equal(fs.readdirSync(m.dm.stageDir).length, 0, 'the duplicate is removed from the stage folder');
});
test('waitForSettled: a request that answered and sends nothing (a beacon) or never answers (a long poll) is idle and never makes the page unsettled; a slow answer is waited for; other things stuck still do', async () => {
  const { waitForSettled } = require('../backend/links/tab.cjs');
  const fake = (entries) => ({ net: { inflight: new Map(entries), quiet: new Set(), lastActivityAt: 0 }, evalIsolated: async () => ({ readyState: 'complete', quiet: 99999, count: 0 }) });
  const ago = (ms) => Date.now() - ms;
  const beacon = fake([['b', { type: 'Fetch', startedAt: ago(4000), responded: true, lastDataAt: ago(4000) }]]);
  assert.deepEqual((({ settled }) => ({ settled }))(await waitForSettled(beacon, { maxMs: 3000 })), { settled: true }, 'answered, no data for 4 s: idle');
  assert.ok(beacon.net.quiet.has('b'), 'and remembered as idle');
  const streaming = fake([['s', { type: 'Fetch', startedAt: ago(9000), responded: true, lastDataAt: Date.now() }]]);
  streaming.net.inflight.get('s').lastDataAt = Date.now();
  const t0 = Date.now();
  setTimeout(() => { streaming.net.inflight.get('s').lastDataAt = ago(5000); }, 250);
  assert.equal((await waitForSettled(streaming, { maxMs: 3000, pollMs: 20 })).settled, true);
  assert.ok(Date.now() - t0 >= 240, 'a response that is still sending data is waited for');
  const slow = fake([['a', { type: 'Fetch', startedAt: ago(1000), responded: false, lastDataAt: ago(1000) }]]);
  setTimeout(() => slow.net.inflight.delete('a'), 300);
  const waitedFor = Date.now();
  assert.equal((await waitForSettled(slow, { maxMs: 3000, pollMs: 20 })).settled, true);
  assert.ok(Date.now() - waitedFor >= 280, 'an API that has not answered yet is waited for (up to stalledApiMs)');
  const poll = fake([['p', { type: 'Fetch', startedAt: ago(1000), responded: false, lastDataAt: ago(1000) }]]);
  const r = await waitForSettled(poll, { maxMs: 400, pollMs: 20 });
  assert.deepEqual([r.settled, r.apiPending], [true, 1], 'at the deadline a request that never answered is not held against the page');
  assert.ok(poll.net.quiet.has('p'));
  const again = Date.now();
  assert.equal((await waitForSettled(poll, { maxMs: 400, pollMs: 20 })).settled, true);
  assert.ok(Date.now() - again < 200, 'the next settle does not wait for it again');
  const stuck = fake([['x', { type: 'Script', startedAt: ago(1000), responded: false, lastDataAt: ago(1000) }]]);
  assert.equal((await waitForSettled(stuck, { maxMs: 300, pollMs: 20, stalledMs: 5000 })).settled, false, 'a stuck script is a real unsettled page');
});

test('waitForSettled: not quiet before the grace after a click; patient for an API answer past maxMs; says how many requests that the step started were still waiting', async () => {
  const { waitForSettled } = require('../backend/links/tab.cjs');
  const fake = (entries = []) => ({ net: { inflight: new Map(entries), quiet: new Set(), lastActivityAt: 0 }, evalIsolated: async () => ({ readyState: 'complete', quiet: 99999, count: 0 }) });
  const t0 = Date.now();
  await waitForSettled(fake(), { maxMs: 2000, since: Date.now() - 50, graceMs: 250, pollMs: 20 });
  assert.ok(Date.now() - t0 >= 190, 'just after a click the request it started is not in the log yet');
  const quickRun = Date.now();
  await waitForSettled(fake(), { maxMs: 2000, pollMs: 20 });
  assert.ok(Date.now() - quickRun < 100, 'no click, no grace');
  const slow = fake([['a', { type: 'Fetch', startedAt: Date.now() - 50, responded: false, lastDataAt: Date.now() }]]);
  setTimeout(() => slow.net.inflight.delete('a'), 400);
  const t1 = Date.now();
  const r1 = await waitForSettled(slow, { maxMs: 100, patientMs: 3000, since: Date.now() - 100, pollMs: 20 });
  assert.equal(r1.settled, true);
  assert.ok(Date.now() - t1 >= 350, 'past maxMs it kept waiting for the answer');
  assert.ok(!r1.lost);
  const never = fake([['a', { type: 'Fetch', startedAt: Date.now() - 50, responded: false, lastDataAt: Date.now() }], ['old', { type: 'Fetch', startedAt: Date.now() - 5000, responded: false, lastDataAt: Date.now() - 5000 }]]);
  const r2 = await waitForSettled(never, { maxMs: 100, patientMs: 400, since: Date.now() - 100, pollMs: 20 });
  assert.deepEqual([r2.settled, r2.apiPending, r2.lost, r2.lostIds], [true, 2, 1, ['a']], 'two were waiting, one of them started by this step (and its id is told, to look at it again later)');
  const ticker = fake();
  ticker.evalIsolated = async () => ({ readyState: 'complete', quiet: 0, count: 1 });
  const t2 = Date.now();
  const r3 = await waitForSettled(ticker, { maxMs: 200, patientMs: 5000, pollMs: 20 });
  assert.equal(r3.settled, false);
  assert.ok(Date.now() - t2 < 600, 'a DOM that never goes quiet still ends at maxMs when no request is waiting');
});
function scriptedTab(script) {
  const { extractPage, pageOps } = require('../backend/links/page.cjs');
  const log = []; const snaps = [];
  const tab = {
    net: { inflight: new Map(), lastActivityAt: 0 },
    evalIsolated: async () => ({ readyState: 'complete', quiet: 99999, count: 0 }),
    evalFn: async (fn, arg) => {
      if (fn === extractPage) { const snap = script.snapshot(log.length); snaps.push(snap); return snap; }
      assert.equal(fn, pageOps);
      log.push(arg);
      return script.op(arg, log);
    },
  };
  return { tab, log, snaps };
}
const fileSnap = (...names) => ({ url: 'https://x.example/t', sections: [{ heading: 'Files', text: names.join('\n') }], links: names.map((n) => ({ text: n, href: `https://x.example/f/${n}.txt`, rawHref: `/f/${n}.txt`, scheme: 'https:', fileLike: true, nameHint: n, ext: 'txt', path: `a-${n}`, group: 'Files' })), buttons: [], toggles: [] });
/* what a page that has nothing to do answers to an op */
const IDLE = { opened: 0, expanded: 0, popups: [], blocked: 0, cut: false, moved: false, atBottom: true, height: 1000 };
const NOPAGER = { found: false, hinted: false, next: null, prev: null, nums: [], current: null };

test('discover stabilize: looks again after each wait and stops as soon as two looks in a row are the same', async () => {
  let n = 0;
  const { tab } = scriptedTab({ snapshot: () => { n += 1; return fileSnap(...['a', 'b', 'c'].slice(0, Math.min(n + 1, 3))); }, op: () => ({}) });
  const first = fileSnap('a');
  const t0 = Date.now();
  const snaps = await discover.stabilize(tab, first, { waits: [20, 20] });
  assert.equal(snaps.length, 3, 'the page was still growing at the second look, so there was a third');
  assert.ok(Date.now() - t0 >= 35);
  n = 5;
  const same = await discover.stabilize(tab, fileSnap('a', 'b', 'c'), { waits: [10, 10] });
  assert.equal(same.length, 2, 'identical to the first look: stop');
  await assert.rejects(discover.stabilize(tab, first, { waits: [5000], signal: AbortSignal.abort() }), (e) => e.code === 'CANCELLED');
});
test('discover gather: tabs one at a time (the open one is put back), "Load more" while it adds files, scrolling until the scroller is at its bottom and the page stopped growing, never past its steps; everything is a snapshot', async () => {
  let scrolls = 0; let more = 2;
  const script = {
    snapshot: (step) => fileSnap('home', ...Array.from({ length: Math.min(step, 4) }, (_, i) => `n${i}`)),
    op: (arg) => {
      if (arg.op === 'controls') return { tabs: [{ label: 'Files', path: 'tab1', selected: true }, { label: 'Other', path: 'tab2', selected: false }], more: more > 0 ? [{ label: 'Load more', path: 'more' }] : [], pager: NOPAGER, popups: [], cut: {}, blocked: 0 };
      if (arg.op === 'activate') { if (arg.path === 'more') more -= 1; return { ok: true }; }
      if (arg.op === 'scroll') { if (arg.reset) return { moved: false, atBottom: false, height: 0 }; if (arg.probe) return { moved: false, atBottom: scrolls >= 6, height: 1000 }; scrolls += 1; return { moved: scrolls <= 6, atBottom: scrolls >= 6, height: 1000 }; }
      return IDLE;
    },
  };
  const { tab, log } = scriptedTab(script);
  const snaps = [fileSnap('home')];
  const did = await discover.gather(tab, snaps, {});
  const activated = log.filter((a) => a.op === 'activate');
  assert.deepEqual(activated.map((a) => a.path), ['more', 'more', 'tab2', 'tab1'], 'Load more on the open tab until it is gone, then the other tab, then the first one again');
  assert.deepEqual(activated.map((a) => a.kind), ['more', 'more', 'tab', 'tab'], 'every press names its kind');
  assert.equal(did.tabs, 1);
  assert.equal(did.more, 2);
  assert.equal(did.scrolls, 6, 'it scrolled on until the scroller was at its bottom');
  assert.ok(log.some((a) => a.op === 'scroll' && a.reset), 'the page is scrolled back to the top');
  assert.ok(snaps.length > 4);
  assert.deepEqual(did.capped, []);
  const capped = scriptedTab({ snapshot: (step) => fileSnap('x', `s${step}`), op: (arg) => (arg.op === 'scroll' ? { moved: true, atBottom: false, height: 1000 } : arg.op === 'controls' ? { tabs: [], more: [], pager: NOPAGER } : IDLE) });
  const cappedDid = await discover.gather(capped.tab, [fileSnap('x')], { maxScroll: 5 });
  assert.equal(capped.log.filter((a) => a.op === 'scroll' && !a.reset && !a.probe).length <= 5, true);
  assert.match(cappedDid.capped.join(' '), /scrolling stopped at 5 steps before the end of the page, which may still have more files/, 'a limit that ended a step is told, not silent');
  const timed = scriptedTab({ snapshot: () => fileSnap('x'), op: (arg) => (arg.op === 'controls' ? { tabs: [{ label: 'A', path: 'a', selected: false }], more: [], pager: NOPAGER } : arg.op === 'activate' ? { ok: true } : IDLE) });
  await discover.gather(timed.tab, [fileSnap('x')], { budgetMs: -1, minPerTabMs: 5000 });
  assert.deepEqual(timed.log.filter((a) => a.op === 'activate').map((a) => a.path), ['a'], 'no time left, but every tab still gets its minimum');
});
test('discover gather: an infinite scroller is scrolled to its bottom even when the first steps add nothing (a chunk taller than two steps); a scroller that cannot move says so; a short page is left alone', async () => {
  /* 7 chunks of 3 steps: the sentinel at the end of a chunk loads the next one only when the scroller is at its bottom */
  const st = { top: 0, chunks: 1 };
  const STEP = 400; const CHUNK = 1000; const BOX = 400;
  const height = () => st.chunks * CHUNK;
  const atBottom = () => st.top + BOX >= height() - 2;
  const grow = () => { if (atBottom() && st.chunks < 7) st.chunks += 1; };
  const infinite = scriptedTab({
    snapshot: () => fileSnap(...Array.from({ length: st.chunks * 5 }, (_, i) => `i${i}`)),
    op: (arg) => {
      if (arg.op === 'controls') return { tabs: [], more: [], pager: NOPAGER };
      if (arg.op === 'scroll') {
        if (arg.reset) { st.top = 0; return { moved: false, atBottom: false, height: 0 }; }
        if (arg.probe) return { moved: false, atBottom: atBottom(), height: height() };
        const before = st.top; st.top = Math.min(st.top + STEP, height() - BOX); const out = { moved: st.top !== before, atBottom: atBottom(), height: height() }; grow(); return out;
      }
      return IDLE;
    },
  });
  const snaps = [fileSnap('i0')];
  const did = await discover.gather(infinite.tab, snaps, {});
  const all = discover.unionCandidates(snaps.map(fileCandidates));
  assert.equal(st.chunks, 7, 'every chunk was loaded');
  assert.equal(all.length, 35, 'and every file of it seen');
  assert.deepEqual(did.capped, []);
  const jammed = scriptedTab({ snapshot: () => fileSnap('x'), op: (arg) => (arg.op === 'controls' ? { tabs: [], more: [], pager: NOPAGER } : arg.op === 'scroll' ? { moved: false, atBottom: false, height: 5000 } : IDLE) });
  const jam = await discover.gather(jammed.tab, [fileSnap('x')], {});
  assert.ok(jam.capped.some((t) => /could not be scrolled to its end, so it may have more files/.test(t)), jam.capped.join(' | '));
  const short = scriptedTab({ snapshot: () => fileSnap('x'), op: (arg) => (arg.op === 'controls' ? { tabs: [], more: [], pager: NOPAGER } : IDLE) });
  const shortDid = await discover.gather(short.tab, [fileSnap('x')], {});
  assert.equal(short.log.filter((a) => a.op === 'scroll' && !a.reset && !a.probe).length, 1, 'a page that does not scroll is tried once');
  assert.deepEqual(shortDid.capped, []);
});
test('discover gather: every "Load more" is pressed, up to 50 at once; one that stays on the page after presses that add nothing is told; so are past-the-cap controls, tabs, form buttons and a menu that may hold files', async () => {
  const st = { chunks: [1, 1, 1, 1, 1] };
  const many = scriptedTab({
    snapshot: () => fileSnap(...st.chunks.flatMap((n, k) => Array.from({ length: n }, (_, i) => `s${k}f${i}`))),
    op: (arg) => {
      if (arg.op === 'controls') return { tabs: [], more: st.chunks.map((n, k) => ({ label: 'Show more', path: `m${k}` })), pager: NOPAGER, popups: [], cut: {}, blocked: 0 };
      if (arg.op === 'activate') { const k = Number(arg.path.slice(1)); if (st.chunks[k] < 3) st.chunks[k] += 1; return { ok: true }; }
      return IDLE;
    },
  });
  const snaps = [fileSnap('s0f0')];
  const did = await discover.gather(many.tab, snaps, {});
  assert.equal(discover.unionCandidates(snaps.map(fileCandidates)).length, 15, 'all five sections were pressed, not the first three');
  assert.ok(did.capped.some((t) => /"Show more" was still on the page after \d+ presses; the last 2 added no files/.test(t)), did.capped.join(' | '));
  const caps = scriptedTab({ snapshot: () => fileSnap('x'), op: (arg) => (arg.op === 'controls' ? { tabs: [], more: [], pager: NOPAGER, popups: ['Attachments (4)'], cut: { tabs: 4, more: 2 }, blocked: 3 } : IDLE) });
  const capDid = await discover.gather(caps.tab, [fileSnap('x')], {});
  const said = capDid.capped.join(' | ');
  assert.match(said, /4 tabs past the 50 the loader opens were not opened/);
  assert.match(said, /2 controls like "Load more" past the 50 the loader presses were not pressed/);
  assert.match(said, /3 controls like "Load more" that would submit a form were not pressed/);
  assert.match(said, /"Attachments \(4\)" opens a menu or dialog that may hold files; it was not opened/);
  const stuck = scriptedTab({ snapshot: () => fileSnap('x'), op: (arg) => (arg.op === 'controls' ? { tabs: [], more: [{ label: 'Load more', path: 'm' }], pager: NOPAGER } : arg.op === 'activate' ? { ok: false, why: 'the element is gone from the page' } : IDLE) });
  assert.match((await discover.gather(stuck.tab, [fileSnap('x')], {})).capped.join(' | '), /"Load more" could not be pressed \(the element is gone from the page\)/);
});
test('discover gather: a pager is followed - Next presses, page numbers, links that change only a page parameter; each page is a snapshot with its view; what cannot be followed is told', async () => {
  const PAGES = 4;
  const st = { page: 1 };
  const names = (p) => Array.from({ length: 3 }, (_, i) => `p${p}f${i}`);
  const pagerOf = (extra = {}) => ({ found: true, hinted: true, next: st.page < PAGES ? { label: 'Next', path: 'next', href: null, disabled: false } : { label: 'Next', path: 'next', href: null, disabled: true }, prev: null, nums: [], current: null, ...extra });
  const spa = scriptedTab({ snapshot: () => fileSnap(...names(st.page)), op: (arg) => (arg.op === 'controls' ? { tabs: [], more: [], pager: pagerOf() } : arg.op === 'activate' ? (st.page += 1, { ok: true }) : IDLE) });
  const pos = { pages: 0, url: null };
  const snaps = [fileSnap(...names(1))];
  const did = await discover.gather(spa.tab, snaps, { pos });
  const all = discover.unionCandidates(snaps.map(fileCandidates));
  assert.equal(all.length, 12, 'four pages of three');
  assert.deepEqual([did.pages, pos.pages, did.capped], [3, 3, []]);
  assert.deepEqual(spa.log.filter((a) => a.op === 'activate').map((a) => [a.kind, a.path]), [['pager', 'next'], ['pager', 'next'], ['pager', 'next']]);
  assert.deepEqual(all.find((c) => c.label === 'p3f1').view, { tab: null, pages: 2, pageUrl: null, more: 0, scroll: 0 }, 'the page of the pager it was seen on');
  /* numbers only: the number after the current one */
  const nums = { page: 1 };
  const numbered = scriptedTab({
    snapshot: () => fileSnap(...names(nums.page)),
    op: (arg) => {
      if (arg.op === 'controls') return { tabs: [], more: [], pager: { found: true, hinted: true, next: null, prev: null, current: nums.page, nums: [1, 2, 3].map((n) => ({ n, label: String(n), path: `n${n}`, href: null, current: n === nums.page, disabled: false })) } };
      if (arg.op === 'activate') { nums.page = Number(arg.path.slice(1)); return { ok: true }; }
      return IDLE;
    },
  });
  const nsnaps = [fileSnap(...names(1))];
  await discover.gather(numbered.tab, nsnaps, {});
  assert.equal(discover.unionCandidates(nsnaps.map(fileCandidates)).length, 9);
  assert.deepEqual(numbered.log.filter((a) => a.op === 'activate').map((a) => a.path), ['n2', 'n3']);
  /* links that change only the page parameter are followed with goto; another path or another parameter is not */
  const links = { url: 'https://x.example/t?page=1', pages: [] };
  const hrefFor = (n, extra = '') => `https://x.example/t?page=${n}${extra}`;
  const linked = scriptedTab({
    snapshot: () => fileSnap(...names(Number(new URL(links.url).searchParams.get('page')))),
    op: (arg) => {
      if (arg.op === 'where') return { href: links.url };
      if (arg.op === 'controls') { const p = Number(new URL(links.url).searchParams.get('page')); return { tabs: [], more: [], pager: { found: true, hinted: true, next: { label: 'Next', path: 'next', href: p < 3 ? hrefFor(p + 1) : hrefFor(3), disabled: false }, prev: null, nums: [], current: null } }; }
      return IDLE;
    },
  });
  const lsnaps = [fileSnap(...names(1))];
  const goto = async (url) => { links.pages.push(url); links.url = url; };
  const lp = { pages: 0, url: null };
  const ldid = await discover.gather(linked.tab, lsnaps, { goto, pos: lp, homeUrl: 'https://x.example/t?page=1' });
  assert.equal(discover.unionCandidates(lsnaps.map(fileCandidates)).length, 9);
  assert.deepEqual(links.pages, [hrefFor(2), hrefFor(3), 'https://x.example/t?page=1'], 'two pages followed, then back to the first');
  assert.deepEqual([lp.url, ldid.pages, ldid.capped], [null, 2, []]);
  assert.deepEqual(lsnaps.filter((x) => x.view && x.view.pageUrl).map((x) => x.view.pageUrl).filter((u, i, all) => all.indexOf(u) === i), [hrefFor(2), hrefFor(3)]);
  const other = scriptedTab({ snapshot: () => fileSnap('a'), op: (arg) => (arg.op === 'where' ? { href: 'https://x.example/t?page=1' } : arg.op === 'controls' ? { tabs: [], more: [], pager: { found: true, hinted: true, next: { label: 'Next', path: 'next', href: 'https://x.example/other?page=2', disabled: false }, prev: null, nums: [], current: null } } : IDLE) });
  const od = await discover.gather(other.tab, [fileSnap('a')], { goto: async () => {}, pos: { pages: 0, url: null } });
  assert.match(od.capped.join(' | '), /pagination link "Next" goes to another address than the page, so its other pages were not read/);
  const nogoto = await discover.gather(other.tab, [fileSnap('a')], {});
  assert.match(nogoto.capped.join(' | '), /pagination links \("Next"\) that the loader does not follow here/);
  const unknown = scriptedTab({ snapshot: () => fileSnap('a'), op: (arg) => (arg.op === 'controls' ? { tabs: [], more: [], pager: { found: true, hinted: true, next: null, prev: null, current: null, nums: [{ n: 1, label: '1', path: 'a', href: null, current: false }, { n: 2, label: '2', path: 'b', href: null, current: false }] } } : IDLE) });
  assert.match((await discover.gather(unknown.tab, [fileSnap('a')], {})).capped.join(' | '), /numbered pages but does not show which one is open/);
  const hinted = scriptedTab({ snapshot: () => fileSnap('a'), op: (arg) => (arg.op === 'controls' ? { tabs: [], more: [], pager: { found: false, hinted: true } } : IDLE) });
  assert.match((await discover.gather(hinted.tab, [fileSnap('a')], {})).capped.join(' | '), /has pagination that the loader did not recognise, so only its first page was read/);
  /* a Next that never turns off and moves nothing: the end of the pager, no fuss */
  const endless = scriptedTab({ snapshot: () => fileSnap('same'), op: (arg) => (arg.op === 'controls' ? { tabs: [], more: [], pager: pagerOf({ next: { label: 'Next', path: 'next', href: null, disabled: false } }) } : arg.op === 'activate' ? { ok: true } : IDLE) });
  const ed = await discover.gather(endless.tab, [fileSnap('same')], {});
  assert.deepEqual(ed.capped, []);
  assert.equal(endless.log.filter((a) => a.op === 'activate').length, 1, 'pressed once; the page did not move, so that was the end');
  /* pages that change but add no file: two of them, then stop and say so */
  let tick = 0;
  const same = scriptedTab({ snapshot: () => ({ ...fileSnap('same'), sections: [{ heading: 'Files', text: `same ${tick++}` }] }), op: (arg) => (arg.op === 'controls' ? { tabs: [], more: [], pager: pagerOf({ next: { label: 'Next', path: 'next', href: null, disabled: false } }) } : arg.op === 'activate' ? { ok: true } : IDLE) });
  const sd = await discover.gather(same.tab, [fileSnap('same')], {});
  assert.match(sd.capped.join(' | '), /pagination stopped after 2 pages that added no files/);
  assert.equal(same.log.filter((a) => a.op === 'activate').length, 2, 'not for ever');
});
function tabbedPage() {
  const state = { cur: 'A', more: { A: 2, B: 3 }, shown: { A: 1, B: 1 }, scroll: 0 };
  const scrollMax = { A: 2, B: 1 };
  return {
    state,
    script: {
      snapshot: () => fileSnap(...Array.from({ length: state.shown[state.cur] + state.scroll }, (_, i) => `${state.cur}${i + 1}`)),
      op: (arg) => {
        if (arg.op === 'controls') return { tabs: ['A', 'B'].map((t) => ({ label: t, path: `tab${t}`, selected: state.cur === t })), more: state.more[state.cur] > 0 ? [{ label: 'Load more', path: 'more' }] : [], pager: NOPAGER };
        if (arg.op === 'activate') { if (arg.path === 'more') { state.more[state.cur] -= 1; state.shown[state.cur] += 1; } else { state.cur = arg.path.slice(3); state.scroll = 0; } return { ok: true }; }
        if (arg.op === 'scroll') {
          if (arg.reset) { state.scroll = 0; return { moved: false, atBottom: false, height: 0 }; }
          if (arg.probe) return { moved: false, atBottom: state.scroll >= scrollMax[state.cur], height: 1000 };
          if (state.scroll >= scrollMax[state.cur]) return { moved: false, atBottom: true, height: 1000 };
          state.scroll += 1; return { moved: true, atBottom: state.scroll >= scrollMax[state.cur], height: 1000 };
        }
        return IDLE;
      },
    },
  };
}
test('discover gather: EVERY tab gets "Load more" and scrolling, not only the open one; each snapshot knows its view (tab, presses, steps); the open tab is put back', async () => {
  const page = tabbedPage();
  const { tab, log } = scriptedTab(page.script);
  const snaps = [fileSnap('A1')];
  const did = await discover.gather(tab, snaps, {});
  assert.deepEqual(log.filter((a) => a.op === 'activate').map((a) => a.path), ['more', 'more', 'tabB', 'more', 'more', 'more', 'tabA']);
  assert.deepEqual([did.tabs, did.more, did.scrolls, did.home, did.capped], [1, 5, 3, { label: 'A', path: 'tabA' }, []]);
  const all = discover.unionCandidates(snaps.map(fileCandidates));
  assert.deepEqual(all.map((c) => c.label).sort(), ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3', 'B4', 'B5']);
  assert.deepEqual(all.find((c) => c.label === 'B5').view, { tab: { label: 'B', path: 'tabB' }, pages: 0, pageUrl: null, more: 3, scroll: 1 }, 'the tab, the presses and the steps it took to see it');
  assert.deepEqual(all.find((c) => c.label === 'A3').view, { tab: { label: 'A', path: 'tabA' }, pages: 0, pageUrl: null, more: 2, scroll: 0 });
  assert.equal(page.state.cur, 'A');
  const small = tabbedPage();
  const s = scriptedTab(small.script);
  const limited = await discover.gather(s.tab, [fileSnap('A1')], { maxMore: 1 });
  assert.ok(limited.capped.some((t) => /"Load more" in the tab "A" stopped at 1 presses and may have more files/.test(t)), limited.capped.join(' | '));
  assert.ok(limited.capped.some((t) => /in the tab "B"/.test(t)), 'the note says which tab');
});
test('discover gather: a tab whose API has not answered when the step ends is waited for, and said so when it is still pending (a note, not silence)', async () => {
  const state = { cur: 'A', pending: false };
  const script = {
    snapshot: () => fileSnap(...(state.cur === 'A' ? ['a1'] : state.pending ? [] : ['b1'])),
    op: (arg) => {
      if (arg.op === 'controls') return { tabs: ['A', 'B'].map((t) => ({ label: t, path: `tab${t}`, selected: state.cur === t })), more: [], pager: NOPAGER };
      if (arg.op === 'activate') { state.cur = arg.path.slice(3); if (state.cur === 'B') { state.pending = true; pending.tab.net.inflight.set('r', { type: 'Fetch', startedAt: Date.now(), responded: false, lastDataAt: Date.now() }); } return { ok: true }; }
      return IDLE;
    },
  };
  const pending = scriptedTab(script);
  const did = await discover.gather(pending.tab, [fileSnap('a1')], { patientMs: 600, minPerTabMs: 1000 });
  assert.ok(did.capped.some((t) => /a request of the page was still waiting for its answer after the tab "B" was opened, so some files may be missing/.test(t)), did.capped.join(' | '));
  const answered = { cur: 'A' };
  const ok = scriptedTab({
    snapshot: () => fileSnap(...(answered.cur === 'A' ? ['a1'] : ['b1'])),
    op: (arg) => {
      if (arg.op === 'controls') return { tabs: ['A', 'B'].map((t) => ({ label: t, path: `tab${t}`, selected: answered.cur === t })), more: [], pager: NOPAGER };
      if (arg.op === 'activate') { answered.cur = arg.path.slice(3); if (answered.cur === 'B') { ok.tab.net.inflight.set('r', { type: 'Fetch', startedAt: Date.now(), responded: false, lastDataAt: Date.now() }); setTimeout(() => ok.tab.net.inflight.delete('r'), 700); } return { ok: true }; }
      return IDLE;
    },
  });
  const done = await discover.gather(ok.tab, [fileSnap('a1')], { patientMs: 5000, minPerTabMs: 1000 });
  assert.deepEqual(done.capped, [], 'it answered in time: nothing to say');
  /* a request that is given up on at 20 s is still pending: it is told */
  const aged = scriptedTab({ snapshot: () => fileSnap('a1'), op: (arg) => (arg.op === 'controls' ? { tabs: [], more: [], pager: NOPAGER } : IDLE) });
  aged.tab.net.inflight.set('old', { type: 'Fetch', startedAt: Date.now() - 30000, responded: false, lastDataAt: Date.now() - 30000 });
  const quickRun = await discover.gather(aged.tab, [fileSnap('a1')], { patientMs: 100 });
  assert.deepEqual(quickRun.capped, [], 'it started before the step: not this step\'s');
  const { waitForSettled } = require('../backend/links/tab.cjs');
  const r = await waitForSettled(aged.tab, { maxMs: 300, pollMs: 20 });
  assert.deepEqual([r.settled, r.lost], [true, 1], 'with no step to compare with, a request that never answered is lost');
});
test('discover replay: the tab, the pager, the "Load more" presses, then the scroll steps, in the order gather took them', async () => {
  const page = tabbedPage();
  const { tab, log } = scriptedTab(page.script);
  const r = await discover.replay(tab, { tab: { label: 'B', path: 'tabB' }, more: 2, scroll: 1 }, { label: 'A', path: 'tabA' }, {});
  assert.deepEqual(r, { ok: true });
  const trace = log.map((a) => `${a.op}${a.path ? `:${a.path}` : ''}${a.reset ? ':reset' : ''}`);
  assert.deepEqual(trace.filter((t) => !t.startsWith('controls') && !t.startsWith('expand')), ['activate:tabB', 'activate:more', 'activate:more', 'scroll:reset', 'scroll']);
  assert.deepEqual([page.state.cur, page.state.shown.B, page.state.scroll], ['B', 3, 1]);
  const again = scriptedTab(page.script);
  await discover.replay(again.tab, { tab: { label: 'B', path: 'tabB' }, more: 0, scroll: 0 }, null, {});
  assert.ok(!again.log.some((a) => a.op === 'activate' && a.path === 'tabB'), 'already on that tab: not pressed again');
  const gone = scriptedTab({ snapshot: () => fileSnap('x'), op: (arg) => (arg.op === 'controls' ? { tabs: [{ label: 'A', path: 'a', selected: true }], more: [] } : arg.op === 'activate' ? { ok: false, why: 'the element is gone from the page' } : {}) });
  const failed = await discover.replay(gone.tab, { tab: { label: 'B', path: 'b' }, more: 0, scroll: 0 }, null, {});
  assert.equal(failed.ok, false);
  assert.match(failed.why, /tab "B" is no longer on the page/);
  const stuck = scriptedTab({ snapshot: () => fileSnap('x'), op: (arg) => (arg.op === 'controls' ? { tabs: [{ label: 'A', path: 'a', selected: true }, { label: 'B', path: 'b', selected: false }], more: [] } : arg.op === 'activate' ? { ok: false, why: 'the element is gone from the page' } : {}) });
  assert.match((await discover.replay(stuck.tab, { tab: { label: 'B', path: 'b' }, more: 0, scroll: 0 }, null, {})).why, /tab "B" could not be opened again/);
  const counted = scriptedTab({ snapshot: () => fileSnap('x'), op: (arg) => (arg.op === 'controls' ? { tabs: [{ label: 'Files (12)', path: 'a', selected: true }, { label: 'Reference (9)', path: 'b', selected: false }], more: [] } : arg.op === 'activate' ? { ok: true } : {}) });
  await discover.replay(counted.tab, { tab: { label: 'Reference (3)', path: 'b' }, more: 0, scroll: 0 }, null, {});
  assert.deepEqual(counted.log.filter((a) => a.op === 'activate').map((a) => [a.path, a.label, a.kind]), [['b', 'Reference (9)', 'tab']], 'a tab whose count changed is the same tab, and is pressed under the label it has now');
});
test('discover replay: a page of a pager is reached again - Next pressed from where the pager is, a reload when it is further on, the address when the pages are links', async () => {
  const st = { page: 1, loads: [] };
  const pager = () => ({ found: true, hinted: true, next: { label: 'Next', path: 'next', href: null, disabled: false }, prev: null, nums: [], current: null });
  const mk = () => scriptedTab({ snapshot: () => fileSnap('x'), op: (arg) => (arg.op === 'controls' ? { tabs: [], more: [], pager: pager() } : arg.op === 'activate' ? (st.page += 1, { ok: true }) : IDLE) });
  const a = mk();
  const pos = { pages: 0, url: null };
  assert.deepEqual(await discover.replay(a.tab, { tab: null, pages: 2, more: 0, scroll: 0 }, null, { pos }), { ok: true });
  assert.deepEqual([st.page, pos.pages], [3, 2], 'two Next presses from the first page');
  await discover.replay(a.tab, { tab: null, pages: 2, more: 0, scroll: 0 }, null, { pos });
  assert.equal(st.page, 3, 'already there: nothing pressed');
  await discover.replay(a.tab, { tab: null, pages: 3, more: 0, scroll: 0 }, null, { pos });
  assert.equal(st.page, 4, 'one more');
  const loaded = [];
  const back = await discover.replay(a.tab, { tab: null, pages: 1, more: 0, scroll: 0 }, null, { pos, goto: async (u) => { loaded.push(u); }, homeUrl: 'https://x.example/t' });
  assert.deepEqual([back.ok, loaded, pos.pages], [true, ['https://x.example/t'], 1], 'further on than wanted: the task page is loaded again and the presses start over');
  const noGoto = await discover.replay(a.tab, { tab: null, pages: 0, more: 0, scroll: 0 }, null, { pos });
  assert.equal(noGoto.ok, true, 'wanting the first page with no way to load it is not an error here');
  const byLink = scriptedTab({ snapshot: () => fileSnap('x'), op: (arg) => (arg.op === 'controls' ? { tabs: [], more: [], pager: NOPAGER } : IDLE) });
  const lpos = { pages: 0, url: null };
  const urls = [];
  await discover.replay(byLink.tab, { tab: null, pages: 0, pageUrl: 'https://x.example/t?page=3', more: 0, scroll: 0 }, null, { pos: lpos, goto: async (u) => { urls.push(u); }, homeUrl: 'https://x.example/t' });
  assert.deepEqual([urls, lpos.url], [['https://x.example/t?page=3'], 'https://x.example/t?page=3']);
  await discover.replay(byLink.tab, { tab: null, pages: 0, pageUrl: 'https://x.example/t?page=3', more: 0, scroll: 0 }, null, { pos: lpos, goto: async (u) => { urls.push(u); } });
  assert.equal(urls.length, 1, 'already on that address');
  await discover.replay(byLink.tab, { tab: null, pages: 0, more: 0, scroll: 0 }, null, { pos: lpos, goto: async (u) => { urls.push(u); }, homeUrl: 'https://x.example/t' });
  assert.deepEqual(urls.slice(1), ['https://x.example/t'], 'the first page has no address of its own: the task page');
});
test('discover expandAll: repeats until nothing new opens (a folder inside a folder), at most `passes` times, every pass a stamped snapshot; a last pass that still opened something, a form button and a menu are told', async () => {
  let n = 0;
  const { tab } = scriptedTab({ snapshot: () => fileSnap('a', `b${n}`), op: () => { n += 1; return n <= 2 ? { opened: 0, expanded: 1 } : { opened: 0, expanded: 0 }; } });
  const snaps = [];
  const total = await discover.expandAll(tab, snaps, { view: { tab: null, more: 0, scroll: 0 } });
  assert.deepEqual(total, { opened: 0, expanded: 2, passes: 1, lost: 0, blocked: 0, popups: [], capped: false }, 'a pass presses one expander after the other until none is left, then one look');
  assert.equal(snaps.length, 1);
  assert.deepEqual(snaps[0].view, { tab: null, pages: 0, pageUrl: null, more: 0, scroll: 0 });
  const stuck = scriptedTab({ snapshot: () => fileSnap('a'), op: () => ({ opened: 1, expanded: 0 }) });
  const stuckTotal = await discover.expandAll(stuck.tab, [], { passes: 3 });
  assert.deepEqual([stuckTotal.passes, stuckTotal.capped], [3, true], 'the last pass still opened something');
  const quiet = scriptedTab({ snapshot: () => fileSnap('a'), op: () => ({ opened: 1, expanded: 0 }) });
  const none = [];
  await discover.expandAll(quiet.tab, none, { passes: 2, snapshots: false });
  assert.equal(none.length, 0, 'snapshots:false only puts the page into the state');
  const told = scriptedTab({ snapshot: () => fileSnap('a'), op: () => ({ opened: 0, expanded: 0, blocked: 2, popups: ['Attachments'] }) });
  assert.deepEqual(await discover.expandAll(told.tab, [], {}), { opened: 0, expanded: 0, passes: 0, lost: 0, blocked: 2, popups: ['Attachments'], capped: false });
  const cutPass = scriptedTab({ snapshot: () => fileSnap('a'), op: () => ({ opened: 0, expanded: 5, cut: true }) });
  assert.equal((await discover.expandAll(cutPass.tab, [], { passes: 1 })).capped, true);
});
test('discover expand: opens details and expanders, and takes a new look only when it did something', async () => {
  const none = scriptedTab({ snapshot: () => fileSnap('a'), op: () => ({ opened: 0, expanded: 0 }) });
  const s1 = [fileSnap('a')];
  await discover.expand(none.tab, s1, {});
  assert.equal(s1.length, 1);
  const some = scriptedTab({ snapshot: () => fileSnap('a', 'b'), op: () => ({ opened: 1, expanded: 0 }) });
  const s2 = [fileSnap('a')];
  assert.deepEqual(await discover.expand(some.tab, s2, {}), { opened: 1, expanded: 0, lost: 0 });
  assert.equal(s2.length, 2);
});

/* ---------------------------------------------------------------- launch arguments and environment */
test('chrome args: a pipe, a profile of our own, never a TCP debugging port, never --no-sandbox, the link nowhere, about:blank the only positional argument', () => {
  for (const headless of [true, false]) {
    const args = chromeArgs({ profileDir: '/p/q', headless });
    assert.ok(args.includes('--remote-debugging-pipe') && args.includes('--user-data-dir=/p/q'));
    assert.equal(args.includes('--headless=new'), headless);
    assert.ok(!args.some((a) => /^--remote-debugging-(port|address)|^--remote-allow-origins|^--no-sandbox|^--disable-web-security|^--ignore-certificate|^--load-extension|^--incognito|^--proxy|^--use-mock-keychain|^--host-resolver/.test(a)), args.join(' '));
    assert.deepEqual(args.filter((a) => !a.startsWith('--')), ['about:blank']);
    assert.equal(args[args.length - 1], 'about:blank');
    assert.ok(args.includes('--restore-last-session') && args.includes('--no-first-run') && args.includes('--no-default-browser-check'));
    assert.equal(args.includes('--hide-crash-restore-bubble'), !headless);
  }
});
test('chrome env: an allow list, so a token in the companion\'s environment never reaches Chrome', () => {
  const env = browserEnv({ PATH: '/usr/bin', HOME: '/home/a', LANG: 'en_US.UTF-8', TMPDIR: '/tmp/x', DISPLAY: ':1', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_SESSION_ID: 's', FINANCE_STUDIO_PILOT_TOKEN: 't', HTTPS_PROXY: 'http://u:p@proxy:3128', AWS_SECRET_ACCESS_KEY: 'a', NODE_OPTIONS: '--inspect' });
  assert.deepEqual(Object.keys(env).sort(), ['DISPLAY', 'HOME', 'LANG', 'PATH', 'TMPDIR']);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/a', 'without a profile home the real HOME is kept (macOS Keychain)');
});
test('chrome env: on Linux HOME and the XDG folders move inside the profile, and a non-UTF-8 locale is replaced', () => {
  if (process.platform !== 'linux') return;
  const env = browserEnv({ PATH: '/usr/bin', HOME: '/root', LANG: 'C', XDG_CONFIG_HOME: '/root/.config' }, '/p/home');
  assert.deepEqual([env.HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME], ['/p/home', '/p/home/.config', '/p/home/.cache', '/p/home/.local/share']);
  assert.equal(env.LC_ALL, 'C.UTF-8');
  assert.equal(browserEnv({ LANG: 'en_US.UTF-8' }).LC_ALL, undefined);
});
test('chrome binary: FINANCE_STUDIO_CHROME, then CHROME_BIN, absolute and executable and not writable by others; the macOS apps (also in ~/Applications) are on the list', () => {
  const dir = fresh('bin');
  const make = (name, mode) => { const f = path.join(dir, name); fs.writeFileSync(f, '#!/bin/sh\n'); fs.chmodSync(f, mode); return f; };
  const a = make('a', 0o755); const b = make('b', 0o755); const writable = make('w', 0o777); const noexec = make('n', 0o644);
  assert.equal(findChromeBinary({ FINANCE_STUDIO_CHROME: a, CHROME_BIN: b }), a);
  assert.equal(findChromeBinary({ CHROME_BIN: b }), b);
  assert.notEqual(findChromeBinary({ FINANCE_STUDIO_CHROME: writable, CHROME_BIN: noexec }), writable, 'a world-writable binary is not used');
  assert.ok(![writable, noexec, 'relative/chrome', '', undefined, path.join(dir, 'missing'), dir].some((f) => usableBinary(f)));
  assert.equal(usableBinary(a), true);
  const list = chrome.defaultCandidates('/Users/owner');
  for (const want of ['/Applications/Google Chrome.app', '/Applications/Chromium.app', '/Users/owner/Applications/Google Chrome.app', '/Users/owner/Applications/Chromium.app', '/usr/bin/google-chrome']) assert.ok(list.includes(want), want);
});
test('chrome binary: the group write bit of macOS admin (gid 80, mode 775, owned by root or the current account) is allowed on macOS only; anything else others can write is not', () => {
  const me = 501;
  const on = (stat, platform = 'darwin') => chrome.writableByOthers(stat, { platform, uid: me });
  assert.equal(on({ mode: 0o100775, uid: 0, gid: 80 }), false, 'root:admin 775 on macOS');
  assert.equal(on({ mode: 0o100775, uid: me, gid: 80 }), false, 'the current account and admin on macOS');
  assert.equal(on({ mode: 0o100755, uid: 0, gid: 80 }), false, 'no group write bit');
  assert.equal(on({ mode: 0o100775, uid: 0, gid: 80 }, 'linux'), true, 'the exception is for macOS only');
  assert.equal(on({ mode: 0o100775, uid: me, gid: 20 }), true, 'another group (staff, gid 20) can write');
  assert.equal(on({ mode: 0o100775, uid: 502, gid: 80 }), true, 'another account owns it');
  assert.equal(on({ mode: 0o100777, uid: 0, gid: 80 }), true, 'world-writable is never allowed');
  assert.equal(on({ mode: 0o100757, uid: me, gid: 80 }), true, 'world-writable with the admin group');
  assert.equal(on({ mode: 0o100664, uid: me, gid: 80 }), false, 'group write without execute is judged by the same rule');
});
test('chrome binary: a .app folder resolves to Contents/MacOS/<CFBundleExecutable>; why a candidate was passed over is reported', () => {
  const dir = fresh('app');
  const app = path.join(dir, 'Fake Browser.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleName</key><string>Fake</string><key>CFBundleExecutable</key>\n<string>FakeBin</string></dict></plist>');
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'FakeBin'), '#!/bin/sh\n', { mode: 0o755 });
  fs.chmodSync(path.join(app, 'Contents', 'MacOS', 'FakeBin'), 0o755);
  assert.equal(chrome.resolveBinary(app), path.join(app, 'Contents', 'MacOS', 'FakeBin'));
  assert.equal(chrome.resolveBinary(app + '/'), path.join(app, 'Contents', 'MacOS', 'FakeBin'));
  assert.equal(chrome.resolveBinary('/usr/bin/chromium'), '/usr/bin/chromium');
  assert.equal(usableBinary(app), true);
  assert.equal(findChromeBinary({ FINANCE_STUDIO_CHROME: app }), path.join(app, 'Contents', 'MacOS', 'FakeBin'));
  const bare = path.join(dir, 'Plain.app');
  fs.mkdirSync(path.join(bare, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(bare, 'Contents', 'MacOS', 'Plain'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(chrome.resolveBinary(bare), path.join(bare, 'Contents', 'MacOS', 'Plain'), 'no Info.plist: the app\'s own name');
  const open = path.join(dir, 'open');
  fs.writeFileSync(open, '#!/bin/sh\n'); fs.chmodSync(open, 0o775);
  const none = chrome.findChrome({ FINANCE_STUDIO_CHROME: open, CHROME_BIN: path.join(dir, 'gone') }, dir);
  assert.deepEqual(none.tried.map((t) => [t.path, t.why.replace(/ \(mode \d+\)/, '')]).slice(0, 2), [[open, 'other accounts can write to it'], [path.join(dir, 'gone'), 'it does not exist']]);
  assert.match(chrome.missingChromeMessage(none.tried), /No Chrome or Chromium found.*FINANCE_STUDIO_CHROME.*open \(other accounts can write to it/);
  assert.equal(chrome.checkBinary(dir).why, 'it is not a file');
  assert.equal(chrome.checkBinary('x').why, 'it is not an absolute path');
});

/* ---------------------------------------------------------------- the profile */
test('profile: seeded preferences keep session cookies and switch the password manager off; old session files go; a second call changes nothing else', () => {
  const profile = fresh('profile');
  fs.mkdirSync(path.join(profile, 'Default', 'Sessions'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'Default', 'Sessions', 'Session_1'), 'old tab https://x.example/?sig=1');
  fs.writeFileSync(path.join(profile, 'Default', 'Current Tabs'), 'old');
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ keep: { me: true }, session: { other: 1 } }));
  prepareProfile(profile);
  const prefs = JSON.parse(fs.readFileSync(path.join(profile, 'Default', 'Preferences'), 'utf8'));
  assert.deepEqual([prefs.session, prefs.keep, prefs.credentials_enable_service, prefs.profile.password_manager_enabled, prefs.autofill], [{ other: 1, restore_on_startup: 1 }, { me: true }, false, false, { profile_enabled: false, credit_card_enabled: false }]);
  assert.ok(!fs.existsSync(path.join(profile, 'Default', 'Sessions')) && !fs.existsSync(path.join(profile, 'Default', 'Current Tabs')));
  assert.equal(fs.statSync(path.join(profile, 'Default', 'Preferences')).mode & 0o777, 0o600);
  prepareProfile(profile);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, 'Default', 'Preferences'), 'utf8')), prefs);
});
test('profile scrub: History, the download database, sessions and caches go (they hold signed links); cookies and local storage stay', () => {
  const profile = fresh('scrub');
  const put = (rel, text = 'https://files.example/blob/a.xlsx?X-Signature=CANARY Atlas_Evaluator.docx') => { const f = path.join(profile, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const forgotten = ['Default/History', 'Default/History-journal', 'Default/Visited Links', 'Default/Top Sites', 'Default/Favicons', 'Default/Shortcuts', 'Default/Web Data', 'Default/DownloadMetadata', 'Default/Network Action Predictor', 'Default/Sessions/Session_1', 'Default/Current Session', 'Default/Last Tabs',
    'Default/shared_proto_db/000003.log', 'Default/Cache/Cache_Data/f_1', 'Default/Code Cache/js/a', 'Default/GPUCache/data_0', 'Default/Service Worker/CacheStorage/x', 'Default/Download Service/x', 'segmentation_platform/ukm_db', 'ShaderCache/index', 'GrShaderCache/index'];
  const kept = ['Default/Cookies', 'Default/Cookies-journal', 'Default/Local Storage/leveldb/000003.log', 'Default/IndexedDB/https_x.example_0.indexeddb.leveldb/a', 'Default/Service Worker/Database/a', 'Default/Preferences', 'Local State', 'home/.config/x'];
  for (const f of [...forgotten, ...kept]) put(f, kept.includes(f) ? 'keep me' : undefined);
  scrubProfile(profile);
  for (const f of forgotten) assert.ok(!fs.existsSync(path.join(profile, f)), f);
  for (const f of kept) assert.equal(fs.readFileSync(path.join(profile, f), 'utf8'), 'keep me', f);
  scrubProfile(profile);
  scrubProfile(path.join(profile, 'nothing-here'));
});

/* ---------------------------------------------------------------- private folders and the mapping store */
test('ensurePrivateDir: created 0700, tightened when looser, a symlink or a file or a foreign owner refused', () => {
  const dir = fresh('priv');
  const made = path.join(dir, 'a', 'b');
  store.ensurePrivateDir(made);
  assert.equal(fs.statSync(made).mode & 0o777, 0o700);
  fs.chmodSync(made, 0o755);
  store.ensurePrivateDir(made);
  assert.equal(fs.statSync(made).mode & 0o777, 0o700);
  fs.symlinkSync(made, path.join(dir, 'link'));
  assert.throws(() => store.ensurePrivateDir(path.join(dir, 'link')), /link or not a folder/);
  fs.writeFileSync(path.join(dir, 'file'), 'x');
  assert.throws(() => store.ensurePrivateDir(path.join(dir, 'file')), /link or not a folder/);
  assert.throws(() => store.ensurePrivateDir(path.join(dir, 'missing'), { create: false }), /missing/);
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    const foreign = path.join(dir, 'foreign');
    fs.mkdirSync(foreign, { mode: 0o700 });
    fs.chownSync(foreign, 65534, 65534);
    assert.throws(() => store.ensurePrivateDir(foreign), /another account/);
  }
});
test('mapping store: learn, read back, atomic 0600 write, strict on read, 50 hosts, only labels it would accept', () => {
  const dir = fresh('map');
  const file = path.join(dir, 'private', 'link-mappings.json');
  assert.equal(store.learnedToggle(file, 'tasks.atlas.example'), null, 'a missing file is an empty store');
  assert.equal(store.learnToggle(file, 'tasks.atlas.example', 'Advanced view', '2026-10-23T12:00:00.000Z'), true);
  assert.equal(store.learnedToggle(file, 'tasks.atlas.example'), 'Advanced view');
  assert.equal(store.learnedToggle(file, 'tasks.meridian.example'), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { schema: 'finance-link-mappings', version: 1, hosts: { 'tasks.atlas.example': { updatedAt: '2026-10-23T12:00:00.000Z', allFilesToggle: 'Advanced view' } } });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['link-mappings.json'], 'no temp file left');
  assert.equal(store.learnToggle(file, 'tasks.atlas.example', 'Show everything', '2026-10-24T00:00:00.000Z'), true);
  assert.equal(store.learnedToggle(file, 'tasks.atlas.example'), 'Show everything', 'the newer label replaces the older');
  for (const bad of ['', 'x'.repeat(201), 'a\u0000b', 'a\u202eb', 5, null, undefined]) assert.equal(store.learnToggle(file, 'tasks.atlas.example', bad, '2026-10-24T00:00:00.000Z'), false, String(bad).slice(0, 10));
  for (const badHost of ['', 'a b', 'x'.repeat(300), 'https://x.example', '../x']) assert.equal(store.learnToggle(file, badHost, 'Label', '2026-10-24T00:00:00.000Z'), false, badHost.slice(0, 10));
  assert.equal(store.learnedToggle(file, 'tasks.atlas.example'), 'Show everything', 'refusals changed nothing');
  assert.equal(store.learnToggle(file, '127.0.0.1:8123', 'Show all', '2026-10-24T00:00:00.000Z'), true, 'a host with a port is a host');
  assert.equal(store.learnedToggle(file, '127.0.0.1:8123'), 'Show all');
  for (let i = 0; i < 60; i += 1) store.learnToggle(file, `h${i}.atlas.example`, `Label ${i}`, `2026-11-${String(1 + (i % 28)).padStart(2, '0')}T00:00:${String(i % 60).padStart(2, '0')}.000Z`);
  assert.equal(Object.keys(store.readMappings(file).hosts).length, 50);
  assert.equal(store.learnedToggle(file, 'tasks.atlas.example'), null, 'the oldest hosts were dropped');
});
test('mapping store: an invalid file counts as empty (unknown key, wrong type, wrong schema, too big, not a file, not JSON) and is never trusted', () => {
  const dir = fresh('mapbad');
  const file = path.join(dir, 'm.json');
  const write = (value) => fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  const entry = { updatedAt: '2026-10-23T12:00:00.000Z', allFilesToggle: 'Show all' };
  write({ schema: 'finance-link-mappings', version: 1, hosts: { 'a.example': entry } });
  assert.equal(store.learnedToggle(file, 'a.example'), 'Show all');
  const bads = [
    { schema: 'finance-link-mappings', version: 1, hosts: { 'a.example': { ...entry, extra: 'content' } } }, { schema: 'finance-link-mappings', version: 1, hosts: { 'a.example': { ...entry, allFilesToggle: 5 } } },
    { schema: 'finance-link-mappings', version: 1, hosts: { 'a.example': { updatedAt: 5, allFilesToggle: 'x' } } }, { schema: 'other', version: 1, hosts: { 'a.example': entry } }, { schema: 'finance-link-mappings', version: 2, hosts: {} },
    { schema: 'finance-link-mappings', version: 1, hosts: { 'a.example': entry }, note: 'x' }, { schema: 'finance-link-mappings', version: 1, hosts: [] }, { schema: 'finance-link-mappings', version: 1, hosts: { 'bad host': entry } },
    { schema: 'finance-link-mappings', version: 1, hosts: { 'a.example': { ...entry, allFilesToggle: 'x'.repeat(300) } } }, 'not json', '[]', 'null',
  ];
  for (const bad of bads) { write(bad); assert.equal(store.learnedToggle(file, 'a.example'), null, JSON.stringify(bad).slice(0, 70)); assert.deepEqual(Object.keys(store.readMappings(file).hosts), []); }
  write({ schema: 'finance-link-mappings', version: 1, hosts: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`h${i}.example`, entry])) });
  assert.deepEqual(Object.keys(store.readMappings(file).hosts), [], 'more than 50 hosts');
  write(' '.repeat(300 * 1024));
  assert.deepEqual(Object.keys(store.readMappings(file).hosts), [], 'larger than the file limit');
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.deepEqual(Object.keys(store.readMappings(file).hosts), [], 'a folder in its place');
});

/* ---------------------------------------------------------------- the request gate */
function fakeSession() {
  const sent = []; const handlers = {};
  return { sent, handlers, s: { send: async (method, params) => { sent.push({ method, params }); return {}; }, on: (method, handler) => { handlers[method] = handler; return () => { delete handlers[method]; }; } } };
}
test('gate: a host or scheme the policy refuses is failed before it is sent; allowed ones continue; redirects pass through to the next hop', async () => {
  const f = fakeSession();
  const blocked = [];
  await gateTab({ s: f.s }, { isAllowed: (u) => u.hostname === 'files.example', onBlocked: (b) => blocked.push(b.host), file: { onResponse: async () => ({ action: 'continue' }) } });
  assert.deepEqual(f.sent[0].params.patterns.map((p) => [p.resourceType, p.requestStage]), [['Document', 'Request'], ['Document', 'Response']], 'documents only, both stages');
  assert.equal(f.sent[0].method, 'Fetch.enable');
  const fire = (params) => f.handlers['Fetch.requestPaused'](params);
  await fire({ requestId: '1', request: { url: 'https://files.example/a.pdf' } });
  await fire({ requestId: '2', request: { url: 'http://127.0.0.2:9/secret' } });
  await fire({ requestId: '3', request: { url: 'not a url' } });
  await fire({ requestId: '4', responseStatusCode: 302, responseHeaders: [{ name: 'Location', value: 'http://127.0.0.2:9/secret' }], request: { url: 'https://files.example/r' } });
  assert.deepEqual(f.sent.slice(1).map((c) => [c.method, c.params.requestId, c.params.errorReason]), [['Fetch.continueRequest', '1', undefined], ['Fetch.failRequest', '2', 'BlockedByClient'], ['Fetch.failRequest', '3', 'BlockedByClient'], ['Fetch.continueRequest', '4', undefined]]);
  assert.deepEqual(blocked, ['127.0.0.2']);
});
test('gate: at the response stage the decision is applied before any body byte: fail, force a download, or continue; an error in the policy fails closed', async () => {
  const f = fakeSession();
  const decisions = [{ action: 'fail' }, { action: 'attachment', filename: 'R\u00e9sum\u00e9 "x".pdf' }, { action: 'continue' }];
  await gateTab({ s: f.s }, { isAllowed: () => true, file: { onResponse: async (p, headers) => { if (p.requestId === 'boom') throw new Error('policy bug'); assert.equal(headers['content-type'], 'application/pdf'); return decisions.shift(); } } });
  const fire = (id) => f.handlers['Fetch.requestPaused']({ requestId: id, responseStatusCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/pdf' }, { name: 'Content-Disposition', value: 'inline; filename="evil\r\nSet-Cookie: x=1"' }], request: { url: 'https://files.example/a.pdf' } });
  await fire('a'); await fire('b'); await fire('c'); await fire('boom');
  const calls = f.sent.slice(1);
  assert.deepEqual(calls.map((c) => [c.method, c.params.errorReason]), [['Fetch.failRequest', 'Aborted'], ['Fetch.continueResponse', undefined], ['Fetch.continueRequest', undefined], ['Fetch.failRequest', 'Aborted']]);
  const headers = calls[1].params.responseHeaders;
  assert.equal(headers.filter((h) => h.name.toLowerCase() === 'content-disposition').length, 1, 'the old disposition is replaced, not doubled');
  assert.match(headers.find((h) => h.name === 'content-disposition').value, /^attachment; filename="R_sum_ _x_\.pdf"; filename\*=UTF-8''R%C3%A9sum%C3%A9%20%22x%22\.pdf$/);
  assert.equal(calls[1].params.responseCode, 200);
  assert.equal(attachmentHeader('a b.pdf'), 'attachment; filename="a b.pdf"; filename*=UTF-8\'\'a%20b.pdf');
  assert.ok(!/[\r\n]/.test(attachmentHeader('a\r\nSet-Cookie: x=1')));
});

/* ---------------------------------------------------------------- downloads: decisions, caps, naming */
function manager(limits = {}) {
  const dir = fresh('dl');
  const sent = [];
  const cdp = new EventEmitter();
  cdp.closed = false;
  const dm = new DownloadManager(cdp, { stageDir: path.join(dir, 'stage'), destDir: path.join(dir, 'files'), limits });
  /* Chrome answers a cancel with a "canceled" progress event for that download. */
  cdp.send = async (method, params) => { sent.push({ method, params }); if (method === 'Browser.cancelDownload') dm.onProgress({ guid: params.guid, totalBytes: 0, receivedBytes: 0, state: 'canceled' }); return {}; };
  fs.mkdirSync(dm.stageDir, { recursive: true }); fs.mkdirSync(dm.destDir, { recursive: true });
  return { dm, sent, dir };
}
const job = (extra = {}) => ({ candidate: { ext: 'pdf', nameHint: 'A.pdf' }, tab: { net: { hops: [] } }, terminal: null, ...extra });
const decide = (m, j, status, headers) => m.dm.decide(j, { responseStatusCode: status }, headers);

test('download decisions: errors, size, a web page in place of a file, a sign-in page, inline types forced to a download', () => {
  const m = manager({ maxFileBytes: 1000, maxTotalBytes: 1500 });
  let j = job();
  assert.deepEqual(decide(m, j, 404, {}), { action: 'fail' }); assert.deepEqual(j.terminal, { state: 'http-error' });
  j = job(); decide(m, j, 403, {}); assert.equal(j.terminal.state, 'http-denied');
  j = job(); decide(m, j, 401, {}); assert.equal(j.terminal.state, 'http-denied');
  j = job(); decide(m, j, 200, { 'content-length': '5000' }); assert.equal(j.terminal.state, 'too-large');
  m.dm.totalBytes = 900; j = job(); decide(m, j, 200, { 'content-length': '700' }); assert.equal(j.terminal.state, 'total-cap'); m.dm.totalBytes = 0;
  j = job({ candidate: { ext: null } }); decide(m, j, 200, { 'content-type': 'text/html; charset=utf-8' }); assert.equal(j.terminal.state, 'not-a-file');
  j = job({ candidate: { ext: null }, tab: { net: { hops: [{ rawUrl: 'https://x.example/f/1' }, { rawUrl: 'https://x.example/login?next=%2Ff%2F1' }] } } }); decide(m, j, 200, { 'content-type': 'text/html' }); assert.equal(j.terminal.state, 'needs-sign-in');
  j = job({ candidate: { ext: 'html' } }); assert.equal(decide(m, j, 200, { 'content-type': 'text/html' }).action, 'attachment', 'a link that says it is an .html file is a file');
  j = job({ candidate: { ext: 'pdf', nameHint: '../a b.pdf' } });
  assert.deepEqual(decide(m, j, 200, { 'content-type': 'application/pdf' }), { action: 'attachment', filename: 'a b.pdf' });
  for (const type of ['text/plain', 'image/png', 'application/json', 'application/vnd.api+json', 'application/xml']) assert.equal(decide(m, job(), 200, { 'content-type': type }).action, 'attachment', type);
  assert.equal(decide(m, job(), 200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="a.pdf"' }).action, 'continue');
  assert.equal(decide(m, job(), 200, { 'content-type': 'application/octet-stream' }).action, 'continue');
  assert.equal(decide(m, job(), 200, { 'content-type': 'application/zip', 'content-length': '900' }).action, 'continue');
});

test('download caps while a file arrives: the size on disk is polled, so a fast link cannot run past the cap; a stalled one is cancelled; nothing is left in the stage folder', async () => {
  const m = manager({ maxFileBytes: 1000, maxTotalBytes: 1500, idleMs: 150, pollMs: 10 });
  const guid = 'g1';
  const j = job({ guid, received: 0, totalBytes: 0, lastGrowthAt: Date.now(), startedAt: Date.now() });
  m.dm.jobs.set(guid, j);
  fs.writeFileSync(path.join(m.dm.stageDir, `${guid}.crdownload`), Buffer.alloc(1200));
  await m.dm.waitTerminal(j);
  assert.equal(j.terminal.state, 'too-large');
  assert.ok(m.sent.some((c) => c.method === 'Browser.cancelDownload' && c.params.guid === guid));
  assert.deepEqual(fs.readdirSync(m.dm.stageDir), [], 'the partial file is removed');

  m.dm.totalBytes = 900;
  const j2 = job({ guid: 'g2', received: 0, totalBytes: 0, lastGrowthAt: Date.now(), startedAt: Date.now() });
  m.dm.jobs.set('g2', j2);
  fs.writeFileSync(path.join(m.dm.stageDir, 'g2.crdownload'), Buffer.alloc(700));
  await m.dm.waitTerminal(j2);
  assert.equal(j2.terminal.state, 'total-cap');

  m.dm.totalBytes = 0;
  const j3 = job({ guid: 'g3', received: 0, totalBytes: 0, lastGrowthAt: Date.now(), startedAt: Date.now() });
  m.dm.jobs.set('g3', j3);
  fs.writeFileSync(path.join(m.dm.stageDir, 'g3.crdownload'), Buffer.alloc(10));
  await m.dm.waitTerminal(j3);
  assert.equal(j3.terminal.state, 'stalled');

  const j4 = job({ guid: null, startedAt: Date.now() - 20000 });
  await m.dm.waitTerminal(j4);
  assert.equal(j4.terminal.state, 'no-download');

  const j5 = job({ guid: null, startedAt: Date.now() });
  const ac = new AbortController(); setTimeout(() => ac.abort(), 30);
  await m.dm.waitTerminal(j5, ac.signal);
  assert.equal(j5.terminal.state, 'cancelled');

  const j6 = job({ guid: 'g6', received: 0, totalBytes: 0, lastGrowthAt: Date.now(), startedAt: Date.now() - 700000 });
  m.dm.jobs.set('g6', j6);
  fs.writeFileSync(path.join(m.dm.stageDir, 'g6.crdownload'), Buffer.alloc(1));
  await m.dm.waitTerminal(j6);
  assert.equal(j6.terminal.state, 'timeout');
});

test('download finalize: a completed file is verified, hashed, named safely and unique, moved without overwriting, mode 0600', async () => {
  const m = manager();
  const crypto = require('node:crypto');
  const finish = async (guid, content, suggested, extra = {}) => {
    const file = path.join(m.dm.stageDir, guid);
    fs.writeFileSync(file, content);
    const j = job({ guid, suggested, received: content.length, totalBytes: content.length, completed: { filePath: file }, contentType: 'text/csv', ...extra });
    const result = {};
    await m.dm.finalize(j, result);
    return { j, result };
  };
  const a = await finish('ga', 'party,units\nAtlas,2480\n', 'report.csv');
  assert.deepEqual([a.result.state, a.result.name, a.result.size], ['done', 'report.csv', 23]);
  assert.equal(a.result.sha256, crypto.createHash('sha256').update('party,units\nAtlas,2480\n').digest('hex'));
  const b = await finish('gb', 'x', 'Report.CSV');
  assert.equal(b.result.name, 'Report (2).CSV', 'a name that differs only in case is a second file');
  const c = await finish('gc', 'y', '../../../tmp/pwned.txt');
  assert.equal(c.result.name, 'pwned.txt');
  assert.deepEqual(fs.readdirSync(m.dm.destDir).sort(), ['Report (2).CSV', 'pwned.txt', 'report.csv']);
  for (const name of fs.readdirSync(m.dm.destDir)) assert.equal(fs.statSync(path.join(m.dm.destDir, name)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(m.dm.stageDir), [], 'moved, not copied');
  assert.equal(fs.readFileSync(path.join(m.dm.destDir, 'report.csv'), 'utf8'), 'party,units\nAtlas,2480\n', 'the first file was not overwritten');
  assert.equal(m.dm.totalBytes, 23 + 1 + 1);
  /* refusals */
  const outside = path.join(m.dir, 'elsewhere.txt'); fs.writeFileSync(outside, 'secret');
  const j = job({ guid: 'gd', completed: { filePath: outside }, received: 6, totalBytes: 6 });
  await m.dm.finalize(j, {});
  assert.match(j.terminal.detail, /outside its download folder/);
  const link = path.join(m.dm.stageDir, 'ge'); fs.symlinkSync(outside, link);
  const j2 = job({ guid: 'ge', completed: { filePath: link }, received: 6, totalBytes: 6 });
  await m.dm.finalize(j2, {});
  assert.match(j2.terminal.detail, /not a regular file/);
  const d = await finish('gf', 'short', 'x.bin', { totalBytes: 50 });
  assert.equal(d.j.terminal.state, 'size-mismatch');
  assert.ok(!fs.existsSync(path.join(m.dm.destDir, 'x.bin')));
});

test('download events: a download nobody asked for is cancelled on sight; one a tab asked for is tracked by its guid', () => {
  const m = manager();
  m.dm.onBegin({ guid: 'stray', frameId: 'F9', url: 'https://x.example/a', suggestedFilename: 'a.bin' });
  assert.deepEqual([m.dm.stray, m.sent[0].method, m.sent[0].params.guid], [1, 'Browser.cancelDownload', 'stray']);
  const j = job({ received: 0, completed: null, totalBytes: 0 });
  m.dm.byFrame.set('F1', j);
  m.dm.onBegin({ guid: 'g1', frameId: 'F1', url: 'https://x.example/a', suggestedFilename: 'A.pdf' });
  assert.deepEqual([j.guid, j.suggested, m.dm.jobs.get('g1') === j, m.dm.byFrame.has('F1')], ['g1', 'A.pdf', true, false]);
  m.dm.onProgress({ guid: 'g1', totalBytes: 10, receivedBytes: 4, state: 'inProgress' });
  assert.deepEqual([j.totalBytes, j.received, j.completed], [10, 4, null]);
  m.dm.onProgress({ guid: 'g1', totalBytes: 10, receivedBytes: 10, state: 'completed', filePath: '/stage/g1' });
  assert.deepEqual(j.completed, { filePath: '/stage/g1' });
  m.dm.onProgress({ guid: 'unknown', totalBytes: 1, receivedBytes: 1, state: 'canceled' });
});

/* ---------------------------------------------------------------- the loader's own rules, without a browser */
const fakeChrome = (log = {}) => (binary, args) => {
  log.binary = binary; log.args = args;
  const child = new EventEmitter();
  child.stdio = [null, null, new PassThrough(), new PassThrough(), new PassThrough()];
  child.stderr = child.stdio[2];
  child.pid = undefined;
  setImmediate(() => { child.stderr.write(log.stderr || 'Failed to create SingletonLock: File exists'); child.emit('exit', 21, null); child.stdio[4].destroy(); });
  return child;
};
const exe = () => { const f = path.join(fresh('exe'), 'chrome'); fs.writeFileSync(f, '#!/bin/sh\n'); fs.chmodSync(f, 0o755); return f; };

test('createLinkLoader: needs an absolute root; the API has exactly start, get, continue, cancel, waitFor (and shutdown)', () => {
  assert.throws(() => createLinkLoader({}), /absolute path/);
  assert.throws(() => createLinkLoader({ root: 'relative/dir' }), /absolute path/);
  const loader = createLinkLoader({ root: fresh('root') });
  assert.deepEqual(Object.keys(loader).sort(), ['cancel', 'continue', 'get', 'shutdown', 'start', 'waitFor']);
  assert.equal(typeof loader.waitFor, 'function');
});

test('start: a refused link is a LinkError with a status and a code, nothing is created, nothing is launched', async () => {
  const root = fresh('root');
  const log = {};
  const loader = createLinkLoader({ root, chromePath: exe(), spawnFn: fakeChrome(log) });
  for (const [link, code] of [['http://tasks.atlas.example/t', 'scheme'], ['https://127.0.0.1/t', 'reserved-name'], ['https://10.0.0.1/t', 'ip-literal'], ['https://u:p@tasks.atlas.example/t', 'userinfo'], ['', 'empty'], [42, 'type']]) {
    assert.throws(() => loader.start(link), (e) => e instanceof LinkError && e.status === 400 && e.code === code);
  }
  assert.equal(log.binary, undefined);
  assert.ok(!fs.existsSync(path.join(root, 'private', 'links')), 'no folder for a refused link');
  assert.throws(() => loader.get('lnk-0123456789ab'), (e) => e instanceof LinkError && e.status === 404);
  for (const bad of ['', '../x', 'lnk-xyz', null, undefined, 'lnk-0123456789abc']) assert.throws(() => loader.get(bad), (e) => e.status === 404);
  assert.throws(() => loader.continue('lnk-0123456789ab'), (e) => e.status === 404);
  assert.throws(() => loader.cancel('lnk-0123456789ab'), (e) => e.status === 404);
  await assert.rejects(loader.waitFor('lnk-0123456789ab'), (e) => e.status === 404);
});

test('a launch that fails ends as failed with a plain message that holds no part of the link; the folder is 0700; the loader is free again', async () => {
  const root = fresh('root');
  const log = {};
  const loader = createLinkLoader({ root, chromePath: exe(), spawnFn: fakeChrome(log), headless: false });
  const link = 'https://tasks.atlas.example/t/1?X-Signature=CANARYSIG#CANARYFRAG';
  const id = loader.start(link);
  assert.match(id, /^lnk-[0-9a-f]{12}$/);
  const first = loader.get(id);
  assert.deepEqual(Object.keys(first).sort(), ['error', 'files', 'folder', 'id', 'message', 'notes', 'page', 'sections', 'skipped', 'state', 'toggle']);
  assert.deepEqual([first.state, first.page, first.error, first.files, first.skipped, first.sections], ['starting', { origin: 'https://tasks.atlas.example', path: '/t/1' }, null, [], [], []]);
  assert.deepEqual(first.toggle, { found: false, label: '', flipped: false, filesBefore: 0, filesAfter: 0, learned: false });
  assert.equal(first.folder, path.join(root, 'private', 'links', id));
  assert.equal(fs.statSync(first.folder).mode & 0o777, 0o700);
  assert.throws(() => loader.start(link), (e) => e.status === 409 && e.code === 'busy', 'one load at a time');
  const final = await loader.waitFor(id);
  assert.equal(final.state, 'failed');
  assert.match(final.message, /Quit the loader's Chrome \(Cmd\+Q\) and try again\./);
  assert.equal(final.error, final.message);
  for (const secret of ['CANARYSIG', 'CANARYFRAG', 'X-Signature']) assert.ok(!JSON.stringify(final).includes(secret) && !(log.args || []).join(' ').includes(secret), secret);
  assert.ok(!(log.args || []).includes('--headless=new') && !(log.args || []).includes('--no-sandbox'), 'visible by default, and the product never adds --no-sandbox');
  assert.equal(log.args[log.args.length - 1], 'about:blank');
  assert.equal(fs.statSync(path.join(root, 'private', 'link-profile')).mode & 0o777, 0o700);
  assert.deepEqual(loader.get(id), final, 'a final state does not change');
  final.state = 'tampered'; first.files.push('x');
  assert.equal(loader.get(id).state, 'failed', 'get returns a copy');
  assert.throws(() => loader.continue(id), (e) => e.status === 409 && e.code === 'not-waiting');
  assert.equal(loader.cancel(id).state, 'failed', 'cancel of a finished load changes nothing');
  assert.equal((await loader.waitFor(id)).state, 'failed');
  const again = loader.start(link);
  assert.notEqual(again, id);
  assert.equal((await loader.waitFor(again)).state, 'failed');
});

test('headless is a switch of the loader, and a Chrome that is not there or not safe to run is a failed load, not a crash', async () => {
  const log = {};
  const loader = createLinkLoader({ root: fresh('root'), chromePath: exe(), spawnFn: fakeChrome(log), headless: true });
  await loader.waitFor(loader.start('https://tasks.atlas.example/t/1'));
  assert.ok(log.args.includes('--headless=new'));

  const unsafe = path.join(fresh('exe'), 'chrome'); fs.writeFileSync(unsafe, '#!/bin/sh\n'); fs.chmodSync(unsafe, 0o777);
  const bad = createLinkLoader({ root: fresh('root'), chromePath: unsafe, spawnFn: fakeChrome({}) });
  const f = await bad.waitFor(bad.start('https://tasks.atlas.example/t/1'));
  assert.equal(f.state, 'failed');
  assert.match(f.message, /Chrome path/);

  const none = createLinkLoader({ root: fresh('root'), spawnFn: fakeChrome({}) });
  const saved = { a: process.env.FINANCE_STUDIO_CHROME, b: process.env.CHROME_BIN };
  delete process.env.FINANCE_STUDIO_CHROME; process.env.CHROME_BIN = path.join(scratch, 'nothing');
  try {
    const g = await none.waitFor(none.start('https://tasks.atlas.example/t/1'));
    if (!findChromeBinary()) { assert.equal(g.state, 'failed'); assert.match(g.message, /No Chrome or Chromium found/); }
  } finally {
    if (saved.a === undefined) delete process.env.FINANCE_STUDIO_CHROME; else process.env.FINANCE_STUDIO_CHROME = saved.a;
    if (saved.b === undefined) delete process.env.CHROME_BIN; else process.env.CHROME_BIN = saved.b;
  }
});

test('a spawn that throws is a failed load; cancel and shutdown on a load that is still starting end it as cancelled and leave nothing running', async () => {
  const throwing = createLinkLoader({ root: fresh('root'), chromePath: exe(), spawnFn: () => { throw new Error('spawn EACCES while opening https://tasks.atlas.example/t/1?sig=CANARY'); } });
  const f = await throwing.waitFor(throwing.start('https://tasks.atlas.example/t/1?sig=CANARY'));
  assert.equal(f.state, 'failed');
  assert.ok(!JSON.stringify(f).includes('CANARY'), 'a URL inside an error message is cut down');
  const log = {};
  const slow = (binary, args) => { const child = fakeChrome(log)(binary, args); return child; };
  const loader = createLinkLoader({ root: fresh('root'), chromePath: exe(), spawnFn: slow });
  const id = loader.start('https://tasks.atlas.example/t/1');
  const cancelling = loader.cancel(id);
  assert.deepEqual([cancelling.state, cancelling.message, cancelling.error], ['loading', 'Cancelling...', null], 'not final until Chrome is closed');
  assert.equal(loader.cancel(id).message, 'Cancelling...', 'cancelling twice is harmless');
  assert.throws(() => loader.continue(id), (e) => e.status === 409, 'nothing waits while cancelling');
  const done = await loader.waitFor(id);
  assert.deepEqual([done.state, done.message, done.error], ['cancelled', 'Cancelled.', null], 'a cancel wins over the failure that follows');
  const id2 = loader.start('https://tasks.atlas.example/t/2');
  await loader.shutdown();
  assert.equal(loader.get(id2).state, 'cancelled');
  await loader.shutdown();
});

test('limits can only be lowered by a test, never raised; timeouts can be changed', async () => {
  const loader = createLinkLoader({ root: fresh('root'), chromePath: exe(), spawnFn: fakeChrome({}), limits: { files: 10 ** 9, fileBytes: -5, totalBytes: 'x' }, timeouts: { signIn: 5 } });
  const { LIMITS, TIMEOUTS } = require('../backend/links/index.cjs');
  assert.deepEqual([LIMITS.files, LIMITS.fileBytes, LIMITS.totalBytes, LIMITS.sections, LIMITS.sectionChars], [300, 200 * 1024 * 1024, 2 * 1024 * 1024 * 1024, 200, 20000]);
  assert.deepEqual([TIMEOUTS.signIn, TIMEOUTS.person, TIMEOUTS.navigation], [600000, 600000, 30000]);
  await loader.waitFor(loader.start('https://tasks.atlas.example/t/1'));
});

/* ---------------------------------------------------------------- the sign-in window, the profile, macOS */
test('chrome args: the sign-in window has no debugging channel at all and opens only the origin; the headed flags are for visible windows only', () => {
  const win = chromeArgs({ profileDir: '/p/q', headless: false, url: 'https://tasks.atlas.example/', pipe: false });
  assert.ok(!win.some((a) => /remote-debugging/.test(a)), 'no pipe, no port');
  assert.deepEqual(win.filter((a) => !a.startsWith('--')), ['https://tasks.atlas.example/']);
  assert.ok(win.includes('--user-data-dir=/p/q') && win.includes('--restore-last-session'));
  for (const flag of ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']) {
    assert.ok(win.includes(flag) && chromeArgs({ profileDir: '/p', headless: false }).includes(flag), flag);
    assert.ok(!chromeArgs({ profileDir: '/p', headless: true }).includes(flag), flag + ' only for a visible window');
  }
  assert.ok(chromeArgs({ profileDir: '/p', headless: true, pipe: false }).includes('--headless=new'));
  assert.ok(!win.some((a) => /^--no-sandbox/.test(a)));
});
test('profile: the sign-in window cannot download (download_restrictions, a download folder inside the profile), no browser sign-in, no Safe Browsing', () => {
  const profile = fresh('prefs');
  prepareProfile(profile);
  const prefs = JSON.parse(fs.readFileSync(path.join(profile, 'Default', 'Preferences'), 'utf8'));
  assert.equal(prefs.download_restrictions, 3);
  assert.equal(prefs.download.default_directory, path.join(profile, 'quarantine'));
  assert.equal(prefs.download.prompt_for_download, false);
  assert.deepEqual([prefs.signin.allowed, prefs.safebrowsing.enabled, prefs.safebrowsing.enhanced, prefs.session.restore_on_startup], [false, false, false, 1]);
  assert.equal(fs.statSync(path.join(profile, 'quarantine')).mode & 0o777, 0o700);
});
test('profile: a lock left by a killed Chrome is removed, but only when no Chrome holds the profile', async () => {
  const profile = fresh('locks');
  const lock = () => { for (const n of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) { fs.rmSync(path.join(profile, n), { force: true }); fs.symlinkSync('host-12345', path.join(profile, n)); } };
  lock();
  assert.equal(chrome.holdsProfile(profile), false);
  prepareProfile(profile);
  for (const n of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) assert.throws(() => fs.lstatSync(path.join(profile, n)), /ENOENT/, n);
  const { spawn } = require('node:child_process');
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', '--', `--user-data-dir=${profile}`], { stdio: 'ignore' });
  try {
    await sleep(300);
    assert.equal(chrome.holdsProfile(profile), true, 'a process with the profile on its command line holds it');
    lock();
    prepareProfile(profile);
    assert.ok(fs.lstatSync(path.join(profile, 'SingletonLock')).isSymbolicLink(), 'a live Chrome\'s lock is left alone');
  } finally { holder.kill('SIGKILL'); }
});
test('signalTree: a group is signalled through its leader; a test double without a pid through its own kill(); pid 0 and 1 never', () => {
  const sent = [];
  assert.equal(chrome.signalTree({ pid: undefined, kill: (sig) => sent.push(sig) }, 'SIGINT'), true);
  assert.deepEqual(sent, ['SIGINT']);
  assert.equal(chrome.signalTree({ pid: 1, kill: (sig) => sent.push(sig) }, 'SIGTERM'), true, 'pid 1 is treated as a double: its kill(), never process.kill');
  assert.deepEqual(sent, ['SIGINT', 'SIGTERM']);
  assert.equal(chrome.signalTree({ pid: 0 }, 'SIGTERM'), false);
  assert.equal(chrome.signalTree({ pid: 2147483000 }, 'SIGTERM'), false, 'no such process');
});
function fakeWindowSpawn(log, behaviour = {}) {
  return (binary, args, options) => {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.pid = undefined;
    child.signals = [];
    child.kill = (signal) => {
      child.signals.push(signal);
      if (signal === (behaviour.exitsOn || 'SIGINT')) setImmediate(() => child.emit('exit', 0, signal));
      return true;
    };
    log.push({ binary, args, options, child });
    return child;
  };
}
test('launchWindow: the same binary and profile, no pipe, only the origin on the command line, an allow-listed environment; stop() is SIGINT first (Chrome writes its cookies), then SIGTERM, then the kill', async () => {
  const profile = fresh('win');
  const log = [];
  const secretEnv = { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-canary', HTTPS_PROXY: 'http://u:canary@proxy:3128' };
  const win = chrome.launchWindow({ binary: '/opt/fake/chrome', profileDir: profile, headless: false, spawnFn: fakeWindowSpawn(log), env: secretEnv, url: 'https://tasks.atlas.example/' });
  assert.equal(log[0].binary, '/opt/fake/chrome');
  assert.ok(!log[0].args.some((a) => /remote-debugging/.test(a)) && log[0].args.includes(`--user-data-dir=${profile}`));
  assert.equal(log[0].args[log[0].args.length - 1], 'https://tasks.atlas.example/');
  assert.deepEqual(log[0].options.stdio, ['ignore', 'ignore', 'pipe']);
  assert.equal(log[0].options.detached, true);
  assert.ok(!JSON.stringify(log[0].options.env).includes('canary'));
  assert.equal(win.hasExited(), false);
  await win.stop({ graceMs: 500 });
  assert.deepEqual(log[0].child.signals, ['SIGINT'], 'a window that exits on SIGINT is not signalled again');
  assert.equal(win.hasExited(), true);
  const stubborn = [];
  const win2 = chrome.launchWindow({ binary: '/opt/fake/chrome', profileDir: profile, headless: true, spawnFn: fakeWindowSpawn(stubborn, { exitsOn: 'SIGTERM' }), url: 'https://tasks.atlas.example/' });
  assert.ok(stubborn[0].args.includes('--headless=new'));
  await win2.stop({ graceMs: 30 });
  assert.deepEqual(stubborn[0].child.signals, ['SIGINT', 'SIGTERM']);
  assert.throws(() => chrome.launchWindow({ binary: null, profileDir: profile, spawnFn: fakeWindowSpawn([]), url: 'x' }), /No Chrome or Chromium found/);
  const failing = new EventEmitter(); failing.stderr = new PassThrough();
  const win3 = chrome.launchWindow({ binary: '/nope', profileDir: profile, spawnFn: () => failing, url: 'https://tasks.atlas.example/' });
  failing.emit('error', new Error('spawn ENOENT'));
  assert.deepEqual([win3.hasExited(), win3.error()], [true, 'spawn ENOENT']);
});
test('macOS: a Studio folder in a synced place is warned about; Spotlight and Time Machine are kept away from the profile and the load folders, once, failures ignored', () => {
  const home = '/Users/owner';
  for (const synced of ['/Users/owner/Documents/studio', '/Users/owner/Desktop', '/Users/owner/Library/Mobile Documents/com~apple~CloudDocs/x', '/Users/owner/Library/CloudStorage/OneDrive-Atlas/x', '/Users/owner/Dropbox/studio', '/Volumes/Work/OneDrive - Borealis/studio']) {
    assert.match(chrome.syncWarning(synced, home, 'darwin'), /may be synced or backed up/, synced);
  }
  for (const fine of ['/Users/owner/code/studio', '/Users/owner/DocumentsX/studio', '/Users/other/Documents/x']) assert.equal(chrome.syncWarning(fine, home, 'darwin'), '', fine);
  assert.equal(chrome.syncWarning('/Users/owner/Documents/studio', home, 'linux'), '', 'macOS only');
  assert.match(chrome.syncWarning('/Users/owner/Documents/studio', home, 'darwin'), /~\/Documents/);
  const priv = fresh('mac');
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); if (args[1].endsWith('bad')) throw new Error('tmutil missing'); };
  assert.deepEqual(chrome.protectStorage({ privateDir: priv, paths: ['/x/profile-1', '/x/bad'], platform: 'linux', run }), []);
  assert.deepEqual(calls, []);
  assert.ok(!fs.existsSync(path.join(priv, '.metadata_never_index')));
  assert.deepEqual(chrome.protectStorage({ privateDir: priv, paths: ['/x/profile-1', '/x/bad'], platform: 'darwin', run }), ['/x/profile-1']);
  assert.deepEqual(calls, [['tmutil', 'addexclusion', '/x/profile-1'], ['tmutil', 'addexclusion', '/x/bad']]);
  assert.ok(fs.existsSync(path.join(priv, '.metadata_never_index')));
  chrome.protectStorage({ privateDir: priv, paths: ['/x/profile-1'], platform: 'darwin', run });
  assert.equal(calls.length, 2, 'once per path');
});

/* ---------------------------------------------------------------- the sign-in classifier, more */
test('classify: MFA, verification and magic-link steps are not the task page; the refusal page of an identity provider is named', () => {
  const { LOGIN_PATH_RE, CHALLENGE_RE, REFUSED_RE } = require('../backend/links/auth-wall.cjs');
  for (const p of ['/mfa', '/auth/verify', '/2fa/', '/two-factor', '/challenge', '/otp', '/check-email', '/magic/abc', '/sessions/new', '/authenticator', '/login']) assert.ok(LOGIN_PATH_RE.test(p), p);
  for (const p of ['/tasks/atlas-001', '/verification-report', '/files/mfa-notes.pdf', '/magical']) assert.ok(!LOGIN_PATH_RE.test(p), p);
  for (const t of ['Enter the code we sent you', 'Approve this sign-in on your phone', 'Check your email', 'Use your authenticator app', 'MFA required', 'Click the magic link']) assert.ok(CHALLENGE_RE.test(t), t);
  assert.ok(!CHALLENGE_RE.test('Quarterly bridge for Atlas'));
  for (const t of ['This browser or app may not be secure.', 'Couldn\'t sign you in', 'Try using a different browser']) assert.ok(REFUSED_RE.test(t), t);
  const mfa = classifyPage({ ...base, finalUrl: 'https://tasks.atlas.example/mfa', hops: [{ rawUrl: 'https://tasks.atlas.example/t/1', status: 302 }, { rawUrl: 'https://tasks.atlas.example/mfa', status: 200 }], snapshot: snap({ title: 'Enter the code', headings: [{ level: 1, text: 'Enter the code' }] }) });
  assert.equal(mfa.state, 'needs-person');
  const rejected = classifyPage({ ...base, finalUrl: 'https://accounts.google.com/signin/rejected?x=1', hops: [{ rawUrl: 'https://tasks.atlas.example/t/1', status: 302 }, { rawUrl: 'https://accounts.google.com/signin/rejected?x=1', status: 200 }], snapshot: snap({ title: 'Sign in', headings: [] }) });
  assert.equal(rejected.state, 'needs-sign-in');
  assert.ok(rejected.signals.includes('sign-in-refused') && /refused/.test(rejected.reason) && /separate Chrome window/.test(rejected.reason));
  const worded = classifyPage({ ...base, snapshot: snap({ sections: [{ heading: '', text: 'Couldn\'t sign you in. This browser or app may not be secure.' }] }) });
  assert.ok(worded.signals.includes('sign-in-refused') && worded.state === 'needs-sign-in');
});
test('cleanLabel: control, bidi and zero-width characters out, blanks folded, cut', () => {
  assert.equal(cleanLabel('Re\u202eport\u200b  Q3\u0000.xlsx\n'), 'Re port Q3 .xlsx');
  assert.equal(cleanLabel(null), '');
  assert.equal(cleanLabel('x'.repeat(500), 20).length, 20);
});

/* ---------------------------------------------------------------- the store, with a key */
test('mapping store: a control without a label is remembered by its id or data-testid; a label alone, a key alone, both; neither is refused', () => {
  const file = path.join(fresh('mapkey'), 'm.json');
  const iso = '2026-10-23T12:00:00.000Z';
  assert.equal(store.learnToggle(file, 'a.example', '', iso, 'id:allFilesSwitch'), true);
  assert.deepEqual(store.learnedToggleInfo(file, 'a.example'), { label: '', key: 'id:allFilesSwitch' });
  assert.equal(store.learnedToggle(file, 'a.example'), null, 'no label to give');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).hosts['a.example'], { updatedAt: iso, allFilesToggleKey: 'id:allFilesSwitch' });
  assert.equal(store.learnToggle(file, 'b.example', 'Show all files', iso, 'testid:all'), true);
  assert.deepEqual(store.learnedToggleInfo(file, 'b.example'), { label: 'Show all files', key: 'testid:all' });
  assert.equal(store.learnToggle(file, 'c.example', 'Show all files', iso), true);
  assert.deepEqual(store.learnedToggleInfo(file, 'c.example'), { label: 'Show all files', key: '' });
  for (const bad of [['', ''], ['', 'class:x'], ['', 'id:'], ['', 'id:a b'], ['', 'id:' + 'x'.repeat(81)], ['', 'testid:a\u0000b']]) assert.equal(store.learnToggle(file, 'd.example', bad[0], iso, bad[1]), false, JSON.stringify(bad));
  assert.equal(store.learnedToggleInfo(file, 'd.example'), null);
  fs.writeFileSync(file, JSON.stringify({ schema: 'finance-link-mappings', version: 1, hosts: { 'e.example': { updatedAt: iso, allFilesToggleKey: 'javascript:alert(1)' } } }));
  assert.equal(store.learnedToggleInfo(file, 'e.example'), null, 'a bad key on disk makes the whole store empty');
  fs.writeFileSync(file, JSON.stringify({ schema: 'finance-link-mappings', version: 1, hosts: { 'e.example': { updatedAt: iso } } }));
  assert.equal(store.learnedToggleInfo(file, 'e.example'), null, 'an entry that says nothing is invalid');
});
test('changedToggle: select options and tabs share a path, so the option number tells them apart', () => {
  const o = (label, checked, option) => ({ label, checked, path: 'select#view', option, kind: 'option' });
  assert.equal(changedToggle([o('Added', true, 0), o('All files', false, 1)], [o('Added', false, 0), o('All files', true, 1)]).label, 'All files');
  assert.equal(changedToggle([o('Added', true, 0), o('All files', false, 1)], [o('Added', true, 0), o('All files', false, 1)]), null);
});

/* ---------------------------------------------------------------- downloads, more */
test('downloads: a stall with every byte already there is Chrome holding the file as possibly unsafe; any other stall stays a stall', async () => {
  const m = manager({ maxFileBytes: 10000, maxTotalBytes: 100000, idleMs: 100, pollMs: 10 });
  const held = job({ guid: 'h1', received: 500, totalBytes: 500, lastGrowthAt: Date.now() - 1000, startedAt: Date.now() - 1000 });
  m.dm.jobs.set('h1', held);
  fs.writeFileSync(path.join(m.dm.stageDir, 'h1.crdownload'), Buffer.alloc(500));
  await m.dm.waitTerminal(held);
  assert.deepEqual(held.terminal, { state: 'held-by-chrome', detail: 'Chrome held the file as possibly unsafe' });
  const half = job({ guid: 'h2', received: 100, totalBytes: 500, lastGrowthAt: Date.now() - 1000, startedAt: Date.now() - 1000 });
  m.dm.jobs.set('h2', half);
  fs.writeFileSync(path.join(m.dm.stageDir, 'h2.crdownload'), Buffer.alloc(100));
  await m.dm.waitTerminal(half);
  assert.equal(half.terminal.state, 'stalled');
});
test('downloads: five failures in a row stop the step with a reason and hand back what was not tried; a success resets the count; the whole step has a time budget', async () => {
  const m = manager({ stopAfter: 5, phaseMs: 60000 });
  const outcome = (name) => (name.startsWith('bad') ? { state: 'http-error', detail: null } : { state: 'done', name, size: 1, sha256: 'x' });
  m.dm.fetchOne = async (c) => outcome(c.label);
  const run = (names, extra) => m.dm.fetchAll(names.map((label) => ({ label })), extra);
  const a = await run(['bad1', 'bad2', 'ok1', 'bad3', 'bad4', 'bad5', 'bad6', 'bad7', 'late1', 'late2']);
  assert.equal(a.results.length, 8, 'the ok in the middle reset the count');
  assert.match(a.stopped, /^5 files in a row could not be downloaded \(http-error\)$/);
  assert.deepEqual(a.rest.map((c) => c.label), ['late1', 'late2']);
  const b = await run(['ok1', 'ok2']);
  assert.deepEqual([b.stopped, b.rest.length, b.results.length], [null, 0, 2]);
  const seen = [];
  await run(['ok1'], { onFile: (r, c) => seen.push([r.state, c.label]) });
  assert.deepEqual(seen, [['done', 'ok1']]);
  const ac = new AbortController(); ac.abort();
  assert.equal((await run(['ok1'], { signal: ac.signal })).results.length, 0);
  m.dm.limits.phaseMs = -1;
  const t = await run(['ok1', 'ok2']);
  assert.deepEqual([t.results.length, t.stopped, t.rest.length], [0, 'the time for the file step ran out', 2]);
});
test('downloads: a window a click opens is adopted so its download is tracked, and closed when the job ends; without a click job nothing is adopted', async () => {
  const m = manager();
  assert.equal(m.dm.adoptPopup('P1'), false);
  m.dm.clickJob = job();
  assert.equal(m.dm.adoptPopup('P1'), true);
  assert.equal(m.dm.byFrame.get('P1'), m.dm.clickJob);
  m.dm.onBegin({ guid: 'gp', frameId: 'P1', url: 'https://x.example/a', suggestedFilename: 'A.pdf' });
  assert.equal(m.dm.clickJob.guid, 'gp', 'the download that began in the window belongs to the click');
  await m.dm.closePopups();
  assert.ok(m.sent.some((c) => c.method === 'Target.closeTarget' && c.params.targetId === 'P1'));
  assert.equal(m.dm.popups.size, 0);
});

/* ---------------------------------------------------------------- click candidates: where they are found, what is checked, what is retried */
function clickTab(results = [{ ok: true }]) {
  const calls = [];
  return { calls, frameId: 'F1', net: { hops: [] }, evalFn: async (fn, arg) => { calls.push(arg); return results[Math.min(calls.length - 1, results.length - 1)]; } };
}
test('downloads: a click candidate is located first (the page is put into its view), then pressed under its kind with its text, its row and its file name; a link is pressed as a link, with its address', async () => {
  const m = manager({ gapMs: 0, beginTimeoutMs: 20, pollMs: 5 });
  const tab = clickTab();
  const seen = [];
  m.dm.locate = async (c) => { seen.push(c.label); return { ok: true, path: 'table > tr:nth-of-type(7) > button' }; };
  const button = { mode: 'click', kind: 'button', text: 'Download', label: 'Atlas_Rows.csv 1 KB', nameHint: 'Atlas_Rows.csv', path: 'old > path', pageTab: tab };
  const r = await m.dm.fetchOne({ ...button });
  assert.equal(r.state, 'no-download', 'nothing began: reported, not hidden');
  assert.match(r.detail, /pressed once and not again/);
  assert.deepEqual(seen, ['Atlas_Rows.csv 1 KB']);
  assert.equal(tab.calls.length, 1, 'a click that began no download is never pressed again');
  assert.equal(tab.calls[0].op, 'activate');
  assert.deepEqual([tab.calls[0].path, tab.calls[0].kind, tab.calls[0].label, tab.calls[0].row, tab.calls[0].name], ['table > tr:nth-of-type(7) > button', 'download', 'Download', 'Atlas_Rows.csv 1 KB', 'Atlas_Rows.csv'], 'the path is the one found NOW, not the old one');
  const link = clickTab();
  await m.dm.fetchOne({ mode: 'click', kind: 'link', text: 'Reset policy.pdf', label: 'Reset policy.pdf', nameHint: 'Reset policy.pdf', href: 'https://x.test/f/Reset_policy.pdf', path: 'a', pageTab: link });
  assert.deepEqual([link.calls[0].kind, link.calls[0].href], ['link', 'https://x.test/f/Reset_policy.pdf'], 'a link is pressed as a link and must still have the address it was listed with');
  const blob = clickTab();
  await m.dm.fetchOne({ mode: 'click', kind: 'link', text: 'Blob', label: 'Blob', href: null, path: 'a', pageTab: blob });
  assert.ok(!('href' in blob.calls[0]), 'a blob address exists only in the page: the page side checks that it is one');
  const lost = clickTab();
  m.dm.locate = async () => ({ ok: false, why: 'the file is no longer on the page (its row could not be found again)' });
  const gone = await m.dm.fetchOne({ ...button, pageTab: lost });
  assert.deepEqual([gone.state, gone.detail], ['failed', 'the file is no longer on the page (its row could not be found again)']);
  assert.equal(lost.calls.length, 0, 'a row that cannot be found is never clicked');
  const wrong = clickTab([{ ok: false, why: 'the row of the element is no longer the one that was listed' }]);
  m.dm.locate = async () => ({ ok: true, path: 'p' });
  const refused = await m.dm.fetchOne({ ...button, pageTab: wrong });
  assert.deepEqual([refused.state, refused.detail], ['failed', 'the row of the element is no longer the one that was listed']);
});
test('downloads: downloads are paced; a click that began no download is pressed once, whatever the control', async () => {
  const m = manager({ gapMs: 40, beginTimeoutMs: 15, pollMs: 5 });
  const tab = clickTab();
  m.dm.locate = async () => ({ ok: true, path: 'p' });
  const first = await m.dm.fetchOne({ mode: 'click', kind: 'button', text: 'Download', label: 'A.txt', nameHint: 'A.txt', path: 'p', pageTab: tab });
  const t0 = Date.now();
  const second = await m.dm.fetchOne({ mode: 'click', kind: 'button', text: 'Download', label: 'B.txt', nameHint: 'B.txt', path: 'p', pageTab: tab });
  assert.deepEqual([first.state, second.state], ['no-download', 'no-download']);
  assert.equal(tab.calls.length, 2, 'one press each');
  assert.ok(Date.now() - t0 >= 40, 'the second job waited out the gap');
  const link = clickTab();
  const nav = await m.dm.fetchOne({ mode: 'click', kind: 'link', text: 'x', label: 'x', path: 'p', pageTab: link });
  assert.equal(nav.state, 'no-download');
  assert.equal(link.calls.length, 1);
});
test('downloads: while a control is pressed in the task page every request that is not a read is failed before it leaves the browser; the job ends as blocked-write and the control is not pressed again', async () => {
  const m = manager({ gapMs: 0, beginTimeoutMs: 2000, pollMs: 5 });
  const sent = []; const handlers = {};
  const tab = clickTab();
  tab.s = { on: (method, handler) => { handlers[method] = handler; return () => { delete handlers[method]; }; }, send: async (method, params) => { sent.push([method, params]); return {}; } };
  tab.evalFn = async (fn, arg) => {   /* the page's script POSTs when the control is pressed, and also reads something */
    tab.calls.push(arg);
    await handlers['Fetch.requestPaused']({ requestId: 'r1', request: { method: 'GET', url: 'https://x.test/api/list', postData: 'SECRET' } });
    await handlers['Fetch.requestPaused']({ requestId: 'r2', request: { method: 'POST', url: 'https://x.test/api/files/7/export', postData: 'SECRET' } });
    return { ok: true };
  };
  m.dm.locate = async () => ({ ok: true, path: 'p' });
  const r = await m.dm.fetchOne({ mode: 'click', kind: 'button', text: 'Download', label: 'Q3.txt', nameHint: 'Q3.txt', path: 'p', pageTab: tab });
  assert.equal(r.state, 'blocked-write');
  assert.match(r.detail, /sent a POST request instead of downloading; it was blocked and not pressed again/);
  assert.equal(tab.calls.length, 1);
  assert.deepEqual(sent.map(([method, params]) => [method, params && (params.requestId || params.patterns && 'patterns')]), [['Fetch.enable', 'patterns'], ['Fetch.continueRequest', 'r1'], ['Fetch.failRequest', 'r2'], ['Fetch.disable', undefined]]);
  assert.equal(sent.find(([method]) => method === 'Fetch.failRequest')[1].errorReason, 'BlockedByClient');
  assert.ok(!JSON.stringify(sent).includes('SECRET'), 'the body of a request is never looked at');
  assert.deepEqual(Object.keys(handlers), [], 'and the guard is off again');
});

/* ---------------------------------------------------------------- the Chrome that cannot start, the profile that is scrubbed on every way out */
test('a Chrome that does not start is reported as that, with its output (cut down), not as a window the owner closed; the profile is scrubbed', async () => {
  const root = fresh('root');
  const profile = path.join(root, 'private', 'link-profile');
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'Default', 'History'), 'https://tasks.atlas.example/t/1?X-Signature=CANARYHIST');
  const log = { stderr: 'Missing X server or $DISPLAY\nThe platform failed to initialize. Exiting. https://tasks.atlas.example/t/1?sig=CANARYERR' };
  const loader = createLinkLoader({ root, chromePath: exe(), spawnFn: fakeChrome(log), headless: false });
  const final = await loader.waitFor(loader.start('https://tasks.atlas.example/t/1'));
  assert.equal(final.state, 'failed');
  assert.match(final.message, /^Chrome did not start\. Missing X server or \$DISPLAY/);
  assert.doesNotMatch(final.message, /closed before the load finished|CANARYERR|sig=/);
  assert.equal(final.error, final.message);
  assert.ok(!fs.existsSync(path.join(profile, 'Default', 'History')), 'a launch that failed still forgets where the profile has been');
});
/* ---------------------------------------------------------------- source rules */
const sources = fs.readdirSync(path.join(__dirname, '..', 'backend', 'links')).filter((n) => n.endsWith('.cjs')).map((n) => [n, fs.readFileSync(path.join(__dirname, '..', 'backend', 'links', n), 'utf8')]);
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
test('source: the loader never turns on the Runtime domain, never touches cookies or storage, never adds --no-sandbox, never logs, runs no shell', () => {
  assert.ok(sources.length >= 10);
  for (const [name, text] of sources) {
    const c = code(text);
    assert.ok(!/Runtime\.enable/.test(c), `${name}: Runtime.enable`);
    assert.ok(!/(getCookies|getAllCookies|setCookie|deleteCookies|clearBrowserCookies|Storage\.)/.test(c), `${name}: cookie or storage method`);
    assert.ok(!/--no-sandbox|--remote-debugging-port|--remote-debugging-address|--disable-web-security|--ignore-certificate|--use-mock-keychain/.test(c), `${name}: a forbidden Chrome switch`);
    assert.ok(!/\bconsole\.|process\.stdout|process\.stderr/.test(c), `${name}: logging`);
    assert.ok(!/shell:\s*true|(^|[^.\w])exec(Sync|File)?\(|\.exec(Sync|File)\(|xdg-open|(^|[^.\w])open\(/.test(c.replace(/static async open\(/g, '')), `${name}: shell or open`);
    assert.ok(!/Cookies|Login Data|Local State|\.config\/google-chrome|Application Support\/Google/.test(c.replace(/'Cookies'/g, '')), `${name}: a path in the person's own Chrome profile`);
    assert.ok(!/[^\x00-\x7f]/.test(text), `${name}: plain ASCII`);
  }
  const spawners = sources.filter(([, text]) => /require\('node:child_process'\)/.test(text)).map(([name]) => name).sort();
  assert.deepEqual(spawners, ['chrome.cjs'], 'child_process is imported by the Chrome launcher only');
  assert.ok(!sources.some(([name, text]) => name !== 'chrome.cjs' && /\bspawn(Sync)?\(/.test(code(text)) && name !== 'chrome.cjs'));
});
test('source: no part of the page, the link or the person is ever spliced into evaluated code', () => {
  for (const [name, text] of sources) {
    const evals = code(text).match(/evalIsolated\([^)]*\)/g) || [];
    for (const call of evals) assert.ok(!/\$\{|\+/.test(call) || name === 'tab.cjs', `${name}: ${call}`);
  }
  const tabSource = code(fs.readFileSync(path.join(__dirname, '..', 'backend', 'links', 'tab.cjs'), 'utf8'));
  assert.ok(/evalFn\(fn, arg, options\) \{ return this\.evalIsolated\(`\(\$\{fn\.toString\(\)\}\)\(\$\{JSON\.stringify\(/.test(tabSource), 'evalFn is the one place code is built, and its argument is JSON');
});
