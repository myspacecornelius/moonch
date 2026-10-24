'use strict';
/* The safety checks that stand between the withheld material and a pilot.

   WITHHELD material: the grader guideline, the golden answer, everything the designer wrote that is not meant for pilots (its
   guideline, golden answer and traps file), the business prompt when it was a file, and every file whose package-engine.js
   classifyPath role is evaluator, run-evidence or audit. None of it may be in work/filesystem, the folder a pilot packet is made from.

   verifyPacket runs before EVERY round and again against what the agent service recorded for the round. It reads the folder as it is
   on disk, not as it was built: the set of files must be exactly the manifest, every hash must match, no file may be byte for byte a
   withheld file, no name may be a withheld name, and no name may be grading material by the shared rule. Any doubt fails closed
   (SafetyError): the round is not created. */

const fs = require('node:fs');
const path = require('node:path');
const { classifyPath, WITHHELD_ROLES } = require('../../package-engine.js');
const { DESIGN } = require('./constants.cjs');
const { sha256Hex, squash, hashFile } = require('./util.cjs');

/* message is shown to the owner and kept in the state; detail, when there is one, names the file and goes to the pipeline's private error.log
   only (a name chosen by the designer can say where a trap is). */
class SafetyError extends Error {
  constructor(message, detail) {
    super(message);
    this.detail = detail || message;
  }
}

const EMPTY_SHA = sha256Hex('');

/* Every file below dir as [{ name, bytes, sha256 }], sorted. Anything that is not a regular file or a folder (a link, a socket) is an error. */
function treeManifest(dir) {
  const out = [];
  const visit = relDir => {
    for (const entry of fs.readdirSync(path.join(dir, relDir), { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new SafetyError('The pilot packet holds a link', `The pilot packet holds a link (${rel.slice(0, 120)})`);
      if (entry.isDirectory()) { visit(rel); continue; }
      if (!entry.isFile()) throw new SafetyError('The pilot packet holds something that is not a file', `The pilot packet holds something that is not a file (${rel.slice(0, 120)})`);
      const abs = path.join(dir, rel);
      out.push({ name: rel, bytes: fs.lstatSync(abs).size, sha256: hashFile(abs) });
    }
  };
  visit('');
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/* manifest: [{ name, bytes, sha256 }] as built. withheldHashes: Set of sha256. withheldNames: Set of lower case names.
   Returns the manifest read from disk when everything holds. */
function verifyPacket({ dir, manifest, withheldHashes, withheldNames }) {
  let actual;
  try {
    actual = treeManifest(dir);
  } catch (error) {
    if (error instanceof SafetyError) throw error;
    throw new SafetyError('The pilot packet could not be read');
  }
  if (!actual.length) throw new SafetyError('The pilot packet is empty');
  const expected = new Map(manifest.map(file => [file.name, file]));
  if (expected.size !== actual.length || actual.some(file => !expected.has(file.name))) {
    throw new SafetyError('The pilot packet is not the set of files that was built (a file was added or removed)');
  }
  for (const file of actual) {
    const built = expected.get(file.name);
    if (built.sha256 !== file.sha256 || built.bytes !== file.bytes) throw new SafetyError('A file of the pilot packet changed after it was built', `A file of the pilot packet changed after it was built (${file.name.slice(0, 120)})`);
    if (file.sha256 !== EMPTY_SHA && withheldHashes.has(file.sha256)) throw new SafetyError('A file of the pilot packet is byte for byte withheld material', `A file of the pilot packet is byte for byte withheld material (${file.name.slice(0, 120)})`);
    if (withheldNames.has(file.name.toLowerCase())) throw new SafetyError('A file of the pilot packet carries the name of withheld material', `A file of the pilot packet carries the name of withheld material (${file.name.slice(0, 120)})`);
    if (WITHHELD_ROLES.includes(classifyPath(file.name).role)) throw new SafetyError('A file of the pilot packet looks like grading material by name', `A file of the pilot packet looks like grading material by name (${file.name.slice(0, 120)})`);
  }
  return actual;
}

/* What the agent service recorded for the round must be exactly the manifest, every file included. */
function verifyRoundPacket(round, manifest) {
  const files = round && round.packet && Array.isArray(round.packet.files) ? round.packet.files : [];
  const expected = new Map(manifest.map(file => [file.name, file.sha256]));
  if (files.length !== expected.size || files.some(file => !file.include || expected.get(file.path) !== file.sha256)) {
    throw new SafetyError('The round the agent service made does not hold exactly the files that were checked');
  }
}

/* The windows of a withheld text used by the leak check: its squashed form cut into overlapping pieces of DESIGN.leakWindow characters
   (80), a new piece every DESIGN.leakStep characters (30), and the last piece; the whole text when it is shorter. A text of fewer than 40
   characters gives none. */
function leakWindows(text) {
  const s = squash(text);
  if (s.length < 40) return [];
  const size = DESIGN.leakWindow;
  if (s.length <= size) return [s];
  const out = [];
  for (let at = 0; at + size <= s.length; at += DESIGN.leakStep) out.push(s.slice(at, at + size));
  out.push(s.slice(-size));
  return out;
}

/* True when the text holds any of the windows. */
function containsLeak(text, windows) {
  if (!windows.length) return false;
  const s = squash(text);
  return windows.some(window => s.includes(window));
}

module.exports = { SafetyError, EMPTY_SHA, treeManifest, verifyPacket, verifyRoundPacket, leakWindows, containsLeak };
