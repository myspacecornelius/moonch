'use strict';
/* The Claude Code runtime wrapper (docs/local-agents.md section 3): finding the binary, building the fixed argument
   list, the environment a pilot runs in, the checks made before anything starts, and running one `claude -p` process
   while parsing its stream-json output.

   Nothing here decides what may run. The caller passes allowlisted values and buildArgs checks them again, so a
   client string can never become an argument. No model is started by importing this file, and the pre-flight checks
   (`claude --help`, `claude auth status`) never start one either. */

const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MODELS, EFFORTS, TOOLS, LIMITS, BUDGET_USD, PILOT_CONFIG_DIRNAME } = require('./constants.cjs');
const { extractToolCalls } = require('./path-audit.cjs');

const VERSION_TIMEOUT_MS = 5000;
const HELP_TIMEOUT_MS = 10000;
const AUTH_TIMEOUT_MS = 20000;
const PROMPT_VIA = ['argv', 'stdin'];
const STDERR_TAIL_BYTES = 4096;
const TOOL_RESULT_CHARS = 2000;
const MAX_LINE_CHARS = 16 * 1024 * 1024; /* a longer line is kept in the transcript but not parsed */
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;
const MAX_PROMPT_BYTES = 120 * 1024; /* one argument is limited to 128 KiB on Linux */
const EXIT_DRAIN_MS = 2000; /* how long to wait for the output pipes after the process exited */

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const messageOf = error => String(error && error.message ? error.message : error).slice(0, 300);

/* ------------------------------------------------------------------ detection (section 3.1) */

function defaultExists(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultExecFile(file, args, options) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/* CLAUDE_BIN, then claude on PATH, then the known install locations. Duplicates are dropped. */
function candidatePaths(env, home) {
  const list = [];
  const add = (file, source) => {
    if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) return;
    if (!list.some(entry => entry.path === file)) list.push({ path: file, source });
  };
  if (typeof env.CLAUDE_BIN === 'string' && env.CLAUDE_BIN.trim()) add(env.CLAUDE_BIN.trim(), 'env');
  for (const dir of String(env.PATH || '').split(path.delimiter)) if (dir && path.isAbsolute(dir)) add(path.join(dir, 'claude'), 'path');
  add('/opt/homebrew/bin/claude', 'known');
  add('/usr/local/bin/claude', 'known');
  add(path.join(home, '.claude', 'local', 'claude'), 'known');
  add(path.join(home, '.local', 'bin', 'claude'), 'known');
  return list;
}

/* detectClaude({ env, exists, execFile, home }) -> Promise<{ found, path, version, source }>
   Runs `claude --version` (5 second timeout) on the first candidate that exists. It never runs a model.
   If the first candidates exist but cannot report a version, the next one is tried; if none can, the result is
   { found: false } with the first failing path and an `error` message, so the writer can see why. */
async function detectClaude(options = {}) {
  const env = isObject(options.env) ? options.env : process.env;
  const exists = typeof options.exists === 'function' ? options.exists : defaultExists;
  const execFile = typeof options.execFile === 'function' ? options.execFile : defaultExecFile;
  const home = typeof options.home === 'string' && options.home ? options.home : os.homedir();
  let failure = null;
  for (const candidate of candidatePaths(env, home)) {
    if (!exists(candidate.path)) continue;
    try {
      const output = await execFile(candidate.path, ['--version'], { timeout: VERSION_TIMEOUT_MS, env, maxBuffer: 64 * 1024, windowsHide: true });
      const text = typeof output === 'string' ? output : output && output.stdout !== undefined ? String(output.stdout) : '';
      const version = text.trim().split(/\r?\n/)[0].slice(0, 120);
      if (!version) throw new Error('claude --version printed nothing');
      return { found: true, path: candidate.path, version, source: candidate.source };
    } catch (error) {
      if (!failure) failure = { found: false, path: candidate.path, version: null, source: candidate.source, error: String(error && error.message ? error.message : error).slice(0, 300) };
    }
  }
  return failure || { found: false, path: null, version: null, source: null };
}

/* ------------------------------------------------------------------ the options the runtime lists (pre-flight) */

/* Every flag buildArgs can pass. A runtime that does not list one of the flags a launch uses is refused before
   anything starts, so an older or newer CLI can never silently drop a safety flag (for example the spending cap). */
const REQUIRED_FLAGS = Object.freeze([
  '-p', '--model', '--effort', '--output-format', '--verbose', '--tools', '--allowedTools', '--permission-mode',
  '--disable-slash-commands', '--strict-mcp-config', '--setting-sources', '--no-session-persistence', '--max-budget-usd',
  '--input-format',
]);

const FLAG_TOKEN = /^--?[A-Za-z0-9][A-Za-z0-9-]*$/;

/* parseHelpFlags(text) -> Set of every option `claude --help` lists, short and long, aliases included.
   Option lines are indented by a few spaces and start with a dash; the option names end at two spaces or at the
   argument placeholder. Wrapped description lines are indented further and are ignored. */
function parseHelpFlags(text) {
  const flags = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!/^ {1,4}-/.test(line)) continue;
    const names = line.trim().split(/ {2,}|\s+[<[]/)[0];
    for (const part of names.split(/,\s*/)) {
      const token = part.trim().split(/\s/)[0];
      if (FLAG_TOKEN.test(token)) flags.add(token);
    }
  }
  return flags;
}

/* missingFlags(args, flags) -> the flags in an argument list that the runtime does not list, in order, once each. */
function missingFlags(args, flags) {
  const known = flags instanceof Set ? flags : new Set(Array.isArray(flags) ? flags : []);
  const missing = [];
  for (const arg of Array.isArray(args) ? args : []) {
    if (typeof arg === 'string' && /^--?[A-Za-z]/.test(arg) && !known.has(arg) && !missing.includes(arg)) missing.push(arg);
  }
  return missing;
}

/* readHelpFlags({ bin, version, env, execFile, cache }) -> Promise<{ ok, flags: [string], error }>
   Runs `claude --help` (no model). A successful answer is kept in `cache` (a Map) under the binary path and version, so
   the help text is read once per installed version. A failure is not cached. */
async function readHelpFlags({ bin, version, env, execFile, cache } = {}) {
  const key = `${bin}\0${version}`;
  if (cache instanceof Map && cache.has(key)) return cache.get(key);
  const run = typeof execFile === 'function' ? execFile : defaultExecFile;
  try {
    const output = await run(bin, ['--help'], { timeout: HELP_TIMEOUT_MS, env: isObject(env) ? env : process.env, maxBuffer: 1024 * 1024, windowsHide: true });
    const text = typeof output === 'string' ? output : output && output.stdout !== undefined ? String(output.stdout) : '';
    const flags = parseHelpFlags(text);
    if (!flags.size) throw new Error('claude --help listed no options');
    const result = { ok: true, flags: [...flags].sort(), error: null };
    if (cache instanceof Map) cache.set(key, result);
    return result;
  } catch (error) {
    return { ok: false, flags: [], error: messageOf(error) };
  }
}

/* ------------------------------------------------------------------ arguments (section 3.2) */

/* The spending cap for a run without an explicit one: pilots (with tools) and tool-less runs differ. */
const defaultBudgetFor = tools => (Array.isArray(tools) && tools.length ? BUDGET_USD.pilotDefault : BUDGET_USD.toolLessDefault);

/* budgetText(value) -> the text passed to --max-budget-usd ("3.00"), or null when the value is not a number of US
   dollars in whole cents inside the allowlisted range. */
function budgetText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 1e-6) return null;
  if (cents < Math.round(BUDGET_USD.minUsd * 100) || cents > Math.round(BUDGET_USD.maxUsd * 100)) return null;
  return (cents / 100).toFixed(2);
}

/* buildArgs({ prompt, model, effort, tools, maxBudgetUsd, promptVia }) -> string[]
   The fixed argument list. model, effort and tools must come from the allowlists in constants.cjs, otherwise this
   throws. With no tools (the simulated grader) the tool list is empty and --allowedTools is left out.
   maxBudgetUsd defaults to 3.00 for a pilot and 0.50 for a tool-less run, and must be in the allowlisted range.
   promptVia 'argv' (the default) passes the prompt as the argument after -p. 'stdin' leaves it out of the list and adds
   --input-format text; the caller then gives the same prompt to ClaudeRun, which writes it to the process's stdin. */
function buildArgs({ prompt, model, effort, tools, maxBudgetUsd, promptVia = 'argv' } = {}) {
  if (!PROMPT_VIA.includes(promptVia)) throw new TypeError('The prompt is passed either as an argument or on stdin');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0')) throw new TypeError('A prompt is required');
  if (prompt.startsWith('-')) throw new TypeError('The prompt must not start with a dash');
  if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new RangeError('The prompt is too large to pass as one argument');
  if (!MODELS.includes(model)) throw new TypeError('The model is not on the allowlist');
  if (!EFFORTS.includes(effort)) throw new TypeError('The effort is not on the allowlist');
  if (!Array.isArray(tools) || tools.some(tool => !TOOLS.includes(tool)) || new Set(tools).size !== tools.length) {
    throw new TypeError('The tool list is not on the allowlist');
  }
  const budget = budgetText(maxBudgetUsd === undefined ? defaultBudgetFor(tools) : maxBudgetUsd);
  if (budget === null) {
    throw new RangeError(`The spending cap must be from ${BUDGET_USD.minUsd.toFixed(2)} to ${BUDGET_USD.maxUsd.toFixed(2)} US dollars, in whole cents`);
  }
  const list = TOOLS.filter(tool => tools.includes(tool)).join(',');
  const args = promptVia === 'argv' ? ['-p', prompt] : ['-p'];
  args.push('--model', model, '--effort', effort, '--output-format', 'stream-json', '--verbose', '--tools', list);
  if (list) args.push('--allowedTools', list);
  args.push('--permission-mode', 'acceptEdits', '--disable-slash-commands', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence');
  args.push('--max-budget-usd', budget);
  if (promptVia === 'stdin') args.push('--input-format', 'text');
  return args;
}

/* ------------------------------------------------------------------ the pilot environment (section 3.2) */

/* claudeConfigDirOf(env, home) -> the runtime's configuration folder for an environment: CLAUDE_CONFIG_DIR when it is
   set, otherwise ~/.claude. This is the writer's own folder, which the audit always treats as outside every pilot. */
function claudeConfigDirOf(env, home) {
  const source = isObject(env) ? env : process.env;
  if (typeof source.CLAUDE_CONFIG_DIR === 'string' && source.CLAUDE_CONFIG_DIR) return path.resolve(source.CLAUDE_CONFIG_DIR);
  const base = typeof source.HOME === 'string' && source.HOME ? source.HOME : typeof home === 'string' && home ? home : os.homedir();
  return path.join(base, '.claude');
}

/* The CLAUDE_SECURESTORAGE_CONFIG_DIR a pilot gets, so its runtime still finds the writer's sign-in although
   CLAUDE_CONFIG_DIR points into the pilot folder. Nothing is copied: the runtime reads the sign-in where it always does.
     - a value the writer set already is kept as it is;
     - otherwise the writer's CLAUDE_CONFIG_DIR, when that is set;
     - otherwise the empty string. Claude Code 2.1.x reads an empty value as ~/.claude for the credentials file (Linux)
       and as "no suffix" for the name of its Keychain item (macOS), which is what it uses when neither variable is set.
       A non-empty ~/.claude would name a different Keychain item on macOS and the pilot would not be signed in. */
function secureStorageDirFor(env) {
  const source = isObject(env) ? env : process.env;
  if (typeof source.CLAUDE_SECURESTORAGE_CONFIG_DIR === 'string') return source.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (typeof source.CLAUDE_CONFIG_DIR === 'string' && source.CLAUDE_CONFIG_DIR) return source.CLAUDE_CONFIG_DIR;
  return '';
}

/* pilotEnv(parentEnv, scratch) -> the environment of an agent process whose scratch folder is `scratch`
   (<folder>/.tmp): the parent environment plus
     TMPDIR, CLAUDE_CODE_TMPDIR        the scratch folder;
     CLAUDE_CONFIG_DIR                 <scratch>/claude-config, so the runtime's own files (large tool outputs saved under
                                       projects/<cwd>/<session>/tool-results/) stay inside the pilot folder;
     CLAUDE_SECURESTORAGE_CONFIG_DIR   where the writer's sign-in is (secureStorageDirFor);
     CLAUDE_CODE_DISABLE_AUTO_MEMORY,
     CLAUDE_CODE_DISABLE_CLAUDE_MDS    "1": no memory or CLAUDE.md file from anywhere reaches a blind pilot.
   Nothing else is added or removed. Pure: preparePilotConfigDir creates the folder. */
function pilotEnv(parentEnv, scratch) {
  const env = isObject(parentEnv) ? parentEnv : process.env;
  if (typeof scratch !== 'string' || !path.isAbsolute(scratch) || scratch.includes('\0')) throw new TypeError('The scratch folder must be an absolute path');
  return {
    ...env,
    TMPDIR: scratch,
    CLAUDE_CODE_TMPDIR: scratch,
    CLAUDE_CONFIG_DIR: path.join(scratch, PILOT_CONFIG_DIRNAME),
    CLAUDE_SECURESTORAGE_CONFIG_DIR: secureStorageDirFor(env),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  };
}

/* Creates <scratch>/claude-config (and the scratch folder) for pilotEnv. Never copies anything into it. */
function preparePilotConfigDir(scratch) {
  const dir = path.join(scratch, PILOT_CONFIG_DIRNAME);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/* ------------------------------------------------------------------ sign-in check (pre-flight) */

/* Runs a short command and resolves with its exit code and output. Never rejects. */
function runCommand(file, args, options) {
  return new Promise(resolve => {
    try {
      childProcess.execFile(file, args, options, (error, stdout, stderr) => {
        const code = error ? (Number.isInteger(error.code) ? error.code : null) : 0;
        const signal = error && typeof error.signal === 'string' ? error.signal : null;
        resolve({ code, signal, stdout: String(stdout || ''), stderr: String(stderr || ''), error: error && (code === null || signal) ? error : null });
      });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', error });
    }
  });
}

/* checkAuth({ bin, env, cwd, timeoutMs, run }) -> Promise<{ signedIn, exitCode, loggedIn, authMethod, apiProvider,
   configDirectory, error, stderrTail }>
   Runs `claude auth status --json` (no model) with the environment a pilot will get. signedIn is true only when the
   command exits with 0 and its JSON says loggedIn: true. Account fields (email, organisation) are never kept. */
async function checkAuth({ bin, env, cwd, timeoutMs, run } = {}) {
  const exec = typeof run === 'function' ? run : runCommand;
  const out = await exec(bin, ['auth', 'status', '--json'], {
    cwd,
    env: isObject(env) ? env : process.env,
    timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : AUTH_TIMEOUT_MS,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
  let report = null;
  try {
    const value = JSON.parse(String(out.stdout || '').trim());
    if (isObject(value)) report = value;
  } catch { /* not JSON: not signed in as far as the Studio can tell */ }
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);
  const loggedIn = report ? report.loggedIn === true : null;
  return {
    signedIn: out.code === 0 && loggedIn === true,
    exitCode: Number.isInteger(out.code) ? out.code : null,
    loggedIn,
    authMethod: report ? text(report.authMethod, 40) : null,
    apiProvider: report ? text(report.apiProvider, 40) : null,
    configDirectory: report ? text(report.configDirectory, 4096) : null,
    error: out.signal ? `stopped by ${out.signal}${out.error && out.error.killed ? ' at the time limit' : ''}` : out.error ? messageOf(out.error) : null,
    stderrTail: String(out.stderr || '').slice(-500),
  };
}

/* ------------------------------------------------------------------ stream parsing (section 3.3) */

/* One stdout line as an event, or null for anything that is not a JSON object with a string `type`. */
function parseEventLine(line) {
  if (line.length > MAX_LINE_CHARS) return null;
  const text = line.trim();
  if (text[0] !== '{') return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  return isObject(value) && typeof value.type === 'string' ? value : null;
}

/* A copy of the event whose tool_result bodies are cut to TOOL_RESULT_CHARS characters in total. Non text parts
   (images and the like) are replaced by a marker. The original object is never changed. */
function truncateToolResults(event) {
  if (event.type !== 'user' || !isObject(event.message) || !Array.isArray(event.message.content)) return event;
  let changed = false;
  const content = event.message.content.map(block => {
    if (!isObject(block) || block.type !== 'tool_result') return block;
    const body = block.content;
    if (typeof body === 'string') {
      if (body.length <= TOOL_RESULT_CHARS) return block;
      changed = true;
      return { ...block, content: body.slice(0, TOOL_RESULT_CHARS), truncated: true };
    }
    if (!Array.isArray(body)) return block;
    let budget = TOOL_RESULT_CHARS;
    let cut = false;
    const parts = body.map(part => {
      if (!isObject(part) || typeof part.text !== 'string') { cut = true; return { type: isObject(part) && typeof part.type === 'string' ? part.type : 'unknown', omitted: true }; }
      const text = part.text.slice(0, Math.max(0, budget));
      budget -= text.length;
      if (text.length !== part.text.length) cut = true;
      return text.length === part.text.length ? part : { ...part, text, truncated: true };
    });
    if (!cut) return block;
    changed = true;
    return { ...block, content: parts, truncated: true };
  });
  return changed ? { ...event, message: { ...event.message, content } } : event;
}

const stringsOnly = value => (Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 200) : []);

function normaliseInit(event) {
  return {
    model: typeof event.model === 'string' && event.model ? event.model : null,
    tools: stringsOnly(event.tools),
    skills: Array.isArray(event.skills) ? event.skills.slice(0, 200) : [],
    mcp_servers: Array.isArray(event.mcp_servers) ? event.mcp_servers.slice(0, 200) : [],
  };
}

function normaliseResult(event) {
  const usage = event.modelUsage;
  return {
    present: true,
    text: typeof event.result === 'string' ? event.result : '',
    num_turns: Number.isFinite(event.num_turns) ? event.num_turns : null,
    total_cost_usd: Number.isFinite(event.total_cost_usd) ? event.total_cost_usd : null,
    terminal_reason: typeof event.terminal_reason === 'string' ? event.terminal_reason : null,
    subtype: typeof event.subtype === 'string' ? event.subtype.slice(0, 64) : null,
    is_error: event.is_error === true,
    modelUsage: Array.isArray(usage) ? stringsOnly(usage) : isObject(usage) ? Object.keys(usage).slice(0, 50) : [],
  };
}

/* The result subtype the runtime sends when a run reached its --max-budget-usd cap (is_error is true, terminal_reason
   "budget_exhausted"). Such a run failed because of the cap, whatever its exit code, and says so (failureReason 'budget'). */
const BUDGET_EXHAUSTED_SUBTYPE = 'error_max_budget_usd';

/* summarizeEvents(events) -> { init, result, toolCalls: { total, bash, file } }
   init comes from the first system/init event, result from the last result event. When one is missing the object is
   still returned, with null model or empty text (result.present is false). */
function summarizeEvents(events) {
  const list = Array.isArray(events) ? events : [];
  const init = list.find(event => isObject(event) && event.type === 'system' && event.subtype === 'init');
  const results = list.filter(event => isObject(event) && event.type === 'result');
  const calls = extractToolCalls(list);
  const bash = calls.filter(call => call.name === 'Bash').length;
  return {
    init: init ? normaliseInit(init) : { model: null, tools: [], skills: [], mcp_servers: [] },
    result: results.length
      ? normaliseResult(results[results.length - 1])
      : { present: false, text: '', num_turns: null, total_cost_usd: null, terminal_reason: null, subtype: null, is_error: false, modelUsage: [] },
    toolCalls: { total: calls.length, bash, file: calls.length - bash },
  };
}

/* ------------------------------------------------------------------ one run */

/* A single `claude -p` process.
     new ClaudeRun({ bin, args, cwd, env, spawnFn, timeoutMs, killGraceMs, transcriptPath, promptVia, prompt })
       promptVia 'argv' (default): the prompt is in args and stdin is closed. 'stdin': args come from
       buildArgs({ ..., promptVia: 'stdin' }) and `prompt` is written to the process's stdin, which is then closed.
     start()  -> Promise<summary> (never rejects)
     cancel() -> true if a running or pending run was asked to stop
   Events: 'line' (raw stdout line), 'event' (parsed event, tool results truncated), 'end' (summary).
   summary = { state: 'completed' | 'failed' | 'cancelled', exitCode, signal, init, result, stderrTail, events,
               timedOut, failureReason, spawnError, leftoverStopped, junkLines, transcriptBytes }
   leftoverStopped is true when the process exited by itself but left processes in its group, which were then killed.
   A run is completed only when the process exits with code 0, it was not cancelled or timed out, and a result event
   with non empty text (and is_error not true) was seen. A run whose result says the spending cap was reached is failed
   with failureReason 'budget', whatever its exit code. */
class ClaudeRun extends EventEmitter {
  constructor(options = {}) {
    super();
    this.bin = options.bin;
    this.args = Array.isArray(options.args) ? options.args.slice() : [];
    this.promptVia = options.promptVia === undefined ? 'argv' : options.promptVia;
    if (!PROMPT_VIA.includes(this.promptVia)) throw new TypeError('The prompt is passed either as an argument or on stdin');
    if (this.promptVia === 'stdin' && (typeof options.prompt !== 'string' || !options.prompt.trim())) throw new TypeError('A prompt is required on stdin');
    this.input = this.promptVia === 'stdin' ? options.prompt : null;
    this.cwd = options.cwd;
    this.env = options.env;
    this.spawnFn = typeof options.spawnFn === 'function' ? options.spawnFn : childProcess.spawn;
    /* Only a real child process gets its own process group, so the whole group can be stopped. */
    this.useGroup = this.spawnFn === childProcess.spawn && process.platform !== 'win32';
    this.timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : LIMITS.timeoutMs;
    this.killGraceMs = Number.isFinite(options.killGraceMs) && options.killGraceMs >= 0 ? options.killGraceMs : LIMITS.killGraceMs;
    this.drainMs = Number.isFinite(options.drainMs) && options.drainMs >= 0 ? options.drainMs : EXIT_DRAIN_MS;
    this.transcriptPath = typeof options.transcriptPath === 'string' && options.transcriptPath ? options.transcriptPath : null;
    this.child = null;
    this.events = [];
    this.junkLines = 0;
    this.transcriptBytes = 0;
    this.exitCode = null;
    this.signal = null;
    this.spawnError = null;
    this._promise = null;
    this._resolve = null;
    this._done = false;
    this._cancelRequested = false;
    this._timedOut = false;
    this._terminating = false;
    this._fd = null;
    this._buffer = '';
    this._decoder = new StringDecoder('utf8');
    this._stderr = Buffer.alloc(0);
    this._timers = { timeout: null, kill: null, drain: null };
  }

  get pid() { return this.child && Number.isInteger(this.child.pid) ? this.child.pid : null; }

  start() {
    if (!this._promise) this._promise = new Promise(resolve => { this._resolve = resolve; this._begin(); });
    return this._promise;
  }

  /* Ask the process to stop (SIGTERM, then SIGKILL after killGraceMs). The run ends as `cancelled`. */
  cancel() {
    if (this._done) return false;
    this._cancelRequested = true;
    if (this.child) this._terminate();
    return true;
  }

  _begin() {
    if (this._cancelRequested) { this._finish(); return; }
    try {
      this._openTranscript();
    } catch (error) {
      this.spawnError = 'Could not open the transcript file: ' + (error && error.message ? error.message : error);
      this._finish();
      return;
    }
    try {
      this.child = this.spawnFn(this.bin, this.args, { cwd: this.cwd, env: this.env, stdio: [this.input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: this.useGroup, windowsHide: true });
    } catch (error) {
      this.spawnError = String(error && error.message ? error.message : error);
      this._finish();
      return;
    }
    const child = this.child;
    if (this.input !== null && child.stdin) {
      /* A process that exits before reading its input closes the pipe; that is reported by its exit, not here. */
      child.stdin.on('error', () => {});
      child.stdin.end(this.input);
    }
    if (child.stdout) {
      child.stdout.on('data', chunk => this._onStdout(chunk));
      child.stdout.on('error', () => {});
    }
    if (child.stderr) {
      child.stderr.on('data', chunk => this._onStderr(chunk));
      child.stderr.on('error', () => {});
    }
    child.on('error', error => {
      this.spawnError = String(error && error.message ? error.message : error);
      /* A process that never started has no pid and will not report an exit. */
      if (!Number.isInteger(child.pid)) this._finish();
    });
    child.on('exit', (code, signal) => {
      this.exitCode = Number.isInteger(code) ? code : null;
      this.signal = typeof signal === 'string' ? signal : null;
      if (!this._timers.drain) this._timers.drain = setTimeout(() => this._finish(), this.drainMs);
    });
    child.on('close', (code, signal) => {
      if (this.exitCode === null && Number.isInteger(code)) this.exitCode = code;
      if (this.signal === null && typeof signal === 'string') this.signal = signal;
      this._finish();
    });
    this._timers.timeout = setTimeout(() => {
      this._timedOut = true;
      this._terminate();
    }, this.timeoutMs);
  }

  _openTranscript() {
    if (!this.transcriptPath) return;
    fs.mkdirSync(path.dirname(this.transcriptPath), { recursive: true, mode: 0o700 });
    this._fd = fs.openSync(this.transcriptPath, 'a', 0o600);
  }

  _appendTranscript(line) {
    if (this._fd === null) return;
    const bytes = Buffer.byteLength(line) + 1;
    if (this.transcriptBytes + bytes > MAX_TRANSCRIPT_BYTES) return;
    try {
      fs.writeSync(this._fd, line + '\n');
      this.transcriptBytes += bytes;
    } catch {
      /* A full disk must not stop the run being summarised. */
    }
  }

  _onStdout(chunk) {
    this._buffer += typeof chunk === 'string' ? chunk : this._decoder.write(chunk);
    let newline;
    while ((newline = this._buffer.indexOf('\n')) >= 0) {
      const line = this._buffer.slice(0, newline);
      this._buffer = this._buffer.slice(newline + 1);
      this._handleLine(line);
    }
    /* A line that never ends cannot grow without bound. */
    if (this._buffer.length > MAX_LINE_CHARS + 1024) {
      this._handleLine(this._buffer);
      this._buffer = '';
    }
  }

  _handleLine(raw) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.trim()) return;
    this._appendTranscript(line);
    this.emit('line', line);
    const event = parseEventLine(line);
    if (!event) { this.junkLines++; return; }
    const stored = truncateToolResults(event);
    this.events.push(stored);
    this.emit('event', stored);
  }

  _onStderr(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const joined = Buffer.concat([this._stderr, bytes]);
    this._stderr = joined.length > STDERR_TAIL_BYTES ? joined.subarray(joined.length - STDERR_TAIL_BYTES) : joined;
  }

  _signal(signal) {
    const child = this.child;
    if (!child) return;
    try {
      if (this.useGroup && Number.isInteger(child.pid) && child.pid > 1) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      try { child.kill(signal); } catch { /* already gone */ }
    }
  }

  /* True while the process group of the child still has a member (signal 0 only asks). */
  _groupAlive() {
    const pid = this.child && this.child.pid;
    if (!Number.isInteger(pid) || pid <= 1) return false;
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return error && error.code === 'EPERM';
    }
  }

  _terminate() {
    if (this._terminating || this._done) return;
    this._terminating = true;
    this._signal('SIGTERM');
    this._timers.kill = setTimeout(() => {
      this._signal('SIGKILL');
      /* If the pipes never close after SIGKILL, stop waiting for them. */
      if (!this._timers.drain) this._timers.drain = setTimeout(() => this._finish(), this.drainMs);
    }, this.killGraceMs);
  }

  _stderrTail() {
    let text = this._stderr.toString('utf8').replace(/^�+/, '');
    if (this.spawnError) text += (text && !text.endsWith('\n') ? '\n' : '') + 'spawn error: ' + this.spawnError;
    return text;
  }

  _finish() {
    if (this._done) return;
    this._done = true;
    for (const name of Object.keys(this._timers)) {
      if (this._timers[name]) clearTimeout(this._timers[name]);
      this._timers[name] = null;
    }
    /* Anything still in the group is stopped for good: after a cancel or a timeout, and also after a normal exit, where a
       background job the agent started would otherwise keep running as the writer and could change the folder after the
       audit and the output snapshot. A process that left the group (its own session) is out of reach of this. */
    if (this.useGroup && this.child) {
      const alive = this._groupAlive();
      this.leftoverStopped = alive && !this._cancelRequested && !this._timedOut;
      if (alive || this._cancelRequested || this._timedOut) this._signal('SIGKILL');
    }
    this._buffer += this._decoder.end();
    if (this._buffer) this._handleLine(this._buffer);
    this._buffer = '';
    if (this._fd !== null) {
      try { fs.closeSync(this._fd); } catch { /* nothing to do */ }
      this._fd = null;
    }
    for (const stream of this.child ? [this.child.stdin, this.child.stdout, this.child.stderr] : []) {
      if (stream && typeof stream.destroy === 'function') { try { stream.destroy(); } catch { /* ignore */ } }
    }
    const summary = this._summary();
    this.emit('end', summary);
    if (this._resolve) this._resolve(summary);
  }

  _summary() {
    const { init, result } = summarizeEvents(this.events);
    let state = 'failed';
    let failureReason = null;
    if (this._cancelRequested) { state = 'cancelled'; failureReason = 'cancelled'; }
    else if (this.spawnError && !this.child) failureReason = 'spawn-error';
    else if (this._timedOut) failureReason = 'timeout';
    else if (result.present && result.subtype === BUDGET_EXHAUSTED_SUBTYPE) failureReason = 'budget';
    else if (this.exitCode === null) failureReason = this.signal ? 'signal' : this.spawnError ? 'spawn-error' : 'no-exit-code';
    else if (this.exitCode !== 0) failureReason = 'exit-code';
    else if (!result.present) failureReason = 'no-result';
    else if (result.is_error) failureReason = 'error-result';
    else if (!result.text.trim()) failureReason = 'empty-result';
    else state = 'completed';
    return {
      state,
      exitCode: this.exitCode,
      signal: this.signal,
      init,
      result,
      stderrTail: this._stderrTail(),
      events: this.events,
      timedOut: this._timedOut,
      failureReason: state === 'completed' ? null : failureReason,
      spawnError: this.spawnError,
      leftoverStopped: this.leftoverStopped === true,
      junkLines: this.junkLines,
      transcriptBytes: this.transcriptBytes,
    };
  }
}

module.exports = {
  detectClaude,
  buildArgs,
  budgetText,
  defaultBudgetFor,
  ClaudeRun,
  summarizeEvents,
  REQUIRED_FLAGS,
  parseHelpFlags,
  missingFlags,
  readHelpFlags,
  claudeConfigDirOf,
  secureStorageDirFor,
  pilotEnv,
  preparePilotConfigDir,
  checkAuth,
  MAX_PROMPT_BYTES,
  STDERR_TAIL_BYTES,
  TOOL_RESULT_CHARS,
};
