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
const { chromeArgs, browserEnv, findChromeBinary, usableBinary, prepareProfile, scrubProfile } = require('../backend/links/chrome.cjs');
const { gateTab, attachmentHeader } = require('../backend/links/gate.cjs');
const { fileCandidates, findAllFilesToggle, TOGGLE_LABEL_RE, NEVER_TEXT_RE, NEVER_HREF_RE } = require('../backend/links/page.cjs');
const { validateLink, fileUrlAllowed, hostProblem } = require('../backend/links/url.cjs');
const store = require('../backend/links/store.cjs');
const { Tab, safeUrl, safeText } = require('../backend/links/tab.cjs');
const { DownloadManager, pickName } = require('../backend/links/downloads.cjs');
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
test('toggle label: the words that say "all files", and nothing else', () => {
  for (const yes of ['Show all files', 'show ALL files', 'All files', 'Include all files', 'Include world files', 'World files', 'Show all', 'Show all attachments', 'Include all', 'All attachments', 'all downloads', 'Display world  files', 'Show all\nfiles']) assert.ok(TOGGLE_LABEL_RE.test(yes), yes);
  for (const no of ['Advanced view', 'Dark mode', 'Notify me', 'Show files', 'Showall', 'All', 'Callfiles', 'overall filesystem usage?', 'Download', 'Show details', 'Remember me', '', 'worldfiles', 'Include archived']) assert.ok(!TOGGLE_LABEL_RE.test(no), no);
  assert.ok(TOGGLE_LABEL_RE.test('x'.repeat(100000) + ' all files') && !TOGGLE_LABEL_RE.test('all '.repeat(20000)), 'no catastrophic backtracking');
  assert.equal(exportedRe, TOGGLE_LABEL_RE);
  assert.equal(exportedFinder, findAllFilesToggle);
});
test('findAllFilesToggle: an unchecked, enabled switch whose label matches; the learned label first; checked and disabled ones never', () => {
  const t = (label, checked = false, extra = {}) => ({ label, checked, disabled: false, path: `#${label}`, kind: 'switch', ...extra });
  assert.equal(findAllFilesToggle([t('Dark mode', true), t('Notify me'), t('Show all files')], null).label, 'Show all files');
  assert.equal(findAllFilesToggle([t('Show all files', true)], null), null, 'already on: nothing to switch');
  assert.equal(findAllFilesToggle([t('Show all files', false, { disabled: true })], null), null);
  assert.equal(findAllFilesToggle([t('Advanced view'), t('Show all files')], 'advanced view').label, 'Advanced view', 'learned label wins, trimmed and case-insensitive');
  assert.equal(findAllFilesToggle([t('Advanced view')], null), null);
  assert.equal(findAllFilesToggle([t('Show all files')], 'Gone from the page').label, 'Show all files', 'a learned label that is no longer there falls back to the words');
  assert.equal(findAllFilesToggle([t('Advanced view', true), t('Show all files')], 'Advanced view').label, 'Show all files', 'a learned switch that is already on is not clicked again');
  assert.equal(findAllFilesToggle([t('Include all'), t('Show all files')], null).label, 'Include all', 'first match in page order');
  assert.equal(findAllFilesToggle([], null), null);
  assert.equal(findAllFilesToggle(null, null), null);
  assert.equal(findAllFilesToggle([null, { label: 5 }, t('World files')], '').label, 'World files');
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
test('candidates: files, not actions; Archive_2026.zip stays, "Delete file" and /logout go; buttons in forms go; the group and label come along', () => {
  const link = (text, href, extra = {}) => ({ text, href, rawHref: href, scheme: 'https:', fileLike: true, why: ['extension'], nameHint: text, ext: 'zip', path: 'a', download: null, group: 'Task files', ...extra });
  const s = {
    url: 'https://x.example/t',
    links: [link('Archive_2026.zip', 'https://x.example/f/Archive_2026.zip'), link('Delete file', 'https://x.example/f/1/delete'), link('Sign out', 'https://x.example/logout'), link('Approved_Budget.xlsx', 'https://x.example/f/b.xlsx', { group: 'World files' }), link('same', 'https://x.example/f/b.xlsx'),
      link('Odd', 'javascript:alert(1)', { scheme: 'javascript:' }), link('Plain page', 'https://x.example/about', { fileLike: false })],
    buttons: [{ text: 'Notes.txt', fileLike: true, disabled: false, inForm: false, dataUrl: '/f/n.txt', ext: 'txt', path: 'button', group: 'Task files' }, { text: 'Download all', fileLike: true, disabled: false, inForm: true, dataUrl: null, path: 'b2' }, { text: 'Remove Notes.txt', fileLike: true, disabled: false, inForm: false, path: 'b3' }, { text: 'Gone.txt', fileLike: true, disabled: true, path: 'b4' }],
  };
  const list = fileCandidates(s);
  assert.deepEqual(list.map((c) => c.text), ['Archive_2026.zip', 'Approved_Budget.xlsx', 'Notes.txt']);
  assert.deepEqual(list.map((c) => [c.mode, c.group, c.label]), [['navigate', 'Task files', 'Archive_2026.zip'], ['navigate', 'World files', 'Approved_Budget.xlsx'], ['click', 'Task files', 'Notes.txt']]);
  assert.equal(list[2].href, 'https://x.example/f/n.txt');
  assert.ok(NEVER_TEXT_RE.test('Cancel booking') && !NEVER_TEXT_RE.test('Cancelled_Orders.csv'));
  assert.ok(NEVER_TEXT_RE.test('Delete file') && NEVER_TEXT_RE.test('Sign out') && !NEVER_TEXT_RE.test('Archive_2026.zip') && !NEVER_TEXT_RE.test('Approved_Budget.xlsx'));
  assert.ok(NEVER_HREF_RE.test('/x?action=delete') && NEVER_HREF_RE.test('/files/12/remove') && NEVER_HREF_RE.test('/logout') && !NEVER_HREF_RE.test('/files/removed.csv'));
  assert.deepEqual(fileCandidates({ url: 'https://x.example/', links: [], buttons: [] }), []);
  assert.deepEqual(fileCandidates({ url: 'https://x.example/' }), []);
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
    el('UL', {}, [el('LI', {}, [link('Atlas_Prompt.txt', '/files/prompt')]), el('LI', {}, [link('About us', '/about')]), el('LI', {}, [link('Delete file', '/files/1/delete')])]),
    el('BUTTON', { role: 'switch', 'aria-checked': 'false', id: 't' }, [text('Show all files')]),
    el('BUTTON', { 'aria-pressed': 'true', id: 'p' }, [text('Compact view')]),
    el('DIV', { role: 'switch', 'aria-checked': 'false', 'aria-label': 'Advanced view', id: 'a' }, []),
    el('INPUT', { id: 'c', type: 'checkbox' }, [], { type: 'checkbox', checked: true, labels: [el('LABEL', {}, [text('Remember me')])] }),
    el('BUTTON', { id: 'dl' }, [text('Notes.txt')], { form: null }),
  ]);
  Object.assign(doc, { body, documentElement: body, title: 'Atlas', readyState: 'complete', querySelectorAll: (sel) => (sel === '*' ? flat(body) : []), querySelector: () => null });
  return doc;
}
test('extractPage: self-contained (it is sent to the page as text); sections at headings, hidden and script text left out, file links with their heading, switches with label and state, secret-looking fields not read', () => {
  const { extractPage, LIMITS } = require('../backend/links/page.cjs');
  const doc = fakeDocument();
  const sandbox = { document: doc, location: { href: 'https://tasks.atlas.example/t/1', origin: 'https://tasks.atlas.example' }, performance: { now: () => 0 }, CSS: { escape: (s) => s }, URL, URLSearchParams };
  const out = vm.runInNewContext(`(${extractPage.toString()})(${JSON.stringify({ limits: LIMITS })})`, sandbox);
  const result = JSON.parse(JSON.stringify(out));
  assert.deepEqual(result.sections.map((s) => s.heading), ['Atlas task', 'Business prompt', 'Notes', 'Task files']);
  const by = Object.fromEntries(result.sections.map((s) => [s.heading, s.text]));
  assert.equal(by['Business prompt'], 'Prepare the bridge. Be brief.');
  assert.ok(!JSON.stringify(result.sections).includes('Hidden text') && !JSON.stringify(result.sections).includes('var secret') && !JSON.stringify(result).includes('color: red'));
  assert.equal(by.Notes, 'Reviewer note: Check the freight credit.');
  assert.ok(!JSON.stringify(result).includes('HIDDEN-SECRET') && !JSON.stringify(result).includes('hunter2'), 'a secret-looking field and a password are never read');
  assert.match(by['Task files'], /Atlas_Prompt\.txt/);
  assert.deepEqual(result.links.map((l) => [l.text, l.group, l.fileLike, l.href]), [['Atlas_Prompt.txt', 'Task files', true, 'https://tasks.atlas.example/files/prompt'], ['Delete file', 'Task files', true, 'https://tasks.atlas.example/files/1/delete']], 'only links that look like files; /about is not one');
  assert.deepEqual(result.toggles.map((t) => [t.label, t.checked, t.kind]), [['Show all files', false, 'switch'], ['Compact view', true, 'pressed'], ['Advanced view', false, 'switch'], ['Remember me', true, 'checkbox']]);
  assert.equal(findAllFilesToggle(result.toggles, null).label, 'Show all files');
  assert.equal(findAllFilesToggle(result.toggles, 'advanced view').label, 'Advanced view');
  assert.deepEqual(result.buttons.map((b) => [b.text, b.group]), [['Notes.txt', 'Task files']]);
  assert.deepEqual(fileCandidates(result).map((c) => [c.mode, c.label]), [['navigate', 'Atlas_Prompt.txt'], ['click', 'Notes.txt']], 'the Delete link is dropped by the candidate rules');
  assert.deepEqual([result.signals.hasPasswordField, result.signals.hasOtpField, result.signals.hasCaptcha, result.linkCount, result.title, result.url], [true, false, false, 3, 'Atlas', 'https://tasks.atlas.example/t/1']);
  assert.ok(result.controlCount >= 1);
  assert.equal(typeof result.signals.bodyTextChars, 'number');
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
test('chrome binary: FINANCE_STUDIO_CHROME, then CHROME_BIN, absolute and executable and not writable by others; the macOS apps are on the list', () => {
  const dir = fresh('bin');
  const make = (name, mode) => { const f = path.join(dir, name); fs.writeFileSync(f, '#!/bin/sh\n'); fs.chmodSync(f, mode); return f; };
  const a = make('a', 0o755); const b = make('b', 0o755); const writable = make('w', 0o777); const noexec = make('n', 0o644);
  assert.equal(findChromeBinary({ FINANCE_STUDIO_CHROME: a, CHROME_BIN: b }), a);
  assert.equal(findChromeBinary({ CHROME_BIN: b }), b);
  assert.notEqual(findChromeBinary({ FINANCE_STUDIO_CHROME: writable, CHROME_BIN: noexec }), writable, 'a world-writable binary is not used');
  assert.ok(![writable, noexec, 'relative/chrome', '', undefined, path.join(dir, 'missing'), dir].some((f) => usableBinary(f)));
  assert.equal(usableBinary(a), true);
  const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'links', 'chrome.cjs'), 'utf8');
  assert.ok(source.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') && source.includes('/Applications/Chromium.app/Contents/MacOS/Chromium'));
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
  assert.deepEqual(Object.keys(first).sort(), ['error', 'files', 'folder', 'id', 'message', 'page', 'sections', 'state', 'toggle']);
  assert.deepEqual([first.state, first.page, first.error, first.files, first.sections], ['starting', { origin: 'https://tasks.atlas.example', path: '/t/1' }, null, [], []]);
  assert.deepEqual(first.toggle, { found: false, label: '', flipped: false, filesBefore: 0, filesAfter: 0, learned: false });
  assert.equal(first.folder, path.join(root, 'private', 'links', id));
  assert.equal(fs.statSync(first.folder).mode & 0o777, 0o700);
  assert.throws(() => loader.start(link), (e) => e.status === 409 && e.code === 'busy', 'one load at a time');
  const final = await loader.waitFor(id);
  assert.equal(final.state, 'failed');
  assert.match(final.message, /already open/);
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
  const cancelled = loader.cancel(id);
  assert.deepEqual([cancelled.state, cancelled.message, cancelled.error], ['cancelled', 'Cancelled.', null]);
  assert.equal((await loader.waitFor(id)).state, 'cancelled', 'a cancel wins over the failure that follows');
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
