'use strict';
/* Small helpers shared by the pipeline modules: hashing, atomic JSON files, a walk of a folder that never follows a link, and the
   rules for a file name that may be copied into a work folder. Nothing here starts a process or a model. */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { hashFile } = require('../agents/pilot-folder.cjs');

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256Hex = data => crypto.createHash('sha256').update(data).digest('hex');
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const JUNK_NAMES = new Set(['.DS_Store', '__MACOSX', 'Thumbs.db']);
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.html', '.htm', '.xml', '.log', '.yaml', '.yml']);

/* Thrown when a copy was cut short because the owner pressed Stop. */
class Stopped extends Error {}

/* Files that are never part of a design or a packet: system litter and the lock files office programs leave next to a file. */
const JUNK_FILE_RE = /^(?:~\$.*|\.~lock\..*#|desktop\.ini|Thumbs\.db|\.DS_Store|.*\.(?:swp|swo))$/i;
const isJunkName = rel => String(rel).split('/').some(part => JUNK_NAMES.has(part)) || JUNK_FILE_RE.test(path.posix.basename(String(rel)));

/* Text cut to `max` characters, never inside a surrogate pair. */
function capText(value, max) {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/* One line of display text: controls become spaces. */
const oneLine = (value, max) => capText(String(value === undefined || value === null ? '' : value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim(), max);

function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

function writeTextAtomic(file, text) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function within(candidate, root) {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/* A relative file name as the pipeline keeps it: forward slashes, no traversal, no hidden or junk part, no control character, at
   most `depth` parts, every part a usable length. Returns the reason it is refused, or '' when it is fine. */
function nameProblem(rel, depth) {
  if (typeof rel !== 'string' || !rel) return 'it has no name';
  if (rel.includes('\0') || CONTROL_RE.test(rel)) return 'its name holds a control character';
  if (rel.includes('\\')) return 'its name holds a backslash';
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return 'its name is absolute';
  const parts = rel.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) return 'its name is not a plain relative path';
  if (parts.length > depth) return `it is nested deeper than ${depth} levels`;
  if (parts.some(part => Buffer.byteLength(part) > 255)) return 'a part of its name is too long';
  if (parts.some(part => part.startsWith('.') || JUNK_NAMES.has(part))) return 'its name is hidden';
  return '';
}

/* Every regular file below `root`, by relative name, links and special files never followed. Returns { files: [{ rel, abs, bytes }],
   skipped: [{ rel, why }] }, both sorted. maxFiles and the depth bound the work. */
function walkFiles(root, options = {}) {
  const maxFiles = options.maxFiles || 1000;
  const depth = options.depth || 4;
  const skipTop = options.skipTop || new Set();
  const files = [];
  const skipped = [];
  const pending = [''];
  let visited = 0;
  while (pending.length) {
    const relDir = pending.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (++visited > maxFiles * 20) throw new Error('The folder has too many entries');
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const shown = rel.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?');
      if (!relDir && skipTop.has(entry.name)) continue;
      if (CONTROL_RE.test(entry.name)) { skipped.push({ rel: shown, why: 'its name holds a control character' }); continue; }
      if (entry.name.startsWith('.') || JUNK_NAMES.has(entry.name)) { skipped.push({ rel: shown, why: 'hidden' }); continue; }
      if (!entry.isDirectory() && JUNK_FILE_RE.test(entry.name)) { skipped.push({ rel: shown, why: 'junk' }); continue; }
      if (entry.isSymbolicLink()) { skipped.push({ rel: shown, why: 'a symbolic link, never followed' }); continue; }
      if (entry.isDirectory()) {
        if (rel.split('/').length >= depth) { skipped.push({ rel: shown + '/', why: `nested deeper than ${depth} levels` }); continue; }
        pending.push(rel);
        continue;
      }
      if (!entry.isFile()) { skipped.push({ rel: shown, why: 'not a regular file' }); continue; }
      const abs = path.join(root, rel);
      files.push({ rel, abs, bytes: fs.lstatSync(abs).size });
      if (files.length > maxFiles) throw new Error(`The folder has more than ${maxFiles} files`);
    }
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  skipped.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, skipped };
}

/* Copies one regular file (never over an existing one), checks the copy byte for byte through its hash, and returns the hash.
   expected: the hash the file must have (a mismatch removes the copy and throws). */
function copyVerified(source, target, expected) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, 0o644);
  const actual = hashFile(target);
  if (expected && actual !== expected) {
    fs.rmSync(target, { force: true });
    throw new Error(`${path.basename(source)} is not the file that was announced (its hash differs)`);
  }
  return actual;
}

/* Copies one regular file as a stream (the event loop stays free for a file of hundreds of megabytes), never over an existing file and
   never through a link, while hashing the bytes it writes. shouldStop() is asked for every chunk and ends the copy with Stopped.
   expected: the hash the bytes must have; a mismatch removes the copy and throws. Resolves { sha256, bytes }. */
async function copyHashed(source, target, options = {}) {
  const { expected, shouldStop } = options;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const handle = await fs.promises.open(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let written = false;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${path.basename(source)} is not a regular file`);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const meter = new Transform({
      transform(chunk, encoding, done) {
        if (shouldStop && shouldStop()) { done(new Stopped('stopped')); return; }
        hash.update(chunk);
        bytes += chunk.length;
        done(null, chunk);
      },
    });
    written = true;
    await pipeline(handle.createReadStream(), meter, fs.createWriteStream(target, { flags: 'wx', mode: 0o644 }));
    written = false;
    fs.chmodSync(target, 0o644);
    const sha256 = hash.digest('hex');
    if (expected && sha256 !== expected) {
      fs.rmSync(target, { force: true });
      throw new Error(`${path.basename(source)} is not the file that was announced (its hash differs)`);
    }
    return { sha256, bytes };
  } catch (error) {
    if (written) fs.rmSync(target, { force: true });
    throw error;
  } finally {
    await handle.close().catch(() => {});
  }
}

/* The text of a file when it is text (a known text extension, valid UTF-8, no NUL), cut to `max`; null otherwise. */
function readTextFile(file, max) {
  if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) return null;
  let buffer;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return null;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      buffer = Buffer.alloc(Math.min(stat.size, max));
      fs.readSync(fd, buffer, 0, buffer.length, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  if (buffer.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return null; }
}

/* Whitespace collapsed and lower case, for the leak check. */
const squash = text => String(text).replace(/\s+/gu, ' ').trim().toLowerCase();

/* A sum of money in dollars to the cent, half a cent rounded up: 27.025 is 27.03 (toFixed(2) gives 27.02 for it). */
const usdText = value => (Math.round(Math.round(Number(value) * 1e6) / 1e6 * 100 + 1e-7) / 100).toFixed(2);

function removeTree(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = {
  usdText, isObject, sha256Hex, clone, CONTROL_RE, JUNK_NAMES, JUNK_FILE_RE, isJunkName, Stopped, copyHashed, TEXT_EXTENSIONS, capText, oneLine, writeJsonAtomic, writeTextAtomic, readJson,
  within, nameProblem, walkFiles, copyVerified, readTextFile, squash, removeTree, delay, hashFile,
};
