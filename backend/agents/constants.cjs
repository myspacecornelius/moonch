'use strict';
/* Shared limits and allowlists for the local agent runtime (docs/local-agents.md).
   The server enforces every value here. The browser only displays them. */

const MAX_PILOTS_PER_ROUND = 5;

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-5-5', 'claude-opus-4-8'];
const DEFAULT_MODEL = 'claude-opus-5-5';
/* The model the simulated grader dialog offers first: the writer's grading instrument, the one its calibration against the
   platform's batch was made with. Pilots keep DEFAULT_MODEL. */
const GRADER_MODEL = 'claude-opus-4-8';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_EFFORT = 'medium';

const TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];

const LIMITS = {
  files: 150,
  bytes: 100 * 1024 * 1024,
  depth: 4,
  timeoutMs: 50 * 60 * 1000,
  killGraceMs: 5000,
  /* At most this many pilots of a round run at the same time: the round cap, so a full round runs in one wave and ends
     within one time limit. A round may ask for fewer at a time (config.concurrency), and tests may lower it further. */
  concurrency: MAX_PILOTS_PER_ROUND,
  bodyBytes: 1024 * 1024,
  packetBodyBytes: 256 * 1024,
  graderBatch: 5,
};

/* The spending cap passed to the runtime as --max-budget-usd, in US dollars with at most two decimals. A pilot round
   may choose any amount in [minUsd, maxUsd]; tool-less runs (simulated grader, author review) use their own default. */
const BUDGET_USD = {
  pilotDefault: 3,
  toolLessDefault: 0.5,
  minUsd: 0.05,
  maxUsd: 20,
};

/* The ship bar a writer may freeze with the gold: at least `wrong` wrong answers of `of` runs, whole numbers with
   1 <= wrong <= of <= maxRuns. The Freeze card suggests 5 of 6. */
const SHIP_BAR = { maxRuns: 20, suggestWrong: 5, suggestOf: 6 };

/* The pilot's own runtime configuration folder, inside its scratch folder (<folder>/.tmp/claude-config). The runtime
   keeps large tool outputs there, so they stay inside the pilot folder. */
const PILOT_CONFIG_DIRNAME = 'claude-config';

/* Paths that look like grading or private material: the files the shared rule in package-engine.js (classifyPath) gives
   the evaluator role. A selected file that matches is refused unless the writer overrides that exact file. Not a RegExp:
   the rule is folder first and word bounded (answers/x.csv and Reference_Memo.docx match, Goldman_Comps.xlsx and
   gaf/Reference_Memo.docx do not), so a file the inspection includes by default is never refused. */
const { classifyPath, WITHHELD_ROLES } = require('../../package-engine.js');
const EVALUATOR_PATTERN = { test: rel => classifyPath(rel).role === 'evaluator' };

/* Round, run and folder identifiers. Anything else from a client is refused. */
const ID_RE = /^[a-z0-9-]{4,64}$/;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

module.exports = deepFreeze({
  MAX_PILOTS_PER_ROUND,
  MODELS,
  DEFAULT_MODEL,
  GRADER_MODEL,
  EFFORTS,
  DEFAULT_EFFORT,
  TOOLS,
  LIMITS,
  BUDGET_USD,
  SHIP_BAR,
  PILOT_CONFIG_DIRNAME,
  EVALUATOR_PATTERN,
  WITHHELD_ROLES,
  ID_RE,
});
