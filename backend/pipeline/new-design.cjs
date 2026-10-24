'use strict';
/* Designer v2 (designMode 'new') for the pipeline service: a new task built from the world files, with the checks that keep fairness and
   difficulty apart. These are methods of PipelineService (service.cjs assigns them to its prototype), so they use the service's own state,
   budget and model-run helpers.

   One attempt of the 'new' mode:
     1. the designer writes a task from the world files (and the reference documents, when there are any), plus a brief;
     2. the harness reads it (deterministic checks, the leak guards, the brief's quotes);
     3. the answer set: the golden answer and every permitted alternative are graded against the guideline (mandatory);
     4. the blind review (a reader with only the packet and the prompt), then the reveal, and the application check of every clause that rules
        an alternative out; what they find is repaired once, regraded, and checked again;
     5. the packet is built, and its freeze record is written;
   then the pilots, each low score adjudicated (see _adjudicatePilot) and counted only when it is explained.

   Nothing a model says counts until the harness has checked it: quotes are found word for word, dates are compared by the harness, and a
   guideline that cannot grade its own fixed answers is a defect of the guideline, not of the packet. Public messages never name a file, a
   clause or a figure; the detail goes to the designer's feedback and to private files of the attempt. */

const fs = require('node:fs');
const path = require('node:path');
const P = require('./constants.cjs');
const { StopSignal, BudgetStop, Failure, AttemptRejected, DesignError } = require('./errors.cjs');
const { sha256Hex, capText, oneLine, writeJsonAtomic, writeTextAtomic, walkFiles, hashFile, delay, usdText } = require('./util.cjs');
const { attemptReserveUsd } = require('./budget.cjs');
const { SafetyError } = require('./safety.cjs');
const { buildWork, designerPromptNew, repairPrompt, reviewRepairPrompt, evaluatorRepairPrompt, readDesign, scanDesignFiles, verifyDesignBrief } = require('./design.cjs');
const { runReviewer, runToolLess } = require('./models.cjs');
const { decideGrades, meanScore, graderEffort, lowCounts, stageStanding, EVALUATOR_FAULT, GRADER_FOOTER, MAX_ANSWER_FOR_GRADER } = require('./gates.cjs');
const { buildCorpus, findQuote, normalizeText } = require('./quotes.cjs');
const { normalAction } = require('./brief.cjs');
const R = require('./review.cjs');
const { suggest } = require('../agents/classify.cjs');
const { extractText, readerKindOfFile } = require('./extract.cjs');

const round6 = value => Math.round(value * 1e6) / 1e6;
const MAX_REVIEW_EVALUATIONS = 2; /* the reveal runs at most twice in one attempt: once, and once more after a repair */
const MAX_REVIEW_REPAIRS = 2;

/* Which files of out/ the pilots could see, and which are the evaluator's. Anything not named here is treated as the pilots'. */
const EVALUATOR_PATH_RE = /^(?:guideline\.md|golden-answer\.md|brief\.json|traps\.json|answers\.json|answers\/.*)$/;
const hashOut = outDir => {
  const out = new Map();
  for (const file of walkFiles(outDir, { maxFiles: 1000, depth: 8 }).files) out.set(file.rel, hashFile(file.abs));
  return out;
};
/* What changed between two hashings of out/: { any, packet, evaluator, names } (packet: a file the pilots would get, or the prompt). */
function changesOf(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  const changed = [...names].filter(name => before.get(name) !== after.get(name));
  return { any: changed.length > 0, packet: changed.some(name => !EVALUATOR_PATH_RE.test(name)), evaluator: changed.some(name => EVALUATOR_PATH_RE.test(name)), names: changed };
}

const packetSha = manifest => sha256Hex(manifest.map(file => `${file.name}\t${file.sha256}\t${file.bytes}`).join('\n'));
const decisionText = brief => `${brief.decision.ask} Mandate: ${brief.decision.mandate} Effective: ${brief.decision.effectiveDate}.`;

module.exports = {
  /* -------------------------------------------------------------- shared helpers */

  /* Strings that no environment value or argument of an isolated run may hold: the private folder of the project, and the reference folder the owner named (it can be anywhere). */
  _forbiddenText(ctl = null) { return [path.join(this.root, 'private'), ...(ctl && typeof ctl.referencesDir === 'string' && ctl.referencesDir ? [ctl.referencesDir] : [])]; },

  /* A folder under <tmpRoot>/finance-studio-pipelines/<id>/runs for one review run, empty. */
  _reviewFolder(p, name) {
    const dir = path.join(this._workspace(p.id), 'runs', name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  },

  /* One tool-less, isolated model call for a review. Resolves { usable, text }: usable when the run completed and used no tool. A call that
     does not fit under the cap ends the run (BudgetStop; incomplete while the attempt's checks are not done). */
  async _reviewCall(p, ctl, { stage = 'design', kind, ref, name, prompt, cap }) {
    this._checkStop(ctl);
    this._reserve(p, `the ${kind.replace(/-/g, ' ')}`, cap);
    if (Buffer.byteLength(prompt) > 120 * 1024) return { usable: false, text: '' };
    const folder = this._reviewFolder(p, name);
    let run;
    try {
      run = await runToolLess({ rt: this.rt, folder, prompt, model: p.config.model, effort: graderEffort(p.config.effort), capUsd: cap, onRunner: this._track(ctl), isolated: { forbiddenText: this._forbiddenText(ctl) } });
    } catch (error) {
      if (ctl.stop) throw new StopSignal('stopped');
      throw error;
    } finally {
      try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* a leftover folder is private and empty */ }
    }
    this._spend(p, stage, kind, ref, run.costUsd, cap, !run.summary.spawnError);
    if (run.summary.state === 'cancelled' || ctl.stop) throw new StopSignal('stopped');
    const usable = run.summary.state === 'completed' && run.toolCalls === 0;
    return { usable, text: usable ? run.summary.result.text : '' };
  },

  /* Before an attempt of the 'new' mode: everything that must finish for the attempt to count (the designer, its repair turns, the reviews, the
     answer set, the adjudication of every pilot) at its worst case with the headroom on top. The pilots themselves are reserved by their
     stages. A cap that cannot pay for the first attempt ends the run as incomplete: nothing was validated. A cap that cannot pay for a redesign, after an
     attempt whose checks finished and that failed the pilots, ends the run as a plain budget stop: that attempt was validated, and nothing passed. */
  _reserveAttempt(p, n) {
    const need = round6(attemptReserveUsd(p.config.designCapUsd, { fairnessSet: p.config.fairnessSet === true }) * P.HEADROOM);
    if (round6(p.spentUsd + need) > p.config.capUsd + 1e-9) {
      const first = p.attempts.length === 0;
      const figures = `could cost up to USD ${usdText(need)} (with ${Math.round((P.HEADROOM - 1) * 100)}% headroom), USD ${usdText(p.spentUsd)} is spent, USD ${usdText(round6(p.spentUsd + need))} together, and the cap is USD ${usdText(p.config.capUsd)}.`;
      if (first) throw new BudgetStop(`Stopped before attempt ${n}: the checks every design must pass (the designer, the reviews, the answer set and the adjudication of the pilots) ${figures} The design was not validated, so nothing here counts as a pass.`, { incomplete: true });
      throw new BudgetStop(`Stopped before attempt ${n}: the checks every design must pass (the designer, the reviews, the answer set and the adjudication of the pilots) ${figures} The earlier attempts had finished their checks and did not pass, so nothing here counts as a pass.`, { incomplete: false });
    }
  },

  /* -------------------------------------------------------------- references */

  /* The reference documents: copied once into the pipeline's private folder (streamed and hashed), read for the leak guard. */
  async _prepareReferences(p, ctl) {
    const refs = p.references;
    if (!refs || !refs.found || !ctl.referencesDir) return;
    const { scanReferences, copyReferences, referenceTexts } = require('./references.cjs');
    const { leakWindowSet } = require('./safety.cjs');
    this._setStage(p, 'classify', 'Copying the reference documents');
    const scan = scanReferences(ctl.referencesDir);
    if (scan.problems.length) throw new Failure('The reference folder changed after the pipeline was started, and it no longer follows the rules. Nothing was designed.');
    const dest = path.join(this._priv(p.id), 'references');
    fs.rmSync(dest, { recursive: true, force: true });
    const copied = await copyReferences(scan.files, dest, () => ctl.stop);
    this._checkStop(ctl);
    const texts = await referenceTexts(dest, copied);
    const readable = texts.filter(item => typeof item.text === 'string' && item.text.trim());
    const windows = leakWindowSet(readable.map(item => item.text), this.referenceScanChars);
    /* Text that a world or task file already holds is not a leak when it is in a file the designer edits (the pilots have it already, and an edit leaves most of
       a file as it was). The windows that the original packet contains are taken out of the set once, here; a passage of a reference that no original file holds
       still is a leak wherever the designer puts it. */
    let referenceSet = windows.set;
    for (const name of ctl.packet.keys()) {
      this._checkStop(ctl);
      const text = await extractText(this._originalFile(p, name), { maxChars: 4 * 1024 * 1024 });
      if (typeof text === 'string' && text) referenceSet = referenceSet.without([text]);
    }
    ctl.referenceDir = dest;
    ctl.referenceTexts = texts;
    ctl.referenceWindows = referenceSet;
    refs.files = copied;
    refs.copied = true;
    /* Named as unscanned, so that the owner knows what the guard could not look for: a file with no readable text (a PDF), a file the cap left out or cut
       short, and a text that reached the limit of what is read from one file. `partial` names the ones that were scanned in part. */
    const cutNames = new Set(windows.cut.map(item => readable[item.index].name));
    const partial = new Set([...windows.cut.filter(item => item.scanned > 0).map(item => readable[item.index].name), ...texts.filter(item => item.cut).map(item => item.name)]);
    refs.unscanned = texts.filter(item => typeof item.text !== 'string' || !item.text.trim() || cutNames.has(item.name) || item.cut).map(item => item.name);
    refs.partial = [...partial];
    refs.scannedChars = windows.scannedChars;
    refs.truncated = windows.truncated || partial.size > 0;
    this._save(p);
  },

  /* -------------------------------------------------------------- the answer set (D5) */

  /* The fixed answers of a design: the golden answer and every permitted alternative, each with the threshold it must reach. */
  _fixedAnswers(design) {
    return [
      { name: 'golden', kind: 'golden', file: 'golden-answer.md', text: design.goldenAnswer, threshold: P.GOLDEN_MIN },
      ...design.alternatives.map(item => ({ name: item.name, kind: 'alternative', file: item.file, text: item.text, threshold: P.ALTERNATIVE_MIN })),
    ];
  },

  /* One fixed answer, graded twice, a third time on a straddle (the majority decides). A grade that is null or refused gets one more call; a
     second one fails the check. Resolves { grades, decision, failed, reason, verdict }. */
  async _gradeFixedAnswer(p, ctl, { n, label, guideline, answer, threshold, stage = 'design' }) {
    const ref = `as-${n}-${label}`;
    const grades = [];
    let nulls = 0;
    let call = 0;
    let last = { reason: '', verdict: null };
    for (;;) {
      const decision = decideGrades(grades, threshold);
      if (decision.done) return { grades, decision, failed: false, reason: last.reason, verdict: last.verdict };
      if (grades.length >= P.ANSWER_SET_GRADES) return { grades, decision, failed: true, reason: last.reason, verdict: last.verdict };
      this._checkStop(ctl);
      this._reserve(p, 'a grade of the answer set', P.CAPS.graderUsd);
      call++;
      const result = await this._pilotGrade(p, ctl, { stage, ref, guideline, answer, call });
      if (result.ok && result.score !== null) {
        grades.push(result.score);
        last = { reason: result.reason, verdict: result.verdict };
        continue;
      }
      nulls++;
      if (nulls > 1) return { grades, decision, failed: true, reason: last.reason, verdict: last.verdict };
    }
  },

  /* The mandatory answer-set test. design: the design as read. why: 'first grading' or the cause of a regrade. Every fixed answer is graded
     against the CURRENT guideline; the earlier runs of the same answer stay in `runs`, so a change of the rubric can be read exactly. Throws
     AttemptRejected when an answer is below its threshold (a defect of the guideline or the golden answer, not of the packet). */
  async _answerSetTest(p, ctl, attempt, design, { why, stage = 'design', reject = true }) {
    const n = attempt.n;
    const guidelineSha = sha256Hex(design.guideline);
    const set = attempt.answerSet || (attempt.answerSet = { goldenMin: P.GOLDEN_MIN, alternativeMin: P.ALTERNATIVE_MIN, answers: [], passed: null });
    const guideline = design.guideline + GRADER_FOOTER;
    const failures = [];
    const details = [];
    for (const fixed of this._fixedAnswers(design)) {
      this._checkStop(ctl);
      const existing = set.answers.find(item => item.name === fixed.name);
      const runNo = existing ? existing.runs.length + 1 : 1;
      const label = runNo === 1 ? fixed.name : `${fixed.name}-r${runNo}`;
      const graded = await this._gradeFixedAnswer(p, ctl, { n, label, guideline, answer: capText(fixed.text, MAX_ANSWER_FOR_GRADER), threshold: fixed.threshold, stage });
      let entry = existing;
      if (!entry) { entry = { name: fixed.name, kind: fixed.kind, file: fixed.file, threshold: fixed.threshold, runs: [] }; set.answers.push(entry); }
      const run = {
        why, at: this.now(), guidelineSha256: guidelineSha, answerSha256: sha256Hex(fixed.text), grades: graded.grades.slice(),
        /* score is the mean of the grades, for reading; the answer passes or fails by the rule: both grades on one side of the threshold, or the majority of three */
        score: meanScore(graded.grades), rule: graded.grades.length >= 3 ? 'majority' : 'both', passed: !graded.failed && graded.decision.passed === true, unstable: graded.decision.unstable === true, noGrade: graded.failed && graded.grades.length < 2,
      };
      entry.runs.push(run);
      entry.sha256 = run.answerSha256;
      entry.score = run.score;
      entry.passed = run.passed;
      entry.unstable = run.unstable;
      entry.grades = run.grades;
      if (fixed.kind === 'golden') attempt.calibration = { score: run.score, verdict: graded.verdict, reason: graded.reason };
      this._save(p);
      if (!run.passed) {
        const what = fixed.kind === 'golden' ? 'The golden answer' : 'A permitted alternative';
        if (run.noGrade) {
          failures.push(`The simulated grader gave ${fixed.kind === 'golden' ? 'the golden answer' : 'a permitted alternative'} no usable score, so the guideline could not be checked against it`);
          details.push(`The simulated grader could not score ${fixed.kind === 'golden' ? 'your golden answer' : `your alternative answer ${fixed.file}`} against your guideline (no usable score). Make the guideline a clear list of points with how many each is worth.`);
        } else {
          const rule = run.rule === 'majority' ? 'the grades straddled the threshold, so the majority of three decides' : 'both grades decide';
          const grades = run.grades.map(value => value.toFixed(2)).join(', ');
          failures.push(`${what} did not reach ${fixed.threshold.toFixed(2)} against the guideline (grades ${grades}; ${rule}; the mean is ${run.score.toFixed(2)})`);
          details.push(`${fixed.kind === 'golden' ? 'Your golden answer' : `Your alternative answer ${fixed.file}`} did not reach ${fixed.threshold.toFixed(2)} against your guideline (grades ${grades}; ${rule}; the mean is ${run.score.toFixed(2)}): ${graded.reason || '(no reason given)'}. It must reach at least ${fixed.threshold.toFixed(2)}. This is a defect of the guideline or of the answer: fix them so that they agree, without taking a rule out of the packet.`);
        }
      }
    }
    set.passed = set.answers.every(item => item.passed);
    this._save(p);
    if (failures.length && reject) throw new AttemptRejected('answer-set', failures, details);
    return { passed: failures.length === 0, failures, details };
  },

  /* -------------------------------------------------------------- the reviews (D4) */

  /* The reviewer's own folder, next to the packet copy: a plain text rendering of every file the Read tool refuses (Word, Excel, slide and RTF files), written
     under text-renderings/ with the same relative name and .txt added. The renderings are the reviewer's copies and never part of the pilot packet. Files that
     nobody can read are named. Resolves { renderings: [{ file, rendering }], unreadable: [names], partial: [names] }. */
  async _prepareBlindFolder(folder, manifest, shouldStop) {
    const renderings = [];
    const unreadable = [];
    const partial = [];
    const LIMIT = 8 * 1024 * 1024;
    for (const entry of manifest) {
      if (shouldStop()) throw new StopSignal('stopped');
      const copy = path.join(folder, 'filesystem', ...entry.name.split('/'));
      const kind = await readerKindOfFile(copy, entry.name);
      if (kind === 'unreadable') { unreadable.push(entry.name); continue; }
      if (kind !== 'rendered') continue;
      const text = await extractText(copy, { maxChars: LIMIT });
      const target = path.join(folder, 'text-renderings', ...`${entry.name}.txt`.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const cutShort = text.length >= LIMIT;
      fs.writeFileSync(target, `TEXT RENDERING of filesystem/${entry.name}, written by the harness for you. It holds the text of the file; layout, pictures and charts are not in it.\n\n${text}${cutShort ? '\n[the rendering stops here: the file goes on]\n' : ''}`, { mode: 0o600 });
      renderings.push({ file: entry.name, rendering: `text-renderings/${entry.name}.txt` });
      if (cutShort) partial.push(entry.name);
    }
    /* the folder holds the packet copy, the prompt, the renderings and the run's scratch: nothing of the designer's */
    const extra = fs.readdirSync(folder).filter(name => !['filesystem', 'prompt.txt', 'text-renderings', '.tmp'].includes(name));
    if (extra.length) throw new SafetyError('The blind reviewer\'s folder holds something that is not the packet, the prompt or a rendering', `The blind reviewer's folder holds ${extra.slice(0, 5).join(', ')}`);
    return { renderings, unreadable, partial };
  },

  /* Stage 1: a reader with only a copy of the pilot packet and the revised prompt, run with the Read tool and audited like a pilot. A run
     that broke the audit is discarded. Resolves { value, packetSha256 } or throws AttemptRejected when two runs gave nothing usable. The reader gets a text
     rendering of every file its Read tool refuses (see _prepareBlindFolder); a file nobody can read is named to it and recorded in stage1.unreadable, and the
     blind result is then 'partial', never a silent 'no objection' for that file. */
  async _blindStage(p, ctl, attempt, ctx, round) {
    const design = ctx.holder.design;
    const n = attempt.n;
    const record = attempt.fairness.stage1 || (attempt.fairness.stage1 = { state: 'running', tries: 0, runs: 0, packetSha256: null, rendered: [], unreadable: [] });
    record.runs++;
    for (let tryNo = 1; tryNo <= 2; tryNo++) {
      this._checkStop(ctl);
      this._reserve(p, 'the blind review', P.CAPS.blindReviewUsd);
      record.tries++;
      const folder = this._reviewFolder(p, `review-${n}-${round}-${tryNo}`);
      let outcome = null;
      let prepared = { renderings: [], unreadable: [], partial: [] };
      try {
        const manifest = await buildWork({ originalDir: this._origDir(p.id), outDir: ctx.outDir, workDir: path.join(folder, 'filesystem'), packet: ctl.packet, design, shouldStop: () => ctl.stop });
        fs.writeFileSync(path.join(folder, 'prompt.txt'), design.prompt + '\n', { mode: 0o600 });
        prepared = await this._prepareBlindFolder(folder, manifest, () => ctl.stop);
        const run = await runReviewer({
          rt: this.rt, folder, prompt: R.blindPrompt({ prompt: design.prompt, renderings: prepared.renderings, unreadable: [...prepared.unreadable, ...prepared.partial.map(name => `${name} (only the start of its rendering)`)] }), model: p.config.model, effort: P.MIN_GRADER_EFFORT, capUsd: P.CAPS.blindReviewUsd,
          transcriptPath: path.join(ctx.attemptDir, `review-${round}-${tryNo}.transcript.jsonl`), projectRoot: this.root, onRunner: this._track(ctl), isolated: { forbiddenText: this._forbiddenText(ctl) },
        });
        this._spend(p, 'design', 'blind-review', `attempt ${n}`, run.costUsd, P.CAPS.blindReviewUsd, !run.summary.spawnError);
        if (run.summary.state === 'cancelled' || ctl.stop) throw new StopSignal('stopped');
        if (run.audit && run.audit.status !== 'CLEAN') {
          record.discarded = (record.discarded || 0) + 1;
        } else if (run.summary.state === 'completed') {
          const parsed = R.parseBlind(run.answer);
          if (parsed.ok) outcome = { value: { ...parsed.value, unreadable: [...prepared.unreadable, ...prepared.partial] }, packetSha256: packetSha(manifest) };
        }
      } finally {
        try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* a leftover folder is private */ }
      }
      if (outcome) {
        record.rendered = prepared.renderings.map(item => item.file);
        record.unreadable = outcome.value.unreadable;
        record.state = outcome.value.unreadable.length ? 'partial' : 'ok';
        record.packetSha256 = outcome.packetSha256;
        ctl.blindNotices = outcome.value.statusNotices;
        this._save(p);
        return outcome;
      }
    }
    record.state = 'unusable';
    this._save(p);
    throw new AttemptRejected('review', ['The blind review gave no usable answer'], ['The blind review of your packet gave no usable answer twice (the reader was discarded, or its answer could not be read). Make the packet and the prompt plain enough for a reader to work from.']);
  },

  /* The application check of one clause (stage 2b): governs, in force, not superseded, excludes. The reviewer is shown the packet with the clause's file
     first, and the harness holds every quote to what the reviewer was shown. The prompt of the task counts as a file of the packet, for the quotes and for
     the search for supersession wording. Resolves { pass, failed, checks, dates, hits, unscanned, cut }. */
  async _applicationCheck(p, ctl, { n, tag, stage = 'design', clause, alternative, decision, brief, documents, promptText = '' }) {
    const docs = promptText ? [...documents, { name: 'prompt.txt', text: promptText }] : documents;
    const hits = R.supersessionHits(docs, clause, { notices: ctl.blindNotices || [] });
    /* the clause's file, then the brief's authority and evidence files, then every file that holds a passage of supersession wording: the reviewer sees them whole while the budget lasts */
    const hitFiles = [...new Set(hits.filter(hit => hit.kind === 'passage' && hit.document).map(hit => hit.document))];
    const view = R.packetView(docs, R.PACKET_CAPS.application, [...R.priorityFiles(brief, [clause.file]), ...hitFiles]);
    const corpus = buildCorpus(view.shown);
    const prompt = R.applicationPrompt({ clause, alternative, decision, decisionDate: brief && brief.decision ? brief.decision.decisionDate : '', hits, documents: docs, view });
    let parsed = null;
    for (let tryNo = 1; tryNo <= 2 && !parsed; tryNo++) {
      const call = await this._reviewCall(p, ctl, { stage, kind: 'application', ref: tag, name: `apply-${n}-${tag}-${tryNo}`, prompt, cap: P.CAPS.applicationUsd });
      if (!call.usable) continue;
      const out = R.parseApplication(call.text);
      if (out.ok) parsed = out.value;
    }
    const unscanned = hits.filter(hit => hit.kind === 'unreadable' || hit.unreadable === true).map(hit => hit.document);
    if (!parsed) return { pass: false, failed: ['unusable'], checks: { governs: false, inForce: false, notSuperseded: false, excludes: false }, dates: null, hits: hits.length, unscanned, cut: view.cut };
    const checked = R.checkApplication(parsed, { corpus, hits, clause, brief });
    return { ...checked, hits: hits.length, cut: view.cut };
  },

  /* What a check of a clause depends on, as one hash: the files the pilots get (their names and texts), the prompt, the decision and the roles of the files in
     the brief, and the notices the blind reviewer found. A result is reused only for the same signature. */
  _designSignature(ctl, design) {
    const brief = design.brief;
    return sha256Hex(JSON.stringify([
      design.documents.map(item => [item.name, sha256Hex(item.text || '')]).sort(),
      sha256Hex(design.prompt),
      brief.decision, brief.files.map(file => [file.name, file.role]).sort(),
      ctl.blindNotices || [],
    ]));
  },

  /* The key of one application check: the clause (file and words), the alternative it must rule out, and everything the check depends on. */
  _appKey(ctl, design, clause, alternative) {
    if (!design.__signature) Object.defineProperty(design, '__signature', { value: this._designSignature(ctl, design), enumerable: false });
    return sha256Hex([design.__signature, clause.file, normalizeText(clause.quote), normalizeText(alternative)].join('\n'));
  },

  /* The alternative a trap's rule must rule out: the action of its wrong path; when the wrong path takes the same action as the right one and differs only in a
     calculation, the calculation (the right action is not something a clause can rule out). */
  _wrongPathText(trap) {
    if (normalAction(trap.wrongPath.action) !== normalAction(trap.correctPath.action)) return trap.wrongPath.action;
    const figures = trap.wrongPath.figures.map(figure => `${figure.label}: ${figure.value}`).join('; ');
    return `${trap.wrongPath.action} (reached by this calculation: ${trap.wrongPath.reasoning}${figures ? `; figures: ${figures}` : ''})`;
  },

  /* The file that holds the clause that rules a trap's strongest alternative out: the brief's authority file first, then its other authority and evidence files,
     then the prompt; the quote has to stand there (a decoy that holds the same sentence is not the file). '' when it stands nowhere that counts. */
  _clauseFile(design, quote) {
    const corpus = buildCorpus([...design.documents, { name: 'prompt.txt', text: design.prompt }]);
    const names = [design.brief.decision.authorityFile, ...design.brief.files.filter(file => file.role === 'authority' || file.role === 'evidence').map(file => file.name), 'prompt.txt'];
    return [...new Set(names)].find(name => findQuote(quote, corpus, name, { strict: true })) || '';
  },

  /* The clauses of the brief, each checked as the reveal's clause is: the rule of every trap against its wrong path, and the quote that rules out every
     trap's strongest alternative. A clause that was already checked in this review (the same file, words and alternative, on the same files and decision) is not
     checked again, and ctx.appCache keeps only the passes (a failure is never reused: a repair, or a reviewer that failed once, gets a new check). Resolves
     { pass, count, failures: [{ trap, part, failed }], unscanned, cut } (traps are numbered from 1: the id a designer chose can carry a figure). skip: keys
     already checked in this review. */
  async _briefApplications(p, ctl, attempt, ctx, round, skip) {
    const design = ctx.holder.design;
    const decision = decisionText(design.brief);
    const jobs = [];
    design.brief.traps.forEach((trap, index) => {
      jobs.push({ trap: index + 1, part: 'rule', clause: { file: trap.rule.file, quote: trap.rule.clause }, alternative: this._wrongPathText(trap) });
      jobs.push({ trap: index + 1, part: 'whyRejected', clause: { file: this._clauseFile(design, trap.strongestAlternative.whyRejected), quote: trap.strongestAlternative.whyRejected }, alternative: trap.strongestAlternative.answer });
    });
    const done = new Set(skip);
    const failures = [];
    const unscanned = new Set();
    const cut = new Set();
    let count = 0;
    for (const job of jobs) {
      const key = this._appKey(ctl, design, job.clause, job.alternative);
      if (done.has(key)) continue;
      done.add(key);
      let result = ctx.appCache.get(key);
      if (!result) {
        result = job.clause.file
          ? await this._applicationCheck(p, ctl, { n: attempt.n, tag: `brief-${round}-${job.trap}${job.part === 'rule' ? 'r' : 'w'}`, clause: job.clause, alternative: job.alternative, decision, brief: design.brief, documents: design.documents, promptText: design.prompt })
          : { pass: false, failed: ['governs'], unscanned: [], cut: [] };
        if (result.pass) ctx.appCache.set(key, result);
      }
      count++;
      for (const name of result.unscanned || []) unscanned.add(name);
      for (const name of result.cut || []) cut.add(name);
      if (!result.pass) failures.push({ trap: job.trap, part: job.part, failed: result.failed });
    }
    return { pass: failures.length === 0, count, failures, unscanned: [...unscanned], cut: [...cut] };
  },

  /* Stage 2: the reveal, with the application check of the clause that rules the alternative out, and of the clauses of the brief. What the reviewer was
     shown of the packet is fixed (the authority and evidence files first), and every quote is held to it. Resolves { disposition, objectionClass, parsed,
     notes, application, briefApplication, cut }. Two runs without a usable answer reject the attempt. */
  async _revealStage(p, ctl, attempt, ctx, blind, round) {
    const design = ctx.holder.design;
    const n = attempt.n;
    const view = R.packetView(design.documents, R.PACKET_CAPS.reveal, R.priorityFiles(design.brief));
    const report = {};
    const prompt = R.revealPrompt({ prompt: design.prompt, guideline: design.guideline, goldenAnswer: design.goldenAnswer, brief: design.brief, blind: blind.value, documents: design.documents, view, report });
    let parsed = null;
    for (let tryNo = 1; tryNo <= 2 && !parsed; tryNo++) {
      const call = await this._reviewCall(p, ctl, { kind: 'reveal', ref: `attempt ${n}`, name: `reveal-${n}-${round}-${tryNo}`, prompt, cap: P.CAPS.revealReviewUsd });
      if (!call.usable) continue;
      const out = R.parseReveal(call.text);
      if (out.ok) parsed = out.value;
    }
    if (!parsed) throw new AttemptRejected('review', ['The second review gave no usable answer'], ['The second review (the reveal) of your design gave no usable answer twice. Make the guideline, the brief and the packet plain enough to be compared.']);
    const corpus = buildCorpus([...view.shown, ...(report.promptParts || [design.prompt]).map(text => ({ name: 'prompt.txt', text }))]);
    const checked = R.checkReveal(parsed, corpus, { blind: blind.value, brief: design.brief });
    const notes = checked.notes.slice();
    let disposition = checked.disposition;
    let application = null;
    let briefApplication = null;
    const decision = decisionText(design.brief);
    const done = new Set();
    if (checked.needsApplication) {
      const against = parsed.againstAlternative;
      const alternative = parsed.alternative || (blind.value.alternative && blind.value.alternative.answer) || blind.value.answer;
      const clause = { file: against.file, quote: against.quote };
      done.add(this._appKey(ctl, design, clause, alternative));
      application = await this._applicationCheck(p, ctl, { n, tag: `reveal-${round}`, clause, alternative, decision, brief: design.brief, documents: design.documents, promptText: design.prompt });
      if (!application.pass) {
        disposition = 'unresolved';
        notes.push(`the clause quoted against the alternative was not shown to apply (${application.failed.join(', ')})`);
      }
    }
    const settledPermitted = disposition === 'permitted' && parsed.guidelineCovers === true && Boolean(ctx.settledAlternative(parsed));
    if (['excluded_by_clause', 'no_alternative', 'equivalent_result'].includes(disposition) || settledPermitted) {
      /* The brief's own claims must apply too, not only exist: the rule of every trap and the clause that rules its strongest alternative out. */
      briefApplication = await this._briefApplications(p, ctl, attempt, ctx, round, done);
      if (!briefApplication.pass) {
        disposition = 'unresolved';
        notes.push(`a clause of the brief was not shown to apply (${briefApplication.failures.map(item => `trap ${item.trap}, ${item.part}: ${item.failed.join(', ')}`).join('; ')})`);
      }
    }
    const cut = [...new Set([...view.cut, ...(application ? application.cut : []), ...(briefApplication ? briefApplication.cut : [])])];
    if (cut.length) notes.push(`the reviewers were shown only the start of ${cut.join(', ')}, so a rule or a date further into ${cut.length === 1 ? 'it' : 'them'} could not be quoted: keep the rule statements near the top of a long file`);
    if (report.cut && report.cut.length) notes.push(`the reveal reviewer was shown only the start and the end of ${report.cut.join(', ')}`);
    return { disposition, objectionClass: parsed.objectionClass, parsed, notes, application, briefApplication, cut };
  },

  /* One repair turn for what the reviews found. what: 'alternative' | 'equivalent' | 'missing'. Resolves what changed in out/ (changesOf) after
     the design was read again; a design that no longer reads rejects the attempt. */
  async _reviewRepair(p, ctl, attempt, ctx, what, finding) {
    const n = attempt.n;
    this._checkStop(ctl);
    this._reserve(p, 'the repair turn', P.CAPS.repairUsd);
    this._note(p, `Asking the trap designer to repair what the reviews found (attempt ${n} of ${ctx.total})`);
    const before = hashOut(ctx.outDir);
    attempt.fairness.repairs++;
    const turn = await this._designerTurn(p, ctl, {
      prompt: reviewRepairPrompt({ attempt: n, attempts: ctx.total, what, finding }), cap: P.CAPS.repairUsd, kind: 'review-repair', ref: `attempt ${n}`,
      transcript: path.join(ctx.attemptDir, `review-repair-${attempt.fairness.repairs}.transcript.jsonl`), designer: ctx.designer,
    });
    if (turn.problem) throw new AttemptRejected('review', [turn.problem.message], [turn.problem.detail]);
    const change = changesOf(before, hashOut(ctx.outDir));
    const problem = await ctx.tryRead();
    if (problem) throw new AttemptRejected('design', [problem.message], [problem.detail]);
    this._keepOut(ctx.outDir, path.join(ctx.attemptDir, 'out'));
    return change;
  },

  /* The whole fairness part of an attempt: the answer set, then the blind review and the reveal, with at most two evaluations and two repairs.
     Records the result in attempt.fairness and attempt.answerSet and throws AttemptRejected when the design is not fair. */
  async _fairnessNew(p, ctl, attempt, ctx) {
    const fair = attempt.fairness;
    const detail = { evaluations: [] };
    ctx.appCache = new Map(); /* the passes of the application checks of the brief's clauses, by everything a check depends on (see _appKey) */
    /* The declared alternative that the reviewer's alternative is, when there is one and the guideline grades its answer at ALTERNATIVE_MIN or more. The
       harness ties the two by the words of the action (the reviewer's "alternative" and the declared "answer"): a graded answer for some other alternative
       settles nothing. */
    ctx.declaredAlternative = (design, parsed) => design.alternatives.find(alternative => R.sameAction(parsed.alternative, alternative.answer)) || null;
    ctx.settledAlternative = parsed => {
      const set = attempt.answerSet;
      const tied = ctx.declaredAlternative(ctx.holder.design, parsed);
      const entry = tied && set ? set.answers.find(item => item.name === tied.name) : null;
      return entry && entry.passed ? tied : null;
    };
    const reject = (reason, finding) => {
      this._writeFairnessDetail(ctx.attemptDir, attempt, detail);
      throw new AttemptRejected('review', [reason], [finding]);
    };
    await this._answerSetTest(p, ctl, attempt, ctx.holder.design, { why: 'first grading' });
    let blind = null;
    let rerunBlind = true;
    for (let evaluation = 1; ; evaluation++) {
      this._note(p, `Reviewing the design of attempt ${attempt.n} (review ${evaluation} of at most ${MAX_REVIEW_EVALUATIONS})`);
      if (rerunBlind) { blind = await this._blindStage(p, ctl, attempt, ctx, evaluation); rerunBlind = false; }
      const reveal = await this._revealStage(p, ctl, attempt, ctx, blind, evaluation);
      const application = reveal.application ? { pass: reveal.application.pass, failed: reveal.application.failed, checks: reveal.application.checks, dates: reveal.application.dates, hits: reveal.application.hits, unscanned: reveal.application.unscanned } : null;
      const briefApplication = reveal.briefApplication ? { pass: reveal.briefApplication.pass, count: reveal.briefApplication.count, failures: reveal.briefApplication.failures, unscanned: reveal.briefApplication.unscanned } : null;
      fair.stage2 = { disposition: reveal.disposition, objectionClass: reveal.objectionClass, evaluations: evaluation, application, briefApplication, cut: reveal.cut };
      detail.evaluations.push({ blind: blind.value, reveal: reveal.parsed, disposition: reveal.disposition, notes: reveal.notes, application: reveal.application, briefApplication: reveal.briefApplication });
      this._save(p);
      const d = reveal.disposition;
      const finding = this._reviewFinding(reveal);
      const last = evaluation >= MAX_REVIEW_EVALUATIONS || fair.repairs >= MAX_REVIEW_REPAIRS;
      if (d === 'no_alternative' || d === 'excluded_by_clause') break;

      if (d === 'permitted') {
        /* The packet allows the alternative. That is not a rejection: it is settled once the guideline accepts it and the declared alternative that is this one has
           a fixed answer that the guideline grades at ALTERNATIVE_MIN or more. Otherwise one repair adds the line to the acceptable variation and writes the
           answer, and the harness checks that what was written is that alternative; then the review runs once more. */
        if (reveal.parsed.guidelineCovers === true && ctx.settledAlternative(reveal.parsed)) break;
        if (last) reject('The reviews found an answer that the packet allows, and the guideline does not yet accept it with a graded answer', finding);
        const before = new Map(ctx.holder.design.alternatives.map(alternative => [alternative.name, alternative.sha256]));
        const change = await this._reviewRepair(p, ctl, attempt, ctx, 'alternative', finding);
        const now = ctx.holder.design;
        if (!change.any) reject('The repair changed nothing, so the permitted alternative was not added', `${finding}\nYour repair changed no file. Add the alternative to the acceptable variation of out/guideline.md, write its answer under out/answers/ and list it in out/brief.json.`);
        if (!now.alternatives.length) reject('The repair did not write an answer for the permitted alternative', `${finding}\nThe design still has no permitted alternative with an answer file under out/answers/. Write one (a strong answer that takes the alternative with correct reasoning) and list it in permittedAlternatives of out/brief.json.`);
        const produced = ctx.declaredAlternative(now, reveal.parsed);
        if (!produced) reject('The repair wrote an answer for another alternative than the one the review reported', `${finding}\nThe alternatives your brief lists now are: ${now.alternatives.map(alternative => `"${oneLine(alternative.answer, 160)}"`).join('; ')}. None of them is the alternative the review reported. List the alternative the review found in permittedAlternatives (its answer is what it says) and write the answer that takes it.`);
        if (before.get(produced.name) === produced.sha256 && !change.names.includes('guideline.md')) reject('The repair did not write the answer for the permitted alternative', `${finding}\nYour repair left the answer of this alternative as it was, and did not change out/guideline.md. Write the answer that takes the alternative, and add the alternative to the acceptable variation of the guideline.`);
        if (R.copiesText(produced.text, now.goldenAnswer)) reject('The answer written for the permitted alternative is a copy of the golden answer', `${finding}\nThe answer ${produced.file} says what the golden answer says. Write an answer that takes the alternative action with correct reasoning.`);
        if (reveal.parsed.guidelineCovers !== true && !change.names.includes('guideline.md')) reject('The repair did not add the permitted alternative to the guideline', `${finding}\nYour repair did not change out/guideline.md. Add the alternative to its "Acceptable variation" section.`);
        if (change.packet) rerunBlind = true;
        await this._answerSetTest(p, ctl, attempt, now, { why: change.packet ? 'after the packet changed' : 'after the permitted alternative was added' });
        continue;
      }

      if (d === 'equivalent_result') {
        /* Accepted. A line in the acceptable variation is added when the guideline lacks it, so the grader does not punish it. If that repair touches the
           packet, the packet is not the one that was reviewed: it is reviewed again. If it touches the evaluator material beyond the guideline (the golden
           answer, the brief, the traps, an answer file), nothing has reviewed that either: the reveal runs again on it, which also checks the clauses of the
           brief again. */
        if (reveal.parsed.guidelineCovers === true || fair.repairs >= MAX_REVIEW_REPAIRS) break;
        const change = await this._reviewRepair(p, ctl, attempt, ctx, 'equivalent', finding);
        if (!change.names.includes('guideline.md')) reject('The repair did not add the equivalent result to the guideline', `${finding}\nYour repair did not change out/guideline.md. Add the equivalent result to its "Acceptable variation" section.`);
        await this._answerSetTest(p, ctl, attempt, ctx.holder.design, { why: change.packet ? 'after the packet changed' : 'after the equivalent result was added' });
        const beyond = change.names.some(name => name !== 'guideline.md' && EVALUATOR_PATH_RE.test(name));
        if (!change.packet && !beyond) break;
        if (evaluation >= MAX_REVIEW_EVALUATIONS) reject(change.packet ? 'The repair changed the packet and there is no review left' : 'The repair changed more than the guideline and there is no review left', `${finding}\nYour repair changed ${change.packet ? 'a file the pilots get, which the review had not seen' : 'evaluator material beyond the guideline, which the review had not seen'}. Change only out/guideline.md for an equivalent result.`);
        if (change.packet) rerunBlind = true;
        continue;
      }

      /* unresolved: one repair turn, then the reveal once more. */
      if (last) reject('The reviews could not settle which answer the files support', finding);
      const change = await this._reviewRepair(p, ctl, attempt, ctx, 'missing', finding);
      if (!change.any) reject('The repair changed nothing, so the review could not be settled', `${finding}\nYour repair changed no file. Change the files or the guideline so that the question is settled.`);
      if (change.packet) {
        rerunBlind = true;
        /* The packet changed: the golden answer is checked again with the other fixed answers (the same answers, against the revised guideline). */
        await this._answerSetTest(p, ctl, attempt, ctx.holder.design, { why: 'after the packet changed' });
      } else {
        await this._answerSetTest(p, ctl, attempt, ctx.holder.design, { why: 'after the guideline was revised' });
      }
    }
    fair.status = 'passed';
    this._writeFairnessDetail(ctx.attemptDir, attempt, detail);
    this._save(p);
  },

  _reviewFinding(reveal) {
    const parsed = reveal.parsed;
    const lines = [`The strongest different answer the reviews found: ${parsed.alternative || '(not stated)'}`, `Objection class: ${reveal.objectionClass}. Disposition: ${reveal.disposition}.`];
    if (parsed.forAlternative && parsed.forAlternative.quote) lines.push(`For the alternative (${oneLine(parsed.forAlternative.file, 120)}): "${parsed.forAlternative.quote}"`);
    if (parsed.againstAlternative && parsed.againstAlternative.quote) lines.push(`Against the alternative (${oneLine(parsed.againstAlternative.file, 120)}): "${parsed.againstAlternative.quote}"`);
    lines.push(`The guideline already accepts it: ${parsed.guidelineCovers ? 'yes' : 'no'}.`);
    if (parsed.why) lines.push(`Why: ${parsed.why}`);
    for (const note of reveal.notes) lines.push(`Harness: ${note}.`);
    /* a date the checks could not read is the commonest reason for a clause to be called out of force */
    const failedDates = [reveal.application, ...(reveal.briefApplication ? reveal.briefApplication.failures : [])].some(item => item && Array.isArray(item.failed) && item.failed.includes('inForce'));
    if (failedDates) lines.push('Harness: the dates the checks read are written as 2025-03-01, 1 March 2025, March 1, 2025 or the 1st day of March, 2025. Other forms (03/01/2025, 20250301, "March 2025") are not read. A quote that holds more than one date must say which one takes effect ("takes effect on ..."). When the brief gives decision.decisionDate, the day must stand in prompt.txt or in a file the pilots get.');
    return lines.join('\n');
  },

  _writeFairnessDetail(attemptDir, attempt, detail) {
    try { writeJsonAtomic(path.join(attemptDir, 'fairness.json'), { attempt: attempt.n, fairness: attempt.fairness, answerSet: attempt.answerSet, ...detail }); } catch { /* the record in the state is what counts */ }
  },

  /* -------------------------------------------------------------- the diagnostic suite (optional, D5) */

  /* The optional suite behind the start-form switch fairnessSet: out/answers.json names up to six diagnostic answers with a band (high or low).
     Each is graded once; a high answer must reach ALTERNATIVE_MIN and a low answer must stay under the screen bar. A miss is a defect of
     the guideline (it does not tell the answers apart as the design says), so the attempt is rejected. */
  async _diagnosticSuite(p, ctl, attempt, ctx) {
    const design = ctx.holder.design;
    const n = attempt.n;
    let list;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(ctx.outDir, 'answers.json'), 'utf8'));
      list = Array.isArray(data) ? data : Array.isArray(data.answers) ? data.answers : null;
    } catch { list = null; }
    if (!list || !list.length || list.length > 6) throw new AttemptRejected('diagnostic', ['The diagnostic answers were not delivered as asked'], ['out/answers.json must list 1 to 6 diagnostic answers: [{"name", "file": "answers/diag-N.md", "band": "high" or "low"}].']);
    const guideline = design.guideline + GRADER_FOOTER;
    const results = [];
    const misses = [];
    for (const [index, item] of list.entries()) {
      this._checkStop(ctl);
      const file = item && typeof item.file === 'string' && /^answers\/[A-Za-z0-9._-]+\.md$/.test(item.file) ? item.file : '';
      const band = item && (item.band === 'high' || item.band === 'low') ? item.band : '';
      let text = '';
      if (file) { try { text = fs.readFileSync(path.join(ctx.outDir, ...file.split('/')), 'utf8'); } catch { text = ''; } }
      if (!file || !band || !text.trim()) throw new AttemptRejected('diagnostic', ['A diagnostic answer was not delivered as asked'], [`out/answers.json entry ${index + 1} needs a file under answers/ that exists, and a band of high or low.`]);
      this._reserve(p, 'a diagnostic answer', P.CAPS.graderUsd);
      const result = await this._pilotGrade(p, ctl, { stage: 'design', ref: `diag-${n}-${index + 1}`, guideline, answer: capText(text, MAX_ANSWER_FOR_GRADER), call: 1 });
      const score = result.ok ? result.score : null;
      const ok = score !== null && (band === 'high' ? score >= P.ALTERNATIVE_MIN : score < P.SCREEN_BAR);
      results.push({ name: oneLine(item.name, 80) || `answer ${index + 1}`, file, band, score, ok });
      if (!ok) misses.push(`${oneLine(item.name, 80) || file} (band ${band}, score ${score === null ? 'none' : score.toFixed(2)})`);
    }
    attempt.diagnostic = { results, passed: misses.length === 0 };
    this._save(p);
    if (misses.length) throw new AttemptRejected('diagnostic', [`The guideline did not grade ${misses.length} diagnostic answer${misses.length === 1 ? '' : 's'} as the design says (${misses.length} of ${results.length})`], [`The guideline did not grade these diagnostic answers into the band you declared (high: at least ${P.ALTERNATIVE_MIN.toFixed(2)}; low: below ${P.SCREEN_BAR.toFixed(2)}): ${misses.join('; ')}. Fix the guideline so that it grades them as declared.`]);
  },

  /* -------------------------------------------------------------- one attempt */

  _freezeRecord(p, ctl, attempt, manifest, reason) {
    const list = attempt.freeze || (attempt.freeze = []);
    const texts = this._designTexts(p, attempt.n);
    const fixed = attempt.answerSet ? attempt.answerSet.answers : [];
    const record = {
      n: list.length + 1, at: this.now(), reason,
      packetSha256: packetSha(manifest), packetFiles: manifest.length,
      promptSha256: attempt.promptSha256,
      guidelineSha256: sha256Hex(texts.guideline),
      goldenSha256: sha256Hex(texts.goldenAnswer),
      answerSetSha256: sha256Hex(fixed.map(item => `${item.name}:${item.sha256}`).join('\n')),
      answers: fixed.map(item => ({ name: item.name, sha256: item.sha256 })),
      pilot: { model: p.config.model, effort: p.config.effort, capUsd: p.config.pilotCapUsd },
      grader: { model: p.config.graderModel, effort: p.config.graderEffort },
      budget: { totalCapUsd: p.config.capUsd, designCapUsd: p.config.designCapUsd, pilotCapUsd: p.config.pilotCapUsd },
    };
    list.push(record);
    try { writeJsonAtomic(path.join(this._attemptDir(p.id, attempt.n), `freeze-${record.n}.json`), record); } catch { /* the record in the state is what counts */ }
    this._save(p);
    return record;
  },

  /* One attempt of the 'new' mode. Resolves when the design is accepted (p.design is the new design and the pilot packet is built) and throws
     AttemptRejected when it is not. */
  async _designNew(p, ctl) {
    const n = p.attempt + 1;
    const total = P.MAX_REDESIGNS + 1;
    this._setStage(p, 'design', `Designing the traps (attempt ${n} of ${total})`);
    this._checkStop(ctl);
    this._reserveAttempt(p, n);
    const designer = this._designerDir(p.id);
    fs.rmSync(designer, { recursive: true, force: true });
    fs.mkdirSync(path.join(designer, 'out'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(designer, '.tmp'), { recursive: true, mode: 0o700 });
    const redesign = n > 1;
    await this._writeDesignerInputs(p, ctl, designer, redesign);
    p.attempt = n;
    const attempt = {
      n, startedAt: this.now(), mode: 'new', traps: [], newFiles: 0, editedFiles: 0, screen: null, test: null, outcome: 'in-progress', repaired: false, rejection: null,
      validation: 'pending', answerSet: null, calibration: null, freeze: [], guidelineRepair: null,
      fairness: { status: 'pending', stage1: null, stage2: null, repairs: 0 },
      difficulty: { status: 'pending', screen: null, test: null },
    };
    p.attempts.push(attempt);
    this._save(p);
    const attemptDir = this._attemptDir(p.id, n);
    fs.mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
    const outDir = path.join(designer, 'out');
    const holder = { design: null };
    const hasReferences = Boolean(p.references && p.references.copied);

    let turn = await this._designerTurn(p, ctl, {
      prompt: designerPromptNew({ attempt: n, attempts: total, redesign, hasReferences, fairnessSet: p.config.fairnessSet === true }), cap: p.config.designCapUsd, kind: 'design', ref: `attempt ${n}`,
      transcript: path.join(attemptDir, 'design.transcript.jsonl'), designer,
    });
    /* What the designer wrote, read, scanned and checked against the packet it makes. */
    const tryRead = async () => {
      try {
        const sets = this._withheldSets(p, ctl);
        const design = readDesign({
          outDir, packet: ctl.packet, withheldHashes: sets.hashes, windows: this._leakWindowsOf(ctl), original: ctl.original, originalDir: this._origDir(p.id),
          mode: 'new', referenceWindows: ctl.referenceWindows || [],
        });
        const scanned = await scanDesignFiles({ outDir, design, shouldStop: () => ctl.stop });
        design.unscanned = scanned.unscanned;
        const checked = await verifyDesignBrief({ packet: ctl.packet, design, originalDir: this._origDir(p.id), outDir, referenceTexts: ctl.referenceTexts || [] });
        design.briefWarnings = checked.warnings;
        design.documents = checked.documents;
        holder.design = design;
        return null;
      } catch (error) {
        holder.design = null;
        if (error instanceof DesignError) return { message: error.message, detail: error.detail };
        throw error;
      }
    };
    let problem = turn.problem;
    if (!problem) problem = await tryRead();
    if (problem) {
      attempt.repaired = true;
      this._note(p, `Asking the trap designer to fix its work (attempt ${n} of ${total})`);
      this._checkStop(ctl);
      this._reserve(p, 'the repair turn', P.CAPS.repairUsd);
      turn = await this._designerTurn(p, ctl, {
        prompt: repairPrompt({ attempt: n, attempts: total, problem: problem.detail, mode: 'new' }), cap: P.CAPS.repairUsd, kind: 'design-repair', ref: `attempt ${n}`,
        transcript: path.join(attemptDir, 'repair.transcript.jsonl'), designer,
      });
      problem = turn.problem || await tryRead();
      if (problem) {
        attempt.validation = 'failed';
        attempt.fairness.status = 'not-reached'; /* the design never read, so no review ran: nothing is left pending */
        this._keepOut(outDir, path.join(attemptDir, 'out'));
        throw new AttemptRejected('design', [problem.message], [problem.detail]);
      }
    }
    attempt.audit = { status: 'CLEAN', violationCount: 0 };
    writeTextAtomic(path.join(attemptDir, 'design-summary.txt'), capText(turn.answer, 20000) + '\n');
    this._keepOut(outDir, path.join(attemptDir, 'out'));
    const first = holder.design;
    attempt.traps = first.traps.map(trap => ({ id: trap.id, title: trap.title }));
    attempt.newFiles = first.newFiles.length;
    attempt.editedFiles = first.editedFiles.length;
    attempt.promptSha256 = sha256Hex(first.prompt);
    attempt.taskType = { workflow: first.brief.taskType.workflow, why: first.brief.taskType.why, referenceEntries: first.brief.taskType.referenceEntries };
    this._save(p);

    const ctx = { holder, outDir, attemptDir, designer, total, tryRead };
    try {
      this._note(p, `Checking the design of attempt ${n}: the answer set, the blind review and the reveal`);
      await this._fairnessNew(p, ctl, attempt, ctx);
      if (p.config.fairnessSet === true) await this._diagnosticSuite(p, ctl, attempt, ctx);
    } catch (error) {
      if (error instanceof AttemptRejected) {
        attempt.validation = 'failed';
        if (attempt.fairness.status === 'pending') attempt.fairness.status = error.kind === 'answer-set' && !attempt.fairness.stage1 ? 'not-reached' : 'rejected';
        this._keepOut(outDir, path.join(attemptDir, 'out'));
        this._save(p);
      }
      throw error;
    }
    const design = holder.design;
    this._keepOut(outDir, path.join(attemptDir, 'out'));
    attempt.promptSha256 = sha256Hex(design.prompt);
    attempt.traps = design.traps.map(trap => ({ id: trap.id, title: trap.title }));
    attempt.newFiles = design.newFiles.length;
    attempt.editedFiles = design.editedFiles.length;
    attempt.taskType = { workflow: design.brief.taskType.workflow, why: design.brief.taskType.why, referenceEntries: design.brief.taskType.referenceEntries };

    /* Accepted: the pilot packet. It must be byte for byte the packet the blind reviewer read. */
    const manifest = await buildWork({ originalDir: this._origDir(p.id), outDir, workDir: this._packetDir(p.id), packet: ctl.packet, design, shouldStop: () => ctl.stop });
    this._checkStop(ctl);
    if (attempt.fairness.stage1 && attempt.fairness.stage1.packetSha256 && attempt.fairness.stage1.packetSha256 !== packetSha(manifest)) {
      throw new SafetyError('The pilot packet is not the packet the blind review read');
    }
    ctl.manifest = manifest;
    ctl.reviewedDesign = design;
    ctl.documents = design.documents;
    ctl.brief = design.brief;
    const after = this._withheldSets(p, ctl);
    require('./safety.cjs').verifyPacket({ dir: this._packetDir(p.id), manifest, withheldHashes: after.hashes, withheldNames: after.names, allowNames: ctl.keptNames });
    const bytes = manifest.reduce((sum, file) => sum + file.bytes, 0);
    attempt.validation = 'complete';
    this._freezeRecord(p, ctl, attempt, manifest, 'before the pilots');
    p.design = {
      attempt: n,
      traps: design.traps,
      gold: design.gold,
      fingerprints: design.fingerprints,
      newFiles: design.newFiles,
      editedFiles: design.editedFiles,
      packet: { fileCount: manifest.length, bytes, files: manifest },
      audit: attempt.audit,
      notes: design.notes.concat(design.briefWarnings || [], this._blindNotes(attempt)),
      repaired: attempt.repaired,
      calibration: attempt.calibration,
      fairness: attempt.fairness,
      guidelineDiff: design.guidelineDiff,
      rubricChanges: design.rubricChanges,
      unscanned: design.unscanned,
      brief: design.brief,
      taskType: attempt.taskType,
      alternatives: design.alternatives.map(item => ({ name: item.name, file: item.file, answer: item.answer })),
    };
    this._save(p);
  },

  /* Notes for the owner about what the blind review could not read (a file nobody could open, or only the start of a rendering). */
  _blindNotes(attempt) {
    const stage1 = attempt.fairness && attempt.fairness.stage1;
    if (!stage1 || !Array.isArray(stage1.unreadable) || !stage1.unreadable.length) return [];
    return [`The blind review could not read ${stage1.unreadable.length === 1 ? 'this file' : 'these files'} of the packet: ${stage1.unreadable.slice(0, 10).map(name => oneLine(name, 120)).join(', ')}. Its answer says nothing about ${stage1.unreadable.length === 1 ? 'it' : 'them'}; look at ${stage1.unreadable.length === 1 ? 'it' : 'them'} yourself.`];
  },

  /* -------------------------------------------------------------- the pilots (D6) */

  /* A deterministic hint for the adjudicator: does the final answer match the brief's wrong path or a fingerprint? It is only a hint. */
  _hint(p, ctl, ref) {
    const text = ctl.answers.get(ref) || '';
    const final = (ctl.finals && ctl.finals.get(ref)) || text;
    const out = { fingerprintHits: [], wrongPathFigures: false, goldMatch: false };
    try {
      const freeze = { gold: p.design.gold, fingerprints: p.design.fingerprints };
      const found = suggest(freeze, final, text);
      out.fingerprintHits = found.fingerprints.filter(item => item.hit).map(item => item.id);
      out.goldMatch = found.verdict === 'matches-frozen-gold';
      const wrong = ctl.brief ? ctl.brief.traps.flatMap(trap => trap.wrongPath.figures.map(figure => ({ label: figure.label, value: figure.value, tolerance: figure.tolerance }))) : [];
      if (wrong.length) out.wrongPathFigures = suggest({ gold: { figures: wrong }, fingerprints: [] }, final, text).matches.every(match => match.where === 'final');
    } catch { /* a hint that cannot be made is none */ }
    return out;
  },

  /* Every pilot below its bar gets one adjudication call. A low score counts toward the pass only when the answer is `intended` (the adopted
     action AND the rationale are in the answer, word for word) or `other_valid_error` (a clause of the packet that applies, shown by the
     application check). tool_failure makes the pilot a missing one. Everything else is unexplained. Sets record.adjudication and
     record.countsTowardPass; the details are in a private file of the attempt. */
  async _adjudicatePilot(p, ctl, { stage, record, ref, bar }) {
    const attempt = p.attempts[p.attempts.length - 1];
    const texts = this._designTexts(p);
    const answer = ctl.answers.get(ref) || '';
    const hint = this._hint(p, ctl, ref);
    /* The reviewer is shown the packet (and the prompt) with the authority files first; its quotes are held to what it was shown. */
    const docs = [...ctl.documents, { name: 'prompt.txt', text: texts.prompt }];
    const view = R.packetView(docs, R.PACKET_CAPS.adjudication, R.priorityFiles(ctl.brief));
    const report = {};
    const prompt = R.adjudicationPrompt({ guideline: texts.guideline, brief: ctl.brief, documents: docs, answer, graderReason: record.reason, score: record.score, hint, bar, view, report });
    let parsed = null;
    for (let tryNo = 1; tryNo <= 2 && !parsed; tryNo++) {
      const call = await this._reviewCall(p, ctl, { stage, kind: 'adjudication', ref, name: `adjudicate-${record.id}-${record.round}-${tryNo}`, prompt, cap: P.CAPS.adjudicationUsd });
      if (!call.usable) continue;
      const out = R.parseAdjudication(call.text);
      if (out.ok) parsed = out.value;
    }
    const corpus = buildCorpus(view.shown);
    let checked;
    const notes = [];
    if (!parsed) {
      checked = { class: 'unsupported', counts: false, needsApplication: false, clause: null, action: '', notes: ['the adjudication gave no usable answer'] };
    } else {
      checked = R.checkAdjudication(parsed, { answerText: answer, answerParts: report.answerParts, corpus });
    }
    notes.push(...checked.notes);
    if (report.cut && report.cut.length) notes.push(`the adjudicator was shown only the start and the end of ${report.cut.join(', ')}`);
    let application = null;
    let klass = checked.class;
    let counts = checked.counts;
    if (checked.needsApplication) {
      /* The clause is the one the harness found (in the file it names), and the alternative the clause must exclude is the action the harness found in the answer. */
      application = await this._applicationCheck(p, ctl, { n: attempt.n, tag: `${record.id}-${record.round}`, stage, clause: checked.clause, alternative: checked.action, decision: decisionText(ctl.brief), brief: ctl.brief, documents: ctl.documents, promptText: texts.prompt });
      if (application.pass) counts = true;
      else { klass = 'unsupported'; counts = false; notes.push(`the clause the answer violates was not shown to apply (${application.failed.join(', ')})`); }
    }
    /* tool_failure takes a pilot out of the stage and buys a replacement, so the adjudicator's word is not enough: the pilot's own record has to show a failed tool
       call on a file of the packet. Otherwise the claim is an unsupported one. */
    let evidence = null;
    if (klass === 'tool_failure') {
      evidence = this._toolFailureEvidence(ctl, ref);
      if (!evidence) { klass = 'unsupported'; counts = false; notes.push('the adjudication said the pilot could not read or open something, but the pilot\'s own record shows no failed tool call on a file of the packet'); }
    }
    record.adjudication = { class: klass, claimed: parsed ? parsed.class : null, counts, note: notes.length ? oneLine(notes.join('; '), 300) : '', application: application ? { pass: application.pass, failed: application.failed } : null };
    record.countsTowardPass = counts;
    if (klass === 'tool_failure') { record.valid = false; record.toolFailure = true; record.countsTowardPass = false; }
    try {
      const dir = path.join(this._attemptDir(p.id, attempt.n), 'adjudications');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeJsonAtomic(path.join(dir, `${record.id}-${record.round}-${record.run}${record.regraded ? '-regraded' : ''}.json`), { pilot: record.id, ref, score: record.score, hint, claimed: parsed, checked: { class: klass, counts, notes }, application, toolFailureEvidence: evidence });
    } catch { /* the record in the state is what counts */ }
    this._save(p);
  },

  /* The failed tool call that makes a pilot's "could not read or open something" real: the pilot's own transcript (the agent service's record of its run) is read
     for a tool result that is an error and that concerns a file of the pilot packet (the file's name stands in the call or in the error). Resolves
     { file, error } or null. Nothing the adjudicator said is used. */
  _toolFailureEvidence(ctl, ref) {
    const [roundId, run] = String(ref).split('#');
    if (!roundId || !/^\d+$/.test(run || '') || !/^[A-Za-z0-9._-]+$/.test(roundId)) return null;
    const file = path.join(this.root, 'private', 'agent-rounds', roundId, 'runs', run, 'transcript.jsonl');
    let text;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return null;
      text = fs.readFileSync(file, 'utf8');
    } catch { return null; }
    const names = (ctl.manifest || []).map(entry => entry.name);
    const bases = names.map(name => name.split('/').pop().toLowerCase());
    const calls = new Map();
    const ERROR_RE = /^\s*(?:<tool_use_error>|error:|this tool cannot read|file does not exist|no such file|permission denied|cannot read|unable to read|failed to read|file content .{0,60}exceeds)/i;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const content = event && event.message && Array.isArray(event.message.content) ? event.message.content : [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'tool_use') { calls.set(block.id, JSON.stringify(block.input || {}).toLowerCase()); continue; }
        if (block.type !== 'tool_result') continue;
        const body = typeof block.content === 'string' ? block.content : JSON.stringify(block.content === undefined ? '' : block.content);
        if (!(block.is_error === true || ERROR_RE.test(body))) continue;
        const touched = `${calls.get(block.tool_use_id) || ''} ${body.toLowerCase()}`;
        const at = bases.findIndex(base => base && touched.includes(base));
        if (at >= 0) return { file: names[at], error: oneLine(body, 160) };
      }
    }
    return null;
  },

  /* The numbers of a stage from its pilots: the counts by class, who is unexplained, and how it stands. repairOpen: see stageStanding. */
  _tallyStage(stage, repairOpen) {
    const valid = stage.pilots.filter(pilot => pilot.valid);
    stage.counted = valid.length;
    stage.belowBar = valid.filter(pilot => pilot.belowBar === true).length;
    stage.explained = valid.filter(pilot => pilot.countsTowardPass === true).length;
    stage.lows = lowCounts(stage.pilots);
    stage.unexplained = valid.filter(pilot => pilot.belowBar === true && pilot.countsTowardPass !== true).map(pilot => ({ pilot: pilot.id, class: pilot.adjudication ? pilot.adjudication.class : 'unsupported', score: pilot.score }));
    return stageStanding(stage.pilots, { need: stage.need, of: stage.of, repairOpen });
  },

  /* -------------------------------------------------------------- the guideline-only repair (D6.5) */

  /* A stage failed and some low score was classed permitted_alternative or grader_defect: the evaluator material is at fault, not the packet.
     One repair turn that may change only guideline.md and golden-answer.md, then the SAVED answers are graded again (no new pilots) and the
     stage is counted again. Once per attempt. Resolves the stage (counted again, or as it was when the repair did not hold). */
  async _evaluatorRepair(p, ctl, attempt, stage, kind) {
    if (attempt.guidelineRepair) return stage;
    const faulty = stage.pilots.filter(pilot => pilot.adjudication && EVALUATOR_FAULT.has(pilot.adjudication.class));
    if (!faulty.length) return stage;
    const n = attempt.n;
    const total = P.MAX_REDESIGNS + 1;
    const designer = this._designerDir(p.id);
    const outDir = path.join(designer, 'out');
    const attemptDir = this._attemptDir(p.id, n);
    const record = attempt.guidelineRepair = { stage: kind, at: this.now(), outcome: 'pending', classes: [...new Set(faulty.map(pilot => pilot.adjudication.class))], changed: [], regrade: null };
    this._setStage(p, kind, `Asking the trap designer to repair the guideline (attempt ${n} of ${total})`);
    this._reserve(p, 'the guideline repair', P.CAPS.repairUsd);
    const finding = faulty.map(pilot => {
      const answer = capText(ctl.answers.get(`${pilot.round}#${pilot.run}`) || '', 1500);
      return `Pilot ${pilot.id} scored ${pilot.score.toFixed(2)} and was judged ${pilot.adjudication.class}${pilot.adjudication.note ? ` (${pilot.adjudication.note})` : ''}.\nThe grader said: ${pilot.reason || '(no reason)'}\nThe answer began: ${answer}`;
    }).join('\n\n');
    const snapshot = path.join(attemptDir, 'out');
    const before = hashOut(outDir);
    const beforeTexts = this._designTexts(p);
    const turn = await this._designerTurn(p, ctl, { prompt: evaluatorRepairPrompt({ attempt: n, attempts: total, finding }), cap: P.CAPS.repairUsd, kind: 'guideline-repair', ref: `attempt ${n}`, transcript: path.join(attemptDir, 'guideline-repair.transcript.jsonl'), designer });
    const restore = () => { try { fs.rmSync(outDir, { recursive: true, force: true }); fs.cpSync(snapshot, outDir, { recursive: true }); } catch { /* the attempt copy is what the pilots were graded on */ } };
    const fail = reason => { record.outcome = 'failed'; record.reason = reason; restore(); this._save(p); return stage; };
    if (turn.problem) return fail('the designer could not do the repair');
    const change = changesOf(before, hashOut(outDir));
    if (!change.any) return fail('the repair changed nothing, so nothing material changed and nothing was run again');
    if (change.packet || change.names.some(name => !['guideline.md', 'golden-answer.md'].includes(name))) return fail('the repair changed more than the guideline and the golden answer, so it was not used');
    record.changed = change.names.slice();
    const problem = await (async () => {
      try {
        const sets = this._withheldSets(p, ctl);
        const design = readDesign({ outDir, packet: ctl.packet, withheldHashes: sets.hashes, windows: this._leakWindowsOf(ctl), original: ctl.original, originalDir: this._origDir(p.id), mode: 'new', referenceWindows: ctl.referenceWindows || [] });
        return { design };
      } catch (error) { if (error instanceof DesignError) return { error }; throw error; }
    })();
    if (problem.error) return fail('the revised guideline or golden answer did not pass the design checks');
    /* The same fixed answers, graded again against the revised guideline; the golden answer is the revised one when the repair changed it. */
    const revised = { ...ctl.reviewedDesign, guideline: problem.design.guideline, goldenAnswer: problem.design.goldenAnswer, alternatives: problem.design.alternatives };
    const before2 = attempt.answerSet ? JSON.parse(JSON.stringify(attempt.answerSet.answers.map(item => ({ name: item.name, grades: item.grades, score: item.score })))) : [];
    let set;
    try {
      set = await this._answerSetTest(p, ctl, attempt, revised, { why: 'after the guideline repair', stage: kind === 'screen' ? 'grade-screen' : 'grade-test', reject: false });
    } catch (error) { throw error; }
    record.regrade = { before: before2, after: attempt.answerSet.answers.map(item => ({ name: item.name, grades: item.grades, score: item.score, passed: item.passed, unstable: item.unstable })), passed: set.passed };
    if (!set.passed) return fail('the revised guideline did not grade the fixed answers as required');
    this._keepOut(outDir, snapshot);
    record.outcome = 'applied';
    p.design.calibration = attempt.calibration;
    record.guidelineSha256 = hashFile(path.join(snapshot, 'guideline.md'));
    record.oldGuidelineSha256 = sha256Hex(beforeTexts.guideline);
    this._freezeRecord(p, ctl, attempt, ctl.manifest, 'after the guideline repair');
    this._save(p);
    return this._recount(p, ctl, attempt, stage, kind);
  },

  /* The saved answers of a stage graded again against the current guideline (no new pilots), every low score adjudicated again unless it was
     `intended` (that rests on the packet and the brief, not on the guideline), then the stage counted again. */
  async _recount(p, ctl, attempt, stage, kind) {
    const gradeStage = kind === 'screen' ? 'grade-screen' : 'grade-test';
    this._setStage(p, gradeStage, `Grading the saved answers of the ${kind} pilots again against the revised guideline`);
    const band = this.bands[kind];
    const grading = { calls: 0, refused: 0, firstError: '' };
    const changes = [];
    for (const record of stage.pilots) {
      const ref = `${record.round}#${record.run}`;
      if (record.stoppedEarly || !ctl.answers.has(ref) || !record.valid) continue;
      this._checkStop(ctl);
      this._reserve(p, 'grading the saved answers again', P.GRADE_CALLS_PER_PILOT * P.CAPS.graderUsd);
      const previous = { score: record.score, belowBar: record.belowBar, countsTowardPass: record.countsTowardPass, adjudication: record.adjudication, valid: record.valid };
      record.previous = previous;
      record.regraded = true;
      record.valid = false;
      try {
        await this._scorePilot(p, ctl, { stage: gradeStage, record, ref, band, bar: stage.bar, grading, gradeRef: `${ref}-regrade` });
        if (record.valid && record.belowBar === true) {
          if (previous.adjudication && previous.adjudication.class === 'intended' && previous.belowBar === true) {
            record.adjudication = previous.adjudication;
            record.countsTowardPass = true;
          } else {
            await this._adjudicatePilot(p, ctl, { stage: gradeStage, record, ref, bar: stage.bar });
          }
        } else if (record.valid) {
          record.adjudication = null;
          record.countsTowardPass = false;
        }
      } catch (error) {
        /* A stop or a cap in the middle of one pilot: that pilot keeps the score it had (it is not left without one), and the run ends with the repair
           not counted (see _finish): nothing here passes. */
        Object.assign(record, { score: previous.score, belowBar: previous.belowBar, countsTowardPass: previous.countsTowardPass, adjudication: previous.adjudication, valid: previous.valid, regraded: false });
        delete record.previous;
        throw error;
      }
      changes.push({ pilot: record.id, from: previous.score, to: record.score });
    }
    const standing = this._tallyStage(stage, false);
    stage.passed = standing.counted >= stage.need;
    stage.recount = { at: this.now(), changes };
    attempt.guidelineRepair.recounted = { passed: stage.passed, explained: stage.explained };
    this._save(p);
    return stage;
  },

  /* The difficulty result of an attempt, kept apart from its fairness result. */
  _setDifficulty(attempt, kind, stage) {
    const summary = stage ? { passed: stage.passed === true, explained: stage.explained === undefined ? stage.belowBar : stage.explained, belowBar: stage.belowBar, of: stage.of, need: stage.need, lows: stage.lows || null } : null;
    attempt.difficulty[kind] = summary;
    if (stage && stage.passed === false) attempt.difficulty.status = 'failed';
    else if (kind === 'test' && stage && stage.passed) attempt.difficulty.status = 'passed';
    else if (attempt.difficulty.status !== 'failed') attempt.difficulty.status = 'pending';
  },

  /* The windows of everything withheld, as one WindowSet (a text is checked by one pass over it, whatever the size of the withheld material). */
  _leakWindowsOf(ctl) {
    if (!ctl.leakSet) {
      const { leakWindows, WindowSet } = require('./safety.cjs');
      ctl.leakSet = new WindowSet([...leakWindows(ctl.texts.guideline || ctl.texts.guidelineExtracted || ''), ...leakWindows(ctl.texts.goldenAnswer || ctl.texts.goldenExtracted || ''), ...(ctl.withheldWindows || [])]);
    }
    return ctl.leakSet;
  },
};
