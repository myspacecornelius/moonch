const {test} = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const M = require('../ideas-model.js'), C = require('../core.js'), E = require('../package-engine.js');
/* Synthetic fixtures only: invented archetypes, invented precedent rows, invented packages (Atlas, Meridian, Borealis). The real archetype catalog is
   used by the integration tests at the bottom when idea-archetypes.js is present. No private workbook content is read or written here. */
const REAL_PATH = path.join(__dirname, '..', 'idea-archetypes.js');
const REAL = fs.existsSync(REAL_PATH) ? require(REAL_PATH) : null;
const digest = s => crypto.createHash('sha256').update(s).digest('hex');
const deepFreeze = v => { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); Object.values(v).forEach(deepFreeze); } return v; };
const copy = v => JSON.parse(JSON.stringify(v));
const seeded = seed => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

/* ---------- invented archetypes (generic; signals use public finance vocabulary) ---------- */
const arche = (n, o) => ({
  id: 'ia-' + String(n).padStart(2, '0'), name: 'Archetype ' + n, kind: 'base-or-definition', mechanism: 'metric_basis',
  summary: 'A generic summary for archetype ' + n + '.', whyItHolds: 'The governing text fixes one reading, so the other reading gives a different figure that still looks plausible.',
  buildMoves: ['Add a second schedule that states the figure on another basis.', 'Let that figure feed the headline recommendation.'],
  wrongApproach: 'use the convenient figure without testing it against the governing text', correctTreatment: 'restate the figure to the governing text and show the other figure as a reconciling item',
  detection: 'compare each headline figure with the clause that governs it', consequence: 'the headline carries the convenient figure and the decision rests on an unsupported amount',
  howSolversGoWrong: ['take the first figure that matches the label'], needs: ['a governing clause', 'a second figure that disagrees'],
  signals: {terms: [], regex: []}, workflowHints: ['reporting'], lead: false, supporting: false, causalGroup: 'cg-ia-' + String(n).padStart(2, '0'), ...o
});
const ARCHETYPES = [
  arche(1, {name: 'Gross and net figures mixed in one ratio', kind: 'base-or-definition', mechanism: 'metric_basis', summary: 'A ratio divides a net amount by a gross base, so one label hides two definitions.', signals: {terms: ['gross margin', 'net margin', 'denominator', 'definition', 'basis'], regex: ['\\b(?:gross|net)\\s+(?:of|to)\\s+(?:tax|fees)\\b']}, workflowHints: ['ratio', 'reporting']}),
  arche(2, {name: 'A later amendment replaces an earlier schedule', kind: 'source-conflict', mechanism: 'contract_conditions', lead: true, summary: 'An amendment with a later effective date supersedes the schedule that stays in the folder.', signals: {terms: ['amendment', 'supersede', 'effective date', 'restated'], regex: ['\\bamended and restated\\b']}, workflowHints: ['pricing', 'contract']}),
  arche(3, {name: 'Cut-off moved by one day', kind: 'timing-or-date', mechanism: 'period_alignment', summary: 'A period boundary moves by one day and a payment falls into the other period.', signals: {terms: ['cut off', 'cutoff', 'month end', 'period end', 'closing date'], regex: []}, workflowHints: ['close']}),
  arche(4, {name: 'Reconciling item missing from a bridge', kind: 'arithmetic-or-structure', mechanism: 'cross_document_bridge', summary: 'A bridge between two documents omits one reconciling item.', signals: {terms: ['reconcil', 'bridge', 'roll forward', 'opening balance'], regex: [], needsAll: ['bridge']}, workflowHints: ['bridge']}),
  arche(5, {name: 'Rounded inputs feed a rounded total', kind: 'arithmetic-or-structure', mechanism: 'rounding_calibration', summary: 'The inputs are shown rounded and the total is rebuilt from the rounded values.', signals: {terms: ['rounded', 'rounding', 'nearest'], regex: [], negative: ['unrounded']}}),
  arche(6, {name: 'Table kept finer than the summary', kind: 'scope-or-classification', mechanism: 'table_grain', summary: 'A detail table is kept at a finer grain than the summary that cites it.', signals: {terms: ['by region', 'by entity', 'subtotal', 'grand total'], regex: []}}),
  arche(7, {name: 'Group perimeter shifts between schedules', kind: 'scope-or-classification', mechanism: 'entity_perimeter', summary: 'The group boundary differs between two schedules.', signals: {terms: ['subsidiary', 'consolidat', 'perimeter', 'affiliate'], regex: []}}),
  arche(8, {name: 'A working input held on a hidden sheet', kind: 'instruction-or-presentation', mechanism: 'dynamic_workbook', supporting: true, summary: 'A live input sits on a hidden sheet while the visible sheet shows a pasted copy.', signals: {terms: ['hidden sheet', 'named range', 'external link'], regex: []}})
];
deepFreeze(ARCHETYPES);
const CATALOG = deepFreeze({version: 1, archetypes: copy(ARCHETYPES), kinds: []});

/* ---------- invented precedent rows (a CSV with the five columns the reader looks for) ---------- */
/* Header names are matched without regard to case, so the fixtures write them in lower case. */
const HEADER = ['workflow', 'trap name', 'what the writer built', 'how the model fell', 'mean score'];
const ROWS = [
  ['Atlas Reporting', 'Gross margin read against a net denominator', 'Two columns share the label "margin", one gross and one net, and the ratio feeds the headline.', 'The solver took the first matching column and never read the definition note.', '0.250'],
  ['Meridian Close', 'Amendment signed after the schedule', 'An amendment with a later effective date supersedes the pricing schedule, which stays in the folder.', 'The solver kept the superseded schedule as the base.', '0.125'],
  ['Meridian Close', 'Month end cut off moved by a day', 'First line, with a comma.\nSecond line with "quotes" and a trailing "note".', 'The closing date moved and the payment landed in the other period.', '0.5'],
  ['Borealis Treasury', 'Bridge missing a reconciling item', 'Windows style\r\nline break inside a cell, plus a reconciling item that is not in the bridge.', 'The solver reconciled to the wrong opening balance.', '0.250'],
  ['Borealis Treasury', 'Rounded inputs rebuilt into a total', 'The figures are shown rounded to the nearest thousand, and the total is rebuilt from them.', 'The total drifted by the rounding amount.', '0.0625'],
  ['Borealis Pricing', 'Rows summed twice', 'The detail table lists a subtotal row that also sits in the grand total.', 'The subtotal was added to the grand total.', 'n/a']
];
const quoteField = (v, all) => { v = String(v); return all || /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const toCsv = (table, {nl = '\r\n', all = false, bom = false, trailing = true} = {}) => (bom ? '\ufeff' : '') + table.map(r => r.map(v => quoteField(v, all)).join(',')).join(nl) + (trailing ? nl : '');
const CSV = toCsv([HEADER, ...ROWS]);
const LIB = () => M.parseLibraryCsv(CSV);

/* ---------- invented packages in the package-engine shape ---------- */
const doc = (name, kind, records, extra = {}) => ({id: 'doc-' + digest(name).slice(0, 10), name, bytes: 100, sha256: digest(name + JSON.stringify(records.length)), role: 'source', roleBasis: 'fixture', status: 'extracted', kind, records, metadata: {}, warnings: [], ...extra});
const txt = (name, lines, extra) => doc(name, 'txt', lines.map((t, i) => ({locator: 'Line ' + (i + 1), text: t})), extra);
const csv = (name, rows, extra) => doc(name, 'csv', rows.map((v, i) => ({locator: 'Row ' + (i + 1), text: v.join(' | '), values: v})), extra);
const cell = (sheet, ref, value, extra = {}) => ({locator: sheet + '!' + ref, text: String(value), sheet, cell: ref, value: String(value), type: 'n', formula: '', hasFormula: false, formulaType: '', cachePresent: true, hidden: false, context: '', ...extra});
const xlsx = (name, records, extra) => doc(name, 'xlsx', records, extra);
const pkg = (documents, title = 'Atlas fixture') => ({schemaVersion: 1, kind: 'finance-task-package', id: 'package-fixture', title, fingerprint: digest(documents.map(d => d.name + d.sha256).sort().join('\n')), documents});
const SUMMARY = () => txt('Atlas_Summary.txt', ['Management summary: gross margin and net margin are shown by entity.', 'The amendment has an effective date of 2026-03-01 and supersedes schedule 2.', 'The totals are rounded to the nearest thousand.']);
const FACTS = () => csv('Cash_Facts.csv', [['label', 'value'], ['Opening balance', '100'], ['Bridge item', '50'], ['Payments due', '1850']]);
const MODEL = () => xlsx('Atlas_Model.xlsx', [cell('Bridge', 'A3', 'Reconciling item to bridge', {type: 's'}), cell('Bridge', 'B3', 120, {context: 'Reconciling item to bridge'}), cell('Staging', 'A1', 'Hidden sheet input', {type: 's', hidden: true}), cell('Staging', 'B7', 42)]);
const NOTES = () => txt('Grader_Notes.txt', ['The answer key says the amendment supersedes the schedule, the cut off moved, rounding applies and the hidden sheet input is live.'], {role: 'evaluator'});
const RUNLOG = () => txt('Run_Log.txt', ['subsidiary perimeter and consolidated group; cut off at month end'], {role: 'run-evidence'});
const AUDITED = () => txt('Audit_Review.txt', ['external link to a named range on a hidden sheet'], {role: 'audit'});
const PROMPT = () => txt('Task_Request.txt', ['Please update the bridge and recommend whether the payment can proceed.'], {role: 'prompt'});
const PKG = () => pkg([SUMMARY(), FACTS(), MODEL(), NOTES(), RUNLOG(), AUDITED(), PROMPT()]);
/* C.blank() is a trap ledger now. These fixtures keep the failure-mode set, whose net-new slots the earlier tests count; TRAP_PROJECT is the trap ledger. */
const PROJECT = (roots = [], framework = 'failure-mode-set') => ({...C.blank(), framework, title: 'Atlas project', roots: roots.map((r, i) => ({...C.root(), id: 'root-' + i, causalGroup: 'cg-' + i, ...r}))});
const TRAP_PROJECT = roots => PROJECT(roots, 'trap-ledger');

/* Every string a model call emits, except the user's own data shown as a quote (a recorded score cell, package quotes, file names, locators, current mode titles). The words of a precedent are checked like any other generated text. */
const USER_PATHS = /(?:^|\.)(?:precedents\.\d+\.scoreText|lowestScoreText|applicability\.\d+\.(?:documentName|locator|quote)|overlapWith\.\d+\.title|overlapWith\.\d+\.modeId|overlapWith\.\d+\.rootId)$/;
function generatedStrings(value, p = '', out = []) {
  if (typeof value === 'string') { if (!USER_PATHS.test(p)) out.push([p, value]); }
  else if (Array.isArray(value)) value.forEach((x, i) => generatedStrings(x, p ? p + '.' + i : String(i), out));
  else if (value && typeof value === 'object') for (const [k, x] of Object.entries(value)) generatedStrings(x, p ? p + '.' + k : k, out);
  return out;
}
const FORBIDDEN_TEXT = /%|\b(?:pass|success|failure) rate\b|\blikely to\b|\bcaught\b|\[hypothesis: edit before use\]/i;
const assertClean = (value, label) => { for (const [p, s] of generatedStrings(value)) assert.ok(!FORBIDDEN_TEXT.test(s), (label || 'output') + ' ' + p + ' contains forbidden text: ' + s.slice(0, 80)); };

/* ---------- the exact interface strings ---------- */
const HOLD = 'needs-evidence';
test('TEXT carries the exact interface strings and status words', () => {
  /* Pinned by the SHA-256 of the spec text, so the exact wording is checked without repeating it in this file. */
  assert.equal(digest(M.TEXT.orderingFootnote), 'd2890db658f59b7701d7b228390a7af5e003ca1da3a59406e19dd568287bf477');
  assert.equal(digest(M.TEXT.noLibrary), '3049c039d83ab9fba299977301fbf7436ee52625e7c471be48d47176ef22ff2f');
  assert.equal(digest(M.TEXT.privacy), '9164a46e6ddf331f38c35cb9f70f36c01469f199a5fdc1d7610799103dcb61fd');
  assert.equal(digest(M.TEXT.honesty), '3f261dc89a4222a7078c67f6346b3db2113dbe4e8088f058fc93a8b127a998cf');
  assert.equal(digest(JSON.stringify(M.TEXT.statusWords)), '617bf53993b9dbbe7db092acf26be19402c6aaf0784c632762d001a1337f9335');
  assert.deepEqual(Object.keys(M.TEXT), ['orderingFootnote', 'noLibrary', 'privacy', 'honesty', 'statusWords']);
  assert.ok(Object.isFrozen(M.TEXT) && Object.isFrozen(M.TEXT.statusWords));
  assert.deepEqual(Object.keys(M).sort(), ['TEXT', 'VERSION', 'buildIdeas', 'coverage', 'detectApplicability', 'displayText', 'labelRows', 'lintIdea', 'parseLibraryCsv', 'retrieve', 'toAuthoringProject']);
});

/* ---------- CSV ---------- */
test('parseLibraryCsv reads the export shape: quoted commas, doubled quotes, LF and CRLF inside quotes, verbatim score text', () => {
  const out = LIB();
  assert.equal(out.rows.length, ROWS.length);
  assert.deepEqual(out.columns, {workflow: 0, trap: 1, built: 2, fell: 3, score: 4, count: 5});
  assert.deepEqual(out.rejected, []);
  out.rows.forEach((r, i) => {
    assert.equal(r.id, 'p-' + String(i + 1).padStart(4, '0'));
    assert.deepEqual([r.workflow, r.trap, r.built, r.fell, r.scoreText], ROWS[i]);
  });
  assert.equal(out.rows[2].built, 'First line, with a comma.\nSecond line with "quotes" and a trailing "note".');
  assert.equal(out.rows[3].built, 'Windows style\r\nline break inside a cell, plus a reconciling item that is not in the bridge.');
  assert.deepEqual(out.rows.map(r => r.score), [0.25, 0.125, 0.5, 0.25, 0.0625, null]);
  assert.equal(out.rows[0].scoreText, '0.250', 'the cell is shown as written, never reformatted');
  assert.deepEqual(Object.keys(out.rows[0]), ['id', 'workflow', 'trap', 'built', 'fell', 'score', 'scoreText']);
  assert.equal(out.hash, digest(CSV));
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /^Line 9: the score is not a plain number/, 'physical line, counting the two lines inside quoted cells');
  assert.equal(out.rows[5].scoreText, 'n/a');
});
test('parseLibraryCsv: LF, CR, CRLF, quote-everything, BOM and a missing final newline all give the same rows', () => {
  const base = LIB().rows;
  for (const opts of [{nl: '\n'}, {nl: '\r'}, {all: true}, {all: true, nl: '\n'}, {bom: true}, {trailing: false}, {nl: '\r', bom: true, all: true, trailing: false}]) {
    const out = M.parseLibraryCsv(toCsv([HEADER, ...ROWS], opts));
    assert.deepEqual(out.rows, base, JSON.stringify(opts));
    assert.deepEqual(out.rejected, []);
  }
  assert.notEqual(M.parseLibraryCsv('\ufeff' + CSV).hash, M.parseLibraryCsv(CSV).hash, 'the hash is of the text as passed in');
  const quotedFirst = M.parseLibraryCsv('\ufeff"workflow, as named",trap,built,score\r\nAtlas,a trap,b,0.5\r\n');
  assert.deepEqual([quotedFirst.columns.trap, quotedFirst.columns.score, quotedFirst.columns.count, quotedFirst.rows.length], [1, 3, 4, 1], 'a quoted first header cell is still quoted after the byte order mark');
});
test('parseLibraryCsv: header aliases are case, space and punctuation insensitive and may be reordered', () => {
  const variants = [
    [['task workflow', 'failure mode', 'description', 'grader', 'mean'], [0, 1, 2, 3, 4]],
    [['workflow', 'trap name', 'writer', 'how the model fell', 'score'], [0, 1, 2, 3, 4]],
    [['WORKFLOW', 'TRAP NAME', 'WRITER', 'HOW THE MODEL FELL', 'MEAN SCORE'], [0, 1, 2, 3, 4]],
    [['  workflow ', 'trap_name', 'what-the-writer-built', 'how-the-model-fell', 'mean-score'], [0, 1, 2, 3, 4]],
    [['score', 'trap', 'workflow', 'grader', 'writer'], [2, 1, 4, 3, 0]]
  ];
  for (const [header, at] of variants) {
    const {columns} = M.parseLibraryCsv(header.join(',') + '\n');
    assert.deepEqual([columns.workflow, columns.trap, columns.built, columns.fell, columns.score], at, header.join('|'));
  }
  const out = M.parseLibraryCsv('score,trap,workflow,grader,writer\r\n0.75,a trap,w,fell text,built text\r\n');
  assert.deepEqual(out.rows[0], {id: 'p-0001', workflow: 'w', trap: 'a trap', built: 'built text', fell: 'fell text', score: 0.75, scoreText: '0.75'});
});
test('parseLibraryCsv: junk rows are rejected with a line number, blank rows are skipped, bad scores are kept with their text', () => {
  const text = 'workflow,trap,built,fell,score\n' +
    'Atlas,First trap,"two\nlines",fell,0.3\n' +
    '\n' +
    ',,,,\n' +
    'Atlas,,built but no title,fell,0.2\n' +
    'Atlas,Short row\n' +
    'Atlas,Long row,b,f,0.1,extra,cells\n' +
    'Atlas,Percent score,b,f,36.5%\n' +
    'Atlas,Empty score,b,f,\n' +
    'Atlas,Exponent score,b,f,1e-3\n';
  const out = M.parseLibraryCsv(text);
  assert.deepEqual(out.rejected, [{line: 6, reason: 'No trap title.'}], 'line 6 follows a two-line quoted cell');
  assert.deepEqual(out.rows.map(r => r.trap), ['First trap', 'Short row', 'Long row', 'Percent score', 'Empty score', 'Exponent score']);
  assert.deepEqual(out.rows.map(r => r.score), [0.3, null, 0.1, null, null, null]);
  assert.deepEqual(out.rows.map(r => r.scoreText), ['0.3', '', '0.1', '36.5%', '', '1e-3']);
  assert.equal(out.rows[1].built, '', 'a short row is padded with empty text');
  assert.equal(out.warnings.filter(w => /score is not a plain number/.test(w)).length, 4, 'every unparseable score is listed, none is rejected');
  assert.ok(out.warnings.every(w => !w.includes('%')), 'a warning never repeats the cell text');
});
test('parseLibraryCsv: never throws on bad content, throws a clear error on a non-string or an oversize text', () => {
  for (const bad of ['', '\n\n', 'workflow,trap\n', 'just one line', '"unclosed', 'a,b\n"never closed']) {
    const out = M.parseLibraryCsv(bad);
    assert.ok(Array.isArray(out.rows) && Array.isArray(out.rejected) && Array.isArray(out.warnings), JSON.stringify(bad));
  }
  assert.equal(M.parseLibraryCsv('').rows.length, 0);
  assert.match(M.parseLibraryCsv('workflow,built\nAtlas,text\n').warnings[0], /No trap column/);
  assert.equal(M.parseLibraryCsv('workflow,built\nAtlas,text\n').rows.length, 0);
  const unclosed = M.parseLibraryCsv('workflow,trap\nAtlas,"never closed');
  assert.equal(unclosed.rows.length, 0, 'a row that swallows the rest of the file is not a precedent');
  assert.deepEqual(unclosed.rejected, [{line: 2, reason: 'A quote was never closed, so the rest of the file was read as one cell.'}]);
  const noScore = M.parseLibraryCsv('workflow,trap\nAtlas,only a trap\n');
  assert.deepEqual([noScore.rows[0].score, noScore.rows[0].scoreText], [null, '']);
  assert.ok(noScore.warnings.some(w => /No score column/.test(w)));
  for (const bad of [null, undefined, 42, {}, [], Buffer.from('a,b')]) assert.throws(() => M.parseLibraryCsv(bad), /must be read as text/);
  assert.throws(() => M.parseLibraryCsv('x'.repeat(100), {maxBytes: 50}), /larger than 50 bytes/);
  assert.throws(() => M.parseLibraryCsv('\u20ac'.repeat(20), {maxBytes: 50}), /larger than/, 'the limit is in UTF-8 bytes, not characters');
  assert.doesNotThrow(() => M.parseLibraryCsv('\u20ac'.repeat(10), {maxBytes: 50}));
});
test('parseLibraryCsv: row cap and cell cap are reported, not silent', () => {
  const many = 'workflow,trap\n' + Array.from({length: 10}, (_, i) => 'Atlas,trap ' + i).join('\n');
  const capped = M.parseLibraryCsv(many, {maxRows: 3});
  assert.equal(capped.rows.length, 3);
  assert.ok(capped.warnings.includes('Only the first 3 rows were read.'));
  const longCell = M.parseLibraryCsv('workflow,trap,built\nAtlas,a trap,' + 'x'.repeat(5000) + '\n');
  assert.equal(longCell.rows[0].built.length, 4000);
  assert.ok(longCell.warnings.some(w => /cut at 4000 characters/.test(w)));
  const rejected = M.parseLibraryCsv('workflow,trap\n' + 'Atlas,\n'.repeat(700));
  assert.equal(rejected.rejected.length, 500);
  assert.ok(rejected.warnings.some(w => /200 more rows had no trap title/.test(w)));
});
test('parseLibraryCsv: a quote that is never closed is reported with its line, and the rows before it are kept', () => {
  const rows = Array.from({length: 600}, (_, i) => ['Atlas ' + (i % 7), 'trap ' + i, 'built', 'fell', '0.5']);
  const stray = toCsv([HEADER, ...rows]).replace(',trap 99,', ',"trap 99,');
  assert.ok(stray.includes(',"trap 99,'));
  const out = M.parseLibraryCsv(stray);
  assert.equal(out.rows.length, 99, 'rows before the stray quote are read');
  assert.equal(out.rejected.length, 1);
  assert.deepEqual(out.rejected[0], {line: 101, reason: 'A quote was never closed, so the rest of the file was read as one cell.'});
  const short = M.parseLibraryCsv('workflow,trap,score\r\nAtlas,"trap one,b,0.3\r\nAtlas,trap2,0.4\r\nAtlas,trap3,0.5\r\n');
  assert.equal(short.rows.length, 0);
  assert.equal(short.rejected.length, 1, 'a short file says so too, not only a long one');
  assert.match(short.rejected[0].reason, /never closed/);
  const balanced = M.parseLibraryCsv('workflow,trap,score\r\nAtlas,"trap, one",0.3\r\nAtlas,"say ""hi""",0.4\r\n');
  assert.deepEqual([balanced.rows.length, balanced.rejected.length], [2, 0], 'quotes that close are not affected');
});
test('parseLibraryCsv: a header cell that holds a comma and is quoted still names its column', () => {
  const out = M.parseLibraryCsv('workflow,trap name,"mean score, as graded"\r\nAtlas,a trap,0.4\r\n');
  assert.deepEqual([out.columns.workflow, out.columns.trap, out.columns.score, out.columns.count], [0, 1, 2, 3]);
  assert.equal(out.rows[0].scoreText, '0.4');
});
test('parseLibraryCsv: hash is the real SHA-256 of the UTF-8 text', () => {
  for (const text of ['', 'a', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(65), 'e\u0301\u20ac \ud83d\ude00 mixed', CSV]) assert.equal(M.parseLibraryCsv(text).hash, digest(text));
});
test('parseLibraryCsv property: random quoted and unquoted fields round trip exactly', () => {
  const rnd = seeded(20260929), pick = list => list[Math.floor(rnd() * list.length)];
  const atoms = ['alpha', 'beta ', ', ', '"', '""', '\n', '\r\n', '\r', ' ', 'x', '\u00e9', '\u20ac', '\u65e5\u672c', ';', 'a,b', '"quoted"', '0.5', '=', '\t'];
  const field = (allowEmpty) => { let s = ''; const n = Math.floor(rnd() * 6); for (let i = 0; i < n; i++) s += pick(atoms); s = s.trim(); return s || (allowEmpty ? '' : 'filler'); };
  for (let round = 0; round < 250; round++) {
    const rows = Array.from({length: 1 + Math.floor(rnd() * 6)}, () => [field(true), field(false), field(true), field(true), pick(['0.5', '.25', '1', '0.0625', '17', 'n/a', '', '36%'])]);
    const opts = {nl: pick(['\n', '\r\n', '\r']), all: rnd() < 0.3, bom: rnd() < 0.2, trailing: rnd() < 0.7};
    const out = M.parseLibraryCsv(toCsv([HEADER, ...rows], opts));
    assert.equal(out.rows.length, rows.length, 'round ' + round);
    assert.deepEqual(out.rejected, []);
    rows.forEach((r, i) => assert.deepEqual([out.rows[i].workflow, out.rows[i].trap, out.rows[i].built, out.rows[i].fell, out.rows[i].scoreText], r, 'round ' + round + ' row ' + i + ' ' + JSON.stringify(opts)));
  }
});
test('parseLibraryCsv: 900 rows and a 5 MB text parse quickly', () => {
  const rnd = seeded(7), words = 'revenue cost margin schedule agreement clause amount balance period entity summary detail rate base price volume forecast'.split(' ');
  const sentence = n => Array.from({length: n}, () => words[Math.floor(rnd() * words.length)]).join(' ');
  const rows = Array.from({length: 900}, (_, i) => ['Atlas ' + (i % 20), sentence(8), sentence(150) + ', "quoted"\n' + sentence(40), sentence(120), (Math.round(rnd() * 700) / 1000).toFixed(3)]);
  const text = toCsv([HEADER, ...rows]);
  let t = Date.now();
  const out = M.parseLibraryCsv(text);
  assert.equal(out.rows.length, 900);
  assert.ok(Date.now() - t < 2000, 'parse took ' + (Date.now() - t) + ' ms');
  const big = 'workflow,trap,built\n' + 'Atlas,a trap title,"some, quoted ""text"" here"\n'.repeat(110000);
  assert.ok(big.length > 5e6 - 1e6);
  t = Date.now();
  const bigOut = M.parseLibraryCsv(big + 'Atlas,tail,x\n'.repeat(1), {maxBytes: 6e6, maxRows: 200000});
  assert.equal(bigOut.rows.length, 110001);
  assert.ok(Date.now() - t < 3000, 'large parse took ' + (Date.now() - t) + ' ms');
  assert.throws(() => M.parseLibraryCsv(big + big), /larger than/);
});

/* ---------- labelling ---------- */
test('labelRows labels a row only for a clear winner and says so honestly otherwise', () => {
  const rows = LIB().rows, {labels, coverage} = M.labelRows(rows, ARCHETYPES);
  assert.equal(labels['p-0001'].archetypeId, 'ia-01');
  assert.ok(labels['p-0001'].matched.includes('gross margin') && labels['p-0001'].matched.includes('denominator'));
  assert.equal(labels['p-0002'].archetypeId, 'ia-02');
  assert.equal(labels['p-0003'].archetypeId, 'ia-03');
  assert.equal(labels['p-0004'].archetypeId, 'ia-04');
  assert.equal(labels['p-0005'].archetypeId, 'ia-05');
  assert.equal(labels['p-0006'].archetypeId, 'ia-06');
  assert.equal(coverage.labelled + coverage.unlabelled, rows.length);
  assert.equal(coverage.labelled, 6);
  const mixed = [{id: 'p-9001', workflow: '', trap: 'Plain wording with nothing in it', built: 'No match here either', fell: 'none', score: null, scoreText: ''}];
  assert.deepEqual(M.labelRows(mixed, ARCHETYPES).labels['p-9001'], {archetypeId: null, matched: []});
  const tie = [{id: 'p-9002', workflow: '', trap: 'amendment and cut off', built: '', fell: '', score: null, scoreText: ''}];
  assert.equal(M.labelRows(tie, ARCHETYPES).labels['p-9002'].archetypeId, null, 'two archetypes with the same weight: no margin, no label');
  const near = [{id: 'p-9003', workflow: '', trap: 'amendment', built: 'a cut off', fell: '', score: null, scoreText: ''}];
  assert.equal(M.labelRows(near, ARCHETYPES).labels['p-9003'].archetypeId, 'ia-02', 'a trap-title hit outweighs a body hit');
  assert.equal(M.labelRows(near, ARCHETYPES).labels['p-9003'].runnerUp, 'ia-03');
});
test('labelRows honours needsAll, negative, regex signals and the minimum weight', () => {
  const row = (id, trap, built = '', fell = '') => ({id, workflow: '', trap, built, fell, score: null, scoreText: ''});
  const out = M.labelRows([
    row('p-1', 'Reconciling item left out', 'a reconciling item'),
    row('p-2', 'Reconciling item left out of the bridge'),
    row('p-3', 'Rounded inputs', 'unrounded totals are rounded later'),
    row('p-4', 'Rounded inputs rebuilt'),
    row('p-5', 'Cost treatment', 'The margin is quoted gross of fees.'),
    row('p-6', 'Weak', 'one body mention of a bridge'),
    row('p-7', 'Cut off', '', 'moved')
  ], ARCHETYPES).labels;
  assert.equal(out['p-1'].archetypeId, null, 'needsAll: no "bridge" anywhere');
  assert.equal(out['p-2'].archetypeId, 'ia-04');
  assert.equal(out['p-3'].archetypeId, null, 'negative term present');
  assert.equal(out['p-4'].archetypeId, 'ia-05');
  assert.deepEqual(out['p-5'], {archetypeId: null, matched: []}, 'a single regex hit in the body is below the minimum');
  assert.equal(out['p-6'].archetypeId, null);
  assert.equal(out['p-7'].archetypeId, 'ia-03');
  const rx = M.labelRows([row('p-8', 'Gross of tax', 'a note on gross of tax figures', 'gross of fees')], ARCHETYPES).labels['p-8'];
  assert.equal(rx.archetypeId, 'ia-01');
  assert.deepEqual(rx.matched, ['pattern 1']);
});
test('labelRows is deterministic, pure and accepts the catalog object or its array', () => {
  const rows = deepFreeze(LIB().rows), a = M.labelRows(rows, CATALOG), b = M.labelRows(rows, ARCHETYPES);
  assert.deepEqual(a, b);
  assert.deepEqual(a, M.labelRows(copy(rows), copy(ARCHETYPES)));
  assert.equal(JSON.stringify(a), JSON.stringify(M.labelRows(rows, ARCHETYPES)));
  assert.throws(() => M.labelRows(rows, null), /archetype catalog is required/);
  assert.deepEqual(M.labelRows([], ARCHETYPES), {labels: {}, coverage: {labelled: 0, unlabelled: 0}});
  const odd = [{id: 'p-1', trap: 'amendment amended and restated', built: 5, fell: null}, null, 'x'];
  assert.doesNotThrow(() => M.labelRows(odd, [{id: 'x', name: 'x', signals: {terms: [null, '', 'amend'], regex: ['(', 'a*', 7], needsAll: [[], 'x'], negative: [3]}}, null]));
});

/* ---------- retrieval ---------- */
test('retrieve returns the nearest precedents, deterministic, ties by id, similarity is a number', () => {
  const rows = LIB().rows, hits = M.retrieve(rows, 'amendment effective date pricing schedule superseded');
  assert.equal(hits[0].row.id, 'p-0002');
  assert.ok(hits.length <= 3 && hits.every(h => typeof h.similarity === 'number' && h.similarity > 0 && typeof h.reason === 'string' && h.reason));
  assert.ok(hits.every((h, i) => i === 0 || hits[i - 1].similarity >= h.similarity));
  assert.match(hits[0].reason, /Common wording: .*amendment/);
  assert.deepEqual(hits, M.retrieve(rows, 'amendment effective date pricing schedule superseded'));
  assert.equal(M.retrieve(rows, 'amendment effective date', {k: 1}).length, 1);
  assert.equal(M.retrieve(rows, 'the and of to', {k: 3}).length, 0, 'stop words only: nothing is close');
  assert.deepEqual(M.retrieve([], 'amendment'), []);
  assert.deepEqual(M.retrieve(rows, 'zzzz qqqq'), []);
  const tied = [1, 2, 3, 4].map(n => ({id: 'p-000' + n, workflow: 'Atlas', trap: 'identical trap wording', built: 'same built text', fell: 'x', score: 0.1 * n, scoreText: String(0.1 * n)}));
  assert.deepEqual(M.retrieve(tied, 'identical trap wording', {k: 4}).map(h => h.row.id), ['p-0001', 'p-0002', 'p-0003', 'p-0004']);
  assert.deepEqual(M.retrieve(tied.slice().reverse(), 'identical trap wording', {k: 4}).map(h => h.row.id), ['p-0001', 'p-0002', 'p-0003', 'p-0004']);
});
test('retrieve boosts rows whose label matches the archetype and rows of the same workflow', () => {
  const rows = LIB().rows, labels = M.labelRows(rows, ARCHETYPES);
  const plain = M.retrieve(rows, 'schedule', {k: 6}).map(h => h.row.id);
  const boosted = M.retrieve(rows, 'schedule', {k: 6, labels, archetypeId: 'ia-05'});
  assert.ok(!plain.includes('p-0005'), 'no shared wording, so it is not close without the label');
  assert.ok(boosted.some(h => h.row.id === 'p-0005'), 'the row labelled ia-05 is kept although "schedule" is not in it');
  assert.match(boosted.find(h => h.row.id === 'p-0005').reason, /Same mechanism label/);
  const tied = [1, 2, 3].map(n => ({id: 'p-000' + n, workflow: 'Atlas', trap: 'identical trap wording', built: 'same built text', fell: 'x', score: 0.1, scoreText: '0.1'}));
  const tiedLabels = {labels: {'p-0001': {archetypeId: null, matched: []}, 'p-0002': {archetypeId: null, matched: []}, 'p-0003': {archetypeId: 'ia-02', matched: ['amend']}}};
  assert.equal(M.retrieve(tied, 'identical trap wording', {k: 3, labels: tiedLabels, archetypeId: 'ia-02'})[0].row.id, 'p-0003', 'equal wording: the labelled row first');
  assert.equal(M.retrieve(tied, 'identical trap wording', {k: 3})[0].row.id, 'p-0001');
  assert.deepEqual(M.retrieve(rows, 'schedule', {k: 6, labels: labels.labels, archetypeId: 'ia-05'}).map(h => h.row.id), boosted.map(h => h.row.id), 'the labels map or the labelRows output');
  const flow = M.retrieve(rows, 'schedule gross', {k: 6, workflow: 'meridian close'});
  assert.match(flow.find(h => h.row.id === 'p-0002').reason, /Same workflow/);
});
test('retrieve does not mutate its inputs and reuses one index per row array', () => {
  const rows = deepFreeze(LIB().rows), labels = deepFreeze(M.labelRows(rows, ARCHETYPES));
  const a = M.retrieve(rows, 'bridge reconciling item', {labels, archetypeId: 'ia-04'}), b = M.retrieve(rows, 'bridge reconciling item', {labels, archetypeId: 'ia-04'});
  assert.deepEqual(a, b);
  assert.equal(a[0].row, rows[3], 'the row object is returned as is');
});

/* ---------- applicability ---------- */
test('detectApplicability reads only solver-visible documents and cites exact records', () => {
  const p = PKG(), d = M.detectApplicability(p, ARCHETYPES);
  assert.deepEqual(Object.keys(d), ['ia-01', 'ia-02', 'ia-04', 'ia-05', 'ia-06', 'ia-08']);
  const names = new Set(Object.values(d).flatMap(x => x.evidence.map(e => e.documentName)));
  assert.deepEqual([...names].sort(), ['Atlas_Model.xlsx', 'Atlas_Summary.txt', 'Cash_Facts.csv']);
  assert.ok(!('ia-03' in d) && !('ia-07' in d), 'wording found only in the evaluator, run-evidence and audit documents is never evidence');
  assert.equal(d['ia-02'].evidence[0].documentName, 'Atlas_Summary.txt');
  assert.equal(d['ia-02'].evidence[0].locator, 'Line 2');
  assert.equal(d['ia-02'].evidence[0].term, 'amendment');
  assert.equal(d['ia-02'].strength, 'signal');
  assert.equal(d['ia-06'].strength, 'weak');
  assert.equal(d['ia-08'].evidence[0].locator, 'Staging!A1');
  for (const x of Object.values(d)) for (const e of x.evidence) {
    assert.ok(e.quote.length <= 300);
    const hit = E.resolveClause(p, {name: e.documentName, locator: e.locator, excerpt: e.quote});
    assert.ok(hit && hit.excerptVerified === true, e.documentName + ' ' + e.locator + ' resolves to one record that contains the quote');
  }
  assert.deepEqual(d['ia-04'].evidence.map(e => e.locator), ['Row 2', 'Row 3', 'Bridge!A3']);
  assert.equal(d['ia-04'].evidence[0].label, 'Opening balance', 'the labelled input of a csv row');
  assert.equal(d['ia-04'].promptMention, true, 'the prompt document is read for wording only');
  assert.ok(Object.values(d).every(x => x.evidence.every(e => e.documentName !== 'Task_Request.txt')));
});
test('detectApplicability: roles are an allowlist, the limit and per-document cap apply, gating terms apply', () => {
  const lines = Array.from({length: 10}, (_, i) => 'Line about the amendment number ' + i);
  const many = pkg([txt('Atlas_Notes.txt', lines), txt('Meridian_Notes.txt', lines)]);
  const d = M.detectApplicability(many, ARCHETYPES);
  assert.equal(d['ia-02'].evidence.length, 3, 'default limit is three');
  assert.deepEqual(d['ia-02'].evidence.map(e => e.documentName), ['Atlas_Notes.txt', 'Atlas_Notes.txt', 'Meridian_Notes.txt'], 'at most two from one document');
  assert.equal(M.detectApplicability(many, ARCHETYPES, {limit: 1})['ia-02'].evidence.length, 1);
  assert.equal(M.detectApplicability(many, ARCHETYPES, {limit: 99})['ia-02'].evidence.length, 4, 'two documents, two each');
  for (const role of ['evaluator', 'run-evidence', 'audit', 'prompt', 'unknown']) assert.deepEqual(M.detectApplicability(pkg([txt('Atlas_Notes.txt', lines, {role})]), ARCHETYPES), {}, role);
  for (const role of ['source', 'template', 'proposal']) assert.ok('ia-02' in M.detectApplicability(pkg([txt('Atlas_Notes.txt', lines, {role})]), ARCHETYPES), role);
  assert.deepEqual(M.detectApplicability(pkg([txt('Atlas_Notes.txt', ['a bridge', 'text'], {status: 'error'})]), ARCHETYPES), {});
  const noBridge = pkg([txt('Atlas_Notes.txt', ['Reconciling items are listed.'])]);
  assert.ok(!('ia-04' in M.detectApplicability(noBridge, ARCHETYPES)), 'needsAll: reconciling words without the word bridge');
  assert.ok('ia-04' in M.detectApplicability(pkg([txt('Atlas_Notes.txt', ['Reconciling items are listed.']), txt('Meridian_Notes.txt', ['The bridge is on another page.'])]), ARCHETYPES), 'needsAll is met across documents');
  assert.ok(!('ia-05' in M.detectApplicability(pkg([txt('Atlas_Notes.txt', ['Rounded totals use unrounded inputs.'])]), ARCHETYPES)), 'negative term in the same record');
  assert.ok('ia-05' in M.detectApplicability(pkg([txt('Atlas_Notes.txt', ['Rounded totals.', 'Unrounded inputs elsewhere.'])]), ARCHETYPES));
  for (const bad of [null, {}, {documents: 3}, 'x']) assert.deepEqual(M.detectApplicability(bad, ARCHETYPES), {});
});
test('detectApplicability: regex signals, spreadsheet cells, long records and numeric cells', () => {
  const long = 'Filler sentence about nothing in particular. '.repeat(60) + 'The agreement was amended and restated last month.';
  const p = pkg([txt('Atlas_Notes.txt', [long, 'Margin is quoted Gross of Tax.']), xlsx('Atlas_Numbers.xlsx', [cell('Sheet1', 'A1', 12345), cell('Sheet1', 'B1', 0.5), cell('Sheet1', 'C1', '=SUM(A1:B1) [cached: 12345.5]', {hasFormula: true})])]);
  const d = M.detectApplicability(p, ARCHETYPES);
  assert.equal(d['ia-02'].evidence[0].locator, 'Line 1');
  assert.ok(d['ia-02'].evidence[0].quote.length <= 300 && /amended and restated/.test(d['ia-02'].evidence[0].quote), 'a long record is quoted around the match');
  assert.equal(d['ia-01'].evidence[0].term, 'Gross of Tax', 'a regex hit reports the matched text, not the pattern');
  assert.equal(d['ia-01'].strength, 'weak');
  assert.ok(E.resolveClause(p, {name: 'Atlas_Notes.txt', locator: 'Line 1', excerpt: d['ia-02'].evidence[0].quote}).excerptVerified);
  assert.equal(d['ia-01'].evidence[0].locator, 'Line 2');
  assert.deepEqual(Object.keys(d), ['ia-01', 'ia-02'], 'numeric cells and a formula without a term are not evidence');
});
test('detectApplicability visits each record once and stays fast on 100,000 records', () => {
  const reads = new Map(), n = 2000;
  const records = Array.from({length: n}, (_, i) => { const r = {locator: 'Line ' + (i + 1)}; Object.defineProperty(r, 'text', {enumerable: true, get() { reads.set(i, (reads.get(i) || 0) + 1); return i % 7 === 0 ? 'the amendment and the bridge number ' + i : 'plain filler ' + i; }}); return r; });
  const d = M.detectApplicability(pkg([doc('Atlas_Big.txt', 'txt', records)]), ARCHETYPES);
  assert.ok('ia-02' in d);
  assert.equal(reads.size, n);
  assert.ok([...reads.values()].every(c => c === 1), 'the text of every record is read exactly once');
  const rnd = seeded(99), vocab = ('revenue cost margin schedule agreement clause amount balance period entity group summary detail note table sheet input rate base price volume forecast actual budget variance accrual reserve cash debt equity facility payment due date closing opening ending report policy limit approved board gross net amendment bridge rounded subtotal perimeter').split(' ');
  const big = Array.from({length: 100000}, (_, i) => ({locator: 'Line ' + (i + 1), text: i % 3 === 0 ? String(Math.floor(rnd() * 1e6)) : Array.from({length: 3 + Math.floor(rnd() * 8)}, () => vocab[Math.floor(rnd() * vocab.length)]).join(' ')}));
  const p = pkg([doc('Atlas_Big.txt', 'txt', big), doc('Meridian_Big.txt', 'txt', big.slice(0, 50000))]);
  let t = Date.now();
  const hit = M.detectApplicability(p, ARCHETYPES);
  assert.ok(Date.now() - t < 5000, 'detect took ' + (Date.now() - t) + ' ms');
  assert.ok(Object.keys(hit).length >= 5);
  t = Date.now();
  const out = M.buildIdeas({mode: 'existing', task: {workflow: '', description: ''}, pkg: p, project: null, library: null, archetypes: ARCHETYPES, now: '2026-10-13T00:00:00.000Z'});
  assert.ok(Date.now() - t < 8000, 'buildIdeas took ' + (Date.now() - t) + ' ms');
  assert.ok(out.ideas.some(i => i.applicability.length));
});

/* ---------- coverage ---------- */
test('coverage reports what the current roots already cover and the open net-new slots', () => {
  assert.deepEqual(M.coverage(null, ARCHETYPES), {roots: 0, netNewCount: 0, openNetNewSlots: 2, byArchetype: {}});
  assert.deepEqual(M.coverage({roots: []}, ARCHETYPES).byArchetype, {});
  const blank = M.coverage(PROJECT([{}]), ARCHETYPES);
  assert.deepEqual(blank.byArchetype, {}, 'a blank root carries the default mechanism and says nothing');
  assert.equal(blank.openNetNewSlots, 1);
  const project = PROJECT([
    {title: 'Amendment supersedes the pricing schedule', lane: 'historical', modeId: 'MODE-1', mechanism: 'contract_conditions', wrongInterpretation: 'use the superseded schedule instead of the amendment effective date'},
    {title: 'Cut-off', lane: 'net-new', causalGroup: 'cg-ia-03', mechanism: 'period_alignment'},
    {title: 'Metric work', lane: 'net-new', mechanism: 'metric_basis'},
    {title: 'Rounded', lane: 'net-new', governingRule: 'The rounded inputs are used as shown.', mechanism: 'rounding_calibration'}
  ]);
  const cov = M.coverage(project, ARCHETYPES);
  assert.equal(cov.netNewCount, 3);
  assert.equal(cov.openNetNewSlots, -1, 'the formula is SET.netNew minus the net-new roots, so it is negative over the cap');
  assert.equal(cov.byArchetype['ia-02'].level, 'covered');
  assert.deepEqual(cov.byArchetype['ia-02'].roots[0], {level: 'covered', rootId: 'root-0', modeId: 'MODE-1', title: 'Amendment supersedes the pricing schedule', why: cov.byArchetype['ia-02'].roots[0].why});
  assert.match(cov.byArchetype['ia-02'].roots[0].why, /^Shares wording with this idea: amendment, supersede, effective date\.$/);
  assert.equal(cov.byArchetype['ia-03'].level, 'covered');
  assert.equal(cov.byArchetype['ia-03'].roots[0].why, 'Same causal group as this idea.');
  assert.equal(cov.byArchetype['ia-01'].level, 'mechanism', 'same catalog mechanism only: weak');
  assert.match(cov.byArchetype['ia-01'].roots[0].why, /Same mechanism family \(metric_basis\)/);
  assert.equal(cov.byArchetype['ia-05'].level, 'overlap', 'one signal and the same mechanism');
  assert.ok(!('ia-04' in cov.byArchetype) && !('ia-08' in cov.byArchetype));
  const defaults = M.coverage(PROJECT([{title: 'x', mechanism: 'period_alignment'}]), ARCHETYPES);
  assert.ok(!('ia-03' in defaults.byArchetype), 'period_alignment alone is the default value and is not evidence');
  assert.equal(M.coverage(PROJECT([{causalGroup: ' '}]), ARCHETYPES).openNetNewSlots, 1);
});

/* ---------- ideas ---------- */
const IDEA_KEYS = ['id', 'archetypeId', 'title', 'mechanism', 'kind', 'status', 'statusWords', 'summary', 'whyItHolds', 'buildMoves', 'wrongApproach', 'correctTreatment', 'detection', 'consequence', 'applicability', 'precedents', 'lowestScoreText', 'overlapWith', 'causalGroup', 'honesty', 'lead', 'needs', 'anchored', 'strength', 'described'];
const build = (over = {}) => M.buildIdeas({mode: 'existing', task: {workflow: 'Reporting', description: ''}, pkg: PKG(), project: null, library: null, archetypes: ARCHETYPES, now: '2026-10-13T00:00:00.000Z', ...over});
test('buildIdeas (existing task): statuses, order without a library, anchors, specialised build moves', () => {
  const out = build();
  assert.deepEqual(Object.keys(out), ['ideas', 'inputs', 'notes', 'ordering', 'generatedAt']);
  assert.equal(out.ordering, null, 'no library, no ordering by score');
  assert.deepEqual(out.ideas.map(i => i.archetypeId), ['ia-02', 'ia-01', 'ia-04', 'ia-05', 'ia-06', 'ia-08', 'ia-03', 'ia-07'], 'status, then lead, then catalog order');
  assert.deepEqual(out.ideas.map(i => i.status), ['anchored', 'anchored', 'anchored', 'anchored', 'anchored', 'anchored', 'needs-evidence', 'needs-evidence']);
  assert.deepEqual(out.ideas.map(i => i.statusWords), [...Array(6).fill('Reviewable hypothesis'), ...Array(2).fill(M.TEXT.statusWords[HOLD])]);
  assert.deepEqual(out.inputs, {packageFingerprint: PKG().fingerprint, projectKey: null, libraryHash: null, archetypesVersion: 0, mode: 'existing'});
  assert.equal(out.generatedAt, '2026-10-13T00:00:00.000Z');
  for (const i of out.ideas) {
    assert.deepEqual(Object.keys(i), IDEA_KEYS);
    assert.match(i.id, /^[A-Za-z0-9_-]{1,120}$/);
    assert.equal(i.honesty, 'Hypothesis for review. No claim about how a solver will perform.');
    assert.deepEqual(i.precedents, []);
    assert.equal(i.lowestScoreText, null);
    assert.ok(i.applicability.every(a => !/Grader|Run_Log|Audit|Task_Request/.test(a.documentName)));
  }
  assert.equal(new Set(out.ideas.map(i => i.id)).size, out.ideas.length);
  const bridge = out.ideas.find(i => i.archetypeId === 'ia-04');
  assert.equal(bridge.applicability.length, 3);
  assert.equal(bridge.strength, 'signal');
  assert.equal(bridge.anchored, true);
  assert.equal(bridge.buildMoves.length, 2);
  assert.ok(bridge.buildMoves[0].startsWith('Add a second schedule that states the figure on another basis. In this package that means working in Cash_Facts.csv at Row 2, the row labelled "Opening balance".'));
  assert.match(bridge.buildMoves[1], /working in Cash_Facts\.csv at Row 3, the row labelled "Bridge item"\.$/);
  const amend = out.ideas.find(i => i.archetypeId === 'ia-02');
  assert.match(amend.buildMoves[0], /working in Atlas_Summary\.txt at Line 2\.$/);
  assert.equal(amend.buildMoves[1], ARCHETYPES[1].buildMoves[1], 'a move with no anchor of its own stays generic');
  const hidden = out.ideas.find(i => i.archetypeId === 'ia-08');
  assert.match(hidden.buildMoves[0], /working in Atlas_Model\.xlsx, sheet Staging\.$/, 'a spreadsheet record is named by its sheet, never by a cell reference');
  assert.ok(out.ideas.every(i => i.buildMoves.every(m => !/\b[A-Z]{1,3}\d{1,5}\b/.test(m.replace(/Row \d+|Line \d+/g, '')))));
  const open = out.ideas.find(i => i.archetypeId === 'ia-03');
  assert.deepEqual([open.applicability, open.anchored, open.strength, open.buildMoves], [[], false, null, ARCHETYPES[2].buildMoves]);
  assert.ok(out.notes.some(n => /^The task request already uses wording close to "Reconciling item missing from a bridge"\./.test(n)));
  assert.ok(!out.notes.some(n => /No task package/.test(n)));
});
test('buildIdeas: ids are deterministic hashes of the archetype and the inputs; limit and now behave', () => {
  const a = build(), b = build({now: '2027-01-01T00:00:00.000Z'});
  assert.deepEqual(a.ideas, b.ideas);
  assert.equal(b.generatedAt, '2027-01-01T00:00:00.000Z');
  assert.equal(build({now: 5}).generatedAt, null);
  assert.notDeepEqual(a.ideas.map(i => i.id), build({pkg: pkg([SUMMARY()])}).ideas.map(i => i.id), 'another package: other ids');
  assert.notDeepEqual(a.ideas.map(i => i.id), build({mode: 'new'}).ideas.map(i => i.id));
  assert.notDeepEqual(a.ideas.map(i => i.id), build({task: {workflow: 'Close', description: ''}}).ideas.map(i => i.id));
  const three = build({limit: 3});
  assert.deepEqual(three.ideas, a.ideas.slice(0, 3));
  assert.equal(build({limit: 0}).ideas.length, 1);
  assert.equal(build({limit: 1000}).ideas.length, 8);
  assert.equal(build({archetypes: CATALOG}).inputs.archetypesVersion, 1);
  assert.deepEqual(build({archetypes: CATALOG}).ideas.map(i => i.id), a.ideas.map(i => i.id).map((id, k) => build({archetypes: CATALOG}).ideas[k].id));
  assert.throws(() => build({mode: 'later'}), /mode must be/);
  assert.throws(() => M.buildIdeas(null), /needs an input object/);
  assert.throws(() => build({archetypes: undefined}), /archetype catalog is required/);
});
test('buildIdeas (existing task) without a package says so and offers catalog ideas on hold', () => {
  const out = build({pkg: null});
  assert.ok(out.ideas.every(i => i.status === 'needs-evidence' && !i.applicability.length));
  assert.ok(out.notes.some(n => /^No task package is loaded/.test(n)));
  assert.equal(out.inputs.packageFingerprint, null);
  assert.ok(build({pkg: pkg([txt('Atlas_Notes.txt', ['nothing relevant'])])}).notes.some(n => /No wording in the solver-visible documents/.test(n)));
});
test('buildIdeas (new task): on hold unless the description supplies the materials; no package evidence is read', () => {
  const none = build({mode: 'new', pkg: PKG()});
  assert.ok(none.ideas.every(i => i.status === 'needs-evidence' && !i.applicability.length && !i.anchored && !i.described));
  assert.deepEqual(none.ideas.map(i => i.archetypeId), ['ia-02', 'ia-01', 'ia-03', 'ia-04', 'ia-05', 'ia-06', 'ia-07', 'ia-08'], 'lead first, then catalog order');
  assert.equal(none.inputs.packageFingerprint, null, 'a package is ignored in new-task mode');
  assert.ok(none.notes.some(n => /^Add a short description/.test(n)));
  const described = build({mode: 'new', pkg: null, task: {workflow: 'Pricing', description: 'We reconcile the bridge to the opening balance. The amendment has a later effective date and supersedes the schedule. Rounded totals use unrounded inputs.'}});
  const by = Object.fromEntries(described.ideas.map(i => [i.archetypeId, i]));
  assert.equal(by['ia-04'].status, 'anchored', 'needsAll term "bridge" is in the description');
  assert.equal(by['ia-04'].described, true);
  assert.deepEqual([by['ia-04'].applicability, by['ia-04'].anchored], [[], false]);
  assert.equal(by['ia-02'].described, true, 'no needsAll: two different signals in the description');
  assert.equal(by['ia-05'].described, false, 'negative term present');
  assert.equal(by['ia-01'].described, false);
  assert.deepEqual(described.ideas.slice(0, 2).map(i => i.archetypeId), ['ia-02', 'ia-04']);
  assert.ok(!described.notes.some(n => /Add a short description/.test(n)));
});
test('buildIdeas: ideas that overlap or repeat a current mode are demoted and say which mode', () => {
  const project = PROJECT([
    {title: 'Amendment supersedes the pricing schedule', lane: 'historical', modeId: 'MODE-1', mechanism: 'contract_conditions', wrongInterpretation: 'use the superseded schedule instead of the amendment effective date'},
    {title: 'Cut-off', lane: 'net-new', causalGroup: 'cg-ia-03'},
    {title: 'Rounded', lane: 'net-new', governingRule: 'The rounded inputs are used as shown.', mechanism: 'rounding_calibration'},
    {title: 'Metric work', lane: 'historical', mechanism: 'metric_basis'}
  ]);
  const out = build({project});
  const by = Object.fromEntries(out.ideas.map(i => [i.archetypeId, i]));
  assert.equal(by['ia-02'].status, 'covered');
  assert.equal(by['ia-02'].statusWords, 'Already covered');
  assert.equal(by['ia-03'].status, 'covered');
  assert.equal(by['ia-05'].status, 'overlap');
  assert.equal(by['ia-05'].statusWords, 'Overlaps a current mode');
  assert.equal(by['ia-01'].status, 'anchored', 'same mechanism alone does not demote');
  assert.equal(by['ia-01'].overlapWith.length, 1);
  assert.deepEqual(by['ia-02'].overlapWith[0], {rootId: 'root-0', modeId: 'MODE-1', title: 'Amendment supersedes the pricing schedule', why: by['ia-02'].overlapWith[0].why});
  assert.deepEqual(by['ia-03'].overlapWith.map(o => Object.keys(o)), [['rootId', 'title', 'why']]);
  const rank = {anchored: 0, 'needs-evidence': 1, overlap: 2, covered: 2};
  assert.ok(out.ideas.every((i, k) => k === 0 || rank[out.ideas[k - 1].status] <= rank[i.status]));
  assert.ok(out.ideas.slice(-3).every(i => ['covered', 'overlap'].includes(i.status)));
  assert.ok(out.notes.includes('Open net-new slots in the current project: 0.'));
  assert.match(out.inputs.projectKey, /^[0-9a-f]{64}$/);
  assert.notEqual(out.inputs.projectKey, build({project: PROJECT([{title: 'Other'}])}).inputs.projectKey);
});

/* ---------- ordering and precedents ---------- */
const mini = (n, word, o) => arche(n, {name: 'Archetype about ' + word, summary: 'A note on ' + word + '.', whyItHolds: 'The ' + word + ' wording is firm.', wrongApproach: 'ignore the ' + word, workflowHints: [], signals: {terms: [word], regex: []}, ...o});
const MINI = deepFreeze([mini(11, 'quillon'), mini(12, 'tarsus'), mini(13, 'vellum'), mini(14, 'mortise', {lead: true}), mini(15, 'tarsus', {name: 'Archetype about tarsus again'})]);
const libFrom = rows => M.parseLibraryCsv(toCsv([HEADER, ...rows]));
const MINI_ROWS = [
  ['Atlas Reporting', 'quillon', 'quillon', 'x', '0.4'], ['Atlas Reporting', 'quillon', 'quillon', 'x', '0.5'],
  ['Atlas Reporting', 'tarsus', 'tarsus', 'x', '0.1'],
  ['Atlas Reporting', 'vellum', 'vellum', 'x', '0.1'], ['Atlas Reporting', 'vellum', 'vellum', 'x', '0.9']
];
const mkey = (i, hasLib) => {
  const low = i.lowestScoreText === null ? Infinity : Number(i.lowestScoreText), rank = {anchored: 0, 'needs-evidence': 1, overlap: 2, covered: 2}[i.status];
  return hasLib ? [rank, low, -i.precedents.length, i.lead ? 0 : 1, i.id] : [rank, i.lead ? 0 : 1];
};
const lexLess = (a, b) => { for (let k = 0; k < a.length; k++) { if (a[k] < b[k]) return true; if (a[k] > b[k]) return false; } return true; };
test('buildIdeas orders by the lowest recorded precedent score when a library is loaded, ties by more precedents, lead, then id', () => {
  const library = libFrom(MINI_ROWS);
  const out = M.buildIdeas({mode: 'new', task: {workflow: '', description: ''}, pkg: null, project: null, library, archetypes: MINI, now: 'x'});
  const by = Object.fromEntries(out.ideas.map(i => [i.archetypeId, i]));
  assert.deepEqual(by['ia-13'].precedents.map(p => p.scoreText), ['0.1', '0.9']);
  assert.equal(by['ia-13'].lowestScoreText, '0.1');
  assert.deepEqual(by['ia-12'].precedents.map(p => p.scoreText), ['0.1']);
  assert.deepEqual(by['ia-14'].precedents, []);
  assert.equal(by['ia-14'].lowestScoreText, null);
  const ids = out.ideas.map(i => i.archetypeId);
  assert.ok(ids.indexOf('ia-13') < ids.indexOf('ia-12') && ids.indexOf('ia-13') < ids.indexOf('ia-15'), 'same lowest score 0.1: more precedents first');
  assert.ok(ids.indexOf('ia-12') < ids.indexOf('ia-11'), 'a lower recorded score comes first');
  assert.equal(ids[ids.length - 1], 'ia-14', 'no precedents last, even for a lead idea');
  const tie = out.ideas.filter(i => ['ia-12', 'ia-15'].includes(i.archetypeId));
  assert.deepEqual(tie.map(i => i.id), tie.map(i => i.id).slice().sort(), 'equal score, equal count, equal lead: by id');
  out.ideas.forEach((i, k) => { if (k) assert.ok(lexLess(mkey(out.ideas[k - 1], true), mkey(i, true)), i.archetypeId); });
  const plain = M.buildIdeas({mode: 'new', task: {workflow: '', description: ''}, pkg: null, project: null, library: null, archetypes: MINI, now: 'x'});
  assert.deepEqual(plain.ideas.map(i => i.archetypeId), ['ia-14', 'ia-11', 'ia-12', 'ia-13', 'ia-15'], 'without a library: status, lead, catalog order');
  assert.ok(plain.ideas.every(i => i.precedents.length === 0 && i.lowestScoreText === null));
  assert.equal(out.inputs.libraryHash, library.hash);
});
test('the recorded score outranks lead, and status outranks the recorded score', () => {
  const library = libFrom([['Atlas Reporting', 'mortise', 'mortise', 'x', '0.8'], ['Atlas Reporting', 'quillon', 'quillon', 'x', '0.2']]);
  const out = M.buildIdeas({mode: 'new', task: {workflow: '', description: ''}, pkg: null, project: null, library, archetypes: MINI, now: 'x'});
  assert.deepEqual(out.ideas.map(i => i.archetypeId).slice(0, 2), ['ia-11', 'ia-14'], 'the lead idea with the higher recorded score comes after the lower one');
  const project = PROJECT([{title: 'The quillon task', causalGroup: 'cg-ia-11'}]);
  const covered = M.buildIdeas({mode: 'new', task: {workflow: '', description: ''}, pkg: null, project, library, archetypes: MINI, now: 'x'});
  assert.equal(covered.ideas[covered.ideas.length - 1].archetypeId, 'ia-11', 'covered goes last although its recorded score is the lowest');
});
test('at most three precedents per idea, chosen by closeness and shown by recorded score ascending, verbatim', () => {
  const rows = [
    ['Atlas Reporting', 'quillon', 'quillon', 'x', '0.9'], ['Atlas Reporting', 'quillon', 'quillon', 'x', '0.3'], ['Atlas Reporting', 'quillon', 'quillon', 'x', '0.30'],
    ['Atlas Reporting', 'quillon', 'quillon', 'x', '0.6'], ['Atlas Reporting', 'quillon', 'quillon', 'x', '0.7'],
    ['Atlas Reporting', 'unrelated lattice wording', 'a long unrelated passage that mentions quillon once among many other words', 'y', '0.01'],
    ['Atlas Reporting', 'plain words', 'plain words', 'z', '0.001']
  ];
  const library = libFrom(rows);
  const idea = M.buildIdeas({mode: 'new', task: {workflow: '', description: ''}, pkg: null, project: null, library, archetypes: MINI, now: 'x'}).ideas.find(i => i.archetypeId === 'ia-11');
  assert.equal(idea.precedents.length, 3);
  assert.deepEqual(idea.precedents.map(p => p.id), ['p-0002', 'p-0003', 'p-0001'], 'the three closest (ties by id), then sorted by recorded score ascending (0.3, 0.30, 0.9)');
  assert.deepEqual(idea.precedents.map(p => p.scoreText), ['0.3', '0.30', '0.9']);
  assert.equal(idea.lowestScoreText, '0.3', 'the single lowest value among the shown ones, as written');
  assert.deepEqual(Object.keys(idea.precedents[0]), ['id', 'workflow', 'trap', 'scoreText']);
  assert.ok(!idea.precedents.some(p => p.id === 'p-0006' || p.id === 'p-0007'), 'a lower recorded score does not make a row closer');
  const noNumber = libFrom([['Atlas', 'quillon', 'quillon', 'x', 'n/a'], ['Atlas', 'quillon', 'quillon', 'x', '0.5'], ['Atlas', 'quillon', 'quillon', 'x', '']]);
  const i2 = M.buildIdeas({mode: 'new', task: {workflow: '', description: ''}, pkg: null, project: null, library: noNumber, archetypes: MINI, now: 'x'}).ideas.find(i => i.archetypeId === 'ia-11');
  assert.deepEqual(i2.precedents.map(p => p.scoreText), ['0.5', 'n/a', ''], 'a row without a number is shown after rows with one');
  assert.equal(i2.lowestScoreText, '0.5');
  const none = libFrom([['Atlas', 'quillon', 'quillon', 'x', 'n/a']]);
  assert.equal(M.buildIdeas({mode: 'new', task: {workflow: '', description: ''}, pkg: null, project: null, library: none, archetypes: MINI, now: 'x'}).ideas.find(i => i.archetypeId === 'ia-11').lowestScoreText, null);
});
test('the library may carry its own labels (as the map or as the labelRows output) or none; an empty library counts as none', () => {
  const library = libFrom(MINI_ROWS), labels = M.labelRows(library.rows, MINI);
  const a = M.buildIdeas({mode: 'new', task: {workflow: '', description: ''}, pkg: null, project: null, library, archetypes: MINI, now: 'x'});
  const b = M.buildIdeas({mode: 'new', task: {workflow: '', description: ''}, pkg: null, project: null, library: {...library, labels}, archetypes: MINI, now: 'x'});
  const c = M.buildIdeas({mode: 'new', task: {workflow: '', description: ''}, pkg: null, project: null, library: {...library, labels: labels.labels}, archetypes: MINI, now: 'x'});
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  const empty = M.buildIdeas({mode: 'new', task: {workflow: '', description: ''}, pkg: null, project: null, library: {rows: [], hash: 'h'}, archetypes: MINI, now: 'x'});
  assert.equal(empty.inputs.libraryHash, null);
  assert.deepEqual(empty.ideas.map(i => i.archetypeId), ['ia-14', 'ia-11', 'ia-12', 'ia-13', 'ia-15']);
});
test('no score is computed: ideas carry only recorded text, and no statistic or rate appears anywhere', () => {
  const library = libFrom(ROWS), out = M.buildIdeas({mode: 'existing', task: {workflow: 'Meridian Close', description: 'close'}, pkg: PKG(), project: null, library, archetypes: ARCHETYPES, now: 'x'});
  const keys = new Set();
  const walk = v => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
  walk(out);
  assert.deepEqual([...keys].filter(k => /score|simil|mean|average|percent|probab|predict|rank|median|rate$/i.test(k)).sort(), ['lowestScoreText', 'scoreText']);
  for (const i of out.ideas) { assert.deepEqual(Object.keys(i), IDEA_KEYS); assert.ok(i.precedents.length <= 3); for (const p of i.precedents) assert.equal(p.scoreText, library.rows.find(r => r.id === p.id).scoreText); }
  assertClean(out, 'buildIdeas');
});

test('precedent text is shown without a percent sign or a rate phrase; every other character stays; the score cell is untouched', () => {
  assert.equal(M.displayText('Margin 45% of sales'), 'Margin 45 percent of sales');
  assert.equal(M.displayText('Margin 45 % of sales'), 'Margin 45 percent of sales');
  assert.equal(M.displayText('100%'), '100 percent');
  assert.equal(M.displayText('50%off, 3%.'), '50 percent off, 3 percent.');
  assert.equal(M.displayText('% change in the base'), 'percent change in the base');
  assert.equal(M.displayText('Error was caught late'), 'Error was ... late');
  assert.equal(M.displayText('Caught in review'), '... in review');
  assert.equal(M.displayText('The PASS  RATE note, a success rate and the failure rate'), 'The ... note, a ... and the ...');
  assert.equal(M.displayText('Likely to breach'), '... breach');
  assert.equal(M.displayText('Plain wording, Atlas "quoted" & more'), 'Plain wording, Atlas "quoted" & more');
  assert.equal(M.displayText(undefined), '');
  const rows = [['Atlas 45%', 'Amendment supersedes the schedule, caught late at 45%', 'built', 'fell', '0.2'], ['Atlas', 'Amendment supersedes the pricing schedule', 'built', 'fell', '0.4']];
  const out = M.buildIdeas({mode: 'new', task: {workflow: '', description: 'An amendment supersedes the schedule.'}, pkg: null, project: null, library: libFrom(rows), archetypes: ARCHETYPES, now: 'x', limit: 100});
  const shown = out.ideas.flatMap(i => i.precedents);
  assert.ok(shown.length > 0);
  for (const p of shown) {
    assert.doesNotMatch(p.workflow + ' ' + p.trap, FORBIDDEN_TEXT, 'precedent words carry no percent sign and no banned phrase');
    assert.ok(['0.2', '0.4'].includes(p.scoreText), 'the recorded score is verbatim');
  }
  assert.ok(shown.some(p => p.trap === 'Amendment supersedes the schedule, ... late at 45 percent' && p.workflow === 'Atlas 45 percent'));
  assertClean(out, 'buildIdeas with percent signs in the workbook');
});
test('a workbook with no readable score is not claimed to order the ideas: buildIdeas reports counts, nothing else', () => {
  const none = M.buildIdeas({mode: 'new', task: {workflow: 'Meridian Close', description: ''}, pkg: null, project: null, library: libFrom(ROWS.map(r => [...r.slice(0, 4), r[4].replace('.', ',')])), archetypes: ARCHETYPES, now: 'x'});
  assert.equal(none.ordering.rows, ROWS.length);
  assert.equal(none.ordering.unreadable, ROWS.length, 'a decimal comma is not a plain number');
  assert.equal(none.ordering.ordered, 0, 'no idea has a lowest recorded score');
  assert.ok(none.ideas.every(i => i.lowestScoreText === null));
  const some = M.buildIdeas({mode: 'new', task: {workflow: 'Meridian Close', description: ''}, pkg: null, project: null, library: LIB(), archetypes: ARCHETYPES, now: 'x', limit: 100});
  assert.equal(some.ordering.rows, ROWS.length);
  assert.equal(some.ordering.unreadable, 1, 'one score cell is not a plain number');
  assert.ok(some.ordering.ordered > 0 && some.ordering.ordered <= some.ideas.length);
  assert.deepEqual(Object.keys(some.ordering), ['rows', 'unreadable', 'ordered'], 'counts of rows and ideas, no score statistic');
});
test('a very long workflow is cut where it is read, so a paste cannot stall the page; the ideas equal those of the cut text', () => {
  const library = LIB(), head = 'Meridian Close ', long = head + 'x'.repeat(3e6);
  const t = Date.now();
  const a = M.buildIdeas({mode: 'new', task: {workflow: long, description: ''}, pkg: null, project: null, library, archetypes: ARCHETYPES, now: 'x'});
  assert.ok(Date.now() - t < 1500, 'a 3 million character workflow took ' + (Date.now() - t) + ' ms');
  const b = M.buildIdeas({mode: 'new', task: {workflow: long.slice(0, 200), description: ''}, pkg: null, project: null, library, archetypes: ARCHETYPES, now: 'x'});
  assert.deepEqual(a, b);
  const c = M.buildIdeas({mode: 'new', task: {workflow: 'Meridian Close', description: ''}, pkg: null, project: null, library, archetypes: ARCHETYPES, now: 'x'});
  assert.notDeepEqual(a.ideas.map(i => i.id), c.ideas.map(i => i.id), 'the cut text still counts as the workflow');
});

/* ---------- purity and determinism ---------- */
test('purity: deep-frozen inputs are never mutated and the same input gives deep-equal plain JSON', () => {
  const frozen = () => {
    const library = libFrom(ROWS), labels = M.labelRows(library.rows, ARCHETYPES);
    return deepFreeze({archetypes: copy(ARCHETYPES), catalog: copy(CATALOG), pkg: PKG(), project: PROJECT([{title: 'Amendment supersedes the pricing schedule', lane: 'net-new'}, {title: 'Cut-off', causalGroup: 'cg-ia-03'}]), library: {...library, labels}, rows: library.rows});
  };
  const run = f => {
    const out = {};
    out.csv = M.parseLibraryCsv(CSV);
    out.labels = M.labelRows(f.rows, f.archetypes);
    out.retrieve = M.retrieve(f.rows, 'amendment effective date', {labels: out.labels, archetypeId: 'ia-02'});
    out.detect = M.detectApplicability(f.pkg, f.archetypes);
    out.cov = M.coverage(f.project, f.archetypes);
    out.existing = M.buildIdeas({mode: 'existing', task: deepFreeze({workflow: 'Meridian Close', description: 'close'}), pkg: f.pkg, project: f.project, library: f.library, archetypes: f.catalog, now: '2026-10-13T00:00:00.000Z', limit: 8});
    out.fresh = M.buildIdeas({mode: 'new', task: deepFreeze({workflow: 'Pricing', description: 'The amendment has a later effective date and supersedes the schedule.'}), pkg: null, project: f.project, library: f.library, archetypes: f.archetypes, now: '2026-10-13T00:00:00.000Z'});
    out.lint = out.existing.ideas.map(i => M.lintIdea(i));
    out.project = out.existing.ideas.map(i => M.toAuthoringProject(i, {pkg: f.pkg, project: f.project}));
    return out;
  };
  const a = run(frozen()), b = run(frozen());
  assert.deepEqual(a, b);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a, 'plain JSON: no undefined, NaN, Map or function');
  assert.ok(a.existing.ideas.length === 8 && a.fresh.ideas.length === 8);
});
test('the model reads no clock and draws no random number', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'ideas-model.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const banned of [/Date\.now\(/, /new Date\(/, /Math\.random/, /\bIntl\b/, /localeCompare/, /toLocale/, /\bfetch\s*\(/, /XMLHttpRequest/, /\beval\s*\(/, /new Function/, /(?<![\w.])document\.[A-Za-z]/, /(?<![\w.])window\.[A-Za-z]/, /localStorage/, /sessionStorage/]) assert.ok(!banned.test(src), String(banned));
  const realDate = Date.now, realRandom = Math.random;
  Date.now = () => { throw new Error('clock'); }; Math.random = () => { throw new Error('random'); };
  try { build(); M.parseLibraryCsv(CSV); M.toAuthoringProject(build().ideas[0], {pkg: PKG()}); } finally { Date.now = realDate; Math.random = realRandom; }
});

/* ---------- lint ---------- */
test('lintIdea: every synthetic archetype and every produced idea passes', () => {
  for (const a of ARCHETYPES) assert.deepEqual(M.lintIdea(a), {ok: true, findings: []}, a.id);
  for (const r of [build(), build({mode: 'new', task: {workflow: '', description: 'bridge amendment effective date'}}), build({library: libFrom(ROWS)})]) for (const i of r.ideas) assert.deepEqual(M.lintIdea(i), {ok: true, findings: []}, i.archetypeId);
});
test('lintIdea finds each forbidden pattern and names the field', () => {
  const base = ARCHETYPES[0], codes = (over, opts) => M.lintIdea({...base, ...over}, opts).findings.map(f => f.code + '@' + f.field);
  assert.deepEqual(codes({wrongApproach: 'use the figure \u2014 quickly'}), ['guidance-unicode@wrongApproach'], 'a dash the guidance draft would silently clean is still reported');
  assert.deepEqual(codes({correctTreatment: 'follow the arrow \u2192 path'}), ['guidance-unicode@correctTreatment']);
  assert.deepEqual(codes({summary: 'the prompt names it'}), ['guidance-ai-mention@summary']);
  assert.deepEqual(codes({summary: 'an AI would see it'}), ['guidance-ai-mention@summary']);
  assert.deepEqual(codes({whyItHolds: 'the score is high'}), ['guidance-scoring-word@whyItHolds']);
  assert.deepEqual(codes({detection: 'check the grading note'}), ['guidance-scoring-word@detection']);
  assert.deepEqual(codes({consequence: 'no partial credit follows'}), ['guidance-scoring@consequence']);
  assert.deepEqual(codes({buildMoves: ['A second move.', 'Edit cell C9 directly.']}), ['guidance-cell-reference@buildMoves[1]']);
  assert.deepEqual(codes({buildMoves: ['Place it under gaf/inputs.csv.']}), ['guidance-jargon@buildMoves[0]']);
  assert.deepEqual(codes({consequence: 'a 10% swing'}), ['ui-percent@consequence']);
  assert.deepEqual(codes({name: 'A trap for the unwary'}), ['teaching-word@name']);
  assert.deepEqual(codes({summary: 'This pitfall appears.'}), ['teaching-word@summary']);
  assert.deepEqual(codes({summary: 'The pass rate is low.'}), ['ui-forbidden-word@summary']);
  assert.deepEqual(codes({summary: 'The failure rate is low.'}), ['ui-forbidden-word@summary']);
  assert.deepEqual(codes({summary: 'It is likely to repeat.'}), ['ui-forbidden-word@summary']);
  assert.deepEqual(codes({summary: 'It was caught early.'}), ['ui-forbidden-word@summary']);
  assert.deepEqual(codes({summary: 'Edit it. [hypothesis: edit before use]'}), ['scaffold-marker@summary']);
  assert.deepEqual(codes({correctTreatment: 'To apply the clause'}), ['splice-to@correctTreatment']);
  assert.deepEqual(codes({wrongApproach: 'GAAP treatment applies'}), ['splice-acronym@wrongApproach']);
  assert.deepEqual(codes({needs: ['a clause with a 5% cap']}), ['ui-percent@needs[0]']);
  assert.deepEqual(codes({howSolversGoWrong: ['read the prompt only']}), ['guidance-ai-mention@howSolversGoWrong[0]']);
  assert.deepEqual(codes({detection: undefined}), ['missing-field@detection']);
  assert.deepEqual(codes({buildMoves: []}), ['missing-field@buildMoves']);
  assert.deepEqual(codes({summary: 'Borealis is named here.'}, {extraJargon: ['Borealis']}), ['guidance-jargon@summary']);
  assert.deepEqual(codes({summary: 'Borealis is named here.'}), []);
  assert.deepEqual(M.lintIdea(null), {ok: false, findings: [{code: 'missing-field', field: 'idea', text: ''}]});
  assert.equal(M.lintIdea({...base, wrongApproach: 'use \u2014 it'}).ok, false);
  const withTitle = {...base, title: base.name}; delete withTitle.name;
  assert.equal(M.lintIdea(withTitle).ok, true, 'an Idea (title) as well as an archetype (name)');
  const noName = {...base}; delete noName.name;
  assert.deepEqual(M.lintIdea(noName).findings.map(f => f.code + '@' + f.field), ['missing-field@title']);
  assert.ok(M.lintIdea({...base, summary: 'the prompt'}).findings[0].text === 'prompt');
});
test('lintIdea builds the spliced sentences exactly as FinanceCore.generateGuidance does', () => {
  const idea = {...ARCHETYPES[3], wrongApproach: 'ignore the prompt wording', correctTreatment: 'give a score to each item', detection: 'check cell C9 for the gaf/ copy', consequence: 'the answer is a trap'};
  const p = C.blank();
  p.business = {objective: 'funding headroom for the planned payment', deliverable: 'an updated liquidity schedule', decision: 'whether the payment proceeds', prompt: ''};
  Object.assign(p.roots[0], {wrongInterpretation: idea.wrongApproach, correctInterpretation: idea.correctTreatment, detectionMethod: idea.detection, headlineWrong: idea.consequence});
  const g = C.generateGuidance(p), made = M.lintIdea(idea).findings.filter(f => f.code.startsWith('guidance-'));
  const fromGuidance = new Set(g.lint.map(x => x.code));
  for (const f of made) assert.ok(fromGuidance.has(f.code), f.code + ' is reported by generateGuidance as well');
  assert.deepEqual([...new Set(made.map(f => f.code))].sort(), [...fromGuidance].filter(c => c !== 'guidance-titled-section').sort());
  assert.ok(g.text.includes('A tempting mistake is to ignore the prompt wording. The correct treatment is to give a score to each item. To check it, check cell C9 for the gaf/ copy. If missed, the answer is a trap.'));
  const clean = {...ARCHETYPES[3]};
  p.roots[0].wrongInterpretation = clean.wrongApproach; p.roots[0].correctInterpretation = clean.correctTreatment; p.roots[0].detectionMethod = clean.detection; p.roots[0].headlineWrong = clean.consequence;
  const g2 = C.generateGuidance(p);
  assert.deepEqual(g2.lint, []);
  assert.ok(g2.text.includes('A tempting mistake is to ' + clean.wrongApproach + '. The correct treatment is to ' + clean.correctTreatment + '. To check it, ' + clean.detection + '. If missed, ' + clean.consequence + '.'));
});

/* ---------- hand-off to the task editor ---------- */
/* app.js needs a DOM; a vm context with a stand-in document runs the real FinanceAuthoring.addCandidate. */
function loadApp() {
  const any = () => {
    const handler = {
      get(t, k) {
        if (k === Symbol.toPrimitive) return () => ''; if (k === 'then') return undefined; if (k === 'length') return 0;
        if (['value', 'innerHTML', 'textContent', 'className', 'id'].includes(k)) return ''; if (k === 'dataset') return {}; if (k === 'files') return [];
        if (k === 'checked') return false; if (k === 'children' || k === 'childNodes' || k === 'querySelectorAll') return k === 'querySelectorAll' ? () => [] : [];
        if (k === 'classList') return {add() {}, remove() {}, toggle() {}, contains() { return false; }}; if (k === 'style') return {};
        if (k === 'closest') return () => null; if (k === 'getBoundingClientRect') return () => ({left: 0, right: 0, top: 0, bottom: 0});
        return proxy;
      }, set() { return true; }, apply() { return proxy; }, construct() { return proxy; }
    };
    const proxy = new Proxy(function () {}, handler);
    return proxy;
  };
  const store = {}, localStorage = {getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; }};
  const win = {localStorage, addEventListener() {}, removeEventListener() {}, location: {protocol: 'file:', hostname: ''}, crypto: crypto.webcrypto, setTimeout, clearTimeout, confirm: () => true};
  const document = any();
  document.querySelector = () => any(); document.querySelectorAll = () => []; document.addEventListener = () => {}; document.getElementById = () => any(); document.createElement = () => any();
  const ctx = {window: win, document, localStorage, navigator: {}, console, setTimeout, clearTimeout, Date, JSON, Math, Object, Array, String, Number, Boolean, Set, Map, Promise, Error, RegExp, Symbol, crypto: crypto.webcrypto, TextEncoder, TextDecoder, URL, Blob, confirm: () => true, alert() {}, location: win.location, requestAnimationFrame: () => 0, FormData: class {}};
  win.window = win; win.document = document;
  vm.createContext(ctx);
  for (const f of ['core.js', 'catalog.js', 'package-engine.js', 'candidate-engine.js', 'app.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, {filename: f});
  return win;
}
const anchoredIdea = (archetypeId, over = {}) => build(over).ideas.find(i => i.archetypeId === archetypeId);
test('toAuthoringProject: a valid single-root net-new project made only of the idea and its verified anchors', () => {
  const idea = anchoredIdea('ia-04'), project = PROJECT([{title: 'Bridge work', lane: 'historical', modeId: 'MODE-7'}]);
  const ap = M.toAuthoringProject(idea, {pkg: PKG(), project});
  assert.deepEqual(C.parseProject(ap), ap, 'parseProject accepts it and changes nothing');
  assert.equal(ap.kind, 'finance-task-design');
  assert.equal(ap.roots.length, 1);
  const r = ap.roots[0];
  assert.deepEqual([r.id, r.title, r.lane, r.mechanism, r.causalGroup, r.modeId, r.libraryRecord, r.reviewStatus], [idea.id, idea.title, 'net-new', 'cross_document_bridge', 'cg-ia-04', '', '', 'pending']);
  assert.deepEqual([r.governingRule, r.wrongInterpretation, r.correctInterpretation, r.detectionMethod, r.headlineWrong, r.triggeringCondition], [idea.whyItHolds, idea.wrongApproach, idea.correctTreatment, idea.detection, idea.consequence, idea.buildMoves[0]]);
  assert.deepEqual([r.expectedBehavior, r.classification, r.ambiguity, r.assumptions, r.resolution, r.acceptableVariations, r.toleranceRationale, r.headlineCorrect], ['', '', '', '', '', '', '', '']);
  assert.deepEqual(r.outputs, [], 'no invented number');
  assert.deepEqual(r.checks, {teaching: false, doubleCount: false, outcomeIrrelevant: false, unsupported: false});
  assert.equal(r.correctiveAction, idea.correctTreatment[0].toUpperCase() + idea.correctTreatment.slice(1) + '.', 'the corrective action is the correct treatment as a sentence');
  const paragraphs = r.facts.split('\n\n');
  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[0], 'Cash_Facts.csv Row 2: Opening balance | 100\nCash_Facts.csv Row 3: Bridge item | 50\nAtlas_Model.xlsx Bridge!A3: Reconciling item to bridge');
  assert.equal(paragraphs[1], 'Build: ' + idea.buildMoves.join(' '), 'the build moves are a labelled last paragraph');
  assert.equal(r.duplicateCheck, 'To confirm: nearest current modes: none found by keyword comparison.');
  assert.deepEqual(ap.sources.map(s => [s.id, s.file, s.cell, s.excerpt, s.suppliedToSolver, s.reviewStatus, s.version]), [
    ['anchor-0', 'Cash_Facts.csv', 'Row 2', 'Opening balance | 100', true, 'pending', 'sha256:' + PKG().documents[1].sha256],
    ['anchor-1', 'Cash_Facts.csv', 'Row 3', 'Bridge item | 50', true, 'pending', 'sha256:' + PKG().documents[1].sha256],
    ['anchor-2', 'Atlas_Model.xlsx', 'Bridge!A3', 'Reconciling item to bridge', true, 'pending', 'sha256:' + PKG().documents[2].sha256]]);
  assert.deepEqual(r.sourceIds, ['anchor-0', 'anchor-1', 'anchor-2']);
  assert.ok(!JSON.stringify(ap).includes('[hypothesis'));
  assert.deepEqual(M.toAuthoringProject(idea, {pkg: PKG(), project}), ap, 'deterministic: the stand-in ids from blank() are all replaced');
  const near = M.toAuthoringProject({...anchoredIdea('ia-02'), overlapWith: [{rootId: 'root-0', modeId: 'MODE-7', title: 'Bridge work', why: 'x'}, {rootId: 'root-1', title: 'Cut-off', why: 'y'}]}, {pkg: PKG()});
  assert.equal(near.roots[0].duplicateCheck, 'To confirm: nearest current modes: MODE-7 Bridge work; Cut-off.');
  const guess = M.toAuthoringProject(anchoredIdea('ia-04'), {pkg: PKG(), project: PROJECT([{title: 'Reconciling item missing from the bridge schedule', mechanism: 'cross_document_bridge'}])});
  assert.equal(guess.roots[0].duplicateCheck, 'To confirm: nearest current modes: Reconciling item missing from the bridge schedule.');
});
test('toAuthoringProject: anchors that do not verify, evaluator evidence and a missing package never become sources', () => {
  const idea = anchoredIdea('ia-04');
  const forged = {...idea, applicability: [
    {documentName: 'Grader_Notes.txt', locator: 'Line 1', quote: 'The answer key says the amendment supersedes the schedule, the cut off moved, rounding applies and the hidden sheet input is live.'},
    {documentName: 'Cash_Facts.csv', locator: 'Row 99', quote: 'not there'},
    {documentName: 'Cash_Facts.csv', locator: 'Row 2', quote: 'a different quote'},
    {documentName: 'Absent.txt', locator: 'Line 1', quote: 'x'},
    {documentName: 'Cash_Facts.csv', locator: 'Row 2', quote: 'Opening balance | 100'},
    {documentName: 'Cash_Facts.csv', locator: 'Row 2', quote: 'Opening balance | 100'},
    null, {documentName: '', locator: 'Row 1'}
  ]};
  const ap = M.toAuthoringProject(forged, {pkg: PKG()});
  assert.deepEqual(ap.sources.map(s => s.cell), ['Row 2']);
  assert.equal(ap.roots[0].facts.split('\n\n')[0], 'Cash_Facts.csv Row 2: Opening balance | 100');
  const twin = pkg([txt('Same.txt', ['gross margin']), txt('Same.txt', ['gross margin'])]);
  assert.deepEqual(M.toAuthoringProject({...idea, applicability: [{documentName: 'Same.txt', locator: 'Line 1', quote: 'gross margin'}]}, {pkg: twin}).sources, [], 'two documents with one name: the anchor is ambiguous and dropped');
  const withoutPkg = M.toAuthoringProject(idea, {});
  assert.deepEqual(withoutPkg.sources, []);
  assert.deepEqual(withoutPkg.roots[0].sourceIds, []);
  assert.ok(withoutPkg.roots[0].facts.startsWith('Cash_Facts.csv Row 2:'), 'without the package the idea is handed over as given, with no sources');
  const created = M.toAuthoringProject(build({mode: 'new'}).ideas[0], {});
  assert.deepEqual([created.sources, created.roots[0].sourceIds], [[], []]);
  assert.ok(created.roots[0].facts.startsWith('Build: '), 'a new-task idea has only the build paragraph');
  const gaf = pkg([txt('gaf/Atlas_Template.txt', ['The amendment has an effective date.'], {role: 'template'})]);
  const gafIdea = build({pkg: gaf}).ideas.find(i => i.archetypeId === 'ia-02');
  assert.equal(M.toAuthoringProject(gafIdea, {pkg: gaf}).sources[0].file, 'Atlas_Template.txt', 'a gaf folder never becomes part of the file name that guidance prints');
  assert.equal(M.toAuthoringProject(gafIdea, {pkg: gaf}).sources[0].title, 'gaf/Atlas_Template.txt Line 1');
  assert.throws(() => M.toAuthoringProject({}, {}), /needs an id and a title/);
  assert.throws(() => M.toAuthoringProject(null), /needs an id and a title/);
});
test('a trap ledger: coverage counts no net-new slot and buildIdeas prints no slot note; what the roots cover reads the same', () => {
  const roots = [{title: 'Cut-off', lane: 'net-new', causalGroup: 'cg-ia-03'}, {title: 'Rounded', lane: 'net-new', governingRule: 'The rounded inputs are used as shown.', mechanism: 'rounding_calibration'}, {title: 'Quillon work', lane: 'net-new'}];
  const trap = M.coverage(TRAP_PROJECT(roots), ARCHETYPES), set = M.coverage(PROJECT(roots), ARCHETYPES);
  assert.equal(trap.openNetNewSlots, null, 'a trap ledger has no slot limit');
  assert.equal(set.openNetNewSlots, -1);
  assert.deepEqual({...trap, openNetNewSlots: -1}, set, 'everything else is read the same way');
  const out = build({project: TRAP_PROJECT(roots)}), legacy = build({project: PROJECT(roots)});
  assert.ok(!out.notes.some(n => /slot/i.test(n)), 'no slot note: ' + out.notes.join(' | '));
  assert.ok(legacy.notes.includes('Open net-new slots in the current project: -1.'));
  assert.deepEqual(out.ideas.map(i => [i.archetypeId, i.status]), legacy.ideas.map(i => [i.archetypeId, i.status]));
  assert.equal(M.coverage(TRAP_PROJECT([]), ARCHETYPES).openNetNewSlots, null);
  assertClean(out, 'trap ledger');
});
test('toAuthoringProject into a trap ledger: no duplicate-check note; the decoy, the superseded version and the margin stay the author\'s', () => {
  const idea = anchoredIdea('ia-04'), roots = [{title: 'Reconciling item missing from the bridge schedule', mechanism: 'cross_document_bridge'}];
  const ap = M.toAuthoringProject(idea, {pkg: PKG(), project: TRAP_PROJECT(roots)}), legacy = M.toAuthoringProject(idea, {pkg: PKG(), project: PROJECT(roots)});
  assert.deepEqual(C.parseProject(ap), ap, 'parseProject accepts it and changes nothing');
  assert.deepEqual([ap.framework, legacy.framework], ['trap-ledger', 'failure-mode-set'], 'the project carries the framework it is made for');
  const r = ap.roots[0];
  assert.equal(r.duplicateCheck, '');
  assert.equal(legacy.roots[0].duplicateCheck, 'To confirm: nearest current modes: Reconciling item missing from the bridge schedule.');
  assert.deepEqual([r.decoy, r.superseded, r.margin], ['', '', '']);
  assert.equal(r.lane, 'net-new', 'the lane is kept; a trap ledger ignores it');
  const strip = p => ({...p, framework: '', roots: p.roots.map(x => ({...x, duplicateCheck: ''}))});
  assert.deepEqual(strip(ap), strip(legacy), 'nothing else differs');
  const named = M.toAuthoringProject({...idea, overlapWith: [{rootId: 'root-0', modeId: 'MODE-7', title: 'Bridge work', why: 'x'}]}, {pkg: PKG(), project: TRAP_PROJECT([])});
  assert.equal(named.roots[0].duplicateCheck, '', 'not even when the idea names an overlap');
  const codes = new Set(C.audit(ap).map(x => x.code));
  assert.ok(codes.has('trap-decoy') && !codes.has('duplicate-check'), 'the audit asks the author for the decoy');
  assert.equal(M.toAuthoringProject(idea, {pkg: PKG()}).framework, 'failure-mode-set', 'without a project the earlier reading holds');
});
test('toAuthoringProject writes no recorded score and no precedent text anywhere', () => {
  const rows = [['Zephyr line', 'quillon vellum mortise tale', 'quillon vellum built with zephyr', 'quillon fell text', '0.4137'], ['Zephyr line', 'amendment supersede effective date zephyr', 'zephyr built', 'zephyr fell', '0.0731']];
  const library = libFrom(rows);
  const out = M.buildIdeas({mode: 'existing', task: {workflow: 'Zephyr line', description: ''}, pkg: PKG(), project: null, library, archetypes: ARCHETYPES, now: 'x'});
  assert.ok(out.ideas.some(i => i.precedents.some(p => p.scoreText === '0.0731')), 'the precedents are on the idea');
  for (const idea of out.ideas) {
    const text = JSON.stringify(M.toAuthoringProject(idea, {pkg: PKG(), project: PROJECT([])}));
    for (const needle of ['0.4137', '0.0731', 'Zephyr', 'zephyr', 'quillon', 'p-0001', 'p-0002', library.hash]) assert.ok(!text.includes(needle), needle + ' in the project for ' + idea.archetypeId);
  }
});
test('the real FinanceAuthoring.addCandidate accepts an idea unchanged and keeps every field the idea carries', () => {
  const win = loadApp(), idea = anchoredIdea('ia-04'), project = win.FinanceAuthoring.getProject();
  assert.equal(project.framework, 'trap-ledger', 'a new editor holds a trap ledger');
  const ap = M.toAuthoringProject(idea, {pkg: PKG(), project});
  const id = win.FinanceAuthoring.addCandidate(PKG(), {id: idea.id, title: idea.title, authoringProject: ap});
  const merged = win.FinanceAuthoring.getProject();
  assert.equal(merged.roots.length, 2);
  const root = merged.roots.find(r => r.id === id), src = ap.roots[0];
  assert.notEqual(id, idea.id, 'the editor assigns its own id');
  for (const k of ['title', 'lane', 'mechanism', 'causalGroup', 'governingRule', 'facts', 'triggeringCondition', 'correctInterpretation', 'wrongInterpretation', 'detectionMethod', 'headlineWrong', 'duplicateCheck', 'expectedBehavior', 'classification', 'ambiguity', 'assumptions', 'resolution', 'acceptableVariations', 'toleranceRationale', 'headlineCorrect', 'modeId', 'libraryRecord', 'reviewStatus', 'decoy', 'superseded', 'margin']) assert.equal(root[k], src[k], k + ' survives the add path');
  assert.deepEqual([root.duplicateCheck, root.decoy, root.superseded, root.margin], ['', '', '', ''], 'no duplicate-check note in a trap ledger, and the decoy, the superseded version and the margin are the author\'s');
  assert.equal(root.correctiveAction, src.correctiveAction, 'the corrective action is kept, not replaced by the fallback');
  assert.equal(root.sourceIds.length, 3);
  assert.deepEqual(root.sourceIds.map(sid => merged.sources.find(s => s.id === sid).cell), ['Row 2', 'Row 3', 'Bridge!A3']);
  assert.deepEqual(merged.sources.map(s => s.version), ap.sources.map(s => s.version));
  assert.ok(merged.sources.every(s => s.suppliedToSolver && s.excerpt && s.authority));
  const mine = C.audit(merged).filter(x => x.rootId === id), codes = new Set(mine.map(x => x.code));
  // The project starts as a trap ledger (C.blank()), so the confident decoy is the author's to name as well.
  assert.deepEqual([...codes].sort(), ['anchor-incomplete', 'human-review', 'missing-acceptableVariations', 'missing-classification', 'missing-expectedBehavior', 'missing-headlineCorrect', 'missing-toleranceRationale', 'outputs-empty', 'source-unreviewed', 'trap-decoy'].sort(), 'only what the author must still supply');
  for (const never of ['group-empty', 'missing-governingRule', 'missing-facts', 'missing-correctInterpretation', 'missing-wrongInterpretation', 'missing-triggeringCondition', 'missing-detectionMethod', 'missing-correctiveAction', 'missing-headlineWrong', 'anchors-empty', 'source-unavailable', 'ambiguity', 'assumptions', 'scaffold-unedited', 'duplicate-check', 'same-root', 'mode-id-empty', 'mode-id-unlisted']) assert.ok(!codes.has(never), never);
  assert.ok(!mine.some(x => x.code.startsWith('manual-')));
  const p2 = JSON.parse(JSON.stringify(merged)); p2.business = {objective: 'funding headroom for the planned payment', deliverable: 'an updated liquidity schedule', decision: 'whether the payment proceeds', prompt: ''};
  const g = C.generateGuidance(C.parseProject(p2));
  assert.ok(g.text.includes('A tempting mistake is to ' + idea.wrongApproach + '. The correct treatment is to ' + idea.correctTreatment + '. To check it, ' + idea.detection + '. If missed, ' + idea.consequence + '.'), 'the four spliced sentences read as written');
  assert.ok(!/\bto to\b/i.test(g.text));
  assert.deepEqual(g.lint.filter(x => x.level === 'blocker'), []);
  assert.ok(!g.lint.some(x => ['guidance-ai-mention', 'guidance-scoring', 'guidance-scoring-word', 'guidance-jargon', 'guidance-unicode', 'guidance-vague', 'guidance-cell-reference'].includes(x.code)));
  /* once added, the idea is recognised as already covered by its causal group */
  const again = build({project: merged});
  assert.equal(again.ideas.find(i => i.archetypeId === 'ia-04').status, 'covered');
  assert.equal(again.ideas.find(i => i.archetypeId === 'ia-04').overlapWith[0].why, 'Same causal group as this idea.');
  assert.ok(!again.notes.some(n => /slot/i.test(n)), 'a trap ledger has no net-new slots to count');
  const second = win.FinanceAuthoring.addCandidate(PKG(), {id: idea.id, title: idea.title, authoringProject: ap});
  assert.notEqual(second, id);
  assert.equal(win.FinanceAuthoring.getProject().sources.length, 3, 'identical anchors merge instead of repeating');
});
test('into a failure-mode set the real addCandidate gets the duplicate-check note as before, and the slots are counted', () => {
  const win = loadApp(), idea = anchoredIdea('ia-04');
  win.FinanceAuthoring.loadProject({...C.blank(), framework: 'failure-mode-set'});
  const project = win.FinanceAuthoring.getProject();
  assert.equal(project.framework, 'failure-mode-set');
  const ap = M.toAuthoringProject(idea, {pkg: PKG(), project});
  assert.equal(ap.framework, 'failure-mode-set');
  const id = win.FinanceAuthoring.addCandidate(PKG(), {id: idea.id, title: idea.title, authoringProject: ap});
  const merged = win.FinanceAuthoring.getProject(), root = merged.roots.find(r => r.id === id);
  assert.equal(root.duplicateCheck, 'To confirm: nearest current modes: none found by keyword comparison.');
  const codes = new Set(C.audit(merged).filter(x => x.rootId === id).map(x => x.code));
  assert.deepEqual([...codes].sort(), ['anchor-incomplete', 'human-review', 'missing-acceptableVariations', 'missing-classification', 'missing-expectedBehavior', 'missing-headlineCorrect', 'missing-toleranceRationale', 'outputs-empty', 'source-unreviewed'].sort(), 'only what the author must still supply, and no decoy');
  assert.ok(build({project: merged}).notes.includes('Open net-new slots in the current project: 0.'), 'the blank first root and the added root are both net-new');
});
test('a new-task idea (no package) goes through the same path and leaves only the author items', () => {
  const win = loadApp(), idea = build({mode: 'new'}).ideas[0];
  const id = win.FinanceAuthoring.addCandidate(null, {id: idea.id, title: idea.title, authoringProject: M.toAuthoringProject(idea, {project: win.FinanceAuthoring.getProject()})});
  const merged = win.FinanceAuthoring.getProject(), codes = new Set(C.audit(merged).filter(x => x.rootId === id).map(x => x.code));
  assert.ok(codes.has('anchors-empty') && codes.has('outputs-empty') && codes.has('human-review'));
  assert.ok(!codes.has('missing-governingRule') && !codes.has('missing-triggeringCondition') && !codes.has('missing-correctiveAction') && !codes.has('duplicate-check'));
  assert.equal(merged.roots.find(r => r.id === id).causalGroup, idea.causalGroup);
});

/* ---------- vocabulary sweep ---------- */
test('leak sweep: no percent sign and no forbidden word in anything the model generates, while user text passes through verbatim', () => {
  const tainted = pkg([
    txt('Atlas_Summary.txt', ['Management summary: gross margin was 45% of sales and the pass rate note was caught late.', 'The amendment has an effective date and supersedes schedule 2.']),
    csv('Cash_Facts.csv', [['label', 'value'], ['Bridge 45%', '50'], ['Opening balance', '100']]),
    txt('Margin 45% case.txt', ['Rounded to the nearest thousand.'])
  ]);
  const library = libFrom([['Atlas 100%', 'gross margin 45% trap that was caught', 'built with a 12% haircut, pass rate unknown', 'likely to fail, failure rate high', '0.31'], ['Atlas', 'amendment supersede effective date', 'built', 'fell', '0.2']]);
  const project = PROJECT([{title: 'Amendment supersedes the pricing schedule', governingRule: 'effective date and amendment', lane: 'historical'}]);
  const runs = [
    M.buildIdeas({mode: 'existing', task: {workflow: 'Atlas 100%', description: 'a 45% case'}, pkg: tainted, project, library, archetypes: ARCHETYPES, now: 'x', limit: 100}),
    M.buildIdeas({mode: 'new', task: {workflow: 'Atlas', description: 'The amendment has an effective date and supersedes the schedule. Bridge to the opening balance.'}, pkg: null, project, library, archetypes: ARCHETYPES, now: 'x', limit: 100}),
    build(), build({pkg: null}), build({mode: 'new'}), build({project: TRAP_PROJECT([{title: 'Amendment supersedes the pricing schedule'}])})
  ];
  for (const out of runs) {
    assertClean(out, 'buildIdeas');
    for (const idea of out.ideas) {
      assertClean(M.lintIdea(idea), 'lintIdea');
      const ap = M.toAuthoringProject(idea, {pkg: tainted, project});
      const r = ap.roots[0];
      assertClean({title: ap.title, rootTitle: r.title, governingRule: r.governingRule, trigger: r.triggeringCondition, correct: r.correctInterpretation, wrong: r.wrongInterpretation, detection: r.detectionMethod, action: r.correctiveAction, headline: r.headlineWrong, build: r.facts.split('\n\n').pop()}, 'toAuthoringProject');
      assert.ok(r.duplicateCheck.startsWith('To confirm: nearest current modes: ') && !/%/.test(r.duplicateCheck));
    }
  }
  assertClean({TEXT: M.TEXT}, 'TEXT');
  const first = runs[0].ideas.find(i => i.archetypeId === 'ia-01');
  assert.ok(first.applicability.some(a => a.quote.includes('45%')), 'a package quote is passed through exactly as written');
  const shown = first.precedents.find(p => p.scoreText === '0.31');
  assert.ok(shown, 'the tainted precedent is one of the closest');
  assert.equal(shown.trap, 'gross margin 45 percent trap that was ...', 'a percent sign and a banned phrase are replaced, the rest stays as recorded');
  assert.equal(shown.workflow, 'Atlas 100 percent');
  assert.ok(first.buildMoves.every(m => !m.includes('%')), 'a label with a percent sign never reaches a build move');
  const flat = runs[0].ideas.find(i => i.archetypeId === 'ia-05');
  assert.deepEqual(flat.buildMoves, ARCHETYPES[4].buildMoves, 'a file name that fails the lint leaves the move generic');
  assert.ok(runs[0].ideas.every(i => i.applicability.every(a => a.documentName !== 'Margin 45% case.txt') || i.buildMoves.every(m => !m.includes('%'))));
  const bridge = runs[0].ideas.find(i => i.archetypeId === 'ia-04');
  assert.ok(bridge.buildMoves.every(m => !m.includes('45')), 'the unclean label is dropped and the plain reference is used');
  assert.match(bridge.buildMoves[0], /working in Cash_Facts\.csv at Row 2\.$/);
});

/* ---------- pipeline performance ---------- */
test('900 rows end to end: parse, label, retrieve and build ideas quickly', () => {
  const rnd = seeded(31337), vocab = 'revenue cost margin schedule agreement clause amount balance period entity group summary detail note table sheet input rate base price volume forecast actual budget variance accrual reserve cash debt equity facility payment due date closing opening ending report policy limit approved board gross net amendment bridge rounded subtotal perimeter'.split(' ');
  const text = n => Array.from({length: n}, () => vocab[Math.floor(rnd() * vocab.length)]).join(' ');
  const rows = Array.from({length: 900}, (_, i) => ['Branch ' + (i % 40), text(7), text(160), text(140), (Math.round(rnd() * 700) / 1000).toFixed(3)]);
  const t = Date.now();
  const library = M.parseLibraryCsv(toCsv([HEADER, ...rows]));
  library.labels = M.labelRows(library.rows, ARCHETYPES);
  assert.equal(library.rows.length, 900);
  const out = M.buildIdeas({mode: 'new', task: {workflow: 'Branch 3', description: 'The amendment and the bridge'}, pkg: null, project: null, library, archetypes: ARCHETYPES, now: 'x'});
  const withoutLabels = M.buildIdeas({mode: 'new', task: {workflow: 'Branch 3', description: 'The amendment and the bridge'}, pkg: null, project: null, library: {...library, labels: undefined}, archetypes: ARCHETYPES, now: 'x'});
  assert.deepEqual(out, withoutLabels, 'labels computed inside buildIdeas equal the ones passed in');
  assert.ok(out.ideas.every(i => i.precedents.length <= 3));
  assert.ok(Date.now() - t < 6000, 'pipeline took ' + (Date.now() - t) + ' ms');
});

/* ---------- the real catalog ---------- */
const real = {skip: REAL ? false : 'idea-archetypes.js is not present'};
const termText = a => [...a.signals.terms.slice(0, 4), ...arr2(a.signals.needsAll)].join('. ');
const arr2 = list => (Array.isArray(list) ? list : []).flatMap(e => (Array.isArray(e) ? e.slice(0, 1) : [e]));
test('real catalog: every archetype passes lintIdea and has unique ids and causal groups', real, () => {
  const list = REAL.archetypes;
  assert.ok(list.length >= 1);
  assert.equal(new Set(list.map(a => a.id)).size, list.length);
  assert.equal(new Set(list.map(a => a.causalGroup)).size, list.length);
  for (const a of list) assert.deepEqual(M.lintIdea(a), {ok: true, findings: []}, a.id);
});
test('real catalog: each archetype can be found from its own vocabulary, and only solver-visible documents count', real, () => {
  for (const a of REAL.archetypes) {
    const text = termText(a);
    const found = M.detectApplicability(pkg([txt('Atlas_Notes.txt', [text])]), REAL);
    assert.ok(a.id in found, a.id + ' is not found from its own terms: ' + text.slice(0, 120));
    assert.ok(found[a.id].evidence.length >= 1 && found[a.id].evidence.every(e => e.quote.length <= 300));
    assert.deepEqual(M.detectApplicability(pkg([txt('Atlas_Notes.txt', [text], {role: 'evaluator'})]), REAL), {}, a.id + ' never from an evaluator document');
  }
});
test('real catalog: ideas in both modes pass lintIdea, the vocabulary sweep and the ordering rules', real, () => {
  const text = REAL.archetypes.map(termText).join('\n').split('\n');
  const p = pkg([txt('Atlas_Notes.txt', text.slice(0, 20)), txt('Meridian_Notes.txt', text.slice(20)), csv('Cash_Facts.csv', [['label', 'value'], ...text.slice(0, 10).map(t => [t, '1'])])]);
  const library = libFrom(REAL.archetypes.map((a, i) => ['Atlas ' + (i % 5), a.name, a.summary + ' ' + a.whyItHolds, a.howSolversGoWrong.join('. '), (0.05 + (i % 9) / 10).toFixed(2)]));
  library.labels = M.labelRows(library.rows, REAL);
  for (const [mode, lib] of [['existing', null], ['existing', library], ['new', null], ['new', library]]) {
    const out = M.buildIdeas({mode, task: {workflow: 'Atlas 2', description: text[0]}, pkg: mode === 'existing' ? p : null, project: null, library: lib, archetypes: REAL, now: 'x', limit: 100});
    assert.equal(out.ideas.length, REAL.archetypes.length);
    assert.equal(out.inputs.archetypesVersion, REAL.version);
    assertClean(out, mode);
    for (const i of out.ideas) { assert.deepEqual(M.lintIdea(i), {ok: true, findings: []}, i.archetypeId); assert.deepEqual(Object.keys(i), IDEA_KEYS); assert.ok(i.precedents.length <= 3); }
    out.ideas.forEach((i, k) => { if (k) assert.ok(lexLess(mkey(out.ideas[k - 1], !!lib), mkey(i, !!lib)), mode + ' ' + i.archetypeId); });
    assert.equal(new Set(out.ideas.map(i => i.id)).size, out.ideas.length);
    assert.deepEqual(out, M.buildIdeas({mode, task: {workflow: 'Atlas 2', description: text[0]}, pkg: mode === 'existing' ? p : null, project: null, library: lib, archetypes: REAL, now: 'x', limit: 100}));
    if (mode === 'existing') assert.ok(out.ideas.some(i => i.status === 'anchored'));
  }
  const labels = library.labels;
  assert.equal(labels.coverage.labelled + labels.coverage.unlabelled, REAL.archetypes.length);
  assert.ok(Object.values(labels.labels).every(l => l.archetypeId === null || REAL.archetypes.some(a => a.id === l.archetypeId)));
});
test('real catalog: every idea converts, is accepted by the real addCandidate and drafts clean guidance', real, () => {
  const win = loadApp();
  const p = pkg([txt('Atlas_Notes.txt', REAL.archetypes.map(termText))]);
  const out = M.buildIdeas({mode: 'existing', task: {workflow: '', description: ''}, pkg: p, project: null, library: null, archetypes: REAL, now: 'x', limit: 100});
  for (const idea of out.ideas) {
    const ap = M.toAuthoringProject(idea, {pkg: p, project: win.FinanceAuthoring.getProject()});
    assert.deepEqual(C.parseProject(ap), ap, idea.archetypeId);
    const id = win.FinanceAuthoring.addCandidate(p, {id: idea.id, title: idea.title, authoringProject: ap});
    const merged = win.FinanceAuthoring.getProject(), root = merged.roots.find(r => r.id === id);
    assert.equal(root.causalGroup, idea.causalGroup);
    assert.equal(root.mechanism, idea.mechanism);
    const codes = new Set(C.audit(merged).filter(x => x.rootId === id).map(x => x.code));
    for (const never of ['group-empty', 'missing-governingRule', 'missing-facts', 'missing-correctInterpretation', 'missing-wrongInterpretation', 'missing-triggeringCondition', 'missing-detectionMethod', 'missing-correctiveAction', 'missing-headlineWrong', 'source-unavailable', 'ambiguity', 'scaffold-unedited', 'duplicate-check']) assert.ok(!codes.has(never), idea.archetypeId + ' ' + never);
    const g = C.generateGuidance(C.parseProject({...JSON.parse(JSON.stringify(merged)), roots: [JSON.parse(JSON.stringify(root))], business: {objective: 'funding headroom for the planned payment', deliverable: 'an updated liquidity schedule', decision: 'whether the payment proceeds', prompt: ''}}));
    assert.deepEqual(g.lint.filter(x => x.level === 'blocker'), [], idea.archetypeId);
    assert.ok(!/\bto to\b/i.test(g.text), idea.archetypeId);
  }
});

/* ---------- robustness ---------- */
test('junk rows, odd documents and odd catalogs never throw', () => {
  const rows = [null, 'x', 5, {trap: 'no id here'}, ...LIB().rows];
  assert.doesNotThrow(() => M.labelRows(rows, ARCHETYPES));
  assert.deepEqual(Object.keys(M.labelRows(rows, ARCHETYPES).labels), LIB().rows.map(r => r.id), 'rows without an id are skipped');
  assert.doesNotThrow(() => M.retrieve(rows, 'amendment effective date'));
  assert.equal(M.retrieve(rows, 'amendment effective date')[0].row.id, 'p-0002');
  const odd = pkg([doc('Atlas_Odd.txt', 'txt', [null, 3, {locator: 'Line 1'}, {locator: 'Line 2', text: 7}, {text: 'the amendment', locator: 'Line 3'}, {text: 'bridge'}]), {id: 'x'}, null].filter(Boolean));
  odd.documents.push(null, 5);
  assert.doesNotThrow(() => M.buildIdeas({mode: 'existing', task: {}, pkg: odd, project: {roots: [null, 4, {}]}, library: {rows: [null, {id: 'p-1', trap: 'amendment'}], hash: 3}, archetypes: ARCHETYPES, now: 'x'}));
  assert.doesNotThrow(() => M.buildIdeas({mode: 'new', archetypes: [null, {id: 'x'}, {id: 'y', name: 'Y', signals: 3}, ...ARCHETYPES], now: 'x'}));
  assert.equal(M.buildIdeas({mode: 'new', archetypes: [null, {id: 'x'}], now: 'x'}).ideas.length, 0);
  assert.doesNotThrow(() => M.coverage({roots: [{title: 5, lane: 'net-new', governingRule: null}]}, ARCHETYPES));
  const out = M.buildIdeas({mode: 'existing', task: null, pkg: PKG(), project: undefined, library: undefined, archetypes: ARCHETYPES, now: undefined});
  assert.equal(out.generatedAt, null);
  assert.equal(out.ideas.length, 8);
});
test('a file name or label that fails the lint never reaches a build move; an ambiguous anchor is not offered', () => {
  const named = pkg([txt('prompt notes.txt', ['The amendment has an effective date and supersedes schedule 2.']), txt('Atlas_Notes.txt', ['Gross margin and net margin differ.'])]);
  const out = build({pkg: named, limit: 100});
  const amend = out.ideas.find(i => i.archetypeId === 'ia-02'), margin = out.ideas.find(i => i.archetypeId === 'ia-01');
  assert.deepEqual(amend.buildMoves, ARCHETYPES[1].buildMoves, 'the word "prompt" in a file name would fail the lint: the move stays generic');
  assert.equal(amend.applicability[0].documentName, 'prompt notes.txt', 'the anchor itself is still offered, as the person\'s own file name');
  assert.match(margin.buildMoves[0], /working in Atlas_Notes\.txt at Line 1\.$/);
  const twin = pkg([txt('Same.txt', ['The amendment has an effective date.']), txt('Same.txt', ['The amendment has an effective date.'])]);
  const t = build({pkg: twin, limit: 100}).ideas.find(i => i.archetypeId === 'ia-02');
  assert.deepEqual([t.status, t.applicability, t.anchored], ['needs-evidence', [], false], 'two documents with one name: the record cannot be told apart, so no anchor');
});
test('a record that carries the draft tool marker is never cited', () => {
  const p = pkg([txt('Atlas_Notes.txt', ['The amendment has an effective date. [hypothesis: edit before use]', 'The amendment is restated.'])]);
  const d = M.detectApplicability(p, ARCHETYPES);
  assert.deepEqual(d['ia-02'].evidence.map(e => e.locator), ['Line 2']);
  assert.ok(!JSON.stringify(build({pkg: p, limit: 100})).includes('[hypothesis'));
});
test('browser load: with no module system the script attaches FinanceIdeasModel to window and finds the core and the engine there', () => {
  const win = {}, ctx = {window: win, TextEncoder, TextDecoder, crypto: crypto.webcrypto, console};
  vm.createContext(ctx);
  for (const f of ['core.js', 'package-engine.js', 'ideas-model.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, {filename: f});
  const W = win.FinanceIdeasModel;
  assert.deepEqual(Object.keys(W).sort(), Object.keys(M).sort());
  const input = {mode: 'existing', task: {workflow: 'Reporting', description: ''}, pkg: PKG(), project: null, library: null, archetypes: ARCHETYPES, now: 'x'};
  const out = W.buildIdeas(input);
  assert.equal(JSON.stringify(out), JSON.stringify(M.buildIdeas(input)), 'the same ideas, including the verified anchors and the lint-checked build moves');
  assert.equal(JSON.stringify(W.toAuthoringProject(out.ideas[1], {pkg: PKG()})), JSON.stringify(M.toAuthoringProject(M.buildIdeas(input).ideas[1], {pkg: PKG()})));
  assert.equal(W.lintIdea(ARCHETYPES[0]).ok, true);
  assert.equal(W.parseLibraryCsv(CSV).hash, digest(CSV));
});
