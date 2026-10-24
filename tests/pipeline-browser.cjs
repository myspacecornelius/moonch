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
const pilots = (scores, extra = {}) => scores.map((score, i) => ({ n: i + 1, id: 'p' + (i + 1), replacement: false, state: 'completed', audit: { status: 'CLEAN', violationCount: 0 }, score, valid: typeof score === 'number', belowBar: typeof score === 'number' ? score < 0.4 : null, reason: '', ...(extra[i] || {}) }));
const stageOf = (name, scores, passed, extra) => ({ name, bar: name === 'test' ? 0.45 : 0.4, need: name === 'test' ? 4 : 2, of: name === 'test' ? 5 : 2, pilots: pilots(scores, extra), passed });
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
/* the rules GET /api/pipeline reports: the default total cap, both design modes with the parts of their least total cap (1.15 x (20.5 + 7 x (3 + 1.5)) = 59.80 for the new mode at the default pilot cap),
   the diagnostic suite, the review caps and the default reference folder (names only) */
const NEW_MIN = { fixedUsd: 20.5, perPilotUsd: 1.5, pilots: 7, headroom: 1.15 };
const REF_NAMES = ['Atlas_Review_Handbook.md', 'Meridian_Workflow_Catalog.pdf'];
const CONFIG = {
  defaultCapUsd: 60, screenBar: 0.4, testBar: 0.45, headroom: 1.15, designModes: ['new', 'harden'], defaultDesignMode: 'new', alternativeMin: 0.85, fairnessSetCapUsd: 3, minCapFairnessSetUsd: 3,
  minCap: NEW_MIN, minCapByMode: { new: NEW_MIN, harden: { fixedUsd: 8, perPilotUsd: 1, pilots: 7, headroom: 1.15 } },
  blindReviewCapUsd: 1.5, revealReviewCapUsd: 0.5, applicationCapUsd: 0.5, adjudicationCapUsd: 0.5,
  references: { maxFiles: 20, maxBytes: 8388608, extensions: ['.md', '.txt', '.pdf'], default: { exists: true, found: 2, names: REF_NAMES, bytes: 48211, problems: 0 } },
};
/* ---- a full attempt of the new mode, in the shape of backend/pipeline (invented: Atlas and Meridian) ---- */
const COUNTING = new Set(['intended', 'other_valid_error']);
const LOW_KEY = { intended: 'intended', other_valid_error: 'otherValid', permitted_alternative: 'permittedAlternative', grader_defect: 'graderDefect', ambiguous: 'ambiguous', tool_failure: 'toolFailure', unsupported: 'unsupported' };
const adj = klass => ({ class: klass, claimed: klass, counts: COUNTING.has(klass), note: '', application: null });
function explainedStage(name, spec, passed, over = {}) {
  const bar = name === 'test' ? 0.45 : 0.4, extra = {};
  const lows = { lowScorers: 0, intended: 0, otherValid: 0, permittedAlternative: 0, graderDefect: 0, ambiguous: 0, toolFailure: 0, unsupported: 0, counted: 0 }, unexplained = [];
  spec.forEach(([score, klass], i) => {
    const low = typeof score === 'number' && score < bar;
    extra[i] = low && klass ? { adjudication: adj(klass), countsTowardPass: COUNTING.has(klass) } : { adjudication: null, countsTowardPass: low ? null : false };
    if (!low) return;
    lows.lowScorers++;
    if (klass) lows[LOW_KEY[klass]]++;
    if (COUNTING.has(klass)) lows.counted++; else unexplained.push({ pilot: 'p' + (i + 1), class: klass || 'unsupported', score });
  });
  return { ...stageOf(name, spec.map(x => x[0]), passed, extra), explained: lows.counted, lows, unexplained, recount: null, ...over };
}
const TRAP_RULE = 'Leverage is measured on funded debt net of cash held in the blocked account.';
const BRIEF = {
  taskType: { workflow: 'Quarterly covenant review', why: 'The world files hold a facility agreement, a ledger and an amendment that a covenant review can use.', referenceEntries: ['Covenant walkthrough'] },
  decision: { ask: 'Does the Atlas borrower meet its leverage covenant at quarter end?', mandate: 'Advise the credit committee whether a waiver is needed.', authorityFile: 'Atlas_Facility_Agreement.txt', effectiveDate: '2025-01-01', decisionDate: '2025-03-31' },
  files: [{ name: 'Atlas_Facility_Agreement.txt', role: 'authority' }, { name: 'Atlas_Ledger.csv', role: 'evidence' }, { name: 'Meridian_Old_Schedule.csv', role: 'decoy' }],
  traps: [{ id: 't1', primary: true, rule: { file: 'Atlas_Facility_Agreement.txt', clause: TRAP_RULE },
    correctPath: { reasoning: 'Net the blocked cash against funded debt before the ratio.', action: 'Report the covenant as met', figures: [{ label: 'Net leverage', value: 3.4, tolerance: 0.05 }] },
    wrongPath: { reasoning: 'Use gross funded debt, as the ledger line shows it.', action: 'Report the covenant as breached', figures: [{ label: 'Net leverage', value: 4.1, tolerance: 0.05 }] },
    changesDecision: 'required_conclusion', whyTempting: { kind: 'effort', source: 'The ledger has one gross debt line that is quick to use.' }, consequence: { source: 'A breach report triggers the default notice of the amendment.' },
    strongestAlternative: { answer: 'Report the covenant as met and ask for a waiver', whyRejected: 'No waiver is needed while the ratio is inside the limit.' } }],
  permittedAlternatives: [{ answer: 'Report the covenant as met and add a monitoring step', support: 'The agreement lets the committee add monitoring.', file: 'answers/alt-1.md' }], permittedAlternativesReason: '', controls: [], primary: 't1',
};
const CHECK = { pass: true, failed: [], checks: { governs: true, inForce: true, notSuperseded: true, excludes: true }, dates: { effective: '2025-01-01', decision: '2025-03-31' }, hits: 0 };
const FAIRNESS = { status: 'passed', repairs: 0, stage1: { state: 'ok', tries: 1, runs: 1, packetSha256: 'a'.repeat(64), discarded: 0 }, stage2: { disposition: 'excluded_by_clause', objectionClass: 'permitted_discretion', evaluations: 1, application: CHECK, briefApplication: null } };
const ANSWER_SET = { goldenMin: 0.9, alternativeMin: 0.85, passed: true, answers: [
  { name: 'golden', kind: 'golden', file: 'golden-answer.md', threshold: 0.9, sha256: 'b'.repeat(64), score: 0.95, grades: [0.96, 0.94], passed: true, unstable: false, runs: [{ why: 'first grading', grades: [0.96, 0.94], score: 0.95, passed: true, unstable: false }] },
  { name: 'alt-1', kind: 'alternative', file: 'answers/alt-1.md', threshold: 0.85, sha256: 'c'.repeat(64), score: 0.8767, grades: [0.9, 0.8, 0.88], passed: true, unstable: true, runs: [{ why: 'first grading', grades: [0.9, 0.8, 0.88], score: 0.8767, passed: true, unstable: true }] }] };
const FREEZE = { n: 1, at: '2026-10-23T10:20:00.000Z', reason: 'before the pilots', packetSha256: 'd1'.repeat(32), packetFiles: 9, promptSha256: 'e2'.repeat(32), guidelineSha256: 'f3'.repeat(32), goldenSha256: 'a4'.repeat(32), answerSetSha256: 'b5'.repeat(32), answers: [{ name: 'golden', sha256: 'c6'.repeat(32) }], pilot: { model: 'claude-opus-5-5', effort: 'medium', capUsd: 3 }, grader: { model: 'claude-sonnet-5-5', effort: 'medium' }, budget: { totalCapUsd: 60, designCapUsd: 5, pilotCapUsd: 3 } };
const newAttempt = (over = {}) => ({ ...attempt({ n: 1 }), mode: 'new', validation: 'complete', traps: ['Gross debt used for the ratio'], fairness: FAIRNESS, answerSet: ANSWER_SET, calibration: { score: 0.95, verdict: 'meets-guidance', reason: 'Matches every rubric line.' }, freeze: [FREEZE], guidelineRepair: null, diagnostic: null, taskType: BRIEF.taskType,
  difficulty: { status: 'pending', screen: null, test: null }, screen: explainedStage('screen', [[0.2, 'intended'], [0.3, 'other_valid_error']], true),
  test: explainedStage('test', [[0.1, 'intended'], [0.2, 'ambiguous'], [0.3, 'other_valid_error'], [0.8, null], [null, null]], null, {}), ...over });
const newDesign = () => ({ ...design(), traps: [{ id: 't1', title: 'Gross debt used for the ratio', files: ['Atlas_Ledger.csv'], mechanism: 'm', decoy: 'Meridian_Old_Schedule.csv', correctValue: '3.4', wrongValue: '4.1' }], editedFiles: [], unscanned: [], fairness: FAIRNESS, taskType: BRIEF.taskType, brief: BRIEF, alternatives: [{ name: 'alt-1', file: 'answers/alt-1.md', answer: 'Report the covenant as met and add a monitoring step' }], answerSet: ANSWER_SET, freeze: [FREEZE] });
const NEW_REFS = { source: 'default', found: 2, names: REF_NAMES, bytes: 48211, copied: true, files: [], unscanned: ['Meridian_Workflow_Catalog.pdf'], partial: [], scannedChars: 5000, truncated: false };
/* the second review of a design that the checks rejected: a clause that did not apply, files that could not be read, and files the reviewers saw only in part */
const FAILED_STAGE2 = {
  disposition: 'unresolved', objectionClass: 'conflicting_authority', evaluations: 1, cut: ['Atlas_Facility_Agreement.txt', 'Meridian_Long_Ledger.csv'],
  application: { pass: false, failed: ['notSuperseded'], checks: { governs: true, inForce: true, notSuperseded: false, excludes: true }, dates: { effective: '2025-01-01', decision: '2025-03-31' },
    hits: [{ id: 'h1', kind: 'passage', document: 'Atlas_Amendment_2.txt', snippet: 'This amendment replaces the schedule.' }, { id: 'more', kind: 'more', document: '', snippet: '3 more passages of supersession wording were found near the clause and are not listed here' }, { id: 'u1', kind: 'unreadable', document: 'Meridian_Policy_Scan.pdf', snippet: 'x' }],
    unscanned: ['Meridian_Policy_Scan.pdf', 'Atlas_Appendix.xlsx'] },
  briefApplication: { pass: false, count: 4, failures: [{ trap: 1, part: 'rule', failed: ['governs', 'inForce'] }, { trap: 2, part: 'whyRejected', failed: ['notSuperseded'] }], unscanned: ['Meridian_Policy_Scan.pdf'] },
};
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
    const state = { id: 'pl-browser-0001', label: 'Atlas review', stage: 'import', running: true, message: 'Opening the task page', createdAt: new Date().toISOString(), source: { kind: 'url', origin: 'https://tasks.example', path: '/review/atlas-4821' }, capUsd: body.capUsd, config: { acceptMissing: false, screenBar: 0.4, testBar: 0.45, designMode: body.designMode, fairnessSet: body.fairnessSet === true, keepAsWorld: body.keepAsWorld || [] }, spentUsd: 0, pilotCapUsd: body.pilotCapUsd, model: body.model, effort: body.effort, redesigns: 0, waiting: null, import: null, classification: null, design: null, attempts: [], result: null, summary: '', error: null };
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
/* One row of the redesign table: the text of each cell under its own column (attempt, Traps, Screen, Test, Outcome, Design checks), so a result in the wrong column fails. */
const redesignRow = n => evaluate(`(()=>{const tr=document.querySelectorAll("#pl-redesigns tbody tr")[${n}];return tr?Object.fromEntries([...tr.children].map(c=>[c.getAttribute("data-label")||"attempt",c.innerText.replace(/\\s+/g," ").trim()])):null})()`);
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
async function noOverflowAtPhone(label) {
  for (const [w, h] of [[390, 844], [320, 640]]) {
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
    assert.equal(await evaluate('document.querySelector("#pl-cap").value'), '60', 'the companion\'s default total cap');
    assert.equal(await text('#pl-cap-min'), 'If the screen passes, one full attempt (screen and test) can cost up to USD 59.80. The reviews and the adjudication of low scores are part of every attempt.', 'the default total cap pays for it: no warning');
    assert.equal(await count('#pl-start-form input[data-pl-in=ack]'), 4);
    assert.equal(await count('#pl-start-form input[type=checkbox]'), 6, 'the four acknowledgements, the withheld-files choice and the diagnostic answers');
    /* the design mode and the fields of the new mode */
    assert.equal(await evaluate('[...document.querySelectorAll("#pl-start-form select[data-pl-in=designMode] option")].map(o=>o.textContent+(o.selected?"*":"")).join("|")'), 'New task from the world files*|Harden the existing task');
    assert.equal(await text('#pl-refs'), 'Reference documents: 2 files found in the default folder (Atlas_Review_Handbook.md, Meridian_Workflow_Catalog.pdf). The designer and the reviewers read them and their text is sent to Anthropic. Pilots never see them.');
    assert.match(await text('#pl-keep-hint'), /^Warning: the pilots get these files, and so does the designer, even if the names look like answers or grading material\./);
    assert.match(await text('.pl-fairness-set'), /^Also run the diagnostic answers \(adds up to USD 3\.00 per attempt\)/);
    await evaluate('(()=>{const s=document.querySelector("#pl-start-form select[data-pl-in=designMode]");s.value="harden";s.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await waitFor('!document.querySelector("#pl-keep")', 'the harden mode to hide the fields of the new mode');
    assert.equal(await exists('#pl-refs'), false);
    assert.equal(await exists('.pl-fairness-set'), false);
    assert.equal(await count('#pl-start-form input[type=checkbox]'), 5);
    assert.equal(await text('#pl-cap-min'), 'If the screen passes, one full attempt (screen and test) can cost up to USD 41.40. The fairness review is part of every attempt.', 'the harden mode has its own figure');
    assert.equal(await focused(), 'design-mode', 'the keyboard stays on the choice');
    await evaluate('(()=>{const s=document.querySelector("#pl-start-form select[data-pl-in=designMode]");s.value="new";s.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await waitFor('!!document.querySelector("#pl-keep")', 'the fields of the new mode to come back');
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
    /* the least total cap, typed live: the figure follows the pilot cap and the diagnostic switch, and a total cap below it warns and does not block */
    const SENT = ' The reviews and the adjudication of low scores are part of every attempt.';
    await evaluate('document.querySelector("#pl-cap").focus();document.querySelector("#pl-cap").select()');
    await call('Input.insertText', { text: '40' });
    await delay(80);
    assert.equal(await text('#pl-cap-min'), 'If the screen passes, one full attempt (screen and test) can cost up to USD 59.80.' + SENT + ' With this total cap the run may stop at the cap before the 5-pilot test.');
    assert.doesNotMatch(await text('#pl-why'), /at least USD/, 'a low total cap warns and does not block');
    await evaluate('document.querySelector("#pl-cap").select()');
    await call('Input.insertText', { text: '60' });
    await delay(80);
    assert.equal(await text('#pl-cap-min'), 'If the screen passes, one full attempt (screen and test) can cost up to USD 59.80.' + SENT);
    await click('#pl-start-form input[data-pl-in=fairnessSet]');
    await delay(80);
    assert.equal(await text('#pl-cap-min'), 'If the screen passes, one full attempt (screen and test) can cost up to USD 63.25.' + SENT + ' With this total cap the run may stop at the cap before the 5-pilot test.', 'the diagnostic answers go over the default total cap of 60');
    await click('#pl-start-form input[data-pl-in=fairnessSet]');
    await evaluate('document.querySelector("#pl-pilot-cap").focus();document.querySelector("#pl-pilot-cap").select()');
    await call('Input.insertText', { text: '5' });
    await delay(80);
    assert.match(await text('#pl-cap-min'), /^If the screen passes, one full attempt \(screen and test\) can cost up to USD 75\.90\./, 'the figure follows the pilot cap as it is typed');
    assert.match(await text('#pl-cap-min'), /USD 75\.90\. The reviews and the adjudication of low scores are part of every attempt\. With this total cap the run may stop/, 'and warns while the total cap is below it');
    assert.equal(await evaluate('document.querySelector("#pl-cap").getAttribute("aria-describedby")'), 'pl-cap-hint pl-cap-min');
    await evaluate('document.querySelector("#pl-pilot-cap").select()');
    await call('Input.insertText', { text: '3' });
    await delay(80);
    assert.equal(await text('#pl-cap-min'), 'If the screen passes, one full attempt (screen and test) can cost up to USD 59.80.' + SENT);
    assert.match(await text('#pl-why'), /Tick all four acknowledgements/, 'a cap that covers it: the next reason is the acknowledgements');
    /* the files to keep as world files, typed into the field */
    await evaluate('document.querySelector("#pl-keep").focus()');
    await call('Input.insertText', { text: 'Atlas_Parent_Answer.xlsx, Meridian_Notes.txt' });
    await delay(80);
    await shot('01b-min-cap-1440', 1440, 1000);
    await shot('01c-new-mode-390', 390, 844);
    await viewport(1440, 1000);
    await evaluate('document.querySelector("#pl-url").focus()');
    const order = [];
    for (let i = 0; i < 9; i++) { await press('Tab'); order.push(await focused()); }
    assert.deepEqual(order, ['design-mode', 'cap', 'model', 'effort', 'pilot-cap', 'keep-as-world', 'fairness-set', 'accept-missing', 'ack-shell-access'], 'Tab walks the fields in reading order');
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
    assert.deepEqual(start.body, { url: TASK_LINK, capUsd: 60, model: 'claude-opus-5-5', effort: 'medium', pilotCapUsd: 3, acceptMissing: false, designMode: 'new', keepAsWorld: ['Atlas_Parent_Answer.xlsx', 'Meridian_Notes.txt'], acknowledgements: ACK_IDS });
    assert.equal(posts.filter(p => p.url === '/api/pipeline/start').length, 1);
    assert.equal(await focused(), 'pl-stage', 'the keyboard moves to the stage line');
    assert.equal(await evaluate('document.body.innerHTML.includes("SECRET-TOKEN-123")'), false, 'the link is nowhere in the page');
    assert.equal(await exists('[data-pl=start]'), false);
    assert.match(await text('#pl-start-form'), /A pipeline is running/);
    assert.equal(await exists('[data-pl=stop]'), true, 'Stop is visible while it runs');
    assert.match(await text('#pl-spend'), /Spent USD 0\.00 of USD 60\.00/);
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

    /* ---------- the owner checks the fetched files against the task page (waiting kind confirm-files) ---------- */
    const FETCHED = Array.from({ length: 40 }, (_, i) => ({ name: 'Atlas_File_' + String(i + 1).padStart(2, '0') + ['.csv', '.txt', '.xlsx'][i % 3], group: i < 25 ? 'World files' : 'Task files', bytes: 1000 + i }));
    const CONFIRM_NOTES = ['The file list stopped at the 200 file cap.', 'A second page of files was not followed.', 'A frame on the page could not be read.'];
    const continuesBefore = posts.filter(p => p.url.endsWith('/continue')).length;
    set({
      import: { fileCount: 40, page: { origin: 'https://tasks.example', path: '/review/atlas-4821' }, toggle: { found: true, label: 'Show all files', flipped: true, filesBefore: 4, filesAfter: 40, learned: false },
        skipped: [{ name: 'Atlas_Thumbs.db', why: 'a system file' }, { name: 'Atlas_Archive_2019.zip', why: 'larger than the size cap' }], files: FETCHED, notes: CONFIRM_NOTES,
        keepAsWorld: [{ name: 'Atlas_Parent_Answer.xlsx', present: true, warning: 'its name looks like an answer or grading material (a file named like an answer), and it goes to the designer and the pilots as a world file' }, { name: 'Meridian_Notes.txt', present: false, warning: 'the task has no file by this name' }] },
      waiting: { kind: 'confirm-files', message: '40 files were fetched. Compare them with the files listed on the task page, then press Continue.', since: new Date().toISOString() },
    });
    await waitFor(stageIs('^Waiting for you: check the files$'), 'the confirm-files wait', POLL_WAIT);
    assert.equal(await text('#pl-wait h2'), 'Check the files');
    assert.match(await text('#pl-wait .pl-wait-message'), /^40 files were fetched\. Compare them with the files listed on the task page/);
    assert.equal(await count('#pl-wait .pl-files li'), 40, 'every fetched file is listed');
    assert.match(await text('#pl-wait .pl-files li:first-child'), /Atlas_File_01\.csv\s+World files/);
    assert.match(await text('#pl-wait .pl-files li:last-child'), /Atlas_File_40\.csv\s+Task files/);
    assert.equal(await text('#pl-wait .pl-notes li:nth-child(3)'), 'A frame on the page could not be read.');
    assert.equal(await count('#pl-wait .pl-notes li'), 3, 'the three notes');
    assert.match(await text('#pl-wait .pl-notes'), /The loader could not fully cover these places/);
    assert.equal(await evaluate('document.querySelector("#pl-wait .pl-notes").getBoundingClientRect().top < document.querySelector("#pl-wait .pl-files-box").getBoundingClientRect().top'), true, 'the notes come before the files');
    /* the files the owner asked to keep as world files, with the companion's warning */
    assert.equal(await text('#pl-wait .pl-kept strong'), 'You asked to keep 2 files as world files');
    assert.match(await text('#pl-wait .pl-kept'), /The designer and the pilots get these files, even if the name looks like an answer or grading material\./);
    assert.match(await text('#pl-wait .pl-kept li:nth-child(1)'), /^Atlas_Parent_Answer\.xlsx\s+its name looks like an answer or grading material[\s\S]*goes to the designer and the pilots as a world file$/);
    assert.match(await text('#pl-wait .pl-kept li:nth-child(2)'), /^Meridian_Notes\.txt\s+the task has no file by this name\s+Not among the files that were fetched\.$/);
    assert.equal(await evaluate('document.querySelector("#pl-wait .pl-kept").getBoundingClientRect().top < document.querySelector("#pl-wait .pl-files-box").getBoundingClientRect().top'), true, 'the warning comes before the list of files');
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#pl-wait .pl-kept")).borderLeftColor!==getComputedStyle(document.querySelector("#pl-wait .pl-files-box")).borderLeftColor'), true, 'and it is marked as a warning');
    assert.match(await text('#pl-import .pl-kept'), /You asked to keep 2 files as world files/, 'the import card shows it too');
    assert.match(await text('#pl-wait'), /Skipped \(2\)[\s\S]*Atlas_Thumbs\.db\s+a system file[\s\S]*Atlas_Archive_2019\.zip\s+larger than the size cap/);
    assert.match(await text('#pl-wait'), /Show all files[\s\S]*Found and turned on \(\u201CShow all files\u201D\)\. 4 files offered before, 40 after\./);
    assert.equal(await evaluate('[...document.querySelectorAll("#pl-wait .pl-confirm-actions button")].map(b=>b.textContent.trim()).join("|")'), 'Every file is there: continue|Stop');
    assert.deepEqual(await yellowButtons(), [], 'no yellow button here: the only yellow one is Approve and start');
    assert.equal(await evaluate('(()=>{const b=document.querySelector("#pl-wait .pl-files-box");return b.scrollHeight>b.clientHeight&&getComputedStyle(b).overflowY==="auto"&&b.clientHeight<=Math.ceil(parseFloat(getComputedStyle(document.documentElement).fontSize)*15.5)})()'), true, 'a long list scrolls inside its box, which stays short');
    assert.equal(await evaluate('document.querySelector("#pl-wait .pl-files-box").getAttribute("tabindex")'), '0', 'and the box can be scrolled from the keyboard');
    assert.match(await text('#pl-import .pl-notes'), /A frame on the page could not be read\./, 'the notes are in the import card too');
    await evaluate('document.querySelector("#pl-wait .pl-files-box").focus()');
    assert.equal(await evaluate('document.activeElement.className'), 'pl-files-box');
    await press('Tab');
    assert.equal(await focused(), 'continue', 'Tab leaves the list for the Continue button');
    await press('Tab');
    assert.equal(await focused(), 'wait-stop', 'then Stop');
    await shot('02c-confirm-1440', 1440, 1000);
    for (const [w, h] of [[390, 844], [320, 640]]) {
      await viewport(w, h);
      const o = await overflow();
      assert.ok(o.scroll <= o.inner, `check the files: horizontal overflow at ${w}x${h}: scrollWidth ${o.scroll} > ${o.inner}`);
      const rects = await evaluate('JSON.stringify([...document.querySelectorAll("#pl-wait .pl-confirm-actions button")].map(b=>{const r=b.getBoundingClientRect();return [Math.round(r.left),Math.round(r.right),Math.round(r.width),Math.round(r.height)]}))');
      assert.equal(JSON.parse(rects).every(([l, r, bw, bh]) => l >= 0 && r <= w && bw >= 44 && bh >= 36), true, 'both buttons fit and are big enough to press at ' + w + ': ' + rects);
      assert.equal(await evaluate('(()=>{const r=document.querySelector("#pl-wait .pl-files-box").getBoundingClientRect();return r.left>=0&&r.right<=window.innerWidth})()'), true, 'the file list fits at ' + w);
    }
    await viewport(390, 844);
    await evaluate('document.querySelector("#pl-wait").scrollIntoView()');
    await shot('02c-confirm-390', 390, 844);
    await noHorizontalOverflow('check the files');
    await evaluate('document.querySelector("[data-pl=continue]").focus()');
    await press('Enter');
    await waitFor('!document.querySelector("#pl-wait [data-pl=continue]")', 'the confirm wait to end', 5000);
    assert.equal(posts.filter(p => p.url.endsWith('/continue')).length, continuesBefore + 1, 'one more continue was posted');
    pass('the confirm-files wait shows "Check the files": the message, three notes above the list, 40 files with groups in a scrolling box, the skipped files, the toggle result, and two buttons that fit a phone and work from the keyboard');

    /* ---------- classify, design ---------- */
    set({ stage: 'classify', message: 'Classifying what was captured', spentUsd: 0.4, import: { fileCount: 9, page: { origin: 'https://tasks.example', path: '/review/atlas-4821' }, toggle: { found: true, label: 'Show all files', flipped: true, filesBefore: 4, filesAfter: 9, learned: false }, skipped: [], files: [], notes: ['A frame on the page could not be read.'], facts: { world: 5, task: 3, withheld: 2, other: 1 } } });
    await waitFor(stageIs('^Classify:'), 'classify', POLL_WAIT);
    assert.match(await text('#pl-import'), /9 files in all · 5 world · 3 task · 2 withheld · 1 other/);
    assert.match(await text('#pl-import'), /Found and turned on \(“Show all files”\)\. 4 files offered before, 9 after\./);
    assert.match(await text('#pl-spend'), /USD 0\.40 of USD 60\.00/);
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

    /* ---------- the new mode while a round runs: what the companion's own redaction leaves of a full attempt ---------- */
    {
      const { redactPipelineData } = require(path.join(root, 'backend', 'pipeline', 'redact.cjs'));
      const [id, state] = [...pipelines][0];
      const running = { ...state, redacted: false, stage: 'screen', design: newDesign(), references: NEW_REFS, config: { ...state.config, designMode: 'new' }, attempts: [newAttempt({ outcome: 'in-progress', test: null, screen: explainedStage('screen', [[0.2, 'intended'], [null, null]], null) })] };
      pipelines.set(id, redactPipelineData(JSON.parse(JSON.stringify(running))));
      await waitFor('/Withheld while a round runs/.test((document.querySelector("#pl-brief")||{}).innerText||"")', 'the new mode while a round runs', POLL_WAIT);
      const gone = await evaluate('(()=>{const t=document.body.innerText;return ["Quarterly covenant review","Atlas_Facility_Agreement","Report the covenant","Net the blocked cash","breached","Usable cash is 1,250"].filter(x=>t.includes(x))})()');
      assert.deepEqual(gone, [], 'nothing of the brief, the golden answer or the paths is on the page while a round runs');
      assert.equal(await text('#pl-brief .pl-withheld'), 'Withheld while a round runs');
      assert.match(await text('#pl-design .pl-task-type'), /^Task type: Withheld while a round runs$/);
      assert.match(await text('#pl-design .pl-refs-summary'), /^Reference documents used: 2 files \(Withheld while a round runs\)\. Pilots never see them\. Not checked for leaked passages: Withheld while a round runs/);
      assert.deepEqual(await evaluate('[...document.querySelectorAll("#pl-checks h3")].map(h=>h.textContent)'), ['Fairness: could another answer be better supported?', 'Difficulty: do the pilots fail for the intended reason?', 'Answer set: can the guideline grade the fixed answers?', 'Guideline repair', 'Diagnostic answers', 'Freeze records'], 'a repair or a diagnostic that may exist is withheld, not left out');
      assert.equal(await evaluate('[...document.querySelectorAll("#pl-checks .pl-withheld")].length >= 3'), true, 'the fairness, the answer set and the counts are withheld');
      assert.match(await text('#pl-checks .card-title'), /Checks complete/, 'that the checks finished is not private');
      assert.match(await text('#pl-screen .pl-lows'), /^Counts by class: Withheld while a round runs$/);
      assert.match(await text('#pl-screen tbody tr:first-child td:nth-child(4)'), /Counts\s+Withheld while a round runs/, 'whether a pilot counts shows, the diagnosis does not');
      await noHorizontalOverflow('the new mode withheld');
      await noOverflowAtPhone('the new mode withheld');
      await shot('03c-new-withheld-1440', 1440, 1000);
      pipelines.set(id, { ...pipelines.get(id), attempts: [], references: null, redacted: false });
    }

    /* ---------- the screen and the test ---------- */
    set({ redacted: false, design: design() });
    setAttempt({ screen: stageOf('screen', [0.31, 0.12], true), test: stageOf('test', [0.1, 0.2, 0.9, 0.3], null, { 3: { state: 'running', score: null, valid: false, belowBar: null, audit: null } }) });
    set({ stage: 'test', spentUsd: 5.2 });
    await waitFor(stageIs('^Test: five blind'), 'the test', POLL_WAIT);
    assert.equal(await count('#pl-screen tbody tr'), 2);
    assert.equal(await text('#pl-screen tbody tr:first-child td:nth-child(2)'), '0.31');
    assert.match(await text('#pl-screen'), /The screen passes when both pilots score below 0\.40\./);
    assert.equal(await text('#pl-screen thead th:nth-child(3)'), 'Below 0.40', 'the screen\'s column is its own bar');
    assert.equal(await text('#pl-test thead th:nth-child(3)'), 'Below 0.45', 'and the test\'s column is the test\'s');
    assert.equal(await text('#pl-stage'), 'Test: five blind pilots are working (4 of 5 must score below 0.45).');
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

    /* ---------- a round stops as soon as its result is decided: the pilots that are no longer needed are not failures ---------- */
    const notNeeded = (kind, after) => ({ state: 'cancelled', score: null, valid: false, belowBar: null, audit: null, stoppedEarly: true, stoppedReason: `Not graded: the ${kind} was already decided after pilot ${after}.` });
    /* the screen: pilot 1 scored 0.62, so pilot 2 was stopped and the designer starts again */
    setAttempt({ outcome: 'screen-failed', screen: { ...stageOf('screen', [0.62, null], false, { 1: notNeeded('screen', 1) }), stoppedEarly: { afterPilot: 1, score: 0.62 } }, test: null });
    set({ stage: 'redesign', redesigns: 1 });
    await waitFor('/Stopped after pilot 1/.test((document.querySelector("#pl-screen")||{}).innerText||"")', 'the screen that stopped early', POLL_WAIT);
    assert.equal(await text('#pl-screen .pl-early-stop'), 'Stopped after pilot 1 scored 0.62: the screen cannot pass.');
    assert.match(await text('#pl-screen .card-title'), /Screen failed/);
    assert.equal(await text('#pl-screen tbody tr:nth-child(2) td:nth-child(2)'), 'Stopped: not needed\nNot graded: the screen was already decided after pilot 1.');
    assert.equal(await text('#pl-screen tbody tr:nth-child(2) td:nth-child(3)'), 'Not needed');
    assert.equal(await text('#pl-screen tbody tr:nth-child(2) td:nth-child(4)'), 'Not needed', 'the column of the count toward the pass');
    assert.equal(await text('#pl-screen tbody tr:nth-child(2) td:nth-child(5)'), 'Not needed', 'and the audit column');
    assert.equal(await evaluate('document.querySelector("#pl-screen thead th:nth-child(4)").textContent'), 'Counts toward the pass');
    assert.match(await text('#pl-screen tbody tr:nth-child(1) td:nth-child(3)'), /No/);
    assert.equal(await evaluate('document.querySelector("#pl-screen tbody tr:nth-child(2) .pill").className'), 'pill ', 'the audit badge is plain: neither amber nor red');
    assert.equal(await evaluate('document.querySelectorAll("#pl-screen .pill.amber, #pl-screen .pill.red").length'), 1, 'only the Screen failed pill is red, and it comes with its words');
    const screenRow = await redesignRow(0);
    assert.equal(screenRow.attempt, 'Attempt 1 (latest)');
    assert.equal(screenRow.Screen, 'Failed (0.62, not needed)', 'the screen column holds the screen result');
    assert.equal(screenRow.Test, 'Not run', 'the test column holds none');
    assert.equal(screenRow.Outcome, 'Screen failed');
    assert.ok(!/not needed|0\.62/.test(screenRow.Test + '|' + screenRow.Outcome), 'the screen result is in no other column');
    await noHorizontalOverflow('screen stopped early');
    await shot('04c-screen-stopped-1440', 1440, 1000);
    await viewport(390, 844);
    await evaluate('document.querySelector("#pl-screen").scrollIntoView()');
    await shot('04c-screen-stopped-390', 390, 844);
    assert.equal(await evaluate('document.querySelector("#pl-screen .pl-stopped-reason").getBoundingClientRect().right <= window.innerWidth'), true, 'the reason fits a phone');
    await viewport(1440, 1000);
    /* the test: pilots 1 and 3 scored 0.45 or more, so 4 and 5 were stopped (the test cannot reach 4 of 5) */
    setAttempt({ outcome: 'test-failed', screen: stageOf('screen', [0.31, 0.12], true), test: { ...stageOf('test', [0.2, 0.71, 0.45, null, null], false, { 3: notNeeded('test', 3), 4: notNeeded('test', 3) }), stoppedEarly: { afterPilot: 3, score: 0.45 } } });
    await waitFor('/Stopped after pilot 3/.test((document.querySelector("#pl-test")||{}).innerText||"")', 'the test that stopped early', POLL_WAIT);
    assert.equal(await text('#pl-test .pl-early-stop'), 'Stopped after pilot 3 scored 0.45: the test cannot pass.');
    assert.match(await text('#pl-test .card-title'), /Test failed/);
    assert.equal(await count('#pl-test tbody tr'), 5);
    assert.equal(await evaluate('[...document.querySelectorAll("#pl-test tbody tr")].map(r=>r.children[2].innerText.trim()).join("|")'), '✓ Yes|✕ No|✕ No|Not needed|Not needed', 'the column of the test bar: 0.45 itself is not below it');
    assert.equal(await count('#pl-test .pl-stopped-reason'), 2);
    assert.match(await text('#pl-test .pl-stopped-reason'), /^Not graded: the test was already decided after pilot 3\./);
    assert.equal(await text('#pl-test thead th:nth-child(3)'), 'Below 0.45');
    assert.equal(await text('#pl-screen thead th:nth-child(3)'), 'Below 0.40', 'both bars at once');
    const testRow = await redesignRow(0);
    assert.equal(testRow.Screen, 'Passed (0.31, 0.12)', 'the screen column holds the screen result');
    assert.equal(testRow.Test, 'Failed (0.20, 0.71, 0.45, not needed, not needed)', 'the test column holds the test result');
    assert.equal(testRow.Outcome, 'Test failed');
    assert.ok(!/not needed|0\.71|0\.45/.test(testRow.Screen + '|' + testRow.Outcome), 'the test result is in no other column');
    assert.ok(!/Passed|0\.31/.test(testRow.Test + '|' + testRow.Outcome), 'the screen result is in no other column');
    await noHorizontalOverflow('test stopped early');
    await shot('04d-test-stopped-1440', 1440, 1000);
    await viewport(390, 844);
    await evaluate('document.querySelector("#pl-test").scrollIntoView()');
    await shot('04d-test-stopped-390', 390, 844);
    await viewport(1440, 1000);
    pass('the two bars show in their own stage (below 0.40 for the screen, below 0.45 for the test); a screen stopped after pilot 1 and a test stopped after 2 pilots at or above the bar show the pilots that were not needed as "Stopped: not needed" with their reason, and the stage says why it stopped');

    /* ---------- a full attempt of the new mode: the brief, fairness and difficulty apart, the answer set, the freeze, and which low scores count ---------- */
    set({ stage: 'test', running: true, redacted: false, redesigns: 0, summary: '', result: null, design: newDesign(), references: { ...NEW_REFS, partial: ['Atlas_Review_Handbook.md'], truncated: true },
      attempts: [newAttempt({ difficulty: { status: 'pending', screen: { passed: true, explained: 2, belowBar: 2, of: 2, need: 2, lows: explainedStage('screen', [[0.2, 'intended'], [0.3, 'other_valid_error']], true).lows }, test: null } })] });
    await waitFor(stageIs('^Test: five blind'), 'the new mode attempt', POLL_WAIT);
    await waitFor('!!document.querySelector("#pl-brief .pl-brief-table")', 'the brief');
    assert.match(await text('#pl-design .pl-task-type'), /^Task type: Quarterly covenant review\. Why: The world files hold/);
    assert.equal(await text('#pl-design .pl-refs-summary'), 'Reference documents used: 2 files (Atlas_Review_Handbook.md, Meridian_Workflow_Catalog.pdf). Pilots never see them. Checked for leaked passages only in part: Atlas_Review_Handbook.md. Not checked for leaked passages (their text could not be read, or the scan cap left them out): Meridian_Workflow_Catalog.pdf.');
    assert.equal(await text('#pl-brief .pl-brief-decision dt:last-of-type'), 'Decision date');
    assert.equal(await text('#pl-brief .pl-brief-decision dd:last-of-type'), '2025-03-31');
    assert.equal(await text('#pl-brief h2'), 'What the traps rest on');
    assert.equal(await evaluate('[...document.querySelectorAll("#pl-brief thead th")].map(h=>h.textContent).join("|")'), 'Trap|Rule|Correct path|Wrong path|Why it is tempting|Strongest alternative');
    const brief = JSON.parse(await evaluate('JSON.stringify(Object.fromEntries([...document.querySelectorAll("#pl-brief tbody tr:first-child td")].map(c=>[c.getAttribute("data-label"),c.innerText.replace(/\\s+/g," ").trim()])))'));
    assert.ok(brief.Rule.includes('Atlas_Facility_Agreement.txt') && brief.Rule.includes(TRAP_RULE), 'the rule and its clause are in the rule column');
    assert.ok(brief['Correct path'].includes('Report the covenant as met') && brief['Correct path'].includes('3.4') && !/breached|4\.1/.test(brief['Correct path']), 'the correct path is in its own column');
    assert.ok(brief['Wrong path'].includes('Report the covenant as breached') && brief['Wrong path'].includes('4.1') && !brief['Wrong path'].includes('Report the covenant as met'), 'and the wrong path in its own');
    assert.ok(brief['Why it is tempting'].startsWith('effort') && brief['Why it is tempting'].includes('What it costs'), 'why it is tempting');
    assert.ok(brief['Strongest alternative'].includes('ask for a waiver') && brief['Strongest alternative'].includes('Ruled out by: No waiver is needed'), 'the strongest alternative and the clause that rules it out');
    assert.equal(await text('#pl-brief .pl-alt-score'), 'Its answer scored 0.88 against the guideline (it needs 0.85), and the grades were unstable.');
    /* fairness and difficulty: two headings, two lists, each with its own words */
    assert.deepEqual(await evaluate('[...document.querySelectorAll("#pl-checks h3")].map(h=>h.textContent)'), ['Fairness: could another answer be better supported?', 'Difficulty: do the pilots fail for the intended reason?', 'Answer set: can the guideline grade the fixed answers?', 'Freeze records']);
    const fairText = await text('#pl-checks .pl-review'), diffText = await text('#pl-checks .pl-difficulty');
    assert.match(fairText, /Blind review: a reader with only the prompt and the files gave an answer \(1 try\)\./);
    assert.match(fairText, /Second review: the other answer is ruled out by a clause of the files \(objection: permitted discretion\)\./);
    assert.match(fairText, /Application check of the clause that rules the other answer out: passed\./);
    assert.ok(!/Screen|Test|pilot/.test(fairText), 'no pilot result in the fairness list');
    assert.match(diffText, /^Screen: passed\. 2 of 2 below 0\.40; 2 count toward the pass \(2 needed\)\./);
    assert.match(diffText, /Test: not run\.$/);
    assert.ok(!/review|clause/i.test(diffText), 'no review in the difficulty list');
    assert.equal(await evaluate('document.querySelector("#pl-checks .pl-unstable").checkVisibility()'), true, 'the unstable grade is marked where it can be seen');
    assert.match(await text('#pl-checks .pl-unstable'), /^Unstable: the grades fell on both sides of the line, so a third grade decided\. All grades: 0\.90, 0\.80, 0\.88\.$/);
    const answers = JSON.parse(await evaluate('JSON.stringify([...document.querySelectorAll("#pl-checks .pl-answers tbody tr")].map(r=>Object.fromEntries([["row",r.querySelector("th").innerText.replace(/\\s+/g," ").trim()],...[...r.querySelectorAll("td")].map(c=>[c.getAttribute("data-label"),c.innerText.replace(/\\s+/g," ").trim()])])))'));
    assert.deepEqual(answers.map(a => [a.row, a.Needs, a.Grades, a.Score]), [['Golden answer', '0.90', '0.96, 0.94', '0.95'], ['Permitted alternative alt-1', '0.85', '0.90, 0.80, 0.88', '0.88']]);
    assert.ok(!answers[0].Result.includes('Unstable') && answers[1].Result.includes('Unstable'), 'only the unstable answer is marked');
    assert.match(await text('#pl-checks .pl-freeze li:first-child'), /^Freeze 1 \(before the pilots\)[\s\S]*Packet d1d1d1d1d1d1 \(9 files\); prompt e2e2e2e2e2e2; guideline f3f3f3f3f3f3; golden answer a4a4a4a4a4a4; answer set b5b5b5b5b5b5\./);
    /* a design the checks rejected: the checks of the brief's clauses by trap, a file that could not be read, and the files the reviewers saw in part */
    setAttempt({ fairness: { ...FAIRNESS, status: 'rejected', stage2: FAILED_STAGE2 } });
    await waitFor('/Trap 2, why the alternative is rejected/.test((document.querySelector("#pl-checks")||{}).innerText||"")', 'the failed checks', POLL_WAIT);
    const items = JSON.parse(await evaluate('JSON.stringify([...document.querySelectorAll("#pl-checks .pl-review > li")].map(li=>li.innerText.replace(/\\s+/g," ").trim()))'));
    assert.equal(items.length, 4, 'the blind review, the second review and one line for each check');
    const app = items.find(x => x.startsWith('Application check of the clause that rules the other answer out')), brf = items.find(x => x.startsWith('Application check of the clauses the brief rests on'));
    assert.match(app, /^Application check of the clause that rules the other answer out: failed\. it may be superseded\. In force from 2025-01-01; decision on 2025-03-31\. 1 place in the files mentions a change of a document\./);
    assert.ok(app.includes('Meridian_Policy_Scan.pdf: This file could not be read as text, so it could not be checked for a later document that replaces it.'));
    assert.ok(app.includes('More passages were found than are shown here (3 more).'));
    assert.ok(app.includes('These files could not be read as text, so they could not be checked for a later document that replaces the clause: Atlas_Appendix.xlsx.'));
    assert.ok(brf.startsWith('Application check of the clauses the brief rests on: failed. 4 checks made.'), brf);
    assert.ok(brf.includes('Trap 1, the rule clause: it does not govern this decision; it is not shown to be in force.') && brf.includes('Trap 2, why the alternative is rejected: it may be superseded.'));
    assert.ok(!app.includes('Trap 1') && !brf.includes('More passages'), 'each failure is under its own check');
    assert.equal(await text('#pl-checks .pl-cut'), 'The reviewers saw these files only in part: Atlas_Facility_Agreement.txt, Meridian_Long_Ledger.csv.');
    assert.equal(await evaluate('document.querySelectorAll("#pl-checks .pl-hit-unreadable").length'), 1);
    await noOverflowAtPhone('the failed checks');
    await shot('03g-new-failed-checks-1440', 1440, 1000);
    await viewport(390, 844);
    await evaluate('document.querySelector("#pl-checks .pl-review").scrollIntoView()');
    await shot('03g-new-failed-checks-390', 390, 844);
    await viewport(1440, 1000);
    setAttempt({ fairness: FAIRNESS });
    await waitFor('!/Trap 2, why the alternative is rejected/.test((document.querySelector("#pl-checks")||{}).innerText||"")', 'the passing checks again', POLL_WAIT);
    /* the pilots of the test: which low scores count, and the ones that do not are marked with their diagnosis */
    const counts = JSON.parse(await evaluate('JSON.stringify([...document.querySelectorAll("#pl-test tbody tr")].map(r=>r.querySelector("td[data-label=\\"Counts toward the pass\\"]").innerText.replace(/\\s+/g," ").trim()))'));
    assert.deepEqual(counts, ['\u2713 Counts Diagnosis: the intended error', '! Low score that does not count Diagnosis: ambiguous', '\u2713 Counts Diagnosis: another valid error', 'Does not count: the score is not below 0.45', 'Waiting for a score']);
    assert.equal(await count('#pl-test .pl-nocount'), 1);
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#pl-test .pl-nocount")).color!==getComputedStyle(document.querySelector("#pl-test .pl-counts")).color'), true, 'a counting pilot and one that does not look different, and each has its words');
    assert.equal(await text('#pl-test .pl-unexplained li'), 'Pilot 2 scored 0.20: ambiguous');
    assert.match(await text('#pl-test .pl-lows'), /^Low scores: 3\. By diagnosis: 1 intended, 1 another valid error, 0 permitted alternative, 0 grader defect, 1 ambiguous, 0 tool failure, 0 not supported\. Counted toward the pass: 2\.$/);
    assert.equal(await text('#pl-test .pl-tally'), '3 of 5 below 0.45; 2 count toward the pass; 4 needed.');
    await noHorizontalOverflow('the new mode cards');
    await noOverflowAtPhone('the new mode cards');
    await shot('03d-new-brief-1440', 1440, 1000);
    await evaluate('document.querySelector("#pl-checks").scrollIntoView()');
    await shot('03e-new-checks-1440', 1440, 1000);
    await viewport(390, 844);
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#pl-brief thead")).position'), 'absolute', 'at phone width the brief table folds into labels per cell');
    await evaluate('document.querySelector("#pl-brief").scrollIntoView()');
    await shot('03d-new-brief-390', 390, 844);
    await evaluate('document.querySelector("#pl-checks").scrollIntoView()');
    await shot('03e-new-checks-390', 390, 844);
    await evaluate('document.querySelector("#pl-test").scrollIntoView()');
    await shot('03f-new-test-390', 390, 844);
    await viewport(1440, 1000);
    pass('a full attempt of the new mode: the task type, the brief with each trap in its own columns, fairness and difficulty as two separate results, the answer set with an unstable grade marked, the freeze record, and each pilot saying whether its low score counts');

    /* ---------- done: result and export ---------- */
    set({ stage: 'done', running: false, spentUsd: 17.4, redesigns: 2, summary: 'The test passed: 4 of 5 pilots scored below 0.45 (design attempt 3). Export the private zip to take the design away.', attempts: [
      attempt({ n: 1, traps: [{ id: 't1', title: 'Rounded inputs rebuilt into a total' }], outcome: 'rejected', rejection: { kind: 'checks', reasons: ['The golden answer scored 0.62 against its own guideline; at least 0.90 is needed'] }, calibration: { score: 0.62, verdict: 'does-not-meet-guidance', reason: 'Missing the date.' }, fairness: { status: 'ok', count: 0 }, repaired: true }),
      attempt({ n: 2, traps: [{ id: 't1', title: 'Rounded inputs rebuilt into a total' }], outcome: 'screen-failed', screen: stageOf('screen', [0.7, 0.3], false), calibration: { score: 0.97, verdict: 'v', reason: 'r' }, fairness: { status: 'ok', count: 0 } }),
      attempt({ n: 3, outcome: 'passed', screen: stageOf('screen', [0.31, 0.12], true), test: stageOf('test', [0.1, 0.2, 0.9, 0.3, 0.44], true), calibration: { score: 0.98, verdict: 'v', reason: 'r' }, fairness: { status: 'ok', count: 0 } })] });
    await waitFor(stageIs('^Done:'), 'done', POLL_WAIT);
    assert.match(await text('#pl-verdict'), /The test passed/);
    assert.match(await text('#pl-verdict'), /The test passed: 4 of 5 pilots scored below 0\.45 \(design attempt 3\)\./);
    assert.match(await text('#pl-redesigns'), /2 of 3 used/);
    assert.equal(await count('#pl-redesigns tbody tr'), 3);
    const [rej, failedScreen, passedRow] = [await redesignRow(0), await redesignRow(1), await redesignRow(2)];
    assert.deepEqual([rej.Screen, rej.Test], ['Not run', 'Not run'], 'a rejected design ran no pilot');
    assert.match(rej.Outcome, /^Rejected before any pilot[\s\S]*The design did not pass the calibration or the fairness check\.[\s\S]*The golden answer scored 0\.62 against its own guideline; at least 0\.90 is needed/, 'the rejection is in the outcome column');
    assert.match(rej['Design checks'], /Calibration: 0\.62, failed[\s\S]*A repair turn was used/, 'and the checks in their own');
    assert.ok(!/Rejected|golden answer|Calibration/.test(rej.Screen + '|' + rej.Test), 'neither is in a result column');
    assert.deepEqual([failedScreen.Screen, failedScreen.Test, failedScreen.Outcome], ['Failed (0.70, 0.30)', 'Not run', 'Screen failed']);
    assert.deepEqual([passedRow.Screen, passedRow.Test, passedRow.Outcome], ['Passed (0.31, 0.12)', 'Passed (0.10, 0.20, 0.90, 0.30, 0.44)', 'Passed'], 'the screen scores are in the screen column and the test scores in the test column');
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

    /* ---------- the checks did not finish: a third pipeline that the cap stopped before the blind review ---------- */
    await click('[data-pl=new]');
    await waitFor('!!document.querySelector("#pl-url")', 'the form to open for the third pipeline');
    await evaluate('document.querySelector("#pl-url").focus()');
    await call('Input.insertText', { text: TASK_LINK });
    for (const id of ACK_IDS) await click('#pl-start-form input[data-id="' + id + '"]');
    await click('[data-pl=start]');
    await waitFor(stageIs('^Import:'), 'the third pipeline', 5000);
    assert.equal(posts.filter(p => p.url === '/api/pipeline/start').length, 3, 'a third start was posted');
    set({ stage: 'budget', running: false, capUsd: 30, spentUsd: 24.5, references: NEW_REFS, design: null, summary: 'Stopped before the blind review: USD 24.50 spent, and the step could cost up to USD 2.30.', result: { verdict: 'incomplete', message: 'x', validation: 'incomplete' },
      attempts: [newAttempt({ validation: 'incomplete', outcome: 'budget', fairness: { ...FAIRNESS, status: 'incomplete', stage2: null }, difficulty: { status: 'pending', screen: null, test: null }, screen: null, test: null, freeze: [], calibration: null })] });
    await waitFor(stageIs('^Stopped at the cap'), 'the incomplete result', POLL_WAIT);
    assert.equal(await text('#pl-stage'), 'Stopped at the cap, in the Design step: the next call would pass the total cap, so it was not started.');
    assert.equal(await text('#pl-verdict h2'), 'The checks did not finish');
    assert.match(await text('#pl-verdict .card-title'), /Incomplete/);
    assert.equal(await text('#pl-verdict .pl-incomplete'), 'The checks did not finish. Nothing here counts as a pass: a design passes only after every check of it has finished.');
    assert.equal(await text('#pl-checks .pl-incomplete'), 'The checks did not finish. Nothing here counts as a pass: a design passes only after every check of it has finished.');
    assert.match(await text('#pl-checks .card-title'), /Checks did not finish/);
    assert.match(await text('#pl-checks .pl-review'), /Second review: not run\./);
    assert.match(await text('#pl-checks .pl-difficulty'), /Screen: not run\.\s+Test: not run\./);
    assert.equal(await evaluate('/passed|Passed/.test(document.querySelector("#pl-verdict").innerText.replace("Nothing here counts as a pass","")+document.querySelector("#pl-checks .pl-difficulty").innerText)'), false, 'nothing reads as a pass');
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#pl-checks .pl-incomplete")).borderLeftColor!==getComputedStyle(document.querySelector("#pl-checks")).borderLeftColor'), true, 'the notice is marked');
    await noHorizontalOverflow('the checks did not finish');
    await noOverflowAtPhone('the checks did not finish');
    await shot('04e-incomplete-1440', 1440, 1000);
    await viewport(390, 844);
    await evaluate('document.querySelector("#pl-checks").scrollIntoView()');
    await shot('04e-incomplete-390', 390, 844);
    await viewport(1440, 1000);
    pass('a run stopped before its checks finished says so plainly in the checks card and the result, and nothing reads as a pass');

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
