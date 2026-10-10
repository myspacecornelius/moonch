'use strict';
/* Shared limits and allowlists for the local agent runtime (docs/local-agents.md).
   The server enforces every value here. The browser only displays them. */

const MAX_PILOTS_PER_ROUND = 5;

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-5-5'];
const DEFAULT_MODEL = 'claude-opus-5-5';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_EFFORT = 'medium';

const TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];

const LIMITS = {
  files: 150,
  bytes: 100 * 1024 * 1024,
  depth: 4,
  timeoutMs: 50 * 60 * 1000,
  killGraceMs: 5000,
  concurrency: 3,
  bodyBytes: 1024 * 1024,
  packetBodyBytes: 256 * 1024,
  graderBatch: 5,
};

/* File names that look like grading material. A selected file whose relative path matches is refused unless the
   writer overrides that exact file. "reference.solution" accepts a space, underscore or dash between the words. */
const EVALUATOR_PATTERN = /answer|golden|gold|grader|evaluator|rubric|reference.solution|fingerprint|attestation|private/i;

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
  EFFORTS,
  DEFAULT_EFFORT,
  TOOLS,
  LIMITS,
  EVALUATOR_PATTERN,
  ID_RE,
});
