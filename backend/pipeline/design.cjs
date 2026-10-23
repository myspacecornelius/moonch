'use strict';
/* Design: the trap designer's instructions, its feedback on a redesign, and the checks on what it hands back.

   The designer is a Claude Code run WITH tools in <workspace>/designer/ (its working folder). It reads task/ (copies of the world and
   task files), prompt.txt, guideline.md, golden-answer.md and ideas.txt, and writes out/: new files under out/new/, edited copies of
   world files under out/edited/ (each listed with a reason), prompt.txt, guideline.md, golden-answer.md and traps.json.

   readDesign validates all of that against the disk and throws DesignError, with a message that names no model text, when anything is
   wrong. buildWork then makes the pilot packet (work/filesystem): the world and task files that are not withheld, the edited copies
   in place of their originals, and the new files. The originals are never touched. */

const fs = require('node:fs');
const path = require('node:path');
const { GAF_PATTERN } = require('../../package-engine.js');
const C = require('../agents/constants.cjs');
const { parseFigure } = require('../agents/classify.cjs');
const { DESIGN, INTAKE } = require('./constants.cjs');
const { isObject, oneLine, capText, nameProblem, walkFiles, copyVerified, hashFile, TEXT_EXTENSIONS } = require('./util.cjs');
const { withheldReason } = require('./classify.cjs');
const { containsLeak, leakWindows, EMPTY_SHA } = require('./safety.cjs');
const { sha256Hex } = require('./util.cjs');

class DesignError extends Error {}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const READ_CAP = 4 * 1024 * 1024;

/* ------------------------------------------------------------------ what the designer is given */

/* ideas.txt: the mechanism catalog (idea-archetypes.js), one block per mechanism: id, name, kind, mechanism tag and the one-line summary.
   The ranking of ideas-model.js needs the owner's precedent workbook, which a pipeline does not have, so the order is the catalog's. */
function catalogText() {
  let archetypes = [];
  try { archetypes = require('../../idea-archetypes.js').archetypes || []; } catch { archetypes = []; }
  const lines = ['Catalog of mechanisms for building traps. One block per idea: id | name | kind | mechanism, then what it does.', ''];
  for (const item of archetypes) {
    lines.push(`${item.id} | ${item.name} | ${item.kind} | ${item.mechanism}`, `  ${oneLine(item.summary, 400)}`);
  }
  return lines.join('\n') + '\n';
}

const DESIGNER_RULES = [
  'You are the trap designer for one finance task. Your working folder is the current folder. Work only inside it.',
  '',
  'What is here:',
  '- task/             the world files and task files the pilots will receive. Read them. Do not change them.',
  '- prompt.txt        the business prompt the pilots are given now.',
  '- guideline.md      the grader guideline now.',
  '- golden-answer.md  the golden answer now.',
  '- ideas.txt         the catalog of trap mechanisms: id, name, kind, mechanism, and one line each.',
];

const DESIGNER_TASK = [
  '',
  'Goal: build the 1 to 3 hardest traps for this task, using ideas from the catalog, so that a careful blind pilot gives a wrong final answer and a simulated grader scores that answer below 0.45 against the guideline. A trap has one correct reading and one tempting wrong reading, and the supplied files must settle which is which.',
  '',
  'How to build it:',
  '1. Prefer NEW files. Write each under out/new/ (sub folders allowed, at most three levels in all). A new file is an ordinary source document of the task and must read like one.',
  '2. Edit an existing world or task file only when a trap cannot work without it. Copy the file to out/edited/<same name>, change the copy, and list it in editedFiles with a reason. Never change files in task/.',
  `3. Write out/prompt.txt: the business prompt the pilots receive, at most ${DESIGN.promptChars} characters. Keep what the task asks for and change it only as far as a trap needs. It must not mention traps, mechanisms or the guideline.`,
  `4. Write out/guideline.md: the grader guideline that matches your design, at most ${DESIGN.guidelineChars} characters. Say what a correct answer states, name the correct values, and say which wrong readings fail.`,
  '5. Write out/golden-answer.md: the golden answer that matches your design.',
  '6. Write out/traps.json, valid JSON in exactly this shape:',
  '{"traps": [{"id": "t1", "title": "short title", "mechanism": "how the trap works", "files": ["file names the trap uses"], "decoy": "the tempting wrong source or reading", "correctValue": "...", "wrongValue": "..."}],',
  ' "gold": {"decision": "phrases a correct answer states, separated by semicolons", "figures": [{"label": "...", "value": 1250, "tolerance": 1}]},',
  ' "fingerprints": [{"id": "fp-1", "label": "the wrong reading in a few words", "tokens": ["words a wrong answer uses"], "figures": [{"label": "...", "value": 3050, "tolerance": 1}]}],',
  ' "newFiles": ["names of the files under out/new"],',
  ' "editedFiles": [{"name": "name of a file under out/edited", "reason": "why the trap cannot work without this edit"}]}',
  '',
  'Hard rules:',
  '- Everything under out/new and out/edited is sent to the pilots. Put nothing there that names a trap, a mechanism, the guideline or the golden answer, and copy no text from guideline.md or golden-answer.md into it.',
  '- The names of new and edited files must read like ordinary documents. Do not use words such as guideline, rubric, answer, golden, reference, solution, key, memo, grader, evaluation, review, audit or gaf in a name.',
  '- Do not read or write outside this folder. Do not start any program that calls a model. Do not use the network.',
  '- Finish with a short plain-text summary of the traps. Do not end the run before the four files in out/ exist.',
];

function designerPrompt({ attempt, attempts, redesign }) {
  const lines = [...DESIGNER_RULES];
  if (redesign) {
    lines.push('- feedback.md       how the last design fared: each pilot\'s score, verdict, the grader\'s reason and the final answer. Read it first.');
    lines.push('- previous/         your last design (its out/ folder), for you to strengthen or replace.');
  }
  lines.push(...DESIGNER_TASK, '', `This is design attempt ${attempt} of ${attempts}.${redesign ? ' Strengthen the traps that worked and replace the ones that did not.' : ''}`);
  return lines.join('\n') + '\n';
}

/* feedback.md for a redesign. stage: the failed stage with its pilots; history: the earlier attempts' outcomes. */
function feedbackText({ attempt, stage, history, traps }) {
  const lines = [
    `# Feedback on design attempt ${attempt}`,
    '',
    `The ${stage.name} did not pass. Rule: ${stage.rule}. The bar is a score below ${stage.bar}; ${stage.belowBar} of ${stage.pilotsWanted} counted pilots were below it.`,
    '',
    '## The traps of this attempt',
    ...traps.map(trap => `- ${trap.id}: ${trap.title}`),
    '',
    '## Pilots',
  ];
  for (const pilot of stage.pilots) {
    lines.push('', `### ${pilot.id}${pilot.replacement ? ' (replacement)' : ''}`);
    lines.push(`- state: ${pilot.state}; audit: ${pilot.audit ? pilot.audit.status : 'none'}`);
    lines.push(`- score: ${typeof pilot.score === 'number' ? pilot.score.toFixed(2) : 'none'}${pilot.score !== null && pilot.score !== undefined ? (pilot.score < stage.bar ? ' (below the bar, the design worked)' : ' (at or above the bar, the pilot got through)') : ''}`);
    if (pilot.verdict) lines.push(`- grader verdict: ${pilot.verdict}`);
    if (pilot.reason) lines.push(`- grader reason: ${pilot.reason}`);
    if (pilot.answer) lines.push('', 'Final answer:', '', capText(pilot.answer, 6000));
  }
  if (history.length) {
    lines.push('', '## Earlier attempts');
    for (const item of history) lines.push(`- attempt ${item.n}: ${item.outcome}`);
  }
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ reading what the designer wrote */

function readCapped(file, max, what) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw new DesignError(`${what} was not written`); }
  if (!stat.isFile()) throw new DesignError(`${what} is not a regular file`);
  if (stat.size > max * 4) throw new DesignError(`${what} is too large`);
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes('\0')) throw new DesignError(`${what} holds a NUL byte`);
  return text;
}

function figureList(list, where) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > 50) throw new DesignError(`${where} figures must be a list of at most 50`);
  return list.map((item, index) => {
    if (!isObject(item)) throw new DesignError(`${where} figure ${index + 1} is not an object`);
    if (parseFigure(item.value) === null) throw new DesignError(`${where} figure ${index + 1} needs a numeric value`);
    const tolerance = item.tolerance === undefined || item.tolerance === null || item.tolerance === '' ? 0 : parseFigure(item.tolerance);
    if (tolerance === null || tolerance < 0) throw new DesignError(`${where} figure ${index + 1} needs a tolerance of zero or more`);
    return { label: oneLine(item.label, 200), value: typeof item.value === 'number' ? item.value : String(item.value).trim(), tolerance };
  });
}

function textValue(value, max, what) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') throw new DesignError(`${what} must be text`);
  if (value.length > max) throw new DesignError(`${what} is longer than ${max} characters`);
  return value.trim();
}

function parseTrapsFile(text, available) {
  let data;
  try { data = JSON.parse(text); } catch { throw new DesignError('traps.json is not valid JSON'); }
  if (!isObject(data)) throw new DesignError('traps.json is not an object');
  if (!Array.isArray(data.traps) || data.traps.length < 1 || data.traps.length > DESIGN.traps) throw new DesignError(`traps.json needs 1 to ${DESIGN.traps} traps`);
  const seen = new Set();
  const traps = data.traps.map((item, index) => {
    if (!isObject(item)) throw new DesignError(`trap ${index + 1} is not an object`);
    const id = textValue(item.id, 64, `trap ${index + 1} id`);
    if (!ID_RE.test(id) || seen.has(id)) throw new DesignError(`trap ${index + 1} needs a unique id of letters, digits, dashes and underscores`);
    seen.add(id);
    const title = oneLine(textValue(item.title, DESIGN.titleChars, `trap ${id} title`), DESIGN.titleChars);
    if (!title) throw new DesignError(`trap ${id} needs a title`);
    const files = Array.isArray(item.files) ? item.files : [];
    if (files.length > 20 || files.some(name => typeof name !== 'string')) throw new DesignError(`trap ${id} files must be a list of at most 20 names`);
    for (const name of files) if (!available.has(name)) throw new DesignError(`trap ${id} names a file that is not in the pilot packet`);
    return {
      id,
      title,
      mechanism: textValue(item.mechanism === undefined ? '' : item.mechanism, DESIGN.textChars, `trap ${id} mechanism`),
      files: files.slice(),
      decoy: textValue(item.decoy === undefined ? '' : item.decoy, DESIGN.textChars, `trap ${id} decoy`),
      correctValue: textValue(item.correctValue === undefined ? '' : item.correctValue, 200, `trap ${id} correctValue`),
      wrongValue: textValue(item.wrongValue === undefined ? '' : item.wrongValue, 200, `trap ${id} wrongValue`),
    };
  });
  if (!isObject(data.gold)) throw new DesignError('traps.json needs a gold object');
  const decision = textValue(data.gold.decision === undefined ? '' : data.gold.decision, DESIGN.textChars, 'gold.decision');
  const figures = figureList(data.gold.figures, 'gold');
  if (!figures.length && !decision.split(';').some(part => part.trim())) throw new DesignError('The gold needs at least one figure or one decision phrase');
  const prints = data.fingerprints === undefined || data.fingerprints === null ? [] : data.fingerprints;
  if (!Array.isArray(prints) || prints.length > 20) throw new DesignError('fingerprints must be a list of at most 20');
  const printIds = new Set();
  const fingerprints = prints.map((item, index) => {
    if (!isObject(item)) throw new DesignError(`fingerprint ${index + 1} is not an object`);
    const id = textValue(item.id, 64, `fingerprint ${index + 1} id`);
    if (!ID_RE.test(id) || printIds.has(id)) throw new DesignError(`fingerprint ${index + 1} needs a unique id`);
    printIds.add(id);
    const tokens = (Array.isArray(item.tokens) ? item.tokens : []).filter(token => typeof token === 'string').map(token => token.trim()).filter(Boolean);
    if (tokens.length > 30 || tokens.some(token => token.length > 200)) throw new DesignError(`fingerprint ${id} has too many or too long tokens`);
    const printFigures = figureList(item.figures, `fingerprint ${id}`);
    if (!tokens.length && !printFigures.length) throw new DesignError(`fingerprint ${id} needs a token or a figure`);
    return { id, label: oneLine(item.label, 200), tokens, figures: printFigures };
  });
  const listedNew = Array.isArray(data.newFiles) ? data.newFiles.filter(name => typeof name === 'string') : [];
  const listedEdited = Array.isArray(data.editedFiles) ? data.editedFiles.filter(isObject) : [];
  return { traps, gold: { decision, figures }, fingerprints, listedNew, listedEdited };
}

/* Everything out/ holds, validated against the disk and the withheld material. packet: Map(name -> { sha256 }) of the base packet (the
   world and task files that are not withheld). withheldHashes: Set. windows: leak windows of every withheld text (safety.leakWindows).
   Returns the design, with the lists of new and edited files as they are on disk. */
function readDesign({ outDir, packet, withheldHashes, windows }) {
  const notes = [];
  const prompt = readCapped(path.join(outDir, 'prompt.txt'), DESIGN.promptChars, 'out/prompt.txt').replace(/\s+$/, '');
  if (!prompt.trim()) throw new DesignError('out/prompt.txt is empty');
  if (prompt.length > DESIGN.promptChars) throw new DesignError(`out/prompt.txt is longer than ${DESIGN.promptChars} characters`);
  if (prompt.startsWith('-')) throw new DesignError('out/prompt.txt must not start with a dash');
  const guideline = readCapped(path.join(outDir, 'guideline.md'), DESIGN.guidelineChars, 'out/guideline.md').replace(/\s+$/, '');
  if (!guideline.trim()) throw new DesignError('out/guideline.md is empty');
  if (guideline.length > DESIGN.guidelineChars) throw new DesignError(`out/guideline.md is longer than ${DESIGN.guidelineChars} characters`);
  const goldenAnswer = readCapped(path.join(outDir, 'golden-answer.md'), DESIGN.goldenChars, 'out/golden-answer.md').replace(/\s+$/, '');
  if (!goldenAnswer.trim()) throw new DesignError('out/golden-answer.md is empty');
  if (goldenAnswer.length > DESIGN.goldenChars) throw new DesignError(`out/golden-answer.md is longer than ${DESIGN.goldenChars} characters`);
  const trapsText = readCapped(path.join(outDir, 'traps.json'), 200000, 'out/traps.json');
  /* What the designer wrote for itself is withheld too: its guideline, golden answer and traps file are never a pilot's file, and a
     passage of the first two is never in the prompt or in a file a pilot receives. */
  withheldHashes = new Set([...withheldHashes, sha256Hex(guideline), sha256Hex(guideline + '\n'), sha256Hex(goldenAnswer), sha256Hex(goldenAnswer + '\n'), sha256Hex(trapsText)]);
  for (const name of ['guideline.md', 'golden-answer.md', 'traps.json']) {
    try { withheldHashes.add(hashFile(path.join(outDir, name))); } catch { /* read above */ }
  }
  windows = [...windows, ...leakWindows(guideline), ...leakWindows(goldenAnswer)];

  const lowerPacket = new Map([...packet.keys()].map(name => [name.toLowerCase(), name]));
  const lister = sub => {
    const dir = path.join(outDir, sub);
    if (!fs.existsSync(dir)) return [];
    try {
      const walked = walkFiles(dir, { maxFiles: DESIGN.newFiles, depth: INTAKE.depth });
      if (walked.skipped.length) throw new DesignError(`out/${sub} holds an entry that cannot be used (${walked.skipped[0].rel.slice(0, 120)}: ${walked.skipped[0].why})`);
      return walked.files;
    } catch (error) {
      if (error instanceof DesignError) throw error;
      throw new DesignError(`out/${sub} could not be read (${error && error.message ? error.message.slice(0, 120) : 'error'})`);
    }
  };
  const newOnDisk = lister('new');
  const editedOnDisk = lister('edited');
  if (newOnDisk.length + editedOnDisk.length > DESIGN.newFiles) throw new DesignError('The designer wrote too many files');

  const fileChecks = (file, kind) => {
    const problem = nameProblem(file.rel, INTAKE.depth);
    if (problem) throw new DesignError(`${kind} file ${oneLine(file.rel, 120)}: ${problem}`);
    if (GAF_PATTERN.test(file.rel)) throw new DesignError(`${kind} file ${oneLine(file.rel, 120)} is in a gaf path, which pilots never see`);
    const why = withheldReason(file.rel);
    if (why) throw new DesignError(`${kind} file ${oneLine(file.rel, 120)} looks like grading material by name (${why})`);
    const sha256 = hashFile(file.abs);
    if (sha256 !== EMPTY_SHA && withheldHashes.has(sha256)) throw new DesignError(`${kind} file ${oneLine(file.rel, 120)} is a copy of withheld material`);
    if (TEXT_EXTENSIONS.has(path.extname(file.rel).toLowerCase()) && file.bytes <= READ_CAP) {
      let text = '';
      try { text = fs.readFileSync(file.abs, 'utf8'); } catch { text = ''; }
      if (containsLeak(text, windows)) throw new DesignError(`${kind} file ${oneLine(file.rel, 120)} holds a long passage of the guideline or the golden answer`);
    }
    return { name: file.rel, bytes: file.bytes, sha256 };
  };

  const taken = new Set();
  const newFiles = newOnDisk.map(file => {
    const key = file.rel.toLowerCase();
    if (lowerPacket.has(key)) throw new DesignError(`new file ${oneLine(file.rel, 120)} has the name of an existing file; edit that file instead and list it with a reason`);
    if (taken.has(key)) throw new DesignError(`new file ${oneLine(file.rel, 120)} is named twice`);
    taken.add(key);
    return fileChecks(file, 'new');
  });
  const editedFiles = editedOnDisk.map(file => {
    if (!packet.has(file.rel)) throw new DesignError(`edited file ${oneLine(file.rel, 120)} is not a world or task file; write it under out/new instead`);
    return fileChecks(file, 'edited');
  });

  const available = new Set([...packet.keys(), ...newFiles.map(file => file.name)]);
  const parsed = parseTrapsFile(trapsText, available);
  for (const name of parsed.listedNew) if (!newFiles.some(file => file.name === name)) throw new DesignError(`traps.json lists the new file ${oneLine(name, 120)} but out/new does not hold it`);
  const unlisted = newFiles.filter(file => !parsed.listedNew.includes(file.name));
  if (unlisted.length) notes.push(`${unlisted.length} new file${unlisted.length === 1 ? ' was' : 's were'} not listed in traps.json and ${unlisted.length === 1 ? 'is' : 'are'} included anyway.`);
  const reasons = new Map();
  for (const item of parsed.listedEdited) {
    const name = typeof item.name === 'string' ? item.name : '';
    const reason = typeof item.reason === 'string' ? oneLine(item.reason, DESIGN.reasonChars) : '';
    if (!editedFiles.some(file => file.name === name)) throw new DesignError(`traps.json lists the edited file ${oneLine(name, 120)} but out/edited does not hold it`);
    if (!reason) throw new DesignError(`the edit of ${oneLine(name, 120)} has no reason`);
    reasons.set(name, reason);
  }
  for (const file of editedFiles) if (!reasons.has(file.name)) throw new DesignError(`the edited file ${oneLine(file.name, 120)} is not listed with a reason`);
  for (const file of editedFiles) {
    file.reason = reasons.get(file.name);
    if (file.sha256 === packet.get(file.name).sha256) notes.push(`${file.name} is listed as edited but is identical to the original.`);
  }

  const total = packet.size + newFiles.length;
  let bytes = newFiles.reduce((sum, file) => sum + file.bytes, 0);
  for (const [name, entry] of packet) bytes += (editedFiles.find(file => file.name === name) || entry).bytes;
  if (total > C.LIMITS.files) throw new DesignError(`The pilot packet would hold ${total} files; the limit is ${C.LIMITS.files}`);
  if (bytes > C.LIMITS.bytes) throw new DesignError('The pilot packet would be larger than the packet limit');

  if (containsLeak(prompt, windows)) throw new DesignError('out/prompt.txt holds a long passage of the guideline or the golden answer');
  return { prompt, guideline, goldenAnswer, traps: parsed.traps, gold: parsed.gold, fingerprints: parsed.fingerprints, newFiles, editedFiles, notes };
}

/* ------------------------------------------------------------------ the pilot packet */

/* work/filesystem: the base packet from original/ (an edited copy from out/edited in place of its original) and the new files from
   out/new. Every copy is checked against the hash it must have. Returns the manifest, [{ name, bytes, sha256 }], sorted. */
function buildWork({ originalDir, outDir, workDir, packet, design }) {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const edited = new Map(design.editedFiles.map(file => [file.name, file]));
  const manifest = [];
  try {
    for (const [name, entry] of packet) {
      const change = edited.get(name);
      const source = change ? path.join(outDir, 'edited', ...name.split('/')) : path.join(originalDir, ...name.split('/'));
      const expected = change ? change.sha256 : entry.sha256;
      const sha256 = copyVerified(source, path.join(workDir, ...name.split('/')), expected);
      manifest.push({ name, bytes: fs.lstatSync(path.join(workDir, ...name.split('/'))).size, sha256 });
    }
    for (const file of design.newFiles) {
      const sha256 = copyVerified(path.join(outDir, 'new', ...file.name.split('/')), path.join(workDir, ...file.name.split('/')), file.sha256);
      manifest.push({ name: file.name, bytes: file.bytes, sha256 });
    }
  } catch (error) {
    fs.rmSync(workDir, { recursive: true, force: true });
    throw new DesignError(`The pilot packet could not be built (${error && error.message ? error.message.slice(0, 160) : 'error'})`);
  }
  return manifest.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

module.exports = { DesignError, catalogText, designerPrompt, feedbackText, readDesign, buildWork, parseTrapsFile };
