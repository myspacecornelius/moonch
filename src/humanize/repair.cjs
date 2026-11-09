'use strict';
/* The repair workers: they take what the rewriter returned for one segment, hold it to the frozen source and the secretary's brief, put
   back what slipped, and either hand on a text that may be scanned or reject the pass. They work on MASKED text, where every figure and
   every locked term is a key that names one place in the source.

   repairSegment(source, candidate, ctx) -> { ok, text, splices, fixes, notes, reason }
     source, candidate: masked texts of the same segment. ctx: { map, prefix, maxLengthDrift, watch: [phrase], maxIterations }.
     ok false: the pass is rejected (reason says why); the chunk keeps its previous text and the text is never scanned.
     ok true:  text is the candidate, possibly with whole source sentences spliced back in (splices: [{ source, replaced }]); fixes are
               mechanical corrections made without a splice (a locked term retyped in another letter case); notes need a human read.

   What is checked (each failure names the source sentence it belongs to, and that sentence is spliced back in):
     inventory   every key of the segment exactly once; no key of another segment; no unknown key; no digit outside a key
     basis       the word after a figure, and the symbol before it, still give it the basis it had: currency stays currency, a percent a
                 percent, a multiple a multiple, basis points basis points; no magnitude (million, bn) or unit added to a figure
     binding     per clause of the source that carries a figure: its figures stay in one sentence, the subject they describe is still in that
                 sentence, the clause is still negated (or still not), its verb does not now point the other way, and two figures that
                 described two subjects are still each nearest their own subject (a swap)
     voice       no first person where the source had none
     logic       in sentences without figures: with the same number of sentences, sentence i keeps the negation of source sentence i;
                 otherwise a changed count of negations is a note
     length      the repaired segment is within maxLengthDrift of the source in words (a rejection, never a splice)
   CLEAN here means the inventory, the bases and the bindings held. It is not a meaning check: a sentence can say something else with
   every figure in place. The run's notes say which chunks a person should still read. */

const { splitSentences, tokens, wordCount, stem } = require('./text.cjs');
const { bindClauses, isNegation } = require('./secretary.cjs');
const { keyRe, normalizeKeys } = require('./mask.cjs');
const { LIMITS } = require('./constants.cjs');

const FIRST_PERSON_RE = /\b(?:we|our|ours|us|i|me|my|mine|myself|ourselves)\b/gi;
const PERCENT_WORDS = new Set(['percent', '%', 'pp', 'ppt', 'percentage', 'per']);
const MULT_WORDS = new Set(['x', 'times', '×', 'fold']);
const BPS_WORDS = new Set(['bps', 'bp', 'basis']);
const CUR_WORDS = new Set(['dollars', 'dollar', 'usd', 'eur', 'gbp', 'euros', 'euro', 'pounds', 'pound']);
const MAG_WORDS = new Set(['million', 'billion', 'thousand', 'trillion', 'm', 'mm', 'mn', 'bn', 'k', 'tn']);
const CURRENCY_BEFORE_RE = /[$€£¥₹]\s?$/;

function firstPerson(text) {
  const hits = String(text).match(FIRST_PERSON_RE) || [];
  return hits.filter(h => h !== 'US').length;
}

function spansOf(text, map, prefix) {
  const re = keyRe(prefix);
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    const entry = map[m[0]];
    if (entry) out.push({ start: m.index, end: m.index + m[0].length, key: m[0], role: entry.role, text: entry.text, basis: entry.basis });
  }
  return out;
}

function sentencesOf(text, map, prefix) {
  return splitSentences(text).map(s => {
    const spans = spansOf(s.text, map, prefix);
    return { text: s.text, spans, keys: new Set(spans.map(x => x.key)) };
  });
}

const negated = text => tokens(text).some(t => isNegation(t.lw));

/* The unit word after a key, and the character before it, in lower case. */
function contextOf(text, start, end) {
  const after = /^\s*([a-z%×]+)/i.exec(text.slice(end, end + 30));
  return { next: after ? after[1].toLowerCase() : '', currencyBefore: CURRENCY_BEFORE_RE.test(text.slice(Math.max(0, start - 2), start)) };
}

function basisSlip(basis, ctx, sourceCtx, entryText) {
  const changed = ctx.next !== sourceCtx.next;
  const unitAdded = set => changed && set.has(ctx.next);
  const currencyAdded = ctx.currencyBefore && !sourceCtx.currencyBefore;
  const hasMagnitude = /\d\s?(?:k|mm|mn|m|bn|b|tn|t|thousand|million|billion|trillion)\b/i.test(entryText);
  switch (basis) {
    case 'currency': return unitAdded(PERCENT_WORDS) || unitAdded(MULT_WORDS) || unitAdded(BPS_WORDS) || currencyAdded || (!hasMagnitude && unitAdded(MAG_WORDS));
    case 'percent': return unitAdded(PERCENT_WORDS) || unitAdded(MULT_WORDS) || unitAdded(BPS_WORDS) || unitAdded(CUR_WORDS) || currencyAdded;
    case 'bps': return unitAdded(PERCENT_WORDS) || unitAdded(MULT_WORDS) || unitAdded(CUR_WORDS) || unitAdded(BPS_WORDS) || currencyAdded;
    case 'multiple': return unitAdded(PERCENT_WORDS) || unitAdded(BPS_WORDS) || unitAdded(CUR_WORDS) || unitAdded(MULT_WORDS) || currencyAdded;
    case 'number': return unitAdded(PERCENT_WORDS) || unitAdded(MULT_WORDS) || unitAdded(BPS_WORDS) || unitAdded(CUR_WORDS) || currencyAdded || (!hasMagnitude && unitAdded(MAG_WORDS));
    default: return currencyAdded;
  }
}

/* Where a binding's head occurs in a sentence: offsets. */
function headPositions(sentence, head) {
  if (!head) return [];
  if (head.startsWith('term:')) {
    const key = head.slice(5);
    return sentence.spans.filter(s => s.key === key).map(s => s.start);
  }
  const want = head.slice(5);
  return tokens(sentence.text, sentence.spans).filter(t => !t.span && stem(t.lw) === want).map(t => t.start);
}

/* One read of a candidate against its source. Returns { fatal, fails: [{ code, src: [i], cand: [j] }], notes }. */
function check(srcS, candText, ctx) {
  const { map, prefix } = ctx;
  const fails = [];
  const notes = [];
  const candS = sentencesOf(candText, map, prefix);
  const owner = new Map();
  srcS.forEach((s, i) => s.keys.forEach(k => owner.set(k, i)));

  const allKeys = [...candText.matchAll(keyRe(prefix))].map(m => m[0]);
  const unknown = allKeys.filter(k => !map[k]);
  if (unknown.length) return { fatal: `the rewriter returned placeholders that were never sent (${[...new Set(unknown)].join(', ')})`, fails, notes, candS };
  const foreign = allKeys.filter(k => map[k] && !owner.has(k));
  if (foreign.length) return { fatal: `a figure or term moved here from another paragraph or bullet (${[...new Set(foreign)].map(k => map[k].text).join(', ')})`, fails, notes, candS };

  const counts = new Map();
  for (const k of allKeys) counts.set(k, (counts.get(k) || 0) + 1);
  for (const [k, i] of owner) {
    const n = counts.get(k) || 0;
    if (n === 0) fails.push({ code: 'dropped', what: map[k].text, src: [i], cand: [] });
    else if (n > 1) fails.push({ code: 'duplicated', what: map[k].text, src: [i], cand: candS.map((c, j) => (c.keys.has(k) ? j : -1)).filter(j => j >= 0) });
  }

  let invented = null;
  candS.forEach((c, j) => {
    if (!/\d/.test(c.text.replace(keyRe(prefix), ' '))) return;
    if (c.keys.size) fails.push({ code: 'invented', what: 'a number that is not in the source', src: [], cand: [j] });
    else if (candS.length === srcS.length) fails.push({ code: 'invented', what: 'a number that is not in the source', src: [j], cand: [j] });
    else invented = 'the rewriter added a number that is not in the source, in a sentence that cannot be matched to one';
  });
  if (invented) return { fatal: invented, fails, notes, candS };

  const where = new Map();
  candS.forEach((c, j) => c.keys.forEach(k => { if (!where.has(k)) where.set(k, j); }));

  /* basis: compared with the same key's context in the source */
  for (const c of candS) {
    for (const span of c.spans) {
      if (span.role !== 'fact') continue;
      const i = owner.get(span.key);
      const s = srcS[i];
      const srcSpan = s.spans.find(x => x.key === span.key);
      if (!srcSpan) continue;
      if (basisSlip(span.basis, contextOf(c.text, span.start, span.end), contextOf(s.text, srcSpan.start, srcSpan.end), span.text)) {
        fails.push({ code: 'basis', what: `${span.text} (${span.basis})`, src: [i], cand: [where.get(span.key)] });
      }
    }
  }

  /* bindings */
  srcS.forEach((s, i) => {
    const bindings = bindClauses(s.text, s.spans);
    const heads = bindings.filter(b => b.head);
    for (const b of bindings) {
      const at = b.facts.map(k => where.get(k));
      if (at.some(j => j === undefined)) continue; /* a dropped key is already a failure */
      if (new Set(at).size > 1) { fails.push({ code: 'split', what: b.facts.map(k => map[k].text).join(' / '), src: [i], cand: at }); continue; }
      const c = candS[at[0]];
      if (b.head && !headPositions(c, b.head).length) { fails.push({ code: 'subject', what: `${b.subject} -> ${b.facts.map(k => map[k].text).join(', ')}`, src: [i], cand: [at[0]] }); continue; }
      const cb = bindClauses(c.text, c.spans).find(x => x.facts.includes(b.facts[0]));
      if (cb && cb.negated !== b.negated) { fails.push({ code: 'negation', what: b.clause, src: [i], cand: [at[0]] }); continue; }
      if (cb && b.direction && cb.direction && cb.direction !== b.direction) { fails.push({ code: 'direction', what: `${b.subject} ${b.direction} -> ${cb.direction}`, src: [i], cand: [at[0]] }); continue; }
      /* a swap: within the candidate sentence, the nearest subject before each figure must be its own */
      const rivals = heads.filter(h => h !== b && h.head !== b.head && h.facts.every(k => where.get(k) === at[0]));
      if (b.head && rivals.length) {
        const factPos = c.spans.find(x => x.key === b.facts[0]).start;
        const candidates = [b, ...rivals].flatMap(h => headPositions(c, h.head).filter(p => p < factPos).map(p => ({ h, p })));
        const nearest = candidates.sort((x, y) => y.p - x.p)[0];
        if (nearest && nearest.h !== b) fails.push({ code: 'swap', what: `${b.subject} / ${nearest.h.subject}`, src: [i], cand: [at[0]] });
      }
    }
  });

  /* voice: first person where the source had none */
  const srcFirst = srcS.reduce((n, s) => n + firstPerson(s.text), 0);
  if (!srcFirst) {
    candS.forEach((c, j) => {
      if (!firstPerson(c.text)) return;
      if (c.keys.size) fails.push({ code: 'first-person', what: c.text.slice(0, 60), src: [], cand: [j] });
      else if (candS.length === srcS.length) fails.push({ code: 'first-person', what: c.text.slice(0, 60), src: [j], cand: [j] });
      else notes.push({ code: 'first-person', text: 'First person appears where the source has none; read before shipping.' });
    });
  }

  /* logic, in sentences without figures */
  if (candS.length === srcS.length) {
    srcS.forEach((s, i) => {
      if (s.keys.size || candS[i].keys.size) return;
      if (negated(s.text) !== negated(candS[i].text)) fails.push({ code: 'negation', what: s.text.slice(0, 60), src: [i], cand: [i] });
    });
  } else {
    const n = list => list.reduce((acc, s) => acc + tokens(s.text).filter(t => isNegation(t.lw)).length, 0);
    if (n(srcS) !== n(candS)) notes.push({ code: 'negation-count', text: `The source has ${n(srcS)} negation(s) and the rewrite ${n(candS)}; read the logic before shipping.` });
  }

  /* watched terminology */
  for (const phrase of ctx.watch || []) {
    const count = list => list.reduce((acc, s) => acc + (s.text.toLowerCase().split(phrase.toLowerCase()).length - 1), 0);
    const before = count(srcS);
    const after = count(candS);
    if (after < before) notes.push({ code: 'terminology', text: `"${phrase}" appears ${after} time(s) where the source has ${before}; check the rewrite kept the term.` });
  }
  return { fatal: null, fails, notes, candS };
}

/* Replace the candidate sentences that hold any key of the failing source sentences (and, transitively, the source sentences whose keys
   those candidate sentences hold) with the source sentences, in source order, where the first of them stood. */
function splice(srcS, candS, badSrc, badCand) {
  const owner = new Map();
  srcS.forEach((s, i) => s.keys.forEach(k => owner.set(k, i)));
  const S = new Set(badSrc);
  const R = new Set(badCand);
  /* With as many sentences on both sides, sentence j of the rewrite stands for sentence j of the source: a candidate sentence that goes
     brings its partner back, so nothing it said without a key is lost. */
  const paired = srcS.length === candS.length;
  let changed = true;
  while (changed) {
    changed = false;
    candS.forEach((c, j) => {
      if (!R.has(j) && [...c.keys].some(k => S.has(owner.get(k)))) { R.add(j); changed = true; }
    });
    for (const j of R) {
      for (const k of candS[j].keys) {
        const i = owner.get(k);
        if (i !== undefined && !S.has(i)) { S.add(i); changed = true; }
      }
      if (paired && !S.has(j)) { S.add(j); changed = true; }
    }
    if (paired) for (const i of S) if (!R.has(i)) { R.add(i); changed = true; }
  }
  const back = [...S].sort((a, b) => a - b).map(i => srcS[i].text);
  let out;
  if (R.size) {
    const first = Math.min(...R);
    out = candS.flatMap((c, j) => (j === first ? back : R.has(j) ? [] : [c.text]));
  } else {
    /* every key of those source sentences was dropped: put them back after the candidate sentence that holds the latest key of an
       earlier source sentence, or first */
    const minS = Math.min(...S);
    let at = -1;
    for (let i = minS - 1; i >= 0 && at < 0; i -= 1) {
      for (const k of srcS[i].keys) {
        const j = candS.findIndex(c => c.keys.has(k));
        if (j > at) at = j;
      }
    }
    const texts = candS.map(c => c.text);
    out = [...texts.slice(0, at + 1), ...back, ...texts.slice(at + 1)];
  }
  return {
    text: out.join(' '),
    replaced: [...R].sort((a, b) => a - b).map(j => candS[j].text),
    restored: back,
  };
}

/* A locked term the rewriter typed out itself in another letter case is written back the locked way. */
function fixTermCase(text, map, prefix) {
  const fixes = [];
  let out = text;
  const terms = [...new Set(Object.values(map).filter(e => e.role === 'term' && e.kind !== 'quote' && /\p{L}/u.test(e.text)).map(e => e.text))];
  for (const term of terms.sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(?<![\\w])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'gi');
    out = out.replace(re, found => {
      if (found === term) return found;
      fixes.push({ code: 'term-case', from: found, to: term });
      return term;
    });
  }
  return { text: out, fixes, prefix };
}

function repairSegment(source, candidate, ctx) {
  const maxIterations = ctx.maxIterations || LIMITS.maxSpliceIterations;
  const maxDrift = Number.isFinite(ctx.maxLengthDrift) ? ctx.maxLengthDrift : LIMITS.maxLengthDrift;
  const srcS = sentencesOf(source, ctx.map, ctx.prefix);
  const keyed = normalizeKeys(String(candidate == null ? '' : candidate), ctx.map, ctx.prefix);
  const cased = fixTermCase(keyed.replace(/\s*\n\s*/g, ' ').trim(), ctx.map, ctx.prefix);
  let text = cased.text;
  const splices = [];
  let notes = [];
  for (let iteration = 0; iteration <= maxIterations; iteration += 1) {
    const result = check(srcS, text, ctx);
    if (result.fatal) return { ok: false, text, splices, fixes: cased.fixes, notes, reason: result.fatal };
    notes = result.notes;
    if (!result.fails.length) {
      const sw = wordCount(source);
      const drift = sw ? Math.abs(wordCount(text) - sw) / sw : 0;
      if (drift > maxDrift) return { ok: false, text, splices, fixes: cased.fixes, notes, reason: `the rewrite is ${Math.round(drift * 100)}% longer or shorter than the source (at most ${Math.round(maxDrift * 100)}%)` };
      return { ok: true, text, splices, fixes: cased.fixes, notes, reason: null };
    }
    if (iteration === maxIterations) break;
    const badSrc = new Set(result.fails.flatMap(f => f.src));
    const badCand = new Set(result.fails.flatMap(f => f.cand));
    const done = splice(srcS, result.candS, badSrc, badCand);
    splices.push({ codes: [...new Set(result.fails.map(f => f.code))], what: result.fails.map(f => f.what).slice(0, 6), replaced: done.replaced, restored: done.restored });
    text = done.text;
  }
  return { ok: false, text, splices, fixes: cased.fixes, notes, reason: 'the slips could not be repaired by splicing source sentences back in' };
}

module.exports = { repairSegment, check, splice, sentencesOf, spansOf, firstPerson, basisSlip, fixTermCase };
