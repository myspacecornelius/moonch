'use strict';
/* Tests for the companion's lifecycle: one companion per folder (LOCAL_SERVER.json), SIGHUP and SIGQUIT, the process 'exit'
   hook that stops pilots after a crash, the pilot pid on disk and the stop of a pilot an earlier companion left running at
   the next start, and the fixed default port with its fallback.
   Pilots are the stub (backend/agents/stub-claude.cjs): no model is started and nothing leaves this machine. Processes are
   real children of this test and are killed afterwards. Fixtures are synthetic and live in temporary folders. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { cleanEnv } = require('./fixtures/clean-env.cjs');

const server = require('../backend/server.cjs');
const { createServer, installSignalHandlers, findRunningCompanion, portChoice, listenWithFallback, runCompanion, removeLocalServerRecord, pidAlive, DEFAULT_PORT, KEEP_OPEN_LINE } = server;
const { createAgentService } = require('../backend/agents/index.cjs');
const { RoundStore } = require('../backend/agents/rounds.cjs');
const { buildArgs } = require('../backend/agents/claude-runner.cjs');
const C = require('../backend/agents/constants.cjs');

const REPO = path.resolve(__dirname, '..');
const STUB = path.join(REPO, 'backend', 'agents', 'stub-claude.cjs');
const PROMPT = 'Assess the Atlas liquidity position using the supplied records and recommend whether the borrowing can proceed.';
const ACK = ['shell-access', 'network', 'isolation-by-audit'];
const GOLD = {
  gold: { decision: 'hold', figures: [{ label: 'Usable cash', value: '1,250', tolerance: 1 }], notes: 'Synthetic gold' },
  fingerprints: [{ id: 'fp-credit', label: 'Counts available credit as cash', tokens: ['available facility counted'], figures: [{ label: 'Wrong cash', value: 3050, tolerance: 1 }] }],
};
const LEFTOVER_NOTE = 'A pilot process left over from the previous companion was stopped at startup.';
const INTERRUPTED_NOTE = 'The companion stopped before this run finished.';

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

function tempDir(t, prefix = 'finance-lifecycle-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

/* ------------------------------------------------------------------ processes */

/* A process that exists and is not a zombie (a killed process whose parent has not collected it yet is gone for our purpose). */
function running(pid) {
  const answer = childProcess.spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return answer !== '' && !answer.startsWith('Z');
}

const commandOf = pid => childProcess.spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
const groupOf = pid => Number(childProcess.spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim());

function killTree(pid) {
  for (const target of [-pid, pid]) {
    try { process.kill(target, 'SIGKILL'); } catch { /* already gone */ }
  }
}

/* Resolves with the signal that ended a child process of this test (null when it exited by itself). */
const endOf = child => new Promise(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
  else child.once('exit', (code, signal) => resolve({ code, signal }));
});

/* A long lived process that is not a companion and not a pilot: its command line does not name the stub. */
function idleProcess(t, { detached = false, extraArgs = [] } = {}) {
  const child = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...extraArgs], { stdio: 'ignore', detached });
  t.after(() => killTree(child.pid));
  return child;
}

async function deadPid() {
  const child = childProcess.spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await endOf(child);
  return child.pid;
}

/* A pilot the way the runner starts one: the stub itself, detached, with the pilot's arguments, hanging after its first event. */
function leftoverStub(t, cwd) {
  const args = buildArgs({ prompt: 'Synthetic prompt', model: 'claude-opus-5-5', effort: 'low', tools: C.TOOLS });
  const env = { ...cleanEnv(), FINANCE_STUB_SCENARIO: JSON.stringify({ hang: true }) };
  const child = childProcess.spawn(STUB, args, { cwd, env, stdio: 'ignore', detached: true });
  t.after(() => killTree(child.pid));
  return child;
}

/* ------------------------------------------------------------------ a status server that stands for a running companion */

/* A real companion HTTP layer on a free port with a stand-in agent service. */
async function liveCompanion(t, root) {
  const calls = [];
  const service = {
    status: async () => ({}),
    listRounds: async () => [],
    shutdown: async () => {},
    setCompanionPort: async port => { calls.push(port); },
    killPilots: () => { calls.push('killPilots'); },
  };
  const app = createServer({ root, service, port: 0, runner: { state: null, cancel() {} }, log: () => {} });
  const { url, port } = await app.listen();
  t.after(() => app.close());
  return { app, url, port, calls };
}

const writeRecord = (root, record) => fs.writeFileSync(path.join(root, 'LOCAL_SERVER.json'), typeof record === 'string' ? record : JSON.stringify(record));
const readRecord = root => readJson(path.join(root, 'LOCAL_SERVER.json'));
const recordFor = (url, pid) => ({ url, pid, startedAt: new Date().toISOString(), modelCallsOnLaunch: 0 });

/* A free port number: bound for a moment and released. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/* A listener that holds a port, so that binding it fails with EADDRINUSE. */
async function busyPort(t) {
  const holder = net.createServer();
  await new Promise(resolve => holder.listen(0, '127.0.0.1', resolve));
  t.after(() => holder.close());
  return holder.address().port;
}

/* ====================================================================== the usual port */

test('the usual port is 47321 when FINANCE_STUDIO_PORT is unset or empty, and a value the writer sets is kept as it is', () => {
  assert.equal(DEFAULT_PORT, 47321);
  assert.deepEqual(portChoice({}), { port: 47321, fixed: false });
  assert.deepEqual(portChoice({ FINANCE_STUDIO_PORT: '' }), { port: 47321, fixed: false });
  assert.deepEqual(portChoice({}, 5000), { port: 5000, fixed: false });
  assert.deepEqual(portChoice({ FINANCE_STUDIO_PORT: '0' }), { port: 0, fixed: true }, 'an explicit 0 is still a free port, as before');
  assert.deepEqual(portChoice({ FINANCE_STUDIO_PORT: '8123' }), { port: 8123, fixed: true });
  assert.ok(Number.isNaN(portChoice({ FINANCE_STUDIO_PORT: 'abc' }).port), 'a bad value reaches createServer, which refuses it');
  assert.throws(() => createServer({ root: os.tmpdir(), service: { status: async () => ({}) }, port: portChoice({ FINANCE_STUDIO_PORT: 'abc' }).port }), /port must be a whole number/);
  assert.equal(createServer({ root: os.tmpdir(), service: { status: async () => ({}) } }).server.listening, false, 'createServer keeps its own default (port 0, tests pass 0)');
});

test('a busy usual port falls back to a free one on the same server, once; a port the writer chose, or another error, is not retried', async t => {
  const root = tempDir(t);
  const taken = await busyPort(t);
  const first = await liveCompanion(t, root);
  /* the live one above bound a free port of its own; now a second app whose usual port is the busy one */
  const calls = [];
  const service = { status: async () => ({}), listRounds: async () => [], shutdown: async () => {}, setCompanionPort: async port => { calls.push(port); } };
  const app = createServer({ root, service, port: taken, runner: { state: null, cancel() {} }, log: () => {} });
  t.after(() => app.close());
  const listeningBefore = app.server.listenerCount('listening');
  const bound = await listenWithFallback(app, { port: taken, fixed: false });
  assert.equal(bound.fellBack, true);
  assert.equal(bound.usualPort, taken);
  assert.notEqual(bound.port, taken);
  assert.notEqual(bound.port, first.port);
  assert.equal(bound.url, `http://127.0.0.1:${bound.port}`);
  assert.deepEqual(calls, [bound.port], 'the service is told the final port exactly once');
  assert.equal(app.server.listenerCount('error'), 1, 'one error logger, not one per attempt');
  assert.equal(app.server.listenerCount('listening'), listeningBefore, 'the failed attempt left no listening callback behind');
  const status = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: bound.port, path: '/api/status' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject));
  assert.equal(status, 200, 'the fallback server answers');

  /* the writer chose the port: a busy port is an error */
  const chosen = createServer({ root, service, port: taken, runner: { state: null, cancel() {} }, log: () => {} });
  await assert.rejects(listenWithFallback(chosen, { port: taken, fixed: true }), error => error.code === 'EADDRINUSE');

  /* any other failure is not turned into a fallback */
  let attempts = 0;
  const failing = { listen: async () => { attempts++; throw Object.assign(new Error('not allowed'), { code: 'EACCES' }); } };
  await assert.rejects(listenWithFallback(failing, { port: 80, fixed: false }), error => error.code === 'EACCES');
  assert.equal(attempts, 1);

  /* a free usual port is simply used */
  const free = await freePort();
  const plain = createServer({ root, service, port: free, runner: { state: null, cancel() {} }, log: () => {} });
  t.after(() => plain.close());
  const direct = await listenWithFallback(plain, { port: free, fixed: false });
  assert.equal(direct.port, free);
  assert.equal(direct.fellBack, undefined);
});

/* ====================================================================== one companion per folder: the decision */

test('findRunningCompanion: a live pid whose url answers /api/status is a running companion; a stale record is not', async t => {
  const root = tempDir(t);
  const live = await liveCompanion(t, root);
  const other = idleProcess(t);

  assert.equal(await findRunningCompanion(root), null, 'no LOCAL_SERVER.json');
  writeRecord(root, 'not json {');
  assert.equal(await findRunningCompanion(root), null, 'an unreadable record');
  writeRecord(root, '["a", "list"]');
  assert.equal(await findRunningCompanion(root), null, 'a record that is not an object');

  writeRecord(root, recordFor(live.url, other.pid));
  assert.deepEqual(await findRunningCompanion(root), { url: live.url, pid: other.pid }, 'live pid, answering url');

  /* the record of this very process is never "another companion" */
  writeRecord(root, recordFor(live.url, process.pid));
  assert.equal(await findRunningCompanion(root), null);
  assert.deepEqual(await findRunningCompanion(root, { pid: 424242 }), { url: live.url, pid: process.pid }, 'the caller\'s own pid is what is excluded');

  /* a dead pid is stale whatever answers at the url, and the url is not even asked */
  const gone = await deadPid();
  let asked = 0;
  writeRecord(root, recordFor(live.url, gone));
  assert.equal(await findRunningCompanion(root, { probe: async () => { asked++; return true; } }), null);
  assert.equal(asked, 0);

  /* a live pid whose url does not answer is stale */
  const closedPort = await freePort();
  writeRecord(root, recordFor(`http://127.0.0.1:${closedPort}`, other.pid));
  assert.equal(await findRunningCompanion(root), null, 'nothing listens there');

  /* something answers, but it is not a companion */
  const stranger = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(req.url === '/api/status' ? '{"hello":"world"}' : 'no'); });
  await new Promise(resolve => stranger.listen(0, '127.0.0.1', resolve));
  t.after(() => stranger.close());
  writeRecord(root, recordFor(`http://127.0.0.1:${stranger.address().port}`, other.pid));
  assert.equal(await findRunningCompanion(root), null, 'a status without a nonce');
  const teapot = http.createServer((req, res) => { res.statusCode = 500; res.end('{"nonce":"x"}'); });
  await new Promise(resolve => teapot.listen(0, '127.0.0.1', resolve));
  t.after(() => teapot.close());
  writeRecord(root, recordFor(`http://127.0.0.1:${teapot.address().port}`, other.pid));
  assert.equal(await findRunningCompanion(root), null, 'an error status');

  /* only an address of this machine is ever asked */
  for (const url of ['http://example.com:80', 'https://127.0.0.1:1', 'http://10.255.255.1:9', 'file:///etc/passwd', 'nonsense', '']) {
    writeRecord(root, recordFor(url, other.pid));
    assert.equal(await findRunningCompanion(root, { probe: async () => { throw new Error('must not be asked: ' + url); } }), null, url);
  }
  writeRecord(root, recordFor('http://10.255.255.1:9', other.pid));
  assert.equal(await findRunningCompanion(root), null, 'a remote address is not asked at all');

  /* a pid that is not a whole number */
  for (const pid of ['123', 0, -5, 1.5, null, undefined]) {
    writeRecord(root, recordFor(live.url, pid));
    assert.equal(await findRunningCompanion(root), null, String(pid));
  }
});

test('findRunningCompanion gives up on a companion that accepts the connection but does not answer within the time allowed', async t => {
  const root = tempDir(t);
  const other = idleProcess(t);
  const sockets = new Set();
  const silent = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); });
  await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); silent.close(); });
  writeRecord(root, recordFor(`http://127.0.0.1:${silent.address().port}`, other.pid));
  const started = Date.now();
  assert.equal(await findRunningCompanion(root, { timeoutMs: 200 }), null);
  const took = Date.now() - started;
  assert.ok(took >= 150 && took < 1400, `the wait was ${took} ms`);
});

test('pidAlive: signal 0 succeeding or failing with EPERM means the process exists', t => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive(1.5), false);
  assert.equal(pidAlive('1'), false);
  t.mock.method(process, 'kill', pid => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM', pid }); });
  assert.equal(pidAlive(4242), true, 'EPERM: it exists but belongs to someone else');
  process.kill.mock.restore();
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); });
  assert.equal(pidAlive(4242), false);
});

/* ====================================================================== runCompanion in this process */

function companionEnv(root, extra = {}) {
  return { ...cleanEnv(), CLAUDE_BIN: STUB, TMPDIR: path.join(root, 'tmp'), FINANCE_STUB_SCENARIO: '{}', ...extra };
}

test('runCompanion answers "already running" and starts nothing when a live companion serves the folder', async t => {
  const root = tempDir(t);
  const live = await liveCompanion(t, root);
  const other = idleProcess(t);
  writeRecord(root, recordFor(live.url, other.pid));
  const before = fs.readFileSync(path.join(root, 'LOCAL_SERVER.json'), 'utf8');
  const lines = [];
  const opened = [];
  const proc = new EventEmitter();
  const createService = () => { throw new Error('the agent service must not be created: it would recover the rounds of the running companion'); };

  const quiet = await runCompanion([], companionEnv(root), { root, log: line => lines.push(line), openUrl: url => opened.push(url), createService, proc, exit: () => { throw new Error('no exit'); } });
  assert.deepEqual(quiet, { alreadyRunning: true, url: live.url });
  assert.deepEqual(lines, [`Finance Task Studio is already running at ${live.url}`]);
  assert.deepEqual(opened, [], 'without --open nothing is opened');

  const withOpen = await runCompanion(['--open'], companionEnv(root), { root, log: line => lines.push(line), openUrl: url => opened.push(url), createService, proc });
  assert.equal(withOpen.alreadyRunning, true);
  assert.equal(lines[1], `Finance Task Studio is already running at ${live.url}`);
  assert.deepEqual(opened, [live.url], 'with --open the running companion\'s page is opened');

  assert.equal(proc.eventNames().length, 0, 'no signal handler was installed');
  assert.equal(fs.readFileSync(path.join(root, 'LOCAL_SERVER.json'), 'utf8'), before, 'the running companion\'s record is left alone');
  assert.equal(live.calls.includes('killPilots'), false);
});

test('runCompanion with a stale record starts as usual, overwrites the record, prints the keep-open line, and SIGHUP removes the record', async t => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, 'tmp'));
  writeRecord(root, recordFor('http://127.0.0.1:9', await deadPid()));
  const lines = [];
  const opened = [];
  const exits = [];
  const proc = new EventEmitter();
  const started = await runCompanion(['--open'], companionEnv(root, { FINANCE_STUDIO_PORT: '0' }), { root, log: line => lines.push(line), openUrl: url => opened.push(url), proc, exit: code => exits.push(code) });
  assert.equal(started.alreadyRunning, undefined);
  t.after(() => started.app.close());

  assert.match(lines[0], /^Finance Task Studio: http:\/\/127\.0\.0\.1:\d+ \(no private evidence module found; viewer only\)$/);
  assert.equal(lines[0].split(' ')[3], started.url);
  assert.ok(lines.some(line => line.startsWith('Pilot sign-in: ')));
  assert.equal(lines[lines.length - 1], KEEP_OPEN_LINE);
  assert.equal(KEEP_OPEN_LINE, 'Keep this window open while a round runs; closing it stops the companion and its pilots.');
  assert.equal(lines.filter(line => line.includes('is busy')).length, 0);
  assert.deepEqual(opened, [started.url]);
  assert.deepEqual(readRecord(root), { url: started.url, pid: process.pid, startedAt: readRecord(root).startedAt, modelCallsOnLaunch: 0 });
  assert.deepEqual(await findRunningCompanion(root, { pid: 424242 }), { url: started.url, pid: process.pid }, 'and it now answers as a running companion');

  /* the Terminal window closes: the same path as SIGTERM, and the record goes */
  assert.equal(proc.listenerCount('SIGHUP'), 1);
  proc.emit('SIGHUP');
  await waitFor(() => exits.length, { label: 'the shutdown to finish' });
  assert.deepEqual(exits, [0]);
  assert.equal(fs.existsSync(path.join(root, 'LOCAL_SERVER.json')), false, 'LOCAL_SERVER.json is removed on a graceful shutdown');
});

test('the record is removed only while it still records this pid', async t => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, 'tmp'));
  const exits = [];
  const proc = new EventEmitter();
  const started = await runCompanion([], companionEnv(root, { FINANCE_STUDIO_PORT: '0' }), { root, log: () => {}, proc, exit: code => exits.push(code) });
  t.after(() => started.app.close());
  writeRecord(root, recordFor('http://127.0.0.1:9', process.pid + 1000000));
  proc.emit('SIGTERM');
  await waitFor(() => exits.length, { label: 'the shutdown to finish' });
  assert.equal(readRecord(root).pid, process.pid + 1000000, 'a record of another companion stays');

  assert.equal(removeLocalServerRecord(root, 5), false);
  assert.equal(removeLocalServerRecord(root, process.pid + 1000000), true);
  assert.equal(fs.existsSync(path.join(root, 'LOCAL_SERVER.json')), false);
  assert.equal(removeLocalServerRecord(root, process.pid), false, 'nothing to remove');
});

test('runCompanion without FINANCE_STUDIO_PORT uses the usual port, and prints one line when it is busy and takes another', async t => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, 'tmp'));

  /* the usual port is free: it is used */
  const usual = await freePort();
  const lines = [];
  const proc = new EventEmitter();
  const calm = await runCompanion([], companionEnv(root), { root, usualPort: usual, log: line => lines.push(line), proc, exit: () => {} });
  t.after(() => calm.app.close());
  assert.equal(calm.url, `http://127.0.0.1:${usual}`);
  assert.equal(lines.filter(line => line.includes('busy')).length, 0);
  await calm.app.close();
  removeLocalServerRecord(root);

  /* the usual port is busy: another one, and one line that says why */
  const taken = await busyPort(t);
  const busyLines = [];
  const busy = await runCompanion([], companionEnv(root), { root, usualPort: taken, log: line => busyLines.push(line), proc: new EventEmitter(), exit: () => {} });
  t.after(() => busy.app.close());
  assert.notEqual(busy.url, `http://127.0.0.1:${taken}`);
  const notes = busyLines.filter(line => line.includes('busy'));
  assert.equal(notes.length, 1);
  assert.match(notes[0], new RegExp(`The usual port ${taken} is busy`));
  assert.match(notes[0], /Work saved in the browser by earlier sessions/);
  assert.match(notes[0], /will not show/);
  assert.equal(readRecord(root).url, busy.url, 'the record names the address in use');
  await busy.app.close();
  removeLocalServerRecord(root);

  /* a port the writer chose that is busy stays an error */
  await assert.rejects(runCompanion([], companionEnv(root, { FINANCE_STUDIO_PORT: String(taken) }), { root, log: () => {}, proc: new EventEmitter(), exit: () => {} }), error => error.code === 'EADDRINUSE');
});

/* ====================================================================== signals */

test('SIGINT, SIGTERM, SIGHUP and SIGQUIT each run the shutdown once, then exit 0; a second signal exits at once with 128 plus its number', async () => {
  const expectedSecond = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGQUIT: 131 };
  for (const [signal, secondCode] of Object.entries(expectedSecond)) {
    const events = [];
    let release;
    const app = { shutdown: () => { events.push('shutdown'); return new Promise(resolve => { release = resolve; }); } };
    const proc = new EventEmitter();
    const exits = [];
    installSignalHandlers(app, { proc, exit: code => { events.push('exit ' + code); exits.push(code); }, log: () => {}, forceAfterMs: 60000, cleanup: () => events.push('cleanup') });
    for (const name of Object.keys(expectedSecond)) assert.equal(proc.listenerCount(name), 1, `${signal} run: a handler for ${name}`);
    proc.emit(signal);
    assert.deepEqual(events, ['shutdown'], signal + ' starts the shutdown');
    proc.emit(signal);
    assert.deepEqual(exits, [secondCode], signal + ' again exits at once');
    release();
    await sleep(10);
    assert.deepEqual(events, ['shutdown', 'exit ' + secondCode, 'cleanup', 'exit 0'], signal + ': cleanup runs before the exit that follows the shutdown');
  }

  /* all four reach exactly the same shutdown as SIGTERM */
  for (const signal of ['SIGHUP', 'SIGQUIT']) {
    let shutdowns = 0;
    const exits = [];
    const proc = new EventEmitter();
    installSignalHandlers({ shutdown: async () => { shutdowns++; } }, { proc, exit: code => exits.push(code), forceAfterMs: 60000 });
    proc.emit(signal);
    await sleep(10);
    assert.equal(shutdowns, 1);
    assert.deepEqual(exits, [0]);
  }
});

test('a cleanup that throws, or a shutdown that fails, still ends in exit 0; a stuck shutdown is cut off with exit 1', async () => {
  const messages = [];
  const proc = new EventEmitter();
  const exits = [];
  installSignalHandlers({ shutdown: () => Promise.reject(new Error('could not stop')) }, { proc, exit: code => exits.push(code), log: message => messages.push(message), forceAfterMs: 60000, cleanup: () => { throw new Error('record is locked'); } });
  proc.emit('SIGHUP');
  await sleep(10);
  assert.deepEqual(exits, [0]);
  assert.ok(messages.some(message => message.includes('could not stop')));

  const stuck = new EventEmitter();
  const stuckExits = [];
  installSignalHandlers({ shutdown: () => new Promise(() => {}) }, { proc: stuck, exit: code => stuckExits.push(code), forceAfterMs: 30 });
  stuck.emit('SIGHUP');
  await sleep(120);
  assert.deepEqual(stuckExits, [1]);
});

test('the process exit hook kills the pilots (synchronously) and cleans up, whatever ended the process; it copes with an app that cannot kill pilots', () => {
  const events = [];
  const proc = new EventEmitter();
  installSignalHandlers({ shutdown: async () => {}, killPilots: () => events.push('killPilots') }, { proc, exit: () => {}, cleanup: () => events.push('cleanup') });
  assert.equal(proc.listenerCount('exit'), 1);
  proc.emit('exit', 1);
  assert.deepEqual(events, ['killPilots', 'cleanup']);

  const plain = new EventEmitter();
  installSignalHandlers({ shutdown: async () => {} }, { proc: plain, exit: () => {} });
  assert.doesNotThrow(() => plain.emit('exit', 0));

  /* a failing kill must not stop the cleanup, and a failing cleanup must not throw out of the exit hook */
  const failing = new EventEmitter();
  const after = [];
  installSignalHandlers({ shutdown: async () => {}, killPilots: () => { throw new Error('no such process'); } }, { proc: failing, exit: () => {}, cleanup: () => { after.push('cleanup'); throw new Error('locked'); } });
  assert.doesNotThrow(() => failing.emit('exit', 1));
  assert.deepEqual(after, ['cleanup']);
});

test('createServer.killPilots hands the kill to the service, and does nothing when the service has none', async t => {
  const root = tempDir(t);
  const calls = [];
  const withKill = createServer({ root, service: { status: async () => ({}), killPilots: () => calls.push('killed') }, runner: { state: null, cancel() {} }, log: () => {} });
  withKill.killPilots();
  assert.deepEqual(calls, ['killed']);
  const without = createServer({ root, service: { status: async () => ({}) }, runner: { state: null, cancel() {} }, log: () => {} });
  assert.doesNotThrow(() => without.killPilots());
});

/* ====================================================================== a synthetic world with the stub as the runtime */

function makeWorld(t, scenario = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-lifecycle-world-'));
  const projectRoot = path.join(base, 'project');
  const source = path.join(base, 'source');
  const tmpRoot = path.join(base, 'tmp');
  fs.mkdirSync(path.join(projectRoot, 'private'), { recursive: true });
  fs.mkdirSync(source);
  fs.mkdirSync(tmpRoot);
  fs.writeFileSync(path.join(source, 'Facility_Terms.txt'), 'Atlas facility terms, synthetic. Available credit is not cash received.\n');
  const env = { ...cleanEnv(), FINANCE_STUB_SCENARIO: JSON.stringify(scenario) };
  const services = [];
  const make = (extra = {}) => {
    const service = createAgentService({ root: projectRoot, env, claudeBin: STUB, tmpRoot, ...extra });
    services.push(service);
    return service;
  };
  const world = { base, projectRoot, source, tmpRoot, env, make, service: make(), pids: new Set(), roundsDir: path.join(projectRoot, 'private', 'agent-rounds') };
  t.after(async () => {
    for (const pid of world.pids) killTree(pid);
    for (const service of services) await service.shutdown();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return world;
}

const roundBody = w => ({ label: 'synthetic round', sourceDir: w.source, promptText: PROMPT, gafVisible: true, config: { model: 'claude-opus-5-5', effort: 'medium', count: 1 } });
const roundFile = (w, id) => path.join(w.roundsDir, id, 'round.json');
const runFile = (w, id) => path.join(w.roundsDir, id, 'runs', '1', 'run.json');

async function approvedRound(w, service = w.service) {
  const round = await service.createRound(roundBody(w));
  await service.freezeRound(round.id, GOLD);
  const { summarySha256 } = await service.approvalSummary(round.id);
  await service.approveRound(round.id, { summarySha256, acknowledgements: ACK });
  return round.id;
}

/* The run record on disk once the pilot is recorded in it (null before). */
function pilotOnDisk(w, id) {
  try {
    const run = readJson(runFile(w, id));
    return run.pilot ? run : null;
  } catch {
    return null;
  }
}

/* ====================================================================== the pilot's pid on disk */

test('a launched pilot is on disk with its pid, group and spawn time while it runs, and not in any view; the record is gone when it ends', async t => {
  const w = makeWorld(t, { hang: true });
  const id = await approvedRound(w);
  await w.service.launchRound(id);
  const run = await waitFor(() => pilotOnDisk(w, id), { label: 'the pilot to be recorded' });
  const { pilot } = run;
  w.pids.add(pilot.pid);

  assert.ok(Number.isInteger(pilot.pid) && pilot.pid > 1);
  assert.equal(pilot.group, true, 'the runner starts a real child in its own process group');
  assert.equal(pilot.bin, STUB, 'the runtime binary the round started');
  assert.ok(Date.parse(pilot.spawnedAt) >= Date.parse(run.startedAt), 'spawned after the run started');
  assert.ok(Date.now() - Date.parse(pilot.spawnedAt) < 60000);
  assert.deepEqual(Object.keys(pilot).sort(), ['bin', 'group', 'pid', 'spawnedAt']);
  assert.equal(running(pilot.pid), true);
  assert.equal(groupOf(pilot.pid), pilot.pid, 'the pid is its process group id');
  assert.ok(commandOf(pilot.pid).includes('stub-claude.cjs'));
  assert.deepEqual(readJson(roundFile(w, id)).runs[0].pilot, pilot, 'round.json carries it too');

  const detail = await w.service.getRun(id, 1);
  assert.equal('pilot' in detail, false, 'not in the run detail');
  assert.equal('pilot' in (await w.service.getRound(id)).runs[0], false, 'not in the round view');
  assert.equal((await w.service.listRuns({ limit: 10 })).some(row => 'pilot' in row), false, 'not in the run feed');

  await w.service.cancelRound(id);
  await w.service.whenSettled(id);
  assert.equal('pilot' in readJson(runFile(w, id)), false, 'run.json after the run ended');
  assert.equal('pilot' in readJson(roundFile(w, id)).runs[0], false, 'round.json after the run ended');
  await waitFor(() => !running(pilot.pid), { label: 'the pilot to stop' });
});

test('service.killPilots sends SIGKILL to the process group of a running pilot at once, and the round still settles', async t => {
  const w = makeWorld(t, { hang: true });
  const id = await approvedRound(w);
  await w.service.launchRound(id);
  const { pilot } = await waitFor(() => pilotOnDisk(w, id), { label: 'the pilot to be recorded' });
  w.pids.add(pilot.pid);
  assert.equal(running(pilot.pid), true);
  w.service.killPilots();
  await waitFor(() => !running(pilot.pid), { label: 'the pilot to be killed' });
  await w.service.whenSettled(id);
  const run = readJson(runFile(w, id));
  assert.equal(run.state, 'failed');
  assert.equal(run.signal, 'SIGKILL');
});

test('RoundStore.killPilotsNow signals the group of every live pilot and every tool-less runner, and only a real pid', t => {
  const w = makeWorld(t);
  const store = new RoundStore({ root: w.projectRoot, claudeBin: STUB, tmpRoot: w.tmpRoot, env: w.env });
  store.live.set('rnd-aaaaaaaaaaaa', { runners: new Map([[1, { pid: 4242, useGroup: true }], [2, { pid: 4243, useGroup: false }], [3, { pid: null, useGroup: true }], [4, { pid: 1, useGroup: true }], [5, { pid: 0, useGroup: true }]]) });
  store.live.set('rnd-bbbbbbbbbbbb', { runners: new Map([[1, { pid: 4245, useGroup: true }]]) });
  store.graderRunners.add({ pid: 4244, useGroup: true });
  const kill = t.mock.method(process, 'kill', () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); });
  assert.doesNotThrow(() => store.killPilotsNow(), 'a process that is already gone is not an error');
  const calls = kill.mock.calls.map(call => call.arguments);
  kill.mock.restore();
  assert.deepEqual(calls, [[-4244, 'SIGKILL'], [-4242, 'SIGKILL'], [4243, 'SIGKILL'], [-4245, 'SIGKILL']]);
});

/* ====================================================================== leftover pilots at the next start */

test('_stopLeftoverPilot never signals a pid it cannot vouch for', t => {
  const w = makeWorld(t);
  const store = new RoundStore({ root: w.projectRoot, claudeBin: STUB, tmpRoot: w.tmpRoot, env: w.env });
  const kill = t.mock.method(process, 'kill', () => {});
  const asked = [];
  store._processInfo = pid => { asked.push(pid); return { pgid: pid, command: `node ${STUB} -p x` }; };
  const sent = () => kill.mock.calls.map(call => call.arguments);
  const good = { pid: 4242, group: true, spawnedAt: '2026-01-01T00:00:00.000Z', bin: STUB };

  for (const pilot of [undefined, null, 'x', {}, { ...good, pid: 1 }, { ...good, pid: 0 }, { ...good, pid: -4242 }, { ...good, pid: '4242' }, { ...good, pid: 42.5 }, { ...good, pid: process.pid }, { ...good, bin: undefined }, { ...good, bin: '' }, { ...good, bin: '/' }, { ...good, bin: 7 }]) {
    assert.equal(store._stopLeftoverPilot(pilot), false, JSON.stringify(pilot));
  }
  assert.deepEqual(asked, [], 'those records never reach ps');
  assert.deepEqual(sent(), []);

  store._processInfo = () => null;
  assert.equal(store._stopLeftoverPilot(good), false, 'not running (or no ps)');
  store._processInfo = pid => ({ pgid: pid, command: 'sleep 300' });
  assert.equal(store._stopLeftoverPilot(good), false, 'an unrelated program has the pid now');
  store._processInfo = pid => ({ pgid: pid + 1, command: `node ${STUB} -p x` });
  assert.equal(store._stopLeftoverPilot(good), false, 'the name matches but it does not lead a group of its own');
  assert.deepEqual(sent(), []);

  store._processInfo = pid => ({ pgid: pid, command: `node ${STUB} -p x` });
  assert.equal(store._stopLeftoverPilot(good), true);
  assert.deepEqual(sent(), [[-4242, 'SIGKILL']], 'the whole group');
  store._processInfo = () => ({ pgid: 7, command: `node ${STUB} -p x` });
  assert.equal(store._stopLeftoverPilot({ ...good, group: false }), true);
  assert.deepEqual(sent().slice(1), [[4242, 'SIGKILL']], 'a pilot that was not started as a group leader is signalled alone');
  kill.mock.restore();

  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); });
  store._processInfo = pid => ({ pgid: pid, command: `node ${STUB} -p x` });
  assert.equal(store._stopLeftoverPilot(good), false, 'a signal that fails is not claimed as a stop');
});

/* A finished round turned into the state a crash leaves: running, with a run that was running and the given pilot record. */
async function roundLeftRunning(w, pilot) {
  const id = await approvedRound(w);
  await w.service.launchRound(id);
  await w.service.whenSettled(id);
  const round = readJson(roundFile(w, id));
  round.status = 'running';
  round.endedAt = null;
  const run = round.runs[0];
  Object.assign(run, { state: 'running', endedAt: null, exitCode: null, failureReason: null, stderrTail: '' });
  if (pilot) run.pilot = pilot;
  else delete run.pilot;
  fs.writeFileSync(roundFile(w, id), JSON.stringify(round));
  fs.writeFileSync(runFile(w, id), JSON.stringify(run));
  return id;
}

function interruptedOnDisk(w, id) {
  const round = readJson(roundFile(w, id));
  const run = round.runs[0];
  assert.equal(run.state, 'failed');
  assert.equal(run.failureReason, 'interrupted');
  assert.ok(run.endedAt);
  assert.equal(round.status, 'failed');
  assert.equal(round.note, 'The companion stopped while this round was running.');
  assert.equal('pilot' in run, false, 'the pid is not kept once it has been dealt with');
  assert.equal('pilot' in readJson(runFile(w, id)), false);
  return run;
}

test('at startup a still-running pilot of a dead companion is stopped (its whole group) and the run says so', async t => {
  const w = makeWorld(t);
  const leftover = leftoverStub(t, tempDir(t));
  w.pids.add(leftover.pid);
  await waitFor(() => commandOf(leftover.pid).includes('stub-claude.cjs'), { label: 'the leftover pilot to be up' });
  assert.equal(groupOf(leftover.pid), leftover.pid);
  const id = await roundLeftRunning(w, { pid: leftover.pid, group: true, spawnedAt: new Date().toISOString(), bin: STUB });

  const second = w.make();
  const ended = await Promise.race([endOf(leftover), sleep(10000).then(() => 'still running')]);
  assert.equal(ended.signal, 'SIGKILL', 'the leftover pilot was killed');
  assert.equal(running(leftover.pid), false);

  const run = interruptedOnDisk(w, id);
  assert.equal(run.stderrTail, INTERRUPTED_NOTE + '\n' + LEFTOVER_NOTE);
  const view = await second.getRun(id, 1);
  assert.ok(view.stderrTail.endsWith(LEFTOVER_NOTE));
  assert.equal(view.failureReason, 'interrupted');
  assert.equal((await second.getRound(id)).status, 'failed');
});

test('at startup an unrelated live process that has the recorded pid is left alone, with the usual interrupted note only', async t => {
  const w = makeWorld(t);
  const stranger = idleProcess(t, { detached: true });
  w.pids.add(stranger.pid);
  await waitFor(() => commandOf(stranger.pid).includes('setInterval'), { label: 'the other process to be up' });
  assert.equal(groupOf(stranger.pid), stranger.pid, 'it even leads its own group, like a pilot');
  const id = await roundLeftRunning(w, { pid: stranger.pid, group: true, spawnedAt: new Date().toISOString(), bin: STUB });

  w.make();
  const run = interruptedOnDisk(w, id);
  assert.equal(run.stderrTail, INTERRUPTED_NOTE);
  await sleep(300);
  assert.equal(stranger.exitCode, null);
  assert.equal(stranger.signalCode, null);
  assert.equal(running(stranger.pid), true, 'still running');
});

test('at startup a process whose command line names the runtime but that does not lead its own group is left alone', async t => {
  const w = makeWorld(t);
  const lookalike = idleProcess(t, { extraArgs: ['stub-claude.cjs'] }); /* same process group as this test */
  w.pids.add(lookalike.pid);
  await waitFor(() => commandOf(lookalike.pid).includes('stub-claude.cjs'), { label: 'the look-alike to be up' });
  assert.notEqual(groupOf(lookalike.pid), lookalike.pid);
  const id = await roundLeftRunning(w, { pid: lookalike.pid, group: true, spawnedAt: new Date().toISOString(), bin: STUB });

  w.make();
  assert.equal(interruptedOnDisk(w, id).stderrTail, INTERRUPTED_NOTE);
  await sleep(300);
  assert.equal(lookalike.signalCode, null);
  assert.equal(running(lookalike.pid), true);
});

test('at startup a pilot record whose process has ended, and a round with no pilot record, only get the interrupted handling', async t => {
  const w = makeWorld(t);
  const gone = await deadPid();
  const withDead = await roundLeftRunning(w, { pid: gone, group: true, spawnedAt: new Date().toISOString(), bin: STUB });
  const withoutPilot = await roundLeftRunning(w, null);
  const second = w.make();
  assert.equal(interruptedOnDisk(w, withDead).stderrTail, INTERRUPTED_NOTE);
  assert.equal(interruptedOnDisk(w, withoutPilot).stderrTail, INTERRUPTED_NOTE);
  assert.equal((await second.getRound(withDead)).runs[0].failureReason, 'interrupted');
});

/* ====================================================================== a companion that dies */

/* A companion process of its own: the real service on the stub, the real signal handlers and exit hook, one launched round
   whose pilot hangs. `mode` is how the companion then dies: 'throw' (an uncaught exception) or 'kill' (SIGKILL: no hook runs). */
const CRASHER = `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(process.env.LIFECYCLE_CONFIG);
const { createAgentService } = require(config.agents);
const { createServer, installSignalHandlers } = require(config.server);
(async () => {
  const service = createAgentService({ root: config.root, env: process.env, claudeBin: config.stub, tmpRoot: config.tmpRoot });
  const app = createServer({ root: config.root, service, port: 0, log: () => {} });
  installSignalHandlers(app);
  const round = await service.createRound(config.body);
  await service.freezeRound(round.id, config.gold);
  const { summarySha256 } = await service.approvalSummary(round.id);
  await service.approveRound(round.id, { summarySha256, acknowledgements: config.ack });
  await service.launchRound(round.id);
  const file = path.join(config.root, 'private', 'agent-rounds', round.id, 'runs', '1', 'run.json');
  const transcript = path.join(path.dirname(file), 'transcript.jsonl');
  /* The pilot is announced once it has printed its first event: after that it writes nothing more (it hangs), so a pipe that
     breaks when this process dies cannot be what ends it. */
  for (;;) {
    try {
      const run = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (run.pilot && fs.existsSync(transcript) && fs.statSync(transcript).size > 0) { console.log('PILOT ' + run.pilot.pid + ' ' + round.id); break; }
    } catch { /* not written yet */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  setTimeout(() => {
    if (config.mode === 'throw') throw new Error('simulated crash');
    process.kill(process.pid, 'SIGKILL');
  }, 50);
})();
`;

async function crashedCompanion(t, mode) {
  const w = makeWorld(t, { hang: true });
  const script = path.join(w.base, 'crasher.cjs');
  fs.writeFileSync(script, CRASHER);
  const config = { agents: path.join(REPO, 'backend', 'agents', 'index.cjs'), server: path.join(REPO, 'backend', 'server.cjs'), root: w.projectRoot, tmpRoot: w.tmpRoot, stub: STUB, body: roundBody(w), gold: GOLD, ack: ACK, mode };
  const child = childProcess.spawn(process.execPath, [script], { env: { ...w.env, LIFECYCLE_CONFIG: JSON.stringify(config) }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => killTree(child.pid));
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const found = await waitFor(() => /PILOT (\d+) (rnd-[0-9a-f]{12})/.exec(output), { label: 'the companion to start a pilot', timeout: 30000 });
  const pilot = Number(found[1]);
  w.pids.add(pilot);
  const ended = await Promise.race([endOf(child), sleep(15000).then(() => 'timed out')]);
  return { w, pilot, id: found[2], ended, output };
}

test('a companion that crashes with an uncaught exception does not leave its pilot behind (the exit hook)', async t => {
  const { w, pilot, id, ended, output } = await crashedCompanion(t, 'throw');
  assert.equal(ended.code, 1, output);
  assert.match(output, /simulated crash/);
  await waitFor(() => !running(pilot), { label: 'the pilot to be killed by the exit hook' });
  /* nothing finished the round, so the record is still the running one; the next start deals with it (no pilot is left to stop) */
  assert.equal(readJson(runFile(w, id)).state, 'running');
  w.make();
  assert.equal(interruptedOnDisk(w, id).stderrTail, INTERRUPTED_NOTE);
});

test('a companion killed with SIGKILL leaves its pilot running, and the next start stops it and closes the round', async t => {
  const { w, pilot, id, ended } = await crashedCompanion(t, 'kill');
  assert.equal(ended.signal, 'SIGKILL');
  assert.equal(running(pilot), true, 'no hook can run on SIGKILL: the pilot is an orphan now');
  assert.ok(commandOf(pilot).includes('stub-claude.cjs'));
  const recorded = readJson(runFile(w, id));
  assert.equal(recorded.state, 'running');
  assert.equal(recorded.pilot.pid, pilot);

  const next = w.make();
  await waitFor(() => !running(pilot), { label: 'the orphaned pilot to be stopped at startup' });
  const run = interruptedOnDisk(w, id);
  assert.ok(run.stderrTail.endsWith(LEFTOVER_NOTE), run.stderrTail);
  assert.equal((await next.getRound(id)).status, 'failed');
});

/* ====================================================================== the script itself */

function copyProject(base) {
  const project = path.join(base, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.cpSync(path.join(REPO, 'backend'), path.join(project, 'backend'), { recursive: true });
  for (const name of ['package-engine.js', 'index.html', 'agents.js']) fs.copyFileSync(path.join(REPO, name), path.join(project, name));
  return project;
}

/* The companion as a script (never with --open, which would start a browser on a Mac). */
function startCompanion(t, project, env = {}) {
  const base = path.dirname(project);
  const tmp = path.join(base, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const child = childProcess.spawn(process.execPath, [path.join(project, 'backend', 'server.cjs')], {
    cwd: base,
    env: { ...cleanEnv(), FINANCE_STUDIO_PORT: '0', CLAUDE_BIN: STUB, TMPDIR: tmp, FINANCE_STUB_SCENARIO: '{}', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const script = { child, output: '' };
  script.exited = endOf(child);
  child.stdout.on('data', chunk => { script.output += chunk; });
  child.stderr.on('data', chunk => { script.output += chunk; });
  t.after(() => killTree(child.pid));
  script.url = () => (/Finance Task Studio: (http:\/\/127\.0\.0\.1:\d+)/.exec(script.output) || [])[1];
  return script;
}

const exitOf = (script, ms = 30000) => Promise.race([script.exited, sleep(ms).then(() => 'timed out')]);

test('run as a script: a second start for the same folder says it is already running and exits 0; SIGHUP, SIGQUIT and SIGKILL then leave the folder free to start again', async t => {
  const base = tempDir(t, 'finance-lifecycle-script-');
  const project = copyProject(base);
  const recordPath = path.join(project, 'LOCAL_SERVER.json');

  const first = startCompanion(t, project);
  const url = await waitFor(() => first.url(), { label: 'the first companion to print its address' });
  await waitFor(() => first.output.includes(KEEP_OPEN_LINE), { label: 'the keep-open line' });
  const record = readJson(recordPath);
  assert.equal(record.pid, first.child.pid);

  const second = startCompanion(t, project);
  assert.deepEqual(await exitOf(second), { code: 0, signal: null }, second.output);
  assert.equal(second.output.trim(), `Finance Task Studio is already running at ${url}`);
  assert.deepEqual(readJson(recordPath), record, 'the first companion\'s record is untouched');
  assert.deepEqual(await findRunningCompanion(project, { pid: second.child.pid }), { url, pid: first.child.pid }, 'and it still answers');

  /* the Terminal window is closed: SIGHUP is a graceful shutdown that removes the record */
  first.child.kill('SIGHUP');
  assert.deepEqual(await exitOf(first), { code: 0, signal: null }, first.output);
  assert.equal(fs.existsSync(recordPath), false);

  /* a companion that dies without a chance to clean up leaves a stale record, which the next start overwrites */
  const third = startCompanion(t, project);
  await waitFor(() => third.url(), { label: 'the third companion to print its address' });
  third.child.kill('SIGKILL');
  assert.deepEqual(await exitOf(third), { code: null, signal: 'SIGKILL' });
  assert.equal(readJson(recordPath).pid, third.child.pid, 'stale: the pid is dead');

  const fourth = startCompanion(t, project);
  const fourthUrl = await waitFor(() => fourth.url(), { label: 'the fourth companion to print its address' });
  assert.doesNotMatch(fourth.output, /already running/);
  assert.equal(readJson(recordPath).pid, fourth.child.pid);
  assert.equal(readJson(recordPath).url, fourthUrl);

  /* SIGQUIT is handled the same way */
  fourth.child.kill('SIGQUIT');
  assert.deepEqual(await exitOf(fourth), { code: 0, signal: null }, fourth.output);
  assert.equal(fs.existsSync(recordPath), false);
});

test('run as a script without FINANCE_STUDIO_PORT it takes port 47321 when that is free, and otherwise another port with one line saying why', async t => {
  const free = await new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(DEFAULT_PORT, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
  const base = tempDir(t, 'finance-lifecycle-port-');
  const project = copyProject(base);
  const env = { FINANCE_STUDIO_PORT: undefined };
  const script = startCompanion(t, project, env);
  const url = await waitFor(() => script.url(), { label: 'the companion to print its address' });
  await waitFor(() => script.output.includes(KEEP_OPEN_LINE), { label: 'the keep-open line, the last of the start-up lines' });
  /* Either the usual port or, with one line saying why, another one. When the port was free a moment ago the first is what
     happens, unless something else took it in between (a second copy of this test file running at the same time). */
  const notes = script.output.split('\n').filter(line => line.includes('The usual port 47321 is busy'));
  if (url === 'http://127.0.0.1:47321') {
    assert.equal(notes.length, 0, script.output);
    assert.doesNotMatch(script.output, /is busy/);
  } else {
    assert.equal(notes.length, 1, script.output);
    assert.match(notes[0], /Work saved in the browser by earlier sessions/);
  }
  if (free && url !== 'http://127.0.0.1:47321') t.diagnostic('port 47321 was taken by another process between the check and the start');
  script.child.kill('SIGTERM');
  assert.deepEqual(await exitOf(script), { code: 0, signal: null }, script.output);
});
