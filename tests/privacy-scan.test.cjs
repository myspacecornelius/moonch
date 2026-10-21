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

/* Writes scripts/binary-allowlist.txt (the file a clone tracks) with one exact repo path per line. */
function allowBinaries(dir, ...paths) {
  put(dir, 'scripts/binary-allowlist.txt', `# synthetic allowlist\n\n${paths.join('\n')}\n`);
}

/* A real PNG signature followed by NUL bytes, so the content is binary. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

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
  assert.equal(count(run.stdout, 'binary allowed'), 0);
  assert.equal(count(run.stdout, 'binary blocked'), 0);
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

/* ---------- a linked worktree uses the term list of the main checkout ---------- */

function mainWithWorktree(content = `${SECRET}\n`) {
  const dir = createRepo();
  put(dir, '.gitignore', '/private/\n');
  put(dir, 'readme.txt', 'Atlas Foods.\n');
  put(dir, 'private/privacy-terms.txt', content);
  commitAll(dir, 'initial');
  const worktree = path.join(freshDir('worktrees'), 'wt');
  git(dir, ['worktree', 'add', '-q', worktree, '-b', 'side']);
  return { dir, worktree };
}

test('a linked worktree falls back to the main checkout\'s private/privacy-terms.txt', () => {
  const { dir, worktree } = mainWithWorktree();
  assert.ok(!fs.existsSync(path.join(worktree, 'private')), 'the worktree has no private folder of its own');
  const clean = scan(worktree);
  assert.equal(clean.status, 0, clean.all);
  assert.equal(count(clean.stdout, 'hits'), 0);
  put(worktree, 'notes.txt', `mentions ${SECRET}\n`);
  const leak = scan(worktree);
  assert.equal(leak.status, 1, leak.all);
  assert.match(leak.stdout, /^HIT notes\.txt:1 term 1$/m);
  assert.equal(scan(dir).status, 0, 'the main checkout still uses its own file');
});

test('a worktree\'s own term list wins over the main checkout\'s, --terms wins over both, and with none anywhere the scan refuses', () => {
  const { dir, worktree } = mainWithWorktree('main-only-term\n');
  put(worktree, 'a.txt', `main-only-term and ${SECRET}\n`);
  const fromMain = scan(worktree);
  assert.match(fromMain.stdout, /^HIT a\.txt:1 term 1$/m);
  put(worktree, 'private/privacy-terms.txt', `${SECRET}\n`);
  const own = scan(worktree);
  assert.equal(own.status, 1, own.all);
  assert.equal(count(own.stdout, 'hits'), 1);
  const explicit = scan(worktree, ['--terms', writeTerms('quokka-sapphire\n')]);
  assert.equal(explicit.status, 0, explicit.all);

  const missingExplicit = scan(worktree, ['--terms', path.join(scratch, 'no-such-terms.txt')]);
  assert.equal(missingExplicit.status, 2, 'an explicit --terms file is never replaced by the main checkout\'s');
  assert.ok(missingExplicit.stderr.includes(NO_TERMS));

  fs.rmSync(path.join(worktree, 'private'), { recursive: true });
  fs.rmSync(path.join(dir, 'private'), { recursive: true });
  const none = scan(worktree);
  assert.equal(none.status, 2, none.all);
  assert.ok(none.stderr.includes(NO_TERMS));
  const looked = none.stderr.split('\n').filter(line => line.includes('looked for:'));
  assert.equal(looked.length, 2, 'both places are named: ' + none.stderr);
  assert.ok(looked.some(line => line.includes(path.join(dir, 'private'))) && looked.some(line => line.includes(path.join(worktree, 'private'))));
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

test('a tracked binary file that is not on the allowlist blocks the scan, names its path and says how to allow it', () => {
  const dir = cleanRepo();
  put(dir, 'assets/blob.bin', Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`${SECRET} ${SECRET_REGEX_TEXT}`)]));
  commitAll(dir, 'binary');
  const run = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(run.status, 1, run.all);
  assert.match(run.stdout, /^BINARY assets\/blob\.bin \(tracked\) is not on scripts\/binary-allowlist\.txt$/m);
  assert.match(run.stdout, /^binary: 1 binary file\(s\) are blocked\. /m);
  assert.match(run.stdout, /^binary: to allow one deliberately, add its exact repo path on a line of its own in scripts\/binary-allowlist\.txt /m);
  assert.equal(count(run.stdout, 'binary blocked'), 1);
  assert.equal(count(run.stdout, 'binary allowed'), 0);
  assert.equal(count(run.stdout, 'hits'), 0, 'the content of a binary file is never scanned');
  assert.match(run.stdout, /^privacy-scan: BLOCKED - /m);
  assert.doesNotMatch(run.stdout, /clean/);
});

test('an untracked binary file that git does not ignore blocks the scan, and an ignored one does not', () => {
  const dir = createRepo();
  put(dir, '.gitignore', 'scratch/\n');
  put(dir, 'readme.txt', 'Atlas Foods.\n');
  commitAll(dir, 'initial');
  put(dir, 'scratch/package.xlsx', PNG_BYTES);
  const ignored = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(ignored.status, 0, ignored.all);
  assert.equal(count(ignored.stdout, 'binary blocked'), 0);

  put(dir, 'task package.xlsx', PNG_BYTES);
  const run = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(run.status, 1, run.all);
  assert.match(run.stdout, /^BINARY task package\.xlsx \(untracked, not ignored\) is not on scripts\/binary-allowlist\.txt$/m);
  assert.equal(count(run.stdout, 'binary blocked'), 1);
});

test('a binary file whose exact path is on the allowlist passes, is counted, and is still not scanned', () => {
  const dir = cleanRepo();
  put(dir, 'qa/shot.png', Buffer.concat([PNG_BYTES, Buffer.from(SECRET)]));
  put(dir, 'qa/other.png', PNG_BYTES);
  allowBinaries(dir, 'qa/shot.png');
  commitAll(dir, 'allowed shot');
  const blocked = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(blocked.status, 1, 'only an exact path counts: qa/other.png is not listed');
  assert.match(blocked.stdout, /^BINARY qa\/other\.png \(tracked\) is not on /m);
  assert.doesNotMatch(blocked.stdout, /^BINARY qa\/shot\.png/m);

  allowBinaries(dir, 'qa/shot.png', 'qa/other.png');
  const run = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(run.status, 0, run.all);
  assert.equal(count(run.stdout, 'binary allowed'), 2);
  assert.equal(count(run.stdout, 'binary blocked'), 0);
  assert.equal(count(run.stdout, 'hits'), 0);
  assert.match(run.stdout, /^allowed-binary \(on scripts\/binary-allowlist\.txt, content not scanned\): 2\n {2}qa\/other\.png\n {2}qa\/shot\.png$/m);
  assert.doesNotMatch(run.stdout, /^BINARY /m);
});

test('the allowlist ignores comments, blank lines and CRLF, and matches whole paths in the case git reports them', () => {
  const dir = cleanRepo();
  put(dir, 'qa/shot.png', PNG_BYTES);
  put(dir, 'qa/shot.png.bak', PNG_BYTES);
  put(dir, 'qa/Upper.png', PNG_BYTES);
  put(dir, 'scripts/binary-allowlist.txt', '﻿# comment\r\n\r\n   \r\n# qa/shot.png.bak\r\n  qa/shot.png  \r\nqa/upper.png\r\n');
  commitAll(dir, 'allowlist with noise');
  const run = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(run.status, 1, run.all);
  assert.equal(count(run.stdout, 'binary allowed'), 1);
  assert.match(run.stdout, /^BINARY qa\/shot\.png\.bak \(tracked\)/m, 'a commented-out line allows nothing and a prefix is not a match');
  assert.match(run.stdout, /^BINARY qa\/Upper\.png \(tracked\)/m, 'the path is compared exactly, case included');
  assert.doesNotMatch(run.stdout, /^BINARY qa\/shot\.png /m);
});

test('an allowlist line that is a pattern or a ./ path is an error, and so is an allowlist that is not UTF-8 text', { skip: process.platform === 'win32' }, () => {
  const dir = cleanRepo();
  put(dir, 'qa/shot.png', PNG_BYTES);
  for (const [line, number] of [['qa/*.png', 3], ['./qa/shot.png', 3], ['/qa/shot.png', 3], ['qa\\shot.png', 3], ['qa/shot?.png', 3]]) {
    put(dir, 'scripts/binary-allowlist.txt', `# comment\n\n${line}\n`);
    const run = scan(dir, ['--terms', writeTerms(TERMS)]);
    assert.equal(run.status, 2, `${line}: ${run.all}`);
    assert.match(run.stderr, new RegExp(`scripts/binary-allowlist\\.txt line ${number}: write one exact repo path`));
    assert.doesNotMatch(run.stdout, /clean/);
  }
  put(dir, 'scripts/binary-allowlist.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('qa/shot.png\n', 'utf16le')]));
  const utf16 = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(utf16.status, 2, utf16.all);
  assert.match(utf16.stderr, /scripts\/binary-allowlist\.txt must be UTF-8 text/);

  fs.rmSync(path.join(dir, 'scripts', 'binary-allowlist.txt'));
  fs.mkdirSync(path.join(dir, 'scripts', 'binary-allowlist.txt'));
  const folder = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(folder.status, 2, folder.all);
  assert.match(folder.stderr, /must be a regular file/);

  fs.rmdirSync(path.join(dir, 'scripts', 'binary-allowlist.txt'));
  fs.symlinkSync(path.join(scratch, 'elsewhere.txt'), path.join(dir, 'scripts', 'binary-allowlist.txt'));
  const link = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(link.status, 2, 'a link to an allowlist somewhere else is not followed: ' + link.all);
});

test('a file over 5 MB with a NUL byte near its start is a binary file, not a skipped-size file', () => {
  const dir = cleanRepo();
  const limit = 5 * 1024 * 1024;
  put(dir, 'big.dat', Buffer.concat([PNG_BYTES, Buffer.alloc(limit + 10, 0x61)]));
  put(dir, 'big.txt', Buffer.alloc(limit + 10, 0x61));
  commitAll(dir, 'big files');
  const run = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(run.status, 1, run.all);
  assert.match(run.stdout, /^BINARY big\.dat \(tracked\) is not on /m);
  assert.doesNotMatch(run.stdout, /big\.txt \(tracked\)/);
  assert.equal(count(run.stdout, 'binary blocked'), 1);
  assert.equal(count(run.stdout, 'size skipped'), 1, 'a large text file is still only reported as skipped-size');

  allowBinaries(dir, 'big.dat');
  const allowed = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(allowed.status, 0, allowed.all);
  assert.equal(count(allowed.stdout, 'binary allowed'), 1);
  assert.equal(count(allowed.stdout, 'size skipped'), 1);
});

test('a blocked binary path is redacted and cannot forge output lines, and long lists are capped', { skip: process.platform === 'win32' }, () => {
  const dir = cleanRepo();
  put(dir, `${SECRET}-package.zip`, PNG_BYTES);
  put(dir, 'x\nBINARY forged.bin (tracked) is not on y', PNG_BYTES);
  const run = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(run.status, 1, run.all);
  assert.match(run.stdout, /^BINARY \[redacted\]-package\.zip \(untracked, not ignored\) is not on /m);
  const lines = run.stdout.split('\n');
  assert.ok(!lines.some(line => line.startsWith('BINARY forged')), run.stdout);
  assert.ok(lines.some(line => line.startsWith('BINARY x?BINARY forged.bin (tracked) is not on y (untracked, not ignored)')), run.stdout);
  assert.ok(!run.all.toLowerCase().includes(SECRET), 'the term is never printed');

  for (let n = 0; n < 502; n += 1) put(dir, `many/${String(n).padStart(3, '0')}.bin`, PNG_BYTES);
  const many = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(many.status, 1);
  assert.equal(count(many.stdout, 'binary blocked'), 504);
  assert.equal(many.stdout.split('\n').filter(line => line.startsWith('BINARY ')).length, 500);
  assert.match(many.stdout, /^\.\.\. 4 more blocked binary file\(s\) not shown$/m);
});

test('only the first 8 KB decide whether a file is binary', () => {
  const dir = cleanRepo();
  put(dir, 'late-nul.txt', Buffer.concat([Buffer.from(`${SECRET}\n`), Buffer.alloc(9000, 0x61), Buffer.from([0])]));
  commitAll(dir, 'late nul');
  const run = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(run.status, 1, run.all);
  assert.match(run.stdout, /^HIT late-nul\.txt:1 term 3$/m);
  assert.equal(count(run.stdout, 'binary blocked'), 0);
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
  assert.equal(count(run.stdout, 'binary blocked'), 0);
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
  assert.match(outputs[0].stdout, /^BINARY \[redacted\]\.bin \(tracked\) is not on /m, 'a blocked binary path is redacted too');
  assert.match(outputs[1].stdout, /^BINARY \[redacted\]\.bin \(tracked; added or changed in /m);
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

/* ---------- what counts as binary ---------- */

const NUL_FREE_PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
const NUL_FREE_ZIP = Buffer.from('PK\x03\x04plain looking bytes only');
const NUL_FREE_OLE = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.from('plain looking bytes only')]);
const LATIN1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);

test('a PDF, zip container or old Office file with no NUL byte, and bytes that are not UTF-8, are binary files that need the allowlist', () => {
  const dir = cleanRepo();
  put(dir, 'docs/memo.pdf', NUL_FREE_PDF);
  put(dir, 'docs/book.xlsx', NUL_FREE_ZIP);
  put(dir, 'docs/old.xls', NUL_FREE_OLE);
  put(dir, 'docs/notes.txt', LATIN1);
  put(dir, 'docs/fine.txt', Buffer.from('café ✓ plain UTF-8\n'));
  put(dir, 'docs/mention.txt', Buffer.from('a line that mentions %PDF- and PK in the middle\n'));
  commitAll(dir, 'documents');
  const run = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(run.status, 1, run.all);
  for (const name of ['docs/memo.pdf', 'docs/book.xlsx', 'docs/old.xls', 'docs/notes.txt']) {
    assert.ok(run.stdout.includes(`BINARY ${name} (tracked) is not on scripts/binary-allowlist.txt`), name + '\n' + run.stdout);
  }
  assert.doesNotMatch(run.stdout, /BINARY docs\/(fine|mention)\.txt/, 'valid UTF-8 text is still text');
  assert.equal(count(run.stdout, 'binary blocked'), 4);
  assert.equal(count(run.stdout, 'files scanned'), 4, 'the two readme files and the two text files');

  allowBinaries(dir, 'docs/notes.txt');
  const partly = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(count(partly.stdout, 'binary blocked'), 3);
  assert.equal(count(partly.stdout, 'binary allowed'), 1);
});

test('a term in UTF-8 text beyond ASCII is still found, and a large file cut mid-character stays a skipped-size file', () => {
  const dir = cleanRepo();
  put(dir, 'accented.txt', Buffer.from(`café ${SECRET} ✓\n`));
  const limit = 5 * 1024 * 1024;
  /* 8191 ASCII bytes, then two-byte characters: the 8 KB probe ends inside a character. */
  put(dir, 'big-accented.txt', Buffer.concat([Buffer.alloc(8191, 0x61), Buffer.from('é'.repeat(limit / 2))]));
  commitAll(dir, 'text');
  const run = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(run.status, 1, run.all);
  assert.match(run.stdout, /^HIT accented\.txt:1 term 3$/m);
  assert.equal(count(run.stdout, 'binary blocked'), 0);
  assert.equal(count(run.stdout, 'size skipped'), 1);
});

/* ---------- an allowlisted path must still hold what its entry says ---------- */

const HASH = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
const ZIP_BYTES = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(16, 0)]);

test('an allowlisted .png path must hold a real PNG: a zip, a PDF or plain text there is blocked in the work tree', () => {
  const dir = cleanRepo();
  put(dir, 'qa/dashboard/desktop-overview.png', PNG_BYTES);
  allowBinaries(dir, 'qa/dashboard/desktop-overview.png');
  commitAll(dir, 'a real screenshot');
  const ok = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(ok.status, 0, ok.all);
  assert.equal(count(ok.stdout, 'binary allowed'), 1);

  for (const [label, bytes] of [['a zip with NUL bytes', ZIP_BYTES], ['a NUL-free zip', NUL_FREE_ZIP], ['a PDF', NUL_FREE_PDF], ['plain text', Buffer.from('not an image\n')], ['a short file', Buffer.from([0x89, 0x50])], ['an empty file', Buffer.alloc(0)]]) {
    put(dir, 'qa/dashboard/desktop-overview.png', bytes);
    const run = scan(dir, ['--terms', writeTerms(TERMS)]);
    assert.equal(run.status, 1, `${label}: ${run.all}`);
    assert.match(run.stdout, /^BINARY qa\/dashboard\/desktop-overview\.png \(tracked\) fails its scripts\/binary-allowlist\.txt entry: not a PNG file$/m, label);
    assert.equal(count(run.stdout, 'binary allowed'), 0, label + ': a path that fails its check is not counted as allowed');
  }
});

test('a sha256 pin fixes the content: the pinned file passes, any other content at that path is blocked, in any letter case', () => {
  const dir = cleanRepo();
  put(dir, 'tests/fixtures/package.zip', ZIP_BYTES);
  allowBinaries(dir, `tests/fixtures/package.zip sha256=${HASH(ZIP_BYTES).toUpperCase()}`);
  commitAll(dir, 'pinned fixture');
  const ok = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(ok.status, 0, ok.all);
  assert.equal(count(ok.stdout, 'binary allowed'), 1);

  put(dir, 'tests/fixtures/package.zip', Buffer.concat([ZIP_BYTES, Buffer.from([1])]));
  const swapped = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(swapped.status, 1, swapped.all);
  assert.match(swapped.stdout, /^BINARY tests\/fixtures\/package\.zip \(tracked\) fails its scripts\/binary-allowlist\.txt entry: sha256 differs from the pinned value$/m);

  put(dir, 'tests/fixtures/package.zip', Buffer.from('now plain text\n'));
  const text = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(text.status, 1, 'a pin also holds when the replacement is text: ' + text.all);
  assert.match(text.stdout, /sha256 differs from the pinned value/);
});

test('a path with a pin that does not exist in the work tree blocks nothing by itself, and the pins in the repository match', () => {
  const dir = cleanRepo();
  allowBinaries(dir, `gone.zip sha256=${HASH('x')}`, 'gone.png');
  commitAll(dir, 'allowlist only');
  assert.equal(scan(dir, ['--terms', writeTerms(TERMS)]).status, 0);
  const root = path.join(__dirname, '..');
  const entries = scanner.parseAllowlist(fs.readFileSync(path.join(root, 'scripts', 'binary-allowlist.txt'), 'utf8'));
  const pinned = [...entries].filter(([, entry]) => entry.sha256 !== null);
  assert.ok(pinned.some(([file]) => file === 'tests/fixtures/package.zip'), 'the test fixture zip is pinned');
  for (const [file, entry] of pinned) assert.equal(HASH(fs.readFileSync(path.join(root, file))), entry.sha256, file);
});

/* ---------- tracked files that .gitignore ignores ---------- */

const IGNORE_RULES = '*[_-]PRIVATE.*\n*-project.json\n!keep-project.json\n';

test('a force-added ignored export is blocked as a tracked file, named, with the way out', () => {
  const dir = createRepo();
  put(dir, '.gitignore', IGNORE_RULES);
  put(dir, 'readme.txt', 'Atlas Foods.\n');
  put(dir, 'keep-project.json', '{"invented":true}\n');
  commitAll(dir, 'initial');
  put(dir, 'Finance_Agent_Round_r1_PRIVATE.json', '{"gold":"invented"}\n');
  put(dir, 'T-project.json', '{"invented":true}\n');
  put(dir, `${SECRET}-project.json`, '{"invented":true}\n');
  git(dir, ['add', '-f', 'Finance_Agent_Round_r1_PRIVATE.json', 'T-project.json', `${SECRET}-project.json`]);
  commitAll(dir, 'oops, forced');
  const run = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(run.status, 1, run.all);
  assert.match(run.stdout, /^IGNORED Finance_Agent_Round_r1_PRIVATE\.json \(tracked\) is ignored by \.gitignore, so it must not be in git$/m);
  assert.match(run.stdout, /^IGNORED T-project\.json \(tracked\) is ignored by /m);
  assert.match(run.stdout, /^IGNORED \[redacted\]-project\.json \(tracked\) is ignored by /m, 'the printed path is redacted');
  assert.match(run.stdout, /^ignored: take each out of git with git rm --cached <path>/m);
  assert.doesNotMatch(run.stdout, /IGNORED keep-project\.json/, 'a path with a ! exception is not ignored');
  assert.equal(count(run.stdout, 'ignored blocked'), 3);
  assert.equal(count(run.stdout, 'binary blocked'), 0);
  assert.ok(!run.all.toLowerCase().includes(SECRET));

  git(dir, ['rm', '-q', '--cached', 'T-project.json', 'Finance_Agent_Round_r1_PRIVATE.json', `${SECRET}-project.json`]);
  const fixed = scan(dir, ['--terms', writeTerms(TERMS)]);
  assert.equal(fixed.status, 0, 'once git no longer tracks them the files are ignored and untracked, which is where they belong: ' + fixed.all);
  assert.equal(count(fixed.stdout, 'ignored blocked'), 0);
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

test('a binary file added in the range that is not on the allowlist blocks, naming the path, the range and the commit', () => {
  const dir = createRepo();
  put(dir, 'a.txt', 'header\n');
  const base = commitAll(dir, 'base');
  put(dir, 'with space/odd "name".xlsx', Buffer.from([0, 1, 2, 3, 0]));
  const added = commitAll(dir, 'adds a binary');
  const run = scan(dir, ['--terms', writeTerms(TERMS), '--range', `${base}..HEAD`]);
  assert.equal(run.status, 1, run.all);
  assert.ok(
    run.stdout.includes(`BINARY with space/odd "name".xlsx (tracked; added or changed in ${base}..HEAD by ${shortOf(added)}) is not on scripts/binary-allowlist.txt`),
    run.stdout,
  );
  assert.equal(count(run.stdout, 'binary blocked'), 1);
  assert.match(run.stdout, /^binary: to allow one deliberately, /m);
});

test('a binary file added and deleted again inside the range still blocks, because history is what gets pushed', () => {
  const dir = createRepo();
  put(dir, 'a.txt', 'header\n');
  const base = commitAll(dir, 'base');
  put(dir, 'package.zip', PNG_BYTES);
  const added = commitAll(dir, 'adds a package');
  git(dir, ['rm', '-q', 'package.zip']);
  commitAll(dir, 'removes it again');
  const terms = writeTerms(TERMS);
  assert.equal(scan(dir, ['--terms', terms]).status, 0, 'the work tree itself holds no binary file');
  const run = scan(dir, ['--terms', terms, '--range', `${base}..HEAD`]);
  assert.equal(run.status, 1, run.all);
  assert.ok(run.stdout.includes(`BINARY package.zip (added or changed in ${base}..HEAD by ${shortOf(added)}) is not on `), run.stdout);
});

test('deleting a binary file in the range is not a hit, and a binary file on the allowlist is allowed to change', () => {
  const dir = createRepo();
  put(dir, 'a.txt', 'header\n');
  put(dir, 'old.bin', PNG_BYTES);
  put(dir, 'kept.png', PNG_BYTES);
  allowBinaries(dir, 'kept.png');
  const base = commitAll(dir, 'base already carries a binary file');
  git(dir, ['rm', '-q', 'old.bin']);
  put(dir, 'kept.png', Buffer.concat([PNG_BYTES, Buffer.from([9, 9])]));
  commitAll(dir, 'deletes one binary and changes the allowed one');
  const run = scan(dir, ['--terms', writeTerms(TERMS), '--range', `${base}..HEAD`]);
  assert.equal(run.status, 0, run.all);
  assert.equal(count(run.stdout, 'binary blocked'), 0);
  assert.match(run.stdout, /^range: 1 allowed binary file change\(s\) not scanned$/m);
});

test('the range reads the allowlist from the head commit: an allowlist added in the range counts, one only in the work tree does not', () => {
  const dir = createRepo();
  put(dir, 'a.txt', 'header\n');
  const base = commitAll(dir, 'base');
  const terms = writeTerms(TERMS);

  put(dir, 'shot.png', PNG_BYTES);
  commitAll(dir, 'adds a binary first');
  allowBinaries(dir, 'shot.png');
  commitAll(dir, 'allows it in a later commit of the same push');
  const allowed = scan(dir, ['--terms', terms, '--range', `${base}..HEAD`]);
  assert.equal(allowed.status, 0, allowed.all);
  assert.match(allowed.stdout, /^range: 1 allowed binary file change\(s\) not scanned$/m);

  put(dir, 'second.png', PNG_BYTES);
  commitAll(dir, 'adds another binary');
  allowBinaries(dir, 'shot.png', 'second.png');
  const workTreeOnly = scan(dir, ['--terms', terms, '--range', `${base}..HEAD`]);
  assert.equal(scan(dir, ['--terms', terms]).status, 0, 'the work tree scan reads the edited allowlist');
  assert.equal(workTreeOnly.status, 1, workTreeOnly.all);
  assert.match(workTreeOnly.stdout, /^BINARY second\.png \(added or changed in /m);
  assert.doesNotMatch(workTreeOnly.stdout, /^BINARY shot\.png/m);

  const earlier = git(dir, ['rev-parse', 'HEAD~1']);
  const olderHead = scan(dir, ['--terms', terms, '--range', `${base}..${earlier}`]);
  assert.equal(olderHead.status, 0, 'a range ends at its own head commit, whatever is checked out: ' + olderHead.all);
});

test('a binary file introduced only on a merged branch is found through the merge', () => {
  const dir = createRepo();
  put(dir, 'a.txt', 'header\n');
  const base = commitAll(dir, 'base');
  const mainBranch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  git(dir, ['checkout', '-q', '-b', 'side']);
  put(dir, 'side.docx', PNG_BYTES);
  const sideCommit = commitAll(dir, 'side adds a binary');
  git(dir, ['checkout', '-q', mainBranch]);
  put(dir, 'a.txt', 'header\nmore\n');
  commitAll(dir, 'main moves on');
  git(dir, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side']);
  const run = scan(dir, ['--terms', writeTerms(TERMS), '--range', `${base}..HEAD`]);
  assert.equal(run.status, 1, run.all);
  assert.match(run.stdout, new RegExp(`^BINARY side\\.docx \\(tracked; added or changed in ${base}\\.\\.HEAD by ${shortOf(sideCommit)}\\)`, 'm'));
  assert.equal(count(run.stdout, 'binary blocked'), 1);
});

test('a PDF, a zip container and Latin-1 text added in the range are binary files even though git diffs them as text', () => {
  const dir = createRepo();
  put(dir, 'a.txt', 'header\n');
  const base = commitAll(dir, 'base');
  put(dir, 'memo.pdf', NUL_FREE_PDF);
  put(dir, 'book.xlsx', NUL_FREE_ZIP);
  put(dir, 'old.doc', NUL_FREE_OLE);
  put(dir, 'notes.txt', LATIN1);
  put(dir, 'fine.txt', Buffer.from('café ✓\n'));
  const added = commitAll(dir, 'documents');
  const range = `${base}..HEAD`;
  assert.doesNotMatch(git(dir, ['diff', '--numstat', range]), /^-\t-\t/m, 'git itself calls all of these text');
  const run = scan(dir, ['--terms', writeTerms(TERMS), '--range', range]);
  assert.equal(run.status, 1, run.all);
  for (const name of ['memo.pdf', 'book.xlsx', 'old.doc', 'notes.txt']) {
    assert.ok(run.stdout.includes(`BINARY ${name} (tracked; added or changed in ${range} by ${shortOf(added)}) is not on `), name + '\n' + run.stdout);
  }
  assert.doesNotMatch(run.stdout, /BINARY fine\.txt/);
  assert.equal(count(run.stdout, 'binary blocked'), 4);
});

test('an allowed .png path that holds a zip in an intermediate commit of the range is blocked, although the final tree has a real PNG', () => {
  const dir = createRepo();
  put(dir, 'a.txt', 'header\n');
  const base = commitAll(dir, 'base');
  put(dir, 'qa/shot.png', PNG_BYTES);
  allowBinaries(dir, 'qa/shot.png');
  const first = commitAll(dir, 'a real screenshot, allowed');
  put(dir, 'qa/shot.png', ZIP_BYTES);
  const swapped = commitAll(dir, 'a zip under the screenshot name');
  put(dir, 'qa/shot.png', Buffer.concat([PNG_BYTES, Buffer.from([7])]));
  commitAll(dir, 'a real screenshot again');
  const terms = writeTerms(TERMS);
  assert.equal(scan(dir, ['--terms', terms]).status, 0, 'the final tree is fine');

  const run = scan(dir, ['--terms', terms, '--range', `${base}..HEAD`]);
  assert.equal(run.status, 1, run.all);
  assert.ok(run.stdout.includes(`BINARY qa/shot.png (added or changed in ${base}..HEAD by ${shortOf(swapped)}) fails its scripts/binary-allowlist.txt entry: not a PNG file`), run.stdout);
  assert.ok(!run.stdout.includes(shortOf(first)), 'the first commit was fine');
  assert.equal(count(run.stdout, 'binary blocked'), 1);

  const onlyGood = scan(dir, ['--terms', terms, '--range', `${base}..${first}`]);
  assert.equal(onlyGood.status, 0, onlyGood.all);
  assert.match(onlyGood.stdout, /^range: 1 allowed binary file change\(s\) not scanned$/m);
});

test('plain text under an allowed .png name, and a changed blob under a sha256 pin, are blocked in the range', () => {
  const dir = createRepo();
  put(dir, 'a.txt', 'header\n');
  const base = commitAll(dir, 'base');
  put(dir, 'qa/shot.png', Buffer.from('this is not an image\n'));
  put(dir, 'fixtures/package.zip', ZIP_BYTES);
  allowBinaries(dir, 'qa/shot.png', `fixtures/package.zip sha256=${HASH(ZIP_BYTES)}`);
  commitAll(dir, 'text as a screenshot');
  const run = scan(dir, ['--terms', writeTerms(TERMS), '--range', `${base}..HEAD`]);
  assert.equal(run.status, 1, run.all);
  assert.match(run.stdout, /^BINARY qa\/shot\.png \(tracked; added or changed in .*\) fails its scripts\/binary-allowlist\.txt entry: not a PNG file$/m);
  assert.doesNotMatch(run.stdout, /BINARY fixtures\/package\.zip/, 'the pinned file matches its pin');

  put(dir, 'fixtures/package.zip', Buffer.concat([ZIP_BYTES, Buffer.from([1])]));
  const changed = commitAll(dir, 'a different zip at the pinned path');
  const pinned = scan(dir, ['--terms', writeTerms(TERMS), '--range', `${base}..HEAD`]);
  assert.ok(pinned.stdout.includes(`BINARY fixtures/package.zip (tracked; added or changed in ${base}..HEAD by ${shortOf(changed)}) fails its scripts/binary-allowlist.txt entry: sha256 differs from the pinned value`), pinned.stdout);
});

test('a force-added ignored export is blocked in the range, even when a later commit removes it', () => {
  const dir = createRepo();
  put(dir, '.gitignore', IGNORE_RULES);
  put(dir, 'a.txt', 'header\n');
  const base = commitAll(dir, 'base');
  put(dir, 'Finance_Agent_Round_r1_PRIVATE.json', '{"gold":"invented"}\n');
  put(dir, 'with space/T-project.json', '{"invented":true}\n');
  put(dir, 'keep-project.json', '{"invented":true}\n');
  git(dir, ['add', '-f', 'Finance_Agent_Round_r1_PRIVATE.json', 'with space/T-project.json']);
  const added = commitAll(dir, 'adds ignored exports');
  git(dir, ['rm', '-q', 'Finance_Agent_Round_r1_PRIVATE.json', 'with space/T-project.json']);
  commitAll(dir, 'removes them again');
  const terms = writeTerms(TERMS);
  const range = `${base}..HEAD`;
  assert.equal(scan(dir, ['--terms', terms]).status, 0, 'the final tree no longer tracks them');
  const run = scan(dir, ['--terms', terms, '--range', range]);
  assert.equal(run.status, 1, run.all);
  assert.ok(run.stdout.includes(`IGNORED Finance_Agent_Round_r1_PRIVATE.json (added or changed in ${range} by ${shortOf(added)}) is ignored by .gitignore, so it must not be in git`), run.stdout);
  assert.ok(run.stdout.includes(`IGNORED with space/T-project.json (added or changed in ${range} by ${shortOf(added)}) is ignored by `), run.stdout);
  assert.doesNotMatch(run.stdout, /IGNORED keep-project\.json/, 'a path with a ! exception is not ignored');
  assert.equal(count(run.stdout, 'ignored blocked'), 2);
  assert.match(run.stdout, /^ignored: take each out of git with git rm --cached <path>/m);
});

test('a path that only a range deletes is never blocked as ignored or binary', () => {
  const dir = createRepo();
  put(dir, '.gitignore', IGNORE_RULES);
  put(dir, 'a.txt', 'header\n');
  put(dir, 'T-project.json', '{"invented":true}\n');
  put(dir, 'old.bin', PNG_BYTES);
  git(dir, ['add', '-f', 'T-project.json']);
  const base = commitAll(dir, 'base, already carrying both');
  git(dir, ['rm', '-q', 'T-project.json', 'old.bin']);
  commitAll(dir, 'deletes both');
  const run = scan(dir, ['--terms', writeTerms(TERMS), '--range', `${base}..HEAD`]);
  assert.equal(run.status, 0, run.all);
  assert.equal(count(run.stdout, 'ignored blocked'), 0);
  assert.equal(count(run.stdout, 'binary blocked'), 0);
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

test('parseAllowlist keeps exact paths and optional pins, skips comments and blanks, and rejects bad lines', () => {
  const hash = 'ab'.repeat(32);
  const allowed = scanner.parseAllowlist(`﻿# c\r\n\r\n qa/a.png \r\ntests/fixtures/package.zip sha256=${hash.toUpperCase()}\r\nwith space/odd name.zip\tsha256=${hash}\nqa/b c.png\n`);
  assert.deepEqual([...allowed.keys()], ['qa/a.png', 'tests/fixtures/package.zip', 'with space/odd name.zip', 'qa/b c.png']);
  assert.deepEqual(allowed.get('qa/a.png'), { sha256: null });
  assert.deepEqual(allowed.get('tests/fixtures/package.zip'), { sha256: hash }, 'the pin is kept in lower case');
  assert.deepEqual(allowed.get('with space/odd name.zip'), { sha256: hash });
  assert.equal(allowed.has('QA/a.png'), false);
  assert.equal(scanner.parseAllowlist('').size, 0);
  assert.throws(() => scanner.parseAllowlist('ok.bin\nqa/*.png\n'), /line 2: write one exact repo path/);
  assert.throws(() => scanner.parseAllowlist('ok.bin sha256=abc\n'), /line 1: sha256= needs 64 hexadecimal digits/);
  assert.throws(() => scanner.parseAllowlist(`a.bin sha256=${hash}x\n`), /line 1: sha256= needs 64 hexadecimal digits/);
  assert.throws(() => scanner.parseAllowlist(`sha256=${hash}\n`), /line 1: put the exact repo path before sha256=/);
  assert.throws(() => scanner.parseAllowlist('a.bin\n# c\na.bin\n'), /line 3: the path is listed twice/);
  assert.equal(scanner.BINARY_ALLOWLIST, 'scripts/binary-allowlist.txt');
});

test('decodeText treats NUL bytes in the first 8 KB, document signatures and invalid UTF-8 as binary, and honours byte order marks', () => {
  assert.equal(scanner.decodeText(Buffer.from([0x61, 0, 0x62])), null);
  assert.equal(scanner.decodeText(Buffer.from('plain text')), 'plain text');
  assert.equal(scanner.decodeText(Buffer.from('﻿with bom')), 'with bom');
  assert.equal(scanner.decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')])), 'hi');
  assert.equal(scanner.decodeText(Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), Buffer.from('hi', 'utf16le')])), null);
  assert.equal(scanner.decodeText(Buffer.from('%PDF-1.7\nno NUL byte in here\n')), null, 'a PDF');
  assert.equal(scanner.decodeText(Buffer.from('PK\x03\x04plain looking')), null, 'a zip container');
  assert.equal(scanner.decodeText(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.from('plain looking')])), null, 'an old Office file');
  assert.equal(scanner.decodeText(Buffer.from('see %PDF-1.7 and PK\x03\x04 later')), 'see %PDF-1.7 and PK\x03\x04 later', 'a signature only counts at the start');
  assert.equal(scanner.decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9])), null, 'Latin-1 bytes are not UTF-8');
  assert.equal(scanner.decodeText(Buffer.from('café ✓')), 'café ✓', 'valid UTF-8 beyond ASCII is text');
  const cut = Buffer.from('é').subarray(0, 1);
  assert.equal(scanner.decodeText(Buffer.concat([Buffer.from('ab'), cut])), null, 'a character cut off in a whole file is invalid');
  assert.equal(scanner.decodeText(Buffer.concat([Buffer.from('ab'), cut]), { partial: true }), 'ab', 'but not at the end of a probe');
});
