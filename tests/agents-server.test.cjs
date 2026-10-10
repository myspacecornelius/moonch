'use strict';
/* Tests for the companion's HTTP layer (docs/local-agents.md section 5).
   The server runs on an ephemeral port with an agent service built on backend/agents/stub-claude.cjs, so no model is started and
   nothing leaves this machine. Every fixture is synthetic and lives in temporary folders that are removed afterwards. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const childProcess = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createServer, installSignalHandlers, localServerRecord, usableClaudeBin, ASSETS } = require('../backend/server.cjs');
const { createAgentService, AgentError } = require('../backend/agents/index.cjs');
const C = require('../backend/agents/constants.cjs');
const core = require('../core.js');

const REPO = path.resolve(__dirname, '..');
const STUB = path.join(REPO, 'backend', 'agents', 'stub-claude.cjs');
const PROMPT = 'Assess the Atlas liquidity position using the supplied records and recommend whether the borrowing can proceed.';
const PILOT_PREFIX = 'The task materials are in ./filesystem. Save any files you produce to ./outputs. When you finish, give your answer in your final message.\n\n';
const TOOL_LIST = 'Bash,Read,Write,Edit,Glob,Grep';
const ACK = ['shell-access', 'network', 'isolation-by-audit'];
const GOLD = {
  gold: { decision: 'hold', figures: [{ label: 'Usable cash', value: '1,250', tolerance: 1 }], notes: 'Synthetic gold' },
  fingerprints: [{ id: 'fp-credit', label: 'Counts available credit as cash', tokens: ['available facility counted'], figures: [{ label: 'Wrong cash', value: 3050, tolerance: 1 }] }],
};
const GOLD_ANSWER = 'Usable cash is 1,250. Hold the borrowing.';
const WRONG_ANSWER = 'Cash is 3,050 because the available facility counted as cash. Proceed.';

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

/* One request on its own connection. A header set to undefined or null is left out. */
function request(port, { method = 'GET', path: urlPath, headers = {}, body, chunks }) {
  return new Promise((resolve, reject) => {
    const sent = {};
    for (const [name, value] of Object.entries(headers)) if (value !== undefined && value !== null) sent[name] = value;
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    if (payload !== undefined && !chunks) sent['Content-Length'] = payload.length;
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
    if (chunks && payload !== undefined) {
      /* no Content-Length: the body goes out chunked */
      for (let at = 0; at < payload.length; at += chunks) req.write(payload.subarray(at, at + chunks));
      req.end();
    } else {
      req.end(payload);
    }
  });
}

/* A client that behaves like the page: GETs carry nothing extra, changes carry Origin, the nonce and the JSON type. */
function clientFor(port, nonce) {
  const origin = `http://127.0.0.1:${port}`;
  return {
    port,
    origin,
    get: (urlPath, headers) => request(port, { path: urlPath, headers }),
    send: (method, urlPath, body, headers = {}) => request(port, {
      method,
      path: urlPath,
      body: body === undefined ? '{}' : body,
      headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Finance-Local': nonce, ...headers },
    }),
  };
}

/* ------------------------------------------------------------------ the synthetic world */

/* <base>/project (with private/), <base>/source (the packet), <base>/tmp (pilot folders). The server and the service share the
   project folder unless serverRoot says otherwise. */
async function makeWorld(t, scenario = {}, options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-server-test-'));
  const projectRoot = path.join(base, 'project');
  const source = path.join(base, 'source');
  const tmpRoot = path.join(base, 'tmp');
  fs.mkdirSync(path.join(projectRoot, 'private'), { recursive: true });
  fs.mkdirSync(path.join(source, 'gaf'), { recursive: true });
  fs.mkdirSync(tmpRoot);
  fs.writeFileSync(path.join(source, 'Facility_Terms.txt'), 'Atlas facility terms, synthetic. Available credit is not cash received.\n');
  fs.writeFileSync(path.join(source, 'Cash_Facts.csv'), 'Label,Value\nOpening usable cash,100\nConfirmed funded draw,500\n');
  fs.writeFileSync(path.join(source, 'gaf', 'Template_Layout.txt'), 'synthetic template\n');
  fs.writeFileSync(path.join(source, 'Answer_Key.txt'), 'Synthetic answer material, never given to a pilot by default.\n');
  const argvLog = path.join(base, 'argv.log');
  const envLog = path.join(base, 'env.log');
  const env = {
    ...process.env,
    FINANCE_STUB_SCENARIO: JSON.stringify(scenario),
    FINANCE_STUB_ARGV_LOG: argvLog,
    FINANCE_STUB_ENV_LOG: envLog,
    ...(options.env || {}),
  };
  const service = options.service || createAgentService({ root: projectRoot, env, claudeBin: STUB, tmpRoot, limits: options.limits });
  const logs = [];
  const app = createServer({ root: options.serverRoot || projectRoot, service, port: 0, log: message => logs.push(message) });
  const { port, url } = await app.listen();
  const world = { base, projectRoot, source, tmpRoot, argvLog, envLog, env, service, app, logs, port, url, pilots: path.join(tmpRoot, 'finance-studio-pilots'), ...clientFor(port, app.nonce) };
  world.post = (urlPath, body, headers) => world.send('POST', urlPath, body, headers);
  t.after(async () => {
    await app.shutdown();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return world;
}

const readJsonLines = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
const promptRuns = file => readJsonLines(file).filter(args => args.includes('-p'));

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

async function frozenRound(w, extra) {
  const created = await createRound(w, extra);
  const frozen = await w.post(`/api/agents/rounds/${created.id}/freeze`, GOLD);
  assert.equal(frozen.status, 200, frozen.text);
  return frozen.json;
}

async function approvedRound(w, extra) {
  const frozen = await frozenRound(w, extra);
  const approved = await w.post(`/api/agents/rounds/${frozen.id}/approve`, { summarySha256: frozen.summarySha256, acknowledgements: ACK });
  assert.equal(approved.status, 200, approved.text);
  return approved.json;
}

const roundStatus = (w, id) => w.get(`/api/agents/rounds/${id}`).then(response => response.json.status);

async function finishedRound(w, extra) {
  const approved = await approvedRound(w, extra);
  const launched = await w.post(`/api/agents/rounds/${approved.id}/launch`);
  assert.equal(launched.status, 200, launched.text);
  await waitFor(async () => ['finished', 'failed', 'cancelled'].includes(await roundStatus(w, approved.id)), { label: 'the round to end' });
  return approved.id;
}

const expectedArgs = (promptText, model = 'claude-opus-5-5', effort = 'medium') => [
  '-p', PILOT_PREFIX + promptText,
  '--model', model, '--effort', effort,
  '--output-format', 'stream-json', '--verbose',
  '--tools', TOOL_LIST, '--allowedTools', TOOL_LIST,
  '--permission-mode', 'acceptEdits',
  '--disable-slash-commands', '--strict-mcp-config', '--setting-sources', '',
  '--no-session-persistence',
];

/* A service whose methods are replaced by the given ones, so a route can be driven with a chosen failure. */
const patchedService = (real, patch) => ({ ...real, ...patch });

/* ====================================================================== status and shape */

test('GET /api/status keeps its fields and adds the agents block', async t => {
  const w = await makeWorld(t);
  const response = await w.get('/api/status');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.deepEqual(Object.keys(response.json).sort(), ['adapter', 'agents', 'canStart', 'connection', 'nonce', 'state']);
  assert.equal(response.json.state, null);
  assert.equal(response.json.connection, 'local-sdk-adapter');
  assert.equal(response.json.canStart, false);
  assert.equal(response.json.adapter, 'deepseek-account');
  assert.match(response.json.nonce, /^[0-9a-f]{48}$/);
  assert.equal(response.json.nonce, w.app.nonce);

  const agents = response.json.agents;
  assert.deepEqual(Object.keys(agents).sort(), ['efforts', 'maxPilotsPerRound', 'models', 'runtime']);
  assert.equal(agents.maxPilotsPerRound, C.MAX_PILOTS_PER_ROUND);
  assert.equal(agents.maxPilotsPerRound, 5);
  assert.deepEqual(agents.models, C.MODELS);
  assert.deepEqual(agents.efforts, C.EFFORTS);
  assert.equal(agents.runtime.found, true);
  assert.equal(agents.runtime.version, '0.0.0-stub');
  assert.equal(agents.runtime.path, STUB);
});

test('the nonce differs from one server to the next', async t => {
  const first = await makeWorld(t);
  const second = await makeWorld(t);
  assert.notEqual(first.app.nonce, second.app.nonce);
  const crossed = await first.send('POST', '/api/agents/rounds', roundBody(first), { 'X-Finance-Local': second.app.nonce });
  assert.equal(crossed.status, 403);
});

test('a status block that cannot be read still answers, from the fixed limits', async t => {
  const real = createAgentService({ root: path.join(os.tmpdir(), 'unused-root-for-status'), claudeBin: STUB });
  const w = await makeWorld(t, {}, { service: patchedService(real, { status: async () => { throw new Error('detection failed at /private/place'); } }) });
  const response = await w.get('/api/status');
  assert.equal(response.status, 200);
  assert.equal(response.json.agents.runtime.found, false);
  assert.equal(response.json.agents.maxPilotsPerRound, 5);
  assert.deepEqual(response.json.agents.models, C.MODELS);
  assert.equal(w.logs.length, 1);
});

test('starting the companion starts no model, writes no server record, and reading the status only asks for the version', async t => {
  const w = await makeWorld(t);
  await w.get('/api/status');
  await w.get('/api/agents/rounds');
  const invocations = readJsonLines(w.argvLog);
  assert.ok(invocations.length >= 1, 'the runtime version was asked for');
  assert.ok(invocations.every(args => args.length === 1 && args[0] === '--version'), JSON.stringify(invocations));
  assert.equal(promptRuns(w.argvLog).length, 0);
  assert.equal(fs.existsSync(path.join(w.projectRoot, 'LOCAL_SERVER.json')), false, 'only the script entry writes LOCAL_SERVER.json');
  assert.equal(fs.existsSync(w.pilots), false, 'no pilot folder exists');
});

test('LOCAL_SERVER.json records zero model calls unless the one-time run was requested', () => {
  const base = { url: 'http://127.0.0.1:5000', pid: 7, startedAt: '2026-01-01T00:00:00.000Z' };
  assert.deepEqual(localServerRecord({ ...base, runApprovedOnce: false }), { ...base, modelCallsOnLaunch: 0 });
  assert.deepEqual(localServerRecord({ ...base, runApprovedOnce: undefined }), { ...base, modelCallsOnLaunch: 0 });
  assert.equal(localServerRecord({ ...base, runApprovedOnce: true }).modelCallsOnLaunch, 1);
  assert.deepEqual(Object.keys(localServerRecord({ ...base, runApprovedOnce: false })), ['url', 'pid', 'startedAt', 'modelCallsOnLaunch']);
});

test('createServer refuses a missing service and a bad port, and binds to the loopback address only', async t => {
  assert.throws(() => createServer({ root: REPO, port: 0 }), TypeError);
  assert.throws(() => createServer({ root: REPO, service: {}, port: 0 }), TypeError);
  const service = createAgentService({ root: path.join(os.tmpdir(), 'unused-root-for-port'), claudeBin: STUB });
  for (const port of [-1, 65536, 1.5, NaN, '80']) assert.throws(() => createServer({ root: REPO, service, port }), RangeError);
  const w = await makeWorld(t);
  assert.equal(w.app.server.address().address, '127.0.0.1');
  assert.equal(w.app.server.address().port, w.port);
});

/* ====================================================================== host, origin, nonce, content type */

test('the Host header must be exactly 127.0.0.1:<port> on every kind of request', async t => {
  const w = await makeWorld(t);
  const hosts = ['localhost:' + w.port, '127.0.0.1', `127.0.0.1:${w.port + 1}`, 'evil.example', `evil.example:${w.port}`, `127.0.0.1:${w.port}.evil.example`, `0.0.0.0:${w.port}`];
  for (const host of hosts) {
    const get = await request(w.port, { path: '/api/status', headers: { Host: host } });
    assert.equal(get.status, 403, 'GET with Host ' + host);
    const page = await request(w.port, { path: '/', headers: { Host: host } });
    assert.equal(page.status, 403, 'page with Host ' + host);
    const post = await request(w.port, {
      method: 'POST',
      path: '/api/agents/rounds',
      body: roundBody(w),
      headers: { Host: host, Origin: `http://${host}`, 'Content-Type': 'application/json', 'X-Finance-Local': w.app.nonce },
    });
    assert.equal(post.status, 403, 'POST with Host ' + host + ' even with a matching Origin and the right nonce');
  }
  const list = await w.get('/api/agents/rounds');
  assert.deepEqual(list.json.rounds, [], 'nothing was created by the refused requests');
});

test('a change needs Origin http://<host>', async t => {
  const w = await makeWorld(t);
  const good = { Origin: w.origin, 'Content-Type': 'application/json', 'X-Finance-Local': w.app.nonce };
  const origins = [undefined, 'null', 'http://evil.example', 'http://localhost:' + w.port, `https://127.0.0.1:${w.port}`, `http://127.0.0.1:${w.port + 1}`, w.origin + '/', w.origin.toUpperCase(), ''];
  for (const origin of origins) {
    const response = await request(w.port, { method: 'POST', path: '/api/agents/rounds', body: roundBody(w), headers: { ...good, Origin: origin } });
    assert.equal(response.status, 403, 'Origin ' + JSON.stringify(origin));
  }
  const list = await w.get('/api/agents/rounds');
  assert.deepEqual(list.json.rounds, []);
  const accepted = await request(w.port, { method: 'POST', path: '/api/agents/rounds', body: roundBody(w), headers: good });
  assert.equal(accepted.status, 200, accepted.text);
});

test('a change needs the nonce from the status route', async t => {
  const w = await makeWorld(t);
  const wrong = [undefined, '', 'x', w.app.nonce.slice(1), w.app.nonce + '0', w.app.nonce.toUpperCase(), '0'.repeat(48)];
  for (const value of wrong) {
    const response = await w.send('POST', '/api/agents/rounds', roundBody(w), { 'X-Finance-Local': value });
    assert.equal(response.status, 403, 'nonce ' + JSON.stringify(value));
  }
  /* the nonce only travels in a header: the same value in the query or the body does not count */
  const inQuery = await w.send('POST', `/api/agents/rounds?x-finance-local=${w.app.nonce}`, { ...roundBody(w), nonce: w.app.nonce }, { 'X-Finance-Local': undefined });
  assert.equal(inQuery.status, 403);
  assert.deepEqual((await w.get('/api/agents/rounds')).json.rounds, []);
});

test('a change needs Content-Type application/json', async t => {
  const w = await makeWorld(t);
  const refused = [undefined, '', 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx', 'text/json', 'application/json; charset=latin1', 'application/xml'];
  for (const type of refused) {
    const response = await w.send('POST', '/api/agents/rounds', roundBody(w), { 'Content-Type': type });
    assert.equal(response.status, 415, 'type ' + JSON.stringify(type) + ' ' + response.text);
    assert.match(response.json.error, /application\/json/);
  }
  assert.deepEqual((await w.get('/api/agents/rounds')).json.rounds, []);
  for (const type of ['application/json', 'application/json; charset=utf-8', 'Application/JSON', 'application/json;charset=UTF-8']) {
    const response = await w.send('POST', '/api/agents/packet/inspect', { sourceDir: w.source }, { 'Content-Type': type });
    assert.equal(response.status, 200, 'type ' + type + ' ' + response.text);
  }
});

test('Origin, nonce and content type are checked before the body is read or any id is looked at', async t => {
  const w = await makeWorld(t);
  const huge = Buffer.alloc(2 * 1024 * 1024, 0x61);
  const noNonce = await request(w.port, { method: 'POST', path: '/api/agents/rounds/BAD_ID/freeze', body: huge, headers: { Origin: w.origin, 'Content-Type': 'application/json' } });
  assert.equal(noNonce.status, 403);
  const noOrigin = await request(w.port, { method: 'POST', path: '/api/agents/rounds/BAD_ID/freeze', body: huge, headers: { 'Content-Type': 'application/json', 'X-Finance-Local': w.app.nonce } });
  assert.equal(noOrigin.status, 403);
  const noType = await request(w.port, { method: 'POST', path: '/api/agents/rounds/BAD_ID/freeze', body: huge, headers: { Origin: w.origin, 'X-Finance-Local': w.app.nonce } });
  assert.equal(noType.status, 415);
});

test('a page on another origin cannot read the API, and responses carry no CORS permission', async t => {
  const w = await makeWorld(t);
  for (const urlPath of ['/api/status', '/api/agents/rounds', '/api/agents/rounds/rnd-000000000000']) {
    const foreign = await w.get(urlPath, { Origin: 'http://evil.example' });
    assert.equal(foreign.status, 403, urlPath);
    assert.ok(!('nonce' in (foreign.json || {})), 'the nonce is not sent to a foreign origin');
    assert.equal(foreign.headers['access-control-allow-origin'], undefined);
    const same = await w.get(urlPath, { Origin: w.origin });
    assert.notEqual(same.status, 403, urlPath);
  }
  const preflight = await request(w.port, { method: 'OPTIONS', path: '/api/agents/rounds', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-finance-local,content-type' } });
  assert.equal(preflight.status, 405);
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);
  assert.equal(preflight.headers['access-control-allow-headers'], undefined);
  const ok = await w.get('/api/status');
  assert.equal(ok.headers['access-control-allow-origin'], undefined);
  assert.equal(ok.headers['cross-origin-resource-policy'], 'same-origin');
});

/* ====================================================================== bodies */

test('the body cap is 1 MB, and 256 KB on the packet routes', async t => {
  const w = await makeWorld(t);
  const padded = size => {
    const prefix = '{"pad":"';
    const suffix = '"}';
    return Buffer.from(prefix + 'a'.repeat(size - prefix.length - suffix.length) + suffix);
  };
  const exactPacket = padded(C.LIMITS.packetBodyBytes);
  const exactBody = padded(C.LIMITS.bodyBytes);
  assert.equal(exactPacket.length, 256 * 1024);
  assert.equal(exactBody.length, 1024 * 1024);

  /* at the limit the request reaches the service (which then finds a field missing: 400); one byte more is 413 */
  for (const urlPath of ['/api/agents/packet/inspect', '/api/agents/rounds']) {
    assert.equal((await w.post(urlPath, exactPacket)).status, 400, urlPath + ' at the cap');
    const over = await w.post(urlPath, padded(C.LIMITS.packetBodyBytes + 1));
    assert.equal(over.status, 413, urlPath + ' over the cap');
    assert.match(over.json.error, /256 KB/);
  }
  assert.equal((await w.post('/api/agents/grader-sim', exactBody)).status, 400);
  const over = await w.post('/api/agents/grader-sim', padded(C.LIMITS.bodyBytes + 1));
  assert.equal(over.status, 413);
  assert.match(over.json.error, /1024 KB/);

  /* the routes that are not packet routes take the larger body: a 300 KB body is read, then the unknown round is a 404 */
  const medium = padded(300 * 1024);
  for (const urlPath of ['/api/agents/rounds/rnd-000000000000/freeze', '/api/agents/rounds/rnd-000000000000/runs/1/classify']) {
    assert.equal((await w.post(urlPath, medium)).status, 404, urlPath);
  }
  assert.equal((await w.post('/api/agents/packet/inspect', medium)).status, 413);

  /* a body of 2 MB that declares its length, and the same sent chunked with no length at all */
  const twoMb = Buffer.alloc(2 * 1024 * 1024, 0x20);
  assert.equal((await w.post('/api/agents/grader-sim', twoMb)).status, 413);
  const chunked = await request(w.port, {
    method: 'POST',
    path: '/api/agents/packet/inspect',
    body: padded(600 * 1024),
    chunks: 16 * 1024,
    headers: { Origin: w.origin, 'Content-Type': 'application/json', 'X-Finance-Local': w.app.nonce },
  });
  assert.equal(chunked.status, 413);

  /* the server is still healthy afterwards */
  assert.equal((await w.get('/api/status')).status, 200);
  assert.equal(w.logs.length, 0, w.logs.join('\n'));
});

test('a client that hangs up in the middle of a body does not disturb the server', async t => {
  const w = await makeWorld(t);
  await new Promise((resolve, reject) => {
    const socket = net.connect(w.port, '127.0.0.1', () => {
      const head = `POST /api/agents/rounds HTTP/1.1\r\nHost: 127.0.0.1:${w.port}\r\nOrigin: ${w.origin}\r\nContent-Type: application/json\r\nX-Finance-Local: ${w.app.nonce}\r\nContent-Length: 5000\r\n\r\n{"label":"half a bo`;
      socket.write(head, () => { socket.destroy(); resolve(); });
    });
    socket.on('error', reject);
  });
  await sleep(100);
  assert.equal((await w.get('/api/status')).status, 200);
  assert.deepEqual((await w.get('/api/agents/rounds')).json.rounds, []);
  assert.equal(w.logs.length, 0, 'a hang-up is not an internal error');
});

test('invalid JSON, a body that is not an object, and bad UTF-8 are 400; an empty body is an empty object', async t => {
  const w = await makeWorld(t);
  for (const text of ['{', '{"a":', 'not json', '{"a":1}}', "{'a':1}", '{"a":1,}', 'undefined']) {
    const response = await w.post('/api/agents/packet/inspect', text);
    assert.equal(response.status, 400, text);
    assert.match(response.json.error, /valid JSON/);
  }
  for (const text of ['[]', 'null', '"text"', '1', 'true', '[{"sourceDir":"x"}]']) {
    const response = await w.post('/api/agents/packet/inspect', text);
    assert.equal(response.status, 400, text);
    assert.match(response.json.error, /JSON object/);
  }
  const badBytes = await w.post('/api/agents/packet/inspect', Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d]));
  assert.equal(badBytes.status, 400);
  assert.match(badBytes.json.error, /UTF-8/);

  /* empty and blank bodies are {}: the service then says what is missing, and routes that need nothing just run */
  for (const text of ['', '  \n ']) {
    const missing = await w.post('/api/agents/packet/inspect', text);
    assert.equal(missing.status, 400);
    assert.match(missing.json.error, /sourceDir is required/);
    const unknown = await w.post('/api/agents/rounds/rnd-000000000000/cancel', text);
    assert.equal(unknown.status, 404);
  }
  /* a byte order mark in front of valid JSON is tolerated */
  const bom = await w.post('/api/agents/packet/inspect', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ sourceDir: w.source }))]));
  assert.equal(bom.status, 200);
  /* a key called __proto__ is just data and changes nothing */
  const proto = await w.post('/api/agents/packet/inspect', '{"__proto__":{"sourceDir":"/etc"},"sourceDir":' + JSON.stringify(w.source) + '}');
  assert.equal(proto.status, 200);
  assert.equal({}.sourceDir, undefined);
});

/* ====================================================================== ids and routes */

test('ids must match ^[a-z0-9-]{4,64}$ on every route that takes one', async t => {
  const w = await makeWorld(t);
  const bad = ['BAD_ID', 'Rnd-000000000000', 'abc', 'a'.repeat(65), 'rnd_000000000000', 'rnd-0000.00000000', 'rnd-00000000%2Fx', 'rnd-000000%20000', 'rnd-%00000000000', '%'];
  for (const id of bad) {
    const where = '/api/agents/rounds/' + id;
    assert.equal((await w.get(where)).status, 400, 'GET ' + id);
    for (const tail of ['/freeze', '/refreeze', '/approve', '/launch', '/cancel', '/export', '/runs/1/classify']) {
      assert.equal((await w.post(where + tail, {})).status, 400, 'POST ' + id + tail);
    }
    assert.equal((await w.get(where + '/runs/1')).status, 400, 'GET run of ' + id);
  }
  /* an id with a valid shape that names nothing is a 404, never a 500 */
  const missing = ['rnd-000000000000', 'aaaa', 'a'.repeat(64), '0000'];
  for (const id of missing) {
    const where = '/api/agents/rounds/' + id;
    assert.equal((await w.get(where)).status, 404, 'GET ' + id);
    assert.equal((await w.get(where + '/runs/1')).status, 404);
    for (const tail of ['/freeze', '/refreeze', '/approve', '/launch', '/cancel', '/export', '/runs/1/classify']) {
      assert.equal((await w.post(where + tail, {})).status, 404, 'POST ' + id + tail);
    }
  }
  assert.equal(w.logs.length, 0, w.logs.join('\n'));
});

test('the server rejects a bad id or run number itself, before the service is called', async t => {
  const real = createAgentService({ root: path.join(os.tmpdir(), 'unused-root-for-trap'), claudeBin: STUB });
  const trap = {};
  for (const name of ['inspectPacket', 'createRound', 'approvalSummary', 'freezeRound', 'refreezeRound', 'approveRound', 'launchRound', 'listRounds', 'getRound', 'getRun', 'classifyRun', 'cancelRound', 'exportRound', 'graderSim']) {
    trap[name] = async () => { throw new Error('the service was reached'); };
  }
  const w = await makeWorld(t, {}, { service: patchedService(real, trap) });
  const tails = ['/freeze', '/refreeze', '/approve', '/launch', '/cancel', '/export', '/runs/1/classify'];
  for (const id of ['BAD_ID', 'abc', 'a'.repeat(65), 'rnd_000000000000', 'rnd-0000%2F00000000', '%']) {
    assert.equal((await w.get('/api/agents/rounds/' + id)).status, 400, id);
    assert.equal((await w.get(`/api/agents/rounds/${id}/runs/1`)).status, 400, id);
    for (const tail of tails) assert.equal((await w.post(`/api/agents/rounds/${id}${tail}`, {})).status, 400, id + tail);
  }
  for (const n of ['0', '01', 'abc', '1000']) {
    assert.equal((await w.get(`/api/agents/rounds/rnd-000000000000/runs/${n}`)).status, 400, 'run ' + n);
    assert.equal((await w.post(`/api/agents/rounds/rnd-000000000000/runs/${n}/classify`, {})).status, 400, 'run ' + n);
  }
  assert.equal(w.logs.length, 0, 'no bad id reached the service');
  /* the trap works: a well formed id does reach the service, and the failure is a generic 500 */
  const reached = await w.get('/api/agents/rounds/rnd-000000000000');
  assert.equal(reached.status, 500);
  assert.ok(!reached.text.includes('the service was reached'));
  assert.equal(w.logs.length, 1);
});

test('run numbers are checked on the run routes, and an unknown run is a 404', async t => {
  const w = await makeWorld(t);
  const created = await createRound(w);
  for (const n of ['0', '00', '01', 'abc', '1000', '-1', '1.5', '1e1', '%31', 'x1']) {
    assert.equal((await w.get(`/api/agents/rounds/${created.id}/runs/${n}`)).status, 400, 'GET run ' + n);
    assert.equal((await w.post(`/api/agents/rounds/${created.id}/runs/${n}/classify`, { verdict: 'unclear' })).status, 400, 'classify run ' + n);
  }
  for (const n of ['1', '2', '99']) {
    assert.equal((await w.get(`/api/agents/rounds/${created.id}/runs/${n}`)).status, 404, 'GET run ' + n);
    assert.equal((await w.post(`/api/agents/rounds/${created.id}/runs/${n}/classify`, { verdict: 'unclear' })).status, 404, 'classify run ' + n);
  }
});

test('unknown routes: non-GET is 405, GET is 404, a known address with the wrong method is 405 with Allow', async t => {
  const w = await makeWorld(t);
  /* these answer 405 without any credentials, as before (the historical browser check relies on /api/run) */
  for (const [method, urlPath] of [['POST', '/api/run'], ['POST', '/api/agents/unknown'], ['PUT', '/api/agents/nothing'], ['DELETE', '/api/anything'], ['POST', '/index.html'], ['POST', '/'], ['PATCH', '/api/agents/rounds/rnd-000000000000/other'], ['POST', '/api/agents/rounds/rnd-000000000000/runs/1']]) {
    const bare = await request(w.port, { method, path: urlPath });
    assert.equal(bare.status, 405, `${method} ${urlPath} without credentials`);
    const signed = await w.send(method, urlPath, {});
    assert.equal(signed.status, 405, `${method} ${urlPath} with credentials`);
  }
  assert.equal((await request(w.port, { method: 'HEAD', path: '/' })).status, 405);

  for (const urlPath of ['/api/agents/unknown', '/api/agents', '/api/agents/rounds/rnd-000000000000/other', '/api/nothing', '/api/agents/rounds/rnd-000000000000/runs/1/other/x']) {
    assert.equal((await w.get(urlPath)).status, 404, urlPath);
  }

  const wrong = [
    ['PUT', '/api/agents/rounds', 'GET, POST'],
    ['DELETE', '/api/agents/rounds', 'GET, POST'],
    ['POST', '/api/status', 'GET'],
    ['PUT', '/api/status', 'GET'],
    ['GET', '/api/cancel', 'POST'],
    ['GET', '/api/agents/packet/inspect', 'POST'],
    ['GET', '/api/agents/rounds/rnd-000000000000/launch', 'POST'],
    ['GET', '/api/agents/rounds/rnd-000000000000/freeze', 'POST'],
    ['POST', '/api/agents/rounds/rnd-000000000000', 'GET'],
    ['DELETE', '/api/agents/rounds/rnd-000000000000', 'GET'],
    ['GET', '/api/agents/grader-sim', 'POST'],
    ['PUT', '/api/agents/rounds/rnd-000000000000/runs/1', 'GET'],
    ['GET', '/api/agents/rounds/rnd-000000000000/runs/1/classify', 'POST'],
    ['OPTIONS', '/api/agents/rounds/rnd-000000000000/export', 'POST'],
  ];
  for (const [method, urlPath, allow] of wrong) {
    const response = await w.send(method, urlPath, {});
    assert.equal(response.status, 405, `${method} ${urlPath}`);
    assert.equal(response.headers.allow, allow, `${method} ${urlPath}`);
  }
  assert.deepEqual((await w.get('/api/agents/rounds')).json.rounds, [], 'nothing changed');
});

/* ====================================================================== static files */

test('static files: the allowlist, agents.js, the connect-src rewrite, and nothing else', async t => {
  const w = await makeWorld(t, {}, { serverRoot: REPO });
  assert.ok(ASSETS.has('agents.js'));
  const index = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  assert.ok(index.includes("connect-src 'none'"), 'the shipped page is offline by default');

  for (const urlPath of ['/', '/index.html']) {
    const page = await w.get(urlPath);
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /^text\/html; charset=utf-8/);
    assert.ok(page.text.includes("connect-src 'self'"));
    assert.ok(!page.text.includes("connect-src 'none'"));
    assert.equal(page.text, index.replace("connect-src 'none'", "connect-src 'self'"), 'only the connect-src directive changes');
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['x-frame-options'], 'DENY');
  }
  const wanted = [...ASSETS].filter(name => name !== 'index.html');
  for (const name of ['styles.css', 'core.js', 'catalog.js', 'examples.js', 'playbook.js', 'research-gates.js', 'package-engine.js', 'candidate-engine.js', 'app.js', 'agents.js', 'dashboard.js']) {
    assert.ok(wanted.includes(name), name + ' is on the allowlist');
    const response = await w.get('/' + name);
    assert.equal(response.status, 200, name);
    assert.match(response.headers['content-type'], name.endsWith('.css') ? /^text\/css; charset=utf-8/ : /^text\/javascript; charset=utf-8/);
    assert.equal(response.text, fs.readFileSync(path.join(REPO, name), 'utf8'), name + ' is served byte for byte');
  }
  /* every script and style the page loads is served */
  for (const match of index.matchAll(/(?:src|href)="([a-z-]+\.(?:js|css))"/g)) assert.equal((await w.get('/' + match[1])).status, 200, match[1]);

  for (const urlPath of ['/package.json', '/README.md', '/Finance_Task_Studio.html', '/LOCAL_SERVER.json', '/backend/server.cjs', '/backend/agents/constants.cjs', '/private/model-run.js', '/private/agent-rounds/x', '/tests/agents-server.test.cjs', '/docs/local-agents.md', '/.gitignore', '/%2e%2e/package.json', '/api/../package.json', '/styles.css/../package.json', '/index.html%00.js']) {
    assert.equal((await w.get(urlPath)).status, 404, urlPath);
  }
  assert.equal((await w.get('//etc/passwd')).status, 400);
  assert.equal(w.logs.length, 0, w.logs.join('\n'));
});

test('a missing asset file is a 404, not an error', async t => {
  const w = await makeWorld(t);
  const response = await w.get('/index.html');
  assert.equal(response.status, 404);
  assert.equal(response.text, 'Missing application asset');
});

test('the archived cancel route keeps its checks: Origin and nonce, no content type, no model', async t => {
  const w = await makeWorld(t);
  assert.equal((await request(w.port, { method: 'POST', path: '/api/cancel' })).status, 403);
  assert.equal((await request(w.port, { method: 'POST', path: '/api/cancel', headers: { 'X-Finance-Local': w.app.nonce } })).status, 403);
  assert.equal((await request(w.port, { method: 'POST', path: '/api/cancel', headers: { Origin: w.origin } })).status, 403);
  assert.equal((await request(w.port, { method: 'POST', path: '/api/cancel', headers: { Origin: w.origin, 'X-Finance-Local': 'wrong' } })).status, 403);
  assert.equal((await request(w.port, { method: 'POST', path: '/api/cancel', headers: { Origin: 'http://evil.example', 'X-Finance-Local': w.app.nonce } })).status, 403);
  const accepted = await request(w.port, { method: 'POST', path: '/api/cancel', headers: { Origin: w.origin, 'X-Finance-Local': w.app.nonce } });
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.json, { cancelRequested: true, state: null });
  assert.equal(promptRuns(w.argvLog).length, 0);
});

/* ====================================================================== error mapping */

test('errors: AgentError statuses pass through, everything else is a generic 500 with nothing from the server in it', async t => {
  const real = createAgentService({ root: path.join(os.tmpdir(), 'unused-root-for-errors'), claudeBin: STUB });
  const secretRoot = path.join(os.tmpdir(), 'finance-server-test-secret-root');
  const service = patchedService(real, {
    inspectPacket: async () => { throw new Error(`boom at ${secretRoot}/file.js:12\n    at Object.<anonymous> (${secretRoot}/file.js:12:5)`); },
    createRound: async () => { throw new AgentError(500, `could not write ${secretRoot}/round.json`); },
    getRound: async () => { throw new AgentError(409, 'The packet changed'); },
    freezeRound: async () => { throw new AgentError(418, 'a status that is not offered'); },
    approveRound: async () => { throw 'a thrown string'; },
    launchRound: () => { throw new TypeError('not a function (synchronous)'); },
    exportRound: async () => { throw new AgentError(413, 'too big'); },
    cancelRound: async () => { throw new AgentError(404, 'No such round'); },
    classifyRun: async () => { throw new AgentError(400, 'bad verdict'); },
    refreezeRound: async () => ({ circular: (() => { const loop = {}; loop.self = loop; return loop; })() }),
  });
  const w = await makeWorld(t, {}, { service });
  const expectations = [
    ['POST', '/api/agents/packet/inspect', {}, 500],
    ['POST', '/api/agents/rounds', roundBody(w), 500],
    ['GET', '/api/agents/rounds/rnd-000000000000', undefined, 409],
    ['POST', '/api/agents/rounds/rnd-000000000000/freeze', {}, 500],
    ['POST', '/api/agents/rounds/rnd-000000000000/approve', {}, 500],
    ['POST', '/api/agents/rounds/rnd-000000000000/launch', {}, 500],
    ['POST', '/api/agents/rounds/rnd-000000000000/export', {}, 413],
    ['POST', '/api/agents/rounds/rnd-000000000000/cancel', {}, 404],
    ['POST', '/api/agents/rounds/rnd-000000000000/runs/1/classify', {}, 400],
    ['POST', '/api/agents/rounds/rnd-000000000000/refreeze', {}, 500],
  ];
  for (const [method, urlPath, body, status] of expectations) {
    const response = method === 'GET' ? await w.get(urlPath) : await w.send(method, urlPath, body);
    assert.equal(response.status, status, `${method} ${urlPath}: ${response.text}`);
    assert.deepEqual(Object.keys(response.json), ['error']);
    assert.match(response.headers['content-type'], /^application\/json/);
    if (status === 500) {
      assert.match(response.json.error, /internal error/i);
      for (const leak of [secretRoot, 'boom', 'file.js', ' at ', 'TypeError', 'thrown string', 'circular', 'Converting', os.homedir()]) {
        assert.ok(!response.text.includes(leak), `${urlPath} leaks ${leak}: ${response.text}`);
      }
    }
  }
  /* the operator sees the real cause in the terminal */
  assert.equal(w.logs.length, 6);
  assert.ok(w.logs.some(line => line.includes('boom at')));
  assert.ok(w.logs.some(line => line.includes('a thrown string')));
  assert.equal((await w.get('/api/status')).status, 200, 'the server is still up');
});

test('a client error message that names a server folder has it replaced', async t => {
  const real = createAgentService({ root: path.join(os.tmpdir(), 'unused-root-for-redact'), claudeBin: STUB });
  let w;
  const service = patchedService(real, {
    getRound: async () => { throw new AgentError(409, `Cannot use ${w.projectRoot}/private/agent-rounds/x or ${os.homedir()}/secret`); },
  });
  w = await makeWorld(t, {}, { service });
  const response = await w.get('/api/agents/rounds/rnd-000000000000');
  assert.equal(response.status, 409);
  assert.ok(!response.text.includes(w.projectRoot));
  assert.ok(!response.text.includes(os.homedir()) || os.homedir() === '/');
  assert.match(response.json.error, /<server path>/);
});

test('the list of rounds is wrapped in an object', async t => {
  const w = await makeWorld(t);
  const empty = await w.get('/api/agents/rounds');
  assert.deepEqual(empty.json, { rounds: [] });
  const created = await createRound(w);
  const one = await w.get('/api/agents/rounds');
  assert.equal(one.json.rounds.length, 1);
  assert.equal(one.json.rounds[0].id, created.id);
  assert.equal(one.json.rounds[0].status, 'draft');
});

test('the author review route answers 404 when the service does not offer it, then passes the body through', async t => {
  const unused = createAgentService({ root: path.join(os.tmpdir(), 'unused-root-for-review'), claudeBin: STUB });
  const none = await makeWorld(t, {}, { service: patchedService(unused, { authorReview: undefined }) });
  const missing = await none.post('/api/agents/author-review', { model: 'claude-opus-5-5' });
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /not available/);
  assert.equal(promptRuns(none.argvLog).length, 0);

  const real = createAgentService({ root: path.join(os.tmpdir(), 'unused-root-for-review'), claudeBin: STUB });
  const seen = [];
  const offered = await makeWorld(t, {}, { service: patchedService(real, { authorReview: async body => { seen.push(body); return { text: 'reviewed' }; } }) });
  const response = await offered.post('/api/agents/author-review', { model: 'claude-opus-5-5', promptText: 'p' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { text: 'reviewed' });
  assert.deepEqual(seen, [{ model: 'claude-opus-5-5', promptText: 'p' }]);
  assert.equal((await offered.send('POST', '/api/agents/author-review', {}, { 'X-Finance-Local': 'wrong' })).status, 403);
  assert.equal(seen.length, 1);
});

test('the author review route runs one tool-less review through the real service', async t => {
  const w = await makeWorld(t, { resultText: 'The prompt asks for a liquidity read. The facility terms are ambiguous about availability.' });
  const bad = await w.post('/api/agents/author-review', { model: 'claude-opus-5-5', promptText: 'p' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /packageText/);
  assert.equal(promptRuns(w.argvLog).length, 0, 'a refused request starts nothing');
  const wrongModel = await w.post('/api/agents/author-review', { packageText: 'FILE a.txt', model: 'gpt-5' });
  assert.equal(wrongModel.status, 400);
  const ok = await w.post('/api/agents/author-review', { packageText: 'FILE Facility_Terms.txt\n  A1: Available credit is not cash.', promptText: PROMPT, model: 'claude-sonnet-5-5', bin: '/bin/sh', args: ['-c', 'true'] });
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.json.text, /facility terms are ambiguous/);
  assert.equal(ok.json.model, 'claude-sonnet-5-5');
  assert.match(ok.json.label, /not a blind pilot and not a score/);
  const [args] = promptRuns(w.argvLog);
  assert.equal(args[0], '-p');
  assert.match(args[1], /<<<PACKAGE\nFILE Facility_Terms.txt/);
  assert.deepEqual(args.slice(2, 5), ['--model', 'claude-sonnet-5-5', '--effort']);
  assert.equal(args[args.indexOf('--tools') + 1], '', 'no tools');
  assert.ok(!args.includes('--allowedTools'));
  assert.ok(!args.includes('/bin/sh'), 'the browser cannot supply a binary or an argument');
});

/* ====================================================================== the full flow */

test('full flow: inspect, create, freeze, approval summary, approve, launch, poll, classify, export', async t => {
  const w = await makeWorld(t, [
    { resultText: GOLD_ANSWER, toolUses: [{ name: 'Bash', input: { command: 'ls filesystem' } }], writeFiles: [{ path: 'outputs/answer.txt', content: 'Usable cash 1,250' }] },
    { resultText: WRONG_ANSWER },
  ]);

  /* 1. the page reads the status and keeps the nonce */
  const status = await w.get('/api/status');
  assert.equal(status.status, 200);
  const nonce = status.json.nonce;
  assert.equal(nonce, w.app.nonce);
  assert.equal(status.json.agents.runtime.found, true);

  /* 2. inspect the packet folder */
  const inspected = await w.send('POST', '/api/agents/packet/inspect', { sourceDir: w.source }, { 'X-Finance-Local': nonce });
  assert.equal(inspected.status, 200, inspected.text);
  const byPath = new Map(inspected.json.files.map(file => [file.path, file]));
  assert.deepEqual([...byPath.keys()].sort(), ['Answer_Key.txt', 'Cash_Facts.csv', 'Facility_Terms.txt', 'gaf/Template_Layout.txt']);
  for (const file of inspected.json.files) {
    assert.deepEqual(Object.keys(file).sort(), ['bytes', 'defaultInclude', 'inferredRole', 'path', 'reason', 'sha256']);
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(byPath.get('Answer_Key.txt').defaultInclude, false, 'grading material is off by default');
  assert.equal(byPath.get('Facility_Terms.txt').defaultInclude, true);
  assert.ok(!inspected.text.includes(w.base), 'the listing carries relative paths only');

  /* 3. create a round. Keys that try to supply a command, a binary, arguments or a folder are ignored. */
  const include = inspected.json.files.filter(file => file.defaultInclude).map(file => file.path);
  const created = await w.post('/api/agents/rounds', roundBody(w, {
    include,
    config: { model: 'claude-opus-5-5', effort: 'medium', count: 2, bin: '/bin/sh', args: ['-c', 'echo hacked'], folder: '/etc', cwd: '/etc', env: { TMPDIR: '/etc' } },
    bin: '/bin/sh',
    binary: '/usr/bin/env',
    args: ['-c', 'echo hacked'],
    argv: ['--dangerously-skip-permissions'],
    command: 'rm -rf /',
    folder: '/etc',
    cwd: '/',
    env: { TMPDIR: '/etc', PATH: '/nowhere' },
  }));
  assert.equal(created.status, 200, created.text);
  const id = created.json.id;
  assert.match(id, /^rnd-[0-9a-f]{12}$/);
  assert.equal(created.json.status, 'draft');
  assert.equal(created.json.config.count, 2);
  assert.deepEqual(created.json.config.tools, ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']);
  assert.deepEqual(created.json.runs, []);
  assert.equal(created.json.freeze, null);
  assert.ok(!('approvalSummary' in created.json), 'nothing to approve before the gold is frozen');
  assert.deepEqual(created.json.packet.files.filter(file => file.include).map(file => file.path).sort(), include.slice().sort());
  assert.match(created.json.packet.packetSha256, /^[0-9a-f]{64}$/);
  assert.equal(created.json.packet.gafVisible, true);

  /* 4. nothing can be approved or launched before the freeze */
  const early = await w.post(`/api/agents/rounds/${id}/approve`, { summarySha256: 'f'.repeat(64), acknowledgements: ACK });
  assert.equal(early.status, 409);
  assert.match(early.json.error, /Freeze the gold/);
  assert.equal((await w.post(`/api/agents/rounds/${id}/launch`)).status, 409);

  /* 5. freeze, and read the approval summary that comes with a frozen round */
  const frozen = await w.post(`/api/agents/rounds/${id}/freeze`, GOLD);
  assert.equal(frozen.status, 200, frozen.text);
  assert.equal(frozen.json.status, 'frozen');
  assert.match(frozen.json.freeze.sha256, /^[0-9a-f]{64}$/);
  assert.equal(frozen.json.freeze.postHoc, false);
  assert.match(frozen.json.summarySha256, /^[0-9a-f]{64}$/);
  const summary = frozen.json.approvalSummary;
  assert.equal(summary.summarySha256, frozen.json.summarySha256);
  assert.equal(summary.model, 'claude-opus-5-5');
  assert.equal(summary.effort, 'medium');
  assert.equal(summary.count, 2);
  assert.deepEqual(summary.tools, ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']);
  assert.equal(summary.packetSha256, created.json.packet.packetSha256);
  assert.equal(summary.freezeSha256, frozen.json.freeze.sha256);
  assert.equal(summary.gafVisible, true);
  assert.deepEqual(summary.overrides, []);
  assert.match(summary.commandLine, /^claude -p "<prompt elided>" --model claude-opus-5-5 --effort medium --output-format stream-json --verbose --tools /);
  assert.ok(!summary.commandLine.includes('Atlas'), 'the prompt is elided');
  assert.ok(!summary.commandLine.includes('/bin/sh') && !summary.commandLine.includes('hacked'));
  assert.match(summary.text, /not by an operating system sandbox/);
  assert.match(summary.text, /Shell access/);
  assert.match(summary.text, /Network/);
  assert.match(summary.text, /Directional only|directional only/);
  assert.ok(!summary.text.includes(w.base), 'the summary prints no absolute path');
  assert.ok(!summary.text.includes(os.tmpdir() + path.sep), 'the summary prints no absolute path');
  const reread = await w.get(`/api/agents/rounds/${id}`);
  assert.equal(reread.json.summarySha256, frozen.json.summarySha256, 'the same hash on every read');

  /* 6. approval needs the exact hash and all three acknowledgements */
  for (const wrongHash of ['f'.repeat(64), '', frozen.json.summarySha256.toUpperCase(), frozen.json.summarySha256.slice(1), frozen.json.freeze.sha256]) {
    const refused = await w.post(`/api/agents/rounds/${id}/approve`, { summarySha256: wrongHash, acknowledgements: ACK });
    assert.equal(refused.status, 409, 'hash ' + wrongHash);
    assert.match(refused.json.error, /approval hash/);
  }
  assert.equal((await w.post(`/api/agents/rounds/${id}/approve`, { acknowledgements: ACK })).status, 409);
  assert.equal((await w.post(`/api/agents/rounds/${id}/approve`, { summarySha256: 12345, acknowledgements: ACK })).status, 409);
  for (const acknowledgements of [[], ACK.slice(1), ['shell-access', 'network'], [...ACK, 'extra'], 'shell-access,network,isolation-by-audit', undefined]) {
    const refused = await w.post(`/api/agents/rounds/${id}/approve`, { summarySha256: frozen.json.summarySha256, acknowledgements });
    assert.equal(refused.status, 400, JSON.stringify(acknowledgements));
  }
  assert.equal(await roundStatus(w, id), 'frozen', 'still frozen after the refusals');
  assert.equal((await w.post(`/api/agents/rounds/${id}/launch`)).status, 409, 'launch without approval');
  assert.equal(promptRuns(w.argvLog).length, 0);

  const approved = await w.post(`/api/agents/rounds/${id}/approve`, { summarySha256: frozen.json.summarySha256, acknowledgements: ACK });
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.json.status, 'approved');
  assert.deepEqual(approved.json.approval.acknowledgements, ACK);
  assert.equal(approved.json.approval.summarySha256, frozen.json.summarySha256);
  assert.equal(approved.json.summarySha256, frozen.json.summarySha256);
  assert.equal((await w.post(`/api/agents/rounds/${id}/approve`, { summarySha256: frozen.json.summarySha256, acknowledgements: ACK })).status, 409, 'approved once');
  assert.equal((await w.post(`/api/agents/rounds/${id}/freeze`, GOLD)).status, 409, 'the gold is not editable after approval');
  assert.equal((await w.post(`/api/agents/rounds/${id}/refreeze`, GOLD)).status, 409, 'nothing launched yet, so no post-hoc version');
  assert.equal(promptRuns(w.argvLog).length, 0, 'approval alone runs nothing');

  /* 7. launch returns at once and the page polls */
  const launched = await w.post(`/api/agents/rounds/${id}/launch`);
  assert.equal(launched.status, 200, launched.text);
  assert.equal(launched.json.status, 'running');
  assert.equal(launched.json.runs.length, 2);
  assert.equal((await w.post(`/api/agents/rounds/${id}/launch`)).status, 409, 'launched once');
  assert.equal((await w.post(`/api/agents/rounds/${id}/freeze`, GOLD)).status, 409, 'no new freeze after launch');
  await waitFor(async () => (await roundStatus(w, id)) === 'finished', { label: 'the round to finish' });

  const finished = (await w.get(`/api/agents/rounds/${id}`)).json;
  assert.equal(finished.status, 'finished');
  assert.deepEqual(finished.runs.map(run => run.state), ['completed', 'completed']);
  assert.deepEqual(finished.runs.map(run => run.audit.status), ['CLEAN', 'CLEAN']);
  assert.deepEqual(finished.runs.map(run => run.classification.suggestedVerdict), ['matches-frozen-gold', 'fingerprint']);
  assert.equal(finished.counts.completed, 2);
  assert.equal(finished.counts.clean, 2);
  assert.match(finished.directional, /Directional only, n = 2\./);
  for (const run of finished.runs) {
    assert.equal(run.folder, `finance-studio-pilots/${id}-${run.n}`, 'the run folder is reported without its location');
    assert.equal(run.resolvedModel, 'claude-opus-5-5');
  }
  assert.ok(!JSON.stringify(finished.runs).includes(w.tmpRoot), 'no pilot folder path in the round view');
  const list = (await w.get('/api/agents/rounds')).json.rounds;
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'finished');

  /* 8. the arguments were the fixed ones, whatever the create request carried */
  const runs = promptRuns(w.argvLog);
  assert.equal(runs.length, 2);
  for (const args of runs) assert.deepEqual(args, expectedArgs(PROMPT));
  const envs = readJsonLines(w.envLog);
  assert.equal(envs.length, 2);
  const realPilots = fs.realpathSync(w.pilots);
  for (const entry of envs) {
    const cwd = fs.realpathSync(entry.cwd);
    assert.ok(cwd.startsWith(realPilots + path.sep), 'the pilot runs inside the pilots folder: ' + cwd);
    assert.equal(fs.realpathSync(entry.TMPDIR), path.join(cwd, '.tmp'));
    assert.equal(fs.realpathSync(entry.CLAUDE_CODE_TMPDIR), path.join(cwd, '.tmp'));
  }

  /* 9. run detail */
  const detail = await w.get(`/api/agents/rounds/${id}/runs/1`);
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.json.final.text, GOLD_ANSWER);
  assert.equal(detail.json.state, 'completed');
  assert.equal(detail.json.audit.status, 'CLEAN');
  assert.deepEqual(detail.json.solverFiles.slice().sort(), include.slice().sort());
  assert.ok(!detail.json.solverFiles.includes('Answer_Key.txt'));
  assert.deepEqual(detail.json.outputs.map(output => output.name), ['answer.txt']);
  assert.equal(detail.json.toolCalls.bash, 1);
  assert.ok(!('manifest' in detail.json));
  assert.equal(detail.json.folder, `finance-studio-pilots/${id}-1`);

  /* 10. classify: refusals first, then the human verdicts */
  const classify = (n, body) => w.post(`/api/agents/rounds/${id}/runs/${n}/classify`, body);
  assert.equal((await classify(1, { verdict: 'nonsense' })).status, 400);
  assert.equal((await classify(1, {})).status, 400);
  assert.equal((await classify(2, { verdict: 'fingerprint', fingerprintIds: [] })).status, 400);
  assert.equal((await classify(2, { verdict: 'fingerprint', fingerprintIds: ['fp-nope'] })).status, 400);
  assert.equal((await classify(1, { verdict: 'matches-frozen-gold', fingerprintIds: ['fp-credit'] })).status, 400);
  assert.equal((await classify(3, { verdict: 'unclear' })).status, 404);
  assert.equal((await w.send('POST', `/api/agents/rounds/${id}/runs/1/classify`, { verdict: 'unclear' }, { 'X-Finance-Local': 'wrong' })).status, 403);
  const first = await classify(1, { verdict: 'matches-frozen-gold', fingerprintIds: [], note: 'Matches the frozen gold.' });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.classification.human.verdict, 'matches-frozen-gold');
  assert.equal(first.json.classification.suggested.verdict, 'matches-frozen-gold', 'the suggestion stays beside the human verdict');
  const second = await classify(2, { verdict: 'fingerprint', fingerprintIds: ['fp-credit'], note: '' });
  assert.equal(second.status, 200, second.text);
  assert.deepEqual(second.json.classification.human.fingerprintIds, ['fp-credit']);

  /* 11. export validates through the project's own checks */
  const exported = await w.post(`/api/agents/rounds/${id}/export`);
  assert.equal(exported.status, 200, exported.text);
  assert.equal(exported.json.schema, 'finance-agent-round-export');
  assert.equal(exported.json.roundId, id);
  assert.match(exported.json.directional, /Directional only, n = 2\./);
  assert.equal(exported.json.records.length, 2);
  assert.deepEqual(exported.json.discarded, []);
  assert.deepEqual(exported.json.excluded, []);
  assert.deepEqual(exported.json.records.map(record => record.classification), ['no-root-failure', 'model-error']);
  assert.deepEqual(exported.json.records.map(record => record.rootFailures), [[], ['fp-credit']]);
  const project = core.blank();
  const experiments = exported.json.records.map((record, index) => ({
    id: `exp-${index}`,
    runId: record.runId,
    date: record.date,
    model: record.model,
    score: '',
    scoreMax: '',
    evidence: record.evidence,
    notes: record.notes,
    snapshot: core.snapshot(project),
    versions: record.versions,
    classification: record.classification,
    rootFailures: record.rootFailures,
  }));
  experiments.forEach(experiment => assert.doesNotThrow(() => core.validateExperiment(experiment)));
  project.experiments = experiments;
  assert.equal(core.parseProject(JSON.stringify(project)).experiments.length, 2);

  /* 12. a post-hoc freeze after launch keeps the original beside it */
  const refrozen = await w.post(`/api/agents/rounds/${id}/refreeze`, { ...GOLD, gold: { ...GOLD.gold, notes: 'Changed after seeing outputs' } });
  assert.equal(refrozen.status, 200, refrozen.text);
  assert.equal(refrozen.json.postHocFreezes.length, 1);
  assert.equal(refrozen.json.postHocFreezes[0].postHoc, true);
  assert.equal(refrozen.json.freeze.sha256, frozen.json.freeze.sha256, 'the original freeze is untouched');
  assert.ok(!('summarySha256' in refrozen.json), 'a finished round has nothing left to approve');

  /* 13. the cancel route on a finished round */
  assert.equal((await w.post(`/api/agents/rounds/${id}/cancel`)).status, 409);
  assert.equal(w.logs.length, 0, w.logs.join('\n'));
});

test('a file that looks like grading material needs an override by name, and the override is recorded', async t => {
  const w = await makeWorld(t);
  const refused = await w.post('/api/agents/rounds', roundBody(w, { include: ['Facility_Terms.txt', 'Answer_Key.txt'] }));
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /grading material/);
  assert.equal((await w.post('/api/agents/rounds', roundBody(w, { include: ['Facility_Terms.txt', 'Answer_Key.txt'], overrides: ['Cash_Facts.csv'] }))).status, 400, 'an override must name a selected file');
  const allowed = await w.post('/api/agents/rounds', roundBody(w, { include: ['Facility_Terms.txt', 'Answer_Key.txt'], overrides: ['Answer_Key.txt'] }));
  assert.equal(allowed.status, 200, allowed.text);
  assert.deepEqual(allowed.json.packet.files.filter(file => file.overridden).map(file => file.path), ['Answer_Key.txt']);
  const frozen = await w.post(`/api/agents/rounds/${allowed.json.id}/freeze`, GOLD);
  assert.deepEqual(frozen.json.approvalSummary.overrides, ['Answer_Key.txt']);
  assert.match(frozen.json.approvalSummary.text, /Overridden files: Answer_Key\.txt/);
});

/* ====================================================================== refusals */

test('round creation refuses a pilot count above the cap and every other value that is not 1 to 5', async t => {
  const w = await makeWorld(t);
  for (const count of [6, 7, 100, 0, -1, 2.5, '3', null, undefined, NaN, Infinity, [], {}, true]) {
    const response = await w.post('/api/agents/rounds', roundBody(w, { config: { model: 'claude-opus-5-5', effort: 'medium', count } }));
    assert.equal(response.status, 400, 'count ' + JSON.stringify(count) + ' ' + response.text);
  }
  assert.equal((await w.post('/api/agents/rounds', roundBody(w, { config: { model: 'claude-opus-5-5', effort: 'medium' } }))).status, 400, 'no count');
  assert.equal((await w.post('/api/agents/rounds', roundBody(w, { config: undefined }))).status, 400, 'no config');
  const six = await w.post('/api/agents/rounds', roundBody(w, { config: { count: 6 } }));
  assert.match(six.json.error, /from 1 to 5/);
  assert.deepEqual((await w.get('/api/agents/rounds')).json.rounds, [], 'nothing was created');
  for (const count of [1, 2, 3, 4, 5]) {
    const response = await w.post('/api/agents/rounds', roundBody(w, { config: { count } }));
    assert.equal(response.status, 200, 'count ' + count);
    assert.equal(response.json.config.count, count);
    assert.equal(response.json.config.model, C.DEFAULT_MODEL);
    assert.equal(response.json.config.effort, C.DEFAULT_EFFORT);
  }
  assert.equal(promptRuns(w.argvLog).length, 0);
});

test('round creation refuses models, efforts and tool lists outside the allowlists, and missing fields', async t => {
  const w = await makeWorld(t);
  const config = extra => ({ model: 'claude-opus-5-5', effort: 'medium', count: 1, ...extra });
  const refusals = [
    roundBody(w, { config: config({ model: 'gpt-5' }) }),
    roundBody(w, { config: config({ model: '--dangerously-skip-permissions' }) }),
    roundBody(w, { config: config({ model: 'claude-opus-5-5 --foo' }) }),
    roundBody(w, { config: config({ effort: 'extreme' }) }),
    roundBody(w, { config: config({ tools: ['Bash', 'WebFetch'] }) }),
    roundBody(w, { config: config({ tools: ['Bash'] }) }),
    roundBody(w, { config: config({ tools: 'Bash' }) }),
    roundBody(w, { config: config({ kind: 'grader-sim' }) }),
    roundBody(w, { gafVisible: undefined }),
    roundBody(w, { gafVisible: 'yes' }),
    roundBody(w, { promptText: undefined }),
    roundBody(w, { promptText: '   ' }),
    roundBody(w, { promptText: 'a\0b' }),
    roundBody(w, { promptText: 5 }),
    roundBody(w, { sourceDir: undefined }),
    roundBody(w, { sourceDir: 5 }),
    roundBody(w, { include: [] }),
    roundBody(w, { include: 'Facility_Terms.txt' }),
    roundBody(w, { include: ['Facility_Terms.txt', 'Facility_Terms.txt'] }),
    roundBody(w, { include: ['../project/private'] }),
    roundBody(w, { include: ['../../../../etc/passwd'] }),
    roundBody(w, { include: ['/etc/passwd'] }),
    roundBody(w, { include: ['missing.txt'] }),
    roundBody(w, { versions: { prompt: 'p' } }),
  ];
  for (const body of refusals) {
    const response = await w.post('/api/agents/rounds', body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 200) + ' ' + response.text);
  }
  assert.deepEqual((await w.get('/api/agents/rounds')).json.rounds, []);
});

test('a source folder inside the project, holding the project, or not usable is refused', async t => {
  const w = await makeWorld(t);
  fs.mkdirSync(path.join(w.projectRoot, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(w.projectRoot, 'sub', 'notes.txt'), 'synthetic');
  fs.writeFileSync(path.join(w.projectRoot, 'private', 'evidence.txt'), 'synthetic private material');
  const link = path.join(w.base, 'link-to-project');
  fs.symlinkSync(w.projectRoot, link);
  const linkToPrivate = path.join(w.base, 'link-to-private');
  fs.symlinkSync(path.join(w.projectRoot, 'private'), linkToPrivate);
  const aFile = path.join(w.source, 'Cash_Facts.csv');

  const refused = [
    w.projectRoot,
    w.projectRoot + path.sep,
    path.join(w.projectRoot, 'sub'),
    path.join(w.projectRoot, 'private'),
    path.join(w.projectRoot, 'private', 'agent-rounds'),
    path.join(w.projectRoot, 'sub', '..', 'private'),
    link,
    linkToPrivate,
    w.base,
    path.dirname(w.base),
    path.join(w.source, '..', 'project', 'private'),
    path.join(w.base, 'does-not-exist'),
    aFile,
    'source',
    './source',
    '../source',
    '~',
    '',
    '   ',
    'x'.repeat(5000),
    w.source + '\0',
  ];
  for (const sourceDir of refused) {
    const inspect = await w.post('/api/agents/packet/inspect', { sourceDir });
    assert.ok([400, 413].includes(inspect.status), `inspect ${JSON.stringify(sourceDir).slice(0, 80)} -> ${inspect.status} ${inspect.text.slice(0, 200)}`);
    const create = await w.post('/api/agents/rounds', roundBody(w, { sourceDir }));
    assert.ok([400, 413].includes(create.status), `create ${JSON.stringify(sourceDir).slice(0, 80)} -> ${create.status}`);
    for (const response of [inspect, create]) {
      assert.ok(!response.text.includes('synthetic private material'));
      assert.ok(!response.text.includes('evidence.txt'));
    }
  }
  const insideMessage = await w.post('/api/agents/packet/inspect', { sourceDir: path.join(w.projectRoot, 'private') });
  assert.equal(insideMessage.status, 400);
  assert.match(insideMessage.json.error, /inside the Studio project/);
  assert.deepEqual((await w.get('/api/agents/rounds')).json.rounds, [], 'no round came from a refused folder');
  assert.equal(promptRuns(w.argvLog).length, 0);
});

test('earlier pilot folders can never become a packet source', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER });
  const id = await finishedRound(w);
  const pilotFolder = path.join(w.pilots, `${id}-1`);
  assert.ok(fs.existsSync(pilotFolder));
  for (const sourceDir of [w.pilots, pilotFolder, w.tmpRoot, path.join(pilotFolder, 'outputs')]) {
    const response = await w.post('/api/agents/packet/inspect', { sourceDir });
    assert.equal(response.status, 400, sourceDir + ' ' + response.text);
  }
});

test('freeze bodies are validated, and nothing can launch without a freeze and an approval', async t => {
  const w = await makeWorld(t);
  const created = await createRound(w);
  const where = tail => `/api/agents/rounds/${created.id}${tail}`;
  for (const body of [{}, { gold: {} }, { gold: { decision: '' } }, { gold: 'hold' }, { gold: { figures: [{ label: 'x', value: 'abc' }] } }, { gold: { decision: 'hold' }, fingerprints: 'x' }, { gold: { decision: 'hold' }, fingerprints: [{ id: 'bad id!', tokens: ['a'] }] }, { gold: { decision: 'hold' }, fingerprints: [{ id: 'fp-a' }] }]) {
    assert.equal((await w.post(where('/freeze'), body)).status, 400, JSON.stringify(body));
  }
  assert.equal(await roundStatus(w, created.id), 'draft');
  assert.equal((await w.post(where('/launch'))).status, 409, 'draft');
  assert.equal((await w.post(where('/approve'), { summarySha256: 'a'.repeat(64), acknowledgements: ACK })).status, 409, 'draft');
  assert.equal((await w.post(where('/export'))).status, 409, 'no runs to export');
  const frozen = await w.post(where('/freeze'), GOLD);
  assert.equal(frozen.status, 200);
  assert.equal((await w.post(where('/launch'))).status, 409, 'frozen but not approved');
  const again = await w.post(where('/freeze'), { ...GOLD, gold: { ...GOLD.gold, decision: 'proceed' } });
  assert.equal(again.status, 200, 'before approval the gold can still be replaced');
  assert.notEqual(again.json.freeze.sha256, frozen.json.freeze.sha256);
  assert.notEqual(again.json.summarySha256, frozen.json.summarySha256, 'a new freeze is a new summary, so an old approval hash no longer works');
  assert.equal((await w.post(where('/approve'), { summarySha256: frozen.json.summarySha256, acknowledgements: ACK })).status, 409);
  assert.equal(promptRuns(w.argvLog).length, 0, 'no refusal started a model');
});

test('a changed packet file stops the launch with PACKET HASH MISMATCH and nothing starts', async t => {
  const w = await makeWorld(t);
  const approved = await approvedRound(w);
  fs.appendFileSync(path.join(w.source, 'Facility_Terms.txt'), 'edited after approval\n');
  const launch = await w.post(`/api/agents/rounds/${approved.id}/launch`);
  assert.equal(launch.status, 409);
  assert.match(launch.json.error, /PACKET HASH MISMATCH/);
  assert.equal(promptRuns(w.argvLog).length, 0);
  assert.equal(await roundStatus(w, approved.id), 'approved');
  assert.equal(fs.existsSync(w.pilots), false, 'no pilot folder was built');
});

/* ====================================================================== running rounds */

test('a DISCARDED run cannot be classified and is exported only in the separate list', async t => {
  const w = await makeWorld(t, { resultText: GOLD_ANSWER, toolUses: [{ name: 'Read', input: { file_path: '/opt/outside-the-folder/notes.txt' } }] });
  const id = await finishedRound(w);
  const round = (await w.get(`/api/agents/rounds/${id}`)).json;
  assert.equal(round.runs[0].state, 'completed');
  assert.equal(round.runs[0].audit.status, 'DISCARDED');
  assert.equal(round.runs[0].audit.violationCount, 1);
  assert.equal(round.runs[0].classification, null, 'a discarded run gets no suggestion');
  const detail = (await w.get(`/api/agents/rounds/${id}/runs/1`)).json;
  assert.equal(detail.audit.violations[0].kind, 'abs');
  assert.equal(detail.audit.violations[0].path, '/opt/outside-the-folder/notes.txt');
  const classify = await w.post(`/api/agents/rounds/${id}/runs/1/classify`, { verdict: 'matches-frozen-gold' });
  assert.equal(classify.status, 409);
  assert.match(classify.json.error, /DISCARDED/);
  const exported = (await w.post(`/api/agents/rounds/${id}/export`)).json;
  assert.deepEqual(exported.records, []);
  assert.equal(exported.discarded.length, 1);
  assert.equal(exported.discarded[0].audit, 'DISCARDED');
  assert.equal(exported.discarded[0].violations[0].kind, 'abs');
});

test('cancel stops a running round, a second round cannot start meanwhile, and a second cancel is refused', async t => {
  const w = await makeWorld(t, { hang: true }, { limits: { killGraceMs: 200 } });
  const first = await approvedRound(w, { config: { model: 'claude-opus-5-5', effort: 'medium', count: 2 } });
  const second = await approvedRound(w);
  assert.equal((await w.post(`/api/agents/rounds/${first.id}/launch`)).status, 200);
  await waitFor(async () => (await w.get(`/api/agents/rounds/${first.id}`)).json.runs.some(run => run.state === 'running'), { label: 'a pilot to be running' });
  const blocked = await w.post(`/api/agents/rounds/${second.id}/launch`);
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.error, /Another round is running/);

  const cancelled = await w.post(`/api/agents/rounds/${first.id}/cancel`);
  assert.equal(cancelled.status, 200, cancelled.text);
  await waitFor(async () => (await roundStatus(w, first.id)) === 'cancelled', { label: 'the round to be cancelled' });
  const after = (await w.get(`/api/agents/rounds/${first.id}`)).json;
  assert.ok(after.runs.every(run => run.state === 'cancelled'), JSON.stringify(after.runs.map(run => run.state)));
  assert.equal((await w.post(`/api/agents/rounds/${first.id}/cancel`)).status, 409);

  /* an approved round that never ran can be cancelled too, and then it cannot be launched */
  assert.equal((await w.post(`/api/agents/rounds/${second.id}/cancel`)).status, 200);
  assert.equal((await w.post(`/api/agents/rounds/${second.id}/launch`)).status, 409);
});

test('shutdown cancels a running round before the server closes, and then nothing answers', async t => {
  const w = await makeWorld(t, { hang: true }, { limits: { killGraceMs: 200 } });
  const approved = await approvedRound(w);
  assert.equal((await w.post(`/api/agents/rounds/${approved.id}/launch`)).status, 200);
  await waitFor(async () => (await w.get(`/api/agents/rounds/${approved.id}`)).json.runs.some(run => run.state === 'running'), { label: 'a pilot to be running' });
  await w.app.shutdown();
  const round = await w.service.getRound(approved.id);
  assert.equal(round.status, 'cancelled');
  assert.deepEqual(round.runs.map(run => run.state), ['cancelled']);
  await assert.rejects(w.get('/api/status'), error => error.code === 'ECONNREFUSED');
  await w.app.shutdown(); /* idempotent */
});

test('GET /runs/:n returns that run, not the first one', async t => {
  const w = await makeWorld(t, [{ resultText: GOLD_ANSWER }, { resultText: WRONG_ANSWER }]);
  const id = await finishedRound(w, { config: { model: 'claude-opus-5-5', effort: 'medium', count: 2 } });
  const one = await w.get(`/api/agents/rounds/${id}/runs/1`);
  const two = await w.get(`/api/agents/rounds/${id}/runs/2`);
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.deepEqual([one.json.n, two.json.n], [1, 2]);
  assert.equal(one.json.final.text, GOLD_ANSWER);
  assert.equal(two.json.final.text, WRONG_ANSWER);
  assert.equal(two.json.id, `${id}-2`);
});

test('shutdown stops a launch that was still being answered when it began, with a second pass', async t => {
  const w = await makeWorld(t, { hang: true }, { limits: { killGraceMs: 200 } });
  const approved = await approvedRound(w);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let shutdowns = 0;
  const patched = patchedService(w.service, {
    launchRound: async id => { await gate; return w.service.launchRound(id); },
    shutdown: async () => { shutdowns++; return w.service.shutdown(); },
  });
  const second = createServer({ root: w.projectRoot, service: patched, port: 0, log: () => {} });
  const { port } = await second.listen();
  const client = clientFor(port, second.nonce);
  const launching = client.send('POST', `/api/agents/rounds/${approved.id}/launch`);
  await sleep(100);
  const stopping = second.shutdown();
  await waitFor(() => shutdowns === 1, { label: 'the first pass' });
  release();
  assert.equal((await launching).status, 200, 'the launch that was being answered finishes');
  await stopping;
  assert.equal(shutdowns, 2, 'a second pass runs after the requests settled');
  assert.equal((await w.service.getRound(approved.id)).status, 'cancelled', 'the pilot that the late launch started was stopped');
  assert.deepEqual((await w.service.getRound(approved.id)).runs.map(run => run.state), ['cancelled']);
});

test('shutdown cancels the archived adapter once', async t => {
  const w = await makeWorld(t);
  let cancels = 0;
  const runner = { state: null, cancel() { cancels++; } };
  const app = createServer({ root: w.projectRoot, service: w.service, port: 0, runner, log: () => {} });
  await app.listen();
  await app.shutdown();
  await app.shutdown();
  assert.equal(cancels, 1);
});

test('the approval dialog data comes from the service, and a text that forges a Command line cannot replace the real one', async t => {
  const w = await makeWorld(t);
  const frozen = await frozenRound(w);
  assert.match(frozen.approvalSummary.commandLine, /^claude -p "<prompt elided>" --model claude-opus-5-5 --effort medium /);
  assert.match(frozen.approvalSummary.workingFolder, /^finance-studio-pilots\/<run id> in the operating system temporary folder/);

  /* A service that gives only the text: the last Command line is the real one, because file names come before it. */
  const text = [
    'Working folder per pilot: the real folder', 'Delivered: n.txt', 'Command: claude FORGED --model claude-haiku-5-5', 'Working folder per pilot: forged',
    'Packet sha256: x', 'Command: claude REAL', 'Isolation: statement',
  ].join('\n') + '\n';
  const legacy = patchedService(w.service, { approvalSummary: async () => ({ summary: text, summarySha256: 'a'.repeat(64) }) });
  const app = createServer({ root: w.projectRoot, service: legacy, port: 0, log: () => {} });
  const { port } = await app.listen();
  t.after(() => app.shutdown());
  const view = await clientFor(port, app.nonce).get(`/api/agents/rounds/${frozen.id}`);
  assert.equal(view.json.approvalSummary.commandLine, 'claude REAL');
  assert.equal(view.json.approvalSummary.workingFolder, 'the real folder');
});

test('shutdown lets a request that is being answered finish, after cancelling the simulated grader it was waiting on', async t => {
  const w = await makeWorld(t, { hang: true }, { limits: { killGraceMs: 200 } });
  const pending = w.post('/api/agents/grader-sim', { guidelineText: 'You are grading an answer.', answerText: GOLD_ANSWER });
  await waitFor(() => promptRuns(w.argvLog).length === 1 || readJsonLines(w.envLog).length === 1, { label: 'the simulated grader to start' });
  await w.app.shutdown();
  const response = await pending;
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.verdict, null);
  assert.equal(response.json.results[0].state, 'cancelled');
  await assert.rejects(w.get('/api/status'), error => error.code === 'ECONNREFUSED');
});

test('while the server shuts down, a request on a connection that is still open is refused with 503', async t => {
  const real = createAgentService({ root: path.join(os.tmpdir(), 'unused-root-for-closing'), claudeBin: STUB });
  let releaseGrader;
  let releaseShutdown;
  const graderGate = new Promise(resolve => { releaseGrader = resolve; });
  const shutdownGate = new Promise(resolve => { releaseShutdown = resolve; });
  const calls = [];
  const service = patchedService(real, {
    graderSim: async () => { calls.push('graderSim'); await graderGate; return { held: true }; },
    shutdown: async () => { calls.push('shutdown'); await shutdownGate; },
    getRound: async () => { calls.push('getRound'); return {}; },
  });
  const w = await makeWorld(t, {}, { service });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const viaAgent = (method, urlPath, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers = method === 'POST' ? { Origin: w.origin, 'Content-Type': 'application/json', 'X-Finance-Local': w.app.nonce, 'Content-Length': payload.length } : {};
    const req = http.request({ host: '127.0.0.1', port: w.port, method, path: urlPath, headers, agent }, res => {
      const parts = [];
      res.on('data', part => parts.push(part));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(payload);
  });

  const held = viaAgent('POST', '/api/agents/grader-sim', { guidelineText: 'g', answerText: 'a' });
  await waitFor(() => calls.includes('graderSim'), { label: 'the request to be in progress' });
  const stopping = w.app.shutdown();
  await waitFor(() => calls.includes('shutdown'), { label: 'the shutdown to begin' });
  releaseGrader();
  assert.equal((await held).status, 200, 'the request that was being answered finishes');

  const late = await viaAgent('GET', '/api/agents/rounds/rnd-000000000000');
  assert.equal(late.status, 503, late.text);
  assert.ok(!calls.includes('getRound'), 'the late request never reached the service');
  releaseShutdown();
  await stopping;
});

test('SIGINT and SIGTERM run the shutdown once, then exit; a second signal exits at once; a stuck shutdown is cut off', async () => {
  const exits = [];
  const messages = [];
  let shutdowns = 0;
  const finishShutdown = [];
  const app = { shutdown: () => { shutdowns++; return new Promise(resolve => finishShutdown.push(resolve)); } };
  const proc = new EventEmitter();
  installSignalHandlers(app, { proc, exit: code => exits.push(code), log: message => messages.push(message), forceAfterMs: 60000 });
  assert.equal(proc.listenerCount('SIGINT'), 1);
  assert.equal(proc.listenerCount('SIGTERM'), 1);
  proc.emit('SIGTERM');
  assert.equal(shutdowns, 1);
  assert.deepEqual(exits, [], 'it waits for the shutdown');
  proc.emit('SIGINT');
  assert.equal(shutdowns, 1, 'the shutdown is not started twice');
  assert.deepEqual(exits, [130], 'a second signal exits at once');
  finishShutdown[0]();
  await sleep(10);
  assert.deepEqual(exits, [130, 0]);

  /* a failing shutdown is reported and the process still exits */
  const failing = new EventEmitter();
  const failedExits = [];
  installSignalHandlers({ shutdown: () => Promise.reject(new Error('could not stop')) }, { proc: failing, exit: code => failedExits.push(code), log: message => messages.push(message), forceAfterMs: 60000 });
  failing.emit('SIGINT');
  await sleep(10);
  assert.deepEqual(failedExits, [0]);
  assert.ok(messages.some(message => message.includes('could not stop')));

  /* a shutdown that never ends is cut off */
  const stuck = new EventEmitter();
  const stuckExits = [];
  installSignalHandlers({ shutdown: () => new Promise(() => {}) }, { proc: stuck, exit: code => stuckExits.push(code), forceAfterMs: 30 });
  stuck.emit('SIGTERM');
  await sleep(120);
  assert.deepEqual(stuckExits, [1]);
});

/* ====================================================================== the simulated grader */

test('grader-sim over HTTP: one tool-less run, labelled as a simulation, five at most per call', async t => {
  const w = await makeWorld(t, { resultText: '{"verdict":"meets-guidance","reason":"The answer matches."}' });
  const one = await w.post('/api/agents/grader-sim', { guidelineText: 'You are grading an answer about Atlas cash.', answerText: GOLD_ANSWER, model: 'claude-sonnet-5-5' });
  assert.equal(one.status, 200, one.text);
  assert.equal(one.json.label, 'simulated grader, not Studio grading');
  assert.equal(one.json.simulated, true);
  assert.equal(one.json.model, 'claude-sonnet-5-5');
  assert.equal(one.json.verdict, 'meets-guidance');
  assert.equal(one.json.reason, 'The answer matches.');
  const runs = promptRuns(w.argvLog);
  assert.equal(runs.length, 1);
  const args = runs[0];
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', ''], 'no tools at all');
  assert.ok(!args.includes('--allowedTools'));
  assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-5-5');

  const six = await w.post('/api/agents/grader-sim', { guidelineText: 'g', answerTexts: ['1', '2', '3', '4', '5', '6'] });
  assert.equal(six.status, 400);
  assert.match(six.json.error, /At most 5/);
  assert.equal(promptRuns(w.argvLog).length, 1, 'the refused batch started nothing');
  for (const body of [{ guidelineText: 'g' }, { answerText: 'a' }, { guidelineText: 'g', answerText: 'a', model: 'gpt-5' }, { guidelineText: 'g', answerText: 'a', effort: 'extreme' }, { guidelineText: 'g', answerTexts: [] }]) {
    assert.equal((await w.post('/api/agents/grader-sim', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await w.post('/api/agents/grader-sim', { guidelineText: 'g'.repeat(40000), answerText: 'a' })).status, 413);
  assert.equal((await w.send('POST', '/api/agents/grader-sim', { guidelineText: 'g', answerText: 'a' }, { Origin: 'http://evil.example' })).status, 403);
  assert.equal(promptRuns(w.argvLog).length, 1);
});

/* ====================================================================== the script entry */

test('usableClaudeBin pins CLAUDE_BIN only when it names an executable file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-server-bin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executable = path.join(dir, 'runtime');
  const plain = path.join(dir, 'plain');
  fs.writeFileSync(executable, '#!/bin/sh\n');
  fs.chmodSync(executable, 0o755);
  fs.writeFileSync(plain, 'text');
  fs.chmodSync(plain, 0o644);
  assert.equal(usableClaudeBin(executable), executable);
  assert.equal(usableClaudeBin(STUB), STUB);
  for (const value of [plain, dir, path.join(dir, 'missing'), '', undefined, null, 5, {}, ['x']]) assert.equal(usableClaudeBin(value), undefined, String(value));
});

/* A copy of the files the companion needs, in a folder of its own, so the script runs without touching the real project. */
function copyProject(base) {
  const project = path.join(base, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.cpSync(path.join(REPO, 'backend'), path.join(project, 'backend'), { recursive: true });
  for (const name of ['package-engine.js', 'index.html', 'agents.js']) fs.copyFileSync(path.join(REPO, name), path.join(project, name));
  return project;
}

/* The exit of a script child, or 'timed out' after 30 seconds. The timer is cleared so it never keeps the test process alive. */
function exitOf(script, ms = 30000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve('timed out'), ms);
    script.exited.then(result => { clearTimeout(timer); resolve(result); });
  });
}

function startScript(t, { args = [], env = {}, scenario = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-server-script-'));
  const project = copyProject(base);
  const tmp = path.join(base, 'tmp');
  const source = path.join(base, 'source');
  fs.mkdirSync(tmp);
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'Facility_Terms.txt'), 'Atlas facility terms, synthetic.\n');
  const argvLog = path.join(base, 'argv.log');
  const child = childProcess.spawn(process.execPath, [path.join(project, 'backend', 'server.cjs'), ...args], {
    cwd: base,
    env: { ...process.env, FINANCE_STUDIO_PORT: '0', CLAUDE_BIN: STUB, TMPDIR: tmp, FINANCE_STUB_SCENARIO: JSON.stringify(scenario), FINANCE_STUB_ARGV_LOG: argvLog, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const script = { base, project, source, argvLog, child, output: '' };
  script.exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  child.stdout.on('data', chunk => { script.output += chunk; });
  child.stderr.on('data', chunk => { script.output += chunk; });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(base, { recursive: true, force: true });
  });
  script.url = () => (/Finance Task Studio: (http:\/\/127\.0\.0\.1:\d+)/.exec(script.output) || [])[1];
  return script;
}

test('run as a script it serves, records zero model calls, and SIGTERM cancels the running round before it exits', async t => {
  const script = startScript(t, { scenario: { hang: true } });
  const url = await waitFor(() => script.url(), { label: 'the companion to print its address' });
  const port = Number(new URL(url).port);
  assert.match(script.output, /viewer only/, 'no private evidence module in this copy');

  const record = JSON.parse(fs.readFileSync(path.join(script.project, 'LOCAL_SERVER.json'), 'utf8'));
  assert.deepEqual(record, { url, pid: script.child.pid, startedAt: record.startedAt, modelCallsOnLaunch: 0 });
  assert.ok(!Number.isNaN(Date.parse(record.startedAt)));

  const status = await request(port, { path: '/api/status' });
  assert.equal(status.status, 200);
  assert.equal(status.json.agents.runtime.found, true);
  assert.equal(status.json.agents.runtime.path, STUB);
  const page = await request(port, { path: '/' });
  assert.ok(page.text.includes("connect-src 'self'"));
  assert.equal((await request(port, { path: '/agents.js' })).status, 200);
  assert.equal(promptRuns(script.argvLog).length, 0, 'starting started no model');

  const client = clientFor(port, status.json.nonce);
  const post = (urlPath, body) => client.send('POST', urlPath, body);
  const created = await post('/api/agents/rounds', { label: 'script round', sourceDir: script.source, promptText: PROMPT, gafVisible: false, config: { count: 1 } });
  assert.equal(created.status, 200, created.text);
  const id = created.json.id;
  const frozen = await post(`/api/agents/rounds/${id}/freeze`, GOLD);
  assert.equal(frozen.status, 200, frozen.text);
  assert.equal((await post(`/api/agents/rounds/${id}/launch`)).status, 409, 'not approved yet');
  assert.equal((await post(`/api/agents/rounds/${id}/approve`, { summarySha256: frozen.json.summarySha256, acknowledgements: ACK })).status, 200);
  assert.equal((await post(`/api/agents/rounds/${id}/launch`)).status, 200);
  await waitFor(async () => (await client.get(`/api/agents/rounds/${id}`)).json.runs.some(run => run.state === 'running'), { label: 'a pilot to be running' });
  await waitFor(() => promptRuns(script.argvLog).length === 1, { label: 'the pilot process to start' });

  script.child.kill('SIGTERM');
  const result = await exitOf(script);
  assert.deepEqual(result, { code: 0, signal: null }, script.output);
  const saved = JSON.parse(fs.readFileSync(path.join(script.project, 'private', 'agent-rounds', id, 'round.json'), 'utf8'));
  assert.equal(saved.status, 'cancelled');
  assert.deepEqual(saved.runs.map(run => run.state), ['cancelled']);
});

test('run as a script with SIGINT the same way, and with the one-time run flag but no evidence module nothing starts', async t => {
  const script = startScript(t, { args: ['--run-approved-once'] });
  const url = await waitFor(() => script.url(), { label: 'the companion to print its address' });
  await waitFor(() => /No private evidence module found/.test(script.output), { label: 'the refusal to run the archived analysis' });
  const record = JSON.parse(fs.readFileSync(path.join(script.project, 'LOCAL_SERVER.json'), 'utf8'));
  assert.equal(record.modelCallsOnLaunch, 1, 'the flag is what the record reports');
  assert.equal((await request(Number(new URL(url).port), { path: '/api/status' })).status, 200, 'the viewer keeps running');
  assert.equal(promptRuns(script.argvLog).length, 0);
  assert.equal(fs.existsSync(path.join(script.project, 'model-runs')), false, 'the archived adapter did not start');
  script.child.kill('SIGINT');
  assert.deepEqual(await exitOf(script), { code: 0, signal: null }, script.output);
});

test('run as a script it exits with a message on a bad or busy port, and ignores an unusable CLAUDE_BIN', async t => {
  const bad = startScript(t, { env: { FINANCE_STUDIO_PORT: 'abc' } });
  assert.deepEqual(await exitOf(bad), { code: 1, signal: null }, bad.output);
  assert.match(bad.output, /could not start: The port must be a whole number/);

  const holder = net.createServer();
  await new Promise(resolve => holder.listen(0, '127.0.0.1', resolve));
  t.after(() => holder.close());
  const busy = startScript(t, { env: { FINANCE_STUDIO_PORT: String(holder.address().port) } });
  assert.deepEqual(await exitOf(busy), { code: 1, signal: null }, busy.output);
  assert.match(busy.output, /could not start: .*EADDRINUSE/);

  /* a CLAUDE_BIN that is not executable does not stop the companion from starting */
  const missing = startScript(t, { env: { CLAUDE_BIN: path.join(os.tmpdir(), 'no-such-runtime-for-this-test') } });
  const url = await waitFor(() => missing.url(), { label: 'the companion to print its address' });
  const status = await request(Number(new URL(url).port), { path: '/api/status' });
  assert.equal(status.status, 200);
  assert.notEqual(status.json.agents.runtime.path, path.join(os.tmpdir(), 'no-such-runtime-for-this-test'));
  missing.child.kill('SIGTERM');
  assert.deepEqual(await exitOf(missing), { code: 0, signal: null });
});
