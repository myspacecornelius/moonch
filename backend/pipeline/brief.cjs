'use strict';
/* The designer's brief (designer v2): out/brief.json says what the design is built on. One primary trap, at most three in all. Everything
   here is checked without a model:

     the shape: every field present, the roles and the kinds valid, the files real, no evaluator file listed as pilot-facing;
     each trap's wrong path really changes a required conclusion or a materially required calculation (the actions differ after
       normalisation, or a figure differs beyond the larger tolerance, and changesDecision is not "neither");
     with more than one trap, controls for the baseline, each single wrong path and the combination, each different from the baseline;
     the clause of the governing rule and the quote that rules out the strongest alternative are found, word for word, in the packet.

   A fault is a DesignError. Its message never carries a name the designer chose (an id, a file, a figure); the detail does. */

const { DESIGN, MAX_ALTERNATIVES, MIN_CLAUSE_QUOTE_CHARS } = require('./constants.cjs');
const STRICT = { strict: true };
const { DesignError } = require('./errors.cjs');
const { isObject, oneLine } = require('./util.cjs');
const { normalizeText, buildCorpus, findQuote, isoTime } = require('./quotes.cjs');

const ROLES = ['authority', 'evidence', 'decoy', 'baseline'];
const WHY_KINDS = ['money', 'time', 'effort', 'accountability'];
const CHANGES = ['required_conclusion', 'required_calculation', 'neither'];
const SCENARIOS = ['baseline', 'primary_wrong', 'secondary_wrong', 'combined_wrong'];
const ALT_FILE_RE = /^answers\/alt-[1-9]\.md$/;
/* Files that are the evaluator's, whatever the designer calls them in the brief: never pilot-facing. */
const EVALUATOR_FILE_RE = /(?:^|\/)(?:brief\.json|guideline\.md|golden-answer\.md|traps\.json|answers\.json)$|^answers\//i;

const fault = (message, detail) => new DesignError(message, detail);
const text = (value, max) => (typeof value === 'string' ? oneLine(value, max).trim() : '');

function need(value, what, max = DESIGN.textChars) {
  const out = text(value, max);
  if (!out) throw fault(`The brief needs ${what}`, `out/brief.json needs ${what}.`);
  return out;
}

/* [{ label, value, tolerance }] */
function figures(list, where) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > 20) throw fault('A figure list in the brief is not a list of at most 20', `${where} figures must be a list of at most 20.`);
  return list.map((item, index) => {
    const number = isObject(item) ? Number(typeof item.value === 'string' ? item.value.replace(/[,$\s]/g, '') : item.value) : NaN;
    if (!isObject(item) || typeof item.value === 'boolean' || item.value === null || !Number.isFinite(number)) throw fault('A figure in the brief needs a numeric value', `${where} figure ${index + 1} needs a numeric value.`);
    const tolerance = item.tolerance === undefined || item.tolerance === null || item.tolerance === '' ? 0 : Number(item.tolerance);
    if (!Number.isFinite(tolerance) || tolerance < 0) throw fault('A figure in the brief needs a tolerance of zero or more', `${where} figure ${index + 1} needs a tolerance of zero or more.`);
    return { label: text(item.label, 200), value: number, tolerance };
  });
}

const pathOf = (value, where) => {
  if (!isObject(value)) throw fault('A path in the brief is missing', `${where} is missing.`);
  return { reasoning: need(value.reasoning, 'the reasoning of each path'), action: need(value.action, 'the action of each path', 400), figures: figures(value.figures, where) };
};

/* Two actions are the same when their words are, ignoring case, punctuation and white space. */
const normalAction = value => normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const actionsDiffer = (a, b) => Boolean(normalAction(a)) && Boolean(normalAction(b)) && normalAction(a) !== normalAction(b);

/* Do two lists of figures differ beyond the larger of the two tolerances? Only figures that pair up are compared. A figure pairs with the figure of the
   same label (letters and digits, case folded) on the other side; when the labels share nothing, the lists are paired by position. A figure that
   only one side has, or a label changed on a figure whose value is the same, is not a difference: otherwise a figure could be added or renamed to make a
   wrong path look different from the right one. */
function figuresDiffer(a, b) {
  const key = item => normalAction(item.label);
  const right = new Map();
  for (const item of b) if (key(item) && !right.has(key(item))) right.set(key(item), item);
  const pairs = [];
  for (const item of a) if (key(item) && right.has(key(item))) pairs.push([item, right.get(key(item))]);
  if (!pairs.length && a.length && a.length === b.length) a.forEach((item, index) => pairs.push([item, b[index]]));
  return pairs.some(([x, y]) => Math.abs(x.value - y.value) > Math.max(x.tolerance, y.tolerance));
}

/* Is a wrong path a real change to a required conclusion or calculation? */
function changesRequirement(correct, wrong, changes) {
  if (changes === 'neither') return false;
  const action = actionsDiffer(correct.action, wrong.action);
  const figure = figuresDiffer(correct.figures, wrong.figures);
  /* Arithmetic movement alone does not change a conclusion; a different action with identical arithmetic does. */
  if (changes === 'required_conclusion') return action;
  return action || figure;
}

/* text of out/brief.json -> the brief, normalised. ctx: { traps: [{ id }] from traps.json, files: Set of the names the pilots get (the packet
   and the new files) }. Throws a DesignError for the first fault. */
function parseBrief(source, ctx) {
  let data;
  try { data = JSON.parse(source); } catch { throw fault('out/brief.json is not valid JSON', 'out/brief.json is not valid JSON.'); }
  if (!isObject(data)) throw fault('out/brief.json is not an object', 'out/brief.json is not an object.');
  const taskType = isObject(data.taskType) ? { workflow: need(data.taskType.workflow, 'a task type workflow', 300), why: text(data.taskType.why, DESIGN.textChars), referenceEntries: (Array.isArray(data.taskType.referenceEntries) ? data.taskType.referenceEntries : []).filter(item => typeof item === 'string').map(item => text(item, 300)).filter(Boolean).slice(0, 20) } : null;
  if (!taskType) throw fault('The brief needs a task type', 'out/brief.json needs taskType: {workflow, why, referenceEntries}.');
  const d = isObject(data.decision) ? data.decision : null;
  if (!d) throw fault('The brief needs a decision', 'out/brief.json needs decision: {ask, mandate, authorityFile, effectiveDate}.');
  const decision = { ask: need(d.ask, 'what the decision asks'), mandate: need(d.mandate, 'the mandate of the decision'), authorityFile: need(d.authorityFile, 'the authority file of the decision', 300), effectiveDate: need(d.effectiveDate, 'the effective date of the decision', 80) };
  /* The date the decision is taken on, as an ISO date. Optional in the brief; when it is given, the application check holds the reviewer to it. */
  if (d.decisionDate !== undefined && d.decisionDate !== null && d.decisionDate !== '') {
    if (isoTime(d.decisionDate) === null) throw fault('The decision date of the brief is not an ISO date', 'out/brief.json decision.decisionDate must be an ISO date (YYYY-MM-DD) that exists, or left out.');
    decision.decisionDate = String(d.decisionDate).trim();
  }
  if (!Array.isArray(data.files) || !data.files.length || data.files.length > 100) throw fault('The brief needs a list of the files and their roles', 'out/brief.json needs files: [{name, role}] (1 to 100).');
  const files = data.files.map((item, index) => {
    if (!isObject(item) || typeof item.name !== 'string' || !ROLES.includes(item.role)) throw fault('A file of the brief needs a name and a valid role', `out/brief.json file ${index + 1} needs a name and a role of ${ROLES.join(', ')}.`);
    if (EVALUATOR_FILE_RE.test(item.name)) throw fault('The brief lists an evaluator file as a file the pilots get', `out/brief.json lists ${oneLine(item.name, 120)}, which is evaluator material and never pilot-facing.`);
    if (!ctx.files.has(item.name)) throw fault('The brief lists a file that the pilots do not get', `out/brief.json lists ${oneLine(item.name, 120)}, which is not in the pilot packet or in out/new.`);
    return { name: item.name, role: item.role };
  });
  if (!files.some(file => file.role === 'authority')) throw fault('The brief needs an authority file', 'out/brief.json files needs at least one file with the role authority.');
  const authority = files.find(file => file.name === decision.authorityFile);
  if (!authority || authority.role !== 'authority') throw fault('The authority file of the decision is not listed as an authority file', `decision.authorityFile ${oneLine(decision.authorityFile, 120)} must be in files with the role authority.`);
  if (!Array.isArray(data.traps) || !data.traps.length || data.traps.length > DESIGN.traps) throw fault(`The brief needs 1 to ${DESIGN.traps} traps`, `out/brief.json needs traps (1 to ${DESIGN.traps}).`);
  const seen = new Set();
  const traps = data.traps.map((item, index) => {
    if (!isObject(item)) throw fault('A trap of the brief is not an object', `out/brief.json trap ${index + 1} is not an object.`);
    const id = text(item.id, 64);
    if (!id || seen.has(id)) throw fault('A trap of the brief needs a unique id', `out/brief.json trap ${index + 1} needs a unique id.`);
    seen.add(id);
    const who = `out/brief.json trap ${id}`;
    const rule = isObject(item.rule) ? { file: need(item.rule.file, 'the file of the governing rule', 300), clause: need(item.rule.clause, 'the clause of the governing rule') } : null;
    if (!rule) throw fault('A trap of the brief needs the rule it rests on', `${who} needs rule: {file, clause}.`);
    if (!ctx.files.has(rule.file)) throw fault('The rule of a trap names a file that the pilots do not get', `${who}: rule.file ${oneLine(rule.file, 120)} is not in the pilot packet or in out/new.`);
    const correctPath = pathOf(item.correctPath, `${who} correctPath`);
    const wrongPath = pathOf(item.wrongPath, `${who} wrongPath`);
    if (!CHANGES.includes(item.changesDecision)) throw fault('A trap of the brief needs changesDecision', `${who} needs changesDecision of ${CHANGES.join(', ')}.`);
    if (!changesRequirement(correctPath, wrongPath, item.changesDecision)) {
      throw fault('A wrong path of the brief does not change a required conclusion or calculation', `${who}: the wrong path must change a required conclusion (a different action) or a materially required calculation (a figure that differs beyond the larger tolerance), and changesDecision must not be "neither". Arithmetic movement alone does not satisfy a conclusion, and the actions must differ after normalisation.`);
    }
    const w = isObject(item.whyTempting) ? item.whyTempting : null;
    if (!w || !WHY_KINDS.includes(w.kind)) throw fault('A trap of the brief needs whyTempting', `${who} needs whyTempting: {kind of ${WHY_KINDS.join(', ')}, source}.`);
    const whyTempting = { kind: w.kind, source: need(w.source, 'the source of the temptation') };
    const consequence = isObject(item.consequence) ? { source: need(item.consequence.source, 'the source of the consequence') } : null;
    if (!consequence) throw fault('A trap of the brief needs a consequence', `${who} needs consequence: {source}.`);
    const s = isObject(item.strongestAlternative) ? item.strongestAlternative : null;
    if (!s) throw fault('A trap of the brief needs its strongest alternative', `${who} needs strongestAlternative: {answer, whyRejected}.`);
    const strongestAlternative = { answer: need(s.answer, 'the strongest alternative answer'), whyRejected: need(s.whyRejected, 'the clause that rules the strongest alternative out') };
    return { id, primary: item.primary === true, rule, correctPath, wrongPath, changesDecision: item.changesDecision, whyTempting, consequence, strongestAlternative };
  });
  if (traps.filter(trap => trap.primary).length !== 1) throw fault('The brief needs exactly one primary trap', 'out/brief.json needs exactly one trap with primary: true.');
  const wanted = (ctx.traps || []).map(trap => trap.id).sort().join('\n');
  if (wanted && traps.map(trap => trap.id).sort().join('\n') !== wanted) throw fault('The traps of the brief are not the traps of traps.json', 'The trap ids of out/brief.json and out/traps.json must be the same.');

  const alternatives = Array.isArray(data.permittedAlternatives) ? data.permittedAlternatives : null;
  if (!alternatives || alternatives.length > MAX_ALTERNATIVES) throw fault(`The brief needs permittedAlternatives (at most ${MAX_ALTERNATIVES})`, `out/brief.json needs permittedAlternatives: a list of at most ${MAX_ALTERNATIVES}, empty with permittedAlternativesReason when there is none.`);
  const permittedAlternatives = alternatives.map((item, index) => {
    if (!isObject(item) || !ALT_FILE_RE.test(String(item.file))) throw fault('A permitted alternative needs an answer file under answers/', `permittedAlternatives ${index + 1} needs file: answers/alt-N.md (N from 1 to 9).`);
    return { answer: need(item.answer, 'the answer of each permitted alternative'), support: need(item.support, 'the support of each permitted alternative'), file: item.file };
  });
  if (new Set(permittedAlternatives.map(item => item.file)).size !== permittedAlternatives.length) throw fault('Two permitted alternatives share an answer file', 'permittedAlternatives must name different files.');
  const permittedAlternativesReason = text(data.permittedAlternativesReason, DESIGN.textChars);
  if (!permittedAlternatives.length && !permittedAlternativesReason) throw fault('An empty list of permitted alternatives needs a reason', 'out/brief.json: permittedAlternatives is empty, so permittedAlternativesReason must say why.');

  const rawControls = Array.isArray(data.controls) ? data.controls : [];
  if (traps.length > 1 || rawControls.length) {
    const controls = rawControls.map((item, index) => {
      if (!isObject(item) || !SCENARIOS.includes(item.scenario)) throw fault('A control of the brief needs a valid scenario', `control ${index + 1} needs scenario of ${SCENARIOS.join(', ')}.`);
      return { scenario: item.scenario, trap: text(item.trap, 64), action: need(item.action, 'the action of each control', 400), figures: figures(item.figures, `control ${index + 1}`), changesDecision: item.changesDecision === true };
    });
    if (traps.length > 1) checkControls(controls, traps);
    return finish({ taskType, decision, files, traps, permittedAlternatives, permittedAlternativesReason, controls });
  }
  return finish({ taskType, decision, files, traps, permittedAlternatives, permittedAlternativesReason, controls: [] });
}

const finish = brief => ({ ...brief, primary: brief.traps.find(trap => trap.primary).id });

/* With more than one trap: the baseline, each single wrong path and the combination, each different from the baseline. */
function checkControls(controls, traps) {
  const baseline = controls.find(control => control.scenario === 'baseline');
  const missing = what => fault('The controls of the brief are incomplete', `out/brief.json controls must hold the baseline, each single wrong path and the combination of all of them (missing: ${what}).`);
  if (!baseline) throw missing('the baseline');
  const primary = traps.find(trap => trap.primary);
  const singles = [{ scenario: 'primary_wrong', trap: primary.id }, ...traps.filter(trap => !trap.primary).map(trap => ({ scenario: 'secondary_wrong', trap: trap.id }))];
  const chosen = [];
  for (const wanted of singles) {
    const control = controls.find(item => item.scenario === wanted.scenario && (wanted.scenario === 'primary_wrong' || item.trap === wanted.trap));
    if (!control) throw missing(`the control of ${wanted.scenario} for trap ${wanted.trap}`);
    chosen.push(control);
  }
  const combined = controls.find(control => control.scenario === 'combined_wrong');
  if (!combined) throw missing('the combination');
  for (const control of [...chosen, combined]) {
    const differs = actionsDiffer(baseline.action, control.action) || figuresDiffer(baseline.figures, control.figures);
    if (!differs || control.changesDecision !== true) {
      throw fault('A control of the brief does not differ from the baseline', 'Every single wrong path and the combination must differ from the baseline in its action or in a figure beyond the tolerance, with changesDecision true, so that one mechanism cannot mask another.');
    }
  }
}

/* The quotes: the clause of each rule is in the file it names or in the prompt; the quote that rules out the strongest alternative is in
   a file the brief lists as authority or evidence, or in the prompt. documents: [{ name, text }] of every file the pilots get; prompt: its text.
   Resolves { warnings }; throws a DesignError for the first quote that is not found. referenceTexts: [{ name, text }] for the warning. */
function verifyBriefSources(brief, documents, prompt, referenceTexts = []) {
  const corpus = buildCorpus([...documents, { name: 'prompt.txt', text: prompt }]);
  const promptOnly = corpus.filter(item => item.name === 'prompt.txt');
  const listed = new Set(brief.files.filter(file => file.role === 'authority' || file.role === 'evidence').map(file => file.name));
  for (const trap of brief.traps) {
    if (!findQuote(trap.rule.clause, corpus, trap.rule.file, STRICT) && !findQuote(trap.rule.clause, promptOnly, undefined, STRICT)) {
      throw fault('A rule of the brief is not found in the pilot packet', `The clause of trap ${trap.id} (${oneLine(trap.rule.clause, 120)}) is not found, word for word, in ${oneLine(trap.rule.file, 120)} or in prompt.txt. Quote the clause exactly as the file states it, as a whole sentence or at least ${MIN_CLAUSE_QUOTE_CHARS} characters.`);
    }
    if (!findQuote(trap.strongestAlternative.whyRejected, corpus.filter(item => listed.has(item.name) || item.name === 'prompt.txt'), undefined, STRICT)) {
      throw fault('The reason that rules out a strongest alternative is not found in the pilot packet', `The whyRejected quote of trap ${trap.id} (${oneLine(trap.strongestAlternative.whyRejected, 120)}) is not found, word for word, in a file the brief lists as authority or evidence, or in prompt.txt. If no clause excludes the alternative, list it in permittedAlternatives or change the trap.`);
    }
  }
  const warnings = [];
  const readable = referenceTexts.filter(item => typeof item.text === 'string');
  if (readable.length) {
    const wanted = normalizeText(brief.taskType.workflow).toLowerCase();
    if (!readable.some(item => normalizeText(item.text).toLowerCase().includes(wanted))) warnings.push('The workflow named in the brief is not found in the reference documents.');
  }
  return { warnings };
}

/* Words of the brief that only an evaluator should hold: what the leak guard must keep out of every file the pilots get. */
function briefEvaluatorText(brief) {
  const parts = [];
  for (const trap of brief.traps) parts.push(trap.correctPath.reasoning, trap.wrongPath.reasoning, trap.correctPath.action, trap.wrongPath.action, trap.strongestAlternative.answer);
  for (const item of brief.permittedAlternatives) parts.push(item.answer);
  return parts.filter(Boolean).join('\n');
}

module.exports = { ROLES, WHY_KINDS, CHANGES, SCENARIOS, EVALUATOR_FILE_RE, parseBrief, verifyBriefSources, briefEvaluatorText, actionsDiffer, figuresDiffer, changesRequirement };
