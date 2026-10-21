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
 * Binary files cannot be scanned, so they are refused unless allowed. A tracked file, an untracked file that git does not
 * ignore, and (with --range) a file that any commit in the range adds or changes, is blocked when this scan sees its
 * content as binary and its exact repo path is not a line of scripts/binary-allowlist.txt. Content is binary when it has a
 * NUL byte in the first 8 KB, starts with %PDF-, PK\x03\x04 (zip, xlsx, docx) or \xD0\xCF\x11\xE0 (old Office), or is not
 * valid UTF-8 (a UTF-16 file with a byte order mark is text). A file over 5 MB is classed by its first 8 KB the same way;
 * any other file over 5 MB is reported as skipped-size.
 *
 * Allowlist file: one entry per line, "<exact repo path>" or "<exact repo path> sha256=<64 hex digits>"; blank lines and
 * lines starting with # are ignored. The path alone allows the path; a path ending in .png must also hold a real PNG
 * (signature check), and a sha256 pins the exact content. The checks run on the work tree file and on every blob that a
 * commit in the range adds or changes, so an allowed path cannot be reused for another kind of file. The work tree check
 * reads the allowlist from the work tree; the range check reads it from the head commit of the range, so a push can only
 * allow what it actually publishes.
 *
 * A file that .gitignore ignores must not be in git: a tracked ignored file (git ls-files -ci --exclude-standard) and,
 * with --range, any path a commit in the range adds or changes that git check-ignore --no-index matches, is blocked.
 *
 * The term list is <root>/private/privacy-terms.txt, or, when that is missing (a linked worktree), the one in the main
 * checkout: <directory of the git common dir>/private/privacy-terms.txt.
 *
 * Output: "HIT <file>:<line> term <index>" for each hit. The line number is 0 for a hit in a path name.
 * "BINARY <file> (<where>) <problem>" for each blocked binary file, "IGNORED <file> (<where>) ..." for each blocked path.
 * The matched text and the term are never printed, and any term match inside a printed path or git message
 * is replaced by [redacted]. The last line is a one line summary.
 *
 * Exit codes: 0 clean, 1 at least one hit or blocked file, 2 usage or configuration error (fail closed).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const EXIT_CLEAN = 0;
const EXIT_HITS = 1;
const EXIT_ERROR = 2;

const NO_TERMS_MESSAGE = 'no privacy term list: refusing to pass';
const BINARY_ALLOWLIST = 'scripts/binary-allowlist.txt';
const TERMS_FILE = path.join('private', 'privacy-terms.txt');
const NOT_ALLOWED = `is not on ${BINARY_ALLOWLIST}`;
const IGNORED_PROBLEM = 'is ignored by .gitignore, so it must not be in git';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/* Content that starts like a PDF, a zip container (xlsx, docx, pptx, zip) or an old Office file is binary whatever else it holds. */
const DOCUMENT_MAGIC = [Buffer.from('%PDF-'), Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0xd0, 0xcf, 0x11, 0xe0])];
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

function noTermList(files) {
  return new ScanError(NO_TERMS_MESSAGE, files.map(file => `looked for: ${file}`));
}

/**
 * Where a linked worktree finds the term list of the main checkout: <directory of the git common dir>/private/privacy-terms.txt.
 * Null when git cannot say (not a repository, git missing).
 */
function commonDirTermsFile(root) {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: root, env: gitEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? path.join(path.dirname(path.resolve(root, out)), TERMS_FILE) : null;
  } catch {
    return null;
  }
}

/** The files to try, in order: --terms alone, or <root>/private/privacy-terms.txt and then the main checkout's. */
function termsCandidates(options, root) {
  if (options.terms) return [path.resolve(options.terms)];
  const own = path.join(root, TERMS_FILE);
  const shared = commonDirTermsFile(root);
  return shared && shared !== own ? [own, shared] : [own];
}

/** Reads the first candidate that can be read; a candidate that is read but holds no term is a refusal, not a reason to try the next. */
function loadTerms(files) {
  let bytes = null;
  for (const file of files) {
    try {
      bytes = fs.readFileSync(file);
      break;
    } catch {
      bytes = null;
    }
  }
  if (bytes === null) throw noTermList(files);
  /* A UTF-16 file decodes as UTF-8 with NUL bytes between letters and would silently never match. */
  if (bytes.includes(0)) throw new ScanError('the term file must be UTF-8 text (it contains NUL bytes)');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ScanError('the term file must be valid UTF-8 text');
  }
  const matchers = parseTerms(text);
  if (matchers.length === 0) throw noTermList(files);
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

/**
 * Runs git with a fixed argument vector (never a shell string). Returns stdout as text, or as a Buffer with
 * options.buffer. options.input is written to standard input.
 */
function git(ctx, args, doing, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: ctx.root,
      env: ctx.env,
      encoding: options.buffer ? 'buffer' : 'utf8',
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      input: typeof options.input === 'string' ? Buffer.from(options.input, 'utf8') : options.input,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    let reason = String(error.code || 'failed');
    const stderr = error.stderr === undefined || error.stderr === null ? '' : String(error.stderr).trim();
    if (error.code === 'ENOBUFS') reason = 'output too large, narrow the range';
    else if (stderr) reason = stderr.split('\n')[0];
    throw new ScanError(`git failed while ${doing}: ${ctx.safe(reason)}`);
  }
}

/** Paths (from the list) that .gitignore ignores, judged by the rules alone: git check-ignore --no-index. */
function ignoredPaths(ctx, paths) {
  if (paths.length === 0) return new Set();
  const run = spawnSync('git', ['check-ignore', '--no-index', '--stdin', '-z'], {
    cwd: ctx.root, env: ctx.env, input: `${paths.join('\0')}\0`, encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  if (run.status === 1) return new Set();
  if (run.status !== 0) {
    const reason = String(run.stderr || run.error && run.error.code || 'failed').trim().split('\n')[0];
    throw new ScanError(`git failed while checking the changed paths against .gitignore: ${ctx.safe(reason)}`);
  }
  return new Set(splitNul(run.stdout));
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

/* ---------- binary allowlist ---------- */

/**
 * Parses the allowlist text into a Map from exact repo path to {sha256}: sha256 is a lower case hex string when the line
 * pins the content ("<path> sha256=<64 hex digits>"), otherwise null. Pure. Blank lines and lines starting with # are ignored.
 * A pattern, a path written with a leading "/" or "./", a malformed pin and a path listed twice are errors rather than
 * entries that silently never match.
 */
function parseAllowlist(text) {
  const allowed = new Map();
  text.split('\n').forEach((raw, position) => {
    const line = raw.replace(/\r$/, '').replace(/^\uFEFF/, '').trim();
    if (line === '' || line.startsWith('#')) return;
    const where = `${BINARY_ALLOWLIST} line ${position + 1}`;
    if (/^sha256=/i.test(line)) throw new ScanError(`${where}: put the exact repo path before sha256=`);
    let file = line;
    let sha256 = null;
    const pinned = /^(.*?)\s+sha256=(\S*)$/.exec(line);
    if (pinned) {
      if (!/^[0-9a-fA-F]{64}$/.test(pinned[2])) throw new ScanError(`${where}: sha256= needs 64 hexadecimal digits`);
      file = pinned[1].trim();
      sha256 = pinned[2].toLowerCase();
    }
    if (file === '' || /[*?]/.test(file) || file.startsWith('/') || file.startsWith('./') || file.includes('\\')) {
      throw new ScanError(`${where}: write one exact repo path (no wildcards, no leading / or ./)`);
    }
    if (allowed.has(file)) throw new ScanError(`${where}: the path is listed twice`);
    allowed.set(file, { sha256 });
  });
  return allowed;
}

/** True when the allowlist entry asks for more than the path: a .png must be a PNG, and a pin fixes the content. */
function needsContentCheck(file, entry) {
  return entry.sha256 !== null || /\.png$/i.test(file);
}

/** Why the bytes of an allowlisted path are not what its entry says, or null when they are. */
function allowlistContentProblem(file, entry, bytes) {
  if (/\.png$/i.test(file) && !(bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))) {
    return 'not a PNG file';
  }
  if (entry.sha256 !== null && crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    return 'sha256 differs from the pinned value';
  }
  return null;
}

function decodeAllowlist(bytes) {
  if (bytes.includes(0)) throw new ScanError(`${BINARY_ALLOWLIST} must be UTF-8 text (it contains NUL bytes)`);
  try {
    return parseAllowlist(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof ScanError) throw error;
    throw new ScanError(`${BINARY_ALLOWLIST} must be valid UTF-8 text`);
  }
}

/** The allowlist in the work tree. A missing file is an empty allowlist: every binary file is then blocked. */
function loadWorkTreeAllowlist(ctx) {
  const file = path.join(ctx.root, BINARY_ALLOWLIST);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return new Map();
  }
  if (!stat.isFile()) throw new ScanError(`${BINARY_ALLOWLIST} must be a regular file`);
  try {
    return decodeAllowlist(fs.readFileSync(file));
  } catch (error) {
    if (error instanceof ScanError) throw error;
    throw new ScanError(`${BINARY_ALLOWLIST} could not be read`);
  }
}

/**
 * The allowlist as the head commit of the range has it, so that a push can only allow what it publishes: an allowlist
 * edit that was never committed does not count. No such file at the head is an empty allowlist.
 */
function loadRangeAllowlist(ctx, range) {
  const head = range.split('..')[1];
  const commit = git(ctx, ['rev-parse', '--verify', '--quiet', `${head}^{commit}`], 'resolving the head of the range').trim();
  let text;
  try {
    text = git(ctx, ['cat-file', 'blob', `${commit}:${BINARY_ALLOWLIST}`], 'reading the binary allowlist at the head of the range');
  } catch {
    return new Map();
  }
  return decodeAllowlist(Buffer.from(text, 'utf8'));
}

/* ---------- results ---------- */

function newResult() {
  return {
    filesScanned: 0,
    binaryAllowed: [],
    binaryBlocked: new Map(),
    ignoredBlocked: new Map(),
    oversize: [],
    otherSkipped: [],
    addedLines: 0,
    rangeBinaryAllowed: 0,
    hits: [],
    seen: new Set(),
  };
}

/**
 * Records a path that must not be committed in `bucket` (result.binaryBlocked or result.ignoredBlocked). `kind` is 'tree' or
 * 'range'; the first place of each kind is kept, and every distinct problem is kept.
 */
function blockPath(ctx, bucket, rel, kind, where, problem) {
  const key = ctx.safe(rel);
  const entry = bucket.get(key) || { tree: null, range: null, problems: new Set() };
  if (entry[kind] === null) entry[kind] = where;
  entry.problems.add(problem);
  bucket.set(key, entry);
}

function addHit(result, key, hit) {
  if (result.seen.has(key)) return;
  result.seen.add(key);
  result.hits.push(hit);
}

/* ---------- reading one file ---------- */

/**
 * Decodes file bytes to text, or returns null for binary content. Binary is: a NUL byte in the first 8 KB (except in UTF-16
 * with a byte order mark, which is text), a document signature at the start (PDF, zip container, old Office), or bytes that
 * are not valid UTF-8. With options.partial the bytes are the start of a longer file, so a character cut off at the end is fine.
 */
function decodeText(buffer, options = {}) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    if (buffer[2] === 0 && buffer[3] === 0) return null; /* UTF-32 */
    return buffer.toString('utf16le', 2);
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const body = Buffer.from(buffer.subarray(2, 2 + ((buffer.length - 2) & ~1)));
    return body.swap16().toString('utf16le');
  }
  if (buffer.subarray(0, BINARY_PROBE_BYTES).includes(0)) return null;
  if (DOCUMENT_MAGIC.some(magic => buffer.length >= magic.length && buffer.subarray(0, magic.length).equals(magic))) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer, { stream: options.partial === true }).replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

/** A file over the size limit is still a binary file when its first 8 KB say so; otherwise it is reported as oversize. */
function classifyOversize(head, bytes) {
  return decodeText(head, { partial: true }) === null ? { kind: 'binary' } : { kind: 'oversize', bytes };
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
    if (opened.size > MAX_FILE_BYTES) {
      const head = Buffer.alloc(BINARY_PROBE_BYTES);
      return classifyOversize(head.subarray(0, fs.readSync(fd, head, 0, BINARY_PROBE_BYTES, 0)), opened.size);
    }
    const buffer = fs.readFileSync(fd);
    if (buffer.length > MAX_FILE_BYTES) return classifyOversize(buffer.subarray(0, BINARY_PROBE_BYTES), buffer.length);
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

/**
 * Why the work tree file at an allowlisted path is not what its entry says (not a PNG, wrong sha256, a symlink), or null.
 * Only called for an entry that asks for a content check.
 */
function workTreeContentProblem(ctx, rel, entry) {
  const absolute = path.join(ctx.root, rel);
  let fd;
  try {
    if (fs.lstatSync(absolute).isSymbolicLink()) return 'is a symbolic link';
    fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch {
    return 'could not be read';
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return 'is not a regular file';
    return allowlistContentProblem(rel, entry, fs.readFileSync(fd));
  } catch {
    return 'could not be read';
  } finally {
    fs.closeSync(fd);
  }
}

function scanWorkingTree(ctx, files, result) {
  for (const rel of files) {
    recordNameHits(ctx, rel, result, null);
    if (leavesRoot(ctx, rel)) {
      result.otherSkipped.push(`${ctx.safe(rel)} (path crosses a symlink out of the repository)`);
      continue;
    }
    const content = readForScan(path.join(ctx.root, rel));
    const where = ctx.tracked.has(rel) ? 'tracked' : 'untracked, not ignored';
    const entry = ctx.allowlist.get(rel);
    /* An allowlisted path must still hold what its entry says, whatever kind of file it is now. */
    const problem = entry !== undefined && content.kind !== 'skipped' && needsContentCheck(rel, entry)
      ? workTreeContentProblem(ctx, rel, entry) : null;
    if (problem !== null) blockPath(ctx, result.binaryBlocked, rel, 'tree', where, `fails its ${BINARY_ALLOWLIST} entry: ${problem}`);
    if (content.kind === 'text') {
      result.filesScanned += 1;
      scanText(ctx, rel, content.text, result);
    } else if (content.kind === 'binary') {
      if (entry === undefined) blockPath(ctx, result.binaryBlocked, rel, 'tree', where, NOT_ALLOWED);
      else if (problem === null) result.binaryAllowed.push(ctx.safe(rel));
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
 *   {type:'added', commit, file, line, text}   one added line (line is the line number in the new file).
 * A binary change has no lines to visit; scanRangeFiles finds those.
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
    }
  }
}

/**
 * Walks `git log --raw -z --no-abbrev --no-renames --format=%x01%H` or `git diff --raw -z --no-abbrev --no-renames` output
 * and calls visit({commit, file, mode, oid}) for each changed file: mode and oid are those of the new side. The output is
 * NUL separated, so a path may hold any character. The commit is null for a plain diff.
 */
function walkRaw(output, visit) {
  let commit = null;
  const tokens = output.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i].startsWith('\n') ? tokens[i].slice(1) : tokens[i];
    if (token.charCodeAt(0) === 1) {
      commit = token.slice(1);
      continue;
    }
    const header = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) [A-Z]\d*$/.exec(token);
    if (!header) continue;
    i += 1;
    if (i < tokens.length && tokens[i] !== '') visit({ commit, file: tokens[i], mode: header[2], oid: header[4] });
  }
}

/** The contents of the given blobs as a Map from object id to Buffer. Uses object ids, so no path can break the protocol. */
function readBlobs(ctx, oids) {
  const blobs = new Map();
  if (oids.length === 0) return blobs;
  const checked = git(ctx, ['cat-file', '--batch-check'], 'checking the sizes of the changed files', { input: `${oids.join('\n')}\n` });
  const small = [];
  const large = [];
  for (const line of checked.split('\n')) {
    if (line === '') continue;
    const match = /^([0-9a-f]+) (\w+) (\d+)$/.exec(line);
    if (!match) throw new ScanError('a changed file in the range could not be read from the repository');
    if (match[2] !== 'blob') continue;
    (Number(match[3]) > MAX_FILE_BYTES ? large : small).push(match[1]);
  }
  if (small.length > 0) {
    const out = git(ctx, ['cat-file', '--batch'], 'reading the changed files', { input: `${small.join('\n')}\n`, buffer: true });
    let offset = 0;
    while (offset < out.length) {
      const eol = out.indexOf(10, offset);
      const header = /^([0-9a-f]+) (\w+) (\d+)$/.exec(out.toString('latin1', offset, eol));
      if (eol < 0 || !header) throw new ScanError('a changed file in the range could not be read from the repository');
      const start = eol + 1;
      blobs.set(header[1], out.subarray(start, start + Number(header[3])));
      offset = start + Number(header[3]) + 1;
    }
  }
  for (const oid of large) blobs.set(oid, git(ctx, ['cat-file', 'blob', oid], 'reading a large changed file', { buffer: true }));
  return blobs;
}

/** 'binary', 'oversize' or 'text', by the same rules as a work tree file. */
function blobKind(buffer) {
  if (buffer.length > MAX_FILE_BYTES) return classifyOversize(buffer.subarray(0, BINARY_PROBE_BYTES), buffer.length).kind;
  return decodeText(buffer) === null ? 'binary' : 'text';
}

/**
 * Every file that a commit in the range adds or changes (each commit on its own, then the net diff, because a file that was
 * added and deleted again inside the range was still published) must
 *   - not be ignored by .gitignore (git check-ignore --no-index),
 *   - if its content is binary, be on the allowlist as the head commit has it, and
 *   - if it is on the allowlist with a content check (a .png, or a sha256 pin), pass that check in this very commit.
 */
function scanRangeFiles(ctx, range, result) {
  const allowlist = loadRangeAllowlist(ctx, range);
  const options = ['--raw', '-z', '--no-abbrev', '--no-renames', '--no-ext-diff', '--no-textconv', '--diff-filter=d'];
  const history = git(ctx, ['log', '--reverse', '-m', '--format=%x01%H', ...options, range, '--'], 'listing the changed files in the range');
  const net = git(ctx, ['diff', ...options, range, '--'], 'listing the changed files in the diff of the range');
  const entries = [];
  const collect = event => {
    if (event.mode !== '160000') entries.push(event); /* a submodule pointer is a commit id, not a file */
  };
  walkRaw(history, collect);
  walkRaw(net, collect);

  const ignored = ignoredPaths(ctx, [...new Set(entries.map(entry => entry.file))]);
  const blobs = readBlobs(ctx, [...new Set(entries.map(entry => entry.oid))]);
  const kinds = new Map();
  for (const entry of entries) {
    const where = `added or changed in ${range}${entry.commit ? ` by ${entry.commit.slice(0, 12)}` : ''}`;
    if (ignored.has(entry.file)) blockPath(ctx, result.ignoredBlocked, entry.file, 'range', where, IGNORED_PROBLEM);
    const buffer = blobs.get(entry.oid);
    if (buffer === undefined) continue; /* not a blob */
    if (!kinds.has(entry.oid)) kinds.set(entry.oid, blobKind(buffer));
    const binary = kinds.get(entry.oid) === 'binary';
    const allowed = allowlist.get(entry.file);
    if (allowed === undefined) {
      if (binary) blockPath(ctx, result.binaryBlocked, entry.file, 'range', where, NOT_ALLOWED);
      continue;
    }
    const problem = needsContentCheck(entry.file, allowed) ? allowlistContentProblem(entry.file, allowed, buffer) : null;
    if (problem !== null) blockPath(ctx, result.binaryBlocked, entry.file, 'range', where, `fails its ${BINARY_ALLOWLIST} entry: ${problem}`);
    else if (binary && entry.commit !== null) result.rangeBinaryAllowed += 1;
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
    if (event.type === 'file') {
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
  scanRangeFiles(ctx, range, result);
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
  const matchers = loadTerms(termsCandidates(options, root));
  if (!isDirectory) throw new ScanError('--root is not a directory');

  const ctx = {
    root, matchers, safe: makeSafe(matchers), env: gitEnvironment(), realRoot: null, directoryChecks: new Map(),
    tracked: new Set(), allowlist: new Map(),
  };
  const range = options.range === null ? null : validateRange(options.range);
  assertTopLevel(ctx);
  ctx.realRoot = fs.realpathSync(root);
  const files = listFiles(ctx);
  ctx.tracked = new Set(files.tracked);
  ctx.allowlist = loadWorkTreeAllowlist(ctx);
  failOnPrivatePaths(ctx, files.tracked.filter(isPrivatePath), 'tracked file(s) under private/: git must never track private evidence');

  const result = newResult();
  scanWorkingTree(ctx, files.all, result);
  const ignoredTracked = splitNul(git(ctx, ['ls-files', '-z', '--cached', '--ignored', '--exclude-standard'], 'listing tracked files that .gitignore ignores'));
  for (const rel of ignoredTracked) blockPath(ctx, result.ignoredBlocked, rel, 'tree', 'tracked', IGNORED_PROBLEM);
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

function sortedEntries(map) {
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Prints one family of blocked paths: a line per path (capped), then the lines that say what to do. */
function reportBlocked(io, label, noun, map, advice) {
  const blocked = sortedEntries(map);
  if (blocked.length === 0) return;
  for (const [file, entry] of blocked.slice(0, MAX_PRINTED_HITS)) {
    const where = [entry.tree, entry.range].filter(Boolean).join('; ');
    io.out(`${label} ${file} (${where}) ${[...entry.problems].join('; ')}`);
  }
  if (blocked.length > MAX_PRINTED_HITS) io.out(`... ${blocked.length - MAX_PRINTED_HITS} more blocked ${noun} not shown`);
  for (const line of advice(blocked.length)) io.out(line);
}

/** Prints the report and returns the exit code. */
function report(io, result) {
  for (const hit of result.hits.slice(0, MAX_PRINTED_HITS)) io.out(formatHit(hit));
  if (result.hits.length > MAX_PRINTED_HITS) io.out(`... ${result.hits.length - MAX_PRINTED_HITS} more hit(s) not shown`);
  reportBlocked(io, 'BINARY', 'binary file(s)', result.binaryBlocked, count => [
    `binary: ${count} binary file(s) are blocked. A binary file cannot be scanned for private terms, `
    + 'and task packages (xlsx, docx, pdf, zip) and the app\'s exports must never be committed.',
    `binary: to allow one deliberately, add its exact repo path on a line of its own in ${BINARY_ALLOWLIST} `
    + '(a line starting with # is a comment; follow the path with sha256=<64 hex digits> to pin its content; '
    + 'a .png path must really hold a PNG) and commit that change with the file. Otherwise delete it or add it to .gitignore.',
  ]);
  reportBlocked(io, 'IGNORED', 'ignored path(s)', result.ignoredBlocked, count => [
    `ignored: ${count} path(s) are ignored by .gitignore, which marks private downloads, task documents and local files that must `
    + 'never be committed.',
    'ignored: take each out of git with git rm --cached <path> (keep it outside the repository); only if it really belongs in '
    + 'git, add a !<path> exception to .gitignore in the same change.',
  ]);

  listSkipped(io, `allowed-binary (on ${BINARY_ALLOWLIST}, content not scanned)`, result.binaryAllowed);
  listSkipped(io, `skipped-size (over ${MAX_FILE_BYTES / (1024 * 1024)} MB, not scanned)`, result.oversize);
  listSkipped(io, 'skipped-other (not scanned)', result.otherSkipped);
  if (result.rangeBinaryAllowed > 0) io.out(`range: ${result.rangeBinaryAllowed} allowed binary file change(s) not scanned`);

  const hits = result.hits.length;
  const blocked = result.binaryBlocked.size + result.ignoredBlocked.size;
  io.out(
    `privacy-scan: ${hits === 0 && blocked === 0 ? 'clean' : 'BLOCKED'} - files scanned: ${result.filesScanned}, `
    + `binary allowed: ${result.binaryAllowed.length}, binary blocked: ${result.binaryBlocked.size}, `
    + `ignored blocked: ${result.ignoredBlocked.size}, size skipped: ${result.oversize.length}, `
    + `other skipped: ${result.otherSkipped.length}, added lines scanned: ${result.addedLines}, hits: ${hits}`,
  );
  return hits === 0 && blocked === 0 ? EXIT_CLEAN : EXIT_HITS;
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

module.exports = {
  main, parseArgs, parseTerms, parseAllowlist, validateRange, decodeText, NO_TERMS_MESSAGE, BINARY_ALLOWLIST, EXIT_CLEAN, EXIT_HITS, EXIT_ERROR,
};

if (require.main === module) {
  /* A reader that closes the pipe early (for example `| head`) must not turn the exit code into a stack trace. */
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
  process.exitCode = main(process.argv.slice(2));
}
