'use strict';
/* Regression tests for the agent service: the places where a change would leave every other test green. Each test is
   written so that it fails when the rule it names is removed. Every run uses backend/agents/stub-claude.cjs or a small
   Node script; no model is started and nothing touches the network. All fixtures are synthetic and live in temporary
   folders that are removed afterwards. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildArgs, ClaudeRun } = require('../backend/agents/claude-runner.cjs');
const { createAgentService, AgentError } = require('../backend/agents/index.cjs');
const { RoundStore, buildGraderPrompt, buildReviewPrompt } = require('../backend/agents/rounds.cjs');
const C = require('../backend/agents/constants.cjs');
const candidateEngine = require('../candidate-engine.js');

const STUB = path.resolve(__dirname, '..', 'backend', 'agents', 'stub-claude.cjs');
const PROMPT = 'Assess the Atlas liquidity position using the supplied records and recommend whether the borrowing can proceed.';
const ACK = ['shell-access', 'network', 'isolation-by-audit'];
const GOLD = {
  gold: { decision: 'hold', figures: [{ label: 'Usable cash', value: '1,250', tolerance: 1 }], notes: 'Synthetic gold' },
  fingerprints: [{ id: 'fp-credit', label: 'Counts available credit as cash', tokens: ['available facility counted'], figures: [{ label: 'Wrong cash', value: 3050, tolerance: 1 }] }],
};
const GOLD_ANSWER = 'Usable cash is 1,250. Hold the borrowing.';
const WRONG_ANSWER = 'Cash is 3,050 because the available facility counted as cash. Proceed.';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, { timeout = 15000, interval = 20, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + label);
    await sleep(interval);
  }
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}
const promptRuns = file => readJsonLines(file).filter(args => args.includes('-p'));

/* A synthetic world: <base>/project (with private/), <base>/source (the packet), <base>/tmp (pilot folders).
   __PROJECT_ROOT__ and __PILOTS_ROOT__ in a scenario are replaced by the real paths. */
function makeWorld(t, scenario = {}, options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-hardening-test-'));
  const projectRoot = path.join(base, 'project');
  const source = path.join(base, 'source');
  const tmpRoot = path.join(base, 'tmp');
  fs.mkdirSync(path.join(projectRoot, 'private'), { recursive: true });
  fs.mkdirSync(source);
  fs.mkdirSync(tmpRoot);
  const pilots = path.join(tmpRoot, 'finance-studio-pilots');
  const argvLog = path.join(base, 'argv.log');
  const put = (rel, data) => {
    const target = path.join(source, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data === undefined ? 'synthetic contents of ' + rel : data);
    return target;
  };
  put('Facility_Terms.txt', 'Atlas facility terms, synthetic. Available credit is not cash received.\n');
  put('Cash_Facts.csv', 'Label,Value\nOpening usable cash,100\nConfirmed funded draw,500\n');
  const env = {
    ...process.env,
    FINANCE_STUB_SCENARIO: JSON.stringify(scenario).split('__PROJECT_ROOT__').join(projectRoot).split('__PILOTS_ROOT__').join(pilots),
    FINANCE_STUB_ARGV_LOG: argvLog,
    ...(options.env || {}),
  };
  const make = (extra = {}) => createAgentService({ root: projectRoot, env, claudeBin: STUB, tmpRoot, limits: options.limits, ...extra });
  const service = make();
  t.after(async () => {
    await service.shutdown();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, projectRoot, source, tmpRoot, pilots, argvLog, put, env, service, make, roundsDir: path.join(projectRoot, 'private', 'agent-rounds') };
}

const roundBody = (w, extra = {}) => ({
  label: 'synthetic round',
  sourceDir: w.source,
  promptText: PROMPT,
  gafVisible: true,
  config: { model: 'claude-opus-5-5', effort: 'medium', count: 1 },
  ...extra,
});
const newRound = (w, extra) => w.service.createRound(roundBody(w, extra));

async function frozenRound(w, extra, freeze = GOLD) {
  const round = await newRound(w, extra);
  await w.service.freezeRound(round.id, freeze);
  return round.id;
}

async function approvedRound(w, extra) {
  const id = await frozenRound(w, extra);
  const { summarySha256 } = await w.service.approvalSummary(id);
  await w.service.approveRound(id, { summarySha256, acknowledgements: ACK });
  return id;
}

async function finishedRound(w, extra) {
  const id = await approvedRound(w, extra);
  await w.service.launchRound(id);
  await w.service.whenSettled(id);
  return id;
}

async function rejects(promise, status, pattern) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof AgentError, 'AgentError expected, got ' + (error && error.stack));
    assert.equal(error.status, status, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

const readRound = (w, id) => JSON.parse(fs.readFileSync(path.join(w.roundsDir, id, 'round.json'), 'utf8'));
const writeRound = (w, id, round) => fs.writeFileSync(path.join(w.roundsDir, id, 'round.json'), JSON.stringify(round));

/* ====================================================================== the audit is wired to the pilot's own folder */

test('the audit runs against each pilot own folder: a sibling pilot output is off limits, the own folder is not', async t => {
  const w = makeWorld(t, [
    { resultText: GOLD_ANSWER, writeFiles: [{ path: 'outputs/answer.txt', content: 'Usable cash 1,250' }] },
    {
      resultText: GOLD_ANSWER,
      toolUses: [
        { name: 'Bash', input: { command: 'cat __PILOTS_ROOT__/*-1/outputs/answer.txt' } },
        { name: 'Glob', input: { pattern: '__PILOTS_ROOT__/*/outputs/*' } },
        { name: 'Read', input: { file_path: 'outputs/answer.txt' } },
        { name: 'Bash', input: { command: 'ls outputs filesystem' } },
      ],
    },
    {
      resultText: GOLD_ANSWER,
      toolUses: [{ name: 'Bash', input: { command: 'cat ../*-1/outputs/answer.txt' } }],
    },
    { resultText: GOLD_ANSWER, toolUses: [{ name: 'Read', input: { file_path: 'outputs/answer.txt' } }, { name: 'Bash', input: { command: 'ls outputs filesystem' } }] },
  ]);
  const id = await finishedRound(w, { config: { model: 'claude-opus-5-5', effort: 'medium', count: 4 } });
  const runs = await Promise.all([1, 2, 3, 4].map(n => w.service.getRun(id, n)));
  assert.equal(runs[0].audit.status, 'CLEAN');
  assert.equal(runs[1].audit.status, 'DISCARDED');
  assert.deepEqual(runs[1].audit.violations.map(v => v.kind), ['abs', 'abs'], 'the shell read and the Glob are both outside the pilot folder');
  assert.ok(runs[1].audit.violations.every(v => v.path.startsWith(w.pilots)));
  assert.equal(runs[2].audit.status, 'DISCARDED');
  assert.deepEqual(runs[2].audit.violations.map(v => v.kind), ['dotdot'], 'a relative path to a sibling is also caught');
  assert.equal(runs[3].audit.status, 'CLEAN', 'the own folder, by relative path, is fine');
  await rejects(w.service.classifyRun(id, 2, { verdict: 'matches-frozen-gold' }), 409, /DISCARDED/);
  await rejects(w.service.classifyRun(id, 3, { verdict: 'matches-frozen-gold' }), 409, /DISCARDED/);
  await w.service.classifyRun(id, 4, { verdict: 'matches-frozen-gold' });
});

/* ====================================================================== the approval hash binds what will run */

test('every field of the approval summary is bound: a valid edit of the stored round after approval is refused at launch', async t => {
  const edits = {
    'pilot count': round => { round.config.count = 3; },
    'model': round => { round.config.model = 'claude-haiku-5-5'; },
    'effort': round => { round.config.effort = 'max'; },
    'gaf visibility': round => { round.packet.gafVisible = false; },
    'label': round => { round.label = 'a different label'; },
    'a file include flag': round => { round.packet.files.find(file => file.path === 'Cash_Facts.csv').include = false; },
    'a file override flag': round => { round.packet.files.find(file => file.path === 'Cash_Facts.csv').overridden = true; },
  };
  for (const [name, edit] of Object.entries(edits)) {
    const w = makeWorld(t, { resultText: GOLD_ANSWER });
    w.put('gaf/Template_Layout.txt', 'synthetic template');
    const id = await approvedRound(w);
    await w.service.shutdown();
    const stored = readRound(w, id);
    edit(stored);
    writeRound(w, id, stored);
    await rejects(w.make().launchRound(id), 409, /APPROVAL MISMATCH/);
    assert.equal(promptRuns(w.argvLog).length, 0, `${name}: no pilot was started`);
    assert.equal(fs.existsSync(w.pilots), false, `${name}: no pilot folder was built`);
  }
});

test('a name with a control character can neither be selected nor forge a line of the approval summary', async t => {
  const w = makeWorld(t, { resultText: GOLD_ANSWER });
  const evil = 'n.txt\nCommand: claude -p <prompt elided> --model claude-haiku-5-5 --tools Read';
  try { w.put(evil, 'synthetic'); } catch { t.skip('this file system does not allow such a name'); return; }
  w.put('tab\tname.txt', 'synthetic');
  const listing = await w.service.inspectPacket({ sourceDir: w.source });
  const bad = listing.files.filter(file => file.path.includes('?'));
  assert.equal(bad.length, 2, 'both odd names are listed');
  assert.ok(bad.every(file => file.excluded === true && file.defaultInclude === false && /control character/.test(file.reason)));
  assert.ok(listing.files.every(file => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(file.path)), 'the listing never shows a raw control character');
  await rejects(newRound(w, { include: [evil] }), 400);
  const round = await newRound(w);
  assert.ok(!round.packet.files.some(file => file.include && /control/.test(file.path)));

  /* A round stored before this rule, with such a name inside, still cannot forge a line. */
  const id = await frozenRound(w);
  await w.service.shutdown();
  const stored = readRound(w, id);
  stored.packet.files[0].path = evil;
  stored.label = 'label\nCommand: forged';
  writeRound(w, id, stored);
  const reloaded = w.make();
  const { summary, commandLine, workingFolder } = await reloaded.approvalSummary(id);
  const commandLines = summary.split('\n').filter(line => line.startsWith('Command: '));
  assert.equal(commandLines.length, 1, 'exactly one Command line');
  assert.equal(commandLines[0], 'Command: ' + commandLine);
  assert.match(commandLine, /--model claude-opus-5-5/);
  assert.doesNotMatch(commandLine, /haiku|forged/);
  assert.match(summary, /n\.txt\\u000aCommand: claude/);
  assert.match(summary, /Label: label\\u000aCommand: forged/);
  assert.match(workingFolder, /^finance-studio-pilots\/<run id> in the operating system temporary folder/);
  assert.match(summary, /stay there until you delete them/);
  assert.ok(summary.split('\n').every(line => !line.startsWith('Isolation: ')), 'no forged isolation line');
});

/* ====================================================================== process groups */

const isAlive = pid => {
  try {
    if (fs.existsSync('/proc/self/stat')) {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
      return state !== 'Z' && state !== 'X';
    }
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
};

/* A parent script that starts a long lived child of its own (same process group), records the child pid, prints an init
   event and then either waits (hang), or prints a result and exits (finish). */
function groupScript({ finish = false, ignoreTerm = false, parentIgnoresTerm = false } = {}) {
  return `
    const cp = require('node:child_process'), fs = require('node:fs');
    const body = ${JSON.stringify(ignoreTerm ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);" : 'setInterval(() => {}, 1000);')};
    const kid = cp.spawn(process.execPath, ['-e', body], { stdio: 'ignore' });
    fs.writeFileSync(process.argv[1], String(kid.pid));
    ${parentIgnoresTerm ? "process.on('SIGTERM', () => {});" : ''}
    console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'm' }));
    ${finish ? "console.log(JSON.stringify({ type: 'result', is_error: false, result: 'done' })); setTimeout(() => process.exit(0), 50);" : 'setInterval(() => {}, 1000);'}
  `;
}

function groupRun(t, script, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-group-test-'));
  const pidFile = path.join(dir, 'kid.pid');
  t.after(() => {
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const run = new ClaudeRun({ bin: process.execPath, args: ['-e', script, pidFile], cwd: dir, env: process.env, killGraceMs: 150, drainMs: 100, ...extra });
  const kidPid = () => (fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8') ? Number(fs.readFileSync(pidFile, 'utf8')) : 0);
  return { run, kidPid, dir };
}

const groupTest = process.platform === 'win32' ? test.skip : test;

groupTest('cancel stops a child the pilot shell started, not only the process itself', async t => {
  const { run, kidPid } = groupRun(t, groupScript());
  const done = run.start();
  const pid = await waitFor(kidPid, { label: 'the child pid' });
  assert.ok(isAlive(pid), 'the child runs while the pilot runs');
  run.cancel();
  const summary = await done;
  assert.equal(summary.state, 'cancelled');
  await waitFor(() => !isAlive(pid), { label: 'the child to stop', timeout: 5000 });
});

groupTest('a timeout stops the whole process group', async t => {
  const { run, kidPid } = groupRun(t, groupScript(), { timeoutMs: 400 });
  const done = run.start();
  const pid = await waitFor(kidPid, { label: 'the child pid' });
  const summary = await done;
  assert.equal(summary.failureReason, 'timeout');
  await waitFor(() => !isAlive(pid), { label: 'the child to stop', timeout: 5000 });
});

groupTest('a child that ignores SIGTERM is killed when the run ends, even though the parent already exited', async t => {
  const { run, kidPid } = groupRun(t, groupScript({ ignoreTerm: true }), { killGraceMs: 10000 });
  const done = run.start();
  const pid = await waitFor(kidPid, { label: 'the child pid' });
  await sleep(150);
  run.cancel();
  const summary = await done;
  assert.equal(summary.state, 'cancelled');
  await waitFor(() => !isAlive(pid), { label: 'the stubborn child to stop', timeout: 5000 });
});

groupTest('a background process left behind by a run that ends normally is stopped and noted', async t => {
  const { run, kidPid } = groupRun(t, groupScript({ finish: true }));
  const summary = await run.start();
  assert.equal(summary.state, 'completed');
  assert.equal(summary.leftoverStopped, true);
  const pid = kidPid();
  assert.ok(pid > 1);
  await waitFor(() => !isAlive(pid), { label: 'the leftover to stop', timeout: 5000 });

  /* A run that leaves nothing behind says so too. */
  const clean = groupRun(t, `console.log(JSON.stringify({ type: 'result', is_error: false, result: 'done' }));`);
  const cleanSummary = await clean.run.start();
  assert.equal(cleanSummary.state, 'completed');
  assert.equal(cleanSummary.leftoverStopped, false);
});

test('a pilot that leaves a background process running has it stopped, and the run says so', async t => {
  const w = makeWorld(t, [{ resultText: GOLD_ANSWER, background: true }, { resultText: GOLD_ANSWER }]);
  const id = await finishedRound(w, { config: { model: 'claude-opus-5-5', effort: 'medium', count: 2 } });
  const [left, clean] = [await w.service.getRun(id, 1), await w.service.getRun(id, 2)];
  assert.equal(left.state, 'completed');
  assert.equal(left.audit.status, 'CLEAN', 'a leftover is a note, not a discard');
  assert.ok(left.audit.notes.some(note => note.startsWith('background-processes: ')), left.audit.notes.join(' | '));
  assert.equal(clean.audit.notes.some(note => note.startsWith('background-processes')), false, 'a run that left nothing has no such note');
  const pid = Number(fs.readFileSync(path.join(w.pilots, `${id}-1`, '.tmp', 'background.pid'), 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } });
  await waitFor(() => !isAlive(pid), { label: 'the background process to stop', timeout: 5000 });
});

/* ====================================================================== state that must survive a restart */

test('a human verdict is on disk the moment it is given', async t => {
  const w = makeWorld(t, { resultText: GOLD_ANSWER });
  const id = await finishedRound(w);
  await w.service.classifyRun(id, 1, { verdict: 'matches-frozen-gold', note: 'saved at once' });
  const onDisk = JSON.parse(fs.readFileSync(path.join(w.roundsDir, id, 'runs', '1', 'run.json'), 'utf8'));
  assert.equal(onDisk.classification.human.verdict, 'matches-frozen-gold');
  assert.equal(readRound(w, id).runs[0].classification.human.note, 'saved at once');
  await w.service.shutdown();
  const reloaded = w.make();
  assert.equal((await reloaded.getRun(id, 1)).classification.human.verdict, 'matches-frozen-gold');
  assert.equal((await reloaded.exportRound(id)).records.length, 1);
});

test('a human verdict, a post-hoc freeze and the export survive a restart; a second post-hoc freeze keeps the verdict', async t => {
  const w = makeWorld(t, { resultText: GOLD_ANSWER });
  const id = await finishedRound(w);
  await w.service.classifyRun(id, 1, { verdict: 'matches-frozen-gold', note: 'kept' });

  await w.service.refreezeRound(id, GOLD);
  const afterFirst = await w.service.getRun(id, 1);
  assert.equal(afterFirst.classification.human.verdict, 'matches-frozen-gold', 'the verdict survives a post-hoc freeze');
  await w.service.refreezeRound(id, { gold: { decision: 'proceed', figures: [], notes: '' }, fingerprints: [] });
  const afterSecond = await w.service.getRun(id, 1);
  assert.equal(afterSecond.classification.human.verdict, 'matches-frozen-gold', 'and a second one');
  assert.equal(afterSecond.classification.human.note, 'kept');
  assert.equal(afterSecond.classification.suggested.freezeVersion, 3);
  const exportBefore = await w.service.exportRound(id);
  assert.equal(exportBefore.records.length, 1);

  await w.service.shutdown();
  const reloaded = w.make();
  const round = await reloaded.getRound(id);
  assert.equal(round.postHocFreezes.length, 2, 'post-hoc freezes survive a restart');
  assert.deepEqual(round.postHocFreezes.map(freeze => freeze.version), [2, 3]);
  const run = await reloaded.getRun(id, 1);
  assert.equal(run.classification.human.verdict, 'matches-frozen-gold', 'the human verdict survives a restart');
  assert.equal(run.classification.human.note, 'kept');
  const exportAfter = await reloaded.exportRound(id);
  assert.deepEqual(exportAfter.records.map(record => [record.runId, record.classification, record.notes]), exportBefore.records.map(record => [record.runId, record.classification, record.notes]));
  /* the next post-hoc version is numbered after the stored ones */
  const fourth = await reloaded.refreezeRound(id, GOLD);
  assert.equal(fourth.postHocFreezes.length, 3);
  assert.equal(fourth.postHocFreezes[2].version, 4);
});

test('a finished, failed or cancelled round cannot be launched again, and its runs are left as they were', async t => {
  const finished = makeWorld(t, { resultText: GOLD_ANSWER });
  const finishedId = await finishedRound(finished);
  const before = await finished.service.getRound(finishedId);
  assert.equal(before.status, 'finished');
  await rejects(finished.service.launchRound(finishedId), 409, /Approve the round/);
  assert.equal(promptRuns(finished.argvLog).length, 1, 'no second process was started');
  assert.deepEqual((await finished.service.getRound(finishedId)).runs, before.runs);

  const failed = makeWorld(t, { resultText: '', exitCode: 3 });
  const failedId = await finishedRound(failed);
  assert.equal((await failed.service.getRound(failedId)).status, 'failed');
  await rejects(failed.service.launchRound(failedId), 409, /Approve the round/);
  assert.equal(promptRuns(failed.argvLog).length, 1);
  assert.equal((await failed.service.getRound(failedId)).runs[0].state, 'failed');

  const cancelled = makeWorld(t);
  const cancelledId = await approvedRound(cancelled);
  await cancelled.service.cancelRound(cancelledId);
  await rejects(cancelled.service.launchRound(cancelledId), 409);
  assert.equal(promptRuns(cancelled.argvLog).length, 0);
});

/* ====================================================================== counts, export and approval details */

test('counts, the directional line and the export agree: discarded, failed and unclassified runs are not counted as results', async t => {
  const w = makeWorld(t, [
    { resultText: GOLD_ANSWER },
    { resultText: GOLD_ANSWER, toolUses: [{ name: 'Bash', input: { command: 'cat /opt/outside/x' } }] },
    { resultText: '', exitCode: 1 },
    { resultText: WRONG_ANSWER },
  ]);
  const id = await finishedRound(w, { config: { model: 'claude-opus-5-5', effort: 'medium', count: 4 } });
  let round = await w.service.getRound(id);
  assert.deepEqual(round.runs.map(run => [run.state, run.audit.status]), [['completed', 'CLEAN'], ['completed', 'DISCARDED'], ['failed', 'CLEAN'], ['completed', 'CLEAN']]);
  assert.equal(round.directional, 'Directional only, n = 2. No rate or difficulty is computed.', 'the discarded and the failed run are not results');
  assert.equal(round.counts.discarded, 1);
  assert.equal(round.counts.clean, 3);
  assert.equal(round.counts.classified, 0, 'a suggestion is not a classification');
  assert.equal(round.runs[3].classification.suggestedVerdict, 'fingerprint');
  assert.equal(round.runs[3].classification.humanVerdict, null);
  await w.service.classifyRun(id, 1, { verdict: 'matches-frozen-gold' });
  round = await w.service.getRound(id);
  assert.equal(round.counts.classified, 1);
  assert.equal(round.counts.completed, 3);
  assert.equal(round.counts.failed, 1);
  const rows = await w.service.listRounds();
  assert.deepEqual(rows[0].counts, round.counts);
  const exported = await w.service.exportRound(id);
  assert.equal(exported.directional, 'Directional only, n = 1. No rate or difficulty is computed.');
});

test('the export names the model the runtime reported, and falls back to labelled hashes when no versions were given', async t => {
  const w = makeWorld(t, { resultText: GOLD_ANSWER, init: { model: 'claude-sonnet-5-5' } });
  const id = await finishedRound(w);
  await w.service.classifyRun(id, 1, { verdict: 'matches-frozen-gold' });
  const round = await w.service.getRound(id);
  const [record] = (await w.service.exportRound(id)).records;
  assert.equal(round.runs[0].requestedModel, 'claude-opus-5-5');
  assert.equal(record.model, 'claude-sonnet-5-5', 'the resolved model, not the requested one');
  assert.deepEqual(record.versions, {
    prompt: `sha256:${round.packet.promptSha256.slice(0, 12)}`,
    workbook: `sha256:${round.packet.packetSha256.slice(0, 12)}`,
    evaluator: `freeze:${round.freeze.sha256.slice(0, 12)}`,
  });
});

test('an evaluator-role file the writer overrode into the packet does not enter the source fingerprint', async t => {
  const w = makeWorld(t, { resultText: GOLD_ANSWER });
  w.put('Answer Key.txt', 'synthetic key that the writer deliberately delivers');
  const include = ['Cash_Facts.csv', 'Facility_Terms.txt', 'Answer Key.txt'];
  const id = await finishedRound(w, { include, overrides: ['Answer Key.txt'] });
  await w.service.classifyRun(id, 1, { verdict: 'matches-frozen-gold' });
  const round = await w.service.getRound(id);
  const key = round.packet.files.find(file => file.path === 'Answer Key.txt');
  assert.equal(key.role, 'evaluator');
  assert.equal(key.overridden, true);
  const documents = round.packet.files.filter(file => file.include).map(file => ({ name: file.path, sha256: file.sha256, role: file.role }));
  documents.push({ name: 'Task_Prompt.txt', sha256: crypto.createHash('sha256').update(PROMPT).digest('hex'), role: 'prompt' });
  const [record] = (await w.service.exportRound(id)).records;
  assert.equal(record.sourceFingerprint, await candidateEngine.sourceFingerprint({ documents }));
  const withoutKey = documents.filter(document => document.name !== 'Answer Key.txt');
  assert.equal(record.sourceFingerprint, await candidateEngine.sourceFingerprint({ documents: withoutKey }));
});

test('the approval summary lists what is delivered and what is withheld, for gaf visible and hidden', async t => {
  const w = makeWorld(t);
  w.put('gaf/Template_Layout.txt', 'synthetic template');
  w.put('Extra_gaf_notes.txt', 'synthetic');
  const lineOf = (summary, prefix) => summary.split('\n').find(line => line.startsWith(prefix));
  const hiddenId = await frozenRound(w, { gafVisible: false });
  const hidden = (await w.service.approvalSummary(hiddenId)).summary;
  assert.equal(lineOf(hidden, 'Packet files: '), 'Packet files: 4 selected, 2 delivered to each pilot');
  assert.equal(lineOf(hidden, 'Delivered: '), 'Delivered: Cash_Facts.csv, Facility_Terms.txt');
  assert.equal(lineOf(hidden, 'Withheld because the gaf folder is hidden: '), 'Withheld because the gaf folder is hidden: Extra_gaf_notes.txt, gaf/Template_Layout.txt');
  assert.equal(lineOf(hidden, 'GAF folder visible to pilots: '), 'GAF folder visible to pilots: no');
  assert.ok(hidden.includes('The gaf/ folder matches production only if the production solver sees this file.'));
  assert.equal(lineOf(hidden, 'Time limit per pilot: '), 'Time limit per pilot: 50 minutes');
  assert.match(lineOf(hidden, 'Prompt sha256: '), /^Prompt sha256: [0-9a-f]{64}$/);

  const visibleId = await frozenRound(w, { gafVisible: true });
  const visible = (await w.service.approvalSummary(visibleId)).summary;
  assert.equal(lineOf(visible, 'Packet files: '), 'Packet files: 4 selected, 4 delivered to each pilot');
  assert.equal(lineOf(visible, 'Delivered: '), 'Delivered: Cash_Facts.csv, Extra_gaf_notes.txt, Facility_Terms.txt, gaf/Template_Layout.txt');
  assert.equal(lineOf(visible, 'Withheld because the gaf folder is hidden: '), 'Withheld because the gaf folder is hidden: none');
  assert.equal(lineOf(visible, 'GAF folder visible to pilots: '), 'GAF folder visible to pilots: yes');
  assert.notEqual(hidden, visible);
});

/* ====================================================================== guards that were only implied */

test('an approval hash that is only a prefix of the right one is refused', async t => {
  const w = makeWorld(t);
  const id = await frozenRound(w);
  const { summarySha256 } = await w.service.approvalSummary(id);
  for (const given of [summarySha256.slice(0, 8), summarySha256.slice(0, 32), summarySha256.slice(0, 63), summarySha256 + '0', summarySha256.toUpperCase(), '']) {
    await rejects(w.service.approveRound(id, { summarySha256: given, acknowledgements: ACK }), 409, /approval hash/);
  }
  assert.equal((await w.service.getRound(id)).status, 'frozen');
  await w.service.approveRound(id, { summarySha256, acknowledgements: ACK });
});

test('limits can be lowered but never raised: a huge override gives the contract values', () => {
  const store = new RoundStore({ root: path.join(os.tmpdir(), 'finance-limits-test-not-created'), limits: { timeoutMs: 1e12, killGraceMs: 1e9, concurrency: 99, drainMs: 5 } });
  assert.equal(store.limits.timeoutMs, C.LIMITS.timeoutMs);
  assert.equal(store.limits.killGraceMs, C.LIMITS.killGraceMs);
  assert.equal(store.limits.concurrency, C.LIMITS.concurrency);
  const lowered = new RoundStore({ root: path.join(os.tmpdir(), 'finance-limits-test-not-created'), limits: { timeoutMs: 1000, killGraceMs: 7, concurrency: 1 } });
  assert.deepEqual([lowered.limits.timeoutMs, lowered.limits.killGraceMs, lowered.limits.concurrency], [1000, 7, 1]);
});

test('a tool-less run (grader or author review) is capped at ten minutes, whatever the pilot limit is', async t => {
  const w = makeWorld(t, { resultText: '{"verdict": "unclear", "reason": "x"}' });
  const delays = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return realSetTimeout(fn, ms, ...rest); };
  try {
    await w.service.graderSim({ guidelineText: 'You are grading an answer.', answerText: 'An answer.' });
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.ok(delays.includes(10 * 60 * 1000), 'the grader timeout is ten minutes: ' + delays.join(','));
  assert.ok(!delays.includes(C.LIMITS.timeoutMs), 'and not the 50 minute pilot limit');
});

test('a source folder that disappeared after approval refuses the launch with PACKET HASH MISMATCH', async t => {
  const w = makeWorld(t);
  const id = await approvedRound(w);
  fs.rmSync(w.source, { recursive: true, force: true });
  await rejects(w.service.launchRound(id), 409, /PACKET HASH MISMATCH.*source folder is missing/);
  assert.equal(promptRuns(w.argvLog).length, 0);
  assert.equal((await w.service.getRound(id)).status, 'approved');
});

test('a run that cannot be finished is DISCARDED, never CLEAN', async t => {
  const w = makeWorld(t, { resultText: GOLD_ANSWER, delayMs: 500 });
  const id = await approvedRound(w);
  await w.service.launchRound(id);
  /* A regular file where the run's outputs folder belongs makes the copy of the outputs fail. */
  fs.writeFileSync(path.join(w.roundsDir, id, 'runs', '1', 'outputs'), 'in the way');
  await w.service.whenSettled(id);
  const run = await w.service.getRun(id, 1);
  assert.equal(run.audit.status, 'DISCARDED');
  assert.ok(run.audit.notes.some(note => note.startsWith('audit-error: the run could not be finished')), run.audit.notes.join(' | '));
  await rejects(w.service.classifyRun(id, 1, { verdict: 'matches-frozen-gold' }), 409, /DISCARDED/);
});

test('a solver file that disappeared and junk output lines are noted exactly', async t => {
  const w = makeWorld(t, { resultText: GOLD_ANSWER, deleteFiles: ['filesystem/Cash_Facts.csv'], junk: true });
  const id = await finishedRound(w);
  const run = await w.service.getRun(id, 1);
  assert.equal(run.audit.status, 'CLEAN');
  assert.deepEqual(run.audit.inputsModified, ['Cash_Facts.csv (missing)']);
  assert.deepEqual(run.audit.notes, [
    'inputs-modified: Cash_Facts.csv (missing)',
    'stream-junk: 2 output lines were not JSON and were ignored',
  ]);
});

test('an answer kept in a text-like output file is found for every text extension, and not for other files', async t => {
  const answer = 'Usable cash is 1,250. Hold the borrowing.';
  const groups = [['txt', 'csv', 'tsv', 'json', 'html'], ['htm', 'xml', 'log', 'yaml', 'yml'], ['sql', 'py', 'md', 'bin', 'xlsx']];
  const verdicts = {};
  for (const group of groups) {
    const w = makeWorld(t, group.map(ext => ({ resultText: 'See the attached file.', writeFiles: [{ path: `outputs/answer.${ext}`, content: answer }] })));
    const id = await finishedRound(w, { config: { model: 'claude-opus-5-5', effort: 'medium', count: 5 } });
    const round = await w.service.getRound(id);
    group.forEach((ext, index) => { verdicts[ext] = round.runs[index].classification.suggestedVerdict; });
  }
  for (const ext of ['txt', 'csv', 'tsv', 'json', 'html', 'htm', 'xml', 'log', 'yaml', 'yml', 'sql', 'py', 'md']) assert.equal(verdicts[ext], 'matches-frozen-gold', ext);
  for (const ext of ['bin', 'xlsx']) assert.equal(verdicts[ext], 'unclear', ext);
});

test('the data markers around grader and review inputs are exact, and the service sends them', async t => {
  assert.ok(buildGraderPrompt('GUIDE', 'ANSWER-TEXT').includes('\n<<<GUIDANCE\nGUIDE\nGUIDANCE>>>\n\n<<<ANSWER\nANSWER-TEXT\nANSWER>>>'));
  assert.ok(buildReviewPrompt('PROMPT-TEXT', 'PACKAGE-TEXT').includes('\n<<<PROMPT\nPROMPT-TEXT\nPROMPT>>>\n\n<<<PACKAGE\nPACKAGE-TEXT\nPACKAGE>>>'));
  const w = makeWorld(t, { resultText: '{"verdict": "unclear", "reason": "x"}' });
  await w.service.graderSim({ guidelineText: 'You are grading an answer.', answerText: 'An answer.' });
  await w.service.authorReview({ promptText: 'A prompt.', packageText: 'Some package text.' });
  const [grader, review] = promptRuns(w.argvLog).map(args => args[1]);
  assert.ok(grader.includes('\n<<<GUIDANCE\nYou are grading an answer.\nGUIDANCE>>>\n\n<<<ANSWER\nAn answer.\nANSWER>>>'));
  assert.ok(review.includes('\n<<<PROMPT\nA prompt.\nPROMPT>>>\n\n<<<PACKAGE\nSome package text.\nPACKAGE>>>'));
});

test('keys a client adds to the config are not stored and never reach the command line', async t => {
  const w = makeWorld(t, { resultText: GOLD_ANSWER });
  const round = await newRound(w, { config: { kind: 'pilot', model: 'claude-opus-5-5', effort: 'medium', count: 1, args: ['--dangerously-skip-permissions'], bin: '/bin/sh', env: { X: '1' }, folder: '/tmp' } });
  assert.deepEqual(Object.keys(round.config), ['kind', 'model', 'effort', 'count', 'tools']);
  assert.deepEqual(Object.keys(readRound(w, round.id).config), ['kind', 'model', 'effort', 'count', 'tools']);
  const id = round.id;
  await w.service.freezeRound(id, GOLD);
  const { summarySha256 } = await w.service.approvalSummary(id);
  await w.service.approveRound(id, { summarySha256, acknowledgements: ACK });
  await w.service.launchRound(id);
  await w.service.whenSettled(id);
  const [argv] = promptRuns(w.argvLog);
  assert.deepEqual(argv.slice(2), buildArgs({ prompt: 'x', model: 'claude-opus-5-5', effort: 'medium', tools: C.TOOLS }).slice(2));
});

/* ====================================================================== the pilots root */

test('the folder that holds the pilot folders must be a real directory this account owns', async t => {
  const w = makeWorld(t, { resultText: GOLD_ANSWER });
  /* a link is refused */
  const elsewhere = path.join(w.base, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, w.pilots);
  const linkedId = await approvedRound(w);
  await w.service.launchRound(linkedId);
  await w.service.whenSettled(linkedId);
  let run = await w.service.getRun(linkedId, 1);
  assert.equal(run.state, 'failed');
  assert.equal(run.failureReason, 'setup-error');
  assert.match(run.stderrTail, /symbolic link/);
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing was built through the link');
  /* the tool-less runs (simulated grader, author review) use the same folder and the same check */
  await rejects(w.service.graderSim({ guidelineText: 'You are grading an answer.', answerText: 'An answer.' }), 409, /symbolic link/);
  await rejects(w.service.authorReview({ promptText: 'A prompt.', packageText: 'Some text.' }), 409, /symbolic link/);
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'and they built nothing through it either');
  fs.rmSync(w.pilots);

  /* a root that is open to others is made private, and then used */
  if (process.platform !== 'win32') {
    fs.mkdirSync(w.pilots, { mode: 0o755 });
    fs.chmodSync(w.pilots, 0o755);
    const openId = await approvedRound(w);
    await w.service.launchRound(openId);
    await w.service.whenSettled(openId);
    run = await w.service.getRun(openId, 1);
    assert.equal(run.state, 'completed');
    assert.equal(fs.statSync(w.pilots).mode & 0o077, 0, 'the root is private now');
  }
});

test('a pilots root owned by another account is refused', { skip: process.platform === 'win32' || typeof process.getuid !== 'function' || process.getuid() !== 0 }, async t => {
  const w = makeWorld(t, { resultText: GOLD_ANSWER });
  fs.mkdirSync(w.pilots, { mode: 0o700 });
  fs.chownSync(w.pilots, 65534, 65534);
  const id = await approvedRound(w);
  await w.service.launchRound(id);
  await w.service.whenSettled(id);
  const run = await w.service.getRun(id, 1);
  assert.equal(run.state, 'failed');
  assert.match(run.stderrTail, /belongs to another account/);
  assert.deepEqual(fs.readdirSync(w.pilots), []);
});

/* ====================================================================== the runtime check */

test('a runtime that was missing is looked for again at once, and a found one is still cached', async t => {
  let installed = false;
  let versionCalls = 0;
  const w = makeWorld(t);
  const service = w.make({
    claudeBin: null,
    env: { PATH: '/nowhere-for-this-test', HOME: w.base },
    home: w.base,
    exists: file => installed && file === '/usr/local/bin/claude',
    execFile: async () => { versionCalls++; return { stdout: '2.1.0 (Claude Code)\n' }; },
  });
  const before = await service.status();
  assert.equal(before.runtime.found, false);
  installed = true;
  const after = await service.status();
  assert.equal(after.runtime.found, true, 'Check again sees the new install without waiting');
  assert.equal(versionCalls, 1);
  await service.status();
  await service.status();
  assert.equal(versionCalls, 1, 'a found runtime is cached');
  await service.shutdown();
});
