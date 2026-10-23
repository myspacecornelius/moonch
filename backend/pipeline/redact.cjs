'use strict';
/* Pipeline state as a running pilot may see it. A pilot is an agent with a shell on this machine and can reach the companion like any
   other local process, so while ANY round runs every answer that carries pipeline data is passed through redactPipelineData:

     withheld (the key stays, its value becomes { withheld: true }):
       design.prompt, design.guideline, design.goldenAnswer, design.gold, design.fingerprints, design.notes,
       every trap's title, files, mechanism, decoy, correctValue and wrongValue (the id stays, so do the counts),
       the name and the reason of every edited file, and every diff,
       the calibration and the fairness review of a design, the guideline diff and the rubric changes,
       every pilot's grader reason.
     The same names are withheld wherever they appear, so a field added to the view later is covered. The answer carries redacted: true.

   The server applies it to the response (backend/server.cjs), not to the service's view, so it does not depend on how the view was built. */

const { isObject } = require('./util.cjs');

const MARK = Object.freeze({ withheld: true });
/* Withheld wherever they appear. */
const ANYWHERE = new Set(['gold', 'fingerprints', 'mechanism', 'decoy', 'correctValue', 'wrongValue', 'reason', 'calibration', 'fairness', 'guidelineDiff', 'diff', 'rubricChanges', 'guidelineText', 'goldenAnswerText', 'promptText', 'finalText', 'answer', 'answerText', 'summarySha256', 'approvalSummary', 'sourceDir']);
/* Withheld only directly inside the design object: classification.prompt and classification.guideline are names, not texts. */
const IN_DESIGN = new Set(['prompt', 'guideline', 'goldenAnswer', 'notes']);
/* Withheld only inside the list of traps (design.traps, attempts[].traps) and the list of edited files. */
const IN_TRAPS = new Set(['title', 'files']);
const IN_EDITED = new Set(['name']);
const MAX_DEPTH = 24;

function walk(value, key, parentKey, depth) {
  if (depth > MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.map(item => walk(item, key, key, depth + 1));
  if (!isObject(value)) return value;
  const out = {};
  for (const [name, child] of Object.entries(value)) {
    if (ANYWHERE.has(name) || (key === 'design' && IN_DESIGN.has(name)) || (key === 'traps' && IN_TRAPS.has(name)) || (key === 'editedFiles' && IN_EDITED.has(name))) out[name] = { ...MARK };
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
