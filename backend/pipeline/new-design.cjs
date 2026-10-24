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
const { sha256Hex, capText, oneLine, writeJsonAtomic, writeTextAtomic, walkFiles, hashFile, delay } = require('./util.cjs');
const { attemptReserveUsd } = require('./budget.cjs');
const { SafetyError } = require('./safety.cjs');
const { buildWork, designerPromptNew, repairPrompt, reviewRepairPrompt, evaluatorRepairPrompt, readDesign, scanDesignFiles, verifyDesignBrief } = require('./design.cjs');
const { runReviewer, runToolLess } = require('./models.cjs');
const { decideGrades, meanScore, graderEffort, lowCounts, stageStanding, EVALUATOR_FAULT, GRADER_FOOTER, MAX_ANSWER_FOR_GRADER } = require('./gates.cjs');
const { buildCorpus, findQuote, normalizeText } = require('./quotes.cjs');
const R = require('./review.cjs');
const { suggest } = require('../agents/classify.cjs');

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

  _forbiddenText() { return [path.join(this.root, 'private')]; },

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
      run = await runToolLess({ rt: this.rt, folder, prompt, model: p.config.model, effort: graderEffort(p.config.effort), capUsd: cap, onRunner: this._track(ctl), isolated: { forbiddenText: this._forbiddenText() } });
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
     stages. A cap that cannot pay ends the run as incomplete: nothing was validated. */
  _reserveAttempt(p, n) {
    const need = round6(attemptReserveUsd(p.config.designCapUsd, { fairnessSet: p.config.fairnessSet === true }) * P.HEADROOM);
    if (round6(p.spentUsd + need) > p.config.capUsd + 1e-9) {
      throw new BudgetStop(`Stopped before attempt ${n}: the checks every design must pass (the designer, the reviews, the answer set and the adjudication of the pilots) could cost up to USD ${need.toFixed(2)} (with ${Math.round((P.HEADROOM - 1) * 100)}% headroom), USD ${p.spentUsd.toFixed(2)} is spent, and the cap is USD ${p.config.capUsd.toFixed(2)}. The design was not validated, so nothing here counts as a pass.`, { incomplete: true });
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
    ctl.referenceDir = dest;
    ctl.referenceTexts = texts;
    ctl.referenceWindows = windows.set;
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
        score: meanScore(graded.grades), passed: !graded.failed && graded.decision.passed === true, unstable: graded.decision.unstable === true, noGrade: graded.failed && graded.grades.length < 2,
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
          failures.push(`${what} scored ${run.score.toFixed(2)} against the guideline (grades ${run.grades.map(value => value.toFixed(2)).join(', ')}); at least ${fixed.threshold.toFixed(2)} is needed`);
          details.push(`${fixed.kind === 'golden' ? 'Your golden answer' : `Your alternative answer ${fixed.file}`} scored ${run.score.toFixed(2)} against your guideline (grades ${run.grades.map(value => value.toFixed(2)).join(', ')}): ${graded.reason || '(no reason given)'}. It must score at least ${fixed.threshold.toFixed(2)}. This is a defect of the guideline or of the answer: fix them so that they agree, without taking a rule out of the packet.`);
        }
      }
    }
    set.passed = set.answers.every(item => item.passed);
    this._save(p);
    if (failures.length && reject) throw new AttemptRejected('answer-set', failures, details);
    return { passed: failures.length === 0, failures, details };
  },

  /* -------------------------------------------------------------- the reviews (D4) */

  /* Stage 1: a reader with only a copy of the pilot packet and the revised prompt, run with the Read tool and audited like a pilot. A run
     that broke the audit is discarded. Resolves { value, packetSha256 } or throws AttemptRejected when two runs gave nothing usable. */
  async _blindStage(p, ctl, attempt, ctx, round) {
    const design = ctx.holder.design;
    const n = attempt.n;
    const record = attempt.fairness.stage1 || (attempt.fairness.stage1 = { state: 'running', tries: 0, runs: 0, packetSha256: null });
    record.runs++;
    for (let tryNo = 1; tryNo <= 2; tryNo++) {
      this._checkStop(ctl);
      this._reserve(p, 'the blind review', P.CAPS.blindReviewUsd);
      record.tries++;
      const folder = this._reviewFolder(p, `review-${n}-${round}-${tryNo}`);
      let outcome = null;
      try {
        const manifest = await buildWork({ originalDir: this._origDir(p.id), outDir: ctx.outDir, workDir: path.join(folder, 'filesystem'), packet: ctl.packet, design, shouldStop: () => ctl.stop });
        fs.writeFileSync(path.join(folder, 'prompt.txt'), design.prompt + '\n', { mode: 0o600 });
        const run = await runReviewer({
          rt: this.rt, folder, prompt: R.blindPrompt({ prompt: design.prompt }), model: p.config.model, effort: P.MIN_GRADER_EFFORT, capUsd: P.CAPS.blindReviewUsd,
          transcriptPath: path.join(ctx.attemptDir, `review-${round}-${tryNo}.transcript.jsonl`), projectRoot: this.root, onRunner: this._track(ctl), isolated: { forbiddenText: this._forbiddenText() },
        });
        this._spend(p, 'design', 'blind-review', `attempt ${n}`, run.costUsd, P.CAPS.blindReviewUsd, !run.summary.spawnError);
        if (run.summary.state === 'cancelled' || ctl.stop) throw new StopSignal('stopped');
        if (run.audit && run.audit.status !== 'CLEAN') {
          record.discarded = (record.discarded || 0) + 1;
        } else if (run.summary.state === 'completed') {
          const parsed = R.parseBlind(run.answer);
          if (parsed.ok) outcome = { value: parsed.value, packetSha256: packetSha(manifest) };
        }
      } finally {
        try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* a leftover folder is private */ }
      }
      if (outcome) {
        record.state = 'ok';
        record.packetSha256 = outcome.packetSha256;
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
    const hits = R.supersessionHits(docs, clause);
    const view = R.packetView(docs, R.PACKET_CAPS.application, R.priorityFiles(brief, [clause.file]));
    const corpus = buildCorpus(view.shown);
    const prompt = R.applicationPrompt({ clause, alternative, decision, decisionDate: brief && brief.decision ? brief.decision.decisionDate : '', hits, documents: docs, view });
    let parsed = null;
    for (let tryNo = 1; tryNo <= 2 && !parsed; tryNo++) {
      const call = await this._reviewCall(p, ctl, { stage, kind: 'application', ref: tag, name: `apply-${n}-${tag}-${tryNo}`, prompt, cap: P.CAPS.applicationUsd });
      if (!call.usable) continue;
      const out = R.parseApplication(call.text);
      if (out.ok) parsed = out.value;
    }
    const unscanned = hits.filter(hit => hit.kind === 'unreadable').map(hit => hit.document);
    if (!parsed) return { pass: false, failed: ['unusable'], checks: { governs: false, inForce: false, notSuperseded: false, excludes: false }, dates: null, hits: hits.length, unscanned, cut: view.cut };
    const checked = R.checkApplication(parsed, { corpus, hits, clause, brief });
    return { ...checked, hits: hits.length, cut: view.cut };
  },

  /* The clauses of the brief, each checked as the reveal's clause is: the rule of every trap against its wrong path, and the quote that rules out every
     trap's strongest alternative. A clause that was already checked on this packet (the same file, words and alternative) is not checked again; ctx.appCache
     keeps the results until the packet changes. Resolves { pass, count, failures: [{ trap, part, failed }], unscanned, cut } (traps are numbered from 1:
     the id a designer chose can carry a figure). skip: keys already checked in this review. */
  async _briefApplications(p, ctl, attempt, ctx, round, skip) {
    const design = ctx.holder.design;
    const full = buildCorpus([...design.documents, { name: 'prompt.txt', text: design.prompt }]);
    const decision = decisionText(design.brief);
    const jobs = [];
    design.brief.traps.forEach((trap, index) => {
      jobs.push({ trap: index + 1, part: 'rule', clause: { file: trap.rule.file, quote: trap.rule.clause }, alternative: trap.wrongPath.action });
      const file = findQuote(trap.strongestAlternative.whyRejected, full, undefined, { strict: true });
      jobs.push({ trap: index + 1, part: 'whyRejected', clause: { file, quote: trap.strongestAlternative.whyRejected }, alternative: trap.strongestAlternative.answer });
    });
    const done = new Set(skip);
    const failures = [];
    const unscanned = new Set();
    const cut = new Set();
    let count = 0;
    for (const job of jobs) {
      const key = sha256Hex([job.clause.file, normalizeText(job.clause.quote), normalizeText(job.alternative)].join('\n'));
      if (done.has(key)) continue;
      done.add(key);
      let result = ctx.appCache.get(key);
      if (!result) {
        result = job.clause.file
          ? await this._applicationCheck(p, ctl, { n: attempt.n, tag: `brief-${round}-${job.trap}${job.part === 'rule' ? 'r' : 'w'}`, clause: job.clause, alternative: job.alternative, decision, brief: design.brief, documents: design.documents, promptText: design.prompt })
          : { pass: false, failed: ['governs'], unscanned: [], cut: [] };
        ctx.appCache.set(key, result);
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
    const prompt = R.revealPrompt({ prompt: design.prompt, guideline: design.guideline, goldenAnswer: design.goldenAnswer, brief: design.brief, blind: blind.value, documents: design.documents, view });
    let parsed = null;
    for (let tryNo = 1; tryNo <= 2 && !parsed; tryNo++) {
      const call = await this._reviewCall(p, ctl, { kind: 'reveal', ref: `attempt ${n}`, name: `reveal-${n}-${round}-${tryNo}`, prompt, cap: P.CAPS.revealReviewUsd });
      if (!call.usable) continue;
      const out = R.parseReveal(call.text);
      if (out.ok) parsed = out.value;
    }
    if (!parsed) throw new AttemptRejected('review', ['The second review gave no usable answer'], ['The second review (the reveal) of your design gave no usable answer twice. Make the guideline, the brief and the packet plain enough to be compared.']);
    const corpus = buildCorpus([...view.shown, { name: 'prompt.txt', text: capText(design.prompt, 8000) }]);
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
      done.add(sha256Hex([clause.file, normalizeText(clause.quote), normalizeText(alternative)].join('\n')));
      application = await this._applicationCheck(p, ctl, { n, tag: `reveal-${round}`, clause, alternative, decision, brief: design.brief, documents: design.documents, promptText: design.prompt });
      if (!application.pass) {
        disposition = 'unresolved';
        notes.push(`the clause quoted against the alternative was not shown to apply (${application.failed.join(', ')})`);
      }
    }
    const settledPermitted = disposition === 'permitted' && parsed.guidelineCovers === true && Boolean(ctx.alternativesGraded && ctx.alternativesGraded());
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
    ctx.appCache = new Map(); /* results of the application checks of the brief's clauses; cleared when the packet changes */
    /* Is there a permitted alternative, with a fixed answer that the guideline grades at ALTERNATIVE_MIN or more? */
    ctx.alternativesGraded = () => {
      const set = attempt.answerSet;
      const alternatives = ctx.holder.design.alternatives;
      return Boolean(set) && alternatives.length > 0 && alternatives.every(alternative => { const entry = set.answers.find(item => item.name === alternative.name); return Boolean(entry && entry.passed); });
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
        /* The packet allows the alternative. That is not a rejection: it is settled once the guideline accepts it and a fixed answer that takes it is graded
           at ALTERNATIVE_MIN or more (the answer set grades every declared alternative). Otherwise one repair adds the line to the acceptable variation and
           writes the answer, and the review runs once more. */
        if (reveal.parsed.guidelineCovers === true && ctx.alternativesGraded()) break;
        if (last) reject('The reviews found an answer that the packet allows, and the guideline does not yet accept it with a graded answer', finding);
        const change = await this._reviewRepair(p, ctl, attempt, ctx, 'alternative', finding);
        const now = ctx.holder.design;
        if (!change.any) reject('The repair changed nothing, so the permitted alternative was not added', `${finding}\nYour repair changed no file. Add the alternative to the acceptable variation of out/guideline.md, write its answer under out/answers/ and list it in out/brief.json.`);
        if (!now.alternatives.length) reject('The repair did not write an answer for the permitted alternative', `${finding}\nThe design still has no permitted alternative with an answer file under out/answers/. Write one (a strong answer that takes the alternative with correct reasoning) and list it in permittedAlternatives of out/brief.json.`);
        if (reveal.parsed.guidelineCovers !== true && !change.names.includes('guideline.md')) reject('The repair did not add the permitted alternative to the guideline', `${finding}\nYour repair did not change out/guideline.md. Add the alternative to its "Acceptable variation" section.`);
        if (change.packet) { rerunBlind = true; ctx.appCache.clear(); }
        await this._answerSetTest(p, ctl, attempt, now, { why: change.packet ? 'after the packet changed' : 'after the permitted alternative was added' });
        continue;
      }

      if (d === 'equivalent_result') {
        /* Accepted. A line in the acceptable variation is added when the guideline lacks it, so the grader does not punish it. If that repair touches the
           packet, the packet is not the one that was reviewed: it is reviewed again. */
        if (reveal.parsed.guidelineCovers === true || fair.repairs >= MAX_REVIEW_REPAIRS) break;
        const change = await this._reviewRepair(p, ctl, attempt, ctx, 'equivalent', finding);
        await this._answerSetTest(p, ctl, attempt, ctx.holder.design, { why: change.packet ? 'after the packet changed' : 'after the equivalent result was added' });
        if (!change.packet) break;
        if (evaluation >= MAX_REVIEW_EVALUATIONS) reject('The repair changed the packet and there is no review left', `${finding}\nYour repair changed a file the pilots get, which the review had not seen. Change only out/guideline.md for an equivalent result.`);
        rerunBlind = true;
        ctx.appCache.clear();
        continue;
      }

      /* unresolved: one repair turn, then the reveal once more. */
      if (last) reject('The reviews could not settle which answer the files support', finding);
      const change = await this._reviewRepair(p, ctl, attempt, ctx, 'missing', finding);
      if (!change.any) reject('The repair changed nothing, so the review could not be settled', `${finding}\nYour repair changed no file. Change the files or the guideline so that the question is settled.`);
      if (change.packet) {
        rerunBlind = true;
        ctx.appCache.clear();
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
      notes: design.notes.concat(design.briefWarnings || []),
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
    const prompt = R.adjudicationPrompt({ guideline: texts.guideline, brief: ctl.brief, documents: docs, answer, graderReason: record.reason, score: record.score, hint, bar, view });
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
      checked = R.checkAdjudication(parsed, { answerText: answer, corpus });
    }
    notes.push(...checked.notes);
    let application = null;
    let klass = checked.class;
    let counts = checked.counts;
    if (checked.needsApplication) {
      /* The clause is the one the harness found (in the file it names), and the alternative the clause must exclude is the action the harness found in the answer. */
      application = await this._applicationCheck(p, ctl, { n: attempt.n, tag: `${record.id}-${record.round}`, stage, clause: checked.clause, alternative: checked.action, decision: decisionText(ctl.brief), brief: ctl.brief, documents: ctl.documents, promptText: texts.prompt });
      if (application.pass) counts = true;
      else { klass = 'unsupported'; counts = false; notes.push(`the clause the answer violates was not shown to apply (${application.failed.join(', ')})`); }
    }
    record.adjudication = { class: klass, claimed: parsed ? parsed.class : null, counts, note: notes.length ? oneLine(notes.join('; '), 300) : '', application: application ? { pass: application.pass, failed: application.failed } : null };
    record.countsTowardPass = counts;
    if (klass === 'tool_failure') { record.valid = false; record.toolFailure = true; record.countsTowardPass = false; }
    try {
      const dir = path.join(this._attemptDir(p.id, attempt.n), 'adjudications');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeJsonAtomic(path.join(dir, `${record.id}-${record.round}-${record.run}${record.regraded ? '-regraded' : ''}.json`), { pilot: record.id, ref, score: record.score, hint, claimed: parsed, checked: { class: klass, counts, notes }, application });
    } catch { /* the record in the state is what counts */ }
    this._save(p);
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
      const previous = { score: record.score, belowBar: record.belowBar, countsTowardPass: record.countsTowardPass, adjudication: record.adjudication };
      record.previous = previous;
      record.regraded = true;
      record.valid = false;
      this._reserve(p, 'grading the saved answers again', P.GRADE_CALLS_PER_PILOT * P.CAPS.graderUsd);
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

  _leakWindowsOf(ctl) {
    const { leakWindows } = require('./safety.cjs');
    return [...leakWindows(ctl.texts.guideline || ctl.texts.guidelineExtracted || ''), ...leakWindows(ctl.texts.goldenAnswer || ctl.texts.goldenExtracted || ''), ...(ctl.withheldWindows || [])];
  },
};
