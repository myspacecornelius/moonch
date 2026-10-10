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
  const env = { ...process.env, FINANCE_STUB_SCENARIO: JSON.stringify(scenario), ...(options.env || {}) };
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

function makePage(t, world, { location } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  let inflight = 0;
  const pageFetch = async (url, init = {}) => {
    inflight++;
    try {
      const headers = { ...(init.headers || {}) };
      if (init.method && init.method !== 'GET') headers.Origin = world.origin;
      return await fetch(world.origin + url, { ...init, headers });
    } finally {
      inflight--;
    }
  };
  const document = {
    activeElement: null, hidden: false, body: element('body'),
    querySelector: selector => {
      const match = /^#([\w-]+)$/.exec(selector);
      return match ? element(match[1]) : null;
    },
    addEventListener() {},
  };
  const context = vm.createContext({
    document, fetch: pageFetch, setTimeout, clearTimeout, console, URL, Blob,
    location: location || { protocol: 'http:', hostname: '127.0.0.1' }, CSS: { escape: value => String(value) },
  });
  context.window = context;
  vm.runInContext(AGENTS_SOURCE, context, { filename: 'agents.js' });
  const agents = context.FinanceAgents;
  assert.ok(agents && typeof agents.handleEvent === 'function', 'agents.js exports its handler');
  t.after(() => agents.afterRender(false));

  const all = () => ['ag-runtime', 'ag-packet', 'ag-freeze', 'ag-round', 'ag-runs', 'ag-gate', 'ag-freeze-state', 'agents-modal'].map(id => element(id).innerHTML).join('\n');
  const tagOf = (action, dataset = {}) => {
    const wanted = Object.entries(dataset).map(([key, value]) => `data-${key}="${value}"`);
    const found = [...all().matchAll(/<(?:button|tr)\b[^>]*>/g)].map(match => match[0]).find(tag => tag.includes(`data-ag="${action}"`) && wanted.every(attribute => tag.includes(attribute)));
    return found || null;
  };
  const page = {
    elements,
    agents,
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
      agents.render({ package: null, notify() {}, download() {} });
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
