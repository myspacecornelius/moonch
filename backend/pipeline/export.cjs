'use strict';
/* Export: a PRIVATE zip of the final design (package-engine.js writeZip): the new files, the edited world files (each next to the
   reason it was edited), the prompt, the guideline, the golden answer, the traps file and the score table. It holds the guideline and the
   golden answer, so it is for the owner and is never an input of any round. The name is <label>_pipeline_PRIVATE.zip. */

const fs = require('node:fs');
const path = require('node:path');
const { writeZip } = require('../../package-engine.js');
const { sha256Hex, walkFiles, usdText } = require('./util.cjs');

/* A bar as text; an older state has only passBar (the test's). */
const fixed = (bar, fallback) => (typeof bar === 'number' ? bar : typeof fallback === 'number' ? fallback : 0).toFixed(2);
const safeLabel = text => (String(text || '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'pipeline');

/* The freeze records for the README. The statement about the packet is only made when the export holds the manifest it refers to. */
function freezeLines(freezes, manifest) {
  const lines = ['', 'FREEZE RECORD (what was tested, before the pilots ran' + (freezes.length > 1 ? ', and again after each guideline repair' : '') + ')'];
  for (const freeze of freezes) {
    lines.push(
      `- record ${freeze.n} (${freeze.reason}), ${freeze.at}`,
      `  packet sha256 ${freeze.packetSha256} (${freeze.packetFiles} files); prompt ${freeze.promptSha256}`,
      `  guideline ${freeze.guidelineSha256}; golden answer ${freeze.goldenSha256}; answer set ${freeze.answerSetSha256}`,
      `  pilots: ${freeze.pilot.model}, effort ${freeze.pilot.effort}, cap USD ${Number(freeze.pilot.capUsd).toFixed(2)} each; grader: ${freeze.grader.model}, effort ${freeze.grader.effort}; run budget USD ${Number(freeze.budget.totalCapUsd).toFixed(2)}`,
    );
  }
  if (manifest.length) {
    lines.push('', 'The packet the pilots were tested on is byte for byte the packet listed in packet-manifest.json (name, size and sha256 of each file; the packet sha256 above is the sha256 of the lines name, sha256 and size separated by tabs, one per file in name order, joined by new lines). The files under new/ and edited/ in this export are those files, and SHA256SUMS.txt lists the sha256 of every file in this export, so each can be compared with the manifest.');
  }
  return lines;
}

function scoreRows(attempts) {
  const rows = [['attempt', 'stage', 'pilot', 'round', 'run', 'score', 'below_bar', 'counted', 'audit', 'stopped_early']];
  for (const attempt of attempts) {
    for (const stage of [attempt.screen, attempt.test]) {
      if (!stage) continue;
      for (const pilot of stage.pilots) {
        rows.push([attempt.n, stage.name, pilot.id, pilot.round, pilot.run, typeof pilot.score === 'number' ? pilot.score.toFixed(2) : '', pilot.belowBar === null || pilot.belowBar === undefined ? '' : pilot.belowBar ? 'yes' : 'no', pilot.valid ? 'yes' : 'no', pilot.audit ? pilot.audit.status : '', pilot.stoppedEarly ? 'yes' : 'no']);
      }
    }
  }
  return rows;
}

const csv = rows => rows.map(row => row.map(cell => (/[",\n]/.test(String(cell)) ? `"${String(cell).replace(/"/g, '""')}"` : String(cell))).join(',')).join('\n') + '\n';

/* outDir: <private>/pipelines/<id>/attempts/<n>/out. state: the pipeline state (label, stage, attempts, spent, config, and designAttempt:
   the number of the attempt whose design this is). */
function buildExport({ outDir, state, note }) {
  const base = `${safeLabel(state.label)}_pipeline_PRIVATE`;
  const enc = new TextEncoder();
  const entries = [];
  const add = (name, bytes) => entries.push({ name: `${base}/${name}`, bytes: bytes instanceof Uint8Array ? bytes : enc.encode(bytes) });
  const readIf = file => { try { return fs.readFileSync(file); } catch { return null; } };
  const rows = scoreRows(state.attempts);
  const designAttempt = state.attempts.find(attempt => attempt.n === state.designAttempt) || null;
  const freezes = designAttempt && Array.isArray(designAttempt.freeze) ? designAttempt.freeze : [];
  const manifest = Array.isArray(state.manifest) ? state.manifest : [];
  const attemptDir = path.dirname(outDir);
  add('README_PRIVATE.txt', [
    `PRIVATE pipeline export: ${state.label}`,
    '',
    'This folder holds the grader guideline and the golden answer of the final design. Never put it in a pilot packet or upload it where a solver can read it.',
    '',
    `Result: ${state.stage}. ${state.message || ''}`.trim(),
    `Design attempts: ${state.attempts.length} (redesigns used: ${state.redesigns}). Spent: USD ${usdText(state.spentUsd)} of a cap of USD ${usdText(state.config.capUsd)}.`,
    `Bars: a pilot beats the design with a simulated-grader score below the bar of the stage. Screen: both of ${state.config.screenPilots} below ${fixed(state.config.screenBar, state.config.passBar)}. Test: at least ${state.config.testNeed} of ${state.config.testPilots} below ${fixed(state.config.testBar, state.config.passBar)}. A stage stops as soon as its result is decided.`,
    /* The design in this zip is the one that was accepted (designAttempt), which is not always the last attempt: later ones may have been rejected. */
    note ? `Design of attempt ${state.designAttempt === undefined || state.designAttempt === null ? '?' : state.designAttempt}: ${note}` : '',
    '',
    'prompt.txt, guideline.md, golden-answer.md and traps.json are the final design. new/ holds the files added to the world; edited/ holds the world files that were changed (traps.json says why). scores.csv has every pilot score. The simulated grader is a rehearsal, not Studio grading.',
    ...(freezes.length ? freezeLines(freezes, manifest) : []),
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
  /* Designer v2: the brief, the answers that must grade, the review record and the freeze records, and the packet as it was tested. */
  for (const name of ['brief.json']) {
    const bytes = readIf(path.join(outDir, name));
    if (bytes) add(name, bytes);
  }
  const answersDir = path.join(outDir, 'answers');
  if (fs.existsSync(answersDir)) for (const file of walkFiles(answersDir, { maxFiles: 50, depth: 3 }).files) add(`answers/${file.rel}`, fs.readFileSync(file.abs));
  for (const name of ['fairness.json', ...freezes.map(freeze => `freeze-${freeze.n}.json`)]) {
    const bytes = readIf(path.join(attemptDir, name));
    if (bytes) add(name, bytes);
  }
  if (freezes.length) add('packet-manifest.json', JSON.stringify(manifest.map(file => ({ name: file.name, bytes: file.bytes, sha256: file.sha256 })), null, 2) + '\n');
  add('scores.csv', csv(rows));
  add('scores.json', JSON.stringify(state.attempts.map(attempt => ({ attempt: attempt.n, outcome: attempt.outcome, validation: attempt.validation, screen: attempt.screen, test: attempt.test, fairness: attempt.fairness, difficulty: attempt.difficulty })), null, 2) + '\n');
  /* The sha256 of every file in this export (SHA256SUMS.txt itself excepted), so that what was shipped can be compared with what was tested. */
  if (freezes.length) add('SHA256SUMS.txt', entries.map(entry => `${sha256Hex(entry.bytes)}  ${entry.name.slice(base.length + 1)}`).join('\n') + '\n');
  const bytes = writeZip(entries);
  return { name: `${safeLabel(state.label)}_pipeline_PRIVATE.zip`, bytes, sha256: sha256Hex(bytes), files: entries.map(entry => ({ path: entry.name.slice(base.length + 1), bytes: entry.bytes.length })) };
}

module.exports = { buildExport, safeLabel };
