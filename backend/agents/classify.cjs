'use strict';
/* Assistive classification of a pilot answer against a frozen gold and frozen fingerprints (docs/local-agents.md
   section 7). Everything here is labelled "heuristic". The human verdict is the one that is stored and exported. */

const crypto = require('node:crypto');

const MAX_TEXT = 4000000; /* characters examined per text */
const EPSILON = 1e-9;

/* A number as it appears in prose: optional minus sign stuck to the digits, optional currency sign, digits with
   thousands separators, optional decimals. Percent signs and a trailing x are left out of the match and ignored. */
const NUMBER_RE = /(?<![\w.])(-)?(?:[$\u20ac\u00a3\u00a5]\s?)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/g;
const FIGURE_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)$/;

const asArray = value => (Array.isArray(value) ? value : []);

/* Fold typography that would defeat matching: width variants, non breaking spaces, curly quotes, dashes and minus signs. */
function normalise(text) {
  return String(text === null || text === undefined ? '' : text)
    .slice(0, MAX_TEXT)
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-');
}

/* A figure given by the writer: a number, or text such as "$2,345", "21.4%", "3.2x" or "(2,345)". Returns null if unusable. */
function parseFigure(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  let text = normalise(value).trim();
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1).trim(); }
  text = text.replace(/[$\u20ac\u00a3\u00a5,\s]/g, '').replace(/[%x]$/i, '');
  if (!FIGURE_RE.test(text)) return null;
  const parsed = Number(text);
  return negative ? -parsed : parsed;
}

/* Every number in a text, signed. A number wrapped in brackets, as in accounting statements, is offered both ways
   because prose also uses brackets for ordinary positive numbers. */
function extractNumbers(text) {
  const numbers = [];
  for (const match of text.matchAll(NUMBER_RE)) {
    const digits = match[2].replace(/,/g, '') + (match[3] || '');
    const magnitude = Number(digits);
    if (!Number.isFinite(magnitude)) continue;
    numbers.push(match[1] ? -magnitude : magnitude);
    const before = text[match.index - 1];
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 3);
    if (!match[1] && before === '(' && /^\s?[%x]?\)/i.test(after)) numbers.push(-magnitude);
  }
  return numbers;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* A phrase must appear on word boundaries, so "hold" does not match "threshold" and "2,345" does not match "12,345"
   or "2,345,000". Matching is case insensitive. Returns null for an empty phrase. */
function phrasePattern(phrase) {
  const text = normalise(phrase).trim().toLowerCase();
  if (!text) return null;
  const body = text.split(/\s+/).map(escapeRegExp).join('\\s+');
  const left = /^[a-z0-9]/.test(text) ? '(?<![a-z0-9])(?<!\\d[.,])' : '';
  const right = /[a-z0-9]$/.test(text) ? '(?![a-z0-9]|[.,]\\d)' : '';
  return new RegExp(left + body + right);
}

/* One text prepared for searching. */
function prepare(text) {
  const normal = normalise(text);
  return { lower: normal.toLowerCase(), numbers: extractNumbers(normal) };
}

function hasPhrase(prepared, phrase) {
  const pattern = phrasePattern(phrase);
  return pattern !== null && pattern.test(prepared.lower);
}

/* A decision keyword that a negation comes right before does not say what it seems to say ("do not approve the
   refinancing"). A negation counts when it is one of the three words before the keyword in the same sentence: not, no,
   never, avoid, cannot, and any contraction ending in n't (don't, shouldn't, can't, ...), so "do not" and "should not"
   are covered by their "not". A full stop, !, ?, ; or a new line ends the sentence, so a negation in an earlier sentence
   does not carry over. */
const NEGATION_WORDS = 3;
const NEGATION_LOOKBACK = 100; /* characters looked at before a keyword, enough for three words */
const MAX_KEYWORD_OCCURRENCES = 20000; /* occurrences of one keyword examined, so no text costs more than a bounded amount */
const isNegator = word => /^(?:not|no|never|avoid|cannot|dont)$/.test(word) || /n't$/.test(word);

function negatedAt(lower, index) {
  const before = lower.slice(Math.max(0, index - NEGATION_LOOKBACK), index);
  const words = before.slice(before.lastIndexOf('\n') + 1).split(/\s+/).filter(Boolean);
  let seen = 0;
  for (let i = words.length - 1; i >= 0 && seen < NEGATION_WORDS; i--, seen++) {
    if (/[.!?;]$/.test(words[i])) return false; /* the word ends an earlier sentence */
    if (isNegator(words[i].replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, ''))) return true;
  }
  return false;
}

/* Does the phrase appear at least once without a negation before it? */
function hasAffirmedPhrase(prepared, phrase) {
  const pattern = phrasePattern(phrase);
  if (pattern === null) return false;
  let examined = 0;
  for (const match of prepared.lower.matchAll(new RegExp(pattern.source, 'g'))) {
    if (!negatedAt(prepared.lower, match.index)) return true;
    if (++examined >= MAX_KEYWORD_OCCURRENCES) return false;
  }
  return false;
}

function hasFigure(prepared, target, tolerance) {
  const allowed = tolerance + EPSILON * Math.max(1, Math.abs(target));
  return prepared.numbers.some(number => Math.abs(number - target) <= allowed);
}

/* Look for a figure in the final answer first, then in the outputs. Returns where it was found. */
function findFigure(figure, texts) {
  const item = figure && typeof figure === 'object' ? figure : {};
  const target = parseFigure(item.value);
  const parsedTolerance = parseFigure(item.tolerance === undefined ? 0 : item.tolerance);
  const tolerance = parsedTolerance === null ? 0 : Math.abs(parsedTolerance);
  let where = null;
  if (target !== null) {
    if (hasFigure(texts.final, target, tolerance)) where = 'final';
    else if (hasFigure(texts.outputs, target, tolerance)) where = 'outputs';
  }
  return { label: typeof item.label === 'string' ? item.label : '', value: item.value, found: where !== null, where };
}

/* A gold figure with a single digit (0 to 9, either sign) turns up in almost any answer, so a match on it is weak. */
const isSingleDigit = value => {
  const target = parseFigure(value);
  return target !== null && Number.isInteger(target) && Math.abs(target) <= 9;
};

/* Only the final answer decides a verdict. What the pilot wrote into its output files can hold the source figures it was
   given and every number of its working, so a hit there is reported (see `where`) and not counted. */
function checkFingerprint(fingerprint, texts) {
  const item = fingerprint && typeof fingerprint === 'object' ? fingerprint : {};
  const tokens = asArray(item.tokens).filter(token => typeof token === 'string' && token.trim());
  const figures = asArray(item.figures).map(figure => findFigure(figure, texts));
  const tokensFound = tokens.filter(token => hasPhrase(texts.final, token));
  const byTokens = tokens.length > 0 && tokensFound.length === tokens.length;
  const byFigures = figures.length > 0 && figures.every(figure => figure.where === 'final');
  return {
    id: typeof item.id === 'string' ? item.id : '',
    label: typeof item.label === 'string' ? item.label : '',
    hit: byTokens || byFigures,
    tokensFound,
    figuresFound: figures,
  };
}

/* suggest(freeze, finalText, outputsText)
   -> { verdict: 'matches-frozen-gold' | 'fingerprint' | 'unclear',
        matches: [{ label, value, found, where, weak?, reason? }], fingerprints: [{ id, label, hit, tokensFound, figuresFound }],
        decision: { keywords, found }, reason?, label: 'heuristic' }
   - The verdict is decided from the final answer only. The outputs text (the pilot's output files) is searched too, but
     only to say where a gold figure appeared: `where` is 'final', 'outputs' (found there and nowhere in the answer, so it
     does not count) or null. A keyword or fingerprint that is only in the outputs does not count either. `reason` says so.
     The page prints `found` and `where` for each gold figure ("found in the outputs"), so those two carry the news.
   - Figures match within the writer's absolute tolerance after thousands separators, currency signs and a trailing
     % or x are ignored. A minus sign matters.
   - matches-frozen-gold needs every gold figure in the final answer, no fingerprint hit, and at least one decision keyword
     when gold.decision (keywords separated by semicolons) is given. A gold with no figures and no keywords proves nothing,
     so it is never a match.
   - A decision keyword does not count when not, no, never, avoid, cannot or a contraction ending in n't stands within
     three words before it in the same sentence ("do not approve the refinancing").
   - A gold figure that is a single digit (0 to 9, either sign) is weak evidence: its entry has weak: true, and its `where`
     reads "final, a single digit that may be incidental" (which the page prints after "found in the"). When every gold
     figure is weak and no decision keyword confirms them, the answer is not a match (unclear, or fingerprint when one hits).
   - A fingerprint hits only when all of its tokens appear or all of its figures match, in the final answer.
   - A fingerprint hit alongside a full gold match is reported as unclear: the answer states both.
   - `reason` (a few short sentences) is only present when something above kept evidence from counting. */
function suggest(freeze, finalText, outputsText) {
  if (freeze === null || typeof freeze !== 'object') throw new TypeError('suggest needs a freeze record');
  const texts = { final: prepare(finalText), outputs: prepare(outputsText) };
  const gold = freeze.gold !== null && typeof freeze.gold === 'object' ? freeze.gold : {};
  const goldFigures = asArray(gold.figures);
  const located = goldFigures.map(figure => findFigure(figure, texts));
  const weak = located.map((match, index) => match.where === 'final' && isSingleDigit(goldFigures[index] && goldFigures[index].value));
  const matches = located.map((match, index) => (weak[index]
    ? { ...match, where: 'final, a single digit that may be incidental', weak: true, reason: 'a single-digit figure can match by chance' }
    : match));
  const keywords = String(gold.decision === null || gold.decision === undefined ? '' : gold.decision).split(';').map(part => part.trim()).filter(Boolean);
  const keywordsFound = keywords.filter(keyword => hasAffirmedPhrase(texts.final, keyword));
  const fingerprintItems = asArray(freeze.fingerprints);
  const fingerprints = fingerprintItems.map(fingerprint => checkFingerprint(fingerprint, texts));
  const anyFingerprint = fingerprints.some(fingerprint => fingerprint.hit);
  const hasCriteria = matches.length > 0 || keywords.length > 0;
  let goldMet = hasCriteria && located.every(match => match.where === 'final') && (keywords.length === 0 || keywordsFound.length > 0);
  const weakOnly = goldMet && matches.length > 0 && weak.every(Boolean) && keywordsFound.length === 0;
  if (weakOnly) goldMet = false;
  let verdict = 'unclear';
  if (goldMet && !anyFingerprint) verdict = 'matches-frozen-gold';
  else if (anyFingerprint && !goldMet) verdict = 'fingerprint';

  const reasons = explainUncounted({ texts, goldFigures, located, keywords, keywordsFound, fingerprints, fingerprintItems, weakOnly });
  const result = { verdict, matches, fingerprints, decision: { keywords, found: keywordsFound }, label: 'heuristic' };
  if (reasons.length) result.reason = reasons.join(' ');
  return result;
}

/* One sentence for each kind of evidence that was seen and not counted: a gold figure, a keyword or a fingerprint that is
   only in the outputs, a keyword that only follows a negation, and a match on single digits alone. */
function explainUncounted({ texts, goldFigures, located, keywords, keywordsFound, fingerprints, fingerprintItems, weakOnly }) {
  const sentences = [];
  const say = (items, noun, what) => {
    if (!items.length) return;
    const one = items.length === 1;
    sentences.push(`The ${noun}${one ? '' : 's'} ${items.join(', ')} ${one ? 'appears' : 'appear'} ${what}, so ${one ? 'it is' : 'they are'} not counted.`);
  };
  const figureName = (match, index) => {
    const value = goldFigures[index] && goldFigures[index].value;
    return match.label ? `${match.label} (${value})` : String(value);
  };
  say(located.map((match, index) => (match.where === 'outputs' ? figureName(match, index) : null)).filter(Boolean), 'gold figure', 'only in the output files, not in the final answer');
  const otherKeywords = keywords.filter(keyword => !keywordsFound.includes(keyword));
  const inOutputs = otherKeywords.filter(keyword => hasAffirmedPhrase(texts.outputs, keyword));
  say(inOutputs, 'decision keyword', 'only in the output files');
  say(otherKeywords.filter(keyword => !inOutputs.includes(keyword) && hasPhrase(texts.final, keyword)), 'decision keyword', 'in the final answer only after a negation (not, no, never, avoid, cannot, n\'t)');
  const outputsAsAnswer = { final: texts.outputs, outputs: texts.outputs };
  say(fingerprints.map((fingerprint, index) => (!fingerprint.hit && checkFingerprint(fingerprintItems[index], outputsAsAnswer).hit
    ? (fingerprint.label || fingerprint.id || `fingerprint ${index + 1}`) : null)).filter(Boolean), 'fingerprint', 'only in the output files');
  if (weakOnly) {
    const names = located.map(figureName);
    const one = names.length === 1;
    sentences.push(`Weak evidence: the gold figure${one ? '' : 's'} ${names.join(', ')} ${one ? 'is a single digit' : 'are single digits'}, so the match may be incidental, and no decision keyword confirms ${one ? 'it' : 'them'}.`);
  }
  return sentences;
}

/* Canonical JSON: object keys sorted, no whitespace, undefined and functions dropped as JSON.stringify does. */
function canonicalize(value, depth = 0) {
  if (depth > 64) throw new RangeError('The freeze record is nested too deeply');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string': return JSON.stringify(value);
    case 'number': return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'boolean': return value ? 'true' : 'false';
    case 'bigint': throw new TypeError('The freeze record cannot contain a bigint');
    case 'object': break;
    default: return undefined;
  }
  if (typeof value.toJSON === 'function') return canonicalize(value.toJSON(), depth + 1);
  if (Array.isArray(value)) return '[' + value.map(item => { const text = canonicalize(item, depth + 1); return text === undefined ? 'null' : text; }).join(',') + ']';
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    const text = canonicalize(value[key], depth + 1);
    if (text !== undefined) parts.push(JSON.stringify(key) + ':' + text);
  }
  return '{' + parts.join(',') + '}';
}

/* sha256 (hex) of the canonical JSON of a freeze record. A top level `sha256` property is ignored, so a stored record
   can be re-hashed and compared with the hash it carries. */
function hashFreeze(freeze) {
  if (freeze === null || typeof freeze !== 'object') throw new TypeError('hashFreeze needs a freeze record');
  const { sha256, ...rest } = freeze;
  return crypto.createHash('sha256').update(canonicalize(Array.isArray(freeze) ? freeze : rest), 'utf8').digest('hex');
}

module.exports = { suggest, hashFreeze, parseFigure, extractNumbers };
