'use strict';
/* Quotes and dates, checked by the harness and never taken on trust. A model that says "the packet says X" gives the words and the file; the
   words count only when they are found, whitespace-normalised, in that text. A date counts only when it is a real ISO date. */

const { MIN_QUOTE_CHARS, MIN_CLAUSE_QUOTE_CHARS, MIN_SENTENCE_QUOTE_CHARS } = require('./constants.cjs');

/* Typography folded, white space collapsed. Case is kept: a quote is word for word. */
function foldTypography(text) {
  return String(text === undefined || text === null ? '' : text)
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, '\'')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-');
}

function normalizeText(text) {
  return foldTypography(text).replace(/\s+/g, ' ').trim();
}

/* The same folding, and the places in the folded text where a line of the original began (white space that held a line break): a line is a boundary
   of a sentence in a list, under a heading or in a table cell, where nothing marks it with a full stop. Resolves { norm, lineStarts: Set of positions }. */
function normalizeWithLines(text) {
  const s = foldTypography(text);
  let norm = '';
  const lineStarts = new Set();
  const re = /\s+/g;
  let last = 0;
  let match;
  const push = piece => { norm += piece; };
  while ((match = re.exec(s)) !== null) {
    push(s.slice(last, match.index));
    last = match.index + match[0].length;
    if (norm.length === 0 || last >= s.length) continue; /* leading and trailing white space is dropped */
    push(' ');
    if (/[\n\r]/.test(match[0])) lineStarts.add(norm.length);
  }
  push(s.slice(last));
  return { norm, lineStarts };
}

/* A corpus: [{ name, text }] -> [{ name, norm, lineStarts }] so that many quotes are looked up without normalising again. */
function buildCorpus(documents) {
  return documents.filter(item => item && typeof item.text === 'string').map(item => ({ name: item.name, ...normalizeWithLines(item.text) }));
}

/* Does the quote, found at `at` in the folded text, start and end as a whole sentence? A sentence starts at the start of the text, after a full stop (or ? ! :
   ;), at the start of a line, after a list marker, a heading mark or a table bar, and ends with a full stop (also before a closing quote or bracket), at the
   end of the text, at the end of a line or before a table bar. lineStarts: the positions where a line began (see normalizeWithLines). */
const LIST_MARKER_RE = /(?:^|\s)(?:[-*\u2022]|#{1,6}|\d{1,3}[.)]|\(?[A-Za-z]{1,2}[.)]|\|)\s$/;
function wholeSentence(norm, at, length, lineStarts = null) {
  const lines = lineStarts instanceof Set ? lineStarts : null;
  /* an opening quote or bracket in front of the sentence is not part of the sentence before it */
  let start = at;
  while (start > 0 && '"\'([{'.includes(norm[start - 1])) start--;
  const before = start === 0 || (lines && lines.has(start)) || /[.!?:;]["')\]]* $/.test(norm.slice(Math.max(0, start - 6), start)) || LIST_MARKER_RE.test(norm.slice(Math.max(0, start - 8), start));
  const end = at + length;
  const after = end >= norm.length || /[.!?]["')\]]*$/.test(norm.slice(at, end)) || (lines && lines.has(end + 1) && norm[end] === ' ') || norm.slice(end, end + 2) === ' |';
  return before && after;
}

/* Is the quote long enough and found in one of the documents? Returns the name of the document, or ''. `name` limits the search to the document of that
   name: a name that is no document of the corpus finds nothing (a wrong file name fails the quote; it is never searched for in the whole packet).
   Left out (undefined), every document is searched. options.strict: the quote is evidence of a clause or a date, so it needs MIN_CLAUSE_QUOTE_CHARS
   characters or, shorter than that, to be a whole sentence of at least MIN_SENTENCE_QUOTE_CHARS. Every place where the quote occurs is tried, not
   only the first. */
function findQuote(quote, corpus, name, options = {}) {
  const wanted = normalizeText(quote);
  const strict = options.strict === true;
  if (wanted.length < (strict ? MIN_SENTENCE_QUOTE_CHARS : MIN_QUOTE_CHARS)) return '';
  const limited = name !== undefined && name !== null;
  for (const document of corpus) {
    if (limited && document.name !== name) continue;
    let at = document.norm.indexOf(wanted);
    while (at >= 0) {
      if (!strict || wanted.length >= MIN_CLAUSE_QUOTE_CHARS || wholeSentence(document.norm, at, wanted.length, document.lineStarts)) return document.name;
      at = document.norm.indexOf(wanted, at + 1);
    }
  }
  return '';
}

/* "2025-03-01" -> a UTC time in milliseconds, or null when it is not a real calendar date in exactly that form. */
function isoTime(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text === undefined || text === null ? '' : text).trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(year, month - 1, day);
  const back = new Date(time);
  return back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day ? time : null;
}

/* Is the document in force on the decision date? { ok, reason }: a missing or unparseable date fails. */
function inForce(effectiveDate, decisionDate) {
  const effective = isoTime(effectiveDate);
  const decision = isoTime(decisionDate);
  if (effective === null) return { ok: false, reason: 'the effective date is missing or is not an ISO date' };
  if (decision === null) return { ok: false, reason: 'the decision date is missing or is not an ISO date' };
  if (effective > decision) return { ok: false, reason: 'the document takes effect after the decision date' };
  return { ok: true, reason: '' };
}

const MONTHS = { january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12 };
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const iso = (year, month, day) => {
  const text = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isoTime(text) === null ? null : text;
};

/* Every calendar date a text holds, with its place in the folded text: [{ iso, index, end }] in order. The forms that are read: 2025-03-01, 2025/03/01,
   1 March 2025, 1st March 2025, the 1st day of March, 2025, March 1, 2025. A slash date with the year last (03/01/2025) is not read: day and month cannot be
   told apart, and neither can 20250301 or "March 2025", which are no day. */
function datesAt(text) {
  const raw = normalizeText(text);
  const found = [];
  const add = (m, value) => { if (value) found.push({ iso: value, index: m.index, end: m.index + m[0].length }); };
  for (const m of raw.matchAll(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/g)) add(m, iso(m[1], m[2], m[3]));
  for (const m of raw.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\.?\\s+(?:of\\s+)?(${MONTH_RE})\\.?,?\\s+(\\d{4})\\b`, 'gi'))) add(m, iso(m[3], MONTHS[m[2].toLowerCase()], m[1]));
  for (const m of raw.matchAll(new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'))) add(m, iso(m[3], MONTHS[m[1].toLowerCase()], m[2]));
  for (const m of raw.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)\\s+day\\s+of\\s+(${MONTH_RE}),?\\s+(\\d{4})\\b`, 'gi'))) add(m, iso(m[3], MONTHS[m[2].toLowerCase()], m[1]));
  return found.sort((a, b) => a.index - b.index);
}

/* The calendar dates a text holds, as ISO dates, each once. */
function datesIn(text) {
  return [...new Set(datesAt(text).map(item => item.iso))];
}

module.exports = { normalizeText, normalizeWithLines, buildCorpus, findQuote, isoTime, inForce, datesIn, datesAt, wholeSentence };
