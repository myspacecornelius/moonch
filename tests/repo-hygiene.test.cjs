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

/* Formats that carry task documents, packages, archives and data exports. .gitignore ignores each in any letter case. */
const DOCUMENT_EXTENSIONS = [
  'xlsx', 'xlsm', 'xlsb', 'xls', 'xltx', 'xltm', 'docx', 'docm', 'doc', 'dotx', 'pdf', 'zip', 'pptx', 'pptm', 'ppt', 'odt', 'ods', 'odp',
  'rtf', 'numbers', 'pages', 'key', '7z', 'rar', 'gz', 'csv',
];

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
  for (const name of ['private/agent-rounds/rnd-0123456789ab/round.json', 'LOCAL_SERVER.json', 'LOCAL_SERVER.lock', 'private/privacy-terms.txt']) assert.ok(ignored(name), name + ' must stay ignored');
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
    'Task.XLSX',
    'a/b.Pdf',
    'x.xlsb',
    'x.xltx',
    'x.xltm',
    'x.docm',
    'x.dotx',
    'x.pptm',
    'x.odt',
    'x.ods',
    'x.rtf',
    'x.numbers',
    'x.pages',
    'x.key',
    'x.7z',
    'x.RAR',
    'x.gz',
    'export.csv',
    'Data/EXPORT.CSV',
    'T-Project.json',
    'T-PROJECT.JSON',
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
  assert.deepEqual(trackedFiles().filter(name => !name.startsWith('tests/fixtures/') && (/-project\.json$/i.test(name) || DOCUMENT_EXTENSIONS.some(ext => name.toLowerCase().endsWith('.' + ext)))), [], 'tracked documents or project downloads outside tests/fixtures');
});

test('.gitignore keeps no whitelist line for a screenshot that is not tracked, and none for folders that do not exist', { skip: hasGit ? false : 'not a git work tree' }, () => {
  const lines = read('.gitignore').split('\n');
  const negations = lines.filter(line => /^!qa\//.test(line)).map(line => line.slice(1));
  const tracked = new Set(trackedFiles());
  assert.ok(negations.length > 0);
  for (const name of negations) assert.ok(tracked.has(name), name + ' is whitelisted in .gitignore but not tracked');
  assert.ok(!lines.some(line => /qa\/(?:mission|workbench)/.test(line)), 'qa/mission and qa/workbench do not exist');
  for (const rule of ['*[_-]PRIVATE.*', '*-[pP][rR][oO][jJ][eE][cC][tT].[jJ][sS][oO][nN]', '/tmp/', '/.claude/settings.local.json', '/FILEBASE_MANIFEST.json', '/LOCAL_SERVER.lock*']) assert.ok(lines.includes(rule), rule + ' is in .gitignore');
  assert.ok(!lines.includes('*_PRIVATE.*') && !lines.includes('*-project.json'), 'the case-sensitive rules are replaced');
  for (const ext of DOCUMENT_EXTENSIONS) {
    const rule = '*.' + [...ext].map(c => (/[a-z]/i.test(c) ? '[' + c.toLowerCase() + c.toUpperCase() + ']' : c)).join('');
    assert.ok(lines.includes(rule), rule + ' (any letter case of .' + ext + ') is in .gitignore');
  }
  assert.ok(lines.indexOf('!tests/fixtures/**') < lines.indexOf('*[_-]PRIVATE.*'), 'the fixtures exception comes before the private rules so that they win');
});

/* ------------------------------------------------------------------ binary files */

test('every tracked binary file is on scripts/binary-allowlist.txt with the content its entry asks for, and every entry is a tracked file', { skip: hasGit ? false : 'not a git work tree' }, () => {
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
      return scanner.decodeText(head.subarray(0, fs.readSync(fd, head, 0, head.length, 0)), { partial: true }) === null;
    } finally { fs.closeSync(fd); }
  });
  assert.deepEqual(binary.filter(name => !allowed.has(name)), [], 'tracked binary files that are not on the allowlist');
  assert.deepEqual([...allowed.keys()].filter(name => !tracked.includes(name)), [], 'allowlist entries that are not tracked files');
  assert.ok(allowed.has('tests/fixtures/package.zip'));
  assert.ok(allowed.get('tests/fixtures/package.zip').sha256, 'the fixture zip is pinned by sha256');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const [name, entry] of allowed) {
    assert.ok(/^(?:qa\/.+\.png|tests\/fixtures\/.+)$/.test(name), name + ' is neither a retained screenshot nor a test fixture');
    const bytes = fs.readFileSync(path.join(root, name));
    if (name.endsWith('.png')) assert.ok(bytes.subarray(0, 8).equals(png), name + ' is not a PNG');
    else assert.ok(entry.sha256, name + ' is not a screenshot, so its entry must carry a sha256 pin');
    if (entry.sha256) assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'), entry.sha256, name + ' differs from its pin');
  }
});

/* ------------------------------------------------------------------ package.json */

test('package.json: setup installs the shim without core.hooksPath, build has no python, package builds the archive, dead scripts are gone', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.setup, 'node scripts/setup-hooks.cjs');
  assert.doesNotMatch(Object.values(pkg.scripts).join('\n'), /hooksPath/);
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

const NO_SH = process.platform === 'win32' ? 'no sh' : false;

/* A pre-push hook file in the common hooks folder, as `npm run setup` leaves it. */
function installShim(dir) {
  put(dir, '.git/hooks/pre-push', fs.readFileSync(path.join(root, '.githooks', 'pre-push')), 0o755);
}

test('the launcher warns when this checkout has no pre-push hook where git looks for it, and is quiet otherwise', { skip: NO_SH }, () => {
  const dir = newRepo(freshDir('launcher'));
  const none = runHookCheck(dir);
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout, WARNING, 'no hook of any kind');

  installShim(dir);
  assert.equal(runHookCheck(dir).stdout, '', 'the shim in the common hooks folder, as npm run setup installs it');
  fs.rmSync(path.join(dir, '.git', 'hooks', 'pre-push'));
  assert.equal(runHookCheck(dir).stdout, WARNING);
});

test('the launcher follows core.hooksPath: a folder without pre-push warns, a folder with one does not', { skip: NO_SH }, () => {
  const dir = newRepo(freshDir('launcher-hookspath'));
  installShim(dir);
  assert.equal(inRepo(dir, ['config', 'core.hooksPath', 'somewhere-else']).status, 0);
  assert.equal(runHookCheck(dir).stdout, WARNING, 'git would look in somewhere-else, which has no pre-push, whatever .git/hooks holds');

  assert.equal(inRepo(dir, ['config', 'core.hooksPath', '.githooks']).status, 0);
  assert.equal(runHookCheck(dir).stdout, WARNING, 'an older branch has no .githooks folder: the setting of an earlier setup protects nothing there');
  put(dir, '.githooks/pre-push', '#!/bin/sh\nexit 0\n', 0o755);
  assert.equal(runHookCheck(dir).stdout, '', 'a branch that has the folder');
  assert.equal(inRepo(dir, ['config', 'core.hooksPath', '.githooks/']).status, 0);
  assert.equal(runHookCheck(dir).stdout, '', 'a trailing slash is the same folder');
});

test('the launcher looks in the common hooks folder of a linked worktree', { skip: NO_SH }, () => {
  const dir = newRepo(freshDir('launcher-main'));
  put(dir, 'readme.txt', 'Atlas\n');
  assert.equal(inRepo(dir, ['add', '-A']).status, 0);
  assert.equal(inRepo(dir, ['commit', '-q', '-m', 'initial']).status, 0);
  const worktree = path.join(freshDir('launcher-worktrees'), 'wt');
  assert.equal(inRepo(dir, ['worktree', 'add', '-q', worktree, '-b', 'side']).status, 0);
  assert.ok(fs.statSync(path.join(worktree, '.git')).isFile(), 'a linked worktree has a .git file');
  assert.equal(runHookCheck(fs.realpathSync(worktree)).stdout, WARNING, 'no shim yet');
  installShim(dir);
  assert.equal(runHookCheck(fs.realpathSync(worktree)).stdout, '', 'the shim in the main checkout\'s .git/hooks serves the worktree');
});

test('the launcher runs no git and says nothing when this folder is not itself the top of a git checkout', { skip: NO_SH }, () => {
  /* A stand-in git that records every call, so that "no git is run" can be asserted. */
  const bin = freshDir('launcher-bin');
  const log = path.join(bin, 'calls.log');
  put(bin, 'git', `#!/bin/sh\necho "$*" >> "${log}"\nexec ${JSON.stringify(spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim())} "$@"\n`, 0o755);
  const run = dir => spawnSync('/bin/sh', ['-e', '-c', hookCheckBlock()], { cwd: dir, env: hermetic({ PATH: bin + path.delimiter + process.env.PATH }), encoding: 'utf8' });

  const copy = fs.realpathSync(freshDir('launcher-copy'));
  const plain = run(copy);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout + plain.stderr, '');
  assert.ok(!fs.existsSync(log), 'a folder with no .git entry runs no git: ' + (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''));

  /* A folder with a .git entry that git does not accept, inside another repository, must not be judged by that repository. */
  const outer = newRepo(path.join(fs.realpathSync(freshDir('launcher-outer')), 'repo'));
  put(outer, 'readme.txt', 'Atlas\n');
  assert.equal(inRepo(outer, ['add', '-A']).status, 0);
  assert.equal(inRepo(outer, ['commit', '-q', '-m', 'initial']).status, 0);
  const inner = path.join(outer, 'unpacked');
  fs.mkdirSync(path.join(inner, '.git'), { recursive: true });
  const nested = run(inner);
  assert.equal(nested.status, 0, nested.stderr);
  assert.equal(nested.stdout + nested.stderr, '', 'the outer repository has no pre-push hook, but it is not this checkout');
  assert.ok(fs.existsSync(log), 'git was asked, because a .git entry exists, and its answer (the outer top level) was refused');
  assert.equal(run(outer).stdout, WARNING, 'the outer repository itself is a checkout without a hook');
});

test('the launcher check runs before the companion and uses only POSIX shell', () => {
  const block = hookCheckBlock();
  assert.doesNotMatch(block, /\[\[|\$\{[^}]*:[AaHhTt]\}/, 'no zsh-only syntax inside the marked block');
  assert.match(block, /\[ -e \.git \]/);
  assert.match(block, /pwd -P/);
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

const NO_LINKS = process.platform === 'win32' ? 'no symlinks' : false;

test('package-filebase.py refuses a tracked symlink, to a private file, to a file outside the repository, to a folder, or dangling', { skip: skipPython || NO_LINKS }, () => {
  const outside = path.join(freshDir('outside'), 'secret.txt');
  fs.writeFileSync(outside, 'outside the repository\n');
  for (const [label, link, target, make] of [
    ['private', 'docs/notes.txt', '../private/secret.txt', dir => put(dir, 'private/secret.txt', 'private\n')],
    ['outside', 'docs/outside.txt', outside, () => {}],
    ['inside', 'docs/alias.md', 'guide.md', () => {}],
    ['dangling', 'docs/gone.txt', 'no-such-file.txt', () => {}],
    ['folder', 'linked-docs', 'docs', () => {}],
    ['folder-to-private', 'pub', 'private', dir => put(dir, 'private/secret.txt', 'private\n')],
  ]) {
    const p = packagerRepo('symlink-' + label);
    put(p.dir, 'docs/guide.md', 'Meridian\n');
    fs.mkdirSync(path.dirname(path.join(p.dir, link)), { recursive: true });
    fs.symlinkSync(target, path.join(p.dir, link));
    p.commit('tracks a link');
    make(p.dir); /* the private file exists only after the commit, as in real life: git does not track it */
    for (const args of [['--manifest-only'], []]) {
      const run = p.run(...args);
      assert.notEqual(run.status, 0, `${label}: ${run.stdout}`);
      assert.match(run.stderr, /package-filebase: Symlink in package/, label + ': ' + run.stderr);
      assert.doesNotMatch(run.stderr, /Traceback/);
    }
    assert.ok(!fs.existsSync(path.join(p.dir, 'FILEBASE_MANIFEST.json')), label + ': no manifest is written');
    assert.deepEqual(fs.readdirSync(p.outer).sort(), ['repo'], label + ': no ZIP is written');
  }
});

test('package-filebase.py refuses a path that runs through a symlinked folder, and a manifest path that is a symlink', { skip: skipPython || NO_LINKS }, () => {
  const p = packagerRepo('symlink-parent');
  p.commit('tracked files');
  const target = freshDir('elsewhere');
  fs.writeFileSync(path.join(target, 'x.md'), 'x\n');
  fs.rmSync(path.join(p.dir, 'docs'), { recursive: true });
  fs.symlinkSync(target, path.join(p.dir, 'docs'));
  const viaFolder = p.run('--manifest-only');
  assert.notEqual(viaFolder.status, 0);
  assert.match(viaFolder.stderr, /package-filebase: (?:Symlink in package|Path goes through a symlink|Path leaves the repository|Tracked file missing)/);

  const q = packagerRepo('symlink-manifest');
  q.commit('tracked files');
  fs.symlinkSync(path.join(target, 'x.md'), path.join(q.dir, 'FILEBASE_MANIFEST.json'));
  const manifest = q.run('--manifest-only');
  assert.notEqual(manifest.status, 0, manifest.stdout);
  assert.match(manifest.stderr, /FILEBASE_MANIFEST\.json is a symlink/);
  assert.equal(fs.readFileSync(path.join(target, 'x.md'), 'utf8'), 'x\n', 'nothing was written through the link');
});

test('package-filebase.py outside a git checkout says to run npm run package from one, instead of a traceback', { skip: skipPython }, () => {
  const plain = freshDir('not-a-checkout');
  put(plain, 'scripts/package-filebase.py', fs.readFileSync(PACKAGER));
  put(plain, 'index.html', '<p>Atlas</p>\n');
  const run = spawnSync('python3', ['-I', path.join(plain, 'scripts', 'package-filebase.py')], { cwd: plain, env: hermetic(), encoding: 'utf8' });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /^package-filebase: run npm run package from a git checkout/m);
  assert.doesNotMatch(run.stderr, /Traceback|RuntimeError/);
  assert.equal(run.stdout, '');
  assert.ok(!fs.existsSync(path.join(plain, 'FILEBASE_MANIFEST.json')));

  /* A copy inside some other repository is not a checkout of its own either, even though git answers there. */
  const outer = newRepo(freshDir('outer-repo'));
  put(outer, 'sub/scripts/package-filebase.py', fs.readFileSync(PACKAGER));
  put(outer, 'sub/index.html', '<p>Atlas</p>\n');
  assert.equal(inRepo(outer, ['add', '-A']).status, 0);
  assert.equal(inRepo(outer, ['commit', '-q', '-m', 'initial']).status, 0);
  const nested = spawnSync('python3', ['-I', path.join(outer, 'sub', 'scripts', 'package-filebase.py'), '--manifest-only'], { cwd: path.join(outer, 'sub'), env: hermetic(), encoding: 'utf8' });
  assert.equal(nested.status, 1, nested.stdout + nested.stderr);
  assert.match(nested.stderr, /package-filebase: run npm run package from a git checkout: .* is not the top level of one/);
  assert.ok(!fs.existsSync(path.join(outer, 'sub', 'FILEBASE_MANIFEST.json')));
});

test('package-filebase.py warns on stderr when git status is not clean, and stays quiet when it is', { skip: skipPython }, () => {
  const clean = packagerRepo('status-clean');
  clean.commit('tracked files');
  const quiet = clean.run('--manifest-only');
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stderr, '');

  const dirty = packagerRepo('status-dirty');
  dirty.commit('tracked files');
  put(dirty.dir, 'index.html', '<p>Atlas, edited</p>\n');
  put(dirty.dir, 'new-notes.txt', 'not committed\n');
  const warned = dirty.run('--manifest-only');
  assert.equal(warned.status, 0, 'a dirty tree is a warning, not a refusal: ' + warned.stderr);
  assert.match(warned.stderr, /^package-filebase: warning: git status is not clean \(2 entries\)/m);
  assert.ok(manifestOf(dirty.dir).files.some(entry => entry.file === 'index.html'));
  assert.ok(!manifestOf(dirty.dir).files.some(entry => entry.file === 'new-notes.txt'), 'the untracked file is only mentioned, never packaged');
});

test('the packager in the repository reads git ls-files and writes the finance-task-studio prefix', () => {
  const text = read('scripts/package-filebase.py');
  assert.match(text, /'ls-files'/);
  assert.match(text, /ARCHIVE_PREFIX = 'finance-task-studio\/'/);
  assert.doesNotMatch(text, /finance-trap-studio|rglob/);
  assert.ok(!trackedFiles().includes('FILEBASE_MANIFEST.json'), 'the manifest is rebuilt per machine and is not versioned');
});
