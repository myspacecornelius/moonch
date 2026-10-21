'use strict';
/* Tests for scripts/pre-push.cjs, the hook that runs the privacy scan over what a push publishes.
   Every fixture is synthetic: throwaway repositories under os.tmpdir() with an invented term, a local bare repository as the
   remote, and a term list passed through FINANCE_PRIVACY_TERMS. The real private/ folder is never read. */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const hook = require('../scripts/pre-push.cjs');

const HOOK = path.resolve(__dirname, '..', 'scripts', 'pre-push.cjs');
const SCANNER = path.resolve(__dirname, '..', 'scripts', 'privacy-scan.cjs');
const TERM = 'synthetic-forbidden-term';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const ZERO = '0'.repeat(40);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-push-test-'));
const homeDir = path.join(scratch, 'home');
fs.mkdirSync(homeDir);
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const env = (extra = {}) => ({
  PATH: process.env.PATH, HOME: homeDir, XDG_CONFIG_HOME: homeDir, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...extra,
});
const git = (dir, args, extra) => execFileSync('git', args, { cwd: dir, env: env(extra), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (dir, args, extra) => spawnSync('git', args, { cwd: dir, env: env(extra), encoding: 'utf8' });

/* ------------------------------------------------------------------ the pure parts */

test('parseRefLines reads the four fields of each line and ignores everything else', () => {
  const text = `refs/heads/main ${A} refs/heads/main ${B}\n\nnot a ref\nrefs/heads/x ${B} refs/heads/x ${ZERO}\n`;
  assert.deepEqual(hook.parseRefLines(text), [
    { localRef: 'refs/heads/main', localSha: A, remoteRef: 'refs/heads/main', remoteSha: B },
    { localRef: 'refs/heads/x', localSha: B, remoteRef: 'refs/heads/x', remoteSha: ZERO },
  ]);
  assert.deepEqual(hook.parseRefLines(''), []);
  assert.deepEqual(hook.parseRefLines(undefined), []);
});

test('planRanges: an existing branch scans remote..local, a deletion nothing, a new branch the unpushed commits only', () => {
  const calls = [];
  const known = new Set([B]);
  const fake = (args, options) => {
    calls.push(args.join(' '));
    if (args[0] === 'cat-file') return { ok: known.has(args[2].split('^')[0]), out: '' };
    if (args[0] === 'rev-list') return { ok: true, out: `${'c'.repeat(40)}\n${'d'.repeat(40)}` };
    if (args[0] === 'rev-parse') return { ok: true, out: 'e'.repeat(40) };
    if (args[0] === 'hash-object') return { ok: true, out: 'f'.repeat(40), input: options && options.input };
    return { ok: false, out: '' };
  };
  const line = (local, remote) => ({ localRef: 'refs/heads/x', localSha: local, remoteRef: 'refs/heads/x', remoteSha: remote });
  assert.deepEqual(hook.planRanges([line(A, B)], 'origin', fake), [`${B}..${A}`], 'a known remote sha');
  assert.deepEqual(hook.planRanges([line(ZERO, B)], 'origin', fake), [], 'a deletion');
  const fresh = hook.planRanges([line(A, ZERO)], 'origin', fake);
  assert.deepEqual(fresh, [`${'e'.repeat(40)}..${A}`], 'a new branch starts at the parent of its first unpushed commit');
  assert.ok(calls.includes(`rev-list --reverse ${A} --not --remotes=origin`));
  const unknown = hook.planRanges([line(A, '9'.repeat(40))], 'origin', fake);
  assert.deepEqual(unknown, [`${'e'.repeat(40)}..${A}`], 'a remote sha this clone does not have is treated like a new branch');
  const nothing = (args) => (args[0] === 'rev-list' ? { ok: true, out: '' } : { ok: false, out: '' });
  assert.deepEqual(hook.planRanges([line(A, ZERO)], 'origin', nothing), [], 'everything is on the remote already');
  const broken = (args) => ({ ok: false, out: '' });
  assert.throws(() => hook.planRanges([line(A, ZERO)], 'origin', broken), /could not list the commits/);
});

test('main blocks when the scan fails, passes when it does not, and blocks outside a work tree', () => {
  const lines = `refs/heads/x ${A} refs/heads/x ${B}\n`;
  const fakeGit = (args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { ok: true, out: '/work/tree' };
    if (args[0] === 'cat-file') return { ok: true, out: '' };
    return { ok: false, out: '' };
  };
  const messages = [];
  const seen = [];
  const pass = hook.main(['origin', 'url'], lines, { git: fakeGit, run: args => { seen.push(args); return 0; }, err: m => messages.push(m), env: {} });
  assert.equal(pass, 0);
  assert.deepEqual(seen, [['--root', '/work/tree', '--range', `${B}..${A}`]]);
  const fail = hook.main(['origin'], lines, { git: fakeGit, run: () => 1, err: m => messages.push(m), env: { FINANCE_PRIVACY_TERMS: '/terms.txt' } });
  assert.equal(fail, 1);
  assert.match(messages.join('\n'), /did not pass\. Push blocked/);
  const withTerms = [];
  hook.main(['origin'], lines, { git: fakeGit, run: args => { withTerms.push(args); return 0; }, err() {}, env: { FINANCE_PRIVACY_TERMS: '/terms.txt' } });
  assert.deepEqual(withTerms[0].slice(0, 4), ['--root', '/work/tree', '--terms', '/terms.txt']);
  const outside = hook.main(['origin'], lines, { git: () => ({ ok: false, out: '' }), run: () => 0, err: m => messages.push(m), env: {} });
  assert.equal(outside, 1);
  const noRefs = [];
  assert.equal(hook.main(['origin'], '', { git: fakeGit, run: args => { noRefs.push(args); return 0; }, err() {}, env: {} }), 0);
  assert.deepEqual(noRefs, [['--root', '/work/tree']], 'with no refs the work tree is still scanned once');
});

/* ------------------------------------------------------------------ with real repositories and a real push */

function world(label, { installHook = true } = {}) {
  const dir = path.join(scratch, label);
  fs.mkdirSync(dir);
  const remote = path.join(dir, 'remote.git');
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  git(dir, ['init', '-q', '--bare', remote]);
  git(work, ['init', '-q', '-b', 'main']);
  for (const [key, value] of [['user.name', 'Test Writer'], ['user.email', 'writer@example.invalid'], ['commit.gpgsign', 'false']]) git(work, ['config', key, value]);
  git(work, ['remote', 'add', 'origin', remote]);
  const terms = path.join(dir, 'terms.txt');
  fs.writeFileSync(terms, `# synthetic\n${TERM}\n`);
  const commit = (name, text, message) => {
    fs.writeFileSync(path.join(work, name), text);
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', message]);
    return git(work, ['rev-parse', 'HEAD']);
  };
  const install = () => {
    const file = path.join(work, '.git', 'hooks', 'pre-push');
    fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${HOOK}" "$@"\n`, { mode: 0o755 });
  };
  if (installHook) install();
  const push = (args, extra) => tryGit(work, ['push', ...args], { FINANCE_PRIVACY_TERMS: terms, ...extra });
  const remoteHead = branch => { const result = tryGit(remote, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); return result.status === 0 ? result.stdout.trim() : null; };
  return { dir, remote, work, terms, commit, push, install, remoteHead };
}

test('a term added in one commit and removed in the next is blocked, although the work tree is clean', () => {
  const w = world('add-then-remove');
  const base = w.commit('notes.txt', 'plain text\n', 'baseline');
  assert.equal(w.push(['origin', 'main']).status, 0, 'a clean push goes through');
  assert.equal(w.remoteHead('main'), base);
  const leaked = w.commit('notes.txt', `plain text ${TERM}\n`, 'add');
  const removed = w.commit('notes.txt', 'plain text\n', 'remove');
  assert.notEqual(leaked, removed);

  /* What the old README hook ran (no --range) sees only the clean work tree. */
  const old = spawnSync(process.execPath, [SCANNER, '--terms', w.terms, '--root', w.work], { encoding: 'utf8', env: env() });
  assert.equal(old.status, 0, 'the work tree scan alone passes: ' + old.stdout);

  const blocked = w.push(['origin', 'main']);
  assert.notEqual(blocked.status, 0, 'the hook blocks the push');
  assert.match(blocked.stdout + blocked.stderr, /HIT notes\.txt/);
  assert.match(blocked.stdout + blocked.stderr, /Push blocked/);
  assert.equal(w.remoteHead('main'), base, 'nothing reached the remote');
  assert.doesNotMatch(blocked.stdout + blocked.stderr, new RegExp(TERM), 'the term is never printed');
});

test('a new branch is scanned from its first unpushed commit, and history that is already on the remote does not block it', () => {
  const w = world('new-branch', { installHook: false });
  w.commit('old.txt', `old history ${TERM}\n`, 'old leak');
  w.commit('old.txt', 'old history\n', 'old fix');
  assert.equal(w.push(['origin', 'main']).status, 0, 'pushed before the hook was installed');
  w.install();
  git(w.work, ['checkout', '-q', '-b', 'feature']);
  w.commit('new.txt', 'a clean change\n', 'clean');
  assert.equal(w.push(['origin', 'feature']).status, 0, 'a new branch with clean new commits passes');
  assert.ok(w.remoteHead('feature'));

  git(w.work, ['checkout', '-q', '-b', 'second']);
  w.commit('other.txt', `fresh ${TERM}\n`, 'leak');
  w.commit('other.txt', 'fresh\n', 'fix');
  const blocked = w.push(['origin', 'second']);
  assert.notEqual(blocked.status, 0);
  assert.equal(w.remoteHead('second'), null);
});

test('a deletion passes, a missing term list blocks (the scan fails closed), and the hook is quiet about clean pushes', () => {
  const w = world('misc');
  w.commit('a.txt', 'one\n', 'one');
  const first = w.push(['origin', 'main']);
  assert.equal(first.status, 0);
  git(w.work, ['checkout', '-q', '-b', 'topic']);
  w.commit('b.txt', 'two\n', 'two');
  assert.equal(w.push(['origin', 'topic']).status, 0);
  assert.equal(w.push(['origin', '--delete', 'topic']).status, 0, 'deleting a branch publishes nothing');
  assert.equal(w.remoteHead('topic'), null);

  w.commit('c.txt', 'three\n', 'three');
  const noTerms = w.push(['origin', 'topic'], { FINANCE_PRIVACY_TERMS: path.join(w.dir, 'missing-terms.txt') });
  assert.notEqual(noTerms.status, 0);
  assert.match(noTerms.stdout + noTerms.stderr, /Push blocked/);
  assert.equal(w.remoteHead('topic'), null);
});

/* ------------------------------------------------------------------ binary files, and the versioned hook */

const VERSIONED_HOOKS = path.resolve(__dirname, '..', '.githooks');
/* A real PNG signature followed by NUL bytes. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function commitFiles(w, files, message) {
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(w.work, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git(w.work, ['add', '-A']);
  git(w.work, ['commit', '-q', '-m', message]);
  return git(w.work, ['rev-parse', 'HEAD']);
}

test('a push that adds a binary file not on the allowlist is blocked, and one that allows it in the same push goes through', () => {
  const w = world('binary');
  const base = w.commit('notes.txt', 'plain text\n', 'baseline');
  assert.equal(w.push(['origin', 'main']).status, 0);

  commitFiles(w, { 'packages/Task Package.xlsx': PNG }, 'adds a task package');
  const blocked = w.push(['origin', 'main']);
  assert.notEqual(blocked.status, 0, 'the hook blocks the push');
  const output = blocked.stdout + blocked.stderr;
  assert.match(output, /BINARY packages\/Task Package\.xlsx \(tracked; added or changed in /);
  assert.match(output, /to allow one deliberately, add its exact repo path/);
  assert.match(output, /Push blocked/);
  assert.equal(w.remoteHead('main'), base, 'nothing reached the remote');

  git(w.work, ['reset', '-q', '--hard', 'HEAD~1']);
  const allowed = commitFiles(w, { 'packages/shot.png': PNG, 'scripts/binary-allowlist.txt': '# on purpose\npackages/shot.png\n' }, 'adds a screenshot and allows it');
  const pushed = w.push(['origin', 'main']);
  assert.equal(pushed.status, 0, pushed.stdout + pushed.stderr);
  assert.equal(w.remoteHead('main'), allowed);
});

test('a new branch is checked for binary files from its first unpushed commit, even when the work tree is clean again', () => {
  const w = world('binary-new-branch');
  w.commit('notes.txt', 'plain text\n', 'baseline');
  assert.equal(w.push(['origin', 'main']).status, 0);
  git(w.work, ['checkout', '-q', '-b', 'feature']);
  commitFiles(w, { 'export.zip': PNG }, 'adds an export');
  git(w.work, ['rm', '-q', 'export.zip']);
  git(w.work, ['commit', '-q', '-m', 'removes the export']);
  const blocked = w.push(['origin', 'feature']);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stdout + blocked.stderr, /BINARY export\.zip \(added or changed in /);
  assert.equal(w.remoteHead('feature'), null);
});

/* ------------------------------------------------------------------ npm run setup and the shim */

const REPO = path.resolve(__dirname, '..');
const SHIM_SOURCE = path.join(VERSIONED_HOOKS, 'pre-push');
const NO_SH = process.platform === 'win32' ? 'no sh' : false;
const setupRun = (w, args = [], extra) => spawnSync(process.execPath, ['scripts/setup-hooks.cjs', ...args], { cwd: w.work, env: env(extra), encoding: 'utf8' });
const shimFile = w => path.join(w.work, '.git', 'hooks', 'pre-push');

/* Puts the scripts a checkout needs (and the shim's source) into the work tree of a throwaway repository, the way a branch carries them. */
function vendor(w, message = 'adds the privacy scripts') {
  const files = {};
  for (const name of ['scripts/pre-push.cjs', 'scripts/privacy-scan.cjs', 'scripts/setup-hooks.cjs', '.githooks/pre-push']) files[name] = fs.readFileSync(path.join(REPO, name));
  return commitFiles(w, files, message);
}

test('.githooks/pre-push is executable, and git tracks it as an executable file', { skip: NO_SH }, () => {
  assert.ok(fs.statSync(SHIM_SOURCE).mode & 0o100, '.githooks/pre-push must be executable');
  const listed = tryGit(REPO, ['ls-files', '--stage', '--', '.githooks/pre-push']);
  if (listed.status === 0 && listed.stdout.trim()) assert.match(listed.stdout, /^100755 /, 'git must track it as an executable file');
  const text = fs.readFileSync(SHIM_SOURCE, 'utf8');
  assert.match(text, /finance-task-studio pre-push shim/);
  assert.doesNotMatch(text, /dirname/, 'the shim does not depend on where the hook file lives');
});

test('npm run setup copies the shim to the common hooks folder, sets no core.hooksPath, and can be run again', { skip: NO_SH }, () => {
  const w = world('setup', { installHook: false });
  w.commit('notes.txt', 'plain text\n', 'baseline');
  vendor(w);
  const first = setupRun(w);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /setup: installed the privacy hook at .*pre-push/);
  assert.equal(fs.readFileSync(shimFile(w), 'utf8'), fs.readFileSync(SHIM_SOURCE, 'utf8'));
  assert.ok(fs.statSync(shimFile(w)).mode & 0o100, 'the installed shim is executable');
  assert.equal(tryGit(w.work, ['config', '--get', 'core.hooksPath']).status, 1, 'core.hooksPath is not set');

  const again = setupRun(w);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /is already up to date/);

  fs.writeFileSync(shimFile(w), '#!/bin/sh\n# finance-task-studio pre-push shim, an older version\nexit 0\n', { mode: 0o755 });
  const updated = setupRun(w);
  assert.equal(updated.status, 0, updated.stdout + updated.stderr);
  assert.match(updated.stdout, /setup: updated the privacy hook/);
  assert.equal(fs.readFileSync(shimFile(w), 'utf8'), fs.readFileSync(SHIM_SOURCE, 'utf8'));

  fs.writeFileSync(shimFile(w), '#!/bin/sh\nexec node scripts/pre-push.cjs "$@"\n', { mode: 0o755 });
  const manual = setupRun(w);
  assert.equal(manual.status, 0, 'the one-line hook the README used to show is replaced without --force: ' + manual.stdout + manual.stderr);
  assert.equal(fs.readFileSync(shimFile(w), 'utf8'), fs.readFileSync(SHIM_SOURCE, 'utf8'));
});

test('setup never overwrites a different pre-push hook unless --force, and then keeps the old one', { skip: NO_SH }, () => {
  const w = world('setup-different', { installHook: false });
  w.commit('notes.txt', 'plain text\n', 'baseline');
  vendor(w);
  const mine = '#!/bin/sh\n# my own checks\nexit 0\n';
  fs.mkdirSync(path.dirname(shimFile(w)), { recursive: true });
  fs.writeFileSync(shimFile(w), mine, { mode: 0o755 });
  const refused = setupRun(w);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /already holds a pre-push hook that is not this one/);
  assert.match(refused.stderr, /npm run setup -- --force/);
  assert.equal(fs.readFileSync(shimFile(w), 'utf8'), mine, 'left alone');
  assert.ok(!fs.existsSync(`${shimFile(w)}.replaced`));

  const forced = setupRun(w, ['--force']);
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  assert.equal(fs.readFileSync(shimFile(w), 'utf8'), fs.readFileSync(SHIM_SOURCE, 'utf8'));
  assert.equal(fs.readFileSync(`${shimFile(w)}.replaced`, 'utf8'), mine, 'the old hook is kept');

  const bad = setupRun(w, ['--bogus']);
  assert.equal(bad.status, 2, bad.stdout + bad.stderr);
});

test('setup unsets core.hooksPath=.githooks and says so, and says plainly when another core.hooksPath will stop the hook running', { skip: NO_SH }, () => {
  const w = world('setup-hookspath', { installHook: false });
  w.commit('notes.txt', 'plain text\n', 'baseline');
  vendor(w);
  git(w.work, ['config', 'core.hooksPath', '.githooks']);
  const unset = setupRun(w);
  assert.equal(unset.status, 0, unset.stdout + unset.stderr);
  assert.match(unset.stdout, /core\.hooksPath was set to \.githooks; it is now unset/);
  assert.equal(tryGit(w.work, ['config', '--get', 'core.hooksPath']).status, 1);
  assert.ok(fs.existsSync(shimFile(w)), 'the shim is installed before the setting goes away');

  git(w.work, ['config', 'core.hooksPath', 'some-other-hooks']);
  const elsewhere = setupRun(w);
  assert.equal(elsewhere.status, 1, elsewhere.stdout + elsewhere.stderr);
  assert.match(elsewhere.stderr, /core\.hooksPath\), not from .*, so the privacy hook will NOT run on push/);
  assert.equal(git(w.work, ['config', '--get', 'core.hooksPath']), 'some-other-hooks', 'a setting that is not ours is never changed');

  git(w.work, ['config', 'core.hooksPath', path.join(w.work, '.git', 'hooks')]);
  const same = setupRun(w);
  assert.equal(same.status, 0, 'a core.hooksPath that is the common hooks folder itself is fine: ' + same.stdout + same.stderr);
});

test('setup refuses unless its folder is itself the top of a git checkout', { skip: NO_SH }, () => {
  const w = world('setup-top', { installHook: false });
  w.commit('notes.txt', 'plain text\n', 'baseline');
  const nested = path.join(w.work, 'copy');
  fs.mkdirSync(path.join(nested, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(nested, '.githooks'));
  fs.copyFileSync(path.join(REPO, 'scripts', 'setup-hooks.cjs'), path.join(nested, 'scripts', 'setup-hooks.cjs'));
  fs.copyFileSync(SHIM_SOURCE, path.join(nested, '.githooks', 'pre-push'));
  const inside = spawnSync(process.execPath, ['scripts/setup-hooks.cjs'], { cwd: nested, env: env(), encoding: 'utf8' });
  assert.equal(inside.status, 1, inside.stdout + inside.stderr);
  assert.match(inside.stderr, /is not the top level of a git checkout, so no hook was installed/);
  assert.ok(!fs.existsSync(shimFile(w)), 'nothing was installed into the repository around it');

  const plain = path.join(scratch, 'plain-copy');
  fs.mkdirSync(path.join(plain, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(plain, '.githooks'));
  fs.copyFileSync(path.join(REPO, 'scripts', 'setup-hooks.cjs'), path.join(plain, 'scripts', 'setup-hooks.cjs'));
  fs.copyFileSync(SHIM_SOURCE, path.join(plain, '.githooks', 'pre-push'));
  const none = spawnSync(process.execPath, ['scripts/setup-hooks.cjs'], { cwd: plain, env: env(), encoding: 'utf8' });
  assert.equal(none.status, 1, none.stdout + none.stderr);
  assert.match(none.stderr, /is not the top level of a git checkout/);
});

test('with the shim installed by setup, a push is scanned: a leak, a binary, a new branch and a clean push', { skip: NO_SH }, () => {
  const w = world('shim-push', { installHook: false });
  w.commit('notes.txt', 'plain text\n', 'baseline');
  vendor(w);
  assert.equal(setupRun(w).status, 0);
  const base = git(w.work, ['rev-parse', 'HEAD']);
  assert.equal(w.push(['origin', 'main']).status, 0, 'a clean push goes through the shim');
  assert.equal(w.remoteHead('main'), base);

  w.commit('notes.txt', `plain text ${TERM}\n`, 'leaks');
  w.commit('notes.txt', 'plain text\n', 'fixes it');
  const leak = w.push(['origin', 'main']);
  assert.notEqual(leak.status, 0, 'stdin and arguments reach the scan, so the range is read from the commits');
  assert.match(leak.stdout + leak.stderr, /HIT notes\.txt/);
  assert.match(leak.stdout + leak.stderr, /Push blocked/);
  assert.equal(w.remoteHead('main'), base);

  git(w.work, ['reset', '-q', '--hard', base]);
  commitFiles(w, { 'memo.docx': PNG }, 'adds a memo');
  const binary = w.push(['origin', 'main']);
  assert.notEqual(binary.status, 0);
  assert.match(binary.stdout + binary.stderr, /BINARY memo\.docx/);

  git(w.work, ['reset', '-q', '--hard', base]);
  git(w.work, ['checkout', '-q', '-b', 'feature']);
  w.commit('other.txt', `fresh ${TERM}\n`, 'leak on a new branch');
  assert.notEqual(w.push(['origin', 'feature']).status, 0, 'the remote name argument reaches the hook');
  assert.equal(w.remoteHead('feature'), null);
});

test('a linked worktree is scanned with the shim and the main checkout\'s term list; an older branch without the scripts is blocked, not skipped', { skip: NO_SH }, () => {
  const w = world('shim-worktree', { installHook: false });
  const base = commitFiles(w, { '.gitignore': '/private/\n', 'notes.txt': 'plain text\n' }, 'baseline: an older state with no privacy scripts');
  assert.equal(w.push(['origin', 'main']).status, 0, 'pushed before any hook exists');
  const oldTree = path.join(scratch, 'shim-worktree', 'old-branch');
  git(w.work, ['worktree', 'add', '-q', oldTree, '-b', 'old']);

  vendor(w);
  fs.mkdirSync(path.join(w.work, 'private'));
  fs.writeFileSync(path.join(w.work, 'private', 'privacy-terms.txt'), `# synthetic\n${TERM}\n`);
  assert.equal(setupRun(w).status, 0);
  const newTree = path.join(scratch, 'shim-worktree', 'new-branch');
  git(w.work, ['worktree', 'add', '-q', newTree, '-b', 'new']);
  assert.ok(!fs.existsSync(path.join(newTree, 'private')), 'the worktree has no private folder of its own');

  /* No FINANCE_PRIVACY_TERMS: the term list comes from the main checkout. */
  const push = (dir, args) => tryGit(dir, ['push', ...args], { FINANCE_PRIVACY_TERMS: '' });
  fs.writeFileSync(path.join(newTree, 'fresh.txt'), 'a clean change\n');
  git(newTree, ['add', '-A']);
  git(newTree, ['commit', '-q', '-m', 'clean change in the worktree']);
  const clean = push(newTree, ['origin', 'new']);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.ok(w.remoteHead('new'));

  fs.writeFileSync(path.join(newTree, 'fresh.txt'), `a leak ${TERM}\n`);
  git(newTree, ['add', '-A']);
  git(newTree, ['commit', '-q', '-m', 'leak in the worktree']);
  const leak = push(newTree, ['origin', 'new']);
  assert.notEqual(leak.status, 0, 'the worktree is scanned with the main checkout\'s terms: ' + leak.stdout + leak.stderr);
  assert.match(leak.stdout + leak.stderr, /HIT fresh\.txt/);
  assert.doesNotMatch(leak.stdout + leak.stderr, /no privacy term list/);

  fs.writeFileSync(path.join(oldTree, 'older.txt'), 'a change on an older branch\n');
  git(oldTree, ['add', '-A']);
  git(oldTree, ['commit', '-q', '-m', 'change on the older branch']);
  assert.ok(!fs.existsSync(path.join(oldTree, 'scripts', 'pre-push.cjs')), 'the older branch does not have the scripts');
  const older = push(oldTree, ['origin', 'old']);
  assert.notEqual(older.status, 0, 'a checkout without the scripts fails closed: ' + older.stdout + older.stderr);
  assert.match(older.stderr, /scripts\/pre-push\.cjs does not exist \(an older branch\?\).*Push blocked/);
  assert.match(older.stderr, /update this checkout to a commit that has scripts\/pre-push\.cjs/);
  assert.equal(w.remoteHead('old'), null);
  assert.equal(base.length, 40);
});

test('the shim passes its arguments and standard input to scripts/pre-push.cjs and returns its exit code, and fails closed without node, a work tree or the script', { skip: NO_SH }, () => {
  const checkout = path.join(scratch, 'shim-stub');
  fs.mkdirSync(path.join(checkout, 'scripts'), { recursive: true });
  git(checkout, ['init', '-q']);
  fs.writeFileSync(path.join(checkout, 'scripts', 'pre-push.cjs'), [
    "let input = '';",
    "process.stdin.setEncoding('utf8').on('data', c => { input += c; }).on('end', () => {",
    "  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input, cwd: process.cwd() }));",
    "  process.exitCode = 7;",
    '});',
  ].join('\n'));
  const lines = `refs/heads/x ${A} refs/heads/x ${B}\n`;
  const run = spawnSync('/bin/sh', [SHIM_SOURCE, 'origin', 'file:///somewhere'], { cwd: checkout, env: env(), encoding: 'utf8', input: lines });
  assert.equal(run.status, 7, "the scan script's exit code is the hook's: " + run.stdout + run.stderr);
  const seen = JSON.parse(run.stdout);
  assert.deepEqual(seen.argv, ['origin', 'file:///somewhere']);
  assert.equal(seen.input, lines);

  /* Run from a subfolder (as git never does, but the shim must still find the top). */
  fs.mkdirSync(path.join(checkout, 'sub'));
  const sub = spawnSync('/bin/sh', [SHIM_SOURCE, 'origin'], { cwd: path.join(checkout, 'sub'), env: env(), encoding: 'utf8', input: '' });
  assert.equal(sub.status, 7, sub.stdout + sub.stderr);

  const noNode = spawnSync('/bin/sh', [SHIM_SOURCE, 'origin', 'url'], { encoding: 'utf8', input: '', env: { PATH: path.join(scratch, 'no-such-bin') } });
  assert.equal(noNode.status, 1, noNode.stdout + noNode.stderr);
  assert.match(noNode.stderr, /node was not found.*Push blocked/);

  const outside = path.join(scratch, 'not-a-work-tree');
  fs.mkdirSync(outside);
  const noTree = spawnSync('/bin/sh', [SHIM_SOURCE, 'origin'], { cwd: outside, env: env(), encoding: 'utf8', input: '' });
  assert.equal(noTree.status, 1, noTree.stdout + noTree.stderr);
  assert.match(noTree.stderr, /could not find the top of this work tree.*Push blocked/);

  fs.rmSync(path.join(checkout, 'scripts', 'pre-push.cjs'));
  const noScript = spawnSync('/bin/sh', [SHIM_SOURCE, 'origin'], { cwd: checkout, env: env(), encoding: 'utf8', input: '' });
  assert.equal(noScript.status, 1, noScript.stdout + noScript.stderr);
  assert.match(noScript.stderr, /scripts\/pre-push\.cjs does not exist.*Push blocked/);
});

test('the very first push of a repository is checked for binary files too', () => {
  const w = world('binary-first-push');
  commitFiles(w, { 'readme.txt': 'plain text\n', 'task.pdf': PNG }, 'first commit with a pdf');
  const blocked = w.push(['origin', 'main']);
  assert.notEqual(blocked.status, 0, blocked.stdout + blocked.stderr);
  assert.match(blocked.stdout + blocked.stderr, /BINARY task\.pdf \(tracked; added or changed in /);
  assert.equal(w.remoteHead('main'), null, 'nothing reached the remote');
});
