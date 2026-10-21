'use strict';
/* Checks on what git will and will not offer, using the repository's own .gitignore. Nothing here reads private/. */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const scanner = require('../scripts/privacy-scan.cjs');

const root = path.resolve(__dirname, '..');
const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
const hasGit = git(['rev-parse', '--is-inside-work-tree']).status === 0;
const ignored = name => git(['check-ignore', '-q', '--', name]).status === 0;
/* The rule that ignores a path, taken from the repository's own .gitignore only: .git/info/exclude and a global ignore file are
   machine-local and must not make the test pass. --no-index judges the path by the rules alone, tracked or not. */
const ignoredBy = name => {
  const run = git(['check-ignore', '--no-index', '-v', '--', name]);
  const match = run.status === 0 ? /^([^:]+):\d+:([^\t]*)\t/.exec(run.stdout) : null;
  /* With -v git also prints the negated pattern that un-ignores a path; that path is not ignored. */
  return match && !match[2].startsWith('!') ? { source: match[1], pattern: match[2] } : null;
};
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const trackedFiles = () => git(['ls-files', '-z']).stdout.split('\0').filter(Boolean);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-hygiene-test-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const hermetic = (extra = {}) => ({
  PATH: process.env.PATH, HOME: scratch, XDG_CONFIG_HOME: scratch, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...extra,
});
const inRepo = (dir, args, extra) => spawnSync('git', args, { cwd: dir, env: hermetic(extra), encoding: 'utf8' });
let counter = 0;
const freshDir = label => {
  counter += 1;
  const dir = path.join(scratch, label + '-' + counter);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
function newRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const args of [['init', '-q'], ['config', 'user.name', 'Test Writer'], ['config', 'user.email', 'writer@example.invalid'], ['config', 'commit.gpgsign', 'false']]) {
    assert.equal(inRepo(dir, args).status, 0, args.join(' '));
  }
  return dir;
}
function put(dir, rel, content, mode) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, mode ? { mode } : undefined);
  if (mode) fs.chmodSync(full, mode);
}

test('files the app downloads with private material are ignored wherever they land', { skip: hasGit ? false : 'not a git work tree' }, () => {
  const agents = fs.readFileSync(path.join(root, 'agents.js'), 'utf8');
  assert.ok(/'Finance_Agent_Round_'\+S\.round\.id\+'_PRIVATE\.json'/.test(agents), 'the name agents.js gives the round download');
  for (const name of [
    'Finance_Agent_Round_rnd-0123456789ab_PRIVATE.json',
    'Finance_Task_Analysis_PRIVATE.json',
    'Finance_Task_Analysis_Results_PRIVATE.txt',
    'Downloads/Finance_Agent_Round_rnd-0123456789ab_PRIVATE.json',
    'qa/agents/Finance_Agent_Round_rnd-0123456789ab_PRIVATE.json',
  ]) assert.ok(ignored(name), name + ' must be ignored');
  for (const name of ['private/agent-rounds/rnd-0123456789ab/round.json', 'LOCAL_SERVER.json', 'private/privacy-terms.txt']) assert.ok(ignored(name), name + ' must stay ignored');
  for (const name of ['README.md', 'agents.js', 'scripts/pre-push.cjs', 'tests/repo-hygiene.test.cjs']) assert.ok(!ignored(name), name + ' must not be ignored');
});

test('no tracked file carries the private download suffix', { skip: hasGit ? false : 'not a git work tree' }, () => {
  const tracked = git(['ls-files', '-z']).stdout.split('\0').filter(Boolean);
  assert.deepEqual(tracked.filter(name => /[_-]PRIVATE\./.test(name)), []);
});

/* ------------------------------------------------------------------ .gitignore */

test('the private download names, task documents, the project download, scratch folders and the manifest are ignored by .gitignore itself', { skip: hasGit ? false : 'not a git work tree' }, () => {
  for (const name of [
    'T-evaluator-draft-PRIVATE.json',
    'T-failure-modes-PRIVATE.txt',
    'T-working-document-PRIVATE.md',
    'x-assistant-request-PRIVATE.json',
    'Finance_Task_Analysis_PRIVATE.json',
    'Downloads/Some-Task-evaluator-draft-PRIVATE.json',
    'T-project.json',
    'Some-Task-project.json',
    'task.xlsx',
    'task.xlsm',
    'task.xls',
    'memo.docx',
    'memo.doc',
    'Task Package.pdf',
    'packet.zip',
    'deck.pptx',
    'nested/folder/packet.zip',
    'tmp/x',
    '.claude/settings.local.json',
    'FILEBASE_MANIFEST.json',
  ]) {
    const rule = ignoredBy(name);
    assert.ok(rule, name + ' must be ignored');
    assert.equal(rule.source, '.gitignore', name + ' must be ignored by the repository .gitignore (matched ' + rule.source + ')');
  }
});

test('tests/fixtures keeps its synthetic documents, but private downloads stay ignored there too', { skip: hasGit ? false : 'not a git work tree' }, () => {
  for (const name of ['tests/fixtures/package.zip', 'tests/fixtures/sample.xlsx', 'tests/fixtures/nested/memo.docx']) {
    assert.equal(git(['check-ignore', '--no-index', '-q', '--', name]).status, 1, name + ' must not be ignored');
  }
  assert.equal(git(['check-ignore', '-q', '--', 'tests/fixtures/package.zip']).status, 1, 'the tracked fixture is not ignored');
  for (const name of ['tests/fixtures/x-evaluator-draft-PRIVATE.json', 'tests/fixtures/Finance_Task_Analysis_PRIVATE.json', 'tests/fixtures/T-project.json']) {
    assert.ok(ignoredBy(name), name + ' must stay ignored inside tests/fixtures');
  }
  for (const name of ['README.md', 'package.json', 'scripts/binary-allowlist.txt', '.githooks/pre-push', 'tests/fixtures/package.zip', 'qa/dashboard/desktop-overview.png']) {
    assert.equal(git(['check-ignore', '--no-index', '-q', '--', name]).status, 1, name + ' must not be ignored');
  }
});

test('git tracks nothing that .gitignore ignores, and no tracked file is a private or project download', { skip: hasGit ? false : 'not a git work tree' }, () => {
  const listed = git(['ls-files', '-z', '--cached', '--ignored', '--exclude-standard']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.split('\0').filter(Boolean), [], 'tracked files that match an ignore rule (FILEBASE_MANIFEST.json must be removed from the index)');
  assert.deepEqual(trackedFiles().filter(name => /(?:^|\/)[^/]*-project\.json$/.test(name) || /\.(?:xlsx|xlsm|xls|docx|doc|pdf|pptx)$/i.test(name)), []);
});

test('.gitignore keeps no whitelist line for a screenshot that is not tracked, and none for folders that do not exist', { skip: hasGit ? false : 'not a git work tree' }, () => {
  const lines = read('.gitignore').split('\n');
  const negations = lines.filter(line => /^!qa\//.test(line)).map(line => line.slice(1));
  const tracked = new Set(trackedFiles());
  assert.ok(negations.length > 0);
  for (const name of negations) assert.ok(tracked.has(name), name + ' is whitelisted in .gitignore but not tracked');
  assert.ok(!lines.some(line => /qa\/(?:mission|workbench)/.test(line)), 'qa/mission and qa/workbench do not exist');
  for (const rule of ['*[_-]PRIVATE.*', '*-project.json', '/tmp/', '/.claude/settings.local.json', '/FILEBASE_MANIFEST.json']) assert.ok(lines.includes(rule), rule + ' is in .gitignore');
  assert.ok(!lines.includes('*_PRIVATE.*'), 'the underscore-only rule is replaced');
  assert.ok(lines.indexOf('!tests/fixtures/**') < lines.indexOf('*[_-]PRIVATE.*'), 'the fixtures exception comes before the private rules so that they win');
});

/* ------------------------------------------------------------------ binary files */

test('every tracked binary file is on scripts/binary-allowlist.txt, and every allowlist entry is a tracked file', { skip: hasGit ? false : 'not a git work tree' }, () => {
  const allowed = scanner.parseAllowlist(read('scripts/binary-allowlist.txt'));
  const tracked = trackedFiles();
  const binary = tracked.filter(name => {
    const full = path.join(root, name);
    let stat;
    try { stat = fs.lstatSync(full); } catch { return false; }
    if (!stat.isFile()) return false;
    const fd = fs.openSync(full, 'r');
    try {
      const head = Buffer.alloc(8 * 1024);
      return scanner.decodeText(head.subarray(0, fs.readSync(fd, head, 0, head.length, 0))) === null;
    } finally { fs.closeSync(fd); }
  });
  assert.deepEqual(binary.filter(name => !allowed.has(name)), [], 'tracked binary files that are not on the allowlist');
  assert.deepEqual([...allowed].filter(name => !tracked.includes(name)), [], 'allowlist entries that are not tracked files');
  assert.ok(allowed.has('tests/fixtures/package.zip'));
  for (const name of allowed) assert.ok(/^(?:qa\/.+\.png|tests\/fixtures\/.+)$/.test(name), name + ' is neither a retained screenshot nor a test fixture');
});

/* ------------------------------------------------------------------ package.json */

test('package.json: setup installs the versioned hook, build has no python, package builds the archive, dead scripts are gone', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.setup, 'git config core.hooksPath .githooks');
  assert.equal(pkg.scripts.build, 'node scripts/build-catalog.cjs && node scripts/build-standalone.cjs');
  assert.equal(pkg.scripts.package, 'python3 scripts/package-filebase.py');
  assert.equal(pkg.engines.node, '>=22');
  for (const name of ['test:mission', 'test:workbench']) assert.ok(!(name in pkg.scripts), name + ' points at a file that does not exist');
  assert.doesNotMatch(Object.values(pkg.scripts).join('\n'), /--manifest-only|FILEBASE_MANIFEST/);
  for (const [name, command] of Object.entries(pkg.scripts)) {
    for (const file of command.match(/(?:tests|scripts)\/[\w.-]+\.(?:cjs|py)/g) || []) assert.ok(fs.existsSync(path.join(root, file)), name + ' runs ' + file + ', which does not exist');
  }
});

/* ------------------------------------------------------------------ the launcher's privacy hook check */

const LAUNCHER = 'Start Finance Task Studio.command';
function hookCheckBlock() {
  const text = read(LAUNCHER);
  const begin = text.indexOf('# privacy-hook-check:begin\n');
  const end = text.indexOf('# privacy-hook-check:end\n');
  assert.ok(begin > 0 && end > begin, 'the launcher marks its privacy hook check');
  assert.ok(end < text.indexOf('exec "$studio_node"'), 'the check runs before the companion starts');
  return text.slice(begin, end);
}
const runHookCheck = dir => spawnSync('/bin/sh', ['-e', '-c', hookCheckBlock()], { cwd: dir, env: hermetic(), encoding: 'utf8' });
const WARNING = 'Privacy hook not installed: run npm run setup once\n';

test('the launcher warns once when neither core.hooksPath=.githooks nor a pre-push hook is set up, and is quiet otherwise', { skip: process.platform === 'win32' ? 'no sh' : false }, () => {
  const dir = newRepo(freshDir('launcher'));
  const none = runHookCheck(dir);
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout, WARNING, 'no hook of any kind');

  assert.equal(inRepo(dir, ['config', 'core.hooksPath', 'somewhere-else']).status, 0);
  assert.equal(runHookCheck(dir).stdout, WARNING, 'another hooks folder with no pre-push hook in .git/hooks');

  assert.equal(inRepo(dir, ['config', 'core.hooksPath', '.githooks']).status, 0);
  assert.equal(runHookCheck(dir).stdout, '', 'the versioned hook folder is set');
  assert.equal(inRepo(dir, ['config', 'core.hooksPath', '.githooks/']).status, 0);
  assert.equal(runHookCheck(dir).stdout, '', 'a trailing slash is the same folder');

  assert.equal(inRepo(dir, ['config', '--unset', 'core.hooksPath']).status, 0);
  put(dir, '.git/hooks/pre-push', '#!/bin/sh\nexec node scripts/pre-push.cjs "$@"\n', 0o755);
  assert.equal(runHookCheck(dir).stdout, '', 'the manual hook in .git/hooks');
});

test('the launcher says nothing outside a git work tree, such as an unpacked copy', { skip: process.platform === 'win32' ? 'no sh' : false }, () => {
  const dir = freshDir('launcher-copy');
  const run = runHookCheck(dir);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, '');
});

test('the launcher stays executable and still starts the companion last', () => {
  assert.ok(fs.statSync(path.join(root, LAUNCHER)).mode & 0o100, LAUNCHER + ' must be executable');
  const text = read(LAUNCHER);
  assert.ok(text.trimEnd().endsWith('exec "$studio_node" backend/server.cjs --open'));
  assert.ok(text.includes('Privacy hook not installed: run npm run setup once'));
});

/* ------------------------------------------------------------------ scripts/package-filebase.py */

const hasPython = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;
const skipPython = hasPython && hasGit ? false : 'python3 or git not available';
const PACKAGER = path.join(root, 'scripts', 'package-filebase.py');

/* A throwaway repository that holds a copy of the packager, inside a folder of its own because the ZIPs are written next to the repository. */
function packagerRepo(label) {
  const outer = freshDir(label);
  const dir = newRepo(path.join(outer, 'repo'));
  put(dir, 'scripts/package-filebase.py', fs.readFileSync(PACKAGER));
  put(dir, 'index.html', '<p>Atlas</p>\n');
  put(dir, 'Start Finance Task Studio.command', '#!/bin/zsh\n', 0o755);
  put(dir, 'docs/guide.md', 'Meridian\n');
  put(dir, '.gitignore', 'ignored-output.txt\n');
  const commit = message => {
    assert.equal(inRepo(dir, ['add', '-A', '-f']).status, 0);
    assert.equal(inRepo(dir, ['commit', '-q', '-m', message]).status, 0);
  };
  const run = (...args) => spawnSync('python3', ['-I', path.join(dir, 'scripts', 'package-filebase.py'), ...args], { cwd: dir, env: hermetic(), encoding: 'utf8' });
  return { outer, dir, commit, run };
}
const manifestOf = dir => JSON.parse(fs.readFileSync(path.join(dir, 'FILEBASE_MANIFEST.json'), 'utf8'));

test('package-filebase.py lists only the files git tracks: untracked, ignored and private files never reach the manifest or the ZIPs', { skip: skipPython }, () => {
  const p = packagerRepo('packager');
  p.commit('tracked files');
  put(p.dir, 'untracked-notes.txt', 'not committed\n');
  put(p.dir, 'ignored-output.txt', 'ignored\n');
  put(p.dir, 'private/evidence-module.js', 'private\n');
  put(p.dir, 'qa/scratch/downloads/export.json', '{}\n');
  put(p.dir, 'FILEBASE_MANIFEST.json', '{"stale":true}\n');
  const run = p.run();
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const names = manifestOf(p.dir).files.map(entry => entry.file);
  assert.deepEqual(names, ['.gitignore', 'Start Finance Task Studio.command', 'docs/guide.md', 'index.html', 'scripts/package-filebase.py']);
  assert.ok(manifestOf(p.dir).files.every(entry => /^[0-9a-f]{64}$/.test(entry.sha256) && entry.bytes > 0));

  for (const zip of ['Finance_Task_Studio.zip', 'Finance_Task_Studio_Filebase.zip']) {
    const listing = spawnSync('python3', ['-I', '-c', 'import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nfor i in z.infolist(): print("%o %s" % (i.external_attr >> 16, i.filename))', path.join(p.outer, zip)], { encoding: 'utf8' });
    assert.equal(listing.status, 0, listing.stderr);
    const entries = listing.stdout.trim().split('\n');
    assert.ok(entries.every(line => / finance-task-studio\//.test(line)), 'every entry sits under finance-task-studio/');
    assert.doesNotMatch(listing.stdout, /finance-trap-studio/);
    assert.ok(entries.includes('100755 finance-task-studio/Start Finance Task Studio.command'), 'the launcher keeps its executable bit');
    assert.ok(entries.includes('100644 finance-task-studio/index.html'));
    assert.ok(entries.some(line => line.endsWith(' finance-task-studio/FILEBASE_MANIFEST.json')), 'the freshly written manifest is in the ZIP');
    assert.doesNotMatch(listing.stdout, /untracked-notes|ignored-output|private|downloads/);
  }
});

test('package-filebase.py --manifest-only writes the manifest and no ZIP, and never lists a tracked manifest in itself', { skip: skipPython }, () => {
  const p = packagerRepo('packager-manifest');
  put(p.dir, 'FILEBASE_MANIFEST.json', '{"stale":true}\n');
  p.commit('tracked files, including a stale manifest');
  const run = p.run('--manifest-only');
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.ok(!manifestOf(p.dir).files.some(entry => entry.file === 'FILEBASE_MANIFEST.json'));
  assert.deepEqual(fs.readdirSync(p.outer).sort(), ['repo']);
});

test('package-filebase.py refuses a tracked file with private in its name, a forbidden folder, a missing file, or an empty repository', { skip: skipPython }, () => {
  for (const [label, rel] of [
    ['name', 'docs/Task-Private-Notes.md'],
    ['name-lower', 'docs/private.txt'],
    ['folder', 'PRIVATE/notes.txt'],
    ['runtime', 'model-runs/run-1.json'],
    ['downloads', 'qa/downloads/export.json'],
  ]) {
    const p = packagerRepo('refuse-' + label);
    put(p.dir, rel, 'x\n');
    p.commit('tracks a file it should not');
    const run = p.run('--manifest-only');
    assert.notEqual(run.status, 0, rel + ': ' + run.stdout);
    assert.match(run.stderr, /Private or runtime payload in package/);
    assert.ok(!fs.existsSync(path.join(p.dir, 'FILEBASE_MANIFEST.json')), 'no manifest is written for a refused package');
  }
  const missing = packagerRepo('refuse-missing');
  missing.commit('tracked files');
  fs.rmSync(path.join(missing.dir, 'docs', 'guide.md'));
  const gone = missing.run('--manifest-only');
  assert.notEqual(gone.status, 0);
  assert.match(gone.stderr, /Tracked file missing from the work tree/);

  const empty = packagerRepo('refuse-empty');
  const none = empty.run('--manifest-only');
  assert.notEqual(none.status, 0, 'nothing is tracked yet');
  assert.match(none.stderr, /git ls-files listed nothing/);
});

test('package-filebase.py is not fooled by GIT_DIR in the environment (a hook sets it)', { skip: skipPython }, () => {
  const other = newRepo(freshDir('other-repo'));
  put(other, 'wrong.txt', 'wrong\n');
  assert.equal(inRepo(other, ['add', '-A']).status, 0);
  const p = packagerRepo('packager-gitdir');
  p.commit('tracked files');
  const run = spawnSync('python3', ['-I', path.join(p.dir, 'scripts', 'package-filebase.py'), '--manifest-only'], {
    cwd: p.dir, env: hermetic({ GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other }), encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.ok(!manifestOf(p.dir).files.some(entry => entry.file === 'wrong.txt'));
});

test('the packager in the repository reads git ls-files and writes the finance-task-studio prefix', () => {
  const text = read('scripts/package-filebase.py');
  assert.match(text, /'ls-files'/);
  assert.match(text, /ARCHIVE_PREFIX = 'finance-task-studio\/'/);
  assert.doesNotMatch(text, /finance-trap-studio|rglob/);
  assert.ok(!trackedFiles().includes('FILEBASE_MANIFEST.json'), 'the manifest is rebuilt per machine and is not versioned');
});
