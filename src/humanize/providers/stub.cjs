'use strict';
/* Offline stand-ins, so the whole network of workers can run with nothing installed and no account: tests, demos, and a dry run of a
   document before any credit is spent. Neither calls anything.

   stubRewriter(): deterministic edits of common machine tells (stock transitions, "it is important to note", "utilize", missing
     contractions). It keeps every placeholder where it was. It is not Verva and its output is not a humanized text.
   stubDetector(): an ESTIMATE of how machine-like a text reads, from the same tells, sentence-length uniformity and the absence of
     contractions. It is not GPTZero, it is marked estimate: true, and a run scored by it is never signed off. */

const { splitSentences, wordCount } = require('../text.cjs');

const EDITS = [
  [/\bIt is important to note that\s+/g, ''],
  [/\bit is important to note that\s+/g, ''],
  [/\bIt is worth noting that\s+/g, ''],
  [/\bIn order to\b/g, 'To'],
  [/\bin order to\b/g, 'to'],
  [/\butiliz(e|es|ed|ing)\b/g, (m, end) => ({ e: 'use', es: 'uses', ed: 'used', ing: 'using' }[end])],
  [/\bMoreover,\s*/g, 'Also, '],
  [/\bFurthermore,\s*/g, 'On top of that, '],
  [/\bAdditionally,\s*/g, 'Also, '],
  [/\bIn conclusion,\s*/g, ''],
  [/\bOverall,\s*/g, ''],
  [/\bdelve(s)? into\b/g, (m, s) => `look${s || ''} at`],
  [/\bcomprehensive\b/g, 'full'],
  [/\brobust\b/g, 'solid'],
  [/\bpivotal\b/g, 'key'],
  [/\bcrucial\b/g, 'key'],
  [/\bseamless(ly)?\b/g, (m, ly) => (ly ? 'smoothly' : 'smooth')],
  [/\bit is\b/g, "it's"],
  [/\bIt is\b/g, "It's"],
  [/\bdo not\b/g, "don't"],
  [/\bdoes not\b/g, "doesn't"],
  [/\bdid not\b/g, "didn't"],
  [/\bis not\b/g, "isn't"],
  [/\bare not\b/g, "aren't"],
  [/\bwas not\b/g, "wasn't"],
  [/\bcannot\b/g, "can't"],
];

function stubRewriter(options = {}) {
  return {
    id: 'stub',
    label: 'Offline rewriter (stub)',
    external: false,
    minWords: Number.isInteger(options.minWords) ? options.minWords : 0,
    async rewrite(text) {
      let out = String(text);
      for (const [re, to] of EDITS) out = out.replace(re, to);
      /* a sentence that lost its opening words starts with a capital again */
      out = out.replace(/(^|[.!?]\s+)([a-z])/g, (m, lead, ch) => lead + ch.toUpperCase());
      return out;
    },
  };
}

const TELLS = /\b(?:moreover|furthermore|additionally|crucial|pivotal|robust|seamless(?:ly)?|comprehensive|delve|leverage|notably|utiliz\w*|it is important to note|it is worth noting|in conclusion|overall|landscape|underscore\w*|testament)\b/gi;
const CONTRACTION = /\b\w+['’](?:s|t|re|ve|ll|d|m)\b/i;

function stubDetector() {
  return {
    id: 'stub',
    label: 'Offline estimate (not GPTZero)',
    estimate: true,
    external: false,
    async scan(text) {
      const sentences = splitSentences(String(text).replace(/\n+/g, ' '));
      const lengths = sentences.map(s => wordCount(s.text));
      const mean = lengths.reduce((a, b) => a + b, 0) / (lengths.length || 1);
      const spread = Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / (lengths.length || 1)) / (mean || 1);
      const uniform = lengths.length > 2 && spread < 0.25 ? 0.12 : 0;
      const scored = sentences.map(s => {
        const tells = (s.text.match(TELLS) || []).length;
        const formal = wordCount(s.text) >= 15 && !CONTRACTION.test(s.text) ? 0.1 : 0;
        const p = Math.max(0, Math.min(1, 0.2 + 0.28 * tells + formal + uniform));
        return { text: s.text, generatedProb: Math.round(p * 1000) / 1000 };
      });
      const weight = scored.reduce((n, s) => n + wordCount(s.text), 0) || 1;
      const ai = scored.reduce((n, s) => n + s.generatedProb * wordCount(s.text), 0) / weight;
      const human = Math.round((1 - ai) * 1000) / 1000;
      return { human, ai: Math.round(ai * 1000) / 1000, mixed: 0, predictedClass: human >= 0.5 ? 'human' : 'ai', confidence: 'estimate', sentences: scored };
    },
  };
}

module.exports = { stubRewriter, stubDetector };
