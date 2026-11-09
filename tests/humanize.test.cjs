'use strict';
/* src/humanize: the secretary, the chunker, the masks, the repair workers, the orchestrator's loops, the GPTZero worker, the key store,
   the companion's /api/humanize routes and the CLI. No network, no browser, no model: providers are scripted fakes or the offline stubs.
   The Verva worker in a real Chromium is tests/humanize-browser.cjs. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { brief, findFacts } = require('../src/humanize/secretary.cjs');
const { parseUnits, splitSentences } = require('../src/humanize/text.cjs');
const { segment, assemble, splitReturned } = require('../src/humanize/chunks.cjs');
const { maskSegments, unmask, choosePrefix, normalizeKeys } = require('../src/humanize/mask.cjs');
const { repairSegment } = require('../src/humanize/repair.cjs');
const { runHumanize, settingsOf } = require('../src/humanize/orchestrator.cjs');
const { stubRewriter, stubDetector } = require('../src/humanize/providers/stub.cjs');
const { createGptZero, readAnswer } = require('../src/humanize/providers/gptzero.cjs');
const { createKeyStore } = require('../src/humanize/keys.cjs');
const { createHumanizeService } = require('../src/humanize/service.cjs');
const { redactHumanizeData } = require('../src/humanize/redact.cjs');
const { validateUrl, cleanConfig } = require('../src/humanize/providers/verva-web.cjs');
const { HumanizeError } = require('../src/humanize/errors.cjs');
const C = require('../src/humanize/constants.cjs');
const { createServer } = require('../backend/server.cjs');
const cli = require('../src/humanize/cli.cjs');

const REPO = path.resolve(__dirname, '..');

const DOC = [
  '# Q3 FY2025 update',
  '',
  'Northwind Capital (the "Company") reported Net Revenue of $4.1m in Q3 2025, up 12% year on year. EBITDA margin fell 150 bps to 21.4%, while net leverage did not breach the 3.5x covenant. Moreover, it is important to note that operating margin expanded and operating margin remains a key focus for the Senior Secured Notes holders.',
  '',
  '- Cash on hand: $12,000,000 as of 2025-09-30',
  '- Interest coverage 2.1x vs 1.75x minimum',
  '- See Northwind_Q3.xlsx for the bridge',
  '',
  'Management said "we are on track" and expects revenue to grow 8–10% in FY2026. The U.S. business was not affected and the team does not expect any change.',
  '',
].join('\n');

const figuresOf = text => findFacts(text).map(f => f.text).sort();

/* ------------------------------------------------------------------ secretary */

test('secretary: every figure keeps its basis (currency, percent, bps, multiple, date, period, range)', () => {
  const b = brief(DOC);
  const basis = Object.fromEntries(b.facts.map(f => [f.text, f.basis]));
  assert.equal(basis['$4.1m'], 'currency');
  assert.equal(basis['$12,000,000'], 'currency');
  assert.equal(basis['12%'], 'percent');
  assert.equal(basis['8–10%'], 'percent', 'a range keeps the unit of its end');
  assert.equal(basis['150 bps'], 'bps');
  assert.equal(basis['3.5x'], 'multiple');
  assert.equal(basis['2.1x'], 'multiple');
  assert.equal(basis['2025-09-30'], 'date');
  assert.equal(basis['Q3 2025'], 'period');
  assert.equal(basis.FY2026, 'period');
  assert.equal(basis['21.4%'], 'percent');
  assert.ok(!b.facts.some(f => f.text.endsWith('.')), 'a sentence period is never part of a figure');
});

test('secretary: the terminology lock holds defined terms, acronyms, proper names, quotes, files and watched phrases', () => {
  const kinds = Object.fromEntries(brief(DOC).terms.map(t => [t.text, t.kind]));
  assert.equal(kinds['"Company"'], 'quote');
  assert.equal(kinds.EBITDA, 'acronym');
  assert.equal(kinds['Northwind Capital'], 'proper');
  assert.equal(kinds['Net Revenue'], 'proper');
  assert.equal(kinds['Senior Secured Notes'], 'proper');
  assert.equal(kinds['Northwind_Q3.xlsx'], 'file');
  assert.equal(kinds['"we are on track"'], 'quote');
  assert.equal(kinds['operating margin'], 'watch', 'a repeated lower-case finance phrase is watched, not masked');
  assert.ok(!('U' in kinds) && !('S' in kinds), 'the letters of U.S. are not terms');
  assert.ok(!('Interest' in kinds), 'the first word of a bullet is not a proper name');
  assert.ok(!('Moreover' in kinds), 'a sentence-initial word is not a term');
});

test('secretary: the noun-verb map binds each figure to its subject, verb, direction and negation', () => {
  const rows = brief(DOC).bindings;
  const by = fact => rows.find(r => r.facts.includes(fact));
  assert.equal(by('150 bps').subject, 'margin');
  assert.equal(by('150 bps').direction, 'down');
  assert.deepEqual(by('150 bps').facts, ['150 bps', '21.4%']);
  assert.equal(by('3.5x').subject, 'leverage');
  assert.equal(by('3.5x').negated, true);
  assert.equal(by('$4.1m').direction, 'up');
  assert.equal(by('8–10%').verb, 'expects');
});

/* ------------------------------------------------------------------ blocks, chunks, masks */

test('blocks: headings, bullets, tables and code are told apart; bullets and paragraphs are rewritable', () => {
  const text = '# Title\n\nA paragraph that\nwraps over two lines.\n\n- one bullet\n  continued here\n- two\n\n| a | b |\n\n```\ncode 1\n```\nKey points:\n';
  const units = parseUnits(text).map(u => [u.type, text.slice(u.start, u.end)]);
  assert.deepEqual(units, [
    ['heading', '# Title'],
    ['paragraph', 'A paragraph that\nwraps over two lines.'],
    ['bullet', 'one bullet\n  continued here'],
    ['bullet', 'two'],
    ['table', '| a | b |'],
    ['code', '```\ncode 1\n```'],
    ['heading', 'Key points:'],
  ]);
});

test('sentences: abbreviations, initials and decimals do not end a sentence', () => {
  const s = splitSentences('Revenue was $4.1m in the U.S. market. J. Smith, the CFO, agreed. Costs rose vs. plan! Done?').map(x => x.text);
  assert.deepEqual(s, ['Revenue was $4.1m in the U.S. market.', 'J. Smith, the CFO, agreed.', 'Costs rose vs. plan!', 'Done?']);
});

test('chunks: the document is rebuilt byte for byte; prose and other blocks get their own bars; short prose merges', () => {
  const { segments, chunks } = segment(DOC);
  assert.equal(assemble(segments), DOC, 'joining the segments gives back the source');
  assert.deepEqual(chunks.map(c => [c.kind, c.bar, c.segmentIds.length]), [['prose', 0.9, 1], ['other', 0.7, 3], ['prose', 0.9, 1]]);
  assert.ok(segments.find(s => s.kind === 'fixed' && s.text.includes('# Q3 FY2025 update')), 'the heading ships as written');
  const short = 'Revenue grew because pricing held and the mix improved overall.\n\nCosts fell because the team cut travel and moved two vendors.\n';
  assert.equal(segment(short).chunks.length, 1, 'two short prose paragraphs travel as one chunk');
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i + 1} explains one more part of the plan in plain words.`).join(' ');
  const cut = segment(long, { maxChunkWords: 100 });
  assert.ok(cut.chunks.length > 1, 'a long paragraph is cut at sentence boundaries');
  assert.equal(assemble(cut.segments), long);
});

test('chunks: a multi-segment answer is cut back only when the paragraph count matches', () => {
  assert.deepEqual(splitReturned('one\n\ntwo', 2), ['one', 'two']);
  assert.deepEqual(splitReturned('one\ntwo', 2), ['one', 'two']);
  assert.equal(splitReturned('one two', 2), null);
  assert.deepEqual(splitReturned('line\nwrapped', 1), ['line wrapped']);
});

test('masks: one key per occurrence, unknown digits masked too, exact round trip, near-miss keys normalised', () => {
  const b = brief('Revenue was $4.1m and then $4.1m again, with 7 sites.');
  const { masked, map } = maskSegments(['Revenue was $4.1m and then $4.1m again, with 7 sites.'], b.tokens, { prefix: 'K' });
  assert.equal(masked[0], 'Revenue was K01 and then K02 again, with K03 sites.');
  assert.equal(map.K01.text, '$4.1m');
  assert.equal(map.K02.text, '$4.1m');
  assert.equal(map.K03.basis, 'number');
  assert.equal(unmask(masked[0], map, 'K'), 'Revenue was $4.1m and then $4.1m again, with 7 sites.');
  assert.ok(!/\d/.test(masked[0].replace(/K\d{2}/g, '')), 'no bare digit reaches the rewriter');
  assert.equal(normalizeKeys('k01 and K-02 and K 03 and K99', map, 'K'), 'K01 and K02 and K03 and K99');
  assert.equal(choosePrefix('see K01 in the memo'), 'Q', 'a source that already holds K01 gets another prefix');
});

/* ------------------------------------------------------------------ repair */

const SRC = 'Revenue rose 12% to $4.1m in Q3 2025, while EBITDA margin fell 150 bps to 21.4%. Net leverage did not breach the 3.5x covenant. The team remains focused on cash.';
function masked(text = SRC) {
  const { masked: m, map } = maskSegments([text], brief(text).tokens, { prefix: 'K' });
  return { src: m[0], map, ctx: { map, prefix: 'K', maxLengthDrift: 0.5, watch: [] } };
}

test('repair: a rewrite that keeps every figure, subject, negation and direction passes untouched', () => {
  const { src, map, ctx } = masked();
  const cand = 'Revenue climbed K01 and reached K02 in K03. Meanwhile, K04 margin dropped K05 to K06. Net leverage stayed clear of the K07 covenant and did not breach it. The team is still focused on cash.';
  const r = repairSegment(src, cand, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.splices.length, 0);
  assert.equal(unmask(r.text, map, 'K'), 'Revenue climbed 12% and reached $4.1m in Q3 2025. Meanwhile, EBITDA margin dropped 150 bps to 21.4%. Net leverage stayed clear of the 3.5x covenant and did not breach it. The team is still focused on cash.');
});

for (const [name, change, code] of [
  ['a flipped negation', s => s.replace('did not breach', 'breached'), 'negation'],
  ['a reversed direction', s => s.replace('fell', 'rose'), 'direction'],
  ['a changed basis', s => s.replace('K05 to', 'K05 percent to'), 'basis'],
  ['a dropped figure', s => s.replace(' in K03', ''), 'dropped'],
  ['a duplicated figure', s => s.replace('The team', 'The K07 team'), 'duplicated'],
  ['an invented number', s => s.replace('on cash.', 'on cash, 5 days a week.'), 'invented'],
  ['first person where the source has none', s => s.replace('The team remains', 'We remain'), 'first-person'],
  ['a lost subject', s => s.replace('Net leverage did', 'It did'), 'subject'],
]) {
  test(`repair: ${name} is put back by splicing the source sentence in`, () => {
    const { src, map, ctx } = masked();
    const r = repairSegment(src, change(src), ctx);
    assert.equal(r.ok, true, r.reason || '');
    assert.ok(r.splices.some(s => s.codes.includes(code)), `spliced for ${code}: ${JSON.stringify(r.splices.map(s => s.codes))}`);
    const out = unmask(r.text, map, 'K');
    assert.deepEqual(figuresOf(out), figuresOf(SRC), 'every source figure, once');
    assert.ok(out.includes('did not breach the 3.5x covenant'));
    assert.ok(out.includes('The team remains focused on cash.'), 'a sentence without a key is never lost');
  });
}

test('repair: two figures swapped between subjects are caught', () => {
  const { src, ctx } = masked();
  const swapped = 'Revenue rose K05 to K06 in K03, while K04 margin fell K01 to K02. Net leverage did not breach the K07 covenant. The team remains focused on cash.';
  const r = repairSegment(src, swapped, ctx);
  assert.ok(r.splices.length >= 1, 'the swap is repaired');
  assert.equal(r.text, src);
});

test('repair: an unknown placeholder or a large length change rejects the pass', () => {
  const { src, ctx } = masked();
  assert.equal(repairSegment(src, `${src} K99`, ctx).ok, false);
  const long = repairSegment(src, `${src} ${'And the plan keeps going on and on. '.repeat(8)}`, { ...ctx, maxLengthDrift: 0.15 });
  assert.equal(long.ok, false);
  assert.match(long.reason, /longer or shorter/);
});

test('repair: a locked term retyped in another case is written back the locked way', () => {
  const text = 'The Senior Secured Notes were refinanced in full during the quarter.';
  const { src, map, ctx } = masked(text);
  const r = repairSegment(src, `${src.replace('were refinanced in full', 'were fully refinanced')} The senior secured notes holders agreed.`, { ...ctx, maxLengthDrift: 1 });
  assert.equal(r.ok, true);
  assert.ok(r.fixes.some(f => f.code === 'term-case'));
  assert.match(unmask(r.text, map, 'K'), /The Senior Secured Notes holders agreed\./);
});

/* ------------------------------------------------------------------ orchestrator */

/* A scripted detector: scores by a function of the text, and records every scan. */
function fakeDetector(score, extra = {}) {
  const seen = [];
  return { id: 'fake', label: 'Fake detector', estimate: false, seen, ...extra, async scan(text) { seen.push(text); const r = score(text, seen.length); return typeof r === 'number' ? { human: r, sentences: [] } : r; } };
}
function fakeRewriter(edit, extra = {}) {
  const seen = [];
  return { id: 'fake', label: 'Fake rewriter', seen, ...extra, async rewrite(text) { seen.push(text); return edit(text, seen.length); } };
}
const PROSE = 'The quarter went well and revenue rose 12% to $4.1m as pricing held. Margin fell 150 bps to 21.4%, but leverage did not breach the 3.5x covenant. The team plans to keep costs flat next year.';

test('orchestrator: a text already above its bars is deposited as written, with no rewrite', async () => {
  const rw = fakeRewriter(t => t);
  const r = await runHumanize(DOC, { rewriter: rw, detector: fakeDetector(() => 0.95) });
  assert.equal(r.status, 'passed');
  assert.equal(r.signedOff, true);
  assert.equal(rw.seen.length, 0);
  assert.equal(r.final, DOC);
  assert.equal(r.calls.scan, 3, 'one baseline scan per chunk');
});

test('orchestrator: a chunk that reaches 90% on its second pass is deposited, and the aggregate signs the run off', async () => {
  const rw = fakeRewriter((t, n) => (n === 1 ? t.replace('went well', 'went fine') : t.replace('went fine', 'went great')));
  const det = fakeDetector((text, n) => (n === 1 ? 0.3 : n === 2 ? 0.6 : 0.93));
  const r = await runHumanize(PROSE, { rewriter: rw, detector: det });
  assert.equal(r.status, 'passed');
  assert.equal(r.chunks[0].status, 'passed');
  assert.deepEqual(r.chunks[0].passes.map(p => [p.kind, p.human]), [['baseline', 0.3], ['rewrite', 0.6], ['rewrite', 0.93]]);
  assert.deepEqual(figuresOf(r.final), figuresOf(PROSE));
  assert.equal(r.aggregate.human, 0.93);
});

test('orchestrator: the rewriter only ever sees masked text', async () => {
  const rw = fakeRewriter(t => t.replace('went well', 'went fine'));
  await runHumanize(DOC, { rewriter: rw, detector: fakeDetector(t => (t.includes('went fine') ? 0.95 : 0.2)), options: { maxRounds: 1, maxPasses: 1 } });
  assert.ok(rw.seen.length > 0);
  for (const sent of rw.seen) {
    assert.ok(!/\d/.test(sent.replace(/K\d{2,}/g, '')), `no figure reaches the rewriter: ${sent}`);
    for (const term of ['EBITDA', 'Northwind', 'Net Revenue', 'Senior Secured Notes']) assert.ok(!sent.includes(term), `${term} is masked`);
  }
});

test('orchestrator: second passes send only the flagged sentences (generated_prob >= 0.80)', async () => {
  const sentences = splitSentences(PROSE).map(s => s.text);
  const det = fakeDetector((text, n) => ({ human: n === 1 ? 0.4 : 0.5, sentences: splitSentences(text).map((s, i) => ({ text: s.text, generatedProb: i === 1 ? 0.95 : 0.1 })) }));
  const rw = fakeRewriter(t => t.replace('The quarter went well', 'It was a good quarter').replace('but leverage', 'though leverage'));
  await runHumanize(PROSE, { rewriter: rw, detector: det, options: { maxRounds: 1, maxPasses: 1 } });
  assert.equal(rw.seen.length, 1, 'the first pass after the baseline already has readings: only the flagged span goes');
  assert.ok(rw.seen[0].includes('leverage') && !rw.seen[0].includes('quarter'), `only sentence 2 was sent: ${rw.seen[0]}`);
  assert.equal(sentences.length, 3);
});

test('orchestrator: a chunk that cannot reach its bar is respliced and the run ends below the bar with every fact intact', async () => {
  const text = `${PROSE}\n\n${PROSE.replace('The quarter', 'The year').replace('next year', 'next quarter')}\n`;
  const det = fakeDetector(() => 0.5);
  let k = 0;
  const rw = fakeRewriter(t => { k += 1; return t.replace(/\bteam\b/g, k % 2 ? 'group' : 'crew'); });
  const r = await runHumanize(text, { rewriter: rw, detector: det, options: { maxRounds: 2, maxPasses: 3, minChunkWords: 200 } });
  assert.equal(r.status, 'below-bar');
  assert.equal(r.aggregate.history.length, 2);
  assert.ok(r.chunks.some(c => c.parent === 'c1'), 'the two-paragraph chunk was respliced into one chunk per paragraph');
  assert.deepEqual(figuresOf(r.final), figuresOf(text));
  assert.ok(r.log.some(l => /respliced/.test(l.text)));
});

test('orchestrator: a rewriter that drops or invents figures never ships them', async () => {
  const rw = fakeRewriter(t => t.replace(/K0[12]\b/g, '').replace('flat', 'flat for 9 months'));
  const r = await runHumanize(PROSE, { rewriter: rw, detector: fakeDetector(() => 0.95 - 0.6), options: { maxRounds: 1 } });
  assert.deepEqual(figuresOf(r.final), figuresOf(PROSE));
  assert.ok(!r.final.includes('9 months'));
});

test('orchestrator: stages run in lock step: every rewrite of a pass finishes before its first scan', async () => {
  const order = [];
  const text = 'Alpha team members did the first part of the work this week and it went fine for all.\n\n# Break\n\nBeta team members did the second part of the work this week and it went fine for all.\n';
  const rw = { id: 'r', async rewrite(t) { order.push('rewrite'); await new Promise(r => setTimeout(r, 5)); return t.replace('went fine', 'went well'); } };
  const det = { id: 'd', async scan() { order.push('scan'); return { human: 0.5, sentences: [] }; } };
  await runHumanize(text, { rewriter: rw, detector: det, options: { maxRounds: 1, maxPasses: 1, workers: 2 } });
  assert.deepEqual(order, ['scan', 'scan', 'rewrite', 'rewrite', 'scan', 'scan']);
});

test('orchestrator: more workers per field give the same result as one', async () => {
  const text = Array.from({ length: 5 }, (_, i) => `Team ${String.fromCharCode(65 + i)} finished part of the job this week and it went fine overall.\n\n## Part\n`).join('\n');
  const make = () => ({
    rw: { id: 'r', async rewrite(t) { await new Promise(r => setTimeout(r, 20 - t.length % 17)); return t.replace('went fine', 'went well'); } },
    det: { id: 'd', async scan(t) { return { human: t.includes('went well') ? 0.95 : 0.4, sentences: [] }; } },
  });
  const one = make();
  const four = make();
  const a = await runHumanize(text, { rewriter: one.rw, detector: one.det, options: { workers: 1 }, now: () => 't' });
  const b = await runHumanize(text, { rewriter: four.rw, detector: four.det, options: { workers: 4 }, now: () => 't' });
  assert.equal(a.final, b.final);
  assert.deepEqual(a.chunks.map(c => c.passes), b.chunks.map(c => c.passes));
});

test('orchestrator: the call cap, a stop, a sign-in wall and an estimate detector each end the run plainly', async () => {
  const budget = await runHumanize(PROSE, { rewriter: fakeRewriter((t, n) => t.replace(/went \w+/, `went ${['fine', 'great', 'okay'][n % 3]}`)), detector: fakeDetector(() => 0.2), options: { maxRewriteCalls: 2 } });
  assert.equal(budget.status, 'budget');
  assert.match(budget.error, /cap of 2 rewriter calls/);
  assert.deepEqual(figuresOf(budget.final), figuresOf(PROSE));

  const controller = new AbortController();
  const stopped = await runHumanize(PROSE, { rewriter: fakeRewriter(t => { controller.abort(); return t; }), detector: fakeDetector(() => 0.2), signal: controller.signal });
  assert.equal(stopped.status, 'cancelled');

  const wall = await runHumanize(PROSE, { rewriter: { id: 'v', async preflight() { throw new HumanizeError('Verva asks you to sign in.', 'needs-sign-in', 409); }, async rewrite(t) { return t; } }, detector: fakeDetector(() => 0.2) });
  assert.equal(wall.status, 'needs-sign-in');
  assert.equal(wall.final, PROSE);

  const estimate = await runHumanize(PROSE, { rewriter: stubRewriter(), detector: { ...stubDetector(), scan: async () => ({ human: 0.99, sentences: [] }) } });
  assert.equal(estimate.status, 'passed');
  assert.equal(estimate.signedOff, false, 'an estimate never signs a run off');
});

test('orchestrator: the offline stubs run the whole network end to end', async () => {
  const r = await runHumanize(DOC, { rewriter: stubRewriter(), detector: stubDetector() });
  assert.ok(C.ENDED.includes(r.status));
  assert.deepEqual(figuresOf(r.final), figuresOf(DOC));
  assert.ok(r.final.startsWith('# Q3 FY2025 update\n\n'), 'the heading ships as written');
  assert.ok(r.final.includes('- Cash on hand: $12,000,000 as of 2025-09-30'), 'the bullet markers stay');
  assert.ok(!r.final.includes('it is important to note'), 'the stub removed a stock phrase');
});

test('orchestrator: settings are clamped to their allowed ranges', () => {
  const s = settingsOf({ maxPasses: 99, maxRounds: 0, workers: 9, bars: { prose: 2, other: 0.5 } });
  assert.equal(s.maxPasses, C.LIMITS.maxPasses);
  assert.equal(s.maxRounds, C.LIMITS.maxRounds);
  assert.deepEqual(s.workers, { rewrite: 1, scan: 1 });
  assert.deepEqual(s.bars, { prose: 0.9, other: 0.5, aggregate: 0.8 });
});

/* ------------------------------------------------------------------ GPTZero and keys */

function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
  };
  fn.calls = calls;
  return fn;
}
const keysWith = key => ({ get: async () => ({ key, source: key ? 'env' : null, error: null }) });

test('gptzero: reads the human probability and the per-sentence readings; the key goes only in x-api-key', async () => {
  const body = { documents: [{ class_probabilities: { human: 0.82, ai: 0.1, mixed: 0.08 }, predicted_class: 'human', confidence_category: 'high', sentences: [{ sentence: 'One.', generated_prob: 0.1 }, { sentence: 'Two.', generated_prob: 0.9 }] }] };
  const fetch = fakeFetch([{ status: 200, body }]);
  const d = createGptZero({ keys: keysWith('secret-key-123'), fetch });
  const r = await d.scan('One. Two.');
  assert.equal(r.human, 0.82);
  assert.deepEqual(r.sentences, [{ text: 'One.', generatedProb: 0.1 }, { text: 'Two.', generatedProb: 0.9 }]);
  assert.equal(fetch.calls[0].url, 'https://api.gptzero.me/v2/predict/text');
  assert.equal(fetch.calls[0].init.headers['x-api-key'], 'secret-key-123');
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { document: 'One. Two.' });
  assert.equal(readAnswer({ documents: [{ completely_generated_prob: 0.25 }] }).human, 0.75, 'an older answer shape is read too');
  assert.equal(readAnswer({ documents: [{ class_probabilities: { human: 0.4 }, document_classification: 'MIXED' }] }).predictedClass, 'MIXED', 'document_classification stands in for predicted_class');
});

test('gptzero: retries a 429, never puts the key in a message, and refuses to start without a key', async () => {
  const fetch = fakeFetch([{ status: 429, body: {} }, { status: 200, body: { documents: [{ class_probabilities: { human: 0.5 } }] } }]);
  assert.equal((await createGptZero({ keys: keysWith('secret-key-123'), fetch, waitMs: 1 }).scan('x')).human, 0.5);
  const refused = createGptZero({ keys: keysWith('secret-key-123'), fetch: fakeFetch([{ status: 401, body: {} }]), waitMs: 1 });
  await assert.rejects(refused.scan('x'), e => /refused the API key \(HTTP 401\)/.test(e.message) && !e.message.includes('secret-key-123'));
  await assert.rejects(createGptZero({ keys: keysWith(null) }).preflight(), e => e.code === 'config' && /GPTZERO_API_KEY/.test(e.message) && /finance-studio-gptzero-key/.test(e.message));
});

test('keys: takeFromEnv moves the key out of the environment a pilot would inherit, and the store still has it', async () => {
  const env = { GPTZERO_API_KEY: 'abcdefgh12345678', PATH: '/bin', FINANCE_STUDIO_KEYCHAIN: 'off' };
  const store = createKeyStore({ env, platform: 'linux' });
  assert.deepEqual(store.takeFromEnv(), ['GPTZERO_API_KEY']);
  assert.equal(env.GPTZERO_API_KEY, undefined);
  assert.deepEqual(await store.get('gptzero'), { key: 'abcdefgh12345678', source: 'env', error: null });
  assert.deepEqual(await store.describe('gptzero'), { found: true, source: 'env', error: null });
  assert.equal((await createKeyStore({ env: { FINANCE_STUDIO_KEYCHAIN: 'off' }, platform: 'darwin' }).get('gptzero')).key, null);
});

/* ------------------------------------------------------------------ Verva settings */

test('verva: the page address must be https (loopback only for tests) and selectors are short CSS strings', () => {
  assert.equal(validateUrl('https://example.test/humanizer#x').url, 'https://example.test/humanizer');
  assert.equal(validateUrl('http://example.test/').ok, false);
  assert.equal(validateUrl('https://user:pw@example.test/').ok, false);
  assert.equal(validateUrl('http://127.0.0.1:9/').ok, false);
  assert.equal(validateUrl('http://127.0.0.1:9/', { allowLoopback: true }).ok, true);
  assert.throws(() => cleanConfig({ input: 'x'.repeat(201) }), /CSS selector/);
  assert.equal(cleanConfig({ minWords: 50, headless: true }).minWords, 50);
  assert.equal(cleanConfig({}).url, 'https://verva.com/dashboard', 'Verva (formerly TwainGPT) is the default page');
});

/* ------------------------------------------------------------------ the companion's routes */

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'humanize-test-'));
  for (const name of ['index.html', 'humanize.js', 'humanize.css']) fs.copyFileSync(path.join(REPO, name), path.join(dir, name));
  return dir;
}

function fakeAgents(rounds = []) {
  return { status: async () => ({ runtime: { found: false } }), listRounds: async () => rounds };
}

function fakeVerva() {
  return { id: 'verva', label: 'Verva (fake)', external: true, async rewrite(t) { return t; }, status: () => ({ configured: false, url: null, chrome: false, browser: 'closed', signIn: 'closed' }), async close() {}, async signIn() { return { signIn: 'open' }; }, async finishSignIn() { return { signIn: 'closed' }; } };
}

async function boot(options = {}) {
  const root = tempRoot();
  const rounds = options.rounds || [];
  const env = { GPTZERO_API_KEY: 'abcdefgh12345678', FINANCE_STUDIO_KEYCHAIN: 'off' };
  const humanize = options.noHumanize ? undefined : createHumanizeService({ root, env, verva: fakeVerva() });
  const app = createServer({ root, service: fakeAgents(rounds), humanize, port: 0, log: () => {} });
  const { port } = await app.listen(0);
  const send = (method, p, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { Host: `127.0.0.1:${port}` };
    if (method !== 'GET') Object.assign(headers, { Origin: `http://127.0.0.1:${port}`, 'x-finance-local': app.nonce, 'Content-Type': 'application/json' });
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  return { app, send, env, rounds, root, close: async () => { await app.shutdown(); fs.rmSync(root, { recursive: true, force: true }); } };
}

async function waitEnded(send, id) {
  for (let i = 0; i < 200; i += 1) {
    const r = await send('GET', `/api/humanize/${id}`);
    if (C.ENDED.includes(r.body.status)) return r.body;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('the run did not end');
}

test('companion: /api/humanize lists the workers, keeps the key out of the environment, and runs a stub dry run to the end', async () => {
  const w = await boot();
  try {
    assert.equal(w.env.GPTZERO_API_KEY, undefined, 'the key left the environment when the service was built');
    const list = await w.send('GET', '/api/humanize');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.config.bars, C.BARS);
    assert.deepEqual(list.body.config.gptzero, { found: true, source: 'env', error: null });
    assert.ok(!JSON.stringify(list.body).includes('abcdefgh12345678'), 'the key is never in an answer');

    const refused = await w.send('POST', '/api/humanize/start', { text: DOC, rewriter: 'verva', detector: 'stub' });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /Text leaves this computer/);

    const started = await w.send('POST', '/api/humanize/start', { text: DOC, rewriter: 'stub', detector: 'stub' });
    assert.equal(started.status, 200);
    assert.match(started.body.id, /^hz-/);
    const view = await waitEnded(w.send, started.body.id);
    assert.deepEqual(figuresOf(view.final), figuresOf(DOC));
    assert.equal(view.signedOff, false);
    const saved = path.join(w.root, 'private', 'humanize', 'runs', `${started.body.id}.json`);
    assert.ok(fs.existsSync(saved), 'the finished run is kept in private/humanize/runs');
    assert.equal(fs.statSync(saved).mode & 0o077, 0, 'readable by this account only');

    assert.equal((await w.send('GET', '/api/humanize/hz-nosuchrun-abcdef')).status, 404);
    assert.equal((await w.send('POST', '/api/humanize/start', { text: '  ', rewriter: 'stub', detector: 'stub' })).status, 400);
    assert.equal((await w.send('POST', '/api/humanize/start', { text: DOC, rewriter: 'shell', detector: 'stub' })).status, 400);
    const bad = await w.send('POST', '/api/humanize/verva/config', { url: 'http://example.test/' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /https/);
  } finally {
    await w.close();
  }
});

test('companion: while a round of pilots runs, humanize answers carry no text', async () => {
  const w = await boot();
  try {
    const { body } = await w.send('POST', '/api/humanize/start', { text: DOC, rewriter: 'stub', detector: 'stub' });
    await waitEnded(w.send, body.id);
    w.rounds.push({ id: 'round-1', status: 'running' });
    const view = (await w.send('GET', `/api/humanize/${body.id}`)).body;
    assert.equal(view.redacted, true);
    assert.deepEqual(view.final, { withheld: true });
    assert.deepEqual(view.brief, { withheld: true });
    assert.ok(view.chunks.every(c => c.text.withheld && c.source.withheld));
    assert.ok(view.log.every(l => l.text.withheld));
    const text = JSON.stringify(view);
    for (const piece of ['Northwind', '$4.1m', 'EBITDA', 'covenant']) assert.ok(!text.includes(piece), `${piece} is withheld`);
    assert.equal((await w.send('GET', '/api/humanize')).body.redacted, true);
    const refused = await w.send('POST', '/api/humanize/start', { text: DOC, rewriter: 'stub', detector: 'stub' });
    assert.equal(refused.status, 409, 'no run starts while a round runs');
    assert.match(refused.body.error, /round of pilots is running/);
    assert.equal((await w.send('POST', '/api/humanize/verva/config', { url: 'https://example.test/' })).status, 409);
    assert.equal((await w.send('POST', '/api/humanize/verva/sign-in')).status, 409);
  } finally {
    await w.close();
  }
});

test('companion: without the humanize service the routes say so, and the page assets are served', async () => {
  const w = await boot({ noHumanize: true });
  try {
    const r = await w.send('GET', '/api/humanize');
    assert.equal(r.status, 404);
    assert.match(r.body.error, /Humanize is not available/);
  } finally {
    await w.close();
  }
  const v = await boot();
  try {
    const page = await new Promise(resolve => http.get({ host: '127.0.0.1', port: v.app.server.address().port, path: '/humanize.js', headers: { Host: `127.0.0.1:${v.app.server.address().port}` } }, res => { let t = ''; res.on('data', c => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, t })); }));
    assert.equal(page.status, 200);
    assert.match(page.t, /window\.FinanceHumanize|W\.FinanceHumanize/);
  } finally {
    await v.close();
  }
});

test('redaction: a run row list keeps its counts and a view loses every text', () => {
  const view = { status: 'passed', final: 'secret', brief: { facts: [] }, error: 'oops secret', log: [{ at: 'a', round: 1, pass: 1, stage: 'repair', text: 'secret' }], chunks: [{ id: 'c1', text: 'secret', source: 'secret', notes: [{ code: 'x' }], passes: [{ human: 0.5, reasons: ['secret'] }] }] };
  const out = redactHumanizeData(view);
  assert.ok(!JSON.stringify(out).includes('secret'));
  assert.equal(out.chunks[0].passes[0].human, 0.5);
  assert.deepEqual(redactHumanizeData({ runs: [{ id: 'hz-a' }] }), { runs: [{ id: 'hz-a' }], redacted: true });
});

/* ------------------------------------------------------------------ the page and the CLI */

test('page: the display copy of the bars agrees with src/humanize/constants.cjs, and the page talks only to /api/humanize', () => {
  const src = fs.readFileSync(path.join(REPO, 'humanize.js'), 'utf8');
  const m = /const BARS=Object\.freeze\(\{prose:([\d.]+),other:([\d.]+),aggregate:([\d.]+)\}\)/.exec(src);
  assert.ok(m, 'humanize.js declares BARS');
  assert.deepEqual({ prose: Number(m[1]), other: Number(m[2]), aggregate: Number(m[3]) }, C.BARS);
  for (const call of src.matchAll(/\b(?:get|post)\('([^']*)'/g)) assert.ok(call[1].startsWith('/api/humanize'), call[1]);
  assert.ok(!/https?:\/\//.test(src), 'no absolute address in the page');
  assert.match(src, new RegExp(C.ENDED.map(s => `'${s}'`).join(',')), 'the page knows the same ended states');
});

test('cli: a stub dry run writes the final text and a 0600 report; an external run needs --yes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'humanize-cli-'));
  try {
    fs.writeFileSync(path.join(dir, 'in.txt'), DOC);
    const lines = [];
    const io = { out: t => lines.push(t), err: () => {}, env: { FINANCE_STUDIO_KEYCHAIN: 'off' } };
    const code = await cli.main(['run', '--in', path.join(dir, 'in.txt'), '--rewriter', 'stub', '--detector', 'stub', '--out', path.join(dir, 'out.txt'), '--report', path.join(dir, 'r.json'), '--quiet'], io);
    assert.ok([0, 1].includes(code));
    assert.deepEqual(figuresOf(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8')), figuresOf(DOC));
    assert.equal(fs.statSync(path.join(dir, 'r.json')).mode & 0o077, 0);
    const errs = [];
    assert.equal(await cli.main(['run', '--in', path.join(dir, 'in.txt'), '--rewriter', 'stub', '--detector', 'gptzero'], { ...io, err: t => errs.push(t) }), 2);
    assert.match(errs.join('\n'), /Add --yes/);
    assert.equal(await cli.main(['brief', '--in', path.join(dir, 'in.txt')], io), 0);
    assert.ok(JSON.parse(lines[lines.length - 1]).facts.length > 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
