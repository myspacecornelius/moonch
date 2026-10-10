'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const scanner = require('../scripts/privacy-scan.cjs');

/*
 * Every fixture here is synthetic: invented terms and throwaway git repositories under os.tmpdir().
 * The tests always pass their own term file with --terms and never read the real private/ folder.
 * Git runs with an empty global configuration (GIT_CONFIG_GLOBAL), and user.name / user.email are set
 * locally in each throwaway repository, so no global configuration is touched or needed.
 */

const SCRIPT = path.join(__dirname, '..', 'scripts', 'privacy-scan.cjs');
const NO_TERMS = 'no privacy term list: refusing to pass';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-scan-test-'));
const homeDir = path.join(scratch, 'home');
fs.mkdirSync(homeDir);
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function freshDir(label) {
  counter += 1;
  const dir = path.join(scratch, `${label}-${counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function hermeticEnv(extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: homeDir,
    XDG_CONFIG_HOME: homeDir,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, env: hermeticEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function createRepo() {
  const dir = freshDir('repo');
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'Test Writer']);
  git(dir, ['config', 'user.email', 'writer@example.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['config', 'core.hooksPath', path.join(scratch, 'no-hooks')]);
  return dir;
}

function put(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function commitAll(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

function writeTerms(content) {
  const file = path.join(freshDir('terms'), 'terms.txt');
  fs.writeFileSync(file, content);
  return file;
}

function scan(root, args = [], env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8', env: hermeticEnv(env) });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, all: result.stdout + result.stderr };
}

function count(output, label) {
  const match = new RegExp(`${label}: (\\d+)`).exec(output);
  assert.ok(match, `summary has "${label}"`);
  return Number(match[1]);
}

/* Synthetic terms. The first is a literal; the second is a case-insensitive regular expression. */
const TERMS = '# synthetic list\n\nzebra-quartz\n/acct-\\d{4}/i\n';
const SECRET = 'zebra-quartz';
const SECRET_REGEX_TEXT = 'ACCT-4417';

function cleanRepo() {
  const dir = createRepo();
  put(dir, 'readme.txt', 'Atlas Foods quarterly notes.\nNothing to see here.\n');
  put(dir, 'src/model.txt', 'Meridian Retail margin 31.5 percent.\n');
  commitAll(dir, 'initial');
  return dir;
}

/* ---------- the documented cases ---------- */

test('a clean repository passes with exit 0 and a one line summary', () => {
  const dir = cleanRepo();
  const run = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(run.status, 0, run.all);
  assert.equal(count(run.stdout, 'files scanned'), 2);
  assert.equal(count(run.stdout, 'binary skipped'), 0);
  assert.equal(count(run.stdout, 'hits'), 0);
  const summary = run.stdout.trim().split('\n').filter(line => line.startsWith('privacy-scan:'));
  assert.equal(summary.length, 1);
  assert.doesNotMatch(run.stdout, /HIT /);
});

test('a tracked file containing a term fails with exit 1, file:line and the term index', () => {
  const dir = cleanRepo();
  put(dir, 'notes.txt', `first line\nthe ${SECRET} figure\n`);
  commitAll(dir, 'add notes');
  const run = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(run.status, 1, run.all);
  assert.match(run.stdout, /^HIT notes\.txt:2 term 3$/m);
  assert.equal(count(run.stdout, 'hits'), 1);
});

test('an untracked file that git does not ignore is scanned and fails', () => {
  const dir = cleanRepo();
  put(dir, 'draft.txt', `draft mentions ${SECRET}\n`);
  const run = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(run.status, 1, run.all);
  assert.match(run.stdout, /^HIT draft\.txt:1 term 3$/m);
});

test('an ignored untracked file containing a term passes', () => {
  const dir = createRepo();
  put(dir, '.gitignore', 'local-only/\n');
  put(dir, 'readme.txt', 'Atlas Foods.\n');
  commitAll(dir, 'initial');
  put(dir, 'local-only/evidence.txt', `${SECRET}\n${SECRET_REGEX_TEXT}\n`);
  const run = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(run.status, 0, run.all);
  assert.equal(count(run.stdout, 'files scanned'), 2, 'only .gitignore and readme.txt');
});

test('the default term file is <root>/private/privacy-terms.txt and private/ stays out of the scan', () => {
  const dir = createRepo();
  put(dir, '.gitignore', '/private/\n');
  put(dir, 'readme.txt', 'Atlas Foods.\n');
  commitAll(dir, 'initial');
  put(dir, 'private/privacy-terms.txt', `${SECRET}\n`);
  put(dir, 'notes.txt', `mentions ${SECRET}\n`);
  const run = scan(dir);
  assert.equal(run.status, 1, run.all);
  assert.match(run.stdout, /^HIT notes\.txt:1 term 1$/m);
  assert.doesNotMatch(run.stdout, /private/);
});

/* ---------- term syntax ---------- */

test('literals are case insensitive and regexes honour their own flags', () => {
  const dir = cleanRepo();
  put(dir, 'literal.txt', 'a ZeBrA-QuArTz appears\n');
  put(dir, 'upper.txt', 'reference ACCT-1234 here\n');
  put(dir, 'lower.txt', 'reference acct-1234 here\n');
  put(dir, 'short.txt', 'reference ACCT-12 here\n');
  commitAll(dir, 'files');
  const run = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(run.status, 1, run.all);
  assert.match(run.stdout, /^HIT literal\.txt:1 term 3$/m);
  assert.match(run.stdout, /^HIT upper\.txt:1 term 4$/m);
  assert.match(run.stdout, /^HIT lower\.txt:1 term 4$/m, 'the /i flag makes the regex case insensitive');
  assert.doesNotMatch(run.stdout, /short\.txt/, 'the regex needs four digits');

  const strict = writeTerms('/ACCT-\\d{4}/\n');
  const strictRun = scan(dir, ['--terms', strict]);
  assert.match(strictRun.stdout, /^HIT upper\.txt:1 term 1$/m);
  assert.doesNotMatch(strictRun.stdout, /lower\.txt/, 'without /i the regex is case sensitive');
});

test('regex metacharacters in a literal term are matched literally', () => {
  const dir = cleanRepo();
  put(dir, 'plain.txt', 'aXb(c is not it\n');
  put(dir, 'exact.txt', 'but a.b(c is\n');
  commitAll(dir, 'files');
  const run = scan(dir, ['--terms', writeTerms('a.b(c\n')]);
  assert.equal(run.status, 1, run.all);
  assert.match(run.stdout, /^HIT exact\.txt:1 term 1$/m);
  assert.doesNotMatch(run.stdout, /plain\.txt/);
});

test('a path-like literal such as /usr/lib is not mistaken for a regular expression', () => {
  const dir = cleanRepo();
  put(dir, 'paths.txt', 'see /usr/lib/thing\n');
  commitAll(dir, 'paths');
  const run = scan(dir, ['--terms', writeTerms('/usr/lib\n')]);
  assert.equal(run.status, 1, run.all);
  assert.match(run.stdout, /^HIT paths\.txt:1 term 1$/m);
});

test('the term index is the line number in the term file, counting comments and blanks', () => {
  const dir = cleanRepo();
  put(dir, 'a.txt', 'quokka-sapphire\n');
  commitAll(dir, 'a');
  const terms = writeTerms('# comment\n\n   \n# another\nquokka-sapphire\n');
  const run = scan(dir, ['--terms', terms]);
  assert.match(run.stdout, /^HIT a\.txt:1 term 5$/m);
});

test('a term file with a byte order mark and CRLF line endings works', () => {
  const dir = cleanRepo();
  put(dir, 'a.txt', 'one\nquokka-sapphire\n');
  commitAll(dir, 'a');
  const terms = writeTerms('﻿quokka-sapphire\r\n# note\r\n');
  const run = scan(dir, ['--terms', terms]);
  assert.equal(run.status, 1, run.all);
  assert.match(run.stdout, /^HIT a\.txt:2 term 1$/m);
});

test('one line matching two terms reports both indexes', () => {
  const dir = cleanRepo();
  put(dir, 'both.txt', `${SECRET} and ${SECRET_REGEX_TEXT}\n`);
  commitAll(dir, 'both');
  const run = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.match(run.stdout, /^HIT both\.txt:1 term 3$/m);
  assert.match(run.stdout, /^HIT both\.txt:1 term 4$/m);
  assert.equal(count(run.stdout, 'hits'), 2);
});

/* ---------- fail closed ---------- */

test('an invalid regular expression is an error (exit 2), never skipped, and is not echoed', () => {
  const dir = cleanRepo();
  put(dir, 'a.txt', 'unclosed group (\n');
  commitAll(dir, 'a');
  const run = scan(dir, ['--terms', writeTerms('fine-term\n/(unclosed-group/i\n')]);
  assert.equal(run.status, 2, run.all);
  assert.match(run.stderr, /term file line 2: invalid regular expression/);
  assert.doesNotMatch(run.all, /unclosed-group/);
  assert.doesNotMatch(run.stdout, /HIT/);
});

test('invalid regex flags and a term that matches the empty string are errors', () => {
  const dir = cleanRepo();
  const duplicated = scan(dir, ['--terms', writeTerms('/abc/ii\n')]);
  assert.equal(duplicated.status, 2, duplicated.all);
  assert.match(duplicated.stderr, /line 1: invalid regular expression/);
  const empty = scan(dir, ['--terms', writeTerms('/x*/i\n')]);
  assert.equal(empty.status, 2, empty.all);
  assert.match(empty.stderr, /line 1: the term matches the empty string/);
});

test('a missing, empty or comment-only term file exits 2 with the refusal message', () => {
  const dir = cleanRepo();
  const missing = scan(dir, ['--terms', path.join(scratch, 'does-not-exist.txt')]);
  assert.equal(missing.status, 2, missing.all);
  assert.ok(missing.stderr.includes(NO_TERMS), missing.stderr);

  const empty = scan(dir, ['--terms', writeTerms('')]);
  assert.equal(empty.status, 2, empty.all);
  assert.ok(empty.stderr.includes(NO_TERMS));

  const commentsOnly = scan(dir, ['--terms', writeTerms('# nothing here\n\n   \n# still nothing\n')]);
  assert.equal(commentsOnly.status, 2, commentsOnly.all);
  assert.ok(commentsOnly.stderr.includes(NO_TERMS));

  const directory = scan(dir, ['--terms', freshDir('not-a-file')]);
  assert.equal(directory.status, 2, directory.all);
  assert.ok(directory.stderr.includes(NO_TERMS));
});

test('with no --terms and no private/privacy-terms.txt the scan refuses to pass', () => {
  const dir = cleanRepo();
  const run = scan(dir);
  assert.equal(run.status, 2, run.all);
  assert.ok(run.stderr.includes(NO_TERMS));
  assert.doesNotMatch(run.stdout, /clean/);
});

test('a term file that is not UTF-8 text (for example UTF-16) is an error, not a silent no-op', () => {
  const dir = cleanRepo();
  const file = path.join(freshDir('terms'), 'utf16.txt');
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('zebra-quartz\n', 'utf16le')]));
  const run = scan(dir, ['--terms', file]);
  assert.equal(run.status, 2, run.all);
  assert.match(run.stderr, /UTF-8/);
});

test('usage errors exit 2 and --help exits 0', () => {
  const dir = cleanRepo();
  const terms = writeTerms(TERMS);
  for (const args of [
    ['--bogus'],
    ['stray-positional'],
    ['--terms'],
    ['--terms', '--range', 'a..b'],
    ['--terms', terms, '--terms', terms],
    ['--range', 'HEAD'],
    ['--range', '-x..HEAD'],
    ['--range', 'a...b'],
    ['--range', 'a..b..c'],
    ['--range', '..HEAD'],
  ]) {
    const run = scan(dir, args);
    assert.equal(run.status, 2, `${args.join(' ')}: ${run.all}`);
    assert.doesNotMatch(run.stdout, /clean/);
  }
  const help = scan(dir, ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage: node scripts\/privacy-scan\.cjs/);
});

test('the --flag=value form is accepted', () => {
  const dir = cleanRepo();
  put(dir, 'a.txt', `${SECRET}\n`);
  const run = spawnSync(process.execPath, [SCRIPT, `--root=${dir}`, `--terms=${writeTerms(TERMS)}`], { encoding: 'utf8', env: hermeticEnv() });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /^HIT a\.txt:1 term 3$/m);
});

test('a root that is not the top level of a git work tree is an error', () => {
  const terms = writeTerms(TERMS);
  const plain = scan(freshDir('plain'), ['--terms', terms]);
  assert.equal(plain.status, 2, plain.all);

  const dir = cleanRepo();
  const subdirectory = scan(path.join(dir, 'src'), ['--terms', terms]);
  assert.equal(subdirectory.status, 2, subdirectory.all);
  assert.match(subdirectory.stderr, /top level of a git work tree/);

  const missing = scan(path.join(scratch, 'no-such-root'), ['--terms', terms]);
  assert.equal(missing.status, 2, missing.all);
});

test('tracked files under private/ are an error', () => {
  const dir = cleanRepo();
  put(dir, 'private/evidence.txt', 'nothing sensitive here\n');
  git(dir, ['add', '-f', 'private/evidence.txt']);
  commitAll(dir, 'oops');
  const run = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(run.status, 2, run.all);
  assert.match(run.stderr, /tracked file\(s\) under private\//);
  assert.match(run.stderr, /private\/evidence\.txt/);
});

test('GIT_DIR and GIT_WORK_TREE from the environment do not redirect the scan', () => {
  const other = createRepo();
  put(other, 'leak.txt', `${SECRET}\n`);
  commitAll(other, 'other');
  const dir = cleanRepo();
  const run = scan(dir, ['--terms', writeTerms(TERMS)], { GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other });
  assert.equal(run.status, 0, run.all);
  assert.equal(count(run.stdout, 'files scanned'), 2);
});

/* ---------- file kinds ---------- */

test('a binary file is skipped, its path is listed, and its content is not scanned', () => {
  const dir = cleanRepo();
  put(dir, 'assets/blob.bin', Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`${SECRET} ${SECRET_REGEX_TEXT}`)]));
  commitAll(dir, 'binary');
  const run = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(run.status, 0, run.all);
  assert.equal(count(run.stdout, 'binary skipped'), 1);
  assert.match(run.stdout, /^skipped-binary \(not scanned\): 1\n {2}assets\/blob\.bin$/m);
});

test('only the first 8 KB decide whether a file is binary', () => {
  const dir = cleanRepo();
  put(dir, 'late-nul.txt', Buffer.concat([Buffer.from(`${SECRET}\n`), Buffer.alloc(9000, 0x61), Buffer.from([0])]));
  commitAll(dir, 'late nul');
  const run = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(run.status, 1, run.all);
  assert.match(run.stdout, /^HIT late-nul\.txt:1 term 3$/m);
  assert.equal(count(run.stdout, 'binary skipped'), 0);
});

test('UTF-16 text with a byte order mark is scanned as text, not skipped as binary', () => {
  const dir = cleanRepo();
  const line = `notes ${SECRET}\n`;
  put(dir, 'le.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`first\n${line}`, 'utf16le')]));
  put(dir, 'be.txt', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(`first\n${line}`, 'utf16le').swap16()]));
  commitAll(dir, 'utf16');
  const run = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(run.status, 1, run.all);
  assert.match(run.stdout, /^HIT le\.txt:2 term 3$/m);
  assert.match(run.stdout, /^HIT be\.txt:2 term 3$/m);
  assert.equal(count(run.stdout, 'binary skipped'), 0);
});

test('files over 5 MB are skipped and reported, and a file of exactly 5 MB is scanned', () => {
  const dir = cleanRepo();
  const header = Buffer.from(`${SECRET}\n`);
  const limit = 5 * 1024 * 1024;
  put(dir, 'big.txt', Buffer.concat([header, Buffer.alloc(limit, 0x61)]));
  commitAll(dir, 'big');
  const skipped = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(skipped.status, 0, skipped.all);
  assert.equal(count(skipped.stdout, 'size skipped'), 1);
  assert.match(skipped.stdout, /^skipped-size \(over 5 MB, not scanned\): 1\n {2}big\.txt \(\d+ bytes\)$/m);

  put(dir, 'big.txt', Buffer.concat([header, Buffer.alloc(limit - header.length, 0x61)]));
  const scanned = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(scanned.status, 1, scanned.all);
  assert.match(scanned.stdout, /^HIT big\.txt:1 term 3$/m);
  assert.equal(count(scanned.stdout, 'size skipped'), 0);
});

test('symlinks are never followed; a link is scanned as its own target text only', { skip: process.platform === 'win32' }, () => {
  const outside = path.join(freshDir('outside'), 'outside.txt');
  fs.writeFileSync(outside, `${SECRET} lives out here\n`);
  const dir = cleanRepo();
  fs.symlinkSync(outside, path.join(dir, 'link-to-outside.txt'));
  commitAll(dir, 'link');
  const followed = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(followed.status, 0, `the target file's content must not be read: ${followed.all}`);

  fs.symlinkSync(`target-${SECRET}`, path.join(dir, 'named.txt'));
  const named = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(named.status, 1, named.all);
  assert.match(named.stdout, /^HIT named\.txt:1 term 3$/m);
  assert.doesNotMatch(named.stdout, /link-to-outside/);
});

test('a tracked directory swapped for a symlink out of the repository is not read through', { skip: process.platform === 'win32' }, () => {
  const dir = cleanRepo();
  put(dir, 'sub/inner.txt', 'harmless\n');
  commitAll(dir, 'sub');
  const outsideDir = freshDir('outside-dir');
  fs.writeFileSync(path.join(outsideDir, 'inner.txt'), `${SECRET}\n`);
  fs.rmSync(path.join(dir, 'sub'), { recursive: true });
  fs.symlinkSync(outsideDir, path.join(dir, 'sub'));
  const run = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(run.status, 0, `content behind the link must not be read: ${run.all}`);
  assert.match(run.stdout, /sub\/inner\.txt \(path crosses a symlink out of the repository\)/);
});

test('a reader that closes the pipe early does not change the exit code or print a stack trace', async () => {
  const dir = cleanRepo();
  put(dir, 'notes.txt', `${SECRET}\n`);
  const terms = writeTerms(TERMS);
  const child = require('node:child_process').spawn(process.execPath, [SCRIPT, '--root', dir, '--terms', terms], {
    env: hermeticEnv(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.destroy();
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const status = await new Promise(resolve => child.on('close', resolve));
  assert.equal(status, 1, stderr);
  assert.doesNotMatch(stderr, /EPIPE|Unhandled|at .*\.cjs/);
});

/* ---------- output never carries the term ---------- */

test('a term inside a file name is a hit on the path and the printed path is redacted', () => {
  const dir = cleanRepo();
  put(dir, `${SECRET}-model.txt`, 'harmless content\n');
  put(dir, `docs/${SECRET_REGEX_TEXT.toLowerCase()}/inner.txt`, `${SECRET} inside\n`);
  commitAll(dir, 'named');
  const run = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(run.status, 1, run.all);
  assert.match(run.stdout, /^HIT \[redacted\]-model\.txt:0 term 3 \(path name\)$/m);
  assert.match(run.stdout, /^HIT docs\/\[redacted\]\/inner\.txt:0 term 4 \(path name\)$/m);
  assert.match(run.stdout, /^HIT docs\/\[redacted\]\/inner\.txt:1 term 3$/m);
});

test('output never contains the matched text or the term, in any scenario', () => {
  const dir = cleanRepo();
  const base = git(dir, ['rev-parse', 'HEAD']);
  put(dir, 'content.txt', `value ${SECRET} and ${SECRET_REGEX_TEXT}\n`);
  put(dir, `${SECRET}.txt`, 'name hit\n');
  put(dir, 'binary.bin', Buffer.from([0, 0, 0]));
  put(dir, `${SECRET_REGEX_TEXT}.bin`, Buffer.from([0, 0, 0]));
  commitAll(dir, 'content');
  const terms = writeTerms(TERMS);
  const outputs = [
    scan(dir, ['--terms', terms]),
    scan(dir, ['--terms', terms, '--range', `${base}..HEAD`]),
    scan(dir, ['--terms', terms, '--range', `${base}..no-such-ref`]),
    scan(dir, ['--terms', writeTerms('/(broken-zebra-quartz/\n')]),
  ];
  for (const run of outputs) {
    const lower = run.all.toLowerCase();
    assert.ok(!lower.includes(SECRET), run.all);
    assert.ok(!lower.includes(SECRET_REGEX_TEXT.toLowerCase()), run.all);
  }
  assert.equal(outputs[0].status, 1);
  assert.equal(outputs[1].status, 1);
  assert.equal(outputs[2].status, 2);
  assert.equal(outputs[3].status, 2);
});

test('a hostile file name cannot forge extra output lines', { skip: process.platform === 'win32' }, () => {
  const dir = cleanRepo();
  put(dir, 'x\nHIT forged.txt:1 term 9', `${SECRET}\n`);
  const run = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(run.status, 1, run.all);
  const lines = run.stdout.split('\n');
  assert.ok(!lines.some(line => line.startsWith('HIT forged')), run.stdout);
  assert.ok(lines.some(line => line.startsWith('HIT x?HIT forged.txt:1 term 9:1 term 3')), run.stdout);
});

/* ---------- --range: added lines of the commits to be pushed ---------- */

function shortOf(sha) {
  return sha.slice(0, 12);
}

test('a term removed and then added again inside the range fails as an added line', () => {
  const dir = createRepo();
  put(dir, 'a.txt', `header\n${SECRET}\n`);
  const base = commitAll(dir, 'base already carries the line');
  put(dir, 'a.txt', 'header\n');
  commitAll(dir, 'remove the line');
  put(dir, 'a.txt', `header\n${SECRET}\n`);
  const readded = commitAll(dir, 'add the line again');
  const terms = writeTerms(TERMS);

  /* The net diff of base..HEAD is empty, so only the commit by commit pass sees the added line. */
  assert.equal(git(dir, ['diff', `${base}..HEAD`]), '');
  const run = scan(dir, ['--terms', terms, '--range', `${base}..HEAD`]);
  assert.equal(run.status, 1, run.all);
  assert.ok(
    run.stdout.includes(`HIT a.txt:2 term 3 (added in ${base}..HEAD by ${shortOf(readded)})`),
    run.stdout,
  );
});

test('a term added and removed again inside the range still fails, because history is what gets pushed', () => {
  const dir = createRepo();
  put(dir, 'a.txt', 'header\n');
  const base = commitAll(dir, 'base');
  put(dir, 'a.txt', `header\nsecond\n${SECRET}\n`);
  const added = commitAll(dir, 'adds the term');
  put(dir, 'a.txt', 'header\nsecond\n');
  commitAll(dir, 'removes the term');
  const terms = writeTerms(TERMS);

  const withoutRange = scan(dir, ['--terms', terms]);
  assert.equal(withoutRange.status, 0, 'the working tree itself is clean');

  const run = scan(dir, ['--terms', terms, '--range', `${base}..HEAD`]);
  assert.equal(run.status, 1, run.all);
  assert.ok(run.stdout.includes(`HIT a.txt:3 term 3 (added in ${base}..HEAD by ${shortOf(added)})`), run.stdout);
  assert.equal(count(run.stdout, 'added lines scanned'), 2, 'the two lines the first commit added');
});

test('lines removed by the range are not hits, only added lines are', () => {
  const dir = createRepo();
  put(dir, 'a.txt', `header\n${SECRET}\n`);
  const base = commitAll(dir, 'base already carries the line');
  put(dir, 'a.txt', 'header\n');
  commitAll(dir, 'removes it');
  const run = scan(dir, ['--terms', writeTerms(TERMS), '--range', `${base}..HEAD`]);
  assert.equal(run.status, 0, run.all);
  assert.equal(count(run.stdout, 'hits'), 0);
});

test('an added line that itself starts with "++" is scanned and is not taken for a diff header', () => {
  const dir = createRepo();
  put(dir, 'a.txt', 'header\n');
  const base = commitAll(dir, 'base');
  put(dir, 'a.txt', `header\n++ ${SECRET}\n`);
  commitAll(dir, 'adds a line starting with plus signs');
  put(dir, 'a.txt', 'header\n');
  commitAll(dir, 'removes it');
  const run = scan(dir, ['--terms', writeTerms(TERMS), '--range', `${base}..HEAD`]);
  assert.equal(run.status, 1, run.all);
  assert.match(run.stdout, /^HIT a\.txt:2 term 3 \(added in /m);
});

test('range hits name the file, the new-file line number, the range and the commit', () => {
  const dir = createRepo();
  put(dir, 'notes/one.txt', 'l1\nl2\nl3\n');
  const base = commitAll(dir, 'base');
  put(dir, 'notes/one.txt', `l1\nl2\nl3\nl4\n${SECRET_REGEX_TEXT}\nl6\n`);
  put(dir, 'two.txt', `one\ntwo\n${SECRET}\n`);
  const head = commitAll(dir, 'adds two hits');
  const run = scan(dir, ['--terms', writeTerms(TERMS), '--range', `${base}..${head}`]);
  assert.equal(run.status, 1, run.all);
  const range = `${base}..${head}`;
  assert.ok(run.stdout.includes(`HIT notes/one.txt:5 term 4 (added in ${range} by ${shortOf(head)})`), run.stdout);
  assert.ok(run.stdout.includes(`HIT two.txt:3 term 3 (added in ${range} by ${shortOf(head)})`), run.stdout);
});

test('a term introduced only on a merged branch is found through the merge', () => {
  const dir = createRepo();
  put(dir, 'a.txt', 'header\n');
  const base = commitAll(dir, 'base');
  const mainBranch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  git(dir, ['checkout', '-q', '-b', 'side']);
  put(dir, 'side.txt', `${SECRET}\n`);
  const sideCommit = commitAll(dir, 'side adds the term');
  git(dir, ['checkout', '-q', mainBranch]);
  put(dir, 'a.txt', 'header\nmore\n');
  commitAll(dir, 'main moves on');
  git(dir, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side']);
  git(dir, ['rm', '-q', 'side.txt']);
  commitAll(dir, 'drop the file after merging');
  const terms = writeTerms(TERMS);
  assert.equal(scan(dir, ['--terms', terms]).status, 0, 'the final tree is clean');
  const run = scan(dir, ['--terms', terms, '--range', `${base}..HEAD`]);
  assert.equal(run.status, 1, run.all);
  assert.ok(run.stdout.includes(`HIT side.txt:1 term 3 (added in ${base}..HEAD by ${shortOf(sideCommit)})`), run.stdout);
});

test('a term in a path name added within the range is found even if the file is later deleted', () => {
  const dir = createRepo();
  put(dir, 'a.txt', 'header\n');
  const base = commitAll(dir, 'base');
  put(dir, `${SECRET}.txt`, 'harmless\n');
  commitAll(dir, 'adds a file with the term in its name');
  git(dir, ['rm', '-q', `${SECRET}.txt`]);
  commitAll(dir, 'deletes it');
  const run = scan(dir, ['--terms', writeTerms(TERMS), '--range', `${base}..HEAD`]);
  assert.equal(run.status, 1, run.all);
  assert.match(run.stdout, /^HIT \[redacted\]\.txt:0 term 3 \(path name in /m);
  assert.ok(!run.all.toLowerCase().includes(SECRET));
});

test('paths with spaces and quotes are read correctly from the diff', () => {
  const dir = createRepo();
  put(dir, 'a.txt', 'header\n');
  const base = commitAll(dir, 'base');
  put(dir, 'with space/odd "name".txt', `x\n${SECRET}\n`);
  commitAll(dir, 'odd path');
  const run = scan(dir, ['--terms', writeTerms(TERMS), '--range', `${base}..HEAD`]);
  assert.equal(run.status, 1, run.all);
  assert.match(run.stdout, /^HIT with space\/odd "name"\.txt:2 term 3 \(added in /m);
});

test('binary changes inside the range are counted but cannot be scanned', () => {
  const dir = createRepo();
  put(dir, 'a.txt', 'header\n');
  const base = commitAll(dir, 'base');
  put(dir, 'blob.bin', Buffer.from([0, 1, 2, 3, 0]));
  commitAll(dir, 'adds a binary');
  const run = scan(dir, ['--terms', writeTerms(TERMS), '--range', `${base}..HEAD`]);
  assert.equal(run.status, 0, run.all);
  assert.match(run.stdout, /^range: 1 binary file change\(s\) not scanned$/m);
});

test('private/ paths added by commits in the range are an error', () => {
  const dir = createRepo();
  put(dir, 'a.txt', 'header\n');
  const base = commitAll(dir, 'base');
  put(dir, 'private/evidence.txt', 'nothing sensitive\n');
  git(dir, ['add', '-f', 'private/evidence.txt']);
  commitAll(dir, 'adds private');
  git(dir, ['rm', '-q', '-f', 'private/evidence.txt']);
  commitAll(dir, 'removes it again');
  const run = scan(dir, ['--terms', writeTerms(TERMS), '--range', `${base}..HEAD`]);
  assert.equal(run.status, 2, run.all);
  assert.match(run.stderr, /under private\/ are added by commits in the range/);
});

test('an unknown revision in --range is an error (exit 2), not a pass', () => {
  const dir = cleanRepo();
  const run = scan(dir, ['--terms', writeTerms(TERMS), '--range', 'no-such-ref..HEAD']);
  assert.equal(run.status, 2, run.all);
  assert.match(run.stderr, /git failed while/);
  assert.doesNotMatch(run.stdout, /clean/);
});

test('an empty range scans no added lines and passes', () => {
  const dir = cleanRepo();
  const run = scan(dir, ['--terms', writeTerms(TERMS), '--range', 'HEAD..HEAD']);
  assert.equal(run.status, 0, run.all);
  assert.equal(count(run.stdout, 'added lines scanned'), 0);
});

/* ---------- module surface ---------- */

test('parseTerms and validateRange behave as documented', () => {
  const matchers = scanner.parseTerms('# c\n\nAlpha\r\n/b+/i\n');
  assert.deepEqual(matchers.map(m => m.index), [3, 4]);
  assert.equal(matchers[0].test.test('xxALPHAxx'), true);
  assert.equal(matchers[1].test.test('aBBb'), true);
  assert.throws(() => scanner.parseTerms('/(/\n'), /line 1: invalid regular expression/);
  assert.equal(scanner.validateRange('origin/main..HEAD~2'), 'origin/main..HEAD~2');
  assert.throws(() => scanner.validateRange('a..b;rm'), /--range must look like/);
});

test('decodeText treats NUL bytes in the first 8 KB as binary and honours byte order marks', () => {
  assert.equal(scanner.decodeText(Buffer.from([0x61, 0, 0x62])), null);
  assert.equal(scanner.decodeText(Buffer.from('plain text')), 'plain text');
  assert.equal(scanner.decodeText(Buffer.from('﻿with bom')), 'with bom');
  assert.equal(scanner.decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')])), 'hi');
  assert.equal(scanner.decodeText(Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), Buffer.from('hi', 'utf16le')])), null);
});
