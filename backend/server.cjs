'use strict';
/* Finance Task Studio local companion (docs/local-agents.md section 5).

   It serves the Studio's own files and the /api/agents routes on 127.0.0.1 only. Starting it never starts a model: pilots
   run only after a round has been frozen, approved and launched through the API, and the archived one-run adapter runs
   only with --run-approved-once.

   Every request must carry Host: 127.0.0.1:<port>. Every request that changes anything (any method but GET) must also carry
   Origin: http://<host>, the header x-finance-local with the nonce from GET /api/status, and Content-Type: application/json.
   The browser never supplies a command, a binary path or an argument: it sends text, numbers, file names and choices, and the
   agent service validates all of them and builds every argument itself.

   Blindness while a round runs. A pilot is an agent with a shell on this machine, so it can reach this companion like any
   other local process (the nonce is in GET /api/status). While any round is running:
     - every response that carries round data (the round list, a round, a run, and the POST routes that answer with a round
       or a run) is passed through redactRoundData: each freeze record shrinks to { sha256, frozenAt }, and the gold, the
       fingerprints, the prompt text, the approval summary and its hash, the source folder, a run's final text and the
       details of a classification are left out. The answer carries redacted: true. When the round has ended the full view
       comes back. This sits here, on the response, so it does not depend on how the service builds its views. The one
       exception is the answer to a freeze, which keeps the approval summary of the round just frozen;
     - POST /api/agents/grader-sim and /api/agents/author-review answer 409: their text (the grading guidance, the package)
       would be on a command line a pilot can read. A launch is refused with 409 while one of them is still running.
   The audit (agents/path-audit.cjs, kind loopback) discards a run whose tool calls reach for this machine at all. After
   listen() the server hands its port to the service (service.setCompanionPort, when the service has it) for that audit.

   Two read routes carry round data and follow the same rule (both are flagged roundData):
     GET /api/agents/runs                         the run feed: one row per run, newest first (service.listRuns). Redacted like
                                                  a round: it holds states, counts and verdict names, never text.
     GET /api/agents/rounds/:id/runs/:n/log       a page of the run's transcript (service.readRunLog). While ANY round runs a
                                                  line is { seq, at, kind, tool, chars } and nothing else; otherwise its text
                                                  has passed the path redactor (scrubLogText) and is cut to 2000 characters.

   Module API (used by the tests):
     createServer({ root, service, port, runner?, state?, log? }) -> { server, nonce, runner, listen(), close(), shutdown() }
       listen() resolves { port, url }. close() stops the listener and drops connections. shutdown() also cancels the
       archived adapter and every running round (service.shutdown()) before it closes.
     redactRoundData(value, { keepApproval? }) -> a copy of round data with what a running pilot must not read left out
     scrubLogText(text, redact?) -> the text of a log line with every absolute path replaced, cut to 2000 characters
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
const { readPilotToken, sourceText, gatewayFindings, describeFindings } = require('./agents/pilot-token.cjs');
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
const TOOL_LESS_WHILE_RUNNING = 'A round of pilots is running. The simulated grader and the author review wait until it has ended, because their text would be on a command line that a running pilot can read. Nothing was started';
const LAUNCH_WHILE_TOOL_LESS = 'A simulated grader or an author review is still running. Launch the round when it has finished, because its text is on a command line that a pilot could read. Nothing was started';

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

/* ------------------------------------------------------------------ blindness while a round runs */

/* Left out wherever they appear in round data: the gold and the fingerprints, the prompt and the approval summary (with the
   hash the page approves by: without the text there is nothing to approve), the folder the packet came from (the excluded
   grading material sits there), and the text a tool-less run was given. */
const WITHHELD_KEYS = new Set(['gold', 'fingerprints', 'promptText', 'approvalSummary', 'summarySha256', 'sourceDir', 'guidelineText', 'packageText']);
const FREEZE_KEYS = new Set(['freeze', 'postHocFreezes']);
const MAX_REDACT_DEPTH = 32;

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOrNull = value => (typeof value === 'string' ? value : null);

/* A freeze record, the original or a post-hoc version, wherever it sits: only its hash and its time stamp. */
function freezeStub(record) {
  return { sha256: textOrNull(record.sha256), frozenAt: textOrNull(record.frozenAt) };
}

/* A classification keeps its verdicts. Matched figures, fingerprints, decision keywords and the writer's note come from
   the gold, and next to a final answer even a verdict says what the gold is, so the final text goes as well. */
function keepVerdict(record, extra) {
  const out = { verdict: textOrNull(record.verdict) };
  for (const key of extra) if (key in record) out[key] = record[key];
  return out;
}

function redactNode(value, key, depth) {
  if (depth > MAX_REDACT_DEPTH) return null;
  if (Array.isArray(value)) return value.map(item => redactNode(item, key, depth + 1));
  if (!isPlainObject(value)) return value;
  if (FREEZE_KEYS.has(key) || 'gold' in value || ('fingerprints' in value && 'sha256' in value)) return freezeStub(value);
  if (key === 'suggested') return keepVerdict(value, ['label', 'freezeVersion', 'freezeSha256']);
  if (key === 'human') return keepVerdict(value, ['at', 'freezeVersion', 'freezeSha256']);
  if (key === 'final') return { chars: Number.isFinite(value.chars) ? value.chars : null };
  const out = {};
  /* A row of the round list names the content hash of its latest freeze. The round itself withholds it (its freeze shrinks to
     { sha256, frozenAt }), so the row says null while a round runs. The hash the next round carried forward (carried) stays. */
  const isRow = 'runCount' in value && 'counts' in value;
  for (const [name, child] of Object.entries(value)) {
    if (WITHHELD_KEYS.has(name)) continue;
    out[name] = isRow && name === 'contentSha256' ? null : redactNode(child, name, depth + 1);
  }
  return out;
}

/* Round data as a running pilot may see it. It works on the response, whatever the service put in it. keepApproval keeps
   the approval summary and its hash (the freeze answer: the writer who just froze a round approves it from there; the
   summary names files and hashes and elides the prompt, so it carries no gold and no prompt text). */
function redactRoundData(value, options = {}) {
  const out = redactNode(value, '', 0);
  if (!isPlainObject(out)) return out;
  const kept = {};
  if (options.keepApproval === true && isPlainObject(value)) {
    for (const key of ['summarySha256', 'approvalSummary']) if (key in value) kept[key] = value[key];
  }
  return { ...out, ...kept, redacted: true };
}

/* ------------------------------------------------------------------ the run log: what a line may carry */

const LOG_KINDS = new Set(['init', 'tool', 'text', 'result', 'error', 'system']);
const LOG_TEXT_CHARS = 2000;
const LOG_PAGE_LINES = 200;
const LOG_PATH_CHARS = 300;
const LOG_TOKEN_RE = /^[A-Za-z0-9_.:\-[\]]{1,100}$/;
const LOG_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const LOG_NO_PATH = '[^\\s"\'`<>|;,&()[\\]{}]';
/* Absolute paths in free text: a file:// address, a quoted path (spaces allowed), a Windows or UNC path, ~/..., and a path
   that starts with / where no path character comes before it (so a/b and https://host/x stay), also right after a flag (-I/x). */
const FILE_URL_RE = /file:\/\/[^\s"'`<>]*/gi;
const QUOTED_PATH_RE = /(["'`])((?:\/(?!\/)|~\/|[A-Za-z]:[\\/]|\\\\)[^"'`\r\n]*?)\1/g;
const WINDOWS_PATH_RE = new RegExp(`(?<![A-Za-z0-9_])(?:[A-Za-z]:[\\\\/]|\\\\\\\\)${LOG_NO_PATH}*`, 'g');
const HOME_PATH_RE = new RegExp(`(?<![A-Za-z0-9_.~/\\\\])~/${LOG_NO_PATH}*`, 'g');
const POSIX_PATH_RE = new RegExp(`(?:(?<![A-Za-z0-9_.~/\\\\])|(?<=(?:^|\\s)-[A-Za-z]))/(?!/)${LOG_NO_PATH}+`, 'g');

/* The text of a log line as the browser may have it: the server's own folders and the home folder written as <server path>
   (the redactor every error message goes through), every other absolute path as <path>, at most 2000 characters. */
function scrubLogText(text, redact = value => value) {
  const bounded = String(text).slice(0, LOG_TEXT_CHARS * 2);
  const out = redact(bounded)
    .replace(FILE_URL_RE, '<path>')
    .replace(QUOTED_PATH_RE, (match, quote) => `${quote}<path>${quote}`)
    .replace(WINDOWS_PATH_RE, '<path>')
    .replace(HOME_PATH_RE, '<path>')
    .replace(POSIX_PATH_RE, '<path>');
  if (out.length <= LOG_TEXT_CHARS) return out;
  const code = out.charCodeAt(LOG_TEXT_CHARS - 1);
  return out.slice(0, code >= 0xd800 && code <= 0xdbff ? LOG_TEXT_CHARS - 1 : LOG_TEXT_CHARS);
}

/* A path from a log line, only if it is relative and stays inside the folder it is relative to. */
function safeRelPath(value) {
  if (typeof value !== 'string' || !value || value.length > LOG_PATH_CHARS || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if (/^[\\/~]/.test(value) || /^[A-Za-z]:/.test(value)) return null;
  const steps = value.split(/[\\/]+/);
  if (steps.includes('..')) return null;
  const clean = steps.filter(step => step && step !== '.').join('/');
  return clean && clean.length <= LOG_PATH_CHARS ? clean : null;
}

const wholeNumber = value => (Number.isInteger(value) && value >= 0 ? value : null);

/* The fields every line may have, rebuilt from the service's answer one by one: a field nobody listed here is not passed on. */
function logLineBase(line) {
  if (!isPlainObject(line) || !Number.isInteger(line.seq) || line.seq < 1) return null;
  const out = { seq: line.seq, at: typeof line.at === 'string' && LOG_TIME_RE.test(line.at) ? line.at : null, kind: LOG_KINDS.has(line.kind) ? line.kind : 'system' };
  return out;
}

function logEnvelope(value, lines, withheld) {
  const next = isPlainObject(value) ? wholeNumber(value.next) : null;
  const out = { lines, next: next === null ? 0 : next, done: isPlainObject(value) && value.done === true, withheld };
  if (withheld) out.redacted = true;
  return out;
}

/* A log page while any round runs: kind, the name of the tool (one of the fixed six, else "other"), the length and the time
   stamp of each line. Whatever else the service put on a line, text, command, path, tool input, is left out here. */
function withholdLog(value) {
  const source = isPlainObject(value) && Array.isArray(value.lines) ? value.lines.slice(0, LOG_PAGE_LINES) : [];
  const lines = [];
  for (const line of source) {
    const out = logLineBase(line);
    if (!out) continue;
    if (typeof line.tool === 'string') out.tool = C.TOOLS.includes(line.tool) ? line.tool : 'other';
    const chars = wholeNumber(line.chars);
    if (chars !== null) out.chars = chars;
    lines.push(out);
  }
  return logEnvelope(value, lines, true);
}

/* A log page when no round runs: text through the path redactor and cut, a path only if it is relative. */
function shapeLog(value, redact) {
  const source = isPlainObject(value) && Array.isArray(value.lines) ? value.lines.slice(0, LOG_PAGE_LINES) : [];
  const lines = [];
  for (const line of source) {
    const out = logLineBase(line);
    if (!out) continue;
    if (typeof line.tool === 'string' && LOG_TOKEN_RE.test(line.tool)) out.tool = line.tool;
    const chars = wholeNumber(line.chars);
    if (chars !== null) out.chars = chars;
    const relPath = safeRelPath(line.relPath);
    if (relPath) out.relPath = relPath;
    if (typeof line.text === 'string' && line.text) out.text = scrubLogText(line.text, redact);
    lines.push(out);
  }
  return logEnvelope(value, lines, false);
}

/* ------------------------------------------------------------------ query strings */

function oneParam(query, name) {
  const all = query.getAll(name);
  if (all.length > 1) throw new HttpError(400, `${name} was given more than once`);
  return all.length ? all[0] : undefined;
}

/* A whole number from min to max written in plain digits; fallback when the name is absent. */
function wholeParam(query, name, fallback, min, max) {
  const raw = oneParam(query, name);
  if (raw === undefined) return fallback;
  const value = /^(?:0|[1-9][0-9]{0,9})$/.test(raw) ? Number(raw) : NaN;
  if (!(value >= min && value <= max)) throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}`);
  return value;
}

/* ------------------------------------------------------------------ route table */

/* pattern: path with :id (a round id) and :n (a run number). Handlers get { params, body, query } (query: the URLSearchParams) and
   return the JSON to send. whileRunning: what replaces the generic redaction of a roundData answer while a round runs.
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
          /* null for a round stored before these settings existed (its old approval no longer matches anyway) */
          maxBudgetUsd: Number.isFinite(view.config.maxBudgetUsd) ? view.config.maxBudgetUsd : null,
          concurrency: Number.isInteger(view.config.concurrency) ? view.config.concurrency : null,
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

  /* Is any round running? Asked through the service's own list, so it holds for every round, whoever reads which one. When
     the answer cannot be read the companion assumes a round is running: it withholds rather than leaks. */
  async function anyRoundRunning() {
    try {
      const rows = await service.listRounds();
      return !Array.isArray(rows) || rows.some(row => isPlainObject(row) && row.status === 'running');
    } catch (error) {
      log(`companion: the list of rounds could not be read, so round data is withheld as if a round were running (${error && error.message ? error.message : error})`);
      return true;
    }
  }

  /* A simulated grader or an author review puts its text on a command line, where any process of this account can read it.
     So it never runs while a round runs or is being launched, and a launch waits until none of them is running. Each side
     counts itself in before it looks at the other, so two requests that arrive together cannot both pass. */
  let toolLessInFlight = 0;
  let launchesInFlight = 0;

  async function toolLess(work) {
    toolLessInFlight++;
    try {
      if (launchesInFlight || await anyRoundRunning()) throw new HttpError(409, TOOL_LESS_WHILE_RUNNING);
      return await work();
    } finally {
      toolLessInFlight--;
    }
  }

  async function launching(work) {
    launchesInFlight++;
    try {
      if (toolLessInFlight) throw new HttpError(409, LAUNCH_WHILE_TOOL_LESS);
      return await work();
    } finally {
      launchesInFlight--;
    }
  }

  /* roundData: the answer is round data, redacted while any round runs (redactRoundData). keepApproval: the freeze answer
     keeps the approval summary, so the next round can be frozen and approved while another one runs. The export is left
     out on purpose: it carries hashes, verdicts and fingerprint ids but no gold, and the page stores it as evidence as it
     is. */
  const routes = [
    { method: 'GET', pattern: '/api/status', handler: async () => ({ state: currentState(), connection: 'local-sdk-adapter', canStart: false, nonce, adapter: 'deepseek-account', agents: await agentsStatus() }) },
    { method: 'POST', pattern: '/api/cancel', legacy: true, handler: async () => { runner.cancel(); return { cancelRequested: true, state: currentState() }; } },
    { method: 'POST', pattern: '/api/agents/packet/inspect', limit: 'packet', handler: ({ body }) => service.inspectPacket(body) },
    { method: 'GET', pattern: '/api/agents/rounds', roundData: true, handler: async () => ({ rounds: await service.listRounds() }) },
    /* The run feed: every run of every round, newest first. limit 1..200 (60), task (a task name), round (a round id). */
    {
      method: 'GET',
      pattern: '/api/agents/runs',
      roundData: true,
      handler: async ({ query }) => {
        const limit = wholeParam(query, 'limit', 60, 1, 200);
        const task = oneParam(query, 'task');
        const roundId = oneParam(query, 'round');
        if (task !== undefined && task.length > 120) throw new HttpError(400, 'task is longer than 120 characters');
        if (roundId !== undefined && !C.ID_RE.test(roundId)) throw new HttpError(400, 'That is not a valid round id');
        if (typeof service.listRuns !== 'function') throw new AgentError(404, 'The run feed is not available in this version of the companion');
        return { runs: await service.listRuns({ limit, task, round: roundId }) };
      },
    },
    { method: 'POST', pattern: '/api/agents/rounds', limit: 'packet', roundData: true, handler: ({ body }) => round(service.createRound(body)) },
    { method: 'GET', pattern: '/api/agents/rounds/:id', roundData: true, handler: ({ params }) => round(service.getRound(params.id)) },
    { method: 'POST', pattern: '/api/agents/rounds/:id/freeze', roundData: true, keepApproval: true, handler: ({ params, body }) => round(service.freezeRound(params.id, body)) },
    /* Start the next round from this one: a new draft that carries the packet selection, prompt, gaf setting, settings,
       gold and fingerprints forward (carriedFrom). It is not frozen or approved; it needs both, like any round. The body
       carries nothing: the service reads everything from the stored round. */
    { method: 'POST', pattern: '/api/agents/rounds/:id/next', roundData: true, handler: ({ params }) => round(service.nextRound(params.id)) },
    /* The launch pre-flight (claude --help lists every option, claude auth status says signed in), asked for before the
       writer approves. No model is started. A problem is a 409 that names it. */
    {
      method: 'POST',
      pattern: '/api/agents/rounds/:id/preflight',
      handler: ({ params }) => {
        if (typeof service.preflightRound !== 'function') throw new AgentError(404, 'The pre-flight check is not available in this version of the companion');
        return service.preflightRound(params.id);
      },
    },
    { method: 'POST', pattern: '/api/agents/rounds/:id/refreeze', roundData: true, handler: ({ params, body }) => round(service.refreezeRound(params.id, body)) },
    { method: 'POST', pattern: '/api/agents/rounds/:id/approve', roundData: true, handler: ({ params, body }) => round(service.approveRound(params.id, body)) },
    { method: 'POST', pattern: '/api/agents/rounds/:id/launch', roundData: true, handler: ({ params }) => launching(() => round(service.launchRound(params.id))) },
    { method: 'POST', pattern: '/api/agents/rounds/:id/cancel', roundData: true, handler: ({ params }) => round(service.cancelRound(params.id)) },
    { method: 'POST', pattern: '/api/agents/rounds/:id/export', handler: ({ params }) => service.exportRound(params.id) },
    { method: 'GET', pattern: '/api/agents/rounds/:id/runs/:n', roundData: true, handler: ({ params }) => service.getRun(params.id, params.n) },
    /* A page of a run's transcript. after (the last line seen, 0), limit 1..200 (100). While any round runs, a line is only
       { seq, at, kind, tool, chars }: the service is told to withhold, and withholdLog enforces it on whatever comes back, also
       when a round starts while the file is being read (whileRunning). */
    {
      method: 'GET',
      pattern: '/api/agents/rounds/:id/runs/:n/log',
      roundData: true,
      whileRunning: withholdLog,
      handler: async ({ params, query }) => {
        const after = wholeParam(query, 'after', 0, 0, 2000000000);
        const limit = wholeParam(query, 'limit', 100, 1, 200);
        if (typeof service.readRunLog !== 'function') throw new AgentError(404, 'The run log is not available in this version of the companion');
        const running = await anyRoundRunning();
        const page = await service.readRunLog(params.id, params.n, { after, limit, withheld: running });
        return running || (isPlainObject(page) && page.withheld === true) ? withholdLog(page) : shapeLog(page, redact);
      },
    },
    { method: 'POST', pattern: '/api/agents/rounds/:id/runs/:n/classify', roundData: true, handler: ({ params, body }) => service.classifyRun(params.id, params.n, body) },
    { method: 'POST', pattern: '/api/agents/grader-sim', handler: ({ body }) => toolLess(() => service.graderSim(body)) },
    {
      /* The Agents page has an author review button. The service has no such method yet, so the answer says so plainly. */
      method: 'POST',
      pattern: '/api/agents/author-review',
      handler: ({ body }) => toolLess(() => {
        if (typeof service.authorReview !== 'function') throw new AgentError(404, 'Author review is not available in this version of the companion');
        return service.authorReview(body);
      }),
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
    let value = await route.handler({ params, body, query: url.searchParams });
    /* Asked after the data was read: a round that started meanwhile is running now, and the answer is redacted. */
    if (route.roundData && await anyRoundRunning()) value = route.whileRunning ? route.whileRunning(value) : redactRoundData(value, { keepApproval: route.keepApproval === true });
    return sendJson(res, 200, value);
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

  /* The audit flags a pilot that reaches for this port (path-audit.cjs, companionPort), so the service is told the port
     once it is known. A service without setCompanionPort still has every loopback address flagged. */
  async function tellServicePort(bound) {
    if (typeof service.setCompanionPort !== 'function') return;
    try {
      await service.setCompanionPort(bound);
    } catch (error) {
      log(`companion: the agent service did not take the companion port (${error && error.message ? error.message : error}); loopback addresses are still flagged`);
    }
  }

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, HOST, () => {
        server.off('error', reject);
        server.on('error', error => log(`companion: server error: ${error && error.message ? error.message : error}`));
        boundPort = server.address().port;
        tellServicePort(boundPort).then(() => resolve({ port: boundPort, url: `http://${HOST}:${boundPort}` }));
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

/* One line for the terminal on how pilots will sign in (pilot-token.cjs). Reads the token once; never prints it. */
async function describePilotSignIn(env) {
  const signIn = await readPilotToken({ env });
  const findings = gatewayFindings(env);
  if (signIn.error) return `a pilot token is stored but cannot be used (${signIn.error}); pilots will be refused until it is fixed or removed`;
  if (signIn.token) return `the dedicated pilot token from ${sourceText(signIn.source)}${findings.length ? `; left out of the pilot environment: ${findings.map(finding => finding.name).join(', ')}` : ''}`;
  if (findings.length) return `none stored, and this environment sets ${describeFindings(findings)}; pilots will be refused until a pilot token is stored or that is unset (README, "Pilot sign-in")`;
  return 'your own Claude Code sign-in (no pilot token stored; README, "Pilot sign-in")';
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
  console.log('Pilot sign-in: ' + await describePilotSignIn(env));
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

module.exports = { createServer, installSignalHandlers, localServerRecord, usableClaudeBin, redactRoundData, scrubLogText, describePilotSignIn, HttpError, ASSETS };
