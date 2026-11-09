'use strict';
/* The orchestrator: one field of text in, one final text field out, through a network of workers that it runs in lock step.

     secretary (1)      reads the frozen source and writes the brief: the terminology lock, the noun-verb map, the fact ledger with the
                        basis of every figure (secretary.cjs). The document is cut into chunks (chunks.cjs) and every figure and locked
                        term is masked (mask.cjs).
     sign-off (n)       scans each chunk as it stands (pass 0). A chunk already at its bar is deposited and never rewritten.
     then, per round, up to maxPasses passes of
       rewriters (n)    send each open chunk to the rewriter (Verva): the whole chunk on its first pass, afterwards only the sentences the
                        last scan read at or above the flagged-span line (0.80 AI), each widened to the rewriter's minimum length;
       repair (n)       hold every returned segment to the source and the brief, splice back the source sentence wherever a figure, a
                        basis, a subject, a negation or a direction slipped, and reject what cannot be repaired (repair.cjs);
       sign-off (n)     scan what the repair passed. At or above the chunk's bar (0.90 prose, 0.70 other) the chunk is deposited into
                        the final text field; otherwise its best version so far is kept for the next pass.
     after the round    the aggregate is the word-weighted mean of every chunk's best reading. At or above 0.80 the run is done.
                        Below it, every chunk that used its passes without reaching its bar is respliced (a chunk of several paragraphs
                        or bullets is cut into one chunk per paragraph; a single paragraph starts again from its source) and goes back
                        through the rewriter, the repair and the sign-off in the next round.

   Each stage finishes for every chunk before the next stage starts (a barrier), and the workers of a stage return their results in chunk
   order (pool.cjs), so a run's output does not depend on timing. workers: 1 makes every call one after the other.

   The run ends with status passed (the aggregate reached its bar), below-bar (maxRounds used), stalled (stallRounds rounds without a gain),
   budget (a call cap was reached), cancelled, needs-sign-in (the rewriter's page asked for a sign-in) or failed (an error). Whatever the
   status, `final` is the document assembled from the best version of every chunk that passed the repair gate (the source where none did),
   and nothing is edited after its last scan. A detector marked `estimate` (the offline stub) never signs a run off: signedOff stays false.

   runHumanize(text, { rewriter, detector, options, signal, onUpdate }) -> Promise<result>  (never rejects; errors become status failed)
   Providers: rewriter { id, label, minWords?, rewrite(maskedText, { signal }) -> text, preflight?(), close?() }
              detector { id, label, estimate?, scan(text, { signal }) -> { human, sentences: [{ text, generatedProb }], ... }, preflight?() } */

const { BARS, LIMITS } = require('./constants.cjs');
const { brief: writeBrief } = require('./secretary.cjs');
const { segment, assemble, joinSegments, splitReturned } = require('./chunks.cjs');
const { choosePrefix, maskSegments, unmask } = require('./mask.cjs');
const { repairSegment } = require('./repair.cjs');
const { splitSentences, wordCount, normalizeSpace } = require('./text.cjs');
const { runPool, AbortedError } = require('./pool.cjs');
const { HumanizeError, BudgetError } = require('./errors.cjs');

const clampInt = (value, min, max, fallback) => (Number.isInteger(value) && value >= min && value <= max ? value : fallback);
const clampBar = (value, fallback) => (Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback);

/* The settings a run uses, every value inside its allowed range (an invalid one falls back to the default). */
function settingsOf(options = {}) {
  const bars = options.bars || {};
  const workers = options.workers;
  const w = typeof workers === 'object' && workers ? workers : { rewrite: workers, scan: workers };
  return {
    bars: { prose: clampBar(bars.prose, BARS.prose), other: clampBar(bars.other, BARS.other), aggregate: clampBar(bars.aggregate, BARS.aggregate) },
    maxPasses: clampInt(options.maxPasses, 1, LIMITS.maxPassesCap, LIMITS.maxPasses),
    maxRounds: clampInt(options.maxRounds, 1, LIMITS.maxRoundsCap, LIMITS.maxRounds),
    workers: { rewrite: clampInt(w.rewrite, 1, LIMITS.maxWorkers, LIMITS.workers), scan: clampInt(w.scan, 1, LIMITS.maxWorkers, LIMITS.workers) },
    flaggedSpan: clampBar(options.flaggedSpan, LIMITS.flaggedSpan),
    maxLengthDrift: Number.isFinite(options.maxLengthDrift) && options.maxLengthDrift > 0 && options.maxLengthDrift <= 1 ? options.maxLengthDrift : LIMITS.maxLengthDrift,
    minChunkWords: clampInt(options.minChunkWords, 1, 1000, LIMITS.minChunkWords),
    maxChunkWords: clampInt(options.maxChunkWords, 20, 2000, LIMITS.maxChunkWords),
    maxRewriteCalls: clampInt(options.maxRewriteCalls, 1, 5000, LIMITS.maxRewriteCalls),
    maxScanCalls: clampInt(options.maxScanCalls, 1, 5000, LIMITS.maxScanCalls),
    stallRounds: clampInt(options.stallRounds, 1, LIMITS.maxRoundsCap, LIMITS.stallRounds),
    baselineScan: options.baselineScan !== false,
  };
}

const words = list => list.reduce((n, t) => n + wordCount(t), 0);
const round3 = x => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);

/* Per-sentence AI readings of a scan, laid onto the masked sentences of each segment (null where no scanned sentence matches). */
function sentenceReadings(maskedTexts, map, prefix, scanned) {
  const norm = s => normalizeSpace(s).toLowerCase().replace(/[^\p{L}\p{N}%$ ]/gu, '');
  const bag = s => new Set(s.split(' ').filter(Boolean));
  const list = (scanned || []).filter(s => s && typeof s.text === 'string' && Number.isFinite(s.generatedProb)).map(s => ({ n: norm(s.text), b: bag(norm(s.text)), p: s.generatedProb }));
  return maskedTexts.map(text => splitSentences(text).map(s => {
    const n = norm(unmask(s.text, map, prefix));
    if (!n) return null;
    const b = bag(n);
    let best = null;
    for (const g of list) {
      if (!g.n) continue;
      const inter = [...b].filter(w => g.b.has(w)).length;
      const jaccard = inter / (new Set([...b, ...g.b]).size || 1);
      if (n.includes(g.n) || g.n.includes(n) || jaccard >= 0.6) best = best === null ? g.p : Math.max(best, g.p);
    }
    return best;
  }));
}

async function runHumanize(text, deps = {}) {
  const { rewriter, detector, signal } = deps;
  const settings = settingsOf(deps.options);
  const onUpdate = typeof deps.onUpdate === 'function' ? deps.onUpdate : () => {};
  const now = typeof deps.now === 'function' ? deps.now : () => new Date().toISOString();
  const source = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const run = {
    status: 'running', error: null, stage: 'secretary', round: 0, pass: 0, startedAt: now(), endedAt: null,
    calls: { rewrite: 0, scan: 0 }, aggregate: { human: null, bar: settings.bars.aggregate, met: false, history: [] }, log: [],
  };
  const log = (message, extra = {}) => { run.log.push({ at: now(), round: run.round, pass: run.pass, stage: run.stage, ...extra, text: message }); };
  let segments = [];
  let chunks = [];
  let brief = { facts: [], terms: [], bindings: [], tokens: [] };
  let map = {};
  let prefix = 'K';
  const seg = {}; /* id -> { source, best } masked texts */

  const unmaskedBest = () => {
    const texts = {};
    for (const s of segments) if (seg[s.id]) texts[s.id] = unmask(seg[s.id].best, map, prefix);
    return texts;
  };
  const chunkWords = c => words(c.segmentIds.map(id => unmask(seg[id].best, map, prefix)));
  const view = () => ({
    ...run,
    settings,
    providers: {
      rewriter: rewriter ? { id: rewriter.id, label: rewriter.label || rewriter.id } : null,
      detector: detector ? { id: detector.id, label: detector.label || detector.id, estimate: Boolean(detector.estimate) } : null,
    },
    signedOff: run.status === 'passed' && Boolean(detector) && !detector.estimate,
    brief: { facts: brief.facts, terms: brief.terms, bindings: brief.bindings },
    chunks: chunks.map(c => ({
      id: c.id, kind: c.kind, bar: c.bar, status: c.status, parent: c.parent || null, words: chunkWords(c),
      best: { human: round3(c.best.human), round: c.best.round, pass: c.best.pass },
      passes: c.passes,
      notes: c.best.notes || [],
      text: joinSegments(c.segmentIds.map(id => unmask(seg[id].best, map, prefix))),
      source: joinSegments(c.segmentIds.map(id => unmask(seg[id].source, map, prefix))),
    })),
    final: segments.length ? assemble(segments, unmaskedBest()) : source,
  });
  const update = () => { try { onUpdate(view()); } catch { /* a listener's failure is not the run's */ } };
  const checkAbort = () => { if (signal && signal.aborted) throw new AbortedError(); };

  async function callRewriter(maskedText) {
    checkAbort();
    if (run.calls.rewrite >= settings.maxRewriteCalls) throw new BudgetError(`The run reached its cap of ${settings.maxRewriteCalls} rewriter calls.`);
    run.calls.rewrite += 1;
    const out = await rewriter.rewrite(maskedText, { signal });
    if (typeof out !== 'string' || !out.trim()) throw new HumanizeError(`${rewriter.label || rewriter.id} returned no text.`, 'rewriter', 502);
    return out;
  }

  async function callDetector(plainText) {
    checkAbort();
    if (run.calls.scan >= settings.maxScanCalls) throw new BudgetError(`The run reached its cap of ${settings.maxScanCalls} detector scans.`);
    run.calls.scan += 1;
    const r = await detector.scan(plainText, { signal });
    if (!r || !Number.isFinite(r.human) || r.human < 0 || r.human > 1) throw new HumanizeError(`${detector.label || detector.id} returned no human reading.`, 'detector', 502);
    return r;
  }

  /* The rewrite of one chunk, as masked texts per segment (null when the answer could not be laid back onto the segments). */
  async function rewriteChunk(c) {
    const current = c.segmentIds.map(id => (c.fromSource ? seg[id].source : seg[id].best));
    const minWords = Number.isInteger(rewriter.minWords) ? rewriter.minWords : 0;
    const flagged = !c.fresh && c.readings ? c.readings.map(list => list.map(p => p !== null && p >= settings.flaggedSpan)) : null;
    const anyFlagged = flagged && flagged.some(list => list.some(Boolean));
    if (!anyFlagged) {
      const answer = await callRewriter(joinSegments(current));
      const parts = splitReturned(answer, current.length);
      return parts ? { texts: parts, scope: 'chunk' } : { texts: null, scope: 'chunk', reason: `the rewriter did not return ${current.length} paragraphs` };
    }
    const texts = [];
    let spans = 0;
    for (let k = 0; k < current.length; k += 1) {
      const sentences = splitSentences(current[k]);
      const marks = flagged[k] && flagged[k].length === sentences.length ? flagged[k].slice() : sentences.map(() => false);
      if (!marks.some(Boolean)) { texts.push(current[k]); continue; }
      /* contiguous flagged runs, each widened with its neighbours until it holds minWords */
      const runs = [];
      for (let i = 0; i < marks.length; i += 1) {
        if (!marks[i]) continue;
        let j = i;
        while (j + 1 < marks.length && marks[j + 1]) j += 1;
        runs.push([i, j]);
        i = j;
      }
      for (const r of runs) {
        while (words(sentences.slice(r[0], r[1] + 1).map(s => s.text)) < minWords && (r[0] > 0 || r[1] < sentences.length - 1)) {
          if (r[0] > 0) r[0] -= 1;
          if (words(sentences.slice(r[0], r[1] + 1).map(s => s.text)) < minWords && r[1] < sentences.length - 1) r[1] += 1;
        }
      }
      const merged = [];
      for (const r of runs) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
        else merged.push(r.slice());
      }
      const pieces = [];
      let at = 0;
      for (const [i, j] of merged) {
        if (i > at) pieces.push(sentences.slice(at, i).map(s => s.text).join(' '));
        const answer = await callRewriter(sentences.slice(i, j + 1).map(s => s.text).join(' '));
        spans += 1;
        pieces.push(answer.replace(/\s*\n\s*/g, ' ').trim());
        at = j + 1;
      }
      if (at < sentences.length) pieces.push(sentences.slice(at).map(s => s.text).join(' '));
      texts.push(pieces.join(' '));
    }
    return { texts, scope: `${spans} flagged span${spans === 1 ? '' : 's'}` };
  }

  /* Repair every segment of a chunk's rewrite. A rejected segment keeps its previous text; when none changed, nothing is scanned. */
  function repairChunk(c, draft) {
    const record = { round: run.round, pass: run.pass, kind: 'rewrite', scope: draft.scope, gate: 'rejected', reasons: [], splices: 0, fixes: 0, notes: [], human: null, flagged: null };
    if (!draft.texts) { record.reasons.push(draft.reason); return { c, record, texts: null, notes: [] }; }
    const texts = [];
    let changed = false;
    let notes = [];
    c.segmentIds.forEach((id, k) => {
      const r = repairSegment(seg[id].source, draft.texts[k], { map, prefix, maxLengthDrift: settings.maxLengthDrift, watch: c.watch });
      record.splices += r.splices.length;
      record.fixes += r.fixes.length;
      if (!r.ok) { record.reasons.push(r.reason); texts.push(seg[id].best); return; }
      notes = notes.concat(r.notes);
      if (normalizeSpace(r.text) !== normalizeSpace(seg[id].best)) changed = true;
      texts.push(r.text);
    });
    record.notes = [...new Set(notes.map(n => n.code))];
    if (!changed) { if (!record.reasons.length) record.reasons.push('the repaired rewrite is the same as the text it replaces'); return { c, record, texts: null, notes }; }
    record.gate = record.splices || record.fixes ? 'repaired' : 'ok';
    return { c, record, texts, notes };
  }

  function adopt(c, texts, scan, record, notes) {
    const readings = sentenceReadings(texts, map, prefix, scan.sentences);
    record.human = round3(scan.human);
    record.flagged = readings.flat().filter(p => p !== null && p >= settings.flaggedSpan).length;
    if (c.best.human === null || scan.human > c.best.human) {
      c.segmentIds.forEach((id, k) => { seg[id].best = texts[k]; });
      c.best = { human: scan.human, round: run.round, pass: run.pass, notes };
      c.readings = readings;
    }
    if (scan.human >= c.bar) c.status = 'passed';
  }

  function aggregate() {
    let total = 0;
    let weight = 0;
    for (const c of chunks) {
      const w = chunkWords(c);
      total += w * (c.best.human === null ? 0 : c.best.human);
      weight += w;
    }
    return weight ? total / weight : 1;
  }

  function resplice() {
    const next = [];
    let made = 0;
    for (const c of chunks) {
      if (c.status !== 'exhausted') { next.push(c); continue; }
      if (c.segmentIds.length > 1) {
        c.segmentIds.forEach((id, k) => {
          made += 1;
          next.push({ ...c, id: `${c.id}.${k + 1}`, parent: c.id, segmentIds: [id], status: 'working', fresh: false, passes: [], readings: c.readings ? [c.readings[k]] : null, best: { ...c.best } });
        });
        log(`Chunk ${c.id} respliced into ${c.segmentIds.length} chunks, one per paragraph or bullet.`, { chunk: c.id });
      } else {
        made += 1;
        next.push({ ...c, status: 'working', fresh: true, fromSource: true, readings: null });
        log(`Chunk ${c.id} goes back to the rewriter from its source.`, { chunk: c.id });
      }
    }
    chunks = next;
    return made;
  }

  try {
    if (!rewriter || typeof rewriter.rewrite !== 'function') throw new HumanizeError('No rewriter was given.', 'config');
    if (!detector || typeof detector.scan !== 'function') throw new HumanizeError('No detector was given.', 'config');
    if (!source.trim()) throw new HumanizeError('There is no text to humanize.', 'input');
    if (source.length > LIMITS.maxTextChars) throw new HumanizeError(`The text is longer than ${LIMITS.maxTextChars} characters.`, 'input');

    /* the secretary */
    brief = writeBrief(source);
    prefix = choosePrefix(source);
    const doc = segment(source, settings);
    segments = doc.segments;
    const rewritable = segments.filter(s => s.kind !== 'fixed');
    const masked = maskSegments(rewritable.map(s => s.text), brief.tokens, { prefix });
    map = masked.map;
    rewritable.forEach((s, i) => { seg[s.id] = { source: masked.masked[i], best: masked.masked[i] }; });
    const watch = brief.terms.filter(t => t.kind === 'watch').map(t => t.text);
    chunks = doc.chunks.map(c => ({ ...c, status: 'working', fresh: true, readings: null, passes: [], watch, best: { human: null, round: 0, pass: 0, notes: [] } }));
    log(`Secretary: ${brief.facts.length} figure(s), ${brief.terms.length} locked or watched term(s), ${brief.bindings.length} binding(s); ${chunks.length} chunk(s) (${chunks.filter(c => c.kind === 'prose').length} prose, ${chunks.filter(c => c.kind === 'other').length} other).`);
    update();
    if (!chunks.length) {
      run.status = 'passed';
      log('Nothing in the text is prose or a rewritable line; the final text is the source.');
      return finish();
    }

    for (const provider of [rewriter, detector]) if (typeof provider.preflight === 'function') { checkAbort(); await provider.preflight({ signal }); }

    if (settings.baselineScan) {
      run.stage = 'signoff';
      update();
      const scans = await runPool(chunks, settings.workers.scan, c => {
        const plain = joinSegments(c.segmentIds.map(id => unmask(seg[id].source, map, prefix)));
        return callDetector(plain).then(r => { c.seen = new Map([[normalizeSpace(plain), r]]); return r; });
      }, { signal });
      chunks.forEach((c, i) => {
        const record = { round: 0, pass: 0, kind: 'baseline', scope: 'source', gate: '-', reasons: [], splices: 0, fixes: 0, notes: [], human: null, flagged: null };
        adopt(c, c.segmentIds.map(id => seg[id].source), scans[i], record, []);
        c.fresh = c.readings ? !c.readings.flat().some(p => p !== null && p >= settings.flaggedSpan) : true;
        c.passes.push(record);
        if (c.status === 'passed') log(`Chunk ${c.id} already reads ${Math.round(scans[i].human * 100)}% human (bar ${Math.round(c.bar * 100)}%): deposited as written.`, { chunk: c.id });
      });
      update();
    }

    for (run.round = 1; run.round <= settings.maxRounds; run.round += 1) {
      for (run.pass = 1; run.pass <= settings.maxPasses; run.pass += 1) {
        const due = chunks.filter(c => c.status === 'working');
        if (!due.length) break;
        run.stage = 'rewrite';
        update();
        const drafts = await runPool(due, settings.workers.rewrite, c => rewriteChunk(c), { signal });
        run.stage = 'repair';
        const gated = due.map((c, i) => repairChunk(c, drafts[i]));
        update();
        run.stage = 'signoff';
        const toScan = gated.filter(g => g.texts);
        /* a text this chunk already had scanned is not scanned again: the earlier reading stands */
        const scans = await runPool(toScan, settings.workers.scan, g => {
          const plain = joinSegments(g.texts.map(t => unmask(t, map, prefix)));
          const key = normalizeSpace(plain);
          g.c.seen = g.c.seen || new Map();
          if (g.c.seen.has(key)) { g.record.cached = true; return g.c.seen.get(key); }
          return callDetector(plain).then(r => { g.c.seen.set(key, r); return r; });
        }, { signal });
        toScan.forEach((g, i) => adopt(g.c, g.texts, scans[i], g.record, g.notes));
        for (const g of gated) {
          g.c.passes.push(g.record);
          g.c.fresh = false;
          g.c.fromSource = false;
          if (g.c.status === 'passed') log(`Chunk ${g.c.id} signed off at ${Math.round(g.record.human * 100)}% human (bar ${Math.round(g.c.bar * 100)}%) and deposited.`, { chunk: g.c.id });
          else if (g.record.gate === 'rejected') log(`Chunk ${g.c.id}: the repair gate rejected the rewrite (${g.record.reasons.join('; ')}).`, { chunk: g.c.id });
          if (g.c.status === 'working' && run.pass === settings.maxPasses) g.c.status = 'exhausted';
        }
        update();
      }
      for (const c of chunks) if (c.status === 'working') c.status = 'exhausted';
      run.pass = 0;
      const human = aggregate();
      run.aggregate.human = round3(human);
      run.aggregate.history.push({ round: run.round, human: round3(human) });
      run.aggregate.met = human >= settings.bars.aggregate;
      log(`Round ${run.round}: aggregate ${Math.round(human * 1000) / 10}% human (bar ${Math.round(settings.bars.aggregate * 100)}%).`);
      if (run.aggregate.met) { run.status = 'passed'; break; }
      if (run.round === settings.maxRounds) { run.status = 'below-bar'; break; }
      const history = run.aggregate.history;
      const base = history.length > settings.stallRounds ? history[history.length - 1 - settings.stallRounds].human : null;
      if (base !== null && history[history.length - 1].human - base < 0.005) {
        run.status = 'stalled';
        log(`No gain in ${settings.stallRounds} round(s): stopped. The chunks still below their bar need a person to say what may move.`);
        break;
      }
      if (!resplice()) { run.status = 'below-bar'; break; }
      run.pass = 0;
      update();
    }
    if (run.status === 'running') run.status = run.aggregate.met ? 'passed' : 'below-bar';
  } catch (error) {
    run.status = error instanceof AbortedError ? 'cancelled' : error && error.code === 'needs-sign-in' ? 'needs-sign-in' : error instanceof BudgetError ? 'budget' : 'failed';
    run.error = String(error && error.message ? error.message : error);
    log(run.error);
    if (chunks.length && segments.length) {
      const human = aggregate();
      run.aggregate.human = round3(human);
      run.aggregate.met = human >= settings.bars.aggregate;
    }
  }
  return finish();

  function finish() {
    run.stage = 'done';
    run.endedAt = now();
    for (const c of chunks) if (c.status === 'working') c.status = 'exhausted';
    const result = view();
    try { onUpdate(result); } catch { /* ignored */ }
    return result;
  }
}

module.exports = { runHumanize, settingsOf, sentenceReadings, HumanizeError, BudgetError };
