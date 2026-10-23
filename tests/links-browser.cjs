/* Optional developer QA for the link loader (not part of npm test). Starts a synthetic task platform on loopback (invented content only:
   Atlas, Meridian, Borealis) and drives backend/links/index.cjs against it with a real Chromium on a temporary project root, so the
   project's own private/ folder is never read or written. No model is involved anywhere. The test adds --no-sandbox through spawnFn only
   when it runs as root (the product never does). Windows are headless, except one scenario that runs headed under Xvfb when it is there.

   The platform: a sign-in redirect (a session cookie without an expiry, so the test also proves it survives Chrome's restart), an MFA step
   that takes 5 s, task pages whose "Show all files" control is a switch, a switch whose label is the text beside it, a switch that is
   already on, a <select>, a switch with an unrelated label, a switch with no label at all, and pages without any; files in a closed
   <details>, behind a tab, in a virtualised list, in a same-origin iframe, added late, behind a "Download" button in a table row, as a
   blob: link; a 404, a presigned file on a second origin, a hostile file name, two names that differ only in case, an inline PDF, a link
   that only works with a referrer, a redirect to an address the loader must not open, files over the caps, and links that must never
   be requested (Delete, Sign out, javascript:, file:, an address written as numbers). The "person" is the page itself: it polls a test
   endpoint and submits the sign-in form, clicks its own switch or closes its own window when told to.

   Covered: the whole flow in both sign-in modes. Piped: needs-sign-in with the network domain off, an MFA step that is waited out
   (two polls on the task page itself). Window (the default): the loader's Chrome is closed, the same binary opens the same profile with
   no debugging channel and only the origin, the person signs in, SIGINT makes Chrome write its cookies, the loader's Chrome opens
   again; a faked window (spawnFn) for the handshake, the repeat-once-then-fail rule, a window that exits by itself, a profile already in
   use; a closed window; headed flags and Page.bringToFront. Finding files: the switch by label, by sibling text, by learned label or
   id, already on, a <select>, needs-person then continue, expanders, tabs, scrolling, iframes, late changes, slow growth, zero files,
   five failures in a row, a failed file (skipped, needs-person), a 401 retried as a click. Plus: cancel (waiting, mid-download), a 404,
   timeouts, Chrome killed, the caps, names and hashes, and the privacy rules: no Runtime.enable and no cookie method on the wire,
   downloads denied before the first navigation, the link and its query string nowhere (argv, state, page.json, ps, the profile after
   the scrub), an allow-listed environment, a 0700 profile, files 0600, no Chrome left behind.

   Environment: CHROME_BIN (default /opt/pw-browsers/chromium-1194/chrome-linux/chrome when it exists), KEEP=1 keeps the temporary folder. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const { createLinkLoader, LinkError } = require('../backend/links/index.cjs');
const { listProcesses } = require('../backend/links/chrome.cjs');

const defaultChrome = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const chromePath = process.env.CHROME_BIN || (fs.existsSync(defaultChrome) ? defaultChrome : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const det = (seed, size) => Buffer.from(crypto.createHash('sha256').update(seed).digest('hex').repeat(Math.ceil(size / 64))).subarray(0, size);
const SECRET_SIG = 'SECRETSIG0123456789';
const SECRET_QUERY = 'CANARYQ9876543210';
const SECRET_FRAGMENT = 'FRAGCANARY77';
const SIGNIN_WINDOW_MESSAGE = 'Sign in in the Chrome window that opened (look for the new Chrome icon in the Dock if you do not see it). When the platform shows you are signed in, press Continue here.';
const PERSON_MESSAGE = 'Turn on the option that shows all files in the Chrome window, then press Continue.';
const checks = [];
const finals = [];
const ok = (label) => { checks.push(label); };

/* ---------------------------------------------------------------- the synthetic platform */
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const text = (name, body, extra = {}) => ({ name, type: 'text/plain', body: Buffer.from(body), disp: `attachment; filename="${name}"`, ...extra });
const FILES = {
  prompt: { name: 'Atlas_Prompt.txt', type: 'text/plain; charset=utf-8', body: Buffer.from('Atlas prompt: build the Q3 variance bridge for Borealis Holdings.\n'), disp: 'attachment; filename="Atlas_Prompt.txt"' },
  brief: { name: 'Atlas_Brief.pdf', type: 'application/pdf', body: Buffer.concat([Buffer.from('%PDF-1.4\n'), det('brief', 3000)]), disp: null },   /* inline: Chrome would show it, the loader forces a download */
  workbook: { name: 'Atlas_Workbook.xlsx', type: XLSX, body: det('workbook', 40000), disp: 'attachment; filename="Atlas_Workbook.xlsx"' },
  report: { name: 'report.csv', type: 'text/csv', body: Buffer.from('party,units\nAtlas,2480\n'), disp: 'attachment; filename="report.csv"' },
  ledger: { name: 'World_Ledger.csv', type: 'text/csv', body: Buffer.from('account,balance\nMeridian,100\n'), disp: 'attachment; filename="World_Ledger.csv"' },
  hostile: { name: 'hostile', type: 'text/plain', body: Buffer.from('a file whose name tries to leave its folder\n'), disp: 'attachment; filename="../../../tmp/pwned.txt"' },
  report2: { name: 'Report.CSV', type: 'text/csv', body: Buffer.from('party,units\nMeridian,0\n'), disp: 'attachment; filename="Report.CSV"' },
  adv1: text('Borealis_Rates.txt', 'rates v1\n'),
  adv2: text('Borealis_Curve.txt', 'curve v1\n'),
  adv3: text('Borealis_Notes.txt', 'notes v1\n'),
  adv4: text('Borealis_Extra.txt', 'extra v1\n'),
  rows: { name: 'Atlas_Rows.csv', type: 'text/csv', body: Buffer.from('row,value\n1,10\n'), disp: 'attachment; filename="Atlas_Rows.csv"' },
  gated: text('Atlas_Gated.txt', 'only with a referrer\n'),
  'frame-a': text('Frame_A.txt', 'frame a\n'),
  'frame-b': text('Frame_B.txt', 'frame b\n'),
  'late-a': text('Late_A.txt', 'late a\n'),
  'late-b': text('Late_B.txt', 'late b\n'),
  htmlfile: { name: 'Atlas_Page.pdf', type: 'text/html', body: Buffer.from('<html><body>Please sign in</body></html>'), disp: null },
  'cap-a': { name: 'cap_a.bin', type: 'application/octet-stream', body: det('cap-a', 600 * 1024), disp: 'attachment; filename="cap_a.bin"' },
  'cap-b': { name: 'cap_b.bin', type: 'application/octet-stream', body: det('cap-b', 600 * 1024), disp: 'attachment; filename="cap_b.bin"' },
  'cap-c': { name: 'cap_c.bin', type: 'application/octet-stream', body: det('cap-c', 600 * 1024), disp: 'attachment; filename="cap_c.bin"' },
  'cap-d': { name: 'cap_d.bin', type: 'application/octet-stream', body: det('cap-d', 1024), disp: 'attachment; filename="cap_d.bin"' },
  'cap-big': { name: 'cap_big.bin', type: 'application/octet-stream', body: det('cap-big', 3 * 1024 * 1024), disp: 'attachment; filename="cap_big.bin"', length: true },   /* announced with Content-Length */
  'cap-fast': { name: 'cap_fast.bin', type: 'application/octet-stream', body: det('cap-fast', 2 * 1024 * 1024), disp: 'attachment; filename="cap_fast.bin"' },   /* chunked and quick: done before the next poll */
  'cap-stream': { name: 'cap_stream.bin', type: 'application/octet-stream', body: null, disp: 'attachment; filename="cap_stream.bin"' },
  offsite: { name: 'Offsite.txt', type: 'text/plain', body: Buffer.from('x'), disp: null },
  gone: { name: 'Gone.pdf', type: 'application/pdf', body: Buffer.from('x'), disp: null },
};
for (let n = 1; n <= 10; n += 1) FILES[`vf-${n}`] = text(`Report_${String(n).padStart(2, '0')}.txt`, `virtual row ${n}\n`);
const STREAM_TOTAL = 8 * 1024 * 1024;

async function startPlatform() {
  const sessions = new Set();
  const person = { signin: false, flips: new Set() };
  const flags = { openAccess: false, mfa: false };
  const requests = [];
  const stats = { streamSent: 0, trapRequests: 0, deleteRequests: 0, mfaDoneAt: 0 };
  const servers = [];
  const listen = (handler, host) => new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, host, () => { servers.push(server); resolve(server); });
  });
  const send = (res, status, type, body, headers = {}) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers }); res.end(body); };
  const cookieOf = (req, name) => { const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || ''); return m ? m[1] : null; };
  const startSession = (res, next) => {
    const token = crypto.randomBytes(12).toString('hex');
    sessions.add(token);
    res.writeHead(302, { location: next, 'set-cookie': `sid=${token}; Path=/; HttpOnly; SameSite=Lax` });   /* no expiry: a session cookie */
    res.end();
  };
  const safeNext = (value) => String(value || '/').replace(/[^A-Za-z0-9/_%?=&.-]/g, '');

  let trap = null;
  try { trap = await listen((req, res) => { stats.trapRequests += 1; send(res, 200, 'text/plain', 'trap'); }, '127.0.0.2'); } catch (e) { trap = null; }   /* some systems have no 127.0.0.2 */
  const files = await listen((req, res) => {
    const u = new URL(req.url, 'http://x');
    requests.push({ origin: 'files', method: req.method, path: u.pathname, cookie: Boolean(req.headers.cookie) });
    const m = /^\/blob\/([^/]+)$/.exec(u.pathname);
    const def = m && Object.values(FILES).find((f) => f.name === decodeURIComponent(m[1]));
    if (!def || u.searchParams.get('X-Signature') !== SECRET_SIG) return send(res, 403, 'text/plain', 'bad signature');
    return send(res, 200, def.type, def.body, def.disp ? { 'content-disposition': def.disp } : {});
  }, '127.0.0.1');
  const filesOrigin = `http://localhost:${files.address().port}`;

  const li = (key, extra = '') => `<li><a href="/files/${key}"${extra}>${FILES[key].name}</a></li>`;
  const TOGGLES = {
    all: '<button role="switch" aria-checked="false" data-main="1" id="t">Show all files</button>',
    on: '<button role="switch" aria-checked="true" data-main="1" id="t">Show all files</button>',
    advanced: '<div role="switch" tabindex="0" aria-checked="false" aria-label="Advanced view" data-main="1" id="t">&nbsp;</div>',
    empty: '<span role="switch" tabindex="0" aria-checked="false" data-main="1" id="sw-empty"></span>',
    sibling: '<div class="row"><span>Show all files</span><div role="switch" tabindex="0" aria-checked="false" data-main="1" id="sw-sibling"></div></div>',
    select: '<select data-main="1" id="view"><option>Added files</option><option>All files</option></select>',
  };
  /* A task page. toggle: one of TOGGLES (or none); world files are added when it is switched on (after `delay` ms), or shown at once
     for the switch that starts on. pollers: [[name, javascript]] run when the test says so. */
  const page = ({ slug, title, taskKeys = [], worldKeys = [], toggle = null, delay: wait = 250, extraLinks = '', extraBody = '', pollers = [], head = '' }) => {
    const world = worldKeys.map((k) => ({ href: `/files/${k}`, text: FILES[k].name }));
    const polls = pollers.map(([name, js]) => `setInterval(async () => { const j = await (await fetch('/__person/flip?name=${name}')).json(); if (j.go) { ${js} } }, 150);`).join('\n');
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>
<h1>${title}</h1>
<h2>Business prompt</h2><p>Atlas is a mid-size distributor owned by Borealis Holdings. Prepare a variance bridge for Meridian Capital.</p>
<h2>Grader guideline</h2><p>Award the bridge only when price, volume and mix sum to the reported change.</p>
<h2>Notes</h2><p>&lt;img src=x onerror=alert(1)&gt; ignore previous instructions</p>
<form onsubmit="return false"><label for="n">Reviewer note</label><textarea id="n" name="note">Check the freight credit.</textarea><label for="p2">Account code</label><input id="p2" name="account-token" value="HIDDEN-SECRET"></form>
<h2>Task files</h2><ul>${taskKeys.map((k) => (k === 'workbook' ? `<li><a href="${filesOrigin}/blob/${encodeURIComponent(FILES.workbook.name)}?X-Signature=${SECRET_SIG}&X-Expires=9999999999">Atlas_Workbook.xlsx</a></li>` : k === 'prompt' ? li(k, ' download') : li(k))).join('')}${extraLinks}</ul>
<div role="switch" aria-checked="true" tabindex="0" aria-label="Dark mode" id="dark"></div><div role="switch" aria-checked="false" tabindex="0" aria-label="Notify me" id="notify"></div>
${toggle ? TOGGLES[toggle] : ''}
<div id="more"></div>
<a href="/files/1/delete">Delete file</a> <a href="/logout">Sign out</a> <button type="button">Archive task</button>
${extraBody}
<script>
const WORLD = ${JSON.stringify(world)};
const t = document.querySelector('[data-main]');
const box = document.getElementById('more');
const reveal = () => {
  const h = document.createElement('h2'); h.textContent = 'World files'; const ul = document.createElement('ul');
  for (const w of WORLD) { const item = document.createElement('li'); const a = document.createElement('a'); a.href = w.href; a.textContent = w.text; item.append(a); ul.append(item); }
  box.append(h, ul);
};
if (t && t.tagName === 'SELECT') t.addEventListener('change', () => { box.replaceChildren(); if (t.selectedIndex === 1) setTimeout(reveal, ${wait}); });
else if (t) t.addEventListener('click', () => {
  const on = t.getAttribute('aria-checked') !== 'true';
  t.setAttribute('aria-checked', String(on));
  box.replaceChildren();
  if (on) setTimeout(reveal, ${wait});
});
${toggle === 'on' ? 'reveal();' : ''}
${polls}
</script></body></html>`;
  };
  const tableRow = '<table><tr><td>Atlas_Rows.csv </td><td>1 KB </td><td><button type="button" data-url="/files/rows" id="rowdl">Download</button></td></tr></table>';
  const rowScript = `document.getElementById('rowdl').addEventListener('click', () => { const a = document.createElement('a'); a.href = '/files/rows'; a.download = ''; document.body.append(a); a.click(); a.remove(); });`;
  const PAGES = {
    'atlas-001': () => page({ slug: 'atlas-001', title: 'Atlas task', taskKeys: ['prompt', 'brief', 'workbook', 'report'], worldKeys: ['ledger', 'hostile', 'report2'], toggle: 'all' }),
    'borealis-013': () => page({ slug: 'borealis-013', title: 'Borealis task', taskKeys: ['prompt', 'report'], worldKeys: ['adv1', 'adv2'], toggle: 'advanced', pollers: [['borealis-013', 't.click();']] }),
    'meridian-020': () => page({ slug: 'meridian-020', title: 'Meridian task', taskKeys: ['prompt'], worldKeys: ['adv3'], toggle: 'empty', pollers: [['meridian-020', 't.click();']] }),
    'plain-030': () => page({ slug: 'plain-030', title: 'Plain task', taskKeys: ['prompt', 'report'], extraBody: `<script>alert('Atlas banner'); confirm('Leave this page?');</script>`, }),   /* dialogs freeze a page until someone answers */
    'caps-040': () => page({ slug: 'caps-040', title: 'Caps task', taskKeys: ['cap-a', 'cap-big'], worldKeys: ['cap-stream', 'cap-fast', 'cap-b', 'cap-c', 'cap-d'], toggle: 'all' }),
    'sibling-050': () => page({ slug: 'sibling-050', title: 'Sibling task', taskKeys: ['prompt', 'report'], worldKeys: ['adv1', 'adv2'], toggle: 'sibling' }),
    'on-051': () => page({ slug: 'on-051', title: 'Already on task', taskKeys: ['prompt', 'report'], worldKeys: ['adv1', 'adv2'], toggle: 'on' }),
    'select-052': () => page({ slug: 'select-052', title: 'Select task', taskKeys: ['prompt', 'report'], worldKeys: ['adv1', 'adv2'], toggle: 'select' }),
    'panels-053': () => page({
      slug: 'panels-053', title: 'Panels task', taskKeys: ['prompt'], toggle: 'on',
      extraBody: `<h2>More</h2><div role="tablist"><button role="tab" aria-selected="true" id="tab-a">Task</button><button role="tab" aria-selected="false" id="tab-b">Reference</button></div>
<div id="panel-a"><p>Task panel</p></div><div id="panel-b" hidden><h2>Reference files</h2><ul><li><a href="/files/adv1">Borealis_Rates.txt</a></li></ul></div>
<details><summary>More files</summary><ul><li><a href="/files/adv2">Borealis_Curve.txt</a></li></ul></details>
${tableRow}<script>
for (const [tab, panel, other, otherPanel] of [['tab-a', 'panel-a', 'tab-b', 'panel-b'], ['tab-b', 'panel-b', 'tab-a', 'panel-a']]) document.getElementById(tab).addEventListener('click', () => {
  document.getElementById(tab).setAttribute('aria-selected', 'true'); document.getElementById(other).setAttribute('aria-selected', 'false');
  document.getElementById(panel).hidden = false; document.getElementById(otherPanel).hidden = true;
});
${rowScript}
</script>`,
    }),
    'virtual-054': () => page({
      slug: 'virtual-054', title: 'Virtual list task', toggle: 'on',
      extraBody: `<h2>Rows</h2><div id="vbox" style="height:120px;overflow:auto;position:relative;width:300px"><div id="spacer"></div></div><script>
const N = 10, H = 40, box = document.getElementById('vbox');
document.getElementById('spacer').style.height = (N * H) + 'px';
function render() {
  const first = Math.floor(box.scrollTop / H);
  box.querySelectorAll('.vrow').forEach((r) => r.remove());
  for (let i = first; i < Math.min(N, first + 4); i += 1) {
    const a = document.createElement('a'); a.className = 'vrow'; a.href = '/files/vf-' + (i + 1); a.textContent = 'Report_' + String(i + 1).padStart(2, '0') + '.txt';
    a.style.cssText = 'position:absolute;left:0;top:' + (i * H) + 'px;height:' + H + 'px;display:block'; box.append(a);
  }
}
box.addEventListener('scroll', render); render();
</script>`,
    }),
    'iframe-055': () => page({ slug: 'iframe-055', title: 'Iframe task', taskKeys: ['prompt'], toggle: 'on', extraBody: '<h2>Frame</h2><iframe src="/frame/files" style="width:420px;height:200px"></iframe>' }),
    'nofiles-056': () => page({ slug: 'nofiles-056', title: 'No files task', toggle: 'on' }),
    'late-057': () => page({
      slug: 'late-057', title: 'Late task', taskKeys: ['prompt'], toggle: 'on',
      extraBody: `<script>
setTimeout(() => { const a = document.createElement('a'); a.href = '/files/late-a'; a.textContent = 'Late_A.txt'; const item = document.createElement('li'); item.append(a); document.querySelector('ul').append(item); }, 1200);
setTimeout(() => { const a = document.createElement('a'); a.href = '/files/late-b'; a.textContent = 'Late_B.txt'; const item = document.createElement('li'); item.append(a); document.querySelector('ul').append(item); }, 2000);
</script>`,
    }),
    'slow-058': () => page({ slug: 'slow-058', title: 'Slow task', taskKeys: ['prompt'], worldKeys: ['adv1', 'adv2'], toggle: 'all', delay: 2600 }),
    'stop-059': () => page({ slug: 'stop-059', title: 'Stop task', toggle: 'on', extraLinks: Array.from({ length: 7 }, (_, i) => `<li><a href="/files/gone-${i + 1}">Missing_${i + 1}.txt</a></li>`).join('') }),
    'edge-060': () => page({
      slug: 'edge-060', title: 'Edge task', taskKeys: ['prompt', 'offsite', 'gone', 'htmlfile', 'gated'], worldKeys: ['adv4'], toggle: 'all',
      pollers: [['stray', `const a = document.createElement('a'); a.href = '/files/prompt'; a.download = 'stray.txt'; document.body.append(a); a.click(); a.remove();`]],
      extraBody: `<button type="button" id="blob">Atlas_Blob.txt</button><script>
document.getElementById('blob').addEventListener('click', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['blob content from the page\\n'], { type: 'text/plain' })); a.download = 'Atlas_Blob.txt'; document.body.append(a); a.click(); a.remove(); });
</script>`,
      extraLinks: '<li><a href="javascript:alert(1)" download>evil.pdf</a></li><li><a href="file:///etc/passwd" download>passwd.txt</a></li><li><a href="https://127.0.0.2:22/x.pdf">x.pdf</a></li><li><a href="https://10.0.0.5/y.pdf">y.pdf</a></li>',
    }),
  };

  const main = await listen((req, res) => {
    const u = new URL(req.url, 'http://x');
    const signedIn = flags.openAccess || sessions.has(cookieOf(req, 'sid'));
    requests.push({ origin: 'main', method: req.method, path: u.pathname, cookie: Boolean(req.headers.cookie), at: Date.now() });
    if (u.pathname === '/__person/signin') return send(res, 200, 'application/json', JSON.stringify({ go: person.signin }));
    if (u.pathname === '/__person/flip') return send(res, 200, 'application/json', JSON.stringify({ go: person.flips.delete(u.searchParams.get('name')) }));   /* once: a person clicks once */
    if (u.pathname === '/') {
      if (!signedIn) { res.writeHead(302, { location: '/login?next=%2F' }); return res.end(); }
      return send(res, 200, 'text/html; charset=utf-8', '<!doctype html><title>Home</title><h1>Home</h1><p>You are signed in.</p>');
    }
    if (u.pathname === '/login' && req.method === 'GET') {
      return send(res, 200, 'text/html; charset=utf-8', `<!doctype html><title>Sign in</title><h1>Sign in</h1>
<form id="f" method="post" action="/login"><input type="hidden" name="next" value="${safeNext(u.searchParams.get('next'))}"><label>User <input name="user" value="owner"></label><label>Password <input type="password" name="password" value="synthetic"></label><button>Sign in</button></form>
<script>setInterval(async () => { const j = await (await fetch('/__person/signin')).json(); if (j.go) document.getElementById('f').submit(); }, 150);</script>`);
    }
    if (u.pathname === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        person.signin = false;
        const next = decodeURIComponent(new URLSearchParams(body).get('next') || '/');
        if (flags.mfa) { res.writeHead(302, { location: `/mfa?next=${encodeURIComponent(next)}` }); return res.end(); }
        return startSession(res, next);
      });
      return undefined;
    }
    if (u.pathname === '/mfa') {
      const next = safeNext(u.searchParams.get('next'));
      return send(res, 200, 'text/html; charset=utf-8', `<!doctype html><title>Verify</title><h1>Enter the code we sent you</h1><p>Approve this sign-in to continue.</p><script>setTimeout(() => { location.href = '/mfa/done?next=' + encodeURIComponent(${JSON.stringify(next)}); }, 5000);</script>`);
    }
    if (u.pathname === '/mfa/done') { stats.mfaDoneAt = Date.now(); return startSession(res, decodeURIComponent(safeNext(u.searchParams.get('next')))); }
    if (u.pathname === '/frame/files') return send(res, 200, 'text/html; charset=utf-8', `<!doctype html><h3>Inside the frame</h3><ul>${li('frame-a')}${li('frame-b')}</ul>`);
    const task = /^\/tasks\/([a-z0-9-]+)$/.exec(u.pathname);
    if (task) {
      if (!signedIn) { res.writeHead(302, { location: `/login?next=${encodeURIComponent(u.pathname)}` }); return res.end(); }
      if (task[1] === 'missing-404') return send(res, 404, 'text/html; charset=utf-8', '<h1>Not found</h1>');
      if (!PAGES[task[1]]) return send(res, 404, 'text/html', 'no such task');
      return send(res, 200, 'text/html; charset=utf-8', PAGES[task[1]]());
    }
    const file = /^\/files\/([a-z0-9-]+)$/.exec(u.pathname);
    if (/\/delete$|^\/logout$/.test(u.pathname)) { stats.deleteRequests += 1; return send(res, 200, 'text/plain', 'done'); }
    if (file) {
      if (!signedIn) return send(res, 401, 'text/plain', 'sign in');
      const key = file[1];
      if (key === 'offsite') { res.writeHead(302, { location: `http://127.0.0.2:${trap ? trap.address().port : 9}/secret` }); return res.end(); }
      if (key === 'gone' || /^gone-\d+$/.test(key)) return send(res, 404, 'text/plain', 'gone');
      if (key === 'gated' && !req.headers.referer) return send(res, 401, 'text/plain', 'a referrer is needed');   /* a bare navigation has none, a click in the page does */
      if (key === 'cap-stream') {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': FILES['cap-stream'].disp });   /* chunked: no Content-Length */
        const chunk = det('stream', 64 * 1024);
        const timer = setInterval(() => { if (stats.streamSent >= STREAM_TOTAL || res.destroyed) { clearInterval(timer); return res.end(); } stats.streamSent += chunk.length; res.write(chunk); return undefined; }, 20);
        res.on('close', () => clearInterval(timer));
        return undefined;
      }
      const def = FILES[key];
      if (!def || !def.body) return send(res, 404, 'text/plain', 'no such file');
      return send(res, 200, def.type, def.body, { ...(def.disp ? { 'content-disposition': def.disp } : {}), ...(def.length ? { 'content-length': def.body.length } : {}) });
    }
    return send(res, 404, 'text/plain', 'not found');
  }, '127.0.0.1');
  const origin = `http://127.0.0.1:${main.address().port}`;
  return {
    origin, filesOrigin, requests, stats, hasTrap: Boolean(trap), flags,
    signOut: () => sessions.clear(),
    sessionCount: () => sessions.size,
    signIn: () => { person.signin = true; },
    flip: (name) => person.flips.add(name),
    unflip: (name) => person.flips.delete(name),
    count: (pathname, method = 'GET') => requests.filter((r) => r.origin === 'main' && r.path === pathname && r.method === method).length,
    close: () => Promise.all(servers.map((s) => new Promise((resolve) => { s.closeAllConnections(); s.close(resolve); }))),
  };
}

/* ---------------------------------------------------------------- the test harness */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-links-qa-'));
const calls = [];   /* every CDP method the loader sent, in order */
const pipes = [];   /* the loader's Chromes, newest last */
const spawns = [];  /* every browser the loader started: { kind: 'pipe' | 'window', args } */
const fakeWindow = { on: false, children: [], stderr: '' };   /* on: the sign-in window is a test double, not a Chrome */
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const spawnFn = (binary, args, options) => {
  const isWindow = !args.includes('--remote-debugging-pipe');
  spawns.push({ kind: isWindow ? 'window' : 'pipe', args: [...args] });
  if (isWindow && fakeWindow.on) {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.pid = undefined;
    child.signals = [];
    child.kill = (signal) => { child.signals.push(signal); setImmediate(() => child.emit('exit', 0, signal)); return true; };
    fakeWindow.children.push(child);
    if (fakeWindow.stderr) setImmediate(() => { child.stderr.write(fakeWindow.stderr); child.emit('exit', 21, null); });
    return child;
  }
  const child = spawn(binary, isRoot ? [...args.slice(0, -1), '--no-sandbox', args[args.length - 1]] : args, options);
  if (!isWindow) {
    const pipe = child.stdio[3]; const write = pipe.write.bind(pipe);
    pipe.write = (chunk, ...rest) => { try { calls.push(JSON.parse(String(chunk).replace(/\0$/, '')).method); } catch (e) { /* not a command */ } return write(chunk, ...rest); };
    /* the "person" can also act through the same pipe (a second voice with ids of its own): close the tab the way clicking its x does */
    const waiters = new Map(); let buffered = Buffer.alloc(0); let seq = 0;
    child.stdio[4].on('data', (data) => {
      buffered = Buffer.concat([buffered, data]);
      for (let at = buffered.indexOf(0); at >= 0; at = buffered.indexOf(0)) {
        const raw = buffered.subarray(0, at).toString('utf8'); buffered = buffered.subarray(at + 1);
        try { const msg = JSON.parse(raw); if (waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); } } catch (e) { /* not for us */ }
      }
    });
    child.person = (method, params = {}) => new Promise((resolve) => { seq += 1; waiters.set(1e9 + seq, resolve); write(JSON.stringify({ id: 1e9 + seq, method, params }) + '\0'); });
    pipes.push(child);
  }
  return child;
};
const fixedClock = () => new Date('2026-10-23T12:00:00.000Z');
const loaders = [];
const makeLoader = (root, extra = {}) => {
  const { timeouts, ...rest } = extra;
  const loader = createLinkLoader({
    root, chromePath, spawnFn, clock: fixedClock, headless: true, allowLoopback: true, signIn: 'piped',
    timeouts: { poll: 100, settle: 2500, begin: 8000, stall: 5000, stable: [150, 300], grow: 3000, expand: 15000, ...(timeouts || {}) }, ...rest,
  });
  loaders.push(loader);
  return loader;
};
const profileOf = (root) => path.join(root, 'private', 'link-profile');
const mainProcess = (profile, pipe) => listProcesses().find((p) => p.cmd.includes(`--user-data-dir=${profile}`) && !/--type=/.test(p.cmd) && p.cmd.includes('--remote-debugging-pipe') === pipe);
const group = (profile) => {
  const main = mainProcess(profile, true);
  return main ? { main, all: listProcesses().filter((p) => p.pgid === main.pid) } : null;
};
const leftovers = (profile) => listProcesses().filter((p) => !p.state.startsWith('Z') && p.cmd.includes(profile));

/* Poll a load; run handlers[state] once, the first time that state is seen (handlers may be async; polling waits for them). */
async function drive(loader, id, handlers = {}, limitMs = 120000) {
  const seen = [];
  const end = Date.now() + limitMs;
  for (;;) {
    const state = loader.get(id);
    if (!seen.includes(state.state)) {
      seen.push(state.state);
      if (handlers[state.state]) await handlers[state.state](state);
    }
    if (['done', 'failed', 'cancelled'].includes(state.state)) { const final = await loader.waitFor(id); finals.push(final); return { final, seen }; }
    if (Date.now() > end) throw new Error(`load did not finish; states seen: ${seen.join(', ')}; last: ${JSON.stringify(state)}`);
    await delay(50);
  }
}
const until = async (condition, label, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (condition()) return; await delay(25); } throw new Error('Timed out waiting for ' + label); };
const filesOnDisk = (state) => fs.readdirSync(path.join(state.folder, 'files')).sort();
const labels = (state) => state.files.map((f) => f.label).sort();
const walk = (dir) => { const out = []; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, e.name); if (e.isDirectory()) out.push(...walk(full)); else if (e.isFile()) out.push(full); } return out; };
const truthByName = Object.fromEntries(Object.values(FILES).filter((f) => f.body).map((f) => [f.name, sha(f.body)]));
const toggle = (found, label, flipped, filesBefore, filesAfter, learned) => ({ found, label, flipped, filesBefore, filesAfter, learned });

(async () => {
  let platform; let failure = null; let xvfb = null;
  const canaryEnv = { FINANCE_STUDIO_PILOT_TOKEN: 'canary-pilot-token-0001', ANTHROPIC_API_KEY: 'sk-canary-0002', HTTPS_PROXY: 'http://user:canary0003@proxy.example:3128' };
  const savedDisplay = process.env.DISPLAY;
  try {
    Object.assign(process.env, canaryEnv);
    platform = await startPlatform();
    const root = path.join(tmp, 'project');
    fs.mkdirSync(root);
    const loader = makeLoader(root);
    const profile = profileOf(root);

    /* 1. Refusals before any browser starts. */
    const strict = makeLoader(root, { allowLoopback: false });
    for (const [link, code] of [['http://tasks.atlas.example/t/1', 'scheme'], ['https://user:pw@tasks.atlas.example/t', 'userinfo'], ['https://10.1.2.3/t', 'ip-literal'], ['https://localhost/t', 'reserved-name'], ['https://printer.local/t', 'reserved-name'], ['javascript:alert(1)', 'scheme'], ['', 'empty']]) {
      assert.throws(() => strict.start(link), (e) => e instanceof LinkError && e.status === 400 && e.code === code && !e.message.includes('printer') && !e.message.includes('tasks.atlas'), link);
    }
    assert.throws(() => strict.start(`${platform.origin}/tasks/atlas-001`), (e) => e.code === 'reserved-name', 'loopback links are refused unless the loader was built for tests');
    assert.throws(() => loader.get('lnk-000000000000'), (e) => e.status === 404);
    assert.throws(() => loader.get('../../etc'), (e) => e.status === 404);
    assert.equal(calls.length, 0, 'no browser was started by a refused link');
    ok('refused links (scheme, user info, numeric host, internal names, empty) give 400 with a code and never echo the link; unknown ids give 404; nothing was launched');

    /* 2. The whole flow in the loader's own window: sign-in, the show-all-files switch, 7 files. */
    const url1 = `${platform.origin}/tasks/atlas-001?ref=${SECRET_QUERY}#${SECRET_FRAGMENT}`;
    const id1 = loader.start(url1);
    assert.match(id1, /^lnk-[0-9a-f]{12}$/);
    assert.throws(() => loader.start(url1), (e) => e instanceof LinkError && e.status === 409 && e.code === 'busy');
    assert.throws(() => loader.continue(id1), (e) => e.status === 409 && e.code === 'not-waiting', 'continue before anything waits');
    let spied = null;
    const run1 = await drive(loader, id1, {
      'needs-sign-in': async (state) => {
        await until(() => calls.includes('Network.disable'), 'the network domain to be switched off for the sign-in');
        const g = group(profile);
        assert.ok(g, 'Chrome is running on the loader profile');
        spied = {
          argv: g.main.cmd, groupSize: g.all.length, environ: [], profileMode: fs.statSync(profile).mode & 0o777,
          ps: listProcesses().map((p) => p.cmd).join('\n'), state: JSON.stringify(state), message: state.message,
        };
        if (fs.existsSync('/proc')) for (const p of g.all) { try { spied.environ.push(fs.readFileSync(`/proc/${p.pid}/environ`, 'utf8')); } catch (e) { /* gone */ } }
        spied.callsBeforeSignIn = calls.slice();
        platform.signIn();
      },
    });
    const s1 = run1.final;
    assert.equal(s1.state, 'done', JSON.stringify(s1));
    assert.deepEqual(run1.seen.filter((x) => x !== 'starting'), ['needs-sign-in', 'loading', 'downloading', 'done'], run1.seen.join());
    assert.deepEqual(Object.keys(s1).sort(), ['error', 'files', 'folder', 'id', 'message', 'page', 'sections', 'skipped', 'state', 'toggle']);
    assert.deepEqual([s1.error, s1.skipped], [null, []]);
    assert.deepEqual(s1.page, { origin: platform.origin, path: '/tasks/atlas-001' });
    assert.equal(s1.folder, path.join(root, 'private', 'links', id1));
    assert.deepEqual(s1.toggle, toggle(true, 'Show all files', true, 4, 7, false));
    ok('flow: starting, needs-sign-in, loading, downloading, done; the state has the specified keys plus skipped; the switch "Show all files" was found by its label, clicked, and the file count went from 4 to 7');
    assert.equal(s1.files.length, 7);
    for (const f of s1.files) {
      assert.deepEqual(Object.keys(f).sort(), ['group', 'label', 'name', 'sha256', 'size']);
      assert.equal(fs.statSync(path.join(s1.folder, 'files', f.name)).size, f.size);
      assert.equal(fs.statSync(path.join(s1.folder, 'files', f.name)).mode & 0o777, 0o600, 'files are 0600');
      assert.equal(sha(fs.readFileSync(path.join(s1.folder, 'files', f.name))), f.sha256);
    }
    const byLabel = Object.fromEntries(s1.files.map((f) => [f.label, f]));
    for (const label of ['Atlas_Prompt.txt', 'Atlas_Brief.pdf', 'Atlas_Workbook.xlsx', 'World_Ledger.csv']) assert.equal(byLabel[label].sha256, truthByName[label], `${label} equals what the server sent`);
    assert.deepEqual([byLabel['Atlas_Prompt.txt'].group, byLabel['Atlas_Workbook.xlsx'].group, byLabel['World_Ledger.csv'].group], ['Task files', 'Task files', 'World files'], 'group is the heading above the file');
    assert.deepEqual(filesOnDisk(s1), s1.files.map((f) => f.name).sort(), 'the folder holds exactly the listed files');
    ok('7 files (4 task files, 3 world files revealed by the switch, an inline PDF forced to a download, a presigned file on a second origin) are on disk with the sha256 and size the server sent, mode 0600, with their group heading and label');
    const names = s1.files.map((f) => f.name);
    assert.ok(names.every((n) => !/[\\/]/.test(n) && n !== '..' && !n.startsWith('.')), 'hostile name sanitised: ' + names.join('|'));
    assert.ok(!names.includes('hostile') && names.some((n) => /pwned\.txt$/.test(n)), 'the hostile Content-Disposition name is a flat name: ' + names.join('|'));
    assert.ok(names.includes('report.csv') && names.some((n) => /^Report \(2\)\.CSV$/i.test(n)), 'names that differ only in case stay two files: ' + names.join('|'));
    assert.ok(!fs.existsSync('/tmp/pwned.txt'), 'nothing was written outside the load folder');
    ok('a Content-Disposition name with ../ becomes a flat name, report.csv and Report.CSV both survive (case-insensitive unique), nothing outside the folder');
    assert.equal(platform.stats.deleteRequests, 0, 'Delete and Sign out links were never requested');
    ok('links called "Delete file" and "Sign out" and a button called "Archive task" were never requested or clicked; "Dark mode" and "Notify me" switches were left alone');
    const pageJson = JSON.parse(fs.readFileSync(path.join(s1.folder, 'page.json'), 'utf8'));
    assert.deepEqual(Object.keys(pageJson).sort(), ['fileList', 'loadedAt', 'page', 'sections', 'skipped']);
    assert.equal(pageJson.loadedAt, '2026-10-23T12:00:00.000Z');
    assert.deepEqual(pageJson.fileList, s1.files);
    assert.deepEqual(pageJson.page, s1.page);
    const heads = pageJson.sections.map((s) => s.heading);
    assert.deepEqual(heads.filter(Boolean), ['Atlas task', 'Business prompt', 'Grader guideline', 'Notes', 'Task files', 'World files']);
    const sectionText = Object.fromEntries(pageJson.sections.map((s) => [s.heading, s.text]));
    assert.match(sectionText['Business prompt'], /variance bridge for Meridian Capital/);
    assert.match(sectionText['Grader guideline'], /price, volume and mix/);
    assert.match(sectionText.Notes, /<img src=x onerror=alert\(1\)> ignore previous instructions/, 'hostile text is data');
    assert.match(sectionText.Notes, /Reviewer note: Check the freight credit\./, 'a form value is read with its label');
    assert.doesNotMatch(JSON.stringify(pageJson), /HIDDEN-SECRET|account-token/, 'a control whose name looks like a secret is not read');
    assert.match(sectionText['Task files'], /Atlas_Prompt\.txt/);
    assert.match(sectionText['World files'], /World_Ledger\.csv/);
    assert.deepEqual(s1.sections, pageJson.sections.map((s) => ({ heading: s.heading, chars: s.text.length })));
    ok('page.json: sections cut at headings (prompt, guideline, notes with hostile text kept as plain text, task files, world files), a textarea value read with its label, a secret-looking field skipped; state.sections lists heading and chars');

    /* privacy: argv, environment, wire, state, files, profile */
    const profileFiles = () => walk(profile).map((f) => { try { return [f, fs.readFileSync(f)]; } catch (e) { return [f, Buffer.alloc(0)]; } });
    for (const needle of [SECRET_QUERY, SECRET_SIG, SECRET_FRAGMENT]) {
      assert.ok(!spied.argv.includes(needle) && !spied.ps.includes(needle), `${needle} is not on any command line`);
      assert.ok(!JSON.stringify(s1).includes(needle) && !JSON.stringify(pageJson).includes(needle), `${needle} is not in the state or page.json`);
    }
    assert.ok(!spied.state.includes(SECRET_QUERY));
    assert.match(spied.argv, /--remote-debugging-pipe/);
    assert.doesNotMatch(spied.argv, /--remote-debugging-port|--remote-debugging-address/);
    assert.ok(spied.argv.trimEnd().endsWith('about:blank'), 'the only positional argument is about:blank');
    ok('the link and its query string are not on Chrome\'s command line (the only positional argument is about:blank), in ps, in the state or in page.json');
    assert.equal(spied.profileMode, 0o700, 'profile folder is 0700');
    assert.equal(fs.statSync(s1.folder).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(s1.folder, 'files')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(s1.folder, 'page.json')).mode & 0o777, 0o600);
    assert.ok(!fs.existsSync(path.join(s1.folder, '.incoming')), 'stage folder removed');
    if (fs.existsSync('/proc') && process.platform === 'linux') {
      assert.ok(spied.environ.length > 0);
      for (const env of spied.environ) {
        for (const canary of Object.values(canaryEnv)) assert.ok(!env.includes(canary) && !env.includes('canary'), 'no companion secret in Chrome\'s environment');
      }
      assert.ok(spied.environ[0].split('\0').includes(`HOME=${path.join(profile, 'home')}`), 'HOME is inside the profile folder (main process)');
      ok(`none of ${spied.environ.length} Chrome processes carries a canary token, API key or proxy password; HOME and XDG folders are inside the profile`);
    }
    assert.ok(!calls.includes('Runtime.enable'), 'Runtime.enable is never sent');
    assert.ok(!calls.some((m) => /Cookie|Storage\./.test(m)), 'no cookie method is ever sent: ' + calls.filter((m) => /Cookie|Storage\./.test(m)).join());
    assert.ok(!calls.includes('Page.setDownloadBehavior'));
    const firstNav = calls.indexOf('Page.navigate');
    assert.ok(calls.indexOf('Browser.setDownloadBehavior') > -1 && calls.indexOf('Browser.setDownloadBehavior') < firstNav, 'downloads are denied before the first navigation');
    const sign = spied.callsBeforeSignIn;
    const off = sign.lastIndexOf('Network.disable');
    assert.ok(off > sign.indexOf('Page.navigate') && !sign.slice(off).includes('Network.enable') && !sign.slice(off).includes('Fetch.enable'), 'the network domain is off, with no enable or Fetch call, while the person is at the sign-in page');
    assert.ok(calls.lastIndexOf('Network.enable') > calls.lastIndexOf('Network.disable'), 'and on again afterwards');
    assert.ok(!calls.includes('Page.bringToFront'), 'headless: no window to bring forward');
    ok('on the wire: no Runtime.enable, no cookie or storage method, downloads denied before the first navigation, and (piped sign-in) the network domain is off (no Network.enable or Fetch.enable) while the person is at the sign-in page, on again after');
    const hits = profileFiles().filter(([f, data]) => data.includes(SECRET_QUERY) || data.includes(SECRET_SIG) || data.includes(SECRET_FRAGMENT));
    assert.deepEqual(hits.map(([f]) => path.relative(profile, f)), [], 'the profile holds no signed link after the scrub');
    for (const gone of ['History', 'Sessions', 'shared_proto_db', 'Cache', 'Visited Links']) assert.ok(!fs.existsSync(path.join(profile, 'Default', gone)), gone + ' scrubbed');
    assert.deepEqual(leftovers(profile), [], 'no Chrome process is left');
    assert.equal(group(profile), null);
    ok('after the load: no process carries the profile path, History, Sessions, the download database and caches are gone, and no profile file holds the query string or the signature');
    assert.ok(platform.requests.some((r) => r.origin === 'files' && r.path.startsWith('/blob/') && !r.cookie), 'the presigned file host got no cookie');
    const seeded = JSON.parse(fs.readFileSync(path.join(profile, 'Default', 'Preferences'), 'utf8'));
    assert.deepEqual([seeded.download_restrictions, seeded.signin.allowed, seeded.safebrowsing.enabled], [3, false, false], 'the profile keeps the seeded safety preferences');
    ok('with download_restrictions=3, no sign-in and Safe Browsing off seeded in the profile, the loader\'s own downloads still work (7 files above)');

    /* 3. The sign-in survives Chrome's restart (a session cookie), the same files arrive again. */
    const before2 = platform.requests.length;
    const run2 = await drive(loader, loader.start(`${platform.origin}/tasks/atlas-001`));
    assert.equal(run2.final.state, 'done', JSON.stringify(run2.final));
    assert.ok(!run2.seen.includes('needs-sign-in'), 'no sign-in the second time: ' + run2.seen.join());
    assert.deepEqual(run2.final.files.map((f) => [f.label, f.sha256]).sort(), s1.files.map((f) => [f.label, f.sha256]).sort());
    assert.notEqual(run2.final.id, id1);
    assert.ok(platform.requests.slice(before2).every((r) => r.origin !== 'main' || r.path !== '/login'));
    ok('the second load needs no sign-in (the session cookie survived the restart and the scrub) and returns the same hashes in a new folder');

    /* 4. A switch with an unrelated label: needs-person, continue, learned (label and id); the next load uses it. */
    platform.signOut();
    const urlB = `${platform.origin}/tasks/borealis-013`;
    const idB = loader.start(urlB);
    const runB = await drive(loader, idB, {
      'needs-sign-in': async () => { await until(() => calls.includes('Network.disable'), 'network off'); platform.signIn(); },
      'needs-person': async (state) => {
        assert.equal(state.message, PERSON_MESSAGE);
        assert.deepEqual(state.toggle, toggle(false, '', false, 2, 2, false));
        assert.ok(group(profile), 'Chrome stays open for the person');
        platform.flip('borealis-013');                    /* the person turns the switch on in the window ... */
        await delay(900);                                  /* ... the page adds its files ... */
        const after = loader.continue(idB);               /* ... and presses Continue */
        assert.equal(after.state, 'loading');
      },
    });
    assert.equal(runB.final.state, 'done', JSON.stringify(runB.final));
    assert.deepEqual(runB.seen.filter((x) => x !== 'starting'), ['needs-sign-in', 'loading', 'needs-person', 'downloading', 'done'], runB.seen.join());
    assert.deepEqual(runB.final.toggle, toggle(true, 'Advanced view', true, 2, 4, true));
    assert.equal(runB.final.files.length, 4);
    const mapFile = path.join(root, 'private', 'link-mappings.json');
    const host = new URL(platform.origin).host;
    assert.deepEqual(JSON.parse(fs.readFileSync(mapFile, 'utf8')), { schema: 'finance-link-mappings', version: 1, hosts: { [host]: { updatedAt: '2026-10-23T12:00:00.000Z', allFilesToggle: 'Advanced view', allFilesToggleKey: 'id:t' } } });
    assert.equal(fs.statSync(mapFile).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(mapFile)).filter((n) => n.endsWith('.tmp')), [], 'atomic write left no temp file');
    ok('needs-person with the exact message, continue() goes straight to loading, the switch the person flipped ("Advanced view", id t) is stored for the host in link-mappings.json (0600, atomic) and the load finishes with 4 files');
    platform.unflip('borealis-013');
    const runB2 = await drive(loader, loader.start(urlB));
    assert.equal(runB2.final.state, 'done', JSON.stringify(runB2.final));
    assert.ok(!runB2.seen.includes('needs-person'), 'learned: no question the second time: ' + runB2.seen.join());
    assert.deepEqual(runB2.final.toggle, toggle(true, 'Advanced view', true, 2, 4, true));
    assert.equal(runB2.final.files.length, 4);
    ok('the next load of that host clicks the learned switch by itself (learned: true, no needs-person)');

    /* 5. A switch without any label: the person flips it; it is remembered by its id. */
    const idC = loader.start(`${platform.origin}/tasks/meridian-020`);
    const runC = await drive(loader, idC, {
      'needs-person': async () => { platform.flip('meridian-020'); await delay(900); loader.continue(idC); },
    });
    assert.equal(runC.final.state, 'done', JSON.stringify(runC.final));
    assert.deepEqual(runC.final.toggle, toggle(true, '', true, 1, 2, true));
    assert.deepEqual(JSON.parse(fs.readFileSync(mapFile, 'utf8')).hosts[host], { updatedAt: '2026-10-23T12:00:00.000Z', allFilesToggleKey: 'id:sw-empty' });
    const runC2 = await drive(loader, loader.start(`${platform.origin}/tasks/meridian-020`));
    assert.ok(!runC2.seen.includes('needs-person'), 'learned by id: no question the second time: ' + runC2.seen.join());
    assert.deepEqual(runC2.final.toggle, toggle(true, '', true, 1, 2, true));
    ok('a switch with no label: the person flips it, it is stored by its id (no label to store), and the next load clicks it by itself');
    platform.unflip('meridian-020');

    /* 6. No switch at all, cancel while waiting for the person; the process table is empty afterwards. */
    const idD = loader.start(`${platform.origin}/tasks/plain-030`);
    let startRefused = false;
    const runD = await drive(loader, idD, {
      'needs-person': async (state) => {
        assert.deepEqual(state.toggle, toggle(false, '', false, 2, 2, false));
        assert.throws(() => loader.start(`${platform.origin}/tasks/atlas-001`), (e) => e.status === 409);
        startRefused = true;
        const cancelling = loader.cancel(idD);
        assert.deepEqual([cancelling.state, cancelling.message], ['loading', 'Cancelling...']);
        assert.throws(() => loader.continue(idD), (e) => e.status === 409);
      },
    });
    assert.ok(startRefused);
    assert.equal(runD.final.state, 'cancelled');
    assert.equal(runD.final.message, 'Cancelled.');
    assert.equal(runD.final.error, null);
    assert.deepEqual(leftovers(profile), [], 'cancel leaves no Chrome process');
    assert.ok(!fs.existsSync(path.join(runD.final.folder, '.incoming')));
    assert.equal(loader.cancel(idD).state, 'cancelled', 'cancel twice is harmless');
    assert.throws(() => loader.continue(idD), (e) => e.status === 409);
    ok('no switch found: needs-person; a second start is refused (409) while a load waits; cancel shows "Cancelling..." and ends as cancelled once Chrome is gone, continue afterwards is 409');
    const runD2 = await drive(loader, loader.start(`${platform.origin}/tasks/plain-030`), { 'needs-person': async (state) => { await delay(200); loader.continue(state.id); } });
    assert.equal(runD2.final.state, 'done', JSON.stringify(runD2.final));
    assert.deepEqual(runD2.final.toggle, toggle(false, '', false, 2, 2, false));
    assert.equal(runD2.final.files.length, 2);
    ok('pressing Continue without having changed anything continues with the files that are there (the person decides)');

    /* 7. Not found. */
    const idE = loader.start(`${platform.origin}/tasks/missing-404`);
    const runE = await drive(loader, idE);
    assert.equal(runE.final.state, 'failed');
    assert.match(runE.final.message, /404/);
    assert.equal(runE.final.error, runE.final.message);
    assert.ok(!runE.final.message.includes('missing-404') && !runE.final.message.includes(platform.origin));
    assert.deepEqual(runE.final.files, []);
    assert.deepEqual(leftovers(profile), []);
    ok('a 404 task page fails with the platform\'s answer in message and error (and no URL in it), no files, no Chrome left');

    /* 8. File hops, bad links on the page, a failed file asks the person, a 401 retried as a click, caps, five failures in a row. */
    const cancelsBefore = calls.filter((m) => m === 'Browser.cancelDownload').length;
    const idF = loader.start(`${platform.origin}/tasks/edge-060`);
    let skippedAsked = null;
    const runF = await drive(loader, idF, {
      downloading: async () => { platform.flip('stray'); },   /* the page starts a download by itself while files are being fetched */
      'needs-person': async (state) => { skippedAsked = state; await delay(100); loader.continue(idF); },
    });
    assert.equal(runF.final.state, 'done', JSON.stringify(runF.final));
    assert.ok(skippedAsked, 'a file that could not be downloaded is not skipped silently');
    assert.match(skippedAsked.message, /^5 files could not be downloaded: .*Offsite\.txt.*Gone\.pdf.*Atlas_Page\.pdf.*\. Download them yourself into a folder and use Import from folder, or press Continue to go on without them\.$/);
    const reasonOf = (name) => (skippedAsked.skipped.find((s) => s.label === name) || {}).reason || '';
    assert.match(reasonOf('Offsite.txt'), /^blocked-host/);
    assert.match(reasonOf('Gone.pdf'), /^http-error/);
    assert.match(reasonOf('Atlas_Page.pdf'), /^not-a-file/);
    assert.match(reasonOf('x.pdf'), /address is not one the loader opens/);
    assert.match(reasonOf('y.pdf'), /address is not one the loader opens/);
    assert.deepEqual(skippedAsked.skipped.map((s) => Object.keys(s).sort()).filter((k) => k.join() !== 'group,label,reason'), []);
    assert.deepEqual(labels(runF.final), ['Atlas_Blob.txt', 'Atlas_Gated.txt', 'Atlas_Prompt.txt', 'Borealis_Extra.txt']);
    assert.deepEqual(runF.final.skipped.map((s) => s.label).sort(), skippedAsked.skipped.map((s) => s.label).sort());
    const blob = runF.final.files.find((f) => f.label === 'Atlas_Blob.txt');
    assert.equal(fs.readFileSync(path.join(runF.final.folder, 'files', blob.name), 'utf8'), 'blob content from the page\n');
    assert.equal(fs.readFileSync(path.join(runF.final.folder, 'files', runF.final.files.find((f) => f.label === 'Atlas_Gated.txt').name), 'utf8'), 'only with a referrer\n');
    assert.deepEqual(filesOnDisk(runF.final), ['Atlas_Blob.txt', 'Atlas_Gated.txt', 'Atlas_Prompt.txt', 'Borealis_Extra.txt'], 'the download the page started by itself was not kept');
    assert.ok(calls.filter((m) => m === 'Browser.cancelDownload').length > cancelsBefore, 'the stray download was cancelled');
    assert.match(runF.final.message, /5 not kept \(listed in skipped\)/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(runF.final.folder, 'page.json'), 'utf8')).skipped.length, 5, 'page.json lists what was not kept');
    assert.equal(platform.stats.trapRequests, 0, 'the redirect to an address written as numbers was never requested');
    assert.ok(!platform.requests.some((r) => /passwd|evil/.test(r.path)));
    ok('a button that builds a blob: URL is clicked and its download kept (click mode); a download the page starts by itself while files are fetched is cancelled and not kept; a page that opens alert and confirm dialogs does not hang the load');
    ok('a file link that answers 401 to a bare navigation is retried once as a click in the page (it needs the referrer) and kept');
    ok(`files that could not be fetched are not skipped silently: 5 skipped (a redirect to 127.0.0.2 blocked${platform.hasTrap ? ' before it was sent, the listener saw 0 requests' : ''}, a 404, a web page in place of a file, two addresses written as numbers) with a reason each, the state goes to needs-person with the exact copy, Continue finishes with the others; javascript: and file: links are not candidates`);

    const capped = makeLoader(root, { limits: { files: 6, fileBytes: 1024 * 1024, totalBytes: 1536 * 1024 } });
    let cappedAsked = null;
    const runG = await drive(capped, capped.start(`${platform.origin}/tasks/caps-040`), { 'needs-person': async (state) => { cappedAsked = state; capped.continue(state.id); } });
    assert.equal(runG.final.state, 'done', JSON.stringify(runG.final));
    assert.deepEqual(labels(runG.final), ['cap_a.bin', 'cap_b.bin']);
    assert.ok(cappedAsked, 'files over the caps are reported, not dropped silently');
    const why = runG.final.skipped.map((s) => s.reason);
    assert.equal(why.filter((r) => /^(too-large|total-cap)/.test(r)).length, 4, why.join(' | '));   /* which cap trips first for a file that breaks both depends on the poll */
    assert.ok(why.some((r) => /^too-large/.test(r)) && why.some((r) => /^total-cap/.test(r)), why.join(' | '));
    assert.equal(why.filter((r) => r === 'over the limit of 6 files').length, 1);
    assert.ok(platform.stats.streamSent < STREAM_TOTAL / 2, `the endless download was cut at the cap (${platform.stats.streamSent} bytes sent of ${STREAM_TOTAL})`);
    assert.deepEqual(filesOnDisk(runG.final), ['cap_a.bin', 'cap_b.bin']);
    ok(`caps: at most 6 files tried; a file announced above the per-file cap is refused before its body, a quick chunked file that ends over the cap is dropped, an endless download without Content-Length is cut at the cap (${platform.stats.streamSent} of ${STREAM_TOTAL} bytes sent), the total cap refuses the next file, partial files are removed; each is listed in skipped`);

    /* 8b. Cancel in the middle of a download. */
    platform.stats.streamSent = 0;
    const idL = loader.start(`${platform.origin}/tasks/caps-040`);
    const runL = await drive(loader, idL, {
      downloading: async () => { await until(() => platform.stats.streamSent > 256 * 1024, 'the endless download to start', 30000); const sent = platform.stats.streamSent; assert.equal(loader.cancel(idL).message, 'Cancelling...'); assert.ok(sent < STREAM_TOTAL); },
    });
    assert.equal(runL.final.state, 'cancelled');
    assert.deepEqual(leftovers(profile), []);
    assert.ok(!fs.existsSync(path.join(runL.final.folder, '.incoming')), 'no partial file is left');
    assert.ok(!fs.existsSync(path.join(runL.final.folder, 'page.json')), 'no page.json for a load that did not finish');
    await delay(400);
    const afterCancel = platform.stats.streamSent;
    await delay(400);
    assert.equal(platform.stats.streamSent, afterCancel, 'the server stopped sending once the load was cancelled');
    assert.ok(afterCancel < STREAM_TOTAL);
    ok('cancel in the middle of an endless download: cancelled, Chrome gone, the transfer stops, no partial file and no page.json');

    /* 9. A sign-in that never comes, Chrome killed under the loader, a person who never answers. */
    platform.signOut();
    const slow = makeLoader(root, { clock: undefined, timeouts: { signIn: 1500 } });
    const runH = await drive(slow, slow.start(`${platform.origin}/tasks/atlas-001`));
    assert.equal(runH.final.state, 'failed');
    assert.equal(runH.final.message, 'Sign-in did not finish within 2 seconds.');
    assert.ok(runH.seen.includes('needs-sign-in'));
    assert.deepEqual(leftovers(profile), []);
    ok('a sign-in that never comes fails after the timeout with a plain message, and Chrome is closed');
    const idI = loader.start(`${platform.origin}/tasks/atlas-001`);
    const runI = await drive(loader, idI, {
      'needs-sign-in': async () => { await until(() => group(profile), 'Chrome'); const g = group(profile); process.kill(-g.main.pid, 'SIGKILL'); },
    });
    assert.equal(runI.final.state, 'failed');
    assert.equal(runI.final.message, 'The Chrome window was closed before the load finished.');
    assert.deepEqual(leftovers(profile), []);
    assert.equal(group(profile), null);
    ok('Chrome killed while the person signs in: failed with a plain message, nothing left running, the loader is free for the next link');
    platform.signIn();
    const quiet = makeLoader(root, { clock: undefined, timeouts: { person: 1500 } });
    const runK = await drive(quiet, quiet.start(`${platform.origin}/tasks/plain-030`));
    assert.equal(runK.final.state, 'failed');
    assert.equal(runK.final.message, 'No answer within 2 seconds.');
    assert.ok(runK.seen.includes('needs-person'));
    assert.deepEqual(leftovers(profile), []);
    ok('a person who never answers: needs-person ends as failed after the timeout, Chrome is closed');
    platform.signIn();
    const runJ = await drive(loader, loader.start(`${platform.origin}/tasks/plain-030`), { 'needs-person': async (s) => { loader.continue(s.id); } });
    assert.equal(runJ.final.state, 'done', JSON.stringify(runJ.final));
    ok('and the next link loads normally afterwards');

    /* 10. Piped sign-in with an MFA step that takes 5 s: the loader waits on the task page itself (two polls), it does not reload mid-step. */
    platform.signOut();
    platform.flags.mfa = true;
    const tasksBefore = platform.count('/tasks/atlas-001'); const loginsBefore = platform.count('/login');
    const startedMfa = Date.now();
    const runM = await drive(loader, loader.start(`${platform.origin}/tasks/atlas-001`), { 'needs-sign-in': async () => { await until(() => calls.includes('Network.disable'), 'network off'); platform.signIn(); } });
    platform.flags.mfa = false;
    assert.equal(runM.final.state, 'done', JSON.stringify(runM.final));
    assert.ok(Date.now() - startedMfa >= 5000, 'the MFA step took its 5 seconds');
    assert.equal(platform.count('/login') - loginsBefore, 1, 'the sign-in page was asked for once: no reload during the MFA step');
    assert.equal(platform.count('/tasks/atlas-001') - tasksBefore, 3, 'the task page: the first request, the landing after MFA, and the loader\'s own load');
    ok('piped sign-in through an MFA step that takes 5 s: the loader does not reload the task link while the page is on /mfa; it waits until the tab is on the task page (same origin and path, no password or code field) on two polls in a row');

    /* 11. Finding files, 10 fixtures at once (each its own Chrome and profile; the platform lets everyone in for this part). */
    platform.flags.openAccess = true;
    const batch = (specs) => Promise.all(specs.map(async (spec) => {
      const dir = path.join(tmp, `batch-${spec.slug}`);
      fs.mkdirSync(dir);
      const l = makeLoader(dir, spec.loader || {});
      return { spec, dir, ...(await drive(l, l.start(`${platform.origin}/tasks/${spec.slug}`), spec.handlers ? spec.handlers(l) : {})) };
    }));
    const first5 = await batch([
      { slug: 'sibling-050' }, { slug: 'on-051' }, { slug: 'select-052' }, { slug: 'panels-053' }, { slug: 'virtual-054' },
    ]);
    const get = (list, slug) => list.find((r) => r.spec.slug === slug);
    const sibling = get(first5, 'sibling-050');
    assert.equal(sibling.final.state, 'done', JSON.stringify(sibling.final));
    assert.deepEqual(sibling.final.toggle, toggle(true, 'Show all files', true, 2, 4, false));
    assert.ok(!sibling.seen.includes('needs-person'));
    ok('a switch with no text of its own takes the label of the text beside it ("Show all files"), is found and clicked: 2 files become 4, no question');
    const onPage = get(first5, 'on-051');
    assert.equal(onPage.final.state, 'done', JSON.stringify(onPage.final));
    assert.deepEqual(onPage.final.toggle, toggle(true, 'Show all files', true, 4, 4, false));
    assert.ok(!onPage.seen.includes('needs-person'));
    assert.deepEqual(labels(onPage.final), ['Atlas_Prompt.txt', 'Borealis_Curve.txt', 'Borealis_Rates.txt', 'report.csv'], 'a switch that is already on is not clicked (clicking would hide the world files)');
    ok('a "Show all files" switch that is already on counts as found and flipped, is not clicked, and nobody is asked');
    const select = get(first5, 'select-052');
    assert.equal(select.final.state, 'done', JSON.stringify(select.final));
    assert.deepEqual(select.final.toggle, toggle(true, 'All files', true, 2, 4, false));
    ok('a <select> whose option says "All files" is chosen with input and change events: 2 files become 4');
    const panels = get(first5, 'panels-053');
    assert.equal(panels.final.state, 'done', JSON.stringify(panels.final));
    assert.deepEqual(labels(panels.final), ['Atlas_Prompt.txt', 'Atlas_Rows.csv 1 KB', 'Borealis_Curve.txt', 'Borealis_Rates.txt']);
    const rowFile = panels.final.files.find((f) => f.label === 'Atlas_Rows.csv 1 KB');
    assert.equal(rowFile.name, 'Atlas_Rows.csv');
    assert.ok(/Reference files/.test(fs.readFileSync(path.join(panels.final.folder, 'page.json'), 'utf8')), 'the text of the tab panel is in page.json');
    ok('files in a closed <details>, behind a tab (the first tab is put back), and behind a "Download" button whose label is the text of its table row ("Atlas_Rows.csv 1 KB") are all found; the tab panel\'s text is in the sections');
    const virtual = get(first5, 'virtual-054');
    assert.equal(virtual.final.state, 'done', JSON.stringify(virtual.final));
    assert.deepEqual(labels(virtual.final), Array.from({ length: 10 }, (_, i) => `Report_${String(i + 1).padStart(2, '0')}.txt`));
    ok('a virtualised list (only the rows on screen exist) is scrolled in steps: all 10 files are found and downloaded');
    const second5 = await batch([
      { slug: 'iframe-055' }, { slug: 'nofiles-056', handlers: (l) => ({ 'needs-person': async (state) => { assert.equal(state.message, 'No files were found. Open the view that lists the files in the Chrome window, then press Continue.'); await delay(200); l.continue(state.id); } }) },
      { slug: 'late-057', loader: { timeouts: { stable: [1000, 2000] } } }, { slug: 'slow-058', loader: { timeouts: { grow: 5000 } } },
      { slug: 'stop-059', handlers: (l) => ({ 'needs-person': async (state) => { assert.match(state.message, /^7 files could not be downloaded: Missing_1\.txt, Missing_2\.txt, Missing_3\.txt, Missing_4\.txt, Missing_5\.txt and 2 more\. Stopped early: 5 files in a row could not be downloaded \(http-error\)\. Download them/); assert.equal(state.skipped.length, 7); assert.match(state.skipped[6].reason, /^not tried: 5 files in a row/); l.continue(state.id); } }) },
    ]);
    const frame = get(second5, 'iframe-055');
    assert.equal(frame.final.state, 'done', JSON.stringify(frame.final));
    assert.deepEqual(labels(frame.final), ['Atlas_Prompt.txt', 'Frame_A.txt', 'Frame_B.txt']);
    assert.match(fs.readFileSync(path.join(frame.final.folder, 'page.json'), 'utf8'), /Inside the frame/);
    ok('a same-origin iframe is read: its files are downloaded and its text is in the sections');
    const nofiles = get(second5, 'nofiles-056');
    assert.equal(nofiles.final.state, 'done', JSON.stringify(nofiles.final));
    assert.ok(nofiles.seen.includes('needs-person'));
    assert.deepEqual(nofiles.final.files, []);
    assert.match(nofiles.final.message, /^0 files and \d+ text sections? loaded/);
    ok('a page with no file at all: needs-person ("No files were found. Open the view that lists the files in the Chrome window, then press Continue."), Continue goes on with none');
    const late = get(second5, 'late-057');
    assert.equal(late.final.state, 'done', JSON.stringify(late.final));
    assert.deepEqual(labels(late.final), ['Atlas_Prompt.txt', 'Late_A.txt', 'Late_B.txt']);
    ok('a page that keeps changing after it settled: looks again 1 s and 3 s later, so a link added at 1.2 s and another at 2.0 s are both found, whatever the settle time was');
    const slowGrow = get(second5, 'slow-058');
    assert.equal(slowGrow.final.state, 'done', JSON.stringify(slowGrow.final));
    assert.deepEqual(slowGrow.final.toggle, toggle(true, 'Show all files', true, 1, 3, false));
    ok('after the switch is clicked the loader waits up to 5 s for the list to grow (files appeared 2.6 s later)');
    const stop = get(second5, 'stop-059');
    assert.equal(stop.final.state, 'failed', JSON.stringify(stop.final));
    assert.match(stop.final.message, /^None of the 7 files could be downloaded\. You can also download the files yourself and use Import from folder\.$/);
    assert.equal(stop.final.skipped.length, 7);
    ok('five files in a row that fail stop the file step with the reason, the other two are listed as not tried, and when nothing could be downloaded the load fails with the Import from folder hint');
    platform.flags.openAccess = false;
    for (const r of [...first5, ...second5]) assert.deepEqual(leftovers(profileOf(r.dir)), [], r.spec.slug);

    /* 12. The sign-in window: a separate Chrome with no debugging channel (real Chrome, headless), then a faked one for the handshake. */
    const rootW = path.join(tmp, 'window-project');
    fs.mkdirSync(rootW);
    const profileW = profileOf(rootW);
    const winLoader = makeLoader(rootW, { signIn: 'window' });
    platform.signOut();
    platform.flags.mfa = true;
    const spawnsBefore = spawns.length;
    const urlW = `${platform.origin}/tasks/atlas-001?ref=${SECRET_QUERY}`;
    const taskGetsBefore = platform.count('/tasks/atlas-001');
    let windowSeen = null;
    const idW = winLoader.start(urlW);
    const runW = await drive(winLoader, idW, {
      'needs-sign-in': async (state) => {
        assert.equal(state.message, SIGNIN_WINDOW_MESSAGE);
        await until(() => mainProcess(profileW, false), 'the sign-in window');
        const w = mainProcess(profileW, false);
        windowSeen = { cmd: w.cmd, loaderChrome: mainProcess(profileW, true), prefs: JSON.parse(fs.readFileSync(path.join(profileW, 'Default', 'Preferences'), 'utf8')) };
        platform.signIn();                                                    /* the person signs in in the window ... */
        await until(() => platform.sessionCount() > 0, 'the platform to see the sign-in (after the 5 s MFA step)', 20000);
        await delay(400);
        assert.equal(winLoader.get(idW).state, 'needs-sign-in', 'the loader waits for Continue, it does not guess');
        winLoader.continue(idW);                                              /* ... and presses Continue */
      },
    });
    platform.flags.mfa = false;
    assert.equal(runW.final.state, 'done', JSON.stringify(runW.final));
    assert.deepEqual(runW.seen.filter((x) => x !== 'starting'), ['loading', 'needs-sign-in', 'downloading', 'done'].filter((x) => runW.seen.includes(x)));
    assert.ok(runW.seen.includes('needs-sign-in'));
    assert.equal(windowSeen.loaderChrome, undefined, 'the loader\'s own Chrome was closed while the person signed in');
    assert.doesNotMatch(windowSeen.cmd, /--remote-debugging|--no-sandbox.*--remote/, 'the sign-in window has no debugging channel');
    assert.ok(windowSeen.cmd.trimEnd().endsWith(`${platform.origin}/`), 'only the origin is on its command line: ' + windowSeen.cmd.slice(-80));
    assert.ok(!windowSeen.cmd.includes(SECRET_QUERY) && !windowSeen.cmd.includes('tasks') && !windowSeen.cmd.includes('atlas'), 'no path and no query on its command line');
    assert.equal(windowSeen.cmd.includes('--headless=new'), true, 'a test double of a window: headless, same switches otherwise');
    assert.deepEqual([windowSeen.prefs.download_restrictions, windowSeen.prefs.signin.allowed, windowSeen.prefs.session.restore_on_startup, path.dirname(windowSeen.prefs.download.default_directory)], [3, false, 1, profileW]);
    const mine = spawns.slice(spawnsBefore);
    assert.deepEqual(mine.map((s) => s.kind), ['pipe', 'window', 'pipe'], 'the loader\'s Chrome, the person\'s window, the loader\'s Chrome again');
    assert.ok(mine.every((s) => !s.args.join(' ').includes(SECRET_QUERY)), 'the link is on no command line');
    assert.equal(platform.count('/tasks/atlas-001') - taskGetsBefore, 2, 'the task link was asked for twice: the wall, and the load after sign-in');
    assert.equal(runW.final.files.length, 7, 'the session cookie the window wrote (SIGINT) was there for the loader\'s Chrome');
    assert.deepEqual(leftovers(profileW), []);
    assert.equal(mainProcess(profileW, false), undefined, 'the window is gone');
    ok('window sign-in: the loader\'s Chrome closes, the same binary opens the same profile with NO debugging channel and only the origin on its command line (no path, no query), seeded with download_restrictions=3 and no sign-in; the exact copy is shown; the person signs in (after a 5 s MFA step) and presses Continue; SIGINT lets Chrome write its cookie; Chrome reopens on the pipe and the task loads (7 files); nothing is left');

    /* 12b. The handshake with the window faked: arguments, signals, order, the repeat-once rule, a window that exits by itself, a profile in use. */
    fakeWindow.on = true;
    platform.signOut();
    const spawns2 = spawns.length;
    const fakeLoader = makeLoader(rootW, { signIn: 'window' });
    const idX = fakeLoader.start(`${platform.origin}/tasks/atlas-001?ref=${SECRET_QUERY}`);
    const presses = (async () => { for (let n = 0; n < 2; n += 1) { await until(() => fakeWindow.children.length > n && fakeLoader.get(idX).state === 'needs-sign-in' && fakeLoader.get(idX).message === SIGNIN_WINDOW_MESSAGE, `window ${n + 1}`, 20000); await delay(250); fakeLoader.continue(idX); await delay(300); } })();
    const runX = await drive(fakeLoader, idX);
    await presses;
    assert.equal(runX.final.state, 'failed', JSON.stringify(runX.final));
    assert.equal(runX.final.message, 'The platform still asks you to sign in. You can also download the files yourself and use Import from folder.');
    assert.deepEqual(spawns.slice(spawns2).map((s) => s.kind), ['pipe', 'window', 'pipe', 'window', 'pipe'], 'sign in, look again, sign in once more, look again, then give up');
    const windows = spawns.slice(spawns2).filter((s) => s.kind === 'window');
    for (const w of windows) assert.deepEqual(w.args.filter((a) => !a.startsWith('--')), [`${platform.origin}/`], 'only the origin');
    assert.deepEqual(fakeWindow.children.map((c) => c.signals), [['SIGINT'], ['SIGINT']], 'each window is asked to quit the way Ctrl-C does, once');
    assert.deepEqual(leftovers(profileW), []);
    ok('the window handshake with the window faked through spawnFn: loader Chrome, window (origin only), Continue sends SIGINT, loader Chrome again; when the platform still asks, once more, then it fails offering Import from folder');
    fakeWindow.children.length = 0;
    platform.signOut();
    const idY = fakeLoader.start(`${platform.origin}/tasks/on-051`);
    const runY = await drive(fakeLoader, idY, { 'needs-sign-in': async () => { platform.flags.openAccess = true; await delay(300); fakeWindow.children[0].emit('exit', 0, null); } });   /* the person signs in and quits that Chrome (Cmd+Q) */
    platform.flags.openAccess = false;
    assert.equal(runY.final.state, 'done', JSON.stringify(runY.final));
    assert.deepEqual(fakeWindow.children[0].signals, [], 'a window that has exited is not signalled');
    ok('a sign-in window that exits by itself (the person quits it) counts as "done signing in": no Continue needed, no signal sent');
    fakeWindow.children.length = 0;
    fakeWindow.stderr = 'Failed to create SingletonLock: File exists';
    const idZ = fakeLoader.start(`${platform.origin}/tasks/on-051`);
    platform.signOut();
    const runZ = await drive(fakeLoader, idZ);
    fakeWindow.stderr = '';
    assert.equal(runZ.final.state, 'failed', JSON.stringify(runZ.final));
    assert.equal(runZ.final.message, 'Quit the loader\'s Chrome (Cmd+Q) and try again.');
    ok('a sign-in window that cannot take the profile (another Chrome holds it) fails at once with "Quit the loader\'s Chrome (Cmd+Q) and try again."');
    fakeWindow.on = false;
    fakeWindow.children.length = 0;

    /* 13. The person closes the Chrome window: the load ends at once. */
    const closer = makeLoader(rootW);
    const idQ = closer.start(`${platform.origin}/tasks/plain-030`);
    let closedAt = 0;
    const runQ = await drive(closer, idQ, {
      'needs-sign-in': async () => { platform.signIn(); },
      'needs-person': async () => {
        const live = pipes[pipes.length - 1];
        const { result } = await live.person('Target.getTargets');
        const page = result.targetInfos.find((t) => t.type === 'page' && t.url.includes('/tasks/plain-030'));
        assert.ok(page, 'the task tab is open');
        closedAt = Date.now();
        await live.person('Target.closeTarget', { targetId: page.targetId });
      },
    });
    assert.equal(runQ.final.state, 'failed', JSON.stringify(runQ.final));
    assert.equal(runQ.final.message, 'You closed the Chrome window before the load finished. Start again.');
    assert.ok(Date.now() - closedAt < 8000, 'it did not wait for the 10-minute timeout');
    assert.deepEqual(leftovers(profileW), []);
    ok('the person closes the task tab (clicking its x, sent through the pipe as a second voice; on macOS Chrome keeps running): the load fails at once with "You closed the Chrome window before the load finished. Start again." and Chrome is closed');

    /* 14. Headed (a real window under Xvfb), when Xvfb is there: the headed switches, the window brought forward, the sign-in window headed. */
    const xvfbPath = ['/usr/bin/Xvfb', '/usr/local/bin/Xvfb'].find((p) => fs.existsSync(p));
    if (xvfbPath && process.platform === 'linux') {
      const display = `:${200 + (process.pid % 700)}`;
      xvfb = spawn(xvfbPath, [display, '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
      await until(() => fs.existsSync(`/tmp/.X11-unix/X${display.slice(1)}`), 'Xvfb', 10000);
      process.env.DISPLAY = display;
      const rootH = path.join(tmp, 'headed-project');
      fs.mkdirSync(rootH);
      const profileH = profileOf(rootH);
      const headed = makeLoader(rootH, { headless: false, signIn: 'window' });
      platform.signOut();
      const callsBefore = calls.length; const spawnsBeforeH = spawns.length;
      let headedSeen = null;
      const idH = headed.start(`${platform.origin}/tasks/on-051`);
      const runHd = await drive(headed, idH, {
        'needs-sign-in': async () => {
          await until(() => mainProcess(profileH, false), 'the headed sign-in window');
          headedSeen = { window: mainProcess(profileH, false).cmd };
          platform.signIn();
          await until(() => platform.sessionCount() > 0, 'the sign-in', 20000);
          await delay(400);
          headed.continue(idH);
        },
        downloading: async () => { const g = group(profileH); headedSeen.loader = g && g.main.cmd; },
      });
      assert.equal(runHd.final.state, 'done', JSON.stringify(runHd.final));
      for (const cmd of [headedSeen.window, headedSeen.loader]) {
        assert.ok(cmd, 'both Chromes were seen');
        assert.doesNotMatch(cmd, /--headless/);
        for (const flag of ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']) assert.ok(cmd.includes(flag), flag);
      }
      const headedCalls = calls.slice(callsBefore);
      assert.ok(headedCalls.includes('Page.bringToFront') && headedCalls.includes('Target.activateTarget'), 'the window is brought to the front');
      assert.deepEqual(spawns.slice(spawnsBeforeH).map((s) => s.kind), ['pipe', 'window', 'pipe']);
      assert.deepEqual(leftovers(profileH), []);
      ok('headed (under Xvfb): the loader\'s Chrome and the sign-in window are real windows with --disable-backgrounding-occluded-windows, --disable-renderer-backgrounding and --disable-background-timer-throttling; Page.bringToFront and Target.activateTarget are sent; the whole window flow finishes');
      process.env.DISPLAY = savedDisplay;
      if (savedDisplay === undefined) delete process.env.DISPLAY;
    } else ok('headed scenario skipped: no Xvfb on this machine');

    for (const state of finals) for (const needle of [SECRET_QUERY, SECRET_SIG, SECRET_FRAGMENT]) assert.ok(!JSON.stringify(state).includes(needle), 'a state holds ' + needle);
    ok(`none of the ${finals.length} final states holds the query string, the fragment or the signature`);
  } catch (error) {
    failure = error;
  } finally {
    for (const name of Object.keys(canaryEnv)) delete process.env[name];
    if (savedDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = savedDisplay;
    await Promise.all(loaders.map((l) => l.shutdown().catch(() => {})));   /* a failed run must not leave Chrome open */
    if (xvfb) xvfb.kill();
    if (platform) await platform.close().catch(() => {});
    if (process.env.KEEP === '1') console.log('kept', tmp); else fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (failure) { console.error(failure); process.exitCode = 1; return; }
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
})();
