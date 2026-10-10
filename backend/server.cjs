'use strict';
/* Finance Task Studio local companion (docs/local-agents.md section 5).

   It serves the Studio's own files and the /api/agents routes on 127.0.0.1 only. Starting it never starts a model: pilots
   run only after a round has been frozen, approved and launched through the API, and the archived one-run adapter runs
   only with --run-approved-once.

   Every request must carry Host: 127.0.0.1:<port>. Every request that changes anything (any method but GET) must also carry
   Origin: http://<host>, the header x-finance-local with the nonce from GET /api/status, and Content-Type: application/json.
   The browser never supplies a command, a binary path or an argument: it sends text, numbers, file names and choices, and the
   agent service validates all of them and builds every argument itself.

   Module API (used by the tests):
     createServer({ root, service, port, runner?, state?, log? }) -> { server, nonce, runner, listen(), close(), shutdown() }
       listen() resolves { port, url }. close() stops the listener and drops connections. shutdown() also cancels the
       archived adapter and every running round (service.shutdown()) before it closes.
     installSignalHandlers(app, { proc?, exit?, log?, forceAfterMs? })
     localServerRecord({ url, pid, startedAt, runApprovedOnce }) -> the LOCAL_SERVER.json content
     usableClaudeBin(value) -> value when it names an executable file, otherwise undefined */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');
const { HarnessRun } = require('./harness.cjs');
const { createAgentService, AgentError } = require('./agents/index.cjs');
const C = require('./agents/constants.cjs');

const ROOT = path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const ASSETS = new Set(['index.html', 'styles.css', 'core.js', 'catalog.js', 'examples.js', 'playbook.js', 'research-gates.js', 'package-engine.js', 'candidate-engine.js', 'app.js', 'agents.js', 'dashboard.js']);
const RUN_NUMBER_RE = /^[1-9][0-9]{0,2}$/;
const JSON_TYPE_RE = /^application\/json\s*(?:;\s*charset\s*=\s*"?utf-8"?\s*)?$/i;
const PUBLIC_STATUSES = new Set([400, 403, 404, 405, 409, 413, 415]);
const GENERIC_ERROR = 'The companion hit an internal error. The details are in the terminal where it is running.';
const DRAIN_ALLOWANCE = 16 * 1024 * 1024; /* bytes read and thrown away after a 413 before the connection is dropped */
const SETTLE_MS = 10000; /* shutdown waits this long for requests that are still being answered */

/* An error that is safe to show the writer, with the HTTP status to send. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/* ------------------------------------------------------------------ small helpers */

const digest = value => crypto.createHash('sha256').update(String(value), 'utf8').digest();

/* Compare two secrets without leaking where they differ. */
function sameSecret(given, expected) {
  return typeof given === 'string' && crypto.timingSafeEqual(digest(given), digest(expected));
}

function realOrSame(file) {
  try { return fs.realpathSync(file); } catch { return file; }
}

/* Error text can name the server's own folders. Those never go to the browser. */
function makeRedactor(root) {
  const needles = [...new Set([root, realOrSame(root), os.homedir()])].filter(item => typeof item === 'string' && item.length > 1).sort((a, b) => b.length - a.length);
  return text => needles.reduce((out, needle) => out.split(needle).join('<server path>'), String(text));
}

/* Which errors may reach the browser, with which status and text. Anything unexpected becomes a generic 500. */
function publicError(error, redact) {
  const known = error instanceof HttpError || error instanceof AgentError;
  if (known && PUBLIC_STATUSES.has(error.status)) return { status: error.status, message: redact(error.message) };
  return { status: 500, message: GENERIC_ERROR };
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value === undefined ? {} : value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/* Reads at most `limit` bytes. When a body is too large the promise rejects at once (the caller answers 413 straight away),
   the rest is read and thrown away, and a sender that keeps going far past the limit is cut off. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    const fail = error => {
      if (failed) return;
      failed = true;
      chunks.length = 0;
      reject(error);
    };
    const tooLarge = () => new HttpError(413, `The request is larger than the ${Math.round(limit / 1024)} KB this route accepts`);
    const declared = req.headers['content-length'];
    if (typeof declared === 'string' && /^\d+$/.test(declared) && Number(declared) > limit) fail(tooLarge());
    req.on('data', chunk => {
      size += chunk.length;
      if (failed) {
        if (size > limit + DRAIN_ALLOWANCE) req.destroy();
        return;
      }
      if (size > limit) { fail(tooLarge()); return; }
      chunks.push(chunk);
    });
    req.once('end', () => { if (!failed) resolve(Buffer.concat(chunks, size)); });
    req.on('error', () => fail(new HttpError(400, 'The request was interrupted')));
    req.once('close', () => { if (!req.complete) fail(new HttpError(400, 'The request was interrupted')); });
  });
}

/* An empty body counts as {}. Anything else must be a UTF-8 JSON object. */
function parseJsonObject(buffer) {
  if (!buffer.length) return {};
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new HttpError(400, 'The request body is not valid UTF-8 text');
  }
  if (!text.trim()) return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'The request body must be a JSON object');
  return value;
}

function summaryLine(text, prefix, last = false) {
  const lines = String(text).split('\n').filter(item => item.startsWith(prefix));
  const line = last ? lines[lines.length - 1] : lines[0];
  return line ? line.slice(prefix.length) : '';
}

const contentType = name => (name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');

/* ------------------------------------------------------------------ route table */

/* pattern: path with :id (a round id) and :n (a run number). Handlers get { params, body } and return the JSON to send.
   limit: 'packet' selects the smaller body cap. legacy: the archived cancel route keeps its original, header only checks. */
function pathParts(pattern) {
  return pattern.split('/').slice(1);
}

function matchRoutes(routes, pathname) {
  const parts = pathname.split('/').slice(1);
  const hits = [];
  for (const route of routes) {
    if (route.parts.length !== parts.length) continue;
    const params = {};
    let fits = true;
    route.parts.forEach((want, index) => {
      if (!fits) return;
      if (want[0] === ':') params[want.slice(1)] = parts[index];
      else if (want !== parts[index]) fits = false;
    });
    if (fits) hits.push({ route, params });
  }
  return hits;
}

/* ------------------------------------------------------------------ the server */

function createServer(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const service = options.service;
  if (!service || typeof service.status !== 'function') throw new TypeError('createServer needs an agent service');
  const port = options.port === undefined ? 0 : options.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('The port must be a whole number from 0 to 65535');
  const log = typeof options.log === 'function' ? options.log : message => console.error(message);
  const redact = makeRedactor(root);
  const nonce = crypto.randomBytes(24).toString('hex');
  const initialState = options.state === undefined ? null : options.state;
  const runner = options.runner || new HarnessRun({ root });
  const currentState = () => (runner.state ? runner.state : initialState);
  const inflight = new Set();
  let boundPort = null;
  let closing = false;
  let closed = null;
  let shuttingDown = null;

  /* ---------- what the routes do */

  async function agentsStatus() {
    try {
      return await service.status();
    } catch (error) {
      log(`companion: the agent status could not be read (${error && error.message ? error.message : error})`);
      return {
        runtime: { found: false, path: null, version: null, source: null },
        maxPilotsPerRound: C.MAX_PILOTS_PER_ROUND,
        models: C.MODELS.slice(),
        efforts: C.EFFORTS.slice(),
      };
    }
  }

  /* A frozen or approved round carries the approval summary and its hash, so the page approves exactly what will run. */
  async function withApproval(view) {
    if (!view || typeof view !== 'object' || !view.freeze || !['frozen', 'approved'].includes(view.status)) return view;
    try {
      const { summary, summarySha256, commandLine, workingFolder } = await service.approvalSummary(view.id);
      /* The service says the command line and the folder itself. Reading them out of the text is only a fallback for a
         service that does not, and then the last Command line is the real one (file names come before it). */
      return {
        ...view,
        summarySha256,
        approvalSummary: {
          text: summary,
          summarySha256,
          commandLine: typeof commandLine === 'string' ? commandLine : summaryLine(summary, 'Command: ', true),
          workingFolder: typeof workingFolder === 'string' ? workingFolder : summaryLine(summary, 'Working folder per pilot: '),
          model: view.config.model,
          effort: view.config.effort,
          count: view.config.count,
          tools: view.config.tools,
          packetSha256: view.packet.packetSha256,
          freezeSha256: view.freeze.sha256,
          gafVisible: view.packet.gafVisible,
          overrides: view.packet.files.filter(file => file.include && file.overridden).map(file => file.path),
        },
      };
    } catch {
      return view;
    }
  }

  const round = async promise => withApproval(await promise);

  const routes = [
    { method: 'GET', pattern: '/api/status', handler: async () => ({ state: currentState(), connection: 'local-sdk-adapter', canStart: false, nonce, adapter: 'deepseek-account', agents: await agentsStatus() }) },
    { method: 'POST', pattern: '/api/cancel', legacy: true, handler: async () => { runner.cancel(); return { cancelRequested: true, state: currentState() }; } },
    { method: 'POST', pattern: '/api/agents/packet/inspect', limit: 'packet', handler: ({ body }) => service.inspectPacket(body) },
    { method: 'GET', pattern: '/api/agents/rounds', handler: async () => ({ rounds: await service.listRounds() }) },
    { method: 'POST', pattern: '/api/agents/rounds', limit: 'packet', handler: ({ body }) => round(service.createRound(body)) },
    { method: 'GET', pattern: '/api/agents/rounds/:id', handler: ({ params }) => round(service.getRound(params.id)) },
    { method: 'POST', pattern: '/api/agents/rounds/:id/freeze', handler: ({ params, body }) => round(service.freezeRound(params.id, body)) },
    { method: 'POST', pattern: '/api/agents/rounds/:id/refreeze', handler: ({ params, body }) => round(service.refreezeRound(params.id, body)) },
    { method: 'POST', pattern: '/api/agents/rounds/:id/approve', handler: ({ params, body }) => round(service.approveRound(params.id, body)) },
    { method: 'POST', pattern: '/api/agents/rounds/:id/launch', handler: ({ params }) => round(service.launchRound(params.id)) },
    { method: 'POST', pattern: '/api/agents/rounds/:id/cancel', handler: ({ params }) => round(service.cancelRound(params.id)) },
    { method: 'POST', pattern: '/api/agents/rounds/:id/export', handler: ({ params }) => service.exportRound(params.id) },
    { method: 'GET', pattern: '/api/agents/rounds/:id/runs/:n', handler: ({ params }) => service.getRun(params.id, params.n) },
    { method: 'POST', pattern: '/api/agents/rounds/:id/runs/:n/classify', handler: ({ params, body }) => service.classifyRun(params.id, params.n, body) },
    { method: 'POST', pattern: '/api/agents/grader-sim', handler: ({ body }) => service.graderSim(body) },
    {
      /* The Agents page has an author review button. The service has no such method yet, so the answer says so plainly. */
      method: 'POST',
      pattern: '/api/agents/author-review',
      handler: ({ body }) => {
        if (typeof service.authorReview !== 'function') throw new AgentError(404, 'Author review is not available in this version of the companion');
        return service.authorReview(body);
      },
    },
  ];
  for (const route of routes) route.parts = pathParts(route.pattern);

  /* ---------- checks that run before a route does anything */

  function authorizeChange(req, host, route) {
    if (req.headers.origin !== `http://${host}`) throw new HttpError(403, 'Origin authorization required');
    if (!sameSecret(req.headers['x-finance-local'], nonce)) throw new HttpError(403, 'Origin authorization required');
    if (!route.legacy && !JSON_TYPE_RE.test(String(req.headers['content-type'] || ''))) throw new HttpError(415, 'Send the request as application/json');
  }

  /* A page on another origin may not read these routes, and the answer says why. Same-origin GETs carry no Origin header. */
  function refuseForeignRead(req, host) {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) throw new HttpError(403, 'Cross-origin requests are not allowed');
  }

  function checkParams(params) {
    if (params.id !== undefined && !C.ID_RE.test(params.id)) throw new HttpError(400, 'That is not a valid round id');
    if (params.n !== undefined && !RUN_NUMBER_RE.test(params.n)) throw new HttpError(400, 'That is not a valid run number');
  }

  /* ---------- static files */

  function serveAsset(pathname, res) {
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!ASSETS.has(name)) { res.writeHead(404); return res.end('Not found'); }
    let data;
    try {
      data = fs.readFileSync(path.join(root, name));
    } catch {
      res.writeHead(404);
      return res.end('Missing application asset');
    }
    if (name === 'index.html') data = Buffer.from(data.toString().replace("connect-src 'none'", "connect-src 'self'"));
    res.setHeader('Content-Type', contentType(name));
    return res.end(data);
  }

  /* ---------- the request handler */

  async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const host = req.headers.host;
    if (host !== `${HOST}:${boundPort}`) { res.writeHead(403); return res.end('Local host required'); }
    if (closing) return sendJson(res, 503, { error: 'The companion is shutting down' });
    if (typeof req.url !== 'string' || req.url[0] !== '/' || req.url[1] === '/') return sendJson(res, 400, { error: 'Bad request' });
    let url;
    try { url = new URL(req.url, `http://${host}`); } catch { return sendJson(res, 400, { error: 'Bad request' }); }

    const hits = matchRoutes(routes, url.pathname);
    if (!hits.length) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Unsupported action' });
      return serveAsset(url.pathname, res);
    }
    const hit = hits.find(item => item.route.method === req.method);
    if (!hit) {
      res.setHeader('Allow', hits.map(item => item.route.method).join(', '));
      return sendJson(res, 405, { error: 'That method is not supported for this address' });
    }

    const { route, params } = hit;
    if (route.method === 'GET') refuseForeignRead(req, host);
    else authorizeChange(req, host, route);
    checkParams(params);
    let body;
    if (route.method !== 'GET' && !route.legacy) {
      body = parseJsonObject(await readBody(req, route.limit === 'packet' ? C.LIMITS.packetBodyBytes : C.LIMITS.bodyBytes));
    }
    return sendJson(res, 200, await route.handler({ params, body }));
  }

  function answerError(res, error, req) {
    const { status, message } = publicError(error, redact);
    if (status === 500) log(`companion: ${req.method} ${String(req.url).slice(0, 200)} failed: ${error && error.stack ? error.stack : error}`);
    if (res.headersSent) { res.destroy(); return; }
    try { sendJson(res, status, { error: message }); } catch { res.destroy(); }
  }

  const server = http.createServer((req, res) => {
    const work = handle(req, res).catch(error => answerError(res, error, req)).catch(() => res.destroy());
    inflight.add(work);
    work.then(() => inflight.delete(work));
  });

  /* ---------- starting and stopping */

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, HOST, () => {
        server.off('error', reject);
        server.on('error', error => log(`companion: server error: ${error && error.message ? error.message : error}`));
        boundPort = server.address().port;
        resolve({ port: boundPort, url: `http://${HOST}:${boundPort}` });
      });
    });
  }

  function stopAccepting() {
    closing = true;
    if (!closed) closed = new Promise(resolve => server.close(() => resolve()));
    server.closeIdleConnections();
    return closed;
  }

  async function close() {
    const done = stopAccepting();
    server.closeAllConnections();
    await done;
  }

  async function settleRequests() {
    if (!inflight.size) return;
    const timer = { id: null };
    const timeout = new Promise(resolve => { timer.id = setTimeout(resolve, SETTLE_MS); timer.id.unref(); });
    await Promise.race([Promise.allSettled([...inflight]), timeout]);
    clearTimeout(timer.id);
  }

  async function stopRounds() {
    if (typeof service.shutdown !== 'function') return;
    try {
      await service.shutdown();
    } catch (error) {
      log(`companion: stopping the pilots failed: ${error && error.message ? error.message : error}`);
    }
  }

  /* No new requests, the archived adapter and every running round cancelled, then the connections dropped. A launch that was
     still being answered when this began is stopped by the second pass. */
  function shutdown() {
    if (!shuttingDown) {
      shuttingDown = (async () => {
        const done = stopAccepting();
        try { runner.cancel(); } catch { /* nothing was running */ }
        await stopRounds();
        await settleRequests();
        await stopRounds();
        server.closeAllConnections();
        await done;
      })();
    }
    return shuttingDown;
  }

  return { server, nonce, runner, listen, close, shutdown };
}

/* On SIGINT or SIGTERM: cancel every running round, then exit. A second signal exits at once. */
function installSignalHandlers(app, options = {}) {
  const proc = options.proc || process;
  const exit = options.exit || (code => process.exit(code));
  const report = options.log || (message => console.error(message));
  const forceAfterMs = options.forceAfterMs === undefined ? 20000 : options.forceAfterMs;
  let stopping = false;
  const onSignal = signal => {
    if (stopping) { exit(signal === 'SIGINT' ? 130 : 143); return; }
    stopping = true;
    const timer = setTimeout(() => exit(1), forceAfterMs);
    timer.unref();
    app.shutdown().catch(error => report(`companion: shutdown failed: ${error && error.message ? error.message : error}`)).then(() => {
      clearTimeout(timer);
      exit(0);
    });
  };
  proc.on('SIGINT', () => onSignal('SIGINT'));
  proc.on('SIGTERM', () => onSignal('SIGTERM'));
  return onSignal;
}

function localServerRecord({ url, pid, startedAt, runApprovedOnce }) {
  return { url, pid, startedAt, modelCallsOnLaunch: runApprovedOnce ? 1 : 0 };
}

/* ------------------------------------------------------------------ private evidence and the script entry */

/* Private evidence modules live under private/ (ignored by git): private/evidence-module.js or any *-audit.js. The viewer runs
   without one; the archived one-run analysis requires it. */
function loadEvidenceAudit(root) {
  const privateDir = path.join(root, 'private');
  if (!fs.existsSync(privateDir)) return null;
  const candidates = fs.readdirSync(privateDir)
    .filter(file => file === 'evidence-module.js' || /-audit\.js$/.test(file))
    .sort((a, b) => (a === 'evidence-module.js' ? -1 : 0) - (b === 'evidence-module.js' ? -1 : 0));
  if (!candidates.length) return null;
  global.window = {};
  try {
    require(path.join(privateDir, candidates[0]));
    return Object.values(global.window).find(value => value && value.kind === 'bundled-task-audit') || null;
  } catch (error) {
    console.error(`The private evidence module could not be loaded (${error && error.message ? error.message : error}); viewer only.`);
    return null;
  } finally {
    delete global.window;
  }
}

function loadModelRunState(root) {
  const file = path.join(root, 'private', 'model-run.js');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text.replace(/^window.FinanceModelRun\s*=\s*/, '').replace(/;\s*$/, ''));
  } catch {
    return null;
  }
}

/* CLAUDE_BIN pins the runtime only when it names an executable file. Otherwise detection goes on to PATH and the known
   locations, as docs/local-agents.md section 3.1 says. */
function usableClaudeBin(value) {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    if (!fs.statSync(value).isFile()) return undefined;
    fs.accessSync(value, fs.constants.X_OK);
    return value;
  } catch {
    return undefined;
  }
}

async function runCompanion(argv = process.argv.slice(2), env = process.env) {
  const audit = loadEvidenceAudit(ROOT);
  const service = createAgentService({ root: ROOT, env, claudeBin: usableClaudeBin(env.CLAUDE_BIN) });
  const app = createServer({ root: ROOT, service, port: Number(env.FINANCE_STUDIO_PORT || 0), state: loadModelRunState(ROOT) });
  installSignalHandlers(app);
  const { url } = await app.listen();
  const runApprovedOnce = argv.includes('--run-approved-once');
  fs.writeFileSync(path.join(ROOT, 'LOCAL_SERVER.json'), JSON.stringify(localServerRecord({ url, pid: process.pid, startedAt: new Date().toISOString(), runApprovedOnce }), null, 2));
  console.log('Finance Task Studio: ' + url + (audit ? '' : ' (no private evidence module found; viewer only)'));
  if (argv.includes('--open')) {
    const opener = require('node:child_process').spawn('open', [url], { stdio: 'ignore' });
    opener.on('error', () => console.log('Could not open a browser automatically. Open the address above.'));
    opener.unref();
  }
  if (runApprovedOnce) {
    if (!audit) { console.error('No private evidence module found; the archived analysis cannot start.'); return; }
    try {
      await app.runner.start(audit);
      console.log('Harness status: ' + app.runner.state.status);
    } catch (error) {
      console.error(error.message);
    }
  }
}

if (require.main === module) {
  runCompanion().catch(error => {
    console.error('Finance Task Studio could not start: ' + (error && error.message ? error.message : error));
    process.exit(1);
  });
}

module.exports = { createServer, installSignalHandlers, localServerRecord, usableClaudeBin, HttpError, ASSETS };
