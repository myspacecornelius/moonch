'use strict';
/* Tests for Mission Control (mission.js) without a browser.

   The real views-kit.js, mission-model.js, workbench-model.js, agents.js and mission.js run inside a vm with a small fake document.
   Their requests go to a real companion (backend/server.cjs) on an ephemeral port, backed by backend/agents/stub-claude.cjs, so no
   model is started and nothing leaves this machine. The page's own handlers are called with the controls found in the markup it
   painted. Rounds are made through the service, one after another (only one round runs at a time): finished rounds for the invented
   tasks Atlas and Meridian (with a DISCARDED pilot and a failed pilot among them), and a running round for Borealis.
   Every fixture is synthetic and lives in temporary folders that are removed afterwards. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { cleanEnv } = require('./fixtures/clean-env.cjs');

const { createServer } = require('../backend/server.cjs');
const { createAgentService } = require('../backend/agents/index.cjs');

const REPO = path.resolve(__dirname, '..');
const STUB = path.join(REPO, 'backend', 'agents', 'stub-claude.cjs');
const SCRIPTS = ['views-kit.js', 'mission-model.js', 'workbench-model.js', 'agents.js', 'mission.js'];
const SOURCES = Object.fromEntries(SCRIPTS.map(name => [name, fs.readFileSync(path.join(REPO, name), 'utf8')]));
const PROMPT = 'Assess the Atlas liquidity position using the supplied records and recommend whether the borrowing can proceed.';
const ACK = ['shell-access', 'network', 'isolation-by-audit'];
const GOLD = {
  gold: { decision: 'hold', figures: [{ label: 'Usable cash', value: '1,250', tolerance: 1 }], notes: 'Synthetic gold notes' },
  fingerprints: [{ id: 'fp-alpha', label: 'Counts available credit as cash', tokens: ['available facility counted'], figures: [] }],
};
const WITHHELD = 'Details withheld while a round runs';
/* The stub plays entry n of the array for pilot n: 1 states the gold, 2 lands on the fingerprint, 3 reads outside its folder
   (DISCARDED), 4 exits with an error (failed), 5 gives an unclear answer. */
const ANSWER_GOLD = 'Usable cash is 1,250. Hold the borrowing.';
const ANSWER_FP = 'Available facility counted as cash. Proceed.';
const FAST = [
  { resultText: ANSWER_GOLD, numTurns: 6, toolUses: [{ name: 'Read', input: { file_path: 'filesystem/Cash_Facts.csv' }, result: 'synthetic' }], writeFiles: [{ path: 'outputs/answer.txt', content: 'hold 1,250\n' }, { path: 'outputs/cash_summary.csv', content: 'item,value\ncash,1250\n' }] },
  { resultText: ANSWER_FP, numTurns: 4, writeFiles: [{ path: 'outputs/answer.txt', content: 'proceed\n' }] },
  { toolUses: [{ name: 'Read', input: { file_path: '/etc/hosts' }, result: 'synthetic' }], resultText: 'Hold. Usable cash is 1,250.' },
  { exitCode: 1, resultText: '' },
  { resultText: 'Unclear. More data is needed.', numTurns: 3, writeFiles: [{ path: 'outputs/notes.md', content: 'unclear\n' }] },
];
/* Pilots 1 and 2 end after about 4 s, the others stay running until the test cancels the round. */
const SLOW = [0, 1, 2, 3, 4].map(i => ({ resultText: 'Usable cash is 1,250. Hold.', numTurns: 5, toolUses: [{ name: 'Read', input: { file_path: 'filesystem/Cash_Facts.csv' }, result: 'synthetic' }], delayMs: i < 2 ? 3000 : 120000, writeFiles: [{ path: 'outputs/slow.txt', content: 'hold\n' }] }));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, { timeout = 20000, interval = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + label);
    await sleep(interval);
  }
}

/* ------------------------------------------------------------------ the world: companion, service, packet folder */

async function makeWorld(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-mission-test-'));
  const projectRoot = path.join(base, 'project');
  const source = path.join(base, 'source');
  const tmpRoot = path.join(base, 'tmp');
  fs.mkdirSync(path.join(projectRoot, 'private'), { recursive: true });
  fs.mkdirSync(source);
  fs.mkdirSync(tmpRoot);
  fs.writeFileSync(path.join(source, 'Facility_Terms.txt'), 'Atlas facility terms, synthetic. Available credit is not cash received.\n');
  fs.writeFileSync(path.join(source, 'Cash_Facts.csv'), 'Label,Value\nOpening usable cash,100\nConfirmed funded draw,500\n');
  /* The pilots get a copy of this object at each launch, so the scenario can change between rounds. */
  const env = { ...cleanEnv(), FINANCE_STUB_SCENARIO: JSON.stringify(FAST) };
  const service = createAgentService({ root: projectRoot, env, claudeBin: STUB, tmpRoot, limits: { killGraceMs: 200 } });
  const app = createServer({ root: projectRoot, service, port: 0, log: () => {} });
  const { port } = await app.listen();
  const world = { base, source, env, service, app, port, origin: `http://127.0.0.1:${port}` };
  t.after(async () => {
    try { for (const row of await service.listRounds()) if (row.status === 'running') await service.cancelRound(row.id); } catch { /* shutting down anyway */ }
    await app.shutdown();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return world;
}

const roundBody = (w, label, task, count) => ({
  label, task, sourceDir: w.source, promptText: PROMPT, gafVisible: true,
  config: { model: 'claude-opus-5-5', effort: 'medium', count },
});
async function approvedRound(w, label, task, count) {
  const round = await w.service.createRound(roundBody(w, label, task, count));
  await w.service.freezeRound(round.id, GOLD);
  const { summarySha256 } = await w.service.approvalSummary(round.id);
  await w.service.approveRound(round.id, { summarySha256, acknowledgements: ACK });
  return round.id;
}
async function finishedRound(w, label, task, count) {
  const id = await approvedRound(w, label, task, count);
  await w.service.launchRound(id);
  await w.service.whenSettled(id);
  return id;
}
/* Atlas (5 pilots: gold, fingerprint, DISCARDED, failed, unclear) and Meridian (3 pilots, one DISCARDED) are finished and two of
   Atlas's clean pilots are classified. Borealis is a draft, or a running round when `running`. */
async function seedBoard(w, { running = false } = {}) {
  w.env.FINANCE_STUB_SCENARIO = JSON.stringify(FAST);
  const atlas = await finishedRound(w, 'Atlas round 1', 'Atlas', 5);
  await w.service.classifyRun(atlas, 1, { verdict: 'matches-frozen-gold', fingerprintIds: [] });
  await w.service.classifyRun(atlas, 2, { verdict: 'fingerprint', fingerprintIds: ['fp-alpha'] });
  const meridian = await finishedRound(w, 'Meridian round 1', 'Meridian', 3);
  let borealis;
  if (running) {
    w.env.FINANCE_STUB_SCENARIO = JSON.stringify(SLOW);
    borealis = await approvedRound(w, 'Borealis round 1', 'Borealis', 5);
    await w.service.launchRound(borealis);
    await waitFor(async () => (await w.service.getRound(borealis)).runs.some(run => run.state === 'running'), { label: 'a Borealis pilot to run' });
  } else borealis = (await w.service.createRound(roundBody(w, 'Borealis round 1', 'Borealis', 5))).id;
  return { atlas, meridian, borealis };
}

/* ------------------------------------------------------------------ the page: the scripts in a vm with a fake document */

const attrsOf = tag => {
  const out = {};
  for (const m of tag.matchAll(/\s([\w:-]+)(?:="([^"]*)")?/g)) out[m[1]] = m[2] === undefined ? '' : m[2].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return out;
};
const entities = text => text.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
/* plain: every tag is a word break (how a reader hears separate controls); flat: tags vanish (the text a sentence is made of) */
const plain = markup => entities(String(markup).replace(/<wbr>/g, '').replace(/<[^>]*>/g, ' '));
const flat = markup => entities(String(markup).replace(/<wbr>/g, '').replace(/<[^>]*>/g, ''));

/* A Map-backed stand-in for window.localStorage. */
function makeStorage() {
  const map = new Map();
  return { map, getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: k => { map.delete(k); } };
}

function makePage(t, world, { location, storage, hidden = false, packageLoaded = false, workbench = true, clipboard, tamper } = {}) {
  const elements = new Map();
  const handlers = {};
  const requests = [];
  const navigations = [];
  const opened = { runs: [], rounds: [], workbench: [], load: 0 };
  let failing = false, inflight = 0;
  const document = { activeElement: null, hidden, body: null, title: 'Finance Task Studio' };
  const makeEl = (id, tag = 'DIV') => {
    const attrs = new Map();
    const el = {
      id, tagName: tag, innerHTML: '', textContent: '', hidden: false, scrollTop: 0, value: '', files: null, listeners: {}, removed: false,
      setAttribute(name, value) { attrs.set(name, String(value)); if (name === 'hidden') el.hidden = true; },
      removeAttribute(name) { attrs.delete(name); if (name === 'hidden') el.hidden = false; },
      getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
      addEventListener(type, fn) { (el.listeners[type] || (el.listeners[type] = [])).push(fn); },
      removeEventListener() {},
      appendChild(child) { return child; },
      remove() { el.removed = true; },
      focus() { document.activeElement = el; },
      click() { el.clicked = (el.clicked || 0) + 1; },
      contains: node => node === el,
      querySelector(selector) {
        if (selector.includes('data-views-live="polite"')) return element('mc-status');
        if (selector.includes('data-views-live="assertive"')) return element('mc-alert');
        return null;
      },
    };
    return el;
  };
  const element = id => {
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  };
  document.body = makeEl('body', 'BODY');
  document.querySelector = selector => {
    const match = /^#([\w-]+)$/.exec(selector);
    return match ? element(match[1]) : null;
  };
  document.addEventListener = (type, fn) => { (handlers[type] || (handlers[type] = [])).push(fn); };
  document.removeEventListener = (type, fn) => { handlers[type] = (handlers[type] || []).filter(f => f !== fn); };
  document.createElement = tag => makeEl('', String(tag).toUpperCase());
  const fire = (type, event) => { for (const fn of (handlers[type] || []).slice()) fn(event); };
  const pageFetch = async (url, init = {}) => {
    inflight++;
    requests.push({ url, method: init.method || 'GET' });
    try {
      if (failing) throw new TypeError('synthetic: the network is down');
      const headers = { ...(init.headers || {}) };
      if (init.method && init.method !== 'GET') headers.Origin = world.origin;
      const res = await fetch(world.origin + url, { ...init, headers });
      if (!tamper) return res;
      /* a test may change what the companion answered (a feed window that moved, a pilot list that did not load) */
      const body = await res.json();
      const next = tamper(url, body);
      return new Response(JSON.stringify(next === undefined ? body : next), { status: res.status, headers: { 'content-type': 'application/json' } });
    } finally {
      inflight--;
    }
  };
  const store = storage || makeStorage();
  const copied = [];
  const context = vm.createContext({
    document, fetch: pageFetch, setTimeout, clearTimeout, console, URL, Blob,
    location: location || { protocol: 'http:', hostname: '127.0.0.1' }, CSS: { escape: value => String(value) },
    localStorage: store,
    navigator: { platform: 'Linux x86_64', clipboard: clipboard === undefined ? { writeText: async text => { copied.push(text); } } : clipboard },
  });
  context.window = context;
  const scrolls = [];
  context.innerHeight = 900;
  context.scrollBy = arg => { scrolls.push(arg); };
  for (const name of SCRIPTS.slice(0, 4)) vm.runInContext(SOURCES[name], context, { filename: name });
  /* what the page asked the polite announcer to say (the announcer itself coalesces over four seconds) */
  const said = [];
  const realAnnouncer = context.FinanceViews.announcer;
  context.FinanceViews.announcer = (root, opts) => {
    const announcer = realAnnouncer(root, opts), say = announcer.say;
    announcer.say = (text, o) => { said.push({ text, kind: o && o.kind }); return say.call(announcer, text, o); };
    return announcer;
  };
  context.FinanceDashboard = {
    navigate: id => { navigations.push(id); return true; },
    loadFiles: () => { opened.load++; },
    getPackage: () => (packageLoaded ? { documents: [{}] } : null),
  };
  if (workbench) context.FinanceWorkbench = { open: arg => { opened.workbench.push(arg); } };
  vm.runInContext(SOURCES['mission.js'], context, { filename: 'mission.js' });
  const mission = context.FinanceMission;
  assert.ok(mission && typeof mission.render === 'function' && typeof mission.afterRender === 'function', 'mission.js exports render and afterRender');
  const ctx = { package: { documents: packageLoaded ? [{}] : [] }, notify() {}, download() {}, navigate: id => navigations.push(id), loadFiles: () => { opened.load++; } };
  t.after(() => mission.afterRender(false));

  const page = {
    elements, element, requests, navigations, opened, context, mission, document, store, copied, said, scrolls,
    set failing(value) { failing = value; },
    markup: () => mission.render(ctx),
    text: () => plain(mission.render(ctx)),
    region: id => element(id).innerHTML,
    status: () => element('mc-status').textContent,
    alert: () => element('mc-alert').textContent,
    /* every painted region, joined: what the person sees once the page has painted */
    painted: () => [...elements.values()].map(el => el.innerHTML).join('\n'),
    buttons: () => [...page.markup().matchAll(/<button\b[^>]*>/g)].map(m => attrsOf(m[0])),
    primaries: () => page.buttons().filter(a => /(?:^|\s)primary(?:\s|$)/.test(a.class || '')),
    feedKeys: () => [...element('mc-feed').innerHTML.matchAll(/data-key="([^"]+)"/g)].map(m => m[1]),
    async settle() {
      let quiet = 0;
      while (quiet < 3) {
        await sleep(25);
        quiet = inflight === 0 ? quiet + 1 : 0;
      }
    },
    /* the 'tab became visible again' hook is the page's way to poll at once */
    async poll() {
      document.hidden = false;
      fire('visibilitychange', {});
      await page.settle();
    },
    async mount() {
      mission.render(ctx);
      mission.afterRender(true);
      await waitFor(() => element('mc-strip').innerHTML && !/Checking/.test(element('mc-strip').innerHTML), { label: 'the first poll' });
      await page.settle();
    },
    target(tag, extra = {}) {
      const a = attrsOf(tag);
      const el = {
        tagName: /^<(\w+)/.exec(tag)[1].toUpperCase(),
        getAttribute: name => (name in a ? a[name] : null),
        closest: selector => (selector === '[data-mc]' ? (a['data-mc'] !== undefined ? el : null) : selector === '#mc-root' ? {} : selector === '#mc-import' ? (extra.inImport ? {} : null) : null),
        value: extra.value,
        open: extra.open,
        ...extra,
      };
      return el;
    },
    find(action, dataset = {}) {
      const wanted = Object.entries(dataset).map(([k, v]) => `${k}="${v}"`);
      const tags = [...page.painted().matchAll(/<button\b[^>]*>/g), ...page.markup().matchAll(/<button\b[^>]*>/g)].map(m => m[0]);
      return tags.find(tag => tag.includes(`data-mc="${action}"`) && wanted.every(w => tag.includes(w))) || null;
    },
    async click(action, dataset = {}) {
      const tag = page.find(action, dataset);
      assert.ok(tag, `the page has a control for ${action}`);
      fire('click', { type: 'click', target: page.target(tag) });
      await page.settle();
    },
    async type(selectorId, value, kind) {
      const el = page.target(`<input id="${selectorId}" data-mc-in="${kind}">`, { value });
      fire('input', { type: 'input', target: el });
      await page.settle();
    },
    async choose(value) {
      const el = page.target('<select id="mc-stage-filter" data-mc-in="stage">', { value });
      fire('change', { type: 'change', target: el });
      await page.settle();
    },
    key(event) { let stopped = false; fire('keydown', { preventDefault() { stopped = true; }, target: document.body, ...event }); return stopped; },
  };
  return page;
}

/* A synthetic grading result in the shape the importer reads. The reasoning text carries a marker that must never be stored. */
const REASONING_MARKER = 'REASONING-MARKER-do-not-store';
function gradingFile(overrides = {}) {
  const json = JSON.stringify({
    grading_runs: [{ grading_run_id: 'run-synthetic-17', final_score: 0.62, scoring_method: 'rubric', grading_run_status: 'completed', judge: { llm_model: { provider: 'synthetic', model: 'judge-1' } } }],
    trajectory_output: { attempt_number: 2, final_score: 0.62, rewards: [{ subscores: [{ name: 'Accuracy', score: 0.62, max_score: 1, weight: 1, reasoning: `**Facts**\n- PASS the cash figure ${REASONING_MARKER}\n- FAIL the facility treatment` }] }] },
    ...overrides,
  });
  return { name: 'grading_run.json', size: json.length, text: async () => json };
}
const fileOf = (name, text) => ({ name, size: text.length, text: async () => text });

/* ====================================================================== the board, from the real API */

test('the board is built from the real API: one card per task with version, active agents, score line and next action', async t => {
  const w = await makeWorld(t);
  const ids = await seedBoard(w);
  const page = makePage(t, w);
  await page.mount();
  const text = page.text();
  for (const name of ['Atlas', 'Meridian', 'Borealis']) assert.match(text, new RegExp(`\\b${name}\\b`), `a card for ${name}`);
  assert.equal([...page.markup().matchAll(/<li class="mc-card[^"]*">/g)].length, 3, 'one card per task');
  assert.equal(page.buttons().filter(a => a['data-mc'] === 'card').length, 3);
  for (const a of page.buttons().filter(b => b['data-mc'] === 'card')) assert.equal(a['aria-pressed'], 'false', 'cards are toggle buttons');
  assert.match(text, /v1 · sha256:[0-9a-f]{12}/, 'the version is the round depth and the packet hash');
  const cardText = flat(page.region('mc-cards'));
  assert.equal([...cardText.matchAll(/No score recorded(?!\.)/g)].length, 3, 'each card says only "No score recorded", never a made-up score');
  assert.doesNotMatch(cardText, /Pilots and the simulated grader/, 'the longer sentence is not repeated on every card');
  assert.match(flat(page.region('mc-details')), /No score recorded\. Pilots and the simulated grader are not scored\./, 'the exact sentence is in the Details of the live run');
  assert.equal([...cardText.matchAll(/0 active agents/g)].length, 3, 'each card says how many agents are active');
  assert.match(text, /Next action Classify 2 clean pilots/, 'Meridian has two clean pilots to classify');
  assert.match(text, /Next action Freeze the round/, 'Borealis is a draft');
  assert.match(text, /3 tasks/);
  assert.match(text, /0 pilots running/);
  /* Atlas has 5 pilots (1 gold, 1 fingerprint classified; 1 unclear unclassified; 1 DISCARDED; 1 failed), Meridian 2 clean: 3 need a verdict. */
  assert.match(text, /3 pilots need your verdict/);
  assert.equal(page.primaries().length, 1, 'one yellow button');
  assert.equal(page.primaries()[0]['data-mc'], 'next');
  /* the feed: newest round first, pilots ascending, one row per pilot */
  const keys = page.feedKeys();
  assert.equal(keys.length, 8, '5 Atlas pilots and 3 Meridian pilots');
  assert.deepEqual(keys, [1, 2, 3].map(n => `${ids.meridian}:${n}`).concat([1, 2, 3, 4, 5].map(n => `${ids.atlas}:${n}`)));
  const feed = page.markup();
  assert.match(feed, /DISCARDED/);
  assert.match(feed, /FAILED/);
  assert.match(feed, /COMPLETED/);
  assert.match(feed, /The program exited with code 1/, 'a failed pilot says why in words');
  assert.match(feed, /Discarded by the audit/);
  /* no percentage, rate or score-share anywhere */
  assert.doesNotMatch(text, /%|pass rate|success rate|failure rate|difficulty|caught/);
  /* the rule: no request except through the page's own API helper, all of them GETs under /api/agents/ or /api/status */
  assert.ok(page.requests.length > 0);
  for (const r of page.requests) { assert.equal(r.method, 'GET'); assert.match(r.url, /^\/api\/(?:status|agents\/(?:rounds|runs)(?:[/?]|$))/); }
});

test('the live panel shows the four-stage stepper for the latest round and the Details hold progress, verdict counts and chips', async t => {
  const w = await makeWorld(t);
  await seedBoard(w);
  const page = makePage(t, w);
  await page.mount();
  const steps = page.region('mc-stepper');
  for (const name of ['Queued', 'Running', 'Classify', 'Complete']) assert.match(steps, new RegExp(name));
  assert.equal([...steps.matchAll(/<li class="mc-step/g)].length, 4);
  assert.equal([...steps.matchAll(/aria-current="step"/g)].length, 1, 'one current stage');
  assert.match(page.region('mc-stepper'), /Classify[\s\S]*is-current|is-current[\s\S]*Classify/, 'the round has ended and has clean pilots to classify');
  const details = page.region('mc-details');
  assert.match(details, /<details class="mc-details"/);
  assert.doesNotMatch(details, / open[ >]/, 'closed by default');
  assert.match(details, /Matches the frozen gold/);
  assert.match(details, /Directional only, n = 2\./, 'the count of clean completed pilots of the latest round');
  assert.match(details, /<progress /);
  assert.match(plain(details), /3 of 3 pilots finished/);
  assert.doesNotMatch(plain(details), /%|rate|difficulty/);
});

test('a task that carried its round forward is on the next version, and its newest round leads the card', async t => {
  const w = await makeWorld(t);
  w.env.FINANCE_STUB_SCENARIO = JSON.stringify(FAST);
  const first = await finishedRound(w, 'Atlas round 1', 'Atlas', 1);
  const next = (await w.service.nextRound(first)).id;
  await w.service.freezeRound(next, GOLD);
  const { summarySha256 } = await w.service.approvalSummary(next);
  await w.service.approveRound(next, { summarySha256, acknowledgements: ACK });
  await w.service.launchRound(next);
  await w.service.whenSettled(next);
  const page = makePage(t, w);
  await page.mount();
  assert.equal([...page.markup().matchAll(/<li class="mc-card/g)].length, 1, 'both rounds are one task');
  assert.match(page.text(), /Atlas v2 · sha256:[0-9a-f]{12}/);
  await page.click('view-run');
  await waitFor(() => /Evidence path/.test(page.region('mc-inspector')), { label: 'the inspector' });
  assert.ok(page.region('mc-inspector').includes(`private/agent-rounds/${next}/runs/1/outputs/`), 'the live panel follows the newest round');
  assert.equal(page.feedKeys().length, 2);
  assert.deepEqual(page.feedKeys(), [`${next}:1`, `${first}:1`]);
});

/* ====================================================================== search and selection */

test('the search field filters the cards, the feed and the outputs, and the chord focuses it', async t => {
  const w = await makeWorld(t);
  const ids = await seedBoard(w);
  const page = makePage(t, w);
  await page.mount();
  assert.equal(page.key({ ctrlKey: true, key: 'k' }), true, 'Ctrl K is taken by the page');
  assert.equal(page.document.activeElement, page.element('mc-search'), 'and focuses the search field');
  page.document.activeElement = null;
  assert.equal(page.key({ metaKey: true, key: 'K' }), true, 'so is the command key');
  assert.equal(page.key({ key: 'k' }), false, 'a plain k is left alone');

  /* the names of the newest outputs arrive with the next polls */
  await page.poll();
  await page.poll();
  await page.type('mc-search', 'meridian', 'search');
  const text = page.text();
  assert.match(page.region('mc-cards'), /Meridian/);
  assert.doesNotMatch(page.region('mc-cards'), /Atlas|Borealis/, 'only the matching card stays');
  assert.deepEqual(page.feedKeys(), [1, 2, 3].map(n => `${ids.meridian}:${n}`), 'only its pilots stay in the feed');
  assert.doesNotMatch(page.region('mc-outputs'), /Atlas/, 'and only its outputs');
  assert.match(text, /Meridian/);

  /* a file name matches the run that made it */
  await page.type('mc-search', 'cash_summary', 'search');
  assert.match(page.region('mc-cards'), /Atlas/, 'the task that owns a matching output is kept');
  assert.match(page.region('mc-cards'), /Meridian/);
  assert.doesNotMatch(page.region('mc-cards'), /Borealis/);
  assert.ok(page.feedKeys().length >= 1);

  await page.type('mc-search', 'zzz-no-such-thing', 'search');
  assert.match(page.region('mc-cards'), /No task matches "zzz-no-such-thing"\./);
  assert.match(page.region('mc-feed-empty'), /No run matches the search or the stage filter\./);
  /* the count is announced (after the page's pause) in the one polite region */
  await waitFor(() => /0 tasks, 0 runs/.test(page.status()), { label: 'the search count to be announced', timeout: 4000 });

  await page.type('mc-search', '', 'search');
  assert.equal(page.feedKeys().length, 8);
  assert.match(page.region('mc-cards'), /Atlas[\s\S]*Meridian[\s\S]*Borealis/);
  await waitFor(() => /Search cleared/.test(page.status()), { label: 'the cleared search to be announced', timeout: 4000 });
});

test('a card is a toggle button: selecting it filters the live panel, the feed and the outputs; selecting it again clears the filter', async t => {
  const w = await makeWorld(t);
  const ids = await seedBoard(w);
  const page = makePage(t, w);
  await page.mount();
  const unselected = page.region('mc-cards');
  await page.click('card', { 'data-task': 'task:atlas' });
  const cards = page.region('mc-cards');
  const bare = markup => markup.replace(/ is-selected/g, '').replace(/aria-pressed="(?:true|false)"/g, '');
  assert.equal(bare(cards), bare(unselected), 'selecting a card changes nothing in the cards but the selected state, so nothing below them moves');
  assert.match(cards, /data-task="task:atlas"[^>]*aria-pressed="true"/);
  assert.equal([...cards.matchAll(/aria-pressed="true"/g)].length, 1);
  assert.match(cards, /is-selected/);
  assert.doesNotMatch(cards, /Latest local pilots/, 'a card never grows when it is selected: the pilot tally is in the live run, not in the card');
  assert.match(page.region('mc-details'), /Latest local pilots \(round Atlas round [12]\)/, 'the live run of the selected task shows its pilot tally');
  assert.match(plain(page.region('mc-details')), /Directional only, n = \d+\./);
  assert.deepEqual(page.feedKeys().map(k => k.split(':')[0]).filter((v, i, a) => a.indexOf(v) === i), [ids.atlas]);
  assert.equal(page.feedKeys().length, 5);
  assert.match(page.region('mc-live-head'), /Atlas/);
  assert.doesNotMatch(page.region('mc-outputs'), /Meridian/);
  /* the choice is kept in the browser */
  assert.equal(JSON.parse(page.store.map.get('fts.mc.v1')).task, 'task:atlas');
  await page.click('card', { 'data-task': 'task:atlas' });
  assert.doesNotMatch(page.region('mc-cards'), /aria-pressed="true"/);
  assert.equal(page.feedKeys().length, 8, 'selecting again clears the filter');
  assert.equal(JSON.parse(page.store.map.get('fts.mc.v1')).task, null);
  /* the stage filter narrows the feed by state */
  await page.choose('failed');
  assert.equal(page.feedKeys().length, 1, 'one failed pilot');
  await page.choose('discarded');
  assert.equal(page.feedKeys().length, 2, 'a DISCARDED pilot in each round');
  await page.choose('outputs');
  assert.ok(page.feedKeys().length >= 3 && page.feedKeys().length < 8, 'only the runs with output files');
  assert.equal(JSON.parse(page.store.map.get('fts.mc.v1')).stage, 'outputs');
  await page.choose('all');
});

test('filters kept in the browser come back on the next visit, and a task that no longer exists is ignored', async t => {
  const w = await makeWorld(t);
  await seedBoard(w);
  const storage = makeStorage();
  storage.setItem('fts.mc.v1', JSON.stringify({ task: 'task:meridian', stage: 'completed' }));
  const page = makePage(t, w, { storage });
  await page.mount();
  assert.match(page.region('mc-cards'), /data-task="task:meridian"[^>]*aria-pressed="true"/);
  assert.match(page.region('mc-feedbar'), /<option value="completed" selected>/);
  const other = makeStorage();
  other.setItem('fts.mc.v1', JSON.stringify({ task: 'task:gone', stage: 'not-a-stage' }));
  const second = makePage(t, w, { storage: other });
  await second.mount();
  assert.doesNotMatch(second.region('mc-cards'), /aria-pressed="true"/, 'an unknown task selects nothing');
  assert.equal(second.feedKeys().length, 8, 'and filters nothing');
  assert.match(second.region('mc-feedbar'), /<option value="all" selected>/);
});

/* ====================================================================== polls, order, blindness */

test('the feed keeps its order across polls, also while a pilot ends and a round runs', async t => {
  const w = await makeWorld(t);
  const ids = await seedBoard(w, { running: true });
  const page = makePage(t, w);
  await page.mount();
  const before = page.feedKeys();
  assert.equal(before.length, 13, '5 Borealis, 3 Meridian and 5 Atlas pilots');
  assert.deepEqual(before, [1, 2, 3, 4, 5].map(n => `${ids.borealis}:${n}`).concat([1, 2, 3].map(n => `${ids.meridian}:${n}`), [1, 2, 3, 4, 5].map(n => `${ids.atlas}:${n}`)), 'the running round is first, its pilots in order');
  for (let i = 0; i < 3; i++) { await page.poll(); assert.deepEqual(page.feedKeys(), before, `poll ${i + 1} changed nothing`); }
  /* Borealis pilots 1 and 2 end after about 3 s: the rows stay where they are, only their words change. */
  await waitFor(async () => { await page.poll(); return page.feedKeys().slice(0, 5).filter(key => new RegExp(`data-key="${key}"[^>]*st-completed`).test(page.region('mc-feed'))).length >= 2; }, { label: 'two Borealis pilots to complete', timeout: 15000, interval: 200 });
  await waitFor(async () => { await page.poll(); return /<span class="mc-active is-on">[\s\S]*?3 active/.test(page.region('mc-cards')); }, { label: 'Borealis to show three active pilots', timeout: 8000, interval: 200 });
  assert.deepEqual(page.feedKeys(), before, 'a state change moves no row');
  assert.match(page.region('mc-live-head'), /Live run/);
  assert.match(page.region('mc-feedbar'), /Streaming live\.\.\./, 'the live indicator is text');
  assert.match(page.region('mc-cards'), /<span class="mc-active is-on">[\s\S]*3 active/, 'Borealis has three pilots still running');
});

test('while a round runs the page shows no gold, fingerprint, prompt or answer text, and says the details are withheld', async t => {
  const w = await makeWorld(t);
  await seedBoard(w);
  const page = makePage(t, w);
  await page.mount();
  /* nothing runs: the inspector of a finished pilot shows its answer and its file names */
  await page.click('view-run');
  await waitFor(() => page.region('mc-inspector').includes('Final answer'), { label: 'the final answer to load' });
  const first = page.region('mc-inspector');
  assert.match(first, /Where the output is/);
  assert.match(first, /private\/agent-rounds\/rnd-[0-9a-z-]+\/runs\/1\/outputs\//, 'the evidence path');
  assert.match(first, /finance-studio-pilots\//, 'the working folder');
  await waitFor(() => /Usable cash is 1,250\. Hold the borrowing\./.test(page.region('mc-inspector')), { label: 'the answer text' });
  await waitFor(() => /cash_summary\.csv|answer\.txt/.test(page.region('mc-outputs')), { label: 'the output names' });

  /* a round starts: every surface must lose that text on the next poll */
  w.env.FINANCE_STUB_SCENARIO = JSON.stringify(SLOW);
  const running = await approvedRound(w, 'Borealis round 1', 'Borealis', 5);
  await w.service.launchRound(running);
  await waitFor(async () => { await page.poll(); return page.region('mc-feedbar').includes('Streaming live...'); }, { label: 'the page to see the running round', timeout: 15000, interval: 100 });
  const everything = page.painted() + '\n' + page.markup();
  for (const secret of [ANSWER_GOLD, ANSWER_FP, 'Synthetic gold notes', 'Counts available credit as cash', 'available facility counted', 'fp-alpha', 'Assess the Atlas liquidity', w.source, 'cash_summary.csv', 'Usable cash']) {
    assert.ok(!everything.includes(secret), `"${secret}" must not be on the page while a round runs`);
  }
  assert.ok(plain(page.region('mc-inspector')).includes(WITHHELD), 'the inspector says the details are withheld');
  assert.ok(plain(page.region('mc-outputs')).includes(WITHHELD), 'so does the outputs list');
  assert.ok(plain(page.region('mc-feed')).includes(WITHHELD), 'and so does every row of the feed');
  assert.match(plain(page.region('mc-outputs')), /\d+ files? from \d+ pilots?/, 'the counts stay');
  assert.match(page.region('mc-feedbar'), /Streaming live\.\.\./);
  /* the log of the selected run: kinds only */
  const logRequests = page.requests.filter(r => /\/log\?/.test(r.url));
  assert.ok(logRequests.length >= 1, 'the log is asked for');
  assert.match(page.region('mc-inspector'), /only the kind of each step is listed|Details withheld while a round runs/);
  /* the round ends: the details come back */
  await w.service.cancelRound(running);
  await w.service.whenSettled(running);
  await waitFor(async () => { await page.poll(); return !page.region('mc-feedbar').includes('Streaming live...'); }, { label: 'the page to see the round end', timeout: 15000, interval: 100 });
  await waitFor(() => /Usable cash is 1,250\. Hold the borrowing\./.test(page.region('mc-inspector')) || !page.region('mc-inspector').trim(), { label: 'the answer to come back' });
});

test('polling stops when the view is left, waits while the tab is hidden, and a manual retry polls at once', async t => {
  const w = await makeWorld(t);
  await seedBoard(w);
  const page = makePage(t, w, { hidden: true });
  page.mission.render({ package: { documents: [] } });
  page.mission.afterRender(true);
  await sleep(300);
  assert.equal(page.requests.length, 0, 'a hidden tab makes no request');
  page.document.hidden = false;
  await page.poll();
  assert.ok(page.requests.length >= 3, 'visible again: the link check and both lists');
  /* while it runs, the interval follows the round: a second poll comes without any nudge when a round runs */
  const countBefore = page.requests.length;
  page.mission.afterRender(false);
  await page.poll();
  await sleep(200);
  assert.equal(page.requests.length, countBefore, 'after afterRender(false) nothing polls, not even on a visibility change');
  page.mission.afterRender(true);
  await waitFor(() => page.requests.length > countBefore, { label: 'polling to start again' });
});

test('a lost link is announced once as an alert, keeps the old data with a stale marker, and Retry now polls again', async t => {
  const w = await makeWorld(t);
  await seedBoard(w);
  const page = makePage(t, w);
  await page.mount();
  assert.equal(page.alert(), '');
  page.failing = true;
  await page.poll();
  assert.equal(page.alert(), '', 'one failed poll is not a lost link yet');
  await page.poll();
  assert.match(page.alert(), /The link to the local companion was lost/);
  const alert = page.alert();
  await page.poll();
  await page.poll();
  assert.equal(page.alert(), alert, 'announced once');
  assert.match(page.region('mc-note'), /The link to the local companion was lost\. Showing what was last seen at \d\d:\d\d:\d\d\./);
  assert.match(page.region('mc-note'), /data-mc="retry"/);
  assert.match(page.region('mc-strip'), /Link lost/);
  assert.match(page.region('mc-strip'), /Active agents: Not available/, 'never a zero for what is not known');
  assert.match(page.region('mc-cards'), /Atlas/, 'the last data stays');
  assert.match(page.region('mc-feedbar'), /Stale: link lost/);
  assert.equal(page.primaries().length, 0, 'nobody is primary without the companion');
  page.failing = false;
  await page.click('retry');
  await waitFor(() => !/Link lost/.test(page.region('mc-strip')), { label: 'the link to come back' });
  assert.equal(page.region('mc-note').trim(), '');
  assert.match(page.region('mc-strip'), /Local companion/);
});

test('terminal transitions are announced in the one polite region, once, and never as progress', async t => {
  const w = await makeWorld(t);
  await seedBoard(w, { running: true });
  const page = makePage(t, w);
  await page.mount();
  assert.equal(page.status(), '', 'the first snapshot announces nothing');
  assert.equal([...page.markup().matchAll(/role="status"/g)].length, 1, 'one polite status region');
  await waitFor(async () => { await page.poll(); return /Borealis: pilot \d completed\./.test(page.status()); }, { label: 'the completion to be announced', timeout: 20000, interval: 250 });
  assert.match(page.status(), /^Borealis: pilot [12] completed\./);
  assert.doesNotMatch(page.status(), /tool call|turn|running/, 'no progress chatter');
  assert.ok(page.status().length <= 160);
});

/* ====================================================================== editions and states */

test('the file edition makes no request, says so in a neutral banner, and shows Not available for active agents, never 0', async t => {
  const w = await makeWorld(t);
  const page = makePage(t, w, { location: { protocol: 'file:', hostname: '' } });
  await page.mount();
  await sleep(150);
  assert.equal(page.requests.length, 0, 'no request at all');
  assert.match(page.region('mc-note'), /Local agents need the companion: run npm start\./);
  assert.match(page.region('mc-strip'), /Active agents: Not available/);
  assert.match(page.region('mc-strip'), /Offline/);
  assert.doesNotMatch(plain(page.region('mc-strip')), /\b0 pilots running/);
  assert.equal(page.region('mc-live-head').trim(), '');
  assert.equal(page.primaries().length, 1);
  assert.equal(page.primaries()[0]['data-mc'], 'load', 'Load task package is the one yellow button when nothing is loaded');
  /* an imported evaluation still shows, with Not available for agents */
  page.store.setItem('fts.evals.v1', JSON.stringify([{ id: 'eval-1', task: 'Atlas', runId: 'run-9', score: 0.5, scoreMax: 1, importedAt: '2026-05-01T10:00:00.000Z', sourceName: 'x.json' }]));
  page.mission.afterRender(false);
  page.mission.render({ package: { documents: [] } });
  page.mission.afterRender(true);
  await sleep(150);
  assert.match(page.region('mc-cards'), /Active agents: Not available/);
  assert.match(flat(page.region('mc-cards')), /Imported evaluation result: 0\.5 \/ 1, run run-9, 2026-05-01\. Recorded by you from the evaluation; Finance Task Studio did not compute it\./);
  assert.equal(page.requests.length, 0, 'still no request');
});

test('an empty companion says what is missing in one place and offers the single yellow button', async t => {
  const w = await makeWorld(t);
  const page = makePage(t, w);
  await page.mount();
  assert.match(plain(page.region('mc-empty')), /No task has a round yet\. Freeze a round in Agents and its task appears here\. Nothing has run\./);
  assert.equal(page.region('mc-live-head').trim(), '');
  assert.equal(page.primaries().length, 1);
  assert.equal(page.primaries()[0]['data-mc'], 'load', 'nothing loaded and no round: Load task package');
  await page.click('load');
  assert.equal(page.opened.load, 1, 'it opens the existing package picker');
  /* a loaded package and no round: the primary moves to Open Agents, Load goes quiet */
  const loaded = makePage(t, w, { packageLoaded: true });
  await loaded.mount();
  assert.equal(loaded.primaries().length, 1);
  assert.equal(loaded.primaries()[0]['data-mc'], 'start');
  await loaded.click('start');
  assert.deepEqual(loaded.navigations, ['agents']);
});

test('at most one yellow button is on screen in every state, and Open in Agents hands the round to the Agents page', async t => {
  const w = await makeWorld(t);
  const ids = await seedBoard(w, { running: true });
  const page = makePage(t, w);
  await page.mount();
  assert.equal(page.primaries().length, 1);
  const only = page.primaries()[0];
  assert.equal(only['data-task'], 'task:borealis', 'the running round is the most urgent task');
  const blocked = page.buttons().filter(a => a['data-mc'] === 'next' && a['data-task'] !== 'task:borealis');
  assert.ok(blocked.length === 2 && blocked.every(a => 'disabled' in a), 'classification waits while a round runs, so those buttons are disabled with the reason shown');
  assert.match(page.text(), /Classification waits until no round is running\./);
  let recorded = null;
  page.context.FinanceAgents.openRound = (id, step) => { recorded = { id, step }; return Promise.resolve({ recorded: true, applied: false }); };
  await page.click('next', { 'data-task': 'task:borealis' });
  assert.deepEqual(recorded, { id: ids.borealis, step: 'runs' }, 'the pilots step of the running round');
  assert.deepEqual(page.navigations, ['agents']);
  /* a blocked button does nothing */
  await page.click('next', { 'data-task': 'task:atlas' });
  assert.deepEqual(page.navigations, ['agents']);
  /* every combination of selection and filter keeps one primary */
  await page.click('card', { 'data-task': 'task:atlas' });
  assert.equal(page.primaries().length, 1);
  await page.type('mc-search', 'meridian', 'search');
  assert.ok(page.primaries().length <= 1);
});

test('a classify action opens the first clean pilot through openRun', async t => {
  const w = await makeWorld(t);
  const ids = await seedBoard(w);
  const page = makePage(t, w);
  await page.mount();
  let recorded = null;
  page.context.FinanceAgents.openRun = (id, n) => { recorded = { id, n }; return Promise.resolve({ recorded: true, applied: false }); };
  await page.click('next', { 'data-task': 'task:meridian' });
  assert.deepEqual(recorded, { id: ids.meridian, n: 1 });
  assert.deepEqual(page.navigations, ['agents']);
});

test('names typed by the person are text, never markup, and a card with an odd name still works', async t => {
  const w = await makeWorld(t);
  w.env.FINANCE_STUB_SCENARIO = JSON.stringify(FAST);
  const hostile = '<img src=x onerror=alert(1)>"\'&';
  await finishedRound(w, 'Round <b>1</b>', hostile, 1);
  const page = makePage(t, w);
  await page.mount();
  const everything = page.markup() + page.painted();
  assert.ok(!everything.includes('<img'), 'no raw tag from a name');
  assert.ok(!/<b>1<\/b>/.test(everything), 'no raw tag from a label');
  assert.ok(everything.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the name is shown as text');
  /* attribute names only: what sits between quotes is a value, and a value cannot start a handler */
  assert.doesNotMatch(everything.replace(/="[^"]*"/g, '=""'), /<[^>]*\son[a-z]+\s*=/i, 'no handler attribute made from a name');
  const escaped = `task:${hostile.toLowerCase()}`.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  await page.click('card', { 'data-task': escaped });
  assert.match(page.region('mc-cards'), /aria-pressed="true"/);
  assert.equal(page.feedKeys().length, 1);
  /* the id that describes a blocked button never holds the spaces and quotes of the name */
  const ids = [...page.markup().matchAll(/\sid="([^"]*)"/g)].map(m => m[1]);
  assert.ok(ids.every(id => /^[A-Za-z0-9_:-]+$/.test(id)), 'ids are plain: ' + ids.filter(id => !/^[A-Za-z0-9_:-]+$/.test(id)));
});

test('FinanceMission.focusTask selects a card by key or by name, and says no when there is none', async t => {
  const w = await makeWorld(t);
  await seedBoard(w);
  const page = makePage(t, w);
  assert.equal(page.mission.focusTask('Atlas'), false, 'nothing is known before the first poll');
  await page.mount();
  assert.equal(page.mission.focusTask('Meridian'), true);
  assert.match(page.region('mc-cards'), /data-task="task:meridian"[^>]*aria-pressed="true"/);
  assert.equal(page.feedKeys().length, 3);
  assert.equal(page.mission.focusTask('task:atlas'), true);
  assert.match(page.region('mc-cards'), /data-task="task:atlas"[^>]*aria-pressed="true"/);
  assert.equal(page.mission.focusTask('Cobalt'), false);
  assert.match(page.region('mc-cards'), /data-task="task:atlas"[^>]*aria-pressed="true"/, 'an unknown task changes nothing');
});

test('the log of the selected run is read page by page without repeating a line', async t => {
  const w = await makeWorld(t);
  await seedBoard(w);
  const page = makePage(t, w);
  await page.mount();
  await page.click('view-run');
  await waitFor(() => /Activity \(\d+ lines?\)/.test(page.region('mc-inspector')), { label: 'the activity to load' });
  /* two polls at once with a click on the same run in between: no line may appear twice */
  await Promise.all([page.poll(), page.poll(), page.click('view-run')]);
  const seqs = [...page.region('mc-inspector').matchAll(/<span class="mc-log-seq">(\d+)<\/span>/g)].map(m => Number(m[1]));
  assert.ok(seqs.length >= 3, 'the transcript has lines: ' + seqs.length);
  assert.deepEqual(seqs, [...new Set(seqs)].sort((a, b) => a - b), 'each line once, in order');
  assert.match(page.region('mc-inspector'), /Activity \(\d+ lines?\)/);
});

test('Open in Agents from a card with a draft round asks the Agents page for that round at its freeze step', async t => {
  const w = await makeWorld(t);
  const ids = await seedBoard(w);
  const page = makePage(t, w);
  await page.mount();
  let recorded = null;
  page.context.FinanceAgents.openRound = (id, step) => { recorded = { id, step }; return Promise.resolve({ recorded: true, applied: false }); };
  await page.click('next', { 'data-task': 'task:borealis' });
  assert.equal(JSON.stringify(recorded), JSON.stringify({ id: ids.borealis, step: 'freeze' }));
  assert.equal(JSON.stringify(page.navigations), JSON.stringify(['agents']));
});

/* ====================================================================== the inspector */

test('the inspector says what ran, what happened and where the output is, and Escape closes it', async t => {
  const w = await makeWorld(t);
  const ids = await seedBoard(w);
  const page = makePage(t, w);
  await page.mount();
  await page.click('view-run');
  const ins = () => page.region('mc-inspector');
  await waitFor(() => /Final answer/.test(ins()), { label: 'the inspector detail' });
  assert.match(ins(), /What ran/);
  assert.match(ins(), /What happened/);
  assert.match(ins(), /Where the output is/);
  assert.match(plain(ins()), /Task Meridian/);
  assert.match(plain(ins()), /Working folder finance-studio-pilots\//);
  assert.match(plain(ins()), new RegExp(`Evidence path private/agent-rounds/${ids.meridian}/runs/\\d/outputs/`));
  assert.match(ins(), /data-mc="copy"/);
  assert.match(ins(), /data-mc="open-agents"/);
  assert.match(ins(), /data-mc="open-workbench"/);
  assert.match(page.region('mc-stage') + page.markup(), /data-inspector="true"/);
  /* Copy path puts the evidence path on the clipboard, and nothing is ever offered as a download */
  await page.click('copy');
  assert.equal(page.copied.length, 1);
  assert.match(page.copied[0], /^private\/agent-rounds\/[a-z0-9-]+\/runs\/\d\/outputs\/$/);
  assert.match(page.status(), /Copied the path to the clipboard\./);
  assert.doesNotMatch(page.markup(), /download|<a [^>]*href/i);
  /* Open in Agents and Open in Workbench hand the run over, then navigate */
  const calls = [];
  page.context.FinanceAgents.openRun = (id, n) => { calls.push(['openRun', id, n]); return Promise.resolve({}); };
  await page.click('open-agents');
  await page.click('open-workbench');
  assert.deepEqual(calls[0].slice(0, 1), ['openRun']);
  assert.equal(JSON.stringify(page.opened.workbench), JSON.stringify([{ roundId: ids.meridian, n: 1 }]));
  assert.equal(JSON.stringify(page.navigations), JSON.stringify(['agents', 'workbench']));
  /* Escape closes it */
  assert.equal(page.key({ key: 'Escape' }), true);
  assert.equal(page.region('mc-inspector').trim(), '');
  assert.ok(page.element('mc-inspector').hidden);
});

test('Open in Workbench is absent when the Workbench is not there', async t => {
  const w = await makeWorld(t);
  await seedBoard(w);
  const page = makePage(t, w, { workbench: false });
  await page.mount();
  await page.click('view-run');
  await waitFor(() => /What ran/.test(page.region('mc-inspector')), { label: 'the inspector' });
  assert.doesNotMatch(page.region('mc-inspector'), /open-workbench/);
  assert.match(page.region('mc-inspector'), /open-agents/);
});

test('the inspector does not call an uncounted output zero, and shows a path only when there is one', async t => {
  const w = await makeWorld(t);
  const ids = await seedBoard(w, { running: true });
  const live = makePage(t, w);
  await live.mount();
  await live.click('view-run');
  const running = plain(live.region('mc-inspector'));
  assert.match(running, /Output files Counted when the run ends/, 'a running pilot has no count yet, which is not zero');
  assert.match(running, new RegExp(`Evidence path private/agent-rounds/${ids.borealis}/runs/1/outputs/`), 'the path the copy will have');
  assert.match(running, /Copied to the evidence folder when the run ends\./);
  assert.doesNotMatch(running, /Output files 0\b/);
  /* an ended pilot whose output was never copied: no path to offer, and the page says so */
  const other = await makeWorld(t);
  const ended = await seedBoard(other);
  const tamper = (url, body) => (body && Array.isArray(body.runs) ? { ...body, runs: body.runs.map(r => (r.roundId === ended.meridian && r.n === 1 ? { ...r, evidencePath: null } : r)) } : undefined);
  const page = makePage(t, other, { tamper });
  await page.mount();
  await page.click('view-run');
  const text = plain(page.region('mc-inspector'));
  assert.match(text, /Pilot 1 · Meridian round 1/);
  assert.match(text, /Evidence path Not available/);
  assert.match(text, /Output files None/);
  assert.match(text, /No output was copied for this run\./);
  assert.doesNotMatch(page.region('mc-inspector'), /data-mc="copy"/, 'nothing to copy');
});

/* ====================================================================== imported evaluation results */

test('importing an evaluation result: file, task, record, card, and only the score is kept', async t => {
  const w = await makeWorld(t);
  await seedBoard(w);
  const page = makePage(t, w);
  await page.mount();
  await page.click('import');
  assert.match(page.region('mc-import'), /Import evaluation result/);
  assert.match(page.region('mc-import'), /data-mc="import-choose"/);
  await page.click('import-cancel');
  await runImport(page, gradingFile(), 'Atlas');
  const card = flat(page.region('mc-cards'));
  assert.match(card, /Imported evaluation result: 0\.62 \/ 1, run run-synthetic-17, \d{4}-\d{2}-\d{2}\. Recorded by you from the evaluation; Finance Task Studio did not compute it\./);
  assert.doesNotMatch(card, /Earlier version/, 'recorded against the latest packet');
  const stored = JSON.parse(page.store.map.get('fts.evals.v1'));
  assert.equal(stored.length, 1);
  assert.deepEqual({ task: stored[0].task, runId: stored[0].runId, score: stored[0].score, scoreMax: stored[0].scoreMax, roundId: stored[0].roundId }, { task: 'Atlas', runId: 'run-synthetic-17', score: 0.62, scoreMax: 1, roundId: stored[0].roundId });
  assert.ok(stored[0].packetSha256 && stored[0].roundId.startsWith('rnd-'), 'the latest round and packet are noted so a later version can be called earlier');
  assert.equal(stored[0].sourceName, 'grading_run.json');
  assert.ok(!page.store.map.get('fts.evals.v1').includes(REASONING_MARKER), 'the reasoning text is never stored');
  assert.ok(!page.painted().includes(REASONING_MARKER), 'and is not shown');
  assert.match(page.status(), /Recorded the evaluation result for Atlas\./);
  assert.equal(page.region('mc-import').trim(), '', 'the panel closes');
  /* importing the same run again replaces the record (de-duplicated by id) */
  await runImport(page, gradingFile(), 'atlas');
  assert.equal(JSON.parse(page.store.map.get('fts.evals.v1')).length, 1);
  /* a record for a task with no round makes its own card, with a Start action that is never primary */
  await runImport(page, gradingFile({ grading_runs: [{ grading_run_id: 'run-other', final_score: 3, grading_run_status: 'completed' }], trajectory_output: { attempt_number: 1, final_score: 3, rewards: [{ subscores: [{ name: 'A', score: 3, max_score: 5, weight: 1, reasoning: '' }] }] } }), 'Cobalt');
  assert.match(page.region('mc-cards'), /Cobalt/);
  assert.match(flat(page.region('mc-cards')), /Imported evaluation result: 3 \/ 5, run run-other/);
  assert.equal(page.primaries().filter(a => a['data-task'] === 'task:cobalt').length, 0);
  /* a new page with the same storage shows them again */
  const second = makePage(t, w, { storage: page.store });
  await second.mount();
  assert.match(flat(second.region('mc-cards')), /Imported evaluation result: 0\.62 \/ 1, run run-synthetic-17/);
  assert.match(second.region('mc-cards'), /Cobalt/);
});

/* The hidden file input is created by the page; the fake document records it. */
async function runImport(page, file, task) {
  if (!page.find('import-choose') && !page.find('import-save')) await page.click('import');
  if (page.find('import-save')) { await page.click('import-cancel'); await page.click('import'); }
  const created = [];
  const original = page.document.createElement;
  page.document.createElement = tag => { const el = original(tag); created.push(el); return el; };
  const appended = [];
  page.document.body.appendChild = child => { appended.push(child); return child; };
  await page.click('import-choose');
  page.document.createElement = original;
  const input = created.find(el => el.tagName === 'INPUT');
  assert.ok(input, 'the page made a hidden file input with createElement');
  assert.equal(input.type, 'file');
  assert.equal(input.hidden, true);
  assert.match(input.accept, /json/);
  assert.equal(input.clicked, 1, 'and opened it');
  assert.ok(appended.includes(input));
  input.files = [file];
  for (const fn of input.listeners.change || []) fn({ target: input });
  await waitFor(() => /data-mc="import-save"|mc-error/.test(page.region('mc-import')), { label: 'the file to be read' });
  if (/mc-error/.test(page.region('mc-import'))) return;
  assert.match(plain(page.region('mc-import')), /Score 0?\.?\d|Score \d/);
  await page.type('mc-imp-task', task, 'imp-task');
  await page.click('import-save');
}

test('a bad evaluation file gives a clear error and records nothing', async t => {
  const w = await makeWorld(t);
  await seedBoard(w);
  const page = makePage(t, w);
  await page.mount();
  const cases = [
    [fileOf('notes.txt', 'this is not json at all'), /Could not use notes\.txt\. The evaluation result is not valid JSON\./],
    [fileOf('list.json', '[1,2,3]'), /Could not use list\.json\. The evaluation result must be a JSON object/],
    [fileOf('other.json', '{"hello":"world"}'), /Could not use other\.json\. This is not an evaluation grading result: grading_runs is missing or empty\./],
    [fileOf('noscore.json', JSON.stringify({ grading_runs: [{ grading_run_id: 'r' }], trajectory_output: { rewards: [] } })), /Could not use noscore\.json\. The file has no final score, so there is nothing to record\./],
    [{ name: 'huge.json', size: 40 * 1024 * 1024, text: async () => '{}' }, /Could not use huge\.json\. The file is larger than 30 MB, so it was not read\./],
  ];
  for (const [file, pattern] of cases) {
    await runImport(page, file, 'Atlas');
    assert.match(plain(page.region('mc-import')), pattern);
    assert.match(page.status(), /Could not use/, 'the error is also said in the polite region');
    assert.equal(page.store.map.get('fts.evals.v1'), undefined, 'nothing was stored');
    assert.match(page.region('mc-import'), /data-mc="import-choose"/, 'the person can choose another file');
  }
  /* a good file but no task name: the person is asked for it, and nothing is stored */
  await runImport(page, gradingFile(), '');
  assert.match(plain(page.region('mc-import')), /Type the task name this result belongs to\./);
  assert.equal(page.store.map.get('fts.evals.v1'), undefined);
  /* the task field offers the known tasks */
  assert.match(page.region('mc-import'), /<datalist id="mc-task-list">[\s\S]*value="Atlas"[\s\S]*value="Meridian"[\s\S]*value="Borealis"/);
  await page.click('import-cancel');
  assert.equal(page.region('mc-import').trim(), '');
});

test('records in storage that are damaged or of another shape are ignored without breaking the page', async t => {
  const w = await makeWorld(t);
  await seedBoard(w);
  for (const value of ['not json', '{"a":1}', '[1,"x",null,{"id":"e","task":"Atlas","score":"7%"}]', '[{"id":"e","task":"Atlas","runId":"r","score":0.4,"scoreMax":1,"importedAt":"2026-01-02T00:00:00.000Z"}]']) {
    const storage = makeStorage();
    storage.setItem('fts.evals.v1', value);
    const page = makePage(t, w, { storage });
    await page.mount();
    assert.match(page.region('mc-cards'), /Atlas/, 'the board still draws');
    if (value.includes('0.4')) assert.match(flat(page.region('mc-cards')), /Imported evaluation result: 0\.4 \/ 1, run r, 2026-01-02\./);
    else assert.doesNotMatch(flat(page.region('mc-cards')), /Imported evaluation result/);
  }
  /* storage that throws: the page still works and the record is kept for the session */
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const page = makePage(t, w, { storage: broken });
  await page.mount();
  await page.click('import');
  await runImport(page, gradingFile(), 'Atlas');
  assert.match(page.status(), /The browser did not save it, so it is kept for this page only\./);
  assert.match(flat(page.region('mc-cards')), /Imported evaluation result: 0\.62 \/ 1/);
});

/* ====================================================================== what is announced, and what the live run claims */

test('a row of a round the page already knows is not news when it first appears, but a round that arrives already ended is announced', async t => {
  const w = await makeWorld(t);
  const ids = await seedBoard(w);
  /* the first snapshot has Atlas without pilots 4 and 5 (a feed window that has not reached them) and no Meridian at all */
  let early = true;
  const tamper = (url, body) => (early && body && Array.isArray(body.runs) ? { ...body, runs: body.runs.filter(r => r.roundId !== ids.meridian && !(r.roundId === ids.atlas && r.n >= 4)) } : undefined);
  const page = makePage(t, w, { tamper });
  await page.mount();
  assert.ok(!page.feedKeys().includes(`${ids.atlas}:4`) && !page.feedKeys().some(k => k.startsWith(ids.meridian)), 'the first snapshot is the short one');
  assert.deepEqual(page.said, [], 'the first snapshot announces nothing');
  early = false;
  await page.poll();
  assert.ok(page.feedKeys().includes(`${ids.atlas}:4`) && page.feedKeys().includes(`${ids.meridian}:1`), 'the second snapshot has everything');
  const said = page.said.map(x => x.text);
  assert.deepEqual(said.filter(x => x.startsWith('Atlas')), [], 'Atlas is a known round: its late rows are not announced as news');
  assert.deepEqual(said.filter(x => x.startsWith('Meridian')), ['Meridian: pilot 1 completed.', 'Meridian: pilot 2 completed.', 'Meridian: pilot 3 was discarded by the audit.'], 'Meridian arrived already ended');
  assert.ok(page.said.every(x => ['completed', 'discarded'].includes(x.kind)), 'only terminal kinds are said');
});

test('a round whose pilot list did not load in full does not claim to be complete', async t => {
  const w = await makeWorld(t);
  const ids = await seedBoard(w);
  const tamper = (url, body) => (body && Array.isArray(body.runs) ? { ...body, runs: body.runs.filter(r => r.roundId !== ids.meridian) } : undefined);
  const page = makePage(t, w, { tamper });
  await page.mount();
  const steps = page.region('mc-stepper');
  const items = [...steps.matchAll(/<li class="mc-step is-(\w+)"[^>]*>([\s\S]*?)<\/li>/g)].map(m => ({ state: m[1], text: plain(m[2]) }));
  assert.equal(items.length, 4);
  assert.equal(items[2].state, 'current', 'it waits at Classify');
  assert.match(items[2].text, /Pilot list not loaded/);
  assert.equal(items[3].state, 'todo', 'and Complete is not reached');
  assert.match(items[3].text, /Not yet/);
  assert.match(plain(page.region('mc-details')), /the pilot list has not loaded yet\. Open the round in Agents\./);
});

test('opening the inspector brings it up to where it sticks, and leaves the page alone when it is already there', async t => {
  const w = await makeWorld(t);
  await seedBoard(w);
  const page = makePage(t, w);
  await page.mount();
  let top = 462, bottom = 1160;
  page.element('mc-inspector').getBoundingClientRect = () => ({ top, bottom });
  await page.click('view-run');
  assert.deepEqual(page.scrolls.map(s => ({ top: s.top, behavior: s.behavior })), [{ top: 438, behavior: 'auto' }], 'the page moves up by the distance to 24px under the top; no smooth motion without a motion preference');
  top = 24; bottom = 800;
  await page.click('view-run');
  assert.equal(page.scrolls.length, 1, 'already in place: no scroll');
});

test('a card shows at most three running dots, and the document lists the feed before the live run so the keyboard reaches the wide layout left to right', async t => {
  const w = await makeWorld(t);
  await seedBoard(w, { running: true });
  const page = makePage(t, w);
  await page.mount();
  const borealis = page.region('mc-cards').split('<li class="mc-card').find(card => /Borealis/.test(card));
  assert.equal([...borealis.matchAll(/mc-dot is-live/g)].length, 3, 'five running pilots show three dots');
  assert.match(flat(borealis), /5 active agents/, 'and the number says five');
  const markup = page.markup();
  assert.ok(markup.indexOf('id="mc-feedpanel"') > 0 && markup.indexOf('id="mc-feedpanel"') < markup.indexOf('id="mc-live"'), 'feed first in the document');
  assert.ok(markup.indexOf('id="mc-live"') < markup.indexOf('id="mc-inspector"') && markup.indexOf('id="mc-inspector"') < markup.indexOf('id="mc-outputs"'));
});

test('a companion that cannot be reached from the start is a lost link with a retry, not an empty board', async t => {
  const w = await makeWorld(t);
  await seedBoard(w);
  const page = makePage(t, w);
  page.failing = true;
  page.mission.render({ package: { documents: [] } });
  page.mission.afterRender(true);
  await page.settle();
  assert.match(page.region('mc-strip'), /Checking for the local companion/, 'one failed answer is not a verdict yet');
  await page.poll();
  assert.match(page.region('mc-note'), /The link to the local companion was lost\. Nothing has loaded yet\./);
  assert.match(page.region('mc-note'), /data-mc="retry"/);
  assert.equal(page.region('mc-empty').trim(), '', 'no second message about the same thing');
  assert.equal(page.region('mc-cards').trim(), '');
  assert.equal(page.alert(), 'The local companion could not be reached.', 'said once in the alert region');
  assert.match(page.region('mc-strip'), /Link lost/);
  page.failing = false;
  await page.click('retry');
  await waitFor(() => /Atlas/.test(page.region('mc-cards')), { label: 'the board after a retry' });
  assert.equal(page.region('mc-note').trim(), '');
  assert.match(page.region('mc-strip'), /Local companion/);
});

/* ====================================================================== hygiene */

test('the markup has the roles, labels and live regions the page promises, and no inline style or handler', async t => {
  const w = await makeWorld(t);
  await seedBoard(w);
  const page = makePage(t, w);
  await page.mount();
  const markup = page.markup();
  assert.match(markup, /<div id="mc-root" class="mc-root"/);
  assert.match(markup, /<h1 class="mc-title">Mission Control<\/h1>/);
  assert.match(markup, /placeholder="Search tasks, runs, or outputs\.\.\."/);
  assert.match(markup, /<kbd class="mc-kbd" aria-hidden="true">Ctrl K<\/kbd>/);
  assert.match(markup, /id="mc-feed" class="mc-feed" tabindex="0" role="listbox" aria-label="Run feed"/);
  assert.equal([...markup.matchAll(/role="status"/g)].length, 1);
  assert.equal([...markup.matchAll(/role="alert"/g)].length, 1);
  assert.match(markup, /<ol id="mc-stepper"/);
  assert.doesNotMatch(markup + page.painted(), /\sstyle\s*=|\son[a-z]+\s*=\s*"/i);
  assert.doesNotMatch(markup + page.painted(), /https?:\/\//);
  assert.equal(page.document.title, 'Finance Task Studio', 'the page never touches the tab title');
  for (const a of page.buttons()) assert.equal(a.type, 'button', 'every button is a plain button');
  /* nothing in the page's text says a rate, a share or a verdict about the task itself */
  assert.doesNotMatch(page.text() + plain(page.painted()), /%|pass rate|success rate|failure rate|difficulty|caught|\bready\b|\bdone\b/i);
});

test('mission.js has no dynamic code, inline style, absolute URL, direct request or tab-title write', () => {
  const src = SOURCES['mission.js'];
  assert.doesNotMatch(src, /https?:\/\//);
  assert.doesNotMatch(src, /\beval\s*\(|new Function|XMLHttpRequest|WebSocket|sendBeacon|importScripts|EventSource|new Worker|\bimport\s*\(/);
  assert.doesNotMatch(src, /style\s*=\s*"/);
  assert.doesNotMatch(src, /\bfetch\s*\(/);
  assert.doesNotMatch(src, /document\.title\s*=(?!=)/);
  assert.doesNotMatch(src, /\bon(?:click|input|change|keydown|keyup|load|error|submit)\s*=\s*"/);
  assert.doesNotMatch(src, /data-(?:dash|ag)-|data-tab\b|data-action\b|data-bind\b/);
  const css = fs.readFileSync(path.join(REPO, 'mission.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /@import|url\s*\(|@font-face/i);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/i);
  const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map(m => Number(m[1]));
  assert.ok(sizes.length > 10 && sizes.every(n => n >= 12), 'no text under 12px: ' + sizes.filter(n => n < 12));
});
