'use strict';
/* File names that came from the network (Content-Disposition, a link text, a download attribute) never reach the disk as they are.
   Chrome's suggestedFilename is only partly sanitised (it keeps Windows device names such as CON.txt) and with allowAndName the file
   lands under a GUID anyway, so the name is ours to choose: one flat name, no separators, no control or bidi characters, no device
   names, bounded length, unique on a case-insensitive disk. Exports: sanitizeFileName, uniqueName, insideDir, collisionKey. */

const path = require('node:path');

/* Built from code points so this file stays plain ASCII: C0 and C1 controls, DEL, line and paragraph separators, zero-width and bidi
   controls, the word joiner and invisible operators, the byte order mark, plus the characters Windows and the shell treat specially. */
const UNSAFE_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff]];
const hex4 = (n) => '\\u' + n.toString(16).padStart(4, '0');
const UNSAFE = new RegExp('[' + UNSAFE_RANGES.map(([a, b]) => (a === b ? hex4(a) : hex4(a) + '-' + hex4(b))).join('') + '<>:"|?*\\\\/]', 'gu');
const DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9\xb9\xb2\xb3]|lpt[1-9\xb9\xb2\xb3])(?:\..*)?$/iu;
const MAX_BYTES = 120;

const bytes = (s) => Buffer.byteLength(s, 'utf8');
function clipBytes(text, limit) {
  if (bytes(text) <= limit) return text;
  let out = '';
  for (const ch of text) { if (bytes(out + ch) > limit) break; out += ch; }
  return out;
}
function splitExt(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return [name, ''];
  const ext = name.slice(dot);
  return /^\.[A-Za-z0-9]{1,12}$/.test(ext) ? [name.slice(0, dot), ext] : [name, ''];
}

/* Returns { name, changed, reasons }. Never throws, never returns an empty name. */
function sanitizeFileName(raw, fallback = 'file') {
  const reasons = [];
  let name = String(raw == null ? '' : raw).normalize('NFC');
  const original = name;
  const segments = name.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');   /* a path: keep the last real segment */
  if (segments.length > 1 || segments.includes('..')) reasons.push('path');
  name = segments.filter((s) => s !== '..').pop() || '';
  const cleaned = name.replace(UNSAFE, '_');
  if (cleaned !== name) reasons.push('characters');
  name = cleaned.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '');
  if (name !== cleaned) reasons.push('dots-or-spaces');
  if (!name) { name = fallback; reasons.push('empty'); }
  if (DEVICE.test(name)) { name = '_' + name; reasons.push('device-name'); }
  if (bytes(name) > MAX_BYTES) {
    const [stem, ext] = splitExt(name);
    name = clipBytes(stem, MAX_BYTES - bytes(ext)) + ext;
    reasons.push('length');
  }
  return { name, changed: name !== original, reasons };
}

/* Case-insensitive, Unicode-normalising key: "Report.XLSX" and "report.xlsx" are one file on APFS and NTFS. */
const collisionKey = (name) => name.normalize('NFKC').toLowerCase();

/* "a.csv", "a (2).csv", "a (3).csv". Adds the chosen name to `taken` (a Set of collision keys). */
function uniqueName(name, taken) {
  const [stem, ext] = splitExt(name);
  let candidate = name;
  for (let n = 2; taken.has(collisionKey(candidate)); n += 1) candidate = `${clipBytes(stem, MAX_BYTES - bytes(ext) - 8)} (${n})${ext}`;
  taken.add(collisionKey(candidate));
  return candidate;
}

/* True when `file` is directly inside `dir` (one level) once both are resolved. */
function insideDir(dir, file) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep);
}

module.exports = { sanitizeFileName, uniqueName, insideDir, collisionKey, MAX_BYTES };
