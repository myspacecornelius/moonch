'use strict';
/* The document model the orchestrator works on.

   segment(text, { minChunkWords, maxChunkWords, bars }) -> { segments, chunks }
     segments: [{ id, kind, text }] in order; joining every segment's text gives back the source exactly. kind 'fixed' (headings, tables,
               code, quotes, rules, bullet markers, blank lines, blocks under four words) ships as written and is never sent anywhere.
               'prose' is a paragraph or a bullet that reads as sentences (at least twelve words, fifteen for a bullet, fewer than 12
               figures per 100 words). 'other' is any other rewritable block: figure-heavy lines and short bullets. A paragraph longer than
               maxChunkWords is cut at sentence boundaries into several segments.
     chunks:   [{ id, kind, bar, segmentIds }]: what one rewriter call and one detector scan sees. A short prose paragraph is merged with the
               next prose paragraph up to minChunkWords; consecutive 'other' blocks (a run of bullets) are grouped up to maxChunkWords.
               bar: 0.90 for prose, 0.70 for other (constants BARS).
   assemble(segments, texts) -> the document with each rewritable segment's text replaced by texts[id] where one is given.
   joinSegments(texts) / splitReturned(text, n): how a multi-segment chunk travels as one text (blank line between segments) and how the
     rewriter's answer is cut back into n segments (null when the paragraph count does not match). */

const { parseUnits, REWRITABLE_UNITS, splitSentences, wordCount } = require('./text.cjs');
const { findFacts } = require('./secretary.cjs');
const { LIMITS, BARS } = require('./constants.cjs');

function classifyBlock(body, type) {
  const words = wordCount(body);
  if (words < 4) return 'fixed';
  const density = findFacts(body).length / words;
  const minWords = type === 'bullet' ? 15 : 12;
  if (words >= minWords && density < 0.12 && /\p{Ll}{3}/u.test(body)) return 'prose';
  return 'other';
}

/* Cut a long paragraph into pieces of at most maxWords at sentence boundaries: [{ start, end }] offsets inside body. */
function cutLong(body, maxWords) {
  const sentences = splitSentences(body);
  const pieces = [];
  let current = null;
  for (const s of sentences) {
    const w = wordCount(s.text);
    if (current && current.words + w > maxWords) { pieces.push(current); current = null; }
    if (!current) current = { start: s.start, end: s.end, words: 0 };
    current.end = s.end;
    current.words += w;
  }
  if (current) pieces.push(current);
  return pieces.length ? pieces : [{ start: 0, end: body.length, words: wordCount(body) }];
}

const BULLET_MARKERS_RE = /(^|\n)[ \t]*(?:[-•*+‣◦]|\(?\d{1,3}[.)]|\(?[a-z][.)])[ \t]+/gi;
const onlyLayout = text => text.replace(BULLET_MARKERS_RE, '$1').trim() === '';

function segment(text, options = {}) {
  const source = String(text == null ? '' : text);
  const minChunkWords = options.minChunkWords || LIMITS.minChunkWords;
  const maxChunkWords = options.maxChunkWords || LIMITS.maxChunkWords;
  const bars = { ...BARS, ...(options.bars || {}) };
  const segments = [];
  let pos = 0;
  const pushFixed = end => {
    if (end <= pos) return;
    const last = segments[segments.length - 1];
    if (last && last.kind === 'fixed') last.text += source.slice(pos, end);
    else segments.push({ id: segments.length, kind: 'fixed', text: source.slice(pos, end) });
    pos = end;
  };
  for (const unit of parseUnits(source)) {
    const body = source.slice(unit.start, unit.end);
    const kind = REWRITABLE_UNITS.has(unit.type) ? classifyBlock(body, unit.type) : 'fixed';
    if (kind === 'fixed') continue;
    pushFixed(unit.start);
    const pieces = kind === 'prose' && wordCount(body) > maxChunkWords ? cutLong(body, maxChunkWords) : [{ start: 0, end: body.length }];
    for (const piece of pieces) {
      pushFixed(unit.start + piece.start);
      segments.push({ id: segments.length, kind, text: source.slice(unit.start + piece.start, unit.start + piece.end) });
      pos = unit.start + piece.end;
    }
  }
  pushFixed(source.length);

  const chunks = [];
  let open = null;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg.kind === 'fixed') {
      if (open && !onlyLayout(seg.text)) open = null;
      continue;
    }
    const words = wordCount(seg.text);
    const fits = open && open.kind === seg.kind && open.words + words <= maxChunkWords && (seg.kind === 'other' || open.words < minChunkWords);
    if (fits) {
      open.segmentIds.push(seg.id);
      open.words += words;
    } else {
      open = { id: `c${chunks.length + 1}`, kind: seg.kind, bar: seg.kind === 'prose' ? bars.prose : bars.other, segmentIds: [seg.id], words };
      chunks.push(open);
    }
  }
  return { segments, chunks: chunks.map(({ words, ...rest }) => rest) };
}

function assemble(segments, texts = {}) {
  return segments.map(s => (s.kind !== 'fixed' && typeof texts[s.id] === 'string' ? texts[s.id] : s.text)).join('');
}

const SEGMENT_JOIN = '\n\n';
const joinSegments = texts => texts.join(SEGMENT_JOIN);

/* The rewriter's answer for an n-segment chunk, cut back into n texts; null when it cannot be done without guessing. One segment: the whole
   answer, with its line breaks folded into spaces (a paragraph or a bullet is one line of thought). */
function splitReturned(text, n) {
  const clean = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
  if (n === 1) return [clean.replace(/\s*\n\s*/g, ' ')];
  let parts = clean.split(/\n[ \t]*\n+/).map(p => p.trim()).filter(Boolean);
  if (parts.length !== n) parts = clean.split(/\n+/).map(p => p.trim()).filter(Boolean);
  if (parts.length !== n) return null;
  return parts.map(p => p.replace(/\s*\n\s*/g, ' '));
}

module.exports = { segment, assemble, joinSegments, splitReturned, classifyBlock, SEGMENT_JOIN };
