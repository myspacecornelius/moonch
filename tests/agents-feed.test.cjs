'use strict';
/* Tests for the data Mission Control reads: the enriched round rows, GET /api/agents/runs (the run feed) and
   GET /api/agents/rounds/:id/runs/:n/log (a page of a run's transcript). See docs/local-agents.md sections 5 and 16.
   The companion runs on an ephemeral port with an agent service built on backend/agents/stub-claude.cjs, so no model is
   started and nothing leaves this machine. Every fixture is synthetic and lives in temporary folders removed afterwards. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { cleanEnv } = require('./fixtures/clean-env.cjs');

const { createServer, scrubLogText } = require('../backend/server.cjs');
const { createAgentService } = require('../backend/agents/index.cjs');
const { LOG_LIMITS } = require('../backend/agents/rounds.cjs');
const C = require('../backend/agents/constants.cjs');

const REPO = path.resolve(__dirname, '..');
const STUB = path.join(REPO, 'backend', 'agents', 'stub-claude.cjs');
const PROMPT = 'Assess the Atlas liquidity position using the supplied records and recommend whether the borrowing can proceed.';
const ACK = ['shell-access', 'network', 'isolation-by-audit'];
const GOLD = {
  gold: { decision: 'hold', figures: [{ label: 'Usable cash', value: '1,250', tolerance: 1 }], notes: 'Synthetic gold' },
  fingerprints: [{ id: 'fp-credit', label: 'Counts available credit as cash', tokens: ['available facility counted'], figures: [{ label: 'Wrong cash', value: 3050, tolerance: 1 }] }],
};
const GOLD_ANSWER = 'Usable cash is 1,250. Hold the borrowing.';
const WRONG_ANSWER = 'Cash is 3,050 because the available facility counted as cash. Proceed.';
/* Text from the gold, the fingerprints, the prompt and a pilot's answer: none of it may reach a running pilot. */
const SECRET_TEXT = ['Synthetic gold', 'fp-credit', 'Counts available credit as cash', 'available facility counted', 'Wrong cash', PROMPT, GOLD_ANSWER];
const SECRET_KEYS = ['"gold"', '"fingerprints"', '"promptText"', '"approvalSummary"', '"summarySha256"', '"sourceDir"', '"matches"', '"text"'];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, { timeout = 20000, interval = 20, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + label);
    await sleep(interval);
  }
}

/* ------------------------------------------------------------------ http client */

function request(port, { method = 'GET', path: urlPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const sent = {};
    for (const [name, value] of Object.entries(headers)) if (value !== undefined && value !== null) sent[name] = value;
    const payload = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    if (payload !== undefined) sent['Content-Length'] = payload.length;
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: sent, agent: false }, res => {
      const parts = [];
      res.on('data', part => parts.push(part));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/* ------------------------------------------------------------------ the synthetic world */

/* A clock that moves one second at every reading, so every time stamp the store writes differs and the order of events is
   the order of the readings. */
function steppingClock(start = '2026-03-01T09:00:00.000Z') {
  let ms = Date.parse(start);
  return () => { const at = new Date(ms); ms += 1000; return at; };
}

/* <base>/project (with private/), <base>/source (the packet), <base>/tmp (pilot folders). The scenario of the stub can be
   changed between rounds (w.scenario(...)): the store hands the pilots this very env object. */
async function makeWorld(t, scenario = {}, options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-feed-test-'));
  const projectRoot = path.join(base, 'project');
  const source = path.join(base, 'source');
  const tmpRoot = path.join(base, 'tmp');
  fs.mkdirSync(path.join(projectRoot, 'private'), { recursive: true });
  fs.mkdirSync(path.join(source, 'gaf'), { recursive: true });
  fs.mkdirSync(tmpRoot);
  fs.writeFileSync(path.join(source, 'Facility_Terms.txt'), 'Atlas facility terms, synthetic. Available credit is not cash received.\n');
  fs.writeFileSync(path.join(source, 'Cash_Facts.csv'), 'Label,Value\nOpening usable cash,100\nConfirmed funded draw,500\n');
  const env = { ...cleanEnv(), FINANCE_STUB_SCENARIO: JSON.stringify(scenario), ...(options.env || {}) };
  const service = options.service || createAgentService({ root: projectRoot, env, claudeBin: STUB, tmpRoot, limits: { killGraceMs: 200, ...(options.limits || {}) }, clock: options.clock });
  const logs = [];
  const app = createServer({ root: projectRoot, service, port: 0, log: message => logs.push(message) });
  const { port } = await app.listen();
  const origin = `http://127.0.0.1:${port}`;
  const w = {
    base, projectRoot, source, tmpRoot, env, service, app, logs, port,
    pilots: path.join(tmpRoot, 'finance-studio-pilots'),
    roundsDir: path.join(projectRoot, 'private', 'agent-rounds'),
    get: (urlPath, headers) => request(port, { path: urlPath, headers }),
    send: (method, urlPath, body, headers = {}) => request(port, {
      method, path: urlPath, body: body === undefined ? '{}' : body,
      headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Finance-Local': app.nonce, ...headers },
    }),
    scenario: value => { env.FINANCE_STUB_SCENARIO = JSON.stringify(value); },
  };
  w.post = (urlPath, body, headers) => w.send('POST', urlPath, body, headers);
  w.transcript = (id, n = 1) => path.join(w.roundsDir, id, 'runs', String(n), 'transcript.jsonl');
  t.after(async () => {
    await app.shutdown();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return w;
}

const roundBody = (w, extra = {}) => ({
  label: 'synthetic round',
  sourceDir: w.source,
  promptText: PROMPT,
  gafVisible: true,
  config: { model: 'claude-opus-5-5', effort: 'medium', count: 1 },
  ...extra,
});

async function createRound(w, extra) {
  const response = await w.post('/api/agents/rounds', roundBody(w, extra));
  assert.equal(response.status, 200, response.text);
  return response.json;
}

async function approvedRound(w, extra, gold = GOLD) {
  const created = await createRound(w, extra);
  const frozen = await w.post(`/api/agents/rounds/${created.id}/freeze`, gold);
  assert.equal(frozen.status, 200, frozen.text);
  const approved = await w.post(`/api/agents/rounds/${created.id}/approve`, { summarySha256: frozen.json.summarySha256, acknowledgements: ACK });
  assert.equal(approved.status, 200, approved.text);
  return approved.json;
}

/* create, freeze, approve, launch, and wait until the round has ended */
async function finishedRound(w, extra, gold) {
  const approved = await approvedRound(w, extra, gold);
  assert.equal((await w.post(`/api/agents/rounds/${approved.id}/launch`)).status, 200);
  await w.service.whenSettled(approved.id);
  return approved.id;
}

/* create, freeze, approve and launch a round, and wait until its first pilot is running */
async function runningRound(w, extra, gold) {
  const approved = await approvedRound(w, extra, gold);
  assert.equal((await w.post(`/api/agents/rounds/${approved.id}/launch`)).status, 200);
  await waitFor(async () => (await w.service.getRound(approved.id)).runs.some(run => run.state === 'running'), { label: 'a pilot to be running' });
  return approved.id;
}

const cancelRound = async (w, id) => {
  assert.equal((await w.post(`/api/agents/rounds/${id}/cancel`)).status, 200);
  await w.service.whenSettled(id);
};

const readLines = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

/* ====================================================================== enriched round rows */

test('a round row carries the task, the launch and end times, the latest freeze, the carried depth and the last activity', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER }, { clock: steppingClock() });
  const rows = async () => Object.fromEntries((await w.service.listRounds()).map(row => [row.id, row]));

  /* a draft */
  const draft = await w.service.createRound(roundBody(w, { label: 'Atlas round 1', task: '  Atlas  ' }));
  let row = (await rows())[draft.id];
  assert.equal(row.task, 'Atlas');
  assert.equal(row.launchedAt, null);
  assert.equal(row.endedAt, null);
  assert.equal(row.freezeVersion, null);
  assert.equal(row.freezePostHoc, false);
  assert.equal(row.contentSha256, null);
  assert.equal(row.carriedDepth, 0);
  assert.equal(row.lastActivityAt, draft.createdAt);

  /* frozen, approved, launched and ended: the last activity follows the latest event, whichever it is */
  const frozen = await w.service.freezeRound(draft.id, GOLD);
  row = (await rows())[draft.id];
  assert.equal(row.freezeVersion, 1);
  assert.equal(row.freezePostHoc, false);
  assert.equal(row.contentSha256, frozen.freeze.contentSha256);
  assert.equal(row.freezeSha256, frozen.freeze.sha256, 'the existing key is unchanged');
  assert.equal(row.lastActivityAt, frozen.freeze.frozenAt);
  const { summarySha256 } = await w.service.approvalSummary(draft.id);
  const approved = await w.service.approveRound(draft.id, { summarySha256, acknowledgements: ACK });
  assert.equal((await rows())[draft.id].lastActivityAt, approved.approval.approvedAt);
  await w.service.launchRound(draft.id);
  await w.service.whenSettled(draft.id);
  const ended = await w.service.getRound(draft.id);
  row = (await rows())[draft.id];
  assert.equal(row.launchedAt, ended.launchedAt);
  assert.equal(row.endedAt, ended.endedAt);
  assert.equal(row.status, 'finished');
  const times = view => [view.createdAt, view.launchedAt, view.endedAt, view.freeze.frozenAt, view.approval.approvedAt, ...view.postHocFreezes.map(freeze => freeze.frozenAt), ...view.runs.flatMap(run => [run.startedAt, run.endedAt])];
  const latest = list => list.filter(Boolean).sort().pop();
  assert.equal(row.lastActivityAt, latest(times(ended)), 'the latest of every time the round holds');
  assert.ok(ended.runs[0].startedAt > ended.launchedAt && ended.endedAt >= ended.runs[0].endedAt);

  /* a human verdict is activity */
  const classified = await w.service.classifyRun(draft.id, 1, { verdict: 'matches-frozen-gold', fingerprintIds: [], note: '' });
  assert.ok(classified.classification.human.at > ended.endedAt);
  assert.equal((await rows())[draft.id].lastActivityAt, classified.classification.human.at);

  /* a post-hoc freeze is the latest freeze: its version, its flag, its content hash */
  const posthoc = await w.service.refreezeRound(draft.id, { ...GOLD, gold: { ...GOLD.gold, notes: 'Synthetic post-hoc notes' } });
  row = (await rows())[draft.id];
  assert.equal(row.freezeVersion, 2);
  assert.equal(row.freezePostHoc, true);
  assert.equal(row.contentSha256, posthoc.postHocFreezes[0].contentSha256);
  assert.notEqual(row.contentSha256, frozen.freeze.contentSha256);
  assert.equal(row.freezeSha256, frozen.freeze.sha256, 'freezeSha256 stays the first freeze, as before');
  assert.equal(row.lastActivityAt, posthoc.postHocFreezes[0].frozenAt);
  assert.ok(row.lastActivityAt > classified.classification.human.at);

  /* a cancelled draft: its end is the last activity */
  const other = await w.service.createRound(roundBody(w, { label: 'to cancel' }));
  const cancelled = await w.service.cancelRound(other.id);
  row = (await rows())[other.id];
  assert.equal(row.endedAt, cancelled.endedAt);
  assert.equal(row.launchedAt, null);
  assert.equal(row.lastActivityAt, cancelled.endedAt);
  assert.equal(row.task, '', 'no task given: empty, not missing');
});

test('carriedDepth counts the carriedFrom steps along a lineage, and a loop, a missing origin or a hand edit cannot hang the list', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER });
  const root = await w.service.createRound(roundBody(w, { label: 'Atlas round 1', task: 'Atlas' }));
  await w.service.freezeRound(root.id, GOLD);
  const second = await w.service.nextRound(root.id);
  await w.service.freezeRound(second.id, GOLD);
  const third = await w.service.nextRound(second.id);
  await w.service.freezeRound(third.id, GOLD);
  const fourth = await w.service.nextRound(third.id);
  const unrelated = await w.service.createRound(roundBody(w, { label: 'Meridian round 1', task: 'Meridian' }));

  const depths = async service => Object.fromEntries((await service.listRounds()).map(row => [row.id, row.carriedDepth]));
  assert.deepEqual(await depths(w.service), { [root.id]: 0, [second.id]: 1, [third.id]: 2, [fourth.id]: 3, [unrelated.id]: 0 });
  assert.deepEqual((await w.service.listRounds()).map(row => row.task).sort(), ['Atlas', 'Atlas', 'Atlas', 'Atlas', 'Meridian'], 'the task is carried down the lineage');

  /* the round that was carried forward from an unknown round still counts that step; a self loop and a longer loop end */
  const edit = (id, change) => {
    const file = path.join(w.roundsDir, id, 'round.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    change(stored);
    fs.writeFileSync(file, JSON.stringify(stored));
  };
  edit(unrelated.id, stored => { stored.carriedFrom = 'rnd-ffffffffffff'; });
  edit(second.id, stored => { stored.carriedFrom = second.id; });
  edit(root.id, stored => { stored.carriedFrom = fourth.id; });
  const reloaded = createAgentService({ root: w.projectRoot, env: w.env, claudeBin: STUB, tmpRoot: w.tmpRoot });
  const looped = await depths(reloaded);
  assert.equal(looped[unrelated.id], 1);
  assert.equal(looped[second.id], 1, 'a round carried from itself');
  for (const id of [root.id, third.id, fourth.id]) assert.ok(Number.isInteger(looped[id]) && looped[id] >= 1 && looped[id] <= 4, `${id} ends: ${looped[id]}`);
});

test('the round list over HTTP carries the new row keys, and while a round runs it says null for the content hash only', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER });
  const first = await finishedRound(w, { label: 'Atlas round 1', task: 'Atlas' });
  const list = (await w.get('/api/agents/rounds')).json;
  assert.equal(list.redacted, undefined);
  const row = list.rounds[0];
  assert.deepEqual(Object.keys(row).sort(), ['carriedDepth', 'carriedFrom', 'config', 'counts', 'contentSha256', 'createdAt', 'endedAt', 'freezePostHoc', 'freezeSha256', 'freezeVersion', 'gafVisible', 'id', 'label', 'lastActivityAt', 'launchedAt', 'packetSha256', 'runCount', 'status', 'task'].sort());
  assert.match(row.contentSha256, /^[0-9a-f]{64}$/);

  w.scenario({ hang: true });
  const running = await runningRound(w, { label: 'Atlas round 2', task: 'Atlas' }, GOLD);
  const during = (await w.get('/api/agents/rounds')).json;
  assert.equal(during.redacted, true);
  assert.equal(during.rounds.length, 2);
  for (const each of during.rounds) {
    assert.equal(each.contentSha256, null, 'the hash of the gold is withheld in a row as it is in the round');
    assert.match(each.freezeSha256, /^[0-9a-f]{64}$/, 'the hashes the round view keeps stay');
    assert.equal(each.task, 'Atlas');
    assert.ok(each.lastActivityAt && each.freezeVersion === 1);
  }
  const text = JSON.stringify(during);
  for (const secret of SECRET_TEXT) assert.ok(!text.includes(secret), `the list leaks ${secret}`);
  await cancelRound(w, running);
  assert.match((await w.get('/api/agents/rounds')).json.rounds.find(item => item.id === first).contentSha256, /^[0-9a-f]{64}$/);
});

/* ====================================================================== the run feed */

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FEED_KEYS = ['arrivedAt', 'audit', 'classification', 'costUsd', 'endedAt', 'evidencePath', 'exitCode', 'failureReason', 'final', 'key', 'n', 'needsVerdict', 'numTurns', 'outputCount', 'requestedModel', 'resolvedModel', 'roundId', 'roundLabel', 'roundStatus', 'runId', 'startedAt', 'state', 'task', 'terminalReason', 'toolCalls', 'workingFolder'];

/* Three finished rounds of different tasks and states (a completed, a DISCARDED and a failed pilot; two answers; one pilot of a
   round with no task), on a clock that moves one second per reading. Tests add a round with a running and a waiting pilot. */
async function feedWorld(t) {
  const w = await makeWorld(t, {}, { clock: steppingClock() });
  const gold = { resultText: GOLD_ANSWER, writeFiles: [{ path: 'outputs/answer.txt', content: 'Usable cash 1,250\n' }] };
  const hosts = { toolUses: [{ name: 'Read', input: { file_path: '/etc/hosts' }, result: 'localhost' }], resultText: WRONG_ANSWER };
  w.scenario([gold, hosts, { exitCode: 1, resultText: 'partial' }]);
  const atlas1 = await finishedRound(w, { label: 'Atlas round 1', task: 'Atlas', config: { model: 'claude-opus-5-5', effort: 'medium', count: 3 } });
  w.scenario([gold, { resultText: WRONG_ANSWER }]);
  /* the second round is made from the form with the first as its origin, and a task typed with other capitals and spaces */
  const atlas2 = await finishedRound(w, { label: 'Atlas round 2', task: '  ATLAS ', carriedFrom: atlas1, config: { model: 'claude-opus-5-5', effort: 'medium', count: 2 } });
  w.scenario([gold]);
  const loose = await finishedRound(w, { label: 'loose round' });
  return { w, atlas1, atlas2, loose };
}

test('the feed: one row per run, newest first by arrivedAt, with every field of the contract', async t => {
  const { w, atlas1, atlas2, loose } = await feedWorld(t);
  w.scenario([{ toolUses: [{ name: 'Bash', input: { command: 'ls' }, result: 'ok' }], delayMs: 60000 }]);
  const meridian = await approvedRound(w, { label: 'Meridian round 1', task: 'Meridian', config: { model: 'claude-opus-5-5', effort: 'medium', count: 2, concurrency: 1 } });
  assert.equal((await w.post(`/api/agents/rounds/${meridian.id}/launch`)).status, 200);
  await waitFor(async () => (await w.service.getRound(meridian.id)).runs[0].state === 'running', { label: 'run 1 to run' });

  /* while the round runs: queued and running rows, nothing but states and counts */
  const during = await w.get('/api/agents/runs?limit=200');
  assert.equal(during.status, 200, during.text);
  assert.equal(during.json.redacted, true);
  assert.equal(during.json.runs.length, 3 + 2 + 1 + 2);
  const live = during.json.runs.filter(row => row.roundId === meridian.id);
  assert.deepEqual(live.map(row => row.key), [`${meridian.id}:1`, `${meridian.id}:2`], 'the pilot that started is newer than the one still waiting');
  const view = await w.service.getRound(meridian.id);
  assert.deepEqual(live.map(row => row.state), ['running', 'queued']);
  assert.equal(live[0].startedAt, view.runs[0].startedAt);
  assert.equal(live[0].arrivedAt, view.runs[0].startedAt);
  assert.equal(live[1].startedAt, null);
  assert.equal(live[1].arrivedAt, view.launchedAt, 'a pilot that has not started arrives with its launch');
  for (const row of live) {
    assert.equal(row.endedAt, null);
    assert.equal(row.audit, null);
    assert.equal(row.final, null);
    assert.equal(row.evidencePath, null, 'the evidence copy is made when a run ends');
    assert.equal(row.needsVerdict, false);
    assert.equal(row.classification, null);
    assert.equal(row.task, 'Meridian');
    assert.equal(row.roundStatus, 'running');
    assert.equal(row.roundLabel, 'Meridian round 1');
    assert.equal(row.workingFolder, `finance-studio-pilots/${row.runId}`);
    assert.deepEqual(Object.keys(row).sort(), FEED_KEYS);
  }
  const text = during.text;
  for (const secret of SECRET_TEXT) assert.ok(!text.includes(secret), `the feed leaks ${secret}`);
  for (const key of SECRET_KEYS) assert.ok(!text.includes(key), `the feed carries ${key}`);
  assert.ok(!text.includes(w.source) && !text.includes(w.projectRoot) && !text.includes(w.tmpRoot), 'no path on this machine');
  await cancelRound(w, meridian.id);

  /* after: the full list, redaction gone */
  const all = await w.get('/api/agents/runs?limit=200');
  assert.equal(all.status, 200, all.text);
  assert.equal(all.json.redacted, undefined);
  const rows = all.json.runs;
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.map(row => row.arrivedAt), [...rows.map(row => row.arrivedAt)].sort().reverse(), 'newest first');
  assert.equal(new Set(rows.map(row => row.key)).size, 8);

  /* the order is the order of arrivedAt, then round, then run number, worked out from the round views */
  const views = {};
  for (const id of [atlas1, atlas2, loose, meridian.id]) views[id] = (await w.get(`/api/agents/rounds/${id}`)).json;
  const expected = Object.values(views).flatMap(round => round.runs.map(run => ({ key: `${round.id}:${run.n}`, id: round.id, n: run.n, at: run.endedAt || run.startedAt || round.launchedAt || round.createdAt })))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : b.n - a.n));
  assert.deepEqual(rows.map(row => row.key), expected.map(item => item.key));
  assert.deepEqual(rows.map(row => row.arrivedAt), expected.map(item => item.at));

  /* every field of one finished row, against the round view and the run detail */
  const key = `${atlas1}:1`;
  const row = rows.find(item => item.key === key);
  const run = views[atlas1].runs[0];
  const detail = (await w.get(`/api/agents/rounds/${atlas1}/runs/1`)).json;
  assert.deepEqual(row, {
    key, roundId: atlas1, n: 1, runId: `${atlas1}-1`, roundLabel: 'Atlas round 1', task: 'Atlas', roundStatus: 'finished', state: 'completed',
    startedAt: run.startedAt, endedAt: run.endedAt, arrivedAt: run.endedAt, exitCode: 0, requestedModel: 'claude-opus-5-5', resolvedModel: run.resolvedModel,
    numTurns: run.numTurns, costUsd: run.costUsd, terminalReason: 'completed', failureReason: null, toolCalls: { total: 0, bash: 0, file: 0 },
    audit: { status: 'CLEAN', violationCount: 0 }, final: { chars: GOLD_ANSWER.length }, outputCount: 1, workingFolder: `finance-studio-pilots/${atlas1}-1`,
    evidencePath: `private/agent-rounds/${atlas1}/runs/1/outputs/`, classification: { suggestedVerdict: 'matches-frozen-gold', humanVerdict: null }, needsVerdict: true,
  });
  assert.match(row.startedAt, ISO);
  assert.deepEqual(detail.outputs.map(output => output.name), ['answer.txt']);
  assert.ok(fs.statSync(path.join(w.projectRoot, row.evidencePath)).isDirectory());

  /* needsVerdict: completed, audit CLEAN and no human verdict. A DISCARDED run, a failed run and a classified run do not */
  const byKey = Object.fromEntries(rows.map(item => [item.key, item]));
  assert.equal(byKey[`${atlas1}:1`].needsVerdict, true);
  assert.equal(byKey[`${atlas1}:2`].audit.status, 'DISCARDED');
  const discarded = (await w.get(`/api/agents/rounds/${atlas1}/runs/2`)).json;
  assert.equal(byKey[`${atlas1}:2`].audit.violationCount, discarded.audit.violations.length);
  assert.ok(discarded.audit.violations.length >= 1);
  assert.equal(byKey[`${atlas1}:2`].state, 'completed');
  assert.equal(byKey[`${atlas1}:2`].needsVerdict, false);
  assert.equal(byKey[`${atlas1}:2`].toolCalls.file, 1);
  assert.equal(byKey[`${atlas1}:3`].state, 'failed');
  assert.equal(byKey[`${atlas1}:3`].failureReason, 'exit-code');
  assert.equal(byKey[`${atlas1}:3`].exitCode, 1);
  assert.equal(byKey[`${atlas1}:3`].needsVerdict, false);
  assert.equal(byKey[`${atlas2}:2`].task, 'ATLAS', 'the task is kept as typed, one line');
  assert.equal(byKey[`${atlas2}:2`].classification.suggestedVerdict, 'fingerprint');
  assert.equal(byKey[`${atlas2}:2`].needsVerdict, true);
  assert.equal((await w.post(`/api/agents/rounds/${atlas2}/runs/2/classify`, { verdict: 'fingerprint', fingerprintIds: ['fp-credit'], note: '' })).status, 200);
  const after = (await w.get('/api/agents/runs?limit=200')).json.runs.find(item => item.key === `${atlas2}:2`);
  assert.equal(after.needsVerdict, false);
  assert.deepEqual(after.classification, { suggestedVerdict: 'fingerprint', humanVerdict: 'fingerprint' });

  /* cancelled pilots: the one that was running was finished by the store (evidence copy), the one that never started was not */
  assert.deepEqual([byKey[`${meridian.id}:1`].state, byKey[`${meridian.id}:2`].state], ['cancelled', 'cancelled']);
  assert.equal(byKey[`${meridian.id}:1`].evidencePath, `private/agent-rounds/${meridian.id}/runs/1/outputs/`);
  assert.equal(byKey[`${meridian.id}:2`].evidencePath, null);
  assert.equal(byKey[`${meridian.id}:2`].audit, null);
  assert.equal(byKey[`${meridian.id}:2`].roundStatus, 'cancelled');
  for (const item of rows) {
    const exists = item.evidencePath ? fs.existsSync(path.join(w.projectRoot, item.evidencePath)) : false;
    assert.equal(exists, item.evidencePath !== null, `${item.key}: the path is given exactly when the evidence copy exists`);
  }
  assert.equal(w.logs.length, 0, w.logs.join('\n'));
});

test('the feed filters: limit, task, round, and what they do together', async t => {
  const { w, atlas1, atlas2, loose } = await feedWorld(t);
  const feed = async query => {
    const response = await w.get('/api/agents/runs' + query);
    assert.equal(response.status, 200, `${query}: ${response.text}`);
    assert.deepEqual(Object.keys(response.json), ['runs']);
    return response.json.runs;
  };
  const full = await feed('');
  assert.equal(full.length, 6, 'the default limit (60) holds every run here');
  const keys = full.map(row => row.key);
  assert.deepEqual((await feed('?limit=200')).map(row => row.key), keys);
  assert.deepEqual((await feed('?limit=1')).map(row => row.key), keys.slice(0, 1));
  assert.deepEqual((await feed('?limit=4')).map(row => row.key), keys.slice(0, 4));
  assert.deepEqual((await feed('?limit=4&unknown=1&_=123')).map(row => row.key), keys.slice(0, 4), 'a name the route does not know is ignored');

  assert.deepEqual((await feed('?task=Atlas')).map(row => row.roundId).sort(), [atlas1, atlas1, atlas1, atlas2, atlas2].sort());
  assert.deepEqual((await feed('?task=%20%20aTLAS')).map(row => row.key), (await feed('?task=Atlas')).map(row => row.key), 'case and spaces do not matter');
  assert.deepEqual((await feed('?task=')).map(row => row.roundId), [loose], 'an empty task is the rounds without one');
  assert.deepEqual(await feed('?task=Borealis'), []);
  assert.deepEqual((await feed(`?round=${atlas1}`)).map(row => row.key), [`${atlas1}:3`, `${atlas1}:2`, `${atlas1}:1`].sort((a, b) => keys.indexOf(a) - keys.indexOf(b)));
  assert.deepEqual((await feed(`?round=${atlas2}&task=atlas`)).length, 2);
  assert.deepEqual(await feed(`?round=${atlas2}&task=Meridian`), [], 'filters are combined with and');
  assert.deepEqual((await feed(`?round=${atlas1}&limit=1`)).length, 1);
  assert.equal((await feed('?task=Atlas&limit=2')).length, 2);

  /* what is refused, and how */
  const refused = async (query, status, pattern) => {
    const response = await w.get('/api/agents/runs' + query);
    assert.equal(response.status, status, `${query}: ${response.text}`);
    assert.deepEqual(Object.keys(response.json), ['error'], query);
    assert.match(response.json.error, pattern, query);
  };
  for (const bad of ['0', '201', '-1', '1.5', 'abc', '', '0x10', '1e2', '+5', '007', '99999999999']) await refused('?limit=' + bad, 400, /limit must be a whole number from 1 to 200/);
  await refused('?limit=2&limit=3', 400, /more than once/);
  await refused('?task=a&task=b', 400, /more than once/);
  await refused('?task=' + 'x'.repeat(121), 400, /task is longer than 120/);
  assert.equal((await feed('?task=' + 'x'.repeat(120))).length, 0);
  for (const bad of ['BAD_ID', 'a', '', 'rnd_000000000000', 'x'.repeat(65), '..%2F..', 'rnd-0000%2F00000000']) await refused('?round=' + bad, 400, /not a valid round id/);
  await refused('?round=rnd-ffffffffffff', 404, /No such round/);
  await refused('?round=rnd-fff', 400, /not a valid round id/);

  /* methods and origins */
  const wrong = await w.post('/api/agents/runs', {});
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.allow, 'GET');
  assert.equal((await w.get('/api/agents/runs', { Origin: 'http://evil.example' })).status, 403);
  assert.equal(w.logs.length, 0, w.logs.join('\n'));
});

test('the feed is read from memory: it never opens a file, and a feed of many runs is one pass', async t => {
  const { w } = await feedWorld(t);
  const realOpen = fs.openSync;
  const realRead = fs.readFileSync;
  const touched = [];
  fs.openSync = (...args) => { touched.push(String(args[0])); return realOpen.apply(fs, args); };
  fs.readFileSync = (...args) => { touched.push(String(args[0])); return realRead.apply(fs, args); };
  try {
    const response = await w.get('/api/agents/runs?limit=200');
    assert.equal(response.status, 200);
    assert.equal(response.json.runs.length, 6);
  } finally {
    fs.openSync = realOpen;
    fs.readFileSync = realRead;
  }
  assert.deepEqual(touched.filter(file => file.includes('agent-rounds') || file.includes('finance-studio-pilots')), [], 'no round or transcript file was read');
});

/* ====================================================================== the run log */

/* Strings that must never reach a browser while a round runs. The tool input and the tool result are the pilot's own text. */
const SECRET_CMD = 'SECRET-CMD-6f1c0a93d2';
const SECRET_OUT = 'SECRET-OUT-b2d84e1790';
const SECRET_FINAL = 'SECRET-FINAL-91ac5e07';
const OUTSIDE_DIR = '/home/someone-else/secret-project';
const BIG_RESULT = 'x'.repeat(5000);
const LOG_KEYS = new Set(['seq', 'at', 'kind', 'tool', 'chars', 'relPath', 'text']);
const WITHHELD_LINE_KEYS = new Set(['seq', 'at', 'kind', 'tool', 'chars']);

/* The scenario of a pilot that reads, writes and runs commands, with text a reader must not see while a round runs. */
function loggedScenario(folder, { running = false } = {}) {
  return {
    toolUses: [
      { name: 'Bash', input: { command: `cat ${folder}/filesystem/Facility_Terms.txt && echo ${SECRET_CMD}` }, result: `Atlas facility terms, synthetic.\n${SECRET_OUT} read from ${OUTSIDE_DIR}/notes.txt` },
      { name: 'Read', input: { file_path: `${folder}/filesystem/Cash_Facts.csv` }, result: 'Label,Value' },
      { name: 'Read', input: { file_path: '/etc/hosts' }, result: 'localhost' },
      { name: 'Write', input: { file_path: 'outputs/answer.txt', content: 'Usable cash 1,250' }, result: 'File written' },
      { name: 'Bash', input: { command: 'cat filesystem/big.txt' }, result: BIG_RESULT },
      { name: 'Read', input: { file_path: '../escape.txt' }, result: 'no' },
    ],
    resultText: `${GOLD_ANSWER} ${SECRET_FINAL} Notes in ${OUTSIDE_DIR}/final.txt and in __PROJECT_ROOT__/private/x`,
    ...(running ? { delayMs: 60000 } : {}),
  };
}

/* A round of one pilot with the logged scenario. running: the pilot waits after its last tool call (until it is cancelled). */
async function loggedRound(w, { running = false, label = 'Atlas log round' } = {}) {
  const approved = await approvedRound(w, { label });
  w.scenario(JSON.parse(JSON.stringify(loggedScenario(path.join(w.pilots, `${approved.id}-1`), { running })).split('__PROJECT_ROOT__').join(w.projectRoot)));
  assert.equal((await w.post(`/api/agents/rounds/${approved.id}/launch`)).status, 200);
  if (!running) { await w.service.whenSettled(approved.id); return approved.id; }
  await waitFor(() => fs.existsSync(w.transcript(approved.id)) && fs.readFileSync(w.transcript(approved.id), 'utf8').includes(SECRET_CMD), { label: 'the secret to be in the transcript' });
  await waitFor(() => readLines(w.transcript(approved.id)).length >= 13, { label: 'the tool calls to be in the transcript' });
  return approved.id;
}

const logUrl = (id, n = 1, query = '') => `/api/agents/rounds/${id}/runs/${n}/log${query}`;

const EXPECTED_KINDS = ['init', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'result'];

/* a path that starts with / (or a drive, or ~/) where no path character comes before it */
const ABSOLUTE_PATH = /(?:^|[\s"'`(=:,;|&<>{[])(?:\/(?!\/)[^\s]|~\/|[A-Za-z]:[\\/])/;

test('while ANY round runs, a log page holds only kind, tool name, length and time per line: not a byte of text, command, path or tool input', async t => {
  const w = await makeWorld(t);
  const ended = await loggedRound(w);
  const live = await loggedRound(w, { running: true, label: 'Atlas live round' });
  assert.equal((await w.service.getRound(live)).status, 'running');
  const transcript = readLines(w.transcript(live));
  assert.ok(transcript.join('\n').includes(SECRET_CMD), 'the secret is in the file the route reads');

  const fullTranscript = readLines(w.transcript(ended)).length;
  assert.equal(fullTranscript, 14);
  for (const [name, id, expectedLines] of [['an ended run of another round', ended, 14], ['the running run', live, transcript.length]]) {
    const response = await w.get(logUrl(id));
    assert.equal(response.status, 200, response.text);
    const page = response.json;
    assert.equal(page.withheld, true, name);
    assert.equal(page.redacted, true, name);
    assert.deepEqual(Object.keys(page).sort(), ['done', 'lines', 'next', 'redacted', 'withheld'], name);
    assert.equal(page.lines.length, expectedLines, name);
    assert.equal(page.next, expectedLines, name);
    assert.deepEqual(page.lines.map(line => line.seq), Array.from({ length: expectedLines }, (_, index) => index + 1), name);
    assert.deepEqual(page.lines.map(line => line.kind), EXPECTED_KINDS.slice(0, expectedLines), name);
    for (const line of page.lines) {
      for (const key of Object.keys(line)) assert.ok(WITHHELD_LINE_KEYS.has(key), `${name}: a withheld line carries ${key}`);
      if (line.tool !== undefined) assert.ok(C.TOOLS.includes(line.tool), `${name}: ${line.tool}`);
      assert.ok(line.at === null || ISO.test(line.at));
    }
    /* what stays: the name of the tool and how long the text was */
    assert.deepEqual(page.lines.filter(line => line.tool).map(line => line.tool), ['Bash', 'Read', 'Read', 'Write', 'Bash', 'Read'].slice(0, page.lines.filter(line => line.tool).length));
    if (id === ended) {
      assert.equal(page.lines[10].chars, BIG_RESULT.length, 'the length of a result is known');
      assert.equal(page.lines[2].chars, `Atlas facility terms, synthetic.\n${SECRET_OUT} read from ${OUTSIDE_DIR}/notes.txt`.length);
      assert.equal(page.done, true, 'the run has ended and the file is read to its end');
    } else {
      assert.equal(page.done, false, 'the run has not ended');
    }
    /* not a byte of what the pilot did or said, in any form */
    for (const needle of [SECRET_CMD, SECRET_OUT, SECRET_FINAL, OUTSIDE_DIR, '/etc/hosts', 'etc/hosts', 'localhost', 'Facility_Terms', 'Cash_Facts', 'answer.txt', 'escape.txt', 'Usable cash', 'xxxxxxxx', w.base, w.projectRoot, w.pilots, 'finance-studio-pilots', 'filesystem', 'Session started', 'claude-opus-5-5']) {
      assert.ok(!response.text.includes(needle), `${name}: the log page leaks ${needle}`);
    }
    /* as keys: a kind is allowed to be the word text or result */
    for (const key of ['"text":', '"relPath":', '"command":', '"file_path":', '"content":', '"input":', '"result":', '"message":', '"cwd":', '"gold":', '"fingerprints":', '"promptText":', '"approvalSummary":', '"summarySha256":', '"sourceDir":', '"matches":']) assert.ok(!response.text.includes(key), `${name}: the log page carries ${key}`);
    for (const secret of SECRET_TEXT) assert.ok(!response.text.includes(secret), `${name}: ${secret}`);
  }

  /* a page of a later cursor withholds the same way, and the parameters are still checked */
  const later = await w.get(logUrl(live, 1, '?after=3&limit=2'));
  assert.equal(later.status, 200);
  assert.deepEqual(later.json.lines.map(line => line.seq), [4, 5]);
  assert.equal(later.json.withheld, true);
  assert.equal((await w.get(logUrl(live, 1, '?limit=0'))).status, 400);
  assert.equal((await w.get(logUrl(live, 2))).status, 404);

  /* the round ends: the same route now answers with the text */
  await cancelRound(w, live);
  const after = await w.get(logUrl(live));
  assert.equal(after.status, 200, after.text);
  assert.equal(after.json.withheld, false);
  assert.equal(after.json.redacted, undefined);
  assert.ok(after.json.lines.some(line => (line.text || '').includes(SECRET_CMD)), 'the full view returns when no round runs');
  assert.equal(after.json.lines.length, transcript.length, 'the same lines, now with their text');
  assert.equal(after.json.done, true);
  const earlier = (await w.get(logUrl(ended))).json;
  assert.equal(earlier.withheld, false);
  assert.ok(earlier.lines.some(line => (line.text || '').includes(SECRET_OUT)));
  assert.equal(w.logs.length, 0, w.logs.join('\n'));
});

test('with no round running, a line carries kind, tool, length, a relative path and text: capped at 2000 characters, with no absolute path', async t => {
  const w = await makeWorld(t);
  const id = await loggedRound(w);
  const response = await w.get(logUrl(id));
  assert.equal(response.status, 200, response.text);
  const page = response.json;
  assert.deepEqual(Object.keys(page).sort(), ['done', 'lines', 'next', 'withheld']);
  assert.equal(page.withheld, false);
  assert.equal(page.done, true);
  assert.equal(page.next, 14);
  assert.deepEqual(page.lines.map(line => line.seq), Array.from({ length: 14 }, (_, index) => index + 1));
  assert.deepEqual(page.lines.map(line => line.kind), EXPECTED_KINDS);
  for (const line of page.lines) for (const key of Object.keys(line)) assert.ok(LOG_KEYS.has(key), key);

  const line = number => page.lines[number - 1];
  assert.equal(line(1).text, 'Session started with model claude-opus-5-5.');
  assert.equal(line(1).tool, undefined);
  /* a tool call: the tool, the command with the pilot's own folder written as ".", and the length of the input */
  assert.equal(line(2).tool, 'Bash');
  assert.equal(line(2).text, `cat ./filesystem/Facility_Terms.txt && echo ${SECRET_CMD}`);
  assert.equal(line(2).chars, JSON.stringify({ command: `cat ${path.join(w.pilots, `${id}-1`)}/filesystem/Facility_Terms.txt && echo ${SECRET_CMD}` }).length);
  assert.equal(line(2).relPath, undefined);
  /* a tool result: no tool name, the text of the result */
  assert.equal(line(3).tool, undefined);
  assert.equal(line(3).text, `Atlas facility terms, synthetic.\n${SECRET_OUT} read from <path>`);
  /* a path inside the pilot folder is given relative to it; one outside it, or with .., is not given */
  assert.equal(line(4).tool, 'Read');
  assert.equal(line(4).relPath, 'filesystem/Cash_Facts.csv');
  assert.equal(line(4).text, './filesystem/Cash_Facts.csv');
  assert.equal(line(6).tool, 'Read');
  assert.equal(line(6).relPath, undefined);
  assert.equal(line(6).text, '<path>');
  assert.equal(line(8).tool, 'Write');
  assert.equal(line(8).relPath, 'outputs/answer.txt');
  assert.equal(line(8).text, 'outputs/answer.txt', 'the content that was written is not part of the line');
  assert.equal(line(12).relPath, undefined);
  assert.equal(line(12).text, '../escape.txt');
  /* long text is cut to 2000 characters and says how long it was */
  assert.equal(line(11).chars, BIG_RESULT.length);
  assert.equal(line(11).text.length, 2000);
  assert.equal(line(11).text, BIG_RESULT.slice(0, 2000));
  /* the answer */
  assert.equal(line(14).kind, 'result');
  assert.ok(line(14).text.startsWith(`${GOLD_ANSWER} ${SECRET_FINAL} Notes in <path> and in `));
  assert.ok(line(14).text.includes('<server path>'), 'the redactor the server uses for its own folders');
  assert.equal(line(14).chars, (await w.service.getRun(id, 1)).final.chars);

  /* no absolute path anywhere in the page */
  for (const each of page.lines) {
    assert.ok(!ABSOLUTE_PATH.test(each.text || ''), `an absolute path in line ${each.seq}: ${each.text}`);
    if (each.relPath) assert.ok(!each.relPath.startsWith('/') && !each.relPath.includes('..'), each.relPath);
  }
  for (const needle of [OUTSIDE_DIR, '/etc/hosts', w.base, w.projectRoot, w.pilots, w.tmpRoot, os.tmpdir() + '/finance']) assert.ok(!response.text.includes(needle), `the page echoes ${needle}`);
  assert.equal(w.logs.length, 0, w.logs.join('\n'));
});

test('a cursor pages the log: after, next and limit give every line once, in order, and done comes with the last one', async t => {
  const w = await makeWorld(t);
  const id = await loggedRound(w);
  const everything = (await w.get(logUrl(id, 1, '?limit=200'))).json;
  assert.equal(everything.lines.length, 14);
  for (const limit of [1, 3, 5, 13, 14, 15, 100, 200]) {
    const seen = [];
    let after = 0;
    let pages = 0;
    for (;;) {
      const response = await w.get(logUrl(id, 1, `?after=${after}&limit=${limit}`));
      assert.equal(response.status, 200, response.text);
      const page = response.json;
      pages++;
      assert.ok(page.lines.length <= limit, 'a page holds at most limit lines');
      for (const line of page.lines) assert.ok(line.seq > after, 'a page starts after the cursor');
      seen.push(...page.lines);
      if (page.lines.length) assert.equal(page.next, page.lines[page.lines.length - 1].seq, 'next is the last line given');
      assert.ok(page.next >= after);
      if (page.done) { assert.equal(page.lines.length < limit || page.next === 14, true); after = page.next; break; }
      assert.ok(page.lines.length > 0, 'a page that is not the last one is not empty');
      after = page.next;
      assert.ok(pages < 30, 'the cursor moves');
    }
    assert.equal(after, 14, `limit ${limit}: next reached the end`);
    assert.deepEqual(seen, everything.lines, `limit ${limit}: every line exactly once, in order`);
  }
  /* done is not claimed early: with limit 5 the third page ends at line 14 only because the file ends there */
  const third = (await w.get(logUrl(id, 1, '?after=10&limit=4'))).json;
  assert.deepEqual(third.lines.map(line => line.seq), [11, 12, 13, 14]);
  assert.equal(third.done, false, 'a full page does not know that the end was reached');
  const empty = (await w.get(logUrl(id, 1, '?after=14'))).json;
  assert.deepEqual(empty, { lines: [], next: 14, done: true, withheld: false });
  /* a cursor past the end is brought back to the end of the file */
  const past = (await w.get(logUrl(id, 1, '?after=999&limit=5'))).json;
  assert.deepEqual(past, { lines: [], next: 14, done: true, withheld: false });
  const middle = (await w.get(logUrl(id, 1, '?after=5&limit=2'))).json;
  assert.deepEqual(middle.lines.map(line => line.seq), [6, 7]);
  assert.equal(middle.next, 7);
  assert.equal(middle.done, false);
});

test('a run that has not started has an empty log that is not done; one that never will has an empty log that is', async t => {
  const w = await makeWorld(t, { delayMs: 60000 });
  const approved = await approvedRound(w, { label: 'waiting', config: { model: 'claude-opus-5-5', effort: 'medium', count: 2, concurrency: 1 } });
  assert.equal((await w.post(`/api/agents/rounds/${approved.id}/launch`)).status, 200);
  await waitFor(async () => (await w.service.getRound(approved.id)).runs[0].state === 'running', { label: 'run 1 to run' });
  await waitFor(() => fs.existsSync(w.transcript(approved.id)) && readLines(w.transcript(approved.id)).length >= 1, { label: 'the init line' });
  const waiting = await w.get(logUrl(approved.id, 2));
  assert.equal(waiting.status, 200, waiting.text);
  assert.deepEqual(waiting.json, { lines: [], next: 0, done: false, withheld: true, redacted: true });
  await cancelRound(w, approved.id);
  const cancelled = (await w.service.getRound(approved.id)).runs.map(run => run.state);
  assert.deepEqual(cancelled, ['cancelled', 'cancelled']);
  assert.deepEqual((await w.get(logUrl(approved.id, 2))).json, { lines: [], next: 0, done: true, withheld: false });
  const first = (await w.get(logUrl(approved.id, 1))).json;
  assert.equal(first.done, true);
  assert.equal(first.lines[0].kind, 'init');
  assert.equal(first.lines[0].text, 'Session started with model claude-opus-5-5.');
});

/* ---------------------------------------------------------------------- transcripts written by hand */

const event = (type, extra = {}) => JSON.stringify({ type, ...extra });
const textEvent = (text, extra = {}) => event('assistant', { message: { content: [{ type: 'text', text }] }, ...extra });

/* A finished round whose transcript is replaced by the given text, so a case can be built to the byte. */
async function craftedRound(w, content) {
  const id = await finishedRound(w, {}, GOLD);
  fs.writeFileSync(w.transcript(id), content);
  return id;
}

test('a half written last line is never a line, and neither is anything parsed from it; it becomes one when its newline arrives', async t => {
  const w = await makeWorld(t, [{ hang: true }]);
  const id = await runningRound(w);
  const file = w.transcript(id);
  await waitFor(() => fs.existsSync(file) && readLines(file).length === 1, { label: 'the init line' });
  const page = async () => (await w.get(logUrl(id))).json;
  assert.deepEqual((await page()).lines.map(line => line.kind), ['init']);

  /* the pilot is waiting: it writes nothing, so this stands for a write that is half done */
  const half = textEvent('half way through a sentence');
  const cut = half.length - 12;
  fs.appendFileSync(file, half.slice(0, cut));
  let current = await page();
  assert.deepEqual(current.lines.map(line => line.seq), [1], 'the half line is not offered');
  assert.equal(current.next, 1);
  assert.equal(current.done, false);
  fs.appendFileSync(file, half.slice(cut, cut + 3));
  current = await page();
  assert.equal(current.lines.length, 1, 'still no newline');
  fs.appendFileSync(file, half.slice(cut + 3) + '\n');
  current = await page();
  assert.deepEqual(current.lines.map(line => [line.seq, line.kind, line.chars]), [[1, 'init', undefined], [2, 'text', 'half way through a sentence'.length]]);
  const next = (await w.get(logUrl(id, 1, '?after=1'))).json;
  assert.deepEqual(next.lines.map(line => line.seq), [2]);
  await cancelRound(w, id);
  const final = (await w.get(logUrl(id))).json;
  assert.equal(final.lines[1].text, 'half way through a sentence');
  assert.equal(final.done, true);
});

test('a run that has ended with an unfinished last line (a crash) is done, and the fragment is still not a line', async t => {
  const w = await makeWorld(t);
  const id = await craftedRound(w, event('system', { subtype: 'init', model: 'claude-opus-5-5' }) + '\n' + textEvent('one') + '\n' + '{"type":"assistant","message":{"content":[{"type":"text","text":"unfin');
  const page = (await w.get(logUrl(id))).json;
  assert.deepEqual(page.lines.map(line => line.seq), [1, 2]);
  assert.equal(page.next, 2);
  assert.equal(page.done, true, 'nothing will ever finish that line');
  assert.ok(!JSON.stringify(page).includes('unfin'));
});

test('lines that are not events become system lines with a fixed text: bad JSON, blank lines, other JSON, unknown events', async t => {
  const w = await makeWorld(t);
  const lines = [
    event('system', { subtype: 'init', model: 'claude-opus-5-5' }),
    'not json {SECRET-JUNK-77',
    '',
    '42',
    '[1,2]',
    '"a string"',
    '{"foo": "SECRET-OBJECT-88"}',
    '{"type": 7}',
    textEvent('hello', { timestamp: '2026-03-01T10:00:00Z' }),
    textEvent('bad time', { timestamp: 'yesterday' }),
    event('rate_limit_event', { info: 'SECRET-EVENT-99' }),
    event('system', { subtype: 'hook_started', detail: 'SECRET-SYSTEM-11' }),
    event('system', { subtype: 'not a token!' }),
    event('assistant', { message: { content: [{ type: 'thinking', thinking: 'SECRET-THOUGHT-22' }] } }),
    event('user', { message: { content: 'SECRET-PROMPT-33' } }),
    event('result', { subtype: 'error_max_budget_usd', is_error: true, errors: ['Reached maximum budget ($3)'] }),
    event('result', { subtype: 'error_during_execution', is_error: true }),
    event('result', { subtype: 'success', result: 'done' }),
    '   ',
    '\r',
  ];
  const id = await craftedRound(w, lines.join('\n') + '\n');
  const response = await w.get(logUrl(id, 1, '?limit=200'));
  assert.equal(response.status, 200, response.text);
  const page = response.json;
  assert.equal(page.lines.length, lines.length);
  const MALFORMED = 'This line is not a readable event.';
  const summary = page.lines.map(line => [line.seq, line.kind, line.text]);
  assert.deepEqual(summary.slice(0, 9), [
    [1, 'init', 'Session started with model claude-opus-5-5.'],
    [2, 'system', MALFORMED], [3, 'system', MALFORMED], [4, 'system', MALFORMED], [5, 'system', MALFORMED], [6, 'system', MALFORMED], [7, 'system', MALFORMED], [8, 'system', MALFORMED],
    [9, 'text', 'hello'],
  ]);
  assert.equal(page.lines[1].chars, lines[1].length, 'the length is given, the content is not');
  assert.equal(page.lines[8].at, '2026-03-01T10:00:00.000Z');
  assert.equal(page.lines[9].at, null, 'a time stamp that is not a date is not passed on');
  assert.deepEqual(summary.slice(10, 16), [
    [11, 'system', 'Event: rate_limit_event.'],
    [12, 'system', 'System event: hook_started.'],
    [13, 'system', 'System event.'],
    [14, 'system', 'The model took a step that is not shown.'],
    [15, 'system', 'A message was sent to the model.'],
    [16, 'error', 'Reached maximum budget ($3)'],
  ]);
  assert.deepEqual(summary.slice(16, 18), [[17, 'error', 'The run ended with error_during_execution.'], [18, 'result', 'done']]);
  assert.deepEqual(summary.slice(18).map(item => item[1]), ['system', 'system']);
  for (const secret of ['SECRET-JUNK-77', 'SECRET-OBJECT-88', 'SECRET-EVENT-99', 'SECRET-SYSTEM-11', 'SECRET-THOUGHT-22', 'SECRET-PROMPT-33']) assert.ok(!response.text.includes(secret), `a fixed text, not ${secret}`);
  assert.deepEqual(page.lines.map(line => line.seq), Array.from({ length: lines.length }, (_, index) => index + 1), 'one record per line of the file, blank lines included');
});

test('a multibyte character that straddles a read boundary is not broken, and a UTF-8 line is decoded as a whole', async t => {
  const w = await makeWorld(t);
  const head = '{"type":"assistant","message":{"content":[{"type":"text","text":"';
  const fill = 'a'.repeat(LOG_LIMITS.chunk - head.length - 1);
  const line = head + fill + 'é€😀é"}]}}';
  assert.equal(Buffer.from(line).indexOf(Buffer.from('é')), LOG_LIMITS.chunk - 1, 'the two bytes of the first é straddle the 64 KB boundary');
  const id = await craftedRound(w, line + '\n' + textEvent('after') + '\n');
  const page = (await w.get(logUrl(id))).json;
  assert.equal(page.lines.length, 2);
  assert.equal(page.lines[0].text, (fill + 'é€😀é').slice(0, 2000), 'cut at 2000 characters');
  assert.equal(page.lines[0].chars, fill.length + 'é€😀é'.length);
  assert.ok(!page.lines[0].text.includes('\ufffd'));
  assert.equal(page.lines[1].text, 'after');
  /* the cut never leaves half of a surrogate pair */
  const emoji = 'a' + '😀'.repeat(1500);
  const id2 = await craftedRound(w, textEvent(emoji) + '\n');
  const cut = (await w.get(logUrl(id2))).json.lines[0];
  assert.equal(cut.chars, 3001);
  assert.equal(cut.text.length, 1999, 'the cut would fall inside a pair, so it is made before it');
  assert.equal(cut.text, emoji.slice(0, 1999));
  assert.equal(JSON.stringify(cut.text).includes('\\ud83d"'), false, 'no lone surrogate at the end');
});

test('a line longer than the parse limit is counted, not read into memory or parsed; a 17 MB line costs one page, not the server', { timeout: 60000 }, async t => {
  const w = await makeWorld(t);
  const prefix = Buffer.from('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"x","content":"');
  const suffix = Buffer.from('"}]}}\n');
  const huge = 17 * 1024 * 1024;
  const id = await finishedRound(w);
  const file = w.transcript(id);
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, textEvent('before') + '\n');
  fs.writeSync(fd, prefix); fs.writeSync(fd, Buffer.alloc(huge, 0x41)); fs.writeSync(fd, suffix);
  fs.writeSync(fd, textEvent('after the huge line') + '\n');
  fs.writeSync(fd, prefix); fs.writeSync(fd, Buffer.alloc(LOG_LIMITS.parseBytes - 1000, 0x42)); fs.writeSync(fd, suffix);
  fs.writeSync(fd, textEvent('last') + '\n');
  fs.closeSync(fd);

  const reads = spyReads();
  let response;
  try { response = await w.get(logUrl(id, 1, '?limit=200')); } finally { reads.stop(); }
  assert.equal(response.status, 200, response.text.slice(0, 300));
  assert.ok(response.text.length < 10000, 'the answer is small: ' + response.text.length);
  const page = response.json;
  assert.deepEqual(page.lines.map(line => [line.seq, line.kind]), [[1, 'text'], [2, 'system'], [3, 'text'], [4, 'tool'], [5, 'text']]);
  assert.equal(page.lines[1].chars, prefix.length + huge + suffix.length - 1, 'the size of the line in bytes');
  assert.equal(page.lines[1].text, `This line is ${prefix.length + huge + suffix.length - 1} bytes long, too long to show.`);
  assert.equal(page.lines[2].text, 'after the huge line');
  assert.equal(page.lines[3].text.length, 2000, 'a line just under the limit is parsed and its text capped');
  assert.equal(page.lines[3].chars, LOG_LIMITS.parseBytes - 1000);
  assert.equal(page.lines[4].text, 'last');
  assert.ok(Math.max(...reads.calls.map(call => call.length)) <= LOG_LIMITS.chunk, 'the file is read in chunks of ' + LOG_LIMITS.chunk);
  assert.equal(page.done, true);
  /* while a round runs the huge line is a kind and a length */
  w.scenario({ hang: true });
  const live = await runningRound(w);
  const during = (await w.get(logUrl(id, 1, '?limit=200'))).json;
  assert.equal(during.withheld, true);
  assert.deepEqual(during.lines.map(line => line.kind), ['text', 'system', 'text', 'tool', 'text']);
  assert.equal(during.lines[1].chars, page.lines[1].chars);
  assert.equal(during.lines[1].text, undefined);
  await cancelRound(w, live);
});

/* fs.readSync, counted: how many bytes a request read from the file, and where */
function spyReads() {
  const real = fs.readSync;
  const calls = [];
  fs.readSync = function spy(fd, buffer, offset, length, position) {
    const got = real.apply(fs, arguments);
    calls.push({ length, position, got });
    return got;
  };
  return { calls, stop: () => { fs.readSync = real; }, bytes: () => calls.reduce((sum, call) => sum + Math.max(0, call.got), 0) };
}

test('one request reads at most 64 MB of the file, whatever its size; the index lets the next one go on', { timeout: 60000 }, async t => {
  const w = await makeWorld(t);
  const id = await finishedRound(w);
  const file = w.transcript(id);
  const first = textEvent('first') + '\n';
  fs.writeFileSync(file, first);
  /* a 200 MB file that is one line without an end: nothing in it can ever be a line */
  fs.truncateSync(file, 200 * 1024 * 1024);
  const reads = spyReads();
  let response;
  try { response = await w.get(logUrl(id, 1, '?limit=200')); } finally { reads.stop(); }
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.lines.map(line => line.text), ['first']);
  assert.equal(response.json.next, 1);
  assert.equal(response.json.done, false, 'the end of the file was not reached');
  assert.ok(reads.bytes() <= LOG_LIMITS.scanBytes + LOG_LIMITS.chunk, `read ${reads.bytes()} bytes`);
  assert.ok(reads.bytes() >= LOG_LIMITS.scanBytes, 'it went on up to the limit');
  assert.ok(reads.bytes() < 200 * 1024 * 1024 / 2, 'and no further');
});

test('a request for the first page of a large log reads about a page, not the file', { timeout: 60000 }, async t => {
  const w = await makeWorld(t);
  const id = await finishedRound(w);
  const file = w.transcript(id);
  const rows = Array.from({ length: 60000 }, (_, index) => textEvent(`row ${index + 1} of the synthetic transcript`));
  fs.writeFileSync(file, rows.join('\n') + '\n');
  const size = fs.statSync(file).size;
  assert.ok(size > 3 * 1024 * 1024);
  const reads = spyReads();
  let page;
  try { page = (await w.get(logUrl(id, 1, '?limit=5'))).json; } finally { reads.stop(); }
  assert.deepEqual(page.lines.map(line => line.text), [1, 2, 3, 4, 5].map(index => `row ${index} of the synthetic transcript`));
  assert.ok(reads.bytes() <= LOG_LIMITS.chunk, `read ${reads.bytes()} of ${size} bytes`);
  assert.equal(page.done, false);
  /* the last page of the same file: the cursor is a line number, the index finds the place */
  for (let after = 5; after < 59990; after += 200) assert.equal((await w.get(logUrl(id, 1, `?after=${after}&limit=200`))).status, 200);
  const tail = (await w.get(logUrl(id, 1, '?after=59995&limit=200'))).json;
  assert.deepEqual(tail.lines.map(line => line.seq), [59996, 59997, 59998, 59999, 60000]);
  assert.equal(tail.done, true);
});

test('the index of a run remembers where lines start: a follow-up page reads only what was added, a seek starts at a nearby point, and a restart or a replaced file is read again from the start', { timeout: 60000 }, async t => {
  const w = await makeWorld(t);
  const id = await finishedRound(w);
  const file = w.transcript(id);
  const rows = Array.from({ length: 5000 }, (_, index) => textEvent(`row ${index + 1}`));
  const starts = [];
  let offset = 0;
  for (const row of rows) { starts.push(offset); offset += Buffer.byteLength(row) + 1; }
  fs.writeFileSync(file, rows.slice(0, 3).join('\n') + '\n');
  const small = fs.statSync(file).size;
  assert.equal((await w.get(logUrl(id))).json.next, 3);

  /* lines are appended: the next page starts at the byte where the last one ended */
  fs.appendFileSync(file, rows.slice(3, 7).join('\n') + '\n');
  let reads = spyReads();
  let page;
  try { page = (await w.get(logUrl(id, 1, '?after=3'))).json; } finally { reads.stop(); }
  assert.deepEqual(page.lines.map(line => line.text), ['row 4', 'row 5', 'row 6', 'row 7']);
  assert.equal(reads.calls[0].position, small, 'the first read is at the end of what was read before');
  assert.equal(page.next, 7);

  /* the whole file, then a seek into the middle of it */
  fs.writeFileSync(file, rows.join('\n') + '\n');
  for (let after = 0; after < 5000; after += 200) assert.equal((await w.get(logUrl(id, 1, `?after=${after}&limit=200`))).status, 200);
  reads = spyReads();
  try { page = (await w.get(logUrl(id, 1, '?after=2000&limit=3'))).json; } finally { reads.stop(); }
  assert.deepEqual(page.lines.map(line => line.text), ['row 2001', 'row 2002', 'row 2003']);
  assert.ok(reads.calls[0].position > 0 && reads.calls[0].position <= starts[2000], `the seek starts at ${reads.calls[0].position}, line 2001 is at ${starts[2000]}`);
  assert.ok(reads.calls[0].position >= starts[2000 - LOG_LIMITS.checkpointLines], 'and not further back than the last recorded point');
  reads = spyReads();
  try { page = (await w.get(logUrl(id, 1, '?after=1&limit=2'))).json; } finally { reads.stop(); }
  assert.deepEqual(page.lines.map(line => line.text), ['row 2', 'row 3']);
  assert.equal(reads.calls[0].position, 0);

  /* a companion that was restarted has no index and counts the lines again from the start; the numbers are the same */
  const restarted = createAgentService({ root: w.projectRoot, env: w.env, claudeBin: STUB, tmpRoot: w.tmpRoot });
  reads = spyReads();
  try { page = await restarted.readRunLog(id, 1, { after: 4500, limit: 2 }); } finally { reads.stop(); }
  assert.deepEqual(page.lines.map(line => [line.seq, line.text]), [[4501, 'row 4501'], [4502, 'row 4502']]);
  assert.equal(reads.calls[0].position, 0, 'a cold index starts at the beginning of the file');
  assert.equal(page.next, 4502);

  /* a file that was replaced (new inode) or cut short (same inode) is not trusted to match the index */
  fs.rmSync(file);
  fs.writeFileSync(file, rows.slice(100, 104).join('\n') + '\n');
  page = (await w.get(logUrl(id, 1, '?after=0'))).json;
  assert.deepEqual(page.lines.map(line => line.text), ['row 101', 'row 102', 'row 103', 'row 104']);
  page = (await w.get(logUrl(id, 1, '?after=4500'))).json;
  assert.deepEqual(page, { lines: [], next: 4, done: true, withheld: false }, 'a cursor from the old file is brought back to the end of the new one, not to a place in the old one');
  fs.writeFileSync(file, rows.slice(200, 202).join('\n') + '\n');
  page = (await w.get(logUrl(id, 1, '?after=0'))).json;
  assert.deepEqual(page.lines.map(line => line.text), ['row 201', 'row 202']);
  page = (await w.get(logUrl(id, 1, '?after=4'))).json;
  assert.deepEqual(page, { lines: [], next: 2, done: true, withheld: false }, 'a cursor past the end of the new, shorter file is brought back');
});

test('the index of a very long log stays small: its recorded places thin out as it grows, and a seek still starts close to its line', { timeout: 60000 }, async t => {
  const w = await makeWorld(t);
  const id = await finishedRound(w);
  const row = event('system', { subtype: 'x' });
  const width = Buffer.byteLength(row) + 1;
  fs.writeFileSync(w.transcript(id), (row + '\n').repeat(300000));
  let after = 0;
  let pages = 0;
  for (;;) {
    const page = await w.service.readRunLog(id, 1, { after, limit: 200 });
    assert.ok(page.lines.length <= 200 && (page.lines.length || page.done));
    after = page.next;
    pages++;
    if (page.done) break;
  }
  assert.equal(after, 300000);
  assert.equal(pages, 1501, 'a page more than the 1500 full ones, which finds the end');
  const reads = spyReads();
  let page;
  try { page = await w.service.readRunLog(id, 1, { after: 150001, limit: 2 }); } finally { reads.stop(); }
  assert.deepEqual(page.lines.map(line => line.seq), [150002, 150003]);
  assert.ok(reads.calls[0].position <= 150001 * width && reads.calls[0].position >= (150001 - 128) * width, `the seek starts at ${reads.calls[0].position}`);
  assert.ok(reads.bytes() <= 2 * LOG_LIMITS.chunk);
});

test('a transcript that is cut short in place, or replaced by another file, is read again from its start', async t => {
  const w = await makeWorld(t);
  const id = await finishedRound(w);
  const file = w.transcript(id);
  fs.writeFileSync(file, [textEvent('one'), textEvent('two'), textEvent('three')].join('\n') + '\n');
  assert.equal((await w.get(logUrl(id, 1, '?after=3'))).json.next, 3);
  fs.writeFileSync(file, textEvent('only') + '\n');
  const page = (await w.get(logUrl(id, 1, '?after=3'))).json;
  assert.deepEqual(page, { lines: [], next: 1, done: true, withheld: false });
  assert.deepEqual((await w.get(logUrl(id, 1, '?after=0'))).json.lines.map(line => line.text), ['only']);

  /* another, longer file moved into its place: a new file, so the old places mean nothing in it */
  fs.writeFileSync(file, [textEvent('a'), textEvent('b')].join('\n') + '\n');
  assert.equal((await w.get(logUrl(id, 1, '?after=2'))).json.next, 2);
  const rows = Array.from({ length: 50 }, (_, index) => textEvent(`new ${index + 1} ${'z'.repeat(40)}`));
  fs.writeFileSync(file + '.new', rows.join('\n') + '\n');
  fs.renameSync(file + '.new', file);
  const moved = (await w.get(logUrl(id, 1, '?after=2&limit=2'))).json;
  assert.deepEqual(moved.lines.map(line => [line.seq, line.text]), [[3, `new 3 ${'z'.repeat(40)}`], [4, `new 4 ${'z'.repeat(40)}`]]);
});

test('lines are never held beyond the page limit: many lines of just under the parse limit give a short page that can be continued', { timeout: 60000 }, async t => {
  const w = await makeWorld(t);
  const id = await finishedRound(w);
  const body = 'c'.repeat(LOG_LIMITS.parseBytes - 400);
  const rows = Array.from({ length: 40 }, (_, index) => textEvent(`${index + 1}:${body}`));
  fs.writeFileSync(w.transcript(id), rows.join('\n') + '\n');
  const seen = [];
  let after = 0;
  for (let step = 0; step < 40; step++) {
    const page = (await w.get(logUrl(id, 1, `?after=${after}&limit=200`))).json;
    assert.ok(page.lines.length >= 1 && page.lines.length <= Math.ceil(LOG_LIMITS.pageBytes / (LOG_LIMITS.parseBytes - 400)) + 1, `${page.lines.length} lines held for one page`);
    seen.push(...page.lines.map(line => line.seq));
    after = page.next;
    if (page.done) break;
  }
  assert.deepEqual(seen, Array.from({ length: 40 }, (_, index) => index + 1));
});

test('five 17 MB lines need more than one request: the first stops at the 64 MB limit, the second goes on from the index', { timeout: 120000 }, async t => {
  const w = await makeWorld(t);
  const id = await finishedRound(w);
  const prefix = Buffer.from('{"type":"user","message":{"content":[{"type":"tool_result","content":"');
  const suffix = Buffer.from('"}]}}\n');
  const fd = fs.openSync(w.transcript(id), 'w');
  const filler = Buffer.alloc(17 * 1024 * 1024, 0x41);
  for (let index = 0; index < 5; index++) { fs.writeSync(fd, prefix); fs.writeSync(fd, filler); fs.writeSync(fd, suffix); }
  fs.writeSync(fd, textEvent('end') + '\n');
  fs.closeSync(fd);
  const one = (await w.get(logUrl(id, 1, '?limit=200'))).json;
  assert.ok(one.lines.length >= 1 && one.lines.length < 6, `${one.lines.length} lines in the first request`);
  assert.equal(one.done, false);
  const seen = [...one.lines.map(line => line.seq)];
  let after = one.next;
  for (let step = 0; step < 5 && after < 6; step++) {
    const page = (await w.get(logUrl(id, 1, `?after=${after}&limit=200`))).json;
    seen.push(...page.lines.map(line => line.seq));
    after = page.next;
    if (page.done) break;
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6]);
  assert.equal(after, 6);
});

/* ---------------------------------------------------------------------- what is refused */

test('the log route refuses what is out of range or not an id, with the repo error shape, and an unknown round or run is a 404', async t => {
  const w = await makeWorld(t);
  const id = await loggedRound(w);
  const refused = async (urlPath, status, pattern) => {
    const response = await w.get(urlPath);
    assert.equal(response.status, status, `${urlPath}: ${response.text}`);
    assert.deepEqual(Object.keys(response.json), ['error'], urlPath);
    if (pattern) assert.match(response.json.error, pattern, urlPath);
    return response;
  };
  for (const bad of ['-1', '1.5', 'abc', '', '0x1', '1e3', '+1', '007', '2000000001', '99999999999', ' 1', '1 ']) await refused(logUrl(id, 1, '?after=' + encodeURIComponent(bad)), 400, /after must be a whole number from 0 to 2000000000/);
  for (const bad of ['0', '201', '-5', '2.5', 'many', '', '0x10', '1000', '00']) await refused(logUrl(id, 1, '?limit=' + encodeURIComponent(bad)), 400, /limit must be a whole number from 1 to 200/);
  await refused(logUrl(id, 1, '?after=1&after=2'), 400, /more than once/);
  await refused(logUrl(id, 1, '?limit=1&limit=2'), 400, /more than once/);
  assert.equal((await w.get(logUrl(id, 1, '?after=2000000000&limit=200'))).status, 200);
  assert.equal((await w.get(logUrl(id, 1, '?limit=200&other=1'))).status, 200);
  for (const bad of ['BAD_ID', 'abc', 'a'.repeat(65), 'rnd_000000000000', 'rnd-0000%2F00000000', '%']) await refused(logUrl(bad), 400, /not a valid round id/);
  for (const n of ['0', '00', '01', 'abc', '1000', '-1', '1.5', '1e1', '%31', 'x1']) await refused(logUrl(id, n), 400, /not a valid run number/);
  await refused(logUrl('rnd-ffffffffffff'), 404, /No such round/);
  for (const n of [2, 3, 99]) await refused(logUrl(id, n), 404, /No such run/);
  /* a round that has no runs yet */
  const draft = await createRound(w);
  await refused(logUrl(draft.id), 404, /No such run/);
  /* the route reads, it does not write */
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const wrong = await w.send(method, logUrl(id), {});
    assert.equal(wrong.status, 405, method);
  }
  assert.equal((await w.post(logUrl(id), {})).headers.allow, 'GET');
  assert.equal((await w.get(logUrl(id), { Origin: 'http://evil.example' })).status, 403);
  assert.equal(w.logs.length, 0, w.logs.join('\n'));
});

test('traversal in the address and links on disk cannot make the log route read another file', async t => {
  const w = await makeWorld(t);
  const id = await loggedRound(w);
  const outside = path.join(w.base, 'outside');
  fs.mkdirSync(outside);
  const SECRET_FILE = 'SECRET-OUTSIDE-FILE-5d3c';
  const planted = textEvent(SECRET_FILE) + '\n';
  fs.writeFileSync(path.join(outside, 'transcript.jsonl'), planted);
  fs.writeFileSync(path.join(outside, 'file.txt'), planted);
  const runDir = path.join(w.roundsDir, id, 'runs', '1');
  assert.equal((await w.get(logUrl(id))).status, 200);

  /* the address */
  for (const urlPath of [
    `/api/agents/rounds/..%2F..%2Foutside/runs/1/log`, `/api/agents/rounds/${id}/runs/..%2F1/log`, `/api/agents/rounds/${id}/runs/1%2F..%2F2/log`,
    `/api/agents/rounds/${id}/runs/%2e%2e/log`, `/api/agents/rounds/%2e%2e/runs/1/log`, `/api/agents/rounds/${id}%00/runs/1/log`, `/api/agents/rounds/${id}/runs/1%00/log`,
    `/api/agents/rounds/${id}%2Fruns%2F1/runs/1/log`, `/api/agents/rounds/${id}/runs/1/log%2F..%2Ftranscript.jsonl`, `/api/agents/rounds/${id}\\..\\x/runs/1/log`,
  ]) {
    const response = await w.get(urlPath);
    assert.ok([400, 404].includes(response.status), `${urlPath}: ${response.status}`);
    assert.ok(!response.text.includes(SECRET_FILE));
  }
  for (const urlPath of [`/api/agents/rounds/${id}/runs/1/log/`, `/api/agents/rounds/${id}/runs/1/log/..`, `/api/agents/rounds/${id}/runs/1/log/../../../..`, `/api/agents/rounds/${id}/runs/1/../../../outside/transcript.jsonl`]) {
    const response = await w.get(urlPath);
    assert.ok([400, 404].includes(response.status), `${urlPath}: ${response.status}`);
    assert.ok(!response.text.includes(SECRET_FILE), urlPath);
  }

  /* a transcript that is a link to a file elsewhere */
  const file = w.transcript(id);
  fs.rmSync(file);
  fs.symlinkSync(path.join(outside, 'file.txt'), file);
  let response = await w.get(logUrl(id));
  assert.equal(response.status, 404, response.text);
  assert.deepEqual(response.json, { error: 'No transcript is available for this run' });
  assert.ok(!response.text.includes(SECRET_FILE));
  /* ... also while a round runs, and for a link that leads nowhere */
  fs.rmSync(file);
  fs.symlinkSync(path.join(outside, 'missing.jsonl'), file);
  assert.equal((await w.get(logUrl(id))).status, 404);
  /* a transcript that is a folder, or any other file type */
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.equal((await w.get(logUrl(id))).status, 404);
  fs.rmSync(file, { recursive: true });

  /* a link in front of the transcript: the run folder, the folder of runs, the folder of the round */
  fs.renameSync(runDir, runDir + '-real');
  fs.symlinkSync(outside, runDir);
  response = await w.get(logUrl(id));
  assert.equal(response.status, 404, response.text);
  assert.ok(!response.text.includes(SECRET_FILE));
  fs.rmSync(runDir);
  fs.renameSync(runDir + '-real', runDir);
  const runsDir = path.join(w.roundsDir, id, 'runs');
  fs.renameSync(runsDir, runsDir + '-real');
  fs.mkdirSync(runsDir);
  fs.symlinkSync(outside, path.join(runsDir, '1'));
  assert.equal((await w.get(logUrl(id))).status, 404);
  fs.rmSync(runsDir, { recursive: true });
  fs.renameSync(runsDir + '-real', runsDir);
  const roundDir = path.join(w.roundsDir, id);
  fs.renameSync(roundDir, roundDir + '-real');
  fs.symlinkSync(roundDir + '-real', roundDir);
  assert.equal((await w.get(logUrl(id))).status, 404, 'a link in place of the round folder');
  fs.rmSync(roundDir);
  fs.renameSync(roundDir + '-real', roundDir);
  assert.equal((await w.get(logUrl(id))).status, 200, 'everything back in place: the route reads it again');
  assert.equal(w.logs.length, 0, w.logs.join('\n'));
});

test('a run whose transcript was never written, or is gone, has no lines', async t => {
  const w = await makeWorld(t);
  const id = await finishedRound(w);
  fs.rmSync(w.transcript(id));
  assert.deepEqual((await w.get(logUrl(id))).json, { lines: [], next: 0, done: true, withheld: false });
  fs.rmSync(path.join(w.roundsDir, id, 'runs'), { recursive: true });
  assert.deepEqual((await w.get(logUrl(id))).json, { lines: [], next: 0, done: true, withheld: false });
  /* an unreadable file is not an error that names a path */
  const second = await finishedRound(w);
  fs.chmodSync(w.transcript(second), 0o000);
  const response = await w.get(logUrl(second));
  if (process.getuid && process.getuid() !== 0) assert.equal(response.status, 404, response.text);
  assert.ok(!response.text.includes(w.base));
  fs.chmodSync(w.transcript(second), 0o600);
});

/* ---------------------------------------------------------------------- the rule itself */

test('both routes are round data: a service that ignores the rule is still redacted by the server, also when a round starts during the read', async t => {
  const SECRET = { text: 'PATCHED-TEXT-1d9e', command: 'PATCHED-COMMAND-77aa', input: 'PATCHED-INPUT-c0de', extra: 'PATCHED-EXTRA-e7e7', gold: 'PATCHED-GOLD-9f9f' };
  let phase = 'quiet';
  let rounds = 0;
  const page = () => ({
    lines: [
      { seq: 1, at: '2026-03-01T10:00:00.000Z', kind: 'tool', tool: 'Bash', chars: 40, relPath: 'out/a.txt', text: `${SECRET.text} in /home/u/proj/x.txt`, command: SECRET.command, input: { x: SECRET.input }, extra: SECRET.extra, path: '/etc/passwd' },
      { seq: 2, at: 'not a time', kind: 'made-up', tool: 'MadeUpTool', chars: -4, relPath: '../../etc/passwd', text: 'x'.repeat(5000) },
      { seq: 'three', kind: 'text', text: 'dropped' },
      null,
      { seq: 4, kind: 'result', tool: 'Bash tool with spaces', chars: 2.5, relPath: '/abs/path', text: '' },
    ],
    next: 4,
    done: false,
    withheld: false,
  });
  const feedRowsOf = () => [{ key: 'rnd-000000000001:1', roundId: 'rnd-000000000001', n: 1, final: { text: SECRET.text, chars: 17 }, classification: { suggestedVerdict: 'fingerprint', humanVerdict: null }, freeze: { gold: SECRET.gold, sha256: 'a'.repeat(64), frozenAt: '2026-03-01T10:00:00.000Z' } }];
  const world = await makeWorld(t, {}, {
    service: {
      status: async () => ({ runtime: { found: false }, maxPilotsPerRound: 5, models: [], efforts: [] }),
      listRounds: async () => {
        rounds++;
        if (phase === 'throws') throw new Error('the list cannot be read');
        if (phase === 'starts-during-read') return [{ id: 'rnd-000000000001', status: rounds % 2 === 1 ? 'finished' : 'running' }];
        return [{ id: 'rnd-000000000001', status: phase === 'running' ? 'running' : 'finished' }];
      },
      readRunLog: async () => page(),
      listRuns: async () => feedRowsOf(),
    },
  });
  const log = () => world.get('/api/agents/rounds/rnd-000000000001/runs/1/log');

  /* no round runs: the text goes through, cleaned; every field nobody listed is dropped; a bad line is skipped */
  let response = await log();
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.withheld, false);
  assert.equal(response.json.redacted, undefined);
  assert.deepEqual(response.json.lines, [
    { seq: 1, at: '2026-03-01T10:00:00.000Z', kind: 'tool', tool: 'Bash', chars: 40, relPath: 'out/a.txt', text: `${SECRET.text} in <path>` },
    { seq: 2, at: null, kind: 'system', tool: 'MadeUpTool', text: 'x'.repeat(2000) },
    { seq: 4, at: null, kind: 'result' },
  ]);
  for (const hidden of [SECRET.command, SECRET.input, SECRET.extra, '/etc/passwd', '/home/u']) assert.ok(!response.text.includes(hidden), hidden);
  let feed = await world.get('/api/agents/runs');
  assert.equal(feed.json.redacted, undefined);
  assert.equal(feed.json.runs[0].final.text, SECRET.text, 'with no round running the feed is passed through as the service made it');

  /* a round runs: the service was never asked to withhold, yet nothing but kind, tool, chars and at gets through */
  for (const state of ['running', 'starts-during-read', 'throws']) {
    phase = state;
    rounds = 0;
    response = await log();
    assert.equal(response.status, 200, `${state}: ${response.text}`);
    assert.equal(response.json.withheld, true, state);
    assert.equal(response.json.redacted, true, state);
    assert.deepEqual(response.json.lines, [
      { seq: 1, at: '2026-03-01T10:00:00.000Z', kind: 'tool', tool: 'Bash', chars: 40 },
      { seq: 2, at: null, kind: 'system', tool: 'other' },
      /* when the round starts during the read the page was already shaped for a reader, which dropped a tool name that is no name */
      state === 'starts-during-read' ? { seq: 4, at: null, kind: 'result' } : { seq: 4, at: null, kind: 'result', tool: 'other' },
    ], state);
    for (const secret of Object.values(SECRET).concat(['/etc/passwd', '/home/u', 'out/a.txt', 'xxxxx'])) assert.ok(!response.text.includes(secret), `${state}: the log leaks ${secret}`);
    rounds = 1; /* the feed asks once, after it has read: that answer must be "running" */
    feed = await world.get('/api/agents/runs');
    assert.equal(feed.json.redacted, true, state);
    assert.deepEqual(feed.json.runs[0].final, { chars: 17 }, state);
    assert.deepEqual(feed.json.runs[0].freeze, { sha256: 'a'.repeat(64), frozenAt: '2026-03-01T10:00:00.000Z' });
    assert.ok(!feed.text.includes(SECRET.text) && !feed.text.includes(SECRET.gold), `${state}: the feed leaks`);
  }
  assert.equal(world.logs.length, 3, 'an unreadable list is logged each time it is asked for (twice for the log, once for the feed), and every answer was withheld');

  /* a service that does not offer the routes: 404, as for the pre-flight */
  const bare = await makeWorld(t, {}, { service: { status: async () => ({}) , listRounds: async () => [] } });
  for (const urlPath of ['/api/agents/runs', '/api/agents/rounds/rnd-000000000001/runs/1/log']) {
    const missing = await bare.get(urlPath);
    assert.equal(missing.status, 404, urlPath);
    assert.match(missing.json.error, /not available in this version of the companion/);
  }
  /* a service that answers with something that is not a page: an empty page, not an error */
  const odd = await makeWorld(t, {}, { service: { status: async () => ({}), listRounds: async () => [], readRunLog: async () => null } });
  assert.deepEqual((await odd.get('/api/agents/rounds/rnd-000000000001/runs/1/log')).json, { lines: [], next: 0, done: false, withheld: false });
  assert.equal(odd.logs.length, 0);
});

test('taskKey compares task names without case, extra spaces or the way an accent is encoded', () => {
  const { taskKey } = require('../backend/agents/rounds.cjs');
  assert.equal(taskKey('  ATLAS\t\n bridge '), 'atlas bridge');
  assert.equal(taskKey('Caf\u00e9'), taskKey('Cafe\u0301'));
  assert.equal(taskKey('Atlas'), taskKey('atlas'));
  assert.notEqual(taskKey('Atlas'), taskKey('Atlas 2'));
  assert.equal(taskKey(''), '');
  assert.equal(taskKey(undefined), '');
  assert.equal(taskKey(5), '');
});

test('scrubLogText: every absolute path in free text goes, relative paths and URLs stay, the text is cut at 2000 characters', () => {
  const cases = [
    ['cat /etc/hosts', 'cat <path>'],
    ['cd /home/u/proj && ls', 'cd <path> && ls'],
    ['echo "/a b/c d" > out', 'echo "<path>" > out'],
    ["open '/Users/me/My Docs/x.txt' now", "open '<path>' now"],
    ['see https://example.com/a/b and file:///etc/passwd', 'see https://example.com/a/b and <path>'],
    ['C:\\Users\\x\\f.txt tail', '<path> tail'],
    ['copy D:/data/x.csv here', 'copy <path> here'],
    ['PATH=/usr/bin:/bin ls', 'PATH=<path> ls'],
    ['gcc -I/usr/include x.c', 'gcc -I<path> x.c'],
    ['open ~/Documents/x', 'open <path>'],
    ['>/etc/x', '><path>'],
    ['x \\\\srv\\share\\f', 'x <path>'],
    ['(see /var/log/x)', '(see <path>)'],
    ['ratio 1/2, a/b/c, ./x/y, ../z and https://h/p', 'ratio 1/2, a/b/c, ./x/y, ../z and https://h/p'],
    ['no path here', 'no path here'],
    ['', ''],
  ];
  for (const [input, expected] of cases) assert.equal(scrubLogText(input), expected, input);
  assert.equal(scrubLogText('see /srv/atlas/x', text => text.split('/srv/atlas').join('<server path>')), 'see <server path><path>', 'the server\'s own redactor runs first');
  assert.equal(scrubLogText('y'.repeat(5000)).length, 2000);
  assert.equal(scrubLogText('😀'.repeat(1500)).length, 2000, 'a cut between two pairs keeps both halves of each');
  assert.equal(scrubLogText('a' + '😀'.repeat(1500)).length, 1999, 'no surrogate pair is cut in two');
  assert.equal(scrubLogText(('/' + 'p'.repeat(100) + ' ').repeat(100)).length <= 2000, true);
  assert.equal(scrubLogText(12345), '12345');
});

test('the log reader is exercised through the service too: bad arguments are 400, and the options force a withheld page', async t => {
  const w = await makeWorld(t);
  const id = await loggedRound(w);
  const refuse = async (promise, status) => assert.rejects(promise, error => error.status === status && error.name === 'AgentError');
  await refuse(w.service.readRunLog(id, 1, { after: -1 }), 400);
  await refuse(w.service.readRunLog(id, 1, { after: 1.5 }), 400);
  await refuse(w.service.readRunLog(id, 1, { after: '1' }), 400);
  await refuse(w.service.readRunLog(id, 1, { limit: 0 }), 400);
  await refuse(w.service.readRunLog(id, 1, { limit: 201 }), 400);
  await refuse(w.service.readRunLog(id, 1, { limit: '5' }), 400);
  await refuse(w.service.readRunLog(id, 0), 400);
  await refuse(w.service.readRunLog(id, 'x'), 400);
  await refuse(w.service.readRunLog('NOPE', 1), 400);
  await refuse(w.service.readRunLog('rnd-ffffffffffff', 1), 404);
  await refuse(w.service.readRunLog(id, 5), 404);
  await refuse(w.service.listRuns({ limit: 0 }), 400);
  await refuse(w.service.listRuns({ limit: 201 }), 400);
  await refuse(w.service.listRuns({ limit: 1.5 }), 400);
  await refuse(w.service.listRuns({ round: 'rnd-ffffffffffff' }), 404);
  await refuse(w.service.listRuns({ round: 'x' }), 400);
  await refuse(w.service.listRuns({ task: 7 }), 400);
  const full = await w.service.readRunLog(id, 1);
  assert.equal(full.withheld, false);
  assert.ok(full.lines[1].text.includes(SECRET_CMD));
  assert.equal(full.lines[3].relPath, 'filesystem/Cash_Facts.csv');
  assert.equal(full.lines[5].relPath, undefined, 'a path outside the pilot folder');
  assert.equal(full.lines[7].relPath, 'outputs/answer.txt');
  assert.equal(full.lines[11].relPath, undefined, 'a path with ..');
  assert.equal(full.lines[10].chars, BIG_RESULT.length);
  assert.equal(full.lines[10].text.length, 2000, 'the store cuts the text itself, before the server does');
  assert.ok(full.lines.every(line => !('text' in line) || line.text.length <= 2000));
  assert.ok(!JSON.stringify(full).includes(path.join(w.pilots, `${id}-1`)), 'the pilot\'s own folder is written as "."');
  const forced = await w.service.readRunLog(id, 1, { withheld: true });
  assert.equal(forced.withheld, true);
  assert.ok(!JSON.stringify(forced).includes(SECRET_CMD) && !JSON.stringify(forced).includes('text'));
  assert.deepEqual(forced.lines.map(line => line.kind), EXPECTED_KINDS);
  assert.deepEqual(await w.service.listRuns(), await w.service.listRuns({}), 'no options is the default');
});
