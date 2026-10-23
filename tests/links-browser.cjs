/* Optional developer QA for the link loader (not part of npm test). Starts a synthetic task platform on loopback (invented content only:
   Atlas, Meridian, Borealis) and drives backend/links/index.cjs against it with a real headless Chromium on a temporary project root,
   so the project's own private/ folder is never read or written. No model is involved anywhere. Chrome runs on the loader's pipe; the
   test adds --no-sandbox through spawnFn only when it runs as root (the product never does).

   The platform: a sign-in redirect (a session cookie without an expiry, so the test also proves it survives Chrome's restart), a task
   page whose "Show all files" switch reveals 3 more files after a short delay, a page whose only switch has an unrelated label, a page
   whose switch has no label at all, a page without any switch, a 404, a presigned file on a second origin whose query string carries a
   signature, a hostile file name, two names that differ only in case, an inline PDF, a redirect to an address the loader must not open,
   files over the caps, and links that must never be requested (Delete, Sign out, javascript:, file:, an address written as numbers).
   The "person" is the page itself: it polls a test endpoint and submits the sign-in form or clicks its own switch when told to.

   Covered: needs-sign-in then loading then downloading then done, the page text cut at headings (with a form value and hostile text),
   the switch clicked by its label, the count before and after, needs-person then continue, the label learned for the host and used on
   the next load, an unlabelled switch (nothing learned), cancel while waiting, a second start refused, continue when nothing waits,
   a 404, a sign-in that never comes, Chrome killed under the loader, the caps (files, per file, total), file hops, names and hashes,
   the session surviving a restart, and the privacy rules: no Runtime.enable and no cookie method on the wire, downloads denied before
   the first navigation, the network domain off while the person types a password, the link and its query string nowhere (argv, state,
   page.json, ps, the profile after the scrub), an allow-listed environment, a 0700 profile, files 0600, no Chrome left behind.

   Environment: CHROME_BIN (default /opt/pw-browsers/chromium-1194/chrome-linux/chrome when it exists), KEEP=1 keeps the temporary folder. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
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
const checks = [];
const finals = [];
const ok = (label) => { checks.push(label); };

/* ---------------------------------------------------------------- the synthetic platform */
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FILES = {
  prompt: { name: 'Atlas_Prompt.txt', type: 'text/plain; charset=utf-8', body: Buffer.from('Atlas prompt: build the Q3 variance bridge for Borealis Holdings.\n'), disp: 'attachment; filename="Atlas_Prompt.txt"' },
  brief: { name: 'Atlas_Brief.pdf', type: 'application/pdf', body: Buffer.concat([Buffer.from('%PDF-1.4\n'), det('brief', 3000)]), disp: null },   /* inline: Chrome would show it, the loader forces a download */
  workbook: { name: 'Atlas_Workbook.xlsx', type: XLSX, body: det('workbook', 40000), disp: 'attachment; filename="Atlas_Workbook.xlsx"' },
  report: { name: 'report.csv', type: 'text/csv', body: Buffer.from('party,units\nAtlas,2480\n'), disp: 'attachment; filename="report.csv"' },
  ledger: { name: 'World_Ledger.csv', type: 'text/csv', body: Buffer.from('account,balance\nMeridian,100\n'), disp: 'attachment; filename="World_Ledger.csv"' },
  hostile: { name: 'hostile', type: 'text/plain', body: Buffer.from('a file whose name tries to leave its folder\n'), disp: 'attachment; filename="../../../tmp/pwned.txt"' },
  report2: { name: 'Report.CSV', type: 'text/csv', body: Buffer.from('party,units\nMeridian,0\n'), disp: 'attachment; filename="Report.CSV"' },
  adv1: { name: 'Borealis_Rates.txt', type: 'text/plain', body: Buffer.from('rates v1\n'), disp: 'attachment; filename="Borealis_Rates.txt"' },
  adv2: { name: 'Borealis_Curve.txt', type: 'text/plain', body: Buffer.from('curve v1\n'), disp: 'attachment; filename="Borealis_Curve.txt"' },
  adv3: { name: 'Borealis_Notes.txt', type: 'text/plain', body: Buffer.from('notes v1\n'), disp: 'attachment; filename="Borealis_Notes.txt"' },
  adv4: { name: 'Borealis_Extra.txt', type: 'text/plain', body: Buffer.from('extra v1\n'), disp: 'attachment; filename="Borealis_Extra.txt"' },
  htmlfile: { name: 'Atlas_Page.pdf', type: 'text/html', body: Buffer.from('<html><body>Please sign in</body></html>'), disp: null },
  'cap-a': { name: 'cap_a.bin', type: 'application/octet-stream', body: det('cap-a', 600 * 1024), disp: 'attachment; filename="cap_a.bin"' },
  'cap-b': { name: 'cap_b.bin', type: 'application/octet-stream', body: det('cap-b', 600 * 1024), disp: 'attachment; filename="cap_b.bin"' },
  'cap-c': { name: 'cap_c.bin', type: 'application/octet-stream', body: det('cap-c', 600 * 1024), disp: 'attachment; filename="cap_c.bin"' },
  'cap-d': { name: 'cap_d.bin', type: 'application/octet-stream', body: det('cap-d', 1024), disp: 'attachment; filename="cap_d.bin"' },
  'cap-big': { name: 'cap_big.bin', type: 'application/octet-stream', body: det('cap-big', 3 * 1024 * 1024), disp: 'attachment; filename="cap_big.bin"', length: true },   /* announced with Content-Length */
  'cap-fast': { name: 'cap_fast.bin', type: 'application/octet-stream', body: det('cap-fast', 2 * 1024 * 1024), disp: 'attachment; filename="cap_fast.bin"' },   /* chunked and quick: done before the next poll */
};
const STREAM_TOTAL = 8 * 1024 * 1024;

async function startPlatform() {
  const sessions = new Set();
  const person = { signin: false, flips: new Set() };
  const requests = [];
  const stats = { streamSent: 0, trapRequests: 0, deleteRequests: 0 };
  const servers = [];
  const listen = (handler, host) => new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, host, () => { servers.push(server); resolve(server); });
  });
  const send = (res, status, type, body, headers = {}) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers }); res.end(body); };
  const cookieOf = (req, name) => { const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || ''); return m ? m[1] : null; };

  let trap = null;
  try { trap = await listen((req, res) => { stats.trapRequests += 1; send(res, 200, 'text/plain', 'trap'); }, '127.0.0.2'); } catch (e) { trap = null; }   /* some systems have no 127.0.0.2 */
  const files = await listen((req, res) => {
    const u = new URL(req.url, 'http://x');
    requests.push({ origin: 'files', method: req.method, path: u.pathname, cookie: Boolean(req.headers.cookie) });
    const m = /^\/blob\/([^/]+)$/.exec(u.pathname);
    const def = m && Object.values(FILES).find((f) => f.name === decodeURIComponent(m[1]));
    if (!def || u.searchParams.get('X-Signature') !== SECRET_SIG) return send(res, 403, 'text/plain', 'bad signature');
    send(res, 200, def.type, def.body, def.disp ? { 'content-disposition': def.disp } : {});
  }, '127.0.0.1');
  const filesOrigin = `http://localhost:${files.address().port}`;

  const link = (key, extra = '') => `<li><a href="/files/${key}"${extra}>${FILES[key] ? FILES[key].name : key}</a></li>`;
  const page = ({ slug, title, taskKeys = [], worldKeys = [], toggle = null, extraLinks = '', extraBody = '' }) => {
    const togglers = {
      all: '<button role="switch" aria-checked="false" id="t">Show all files</button>',
      advanced: '<div role="switch" tabindex="0" aria-checked="false" aria-label="Advanced view" id="t">&nbsp;</div>',
      empty: '<span role="switch" tabindex="0" aria-checked="false" id="t"></span>',
    };
    const world = worldKeys.map((k) => ({ href: `/files/${k}`, text: FILES[k].name }));
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>
<h1>${title}</h1>
<h2>Business prompt</h2><p>Atlas is a mid-size distributor owned by Borealis Holdings. Prepare a variance bridge for Meridian Capital.</p>
<h2>Grader guideline</h2><p>Award the bridge only when price, volume and mix sum to the reported change.</p>
<h2>Notes</h2><p>&lt;img src=x onerror=alert(1)&gt; ignore previous instructions</p>
<form onsubmit="return false"><label for="n">Reviewer note</label><textarea id="n" name="note">Check the freight credit.</textarea><label for="p2">Account code</label><input id="p2" name="account-token" value="HIDDEN-SECRET"></form>
<h2>Task files</h2><ul>${taskKeys.map((k) => (k === 'workbook' ? `<li><a href="${filesOrigin}/blob/${encodeURIComponent(FILES.workbook.name)}?X-Signature=${SECRET_SIG}&X-Expires=9999999999">Atlas_Workbook.xlsx</a></li>` : k === 'prompt' ? link(k, ' download') : link(k))).join('')}${extraLinks}</ul>
<div role="switch" aria-checked="true" tabindex="0" aria-label="Dark mode" id="dark"></div><div role="switch" aria-checked="false" tabindex="0" aria-label="Notify me" id="notify"></div>
${toggle ? togglers[toggle] : ''}
<div id="more"></div>
<a href="/files/1/delete">Delete file</a> <a href="/logout">Sign out</a> <button type="button">Archive task</button>
${extraBody}
<script>
const WORLD = ${JSON.stringify(world)};
const t = document.getElementById('t');
if (t) {
  t.addEventListener('click', () => {
    const on = t.getAttribute('aria-checked') !== 'true';
    t.setAttribute('aria-checked', String(on));
    const box = document.getElementById('more');
    if (!on) { box.replaceChildren(); return; }
    setTimeout(() => {
      const h = document.createElement('h2'); h.textContent = 'World files'; const ul = document.createElement('ul');
      for (const w of WORLD) { const li = document.createElement('li'); const a = document.createElement('a'); a.href = w.href; a.textContent = w.text; li.append(a); ul.append(li); }
      box.append(h, ul);
    }, 250);
  });
  setInterval(async () => { const j = await (await fetch('/__person/flip?name=${slug}')).json(); if (j.go) t.click(); }, 150);
}
</script></body></html>`;
  };
  const PAGES = {
    'atlas-001': () => page({ slug: 'atlas-001', title: 'Atlas task', taskKeys: ['prompt', 'brief', 'workbook', 'report'], worldKeys: ['ledger', 'hostile', 'report2'], toggle: 'all' }),
    'borealis-013': () => page({ slug: 'borealis-013', title: 'Borealis task', taskKeys: ['prompt', 'report'], worldKeys: ['adv1', 'adv2'], toggle: 'advanced' }),
    'meridian-020': () => page({ slug: 'meridian-020', title: 'Meridian task', taskKeys: ['prompt'], worldKeys: ['adv3'], toggle: 'empty' }),
    'plain-030': () => page({ slug: 'plain-030', title: 'Plain task', taskKeys: ['prompt', 'report'], extraBody: `<script>alert('Atlas banner'); confirm('Leave this page?');</script>` }),   /* dialogs freeze a page until someone answers */
    'caps-040': () => page({ slug: 'caps-040', title: 'Caps task', taskKeys: ['cap-a', 'cap-big'], worldKeys: ['cap-stream', 'cap-fast', 'cap-b', 'cap-c', 'cap-d'], toggle: 'all' }),
    'edge-060': () => page({
      slug: 'edge-060', title: 'Edge task', taskKeys: ['prompt', 'offsite', 'gone', 'htmlfile'], worldKeys: ['adv4'], toggle: 'all',
      extraBody: `<button type="button" id="blob">Atlas_Blob.txt</button><script>
document.getElementById('blob').addEventListener('click', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['blob content from the page\\n'], { type: 'text/plain' })); a.download = 'Atlas_Blob.txt'; document.body.append(a); a.click(); a.remove(); });
setInterval(async () => { const j = await (await fetch('/__person/flip?name=stray')).json(); if (j.go) { const a = document.createElement('a'); a.href = '/files/prompt'; a.download = 'stray.txt'; document.body.append(a); a.click(); a.remove(); } }, 150);
</script>`,
      extraLinks: '<li><a href="javascript:alert(1)" download>evil.pdf</a></li><li><a href="file:///etc/passwd" download>passwd.txt</a></li><li><a href="https://127.0.0.2:22/x.pdf">x.pdf</a></li><li><a href="https://10.0.0.5/y.pdf">y.pdf</a></li>',
    }),
  };
  FILES['cap-stream'] = { name: 'cap_stream.bin', type: 'application/octet-stream', body: null, disp: 'attachment; filename="cap_stream.bin"' };
  FILES.offsite = { name: 'Offsite.txt', type: 'text/plain', body: Buffer.from('x'), disp: null };
  FILES.gone = { name: 'Gone.pdf', type: 'application/pdf', body: Buffer.from('x'), disp: null };

  const main = await listen((req, res) => {
    const u = new URL(req.url, 'http://x');
    const signedIn = sessions.has(cookieOf(req, 'sid'));
    requests.push({ origin: 'main', method: req.method, path: u.pathname, cookie: Boolean(req.headers.cookie) });
    if (u.pathname === '/__person/signin') { const go = person.signin; return send(res, 200, 'application/json', JSON.stringify({ go })); }
    if (u.pathname === '/__person/flip') { const go = person.flips.delete(u.searchParams.get('name'));   /* once: a person clicks once */ return send(res, 200, 'application/json', JSON.stringify({ go })); }
    if (u.pathname === '/login' && req.method === 'GET') {
      return send(res, 200, 'text/html; charset=utf-8', `<!doctype html><title>Sign in</title><h1>Sign in</h1>
<form id="f" method="post" action="/login"><input type="hidden" name="next" value="${(u.searchParams.get('next') || '/').replace(/[^A-Za-z0-9/_%?=&.-]/g, '')}"><label>User <input name="user" value="owner"></label><label>Password <input type="password" name="password" value="synthetic"></label><button>Sign in</button></form>
<script>setInterval(async () => { const j = await (await fetch('/__person/signin')).json(); if (j.go) document.getElementById('f').submit(); }, 150);</script>`);
    }
    if (u.pathname === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        person.signin = false;
        const token = crypto.randomBytes(12).toString('hex');
        sessions.add(token);
        const next = new URLSearchParams(body).get('next') || '/';
        res.writeHead(302, { location: decodeURIComponent(next), 'set-cookie': `sid=${token}; Path=/; HttpOnly; SameSite=Lax` });   /* no expiry: a session cookie */
        res.end();
      });
      return undefined;
    }
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
      if (key === 'gone') return send(res, 404, 'text/plain', 'gone');
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
    origin, filesOrigin, requests, stats, hasTrap: Boolean(trap),
    signOut: () => sessions.clear(),
    signIn: () => { person.signin = true; },
    flip: (name) => person.flips.add(name),
    unflip: (name) => person.flips.delete(name),
    close: () => Promise.all(servers.map((s) => new Promise((resolve) => { s.closeAllConnections(); s.close(resolve); }))),
  };
}

/* ---------------------------------------------------------------- the test harness */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-links-qa-'));
const calls = [];   /* every CDP method the loader sent, in order */
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const spawnFn = (binary, args, options) => {
  const child = spawn(binary, isRoot ? [...args.slice(0, -1), '--no-sandbox', args[args.length - 1]] : args, options);
  const pipe = child.stdio[3]; const write = pipe.write.bind(pipe);
  pipe.write = (chunk, ...rest) => { try { calls.push(JSON.parse(String(chunk).replace(/\0$/, '')).method); } catch (e) { /* not a command */ } return write(chunk, ...rest); };
  return child;
};
const fixedClock = () => new Date('2026-10-23T12:00:00.000Z');
const loaders = [];
const makeLoader = (root, extra = {}) => { const loader = createLinkLoader({ root, chromePath, spawnFn, clock: fixedClock, headless: true, allowLoopback: true, timeouts: { poll: 100, settle: 8000, begin: 8000, stall: 5000 }, ...extra }); loaders.push(loader); return loader; };
const profileOf = (root) => path.join(root, 'private', 'link-profile');
const group = (profile) => {
  const main = listProcesses().find((p) => p.cmd.includes(`--user-data-dir=${profile}`) && p.cmd.includes('--remote-debugging-pipe'));
  return main ? { main, all: listProcesses().filter((p) => p.pgid === main.pid) } : null;
};
const leftovers = (profile) => listProcesses().filter((p) => !p.state.startsWith('Z') && p.cmd.includes(profile));

/* Poll a load; run handlers[state] once, the first time that state is seen (handlers may be async; polling waits for them). */
async function drive(loader, id, handlers = {}, limitMs = 90000) {
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
const walk = (dir) => { const out = []; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, e.name); if (e.isDirectory()) out.push(...walk(full)); else if (e.isFile()) out.push(full); } return out; };
const truthByName = Object.fromEntries(Object.values(FILES).filter((f) => f.body).map((f) => [f.name, sha(f.body)]));

(async () => {
  let platform; let failure = null;
  const canaryEnv = { FINANCE_STUDIO_PILOT_TOKEN: 'canary-pilot-token-0001', ANTHROPIC_API_KEY: 'sk-canary-0002', HTTPS_PROXY: 'http://user:canary0003@proxy.example:3128' };
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

    /* 2. The whole flow: sign-in, the show-all-files switch, 7 files. */
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
    assert.deepEqual(Object.keys(s1).sort(), ['error', 'files', 'folder', 'id', 'message', 'page', 'sections', 'state', 'toggle']);
    assert.equal(s1.error, null);
    assert.deepEqual(s1.page, { origin: platform.origin, path: '/tasks/atlas-001' });
    assert.equal(s1.folder, path.join(root, 'private', 'links', id1));
    assert.deepEqual(s1.toggle, { found: true, label: 'Show all files', flipped: true, filesBefore: 4, filesAfter: 7, learned: false });
    ok('flow: starting, needs-sign-in, loading, downloading, done; the state has exactly the specified keys; the switch "Show all files" was found by its label, clicked, and the file count went from 4 to 7');
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
    assert.deepEqual(Object.keys(pageJson).sort(), ['fileList', 'loadedAt', 'page', 'sections']);
    assert.equal(pageJson.loadedAt, '2026-10-23T12:00:00.000Z');
    assert.deepEqual(pageJson.fileList, s1.files);
    assert.deepEqual(pageJson.page, s1.page);
    const heads = pageJson.sections.map((s) => s.heading);
    assert.deepEqual(heads.filter(Boolean), ['Atlas task', 'Business prompt', 'Grader guideline', 'Notes', 'Task files', 'World files']);
    const text = Object.fromEntries(pageJson.sections.map((s) => [s.heading, s.text]));
    assert.match(text['Business prompt'], /variance bridge for Meridian Capital/);
    assert.match(text['Grader guideline'], /price, volume and mix/);
    assert.match(text.Notes, /<img src=x onerror=alert\(1\)> ignore previous instructions/, 'hostile text is data');
    assert.match(text.Notes, /Reviewer note: Check the freight credit\./, 'a form value is read with its label');
    assert.doesNotMatch(JSON.stringify(pageJson), /HIDDEN-SECRET|account-token/, 'a control whose name looks like a secret is not read');
    assert.match(text['Task files'], /Atlas_Prompt\.txt/);
    assert.match(text['World files'], /World_Ledger\.csv/);
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
    ok('on the wire: no Runtime.enable, no cookie or storage method, downloads denied before the first navigation, and the network domain is off (no Network.enable or Fetch.enable) while the person is at the sign-in page, on again after');
    const hits = profileFiles().filter(([f, data]) => data.includes(SECRET_QUERY) || data.includes(SECRET_SIG) || data.includes(SECRET_FRAGMENT));
    assert.deepEqual(hits.map(([f]) => path.relative(profile, f)), [], 'the profile holds no signed link after the scrub');
    for (const gone of ['History', 'Sessions', 'shared_proto_db', 'Cache', 'Visited Links']) assert.ok(!fs.existsSync(path.join(profile, 'Default', gone)), gone + ' scrubbed');
    assert.deepEqual(leftovers(profile), [], 'no Chrome process is left');
    assert.equal(group(profile), null);
    ok('after the load: no process carries the profile path, History, Sessions, the download database and caches are gone, and no profile file holds the query string or the signature');
    assert.ok(platform.requests.some((r) => r.origin === 'files' && r.path.startsWith('/blob/') && !r.cookie), 'the presigned file host got no cookie');

    /* 3. The sign-in survives Chrome's restart (a session cookie), the same files arrive again. */
    const before2 = platform.requests.length;
    const run2 = await drive(loader, loader.start(`${platform.origin}/tasks/atlas-001`));
    assert.equal(run2.final.state, 'done', JSON.stringify(run2.final));
    assert.ok(!run2.seen.includes('needs-sign-in'), 'no sign-in the second time: ' + run2.seen.join());
    assert.deepEqual(run2.final.files.map((f) => [f.label, f.sha256]).sort(), s1.files.map((f) => [f.label, f.sha256]).sort());
    assert.notEqual(run2.final.id, id1);
    assert.ok(platform.requests.slice(before2).every((r) => r.origin !== 'main' || r.path !== '/login'));
    ok('the second load needs no sign-in (the session cookie survived the restart and the scrub) and returns the same hashes in a new folder');

    /* 4. A switch with an unrelated label: needs-person, continue, learned; the next load uses it. */
    platform.signOut();
    const urlB = `${platform.origin}/tasks/borealis-013`;
    const idB = loader.start(urlB);
    const runB = await drive(loader, idB, {
      'needs-sign-in': async () => { await until(() => calls.includes('Network.disable'), 'network off'); platform.signIn(); },
      'needs-person': async (state) => {
        assert.equal(state.message, 'Turn on the option that shows all files in the Chrome window, then press Continue.');
        assert.deepEqual(state.toggle, { found: false, label: '', flipped: false, filesBefore: 2, filesAfter: 2, learned: false });
        assert.ok(group(profile), 'Chrome stays open for the person');
        platform.flip('borealis-013');                    /* the person turns the switch on in the window ... */
        await delay(900);                                  /* ... the page adds its files ... */
        const after = loader.continue(idB);               /* ... and presses Continue */
        assert.equal(after.state, 'loading');
      },
    });
    assert.equal(runB.final.state, 'done', JSON.stringify(runB.final));
    assert.deepEqual(runB.seen.filter((x) => x !== 'starting'), ['needs-sign-in', 'loading', 'needs-person', 'downloading', 'done'], runB.seen.join());
    assert.deepEqual(runB.final.toggle, { found: true, label: 'Advanced view', flipped: true, filesBefore: 2, filesAfter: 4, learned: true });
    assert.equal(runB.final.files.length, 4);
    const mapFile = path.join(root, 'private', 'link-mappings.json');
    const mapping = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    assert.deepEqual(mapping, { schema: 'finance-link-mappings', version: 1, hosts: { [new URL(platform.origin).host]: { updatedAt: '2026-10-23T12:00:00.000Z', allFilesToggle: 'Advanced view' } } });
    assert.equal(fs.statSync(mapFile).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(mapFile)).filter((n) => n.endsWith('.tmp')), [], 'atomic write left no temp file');
    ok('needs-person with the exact message, continue() goes straight to loading, the switch the person flipped ("Advanced view") is stored for the host in link-mappings.json (0600, atomic) and the load finishes with 4 files');
    platform.unflip('borealis-013');
    const runB2 = await drive(loader, loader.start(urlB));
    assert.equal(runB2.final.state, 'done', JSON.stringify(runB2.final));
    assert.ok(!runB2.seen.includes('needs-person'), 'learned: no question the second time: ' + runB2.seen.join());
    assert.deepEqual(runB2.final.toggle, { found: true, label: 'Advanced view', flipped: true, filesBefore: 2, filesAfter: 4, learned: true });
    assert.equal(runB2.final.files.length, 4);
    ok('the next load of that host clicks the learned switch by itself (learned: true, no needs-person)');

    /* 5. A switch without any label: the person flips it, nothing can be learned. */
    const idC = loader.start(`${platform.origin}/tasks/meridian-020`);
    const runC = await drive(loader, idC, {
      'needs-person': async () => { platform.flip('meridian-020'); await delay(900); loader.continue(idC); },
    });
    assert.equal(runC.final.state, 'done', JSON.stringify(runC.final));
    assert.deepEqual(runC.final.toggle, { found: true, label: '', flipped: true, filesBefore: 1, filesAfter: 2, learned: false });
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(mapFile, 'utf8')).hosts).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(mapFile, 'utf8')).hosts[new URL(platform.origin).host].allFilesToggle, 'Advanced view', 'an unlabelled switch cannot be stored and does not replace what is stored');
    ok('an unlabelled switch: the person flips it, the load continues with the extra file, learned stays false and the stored mapping is untouched');
    platform.unflip('meridian-020');

    /* 6. No switch at all, cancel while waiting for the person; the process table is empty afterwards. */
    const idD = loader.start(`${platform.origin}/tasks/plain-030`);
    let startRefused = false;
    const runD = await drive(loader, idD, {
      'needs-person': async (state) => {
        assert.deepEqual(state.toggle, { found: false, label: '', flipped: false, filesBefore: 2, filesAfter: 2, learned: false });
        assert.throws(() => loader.start(`${platform.origin}/tasks/atlas-001`), (e) => e.status === 409);
        startRefused = true;
        const cancelled = loader.cancel(idD);
        assert.equal(cancelled.state, 'cancelled');
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
    ok('no switch found: needs-person; a second start is refused (409) while a load waits; cancel ends it as cancelled, Chrome is gone, continue afterwards is 409');
    const runD2 = await drive(loader, loader.start(`${platform.origin}/tasks/plain-030`), { 'needs-person': async (state) => { await delay(200); loader.continue(state.id); } });
    assert.equal(runD2.final.state, 'done', JSON.stringify(runD2.final));
    assert.deepEqual(runD2.final.toggle, { found: false, label: '', flipped: false, filesBefore: 2, filesAfter: 2, learned: false });
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

    /* 8. File hops, bad links on the page, caps. */
    const cancelsBefore = calls.filter((m) => m === 'Browser.cancelDownload').length;
    const idF = loader.start(`${platform.origin}/tasks/edge-060`);
    const runF = await drive(loader, idF, { downloading: async () => { platform.flip('stray'); } });   /* the page starts a download by itself while files are being fetched */
    assert.equal(runF.final.state, 'done', JSON.stringify(runF.final));
    assert.deepEqual(runF.final.files.map((f) => f.label).sort(), ['Atlas_Blob.txt', 'Atlas_Prompt.txt', 'Borealis_Extra.txt']);
    const blob = runF.final.files.find((f) => f.label === 'Atlas_Blob.txt');
    assert.equal(blob.name, 'Atlas_Blob.txt');
    assert.equal(fs.readFileSync(path.join(runF.final.folder, 'files', blob.name), 'utf8'), 'blob content from the page\n');
    assert.deepEqual(filesOnDisk(runF.final), ['Atlas_Blob.txt', 'Atlas_Prompt.txt', 'Borealis_Extra.txt'], 'the download the page started by itself was not kept');
    assert.ok(calls.filter((m) => m === 'Browser.cancelDownload').length > cancelsBefore, 'the stray download was cancelled');
    assert.match(runF.final.message, /not fetched: .*1 blocked-host/);
    assert.match(runF.final.message, /1 http-error/);
    assert.match(runF.final.message, /1 not-a-file/);
    assert.match(runF.final.message, /2 links to addresses the loader does not open/);
    assert.equal(platform.stats.trapRequests, 0, 'the redirect to an address written as numbers was never requested');
    assert.ok(!platform.requests.some((r) => /passwd|evil/.test(r.path)));
    ok('a button that builds a blob: URL is clicked and its download kept (click mode); a download the page starts by itself while files are fetched is cancelled and not kept; a page that opens alert and confirm dialogs does not hang the load');
    ok(`file links: a redirect to 127.0.0.2 is blocked before it is sent${platform.hasTrap ? ' (the listener saw 0 requests)' : ''}, a 404 and a web page in place of a file are not saved, javascript: and file: links are not candidates, https links to 127.0.0.2 and 10.0.0.5 are refused; the load still finishes with the good files and says what was not fetched`);

    const capped = makeLoader(root, { limits: { files: 6, fileBytes: 1024 * 1024, totalBytes: 1536 * 1024 } });
    const runG = await drive(capped, capped.start(`${platform.origin}/tasks/caps-040`));
    assert.equal(runG.final.state, 'done', JSON.stringify(runG.final));
    assert.deepEqual(runG.final.files.map((f) => f.label).sort(), ['cap_a.bin', 'cap_b.bin']);
    const refusedBy = Object.fromEntries([...runG.final.message.matchAll(/(\d+) (too-large|total-cap)/g)].map((m) => [m[2], Number(m[1])]));   /* which cap trips first for a file that breaks both depends on the poll */
    assert.equal((refusedBy['too-large'] || 0) + (refusedBy['total-cap'] || 0), 4, runG.final.message);
    assert.ok(refusedBy['too-large'] >= 1 && refusedBy['total-cap'] >= 1, runG.final.message);
    assert.match(runG.final.message, /1 more over the limit of 6 files/);
    assert.ok(platform.stats.streamSent < STREAM_TOTAL / 2, `the endless download was cut at the cap (${platform.stats.streamSent} bytes sent of ${STREAM_TOTAL})`);
    assert.deepEqual(filesOnDisk(runG.final), ['cap_a.bin', 'cap_b.bin']);
    ok(`caps: at most 6 files tried; a file announced above the per-file cap is refused before its body, a quick chunked file that ends over the cap is dropped, an endless download without Content-Length is cut at the cap (${platform.stats.streamSent} of ${STREAM_TOTAL} bytes sent), the total cap refuses the next file, partial files are removed`);

    /* 8b. Cancel in the middle of a download. */
    platform.stats.streamSent = 0;
    const idL = loader.start(`${platform.origin}/tasks/caps-040`);
    const runL = await drive(loader, idL, {
      downloading: async () => { await until(() => platform.stats.streamSent > 256 * 1024, 'the endless download to start', 30000); const sent = platform.stats.streamSent; assert.equal(loader.cancel(idL).state, 'cancelled'); assert.ok(sent < STREAM_TOTAL); },
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

    /* 9. A sign-in that never comes, and Chrome killed under the loader. */
    platform.signOut();
    const slow = makeLoader(root, { clock: undefined, timeouts: { poll: 100, settle: 8000, signIn: 1500 } });
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
    ok('Chrome killed (or its window closed) while the person signs in: failed with a plain message, nothing left running, the loader is free for the next link');
    platform.signIn();
    const quiet = makeLoader(root, { clock: undefined, timeouts: { poll: 100, settle: 8000, person: 1500 } });
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

    for (const state of finals) for (const needle of [SECRET_QUERY, SECRET_SIG, SECRET_FRAGMENT]) assert.ok(!JSON.stringify(state).includes(needle), 'a state holds ' + needle);
    ok(`none of the ${finals.length} final states holds the query string, the fragment or the signature`);
  } catch (error) {
    failure = error;
  } finally {
    for (const name of Object.keys(canaryEnv)) delete process.env[name];
    await Promise.all(loaders.map((l) => l.shutdown().catch(() => {})));   /* a failed run must not leave Chrome open */
    if (platform) await platform.close().catch(() => {});
    if (process.env.KEEP === '1') console.log('kept', tmp); else fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (failure) { console.error(failure); process.exitCode = 1; return; }
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
})();
