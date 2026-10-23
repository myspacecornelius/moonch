'use strict';
/* Optional developer QA for the Pipeline page. Uses an isolated headless Chromium profile; never attaches to an existing browser.
   The page is served by a FAKE companion started in this file (the same page assets, the connect-src change the real companion makes,
   and invented /api/status and /api/pipeline answers), so no model is started, no real companion is needed and nothing leaves this machine.
   All data is invented (Atlas, Meridian, Borealis, .example hosts). No file is written to qa/: the report goes to QA_OUTPUT (default: a
   temporary folder) and screenshots are taken only when QA_SHOTS names a folder.
   Run: CHROME_BIN=/path/to/chrome node tests/pipeline-browser.cjs   (about 30 seconds: the page polls every 2 seconds) */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), { spawn } = require('node:child_process'), assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const out = process.env.QA_OUTPUT ? path.resolve(root, process.env.QA_OUTPUT) : fs.mkdtempSync(path.join(os.tmpdir(), 'finance-pipeline-qa-'));
const shots = process.env.QA_SHOTS ? path.resolve(root, process.env.QA_SHOTS) : '';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-pipeline-headless-'));
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-pipeline-downloads-'));
const binary = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
fs.mkdirSync(out, { recursive: true });
if (shots) fs.mkdirSync(shots, { recursive: true });

const PG = 'Pa' + 'ge.';
const TASK_LINK = 'https://tasks.example/review/atlas-4821?session=SECRET-TOKEN-123';
const ACK_IDS = ['shell-access', 'network', 'isolation-by-audit', 'model-reads-task'];

/* ---------------------------------------------------------------- the fake companion */
const NONCE = 'nonce-browser-1';
const pipelines = new Map(), posts = [], gets = [];
const ENDED = ['done', 'failed', 'stopped', 'budget'];
/* the states are in the shape of backend/pipeline/service.cjs (_view): pilots inside attempts[].screen and .test, the last attempt current */
const pilots = (scores, extra = {}) => scores.map((score, i) => ({ n: i + 1, id: 'p' + (i + 1), replacement: false, state: 'completed', audit: { status: 'CLEAN', violationCount: 0 }, score, valid: typeof score === 'number', belowBar: typeof score === 'number' ? score < 0.45 : null, reason: '', ...(extra[i] || {}) }));
const stageOf = (name, scores, passed, extra) => ({ name, bar: 0.45, need: name === 'test' ? 4 : 2, of: name === 'test' ? 5 : 2, pilots: pilots(scores, extra), passed });
const attempt = (over = {}) => ({ n: 1, traps: ['Superseded facility schedule'], newFiles: 2, editedFiles: 1, screen: null, test: null, outcome: 'in-progress', ...over });
const W = { withheld: true };
/* diffs in the companion's own shape: { available, kind, added, removed, before, after, truncated, lines: [{ op, text }] } */
const DIFF = { available: true, kind: 'text', added: 1, removed: 1, before: 2000, after: 2120, truncated: false, lines: [{ op: ' ', text: 'Name,Value' }, { op: '-', text: 'Rate,4.00%' }, { op: '+', text: 'Rate,6.00%' }] };
const GUIDELINE_DIFF = { available: true, kind: 'text', added: 1, removed: 1, before: null, after: null, truncated: false, lines: [{ op: ' ', text: 'Award full credit when the answer holds the borrowing.' }, { op: '-', text: 'Count the available facility as cash.' }, { op: '+', text: 'Do not count the available facility as cash.' }] };
const design = (withheld = false) => ({
  attempt: 1,
  calibration: withheld ? W : { score: 0.97, verdict: 'meets-guidance', reason: 'Matches every rubric line.' },
  fairness: withheld ? W : { status: 'unfair', unfair: [{ item: 'The amended date is only in a footnote', why: 'A careful solver has no way to know which schedule governs.' }] },
  guidelineDiff: withheld ? W : GUIDELINE_DIFF,
  unscanned: withheld ? W : [{ name: 'Atlas_Scan_Note.pdf', kind: 'new' }, { name: 'Atlas_Facility_Schedule.rtf', kind: 'edited' }],
  rubricChanges: withheld ? W : [{ change: 'Added a line about the amended facility date', reason: 'The new trap turns on that date.' }],
  traps: [{ id: 't1', title: withheld ? W : 'Superseded facility schedule', mechanism: 'A later amendment replaces the schedule that stays in the folder.', files: withheld ? W : ['Atlas_Amendment_2.txt'], decoy: 'Atlas_Facility_Schedule.csv', correctValue: withheld ? { withheld: true } : '1,250', wrongValue: withheld ? { withheld: true } : '1,900' }],
  newFiles: [{ name: 'Atlas_Amendment_2.txt', bytes: 900 }, { name: 'Meridian_Note.txt', bytes: 400 }], editedFiles: [withheld ? { name: W, reason: W, diff: W, sizeChange: W } : { name: 'Atlas_Facility_Schedule.csv', reason: 'The decoy needs the old rate in column C.', diff: DIFF, bytes: 2120, beforeBytes: 2000 }], notes: [],
  prompt: withheld ? { withheld: true } : 'Assess the Atlas liquidity position and recommend whether the borrowing can proceed.',
  guideline: withheld ? { withheld: true } : 'Award full credit when the answer holds the borrowing on 1,250 of usable cash.',
  goldenAnswer: withheld ? { withheld: true } : 'Usable cash is 1,250. Hold the borrowing.',
  gold: withheld ? { withheld: true } : { decision: 'hold', figures: [{ label: 'Usable cash', value: '1,250', tolerance: 1 }] },
  fingerprints: withheld ? { withheld: true } : [{ id: 'fp-alpha', label: 'Counts available credit as cash', tokens: ['available facility counted'], figures: ['1,900'] }],
});
const ZIP = Buffer.from('PK synthetic zip bytes');
/* the rules GET /api/pipeline reports: the default total cap and the least total cap of one full attempt (1.15 x (6.25 + 7 x (3 + 1.5)) = 43.42 with the pilot cap of 3) */
const CONFIG = { defaultCapUsd: 50, headroom: 1.15, minCap: { fixedUsd: 6.25, perPilotUsd: 1.5, pilots: 7, headroom: 1.15 } };
function handleApi(req, res, url, body) {
  const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  if (req.method === 'POST') {
    posts.push({ url, nonce: req.headers['x-finance-local'], body });
    if (req.headers['x-finance-local'] !== NONCE) return send(403, { error: 'Bad session code' });
  } else gets.push(url);
  if (url === '/api/status') return send(200, { nonce: NONCE, agents: { models: ['claude-opus-5-5', 'claude-sonnet-5-5'], efforts: ['low', 'medium', 'high'], maxPilotsPerRound: 5, runtime: { found: true } } });
  if (req.method === 'GET' && url === '/api/pipeline') return send(200, { pipelines: [...pipelines.values()].map(p => ({ id: p.id, label: p.label, createdAt: p.createdAt, stage: p.stage, running: !ENDED.includes(p.stage), message: p.message, spentUsd: p.spentUsd, capUsd: p.capUsd, attempt: p.attempts.length, redesigns: p.redesigns })), running: null, config: CONFIG });
  if (req.method === 'POST' && url === '/api/pipeline/start') {
    if ([...pipelines.values()].some(p => !ENDED.includes(p.stage))) return send(409, { error: 'A pipeline is already running.' });
    const state = { id: 'pl-browser-0001', label: 'Atlas review', stage: 'import', running: true, message: 'Opening the task page', createdAt: new Date().toISOString(), source: { kind: 'url', origin: 'https://tasks.example', path: '/review/atlas-4821' }, capUsd: body.capUsd, spentUsd: 0, pilotCapUsd: body.pilotCapUsd, model: body.model, effort: body.effort, redesigns: 0, waiting: null, import: null, classification: null, design: null, attempts: [], result: null, summary: '', error: null };
    pipelines.set(state.id, state);
    return send(200, { id: state.id });
  }
  const m = /^\/api\/pipeline\/([\w-]+)(\/[a-z]+)?$/.exec(url);
  if (m && pipelines.has(m[1])) {
    if (req.method === 'GET' && !m[2]) return send(200, pipelines.get(m[1]));
    if (req.method === 'POST' && m[2] === '/continue') { set({ waiting: null }); return send(200, pipelines.get(m[1])); }
    if (req.method === 'POST' && m[2] === '/stop') { set({ stage: 'stopped', running: false }); return send(200, pipelines.get(m[1])); }
    if (req.method === 'POST' && m[2] === '/export') return send(200, { name: 'Atlas_review_pipeline_PRIVATE.zip', size: ZIP.length, sha256: 'x'.repeat(64), files: [], zipBase64: ZIP.toString('base64') });

  }
  send(404, { error: 'Not found' });
}
const set = patch => { const [id, state] = [...pipelines][0]; pipelines.set(id, { ...state, ...patch }); };
/* the current (last) attempt, made when it is first needed */
const setAttempt = patch => { const [, state] = [...pipelines][0]; const all = state.attempts.length ? state.attempts : [attempt()]; set({ attempts: all.map((a, i) => (i === all.length - 1 ? { ...a, ...patch } : a)) }); };

function startServer() {
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const assets = new Set([...index.matchAll(/(?:src|href)="([a-z-]+\.(?:js|css))"/g)].map(m => m[1]));
  const served = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const url = req.url;
      served.push(req.method + ' ' + url);
      if (url.startsWith('/api/')) {
        let body = null;
        try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null; } catch { /* a body that is not JSON */ }
        return handleApi(req, res, url, body);
      }
      if (url === '/' || url === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(index.replace("connect-src 'none'", "connect-src 'self'")); }
      const name = url.slice(1);
      if (assets.has(name)) { res.writeHead(200, { 'content-type': name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); return res.end(fs.readFileSync(path.join(root, name))); }
      res.writeHead(404); res.end('Not found');
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, served })));
}

/* ---------------------------------------------------------------- DevTools protocol helpers */
let proc, ws, nextId = 0;
const pending = new Map(), errors = [], requests = [], checks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const pass = label => checks.push(label);
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000);
    pending.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception));
  return r.result.value;
}
async function waitFor(expression, label, timeout = 9000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await evaluate(expression)) return; } catch { /* the page may be repainting */ }
    await delay(60);
  }
  throw new Error('Timed out waiting for ' + label);
}
const q = selector => JSON.stringify(selector);
const exists = selector => evaluate(`!!document.querySelector(${q(selector)})`);
const text = selector => evaluate(`(document.querySelector(${q(selector)})||{}).innerText||''`);
const count = selector => evaluate(`document.querySelectorAll(${q(selector)}).length`);
const click = async selector => { assert.equal(await evaluate(`(()=>{const el=document.querySelector(${q(selector)});if(!el)return false;el.click();return true;})()`), true, 'missing ' + selector); await delay(80); };
const focused = () => evaluate('(()=>{const a=document.activeElement;return a?(a.getAttribute("data-pl-key")||a.id||a.tagName):""})()');
const KEYS = {
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' }
};
async function press(name, modifiers = 0) {
  const k = KEYS[name];
  await call('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', modifiers, ...k });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
  await delay(70);
}
async function viewport(width, height) {
  await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 });
  await delay(150);
}
async function shot(name, width, height) {
  if (!shots) return;
  await viewport(width, height);
  const r = await call(PG + 'captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shots, name + '.png'), Buffer.from(r.data, 'base64'));
}
const overflow = () => evaluate('(()=>{const d=document.documentElement;return {scroll:Math.max(d.scrollWidth,document.body.scrollWidth),inner:innerWidth}})()');
async function noHorizontalOverflow(label) {
  for (const [w, h] of [[1440, 1000], [1280, 800], [390, 844]]) {
    await viewport(w, h);
    const o = await overflow();
    assert.ok(o.scroll <= o.inner, `${label}: horizontal overflow at ${w}x${h}: scrollWidth ${o.scroll} > ${o.inner}`);
  }
  await viewport(1440, 1000);
}
/* The page repaints from a poll every 2 seconds; wait for the next one that shows what the fake companion now holds. */
const POLL_WAIT = 6000;
const stageIs = pattern => `/${pattern}/.test((document.querySelector("#pl-stage")||{}).textContent||"")`;

(async () => {
  const { server, port, served } = await startServer();
  try {
    proc = spawn(binary, [...(process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []), '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const browserURL = await new Promise((resolve, reject) => {
      let log = '';
      const t = setTimeout(() => reject(new Error('Headless browser startup timeout')), 15000);
      proc.stderr.on('data', d => { log += d; const m = log.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
      proc.on('error', reject);
      proc.on('exit', code => { if (code) reject(new Error('Headless browser exited ' + code + ' ' + log.slice(-1200))); });
    });
    const origin = browserURL.replace(/^ws:/, 'http:').split('/devtools/')[0];
    const targets = await (await fetch(origin + '/json/list')).json();
    const target = targets.find(x => x.type === 'page');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); clearTimeout(p.timeout); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value || a.description));
      if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
    });
    await call(PG + 'enable'); await call('Runtime.enable'); await call('Log.enable'); await call('Network.enable');
    await call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await viewport(1440, 1000);
    await call(PG + 'navigate', { url: `http://127.0.0.1:${port}/index.html` });
    await waitFor('document.readyState==="complete"&&!!window.FinanceDashboard&&!!window.FinancePipeline', 'the page and the Pipeline module');
    await delay(300);

    /* ---------- the view in the shell ---------- */
    const navLabels = await evaluate('[...document.querySelectorAll(".dash-sidebar .nav-btn")].map(b=>b.textContent.trim())');
    assert.ok(navLabels.indexOf('Pipeline') === navLabels.indexOf('Agents') - 1 && navLabels.indexOf('Pipeline') > 0, 'Pipeline sits right above Agents: ' + navLabels.join(', '));
    await click('[data-dash-tab="pipeline"]');
    await waitFor('!!document.querySelector("#pl-root [data-pl=start]")', 'the start card to paint');
    assert.equal(await text('.dash-sidebar .nav-btn.active'), 'Pipeline');
    assert.equal(await evaluate('document.querySelector(".dash-sidebar .nav-btn.active").getAttribute("aria-current")'), 'page');
    assert.equal(await exists('.dash-topbar'), false, 'the page draws its own header');
    assert.equal(await count('#analysis-main h1'), 1, 'one h1');
    assert.equal(await text('#pl-root h1'), 'From a task link to a tested set of traps.');
    assert.equal(await evaluate('document.querySelector("[data-pl=start]").disabled'), true, 'Approve and start waits for the acknowledgements');
    assert.equal(await text('[data-pl=start]'), 'Approve and start');
    assert.match(await text('#pl-why'), /Enter the task link/);
    assert.equal(await count('#pl-root button.primary'), 1, 'one yellow primary');
    assert.equal(await evaluate('document.querySelector("#pl-cap").value'), '50', 'the companion\'s default total cap');
    assert.equal(await text('#pl-cap-min'), 'A full attempt with these caps can cost up to USD 43.42.');
    assert.equal(await count('#pl-start-form input[data-pl-in=ack]'), 4);
    assert.equal(await count('#pl-start-form input[type=checkbox]'), 5, 'the four acknowledgements and the withheld-files choice');
    assert.equal(await evaluate('document.querySelectorAll("#pl-root [role=status][aria-live=polite]").length >= 3'), true, 'live regions for the message, the stage and the wait');
    await noHorizontalOverflow('start card');
    pass('the view opens in the shell with its own header, one yellow primary (disabled with its reason), four acknowledgements and no horizontal overflow at three sizes');
    await shot('01-start-1440', 1440, 1000);
    await shot('01-start-390', 390, 844);
    await viewport(1440, 1000);

    /* the primary is the only yellow thing: no button wears it while Approve and start is disabled, exactly one when it is enabled */
    const yellowButtons = () => evaluate(`(()=>{const probe=document.createElement("i");probe.style.color=getComputedStyle(document.documentElement).getPropertyValue("--primary");document.body.append(probe);const want=getComputedStyle(probe).color;probe.remove();return [...document.querySelectorAll("#pl-root button")].filter(b=>getComputedStyle(b).backgroundColor===want).map(b=>b.getAttribute("data-pl"));})()`);
    assert.deepEqual(await yellowButtons(), [], 'a disabled Approve and start is not yellow');
    /* ---------- the keyboard path: real key presses ---------- */
    await evaluate('document.querySelector("#pl-url").focus()');
    await call('Input.insertText', { text: TASK_LINK });
    await delay(80);
    assert.match(await text('#pl-why'), /Tick all four acknowledgements/);
    /* the least total cap, typed live: the figure follows the pilot cap, and Start waits for a cap that covers it */
    await evaluate('document.querySelector("#pl-cap").focus();document.querySelector("#pl-cap").select()');
    await call('Input.insertText', { text: '40' });
    await delay(80);
    assert.equal(await text('#pl-why'), 'The total cap must be at least USD 43.42 for one full attempt with these caps.');
    assert.equal(await evaluate('document.querySelector("[data-pl=start]").disabled'), true);
    await evaluate('document.querySelector("#pl-cap").select()');
    await call('Input.insertText', { text: '50' });
    await evaluate('document.querySelector("#pl-pilot-cap").focus();document.querySelector("#pl-pilot-cap").select()');
    await call('Input.insertText', { text: '5' });
    await delay(80);
    assert.equal(await text('#pl-cap-min'), 'A full attempt with these caps can cost up to USD 59.52.', 'the figure follows the pilot cap as it is typed');
    assert.equal(await text('#pl-why'), 'The total cap must be at least USD 59.52 for one full attempt with these caps.');
    assert.equal(await evaluate('document.querySelector("#pl-cap").getAttribute("aria-describedby")'), 'pl-cap-hint pl-cap-min');
    await evaluate('document.querySelector("#pl-pilot-cap").select()');
    await call('Input.insertText', { text: '3' });
    await delay(80);
    assert.equal(await text('#pl-cap-min'), 'A full attempt with these caps can cost up to USD 43.42.');
    assert.match(await text('#pl-why'), /Tick all four acknowledgements/, 'a cap that covers it: the next reason is the acknowledgements');
    await shot('01b-min-cap-1440', 1440, 1000);
    await evaluate('document.querySelector("#pl-url").focus()');
    const order = [];
    for (let i = 0; i < 6; i++) { await press('Tab'); order.push(await focused()); }
    assert.deepEqual(order, ['cap', 'model', 'effort', 'pilot-cap', 'accept-missing', 'ack-shell-access'], 'Tab walks the fields in reading order');
    assert.equal(await evaluate('document.querySelector("[data-pl-key=accept-missing]").checked'), false, 'the withheld-files choice is off unless the person turns it on');
    for (let i = 0; i < 4; i++) {
      await press('Space');
      assert.equal(await focused(), 'ack-' + ACK_IDS[i], 'ticking an acknowledgement keeps the keyboard on it');
      if (i < 3) await press('Tab');
    }
    assert.equal(await evaluate('document.querySelector("[data-pl=start]").disabled'), false, 'all four ticked: the button works');
    assert.deepEqual(await yellowButtons(), ['start'], 'enabled, it is the one yellow button');
    assert.equal(await text('#pl-why'), '');
    await press('Tab');
    assert.equal(await focused(), 'start');
    pass('keyboard only: the fields are reached in order, Space ticks the acknowledgements without losing focus, and Tab then reaches the enabled button');

    /* ---------- start: one POST, the link gone from the page ---------- */
    await press('Enter');
    await waitFor(stageIs('^Import:'), 'the first stage', 5000);
    const start = posts.find(p => p.url === '/api/pipeline/start');
    assert.ok(start, 'the page posted a start');
    assert.equal(start.nonce, NONCE);
    assert.deepEqual(start.body, { url: TASK_LINK, capUsd: 50, model: 'claude-opus-5-5', effort: 'medium', pilotCapUsd: 3, acceptMissing: false, acknowledgements: ACK_IDS });
    assert.equal(posts.filter(p => p.url === '/api/pipeline/start').length, 1);
    assert.equal(await focused(), 'pl-stage', 'the keyboard moves to the stage line');
    assert.equal(await evaluate('document.body.innerHTML.includes("SECRET-TOKEN-123")'), false, 'the link is nowhere in the page');
    assert.equal(await exists('[data-pl=start]'), false);
    assert.match(await text('#pl-start-form'), /A pipeline is running/);
    assert.equal(await exists('[data-pl=stop]'), true, 'Stop is visible while it runs');
    assert.match(await text('#pl-spend'), /Spent USD 0\.00 of USD 50\.00/);
    pass('Enter on the button posts once with the nonce and the exact body; the link leaves the page; the keyboard lands on the stage line; Stop and the spend line show');
    await noHorizontalOverflow('running');

    /* ---------- the loader needs the person ---------- */
    set({ waiting: { kind: 'needs-sign-in', message: 'Sign in to the task site in the Chrome window, then press Continue.' } });
    await waitFor(stageIs('^Waiting for you'), 'the sign-in wait', POLL_WAIT);
    assert.equal(await text('#pl-wait h2'), 'Sign in');
    set({ waiting: { kind: 'needs-person', message: 'Turn on the option that shows all files in the Chrome window, then press Continue.' } });
    await waitFor('document.querySelector("#pl-wait h2")&&document.querySelector("#pl-wait h2").textContent!=="Sign in"', 'the wait to change kind', POLL_WAIT);
    assert.equal(await text('#pl-wait h2'), 'Your action is needed in the Chrome window', 'a needs-person wait is not called a sign-in');
    assert.match(await text('#pl-wait'), /Turn on the option that shows all files in the Chrome window, then press Continue\./);
    /* a thousand characters and more of the loader's message are shown whole, wrapped, without a sideways scroll */
    const longMessage = ('3 files could not be downloaded: Atlas_Amendment_2.txt, Meridian_Note.txt, Borealis_Terms.txt. Download them yourself into a folder and use Import a folder. ').repeat(8).slice(0, 1196) + ' END';
    set({ waiting: { kind: 'needs-person', message: longMessage } });
    await waitFor('document.querySelector("#pl-wait .pl-wait-message")&&document.querySelector("#pl-wait .pl-wait-message").textContent.length>1000', 'the long message', POLL_WAIT);
    assert.equal(await evaluate('document.querySelector("#pl-wait .pl-wait-message").textContent'), longMessage, 'the whole message');
    assert.equal(await text('#pl-stage'), 'Waiting for you: Your action is needed in the Chrome window. The whole message is in the card below.', 'the sticky bar stays short');
    await viewport(390, 844);
    assert.ok(await evaluate('document.querySelector("#pl-bar").getBoundingClientRect().height') < 160, 'and the bar stays compact on a phone');
    await shot('02b-waiting-long-390', 390, 844);
    await viewport(1440, 1000);
    await noHorizontalOverflow('long wait message');
    assert.equal(await evaluate('document.querySelector("#pl-wait").getAttribute("aria-live")'), 'polite');
    await shot('02-waiting-1440', 1440, 900);
    await viewport(1440, 1000);
    await evaluate('document.querySelector("[data-pl=continue]").focus()');
    await press('Enter');
    await waitFor('!document.querySelector("#pl-wait [data-pl=continue]")', 'the wait to end', 5000);
    assert.ok(posts.some(p => p.url === '/api/pipeline/pl-browser-0001/continue' && p.nonce === NONCE));
    pass('the waiting message shows in a polite live region with a Continue button that works from the keyboard and posts once');

    /* ---------- classify, design ---------- */
    set({ stage: 'classify', message: 'Classifying what was captured', spentUsd: 0.4, import: { fileCount: 9, page: { origin: 'https://tasks.example', path: '/review/atlas-4821' }, toggle: { found: true, label: 'Show all files', flipped: true, filesBefore: 4, filesAfter: 9, learned: false }, skipped: [], files: [], facts: { world: 5, task: 3, withheld: 2, other: 1 } } });
    await waitFor(stageIs('^Classify:'), 'classify', POLL_WAIT);
    assert.match(await text('#pl-import'), /9 files in all · 5 world · 3 task · 2 withheld · 1 other/);
    assert.match(await text('#pl-import'), /Found and turned on \(“Show all files”\)\. 4 files offered before, 9 after\./);
    assert.match(await text('#pl-spend'), /USD 0\.40 of USD 50\.00/);
    assert.equal(await evaluate('document.querySelector("#pl-timeline [aria-current=step] strong").textContent'), 'Classify');
    assert.match(await text('#pl-spend'), /Classifying what was captured/, 'the companion\'s progress message shows under the stage');
    set({ stage: 'design', classification: { prompt: { kind: 'section', section: 'Business request', number: 2 }, guideline: { kind: 'file', file: 'Atlas_Grader_Guide.docx' }, goldenAnswer: { kind: 'file', file: 'Atlas_Reference_Answer.docx' }, worldFiles: ['Atlas_Facility_Schedule.csv', 'Meridian_Ledger.xlsx'], taskFiles: ['Atlas_Brief.txt'], other: [], withheld: [{ name: 'Atlas_Grader_Guide.docx', why: 'it is the grader guideline' }, { name: 'Atlas_Reference_Answer.docx', why: 'it is the golden answer' }], notes: [], warnings: [{ name: 'Meridian_Ledger.xlsx', why: 'it holds a long passage of the guideline or the golden answer' }] }, design: design(), attempt: 1, attempts: [attempt()] });
    await waitFor(stageIs('^Design:'), 'design', POLL_WAIT);
    assert.match(await text('#pl-classify'), /Section “Business request”/);
    assert.match(await text('#pl-classify'), /File “Atlas_Grader_Guide\.docx”/);
    assert.match(await text('#pl-design'), /Superseded facility schedule/);
    assert.match(await text('#pl-design'), /Atlas_Facility_Schedule\.csv/);
    assert.match(await text('#pl-design'), /The decoy needs the old rate in column C\./);
    assert.equal(await count('#pl-design .pl-edit'), 1, 'the edited world file is highlighted as an edit');
    assert.match(await text('#pl-design .pl-edit'), /Edited world file/);
    pass('classify and design show the import facts, the classification by name, the traps and the highlighted world-file edit');

    /* ---------- the designer's review: warnings, calibration, fairness, diffs ---------- */
    assert.match(await text('#pl-classify .pl-warning'), /Warning: check this before you trust the classification[\s\S]*Meridian_Ledger\.xlsx: it holds a long passage of the guideline or the golden answer/);
    assert.equal(await evaluate('document.querySelector("#pl-classify .pl-warning").getBoundingClientRect().top < document.querySelector("#pl-classify dl").getBoundingClientRect().top'), true, 'the warning is above the parts of the task');
    assert.match(await text('#pl-classify .card-title'), /1 warning/);
    assert.match(await text('#pl-design'), /Calibration passed\s*The golden answer scored 0\.97 against the revised grader guideline\. It needs 0\.90 or more\./);
    assert.match(await text('#pl-design'), /Fairness review[\s\S]*1 unfair item[\s\S]*The amended date is only in a footnote/);
    assert.match(await text('#pl-design'), /Size change: \+120 bytes/);
    assert.equal(await text('#pl-design .pl-unscanned'), 'The text of these new or edited files could not be checked for guideline or golden-answer passages: Atlas_Scan_Note.pdf (new), Atlas_Facility_Schedule.rtf (edited).');
    assert.equal(await evaluate('[...document.querySelectorAll("#pl-design details.pl-changes, #pl-design details.pl-diff-box")].map(d=>d.open).join()'), 'false,false', 'the guideline changes and the file diff start collapsed');
    assert.equal(await evaluate('document.querySelector("#pl-design details.pl-changes pre").checkVisibility()'), false, 'and their text is not on screen');
    /* open the guideline changes with the keyboard: Enter on the summary */
    await evaluate('document.querySelector("#pl-design details.pl-changes > summary").focus()');
    await press('Enter');
    assert.equal(await evaluate('document.querySelector("#pl-design details.pl-changes").open'), true, 'Enter opens it');
    assert.equal(await evaluate('document.querySelector("#pl-design details.pl-changes pre").checkVisibility()'), true, 'opened, the diff is on screen');
    assert.match(await text('#pl-design details.pl-changes'), /Added a line about the amended facility date[\s\S]*Why: The new trap turns on that date\./);
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#pl-design details.pl-changes .pl-diff-del")).color !== getComputedStyle(document.querySelector("#pl-design details.pl-changes .pl-diff-add")).color'), true, 'added and removed lines differ, and both carry + and - in the text');
    assert.match(await text('#pl-design details.pl-changes .pl-diff-del'), /^-Count the available facility as cash\./);
    assert.match(await text('#pl-design details.pl-changes .pl-diff-add'), /^\+Do not count the available facility as cash\./);
    await click('#pl-design details.pl-diff-box > summary');
    assert.match(await text('#pl-design details.pl-diff-box'), /-Rate,4\.00%[\s\S]*\+Rate,6\.00%/);
    await evaluate('document.querySelector("#pl-classify").scrollIntoView()');
    await shot('03a-warning-1440', 1440, 1000);
    await evaluate('document.querySelector("#pl-design h3:nth-of-type(3)").scrollIntoView()');
    await shot('03b-review-1440', 1440, 1000);
    await evaluate('window.scrollTo(0,0)');
    await viewport(1440, 1000);
    pass('classification warnings sit above the task parts; calibration and the fairness review show in the traps card; the guideline changes and each file diff are collapsed details that open from the keyboard, with diff lines marked by + and - as well as colour');

    /* ---------- a round is running: values are withheld ---------- */
    set({ stage: 'screen', redacted: true, design: design(true) });
    setAttempt({ screen: stageOf('screen', [null, null], null, { 0: { state: 'running', audit: null }, 1: { state: 'running', audit: null } }) });
    await waitFor(stageIs('^Screen: two blind'), 'the screen', POLL_WAIT);
    assert.match(await text('#pl-withheld'), /A round is running, so this page does not show the prompt/);
    await evaluate('document.querySelectorAll("#pl-design details").forEach(d=>{d.open=true;})');
    await delay(60);
    assert.equal(await evaluate('document.querySelector("#pl-design").innerText.split("Withheld while a round runs").length - 1'), 18, 'the trap title and files, the file name, size change, reason and diff, calibration, fairness, the rubric changes and the guideline diff, the correct and wrong value, the prompt, the guideline, the golden answer, the gold and the fingerprints and the unscanned files each say so');
    assert.equal(await evaluate('document.body.innerText.includes("Usable cash is 1,250")'), false, 'the golden answer is not on the page');
    assert.equal(await exists('[data-pl=export]'), false);
    await shot('03-screen-withheld-1440', 1440, 1000);
    pass('while a round runs the withheld fields read "Withheld while a round runs", the notice explains, and the golden answer is nowhere in the page');

    /* ---------- the screen and the test ---------- */
    set({ redacted: false, design: design() });
    setAttempt({ screen: stageOf('screen', [0.31, 0.12], true), test: stageOf('test', [0.1, 0.2, 0.9, 0.3], null, { 3: { state: 'running', score: null, valid: false, belowBar: null, audit: null } }) });
    set({ stage: 'test', spentUsd: 5.2 });
    await waitFor(stageIs('^Test: five blind'), 'the test', POLL_WAIT);
    assert.equal(await count('#pl-screen tbody tr'), 2);
    assert.equal(await text('#pl-screen tbody tr:first-child td:nth-child(2)'), '0.31');
    assert.match(await text('#pl-screen'), /The screen passes when both pilots score below 0\.45\./);
    assert.match(await text('#pl-screen tbody tr:first-child td:nth-child(3)'), /Yes/);
    assert.match(await text('#pl-test'), /The test succeeds when at least 4 of 5 pilots score below 0\.45\./);
    assert.match(await text('#pl-test'), /Test in progress/);
    assert.equal(await count('#pl-test tbody tr'), 4);
    assert.match(await text('#pl-test tbody tr:nth-child(4)'), /Running/);
    /* focus survives polls: park the keyboard on Stop and let two polls go by */
    await evaluate('document.querySelector("[data-pl=stop]").focus()');
    await delay(4600);
    assert.equal(await focused(), 'stop', 'a poll does not take the keyboard away from Stop');
    pass('the screen and test tables show scores to two decimals with yes or no in words; polls repaint without taking focus off Stop');
    await noHorizontalOverflow('tables');
    await shot('04-test-1440', 1440, 1000);
    await shot('04-test-390', 390, 844);
    await viewport(390, 844);
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#pl-screen thead")).position'), 'absolute', 'at phone width the table header folds into labels per cell');
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#pl-bar")).position'), 'sticky', 'the bar with Stop stays in view');
    assert.ok(await evaluate('document.querySelector("#pl-bar").getBoundingClientRect().height') < 160, 'and it stays compact on a phone');
    await viewport(1440, 1000);

    /* ---------- done: result and export ---------- */
    set({ stage: 'done', running: false, spentUsd: 17.4, redesigns: 2, summary: 'The test passed: 4 of 5 pilots scored below 0.45 (design attempt 3). Export the private zip to take the design away.', attempts: [
      attempt({ n: 1, traps: [{ id: 't1', title: 'Rounded inputs rebuilt into a total' }], outcome: 'rejected', rejection: { kind: 'checks', reasons: ['The golden answer scored 0.62 against its own guideline; at least 0.90 is needed'] }, calibration: { score: 0.62, verdict: 'does-not-meet-guidance', reason: 'Missing the date.' }, fairness: { status: 'ok', count: 0 }, repaired: true }),
      attempt({ n: 2, traps: [{ id: 't1', title: 'Rounded inputs rebuilt into a total' }], outcome: 'screen-failed', screen: stageOf('screen', [0.7, 0.3], false), calibration: { score: 0.97, verdict: 'v', reason: 'r' }, fairness: { status: 'ok', count: 0 } }),
      attempt({ n: 3, outcome: 'passed', screen: stageOf('screen', [0.31, 0.12], true), test: stageOf('test', [0.1, 0.2, 0.9, 0.3, 0.44], true), calibration: { score: 0.98, verdict: 'v', reason: 'r' }, fairness: { status: 'ok', count: 0 } })] });
    await waitFor(stageIs('^Done:'), 'done', POLL_WAIT);
    assert.match(await text('#pl-verdict'), /The test passed/);
    assert.match(await text('#pl-verdict'), /The test passed: 4 of 5 pilots scored below 0\.45 \(design attempt 3\)\./);
    assert.match(await text('#pl-redesigns'), /2 of 3 used/);
    assert.match(await text('#pl-redesigns'), /Rejected before any pilot[\s\S]*The design did not pass the calibration or the fairness check\.[\s\S]*The golden answer scored 0\.62 against its own guideline; at least 0\.90 is needed/);
    assert.match(await text('#pl-redesigns'), /Calibration: 0\.62, failed[\s\S]*A repair turn was used/);
    assert.equal(await count('#pl-redesigns tbody tr'), 3);
    assert.ok(!(await text('#pl-verdict')).includes('%') && !(await text('#pl-spend')).includes('%'), 'no percentage in the result or the spend');
    assert.equal(await exists('[data-pl=stop]'), false);
    assert.equal(await exists('[data-pl=export]'), true, 'Export is offered when done');
    assert.equal(await evaluate('document.querySelector("[data-dash-tab=pipeline]").getAttribute("aria-current")'), 'page');
    await click('[data-pl=export]');
    await waitFor('/Downloaded /.test(document.querySelector("#pl-msg").textContent)', 'the export message', 5000);
    assert.ok(posts.some(p => p.url === '/api/pipeline/pl-browser-0001/export' && p.nonce === NONCE));
    const file = path.join(downloads, 'Atlas_review_pipeline_PRIVATE.zip');
    const end = Date.now() + 5000;
    while (!fs.existsSync(file) && Date.now() < end) await delay(100);
    assert.ok(fs.existsSync(file), 'the browser saved the private zip');
    assert.deepEqual(fs.readFileSync(file), ZIP);
    const pollsAfterDone = gets.length;
    await delay(2600);
    assert.equal(gets.length, pollsAfterDone, 'the page stops polling once the pipeline is done');
    await shot('05-done-1440', 1440, 1000);
    await evaluate('document.querySelector("#pl-redesigns").scrollIntoView()');
    await shot('06-redesigns-1440', 1440, 1000);
    await evaluate('document.querySelector("#pl-test").scrollIntoView()');
    await shot('07-test-table-390', 390, 844);
    await evaluate('window.scrollTo(0,0)');
    await viewport(1440, 1000);
    await noHorizontalOverflow('done');
    pass('done shows the result, the redesign table and Export; the export saves the private zip byte for byte; polling stops');

    /* ---------- a second pipeline can be started from the folded form ---------- */
    await click('[data-pl=new]');
    await waitFor('!!document.querySelector("#pl-url")', 'the form to open');
    assert.equal(await focused(), 'url');
    assert.equal(await evaluate('document.querySelector("[data-pl=start]").disabled'), true, 'the acknowledgements are asked for again');
    assert.equal(await count('#pl-start-form input[type=checkbox]:checked'), 0);
    pass('after a run the form opens empty: nothing is ticked and the link field is clear');

    /* ---------- the cap stops the run before the test: the timeline marks Test, with the reason ---------- */
    await evaluate('document.querySelector("#pl-url").focus()');
    await call('Input.insertText', { text: TASK_LINK });
    for (const id of ACK_IDS) await click('#pl-start-form input[data-id="' + id + '"]');
    await click('[data-pl=start]');
    await waitFor(stageIs('^Import:'), 'the second pipeline', 5000);
    assert.equal(posts.filter(p => p.url === '/api/pipeline/start').length, 2, 'a second start was posted');
    set({ stage: 'budget', running: false, spentUsd: 17.4, capUsd: 20, summary: 'Stopped before the test: USD 17.40 spent, the step could cost up to USD 20.70, and the cap is USD 20.00.', result: { verdict: 'budget', message: 'x' } });
    setAttempt({ outcome: 'budget', screen: stageOf('screen', [0.31, 0.12], true), test: null });
    await waitFor(stageIs('^Stopped at the cap'), 'the stop at the cap', POLL_WAIT);
    assert.equal(await text('#pl-stage'), 'Stopped at the cap, in the Test step: the next call would pass the total cap, so it was not started.');
    assert.equal(await evaluate('[...document.querySelectorAll("#pl-timeline .pl-step")].map(li=>li.className.replace("pl-step is-","")).join()'), 'done,done,done,done,stopped,todo', 'Screen is done and Test is where it stopped');
    assert.equal(await evaluate('document.querySelector("#pl-timeline [aria-current=step] strong").textContent'), 'Test');
    assert.equal(await text('#pl-timeline .is-stopped small'), 'Stopped at the cap');
    assert.match(await text('#pl-test'), /Not started[\s\S]*The test was not started: the next call would have passed the total cap of USD 20\.00, and USD 17\.40 was spent\./);
    assert.match(await text('#pl-screen'), /Screen passed/);
    assert.match(await text('#pl-verdict'), /Stopped at the cap[\s\S]*Stopped before the test: USD 17\.40 spent[\s\S]*Stopped in the Test step with USD 17\.40 of USD 20\.00 spent\. To go further, start a new pipeline with a higher total cap\./);
    assert.equal(await exists('[data-pl=stop]'), false);
    await noHorizontalOverflow('stopped at the cap');
    await shot('04b-budget-1440', 1440, 1000);
    await shot('04b-budget-390', 390, 844);
    await viewport(1440, 1000);
    pass('a stop at the cap before the test marks Test as where it stopped, the Test card says it was not started, and the result says why in plain words');

    /* ---------- leaving and coming back ---------- */
    await click('[data-dash-tab="overview"]');
    await waitFor('window.FinanceDashboard.getView()==="overview"', 'the overview');
    const getsAway = gets.length;
    await delay(2600);
    assert.equal(gets.length, getsAway, 'no request while another page shows');
    await click('[data-dash-tab="pipeline"]');
    await waitFor('/^Stopped at the cap/.test(document.querySelector("#pl-stage").textContent)', 'the page to come back with the finished pipeline');
    pass('leaving the page stops its requests, and coming back shows the pipeline again');

    /* ---------- no outside requests, no errors ---------- */
    const outside = requests.filter(u => !u.startsWith(`http://127.0.0.1:${port}/`) && !u.startsWith('data:'));
    assert.deepEqual(outside, [], 'the page only talked to its own origin');
    assert.ok(served.every(r => /^(GET|POST) \/(api\/|index\.html|[a-z-]+\.(js|css)|$)/.test(r)), 'only the page, its assets and /api/ were requested: ' + served.filter(r => !/^(GET|POST) \/(api\/|index\.html|[a-z-]+\.(js|css)|$)/.test(r)).join(', '));
    assert.deepEqual(errors, [], 'console and runtime errors: ' + JSON.stringify(errors));
    pass('no request left the companion origin, nothing but /api/ and the page assets was asked for, zero console errors');

    /* ---------- the offline edition: opened from disk, the page says it needs the companion and makes no request ---------- */
    const entry = process.env.APP_ENTRY || path.join(root, 'index.html');
    const before = requests.length;
    await call(PG + 'navigate', { url: 'file://' + entry });
    await waitFor('document.readyState==="complete"&&!!window.FinanceDashboard&&!!window.FinancePipeline', 'the offline page');
    await delay(300);
    await click('[data-dash-tab="pipeline"]');
    await waitFor('!!document.querySelector("#pl-root .pl-offline")', 'the offline card');
    assert.match(await text('#pl-root'), /The Pipeline needs the companion: run npm start\./);
    assert.equal(await exists('[data-pl=start]'), false, 'nothing can be started from disk');
    await delay(2600);
    assert.deepEqual(requests.slice(before).filter(u => /^https?:/.test(u)), [], 'no HTTP request from the offline edition');
    assert.deepEqual(errors, [], 'console and runtime errors: ' + JSON.stringify(errors));
    pass('opened from disk (' + path.basename(entry) + ') the Pipeline page says it needs the companion, offers nothing and makes no request');

    fs.writeFileSync(path.join(out, 'browser-report.json'), JSON.stringify({ passed: true, checks, requests: served.length, consoleErrors: errors, node: process.version }, null, 2));
    console.log(JSON.stringify({ passed: true, checks }, null, 2));
  } catch (error) {
    console.error(error);
    try { fs.writeFileSync(path.join(out, 'browser-report.json'), JSON.stringify({ passed: false, checks, error: String(error && error.stack || error), errors }, null, 2)); } catch { /* the report is a courtesy */ }
    process.exitCode = 1;
  } finally {
    if (ws) { try { await call('Browser.close'); } catch { /* already closing */ } ws.close(); }
    if (proc) { const gone = proc.exitCode !== null ? Promise.resolve() : new Promise(r => { proc.once('exit', r); setTimeout(r, 4000); }); proc.kill(); await gone; }
    server.close();
    for (const dir of [profile, downloads]) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } catch { /* a leftover temporary folder is harmless */ } }
  }
})();
