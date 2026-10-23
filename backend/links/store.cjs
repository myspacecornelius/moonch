'use strict';
/* What the loader keeps on disk besides the downloads: private folders and the per-host "where the show-all-files switch is" store.

   ensurePrivateDir   a folder that is really a folder (not a symlink), owned by this account, mode 0700 (tightened if looser). Used for
                      <root>/private/links, <root>/private/links/<id> and the Chrome profile <root>/private/link-profile.
   mapping store      <root>/private/link-mappings.json: { schema, version, hosts: { "<host>": { updatedAt, allFilesToggle } } }. It keeps
                      WHERE to look (the switch's label), never what was found. Strict on read: an unknown key, a wrong type or an
                      over-limit value makes the whole file count as empty, so the store cannot carry content. Written atomically
                      (temp file then rename), mode 0600.
   Exports: ensurePrivateDir, writeJsonAtomic, readMappings, learnedToggle, learnToggle, STORE_LIMITS. */

const fs = require('node:fs');
const path = require('node:path');

class StoreError extends Error {}

/* mode 0700, created when missing. Refuses a symlink, a file, a folder owned by someone else. */
function ensurePrivateDir(dir, { create = true } = {}) {
  let stat = null;
  try { stat = fs.lstatSync(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!stat) {
    if (!create) throw new StoreError('Folder is missing.');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    stat = fs.lstatSync(dir);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new StoreError('A private folder is a link or not a folder; refusing to use it.');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new StoreError('A private folder belongs to another account; refusing to use it.');
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  return dir;
}

/* Temp file in the same folder, then rename: a reader never sees half a file. */
function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  try { fs.renameSync(temp, file); } catch (e) { fs.rmSync(temp, { force: true }); throw e; }
}

const STORE_LIMITS = { hosts: 50, valueChars: 200, fileBytes: 256 * 1024 };
const HOST_RE = /^[a-z0-9.:\[\]-]{1,260}$/;
const HIDDEN_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const emptyStore = () => ({ schema: 'finance-link-mappings', version: 1, hosts: Object.create(null) });

function validLabel(label) { return typeof label === 'string' && label.length > 0 && label.length <= STORE_LIMITS.valueChars && !HIDDEN_RE.test(label); }

/* The whole store, or an empty one when the file is missing or invalid in any way. */
function readMappings(file) {
  let input;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > STORE_LIMITS.fileBytes) return emptyStore();
    input = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { return emptyStore(); }
  const keysOk = (obj, allowed) => Object.keys(obj).every((k) => allowed.includes(k));
  if (!isObj(input) || !keysOk(input, ['schema', 'version', 'hosts']) || input.schema !== 'finance-link-mappings' || input.version !== 1 || !isObj(input.hosts)) return emptyStore();
  const names = Object.keys(input.hosts);
  if (names.length > STORE_LIMITS.hosts) return emptyStore();
  const hosts = Object.create(null);
  for (const host of names) {
    const entry = input.hosts[host];
    if (!HOST_RE.test(host) || !isObj(entry) || !keysOk(entry, ['updatedAt', 'allFilesToggle']) || typeof entry.updatedAt !== 'string' || !validLabel(entry.allFilesToggle)) return emptyStore();
    hosts[host] = { updatedAt: entry.updatedAt, allFilesToggle: entry.allFilesToggle };
  }
  return { schema: 'finance-link-mappings', version: 1, hosts };
}

/* The label taught for this host, or null. */
function learnedToggle(file, host) {
  const entry = readMappings(file).hosts[host];
  return entry ? entry.allFilesToggle : null;
}

/* Remember the label for the host. Returns false (and stores nothing) for a label the store would not accept back. The oldest host
   is dropped when the store is full. */
function learnToggle(file, host, label, iso) {
  if (!HOST_RE.test(host) || !validLabel(label)) return false;
  const store = readMappings(file);
  store.hosts[host] = { updatedAt: iso, allFilesToggle: label };
  const names = Object.keys(store.hosts);
  if (names.length > STORE_LIMITS.hosts) {
    names.sort((a, b) => store.hosts[a].updatedAt.localeCompare(store.hosts[b].updatedAt));
    for (const old of names.slice(0, names.length - STORE_LIMITS.hosts)) delete store.hosts[old];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeJsonAtomic(file, store);
  return true;
}

module.exports = { ensurePrivateDir, writeJsonAtomic, readMappings, learnedToggle, learnToggle, StoreError, STORE_LIMITS };
