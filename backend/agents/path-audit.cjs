'use strict';
/* Strict audit of the tool calls a pilot made (docs/local-agents.md section 6).

   The audit is pure and ALWAYS strict: any read or write that resolves outside the pilot folder (its own .tmp/ is
   inside it) is a violation, and one violation makes the run DISCARDED. There is no allowance for harness owned
   paths and no option that weakens this. It is a port of a field tested heuristic, not an operating system sandbox:
   it reads commands as text, follows `cd`, and resolves what it can.

   What it cannot do, stated plainly: it does not run anything, so a path assembled at run time (a variable it cannot
   see, command output, encoded text passed to eval or a shell, a script that builds a path) is not seen. Where the
   text shows that such a thing happened it adds a note (cwd-unresolved, unverifiable-command, unverifiable-code,
   unverifiable-input); a note never discards a run. The work per call is capped and timed, and a call that exceeds a
   cap or the time budget fails closed. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DYN = '\u0001'; /* stands in for an expansion whose value is unknown */
const MAX_SHELL_DEPTH = 4;
const MAX_CALL_TEXT = 400;
const MAX_LEAK_NOTES = 10;
/* Work caps. The audit runs on the companion's main thread, so one hostile tool call must not be able to stall it.
   A call that hits a cap cannot be shown to stay inside the folder, so it fails closed (see auditToolCalls). */
const MAX_COMMAND_CHARS = 1000000;
const MAX_STATEMENTS_PER_CALL = 20000;
const MAX_PATH_SEGMENTS = 2048;
const MAX_PATH_CHARS = 8192; /* twice PATH_MAX: no real path is longer, so a longer one is hostile or a loop */
const MAX_BRACE_STEPS = 1024; /* expansion steps for one word; each step is at most one word of the result */
const DEFAULT_BUDGET_MS = 5000;

const SAFE_DEVICES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);
const SAFE_BIN_DIRS = new Set(['/usr/bin', '/bin', '/usr/local/bin', '/usr/sbin', '/sbin']);
/* Top level directories that make an absolute path inside free text believable. */
const TOP_LEVEL = new Set(['etc', 'usr', 'var', 'home', 'Users', 'tmp', 'opt', 'bin', 'sbin', 'root', 'mnt', 'Volumes', 'proc', 'sys',
  'dev', 'Library', 'System', 'Applications', 'private', 'srv', 'run', 'lib', 'lib64', 'boot', 'media', 'snap', 'nix', 'cores']);

const KNOWN_FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'NotebookEdit']);
const WRITING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const FILE_PATH_KEYS = new Set(['file_path', 'path', 'notebook_path', 'directory', 'dir', 'cwd', 'filename', 'filepath', 'folder', 'root',
  'glob', 'paths', 'files', 'file_paths', 'directories']);

const HOME_RE = /\$(?:HOME|OLDPWD)(?![A-Za-z0-9_])|\$\{(?:HOME|OLDPWD)\b[^}]*\}/;
const HOME_CODE_RE = /expanduser|Path\.home\s*\(|os\.homedir\s*\(|environ\s*\[\s*['"]HOME['"]\s*\]|getenv\s*\(\s*['"]HOME['"]|environ\.get\s*\(\s*['"]HOME['"]/;
/* Code that lists the filesystem root: os.listdir('/'), glob.glob('/*'), fs.readdirSync('/') and similar. */
const CODE_ROOT_RE = /\b(?:listdir|walk|scandir|chdir|glob|iglob|iterdir|Path|readdirSync|readdir)\s*\(\s*['"]\/\*?['"]/;
/* A URL in free text. The match stops at $, a backtick and braces, so a substitution inside a URL is still scanned. */
const URL_RE = /\b(?!file:)[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>)|;&${}]+/gi;
/* A whole shell word that is a URL: scheme://host... with a real host, so `x://../../y` (a relative path) is not one. */
const URL_WORD_RE = /^(?!file:)[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9[]/i;
/* What may precede a path inside a script (sed, awk, grep, find patterns). */
const SCRIPT_BOUNDARY = '(^|[\\s\'"`=(\\[{,;:|@])';
/* What may precede a path inside prose or code. < > & also count, so `cat</etc/x` and `echo x>/tmp/y` are seen; a closing
   tag such as </root> is excluded in scanText. The closing brackets, * and ! stay out on purpose: division chains such as
   `(a+b)/c/d`, glob patterns and the shebang line `#!/opt/x/python` would otherwise look like paths that were used. */
const TEXT_BOUNDARY = '(^|[\\s\'"`=(\\[{,;:|@<>&])';
const ABS_PATH = '(\\/[\\w.~@%+-]*(?:\\/[\\w.~@%+-]*)*)';
const SCRIPT_ABS_RE = new RegExp(SCRIPT_BOUNDARY + ABS_PATH, 'g');
const TEXT_ABS_RE = new RegExp(TEXT_BOUNDARY + ABS_PATH, 'g');
const TEXT_DOTDOT_RE = new RegExp(TEXT_BOUNDARY + '((?:\\.\\.\\/)+[\\w.~@%+\\/-]*)', 'g');
const TEXT_TILDE_RE = new RegExp(TEXT_BOUNDARY + '(~\\/[\\w.~@%+\\/-]*)', 'g');
const CLOSING_TAG_RE = /^\/[\w.:-]*\s*>/;

/* ------------------------------------------------------------------ small helpers */

const isObject = value => value !== null && typeof value === 'object';
const asArray = value => (Array.isArray(value) ? value : []);
const stripUrls = text => text.replace(URL_RE, 'URL');
/* True for a text that is one URL with nothing to expand in it. A word with $, a backtick or a space is never exempt. */
const isPlainUrl = text => URL_WORD_RE.test(text) && !/[\s$`]/.test(text);

function within(candidate, root) {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/* A resolver that follows symlinks for the part of a path that exists and appends the rest unchanged. Every ancestor is
   remembered, so a path that grows one directory at a time (a long chain of `cd a`) costs one lookup per new
   directory, and the part below the first missing directory costs none. */
function makeResolver() {
  const known = new Map(); /* absolute path -> { real, exists } */
  return target => {
    const resolved = path.resolve(target);
    if (resolved.length > MAX_PATH_CHARS) throw new RangeError('a path is too long to audit');
    const hit = known.get(resolved);
    if (hit) return hit.real;
    const chain = [];
    let current = resolved;
    while (!known.has(current)) {
      chain.push(current);
      if (chain.length > MAX_PATH_SEGMENTS) throw new RangeError('a path has too many segments to audit');
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    let node = known.get(current);
    if (!node) {
      const top = chain.pop();
      let real = top;
      try { real = fs.realpathSync(top); } catch { /* an unreadable root keeps its own name */ }
      node = { real, exists: true };
      known.set(top, node);
    }
    while (chain.length) {
      const next = chain.pop();
      const candidate = path.join(node.real, path.basename(next));
      let entry = { real: candidate, exists: false };
      if (node.exists) {
        try { entry = { real: fs.realpathSync(candidate), exists: true }; } catch { /* missing, or not readable: the name stays as written */ }
      }
      known.set(next, entry);
      node = entry;
    }
    return node.real;
  };
}

function truncate(text, limit) {
  return text.length > limit ? text.slice(0, limit - 1) + '\u2026' : text;
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch { return '[unserialisable input]'; }
}

/* ------------------------------------------------------------------ event extraction */

/* Key the Claude Code runtime uses for a working directory under <config>/projects/. */
function cwdKeyFor(folder) {
  return String(folder).replace(/[/_]/g, '-');
}

function assistantBlocks(event) {
  if (!isObject(event)) return [];
  if (event.type === 'tool_use') return [event];
  if (event.type !== 'assistant' || !isObject(event.message)) return [];
  return asArray(event.message.content);
}

/* Every assistant tool_use block in order: [{ id, name, input }]. A repeated id is reported once. */
function extractToolCalls(events) {
  const calls = [];
  const seen = new Set();
  for (const event of asArray(events)) {
    for (const block of assistantBlocks(event)) {
      if (!isObject(block) || block.type !== 'tool_use' || typeof block.name !== 'string') continue;
      const id = typeof block.id === 'string' ? block.id : '';
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      calls.push({ id, name: block.name, input: isObject(block.input) ? block.input : {} });
    }
  }
  return calls;
}

/* Text of every tool_result block: [{ toolUseId, text }]. */
function toolResultTexts(events) {
  const results = [];
  for (const event of asArray(events)) {
    if (!isObject(event) || event.type !== 'user' || !isObject(event.message)) continue;
    for (const block of asArray(event.message.content)) {
      if (!isObject(block) || block.type !== 'tool_result') continue;
      const text = typeof block.content === 'string'
        ? block.content
        : asArray(block.content).map(part => (isObject(part) && typeof part.text === 'string' ? part.text : '')).filter(Boolean).join('\n');
      results.push({ toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : '', text });
    }
  }
  return results;
}

/* ------------------------------------------------------------------ audit context */

/* settings: { claudeConfigDir, env, budgetMs, clock }. `env` is the environment the pilot was started with: a variable
   the command did not set itself is looked up there, so a path held in an inherited variable is still seen. */
function makeContext(folderInput, settings) {
  const folder = path.resolve(folderInput);
  const configDir = path.resolve(settings.claudeConfigDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  const clock = typeof settings.clock === 'function' ? settings.clock : Date.now;
  const deadline = clock() + (Number.isFinite(settings.budgetMs) && settings.budgetMs >= 0 ? settings.budgetMs : DEFAULT_BUDGET_MS);
  const tick = () => {
    if (clock() > deadline) throw new RangeError('the audit time budget was used up');
  };
  const resolver = makeResolver();
  const real = target => {
    tick();
    return resolver(target);
  };
  const realFolder = resolver(folder);
  const realConfig = resolver(configDir);
  const env = isObject(settings.env) ? settings.env : null;
  return {
    folder,
    home: os.homedir(),
    tmp: path.join(folder, '.tmp'),
    env,
    tick,
    real,
    inside: target => within(real(target), realFolder),
    underConfig: target => within(path.resolve(target), configDir) || within(real(target), realConfig),
  };
}

/* oldpwd is null while it is unknown: a shell can start with OLDPWD set by whatever launched it. */
function freshState(cwd, oldpwd = null) {
  return { cwd, oldpwd, vars: new Map(), dirStack: [] };
}

function cloneState(state) {
  return { cwd: state.cwd, oldpwd: state.oldpwd, vars: new Map(state.vars), dirStack: state.dirStack.slice() };
}

function restoreState(state, snapshot) {
  state.cwd = snapshot.cwd;
  state.oldpwd = snapshot.oldpwd;
  state.vars = snapshot.vars;
  state.dirStack = snapshot.dirStack;
}

function renderCall(call) {
  try {
    const body = call.name === 'Bash' && typeof call.input.command === 'string' ? call.input.command : call.name + ' ' + safeJson(call.input);
    return truncate(body, MAX_CALL_TEXT);
  } catch {
    return call.name + ' [unreadable input]';
  }
}

/* One run object per tool call: collects violations (de-duplicated by kind and path) and notes. */
function makeRun(ctx, call, violations, notes) {
  const callText = renderCall(call);
  const seen = new Set();
  return {
    ctx,
    statements: 0,
    report(kind, target) {
      const shown = truncate(String(target), 300);
      const key = kind + '\u0000' + shown;
      if (seen.has(key)) return;
      seen.add(key);
      violations.push({ tool: call.name, kind, path: shown, call: callText });
    },
    note(text) { notes.add(text); },
  };
}

/* ------------------------------------------------------------------ path classification */

/* Classify an absolute path. Returns { kind, path } for a violation or null when the access is allowed.
   The binary directories are allowlisted for running and reading programs, never for writing into them. */
function classifyAbsolute(ctx, target, write = false) {
  const normal = path.resolve(target);
  if (SAFE_DEVICES.has(normal)) return null;
  if (!write && SAFE_BIN_DIRS.has(path.dirname(normal))) return null;
  if (/^\/[*?.]*$/.test(normal)) return { kind: 'bare-root', path: '/' };
  if (ctx.inside(normal)) return null;
  if (ctx.underConfig(normal)) return { kind: 'harness-spill', path: normal };
  return { kind: 'abs', path: normal };
}

/* Classify a relative path against the tracked working directory (null means unknown). */
function classifyRelative(ctx, target, state) {
  const dotdot = target.split('/').includes('..');
  if (!dotdot && (/\s/.test(target) || target.length > 1000)) return null;
  if (state.cwd === null) return dotdot ? { kind: 'dotdot', path: target } : null;
  const normal = path.resolve(state.cwd, target);
  if (ctx.inside(normal)) return null;
  if (ctx.underConfig(normal)) return { kind: 'harness-spill', path: normal };
  if (dotdot) return { kind: 'dotdot', path: normal };
  if (!ctx.inside(state.cwd)) return null; /* the cd that left the folder was already reported */
  return { kind: 'abs', path: ctx.real(normal) }; /* a symlink inside the folder that points out */
}

/* Check one expanded word or file tool path. Reports violations and returns the absolute path it denotes (or null).
   `write` is true for redirect targets and for the file tools that change files. */
function checkExpansion(exp, raw, run, state, write = false) {
  const ctx = run.ctx;
  if (exp.home) {
    const resolved = exp.dynamic ? null : path.resolve(exp.text);
    if (resolved && ctx.underConfig(resolved)) run.report('harness-spill', resolved);
    else run.report('home', raw);
    return resolved;
  }
  const target = exp.dynamic ? exp.prefix : exp.text;
  if (!target) return null;
  const violation = target.startsWith('/') ? classifyAbsolute(ctx, target, write) : classifyRelative(ctx, target, state);
  if (violation) run.report(violation.kind, violation.path);
  if (exp.dynamic) return null;
  if (target.startsWith('/')) return path.resolve(target);
  return state.cwd === null ? null : path.resolve(state.cwd, target);
}

/* ------------------------------------------------------------------ free text scanning */

function plausibleTop(segment) {
  if (/^\.+$/.test(segment)) return false;
  return TOP_LEVEL.has(segment) || fs.existsSync('/' + segment);
}

/* Scan prose, code or a script for paths. 'script' mode (sed, awk and grep scripts, find patterns) only believes well
   known top level directories, so address ranges such as /a/,/b/ are never mistaken for paths. 'text' mode also accepts
   any path with two or more segments, and looks for .. and ~ paths and ways code finds the home directory. */
function scanText(text, run, state, mode) {
  if (!text) return;
  const body = stripUrls(text);
  const ctx = run.ctx;
  if (HOME_RE.test(body)) run.report('home', body.match(HOME_RE)[0]);
  if (mode === 'text' && HOME_CODE_RE.test(body)) run.report('home', body.match(HOME_CODE_RE)[0]);
  if (mode === 'text' && CODE_ROOT_RE.test(body)) run.report('bare-root', '/');
  for (const match of body.matchAll(mode === 'script' ? SCRIPT_ABS_RE : TEXT_ABS_RE)) {
    const segments = match[2].split('/').filter(Boolean);
    if (!segments.length || /^\.+$/.test(segments[0])) continue;
    if (match[1] === '<' && CLOSING_TAG_RE.test(body.slice(match.index + 1))) continue; /* </root> is a closing tag */
    const believable = mode === 'script' ? plausibleTop(segments[0]) : segments.length >= 2 || plausibleTop(segments[0]);
    if (!believable) continue;
    const violation = classifyAbsolute(ctx, match[2]);
    if (violation) run.report(violation.kind, violation.path);
  }
  if (mode !== 'text') return;
  for (const match of body.matchAll(TEXT_DOTDOT_RE)) {
    const violation = classifyRelative(ctx, match[2], state);
    if (violation) run.report(violation.kind, violation.path);
  }
  for (const match of body.matchAll(TEXT_TILDE_RE)) {
    const resolved = path.join(ctx.home, match[2].slice(2));
    if (ctx.underConfig(resolved)) run.report('harness-spill', resolved);
    else run.report('home', match[2]);
  }
}

/* ------------------------------------------------------------------ shell lexer */

/* Quotes and command substitutions nest. Real commands nest a few levels; anything deeper is refused so hostile input
   cannot exhaust the stack, and the call is then treated as one that could not be analysed. */
const MAX_NESTING = 64;

function checkNesting(level) {
  if (level > MAX_NESTING) throw new RangeError('shell nesting is too deep');
}

function matchParen(src, from, level = 0) {
  checkNesting(level);
  let depth = 1;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); if (j < 0) return src.length; i = j; continue; }
    if (c === '"') { i = closingQuote(src, i, level + 1); continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return src.length;
}

function closingQuote(src, from, level = 0) {
  checkNesting(level);
  for (let j = from + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === '"') return j;
    if (c === '$' && src[j + 1] === '(') { j = matchParen(src, j + 2, level + 1); continue; }
    if (c === '`') { j = closingBacktick(src, j); continue; }
  }
  return src.length;
}

function closingBacktick(src, from) {
  for (let j = from + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === '`') return j;
  }
  return src.length;
}

/* Words are { segs: [{ t, q }], subs: [string|null] }. q is 'n' (bare), 's' (single quoted or escaped, literal) or
   'd' (double quoted). Each DYN character in a segment pairs with the next entry of subs: the command inside $( ),
   backticks or <( ), or null for arithmetic. Tokens are words ({ k: 'word' }), operators ({ k: 'op' }) and redirects
   ({ k: 'redir' }, with the target word and, for here documents, the body). */
function lex(src) {
  const tokens = [];
  const pendingHeredocs = [];
  let word = null;
  let redirect = null;
  let i = 0;
  const n = src.length;

  const add = (text, q) => {
    if (!word) word = { segs: [], subs: [] };
    const last = word.segs[word.segs.length - 1];
    if (last && last.q === q) last.t += text;
    else word.segs.push({ t: text, q });
  };
  const addDynamic = (sub, q) => { add(DYN, q); word.subs.push(sub); };
  const endWord = () => {
    if (!word) return;
    const finished = word;
    word = null;
    if (redirect) {
      redirect.target = finished;
      if (redirect.op === '<<' || redirect.op === '<<-') pendingHeredocs.push(redirect);
      redirect = null;
    } else tokens.push({ k: 'word', w: finished });
  };
  const operator = value => { endWord(); redirect = null; tokens.push({ k: 'op', v: value }); };
  const startRedirect = (op, fd) => {
    redirect = { k: 'redir', op, fd, target: null, heredoc: null };
    tokens.push(redirect);
  };
  const readHeredocBodies = () => {
    while (pendingHeredocs.length) {
      const heredoc = pendingHeredocs.shift();
      const tag = heredoc.target.segs.map(s => s.t).join('');
      const lines = [];
      while (i < n) {
        let end = src.indexOf('\n', i);
        if (end < 0) end = n;
        const line = src.slice(i, end);
        i = Math.min(end + 1, n);
        const comparable = (heredoc.op === '<<-' ? line.replace(/^\t+/, '') : line).replace(/\r$/, '');
        if (comparable === tag) break;
        lines.push(line);
      }
      heredoc.heredoc = lines.join('\n');
    }
  };
  const readDouble = () => {
    if (!word) word = { segs: [], subs: [] };
    const end = closingQuote(src, i);
    let buffer = '';
    const flush = () => { if (buffer) add(buffer, 'd'); buffer = ''; };
    for (let j = i + 1; j < end; j++) {
      const d = src[j];
      if (d === '\\' && j + 1 < end && '"\\$`\n'.includes(src[j + 1])) {
        if (src[j + 1] !== '\n') { flush(); add(src[j + 1], 's'); }
        j++;
      } else if (d === '$' && src[j + 1] === '(') {
        const close = Math.min(matchParen(src, j + 2), end);
        flush();
        addDynamic(src[j + 2] === '(' ? null : src.slice(j + 2, close), 'd');
        j = close;
      } else if (d === '`') {
        const close = Math.min(closingBacktick(src, j), end);
        flush();
        addDynamic(src.slice(j + 1, close), 'd');
        j = close;
      } else buffer += d;
    }
    flush();
    i = end + 1;
  };

  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue; }
    if (c === '\n') { operator('\n'); i++; readHeredocBodies(); continue; }
    if (c === '\\') {
      if (src[i + 1] !== '\n' && i + 1 < n) add(src[i + 1], 's');
      i += 2;
      continue;
    }
    if (c === "'") {
      let j = src.indexOf("'", i + 1);
      if (j < 0) j = n;
      add(src.slice(i + 1, j), 's');
      i = j + 1;
      continue;
    }
    if (c === '"') { readDouble(); continue; }
    if (c === '$') {
      const next = src[i + 1];
      if (next === '(') {
        const close = matchParen(src, i + 2);
        addDynamic(src[i + 2] === '(' ? null : src.slice(i + 2, close), 'n');
        i = close + 1;
        continue;
      }
      if (next === '{') {
        let close = src.indexOf('}', i + 2);
        if (close < 0) close = n - 1;
        if (src.slice(i + 2, close) === 'IFS') endWord(); /* an unquoted ${IFS} splits words like a space */
        else add(src.slice(i, close + 1), 'n');
        i = close + 1;
        continue;
      }
      if (next === 'I' && /^IFS(?![A-Za-z0-9_])/.test(src.slice(i + 1, i + 5))) { endWord(); i += 4; continue; }
      if (next === "'") { i++; continue; } /* $'...' ANSI-C quoting: the quote follows */
      add('$', 'n');
      i++;
      continue;
    }
    if (c === '`') {
      const close = closingBacktick(src, i);
      addDynamic(src.slice(i + 1, close), 'n');
      i = close + 1;
      continue;
    }
    if (c === '#' && !word && (i === 0 || /[\s;&|(]/.test(src[i - 1]))) {
      const end = src.indexOf('\n', i);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === ';') { operator(';'); i += src[i + 1] === ';' || src[i + 1] === '&' ? 2 : 1; continue; }
    if (c === '|') { operator('|'); i += src[i + 1] === '|' || src[i + 1] === '&' ? 2 : 1; continue; }
    if (c === '&') {
      if (src[i + 1] === '&') { operator('&&'); i += 2; continue; }
      if (src[i + 1] === '>') {
        endWord();
        const op = src[i + 2] === '>' ? '&>>' : '&>';
        startRedirect(op, '');
        i += op.length;
        continue;
      }
      operator('&');
      i++;
      continue;
    }
    if (c === '(' || c === ')') { operator(c); i++; continue; }
    if (c === '<' || c === '>') {
      if (src[i + 1] === '(') { /* process substitution */
        const close = matchParen(src, i + 2);
        addDynamic(src.slice(i + 2, close), 'n');
        i = close + 1;
        continue;
      }
      let fd = '';
      if (word && word.segs.length === 1 && word.segs[0].q === 'n' && /^\d+$/.test(word.segs[0].t)) { fd = word.segs[0].t; word = null; } else endWord();
      const rest = src.slice(i, i + 3);
      let op = c;
      if (rest === '<<<' || rest === '<<-') op = rest;
      else if (rest.startsWith('<<') || rest.startsWith('>>') || rest.startsWith('>&') || rest.startsWith('<&') || rest.startsWith('>|') || rest.startsWith('<>')) op = rest.slice(0, 2);
      startRedirect(op, fd);
      i += op.length;
      continue;
    }
    add(c, 'n');
    i++;
  }
  endWord();
  return tokens;
}

/* Group tokens into statements: simple commands plus subshell open and close markers. */
function toStatements(tokens) {
  const statements = [];
  let current = { t: 'cmd', words: [], redirs: [] };
  const flush = () => {
    if (current.words.length || current.redirs.length) statements.push(current);
    current = { t: 'cmd', words: [], redirs: [] };
  };
  for (const token of tokens) {
    if (token.k === 'word') current.words.push(token.w);
    else if (token.k === 'redir') current.redirs.push(token);
    else if (token.v === '(') { flush(); statements.push({ t: 'open' }); } else if (token.v === ')') { flush(); statements.push({ t: 'close' }); } else flush();
  }
  flush();
  return statements;
}

/* ------------------------------------------------------------------ word expansion */

const literal = word => word.segs.map(s => s.t).join('');
const display = word => literal(word).split(DYN).join('$(\u2026)');

function lookupVariable(name, state, run) {
  if (name === 'HOME') return { text: run.ctx.home, home: true };
  if (name === 'OLDPWD') return { dynamic: true, home: true };
  if (name === 'PWD') return state.cwd === null ? { dynamic: true } : { text: state.cwd };
  if (name === 'TMPDIR' || name === 'CLAUDE_CODE_TMPDIR') return { text: run.ctx.tmp };
  const value = state.vars.get(name);
  if (value && !value.dynamic) return { text: value.text };
  if (value) return { dynamic: true };
  /* Not set by the command itself: use what the pilot inherited, when that is a single absolute path. A list such as
     PATH, a relative value or a missing variable stays unknown. */
  const inherited = run.ctx.env && Object.prototype.hasOwnProperty.call(run.ctx.env, name) ? run.ctx.env[name] : undefined;
  if (typeof inherited === 'string' && inherited.startsWith('/') && !inherited.includes(':') && !inherited.includes(DYN)) {
    return { text: inherited, inherited: true };
  }
  return { dynamic: true };
}

/* Expand a word the way the shell would, as far as it can be known statically.
   Returns { text, dynamic, prefix, home, inherited }. `prefix` is the text before the first unknown part. `inherited` is
   true when a variable's value came from the pilot's environment and not from the command. */
function expand(word, state, run) {
  let text = '';
  let dynamic = false;
  let prefixEnd = 0;
  let home = false;
  let inherited = false;
  let subIndex = 0;
  const markDynamic = () => {
    if (!dynamic) { dynamic = true; prefixEnd = text.length; }
    text += DYN;
  };

  word.segs.forEach((seg, segIndex) => {
    if (seg.q === 's') {
      if (HOME_RE.test(seg.t)) home = true;
      text += seg.t;
      return;
    }
    const value = seg.t;
    let k = 0;
    const tilde = segIndex === 0 && (seg.q === 'n' ? value[0] === '~' : value === '~' || value.startsWith('~/'));
    if (tilde) {
      const slash = value.indexOf('/');
      home = true;
      if (slash === 1 || (slash < 0 && value.length === 1)) text += run.ctx.home;
      else markDynamic();
      k = slash < 0 ? value.length : slash;
    }
    while (k < value.length) {
      const ch = value[k];
      if (ch === DYN) {
        const sub = word.subs[subIndex++];
        if (typeof sub === 'string' && /^\s*pwd\s*$/.test(sub) && state.cwd !== null) text += state.cwd;
        else markDynamic();
        k++;
        continue;
      }
      if (ch !== '$') { text += ch; k++; continue; }
      let name = '';
      let length = 1;
      let complex = false;
      if (value[k + 1] === '{') {
        const close = value.indexOf('}', k + 2);
        const inner = value.slice(k + 2, close < 0 ? value.length : close);
        const m = /^([A-Za-z_][A-Za-z0-9_]*)([^]*)$/.exec(inner);
        name = m ? m[1] : '';
        complex = !m || m[2] !== '';
        length = (close < 0 ? value.length : close + 1) - k;
      } else {
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(value.slice(k + 1));
        if (m) { name = m[0]; length = 1 + name.length; } else if (/[0-9?$!#@*-]/.test(value[k + 1] || '')) { length = 2; complex = true; }
      }
      if (length === 1) { text += '$'; k++; continue; }
      if (!name || complex) {
        if (HOME_RE.test(value.slice(k, k + length))) home = true;
        markDynamic();
      } else {
        const found = lookupVariable(name, state, run);
        if (found.home) home = true;
        if (found.inherited) inherited = true;
        if (found.dynamic) markDynamic();
        else text += found.text;
      }
      k += length;
    }
  });
  return { text, dynamic, prefix: dynamic ? text.slice(0, prefixEnd) : text, home, inherited };
}

/* ------------------------------------------------------------------ command knowledge */

const RESERVED = new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'select', '{', '}', '!', '[[', ']]', 'coproc']);
const WRAPPERS = new Set(['env', 'command', 'builtin', 'exec', 'nohup', 'time', 'sudo', 'nice', 'timeout', 'stdbuf']);
const WRAPPER_VALUE_OPTS = new Map([
  ['nice', ['-n']], ['env', ['-u', '-C', '-S']], ['timeout', ['-s', '-k']],
  ['sudo', ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U']],
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash']);
const DECLARERS = new Set(['export', 'declare', 'local', 'readonly', 'typeset']);

/* The option that introduces code given to an interpreter on the command line. */
const INLINE_CODE = new Map([
  ['python', /^-[A-Za-z]*c$/], ['perl', /^-[A-Za-z]*[eE]$/], ['ruby', /^-e$/], ['php', /^-r$/],
  ['node', /^(?:-e|-p|-pe|--eval|--print)$/], ['nodejs', /^(?:-e|-p|-pe|--eval|--print)$/],
  ['Rscript', /^-e$/], ['R', /^-e$/], ['lua', /^-e$/],
]);

/* Argument grammar for commands whose arguments are not all paths.
   val: short options with a plain value. script/file: short options whose value is a script or a file. l-prefixed
   fields list the long options. first: 'script' when the first positional is a script unless a script or file option
   was given. text: positional arguments are plain text. pair/pairFile: long options that take two values. */
const spec = (fields) => ({ val: '', lval: [], script: '', lscript: [], file: '', lfile: [], pair: [], pairFile: [], first: '', text: false, ...fields });
const GREP = spec({ val: 'mABCdD', lval: ['max-count', 'after-context', 'before-context', 'context', 'directories', 'devices', 'include', 'exclude', 'exclude-dir', 'label', 'binary-files', 'color', 'colour'], script: 'e', lscript: ['regexp'], file: 'f', lfile: ['file', 'exclude-from'], first: 'script' });
const RG = spec({ val: 'mABCgtTjMEdr', lval: ['max-count', 'after-context', 'before-context', 'context', 'glob', 'iglob', 'type', 'type-not', 'type-add', 'threads', 'max-columns', 'encoding', 'max-depth', 'replace', 'colors', 'sort', 'sortr', 'max-filesize'], script: 'e', lscript: ['regexp'], file: 'f', lfile: ['file', 'ignore-file'], first: 'script' });
const AWK = spec({ val: 'Fv', lval: ['field-separator', 'assign'], script: 'e', lscript: ['source'], file: 'f', lfile: ['file'], first: 'script' });
const TEXT_ONLY = spec({ text: true });
const SPECS = new Map([
  ['grep', GREP], ['egrep', GREP], ['fgrep', GREP], ['zgrep', GREP], ['rg', RG], ['ag', RG],
  ['sed', spec({ val: 'l', lval: ['line-length'], script: 'e', lscript: ['expression'], file: 'f', lfile: ['file'], first: 'script' })],
  ['awk', AWK], ['gawk', AWK], ['mawk', AWK], ['nawk', AWK],
  ['jq', spec({ val: 'L', lval: ['indent'], file: 'f', lfile: ['from-file'], pair: ['arg', 'argjson'], pairFile: ['slurpfile', 'rawfile'], first: 'script' })],
  ['cut', spec({ val: 'dfcb', lval: ['delimiter', 'fields', 'characters', 'bytes', 'output-delimiter'] })],
  ['sort', spec({ val: 'tkS', lval: ['field-separator', 'key', 'buffer-size'], file: 'oT', lfile: ['output', 'temporary-directory', 'files0-from'] })],
  ['head', spec({ val: 'nc', lval: ['lines', 'bytes'] })],
  ['tail', spec({ val: 'ncs', lval: ['lines', 'bytes', 'sleep-interval'] })],
  ['tr', TEXT_ONLY], ['echo', TEXT_ONLY], ['printf', TEXT_ONLY], ['expr', TEXT_ONLY], ['seq', TEXT_ONLY],
]);

/* find: starting points come first, then an expression whose pattern operands are not paths. */
const FIND_PATTERN_OPTS = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-lname', '-ilname', '-printf', '-fprintf']);
const FIND_PLAIN_TOKENS = new Set(['(', ')', '!', '{}', ';', '+']);

/* Decide what each argument is: 'path' (check it), 'skip' (an option or a plain value), 'script' (scan as a script)
   or 'text' (a path only if it is a bare word that starts with a slash). */
function classifyArguments(grammar, texts) {
  const kinds = texts.map(() => 'path');
  const positional = [];
  let scriptGiven = false;
  let endOfOptions = false;
  const shortRole = ch => (grammar.script.includes(ch) ? 'script' : grammar.file.includes(ch) ? 'file' : grammar.val.includes(ch) ? 'val' : null);
  const longRole = name => {
    if (grammar.lscript.includes(name)) return 'script';
    if (grammar.lfile.includes(name)) return 'file';
    if (grammar.lval.includes(name)) return 'val';
    if (grammar.pair.includes(name)) return 'pair';
    if (grammar.pairFile.includes(name)) return 'pairFile';
    return null;
  };
  const valueKind = { script: 'script', file: 'path', val: 'skip' };
  const assign = (index, kind) => { if (index < kinds.length) kinds[index] = kind; };
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    if (endOfOptions || t === '-' || t[0] !== '-') { positional.push(i); continue; }
    if (t === '--') { kinds[i] = 'skip'; endOfOptions = true; continue; }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const role = longRole(t.slice(2, eq < 0 ? t.length : eq));
      if (role === 'script' || role === 'file') scriptGiven = true;
      if (eq >= 0) { kinds[i] = role === 'script' ? 'script' : role === 'val' ? 'skip' : 'path'; continue; }
      kinds[i] = 'skip';
      if (role === 'pair') { assign(i + 1, 'skip'); assign(i + 2, 'skip'); i += 2; } else if (role === 'pairFile') { assign(i + 1, 'skip'); assign(i + 2, 'path'); i += 2; } else if (role) { assign(i + 1, valueKind[role]); i++; }
      continue;
    }
    kinds[i] = 'skip';
    for (let k = 1; k < t.length; k++) {
      const role = shortRole(t[k]);
      if (!role) continue;
      if (role === 'script' || role === 'file') scriptGiven = true;
      if (k < t.length - 1) kinds[i] = role === 'script' ? 'script' : 'skip';
      else { assign(i + 1, valueKind[role]); i++; }
      break;
    }
  }
  if (grammar.text) positional.forEach(index => { kinds[index] = 'text'; });
  else if (grammar.first === 'script' && !scriptGiven && positional.length) kinds[positional[0]] = 'script';
  return kinds;
}

/* ------------------------------------------------------------------ brace expansion */

/* The first outermost {a,b} group inside one unquoted piece of text, as { start, end, commas }, or null. One pass with a
   stack, so a long run of braces costs no more than its length. ${...} is skipped whole, and a group without a comma ({}
   or {x}) is not an expansion. */
function findBraceGroup(text) {
  const open = []; /* { start, commas } for each { that is still open */
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '$' && text[i + 1] === '{') {
      const close = text.indexOf('}', i + 2);
      if (close < 0) return null;
      i = close;
    } else if (c === '{') open.push({ start: i, commas: [] });
    else if (c === ',' && open.length) open[open.length - 1].commas.push(i);
    else if (c === '}' && open.length) {
      const group = open.pop();
      if (!open.length && group.commas.length) return { start: group.start, end: i, commas: group.commas };
    }
  }
  return null;
}

/* Brace expansion of one word: {cat,/etc/hosts} is two words. Only a group written wholly in one unquoted piece is
   expanded, and a word that also holds a substitution is left as it is. The expansion is capped (MAX_BRACE_STEPS steps)
   and a word over the cap makes the call fail closed. */
function expandBraces(word) {
  if (word.subs.length) return [word];
  const results = [];
  let overflow = false;
  let steps = 0;
  const walk = segs => {
    if (overflow) return;
    if (++steps > MAX_BRACE_STEPS) { overflow = true; return; }
    for (let si = 0; si < segs.length; si++) {
      if (segs[si].q !== 'n') continue;
      const text = segs[si].t;
      const group = findBraceGroup(text);
      if (!group) continue;
      const bounds = [group.start, ...group.commas, group.end];
      for (let b = 0; b < bounds.length - 1; b++) {
        const replaced = text.slice(0, group.start) + text.slice(bounds[b] + 1, bounds[b + 1]) + text.slice(group.end + 1);
        walk([...segs.slice(0, si), { t: replaced, q: 'n' }, ...segs.slice(si + 1)]);
      }
      return;
    }
    results.push({ segs, subs: [] });
  };
  walk(word.segs);
  /* Words that would not be looked at cannot be shown to stay inside the folder, so the call fails closed. */
  if (overflow) throw new RangeError('a brace expansion is too large to audit');
  return results.length ? results : [word];
}

/* The words of a simple command after brace expansion. Leading NAME=value words are assignments and are not expanded. */
function expandCommandWords(words) {
  const out = [];
  let leading = true;
  for (const word of words) {
    if (leading && parseAssignment(word)) { out.push(word); continue; }
    leading = false;
    out.push(...expandBraces(word));
  }
  return out;
}

/* ------------------------------------------------------------------ command evaluation */

function parseAssignment(word) {
  const first = word.segs[0];
  if (!first || first.q !== 'n') return null;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(first.t);
  if (!m) return null;
  const value = { segs: word.segs.map(s => ({ ...s })), subs: word.subs };
  value.segs[0].t = first.t.slice(m[0].length);
  if (value.segs[0].t === '') value.segs.shift();
  return { name: m[1], value };
}

function applyAssignment(assignment, run, state, persist) {
  const exp = expand(assignment.value, state, run);
  if (exp.home) run.report('home', display(assignment.value));
  if (persist) state.vars.set(assignment.name, { text: exp.text, dynamic: exp.dynamic });
}

/* Skip reserved words and wrapper commands (env, time, nohup, ...) to reach the command that really runs. */
function skipPrefix(words, start) {
  let idx = start;
  while (idx < words.length) {
    const name = literal(words[idx]);
    if (RESERVED.has(name)) { idx++; continue; }
    if (!WRAPPERS.has(name)) break;
    idx++;
    const valueOptions = WRAPPER_VALUE_OPTS.get(name) || [];
    while (idx < words.length) {
      const text = literal(words[idx]);
      if (valueOptions.includes(text)) { idx += 2; continue; }
      if (text.startsWith('-') || parseAssignment(words[idx])) { idx++; continue; }
      break;
    }
    if (name === 'timeout' && idx < words.length) idx++;
  }
  return idx;
}

function checkRedirect(redirect, run, state) {
  if (!redirect.target || redirect.op === '<<' || redirect.op === '<<-') return;
  const exp = expand(redirect.target, state, run);
  if (redirect.op === '<<<') {
    if (exp.home) run.report('home', display(redirect.target));
    else scanText(exp.text, run, state, 'text');
    return;
  }
  if ((redirect.op === '>&' || redirect.op === '<&') && /^(?:\d+|-)$/.test(exp.text)) return;
  checkExpansion(exp, display(redirect.target), run, state, redirect.op !== '<');
}

/* The value of --option=value or NAME=value, checked when it looks like a path. */
function checkAssignedValue(exp, eq, shown, run, state) {
  const target = exp.dynamic ? exp.prefix : exp.text;
  const value = { text: exp.text.slice(eq + 1), prefix: target.slice(eq + 1), dynamic: exp.dynamic, home: false };
  const probe = value.dynamic ? value.prefix : value.text;
  if (probe.startsWith('~')) {
    const plain = probe === '~' || probe.startsWith('~/');
    checkExpansion({ text: plain ? path.join(run.ctx.home, probe.slice(1)) : probe, prefix: '', dynamic: !plain, home: true }, shown, run, state);
  } else if (probe.startsWith('/') || probe.split('/').includes('..')) checkExpansion(value, shown, run, state);
}

/* One shell word. kind is 'path' or 'text' (see classifyArguments). */
function checkWord(word, kind, run, state) {
  const exp = expand(word, state, run);
  const shown = display(word);
  if (exp.home) { checkExpansion(exp, shown, run, state); return; }
  const target = exp.dynamic ? exp.prefix : exp.text;
  if (kind === 'text') { /* echo, printf and friends print their arguments, but an unquoted /* still lists a directory */
    /* Printing a variable that holds a path is not an access, so an inherited value is not checked here. */
    if (!word.segs.some(s => s.q !== 'n') && target.startsWith('/') && !exp.inherited) checkExpansion(exp, shown, run, state);
    return;
  }
  if (target.length > 1 && target[0] === '-' && word.segs[0].q === 'n') {
    const eq = target.indexOf('=');
    if (eq > 0) checkAssignedValue(exp, eq, shown, run, state);
    else if (/^-[A-Za-z]\/./.test(target)) checkAssignedValue(exp, 1, shown, run, state); /* -C/dir, -I/dir */
    return;
  }
  const assigned = /^[A-Za-z_][\w.-]*=/.exec(target);
  if (assigned) { checkAssignedValue(exp, assigned[0].length - 1, shown, run, state); return; }
  if (/^file:\/\//i.test(target)) {
    checkExpansion({ text: exp.text.slice(7), prefix: exp.prefix.slice(7), dynamic: exp.dynamic, home: false }, shown, run, state);
    return;
  }
  /* A URL is not a path. Only a word with nothing to expand in it is exempt: the commands inside a substitution that
     sits in a URL are audited on their own, and `x://../..` (no host) is a relative path like any other. */
  if (!exp.dynamic && isPlainUrl(exp.text)) return;
  checkExpansion(exp, shown, run, state);
  if (/\s/.test(exp.text) && !target.startsWith('/')) scanText(exp.text, run, state, 'text');
}

/* Notes for commands whose real target the audit cannot read from the text. They never discard a run: the audit reads
   commands as text, and these are the shapes where the text is not the whole story. */
const UNVERIFIABLE_COMMAND = 'unverifiable-command: a command name was built from a variable or command output, so what it ran and which paths it used cannot be checked';
const UNVERIFIABLE_CODE = 'unverifiable-code: code given to eval or a shell was built at run time, so only its visible part was checked';
const UNVERIFIABLE_INPUT = 'unverifiable-input: a shell read its commands from its input (for example a pipe), so those commands were not checked';

function handleCd(name, args, run, state) {
  if (name === 'popd') {
    const previous = state.dirStack.pop();
    if (previous !== undefined) { state.oldpwd = state.cwd; state.cwd = previous; }
    return;
  }
  const operands = [];
  let endOfOptions = false;
  for (const word of args) {
    const text = literal(word);
    if (!endOfOptions && text === '--') { endOfOptions = true; continue; }
    if (!endOfOptions && text.startsWith('-') && text !== '-') continue;
    operands.push(word);
  }
  if (!operands.length) {
    if (name === 'cd') {
      run.report('bare-cd', '(home directory)');
      state.oldpwd = state.cwd;
      state.cwd = null;
    }
    return;
  }
  const word = operands[0];
  const exp = expand(word, state, run);
  if (name === 'pushd') state.dirStack.push(state.cwd);
  if (literal(word) === '-') {
    changeToOldpwd(run, state);
    return;
  }
  if (exp.text === '' && !exp.dynamic && !exp.home) return;
  const before = state.cwd;
  const resolved = checkExpansion(exp, display(word), run, state);
  if (resolved === null && exp.dynamic && !exp.home) run.note(CWD_UNRESOLVED);
  state.oldpwd = before;
  state.cwd = resolved;
}

const CWD_UNRESOLVED = 'cwd-unresolved: a cd target could not be resolved statically, so relative paths after it cannot be checked (only ".." paths are still flagged)';

/* `cd -` goes to $OLDPWD. A shell can start with OLDPWD set by whatever launched it, so while the previous directory is
   unknown (nothing in this command has changed directory yet) the jump is a home-kind violation, like a bare $OLDPWD. */
function changeToOldpwd(run, state) {
  const target = state.oldpwd;
  state.oldpwd = state.cwd;
  if (target === null) {
    run.report('home', '$OLDPWD (cd -)');
    run.note(CWD_UNRESOLVED);
    state.cwd = null;
    return;
  }
  state.cwd = target;
  if (!run.ctx.inside(target)) {
    const violation = classifyAbsolute(run.ctx, target);
    if (violation) run.report(violation.kind, violation.path);
  }
}

function evaluateFind(args, run, state) {
  let inExpression = false;
  for (let i = 0; i < args.length; i++) {
    const text = literal(args[i]);
    if (!inExpression && (text.startsWith('-') || text === '(' || text === '!')) inExpression = true;
    if (FIND_PATTERN_OPTS.has(text)) {
      if (args[i + 1]) scanText(literal(args[i + 1]), run, state, 'script');
      i++;
      continue;
    }
    if (inExpression && (text.startsWith('-') || FIND_PLAIN_TOKENS.has(text))) continue;
    checkWord(args[i], 'path', run, state);
  }
}

function evaluateWithGrammar(grammar, args, run, state) {
  const kinds = classifyArguments(grammar, args.map(literal));
  args.forEach((word, index) => {
    const kind = kinds[index];
    if (kind === 'skip') return;
    if (kind === 'script') scanText(literal(word), run, state, 'script');
    else checkWord(word, kind, run, state);
  });
}

function runHeredocs(redirects, isShell, run, state, depth) {
  for (const redirect of redirects) {
    if (typeof redirect.heredoc !== 'string') continue;
    if (isShell && depth < MAX_SHELL_DEPTH) auditShell(redirect.heredoc, run, cloneState(state), depth + 1);
    else scanText(redirect.heredoc, run, state, 'text');
  }
}

/* The code string given with -c (or an interpreter's inline code flag), or -1 when there is none. */
function findCodeFlag(args, matcher) {
  const flag = args.findIndex(word => matcher.test(literal(word)));
  return flag >= 0 && args[flag + 1] ? flag : -1;
}

function checkOtherArguments(args, skipA, skipB, run, state) {
  args.forEach((word, index) => { if (index !== skipA && index !== skipB) checkWord(word, 'path', run, state); });
}

/* Commands inside $( ), backticks and <( ) run in a subshell before the command that uses their output. */
function auditSubstitutions(command, run, state, depth) {
  const words = command.words.concat(command.redirs.map(redirect => redirect.target).filter(Boolean));
  for (const word of words) {
    for (const sub of word.subs) {
      if (typeof sub !== 'string' || !sub.trim()) continue;
      if (depth < MAX_SHELL_DEPTH) auditShell(sub, run, cloneState(state), depth + 1);
      else scanText(sub, run, state, 'text');
    }
  }
}

function evaluateCommand(command, run, state, depth) {
  if (++run.statements > MAX_STATEMENTS_PER_CALL) throw new RangeError('too many shell statements to audit');
  run.ctx.tick();
  const words = expandCommandWords(command.words);
  auditSubstitutions(command, run, state, depth);
  command.redirs.forEach(redirect => checkRedirect(redirect, run, state));
  let idx = 0;
  const assignments = [];
  while (idx < words.length) {
    const assignment = parseAssignment(words[idx]);
    if (!assignment) break;
    assignments.push(assignment);
    idx++;
  }
  const persist = idx === words.length;
  assignments.forEach(assignment => applyAssignment(assignment, run, state, persist));
  if (persist) return;
  idx = skipPrefix(words, idx);
  if (idx >= words.length) return;

  const nameWord = words[idx];
  const name = literal(nameWord);
  const exe = path.posix.basename(name);
  const args = words.slice(idx + 1);
  const plain = !name.includes('/');
  const nameExp = expand(nameWord, state, run);
  if (!plain || nameExp.dynamic) checkWord(nameWord, 'path', run, state);
  if (nameExp.dynamic && !nameExp.prefix) run.note(UNVERIFIABLE_COMMAND);

  if (plain && (name === 'cd' || name === 'chdir' || name === 'pushd' || name === 'popd')) {
    handleCd(name === 'chdir' ? 'cd' : name, args, run, state);
    return;
  }
  if (plain && DECLARERS.has(name)) {
    args.forEach(word => {
      const assignment = parseAssignment(word);
      if (assignment) applyAssignment(assignment, run, state, true);
      else if (!literal(word).startsWith('-')) checkWord(word, 'path', run, state);
    });
    return;
  }
  if (plain && name === 'eval') {
    const expansions = args.map(word => expand(word, state, run));
    if (expansions.some(exp => exp.dynamic)) run.note(UNVERIFIABLE_CODE);
    const joined = expansions.map(exp => exp.text).join(' ');
    if (depth < MAX_SHELL_DEPTH) auditShell(joined, run, state, depth + 1);
    else scanText(joined, run, state, 'text');
    return;
  }
  if (SHELLS.has(exe)) {
    const flag = findCodeFlag(args, /^-[A-Za-z]*c[A-Za-z]*$/);
    if (flag >= 0) {
      const codeExp = expand(args[flag + 1], state, run);
      if (codeExp.dynamic) run.note(UNVERIFIABLE_CODE);
      const code = codeExp.text;
      if (depth < MAX_SHELL_DEPTH) auditShell(code, run, cloneState(state), depth + 1);
      else scanText(code, run, state, 'text');
      checkOtherArguments(args, flag, flag + 1, run, state);
      return;
    }
    args.forEach(word => checkWord(word, 'path', run, state));
    runHeredocs(command.redirs, true, run, state, depth);
    if (!args.some(word => !literal(word).startsWith('-')) && !command.redirs.some(redirect => redirect.op.startsWith('<'))) run.note(UNVERIFIABLE_INPUT);
    return;
  }
  const inline = INLINE_CODE.get(exe.replace(/[\d.]+$/, ''));
  const codeFlag = inline ? findCodeFlag(args, inline) : -1;
  if (codeFlag >= 0) {
    scanText(expand(args[codeFlag + 1], state, run).text, run, state, 'text');
    checkOtherArguments(args, codeFlag, codeFlag + 1, run, state);
    runHeredocs(command.redirs, false, run, state, depth);
    return;
  }
  if (exe === 'find') evaluateFind(args, run, state);
  else if (SPECS.has(exe)) evaluateWithGrammar(SPECS.get(exe), args, run, state);
  else args.forEach(word => checkWord(word, 'path', run, state));
  runHeredocs(command.redirs, false, run, state, depth);
}

function auditShell(code, run, state, depth) {
  const stack = [];
  for (const statement of toStatements(lex(code))) {
    if (statement.t === 'open') stack.push(cloneState(state));
    else if (statement.t === 'close') {
      const snapshot = stack.pop();
      if (snapshot) restoreState(state, snapshot);
    } else evaluateCommand(statement, run, state, depth);
  }
}

/* ------------------------------------------------------------------ file tools */

const isPathKey = (tool, key) => FILE_PATH_KEYS.has(key) || (tool === 'Glob' && key === 'pattern');

function checkToolPath(value, run, folder, write) {
  const text = value.trim();
  if (!text || isPlainUrl(text)) return;
  const tilde = text === '~' || text.startsWith('~/');
  let exp = { text, prefix: text, dynamic: false, home: false };
  if (tilde) exp = { text: path.join(run.ctx.home, text.slice(1)), prefix: '', dynamic: false, home: true };
  else if (HOME_RE.test(text)) exp = { text, prefix: '', dynamic: true, home: true };
  checkExpansion(exp, text, run, freshState(folder), write);
}

/* Every string value of a file tool call. Path-bearing fields are checked as paths, the rest (file contents, patterns,
   edits) as free text. Relative paths resolve against the pilot folder, which is the agent's working directory. */
function auditFileTool(tool, input, run, folder) {
  const state = freshState(folder);
  const write = WRITING_TOOLS.has(tool);
  const walk = (value, key, depth) => {
    if (depth > 8) return;
    if (typeof value === 'string') {
      if (isPathKey(tool, key)) checkToolPath(value, run, folder, write);
      else scanText(value, run, state, tool === 'Grep' && key === 'pattern' ? 'script' : 'text');
    } else if (Array.isArray(value)) value.forEach(item => walk(item, key, depth + 1));
    else if (isObject(value)) for (const [childKey, child] of Object.entries(value)) walk(child, childKey, depth + 1);
  };
  walk(input, '', 0);
}

/* ------------------------------------------------------------------ public audit */

/* macOS reports its temporary and system folders by their physical names (/private/var, /private/tmp, /private/etc).
   They are not the project's private/ folder, so they are removed before the text is checked. */
const SYSTEM_PRIVATE_RE = /(^|[^\w/])\/private\/(?:var|tmp|etc)(?![\w-])/g;

function addLeakNotes(events, projectRoot, notes) {
  let count = 0;
  for (const result of toolResultTexts(events)) {
    const mentionsRoot = typeof projectRoot === 'string' && projectRoot !== '' && result.text.includes(projectRoot);
    if (!mentionsRoot && !/(^|[^\w])private\//.test(result.text.replace(SYSTEM_PRIVATE_RE, '$1'))) continue;
    if (count++ >= MAX_LEAK_NOTES) break;
    notes.add(`leak-in-results: tool result ${result.toolUseId || '(unnamed)'} mentions the project root or private/`);
  }
}

/* The directory a shell starts in with OLDPWD set: only a single absolute path counts. */
function inheritedOldpwd(env) {
  const value = env && typeof env.OLDPWD === 'string' ? env.OLDPWD : '';
  return value.startsWith('/') && !value.includes('\0') ? path.resolve(value) : null;
}

/* auditToolCalls(events, { folder, claudeConfigDir, projectRoot?, env?, budgetMs?, clock? })
   events: parsed stream-json objects. folder: the pilot folder (required). claudeConfigDir defaults to
   $CLAUDE_CONFIG_DIR or ~/.claude. projectRoot only enables the leak-in-results note; it never relaxes the audit.
   env: the environment the pilot was started with. A variable that the command did not set itself is looked up there,
   so `$SOME_VAR/x` is checked when the pilot inherited SOME_VAR=/some/absolute/path. Without it, such a variable is
   unknown and a path that starts with it cannot be checked.
   budgetMs (default 5000) and clock (default Date.now) bound the work: a call that cannot be analysed within the budget
   or the size caps fails closed like any other call that cannot be analysed.
   Returns { status: 'CLEAN' | 'DISCARDED', violations: [{ tool, kind, path, call }], notes: [string] }. */
function auditToolCalls(events, options) {
  const opts = isObject(options) ? options : {};
  if (typeof opts.folder !== 'string' || !opts.folder || opts.folder.includes('\0')) throw new TypeError('auditToolCalls needs the pilot folder');
  const folder = path.resolve(opts.folder);
  if (folder === path.parse(folder).root) throw new TypeError('The pilot folder cannot be the filesystem root');
  const ctx = makeContext(folder, {
    claudeConfigDir: typeof opts.claudeConfigDir === 'string' ? opts.claudeConfigDir : '',
    env: opts.env,
    budgetMs: opts.budgetMs,
    clock: opts.clock,
  });
  const startingOldpwd = inheritedOldpwd(ctx.env);
  const violations = [];
  const notes = new Set();
  const shell = freshState(folder, startingOldpwd);
  for (const call of extractToolCalls(events)) {
    const run = makeRun(ctx, call, violations, notes);
    try {
      ctx.tick();
      if (call.name === 'Bash') {
        if (typeof call.input.command === 'string') {
          if (call.input.command.length > MAX_COMMAND_CHARS) throw new RangeError('the command is too long to audit');
          /* The working directory carries over from call to call. The previous directory (OLDPWD) does not: it is only
             trusted inside one command, because each call may start a new shell. */
          shell.oldpwd = startingOldpwd;
          auditShell(call.input.command, run, shell, 0);
        }
      } else {
        if (!KNOWN_FILE_TOOLS.has(call.name)) notes.add(`unexpected-tool: ${call.name}`);
        auditFileTool(call.name, call.input, run, folder);
      }
    } catch (error) {
      /* A call that cannot be analysed cannot be shown to stay inside the folder, so the audit fails closed. */
      notes.add(`audit-error: a ${call.name} call could not be analysed (${error && error.message ? error.message : 'unknown error'})`);
      run.report('abs', '(call could not be analysed)');
    }
  }
  addLeakNotes(events, opts.projectRoot, notes);
  return { status: violations.length ? 'DISCARDED' : 'CLEAN', violations, notes: [...notes] };
}

module.exports = { cwdKeyFor, extractToolCalls, toolResultTexts, auditToolCalls };
