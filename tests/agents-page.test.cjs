'use strict';
/* Tests for the Agents page (agents.js) and the edition-dependent copy of the other pages, without a browser.

   The real agents.js runs inside a vm with a small fake document. Its requests go to a real companion (backend/server.cjs) on an
   ephemeral port, backed by backend/agents/stub-claude.cjs, so no model is started and nothing leaves this machine. Clicks and
   typing are sent through the page's own event handler, found by the data-ag attributes in the markup the page painted.
   Every fixture is synthetic and lives in temporary folders that are removed afterwards. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanEnv } = require('./fixtures/clean-env.cjs');
const vm = require('node:vm');

const { createServer } = require('../backend/server.cjs');
const { createAgentService } = require('../backend/agents/index.cjs');
const { GAF_RE } = require('../backend/agents/pilot-folder.cjs');

const REPO = path.resolve(__dirname, '..');
const STUB = path.join(REPO, 'backend', 'agents', 'stub-claude.cjs');
const AGENTS_SOURCE = fs.readFileSync(path.join(REPO, 'agents.js'), 'utf8');
const PROMPT = 'Assess the Atlas liquidity position using the supplied records and recommend whether the borrowing can proceed.';
const ACK = ['shell-access', 'network', 'isolation-by-audit'];
const GOLD = {
  gold: { decision: 'hold', figures: [{ label: 'Usable cash', value: '1,250', tolerance: 1 }], notes: 'Synthetic gold' },
  fingerprints: [{ id: 'fp-alpha', label: 'Counts available credit as cash', tokens: ['available facility counted'], figures: [] }],
};
const GOLD_ANSWER = 'Usable cash is 1,250. Hold the borrowing.';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, { timeout = 15000, interval = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + label);
    await sleep(interval);
  }
}

/* ------------------------------------------------------------------ the world: companion, service, packet folder */

async function makeWorld(t, scenario = {}, options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-page-test-'));
  const projectRoot = path.join(base, 'project');
  const source = path.join(base, 'source');
  const tmpRoot = path.join(base, 'tmp');
  fs.mkdirSync(path.join(projectRoot, 'private'), { recursive: true });
  fs.mkdirSync(source);
  fs.mkdirSync(tmpRoot);
  const put = (rel, data) => {
    const target = path.join(source, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data === undefined ? 'synthetic contents of ' + rel : data);
  };
  put('Facility_Terms.txt', 'Atlas facility terms, synthetic. Available credit is not cash received.\n');
  put('Cash_Facts.csv', 'Label,Value\nOpening usable cash,100\nConfirmed funded draw,500\n');
  const env = { ...cleanEnv(), FINANCE_STUB_SCENARIO: JSON.stringify(scenario), ...(options.env || {}) };
  const claudeBin = options.claudeBin || STUB;
  const service = createAgentService({ root: projectRoot, env, claudeBin, tmpRoot, limits: options.limits });
  const app = createServer({ root: projectRoot, service, port: 0, log: () => {} });
  const { port } = await app.listen();
  const world = { base, projectRoot, source, tmpRoot, put, env, service, app, port, origin: `http://127.0.0.1:${port}`, roundsDir: path.join(projectRoot, 'private', 'agent-rounds') };
  t.after(async () => {
    await app.shutdown();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return world;
}

const roundBody = (w, extra = {}) => ({
  label: 'synthetic round', sourceDir: w.source, promptText: PROMPT, gafVisible: true,
  config: { model: 'claude-opus-5-5', effort: 'medium', count: 1 }, ...extra,
});

async function approvedRoundViaService(w, extra) {
  const round = await w.service.createRound(roundBody(w, extra));
  await w.service.freezeRound(round.id, GOLD);
  const { summarySha256 } = await w.service.approvalSummary(round.id);
  await w.service.approveRound(round.id, { summarySha256, acknowledgements: ACK });
  return round.id;
}

async function finishedRoundViaService(w, extra) {
  const id = await approvedRoundViaService(w, extra);
  await w.service.launchRound(id);
  await w.service.whenSettled(id);
  return id;
}

/* ------------------------------------------------------------------ the page: agents.js in a vm with a fake document */

function makeElement(id) {
  return {
    id, innerHTML: '', textContent: '', agHtml: null, disabled: false, className: '', dataset: {}, tabIndex: 0,
    classList: { toggle() {}, add() {}, remove() {} },
    contains: () => false, querySelector: () => null, getAttribute: () => null, focus() {}, getClientRects: () => [],
  };
}

/* A Map-backed stand-in for window.localStorage. broken: every call throws, as blocked storage does. */
function makeStorage({ broken = false } = {}) {
  const map = new Map();
  const guard = () => { if (broken) throw new Error('synthetic: storage is blocked'); };
  return {
    map,
    getItem: key => { guard(); return map.has(key) ? map.get(key) : null; },
    setItem: (key, value) => { guard(); map.set(key, String(value)); },
    removeItem: key => { guard(); map.delete(key); },
  };
}
const DRAFT_KEY = 'finance-studio.agents.draft.v1';

function makePage(t, world, { location, storage, pkg, engine, navigator, authoring, documentExtras } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  let inflight = 0;
  /* every request the page makes, in order: the proof that an offline call made none and that a post carried the nonce */
  const requests = [];
  const pageFetch = async (url, init = {}) => {
    inflight++;
    requests.push({ url, method: init.method || 'GET', nonce: init.headers && init.headers['x-finance-local'] });
    try {
      const headers = { ...(init.headers || {}) };
      if (init.method && init.method !== 'GET') headers.Origin = world.origin;
      return await fetch(world.origin + url, { ...init, headers });
    } finally {
      inflight--;
    }
  };
  const document = {
    activeElement: null, hidden: false, body: element('body'), title: 'Finance Task Studio',
    querySelector: selector => {
      const match = /^#([\w-]+)$/.exec(selector);
      return match ? element(match[1]) : null;
    },
    addEventListener() {},
    ...(documentExtras || {}),
  };
  const context = vm.createContext({
    document, fetch: pageFetch, setTimeout, clearTimeout, console, URL, Blob,
    location: location || { protocol: 'http:', hostname: '127.0.0.1' }, CSS: { escape: value => String(value) },
    ...(storage ? { localStorage: storage } : {}),
    ...(navigator ? { navigator } : {}),
  });
  context.window = context;
  /* authoring: a stand-in for the task editor's FinanceAuthoring, which agents.js reads for the project (prompt limit, versions). */
  if (authoring) context.FinanceAuthoring = authoring;
  /* engine: the page as index.html loads it, with package-engine.js (window.FinancePackageEngine) before agents.js. */
  if (engine) {
    Object.assign(context, { TextDecoder, TextEncoder });
    vm.runInContext(fs.readFileSync(path.join(REPO, 'package-engine.js'), 'utf8'), context, { filename: 'package-engine.js' });
  }
  vm.runInContext(AGENTS_SOURCE, context, { filename: 'agents.js' });
  const agents = context.FinanceAgents;
  assert.ok(agents && typeof agents.handleEvent === 'function', 'agents.js exports its handler');
  t.after(() => agents.afterRender(false));

  const all = () => ['ag-strip', 'ag-draft', 'ag-runtime', 'ag-packet', 'ag-settings', 'ag-freeze', 'ag-round', 'ag-runs', 'ag-gate', 'ag-freeze-state', 'agents-modal'].map(id => element(id).innerHTML).join('\n');
  /* Controls are looked up in the innermost painted copy first: the fake elements do not nest, so the gate and the freeze
     state are newer than the copies inside the cards that hold them. */
  const newestFirst = () => ['agents-modal', 'ag-gate', 'ag-freeze-state', 'ag-strip', 'ag-draft', 'ag-runtime', 'ag-packet', 'ag-settings', 'ag-freeze', 'ag-round', 'ag-runs'].map(id => element(id).innerHTML).join('\n');
  const tagOf = (action, dataset = {}) => {
    const wanted = Object.entries(dataset).map(([key, value]) => `data-${key}="${value}"`);
    const found = [...newestFirst().matchAll(/<(?:button|tr)\b[^>]*>/g)].map(match => match[0]).find(tag => tag.includes(`data-ag="${action}"`) && wanted.every(attribute => tag.includes(attribute)));
    return found || null;
  };
  const page = {
    elements,
    element,
    requests,
    context,
    agents,
    document,
    html: all,
    section: name => element('ag-' + name).innerHTML,
    modal: () => element('agents-modal').innerHTML,
    status: () => element('ag-status').textContent,
    text: () => all().replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' '),
    has: (action, dataset) => tagOf(action, dataset) !== null,
    enabled: (action, dataset) => {
      const tag = tagOf(action, dataset);
      return tag !== null && !/\sdisabled(\s|>|=)/.test(tag);
    },
    async settle() {
      let quiet = 0;
      while (quiet < 3) {
        await sleep(25);
        quiet = inflight === 0 ? quiet + 1 : 0;
      }
    },
    async click(action, dataset = {}) {
      const tag = tagOf(action, dataset);
      assert.ok(tag, `the page has a control for ${action}`);
      const el = {
        dataset: { ag: action, ...dataset }, disabled: /\sdisabled(\s|>|=)/.test(tag),
        closest: selector => (selector === '[data-ag]' ? el : selector === '#ag-root' || selector === '#agents-modal' ? {} : null),
      };
      agents.handleEvent({ type: 'click', target: el });
      await page.settle();
    },
    async type(kind, props = {}) {
      const el = {
        dataset: { agIn: kind, ...(props.dataset || {}) }, value: props.value, checked: props.checked,
        closest: selector => (selector === '[data-ag-in]' ? el : selector === '#ag-root' || selector === '#agents-modal' ? {} : null),
      };
      agents.handleEvent({ type: props.event || 'input', target: el });
      await page.settle();
    },
    async boot() {
      agents.render({ package: pkg || null, notify() {}, download() {} });
      agents.afterRender(true);
      await waitFor(() => element('ag-runtime').innerHTML, { label: 'the page to load' });
      await page.settle();
    },
    async fillAndFreeze(extra = {}) {
      await page.type('dir', { value: world.source });
      await page.click('inspect');
      await page.type('prompt', { value: PROMPT });
      await page.type('decision', { value: 'hold' });
      await page.type('fig', { value: 'Usable cash', dataset: { kind: 'gfig', i: 0, j: 0, f: 'label' } });
      await page.type('fig', { value: '1,250', dataset: { kind: 'gfig', i: 0, j: 0, f: 'value' } });
      await page.type('fp', { value: 'fp-alpha', dataset: { i: 0, f: 'id' } });
      await page.type('fp', { value: 'available facility counted', dataset: { i: 0, f: 'tokens' } });
      if (extra.gaf !== undefined) await page.type('gaf', { checked: extra.gaf });
      await page.click('freeze');
    },
    async acknowledgeAll() {
      for (const id of ACK) await page.type('ack', { checked: true, dataset: { id } });
    },
  };
  return page;
}

/* ====================================================================== approve, then a refused launch */

test('a launch refused after the approval keeps the dialog usable: the round is shown as approved and the next click launches it', async t => {
  const w = await makeWorld(t, { hang: true }, { limits: { killGraceMs: 200 } });
  /* Another round is running, so the launch of the page's round is refused with 409 after its approval went through. */
  const other = await approvedRoundViaService(w);
  await w.service.launchRound(other);
  const page = makePage(t, w);
  await page.boot();
  await page.fillAndFreeze();
  assert.match(page.section('round'), /frozen/);
  await page.click('open-approve');
  assert.match(page.modal(), /Approve and launch this round/);
  await page.acknowledgeAll();
  assert.equal(page.enabled('approve-launch'), true);

  await page.click('approve-launch');
  assert.match(page.modal(), /Another round is running/);
  assert.match(page.modal(), /is approved and nothing was started/, 'the dialog says the round is approved');
  assert.doesNotMatch(page.modal(), /already approved/);
  assert.match(page.section('round'), /approved/, 'the page agrees with the companion about the status');
  assert.doesNotMatch(page.section('round'), /· frozen/);
  assert.equal(page.has('refreeze'), false, 'an approved round that never ran offers no post-hoc freeze');
  assert.match(page.section('freeze'), /Freeze again \(new round\)/, 'the freeze controls are unchanged');

  /* The cause goes away. The same dialog launches the approved round without approving it again. */
  await w.service.cancelRound(other);
  await w.service.whenSettled(other);
  assert.equal(page.enabled('approve-launch'), true, 'the button stays usable');
  await page.click('approve-launch');
  assert.equal(page.modal().trim(), '', 'the dialog closed after a successful launch');
  assert.match(page.section('round'), /running/);
  assert.match(page.status(), /launched/);
  assert.equal(page.has('refreeze'), true, 'once launched, a post-hoc version is possible');
  assert.match(page.html(), /post-hoc/i);
});

test('the launch gate says when Claude Code is missing, and Check again opens it once it is installed', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-page-bin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wrapper = path.join(dir, 'claude-wrapper');
  const w = await makeWorld(t, { resultText: GOLD_ANSWER }, { claudeBin: wrapper });
  const page = makePage(t, w);
  await page.boot();
  assert.match(page.section('runtime'), /Claude Code was not found/);
  await page.fillAndFreeze();
  assert.equal(page.enabled('open-approve'), false, 'launch is disabled while the runtime is missing');
  assert.match(page.html(), /Claude Code was not found, so nothing can start/);

  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${STUB}" "$@"\n`, { mode: 0o755 });
  await page.click('check-runtime');
  assert.match(page.section('runtime'), /Claude Code was found/, 'Check again sees the program at once');
  assert.equal(page.enabled('open-approve'), true);
});

/* ====================================================================== what the approval dialog shows */

test('the approval dialog repeats the prompt, its hash, the files delivered and the files withheld by the gaf setting', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER });
  w.put('gaf/Template_Layout.txt', 'synthetic template');
  w.put('gaf-hedge.csv', 'a,b\n1,2\n');
  /* A round made through the API can select gaf files while gaf is hidden; the companion then withholds them and says so. */
  const created = await w.service.createRound(roundBody(w, { gafVisible: false, include: ['Cash_Facts.csv', 'Facility_Terms.txt', 'gaf-hedge.csv', 'gaf/Template_Layout.txt'] }));
  await w.service.freezeRound(created.id, GOLD);
  const page = makePage(t, w);
  await page.boot();
  await page.click('open-approve');
  const dialog = page.modal();
  const round = await w.service.getRound(created.id);
  assert.ok(dialog.includes('Assess the Atlas liquidity position'), 'the prompt text');
  assert.ok(dialog.includes(round.packet.promptSha256), 'the prompt hash');
  assert.match(page.text(), /4 selected, 2 delivered to each pilot/);
  assert.match(page.text(), /Withheld because gaf\/ is hidden \(2\)/);
  const delivered = dialog.slice(dialog.indexOf('<h3>Files</h3>'), dialog.indexOf('Withheld because gaf/'));
  assert.ok(delivered.includes('Cash_Facts.csv') && delivered.includes('Facility_Terms.txt'));
  assert.ok(!delivered.includes('gaf-hedge.csv') && !delivered.includes('gaf/Template_Layout.txt'), 'gaf files are not listed as delivered');
  const withheld = dialog.slice(dialog.indexOf('Withheld because gaf/'), dialog.indexOf('<h3>Command line</h3>'));
  assert.ok(withheld.includes('gaf-hedge.csv') && withheld.includes('gaf/Template_Layout.txt'), 'a gaf-named file is withheld like a gaf folder file');
  assert.match(dialog, /The exact text this approval covers/);
  assert.ok(dialog.includes('Withheld because the gaf folder is hidden: gaf-hedge.csv, gaf/Template_Layout.txt'), 'the companion text that is hashed is shown as it is');
});

test('with gaf hidden, the page itself leaves out a gaf-named file, so the packet table and the companion agree', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER });
  w.put('gaf/Template_Layout.txt', 'synthetic template');
  w.put('gaf-hedge.csv', 'a,b\n1,2\n');
  const page = makePage(t, w);
  await page.boot();
  await page.fillAndFreeze({ gaf: false });
  const packet = page.section('packet');
  assert.equal((packet.match(/Hidden: gaf\/ is off/g) || []).length, 2, 'both gaf files are marked hidden');
  assert.match(packet, /gaf-hedge\.csv<\/code><span class="pill ">Hidden/);
  assert.match(packet, /2 of 4 files included/);
  await page.click('open-approve');
  assert.match(page.text(), /2 selected, 2 delivered to each pilot/);
  const round = await w.service.getRound((await w.service.listRounds())[0].id);
  assert.deepEqual(round.packet.files.filter(file => file.include).map(file => file.path).sort(), ['Cash_Facts.csv', 'Facility_Terms.txt']);
  assert.doesNotMatch(page.text(), /Withheld because gaf\/ is hidden/);
  assert.match(page.modal(), /Withheld because the gaf folder is hidden: none/);
});

test('a gaf/ file whose name has a grading word is included, and the packet table marks it for a second look', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER });
  w.put('gaf/Golden_Response.docx', 'synthetic');
  w.put('gaf/Template_Layout.txt', 'synthetic template');
  w.put('Golden_Response.docx', 'synthetic');
  const page = makePage(t, w, { engine: true });
  await page.boot();
  await page.type('dir', { value: w.source });
  await page.click('inspect');
  const packet = page.section('packet');
  const row = name => packet.slice(packet.indexOf(`<code class="ag-path">${name}</code>`), packet.indexOf('</tr>', packet.indexOf(`<code class="ag-path">${name}</code>`)));
  assert.match(row('gaf/Golden_Response.docx'), /Check: grading word in a gaf\/ file/);
  assert.match(row('gaf/Golden_Response.docx'), /Its name has a grading word, which withholds a file anywhere else: make sure pilots should see it\./);
  assert.match(row('gaf/Golden_Response.docx'), /data-label="Role">template</);
  assert.doesNotMatch(row('gaf/Template_Layout.txt'), /Check: grading word/);
  assert.doesNotMatch(row('Golden_Response.docx'), /Check: grading word/, 'outside gaf/ the file is withheld instead');
  assert.match(row('Golden_Response.docx'), /Withheld by default: the name contains the word &quot;golden&quot;/);
  assert.equal((packet.match(/Check: grading word/g) || []).length, 1);

  /* Without the engine (an older page build) nothing is marked and nothing breaks. */
  const bare = makePage(t, w);
  await bare.boot();
  await bare.type('dir', { value: w.source });
  await bare.click('inspect');
  assert.doesNotMatch(bare.section('packet'), /Check: grading word/);
});

test('the page and the companion use one rule for which files are gaf files', () => {
  const match = /const isGaf=path=>\/(.+)\/([a-z]*)\.test\(String\(path\)\);/.exec(AGENTS_SOURCE);
  assert.ok(match, 'agents.js defines isGaf with a regular expression literal');
  assert.equal(match[1], GAF_RE.source);
  assert.equal(match[2], GAF_RE.flags);
});

/* ====================================================================== post-hoc freezes */

test('a fingerprint added by a post-hoc freeze can be chosen when classifying, and every freeze version is listed', async t => {
  const w = await makeWorld(t, { resultText: 'Cash looks fine and zeta-marker applies. Proceed.' });
  const id = await finishedRoundViaService(w);
  const posthoc = {
    gold: { decision: 'hold', figures: [{ label: 'Usable cash', value: '1,250', tolerance: 1 }], notes: 'after the fact' },
    fingerprints: [...GOLD.fingerprints, { id: 'fp-zeta', label: 'Seen only in the outputs', tokens: ['zeta-marker'], figures: [] }],
  };
  await w.service.refreezeRound(id, posthoc);
  const page = makePage(t, w);
  await page.boot();

  assert.match(page.section('freeze') + page.html(), /Frozen \(version 1\)/);
  assert.match(page.html(), /Post-hoc freeze version \(version 2\)/);
  const round = await w.service.getRound(id);
  assert.ok(page.html().includes(round.freeze.sha256) && page.html().includes(round.postHocFreezes[0].sha256), 'both hashes are shown');

  await page.click('open-run', { n: 1 });
  const drawer = page.modal();
  assert.ok(/data-id="fp-alpha"/.test(drawer), 'the original fingerprint chip');
  assert.ok(/data-id="fp-zeta"/.test(drawer), 'the post-hoc fingerprint chip');
  assert.match(drawer, /fp-zeta · post-hoc/);
  assert.doesNotMatch(drawer, /fp-alpha · post-hoc/);
  assert.match(drawer, /Fingerprint candidates: fp-zeta/);

  await page.click('apply-suggestion');
  assert.match(page.modal(), /data-id="fp-zeta"[^>]*aria-pressed="true"/, 'the suggested post-hoc fingerprint is selected');
  await page.click('save-class');
  assert.doesNotMatch(page.modal(), /Choose at least one fingerprint chip/);
  const run = await w.service.getRun(id, 1);
  assert.equal(run.classification.human.verdict, 'fingerprint');
  assert.deepEqual(run.classification.human.fingerprintIds, ['fp-zeta']);
});

/* ====================================================================== failed runs and runs that were never audited */

test('a failed run explains itself: the reason in words, the runtime message, and the command with the prompt elided', async t => {
  const w = await makeWorld(t, [
    { resultText: '', exitCode: 3, stderr: 'synthetic runtime complaint' },
    { resultText: 'Not logged in. Please run /login', isError: true },
  ]);
  const id = await finishedRoundViaService(w, { config: { model: 'claude-opus-5-5', effort: 'medium', count: 2 } });
  const page = makePage(t, w);
  await page.boot();

  await page.click('open-run', { n: 1 });
  let drawer = page.modal();
  assert.match(drawer, /The program exited with code 3\./);
  assert.match(drawer, /synthetic runtime complaint/);
  assert.match(drawer, /claude -p/);
  assert.match(drawer, /&lt;prompt elided&gt;/, 'the prompt is elided');
  assert.doesNotMatch(drawer, /claude --version/);
  assert.match(drawer, /--model claude-opus-5-5 --effort medium/);
  assert.match(drawer, /--no-session-persistence --max-budget-usd 3\.00/, 'the documented command carries the spending cap');
  assert.match(drawer, /Runtime message \(the run failed\)/);
  assert.doesNotMatch(drawer, /<h3>Final answer<\/h3>/);
  assert.ok(!drawer.includes(PROMPT), 'the prompt text itself is not in the command');

  await page.click('close-overlay');
  await page.click('open-run', { n: 2 });
  drawer = page.modal();
  assert.match(drawer, /The runtime reported an error as its result/);
  assert.match(drawer, /Not logged in\. Please run \/login/);
  assert.match(drawer, /Runtime message \(the run failed\)/);
  assert.match(drawer, /It is not an answer to grade/);
  assert.equal(id.length > 0, true);
});

test('a timeout is explained in words', async t => {
  const w = await makeWorld(t, { hang: true }, { limits: { timeoutMs: 400, killGraceMs: 100 } });
  await finishedRoundViaService(w);
  const page = makePage(t, w);
  await page.boot();
  await page.click('open-run', { n: 1 });
  assert.match(page.modal(), /The pilot ran out of time \(50 minutes\) and was stopped\./);
});

test('a pilot stopped by its spending cap is explained in words, with the round cap', async t => {
  const w = await makeWorld(t, { budgetExhausted: true, exitCode: 1 });
  const id = await finishedRoundViaService(w, { config: { model: 'claude-opus-5-5', effort: 'medium', count: 1, maxBudgetUsd: 0.75 } });
  const run = await w.service.getRun(id, 1);
  assert.equal(run.state, 'failed');
  assert.equal(run.failureReason, 'budget');
  assert.equal(run.terminalReason, 'budget_exhausted');
  const page = makePage(t, w);
  await page.boot();
  await page.click('open-run', { n: 1 });
  const drawer = page.modal();
  assert.match(drawer, /The pilot reached its spending cap of USD 0\.75 \(--max-budget-usd 0\.75\) and the runtime stopped it before it finished\./);
  assert.doesNotMatch(drawer, /The program exited with code 1\./, 'the cap, not the exit code, is the reason given');
});

test('a run interrupted by a companion restart is shown as not audited, with the round note', async t => {
  const w = await makeWorld(t, { hang: true }, { limits: { killGraceMs: 200 } });
  const id = await approvedRoundViaService(w);
  await w.service.launchRound(id);
  await waitFor(async () => (await w.service.getRound(id)).runs[0].state === 'running', { label: 'the pilot to run' });
  await w.service.shutdown();
  /* make the stored round look as it would after a crash: still running, nothing audited */
  const file = path.join(w.roundsDir, id, 'round.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.status = 'running';
  stored.endedAt = null;
  stored.runs = stored.runs.map(run => ({ ...run, state: 'running', audit: null, endedAt: null, failureReason: null }));
  fs.writeFileSync(file, JSON.stringify(stored));
  const restarted = createAgentService({ root: w.projectRoot, env: w.env, claudeBin: STUB, tmpRoot: w.tmpRoot });
  const second = createServer({ root: w.projectRoot, service: restarted, port: 0, log: () => {} });
  const { port } = await second.listen();
  t.after(() => second.shutdown());
  const page = makePage(t, { ...w, port, origin: `http://127.0.0.1:${port}` });
  await page.boot();
  assert.match(page.section('runs'), /Not audited/);
  assert.doesNotMatch(page.section('runs'), /Pending/);
  assert.match(page.section('runs'), /The companion stopped while this round was running/);
  await page.click('open-run', { n: 1 });
  assert.match(page.modal(), /ended before the audit ran, so it was not audited/);
  assert.match(page.modal(), /The companion stopped while this pilot was running\./);
  assert.match(page.modal(), /its files may not have been copied: that folder may not exist/, 'the evidence folder is named, with the reason it may be missing');
  assert.ok(page.modal().includes(`private/agent-rounds/${id}/runs/1/outputs/`));
});

test('the audit section states what the audit cannot see, and says what a note is', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER, toolUses: [{ name: 'Bash', input: { command: 'cd "$SOMEWHERE"; ls' } }] });
  await finishedRoundViaService(w);
  const page = makePage(t, w);
  await page.boot();
  await page.click('open-run', { n: 1 });
  const drawer = page.modal();
  assert.match(drawer, /does not run anything, so a path assembled while a command runs/);
  assert.match(drawer, /cwd-unresolved/);
  assert.match(drawer, /A note never discards a run/);
});

test('a pilot that starts the agent runtime again is discarded, and the page says why and what the spending cap covers', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER, toolUses: [{ name: 'Bash', input: { command: 'claude -p "solve the task in ./filesystem" > outputs/inner.txt' } }] });
  const before = makePage(t, w);
  await before.boot();
  assert.match(before.section('settings'), /The cap applies to each pilot process the Studio starts\. It is not a ceiling on everything a pilot can start/);
  await finishedRoundViaService(w);
  const page = makePage(t, w);
  await page.boot();
  assert.match(page.section('runs'), /DISCARDED/);
  await page.click('open-run', { n: 1 });
  const drawer = page.modal();
  assert.match(drawer, /<td data-label="Kind">runtime<\/td>/);
  assert.match(drawer, /<strong>runtime:<\/strong> A tool call started the agent runtime \(the claude program\) again/);
  assert.match(drawer, /no spending cap, and its own tool calls are not audited/);
  assert.match(drawer, /started the agent runtime again \(the causes are listed below\)/);
});

/* ====================================================================== smaller wording and layout items */

test('the packet card says where files land and warns about a nested filesystem folder', async t => {
  const w = await makeWorld(t);
  const page = makePage(t, w);
  await page.boot();
  assert.match(page.section('packet'), /<code>\.\/filesystem\/<\/code>/);
  await page.type('dir', { value: w.source });
  await page.click('inspect');
  assert.doesNotMatch(page.section('packet'), /already holds a filesystem\/ folder/);

  const nested = await makeWorld(t);
  nested.put('filesystem/brief.txt', 'synthetic');
  const nestedPage = makePage(t, nested);
  await nestedPage.boot();
  await nestedPage.type('dir', { value: nested.source });
  await nestedPage.click('inspect');
  assert.match(nestedPage.section('packet'), /already holds a filesystem\/ folder/);
  assert.match(nestedPage.section('packet'), /\.\/filesystem\/filesystem\//);
});

test('the simulated grader button says what it needs, and the footer text of the runs card is not a dead end', async t => {
  const w = await makeWorld(t);
  const page = makePage(t, w);
  await page.boot();
  assert.equal(page.enabled('open-grader'), false);
  assert.match(page.section('runs'), /needs a completed pilot with a clean audit/);
});

/* ====================================================================== the two editions say different things about models */

function runEdition(location) {
  const store = new Map();
  const fake = () => ({
    innerHTML: '', textContent: '', className: '', dataset: {}, style: {}, hidden: false, value: '', checked: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, setAttribute() {}, getAttribute: () => null, append() {}, remove() {}, focus() {},
    click() {}, closest: () => null, contains: () => false, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, scrollIntoView() {},
    setSelectionRange() {},
  });
  const document = {
    activeElement: null, hidden: false, title: '',
    querySelector: selector => { if (!store.has(selector)) store.set(selector, fake()); return store.get(selector); },
    querySelectorAll: () => [], addEventListener() {}, createElement: fake, body: fake(), documentElement: fake(),
  };
  const context = vm.createContext({
    document, location, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, URL, Blob, TextEncoder, TextDecoder, performance,
    structuredClone, crypto: require('node:crypto').webcrypto, navigator: {}, CSS: { escape: String }, alert() {}, addEventListener() {}, scrollTo() {},
    requestAnimationFrame: () => 0, fetch: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  context.window = context;
  const index = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const names = [...index.matchAll(/<script defer src="([^"]+)"><\/script>/g)].map(match => match[1]);
  for (const name of names) vm.runInContext(fs.readFileSync(path.join(REPO, name), 'utf8'), context, { filename: name });
  return { dashboard: document.querySelector('#dashboard-app').innerHTML, editor: document.querySelector('#app').innerHTML };
}

test('copy about models and accounts depends on the edition: offline from disk, approval-gated when served by the companion', () => {
  const offline = runEdition({ protocol: 'file:', hostname: '' });
  const served = runEdition({ protocol: 'http:', hostname: '127.0.0.1' });
  assert.match(offline.dashboard, /No account or model needed\./);
  assert.match(offline.dashboard, /Sources stay in this browser unless you explicitly export them\./);
  assert.match(offline.editor, /Offline by design/);
  assert.match(offline.editor, /No accounts, keys, or model calls\./);

  for (const phrase of ['No account or model needed', 'Sources stay in this browser', 'Offline by design', 'No accounts, keys, or model calls']) {
    assert.ok(!served.dashboard.includes(phrase), `served dashboard must not say "${phrase}"`);
    assert.ok(!served.editor.includes(phrase), `served editor must not say "${phrase}"`);
  }
  assert.match(served.dashboard, /No model runs until you approve a round or a review\. The claude program then sends the files you approved to Anthropic\./);
  assert.match(served.dashboard, /Sources stay on this computer\. A model run you approve sends only the files and text approved for that run to Anthropic\./);
  assert.match(served.editor, /Local by design/);
  assert.match(served.editor, /Agent runs are on the Agents page, after your approval\./);
});

/* ====================================================================== round speed: settings, one wave, carry forward */

const runningCount = round => round.runs.filter(run => run.state === 'running').length;

test('model, effort, pilots and the spending cap sit above the freeze; five pilots by default; the freeze fixes them', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER });
  const page = makePage(t, w);
  await page.boot();
  const root = page.elements.get('ag-root').innerHTML;
  assert.ok(root.indexOf('id="ag-settings"') > 0 && root.indexOf('id="ag-settings"') < root.indexOf('id="ag-freeze"'), 'the settings card comes before the freeze card');
  const settings = page.section('settings');
  for (const control of ['data-ag-in="model"', 'data-ag-in="effort"', 'id="ag-count"', 'id="ag-atonce"', 'id="ag-budget"']) assert.ok(settings.includes(control), control);
  assert.doesNotMatch(page.section('round'), /data-ag-in="model"|id="ag-count"/, 'the round card no longer holds the settings');
  assert.match(settings, /id="ag-count"[^>]*value="5"/, 'five pilots by default');
  assert.match(settings, /All 5 at once/);
  assert.match(page.text(), /Round maximum spend USD 15\.00 \(5 × USD 3\.00\)/);
  await page.type('count', { value: '9', event: 'change' });
  assert.match(page.section('settings'), /id="ag-count"[^>]*value="5"/, 'capped at the companion maximum');

  /* a cap the companion would refuse stops the freeze in the page, and nothing is created */
  await page.type('budget', { value: '0.01' });
  assert.match(page.elements.get('ag-budget-error').textContent, /must be a number of US dollars from 0\.05 to 20\.00/);
  assert.match(page.elements.get('ag-roundmax').textContent, /Not set/);
  await page.fillAndFreeze();
  assert.match(page.html(), /Set the spending cap per pilot/);
  assert.deepEqual(await w.service.listRounds(), []);

  await page.type('budget', { value: '1.25' });
  await page.type('atonce', { value: '2' });
  assert.match(page.text(), /Round maximum spend USD 6\.25 \(5 × USD 1\.25\)/);
  await page.click('freeze');
  const [row] = await w.service.listRounds();
  assert.deepEqual({ count: row.config.count, concurrency: row.config.concurrency, maxBudgetUsd: row.config.maxBudgetUsd }, { count: 5, concurrency: 2, maxBudgetUsd: 1.25 });
  assert.match(page.section('round'), /2 at a time, 3 waves/);
  assert.match(page.section('round'), /USD 1\.25 \(--max-budget-usd 1\.25\)/);
  assert.match(page.section('round'), /Round maximum spend<\/dt><dd>USD 6\.25/);
  assert.equal(page.enabled('open-approve'), true);
  await page.type('budget', { value: '1.50' });
  assert.equal(page.enabled('open-approve'), false, 'a changed cap makes the freeze stale');
  assert.match(page.html(), /changed after the freeze/);
});

test('approval shows the cap per pilot, the round maximum and one wave; five pilots then run at once; the strip and the title count them', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER, delayMs: 1200 });
  const page = makePage(t, w);
  await page.boot();
  assert.equal(page.document.title, 'Finance Task Studio');
  assert.match(page.section('strip'), /No round selected/);
  await page.fillAndFreeze();
  await page.click('open-approve');
  const dialog = page.text();
  assert.match(dialog, /Claude Code is ready\./, 'the pre-flight ran before the dialog opened');
  assert.match(dialog, /Spending cap per pilot USD 3\.00 \(--max-budget-usd 3\.00\)/);
  assert.match(dialog, /Round maximum spend USD 15\.00 \(5 × USD 3\.00\) The cap applies to each pilot process the Studio starts\. It is not a ceiling on everything a pilot can start/);
  assert.match(dialog, /all 5 at once, one wave/);
  assert.match(page.modal(), /--max-budget-usd 3\.00/, 'the command line carries the cap');
  assert.match(page.modal(), /Pilots times cap: USD 15\.00 for the pilot processes the Studio starts/, 'and so does the text the approval covers');
  assert.match(page.modal(), /not a ceiling on everything a pilot can start/, 'which says what the cap does not cover');
  await page.acknowledgeAll();
  await page.click('approve-launch');
  assert.equal(page.modal().trim(), '');
  const id = (await w.service.listRounds())[0].id;
  let most = 0;
  await waitFor(async () => {
    const round = await w.service.getRound(id);
    most = Math.max(most, runningCount(round));
    return round.status !== 'running';
  }, { label: 'the round to end', interval: 20 });
  assert.equal(most, 5, 'all five pilots ran together');
  assert.match(page.status(), /all 5 at once, one wave/);
  assert.match(page.document.title, /^\(\d\/5\) Agents · Finance Task Studio$/, 'the title counts the pilots');
  await waitFor(() => page.document.title === '(5/5) Agents · Finance Task Studio', { label: 'the title to count all five', timeout: 10000 });
  assert.match(page.section('strip'), new RegExp(`Round ${id}`));
  assert.match(page.section('strip'), /Pilots 5: done 5 · running 0 · failed 0/);
  assert.match(page.section('strip'), /Elapsed \d+m \d\ds/);
  page.agents.afterRender(false);
  assert.equal(page.document.title, 'Finance Task Studio', 'leaving the page restores the title');
});

test('a pre-flight problem is named in the approval dialog before anything is approved, and Check again clears it', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER }, { env: { FINANCE_STUB_AUTH: 'logged-out' } });
  const page = makePage(t, w);
  await page.boot();
  await page.fillAndFreeze();
  await page.click('open-approve');
  assert.match(page.modal(), /Fix this before you approve\./);
  assert.match(page.modal(), /not signed in/);
  await page.acknowledgeAll();
  assert.equal(page.enabled('approve-launch'), false, 'approval waits for a passing check');
  assert.match(page.section('gate'), /Claude Code is not ready for this round\./);
  const round = (await w.service.listRounds())[0];
  assert.equal(round.status, 'frozen', 'nothing was approved');
  w.env.FINANCE_STUB_AUTH = 'ok';
  await page.click('recheck-preflight');
  assert.match(page.modal(), /Claude Code is ready\./);
  assert.equal(page.enabled('approve-launch'), true);
  assert.doesNotMatch(page.section('gate'), /not ready/);

  const older = await makeWorld(t, { resultText: GOLD_ANSWER }, { env: { FINANCE_STUB_HELP_DROP: '--max-budget-usd' } });
  const olderPage = makePage(t, older);
  await olderPage.boot();
  await olderPage.fillAndFreeze();
  await olderPage.click('open-approve');
  assert.match(olderPage.modal(), /does not list --max-budget-usd/);
  await olderPage.acknowledgeAll();
  assert.equal(olderPage.enabled('approve-launch'), false);
});

test('the simulated grader and the author review are disabled while any round runs, with the reason, and come back after it', async t => {
  const w = await makeWorld(t, [{ resultText: GOLD_ANSWER }, { hang: true }], { limits: { killGraceMs: 200 } });
  const pkg = { documents: [{ name: 'Facility_Terms.txt', role: 'source', sha256: 'a'.repeat(64), records: [{ locator: 'line 1', text: 'synthetic' }] }] };
  const page = makePage(t, w, { pkg });
  await page.boot();
  await page.type('count', { value: '2', event: 'change' });
  await page.fillAndFreeze();
  await page.click('open-approve');
  await page.acknowledgeAll();
  await page.click('approve-launch');
  const id = (await w.service.listRounds())[0].id;
  await waitFor(async () => (await w.service.getRound(id)).runs[0].state === 'completed', { label: 'pilot 1 to complete' });
  await waitFor(() => /<td data-label="State"><span class="pill green">completed<\/span>/.test(page.section('runs')), { label: 'the page to show pilot 1 completed', timeout: 10000 });
  assert.match(page.section('runs'), /<td data-label="Audit"><span class="pill green">CLEAN<\/span>/, 'a clean, completed run that a grader could use');
  assert.equal(page.enabled('open-grader'), false, 'the grader waits although a clean run exists');
  assert.equal(page.enabled('open-review'), false, 'the review waits although a package is loaded');
  assert.match(page.section('runs'), /their text would be on a command line that a running pilot can read/);
  assert.equal(page.enabled('next-round'), false);
  assert.match(page.section('runs'), /Start the next round when it has ended/);

  await w.service.cancelRound(id);
  await w.service.whenSettled(id);
  await waitFor(() => page.enabled('open-grader') && page.enabled('open-review'), { label: 'the buttons to come back', timeout: 10000 });
  assert.doesNotMatch(page.section('runs'), /their text would be on a command line/);
});

test('while another round runs, a finished run keeps its answer hidden and cannot be classified; it comes back when that round ends', async t => {
  const w = await makeWorld(t, [{ resultText: GOLD_ANSWER }, { hang: true }], { limits: { killGraceMs: 200 } });
  const finished = await finishedRoundViaService(w);
  const page = makePage(t, w);
  await page.boot();
  const running = await approvedRoundViaService(w, { config: { model: 'claude-opus-5-5', effort: 'medium', count: 2 } });
  await w.service.launchRound(running);
  await waitFor(async () => (await w.service.getRound(running)).runs[1].state === 'running', { label: 'pilot 2 to run' });
  await page.type('select-round', { value: finished, event: 'change' });
  await page.click('open-run', { n: 1 });
  assert.match(page.modal(), /Hidden while a round is running/);
  assert.ok(!page.modal().includes(GOLD_ANSWER), 'the answer is not shown');
  assert.match(page.modal(), /Where the output is/, 'where the files are is not secret: the folders and the count stay');
  assert.ok(page.modal().includes(`private/agent-rounds/${finished}/runs/1/outputs/`));
  assert.match(page.modal(), /Output files<\/dt><dd>0<\/dd>/);
  assert.equal(page.enabled('save-class'), false);
  assert.match(page.modal(), /Classification waits until no round is running/);
  await w.service.cancelRound(running);
  await w.service.whenSettled(running);
  await waitFor(() => page.modal().includes(GOLD_ANSWER), { label: 'the drawer to read the run again', timeout: 10000 });
  assert.doesNotMatch(page.modal(), /Hidden while a round is running/);
});

test('start next round from this round: a new draft with carriedFrom fills the form; freezing it confirms the same content hash; it still needs its own approval', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER });
  const page = makePage(t, w);
  await page.boot();
  await page.type('count', { value: '1', event: 'change' });
  await page.type('budget', { value: '0.75' });
  await page.fillAndFreeze();
  await page.click('open-approve');
  await page.acknowledgeAll();
  await page.click('approve-launch');
  const first = (await w.service.listRounds())[0].id;
  await w.service.whenSettled(first);
  await waitFor(() => page.enabled('next-round'), { label: 'the next-round button', timeout: 10000 });
  const firstRound = await w.service.getRound(first);

  /* the page is cleared, so everything that comes back comes from the companion */
  await page.click('clear-draft');
  assert.ok(!page.section('packet').includes(PROMPT));
  await page.click('next-round');
  const rows = await w.service.listRounds();
  assert.equal(rows.length, 2);
  const next = rows.find(row => row.id !== first);
  assert.equal(next.status, 'draft');
  assert.equal(next.carriedFrom, first);
  assert.match(page.status(), new RegExp(`Round ${next.id} starts from round ${first}`));
  assert.ok(page.section('packet').includes(PROMPT), 'the prompt is back in the form');
  assert.match(page.section('packet'), /2 of 2 files included/);
  assert.match(page.section('settings'), /id="ag-budget"[^>]*value="0\.75"/);
  assert.match(page.section('settings'), /id="ag-count"[^>]*value="1"/);
  assert.match(page.section('freeze'), /data-ag-in="decision"[^>]*value="hold"/);
  assert.match(page.section('freeze'), /value="fp-alpha"/);
  assert.match(page.section('freeze-state'), new RegExp(`Carried forward from round ${first}`));
  assert.ok(page.section('freeze-state').includes(firstRound.freeze.contentSha256), 'the earlier content hash');
  assert.match(page.section('freeze-state'), /Not frozen yet/);
  assert.equal(page.enabled('open-approve'), false, 'nothing is approved by carrying forward');

  await page.click('freeze');
  assert.equal((await w.service.listRounds()).length, 2, 'the carried draft itself was frozen');
  const frozen = await w.service.getRound(next.id);
  assert.equal(frozen.status, 'frozen');
  assert.equal(frozen.freeze.contentSha256, firstRound.freeze.contentSha256);
  assert.notEqual(frozen.freeze.sha256, firstRound.freeze.sha256);
  const state = page.section('freeze-state');
  assert.ok(state.includes(frozen.freeze.contentSha256) && state.includes(frozen.freeze.sha256) && state.includes(firstRound.freeze.sha256), 'both hashes of both freezes');
  assert.match(state, /Gold and fingerprints<\/dt><dd>unchanged/);
  assert.match(page.status(), /the gold and fingerprints are unchanged/);
  assert.match(page.section('gate'), /frozen and ready for your approval/);

  /* an edit after that freezes a new round that still names where it came from */
  await page.type('decision', { value: 'hold; defer' });
  await page.click('freeze');
  const third = (await w.service.listRounds()).find(row => ![first, next.id].includes(row.id));
  assert.equal(third.carriedFrom, first);
  assert.match(page.section('freeze-state'), /Gold and fingerprints<\/dt><dd>changed/);
  await page.click('open-approve');
  assert.match(page.text(), new RegExp(`Carried forward from Round ${first}\\. Gold and fingerprints changed`));
  assert.match(page.modal(), new RegExp(`Gold and fingerprints compared with round ${first}: changed`));
});

test('the form is kept in this browser while you work, restored after a reload, removed by Clear draft and by a launch, and never written while a round runs', async t => {
  const w = await makeWorld(t, { hang: true }, { limits: { killGraceMs: 200 } });
  const storage = makeStorage();
  const page = makePage(t, w, { storage });
  await page.boot();
  await page.type('dir', { value: w.source });
  await page.click('inspect');
  await page.type('include', { checked: false, dataset: { i: 0 } });
  await page.type('prompt', { value: PROMPT });
  await page.type('decision', { value: 'hold' });
  await page.type('fig', { value: '1,250', dataset: { kind: 'gfig', i: 0, j: 0, f: 'value' } });
  await page.type('budget', { value: '2.50' });
  await waitFor(() => storage.map.has(DRAFT_KEY), { label: 'the draft to be saved' });
  await sleep(500);
  const saved = JSON.parse(storage.map.get(DRAFT_KEY));
  assert.equal(saved.dir, w.source);
  assert.equal(saved.prompt, PROMPT);
  assert.equal(saved.fz.decision, 'hold');
  assert.equal(saved.fz.figures[0].value, '1,250');
  assert.equal(saved.config.budget, '2.50');
  assert.equal(saved.include.paths.length, 1, 'the include boxes too');
  assert.match(page.section('draft'), /saved in this browser/);

  /* a reload: a new page on the same storage gets the form back, and the include boxes once the folder is listed */
  const again = makePage(t, w, { storage });
  await again.boot();
  assert.match(again.status(), /Restored the form you were working on/);
  assert.ok(again.section('packet').includes(PROMPT));
  assert.match(again.section('freeze'), /data-ag-in="decision"[^>]*value="hold"/);
  assert.match(again.section('settings'), /id="ag-budget"[^>]*value="2\.50"/);
  await again.click('inspect');
  assert.match(again.section('packet'), /1 of 2 files included/);

  /* Clear draft empties the form and the storage */
  await again.click('clear-draft');
  assert.equal(storage.map.has(DRAFT_KEY), false);
  assert.ok(!again.section('packet').includes(PROMPT));
  assert.match(again.status(), /Draft cleared/);

  /* a launch removes the draft, and nothing is written while the round runs */
  await again.type('count', { value: '1', event: 'change' });
  await again.fillAndFreeze();
  await waitFor(() => storage.map.has(DRAFT_KEY), { label: 'the draft to be saved again' });
  await again.click('open-approve');
  await again.acknowledgeAll();
  await again.click('approve-launch');
  assert.equal(storage.map.has(DRAFT_KEY), false, 'the launch removed the draft');
  assert.match(again.status(), /draft saved in this browser was removed/);
  await again.type('prompt', { value: PROMPT + ' Typed while the round runs.' });
  await sleep(700);
  assert.equal(storage.map.has(DRAFT_KEY), false, 'nothing is stored while a round runs');
  assert.match(again.section('draft'), /not saved in this browser until it has ended/);
});

test('blocked or damaged storage never breaks the page', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER });
  const page = makePage(t, w, { storage: makeStorage({ broken: true }) });
  await page.boot();
  await page.fillAndFreeze();
  assert.match(page.status(), /Gold frozen/);
  await sleep(500);
  const damaged = makeStorage();
  damaged.map.set(DRAFT_KEY, '{"v":1,"prompt":42,"fz":{"figures":"x","fingerprints":[null,{"id":7}]},"config":{"count":"9","budget":3},"include":{"dir":5}}');
  const second = makePage(t, w, { storage: damaged });
  await second.boot();
  assert.match(second.section('settings'), /id="ag-count"[^>]*value="5"/);
  assert.match(second.section('settings'), /id="ag-budget"[^>]*value="3\.00"/);
  const notJson = makeStorage();
  notJson.map.set(DRAFT_KEY, '{not json');
  const third = makePage(t, w, { storage: notJson });
  await third.boot();
  assert.doesNotMatch(third.status(), /Restored/);
});

/* ====================================================================== the Task field (metadata for Mission Control) */

const taskRows = async w => (await w.service.listRounds()).map(row => row.task);
const FILE_EDITION = { protocol: 'file:', hostname: '' };

test('the Task field: label, placeholder and suggestions; the task is sent with the round, kept in the draft, and carried forward', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER });
  /* two earlier rounds name tasks (one only differs in case and spacing) and one names none */
  await w.service.createRound(roundBody(w, { task: 'Meridian' }));
  await w.service.createRound(roundBody(w, { task: 'Atlas' }));
  await w.service.createRound(roundBody(w, { task: ' atlas ' }));
  await w.service.createRound(roundBody(w));
  const storage = makeStorage();
  const page = makePage(t, w, { storage });
  await page.boot();
  const settings = page.section('settings');
  assert.match(settings, /<label class="field">Task<input type="text" id="ag-task" data-ag-in="task"[^>]*list="ag-task-list"[^>]*maxlength="120"[^>]*placeholder="Task name, for example Atlas"/);
  const options = [...settings.matchAll(/<option value="([^"]*)"><\/option>/g)].map(match => match[1]).filter(value => !/^claude-|^(low|medium|high|max|xhigh)$/.test(value) && !/^\d+$/.test(value));
  /* which spelling is offered depends on which round came last; there is one per name, in alphabetical order */
  assert.deepEqual(options.map(name => name.toLowerCase()), ['atlas', 'meridian'], 'one suggestion per task name, ignoring case and spaces, in order');
  assert.ok(options.every(name => name === name.trim()), 'no stray spaces in a suggestion');
  assert.match(settings, /id="ag-task-list"/);
  assert.match(settings, /Changing it later does not make the freeze stale/);

  /* typed text, a control character and a very long name are cleaned like the companion cleans them */
  await page.type('task', { value: 'Cobalt' });
  await page.fillAndFreeze();
  const [row] = (await w.service.listRounds()).filter(r => r.task === 'Cobalt');
  assert.ok(row, 'the round was created with the task that was typed');
  assert.equal((await w.service.getRound(row.id)).task, 'Cobalt');
  assert.match(page.section('settings'), /id="ag-task"[^>]*value="Cobalt"/);
  assert.ok(page.section('settings').includes('<option value="Cobalt"></option>'), 'the new task is suggested after the freeze');

  /* the draft keeps the task, and a reload restores it; Clear draft removes it */
  await waitFor(() => storage.map.has(DRAFT_KEY) && JSON.parse(storage.map.get(DRAFT_KEY)).task === 'Cobalt', { label: 'the task in the saved draft' });
  const again = makePage(t, w, { storage });
  await again.boot();
  assert.match(again.section('settings'), /id="ag-task"[^>]*value="Cobalt"/);
  await again.click('clear-draft');
  assert.match(again.section('settings'), /id="ag-task"[^>]*value=""/);
  assert.equal(storage.map.has(DRAFT_KEY), false);

  /* a damaged draft cannot put anything but text there */
  const damaged = makeStorage();
  damaged.map.set(DRAFT_KEY, JSON.stringify({ v: 1, task: { evil: 1 } }));
  const third = makePage(t, w, { storage: damaged });
  await third.boot();
  assert.match(third.section('settings'), /id="ag-task"[^>]*value=""/);
  damaged.map.set(DRAFT_KEY, JSON.stringify({ v: 1, task: 'x'.repeat(500) + '\n' }));
  const fourth = makePage(t, w, { storage: damaged });
  await fourth.boot();
  assert.equal((fourth.section('settings').match(/id="ag-task"[^>]*value="(x*)"/) || [])[1].length, 120, 'a stored task is cut to 120 characters');
});

test('a task with a NUL byte or control characters, or a very long one, is cleaned by the page so the freeze is not refused', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER });
  const page = makePage(t, w);
  await page.boot();
  await page.type('task', { value: '  Atlas\u0000 two\u0007  ' });
  await page.fillAndFreeze();
  assert.match(page.status(), /Gold frozen/, 'a NUL byte would be refused by the companion, so the page cleans it first');
  const [row] = await w.service.listRounds();
  assert.equal(row.task, 'Atlas  two');

  const long = await makeWorld(t, { resultText: GOLD_ANSWER });
  const second = makePage(t, long);
  await second.boot();
  await second.type('task', { value: 'é'.repeat(119) + '\ud83d\ude00\ud83d\ude00' });
  await second.fillAndFreeze();
  assert.match(second.status(), /Gold frozen/);
  const [longRow] = await long.service.listRounds();
  assert.equal(longRow.task, 'é'.repeat(119), 'cut at 120 UTF-16 units without leaving half of an emoji');
  assert.equal([...longRow.task].every(ch => ch.charCodeAt(0) < 0xd800 || ch.charCodeAt(0) > 0xdfff), true);
});

test('the task is metadata: changing it never makes a freeze stale and never reaches the approval; a carried-forward draft keeps it unless it is edited', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER });
  const page = makePage(t, w);
  await page.boot();
  await page.type('task', { value: 'Cobalt' });
  await page.fillAndFreeze();
  const [first] = await w.service.listRounds();
  const hashBefore = (await w.service.approvalSummary(first.id)).summarySha256;
  assert.equal(page.enabled('open-approve'), true);

  await page.type('task', { value: 'Borealis' });
  await page.type('task', { value: '' });
  await page.type('task', { value: 'Meridian\u0007 two' });
  assert.equal(page.enabled('open-approve'), true, 'a task edit does not disable the launch');
  assert.doesNotMatch(page.html(), /changed after the freeze|no longer match the freeze/);
  assert.match(page.section('gate'), /frozen and ready for your approval/);
  assert.equal((await w.service.approvalSummary(first.id)).summarySha256, hashBefore, 'the approval summary does not hold the task');
  assert.deepEqual(await taskRows(w), ['Cobalt'], 'the round keeps the task it was frozen with');
  await page.click('open-approve');
  assert.ok(!page.modal().includes('Meridian') && !page.modal().includes('Cobalt') && !page.modal().includes('Borealis'), 'the approval dialog does not show the task');
  await page.acknowledgeAll();
  await page.click('approve-launch');
  const id = first.id;
  await w.service.whenSettled(id);
  await waitFor(() => page.enabled('next-round'), { label: 'the next-round button', timeout: 10000 });

  /* Start next round: the form takes the round's task. Freezing the draft as it is keeps that round; an edited task makes a new one. */
  await page.click('next-round');
  assert.match(page.section('settings'), /id="ag-task"[^>]*value="Cobalt"/, 'the carried round has the same task');
  const afterNext = await w.service.listRounds();
  assert.equal(afterNext.length, 2);
  const draft = afterNext.find(row => row.id !== id);
  assert.equal(draft.task, 'Cobalt');
  await page.click('freeze');
  assert.equal((await w.service.listRounds()).length, 2, 'the carried draft itself was frozen');

  /* the draft that was just frozen is not stale after a task edit either */
  await page.type('task', { value: 'Borealis' });
  assert.equal(page.enabled('open-approve'), true, 'still no staleness');
  assert.doesNotMatch(page.html(), /changed after the freeze|no longer match the freeze/);
});

test('a carried-forward draft with an edited task is not frozen as it is: a round with the typed task is made, carried from the same round; a cleared field means no task', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER });
  const page = makePage(t, w);
  await page.boot();
  await page.type('task', { value: 'Cobalt' });
  await page.type('count', { value: '1', event: 'change' });
  await page.fillAndFreeze();
  await page.click('open-approve');
  await page.acknowledgeAll();
  await page.click('approve-launch');
  const first = (await w.service.listRounds())[0].id;
  await w.service.whenSettled(first);
  await waitFor(() => page.enabled('next-round'), { label: 'the next-round button', timeout: 10000 });
  await page.click('next-round');
  const draft = (await w.service.listRounds()).find(row => row.id !== first);
  assert.equal(draft.task, 'Cobalt');

  await page.type('task', { value: 'Borealis' });
  await page.click('freeze');
  const rows = await w.service.listRounds();
  assert.equal(rows.length, 3, 'a new round, because the draft holds another task');
  const made = rows.find(row => ![first, draft.id].includes(row.id));
  assert.equal(made.task, 'Borealis');
  assert.equal(made.carriedFrom, first);
  assert.equal(made.status, 'frozen');
  assert.equal(rows.find(row => row.id === draft.id).status, 'draft', 'the earlier draft is left alone');

  /* an empty field is an explicit "no task": the companion does not fill it in from the round it was carried from */
  await page.type('task', { value: '   ' });
  await page.type('prompt', { value: PROMPT + ' Another reading.' });
  await page.click('freeze');
  const latest = (await w.service.listRounds()).find(row => ![first, draft.id, made.id].includes(row.id));
  assert.ok(latest, 'a fourth round');
  assert.equal(latest.task, '');
  assert.equal(latest.carriedFrom, first);
});

test('versions from the project in the task editor reach the round; labels the companion would refuse are left out instead of failing the freeze', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER });
  const good = { getProject: () => ({ versions: { prompt: 'p-2', workbook: ' w-3 ', evaluator: 'e-1' } }) };
  const withLabels = makePage(t, w, { authoring: good });
  await withLabels.boot();
  await withLabels.fillAndFreeze();
  const [row] = await w.service.listRounds();
  assert.deepEqual((await w.service.getRound(row.id)).versions, { prompt: 'p-2', workbook: 'w-3', evaluator: 'e-1' });
  assert.ok(withLabels.requests.some(request => request.method === 'POST' && request.url === '/api/agents/rounds'));

  for (const versions of [{ prompt: 'p', workbook: '', evaluator: 'e' }, { prompt: 'p', workbook: 'w' }, { prompt: 'p', workbook: 'w', evaluator: 'x'.repeat(201) }, { prompt: 'p', workbook: 'w', evaluator: 'bad\u0000' }, { prompt: 'p', workbook: 'w', evaluator: 5 }, null]) {
    const w2 = await makeWorld(t, { resultText: GOLD_ANSWER });
    const page = makePage(t, w2, { authoring: { getProject: () => ({ versions }) } });
    await page.boot();
    await page.fillAndFreeze();
    assert.match(page.status(), /Gold frozen/, 'the freeze went through: ' + JSON.stringify(versions));
    const [only] = await w2.service.listRounds();
    assert.equal((await w2.service.getRound(only.id)).versions, null);
  }
  /* a task editor that throws is the same as none */
  const w3 = await makeWorld(t, { resultText: GOLD_ANSWER });
  const broken = makePage(t, w3, { authoring: { getProject: () => { throw new Error('synthetic'); } } });
  await broken.boot();
  await broken.fillAndFreeze();
  assert.match(broken.status(), /Gold frozen/);
});

/* ====================================================================== what other views may call: link, get, post */

/* The page's Error class belongs to its own vm context, so errors are checked by shape, not by instanceof. */
const failsWith = (status, pattern) => error => {
  assert.equal(typeof error.message, 'string');
  assert.equal(error.status, status, `status of: ${error.message}`);
  if (pattern) assert.match(error.message, pattern);
  return true;
};

test('the file edition makes no request at all: link says local false, and get, post, openRun and openRound do nothing on the network', async t => {
  const w = await makeWorld(t);
  const page = makePage(t, w, { location: FILE_EDITION });
  const { agents } = page;
  assert.deepEqual(Object.keys(agents).sort(), ['afterRender', 'get', 'handleEvent', 'link', 'offlineMessage', 'openRound', 'openRun', 'post', 'render']);
  assert.deepEqual({ ...(await agents.link()) }, { local: false, ok: false, offlineMessage: 'Local agents need the companion: run npm start.', error: '' });
  assert.equal(agents.offlineMessage, 'Local agents need the companion: run npm start.');
  await assert.rejects(agents.get('/api/status'), failsWith(0, /Local agents need the companion: run npm start\./));
  await assert.rejects(agents.post('/api/agents/rounds', {}), failsWith(0, /run npm start/));
  assert.deepEqual({ ...(await agents.openRun('rnd-aaaaaaaaaaaa', 1)) }, { recorded: false, applied: false });
  assert.deepEqual({ ...(await agents.openRound('rnd-aaaaaaaaaaaa', 'freeze')) }, { recorded: false, applied: false });
  /* the view itself still shows only the offline message, and a later mount applies nothing */
  const markup = agents.render({ package: null, notify() {}, download() {} });
  agents.afterRender(true);
  await page.settle();
  assert.equal(page.requests.length, 0, 'not one request from the file edition');
  assert.match(markup, /Local agents need the companion: run <code>npm start<\/code>/);
  assert.doesNotMatch(markup, /<button|<input/, 'no controls');
});

test('link loads /api/status once for the nonce; two callers share one request; an unreachable companion is reported, not thrown', async t => {
  const w = await makeWorld(t);
  const page = makePage(t, w);
  const [a, b] = await Promise.all([page.agents.link(), page.agents.link()]);
  assert.deepEqual({ ...a }, { local: true, ok: true, offlineMessage: 'Local agents need the companion: run npm start.', error: '' });
  assert.deepEqual({ ...b }, { ...a });
  assert.deepEqual(page.requests.map(r => `${r.method} ${r.url}`), ['GET /api/status'], 'one request for two callers');
  await page.agents.link();
  assert.equal(page.requests.length, 1, 'nothing more once the nonce is held');

  const down = makePage(t, { ...w, origin: 'http://127.0.0.1:1' });
  const result = await down.agents.link();
  assert.equal(result.local, true);
  assert.equal(result.ok, false);
  assert.match(result.error, /could not be reached/);
  await down.agents.link();
  assert.equal(down.requests.length, 2, 'a failure is not remembered: the next call asks again');
  await assert.rejects(down.agents.get('/api/status'), failsWith(0, /could not be reached/));
});

test('get and post use the shared nonce and fail with an Error that carries status and message', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER });
  const page = makePage(t, w);
  const { agents } = page;
  const status = await agents.get('/api/status');
  assert.ok(status.agents && typeof status.nonce === 'string' && status.nonce);
  assert.equal(page.requests[0].nonce, undefined, 'a read carries no nonce');

  const listing = await agents.post('/api/agents/packet/inspect', { sourceDir: w.source });
  assert.ok(Array.isArray(listing.files) && listing.files.length === 2);
  const posted = page.requests.find(r => r.method === 'POST');
  assert.equal(posted.nonce, status.nonce, 'a post carries the nonce');
  /* the explicit read above is one request for /api/status; the post loaded the nonce with one more, and no later call asks again */
  assert.equal(page.requests.filter(r => r.url === '/api/status').length, 2);

  await assert.rejects(agents.post('/api/agents/packet/inspect', { sourceDir: path.join(w.base, 'nowhere') }), error => {
    assert.ok(error.status >= 400 && error.status < 500, 'a status from the companion: ' + error.status);
    assert.ok(error.message.length > 0 && !/refused the request/.test(error.message), 'the companion\'s own message: ' + error.message);
    return true;
  });
  await assert.rejects(agents.get('/api/agents/rounds/rnd-000000000000'), error => error.status === 404 && typeof error.message === 'string' && error.message.length > 0);
  await assert.rejects(agents.post('/api/agents/rounds/rnd-000000000000/freeze'), error => error.status === 404);
  const rounds = await agents.get('/api/agents/rounds?limit=1');
  assert.ok(Array.isArray(rounds.rounds));

  /* a post with no body sends an empty object, and a repeated read never needs the nonce again */
  const before = page.requests.length;
  await assert.rejects(agents.post('/api/agents/rounds'), error => error.status === 400);
  assert.equal(page.requests.length, before + 1);

  /* the new feed and log routes are reachable with a query string */
  const id = await finishedRoundViaService(w, { task: 'Atlas' });
  const feed = await agents.get('/api/agents/runs?limit=5&task=' + encodeURIComponent('Atlas'));
  assert.equal(feed.runs.length, 1);
  assert.equal(feed.runs[0].roundId, id);
  const log = await agents.get(`/api/agents/rounds/${id}/runs/1/log?after=0&limit=50`);
  assert.ok(Array.isArray(log.lines) && log.done === true);
});

test('get and post refuse anything that is not a plain path under /api/, before any request is made', async t => {
  const w = await makeWorld(t);
  const page = makePage(t, w);
  const bad = ['http://127.0.0.1/api/status', '//evil.example/api/status', 'https://evil.example/api/x', '/status', '/api', 'api/status', '/api/../status', '/api/rounds/../../x',
    '/api/%2e%2e/x', '/api/a/%2E%2E', '/api/a%2f..%2fb', '/api/a%5c..', '/api/x#fragment', '/api/x y', '/api/x\u0000', '/api/é', '/api/x\\y', '/api/%zz', '/API/status', '/api/' + 'a'.repeat(3000),
    '', 42, null, undefined, {}, ['/api/status'], 'javascript:alert(1)', 'data:text/plain,x'];
  for (const path of bad) {
    await assert.rejects(page.agents.get(path), failsWith(400, /Only paths under \/api\//), 'get ' + String(path).slice(0, 40));
    await assert.rejects(page.agents.post(path, {}), failsWith(400, /Only paths under \/api\//), 'post ' + String(path).slice(0, 40));
  }
  assert.equal(page.requests.length, 0, 'nothing was requested');
  /* a query with a slash, equals signs and escapes passes the guard: the companion, not the page, judges its values */
  const refused = await page.agents.get('/api/agents/runs?limit=3&task=a%20b&round=x/y').catch(error => error);
  assert.equal(refused.status, 400);
  assert.match(refused.message, /round id/);
  assert.equal(page.requests.length, 1, 'that one went out');
});

/* ====================================================================== openRun and openRound: a request that waits for the view */

const STEP_IDS = ['runtime', 'packet', 'settings', 'freeze', 'round', 'runs'];
const twoRounds = async w => {
  const older = await finishedRoundViaService(w, { label: 'older round', config: { model: 'claude-opus-5-5', effort: 'medium', count: 2 } });
  await sleep(20);
  const newer = await finishedRoundViaService(w, { label: 'newer round' });
  return { older, newer };
};
const selectedRound = page => (page.section('strip').match(/Round (rnd-[0-9a-f]+)/) || [])[1];

test('openRun before the Agents view is mounted selects that round and opens that pilot once the view is ready', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER });
  const { older, newer } = await twoRounds(w);
  const page = makePage(t, w);
  assert.deepEqual({ ...(await page.agents.openRun(older, 2)) }, { recorded: true, applied: false });
  assert.equal(page.requests.length, 0, 'recording a request asks the companion nothing');
  await page.boot();
  await waitFor(() => /Pilot 2 · completed/.test(page.modal()), { label: 'the drawer of pilot 2' });
  assert.equal(selectedRound(page), older, 'the older round is selected, not the newest one');
  assert.notEqual(older, newer);
  assert.match(page.section('runs'), new RegExp(`<option value="${older}" selected>`));
  assert.match(page.modal(), /Where the output is/);
  assert.match(page.modal(), /<h2 id="ag-dialog-title">Pilot 2 · completed<\/h2>/);
  /* it is applied once: a later mount does not open it again */
  await page.click('close-overlay');
  page.agents.afterRender(false);
  page.agents.afterRender(true);
  await page.settle();
  assert.equal(page.modal().trim(), '');
});

test('openRun while the view is still starting, and while it is showing, applies the request', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER });
  const { older, newer } = await twoRounds(w);
  const page = makePage(t, w);
  page.agents.render({ package: null, notify() {}, download() {} });
  page.agents.afterRender(true);
  assert.deepEqual({ ...(await page.agents.openRun(older, 1)) }, { recorded: true, applied: false }, 'the page is still checking for the companion');
  await waitFor(() => /Pilot 1 · completed/.test(page.modal()), { label: 'the drawer after the start' });
  assert.equal(selectedRound(page), older);

  /* showing now: the answer says it was applied, and the drawer for another round replaces the one that was open */
  assert.deepEqual({ ...(await page.agents.openRun(newer, 1)) }, { recorded: true, applied: true });
  await page.settle();
  assert.equal(selectedRound(page), newer);
  assert.match(page.modal(), /Pilot 1 · completed/);
  assert.ok(page.modal().includes(evidenceOf(newer, 1)), 'the drawer shows the newer round\'s evidence folder');
  assert.ok(!page.modal().includes(evidenceOf(older, 1)));

  /* openRound selects without opening a drawer, and closes the one that is open */
  assert.deepEqual({ ...(await page.agents.openRound(older)) }, { recorded: true, applied: true });
  assert.equal(selectedRound(page), older);
  assert.equal(page.modal().trim(), '');
});

const evidenceOf = (id, n) => `private/agent-rounds/${id}/runs/${n}/outputs/`;

test('openRound scrolls to the step it names, and ignores a step it does not know', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER });
  const { older } = await twoRounds(w);
  const page = makePage(t, w);
  const hits = [];
  for (const step of STEP_IDS) page.element('ag-' + step).scrollIntoView = () => hits.push(step);
  await page.boot();
  hits.length = 0;
  for (const step of STEP_IDS) {
    assert.deepEqual({ ...(await page.agents.openRound(older, step)) }, { recorded: true, applied: true }, step);
    assert.equal(selectedRound(page), older);
  }
  assert.deepEqual(hits, STEP_IDS, 'one scroll per step, to that step');
  hits.length = 0;
  await page.agents.openRound(older, 'nonsense');
  await page.agents.openRound(older);
  await page.agents.openRound(older, '__proto__');
  assert.deepEqual(hits, [], 'an unknown or missing step scrolls nowhere');
  assert.equal(page.status().includes('not valid'), false);

  /* recorded before the mount, applied at the mount */
  const fresh = makePage(t, w);
  const mounted = [];
  fresh.element('ag-freeze').scrollIntoView = () => mounted.push('freeze');
  await fresh.agents.openRound(older, 'freeze');
  await fresh.boot();
  await waitFor(() => mounted.length > 0, { label: 'the scroll after the mount' });
  assert.equal(selectedRound(fresh), older);
  assert.equal(fresh.modal().trim(), '');
});

test('a round or pilot that is not there is reported in the status line, never thrown; a bad argument is too', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER });
  const { older, newer } = await twoRounds(w);
  const page = makePage(t, w);
  await page.boot();
  assert.equal(selectedRound(page), newer);

  /* the round exists, the pilot does not: the round is shown with its runs, and the notice names the pilots it has */
  assert.deepEqual({ ...(await page.agents.openRun(older, 7)) }, { recorded: true, applied: false });
  assert.match(page.status(), /Round rnd-[0-9a-f]+ has no pilot 7\. Its pilots are 1, 2\./);
  assert.ok(page.status().includes(older));
  assert.equal(selectedRound(page), older);
  assert.equal(page.modal().trim(), '');

  /* a drawer that is open is closed by a request that cannot be honoured, so the notice is not hidden behind it */
  await page.click('open-run', { n: 1 });
  assert.match(page.modal(), /Pilot 1/);
  await page.agents.openRun(older, 9);
  assert.equal(page.modal().trim(), '');
  assert.match(page.status(), /no pilot 9/);

  /* the round does not exist: the selection stays where it was */
  const ghost = 'rnd-000000000000';
  assert.deepEqual({ ...(await page.agents.openRun(ghost, 1)) }, { recorded: true, applied: false });
  assert.match(page.status(), /was not found on this companion/);
  assert.ok(page.status().includes(ghost));
  assert.equal(selectedRound(page), older, 'the earlier selection is kept');
  assert.deepEqual({ ...(await page.agents.openRound(ghost, 'freeze')) }, { recorded: true, applied: false });
  assert.match(page.status(), /was not found/);

  /* a round that has no pilots yet */
  const draft = await w.service.createRound(roundBody(w));
  await page.agents.openRun(draft.id, 1);
  assert.match(page.status(), /has not started any pilots, so there is no pilot 1 to open/);

  for (const [args, pattern] of [[['bad id', 1], /round id is not valid/], [[null, 1], /round id is not valid/], [[older, 0], /pilot number is not valid/], [[older, 100], /pilot number is not valid/],
    [[older, 1.5], /pilot number is not valid/], [[older, 'x'], /pilot number is not valid/], [[older, undefined], /pilot number is not valid/], [[older, '2; drop'], /pilot number is not valid/]]) {
    const result = await page.agents.openRun(...args);
    assert.deepEqual({ ...result }, { recorded: true, applied: false }, JSON.stringify(args));
    assert.match(page.status(), pattern, JSON.stringify(args));
    assert.equal(page.modal().trim(), '');
  }
  assert.deepEqual({ ...(await page.agents.openRound('../../x', 'freeze')) }, { recorded: true, applied: false });
  assert.match(page.status(), /round id is not valid/);
  /* nothing but GETs of rounds went out for all of that */
  assert.ok(page.requests.every(r => r.method === 'GET'), 'a request from another view never changes anything');
});

test('a newer request replaces an older one that has not been applied, and one nobody followed up is dropped after two minutes', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER });
  const { older, newer } = await twoRounds(w);
  const page = makePage(t, w);
  const froze = [];
  page.element('ag-freeze').scrollIntoView = () => froze.push(1);
  await page.agents.openRun(older, 1);
  await page.agents.openRound(newer, 'freeze');
  await page.boot();
  await waitFor(() => froze.length > 0, { label: 'the second request' });
  assert.equal(selectedRound(page), newer);
  assert.equal(page.modal().trim(), '', 'the first request was replaced, so no drawer');

  const late = makePage(t, w);
  await late.agents.openRun(older, 1);
  const ContextDate = vm.runInContext('Date', late.context);
  const real = ContextDate.now;
  ContextDate.now = () => real() + 3 * 60 * 1000;
  await late.boot();
  await sleep(300);
  assert.equal(late.modal().trim(), '', 'a request three minutes old is not applied');
  assert.equal(selectedRound(late), newer, 'the page chose its usual round');
  assert.doesNotMatch(late.status(), /no pilot|not found|not valid/, 'and says nothing about it');
});

test('leaving the view while a request is being read opens nothing, and a drawer opened by a request is closed by leaving', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER });
  const { older, newer } = await twoRounds(w);
  const page = makePage(t, w);
  await page.boot();
  const pending = page.agents.openRun(older, 2);
  page.agents.afterRender(false);
  assert.deepEqual({ ...(await pending) }, { recorded: true, applied: false });
  await page.settle();
  assert.equal(page.modal().trim(), '', 'no drawer over another view');
  /* and the selection did not move while the view was away: the pilot opened now is the newer round's */
  page.agents.afterRender(true);
  await page.click('open-run', { n: 1 });
  assert.ok(page.modal().includes(evidenceOf(newer, 1)) && !page.modal().includes(evidenceOf(older, 1)), 'the selected round is still the newer one');
  await page.click('close-overlay');

  await page.agents.openRun(older, 2);
  await page.settle();
  assert.match(page.modal(), /Pilot 2/);
  page.agents.afterRender(false);
  assert.equal(page.modal().trim(), '');
  assert.equal(page.document.title, 'Finance Task Studio');
});

/* ====================================================================== the run drawer: where is the output */

const WRITES = [{ path: 'outputs/answer.txt', content: 'hold 1,250\n' }, { path: 'outputs/notes.txt', content: 'second file\n' }];

/* A stand-in for the browser's clipboard and for the older text-area route. */
function makeCopyFakes({ clipboard = 'works', legacy = 'works' } = {}) {
  const copied = [], legacyCopies = [], created = [];
  const fakes = { copied, legacyCopies, created };
  if (clipboard !== 'absent') {
    fakes.navigator = { clipboard: { writeText: async text => { if (clipboard === 'denied') throw new Error('synthetic: permission denied'); copied.push(text); } } };
  }
  if (legacy !== 'absent') {
    fakes.documentExtras = {
      createElement: tag => {
        const area = { tag, value: '', className: '', parentNode: null, selectedValue: null, setAttribute() {}, focus() {}, select() { area.selectedValue = area.value; } };
        created.push(area);
        return area;
      },
      body: { appendChild: el => { el.parentNode = { removeChild: child => { child.parentNode = null; } }; }, ...makeElement('body') },
      execCommand: command => {
        if (legacy === 'throws') throw new Error('synthetic: not allowed');
        legacyCopies.push([command, created[created.length - 1].selectedValue, created[created.length - 1].parentNode !== null]);
        return legacy === 'works';
      },
    };
  }
  return fakes;
}

test('the run drawer says where the output is: the working folder, the evidence folder with a Copy button, and how many files', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER, writeFiles: WRITES });
  const id = await finishedRoundViaService(w);
  const page = makePage(t, w);
  await page.boot();
  await page.click('open-run', { n: 1 });
  const drawer = page.modal();
  assert.match(drawer, /<h3>Where the output is<\/h3>/);
  assert.ok(drawer.includes(`<dt>Working folder</dt><dd><code class="ag-path">finance-studio-pilots/${id}-1</code>`), 'the relative working folder the run row holds');
  assert.ok(drawer.includes(`<code class="ag-path" id="ag-evidence-path">private/agent-rounds/${id}/runs/1/outputs/</code>`));
  assert.match(drawer, /<button type="button" class="small" data-ag="copy-path"[^>]*>Copy path<\/button>/);
  assert.match(drawer, /<dt>Output files<\/dt><dd>2<\/dd>/);
  assert.doesNotMatch(drawer, /Copied to the working copy when the run ends/, 'that line is for a run that has not ended');
  assert.doesNotMatch(drawer, /may not exist/);
  assert.ok(drawer.indexOf('Where the output is') < drawer.indexOf('<h3>Audit</h3>') && drawer.indexOf('Where the output is') < drawer.indexOf('<h3>Outputs</h3>'));
  assert.match(drawer, /<code class="ag-path">answer\.txt<\/code>/, 'the outputs table is still there');
  /* no absolute path anywhere in it: the page is never told one */
  assert.doesNotMatch(drawer, new RegExp(w.tmpRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(drawer, new RegExp(w.projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(page.has('copy-path'), true);
});

test('while a pilot runs, the drawer shows the folders and the line that the files are copied when the run ends', async t => {
  const w = await makeWorld(t, { hang: true }, { limits: { killGraceMs: 200 } });
  const id = await approvedRoundViaService(w);
  await w.service.launchRound(id);
  await waitFor(async () => (await w.service.getRound(id)).runs[0].state === 'running', { label: 'the pilot to run' });
  const page = makePage(t, w);
  await page.boot();
  await page.click('open-run', { n: 1 });
  const drawer = page.modal();
  assert.match(drawer, /<p class="footnote" id="ag-output-note">Copied to the working copy when the run ends<\/p>/);
  assert.match(drawer, /<dt>Output files<\/dt><dd>Counted when the run ends<\/dd>/);
  assert.ok(drawer.includes(`finance-studio-pilots/${id}-1`) && drawer.includes(`private/agent-rounds/${id}/runs/1/outputs/`));
  assert.equal(page.has('copy-path'), true, 'the path can be copied before the run ends');
  await w.service.cancelRound(id);
  await w.service.whenSettled(id);
  await waitFor(() => !/Copied to the working copy when the run ends/.test(page.modal()), { label: 'the line to go once the run has ended', timeout: 10000 });
  assert.match(page.modal(), /<dt>Output files<\/dt><dd>(0|-)<\/dd>/);
});

test('Copy path uses the clipboard; when that is refused or absent it uses a text area; when nothing works it says so and the path stays selectable', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER, writeFiles: WRITES });
  const id = await finishedRoundViaService(w);
  const wanted = `private/agent-rounds/${id}/runs/1/outputs/`;

  const direct = makeCopyFakes();
  const first = makePage(t, w, direct);
  await first.boot();
  await first.click('open-run', { n: 1 });
  await first.click('copy-path');
  assert.deepEqual(direct.copied, [wanted]);
  assert.equal(direct.created.length, 0, 'the text area is not touched when the clipboard works');
  assert.match(first.modal(), /<p class="footnote" id="ag-copy-note" role="status">Copied the evidence folder path to the clipboard\.<\/p>/);
  assert.equal(first.status(), 'Copied the evidence folder path to the clipboard.');

  const denied = makeCopyFakes({ clipboard: 'denied' });
  const second = makePage(t, w, denied);
  await second.boot();
  await second.click('open-run', { n: 1 });
  await second.click('copy-path');
  assert.deepEqual(denied.legacyCopies, [['copy', wanted, true]], 'the fallback selected exactly the path, inside the page');
  assert.equal(denied.created[0].parentNode, null, 'and removed its text area afterwards');
  assert.match(second.modal(), /Copied the evidence folder path/);

  const absent = makeCopyFakes({ clipboard: 'absent' });
  const third = makePage(t, w, absent);
  await third.boot();
  await third.click('open-run', { n: 1 });
  await third.click('copy-path');
  assert.deepEqual(absent.legacyCopies.map(entry => entry[1]), [wanted]);
  assert.match(third.modal(), /Copied the evidence folder path/);

  for (const options of [{ clipboard: 'absent', legacy: 'refuses' }, { clipboard: 'denied', legacy: 'throws' }, { clipboard: 'absent', legacy: 'absent' }, { clipboard: 'denied', legacy: 'absent' }]) {
    const fakes = makeCopyFakes(options);
    const page = makePage(t, w, fakes);
    await page.boot();
    await page.click('open-run', { n: 1 });
    await page.click('copy-path');
    assert.match(page.modal(), /The browser did not allow copying\. Select the path above and copy it yourself\./, JSON.stringify(options));
    assert.ok(page.modal().includes(wanted), 'the path is on screen to be selected');
    assert.doesNotMatch(page.modal(), /Copied the evidence folder path/);
    assert.deepEqual(fakes.copied, []);
    assert.equal(fakes.created.filter(area => area.parentNode).length, 0, 'no text area is left behind');
  }

  /* a page with neither (the test pages of this file) does not throw either */
  const bare = makePage(t, w);
  await bare.boot();
  await bare.click('open-run', { n: 1 });
  await bare.click('copy-path');
  assert.match(bare.modal(), /did not allow copying/);
});

test('closing the drawer while a copy is under way, or opening another pilot, leaves no stale note', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER }, {});
  const id = await finishedRoundViaService(w, { config: { model: 'claude-opus-5-5', effort: 'medium', count: 2 } });
  let release;
  const slow = { navigator: { clipboard: { writeText: () => new Promise(resolve => { release = resolve; }) } } };
  const page = makePage(t, w, slow);
  await page.boot();
  await page.click('open-run', { n: 1 });
  await page.click('copy-path');
  await page.click('close-overlay');
  release();
  await page.settle();
  assert.equal(page.modal().trim(), '', 'the drawer stays closed');
  await page.click('open-run', { n: 2 });
  assert.doesNotMatch(page.modal(), /ag-copy-note/, 'a new drawer starts without a note');
  assert.ok(page.modal().includes(`private/agent-rounds/${id}/runs/2/outputs/`));
});

/* ====================================================================== pill kinds and the single yellow button */

/* Every pill in the markup as [kind, text]: class="pill <kind>">text</span>. */
const pillsIn = markup => [...markup.matchAll(/<span class="pill ([a-z]*)">([^<]*)<\/span>/g)].map(match => [match[1], match[2]]);
const kindsOf = (markup, wanted) => pillsIn(markup).filter(([, text]) => text === wanted).map(([kind]) => kind);

test('pill kinds: one kind per state everywhere; a count of included files and a frozen round are not green', async t => {
  const w = await makeWorld(t, [{ hang: true }, { hang: true }], { limits: { killGraceMs: 200 } });
  const page = makePage(t, w);
  await page.boot();
  await page.type('count', { value: '2', event: 'change' });
  await page.type('atonce', { value: '1' });
  await page.fillAndFreeze();

  /* a frozen round and the files selected for it are labels of a step, not a pass */
  assert.match(page.section('packet'), /<span class="pill violet">2 of 2 files included<\/span>/);
  assert.doesNotMatch(page.section('packet'), /pill green/);
  assert.match(page.section('round'), /<span class="pill violet">Round rnd-[0-9a-f]+ · frozen<\/span>/);
  assert.match(page.section('strip'), /<span class="pill violet">frozen<\/span>/);
  assert.match(page.section('runs'), /<span class="pill violet">frozen<\/span>/);
  assert.match(page.section('packet'), /<span class="pill ">Not inspected<\/span>|<span class="pill violet">/);

  await page.click('open-approve');
  await page.acknowledgeAll();
  await page.click('approve-launch');
  const id = (await w.service.listRounds())[0].id;
  await waitFor(() => /<td data-label="State"><span class="pill violet">running<\/span>/.test(page.section('runs')), { label: 'the pilot to show as running', timeout: 10000 });
  assert.match(page.section('runs'), /<td data-label="State"><span class="pill ">queued<\/span>/, 'a pilot that waits is a plain label');
  assert.deepEqual(kindsOf(page.section('strip'), 'running'), ['violet'], 'the strip and the table agree about running');
  assert.deepEqual(kindsOf(page.section('round'), 'Round ' + id + ' · running'), ['violet']);

  await w.service.cancelRound(id);
  await w.service.whenSettled(id);
  await waitFor(() => /<span class="pill amber">cancelled<\/span>/.test(page.section('strip')) && /<td data-label="State"><span class="pill amber">cancelled<\/span>/.test(page.section('runs')), { label: 'cancelled to show', timeout: 10000 });
  assert.deepEqual(kindsOf(page.section('strip'), 'cancelled'), ['amber']);
  assert.ok(kindsOf(page.section('runs'), 'cancelled').length >= 2 && kindsOf(page.section('runs'), 'cancelled').every(kind => kind === 'amber'), 'the same kind in the card title and in the table');
  await page.click('open-run', { n: 2 });
  assert.deepEqual(kindsOf(page.modal(), 'cancelled'), ['amber'], 'and in the drawer');
});

test('pill kinds: a failed state is red in the strip, the table and the drawer; a finished round and a completed pilot stay green; CLEAN stays green', async t => {
  const w = await makeWorld(t, [{ resultText: '', exitCode: 3, stderr: 'synthetic runtime complaint' }, { resultText: GOLD_ANSWER }]);
  const failedRound = await finishedRoundViaService(w);
  const page = makePage(t, w);
  await page.boot();
  assert.equal((await w.service.getRound(failedRound)).status, 'failed');
  assert.deepEqual(kindsOf(page.section('strip'), 'failed'), ['red']);
  assert.deepEqual(kindsOf(page.section('runs'), 'failed'), ['red', 'red'], 'the card title and the table');
  await page.click('open-run', { n: 1 });
  assert.deepEqual(kindsOf(page.modal(), 'failed'), ['red']);
  await page.click('close-overlay');

  /* pilot 1 fails again and pilot 2 completes, so this round is finished, not failed */
  const ok = await finishedRoundViaService(w, { config: { model: 'claude-opus-5-5', effort: 'medium', count: 2 } });
  await page.type('select-round', { value: ok, event: 'change' });
  assert.equal((await w.service.getRound(ok)).status, 'finished');
  assert.deepEqual(kindsOf(page.section('strip'), 'finished'), ['green']);
  assert.deepEqual(kindsOf(page.section('runs'), 'finished'), ['green']);
  assert.deepEqual(kindsOf(page.section('runs'), 'failed'), ['red'], 'the failed pilot in the same round');
  assert.match(page.section('runs'), /<td data-label="State"><span class="pill green">completed<\/span>/);
  assert.match(page.section('runs'), /<td data-label="Audit"><span class="pill green">CLEAN<\/span>/);
  assert.equal(pillsIn(page.html()).filter(([kind, text]) => kind === 'amber' && /failed|cancelled/.test(text)).length, 0, 'no failed state is amber');

  /* the one place the page kept its plain label: a file held back by the gaf setting */
  const gaf = await makeWorld(t, { resultText: GOLD_ANSWER });
  gaf.put('gaf-hedge.csv', 'a,b\n1,2\n');
  const gafPage = makePage(t, gaf);
  await gafPage.boot();
  await gafPage.type('dir', { value: gaf.source });
  await gafPage.click('inspect');
  await gafPage.type('gaf', { checked: false });
  assert.match(gafPage.section('packet'), /<span class="pill ">Hidden: gaf\/ is off<\/span>/);
});

/* The yellow buttons the page shows at once: the rail, the cards and the status line. The two cards that nest the gate and the
   freeze state hold older copies of them, so they are left out; the dialog is a different layer and has its own. */
const primaries = page => ['ag-rail', 'ag-strip', 'ag-draft', 'ag-runtime', 'ag-packet', 'ag-settings', 'ag-freeze-state', 'ag-gate', 'ag-runs']
  .flatMap(id => [...page.element(id).innerHTML.matchAll(/<button\b[^>]*class="([^"]*)"[^>]*data-ag="([\w-]+)"/g)].filter(match => /(^|\s)primary(\s|$)/.test(match[1])).map(match => match[2]));

test('at most one yellow button is on screen at a time, and it is the one that moves the current step forward', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER, delayMs: 800 });
  const page = makePage(t, w);
  await page.boot();
  assert.deepEqual(primaries(page), ['inspect'], 'a new page: list the folder');

  await page.type('dir', { value: w.source });
  assert.deepEqual(primaries(page), ['inspect']);
  await page.click('inspect');
  assert.deepEqual(primaries(page), ['goto-step'], 'files listed, no prompt yet: the rail points at the packet');
  assert.match(page.section('rail'), /data-step="packet"/);
  await page.type('prompt', { value: PROMPT });
  assert.deepEqual(primaries(page), ['freeze'], 'the packet is done: freeze is next');
  await page.type('decision', { value: 'hold' });
  await page.type('fig', { value: 'Usable cash', dataset: { kind: 'gfig', i: 0, j: 0, f: 'label' } });
  await page.type('fig', { value: '1,250', dataset: { kind: 'gfig', i: 0, j: 0, f: 'value' } });
  await page.click('freeze');
  assert.deepEqual(primaries(page), ['open-approve'], 'frozen: review and approve');
  assert.match(page.section('gate'), /class="primary" data-ag="open-approve"/);
  assert.match(page.section('freeze-state'), /class="" data-ag="freeze"/, 'the freeze button is a plain button now');

  /* a changed prompt makes the freeze stale: freeze again becomes the one */
  await page.type('prompt', { value: PROMPT + ' More.' });
  assert.deepEqual(primaries(page), ['freeze']);
  await page.type('prompt', { value: PROMPT });
  assert.deepEqual(primaries(page), ['open-approve']);

  await page.click('open-approve');
  assert.match(page.modal(), /class="primary" data-ag="approve-launch"/, 'the dialog keeps its own primary');
  await page.acknowledgeAll();
  await page.click('approve-launch');
  assert.deepEqual(primaries(page), ['goto-step'], 'running: the rail');
  await w.service.whenSettled((await w.service.listRounds())[0].id);
  await waitFor(() => primaries(page).length === 0 || primaries(page)[0] !== 'goto-step', { label: 'the runs to finish on the page', timeout: 10000 });
  assert.ok(primaries(page).length <= 1);

  /* the same holds across a reload with a draft, a task and an offline companion note */
  const states = [];
  const again = makePage(t, w, { storage: makeStorage() });
  await again.boot();
  states.push(primaries(again));
  await again.type('task', { value: 'Atlas' });
  states.push(primaries(again));
  await again.click('check-runtime');
  states.push(primaries(again));
  for (const state of states) assert.ok(state.length <= 1, JSON.stringify(state));
});

test('with Claude Code missing the rail, not a card, holds the yellow button', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-page-bin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = await makeWorld(t, { resultText: GOLD_ANSWER }, { claudeBin: path.join(dir, 'claude-wrapper') });
  const page = makePage(t, w);
  await page.boot();
  assert.match(page.section('runtime'), /Claude Code was not found/);
  assert.deepEqual(primaries(page), ['goto-step']);
  assert.match(page.section('rail'), /data-step="runtime"/);
  await page.fillAndFreeze();
  assert.deepEqual(primaries(page), ['goto-step'], 'still the runtime step: nothing else is yellow');
});

test('requests made while the view shows are answered one by one; one replaced before it starts answers applied false; the last one wins', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER });
  const { older, newer } = await twoRounds(w);
  const page = makePage(t, w);
  await page.boot();
  const a = page.agents.openRun(older, 1);
  const b = page.agents.openRun(newer, 1);
  const c = page.agents.openRun(older, 2);
  assert.deepEqual([{ ...(await a) }, { ...(await b) }, { ...(await c) }], [{ recorded: true, applied: true }, { recorded: true, applied: false }, { recorded: true, applied: true }]);
  await page.settle();
  assert.equal(selectedRound(page), older);
  assert.match(page.modal(), /Pilot 2 · completed/);

  /* leaving while one waits behind another: both callers get an answer, and nothing opens over the other view */
  const first = page.agents.openRound(newer, 'freeze');
  const second = page.agents.openRun(newer, 1);
  page.agents.afterRender(false);
  const answers = await Promise.all([first, second]);
  assert.deepEqual(answers.map(answer => ({ ...answer })).map(answer => answer.recorded), [true, true]);
  assert.equal(answers[1].applied, false);
  await page.settle();
  assert.equal(page.modal().trim(), '');
});
