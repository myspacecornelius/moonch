'use strict';
/* Tests for the Pipeline page (pipeline.js) without a browser, and without the real companion.
   The real agents.js and pipeline.js run inside one vm with a small fake document, as index.html loads them. Every request the page
   makes goes through the Agents page's link / get / post to a FAKE companion in this file: it checks the session code on every POST,
   keeps invented pipeline states, and lets a test move a pipeline forward by hand. No model is started and nothing leaves this machine.
   Clicks and typing are sent through the page's own event handler, found by the data-pl attributes in the markup the page painted.
   Every fixture is invented (Atlas, Meridian, Borealis, .example hosts). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(REPO, name), 'utf8');
const AGENTS_SOURCE = read('agents.js');
const PIPELINE_SOURCE = read('pipeline.js');
const CSS = read('pipeline.css');

const ACK_IDS = ['shell-access', 'network', 'isolation-by-audit', 'model-reads-task'];
const TASK_LINK = 'https://tasks.example/review/atlas-4821?session=SECRET-TOKEN-123';
const SECRET = 'SECRET-TOKEN-123';
const WITHHELD = { withheld: true };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, { timeout = 5000, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('Timed out waiting for ' + label);
    await sleep(10);
  }
}

/* ------------------------------------------------------------------ invented pipeline states, in the shape of backend/pipeline/service.cjs (_view) */

const SOURCE = { kind: 'url', origin: 'https://tasks.example', path: '/review/atlas-4821' };
const attemptOf = (over = {}) => ({ n: 1, startedAt: '2026-10-23T10:05:00.000Z', traps: ['Superseded facility schedule'], newFiles: 2, editedFiles: 1, screen: null, test: null, outcome: 'in-progress', ...over });
/* A fixture may say screen and test (and earlier attempts) for the current attempt; the view carries them inside attempts, the last one current. */
const baseState = (over = {}) => {
  const { screen, test, attempts: earlier, ...rest } = over;
  const attempts = screen || test ? [...(earlier || []), attemptOf({ n: (earlier || []).length + 1, screen: screen || null, test: test || null })] : earlier || [];
  return {
    schema: 'finance-pipeline', schemaVersion: 1, id: 'pl-atlas-0001', label: 'Atlas review', createdAt: '2026-10-23T10:00:00.000Z', updatedAt: '2026-10-23T10:10:00.000Z', endedAt: null,
    stage: 'import', running: true, message: '', summary: '', error: null, waiting: null, source: SOURCE, capUsd: 30, pilotCapUsd: 3, model: 'claude-opus-5-5', effort: 'medium',
    spentUsd: 0, redesigns: 0, loader: null, import: null, classification: null, attempt: attempts.length, design: null, attempts, result: null, ...rest,
  };
};
const importFacts = (over = {}) => ({ fileCount: 9, totalBytes: 123456, groups: { world: 6, task: 3 }, sections: [{ heading: 'Business request', chars: 400 }], page: { origin: 'https://tasks.example', path: '/review/atlas-4821' }, toggle: { found: true, label: 'Show all files', flipped: true, filesBefore: 4, filesAfter: 9, learned: false }, skipped: [], files: [], facts: { world: 5, task: 3, withheld: 2, other: 1 }, ...over });
const classification = () => ({ prompt: { kind: 'section', section: 'Business request', number: 2 }, guideline: { kind: 'file', file: 'Atlas_Grader_Guide.docx' }, goldenAnswer: { kind: 'file', file: 'Atlas_Reference_Answer.docx' }, worldFiles: ['Atlas_Facility_Schedule.csv', 'Meridian_Ledger.xlsx'], taskFiles: ['Atlas_Brief.txt'], other: ['Borealis_Readme.txt'], withheld: [{ name: 'Atlas_Grader_Guide.docx', why: 'it is the grader guideline' }, { name: 'Atlas_Reference_Answer.docx', why: 'it is the golden answer' }], notes: [] });
const designFacts = (over = {}) => ({
  attempt: 1,
  traps: [
    { id: 't1', title: 'Superseded facility schedule', mechanism: 'A later amendment replaces the schedule that stays in the folder.', files: ['Atlas_Amendment_2.txt'], decoy: 'Atlas_Facility_Schedule.csv', correctValue: '1,250', wrongValue: '1,900' },
    { id: 't2', title: 'Rounded inputs rebuilt into a total', mechanism: 'Figures shown in thousands feed a rebuilt total.', files: ['Meridian_Ledger.xlsx'], decoy: 'Meridian_Ledger.xlsx', correctValue: '812', wrongValue: '800' },
  ],
  newFiles: [{ name: 'Atlas_Amendment_2.txt', bytes: 900 }, { name: 'Meridian_Note.txt', bytes: 400 }],
  editedFiles: [{ name: 'Atlas_Facility_Schedule.csv', reason: 'The decoy needs the old rate in column C.', bytes: 2000 }],
  notes: [],
  prompt: 'Assess the Atlas liquidity position and recommend whether the borrowing can proceed.',
  guideline: 'Award full credit when the answer holds the borrowing on 1,250 of usable cash.',
  goldenAnswer: 'Usable cash is 1,250. Hold the borrowing.',
  gold: { decision: 'hold', figures: [{ label: 'Usable cash', value: '1,250', tolerance: 1 }] },
  fingerprints: [{ id: 'fp-alpha', label: 'Counts available credit as cash', tokens: ['available facility counted'], figures: ['1,900'] }],
  ...over,
});
/* One pilot record as the orchestrator keeps it: a score only when the grader gave a usable one. */
const pilots = (scores, extra = {}) => scores.map((score, i) => ({ n: i + 1, id: 'p' + (i + 1), round: 'round-' + (i + 1), run: 1, replacement: false, state: 'completed', audit: { status: 'CLEAN', violationCount: 0 }, costUsd: 0.5, estimated: false, score, verdict: null, reason: '', valid: typeof score === 'number', belowBar: typeof score === 'number' ? score < 0.45 : null, ...(extra[i] || {}) }));
const stageOf = (name, scores, passed, extra) => ({ name, rule: 'the rule', bar: 0.45, need: name === 'test' ? 4 : 2, of: name === 'test' ? 5 : 2, roundIds: ['r'], pilots: pilots(scores, extra), counted: scores.length, belowBar: scores.filter(x => typeof x === 'number' && x < 0.45).length, passed, replacementRound: false });
const doneState = (over = {}) => baseState({
  stage: 'done', running: false, spentUsd: 17.4, redesigns: 1, endedAt: '2026-10-23T11:00:00.000Z', import: importFacts(), classification: classification(), design: designFacts({ attempt: 2 }),
  summary: 'The test passed: 4 of 5 pilots scored below 0.45 (design attempt 2). Export the private zip to take the design away.', result: { verdict: 'success', message: 'x' },
  attempts: [attemptOf({ n: 1, traps: ['Rounded inputs rebuilt into a total'], outcome: 'screen-failed', screen: stageOf('screen', [0.7, 0.3], false) }), attemptOf({ n: 2, outcome: 'passed', screen: stageOf('screen', [0.2, 0.3], true), test: stageOf('test', [0.1, 0.3, 0.44, 0.2, 0.7], true) })], ...over,
});

/* ------------------------------------------------------------------ the fake companion */

const ENDED_STAGES = ['done', 'failed', 'stopped', 'budget'];
const rowOf = p => ({ id: p.id, label: p.label, createdAt: p.createdAt, updatedAt: p.updatedAt, endedAt: p.endedAt, stage: p.stage, running: !ENDED_STAGES.includes(p.stage), message: p.message, spentUsd: p.spentUsd, capUsd: p.capUsd, attempt: p.attempt, redesigns: p.redesigns, verdict: p.result ? p.result.verdict : null });
function makeCompanion(opts = {}) {
  const c = {
    nonce: 'nonce-fake-1', pipelines: new Map(), calls: [], failures: new Map(), startCount: 0, noPipelineSupport: !!opts.noPipelineSupport,
    models: opts.models || ['claude-opus-5-5', 'claude-sonnet-5-5'], efforts: opts.efforts || ['low', 'medium', 'high'],
    /* the rules GET /api/pipeline reports (service.cjs _rules) */
    config: opts.config || { classifyCapUsd: 0.5, designCapUsd: 5, repairCapUsd: 1, fairnessCapUsd: 0.25, graderCapUsd: 0.5, goldenMin: 0.9, regradeBand: [0.4, 0.5], headroom: 1.15 },
    put(state) { c.pipelines.set(state.id, state); return state; },
    update(id, patch) { c.pipelines.set(id, { ...c.pipelines.get(id), ...patch }); },
    /* change the current (last) attempt: its screen, its test, its outcome */
    attemptPatch(id, patch) { const state = c.pipelines.get(id); c.update(id, { attempts: state.attempts.map((a, i, all) => (i === all.length - 1 ? { ...a, ...patch } : a)) }); },
    fail(key, status, error) { c.failures.set(key, { status, error }); },
    /* the answer for a start request: a new pipeline in its first stage */
    onStart(body) { c.startCount++; return baseState({ id: 'pl-run-' + String(c.startCount).padStart(4, '0'), capUsd: body.capUsd, pilotCapUsd: body.pilotCapUsd, model: body.model, effort: body.effort, source: body.url ? SOURCE : { kind: 'folder', name: 'atlas-task' } }); },
    exportAnswer(id) { return { name: 'Atlas_review_pipeline_PRIVATE.zip', size: 22, sha256: 'x'.repeat(64), files: [], zipBase64: Buffer.from('PK synthetic zip bytes').toString('base64') }; },
    handle(method, url, init) {
      const nonce = init.headers && init.headers['x-finance-local'];
      const body = init.body ? JSON.parse(init.body) : null;
      c.calls.push({ method, url, nonce, body });
      const key = method + ' ' + url;
      const failure = [...c.failures].find(([k]) => key === k || (k.endsWith('*') && key.startsWith(k.slice(0, -1))));
      if (failure) { c.failures.delete(failure[0]); return { status: failure[1].status, body: { error: failure[1].error } }; }
      if (method === 'POST' && nonce !== c.nonce) return { status: 403, body: { error: 'Bad session code' } };
      if (url === '/api/status') return { status: 200, body: { nonce: c.nonce, agents: { models: c.models, efforts: c.efforts, maxPilotsPerRound: 5, runtime: { found: true } } } };
      if (c.noPipelineSupport && url.startsWith('/api/pipeline')) return { status: 404, body: { error: 'Not found' } };
      if (method === 'GET' && url === '/api/pipeline') return { status: 200, body: { pipelines: [...c.pipelines.values()].map(rowOf), running: null, config: c.config } };
      if (method === 'POST' && url === '/api/pipeline/start') {
        if ([...c.pipelines.values()].some(p => !ENDED_STAGES.includes(p.stage))) return { status: 409, body: { error: 'A pipeline is already running.' } };
        return { status: 200, body: { id: c.put(c.onStart(body)).id } };
      }
      const m = /^\/api\/pipeline\/([\w-]+)(\/[a-z]+)?$/.exec(url);
      if (m && c.pipelines.has(m[1])) {
        const state = c.pipelines.get(m[1]);
        if (method === 'GET' && !m[2]) return { status: 200, body: state };
        if (method === 'POST' && m[2] === '/continue') { c.update(m[1], { waiting: null }); return { status: 200, body: c.pipelines.get(m[1]) }; }
        if (method === 'POST' && m[2] === '/stop') { c.update(m[1], { stage: 'stopped', running: false, waiting: null }); return { status: 200, body: c.pipelines.get(m[1]) }; }
        if (method === 'POST' && m[2] === '/export') return { status: 200, body: c.exportAnswer(m[1]) };
      }
      return { status: 404, body: { error: 'Not found' } };
    },
  };
  return c;
}

/* ------------------------------------------------------------------ the page: agents.js and pipeline.js in a vm with a fake document */

function makeElement(id) {
  return { id, innerHTML: '', textContent: '', className: '', plHtml: null, dataset: {}, disabled: false, contains: () => false, querySelector: () => null, getAttribute: () => null, focus() {} };
}
const REGIONS = ['pl-start-form', 'pl-start-foot', 'pl-picker', 'pl-spend', 'pl-actions', 'pl-wait', 'pl-withheld', 'pl-timeline', 'pl-import', 'pl-classify', 'pl-design', 'pl-brief', 'pl-checks', 'pl-screen', 'pl-test', 'pl-redesigns', 'pl-verdict'];
const TEXT_FIELDS = new Set(['url', 'dir', 'cap', 'pilotCap', 'keepAsWorld']);

function makePage(t, companion, { location = { protocol: 'http:', hostname: '127.0.0.1' }, noAgents = false, origin: realOrigin = '' } = {}) {
  const elements = new Map(), timers = [], requests = [], listeners = {}, focused = [], downloads = [];
  let inflight = 0, nextTimer = 1;
  const element = id => { if (!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id); };
  const regionsHtml = () => REGIONS.map(id => element(id).innerHTML).join('\n');
  const document = {
    activeElement: null, hidden: false, body: element('body'), title: 'Finance Task Studio',
    querySelector: selector => {
      let m = /^#([\w-]+)$/.exec(selector);
      if (m) return element(m[1]);
      m = /^#pl-root \[data-pl-key="([a-z0-9-]+)"\]$/.exec(selector);
      if (m) { const tag = [...regionsHtml().matchAll(/<(?:button|input|select)\b[^>]*>/g)].map(x => x[0]).find(x => x.includes(`data-pl-key="${m[1]}"`)); return tag ? { disabled: /\sdisabled(\s|>|=)/.test(tag), focus: () => focused.push(m[1]) } : null; }
      return null;
    },
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
  };
  const fetchFn = async (url, init = {}) => {
    inflight++;
    requests.push({ url, method: init.method || 'GET' });
    try {
      if (realOrigin) return await fetch(realOrigin + url, { ...init, headers: { ...(init.headers || {}), ...(init.method && init.method !== 'GET' ? { Origin: realOrigin } : {}) } });
      await sleep(1);
      const answer = companion.handle(init.method || 'GET', url, init);
      return { ok: answer.status < 400, status: answer.status, text: async () => JSON.stringify(answer.body) };
    } finally { inflight--; }
  };
  const context = vm.createContext({
    document, fetch: fetchFn, console, URL, Blob, atob, location,
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.push({ id, fn, ms, done: false }); return id; },
    clearTimeout: id => { const x = timers.find(y => y.id === id); if (x) x.done = true; },
  });
  context.window = context;
  vm.runInContext(AGENTS_SOURCE, context, { filename: 'agents.js' });
  if (noAgents) vm.runInContext('delete window.FinanceAgents', context);
  vm.runInContext(PIPELINE_SOURCE, context, { filename: 'pipeline.js' });
  const pipeline = context.FinancePipeline;
  assert.ok(pipeline && typeof pipeline.handleEvent === 'function' && typeof pipeline.render === 'function' && typeof pipeline.afterRender === 'function', 'pipeline.js exports its module');
  t.after(() => pipeline.afterRender(false));

  const controls = () => [...regionsHtml().matchAll(/<(?:button|input|select)\b[^>]*>/g)].map(m => m[0]);
  const page = {
    elements, element, requests, timers, listeners, focused, downloads, context, pipeline, document,
    html: regionsHtml,
    region: name => element('pl-' + name).innerHTML,
    stage: () => element('pl-stage').textContent,
    status: () => element('pl-msg').textContent,
    statusIsError: () => /\berror\b/.test(element('pl-msg').className),
    text: () => (regionsHtml() + ' ' + element('pl-stage').textContent + ' ' + element('pl-msg').textContent).replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' '),
    pending: () => timers.filter(x => !x.done),
    tagOf: (attr, value) => controls().find(tag => tag.includes(`${attr}="${value}"`)) || null,
    has: action => page.tagOf('data-pl', action) !== null,
    enabled: action => { const tag = page.tagOf('data-pl', action); return tag !== null && !/\sdisabled(\s|>|=)/.test(tag); },
    async settle() { let quiet = 0; while (quiet < 3) { await sleep(8); quiet = inflight === 0 ? quiet + 1 : 0; } },
    async click(action) {
      const tag = page.tagOf('data-pl', action);
      assert.ok(tag, `the page has a control for ${action}`);
      const el = { dataset: { pl: action }, disabled: /\sdisabled(\s|>|=)/.test(tag), closest: s => (s === '[data-pl]' ? el : s === '#pl-root' ? {} : null) };
      pipeline.handleEvent({ type: 'click', target: el });
      await page.settle();
    },
    async type(kind, props = {}) {
      const el = { dataset: { plIn: kind, ...(props.dataset || {}) }, value: props.value, checked: props.checked, closest: s => (s === '[data-pl-in]' ? el : s === '#pl-root' ? {} : null) };
      pipeline.handleEvent({ type: props.event || (TEXT_FIELDS.has(kind) ? 'input' : 'change'), target: el });
      await page.settle();
    },
    async ackAll() { for (const id of ACK_IDS) await page.type('ack', { checked: true, dataset: { id } }); },
    async boot() {
      pipeline.render({ download: (name, bytes, mime) => downloads.push({ name, bytes, mime }), notify() {} });
      pipeline.afterRender(true);
      await waitFor(() => page.region('start-form') || /Pipeline needs|no pipeline support|agents\.js/.test(element('pl-root').innerHTML), { label: 'the page to load' });
      await page.settle();
    },
    /* the clock: run every timer that is waiting, then let the requests finish */
    async tick() { const due = page.pending(); for (const x of due) { x.done = true; x.fn(); } await page.settle(); },
    async fillLink(link = TASK_LINK) { await page.type('url', { value: link }); },
    async startFromLink(link = TASK_LINK) { await page.fillLink(link); await page.ackAll(); await page.click('start'); },
  };
  return page;
}

async function bootWith(t, states = [], opts = {}) {
  const companion = makeCompanion(opts);
  states.forEach(s => companion.put(s));
  const page = makePage(t, companion, opts);
  await page.boot();
  return { companion, page };
}

/* ====================================================================== editions and boot */

test('opened from disk the page makes no request and says the Pipeline needs the companion', async t => {
  const { companion, page } = await bootWith(t, [], { location: { protocol: 'file:', hostname: '' } });
  assert.equal(companion.calls.length, 0);
  assert.equal(page.requests.length, 0);
  assert.match(page.element('pl-root').innerHTML, /The Pipeline needs the companion: run npm start\./);
  assert.match(page.pipeline.render({}), /The Pipeline needs the companion: run npm start\./);
  assert.equal(page.pending().length, 0, 'no timer is started');
});

test('a companion without pipeline support is reported, not hidden: the page says to update it', async t => {
  const { page } = await bootWith(t, [], { noPipelineSupport: true });
  assert.match(page.element('pl-root').innerHTML, /The Pipeline needs the companion: run/);
  assert.match(page.element('pl-root').innerHTML, /This companion has no pipeline support\. Update the companion and run npm start again\./);
});

test('without the Agents page script the Pipeline page says so instead of throwing', async t => {
  const { page } = await bootWith(t, [], { noAgents: true });
  assert.match(page.element('pl-root').innerHTML, /needs agents\.js, which did not load/);
});

test('the module registers its document listeners once and only reacts to its own controls', async t => {
  const { companion, page } = await bootWith(t);
  for (const type of ['click', 'input', 'change']) assert.ok(page.listeners[type] && page.listeners[type].length >= 2, 'the Pipeline page listens for ' + type + ' beside the Agents page');
  const before = companion.calls.length;
  /* a click on something that is not the page's: ignored */
  page.pipeline.handleEvent({ type: 'click', target: { closest: () => null } });
  page.pipeline.handleEvent({ type: 'input', target: { closest: () => null, dataset: {} } });
  page.pipeline.handleEvent({ type: 'click', target: null });
  page.pipeline.handleEvent(null);
  /* a control of the page, but outside #pl-root: ignored */
  const outside = { dataset: { pl: 'start' }, disabled: false, closest: s => (s === '[data-pl]' ? outside : null) };
  page.pipeline.handleEvent({ type: 'click', target: outside });
  await page.settle();
  assert.equal(companion.calls.length, before);
});

/* ====================================================================== the start card */

test('the start card: link or folder, total cap 60, model and effort from the companion, per-pilot cap, four acknowledgements, one yellow button', async t => {
  const { page } = await bootWith(t);
  const form = page.region('start-form');
  assert.match(form, /Task link \(https\)/);
  assert.match(form, /Folder on this computer/);
  assert.match(form, /id="pl-cap"[^>]*value="60"/, 'the total cap starts at 60');
  assert.match(form, /id="pl-pilot-cap"[^>]*value="3\.00"/);
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5']) assert.ok(form.includes(`<option value="${model}"`), model);
  for (const effort of ['low', 'medium', 'high']) assert.ok(form.includes(`<option value="${effort}"`), effort);
  assert.match(form, /<option value="claude-opus-5-5" selected>/, 'the default model comes from the companion list');
  assert.match(form, /<option value="medium" selected>/);
  for (const id of ACK_IDS) assert.ok(page.tagOf('data-id', id), 'a checkbox for ' + id);
  assert.equal((form.match(/data-pl-in="ack"/g) || []).length, 4);
  assert.equal((form.match(/type="checkbox"/g) || []).length, 6, 'the four acknowledgements, the withheld-files choice and the diagnostic answers');
  assert.match(page.region('start-foot'), /<button type="button" class="primary" data-pl="start"/);
  assert.equal((page.html().match(/class="primary"/g) || []).length, 1, 'yellow is on exactly one button');
  assert.match(page.region('start-foot'), />Approve and start<\/button>/);
  assert.equal(page.enabled('start'), false);
  assert.equal(page.tagOf('data-pl', 'start').includes('aria-describedby="pl-why"'), true, 'the reason is tied to the button');
});

test('the first three acknowledgements are the Agents page words, word for word, and the fourth names the task text going to Anthropic', async t => {
  const block = AGENTS_SOURCE.slice(AGENTS_SOURCE.indexOf('const ACKNOWLEDGEMENTS=['), AGENTS_SOURCE.indexOf('];', AGENTS_SOURCE.indexOf('const ACKNOWLEDGEMENTS=[')));
  const theirs = [...block.matchAll(/\{id:'([^']+)',label:'([^']+)',text:'([^']+)'\}/g)].map(m => ({ id: m[1], label: m[2], text: m[3] }));
  assert.equal(theirs.length, 3, 'the Agents page has three');
  const { page } = await bootWith(t);
  const ours = page.pipeline.ACKNOWLEDGEMENTS;
  assert.deepEqual(Array.from(ours, a => a.id), ACK_IDS);
  assert.deepEqual(Array.from(ours.slice(0, 3), a => ({ id: a.id, label: a.label, text: a.text })), theirs);
  assert.match(ours[3].text, /classifier/);
  assert.match(ours[3].text, /trap designer/);
  assert.match(ours[3].text, /simulated grader/);
  assert.match(ours[3].text, /task text, the grader guideline and the golden answer to Anthropic/);
  const form = page.region('start-form');
  for (const a of ours) { assert.ok(form.includes('<strong>' + a.label + '</strong>'), a.label); assert.ok(page.text().includes(a.text), a.id + ' text is shown'); }
});

test('Approve and start stays disabled, with its reason in words, until the source, the caps and all four acknowledgements are right', async t => {
  const { page } = await bootWith(t);
  const why = () => page.region('start-foot').match(/<p id="pl-why" class="pl-why">([^<]*)<\/p>/)[1];
  assert.equal(page.enabled('start'), false);
  assert.match(why(), /Enter the task link/);
  for (const bad of ['http://tasks.example/a', 'tasks.example/a', 'https://user:pw@tasks.example/a', 'https://tasks.example/a b', 'javascript:alert(1)', 'https://']) {
    await page.type('url', { value: bad });
    assert.match(why(), /must be an https address/, bad);
    assert.equal(page.enabled('start'), false, bad);
  }
  await page.fillLink();
  assert.match(why(), /Tick all four acknowledgements/);
  await page.type('ack', { checked: true, dataset: { id: 'shell-access' } });
  await page.type('ack', { checked: true, dataset: { id: 'network' } });
  await page.type('ack', { checked: true, dataset: { id: 'isolation-by-audit' } });
  assert.equal(page.enabled('start'), false, 'three of four is not enough');
  await page.type('ack', { checked: true, dataset: { id: 'model-reads-task' } });
  assert.equal(page.enabled('start'), true);
  assert.equal(why(), '');
  /* untick one: disabled again */
  await page.type('ack', { checked: false, dataset: { id: 'network' } });
  assert.equal(page.enabled('start'), false);
  await page.type('ack', { checked: true, dataset: { id: 'network' } });
  /* caps */
  for (const bad of ['', 'abc', '0', '0.99', '201', '10.123', '-5', '1e2']) {
    await page.type('cap', { value: bad });
    assert.match(why(), /The total cap must be from USD 1\.00 to USD 200\.00/, 'cap ' + JSON.stringify(bad));
    assert.equal(page.enabled('start'), false);
  }
  await page.type('cap', { value: '200' });
  assert.equal(page.enabled('start'), true);
  for (const bad of ['0.04', '20.01', 'x']) {
    await page.type('pilotCap', { value: bad });
    assert.match(why(), /The cap per pilot must be from USD 0\.05 to USD 20\.00/, 'pilot cap ' + bad);
  }
  await page.type('pilotCap', { value: '20' });
  assert.equal(page.enabled('start'), true);
  await page.type('cap', { value: '10' });
  assert.match(why(), /at least the cap of one pilot/);
  await page.type('cap', { value: '30' });
  await page.type('pilotCap', { value: '3' });
  assert.equal(page.enabled('start'), true);
});

/* ---- the total cap: the default, and the least cap for one full attempt (GET /api/pipeline config.defaultCapUsd and config.minCap) ---- */

const CFG = { classifyCapUsd: 0.5, designCapUsd: 5, repairCapUsd: 1, fairnessCapUsd: 0.25, graderCapUsd: 0.5, goldenMin: 0.9, regradeBand: [0.4, 0.5], headroom: 1.15 };
const MIN_CAP = { fixedUsd: 6.25, perPilotUsd: 1.5, pilots: 7, headroom: 1.15 };
const whyOf = page => page.region('start-foot').match(/<p id="pl-why" class="pl-why">([^<]*)<\/p>/)[1];
const capMinInForm = page => (page.region('start-form').match(/<small id="pl-cap-min" class="pl-cap-min">([^<]*)<\/small>/) || [])[1];
const ready = async page => { await page.fillLink(); await page.ackAll(); };

test('the total cap starts at USD 60, or at the default the companion reports, and a cap the person typed is kept', async t => {
  const { page } = await bootWith(t);
  assert.match(page.region('start-form'), /id="pl-cap"[^>]*value="60"/);
  const { page: reported } = await bootWith(t, [], { config: { ...CFG, defaultCapUsd: 40 } });
  assert.match(reported.region('start-form'), /id="pl-cap"[^>]*value="40"/, 'the companion\'s default');
  const { page: fraction } = await bootWith(t, [], { config: { ...CFG, defaultCapUsd: 37.5 } });
  assert.match(fraction.region('start-form'), /id="pl-cap"[^>]*value="37\.5"/);
  for (const junk of [250, 0.5, 'many', null, -1, 12.345, { withheld: true }, [30]]) {
    const { page: odd } = await bootWith(t, [], { config: { ...CFG, defaultCapUsd: junk } });
    assert.match(odd.region('start-form'), /id="pl-cap"[^>]*value="60"/, 'a default of ' + JSON.stringify(junk) + ' is not used');
  }
  /* the person's own cap stays when the rules are read again (a refused start reads them); a cap nobody typed follows the companion */
  const refuse = async (companion, page) => { companion.fail('POST /api/pipeline/start', 409, 'Another pipeline is running.'); await page.click('start'); assert.equal(page.status(), 'Failed: Another pipeline is running.'); };
  const { companion, page: typed } = await bootWith(t, [], { config: { ...CFG, defaultCapUsd: 40 } });
  assert.match(typed.region('start-form'), /id="pl-cap"[^>]*value="40"/);
  await typed.type('cap', { value: '25' });
  companion.config = { ...CFG, defaultCapUsd: 70 };
  await ready(typed);
  await refuse(companion, typed);
  assert.match(typed.region('start-form'), /id="pl-cap"[^>]*value="25"/, 'what was typed is kept');
  const { companion: other, page: untouched } = await bootWith(t, [], { config: { ...CFG, defaultCapUsd: 40 } });
  other.config = { ...CFG, defaultCapUsd: 70 };
  await ready(untouched);
  await refuse(other, untouched);
  assert.match(untouched.region('start-form'), /id="pl-cap"[^>]*value="70"/, 'a cap nobody typed follows the companion\'s default');
  /* a start sends the cap that is in the box */
  const { companion: c2, page: p2 } = await bootWith(t);
  await p2.startFromLink();
  assert.equal(c2.calls.find(c => c.method === 'POST' && c.url === '/api/pipeline/start').body.capUsd, 60);
});

test('config.minCap: the least total cap of one full attempt is shown by the cap field and moves with the pilot cap', async t => {
  /* 1.15 x (6.25 + 7 x (3 + 1.5)) = 43.4125, up to the cent */
  const { page } = await bootWith(t, [], { config: { ...CFG, minCap: MIN_CAP } });
  assert.equal(capMinInForm(page), 'If the screen passes, one full attempt (screen and test) can cost up to USD 43.42. The reviews and the adjudication of low scores are part of every attempt.');
  assert.match(page.region('start-form'), /id="pl-cap"[^>]*aria-describedby="pl-cap-hint pl-cap-min"/, 'the cap field is described by the figure');
  await page.type('pilotCap', { value: '5' });   // 1.15 x (6.25 + 7 x 6.5) = 59.5125
  assert.equal(page.element('pl-cap-min').textContent, 'If the screen passes, one full attempt (screen and test) can cost up to USD 59.52. The reviews and the adjudication of low scores are part of every attempt.', 'the default total cap of 60 covers it: no warning');
  await page.type('cap', { value: '50' });
  assert.equal(page.element('pl-cap-min').textContent, 'If the screen passes, one full attempt (screen and test) can cost up to USD 59.52. The reviews and the adjudication of low scores are part of every attempt. With this total cap the run may stop at the cap before the 5-pilot test.', 'the default pilot cap of 3 was raised and the total cap of 50 no longer covers it');
  await page.type('pilotCap', { value: '0.05' });   // 1.15 x (6.25 + 7 x 1.55) = 19.665
  assert.equal(page.element('pl-cap-min').textContent, 'If the screen passes, one full attempt (screen and test) can cost up to USD 19.67. The reviews and the adjudication of low scores are part of every attempt.');
  await page.type('pilotCap', { value: 'x' });
  assert.equal(page.element('pl-cap-min').textContent, '', 'no figure while the pilot cap is not an amount');
  await page.type('pilotCap', { value: '3' });
  assert.equal(page.element('pl-cap-min').textContent, 'If the screen passes, one full attempt (screen and test) can cost up to USD 43.42. The reviews and the adjudication of low scores are part of every attempt.');
  /* a sum that is exactly on a cent is not rounded up by floating point error: 1.1 x 5 x (0.30 + 0.5) = 4.40 */
  const { page: exact } = await bootWith(t, [], { config: { ...CFG, minCap: { fixedUsd: 0, perPilotUsd: 0.5, pilots: 5, headroom: 1.1 } } });
  await exact.type('pilotCap', { value: '0.30' });
  assert.equal(exact.element('pl-cap-min').textContent, 'If the screen passes, one full attempt (screen and test) can cost up to USD 4.40. The reviews and the adjudication of low scores are part of every attempt.');
});

test('config.minCap: below the least cap Start stays enabled and the cap hint warns that the run may stop before the test', async t => {
  const { companion, page } = await bootWith(t, [], { config: { ...CFG, minCap: MIN_CAP } });
  await ready(page);
  assert.equal(page.enabled('start'), true, 'the default of 60 covers 43.42');
  assert.equal(capMinInForm(page), 'If the screen passes, one full attempt (screen and test) can cost up to USD 43.42. The reviews and the adjudication of low scores are part of every attempt.');
  await page.type('cap', { value: '43.41' });
  assert.equal(page.enabled('start'), true, 'a cap below one full attempt is the owner\'s choice');
  assert.equal(whyOf(page), '');
  assert.equal(page.element('pl-cap-min').textContent, 'If the screen passes, one full attempt (screen and test) can cost up to USD 43.42. The reviews and the adjudication of low scores are part of every attempt. With this total cap the run may stop at the cap before the 5-pilot test.');
  await page.type('cap', { value: '43.42' });
  assert.equal(page.element('pl-cap-min').textContent, 'If the screen passes, one full attempt (screen and test) can cost up to USD 43.42. The reviews and the adjudication of low scores are part of every attempt.', 'exactly the least cap: no warning');
  /* a larger pilot cap raises the least cap, and the warning follows it */
  await page.type('pilotCap', { value: '4' });   // 1.15 x (6.25 + 7 x 5.5) = 51.4625
  assert.match(page.element('pl-cap-min').textContent, /USD 51\.47\. The reviews and the adjudication of low scores are part of every attempt\. With this total cap the run may stop/);
  await page.type('cap', { value: '20' });
  assert.equal(page.enabled('start'), true);
  await page.click('start');
  const post = companion.calls.find(c => c.method === 'POST' && c.url === '/api/pipeline/start');
  assert.equal(post.body.capUsd, 20, 'the low cap is sent as typed');
  assert.equal(post.body.pilotCapUsd, 4);
  /* the cent edge of the figure */
  const { page: exact } = await bootWith(t, [], { config: { ...CFG, minCap: { fixedUsd: 0, perPilotUsd: 0.5, pilots: 5, headroom: 1.1 } } });
  await ready(exact);
  await exact.type('pilotCap', { value: '0.30' });
  await exact.type('cap', { value: '4.39' });
  assert.match(exact.element('pl-cap-min').textContent, /^If the screen passes, one full attempt \(screen and test\) can cost up to USD 4\.40\. The reviews and the adjudication of low scores are part of every attempt\. With this total cap/);
  await exact.type('cap', { value: '4.4' });
  assert.equal(exact.element('pl-cap-min').textContent, 'If the screen passes, one full attempt (screen and test) can cost up to USD 4.40. The reviews and the adjudication of low scores are part of every attempt.');
});

test('config.minCap: the range checks still block, and a least cap above the largest total cap only warns', async t => {
  const { page } = await bootWith(t, [], { config: { ...CFG, minCap: MIN_CAP } });
  await ready(page);
  await page.type('cap', { value: '10' });
  assert.equal(whyOf(page), '', 'below the least cap is not a reason to block');
  await page.type('cap', { value: '2' });
  assert.equal(whyOf(page), 'The total cap must be at least the cap of one pilot.');
  await page.type('cap', { value: '0' });
  assert.match(whyOf(page), /The total cap must be from USD 1\.00 to USD 200\.00/);
  await page.type('cap', { value: '50' });
  await page.type('pilotCap', { value: '0.04' });
  assert.match(whyOf(page), /The cap per pilot must be from USD 0\.05 to USD 20\.00/);
  assert.equal(page.element('pl-cap-min').textContent, '', 'no figure from a pilot cap that is not valid');
  const { page: heavy } = await bootWith(t, [], { config: { ...CFG, minCap: { fixedUsd: 150, perPilotUsd: 5, pilots: 7, headroom: 1.15 } } });
  await ready(heavy);
  await heavy.type('cap', { value: '200' });
  await heavy.type('pilotCap', { value: '20' });   // 1.15 x (150 + 7 x 25) = 373.75
  assert.equal(heavy.enabled('start'), true);
  assert.match(heavy.element('pl-cap-min').textContent, /USD 373\.75\. The reviews and the adjudication of low scores are part of every attempt\. With this total cap the run may stop at the cap before the 5-pilot test\./);
});

test('config.minCap missing or unusable: the page says nothing about it and does not block', async t => {
  const odd = [
    undefined, null, {}, [], 'cap', 7, { withheld: true },
    { fixedUsd: 6.25, perPilotUsd: 1.5, pilots: 7 },                 // no headroom
    { fixedUsd: 6.25, perPilotUsd: 1.5, headroom: 1.15 },            // no pilots
    { fixedUsd: -1, perPilotUsd: 1.5, pilots: 7, headroom: 1.15 },   // negative
    { fixedUsd: 6.25, perPilotUsd: 1.5, pilots: 0, headroom: 1.15 }, // no pilot at all
    { fixedUsd: 6.25, perPilotUsd: 1.5, pilots: 7, headroom: 0.5 },  // less than the plain sum
    { fixedUsd: 'six', perPilotUsd: 1.5, pilots: 7, headroom: 1.15 },
    { fixedUsd: { withheld: true }, perPilotUsd: 1.5, pilots: 7, headroom: 1.15 },
  ];
  for (const minCap of odd) {
    const { page } = await bootWith(t, [], { config: { ...CFG, minCap } });
    assert.equal(capMinInForm(page), '', 'no figure for ' + JSON.stringify(minCap));
    assert.doesNotMatch(page.region('start-form'), /one full attempt \(screen and test\)/);
    await ready(page);
    await page.type('cap', { value: '1' });
    await page.type('pilotCap', { value: '0.05' });
    assert.equal(page.enabled('start'), true, 'a cap of USD 1.00 is not blocked for ' + JSON.stringify(minCap));
    assert.equal(whyOf(page), '');
    assert.equal(page.element('pl-cap-min').textContent, '');
  }
  const { page: none } = await bootWith(t, [], { config: {} });
  assert.equal(capMinInForm(none), '');
  assert.doesNotMatch(none.html(), /full attempt/);
});

test('a click on the disabled button starts nothing', async t => {
  const { companion, page } = await bootWith(t);
  await page.click('start');
  assert.equal(companion.calls.filter(c => c.method === 'POST').length, 0);
});

test('the line under the button says what will happen, with the bar, the pilot counts, the redesigns and the cap, and it follows the design mode', async t => {
  const { page } = await bootWith(t);
  const line = () => page.region('start-foot').match(/<p class="pl-happens">([^<]*)<\/p>/)[1];
  for (const part of ['imported', 'classified', 'builds a new task from the world files', 'blind reviewer', 'two blind pilots', 'below 0.40', 'five pilots', 'at least 4 of 5', 'below 0.45', 'Every low score is explained before it counts', '3 redesigns', 'total cap', 'Stop']) assert.ok(line().includes(part), 'new mode: ' + part);
  await page.type('designMode', { value: 'harden' });
  for (const part of ['imported', 'classified', 'hardens the task', 'two blind pilots', 'below 0.40', 'five pilots', 'at least 4 of 5', 'below 0.45', '3 redesigns', 'total cap', 'Stop']) assert.ok(line().includes(part), 'harden mode: ' + part);
  assert.doesNotMatch(line(), /blind reviewer|explained before it counts/, 'the harden mode has neither');
  assert.match(page.region('start-foot'), /Each pilot is capped at USD 3\.00, so a 2-pilot screen can cost up to USD 6\.00 and a 5-pilot test up to USD 15\.00/);
  await page.type('pilotCap', { value: '1.50' });
  assert.match(page.region('start-foot'), /up to USD 3\.00 and a 5-pilot test up to USD 7\.50/, 'the worst case follows the cap');
});

test('starting from a task link: one POST with the nonce, the link, the caps, model, effort and the four acknowledgements; the link is then gone from the page', async t => {
  const { companion, page } = await bootWith(t);
  await page.type('cap', { value: '25.50' });
  await page.type('model', { value: 'claude-sonnet-5-5' });
  await page.type('effort', { value: 'high' });
  await page.type('pilotCap', { value: '2' });
  await page.startFromLink();
  const posts = companion.calls.filter(c => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/pipeline/start');
  assert.equal(posts[0].nonce, 'nonce-fake-1', 'the session code travels with the request');
  assert.deepEqual(posts[0].body, { url: TASK_LINK, capUsd: 25.5, model: 'claude-sonnet-5-5', effort: 'high', pilotCapUsd: 2, acceptMissing: false, designMode: 'new', acknowledgements: ACK_IDS });
  assert.ok(!('sourceDir' in posts[0].body));
  /* the run is shown, the form is folded away and nothing keeps the link */
  assert.match(page.stage(), /^Import:/);
  assert.match(page.region('start-form'), /A pipeline is running\. You can start another when it has ended\./);
  assert.equal(page.has('start'), false, 'no start button while a pipeline runs');
  assert.equal(page.enabled('new'), false);
  assert.ok(!page.html().includes(SECRET) && !page.text().includes(SECRET) && !page.status().includes(SECRET), 'the link is not shown anywhere');
  assert.ok(!JSON.stringify(page.requests).includes(SECRET), 'and it is not in any URL');
  assert.match(page.status(), /^Started\./);
  assert.equal(page.pending().length, 1, 'polling started');
  assert.equal(page.pending()[0].ms, 2000, 'every 2 seconds');
});

test('starting from a folder sends sourceDir and no link', async t => {
  const { companion, page } = await bootWith(t);
  await page.type('source', { value: 'dir' });
  assert.match(page.region('start-form'), /Folder path/);
  assert.doesNotMatch(page.region('start-form'), /id="pl-url"/);
  const why = () => page.region('start-foot').match(/<p id="pl-why" class="pl-why">([^<]*)<\/p>/)[1];
  assert.match(why(), /Enter the folder path/);
  await page.type('dir', { value: 'Downloads/task' });
  assert.match(why(), /full path of the folder, starting with \//);
  await page.type('dir', { value: '/Users/you/Downloads/atlas-task' });
  await page.ackAll();
  assert.equal(page.enabled('start'), true);
  await page.click('start');
  const post = companion.calls.find(c => c.method === 'POST');
  assert.deepEqual(post.body, { sourceDir: '/Users/you/Downloads/atlas-task', capUsd: 60, model: 'claude-opus-5-5', effort: 'medium', pilotCapUsd: 3, acceptMissing: false, designMode: 'new', acknowledgements: ACK_IDS });
  assert.match(page.stage(), /^Import:/);
});

test('the acknowledgements are spent by a start: the next form is empty and the button is disabled again', async t => {
  const { companion, page } = await bootWith(t);
  await page.startFromLink();
  companion.update('pl-run-0001', { stage: 'done' });
  await page.tick();
  assert.equal(page.enabled('new'), true);
  await page.click('new');
  assert.equal((page.region('start-form').match(/type="checkbox" [^>]*checked/g) || []).length, 0, 'no acknowledgement is ticked');
  assert.doesNotMatch(page.region('start-form'), /value="https:/, 'no link is carried over');
  assert.equal(page.enabled('start'), false);
});

test('a refused start shows the companion reason with the word Failed, keeps the form for another try and starts no polling', async t => {
  const { companion, page } = await bootWith(t);
  companion.fail('POST /api/pipeline/start', 409, 'A pipeline is already running.');
  await page.startFromLink();
  assert.equal(page.status(), 'Failed: A pipeline is already running.');
  assert.equal(page.statusIsError(), true);
  assert.match(page.region('start-form'), /id="pl-url"/, 'the form is still there');
  assert.match(page.region('start-form'), /value="https:\/\/tasks\.example\/review\/atlas-4821/, 'the link stays in the field for a retry');
  assert.equal(page.enabled('start'), true, 'and the button works again');
  assert.equal(page.pending().length, 0);
  /* the retry goes through */
  await page.click('start');
  assert.match(page.stage(), /^Import:/);
  assert.equal(page.status().startsWith('Failed'), false);
});

test('a start answer without a usable id is reported, not trusted', async t => {
  const { companion, page } = await bootWith(t);
  const original = companion.handle;
  companion.handle = (method, url, init) => (url === '/api/pipeline/start' ? { status: 200, body: { id: '../x' } } : original(method, url, init));
  await page.startFromLink();
  assert.match(page.status(), /Failed: The companion did not return a pipeline id\./);
});

/* ====================================================================== the run: stage, spend, timeline */

const stepsOf = html => [...html.matchAll(/<li class="pl-step is-(\w+)"( aria-current="step")?><span class="pl-step-mark" aria-hidden="true">([^<]*)<\/span><span class="pl-step-text"><strong>([^<]*)<\/strong><small>([^<]*)<\/small>/g)].map(m => ({ s: m[1], current: !!m[2], mark: m[3], label: m[4], caption: m[5] }));

test('the timeline lists Import, Classify, Design, Screen, Test, Done and marks the current stage for every stage the pipeline can be in', async t => {
  const rows = [
    ['import', 0, 'In progress'], ['classify', 1], ['design', 2], ['redesign', 2], ['screen', 3], ['grade-screen', 3], ['test', 4], ['grade-test', 4],
  ];
  const { companion, page } = await bootWith(t, [baseState({ stage: 'import' })]);
  for (const [stage, index] of rows) {
    companion.update('pl-atlas-0001', { stage });
    await page.tick();
    const steps = stepsOf(page.region('timeline'));
    assert.deepEqual(steps.map(s => s.label), ['Import', 'Classify', 'Design', 'Screen', 'Test', 'Done'], stage);
    steps.forEach((s, i) => {
      assert.equal(s.current, i === index, `${stage}: step ${s.label} current`);
      assert.equal(s.s, i < index ? 'done' : i === index ? 'active' : 'todo', `${stage}: step ${s.label} state`);
    });
    assert.equal(steps[index].mark, '●');
    assert.equal(steps[0].mark, index === 0 ? '●' : '✓');
    assert.match(page.region('timeline'), /<ol class="pl-steps" aria-label="Pipeline stages">/);
  }
  companion.update('pl-atlas-0001', { stage: 'done' });
  await page.tick();
  const steps = stepsOf(page.region('timeline'));
  assert.ok(steps.every(s => s.s === 'done' && !s.current), 'when done every step is done and none is current');
});

test('the stage line says what is happening in words, adds the redesign count, and is a polite live region', async t => {
  const { companion, page } = await bootWith(t, [baseState({ stage: 'classify' })]);
  assert.equal(page.stage(), 'Classify: sorting the captured files and text.');
  const skeleton = page.pipeline.render({});
  assert.match(skeleton, /<p id="pl-stage" class="pl-stage" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(skeleton, /<p id="pl-msg" class="pl-msg" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(skeleton, /<section id="pl-wait" class="card pl-wait" role="status" aria-live="polite"/);
  const running = { import: 'Import:', design: 'Design:', screen: 'Screen: two blind pilots', 'grade-screen': 'Screen: grading', test: 'Test: five blind pilots', 'grade-test': 'Test: grading' };
  for (const [stage, start] of Object.entries(running)) {
    companion.update('pl-atlas-0001', { stage });
    await page.tick();
    assert.ok(page.stage().startsWith(start), `${stage}: ${page.stage()}`);
  }
  const ended = { done: 'Done:', failed: 'Failed:', stopped: 'Stopped: you pressed Stop.', budget: 'Stopped at the cap, in the Import step: the next call would pass the total cap, so it was not started.' };
  for (const [stage, start] of Object.entries(ended)) {
    const { page: done } = await bootWith(t, [baseState({ stage })]);
    assert.ok(done.stage().startsWith(start), `${stage}: ${done.stage()}`);
    assert.equal(done.pending().length, 0, stage + ' needs no polling');
  }
  companion.update('pl-atlas-0001', { stage: 'redesign', redesigns: 2 });
  await page.tick();
  assert.equal(page.stage(), 'Design: strengthening the traps after a failed stage. Redesign 2 of 3.');
  companion.update('pl-atlas-0001', { stage: 'screen', redesigns: 3 });
  await page.tick();
  assert.match(page.stage(), /Redesign 3 of 3\.$/);
});

test('a stage the page does not know is shown as working, not as an error', async t => {
  const { page } = await bootWith(t, [baseState({ stage: 'warm-up' })]);
  assert.equal(page.stage(), 'Working (warm-up).');
  assert.equal(stepsOf(page.region('timeline')).filter(s => s.current).length, 1);
});

test('spent against the cap: dollars to two decimals, a meter with a label and no percentage, and the run facts', async t => {
  const { companion, page } = await bootWith(t, [baseState({ stage: 'design', spentUsd: 7.5, capUsd: 30 })]);
  const spend = page.region('spend');
  assert.match(spend, /<strong>Spent<\/strong> USD 7\.50 of USD 30\.00<\/p>/);
  assert.match(spend, /<progress class="pl-meter" max="30" value="7\.5" aria-label="Spent against the total cap"><\/progress>/);
  assert.match(spend, /Pipeline <code>pl-atlas-0001<\/code> · claude-opus-5-5 · medium · USD 3\.00 per pilot · started /);
  assert.ok(!spend.includes('%'), 'no percentage in the copy');
  companion.update('pl-atlas-0001', { spentUsd: 12.345 });
  await page.tick();
  assert.match(page.region('spend'), /USD 12\.35 of USD 30\.00/);
  companion.update('pl-atlas-0001', { spentUsd: 31, capUsd: 30 });
  await page.tick();
  assert.match(page.region('spend'), /value="30"/, 'the meter never passes the cap');
  companion.update('pl-atlas-0001', { capUsd: null, spentUsd: 1 });
  await page.tick();
  assert.doesNotMatch(page.region('spend'), /<progress/);
  assert.match(page.region('spend'), /USD 1\.00/);
  companion.update('pl-atlas-0001', { capUsd: 30, config: { acceptMissing: true } });
  await page.tick();
  assert.match(page.region('spend'), /per pilot · withheld files accepted · started /, 'a run started with the withheld-files box ticked says so');
});

test('polling: every 2 seconds while the pipeline runs, repainting from each answer, and it stops by itself when the pipeline ends', async t => {
  const { companion, page } = await bootWith(t, [baseState({ stage: 'import' })]);
  assert.equal(page.pending().length, 1);
  assert.equal(page.pending()[0].ms, 2000);
  const gets = () => companion.calls.filter(c => c.method === 'GET' && c.url === '/api/pipeline/pl-atlas-0001').length;
  const before = gets();
  companion.update('pl-atlas-0001', { stage: 'classify', spentUsd: 0.4 });
  await page.tick();
  assert.equal(gets(), before + 1);
  assert.match(page.stage(), /^Classify:/);
  assert.match(page.region('spend'), /USD 0\.40/);
  assert.equal(page.pending().length, 1, 'and it schedules the next poll');
  companion.update('pl-atlas-0001', { stage: 'done' });
  await page.tick();
  assert.match(page.stage(), /^Done:/);
  assert.equal(page.pending().length, 0, 'no poll once the pipeline has ended');
});

test('polling waits while the tab is hidden, shows a failed poll in words and goes on, and stops when the person leaves the page', async t => {
  const { companion, page } = await bootWith(t, [baseState({ stage: 'screen' })]);
  const count = () => companion.calls.length;
  page.document.hidden = true;
  const hiddenBefore = count();
  await page.tick();
  assert.equal(count(), hiddenBefore, 'a hidden tab makes no request');
  assert.equal(page.pending().length, 1, 'but the poll stays scheduled');
  page.document.hidden = false;
  companion.fail('GET /api/pipeline/pl-atlas-0001', 500, 'The companion hit an error.');
  await page.tick();
  assert.equal(page.status(), 'Failed: The companion hit an error.');
  assert.equal(page.pending().length, 1, 'it keeps polling after a failure');
  await page.tick();
  assert.equal(page.pending().length, 1);
  assert.equal(page.status(), '', 'a good poll takes back a message that only a poll had raised');
  page.pipeline.afterRender(false);
  assert.equal(page.pending().length, 0, 'leaving the page stops the timer');
  const callsAfter = count();
  await page.tick();
  assert.equal(count(), callsAfter);
  page.pipeline.afterRender(true);
  assert.equal(page.pending().length, 1, 'coming back starts it again');
});

test('a dashboard re-render gives the page fresh elements: render and afterRender paint every region again', async t => {
  const { page } = await bootWith(t, [doneState()]);
  const stageBefore = page.stage();
  assert.ok(stageBefore);
  page.elements.clear();
  page.pipeline.render({});
  page.pipeline.afterRender(true);
  await page.settle();
  assert.equal(page.stage(), stageBefore, 'the live stage line is written into the new element');
  assert.match(page.region('timeline'), /pl-step/);
  assert.match(page.region('verdict'), /The test passed/);
  assert.match(page.region('start-form'), /Start a pipeline/);
});

/* ====================================================================== waiting for the person */

test('when the loader needs the person, the message and a Continue button show; Continue posts and the wait ends', async t => {
  const message = 'Turn on the option that shows all files in the Chrome window, then press Continue.';
  const { companion, page } = await bootWith(t, [baseState({ stage: 'import', waiting: { kind: 'needs-person', message } })]);
  const wait = page.region('wait');
  assert.match(wait, /Turn on the option that shows all files/);
  assert.ok(wait.includes(message));
  assert.match(wait, /Waiting for you/);
  assert.equal(page.enabled('continue'), true);
  assert.equal(page.stage(), 'Waiting for you: ' + message, 'the live stage line carries the same message');
  assert.equal(stepsOf(page.region('timeline'))[0].caption, 'Waiting for you');
  assert.match(page.region('actions'), /data-pl="stop"/, 'Stop is there while it waits');
  await page.click('continue');
  const post = companion.calls.find(c => c.method === 'POST');
  assert.equal(post.url, '/api/pipeline/pl-atlas-0001/continue');
  assert.equal(post.nonce, 'nonce-fake-1');
  assert.equal(page.region('wait'), '', 'the wait card is gone');
  assert.match(page.stage(), /^Import:/);
  assert.equal(page.status(), 'Continuing.');
});

test('a wait is titled by its kind: sign in, your action in the Chrome window, or a plain title for a kind the page does not know', async t => {
  const { companion, page } = await bootWith(t, [baseState({ waiting: { kind: 'needs-sign-in', message: 'Sign in to the task site in the Chrome window.', since: '2026-10-23T10:01:00.000Z' } })]);
  assert.match(page.region('wait'), /<h2>Sign in<\/h2>/);
  assert.doesNotMatch(page.region('wait'), /Your action is needed/);
  assert.match(page.region('wait'), /Sign in to the task site in the Chrome window\./);
  assert.equal(page.enabled('continue'), true);
  companion.update('pl-atlas-0001', { waiting: { kind: 'something-new', message: 'Please check the window.' } });
  await page.tick();
  assert.match(page.region('wait'), /The task page needs you/);
  assert.match(page.region('wait'), /Please check the window\./);
  assert.match(page.region('wait'), /<h2>The task page needs you<\/h2>/);
  companion.update('pl-atlas-0001', { waiting: { kind: 'needs-person' } });
  await page.tick();
  assert.match(page.region('wait'), /<h2>Your action is needed in the Chrome window<\/h2>/);
  assert.match(page.region('wait'), /Finish what the Chrome window asks for, then press Continue\./, 'a wait with no message still says what to do');
});

test('a needs-person wait is not called a sign-in, whatever it asks (the toggle, no files found, files that did not download)', async t => {
  const asks = [
    'Turn on the option that shows all files in the Chrome window, then press Continue.',
    'The Studio found no files. Open the view that lists the files in the Chrome window, then press Continue.',
    '3 files could not be downloaded: Atlas_Amendment_2.txt, Meridian_Note.txt, Borealis_Terms.txt. Download them yourself into a folder and use Import a folder.',
  ];
  const { companion, page } = await bootWith(t, [baseState({ waiting: { kind: 'needs-person', message: asks[0] } })]);
  for (const message of asks) {
    companion.update('pl-atlas-0001', { waiting: { kind: 'needs-person', message } });
    await page.tick();
    const wait = page.region('wait');
    assert.match(wait, /<h2>Your action is needed in the Chrome window<\/h2>/);
    assert.doesNotMatch(wait, /Sign in/);
    assert.doesNotMatch(wait, /Turn on the option that shows all files<\/h2>/, 'the heading does not claim one cause');
    assert.ok(wait.includes(message), 'the loader\'s own message carries the detail');
  }
});

test('a long loader message is shown whole in the wait card (a thousand characters and more); the bar carries a short one and points to the card for a long one', async t => {
  const base = 'Open the view that lists the files, then press Continue. Atlas_Amendment_2.txt, Meridian_Note.txt. ';
  for (const size of [200, 300, 1000, 1200, 4000]) {
    const message = base.repeat(50).slice(0, size - 4) + ' END';
    assert.equal(message.length, size);
    const { page } = await bootWith(t, [baseState({ waiting: { kind: 'needs-person', message } })]);
    assert.ok(page.region('wait').includes(message), size + ' characters, not cut, in the card');
    assert.ok(page.text().includes(message.replace(/\s+/g, ' ')), size + ' characters on the page');
    if (size <= 240) assert.equal(page.stage(), 'Waiting for you: ' + message, 'a short message is in the stage line');
    else assert.equal(page.stage(), 'Waiting for you: Your action is needed in the Chrome window. The whole message is in the card below.', 'a long one is in the card, and the bar stays short');
  }
  const { page: signIn } = await bootWith(t, [baseState({ waiting: { kind: 'needs-sign-in', message: 'x'.repeat(1000) } })]);
  assert.equal(signIn.stage(), 'Waiting for you: Sign in. The whole message is in the card below.');
});

test('a failed Continue is shown in words and the button works again', async t => {
  const { companion, page } = await bootWith(t, [baseState({ waiting: { kind: 'needs-person', message: 'Flip the switch.' } })]);
  companion.fail('POST /api/pipeline/pl-atlas-0001/continue', 409, 'Nothing is waiting.');
  await page.click('continue');
  assert.equal(page.status(), 'Failed: Nothing is waiting.');
  assert.equal(page.enabled('continue'), true);
});

/* ---- the wait after a link import: the owner checks the fetched files against the task page (waiting.kind 'confirm-files', import.notes) ---- */

const fetched = (n = 40) => Array.from({ length: n }, (_, i) => ({ name: 'Atlas_File_' + String(i + 1).padStart(2, '0') + ['.csv', '.txt', '.xlsx'][i % 3], group: i < 25 ? 'World files' : 'Task files', bytes: 1000 + i, sha256: 'a'.repeat(64), label: 'File ' + (i + 1) }));
const SKIPPED = [{ name: 'Atlas_Thumbs.db', why: 'a system file' }, { name: 'Atlas_Archive_2019.zip', why: 'larger than the size cap' }];
const NOTES = ['The file list stopped at the 200 file cap.', 'A second page of files was not followed.', 'A frame on the page could not be read.'];
const CONFIRM_MESSAGE = '40 files were fetched. Compare them with the files listed on the task page, then press Continue.';
const confirmState = (over = {}, importOver = {}) => baseState({
  stage: 'import', import: importFacts({ fileCount: 40, files: fetched(), skipped: SKIPPED, notes: NOTES, facts: undefined, ...importOver }),
  waiting: { kind: 'confirm-files', message: CONFIRM_MESSAGE, since: '2026-10-23T10:02:00.000Z' }, ...over,
});

test('the confirm-files wait is its own card, "Check the files": the message, the notes, 40 fetched files with their groups, the skipped files, the toggle result, and two buttons', async t => {
  const { companion, page } = await bootWith(t, [confirmState()]);
  const w = page.region('wait');
  assert.match(w, /<div class="eyebrow">Waiting for you<\/div><h2>Check the files<\/h2>/);
  assert.match(w, /<span class="pill amber">Paused<\/span>/);
  assert.ok(w.includes('<p class="pl-wait-message">' + CONFIRM_MESSAGE + '</p>'));
  assert.doesNotMatch(w, /Sign in|Your action is needed/);
  /* the notes, prominent: a notice before the list of files */
  assert.match(w, /<div class="notice pl-warning pl-notes" role="note"><strong>The loader could not fully cover these places<\/strong>/);
  for (const note of NOTES) assert.ok(w.includes('<li>' + note + '</li>'), note);
  assert.ok(w.indexOf('pl-notes') < w.indexOf('pl-files-box'), 'the notes come before the files');
  /* the files: a count, a scrolling box that the keyboard can reach, every name with its group */
  assert.match(w, /<h3>40 files fetched<\/h3>/);
  assert.match(w, /<div class="pl-files-box" role="region" aria-label="Files fetched from the task page" tabindex="0">/);
  assert.equal((w.match(/<li><span class="pl-file-name">/g) || []).length, 40);
  assert.match(w, /<li><span class="pl-file-name">Atlas_File_01\.csv<\/span> <span class="pl-file-group muted">World files<\/span><\/li>/);
  assert.match(w, /<li><span class="pl-file-name">Atlas_File_40\.csv<\/span>[^]*?Task files<\/span><\/li>/);
  /* the skipped files with their reasons, and the toggle result */
  assert.match(w, /<h3>Skipped \(2\)<\/h3><ul class="pl-names"><li>Atlas_Thumbs\.db <span class="muted">a system file<\/span><\/li><li>Atlas_Archive_2019\.zip <span class="muted">larger than the size cap<\/span><\/li><\/ul>/);
  assert.match(w, /<h3>Show all files<\/h3><p class="pl-toggle-line">Found and turned on \(\u201CShow all files\u201D\)\. 4 files offered before, 9 after\.<\/p>/);
  /* two buttons, in words; the first is not the yellow primary */
  assert.match(w, /<button type="button" data-pl="continue" data-pl-key="continue" >Every file is there: continue<\/button>/);
  assert.match(w, /<button type="button" class="danger" data-pl="stop" data-pl-key="wait-stop" >Stop<\/button>/);
  assert.doesNotMatch(w, /class="primary"/);
  assert.equal(page.stage(), 'Waiting for you: check the files');
  assert.doesNotMatch(w + page.stage(), /%/, 'no percentage');
  assert.equal(stepsOf(page.region('timeline'))[0].s, 'waiting', 'the import step waits for the owner');
  assert.equal(stepsOf(page.region('timeline'))[0].caption, 'Waiting for you');
  assert.match(page.region('wait'), /Every file is there/);
  assert.match(page.region('actions'), /data-pl="stop"/, 'Stop is also in the bar');
  /* the stage bar is the same whatever the message says, and a message the companion left out has words of the page's own */
  companion.update('pl-atlas-0001', { waiting: { kind: 'confirm-files' } });
  await page.tick();
  assert.equal(page.stage(), 'Waiting for you: check the files');
  assert.match(page.region('wait'), /<p class="pl-wait-message">Compare the files below with the task page in the Chrome window\./);
});

test('Every file is there: continue posts to the continue route once; Stop in the card posts to the stop route', async t => {
  const { companion, page } = await bootWith(t, [confirmState()]);
  await page.click('continue');
  const posts = companion.calls.filter(c => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/pipeline/pl-atlas-0001/continue');
  assert.equal(posts[0].nonce, 'nonce-fake-1');
  assert.equal(page.region('wait'), '', 'the card is gone once the companion has no wait');
  const { companion: other, page: stopper } = await bootWith(t, [confirmState()]);
  const tag = stopper.region('wait').match(/<button[^>]*data-pl-key="wait-stop"[^>]*>/)[0];
  assert.ok(tag && !/disabled/.test(tag));
  await stopper.click('stop');
  const stops = other.calls.filter(c => c.method === 'POST');
  assert.equal(stops.length, 1);
  assert.equal(stops[0].url, '/api/pipeline/pl-atlas-0001/stop');
  assert.match(stopper.region('verdict'), /Stopped by you/);
});

test('the confirm-files card copes with a missing list, a short list, nothing skipped and no notes, and with markup in names', async t => {
  const { companion, page } = await bootWith(t, [confirmState({}, { files: undefined, skipped: [], notes: [], toggle: null })]);
  let w = page.region('wait');
  assert.match(w, /<h2>Check the files<\/h2>/);
  assert.match(w, /<h3>Files \(40\)<\/h3><p class="muted">The companion sent no list of the files\.<\/p>/);
  assert.doesNotMatch(w, /Skipped|pl-notes|Show all files<\/h3>|pl-files-box/);
  companion.update('pl-atlas-0001', { import: importFacts({ fileCount: 0, files: [] , skipped: [], notes: [] }) });
  await page.tick();
  assert.match(page.region('wait'), /The import fetched no file\./);
  companion.update('pl-atlas-0001', { import: importFacts({ fileCount: 1, files: [{ name: '<b>x</b>.csv', group: '<i>g</i>' }, 'plain.txt', { group: 'nameless' }, null], skipped: [], notes: ['<script>1</script>', '', 7] }) });
  await page.tick();
  w = page.region('wait');
  assert.match(w, /<h3>1 file fetched<\/h3>/);
  assert.match(w, /&lt;b&gt;x&lt;\/b&gt;\.csv<\/span> <span class="pl-file-group muted">&lt;i&gt;g&lt;\/i&gt;<\/span>/);
  assert.match(w, /<li><span class="pl-file-name">plain\.txt<\/span><\/li>/);
  assert.equal((w.match(/pl-file-name/g) || []).length, 2, 'an entry without a name is not listed');
  assert.match(w, /<li>&lt;script&gt;1&lt;\/script&gt;<\/li><li>7<\/li>/);
  assert.doesNotMatch(w, /<b>|<script>|<i>/);
});

test('the confirm-files card with fields withheld (the whole field, or entry by entry): "Withheld while a round runs", no crash', async t => {
  const W = { withheld: true };
  const { companion, page } = await bootWith(t, [confirmState({ redacted: true, waiting: { kind: 'confirm-files', message: W, since: 'x' } }, { files: W, skipped: W, notes: W, toggle: W })]);
  let w = page.region('wait');
  const marker = '<span class="pl-withheld">Withheld while a round runs</span>';
  assert.ok(w.includes('<p class="pl-wait-message">' + marker + '</p>'), 'the message');
  assert.match(w, /<h3>Files<\/h3><p class="pl-withheld">Withheld while a round runs<\/p>/);
  assert.match(w, /<h3>Skipped<\/h3><p class="pl-withheld">Withheld while a round runs<\/p>/);
  assert.match(w, /<h3>Show all files<\/h3><p class="pl-toggle-line"><span class="pl-withheld">Withheld while a round runs<\/span><\/p>/);
  assert.doesNotMatch(w, /\[object Object\]|undefined|>null</);
  assert.match(w, /Every file is there: continue/);
  assert.equal(page.stage(), 'Waiting for you: check the files');
  companion.update('pl-atlas-0001', { import: importFacts({ fileCount: 3, files: [{ name: W, group: 'World files' }, W, { name: 'Atlas_File_03.csv', group: W }], skipped: [{ name: W, why: W }, W, { name: 'Atlas_Thumbs.db', why: W }], notes: [W, 'A frame could not be read.'], toggle: { found: W, label: W, flipped: W } }) });
  await page.tick();
  w = page.region('wait');
  assert.equal((w.match(/<li><span class="pl-file-name">/g) || []).length, 3);
  assert.ok(w.includes('<span class="pl-file-name">' + marker + '</span>'));
  assert.ok(w.includes('<span class="pl-file-group muted">' + marker + '</span>'));
  assert.ok(w.includes('<li>' + marker + ' <span class="muted">' + marker + '</span></li>'), 'a skipped entry with both parts withheld');
  assert.ok(w.includes('<li>' + marker + '</li>'), 'a withheld note');
  assert.match(w, /<li>A frame could not be read\.<\/li>/);
  assert.doesNotMatch(w, /\[object Object\]|undefined|>null</);
  assert.equal(page.statusIsError(), false);
  /* a wait of another kind whose message is withheld */
  companion.update('pl-atlas-0001', { waiting: { kind: 'needs-person', message: W } });
  await page.tick();
  assert.ok(page.region('wait').includes('<p class="pl-wait-message">' + marker + '</p>'));
  assert.match(page.stage(), /^Waiting for you: Your action is needed in the Chrome window\./);
});

test('import.notes show in the import card at any time, not only during the wait; withheld notes say so', async t => {
  const { companion, page } = await bootWith(t, [baseState({ stage: 'classify', import: importFacts({ notes: NOTES }) })]);
  let i = page.region('import');
  assert.match(i, /<div class="notice pl-warning pl-notes" role="note"><strong>The loader could not fully cover these places<\/strong>/);
  for (const note of NOTES) assert.ok(i.includes('<li>' + note + '</li>'), note);
  assert.ok(i.indexOf('pl-notes') > i.indexOf('<dl'), 'after the facts');
  assert.equal(page.region('wait'), '', 'no wait, and the notes are still there');
  for (const stage of ['design', 'screen', 'test']) {
    companion.update('pl-atlas-0001', { stage, design: designFacts() });
    await page.tick();
    assert.match(page.region('import'), /pl-notes/, stage);
  }
  const { page: done } = await bootWith(t, [doneState({ import: importFacts({ notes: ['A request was still pending.'] }) })]);
  assert.match(done.region('import'), /<li>A request was still pending\.<\/li>/, 'also after the run has ended');
  const { page: none } = await bootWith(t, [baseState({ stage: 'classify', import: importFacts({ notes: [] }) })]);
  assert.doesNotMatch(none.region('import'), /pl-notes|could not fully cover/);
  const { page: absent } = await bootWith(t, [baseState({ stage: 'classify', import: importFacts() })]);
  assert.doesNotMatch(absent.region('import'), /pl-notes/);
  const { page: hidden } = await bootWith(t, [baseState({ stage: 'screen', redacted: true, import: importFacts({ notes: { withheld: true } }) })]);
  assert.match(hidden.region('import'), /<p class="pl-withheld">Places the loader could not fully cover: Withheld while a round runs<\/p>/);
  assert.doesNotMatch(hidden.region('import'), /\[object Object\]/);
  /* the toggle and the skipped list of the import card cope with a withheld marker too */
  const { page: w2 } = await bootWith(t, [baseState({ stage: 'screen', redacted: true, import: importFacts({ toggle: { withheld: true }, skipped: { withheld: true } }) })]);
  assert.match(w2.region('import'), /<dt>Show all files<\/dt><dd><span class="pl-withheld">Withheld while a round runs<\/span><\/dd>/);
  assert.match(w2.region('import'), /Skipped files: Withheld while a round runs/);
});

/* ====================================================================== import facts and classification */

test('import facts: where it came from, the file counts, and whether the show-all-files option was found, turned on or learned', async t => {
  const { companion, page } = await bootWith(t, [baseState({ stage: 'classify', import: importFacts() })]);
  const facts = page.region('import');
  assert.match(facts, /<dt>Source<\/dt><dd>https:\/\/tasks\.example\/review\/atlas-4821<\/dd>/, 'origin and path only');
  assert.match(facts, /<dt>Files<\/dt><dd>9 files in all · 5 world · 3 task · 2 withheld · 1 other<\/dd>/);
  assert.match(facts, /Found and turned on \(“Show all files”\)\. 4 files offered before, 9 after\./);
  assert.match(facts, /never copied into what the pilots see/);
  companion.update('pl-atlas-0001', { import: importFacts({ toggle: { found: false, label: '', flipped: false, filesBefore: 4, filesAfter: 4, learned: false } }) });
  await page.tick();
  assert.match(page.region('import'), /Not found on the page\./);
  companion.update('pl-atlas-0001', { import: importFacts({ toggle: { found: true, label: 'Reveal everything', flipped: true, filesBefore: 4, filesAfter: 9, learned: true } }) });
  await page.tick();
  assert.match(page.region('import'), /Turned on from what you showed for this site\. Label: “Reveal everything”\./);
  companion.update('pl-atlas-0001', { import: importFacts({ toggle: { found: false, learned: true, flipped: false } }) });
  await page.tick();
  assert.match(page.region('import'), /Learned from you for this site\./);
  companion.update('pl-atlas-0001', { import: importFacts({ toggle: { found: true, label: 'Show all', flipped: false } }) });
  await page.tick();
  assert.match(page.region('import'), /Found \(“Show all”\), but not turned on\./);
  /* a folder import: no page, no toggle */
  companion.update('pl-atlas-0001', { source: { kind: 'folder', name: 'atlas-task' }, import: { fileCount: 3, files: [{ name: 'a.txt' }, { name: 'b.txt' }, { name: 'c.txt' }], page: null, toggle: null, skipped: [{ name: 'notes.tmp', why: 'a temporary file' }], facts: undefined } });
  await page.tick();
  assert.match(page.region('import'), /<dt>Source<\/dt><dd>Folder \u201Catlas-task\u201D on this computer<\/dd>/);
  assert.match(page.region('import'), /3 files in all/);
  assert.doesNotMatch(page.region('import'), /Show all files/);
  assert.match(page.region('import'), /<summary>Skipped \(1\)<\/summary><ul class="pl-names"><li>notes\.tmp <span class="muted">a temporary file<\/span><\/li>/);
  companion.update('pl-atlas-0001', { source: { kind: 'folder' }, import: { fileCount: 3 } });
  await page.tick();
  assert.match(page.region('import'), /<dt>Source<\/dt><dd>A folder on this computer<\/dd>/, 'a folder with no name');
});

test('classification shows names only: which section or file is the prompt, the guideline and the golden answer', async t => {
  const { page } = await bootWith(t, [baseState({ stage: 'design', import: importFacts(), classification: classification() })]);
  const c = page.region('classify');
  assert.match(c, /<dt>Business prompt<\/dt><dd>Section “Business request”<\/dd>/);
  assert.match(c, /<dt>Grader guideline<\/dt><dd>File “Atlas_Grader_Guide\.docx”<\/dd>/);
  assert.match(c, /<dt>Golden answer<\/dt><dd>File “Atlas_Reference_Answer\.docx”<\/dd>/);
  assert.match(c, /<summary>File lists<\/summary>/);
  assert.match(c, /World files \(2\)/);
  assert.match(c, /Task files \(1\)/);
  assert.match(c, /Withheld from the pilots \(2\)/);
  assert.match(c, /<li>Meridian_Ledger\.xlsx<\/li>/);
  assert.doesNotMatch(c, /Award full credit|Usable cash is 1,250/, 'only names, never the text of the guideline or the answer');
  assert.match(page.region('import'), /5 world · 3 task · 2 withheld/, 'counts come from the import, else from the lists');
});

test('a classification that did not find a part says so', async t => {
  const { page } = await bootWith(t, [baseState({ stage: 'design', classification: { prompt: { section: 'Request' }, worldFiles: ['a.csv'], taskFiles: [], other: [] } })]);
  assert.match(page.region('classify'), /<dt>Grader guideline<\/dt><dd>Not found<\/dd>/);
  assert.match(page.region('classify'), /<dt>Golden answer<\/dt><dd>Not found<\/dd>/);
  assert.match(page.region('import'), /1 world · 0 task · 0 other/, 'counts fall back to the lists');
});

/* ====================================================================== traps */

test('traps: titles, new files, and the edited world files with their reasons, highlighted as edits', async t => {
  const { page } = await bootWith(t, [baseState({ stage: 'screen', design: designFacts() })]);
  const d = page.region('design');
  assert.match(d, /Attempt 1/);
  assert.match(d, /<strong>Superseded facility schedule<\/strong>/);
  assert.match(d, /<strong>Rounded inputs rebuilt into a total<\/strong>/);
  assert.match(d, /New files \(2\)/);
  assert.match(d, /<li>Atlas_Amendment_2\.txt<\/li>/);
  assert.match(d, /Edited world files \(1\)/);
  assert.match(d, /<li class="pl-edit"><span class="pill amber">Edited world file<\/span> <strong>Atlas_Facility_Schedule\.csv<\/strong><span class="pl-edit-reason">The decoy needs the old rate in column C\.<\/span><\/li>/);
  assert.match(d, /<dt>Correct value<\/dt><dd><span>1,250<\/span><\/dd>/);
  assert.match(d, /<dt>Wrong value<\/dt><dd><span>1,900<\/span><\/dd>/);
  assert.match(d, /<summary>Revised prompt, grader guideline and golden answer<\/summary>/);
  assert.match(d, /Award full credit when the answer holds the borrowing on 1,250 of usable cash\./);
  assert.match(d, /Fingerprints/);
  assert.match(d, /Counts available credit as cash/);
});

test('with no edit to a world file the card says the originals are untouched, and an edit without a reason says so', async t => {
  const { companion, page } = await bootWith(t, [baseState({ stage: 'screen', design: designFacts({ editedFiles: [] }) })]);
  assert.match(page.region('design'), /Edited world files \(0\)/);
  assert.match(page.region('design'), /No existing world file was edited\. The originals are never changed\./);
  assert.doesNotMatch(page.region('design'), /pl-edit"/);
  companion.update('pl-atlas-0001', { design: designFacts({ editedFiles: [{ name: 'Meridian_Ledger.xlsx' }, 'Borealis_Readme.txt'] }) });
  await page.tick();
  assert.match(page.region('design'), /Edited world files \(2\)/);
  assert.match(page.region('design'), /No reason was given\./);
});

test('a redesign shows its attempt number on the traps card', async t => {
  const { page } = await bootWith(t, [baseState({ stage: 'screen', redesigns: 2, design: designFacts({ attempt: undefined }) })]);
  assert.match(page.region('design'), /Attempt 3/);
});

/* ====================================================================== the designer's review: calibration, fairness, guideline changes, diffs, warnings */

const DIFF = '--- Atlas_Facility_Schedule.csv\n+++ Atlas_Facility_Schedule.csv\n@@ -2,1 +2,1 @@\n-Rate,4.00%\n+Rate,6.00%\n';
const GUIDELINE_DIFF = '@@ -1,2 +1,3 @@\n Award full credit when the answer holds the borrowing.\n-Count the available facility as cash.\n+Do not count the available facility as cash.\n';
const review = (over = {}) => ({
  calibration: { score: 0.97, verdict: 'meets-guidance', reason: 'Matches every rubric line.' },
  fairness: { unfair: [] },
  guidelineDiff: GUIDELINE_DIFF,
  rubricChanges: [{ change: 'Added a line about the amended facility date', reason: 'The new trap turns on that date.' }],
  ...over,
});
const withReview = (over = {}, designOver = {}) => baseState({ stage: 'screen', design: designFacts({ ...review(over), ...designOver }) });

test('calibration: the golden answer\'s score against the revised guideline, the 0.90 it needs, passed or failed in words, the grader\'s verdict and reason', async t => {
  const { companion, page } = await bootWith(t, [withReview()]);
  let d = page.region('design');
  assert.match(d, /<h3>Calibration<\/h3><p><span class="pill green">Calibration passed<\/span> The golden answer scored <strong>0\.97<\/strong> against the revised grader guideline\. It needs 0\.90 or more\.<\/p>/);
  assert.match(d, /Grader verdict: <span>meets-guidance<\/span>\. Reason: <span>Matches every rubric line\.<\/span>/);
  assert.ok(d.indexOf('<h3>Calibration</h3>') > d.indexOf('Edited world files'), 'it sits in the traps card after the files');
  for (const [score, word, shown] of [[0.9, 'passed', '0.90'], [0.62, 'failed', '0.62'], [0.8996, 'failed', '0.90 (0.8996)'], [1, 'passed', '1.00']]) {
    companion.update('pl-atlas-0001', { design: designFacts(review({ calibration: { score, verdict: 'v', reason: 'r' } })) });
    await page.tick();
    d = page.region('design');
    assert.match(d, new RegExp(`Calibration ${word}</span> The golden answer scored <strong>${shown.replace(/[().]/g, '\\$&')}</strong>`), `score ${score}`);
    assert.match(d, new RegExp(`pill ${word === 'passed' ? 'green' : 'red'}">Calibration ${word}`));
  }
  companion.update('pl-atlas-0001', { design: designFacts(review({ calibration: { score: null, verdict: '', reason: '' } })) });
  await page.tick();
  d = page.region('design');
  assert.match(d, /The golden answer has not been graded against the revised grader guideline yet\./);
  assert.doesNotMatch(d, /Grader verdict/, 'no verdict line without a verdict or a reason');
});

test('calibration, fairness, the guideline changes and the file diffs show nothing at all when the companion sent none of them', async t => {
  const { page } = await bootWith(t, [baseState({ stage: 'screen', design: designFacts() })]);
  const d = page.region('design');
  for (const word of ['Calibration', 'Fairness review', 'What the designer changed in the grader guideline', 'What changed in', 'Size change', 'Rubric changes']) assert.ok(!d.includes(word), word + ' is absent');
  assert.match(d, /Edited world files \(1\)/, 'the rest of the card is unchanged');
  assert.doesNotMatch(page.region('classify'), /Warning/);
});

test('fairness review: nothing unfair, or each flagged item with its reason, the count in words', async t => {
  const { companion, page } = await bootWith(t, [withReview()]);
  assert.match(page.region('design'), /<h3>Fairness review<\/h3><p><span class="pill green">No unfair item<\/span> The fairness review found no unfair item\.<\/p>/);
  companion.update('pl-atlas-0001', { design: designFacts(review({ fairness: { unfair: [{ item: 'The amended date is only in a footnote', why: 'A careful solver has no way to know which schedule governs.' }, { item: 'Figures in thousands', why: 'The golden answer is in units.' }] } })) });
  await page.tick();
  const d = page.region('design');
  assert.match(d, /<span class="pill amber">2 unfair items<\/span> The fairness review flagged these\./);
  assert.match(d, /<li class="pl-unfair"><strong>The amended date is only in a footnote<\/strong><span class="pl-edit-reason">A careful solver has no way to know which schedule governs\.<\/span><\/li>/);
  assert.match(d, /<strong>Figures in thousands<\/strong>/);
  companion.update('pl-atlas-0001', { design: designFacts(review({ fairness: { unfair: [{ item: 'One thing', why: '' }] } })) });
  await page.tick();
  assert.match(page.region('design'), /<span class="pill amber">1 unfair item<\/span>/);
  assert.match(page.region('design'), /No reason was given\./);
});

test('the guideline changes sit in a collapsed details: the rubric changes with their reasons and the line diff, added and removed lines marked by their first character and a class', async t => {
  const { page } = await bootWith(t, [withReview()]);
  const d = page.region('design');
  assert.match(d, /<details class="pl-changes"><summary>What the designer changed in the grader guideline<\/summary>/, 'collapsed: no open attribute');
  assert.doesNotMatch(d, /<details[^>]*\sopen/);
  assert.match(d, /<h3>Rubric changes \(1\)<\/h3><ul class="pl-names"><li>Added a line about the amended facility date <span class="muted">Why: The new trap turns on that date\.<\/span><\/li><\/ul>/);
  assert.match(d, /<h3>Line changes<\/h3><pre class="pl-text pl-diff">/);
  assert.match(d, /<span class="pl-diff-hunk">@@ -1,2 \+1,3 @@\n<\/span>/);
  assert.match(d, /<span class="pl-diff-del">-Count the available facility as cash\.\n<\/span>/);
  assert.match(d, /<span class="pl-diff-add">\+Do not count the available facility as cash\.<\/span><\/pre>/);
  assert.match(d, /<span class="pl-diff-same"> Award full credit when the answer holds the borrowing\.\n<\/span>/);
});

test('the guideline changes: only the rubric list, only the diff, an empty diff, an empty list, and a diff that is too long', async t => {
  const { companion, page } = await bootWith(t, [withReview({ guidelineDiff: undefined })]);
  let d = page.region('design');
  assert.match(d, /What the designer changed in the grader guideline/);
  assert.doesNotMatch(d, /Line changes/);
  companion.update('pl-atlas-0001', { design: designFacts(review({ rubricChanges: undefined })) });
  await page.tick();
  d = page.region('design');
  assert.match(d, /Line changes/);
  assert.doesNotMatch(d, /Rubric changes/);
  companion.update('pl-atlas-0001', { design: designFacts(review({ rubricChanges: [], guidelineDiff: '' })) });
  await page.tick();
  d = page.region('design');
  assert.match(d, /The designer listed no rubric change\./);
  assert.match(d, /<h3>Line changes<\/h3><p class="muted">No line changed\.<\/p>/);
  companion.update('pl-atlas-0001', { design: designFacts(review({ guidelineDiff: '+' + 'x'.repeat(9000) })) });
  await page.tick();
  assert.match(page.region('design'), /\[shortened for this page\]/);
});

test('each edited world file may carry a diff in its own collapsed details, and a size change in words', async t => {
  const edited = (extra) => designFacts({ editedFiles: [{ name: 'Atlas_Facility_Schedule.csv', reason: 'The decoy needs the old rate in column C.', bytes: 2000, ...extra }] });
  const { companion, page } = await bootWith(t, [baseState({ stage: 'screen', design: edited({ diff: DIFF, sizeChange: 120 }) })]);
  let d = page.region('design');
  assert.match(d, /<li class="pl-edit"><span class="pill amber">Edited world file<\/span> <strong>Atlas_Facility_Schedule\.csv<\/strong> <span class="pl-edit-size">Size change: \+120 bytes<\/span><span class="pl-edit-reason">The decoy needs the old rate in column C\.<\/span><details class="pl-diff-box"><summary>What changed in Atlas_Facility_Schedule\.csv<\/summary>/);
  assert.doesNotMatch(d, /pl-diff-box"[^>]*\sopen/, 'collapsed');
  assert.match(d, /<span class="pl-diff-del">-Rate,4\.00%\n<\/span>/);
  assert.match(d, /<span class="pl-diff-add">\+Rate,6\.00%<\/span><\/pre>/);
  for (const [change, shown] of [[-35, '\u221235 bytes'], [0, '0 bytes'], [1234567, '+1,234,567 bytes'], ['+12 lines, -3 lines', '+12 lines, -3 lines'], [{}, null], [null, null]]) {
    companion.update('pl-atlas-0001', { design: edited({ sizeChange: change }) });
    await page.tick();
    d = page.region('design');
    if (shown) assert.ok(d.includes('Size change: ' + shown), shown);
    else assert.ok(!d.includes('Size change'), 'a size change that is neither text nor a number is not shown: ' + JSON.stringify(change));
  }
  companion.update('pl-atlas-0001', { design: edited({ bytes: 2100, beforeBytes: 2000 }) });
  await page.tick();
  assert.match(page.region('design'), /Size change: \+100 bytes/, 'the companion\'s bytes and beforeBytes give the size change when it names none');
  companion.update('pl-atlas-0001', { design: edited({ bytes: 1900, beforeBytes: 2000, sizeChange: 5 }) });
  await page.tick();
  assert.match(page.region('design'), /Size change: \+5 bytes/, 'a size change the companion names wins');
  companion.update('pl-atlas-0001', { design: edited({ bytes: undefined }) });
  await page.tick();
  d = page.region('design');
  assert.ok(!d.includes('pl-diff-box') && !d.includes('Size change'), 'neither a diff nor a size change: just the file and its reason');
  companion.update('pl-atlas-0001', { design: edited({ diff: '' }) });
  await page.tick();
  assert.match(page.region('design'), /<details class="pl-diff-box"><summary>What changed in Atlas_Facility_Schedule\.csv<\/summary><p class="muted">No line changed\.<\/p>/);
});

test('while a round runs the new fields, trap titles and files and edited file names read "Withheld while a round runs", each in its place', async t => {
  const W = { withheld: true };
  const state = baseState({ stage: 'screen', redacted: true, design: {
    attempt: 1,
    traps: [{ id: 't1', title: W, mechanism: W, files: W, decoy: W, correctValue: W, wrongValue: W }, { id: 't2', title: W, mechanism: W, files: [W, W], decoy: W, correctValue: W, wrongValue: W }],
    newFiles: ['Atlas_Amendment_2.txt'], editedFiles: [{ name: W, reason: W, diff: W, sizeChange: W }],
    prompt: W, guideline: W, goldenAnswer: W, gold: W, fingerprints: W, notes: W,
    calibration: W, fairness: W, guidelineDiff: W, rubricChanges: W,
  }, attempts: [attemptOf({ n: 1, traps: [W, W], outcome: 'in-progress' }), attemptOf({ n: 2, traps: W })], redesigns: 1 });
  const { page } = await bootWith(t, [state]);
  const d = page.region('design');
  const withheld = '<span class="pl-withheld">Withheld while a round runs</span>';
  assert.match(d, new RegExp(`<li class="pl-trap"><strong>${withheld.replace(/[()]/g, '\\$&')}</strong> <span class="muted">Files: ${withheld}</span>`), 'a trap whose title and files are withheld');
  assert.equal((d.match(/<li class="pl-trap"><strong><span class="pl-withheld">/g) || []).length, 2, 'both titles');
  assert.match(d, new RegExp(`<li class="pl-edit"><span class="pill amber">Edited world file</span> <strong>${withheld}</strong> <span class="pl-edit-size">Size change: ${withheld}</span><span class="pl-edit-reason">${withheld}</span><details class="pl-diff-box"><summary>What changed in this file</summary><p class="pl-withheld">Withheld while a round runs</p></details>`));
  assert.match(d, /<h3>Calibration<\/h3><p class="pl-withheld">Withheld while a round runs<\/p>/);
  assert.match(d, /<h3>Fairness review<\/h3><p class="pl-withheld">Withheld while a round runs<\/p>/);
  assert.match(d, /<summary>What the designer changed in the grader guideline<\/summary><h3>Rubric changes<\/h3><p class="pl-withheld">Withheld while a round runs<\/p><h3>Line changes<\/h3><p class="pl-withheld">Withheld while a round runs<\/p>/);
  assert.match(d, /<li>Atlas_Amendment_2\.txt<\/li>/, 'a name that is not withheld is shown');
  assert.match(d, /<h3>Checks on the designer’s files<\/h3><p class="pl-withheld">Withheld while a round runs<\/p>/, 'the designer\'s notes are withheld as a whole');
  assert.doesNotMatch(d, /\[object Object\]|undefined|>null</);
  const r = page.region('redesigns');
  assert.match(r, /<td data-label="Traps">Withheld while a round runs, Withheld while a round runs<\/td>/);
  assert.match(r, /<th scope="row">Attempt 2 \(latest\)<\/th><td data-label="Traps">Withheld while a round runs<\/td>/);
});

test('design.unscanned: new or edited files whose text could not be checked are named in the traps card, worded like the classification note', async t => {
  const { companion, page } = await bootWith(t, [baseState({ stage: 'screen', design: designFacts({ unscanned: [{ name: 'Atlas_Amendment_2.pdf', kind: 'new' }, { name: 'Facility_Terms.rtf', kind: 'edited' }, { name: 'Meridian_Note.bin' }] }) })]);
  let d = page.region('design');
  assert.match(d, /<p class="pl-class-note pl-unscanned">The text of these new or edited files could not be checked for guideline or golden-answer passages: Atlas_Amendment_2\.pdf \(new\), Facility_Terms\.rtf \(edited\), Meridian_Note\.bin\.<\/p>/);
  assert.ok(d.indexOf('pl-unscanned') > d.indexOf('Edited world files'), 'it sits in the traps card after the files');
  /* the classification's own note says the same of the original files */
  const { page: cls } = await bootWith(t, [baseState({ stage: 'design', import: importFacts(), classification: { ...classification(), unscanned: ['Atlas_Supplement.pdf'] } })]);
  assert.match(cls.region('classify'), /The text of these files could not be checked for guideline or golden-answer passages: Atlas_Supplement\.pdf\./);
  /* none, an empty list, or a field of the wrong type: no note */
  for (const none of [undefined, null, [], 'Atlas.pdf', 7, [{}], [{ name: '' }], {}]) {
    companion.update('pl-atlas-0001', { design: designFacts({ unscanned: none }) });
    await page.tick();
    assert.doesNotMatch(page.region('design'), /could not be checked/, JSON.stringify(none));
  }
  /* a name that is markup is text */
  companion.update('pl-atlas-0001', { design: designFacts({ unscanned: [{ name: '<img src=x onerror=1>.pdf', kind: 'new' }] }) });
  await page.tick();
  assert.match(page.region('design'), /&lt;img src=x onerror=1&gt;\.pdf \(new\)/);
  assert.doesNotMatch(page.region('design'), /<img/);
  /* the note alone is enough to show the card */
  const { page: only } = await bootWith(t, [baseState({ stage: 'screen', design: { attempt: 1, unscanned: [{ name: 'Atlas_Amendment_2.pdf', kind: 'new' }] } })]);
  assert.match(only.region('design'), /Atlas_Amendment_2\.pdf \(new\)/);
});

test('design.unscanned while a round runs: withheld as a whole, or name by name, it reads "Withheld while a round runs" and does not break the page', async t => {
  const W = { withheld: true };
  const { companion, page } = await bootWith(t, [baseState({ stage: 'screen', redacted: true, design: designFacts({ unscanned: W }) })]);
  assert.match(page.region('design'), /<p class="pl-class-note pl-unscanned">New or edited files whose text could not be checked for guideline or golden-answer passages: <span class="pl-withheld">Withheld while a round runs<\/span>\.<\/p>/);
  companion.update('pl-atlas-0001', { design: designFacts({ unscanned: [{ name: W, kind: 'edited' }, W, { name: 'Meridian_Note.pdf', kind: 'new' }] }) });
  await page.tick();
  const d = page.region('design');
  assert.match(d, /could not be checked for guideline or golden-answer passages: <span class="pl-withheld">Withheld while a round runs<\/span> \(edited\), <span class="pl-withheld">Withheld while a round runs<\/span>, Meridian_Note\.pdf \(new\)\.<\/p>/);
  assert.doesNotMatch(d, /\[object Object\]|undefined|>null</);
  assert.equal(page.statusIsError(), false);
});

test('a withheld list of edited files, of new files, a withheld calibration score and a withheld fairness list are each shown as withheld, not as empty', async t => {
  const W = { withheld: true };
  const { page } = await bootWith(t, [baseState({ stage: 'screen', redacted: true, design: designFacts({ editedFiles: W, newFiles: W, calibration: { score: W, verdict: W, reason: W }, fairness: { unfair: W }, rubricChanges: W, guidelineDiff: undefined }) })]);
  const d = page.region('design');
  assert.match(d, /<h3>Edited world files<\/h3><p class="pl-withheld">Withheld while a round runs<\/p>/);
  assert.match(d, /<h3>New files<\/h3><ul class="pl-names"><li><span class="pl-withheld">Withheld while a round runs<\/span><\/li><\/ul>/);
  assert.match(d, /<h3>Calibration<\/h3><p class="pl-withheld">Withheld while a round runs<\/p><p class="muted">Grader verdict: <span class="pl-withheld">Withheld while a round runs<\/span>\. Reason: <span class="pl-withheld">/);
  assert.match(d, /<h3>Fairness review<\/h3><p class="pl-withheld">Withheld while a round runs<\/p>/);
  assert.doesNotMatch(d, /Line changes/, 'no diff was sent, so none is shown');
});

test('classification warnings are { name, why } and prominent: a notice with its own heading, "name: why" for each, a count pill, before the parts of the task', async t => {
  const warnings = [{ name: 'Meridian_Ledger.xlsx', why: 'it holds a long passage of the guideline or the golden answer' }, { name: 'Borealis_Notes.txt', why: 'it is byte for byte the same as withheld material' }];
  const { companion, page } = await bootWith(t, [baseState({ stage: 'design', classification: { ...classification(), warnings } })]);
  const c = page.region('classify');
  assert.match(c, /<span class="pill amber">2 warnings<\/span>/);
  assert.match(c, /<div class="notice pl-warning" role="note"><strong>Warning: check this before you trust the classification<\/strong><p class="pl-warning-lead">The classifier called each of these a world or task file, but the pilots will not get it\.<\/p><ul class="pl-names"><li>Meridian_Ledger\.xlsx: it holds a long passage of the guideline or the golden answer<\/li><li>Borealis_Notes\.txt: it is byte for byte the same as withheld material<\/li><\/ul><\/div>/);
  assert.ok(c.indexOf('pl-warning') < c.indexOf('<dl class="history-details">'), 'above the prompt, guideline and golden answer');
  assert.match(page.text(), /Warning: check this before you trust the classification/);
  companion.update('pl-atlas-0001', { classification: { ...classification(), warnings: [{ name: 'Only.txt', why: '' }] } });
  await page.tick();
  assert.match(page.region('classify'), /<span class="pill amber">1 warning<\/span>/);
  assert.match(page.region('classify'), /<li>Only\.txt<\/li>/, 'no why, no colon');
  companion.update('pl-atlas-0001', { classification: { ...classification(), warnings: ['Loose.txt', null, 3, {}] } });
  await page.tick();
  assert.match(page.region('classify'), /<span class="pill amber">1 warning<\/span>/, 'a plain name is a warning, junk is not');
  assert.match(page.region('classify'), /<li>Loose\.txt<\/li>/);
  companion.update('pl-atlas-0001', { classification: { ...classification(), warnings: [] } });
  await page.tick();
  assert.doesNotMatch(page.region('classify'), /Warning|pl-warning/);
  companion.update('pl-atlas-0001', { classification: { ...classification(), warnings: 'not a list' } });
  await page.tick();
  assert.doesNotMatch(page.region('classify'), /pl-warning/);
  const W = { withheld: true };
  companion.update('pl-atlas-0001', { classification: { ...classification(), warnings: [{ name: W, why: W }, { name: 'Named.txt', why: W }] } });
  await page.tick();
  assert.match(page.region('classify'), /<li><span class="pl-withheld">Withheld while a round runs<\/span>: <span class="pl-withheld">Withheld while a round runs<\/span><\/li><li>Named\.txt: <span class="pl-withheld">/);
  companion.update('pl-atlas-0001', { classification: { ...classification(), warnings: W } });
  await page.tick();
  assert.match(page.region('classify'), /<span class="pill amber">1 warning<\/span>/);
  assert.match(page.region('classify'), /<li><span class="pl-withheld">Withheld while a round runs<\/span><\/li>/);
});

test('the golden answer suspects and the files whose text could not be checked are short notes, and nothing is said when there are none', async t => {
  const { companion, page } = await bootWith(t, [baseState({ stage: 'design', classification: { ...classification(), goldenAnswer: null, goldenSuspects: ['Atlas_Key.docx', 'Atlas_Model_Answer.xlsx'], unscanned: ['Meridian_Scan.pdf'] } })]);
  let c = page.region('classify');
  assert.match(c, /<p class="pl-class-note">These files look like the golden answer: Atlas_Key\.docx, Atlas_Model_Answer\.xlsx\. None was identified as the golden answer\.<\/p>/);
  assert.match(c, /<p class="pl-class-note">The text of these files could not be checked for guideline or golden-answer passages: Meridian_Scan\.pdf\.<\/p>/);
  companion.update('pl-atlas-0001', { classification: { ...classification(), goldenSuspects: ['Atlas_Key.docx'], unscanned: [] } });
  await page.tick();
  c = page.region('classify');
  assert.match(c, /These files look like the golden answer: Atlas_Key\.docx\.<\/p>/, 'with a golden answer named there is nothing to add');
  assert.doesNotMatch(c, /could not be checked/);
  companion.update('pl-atlas-0001', { classification: { ...classification(), goldenSuspects: [], unscanned: [] } });
  await page.tick();
  assert.doesNotMatch(page.region('classify'), /pl-class-note/);
  const W = { withheld: true };
  companion.update('pl-atlas-0001', { classification: { ...classification(), goldenSuspects: W, unscanned: [W, 'x.pdf'] } });
  await page.tick();
  assert.match(page.region('classify'), /look like the golden answer: Withheld while a round runs\./);
  assert.match(page.region('classify'), /could not be checked for guideline or golden-answer passages: Withheld while a round runs, x\.pdf\./);
  const { page: only } = await bootWith(t, [baseState({ id: 'pl-atlas-0002', stage: 'design', classification: { prompt: null, worldFiles: [], goldenSuspects: ['k.docx'] } })]);
  assert.match(only.region('classify'), /k\.docx/, 'the card shows for a classification that only has suspects');
});

const STRUCTURED = (over = {}) => ({ available: true, kind: 'text', added: 1, removed: 1, before: 2000, after: 2100, truncated: false, lines: [{ op: ' ', text: 'Award full credit when the answer holds the borrowing.' }, { op: '-', text: 'Count the available facility as cash.' }, { op: '+', text: 'Do not count the available facility as cash.' }], ...over });

test('the diffs as the companion sends them, { available, kind, added, removed, before, after, truncated, lines: [{ op, text }] }, read like text, with the counts and the notes', async t => {
  const { companion, page } = await bootWith(t, [baseState({ stage: 'screen', design: designFacts({ guidelineDiff: STRUCTURED(), rubricChanges: [], editedFiles: [{ name: 'Atlas_Facility_Schedule.csv', reason: 'r', bytes: 2100, beforeBytes: 2000, diff: STRUCTURED({ lines: [{ op: '-', text: 'Rate,4.00%' }, { op: '+', text: 'Rate,6.00%' }] }) }] }) })]);
  let d = page.region('design');
  assert.match(d, /<h3>Line changes<\/h3><p class="muted pl-diff-count">1 line added, 1 removed\.<\/p><pre class="pl-text pl-diff"><span class="pl-diff-same"> Award full credit when the answer holds the borrowing\.\n<\/span><span class="pl-diff-del">-Count the available facility as cash\.\n<\/span><span class="pl-diff-add">\+Do not count the available facility as cash\.<\/span><\/pre>/);
  assert.match(d, /<summary>What changed in Atlas_Facility_Schedule\.csv<\/summary><p class="muted pl-diff-count">1 line added, 1 removed\.<\/p><pre class="pl-text pl-diff"><span class="pl-diff-del">-Rate,4\.00%\n<\/span><span class="pl-diff-add">\+Rate,6\.00%<\/span>/);
  assert.match(d, /Size change: \+100 bytes/);
  assert.doesNotMatch(d, /Only the first lines/);
  companion.update('pl-atlas-0001', { design: designFacts({ guidelineDiff: STRUCTURED({ truncated: true }), rubricChanges: [] }) });
  await page.tick();
  assert.match(page.region('design'), /<p class="muted">Only the first lines of the diff are shown\.<\/p>/);
  companion.update('pl-atlas-0001', { design: designFacts({ guidelineDiff: STRUCTURED({ available: false, added: 0, removed: 0, lines: [] }), rubricChanges: [] }) });
  await page.tick();
  assert.match(page.region('design'), /<h3>Line changes<\/h3><p class="muted">The original is not available as text, so there is no line comparison\.<\/p>/);
  companion.update('pl-atlas-0001', { design: designFacts({ guidelineDiff: STRUCTURED({ added: 0, removed: 0, lines: [] }), rubricChanges: [] }) });
  await page.tick();
  assert.match(page.region('design'), /<p class="muted pl-diff-count">0 lines added, 0 removed\.<\/p><p class="muted">No line changed\.<\/p>/);
  companion.update('pl-atlas-0001', { design: designFacts({ editedFiles: [{ name: 'Meridian_Ledger.xlsx', reason: 'r', bytes: 5200, beforeBytes: 5000, diff: { kind: 'binary', before: 5000, after: 5200, added: 0, removed: 0, lines: [], truncated: false } }] }) });
  await page.tick();
  d = page.region('design');
  assert.match(d, /Size change: \+200 bytes/);
  assert.match(d, /<summary>What changed in Meridian_Ledger\.xlsx<\/summary><p class="muted">This file is not compared line by line\. It had 5,000 bytes and has 5,200\.<\/p>/);
  companion.update('pl-atlas-0001', { design: designFacts({ editedFiles: [{ name: 'a.csv', reason: 'r', diff: { kind: 'text', before: 10, after: 4, added: 0, removed: 1, lines: [{ op: '-', text: 'gone' }] } }] }) });
  await page.tick();
  assert.match(page.region('design'), /Size change: −6 bytes/, 'with no byte counts of its own, the size change comes from the diff');
});

test('a regraded pilot shows its average as the score and "Graded twice: a, b"; the score that counts is the one the companion sets', async t => {
  const regraded = (first, second, score) => ({ score, regrade: { first, second, average: score } });
  const { page } = await bootWith(t, [baseState({ stage: 'test', design: designFacts(), screen: stageOf('screen', [0.4, 0.2], true, { 0: regraded(0.38, 0.42, 0.4), 1: { regrade: null } }) })]);
  const s = page.region('screen');
  assert.match(s, /<td data-label="Score">0\.40<small class="pl-regraded">Graded twice: 0\.38, 0\.42<\/small><\/td>/);
  assert.match(s, /<td data-label="Score">0\.20<\/td>/, 'a single grading says nothing extra');
  assert.deepEqual([...s.matchAll(/data-label="Below 0\.40">(.*?)<\/td>/g)].map(m => m[1].replace(/<[^>]*>/g, '')), ['✕ No', '✓ Yes'], 'the average, 0.40, is not below the screen bar');
  const { page: edge } = await bootWith(t, [baseState({ id: 'pl-atlas-0002', stage: 'test', design: designFacts(), screen: stageOf('screen', [0.3996, 0.1], true, { 0: regraded(0.3992, 0.4, 0.3996) }) })]);
  assert.match(edge.region('screen'), /0\.40 \(0\.3996\)<small class="pl-regraded">Graded twice: 0\.40 \(0\.3992\), 0\.40<\/small>/, 'near-bar digits keep the yes or no honest');
  const { page: noScore } = await bootWith(t, [baseState({ id: 'pl-atlas-0003', stage: 'test', design: designFacts(), screen: stageOf('screen', [null, 0.2], true, { 0: { regrade: { first: 0.4, second: 0.5, average: 0.46 }, valid: true, score: null } }) })]);
  assert.match(noScore.region('screen'), /<td data-label="Score">0\.46<small class="pl-regraded">Graded twice: 0\.40, 0\.50<\/small>/, 'if only the average came, it is the score');
  const { page: junk } = await bootWith(t, [baseState({ id: 'pl-atlas-0004', stage: 'test', design: designFacts(), screen: stageOf('screen', [0.3, 0.2], true, { 0: { regrade: 'x' }, 1: { regrade: { first: 0.4 } } }) })]);
  assert.doesNotMatch(junk.region('screen'), /Graded/);
  const { page: hidden } = await bootWith(t, [baseState({ id: 'pl-atlas-0005', stage: 'test', design: designFacts(), screen: stageOf('screen', [0.3, 0.2], null, { 0: { regrade: { withheld: true } } }) })]);
  assert.match(hidden.region('screen'), /Graded twice: <span class="pl-withheld">Withheld while a round runs<\/span>/);
});

test('what a pilot wrote besides its answer is one short line: "3 files, 2 read"', async t => {
  const { page } = await bootWith(t, [baseState({ stage: 'test', design: designFacts(), screen: stageOf('screen', [0.3, 0.2, 0.1, 0.2], true, { 0: { outputs: { count: 3, readable: 2 } }, 1: { outputs: { count: 1, readable: 1 } }, 2: { outputs: { count: 2, readable: 0 } }, 3: { outputs: { count: 0, readable: 0 } } }) })]);
  const s = page.region('screen');
  assert.match(s, /<th scope="row">Pilot 1<small class="pl-outputs">3 files, 2 read<\/small><\/th>/);
  assert.match(s, /<th scope="row">Pilot 2<small class="pl-outputs">1 file, 1 read<\/small><\/th>/);
  assert.match(s, /<th scope="row">Pilot 3<small class="pl-outputs">2 files, none read<\/small><\/th>/);
  assert.match(s, /<th scope="row">Pilot 4<\/th>/, 'a pilot that wrote nothing has no line');
  const { page: hidden } = await bootWith(t, [baseState({ id: 'pl-atlas-0002', stage: 'test', design: designFacts(), screen: stageOf('screen', [0.3, 0.2], null, { 0: { outputs: { withheld: true } }, 1: { outputs: 'x' } }) })]);
  assert.match(hidden.region('screen'), /<th scope="row">Pilot 1<small class="pl-outputs"><span class="pl-withheld">Withheld while a round runs<\/span><\/small><\/th>/);
  assert.match(hidden.region('screen'), /<th scope="row">Pilot 2<\/th>/);
});

test('a stage says when a replacement round ran, when none was run because it could not change the result, and when scores are graded twice', async t => {
  const { companion, page } = await bootWith(t, [baseState({ stage: 'test', design: designFacts(), screen: { ...stageOf('screen', [0.3, 0.2], true), replacementSkipped: true } })]);
  let s = page.region('screen');
  assert.match(s, /<p class="muted pl-stage-note">No replacement round was run because it could not change the result\.<\/p>/);
  assert.doesNotMatch(s, /A replacement round ran/);
  assert.doesNotMatch(s, /graded a second time/, 'the band is only explained where a score was graded twice');
  companion.attemptPatch('pl-atlas-0001', { screen: { ...stageOf('screen', [0.3, 0.2, 0.4], true, { 2: { replacement: true, regrade: { first: 0.39, second: 0.41, average: 0.4 } } }), replacementRound: true } });
  await page.tick();
  s = page.region('screen');
  assert.match(s, /A replacement round ran for the pilots without a usable score\./);
  assert.doesNotMatch(s, /No replacement round was run/);
  assert.match(s, /A score from 0\.40 to 0\.50 is graded a second time and the two scores are averaged\./, 'the band comes from the companion');
  const { page: noConfig } = await bootWith(t, [baseState({ stage: 'test', design: designFacts(), screen: stageOf('screen', [0.4, 0.2], true, { 0: { regrade: { first: 0.39, second: 0.41, average: 0.4 } } }) })], { config: {} });
  assert.doesNotMatch(noConfig.region('screen'), /graded a second time/, 'without the companion\'s band the page does not guess one');
});

test('every new field is read defensively: wrong types give nothing, never an error', () => {
  const { adapt } = makeAdapter();
  const junk = [null, 5, 'x', [], true, {}, { score: 'high' }, { unfair: 'x' }, { unfair: [null, 3, {}, 'loose'] }, { first: 1 }, { reasons: 7 }];
  for (const value of junk) {
    const v = adapt(baseState({
      classification: { warnings: value, goldenSuspects: value, unscanned: value },
      design: { calibration: value, fairness: value, guidelineDiff: value, rubricChanges: value, repaired: value, editedFiles: [{ name: 'a', diff: value, sizeChange: value }] },
      attempts: [attemptOf({ rejection: value, repaired: value, note: value, calibration: value, fairness: value, screen: { replacementRound: value, replacementSkipped: value, pilots: [{ score: 0.3, regrade: value, outputs: value }] } })],
    }));
    assert.ok(v, JSON.stringify(value));
    assert.ok(Array.isArray(v.cls.warnings) && Array.isArray(v.cls.goldenSuspects) && Array.isArray(v.cls.unscanned));
    assert.ok(v.design.calibration === null || typeof v.design.calibration === 'object');
    assert.ok(v.design.guidelineDiff === null || typeof v.design.guidelineDiff.text === 'string' || v.design.guidelineDiff.withheld);
    assert.ok(v.attempts[0].rejection === null || typeof v.attempts[0].rejection === 'object');
    assert.ok([true, false].includes(v.design.repaired) || v.design.repaired.withheld);
  }
  const v = adapt(baseState({ design: designFacts({ calibration: 'x', fairness: { unfair: 'x' }, guidelineDiff: 5, rubricChanges: {} }) }));
  assert.equal(v.design.calibration, null);
  assert.equal(v.design.fairness, null);
  assert.equal(v.design.guidelineDiff, null);
  assert.equal(v.design.rubricChanges, null);
  const ok = adapt(baseState({ design: designFacts(review({ fairness: { unfair: [{ item: 'i' }, 'loose', 4] }, rubricChanges: [{ change: 'c' }, 'loose', null], calibration: { score: '0.95' } })) }));
  assert.deepEqual(plain(ok.design.fairness), { status: 'unfair', unfair: [{ item: 'i', why: '' }, { item: 'loose', why: '' }], count: 2 });
  assert.deepEqual(plain(ok.design.rubricChanges), [{ change: 'c', reason: '' }, { change: 'loose', reason: '' }]);
  assert.equal(ok.design.calibration.score, 0.95);
  const withheld = adapt(baseState({ design: designFacts({ calibration: { withheld: true }, fairness: { withheld: true }, guidelineDiff: { withheld: true }, rubricChanges: { withheld: true } }) }));
  assert.deepEqual(plain([withheld.design.calibration, withheld.design.fairness, withheld.design.guidelineDiff, withheld.design.rubricChanges]), Array(4).fill({ withheld: true }));
});

test('adapt() reads the fairness status, the attempt fields and the config the way service.cjs sends them', () => {
  const { adapt } = makeAdapter();
  const f = status => adapt(baseState({ design: designFacts({ fairness: status }) })).design.fairness;
  assert.deepEqual(plain(f({ status: 'ok', unfair: [] })), { status: 'ok', unfair: [], count: 0 });
  assert.deepEqual(plain(f({ status: 'unusable', unfair: [] })), { status: 'unusable', unfair: [], count: 0 });
  assert.deepEqual(plain(f({ status: 'unfair', unfair: [{ item: 'a', why: 'b' }] })), { status: 'unfair', unfair: [{ item: 'a', why: 'b' }], count: 1 });
  assert.equal(f({ status: 'ok' }).status, 'ok', 'a status with no list is enough');
  assert.equal(f({ unfair: [{ item: 'a', why: 'b' }] }).status, 'unfair', 'no status: worked out from the list');
  assert.equal(f({ unfair: [] }).status, 'ok');
  assert.equal(f({ status: 'weird', unfair: [] }).status, 'ok', 'an unknown status is not trusted');
  assert.deepEqual(plain(f({ status: 'unfair', count: 3 })), { status: 'unfair', unfair: [], count: 3 }, 'an attempt carries a count and no list');
  const v = adapt(baseState({ attempts: [attemptOf({ n: 1, outcome: 'rejected', repaired: true, note: 'The companion stopped while this attempt was running.', calibration: { score: 0.62, verdict: 'v', reason: 'r' }, fairness: { status: 'unfair', count: 2 }, rejection: { kind: 'checks', reasons: ['one', 'two'] } })] }));
  const a = v.attempts[0];
  assert.deepEqual(plain([a.outcome, a.repaired, a.note, a.rejection, a.calibration, a.fairness]), ['rejected', true, 'The companion stopped while this attempt was running.', { kind: 'checks', reasons: ['one', 'two'] }, { score: 0.62, verdict: 'v', reason: 'r' }, { status: 'unfair', unfair: [], count: 2 }]);
  assert.equal(adapt(baseState({ attempts: [attemptOf({ rejection: null })] })).attempts[0].rejection, null);
  const g = adapt(baseState({ classification: { ...classification(), goldenSuspects: ['a'], unscanned: ['b', 'c'], warnings: [{ name: 'n', why: 'w' }] } })).cls;
  assert.deepEqual(plain([g.goldenSuspects, g.unscanned, g.warnings]), [['a'], ['b', 'c'], [{ name: 'n', why: 'w' }]]);
  assert.equal(adapt(baseState({ config: { acceptMissing: true } })).acceptMissing, true);
  assert.equal(adapt(baseState({})).acceptMissing, false);
  const p = adapt(baseState({ screen: { ...stageOf('screen', [0.5, 0.2], true, { 0: { regrade: { first: 0.4, second: 0.6, average: 0.5 }, outputs: { count: 2, readable: 1 } } }), replacementRound: true, replacementSkipped: true } })).screen;
  assert.deepEqual(plain([p.replacementRound, p.replacementSkipped, p.pilots[0].regrade, p.pilots[0].outputs, p.pilots[0].score]), [true, true, { first: 0.4, second: 0.6, average: 0.5 }, { count: 2, readable: 1 }, 0.5]);
});

test('the fairness review is drawn from its own status: ok, unfair with its items, or unusable', async t => {
  const { companion, page } = await bootWith(t, [withReview({ fairness: { status: 'unusable', unfair: [] } })]);
  assert.match(page.region('design'), /<h3>Fairness review<\/h3><p><span class="pill amber">No usable answer<\/span> The fairness review gave no usable answer\.<\/p>/);
  assert.doesNotMatch(page.region('design'), /No unfair item/, 'no answer is not a clean bill');
  companion.update('pl-atlas-0001', { design: designFacts(review({ fairness: { status: 'ok', unfair: [] } })) });
  await page.tick();
  assert.match(page.region('design'), /<span class="pill green">No unfair item<\/span> The fairness review found no unfair item\./);
  companion.update('pl-atlas-0001', { design: designFacts(review({ fairness: { status: 'unfair', unfair: [{ item: 'One', why: 'Because.' }, { item: 'Two', why: 'Also.' }] } })) });
  await page.tick();
  assert.match(page.region('design'), /<span class="pill amber">2 unfair items<\/span> The fairness review flagged these\./);
  companion.update('pl-atlas-0001', { design: designFacts(review({ fairness: { status: 'unfair', count: 3 } })) });
  await page.tick();
  assert.match(page.region('design'), /<span class="pill amber">3 unfair items<\/span> The fairness review flagged an item\./, 'a status and a count, no list');
  assert.doesNotMatch(page.region('design'), /pl-unfair/);
});

test('a repair turn the designer needed is said once in the traps card', async t => {
  const { companion, page } = await bootWith(t, [baseState({ stage: 'screen', design: designFacts({ repaired: true }) })]);
  assert.match(page.region('design'), /<p class="muted pl-repaired">The designer needed one repair turn to fix its files\.<\/p>/);
  companion.update('pl-atlas-0001', { design: designFacts({ repaired: false }) });
  await page.tick();
  assert.doesNotMatch(page.region('design'), /repair turn/);
  companion.update('pl-atlas-0001', { design: designFacts({ repaired: { withheld: true } }) });
  await page.tick();
  assert.match(page.region('design'), /Whether a repair turn was needed: <span class="pl-withheld">Withheld while a round runs<\/span>/);
});

test('the start form has the withheld-files choice: off by default, never needed for the button, sent as acceptMissing, and spent by a start', async t => {
  const { companion, page } = await bootWith(t);
  const form = page.region('start-form');
  assert.match(form, /<label class="check pl-accept"><input type="checkbox" data-pl-in="acceptMissing" data-pl-key="accept-missing" ><span><strong>Start even if a world or task file has to be withheld \(the pilots will not get it\)<\/strong>/, 'unticked, with the exact label');
  assert.ok(!ACK_IDS.includes('acceptMissing') && !/acceptMissing/.test(JSON.stringify(page.pipeline.ACKNOWLEDGEMENTS)), 'it is not an acknowledgement');
  await page.fillLink();
  await page.ackAll();
  assert.equal(page.enabled('start'), true, 'the button needs the four acknowledgements and nothing about this box');
  await page.type('acceptMissing', { checked: true });
  assert.match(page.region('start-form'), /data-pl-in="acceptMissing"/);
  assert.equal(page.enabled('start'), true);
  await page.click('start');
  const post = companion.calls.find(c => c.url === '/api/pipeline/start');
  assert.equal(post.body.acceptMissing, true, 'sent as true when ticked');
  assert.equal(typeof post.body.acceptMissing, 'boolean');
  companion.update('pl-run-0001', { stage: 'done', running: false });
  await page.tick();
  await page.click('new');
  assert.doesNotMatch(page.region('start-form'), /data-pl-key="accept-missing" checked/, 'the next form starts with the box off again');
});

test('when the pipeline stopped because files would be withheld, the result says so in the words of the box and points at it; no other result does', async t => {
  const message = '2 files the classifier called world or task files are withheld, so the pilots would not get them: Meridian_Ledger.xlsx, Borealis_Notes.txt. If the pilots can do without them, start again with acceptMissing.';
  const { companion, page } = await bootWith(t, [baseState({ stage: 'failed', running: false, summary: message, error: message, classification: { ...classification(), warnings: [{ name: 'Meridian_Ledger.xlsx', why: 'it holds a long passage of the guideline' }] } })]);
  const v = page.region('verdict');
  assert.ok(!v.includes('acceptMissing'), 'the option\'s API name is not shown');
  assert.match(v, /start again with the box “Start even if a world or task file has to be withheld” ticked\./);
  assert.match(v, /<div class="notice pl-accept-note" role="note"><strong>Some files would be withheld from the pilots\.<\/strong> To go on without them, tick “Start even if a world or task file has to be withheld \(the pilots will not get it\)” in the start form, then start again\. <button type="button" class="small" data-pl="accept-form" data-pl-key="accept-form">Open the start form<\/button><\/div>/);
  assert.doesNotMatch(v, /Reason:/, 'the same message is not said twice');
  await page.click('accept-form');
  assert.match(page.region('start-form'), /data-pl-in="acceptMissing"/, 'the start form is open');
  assert.deepEqual(page.focused.slice(-1), ['accept-missing'], 'and the keyboard is on the box');
  for (const [stage, text] of [['failed', 'The pipeline hit an internal error.'], ['done', ''], ['stopped', '']]) {
    const { page: other } = await bootWith(t, [baseState({ id: 'pl-atlas-0009', stage, summary: text, error: text })]);
    assert.doesNotMatch(other.region('verdict'), /pl-accept-note|Open the start form/, stage);
  }
});

test('the cost line uses the companion\'s caps and says reservations include the headroom; without its rules it says only what the page knows', async t => {
  const { page } = await bootWith(t);
  const limits = () => page.region('start-foot').match(/<p class="footnote pl-limits">([^<]*)<\/p>/)[1];
  assert.equal(limits(), 'Each pilot is capped at USD 3.00, so a 2-pilot screen can cost up to USD 6.00 and a 5-pilot test up to USD 15.00. The 5 test pilots run only when both screen pilots score below 0.40, and a round stops as soon as its result is decided. The other calls are capped too: the classifier USD 0.50, the designer USD 5.00 and one repair turn USD 1.00, the fairness review USD 0.25, each grader call USD 0.50. The total cap of USD 60.00 covers everything. Before each step the run reserves its worst case with 15% headroom on top, and stops when that would pass the total cap.');
  const { page: custom } = await bootWith(t, [], { config: { classifyCapUsd: 0.75, designCapUsd: 8, repairCapUsd: 2, fairnessCapUsd: 0.4, graderCapUsd: 0.6, goldenMin: 0.9, regradeBand: [0.4, 0.5], headroom: 1.25 } });
  const text = custom.region('start-foot').match(/<p class="footnote pl-limits">([^<]*)<\/p>/)[1];
  assert.match(text, /the classifier USD 0\.75, the designer USD 8\.00 and one repair turn USD 2\.00, the fairness review USD 0\.40, each grader call USD 0\.60/);
  assert.match(text, /with 25% headroom on top/, 'the headroom is the companion\'s');
  const { page: bare } = await bootWith(t, [], { config: {} });
  const old = bare.region('start-foot').match(/<p class="footnote pl-limits">([^<]*)<\/p>/)[1];
  assert.equal(old, 'Each pilot is capped at USD 3.00, so a 2-pilot screen can cost up to USD 6.00 and a 5-pilot test up to USD 15.00. The 5 test pilots run only when both screen pilots score below 0.40, and a round stops as soon as its result is decided. The classifier, designer and grader runs cost extra. The total cap of USD 60.00 covers everything.');
  const { page: partial } = await bootWith(t, [], { config: { fairnessCapUsd: 0.25, headroom: 1 } });
  const some = partial.region('start-foot').match(/<p class="footnote pl-limits">([^<]*)<\/p>/)[1];
  assert.match(some, /The other calls are capped too: the fairness review USD 0\.25\./);
  assert.doesNotMatch(some, /headroom/, 'no headroom of 1 to speak of');
  await page.type('cap', { value: '12' });
  await page.type('pilotCap', { value: '1' });
  assert.match(limits(), /^Each pilot is capped at USD 1\.00, so a 2-pilot screen can cost up to USD 2\.00 and a 5-pilot test up to USD 5\.00\..*The total cap of USD 12\.00 covers everything\./);
  assert.match(limits(), /The 5 test pilots run only when both screen pilots score below 0\.40, and a round stops as soon as its result is decided\./, 'the test pilots only run when the screen passes');
  /* the screen bar is the companion's when it reports one */
  const { page: barred } = await bootWith(t, [], { config: { screenBar: 0.35, testBar: 0.5 } });
  assert.match(barred.region('start-foot').match(/<p class="footnote pl-limits">([^<]*)<\/p>/)[1], /run only when both screen pilots score below 0\.35,/);
});

test('the calibration minimum is the companion\'s goldenMin, and the page knows 0.90 when it says none', async t => {
  const { companion, page } = await bootWith(t, [withReview({ calibration: { score: 0.93, verdict: 'v', reason: 'r' } })], { config: { goldenMin: 0.95 } });
  assert.match(page.region('design'), /Calibration failed<\/span> The golden answer scored <strong>0\.93<\/strong> against the revised grader guideline\. It needs 0\.95 or more\./);
  const { page: standard } = await bootWith(t, [withReview({ calibration: { score: 0.93, verdict: 'v', reason: 'r' } })], { config: {} });
  assert.match(standard.region('design'), /Calibration passed<\/span>.*It needs 0\.90 or more\./);
  void companion;
});

test('a state in which every field is withheld is drawn without an error', async t => {
  const W = { withheld: true };
  const everything = baseState({
    stage: 'design', redacted: true, redesigns: 1, summary: W, error: W, message: W, waiting: W,
    import: W, classification: { prompt: W, guideline: W, goldenAnswer: W, worldFiles: W, taskFiles: W, other: W, withheld: W, warnings: W, goldenSuspects: W, unscanned: W, notes: W },
    design: { attempt: W, repaired: W, traps: W, newFiles: W, editedFiles: W, prompt: W, guideline: W, goldenAnswer: W, gold: W, fingerprints: W, notes: W, calibration: W, fairness: W, guidelineDiff: W, rubricChanges: W },
    attempts: [{ n: W, traps: W, outcome: W, repaired: W, note: W, calibration: W, fairness: W, rejection: W, screen: W, test: { passed: W, replacementRound: W, replacementSkipped: W, pilots: [{ n: W, regrade: W, outputs: W, score: W, audit: W, state: W }] } }],
  });
  const { page } = await bootWith(t, [everything]);
  for (const region of ['import', 'classify', 'design', 'screen', 'test', 'redesigns', 'verdict', 'wait', 'spend']) assert.doesNotMatch(page.region(region), /\[object Object\]|undefined|>null</, region);
  assert.match(page.region('classify'), /Withheld while a round runs/);
  assert.match(page.region('design'), /Withheld while a round runs/);
  assert.ok(page.stage().length > 0);
});

test('the copy has no percentage: the spend, the stages and the result say it in dollars and counts', async t => {
  const { page } = await bootWith(t, [doneState()]);
  for (const region of ['spend', 'timeline', 'import', 'classify', 'screen', 'test', 'redesigns', 'verdict']) assert.ok(!page.region(region).includes('%'), region + ' has no percent sign');
  assert.ok(!page.stage().includes('%'));
  const { page: start } = await bootWith(t);
  assert.equal((start.region('start-foot').match(/\d+%/g) || []).join(), '15%', 'the cost headroom note is the one percentage');
  assert.ok(!start.region('start-form').includes('%'));
});

/* ====================================================================== score tables */

const rowsOf = html => [...html.matchAll(/<tr><th scope="row">Pilot (\d+)<\/th><td data-label="Score">(.*?)<\/td><td data-label="Below 0\.\d\d">(.*?)<\/td><td data-label="Audit">(.*?)<\/td><\/tr>/g)].map(m => ({ pilot: Number(m[1]), score: m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(), below: m[3].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(), audit: m[4].replace(/<[^>]*>/g, '').trim() }));

test('the screen table: pilot, score to two decimals, below 0.40 yes or no in words, the audit badge, the bar and the rule', async t => {
  const { page } = await bootWith(t, [baseState({ stage: 'test', design: designFacts(), screen: { passed: true, pilots: pilots([0.3, 0.1]) } })]);
  const s = page.region('screen');
  assert.match(s, /2-pilot screen/);
  assert.match(s, /The screen passes when both pilots score below 0\.40\. If the first pilot to finish scores 0\.40 or more, the other is stopped and the designer starts again\./);
  assert.match(s, /<span class="pill green">Screen passed<\/span>/);
  assert.match(s, /<caption class="sr-only">2-pilot screen: score of each pilot against the bar of 0\.40<\/caption>/);
  assert.match(s, /<th scope="col">Below 0\.40<\/th>/);
  assert.doesNotMatch(s, /0\.45/, 'the screen says nothing of the test bar');
  assert.deepEqual(rowsOf(s), [{ pilot: 1, score: '0.30', below: '✓ Yes', audit: 'CLEAN' }, { pilot: 2, score: '0.10', below: '✓ Yes', audit: 'CLEAN' }]);
  assert.match(s, /2 of 2 below 0\.40; both needed\./);
  assert.match(s, /<span class="pill green">CLEAN<\/span>/);
});

test('a failed screen: a score at or above the bar is No, the pill says Screen failed, and the tally counts honestly', async t => {
  const { page } = await bootWith(t, [baseState({ stage: 'redesign', redesigns: 0, design: designFacts(), screen: { passed: false, pilots: pilots([0.4, 0.2]) } })]);
  const s = page.region('screen');
  assert.deepEqual(rowsOf(s).map(r => [r.score, r.below]), [['0.40', '✕ No'], ['0.20', '✓ Yes']]);
  assert.match(s, /<span class="pill red">Screen failed<\/span>/);
  assert.match(s, /1 of 2 below 0\.40; both needed\./);
});

/* ---- the owner's rules for the pilot stages: the screen bar 0.40 and the test bar 0.45, and rounds that stop as soon as their result is decided ---- */

/* the pilot record of a pilot the round no longer needed, as the orchestrator keeps it (stoppedEarly: true and the reason in stoppedReason) */
const notNeeded = (kind, after) => ({ state: 'cancelled', score: null, valid: false, belowBar: null, audit: null, stoppedEarly: true, stoppedReason: `Not graded: the ${kind} was already decided after pilot ${after}.` });
const cell = (html, label) => [...html.matchAll(new RegExp(`<td data-label="${label}">(.*?)</td>`, 'g'))].map(m => m[1]);
const strip = x => x.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
/* The rows of the redesign table, one object per attempt with the text of each cell under its own column (traps, screen, test, outcome, design_checks):
   a result that sits in the wrong column fails the test that reads it. */
const redesignRowsOf = html => [...html.matchAll(/<tr><th scope="row">([^<]*)<\/th>(.*?)<\/tr>/g)].map(m => ({ attempt: m[1], ...Object.fromEntries([...m[2].matchAll(/<td data-label="([^"]+)">(.*?)<\/td>/g)].map(c => [c[1].toLowerCase().replace(/ /g, '_'), strip(c[2])])) }));

test('the two bars: the screen is below 0.40 and the test below 0.45, in the rules, the column heads, the tallies, the stage line and the start card', async t => {
  const { page } = await bootWith(t, [baseState({ stage: 'grade-test', design: designFacts(), screen: { passed: true, pilots: pilots([0.3, 0.1]) }, test: { passed: null, pilots: pilots([0.1, 0.2, 0.3, 0.9, 0.44]) } })]);
  const sc = page.region('screen'), te = page.region('test');
  assert.match(sc, /The screen passes when both pilots score below 0\.40\./);
  assert.match(sc, /<th scope="col">Below 0\.40<\/th>/);
  assert.match(sc, /against the bar of 0\.40<\/caption>/);
  assert.match(sc, /2 of 2 below 0\.40; both needed\./);
  assert.doesNotMatch(sc, /0\.45/);
  assert.match(te, /The test succeeds when at least 4 of 5 pilots score below 0\.45\. It runs only when the screen has passed, and it stops as soon as 2 pilots score 0\.45 or more \(it cannot pass\) or 4 are below \(it has passed\)\./);
  assert.match(te, /<th scope="col">Below 0\.45<\/th>/);
  assert.match(te, /against the bar of 0\.45<\/caption>/);
  assert.match(te, /4 of 5 below 0\.45; 4 needed\./);
  assert.doesNotMatch(te, /0\.40/);
  assert.equal(page.stage(), 'Test: grading the five answers (4 of 5 must score below 0.45).');
  const { page: sp, companion } = await bootWith(t, [baseState({ stage: 'screen' })]);
  assert.equal(sp.stage(), 'Screen: two blind pilots are working (both must score below 0.40).');
  companion.update('pl-atlas-0001', { stage: 'grade-screen' });
  await sp.tick();
  assert.equal(sp.stage(), 'Screen: grading the two answers (both must score below 0.40).');
  companion.update('pl-atlas-0001', { stage: 'test' });
  await sp.tick();
  assert.equal(sp.stage(), 'Test: five blind pilots are working (4 of 5 must score below 0.45).');
  /* the start card says it all before anything runs, and that the test pilots run only when the screen passes */
  const happens = sp.region('start-foot').match(/<p class="pl-happens">([^<]*)<\/p>/);
  assert.equal(happens, null, 'a pipeline is running, so no start card is open');
  const { page: start } = await bootWith(t);
  const text = start.region('start-foot').match(/<p class="pl-happens">([^<]*)<\/p>/)[1];
  assert.match(text, /two blind pilots run a screen that both must score below 0\.40, then, only if the screen passes, five pilots run a test in which at least 4 of 5 must score below 0\.45\./);
  assert.match(text, /Each round stops as soon as its result is decided/);
  assert.match(start.region('start-foot').match(/<p class="footnote pl-limits">([^<]*)<\/p>/)[1], /The 5 test pilots run only when both screen pilots score below 0\.40, and a round stops as soon as its result is decided\./);
});

test('the bars come from the pipeline\'s own config, else the companion\'s, else 0.40 and 0.45; a bar that is not a usable number is not used', async t => {
  /* the companion's list config */
  const { page: listed } = await bootWith(t, [baseState({ stage: 'grade-test', design: designFacts(), screen: { passed: true, pilots: pilots([0.3, 0.1]) }, test: { passed: null, pilots: pilots([0.1, 0.2, 0.3, 0.9, 0.44]) } })], { config: { screenBar: 0.35, testBar: 0.5 } });
  assert.match(listed.region('screen'), /<th scope="col">Below 0\.35<\/th>/);
  assert.match(listed.region('test'), /<th scope="col">Below 0\.50<\/th>/);
  assert.match(listed.region('test'), /4 of 5 below 0\.50; 4 needed\./, 'the count follows the bar');
  assert.equal(listed.stage(), 'Test: grading the five answers (4 of 5 must score below 0.50).');
  /* the pipeline's own config wins: a run keeps the bars it was started with */
  const own = baseState({ stage: 'grade-test', design: designFacts(), config: { screenBar: 0.3, testBar: 0.55 }, screen: { passed: true, pilots: pilots([0.3, 0.1]) }, test: { passed: null, pilots: pilots([0.1, 0.2, 0.3, 0.9, 0.5]) } });
  const { page: mine } = await bootWith(t, [own], { config: { screenBar: 0.35, testBar: 0.5 } });
  assert.match(mine.region('screen'), /<th scope="col">Below 0\.30<\/th>/);
  assert.deepEqual(rowsOf(mine.region('screen')).map(r => r.below), ['✕ No', '✓ Yes'], '0.30 is not below the screen bar 0.30');
  assert.match(mine.region('test'), /<th scope="col">Below 0\.55<\/th>/);
  assert.match(mine.region('test'), /4 of 5 below 0\.55; 4 needed\./);
  /* none, or not usable: the spec's bars */
  for (const bad of [0, -1, 2, 'x', null, [], { withheld: true }, NaN]) {
    const { page: odd } = await bootWith(t, [{ ...own, config: { screenBar: bad, testBar: bad } }], { config: { screenBar: bad, testBar: bad } });
    assert.match(odd.region('screen'), /<th scope="col">Below 0\.40<\/th>/, JSON.stringify(bad));
    assert.match(odd.region('test'), /<th scope="col">Below 0\.45<\/th>/, JSON.stringify(bad));
  }
  const { page: none } = await bootWith(t, [{ ...own, config: undefined }], { config: {} });
  assert.match(none.region('screen'), /Below 0\.40/);
  assert.match(none.region('test'), /Below 0\.45/);
  /* the result card says what the test needed */
  const { page: done } = await bootWith(t, [doneState({ summary: '', config: { screenBar: 0.4, testBar: 0.5 } })]);
  assert.match(done.region('verdict'), /4 of 5 test pilots scored below 0\.50\./);
  const { page: spec } = await bootWith(t, [doneState({ summary: '' })]);
  assert.match(spec.region('verdict'), /4 of 5 test pilots scored below 0\.45\./);
});

test('a screen stopped after pilot 1: the other pilot is "Stopped: not needed" with its reason (not a failure), and the stage says why it stopped', async t => {
  const stopped = { ...stageOf('screen', [0.62, null], false, { 1: notNeeded('screen', 1) }), stoppedEarly: { afterPilot: 1, score: 0.62 } };
  const { companion, page } = await bootWith(t, [baseState({ stage: 'redesign', redesigns: 1, design: designFacts(), attempts: [attemptOf({ n: 1, outcome: 'screen-failed', screen: stopped })] })]);
  const s = page.region('screen');
  assert.match(s, /<span class="pill red">Screen failed<\/span>/);
  assert.match(s, /<p class="pl-early-stop">Stopped after pilot 1 scored 0\.62: the screen cannot pass\.<\/p>/);
  const rows = rowsOf(s);
  assert.equal(rows[0].score, '0.62');
  assert.equal(rows[0].below, '✕ No');
  assert.equal(rows[1].score, 'Stopped: not needed Not graded: the screen was already decided after pilot 1.', 'the state and the reason');
  assert.equal(rows[1].below, 'Not needed');
  assert.equal(rows[1].audit, 'Not needed');
  assert.match(s, /<td data-label="Score">Stopped: not needed<small class="pl-stopped-reason">Not graded: the screen was already decided after pilot 1\.<\/small><\/td>/);
  assert.match(s, /<span class="pill ?">Not needed<\/span>/, 'a plain pill, not the amber "Not audited"');
  assert.doesNotMatch(s, /No score \(cancelled\)|Replacement pending|counts against the design|Not audited|pill amber/);
  assert.match(s, /0 of 2 below 0\.40; both needed\./);
  assert.match(s, /If the first pilot to finish scores 0\.40 or more, the other is stopped and the designer starts again\./);
  /* the redesign table */
  const [row] = redesignRowsOf(page.region('redesigns'));
  assert.equal(row.attempt, 'Attempt 1 (latest)');
  assert.equal(row.screen, 'Failed (0.62, not needed)', 'the screen column holds the screen result');
  assert.equal(row.test, 'Not run', 'the test column holds none');
  assert.equal(row.outcome, 'Screen failed', 'the outcome column holds the outcome');
  assert.doesNotMatch(row.test + ' | ' + row.outcome, /not needed|0\.62/, 'the screen result is in no other column');
  /* before the companion has decided (passed is null), the pilot is still not a failure and the line says only what happened */
  companion.attemptPatch('pl-atlas-0001', { screen: { ...stopped, passed: null } });
  companion.update('pl-atlas-0001', { stage: 'grade-screen' });
  await page.tick();
  const open = page.region('screen');
  assert.match(open, /<p class="pl-early-stop">Stopped after pilot 1 scored 0\.62\.<\/p>/);
  assert.match(open, /<span class="pill violet">Screen in progress<\/span>/);
  assert.equal(rowsOf(open)[1].below, 'Not needed');
  assert.doesNotMatch(open, /Replacement pending/, 'a stopped pilot is not waiting for a replacement');
  /* a pilot that failed on its own is still a failure */
  companion.attemptPatch('pl-atlas-0001', { screen: stageOf('screen', [0.62, null], false, { 1: { state: 'cancelled', score: null, valid: false, audit: null } }) });
  await page.tick();
  assert.equal(rowsOf(page.region('screen'))[1].score, 'No score (cancelled)');
  assert.doesNotMatch(page.region('screen'), /Stopped after|Stopped: not needed/);
});

test('a test stopped after 2 pilots at or above the bar, and a test stopped once 4 were below: who stopped it, with what score, and what that meant', async t => {
  /* pilots 1 and 3 scored 0.45 or more: the test cannot reach 4 of 5, so pilots 4 and 5 are stopped */
  const failed = { ...stageOf('test', [0.2, 0.71, 0.45, null, null], false, { 3: notNeeded('test', 3), 4: notNeeded('test', 3) }), stoppedEarly: { afterPilot: 3, score: 0.45 } };
  const { companion, page } = await bootWith(t, [baseState({ stage: 'redesign', redesigns: 1, design: designFacts(), attempts: [attemptOf({ n: 1, outcome: 'test-failed', screen: stageOf('screen', [0.2, 0.3], true), test: failed })] })]);
  let s = page.region('test');
  assert.match(s, /<span class="pill red">Test failed<\/span>/);
  assert.match(s, /<p class="pl-early-stop">Stopped after pilot 3 scored 0\.45: the test cannot pass\.<\/p>/);
  assert.deepEqual(rowsOf(s).map(r => (r.score.startsWith('Stopped: not needed') ? 'stopped' : r.score)), ['0.20', '0.71', '0.45', 'stopped', 'stopped']);
  assert.deepEqual(rowsOf(s).map(r => r.below), ['✓ Yes', '✕ No', '✕ No', 'Not needed', 'Not needed']);
  assert.match(s, /1 of 5 below 0\.45; 4 needed\./);
  assert.equal((s.match(/Stopped: not needed/g) || []).length, 2);
  assert.doesNotMatch(s, /No score|Replacement pending|counts against the design/);
  const [trow] = redesignRowsOf(page.region('redesigns'));
  assert.equal(trow.screen, 'Passed (0.20, 0.30)', 'the screen column holds the screen result');
  assert.equal(trow.test, 'Failed (0.20, 0.71, 0.45, not needed, not needed)', 'the test column holds the test result');
  assert.equal(trow.outcome, 'Test failed', 'the outcome column holds the outcome');
  assert.doesNotMatch(trow.screen + ' | ' + trow.outcome, /not needed|0\.71|0\.45/, 'the test result is in no other column');
  assert.doesNotMatch(trow.test + ' | ' + trow.outcome, /Passed|0\.30/, 'the screen result is in no other column');
  /* four below the bar: the test has passed and the fifth pilot is not needed */
  const passed = { ...stageOf('test', [0.1, 0.2, 0.3, 0.4, null], true, { 4: notNeeded('test', 4) }), stoppedEarly: { afterPilot: 4, score: 0.4 } };
  companion.update('pl-atlas-0001', { stage: 'done', running: false, result: { verdict: 'success', message: 'x' }, attempts: [attemptOf({ n: 1, outcome: 'passed', screen: stageOf('screen', [0.2, 0.3], true), test: passed })], redesigns: 0 });
  const { page: ok } = await bootWith(t, [baseState({ id: 'pl-atlas-0002', stage: 'done', running: false, design: designFacts(), result: { verdict: 'success', message: 'x' }, attempts: [attemptOf({ n: 1, outcome: 'passed', screen: stageOf('screen', [0.2, 0.3], true), test: passed })] })]);
  s = ok.region('test');
  assert.match(s, /<span class="pill green">Test passed<\/span>/);
  assert.match(s, /<p class="pl-early-stop">Stopped after pilot 4 scored 0\.40: 4 pilots are below 0\.45, so the test has passed\.<\/p>/);
  assert.equal(rowsOf(s)[4].below, 'Not needed');
  assert.match(s, /4 of 5 below 0\.45; 4 needed\./);
  /* a round that was not stopped early says nothing of it */
  const { page: full } = await bootWith(t, [baseState({ id: 'pl-atlas-0003', stage: 'grade-test', design: designFacts(), screen: { passed: true, pilots: pilots([0.1, 0.2]) }, test: { ...stageOf('test', [0.1, 0.2, 0.3, 0.4, 0.2], true), stoppedEarly: null } })]);
  assert.doesNotMatch(full.region('test'), /pl-early-stop|Stopped/);
});

test('early stops while a round runs: a withheld stoppedEarly, afterPilot or score, and a withheld bar, are shown as withheld and break nothing', async t => {
  const W = { withheld: true };
  const { companion, page } = await bootWith(t, [baseState({ stage: 'screen', redacted: true, design: designFacts(), config: { screenBar: W, testBar: W }, screen: { ...stageOf('screen', [0.62, null], null, { 1: { ...notNeeded('screen', 1), stoppedEarly: W, stoppedReason: W } }), stoppedEarly: W } })]);
  let s = page.region('screen');
  const marker = '<span class="pl-withheld">Withheld while a round runs</span>';
  assert.ok(s.includes('<p class="pl-early-stop">Early stop: ' + marker + '</p>'), 'the stage');
  assert.ok(s.includes('<small class="pl-stopped-reason">Early stop: ' + marker + '</small>'), 'the pilot');
  assert.match(s, /<th scope="col">Below 0\.40<\/th>/, 'a withheld bar is the spec\'s');
  assert.doesNotMatch(s, /\[object Object\]|undefined|>null</);
  /* a pilot whose reason is withheld is still a pilot that was stopped */
  companion.attemptPatch('pl-atlas-0001', { screen: { ...stageOf('screen', [0.62, null], false, { 1: { ...notNeeded('screen', 1), stoppedReason: W } }), stoppedEarly: { afterPilot: W, score: W } } });
  await page.tick();
  s = page.region('screen');
  assert.ok(s.includes('<td data-label="Score">Stopped: not needed<small class="pl-stopped-reason">' + marker + '</small></td>'));
  assert.ok(s.includes('<p class="pl-early-stop">Stopped after a pilot scored ' + marker + ': the screen cannot pass.</p>') || /Stopped after a pilot scored/.test(s));
  assert.doesNotMatch(s, /\[object Object\]|undefined|>null</);
  companion.attemptPatch('pl-atlas-0001', { screen: { ...stageOf('screen', [0.62, null], false, { 1: { ...notNeeded('screen', 1), stoppedEarly: { reason: W } } }), stoppedEarly: { afterPilot: 1 } } });
  await page.tick();
  s = page.region('screen');
  assert.match(s, /<p class="pl-early-stop">Stopped after pilot 1: the screen cannot pass\.<\/p>/, 'no score sent: none is said');
  assert.ok(s.includes('<small class="pl-stopped-reason">' + marker + '</small>'));
  assert.equal(page.statusIsError(), false);
});

test('early-stop fields of the wrong type give nothing or a plain reading, never an error', () => {
  const { adapt } = makeAdapter();
  for (const value of [null, undefined, 5, 'x', [], true, false, {}, { afterPilot: 'one', score: 'high' }, { reason: 7 }]) {
    const v = adapt(baseState({ attempts: [attemptOf({ screen: { passed: false, stoppedEarly: value, pilots: [{ n: 1, score: 0.6, stoppedEarly: value, stoppedReason: value }, { n: 2, stoppedEarly: value, reason: value }] } })] }));
    assert.ok(v, JSON.stringify(value));
    const st = v.attempts[0].screen.stoppedEarly;
    assert.ok(st === null || typeof st === 'object', 'the stage');
    for (const p of v.attempts[0].screen.pilots) assert.ok(p.stoppedEarly === null || typeof p.stoppedEarly === 'object', 'a pilot');
  }
  const v = adapt(baseState({ attempts: [attemptOf({ screen: { passed: false, stoppedEarly: { afterPilot: 1, score: 0.62 }, pilots: [{ n: 1, score: 0.62 }, { n: 2, stoppedEarly: true, stoppedReason: 'Not needed.' }, { n: 3, stoppedEarly: false }, { n: 4, stoppedEarly: 'Done early.' }, { n: 5, stoppedEarly: { reason: 'Because.' } }, { n: 6, stoppedEarly: true, reason: 'The grader reason of a pilot without a score.' }] } })] }));
  assert.deepEqual(plain(v.attempts[0].screen.stoppedEarly), { afterPilot: 1, score: 0.62 });
  assert.deepEqual(plain(v.attempts[0].screen.pilots.map(p => p.stoppedEarly)), [null, { reason: 'Not needed.' }, null, { reason: 'Done early.' }, { reason: 'Because.' }, { reason: 'The grader reason of a pilot without a score.' }]);
});

test('each stage has its own band of scores that is graded a second time: the screen\'s and the test\'s, else the one the companion reports', async t => {
  const regraded = (first, second, score) => ({ score, regrade: { first, second, average: score } });
  const withRegrade = baseState({ stage: 'grade-test', design: designFacts(), screen: stageOf('screen', [0.4, 0.2], true, { 0: regraded(0.36, 0.44, 0.4) }), test: stageOf('test', [0.1, 0.2, 0.3, 0.9, 0.45], null, { 4: regraded(0.43, 0.47, 0.45) }) });
  const { page } = await bootWith(t, [withRegrade], { config: { regradeBand: [0.4, 0.5], screenRegradeBand: [0.35, 0.45], testRegradeBand: [0.4, 0.5] } });
  assert.match(page.region('screen'), /A score from 0\.35 to 0\.45 is graded a second time/);
  assert.match(page.region('test'), /A score from 0\.40 to 0\.50 is graded a second time/);
  const { page: one } = await bootWith(t, [withRegrade], { config: { regradeBand: [0.4, 0.5] } });
  assert.match(one.region('screen'), /A score from 0\.40 to 0\.50 is graded a second time/, 'the one band, when there are not two');
  const { page: none } = await bootWith(t, [withRegrade], { config: {} });
  assert.doesNotMatch(none.region('screen') + none.region('test'), /graded a second time/);
});

test('the test table: five pilots, needing 4 of 5; the verdict is the companion\'s, and until it has one the stage is in progress whatever the scores say', async t => {
  const { companion, page } = await bootWith(t, [baseState({ stage: 'grade-test', design: designFacts(), screen: { passed: true, pilots: pilots([0.1, 0.2]) }, test: { passed: null, pilots: pilots([0.1, 0.2, 0.3, 0.9, 0.44]) } })]);
  let s = page.region('test');
  assert.match(s, /5-pilot test/);
  assert.match(s, /The test succeeds when at least 4 of 5 pilots score below 0\.45\./);
  assert.equal(rowsOf(s).length, 5);
  assert.match(s, /4 of 5 below 0\.45; 4 needed\./, 'the count follows the scores');
  assert.match(s, /<span class="pill violet">Test in progress<\/span>/, 'four of five below the bar is not a verdict until the companion says so');
  assert.doesNotMatch(s, /Test passed|Test failed/);
  companion.attemptPatch('pl-atlas-0001', { test: stageOf('test', [0.1, 0.2, 0.3, 0.9, 0.44], true) });
  await page.tick();
  assert.match(page.region('test'), /<span class="pill green">Test passed<\/span>/);
  companion.attemptPatch('pl-atlas-0001', { test: stageOf('test', [0.1, 0.2, 0.6, 0.9, 0.44], null) });
  await page.tick();
  s = page.region('test');
  assert.match(s, /3 of 5 below 0\.45; 4 needed\./);
  assert.match(s, /<span class="pill violet">Test in progress<\/span>/, 'three of five with every pilot in is still the companion\'s to decide (a replacement may be coming)');
  companion.attemptPatch('pl-atlas-0001', { test: stageOf('test', [0.1, 0.2, 0.6, 0.9, 0.44], false) });
  await page.tick();
  assert.match(page.region('test'), /<span class="pill red">Test failed<\/span>/);
  companion.attemptPatch('pl-atlas-0001', { test: stageOf('test', [0.1, 0.2], null, { 1: { state: 'running', score: null, audit: null, valid: false } }) });
  await page.tick();
  assert.match(page.region('test'), /<span class="pill violet">Test in progress<\/span>/, 'two of five so far');
});

test('the screen verdict is the companion\'s too: both pilots below the bar and no verdict yet is still in progress', async t => {
  const { companion, page } = await bootWith(t, [baseState({ stage: 'grade-screen', design: designFacts(), screen: stageOf('screen', [0.2, 0.3], null) })]);
  assert.match(page.region('screen'), /<span class="pill violet">Screen in progress<\/span>/);
  assert.match(page.region('screen'), /2 of 2 below 0\.40; both needed\./);
  companion.attemptPatch('pl-atlas-0001', { screen: stageOf('screen', [0.2, 0.3], true) });
  await page.tick();
  assert.match(page.region('screen'), /<span class="pill green">Screen passed<\/span>/);
});

test('scores are shown to two decimals, and a score that rounds onto the bar shows its extra digits so the yes or no is never a surprise', async t => {
  const { page } = await bootWith(t, [baseState({ stage: 'test', design: designFacts(), screen: { passed: true, pilots: pilots([0.3996, 0.4001]) } })]);
  assert.deepEqual(rowsOf(page.region('screen')).map(r => [r.score, r.below]), [['0.40 (0.3996)', '✓ Yes'], ['0.40 (0.4001)', '✕ No']]);
  /* each stage rounds against its own bar: 0.40 for the screen, 0.45 for the test */
  const { page: tst } = await bootWith(t, [baseState({ id: 'pl-atlas-0003', stage: 'grade-test', design: designFacts(), screen: { passed: true, pilots: pilots([0.1, 0.2]) }, test: { passed: null, pilots: pilots([0.4496, 0.4501, 0.4, 0.3996, 0.1]) } })]);
  assert.deepEqual(rowsOf(tst.region('test')).map(r => [r.score, r.below]), [['0.45 (0.4496)', '✓ Yes'], ['0.45 (0.4501)', '✕ No'], ['0.40', '✓ Yes'], ['0.40', '✓ Yes'], ['0.10', '✓ Yes']]);   // 0.40 and 0.3996 are not near the test bar
  const { page: other } = await bootWith(t, [baseState({ id: 'pl-atlas-0002', stage: 'test', design: designFacts(), screen: { passed: true, pilots: pilots([0.123456, 1]) } })]);
  assert.deepEqual(rowsOf(other.region('screen')).map(r => r.score), ['0.12', '1.00']);
});

test('a pilot without a score: Replacement pending while the stage is undecided, counts against the design once it is, and the audit badge says DISCARDED in words', async t => {
  const { companion, page } = await bootWith(t, [baseState({ stage: 'grade-screen', design: designFacts(), screen: { passed: null, pilots: [
    { n: 1, state: 'completed', score: null, valid: false, audit: { status: 'DISCARDED' } },
    { n: 2, state: 'failed', score: null, valid: false, audit: '' },
    { n: 3, state: 'completed', score: null, valid: false, audit: { status: 'CLEAN' } },
    { n: 4, state: 'running', score: null, valid: false, audit: null },
  ] } })]);
  let rows = rowsOf(page.region('screen'));
  assert.equal(rows[0].score, 'No score (discarded)');
  assert.equal(rows[0].audit, 'DISCARDED');
  assert.equal(rows[0].below, 'Replacement pending', 'a discarded pilot is replaced once per stage');
  assert.equal(rows[1].score, 'No score (failed)');
  assert.equal(rows[1].audit, 'Not audited');
  assert.equal(rows[1].below, 'Replacement pending');
  assert.equal(rows[2].score, 'Waiting for the grader');
  assert.equal(rows[2].below, 'Pending', 'an answer that is still to be graded is not a replacement');
  assert.equal(rows[3].below, 'Pending');
  assert.match(page.region('screen'), /<span class="pill red">DISCARDED<\/span>/);
  assert.match(page.region('screen'), /<span class="pill amber">Not audited<\/span>/);
  assert.match(page.region('screen'), /<span class="pill violet">Screen in progress<\/span>/, 'no verdict from the companion, so no failed screen');
  assert.doesNotMatch(page.region('screen'), /counts against the design/);
  /* decided: nothing more will come for them */
  companion.attemptPatch('pl-atlas-0001', { screen: { ...stageOf('screen', [null, null], false), pilots: [
    { n: 1, state: 'completed', score: null, valid: false, audit: { status: 'DISCARDED' } },
    { n: 2, state: 'completed', score: null, valid: false, audit: { status: 'CLEAN' } },
  ] } });
  await page.tick();
  rows = rowsOf(page.region('screen'));
  assert.equal(rows[0].score, 'No score (discarded)');
  assert.equal(rows[1].score, 'No usable score');
  assert.match(rows[0].below, /No, a pilot without a score counts against the design/);
  assert.match(rows[1].below, /No, a pilot without a score counts against the design/);
  assert.match(page.region('screen'), /<span class="pill red">Screen failed<\/span>/);
});

test('pilots still working show their state, not a score', async t => {
  const { page } = await bootWith(t, [baseState({ stage: 'screen', design: designFacts(), screen: { passed: null, pilots: [{ n: 1, state: 'running' }, { n: 2, state: 'queued' }] } })]);
  const rows = rowsOf(page.region('screen'));
  assert.deepEqual(rows.map(r => r.score), ['Running', 'Queued']);
  assert.deepEqual(rows.map(r => r.below), ['Pending', 'Pending']);
  assert.deepEqual(rows.map(r => r.audit), ['Pending', 'Pending']);
  assert.match(page.region('screen'), /pill violet">Screen in progress/);
});

test('a stage that has started but has no pilots yet says the pilots are starting; one not reached shows no card', async t => {
  const { companion, page } = await bootWith(t, [baseState({ stage: 'screen', design: designFacts() })]);
  assert.match(page.region('screen'), /The pilots are starting\./);
  assert.equal(page.region('test'), '');
  companion.update('pl-atlas-0001', { stage: 'classify', design: undefined });
  await page.tick();
  assert.equal(page.region('screen'), '');
});

test('redesign attempts: every attempt with its traps, screen, test and outcome, and the count used', async t => {
  const { page } = await bootWith(t, [baseState({ stage: 'grade-test', redesigns: 2, design: designFacts({ attempt: 3 }), attempts: [
    attemptOf({ n: 1, traps: ['Rounded inputs rebuilt into a total'], outcome: 'screen-failed', screen: stageOf('screen', [0.7, 0.3], false) }),
    attemptOf({ n: 2, traps: ['Superseded facility schedule'], outcome: 'test-failed', screen: stageOf('screen', [0.2, 0.3], true), test: stageOf('test', [0.9, 0.8, 0.1, 0.2, 0.3], false) }),
    attemptOf({ n: 3, traps: ['Superseded facility schedule', 'Borealis cut-off'], screen: stageOf('screen', [0.2, 0.3], true), test: stageOf('test', [0.1, 0.2], null) }),
  ] })]);
  const r = page.region('redesigns');
  assert.match(r, /2 of 3 used/);
  assert.match(r, /At most 3 redesigns\./);
  assert.match(r, /<th scope="row">Attempt 1<\/th><td data-label="Traps">Rounded inputs rebuilt into a total<\/td><td data-label="Screen">Failed \(0\.70, 0\.30\)<\/td><td data-label="Test">Not run<\/td><td data-label="Outcome">Screen failed<\/td>/);
  assert.match(r, /<th scope="row">Attempt 2<\/th><td data-label="Traps">Superseded facility schedule<\/td><td data-label="Screen">Passed \(0\.20, 0\.30\)<\/td><td data-label="Test">Failed \(0\.90, 0\.80, 0\.10, 0\.20, 0\.30\)<\/td><td data-label="Outcome">Test failed<\/td>/);
  assert.match(r, /<th scope="row">Attempt 3 \(latest\)<\/th><td data-label="Traps">Superseded facility schedule, Borealis cut-off<\/td><td data-label="Screen">Passed \(0\.20, 0\.30\)<\/td><td data-label="Test">In progress \(0\.10, 0\.20\)<\/td><td data-label="Outcome">In progress<\/td>/);
  assert.match(page.region('test'), /Test in progress/, 'the test card shows the latest attempt');
});

test('the redesign card is absent before any redesign; the screen and test cards follow the last attempt', async t => {
  const { companion, page } = await bootWith(t, [baseState({ stage: 'screen', design: designFacts(), screen: stageOf('screen', [0.2], null) })]);
  assert.equal(page.region('redesigns'), '', 'one attempt and no redesign: nothing to compare');
  companion.update('pl-atlas-0001', { redesigns: 1, attempts: [attemptOf({ n: 1, traps: ['A'], outcome: 'screen-failed', screen: stageOf('screen', [0.9, 0.9], false) }), attemptOf({ n: 2, traps: ['B'], screen: stageOf('screen', [0.2], null) })] });
  await page.tick();
  assert.deepEqual(rowsOf(page.region('screen')).map(r => r.score), ['0.20'], 'the last attempt supplies the current results');
  assert.match(page.region('redesigns'), /Attempt 2 \(latest\)/);
  assert.match(page.region('redesigns'), /<th scope="row">Attempt 1<\/th><td data-label="Traps">A<\/td><td data-label="Screen">Failed \(0\.90, 0\.90\)<\/td><td data-label="Test">Not run<\/td><td data-label="Outcome">Screen failed<\/td>/);
  assert.match(page.region('redesigns'), /<td data-label="Outcome">In progress<\/td>/);
});

test('every outcome the companion records has a name, rejected included, and the names it never sends are not invented', async t => {
  const outcomes = ['passed', 'screen-failed', 'test-failed', 'rejected', 'stopped', 'budget', 'failed', 'in-progress', 'odd-new-one'];
  const { page } = await bootWith(t, [baseState({ stage: 'design', redesigns: 1, attempts: outcomes.map((outcome, i) => attemptOf({ n: i + 1, outcome })) })]);
  const cells = [...page.region('redesigns').matchAll(/<td data-label="Outcome">([^<]*)<\/td>/g)].map(m => m[1]);
  assert.deepEqual(cells, ['Passed', 'Screen failed', 'Test failed', 'Rejected before any pilot', 'Stopped', 'Stopped at the cap', 'Failed', 'In progress', 'odd-new-one']);
  for (const never of ['calibration-failed', 'unfair-rubric', 'leak', 'design-error']) assert.ok(!PIPELINE_SOURCE.includes("'" + never + "'") && !PIPELINE_SOURCE.includes(never + ':'), never + ' is not a name the companion sends');
});

test('a rejected attempt says it was rejected before any pilot, why, and which check; a note after a restart, a repair turn and the checks it passed are shown', async t => {
  const { companion, page } = await bootWith(t, [baseState({ stage: 'design', redesigns: 2, attempts: [
    attemptOf({ n: 1, outcome: 'rejected', rejection: { kind: 'checks', reasons: ['The golden answer scored 0.62 against its own guideline; at least 0.90 is needed', 'The fairness review found 1 guideline item that a solver could not know'] }, calibration: { score: 0.62, verdict: 'does-not-meet-guidance', reason: 'Missing the date.' }, fairness: { status: 'unfair', count: 1 }, repaired: true }),
    attemptOf({ n: 2, outcome: 'rejected', rejection: { kind: 'design', reasons: ['out/prompt.txt states a figure of the golden answer'] } }),
    attemptOf({ n: 3, outcome: 'failed', note: 'The companion stopped while this attempt was running.', calibration: { score: 0.97, verdict: 'v', reason: 'r' }, fairness: { status: 'ok', count: 0 } }),
  ] })]);
  const r = page.region('redesigns');
  assert.match(r, /<td data-label="Outcome">Rejected before any pilot<small class="pl-rejection">The design did not pass the calibration or the fairness check\.<\/small><ul class="pl-cell-list"><li>The golden answer scored 0\.62 against its own guideline; at least 0\.90 is needed<\/li><li>The fairness review found 1 guideline item that a solver could not know<\/li><\/ul><\/td>/);
  assert.match(r, /<td data-label="Outcome">Rejected before any pilot<small class="pl-rejection">The designer’s files did not pass the design checks\.<\/small><ul class="pl-cell-list"><li>out\/prompt\.txt states a figure of the golden answer<\/li><\/ul><\/td>/);
  assert.match(r, /<td data-label="Outcome">Failed<small class="pl-rejection">The companion stopped while this attempt was running\.<\/small><\/td>/);
  assert.match(r, /<th scope="col">Design checks<\/th>/);
  assert.match(r, /<td data-label="Design checks"><ul class="pl-cell-list"><li>Calibration: 0\.62, failed<\/li><li>Fairness review: 1 unfair item<\/li><li>A repair turn was used<\/li><\/ul><\/td>/);
  assert.match(r, /<td data-label="Design checks"><ul class="pl-cell-list"><li>Calibration: 0\.97, passed<\/li><li>Fairness review: no unfair item<\/li><\/ul><\/td>/);
  assert.match(r, /<td data-label="Design checks">Not recorded<\/td>/, 'an attempt with no recorded checks');
  companion.attemptPatch('pl-atlas-0001', { calibration: { score: null, verdict: null, reason: '' }, fairness: { status: 'unusable', count: 0 } });
  await page.tick();
  assert.match(page.region('redesigns'), /<li>Calibration: no usable score<\/li><li>Fairness review: no usable answer<\/li>/);
});

test('every part of a rejected attempt may be withheld while a round runs, and the page still draws it', async t => {
  const W = { withheld: true };
  const { page } = await bootWith(t, [baseState({ stage: 'design', redacted: true, redesigns: 1, attempts: [
    attemptOf({ n: 1, outcome: 'rejected', traps: [{ id: 't1', title: W }], rejection: W, calibration: W, fairness: W, repaired: W, note: W }),
    attemptOf({ n: 2, outcome: 'rejected', traps: [{ id: 't1', title: W }, { id: 't2', title: W }], rejection: { kind: 'design', reasons: W }, calibration: { score: W, verdict: W, reason: W }, fairness: { withheld: true } }),
  ] })]);
  const r = page.region('redesigns');
  const w = '<span class="pl-withheld">Withheld while a round runs</span>';
  assert.ok(r.includes(`<td data-label="Outcome">Rejected before any pilot<small class="pl-rejection">${w}</small><small class="pl-rejection">${w}</small></td>`), 'the rejection and the note');
  assert.ok(r.includes(`<li>Calibration: ${w}</li><li>Fairness review: ${w}</li><li>Repair turn: ${w}</li>`));
  assert.ok(r.includes('<td data-label="Traps">Withheld while a round runs</td>'), 'a trap whose title is withheld keeps its place');
  assert.ok(r.includes(`<small class="pl-rejection">The designer’s files did not pass the design checks.</small><ul class="pl-cell-list"><li>${w}</li></ul>`), 'withheld reasons');
  assert.doesNotMatch(r, /\[object Object\]|undefined|>null</);
});

test('a replacement pilot is marked, and once the stage is decided a pilot with no usable score says so', async t => {
  const { page } = await bootWith(t, [baseState({ stage: 'test', design: designFacts(), screen: stageOf('screen', [0.1, null, 0.2], true, { 1: { replacement: false, valid: false }, 2: { replacement: true } }) })]);
  const rows = [...page.region('screen').matchAll(/<th scope="row">([^<]*)<\/th><td data-label="Score">([^<]*)<\/td>/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(rows, [['Pilot 1', '0.10'], ['Pilot 2', 'No usable score'], ['Pilot 3 (replacement)', '0.20']]);
  assert.match(page.region('screen'), /No, a pilot without a score counts against the design/);
});

/* ====================================================================== result, stop, export */

test('the result card for each way a pipeline can end, with spend and redesigns used', async t => {
  const show = async over => (await bootWith(t, [doneState(over)])).page.region('verdict');
  let v = await show({});
  assert.match(v, /<h2>The test passed<\/h2>/);
  assert.match(v, /<span class="pill green">Passed<\/span>/);
  assert.match(v, /<p>The test passed: 4 of 5 pilots scored below 0\.45 \(design attempt 2\)\. Export the private zip to take the design away\.<\/p>/, 'the companion\'s own sentence');
  assert.match(v, /Spent USD 17\.40 of USD 30\.00\. Redesigns used: 1 of 3\./);
  v = await show({ summary: '' });
  assert.match(v, /4 of 5 test pilots scored below 0\.45\. The new files, the revised task text and the score table are ready to export\./, 'the page\'s own words when the companion sent none');
  v = await show({ stage: 'failed', summary: 'Three redesigns used; the screen kept passing for the wrong reason.' });
  assert.match(v, /<h2>No passing design<\/h2>/);
  assert.match(v, /<span class="pill red">Failed<\/span>/);
  assert.match(v, /Three redesigns used; the screen kept passing for the wrong reason\./);
  v = await show({ stage: 'failed', summary: '', error: 'The task page could not be opened.' });
  assert.match(v, /Reason: The task page could not be opened\./);
  assert.match(v, /did not pass within 3 redesigns, or the run could not continue/);
  v = await show({ stage: 'failed', summary: 'The link loader failed: no sign-in.', error: 'The link loader failed: no sign-in.' });
  assert.doesNotMatch(v, /Reason:/, 'the same sentence is not said twice');
  v = await show({ stage: 'stopped', summary: '' });
  assert.match(v, /<h2>Stopped by you<\/h2>/);
  assert.match(v, /<span class="pill amber">Stopped<\/span>/);
  v = await show({ stage: 'budget', summary: '' });
  assert.match(v, /<h2>Stopped at the cap<\/h2>/);
  assert.match(v, /would have passed the total cap of USD 30\.00, so it was not started\./);
  v = await show({ stage: 'budget', summary: 'Stopped before the next screen: USD 12.00 spent, the step could cost up to USD 8.50, and the cap is USD 20.00.' });
  assert.match(v, /Stopped before the next screen: USD 12\.00 spent/);
  assert.match(v, /<span class="pill amber">Cap reached<\/span>/);
  v = await show({ stage: 'import' });
  assert.equal(v, '', 'no result while it runs');
});

test('a run that ended early marks the stage it reached as stopped here', async t => {
  const { page } = await bootWith(t, [baseState({ stage: 'budget', design: designFacts(), screen: { passed: true, pilots: pilots([0.1, 0.2]) }, test: { passed: null, pilots: pilots([0.1]) } })]);
  const steps = stepsOf(page.region('timeline'));
  assert.deepEqual(steps.map(s => s.s), ['done', 'done', 'done', 'done', 'stopped', 'todo']);
  assert.equal(steps[4].caption, 'Stopped at the cap', 'a stop at the cap says so under the step');
  assert.equal(steps[4].mark, '!');
  const { page: early } = await bootWith(t, [baseState({ id: 'pl-atlas-0009', stage: 'failed', error: 'The link could not be opened.' })]);
  assert.deepEqual(stepsOf(early.region('timeline')).map(s => s.s), ['stopped', 'todo', 'todo', 'todo', 'todo', 'todo']);
  assert.equal(stepsOf(early.region('timeline'))[0].caption, 'Stopped here');
});

/* ---- where a run that ended early ended: the step it was in, from what the view holds (a stage that ended is not a step) ---- */

const ended = (stage, over = {}) => baseState({ stage, running: false, import: importFacts(), classification: classification(), ...over });
const rejected = n => attemptOf({ n, outcome: 'rejected', traps: [], rejection: { kind: 'checks', reasons: ['The golden answer scored 0.50 against the revised guideline.'] } });
const where = async (t, state) => {
  const { page } = await bootWith(t, [state]);
  const steps = stepsOf(page.region('timeline'));
  assert.equal(steps.filter(x => x.current).length, 1, 'exactly one step is marked');
  assert.equal(steps.filter(x => x.s === 'stopped').length, 1, 'exactly one step is marked stopped');
  return { page, at: steps.findIndex(x => x.s === 'stopped'), steps };
};
const STEP_NAMES = ['Import', 'Classify', 'Design', 'Screen', 'Test', 'Done'];

test('the timeline marks the step a run ended in: import and classify', async t => {
  /* the link loader failed: nothing was imported */
  assert.equal((await where(t, baseState({ stage: 'failed', error: 'The link loader failed.' }))).at, 0);
  /* the import is complete and the classifier's answer could not be used: no classification is kept (service.cjs _classify throws before it saves one) */
  const { at, steps } = await where(t, baseState({ stage: 'failed', import: importFacts(), error: 'Could not tell which part of the page is the grader guideline.' }));
  assert.equal(at, 1, 'the classification failed, not the import');
  assert.deepEqual(steps.map(x => x.s), ['done', 'stopped', 'todo', 'todo', 'todo', 'todo']);
  assert.equal(steps[1].caption, 'Stopped here');
  /* Stop while the classifier ran */
  assert.equal((await where(t, baseState({ stage: 'stopped', import: importFacts() }))).at, 1);
  /* the cap stopped the run before the classifier */
  const cap = await where(t, baseState({ stage: 'budget', import: importFacts() }));
  assert.equal(cap.at, 1);
  assert.equal(cap.steps[1].caption, 'Stopped at the cap');
  /* the classification is kept when a check after it fails (a file that looks like the golden answer, withheld files, a packet that does not fit) */
  assert.equal((await where(t, ended('failed', { error: 'The page has a file that looks like the golden answer.' }))).at, 1, 'a failed classify check');
});

test('the timeline marks the step a run ended in: design, including a stop or a failure in the first design and designs that were all rejected', async t => {
  /* classified, and Stop or the cap came before the designer started an attempt */
  assert.equal((await where(t, ended('stopped'))).at, 2);
  assert.equal((await where(t, ended('budget'))).at, 2);
  /* Stop during the first design: the attempt is already in the list, with no screen */
  const first = await where(t, ended('stopped', { attempts: [attemptOf({ outcome: 'stopped' })], attempt: 1 }));
  assert.equal(first.at, 2, 'not the screen');
  assert.deepEqual(first.steps.map(x => x.s), ['done', 'done', 'stopped', 'todo', 'todo', 'todo']);
  assert.equal((await where(t, ended('failed', { attempts: [attemptOf({ outcome: 'failed' })], attempt: 1, error: 'The trap designer could not be started.' }))).at, 2);
  assert.equal((await where(t, ended('budget', { attempts: [attemptOf({ outcome: 'budget' })], attempt: 1 }))).at, 2, 'the cap before the repair turn or the fairness review');
  /* all four designs were rejected before any pilot: the stage failed, nothing was run */
  const all = await where(t, ended('failed', { redesigns: 3, attempt: 4, attempts: [1, 2, 3, 4].map(rejected), summary: 'Stopped after 3 redesigns: the design of attempt 4 was rejected before any pilot ran.' }));
  assert.equal(all.at, 2, 'the design step, not the screen');
  assert.deepEqual(all.steps.map(x => x.s), ['done', 'done', 'stopped', 'todo', 'todo', 'todo']);
  const rejectedRows = redesignRowsOf(all.page.region('redesigns'));
  assert.equal(rejectedRows.length, 4);
  for (const r of rejectedRows) {
    assert.equal(r.screen, 'Not run', 'no pilot ran: the screen column says so');
    assert.equal(r.test, 'Not run', 'and so does the test column');
    assert.match(r.outcome, /^Rejected before any pilot/, 'the rejection is in the outcome column');
    assert.doesNotMatch(r.screen + ' | ' + r.test, /Rejected|golden answer/, 'and in no result column');
  }
  /* a screen failed, the next design was rejected, and the run was stopped while the feedback was prepared */
  const failedScreen = attemptOf({ n: 1, outcome: 'screen-failed', screen: stageOf('screen', [0.7, 0.3], false) });
  assert.equal((await where(t, ended('stopped', { redesigns: 1, attempt: 1, attempts: [failedScreen], design: designFacts() }))).at, 2, 'between two attempts the run is in the design step');
  assert.equal((await where(t, ended('failed', { redesigns: 1, attempt: 2, attempts: [failedScreen, rejected(2)], design: designFacts() }))).at, 2, 'a later attempt was rejected while the design of the first is the one the view holds');
  assert.equal((await where(t, ended('stopped', { redesigns: 1, attempt: 2, attempts: [failedScreen, attemptOf({ n: 2, outcome: 'stopped' })], design: designFacts() }))).at, 2, 'a stop in the second design');
});

test('the timeline marks the step a run ended in: screen', async t => {
  /* the design was accepted and the run ended before the screen round began */
  const door = await where(t, ended('stopped', { attempts: [attemptOf({ outcome: 'stopped' })], attempt: 1, design: designFacts({ attempt: 1 }) }));
  assert.equal(door.at, 3);
  assert.match(door.page.region('screen'), /<span class="pill amber">Not started<\/span>/);
  assert.match(door.page.region('screen'), /The run was stopped before the screen started\./);
  assert.equal((await where(t, ended('budget', { attempts: [attemptOf({ outcome: 'budget' })], attempt: 1, design: designFacts({ attempt: 1 }) }))).at, 3);
  /* Stop while the two screen pilots ran: the round is in the list with no pilot yet */
  const round = await where(t, ended('stopped', { design: designFacts(), attempts: [attemptOf({ outcome: 'stopped', screen: stageOf('screen', [], null) })], attempt: 1 }));
  assert.equal(round.at, 3);
  assert.match(round.page.region('screen'), /<span class="pill amber">Screen stopped<\/span>/);
  assert.match(round.page.region('screen'), /The screen ended before any pilot finished, so it has no result\./);
  assert.doesNotMatch(round.page.region('screen'), /The pilots are starting/, 'an ended run does not say its pilots are starting');
  /* the last redesign's screen failed: that is where the run ended */
  const last = await where(t, ended('failed', { redesigns: 3, attempt: 4, design: designFacts({ attempt: 4 }), attempts: [1, 2, 3].map(rejected).concat([attemptOf({ n: 4, outcome: 'screen-failed', screen: stageOf('screen', [0.7, 0.3], false) })]) }));
  assert.equal(last.at, 3);
  assert.match(last.page.region('screen'), /<span class="pill red">Screen failed<\/span>/);
});

test('the timeline marks the step a run ended in: test, including a stop in the test round and the cap before it', async t => {
  const passedScreen = stageOf('screen', [0.2, 0.3], true);
  /* Stop while the five test pilots ran: the round is in the list (service.cjs sets it before the pilots start) with no pilot in it */
  const round = await where(t, ended('stopped', { design: designFacts(), attempt: 1, attempts: [attemptOf({ outcome: 'stopped', screen: passedScreen, test: stageOf('test', [], null) })] }));
  assert.equal(round.at, 4, 'not the screen, which passed');
  assert.deepEqual(round.steps.map(x => x.s), ['done', 'done', 'done', 'done', 'stopped', 'todo']);
  assert.match(round.page.region('test'), /<span class="pill amber">Test stopped<\/span>/);
  assert.match(round.page.region('test'), /The test ended before any pilot finished, so it has no result\./);
  assert.doesNotMatch(round.page.region('test'), /The pilots are starting/);
  assert.match(round.page.region('screen'), /Screen passed/, 'the screen card still says it passed');
  /* the same, with two pilots in and three not scored */
  const some = await where(t, ended('stopped', { design: designFacts(), attempt: 1, attempts: [attemptOf({ outcome: 'stopped', screen: passedScreen, test: stageOf('test', [0.2, 0.3, null], null, [{}, {}, { state: 'cancelled', valid: false, belowBar: null }]) })] }));
  assert.equal(some.at, 4);
  assert.match(some.page.region('test'), /Test stopped/);
  assert.match(some.page.region('test'), /The test ended before it was decided, so it has no result\./);
  assert.doesNotMatch(some.page.region('test'), /Pending|Running|Queued/, 'no pilot of an ended run is shown as pending');
  /* the redesign table does not call an ended run's open test 'in progress' */
  const twice = await where(t, ended('stopped', { redesigns: 1, attempt: 2, design: designFacts({ attempt: 2 }), attempts: [attemptOf({ n: 1, outcome: 'screen-failed', screen: stageOf('screen', [0.7, 0.3], false) }), attemptOf({ n: 2, outcome: 'stopped', screen: passedScreen, test: stageOf('test', [0.2, 0.3], null) })] }));
  assert.equal(twice.at, 4);
  const [first, second] = redesignRowsOf(twice.page.region('redesigns'));
  assert.deepEqual([first.screen, first.test, first.outcome], ['Failed (0.70, 0.30)', 'Not run', 'Screen failed']);
  assert.deepEqual([second.screen, second.test, second.outcome], ['Passed (0.20, 0.30)', 'Stopped (0.20, 0.30)', 'Stopped'], 'the open test of the attempt that was stopped is in the test column, the passed screen in the screen column');
  assert.doesNotMatch(second.screen + ' | ' + second.outcome, /Stopped \(/, 'the stopped test is not in another column');
  assert.doesNotMatch(twice.page.region('redesigns'), /In progress/);
  /* the test failed on the last redesign */
  const failed = await where(t, ended('failed', { redesigns: 3, attempt: 4, design: designFacts({ attempt: 4 }), attempts: [1, 2, 3].map(rejected).concat([attemptOf({ n: 4, outcome: 'test-failed', screen: passedScreen, test: stageOf('test', [0.2, 0.7, 0.8, 0.9, 0.3], false) })]) }));
  assert.equal(failed.at, 4);
  assert.match(failed.page.region('test'), /<span class="pill red">Test failed<\/span>/);
});

test('the cap reached before the test: Test is marked, says it was not started, and the result gives a plain reason', async t => {
  const passedScreen = stageOf('screen', [0.2, 0.3], true);
  const state = ended('budget', {
    design: designFacts(), attempt: 1, spentUsd: 17.4, capUsd: 20, attempts: [attemptOf({ outcome: 'budget', screen: passedScreen })],
    summary: 'Stopped before the test: USD 17.40 spent, the step could cost up to USD 20.70 (with a 15% reserve), and the cap is USD 20.00.', result: { verdict: 'budget', message: 'x' },
  });
  const { page, at, steps } = await where(t, state);
  assert.equal(at, 4);
  assert.deepEqual(steps.map(x => x.s), ['done', 'done', 'done', 'done', 'stopped', 'todo']);
  assert.equal(steps[3].caption, 'Done', 'the screen passed');
  assert.equal(steps[4].caption, 'Stopped at the cap');
  assert.equal(page.stage(), 'Stopped at the cap, in the Test step: the next call would pass the total cap, so it was not started.');
  /* the Test card */
  const test = page.region('test');
  assert.match(test, /<h2>5-pilot test<\/h2>/);
  assert.match(test, /<span class="pill amber">Not started<\/span>/);
  assert.match(test, /The test was not started: the next call would have passed the total cap of USD 20\.00, and USD 17\.40 was spent\./);
  /* the result card: the companion's sentence, the step, and what to do */
  const v = page.region('verdict');
  assert.match(v, /<h2>Stopped at the cap<\/h2>/);
  assert.match(v, /Stopped before the test: USD 17\.40 spent, the step could cost up to USD 20\.70/);
  assert.match(v, /<p class="pl-budget-note">Stopped in the Test step with USD 17\.40 of USD 20\.00 spent\. To go further, start a new pipeline with a higher total cap\.<\/p>/);
  /* without the companion's sentence the page's own words say why */
  const { page: bare } = await bootWith(t, [{ ...state, summary: '' }]);
  assert.match(bare.region('verdict'), /The worst case of the next step would have passed the total cap of USD 20\.00, so it was not started\./);
  assert.match(bare.region('verdict'), /Stopped in the Test step/);
  /* the cap before the screen, and during the classify and design steps, names those steps */
  const early = await bootWith(t, [ended('budget', { attempts: [attemptOf({ outcome: 'budget' })], attempt: 1, design: designFacts({ attempt: 1 }), capUsd: 5, spentUsd: 4 })]);
  assert.equal(early.page.stage(), 'Stopped at the cap, in the Screen step: the next call would pass the total cap, so it was not started.');
  assert.match(early.page.region('verdict'), /Stopped in the Screen step with USD 4\.00 of USD 5\.00 spent\./);
  assert.match(early.page.region('screen'), /The screen was not started: the next call would have passed the total cap of USD 5\.00, and USD 4\.00 was spent\./);
  const design = await bootWith(t, [ended('budget', { attempts: [attemptOf({ outcome: 'budget' })], attempt: 1, capUsd: 5, spentUsd: 4 })]);
  assert.match(design.page.stage(), /in the Design step/);
  const classify = await bootWith(t, [baseState({ stage: 'budget', import: importFacts(), capUsd: 0.4 })]);
  assert.match(classify.page.stage(), /in the Classify step/);
  assert.doesNotMatch(classify.page.region('test') + classify.page.region('screen'), /not started/i, 'a stage the run never reached shows no card');
});

test('a run that is still going is not marked as ended: the stage decides the step, and a redesign counts as design', async t => {
  const { companion, page } = await bootWith(t, [baseState({ stage: 'import', import: importFacts(), classification: classification() })]);
  for (const [stage, index] of [['design', 2], ['redesign', 2], ['screen', 3], ['grade-screen', 3], ['test', 4], ['grade-test', 4]]) {
    companion.update('pl-atlas-0001', { stage, running: true, attempts: [attemptOf({ screen: stageOf('screen', [], null) })], redesigns: stage === 'redesign' ? 1 : 0 });
    await page.tick();
    const steps = stepsOf(page.region('timeline'));
    assert.equal(steps.findIndex(x => x.current), index, stage);
    assert.equal(steps.filter(x => x.s === 'stopped').length, 0, stage + ' is not stopped');
  }
});

test('Stop is visible while the pipeline runs (in any stage), posts once with the nonce, and the page shows the stopped state', async t => {
  const { companion, page } = await bootWith(t, [baseState({ stage: 'test', design: designFacts() })]);
  assert.equal(page.enabled('stop'), true);
  assert.match(page.region('actions'), /<button type="button" class="danger" data-pl="stop"[^>]*>Stop<\/button>/);
  assert.equal(page.has('export'), false, 'no export while it runs');
  await page.click('stop');
  const posts = companion.calls.filter(c => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/pipeline/pl-atlas-0001/stop');
  assert.equal(posts[0].nonce, 'nonce-fake-1');
  assert.match(page.region('verdict'), /Stopped by you/);
  assert.equal(page.has('stop'), false, 'and the button is gone');
  assert.match(page.status(), /Stop requested\./);
  assert.equal(page.pending().length, 0, 'polling ends with the run');
});

test('Stop stays available in every running stage and is offered while waiting', async t => {
  const { companion, page } = await bootWith(t, [baseState({ stage: 'import' })]);
  for (const stage of ['import', 'classify', 'design', 'redesign', 'screen', 'grade-screen', 'test', 'grade-test']) {
    companion.update('pl-atlas-0001', { stage });
    await page.tick();
    assert.equal(page.enabled('stop'), true, stage);
  }
  for (const stage of ['done', 'failed', 'stopped', 'budget']) {
    const { page: ended } = await bootWith(t, [baseState({ stage })]);
    assert.equal(ended.has('stop'), false, stage);
  }
});

test('a failed Stop is shown in words and the button comes back', async t => {
  const { companion, page } = await bootWith(t, [baseState({ stage: 'screen' })]);
  companion.fail('POST /api/pipeline/pl-atlas-0001/stop', 500, 'Could not stop.');
  await page.click('stop');
  assert.equal(page.status(), 'Failed: Could not stop.');
  assert.equal(page.enabled('stop'), true);
});

test('Export is offered once the pipeline is done, posts, and saves the zip under its private name with the right bytes', async t => {
  const { companion, page } = await bootWith(t, [doneState()]);
  assert.equal(page.enabled('export'), true);
  assert.match(page.region('actions'), />Export private zip<\/button>/);
  await page.click('export');
  const post = companion.calls.find(c => c.method === 'POST');
  assert.equal(post.url, '/api/pipeline/pl-atlas-0001/export');
  assert.equal(post.nonce, 'nonce-fake-1');
  assert.equal(page.downloads.length, 1);
  assert.equal(page.downloads[0].name, 'Atlas_review_pipeline_PRIVATE.zip', 'the name the companion gave');
  assert.equal(page.downloads[0].mime, 'application/zip');
  assert.equal(Buffer.from(page.downloads[0].bytes).toString(), 'PK synthetic zip bytes');
  assert.match(page.status(), /Downloaded Atlas_review_pipeline_PRIVATE\.zip\. It holds private task material/);
});

test('an export name that is not a private zip name is replaced, and an answer with no file is an error', async t => {
  const { companion, page } = await bootWith(t, [doneState()]);
  const zip = Buffer.from('x').toString('base64');
  companion.exportAnswer = () => ({ name: '../../evil.zip', zipBase64: zip });
  await page.click('export');
  assert.equal(page.downloads[0].name, 'pl-atlas-0001_pipeline_PRIVATE.zip');
  companion.exportAnswer = () => ({ name: 'Borealis_pipeline_PRIVATE.zip', zipBase64: zip });
  await page.click('export');
  assert.equal(page.downloads[1].name, 'Borealis_pipeline_PRIVATE.zip', 'a well formed private name is kept');
  companion.exportAnswer = () => ({ name: 'x_PRIVATE.zip' });
  await page.click('export');
  assert.equal(page.status(), 'Failed: The companion did not return a file.');
  companion.exportAnswer = () => ({ zipBase64: '!!!not base64!!!' });
  await page.click('export');
  assert.equal(page.status(), 'Failed: The companion did not return a file.');
  assert.equal(page.downloads.length, 2);
});

test('an export the companion refuses (a round is running) is shown in words', async t => {
  const { companion, page } = await bootWith(t, [doneState()]);
  companion.fail('POST /api/pipeline/pl-atlas-0001/export', 409, 'A round is running. Export when it has ended.');
  await page.click('export');
  assert.equal(page.status(), 'Failed: A round is running. Export when it has ended.');
  assert.equal(page.downloads.length, 0);
});

test('a pipeline that ended without success can still be exported when it has a design; a plain failure with nothing built cannot', async t => {
  const { page } = await bootWith(t, [baseState({ stage: 'failed', design: designFacts() })]);
  assert.equal(page.has('export'), true);
  const { page: bare } = await bootWith(t, [baseState({ id: 'pl-atlas-0005', stage: 'failed' })]);
  assert.equal(bare.has('export'), false);
});

/* ====================================================================== withheld while a round runs */

const redactedState = () => baseState({
  stage: 'screen', redacted: true, import: importFacts(), classification: classification(),
  design: { attempt: 1, traps: [{ id: 't1', title: 'Superseded facility schedule', mechanism: 'A later amendment replaces the schedule.', files: ['Atlas_Amendment_2.txt'], decoy: 'Atlas_Facility_Schedule.csv', correctValue: WITHHELD, wrongValue: WITHHELD }], newFiles: ['Atlas_Amendment_2.txt'], editedFiles: [], prompt: WITHHELD, guideline: WITHHELD, goldenAnswer: WITHHELD, gold: WITHHELD, fingerprints: WITHHELD },
  screen: { passed: null, pilots: [{ n: 1, state: 'running' }, { n: 2, state: 'running' }] },
});

test('while a round runs the withheld fields read "Withheld while a round runs", each in its place, and the notice explains', async t => {
  const { page } = await bootWith(t, [redactedState()]);
  const d = page.region('design');
  assert.match(d, /<dt>Correct value<\/dt><dd><span class="pl-withheld">Withheld while a round runs<\/span><\/dd>/);
  assert.match(d, /<dt>Wrong value<\/dt><dd><span class="pl-withheld">Withheld while a round runs<\/span><\/dd>/);
  assert.match(d, /<h3>Prompt<\/h3><p class="pl-withheld">Withheld while a round runs<\/p>/);
  assert.match(d, /<h3>Grader guideline<\/h3><p class="pl-withheld">Withheld while a round runs<\/p>/);
  assert.match(d, /<h3>Golden answer<\/h3><p class="pl-withheld">Withheld while a round runs<\/p>/);
  assert.match(d, /<h3>Gold<\/h3><p class="pl-withheld">Withheld while a round runs<\/p>/);
  assert.match(d, /<h3>Fingerprints<\/h3><p class="pl-withheld">Withheld while a round runs<\/p>/);
  assert.equal((d.match(/Withheld while a round runs/g) || []).length, 7);
  assert.match(page.region('withheld'), /A round is running, so this page does not show the prompt, the grader guideline, the golden answer, the gold, the fingerprints or the trap values\./);
  assert.match(d, /Superseded facility schedule/, 'the title is not private');
  assert.doesNotMatch(d, /\[object Object\]|undefined|null/);
});

test('withheld traps, classification refs and a whole withheld trap list are each shown as withheld, never as empty or as an error', async t => {
  const { page } = await bootWith(t, [baseState({ stage: 'screen', redacted: true, classification: { prompt: WITHHELD, guideline: { file: 'g.docx' }, goldenAnswer: { section: 'Key' }, worldFiles: ['a.csv'] }, design: { traps: WITHHELD, newFiles: ['n.txt'] } })]);
  assert.match(page.region('classify'), /<dt>Business prompt<\/dt><dd>Withheld while a round runs<\/dd>/);
  assert.match(page.region('design'), /<p class="pl-withheld">Withheld while a round runs<\/p>/);
  assert.match(page.region('design'), /New files \(1\)/);
});

test('redacted answers are polled even after the pipeline ended, until the round is over; and nothing is exported meanwhile', async t => {
  const { companion, page } = await bootWith(t, [{ ...doneState(), redacted: true }]);
  assert.equal(page.has('export'), false, 'export is refused while a round runs, so it is not offered');
  assert.equal(page.pending().length, 1, 'the page keeps polling for the end of the round');
  companion.put(doneState());
  await page.tick();
  assert.equal(page.has('export'), true);
  assert.equal(page.pending().length, 0);
  assert.doesNotMatch(page.region('withheld'), /round is running/);
  assert.match(page.region('design'), /<dt>Correct value<\/dt><dd><span>1,250<\/span><\/dd>/, 'the values appear when no round is running');
});

/* ====================================================================== choosing a pipeline, one at a time */

test('with several pipelines the page picks the running one, lists the rest, and switching loads the other', async t => {
  const older = doneState({ id: 'pl-atlas-0001', createdAt: '2026-10-20T09:00:00.000Z' });
  const running = baseState({ id: 'pl-atlas-0002', stage: 'screen', createdAt: '2026-10-22T09:00:00.000Z', design: designFacts() });
  const { companion, page } = await bootWith(t, [older, running]);
  assert.match(page.stage(), /^Screen:/, 'the running pipeline is shown');
  const pick = page.region('picker');
  assert.match(pick, /<label class="field pl-pick">Show pipeline<select data-pl-in="pick"/);
  assert.match(pick, /<option value="pl-atlas-0002" selected>pl-atlas-0002 · Screen/);
  assert.match(pick, /<option value="pl-atlas-0001" >pl-atlas-0001 · Done/);
  assert.equal(page.enabled('new'), false, 'a new one cannot start while one runs');
  companion.update('pl-atlas-0002', { stage: 'done' });
  await page.tick();
  await page.type('pick', { value: 'pl-atlas-0001' });
  assert.match(page.region('verdict'), /The test passed/);
  assert.match(page.region('spend'), /pl-atlas-0001/);
  assert.match(page.region('picker'), /<option value="pl-atlas-0001" selected>/);
  await page.type('pick', { value: '../x' });
  assert.match(page.region('picker'), /<option value="pl-atlas-0001" selected>/, 'an id that is not valid selects nothing');
});

test('with no running pipeline the latest one is shown, the form is folded away, New pipeline opens it and Cancel closes it', async t => {
  const { page } = await bootWith(t, [doneState()]);
  assert.match(page.region('start-form'), /The latest pipeline is shown below\./);
  assert.equal(page.enabled('new'), true);
  assert.equal(page.region('start-foot'), '');
  assert.equal(page.has('start'), false);
  await page.click('new');
  assert.match(page.region('start-form'), /Task link \(https\)/);
  assert.equal(page.has('cancel-new'), true);
  assert.match(page.region('start-foot'), /Approve and start/);
  assert.deepEqual(page.focused.slice(-1), ['url'], 'the first field takes the keyboard');
  await page.click('cancel-new');
  assert.match(page.region('start-form'), /The latest pipeline is shown below\./);
  assert.deepEqual(page.focused.slice(-1), ['new'], 'and the keyboard goes back to the New pipeline button');
});

test('a start refused because another pipeline runs makes the page learn of it: the form folds and the button says why', async t => {
  const { companion, page } = await bootWith(t, [doneState()]);
  await page.click('new');
  await page.fillLink();
  await page.ackAll();
  assert.equal(page.enabled('start'), true);
  companion.put(baseState({ id: 'pl-atlas-0077', stage: 'design', createdAt: '2026-10-24T09:00:00.000Z' }));
  await page.click('start');
  assert.equal(page.status(), 'Failed: A pipeline is already running.');
  assert.equal(page.enabled('start'), false);
  assert.match(page.region('start-foot'), /A pipeline is running\. Start another when it has ended\./);
  assert.match(page.region('picker'), /pl-atlas-0077/, 'the running pipeline is in the list');
});

/* ====================================================================== safety, escaping, accessibility */

test('every name and message from the companion is escaped, in every region', async t => {
  const evil = '<img src=x onerror="alert(1)">';
  const { page } = await bootWith(t, [baseState({
    stage: 'screen', waiting: { kind: 'needs-person', message: evil }, error: evil, summary: evil,
    import: importFacts({ page: { origin: 'https://tasks.example', path: '/' + evil }, toggle: { found: true, label: evil, flipped: true } }),
    classification: { prompt: { section: evil }, guideline: { file: evil }, goldenAnswer: { file: evil }, worldFiles: [evil], taskFiles: [evil], other: [evil], withheld: [evil] },
    design: designFacts({ traps: [{ id: evil, title: evil, mechanism: evil, files: [evil], decoy: evil, correctValue: evil, wrongValue: evil }], newFiles: [evil], editedFiles: [{ name: evil, reason: evil }], prompt: evil, guideline: evil, goldenAnswer: evil, gold: { decision: evil, figures: [{ label: evil, value: evil, tolerance: evil }] }, fingerprints: [{ id: evil, label: evil, tokens: [evil], figures: [evil] }] }),
    screen: { passed: null, pilots: [{ n: 1, state: evil, score: 0.3, audit: evil }] }, attempts: [{ n: 1, traps: [evil], screen: null }],
  })]);
  const all = page.html();
  assert.ok(!all.includes('<img'), 'no element built from companion text');
  assert.ok(all.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'), 'the text is there, escaped');
  assert.equal(page.stage(), 'Waiting for you: ' + evil, 'the stage line is set as text, not markup');
});

test('every control has a name: inputs sit inside labels, buttons have words, tables have captions and column scopes, and the page uses real buttons', async t => {
  const { page } = await bootWith(t, [doneState()]);
  await page.click('new');
  const html = page.html();
  for (const m of html.matchAll(/<input\b[^>]*>/g)) assert.ok(/data-pl-in=/.test(m[0]), 'every input is a page control: ' + m[0]);
  const labels = [...html.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/g)].map(m => m[0]);
  assert.ok(labels.length >= 9, 'labels for the fields, radios and acknowledgements');
  for (const kind of ['url', 'cap', 'pilotCap', 'model', 'effort', 'ack', 'source']) assert.ok(labels.some(l => l.includes(`data-pl-in="${kind}"`)), kind + ' is inside a label');
  for (const m of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) { assert.ok(/type="button"/.test(m[0]), 'type=button'); assert.ok(m[1].replace(/<[^>]*>/g, '').trim().length > 0, 'a button with words'); }
  assert.ok(!/<div[^>]*(?:onclick|role="button")/.test(html), 'no div acting as a button');
  assert.equal((html.match(/<table\b/g) || []).length, (html.match(/<caption class="sr-only">/g) || []).length, 'every table has a caption');
  assert.ok(!/<th>(?!<)/.test(html), 'every header cell has a scope');
  assert.match(html, /<fieldset class="pl-source"><legend>Where the task comes from<\/legend>/);
  assert.match(html, /<fieldset class="pl-acks"><legend>Required before the run starts<\/legend>/);
  assert.ok(!/style\s*=\s*"|\son(?:click|input|change)=/.test(html + page.pipeline.render({})), 'no inline style or handler');
});

test('only the approve button is yellow; Stop and the red and green words each carry text', async t => {
  const { page } = await bootWith(t, [baseState({ stage: 'test', design: designFacts(), screen: { passed: true, pilots: pilots([0.1, 0.2]) }, test: { passed: null, pilots: pilots([0.1, 0.9], { 1: { audit: { status: 'DISCARDED' } } }) } })]);
  assert.equal((page.html().match(/class="primary"/g) || []).length, 0, 'no yellow button while a pipeline runs');
  for (const m of page.html().matchAll(/<span class="pill (green|red|amber)">([^<]*)<\/span>/g)) assert.ok(m[2].trim().length > 2, 'a status pill with a word: ' + m[0]);
  for (const m of page.html().matchAll(/<span class="pl-(yes|no)">[\s\S]*?<\/span>(?:[\s\S]*?)<\/span>/g)) assert.match(m[0].replace(/<[^>]*>/g, ' '), /\b(Yes|No)\b/);
  assert.match(page.region('actions'), /class="danger" data-pl="stop"/);
});

test('the page keeps the task link out of the browser: no storage, no request of its own, and relative /api/ paths only', async t => {
  const { companion, page } = await bootWith(t);
  await page.startFromLink();
  for (const call of companion.calls) assert.ok(call.url.startsWith('/api/'), call.url);
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(PIPELINE_SOURCE));
  assert.ok(!/\bfetch\b|XMLHttpRequest|sendBeacon|WebSocket|EventSource/.test(PIPELINE_SOURCE));
  assert.ok(!/https?:\/\//.test(PIPELINE_SOURCE.replace(/placeholder="https:\/\/tasks\.example\/task\/123"/, '')), 'no absolute URL but the invented placeholder');
  assert.ok(!SECRET.length || !JSON.stringify([...page.elements.values()].map(e => [e.innerHTML, e.textContent])).includes(SECRET), 'the link is in no element');
});

test('the page works at phone width by construction: stacked table rows with data labels, one-column steps, a sticky bar that stacks', () => {
  assert.match(CSS, /@media\(max-width:700px\)\{[\s\S]*\.pl-steps\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(CSS, /\.pl-table td::before\{content:attr\(data-label\)/);
  assert.match(CSS, /\.pl-bar\{position:sticky;top:0/);
  assert.match(CSS, /@media\(max-width:700px\)\{[\s\S]*\.pl-actions\{grid-column:2;grid-row:1\}[\s\S]*\.pl-meta,\.pl-progress\{display:none\}/, 'on a phone Stop stays beside the stage line and the bar loses its detail lines');
  assert.ok(!/(?:^|[;{\s])(?:min-)?width:\s*\d{3,}px/.test(CSS.replace(/@media\([^)]*\)/g, '')), 'no fixed wide width');
  assert.match(CSS, /\.pl-root \.card:empty\{display:none\}/);
});

/* ====================================================================== the adapter and the constants */

const plain = value => JSON.parse(JSON.stringify(value));
test('adapt() survives anything the companion could send, and reads only what it needs', () => {
  const { adapt } = makeAdapter();
  for (const bad of [null, undefined, 0, '', 'text', [], true]) assert.equal(adapt(bad), null, JSON.stringify(bad));
  const empty = adapt({});
  assert.equal(empty.stage, 'import');
  assert.equal(empty.id, '');
  assert.equal(empty.ended, false);
  assert.equal(empty.spentUsd, 0);
  assert.equal(empty.capUsd, null);
  assert.equal(empty.waiting, null);
  assert.equal(empty.screen, null);
  assert.equal(empty.hasDesign, false);
  assert.deepEqual(plain(empty.design.traps), []);
  assert.deepEqual(plain(empty.attempts), []);
  assert.equal(adapt({}, 'fallback-id').id, 'fallback-id');
  const odd = adapt({ id: 'x-y-z', stage: 7, capUsd: '30', spentUsd: 'abc', redesigns: [1, 2], waiting: true, import: 'no', classification: [], source: 'x', design: { traps: 'x', newFiles: [1, null, {}, { name: 'n.txt' }], editedFiles: [null, 3, { name: 'a', reason: 4 }, 'b.txt'], notes: [1, 'ok', null] }, attempts: [null, 3, { n: 'z', traps: [{ title: 'T' }, 5], screen: { pilots: 'x' }, test: { pilots: [null, { score: '0.2', valid: true }, { score: 0.3, valid: false }, { audit: 'CLEAN' }] } }] });
  assert.equal(odd.stage, 'import', 'a stage that is not text is the first stage');
  assert.equal(odd.capUsd, 30);
  assert.equal(odd.spentUsd, 0);
  assert.equal(odd.redesigns, 0, 'only a count is a count');
  assert.equal(odd.waiting, null, 'only an object is a wait');
  assert.equal(odd.hasDesign, true);
  assert.deepEqual(plain(odd.design.newFiles), ['1', 'n.txt']);
  assert.deepEqual(plain(odd.design.edited), [{ name: 'a', reason: '4', diff: null, size: null }, { name: 'b.txt', reason: '', diff: null, size: null }]);
  assert.deepEqual(plain(odd.design.notes), ['1', 'ok']);
  assert.equal(odd.attempts.length, 1);
  assert.deepEqual(plain(odd.attempts[0].traps), ['T', '5']);
  assert.deepEqual(plain(odd.test.pilots.map(p => p.score)), [null, 0.2, null, null], 'a score the grader did not accept is no score');
  assert.deepEqual(plain(odd.test.pilots.map(p => p.audit)), ['', '', '', ''], 'audit is read from { status } only');
  assert.equal(adapt({ id: 'a-b-c', stage: 'done' }).ended, true);
  assert.equal(adapt({ id: 'a-b-c', stage: 'budget' }).ended, true);
  assert.equal(adapt({ id: 'a-b-c', stage: 'redesign' }).ended, false);
  assert.equal(adapt({ id: 'a-b-c', redacted: 'yes' }).redacted, false, 'only true counts');
  assert.match(JSON.stringify(adapt({ id: 'a-b-c', error: { message: 'm' }, summary: 's' })), /"error":"m"/);
});

test('adapt() reads the real shape of the companion: source, counts, references, withheld files, attempts and the last attempt as current', () => {
  const { adapt } = makeAdapter();
  const v = adapt(doneState({ import: importFacts({ skipped: [{ name: 'a.tmp', why: 'temporary' }] }), classification: { ...classification(), notes: ['Names were matched by heuristics.'] } }));
  assert.deepEqual(plain(v.source), { folder: false, origin: 'https://tasks.example', path: '/review/atlas-4821', name: '', pageOrigin: '', pagePath: '' });
  assert.deepEqual(plain(v.files), { total: 9, world: 5, task: 3, withheld: 2, other: 1 });
  assert.deepEqual(plain(v.skipped), [{ name: 'a.tmp', why: 'temporary' }]);
  assert.deepEqual(plain(v.cls.prompt), { kind: 'section', name: 'Business request' });
  assert.deepEqual(plain(v.cls.guideline), { kind: 'file', name: 'Atlas_Grader_Guide.docx' });
  assert.deepEqual(plain(v.cls.withheld), [{ name: 'Atlas_Grader_Guide.docx', why: 'it is the grader guideline' }, { name: 'Atlas_Reference_Answer.docx', why: 'it is the golden answer' }]);
  assert.deepEqual(plain(v.cls.notes), ['Names were matched by heuristics.']);
  assert.equal(v.attempts.length, 2);
  assert.deepEqual(plain(v.attempts.map(a => a.current)), [false, true]);
  assert.equal(v.screen.passed, true);
  assert.equal(v.test.pilots.length, 5);
  assert.equal(v.test.pilots[2].score, 0.44);
  assert.equal(v.hasDesign, true);
  assert.equal(v.label, 'Atlas review');
  const folder = adapt(baseState({ source: { kind: 'folder', name: 'atlas-task' }, import: { fileCount: 4 } }));
  assert.deepEqual(plain(folder.source), { folder: true, origin: '', path: '', name: 'atlas-task', pageOrigin: '', pagePath: '' });
  const withPage = adapt(baseState({ source: { kind: 'folder', name: 'atlas-task' }, import: { fileCount: 4, page: { origin: 'https://tasks.example', path: '/review/atlas-4821' } } }));
  assert.deepEqual([withPage.source.pageOrigin, withPage.source.pagePath, withPage.source.origin], ['https://tasks.example', '/review/atlas-4821', ''], 'a folder with a page.json keeps its task page apart from its source');
  assert.equal(folder.files.total, 4);
  const row = adapt({ id: 'pln-0123456789ab', label: 'Atlas', createdAt: 't', updatedAt: 't', endedAt: null, stage: 'screen', running: true, message: 'Running 2 pilots for the screen', spentUsd: 1.5, capUsd: 30, attempt: 1, redesigns: 0, verdict: null });
  assert.equal(row.stage, 'screen');
  assert.equal(row.message, 'Running 2 pilots for the screen');
  assert.equal(row.capUsd, 30);
});

test('adapt() turns a structured diff into text lines and keeps its counts; an object without lines is nothing', () => {
  const { adapt } = makeAdapter();
  const v = adapt(baseState({ design: designFacts({ guidelineDiff: STRUCTURED(), editedFiles: [{ name: 'a', diff: { kind: 'binary', before: 1, after: 2, lines: [] } }, { name: 'b', diff: { added: 1 } }, { name: 'c', diff: { lines: [{ op: '?', text: 'odd' }, null, { op: '+', text: 5 }] } }] }) }));
  assert.deepEqual(plain(v.design.guidelineDiff), { text: ' Award full credit when the answer holds the borrowing.\n-Count the available facility as cash.\n+Do not count the available facility as cash.', added: 1, removed: 1, truncated: false, available: true, kind: 'text', before: 2000, after: 2100 });
  assert.equal(v.design.edited[0].diff.kind, 'binary');
  assert.equal(v.design.edited[1].diff, null, 'no lines, no diff');
  assert.equal(v.design.edited[2].diff.text, ' odd\n+5', 'an unknown op is a context line');
  assert.equal(v.design.edited[0].size, '+1 byte');
});

test('the export answer is read as { name, zipBase64 } and a name that is not a private zip name is replaced', () => {
  const { adaptExport } = makeAdapter();
  assert.deepEqual(plain(adaptExport({ name: 'Atlas_pipeline_PRIVATE.zip', size: 3, sha256: 'x', files: [], zipBase64: 'QUJD\n' }, 'pln-1')), { base64: 'QUJD', name: 'Atlas_pipeline_PRIVATE.zip' });
  assert.deepEqual(plain(adaptExport({ name: 'a/b.zip', zipBase64: 'QUJD' }, 'pln-1')), { base64: 'QUJD', name: 'pln-1_pipeline_PRIVATE.zip' });
  assert.deepEqual(plain(adaptExport(null, 'pln-1')), { base64: '', name: 'pln-1_pipeline_PRIVATE.zip' });
});

function makeAdapter() {
  const context = vm.createContext({ document: { addEventListener() {} }, console });
  context.window = context;
  vm.runInContext(PIPELINE_SOURCE, context, { filename: 'pipeline.js' });
  return context.FinancePipeline;
}

test('the display constants match backend/pipeline/constants.cjs when the orchestrator has it', t => {
  const file = path.join(REPO, 'backend', 'pipeline', 'constants.cjs');
  if (!fs.existsSync(file)) { t.skip('backend/pipeline/constants.cjs is not there yet'); return; }
  const k = require(file), { RULES } = makeAdapter();
  /* the test bar is PASS_BAR (or TEST_BAR once the orchestrator names it); the screen bar is SCREEN_BAR when it has one */
  assert.equal(RULES.testBar, k.TEST_BAR !== undefined ? k.TEST_BAR : k.PASS_BAR);
  if (k.SCREEN_BAR !== undefined) assert.equal(RULES.screenBar, k.SCREEN_BAR);
  assert.equal(RULES.screenPilots, k.SCREEN_PILOTS);
  assert.equal(RULES.testPilots, k.TEST_PILOTS);
  assert.equal(RULES.testNeed, k.TEST_NEED);
  assert.equal(RULES.maxRedesigns, k.MAX_REDESIGNS);
  /* The default total cap is USD 60. The companion may report its own (GET /api/pipeline config.defaultCapUsd) and the page follows that: see the cap tests. */
  assert.equal(RULES.defaultCapUsd, 60);
  assert.equal(RULES.defaultCapUsd, k.DEFAULT_CAP_USD, 'the page default is the companion\'s');
  assert.equal(RULES.maxCapUsd, k.MAX_CAP_USD);
  if (k.GOLDEN_MIN !== undefined) assert.equal(makeAdapter().CALIBRATION_MIN, k.GOLDEN_MIN, 'the calibration the page says is needed is the one the companion enforces');
  const { ACKNOWLEDGEMENTS } = makeAdapter();
  assert.deepEqual(Array.from(ACKNOWLEDGEMENTS, x => x.id), [...k.ACKNOWLEDGEMENTS], 'the page asks for exactly the acknowledgements the companion requires, in its order');
  const fourth = ACKNOWLEDGEMENTS[3];
  assert.equal(fourth.label + ': ' + fourth.text.charAt(0).toLowerCase() + fourth.text.slice(1), k.MODEL_READS_TASK_TEXT, 'the fourth acknowledgement is the companion\'s sentence word for word');
});

test('the display constants are the spec numbers', () => {
  const { RULES } = makeAdapter();
  assert.deepEqual(plain(RULES), { screenBar: 0.4, testBar: 0.45, screenPilots: 2, testPilots: 5, testNeed: 4, maxRedesigns: 3, defaultCapUsd: 60, maxCapUsd: 200 });
});

test('a message that answers the person stays until the stage changes; an error from an action stays until the next action', async t => {
  const { companion, page } = await bootWith(t, [baseState({ stage: 'import', waiting: { kind: 'needs-person', message: 'Flip it.' } })]);
  await page.click('continue');
  assert.equal(page.status(), 'Continuing.');
  await page.tick();
  assert.equal(page.status(), 'Continuing.', 'same stage: the answer stays');
  companion.update('pl-atlas-0001', { stage: 'classify' });
  await page.tick();
  assert.equal(page.status(), '', 'a new stage replaces it');
  companion.fail('POST /api/pipeline/pl-atlas-0001/stop', 500, 'Could not stop.');
  await page.click('stop');
  assert.equal(page.status(), 'Failed: Could not stop.');
  companion.update('pl-atlas-0001', { stage: 'design' });
  await page.tick();
  assert.equal(page.status(), 'Failed: Could not stop.', 'an action error is not taken back by a poll');
  await page.click('stop');
  assert.match(page.status(), /^Stop requested/);
});

test('after a failed action the keyboard goes back to the control it was on', async t => {
  const { companion, page } = await bootWith(t, [baseState({ stage: 'screen' })]);
  companion.fail('POST /api/pipeline/pl-atlas-0001/stop', 500, 'Could not stop.');
  /* the button holds the keyboard when the action starts; the repaint then destroys it, so nothing is focused afterwards */
  let reads = 0;
  Object.defineProperty(page.document, 'activeElement', { get: () => (reads++ === 0 ? { getAttribute: name => (name === 'data-pl-key' ? 'stop' : null) } : null) });
  await page.click('stop');
  assert.deepEqual(page.focused.slice(-1), ['stop']);
});

test('a double click on Approve and start starts one pipeline', async t => {
  const { companion, page } = await bootWith(t);
  await page.fillLink();
  await page.ackAll();
  const tag = page.tagOf('data-pl', 'start');
  const el = { dataset: { pl: 'start' }, disabled: /\sdisabled(\s|>|=)/.test(tag), closest: s => (s === '[data-pl]' ? el : s === '#pl-root' ? {} : null) };
  page.pipeline.handleEvent({ type: 'click', target: el });
  page.pipeline.handleEvent({ type: 'click', target: el });
  await page.settle();
  assert.equal(companion.calls.filter(c => c.url === '/api/pipeline/start').length, 1);
});

test('a pipeline the companion lists but cannot read is reported in words and the page still opens', async t => {
  const companion = makeCompanion();
  companion.put(baseState({ stage: 'screen' }));
  companion.fail('GET /api/pipeline/pl-atlas-0001', 500, 'The state file could not be read.');
  const page = makePage(t, companion);
  await page.boot();
  assert.equal(page.status(), 'Failed: The state file could not be read.');
  assert.match(page.stage(), /^Screen:/, 'what the list said is shown meanwhile');
  assert.equal(page.pending().length, 1, 'and the page tries again');
  await page.tick();
  assert.equal(page.status(), '', 'the next good poll clears the message');
});

/* ====================================================================== designer v2: the new mode (start form, check files, design, brief, checks, stages, result) */

/* what GET /api/pipeline reports for the new mode (service.cjs _rules): the parts of the least cap of both modes, the diagnostic suite, the review caps and the default reference folder */
const NEW_MIN = { fixedUsd: 20.5, perPilotUsd: 1.5, pilots: 7, headroom: 1.15 };
const HARDEN_MIN = { fixedUsd: 8, perPilotUsd: 1, pilots: 7, headroom: 1.15 };
const REF_NAMES = ['Atlas_Review_Handbook.md', 'Meridian_Workflow_Catalog.pdf'];
const V2 = {
  ...CFG, defaultCapUsd: 60, designModes: ['new', 'harden'], defaultDesignMode: 'new', alternativeMin: 0.85, fairnessSetCapUsd: 3, minCapFairnessSetUsd: 3,
  minCap: NEW_MIN, minCapByMode: { new: NEW_MIN, harden: HARDEN_MIN }, blindReviewCapUsd: 1.5, revealReviewCapUsd: 0.5, applicationCapUsd: 0.5, adjudicationCapUsd: 0.5,
  references: { maxFiles: 20, maxBytes: 8388608, extensions: ['.md', '.txt', '.pdf'], default: { exists: true, found: 2, names: REF_NAMES, bytes: 48211, problems: 0 } },
};
const startBody = c => c.calls.find(x => x.method === 'POST' && x.url === '/api/pipeline/start').body;
const formOf = page => page.region('start-form');
const NEW_LEGEND = '<legend>For a new task</legend>';

test('the start form offers the design mode: a new task from the world files (the default) or hardening the existing task', async t => {
  const { page } = await bootWith(t, [], { config: V2 });
  const f = formOf(page);
  assert.match(f, /<label class="field pl-mode">What to design<select data-pl-in="designMode" data-pl-key="design-mode" aria-describedby="pl-mode-note">/);
  assert.match(f, /<option value="new" selected>New task from the world files<\/option><option value="harden" >Harden the existing task<\/option>/);
  assert.match(f, /<small id="pl-mode-note">The designer starts from the world files alone and writes the prompt, the grader guideline, the golden answer and a brief/);
  /* the same with a companion that does not say which modes it has */
  const { page: bare } = await bootWith(t);
  assert.match(formOf(bare), /<option value="new" selected>New task from the world files<\/option><option value="harden" >Harden the existing task<\/option>/);
  /* the companion's default, until the person has chosen */
  const { page: hd } = await bootWith(t, [], { config: { ...V2, defaultDesignMode: 'harden' } });
  assert.match(formOf(hd), /<option value="harden" selected>/);
  await hd.type('designMode', { value: 'new' });
  assert.match(formOf(hd), /<option value="new" selected>/);
  /* a choice that is not a mode is ignored */
  await hd.type('designMode', { value: 'surprise' });
  assert.match(formOf(hd), /<option value="new" selected>/);
});

test('the fields of the new mode: the reference documents line (names only), keep these files as world files with its warning, and the diagnostic answers with their cost', async t => {
  const { page } = await bootWith(t, [], { config: V2 });
  const f = formOf(page);
  assert.ok(f.includes(NEW_LEGEND));
  assert.match(f, /<p class="pl-refs" id="pl-refs">Reference documents: 2 files found in the default folder \(Atlas_Review_Handbook\.md, Meridian_Workflow_Catalog\.pdf\)\. The designer and the reviewers read them and their text is sent to Anthropic\. Pilots never see them\.<\/p>/);
  assert.doesNotMatch(f, /48211|12000/, 'the sizes are not the page\'s business, and never a word of the content');
  assert.match(f, /<label class="field">Keep these files as world files \(optional\)<input type="text" id="pl-keep" data-pl-in="keepAsWorld" data-pl-key="keep-as-world" value=""/);
  assert.match(f, /<small id="pl-keep-hint"><strong>Warning:<\/strong> the pilots get these files, and so does the designer, even if the names look like answers or grading material\./);
  assert.match(f, /<input type="checkbox" data-pl-in="fairnessSet" data-pl-key="fairness-set" ><span><strong>Also run the diagnostic answers \(adds up to USD 3\.00 per attempt\)<\/strong>/);
  assert.doesNotMatch(f, /no-references/, 'no problem in the folder, so no box to start without it');
  /* the harden mode hides all three */
  await page.type('designMode', { value: 'harden' });
  const h = formOf(page);
  assert.doesNotMatch(h, /For a new task|pl-refs|data-pl-in="keepAsWorld"|data-pl-in="fairnessSet"|Reference documents/);
  assert.match(h, /<option value="harden" selected>/);
  await page.type('designMode', { value: 'new' });
  assert.ok(formOf(page).includes(NEW_LEGEND), 'and they are back in the new mode');
  /* what the companion does not say, the page does not say */
  const { page: none } = await bootWith(t);
  assert.doesNotMatch(formOf(none), /Reference documents/);
  assert.match(formOf(none), /Also run the diagnostic answers<\/strong>/, 'no cost to quote');
  assert.doesNotMatch(formOf(none), /adds up to/);
});

test('the reference line: none found, many found, and a folder with problems (the reason, a box to start without it, and Start waits for one of the two)', async t => {
  const none = { ...V2, references: { default: { exists: false, found: 0, names: [], bytes: 0, problems: 0 } } };
  const { page } = await bootWith(t, [], { config: none });
  assert.match(formOf(page), /<p class="pl-refs" id="pl-refs">Reference documents: none found in the default folder\. The designer works from the world files and its own list of ideas\.<\/p>/);
  const bad = { ...V2, references: { default: { exists: true, found: 0, names: [], bytes: 0, problems: 2 } } };
  const { companion, page: p2 } = await bootWith(t, [], { config: bad });
  const f = formOf(p2);
  assert.match(f, /<p class="pl-refs pl-refs-problem" id="pl-refs">Reference documents: the default folder has 2 problems, so a start is refused\. Fix the folder, or start without it\.<\/p>/);
  assert.match(f, /<input type="checkbox" data-pl-in="noReferences" data-pl-key="no-references" ><span><strong>Start without the reference folder<\/strong>/);
  await ready(p2);
  assert.equal(p2.enabled('start'), false);
  assert.equal(whyOf(p2), 'The reference folder has problems, so the companion would refuse the start. Fix it, or tick Start without the reference folder.');
  await p2.type('noReferences', { checked: true });
  assert.equal(p2.enabled('start'), true);
  assert.equal(whyOf(p2), '');
  await p2.click('start');
  assert.equal(startBody(companion).referencesDir, false, 'start without the reference folder sends referencesDir: false');
  /* the companion's list of problems (problemList: at most 20 short plain sentences, each naming a file or the folder and the reason), one line each; problems stays the count */
  const reasons = ['Meridian_Notes.docx is a link, not a file', 'The folder holds more than 8 MB', 'A file is hidden: .draft.md'];
  const listed = { ...V2, references: { default: { exists: true, found: 0, names: [], bytes: 0, problems: 3, problemList: reasons } } };
  const { page: p3 } = await bootWith(t, [], { config: listed });
  assert.match(formOf(p3), /<p class="pl-refs pl-refs-problem" id="pl-refs">Reference documents: the default folder has 3 problems, so a start is refused\. Fix the folder, or start without it\.<\/p><ul class="pl-names pl-refs-list"><li>Meridian_Notes\.docx is a link, not a file<\/li><li>The folder holds more than 8 MB<\/li><li>A file is hidden: \.draft\.md<\/li><\/ul>/);
  await ready(p3);
  assert.equal(p3.enabled('start'), false);
  await p3.type('designMode', { value: 'harden' });
  assert.equal(p3.enabled('start'), true, 'the harden mode reads no reference folder');
  /* the count and the list may differ (the list holds at most 20): the count is what is said */
  const many = { ...V2, references: { default: { exists: true, found: 0, names: [], bytes: 0, problems: 31, problemList: Array.from({ length: 20 }, (_, i) => 'File ' + i + ' is not allowed') } } };
  const { page: p6 } = await bootWith(t, [], { config: many });
  assert.match(formOf(p6), /has 31 problems, so a start is refused/);
  assert.equal((formOf(p6).match(/<li>File \d+ is not allowed<\/li>/g) || []).length, 20);
  /* a problem list that is not text is dropped; the older shape (the list in problems) is still read */
  const odd = { ...V2, references: { default: { exists: true, found: 0, names: [], bytes: 0, problems: 2, problemList: ['A', null, 5, { x: 1 }, '', 'B'] } } };
  const { page: p7 } = await bootWith(t, [], { config: odd });
  assert.match(formOf(p7), /<ul class="pl-names pl-refs-list"><li>A<\/li><li>5<\/li><li>B<\/li><\/ul>/);
  const older = { ...V2, references: { default: { exists: true, found: 0, names: [], bytes: 0, problems: ['The folder holds a link', 'A file is hidden'] } } };
  const { page: p8 } = await bootWith(t, [], { config: older });
  assert.match(formOf(p8), /has 2 problems, so a start is refused\. Fix the folder, or start without it\.<\/p><ul class="pl-names pl-refs-list"><li>The folder holds a link<\/li><li>A file is hidden<\/li><\/ul>/);
  const none2 = { ...V2, references: { default: { exists: true, found: 0, names: [], bytes: 0, problems: 0, problemList: ['Stale entry'] } } };
  const { page: p9 } = await bootWith(t, [], { config: none2 });
  assert.doesNotMatch(formOf(p9), /Stale entry|pl-refs-problem/, 'no problem is counted, so none is shown');
  const one = { ...V2, references: { default: { exists: true, found: 0, names: [], bytes: 0, problems: 1 } } };
  const { page: p4 } = await bootWith(t, [], { config: one });
  assert.match(formOf(p4), /has 1 problem, so a start is refused/);
  /* no box is ticked in a folder without problems, and none is sent */
  const { companion: c5, page: p5 } = await bootWith(t, [], { config: V2 });
  await p5.startFromLink();
  assert.equal('referencesDir' in startBody(c5), false);
});

test('the start body: designMode always; in the new mode the names to keep, the diagnostic switch and the reference choice; in the harden mode none of them', async t => {
  const { companion, page } = await bootWith(t, [], { config: V2 });
  await page.startFromLink();
  const plainBody = startBody(companion);
  assert.equal(plainBody.designMode, 'new');
  for (const key of ['keepAsWorld', 'fairnessSet', 'referencesDir']) assert.equal(key in plainBody, false, key + ' is left out when it is not asked for');
  assert.deepEqual(plainBody.acknowledgements, ACK_IDS);
  /* every field of the new mode */
  const { companion: c2, page: p2 } = await bootWith(t, [], { config: V2 });
  await p2.type('keepAsWorld', { value: ' Atlas_Parent_Answer.xlsx , Meridian_Notes.txt,, Atlas_Parent_Answer.xlsx ' });
  await p2.type('fairnessSet', { checked: true });
  await p2.fillLink();
  await p2.ackAll();
  await p2.click('start');
  const full = startBody(c2);
  assert.deepEqual(full.keepAsWorld, ['Atlas_Parent_Answer.xlsx', 'Meridian_Notes.txt'], 'trimmed, no empty name, none twice');
  assert.equal(full.fairnessSet, true);
  assert.equal(full.designMode, 'new');
  /* the harden mode: what was typed for the new mode is not sent */
  const { companion: c3, page: p3 } = await bootWith(t, [], { config: V2 });
  await p3.type('keepAsWorld', { value: 'Atlas_Parent_Answer.xlsx' });
  await p3.type('fairnessSet', { checked: true });
  await p3.type('designMode', { value: 'harden' });
  await p3.startFromLink();
  const hb = startBody(c3);
  assert.equal(hb.designMode, 'harden');
  for (const key of ['keepAsWorld', 'fairnessSet', 'referencesDir']) assert.equal(key in hb, false, 'the harden mode does not send ' + key);
  assert.deepEqual(plain(Object.keys(hb).sort()), ['acceptMissing', 'acknowledgements', 'capUsd', 'designMode', 'effort', 'model', 'pilotCapUsd', 'url']);
});

test('keep these files as world files: at most 50 names, plain file names, and Start says why when one is not', async t => {
  const { page } = await bootWith(t, [], { config: V2 });
  await ready(page);
  assert.equal(page.enabled('start'), true);
  const names = n => Array.from({ length: n }, (_, i) => 'Atlas_File_' + i + '.csv').join(',');
  await page.type('keepAsWorld', { value: names(50) });
  assert.equal(page.enabled('start'), true, 'fifty is allowed');
  await page.type('keepAsWorld', { value: names(51) });
  assert.equal(page.enabled('start'), false);
  assert.equal(whyOf(page), 'Keep at most 50 files as world files.');
  await page.type('keepAsWorld', { value: names(50) + ',' + names(50) });
  assert.equal(page.enabled('start'), true, 'the same name twice is one name');
  for (const bad of ['/etc/passwd', '../Secret.txt', 'a/../b.txt', 'x'.repeat(301)]) {
    await page.type('keepAsWorld', { value: 'Atlas_Ok.csv, ' + bad });
    assert.equal(whyOf(page), 'Each file to keep as a world file must be a plain file name, without a leading slash or ..', bad.slice(0, 20));
    assert.equal(page.enabled('start'), false);
  }
  await page.type('keepAsWorld', { value: '' });
  assert.equal(page.enabled('start'), true);
  /* typing for the harden mode is not checked */
  await page.type('keepAsWorld', { value: '../bad' });
  await page.type('designMode', { value: 'harden' });
  assert.equal(page.enabled('start'), true, 'the harden mode ignores the field');
});

test('the figure by the cap field follows the design mode and the diagnostic switch; the reviews and the adjudications are part of every attempt; 60 covers the new mode, and the diagnostic answers go over it', async t => {
  const { page } = await bootWith(t, [], { config: V2 });
  /* 1.15 x (20.5 + 7 x (3 + 1.5)) = 59.80 */
  const sent = ' The reviews and the adjudication of low scores are part of every attempt.';
  assert.equal(capMinInForm(page), 'If the screen passes, one full attempt (screen and test) can cost up to USD 59.80.' + sent);
  assert.doesNotMatch(capMinInForm(page), /may stop at the cap/, 'the default total cap of 60 pays for it');
  assert.match(formOf(page), /id="pl-cap"[^>]*value="60"/);
  /* with the diagnostic answers: 1.15 x (20.5 + 3 + 7 x 4.5) = 63.25 */
  await page.type('fairnessSet', { checked: true });
  assert.equal(page.element('pl-cap-min').textContent, 'If the screen passes, one full attempt (screen and test) can cost up to USD 63.25.' + sent + ' With this total cap the run may stop at the cap before the 5-pilot test.');
  await ready(page);
  assert.equal(page.enabled('start'), true, 'a cap below the figure is a warning, not a block');
  await page.type('cap', { value: '63.25' });
  assert.doesNotMatch(page.element('pl-cap-min').textContent, /may stop at the cap/);
  await page.type('fairnessSet', { checked: false });
  assert.equal(page.element('pl-cap-min').textContent, 'If the screen passes, one full attempt (screen and test) can cost up to USD 59.80.' + sent);
  /* the harden mode has its own parts, and the diagnostic switch is not part of it */
  await page.type('designMode', { value: 'harden' });
  assert.equal(capMinInForm(page), 'If the screen passes, one full attempt (screen and test) can cost up to USD 41.40. The fairness review is part of every attempt.');
  /* the new mode's figure moves with the pilot cap: 1.15 x (20.5 + 7 x (5 + 1.5)) = 75.90 */
  await page.type('designMode', { value: 'new' });
  await page.type('pilotCap', { value: '5' });
  assert.equal(page.element('pl-cap-min').textContent, 'If the screen passes, one full attempt (screen and test) can cost up to USD 75.90.' + sent + ' With this total cap the run may stop at the cap before the 5-pilot test.');
});

test('the figure by the cap field without the parts of a mode: the default mode falls back to minCap, a mode the companion does not describe gets no figure, and a withheld or odd part is not used', async t => {
  const { page } = await bootWith(t, [], { config: { ...CFG, minCap: NEW_MIN } });
  assert.equal(capMinInForm(page), 'If the screen passes, one full attempt (screen and test) can cost up to USD 59.80. The reviews and the adjudication of low scores are part of every attempt.', 'config.minCap is the default mode\'s');
  await page.type('designMode', { value: 'harden' });
  assert.equal(capMinInForm(page), '', 'the harden mode is not described: no figure');
  assert.equal(page.element('pl-cap-min').textContent, '');
  const { page: odd } = await bootWith(t, [], { config: { ...CFG, minCapByMode: { new: { withheld: true }, harden: 'x' }, minCapFairnessSetUsd: 'three' } });
  assert.equal(capMinInForm(odd), '');
  /* a diagnostic suite whose cost the companion does not give: the cap of the suite, else nothing is added */
  const { page: noExtra } = await bootWith(t, [], { config: { ...V2, minCapFairnessSetUsd: undefined, fairnessSetCapUsd: undefined } });
  await noExtra.type('fairnessSet', { checked: true });
  assert.match(noExtra.element('pl-cap-min').textContent, /up to USD 59\.80\./);
});

test('the cost line says that the five test pilots run only when the screen passes, and names the caps of the checks of a new design', async t => {
  const { page } = await bootWith(t, [], { config: V2 });
  const limits = () => page.region('start-foot').match(/<p class="footnote pl-limits">([^<]*)<\/p>/)[1];
  assert.match(limits(), /The 5 test pilots run only when both screen pilots score below 0\.40, and a round stops as soon as its result is decided\./);
  assert.match(limits(), /The other calls are capped too: the classifier USD 0\.50, the designer USD 5\.00 and one repair turn USD 1\.00, the blind review USD 1\.50, the second review USD 0\.50, each application check USD 0\.50, each adjudication of a low score USD 0\.50, each grader call USD 0\.50\./);
  assert.doesNotMatch(limits(), /fairness review/);
  await page.type('designMode', { value: 'harden' });
  assert.match(limits(), /the fairness review USD 0\.25, each grader call USD 0\.50/);
  assert.doesNotMatch(limits(), /blind review|adjudication/);
});

test('the fourth acknowledgement is the companion\'s sentence and names the reviewers and the reference documents', async t => {
  const { page } = await bootWith(t);
  const text = strip(formOf(page));
  assert.ok(text.includes('The reviewers of a new design are Claude Code runs too: the blind reviewer reads a copy of the packet with the Read, Glob and Grep tools, and the others have no tools. When reference documents are used, the trap designer reads them and they are sent to Anthropic as well.'));
  const k = require(path.join(REPO, 'backend', 'pipeline', 'constants.cjs'));
  const { ACKNOWLEDGEMENTS } = makeAdapter();
  const fourth = ACKNOWLEDGEMENTS[3];
  assert.equal(fourth.label + ': ' + fourth.text.charAt(0).toLowerCase() + fourth.text.slice(1), k.MODEL_READS_TASK_TEXT, 'word for word');
});

/* ---- invented new-mode states, in the shape of backend/pipeline (service.cjs _view, new-design.cjs): atlas and meridian, no real names ---- */

const COUNTING = new Set(['intended', 'other_valid_error']);
const LOW_KEY = { intended: 'intended', other_valid_error: 'otherValid', permitted_alternative: 'permittedAlternative', grader_defect: 'graderDefect', ambiguous: 'ambiguous', tool_failure: 'toolFailure', unsupported: 'unsupported' };
const adj = (klass, over = {}) => ({ class: klass, claimed: klass, counts: COUNTING.has(klass), note: '', application: null, ...over });
/* A stage of the new mode: spec is [score, diagnosis class or null] per pilot; the counts, the unexplained list and each pilot's verdict follow from it, as the orchestrator keeps them. */
function explainedStage(name, spec, passed, over = {}, pilotExtra = {}) {
  const bar = name === 'test' ? 0.45 : 0.4;
  const extra = {};
  spec.forEach(([score, klass], i) => {
    const low = typeof score === 'number' && score < bar;
    extra[i] = { ...(low && klass ? { adjudication: adj(klass), countsTowardPass: COUNTING.has(klass) } : { adjudication: null, countsTowardPass: low ? null : false }), ...(pilotExtra[i] || {}) };
  });
  const lows = { lowScorers: 0, intended: 0, otherValid: 0, permittedAlternative: 0, graderDefect: 0, ambiguous: 0, toolFailure: 0, unsupported: 0, counted: 0 };
  const unexplained = [];
  spec.forEach(([score, klass], i) => {
    if (typeof score !== 'number' || score >= bar) return;
    lows.lowScorers++;
    if (klass) lows[LOW_KEY[klass]]++;
    if (COUNTING.has(klass)) lows.counted++;
    else unexplained.push({ pilot: 'p' + (i + 1), class: klass || 'unsupported', score });
  });
  return { ...stageOf(name, spec.map(x => x[0]), passed, extra), explained: lows.counted, lows, unexplained, recount: null, ...over };
}
const TRAP_RULE = 'Leverage is measured on funded debt net of cash held in the blocked account.';
const newBrief = (over = {}) => ({
  taskType: { workflow: 'Quarterly covenant review', why: 'The world files hold a facility agreement, a ledger and an amendment that a covenant review can use.', referenceEntries: ['Covenant walkthrough'] },
  decision: { ask: 'Does the Atlas borrower meet its leverage covenant at quarter end?', mandate: 'Advise the credit committee whether a waiver is needed.', authorityFile: 'Atlas_Facility_Agreement.txt', effectiveDate: '2025-01-01' },
  files: [{ name: 'Atlas_Facility_Agreement.txt', role: 'authority' }, { name: 'Atlas_Ledger.csv', role: 'evidence' }, { name: 'Meridian_Old_Schedule.csv', role: 'decoy' }],
  traps: [{
    id: 't1', primary: true, rule: { file: 'Atlas_Facility_Agreement.txt', clause: TRAP_RULE },
    correctPath: { reasoning: 'Net the blocked cash against funded debt before the ratio.', action: 'Report the covenant as met', figures: [{ label: 'Net leverage', value: 3.4, tolerance: 0.05 }] },
    wrongPath: { reasoning: 'Use gross funded debt, as the ledger line shows it.', action: 'Report the covenant as breached', figures: [{ label: 'Net leverage', value: 4.1, tolerance: 0.05 }] },
    changesDecision: 'required_conclusion', whyTempting: { kind: 'effort', source: 'The ledger has one gross debt line that is quick to use.' },
    consequence: { source: 'A breach report triggers the default notice of the amendment.' },
    strongestAlternative: { answer: 'Report the covenant as met and ask for a waiver', whyRejected: 'No waiver is needed while the ratio is inside the limit.' },
  }],
  permittedAlternatives: [{ answer: 'Report the covenant as met and add a monitoring step', support: 'The agreement lets the committee add monitoring.', file: 'answers/alt-1.md' }],
  permittedAlternativesReason: '', controls: [], primary: 't1', ...over,
});
const passedCheck = { pass: true, failed: [], checks: { governs: true, inForce: true, notSuperseded: true, excludes: true }, dates: { effective: '2025-01-01', decision: '2025-03-31' }, hits: 0 };
const newFairness = (over = {}) => ({
  status: 'passed', repairs: 0,
  stage1: { state: 'ok', tries: 1, runs: 1, packetSha256: 'a'.repeat(64), discarded: 0 },
  stage2: { disposition: 'excluded_by_clause', objectionClass: 'permitted_discretion', evaluations: 1, application: passedCheck, briefApplication: null }, ...over,
});
const goldenRun = (grades, why = 'first grading', over = {}) => ({ why, grades, score: grades.reduce((a, b) => a + b, 0) / grades.length, passed: true, unstable: false, ...over });
const answerSetOf = (over = {}) => ({
  goldenMin: 0.9, alternativeMin: 0.85, passed: true, answers: [
    { name: 'golden', kind: 'golden', file: 'golden-answer.md', threshold: 0.9, sha256: 'b'.repeat(64), score: 0.95, grades: [0.96, 0.94], passed: true, unstable: false, runs: [goldenRun([0.96, 0.94])] },
    { name: 'alt-1', kind: 'alternative', file: 'answers/alt-1.md', threshold: 0.85, sha256: 'c'.repeat(64), score: 0.8767, grades: [0.9, 0.8, 0.8, 0.8], passed: true, unstable: true, runs: [goldenRun([0.9, 0.8, 0.88], 'first grading', { unstable: true, score: 0.8767 })] },
  ], ...over,
});
const freezeRecord = (over = {}) => ({
  n: 1, at: '2026-10-23T10:20:00.000Z', reason: 'before the pilots', packetSha256: 'd1'.repeat(32), packetFiles: 9, promptSha256: 'e2'.repeat(32), guidelineSha256: 'f3'.repeat(32), goldenSha256: 'a4'.repeat(32), answerSetSha256: 'b5'.repeat(32),
  answers: [{ name: 'golden', sha256: 'c6'.repeat(32) }], pilot: { model: 'claude-opus-5-5', effort: 'medium', capUsd: 3 }, grader: { model: 'claude-sonnet-5-5', effort: 'medium' }, budget: { totalCapUsd: 60, designCapUsd: 5, pilotCapUsd: 3 }, ...over,
});
const newAttempt = (over = {}) => attemptOf({
  n: 1, mode: 'new', validation: 'complete', outcome: 'passed', traps: ['Gross debt used for the ratio'], fairness: newFairness(), answerSet: answerSetOf(), calibration: { score: 0.95, verdict: 'meets-guidance', reason: 'Matches every rubric line.' },
  freeze: [freezeRecord()], guidelineRepair: null, diagnostic: null, taskType: newBrief().taskType,
  difficulty: { status: 'passed', screen: { passed: true, explained: 2, belowBar: 2, of: 2, need: 2, lows: { lowScorers: 2, intended: 1, otherValid: 1, permittedAlternative: 0, graderDefect: 0, ambiguous: 0, toolFailure: 0, unsupported: 0, counted: 2 } }, test: { passed: true, explained: 4, belowBar: 5, of: 5, need: 4, lows: null } },
  screen: explainedStage('screen', [[0.2, 'intended'], [0.3, 'other_valid_error']], true),
  test: explainedStage('test', [[0.1, 'intended'], [0.2, 'intended'], [0.3, 'other_valid_error'], [0.35, 'intended'], [0.8, null]], true), ...over,
});
const newState = (over = {}) => baseState({
  stage: 'done', running: false, spentUsd: 41.2, redesigns: 0, endedAt: '2026-10-23T11:00:00.000Z', import: importFacts(), classification: { ...classification(), prompt: null, guideline: null, goldenAnswer: null },
  config: { designMode: 'new', fairnessSet: false, keepAsWorld: [], acceptMissing: false, screenBar: 0.4, testBar: 0.45 },
  references: { source: 'default', found: 2, names: REF_NAMES, bytes: 48211, copied: true, files: [], unscanned: ['Meridian_Workflow_Catalog.pdf'], scannedChars: 5000, truncated: false },
  design: designFacts({ attempt: 1, brief: newBrief(), taskType: newBrief().taskType, alternatives: [{ name: 'alt-1', file: 'answers/alt-1.md', answer: 'Report the covenant as met and add a monitoring step' }], answerSet: answerSetOf(), freeze: [freezeRecord()], fairness: newFairness(), calibration: { score: 0.95, verdict: 'meets-guidance', reason: 'Matches every rubric line.' } }),
  summary: 'The test passed: 4 of 5 pilots scored below 0.45 (design attempt 1).', result: { verdict: 'success', message: 'x', validation: 'complete' }, attempts: [newAttempt()], ...over,
});

test('the files card lists the files kept as world files with the companion\'s warning, and says when a name is not among the fetched files', async t => {
  const kept = [{ name: 'Atlas_Parent_Answer.xlsx', present: true, warning: 'its name looks like an answer or grading material (a file named like an answer), and it goes to the designer and the pilots as a world file' }, { name: 'Meridian_Notes.txt', present: false, warning: 'the task has no file by this name' }];
  const { companion, page } = await bootWith(t, [confirmState({}, { keepAsWorld: kept })]);
  const w = page.region('wait');
  assert.match(w, /<div class="notice pl-warning pl-kept" role="note"><strong>You asked to keep 2 files as world files<\/strong><p class="pl-warning-lead">The designer and the pilots get these files, even if the name looks like an answer or grading material\.<\/p>/);
  assert.match(w, /<li><strong>Atlas_Parent_Answer\.xlsx<\/strong> <span class="muted">its name looks like an answer or grading material \(a file named like an answer\), and it goes to the designer and the pilots as a world file<\/span><\/li>/);
  assert.match(w, /<li><strong>Meridian_Notes\.txt<\/strong> <span class="muted">the task has no file by this name<\/span> <span class="pl-missing">Not among the files that were fetched\.<\/span><\/li>/);
  assert.ok(w.indexOf('pl-kept') < w.indexOf('pl-files-box'), 'the warning comes before the list of files');
  assert.ok(w.indexOf('pl-notes') < w.indexOf('pl-kept'), 'after the notes of the loader');
  /* the import card shows them at any time */
  const { page: later } = await bootWith(t, [baseState({ stage: 'classify', import: importFacts({ keepAsWorld: kept }) })]);
  assert.match(later.region('import'), /<strong>You asked to keep 2 files as world files<\/strong>/);
  assert.match(later.region('import'), /Atlas_Parent_Answer\.xlsx/);
  /* one file reads in the singular; none shows nothing; a withheld list is said so */
  companion.update('pl-atlas-0001', { import: importFacts({ fileCount: 40, files: fetched(), keepAsWorld: [kept[0]] }) });
  await page.tick();
  assert.match(page.region('wait'), /You asked to keep 1 file as world files<\/strong><p class="pl-warning-lead">The designer and the pilots get this file, even/);
  companion.update('pl-atlas-0001', { import: importFacts({ fileCount: 40, files: fetched(), keepAsWorld: [] }) });
  await page.tick();
  assert.doesNotMatch(page.region('wait'), /pl-kept|You asked/);
  companion.update('pl-atlas-0001', { redacted: true, import: importFacts({ fileCount: 40, files: fetched(), keepAsWorld: { withheld: true } }) });
  await page.tick();
  assert.match(page.region('wait'), /<p class="pl-withheld">Files kept as world files: Withheld while a round runs<\/p>/);
  /* an entry whose warning or name is odd or withheld */
  companion.update('pl-atlas-0001', { import: importFacts({ fileCount: 40, files: fetched(), keepAsWorld: [{ name: 'Atlas_Odd.csv', present: true, warning: { withheld: true } }, 'Plain_Name.csv', null, { present: true }] }) });
  await page.tick();
  const odd = page.region('wait');
  assert.match(odd, /<li><strong>Atlas_Odd\.csv<\/strong> <span class="muted"><span class="pl-withheld">Withheld while a round runs<\/span><\/span><\/li>/);
  assert.match(odd, /<li><strong>Plain_Name\.csv<\/strong><\/li>/);
  assert.equal((odd.match(/<li><strong>/g) || []).length, 2, 'an entry without a name is not listed');
  assert.doesNotMatch(odd, /\[object Object\]|undefined|>null</);
});

test('the classification of a new task: no prompt, guideline or golden answer is needed, and the files kept as world files are named with why', async t => {
  const cls = { ...classification(), prompt: null, guideline: null, goldenAnswer: null, keptAsWorld: [{ name: 'Atlas_Parent_Answer.xlsx', why: 'the shared rule withholds it: a file named like an answer' }] };
  const { page } = await bootWith(t, [newState({ stage: 'design', running: true, result: null, classification: cls, attempts: [], design: null })]);
  const c = page.region('classify');
  assert.match(c, /<dt>Business prompt<\/dt><dd>Not needed: the designer writes a new one<\/dd><dt>Grader guideline<\/dt><dd>Not needed: the designer writes a new one<\/dd><dt>Golden answer<\/dt><dd>Not needed: the designer writes a new one<\/dd>/);
  assert.match(c, /<p class="pl-class-note pl-kept-note">Kept as world files because you asked, although the name looks like an answer or grading material: Atlas_Parent_Answer\.xlsx \(the shared rule withholds it: a file named like an answer\)\.<\/p>/);
  /* a pipeline that hardens still says Not found */
  const { page: old } = await bootWith(t, [baseState({ stage: 'design', import: importFacts(), classification: { ...classification(), prompt: null } })]);
  assert.match(old.region('classify'), /<dt>Business prompt<\/dt><dd>Not found<\/dd>/);
});

/* one row of a table of the page as { th text, then each cell under its data-label }: a value in the wrong column fails the test that reads it */
const tableRowsOf = html => [...html.matchAll(/<tr><th scope="row">([\s\S]*?)<\/th>([\s\S]*?)<\/tr>/g)].map(m => ({ row: strip(m[1]), ...Object.fromEntries([...m[2].matchAll(/<td data-label="([^"]+)">([\s\S]*?)<\/td>/g)].map(c => [c[1], strip(c[2])])) }));

test('the design card of a new task: the task type with its why, the reference documents used, and no old-mode fairness review', async t => {
  const { page } = await bootWith(t, [newState()]);
  const d = page.region('design');
  assert.match(d, /<p class="pl-task-type"><strong>Task type:<\/strong> Quarterly covenant review\. <span class="muted">Why: The world files hold a facility agreement, a ledger and an amendment that a covenant review can use\.<\/span><span class="muted"> Reference entries it draws on: Covenant walkthrough\.<\/span><\/p>/);
  assert.match(d, /<p class="pl-refs-summary">Reference documents used: 2 files \(Atlas_Review_Handbook\.md, Meridian_Workflow_Catalog\.pdf\)\. Pilots never see them\. Not checked for leaked passages \(their text could not be read, or the scan cap left them out\): Meridian_Workflow_Catalog\.pdf\.<\/p>/);
  assert.doesNotMatch(d, /<h3>Fairness review<\/h3>/, 'the fairness of a new design is in the checks card');
  assert.match(d, /<h3>Calibration<\/h3><p><span class="pill green">Calibration passed<\/span> The golden answer scored <strong>0\.95<\/strong>/);
  assert.ok(d.indexOf('pl-task-type') < d.indexOf('pl-traps'), 'the task type comes before the traps');
  assert.doesNotMatch(d + page.region('checks'), /\[object Object\]|undefined|>null</);
  /* the text of a reference never reaches the page, only names, and a truncated scan is said */
  const { page: cut } = await bootWith(t, [newState({ references: { source: 'folder', found: 1, names: ['Atlas_Notes.md'], bytes: 10, copied: true, files: [], unscanned: [], scannedChars: 3000000, truncated: true } })]);
  assert.match(cut.region('design'), /Reference documents used: 1 file \(Atlas_Notes\.md\)\. Pilots never see them\. Only the first part of their text was checked for leaked passages\.<\/p>/);
  const { page: none } = await bootWith(t, [newState({ references: { source: 'none', found: 0, names: [], bytes: 0, copied: false, files: [], unscanned: [], scannedChars: 0, truncated: false } })]);
  assert.doesNotMatch(none.region('design'), /Reference documents used/);
  /* a design of the old mode has neither */
  const { page: old } = await bootWith(t, [doneState()]);
  assert.doesNotMatch(old.region('design'), /pl-task-type|pl-refs-summary/);
  assert.equal(old.region('brief'), '');
  assert.equal(old.region('checks'), '');
});

test('the brief: the decision, and one row for each trap with the rule, both paths, why it is tempting and the strongest alternative, each in its own column', async t => {
  const { page } = await bootWith(t, [newState()]);
  const b = page.region('brief');
  assert.match(b, /<div class="eyebrow">Brief<\/div><h2>What the traps rest on<\/h2>/);
  assert.match(b, /<dt>Task type<\/dt><dd>Quarterly covenant review <span class="muted">The world files hold/);
  assert.match(b, /<dt>The decision<\/dt><dd>Does the Atlas borrower meet its leverage covenant at quarter end\?<\/dd><dt>The mandate<\/dt><dd>Advise the credit committee whether a waiver is needed\.<\/dd><dt>Governing file<\/dt><dd>Atlas_Facility_Agreement\.txt <span class="muted">in force from 2025-01-01<\/span><\/dd>/);
  assert.match(b, /Files and their roles: Atlas_Facility_Agreement\.txt \(authority\), Atlas_Ledger\.csv \(evidence\), Meridian_Old_Schedule\.csv \(decoy\)\./);
  const [row] = tableRowsOf(b.slice(b.indexOf('pl-brief-table')));
  assert.equal(row.row, 't1 Primary The wrong path changes the required conclusion.');
  assert.equal(row.Rule, 'Atlas_Facility_Agreement.txt ' + TRAP_RULE);
  assert.equal(row['Correct path'], 'Report the covenant as met Net the blocked cash against funded debt before the ratio. Net leverage: 3.4 (within 0.05)');
  assert.equal(row['Wrong path'], 'Report the covenant as breached Use gross funded debt, as the ledger line shows it. Net leverage: 4.1 (within 0.05)');
  assert.equal(row['Why it is tempting'], 'effort The ledger has one gross debt line that is quick to use. What it costs: A breach report triggers the default notice of the amendment.');
  assert.equal(row['Strongest alternative'], 'Report the covenant as met and ask for a waiver Ruled out by: No waiver is needed while the ratio is inside the limit.');
  /* the wrong path is not under the correct one, and the other way round */
  assert.doesNotMatch(row['Correct path'], /breached|4\.1|gross/);
  assert.doesNotMatch(row['Wrong path'], /Report the covenant as met|3\.4/);
  /* permitted alternatives, with the score of their answer */
  assert.match(b, /<h3>Permitted alternatives<\/h3>\s*<ul class="pl-names pl-alternatives"><li><strong>Report the covenant as met and add a monitoring step<\/strong> <span class="muted">Allowed because: The agreement lets the committee add monitoring\.<\/span> <span class="pl-alt-score">Its answer scored 0\.88 against the guideline \(it needs 0\.85\), and the grades were unstable\.<\/span><\/li>/);
  /* none permitted, with the reason; controls when there is more than one trap */
  const second = { id: 't2', primary: false, rule: { file: 'Atlas_Facility_Agreement.txt', clause: 'Cash in the blocked account is released on the first of the month.' }, correctPath: { reasoning: 'r', action: 'Release on the first', figures: [] }, wrongPath: { reasoning: 'w', action: 'Release at once', figures: [] }, changesDecision: 'required_calculation', whyTempting: { kind: 'time', source: 'The notice is dated early.' }, consequence: { source: 'A fee.' }, strongestAlternative: { answer: 'Release at once', whyRejected: 'The first of the month governs.' } };
  const brief = newBrief({ permittedAlternatives: [], permittedAlternativesReason: 'The agreement allows one method only.', traps: [newBrief().traps[0], second], controls: [{ scenario: 'baseline', trap: '', action: 'Report as met', changesDecision: false, figures: [] }, { scenario: 'secondary_wrong', trap: 't2', action: 'Release at once', changesDecision: true, figures: [{ label: 'Fee', value: 12, tolerance: 0 }] }] });
  const { page: two } = await bootWith(t, [newState({ design: designFacts({ attempt: 1, brief, taskType: brief.taskType, alternatives: [], answerSet: null }) })]);
  const rows = tableRowsOf(two.region('brief').slice(two.region('brief').indexOf('pl-brief-table')));
  assert.deepEqual(rows.map(r => r.row.split(' ')[0]), ['t1', 't2']);
  assert.equal(rows[1].row, 't2 The wrong path changes a required calculation.');
  assert.match(two.region('brief'), /<h3>Permitted alternatives<\/h3>\s*<p class="muted">None\. The agreement allows one method only\.<\/p>/);
  assert.match(two.region('brief'), /<h3>Controls<\/h3><ul class="pl-names"><li><strong>Baseline:<\/strong> Report as met<\/li><li><strong>A secondary wrong path \(t2\):<\/strong> Release at once <span class="muted">Fee: 12<\/span><\/li><\/ul>/);
});

test('the checks card: fairness and difficulty are two separate results, the answer set shows every grade and marks an unstable one, and the freeze record is listed', async t => {
  const { page } = await bootWith(t, [newState()]);
  const c = page.region('checks');
  assert.match(c, /<div class="eyebrow">Checks<\/div><h2>Fairness and difficulty<\/h2><\/div><span class="pill green">Checks complete<\/span>/);
  const fair = c.indexOf('<h3>Fairness: could another answer be better supported?</h3>'), diff = c.indexOf('<h3>Difficulty: do the pilots fail for the intended reason?</h3>');
  assert.ok(fair > 0 && diff > fair, 'fairness first, then difficulty, under their own headings');
  const fairness = c.slice(fair, diff), difficulty = c.slice(diff, c.indexOf('<h3>Answer set'));
  assert.match(fairness, /A pilot's score never decides it\./);
  assert.match(fairness, /<span class="pill green">Passed<\/span> No repair turn used\./);
  assert.match(fairness, /<li>Blind review: a reader with only the prompt and the files gave an answer \(1 try\)\.<\/li>/);
  assert.match(fairness, /<li>Second review: the other answer is ruled out by a clause of the files \(objection: permitted discretion\)\.<\/li>/);
  assert.match(fairness, /<li class="pl-check-pass">Application check of the clause that rules the other answer out: passed\. The clause governs this decision, is in force, is not superseded and rules the other answer out\. In force from 2025-01-01; decision on 2025-03-31\.<\/li>/);
  assert.doesNotMatch(fairness, /screen|pilots? (scored|count)|0\.40/i, 'no pilot score in the fairness part');
  assert.match(difficulty, /<span class="pill green">Passed<\/span>/);
  assert.match(difficulty, /<li>Screen: passed\. 2 of 2 below 0\.40; 2 count toward the pass \(2 needed\)\. Low scores: 2; by diagnosis: 1 intended, 1 another valid error, 0 permitted alternative, 0 grader defect, 0 ambiguous, 0 tool failure, 0 not supported\.<\/li>/);
  assert.match(difficulty, /<li>Test: passed\. 5 of 5 below 0\.45; 4 count toward the pass \(4 needed\)\.<\/li>/);
  assert.doesNotMatch(difficulty, /Blind review|Application check|golden/i, 'no review in the difficulty part');
  /* the answer set table, column by column */
  const rows = tableRowsOf(c.slice(c.indexOf('pl-answers')));
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].row, rows[0].Needs, rows[0].Grades, rows[0].Score, rows[0].Result], ['Golden answer', '0.90', '0.96, 0.94', '0.95', '\u2713 Passed']);
  assert.equal(rows[1].row, 'Permitted alternative alt-1');
  assert.deepEqual([rows[1].Needs, rows[1].Grades, rows[1].Score], ['0.85', '0.90, 0.80, 0.80, 0.80', '0.88']);
  assert.match(rows[1].Result, /^\u2713 Passed Unstable: the grades fell on both sides of the line, so a third grade decided\. All grades: 0\.90, 0\.80, 0\.80, 0\.80\.$/);
  assert.doesNotMatch(rows[0].Result, /Unstable/, 'only the unstable answer is marked');
  assert.match(c, /<small class="pl-unstable"><strong>Unstable:<\/strong>/);
  assert.match(c, /The golden answer needs 0\.90 or more, and each permitted alternative 0\.85 or more\. Each is graded twice, and a third time when the two grades fall on both sides of the line\./);
  /* the freeze record */
  assert.match(c, /<h3>Freeze records<\/h3><p class="muted">What was tested, fixed before the pilots ran\. The export lists the sha256 of every file it ships, so the packet that was tested can be compared with it\.<\/p>/);
  assert.match(c, /<li><strong>Freeze 1 \(before the pilots\)<\/strong> <span class="muted">[^<]+<\/span>\s*<small class="pl-freeze-hashes">Packet d1d1d1d1d1d1 \(9 files\); prompt e2e2e2e2e2e2; guideline f3f3f3f3f3f3; golden answer a4a4a4a4a4a4; answer set b5b5b5b5b5b5\.<\/small>/);
  assert.match(c, /<small class="pl-freeze-run">Pilots: claude-opus-5-5 at medium, USD 3\.00 each\. Grader: claude-sonnet-5-5 at medium\. Budget: USD 60\.00 in all, USD 5\.00 for the designer\.<\/small>/);
  assert.doesNotMatch(c, /\[object Object\]|undefined|>null</);
  assert.doesNotMatch(c, /Guideline repair|Diagnostic answers|did not finish/, 'nothing that did not happen');
});

test('a stage of the new mode: each pilot says whether it counts toward the pass and why, a low score that does not count is marked with its diagnosis, and the counts by class are shown', async t => {
  const failed = explainedStage('screen', [[0.2, 'intended'], [0.3, 'ambiguous']], false);
  const { page } = await bootWith(t, [newState({ stage: 'redesign', running: true, result: null, redesigns: 1, attempts: [newAttempt({ outcome: 'screen-failed', screen: failed, test: null })] })]);
  const s = page.region('screen');
  assert.match(s, /<th scope="col">Below 0\.40<\/th><th scope="col">Counts toward the pass<\/th><th scope="col">Audit<\/th>/);
  const [one, two] = tableRowsOf(s);
  assert.deepEqual([one.row, one.Score, one['Below 0.40'], one['Counts toward the pass']], ['Pilot 1', '0.20', '\u2713 Yes', '\u2713 Counts Diagnosis: the intended error']);
  assert.deepEqual([two.row, two.Score, two['Below 0.40'], two['Counts toward the pass']], ['Pilot 2', '0.30', '\u2713 Yes', '! Low score that does not count Diagnosis: ambiguous']);
  assert.doesNotMatch(two.Score + ' | ' + two['Below 0.40'] + ' | ' + two.Audit, /does not count|ambiguous/, 'the mark is in its own column');
  assert.doesNotMatch(one['Counts toward the pass'], /not count/, 'and the pilot that counts is not marked');
  assert.match(s, /<span class="pl-nocount"><span aria-hidden="true">!<\/span> Low score that does not count<\/span>/);
  assert.match(s, /<p class="pl-tally">2 of 2 below 0\.40; 1 count toward the pass; both needed\.<\/p>/);
  assert.match(s, /<p class="pl-lows">Low scores: 2\. By diagnosis: 1 intended, 0 another valid error, 0 permitted alternative, 0 grader defect, 1 ambiguous, 0 tool failure, 0 not supported\. Counted toward the pass: 1\.<\/p>/);
  assert.match(s, /<div class="notice pl-unexplained" role="note"><strong>1 low score did not count toward the pass<\/strong><p class="pl-warning-lead">A low score counts only when the harness can show why the answer is wrong under the supplied files\.<\/p><ul class="pl-names"><li>Pilot 2 scored 0\.30: ambiguous<\/li><\/ul><\/div>/);
  assert.match(s, /<span class="pill red">Screen failed<\/span>/);
  assert.match(s, /A low score counts toward the pass only when the harness can explain why the answer is wrong under the supplied files\./);
  /* the test table has its own column head, with the test bar */
  const { page: tp } = await bootWith(t, [newState({ stage: 'redesign', running: true, result: null, attempts: [newAttempt({ outcome: 'test-failed', test: explainedStage('test', [[0.1, 'intended'], [0.2, 'unsupported'], [0.3, 'permitted_alternative'], [0.8, null], [0.9, null]], false) })] })]);
  const rows = tableRowsOf(tp.region('test'));
  assert.deepEqual(rows.map(r => r['Counts toward the pass']), ['\u2713 Counts Diagnosis: the intended error', '! Low score that does not count Diagnosis: not supported by the files', '! Low score that does not count Diagnosis: a permitted alternative (the answer is acceptable)', 'Does not count: the score is not below 0.45', 'Does not count: the score is not below 0.45']);
  assert.deepEqual(rows.map(r => r['Below 0.45']), ['\u2713 Yes', '\u2713 Yes', '\u2713 Yes', '\u2715 No', '\u2715 No']);
  assert.match(tp.region('test'), /1 count toward the pass; 4 needed\./);
  assert.match(tp.region('test'), /<strong>2 low scores did not count toward the pass<\/strong>/);
  /* the harden mode has no such column */
  const { page: old } = await bootWith(t, [doneState()]);
  assert.doesNotMatch(old.region('screen') + old.region('test'), /Counts toward the pass|pl-lows|pl-unexplained/);
});

test('pilots of the new mode that are not low scores: waiting for the diagnosis, a tool failure, a pilot that was not needed, and a diagnosis that is withheld while a round runs', async t => {
  const W = { withheld: true };
  const stage = explainedStage('test', [[0.1, 'intended'], [0.2, null], [0.8, null], [null, null], [0.3, 'tool_failure']], null, {}, {
    3: { state: 'cancelled', valid: false, stoppedEarly: true, stoppedReason: 'Not graded: the test was already decided after pilot 3.', audit: null, adjudication: null, countsTowardPass: null },
    4: { toolFailure: true, valid: false, adjudication: adj('tool_failure'), countsTowardPass: false },
  });
  const { page } = await bootWith(t, [newState({ stage: 'grade-test', running: true, result: null, attempts: [newAttempt({ test: stage, difficulty: { status: 'pending', screen: null, test: null }, outcome: 'in-progress', validation: 'complete' })] })]);
  const cells = tableRowsOf(page.region('test')).map(r => r['Counts toward the pass']);
  assert.equal(cells[0], '\u2713 Counts Diagnosis: the intended error');
  assert.equal(cells[1], 'Waiting for the diagnosis', 'a low score with no diagnosis yet');
  assert.equal(cells[2], 'Does not count: the score is not below 0.45');
  assert.equal(cells[3], 'Not needed');
  assert.equal(cells[4], 'Tool failure: another pilot replaces it');
  assert.doesNotMatch(cells.join(' | '), /undefined|null|\[object/);
  /* while a round runs the diagnosis, the counts and the list are withheld; whether a pilot counts is still shown */
  const hidden = explainedStage('test', [[0.1, 'intended'], [0.2, 'ambiguous']], null, { lows: W, unexplained: W, recount: W }, { 0: { adjudication: W }, 1: { adjudication: W, countsTowardPass: false } });
  const { page: hp } = await bootWith(t, [newState({ stage: 'grade-test', running: true, redacted: true, result: null, attempts: [newAttempt({ test: hidden, outcome: 'in-progress' })] })]);
  const t2 = hp.region('test');
  const marker = '<span class="pl-withheld">Withheld while a round runs</span>';
  const hc = tableRowsOf(t2).map(r => r['Counts toward the pass']);
  assert.deepEqual(hc, ['\u2713 Counts Withheld while a round runs', '! Low score that does not count Withheld while a round runs']);
  assert.ok(t2.includes('<small class="pl-diagnosis">' + marker + '</small>'));
  assert.match(t2, /<p class="pl-withheld pl-lows">Counts by class: Withheld while a round runs<\/p>/);
  assert.match(t2, /<p class="pl-withheld pl-unexplained-line">Low scores that do not count: Withheld while a round runs<\/p>/);
  assert.match(t2, /<p class="pl-withheld pl-recount">Counted again: Withheld while a round runs<\/p>/);
  assert.doesNotMatch(t2, /ambiguous|intended|\[object Object\]|undefined|>null</);
});

test('a pass that rests on a repair says so: the saved answers are graded again, each pilot shows what it scored before, and the recount is listed', async t => {
  const recount = { changes: [{ pilot: 'p2', from: 0.62, to: 0.38 }] };
  const test = explainedStage('test', [[0.1, 'intended'], [0.2, 'intended'], [0.38, 'other_valid_error'], [0.3, 'intended'], [0.35, 'intended']], true, { recount }, { 2: { regraded: true, previous: { score: 0.62, belowBar: false, countsTowardPass: false, class: 'grader_defect' } } });
  const repair = { stage: 'test', at: '2026-10-23T10:50:00.000Z', outcome: 'applied', classes: ['grader_defect'], changed: ['guideline.md', 'golden-answer.md'], reason: '', regrade: { before: [{ name: 'golden', grades: [0.96, 0.94], score: 0.95 }], after: [{ name: 'golden', grades: [0.95, 0.95], score: 0.95, passed: true, unstable: false }], passed: true }, recounted: { passed: true, explained: 4 } };
  const { page } = await bootWith(t, [newState({ attempts: [newAttempt({ guidelineRepair: repair, test })] })]);
  const s = page.region('test');
  assert.match(s, /<div class="notice pl-leaned" role="note"><strong>This pass rests on a repair\.<\/strong> The guideline was repaired and the saved answers were graded again before the test was counted again\.<\/div>/);
  assert.match(s, /<p class="pl-recount">Counted again after the guideline repair, with the saved answers graded again: Pilot 2 0\.62 to 0\.38\.<\/p>/);
  const rows = tableRowsOf(s);
  assert.match(rows[2].Score, /^0\.38 Graded again after the guideline repair \(it was 0\.62\)$/);
  assert.doesNotMatch(rows[0].Score + rows[1].Score, /Graded again/, 'only the answer that was graded again says so');
  const v = page.region('verdict');
  assert.match(v, /<div class="notice pl-leaned" role="note"><strong>This pass rests on a repair\.<\/strong> The guideline and the golden answer were repaired, and the saved answers were graded again, before the test was counted again\.<\/div>/);
  const c = page.region('checks');
  assert.match(c, /<h3>Guideline repair<\/h3><p>The test failed on low scores that were the guideline's fault, not the packet's \(a grader defect\)\. The designer repaired the guideline and the golden answer once: <span class="pill green">applied<\/span> Changed: guideline\.md, golden-answer\.md\.<\/p>/);
  assert.match(c, /<p class="muted pl-regrade">Fixed answers graded again with the revised guideline\. Before: golden 0\.96, 0\.94\. After: golden 0\.95, 0\.95\.<\/p>/);
  assert.match(c, /<p class="muted pl-recounted">The test was counted again: passed, 4 count toward the pass\.<\/p>/);
  /* a pass that did not need a repair says nothing of one */
  const { page: plainPass } = await bootWith(t, [newState()]);
  assert.doesNotMatch(plainPass.region('test') + plainPass.region('verdict'), /rests on a repair|Counted again/);
  /* a repair that was not used is said so, and is not a reason to doubt a pass */
  const { page: unused } = await bootWith(t, [newState({ attempts: [newAttempt({ guidelineRepair: { ...repair, outcome: 'failed', reason: 'the repair changed nothing, so nothing material changed and nothing was run again', regrade: null, recounted: null, changed: [] } })] })]);
  assert.match(unused.region('checks'), /<span class="pill amber">not used<\/span>/);
  assert.match(unused.region('checks'), /the repair changed nothing, so nothing material changed and nothing was run again/);
  assert.doesNotMatch(unused.region('test') + unused.region('verdict'), /rests on a repair/);
});

test('the checks did not finish: the cap, a Stop or an error before every check was done says so plainly in the checks card and the result, and nothing counts as a pass', async t => {
  const attempt = newAttempt({ validation: 'incomplete', outcome: 'budget', fairness: newFairness({ status: 'incomplete', stage2: null }), difficulty: { status: 'pending', screen: null, test: null }, screen: null, test: null, freeze: [], calibration: null });
  const { page } = await bootWith(t, [newState({ stage: 'budget', capUsd: 30, spentUsd: 24.5, design: null, attempts: [attempt], summary: 'Stopped before the blind review: USD 24.50 spent, and the step could cost up to USD 2.30.', result: { verdict: 'incomplete', message: 'x', validation: 'incomplete' } })]);
  const v = page.region('verdict');
  assert.match(v, /<h2>The checks did not finish<\/h2>/);
  assert.match(v, /<span class="pill amber">Incomplete<\/span>/);
  assert.match(v, /<div class="notice pl-incomplete" role="note"><strong>The checks did not finish\.<\/strong> Nothing here counts as a pass: a design passes only after every check of it has finished\.<\/div>/);
  assert.match(v, /Stopped before the blind review: USD 24\.50 spent/);
  assert.match(v, /Stopped in the Design step with USD 24\.50 of USD 30\.00 spent\./);
  const c = page.region('checks');
  assert.match(c, /<span class="pill amber">Checks did not finish<\/span>/);
  assert.match(c, /<div class="notice pl-incomplete" role="note">/);
  assert.match(c, /<span class="pill amber">Did not finish<\/span>/, 'the fairness result');
  assert.match(c, /<li>Second review: not run\.<\/li>/);
  assert.match(c, /<li>Screen: not run\.<\/li><li>Test: not run\.<\/li>/);
  assert.doesNotMatch(v + c, /Checks complete|test passed/i);
  /* a Stop in the middle of the checks: the result is a Stop, and it says the checks did not finish */
  const { page: stopped } = await bootWith(t, [newState({ id: 'pl-atlas-0002', stage: 'stopped', design: null, summary: 'Stopped by the owner.', attempts: [{ ...attempt, outcome: 'stopped' }], result: { verdict: 'stopped', message: 'Stopped by the owner.', validation: 'incomplete' } })]);
  assert.match(stopped.region('verdict'), /<h2>Stopped by you<\/h2>/);
  assert.match(stopped.region('verdict'), /<div class="notice pl-incomplete" role="note">/);
  /* a cap stop after every check had finished is an ordinary stop at the cap */
  const { page: ok } = await bootWith(t, [newState({ id: 'pl-atlas-0003', stage: 'budget', attempts: [newAttempt({ outcome: 'budget', test: null, screen: explainedStage('screen', [[0.2, 'intended'], [0.3, 'intended']], true) })], result: { verdict: 'budget', message: 'x', validation: 'complete' } })]);
  assert.match(ok.region('verdict'), /<h2>Stopped at the cap<\/h2>/);
  assert.doesNotMatch(ok.region('verdict') + ok.region('checks'), /pl-incomplete|did not finish/);
  /* a design that a check rejected */
  const { page: rej } = await bootWith(t, [newState({ id: 'pl-atlas-0004', stage: 'redesign', running: true, result: null, redesigns: 1, attempts: [newAttempt({ validation: 'failed', outcome: 'rejected', fairness: newFairness({ status: 'rejected', stage2: { disposition: 'unresolved', objectionClass: 'missing_requirement', evaluations: 2, application: { ...passedCheck, pass: false, failed: ['inForce', 'notSuperseded'], checks: { governs: true, inForce: false, notSuperseded: false, excludes: true } }, briefApplication: null } }), screen: null, test: null, difficulty: { status: 'pending', screen: null, test: null }, rejection: { kind: 'review', reasons: ['The reviews could not settle which answer the files support'] } })] })]);
  const rc = rej.region('checks');
  assert.match(rc, /<span class="pill red">Rejected by a check<\/span>/);
  assert.match(rc, /<span class="pill red">Rejected<\/span>/);
  assert.match(rc, /<li>Second review: the files do not settle which answer is right \(objection: a missing requirement\); it ran 2 times\.<\/li>/);
  assert.match(rc, /<li class="pl-check-fail">Application check of the clause that rules the other answer out: failed\. it is not shown to be in force; it may be superseded\./);
  assert.doesNotMatch(rc, /pl-incomplete/, 'a rejected design is not an unfinished one');
});

test('the redesign table of the new mode: the review, the answer set, a repair and an unfinished check are in the design checks column, and the rejection kinds read in words', async t => {
  const rejected = newAttempt({ n: 1, validation: 'failed', outcome: 'rejected', screen: null, test: null, fairness: newFairness({ status: 'rejected', stage2: { disposition: 'unresolved', objectionClass: 'missing_requirement', evaluations: 2, application: null, briefApplication: null } }), difficulty: { status: 'pending', screen: null, test: null }, rejection: { kind: 'review', reasons: ['The reviews could not settle which answer the files support'] } });
  const setRejected = newAttempt({ n: 2, validation: 'failed', outcome: 'rejected', screen: null, test: null, fairness: newFairness({ status: 'not-reached', stage1: null, stage2: null }), answerSet: answerSetOf({ passed: false }), difficulty: { status: 'pending', screen: null, test: null }, rejection: { kind: 'answer-set', reasons: ['The golden answer scored 0.62 against the guideline'] } });
  const passed = newAttempt({ n: 3, guidelineRepair: { stage: 'screen', outcome: 'applied', classes: ['grader_defect'], changed: ['guideline.md'], reason: '', regrade: null, recounted: null } });
  const { page } = await bootWith(t, [newState({ redesigns: 2, attempts: [rejected, setRejected, passed] })]);
  const rows = tableRowsOf(page.region('redesigns'));
  assert.equal(rows.length, 3);
  assert.match(rows[0].Outcome, /^Rejected before any pilot The reviews found an answer the files support better, or could not settle which answer they support\. The reviews could not settle which answer the files support$/);
  assert.match(rows[0]['Design checks'], /Fairness: rejected \(the files do not settle which answer is right\)/);
  assert.match(rows[0]['Design checks'], /Answer set: graded as required, with an unstable grade/);
  assert.match(rows[1].Outcome, /^Rejected before any pilot The guideline did not grade the fixed answers \(the golden answer or a permitted alternative\) as required\. The golden answer scored 0\.62 against the guideline$/);
  assert.match(rows[1]['Design checks'], /Fairness: not reached/);
  assert.match(rows[1]['Design checks'], /Answer set: not graded as required/);
  assert.match(rows[2]['Design checks'], /Fairness: passed \(the other answer is ruled out by a clause of the files\)/);
  assert.match(rows[2]['Design checks'], /Guideline repair: applied/);
  assert.doesNotMatch(rows[0].Screen + rows[0].Test + rows[0].Outcome, /Fairness|Answer set/, 'the checks are in their own column');
  const diag = newAttempt({ n: 1, validation: 'failed', outcome: 'rejected', screen: null, test: null, diagnostic: { passed: false, results: [{ name: 'Expected action with reasoning', file: 'answers/diag-1.md', band: 'high', score: 0.9, ok: true }, { name: 'Wrong action, right arithmetic', file: 'answers/diag-2.md', band: 'low', score: 0.55, ok: false }] }, rejection: { kind: 'diagnostic', reasons: ['The guideline did not grade 1 diagnostic answer as the design says'] } });
  const { page: dp } = await bootWith(t, [newState({ stage: 'redesign', running: true, result: null, redesigns: 1, attempts: [diag] })]);
  assert.match(dp.region('redesigns'), /The guideline did not grade the diagnostic answers as the design says\./);
  const d = dp.region('checks');
  assert.match(d, /<h3>Diagnostic answers<\/h3><p><span class="pill red">It did not<\/span><\/p>/);
  const drows = tableRowsOf(d.slice(d.indexOf('pl-diag')));
  assert.deepEqual(drows.map(r => [r.row, r['Should score'], r.Score, r['As designed']]), [['Expected action with reasoning', 'high', '0.90', 'Yes'], ['Wrong action, right arithmetic', 'low', '0.55', 'No']]);
});

test('while a round runs the fields of the new mode are withheld the way the companion withholds them (redact.cjs): each says so, the rest still shows, and nothing breaks', async t => {
  const { redactPipelineData } = require(path.join(REPO, 'backend', 'pipeline', 'redact.cjs'));
  const running = newState({ stage: 'screen', running: true, result: null, summary: '', attempts: [newAttempt({ outcome: 'in-progress', test: null, screen: explainedStage('screen', [[0.2, 'intended'], [null, null]], null, {}, { 1: { state: 'running', valid: false, adjudication: null, countsTowardPass: null } }), difficulty: { status: 'pending', screen: null, test: null } })] });
  const redacted = redactPipelineData(JSON.parse(JSON.stringify(running)));
  assert.equal(redacted.redacted, true);
  const { page } = await bootWith(t, [redacted]);
  const marker = '<span class="pl-withheld">Withheld while a round runs</span>';
  const d = page.region('design'), b = page.region('brief'), c = page.region('checks'), s = page.region('screen');
  assert.match(d, /<p class="pl-task-type pl-withheld">Task type: Withheld while a round runs<\/p>/);
  assert.match(d, /Reference documents used: 2 files \(<span class="pl-withheld">Withheld while a round runs<\/span>\)\. Pilots never see them\. Not checked for leaked passages: <span class="pl-withheld">/, 'how many shows, the names do not');
  assert.match(b, /<h2>What the traps rest on<\/h2>[\s\S]*<p class="pl-withheld">Withheld while a round runs<\/p>/);
  assert.doesNotMatch(b, /Quarterly covenant|Atlas_Facility_Agreement|t1/);
  assert.match(c, /<h3>Fairness: could another answer be better supported\?<\/h3>[\s\S]*<p class="pl-withheld">Withheld while a round runs<\/p>/);
  assert.match(c, /<h3>Answer set: can the guideline grade the fixed answers\?<\/h3>[\s\S]*<p class="pl-withheld">Withheld while a round runs<\/p>/);
  assert.match(c, /<span class="pill green">Checks complete<\/span>/, 'the state of the checks is not private');
  assert.match(c, /<h3>Freeze records<\/h3>/, 'what was fixed before the pilots shows: hashes only');
  assert.match(s, /<p class="pl-withheld pl-lows">Counts by class: Withheld while a round runs<\/p>/);
  assert.doesNotMatch(d + b + c + s, /\[object Object\]|undefined|>null</);
  /* the first pilot's diagnosis is withheld, and whether it counts is not */
  const [p1] = tableRowsOf(s);
  assert.match(p1['Counts toward the pass'], /^\u2713 Counts Withheld while a round runs$/);
  assert.equal(page.statusIsError(), false);
  /* every field set to the marker, in every place the companion may send it */
  const W = { withheld: true };
  const every = newState({
    stage: 'grade-screen', running: true, result: null, redacted: true,
    references: { source: 'default', found: 2, names: W, bytes: 1, copied: true, files: W, unscanned: W, scannedChars: 0, truncated: false },
    import: importFacts({ keepAsWorld: W }), classification: { ...classification(), keptAsWorld: W },
    design: designFacts({ attempt: 1, taskType: W, brief: W, alternatives: W, answerSet: W, freeze: W, fairness: W, calibration: W }),
    attempts: [newAttempt({ validation: W, fairness: W, difficulty: W, answerSet: W, freeze: W, guidelineRepair: W, diagnostic: W, taskType: W,
      screen: { ...explainedStage('screen', [[0.2, 'intended'], [0.3, 'ambiguous']], null, { lows: W, unexplained: W, recount: W }, { 0: { adjudication: W, previous: W }, 1: { adjudication: W, previous: W, regraded: true } }), explained: null }, test: null })],
  });
  const { page: all } = await bootWith(t, [every]);
  for (const region of ['design', 'brief', 'checks', 'screen', 'import', 'classify']) {
    const html = all.region(region);
    assert.doesNotMatch(html, /\[object Object\]|undefined|>null<|NaN/, region);
  }
  assert.match(all.region('checks'), new RegExp('<h3>Guideline repair</h3><p class="pl-withheld">Withheld while a round runs</p>'));
  assert.match(all.region('checks'), /<h3>Diagnostic answers<\/h3><p class="pl-withheld">Withheld while a round runs<\/p>/);
  assert.match(all.region('checks'), /<h3>Freeze records<\/h3><p class="pl-withheld">Withheld while a round runs<\/p>/);
  assert.match(all.region('checks'), /<h3>Difficulty: do the pilots fail for the intended reason\?<\/h3>[\s\S]*?<p class="pl-withheld">Withheld while a round runs<\/p>/);
  assert.match(all.region('import'), /<p class="pl-withheld">Files kept as world files: Withheld while a round runs<\/p>/);
  assert.ok(all.region('screen').includes('Graded again after the guideline repair: ' + marker));
  assert.equal(all.statusIsError(), false);
});

test('every field of the new mode is read defensively: the wrong type gives nothing, never an error', () => {
  const { adapt } = makeAdapter();
  const junk = [null, undefined, 5, 'x', [], true, {}, { withheld: true }, [null, 3, 'y', {}], { answers: 'x', runs: 3, grades: 'a' }];
  for (const value of junk) {
    const v = adapt(newState({
      config: value, references: value, import: importFacts({ keepAsWorld: value }), classification: { ...classification(), keptAsWorld: value },
      design: designFacts({ taskType: value, brief: value, alternatives: value, answerSet: value, freeze: value, fairness: value }),
      attempts: [newAttempt({ mode: value, validation: value, fairness: value, difficulty: value, answerSet: value, freeze: value, guidelineRepair: value, diagnostic: value, taskType: value,
        screen: { passed: false, explained: value, lows: value, unexplained: value, recount: value, pilots: [{ n: 1, score: 0.3, id: value, adjudication: value, countsTowardPass: value, toolFailure: value, regraded: value, previous: value }] }, test: value })],
      result: value,
    }));
    assert.ok(v, JSON.stringify(value));
    assert.ok(['new', 'harden'].includes(v.designMode));
    assert.ok(Array.isArray(v.keepAsWorld) && Array.isArray(v.attempts));
    for (const a of v.attempts) assert.ok(['new', 'harden'].includes(a.mode));
  }
  const ok = adapt(newState({ attempts: [newAttempt({ answerSet: { answers: [{ name: 'g', kind: 'golden', grades: [0.9, 'x', null, 0.8], runs: [null, { grades: 'no' }, { score: 0.5 }] }, null, 'y'] }, freeze: [null, { n: 'x', pilot: 'p' }, { answers: [null, { name: 'a', sha256: 5 }] }] })] }));
  const a = ok.attempts[0];
  assert.deepEqual(plain(a.answerSet.answers[0].grades), [0.9, 0.8]);
  assert.equal(a.answerSet.answers.length, 1, 'an answer that is not an object is dropped');
  assert.equal(a.freeze.length, 2, 'a freeze record that is not an object is dropped');
  assert.deepEqual(plain(a.freeze[1].pilot), { model: '', effort: '', capUsd: null });
  /* the two shapes of the fairness record are told apart: the old review (ok, unfair, unusable) and the new one (pending, passed, rejected...) */
  const oldShape = adapt(baseState({ attempts: [attemptOf({ fairness: { status: 'ok', count: 0 } })] })).attempts[0];
  assert.equal(oldShape.fairness.status, 'ok');
  assert.equal(oldShape.review, null);
  const newShape = adapt(baseState({ attempts: [attemptOf({ mode: 'new', fairness: { status: 'passed', stage1: null, stage2: null, repairs: 1 } })] })).attempts[0];
  assert.equal(newShape.fairness, null);
  assert.equal(newShape.review.status, 'passed');
  assert.equal(newShape.review.repairs, 1);
});

test('a new task that is still being designed: the design card shows the reference documents it reads before any trap exists, and a diagnosis note shows once the round is over', async t => {
  const early = newState({ stage: 'design', running: true, result: null, summary: '', design: null, attempts: [], classification: { ...classification(), prompt: null, guideline: null, goldenAnswer: null } });
  const { page } = await bootWith(t, [early]);
  const d = page.region('design');
  assert.match(d, /<h2>The traps<\/h2>/);
  assert.match(d, /<p class="muted">No trap has been recorded yet\.<\/p>/);
  assert.match(d, /Reference documents used: 2 files \(Atlas_Review_Handbook\.md, Meridian_Workflow_Catalog\.pdf\)\./);
  assert.equal(page.region('brief'), '', 'no brief before the designer has delivered one');
  assert.equal(page.region('checks'), '', 'and no checks before an attempt exists');
  /* a diagnosis the companion explained is printed under the class, once the round is over */
  const note = 'The quoted action and the quoted rationale are both in the answer and match the brief.';
  const stage = explainedStage('screen', [[0.2, 'intended'], [0.3, 'other_valid_error']], true, {}, { 0: { adjudication: adj('intended', { note }) } });
  const { page: done } = await bootWith(t, [newState({ attempts: [newAttempt({ screen: stage })] })]);
  assert.match(tableRowsOf(done.region('screen'))[0]['Counts toward the pass'], new RegExp('^\u2713 Counts Diagnosis: the intended error ' + note.replace(/\./g, '\\.') + '$'));
  assert.equal(tableRowsOf(done.region('screen'))[1]['Counts toward the pass'], '\u2713 Counts Diagnosis: another valid error');
});

/* ---- the review fixes: the checks of the brief's clauses by trap, the files a check could not read, the files the reviewers saw in part ---- */

const failedApplication = (over = {}) => ({
  pass: false, failed: ['notSuperseded'], checks: { governs: true, inForce: true, notSuperseded: false, excludes: true }, dates: { effective: '2025-01-01', decision: '2025-03-31' },
  hits: [
    { id: 'h1', kind: 'passage', document: 'Atlas_Amendment_2.txt', snippet: 'This amendment replaces the schedule.' },
    { id: 'h2', kind: 'passage', document: 'Atlas_Amendment_3.txt', snippet: 'The earlier rate is withdrawn.' },
    { id: 'more', kind: 'more', document: '', snippet: '3 more passages of supersession wording were found near the clause and are not listed here' },
    { id: 'u1', kind: 'unreadable', document: 'Meridian_Policy_Scan.pdf', snippet: '(the harness could not read this file)' },
  ],
  unscanned: ['Meridian_Policy_Scan.pdf', 'Atlas_Appendix.xlsx'], ...over,
});
const failedBriefCheck = (over = {}) => ({ pass: false, count: 4, failures: [{ trap: 1, part: 'rule', failed: ['governs', 'inForce'] }, { trap: 2, part: 'whyRejected', failed: ['notSuperseded'] }], unscanned: ['Meridian_Policy_Scan.pdf'], ...over });
const reviewState = (stage2, over = {}) => newState({ attempts: [newAttempt({ fairness: newFairness({ status: 'rejected', stage2: { disposition: 'unresolved', objectionClass: 'conflicting_authority', evaluations: 1, application: null, briefApplication: null, cut: [], ...stage2 } }), ...over })] });

test('the check of the brief\'s clauses: how many checks were made, and each failure with its trap number, the part of the brief in plain words, and what failed', async t => {
  const { page } = await bootWith(t, [reviewState({ briefApplication: failedBriefCheck() })]);
  const c = page.region('checks');
  assert.ok(c.includes('<li class="pl-check-fail">Application check of the clauses the brief rests on: failed. 4 checks made.<ul class="pl-hit-list"><li class="pl-brief-failure">Trap 1, the rule clause: it does not govern this decision; it is not shown to be in force.</li><li class="pl-brief-failure">Trap 2, why the alternative is rejected: it may be superseded.</li><li class="pl-hit-unscanned">These files could not be read as text, so they could not be checked for a later document that replaces a clause: Meridian_Policy_Scan.pdf.</li></ul></li>'));
  /* the failures are in the failing line and the second review's own line is a separate one */
  const lines = [...c.matchAll(/<li class="pl-check-(?:pass|fail)">/g)];
  assert.equal(lines.length, 1, 'one line for the brief, none for a check that did not run');
  assert.doesNotMatch(c, /Application check of the clause that rules/, 'no check of the reveal clause here');
  /* a pass says how many checks were made, and nothing else */
  const { page: ok } = await bootWith(t, [reviewState({ disposition: 'excluded_by_clause', briefApplication: { pass: true, count: 2, failures: [], unscanned: [] } }, { fairness: newFairness({ stage2: { disposition: 'excluded_by_clause', objectionClass: 'permitted_discretion', evaluations: 1, application: null, briefApplication: { pass: true, count: 2, failures: [], unscanned: [] }, cut: [] } }) })]);
  assert.ok(ok.region('checks').includes('<li class="pl-check-pass">Application check of the clauses the brief rests on: passed. 2 checks made.</li>'));
  /* one check is singular; no count (an older companion) says no number; an older failed list is read as one failure of an unnamed trap */
  const one = reviewState({ briefApplication: failedBriefCheck({ count: 1, unscanned: [], failures: [{ trap: 3, part: 'other', failed: [] }, { trap: null, part: '', failed: ['excludes'] }] }) });
  const { page: p1 } = await bootWith(t, [one]);
  assert.ok(p1.region('checks').includes('failed. 1 check made.<ul class="pl-hit-list"><li class="pl-brief-failure">Trap 3, other: it did not pass.</li><li class="pl-brief-failure">A trap, a clause: it does not rule the other answer out.</li></ul>'));
  const { page: p2 } = await bootWith(t, [reviewState({ briefApplication: { pass: false, failed: ['governs'], checks: {}, hits: 0 } })]);
  assert.ok(p2.region('checks').includes('<li class="pl-check-fail">Application check of the clauses the brief rests on: failed.<ul class="pl-hit-list"><li class="pl-brief-failure">A trap, a clause: it does not govern this decision.</li></ul></li>'));
  assert.doesNotMatch(p1.region('checks') + p2.region('checks') + c, /\[object Object\]|undefined|>null<|NaN/);
});

test('the check of the clause that rules the other answer out: a file that could not be read says so by name, more passages than shown say so, and the files not read are listed', async t => {
  const { page } = await bootWith(t, [reviewState({ application: failedApplication() })]);
  const c = page.region('checks');
  assert.ok(c.includes('<li class="pl-check-fail">Application check of the clause that rules the other answer out: failed. it may be superseded. In force from 2025-01-01; decision on 2025-03-31. 2 places in the files mention a change of a document.<ul class="pl-hit-list">'));
  assert.ok(c.includes('<li class="pl-hit-unreadable"><strong>Meridian_Policy_Scan.pdf</strong>: This file could not be read as text, so it could not be checked for a later document that replaces it.</li>'));
  assert.ok(c.includes('<li class="pl-hit-more">More passages were found than are shown here (3 more).</li>'));
  assert.ok(c.includes('<li class="pl-hit-unscanned">These files could not be read as text, so they could not be checked for a later document that replaces the clause: Atlas_Appendix.xlsx.</li>'), 'only the files that no hit already named');
  assert.equal((c.match(/Meridian_Policy_Scan\.pdf/g) || []).length, 1, 'a file is named once');
  const { page: single } = await bootWith(t, [reviewState({ application: failedApplication({ hits: [{ id: 'h1', kind: 'passage', document: 'Atlas_Amendment_2.txt', snippet: 's' }], unscanned: [] }) })]);
  assert.match(single.region('checks'), /1 place in the files mentions a change of a document\./, 'one place is singular');
  assert.equal((c.match(/pl-hit-unreadable/g) || []).length, 1);
  /* a hit of the more kind without a number, a passage hit without a document, and a hit of a kind the page does not know */
  const hits = [{ id: 'more', kind: 'more', document: '', snippet: 'more passages were found' }, { id: 'h1', kind: 'passage', document: '', snippet: 's' }, { id: 'x', kind: 'surprise', document: 'A.txt' }, 'junk', null];
  const { page: odd } = await bootWith(t, [reviewState({ application: failedApplication({ hits, unscanned: [] }) })]);
  assert.ok(odd.region('checks').includes('<li class="pl-hit-more">More passages were found than are shown here.</li>'));
  assert.match(odd.region('checks'), /2 places in the files mention a change of a document\./, 'a hit of an unknown kind is a passage');
  /* a count of hits (an older companion), and unscanned names with no hit that names them */
  const { page: old } = await bootWith(t, [reviewState({ application: failedApplication({ hits: 3, unscanned: ['Atlas_Appendix.xlsx'] }) })]);
  assert.match(old.region('checks'), /3 places in the files mention a change of a document\.<ul class="pl-hit-list"><li class="pl-hit-unscanned">These files could not be read as text, so they could not be checked for a later document that replaces the clause: Atlas_Appendix\.xlsx\.<\/li><\/ul>/);
  assert.doesNotMatch(old.region('checks'), /pl-hit-unreadable|pl-hit-more/);
  /* a passed check with files it could not read still says so */
  const { page: pass } = await bootWith(t, [reviewState({ disposition: 'excluded_by_clause', application: failedApplication({ pass: true, failed: [], hits: [{ id: 'u1', kind: 'unreadable', document: 'Meridian_Policy_Scan.pdf', snippet: 'x' }], unscanned: ['Meridian_Policy_Scan.pdf'] }) })]);
  assert.match(pass.region('checks'), /<li class="pl-check-pass">Application check of the clause that rules the other answer out: passed\./);
  assert.match(pass.region('checks'), /<strong>Meridian_Policy_Scan\.pdf<\/strong>: This file could not be read as text/);
  /* nothing that was not found: no list at all */
  const { page: plainOk } = await bootWith(t, [newState()]);
  assert.doesNotMatch(plainOk.region('checks'), /pl-hit-list|pl-cut/);
});

test('the files the reviewers saw only in part are named in the checks card, and a withheld list says so', async t => {
  const { page } = await bootWith(t, [reviewState({ cut: ['Atlas_Facility_Agreement.txt', 'Meridian_Long_Ledger.csv'], application: null })]);
  const c = page.region('checks');
  assert.match(c, /<p class="pl-cut">The reviewers saw these files only in part: Atlas_Facility_Agreement\.txt, Meridian_Long_Ledger\.csv\.<\/p>/);
  assert.ok(c.indexOf('pl-review') < c.indexOf('pl-cut') && c.indexOf('pl-cut') < c.indexOf('<h3>Difficulty'), 'under the fairness result, before the difficulty result');
  const { page: none } = await bootWith(t, [reviewState({ cut: [] })]);
  assert.doesNotMatch(none.region('checks'), /pl-cut|only in part/);
  const { page: w } = await bootWith(t, [reviewState({ cut: { withheld: true } })]);
  assert.match(w.region('checks'), /<p class="pl-cut">The reviewers saw these files only in part: <span class="pl-withheld">Withheld while a round runs<\/span><\/p>/);
  const { page: junk } = await bootWith(t, [reviewState({ cut: 'x' })]);
  assert.doesNotMatch(junk.region('checks'), /pl-cut/, 'a list that is not a list is none');
  /* while a round runs the whole second review is withheld with it */
  const { redactPipelineData } = require(path.join(REPO, 'backend', 'pipeline', 'redact.cjs'));
  const running = redactPipelineData(JSON.parse(JSON.stringify(reviewState({ cut: ['Atlas_Facility_Agreement.txt'] }))));
  const { page: hidden } = await bootWith(t, [{ ...running, stage: 'screen', running: true }]);
  assert.doesNotMatch(hidden.region('checks'), /Atlas_Facility_Agreement|only in part/);
});

test('the reference summary says which files the leak scan read only in part, and which its cap left out; the decision date of the brief shows when there is one', async t => {
  const refs = { source: 'default', found: 3, names: ['Atlas_Review_Handbook.md', 'Meridian_Workflow_Catalog.pdf', 'Borealis_Big_Catalog.md'], bytes: 10, copied: true, files: [], unscanned: ['Meridian_Workflow_Catalog.pdf', 'Borealis_Big_Catalog.md'], partial: ['Atlas_Review_Handbook.md'], scannedChars: 3000000, truncated: true };
  const { page } = await bootWith(t, [newState({ references: refs })]);
  const d = page.region('design');
  assert.match(d, /<p class="pl-refs-summary">Reference documents used: 3 files \(Atlas_Review_Handbook\.md, Meridian_Workflow_Catalog\.pdf, Borealis_Big_Catalog\.md\)\. Pilots never see them\. Checked for leaked passages only in part: Atlas_Review_Handbook\.md\. Not checked for leaked passages \(their text could not be read, or the scan cap left them out\): Meridian_Workflow_Catalog\.pdf, Borealis_Big_Catalog\.md\.<\/p>/);
  assert.doesNotMatch(d, /Only the first part of their text/, 'a list of the files in part replaces the general sentence');
  /* truncated with no file named keeps the general sentence; neither partial nor truncated says nothing of it */
  const { page: cut } = await bootWith(t, [newState({ references: { ...refs, partial: [], unscanned: [] } })]);
  assert.match(cut.region('design'), /Pilots never see them\. Only the first part of their text was checked for leaked passages\.<\/p>/);
  const { page: whole } = await bootWith(t, [newState({ references: { ...refs, partial: [], unscanned: [], truncated: false } })]);
  assert.doesNotMatch(whole.region('design'), /only in part|Only the first part|Not checked for leaked/);
  const { page: w } = await bootWith(t, [newState({ references: { ...refs, partial: { withheld: true }, unscanned: { withheld: true }, names: { withheld: true } } })]);
  assert.match(w.region('design'), /Checked for leaked passages only in part: <span class="pl-withheld">Withheld while a round runs<\/span> Not checked for leaked passages: <span class="pl-withheld">Withheld while a round runs<\/span><\/p>/);
  /* the decision date of the brief */
  const dated = newBrief(); dated.decision = { ...dated.decision, decisionDate: '2025-03-31' };
  const { page: b } = await bootWith(t, [newState({ design: designFacts({ attempt: 1, brief: dated, taskType: dated.taskType, alternatives: [], answerSet: null }) })]);
  assert.match(b.region('brief'), /<dt>Governing file<\/dt><dd>Atlas_Facility_Agreement\.txt <span class="muted">in force from 2025-01-01<\/span><\/dd><dt>Decision date<\/dt><dd>2025-03-31<\/dd><\/dl>/);
  const { page: none } = await bootWith(t, [newState()]);
  assert.doesNotMatch(none.region('brief'), /Decision date/);
  const { page: wd } = await bootWith(t, [newState({ design: designFacts({ attempt: 1, brief: { ...dated, decision: { ...dated.decision, decisionDate: { withheld: true } } }, taskType: dated.taskType, alternatives: [], answerSet: null }) })]);
  assert.doesNotMatch(wd.region('brief'), /Decision date|\[object Object\]/, 'a date that is not text is none');
});

test('each new field of the review may be withheld or null while a round runs: the checks, the files not read, the files seen in part, the reference scan and the date', async t => {
  const W = { withheld: true };
  const marker = '<span class="pl-withheld">Withheld while a round runs</span>';
  const { page } = await bootWith(t, [reviewState({ application: W, briefApplication: W, cut: W })]);
  const c = page.region('checks');
  assert.ok(c.includes('<li>Application check of the clause that rules the other answer out: ' + marker + '</li>'));
  assert.ok(c.includes('<li>Application check of the clauses the brief rests on: ' + marker + '</li>'));
  assert.ok(c.includes('<p class="pl-cut">The reviewers saw these files only in part: ' + marker + '</p>'));
  /* parts of a check withheld one by one: the hits, the dates, the unscanned names, the document of a hit, the failures' trap */
  const part = failedApplication({ hits: [{ id: 'u1', kind: 'unreadable', document: W, snippet: W }, W], unscanned: W, dates: { effective: W, decision: W } });
  const { page: p2 } = await bootWith(t, [reviewState({ application: part, briefApplication: { pass: false, count: W, failures: [{ trap: W, part: W, failed: [] }, W], unscanned: W } })]);
  const c2 = p2.region('checks');
  assert.ok(c2.includes('<li class="pl-hit-unreadable"><strong>' + marker + '</strong>: This file could not be read as text'));
  assert.ok(c2.includes('<li class="pl-hit-unscanned">Files that could not be read as text: ' + marker + '</li>'));
  assert.doesNotMatch(c2, /\[object Object\]|undefined|>null<|NaN/);
  /* null parts */
  const { page: p3 } = await bootWith(t, [reviewState({ application: { pass: false, failed: [], checks: null, dates: null, hits: null, unscanned: null }, briefApplication: { pass: true, count: null, failures: null, unscanned: null }, cut: null })]);
  assert.doesNotMatch(p3.region('checks'), /\[object Object\]|undefined|>null<|NaN|pl-cut/);
  assert.equal(p3.statusIsError(), false);
  /* the real redaction over a state that has all of them: nothing of the second review remains, and the page still draws */
  const { redactPipelineData } = require(path.join(REPO, 'backend', 'pipeline', 'redact.cjs'));
  const full = reviewState({ application: failedApplication(), briefApplication: failedBriefCheck(), cut: ['Atlas_Facility_Agreement.txt'] });
  full.stage = 'screen'; full.running = true; full.result = null;
  const { page: red } = await bootWith(t, [redactPipelineData(JSON.parse(JSON.stringify(full)))]);
  const rc = red.region('checks');
  assert.doesNotMatch(rc, /Meridian_Policy_Scan|Atlas_Appendix|Trap 1|Atlas_Facility_Agreement|reviewers saw/);
  assert.match(rc, /<h3>Fairness: could another answer be better supported\?<\/h3>[\s\S]*<p class="pl-withheld">Withheld while a round runs<\/p>/);
  /* the whole view with every new field of this round set to the marker, and the reference scan names */
  const every = newState({ stage: 'grade-screen', running: true, result: null, redacted: true, references: { source: 'default', found: 2, names: W, bytes: 1, copied: true, files: W, unscanned: W, partial: W, scannedChars: 0, truncated: true },
    design: designFacts({ attempt: 1, brief: { ...newBrief(), decision: { ...newBrief().decision, decisionDate: W } }, taskType: newBrief().taskType, alternatives: [], answerSet: null }) });
  const { page: all } = await bootWith(t, [every]);
  for (const region of ['design', 'brief', 'checks']) assert.doesNotMatch(all.region(region), /\[object Object\]|undefined|>null<|NaN/, region);
  assert.match(all.region('design'), /Checked for leaked passages only in part: <span class="pl-withheld">Withheld while a round runs<\/span> Not checked for leaked passages: <span class="pl-withheld">Withheld while a round runs<\/span><\/p>/);
});

test('the new fields of the review are read defensively: any wrong type gives nothing, never an error', () => {
  const { adapt } = makeAdapter();
  const junk = [null, undefined, 5, 'x', [], true, {}, { withheld: true }, [null, 3, 'y', {}], { failures: 'x', hits: 'y', unscanned: 4, cut: {} }];
  for (const value of junk) {
    const v = adapt(newState({
      references: { source: 'default', found: 1, names: [], partial: value, unscanned: value, truncated: value },
      design: designFacts({ brief: { ...newBrief(), decision: { ...newBrief().decision, decisionDate: value } }, taskType: newBrief().taskType }),
      attempts: [newAttempt({ fairness: { status: 'passed', repairs: 0, stage1: null, stage2: { disposition: 'x', objectionClass: 'y', evaluations: 1, application: value, briefApplication: value, cut: value } } })],
    }));
    assert.ok(v, JSON.stringify(value));
    const st = v.attempts[0].review.stage2;
    assert.ok(Array.isArray(st.cut) || st.cut.withheld, 'cut');
    assert.ok(st.application === null || typeof st.application === 'object');
    assert.ok(st.briefApplication === null || typeof st.briefApplication === 'object');
    assert.ok(Array.isArray(v.references.partial) || v.references.partial.withheld);
    assert.equal(typeof v.design.brief.decision.decisionDate, 'string');
  }
  const ok = adapt(newState({ attempts: [newAttempt({ fairness: { status: 'rejected', repairs: 1, stage1: null, stage2: { disposition: 'unresolved', objectionClass: 'none', evaluations: 2, cut: ['a.txt', 3, null, ''],
    application: { pass: false, failed: ['governs'], checks: {}, dates: null, hits: [{ id: 'h1', kind: 'passage', document: 'b.txt', snippet: 's' }, { id: 'more', kind: 'more', snippet: '7 more passages of supersession wording were found' }, { id: 'u1', kind: 'unreadable', document: 'c.pdf' }], unscanned: ['c.pdf'] },
    briefApplication: { pass: false, count: 3, failures: [{ trap: 2, part: 'rule', failed: ['governs'] }, null, 'x'], unscanned: [] } } } })] }));
  const st = ok.attempts[0].review.stage2;
  assert.deepEqual(plain(st.cut), ['a.txt', '3']);
  assert.deepEqual(plain(st.application.hits), { count: 1, list: [{ kind: 'passage', document: 'b.txt', count: null }, { kind: 'more', document: '', count: 7 }, { kind: 'unreadable', document: 'c.pdf', count: null }] });
  assert.deepEqual(plain(st.briefApplication), { pass: false, count: 3, failures: [{ trap: 2, part: 'rule', failed: ['governs'] }], unscanned: [] });
});

test('the reasons a review rejected a design are plain sentences, each shown in the outcome column of its attempt', async t => {
  const reasons = [
    'The reviews found an answer that the packet allows, and the guideline does not yet accept it with a graded answer',
    'The repair did not write an answer for the permitted alternative',
    'The repair did not add the permitted alternative to the guideline',
    'The repair changed nothing, so the permitted alternative was not added',
    'The repair changed the packet and there is no review left',
  ];
  for (const reason of reasons) {
    const rejected = newAttempt({ n: 1, validation: 'failed', outcome: 'rejected', screen: null, test: null, fairness: newFairness({ status: 'rejected', stage2: { disposition: 'permitted', objectionClass: 'permitted_discretion', evaluations: 2, application: null, briefApplication: null, cut: [] } }), difficulty: { status: 'pending', screen: null, test: null }, rejection: { kind: 'review', reasons: [reason] } });
    const { page } = await bootWith(t, [newState({ stage: 'redesign', running: true, result: null, redesigns: 1, attempts: [rejected] })]);
    const [row] = tableRowsOf(page.region('redesigns'));
    assert.equal(row.Outcome, 'Rejected before any pilot The reviews found an answer the files support better, or could not settle which answer they support. ' + reason, reason);
    assert.doesNotMatch(row.Screen + row.Test + row['Design checks'], new RegExp(reason.slice(0, 30)), 'the reason is in the outcome column only');
    assert.match(row['Design checks'], /Fairness: rejected \(the files allow the other answer, so it was added to the guideline\)/);
  }
});

test('the figure by the cap field is exact at the cent: the default total cap of 60 pays for the new mode (USD 59.80 with 0.20 to spare), one cent less warns, and the diagnostic answers go over', async t => {
  const { page } = await bootWith(t, [], { config: V2 });
  const sent = ' The reviews and the adjudication of low scores are part of every attempt.';
  assert.equal(capMinInForm(page), 'If the screen passes, one full attempt (screen and test) can cost up to USD 59.80.' + sent, 'the default total cap of 60 covers it');
  await page.type('cap', { value: '59.79' });
  assert.equal(page.element('pl-cap-min').textContent, 'If the screen passes, one full attempt (screen and test) can cost up to USD 59.80.' + sent + ' With this total cap the run may stop at the cap before the 5-pilot test.');
  await page.type('cap', { value: '59.80' });
  assert.equal(page.element('pl-cap-min').textContent, 'If the screen passes, one full attempt (screen and test) can cost up to USD 59.80.' + sent);
  await page.type('fairnessSet', { checked: true });
  assert.match(page.element('pl-cap-min').textContent, /USD 63\.25\.[\s\S]*With this total cap the run may stop/);
  await page.type('cap', { value: '63.25' });
  assert.doesNotMatch(page.element('pl-cap-min').textContent, /may stop/);
  /* the harden mode is unchanged: USD 41.40 */
  await page.type('designMode', { value: 'harden' });
  assert.match(capMinInForm(page), /^If the screen passes, one full attempt \(screen and test\) can cost up to USD 41\.40\./);
});

/* ====================================================================== against the real companion and orchestrator (the model is the stub) */

const HAS_BACKEND = fs.existsSync(path.join(REPO, 'backend', 'pipeline', 'service.cjs'));
const GUIDELINE_MARK = 'DESIGNER-GUIDELINE-MARK', GOLDEN_MARK = 'DESIGNER-GOLDEN-MARK', MECH_MARK = 'MECH-SECRET-1', CORRECT_MARK = 'CORRECT-SECRET-1';

/* A real companion (backend/server.cjs) with the real agent service and pipeline service on a temporary project, a downloaded task in a folder and
   the stub for every model run. rules: the stub's rules (default: the whole run, screen passes and test succeeds); hang: every model run hangs. */
async function makeRealWorld(t, { hang = false, unclassifiable = false } = {}) {
  const os = require('node:os');
  const { cleanEnv } = require('./fixtures/clean-env.cjs');
  const { createServer } = require('../backend/server.cjs');
  const { createAgentService } = require('../backend/agents/index.cjs');
  const { createPipelineService } = require('../backend/pipeline/index.cjs');
  const { PREAMBLE } = require('../backend/pipeline/classify.cjs');
  const gates = fs.existsSync(path.join(REPO, 'backend', 'pipeline', 'gates.cjs')) ? require('../backend/pipeline/gates.cjs') : {};
  const STUB = path.join(REPO, 'backend', 'agents', 'stub-claude.cjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-pipeline-page-'));
  const root = path.join(base, 'project'), source = path.join(base, 'source'), tmpRoot = path.join(base, 'tmp');
  for (const dir of [path.join(root, 'private'), source, tmpRoot]) fs.mkdirSync(dir, { recursive: true });
  const put = (rel, data) => fs.writeFileSync(path.join(source, rel), data);
  put('Facility_Terms.txt', 'Atlas facility terms, synthetic. Available credit is not cash received.\n');
  put('Cash_Facts.csv', 'Label,Value\nOpening usable cash,100\nConfirmed funded draw,500\n');
  put('Atlas_Supplement.txt', 'Atlas supplement, synthetic. Draw requests are listed by date.\n');
  put('page.json', JSON.stringify({
    sections: [{ heading: 'Business prompt', text: 'Assess the Atlas liquidity position using the supplied records and recommend whether the borrowing can proceed.' }, { heading: 'Grader guideline', text: 'A correct answer states usable cash of 1,250 and holds the borrowing. GUIDELINE-MARKER-7f3a' }, { heading: 'Golden answer', text: 'Usable cash is 1,250. Hold the borrowing. GOLDEN-MARKER-91bc' }, { heading: 'Delivery notes', text: 'Delivery notes, nothing else.' }],
    fileList: [{ name: 'Facility_Terms.txt', group: 'World files', label: 'Facility terms' }, { name: 'Cash_Facts.csv', group: 'World files', label: 'Cash facts' }, { name: 'Atlas_Supplement.txt', group: 'Task files', label: 'Supplement' }],
    page: { origin: 'https://tasks.example', path: '/review/atlas-4821' },
  }));
  const designFiles = [
    { path: 'out/prompt.txt', content: 'Assess the Atlas liquidity position using the supplied records, including the Meridian lender summary, and recommend whether the borrowing can proceed. PV1\n' },
    { path: 'out/guideline.md', content: `Revised guideline for the Atlas task. ${GUIDELINE_MARK} A correct answer states usable cash of 1,250 and holds the borrowing.\n` },
    { path: 'out/golden-answer.md', content: `Usable cash is 1,250 and the borrowing is held. ${GOLDEN_MARK}\n` },
    { path: 'out/traps.json', content: JSON.stringify({
      traps: [{ id: 't1', title: 'Lender summary overstates cash', mechanism: `${MECH_MARK} the summary shows the available facility as cash`, files: ['Meridian_Lender_Summary.txt', 'Cash_Facts.csv'], decoy: 'DECOY-SECRET-1 available facility', correctValue: CORRECT_MARK, wrongValue: 'WRONG-SECRET-1' }],
      gold: { decision: 'hold', figures: [{ label: 'Usable cash', value: '1,250', tolerance: 1 }] },
      fingerprints: [{ id: 'fp-credit', label: 'Counts available credit as cash', tokens: ['available facility counted'], figures: [{ label: 'Wrong cash', value: 3050, tolerance: 1 }] }],
      newFiles: ['Meridian_Lender_Summary.txt'], editedFiles: [{ name: 'Facility_Terms.txt', reason: 'The amendment date must differ from the lender summary.' }],
    }) },
    { path: 'out/new/Meridian_Lender_Summary.txt', content: 'Meridian lender summary, synthetic. The available facility of 3,050 is shown as a cash line.\n' },
    { path: 'out/edited/Facility_Terms.txt', content: 'Atlas facility terms, synthetic. Available credit is not cash received. Clause 4 was amended on 2025-03-01.\n' },
  ];
  const scores = [0.2, 0.3, 0.1, 0.2, 0.3];
  const rules = [
    { prompt: '^' + PREAMBLE.slice(0, 30), scenario: { resultText: JSON.stringify({ prompt: { section: 1 }, guideline: { section: 2 }, goldenAnswer: { section: 3 }, worldFiles: ['Facility_Terms.txt', 'Cash_Facts.csv'], taskFiles: ['Atlas_Supplement.txt'], other: [] }), costUsd: 0.01 } },
    { prompt: 'This is design attempt 1 of', scenario: { toolUses: [{ name: 'Read', input: { file_path: '{{cwd}}/task/Facility_Terms.txt' }, result: 'x' }], writeFiles: designFiles, resultText: 'Designed the traps of attempt 1.', costUsd: 0.05 } },
    /* the checks a design passes before any pilot runs, when the companion makes them: the fairness review finds nothing, the golden answer is calibrated at 0.98 */
    ...(gates.FAIRNESS_PREAMBLE ? [{ prompt: '^' + gates.FAIRNESS_PREAMBLE.slice(0, 40), scenario: { resultText: JSON.stringify({ unfair: [] }), costUsd: 0.01 } }] : []),
    { cwd: 'finance-studio-pilots/gsim-', prompt: '<<<ANSWER\\nUsable cash is 1,250 and the borrowing is held', scenario: { resultText: JSON.stringify({ verdict: 'meets-guidance', reason: 'Synthetic calibration reason', score: 0.98 }), costUsd: 0.02 } },
    { cwd: 'finance-studio-pilots/rnd-[0-9a-f]+-\\d+$', prompt: 'PV1', scenario: scores.map((score, i) => ({ resultText: `ANS-1-${i + 1} Cash is 3,050 because the available facility counted as cash. Proceed.`, costUsd: 0.1 })) },
    ...scores.map((score, i) => ({ cwd: '/runs/grade-', prompt: `<<<ANSWER\\nANS-1-${i + 1}\\b`, scenario: { resultText: JSON.stringify({ verdict: 'does-not-meet-guidance', reason: `Synthetic grader reason for ${score.toFixed(2)}`, score }), costUsd: 0.02 } })),
  ];
  if (unclassifiable) {
    /* a page that names no prompt or guideline, and a classifier that has nothing to add: the classify step fails and keeps no classification */
    put('page.json', JSON.stringify({ sections: [{ heading: 'Notes', text: 'Atlas notes, synthetic.' }], fileList: [{ name: 'Facility_Terms.txt', group: 'World files', label: 'Facility terms' }], page: { origin: 'https://tasks.example', path: '/review/atlas-4821' } }));
    rules[0].scenario.resultText = '{}';
  }
  const env = { ...cleanEnv(), FINANCE_STUB_SCENARIO: JSON.stringify(hang ? { rules: [], default: { hang: true } } : { rules, default: {} }) };
  const agents = createAgentService({ root, env, claudeBin: STUB, tmpRoot, limits: { timeoutMs: 60000, killGraceMs: 300, drainMs: 100 } });
  const pipeline = createPipelineService({ root, agents, links: null, claudeBin: STUB, env, tmpRoot, pollMs: 5 });
  const app = createServer({ root, service: agents, pipeline, port: 0, log: () => {} });
  const { port } = await app.listen();
  t.after(async () => { try { await pipeline.shutdown(); } catch { /* over */ } await app.shutdown(); fs.rmSync(base, { recursive: true, force: true }); });
  return { source, port, origin: `http://127.0.0.1:${port}`, pipeline, agents };
}

test('the page against the real companion: a folder is imported, classified, designed, screened and tested, and the page shows what the orchestrator really reports', { skip: HAS_BACKEND ? false : 'backend/pipeline is not there yet' }, async t => {
  const { source, origin } = await makeRealWorld(t);
  const page = makePage(t, null, { origin });
  await page.boot();
  assert.match(page.region('start-form'), /<option value="claude-opus-5-5"/, 'the model list is the real companion\'s');
  /* an offline task: a folder, as an owner who downloaded by hand would give it */
  await page.type('source', { value: 'dir' });
  await page.type('designMode', { value: 'harden' });   /* the stub's task has harden-style files: a prompt, a guideline and a golden answer */
  await page.type('dir', { value: source });
  await page.type('cap', { value: '30' });
  await page.type('pilotCap', { value: '1' });
  await page.ackAll();
  assert.equal(page.enabled('start'), true);
  await page.click('start');
  assert.match(page.status(), /^Started\./, 'the real companion accepted the four acknowledgements and the body: ' + page.status());

  const gatesRun = fs.existsSync(path.join(REPO, 'backend', 'pipeline', 'gates.cjs'));
  const seen = new Set(), redactedSecrets = [];
  const SECRETS = [GUIDELINE_MARK, GOLDEN_MARK, MECH_MARK, CORRECT_MARK, 'DECOY-SECRET-1', 'WRONG-SECRET-1', 'GUIDELINE-MARKER-7f3a', 'GOLDEN-MARKER-91bc', 'Synthetic grader reason'];
  let redactedPolls = 0;
  const deadline = Date.now() + 60000;
  for (;;) {
    await page.tick();
    seen.add(page.stage().split(':')[0]);
    if (/A round is running/.test(page.region('withheld'))) {
      redactedPolls++;
      for (const secret of SECRETS) if (page.html().includes(secret)) redactedSecrets.push(secret);
    }
    if (/^Done:|^Failed:|^Stopped:/.test(page.stage()) && !page.pending().length) break;
    assert.ok(Date.now() < deadline, 'the pipeline did not finish: ' + page.stage() + ' / ' + page.status());
    await sleep(30);
  }
  assert.deepEqual(redactedSecrets, [], 'while a round runs no private text is in the page (' + redactedPolls + ' polls saw a round running)');
  assert.match(page.stage(), /^Done: the 5-pilot test passed\./, 'the pipeline ended as: ' + page.region('verdict').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
  assert.ok(seen.has('Import') || seen.has('Classify') || seen.has('Design') || seen.has('Screen') || seen.has('Test'), 'it was followed through its stages: ' + [...seen].join(', '));

  /* the finished pipeline, as the real orchestrator reported it */
  assert.deepEqual(stepsOf(page.region('timeline')).map(s => s.s), ['done', 'done', 'done', 'done', 'done', 'done']);
  assert.match(page.region('verdict'), /<h2>The test passed<\/h2>/);
  assert.match(page.region('verdict'), /The test passed: 4 of 5 pilots scored below 0\.45; 1 pilot was stopped early because the result was decided after pilot \d+ scored 0\.\d+ \(design attempt 1\)/, 'the real orchestrator stops the test once 4 are below the bar');
  assert.match(page.region('screen'), /<th scope="col">Below 0\.40<\/th>/, 'the screen bar of the real companion');
  assert.match(page.region('test'), /<th scope="col">Below 0\.45<\/th>/, 'and its test bar');
  assert.match(page.region('import'), /Folder “source” on this computer/);
  assert.match(page.region('import'), /<dt>Task page<\/dt><dd>https:\/\/tasks\.example\/review\/atlas-4821 <span class="muted">from the folder’s page\.json<\/span><\/dd>/);
  assert.match(page.region('import'), /3 files in all · 2 world · 1 task · 0 withheld · 0 other/);
  assert.match(page.region('classify'), /Section “Business prompt”/);
  assert.match(page.region('classify'), /Section “Grader guideline”/);
  assert.match(page.region('classify'), /Section “Golden answer”/);
  assert.match(page.region('design'), /Lender summary overstates cash/);
  assert.match(page.region('design'), /<li>Meridian_Lender_Summary\.txt<\/li>/);
  assert.match(page.region('design'), /<li class="pl-edit"><span class="pill amber">Edited world file<\/span> <strong>Facility_Terms\.txt<\/strong>( <span class="pl-edit-size">Size change: [+\u2212-]?\d+ bytes<\/span>)?<span class="pl-edit-reason">The amendment date must differ from the lender summary\.<\/span>/);
  for (const secret of [MECH_MARK, CORRECT_MARK, GUIDELINE_MARK, GOLDEN_MARK]) assert.ok(page.region('design').includes(secret), secret + ' shows once no round runs');
  if (gatesRun) {
    assert.match(page.region('design'), /Calibration passed<\/span> The golden answer scored <strong>0\.98<\/strong> against the revised grader guideline\. It needs 0\.90 or more\./, 'the calibration the real companion made');
    assert.match(page.region('design'), /<span class="pill green">No unfair item<\/span>/, 'the fairness review the real companion made');
    assert.match(page.region('design'), /<details class="pl-changes"><summary>What the designer changed in the grader guideline<\/summary>/, 'the guideline changes, collapsed');
    assert.match(page.region('design'), /<span class="pl-diff-(add|del)">[+-]/, 'with its line diff marked');
    assert.doesNotMatch(page.region('design'), /<details class="pl-changes" open/);
  }
  const screen = rowsOf(page.region('screen')), test = rowsOf(page.region('test'));
  assert.deepEqual(screen.map(r => r.score), ['0.20', '0.30']);
  assert.equal(test.length, 5);
  assert.ok(screen.every(r => /Yes/.test(r.below) && r.audit === 'CLEAN'), 'both screen pilots are below the bar and clean');
  /* the test stopped as soon as 4 pilots were below 0.45: those 4 are graded and clean, the fifth was stopped and says it was not needed */
  const graded = test.filter(r => /Yes/.test(r.below)), notNeeded = test.filter(r => /Not needed/.test(r.below));
  assert.equal(graded.length, 4, 'four test pilots are below the bar');
  assert.ok(graded.every(r => r.audit === 'CLEAN'));
  assert.equal(notNeeded.length, 1, 'one test pilot was stopped because the result was decided');
  /* a pilot stopped before it ended has no audit ("Not needed"); one that had ended but was not graded shows the audit the companion really made */
  assert.ok(notNeeded[0].audit === 'Not needed' || notNeeded[0].audit === 'CLEAN', 'its audit is honest: ' + notNeeded[0].audit);
  assert.equal(graded.length + notNeeded.length, test.length, 'no other kind of row');
  assert.match(page.region('spend'), /<strong>Spent<\/strong> USD \d+\.\d\d of USD 30\.00/);
  assert.doesNotMatch(page.region('spend'), /<strong>Spent<\/strong> USD 0\.00 /, 'the real spend is reported');
  assert.equal(page.enabled('export'), true);
  await page.click('export');
  assert.equal(page.downloads.length, 1, 'the real export came down: ' + page.status());
  assert.match(page.downloads[0].name, /^[A-Za-z0-9_-]+_pipeline_PRIVATE\.zip$/);
  assert.equal(Buffer.from(page.downloads[0].bytes).subarray(0, 2).toString(), 'PK', 'a zip');
});

test('the page against the real companion: Stop ends a pipeline that is working, and the page says so', { skip: HAS_BACKEND ? false : 'backend/pipeline is not there yet' }, async t => {
  const { source, origin } = await makeRealWorld(t, { hang: true });
  const page = makePage(t, null, { origin });
  await page.boot();
  await page.type('source', { value: 'dir' });
  await page.type('designMode', { value: 'harden' });   /* the stub's task has harden-style files: a prompt, a guideline and a golden answer */
  await page.type('dir', { value: source });
  await page.ackAll();
  await page.click('start');
  assert.match(page.status(), /^Started\./);
  await waitFor(async () => { await page.tick(); return /^Classify:/.test(page.stage()); }, { timeout: 20000, label: 'the classifier to start' });
  assert.equal(page.enabled('stop'), true);
  await sleep(500);   /* the model process has started */
  await page.click('stop');
  await waitFor(async () => { await page.tick(); return /^Stopped:/.test(page.stage()); }, { timeout: 30000, label: 'the stop to show ' + page.stage() + ' | ' + page.status() });
  assert.match(page.region('verdict'), /<h2>Stopped by you<\/h2>/);
  assert.equal(page.has('stop'), false);
  assert.equal(page.enabled('new'), true, 'another pipeline can be started');
  assert.deepEqual(stepsOf(page.region('timeline')).map(x => x.s), ['done', 'stopped', 'todo', 'todo', 'todo', 'todo'], 'the real view of a run stopped while the classifier ran: Classify is where it stopped');
});

test('the page against the real companion: a classification that fails marks the Classify step, not Import', { skip: HAS_BACKEND ? false : 'backend/pipeline is not there yet' }, async t => {
  const { source, origin } = await makeRealWorld(t, { unclassifiable: true });
  const page = makePage(t, null, { origin });
  await page.boot();
  await page.type('source', { value: 'dir' });
  await page.type('designMode', { value: 'harden' });   /* the stub's task has harden-style files: a prompt, a guideline and a golden answer */
  await page.type('dir', { value: source });
  await page.type('cap', { value: '30' });
  await page.type('pilotCap', { value: '1' });
  await page.ackAll();
  await page.click('start');
  assert.match(page.status(), /^Started\./);
  await waitFor(async () => { await page.tick(); return /^Failed:/.test(page.stage()); }, { timeout: 30000, label: 'the run to fail ' + page.stage() + ' | ' + page.status() });
  const steps = stepsOf(page.region('timeline'));
  assert.deepEqual(steps.map(x => x.s), ['done', 'stopped', 'todo', 'todo', 'todo', 'todo'], 'the import finished and the classify step failed');
  assert.equal(steps[1].label, 'Classify');
  assert.match(page.region('verdict'), /<h2>No passing design<\/h2>/);
  assert.match(page.region('verdict'), /Could not tell which part of the page is/);
});
