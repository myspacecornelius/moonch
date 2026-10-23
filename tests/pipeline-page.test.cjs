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
const REGIONS = ['pl-start-form', 'pl-start-foot', 'pl-picker', 'pl-spend', 'pl-actions', 'pl-wait', 'pl-withheld', 'pl-timeline', 'pl-import', 'pl-classify', 'pl-design', 'pl-screen', 'pl-test', 'pl-redesigns', 'pl-verdict'];
const TEXT_FIELDS = new Set(['url', 'dir', 'cap', 'pilotCap']);

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

test('the start card: link or folder, total cap 30, model and effort from the companion, per-pilot cap, four acknowledgements, one yellow button', async t => {
  const { page } = await bootWith(t);
  const form = page.region('start-form');
  assert.match(form, /Task link \(https\)/);
  assert.match(form, /Folder on this computer/);
  assert.match(form, /id="pl-cap"[^>]*value="30"/, 'the total cap starts at 30');
  assert.match(form, /id="pl-pilot-cap"[^>]*value="3\.00"/);
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5']) assert.ok(form.includes(`<option value="${model}"`), model);
  for (const effort of ['low', 'medium', 'high']) assert.ok(form.includes(`<option value="${effort}"`), effort);
  assert.match(form, /<option value="claude-opus-5-5" selected>/, 'the default model comes from the companion list');
  assert.match(form, /<option value="medium" selected>/);
  for (const id of ACK_IDS) assert.ok(page.tagOf('data-id', id), 'a checkbox for ' + id);
  assert.equal((form.match(/data-pl-in="ack"/g) || []).length, 4);
  assert.equal((form.match(/type="checkbox"/g) || []).length, 5, 'the four acknowledgements and the withheld-files choice');
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

test('a click on the disabled button starts nothing', async t => {
  const { companion, page } = await bootWith(t);
  await page.click('start');
  assert.equal(companion.calls.filter(c => c.method === 'POST').length, 0);
});

test('the line under the button says what will happen, with the bar, the pilot counts, the redesigns and the cap', async t => {
  const { page } = await bootWith(t);
  const line = page.region('start-foot').match(/<p class="pl-happens">([^<]*)<\/p>/)[1];
  for (const part of ['imported', 'classified', 'designs the hardest traps', 'two blind pilots', 'below 0.45', 'five pilots', 'at least 4 of 5', '3 redesigns', 'total cap', 'Stop']) assert.ok(line.includes(part), part);
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
  assert.deepEqual(posts[0].body, { url: TASK_LINK, capUsd: 25.5, model: 'claude-sonnet-5-5', effort: 'high', pilotCapUsd: 2, acceptMissing: false, acknowledgements: ACK_IDS });
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
  assert.deepEqual(post.body, { sourceDir: '/Users/you/Downloads/atlas-task', capUsd: 30, model: 'claude-opus-5-5', effort: 'medium', pilotCapUsd: 3, acceptMissing: false, acknowledgements: ACK_IDS });
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
  const ended = { done: 'Done:', failed: 'Failed:', stopped: 'Stopped: you pressed Stop.', budget: 'Stopped: the next step would pass the total cap.' };
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

test('the sign-in wait names the Chrome window, and a wait of another kind gets a plain title', async t => {
  const { companion, page } = await bootWith(t, [baseState({ waiting: { kind: 'needs-sign-in', message: 'Sign in to the task site in the Chrome window.', since: '2026-10-23T10:01:00.000Z' } })]);
  assert.match(page.region('wait'), /Sign in in the Chrome window/);
  assert.match(page.region('wait'), /Sign in to the task site in the Chrome window\./);
  assert.equal(page.enabled('continue'), true);
  companion.update('pl-atlas-0001', { waiting: { kind: 'something-new', message: 'Please check the window.' } });
  await page.tick();
  assert.match(page.region('wait'), /The task page needs you/);
  assert.match(page.region('wait'), /Please check the window\./);
  companion.update('pl-atlas-0001', { waiting: { kind: 'needs-person' } });
  await page.tick();
  assert.match(page.region('wait'), /Finish what the Chrome window asks for, then press Continue\./, 'a wait with no message still says what to do');
});

test('a failed Continue is shown in words and the button works again', async t => {
  const { companion, page } = await bootWith(t, [baseState({ waiting: { kind: 'needs-person', message: 'Flip the switch.' } })]);
  companion.fail('POST /api/pipeline/pl-atlas-0001/continue', 409, 'Nothing is waiting.');
  await page.click('continue');
  assert.equal(page.status(), 'Failed: Nothing is waiting.');
  assert.equal(page.enabled('continue'), true);
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
  const { page } = await bootWith(t, [baseState({ stage: 'test', design: designFacts(), screen: stageOf('screen', [0.45, 0.2], true, { 0: regraded(0.43, 0.47, 0.45), 1: { regrade: null } }) })]);
  const s = page.region('screen');
  assert.match(s, /<td data-label="Score">0\.45<small class="pl-regraded">Graded twice: 0\.43, 0\.47<\/small><\/td>/);
  assert.match(s, /<td data-label="Score">0\.20<\/td>/, 'a single grading says nothing extra');
  assert.deepEqual([...s.matchAll(/data-label="Below 0\.45">(.*?)<\/td>/g)].map(m => m[1].replace(/<[^>]*>/g, '')), ['✕ No', '✓ Yes'], 'the average, 0.45, is not below the bar');
  const { page: edge } = await bootWith(t, [baseState({ id: 'pl-atlas-0002', stage: 'test', design: designFacts(), screen: stageOf('screen', [0.4496, 0.1], true, { 0: regraded(0.4492, 0.45, 0.4496) }) })]);
  assert.match(edge.region('screen'), /0\.45 \(0\.4496\)<small class="pl-regraded">Graded twice: 0\.45 \(0\.4492\), 0\.45<\/small>/, 'near-bar digits keep the yes or no honest');
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
  companion.attemptPatch('pl-atlas-0001', { screen: { ...stageOf('screen', [0.3, 0.2, 0.45], true, { 2: { replacement: true, regrade: { first: 0.44, second: 0.46, average: 0.45 } } }), replacementRound: true } });
  await page.tick();
  s = page.region('screen');
  assert.match(s, /A replacement round ran for the pilots without a usable score\./);
  assert.doesNotMatch(s, /No replacement round was run/);
  assert.match(s, /A score from 0\.40 to 0\.50 is graded a second time and the two scores are averaged\./, 'the band comes from the companion');
  const { page: noConfig } = await bootWith(t, [baseState({ stage: 'test', design: designFacts(), screen: stageOf('screen', [0.45, 0.2], true, { 0: { regrade: { first: 0.44, second: 0.46, average: 0.45 } } }) })], { config: {} });
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
  assert.equal(limits(), 'Each pilot is capped at USD 3.00, so a 2-pilot screen can cost up to USD 6.00 and a 5-pilot test up to USD 15.00. The other calls are capped too: the classifier USD 0.50, the designer USD 5.00 and one repair turn USD 1.00, the fairness review USD 0.25, each grader call USD 0.50. The total cap of USD 30.00 covers everything. Before each step the run reserves its worst case with 15% headroom on top, and stops when that would pass the total cap.');
  const { page: custom } = await bootWith(t, [], { config: { classifyCapUsd: 0.75, designCapUsd: 8, repairCapUsd: 2, fairnessCapUsd: 0.4, graderCapUsd: 0.6, goldenMin: 0.9, regradeBand: [0.4, 0.5], headroom: 1.25 } });
  const text = custom.region('start-foot').match(/<p class="footnote pl-limits">([^<]*)<\/p>/)[1];
  assert.match(text, /the classifier USD 0\.75, the designer USD 8\.00 and one repair turn USD 2\.00, the fairness review USD 0\.40, each grader call USD 0\.60/);
  assert.match(text, /with 25% headroom on top/, 'the headroom is the companion\'s');
  const { page: bare } = await bootWith(t, [], { config: {} });
  const old = bare.region('start-foot').match(/<p class="footnote pl-limits">([^<]*)<\/p>/)[1];
  assert.equal(old, 'Each pilot is capped at USD 3.00, so a 2-pilot screen can cost up to USD 6.00 and a 5-pilot test up to USD 15.00, before the classifier, designer and grader runs. The total cap of USD 30.00 covers everything.');
  const { page: partial } = await bootWith(t, [], { config: { fairnessCapUsd: 0.25, headroom: 1 } });
  const some = partial.region('start-foot').match(/<p class="footnote pl-limits">([^<]*)<\/p>/)[1];
  assert.match(some, /The other calls are capped too: the fairness review USD 0\.25\./);
  assert.doesNotMatch(some, /headroom/, 'no headroom of 1 to speak of');
  await page.type('cap', { value: '12' });
  await page.type('pilotCap', { value: '1' });
  assert.match(limits(), /^Each pilot is capped at USD 1\.00, so a 2-pilot screen can cost up to USD 2\.00 and a 5-pilot test up to USD 5\.00\..*The total cap of USD 12\.00 covers everything\./);
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

const rowsOf = html => [...html.matchAll(/<tr><th scope="row">Pilot (\d+)<\/th><td data-label="Score">([^<]*)<\/td><td data-label="Below 0\.45">(.*?)<\/td><td data-label="Audit">(.*?)<\/td><\/tr>/g)].map(m => ({ pilot: Number(m[1]), score: m[2], below: m[3].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(), audit: m[4].replace(/<[^>]*>/g, '').trim() }));

test('the screen table: pilot, score to two decimals, below 0.45 yes or no in words, the audit badge, the bar and the rule', async t => {
  const { page } = await bootWith(t, [baseState({ stage: 'test', design: designFacts(), screen: { passed: true, pilots: pilots([0.3, 0.1]) } })]);
  const s = page.region('screen');
  assert.match(s, /2-pilot screen/);
  assert.match(s, /The screen passes when both pilots score below 0\.45\./);
  assert.match(s, /<span class="pill green">Screen passed<\/span>/);
  assert.match(s, /<caption class="sr-only">2-pilot screen: score of each pilot against the bar of 0\.45<\/caption>/);
  assert.match(s, /<th scope="col">Below 0\.45<\/th>/);
  assert.deepEqual(rowsOf(s), [{ pilot: 1, score: '0.30', below: '✓ Yes', audit: 'CLEAN' }, { pilot: 2, score: '0.10', below: '✓ Yes', audit: 'CLEAN' }]);
  assert.match(s, /2 of 2 below 0\.45; both needed\./);
  assert.match(s, /<span class="pill green">CLEAN<\/span>/);
});

test('a failed screen: a score at or above the bar is No, the pill says Screen failed, and the tally counts honestly', async t => {
  const { page } = await bootWith(t, [baseState({ stage: 'redesign', redesigns: 0, design: designFacts(), screen: { passed: false, pilots: pilots([0.45, 0.2]) } })]);
  const s = page.region('screen');
  assert.deepEqual(rowsOf(s).map(r => [r.score, r.below]), [['0.45', '✕ No'], ['0.20', '✓ Yes']]);
  assert.match(s, /<span class="pill red">Screen failed<\/span>/);
  assert.match(s, /1 of 2 below 0\.45; both needed\./);
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
  assert.match(page.region('screen'), /2 of 2 below 0\.45; both needed\./);
  companion.attemptPatch('pl-atlas-0001', { screen: stageOf('screen', [0.2, 0.3], true) });
  await page.tick();
  assert.match(page.region('screen'), /<span class="pill green">Screen passed<\/span>/);
});

test('scores are shown to two decimals, and a score that rounds onto the bar shows its extra digits so the yes or no is never a surprise', async t => {
  const { page } = await bootWith(t, [baseState({ stage: 'test', design: designFacts(), screen: { passed: true, pilots: pilots([0.4496, 0.4501]) } })]);
  assert.deepEqual(rowsOf(page.region('screen')).map(r => [r.score, r.below]), [['0.45 (0.4496)', '✓ Yes'], ['0.45 (0.4501)', '✕ No']]);
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
  assert.equal(steps[4].caption, 'Stopped here');
  assert.equal(steps[4].mark, '!');
  const { page: early } = await bootWith(t, [baseState({ id: 'pl-atlas-0009', stage: 'failed', error: 'The link could not be opened.' })]);
  assert.deepEqual(stepsOf(early.region('timeline')).map(s => s.s), ['stopped', 'todo', 'todo', 'todo', 'todo', 'todo']);
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
  assert.equal(RULES.passBar, k.PASS_BAR);
  assert.equal(RULES.screenPilots, k.SCREEN_PILOTS);
  assert.equal(RULES.testPilots, k.TEST_PILOTS);
  assert.equal(RULES.testNeed, k.TEST_NEED);
  assert.equal(RULES.maxRedesigns, k.MAX_REDESIGNS);
  assert.equal(RULES.defaultCapUsd, k.DEFAULT_CAP_USD);
  assert.equal(RULES.maxCapUsd, k.MAX_CAP_USD);
  if (k.GOLDEN_MIN !== undefined) assert.equal(makeAdapter().CALIBRATION_MIN, k.GOLDEN_MIN, 'the calibration the page says is needed is the one the companion enforces');
  const { ACKNOWLEDGEMENTS } = makeAdapter();
  assert.deepEqual(Array.from(ACKNOWLEDGEMENTS, x => x.id), [...k.ACKNOWLEDGEMENTS], 'the page asks for exactly the acknowledgements the companion requires, in its order');
  const fourth = ACKNOWLEDGEMENTS[3];
  assert.equal(fourth.label + ': ' + fourth.text.charAt(0).toLowerCase() + fourth.text.slice(1), k.MODEL_READS_TASK_TEXT, 'the fourth acknowledgement is the companion\'s sentence word for word');
});

test('the display constants are the spec numbers', () => {
  const { RULES } = makeAdapter();
  assert.deepEqual(plain(RULES), { passBar: 0.45, screenPilots: 2, testPilots: 5, testNeed: 4, maxRedesigns: 3, defaultCapUsd: 30, maxCapUsd: 200 });
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

/* ====================================================================== against the real companion and orchestrator (the model is the stub) */

const HAS_BACKEND = fs.existsSync(path.join(REPO, 'backend', 'pipeline', 'service.cjs'));
const GUIDELINE_MARK = 'DESIGNER-GUIDELINE-MARK', GOLDEN_MARK = 'DESIGNER-GOLDEN-MARK', MECH_MARK = 'MECH-SECRET-1', CORRECT_MARK = 'CORRECT-SECRET-1';

/* A real companion (backend/server.cjs) with the real agent service and pipeline service on a temporary project, a downloaded task in a folder and
   the stub for every model run. rules: the stub's rules (default: the whole run, screen passes and test succeeds); hang: every model run hangs. */
async function makeRealWorld(t, { hang = false } = {}) {
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
    ...scores.map((score, i) => ({ cwd: 'finance-studio-pilots/gsim-', prompt: `<<<ANSWER\\nANS-1-${i + 1}\\b`, scenario: { resultText: JSON.stringify({ verdict: 'does-not-meet-guidance', reason: `Synthetic grader reason for ${score.toFixed(2)}`, score }), costUsd: 0.02 } })),
  ];
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
  assert.match(page.region('verdict'), /The test passed: 5 of 5 pilots scored below 0\.45/);
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
  assert.ok(screen.every(r => /Yes/.test(r.below) && r.audit === 'CLEAN') && test.every(r => /Yes/.test(r.below) && r.audit === 'CLEAN'));
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
});
