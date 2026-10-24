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

/* Does a line of text end a unit on its own, so that the next line begins something new? A sentence does (it ends in a full stop, a question or exclamation
   mark, a colon or a semicolon, with a closing quote or bracket after it); so does a heading (a short line of capitalised words, or a mark of one), an item of a
   list, and a row of a table. A line that stops in the middle of a sentence because the file was wrapped there does not. */
const ENDS_SENTENCE_RE = /[.!?:;]["')\]]*$/;
const MARKED_LINE_RE = /^(?:#{1,6}\s|[-*\u2022]\s|\d{1,3}[.)]\s|\(?[A-Za-z]{1,2}[.)]\s|\|)/;
function endsUnit(line) {
  const text = line.trim();
  if (!text) return true;
  if (ENDS_SENTENCE_RE.test(text) || MARKED_LINE_RE.test(text) || text.includes('\t') || text.includes('|')) return true;
  const words = text.split(/\s+/);
  return text.length <= 70 && words.length <= 10 && !/,$/.test(text) && words.filter(word => /^[A-Z0-9(]/.test(word)).length / words.length >= 0.6;
}

/* The same folding, and the places in the folded text where a new unit began on a new line: a line break is a boundary of a sentence when the line before it
   ends one (a full stop, a heading, an item of a list, a row of a table, a blank line between paragraphs, any line of a CSV file), and is not when the file was
   wrapped in the middle of a sentence. Resolves { norm, lineStarts: Set of positions }. options.everyLine: every line is a unit (a CSV file). */
function normalizeWithLines(text, options = {}) {
  const s = foldTypography(text);
  let norm = '';
  const lineStarts = new Set();
  const re = /\s+/g;
  let last = 0;
  let lineBegin = 0;
  let match;
  const push = piece => { norm += piece; };
  while ((match = re.exec(s)) !== null) {
    push(s.slice(last, match.index));
    last = match.index + match[0].length;
    if (norm.length === 0 || last >= s.length) continue; /* leading and trailing white space is dropped */
    push(' ');
    const breaks = (match[0].match(/\n/g) || []).length + (match[0].includes('\r') && !match[0].includes('\n') ? 1 : 0);
    if (breaks > 0) {
      const line = s.slice(lineBegin, match.index);
      if (options.everyLine === true || breaks > 1 || endsUnit(line)) lineStarts.add(norm.length);
      lineBegin = last;
    }
  }
  push(s.slice(last));
  return { norm, lineStarts };
}

/* A corpus: [{ name, text }] -> [{ name, norm, lineStarts }] so that many quotes are looked up without normalising again. */
function buildCorpus(documents) {
  return documents.filter(item => item && typeof item.text === 'string').map(item => ({ name: item.name, ...normalizeWithLines(item.text, { everyLine: /\.(?:csv|tsv)$/i.test(String(item.name || '')) }) }));
}

/* Does the quote, found at `at` in the folded text, start and end as a whole sentence? A sentence starts at the start of the text, after a full stop (or ? ! :
   ;), at the start of a line that follows a unit that ended (see endsUnit), after a list marker, a heading mark or a table bar, and ends with a full stop (also
   before a closing quote or bracket) that is followed by the end of the text or by a space and a word that does not start in lower case (so a full stop inside
   60.50 or before "dollars" in "U.S. dollars" does not end it), at the end of the text, at the end of a line that ends a unit, or before a table bar.
   lineStarts: the positions where a new unit began on a new line (see normalizeWithLines). */
const LIST_MARKER_RE = /(?:^|\s)(?:[-*\u2022]|#{1,6}|\d{1,3}[.)]|\(?[A-Za-z]{1,2}[.)]|\|)\s$/;
function wholeSentence(norm, at, length, lineStarts = null) {
  const lines = lineStarts instanceof Set ? lineStarts : null;
  /* an opening quote or bracket in front of the sentence is not part of the sentence before it */
  let start = at;
  while (start > 0 && '"\'([{'.includes(norm[start - 1])) start--;
  const before = start === 0 || (lines && lines.has(start)) || /[.!?:;]["')\]]* $/.test(norm.slice(Math.max(0, start - 6), start)) || LIST_MARKER_RE.test(norm.slice(Math.max(0, start - 8), start));
  const end = at + length;
  const stops = /[.!?]["')\]]*$/.test(norm.slice(at, end));
  /* what follows the quote in the file decides, not the last character of the quote */
  let past = end;
  while (past < norm.length && '"\')]'.includes(norm[past])) past++; /* a closing quote or bracket right after the full stop belongs to the sentence */
  const after = end >= norm.length
    || (stops && (past >= norm.length || (norm[past] === ' ' && !/^ ?[a-z]/.test(norm.slice(past, past + 2)))))
    || (lines && lines.has(end + 1) && norm[end] === ' ')
    || norm.slice(end, end + 2) === ' |';
  return Boolean(before && after);
}

/* Does the quote, found at `at`, stop in the middle of a word or of a number (1,250 cut from 1,250,000; 60 from 60.50) or start in the middle of a word? */
function cutsInside(norm, at, length) {
  const end = at + length;
  if (at > 0 && /[A-Za-z0-9]/.test(norm[at]) && /[A-Za-z0-9]/.test(norm[at - 1])) return true;
  if (end < norm.length && /[A-Za-z0-9]/.test(norm[end - 1]) && /[A-Za-z0-9]/.test(norm[end])) return true;
  return end < norm.length && /[0-9]/.test(norm[end - 1]) && /^[.,]\d/.test(norm.slice(end, end + 2));
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
      if (!strict || (!cutsInside(document.norm, at, wanted.length) && (wanted.length >= MIN_CLAUSE_QUOTE_CHARS || wholeSentence(document.norm, at, wanted.length, document.lineStarts)))) return document.name;
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
