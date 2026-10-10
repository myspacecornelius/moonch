'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashFile, inspectSource, buildPilotFolder, verifyFolder, snapshotOutputs, PacketError } = require('../backend/agents/pilot-folder.cjs');
const { inferRole } = require('../package-engine.js');
const constants = require('../backend/agents/constants.cjs');

const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const REPO_ROOT = path.resolve(__dirname, '..');

/* A synthetic world: <base>/project (with private/), <base>/source (the packet), <base>/pilots (destination). */
function world(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-folder-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const projectRoot = path.join(base, 'project');
  const source = path.join(base, 'source');
  const destRoot = path.join(base, 'pilots');
  fs.mkdirSync(path.join(projectRoot, 'private'), { recursive: true });
  fs.mkdirSync(source);
  const put = (rel, data = 'data of ' + rel) => {
    const target = path.join(source, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    return target;
  };
  return { base, projectRoot, source, destRoot, put };
}

/* The selection inspectSource would offer, as the build step expects it. */
function select(w, rels) {
  const listing = inspectSource(w.source, { projectRoot: w.projectRoot });
  return rels.map(rel => {
    const file = listing.files.find(entry => entry.path === rel);
    assert.ok(file, 'listed: ' + rel);
    return { path: rel, sha256: file.sha256 };
  });
}

function build(w, files, extra = {}) {
  return buildPilotFolder({ sourceDir: w.source, files, promptText: 'Synthetic prompt text', destRoot: w.destRoot, runId: 'rnd-aaaaaaaaaaaa-1', gafVisible: true, projectRoot: w.projectRoot, ...extra });
}

function treeOf(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix + entry.name;
    if (entry.isDirectory()) { out.push(rel + '/'); out.push(...treeOf(path.join(dir, entry.name), rel + '/')); } else out.push(rel);
  }
  return out;
}

test('hashFile streams a file and matches sha256', t => {
  const w = world(t);
  const small = w.put('small.txt', 'abc');
  assert.equal(hashFile(small), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const bigData = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
  const big = w.put('big.bin', bigData);
  assert.equal(hashFile(big), sha(bigData));
  assert.equal(hashFile(w.put('empty.txt', '')), sha(''));
});

test('hashFile never follows a link and refuses non regular files', t => {
  const w = world(t);
  const target = w.put('real.txt', 'x');
  fs.symlinkSync(target, path.join(w.source, 'link.txt'));
  assert.throws(() => hashFile(path.join(w.source, 'link.txt')));
  assert.throws(() => hashFile(w.source));
  assert.throws(() => hashFile(path.join(w.source, 'missing.txt')));
});

test('inspectSource lists regular files with role, hash, size and default inclusion', t => {
  const w = world(t);
  const names = ['model.xlsx', 'notes/readme.txt', 'gaf/template.xlsx', 'Answer Key.pdf', 'Golden Response.md', 'rubric.docx', 'grader_notes.txt', 'run_1.log', 'trajectory.json', 'review.md', 'candidate_audit.txt', 'prompt.txt', 'reference_solution.xlsx', 'fingerprint.txt', 'private_notes.txt'];
  for (const name of names) w.put(name);
  const listing = inspectSource(w.source, { projectRoot: w.projectRoot });
  assert.deepEqual(listing.files.map(f => f.path), [...names].sort());
  assert.equal(listing.totalBytes, listing.files.reduce((sum, f) => sum + f.bytes, 0));
  const byPath = Object.fromEntries(listing.files.map(f => [f.path, f]));
  for (const file of listing.files) {
    assert.deepEqual(Object.keys(file).sort(), ['bytes', 'defaultInclude', 'inferredRole', 'path', 'reason', 'sha256']);
    assert.equal(file.sha256, hashFile(path.join(w.source, ...file.path.split('/'))));
    assert.equal(file.bytes, fs.statSync(path.join(w.source, ...file.path.split('/'))).size);
    assert.equal(file.inferredRole, inferRole(file.path), 'role mirrors package-engine inferRole: ' + file.path);
  }
  for (const included of ['model.xlsx', 'notes/readme.txt', 'gaf/template.xlsx', 'prompt.txt']) {
    assert.equal(byPath[included].defaultInclude, true, included);
    assert.equal(byPath[included].reason, '');
  }
  for (const withheld of ['Answer Key.pdf', 'Golden Response.md', 'rubric.docx', 'grader_notes.txt', 'run_1.log', 'trajectory.json', 'review.md', 'candidate_audit.txt', 'reference_solution.xlsx', 'fingerprint.txt', 'private_notes.txt']) {
    assert.equal(byPath[withheld].defaultInclude, false, withheld);
    assert.notEqual(byPath[withheld].reason, '', withheld);
  }
  assert.equal(byPath['gaf/template.xlsx'].inferredRole, 'template');
  assert.equal(byPath['Answer Key.pdf'].inferredRole, 'evaluator');
  assert.equal(byPath['run_1.log'].inferredRole, 'run-evidence');
  assert.equal(byPath['review.md'].inferredRole, 'audit');
});

test('role inference is the one package-engine uses', () => {
  assert.equal(typeof inferRole, 'function');
  for (const [name, role] of [['gaf/x.xlsx', 'template'], ['a/template_v2.xlsx', 'template'], ['answers.csv', 'evaluator'], ['Task_Prompt.txt', 'prompt'], ['batch_2.csv', 'run-evidence'], ['review.docx', 'audit'], ['sector.csv', 'source']]) assert.equal(inferRole(name), role, name);
});

test('inspectSource skips junk and dot folders, flags hidden files, and never follows links', t => {
  const w = world(t);
  w.put('a.csv');
  w.put('.DS_Store');
  w.put('__MACOSX/._a.csv');
  w.put('.git/config');
  w.put('.hidden-dir/inside.txt');
  w.put('.env', 'SECRET=1');
  const outside = path.join(w.base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(w.source, 'file-link.txt'));
  fs.symlinkSync(outside, path.join(w.source, 'dir-link'));
  fs.symlinkSync(path.join(w.base, 'does-not-exist'), path.join(w.source, 'dangling'));
  const listing = inspectSource(w.source, { projectRoot: w.projectRoot });
  const byPath = Object.fromEntries(listing.files.map(f => [f.path, f]));
  assert.deepEqual(Object.keys(byPath).sort(), ['.env', 'a.csv', 'dangling', 'dir-link', 'file-link.txt']);
  assert.equal(byPath['a.csv'].defaultInclude, true);
  assert.equal(byPath['.env'].defaultInclude, false);
  assert.match(byPath['.env'].reason, /Hidden/);
  for (const link of ['file-link.txt', 'dir-link', 'dangling']) {
    assert.equal(byPath[link].defaultInclude, false, link);
    assert.equal(byPath[link].excluded, true, link);
    assert.match(byPath[link].reason, /link/i, link);
    assert.equal(byPath[link].sha256, '');
  }
  assert.equal(listing.totalBytes, byPath['a.csv'].bytes + byPath['.env'].bytes, 'links add nothing to the total');
});

test('inspectSource accepts a source folder reached through a link', t => {
  const w = world(t);
  w.put('a.csv');
  const alias = path.join(w.base, 'alias');
  fs.symlinkSync(w.source, alias);
  assert.deepEqual(inspectSource(alias, { projectRoot: w.projectRoot }).files.map(f => f.path), ['a.csv']);
});

test('inspectSource refuses bad source paths', t => {
  const w = world(t);
  const file = w.put('a.csv');
  for (const bad of [undefined, null, '', '   ', 42, {}, [], 'relative/dir', './source', 'source', '~/Desktop', path.join(w.base, 'missing'), file, 'x\0y', '/tmp/\0']) {
    assert.throws(() => inspectSource(bad, { projectRoot: w.projectRoot }), PacketError, String(bad));
  }
});

test('inspectSource refuses the project root, anything inside it, private/, and folders that contain it', t => {
  const w = world(t);
  fs.mkdirSync(path.join(w.projectRoot, 'qa'));
  fs.mkdirSync(path.join(w.projectRoot, 'private', 'task-a'));
  fs.writeFileSync(path.join(w.projectRoot, 'private', 'task-a', 'x.txt'), 'secret');
  const refuse = (dir, pattern) => assert.throws(() => inspectSource(dir, { projectRoot: w.projectRoot }), error => error instanceof PacketError && error.status === 400 && pattern.test(error.message), dir);
  refuse(w.projectRoot, /inside the Studio project/);
  refuse(path.join(w.projectRoot, 'qa'), /inside the Studio project/);
  refuse(path.join(w.projectRoot, 'private'), /inside the Studio project/);
  refuse(path.join(w.projectRoot, 'private', 'task-a'), /inside the Studio project/);
  refuse(w.base, /contains the Studio project/);
  refuse(path.parse(w.base).root, /contains the Studio project/);
  const viaLink = path.join(w.base, 'to-private');
  fs.symlinkSync(path.join(w.projectRoot, 'private'), viaLink);
  refuse(viaLink, /inside the Studio project/);
  const viaProjectLink = path.join(w.base, 'to-project');
  fs.symlinkSync(w.projectRoot, viaProjectLink);
  refuse(viaProjectLink, /inside the Studio project/);
});

test('inspectSource uses the real project as its default root', () => {
  assert.throws(() => inspectSource(REPO_ROOT), /inside the Studio project/);
  assert.throws(() => inspectSource(path.join(REPO_ROOT, 'tests')), /inside the Studio project/);
  assert.throws(() => inspectSource(path.dirname(REPO_ROOT)), /contains the Studio project/);
});

test('inspectSource enforces depth, file count and size limits', t => {
  const shallow = world(t);
  shallow.put('a/b/c/d.txt');
  assert.equal(inspectSource(shallow.source, { projectRoot: shallow.projectRoot }).files.length, 1, 'four levels including the file name is allowed');
  const deep = world(t);
  deep.put('a/b/c/d/e.txt');
  assert.throws(() => inspectSource(deep.source, { projectRoot: deep.projectRoot }), /deeper than 4/);

  const many = world(t);
  for (let i = 0; i < constants.LIMITS.files; i++) many.put(`f${String(i).padStart(3, '0')}.txt`, String(i));
  assert.equal(inspectSource(many.source, { projectRoot: many.projectRoot }).files.length, 150);
  many.put('one-too-many.txt');
  assert.throws(() => inspectSource(many.source, { projectRoot: many.projectRoot }), /more than 150 files/);

  const heavy = world(t);
  const big = heavy.put('big.bin', '');
  fs.truncateSync(big, constants.LIMITS.bytes + 1);
  assert.throws(() => inspectSource(heavy.source, { projectRoot: heavy.projectRoot }), /larger than 100 MB/);
  fs.truncateSync(big, constants.LIMITS.bytes);
  const exact = inspectSource(heavy.source, { projectRoot: heavy.projectRoot });
  assert.equal(exact.totalBytes, constants.LIMITS.bytes, 'exactly 100 MB is allowed');
});

test('buildPilotFolder copies byte for byte into folder/filesystem and creates outputs and .tmp', t => {
  const w = world(t);
  const binary = Buffer.from([0, 1, 2, 255, 254, 10, 13, 0]);
  w.put('model.xlsx', binary);
  w.put('notes/readme.txt', 'readme');
  w.put('data/q1/sales.csv', 'a,b\n1,2\n');
  const files = select(w, ['model.xlsx', 'notes/readme.txt', 'data/q1/sales.csv']);
  const result = build(w, files);
  assert.equal(result.folder, path.join(w.destRoot, 'rnd-aaaaaaaaaaaa-1'));
  assert.deepEqual(result.manifest.map(m => m.path), ['data/q1/sales.csv', 'model.xlsx', 'notes/readme.txt']);
  for (const entry of result.manifest) {
    const copy = path.join(result.folder, 'filesystem', ...entry.path.split('/'));
    const original = path.join(w.source, ...entry.path.split('/'));
    assert.ok(fs.readFileSync(copy).equals(fs.readFileSync(original)), 'identical bytes: ' + entry.path);
    assert.equal(entry.sha256, sha(fs.readFileSync(original)));
    assert.equal(entry.bytes, fs.statSync(original).size);
    assert.ok(!fs.lstatSync(copy).isSymbolicLink());
  }
  assert.deepEqual(treeOf(result.folder), ['.tmp/', 'filesystem/', 'filesystem/data/', 'filesystem/data/q1/', 'filesystem/data/q1/sales.csv', 'filesystem/model.xlsx', 'filesystem/notes/', 'filesystem/notes/readme.txt', 'outputs/']);
  assert.deepEqual(fs.readdirSync(path.join(result.folder, 'outputs')), []);
  assert.deepEqual(fs.readdirSync(path.join(result.folder, '.tmp')), []);
  assert.equal(fs.statSync(result.folder).mode & 0o077, 0, 'the folder is private to the owner');
  assert.deepEqual(result.overrides, []);
  assert.deepEqual(result.omitted, []);
  assert.deepEqual(verifyFolder(result.folder, result.manifest), { ok: true, modified: [], missing: [] });
});

test('the prompt text is never written into the folder', t => {
  const w = world(t);
  w.put('a.csv');
  const prompt = 'UNIQUE-PROMPT-MARKER please compute the thing';
  const result = build(w, select(w, ['a.csv']), { promptText: prompt });
  const hits = [];
  const scan = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(full);
      else if (fs.readFileSync(full, 'utf8').includes('UNIQUE-PROMPT-MARKER') || entry.name.includes('UNIQUE-PROMPT')) hits.push(full);
    }
  };
  scan(result.folder);
  assert.deepEqual(hits, []);
});

test('files under a gaf segment are omitted when gafVisible is false and copied when true', t => {
  const w = world(t);
  w.put('model.xlsx');
  w.put('gaf/rates.xlsx');
  w.put('docs/GAF_notes.txt');
  w.put('docs/gaffer.txt');
  const files = select(w, ['model.xlsx', 'gaf/rates.xlsx', 'docs/GAF_notes.txt', 'docs/gaffer.txt']);
  const hidden = build(w, files, { gafVisible: false, runId: 'rnd-hidden-1' });
  assert.deepEqual(hidden.manifest.map(m => m.path), ['docs/gaffer.txt', 'model.xlsx']);
  assert.deepEqual(hidden.omitted, ['docs/GAF_notes.txt', 'gaf/rates.xlsx']);
  assert.ok(!fs.existsSync(path.join(hidden.folder, 'filesystem', 'gaf')));
  const visible = build(w, files, { gafVisible: true, runId: 'rnd-visible-1' });
  assert.deepEqual(visible.manifest.map(m => m.path), ['docs/GAF_notes.txt', 'docs/gaffer.txt', 'gaf/rates.xlsx', 'model.xlsx']);
  assert.deepEqual(visible.omitted, []);
  assert.ok(fs.existsSync(path.join(visible.folder, 'filesystem', 'gaf', 'rates.xlsx')));
});

test('gafVisible must be an explicit boolean', t => {
  const w = world(t);
  w.put('a.csv');
  const files = select(w, ['a.csv']);
  for (const value of [undefined, null, 'true', 1, 0]) assert.throws(() => build(w, files, { gafVisible: value }), /gafVisible/);
  assert.ok(!fs.existsSync(w.destRoot), 'nothing was created');
});

test('evaluator names and private segments are refused unless that exact file is overridden', t => {
  const w = world(t);
  const risky = ['Answer Key.xlsx', 'golden_response.docx', 'rubric.pdf', 'grader.txt', 'evaluator_notes.txt', 'reference-solution.xlsx', 'fingerprint.json', 'attestation.txt', 'private/notes.txt', 'notes/Private Memo.txt'];
  for (const rel of risky) w.put(rel);
  w.put('ok.csv');
  const listing = inspectSource(w.source, { projectRoot: w.projectRoot });
  for (const rel of risky) {
    const entry = listing.files.find(f => f.path === rel);
    assert.throws(() => build(w, [{ path: rel, sha256: entry.sha256 }]), error => error instanceof PacketError && /grading material/.test(error.message), rel);
    assert.throws(() => build(w, [{ path: rel, sha256: entry.sha256, override: 'yes' }]), PacketError, 'only true overrides: ' + rel);
    assert.throws(() => build(w, [{ path: 'ok.csv', sha256: listing.files.find(f => f.path === 'ok.csv').sha256 }, { path: rel, sha256: entry.sha256, override: false }]), PacketError, rel);
  }
  assert.ok(!fs.existsSync(w.destRoot) || fs.readdirSync(w.destRoot).length === 0, 'refusals leave nothing behind');
  const entry = listing.files.find(f => f.path === 'rubric.pdf');
  const okEntry = listing.files.find(f => f.path === 'ok.csv');
  const result = build(w, [{ path: 'rubric.pdf', sha256: entry.sha256, override: true }, { path: 'ok.csv', sha256: okEntry.sha256 }]);
  assert.deepEqual(result.overrides, ['rubric.pdf'], 'the override is recorded by name');
  assert.deepEqual(result.manifest.map(m => m.path), ['ok.csv', 'rubric.pdf']);
  const other = listing.files.find(f => f.path === 'grader.txt');
  assert.throws(() => build(w, [{ path: 'rubric.pdf', sha256: entry.sha256, override: true }, { path: 'grader.txt', sha256: other.sha256 }], { runId: 'rnd-other-1' }), /grading material/, 'an override covers only its own file');
});

test('a source folder inside the project is refused even with an override', t => {
  const w = world(t);
  const inside = path.join(w.projectRoot, 'private', 'task');
  fs.mkdirSync(inside, { recursive: true });
  fs.writeFileSync(path.join(inside, 'solver.csv'), 'x');
  assert.throws(() => buildPilotFolder({ sourceDir: inside, files: [{ path: 'solver.csv', sha256: sha('x'), override: true }], promptText: '', destRoot: w.destRoot, runId: 'rnd-private-1', gafVisible: true, projectRoot: w.projectRoot }), /inside the Studio project/);
  assert.ok(!fs.existsSync(w.destRoot));
});

test('path traversal, absolute paths and odd names in the selection are refused', t => {
  const w = world(t);
  w.put('a.csv');
  fs.writeFileSync(path.join(w.base, 'outside.txt'), 'outside');
  const good = select(w, ['a.csv'])[0];
  const hash = good.sha256;
  const bad = ['../outside.txt', 'a/../a.csv', 'a/../../outside.txt', '/etc/passwd', path.join(w.source, 'a.csv'), './a.csv', 'a.csv/', 'a//b.csv', '', '.', '..', 'a\\b.csv', 'a.csv\0', 'C:\\x.txt', 'C:/x.txt', '.hidden/x.csv', '__MACOSX/x.csv', 'a/b/c/d/e.csv', 'x'.repeat(300), null, undefined, 42, {}];
  for (const rel of bad) {
    assert.throws(() => build(w, [{ path: rel, sha256: hash }]), PacketError, JSON.stringify(rel));
  }
  assert.ok(!fs.existsSync(w.destRoot), 'nothing was created for refused selections');
});

test('symlinks, links in parent folders and non files are refused', t => {
  const w = world(t);
  w.put('real/inside.csv', 'inside');
  w.put('plain.csv', 'plain');
  const outside = path.join(w.base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.csv'), 'secret');
  fs.symlinkSync(path.join(outside, 'secret.csv'), path.join(w.source, 'file-link.csv'));
  fs.symlinkSync(outside, path.join(w.source, 'dir-link'));
  fs.symlinkSync(path.join(w.source, 'plain.csv'), path.join(w.source, 'link-to-inside.csv'));
  fs.mkdirSync(path.join(w.source, 'folder'));
  const refuse = (rel, hash) => assert.throws(() => build(w, [{ path: rel, sha256: hash }]), PacketError, rel);
  refuse('file-link.csv', sha('secret'));
  refuse('link-to-inside.csv', sha('plain'));
  refuse('dir-link/secret.csv', sha('secret'));
  refuse('folder', sha(''));
  refuse('missing.csv', sha(''));
  assert.ok(!fs.existsSync(w.destRoot));
});

test('a file that changed after approval is refused with PACKET HASH MISMATCH (409) and the half built folder is removed', t => {
  const w = world(t);
  w.put('a.csv', 'first');
  w.put('b.csv', 'second');
  const files = select(w, ['a.csv', 'b.csv']);
  fs.writeFileSync(path.join(w.source, 'b.csv'), 'second, edited after approval');
  assert.throws(() => build(w, files), error => error instanceof PacketError && error.status === 409 && /PACKET HASH MISMATCH/.test(error.message) && /b\.csv/.test(error.message));
  assert.ok(!fs.existsSync(path.join(w.destRoot, 'rnd-aaaaaaaaaaaa-1')), 'no partial folder remains');
  const sameSizeFiles = select(w, ['a.csv']);
  fs.writeFileSync(path.join(w.source, 'a.csv'), 'FIRST');
  assert.throws(() => build(w, sameSizeFiles), /PACKET HASH MISMATCH/, 'same length, different bytes');
});

test('hashes must be real sha256 values and the selection must name real files', t => {
  const w = world(t);
  w.put('a.csv');
  for (const hash of [undefined, '', 'abc', 'A'.repeat(64), 'g'.repeat(64), 5]) assert.throws(() => build(w, [{ path: 'a.csv', sha256: hash }]), PacketError, String(hash));
  assert.throws(() => build(w, [{ path: 'a.csv', sha256: sha('different') }]), /PACKET HASH MISMATCH/);
  assert.throws(() => build(w, []), /at least one/);
  assert.throws(() => build(w, 'a.csv'), /at least one/);
  assert.throws(() => build(w, [null]), PacketError);
  const [entry] = select(w, ['a.csv']);
  assert.throws(() => build(w, [entry, entry]), /twice/);
});

test('run ids, destination and existing folders', t => {
  const w = world(t);
  w.put('a.csv');
  const files = select(w, ['a.csv']);
  for (const runId of [undefined, '', 'abc', 'UPPER-case-id', '../escape-1', 'has space', 'a/b/c/d', 'x'.repeat(65), 'rnd_underscore']) {
    assert.throws(() => build(w, files, { runId }), /run id/, String(runId));
  }
  const first = build(w, files);
  assert.throws(() => build(w, files), error => error instanceof PacketError && error.status === 409 && /already exists/.test(error.message));
  assert.ok(fs.existsSync(first.folder), 'a refused rebuild leaves the first folder alone');
  assert.throws(() => build(w, files, { destRoot: 'relative/dir', runId: 'rnd-relative-1' }), /absolute/);
  assert.throws(() => build(w, files, { destRoot: '', runId: 'rnd-empty-dest-1' }), /absolute/);
  assert.throws(() => build(w, files, { destRoot: path.join(w.projectRoot, 'pilots'), runId: 'rnd-inside-1' }), /outside the Studio project/);
  assert.ok(!fs.existsSync(path.join(w.projectRoot, 'pilots')), 'no folder was created inside the project');
  assert.throws(() => build(w, files, { destRoot: path.join(w.source, 'pilots'), runId: 'rnd-in-source-1' }), /inside the source folder/);
  assert.throws(() => build(w, files, { sourceDir: w.projectRoot, runId: 'rnd-source-project-1' }), /inside the Studio project/);
  const aliasToProject = path.join(w.base, 'alias-to-project');
  fs.symlinkSync(w.projectRoot, aliasToProject);
  assert.throws(() => build(w, files, { destRoot: path.join(aliasToProject, 'pilots'), runId: 'rnd-alias-1' }), /outside the Studio project/);
});

test('limits are enforced when building too', t => {
  const w = world(t);
  const selection = [];
  for (let i = 0; i < constants.LIMITS.files + 1; i++) {
    w.put(`f${String(i).padStart(3, '0')}.txt`, String(i));
    selection.push({ path: `f${String(i).padStart(3, '0')}.txt`, sha256: sha(String(i)) });
  }
  assert.throws(() => build(w, selection), /More than 150 files/);
  const heavy = world(t);
  const big = heavy.put('big.bin', '');
  fs.truncateSync(big, constants.LIMITS.bytes + 1);
  assert.throws(() => build(heavy, [{ path: 'big.bin', sha256: sha('x') }]), /larger than the packet limit/);
});

test('an unreadable or vanished source file removes the folder', t => {
  const w = world(t);
  w.put('a.csv');
  w.put('b.csv');
  const files = select(w, ['a.csv', 'b.csv']);
  fs.rmSync(path.join(w.source, 'b.csv'));
  assert.throws(() => build(w, files), error => error instanceof PacketError && error.status === 409);
  assert.ok(!fs.existsSync(path.join(w.destRoot, 'rnd-aaaaaaaaaaaa-1')));
});

test('verifyFolder detects modified, missing and replaced inputs', t => {
  const w = world(t);
  w.put('a.csv', 'alpha');
  w.put('sub/b.csv', 'beta');
  w.put('c.csv', 'gamma');
  w.put('d.csv', 'delta');
  const { folder, manifest } = build(w, select(w, ['a.csv', 'sub/b.csv', 'c.csv', 'd.csv']));
  assert.deepEqual(verifyFolder(folder, manifest), { ok: true, modified: [], missing: [] });
  fs.writeFileSync(path.join(folder, 'filesystem', 'a.csv'), 'ALPHA');
  assert.deepEqual(verifyFolder(folder, manifest), { ok: false, modified: ['a.csv'], missing: [] }, 'same size, different bytes');
  fs.appendFileSync(path.join(folder, 'filesystem', 'sub', 'b.csv'), '!');
  fs.rmSync(path.join(folder, 'filesystem', 'c.csv'));
  fs.rmSync(path.join(folder, 'filesystem', 'd.csv'));
  fs.symlinkSync(path.join(w.source, 'd.csv'), path.join(folder, 'filesystem', 'd.csv'));
  const result = verifyFolder(folder, manifest);
  assert.equal(result.ok, false);
  assert.deepEqual(result.modified.sort(), ['a.csv', 'd.csv', 'sub/b.csv']);
  assert.deepEqual(result.missing, ['c.csv']);
  fs.rmSync(path.join(folder, 'filesystem', 'sub'), { recursive: true });
  assert.deepEqual(verifyFolder(folder, manifest).missing.sort(), ['c.csv', 'sub/b.csv']);
  assert.deepEqual(verifyFolder(folder, []), { ok: true, modified: [], missing: [] });
  assert.throws(() => verifyFolder(folder, [{ path: '../escape', sha256: sha('x'), bytes: 1 }]), PacketError);
  fs.rmSync(folder, { recursive: true });
  assert.equal(verifyFolder(folder, manifest).missing.length, 4);
});

test('verifyFolder ignores extra files the agent added', t => {
  const w = world(t);
  w.put('a.csv');
  const { folder, manifest } = build(w, select(w, ['a.csv']));
  fs.writeFileSync(path.join(folder, 'filesystem', 'scratch.txt'), 'x');
  fs.writeFileSync(path.join(folder, 'outputs', 'result.md'), 'x');
  assert.equal(verifyFolder(folder, manifest).ok, true);
});

test('snapshotOutputs lists regular files with size and hash, sorted, ignoring links', t => {
  const w = world(t);
  w.put('a.csv');
  const { folder } = build(w, select(w, ['a.csv']));
  assert.deepEqual(snapshotOutputs(folder), []);
  fs.writeFileSync(path.join(folder, 'outputs', 'z.md'), 'zulu');
  fs.mkdirSync(path.join(folder, 'outputs', 'sub', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'outputs', 'sub', 'deeper', 'a.txt'), 'alpha');
  fs.writeFileSync(path.join(folder, 'outputs', 'm.csv'), '');
  fs.symlinkSync(path.join(w.source, 'a.csv'), path.join(folder, 'outputs', 'link.csv'));
  assert.deepEqual(snapshotOutputs(folder), [
    { name: 'm.csv', bytes: 0, sha256: sha('') },
    { name: 'sub/deeper/a.txt', bytes: 5, sha256: sha('alpha') },
    { name: 'z.md', bytes: 4, sha256: sha('zulu') },
  ]);
  fs.rmSync(path.join(folder, 'outputs'), { recursive: true });
  assert.deepEqual(snapshotOutputs(folder), [], 'a missing outputs folder is an empty list');
  assert.deepEqual(snapshotOutputs(path.join(w.base, 'never-built')), []);
});

test('snapshotOutputs is bounded', t => {
  const w = world(t);
  w.put('a.csv');
  const { folder } = build(w, select(w, ['a.csv']));
  for (let i = 0; i < 1100; i++) fs.writeFileSync(path.join(folder, 'outputs', `f${String(i).padStart(4, '0')}.txt`), String(i));
  assert.equal(snapshotOutputs(folder).length, 1000);
});

test('refusals are PacketError with an HTTP style status', t => {
  const w = world(t);
  const error = (() => { try { inspectSource('relative', { projectRoot: w.projectRoot }); } catch (e) { return e; } return null; })();
  assert.ok(error instanceof PacketError);
  assert.ok(error instanceof Error);
  assert.equal(error.status, 400);
  assert.equal(error.name, 'PacketError');
});

test('constants carry the documented limits and allowlists and cannot be changed at run time', () => {
  assert.equal(constants.MAX_PILOTS_PER_ROUND, 5);
  assert.deepEqual([...constants.MODELS], ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-5-5']);
  assert.equal(constants.DEFAULT_MODEL, 'claude-opus-5-5');
  assert.ok(constants.MODELS.includes(constants.DEFAULT_MODEL));
  assert.deepEqual([...constants.EFFORTS], ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(constants.DEFAULT_EFFORT, 'medium');
  assert.ok(constants.EFFORTS.includes(constants.DEFAULT_EFFORT));
  assert.deepEqual([...constants.TOOLS], ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']);
  assert.deepEqual({ ...constants.LIMITS }, { files: 150, bytes: 104857600, depth: 4, timeoutMs: 3000000, killGraceMs: 5000, concurrency: 3, bodyBytes: 1048576, packetBodyBytes: 262144, graderBatch: 5 });
  assert.throws(() => constants.MODELS.push('claude-other'), TypeError);
  assert.throws(() => { constants.LIMITS.files = 1000; }, TypeError);
  assert.throws(() => { constants.MAX_PILOTS_PER_ROUND = 50; }, TypeError);
});

test('the evaluator pattern is case insensitive and the id pattern is strict', () => {
  const { EVALUATOR_PATTERN, ID_RE } = constants;
  assert.equal(EVALUATOR_PATTERN.flags.includes('g'), false, 'no sticky state between calls');
  for (const name of ['Answer Key.pdf', 'GOLDEN.txt', 'gold_standard.csv', 'Grader notes', 'evaluator.md', 'RUBRIC.docx', 'reference solution.xlsx', 'reference_solution.xlsx', 'reference-solution.xlsx', 'fingerprints.json', 'Attestation.pdf', 'private/x.csv']) {
    assert.ok(EVALUATOR_PATTERN.test(name), name);
    assert.ok(EVALUATOR_PATTERN.test(name), name + ' (second call gives the same answer)');
  }
  for (const name of ['model.xlsx', 'sales_q1.csv', 'prompt.txt', 'notes/readme.md', 'referral.txt']) assert.equal(EVALUATOR_PATTERN.test(name), false, name);
  for (const good of ['rnd-0123456789ab', 'abcd', 'a-b-c-1', 'x'.repeat(64)]) assert.ok(ID_RE.test(good), good);
  for (const bad of ['abc', 'x'.repeat(65), 'UPPER-case', 'has space', 'a/b/c/d', '../escape-1', 'under_score', 'abcd\n', '']) assert.equal(ID_RE.test(bad), false, JSON.stringify(bad));
});

/* ------------------------------------------------------------------ each validation rule, by its own message */

test('each rule of the selection check refuses with its own message, for files that really exist', t => {
  const w = world(t);
  w.put('a.csv');
  const hash = select(w, ['a.csv'])[0].sha256;
  /* The odd paths exist on disk, so only the named rule can be what refuses them. */
  w.put('.hidden/x.csv', 'x');
  w.put('__MACOSX/x.csv', 'x');
  fs.writeFileSync(path.join(w.source, 'a\\b.csv'), 'x');
  fs.writeFileSync(path.join(w.source, 'C:'), 'x');
  const refuse = (rel, pattern) => assert.throws(() => build(w, [{ path: rel, sha256: sha('x') }]), error => error instanceof PacketError && error.status === 400 && pattern.test(error.message), rel);
  refuse('.hidden/x.csv', /hidden folder/);
  refuse('__MACOSX/x.csv', /hidden folder/);
  refuse('a\\b.csv', /backslash/);
  refuse('C:/x.txt', /absolute/);
  refuse('/etc/hosts', /absolute/);
  refuse('a/../a.csv', /escapes|normalised/);
  refuse('n\u0007ame.csv', /control character/);
  refuse('n\u2028ame.csv', /control character/);
  refuse('n\name.csv', /control character/);
  assert.throws(() => build(w, [{ path: 'a.csv', sha256: hash }, { path: 'a.csv', sha256: hash }]), /twice/);
  /* a missing file is a different refusal (409), so the checks above are not just "a PacketError" */
  assert.throws(() => build(w, [{ path: 'nothing.csv', sha256: hash }]), error => error instanceof PacketError && error.status === 409 && /missing/.test(error.message));
  assert.ok(!fs.existsSync(w.destRoot));
});

test('a relative source folder is refused even when it exists, and hashFile names the reason for a folder', t => {
  const w = world(t);
  w.put('a.csv');
  const saved = process.cwd();
  process.chdir(w.base);
  t.after(() => process.chdir(saved));
  for (const relative of ['source', './source', 'source/']) {
    assert.ok(fs.statSync(relative).isDirectory(), 'the relative folder exists');
    assert.throws(() => inspectSource(relative, { projectRoot: w.projectRoot }), error => error instanceof PacketError && /absolute path/.test(error.message), relative);
    assert.throws(() => buildPilotFolder({ sourceDir: relative, files: [{ path: 'a.csv', sha256: sha('x') }], promptText: '', destRoot: w.destRoot, runId: 'rnd-relative-1', gafVisible: true, projectRoot: w.projectRoot }), /absolute path/, relative);
  }
  assert.throws(() => hashFile(w.source), error => error instanceof PacketError && /Not a regular file/.test(error.message));
});

/* ------------------------------------------------------------------ names with control characters */

test('a file whose name holds a control character is listed as unusable, with a printable name', t => {
  const w = world(t);
  w.put('ok.csv');
  let planted = 0;
  for (const name of ['two\nlines.txt', 'tab\there.txt', 'esc\u001b[0m.txt', 'sep\u2028arator.txt']) {
    try { fs.writeFileSync(path.join(w.source, name), 'x'); planted++; } catch { /* the file system refuses this name */ }
  }
  const listing = inspectSource(w.source, { projectRoot: w.projectRoot });
  assert.equal(listing.files.length, 1 + planted);
  const odd = listing.files.filter(file => file.path !== 'ok.csv');
  assert.equal(odd.length, planted);
  for (const file of odd) {
    assert.equal(file.excluded, true);
    assert.equal(file.defaultInclude, false);
    assert.match(file.reason, /control character/);
    assert.doesNotMatch(file.path, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
  }
  assert.equal(listing.files.find(file => file.path === 'ok.csv').excluded, undefined);
});

/* ------------------------------------------------------------------ the folder that holds the pilot folders */

test('the pilots root is created private, reused when it is private, tightened when it is open, and refused when it is a link', t => {
  const w = world(t);
  w.put('a.csv');
  const files = select(w, ['a.csv']);
  build(w, files);
  assert.equal(fs.statSync(w.destRoot).mode & 0o077, 0, 'created private');
  build(w, files, { runId: 'rnd-aaaaaaaaaaaa-2' });
  if (process.platform === 'win32') return;
  fs.chmodSync(w.destRoot, 0o755);
  build(w, files, { runId: 'rnd-aaaaaaaaaaaa-3' });
  assert.equal(fs.statSync(w.destRoot).mode & 0o777, 0o700, 'an open root is made private');
  const elsewhere = path.join(w.base, 'elsewhere');
  fs.mkdirSync(elsewhere);
  const linked = path.join(w.base, 'linked-root');
  fs.symlinkSync(elsewhere, linked);
  assert.throws(() => build(w, files, { destRoot: linked, runId: 'rnd-aaaaaaaaaaaa-4' }), error => error instanceof PacketError && /symbolic link/.test(error.message));
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing was built through the link');
  const file = path.join(w.base, 'not-a-folder');
  fs.writeFileSync(file, 'x');
  assert.throws(() => build(w, files, { destRoot: file, runId: 'rnd-aaaaaaaaaaaa-5' }));
});

test('a pilots root that belongs to another account is refused', { skip: process.platform === 'win32' || typeof process.getuid !== 'function' || process.getuid() !== 0 }, t => {
  const w = world(t);
  w.put('a.csv');
  const files = select(w, ['a.csv']);
  fs.mkdirSync(w.destRoot, { mode: 0o700 });
  fs.chownSync(w.destRoot, 65534, 65534);
  assert.throws(() => build(w, files), error => error instanceof PacketError && /another account/.test(error.message));
  assert.deepEqual(fs.readdirSync(w.destRoot), []);
});
