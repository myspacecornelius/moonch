#!/usr/bin/env node
'use strict';

/*
 * Privacy scan (docs/local-agents.md, section 14).
 *
 * Blocks a push that would carry private task content. The term list is NOT in the repository:
 * it is read from <root>/private/privacy-terms.txt (or --terms). The scanner is generic and fails closed.
 *
 *   node scripts/privacy-scan.cjs [--terms <file>] [--range <base>..<head>] [--root <dir>]
 *
 * Term file: one term per line. Blank lines and lines starting with # are ignored. A term written as
 * /pattern/flags is a regular expression (flags from dgimsuvy; g and y are ignored). Anything else is a
 * case-insensitive literal. Leading and trailing whitespace on a line is trimmed. Matching is per line.
 * Each term is identified by the 1-based LINE NUMBER of its line in the term file (comments and blanks count).
 *
 * What is scanned
 *   - every file git tracks and every untracked file git does not ignore (text only), plus every path name;
 *   - with --range, the lines ADDED by the commits in the range: each commit on its own (history is what a
 *     push publishes, so a term added and then removed inside the range still counts) and the net diff.
 *
 * Output: "HIT <file>:<line> term <index>" for each hit. The line number is 0 for a hit in a path name.
 * The matched text and the term are never printed, and any term match inside a printed path or git message
 * is replaced by [redacted]. The last line is a one line summary.
 *
 * Exit codes: 0 clean, 1 at least one hit, 2 usage or configuration error (fail closed).
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const EXIT_CLEAN = 0;
const EXIT_HITS = 1;
const EXIT_ERROR = 2;

const NO_TERMS_MESSAGE = 'no privacy term list: refusing to pass';
const USAGE = 'usage: node scripts/privacy-scan.cjs [--terms <file>] [--range <base>..<head>] [--root <dir>]';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_PRINTED_HITS = 500;
const MAX_LISTED_PATHS = 100;

const REGEX_TERM = /^\/(.+)\/([dgimsuvy]*)$/;
const REDACTION_MARK = '';
const COMMIT_MARK = '\u0001';

/* Variables that would make git look at a different repository than --root, or run a helper program. */
const GIT_ENV_TO_DROP = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_EXTERNAL_DIFF',
];

const DIFF_ARGS = [
  '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0', '--src-prefix=a/', '--dst-prefix=b/',
];

/** An error that ends the run with exit code 2. Its text never contains a term. */
class ScanError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'ScanError';
    this.details = details;
  }
}

/* ---------- arguments ---------- */

function parseArgs(argv) {
  const options = { terms: null, range: null, root: null, help: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    if (name !== '--terms' && name !== '--range' && name !== '--root') {
      throw new ScanError(`unknown argument: ${arg}`, [USAGE]);
    }
    const key = name.slice(2);
    if (seen.has(key)) throw new ScanError(`${name} given more than once`, [USAGE]);
    seen.add(key);
    let value;
    if (equals > 0) {
      value = arg.slice(equals + 1);
    } else {
      i += 1;
      value = argv[i];
    }
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
      throw new ScanError(`${name} needs a value`, [USAGE]);
    }
    options[key] = value;
  }
  return options;
}

/** Accepts exactly <base>..<head>. Neither side may look like a git option. Returns the validated string. */
function validateRange(range) {
  const parts = range.split('..');
  const revision = /^[A-Za-z0-9_@{}~^:+/.-]+$/;
  const ok = parts.length === 2 && parts.every(part => (
    part !== '' && revision.test(part) && !part.startsWith('-') && !part.startsWith('.') && !part.endsWith('.')
  ));
  if (!ok) throw new ScanError('--range must look like <base>..<head>', [USAGE]);
  return range;
}

/* ---------- terms ---------- */

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileTerm(text, index) {
  const wrapped = REGEX_TERM.exec(text);
  const source = wrapped ? wrapped[1] : escapeRegExp(text);
  const flags = wrapped ? wrapped[2].replace(/[gy]/g, '') : 'iu';
  let test;
  let global;
  try {
    test = new RegExp(source, flags);
    global = new RegExp(source, `${flags}g`);
  } catch {
    /* The JavaScript error text quotes the pattern, so it is deliberately not forwarded. */
    throw new ScanError(`term file line ${index}: invalid regular expression`);
  }
  if (test.test('')) throw new ScanError(`term file line ${index}: the term matches the empty string`);
  return { index, test, global };
}

/** Parses term file text into matchers. Pure. Throws ScanError for an invalid term. */
function parseTerms(text) {
  const matchers = [];
  text.split('\n').forEach((raw, position) => {
    const line = raw.replace(/\r$/, '').trim();
    if (line === '' || line.startsWith('#')) return;
    matchers.push(compileTerm(line, position + 1));
  });
  return matchers;
}

function noTermList(file) {
  return new ScanError(NO_TERMS_MESSAGE, [`looked for: ${file}`]);
}

function loadTerms(file) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    throw noTermList(file);
  }
  /* A UTF-16 file decodes as UTF-8 with NUL bytes between letters and would silently never match. */
  if (bytes.includes(0)) throw new ScanError('the term file must be UTF-8 text (it contains NUL bytes)');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ScanError('the term file must be valid UTF-8 text');
  }
  const matchers = parseTerms(text);
  if (matchers.length === 0) throw noTermList(file);
  return matchers;
}

/**
 * Returns safe(text): control characters become "?" (so a hostile file name cannot forge output lines) and
 * every term match becomes [redacted] (so a path or git message cannot echo a term).
 */
function makeSafe(matchers) {
  return function safe(text) {
    let out = String(text);
    for (const matcher of matchers) out = out.replace(matcher.global, REDACTION_MARK);
    return out.replace(/[\u0000-\u001f\u007f]/g, '?').replaceAll(REDACTION_MARK, '[redacted]');
  };
}

/* ---------- git ---------- */

function gitEnvironment() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  for (const name of GIT_ENV_TO_DROP) delete env[name];
  return env;
}

/** Runs git with a fixed argument vector (never a shell string). Returns stdout. */
function git(ctx, args, doing) {
  try {
    return execFileSync('git', args, {
      cwd: ctx.root,
      env: ctx.env,
      encoding: 'utf8',
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    let reason = String(error.code || 'failed');
    if (error.code === 'ENOBUFS') reason = 'output too large, narrow the range';
    else if (typeof error.stderr === 'string' && error.stderr.trim()) reason = error.stderr.trim().split('\n')[0];
    throw new ScanError(`git failed while ${doing}: ${ctx.safe(reason)}`);
  }
}

function assertTopLevel(ctx) {
  const top = git(ctx, ['rev-parse', '--show-toplevel'], 'locating the repository').trim();
  let same = false;
  try {
    same = fs.realpathSync(top) === fs.realpathSync(ctx.root);
  } catch {
    same = false;
  }
  if (!same) throw new ScanError('--root must be the top level of a git work tree');
}

function splitNul(output) {
  return output.split('\0').filter(Boolean);
}

function listFiles(ctx) {
  const tracked = splitNul(git(ctx, ['ls-files', '-z'], 'listing tracked files'));
  const untracked = splitNul(git(ctx, ['ls-files', '-z', '--others', '--exclude-standard'], 'listing untracked files'));
  return { tracked, all: [...new Set([...tracked, ...untracked])].sort() };
}

function isPrivatePath(rel) {
  return rel.toLowerCase().startsWith('private/');
}

function failOnPrivatePaths(ctx, paths, message) {
  if (paths.length === 0) return;
  const shown = paths.slice(0, 20).map(rel => `  ${ctx.safe(rel)}`);
  if (paths.length > shown.length) shown.push(`  ... and ${paths.length - shown.length} more`);
  throw new ScanError(`${paths.length} ${message}`, shown);
}

/* ---------- results ---------- */

function newResult() {
  return {
    filesScanned: 0,
    binary: [],
    oversize: [],
    otherSkipped: [],
    addedLines: 0,
    rangeBinary: 0,
    hits: [],
    seen: new Set(),
  };
}

function addHit(result, key, hit) {
  if (result.seen.has(key)) return;
  result.seen.add(key);
  result.hits.push(hit);
}

/* ---------- reading one file ---------- */

/**
 * Decodes file bytes to text, or returns null for binary content.
 * A NUL byte in the first 8 KB means binary, except UTF-16 with a byte order mark, which is text.
 */
function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    if (buffer[2] === 0 && buffer[3] === 0) return null; /* UTF-32 */
    return buffer.toString('utf16le', 2);
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const body = Buffer.from(buffer.subarray(2, 2 + ((buffer.length - 2) & ~1)));
    return body.swap16().toString('utf16le');
  }
  if (buffer.subarray(0, BINARY_PROBE_BYTES).includes(0)) return null;
  return buffer.toString('utf8').replace(/^﻿/, '');
}

/**
 * Returns {kind:'text', text} | {kind:'binary'} | {kind:'oversize', bytes} | {kind:'skipped', reason}.
 * Never follows a symlink: a link is scanned as its own target string.
 */
function readForScan(absolute) {
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    return { kind: 'skipped', reason: 'missing' };
  }
  if (stat.isSymbolicLink()) {
    try {
      return { kind: 'text', text: fs.readlinkSync(absolute) };
    } catch {
      return { kind: 'skipped', reason: 'unreadable link' };
    }
  }
  if (!stat.isFile()) return { kind: 'skipped', reason: 'not a regular file' };
  if (stat.size > MAX_FILE_BYTES) return { kind: 'oversize', bytes: stat.size };

  let fd;
  try {
    /* O_NOFOLLOW closes the window between the lstat above and the open. */
    fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch {
    return { kind: 'skipped', reason: 'unreadable' };
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) return { kind: 'skipped', reason: 'not a regular file' };
    if (opened.size > MAX_FILE_BYTES) return { kind: 'oversize', bytes: opened.size };
    const buffer = fs.readFileSync(fd);
    if (buffer.length > MAX_FILE_BYTES) return { kind: 'oversize', bytes: buffer.length };
    const text = decodeText(buffer);
    return text === null ? { kind: 'binary' } : { kind: 'text', text };
  } catch {
    return { kind: 'skipped', reason: 'unreadable' };
  } finally {
    fs.closeSync(fd);
  }
}

/* ---------- matching ---------- */

/** Calls onMatch(termIndex) for each term that matches the text. */
function matchTerms(ctx, text, onMatch) {
  for (const matcher of ctx.matchers) {
    if (matcher.test.test(text)) onMatch(matcher.index);
  }
}

function recordNameHits(ctx, rel, result, scope) {
  matchTerms(ctx, rel, index => {
    addHit(result, `name\0${rel}\0${index}`, { file: ctx.safe(rel), line: 0, index, scope });
  });
}

/* ---------- working tree ---------- */

function scanText(ctx, rel, text, result) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '') continue;
    matchTerms(ctx, line, index => {
      addHit(result, `tree\0${rel}\0${i + 1}\0${index}`, { file: ctx.safe(rel), line: i + 1, index, scope: null });
    });
  }
}

/**
 * True when a directory part of the path is a symlink that leaves the repository. lstat and O_NOFOLLOW only
 * guard the last path component, so this closes the case where a tracked directory was swapped for a link.
 */
function leavesRoot(ctx, rel) {
  const dir = path.dirname(rel);
  if (dir === '.') return false;
  if (!ctx.directoryChecks.has(dir)) {
    let inside = false;
    try {
      const real = fs.realpathSync(path.join(ctx.root, dir));
      inside = real === ctx.realRoot || real.startsWith(ctx.realRoot + path.sep);
    } catch {
      inside = false;
    }
    ctx.directoryChecks.set(dir, inside);
  }
  return !ctx.directoryChecks.get(dir);
}

function scanWorkingTree(ctx, files, result) {
  for (const rel of files) {
    recordNameHits(ctx, rel, result, null);
    if (leavesRoot(ctx, rel)) {
      result.otherSkipped.push(`${ctx.safe(rel)} (path crosses a symlink out of the repository)`);
      continue;
    }
    const content = readForScan(path.join(ctx.root, rel));
    if (content.kind === 'text') {
      result.filesScanned += 1;
      scanText(ctx, rel, content.text, result);
    } else if (content.kind === 'binary') {
      result.binary.push(ctx.safe(rel));
    } else if (content.kind === 'oversize') {
      result.oversize.push(`${ctx.safe(rel)} (${content.bytes} bytes)`);
    } else {
      result.otherSkipped.push(`${ctx.safe(rel)} (${content.reason})`);
    }
  }
}

/* ---------- commit range ---------- */

const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** Undoes git's C-style quoting of a path ("a\tb", octal bytes). */
function unquoteCPath(quoted) {
  const body = Buffer.from(quoted.slice(1, quoted.endsWith('"') ? -1 : undefined), 'utf8');
  const bytes = [];
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== 0x5c || i + 1 >= body.length) {
      bytes.push(body[i]);
      continue;
    }
    const next = String.fromCharCode(body[i + 1]);
    if (/[0-7]/.test(next)) {
      let digits = '';
      while (digits.length < 3 && i + 1 < body.length && /[0-7]/.test(String.fromCharCode(body[i + 1]))) {
        digits += String.fromCharCode(body[i + 1]);
        i += 1;
      }
      bytes.push(parseInt(digits, 8) & 0xff);
    } else {
      bytes.push(C_ESCAPES[next] === undefined ? body[i + 1] : C_ESCAPES[next]);
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The new-side path from a "+++ " header, or null for /dev/null (a deleted file). */
function headerPath(raw) {
  let name = raw.endsWith('\t') ? raw.slice(0, -1) : raw;
  if (name === '/dev/null') return null;
  if (name.startsWith('"')) name = unquoteCPath(name);
  return name.startsWith('b/') ? name.slice(2) : name;
}

function hunkStart(line) {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!match) throw new ScanError('could not parse a diff hunk header');
  return Number(match[1]);
}

/**
 * Walks `git diff` / `git log -p` output with --unified=0 and calls visit() with
 *   {type:'file', commit, file}            a file that has a new side,
 *   {type:'added', commit, file, line, text}   one added line (line is the line number in the new file),
 *   {type:'binary', commit}                a binary change, which cannot be scanned.
 * Inside a hunk every line starting with "+" is content, so an added line that begins with "++ " is not
 * mistaken for a "+++" header. Lines of the log format that start with U+0001 carry the commit id.
 */
function walkDiff(output, visit) {
  let commit = null;
  let file = null;
  let inHunk = false;
  let newLine = 0;
  for (const raw of output.split('\n')) {
    if (raw.charCodeAt(0) === 1) {
      commit = raw.slice(1);
      file = null;
      inHunk = false;
    } else if (raw.startsWith('diff --git ')) {
      file = null;
      inHunk = false;
    } else if (raw.startsWith('@@')) {
      newLine = hunkStart(raw);
      inHunk = true;
    } else if (inHunk) {
      if (raw[0] === '+' && file !== null) {
        visit({ type: 'added', commit, file, line: newLine, text: raw.slice(1).replace(/\r$/, '') });
        newLine += 1;
      }
    } else if (raw.startsWith('+++ ')) {
      file = headerPath(raw.slice(4));
      if (file !== null) visit({ type: 'file', commit, file });
    } else if (raw.startsWith('Binary files ')) {
      visit({ type: 'binary', commit });
    }
  }
}

function rangeScope(range, commit) {
  return { range, commit: commit ? commit.slice(0, 12) : null };
}

function scanRange(ctx, range, result) {
  const history = git(ctx, [
    '-c', 'core.quotepath=false', 'log', '--reverse', '-m', '--format=%x01%H', '-p', ...DIFF_ARGS, range, '--',
  ], 'reading the commits in the range');
  const net = git(ctx, [
    '-c', 'core.quotepath=false', 'diff', ...DIFF_ARGS, range, '--',
  ], 'reading the diff of the range');

  const privateAdds = new Set();
  const visitor = countLines => event => {
    if (event.type === 'binary') {
      if (countLines) result.rangeBinary += 1;
    } else if (event.type === 'file') {
      if (isPrivatePath(event.file)) privateAdds.add(event.file);
      recordNameHits(ctx, event.file, result, rangeScope(range, event.commit));
    } else {
      if (countLines) result.addedLines += 1;
      matchTerms(ctx, event.text, index => {
        addHit(result, `line\0${event.file}\0${index}\0${event.text}`, {
          file: ctx.safe(event.file), line: event.line, index, scope: rangeScope(range, event.commit),
        });
      });
    }
  };

  /* Commit by commit first, oldest first, so a hit names the commit that introduced it; then the net diff. */
  walkDiff(history, visitor(true));
  walkDiff(net, visitor(false));
  failOnPrivatePaths(ctx, [...privateAdds].sort(), 'path(s) under private/ are added by commits in the range');
}

/* ---------- run and report ---------- */

function runScan(options) {
  const root = path.resolve(options.root || path.join(__dirname, '..'));
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(root).isDirectory();
  } catch {
    isDirectory = false;
  }
  const termsFile = options.terms ? path.resolve(options.terms) : path.join(root, 'private', 'privacy-terms.txt');
  const matchers = loadTerms(termsFile);
  if (!isDirectory) throw new ScanError('--root is not a directory');

  const ctx = {
    root, matchers, safe: makeSafe(matchers), env: gitEnvironment(), realRoot: null, directoryChecks: new Map(),
  };
  const range = options.range === null ? null : validateRange(options.range);
  assertTopLevel(ctx);
  ctx.realRoot = fs.realpathSync(root);
  const files = listFiles(ctx);
  failOnPrivatePaths(ctx, files.tracked.filter(isPrivatePath), 'tracked file(s) under private/: git must never track private evidence');

  const result = newResult();
  scanWorkingTree(ctx, files.all, result);
  if (range !== null) scanRange(ctx, range, result);
  return result;
}

function formatHit(hit) {
  const base = `HIT ${hit.file}:${hit.line} term ${hit.index}`;
  if (hit.scope === null) return hit.line === 0 ? `${base} (path name)` : base;
  const by = hit.scope.commit ? ` by ${hit.scope.commit}` : '';
  const where = hit.line === 0 ? 'path name' : 'added';
  return `${base} (${where} in ${hit.scope.range}${by})`;
}

function listSkipped(io, title, entries) {
  if (entries.length === 0) return;
  io.out(`${title}: ${entries.length}`);
  for (const entry of entries.slice(0, MAX_LISTED_PATHS)) io.out(`  ${entry}`);
  if (entries.length > MAX_LISTED_PATHS) io.out(`  ... and ${entries.length - MAX_LISTED_PATHS} more`);
}

/** Prints the report and returns the exit code. */
function report(io, result) {
  for (const hit of result.hits.slice(0, MAX_PRINTED_HITS)) io.out(formatHit(hit));
  if (result.hits.length > MAX_PRINTED_HITS) io.out(`... ${result.hits.length - MAX_PRINTED_HITS} more hit(s) not shown`);

  listSkipped(io, 'skipped-binary (not scanned)', result.binary);
  listSkipped(io, `skipped-size (over ${MAX_FILE_BYTES / (1024 * 1024)} MB, not scanned)`, result.oversize);
  listSkipped(io, 'skipped-other (not scanned)', result.otherSkipped);
  if (result.rangeBinary > 0) io.out(`range: ${result.rangeBinary} binary file change(s) not scanned`);

  const hits = result.hits.length;
  io.out(
    `privacy-scan: ${hits === 0 ? 'clean' : 'BLOCKED'} - files scanned: ${result.filesScanned}, `
    + `binary skipped: ${result.binary.length}, size skipped: ${result.oversize.length}, `
    + `other skipped: ${result.otherSkipped.length}, added lines scanned: ${result.addedLines}, hits: ${hits}`,
  );
  return hits === 0 ? EXIT_CLEAN : EXIT_HITS;
}

function defaultIo() {
  return {
    out: line => process.stdout.write(`${line}\n`),
    err: line => process.stderr.write(`${line}\n`),
  };
}

/** Runs the scanner. Returns the exit code; the caller decides how to exit. */
function main(argv, io = defaultIo()) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      io.out(USAGE);
      return EXIT_CLEAN;
    }
    return report(io, runScan(options));
  } catch (error) {
    if (error instanceof ScanError) {
      io.err(`privacy-scan: ${error.message}`);
      for (const detail of error.details) io.err(`privacy-scan: ${detail}`);
    } else {
      /* error.message could quote a pattern or a path, so only the error class and code are shown. */
      io.err(`privacy-scan: unexpected ${error && error.name ? error.name : 'error'}${error && error.code ? ` (${error.code})` : ''}`);
    }
    return EXIT_ERROR;
  }
}

module.exports = { main, parseArgs, parseTerms, validateRange, decodeText, NO_TERMS_MESSAGE, EXIT_CLEAN, EXIT_HITS, EXIT_ERROR };

if (require.main === module) {
  /* A reader that closes the pipe early (for example `| head`) must not turn the exit code into a stack trace. */
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
  process.exitCode = main(process.argv.slice(2));
}
