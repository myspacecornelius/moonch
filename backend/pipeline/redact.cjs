'use strict';
/* Pipeline state as a running pilot may see it. A pilot is an agent with a shell on this machine and can reach the companion like any
   other local process, so while ANY round runs every answer that carries pipeline data is passed through redactPipelineData:

     withheld (the key stays, its value becomes { withheld: true }):
       design.prompt, design.guideline, design.goldenAnswer, design.gold, design.fingerprints, design.notes,
       every trap's title, files, mechanism, decoy, correctValue and wrongValue (the id stays, so do the counts),
       the name, reason, hash and sizes of every edited file, and every diff,
       the hashes and sizes in the task's file list and in the pilot packet's (so the one that differs, the edited file, cannot be found),
       design.unscanned (it can name an edited file),
       the calibration and the fairness review of a design, the guideline diff and the rubric changes,
       every pilot's grader reason.
     The same names are withheld wherever they appear, so a field added to the view later is covered. The answer carries redacted: true.

   The server applies it to the response (backend/server.cjs), not to the service's view, so it does not depend on how the view was built. */

const { isObject } = require('./util.cjs');

const MARK = Object.freeze({ withheld: true });
/* Withheld wherever they appear. */
const ANYWHERE = new Set(['gold', 'fingerprints', 'mechanism', 'decoy', 'correctValue', 'wrongValue', 'reason', 'calibration', 'fairness', 'guidelineDiff', 'diff', 'rubricChanges', 'guidelineText', 'goldenAnswerText', 'promptText', 'finalText', 'answer', 'answerText', 'summarySha256', 'approvalSummary', 'sourceDir']);
/* Withheld only directly inside the design object: classification.prompt and classification.guideline are names, not texts. */
const IN_DESIGN = new Set(['prompt', 'guideline', 'goldenAnswer', 'notes', 'unscanned']);
/* Withheld only inside the list of traps (design.traps, attempts[].traps) and the list of edited files. */
const IN_TRAPS = new Set(['title', 'files']);
/* An edited file: its name, and everything that would give the name away by comparison with the task's own file list (its hash and sizes). */
const IN_EDITED = new Set(['name', 'sha256', 'bytes', 'beforeBytes']);
/* The task's file list (import.files) and the pilot packet's (design.packet.files) carry hashes and sizes of the same names. While a round
   runs they are withheld, because the one file whose hash or size differs between the two lists is an edited file. */
const IN_FILE_LISTS = new Set(['sha256', 'bytes']);
const MAX_DEPTH = 24;

function walk(value, key, parentKey, depth) {
  if (depth > MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.map(item => walk(item, key, key, depth + 1));
  if (!isObject(value)) return value;
  const out = {};
  for (const [name, child] of Object.entries(value)) {
    if (ANYWHERE.has(name) || (key === 'design' && IN_DESIGN.has(name)) || (key === 'traps' && IN_TRAPS.has(name)) || (key === 'editedFiles' && IN_EDITED.has(name)) || (key === 'files' && IN_FILE_LISTS.has(name))) out[name] = { ...MARK };
    else out[name] = walk(child, name, key, depth + 1);
  }
  return out;
}

/* One pipeline view, or the list answer ({ pipelines: [...], ... }), or any object built of them. */
function redactPipelineData(value) {
  const out = walk(value, '', '', 0);
  return isObject(out) ? { ...out, redacted: true } : out;
}

module.exports = { redactPipelineData, MARK };
