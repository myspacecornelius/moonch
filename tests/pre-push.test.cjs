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
