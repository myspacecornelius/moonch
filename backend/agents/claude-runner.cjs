'use strict';
/* The Claude Code runtime wrapper (docs/local-agents.md section 3): finding the binary, building the fixed argument
   list, and running one `claude -p` process while parsing its stream-json output.

   Nothing here decides what may run. The caller passes allowlisted values and buildArgs checks them again, so a
   client string can never become an argument. No model is started by importing this file. */

const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MODELS, EFFORTS, TOOLS, LIMITS } = require('./constants.cjs');
const { extractToolCalls } = require('./path-audit.cjs');

const VERSION_TIMEOUT_MS = 5000;
const STDERR_TAIL_BYTES = 4096;
const TOOL_RESULT_CHARS = 2000;
const MAX_LINE_CHARS = 16 * 1024 * 1024; /* a longer line is kept in the transcript but not parsed */
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;
const MAX_PROMPT_BYTES = 120 * 1024; /* one argument is limited to 128 KiB on Linux */
const EXIT_DRAIN_MS = 2000; /* how long to wait for the output pipes after the process exited */

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

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

/* ------------------------------------------------------------------ arguments (section 3.2) */

/* buildArgs({ prompt, model, effort, tools }) -> string[]
   The fixed argument list. model, effort and tools must come from the allowlists in constants.cjs, otherwise this
   throws. With no tools (the simulated grader) the tool list is empty and --allowedTools is left out. */
function buildArgs({ prompt, model, effort, tools } = {}) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0')) throw new TypeError('A prompt is required');
  if (prompt.startsWith('-')) throw new TypeError('The prompt must not start with a dash');
  if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new RangeError('The prompt is too large to pass as one argument');
  if (!MODELS.includes(model)) throw new TypeError('The model is not on the allowlist');
  if (!EFFORTS.includes(effort)) throw new TypeError('The effort is not on the allowlist');
  if (!Array.isArray(tools) || tools.some(tool => !TOOLS.includes(tool)) || new Set(tools).size !== tools.length) {
    throw new TypeError('The tool list is not on the allowlist');
  }
  const list = TOOLS.filter(tool => tools.includes(tool)).join(',');
  const args = ['-p', prompt, '--model', model, '--effort', effort, '--output-format', 'stream-json', '--verbose', '--tools', list];
  if (list) args.push('--allowedTools', list);
  args.push('--permission-mode', 'acceptEdits', '--disable-slash-commands', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence');
  return args;
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
    is_error: event.is_error === true,
    modelUsage: Array.isArray(usage) ? stringsOnly(usage) : isObject(usage) ? Object.keys(usage).slice(0, 50) : [],
  };
}

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
      : { present: false, text: '', num_turns: null, total_cost_usd: null, terminal_reason: null, is_error: false, modelUsage: [] },
    toolCalls: { total: calls.length, bash, file: calls.length - bash },
  };
}

/* ------------------------------------------------------------------ one run */

/* A single `claude -p` process.
     new ClaudeRun({ bin, args, cwd, env, spawnFn, timeoutMs, killGraceMs, transcriptPath })
     start()  -> Promise<summary> (never rejects)
     cancel() -> true if a running or pending run was asked to stop
   Events: 'line' (raw stdout line), 'event' (parsed event, tool results truncated), 'end' (summary).
   summary = { state: 'completed' | 'failed' | 'cancelled', exitCode, signal, init, result, stderrTail, events,
               timedOut, failureReason, spawnError, leftoverStopped, junkLines, transcriptBytes }
   leftoverStopped is true when the process exited by itself but left processes in its group, which were then killed.
   A run is completed only when the process exits with code 0, it was not cancelled or timed out, and a result event
   with non empty text (and is_error not true) was seen. */
class ClaudeRun extends EventEmitter {
  constructor(options = {}) {
    super();
    this.bin = options.bin;
    this.args = Array.isArray(options.args) ? options.args.slice() : [];
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
      this.child = this.spawnFn(this.bin, this.args, { cwd: this.cwd, env: this.env, stdio: ['ignore', 'pipe', 'pipe'], detached: this.useGroup, windowsHide: true });
    } catch (error) {
      this.spawnError = String(error && error.message ? error.message : error);
      this._finish();
      return;
    }
    const child = this.child;
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
    for (const stream of this.child ? [this.child.stdout, this.child.stderr] : []) {
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

module.exports = { detectClaude, buildArgs, ClaudeRun, summarizeEvents, MAX_PROMPT_BYTES, STDERR_TAIL_BYTES, TOOL_RESULT_CHARS };
