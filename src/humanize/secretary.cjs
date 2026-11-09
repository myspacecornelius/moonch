'use strict';
/* The secretary: one worker that reads the frozen source before anything is rewritten and writes the brief every later worker is held to.

   brief(text) -> {
     facts:    [{ text, basis, count }]       every figure, with its basis: currency, percent, bps, multiple, ratio, date, period, year,
                                              number. "$4.1m" stays currency, "2.3x" stays a multiple, "150 bps" stays basis points.
     terms:    [{ text, kind, count }]        the terminology lock: defined terms ("the Company"), acronyms (EBITDA), proper names and
                                              capitalised phrases (Senior Secured Notes), quoted phrases and file names. They are masked
                                              like figures, so the rewriter cannot change them. kind "watch": a repeated lower-case
                                              finance phrase ("operating margin") that is not masked; the gate counts it.
     bindings: [{ sentence, subject, head, verb, direction, negated, facts }]
                                              the noun-verb map: for each clause that carries a figure, the subject it describes, the verb
                                              it hangs on, whether that verb points up or down, and whether the clause is negated.
     tokens:   [{ text, role, basis|kind }]   the mask list, longest first (facts and the masked terms).
   }
   findFacts(text) and findTerms(text, facts) give the spans the brief is built from. bindClauses(text, spans) is the binding read the
   repair worker runs again on masked text, where the spans are placeholders. Nothing here calls a network or a model. */

const { splitSentences, tokens, stem, parseUnits, REWRITABLE_UNITS } = require('./text.cjs');

/* The sentences of the rewritable blocks, with offsets in the whole text. A heading or a bullet never runs into the next block. */
function sentencesOf(source, units = parseUnits(source)) {
  const out = [];
  for (const unit of units) {
    if (!REWRITABLE_UNITS.has(unit.type)) continue;
    for (const s of splitSentences(source.slice(unit.start, unit.end))) out.push({ text: s.text, start: unit.start + s.start, end: unit.start + s.end });
  }
  return out;
}

/* ------------------------------------------------------------------ figures */

const NUM = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?';
const MAG = '(?:(?:k|mm|mn|m|bn|b|tn|t)(?![\\w])|\\s(?:thousand|million|billion|trillion|mn|mm|bn)\\b)';
const CUR_PRE = '(?:US\\$|C\\$|A\\$|NZ\\$|HK\\$|S\\$|R\\$|\\$|\u20ac|\u00a3|\u00a5|\u20b9|(?:USD|EUR|GBP|JPY|CHF|CAD|AUD|CNY|INR)\\s?)';
const CUR_POST = '\\s?(?:USD|EUR|GBP|JPY|CHF|CAD|AUD|dollars|euros|pounds)\\b';
const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const DASH = '\\s?(?:-|\u2013|\u2014|to)\\s?';
const LEFT = '(?<![\\w.$\u20ac\u00a3\u00a5])';
const SIGN = '[-\u2212+]?';

/* In priority order: when two patterns match the same length at the same place, the earlier one names the basis. */
const FACT_PATTERNS = [
  ['date', `\\b\\d{4}-\\d{2}-\\d{2}\\b`],
  ['date', `\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`],
  ['date', `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH},?\\s+\\d{4}\\b`],
  ['date', `\\b${MONTH}\\s+\\d{4}\\b`],
  ['date', `\\b\\d{1,2}/\\d{1,2}/\\d{2,4}\\b`],
  ['period', `\\b(?:Q[1-4]|[12]H|H[12])\\s?(?:FY)?['\u2019]?\\d{2,4}\\b`],
  ['period', `\\bFY\\s?['\u2019]?\\d{2,4}\\b`],
  ['period', `\\b(?:Q[1-4]|[12]H|H[12])\\b`],
  ['currency', `${LEFT}${CUR_PRE}${NUM}${MAG}?${DASH}${CUR_PRE}?${NUM}${MAG}?`],
  ['currency', `${LEFT}\\(\\s?${SIGN}${CUR_PRE}${NUM}${MAG}?\\s?\\)`],
  ['currency', `${LEFT}${SIGN}${CUR_PRE}${SIGN}${NUM}${MAG}?`],
  ['currency', `${LEFT}${SIGN}${NUM}${MAG}?${CUR_POST}`],
  ['percent', `${LEFT}${SIGN}${NUM}%?${DASH}${SIGN}${NUM}\\s?(?:%|percent\\b|per cent\\b)`],
  ['percent', `${LEFT}${SIGN}${NUM}\\s?(?:%|percent\\b|per cent\\b|ppts?\\b|pp\\b|percentage points?\\b)`],
  ['bps', `${LEFT}${SIGN}${NUM}\\s?(?:bps|bp|basis points?)\\b`],
  ['multiple', `${LEFT}${NUM}x?${DASH}${NUM}\\s?(?:x|\u00d7)(?![\\w])`],
  ['multiple', `${LEFT}${NUM}\\s?(?:x|\u00d7)(?![\\w])`],
  ['multiple', `${LEFT}${NUM}\\s?times\\b`],
  ['ratio', `${LEFT}\\d+(?:\\.\\d+)?:\\d+(?:\\.\\d+)?(?![\\w])`],
  ['year', `\\b(?:19|20)\\d{2}s?\\b`],
  ['number', `${LEFT}${SIGN}${NUM}${MAG}`],
  ['number', `${LEFT}${SIGN}${NUM}(?:st|nd|rd|th)?(?![\\w])`],
];
const FACT_RES = FACT_PATTERNS.map(([basis, source]) => ({ basis, re: new RegExp(source, 'g') }));

/* Spans: [{ start, end, text, basis }], left to right, no overlaps; the longest match wins, then the earlier pattern. */
function findFacts(text) {
  const source = String(text == null ? '' : text);
  const hits = [];
  FACT_RES.forEach(({ basis, re }, priority) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) {
      let value = m[0];
      /* a trailing sentence period is not part of a figure ("rose 12."), a decimal point inside it is */
      while (/[.,]$/.test(value)) value = value.slice(0, -1);
      if (!value || !/\d/.test(value)) continue;
      hits.push({ start: m.index, end: m.index + value.length, text: value, basis, priority });
    }
  });
  return pickSpans(hits);
}

function pickSpans(hits) {
  hits.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.priority - b.priority || a.start - b.start);
  const taken = [];
  for (const hit of hits) {
    if (taken.some(t => t.start < hit.end && hit.start < t.end)) continue;
    taken.push(hit);
  }
  return taken.sort((a, b) => a.start - b.start).map(({ priority, ...rest }) => rest);
}

/* ------------------------------------------------------------------ terms */

const FUNCTION_WORDS = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'our', 'its', 'their', 'his', 'her', 'in', 'on', 'at', 'by', 'for',
  'as', 'if', 'when', 'while', 'after', 'before', 'since', 'with', 'from', 'to', 'and', 'but', 'or', 'so', 'yet', 'of', 'per', 'into', 'over',
  'under', 'than', 'then', 'there', 'here', 'it', 'we', 'they', 'he', 'she', 'i', 'you', 'all', 'each', 'every', 'both', 'some', 'any', 'no',
  'not', 'also', 'however', 'although', 'though', 'because', 'during', 'between', 'through', 'about', 'above', 'below', 'up', 'down', 'out']);
const CONNECTORS = new Set(['of', 'and', '&', 'for', 'de', 'du', 'la', 'von', 'van', 'der', 'del', 'on', 'in']);
const SHOUT = new Set(['NOT', 'AND', 'OR', 'THE', 'NOTE', 'NB', 'TBD', 'OK', 'NA', 'N/A']);
const DAYS = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
const FIN_HEADS = new Set(['margin', 'margins', 'revenue', 'revenues', 'income', 'cash', 'flow', 'flows', 'debt', 'leverage', 'ratio', 'coverage',
  'covenant', 'covenants', 'capex', 'expense', 'expenses', 'cost', 'costs', 'sales', 'profit', 'earnings', 'yield', 'spread', 'rate', 'return',
  'returns', 'valuation', 'multiple', 'equity', 'liquidity', 'guidance', 'backlog', 'bookings', 'churn', 'retention', 'interest', 'principal',
  'maturity', 'tranche', 'facility', 'notes', 'loan', 'loans', 'headroom', 'basis', 'base', 'capital', 'dividend', 'dividends', 'growth']);

const FILE_RE = /\b[\w-]+\.(?:xlsx|xlsm|xls|docx|doc|pdf|csv|pptx|txt|md|json|zip)\b/gi;
const DEFINED_RE = /\(\s*(?:the\s+|each,?\s+an?\s+|an?\s+)?["\u201c]([^"\u201d\n]{2,60})["\u201d]\s*\)|hereinafter\s+(?:the\s+)?["\u201c]([^"\u201d\n]{2,60})["\u201d]/gi;
const QUOTE_RE = /["\u201c][^"\u201d\n]{3,160}["\u201d]/g;
const ACRONYM_RE = /\b[A-Z][A-Z0-9&]{1,}(?:[-/][A-Z0-9]+)*s?\b/g;

/* Spans of the terms to lock, given the fact spans (a term never covers a figure, a figure is never split by a term). */
function findTerms(text, facts = findFacts(text)) {
  const source = String(text == null ? '' : text);
  const hits = [];
  const add = (start, end, kind, priority) => {
    const value = source.slice(start, end);
    if (!value.trim()) return;
    hits.push({ start, end, text: value, kind, priority });
  };
  let m;
  FILE_RE.lastIndex = 0;
  while ((m = FILE_RE.exec(source))) add(m.index, m.index + m[0].length, 'file', 0);
  QUOTE_RE.lastIndex = 0;
  while ((m = QUOTE_RE.exec(source))) if (m[0].split(/\s+/).length <= 20) add(m.index, m.index + m[0].length, 'quote', 1);
  /* a defined term is locked wherever it appears, not only inside its definition */
  const defined = new Set();
  DEFINED_RE.lastIndex = 0;
  while ((m = DEFINED_RE.exec(source))) defined.add((m[1] || m[2]).trim());
  for (const name of defined) {
    const re = new RegExp(`(?<![\\w])${escapeRe(name)}(?![\\w])`, 'g');
    while ((m = re.exec(source))) add(m.index, m.index + m[0].length, 'defined', 2);
  }
  ACRONYM_RE.lastIndex = 0;
  while ((m = ACRONYM_RE.exec(source))) if (!SHOUT.has(m[0]) && /[A-Z].*[A-Z]|[A-Z]\d/.test(m[0])) add(m.index, m.index + m[0].length, 'acronym', 3);
  for (const sentence of sentencesOf(source)) capitalised(source, sentence, add);
  const terms = pickSpans(hits).filter(t => !facts.some(f => f.start < t.end && t.start < f.end));
  return terms;
}

/* Runs of capitalised words inside one sentence. The first word of a sentence starts a term only when the run is two words or more and the
   word is not a function word; a single capitalised word counts when it is not sentence-initial (or is also capitalised mid-sentence). */
function capitalised(source, sentence, add) {
  const toks = tokens(sentence.text);
  const cap = t => /^[\p{Lu}]/u.test(t.w) && !DAYS.has(t.lw) && t.w !== 'I';
  let i = 0;
  while (i < toks.length) {
    if (!cap(toks[i])) { i += 1; continue; }
    let j = i;
    for (;;) {
      const next = toks[j + 1];
      const after = toks[j + 2];
      if (next && cap(next) && contiguous(sentence.text, toks[j], next)) { j += 1; continue; }
      if (next && after && !cap(next) && CONNECTORS.has(next.lw) && cap(after) && contiguous(sentence.text, toks[j], next) && contiguous(sentence.text, next, after)) { j += 2; continue; }
      break;
    }
    let first = i;
    while (first <= j && FUNCTION_WORDS.has(toks[first].lw)) first += 1;
    const length = j - first + 1;
    const initial = first === 0;
    if (length >= 2 || (length === 1 && !initial && toks[first].w.length >= 2)) add(sentence.start + toks[first].start, sentence.start + toks[j].end, 'proper', 4);
    i = j + 1;
  }
}

const contiguous = (text, a, b) => /^[ \t]+$/.test(text.slice(a.end, b.start));
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* Repeated lower-case finance phrases (two or three words ending in a finance head word, seen at least twice). */
function watchTerms(text) {
  const counts = new Map();
  for (const sentence of sentencesOf(String(text == null ? '' : text))) {
    const toks = tokens(sentence.text);
    for (let n = 2; n <= 3; n += 1) {
      for (let i = 0; i + n <= toks.length; i += 1) {
        const run = toks.slice(i, i + n);
        if (!run.every(t => /^[a-z][a-z-]*$/.test(t.w))) continue;
        if (FUNCTION_WORDS.has(run[0].lw) || !FIN_HEADS.has(run[n - 1].lw)) continue;
        if (run.slice(1).some(t => FUNCTION_WORDS.has(t.lw))) continue;
        const phrase = run.map(t => t.w).join(' ');
        counts.set(phrase, (counts.get(phrase) || 0) + 1);
      }
    }
  }
  const out = [...counts].filter(([, c]) => c >= 2).map(([text, count]) => ({ text, kind: 'watch', count }));
  /* "senior net leverage" seen twice makes "net leverage" redundant when it is never seen on its own */
  return out.filter(t => !out.some(o => o !== t && o.text.includes(t.text) && o.count >= t.count)).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
}

/* ------------------------------------------------------------------ the noun-verb map */

const UP = new Set(['rose', 'rise', 'rises', 'rising', 'risen', 'increase', 'increased', 'increases', 'increasing', 'grew', 'grow', 'grows', 'growing',
  'grown', 'gain', 'gained', 'gains', 'climb', 'climbed', 'climbs', 'jump', 'jumped', 'jumps', 'surge', 'surged', 'surges', 'soar', 'soared', 'expand',
  'expanded', 'expands', 'improve', 'improved', 'improves', 'up', 'higher', 'exceed', 'exceeded', 'exceeds', 'beat', 'beats', 'above', 'outperformed',
  'accelerate', 'accelerated', 'strengthened', 'boosted', 'added', 'more', 'over', 'ahead', 'upgrade', 'upgraded']);
const DOWN = new Set(['fell', 'fall', 'falls', 'fallen', 'falling', 'decrease', 'decreased', 'decreases', 'decline', 'declined', 'declines', 'declining',
  'drop', 'dropped', 'drops', 'dip', 'dipped', 'slipped', 'shrank', 'shrink', 'shrinks', 'contract', 'contracted', 'contracts', 'deteriorate',
  'deteriorated', 'down', 'lower', 'below', 'miss', 'missed', 'misses', 'underperformed', 'decelerate', 'decelerated', 'weakened', 'cut', 'cuts',
  'reduce', 'reduced', 'reduces', 'slump', 'slumped', 'plunge', 'plunged', 'tumble', 'tumbled', 'lost', 'less', 'under', 'behind', 'short',
  'downgrade', 'downgraded', 'eroded', 'compressed']);
const FLAT = new Set(['remained', 'remain', 'remains', 'stayed', 'held', 'flat', 'unchanged', 'stable', 'totaled', 'totalled', 'totals', 'total',
  'reached', 'came', 'stood', 'amounted', 'represented', 'represents', 'accounted', 'equaled', 'equalled', 'hit', 'landed', 'closed', 'ended',
  'finished', 'averaged', 'averages']);
const REPORT = new Set(['reported', 'posted', 'recorded', 'generated', 'delivered', 'produced', 'booked', 'earned', 'paid', 'raised', 'issued',
  'repaid', 'refinanced', 'borrowed', 'signed', 'acquired', 'sold', 'invested', 'spent', 'expects', 'expect', 'expected', 'forecasts', 'forecast',
  'projects', 'projected', 'guides', 'guided', 'estimates', 'estimated', 'targets', 'targeted', 'plans', 'anticipates', 'assumes', 'assumed',
  'requires', 'required', 'implies', 'implied', 'suggests', 'shows', 'showed', 'indicates', 'drove', 'offset', 'breached', 'breach', 'met',
  'meet', 'complied', 'covers', 'covered', 'returned', 'yielded', 'priced', 'valued', 'trades', 'traded', 'carries', 'carried', 'owes', 'owed']);
const BE = new Set(['is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'will', 'would', 'could', 'should', 'may', 'might',
  'must', 'can', 'did', 'does', 'do', "isn't", "wasn't", "aren't", "weren't", "hasn't", "haven't", "hadn't", "won't", "wouldn't", "didn't",
  "doesn't", "don't", "can't", "couldn't", "shouldn't"]);
const NEGATIONS = new Set(['not', 'no', 'never', 'none', 'neither', 'nor', 'without', 'cannot', 'nothing', 'nobody', 'unable', 'fails', 'failed', 'fail']);
const CLAUSE_SPLIT_RE = /;|,\s*(?=(?:while|whereas|but|although|though|and|which|with|as|compared|versus|vs\.?)\b)|\s(?=(?:while|whereas|but|although|though)\s)/gi;

const isNegation = lw => NEGATIONS.has(lw) || /n['\u2019]t$/.test(lw);
const directionOf = lw => UP.has(lw) ? 'up' : DOWN.has(lw) ? 'down' : null;
const isVerb = lw => UP.has(lw) || DOWN.has(lw) || FLAT.has(lw) || REPORT.has(lw) || BE.has(lw);

/* Clauses of one sentence: [{ start, end }] offsets inside it. */
function clauses(sentence) {
  const out = [];
  let start = 0;
  CLAUSE_SPLIT_RE.lastIndex = 0;
  let m;
  while ((m = CLAUSE_SPLIT_RE.exec(sentence))) {
    if (m.index > start) out.push({ start, end: m.index });
    start = m.index + m[0].length;
  }
  if (start < sentence.length) out.push({ start, end: sentence.length });
  return out.filter(c => /[\p{L}\p{N}]/u.test(sentence.slice(c.start, c.end)));
}

/* The binding read of one sentence. spans: [{ start, end, key, role: 'fact'|'term', text }] with offsets in `sentence`.
   Returns [{ clause, subject, head, verb, direction, negated, facts: [key] }] for each clause that holds a fact. head is the match key the
   repair worker looks for in a rewrite: a term's key, or the stem of the last content word before the verb. */
function bindClauses(sentence, spans) {
  const out = [];
  for (const c of clauses(sentence)) {
    const inside = spans.filter(s => s.start >= c.start && s.end <= c.end).map(s => ({ ...s, start: s.start - c.start, end: s.end - c.start }));
    const facts = inside.filter(s => s.role === 'fact');
    if (!facts.length) continue;
    const text = sentence.slice(c.start, c.end);
    const toks = tokens(text, inside);
    const verbAt = toks.findIndex(t => !t.span && isVerb(t.lw));
    const before = verbAt > 0 ? toks.slice(0, verbAt) : toks.slice(0, toks.findIndex(t => t.span && t.span.role === 'fact'));
    const content = before.filter(t => (t.span ? t.span.role === 'term' : !FUNCTION_WORDS.has(t.lw) && !/ly$/.test(t.lw) && !isVerb(t.lw) && /\p{L}/u.test(t.w)));
    const head = content.length ? content[content.length - 1] : null;
    const firstFact = toks.findIndex(t => t.span && t.span.role === 'fact');
    const direction = toks.map(t => (t.span ? null : directionOf(t.lw))).find(Boolean) || null;
    out.push({
      clause: text.trim(),
      subject: head ? head.w : null,
      head: head ? (head.span ? `term:${head.span.key}` : `word:${stem(head.lw)}`) : null,
      headAt: head ? head.start + c.start : null,
      verb: verbAt >= 0 ? toks[verbAt].w : null,
      direction,
      negated: toks.some(t => !t.span && isNegation(t.lw)),
      facts: facts.map(f => f.key),
      factAt: firstFact >= 0 ? toks[firstFact].start + c.start : null,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ the brief */

const MASKED_TERM_KINDS = new Set(['file', 'quote', 'defined', 'acronym', 'proper']);

function brief(text) {
  const source = String(text == null ? '' : text);
  const facts = findFacts(source);
  const terms = findTerms(source, facts);
  const watch = watchTerms(source);
  const tally = (list, keyOf) => {
    const map = new Map();
    for (const item of list) {
      const key = keyOf(item);
      const row = map.get(key) || { ...item, count: 0 };
      row.count += 1;
      map.set(key, row);
    }
    return [...map.values()];
  };
  const factRows = tally(facts, f => `${f.basis}\u0000${f.text}`).map(f => ({ text: f.text, basis: f.basis, count: f.count }));
  const termRows = tally(terms, t => t.text).map(t => ({ text: t.text, kind: t.kind, count: t.count }));
  const bindings = [];
  sentencesOf(source).forEach((sentence, index) => {
    const spans = [...facts, ...terms]
      .filter(s => s.start >= sentence.start && s.end <= sentence.end)
      .map(s => ({ start: s.start - sentence.start, end: s.end - sentence.start, key: s.text, role: s.basis ? 'fact' : 'term', text: s.text }));
    for (const b of bindClauses(sentence.text, spans)) bindings.push({ sentence: index, subject: b.subject, head: b.head, verb: b.verb, direction: b.direction, negated: b.negated, facts: b.facts, clause: b.clause });
  });
  const tokenList = [
    ...factRows.map(f => ({ text: f.text, role: 'fact', basis: f.basis })),
    ...termRows.filter(t => MASKED_TERM_KINDS.has(t.kind)).map(t => ({ text: t.text, role: 'term', kind: t.kind })),
  ];
  const seen = new Set();
  const maskTokens = tokenList.filter(t => (seen.has(t.text) ? false : seen.add(t.text))).sort((a, b) => b.text.length - a.text.length || a.text.localeCompare(b.text));
  return {
    facts: factRows.sort((a, b) => b.text.length - a.text.length || a.text.localeCompare(b.text)),
    terms: [...termRows.sort((a, b) => b.count - a.count || a.text.localeCompare(b.text)), ...watch],
    bindings,
    tokens: maskTokens,
  };
}

module.exports = { brief, findFacts, findTerms, watchTerms, bindClauses, clauses, isNegation, directionOf, isVerb, FIN_HEADS, UP, DOWN, NEGATIONS };
