'use strict';
/* Pilot folders: inspect a packet, copy exactly the approved files into a folder outside the project, and later check
   that the solver inputs were not changed (docs/local-agents.md sections 2.4 and 5).

   Layout of a pilot folder: <folder>/filesystem/<approved files>, <folder>/outputs/, <folder>/.tmp/ (the agent's
   TMPDIR). The prompt text is never written into the folder, and nothing is ever copied from private/. */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EVALUATOR_PATTERN, ID_RE, LIMITS } = require('./constants.cjs');
const { inferRole } = require('../../package-engine.js');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAX_ENTRIES = 5000; /* visited directory entries before inspection gives up */
const MAX_OUTPUT_ENTRIES = 1000;
const MAX_OUTPUT_DEPTH = 8;
const SHA256_RE = /^[0-9a-f]{64}$/;
const GAF_RE = /(?:^|[/_ -])gaf(?:[/_. -]|$)/i;
const JUNK_NAMES = new Set(['.DS_Store', '__MACOSX']);
/* C0 and C1 controls, DEL and the Unicode line and paragraph separators. A file name with one of these could forge a
   line in the text the writer approves, so such a file is listed but never usable. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const WITHHELD_ROLES = new Set(['evaluator', 'run-evidence', 'audit']);

/* A refusal with an HTTP style status: 400 for bad input, 409 for a packet that changed. */
class PacketError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'PacketError';
    this.status = status;
  }
}

function within(candidate, root) {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/* sha256 of a regular file, streamed. Symbolic links are never followed. */
function hashFile(file) {
  /* O_NONBLOCK keeps a FIFO from blocking the open; the fstat below then refuses it. */
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  const fd = fs.openSync(file, flags);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new PacketError('Not a regular file');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function realProjectRoot(projectRoot) {
  const root = path.resolve(projectRoot || PROJECT_ROOT);
  try { return fs.realpathSync(root); } catch { return root; }
}

/* The source folder must exist, be a directory, and sit entirely outside the Studio project (which holds private/). */
function resolveSourceDir(sourceDir, projectRoot) {
  if (typeof sourceDir !== 'string' || !sourceDir.trim() || sourceDir.includes('\0')) throw new PacketError('A source folder path is required');
  if (!path.isAbsolute(sourceDir)) throw new PacketError('The source folder must be an absolute path');
  let real;
  try { real = fs.realpathSync(sourceDir); } catch { throw new PacketError('The source folder does not exist'); }
  if (!fs.statSync(real).isDirectory()) throw new PacketError('The source path is not a folder');
  const root = realProjectRoot(projectRoot);
  if (within(real, root)) throw new PacketError('The source folder is inside the Studio project. Use a folder outside it');
  if (within(root, real)) throw new PacketError('The source folder contains the Studio project. Use a folder that does not');
  return real;
}

const segmentsOf = rel => rel.split('/').length;

function classify(rel) {
  const role = inferRole(rel);
  const looksLikeEvaluator = EVALUATOR_PATTERN.test(rel);
  if (role === 'evaluator') return { role, defaultInclude: false, reason: 'Looks like grading material (answer, golden, rubric or similar).' };
  if (looksLikeEvaluator) return { role, defaultInclude: false, reason: 'The name matches an evaluator pattern.' };
  if (role === 'run-evidence') return { role, defaultInclude: false, reason: 'Looks like evidence from an earlier run.' };
  if (role === 'audit') return { role, defaultInclude: false, reason: 'Looks like an audit or review document.' };
  return { role, defaultInclude: !WITHHELD_ROLES.has(role), reason: '' };
}

/* Walk the tree without following links. Returns { regular: [{rel, abs, bytes, hidden}], links: [{rel, why}] }. */
function walk(root) {
  const regular = [];
  const links = [];
  const pending = [''];
  let visited = 0;
  let totalBytes = 0;
  while (pending.length) {
    const relDir = pending.pop();
    const names = fs.readdirSync(path.join(root, relDir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of names) {
      if (++visited > MAX_ENTRIES) throw new PacketError('The source folder has too many entries to inspect');
      if (JUNK_NAMES.has(entry.name)) continue;
      const rel = relDir ? relDir + '/' + entry.name : entry.name;
      const abs = path.join(root, rel);
      if (CONTROL_RE.test(entry.name)) { links.push({ rel: rel.replace(new RegExp(CONTROL_RE.source, 'g'), '?'), why: 'The name contains a control character, so the file cannot be used.' }); continue; }
      if (entry.isSymbolicLink()) { links.push({ rel, why: 'Symbolic link: never followed.' }); continue; }
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        if (segmentsOf(rel) > LIMITS.depth) throw new PacketError(`The source folder is nested deeper than ${LIMITS.depth} levels`);
        pending.push(rel);
        continue;
      }
      if (!entry.isFile()) { links.push({ rel, why: 'Not a regular file.' }); continue; }
      if (segmentsOf(rel) > LIMITS.depth) throw new PacketError(`The source folder is nested deeper than ${LIMITS.depth} levels`);
      const bytes = fs.lstatSync(abs).size;
      totalBytes += bytes;
      if (regular.length + 1 > LIMITS.files) throw new PacketError(`The source folder has more than ${LIMITS.files} files`);
      if (totalBytes > LIMITS.bytes) throw new PacketError(`The source folder is larger than ${Math.round(LIMITS.bytes / 1048576)} MB`);
      regular.push({ rel, abs, bytes, hidden: entry.name.startsWith('.') });
    }
  }
  return { regular, links };
}

/* The one rule for which files belong to the gaf folder: the pilot folder build and the round summary use it, and the
   page keeps a copy of the same pattern (tests/agents-browser-rules.test.cjs compares the two). */
const isGafPath = rel => GAF_RE.test(rel);

/* inspectSource(sourceDir, { projectRoot }) -> { files: [{ path, bytes, sha256, inferredRole, defaultInclude, reason }], totalBytes }
   Symbolic links, special files and files whose name holds a control character are listed as excluded entries
   (excluded: true) and never followed. */
function inspectSource(sourceDir, options = {}) {
  const root = resolveSourceDir(sourceDir, options.projectRoot);
  const { regular, links } = walk(root);
  const files = regular.map(file => {
    const verdict = classify(file.rel);
    const hidden = file.hidden && verdict.defaultInclude;
    return {
      path: file.rel,
      bytes: file.bytes,
      sha256: hashFile(file.abs),
      inferredRole: verdict.role,
      defaultInclude: verdict.defaultInclude && !hidden,
      reason: hidden ? 'Hidden file.' : verdict.reason,
    };
  });
  for (const link of links) {
    files.push({ path: link.rel, bytes: 0, sha256: '', inferredRole: 'source', defaultInclude: false, reason: link.why, excluded: true });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, totalBytes: regular.reduce((sum, file) => sum + file.bytes, 0) };
}

/* A relative path as inspectSource reports it: forward slashes, no traversal, nothing absolute. */
function checkRelativePath(rel) {
  if (typeof rel !== 'string' || rel === '') throw new PacketError('Every selected file needs a path');
  if (rel.includes('\0')) throw new PacketError('A selected file path contains a NUL byte');
  if (rel.includes('\\')) throw new PacketError('A selected file path contains a backslash');
  if (CONTROL_RE.test(rel)) throw new PacketError('A selected file path contains a control character');
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) throw new PacketError('A selected file path is absolute');
  const parts = rel.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) throw new PacketError('A selected file path escapes or is not normalised');
  if (parts.length > LIMITS.depth) throw new PacketError(`A selected file is nested deeper than ${LIMITS.depth} levels`);
  if (parts.some(part => Buffer.byteLength(part) > 255)) throw new PacketError('A selected file path has a name that is too long');
  if (parts.slice(0, -1).some(part => part.startsWith('.') || part === '__MACOSX')) throw new PacketError('A selected file is inside a hidden folder');
  return rel;
}

/* The folder that holds the pilot folders usually sits in a shared temporary directory, where another account could
   have created it first, or replaced it with a link. It must be a real directory that this account owns. A mode that
   lets others in is tightened to 0700; anything else is refused. (Not checked on Windows, which has no such modes.) */
function checkPilotsRoot(destRoot) {
  if (process.platform === 'win32') return;
  const stat = fs.lstatSync(destRoot);
  if (stat.isSymbolicLink()) throw new PacketError('The pilot root is a symbolic link, so it was not used. Remove it or choose another temporary folder', 409);
  if (!stat.isDirectory()) throw new PacketError('The pilot root is not a folder, so it was not used', 409);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new PacketError('The pilot root belongs to another account, so it was not used. Remove it or choose another temporary folder', 409);
  }
  if (stat.mode & 0o077) {
    fs.chmodSync(destRoot, 0o700);
    if (fs.lstatSync(destRoot).mode & 0o077) throw new PacketError('The pilot root is open to other accounts and could not be made private', 409);
  }
}

function prepareDestination(destRoot, sourceReal, projectRoot) {
  if (typeof destRoot !== 'string' || !destRoot || destRoot.includes('\0') || !path.isAbsolute(destRoot)) throw new PacketError('The pilot root must be an absolute path');
  const root = realProjectRoot(projectRoot);
  if (within(path.resolve(destRoot), root)) throw new PacketError('Pilot folders must be outside the Studio project');
  fs.mkdirSync(destRoot, { recursive: true, mode: 0o700 });
  checkPilotsRoot(destRoot);
  const real = fs.realpathSync(destRoot);
  if (within(real, root)) throw new PacketError('Pilot folders must be outside the Studio project');
  if (within(real, sourceReal)) throw new PacketError('Pilot folders cannot be inside the source folder');
  return path.resolve(destRoot);
}

function sortByPath(entries) {
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/* buildPilotFolder({ sourceDir, files: [{ path, sha256, override }], promptText, destRoot, runId, gafVisible, projectRoot? })
   -> { folder, manifest: [{ path, sha256, bytes }], overrides: [path], omitted: [path] }
   Every file is re-hashed against the hash the writer approved, copied, and verified byte for byte. Any failure removes
   the half built folder. promptText is accepted for the caller's convenience and is deliberately not written anywhere. */
function buildPilotFolder(spec) {
  const { sourceDir, files, destRoot, runId, gafVisible, projectRoot } = spec || {};
  if (typeof runId !== 'string' || !ID_RE.test(runId)) throw new PacketError('The run id is not valid');
  if (typeof gafVisible !== 'boolean') throw new PacketError('gafVisible must be true or false');
  if (!Array.isArray(files) || !files.length) throw new PacketError('Select at least one solver file');
  const sourceReal = resolveSourceDir(sourceDir, projectRoot);

  /* Validate the whole selection before anything is written. */
  const chosen = [];
  const omitted = [];
  const overrides = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const entry of files) {
    if (entry === null || typeof entry !== 'object') throw new PacketError('Every selected file must be an object');
    const rel = checkRelativePath(entry.path);
    if (seen.has(rel)) throw new PacketError('A file is selected twice');
    seen.add(rel);
    if (!gafVisible && isGafPath(rel)) { omitted.push(rel); continue; }
    if (EVALUATOR_PATTERN.test(rel)) {
      if (entry.override !== true) throw new PacketError(`Refusing a file whose name looks like grading material (${rel}). Override it by name if it is a solver file`);
      overrides.push(rel);
    }
    if (typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256)) throw new PacketError(`The approved hash for ${rel} is not a sha256`);
    const source = path.join(sourceReal, ...rel.split('/'));
    let stat;
    try { stat = fs.lstatSync(source); } catch { throw new PacketError(`A selected file is missing: ${rel}`, 409); }
    if (stat.isSymbolicLink()) throw new PacketError(`Refusing a symbolic link: ${rel}`);
    if (!stat.isFile()) throw new PacketError(`A selected path is not a regular file: ${rel}`);
    if (fs.realpathSync(source) !== source) throw new PacketError(`Refusing a path that passes through a symbolic link: ${rel}`);
    totalBytes += stat.size;
    chosen.push({ rel, source, sha256: entry.sha256, bytes: stat.size });
  }
  if (!chosen.length) throw new PacketError('No solver files remain after hiding the gaf folder');
  if (chosen.length > LIMITS.files) throw new PacketError(`More than ${LIMITS.files} files selected`);
  if (totalBytes > LIMITS.bytes) throw new PacketError('The selected files are larger than the packet limit');

  const rootDir = prepareDestination(destRoot, sourceReal, projectRoot);
  const folder = path.join(rootDir, runId);
  try {
    fs.mkdirSync(folder, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new PacketError('That pilot folder already exists', 409);
    throw error;
  }
  const manifest = [];
  try {
    for (const file of chosen) {
      if (hashFile(file.source) !== file.sha256) throw new PacketError(`PACKET HASH MISMATCH: ${file.rel} changed after it was approved`, 409);
      const target = path.join(folder, 'filesystem', ...file.rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file.source, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, 0o644);
      const copy = fs.lstatSync(target);
      if (!copy.isFile() || copy.size !== file.bytes || hashFile(target) !== file.sha256) {
        throw new PacketError(`PACKET HASH MISMATCH: the copy of ${file.rel} is not identical to the approved file`, 409);
      }
      manifest.push({ path: file.rel, sha256: file.sha256, bytes: copy.size });
    }
    fs.mkdirSync(path.join(folder, 'filesystem'), { recursive: true });
    fs.mkdirSync(path.join(folder, 'outputs'), { recursive: true });
    fs.mkdirSync(path.join(folder, '.tmp'), { recursive: true });
  } catch (error) {
    fs.rmSync(folder, { recursive: true, force: true });
    throw error;
  }
  return { folder, manifest: sortByPath(manifest), overrides: overrides.sort(), omitted: omitted.sort() };
}

/* verifyFolder(folder, manifest) -> { ok, modified: [path], missing: [path] }
   Compares every solver file with the manifest. A file replaced by a link or a directory counts as modified. */
function verifyFolder(folder, manifest) {
  const modified = [];
  const missing = [];
  for (const entry of Array.isArray(manifest) ? manifest : []) {
    const rel = checkRelativePath(entry && entry.path);
    const target = path.join(folder, 'filesystem', ...rel.split('/'));
    let stat;
    try { stat = fs.lstatSync(target); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') { missing.push(rel); continue; }
      throw error;
    }
    if (!stat.isFile() || (typeof entry.bytes === 'number' && stat.size !== entry.bytes)) { modified.push(rel); continue; }
    let digest;
    try { digest = hashFile(target); } catch { modified.push(rel); continue; }
    if (digest !== entry.sha256) modified.push(rel);
  }
  return { ok: !modified.length && !missing.length, modified, missing };
}

/* snapshotOutputs(folder) -> [{ name, bytes, sha256 }] for the regular files under <folder>/outputs, by relative name.
   Links and special files are ignored. The list is bounded, so a runaway agent cannot make this slow. */
function snapshotOutputs(folder) {
  const base = path.join(folder, 'outputs');
  const found = [];
  const visit = (relDir, depth) => {
    let entries;
    try { entries = fs.readdirSync(path.join(base, relDir), { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (found.length >= MAX_OUTPUT_ENTRIES) return;
      const rel = relDir ? relDir + '/' + entry.name : entry.name;
      if (entry.isDirectory()) { if (depth < MAX_OUTPUT_DEPTH) visit(rel, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const file = path.join(base, rel);
      let sha256 = '';
      try { sha256 = hashFile(file); } catch { sha256 = ''; }
      found.push({ name: rel, bytes: fs.lstatSync(file).size, sha256 });
    }
  };
  visit('', 0);
  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

module.exports = { hashFile, inspectSource, buildPilotFolder, verifyFolder, snapshotOutputs, checkPilotsRoot, isGafPath, GAF_RE, PacketError };
