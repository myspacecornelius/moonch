'use strict';
/* Tests for the companion's lifecycle: one companion per folder (LOCAL_SERVER.json), SIGHUP and SIGQUIT, the process 'exit'
   hook that stops pilots after a crash, the pilot pid on disk and the stop of a pilot an earlier companion left running at
   the next start, and the fixed default port with its fallback.
   Pilots are the stub (backend/agents/stub-claude.cjs): no model is started and nothing leaves this machine. Processes are
   real children of this test and are killed afterwards. Fixtures are synthetic and live in temporary folders. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { cleanEnv } = require('./fixtures/clean-env.cjs');

const server = require('../backend/server.cjs');
const { createServer, installSignalHandlers, findRunningCompanion, claimFolder, releaseFolder, portChoice, listenWithFallback, runCompanion, removeLocalServerRecord, pidAlive, DEFAULT_PORT, KEEP_OPEN_LINE } = server;
const { createAgentService } = require('../backend/agents/index.cjs');
const { RoundStore, PILOT_PROMPT_PREFIX } = require('../backend/agents/rounds.cjs');
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

/* A real companion HTTP layer on a free port with a stand-in agent service (`overrides` replaces parts of the service). */
async function liveCompanion(t, root, overrides = {}) {
  const calls = [];
  const service = {
    status: async () => ({}),
    listRounds: async () => [],
    shutdown: async () => {},
    setCompanionPort: async port => { calls.push(port); },
    killPilots: () => { calls.push('killPilots'); },
    ...overrides,
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

/* A listener that accepts connections and never answers: a companion that is busy, as far as a caller can tell. */
async function silentServer(t) {
  const sockets = new Set();
  const silent = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); });
  await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); silent.close(); });
  return { port: silent.address().port, url: `http://127.0.0.1:${silent.address().port}` };
}

/* A plain HTTP server on a free port; `seen` collects the request urls. */
async function plainServer(t, handler) {
  const seen = [];
  const plain = http.createServer((req, res) => { seen.push(req.url); handler(req, res); });
  await new Promise(resolve => plain.listen(0, '127.0.0.1', resolve));
  t.after(() => plain.close());
  return { seen, url: `http://127.0.0.1:${plain.address().port}` };
}

/* GET with a time limit: resolves { status, json } or { timedOut: true }. */
function getWithin(port, urlPath, ms) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, agent: false }, res => {
      const parts = [];
      res.on('data', part => parts.push(part));
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(parts).toString('utf8')) }); });
    });
    req.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    const timer = setTimeout(() => { req.destroy(); resolve({ timedOut: true }); }, ms);
  });
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

const SELF = 424242; /* a pid for "the process that is asking", so that the pid of this test process can be a companion's */
const LOCK = root => path.join(root, 'LOCAL_SERVER.lock');

test('findRunningCompanion: no record, a dead pid, a refused connection and a companion with another pid are stale; the recorded companion is running', async t => {
  const root = tempDir(t);
  const live = await liveCompanion(t, root); /* answers { companion, pid: <this test process> } */
  const other = idleProcess(t);

  assert.equal(await findRunningCompanion(root), null, 'no LOCAL_SERVER.json');
  writeRecord(root, 'not json {');
  assert.equal(await findRunningCompanion(root), null, 'an unreadable record');
  writeRecord(root, '["a", "list"]');
  assert.equal(await findRunningCompanion(root), null, 'a record that is not an object');

  /* the url reports the pid the record names: running */
  writeRecord(root, recordFor(live.url, process.pid));
  assert.deepEqual(await findRunningCompanion(root, { pid: SELF }), { status: 'running', url: live.url, pid: process.pid });
  assert.equal(await findRunningCompanion(root), null, 'the asking process\'s own pid is never another companion');

  /* the url answers as a companion, with another pid: the recorded pid is something else now */
  writeRecord(root, recordFor(live.url, other.pid));
  assert.equal(await findRunningCompanion(root), null);

  /* a dead pid is stale whatever answers at the url, and the url is not asked */
  const gone = await deadPid();
  let asked = 0;
  writeRecord(root, recordFor(live.url, gone));
  assert.equal(await findRunningCompanion(root, { probe: async () => { asked++; return { kind: 'companion', pid: gone }; } }), null);
  assert.equal(asked, 0);

  /* a live pid whose url refuses the connection is stale */
  const closedPort = await freePort();
  writeRecord(root, recordFor(`http://127.0.0.1:${closedPort}`, other.pid));
  assert.equal(await findRunningCompanion(root), null, 'nothing listens there');
  assert.equal(await findRunningCompanion(root, { probe: async () => ({ kind: 'refused' }) }), null);

  /* a pid that is not a whole number cannot be checked at all */
  for (const pid of ['123', 0, -5, 1.5, null, undefined]) {
    writeRecord(root, recordFor(live.url, pid));
    assert.equal(await findRunningCompanion(root), null, String(pid));
  }
});

test('findRunningCompanion: a live pid whose url is slow, resets, answers with an error or is not a companion is NOT stale; it is unclear, and says why', async t => {
  const root = tempDir(t);
  const other = idleProcess(t);
  const json = text => (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(text); };
  const stranger = await plainServer(t, json('{"hello":"world"}'));
  const beforePid = await plainServer(t, json('{"nonce":"abc","connection":"local-sdk-adapter"}')); /* a companion from before the status carried pid */
  const teapot = await plainServer(t, (req, res) => { res.statusCode = 500; res.end(`{"companion":"finance-task-studio","pid":${other.pid}}`); });
  const html = await plainServer(t, (req, res) => res.end('<html></html>'));
  const resetter = net.createServer(socket => socket.destroy());
  await new Promise(resolve => resetter.listen(0, '127.0.0.1', resolve));
  t.after(() => resetter.close());
  const silent = await silentServer(t);

  const cases = [
    [stranger.url, /not a companion that says its process id/],
    [beforePid.url, /not a companion that says its process id/],
    [teapot.url, /status 500/],
    [html.url, /not a companion/],
    [`http://127.0.0.1:${resetter.address().port}`, /connection failed \(ECONNRESET\)/],
    [silent.url, /did not answer within 0\.2 seconds/],
  ];
  for (const [url, pattern] of cases) {
    writeRecord(root, recordFor(url, other.pid));
    const started = Date.now();
    const found = await findRunningCompanion(root, { timeoutMs: 200 });
    assert.ok(found, url);
    assert.equal(found.status, 'unclear', url);
    assert.equal(found.url, url);
    assert.equal(found.pid, other.pid);
    assert.match(found.detail, pattern, url);
    if (url === silent.url) assert.ok(Date.now() - started >= 150 && Date.now() - started < 1400, 'it waited for the time allowed and no longer');
  }
  assert.deepEqual(stranger.seen, ['/api/status?probe=1'], 'the cheap probe is what is asked');

  /* an address that is not http on this machine is never asked, and is unclear, not stale */
  for (const [url, pattern] of [['http://example.com:80', /not an address of this machine/], ['https://127.0.0.1:1', /not an address of this machine/], ['http://10.255.255.1:9', /not an address of this machine/], ['file:///etc/passwd', /not usable/], ['nonsense', /not usable/], ['', /not usable/]]) {
    writeRecord(root, recordFor(url, other.pid));
    const found = await findRunningCompanion(root);
    assert.equal(found && found.status, 'unclear', url);
    assert.match(found.detail, pattern, url);
    let origin = null;
    try { origin = new URL(url).origin; } catch { /* not an address */ }
    assert.equal(found.url, origin === 'null' ? null : origin, 'the address is echoed only as a parsed origin, never as the raw text');
  }
  writeRecord(root, { pid: other.pid });
  assert.equal((await findRunningCompanion(root)).status, 'unclear', 'no address in the record');

  /* a check that fails, or says nothing, is unclear too */
  writeRecord(root, recordFor(stranger.url, other.pid));
  assert.match((await findRunningCompanion(root, { probe: async () => { throw new Error('boom'); } })).detail, /the check failed \(boom\)/);
  assert.equal((await findRunningCompanion(root, { probe: async () => undefined })).status, 'unclear');
});

test('GET /api/status?probe=1 answers { companion, pid } at once while the full status waits for runtime detection (claude --version); the full status carries pid', async t => {
  const root = tempDir(t);
  /* a runtime whose --version never returns: detectClaude waits for it, as it does for a claude that hangs */
  const service = createAgentService({ root, env: { ...cleanEnv(), FINANCE_STUB_SCENARIO: '{}' }, claudeBin: STUB, tmpRoot: root, execFile: () => new Promise(() => {}) });
  const slow = createServer({ root, service, port: 0, runner: { state: null, cancel() {} }, log: () => {} });
  const { port } = await slow.listen();
  t.after(() => slow.close());

  const started = Date.now();
  const probe = await getWithin(port, '/api/status?probe=1', 3000);
  assert.equal(probe.status, 200);
  assert.deepEqual(probe.json, { companion: 'finance-task-studio', pid: process.pid });
  assert.ok(Date.now() - started < 2000);
  assert.equal((await getWithin(port, '/api/status', 400)).timedOut, true, 'the full status is still waiting for the runtime check');

  const quick = await liveCompanion(t, root);
  const full = await getWithin(quick.port, '/api/status', 3000);
  assert.equal(full.status, 200);
  assert.equal(full.json.pid, process.pid);
  assert.equal(typeof full.json.nonce, 'string');
  assert.ok('agents' in full.json);
  assert.equal((await getWithin(quick.port, '/api/status?probe=1', 3000)).json.agents, undefined, 'the probe answer holds nothing else');
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

/* ====================================================================== the claim on the folder */

test('claimFolder: an exclusive LOCAL_SERVER.lock that holds the pid; held while that pid is alive; taken over when it is dead, damaged, or a leftover of a pid handed out again', async t => {
  const root = tempDir(t);
  const lock = LOCK(root);
  const other = idleProcess(t);
  const long = new Date(Date.now() - 60000);

  const first = claimFolder(root);
  assert.equal(first.claimed, true);
  assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid));
  assert.deepEqual(claimFolder(root), { claimed: false, holder: process.pid }, 'held, even by a claim of this very process');
  assert.equal(releaseFolder(root, 5), false, 'only the holder gives it back');
  assert.equal(fs.existsSync(lock), true);
  first.release();
  assert.equal(fs.existsSync(lock), false);
  assert.equal(releaseFolder(root), false, 'nothing to give back');

  /* held by a live process */
  fs.writeFileSync(lock, String(other.pid));
  assert.deepEqual(claimFolder(root), { claimed: false, holder: other.pid });
  assert.equal(fs.readFileSync(lock, 'utf8'), String(other.pid), 'untouched');

  /* a dead holder: taken over, and nothing is left behind */
  fs.writeFileSync(lock, String(await deadPid()));
  const taken = claimFolder(root);
  assert.equal(taken.claimed, true);
  assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid));
  assert.deepEqual(fs.readdirSync(root).filter(name => name.includes('.old')), []);
  taken.release();

  /* a leftover that carries this process's pid but that this process never claimed: the pid was handed out again */
  fs.writeFileSync(lock, String(process.pid));
  const again = claimFolder(root);
  assert.equal(again.claimed, true);
  again.release();

  /* a damaged file is a leftover; a file that is empty but new is a claim being written right now */
  fs.writeFileSync(lock, 'garbage');
  fs.utimesSync(lock, long, long);
  const damaged = claimFolder(root);
  assert.equal(damaged.claimed, true);
  damaged.release();
  fs.writeFileSync(lock, '');
  assert.deepEqual(claimFolder(root), { claimed: false, holder: null });
  fs.utimesSync(lock, long, long);
  const old = claimFolder(root);
  assert.equal(old.claimed, true);
  old.release();

  /* the liveness check can be replaced */
  fs.writeFileSync(lock, '4242');
  assert.deepEqual(claimFolder(root, { isAlive: pid => pid === 4242 }), { claimed: false, holder: 4242 });
  assert.equal(claimFolder(root, { isAlive: () => false }).claimed, true);
  releaseFolder(root);

  /* a live claim that was made while another taker was renaming the stale one is put back, not lost */
  const dead = await deadPid();
  let polls = 0;
  fs.writeFileSync(lock, String(dead));
  const outcome = claimFolder(root, { isAlive: pid => {
    polls++;
    if (polls === 1) {
      /* between this check and the rename, another start took over and claimed: the file now holds a live pid */
      fs.writeFileSync(lock, String(other.pid));
      return false;
    }
    return pid === other.pid;
  } });
  assert.deepEqual(outcome, { claimed: false, holder: other.pid });
  assert.equal(fs.readFileSync(lock, 'utf8'), String(other.pid), 'the live claim is back');
  assert.deepEqual(fs.readdirSync(root).filter(name => name.includes('.old')), []);
});

test('two starts at once on one folder: exactly one runs, the other refuses; the exit hook gives the folder back and a new start works', async t => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, 'tmp'));
  let created = 0;
  const createService = options => { created++; return createAgentService(options); };
  const procs = [new EventEmitter(), new EventEmitter()];
  const start = proc => runCompanion([], companionEnv(root, { FINANCE_STUDIO_PORT: '0' }), { root, log: () => {}, createService, proc, exit: () => {}, lockWaitMs: 400 });
  const results = await Promise.allSettled(procs.map(start));
  const winners = results.filter(result => result.status === 'fulfilled');
  const losers = results.filter(result => result.status === 'rejected');
  assert.equal(winners.length, 1, JSON.stringify(results.map(result => result.status)));
  assert.equal(losers.length, 1);
  assert.equal(created, 1, 'only one start created the agent service');
  assert.match(losers[0].reason.message, /^another start of Finance Task Studio \(process \d+\) has had this folder for \d+ seconds and has not come up\. If it is still starting, wait for it\. If it is stuck, close it, then start again\. If no companion is running, delete LOCAL_SERVER\.lock, then start again\.$/);
  const winner = winners[0].value;
  t.after(() => winner.app.close());
  assert.equal(fs.readFileSync(LOCK(root), 'utf8'), String(process.pid), 'held while the companion runs');

  procs[results.findIndex(result => result.status === 'fulfilled')].emit('exit', 0);
  assert.equal(fs.existsSync(LOCK(root)), false, 'the exit hook releases the folder');
  assert.equal(fs.existsSync(path.join(root, 'LOCAL_SERVER.json')), false);
  await winner.app.close();

  const next = await runCompanion([], companionEnv(root, { FINANCE_STUDIO_PORT: '0' }), { root, log: () => {}, proc: new EventEmitter(), exit: () => {} });
  t.after(() => next.app.close());
  assert.ok(next.url);
});

/* ====================================================================== runCompanion in this process */

function companionEnv(root, extra = {}) {
  return { ...cleanEnv(), CLAUDE_BIN: STUB, TMPDIR: path.join(root, 'tmp'), FINANCE_STUB_SCENARIO: '{}', ...extra };
}

test('runCompanion answers "already running" and starts nothing when the recorded companion confirms its pid', async t => {
  const root = tempDir(t);
  const live = await liveCompanion(t, root);
  const other = idleProcess(t);
  writeRecord(root, recordFor(live.url, other.pid));
  const before = fs.readFileSync(path.join(root, 'LOCAL_SERVER.json'), 'utf8');
  const lines = [];
  const opened = [];
  const asked = [];
  const proc = new EventEmitter();
  const probe = async (url, timeoutMs) => { asked.push([url, timeoutMs]); return { kind: 'companion', pid: other.pid }; };
  const createService = () => { throw new Error('the agent service must not be created: it would recover the rounds of the running companion'); };

  const quiet = await runCompanion([], companionEnv(root), { root, log: line => lines.push(line), openUrl: url => opened.push(url), createService, probe, proc, exit: () => { throw new Error('no exit'); } });
  assert.deepEqual(quiet, { alreadyRunning: true, url: live.url });
  assert.deepEqual(lines, [`Finance Task Studio is already running at ${live.url}`]);
  assert.deepEqual(opened, [], 'without --open nothing is opened');
  assert.deepEqual(asked, [[live.url, 5000]], 'the companion gets five seconds to answer');

  const withOpen = await runCompanion(['--open'], companionEnv(root), { root, log: line => lines.push(line), openUrl: url => opened.push(url), createService, probe, proc });
  assert.equal(withOpen.alreadyRunning, true);
  assert.equal(lines[1], `Finance Task Studio is already running at ${live.url}`);
  assert.deepEqual(opened, [live.url], 'with --open the running companion\'s page is opened');

  assert.equal(proc.eventNames().length, 0, 'no signal handler was installed');
  assert.equal(fs.readFileSync(path.join(root, 'LOCAL_SERVER.json'), 'utf8'), before, 'the running companion\'s record is left alone');
  assert.equal(fs.existsSync(LOCK(root)), false, 'the claim was given back');
  assert.equal(live.calls.includes('killPilots'), false);
});

test('runCompanion refuses to start, and creates nothing, when the recorded companion is alive but does not confirm; the message names the address and both ways out', async t => {
  const root = tempDir(t);
  const other = idleProcess(t);
  const silent = await silentServer(t);
  writeRecord(root, recordFor(silent.url, other.pid));
  const before = fs.readFileSync(path.join(root, 'LOCAL_SERVER.json'), 'utf8');
  let created = 0;
  await assert.rejects(
    runCompanion(['--open'], companionEnv(root), { root, log: () => {}, openUrl: () => { throw new Error('nothing is opened'); }, statusTimeoutMs: 300, createService: () => { created++; throw new Error('must not be created'); }, proc: new EventEmitter() }),
    error => {
      assert.equal(error.message, `the companion that LOCAL_SERVER.json records (process ${other.pid}, ${silent.url}) may still be running, but it did not confirm that: it did not answer within 0.3 seconds. If it is running, close that companion (press Control-C in its window), then start again. If no companion is running, delete LOCAL_SERVER.json, then start again.`);
      return true;
    },
  );
  assert.equal(created, 0);
  assert.equal(fs.readFileSync(path.join(root, 'LOCAL_SERVER.json'), 'utf8'), before, 'the record is left alone');
  assert.equal(fs.existsSync(LOCK(root)), false, 'the claim was given back');
});

test('runCompanion with a stale record starts as usual, overwrites the record, holds the lock, prints the keep-open line, and SIGHUP removes both', async t => {
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
  assert.equal(fs.readFileSync(LOCK(root), 'utf8'), String(process.pid));
  assert.deepEqual(await findRunningCompanion(root, { pid: SELF }), { status: 'running', url: started.url, pid: process.pid }, 'and it now answers as a running companion');

  /* the Terminal window closes: the same path as SIGTERM, and the record and the lock go */
  assert.equal(proc.listenerCount('SIGHUP'), 1);
  proc.emit('SIGHUP');
  await waitFor(() => exits.length, { label: 'the shutdown to finish' });
  assert.deepEqual(exits, [0]);
  assert.equal(fs.existsSync(path.join(root, 'LOCAL_SERVER.json')), false, 'LOCAL_SERVER.json is removed on a graceful shutdown');
  assert.equal(fs.existsSync(LOCK(root)), false, 'and so is the lock');
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
  proc.emit('exit', 0);

  /* the usual port is busy: another one, and one line that says why */
  const taken = await busyPort(t);
  const busyLines = [];
  const busyProc = new EventEmitter();
  const busy = await runCompanion([], companionEnv(root), { root, usualPort: taken, log: line => busyLines.push(line), proc: busyProc, exit: () => {} });
  t.after(() => busy.app.close());
  assert.notEqual(busy.url, `http://127.0.0.1:${taken}`);
  const notes = busyLines.filter(line => line.includes('busy'));
  assert.equal(notes.length, 1);
  assert.match(notes[0], new RegExp(`The usual port ${taken} is busy`));
  assert.match(notes[0], /Work saved in the browser by earlier sessions/);
  assert.match(notes[0], /will not show/);
  assert.equal(readRecord(root).url, busy.url, 'the record names the address in use');
  await busy.app.close();
  busyProc.emit('exit', 0);

  /* a port the writer chose that is busy stays an error, and the claim on the folder is given back */
  await assert.rejects(runCompanion([], companionEnv(root, { FINANCE_STUDIO_PORT: String(taken) }), { root, log: () => {}, proc: new EventEmitter(), exit: () => {} }), error => error.code === 'EADDRINUSE');
  assert.equal(fs.existsSync(LOCK(root)), false, 'a start that fails gives the folder back');
  assert.equal(fs.existsSync(path.join(root, 'LOCAL_SERVER.json')), false);
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

/* ====================================================================== the Studio's fixed pilot text */

test('a round approved before the Studio\'s fixed pilot text changed says so at launch; any other mismatch keeps the old words', async t => {
  const w = makeWorld(t);
  const id = await approvedRound(w);
  const prefixHash = crypto.createHash('sha256').update(PILOT_PROMPT_PREFIX, 'utf8').digest('hex');
  const stored = readJson(roundFile(w, id)).approval;
  assert.equal(stored.promptPrefixSha256, prefixHash, 'the hash of the fixed text is stored with the approval');
  assert.match(stored.summarySha256, /^[0-9a-f]{64}$/);
  assert.equal((await w.service.getRound(id)).approval.promptPrefixSha256, prefixHash);

  const FIXED_TEXT_CHANGED = 'APPROVAL MISMATCH: The Studio\'s fixed pilot text changed after this round was approved. Cancel this round, then freeze and approve it again. Nothing was started';
  const ROUND_CHANGED = 'APPROVAL MISMATCH: the round changed after it was approved. Nothing was started. Cancel this round, then freeze again from the form (a new round) or start the next round from it';
  /* a new service over the same folder, after the stored approval was edited the way an update of the Studio would leave it */
  const afterEditing = change => {
    const round = readJson(roundFile(w, id));
    change(round.approval);
    fs.writeFileSync(roundFile(w, id), JSON.stringify(round));
    return w.make();
  };
  const refusedWith = async (service, message) => {
    await assert.rejects(service.launchRound(id), error => {
      assert.equal(error.status, 409);
      assert.equal(error.message, message);
      return true;
    });
    assert.equal((await service.getRound(id)).status, 'approved', 'nothing was started and the round is as it was');
  };

  /* the fixed text changed: the stored hash of the text is not today's, and the summary no longer matches */
  await refusedWith(afterEditing(approval => { approval.promptPrefixSha256 = 'f'.repeat(64); approval.summarySha256 = 'e'.repeat(64); }), FIXED_TEXT_CHANGED);
  /* a round approved before the hash was stored */
  await refusedWith(afterEditing(approval => { delete approval.promptPrefixSha256; approval.summarySha256 = 'e'.repeat(64); }), FIXED_TEXT_CHANGED);
  /* the fixed text is the same, so it is the round that changed */
  await refusedWith(afterEditing(approval => { approval.promptPrefixSha256 = prefixHash; approval.summarySha256 = 'e'.repeat(64); }), ROUND_CHANGED);
  /* and a round that matches launches */
  const fine = afterEditing(approval => { approval.promptPrefixSha256 = prefixHash; approval.summarySha256 = stored.summarySha256; });
  await fine.launchRound(id);
  await fine.whenSettled(id);
  assert.equal((await fine.getRound(id)).status, 'finished');
});

/* ====================================================================== leftover pilots at the next start */

test('_stopLeftoverPilot signals only a process that leads its group, has a word of its command line equal to the recorded runtime, and started when the pilot was spawned', t => {
  const w = makeWorld(t);
  const store = new RoundStore({ root: w.projectRoot, claudeBin: STUB, tmpRoot: w.tmpRoot, env: w.env });
  const kill = t.mock.method(process, 'kill', () => {});
  const asked = [];
  const good = { pid: 4242, group: true, spawnedAt: '2026-01-01T00:00:00.000Z', bin: STUB };
  const spawned = Date.parse(good.spawnedAt);
  /* what ps says about a process that is the pilot: leads its group, runs the stub, started two seconds after the record */
  const info = (pid, extra = {}) => ({ pgid: pid, command: `node ${STUB} -p x --model y`, startedAtMs: spawned + 2000, ...extra });
  store._processInfo = pid => { asked.push(pid); return info(pid); };
  const sent = () => kill.mock.calls.map(call => call.arguments);

  for (const pilot of [undefined, null, 'x', {}, { ...good, pid: 1 }, { ...good, pid: 0 }, { ...good, pid: -4242 }, { ...good, pid: '4242' }, { ...good, pid: 42.5 }, { ...good, pid: process.pid }, { ...good, bin: undefined }, { ...good, bin: '' }, { ...good, bin: '/' }, { ...good, bin: 7 }, { ...good, spawnedAt: undefined }, { ...good, spawnedAt: 'yesterday' }, { ...good, spawnedAt: 5 }]) {
    assert.equal(store._stopLeftoverPilot(pilot), false, JSON.stringify(pilot));
  }
  assert.deepEqual(asked, [], 'those records never reach ps');
  assert.deepEqual(sent(), []);

  const refused = (label, what) => {
    store._processInfo = typeof what === 'function' ? what : () => what;
    assert.equal(store._stopLeftoverPilot(good), false, label);
    assert.deepEqual(sent(), [], label);
  };
  refused('not running (or no ps)', null);
  refused('an unrelated program has the pid now', pid => info(pid, { command: 'sleep 300' }));
  refused('the name matches but it does not lead a group of its own', pid => info(pid, { pgid: pid + 1 }));
  /* the review's decoy: a group leader whose command line only mentions a folder called .claude */
  const claude = { ...good, bin: '/usr/local/bin/claude' };
  store._processInfo = pid => info(pid, { command: 'node -e setInterval(()=>{},1000) /home/me/.claude/projects/notes.txt' });
  assert.equal(store._stopLeftoverPilot(claude), false, 'a path under ~/.claude is not the runtime');
  refused('a word that only contains the name', pid => info(pid, { command: 'node /x/not-stub-claude.cjs -p x' }));
  refused('a file that only starts with the name', pid => info(pid, { command: 'vim stub-claude.cjs.bak' }));
  refused('the name inside a longer word', pid => info(pid, { command: 'node -e run --note=stub-claude.cjs' }));
  /* the start time must be close to the recorded spawn time */
  refused('started eleven seconds late', pid => info(pid, { startedAtMs: spawned + 11000 }));
  refused('started eleven seconds early', pid => info(pid, { startedAtMs: spawned - 11000 }));
  refused('started an hour ago (an interactive session with the same file name)', pid => info(pid, { startedAtMs: spawned - 3600000 }));
  refused('no start time', pid => info(pid, { startedAtMs: undefined }));
  refused('an unreadable start time', pid => info(pid, { startedAtMs: NaN }));
  refused('no command', pid => info(pid, { command: undefined }));
  assert.deepEqual(sent(), []);

  /* the pilot itself */
  store._processInfo = pid => info(pid);
  assert.equal(store._stopLeftoverPilot(good), true);
  assert.deepEqual(sent(), [[-4242, 'SIGKILL']], 'the whole group');
  store._processInfo = pid => info(pid, { startedAtMs: spawned + 10000 });
  assert.equal(store._stopLeftoverPilot(good), true, 'ten seconds is still within the allowance');
  store._processInfo = pid => info(pid, { startedAtMs: spawned - 10000 });
  assert.equal(store._stopLeftoverPilot(good), true);
  /* a native binary is matched by its own path or by its file name */
  store._processInfo = pid => info(pid, { command: '/usr/local/bin/claude -p hello --model y' });
  assert.equal(store._stopLeftoverPilot(claude), true);
  store._processInfo = pid => info(pid, { command: 'claude -p hello' });
  assert.equal(store._stopLeftoverPilot(claude), true);
  assert.equal(sent().length, 5);
  store._processInfo = () => info(7, { pgid: 7 });
  assert.equal(store._stopLeftoverPilot({ ...good, group: false }), true);
  assert.deepEqual(sent()[5], [4242, 'SIGKILL'], 'a pilot that was not started as a group leader is signalled alone');
  kill.mock.restore();

  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); });
  store._processInfo = pid => info(pid);
  assert.equal(store._stopLeftoverPilot(good), false, 'a signal that fails is not claimed as a stop');
});

test('RoundStore.elapsedSeconds reads ps etime ([[dd-]hh:]mm:ss), and _processInfo reports a real process', async t => {
  assert.equal(RoundStore.elapsedSeconds('00:05'), 5);
  assert.equal(RoundStore.elapsedSeconds('01:02'), 62);
  assert.equal(RoundStore.elapsedSeconds(' 1:02:03 '), 3723);
  assert.equal(RoundStore.elapsedSeconds('1-02:03:04'), 93784);
  assert.equal(RoundStore.elapsedSeconds('12-00:00:00'), 1036800);
  for (const text of ['', 'abc', '5', '10', '1-2', '1:2:3:4', '-1:00', undefined, null]) assert.equal(RoundStore.elapsedSeconds(text), null, String(text));

  const w = makeWorld(t);
  const store = new RoundStore({ root: w.projectRoot, claudeBin: STUB, tmpRoot: w.tmpRoot, env: w.env });
  const child = idleProcess(t, { detached: true });
  const spawned = Date.now();
  await waitFor(() => commandOf(child.pid).includes('setInterval'), { label: 'the process to be up' });
  const info = store._processInfo(child.pid);
  assert.equal(info.pgid, child.pid);
  assert.ok(info.command.includes('setInterval'));
  assert.ok(Math.abs(info.startedAtMs - spawned) < 5000, `the start time is within seconds of the spawn: ${info.startedAtMs - spawned} ms`);
  assert.equal(store._processInfo(await deadPid()), null);
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

test('at startup the review\'s decoy survives: a group leader whose command line only mentions a path under ~/.claude', async t => {
  const w = makeWorld(t);
  const decoy = idleProcess(t, { detached: true, extraArgs: ['/home/me/.claude/projects/notes.txt'] });
  w.pids.add(decoy.pid);
  await waitFor(() => commandOf(decoy.pid).includes('notes.txt'), { label: 'the decoy to be up' });
  assert.equal(groupOf(decoy.pid), decoy.pid, 'it leads its own group, like a pilot');
  const id = await roundLeftRunning(w, { pid: decoy.pid, group: true, spawnedAt: new Date().toISOString(), bin: '/usr/local/bin/claude' });

  w.make();
  assert.equal(interruptedOnDisk(w, id).stderrTail, INTERRUPTED_NOTE);
  await sleep(300);
  assert.equal(decoy.signalCode, null);
  assert.equal(running(decoy.pid), true, 'not signalled');
});

test('at startup a process that matches the runtime but started long before the recorded spawn time is left alone; one that started at that time is stopped', async t => {
  const w = makeWorld(t);
  /* the same command line and group in both cases: only the recorded spawn time differs */
  const early = leftoverStub(t, tempDir(t));
  w.pids.add(early.pid);
  await waitFor(() => commandOf(early.pid).includes('stub-claude.cjs'), { label: 'the first stub to be up' });
  const hourLater = new Date(Date.now() + 3600000).toISOString();
  const idEarly = await roundLeftRunning(w, { pid: early.pid, group: true, spawnedAt: hourLater, bin: STUB });
  w.make();
  assert.equal(interruptedOnDisk(w, idEarly).stderrTail, INTERRUPTED_NOTE, 'no note: nothing was stopped');
  await sleep(300);
  assert.equal(early.signalCode, null);
  assert.equal(running(early.pid), true, 'a matching command with a start time far from the record survives');

  const w2 = makeWorld(t);
  const right = leftoverStub(t, tempDir(t));
  w2.pids.add(right.pid);
  await waitFor(() => commandOf(right.pid).includes('stub-claude.cjs'), { label: 'the second stub to be up' });
  const idRight = await roundLeftRunning(w2, { pid: right.pid, group: true, spawnedAt: new Date().toISOString(), bin: STUB });
  w2.make();
  assert.equal((await Promise.race([endOf(right), sleep(10000).then(() => 'still running')])).signal, 'SIGKILL');
  assert.equal(interruptedOnDisk(w2, idRight).stderrTail, INTERRUPTED_NOTE + '\n' + LEFTOVER_NOTE);
});

test('at startup a native runtime is matched by its own path as argv[0]', async t => {
  const w = makeWorld(t);
  /* node stands in for a native claude binary: its command line starts with exactly the recorded path */
  const native = idleProcess(t, { detached: true });
  w.pids.add(native.pid);
  await waitFor(() => commandOf(native.pid).startsWith(process.execPath), { label: 'the process to be up' });
  const id = await roundLeftRunning(w, { pid: native.pid, group: true, spawnedAt: new Date().toISOString(), bin: process.execPath });
  w.make();
  assert.equal((await Promise.race([endOf(native), sleep(10000).then(() => 'still running')])).signal, 'SIGKILL');
  assert.equal(interruptedOnDisk(w, id).stderrTail, INTERRUPTED_NOTE + '\n' + LEFTOVER_NOTE);
});

test('a slow companion is not taken for a dead one: the second start refuses, and the round and its pilot are not touched', async t => {
  const w = makeWorld(t);
  const leftover = leftoverStub(t, tempDir(t));
  w.pids.add(leftover.pid);
  await waitFor(() => commandOf(leftover.pid).includes('stub-claude.cjs'), { label: 'the pilot to be up' });
  const id = await roundLeftRunning(w, { pid: leftover.pid, group: true, spawnedAt: new Date().toISOString(), bin: STUB });
  /* the companion that owns the round: alive, listening, and too busy to answer */
  const owner = idleProcess(t);
  const busy = await silentServer(t);
  writeRecord(w.projectRoot, recordFor(busy.url, owner.pid));
  const roundBefore = fs.readFileSync(roundFile(w, id), 'utf8');

  await assert.rejects(
    runCompanion([], companionEnv(w.projectRoot, { FINANCE_STUDIO_PORT: '0' }), { root: w.projectRoot, log: () => {}, statusTimeoutMs: 300, proc: new EventEmitter(), exit: () => {} }),
    error => error.message.includes(busy.url) && /close that companion/.test(error.message),
  );
  await sleep(200);
  assert.equal(leftover.signalCode, null);
  assert.equal(running(leftover.pid), true, 'the pilot of the running companion was not killed');
  assert.equal(fs.readFileSync(roundFile(w, id), 'utf8'), roundBefore, 'and its round was not marked interrupted');
  assert.equal(readRecord(w.projectRoot).pid, owner.pid, 'the record is untouched');
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
  const lockPath = path.join(project, 'LOCAL_SERVER.lock');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), String(first.child.pid), 'the running companion holds the lock');

  const second = startCompanion(t, project);
  assert.deepEqual(await exitOf(second), { code: 0, signal: null }, second.output);
  assert.equal(second.output.trim(), `Finance Task Studio is already running at ${url}`);
  assert.deepEqual(readJson(recordPath), record, 'the first companion\'s record is untouched');
  assert.deepEqual(await findRunningCompanion(project, { pid: second.child.pid }), { status: 'running', url, pid: first.child.pid }, 'and it still answers, as the recorded pid');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), String(first.child.pid), 'the lock is still the first companion\'s');

  /* the Terminal window is closed: SIGHUP is a graceful shutdown that removes the record */
  first.child.kill('SIGHUP');
  assert.deepEqual(await exitOf(first), { code: 0, signal: null }, first.output);
  assert.equal(fs.existsSync(recordPath), false);
  assert.equal(fs.existsSync(lockPath), false);

  /* a companion that dies without a chance to clean up leaves a stale record and lock, which the next start takes over */
  const third = startCompanion(t, project);
  await waitFor(() => third.url(), { label: 'the third companion to print its address' });
  third.child.kill('SIGKILL');
  assert.deepEqual(await exitOf(third), { code: null, signal: 'SIGKILL' });
  assert.equal(readJson(recordPath).pid, third.child.pid, 'stale: the pid is dead');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), String(third.child.pid), 'the lock is stale too');

  const fourth = startCompanion(t, project);
  const fourthUrl = await waitFor(() => fourth.url(), { label: 'the fourth companion to print its address' });
  assert.doesNotMatch(fourth.output, /already running/);
  assert.equal(readJson(recordPath).pid, fourth.child.pid);
  assert.equal(readJson(recordPath).url, fourthUrl);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), String(fourth.child.pid));

  /* SIGQUIT is handled the same way */
  fourth.child.kill('SIGQUIT');
  assert.deepEqual(await exitOf(fourth), { code: 0, signal: null }, fourth.output);
  assert.equal(fs.existsSync(recordPath), false);
  assert.equal(fs.existsSync(lockPath), false);
});

test('run as a script: two starts at the same moment on one folder, one runs and the other says it is already running', async t => {
  const base = tempDir(t, 'finance-lifecycle-race-');
  const project = copyProject(base);
  const a = startCompanion(t, project);
  const b = startCompanion(t, project);
  await waitFor(() => a.url() || b.url(), { label: 'one of the starts to print its address' });
  const [winner, loser] = a.url() ? [a, b] : [b, a];
  const url = winner.url();
  assert.deepEqual(await exitOf(loser), { code: 0, signal: null }, loser.output);
  assert.equal(loser.output.trim(), `Finance Task Studio is already running at ${url}`);
  assert.equal(readJson(path.join(project, 'LOCAL_SERVER.json')).pid, winner.child.pid);
  assert.equal(fs.readFileSync(path.join(project, 'LOCAL_SERVER.lock'), 'utf8'), String(winner.child.pid));
  assert.equal(winner.child.exitCode, null, 'the one that runs is still running');
  winner.child.kill('SIGTERM');
  assert.deepEqual(await exitOf(winner), { code: 0, signal: null }, winner.output);
});

test('run as a script: a companion that is stopped (it accepts connections and does not answer) is not taken for a dead one; the second start refuses after five seconds and the first is untouched', async t => {
  const base = tempDir(t, 'finance-lifecycle-slow-');
  const project = copyProject(base);
  const first = startCompanion(t, project);
  const url = await waitFor(() => first.url(), { label: 'the first companion to print its address' });
  await waitFor(() => first.output.includes(KEEP_OPEN_LINE), { label: 'the keep-open line' });
  const record = readJson(path.join(project, 'LOCAL_SERVER.json'));

  first.child.kill('SIGSTOP');
  await sleep(200);
  const started = Date.now();
  const second = startCompanion(t, project);
  assert.deepEqual(await exitOf(second, 40000), { code: 1, signal: null }, second.output);
  const took = Date.now() - started;
  assert.ok(took >= 4500 && took < 20000, `the second start waited ${took} ms for an answer`);
  assert.equal(second.output.trim(), `Finance Task Studio could not start: the companion that LOCAL_SERVER.json records (process ${first.child.pid}, ${url}) may still be running, but it did not confirm that: it did not answer within 5 seconds. If it is running, close that companion (press Control-C in its window), then start again. If no companion is running, delete LOCAL_SERVER.json, then start again.`);
  assert.deepEqual(readJson(path.join(project, 'LOCAL_SERVER.json')), record, 'the record is untouched');
  assert.equal(fs.readFileSync(path.join(project, 'LOCAL_SERVER.lock'), 'utf8'), String(first.child.pid), 'and so is the lock');

  first.child.kill('SIGCONT');
  const third = startCompanion(t, project);
  assert.deepEqual(await exitOf(third), { code: 0, signal: null }, third.output);
  assert.equal(third.output.trim(), `Finance Task Studio is already running at ${url}`);
  first.child.kill('SIGTERM');
  assert.deepEqual(await exitOf(first), { code: 0, signal: null }, first.output);
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
