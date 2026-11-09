'use strict';
/* The humanize orchestrator's fixed rules (docs/humanize.md). The page shows copies of BARS and LIMITS; the orchestrator enforces these. */

/* Human-probability bars. A chunk of prose is signed off at 0.90, any other rewritable chunk (bullets, data-heavy lines) at 0.70, and the
   run is done when the word-weighted mean of the chunk readings reaches 0.80. */
const BARS = Object.freeze({ prose: 0.90, other: 0.70, aggregate: 0.80 });

const LIMITS = Object.freeze({
  maxPasses: 3,          /* rewrite -> repair -> scan cycles a chunk gets in one round before it is respliced */
  maxPassesCap: 5,
  maxRounds: 3,          /* resplice rounds (the first round included) before the run stops below the bar */
  maxRoundsCap: 6,
  flaggedSpan: 0.80,     /* a sentence GPTZero reads at or above this generated_prob is a flagged span; only those are re-run */
  maxLengthDrift: 0.15,  /* a rewritten segment more than 15% longer or shorter (in words) than its source fails the gate */
  workers: 1,            /* workers per field (rewriters, sign-off scanners). 1 runs every call one after the other */
  maxWorkers: 4,
  minChunkWords: 40,     /* short prose paragraphs are merged with the next one up to this size */
  maxChunkWords: 220,    /* a longer paragraph is split at sentence boundaries */
  maxTextChars: 60000,
  maxRewriteCalls: 200,  /* per run: a run that would go past either stops with status "budget" */
  maxScanCalls: 200,
  stallRounds: 2,        /* rounds in a row with no gain in the aggregate stop the run with status "stalled" */
  maxSpliceIterations: 4,
});

const STATUSES = Object.freeze(['running', 'passed', 'below-bar', 'stalled', 'budget', 'cancelled', 'failed', 'needs-sign-in']);
const ENDED = Object.freeze(['passed', 'below-bar', 'stalled', 'budget', 'cancelled', 'failed', 'needs-sign-in']);

/* The one acknowledgement a run with an external provider needs (the page and the CLI's --yes say it word for word). */
const THIRD_PARTY_ACK = 'third-party-text';
const THIRD_PARTY_TEXT = 'Text leaves this computer: the masked chunks (figures and locked terms replaced by placeholders) go to the rewriter, and the unmasked chunk text goes to the detector. Both are third-party services with their own terms.';

const PLACEHOLDER_PREFIX = 'K';

module.exports = { BARS, LIMITS, STATUSES, ENDED, THIRD_PARTY_ACK, THIRD_PARTY_TEXT, PLACEHOLDER_PREFIX };
