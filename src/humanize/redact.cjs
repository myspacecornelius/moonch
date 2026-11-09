'use strict';
/* What a running pilot may read of a humanize answer: states, numbers and counts, never text. The companion applies this while any round
   of pilots runs (backend/server.cjs), like the pipeline's redaction: a pilot has a shell and can reach the companion like any local
   program. The text being humanized can be grader guidance or a golden answer. */

const WITHHELD = Object.freeze({ withheld: true });

function scrubView(v) {
  if (!v || typeof v !== 'object') return v;
  const out = { ...v, redacted: true };
  if ('final' in out) out.final = WITHHELD;
  if ('brief' in out) out.brief = WITHHELD;
  if (typeof out.error === 'string') out.error = WITHHELD;
  if (Array.isArray(out.log)) out.log = out.log.map(l => ({ at: l.at, round: l.round, pass: l.pass, stage: l.stage, text: WITHHELD }));
  if (Array.isArray(out.chunks)) {
    out.chunks = out.chunks.map(c => ({ ...c, text: WITHHELD, source: WITHHELD, notes: [], passes: (c.passes || []).map(p => ({ ...p, reasons: [] })) }));
  }
  return out;
}

function redactHumanizeData(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value.runs)) return { ...value, redacted: true };
  return scrubView(value);
}

module.exports = { redactHumanizeData, WITHHELD };
