'use strict';
/* Plain text helpers with no knowledge of facts or terms: sentences, tokens, word counts. Nothing here allocates per character in a
   way that grows with the square of the input; every function is linear in the text it gets.

   splitSentences(text) -> [{ text, start, end }]: the sentences of one paragraph, in order. A period ends a sentence when whitespace or the
     end follows, the next word does not start in lower case, and the word before it is not a known abbreviation or a single initial.
     A decimal point ($4.1m) never ends one. The pieces between sentences are whitespace only, so joining the sentences with the gaps
     gives back the text.
   tokens(text, spans?) -> [{ w, lw, start, end, span? }]: the words of a text. A span ({ start, end, key, role }) is one token whatever
     it holds, so a masked figure or a multi-word term counts once.
   wordCount(text), normalizeSpace(text), stem(word). */

const ABBREV = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'inc', 'co', 'corp', 'ltd', 'llc', 'plc', 'lp', 'llp', 'vs', 'etc', 'e.g', 'i.e', 'eg', 'ie', 'no', 'nos',
  'approx', 'est', 'fig', 'figs', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'u.s', 'u.k', 'e.u',
  'st', 'jr', 'sr', 'avg', 'dept', 'yr', 'yrs', 'mo', 'mos', 'vol', 'p', 'pp', 'para', 'sec', 'art', 'cf', 'al', 'ref', 'resp', 'excl', 'incl',
]);

const SENTENCE_END_RE = /[.!?…]+["'”’)\]]*(?=\s|$)/g;

function splitSentences(text) {
  const source = String(text == null ? '' : text);
  const out = [];
  let start = firstNonSpace(source, 0);
  SENTENCE_END_RE.lastIndex = 0;
  let m;
  while ((m = SENTENCE_END_RE.exec(source))) {
    const end = m.index + m[0].length;
    if (end <= start) continue;
    if (m[0][0] === '.' && !m[0].startsWith('..')) {
      const before = source.slice(Math.max(start, m.index - 16), m.index);
      const word = /([A-Za-z][A-Za-z.]*)$/.exec(before);
      if (word) {
        const w = word[1].toLowerCase().replace(/\.$/, '');
        if (ABBREV.has(w) || word[1].length === 1) continue;
      }
    }
    const next = /^\s*(\S)/.exec(source.slice(end, end + 40));
    if (next && /[a-z]/.test(next[1])) continue;
    out.push({ text: source.slice(start, end), start, end });
    start = firstNonSpace(source, end);
  }
  const tailEnd = lastNonSpace(source);
  if (start < tailEnd) out.push({ text: source.slice(start, tailEnd), start, end: tailEnd });
  return out;
}

function firstNonSpace(text, from) {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

function lastNonSpace(text) {
  let i = text.length;
  while (i > 0 && /\s/.test(text[i - 1])) i -= 1;
  return i;
}

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’&-]*/gu;

/* Words, with each span (a masked figure, a term) folded into one token that carries the span. Spans must not overlap. */
function tokens(text, spans = []) {
  const source = String(text == null ? '' : text);
  const sorted = spans.slice().sort((a, b) => a.start - b.start);
  const out = [];
  let si = 0;
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(source))) {
    const start = m.index;
    const end = start + m[0].length;
    while (si < sorted.length && sorted[si].end <= start) si += 1;
    const span = sorted[si];
    if (span && span.start < end && start < span.end) {
      if (!out.length || out[out.length - 1].span !== span) out.push({ w: source.slice(span.start, span.end), lw: source.slice(span.start, span.end).toLowerCase(), start: span.start, end: span.end, span });
      if (span.end > end) WORD_RE.lastIndex = span.end;
      continue;
    }
    out.push({ w: m[0], lw: m[0].toLowerCase(), start, end });
  }
  /* a span that holds no word character at all (a lone symbol) still counts as a token */
  for (const span of sorted) {
    if (!out.some(t => t.span === span)) out.push({ w: source.slice(span.start, span.end), lw: source.slice(span.start, span.end).toLowerCase(), start: span.start, end: span.end, span });
  }
  return out.sort((a, b) => a.start - b.start);
}

function wordCount(text) {
  const m = String(text == null ? '' : text).match(/\S+/g);
  return m ? m.filter(w => /[\p{L}\p{N}]/u.test(w)).length : 0;
}

const normalizeSpace = text => String(text == null ? '' : text).replace(/\s+/g, ' ').trim();

/* A crude stem for comparing a subject across a rewrite: lower case, a plural or possessive ending dropped. */
function stem(word) {
  let w = String(word || '').toLowerCase().replace(/['’]s$/, '');
  if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
  else if (w.length > 4 && /(?:ses|xes|ches|shes)$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return w;
}

/* ------------------------------------------------------------------ blocks */

/* parseUnits(text) -> [{ type, start, end }]: the blocks of a document, left to right, with the offsets of each block's BODY (a bullet's
   marker and every blank line stay outside). type: paragraph, bullet (both rewritable), heading, table, code, quote, rule (shipped as
   written). A paragraph is consecutive non-blank lines; a bullet takes its indented continuation lines; a one-line paragraph of at most
   twelve words that does not end like a sentence (or ends with a colon) is a heading. */
const BULLET_RE = /^([ \t]*)((?:[-•*+‣◦]|\(?\d{1,3}[.)]|\(?[a-z][.)]|\(?(?:ii|iii|iv|vi|vii|viii|ix)[.)])[ \t]+)(?=\S)/i;
const HEADING_RE = /^[ \t]{0,3}#{1,6}[ \t]+\S/;
const RULE_RE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const TABLE_RE = /^[ \t]*\|.*\|[ \t]*$|\t.*\t/;
const QUOTE_LINE_RE = /^[ \t]*>/;
const FENCE_RE = /^[ \t]*(?:```|~~~)/;

const special = line => HEADING_RE.test(line) || RULE_RE.test(line) || TABLE_RE.test(line) || QUOTE_LINE_RE.test(line) || FENCE_RE.test(line);
const lineType = line => HEADING_RE.test(line) ? 'heading' : RULE_RE.test(line) ? 'rule' : TABLE_RE.test(line) ? 'table' : 'quote';

function looksLikeHeading(line) {
  const text = line.trim();
  if (/^\*\*[^*]+\*\*:?$/.test(text)) return true;
  if (text.endsWith(':')) return wordCount(text) <= 12;
  return wordCount(text) <= 12 && !/[.!?…]["'”’)\]]*$/.test(text);
}

function parseUnits(text) {
  const source = String(text == null ? '' : text);
  const lines = [];
  let pos = 0;
  for (const raw of source.split('\n')) {
    const body = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    lines.push({ start: pos, end: pos + body.length, text: body });
    pos += raw.length + 1;
  }
  const units = [];
  const push = (type, start, end) => {
    let s = start;
    let e = end;
    while (s < e && /\s/.test(source[s])) s += 1;
    while (e > s && /\s/.test(source[e - 1])) e -= 1;
    if (e > s) units.push({ type, start: s, end: e });
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.text.trim()) { i += 1; continue; }
    if (FENCE_RE.test(line.text)) {
      let j = i + 1;
      while (j < lines.length && !FENCE_RE.test(lines[j].text)) j += 1;
      const last = Math.min(j, lines.length - 1);
      push('code', line.start, lines[last].end);
      i = last + 1;
      continue;
    }
    if (special(line.text)) { push(lineType(line.text), line.start, line.end); i += 1; continue; }
    const bullet = BULLET_RE.exec(line.text);
    let j = i + 1;
    if (bullet) {
      let end = line.end;
      while (j < lines.length && lines[j].text.trim() && /^[ \t]+\S/.test(lines[j].text) && !BULLET_RE.test(lines[j].text) && !special(lines[j].text)) { end = lines[j].end; j += 1; }
      push('bullet', line.start + bullet[0].length, end);
      i = j;
      continue;
    }
    let end = line.end;
    while (j < lines.length && lines[j].text.trim() && !BULLET_RE.test(lines[j].text) && !special(lines[j].text)) { end = lines[j].end; j += 1; }
    push(j === i + 1 && looksLikeHeading(line.text) ? 'heading' : 'paragraph', line.start, end);
    i = j;
  }
  return units;
}

const REWRITABLE_UNITS = new Set(['paragraph', 'bullet']);

module.exports = { splitSentences, tokens, wordCount, normalizeSpace, stem, parseUnits, REWRITABLE_UNITS, ABBREV };
