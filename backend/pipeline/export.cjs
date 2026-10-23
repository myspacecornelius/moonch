'use strict';
/* Export: a PRIVATE zip of the final design (package-engine.js writeZip): the new files, the edited world files (each next to the
   reason it was edited), the prompt, the guideline, the golden answer, the traps file and the score table. It holds the guideline and the
   golden answer, so it is for the owner and is never an input of any round. The name is <label>_pipeline_PRIVATE.zip. */

const fs = require('node:fs');
const path = require('node:path');
const { writeZip } = require('../../package-engine.js');
const { sha256Hex, walkFiles } = require('./util.cjs');

const safeLabel = text => (String(text || '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'pipeline');

function scoreRows(attempts) {
  const rows = [['attempt', 'stage', 'pilot', 'round', 'run', 'score', 'below_bar', 'counted', 'audit']];
  for (const attempt of attempts) {
    for (const stage of [attempt.screen, attempt.test]) {
      if (!stage) continue;
      for (const pilot of stage.pilots) {
        rows.push([attempt.n, stage.name, pilot.id, pilot.round, pilot.run, typeof pilot.score === 'number' ? pilot.score.toFixed(2) : '', pilot.belowBar === null || pilot.belowBar === undefined ? '' : pilot.belowBar ? 'yes' : 'no', pilot.valid ? 'yes' : 'no', pilot.audit ? pilot.audit.status : '']);
      }
    }
  }
  return rows;
}

const csv = rows => rows.map(row => row.map(cell => (/[",\n]/.test(String(cell)) ? `"${String(cell).replace(/"/g, '""')}"` : String(cell))).join(',')).join('\n') + '\n';

/* outDir: <private>/pipelines/<id>/attempts/<n>/out. state: the pipeline state (label, stage, attempts, spent, config). */
function buildExport({ outDir, state, note }) {
  const base = `${safeLabel(state.label)}_pipeline_PRIVATE`;
  const enc = new TextEncoder();
  const entries = [];
  const add = (name, bytes) => entries.push({ name: `${base}/${name}`, bytes: bytes instanceof Uint8Array ? bytes : enc.encode(bytes) });
  const readIf = file => { try { return fs.readFileSync(file); } catch { return null; } };
  const rows = scoreRows(state.attempts);
  const lastAttempt = state.attempts[state.attempts.length - 1];
  add('README_PRIVATE.txt', [
    `PRIVATE pipeline export: ${state.label}`,
    '',
    'This folder holds the grader guideline and the golden answer of the final design. Never put it in a pilot packet or upload it where a solver can read it.',
    '',
    `Result: ${state.stage}. ${state.message || ''}`.trim(),
    `Design attempts: ${state.attempts.length} (redesigns used: ${state.redesigns}). Spent: USD ${state.spentUsd.toFixed(2)} of a cap of USD ${state.config.capUsd.toFixed(2)}.`,
    `Bar: a pilot beats the design with a simulated-grader score below ${state.config.passBar}. Screen: both of ${state.config.screenPilots}. Test: at least ${state.config.testNeed} of ${state.config.testPilots}.`,
    note ? `Design of attempt ${lastAttempt ? lastAttempt.n : '?'}: ${note}` : '',
    '',
    'prompt.txt, guideline.md, golden-answer.md and traps.json are the final design. new/ holds the files added to the world; edited/ holds the world files that were changed (traps.json says why). scores.csv has every pilot score. The simulated grader is a rehearsal, not Studio grading.',
    '',
  ].join('\n'));
  for (const name of ['prompt.txt', 'guideline.md', 'golden-answer.md', 'traps.json']) {
    const bytes = readIf(path.join(outDir, name));
    if (bytes) add(name, bytes);
  }
  for (const sub of ['new', 'edited']) {
    const dir = path.join(outDir, sub);
    if (!fs.existsSync(dir)) continue;
    for (const file of walkFiles(dir, { maxFiles: 500, depth: 6 }).files) add(`${sub}/${file.rel}`, fs.readFileSync(file.abs));
  }
  add('scores.csv', csv(rows));
  add('scores.json', JSON.stringify(state.attempts.map(attempt => ({ attempt: attempt.n, outcome: attempt.outcome, screen: attempt.screen, test: attempt.test })), null, 2) + '\n');
  const bytes = writeZip(entries);
  return { name: `${safeLabel(state.label)}_pipeline_PRIVATE.zip`, bytes, sha256: sha256Hex(bytes), files: entries.map(entry => ({ path: entry.name.slice(base.length + 1), bytes: entry.bytes.length })) };
}

module.exports = { buildExport, safeLabel };
