'use strict';
/* Import: bring the captured task into <workspace>/original/ from either of two places and describe it the same way.
     - the link loader's finished load (<root>/private/links/<id>/files/<name> and page.json), every file checked against the hash
       the loader announced;
     - a folder the owner downloaded by hand (an absolute path outside the Studio project): every regular file below it, plus an
       optional page.json of the loader's shape. The offline path of the tests.
   original/ is never written again after this: the designer works on copies. */

const fs = require('node:fs');
const path = require('node:path');
const { INTAKE } = require('./constants.cjs');
const { isObject, capText, oneLine, readJson, within, nameProblem, walkFiles, copyHashed, isJunkName, Stopped } = require('./util.cjs');

class IntakeError extends Error {}

/* A page.json (the loader's: { sections: [{ heading, text }], fileList: [{ name, group, label }], page: { origin, path } }), cut to the caps. */
function parsePage(value) {
  if (!isObject(value)) throw new IntakeError('page.json is not an object');
  const list = Array.isArray(value.sections) ? value.sections : [];
  const sections = list.slice(0, INTAKE.sections).filter(isObject).map(item => ({
    heading: oneLine(item.heading, 300),
    text: capText(typeof item.text === 'string' ? item.text.replace(/\0/g, '') : '', INTAKE.sectionChars),
  }));
  const fileList = (Array.isArray(value.fileList) ? value.fileList : []).filter(isObject).slice(0, INTAKE.files).map(item => ({
    name: typeof item.name === 'string' ? item.name : '',
    group: oneLine(item.group, 200),
    label: oneLine(item.label, 300),
  }));
  const page = isObject(value.page) && typeof value.page.origin === 'string'
    ? { origin: oneLine(value.page.origin, 300), path: oneLine(value.page.path, 600) }
    : null;
  return { sections, fileList, page };
}

function readPageFile(file, required) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { stat = null; }
  if (!stat || !stat.isFile()) {
    if (required) throw new IntakeError('The loaded page has no page.json, so the prompt, the guideline and the golden answer cannot be found');
    return null;
  }
  if (stat.size > INTAKE.pageBytes) throw new IntakeError('page.json is larger than the limit');
  try { return parsePage(readJson(file)); } catch (error) {
    throw new IntakeError(`page.json could not be read (${error instanceof IntakeError ? error.message : 'not valid JSON'})`);
  }
}

/* Copies announced files into original/ one after the other, as streams, and returns [{ name, bytes, sha256, group, label }]. The hash is
   taken from the bytes written and must be the announced one when there is one. shouldStop() is asked between files and for every chunk. */
async function copyAll(entries, original, shouldStop) {
  if (entries.length > INTAKE.files) throw new IntakeError(`The task has more than ${INTAKE.files} files`);
  let total = 0;
  const out = [];
  const seen = new Set();
  for (const entry of entries) {
    if (shouldStop && shouldStop()) throw new Stopped('stopped');
    const key = entry.name.toLowerCase();
    if (seen.has(key)) throw new IntakeError(`Two files share the name ${entry.name}`);
    seen.add(key);
    total += entry.bytes;
    if (entry.bytes > INTAKE.fileBytes) throw new IntakeError(`${entry.name} is larger than ${Math.round(INTAKE.fileBytes / 1048576)} MB`);
    if (total > INTAKE.totalBytes) throw new IntakeError('The task files together are larger than the limit');
    let copied;
    try {
      copied = await copyHashed(entry.abs, path.join(original, ...entry.name.split('/')), { expected: entry.sha256, shouldStop });
    } catch (error) {
      if (error instanceof Stopped) throw error;
      throw new IntakeError(entry.sha256 && /hash differs/.test(String(error && error.message))
        ? `The loaded file ${oneLine(entry.name, 200)} does not match the hash the loader recorded`
        : `${oneLine(entry.name, 200)} could not be copied`);
    }
    if (copied.bytes !== entry.bytes) throw new IntakeError(`${oneLine(entry.name, 200)} changed while it was copied`);
    out.push({ name: entry.name, bytes: copied.bytes, sha256: copied.sha256, group: entry.group || '', label: entry.label || '' });
  }
  return out;
}

/* The loader's finished state -> original/. The folder must be the loader's own (<root>/private/links/<id>). */
async function intakeFromLoader({ state, root, original, shouldStop }) {
  if (!isObject(state) || typeof state.folder !== 'string' || !path.isAbsolute(state.folder)) throw new IntakeError('The link loader did not say where it saved the files');
  let folder;
  let linksRoot;
  try {
    folder = fs.realpathSync(state.folder);
    linksRoot = fs.realpathSync(path.join(root, 'private', 'links'));
  } catch {
    throw new IntakeError('The loaded files are not where the link loader said they are');
  }
  if (folder === linksRoot || !within(folder, linksRoot)) throw new IntakeError('The loaded files are outside the Studio\'s links folder, so they were not used');
  const filesDir = path.join(folder, 'files');
  const entries = [];
  const skipped = [];
  for (const item of Array.isArray(state.files) ? state.files : []) {
    if (!isObject(item) || typeof item.name !== 'string') continue;
    const problem = nameProblem(item.name, INTAKE.depth) || (isJunkName(item.name) ? 'it is a system or lock file' : '');
    if (problem) { skipped.push({ name: oneLine(item.name, 200), why: problem }); continue; }
    const abs = path.join(filesDir, ...item.name.split('/'));
    let stat;
    try {
      stat = fs.lstatSync(abs);
      if (!stat.isFile() || fs.realpathSync(abs) !== abs) stat = null;
    } catch { stat = null; }
    if (!stat) throw new IntakeError(`The loaded file ${oneLine(item.name, 200)} is missing`);
    if (typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256)) throw new IntakeError(`The loaded file ${oneLine(item.name, 200)} has no hash`);
    entries.push({ name: item.name, abs, bytes: stat.size, sha256: item.sha256, group: oneLine(item.group, 200), label: oneLine(item.label, 300) });
  }
  const page = readPageFile(path.join(folder, 'page.json'), true);
  const files = await copyAll(entries, original, shouldStop);
  const toggle = isObject(state.toggle) ? {
    found: state.toggle.found === true,
    label: oneLine(state.toggle.label, 300),
    flipped: state.toggle.flipped === true,
    filesBefore: Number.isInteger(state.toggle.filesBefore) ? state.toggle.filesBefore : null,
    filesAfter: Number.isInteger(state.toggle.filesAfter) ? state.toggle.filesAfter : null,
    learned: state.toggle.learned === true,
  } : null;
  return { files, sections: page.sections, page: isObject(state.page) && typeof state.page.origin === 'string' ? { origin: oneLine(state.page.origin, 300), path: oneLine(state.page.path, 600) } : page.page, toggle, skipped };
}

/* A folder of files (and optionally a page.json) -> original/. realDir comes from resolveSourceDir: absolute, real, outside the project. */
async function intakeFromFolder({ realDir, original, shouldStop }) {
  let walked;
  try {
    walked = walkFiles(realDir, { maxFiles: INTAKE.files, depth: INTAKE.depth, skipTop: new Set(['page.json']) });
  } catch (error) {
    throw new IntakeError(error && error.message ? error.message : 'The folder could not be read');
  }
  const page = readPageFile(path.join(realDir, 'page.json'), false);
  const described = new Map((page ? page.fileList : []).map(item => [item.name, item]));
  const entries = walked.files.map(file => ({ name: file.rel, abs: file.abs, bytes: file.bytes, group: (described.get(file.rel) || {}).group || '', label: (described.get(file.rel) || {}).label || '' }));
  const files = await copyAll(entries, original, shouldStop);
  return { files, sections: page ? page.sections : [], page: page ? page.page : null, toggle: null, skipped: walked.skipped.map(item => ({ name: item.rel, why: item.why })) };
}

module.exports = { IntakeError, parsePage, intakeFromLoader, intakeFromFolder };
