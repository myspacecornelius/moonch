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

   Identity, expansion and naming (each in its own Chrome, in batches): tabs whose rows only say "Download", a tab called "World files"
   that the loader takes for the switch, virtualised tables and lists (buttons, blob links, 60 plain links), "Load more" in every tab and
   60 files behind it, a folder tree and a closed <details> that the switch adds, a router switch, a world file the platform refuses,
   file names that start with Delete/Reset/Archive/Publish, links and buttons of unusual shape, a form around the table, addresses signed
   anew on every render, opaque addresses without Content-Disposition, an iframe and a shadow root, a slow API behind a switch that is
   already on, and a note when "Load more" is cut off. Window mode: the sign-in pages are scrubbed on cancel and on a timeout, a Chrome
   that holds the profile is not killed, a Chrome that cannot open a window is reported as that.

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
const { spawn, spawnSync } = require('node:child_process');
const { createLinkLoader, LinkError } = require('../backend/links/index.cjs');
const { listProcesses, chromeArgs, browserEnv, prepareProfile } = require('../backend/links/chrome.cjs');

const defaultChrome = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const chromePath = process.env.CHROME_BIN || (fs.existsSync(defaultChrome) ? defaultChrome : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const det = (seed, size) => Buffer.from(crypto.createHash('sha256').update(seed).digest('hex').repeat(Math.ceil(size / 64))).subarray(0, size);
const SECRET_SIG = 'SECRETSIG0123456789';
const SECRET_QUERY = 'CANARYQ9876543210';
const SECRET_FRAGMENT = 'FRAGCANARY77';
const LOGIN_CANARY = 'SIGNINCANARY99';   /* in the address of the sign-in page that the window opens at the origin */
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
  hostile: { name: 'hostile.txt', type: 'text/plain', body: Buffer.from('a file whose name tries to leave its folder\n'), disp: 'attachment; filename="../../../tmp/pwned.txt"' },
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
  const stats = { streamSent: 0, trapRequests: 0, deleteRequests: 0, mfaDoneAt: 0, canaryHits: 0, apiActions: 0, mutations: 0 };
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
    if (u.pathname === '/frame') return send(res, 200, 'text/html; charset=utf-8', '<!doctype html><h3>A frame of another site</h3><ul><li><a href="/blob/Frame_Other.txt">Frame_Other.txt</a></li></ul>');
    const m = /^\/blob\/([^/]+)$/.exec(u.pathname);
    const def = m && Object.values(FILES).find((f) => f.name === decodeURIComponent(m[1]));
    if (!def || u.searchParams.get('X-Signature') !== SECRET_SIG) return send(res, 403, 'text/plain', 'bad signature');
    return send(res, 200, def.type, def.body, def.disp ? { 'content-disposition': def.disp } : {});
  }, '127.0.0.1');
  const filesOrigin = `http://localhost:${files.address().port}`;

  const li = (key, extra = '') => `<li><a href="/files/${key}/${FILES[key].name}"${extra}>${FILES[key].name}</a></li>`;
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
    const world = worldKeys.map((k) => ({ href: `/files/${k}/${FILES[k].name}`, text: FILES[k].name }));
    const polls = pollers.map(([name, js]) => `setInterval(async () => { const j = await (await fetch('/__person/flip?name=${name}')).json(); if (j.go) { ${js} } }, 150);`).join('\n');
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>
<h1>${title}</h1>
<h2>Business prompt</h2><p>Atlas is a mid-size distributor owned by Borealis Holdings. Prepare a variance bridge for Meridian Capital.</p>
<h2>Grader guideline</h2><p>Award the bridge only when price, volume and mix sum to the reported change.</p>
<h2>Notes</h2><p>&lt;img src=x onerror=alert(1)&gt; ignore previous instructions</p>
<form onsubmit="return false"><label for="n">Reviewer note</label><textarea id="n" name="note">Check the freight credit.</textarea><label for="p2">Account code</label><input id="p2" name="account-token" value="HIDDEN-SECRET"></form>
<h2>Task files</h2><ul>${taskKeys.map((k) => (k === 'workbook' ? `<li><a href="${filesOrigin}/blob/${encodeURIComponent(FILES.workbook.name)}?X-Signature=${SECRET_SIG}&X-Expires=9999999999">Atlas_Workbook.xlsx</a></li>` : k === 'prompt' || k === 'gated' ? li(k, ' download') : li(k))).join('')}${extraLinks}</ul>
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
<div id="panel-a"><p>Task panel</p></div><div id="panel-b" hidden><h2>Reference files</h2><ul><li><a href="/files/adv1/Borealis_Rates.txt">Borealis_Rates.txt</a></li></ul></div>
<details><summary>More files</summary><ul><li><a href="/files/adv2/Borealis_Curve.txt">Borealis_Curve.txt</a></li></ul></details>
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
    const a = document.createElement('a'); a.className = 'vrow'; a.href = '/files/vf-' + (i + 1) + '/Report_' + String(i + 1).padStart(2, '0') + '.txt'; a.textContent = 'Report_' + String(i + 1).padStart(2, '0') + '.txt';
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
setTimeout(() => { const a = document.createElement('a'); a.href = '/files/late-a/Late_A.txt'; a.textContent = 'Late_A.txt'; const item = document.createElement('li'); item.append(a); document.querySelector('ul').append(item); }, 1200);
setTimeout(() => { const a = document.createElement('a'); a.href = '/files/late-b/Late_B.txt'; a.textContent = 'Late_B.txt'; const item = document.createElement('li'); item.append(a); document.querySelector('ul').append(item); }, 2000);
</script>`,
    }),
    'slow-058': () => page({ slug: 'slow-058', title: 'Slow task', taskKeys: ['prompt'], worldKeys: ['adv1', 'adv2'], toggle: 'all', delay: 2600 }),
    'stop-059': () => page({ slug: 'stop-059', title: 'Stop task', toggle: 'on', extraLinks: Array.from({ length: 7 }, (_, i) => `<li><a href="/files/gone-${i + 1}/Missing_${i + 1}.txt">Missing_${i + 1}.txt</a></li>`).join('') }),
    'edge-060': () => page({
      slug: 'edge-060', title: 'Edge task', taskKeys: ['prompt', 'offsite', 'gone', 'htmlfile', 'gated'], worldKeys: ['adv4'], toggle: 'all',
      pollers: [['stray', `const a = document.createElement('a'); a.href = '/files/prompt/Atlas_Prompt.txt'; a.download = 'stray.txt'; document.body.append(a); a.click(); a.remove();`]],
      extraBody: `<button type="button" id="blob">Download Atlas_Blob.txt</button><script>
document.getElementById('blob').addEventListener('click', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['blob content from the page\\n'], { type: 'text/plain' })); a.download = 'Atlas_Blob.txt'; document.body.append(a); a.click(); a.remove(); });
</script>`,
      extraLinks: '<li><a href="javascript:alert(1)" download>evil.pdf</a></li><li><a href="file:///etc/passwd" download>passwd.txt</a></li><li><a href="https://127.0.0.2:22/x.pdf">x.pdf</a></li><li><a href="https://10.0.0.5/y.pdf">y.pdf</a></li>',
    }),
  };

  /* Fixtures for the identity, expansion and naming rules. Every file says what it is: the content is "content of <its name>". */
  const doc = (title, body, head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><h1>${title}</h1><h2>Files</h2><p>Atlas files for Meridian Capital, prepared by Borealis.</p>${body}</body></html>`;
  const BLOB = `function dl(n){ const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['content of ' + n])); a.download = n; document.body.appendChild(a); a.click(); a.remove(); }`;
  const TOGGLE_BOX = '<label><input type="checkbox" id="all"> Show all files</label>';
  Object.assign(PAGES, {
    /* tabs: row buttons say only "Download"; the file names sit in the rows. Files of the other tab must not land in the slots of the first. */
    'tabs-070': () => doc('Tabs task', `<div role="tablist"><button role="tab" aria-selected="true" id="t1">Task</button><button role="tab" aria-selected="false" id="t2">Reference</button></div><div id="panel"></div><script>${BLOB}
const DATA = { t1: ['Task_A.txt', 'Task_B.txt'], t2: ['Ref_A.txt', 'Ref_B.txt', 'Ref_C.txt'] };
function render(k) { document.getElementById('t1').setAttribute('aria-selected', k === 't1'); document.getElementById('t2').setAttribute('aria-selected', k === 't2');
  const p = document.getElementById('panel'); p.innerHTML = '<table><tbody>' + DATA[k].map((n) => '<tr><td>' + n + '</td><td><button class="dl" data-n="' + n + '">Download</button></td></tr>').join('') + '</tbody></table>';
  p.querySelectorAll('.dl').forEach((b) => { b.onclick = () => dl(b.dataset.n); }); }
document.getElementById('t1').onclick = () => render('t1'); document.getElementById('t2').onclick = () => render('t2'); render('t1');</script>`),
    /* the second tab is called "World files": it is a tab, not the switch (the label has no show or view), so nobody clicks it for the wrong reason; the person is asked, then every tab is looked at */
    'tabs-071': () => doc('World tabs task', `<div role="tablist"><button role="tab" aria-selected="true" id="t1">Task files</button><button role="tab" aria-selected="false" id="t2">World files</button></div><div id="panel"></div><script>${BLOB}
const DATA = { t1: ['Task_A.txt', 'Task_B.txt'], t2: ['World_A.txt', 'World_B.txt', 'World_C.txt'] };
function render(k) { document.getElementById('t1').setAttribute('aria-selected', k === 't1'); document.getElementById('t2').setAttribute('aria-selected', k === 't2');
  const p = document.getElementById('panel'); p.innerHTML = '<table><tbody>' + DATA[k].map((n) => '<tr><td>' + n + '</td><td><button class="dl" data-n="' + n + '">Download</button></td></tr>').join('') + '</tbody></table>';
  p.querySelectorAll('.dl').forEach((b) => { b.onclick = () => dl(b.dataset.n); }); }
document.getElementById('t1').onclick = () => render('t1'); document.getElementById('t2').onclick = () => render('t2'); render('t1');</script>`),
    /* a virtualised table of 24 rows with a "Download" button each (6 rendered at a time) */
    'vtable-072': () => doc('Virtual table task', `<div id="box" style="height:240px;overflow-y:auto;position:relative"><div id="spacer" style="height:960px"></div><table id="tb" style="position:absolute;top:0;left:0;width:100%"><tbody></tbody></table></div><script>${BLOB}
const N = 24, ROW = 40, VIS = 6; const names = Array.from({ length: N }, (_, i) => 'File_' + String(i + 1).padStart(2, '0') + '.txt');
const box = document.getElementById('box'), tb = document.querySelector('#tb tbody');
function draw() { const first = Math.min(N - VIS, Math.floor(box.scrollTop / ROW)); document.getElementById('tb').style.top = (first * ROW) + 'px';
  tb.innerHTML = names.slice(first, first + VIS).map((n) => '<tr style="height:' + ROW + 'px"><td>' + n + '</td><td><button class="dl" data-n="' + n + '">Download</button></td></tr>').join('');
  tb.querySelectorAll('.dl').forEach((b) => { b.onclick = () => dl(b.dataset.n); }); }
box.addEventListener('scroll', draw); draw();</script>`),
    /* the same with blob: links built when a row is drawn */
    'vlinks-073': () => doc('Virtual blob task', `<div id="box" style="height:240px;overflow-y:auto;position:relative"><div id="spacer" style="height:960px"></div><table id="tb" style="position:absolute;top:0;left:0;width:100%"><tbody></tbody></table></div><script>
const N = 24, ROW = 40, VIS = 6; const names = Array.from({ length: N }, (_, i) => 'Link_' + String(i + 1).padStart(2, '0') + '.txt');
const box = document.getElementById('box'), tb = document.querySelector('#tb tbody');
function draw() { const first = Math.min(N - VIS, Math.floor(box.scrollTop / ROW)); document.getElementById('tb').style.top = (first * ROW) + 'px';
  tb.innerHTML = names.slice(first, first + VIS).map((n) => '<tr style="height:' + ROW + 'px"><td>' + n + '</td><td><a class="dl" href="#" data-n="' + n + '">' + n + '</a></td></tr>').join('');
  tb.querySelectorAll('.dl').forEach((b) => { b.href = URL.createObjectURL(new Blob(['content of ' + b.dataset.n])); b.download = b.dataset.n; }); }
box.addEventListener('scroll', draw); draw();</script>`),
    /* the Reference tab pages its list: 3 files, then "Load more" adds 3, twice */
    'tabmore-074': () => doc('Paged tab task', `<div role="tablist"><button role="tab" aria-selected="true" id="t1">Task</button><button role="tab" aria-selected="false" id="t2">Reference</button></div><div id="panel"></div><script>
const T1 = ['Task_A.txt', 'Task_B.txt']; const T2 = Array.from({ length: 9 }, (_, i) => 'Ref_' + (i + 1) + '.txt'); let shown = 3, cur = 't1';
function render() { document.getElementById('t1').setAttribute('aria-selected', cur === 't1'); document.getElementById('t2').setAttribute('aria-selected', cur === 't2');
  const list = cur === 't1' ? T1 : T2.slice(0, shown);
  document.getElementById('panel').innerHTML = '<ul>' + list.map((n) => '<li><a href="/data/' + n + '">' + n + '</a></li>').join('') + '</ul>' + (cur === 't2' && shown < T2.length ? '<button id="more">Load more</button>' : '');
  const m = document.getElementById('more'); if (m) m.onclick = () => { shown += 3; render(); }; }
document.getElementById('t1').onclick = () => { cur = 't1'; render(); }; document.getElementById('t2').onclick = () => { cur = 't2'; render(); }; render();</script>`),
    /* the switch adds a CLOSED <details> group and a folder tree whose subfolders are closed too (children are made on the first open) */
    'tree-075': () => doc('Tree task', `${TOGGLE_BOX}<ul><li><a href="/data/Task_A.txt">Task_A.txt</a></li></ul><div id="world"></div>
<div id="tree"><button id="f1" aria-expanded="false" aria-controls="f1c">Folder One</button><div id="f1c" hidden></div></div><script>
const f1 = document.getElementById('f1');
f1.onclick = () => { const open = f1.getAttribute('aria-expanded') === 'true'; f1.setAttribute('aria-expanded', !open); const c = document.getElementById('f1c'); c.hidden = open;
  if (!open && !c.dataset.done) { c.dataset.done = 1; c.innerHTML = '<ul><li><a href="/data/Tree_Top.txt">Tree_Top.txt</a></li></ul><button id="f2" aria-expanded="false" aria-controls="f2c">Sub Folder</button><div id="f2c" hidden></div>';
    const f2 = document.getElementById('f2'); f2.onclick = () => { const o2 = f2.getAttribute('aria-expanded') === 'true'; f2.setAttribute('aria-expanded', !o2); const c2 = document.getElementById('f2c'); c2.hidden = o2; if (!o2) c2.innerHTML = '<ul><li><a href="/data/Tree_Deep.txt">Tree_Deep.txt</a></li></ul>'; }; } };
document.getElementById('all').onchange = (e) => { document.getElementById('world').innerHTML = e.target.checked ? '<details><summary>World files</summary><ul><li><a href="/data/World_A.txt">World_A.txt</a></li><li><a href="/data/World_B.txt">World_B.txt</a></li></ul></details>' : ''; };</script>`),
    /* a router switch: it changes the address (pushState to .../all) and shows the world files as "Download" buttons */
    'router-076': () => doc('Router task', `${TOGGLE_BOX}<div id="list"></div><script>${BLOB}
function render() { const on = location.pathname.endsWith('/all'); document.getElementById('all').checked = on;
  const names = ['Task_A.txt'].concat(on ? ['World_A.txt', 'World_B.txt'] : []);
  document.getElementById('list').innerHTML = rowsHtml(names); document.querySelectorAll('.dl').forEach((b) => { b.onclick = () => dl(b.dataset.n); }); }
function rowsHtml(names) { return '<table><tbody>' + names.map((n) => '<tr><td>' + n + '</td><td><button class="dl" data-n="' + n + '">Download</button></td></tr>').join('') + '</tbody></table>'; }
document.getElementById('all').onchange = (e) => { history.pushState({}, '', e.target.checked ? '/tasks/router-076/all' : '/tasks/router-076'); render(); }; render();</script>`),
    /* the switch is page-side only; one world file is a plain link the platform refuses (403) */
    'denied-077': () => doc('Denied task', `${TOGGLE_BOX}<div id="list"></div><script>${BLOB}
function render() { const on = document.getElementById('all').checked;
  const rows = [['Task_A.txt', 'btn']].concat(on ? [['Restricted.txt', 'link'], ['World_B.txt', 'btn'], ['World_C.txt', 'btn']] : []);
  document.getElementById('list').innerHTML = '<table><tbody>' + rows.map(([n, k]) => '<tr><td>' + n + '</td><td>' + (k === 'link' ? '<a href="/denied/' + n + '">' + n + '</a>' : '<button class="dl" data-n="' + n + '">Download</button>') + '</td></tr>').join('') + '</tbody></table>';
  document.querySelectorAll('.dl').forEach((b) => { b.onclick = () => dl(b.dataset.n); }); }
document.getElementById('all').onchange = render; render();</script>`),
    /* file names that start with destructive verbs are files; a /publish/ folder in the address is an action word and is not requested; a button that really is an action is not pressed */
    'verbs-078': () => doc('Verbs task', `<ul><li><a href="/data/Archive_2025_Q4.zip">Archive 2025 Q4.zip</a></li><li><a href="/data/Reset_policy.pdf">Reset policy.pdf</a></li>
<li><a href="/data/publish/Plan.txt">Plan.txt</a></li><li><a href="/data/Danger.pdf?action=delete">Danger.pdf</a></li><li><a href="/data/ok.txt">ok.txt</a></li></ul>
<button type="button" id="dellog">Delete log.txt</button><script>document.getElementById('dellog').onclick = () => fetch('/files/9/delete');</script>`),
    /* controls the extractor must recognise: a "#" link with role=button, a link with no address, an icon-only button with a title, an aria-label button; a link called Budget_2025.xlsx whose address says nothing is NOT clearly a download */
    'controls-079': () => doc('Controls task', `<ul><li><a href="/documents/42">Budget_2025.xlsx</a></li>
<li><a href="#" role="button" id="b2">Download</a></li><li><button id="b3" title="Download file"><svg width="10" height="10"></svg></button></li>
<li><a role="button" id="b4">Download</a></li><li><button id="b5" aria-label="Download Budget5.xlsx"><svg width="10" height="10"></svg></button></li><li><a href="/data/ok.txt">ok.txt</a></li></ul><script>${BLOB}
document.getElementById('b2').onclick = (e) => { e.preventDefault(); dl('b2.txt'); }; document.getElementById('b3').onclick = () => dl('b3.txt'); document.getElementById('b4').onclick = () => dl('b4.txt'); document.getElementById('b5').onclick = () => dl('b5.txt');</script>`),
    /* a filter form around the file table: nothing inside a form is pressed (even a type=button, a submit would POST the form); a table outside it is fine */
    'form-080': () => doc('Form task', `<form id="f" onsubmit="return false"><input type="search" name="q" placeholder="filter"><table><tbody>
<tr><td>Task_A.txt</td><td><button type="button" class="dl" data-n="Task_A.txt">Download</button></td></tr>
<tr><td>Task_B.txt</td><td><button type="button" class="dl" data-n="Task_B.txt">Download</button></td></tr>
<tr><td>Task_C.txt</td><td><button class="sub" data-n="Task_C.txt">Download</button></td></tr></tbody></table></form>
<table><tbody><tr><td>Task_D.txt</td><td><button type="button" class="dl" data-n="Task_D.txt">Download</button></td></tr></tbody></table><script>${BLOB}
document.querySelectorAll('.dl').forEach((b) => { b.onclick = () => { fetch('/hit/form-' + b.dataset.n); dl(b.dataset.n); }; }); document.querySelector('.sub').onclick = () => fetch('/hit/form-sub');</script>`),
    /* every address is signed anew on each render: the same four files, many different addresses */
    'signed-081': () => doc('Signed task', `${TOGGLE_BOX}<div id="list"></div><script>
function render() { const on = document.getElementById('all').checked; const names = ['Signed_A.txt', 'Signed_B.txt'].concat(on ? ['Signed_C.txt', 'Signed_D.txt'] : []);
  document.getElementById('list').innerHTML = '<ul>' + names.map((n) => '<li><a href="/data/' + n + '?X-Amz-Signature=' + Math.random().toString(16).slice(2) + '">' + n + '</a></li>').join('') + '</ul>'; }
document.getElementById('all').onchange = render; render(); setInterval(render, 700);</script>`),
    /* links whose address ends in an opaque segment and that send no Content-Disposition; the name is in the link text */
    'opaque-082': () => doc('Opaque task', `<ul><li><a href="/opaque/11/download">Variance_Bridge.xlsx</a></li><li><a href="/opaque/12/download">Sales_Ledger.csv</a></li><li><a href="/opaque/13/download" download>Board_Memo.pdf</a></li><li><a href="/opaque/14/download">Grader_Guideline.pdf</a></li></ul>`),
    /* a same-origin iframe with a link, a closed <details> and a "Load more" button */
    'frame2-083': () => {
      const inner = `<ul><li><a href="/data/Frame_Open.txt">Frame_Open.txt</a></li></ul><details><summary>More</summary><ul><li><a href="/data/Frame_Closed.txt">Frame_Closed.txt</a></li></ul></details><button id="m">Load more</button><script>document.getElementById('m').onclick=()=>{document.body.insertAdjacentHTML('beforeend','<ul><li><a href="/data/Frame_More.txt">Frame_More.txt</a></li></ul>')}<\/script>`;
      return doc('Frame task', `<iframe style="width:600px;height:300px" srcdoc="${inner.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe><ul><li><a href="/data/Top.txt">Top.txt</a></li></ul>`);
    },
    /* an open shadow root holding a link, a closed <details> and a Download button */
    'shadow-084': () => doc('Shadow task', `<div id="host"></div><script>${BLOB}
const root = document.getElementById('host').attachShadow({ mode: 'open' });
root.innerHTML = '<ul><li><a href="/data/Shadow_Open.txt">Shadow_Open.txt</a></li></ul><details><summary>More</summary><ul><li><a href="/data/Shadow_Closed.txt">Shadow_Closed.txt</a></li></ul></details><table><tbody><tr><td>Shadow_Button.txt</td><td><button class="dl">Download</button></td></tr></tbody></table>';
root.querySelector('.dl').onclick = () => dl('Shadow_Button.txt');</script>`),
    /* the switch is already on (the platform remembers it); the world files come from an API that is slow */
    'slowapi-085': () => doc('Slow API task', `<label><input type="checkbox" id="all" checked> Show all files</label><ul id="list"><li><a href="/data/Task_A.txt">Task_A.txt</a></li></ul><script>
fetch('/api/world?delay=' + (new URLSearchParams(location.search).get('delay') || 0)).then((r) => r.json()).then((j) => { document.getElementById('list').insertAdjacentHTML('beforeend', j.map((n) => '<li><a href="/data/' + n + '">' + n + '</a></li>').join('')); });</script>`),
    /* the switch is already on; one more file appears 3 s after load, from the page's own timer (no request at all) */
    'lategrow-089': () => doc('Late grow task', `<label><input type="checkbox" id="all" checked> Show all files</label><ul id="list"><li><a href="/data/Task_A.txt">Task_A.txt</a></li></ul><script>
setTimeout(() => { document.getElementById('list').insertAdjacentHTML('beforeend', '<li><a href="/data/Late_Grow.txt">Late_Grow.txt</a></li>'); }, 3000);</script>`),
    /* 14 plain rows with a blob "Download" button each, run alone: Chrome drops the 11th download of a burst */
    'burst-090': () => doc('Burst task', `<table><tbody id="tb"></tbody></table><script>${BLOB}
const names = Array.from({ length: 14 }, (_, i) => 'Burst_' + String(i + 1).padStart(2, '0') + '.txt');
document.getElementById('tb').innerHTML = names.map((n) => '<tr><td>' + n + '</td><td><button class="dl" data-n="' + n + '">Download</button></td></tr>').join('');
document.querySelectorAll('.dl').forEach((b) => { b.onclick = () => dl(b.dataset.n); });</script>`),
    /* DIV rows (no table, list item or row role): the name in a span, a bare Download button, 24 rows virtualised */
    'divrows-091': () => doc('Div rows task', `<div id="box" style="height:240px;overflow-y:auto;position:relative"><div id="spacer" style="height:960px"></div><div id="tb" style="position:absolute;top:0;left:0;width:100%"></div></div><script>${BLOB}
const N = 24, ROW = 40, VIS = 6; const names = Array.from({ length: N }, (_, i) => 'Div_' + String(i + 1).padStart(2, '0') + '.txt');
const box = document.getElementById('box'), tb = document.getElementById('tb');
function draw() { const first = Math.min(N - VIS, Math.floor(box.scrollTop / ROW)); tb.style.top = (first * ROW) + 'px';
  tb.innerHTML = names.slice(first, first + VIS).map((n) => '<div class="row" style="height:' + ROW + 'px"><span>' + n + '</span> <button class="dl" data-n="' + n + '">Download</button></div>').join('');
  tb.querySelectorAll('.dl').forEach((b) => { b.onclick = () => dl(b.dataset.n); }); }
box.addEventListener('scroll', draw); draw();</script>`),
    /* two tabs that BOTH list Data.csv and Notes.txt, with different content */
    'twotabs-092': () => doc('Two tabs task', `<div role="tablist"><button role="tab" aria-selected="true" id="t1">Task</button><button role="tab" aria-selected="false" id="t2">Reference</button></div><div id="panel"></div><script>
const DATA = { t1: ['Data.csv', 'Notes.txt'], t2: ['Data.csv', 'Notes.txt', 'Extra.txt'] }; let cur = 't1';
function render(k) { cur = k; document.getElementById('t1').setAttribute('aria-selected', k === 't1'); document.getElementById('t2').setAttribute('aria-selected', k === 't2');
  const p = document.getElementById('panel'); p.innerHTML = '<table><tbody>' + DATA[k].map((n) => '<tr><td>' + n + '</td><td><button class="dl" data-n="' + n + '">Download</button></td></tr>').join('') + '</tbody></table>';
  p.querySelectorAll('.dl').forEach((b) => { b.onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([cur + ' content of ' + b.dataset.n])); a.download = b.dataset.n; document.body.appendChild(a); a.click(); a.remove(); }; }); }
document.getElementById('t1').onclick = () => render('t1'); document.getElementById('t2').onclick = () => render('t2'); render('t1');</script>`),
    /* names with spaces that end in the same word, in two tabs */
    'tabnames-093': () => doc('Tab names task', `<div role="tablist"><button role="tab" aria-selected="true" id="t1">Task</button><button role="tab" aria-selected="false" id="t2">Reference</button></div><div id="panel"></div><script>${BLOB}
const DATA = { t1: ['Task Budget.xlsx', 'Task Notes.txt'], t2: ['Reference Budget.xlsx', 'Reference Notes.txt'] };
function render(k) { document.getElementById('t1').setAttribute('aria-selected', k === 't1'); document.getElementById('t2').setAttribute('aria-selected', k === 't2');
  const p = document.getElementById('panel'); p.innerHTML = '<table><tbody>' + DATA[k].map((n) => '<tr><td>' + n + '</td><td><button class="dl" data-n="' + n + '">Download</button></td></tr>').join('') + '</tbody></table>';
  p.querySelectorAll('.dl').forEach((b) => { b.onclick = () => dl(b.dataset.n); }); }
document.getElementById('t1').onclick = () => render('t1'); document.getElementById('t2').onclick = () => render('t2'); render('t1');</script>`),
    /* a virtualised table whose names share their last words: "Entity 01 Budget.txt" ... "Entity 24 Budget.txt" */
    'entity-094': () => doc('Entity task', `<div id="box" style="height:240px;overflow-y:auto;position:relative"><div id="spacer" style="height:960px"></div><table id="tb" style="position:absolute;top:0;left:0;width:100%"><tbody></tbody></table></div><script>${BLOB}
const N = 24, ROW = 40, VIS = 6; const names = Array.from({ length: N }, (_, i) => 'Entity ' + String(i + 1).padStart(2, '0') + ' Budget.txt');
const box = document.getElementById('box'), tb = document.querySelector('#tb tbody');
function draw() { const first = Math.min(N - VIS, Math.floor(box.scrollTop / ROW)); document.getElementById('tb').style.top = (first * ROW) + 'px';
  tb.innerHTML = names.slice(first, first + VIS).map((n) => '<tr style="height:' + ROW + 'px"><td>' + n + '</td><td><button class="dl" data-n="' + n + '">Download</button></td></tr>').join('');
  tb.querySelectorAll('.dl').forEach((b) => { b.onclick = () => dl(b.dataset.n); }); }
box.addEventListener('scroll', draw); draw();</script>`),
    /* a plain "Show all files" button without aria-pressed; it fetches something when pressed. idem: pressing again changes nothing */
    'button-095': () => doc('Button task', `<button id="all">Show all files</button><div id="list"></div><script>${BLOB}
let on = false;
function render() { const names = ['Button_Task.txt'].concat(on ? ['Button_A.txt', 'Button_B.txt', 'Button_C.txt', 'Button_D.txt', 'Button_E.txt'] : []);
  document.getElementById('list').innerHTML = '<table><tbody>' + names.map((n) => '<tr><td>' + n + '</td><td><button class="dl" data-n="' + n + '">Download</button></td></tr>').join('') + '</tbody></table>';
  document.querySelectorAll('.dl').forEach((b) => { b.onclick = () => dl(b.dataset.n); }); }
document.getElementById('all').onclick = () => { fetch('/hit/idem'); on = true; render(); }; render();</script>`),
    /* the same button FLIPS the view each time it is pressed (all / mine), its label never changes */
    'flip-096': () => doc('Flip task', `<button id="all">Show all files</button><div id="list"></div><script>${BLOB}
let on = false;
function render() { const names = ['Flip_Task.txt'].concat(on ? ['Flip_A.txt', 'Flip_B.txt', 'Flip_C.txt', 'Flip_D.txt', 'Flip_E.txt'] : []);
  document.getElementById('list').innerHTML = '<table><tbody>' + names.map((n) => '<tr><td>' + n + '</td><td><button class="dl" data-n="' + n + '">Download</button></td></tr>').join('') + '</tbody></table>';
  document.querySelectorAll('.dl').forEach((b) => { b.onclick = () => dl(b.dataset.n); }); }
document.getElementById('all').onclick = () => { fetch('/hit/flip'); on = !on; render(); }; render();</script>`),
    /* links to files with no Content-Disposition, an opaque address and a MIME type that Chrome turns into "download.<ext>" */
    'mime-097': () => doc('Mime task', `<ul>${['11:Variance_Bridge.xlsx', '12:Board_Memo.docx', '13:Archive_Pack.zip', '14:Old_Budget.xls', '15:Deck.pptx', '16:Photo.png', '17:Notes.json'].map((x) => `<li><a href="/mime/${x.split(':')[0]}/download">${x.split(':')[1]}</a></li>`).join('')}</ul>`),
    /* an "All" tab that lists everything and a "Task" tab that lists the same file again (same name, same bytes), plus one file only in All */
    'dups-100': () => doc('Duplicates task', `<div role="tablist"><button role="tab" aria-selected="true" id="t1">All</button><button role="tab" aria-selected="false" id="t2">Task</button></div><div id="panel"></div><script>${BLOB}
const DATA = { t1: ['Same.csv', 'OnlyAll.txt'], t2: ['Same.csv'] };
function render(k) { document.getElementById('t1').setAttribute('aria-selected', k === 't1'); document.getElementById('t2').setAttribute('aria-selected', k === 't2');
  const p = document.getElementById('panel'); p.innerHTML = '<table><tbody>' + DATA[k].map((n) => '<tr><td>' + n + '</td><td><button class="dl" data-n="' + n + '">Download</button></td></tr>').join('') + '</tbody></table>';
  p.querySelectorAll('.dl').forEach((b) => { b.onclick = () => dl(b.dataset.n); }); }
document.getElementById('t1').onclick = () => render('t1'); document.getElementById('t2').onclick = () => render('t2'); render('t1');</script>`),
    /* links whose words say they are files but whose ADDRESSES are actions: none of them may be requested */
    'safety-101': () => doc('Safety task', `<ul><li><a href="/data/ok.txt">ok.txt</a></li><li><a href="/api/files/13/remove">Remove Q4.pdf</a></li><li><a href="/api/revoke/99">Revoke access to notes.txt</a></li>
<li><a href="/api/files/12/delete" aria-label="Delete Budget.xlsx"><svg width="10" height="10"></svg></a></li><li><a href="/api/items/7?action=delete">Delete log.txt</a></li><li><button type="button" id="b">Delete Budget.xlsx</button></li></ul>
<script>document.getElementById('b').onclick = () => fetch('/api/files/12/delete');</script>`),
    /* three rows, each a bare Download link whose address differs only in a token (the token IS the file id) */
    'tokens-102': () => doc('Token task', `<table><tbody><tr><td>Budget Q1</td><td><a href="/dl?token=aaa111" download>Download</a></td></tr><tr><td>Budget Q2</td><td><a href="/dl?token=bbb222" download>Download</a></td></tr><tr><td>Budget Q3</td><td><a href="/dl?token=ccc333" download>Download</a></td></tr></tbody></table>`),
    /* extension-less file names; each row carries a relative time that is rewritten every 700 ms */
    'volatile-103': () => doc('Volatile task', `<div id="t"></div><script>
const names = ['Variance Bridge', 'Board Memo', 'Sales Ledger']; let tick = 0;
function draw() { tick += 1; document.getElementById('t').innerHTML = '<table><tbody>' + names.map((n) => '<tr><td>' + n + '</td><td>updated ' + tick + ' min ago</td><td><button class="dl" data-n="' + n + '">Download</button></td></tr>').join('') + '</tbody></table>';
  document.querySelectorAll('.dl').forEach((b) => { b.onclick = () => { const f = b.dataset.n.replace(/ /g, '_') + '.txt'; const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['content of ' + f])); a.download = f; document.body.appendChild(a); a.click(); a.remove(); }; }); }
draw(); setInterval(draw, 700);</script>`),
    /* the Reference tab fills from an API that answers after 4 s */
    'pendingtab-104': () => doc('Slow tab task', `<div role="tablist"><button role="tab" aria-selected="true" id="t1">Task</button><button role="tab" aria-selected="false" id="t2">Reference</button></div><div id="panel"></div><script>
let cur = 't1';
function render() { document.getElementById('t1').setAttribute('aria-selected', cur === 't1'); document.getElementById('t2').setAttribute('aria-selected', cur === 't2'); const p = document.getElementById('panel');
  if (cur === 't1') { p.innerHTML = '<ul><li><a href="/data/Task_A.txt">Task_A.txt</a></li></ul>'; return; }
  p.innerHTML = '<p>Loading...</p>';
  fetch('/api/ref?delay=4000').then((r) => r.json()).then((j) => { if (cur === 't2') p.innerHTML = '<ul>' + j.map((n) => '<li><a href="/data/' + n + '">' + n + '</a></li>').join('') + '</ul>'; }); }
document.getElementById('t1').onclick = () => { cur = 't1'; render(); }; document.getElementById('t2').onclick = () => { cur = 't2'; render(); }; render();</script>`),
    /* each "Load more" press fetches 10 files from an API that takes 3.5 s (30 files in all) */
    'pendingmore-105': () => doc('Slow more task', `<ul id="l"></ul><button id="more">Load more</button><script>
let shown = 0; const N = 30;
function more() { fetch('/api/more?delay=3500&from=' + shown).then((r) => r.json()).then((next) => { shown += next.length; document.getElementById('l').insertAdjacentHTML('beforeend', next.map((n) => '<li><a href="/data/' + n + '">' + n + '</a></li>').join('')); if (shown >= N) document.getElementById('more').remove(); }); }
document.getElementById('more').onclick = more; more();</script>`),
    /* the switch is called "Everything"; the person turns it on; the router moves to a SIBLING path (not below the link's path) */
    'flipmain-106': () => doc('Flip main task', `<label><input type="checkbox" id="all"> Everything</label><div id="list"></div><script>${BLOB}
function render() { const on = location.pathname === '/tasks/flipall-106'; document.getElementById('all').checked = on;
  const names = ['Person_Task.txt'].concat(on ? ['Person_A.txt', 'Person_B.txt'] : []);
  document.getElementById('list').innerHTML = '<table><tbody>' + names.map((n) => '<tr><td>' + n + '</td><td><button class="dl" data-n="' + n + '">Download</button></td></tr>').join('') + '</tbody></table>';
  document.querySelectorAll('.dl').forEach((b) => { b.onclick = () => dl(b.dataset.n); }); }
document.getElementById('all').onchange = (e) => { history.pushState({}, '', e.target.checked ? '/tasks/flipall-106' : '/tasks/flipmain-106'); render(); };
render();
setInterval(async () => { const j = await (await fetch('/__person/flip?name=flipmain-106')).json(); if (j.go) document.getElementById('all').click(); }, 150);</script>`),
    /* blob Download buttons INSIDE an iframe (the download names the iframe's frame), a closed details there, and two "Load more" buttons on the page */
    'flipall-106': () => PAGES['flipmain-106'](),
    'framebtn-107': () => {
      const inner = `<table><tbody><tr><td>Frame_Btn_A.txt</td><td><button class="dl" data-n="Frame_Btn_A.txt">Download</button></td></tr><tr><td>Frame_Btn_B.txt</td><td><button class="dl" data-n="Frame_Btn_B.txt">Download</button></td></tr></tbody></table><script>function dl(n){ const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['content of ' + n])); a.download = n; document.body.appendChild(a); a.click(); a.remove(); }
document.querySelectorAll('.dl').forEach((b) => { b.onclick = () => dl(b.dataset.n); });<\/script>`;
      return doc('Frame button task', `<iframe style="width:600px;height:200px" srcdoc="${inner.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe>`);
    },
    /* two sections with a "Load more" each: the first button never goes away and adds nothing after its first press; the second adds 5 files a press up to 15 */
    'twomore-108': () => doc('Two more task', `<h2>Section A</h2><ul id="a"><li><a href="/data/Sec_A_01.txt">Sec_A_01.txt</a></li></ul><button id="ma">Load more</button><h2>Section B</h2><ul id="b"></ul><button id="mb">Load more</button><script>
let nb = 0; function moreB() { const next = Array.from({ length: 5 }, (_, i) => 'Sec_B_' + String(nb + i + 1).padStart(2, '0') + '.txt'); nb += 5; document.getElementById('b').insertAdjacentHTML('beforeend', next.map((n) => '<li><a href="/data/' + n + '">' + n + '</a></li>').join('')); if (nb >= 15) document.getElementById('mb').remove(); }
document.getElementById('mb').onclick = moreB; moreB(); document.getElementById('ma').onclick = () => {};</script>`),
    /* addresses that end in an opaque segment, a pdf content type, and names that do not end in an extension ("3.2", "v2.1") */
    'names-109': () => doc('Names task', `<ul><li><a href="/files/pdf/31/download">Policy 3.2</a></li><li><a href="/files/pdf/32/download">Budget v2.1</a></li><li><a href="/files/pdf/33/download">Variance Bridge</a></li></ul>`),
    /* a fire-and-forget beacon (keepalive fetch whose body nobody reads) and a long poll that never answers */
    'beacon-098': () => doc('Beacon task', `<ul><li><a href="/data/Beacon_A.txt">Beacon_A.txt</a></li></ul><script>fetch('/beacon', { method: 'POST', body: 'x', keepalive: true });</script>`),
    'hang-099': () => doc('Long poll task', `<ul><li><a href="/data/Hang_A.txt">Hang_A.txt</a></li></ul><script>fetch('/api/hang').then((r) => r.text());</script>`),
    /* 60 files, five more per "Load more" press (more than the old limit of ten presses) */
    'more60-086': () => doc('Many files task', `<ul id="l"></ul><button id="more">Load more</button><script>
let shown = 0; const N = 60, PER = 5; const names = Array.from({ length: N }, (_, i) => 'M_' + String(i + 1).padStart(3, '0') + '.txt');
function more() { const next = names.slice(shown, shown + PER); shown += PER; document.getElementById('l').insertAdjacentHTML('beforeend', next.map((n) => '<li><a href="/data/' + n + '">' + n + '</a></li>').join('')); if (shown >= N) document.getElementById('more').remove(); }
document.getElementById('more').onclick = more; more();</script>`),
    /* 60 virtualised links in a 100 px box (about 3 rows on screen, a step of 2 rows): more steps than the old limit of 20 */
    'vlist60-087': () => doc('Long virtual list task', `<div id="box" style="height:100px;overflow-y:auto;position:relative"><div id="spacer" style="height:2400px"></div><ul id="tb" style="position:absolute;top:0;left:0;margin:0;padding:0;list-style:none"></ul></div><script>
const N = 60, ROW = 40, VIS = 4; const box = document.getElementById('box'), tb = document.getElementById('tb');
function draw() { const first = Math.min(N - VIS, Math.floor(box.scrollTop / ROW)); tb.style.top = (first * ROW) + 'px';
  tb.innerHTML = Array.from({ length: VIS }, (_, k) => { const n = 'V_' + String(first + k + 1).padStart(3, '0') + '.txt'; return '<li style="height:' + ROW + 'px"><a href="/data/' + n + '">' + n + '</a></li>'; }).join(''); }
box.addEventListener('scroll', draw); draw();</script>`),
  });

    /* ---- Round 5: pagers, "view all" variants, folders called Archive, tree items, trees that draw themselves anew, many tabs, the same token in
       two tabs, titles that start with a verb, files in closed dialogs, frames of another site, infinite scroll, persistent "Load more", cells
       that change, names for types a browser does not show, a person who wanders off, slow requests ---- */
    const TOGGLE_ON = '<label><input type="checkbox" id="all" checked> Show all files</label>';
    const dataLink = (n) => `<li><a href="/data/${n}">${n}</a></li>`;
    /* numbered pager buttons + Next, 4 pages of 3 links and a bare Download row each (a button on page 3 must be found again on page 3) */
    PAGES['pagenum-110'] = () => doc('Pager task', `${TOGGLE_ON}<table id="t"></table><nav aria-label="Pagination"><button class="pg" data-p="1">1</button><button class="pg" data-p="2">2</button><button class="pg" data-p="3">3</button><button class="pg" data-p="4">4</button><button id="next" aria-label="Next page">Next</button></nav><script>${BLOB}
let cur = 1;
function render() { const rows = [1, 2, 3].map((i) => 'P' + cur + '_File_0' + i + '.txt');
  document.getElementById('t').innerHTML = '<tbody>' + rows.map((n) => '<tr><td>' + n + '</td><td><a href="/data/' + n + '">' + n + '</a></td></tr>').join('') + '<tr><td>Page ' + cur + ' Memo</td><td><button class="dl" data-n="Page_' + cur + '_Memo.txt">Download</button></td></tr></tbody>';
  document.querySelectorAll('.dl').forEach((b) => { b.onclick = () => dl(b.dataset.n); });
  document.querySelectorAll('.pg').forEach((b) => b.setAttribute('aria-current', String(Number(b.dataset.p) === cur))); }
document.querySelectorAll('.pg').forEach((b) => { b.onclick = () => { cur = Number(b.dataset.p); render(); }; });
document.getElementById('next').onclick = () => { if (cur < 4) { cur += 1; render(); } };
render();</script>`);
    /* server-rendered pages: ?page=N links and rel=next */
    PAGES['pagelinks-111'] = (u) => { const p = Number((u && u.searchParams.get('page')) || 1); return doc('Linked pages task', `${TOGGLE_ON}<p>Page ${p} of 4</p><ul>${[1, 2, 3].map((i) => dataLink(`S${p}_File_0${i}.txt`)).join('')}</ul>
<nav class="pagination" aria-label="pagination">${[1, 2, 3, 4].map((n) => `<a href="?page=${n}">${n}</a>`).join(' ')} <a rel="next" href="?page=${Math.min(4, p + 1)}">Next &raquo;</a></nav>`); };
    /* pager links that also change another parameter: not followed, and said so */
    PAGES['pageother-112'] = (u) => { const p = Number((u && u.searchParams.get('page')) || 1); return doc('Other pager task', `${TOGGLE_ON}<ul>${[1, 2, 3].map((i) => dataLink(`O${p}_File_0${i}.txt`)).join('')}</ul>
<nav class="pagination" aria-label="pagination"><a href="?page=1&sort=name">1</a> <a href="?page=2&sort=name">2</a> <a rel="next" href="?page=2&sort=name">Next</a></nav>`); };
    for (const [slug, label] of [['viewall-120', 'View all (12)'], ['viewall-121', 'Show all'], ['viewall-122', 'See all'], ['viewall-123', 'Next'], ['viewall-124', 'More'], ['viewall-125', 'Load all'], ['viewall-126', 'Show remaining 8']]) {
      PAGES[slug] = () => doc('View all task', `${TOGGLE_ON}<ul id="l"></ul><button id="more">${label}</button><script>
const all = Array.from({ length: 12 }, (_, i) => 'All_' + String(i + 1).padStart(2, '0') + '.txt');
function draw(n) { document.getElementById('l').innerHTML = all.slice(0, n).map((x) => '<li><a href="/data/' + x + '">' + x + '</a></li>').join(''); } draw(4);
document.getElementById('more').onclick = () => { draw(12); document.getElementById('more').remove(); };</script>`);
    }
    /* a file tree whose folders are buttons; one is called Archive, and its files are drawn when it is opened */
    PAGES['archive-130'] = () => doc('Archive folder task', `${TOGGLE_ON}<div id="tree"></div><script>
const folders = { 'Docs (2)': ['Docs_A.txt', 'Docs_B.txt'], 'Archive (3)': ['Arch_A.txt', 'Arch_B.txt', 'Arch_C.txt'], 'Misc (1)': ['Misc_A.txt'] };
const tree = document.getElementById('tree');
for (const [name, files] of Object.entries(folders)) { const wrap = document.createElement('div'); const b = document.createElement('button'); b.setAttribute('aria-expanded', 'false'); b.textContent = name; const box = document.createElement('ul');
  b.onclick = () => { b.setAttribute('aria-expanded', 'true'); box.innerHTML = files.map((n) => '<li><a href="/data/' + n + '">' + n + '</a></li>').join(''); }; wrap.append(b, box); tree.append(wrap); }</script>`);
    /* ARIA tree items: the handler sits on the row inside the item, not on the item (131: children hidden; 132: children made on the first open) */
    for (const [slug, lazy] of [['treeitem-131', false], ['treeitem-132', true]]) {
      PAGES[slug] = () => doc('Tree item task', `${TOGGLE_ON}<ul role="tree" id="tree"></ul><script>
const data = { One: ['Tree_One_A.txt', 'Tree_One_B.txt'], Two: ['Tree_Two_A.txt'], Three: ['Tree_Three_A.txt'] }; const LAZY = ${lazy};
const tree = document.getElementById('tree');
for (const [name, files] of Object.entries(data)) { const li = document.createElement('li'); li.setAttribute('role', 'treeitem'); li.setAttribute('aria-expanded', 'false'); const row = document.createElement('div'); row.className = 'row'; row.textContent = 'Folder ' + name; const group = document.createElement('ul'); group.setAttribute('role', 'group');
  const fill = () => { group.innerHTML = files.map((n) => '<li role="treeitem"><a href="/data/' + n + '">' + n + '</a></li>').join(''); }; if (!LAZY) { fill(); group.hidden = true; }
  row.onclick = () => { const open = li.getAttribute('aria-expanded') === 'true'; li.setAttribute('aria-expanded', String(!open)); if (LAZY && !open && !group.children.length) fill(); group.hidden = open; };
  li.append(row, group); tree.append(li); }</script>`);
    }
    /* a tree that draws itself anew (innerHTML) on every click: wide (20 folders side by side) and deep (each folder holds the next) */
    PAGES['rerender-133'] = () => doc('Wide tree task', `${TOGGLE_ON}<div id="tree"></div><script>
const open = new Set(); const N = 20; const tree = document.getElementById('tree');
function render() { tree.innerHTML = Array.from({ length: N }, (_, i) => '<div><button aria-expanded="' + open.has(i) + '" data-i="' + i + '">Folder ' + i + '</button>' + (open.has(i) ? '<ul><li><a href="/data/Wide_' + String(i).padStart(2, '0') + '.txt">Wide_' + String(i).padStart(2, '0') + '.txt</a></li></ul>' : '') + '</div>').join('');
  tree.querySelectorAll('button').forEach((b) => { b.onclick = () => { open.add(Number(b.dataset.i)); render(); }; }); }
render();</script>`);
    PAGES['rerender-134'] = () => doc('Deep tree task', `${TOGGLE_ON}<div id="tree"></div><script>
const open = new Set(); const D = 8; const tree = document.getElementById('tree');
function level(k) { if (k >= D) return ''; return '<div><button aria-expanded="' + open.has(k) + '" data-k="' + k + '">Level ' + k + '</button>' + (open.has(k) ? '<ul><li><a href="/data/Deep_' + k + '.txt">Deep_' + k + '.txt</a></li></ul>' + level(k + 1) : '') + '</div>'; }
function render() { tree.innerHTML = level(0); tree.querySelectorAll('button').forEach((b) => { b.onclick = () => { open.add(Number(b.dataset.k)); render(); }; }); }
render();</script>`);
    /* 16 tabs of 2 files each */
    PAGES['tabs16-135'] = () => doc('Sixteen tabs task', `${TOGGLE_ON}<div role="tablist" id="tl"></div><div id="panel"></div><script>
const N = 16; let cur = 0; const tl = document.getElementById('tl');
function render() { tl.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-selected', String(i === cur)));
  document.getElementById('panel').innerHTML = '<ul>' + ['A', 'B'].map((x) => { const n = 'Tab_' + String(cur + 1).padStart(2, '0') + '_' + x + '.txt'; return '<li><a href="/data/' + n + '">' + n + '</a></li>'; }).join('') + '</ul>'; }
for (let i = 0; i < N; i += 1) { const b = document.createElement('button'); b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', 'false'); b.textContent = 'Section ' + (i + 1); b.onclick = () => { cur = i; render(); }; tl.append(b); }
render();</script>`);
    /* the same names with opaque tokens in two tabs (the token is a parameter, the file name is in the path), and an address that says nothing */
    PAGES['sametoken-139'] = () => doc('Same token task', `${TOGGLE_ON}<div role="tablist"><button role="tab" aria-selected="true" id="t1">Inputs</button><button role="tab" aria-selected="false" id="t2">Outputs</button></div><div id="panel"></div><script>
const data = { t1: [['report.txt', 'aaa1'], ['notes.txt', 'aaa2']], t2: [['report.txt', 'bbb1'], ['notes.txt', 'bbb2']] }; let cur = 't1';
function render() { for (const k of ['t1', 't2']) document.getElementById(k).setAttribute('aria-selected', String(k === cur));
  document.getElementById('panel').innerHTML = '<ul>' + data[cur].map(([n, t]) => '<li><a href="/dlx/' + n + '?token=' + t + '">' + n + '</a></li>').join('') + (cur === 't1' ? '<li><a href="/dlq?token=zzz9">opaque.txt</a></li>' : '') + '</ul>'; }
document.getElementById('t1').onclick = () => { cur = 't1'; render(); }; document.getElementById('t2').onclick = () => { cur = 't2'; render(); }; render();</script>`);
    /* titles that start with a verb word, and links whose address says nothing or is an action */
    PAGES['verbnames-140'] = () => doc('Verb names task', `${TOGGLE_ON}<ul>${[[91, 'Archive of 2023 correspondence'], [92, 'Reset procedure'], [93, 'Approved vendor list'], [94, 'Submit guidelines'], [95, 'Revoke and reissue policy'], [96, 'Plain document']].map(([id, t]) => `<li><a href="/files/pdf/${id}/download">${t}</a></li>`).join('')}
<li><a href="/files/42">Cancel policy</a></li><li><a href="/files/43">Reset instructions</a></li><li><a href="/files/publish/44">Q4 numbers</a></li><li><a href="/files/45/approve">Approval memo</a></li></ul>`);
    /* file links in a closed dialog (a button opens it), and in a drawer that exists only once it is opened */
    PAGES['dialog-141'] = () => doc('Dialog task', `${TOGGLE_ON}<ul>${dataLink('Dlg_Main_A.txt')}${dataLink('Dlg_Main_B.txt')}</ul><button id="open">Attachments (4)</button>
<dialog id="d"><ul>${[1, 2, 3, 4].map((i) => dataLink(`Dlg_${i}.txt`)).join('')}</ul><button id="close">Close</button></dialog><script>document.getElementById('open').onclick = () => document.getElementById('d').showModal(); document.getElementById('close').onclick = () => document.getElementById('d').close();</script>`);
    PAGES['drawer-142'] = () => doc('Drawer task', `${TOGGLE_ON}<ul>${dataLink('Drw_Main_A.txt')}${dataLink('Drw_Main_B.txt')}</ul><button id="open" aria-haspopup="dialog" aria-expanded="false">Attachments (4)</button><div id="slot"></div><script>
document.getElementById('open').onclick = () => { fetch('/hit/pressed-drawer'); document.getElementById('open').setAttribute('aria-expanded', 'true'); document.getElementById('slot').innerHTML = '<ul>' + [1, 2, 3, 4].map((i) => '<li><a href="/data/Drw_' + i + '.txt">Drw_' + i + '.txt</a></li>').join('') + '</ul>'; };</script>`);
    /* a frame of another site (another origin: localhost for 127.0.0.1) holding files, next to two links on the page */
    PAGES['xframe-143'] = () => doc('Cross frame task', `${TOGGLE_ON}<ul>${dataLink('Xf_Main_A.txt')}${dataLink('Xf_Main_B.txt')}</ul><iframe src="${filesOrigin}/frame" style="width:420px;height:200px"></iframe>`);
    /* an infinite scroller in a box: 25 rows (36 px) per chunk, the next chunk when the end sentinel is seen, 300 ms latency */
    PAGES['infscroll-144'] = () => doc('Infinite scroll task', `${TOGGLE_ON}<div id="box" style="height:420px;overflow:auto;border:1px solid #888"><ul id="l"></ul><div id="sentinel" style="height:10px">&nbsp;</div></div><script>
const N = 110, PER = 25; let shown = 0, busy = false;
function load() { if (busy || shown >= N) return; busy = true; setTimeout(() => { const end = Math.min(N, shown + PER); let h = ''; for (let i = shown + 1; i <= end; i += 1) { const n = 'Inf_' + String(i).padStart(3, '0') + '.txt'; h += '<li style="height:36px"><a href="/data/' + n + '">' + n + '</a></li>'; } shown = end; document.getElementById('l').insertAdjacentHTML('beforeend', h); busy = false; if (shown >= N) document.getElementById('sentinel').remove(); }, 300); }
new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) load(); }, { root: document.getElementById('box') }).observe(document.getElementById('sentinel'));
load();</script>`);
    /* five sections, each with a "Show more" that stays on the page for ever and adds one file a press (up to 4) */
    PAGES['persistent-145'] = () => doc('Persistent more task', `${TOGGLE_ON}<div id="s"></div><script>
const S = 5, MAX = 4; const count = Array(S).fill(1);
function render() { document.getElementById('s').innerHTML = count.map((c, k) => '<h3>Section ' + k + '</h3><ul>' + Array.from({ length: c }, (_, i) => '<li><a href="/data/Sec' + k + '_' + (i + 1) + '.txt">Sec' + k + '_' + (i + 1) + '.txt</a></li>').join('') + '</ul><button class="m" data-k="' + k + '">Show more</button>').join('');
  document.querySelectorAll('.m').forEach((b) => { b.onclick = () => { const k = Number(b.dataset.k); if (count[k] < MAX) { count[k] += 1; render(); } }; }); }
render();</script>`);
    /* extension-less rows with five cells that change while the page is open */
    PAGES['volatile-146'] = () => doc('Volatile cells task', `<div id="t"></div><script>
const names = ['Variance Bridge', 'Board Memo', 'Sales Ledger']; let tick = 0;
function draw() { tick += 1; document.getElementById('t').innerHTML = '<table><tbody>' + names.map((n) => '<tr><td>' + n + '</td><td>Processing ' + (tick % 100) + '%</td><td>' + tick + ' downloads</td><td>Viewed by ' + (tick % 7) + ' people</td><td>' + (tick % 2 ? 'Queued' : 'Ready') + '</td><td>' + (tick % 5) + ' comments</td><td><button class="dl" data-n="' + n + '">Download</button></td></tr>').join('') + '</tbody></table>';
  document.querySelectorAll('.dl').forEach((b) => { b.onclick = () => { const f = b.dataset.n.replace(/ /g, '_') + '.txt'; const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['content of ' + f])); a.download = f; document.body.appendChild(a); a.click(); a.remove(); }; }); }
draw(); setInterval(draw, 700);</script>`);
    /* names with no extension for types a browser does not show inline (xlsx) and one it does (csv) */
    PAGES['nonline-147'] = () => doc('Non inline task', `<ul><li><a href="/xl/51/download">Q3 Variance Bridge</a></li><li><a href="/xl/52/download">Board Memo Final</a></li><li><a href="/xl/53/download">Sales Ledger</a></li></ul>`);
    /* the person is asked to turn on a switch, goes to another page of the site instead, and presses Continue */
    PAGES['wander-148'] = () => doc('Wander task', `<a href="/wander-home">Home</a><label><input type="checkbox" id="all"> Everything</label><div id="list"></div><script>${BLOB}
function render() { const names = ['Wander_A.txt', 'Wander_B.txt'].concat(document.getElementById('all').checked ? ['Wander_World.txt'] : []);
  document.getElementById('list').innerHTML = '<table><tbody>' + names.map((n) => '<tr><td>' + n + '</td><td><button class="dl" data-n="' + n + '">Download</button></td></tr>').join('') + '</tbody></table>';
  document.querySelectorAll('.dl').forEach((b) => { b.onclick = () => dl(b.dataset.n); }); }
document.getElementById('all').onchange = render; render();
setInterval(async () => { const j = await (await fetch('/__person/flip?name=wander-148')).json(); if (j.go) location.href = '/wander-home'; }, 150);</script>`);
    /* the files come from an API that answers after 30 s (longer than the loader waits for one request), after a tab is opened */
    PAGES['slowtab-150'] = () => doc('Very slow tab task', `<div role="tablist"><button role="tab" aria-selected="true" id="t1">Task</button><button role="tab" aria-selected="false" id="t2">Reference</button></div><div id="panel"></div><script>
let cur = 't1';
function render() { document.getElementById('t1').setAttribute('aria-selected', cur === 't1'); document.getElementById('t2').setAttribute('aria-selected', cur === 't2'); const p = document.getElementById('panel');
  if (cur === 't1') { p.innerHTML = '<ul><li><a href="/data/Task_A.txt">Task_A.txt</a></li></ul>'; return; }
  p.innerHTML = '<p>Loading...</p>'; fetch('/api/ref?delay=30000').then((r) => r.json()).then((j) => { if (cur === 't2') p.innerHTML = '<ul>' + j.map((n) => '<li><a href="/data/' + n + '">' + n + '</a></li>').join('') + '</ul>'; }); }
document.getElementById('t1').onclick = () => { cur = 't1'; render(); }; document.getElementById('t2').onclick = () => { cur = 't2'; render(); }; render();</script>`);

    /* ---- UNSAFE controls: none of these may be requested or pressed (each says so on the server when it is) ---- */
    const UNSAFE = '/api/unsafe';
    /* a danger button whose label looks like "all files" */
    PAGES['clear-160'] = () => doc('Clear task', `<ul>${dataLink('Main_A.txt')}</ul><div class="uploader"><button id="clear" class="btn-danger">Clear all files</button></div><script>document.getElementById('clear').onclick = () => { fetch('/hit/pressed-clear'); fetch('${UNSAFE}/clear-160/files', { method: 'DELETE' }); };</script>`);
    /* a settings switch that says "all attachments", before the real switch */
    PAGES['settings-161'] = () => doc('Settings task', `<section><h2>My settings</h2><label><input type="checkbox" id="digest"> Include all attachments in my daily digest email</label></section><label><input type="checkbox" id="all"> Show all files</label><ul id="l">${dataLink('Set_Main_A.txt')}</ul><script>
document.getElementById('digest').onchange = (e) => { fetch('/hit/pressed-digest'); fetch('${UNSAFE}/settings-161/preferences', { method: 'PUT', body: JSON.stringify({ digestAttachments: e.target.checked }) }); };
document.getElementById('all').onchange = (e) => { document.getElementById('l').innerHTML = '${dataLink('Set_Main_A.txt')}' + (e.target.checked ? '${dataLink('Set_World_A.txt')}' : ''); };</script>`);
    /* a bulk-actions list whose option says "all files" */
    PAGES['bulk-162'] = () => doc('Bulk task', `<label for="bulk">Bulk actions</label><select id="bulk"><option>Choose an action</option><option>Mark all files as reviewed</option><option>Delete all files</option></select><ul>${dataLink('Bulk_A.txt')}</ul><script>
document.getElementById('bulk').onchange = (e) => { fetch('/hit/pressed-bulk'); fetch('${UNSAFE}/bulk-162/review-all', { method: 'POST' }); };</script>`);
    /* "Download X" controls that submit a POST form through script: inline handlers (seen) and listeners (not seen) */
    PAGES['scriptform-163'] = () => doc('Script form task', `<form id="f1" method="post" action="${UNSAFE}/scriptform-163/export/1"></form><form id="f2" method="post" action="${UNSAFE}/scriptform-163/export/2"></form><form id="f3" method="post" action="${UNSAFE}/scriptform-163/export/3"></form>
<ul><li>Q3_Report.txt <a href="#" onclick="fetch('/hit/pressed-f1');document.getElementById('f1').submit();return false">Download Q3_Report.txt</a></li>
<li>Q4_Report.txt <div role="button" tabindex="0" onclick="fetch('/hit/pressed-f2');document.getElementById('f2').submit()">Download Q4_Report.txt</div></li>
<li>Q5_Report.txt <button type="button" id="b3">Download Q5_Report.txt</button></li>${dataLink('Script_Ok.txt')}</ul>
<script>document.getElementById('b3').addEventListener('click', () => { fetch('/hit/pressed-f3'); document.getElementById('f3').submit(); });</script>`);
    /* export and app buttons that send data somewhere else */
    PAGES['export-165'] = () => doc('Export task', `<ul>${dataLink('Main_A.txt')}</ul><div class="toolbar"><button id="b1">Export to Google Sheets</button> <button id="b2">Export to Slack</button> <button id="b3">Download app</button></div><script>
for (const [id, path] of [['b1', 'sheets/export'], ['b2', 'slack/post'], ['b3', 'telemetry/app-download']]) document.getElementById(id).onclick = () => { fetch('/hit/pressed-' + id); fetch('${UNSAFE}/export-165/' + path, { method: 'POST' }); };</script>`);
    /* icon-only row actions that are plain GET links */
    PAGES['trash-166'] = () => doc('Trash links task', `<table>${[[11, 'Q1_Budget.txt'], [12, 'Q2_Budget.txt']].map(([id, n]) => `<tr><td><a href="/docs/${id}/${n}">${n}</a></td><td><a href="/docs/${id}/trash" aria-label="Move to trash">x</a></td><td><a href="/docs/${id}/detach" title="Detach from task">y</a></td><td><a href="/docs/${id}/share-publicly" aria-label="Share link">z</a></td></tr>`).join('')}</table>`);
    /* a switch whose label passes the "show all files" words and also says "mark ... reviewed": the words about actions win */
    PAGES['togglemix-168'] = () => doc('Toggle mix task', `<ul>${dataLink('Mix_A.txt')}</ul><label><input type="checkbox" id="mix"> Show all attachments and mark them reviewed</label><script>
document.getElementById('mix').onchange = () => { fetch('/hit/pressed-mix'); fetch('${UNSAFE}/togglemix-168/review', { method: 'POST' }); };</script>`);
    /* ---- Round 6: controls that LOOK like navigation and save something (the write guard and the shapes) ---- */
    const SAVE = (slug, path, method, body = '') => `fetch('/hit/pressed-${slug}'); fetch('${UNSAFE}/${slug}/${path}', { method: '${method}'${body ? `, body: ${JSON.stringify(body)}` : ''} })`;
    /* an estimate picker: numbered buttons in a list, the current one marked */
    PAGES['points-170'] = () => doc('Points task', `${TOGGLE_ON}<h2>Estimate</h2><ul class="points" id="pts">${[1, 2, 3, 5, 8].map((n) => `<li class="${n === 2 ? 'selected' : ''}"><button type="button" data-n="${n}">${n}</button></li>`).join('')}</ul><ul>${dataLink('Pts_A.txt')}</ul>
<script>document.querySelectorAll('#pts button').forEach((b) => { b.onclick = () => { ${SAVE('points-170', 'estimate', 'PUT', '{"points":1}')}; }; });</script>`);
    /* a card with move-left and move-right arrows */
    PAGES['kanban-171'] = () => doc('Kanban task', `${TOGGLE_ON}<div class="card"><button type="button" aria-label="Move to previous stage" id="l">\u2190</button> <span>Status: To do</span> <button type="button" aria-label="Move to next stage" id="r">\u2192</button></div><ul>${dataLink('Kan_A.txt')}</ul>
<script>for (const id of ['l', 'r']) document.getElementById(id).onclick = () => { ${SAVE('kanban-171', 'status', 'PATCH', '{"status":"In progress"}')}; };</script>`);
    /* a review wizard: a lone Next saves the step */
    PAGES['wizard-172'] = () => doc('Wizard task', `${TOGGLE_ON}<p id="s">Step 1 of 3</p><button type="button" id="n">Next</button><ul>${dataLink('Wiz_A.txt')}</ul>
<script>document.getElementById('n').onclick = () => { ${SAVE('wizard-172', 'steps/1', 'PUT', '{"saved":true}')}; document.getElementById('s').textContent = 'Step 2 of 3'; };</script>`);
    /* a vote button */
    PAGES['plusone-173'] = () => doc('Plus one task', `${TOGGLE_ON}<p>Votes: 3</p><button type="button" id="v">+1</button><ul>${dataLink('Vote_A.txt')}</ul><script>document.getElementById('v').onclick = () => { ${SAVE('plusone-173', 'vote', 'POST')}; };</script>`);
    /* a status picker built as tabs */
    PAGES['tabstatus-174'] = () => doc('Status tabs task', `${TOGGLE_ON}<div role="tablist" aria-label="Status"><button role="tab" aria-selected="true">To do</button><button role="tab" aria-selected="false">In progress</button><button role="tab" aria-selected="false">Done</button></div><ul>${dataLink('Stat_A.txt')}</ul>
<script>document.querySelectorAll('[role=tab]').forEach((b) => { b.onclick = () => { document.querySelectorAll('[role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b))); ${SAVE('tabstatus-174', 'status', 'PATCH', '{"status":"x"}')}; }; });</script>`);
    /* tabs that are links to a trash and a sharing page; and to an archive */
    PAGES['tablink-175'] = () => doc('Tab links task', `${TOGGLE_ON}<div role="tablist"><a role="tab" aria-selected="true" href="/tasks/tablink-175">Files</a><a role="tab" aria-selected="false" href="/projects/7/trash">Trash</a><a role="tab" aria-selected="false" href="/projects/7/share">Sharing</a></div><ul>${dataLink('Tl_A.txt')}</ul>`);
    PAGES['tablink-176'] = () => doc('Archive tab link task', `${TOGGLE_ON}<div role="tablist"><a role="tab" aria-selected="true" href="/tasks/tablink-176">Files</a><a role="tab" aria-selected="false" href="/tasks/tablink-176/archive">Archive</a></div><ul>${dataLink('Tl2_A.txt')}</ul>`);
    /* a permission list whose option says "Can view all files" */
    PAGES['perm-177'] = () => doc('Permission task', `<label>Client access <select id="p"><option value="none">No access</option><option value="read">Can view all files</option><option value="write">Can edit</option></select></label><ul>${dataLink('Perm_A.txt')}</ul>
<script>document.getElementById('p').onchange = (e) => { ${SAVE('perm-177', 'client-access', 'PUT')}; };</script>`);
    /* a preferences form that posts when the box is ticked */
    PAGES['autosubmit-178'] = () => doc('Auto submit task', `<form method="post" action="${UNSAFE}/autosubmit-178/prefs"><label><input type="checkbox" name="show_all" value="1" onchange="fetch('/hit/pressed-autosubmit-178'); this.form.submit()"> Show all files</label></form><ul>${dataLink('Auto_A.txt')}</ul>`);
    /* tabs whose lists are loaded with a GraphQL POST (a query: must work); a tab that sends a mutation (must be stopped) */
    PAGES['graphql-179'] = () => doc('GraphQL tabs task', `${TOGGLE_ON}<div role="tablist"><button role="tab" aria-selected="true" id="t1">Task</button><button role="tab" aria-selected="false" id="t2">Reference</button><button role="tab" aria-selected="false" id="t3">Mark seen</button></div><div id="panel"></div><script>
let cur = 't1';
const gql = (query, variables) => fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) }).then((r) => r.json());
function render() { for (const k of ['t1', 't2', 't3']) document.getElementById(k).setAttribute('aria-selected', String(k === cur)); const p = document.getElementById('panel');
  if (cur === 't1') { p.innerHTML = '<ul><li><a href="/data/Task_A.txt">Task_A.txt</a></li></ul>'; return; }
  if (cur === 't2') { p.textContent = 'Loading...'; gql('query Files($tab: String!) { files(tab: $tab) { name } }', { tab: 'ref' }).then((j) => { if (cur === 't2') p.innerHTML = '<ul>' + j.data.files.map((f) => '<li><a href="/data/' + f.name + '">' + f.name + '</a></li>').join('') + '</ul>'; }); return; }
  p.textContent = 'Loading...'; gql('mutation MarkSeen($id: ID!) { markSeen(id: $id) { ok } }', { id: 7 }).then((j) => { if (cur === 't3') p.innerHTML = '<ul><li><a href="/data/Seen_A.txt">Seen_A.txt</a></li></ul>'; }); }
for (const k of ['t1', 't2', 't3']) document.getElementById(k).onclick = () => { cur = k; render(); };
render();</script>`);
    /* links whose addresses are actions, whatever they are called */
    PAGES['actions-167'] = () => doc('Action addresses task', `<ul>${dataLink('Act_Ok.txt')}${[
      ['/api/unsafe/actions-167/remove', ' download', 'Q4 pack'], ['/api/unsafe/actions-167/delete?filename=Q4b.pdf', '', 'Q4b'], ['/docs/15/submit', '', 'Download'], ['/docs/16/actions/run', '', 'Download'], ['/docs/17/cancel', '', 'Download'], ['/docs/18/archive', '', 'Download'],
      ['/docs/19?action=submit', '', 'Download'], ['/docs/20?method=delete', '', 'Download'], ['/docs/21?_method=DELETE', '', 'Download'], ['/docs/22/delete/now', '', 'Download'], ['/docs/24/destroy', '', 'Download'], ['/docs/25/trash', '', 'Download'], ['/docs/26/actions', '', 'Download'],
      ['/docs/27/revoke', '', 'Download'], ['/docs/28/publish', '', 'Download'], ['/docs/29/unsubscribe', '', 'Download']].map(([h, a, t], i) => `<li>Row ${i}: <a href="${h}"${a}>${t}</a></li>`).join('')}</ul>`);

  const main = await listen((req, res) => {
    const u = new URL(req.url, 'http://x');
    const signedIn = flags.openAccess || sessions.has(cookieOf(req, 'sid'));
    requests.push({ origin: 'main', method: req.method, path: u.pathname, cookie: Boolean(req.headers.cookie), at: Date.now() });
    if (u.pathname === '/__person/signin') return send(res, 200, 'application/json', JSON.stringify({ go: person.signin }));
    if (u.pathname === '/__person/flip') return send(res, 200, 'application/json', JSON.stringify({ go: person.flips.delete(u.searchParams.get('name')) }));   /* once: a person clicks once */
    if (u.pathname === '/') {
      if (!signedIn) { res.writeHead(302, { location: `/login?next=%2F&state=${LOGIN_CANARY}` }); return res.end(); }
      return send(res, 200, 'text/html; charset=utf-8', '<!doctype html><title>Home</title><h1>Home</h1><p>You are signed in.</p>');
    }
    if (u.pathname === '/login' && req.method === 'GET') {
      if (u.searchParams.get('state') === LOGIN_CANARY) stats.canaryHits += 1;
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
    if (u.pathname === '/wander-home') return send(res, 200, 'text/html; charset=utf-8', '<!doctype html><title>Home</title><h1>Home</h1><h2>News</h2><p>Home page of the platform, not the task.</p><ul><li><a href="/data/Home_Doc.txt">Home_Doc.txt</a></li></ul>');
    if (u.pathname === '/graphql' && req.method === 'POST') {   /* a data query is answered; a mutation is counted (it must never arrive) */
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => { if (/\bmutation\b/i.test(body)) stats.mutations += 1; return send(res, 200, 'application/json', JSON.stringify({ data: { files: [{ name: 'Ref_A.txt' }, { name: 'Ref_B.txt' }] } })); });
      return undefined;
    }
    const dlx = /^\/dlx\/([^/]+)$/.exec(u.pathname);   /* the file name is in the path, the token in the query: the bytes depend on the token */
    if (dlx) { const name = decodeURIComponent(dlx[1]); const t = u.searchParams.get('token') || ''; return send(res, 200, 'text/plain', `${t.startsWith('aaa') ? 'INPUT' : 'OUTPUT'} ${name}`, { 'content-disposition': `attachment; filename="${name}"` }); }
    const xl = /^\/xl\/(\d+)\/download$/.exec(u.pathname);   /* no Content-Disposition: Chrome names it download.xlsx, and shows a csv inline */
    if (xl) return xl[1] === '53' ? send(res, 200, 'text/csv', 'a,b\n1,2\n') : send(res, 200, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', `PK xl${xl[1]}`);
    const docFile = /^\/docs\/(\d+)\/([^/]+\.txt)$/.exec(u.pathname);
    if (docFile) return send(res, 200, 'text/plain', `content of ${decodeURIComponent(docFile[2])}`, { 'content-disposition': `attachment; filename="${decodeURIComponent(docFile[2])}"` });
    const dataFile = /^\/data\/(?:publish\/)?([^/]+)$/.exec(u.pathname);
    if (dataFile) {
      const name = decodeURIComponent(dataFile[1]);
      return send(res, 200, 'text/plain', `content of ${name}`, { 'content-disposition': `attachment; filename="${name}"` });
    }
    if (u.pathname.startsWith('/hit/')) return send(res, 200, 'text/plain', 'ok');
    if (u.pathname === '/dl') { const t = u.searchParams.get('token'); return send(res, 200, 'application/octet-stream', `content of file_${t}.txt`, { 'content-disposition': `attachment; filename="file_${t}.txt"` }); }
    if (u.pathname === '/api/ref') { setTimeout(() => send(res, 200, 'application/json', JSON.stringify(['Ref_1.txt', 'Ref_2.txt'])), Number(u.searchParams.get('delay')) || 0); return undefined; }
    if (u.pathname === '/api/more') {
      const from = Number(u.searchParams.get('from')) || 0;
      setTimeout(() => send(res, 200, 'application/json', JSON.stringify(Array.from({ length: 10 }, (_, i) => `Slow_${String(from + i + 1).padStart(3, '0')}.txt`))), Number(u.searchParams.get('delay')) || 0);
      return undefined;
    }
    const pdf = /^\/files\/pdf\/(\d+)\/download$/.exec(u.pathname);
    if (pdf) return send(res, 200, 'application/pdf', `%PDF-1.4 content of ${pdf[1]}`);
    if (u.pathname.startsWith('/api/') && u.pathname !== '/api/world' && u.pathname !== '/api/hang') { stats.apiActions += 1; return send(res, 200, 'text/plain', 'done'); }   /* anything else under /api/ is an action the loader must never ask for */
    if (u.pathname === '/beacon') return send(res, 200, 'text/plain', 'ok');
    if (u.pathname === '/api/hang') return undefined;   /* a long poll: no answer, ever */
    const mime = /^\/mime\/(\d+)\/download$/.exec(u.pathname);
    if (mime) {
      const XL = 'application/vnd.openxmlformats-officedocument';
      const [name, type] = { 11: ['Variance_Bridge.xlsx', `${XL}.spreadsheetml.sheet`], 12: ['Board_Memo.docx', `${XL}.wordprocessingml.document`], 13: ['Archive_Pack.zip', 'application/zip'], 14: ['Old_Budget.xls', 'application/vnd.ms-excel'],
        15: ['Deck.pptx', `${XL}.presentationml.presentation`], 16: ['Photo.png', 'image/png'], 17: ['Notes.json', 'application/json'] }[mime[1]];
      return send(res, 200, type, `content of ${name}`);
    }
    const opaque = /^\/opaque\/(\d+)\/download$/.exec(u.pathname);
    if (opaque) {
      const name = { 11: 'Variance_Bridge.xlsx', 12: 'Sales_Ledger.csv', 13: 'Board_Memo.pdf', 14: 'Grader_Guideline.pdf' }[opaque[1]];
      return send(res, 200, 'application/octet-stream', `content of ${name}`);   /* no Content-Disposition, nothing in the address */
    }
    if (u.pathname === '/documents/42') return send(res, 200, 'application/octet-stream', 'content of Budget_2025.xlsx');
    if (u.pathname.startsWith('/denied/')) return send(res, 403, 'text/html', '<h1>forbidden</h1>');
    if (u.pathname === '/api/world') {
      setTimeout(() => send(res, 200, 'application/json', JSON.stringify(['World_A.txt', 'World_B.txt'])), Number(u.searchParams.get('delay')) || 0);
      return undefined;
    }
    const task = /^\/tasks\/([a-z0-9-]+)(?:\/all)?$/.exec(u.pathname);
    if (task) {
      if (!signedIn) { res.writeHead(302, { location: `/login?next=${encodeURIComponent(u.pathname)}` }); return res.end(); }
      if (task[1] === 'missing-404') return send(res, 404, 'text/html; charset=utf-8', '<h1>Not found</h1>');
      if (!PAGES[task[1]]) return send(res, 404, 'text/html', 'no such task');
      return send(res, 200, 'text/html; charset=utf-8', PAGES[task[1]](u));
    }
    const file = /^\/files\/([a-z0-9-]+)(?:\/[^/]+)?$/.exec(u.pathname);
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
  let lastAsk = '';
  const end = Date.now() + limitMs;
  for (;;) {
    const state = loader.get(id);
    /* a handler runs the first time its state is seen; a person is asked again when the question changes */
    const ask = /^needs-/.test(state.state) ? `${state.state}|${state.message}` : '';
    if (!seen.includes(state.state) || (ask && ask !== lastAsk)) {
      if (!seen.includes(state.state)) seen.push(state.state);
      lastAsk = ask;
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
    assert.deepEqual(Object.keys(s1).sort(), ['error', 'files', 'folder', 'id', 'message', 'notes', 'page', 'sections', 'skipped', 'state', 'toggle']);
    assert.deepEqual([s1.error, s1.skipped], [null, []]);
    assert.deepEqual(s1.page, { origin: platform.origin, path: '/tasks/atlas-001' });
    assert.equal(s1.folder, path.join(root, 'private', 'links', id1));
    assert.deepEqual(s1.toggle, toggle(true, 'Show all files', true, 4, 7, false));
    ok('flow: starting, needs-sign-in, loading, downloading, done; the state has the specified keys plus skipped and notes; the switch "Show all files" was found by its label, clicked, and the file count went from 4 to 7');
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
    assert.deepEqual(Object.keys(pageJson).sort(), ['fileList', 'loadedAt', 'notes', 'page', 'sections', 'skipped']);
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
    assert.deepEqual(labels(runF.final), ['Atlas_Gated.txt', 'Atlas_Prompt.txt', 'Borealis_Extra.txt', 'Download Atlas_Blob.txt']);
    assert.deepEqual(runF.final.skipped.map((s) => s.label).sort(), skippedAsked.skipped.map((s) => s.label).sort());
    const blob = runF.final.files.find((f) => f.label === 'Download Atlas_Blob.txt');
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
      const dir = path.join(tmp, `batch-${spec.name || spec.slug}`);
      fs.mkdirSync(dir);
      if (spec.learn) { fs.mkdirSync(path.join(dir, 'private'), { recursive: true }); fs.writeFileSync(path.join(dir, 'private', 'link-mappings.json'), JSON.stringify({ schema: 'finance-link-mappings', version: 1, hosts: { [new URL(platform.origin).host]: { updatedAt: '2026-10-01T00:00:00.000Z', allFilesToggle: spec.learn } } })); }
      const l = makeLoader(dir, spec.loader || {});
      const asked = [];
      const handlers = spec.handlers ? spec.handlers(l) : {};
      if (!handlers['needs-person']) handlers['needs-person'] = async (state) => { asked.push(state); await delay(100); l.continue(state.id); };   /* the person presses Continue */
      return { spec, dir, asked, ...(await drive(l, l.start(`${platform.origin}/tasks/${spec.slug}${spec.query || ''}`), handlers)) };
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

    /* 11b. The review's identity, expansion, naming and control cases (each its own Chrome; two batches). */
    const fileNames = (st) => st.files.map((f) => f.name).sort();
    const wrongContent = (st) => st.files.filter((f) => fs.readFileSync(path.join(st.folder, 'files', f.name), 'utf8') !== `content of ${f.name}`).map((f) => f.name);
    const clean = (r, expected, why) => {
      assert.equal(r.final.state, 'done', `${why}: ${JSON.stringify(r.final)}`);
      assert.deepEqual(fileNames(r.final), expected.slice().sort(), why);
      assert.deepEqual(r.final.skipped, [], `${why}: nothing is left out silently`);
      assert.deepEqual(wrongContent(r.final), [], `${why}: every file has the content of its own name`);
    };
    const NOT_CLEAR = 'not clearly a download: download it yourself';
    const requestsTo = (re) => platform.requests.filter((r) => re.test(r.path));
    const pressed = (name) => platform.count(`/hit/${name}`);
    const notesOf = (r) => JSON.parse(fs.readFileSync(path.join(r.final.folder, 'page.json'), 'utf8')).notes;
    const range = (prefix, n, width = 2, ext = '.txt') => Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(width, '0')}${ext}`);
    const third = await batch([
      { slug: 'tabs-070' }, { slug: 'tabs-071' }, { slug: 'vtable-072' }, { slug: 'vlinks-073' }, { slug: 'tabmore-074' }, { slug: 'tree-075' },
    ]);
    clean(get(third, 'tabs-070'), ['Task_A.txt', 'Task_B.txt', 'Ref_A.txt', 'Ref_B.txt', 'Ref_C.txt'], 'tabs');
    ok('tabs whose rows only say "Download": the files of the second tab (Ref_A, Ref_B, Ref_C) are not lost into the first tab\'s slots, nothing is "gone from the page", and every file has its own content (the row text is part of the identity and is checked before each click)');
    clean(get(third, 'tabs-071'), ['Task_A.txt', 'Task_B.txt', 'World_A.txt', 'World_B.txt', 'World_C.txt'], 'world tab');
    ok('a tab called "World files" is a tab, not the switch: no switch is found (the person is asked and presses Continue), and the files of both tabs are found, pressed in their own tab, and saved under their own names');
    clean(get(third, 'vtable-072'), range('File_', 24), 'virtual table');
    clean(get(third, 'vlinks-073'), range('Link_', 24), 'virtual blob links');
    ok('a virtualised table of 24 rows with "Download" buttons, and the same with blob: links built when a row is drawn: all 24 are saved (the page is scrolled back to each row\'s place before the click; the 11th download is not dropped by Chrome)');
    clean(get(third, 'tabmore-074'), ['Task_A.txt', 'Task_B.txt', ...range('Ref_', 9, 1)], 'paged tab');
    ok('"Load more" and scrolling run in every tab, not only the open one: the Reference tab\'s 9 files behind three "Load more" presses are all found');
    const tree = get(third, 'tree-075');
    clean(tree, ['Task_A.txt', 'Tree_Top.txt', 'Tree_Deep.txt', 'World_A.txt', 'World_B.txt'], 'tree');
    assert.deepEqual(tree.final.toggle, toggle(true, 'Show all files', true, 3, 5, false));
    assert.ok(!tree.seen.includes('needs-person'), 'the switch added files, nobody is asked');
    ok('a folder inside a folder (opened one level per pass) and a closed <details> group that the switch adds are both opened: nothing is missing, and the switch is not reported as "did nothing"');
    for (const r of third) assert.deepEqual(leftovers(profileOf(r.dir)), [], r.spec.slug);

    const fourth = await batch([
      { slug: 'router-076' }, { slug: 'denied-077' }, { slug: 'verbs-078' }, { slug: 'controls-079' }, { slug: 'form-080' }, { slug: 'signed-081' },
    ]);
    clean(get(fourth, 'router-076'), ['Task_A.txt', 'World_A.txt', 'World_B.txt'], 'router');
    assert.equal(platform.count('/tasks/router-076'), 1, 'the task page was fetched once: no reload that would lose the switch');
    ok('a switch that changes the address (pushState to .../all): the world files are pressed where they are, the page is never reloaded');
    const denied = get(fourth, 'denied-077');
    assert.equal(denied.final.state, 'done', JSON.stringify(denied.final));
    assert.deepEqual(fileNames(denied.final), ['Task_A.txt', 'World_B.txt', 'World_C.txt']);
    assert.deepEqual(denied.final.skipped, [{ label: 'Restricted.txt', group: 'Files', reason: 'http-denied' }]);
    assert.equal(denied.asked.length, 1);
    assert.match(denied.asked[0].message, /^1 file could not be downloaded: Restricted\.txt\./);
    assert.equal(platform.count('/tasks/denied-077'), 1, 'a refused plain link is NOT clicked in the task tab (that would navigate it to the error page)');
    assert.equal(platform.count('/denied/Restricted.txt'), 1, 'and it is asked for once');
    assert.deepEqual(wrongContent(denied.final), []);
    ok('a world file whose plain link answers 403: listed in skipped (http-denied) and asked about; it is not retried by clicking it in the task tab, so the other world files are still saved');
    const verbs = get(fourth, 'verbs-078');
    assert.equal(verbs.final.state, 'done', JSON.stringify(verbs.final));
    assert.deepEqual(fileNames(verbs.final), ['Archive_2025_Q4.zip', 'Reset_policy.pdf', 'ok.txt']);
    assert.deepEqual(verbs.final.skipped.map((x) => [x.label, x.reason]).sort(), [['Danger.pdf', 'looks like an action'], ['Delete log.txt', 'looks like an action'], ['Plan.txt', 'looks like an action']]);
    assert.equal(platform.stats.deleteRequests, 0, 'the "Delete log.txt" button was not pressed');
    assert.equal(platform.count('/data/publish/Plan.txt') + platform.count('/data/Danger.pdf'), 0, 'neither the /publish/ address nor the ?action=delete address was requested');
    ok('"Archive 2025 Q4.zip" and "Reset policy.pdf" are files (an action word in a file NAME is fine) and are saved; an address with a /publish/ folder or ?action=delete and a button called "Delete log.txt" are never requested or pressed, and each is listed in skipped as "looks like an action"');
    const controlsRun = get(fourth, 'controls-079');
    assert.equal(controlsRun.final.state, 'done', JSON.stringify(controlsRun.final));
    assert.deepEqual(fileNames(controlsRun.final), ['b2.txt', 'b3.txt', 'b4.txt', 'b5.txt', 'ok.txt']);
    assert.deepEqual(controlsRun.final.skipped, [{ label: 'Budget_2025.xlsx', group: 'Files', reason: 'not clearly a download: download it yourself' }]);
    assert.equal(platform.count('/documents/42'), 0, 'a link that only has a file name for text is not requested');
    ok('controls are recognised by what they are named: a "#" link and a link without an address with role=button, an icon-only button titled "Download file", an aria-label "Download Budget5.xlsx"; a link whose text is a file name and whose address says nothing (/documents/42) is listed as "not clearly a download" and never requested');
    const form = get(fourth, 'form-080');
    assert.equal(form.final.state, 'done', JSON.stringify(form.final));
    assert.deepEqual(fileNames(form.final), ['Task_D.txt']);
    assert.deepEqual(form.final.skipped.map((x) => [x.label, x.reason]).sort(), [['Task_A.txt', 'would submit a form'], ['Task_B.txt', 'would submit a form'], ['Task_C.txt', 'would submit a form']]);
    assert.deepEqual(['form-Task_A.txt', 'form-Task_B.txt', 'form-sub'].map((n) => platform.count(`/hit/${n}`)), [0, 0, 0], 'no control inside the form was pressed');
    ok('nothing inside a form is pressed, not even a type=button (a button can submit through script, a type attribute is not a promise): the three rows are listed as "would submit a form", and the table outside the form is downloaded');
    const signed = get(fourth, 'signed-081');
    clean(signed, ['Signed_A.txt', 'Signed_B.txt', 'Signed_C.txt', 'Signed_D.txt'], 'signed');
    for (const n of ['Signed_A.txt', 'Signed_B.txt', 'Signed_C.txt', 'Signed_D.txt']) assert.equal(platform.requests.filter((r) => r.origin === 'main' && r.path === `/data/${n}`).length, 1, `${n} was fetched once`);
    ok('addresses signed anew on every render (every 700 ms): 4 files, each fetched once, not one copy per signature');
    for (const r of fourth) assert.deepEqual(leftovers(profileOf(r.dir)), [], r.spec.slug);

    const fifth = await batch([
      { slug: 'opaque-082' }, { slug: 'frame2-083' }, { slug: 'shadow-084' },
      { slug: 'slowapi-085', query: '?delay=6000', loader: { timeouts: { settle: 15000, grow: 5000 } } },
      { slug: 'more60-086', loader: { timeouts: { expand: 60000 } } }, { slug: 'vlist60-087', loader: { timeouts: { expand: 90000 } } },
    ]);
    clean(get(fifth, 'opaque-082'), ['Variance_Bridge.xlsx', 'Sales_Ledger.csv', 'Board_Memo.pdf', 'Grader_Guideline.pdf'], 'opaque');
    ok('links that end in /download and send no Content-Disposition keep the name and the extension of their link text (Variance_Bridge.xlsx, not "download")');
    clean(get(fifth, 'frame2-083'), ['Top.txt', 'Frame_Open.txt', 'Frame_Closed.txt', 'Frame_More.txt'], 'frame');
    clean(get(fifth, 'shadow-084'), ['Shadow_Open.txt', 'Shadow_Closed.txt', 'Shadow_Button.txt'], 'shadow');
    ok('inside a same-origin iframe and an open shadow root: a closed <details> is opened, "Load more" is pressed, and a Download button is pressed through the path to its frame or host');
    const slowApi = get(fifth, 'slowapi-085');
    clean(slowApi, ['Task_A.txt', 'World_A.txt', 'World_B.txt'], 'slow api');
    assert.ok(!slowApi.seen.includes('needs-person'));
    ok('the switch is already on and the world files come from an API that takes 6 s: the loader waits for them (a request of the page counts as busy for up to 20 s)');
    clean(get(fifth, 'more60-086'), range('M_', 60, 3), 'more60');
    ok('60 files behind 12 presses of "Load more" (more than the old limit of ten): all saved');
    clean(get(fifth, 'vlist60-087'), range('V_', 60, 3), 'vlist60');
    ok('a virtualised list of 60 links in a box that needs about 26 scroll steps (the old limit was 20): all saved');
    for (const r of fifth) assert.deepEqual(leftovers(profileOf(r.dir)), [], r.spec.slug);

    const sixth = await batch([
      { slug: 'more60-086', name: 'more60-capped', loader: { timeouts: { expand: 1500 } } },
      { slug: 'tree-075', name: 'tree-learned', learn: 'Show all files' },
      { slug: 'lategrow-089' },
    ]);
    const capped60 = sixth[0];
    assert.equal(capped60.final.state, 'done', JSON.stringify(capped60.final));
    assert.ok(capped60.final.files.length > 0 && capped60.final.files.length < 60, `${capped60.final.files.length} files`);
    assert.match(capped60.final.message, /"Load more" in the tab[^;]*stopped at the time limit and may have more files|"Load more" stopped at the time limit and may have more files/);
    assert.ok(JSON.parse(fs.readFileSync(path.join(capped60.final.folder, 'page.json'), 'utf8')).notes.length >= 1, 'page.json has the note too');
    ok('when "Load more" is cut off by the time limit while it still adds files, the done message says so (and page.json keeps the note): the list is not silently short');
    const learnedTree = sixth[1];
    clean(learnedTree, ['Task_A.txt', 'Tree_Top.txt', 'Tree_Deep.txt', 'World_A.txt', 'World_B.txt'], 'learned tree');
    assert.deepEqual(learnedTree.final.toggle, toggle(true, 'Show all files', true, 3, 5, true));
    assert.ok(!learnedTree.seen.includes('needs-person'), 'a learned switch asks nobody, and what it revealed is still opened');
    ok('a switch learned on an earlier load (no question asked) is followed by the same expansion: the closed <details> group it adds and the nested folders are opened');
    const lateGrow = sixth[2];
    clean(lateGrow, ['Task_A.txt', 'Late_Grow.txt'], 'late grow');
    assert.deepEqual(lateGrow.final.toggle, toggle(true, 'Show all files', true, 1, 2, false));
    ok('a switch that is already on gets the same wait as one the loader clicked: a file the page adds 3 s after load, with no request, is found');
    for (const r of sixth) assert.deepEqual(leftovers(profileOf(r.dir)), [], r.spec.slug);
    const burst = (await batch([{ slug: 'burst-090' }]))[0];
    clean(burst, range('Burst_', 14), 'burst');
    ok('14 buttons pressed one after the other (Chrome silently drops the 11th download of a quick burst): all 14 are saved, because downloads are paced and a click that began nothing is tried once more');

    /* 11c. Round 3: the general case of row identity, a plain button that must not be pressed twice, names Chrome makes up, settling. */
    const seventh = await batch([
      { slug: 'divrows-091' }, { slug: 'twotabs-092' }, { slug: 'tabnames-093' }, { slug: 'entity-094' }, { slug: 'button-095' }, { slug: 'flip-096' },
    ]);
    clean(get(seventh, 'divrows-091'), range('Div_', 24), 'div rows');
    ok('rows made of divs (no table row, list item or row role) with the name in a span and a bare Download button, virtualised: the nearest ancestor with more text is the row, all 24 are saved with their own content');
    const twoTabs = get(seventh, 'twotabs-092');
    assert.equal(twoTabs.final.state, 'done', JSON.stringify(twoTabs.final));
    assert.deepEqual(twoTabs.final.skipped, []);
    assert.deepEqual(twoTabs.final.files.map((f) => fs.readFileSync(path.join(twoTabs.final.folder, 'files', f.name), 'utf8')).sort(),
      ['t1 content of Data.csv', 't1 content of Notes.txt', 't2 content of Data.csv', 't2 content of Extra.txt', 't2 content of Notes.txt'], 'each tab\'s Data.csv and Notes.txt is its own file, with its own bytes');
    ok('the same file name in two tabs (Data.csv and Notes.txt in both, with different content) is two files: the tab is part of the identity and the page is put on the right tab before each press');
    clean(get(seventh, 'tabnames-093'), ['Task Budget.xlsx', 'Task Notes.txt', 'Reference Budget.xlsx', 'Reference Notes.txt'], 'tab names');
    clean(get(seventh, 'entity-094'), Array.from({ length: 24 }, (_, i) => `Entity ${String(i + 1).padStart(2, '0')} Budget.txt`), 'entities');
    assert.ok(get(seventh, 'entity-094').final.message.indexOf('taken for another') < 0, 'and the check for merged rows stays quiet');
    ok('names with spaces that end in the same words ("Entity 01 Budget.txt" ... "Entity 24 Budget.txt", "Task Budget.xlsx" / "Reference Budget.xlsx"): the whole name phrase is the identity, not its last word, so none of the 24 and none of the 4 is lost');
    const idem = get(seventh, 'button-095');
    clean(idem, ['Button_Task.txt', 'Button_A.txt', 'Button_B.txt', 'Button_C.txt', 'Button_D.txt', 'Button_E.txt'], 'button idem');
    assert.equal(platform.count('/hit/idem'), 1, 'the plain "Show all files" button was pressed once');
    const flip = get(seventh, 'flip-096');
    clean(flip, ['Flip_Task.txt', 'Flip_A.txt', 'Flip_B.txt', 'Flip_C.txt', 'Flip_D.txt', 'Flip_E.txt'], 'button flip');
    assert.equal(platform.count('/hit/flip'), 1, 'a button that flips the view was pressed once, not before every file');
    ok('a plain "Show all files" button (it never says whether it is on) is pressed once per load, not again before each of the 6 files: an idempotent one and one that flips the view each press both give all 6 files and exactly one request');
    for (const r of seventh) assert.deepEqual(leftovers(profileOf(r.dir)), [], r.spec.slug);
    const dups = (await batch([{ slug: 'dups-100' }]))[0];
    assert.equal(dups.final.state, 'done', JSON.stringify(dups.final));
    assert.deepEqual(fileNames(dups.final), ['OnlyAll.txt', 'Same.csv'], 'the file both tabs list is kept once');
    assert.deepEqual(dups.final.skipped, []);
    assert.match(dups.final.message, /1 file that was listed more than once \(same name, same content\) kept once/);
    ok('a file that two tabs both list (same name, same bytes) is kept once and the done message says so; nothing is lost and nothing is silent');
    const mimes = (await batch([{ slug: 'mime-097' }]))[0];
    clean(mimes, ['Variance_Bridge.xlsx', 'Board_Memo.docx', 'Archive_Pack.zip', 'Old_Budget.xls', 'Deck.pptx', 'Photo.png', 'Notes.json'], 'mime');
    ok('files with no Content-Disposition whose content type Chrome turns into "download.zip" or "download.xlsx" are saved under the name on the page (Archive_Pack.zip), for 7 content types');
    for (const [slug, label, files, loaderTimeouts] of [['beacon-098', 'a beacon (a keepalive fetch whose answer nobody reads)', ['Beacon_A.txt'], { settle: 15000 }], ['hang-099', 'a long poll that never answers', ['Hang_A.txt'], { settle: 4000 }]]) {
      const t0 = Date.now();
      const quietRun = (await batch([{ slug, loader: { timeouts: loaderTimeouts } }]))[0];
      clean(quietRun, files, slug);
      assert.doesNotMatch(quietRun.final.message, /settled:false/, `${label} does not make the page unsettled: ${quietRun.final.message}`);
      if (slug === 'beacon-098') { assert.ok(Date.now() - t0 < 14000, `a beacon is not waited for until the 15 s deadline (${Date.now() - t0} ms)`); assert.deepEqual(notesOf(quietRun), [], 'an answered request is nothing to tell'); }
      if (slug === 'hang-099') assert.match(notesOf(quietRun).join(' | '), /a request of the page was still waiting for its answer when the files were listed, so some files may be missing/, 'a request that never answers is told, not forgotten');
    }
    ok('a beacon that nobody reads, and a long poll that never answers, are idle requests: the load is not held to the 15 s deadline for the beacon, and neither makes the done message say "settled:false"');

    /* 11d. Round 4: addresses that are actions, tokens, volatile rows, slow tabs and pages, the person's flip, frames, names. */
    const eighth = await batch([
      { slug: 'safety-101' }, { slug: 'tokens-102' }, { slug: 'volatile-103' }, { slug: 'pendingtab-104' },
      { slug: 'flipmain-106', handlers: (l) => ({ 'needs-person': async (state) => { platform.flip('flipmain-106'); await delay(1500); l.continue(state.id); } }) }, { slug: 'framebtn-107' },
    ]);
    const safe = get(eighth, 'safety-101');
    assert.equal(safe.final.state, 'done', JSON.stringify(safe.final));
    assert.deepEqual(fileNames(safe.final), ['ok.txt']);
    assert.deepEqual(safe.final.skipped.map((x) => [x.label, x.reason]).sort(), [['Delete Budget.xlsx', 'looks like an action'], ['Delete log.txt', 'looks like an action'], ['Remove Q4.pdf', 'looks like an action'], ['Revoke access to notes.txt', 'looks like an action']]);
    assert.equal(platform.stats.apiActions, 0, 'no address under /api/ was requested');
    assert.deepEqual(platform.requests.filter((r) => /^\/api\/(files|revoke|items)/.test(r.path)), [], 'not by a link, not by a click');
    ok('links whose words say "file" ("Remove Q4.pdf", "Revoke access to notes.txt", an icon link called "Delete Budget.xlsx") but whose addresses are actions (/api/files/13/remove, /api/revoke/99, ?action=delete) are never requested; words alone never waive the address rules, and each is listed in skipped as "looks like an action"');
    const tok = get(eighth, 'tokens-102');
    assert.equal(tok.final.state, 'done', JSON.stringify(tok.final));
    assert.deepEqual(fileNames(tok.final), ['file_aaa111.txt', 'file_bbb222.txt', 'file_ccc333.txt']);
    assert.deepEqual(tok.final.skipped, []);
    assert.equal(platform.count('/dl'), 3, 'three requests, one per token');
    ok('three rows of bare "Download" links that differ only in a token (the token is the file id) are three files: a token is stripped only to pair a re-signed address with its earlier look, never to merge two addresses seen together');
    clean(get(eighth, 'volatile-103'), ['Variance_Bridge.txt', 'Board_Memo.txt', 'Sales_Ledger.txt'], 'volatile rows');
    assert.ok(get(eighth, 'volatile-103').final.message.indexOf('taken for another') < 0);
    ok('extension-less names whose rows carry "updated N min ago", rewritten every 700 ms: the stable part of the row is the identity, so the 3 rows stay 3 candidates and all 3 files are saved');
    const slowTab = get(eighth, 'pendingtab-104');
    clean(slowTab, ['Task_A.txt', 'Ref_1.txt', 'Ref_2.txt'], 'slow tab');
    assert.doesNotMatch(slowTab.final.message, /settled:false|still waiting/);
    ok('a tab whose list comes from an API that answers after 4 s: the step waits for the answer (a short settle used to forget the pending request), and the Reference files are saved');
    const flipped = get(eighth, 'flipmain-106');
    assert.equal(flipped.final.state, 'done', JSON.stringify(flipped.final));
    assert.deepEqual(fileNames(flipped.final), ['Person_A.txt', 'Person_B.txt', 'Person_Task.txt']);
    assert.deepEqual(flipped.final.toggle, toggle(true, 'Everything', true, 1, 3, true));
    assert.equal(platform.count('/tasks/flipmain-106'), 1, 'the task link was loaded once: the page the person left was not reloaded');
    ok('the person turns on a switch whose router moves to a SIBLING path: the page they left is the task page, it is not reloaded (the flip would be lost), all 3 files are saved and the switch is learned');
    clean(get(eighth, 'framebtn-107'), ['Frame_Btn_A.txt', 'Frame_Btn_B.txt'], 'frame buttons');
    ok('blob Download buttons inside an iframe: a download that starts in a subframe is tracked like the tab\'s own, both files are saved');
    for (const r of eighth) assert.deepEqual(leftovers(profileOf(r.dir)), [], r.spec.slug);
    const ninth = await batch([
      { slug: 'pendingmore-105', loader: { timeouts: { expand: 60000, settle: 15000 } } }, { slug: 'twomore-108' }, { slug: 'names-109' },
    ]);
    clean(get(ninth, 'pendingmore-105'), range('Slow_', 30, 3), 'slow more');
    assert.doesNotMatch(get(ninth, 'pendingmore-105').final.message, /still waiting/);
    ok('"Load more" served by an API that takes 3.5 s a press: each press waits for its answer, all 30 files are found');
    clean(get(ninth, 'twomore-108'), ['Sec_A_01.txt', ...range('Sec_B_', 15)], 'two load more');
    ok('two "Load more" buttons on one page, the first never goes away: every visible one is pressed each round, so the second list is not starved (16 files)');
    const named = get(ninth, 'names-109');
    assert.equal(named.final.state, 'done', JSON.stringify(named.final));
    assert.deepEqual(fileNames(named.final), ['Budget v2.1.pdf', 'Policy 3.2.pdf', 'Variance Bridge.pdf']);
    ok('link texts that end in "3.2" or "v2.1" are not extensions: the files keep the words and get the extension of their content type (Policy 3.2.pdf), and a name with no extension gets .pdf too');
    for (const r of ninth) assert.deepEqual(leftovers(profileOf(r.dir)), [], r.spec.slug);
    /* 11e. Round 5: the allowlist (only a download is requested or pressed) and nothing left out without a word (every place that could not
       be covered is a note, every file-like thing that was not downloaded is in skipped). */
    const eleventh = await batch([
      { slug: 'pagenum-110' }, { slug: 'pagelinks-111' }, { slug: 'pageother-112' }, { slug: 'archive-130' }, { slug: 'treeitem-131' }, { slug: 'treeitem-132' }, { slug: 'rerender-133' }, { slug: 'rerender-134' },
    ]);
    const pg = get(eleventh, 'pagenum-110');
    clean(pg, [...[1, 2, 3, 4].flatMap((p) => [1, 2, 3].map((i) => `P${p}_File_0${i}.txt`)), ...[1, 2, 3, 4].map((p) => `Page_${p}_Memo.txt`)], 'pager buttons');
    assert.deepEqual(notesOf(pg), [], 'every page was read: nothing to say');
    ok('a pager of numbered buttons and Next (4 pages): every page is read, Next is pressed page after page, and the "Download" button of page 3 is found again on page 3 (the pager is put back to that page before the press): 16 files, no note');
    const pl = get(eleventh, 'pagelinks-111');
    clean(pl, [1, 2, 3, 4].flatMap((p) => [1, 2, 3].map((i) => `S${p}_File_0${i}.txt`)), 'pager links');
    assert.ok(platform.count('/tasks/pagelinks-111') >= 4, 'each page was loaded');
    assert.deepEqual(notesOf(pl), []);
    ok('server-rendered pages (?page=N links and rel=next) that change only the page parameter are followed: 12 files from 4 pages');
    const po = get(eleventh, 'pageother-112');
    clean(po, ['O1_File_01.txt', 'O1_File_02.txt', 'O1_File_03.txt'], 'other pager');
    assert.match(notesOf(po).join(' | '), /pagination link "Next" goes to another address than the page, so its other pages were not read/);
    ok('pager links that also change another parameter (sort=name) are not followed, and the note says so');
    clean(get(eleventh, 'archive-130'), ['Docs_A.txt', 'Docs_B.txt', 'Arch_A.txt', 'Arch_B.txt', 'Arch_C.txt', 'Misc_A.txt'], 'archive folder');
    assert.deepEqual(notesOf(get(eleventh, 'archive-130')), []);
    ok('a folder called "Archive (3)" is navigation: it is opened like the others and its 3 files are saved (6 of 6)');
    for (const slug of ['treeitem-131', 'treeitem-132']) { clean(get(eleventh, slug), ['Tree_One_A.txt', 'Tree_One_B.txt', 'Tree_Two_A.txt', 'Tree_Three_A.txt'], slug); assert.deepEqual(notesOf(get(eleventh, slug)), [], slug); }
    ok('ARIA tree items whose handler sits on the row inside the item (children hidden, or made on the first open) are opened by pressing the row: 4 of 4');
    clean(get(eleventh, 'rerender-133'), Array.from({ length: 20 }, (_, i) => `Wide_${String(i).padStart(2, '0')}.txt`), 'wide tree');
    clean(get(eleventh, 'rerender-134'), Array.from({ length: 8 }, (_, i) => `Deep_${i}.txt`), 'deep tree');
    ok('a tree that draws itself anew on every click (20 folders side by side, 8 levels deep) is opened one element at a time with a fresh look after each press: 20 of 20 and 8 of 8, not one folder per pass');
    for (const r of eleventh) assert.deepEqual(leftovers(profileOf(r.dir)), [], r.spec.slug);

    const twelfth = await batch([
      { slug: 'tabs16-135' }, { slug: 'sametoken-139' }, { slug: 'verbnames-140' }, { slug: 'dialog-141' }, { slug: 'drawer-142' }, { slug: 'xframe-143' },
    ]);
    const t16 = get(twelfth, 'tabs16-135');
    clean(t16, Array.from({ length: 16 }, (_, i) => ['A', 'B'].map((x) => `Tab_${String(i + 1).padStart(2, '0')}_${x}.txt`)).flat(), 'sixteen tabs');
    assert.deepEqual(notesOf(t16), []);
    ok('16 tabs (more than the old limit of 12): every tab is opened, 32 of 32 files');
    const st = get(twelfth, 'sametoken-139');
    assert.equal(st.final.state, 'done', JSON.stringify(st.final));
    assert.deepEqual(st.final.files.map((f) => fs.readFileSync(path.join(st.final.folder, 'files', f.name), 'utf8')).sort(), ['INPUT notes.txt', 'INPUT report.txt', 'OUTPUT notes.txt', 'OUTPUT report.txt']);
    assert.deepEqual(st.final.skipped, [{ label: 'opaque.txt', group: 'Files', reason: NOT_CLEAR }]);
    assert.equal(requestsTo(/^\/dlq$/).length, 0, 'an address that says nothing was not requested');
    ok('the same names with the same token-less address in two tabs (Inputs and Outputs) are four files, not two; a link whose text is a file name and whose address says nothing (/dlq?token=) is listed as "not clearly a download" and never requested');
    const vn = get(twelfth, 'verbnames-140');
    assert.equal(vn.final.state, 'done', JSON.stringify(vn.final));
    assert.deepEqual(fileNames(vn.final), ['Approved vendor list.pdf', 'Archive of 2023 correspondence.pdf', 'Plain document.pdf', 'Reset procedure.pdf', 'Revoke and reissue policy.pdf', 'Submit guidelines.pdf']);
    assert.deepEqual(vn.final.skipped.map((x) => [x.label, x.reason]).sort(), [['Approval memo', 'looks like an action'], ['Cancel policy', NOT_CLEAR], ['Q4 numbers', 'looks like an action'], ['Reset instructions', NOT_CLEAR]]);
    assert.deepEqual(requestsTo(/^\/files\/(42|43|publish|45)/), [], 'none of the four was requested');
    ok('documents whose titles start with a verb ("Archive of 2023 correspondence", "Reset procedure", "Submit guidelines", "Revoke and reissue policy") are saved when their address says download; links with no clear address or an action in it are listed in skipped and never requested');
    const dg = get(twelfth, 'dialog-141');
    clean(dg, ['Dlg_Main_A.txt', 'Dlg_Main_B.txt'], 'dialog');
    assert.match(notesOf(dg).join(' | '), /4 file links on the page are hidden \(a closed dialog, drawer or panel\) and were not downloaded/);
    ok('4 file links in a closed <dialog> are counted and told ("hidden ... were not downloaded"), not forgotten');
    const dr = get(twelfth, 'drawer-142');
    clean(dr, ['Drw_Main_A.txt', 'Drw_Main_B.txt'], 'drawer');
    assert.match(notesOf(dr).join(' | '), /"Attachments \(4\)" opens a menu or dialog that may hold files; it was not opened/);
    ok('a button that opens a dialog or drawer ("Attachments (4)", aria-haspopup) is not pressed, and the note names it');
    const xf = get(twelfth, 'xframe-143');
    clean(xf, ['Xf_Main_A.txt', 'Xf_Main_B.txt'], 'cross frame');
    assert.match(notesOf(xf).join(' | '), /1 embedded frame from another site \(or sandboxed\) could not be read, so any files in it were not seen/);
    ok('a frame of another site cannot be read: the note says so (and the page\'s own 2 files are saved)');
    for (const r of twelfth) assert.deepEqual(leftovers(profileOf(r.dir)), [], r.spec.slug);

    const thirteenth = await batch(['viewall-120', 'viewall-121', 'viewall-122', 'viewall-123', 'viewall-124', 'viewall-125', 'viewall-126'].map((slug) => ({ slug })));
    for (const [slug, label] of [['viewall-120', 'View all (12)'], ['viewall-121', 'Show all'], ['viewall-122', 'See all'], ['viewall-123', 'Next'], ['viewall-124', 'More'], ['viewall-125', 'Load all'], ['viewall-126', 'Show remaining 8']]) clean(get(thirteenth, slug), range('All_', 12), label);
    ok('buttons that show the rest of a list under other names - "View all (12)", "Show all", "See all", "Next", "More", "Load all", "Show remaining 8" - are pressed: 12 of 12 each');
    for (const r of thirteenth) assert.deepEqual(leftovers(profileOf(r.dir)), [], r.spec.slug);

    const fourteenth = await batch([
      { slug: 'infscroll-144', loader: { timeouts: { expand: 120000 } } }, { slug: 'persistent-145' }, { slug: 'volatile-146' }, { slug: 'nonline-147' },
      { slug: 'wander-148', handlers: (l) => ({ 'needs-person': async (state) => { platform.flip('wander-148'); await delay(1500); l.continue(state.id); } }) }, { slug: 'slowtab-150' },
    ]);
    const inf = get(fourteenth, 'infscroll-144');
    clean(inf, range('Inf_', 110, 3), 'infinite scroll');
    assert.deepEqual(notesOf(inf), []);
    ok('an infinite scroller whose chunk is taller than two scroll steps (110 files, 25 per chunk, loaded when the end is seen): the loader scrolls until the scroller is at its bottom and the page stopped growing, 110 of 110');
    const pers = get(fourteenth, 'persistent-145');
    clean(pers, [0, 1, 2, 3, 4].flatMap((k) => [1, 2, 3, 4].map((i) => `Sec${k}_${i}.txt`)), 'persistent more');
    assert.match(notesOf(pers).join(' | '), /"Show more" was still on the page after \d+ presses; the last 2 added no files/);
    ok('five sections whose "Show more" never goes away: all five are pressed every round (not the first three), 20 of 20, and the button that stayed is told');
    const vol = get(fourteenth, 'volatile-146');
    clean(vol, ['Variance_Bridge.txt', 'Board_Memo.txt', 'Sales_Ledger.txt'], 'volatile cells');
    assert.ok(vol.final.message.indexOf('taken for another') < 0);
    ok('extension-less rows with five cells that change while the page is open (a percentage, a count of downloads, of views, of comments, a status): the name cell is the identity, all 3 files are saved');
    const nl = get(fourteenth, 'nonline-147');
    assert.equal(nl.final.state, 'done', JSON.stringify(nl.final));
    assert.deepEqual(fileNames(nl.final), ['Board Memo Final.xlsx', 'Q3 Variance Bridge.xlsx', 'Sales Ledger.csv']);
    assert.deepEqual(nl.final.skipped, []);
    ok('link texts without an extension on a type the browser does not show (xlsx) or does (csv): the files keep the words on the page plus the extension of their type (Q3 Variance Bridge.xlsx, not download.xlsx)');
    const wd = get(fourteenth, 'wander-148');
    assert.equal(wd.final.state, 'done', JSON.stringify(wd.final));
    assert.deepEqual(fileNames(wd.final), ['Wander_A.txt', 'Wander_B.txt']);
    assert.equal(platform.count('/data/Home_Doc.txt'), 0, 'a file of the page the person wandered to is not a task file');
    assert.ok(!JSON.parse(fs.readFileSync(path.join(wd.final.folder, 'page.json'), 'utf8')).sections.some((s) => s.heading === 'News'), 'and its text is not the task\'s text');
    assert.deepEqual(wd.final.skipped, []);
    ok('the person is asked for a switch, goes to ANOTHER page of the site and presses Continue: that page (another document) is not taken for the task; the task link is loaded again, 2 task files are saved and none of the home page\'s');
    const verySlow = get(fourteenth, 'slowtab-150');
    clean(verySlow, ['Task_A.txt'], 'very slow tab');
    assert.match(notesOf(verySlow).join(' | '), /a request of the page was still waiting for its answer after the tab "Reference" was opened, so some files may be missing/);
    ok('a tab whose API answers after 30 s (longer than the 20 s the loader waits for a request): the files of that tab are missing, and the note says that a request was still waiting');
    for (const r of fourteenth) assert.deepEqual(leftovers(profileOf(r.dir)), [], r.spec.slug);

    /* UNSAFE controls: for each, the server saw nothing and the control was not pressed */
    const fifteenth = await batch([
      { slug: 'clear-160' }, { slug: 'settings-161' }, { slug: 'bulk-162' }, { slug: 'scriptform-163' }, { slug: 'export-165' }, { slug: 'trash-166' }, { slug: 'actions-167' }, { slug: 'togglemix-168' },
    ]);
    const clear = get(fifteenth, 'clear-160');
    clean(clear, ['Main_A.txt'], 'clear all files');
    assert.equal(clear.asked[0].message, PERSON_MESSAGE, 'no switch was found: the person is asked');
    assert.deepEqual(requestsTo(/^\/api\/unsafe\/clear-160/), [], 'the server saw no DELETE');
    assert.equal(pressed('pressed-clear'), 0, 'and the button was not pressed');
    ok('a danger button called "Clear all files" is not the switch: it is not pressed (the server saw no DELETE), the person is asked');
    const sett = get(fifteenth, 'settings-161');
    clean(sett, ['Set_Main_A.txt', 'Set_World_A.txt'], 'settings');
    assert.equal(sett.final.toggle.label, 'Show all files');
    assert.deepEqual(requestsTo(/^\/api\/unsafe\/settings-161/), []);
    assert.equal(pressed('pressed-digest'), 0);
    ok('a settings switch "Include all attachments in my daily digest email" that comes before the real "Show all files" switch is left alone (no preference was saved); the real switch is flipped and the world file saved');
    const bulk = get(fifteenth, 'bulk-162');
    clean(bulk, ['Bulk_A.txt'], 'bulk');
    assert.deepEqual(requestsTo(/^\/api\/unsafe\/bulk-162/), []);
    assert.equal(pressed('pressed-bulk'), 0);
    ok('a bulk-actions list whose option says "Mark all files as reviewed" is not chosen (the server saw no POST)');
    const mix = get(fifteenth, 'togglemix-168');
    clean(mix, ['Mix_A.txt'], 'toggle mix');
    assert.equal(mix.asked[0].message, PERSON_MESSAGE, 'no switch was found: the person is asked');
    assert.deepEqual(requestsTo(/^\/api\/unsafe\/togglemix-168/), []);
    assert.equal(pressed('pressed-mix'), 0);
    ok('a switch labelled "Show all attachments and mark them reviewed" has the words of the real switch and also an action word: it is not flipped (the server saw no POST), the person is asked');
    const sf = get(fifteenth, 'scriptform-163');
    assert.equal(sf.final.state, 'done', JSON.stringify(sf.final));
    assert.deepEqual(fileNames(sf.final), ['Script_Ok.txt']);
    const sfReasons = Object.fromEntries(sf.final.skipped.map((x) => [x.label, x.reason]));
    assert.equal(sfReasons['Download Q3_Report.txt'], 'looks like an action');
    assert.equal(sfReasons['Download Q4_Report.txt'], 'looks like an action');
    assert.match(sfReasons['Download Q5_Report.txt'], /^blocked-write: the control sent a POST request instead of downloading; it was blocked and not pressed again$/);
    assert.deepEqual(requestsTo(/^\/api\/unsafe\/scriptform-163/), [], 'no POST reached the server');
    assert.deepEqual([pressed('pressed-f1'), pressed('pressed-f2'), pressed('pressed-f3')], [0, 0, 1], 'the two controls with a script in their attributes were not pressed; the third (a listener nobody can see) was pressed once and its POST was failed in the browser');
    ok('"Download X" controls that submit a POST form through script: two with the script in an attribute are never pressed ("looks like an action"); one with a listener is pressed once and its POST is failed before it leaves the browser ("blocked-write"); the server saw no request');
    const ex = get(fifteenth, 'export-165');
    assert.equal(ex.final.state, 'done', JSON.stringify(ex.final));
    assert.deepEqual(fileNames(ex.final), ['Main_A.txt']);
    assert.deepEqual(ex.final.skipped, [{ label: 'Download app', group: 'Files', reason: NOT_CLEAR }]);
    assert.deepEqual(requestsTo(/^\/api\/unsafe\/export-165/), []);
    assert.deepEqual(['pressed-b1', 'pressed-b2', 'pressed-b3'].map(pressed), [0, 0, 0]);
    ok('"Export to Google Sheets", "Export to Slack" and "Download app" are never pressed (no POST, nothing sent to a service); "Download app" is listed as not clearly a download');
    const tr = get(fifteenth, 'trash-166');
    clean(tr, ['Q1_Budget.txt', 'Q2_Budget.txt'], 'trash links');
    assert.deepEqual(requestsTo(/^\/docs\/\d+\/(trash|detach|share-publicly)$/), [], 'no row action was requested');
    ok('icon links /trash, /detach and /share-publicly next to each file ("Move to trash", "Detach from task", "Share link") are never requested; the two files are saved and the icons are not reported as files');
    const ac = get(fifteenth, 'actions-167');
    assert.equal(ac.final.state, 'done', JSON.stringify(ac.final));
    assert.deepEqual(fileNames(ac.final), ['Act_Ok.txt']);
    assert.equal(ac.final.skipped.length, 16);
    assert.ok(ac.final.skipped.every((x) => x.reason === 'looks like an action'), JSON.stringify(ac.final.skipped));
    assert.deepEqual(requestsTo(/^\/(docs\/(1[5-9]|2[0-9])(\/|$)|api\/unsafe\/actions-167)/), [], 'not one of the 16 addresses was requested');
    ok('16 links with an action in the address (/remove with a download attribute, /delete?filename=, /submit, /actions/run, /cancel, /archive, ?action=submit, ?method=delete, ?_method=DELETE, /delete/now, /destroy, /trash, /actions, /revoke, /publish, /unsubscribe) are never requested and each is listed as "looks like an action"');
    for (const r of fifteenth) assert.deepEqual(leftovers(profileOf(r.dir)), [], r.spec.slug);

    /* 11f. Round 6: controls that look like navigation and save something. Every press runs with the write guard on; what is not a view is not
       pressed at all; a tab served by a GraphQL query still works. For each: the server saw no write. */
    const sixteenth = await batch([
      { slug: 'points-170' }, { slug: 'kanban-171' }, { slug: 'wizard-172' }, { slug: 'plusone-173' }, { slug: 'tabstatus-174' }, { slug: 'tablink-175' }, { slug: 'tablink-176' }, { slug: 'perm-177' }, { slug: 'autosubmit-178' }, { slug: 'graphql-179' },
    ]);
    const noWrite = (slug) => assert.deepEqual(requestsTo(new RegExp(`^/api/unsafe/${slug}`)), [], `${slug}: the server saw no write`);
    const pts = get(sixteenth, 'points-170');
    clean(pts, ['Pts_A.txt'], 'points');
    noWrite('points-170'); assert.equal(pressed('pressed-points-170'), 0); assert.deepEqual(notesOf(pts), []);
    ok('an estimate picker (numbered buttons 1 2 3 5 8, one marked) is not a pager: nothing was pressed, the server saw no PUT');
    const kan = get(sixteenth, 'kanban-171');
    clean(kan, ['Kan_A.txt'], 'kanban');
    noWrite('kanban-171'); assert.equal(pressed('pressed-kanban-171'), 0); assert.deepEqual(notesOf(kan), []);
    ok('"Move to previous/next stage" arrows are not a pager and not "Load more": nothing was pressed, the server saw no PATCH');
    const wiz = get(sixteenth, 'wizard-172');
    clean(wiz, ['Wiz_A.txt'], 'wizard');
    noWrite('wizard-172'); assert.equal(pressed('pressed-wizard-172'), 1, 'pressed once, never again');
    assert.ok(notesOf(wiz).includes("The page tried to save a change when 'Next' was pressed; it was blocked"), notesOf(wiz).join(' | '));
    ok('a lone Next that saves a wizard step is a "more" button, so it is pressed - once, with the write guard on: the PUT is failed in the browser (the server saw none), the control is not pressed again, and the note says what happened');
    const vote = get(sixteenth, 'plusone-173');
    clean(vote, ['Vote_A.txt'], 'plus one');
    noWrite('plusone-173'); assert.equal(pressed('pressed-plusone-173'), 0);
    ok('"+1" is not "Load more": the vote button is never pressed');
    const tst = get(sixteenth, 'tabstatus-174');
    clean(tst, ['Stat_A.txt'], 'status tabs');
    noWrite('tabstatus-174');
    assert.ok(notesOf(tst).some((n) => /^The page tried to save a change when 'In progress' was pressed; it was blocked$/.test(n)), notesOf(tst).join(' | '));
    assert.ok(pressed('pressed-tabstatus-174') >= 2 && pressed('pressed-tabstatus-174') <= 3, `each tab pressed once: ${pressed('pressed-tabstatus-174')}`);
    ok('a status picker made of role=tab buttons: each tab is pressed once under the write guard, every PATCH is failed before it leaves the browser, and each blocked tab is in the notes');
    const tl = get(sixteenth, 'tablink-175');
    clean(tl, ['Tl_A.txt'], 'tab links');
    assert.deepEqual(requestsTo(/^\/projects\//), [], 'the trash and sharing tabs were not navigated');
    assert.match(notesOf(tl).join(' | '), /the tab "Trash" is a link to an address the loader does not open \(the path has the action word "trash"\)/);
    assert.match(notesOf(tl).join(' | '), /the tab "Sharing" is a link to an address the loader does not open \(the path has the action word "share"\)/);
    const tl2 = get(sixteenth, 'tablink-176');
    clean(tl2, ['Tl2_A.txt'], 'archive tab link');
    assert.deepEqual(requestsTo(/^\/tasks\/tablink-176\/archive/), [], 'the archive tab was not navigated');
    assert.match(notesOf(tl2).join(' | '), /the tab "Archive" is a link to an address the loader does not open/);
    ok('tabs that are links to /projects/7/trash, /projects/7/share and /tasks/x/archive are not navigated (an action word in the address), and each is in the notes');
    const perm = get(sixteenth, 'perm-177');
    clean(perm, ['Perm_A.txt'], 'permission');
    assert.equal(perm.asked[0].message, PERSON_MESSAGE, 'no safe switch: the person is asked');
    noWrite('perm-177'); assert.equal(pressed('pressed-perm-177'), 0);
    ok('a sharing list whose option says "Can view all files" is not the switch (the list holds permissions): not chosen, the server saw no PUT, the person is asked');
    const auto = get(sixteenth, 'autosubmit-178');
    clean(auto, ['Auto_A.txt'], 'auto submit');
    assert.equal(auto.asked[0].message, PERSON_MESSAGE);
    noWrite('autosubmit-178'); assert.equal(pressed('pressed-autosubmit-178'), 0);
    ok('a "Show all files" box in a POST preferences form that submits on change is never ticked: the server saw no POST, the person is asked');
    const gq = get(sixteenth, 'graphql-179');
    clean(gq, ['Task_A.txt', 'Ref_A.txt', 'Ref_B.txt'], 'graphql tabs');
    assert.ok(platform.count('/graphql', 'POST') >= 1, 'the query reached the server');
    assert.equal(platform.stats.mutations, 0, 'the mutation never did');
    assert.ok(notesOf(gq).includes("The page tried to save a change when 'Mark seen' was pressed; it was blocked"), notesOf(gq).join(' | '));
    ok('a tab whose list is loaded with a POST GraphQL query still works (its 2 files are saved); the tab that sends a GraphQL mutation is stopped before it leaves the browser and told');
    for (const r of sixteenth) assert.deepEqual(leftovers(profileOf(r.dir)), [], r.spec.slug);
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

    /* 13b. Every way out of the sign-in window forgets the pages it visited (History, caches, sessions), and a profile that another Chrome
       holds is not swept: the other Chrome is left alone and the message says what to do. */
    const canaryIn = (profile) => walk(profile).filter((f) => { try { return fs.readFileSync(f).includes(LOGIN_CANARY); } catch (e) { return false; } }).map((f) => path.relative(profile, f));
    for (const [how, extra] of [['cancel', {}], ['timeout', { clock: undefined, timeouts: { signIn: 3500 } }]]) {
      platform.signOut();
      const rootX = path.join(tmp, `scrub-${how}`);
      fs.mkdirSync(rootX);
      const scrubLoader = makeLoader(rootX, { signIn: 'window', ...extra });
      const hitsBefore = platform.stats.canaryHits;
      const idK = scrubLoader.start(`${platform.origin}/tasks/atlas-001`);
      const runK2 = await drive(scrubLoader, idK, {
        'needs-sign-in': async () => {
          await until(() => platform.stats.canaryHits > hitsBefore, 'the window to open the sign-in page', 20000);
          await delay(700);
          if (how === 'cancel') scrubLoader.cancel(idK);
        },
      });
      assert.equal(runK2.final.state, how === 'cancel' ? 'cancelled' : 'failed', JSON.stringify(runK2.final));
      assert.deepEqual(leftovers(profileOf(rootX)), []);
      assert.deepEqual(canaryIn(profileOf(rootX)), [], `after ${how}: the sign-in page the window visited is not in the profile`);
      ok(`the sign-in window visited a sign-in page with a state parameter in its address; after a ${how} of the load the profile holds no trace of it (History, caches and sessions are scrubbed on this way out too)`);
    }
    {
      const rootH = path.join(tmp, 'inuse-project');
      fs.mkdirSync(rootH);
      const profileH = profileOf(rootH);
      prepareProfile(profileH);
      const homeDir = path.join(profileH, 'home');
      fs.mkdirSync(homeDir, { recursive: true });
      const args = chromeArgs({ profileDir: profileH, headless: true, url: 'about:blank', pipe: false });
      spawnSync('sh', ['-c', `setsid "${chromePath}" ${args.slice(0, -1).map((a) => `'${a}'`).join(' ')} ${isRoot ? '--no-sandbox ' : ''}about:blank >/dev/null 2>&1 &`], { env: browserEnv(process.env, homeDir) });   /* an orphan: its parent is gone */
      await until(() => mainProcess(profileH, false), 'the Chrome that holds the profile', 20000);
      await delay(1500);
      const holder = mainProcess(profileH, false);
      const inUse = makeLoader(rootH);
      const runH2 = await drive(inUse, inUse.start(`${platform.origin}/tasks/atlas-001`));
      try {
        assert.equal(runH2.final.state, 'failed', JSON.stringify(runH2.final));
        assert.equal(runH2.final.message, 'Quit the loader\'s Chrome (Cmd+Q) and try again.');
        assert.ok(mainProcess(profileH, false) && mainProcess(profileH, false).pid === holder.pid, 'the Chrome that held the profile is still there: the loader did not kill it before telling the owner to quit it');
        ok('a profile held by another Chrome (an orphaned sign-in window): the load fails with "Quit the loader\'s Chrome (Cmd+Q) and try again." and that Chrome is NOT killed');
      } finally {
        let socketDir = null;
        try { socketDir = path.dirname(fs.readlinkSync(path.join(profileH, 'SingletonSocket'))); } catch (e) { /* none */ }
        for (const p of listProcesses().filter((x) => x.cmd.includes(`--user-data-dir=${profileH}`))) { try { process.kill(p.pid, 'SIGKILL'); } catch (e) { /* gone */ } }
        await delay(300);
        if (socketDir && /^\/tmp\/\.org\.chromium\./.test(socketDir)) fs.rmSync(socketDir, { recursive: true, force: true });   /* a killed Chrome leaves its socket folder */
      }
    }
    if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      const rootN = path.join(tmp, 'nodisplay-project');
      fs.mkdirSync(rootN);
      const noDisplay = makeLoader(rootN, { headless: false });
      const runN = await drive(noDisplay, noDisplay.start(`${platform.origin}/tasks/atlas-001`));
      assert.equal(runN.final.state, 'failed', JSON.stringify(runN.final));
      assert.match(runN.final.message, /^Chrome did not start\. /);
      assert.ok(runN.final.message.length > 'Chrome did not start. '.length + 5, 'the output of Chrome is in the message: ' + runN.final.message);
      assert.doesNotMatch(runN.final.message, /closed before the load finished/);
      assert.equal(runN.final.error, runN.final.message);
      assert.deepEqual(leftovers(profileOf(rootN)), []);
      ok('a Chrome that cannot open a window (no display) is reported as "Chrome did not start." with its own output, not as a window the owner closed');
    }

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
