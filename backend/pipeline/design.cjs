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
const { DESIGN, INTAKE, SCREEN_BAR, GOLDEN_MIN, ALTERNATIVE_MIN } = require('./constants.cjs');
const { isObject, oneLine, capText, nameProblem, walkFiles, copyHashed, hashFile, isJunkName, squash, TEXT_EXTENSIONS, Stopped } = require('./util.cjs');
const { extractText, scanFile, ZIP_EXTENSIONS } = require('./extract.cjs');
const { lineDiff } = require('./diff.cjs');
const { withheldReason } = require('./classify.cjs');
const { containsLeak, leakWindows, WindowSet, EMPTY_SHA } = require('./safety.cjs');
const { parseBrief, briefEvaluatorText, verifyBriefSources } = require('./brief.cjs');
const { extractText: extractFileText, readerKind } = require('./extract.cjs');
const { sha256Hex } = require('./util.cjs');

const { DesignError } = require('./errors.cjs');

/* A fault in one file the designer wrote. The public message does not name the file: a new file's name can state the gold, and the name
   of an edited file shows which world file holds the trap. The name goes into the detail, for the designer only. */
function fileFault(kind, rel, text, extra) {
  const who = kind === 'edited' ? 'An edited file' : 'A new file';
  return new DesignError(`${who} ${text}`, `The ${kind === 'edited' ? 'edited' : 'new'} file ${oneLine(rel, 120)} ${text}${extra ? `. ${extra}` : ''}`);
}

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
  /* The screen comes first and its bar is the stricter one, so the design is aimed at it: a design that clears the screen clears the test's bar too. */
  `Goal: build the 1 to 3 hardest traps for this task, using ideas from the catalog, so that a careful blind pilot gives a wrong final answer and a simulated grader scores that answer below ${SCREEN_BAR.toFixed(2)} against the guideline. A trap has one correct reading and one tempting wrong reading, and the supplied files must settle which is which.`,
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
  ' "editedFiles": [{"name": "name of a file under out/edited", "reason": "why the trap cannot work without this edit"}],',
  ' "rubricChanges": [{"change": "what you added or changed in the guideline", "reason": "why"}]}',
  '   rubricChanges is needed when the new guideline is more than 1.5 times as long as the old one.',
  '',
  'Hard rules:',
  '- Every figure in gold.figures must appear in out/golden-answer.md and in out/guideline.md, written as digits (1,250 or 1250). A grader will score your golden answer against your guideline: it must score at least 0.90.',
  '- Do not state any figure of the golden answer, and do not state the decision, in out/prompt.txt or in the name of a new file.',
  '- An edited file must not be much smaller than the original (at most 20 percent), and a line-by-line comparison of your guideline and of each edit is shown to the owner.',
  '- Everything under out/new and out/edited is sent to the pilots. Put nothing there that names a trap, a mechanism, the guideline or the golden answer, and copy no text from guideline.md or golden-answer.md into it.',
  '- The names of new and edited files must read like ordinary documents. Do not use words such as guideline, rubric, answer, golden, reference, solution, key, memo, grader, evaluation, review, audit or gaf in a name.',
  '- Do not read or write outside this folder. Do not start any program that calls a model. Do not use the network.',
  '- Finish with a short plain-text summary of the traps. Do not end the run before the four files in out/ exist.',
];

/* ------------------------------------------------------------------ designer v2: a new task from the world files */

const NEW_RULES = [
  'You are the trap designer for one new finance task. Your working folder is the current folder. Work only inside it.',
  '',
  'What is here:',
  '- task/             the world files and task files the pilots will receive. Read them. Do not change them.',
  '- ideas.txt         the catalog of trap mechanisms: id, name, kind, mechanism, and one line each.',
];

const NEW_TASK = [
  '',
  `Goal: build a new task from the world files. Its hardest trap should make a careful blind pilot give a wrong final answer that a simulated grader scores below ${SCREEN_BAR.toFixed(2)} against the guideline, while the files settle which answer is right. A trap has one correct reading and one tempting wrong reading.`,
  '',
  'How to build it:',
  '1. Pick the task type (workflow) that the world files can best support; when reference documents are present, pick it from them, and borrow a mechanism from another workflow when it fits.',
  '2. Build around a documented decision, a tempting wrong path and evidence that tells them apart. Compute both paths before you write any file.',
  '3. Prefer NEW files. Write each under out/new/ (sub folders allowed, at most three levels in all). A new file is an ordinary source document of the task and must read like one. Edit an existing world or task file only when the trap cannot work without it: copy it to out/edited/<same name>, change the copy, and list it in editedFiles with a reason.',
  `4. Write out/prompt.txt: the business prompt the pilots receive, at most ${DESIGN.promptChars} characters. It must not mention traps, mechanisms or the guideline.`,
  `5. Write out/guideline.md: the grader guideline, at most ${DESIGN.guidelineChars} characters. Say what a correct answer states, name the correct values, and say which wrong readings fail. If only the reasoning is required, accept every permitted action in an "Acceptable variation" section; if one action is required, the packet must hold the decision rule that makes every other action wrong.`,
  '6. Write out/golden-answer.md: the golden answer that matches your design.',
  '7. For each permitted alternative (a different action or method that the packet allows), write out/answers/alt-N.md (N from 1): a strong answer that takes that action with correct reasoning. Keep out/answers/ out of out/new and out/edited.',
  '8. Write out/traps.json, valid JSON in exactly this shape:',
  '{"traps": [{"id": "t1", "title": "short title", "mechanism": "how the trap works", "files": ["file names the trap uses"], "decoy": "the tempting wrong source or reading", "correctValue": "...", "wrongValue": "..."}],',
  ' "gold": {"decision": "phrases a correct answer states, separated by semicolons", "figures": [{"label": "...", "value": 1250, "tolerance": 1}]},',
  ' "fingerprints": [{"id": "fp-1", "label": "the wrong reading in a few words", "tokens": ["words a wrong answer uses"], "figures": [{"label": "...", "value": 3050, "tolerance": 1}]}],',
  ' "newFiles": ["names of the files under out/new"],',
  ' "editedFiles": [{"name": "name of a file under out/edited", "reason": "why the trap cannot work without this edit"}],',
  ' "rubricChanges": []}',
  '9. Write out/brief.json, valid JSON in exactly this shape (one primary trap, at most three in all):',
  '{"taskType": {"workflow": "...", "why": "...", "referenceEntries": ["..."]},',
  ' "decision": {"ask": "...", "mandate": "...", "authorityFile": "name of the authority file", "effectiveDate": "...", "decisionDate": "YYYY-MM-DD, the day the decision of the task is taken; optional, but when you give it the day must also stand in prompt.txt or in a file the pilots get, so that the checks can quote it"},',
  ' "files": [{"name": "file name", "role": "authority" or "evidence" or "decoy" or "baseline"}],',
  ' "traps": [{"id": "t1 (the id of traps.json)", "primary": true, "rule": {"file": "name", "clause": "the exact words of the governing rule"},',
  '   "correctPath": {"reasoning": "...", "action": "...", "figures": [{"label": "...", "value": 0, "tolerance": 0}]},',
  '   "wrongPath": {"reasoning": "...", "action": "...", "figures": [{"label": "...", "value": 0, "tolerance": 0}]},',
  '   "changesDecision": "required_conclusion" or "required_calculation" or "neither",',
  '   "whyTempting": {"kind": "money" or "time" or "effort" or "accountability", "source": "the ordinary record that creates the impression"},',
  '   "consequence": {"source": "the record that makes the wrong accommodation really cost something"},',
  '   "strongestAlternative": {"answer": "...", "whyRejected": "the exact words of the clause that rules it out"}}],',
  ' "permittedAlternatives": [{"answer": "...", "support": "the clause or record that permits it", "file": "answers/alt-1.md"}],',
  ' "permittedAlternativesReason": "why there is none, when the list is empty",',
  ' "controls": [{"scenario": "baseline" or "primary_wrong" or "secondary_wrong" or "combined_wrong", "trap": "id, for secondary_wrong", "action": "...", "figures": [], "changesDecision": true}]}',
  '   controls is needed when there is more than one trap: the baseline, each single wrong path and the combination, each different from the baseline, so that one mechanism cannot mask another.',
  '',
  'Hard rules:',
  '- The wrong path must change a required conclusion (a different action) or a materially required calculation. Arithmetic movement alone does not count.',
  '- One primary trap. Any other mechanism needs its own control and a combined control that show none masks another.',
  '- The packet MUST hold a source that states the governing rule, its scope, its effective date and which document governs. Never take a rule statement out to make the task harder; if a clarification is what makes the task fair, keep it and look for difficulty elsewhere (joins across holders, date ordering, legal against cash availability, gross against net).',
  '- Do not write into any file the pilots get an explanation that applies the rule to the facts.',
  '- Name the strongest defensible alternative answer and the exact words of the clause that rule it out. If no clause rules it out, list it in permittedAlternatives (with its answer file) or change the trap.',
  '- rule.clause and strongestAlternative.whyRejected must be word for word in a file the pilots get (or in prompt.txt), each a whole sentence or at least 40 characters. Every one of them is later checked to show that it governs the decision, is in force on the decision date, has not been superseded by any file in the packet (a file the checks cannot read as text counts against you) and rules the wrong path or the alternative out. Keep the rule statements near the top of a long file.',
  '- Every figure in gold.figures must appear in out/golden-answer.md and in out/guideline.md, written as digits (1,250 or 1250). Your golden answer and each alternative answer will be graded against your guideline: the golden answer must score at least ' + GOLDEN_MIN.toFixed(2) + ' and each alternative at least ' + ALTERNATIVE_MIN.toFixed(2) + '.',
  '- Do not state any figure of the golden answer, and do not state the decision, in out/prompt.txt or in the name of a new file.',
  '- Evaluator material (guideline, golden answer, brief, answers) is never placed in out/new or out/edited, and no text of it is copied into a file the pilots get.',
  '- Dates that matter (the day a document takes effect, the day of the decision) are written in the files as 2025-03-01, 1 March 2025, March 1, 2025 or the 1st day of March, 2025. The checks read no other form (03/01/2025, 20250301 and "March 2025" fail the in-force check). When a sentence holds more than one date, say which one takes effect ("takes effect on ...").',
  '- A new file is a kind that the reviewers can read: plain text, csv, json, md, docx, xlsx, pptx, rtf, a pdf or a picture. Do not add old binary Office files (doc, xls, ppt), archives or other binaries.',
  '- An edited file must not be much smaller than the original (at most 20 percent).',
  '- The names of new and edited files must read like ordinary documents. Do not use words such as guideline, rubric, answer, golden, reference, solution, key, memo, grader, evaluation, review, audit or gaf in a name.',
  '- Reference documents are for you alone: no passage of them goes into any file the pilots get.',
  '- Do not read or write outside this folder. Do not start any program that calls a model. Do not use the network.',
  '- Finish with a short plain-text summary of the traps. Do not end the run before the files in out/ exist.',
];

function designerPromptNew({ attempt, attempts, redesign, hasReferences = false, fairnessSet = false }) {
  const lines = [...NEW_RULES];
  if (hasReferences) lines.push('- reference/       the owner\'s reference documents: what good tasks of a kind look like. For you alone. Read them with the Read tool (PDFs included).');
  if (redesign) {
    lines.push('- feedback.md       how the last design fared: what each check found, and each pilot\'s score and the reason it counted or not. Read it first.');
    lines.push('- previous/         your last design (its out/ folder), for you to strengthen or replace.');
  }
  lines.push(...NEW_TASK);
  if (fairnessSet) lines.push('', 'Also write out/answers.json and the answer files it names: for each of the six diagnostic answers (expected action with correct reasoning, high; a comparison that commits to the correct path, high; the expected action through the intended wrong reasoning, low; a dual recommendation that leaves execution unresolved, low; a wrong action with correct arithmetic, low; a genuine qualification grounded in a real source ambiguity, high) give {"name", "file": "answers/diag-N.md", "band": "high" or "low"}.');
  lines.push('', `This is design attempt ${attempt} of ${attempts}.${redesign ? ' Strengthen the traps that worked and replace the ones that did not.' : ''}`);
  return lines.join('\n') + '\n';
}

/* One repair turn for what the reviews found (designer v2): the same folder, told what to fix. what: 'alternative' (a permitted alternative:
   add it to the acceptable variation, write its answer file, update the brief), 'missing' (a requirement the packet lacks, or a guideline
   that asks for something the packet does not hold) or 'general' (the first design did not pass a check). */
function reviewRepairPrompt({ attempt, attempts, what, finding }) {
  const lines = [...NEW_RULES, '- out/              what your last run left. Change it as little as you can.'];
  lines.push('', 'WHAT THE REVIEW FOUND, exactly:', capText(String(finding), 2500), '');
  if (what === 'alternative') lines.push('This alternative is allowed by the packet. Add it to the "Acceptable variation" section of out/guideline.md, write out/answers/alt-N.md (a strong answer that takes that action with correct reasoning), and list it in permittedAlternatives of out/brief.json with its file. Change nothing else.');
  else if (what === 'equivalent') lines.push('This is a different presentation or method with the same required conclusion. Add a line to the "Acceptable variation" section of out/guideline.md so that it is accepted. Change nothing else.');
  else lines.push('Supply what is missing in the files the pilots get (a source that states the rule, its scope, its effective date and which document governs), or fix the guideline so that it asks for nothing the files do not hold. Keep every rule below.');
  lines.push(...NEW_TASK, '', `This is a repair turn for design attempt ${attempt} of ${attempts}. You have one short run: do not start the design again.`);
  return lines.join('\n') + '\n';
}

/* The one repair turn after a stage failed because the evaluator material was at fault (designer v2): only guideline.md and golden-answer.md. */
function evaluatorRepairPrompt({ attempt, attempts, finding }) {
  return [
    'You are the trap designer for one new finance task. Your working folder is the current folder. Work only inside it.',
    '',
    'The pilots have run on your design. Some answers scored low although they are acceptable, or the grading was wrong for them. The files the pilots get and the prompt are fixed and cannot change.',
    '',
    'WHAT WAS FOUND, exactly:',
    capText(String(finding), 3500),
    '',
    'Change ONLY out/guideline.md and out/golden-answer.md so that the guideline accepts what the packet allows and grades it fairly. Do not touch anything else in out/ (no new file, no edited file, no prompt, no brief, no alternative answer). Your golden answer must still score at least ' + GOLDEN_MIN.toFixed(2) + ' against the guideline.',
    '- Do not read or write outside this folder. Do not start any program that calls a model. Do not use the network.',
    '',
    `This is a guideline repair for design attempt ${attempt} of ${attempts}. You have one short run.`,
  ].join('\n') + '\n';
}

function designerPrompt({ attempt, attempts, redesign }) {
  const lines = [...DESIGNER_RULES];
  if (redesign) {
    lines.push('- feedback.md       how the last design fared: each pilot\'s score, verdict, the grader\'s reason and the final answer. Read it first.');
    lines.push('- previous/         your last design (its out/ folder), for you to strengthen or replace.');
  }
  lines.push(...DESIGNER_TASK, '', `This is design attempt ${attempt} of ${attempts}.${redesign ? ' Strengthen the traps that worked and replace the ones that did not.' : ''}`);
  return lines.join('\n') + '\n';
}

/* The one repair turn: a second run in the same folder, told the exact problem with the first one's work in out/. */
function repairPrompt({ attempt, attempts, problem, mode = 'harden' }) {
  const lines = [...(mode === 'new' ? NEW_RULES : DESIGNER_RULES), '- out/              what a first run left. It cannot be used as it is.'];
  lines.push('', 'THE PROBLEM, exactly:', capText(String(problem), 1500), '', 'Fix that problem in out/ and change as little else as you can. Keep every rule below.');
  lines.push(...(mode === 'new' ? NEW_TASK : DESIGNER_TASK), '', `This is a repair turn for design attempt ${attempt} of ${attempts}. You have one short run: do not start the design again.`);
  return lines.join('\n') + '\n';
}

/* feedback.md for a design that was rejected before any pilot ran: what each check found, in the checks' own words. */
function rejectionFeedback({ attempt, details, history }) {
  const lines = [
    `# Feedback on design attempt ${attempt}`,
    '',
    'This design was rejected before any pilot ran. Nothing was learned about how pilots do with it.',
    '',
    '## What was wrong',
    ...details.map(item => `- ${item}`),
    '',
    'Build the design again, keeping what was sound. The design you wrote is in previous/.',
  ];
  if (history.length) {
    lines.push('', '## Earlier attempts');
    for (const item of history) lines.push(`- attempt ${item.n}: ${item.outcome}`);
  }
  return lines.join('\n') + '\n';
}

/* feedback.md for a redesign. stage: the failed stage with its pilots; history: the earlier attempts' outcomes. */
function feedbackText({ attempt, stage, history, traps }) {
  const lines = [
    `# Feedback on design attempt ${attempt}`,
    '',
    `The ${stage.name} did not pass. Rule: ${stage.rule}. The bar is a score below ${stage.bar.toFixed(2)}; ${stage.belowBar} of ${stage.pilotsWanted} counted pilots were below it.`,
    ...(Array.isArray(stage.unexplained) && stage.unexplained.length ? [
      `${stage.unexplained.length} pilot${stage.unexplained.length === 1 ? '' : 's'} scored below the bar but the low score could not be explained as the error you built the trap for (or as another error the files rule out), so ${stage.unexplained.length === 1 ? 'it' : 'they'} did not count. The traps may not be what is making these pilots fail: read their answers below, and rebuild the trap so that the intended error is what fails.`,
    ] : []),
    ...(stage.stoppedEarly ? [`The ${stage.name} was stopped as soon as the result was decided: after pilot ${stage.stoppedEarly.afterPilot} scored ${typeof stage.stoppedEarly.score === 'number' ? stage.stoppedEarly.score.toFixed(2) : 'no score'}, the pilots that had not finished were cancelled and have no score.`] : []),
    '',
    '## The traps of this attempt',
    ...traps.map(trap => `- ${trap.id}: ${trap.title}`),
    '',
    '## Pilots',
  ];
  for (const pilot of stage.pilots) {
    lines.push('', `### ${pilot.id}${pilot.replacement ? ' (replacement)' : ''}`);
    lines.push(`- state: ${pilot.state}${pilot.stoppedEarly ? ' (stopped early: the result was already decided)' : ''}; audit: ${pilot.audit ? pilot.audit.status : 'none'}`);
    lines.push(`- score: ${typeof pilot.score === 'number' ? pilot.score.toFixed(2) : 'none'}${pilot.score !== null && pilot.score !== undefined ? (pilot.score < stage.bar ? ' (below the bar, the design worked)' : ' (at or above the bar, the pilot got through)') : ''}`);
    if (pilot.adjudication) lines.push(`- the low score ${pilot.countsTowardPass ? 'was explained' : 'was not explained'} (${pilot.adjudication.class}${pilot.adjudication.note ? `: ${pilot.adjudication.note}` : ''})`);
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

/* A fault in traps.json that is about one thing the designer named (a trap, a fingerprint). The public message says "a trap" or "a
   fingerprint"; the name the designer chose (an id can carry a figure, a title can say what the trap is) is in the detail only. */
const upper = text => text.charAt(0).toUpperCase() + text.slice(1);
const named = (what, exact, text) => new DesignError(upper(`${what} ${text}`), `${exact} ${text}`);

/* what: how the public message calls the owner of the list ('gold', 'a fingerprint'); exact: the same with the designer's own id. */
function figureList(list, what, exact = what) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > 50) throw named(what, exact, 'figures must be a list of at most 50');
  return list.map((item, index) => {
    if (!isObject(item)) throw named(what, exact, `figure ${index + 1} is not an object`);
    if (parseFigure(item.value) === null) throw named(what, exact, `figure ${index + 1} needs a numeric value`);
    const tolerance = item.tolerance === undefined || item.tolerance === null || item.tolerance === '' ? 0 : parseFigure(item.tolerance);
    if (tolerance === null || tolerance < 0) throw named(what, exact, `figure ${index + 1} needs a tolerance of zero or more`);
    return { label: oneLine(item.label, 200), value: typeof item.value === 'number' ? item.value : String(item.value).trim(), tolerance };
  });
}

function textValue(value, max, what, exact = what) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') throw new DesignError(upper(`${what} must be text`), `${exact} must be text`);
  if (value.length > max) throw new DesignError(upper(`${what} is longer than ${max} characters`), `${exact} is longer than ${max} characters`);
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
    const title = oneLine(textValue(item.title, DESIGN.titleChars, 'a trap title', `trap ${id} title`), DESIGN.titleChars);
    if (!title) throw named('a trap', `trap ${id}`, 'needs a title');
    const files = Array.isArray(item.files) ? item.files : [];
    if (files.length > 20 || files.some(name => typeof name !== 'string')) throw named('a trap', `trap ${id}`, 'files must be a list of at most 20 names');
    for (const name of files) if (!available.has(name)) throw new DesignError('A trap names a file that is not in the pilot packet', `trap ${id} names the file ${oneLine(name, 120)}, which is not in the pilot packet`);
    return {
      id,
      title,
      mechanism: textValue(item.mechanism === undefined ? '' : item.mechanism, DESIGN.textChars, 'a trap mechanism', `trap ${id} mechanism`),
      files: files.slice(),
      decoy: textValue(item.decoy === undefined ? '' : item.decoy, DESIGN.textChars, 'a trap decoy', `trap ${id} decoy`),
      correctValue: textValue(item.correctValue === undefined ? '' : item.correctValue, 200, 'a trap correctValue', `trap ${id} correctValue`),
      wrongValue: textValue(item.wrongValue === undefined ? '' : item.wrongValue, 200, 'a trap wrongValue', `trap ${id} wrongValue`),
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
    if (tokens.length > 30 || tokens.some(token => token.length > 200)) throw named('a fingerprint', `fingerprint ${id}`, 'has too many or too long tokens');
    const printFigures = figureList(item.figures, 'a fingerprint', `fingerprint ${id}`);
    if (!tokens.length && !printFigures.length) throw named('a fingerprint', `fingerprint ${id}`, 'needs a token or a figure');
    return { id, label: oneLine(item.label, 200), tokens, figures: printFigures };
  });
  const rubric = data.rubricChanges === undefined || data.rubricChanges === null ? [] : data.rubricChanges;
  if (!Array.isArray(rubric) || rubric.length > DESIGN.rubricChanges) throw new DesignError(`rubricChanges must be a list of at most ${DESIGN.rubricChanges}`);
  const rubricChanges = rubric.map((item, index) => {
    if (!isObject(item) || typeof item.change !== 'string' || !item.change.trim() || typeof item.reason !== 'string' || !item.reason.trim()) {
      throw new DesignError(`rubric change ${index + 1} needs a change and a reason`);
    }
    return { change: oneLine(item.change, DESIGN.textChars), reason: oneLine(item.reason, DESIGN.reasonChars) };
  });
  const listedNew = Array.isArray(data.newFiles) ? data.newFiles.filter(name => typeof name === 'string') : [];
  const listedEdited = Array.isArray(data.editedFiles) ? data.editedFiles.filter(isObject) : [];
  return { traps, gold: { decision, figures }, fingerprints, listedNew, listedEdited, rubricChanges };
}

/* ------------------------------------------------------------------ figures and decisions */

const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;
/* "1,250.00" -> "1250": the form numbers are compared in. */
function canonNumber(raw) {
  const value = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(value) ? String(Math.abs(value)) : null;
}
const digitsOf = canonical => canonical.replace(/[^0-9]/g, '').length;
function numbersIn(text) {
  const out = new Set();
  for (const match of String(text).matchAll(NUMBER_RE)) {
    const canonical = canonNumber(match[0]);
    if (canonical !== null) out.add(canonical);
  }
  return out;
}
const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* The numbers (three digits or more) and the decision phrases that the golden answer, gold.figures and the traps' correct values hold:
   what a prompt or a file name must not give away. */
function leakAtoms({ goldenAnswer, gold, traps }) {
  const numbers = new Set();
  const phrases = new Set();
  const addNumbers = text => { for (const number of numbersIn(text)) if (digitsOf(number) >= 3) numbers.add(number); };
  addNumbers(goldenAnswer);
  for (const figure of gold.figures) {
    const value = parseFigure(figure.value);
    const canonical = value === null ? null : canonNumber(value);
    if (canonical !== null && digitsOf(canonical) >= 3) numbers.add(canonical);
  }
  for (const trap of traps) {
    addNumbers(trap.correctValue);
    const text = squash(trap.correctValue);
    if (text.length >= 4 && text.length <= 80 && !/\d/.test(text)) phrases.add(text);
  }
  for (const part of gold.decision.split(';')) {
    const text = squash(part);
    if (text.length >= 4) phrases.add(text);
  }
  return { numbers, phrases: [...phrases] };
}

/* What of the atoms a text states that the original prompt and the original files do not: { numbers: [...], phrases: [...] }. */
function atomsStated(text, atoms, original) {
  const found = { numbers: [], phrases: [] };
  for (const number of numbersIn(text)) if (atoms.numbers.has(number) && !original.numbers.has(number)) found.numbers.push(number);
  const squashed = squash(text);
  for (const phrase of atoms.phrases) {
    if (original.corpus.includes(phrase)) continue;
    if (new RegExp(`(?:^|[^a-z0-9])${escapeRe(phrase)}(?:$|[^a-z0-9])`).test(squashed)) found.phrases.push(phrase);
  }
  return found;
}

/* Everything out/ holds, validated against the disk and the withheld material. packet: Map(name -> { sha256 }) of the base packet (the
   world and task files that are not withheld). withheldHashes: Set. windows: leak windows of every withheld text (safety.leakWindows).
   Returns the design, with the lists of new and edited files as they are on disk. */
function readDesign({ outDir, packet, withheldHashes, windows, original = null, originalDir = null, mode = 'harden', referenceWindows = [] }) {
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
  windows = (windows instanceof WindowSet ? windows : new WindowSet(windows)).with([...leakWindows(guideline), ...leakWindows(goldenAnswer)]);

  const lowerPacket = new Map([...packet.keys()].map(name => [name.toLowerCase(), name]));
  /* out/ and its two folders must be plain folders in the designer's own folder. A link there would lead the copy to files anywhere
     (a symbolic link is never followed below them, but the folder itself is the root of the walk). lstat does not follow a link;
     realpath must come back to the place the name says. */
  const realOut = (() => {
    try {
      const stat = fs.lstatSync(outDir);
      const real = fs.realpathSync(outDir);
      if (stat.isSymbolicLink() || !stat.isDirectory() || real !== path.join(fs.realpathSync(path.dirname(outDir)), path.basename(outDir))) throw new Error('not plain');
      return real;
    } catch {
      throw new DesignError('out/ is not a plain folder (a link or a file stands in its place)', 'out/ must be a real folder inside your own folder. Do not make links.');
    }
  })();
  const lister = sub => {
    const dir = path.join(outDir, sub);
    let stat;
    try { stat = fs.lstatSync(dir); } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw new DesignError(`out/${sub} could not be read`);
    }
    let plain = stat.isDirectory() && !stat.isSymbolicLink();
    if (plain) {
      try { plain = fs.realpathSync(dir) === path.join(realOut, sub); } catch { plain = false; }
    }
    if (!plain) throw new DesignError(`out/${sub} is not a plain folder (a link or a file stands in its place)`, `out/${sub} must be a real folder inside out/, with regular files in it. Do not make links.`);
    try {
      const walked = walkFiles(dir, { maxFiles: DESIGN.newFiles, depth: INTAKE.depth });
      const refused = walked.skipped.filter(item => !isJunkName(item.rel));
      if (refused.length) throw new DesignError(`out/${sub} holds an entry that cannot be used`, `out/${sub} holds an entry that cannot be used (${refused[0].rel.slice(0, 120)}: ${refused[0].why}). Only regular files, in plain folders, with ordinary names.`);
      return walked.files.filter(file => !isJunkName(file.rel));
    } catch (error) {
      if (error instanceof DesignError) throw error;
      throw new DesignError(`out/${sub} could not be read`, `out/${sub} could not be read (${error && error.message ? error.message.slice(0, 120) : 'error'})`);
    }
  };
  const newOnDisk = lister('new');
  const editedOnDisk = lister('edited');
  if (newOnDisk.length + editedOnDisk.length > DESIGN.newFiles) throw new DesignError('The designer wrote too many files');

  const fileChecks = (file, kind) => {
    const problem = nameProblem(file.rel, INTAKE.depth);
    if (problem) throw fileFault(kind, file.rel, `has a name that cannot be used (${problem})`);
    if (GAF_PATTERN.test(file.rel)) throw fileFault(kind, file.rel, 'is in a gaf path, which pilots never see');
    const why = withheldReason(file.rel);
    if (why) throw fileFault(kind, file.rel, `looks like grading material by name (${why})`);
    const sha256 = hashFile(file.abs);
    if (sha256 !== EMPTY_SHA && withheldHashes.has(sha256)) throw fileFault(kind, file.rel, 'is a copy of withheld material');
    if (TEXT_EXTENSIONS.has(path.extname(file.rel).toLowerCase()) && file.bytes <= READ_CAP) {
      let text = '';
      try { text = fs.readFileSync(file.abs, 'utf8'); } catch { text = ''; }
      if (containsLeak(text, windows)) throw fileFault(kind, file.rel, 'holds a long passage of the guideline or the golden answer');
      if (referenceWindows.length && containsLeak(text, referenceWindows)) throw fileFault(kind, file.rel, 'holds a long passage of the reference documents');
    }
    return { name: file.rel, bytes: file.bytes, sha256 };
  };

  const taken = new Set();
  const newFiles = newOnDisk.map(file => {
    const key = file.rel.toLowerCase();
    if (lowerPacket.has(key)) throw fileFault('new', file.rel, 'has the name of an existing file; edit that file instead and list it with a reason');
    if (taken.has(key)) throw fileFault('new', file.rel, 'is named twice');
    taken.add(key);
    return fileChecks(file, 'new');
  });
  const editedFiles = editedOnDisk.map(file => {
    if (!packet.has(file.rel)) throw fileFault('edited', file.rel, 'is not a world or task file; write it under out/new instead');
    return fileChecks(file, 'edited');
  });

  const available = new Set([...packet.keys(), ...newFiles.map(file => file.name)]);
  const parsed = parseTrapsFile(trapsText, available);
  for (const name of parsed.listedNew) if (!newFiles.some(file => file.name === name)) throw new DesignError('traps.json lists a new file that out/new does not hold', `traps.json lists the new file ${oneLine(name, 120)} but out/new does not hold it`);
  const unlisted = newFiles.filter(file => !parsed.listedNew.includes(file.name));
  if (unlisted.length) notes.push(`${unlisted.length} new file${unlisted.length === 1 ? ' was' : 's were'} not listed in traps.json and ${unlisted.length === 1 ? 'is' : 'are'} included anyway.`);
  const reasons = new Map();
  for (const item of parsed.listedEdited) {
    const name = typeof item.name === 'string' ? item.name : '';
    const reason = typeof item.reason === 'string' ? oneLine(item.reason, DESIGN.reasonChars) : '';
    if (!editedFiles.some(file => file.name === name)) throw new DesignError('traps.json lists an edited file that out/edited does not hold', `traps.json lists the edited file ${oneLine(name, 120)} but out/edited does not hold it`);
    if (!reason) throw new DesignError('An edited file has no reason in traps.json', `the edit of ${oneLine(name, 120)} has no reason in traps.json`);
    reasons.set(name, reason);
  }
  for (const file of editedFiles) if (!reasons.has(file.name)) throw fileFault('edited', file.name, 'is not listed with a reason in traps.json');
  for (const file of editedFiles) {
    file.reason = reasons.get(file.name);
    if (file.sha256 === packet.get(file.name).sha256) notes.push(`${file.name} is listed as edited but is identical to the original.`);
  }

  /* Designer v2: the brief, and the answers of the permitted alternatives. They are evaluator material: no word of them may be in a file the
     pilots get, so their texts join the windows of the leak scan. */
  let brief = null;
  const alternatives = [];
  if (mode === 'new') {
    const briefText = readCapped(path.join(outDir, 'brief.json'), 60000, 'out/brief.json');
    brief = parseBrief(briefText, { traps: parsed.traps, files: available });
    withheldHashes = new Set([...withheldHashes, sha256Hex(briefText)]);
    for (const name of ['brief.json', 'answers.json']) { try { withheldHashes.add(hashFile(path.join(outDir, name))); } catch { /* not written */ } }
    const answersDir = path.join(outDir, 'answers');
    let present = false;
    try {
      const stat = fs.lstatSync(answersDir);
      present = true;
      if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(answersDir) !== path.join(realOut, 'answers')) throw new Error('not plain');
    } catch {
      if (present) throw new DesignError('out/answers is not a plain folder (a link or a file stands in its place)', 'out/answers must be a real folder inside out/, with regular files in it. Do not make links.');
    }
    for (const item of brief.permittedAlternatives) {
      const text = readCapped(path.join(outDir, ...item.file.split('/')), 20000, `out/${item.file}`).replace(/\s+$/, '');
      if (!text.trim()) throw new DesignError('The answer of a permitted alternative is empty', `out/${item.file} is empty.`);
      alternatives.push({ name: item.file.replace(/^answers\//, '').replace(/\.md$/, ''), file: item.file, text, sha256: sha256Hex(text), answer: item.answer });
    }
    windows = windows.with([...leakWindows(briefEvaluatorText(brief)), ...alternatives.flatMap(item => leakWindows(item.text))]);
    for (const item of alternatives) withheldHashes = new Set([...withheldHashes, item.sha256, sha256Hex(item.text + '\n')]);
  }

  /* The gold must be in the texts a grader reads: every figure in the golden answer and in the guideline. */
  const goldenNumbers = numbersIn(goldenAnswer);
  const guidelineNumbers = numbersIn(guideline);
  const absent = parsed.gold.figures.filter(figure => {
    const value = parseFigure(figure.value);
    const canonical = value === null ? null : canonNumber(value);
    return canonical === null || !goldenNumbers.has(canonical) || !guidelineNumbers.has(canonical);
  });
  if (absent.length) {
    throw new DesignError('A figure in gold.figures does not appear in both out/golden-answer.md and out/guideline.md',
      `These gold.figures values must appear as digits in both out/golden-answer.md and out/guideline.md, and do not: ${absent.map(figure => `${oneLine(figure.label, 60)} = ${figure.value}`).join('; ')}`);
  }
  /* A guideline that grew a lot says why. */
  if (original && original.guidelineLength && guideline.length > original.guidelineLength * DESIGN.guidelineGrowth && !parsed.rubricChanges.length) {
    throw new DesignError(`out/guideline.md is more than ${DESIGN.guidelineGrowth} times as long as the original guideline and traps.json has no rubricChanges`,
      `out/guideline.md has ${guideline.length} characters, the original guideline ${original.guidelineLength}: more than ${DESIGN.guidelineGrowth} times. List each addition in traps.json as rubricChanges: [{"change": "...", "reason": "..."}], or shorten the guideline.`);
  }
  /* An edit is a change to a world file, not a cut: it may not make the file much smaller, and each one is shown as a comparison. */
  for (const file of editedFiles) {
    const before = packet.get(file.name);
    file.beforeBytes = before.bytes;
    if (before.bytes > 0 && file.bytes < before.bytes * (1 - DESIGN.editShrinkMax)) {
      throw new DesignError(`An edit makes its file more than ${Math.round(DESIGN.editShrinkMax * 100)}% smaller`,
        `The edit of ${oneLine(file.name, 120)} makes the file more than ${Math.round(DESIGN.editShrinkMax * 100)}% smaller: the edited file has ${file.bytes} bytes, the original ${before.bytes}. Change the file, do not cut it down; add what the trap needs.`);
    }
    file.diff = editDiff(file, originalDir, outDir);
  }
  /* A prompt or a new file's name that states what only the golden answer should say. */
  if (original) {
    const atoms = leakAtoms({ goldenAnswer, gold: parsed.gold, traps: parsed.traps });
    const inPrompt = atomsStated(prompt, atoms, original);
    if (inPrompt.numbers.length || inPrompt.phrases.length) {
      throw new DesignError('out/prompt.txt states a figure or a decision of the golden answer that no original file or prompt holds',
        `out/prompt.txt states ${[...inPrompt.numbers.map(item => `the figure ${item}`), ...inPrompt.phrases.map(item => `the phrase "${item}"`)].join(', ')} of the golden answer, which the original prompt and files do not hold. Take it out; the pilots must work it out.`);
    }
    for (const file of newFiles) {
      const named = atomsStated(file.name.replace(/\.[^./]*$/, '').replace(/[_./-]+/g, ' '), atoms, original);
      if (named.numbers.length || named.phrases.length) {
        /* Neither the name nor the figure it states is in the public message: the redesign keeps the same gold. */
        throw new DesignError('The name of a new file gives away part of the answer',
          `The name of the new file ${oneLine(file.name, 120)} states ${[...named.numbers.map(item => `the figure ${item}`), ...named.phrases.map(item => `the phrase "${item}"`)].join(', ')} of the golden answer. Rename the file.`);
      }
    }
  }

  const total = packet.size + newFiles.length;
  let bytes = newFiles.reduce((sum, file) => sum + file.bytes, 0);
  for (const [name, entry] of packet) bytes += (editedFiles.find(file => file.name === name) || entry).bytes;
  if (total > C.LIMITS.files) throw new DesignError(`The pilot packet would hold ${total} files; the limit is ${C.LIMITS.files}`);
  if (bytes > C.LIMITS.bytes) throw new DesignError('The pilot packet would be larger than the packet limit');

  if (containsLeak(prompt, windows)) throw new DesignError('out/prompt.txt holds a long passage of the guideline or the golden answer');
  if (referenceWindows.length && containsLeak(prompt, referenceWindows)) throw new DesignError('out/prompt.txt holds a long passage of the reference documents');
  const guidelineDiff = original && typeof original.guidelineText === 'string' && original.guidelineText
    ? { available: true, ...lineDiff(original.guidelineText, guideline, { maxLines: DESIGN.diffLines }) }
    : { available: false, added: 0, removed: 0, lines: [], truncated: false };
  return { prompt, guideline, goldenAnswer, traps: parsed.traps, gold: parsed.gold, fingerprints: parsed.fingerprints, newFiles, editedFiles, rubricChanges: parsed.rubricChanges, guidelineDiff, notes, windows, referenceWindows, brief, alternatives, unscanned: [] };
}

/* Extensions read as text by the scan below, whatever they are called: the plain text kinds and the usual source, markup and log forms.
   A file with no extension is read as text too. Any other kind is still read as bytes, but is reported as unscanned, because what it
   holds may be packed (a PDF, a picture, an old binary office file). */
const SCANNED_AS_TEXT = new Set([...TEXT_EXTENSIONS, '', '.rtf', '.tex', '.rst', '.sql', '.py', '.js', '.ts', '.jsonl', '.ndjson', '.ini', '.cfg', '.toml', '.conf', '.sh', '.bas']);
const ZIP_TEXT_CHARS = 4 * 1024 * 1024;

/* The files the designer wrote, read for passages of the withheld material: the original guideline and golden answer, anything withheld
   from the task, and the designer's own guideline and golden answer (design.windows). A text file of any size is read in chunks, the text
   of a word-processing, spreadsheet or slide file is extracted (extract.cjs, as the classification does for the task's own files), and any
   other file is read as bytes. A hit throws a DesignError; what could not be read as text is returned as unscanned: [{ name, kind }].
   shouldStop() true throws Stopped. */
async function scanDesignFiles({ outDir, design, shouldStop }) {
  const unscanned = [];
  const stopped = () => { if (shouldStop && shouldStop()) throw new Stopped('stopped'); };
  /* The windows of the reference documents are a WindowSet (a very large set) or an array; both have a length, and containsLeak and scanFile take either. */
  const reference = design.referenceWindows && design.referenceWindows.length ? design.referenceWindows : [];
  for (const [kind, sub, list] of [['new', 'new', design.newFiles], ['edited', 'edited', design.editedFiles]]) {
    for (const file of list) {
      stopped();
      const abs = path.join(outDir, sub, ...file.name.split('/'));
      const ext = path.extname(file.name).toLowerCase();
      if (ZIP_EXTENSIONS.has(ext)) {
        const text = await extractText(abs, { maxChars: ZIP_TEXT_CHARS });
        stopped();
        if (text === null) { unscanned.push({ name: file.name, kind }); continue; }
        if (containsLeak(text, design.windows)) throw fileFault(kind, file.name, 'holds a long passage of the guideline or the golden answer');
        if (reference.length && containsLeak(text, reference)) throw fileFault(kind, file.name, 'holds a long passage of the reference documents');
        continue;
      }
      const scan = await scanFile(abs, design.windows, shouldStop);
      stopped();
      if (scan.leak === true) throw fileFault(kind, file.name, 'holds a long passage of the guideline or the golden answer');
      if (reference.length) {
        const again = await scanFile(abs, reference, shouldStop);
        stopped();
        if (again.leak === true) throw fileFault(kind, file.name, 'holds a long passage of the reference documents');
      }
      if (scan.leak === null || scan.binary || !SCANNED_AS_TEXT.has(ext)) unscanned.push({ name: file.name, kind });
    }
  }
  return { unscanned };
}

/* The comparison of an edited file with its original: a line diff for a text file, the sizes for any other. */
function editDiff(file, originalDir, outDir) {
  const base = { before: file.beforeBytes, after: file.bytes };
  if (!TEXT_EXTENSIONS.has(path.extname(file.name).toLowerCase()) || !originalDir || file.bytes > READ_CAP || file.beforeBytes > READ_CAP) return { kind: 'binary', ...base, added: 0, removed: 0, lines: [], truncated: false };
  try {
    const before = fs.readFileSync(path.join(originalDir, ...file.name.split('/')), 'utf8');
    const after = fs.readFileSync(path.join(outDir, 'edited', ...file.name.split('/')), 'utf8');
    return { kind: 'text', ...base, ...lineDiff(before, after, { maxLines: DESIGN.diffLines }) };
  } catch {
    return { kind: 'binary', ...base, added: 0, removed: 0, lines: [], truncated: false };
  }
}

/* ------------------------------------------------------------------ the pilot packet */

/* work/filesystem: the base packet from original/ (an edited copy from out/edited in place of its original) and the new files from
   out/new. Every copy is checked against the hash it must have. Returns the manifest, [{ name, bytes, sha256 }], sorted. */
async function buildWork({ originalDir, outDir, workDir, packet, design, shouldStop }) {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const edited = new Map(design.editedFiles.map(file => [file.name, file]));
  const manifest = [];
  try {
    for (const [name, entry] of packet) {
      const change = edited.get(name);
      const source = change ? path.join(outDir, 'edited', ...name.split('/')) : path.join(originalDir, ...name.split('/'));
      const copied = await copyHashed(source, path.join(workDir, ...name.split('/')), { expected: change ? change.sha256 : entry.sha256, shouldStop });
      manifest.push({ name, bytes: copied.bytes, sha256: copied.sha256 });
    }
    for (const file of design.newFiles) {
      const copied = await copyHashed(path.join(outDir, 'new', ...file.name.split('/')), path.join(workDir, ...file.name.split('/')), { expected: file.sha256, shouldStop });
      manifest.push({ name: file.name, bytes: copied.bytes, sha256: copied.sha256 });
    }
  } catch (error) {
    fs.rmSync(workDir, { recursive: true, force: true });
    if (error && error.constructor && error.constructor.name === 'Stopped') throw error;
    throw new DesignError('The pilot packet could not be built', `The pilot packet could not be built (${error && error.message ? error.message.slice(0, 160) : 'error'})`);
  }
  return manifest.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/* The text of each file the pilots will get, as it will be in the packet (an edited copy in place of its original): [{ name, text }]. Text that
   cannot be read gives null. dirs: { originalDir, outDir }. */
async function packetDocuments({ packet, design, originalDir, outDir, maxChars = 1024 * 1024 }) {
  const edited = new Set(design.editedFiles.map(file => file.name));
  const out = [];
  for (const name of packet.keys()) {
    const abs = edited.has(name) ? path.join(outDir, 'edited', ...name.split('/')) : path.join(originalDir, ...name.split('/'));
    out.push({ name, text: await extractFileText(abs, { maxChars }) });
  }
  for (const file of design.newFiles) out.push({ name: file.name, text: await extractFileText(path.join(outDir, 'new', ...file.name.split('/')), { maxChars }) });
  return out;
}

/* The brief's quotes against the packet as it will be (see brief.cjs verifyBriefSources). Resolves { warnings, documents }. */
async function verifyDesignBrief({ packet, design, originalDir, outDir, referenceTexts = [] }) {
  const documents = await packetDocuments({ packet, design, originalDir, outDir });
  /* A file the designer adds must be one the reviewers can read: the blind reviewer opens text, PDFs and pictures and gets a text rendering of Word, Excel, slide
     and RTF files; the other reviews read the text the harness extracts. Nobody can read an old binary Office file, an archive or an unknown binary. */
  const unreadable = design.newFiles.filter(file => readerKind(file.name, (documents.find(item => item.name === file.name) || {}).text) === 'unreadable');
  if (unreadable.length) {
    throw new DesignError('A new file is of a kind that the reviewers cannot read',
      `The new file${unreadable.length === 1 ? '' : 's'} ${unreadable.slice(0, 5).map(file => oneLine(file.name, 120)).join(', ')} cannot be read by the reviewers (no text could be taken from ${unreadable.length === 1 ? 'it' : 'them'}). Add files of a kind that has text: plain text, csv, json, md, docx, xlsx, pptx, rtf, a pdf or a picture.`);
  }
  const checked = verifyBriefSources(design.brief, documents, design.prompt, referenceTexts);
  return { warnings: checked.warnings, documents };
}

module.exports = { DesignError, designerPromptNew, reviewRepairPrompt, evaluatorRepairPrompt, packetDocuments, verifyDesignBrief, scanDesignFiles, catalogText, designerPrompt, repairPrompt, rejectionFeedback, feedbackText, readDesign, buildWork, parseTrapsFile, numbersIn, canonNumber, leakAtoms, atomsStated };
