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

/* A figure of the brief as a number: a number, or a string that is one: digits with a decimal point, thousands groups written with commas or spaces (1,250 and
   1 250 are 1250), an optional sign and an optional currency sign in front. An empty string, a lone currency sign, a list, a word, and a comma that is no
   thousands group (1,5 and 1.234,50 are European forms that would be misread) are not numbers: null. */
function figureNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const t = value.trim().replace(/^(-?)\s*[$\u20ac\u00a3]\s*/, '$1');
  if (/^-?\d{1,3}(?:[, ]\d{3})+(?:\.\d+)?$/.test(t) || /^-?\d+(?:\.\d+)?$/.test(t)) return Number(t.replace(/[, ]/g, ''));
  return null;
}

/* [{ label, value, tolerance }] */
function figures(list, where) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > 20) throw fault('A figure list in the brief is not a list of at most 20', `${where} figures must be a list of at most 20.`);
  return list.map((item, index) => {
    const number = isObject(item) ? figureNumber(item.value) : null;
    if (number === null) throw fault('A figure in the brief needs a numeric value', `${where} figure ${index + 1} needs a numeric value (digits, with a decimal point and commas for thousands: 1,250.50; not a word, a blank or a list).`);
    const blank = item.tolerance === undefined || item.tolerance === null || (typeof item.tolerance === 'string' && !item.tolerance.trim());
    const tolerance = blank ? 0 : figureNumber(item.tolerance);
    if (tolerance === null || tolerance < 0) throw fault('A figure in the brief needs a tolerance of zero or more', `${where} figure ${index + 1} needs a tolerance of zero or more.`);
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

/* ------------------------------------------------------------------ permitted alternatives: which one is meant, and whether its answer is its own */

/* The id of a declared alternative: the name of its answer file without the folder and the extension (answers/alt-2.md is alt-2). The reviewers name an
   alternative by it. */
const alternativeIdOf = file => String(file || '').replace(/^answers\//, '').replace(/\.md$/, '');

const ONES = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES = { thousand: 1e3, million: 1e6, billion: 1e9 };
const UNITS = { day: 'day', days: 'day', week: 'week', weeks: 'week', month: 'month', months: 'month', year: 'year', years: 'year', hour: 'hour', hours: 'hour', '%': 'percent', percent: 'percent', pct: 'percent', usd: 'money', dollar: 'money', dollars: 'money' };
const hundredths = value => Math.round(value * 100) / 100;

/* The figures a statement of an action makes: [{ value, unit }], digits (1,250 and 1250.5; a k, m or bn after them; a currency sign) and number words (thirty,
   two hundred and fifty). unit is a time, a share or money when the text says so next to the number, else ''. */
function figuresOfText(text) {
  const t = normalizeText(text).toLowerCase();
  const figures = [];
  for (const m of t.matchAll(/(\$\s?|usd\s?)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s?(%|percent\b|pct\b|k\b|mm\b|m\b|bn\b|million\b|billion\b|thousand\b|days?\b|weeks?\b|months?\b|years?\b|hours?\b|usd\b|dollars?\b))?/g)) {
    let value = Number(m[2].replace(/,/g, ''));
    let unit = UNITS[m[3] || ''] || '';
    if (m[3] === 'k' || m[3] === 'thousand') value *= 1e3;
    else if (m[3] === 'm' || m[3] === 'mm' || m[3] === 'million') value *= 1e6;
    else if (m[3] === 'bn' || m[3] === 'billion') value *= 1e9;
    if (m[1]) unit = 'money';
    figures.push({ value: hundredths(value), unit });
  }
  let run = null;
  const flush = next => {
    if (run) figures.push({ value: hundredths(run.total + run.current), unit: UNITS[next] || '' });
    run = null;
  };
  for (const word of t.split(/[^a-z]+/).filter(Boolean)) {
    if (Object.prototype.hasOwnProperty.call(ONES, word)) { run = run || { total: 0, current: 0 }; run.current += ONES[word]; }
    else if (run && word === 'hundred') run.current = (run.current || 1) * 100;
    else if (run && Object.prototype.hasOwnProperty.call(SCALES, word)) { run.total += (run.current || 1) * SCALES[word]; run.current = 0; }
    else if (run && word === 'and') continue;
    else flush(word);
  }
  flush('');
  return figures;
}

/* The first verb of an action, as the kind of thing it does: go ahead, stop, delay, reduce or escalate. A word that is not in the list is no verb here. */
const VERB_STEMS = [
  ['go', ['proceed', 'approv', 'accept', 'releas', 'pay', 'fund', 'disburs', 'draw', 'borrow', 'authori', 'grant', 'allow', 'permit', 'execut', 'sign', 'continu', 'extend', 'drawdown']],
  ['stop', ['reject', 'declin', 'refus', 'deny', 'denied', 'withhold', 'cancel', 'stop', 'halt', 'block', 'forbid', 'prohibit', 'terminat', 'abandon', 'hold', 'freez', 'suspend']],
  ['delay', ['delay', 'defer', 'postpon', 'reschedul', 'stagger', 'phase']],
  ['reduce', ['reduc', 'cut', 'lower', 'cap', 'shrink', 'decreas', 'trim', 'limit']],
  ['escalate', ['escalat', 'refer', 'seek', 'request', 'obtain', 'ask']],
];
const NEGATIONS = new Set(['not', 'never', 'no', 'cannot', 'dont', 'doesnt', 'wont', 'shouldnt', 'mustnt', 'cant']);
function verbOf(text) {
  const words = normalizeText(text).toLowerCase().replace(/['\u2019]/g, '').split(/[^a-z]+/).filter(Boolean);
  for (let index = 0; index < words.length; index++) {
    for (const [kind, stems] of VERB_STEMS) {
      if (stems.some(stem => words[index].startsWith(stem) && words[index].length <= stem.length + 4)) {
        return { kind, negated: words.slice(Math.max(0, index - 3), index).some(word => NEGATIONS.has(word)) };
      }
    }
  }
  return null;
}

/* Do two statements of an action describe the same alternative? Their figures agree (every figure of the one that states fewer is among the figures of the other,
   with the same unit where both name one: sixty days is not thirty days, and 30 days is not 30 weeks), they do not say the opposite (one negates the verb the
   other does not), and the first verbs they use are of one kind (approve and release are, approve and reject are not). A statement with no words, or a pair that has
   no figure, no verb to compare, says nothing against the other. */
function sameAlternative(reported, declared) {
  const a = String(reported || '');
  const b = String(declared || '');
  if (!normalAction(a) || !normalAction(b)) return true;
  const x = figuresOfText(a);
  const y = figuresOfText(b);
  if (x.length && y.length) {
    const [few, many] = x.length <= y.length ? [x, y] : [y, x];
    for (const figure of few) {
      const same = many.filter(other => other.value === figure.value);
      if (!same.length) return false;
      if (figure.unit && !same.some(other => !other.unit || other.unit === figure.unit)) return false;
    }
  }
  const va = verbOf(a);
  const vb = verbOf(b);
  if (va && vb) return va.kind === vb.kind && va.negated === vb.negated;
  return true;
}

const STOP_WORDS = new Set(['that', 'with', 'from', 'this', 'they', 'have', 'will', 'would', 'should', 'shall', 'into', 'than', 'then', 'their', 'there', 'which', 'when', 'where', 'while', 'been', 'being', 'also', 'each', 'such']);
const contentWords = text => [...new Set(normalizeText(text).toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length >= 4 && !STOP_WORDS.has(word)))];

/* The sentences of a text, normalised (lower case, letters and digits, one space), those of fewer than four words left out (a heading, a label). */
function sentencesOf(text) {
  return String(text || '').split(/\n+|(?<=[.!?])\s+/).map(item => item.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(' ')).filter(item => item.split(' ').length >= 4);
}

/* Does an answer state the alternative it is written for? Its figures are in the answer (when the alternative has figures); otherwise half of the words that
   carry the alternative's meaning are. */
function statesAlternative(text, declared) {
  const figures = figuresOfText(declared);
  if (figures.length) {
    const have = figuresOfText(text);
    return figures.every(figure => have.some(other => other.value === figure.value));
  }
  const words = contentWords(declared);
  if (!words.length) return true;
  const have = new Set(contentWords(text));
  return words.filter(word => have.has(word)).length / words.length >= 0.5;
}

/* What is wrong with the answer written for a permitted alternative, measured against the golden answer: 'copy' (the two say the same, sentence for sentence: the same text, or nine
   tenths of the sentences of each are sentences of the other and the answer does not state its alternative), 'action' (most of its sentences are the golden answer's and it does not state the action or the
   figures of the alternative it is written for, whatever it is dressed in), or ''. An alternative that keeps the facts and the calculation of the golden answer
   and changes the recommendation is none of these. */
function alternativeProblem(text, golden, declaredAnswer) {
  if (normalAction(text) === normalAction(golden)) return 'copy';
  const a = sentencesOf(text);
  const g = sentencesOf(golden);
  if (!a.length || !g.length) return '';
  const inGolden = a.filter(item => g.includes(item)).length / a.length;
  const goldenIn = g.filter(item => a.includes(item)).length / g.length;
  const states = statesAlternative(text, declaredAnswer);
  if (inGolden >= 0.9 && goldenIn >= 0.9 && !states) return 'copy';
  if (inGolden >= 0.5 && !states) return 'action';
  return '';
}

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
    return { id: alternativeIdOf(item.file), answer: need(item.answer, 'the answer of each permitted alternative'), support: need(item.support, 'the support of each permitted alternative'), file: item.file };
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

module.exports = { alternativeIdOf, figuresOfText, sameAlternative, alternativeProblem, ROLES, WHY_KINDS, CHANGES, SCENARIOS, EVALUATOR_FILE_RE, parseBrief, verifyBriefSources, briefEvaluatorText, actionsDiffer, figuresDiffer, changesRequirement, normalAction };
