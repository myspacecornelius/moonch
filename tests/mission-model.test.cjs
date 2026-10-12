'use strict';
/* Tests for mission-model.js (SPEC 2.4). Every fixture here is synthetic (QA fixture, model browser-test-fixture) and uses
   only the invented task names Atlas, Meridian, Borealis and Cobalt. Round rows get their `counts` from their pilot rows
   with the same rules as the companion's countRuns, so a fixture cannot disagree with itself. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const M = require('../mission-model.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'mission-model.js'), 'utf8');
const sha = c => c.repeat(64);
const iso = (day, hh = 9, mm = 0, ss = 0) => `2026-10-${String(day).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.000Z`;

/* ---------- fixtures ---------- */
const CLEAN = { status: 'CLEAN', violationCount: 0 };
const BAD = { status: 'DISCARDED', violationCount: 2 };
const verdict = v => ({ suggestedVerdict: v, humanVerdict: v });

/* A pilot row as GET /api/agents/runs returns it. */
function pilot(roundId, n, over = {}) {
  const base = {
    key: `${roundId}:${n}`, roundId, n, runId: `${roundId}-${n}`, roundLabel: 'QA fixture round', task: '', roundStatus: 'finished',
    state: 'completed', startedAt: iso(1, 9, 5), endedAt: iso(1, 9, 9, 12), arrivedAt: iso(1, 9, 9, 12),
    exitCode: 0, requestedModel: 'browser-test-fixture', resolvedModel: 'browser-test-fixture', numTurns: 6, costUsd: 0.0123,
    terminalReason: 'completed', failureReason: null, toolCalls: { total: 31, bash: 20, file: 11 },
    audit: CLEAN, final: { chars: 1240 }, outputCount: 2, workingFolder: `finance-studio-pilots/${roundId}-${n}`,
    evidencePath: `private/agent-rounds/${roundId}/runs/${n}/outputs/`, classification: null, needsVerdict: true
  };
  const out = { ...base, ...over };
  const human = out.classification && out.classification.humanVerdict;
  out.needsVerdict = out.state === 'completed' && out.audit && out.audit.status === 'CLEAN' && !human;
  return out;
}
const running = (roundId, n, over = {}) => pilot(roundId, n, { state: 'running', roundStatus: 'running', endedAt: null, arrivedAt: iso(5, 10, n), startedAt: iso(5, 10, n), numTurns: null, costUsd: null, terminalReason: null, toolCalls: { total: 4, bash: 3, file: 1 }, audit: null, final: { chars: 0 }, outputCount: 0, evidencePath: null, ...over });
const queued = (roundId, n, over = {}) => pilot(roundId, n, { state: 'queued', roundStatus: 'running', startedAt: null, endedAt: null, arrivedAt: iso(5, 10, 0), numTurns: null, costUsd: null, terminalReason: null, toolCalls: { total: 0, bash: 0, file: 0 }, audit: null, final: { chars: 0 }, outputCount: 0, evidencePath: null, ...over });
const failed = (roundId, n, reason, over = {}) => pilot(roundId, n, { state: 'failed', failureReason: reason, exitCode: reason === 'exit-code' ? 1 : null, terminalReason: null, audit: reason === 'setup-error' ? CLEAN : null, ...over });

/* Same counting rules as countRuns in backend/agents/rounds.cjs. */
function countsOf(runs) {
  const c = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, clean: 0, discarded: 0, classified: 0 };
  for (const r of runs) {
    if (c[r.state] !== undefined) c[r.state]++;
    if (r.audit && r.audit.status === 'CLEAN') c.clean++;
    if (r.audit && r.audit.status === 'DISCARDED') c.discarded++;
    if (r.classification && r.classification.humanVerdict) c.classified++;
  }
  return c;
}
/* A round row as GET /api/agents/rounds returns it (SPEC 2.1 additions included). */
function roundRow(id, over = {}, runs = []) {
  const row = {
    id, createdAt: iso(1, 9), label: 'QA fixture round', task: '', status: 'finished', carriedFrom: null,
    config: { kind: 'pilot', model: 'browser-test-fixture', effort: 'medium', count: Math.max(runs.length, 5), tools: [], maxBudgetUsd: 3, concurrency: 5 },
    packetSha256: sha('a'), freezeSha256: sha('b'), gafVisible: true, runCount: runs.length, counts: countsOf(runs),
    launchedAt: runs.length ? iso(1, 9, 5) : null, endedAt: runs.length ? iso(1, 9, 30) : null,
    freezeVersion: 1, freezePostHoc: false, contentSha256: sha('c'), carriedDepth: 0, lastActivityAt: iso(1, 9, 30)
  };
  return { ...row, ...over };
}
/* Round + its pilots, with the pilots' task/label/status copied from the round the way the feed route does. */
function made(id, over, runSpecs) {
  const stub = roundRow(id, over, runSpecs.map((_, i) => ({ state: 'x' })));
  const runs = runSpecs.map((spec, i) => ({ ...spec(id, i + 1), roundLabel: stub.label, task: stub.task, roundStatus: stub.status }));
  const row = roundRow(id, over, runs);
  const withVerdict = runs.map(r => ({ ...r, needsVerdict: r.state === 'completed' && r.audit && r.audit.status === 'CLEAN' && !(r.classification && r.classification.humanVerdict) }));
  return { round: row, rounds: [row], runs: withVerdict };
}
const done = (over = {}) => (id, n) => pilot(id, n, over);
const gold = (over = {}) => (id, n) => pilot(id, n, { classification: verdict('matches-frozen-gold'), ...over });
const fp = (over = {}) => (id, n) => pilot(id, n, { classification: verdict('fingerprint'), ...over });
const unclear = (over = {}) => (id, n) => pilot(id, n, { classification: verdict('unclear'), ...over });
const discarded = (over = {}) => (id, n) => pilot(id, n, { audit: BAD, ...over });
const fail = (reason, over = {}) => (id, n) => failed(id, n, reason, over);
const cancelled = (over = {}) => (id, n) => pilot(id, n, { state: 'cancelled', failureReason: 'cancelled', audit: null, terminalReason: null, ...over });
const live = (over = {}) => (id, n) => running(id, n, over);
const waiting = (over = {}) => (id, n) => queued(id, n, over);

const combine = (...parts) => ({ rounds: parts.map(p => p.round), runs: parts.flatMap(p => p.runs) });

/* The board used by most tests: Atlas (two rounds, v2 needs verdicts), Meridian (frozen), Borealis (draft), Cobalt (a legacy
   lineage with no task field), and one unassigned legacy round. Nothing runs. */
function idleWorld() {
  const a1 = made('atlas-r1', { label: 'Atlas round 1', task: 'Atlas', createdAt: iso(1, 9), packetSha256: sha('a') }, [gold(), gold(), fp(), unclear(), discarded()]);
  const a2 = made('atlas-r2', { label: 'Atlas round 2', task: 'Atlas', createdAt: iso(2, 9), carriedFrom: 'atlas-r1', carriedDepth: 1, packetSha256: sha('d'), freezeVersion: 2, lastActivityAt: iso(2, 9, 40) }, [gold(), done(), done(), fail('budget'), cancelled()]);
  const m1 = made('mer-r1', { label: 'Meridian round 1', task: 'Meridian', createdAt: iso(1, 10), status: 'frozen', launchedAt: null, endedAt: null, lastActivityAt: iso(1, 10, 2) }, []);
  const b1 = made('bor-r1', { label: 'Borealis round 1', task: 'Borealis', createdAt: iso(3, 8), status: 'draft', freezeSha256: null, freezeVersion: null, contentSha256: null, launchedAt: null, endedAt: null, lastActivityAt: iso(3, 8) }, []);
  const c1 = made('cob-r1', { label: 'Cobalt', task: '', createdAt: iso(1, 11), packetSha256: sha('e'), lastActivityAt: iso(1, 11, 30) }, [gold(), gold()]);
  const c2 = made('cob-r2', { label: 'second try', task: '', createdAt: iso(2, 11), carriedFrom: 'cob-r1', carriedDepth: 1, packetSha256: sha('e'), lastActivityAt: iso(2, 11, 30) }, [gold(), fp(), unclear()]);
  const u1 = made('una-r1', { label: 'Pilot round', task: '', createdAt: iso(1, 12), lastActivityAt: iso(1, 12, 30) }, [done()]);
  return combine(a1, a2, m1, b1, c1, c2, u1);
}
/* Borealis is the one running: 2 running, 1 waiting, 2 finished. The companion redacts every response while it runs. */
function runningWorld() {
  const w = idleWorld();
  const b2 = made('bor-r2', { label: 'Borealis round 2', task: 'Borealis', createdAt: iso(5, 10), status: 'running', launchedAt: iso(5, 10), endedAt: null, lastActivityAt: iso(5, 10, 8) }, [done(), fail('exit-code'), live(), live(), waiting()]);
  const rounds = w.rounds.filter(r => r.id !== 'bor-r1').concat(b2.round);
  return { rounds, runs: w.runs.concat(b2.runs), redacted: true };
}

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze(v[k]); }
  return v;
}
const clone = v => JSON.parse(JSON.stringify(v));
function strings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach(x => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => strings(x, out));
  return out;
}
const byName = (board, name) => board.tasks.find(t => t.name === name);
const NOW = iso(6, 12);

/* ---------- module shape and hygiene ---------- */
test('loads as a UMD global with no DOM, no clock and no storage', () => {
  const win = {};
  vm.runInNewContext(SRC, { window: win });
  assert.equal(typeof win.FinanceMissionModel.buildBoard, 'function');
  assert.equal(typeof win.FinanceMissionModel.buildFeed, 'function');
  assert.deepEqual(Object.keys(win.FinanceMissionModel).sort(), Object.keys(M).sort());
  for (const name of ['taskKey', 'taskName', 'buildBoard', 'scoreRows', 'nextAction', 'buildFeed', 'describeFailure', 'formatDuration', 'shortHash']) assert.equal(typeof M[name], 'function', name);
  assert.ok(!/Date\.now|new Date\(\s*\)|Math\.random|\bdocument\b|localStorage|sessionStorage|\bfetch\b|XMLHttpRequest|\bwindow\.|performance\.now/.test(SRC.replace(/typeof window!=='undefined'\?window:globalThis/, '')), 'pure: no clock, DOM, storage or network');
  assert.ok(!/https?:\/\/|\beval\s*\(|new Function|WebSocket|sendBeacon|importScripts|style\s*=\s*"|<\/script/i.test(SRC), 'passes the page-script hygiene checks');
});

test('formatDuration matches the Agents page wording', () => {
  const table = [[252000, '4m 12s'], [0, '0m 00s'], [7000, '0m 07s'], [59500, '1m 00s'], [60000, '1m 00s'], [3600000, '60m 00s'], [-5000, '0m 00s'], [1499, '0m 01s'], [1500, '0m 02s']];
  for (const [ms, text] of table) assert.equal(M.formatDuration(ms), text, String(ms));
  for (const bad of [NaN, Infinity, undefined, null, '4', {}]) assert.equal(M.formatDuration(bad), '-');
});

test('shortHash takes 12 characters by default and never throws', () => {
  assert.equal(M.shortHash(sha('4')), '444444444444');
  assert.equal(M.shortHash('4f2a9c1d3b7e8899aabb'), '4f2a9c1d3b7e');
  assert.equal(M.shortHash('4f2a9c1d3b7e8899aabb', 6), '4f2a9c');
  assert.equal(M.shortHash('sha256:4f2a9c1d3b7e8899'), '4f2a9c1d3b7e');
  assert.equal(M.shortHash('abc'), 'abc');
  for (const bad of [null, undefined, 5, {}, []]) assert.equal(M.shortHash(bad), '');
  for (const n of [0, -3, 1.5, NaN, 'x']) assert.equal(M.shortHash('4f2a9c1d3b7e8899', n), '4f2a9c1d3b7e');
});

test('evidencePath is the deterministic evidence folder, and only for a valid id and pilot number', () => {
  assert.equal(M.evidencePath('atlas-r2', 3), 'private/agent-rounds/atlas-r2/runs/3/outputs/');
  for (const [id, n] of [['../x', 1], ['ATLAS', 1], ['atlas-r2', 0], ['atlas-r2', 1.5], ['atlas-r2', 100], ['', 1], [null, 1], ['abc', 1]]) assert.equal(M.evidencePath(id, n), null, `${id}/${n}`);
});

/* ---------- task identity and lineage ---------- */
test('taskKey and taskName: the task field, trimmed, matched without regard to case or spacing', () => {
  const a = { id: 'r-aaaa', task: '  Atlas  ' }, b = { id: 'r-bbbb', task: 'atlas' }, c = { id: 'r-cccc', task: 'ATLAS\n\t' }, d = { id: 'r-dddd', task: 'Atlas  Terms' }, e = { id: 'r-eeee', task: 'atlas terms' };
  assert.equal(M.taskName(a), 'Atlas');
  assert.equal(M.taskKey(a), M.taskKey(b));
  assert.equal(M.taskKey(a), M.taskKey(c));
  assert.equal(M.taskKey(d), M.taskKey(e));
  assert.notEqual(M.taskKey(a), M.taskKey(d));
  assert.equal(M.taskName(d), 'Atlas Terms');
  assert.equal(M.resolveTask(a).unassigned, false);
  assert.equal(M.resolveTask(a).via, 'task');
});

test('taskKey and taskName: no task and no list gives Unassigned', () => {
  for (const row of [{ id: 'r-aaaa' }, { id: 'r-aaaa', task: '' }, { id: 'r-aaaa', task: '   ' }, { id: 'r-aaaa', task: 7 }, { id: 'r-aaaa', task: null }, { id: 'r-aaaa', task: { a: 1 } }, null, undefined, 'x', []]) {
    const t = M.resolveTask(row);
    assert.equal(t.name, 'Unassigned');
    assert.equal(t.unassigned, true);
    assert.equal(t.key, 'unassigned');
  }
});

test('a task literally named Unassigned is a task, not the unassigned bucket', () => {
  const t = M.resolveTask({ id: 'r-aaaa', task: 'Unassigned' });
  assert.equal(t.unassigned, false);
  assert.notEqual(t.key, 'unassigned');
});

test('lineage: a legacy round takes its root round label, through any number of carries', () => {
  const rounds = [
    { id: 'cob-r1', label: 'Cobalt terms', task: '', carriedFrom: null },
    { id: 'cob-r2', label: 'x', task: '', carriedFrom: 'cob-r1' },
    { id: 'cob-r3', label: 'y', task: '', carriedFrom: 'cob-r2' }
  ];
  for (const r of rounds) { assert.equal(M.taskName(r, rounds), 'Cobalt terms', r.id); assert.equal(M.resolveTask(r, rounds).unassigned, false); }
  assert.equal(M.resolveTask(rounds[2], rounds).via, 'root-label');
  assert.equal(M.taskKey(rounds[2], rounds), M.taskKey({ id: 'zzzz-1', task: 'COBALT TERMS' }));
  /* without the list the lineage cannot be followed */
  assert.equal(M.taskName(rounds[2]), 'Unassigned');
});

test('lineage: the nearest ancestor with a task wins over the root label; the round own task wins over both', () => {
  const rounds = [
    { id: 'aaaa-1', label: 'root label', task: '', carriedFrom: null },
    { id: 'aaaa-2', label: 'mid', task: 'Atlas', carriedFrom: 'aaaa-1' },
    { id: 'aaaa-3', label: 'leaf', task: '', carriedFrom: 'aaaa-2' },
    { id: 'aaaa-4', label: 'own', task: 'Meridian', carriedFrom: 'aaaa-2' }
  ];
  assert.equal(M.taskName(rounds[2], rounds), 'Atlas');
  assert.equal(M.resolveTask(rounds[2], rounds).via, 'ancestor-task');
  assert.equal(M.taskName(rounds[3], rounds), 'Meridian');
  assert.equal(M.taskName(rounds[0], rounds), 'root label');
});

test('lineage: a generic or empty root label names nothing, so the lineage is Unassigned', () => {
  for (const label of ['Pilot round', 'pilot round', '  PILOT ROUND ', '', '   ', 'Round']) {
    const rounds = [{ id: 'aaaa-1', label, carriedFrom: null }, { id: 'aaaa-2', label: 'child', carriedFrom: 'aaaa-1' }];
    assert.equal(M.taskName(rounds[0], rounds), 'Unassigned', JSON.stringify(label));
    assert.equal(M.taskName(rounds[1], rounds), 'Unassigned', JSON.stringify(label));
  }
});

test('lineage: a missing parent leaves the root unknown (Unassigned), a self loop and a longer cycle never hang', () => {
  const missing = [{ id: 'aaaa-2', label: 'child', carriedFrom: 'gone-1' }];
  assert.equal(M.taskName(missing[0], missing), 'Unassigned');
  const self = [{ id: 'aaaa-1', label: 'loop', carriedFrom: 'aaaa-1' }];
  assert.equal(M.taskName(self[0], self), 'Unassigned');
  const cycle = [{ id: 'aaaa-1', label: 'one', carriedFrom: 'aaaa-3' }, { id: 'aaaa-2', label: 'two', carriedFrom: 'aaaa-1' }, { id: 'aaaa-3', label: 'three', carriedFrom: 'aaaa-2' }];
  for (const r of cycle) { assert.equal(M.taskName(r, cycle), 'Unassigned'); assert.equal(M.resolveTask(r, cycle).end, 'cycle'); }
  /* a task on a round inside a cycle still names it */
  const named = [{ id: 'aaaa-1', label: 'one', task: 'Atlas', carriedFrom: 'aaaa-2' }, { id: 'aaaa-2', label: 'two', carriedFrom: 'aaaa-1' }];
  assert.equal(M.taskName(named[1], named), 'Atlas');
  assert.equal(M.taskName(named[0], named), 'Atlas');
  /* a parent that is missing still lets an ancestor in the list name the round */
  const partial = [{ id: 'aaaa-2', label: 'mid', task: 'Borealis', carriedFrom: 'gone-1' }, { id: 'aaaa-3', label: 'leaf', carriedFrom: 'aaaa-2' }];
  assert.equal(M.taskName(partial[1], partial), 'Borealis');
});

test('lineage depth: the backend carriedDepth is used, else it is counted from the list, cycle safe', () => {
  const rounds = [
    roundRow('dep-aaa1', { task: 'Atlas', carriedDepth: undefined }), roundRow('dep-aaa2', { task: 'Atlas', carriedFrom: 'dep-aaa1', carriedDepth: undefined }), roundRow('dep-aaa3', { task: 'Atlas', carriedFrom: 'dep-aaa2', carriedDepth: undefined }),
    roundRow('dep-bbb1', { task: 'Meridian', carriedFrom: 'gone-9', carriedDepth: undefined }),
    roundRow('dep-ccc1', { task: 'Borealis', carriedFrom: 'dep-ccc2', carriedDepth: undefined }), roundRow('dep-ccc2', { task: 'Borealis', carriedFrom: 'dep-ccc1', carriedDepth: undefined }),
    roundRow('dep-ddd1', { task: 'Cobalt', carriedDepth: 7 })
  ];
  const board = M.buildBoard({ rounds });
  assert.equal(byName(board, 'Atlas').version.depth, 2);
  assert.equal(byName(board, 'Atlas').version.number, 3);
  assert.match(byName(board, 'Atlas').version.label, /^v3 · sha256:a{12}$/);
  assert.equal(byName(board, 'Meridian').version.depth, 0);
  assert.equal(byName(board, 'Borealis').version.depth, 0);
  assert.equal(byName(board, 'Cobalt').version.depth, 7, 'the backend value wins');
  assert.match(byName(board, 'Cobalt').version.label, /^v8 /);
});

/* ---------- version labels ---------- */
test('version: label, packet short hash and freeze label (original, post-hoc, unknown, none)', () => {
  const mk = over => byName(M.buildBoard({ rounds: [roundRow('ver-aaa1', { task: 'Atlas', carriedDepth: 2, packetSha256: '4f2a9c1d3b7e' + 'f'.repeat(52), ...over })] }), 'Atlas').version;
  const v = mk({});
  assert.equal(v.label, 'v3 · sha256:4f2a9c1d3b7e');
  assert.equal(v.packetShort, '4f2a9c1d3b7e');
  assert.equal(v.freezeLabel, 'freeze v1');
  assert.equal(v.frozen, true);
  assert.equal(mk({ freezeVersion: 3, freezePostHoc: true }).freezeLabel, 'post-hoc freeze v3');
  assert.equal(mk({ freezeVersion: null, freezeSha256: sha('b') }).freezeLabel, 'frozen');
  const draft = mk({ status: 'draft', freezeVersion: null, freezeSha256: null });
  assert.equal(draft.freezeLabel, '');
  assert.equal(draft.frozen, false);
  assert.equal(mk({ packetSha256: '' }).label, 'v3');
  assert.equal(mk({ status: 'draft' }).frozen, false, 'a draft is not frozen even when it carries a freeze hash');
});

/* ---------- the board ---------- */
test('board: three synthetic tasks plus a legacy lineage and an unassigned round', () => {
  const w = idleWorld();
  const board = M.buildBoard({ ...w, now: NOW });
  assert.equal(board.status, 'live');
  assert.equal(board.redacted, false);
  assert.deepEqual(board.tasks.map(t => t.name), ['Atlas', 'Meridian', 'Cobalt', 'Borealis', 'Unassigned'], 'started order, Unassigned last');
  assert.deepEqual(board.tasks.map(t => t.unassigned), [false, false, false, false, true]);
  const atlas = byName(board, 'Atlas');
  assert.deepEqual(atlas.roundIds, ['atlas-r2', 'atlas-r1']);
  assert.equal(atlas.latestRoundId, 'atlas-r2');
  assert.equal(atlas.version.label, 'v2 · sha256:dddddddddddd');
  assert.equal(atlas.version.freezeLabel, 'freeze v2');
  assert.deepEqual({ running: atlas.active.running, waiting: atlas.active.waiting, total: atlas.active.total, available: atlas.active.available }, { running: 0, waiting: 0, total: 0, available: true });
  assert.equal(atlas.pilots.roundId, 'atlas-r2');
  assert.equal(atlas.status, 'needs-verdict');
  assert.equal(atlas.statusLabel, 'Needs your verdict');
  assert.equal(atlas.needsVerdict, 2);
  assert.equal(atlas.lastActivityAt, iso(2, 9, 40));
  const cobalt = byName(board, 'Cobalt');
  assert.deepEqual(cobalt.roundIds, ['cob-r2', 'cob-r1'], 'the legacy child joined its root label');
  assert.equal(cobalt.version.number, 2);
  assert.equal(byName(board, 'Meridian').pilots, null);
  assert.equal(byName(board, 'Meridian').version.label, 'v1 · sha256:aaaaaaaaaaaa');
  assert.equal(byName(board, 'Borealis').version.frozen, false);
  assert.equal(byName(board, 'Borealis').version.freezeLabel, '');
  assert.equal(byName(board, 'Unassigned').roundIds[0], 'una-r1');
  assert.deepEqual(board.counts, { tasks: 5, running: 0, waiting: 0, needsVerdict: 3, tasksRunning: 0, tasksNeedingVerdict: 2 }, 'Atlas has 2 and the unassigned round 1');
  assert.equal(board.primaryTaskKey, atlas.key);
  assert.deepEqual(board.incomplete, []);
  assert.equal(board.orphanRuns, 0);
  assert.equal(board.asOf, NOW);
});

test('board: pilot tally is completed AND CLEAN (the agents tally), never counts.clean', () => {
  /* round counts.clean counts the setup-error run (CLEAN audit, state failed) and the discarded run's neighbours */
  const w = made('tal-aaa1', { label: 'Atlas round 1', task: 'Atlas' }, [gold(), gold(), fp(), unclear(), done(), fail('setup-error'), discarded(), fail('timeout'), cancelled(), fail('exit-code', { audit: BAD })]);
  assert.equal(w.round.counts.clean, 6, 'counts.clean over-counts: it includes the failed setup-error run');
  assert.equal(w.round.counts.discarded, 2);
  const p = byName(M.buildBoard(w), 'Atlas').pilots;
  assert.equal(p.n, 5, 'k is completed AND CLEAN: 2 gold + fingerprint + unclear + 1 unclassified');
  assert.deepEqual([p.matchedGold, p.fingerprint, p.unclear, p.unclassified], [2, 1, 1, 1]);
  assert.equal(p.matchedGold + p.fingerprint + p.unclear + p.unclassified, p.n);
  assert.equal(p.discarded, 2, 'a failed run with a DISCARDED audit counts as discarded, not failed');
  assert.equal(p.failed, 2, 'setup-error and timeout');
  assert.equal(p.cancelled, 1);
  assert.equal(p.complete, true);
  assert.equal(p.directional, 'Directional only, n = 5.');
});

test('board: an unknown human verdict is counted as unclear so the tally still adds up', () => {
  const w = made('tal-aaa2', { label: 'Atlas round 1', task: 'Atlas' }, [gold(), done({ classification: { suggestedVerdict: null, humanVerdict: 'some-new-verdict' } }), done({ classification: { suggestedVerdict: null, humanVerdict: '' } })]);
  const p = byName(M.buildBoard(w), 'Atlas').pilots;
  assert.deepEqual([p.n, p.matchedGold, p.fingerprint, p.unclear, p.unclassified], [3, 1, 0, 1, 1]);
});

test('board: a round view run list (no roundId on the rows) is accepted by nextAction', () => {
  const round = roundRow('view-aaa1', { task: 'Atlas' }, [pilot('view-aaa1', 1), pilot('view-aaa1', 2, { classification: verdict('unclear') })]);
  const viewRuns = [pilot('view-aaa1', 1), pilot('view-aaa1', 2, { classification: verdict('unclear') })].map(r => { const { roundId, key, roundLabel, task, roundStatus, ...rest } = r; return { ...rest, id: `view-aaa1-${r.n}` }; });
  const a = M.nextAction({ ...round, runs: viewRuns });
  assert.equal(a.id, 'classify');
  assert.equal(a.label, 'Classify 1 clean pilot');
  assert.equal(a.target.runKey, 'view-aaa1:1');
});

test('board: a round whose pilot rows are not all loaded never gets a verdict tally', () => {
  const w = made('par-aaa1', { label: 'Atlas round 1', task: 'Atlas' }, [gold(), gold(), done(), done(), done()]);
  const board = M.buildBoard({ rounds: w.rounds ?? [w.round], runs: w.runs.slice(0, 2) });
  const t = byName(board, 'Atlas');
  assert.equal(t.pilots.complete, false);
  assert.equal(t.pilots.n, null);
  assert.equal(t.pilots.matchedGold, null);
  assert.equal(t.needsVerdict, 0);
  assert.equal(t.incomplete, true);
  assert.deepEqual(board.incomplete, ['par-aaa1']);
  assert.equal(t.nextAction.id, 'open');
  assert.equal(t.nextAction.primaryEligible, false);
  const rows = M.scoreRows(t);
  assert.equal(rows[0].text, 'Latest local pilots (round Atlas round 1): the pilot list has not loaded yet. Open the round in Agents.');
  assert.ok(!/matched|n =/.test(rows[0].text));
  /* with no run rows at all the board still works from the round rows */
  const bare = M.buildBoard({ rounds: [w.round] });
  assert.equal(byName(bare, 'Atlas').pilots.complete, false);
});

test('board: active agents are running plus waiting, from the pilot rows', () => {
  const board = M.buildBoard({ ...runningWorld(), now: NOW });
  const bor = byName(board, 'Borealis');
  assert.deepEqual({ running: bor.active.running, waiting: bor.active.waiting, total: bor.active.total }, { running: 2, waiting: 1, total: 3 });
  assert.equal(bor.status, 'running');
  assert.equal(bor.statusLabel, 'Pilots running');
  assert.equal(bor.active.elapsedMs, Date.parse(NOW) - Date.parse(iso(5, 10)));
  for (const t of board.tasks.filter(x => x !== bor)) assert.equal(t.active.total, 0, t.name);
  assert.deepEqual(board.counts, { tasks: 5, running: 3, waiting: 1, needsVerdict: 4, tasksRunning: 1, tasksNeedingVerdict: 3 }, 'Atlas 2, the unassigned round 1, Borealis 1');
});

test('board: active agents come from the round counts when its pilot rows are missing', () => {
  const w = runningWorld();
  const board = M.buildBoard({ rounds: w.rounds, redacted: true });
  const bor = byName(board, 'Borealis');
  assert.equal(bor.active.running, 2);
  assert.equal(bor.active.waiting, 1);
  assert.equal(bor.nextAction.id, 'watch');
  assert.equal(bor.nextAction.label, '1 of 5 pilots finished');
});

test('board: while a round runs, every card says so and no verdict count turns into a zero or a blank', () => {
  const board = M.buildBoard({ ...runningWorld(), now: NOW });
  assert.equal(board.redacted, true);
  assert.ok(board.tasks.every(t => t.redacted === true));
  const atlas = byName(board, 'Atlas');
  assert.equal(atlas.pilots.n, 3, 'verdict names survive redaction, so the tally is real');
  assert.equal(atlas.pilots.matchedGold, 1);
  assert.equal(atlas.pilots.unclassified, 2);
  assert.equal(atlas.needsVerdict, 2);
});

/* ---------- score rows (exact wording) ---------- */
test('scoreRows: the pilots row is the SPEC 3.2 sentence, character for character', () => {
  const w = made('sco-aaa1', { label: 'Atlas round 2', task: 'Atlas' }, [gold(), gold(), fp(), unclear(), done(), discarded(), fail('timeout')]);
  const rows = M.scoreRows(byName(M.buildBoard(w), 'Atlas'));
  assert.equal(rows[0].kind, 'pilots');
  assert.equal(rows[0].text, 'Latest local pilots (round Atlas round 2): 2 matched the frozen gold, 1 landed on a frozen fingerprint, 1 unclear, 1 not classified. Directional only, n = 5. Discarded 1 and failed 1 are not counted.');
  assert.equal(rows[0].note, '');
});

test('scoreRows: pilots row with no cancelled or running pilot has no extra sentence; with them it says so', () => {
  const plain = made('sco-aaa2', { label: 'Atlas round 1', task: 'Atlas' }, [done()]);
  assert.equal(M.scoreRows(byName(M.buildBoard(plain), 'Atlas'))[0].text, 'Latest local pilots (round Atlas round 1): 0 matched the frozen gold, 0 landed on a frozen fingerprint, 0 unclear, 1 not classified. Directional only, n = 1. Discarded 0 and failed 0 are not counted.');
  const cx = made('sco-aaa3', { label: 'Atlas round 1', task: 'Atlas' }, [done(), cancelled(), cancelled()]);
  assert.match(M.scoreRows(byName(M.buildBoard(cx), 'Atlas'))[0].text, / Discarded 0 and failed 0 are not counted\. Cancelled 2 are not counted\.$/);
  const run = made('sco-aaa4', { label: 'Atlas round 1', task: 'Atlas', status: 'running' }, [done(), live(), waiting(), cancelled()]);
  assert.match(M.scoreRows(byName(M.buildBoard(run), 'Atlas'))[0].text, / Discarded 0 and failed 0 are not counted\. Cancelled 1 and still running 2 are not counted\.$/);
});

test('scoreRows: a round with an empty label is named by its id', () => {
  const w = made('sco-aaa5', { label: 'Pilot round', task: 'Atlas' }, [done()]);
  assert.match(M.scoreRows(byName(M.buildBoard(w), 'Atlas'))[0].text, /^Latest local pilots \(round sco-aaa5\): /);
});

test('scoreRows: the imported evaluation row and the empty row are exact', () => {
  const w = made('sco-bbb1', { label: 'Atlas round 1', task: 'Atlas' }, [gold()]);
  const evals = [{ id: 'ev-1', task: 'Atlas', runId: 'run-77', attempt: 1, score: '7', scoreMax: 10, importedAt: '2026-10-03T23:59:00.000Z', sourceName: 'Facility_Terms.txt', judge: { provider: 'qa', model: 'browser-test-fixture' } }];
  const rows = M.scoreRows(byName(M.buildBoard({ ...w, evals }), 'Atlas'));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].kind, 'evaluation');
  assert.equal(rows[1].text, 'Imported evaluation result: 7 / 10, run run-77, 2026-10-03. Recorded by you from the evaluation; Finance Task Studio did not compute it.');
  assert.equal(rows[1].note, '');
  const empty = M.scoreRows(byName(M.buildBoard({ rounds: [roundRow('sco-ccc1', { task: 'Meridian', status: 'frozen' })] }), 'Meridian'));
  assert.deepEqual(empty.map(r => [r.kind, r.text]), [['empty', 'No score recorded. Pilots and the simulated grader are not scored.']]);
  /* pilots without an evaluation: the pilots row, then the empty row, so a tally is never read as a score */
  const both = M.scoreRows(byName(M.buildBoard(w), 'Atlas'));
  assert.deepEqual(both.map(r => r.kind), ['pilots', 'empty']);
  assert.equal(both[1].text, M.EMPTY_SCORE);
  /* never more than two rows, never a simulated-grader row */
  for (const t of M.buildBoard({ ...idleWorld(), evals }).tasks) {
    const r = M.scoreRows(t);
    assert.ok(r.length >= 1 && r.length <= 2);
    assert.ok(r.every(x => ['pilots', 'evaluation', 'empty'].includes(x.kind)));
    assert.ok(!/simulated/i.test(r.filter(x => x.kind !== 'empty').map(x => x.text).join(' ')), 'only the pinned empty sentence mentions the grader');
  }
  assert.deepEqual(M.scoreRows(null).map(r => r.kind), ['empty']);
  assert.deepEqual(M.scoreRows({}).map(r => r.kind), ['empty']);
});

test('scoreRows: the evaluation row shows the strings as recorded and does no arithmetic', () => {
  const mk = rec => M.scoreRows(byName(M.buildBoard({ rounds: [roundRow('sco-ddd1', { task: 'Atlas' })], evals: [{ task: 'Atlas', importedAt: iso(3), runId: 'r1', ...rec }] }), 'Atlas')).find(r => r.kind === 'evaluation');
  assert.match(mk({ score: '82.5', scoreMax: '100' }).text, /^Imported evaluation result: 82\.5 \/ 100, run r1, /);
  assert.match(mk({ score: 0, scoreMax: 5 }).text, /^Imported evaluation result: 0 \/ 5, /);
  assert.match(mk({ score: 3 }).text, /^Imported evaluation result: 3, run r1/, 'a missing maximum is not invented');
  assert.match(mk({ score: ' 7 ', scoreMax: ' 10 ' }).text, /^Imported evaluation result: 7 \/ 10, /);
  assert.match(mk({ score: -1.5, scoreMax: 10 }).text, /^Imported evaluation result: -1\.5 \/ 10, /);
  const noRun = M.scoreRows(byName(M.buildBoard({ rounds: [roundRow('sco-ddd2', { task: 'Atlas' })], evals: [{ task: 'Atlas', score: 2, scoreMax: 3 }] }), 'Atlas')).find(r => r.kind === 'evaluation');
  assert.match(noRun.text, /^Imported evaluation result: 2 \/ 3, run not recorded, date not recorded\./);
});

/* ---------- imported evaluation records ---------- */
test('evaluation picker: the latest record per task by importedAt, tasks matched without regard to case', () => {
  const rounds = [roundRow('ev-aaa1', { task: 'Atlas' }), roundRow('ev-bbb1', { task: 'Meridian', createdAt: iso(1, 10) })];
  const evals = [
    { id: 'e1', task: 'Atlas', runId: 'old', score: 1, scoreMax: 10, importedAt: iso(2) },
    { id: 'e2', task: 'atlas', runId: 'newest', score: 9, scoreMax: 10, importedAt: iso(4) },
    { id: 'e3', task: ' ATLAS ', runId: 'middle', score: 5, scoreMax: 10, importedAt: iso(3) },
    { id: 'e4', task: 'Meridian', runId: 'mer', score: 2, scoreMax: 4, importedAt: iso(2) }
  ];
  const board = M.buildBoard({ rounds, evals });
  assert.equal(byName(board, 'Atlas').evaluation.runId, 'newest');
  assert.equal(byName(board, 'Atlas').evaluation.score, 9);
  assert.equal(byName(board, 'Meridian').evaluation.runId, 'mer');
  assert.deepEqual(board.tasks.length, 2, 'evaluations of the same task make one card');
});

test('evaluation picker: ties and bad dates are decided the same way whatever the input order', () => {
  const recs = [
    { id: 'a', task: 'Atlas', runId: 'r-a', score: 1, scoreMax: 2, importedAt: iso(2) },
    { id: 'b', task: 'Atlas', runId: 'r-b', score: 2, scoreMax: 2, importedAt: iso(2) },
    { id: 'c', task: 'Atlas', runId: 'r-c', score: 1, scoreMax: 2, importedAt: 'not a date' },
    { id: 'd', task: 'Atlas', runId: 'r-d', score: 1, scoreMax: 2 }
  ];
  const pick = list => M.pickEvaluations(list).get(M.taskKey({ task: 'Atlas' }));
  assert.equal(pick(recs).id, 'b', 'equal time: the greater id');
  assert.equal(pick(recs.slice().reverse()).id, 'b');
  assert.equal(pick([recs[2], recs[3]]).id, 'd', 'two undated records: the greater id');
  assert.equal(pick(recs.slice(2)).id, pick(recs.slice(2).reverse()).id);
  /* a dated record beats an undated one */
  assert.equal(pick([recs[3], recs[0]]).id, 'a');
});

test('evaluation picker: only a finite number or a plain numeric string is a score', () => {
  const rec = score => ({ task: 'Atlas', runId: 'r', score, scoreMax: 10, importedAt: iso(2) });
  const accepted = [0, 7, 7.5, -2, '7', '7.25', ' 8 ', '-1'];
  const refused = [NaN, Infinity, null, undefined, '', 'seven', '7%', '70 %', '7/10', '1e3', true, {}, [], '7,5', '٧'];
  for (const s of accepted) assert.ok(M.pickEvaluations([rec(s)]).size === 1, `accept ${JSON.stringify(s)}`);
  for (const s of refused) assert.equal(M.pickEvaluations([rec(s)]).size, 0, `refuse ${JSON.stringify(s)}`);
  for (const bad of [null, undefined, 'x', 5, [], [null], [[]]]) assert.equal(M.pickEvaluations(bad).size, 0);
  /* a refused newer record does not hide an older valid one */
  const kept = M.pickEvaluations([{ ...rec(5), runId: 'valid', importedAt: iso(1) }, { ...rec('7%'), runId: 'refused', importedAt: iso(9) }]);
  assert.equal([...kept.values()][0].runId, 'valid');
});

test('evaluation: Earlier version appears only when the recorded packet differs from the latest round, when known', () => {
  const latest = roundRow('ver-aaa2', { task: 'Atlas', packetSha256: sha('d') });
  const old = roundRow('ver-aaa1', { task: 'Atlas', createdAt: iso(1), packetSha256: sha('a') });
  const mk = rec => byName(M.buildBoard({ rounds: [old, { ...latest, createdAt: iso(2) }], evals: [{ task: 'Atlas', runId: 'r', score: 1, scoreMax: 2, importedAt: iso(3), ...rec }] }), 'Atlas').evaluation.versionNote;
  assert.equal(mk({ packetSha256: sha('d') }), '', 'same packet');
  assert.equal(mk({ packetSha256: sha('a') }), 'Earlier version');
  assert.equal(mk({ packetSha256: sha('D') }), '', 'case does not matter');
  assert.equal(mk({ packetSha256: 'd'.repeat(12) }), '', 'a 12 character prefix of the packet hash is the same packet');
  assert.equal(mk({ packetSha256: 'a'.repeat(12) }), 'Earlier version');
  assert.equal(mk({ packetSha256: 'dddd' }), '', 'too short to compare: unknown, so no note');
  assert.equal(mk({}), '', 'not recorded: unknown, so no note');
  assert.equal(mk({ roundId: 'ver-aaa1' }), 'Earlier version', 'recorded against an older round');
  assert.equal(mk({ roundId: 'ver-aaa2' }), '');
  assert.equal(mk({ roundId: 'not-in-list' }), '');
  assert.equal(mk({ packetSha256: sha('d'), roundId: 'ver-aaa1' }), '', 'the packet hash wins over the round id');
  const row = M.scoreRows(byName(M.buildBoard({ rounds: [old, { ...latest, createdAt: iso(2) }], evals: [{ task: 'Atlas', runId: 'r', score: 1, scoreMax: 2, importedAt: iso(3), packetSha256: sha('a') }] }), 'Atlas')).find(r => r.kind === 'evaluation');
  assert.equal(row.note, 'Earlier version');
  assert.ok(!row.text.includes('Earlier version'), 'the exact sentence stays exact; the note is its own field');
});

test('evaluation: a task with only an imported result still gets a card (also offline)', () => {
  const evals = [{ task: 'Cobalt', runId: 'r-1', score: 3, scoreMax: 4, importedAt: iso(2), sourceName: 'Cash_Facts.csv' }, { runId: 'r-2', score: 1, scoreMax: 4, importedAt: iso(2) }];
  const board = M.buildBoard({ evals, offline: true });
  assert.equal(board.status, 'offline');
  assert.deepEqual(board.tasks.map(t => t.name), ['Cobalt', 'Unassigned']);
  const cobalt = board.tasks[0];
  assert.equal(cobalt.status, 'empty');
  assert.equal(cobalt.latestRoundId, null);
  assert.deepEqual(cobalt.roundIds, []);
  assert.equal(cobalt.evaluation.sourceName, 'Cash_Facts.csv');
  assert.equal(cobalt.evaluation.versionNote, '');
  assert.equal(cobalt.nextAction.id, 'start');
  assert.equal(cobalt.nextAction.target.roundId, null);
  assert.equal(cobalt.nextAction.primaryEligible, false);
  assert.deepEqual(M.scoreRows(cobalt).map(r => r.kind), ['evaluation']);
  assert.equal(board.tasks[1].unassigned, true);
});

/* ---------- next action ---------- */
const act = (status, runSpecs, over = {}, options = {}) => {
  const w = made('act-aaa1', { label: 'Atlas round 1', task: 'Atlas', status, ...over }, runSpecs);
  return M.nextAction(w.round, { runs: w.runs, ...options });
};
test('nextAction: every state in the Agents step order', () => {
  const table = [
    ['draft', [], { freezeSha256: null, freezeVersion: null }, {}, 'freeze', 'Freeze the round', 'freeze'],
    ['frozen', [], {}, {}, 'approve', 'Review and approve', 'round'],
    ['approved', [], {}, {}, 'launch', 'Launch', 'round'],
    ['running', [done(), live(), live(), waiting(), waiting()], {}, {}, 'watch', '1 of 5 pilots finished', 'runs'],
    ['running', [fail('exit-code'), live()], {}, {}, 'watch', '0 of 2 pilots finished', 'runs'],
    ['running', [live()], {}, {}, 'watch', '0 of 1 pilot finished', 'runs'],
    ['finished', [gold(), done(), done()], {}, {}, 'classify', 'Classify 2 clean pilots', 'runs'],
    ['finished', [gold(), done()], {}, {}, 'classify', 'Classify 1 clean pilot', 'runs'],
    ['cancelled', [done(), cancelled()], {}, {}, 'classify', 'Classify 1 clean pilot', 'runs'],
    ['failed', [done(), fail('timeout')], {}, {}, 'classify', 'Classify 1 clean pilot', 'runs'],
    ['finished', [gold(), fp(), unclear()], {}, {}, 'export', 'Export', 'runs'],
    ['finished', [fail('timeout'), discarded(), cancelled()], {}, {}, 'start-next', 'Start next round', 'runs'],
    ['failed', [fail('exit-code'), fail('budget')], {}, {}, 'start-next', 'Start next round', 'runs'],
    ['cancelled', [], {}, {}, 'start-next', 'Start next round', 'runs']
  ];
  for (const [status, specs, over, options, id, label, step] of table) {
    const a = act(status, specs, over, options);
    assert.equal(a.id, id, `${status} ${specs.length}: id`);
    assert.equal(a.label, label, `${status}: label`);
    assert.equal(a.target.step, step, `${status}: step`);
    assert.equal(a.target.view, 'agents');
    assert.equal(a.target.roundId, 'act-aaa1');
    assert.equal(a.cta, 'Open in Agents');
    assert.equal(a.primaryEligible, false, 'only the board marks the primary');
    assert.equal(a.urgency, M.URGENCY[id]);
    assert.ok(a.detail.length > 10);
    assert.ok(!/\b(ready|done)\b/i.test(a.label + ' ' + a.detail), 'never say ready or done');
  }
});

test('nextAction: classify points at the first unclassified clean pilot and is followed by export, then start next', () => {
  const a = act('finished', [gold(), fail('timeout'), done(), done()]);
  assert.equal(a.target.runKey, 'act-aaa1:3');
  assert.equal(a.then.id, 'export');
  const e = act('finished', [gold(), gold()]);
  assert.equal(e.id, 'export');
  assert.equal(e.then.id, 'start-next');
  assert.equal(e.then.blocked, false);
  assert.equal(M.nextAction(made('act-aaa2', { task: 'Atlas' }, [fail('timeout')]).round, { runs: made('act-aaa2', { task: 'Atlas' }, [fail('timeout')]).runs }).then, null);
});

test('nextAction: while any round runs Start next round is disabled, classification and launch wait, and the rest are not blocked', () => {
  const blocked = (status, specs, id) => { const a = act(status, specs, {}, { anyRunning: true }); assert.equal(a.id, id); return a; };
  const next = blocked('finished', [fail('timeout')], 'start-next');
  assert.equal(next.blocked, true);
  assert.match(next.blockedReason, /^A round is running\. Start the next round when it has ended/);
  const classify = blocked('finished', [done()], 'classify');
  assert.equal(classify.blocked, true);
  assert.equal(classify.blockedReason, 'Classification waits until no round is running.');
  assert.equal(classify.then.id, 'export');
  assert.equal(blocked('finished', [gold()], 'export').then.blocked, true);
  assert.equal(blocked('approved', [], 'launch').blocked, true);
  for (const [status, specs, id] of [['draft', [], 'freeze'], ['frozen', [], 'approve'], ['finished', [gold()], 'export']]) assert.equal(blocked(status, specs, id).blocked, false, id);
  /* a redacted answer means a round runs */
  assert.equal(act('finished', [fail('timeout')], {}, { redacted: true }).blocked, true);
  /* the running round itself is never blocked */
  assert.equal(act('running', [live()], {}, { anyRunning: true }).blocked, false);
  /* nothing running: nothing blocked */
  assert.equal(act('finished', [fail('timeout')]).blocked, false);
  assert.equal(act('finished', [fail('timeout')]).blockedReason, '');
});

test('nextAction: an ended round with no freeze cannot be carried forward; unknown statuses and bad input fall back to Open in Agents', () => {
  const noFreeze = act('failed', [fail('timeout')], { freezeSha256: null, freezeVersion: null });
  assert.equal(noFreeze.id, 'start-next');
  assert.equal(noFreeze.blocked, true);
  assert.equal(noFreeze.blockedReason, 'This round has no freeze to carry forward.');
  const odd = act('mystery', []);
  assert.equal(odd.id, 'open');
  assert.equal(odd.label, 'Open in Agents');
  for (const bad of [null, undefined, 'x', 5, [], {}]) { const a = M.nextAction(bad); assert.equal(a.id, 'open'); assert.equal(typeof a.detail, 'string'); }
});

test('nextAction: a running round is running even when only its status says so, or only its pilot rows do', () => {
  const byStatus = M.nextAction(roundRow('act-bbb1', { status: 'running', runCount: 0, counts: undefined, config: { count: 4 } }), {});
  assert.equal(byStatus.id, 'watch');
  assert.equal(byStatus.label, '0 of 4 pilots finished');
  const w = made('act-bbb2', { task: 'Atlas', status: 'finished' }, [live(), done()]);
  assert.equal(M.nextAction(w.round, { runs: w.runs }).id, 'watch', 'a stale finished status next to a running pilot row');
  assert.match(act('running', [done(), live(), waiting(), fail('timeout'), cancelled()]).detail, /^1 running, 1 waiting, 1 failed, 1 cancelled\. /);
});

/* ---------- which task is the one primary ---------- */
test('primary: running beats needs-verdict beats approved beats frozen beats draft beats export beats start-next', () => {
  const order = [
    ['watch', 'running', [live()]],
    ['classify', 'finished', [done()]],
    ['launch', 'approved', []],
    ['approve', 'frozen', []],
    ['freeze', 'draft', []],
    ['export', 'finished', [gold()]],
    ['start-next', 'finished', [fail('timeout')]]
  ];
  const tasks = order.map(([id, status, specs], i) => made(`prm-aaa${i}`, { label: `Atlas ${id}`, task: `T${i}`, status, createdAt: iso(1, 9, i), lastActivityAt: iso(1, 9, i) }, specs));
  for (let first = 0; first < order.length; first++) {
    /* drop every task more urgent than `first`, and the least urgent should then be on top */
    const kept = tasks.slice(first);
    const board = M.buildBoard({ ...combine(...kept) });
    const primaries = board.tasks.filter(t => t.nextAction.primaryEligible);
    if (first <= 4) {
      assert.equal(primaries.length, 1, `step ${first}`);
      assert.equal(primaries[0].nextAction.id, order[first][0]);
      assert.equal(board.primaryTaskKey, primaries[0].key);
    } else {
      assert.equal(primaries.length, 0, 'export and start-next are never the one yellow button');
      assert.equal(board.primaryTaskKey, null);
    }
  }
});

test('primary: exactly one task at most, whatever the input order', () => {
  for (const w of [idleWorld(), runningWorld()]) {
    const board = M.buildBoard(w);
    assert.equal(board.tasks.filter(t => t.nextAction.primaryEligible).length, 1);
    const shuffled = M.buildBoard({ rounds: w.rounds.slice().reverse(), runs: w.runs.slice().reverse(), redacted: w.redacted });
    assert.equal(shuffled.primaryTaskKey, board.primaryTaskKey);
  }
  assert.equal(M.buildBoard(runningWorld()).primaryTaskKey, M.taskKey({ task: 'Borealis' }));
  assert.equal(M.buildBoard(idleWorld()).primaryTaskKey, M.taskKey({ task: 'Atlas' }));
});

test('primary: a blocked action never takes the yellow button', () => {
  const w = runningWorld();
  const board = M.buildBoard(w);
  const atlas = byName(board, 'Atlas');
  assert.equal(atlas.nextAction.id, 'classify');
  assert.equal(atlas.nextAction.blocked, true);
  assert.equal(atlas.nextAction.primaryEligible, false);
  /* a redacted answer with no round in the list: nothing is running that this page can see, but classification still waits */
  const lonely = made('prm-bbb1', { task: 'Atlas' }, [done()]);
  const board2 = M.buildBoard({ rounds: [lonely.round], runs: lonely.runs, redacted: true });
  assert.equal(board2.tasks[0].nextAction.blocked, true);
  assert.equal(board2.primaryTaskKey, null);
  /* a frozen round with the running round elsewhere is still reachable: approve is not blocked, but launch is */
  const frozen = made('prm-bbb2', { task: 'Meridian', status: 'frozen', createdAt: iso(2) }, []);
  const approved = made('prm-bbb3', { task: 'Cobalt', status: 'approved', createdAt: iso(2) }, []);
  const run = made('prm-bbb4', { task: 'Borealis', status: 'running', createdAt: iso(2) }, [live()]);
  const b3 = M.buildBoard(combine(frozen, approved, run));
  assert.equal(byName(b3, 'Meridian').nextAction.blocked, false);
  assert.equal(byName(b3, 'Cobalt').nextAction.blocked, true);
  assert.equal(byName(b3, 'Cobalt').nextAction.blockedReason, 'Another round is running. Launch waits until it has ended.');
  assert.equal(byName(b3, 'Borealis').nextAction.primaryEligible, true);
});

test('primary tie-break: same urgency goes to the freshest activity, then the name, then the key', () => {
  const two = (a, b) => M.buildBoard(combine(made('tie-aaa1', { task: a.task, label: 'x', status: 'frozen', lastActivityAt: a.at, createdAt: iso(1, 9) }, []), made('tie-bbb1', { task: b.task, label: 'y', status: 'frozen', lastActivityAt: b.at, createdAt: iso(1, 9, 1) }, [])));
  assert.equal(two({ task: 'Atlas', at: iso(2) }, { task: 'Meridian', at: iso(3) }).primaryTaskKey, M.taskKey({ task: 'Meridian' }), 'freshest first');
  assert.equal(two({ task: 'Atlas', at: iso(3) }, { task: 'Meridian', at: iso(2) }).primaryTaskKey, M.taskKey({ task: 'Atlas' }));
  assert.equal(two({ task: 'Meridian', at: iso(2) }, { task: 'Atlas', at: iso(2) }).primaryTaskKey, M.taskKey({ task: 'Atlas' }), 'same time: name');
  assert.equal(two({ task: 'meridian', at: iso(2) }, { task: 'Atlas', at: iso(2) }).primaryTaskKey, M.taskKey({ task: 'Atlas' }), 'name is compared without regard to case');
  assert.equal(two({ task: 'Atlas', at: null }, { task: 'Meridian', at: iso(2) }).primaryTaskKey, M.taskKey({ task: 'Meridian' }), 'an undated task loses');
});

test('a task takes the most urgent step across its rounds: older unclassified pilots outrank a new draft, an old stale draft is ignored', () => {
  const old = made('mul-aaa1', { task: 'Atlas', label: 'Atlas round 1', createdAt: iso(1) }, [done(), gold()]);
  const draft = made('mul-aaa2', { task: 'Atlas', label: 'Atlas round 2', status: 'draft', createdAt: iso(2), carriedFrom: 'mul-aaa1', carriedDepth: 1, freezeSha256: null, freezeVersion: null }, []);
  const t = byName(M.buildBoard(combine(old, draft)), 'Atlas');
  assert.equal(t.nextAction.id, 'classify');
  assert.equal(t.nextAction.roundId, 'mul-aaa1');
  assert.equal(t.latestRoundId, 'mul-aaa2');
  assert.equal(t.status, 'needs-verdict');
  /* an abandoned frozen round does not nag once a newer round exists */
  const stale = made('mul-bbb1', { task: 'Atlas', label: 'one', status: 'frozen', createdAt: iso(1) }, []);
  const newer = made('mul-bbb2', { task: 'Atlas', label: 'two', status: 'finished', createdAt: iso(2) }, [fail('timeout')]);
  assert.equal(byName(M.buildBoard(combine(stale, newer)), 'Atlas').nextAction.id, 'start-next');
});

test('task status: running, needs-verdict, attention, idle and empty', () => {
  const st = (status, specs, over) => byName(M.buildBoard(combine(made('sta-aaa1', { task: 'Atlas', status, ...over }, specs))), 'Atlas');
  assert.equal(st('running', [live()]).status, 'running');
  assert.equal(st('finished', [done()]).status, 'needs-verdict');
  assert.equal(st('finished', [gold(), discarded()]).status, 'attention');
  assert.equal(st('finished', [gold(), fail('timeout')]).status, 'attention');
  assert.equal(st('failed', [fail('timeout')]).status, 'attention');
  assert.equal(st('finished', [gold(), cancelled()]).status, 'idle', 'a cancelled pilot is the person choice, not a problem');
  assert.equal(st('cancelled', [gold()]).status, 'idle');
  assert.equal(st('finished', [gold(), fp()]).status, 'idle');
  assert.equal(st('draft', [], { freezeSha256: null, freezeVersion: null }).status, 'idle');
  assert.equal(st('draft', [], { freezeSha256: null, freezeVersion: null }).statusLabel, 'Draft round');
  assert.equal(st('frozen', []).statusLabel, 'Frozen round');
  const labels = [st('running', [live()]), st('finished', [done()]), st('failed', [fail('timeout')]), st('finished', [gold()])].map(t => t.statusLabel);
  assert.deepEqual(labels, ['Pilots running', 'Needs your verdict', 'Needs attention', 'Round ended']);
  /* a new draft after a bad round is idle: the person already moved on */
  const moved = combine(made('sta-bbb1', { task: 'Atlas', status: 'failed', createdAt: iso(1) }, [fail('timeout')]), made('sta-bbb2', { task: 'Atlas', status: 'draft', createdAt: iso(2), freezeSha256: null, freezeVersion: null }, []));
  assert.equal(byName(M.buildBoard(moved), 'Atlas').status, 'idle');
});

test('board order: cards keep the order the tasks were started in, a new round never moves a card', () => {
  const w = idleWorld();
  const names = M.buildBoard(w).tasks.map(t => t.name);
  const extra = made('atlas-r3', { label: 'Atlas round 3', task: 'Atlas', createdAt: iso(9), carriedFrom: 'atlas-r2', carriedDepth: 2, status: 'draft', freezeSha256: null, freezeVersion: null }, []);
  const next = M.buildBoard({ rounds: [...w.rounds, extra.round], runs: w.runs });
  assert.deepEqual(next.tasks.map(t => t.name), names);
  assert.equal(byName(next, 'Atlas').latestRoundId, 'atlas-r3');
  const newTask = made('new-r1', { label: 'Later', task: 'Dover', createdAt: iso(10) }, [done()]);
  const appended = M.buildBoard({ rounds: [...w.rounds, newTask.round], runs: w.runs.concat(newTask.runs) });
  assert.deepEqual(appended.tasks.map(t => t.name), [...names.slice(0, -1), 'Dover', 'Unassigned']);
});

/* ---------- the feed ---------- */
function feedWorld() {
  const done1 = made('fee-aaa1', { label: 'Atlas round 1', task: 'Atlas', createdAt: iso(1), status: 'finished' }, [gold(), done(), discarded(), fail('exit-code'), cancelled()]);
  const live2 = made('fee-bbb1', { label: 'Borealis round 1', task: 'Borealis', createdAt: iso(5), status: 'running' }, [done(), live(), waiting()]);
  return combine(done1, live2);
}
test('feed: rounds newest first, pilots ascending, every item keyed roundId:n', () => {
  const w = feedWorld();
  const feed = M.buildFeed({ runs: w.runs, now: NOW });
  assert.deepEqual(feed.items.map(i => i.key), ['fee-bbb1:1', 'fee-bbb1:2', 'fee-bbb1:3', 'fee-aaa1:1', 'fee-aaa1:2', 'fee-aaa1:3', 'fee-aaa1:4', 'fee-aaa1:5']);
  assert.deepEqual(feed.groups.map(g => [g.roundId, g.count, g.taskName, g.roundName]), [['fee-bbb1', 3, 'Borealis', 'Borealis round 1'], ['fee-aaa1', 5, 'Atlas', 'Atlas round 1']]);
  assert.deepEqual(feed.groups.map(g => g.keys), [feed.items.slice(0, 3).map(i => i.key), feed.items.slice(3).map(i => i.key)]);
  assert.equal(new Set(feed.items.map(i => i.key)).size, feed.items.length);
  assert.ok(feed.items.every(i => i.kind === 'pilot'));
});

test('feed: a glyph and a WORD for every state', () => {
  const w = feedWorld();
  const items = M.buildFeed({ runs: w.runs, now: NOW }).items;
  const seen = new Map(items.map(i => [i.stateWord, i.glyph]));
  assert.deepEqual([...seen.keys()].sort(), ['CANCELLED', 'COMPLETED', 'DISCARDED', 'FAILED', 'RUNNING', 'WAITING']);
  assert.equal(new Set(seen.values()).size, seen.size, 'each state has its own glyph');
  for (const [word, glyph] of seen) { assert.ok(glyph.length >= 1, word); assert.ok(!/[A-Za-z0-9]/.test(glyph), `${word}: glyph is a symbol, not a letter`); }
  assert.equal(items.find(i => i.key === 'fee-aaa1:3').stateWord, 'DISCARDED', 'the audit verdict wins over the process state');
  const odd = M.buildFeed({ runs: [pilot('fee-ccc1', 1, { state: 'mystery' })] }).items[0];
  assert.equal(odd.stateWord, 'UNKNOWN');
  assert.ok(odd.glyph);
  assert.equal(odd.happened, 'The companion reported a state this page does not recognise');
  for (const s of Object.values(M.STATES)) assert.ok(s.glyph && s.word && s.key);
});

test('feed: the happened sentence for each state', () => {
  const w = feedWorld();
  const by = new Map(M.buildFeed({ runs: w.runs, now: NOW }).items.map(i => [i.key, i]));
  assert.equal(by.get('fee-aaa1:1').happened, 'Completed in 4m 12s, 31 tool calls, audit CLEAN');
  assert.equal(by.get('fee-aaa1:3').happened, 'Discarded by the audit: 2 violations recorded. Kept for reading, not classified, not counted');
  assert.equal(by.get('fee-aaa1:4').happened, 'The program exited with code 1');
  assert.equal(by.get('fee-aaa1:5').happened, 'Cancelled before it finished');
  assert.equal(by.get('fee-bbb1:2').happened, 'Running, 4 tool calls so far');
  assert.equal(by.get('fee-bbb1:3').happened, 'Waiting to start');
  assert.equal(M.buildFeed({ runs: [pilot('fee-ccc1', 1, { toolCalls: { total: 1, bash: 1, file: 0 } })] }).items[0].happened, 'Completed in 4m 12s, 1 tool call, audit CLEAN');
  assert.equal(M.buildFeed({ runs: [pilot('fee-ccc1', 1, { startedAt: null, toolCalls: { total: null } })] }).items[0].happened, 'Completed, audit CLEAN');
  assert.equal(M.buildFeed({ runs: [pilot('fee-ccc1', 1, { audit: null })] }).items[0].happened, 'Completed in 4m 12s, 31 tool calls, audit pending');
  assert.equal(M.buildFeed({ runs: [pilot('fee-ccc1', 1, { audit: { status: 'DISCARDED', violationCount: 0 } })] }).items[0].happened, 'Discarded by the audit. Kept for reading, not classified, not counted');
  assert.equal(M.buildFeed({ runs: [pilot('fee-ccc1', 1, { audit: BAD, state: 'failed', failureReason: 'timeout' })] }).items[0].stateWord, 'DISCARDED');
  assert.equal(M.buildFeed({ runs: [running('fee-ccc1', 1, { toolCalls: { total: 0 } })] }).items[0].happened, 'Running, no tool calls yet');
  assert.equal(M.buildFeed({ runs: [running('fee-ccc1', 1, { toolCalls: { total: 1 } })] }).items[0].happened, 'Running, 1 tool call so far');
  assert.equal(M.buildFeed({ runs: [pilot('fee-ccc1', 1, { state: 'cancelled', startedAt: null, endedAt: null, failureReason: 'cancelled' })] }).items[0].happened, 'Cancelled before it started');
});

test('feed: running items carry the elapsed time from the now argument, not a clock', () => {
  const r = running('fee-ddd1', 1, { startedAt: iso(5, 10, 0, 0) });
  const at = (h, m) => M.buildFeed({ runs: [r], now: iso(5, h, m) }).items[0];
  assert.equal(at(10, 4).durationMs, 4 * 60000);
  assert.equal(at(10, 4).durationText, '4m 00s');
  assert.equal(at(10, 4).happened, at(11, 40).happened, 'the sentence does not change with the clock');
  assert.equal(M.buildFeed({ runs: [r] }).items[0].durationMs, null, 'no now, no elapsed');
  assert.equal(M.buildFeed({ runs: [r], now: 'garbage' }).items[0].durationMs, null);
  assert.equal(M.buildFeed({ runs: [r], now: iso(5, 9, 0) }).items[0].durationMs, 0, 'a clock behind the start never goes negative');
  assert.equal(M.buildFeed({ runs: [queued('fee-ddd1', 2)], now: NOW }).items[0].durationMs, null);
  assert.equal(M.buildFeed({ runs: [pilot('fee-ddd1', 3)], now: NOW }).items[0].durationMs, 252000, 'an ended pilot is measured by its own timestamps');
});

test('feed: the output descriptor names files, characters, the evidence folder and the working folder', () => {
  const items = M.buildFeed({ runs: [pilot('fee-eee1', 1), running('fee-eee1', 2), pilot('fee-eee1', 3, { evidencePath: undefined }), pilot('fee-eee1', 4, { evidencePath: null }), pilot('fee-eee1', 5, { workingFolder: '/tmp/finance-studio-pilots/x' }), pilot('fee-eee1', 6, { evidencePath: '/home/me/private/agent-rounds/x' })] }).items;
  assert.deepEqual(items[0].output, { files: 2, chars: 1240, relPath: 'private/agent-rounds/fee-eee1/runs/1/outputs/', workingFolder: 'finance-studio-pilots/fee-eee1-1', ready: true });
  assert.deepEqual(items[1].output, { files: 0, chars: 0, relPath: null, workingFolder: 'finance-studio-pilots/fee-eee1-2', ready: false });
  assert.equal(items[2].output.relPath, 'private/agent-rounds/fee-eee1/runs/3/outputs/', 'an ended pilot from a server that omits the key gets the deterministic path');
  assert.deepEqual([items[3].output.relPath, items[3].output.ready], [null, false], 'an explicit null is respected');
  assert.equal(items[4].output.workingFolder, null, 'an absolute path never reaches the page');
  assert.equal(items[5].output.relPath, null);
  assert.ok(M.buildFeed({ runs: [pilot('fee-eee1', 1, { outputCount: undefined, final: undefined })] }).items[0].output.files === null);
});

test('feed: what ran reads Pilot n, round, model', () => {
  const items = M.buildFeed({ runs: [pilot('fee-fff1', 3, { roundLabel: 'Atlas round 2' }), pilot('fee-fff2', 1, { roundLabel: 'Pilot round' }), pilot('fee-fff3', 2, { roundLabel: '', resolvedModel: '', requestedModel: '' }), pilot('fee-fff4', 2, { resolvedModel: '', requestedModel: 'asked-for' })] }).items;
  const what = Object.fromEntries(items.map(i => [i.key, i.what]));
  assert.equal(what['fee-fff1:3'], 'Pilot 3 · Atlas round 2 · browser-test-fixture');
  assert.equal(what['fee-fff2:1'], 'Pilot 1 · fee-fff2 · browser-test-fixture');
  assert.equal(what['fee-fff3:2'], 'Pilot 2 · fee-fff3');
  assert.equal(what['fee-fff4:2'], 'Pilot 2 · fee-fff4 · asked-for'.replace('fee-fff4', 'QA fixture round'));
});

test('feed: the verdict name rides along, needsVerdict means completed and CLEAN with no verdict', () => {
  const items = M.buildFeed({ runs: [pilot('fee-ggg1', 1), pilot('fee-ggg1', 2, { classification: verdict('fingerprint') }), pilot('fee-ggg1', 3, { audit: BAD }), pilot('fee-ggg1', 4, { state: 'failed', failureReason: 'timeout', audit: CLEAN }), pilot('fee-ggg1', 5, { classification: { suggestedVerdict: 'unclear', humanVerdict: null } }), pilot('fee-ggg1', 6, { classification: { suggested: { verdict: 'x' }, human: { verdict: 'unclear' } } }), pilot('fee-ggg1', 7, { classification: { humanVerdict: 'zzz' } })] }).items;
  assert.deepEqual(items.map(i => i.needsVerdict), [true, false, false, false, true, false, false]);
  assert.equal(items[1].verdict.label, 'Lands on a frozen fingerprint');
  assert.equal(items[0].verdict, null);
  assert.equal(items[5].verdict.id, 'unclear', 'the run detail shape is accepted too');
  assert.equal(items[6].verdict.label, 'Unclear, or neither');
});

test('feed filters: task by key or by name, and the state filters, with counts for the task filter', () => {
  const w = feedWorld();
  const all = M.buildFeed({ runs: w.runs, now: NOW });
  assert.deepEqual(all.counts, { all: 8, running: 2, waiting: 1, needsVerdict: 2, failed: 1, discarded: 1, completed: 3, cancelled: 1 });
  const atlas = M.buildFeed({ runs: w.runs, filter: { task: M.taskKey({ task: 'Atlas' }) } });
  assert.equal(atlas.items.length, 5);
  assert.deepEqual(atlas.counts, { all: 5, running: 0, waiting: 0, needsVerdict: 1, failed: 1, discarded: 1, completed: 2, cancelled: 1 });
  assert.deepEqual(M.buildFeed({ runs: w.runs, filter: { task: ' atlas ' } }).items.map(i => i.key), atlas.items.map(i => i.key), 'a name works as well as a key');
  assert.equal(M.buildFeed({ runs: w.runs, filter: { task: 'Nobody' } }).items.length, 0);
  const cases = { running: ['fee-bbb1:2', 'fee-bbb1:3'], 'needs-verdict': ['fee-bbb1:1', 'fee-aaa1:2'], failed: ['fee-aaa1:4'], discarded: ['fee-aaa1:3'], completed: ['fee-bbb1:1', 'fee-aaa1:1', 'fee-aaa1:2'], cancelled: ['fee-aaa1:5'], waiting: ['fee-bbb1:3'] };
  for (const [state, keys] of Object.entries(cases)) {
    const f = M.buildFeed({ runs: w.runs, filter: { state } });
    assert.deepEqual(f.items.map(i => i.key).sort(), keys.slice().sort(), state);
    assert.deepEqual(f.counts, all.counts, `${state}: counts ignore the state filter`);
    assert.equal(f.filter.state, state);
  }
  assert.equal(M.buildFeed({ runs: w.runs, filter: { state: 'needsVerdict' } }).items.length, 2, 'the counts key spelling is accepted');
  assert.equal(M.buildFeed({ runs: w.runs, filter: { state: 'bogus' } }).items.length, 8, 'an unknown state is no filter');
  const both = M.buildFeed({ runs: w.runs, filter: { task: 'Borealis', state: 'running' } });
  assert.deepEqual(both.items.map(i => i.key), ['fee-bbb1:2', 'fee-bbb1:3']);
  assert.deepEqual(both.groups.map(g => g.roundId), ['fee-bbb1'], 'a round with no matching pilot has no header');
  assert.equal(M.buildFeed({ runs: w.runs, filter: { task: 'Borealis' } }).filter.task, M.taskKey({ task: 'Borealis' }));
  for (const f of [null, undefined, 'x', 5, []]) assert.equal(M.buildFeed({ runs: w.runs, filter: f }).items.length, 8);
});

test('feed: a legacy pilot with no task field takes the lineage name when the rounds are supplied', () => {
  const w = idleWorld();
  const f = M.buildFeed({ runs: w.runs, rounds: w.rounds });
  const names = Object.fromEntries(f.items.map(i => [i.roundId, i.taskName]));
  assert.equal(names['cob-r2'], 'Cobalt');
  assert.equal(names['cob-r1'], 'Cobalt');
  assert.equal(names['atlas-r2'], 'Atlas');
  assert.equal(names['una-r1'], 'Unassigned');
  assert.equal(f.items.find(i => i.roundId === 'una-r1').unassigned, true);
  const cobalt = M.buildFeed({ runs: w.runs, rounds: w.rounds, filter: { task: M.taskKey({ task: 'Cobalt' }) } });
  assert.deepEqual([...new Set(cobalt.items.map(i => i.roundId))].sort(), ['cob-r1', 'cob-r2']);
  /* the board and the feed agree on every key */
  const board = M.buildBoard(w);
  const keys = new Set(board.tasks.map(t => t.key));
  for (const i of f.items) assert.ok(keys.has(i.taskKey), i.taskKey);
  assert.equal(M.buildFeed({ runs: w.runs }).items.find(i => i.roundId === 'cob-r2').taskName, 'Unassigned', 'without the rounds only the task field counts');
});

test('feed: an update never moves a row; a new round goes on top and leaves the others where they were', () => {
  const t0 = [pilot('fee-hhh1', 1, { state: 'running', endedAt: null, arrivedAt: iso(5, 10, 0), audit: null }), pilot('fee-hhh1', 2, { state: 'running', endedAt: null, arrivedAt: iso(5, 10, 0), audit: null }), pilot('fee-hhh1', 3, { state: 'queued', startedAt: null, endedAt: null, arrivedAt: iso(5, 9, 59), audit: null }), pilot('fee-hhh0', 1, { arrivedAt: iso(4, 9) }), pilot('fee-hhh0', 2, { arrivedAt: iso(4, 9, 5) })];
  const keys = rows => M.buildFeed({ runs: rows, now: NOW }).items.map(i => i.key);
  const base = keys(t0);
  assert.deepEqual(base, ['fee-hhh1:1', 'fee-hhh1:2', 'fee-hhh1:3', 'fee-hhh0:1', 'fee-hhh0:2']);
  /* pilot 2 finishes first and arrives later than pilot 1's start: the server's newest-first order changes, the model does not */
  const t1 = t0.map(r => r.n === 2 && r.roundId === 'fee-hhh1' ? pilot('fee-hhh1', 2, { arrivedAt: iso(5, 10, 6), endedAt: iso(5, 10, 6) }) : r);
  assert.deepEqual(keys(t1), base);
  /* pilot 3 starts, pilot 1 fails, pilot 2 gets a verdict, an old round's pilot is classified later */
  const t2 = [pilot('fee-hhh1', 1, { state: 'failed', failureReason: 'timeout', arrivedAt: iso(5, 10, 20), endedAt: iso(5, 10, 20), audit: null }), pilot('fee-hhh1', 2, { arrivedAt: iso(5, 10, 6), endedAt: iso(5, 10, 6), classification: verdict('unclear') }), running('fee-hhh1', 3, { arrivedAt: iso(5, 10, 7) }), pilot('fee-hhh0', 1, { arrivedAt: iso(4, 9), classification: verdict('fingerprint') }), pilot('fee-hhh0', 2, { arrivedAt: iso(4, 9, 5) })];
  assert.deepEqual(keys(t2), base);
  /* every permutation of the same rows gives the same order */
  for (const rows of [t0, t1, t2]) {
    const want = keys(rows);
    for (let k = 0; k < 6; k++) { const shuffled = rows.slice().sort((a, b) => ((a.n * 7 + k * 13 + a.roundId.length) % 5) - ((b.n * 7 + k * 13 + b.roundId.length) % 5) || a.n - b.n); assert.deepEqual(keys(shuffled.reverse()), want); }
  }
  /* a brand new round appears first, the rest keep their order */
  const arrival = pilot('fee-hhh2', 1, { arrivedAt: iso(6, 8), startedAt: iso(6, 8), state: 'running', endedAt: null, audit: null });
  assert.deepEqual(keys([...t2, arrival]), ['fee-hhh2:1', ...base]);
  /* rows with no timestamps still order the same way every time */
  const bare = [pilot('fee-iii1', 2, { arrivedAt: null, startedAt: null, endedAt: null }), pilot('fee-iii1', 1, { arrivedAt: null, startedAt: null, endedAt: null }), pilot('fee-iii0', 1, { arrivedAt: null, startedAt: null, endedAt: null })];
  assert.deepEqual(keys(bare), ['fee-iii1:1', 'fee-iii1:2', 'fee-iii0:1']);
  assert.deepEqual(keys(bare.slice().reverse()), keys(bare));
});

test('feed: duplicates keep the later arrival, malformed rows are skipped and counted', () => {
  const rows = [pilot('fee-jjj1', 1, { state: 'running', endedAt: null, arrivedAt: iso(5, 10, 0), audit: null }), pilot('fee-jjj1', 1, { arrivedAt: iso(5, 10, 9) }), null, undefined, 'x', 5, [], {}, { roundId: 'fee-jjj1' }, { n: 2 }, { roundId: 'fee-jjj1', n: 0 }, { roundId: 'fee-jjj1', n: 1.5 }, { roundId: 'fee-jjj1', n: '2' }, { roundId: '', n: 2 }];
  const feed = M.buildFeed({ runs: rows });
  assert.deepEqual(feed.items.map(i => [i.key, i.state]), [['fee-jjj1:1', 'completed']]);
  assert.equal(feed.skipped, rows.length - 1);
  assert.deepEqual(M.buildFeed({ runs: [rows[1], rows[0]] }).items.map(i => i.state), ['completed'], 'whichever order they arrive in');
  for (const bad of [undefined, null, 'x', 5, {}, []]) { const f = M.buildFeed({ runs: bad }); assert.deepEqual(f.items, []); assert.equal(f.counts.all, 0); }
  for (const bad of [undefined, null, 'x', 5, []]) assert.deepEqual(M.buildFeed(bad).items, []);
});

/* ---------- failure and ending reasons ---------- */
test('describeFailure: a plain sentence for every failure reason the backend can produce', () => {
  const table = {
    'exit-code': 'The program exited with code 1.',
    timeout: 'The pilot ran out of time (50 minutes) and was stopped.',
    'no-result': 'The program ended without sending a final result.',
    'error-result': 'The runtime reported an error as its result.',
    budget: 'The pilot reached its spending cap and the runtime stopped it before it finished.',
    'empty-result': 'The program finished with an empty result.',
    'spawn-error': 'The program could not be started.',
    'setup-error': 'The pilot folder could not be built, so nothing was started.',
    signal: 'The program was stopped by a signal.',
    'no-exit-code': 'The program ended without an exit code.',
    interrupted: 'The companion stopped while this pilot was running.'
  };
  /* the backend codes, read from the source so a new code cannot slip past this table */
  const backend = fs.readFileSync(path.join(__dirname, '..', 'backend', 'agents', 'claude-runner.cjs'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'backend', 'agents', 'rounds.cjs'), 'utf8');
  const codes = new Set([...backend.matchAll(/failureReason\s*=\s*'([a-z-]+)'/g)].map(m => m[1]));
  for (const m of backend.matchAll(/failureReason\s*=\s*[^;]*?\?\s*'([a-z-]+)'\s*:\s*[^;]*?\?\s*'([a-z-]+)'\s*:\s*'([a-z-]+)'/g)) { codes.add(m[1]); codes.add(m[2]); codes.add(m[3]); }
  codes.delete('cancelled');
  for (const code of codes) assert.ok(Object.prototype.hasOwnProperty.call(table, code), `the backend raises ${code}: add a sentence`);
  for (const [code, sentence] of Object.entries(table)) {
    const d = M.describeFailure({ state: 'failed', failureReason: code, exitCode: code === 'exit-code' ? 1 : null });
    assert.deepEqual([d.kind, d.code, d.text, d.withheld], ['failed', code, sentence, false], code);
    const item = M.buildFeed({ runs: [failed('fee-kkk1', 1, code, { exitCode: code === 'exit-code' ? 1 : null })] }).items[0];
    assert.equal(item.happened + '.', sentence, `${code} in the feed`);
    assert.equal(item.stateWord, 'FAILED');
  }
});

test('describeFailure: exit code unknown, spending cap with the cap, cancelled before or after start, unknown and missing codes', () => {
  assert.equal(M.describeFailure({ state: 'failed', failureReason: 'exit-code' }).text, 'The program exited with code (unknown).');
  assert.equal(M.describeFailure({ state: 'failed', failureReason: 'exit-code', exitCode: 137 }).text, 'The program exited with code 137.');
  assert.equal(M.describeFailure({ state: 'failed', failureReason: 'budget', maxBudgetUsd: 3 }).text, 'The pilot reached its spending cap (USD 3.00) and the runtime stopped it before it finished.');
  assert.equal(M.describeFailure({ state: 'failed', failureReason: 'budget', maxBudgetUsd: 0.075 }).text.includes('USD 0.08') || M.describeFailure({ state: 'failed', failureReason: 'budget', maxBudgetUsd: 0.075 }).text.includes('USD 0.07'), true);
  assert.equal(M.describeFailure({ state: 'cancelled', failureReason: 'cancelled', startedAt: iso(1) }).text, 'Cancelled before it finished.');
  assert.equal(M.describeFailure({ state: 'cancelled', failureReason: 'cancelled', startedAt: null }).text, 'Cancelled before it started.');
  assert.equal(M.describeFailure({ state: 'cancelled' }).kind, 'cancelled');
  assert.equal(M.describeFailure({ state: 'failed', failureReason: 'cancelled' }).kind, 'cancelled');
  assert.equal(M.describeFailure({ state: 'failed' }).text, 'It did not finish. The companion recorded no reason.');
  assert.equal(M.describeFailure({ state: 'failed', failureReason: 'brand-new-reason' }).text, 'It did not finish, for a reason this page does not recognise.');
  assert.equal(M.describeFailure({ state: 'failed', failureReason: 'constructor' }).text, 'It did not finish, for a reason this page does not recognise.', 'prototype names are not reasons');
  assert.equal(M.describeFailure({ state: 'failed', failureReason: '__proto__' }).kind, 'failed');
  for (const state of ['completed', 'running', 'queued']) assert.equal(M.describeFailure({ state, failureReason: null }).kind, 'none', state);
  assert.equal(M.describeFailure({ state: 'completed', failureReason: 'stray' }).kind, 'none', 'a pilot that completed did not fail');
  for (const bad of [null, undefined, 'x', 5, [], {}]) assert.equal(M.describeFailure(bad).kind, 'none');
  assert.equal(M.describeFailure({ state: 'failed', failureReason: 'budget', maxBudgetUsd: -1 }).text.includes('USD'), false);
});

test('describeFailure: every ending reason the runtime documents has words, and an unknown one never reaches the page', () => {
  const known = { max_turns: 'it reached the turn limit', budget_exhausted: 'it reached its spending cap', aborted_streaming: 'its response was cut off while streaming', aborted_tools: 'its tool calls were stopped', prompt_too_long: 'the conversation grew too long for the model', blocking_limit: 'a usage limit blocked it', model_error: 'the model reported an error', image_error: 'an image could not be read', hook_stopped: 'a hook stopped it', stop_hook_prevented: 'a stop hook prevented it from ending', tool_deferred: 'a tool call was deferred', rapid_refill_breaker: 'it kept refilling its context too quickly' };
  for (const [code, clause] of Object.entries(known)) {
    assert.equal(M.describeFailure({ state: 'failed', failureReason: 'error-result', terminalReason: code }).terminalText, clause, code);
    const item = M.buildFeed({ runs: [failed('fee-lll1', 1, 'error-result', { terminalReason: code })] }).items[0];
    assert.equal(item.happened, `The runtime reported an error as its result. The runtime said it ended because ${clause}`, code);
    /* a pilot that completed but reports another ending says so */
    const ok = M.buildFeed({ runs: [pilot('fee-lll2', 1, { terminalReason: code })] }).items[0];
    assert.equal(ok.happened, `Completed in 4m 12s, 31 tool calls, audit CLEAN, ended because ${clause}`, code);
  }
  assert.equal(M.describeFailure({ state: 'failed', failureReason: 'error-result', terminalReason: 'completed' }).terminalText, '');
  assert.equal(M.describeFailure({ state: 'failed', failureReason: 'error-result', terminalReason: null }).terminalText, '');
  assert.equal(M.describeFailure({ state: 'failed', failureReason: 'error-result', terminalReason: 'weird% caught' }).terminalText, 'of a reason this page does not recognise');
  const spent = M.buildFeed({ runs: [failed('fee-lll3', 1, 'budget', { terminalReason: 'budget_exhausted' })] }).items[0];
  assert.equal(spent.happened, 'The pilot reached its spending cap and the runtime stopped it before it finished', 'the cap is said once');
});

/* ---------- redaction ---------- */
test('redacted feed rows keep state, tool calls, audit status, characters and verdict names, and say what is withheld', () => {
  const runs = [pilot('fee-mmm1', 1, { redacted: true, classification: verdict('fingerprint') }), failed('fee-mmm1', 2, 'budget', { redacted: true }), pilot('fee-mmm1', 3, { redacted: true, audit: BAD }), running('fee-mmm1', 4, { redacted: true }), queued('fee-mmm1', 5, { redacted: true }), pilot('fee-mmm1', 6, { redacted: true, state: 'cancelled', failureReason: 'cancelled' }), pilot('fee-mmm1', 7)];
  const items = M.buildFeed({ runs, now: NOW }).items;
  const W = 'Details withheld while a round runs';
  assert.equal(items[0].happened, `Completed, 31 tool calls, audit CLEAN. ${W}`);
  assert.equal(items[1].happened, `Failed, 31 tool calls. ${W}`);
  assert.equal(items[2].happened, `Discarded by the audit, 31 tool calls. ${W}`);
  assert.equal(items[3].happened, `Running, 4 tool calls so far. ${W}`);
  assert.equal(items[4].happened, `Waiting to start. ${W}`);
  assert.equal(items[5].happened, `Cancelled, 31 tool calls. ${W}`);
  assert.equal(items[6].happened, 'Completed in 4m 12s, 31 tool calls, audit CLEAN', 'only redacted rows are cut down');
  assert.deepEqual(items.map(i => i.redacted), [true, true, true, true, true, true, false]);
  assert.equal(items[0].verdict.label, 'Lands on a frozen fingerprint', 'verdict names are kept');
  assert.equal(items[0].output.chars, 1240);
  assert.equal(items[0].audit.status, 'CLEAN');
  assert.ok(!/spending|cap|exited|code|violation|minute|\d+m \d\ds/.test(items.slice(0, 6).map(i => i.happened).join(' ')), 'no reason, no code, no duration, no violation count');
  /* the response level flag redacts every row */
  const all = M.buildFeed({ runs: [pilot('fee-mmm2', 1), failed('fee-mmm2', 2, 'timeout')], redacted: true }).items;
  assert.ok(all.every(i => i.redacted && i.happened.endsWith(W)));
  assert.equal(all[1].happened, `Failed, 31 tool calls. ${W}`);
});

test('describeFailure on a redacted row says only that the details are withheld', () => {
  for (const [state, code] of [['failed', 'budget'], ['failed', 'exit-code'], ['failed', 'zzz'], ['cancelled', 'cancelled'], ['failed', null]]) {
    const d = M.describeFailure({ state, failureReason: code, exitCode: 9, terminalReason: 'max_turns', redacted: true });
    assert.deepEqual(d, { kind: state === 'cancelled' ? 'cancelled' : 'failed', code: null, text: 'Details withheld while a round runs.', terminalText: '', withheld: true });
  }
  assert.equal(M.describeFailure({ state: 'completed', redacted: true }).kind, 'none');
});

/* ---------- offline and empty ---------- */
test('empty input gives no tasks and the status empty, for every kind of nothing', () => {
  for (const input of [undefined, null, {}, { rounds: [], runs: [], evals: [] }, { rounds: null }, 'x', 5, [], { rounds: [null, 5, 'x', {}, { id: '' }, { id: 5 }] }]) {
    const b = M.buildBoard(input);
    assert.deepEqual(b.tasks, [], JSON.stringify(input));
    assert.equal(b.status, 'empty');
    assert.equal(b.redacted, false);
    assert.deepEqual(b.counts, { tasks: 0, running: 0, waiting: 0, needsVerdict: 0, tasksRunning: 0, tasksNeedingVerdict: 0 });
    assert.equal(b.primaryTaskKey, null);
    assert.match(b.message, /^No task has a round yet\./);
  }
});

test('offline: Active agents is not available (never 0), the pinned message is given, nothing is computed from a missing link', () => {
  const board = M.buildBoard({ ...idleWorld(), offline: true });
  assert.equal(board.status, 'offline');
  assert.equal(board.message, 'Local agents need the companion: run npm start.');
  assert.equal(board.stale, true);
  assert.equal(board.counts.running, null);
  assert.equal(board.counts.waiting, null);
  assert.equal(board.counts.tasksRunning, null);
  for (const t of board.tasks) assert.deepEqual(t.active, { running: null, waiting: null, total: null, available: false, elapsedMs: null }, t.name);
  const none = M.buildBoard({ offline: true });
  assert.equal(none.status, 'offline');
  assert.equal(none.stale, false);
  assert.deepEqual(none.tasks, []);
  assert.equal(none.message, M.OFFLINE_MESSAGE);
});

test('orphan pilot rows (their round is not in the list) are counted, never shown on a card', () => {
  const w = made('orp-aaa1', { task: 'Atlas' }, [done()]);
  const board = M.buildBoard({ rounds: [], runs: w.runs });
  assert.equal(board.orphanRuns, 1);
  assert.deepEqual(board.tasks, []);
  const mixed = M.buildBoard({ rounds: [w.round], runs: [...w.runs, pilot('gone-1', 1)] });
  assert.equal(mixed.orphanRuns, 1);
  assert.equal(mixed.tasks.length, 1);
});

/* ---------- purity, determinism, order independence ---------- */
test('purity: deep-frozen inputs are accepted and never mutated, outputs never alias inputs', () => {
  const w = runningWorld();
  const evals = [{ id: 'e1', task: 'Atlas', runId: 'run-1', score: '7', scoreMax: '10', importedAt: iso(3), judge: { provider: 'qa', model: 'browser-test-fixture' } }];
  const input = deepFreeze({ ...clone(w), evals: clone(evals), now: NOW, filter: { task: 'Atlas' } });
  const snapshot = clone(input);
  const board = M.buildBoard(input);
  const feed = M.buildFeed({ runs: input.runs, rounds: input.rounds, filter: input.filter, now: NOW, redacted: true });
  for (const t of board.tasks) { M.scoreRows(t); M.nextAction(input.rounds[0], { runs: input.runs }); }
  M.describeFailure(input.runs[0]);
  M.pickEvaluations(input.evals);
  M.taskKey(input.rounds[0], input.rounds);
  assert.deepEqual(clone(input), snapshot);
  /* scribbling over the output must not reach the input */
  const target = board.tasks[0];
  target.name = 'changed'; target.nextAction.target.roundId = 'changed'; target.version.label = 'changed';
  if (target.evaluation) target.evaluation.judge = null;
  feed.items.forEach(i => { i.output.relPath = 'changed'; if (i.audit) i.audit.status = 'changed'; });
  assert.deepEqual(clone(input), snapshot);
  const again = M.buildBoard(input);
  assert.notEqual(again.tasks[0].name, 'changed');
});

test('determinism: the same input gives deep-equal output, and the order of the arrays does not matter', () => {
  const evals = [{ id: 'e1', task: 'Atlas', runId: 'a', score: 1, scoreMax: 2, importedAt: iso(3) }, { id: 'e2', task: 'Meridian', runId: 'b', score: 2, scoreMax: 2, importedAt: iso(4), packetSha256: sha('a') }, { id: 'e3', task: 'Cobalt', runId: 'c', score: 0, scoreMax: 2, importedAt: iso(4) }];
  for (const w of [idleWorld(), runningWorld()]) {
    const input = { ...w, evals, now: NOW };
    const one = M.buildBoard(input), two = M.buildBoard(clone(input));
    assert.deepEqual(one, two);
    assert.equal(JSON.stringify(one), JSON.stringify(two));
    const reversed = M.buildBoard({ ...input, rounds: input.rounds.slice().reverse(), runs: input.runs.slice().reverse(), evals: evals.slice().reverse() });
    assert.deepEqual(reversed, one, 'array order is not part of the answer');
    const rotated = M.buildBoard({ ...input, rounds: input.rounds.slice(3).concat(input.rounds.slice(0, 3)), runs: input.runs.slice(5).concat(input.runs.slice(0, 5)) });
    assert.deepEqual(rotated, one);
    const f1 = M.buildFeed({ runs: w.runs, rounds: w.rounds, now: NOW }), f2 = M.buildFeed({ runs: w.runs.slice().reverse(), rounds: w.rounds.slice().reverse(), now: NOW });
    assert.deepEqual(f1, f2);
  }
});

/* ---------- honesty sweep ---------- */
const FORBIDDEN = /%|pass rate|success rate|failure rate|difficulty|caught/i;
const FORBIDDEN_WORDS = /\b(works|fails|hard|ready|done)\b/i;
test('no string the model emits contains a percentage, a rate, a difficulty or a forbidden claim', () => {
  const evals = [{ id: 'e1', task: 'Atlas', runId: 'run-1', score: 7, scoreMax: 10, importedAt: iso(3), sourceName: 'Facility_Terms.txt', packetSha256: sha('a'), judge: { provider: 'qa', model: 'browser-test-fixture' } }, { task: 'Meridian', runId: 'r', score: 2, scoreMax: 3, importedAt: iso(3) }];
  const emitted = [];
  for (const w of [idleWorld(), runningWorld(), { ...idleWorld(), offline: true }, {}, { offline: true }]) {
    const board = M.buildBoard({ ...w, evals, now: NOW });
    emitted.push(...strings(board));
    for (const t of board.tasks) emitted.push(...strings(M.scoreRows(t)));
    const feed = M.buildFeed({ runs: w.runs || [], rounds: w.rounds, now: NOW, redacted: w.redacted });
    emitted.push(...strings(feed.items.map(({ taskName, taskKey, roundLabel, roundName, what, runId, key, roundId, model, ...rest }) => rest)), ...strings(feed.counts));
  }
  /* every failure reason, every ending reason, nonsense reasons that carry forbidden words, every state, redacted or not */
  const reasons = ['exit-code', 'timeout', 'no-result', 'error-result', 'budget', 'empty-result', 'spawn-error', 'setup-error', 'signal', 'no-exit-code', 'interrupted', 'cancelled', null, 'weird% rate', 'difficulty', 'caught', 'pass rate'];
  const endings = [null, 'completed', 'max_turns', 'budget_exhausted', 'aborted_streaming', 'aborted_tools', 'prompt_too_long', 'blocking_limit', 'model_error', 'image_error', 'hook_stopped', 'stop_hook_prevented', 'tool_deferred', 'rapid_refill_breaker', 'caught 50%', 'success rate', 'difficulty'];
  const rows = [];
  let n = 0;
  for (const state of ['queued', 'running', 'completed', 'failed', 'cancelled', 'mystery']) for (const reason of reasons) for (const terminalReason of endings) for (const audit of [null, CLEAN, BAD]) for (const redacted of [false, true]) {
    n++;
    rows.push(pilot('swp-aaa' + (n % 7), (n % 5) + 1, { state, failureReason: reason, terminalReason, audit, redacted, exitCode: 2 }));
  }
  for (const r of rows) { emitted.push(...strings(M.describeFailure(r))); }
  const feed = M.buildFeed({ runs: rows, now: NOW });
  emitted.push(...strings(feed.items.map(({ taskName, taskKey, roundLabel, roundName, what, runId, key, roundId, model, ...rest }) => rest)));
  for (const status of ['draft', 'frozen', 'approved', 'running', 'finished', 'cancelled', 'failed', 'weird']) for (const anyRunning of [false, true]) {
    for (const specs of [[], [done()], [gold()], [fail('timeout')], [live(), waiting()]]) {
      const w = made('swp-bbb1', { task: 'Atlas', status }, specs);
      const a = M.nextAction(w.round, { runs: w.runs, anyRunning });
      emitted.push(...strings(a));
    }
  }
  assert.ok(emitted.length > 500, 'the sweep covered a lot of text');
  const hits = emitted.filter(s => FORBIDDEN.test(s) || FORBIDDEN_WORDS.test(s));
  assert.deepEqual([...new Set(hits)], []);
  assert.ok(emitted.every(s => typeof s === 'string'));
});

test('the pinned wording survives: directional line without a rate, no simulated-grader row, the offline line verbatim', () => {
  const rows = M.scoreRows(byName(M.buildBoard(idleWorld()), 'Atlas'));
  assert.ok(rows[0].text.includes('Directional only, n = 3.'));
  assert.ok(!rows[0].text.includes('No rate or difficulty is computed'), 'the long server line is the view job; the model never writes a word about difficulty');
  assert.equal(M.OFFLINE_MESSAGE, 'Local agents need the companion: run npm start.');
  assert.equal(M.WITHHELD, 'Details withheld while a round runs');
  assert.equal(M.EMPTY_SCORE, 'No score recorded. Pilots and the simulated grader are not scored.');
});

test('an arithmetic check: nothing in a card is a ratio of two counts', () => {
  const board = M.buildBoard({ ...idleWorld(), now: NOW });
  const walk = (v, p = '') => { if (typeof v === 'number') { assert.ok(Number.isInteger(v) || /elapsedMs|score/i.test(p), `${p} = ${v} should be a whole number`); } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`); };
  walk(board);
  const feed = M.buildFeed({ runs: idleWorld().runs, now: NOW });
  walk(feed.counts, 'counts');
  for (const i of feed.items) for (const k of ['durationMs', 'turns', 'toolCalls']) assert.ok(i[k] === null || Number.isInteger(i[k]), k);
});

/* ---------- size ---------- */
test('large input: 200 rounds of 5 pilots build a board and a feed quickly and correctly', () => {
  const rounds = [], runs = [];
  const specs = [gold(), fp(), done(), fail('timeout'), discarded()];
  for (let i = 0; i < 200; i++) {
    const id = `big-${String(i).padStart(4, '0')}`;
    const task = ['Atlas', 'Meridian', 'Borealis', '', ''][i % 5];
    const w = made(id, { label: i < 5 ? ['Atlas', 'Meridian', 'Borealis', 'Cobalt', 'Pilot round'][i] : `Round ${i}`, task, createdAt: new Date(Date.parse(iso(1)) + i * 3600e3).toISOString(), carriedFrom: i >= 5 ? `big-${String(i - 5).padStart(4, '0')}` : null, carriedDepth: Math.floor(i / 5), packetSha256: sha('abcdef'[i % 6]), lastActivityAt: new Date(Date.parse(iso(1)) + i * 3600e3 + 1800e3).toISOString() }, specs);
    rounds.push(w.round);
    for (const r of w.runs) runs.push({ ...r, arrivedAt: new Date(Date.parse(iso(1)) + i * 3600e3 + r.n * 60e3).toISOString() });
  }
  assert.equal(runs.length, 1000);
  const t0 = process.hrtime.bigint();
  const board = M.buildBoard({ rounds, runs, now: NOW });
  const feed = M.buildFeed({ runs, rounds, now: NOW });
  const filtered = M.buildFeed({ runs, rounds, filter: { task: 'Atlas', state: 'needs-verdict' }, now: NOW });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
  assert.equal(board.tasks.length, 5);
  assert.deepEqual(board.tasks.map(t => t.name), ['Atlas', 'Meridian', 'Borealis', 'Cobalt', 'Unassigned']);
  assert.equal(byName(board, 'Atlas').roundIds.length, 40);
  assert.equal(byName(board, 'Atlas').version.number, 40);
  assert.equal(byName(board, 'Cobalt').roundIds.length, 40, 'a legacy lineage found its root label through 40 carries');
  assert.equal(board.counts.needsVerdict, 200);
  assert.equal(feed.items.length, 1000);
  assert.equal(feed.groups.length, 200);
  assert.equal(feed.groups[0].roundId, 'big-0199');
  assert.equal(feed.counts.all, 1000);
  assert.equal(filtered.items.length, 40);
  assert.deepEqual(board.incomplete, []);
});

test('large lineage: a 3000 deep chain, a long cycle and a wide fan do not hang or recurse', () => {
  const depth = 3000;
  const chain = [];
  for (let i = 0; i < depth; i++) chain.push({ id: `chn-${String(i).padStart(5, '0')}`, label: i === 0 ? 'Atlas root' : 'child', carriedFrom: i === 0 ? null : `chn-${String(i - 1).padStart(5, '0')}`, createdAt: new Date(Date.parse(iso(1)) + i * 1000).toISOString() });
  const t0 = process.hrtime.bigint();
  const board = M.buildBoard({ rounds: chain });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 8000, `took ${ms.toFixed(0)} ms`);
  assert.equal(board.tasks.length, 1);
  assert.equal(board.tasks[0].name, 'Atlas root');
  assert.equal(board.tasks[0].version.number, depth);
  const ring = chain.map((r, i) => ({ ...r, carriedFrom: chain[(i + depth - 1) % depth].id }));
  const ringBoard = M.buildBoard({ rounds: ring });
  assert.equal(ringBoard.tasks[0].name, 'Unassigned');
  assert.equal(ringBoard.tasks[0].roundIds.length, depth);
});

/* ---------- second pass: cases found by attacking the first version ---------- */
test('nextAction counts only the pilots of its own round, whatever rows it is handed', () => {
  const mine = made('own-aaa1', { task: 'Atlas' }, [gold()]);
  const other = made('own-bbb1', { task: 'Atlas' }, [done(), done(), live()]);
  const a = M.nextAction(mine.round, { runs: [...mine.runs, ...other.runs] });
  assert.equal(a.id, 'export', 'the other round has unclassified and running pilots; this one has neither');
  assert.equal(a.target.roundId, 'own-aaa1');
});

test('nextAction: a round id that is not a string never reaches a target', () => {
  for (const id of [undefined, null, 5, {}, []]) {
    const a = M.nextAction({ id, status: 'draft' });
    assert.equal(a.id, 'freeze');
    assert.equal(a.target.roundId, null);
    assert.equal(a.roundId, null);
  }
  assert.equal(M.buildBoard({ rounds: [{ id: 5, status: 'draft', task: 'Atlas' }, { id: '', status: 'draft', task: 'Atlas' }] }).tasks.length, 0, 'rows without a string id are not rounds');
});

test('a redacted round view means a round runs, so its own next step waits like the others', () => {
  const w = made('red-aaa1', { task: 'Atlas' }, [done()]);
  const a = M.nextAction({ ...w.round, redacted: true }, { runs: w.runs });
  assert.equal(a.id, 'classify');
  assert.equal(a.blocked, true);
});

test('a score that would print with an exponent is not a score; ordinary decimals are kept as written', () => {
  const picks = score => M.pickEvaluations([{ task: 'Atlas', runId: 'r', score, scoreMax: 10, importedAt: iso(2) }]).size;
  for (const s of [1e21, 1e-7, 1.5e-9, 2e30, -1e21]) assert.equal(picks(s), 0, String(s));
  for (const s of [1000, 0.5, 12345.678, 1e15, 100000000000000]) assert.equal(picks(s), 1, String(s));
  assert.equal(M.pickEvaluations([{ task: 'Atlas', score: 5, scoreMax: 1e30, importedAt: iso(2) }]).get(M.taskKey({ task: 'Atlas' })).scoreMaxText, null, 'a maximum that is not usable is left out, not invented');
});

test('feed task filter: an exact key beats a name that looks like a key', () => {
  const runs = [pilot('flt-aaa1', 1, { task: 'foo' }), pilot('flt-bbb1', 1, { task: 'task:foo' }), pilot('flt-ccc1', 1, { task: '' })];
  const ids = f => M.buildFeed({ runs, filter: { task: f } }).items.map(i => i.roundId);
  assert.deepEqual(ids('task:foo'), ['flt-aaa1'], 'the key of the task named foo');
  assert.deepEqual(ids('Task:Foo'), ['flt-bbb1'], 'not a key, so a name: the task named task:foo');
  assert.deepEqual(ids('unassigned'), ['flt-ccc1']);
  assert.deepEqual(ids('FOO'), ['flt-aaa1']);
  assert.equal(ids('').length, 3, 'an empty filter is no filter');
});

test('offline: nobody holds the yellow primary and the card order is untouched', () => {
  const w = idleWorld();
  const online = M.buildBoard(w), off = M.buildBoard({ ...w, offline: true });
  assert.equal(off.primaryTaskKey, null);
  assert.ok(off.tasks.every(t => t.nextAction.primaryEligible === false));
  assert.deepEqual(off.tasks.map(t => t.key), online.tasks.map(t => t.key));
});

test('now may be an epoch number or an ISO string, and nothing else', () => {
  const r = running('now-aaa1', 1, { startedAt: iso(5, 10) });
  const at = now => M.buildFeed({ runs: [r], now }).items[0].durationMs;
  assert.equal(at(Date.parse(iso(5, 10, 3))), 180000);
  assert.equal(at(iso(5, 10, 3)), 180000);
  for (const bad of [undefined, null, NaN, Infinity, '', 'soon', {}, [], true]) assert.equal(at(bad), null, String(bad));
  assert.equal(M.buildBoard({ now: Date.parse(NOW) }).asOf, NOW);
  assert.equal(M.buildBoard({ now: 'nope' }).asOf, null);
});

test('cards do not move or rename when the same tasks go from idle to running', () => {
  const idle = M.buildBoard(idleWorld()), live = M.buildBoard(runningWorld());
  const common = t => idle.tasks.map(x => x.name).filter(n => live.tasks.some(y => y.name === n));
  assert.deepEqual(live.tasks.map(t => t.name).filter(n => common().includes(n)), common());
  assert.deepEqual(live.tasks.map(t => t.name), ['Atlas', 'Meridian', 'Cobalt', 'Borealis', 'Unassigned']);
});

test('an imported result recorded against the root label of a legacy lineage lands on that lineage card', () => {
  const w = idleWorld();
  const board = M.buildBoard({ ...w, evals: [{ task: 'cobalt', runId: 'run-9', score: 4, scoreMax: 5, importedAt: iso(3), packetSha256: sha('e') }] });
  assert.equal(board.tasks.length, 5, 'no extra card');
  assert.equal(byName(board, 'Cobalt').evaluation.runId, 'run-9');
  assert.equal(byName(board, 'Cobalt').evaluation.versionNote, '', 'the packet is the one the latest round carries');
  assert.equal(byName(board, 'Atlas').evaluation, null);
});

test('a record without a task joins the unassigned card; one task spelled two ways is one card', () => {
  const w = idleWorld();
  const board = M.buildBoard({ ...w, evals: [{ runId: 'run-u', score: 1, scoreMax: 2, importedAt: iso(3) }] });
  assert.equal(byName(board, 'Unassigned').evaluation.runId, 'run-u');
  const lone = M.buildBoard({ evals: [{ task: 'Atlas', runId: 'a', score: 1, importedAt: iso(2) }, { task: 'ATLAS ', runId: 'b', score: 2, importedAt: iso(3) }] });
  assert.equal(lone.tasks.length, 1);
  assert.equal(lone.tasks[0].evaluation.runId, 'b');
});

test('every pilot count on a card is a whole number that adds up', () => {
  for (const w of [idleWorld(), runningWorld()]) {
    for (const t of M.buildBoard(w).tasks) {
      const p = t.pilots;
      if (!p || !p.complete) continue;
      assert.equal(p.matchedGold + p.fingerprint + p.unclear + p.unclassified, p.n, t.name);
      for (const k of ['n', 'matchedGold', 'fingerprint', 'unclear', 'unclassified', 'discarded', 'failed', 'cancelled', 'active', 'total']) assert.ok(Number.isInteger(p[k]) && p[k] >= 0, `${t.name}.${k}`);
      assert.ok(p.n + p.discarded + p.failed + p.cancelled + p.active <= p.total, `${t.name}: nothing is counted twice`);
    }
  }
});

test('a task whose newest round runs shows the running round, not an older round that waits to be classified', () => {
  const old = made('liv-aaa1', { task: 'Atlas', label: 'Atlas round 1', createdAt: iso(1) }, [done(), gold()]);
  const run = made('liv-aaa2', { task: 'Atlas', label: 'Atlas round 2', createdAt: iso(2), status: 'running', carriedFrom: 'liv-aaa1', carriedDepth: 1 }, [done(), live(), waiting()]);
  const t = byName(M.buildBoard(combine(old, run)), 'Atlas');
  assert.equal(t.nextAction.id, 'watch');
  assert.equal(t.nextAction.blocked, false);
  assert.equal(t.nextAction.roundId, 'liv-aaa2');
  assert.equal(t.nextAction.label, '1 of 3 pilots finished', 'a waiting pilot is not a finished one');
  assert.equal(t.status, 'running');
  assert.equal(t.needsVerdict, 2, 'the old pilots are still counted as waiting for a verdict');
  /* and the same when the running round is not the newest */
  const draft = made('liv-aaa3', { task: 'Atlas', label: 'Atlas round 3', createdAt: iso(3), status: 'draft', freezeSha256: null, freezeVersion: null }, []);
  assert.equal(byName(M.buildBoard(combine(old, run, draft)), 'Atlas').nextAction.id, 'watch');
});

test('feed: a round is placed by its earliest pilot arrival, so a pilot finishing late cannot lift an older round above a newer one', () => {
  /* the newer round has the greater id order the other way round, so a tie-break on the id cannot give the right answer by luck */
  const rows = [pilot('arr-bbb1', 1, { arrivedAt: iso(5, 10, 0) }), pilot('arr-bbb1', 2, { arrivedAt: iso(5, 10, 40) }), pilot('arr-aaa1', 1, { arrivedAt: iso(5, 10, 20) }), pilot('arr-aaa1', 2, { arrivedAt: iso(5, 10, 25) })];
  assert.deepEqual(M.buildFeed({ runs: rows }).groups.map(g => g.roundId), ['arr-aaa1', 'arr-bbb1']);
  const later = rows.map(r => r.roundId === 'arr-bbb1' && r.n === 2 ? { ...r, arrivedAt: iso(5, 11, 59) } : r);
  assert.deepEqual(M.buildFeed({ runs: later }).groups.map(g => g.roundId), ['arr-aaa1', 'arr-bbb1']);
});

test('a task is shown under the spelling of its newest round, whatever order the rounds arrive in', () => {
  const older = roundRow('nam-aaa1', { task: 'atlas', createdAt: iso(1), status: 'finished' }), newer = roundRow('nam-bbb1', { task: 'ATLAS', createdAt: iso(2), status: 'finished', carriedFrom: 'nam-aaa1', carriedDepth: 1 });
  for (const rounds of [[older, newer], [newer, older]]) {
    const board = M.buildBoard({ rounds });
    assert.equal(board.tasks.length, 1);
    assert.equal(board.tasks[0].name, 'ATLAS');
  }
});

test('pilot rows that are all present decide the active agents; the round counts are only the fallback', () => {
  const w = made('act-ccc1', { task: 'Atlas', status: 'running' }, [live(), waiting(), done()]);
  const stale = { ...w.round, counts: { ...w.round.counts, running: 0, queued: 0, completed: 3 } };
  const rows = byName(M.buildBoard({ rounds: [stale], runs: w.runs }), 'Atlas');
  assert.deepEqual([rows.active.running, rows.active.waiting], [1, 1], 'the fresh rows win over a stale round row');
  const fallback = byName(M.buildBoard({ rounds: [{ ...w.round, counts: { ...w.round.counts, running: 2, queued: 0 } }] }), 'Atlas');
  assert.deepEqual([fallback.active.running, fallback.active.waiting], [2, 0], 'with no rows the round counts are used');
  const partial = byName(M.buildBoard({ rounds: [{ ...w.round, counts: { ...w.round.counts, running: 2, queued: 0 } }], runs: w.runs.slice(0, 1) }), 'Atlas');
  assert.deepEqual([partial.active.running, partial.active.waiting], [2, 0], 'a partial list is not trusted either');
});

test('a round id listed twice is one round: the first row wins', () => {
  const first = roundRow('dup-aaa1', { task: 'Atlas', label: 'first', createdAt: iso(1) }), second = roundRow('dup-aaa1', { task: 'Meridian', label: 'second', createdAt: iso(2) });
  const board = M.buildBoard({ rounds: [first, second] });
  assert.deepEqual(board.tasks.map(t => [t.name, t.roundIds]), [['Atlas', ['dup-aaa1']]]);
});

test('a round row without runCount is sized by its state counts, so a missing pilot list is noticed', () => {
  const w = made('cnt-aaa1', { task: 'Atlas', status: 'running' }, [live(), live(), done()]);
  const { runCount, ...noCount } = w.round;
  const bare = byName(M.buildBoard({ rounds: [noCount] }), 'Atlas');
  assert.equal(bare.pilots.complete, false, 'three pilots by the counts, none loaded');
  assert.deepEqual([bare.active.running, bare.active.waiting], [2, 0], 'active agents still come from the counts');
  const full = byName(M.buildBoard({ rounds: [noCount], runs: w.runs }), 'Atlas');
  assert.equal(full.pilots.complete, true);
  const none = { ...noCount, counts: undefined };
  assert.equal(byName(M.buildBoard({ rounds: [none] }), 'Atlas').pilots, null, 'no count, no list, nothing to tally');
  const draft = made('cnt-aaa2', { task: 'Meridian', status: 'draft', freezeSha256: null, freezeVersion: null }, []);
  const { runCount: r2, ...draftNoCount } = draft.round;
  assert.equal(byName(M.buildBoard({ rounds: [draftNoCount] }), 'Meridian').incomplete, false, 'zero pilots by the counts is a complete list');
});

test('feed filters: a very long task name still filters by its key, and the state names ignore case and spelling', () => {
  const long = 'Atlas ' + 'x'.repeat(200);
  const runs = [pilot('lng-aaa1', 1, { task: long }), pilot('lng-bbb1', 1, { task: 'Meridian' })];
  const key = M.buildFeed({ runs }).items.find(i => i.roundId === 'lng-aaa1').taskKey;
  assert.ok(key.length > 120 && key.length <= 125, `key is ${key.length} characters`);
  assert.equal(M.buildFeed({ runs }).items.find(i => i.roundId === 'lng-aaa1').taskName.length, 120, 'names are capped at 120');
  assert.deepEqual(M.buildFeed({ runs, filter: { task: key } }).items.map(i => i.roundId), ['lng-aaa1']);
  const states = [pilot('stt-aaa1', 1), running('stt-aaa1', 2), pilot('stt-aaa1', 3, { classification: verdict('unclear') })];
  for (const spelling of ['Running', ' RUNNING ', 'running']) assert.deepEqual(M.buildFeed({ runs: states, filter: { state: spelling } }).items.map(i => i.n), [2], spelling);
  for (const spelling of ['needs-verdict', 'needsVerdict', 'NEEDS_VERDICT', 'Needs Verdict', 'needs verdict']) assert.deepEqual(M.buildFeed({ runs: states, filter: { state: spelling } }).items.map(i => i.n), [1], spelling);
});

test('scoreRows never prints undefined, whatever task it is handed', () => {
  const partial = M.scoreRows({ pilots: { roundId: 'xx-aaa1', complete: true } });
  assert.equal(partial[0].text, 'Latest local pilots (round xx-aaa1): the pilot list has not loaded yet. Open the round in Agents.');
  for (const task of [{ pilots: {} }, { pilots: { roundName: 'r', n: 1 } }, { pilots: { roundName: 'r', n: -1, matchedGold: 0, fingerprint: 0, unclear: 0, unclassified: 0, discarded: 0, failed: 0 } }, { evaluation: {} }, { evaluation: { score: 'x' } }, { evaluation: { score: null } }, { pilots: [], evaluation: [] }, { pilots: 'x', evaluation: 5 }]) {
    const rows = M.scoreRows(task);
    assert.ok(rows.length >= 1 && rows.length <= 2);
    assert.ok(!rows.some(r => /undefined|null|NaN|\[object/.test(r.text)), JSON.stringify(task));
  }
  assert.equal(M.scoreRows({ evaluation: { score: 'x' } })[0].kind, 'empty', 'an unusable result is no result');
  /* a record straight from the evaluation parser carries no scoreText: it is read like the picker reads it */
  const parsed = M.scoreRows({ evaluation: { score: 6, scoreMax: 8, runId: 'run-5', importedAt: '2026-10-03T08:00:00.000Z', versionNote: 'Earlier version' } });
  assert.equal(parsed[0].text, 'Imported evaluation result: 6 / 8, run run-5, 2026-10-03. Recorded by you from the evaluation; Finance Task Studio did not compute it.');
  assert.equal(parsed[0].note, 'Earlier version');
  assert.equal(M.scoreRows({ evaluation: { score: 6, scoreMax: 8, versionNote: 'anything else' } })[0].note, '');
});

test('only ISO dates are dates: a lenient parse of "12" or "1" never becomes a timestamp', () => {
  const evals = [{ task: 'Atlas', runId: 'bad-1', score: 1, scoreMax: 2, importedAt: '12' }, { task: 'Meridian', runId: 'bad-2', score: 1, scoreMax: 2, importedAt: '1' }, { task: 'Cobalt', runId: 'ok', score: 1, scoreMax: 2, importedAt: '2026-10-03' }, { task: 'Borealis', runId: 'ok2', score: 1, scoreMax: 2, importedAt: '2026-10-03 08:00:00' }];
  const board = M.buildBoard({ evals });
  assert.equal(byName(board, 'Atlas').evaluation.importedDate, '');
  assert.equal(byName(board, 'Meridian').evaluation.importedDate, '');
  assert.equal(byName(board, 'Cobalt').evaluation.importedDate, '2026-10-03');
  assert.equal(byName(board, 'Borealis').evaluation.importedDate, '2026-10-03');
  assert.match(M.scoreRows(byName(board, 'Atlas'))[0].text, /, run bad-1, date not recorded\./);
  for (const now of ['12', '1', '2026', 'Oct 5 2026', ' 2026-10-05T10:00:00Z']) assert.equal(M.buildBoard({ now }).asOf, null, now);
  assert.equal(M.buildBoard({ now: '2026-10-05T10:00:00Z' }).asOf, '2026-10-05T10:00:00.000Z');
  assert.equal(M.buildFeed({ runs: [pilot('iso-aaa1', 1, { startedAt: '5', endedAt: '9' })] }).items[0].durationMs, null);
});

test('everything the model returns survives JSON unchanged, so a view can keep or compare it', () => {
  const evals = [{ id: 'e1', task: 'Atlas', runId: 'run-1', score: 7, scoreMax: 10, importedAt: iso(3), judge: 'qa-judge', attempt: '2' }];
  for (const w of [idleWorld(), runningWorld(), {}, { offline: true, evals }]) {
    const board = M.buildBoard({ ...w, evals, now: NOW });
    assert.deepEqual(JSON.parse(JSON.stringify(board)), board);
    const feed = M.buildFeed({ runs: w.runs, rounds: w.rounds, now: NOW });
    assert.deepEqual(JSON.parse(JSON.stringify(feed)), feed);
    for (const t of board.tasks) assert.deepEqual(JSON.parse(JSON.stringify(M.scoreRows(t))), M.scoreRows(t));
  }
});

test('the exported state table cannot be changed by a caller', () => {
  assert.throws(() => { M.STATES.running.word = 'X'; }, TypeError);
  assert.throws(() => { M.STATES.extra = {}; }, TypeError);
  assert.throws(() => { M.URGENCY.watch = 9; }, TypeError);
  assert.equal(M.buildFeed({ runs: [running('frz-aaa1', 1)] }).items[0].stateWord, 'RUNNING');
});
