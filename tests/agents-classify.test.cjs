'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { suggest, hashFreeze, parseFigure, extractNumbers } = require('../backend/agents/classify.cjs');

/* Synthetic case: a made up retailer, Atlas Foods. Invented numbers throughout. */
const freeze = (overrides = {}) => ({
  version: 1,
  gold: {
    decision: 'approve the refinancing; reject the extension',
    figures: [
      { label: 'units', value: 482, tolerance: 0.5 },
      { label: 'margin', value: '31.5%', tolerance: 0.05 },
    ],
    notes: 'synthetic',
  },
  fingerprints: [
    { id: 'fp-gross', label: 'used gross units', tokens: ['gross units', '611'], figures: [] },
    { id: 'fp-ratio', label: 'wrong ratio', tokens: [], figures: [{ label: 'ratio', value: 2.9, tolerance: 0.01 }, { label: 'units', value: 611, tolerance: 0.5 }] },
  ],
  postHoc: false,
  ...overrides,
});

const goldAnswer = 'Atlas Foods: approve the refinancing. Net units are 482 at a 31.5% margin.';

function verdictOf(text, options = {}) {
  return suggest(freeze(options.freeze), text, options.outputs || '').verdict;
}

test('the result is labelled heuristic and has the documented shape', () => {
  const result = suggest(freeze(), goldAnswer, '');
  assert.equal(result.label, 'heuristic');
  assert.deepEqual(Object.keys(result).sort(), ['decision', 'fingerprints', 'label', 'matches', 'verdict']);
  assert.deepEqual(result.matches.map(m => ({ label: m.label, value: m.value, found: m.found })), [
    { label: 'units', value: 482, found: true },
    { label: 'margin', value: '31.5%', found: true },
  ]);
  assert.deepEqual(result.fingerprints.map(f => ({ id: f.id, label: f.label, hit: f.hit, tokensFound: f.tokensFound })), [
    { id: 'fp-gross', label: 'used gross units', hit: false, tokensFound: [] },
    { id: 'fp-ratio', label: 'wrong ratio', hit: false, tokensFound: [] },
  ]);
  assert.equal(result.verdict, 'matches-frozen-gold');
});

test('figures match within the absolute tolerance, inclusive', () => {
  const gold = tolerance => ({ gold: { decision: '', figures: [{ label: 'x', value: 100, tolerance }] }, fingerprints: [] });
  const found = (text, tolerance) => suggest(gold(tolerance), text, '').matches[0].found;
  assert.equal(found('the answer is 100', 0), true);
  assert.equal(found('the answer is 100.4', 0), false);
  assert.equal(found('the answer is 100.4', 0.5), true);
  assert.equal(found('the answer is 100.5', 0.5), true, 'the tolerance is inclusive');
  assert.equal(found('the answer is 100.6', 0.5), false);
  assert.equal(found('the answer is 99.6', 0.5), true);
  assert.equal(found('the answer is 99.4', 0.5), false);
  assert.equal(found('the answer is 100', undefined), true, 'a missing tolerance means exact');
  assert.equal(found('the answer is 100.01', undefined), false);
  assert.equal(found('the answer is 100.01', -0.5), true, 'a negative tolerance is read as its size');
  assert.equal(found('the answer is 100.01', 'abc'), false, 'an unusable tolerance falls back to exact');
  assert.equal(found('nothing numeric here', 5), false);
  assert.equal(found('', 5), false);
});

test('thousands separators, currency signs, percent and x are ignored when matching', () => {
  const found = (value, text, tolerance = 0.005) => suggest({ gold: { figures: [{ label: 'x', value, tolerance }] }, fingerprints: [] }, text, '').matches[0].found;
  assert.equal(found(1234567, 'total of 1,234,567 dollars'), true);
  assert.equal(found(1234567, 'total of $1,234,567'), true);
  assert.equal(found(1234567, 'total of 1234567'), true);
  assert.equal(found('1,234,567', 'total of 1234567.00'), true);
  assert.equal(found('$1,234,567', 'total of 1,234,567'), true);
  assert.equal(found(31.5, 'margin of 31.5%'), true);
  assert.equal(found('31.5%', 'margin of 31.5 percent'), true);
  assert.equal(found('31.5%', 'margin of 31.5% exactly'), true);
  assert.equal(found(3.2, 'a multiple of 3.2x'), true);
  assert.equal(found('3.2x', 'a multiple of 3.2'), true);
  assert.equal(found(1234567, 'total \u20ac1,234,567 and \u00a31,234,567'), true, 'euro and pound signs');
  assert.equal(found(1234567, 'total $ 1,234,567'), true, 'a space after the currency sign');
  assert.equal(found(482, 'there were 4,820 units'), false, 'a longer number is not a match');
  assert.equal(found(482, 'there were 1482 units'), false, 'digits cut from a longer number are not a match');
  assert.equal(found(482, 'cell B482 holds it'), false, 'part of a cell reference is not a figure');
  assert.equal(found(482, 'about 482.3 units', 0.5), true);
  assert.equal(found(482, 'about 482.3 units', 0.1), false);
  assert.equal(found(2345, 'a total of 2,345,000'), false, 'a thousand separator group is not truncated');
  assert.equal(found(12, 'the list 10,12,14 is short'), true, 'comma separated short numbers are separate numbers');
});

test('typographic characters do not defeat matching', () => {
  const found = (value, text) => suggest({ gold: { figures: [{ label: 'x', value, tolerance: 0 }] }, fingerprints: [] }, text, '').matches[0].found;
  assert.equal(found(-5.5, 'a change of \u22125.5 points'), true, 'a unicode minus sign');
  assert.equal(found(1000, 'between 1,000\u20132,345'), true, 'an en dash range keeps both ends positive');
  assert.equal(found(2345, 'between 1,000\u20132,345'), true);
  assert.equal(found(482, 'units\u00a0482'), true, 'a no break space');
  assert.equal(found(482, 'units \uff14\uff18\uff12'), true, 'full width digits');
});

test('signs matter, accounting brackets are read both ways', () => {
  const found = (value, text) => suggest({ gold: { figures: [{ label: 'x', value, tolerance: 0 }] }, fingerprints: [] }, text, '').matches[0].found;
  assert.equal(found(-40, 'a decline of -40 units'), true);
  assert.equal(found(40, 'a decline of -40 units'), false, 'a stuck minus sign makes it negative');
  assert.equal(found(-40, 'a decline of 40 units'), false);
  assert.equal(found(40, 'a list - 40 units - 41 units'), true, 'a spaced dash is a bullet, not a sign');
  assert.equal(found(40, 'the range 30-40 applies'), true, 'a hyphen between numbers is not a sign');
  assert.equal(found(-40, 'cash change (40)'), true, 'brackets as in a statement');
  assert.equal(found(40, 'units (40)'), true, 'brackets used for emphasis in prose');
  assert.equal(found(-40, 'cash change ($40)'), true);
  assert.equal(found(40, 'about (40 units)'), true);
});

test('figures given as text are parsed the same way', () => {
  assert.equal(parseFigure(482), 482);
  assert.equal(parseFigure('482'), 482);
  assert.equal(parseFigure(' $1,234.5 '), 1234.5);
  assert.equal(parseFigure('31.5%'), 31.5);
  assert.equal(parseFigure('3.2x'), 3.2);
  assert.equal(parseFigure('(1,000)'), -1000);
  assert.equal(parseFigure('-7'), -7);
  assert.equal(parseFigure('\u22127'), -7);
  assert.equal(parseFigure('.5'), 0.5);
  for (const bad of ['', 'abc', '1.2.3', '12 units', null, undefined, NaN, Infinity, {}, [], true]) assert.equal(parseFigure(bad), null, String(bad));
  assert.deepEqual(extractNumbers('Q1 revenue was 1,200 vs 950 (down 20.8%)'), [1200, 950, 20.8]);
  assert.deepEqual(extractNumbers('(3.5%) and (7)'), [3.5, -3.5, 7, -7]);
});

test('an unusable gold figure can never be found', () => {
  const bad = suggest({ gold: { figures: [{ label: 'x', value: 'not a number' }, { label: 'y' }, null] }, fingerprints: [] }, 'not a number 12', '');
  assert.deepEqual(bad.matches.map(m => m.found), [false, false, false]);
  assert.equal(bad.verdict, 'unclear');
});

test('matches-frozen-gold needs every gold figure', () => {
  assert.equal(verdictOf(goldAnswer), 'matches-frozen-gold');
  assert.equal(verdictOf('approve the refinancing. Units are 482.'), 'unclear', 'margin missing');
  assert.equal(verdictOf('approve the refinancing. Margin is 31.5%.'), 'unclear', 'units missing');
  assert.equal(verdictOf('approve the refinancing. Units are 483 and margin 31.5%.'), 'unclear', 'one figure outside tolerance');
  assert.equal(verdictOf('Units 482, margin 31.5%, approve the refinancing.'), 'matches-frozen-gold', 'order does not matter');
});

test('decision keywords come from gold.decision split on semicolons; one is enough; boundaries and case are respected', () => {
  const withDecision = decision => ({ freeze: freeze({ gold: { decision, figures: [{ label: 'units', value: 482, tolerance: 0.5 }] } }) });
  const figures = 'Units are 482.';
  assert.equal(verdictOf(figures, withDecision('approve the refinancing; reject the extension')), 'unclear', 'neither keyword appears');
  assert.equal(verdictOf(figures + ' We APPROVE the Refinancing.', withDecision('approve the refinancing; reject the extension')), 'matches-frozen-gold', 'first keyword, any case');
  assert.equal(verdictOf(figures + ' Reject the extension.', withDecision('approve the refinancing; reject the extension')), 'matches-frozen-gold', 'second keyword is enough');
  assert.equal(verdictOf(figures + ' Approve  the\nrefinancing.', withDecision('approve the refinancing')), 'matches-frozen-gold', 'whitespace is flexible');
  assert.equal(verdictOf(figures + ' The threshold is fine.', withDecision('hold')), 'unclear', '"hold" is not inside "threshold"');
  assert.equal(verdictOf(figures + ' Hold the deal.', withDecision('hold')), 'matches-frozen-gold');
  assert.equal(verdictOf(figures, withDecision('')), 'matches-frozen-gold', 'no keywords supplied means none required');
  assert.equal(verdictOf(figures, withDecision('  ;  ; ')), 'matches-frozen-gold', 'empty keywords are dropped');
  assert.equal(verdictOf(figures, { freeze: freeze({ gold: { figures: [{ label: 'units', value: 482, tolerance: 0.5 }] } }) }), 'matches-frozen-gold', 'no decision field');
  const result = suggest(freeze(withDecision('approve the refinancing; reject the extension').freeze), figures + ' Reject the extension.', '');
  assert.deepEqual(result.decision, { keywords: ['approve the refinancing', 'reject the extension'], found: ['reject the extension'] });
});

test('a gold with nothing to check is never a match', () => {
  assert.equal(suggest({ gold: {}, fingerprints: [] }, 'anything at all', '').verdict, 'unclear');
  assert.equal(suggest({ gold: { decision: '', figures: [] }, fingerprints: [] }, 'anything at all', '').verdict, 'unclear');
  assert.equal(suggest({}, 'anything', '').verdict, 'unclear');
  assert.equal(suggest({ gold: { decision: 'approve' } }, 'we approve', '').verdict, 'matches-frozen-gold', 'a keyword alone is a criterion');
});

test('a fingerprint hits only when all of its tokens appear, case insensitively', () => {
  const only = tokens => ({ gold: { figures: [{ label: 'u', value: 482, tolerance: 0 }] }, fingerprints: [{ id: 'f', label: 'f', tokens, figures: [] }] });
  const hit = (tokens, text) => suggest(only(tokens), text, '').fingerprints[0];
  assert.equal(hit(['gross units', '611'], 'it used GROSS UNITS of 611').hit, true);
  assert.deepEqual(hit(['gross units', '611'], 'it used GROSS UNITS of 611').tokensFound, ['gross units', '611']);
  assert.equal(hit(['gross units', '611'], 'it used gross units only').hit, false, 'one of two tokens');
  assert.deepEqual(hit(['gross units', '611'], 'it used gross units only').tokensFound, ['gross units']);
  assert.equal(hit(['gross units', '611'], 'unrelated').hit, false);
  assert.equal(hit(['611'], 'cell 6110 and 1611 and 611.5').hit, false, 'a token is not matched inside a longer number');
  assert.equal(hit(['611'], 'the value 611, rounded').hit, true);
  assert.equal(hit(['2,345'], 'a total of 12,345 or 2,345,000').hit, false);
  assert.equal(hit(['2,345'], 'a total of 2,345.').hit, true);
  assert.equal(hit(['net'], 'the Internet').hit, false, 'word boundaries');
  assert.equal(hit(['$611'], 'it cost $611 each').hit, true, 'tokens that start with a symbol');
  assert.equal(hit(['  '], 'anything').hit, false, 'a blank token is not a token');
});

test('a fingerprint with figures hits only when all of its figures match', () => {
  const only = figures => ({ gold: { figures: [{ label: 'u', value: 482, tolerance: 0 }] }, fingerprints: [{ id: 'f', label: 'f', tokens: [], figures }] });
  const figs = [{ label: 'a', value: 2.9, tolerance: 0.01 }, { label: 'b', value: 611, tolerance: 0.5 }];
  assert.equal(suggest(only(figs), 'ratio 2.9 and units 611', '').fingerprints[0].hit, true);
  assert.equal(suggest(only(figs), 'ratio 2.905 and units 611.4', '').fingerprints[0].hit, true);
  assert.equal(suggest(only(figs), 'ratio 2.9 only', '').fingerprints[0].hit, false);
  assert.equal(suggest(only(figs), 'ratio 3.1 and units 611', '').fingerprints[0].hit, false);
  const found = suggest(only(figs), 'ratio 2.9 only', '').fingerprints[0].figuresFound;
  assert.deepEqual(found.map(f => [f.label, f.found]), [['a', true], ['b', false]]);
});

test('tokens or figures: either route is enough, and an empty fingerprint never hits', () => {
  const mixed = { gold: { figures: [{ label: 'u', value: 482, tolerance: 0 }] }, fingerprints: [{ id: 'f', label: 'f', tokens: ['gross units'], figures: [{ label: 'b', value: 611, tolerance: 0 }] }] };
  assert.equal(suggest(mixed, 'it said gross units', '').fingerprints[0].hit, true, 'all tokens');
  assert.equal(suggest(mixed, 'it said 611', '').fingerprints[0].hit, true, 'all figures');
  assert.equal(suggest(mixed, 'nothing', '').fingerprints[0].hit, false);
  const empty = { gold: { figures: [{ label: 'u', value: 482, tolerance: 0 }] }, fingerprints: [{ id: 'e', label: 'e', tokens: [], figures: [] }, { id: 'm', label: 'm' }, null] };
  assert.deepEqual(suggest(empty, 'anything 482', '').fingerprints.map(f => f.hit), [false, false, false]);
});

test('verdict rules: fingerprint, gold, both, neither', () => {
  assert.equal(verdictOf('The gross units were 611 so I would extend. Margin 28%.'), 'fingerprint', 'a fingerprint and no gold');
  assert.equal(verdictOf('Approve the refinancing. Units 482, margin 31.5%.'), 'matches-frozen-gold');
  assert.equal(verdictOf('Approve the refinancing. Units 482, margin 31.5%. The gross units of 611 would mislead.'), 'unclear', 'gold and a fingerprint together are ambiguous');
  assert.equal(verdictOf('I could not decide.'), 'unclear');
  assert.equal(verdictOf(''), 'unclear');
  assert.equal(verdictOf('ratio 2.9 and 611 units'), 'fingerprint', 'a figures fingerprint');
});

test('the outputs text is searched too and the result says where a figure was found, but only the final answer decides', () => {
  const result = suggest(freeze(), 'Approve the refinancing. Units are 482.', 'Summary table\nmargin 31.5%\n');
  assert.equal(result.verdict, 'unclear', 'a gold figure that is only in the output files does not count');
  assert.deepEqual(result.matches.map(m => m.where), ['final', 'outputs']);
  assert.equal(suggest(freeze(), 'Approve the refinancing.', 'units 482 margin 31.5%').verdict, 'unclear');
  const fromOutputs = suggest(freeze(), 'I am done.', 'gross units 611');
  assert.equal(fromOutputs.verdict, 'unclear', 'a fingerprint that is only in the output files does not count');
  assert.deepEqual(suggest(freeze(), 'nothing', '').matches.map(m => m.where), [null, null]);
});

test('odd inputs are tolerated, a missing freeze is not', () => {
  assert.doesNotThrow(() => suggest(freeze(), undefined, undefined));
  assert.doesNotThrow(() => suggest(freeze(), null, 42));
  assert.doesNotThrow(() => suggest(freeze(), { not: 'text' }, ['x']));
  assert.equal(suggest(freeze(), undefined, undefined).verdict, 'unclear');
  assert.throws(() => suggest(null, 'x', ''), TypeError);
  assert.throws(() => suggest(undefined, 'x', ''), TypeError);
  assert.throws(() => suggest('freeze', 'x', ''), TypeError);
  const weird = { gold: { decision: 7, figures: 'nope' }, fingerprints: 'nope' };
  assert.doesNotThrow(() => suggest(weird, 'text', ''));
  const started = Date.now();
  suggest(freeze(), '1,234 '.repeat(200000) + 'approve the refinancing 482 31.5%', '');
  assert.ok(Date.now() - started < 3000, 'large texts are handled in bounded time');
});

test('the suggestion is never final: it does not touch the freeze and changes nothing stored', () => {
  const record = freeze();
  const copy = JSON.parse(JSON.stringify(record));
  const first = suggest(record, goldAnswer, 'x');
  const second = suggest(record, goldAnswer, 'x');
  assert.deepEqual(record, copy, 'the freeze record is not mutated');
  assert.deepEqual(first, second, 'the suggestion is deterministic');
  assert.ok(!('human' in first) && !('final' in first), 'no stored verdict is produced');
  assert.equal(first.label, 'heuristic');
  assert.ok(Object.isFrozen(record) === false);
});

test('hashFreeze is sha256 of canonical JSON with sorted keys', () => {
  const record = { b: 1, a: { d: [1, 2, { z: true, y: null }], c: 'text' } };
  const canonical = '{"a":{"c":"text","d":[1,2,{"y":null,"z":true}]},"b":1}';
  assert.equal(hashFreeze(record), crypto.createHash('sha256').update(canonical).digest('hex'));
  assert.match(hashFreeze(record), /^[0-9a-f]{64}$/);
});

test('hashFreeze ignores key order and whitespace sources, but not content or array order', () => {
  const one = hashFreeze({ gold: { figures: [{ label: 'x', value: 1, tolerance: 0 }], decision: 'd' }, fingerprints: [{ id: 'a', tokens: ['t'] }] });
  const sameWithOtherOrder = hashFreeze({ fingerprints: [{ tokens: ['t'], id: 'a' }], gold: { decision: 'd', figures: [{ tolerance: 0, value: 1, label: 'x' }] } });
  assert.equal(one, sameWithOtherOrder);
  assert.notEqual(one, hashFreeze({ gold: { figures: [{ label: 'x', value: 2, tolerance: 0 }], decision: 'd' }, fingerprints: [{ id: 'a', tokens: ['t'] }] }));
  assert.notEqual(hashFreeze({ list: [1, 2] }), hashFreeze({ list: [2, 1] }));
  assert.notEqual(hashFreeze({ text: 'a b' }), hashFreeze({ text: 'a  b' }));
  assert.notEqual(hashFreeze({ n: 1 }), hashFreeze({ n: '1' }));
});

test('hashFreeze drops undefined like JSON does, ignores a stored top level sha256, and accepts the real record', () => {
  assert.equal(hashFreeze({ a: 1, b: undefined, c: () => 1 }), hashFreeze({ a: 1 }));
  assert.equal(hashFreeze({ list: [undefined, 1] }), hashFreeze({ list: [null, 1] }));
  assert.equal(hashFreeze({ n: NaN, m: Infinity }), hashFreeze({ n: null, m: null }));
  const record = freeze();
  const stored = { ...record, sha256: hashFreeze(record), frozenAt: '2026-01-01T00:00:00Z' };
  assert.equal(hashFreeze({ ...stored, sha256: 'something else' }), hashFreeze(stored), 'the stored hash does not feed into itself');
  assert.notEqual(hashFreeze(stored), hashFreeze(record), 'other fields such as frozenAt do');
  assert.equal(hashFreeze(JSON.parse(JSON.stringify(stored))), hashFreeze(stored), 'a record read back from disk hashes the same');
  assert.equal(hashFreeze({ when: new Date('2026-01-01T00:00:00Z') }), hashFreeze({ when: '2026-01-01T00:00:00.000Z' }));
});

test('hashFreeze rejects things that are not records', () => {
  assert.throws(() => hashFreeze(null), TypeError);
  assert.throws(() => hashFreeze(undefined), TypeError);
  assert.throws(() => hashFreeze('text'), TypeError);
  assert.throws(() => hashFreeze({ n: 10n }), TypeError);
  let deep = {};
  for (let i = 0; i < 100; i++) deep = { deep };
  assert.throws(() => hashFreeze(deep), RangeError);
  assert.match(hashFreeze([1, 2]), /^[0-9a-f]{64}$/);
});

test('phrases written with capitals, digits or accents match the answer in any case', () => {
  const figures = [{ label: 'units', value: 482, tolerance: 0.5 }];
  const texts = (phrase) => [phrase.toLowerCase(), phrase.toUpperCase(), phrase, `The board said: ${phrase}.`];
  for (const decision of ['Approve the Refinancing', 'HOLD FOR THE BOARD', 'Q3 Plan', 'CafÉ Rouge', 'État']) {
    for (const text of texts(decision)) {
      const result = suggest({ gold: { decision, figures }, fingerprints: [] }, 'Units are 482. ' + text, '');
      assert.equal(result.verdict, 'matches-frozen-gold', `${decision} against ${text}`);
      assert.deepEqual(result.decision.found, [decision], 'the keyword is reported as the writer wrote it');
    }
    assert.equal(suggest({ gold: { decision, figures }, fingerprints: [] }, 'Units are 482. Nothing relevant here.', '').verdict, 'unclear', decision);
  }
  for (const token of ['Hold for the Board', 'Q3 Plan', 'CafÉ Rouge', 'EBITDA Add-Back']) {
    for (const text of texts(token)) {
      const result = suggest({ gold: { figures }, fingerprints: [{ id: 'fp', label: 'fp', tokens: [token], figures: [] }] }, 'Not the gold figure. ' + text, '');
      assert.equal(result.fingerprints[0].hit, true, `${token} against ${text}`);
      assert.deepEqual(result.fingerprints[0].tokensFound, [token]);
      assert.equal(result.verdict, 'fingerprint', `${token} against ${text}`);
    }
    assert.equal(suggest({ gold: { figures }, fingerprints: [{ id: 'fp', label: 'fp', tokens: [token], figures: [] }] }, 'Not the gold figure.', '').fingerprints[0].hit, false, token);
  }
  /* The phrase side and the text side fold case the same way, in the outputs text too: the keyword is found there (the
     reason names it as the writer wrote it) and, being only in the outputs, it does not decide the verdict. */
  const viaOutputs = suggest({ gold: { decision: 'Hold For The Board', figures: [] }, fingerprints: [] }, 'See the file.', 'hold for the board');
  assert.equal(viaOutputs.verdict, 'unclear');
  assert.match(viaOutputs.reason, /Hold For The Board.*only in the output files/);
  assert.equal(suggest({ gold: { decision: 'Hold For The Board', figures: [] }, fingerprints: [] }, 'See the file.', 'HOLD for the BOARD').verdict, 'unclear');
  assert.equal(suggest({ gold: { decision: 'Hold For The Board', figures: [] }, fingerprints: [] }, 'we hold for the board', '').verdict, 'matches-frozen-gold');
});

test('curly quotes and dashes in a phrase match their plain forms, and a mixed-case token is not found inside a longer word', () => {
  const only = token => ({ gold: { figures: [{ label: 'u', value: 482, tolerance: 0 }] }, fingerprints: [{ id: 'f', label: 'f', tokens: [token], figures: [] }] });
  const hit = (token, text) => suggest(only(token), text, '').fingerprints[0].hit;
  assert.equal(hit('Atlas’ Plan', "units 482; the atlas' plan applies"), true, 'curly quote in the phrase');
  assert.equal(hit("Atlas' Plan", 'units 482; the ATLAS’ PLAN applies'), true, 'curly quote in the text');
  assert.equal(hit('Net Debt', 'units 482; Internet Debtors'), false, 'word boundaries still hold with capitals');
});

/* ------------------------------------------------------------------ the final answer decides */

test('only the final answer decides: gold figures, keywords and fingerprints found only in the output files are reported and not counted', () => {
  /* every gold figure is in the outputs only */
  const allOutputs = suggest(freeze(), 'Approve the refinancing. I am done.', 'units 482\nmargin 31.5%');
  assert.equal(allOutputs.verdict, 'unclear');
  assert.deepEqual(allOutputs.matches.map(m => ({ label: m.label, found: m.found, where: m.where })), [
    { label: 'units', found: true, where: 'outputs' },
    { label: 'margin', found: true, where: 'outputs' },
  ], 'the suggestion still says where the figure appeared');
  assert.match(allOutputs.reason, /^The gold figures units \(482\), margin \(31\.5%\) appear only in the output files, not in the final answer, so they are not counted\.$/);
  /* one in the answer, one in the outputs */
  const mixed = suggest(freeze(), 'Approve the refinancing. Units are 482.', 'margin 31.5%');
  assert.equal(mixed.verdict, 'unclear');
  assert.deepEqual(mixed.matches.map(m => m.where), ['final', 'outputs']);
  assert.match(mixed.reason, /^The gold figure margin \(31\.5%\) appears only in the output files, not in the final answer, so it is not counted\.$/);
  /* the same figures in the answer are a match, whatever the outputs hold, and then there is nothing to explain */
  const inAnswer = suggest(freeze(), goldAnswer, 'units 482\nmargin 31.5%');
  assert.equal(inAnswer.verdict, 'matches-frozen-gold');
  assert.deepEqual(inAnswer.matches.map(m => m.where), ['final', 'final'], 'the answer is looked at first');
  assert.ok(!('reason' in inAnswer));
  assert.equal(suggest(freeze(), goldAnswer, '').verdict, 'matches-frozen-gold');
  /* a figure the outputs hold by chance, from the source data the pilot copied there, is no match */
  assert.equal(suggest(freeze(), 'I could not finish; approve the refinancing.', 'copied source rows: 482, 31.5, 611, 2.9').verdict, 'unclear');
  /* keywords */
  const keywordInOutputs = suggest(freeze(), 'Units are 482. Margin 31.5%.', 'Recommendation: approve the refinancing');
  assert.equal(keywordInOutputs.verdict, 'unclear');
  assert.deepEqual(keywordInOutputs.decision, { keywords: ['approve the refinancing', 'reject the extension'], found: [] });
  assert.match(keywordInOutputs.reason, /^The decision keyword approve the refinancing appears only in the output files, so it is not counted\.$/);
  /* fingerprints: tokens and figures */
  const printInOutputs = suggest(freeze(), 'I am done.', 'gross units 611');
  assert.equal(printInOutputs.verdict, 'unclear');
  assert.deepEqual(printInOutputs.fingerprints.map(f => [f.id, f.hit, f.tokensFound]), [['fp-gross', false, []], ['fp-ratio', false, []]]);
  assert.match(printInOutputs.reason, /^The fingerprint used gross units appears only in the output files, so it is not counted\.$/);
  const figuresInOutputs = suggest(freeze(), 'I am done.', 'ratio 2.9 units 611');
  assert.equal(figuresInOutputs.verdict, 'unclear');
  assert.deepEqual(figuresInOutputs.fingerprints[1].figuresFound.map(f => [f.label, f.found, f.where]), [['ratio', true, 'outputs'], ['units', true, 'outputs']], 'the figures of a fingerprint say where they were found too');
  assert.equal(suggest(freeze(), 'The ratio was 2.9 and units 611.', 'x').verdict, 'fingerprint', 'in the answer they count');
  /* a fingerprint in the answer with the gold only in the outputs is a fingerprint */
  assert.equal(suggest(freeze(), 'The gross units of 611 apply.', 'units 482 margin 31.5%').verdict, 'fingerprint');
  /* the outputs text does not need to exist */
  assert.equal(suggest(freeze(), goldAnswer, undefined).verdict, 'matches-frozen-gold');
});

test('the reason is present only when something kept evidence from counting', () => {
  assert.ok(!('reason' in suggest(freeze(), goldAnswer, '')));
  assert.ok(!('reason' in suggest(freeze(), 'nothing relevant', '')));
  assert.ok(!('reason' in suggest(freeze(), 'The gross units of 611.', '')));
  assert.deepEqual(Object.keys(suggest(freeze(), goldAnswer, 'x')).sort(), ['decision', 'fingerprints', 'label', 'matches', 'verdict']);
  assert.deepEqual(Object.keys(suggest(freeze(), 'Approve. Units are 482.', 'margin 31.5%')).sort(), ['decision', 'fingerprints', 'label', 'matches', 'reason', 'verdict']);
  const withReason = suggest(freeze(), 'Approve. Units are 482.', 'margin 31.5%');
  assert.equal(typeof withReason.reason, 'string');
  assert.ok(withReason.reason.length < 200, 'short');
  assert.equal(withReason.label, 'heuristic');
});

/* ------------------------------------------------------------------ negation */

test('a decision keyword that a negation comes right before does not count', () => {
  const keyword = 'approve the refinancing';
  const decide = text => suggest(freeze({ gold: { decision: keyword, figures: [{ label: 'units', value: 482, tolerance: 0.5 }] } }), 'Units are 482. ' + text, '');
  for (const negated of [
    'We do not approve the refinancing.', 'We should not approve the refinancing.', "We shouldn't approve the refinancing.", "Don't approve the refinancing.", 'I would never approve the refinancing.', 'We cannot approve the refinancing.',
    'There is no case to approve the refinancing.', 'WE DO NOT APPROVE THE REFINANCING.', 'We shouldn’t approve the refinancing.', 'Not to approve the refinancing.',
    'The board did not yet approve the refinancing.', "We can't approve the refinancing.", 'Do\nnot approve the refinancing.',
  ]) {
    const result = decide(negated);
    assert.equal(result.verdict, 'unclear', negated);
    assert.deepEqual(result.decision.found, [], negated);
    assert.match(result.reason, /^The decision keyword approve the refinancing appears in the final answer only after a negation \(not, no, never, avoid, cannot, n't\), so it is not counted\.$/, negated);
  }
  for (const affirmed of [
    'We approve the refinancing.', 'There is no doubt that the board will approve the refinancing.', 'We do not think the numbers are wrong so approve the refinancing.', 'We could not verify the cash. Approve the refinancing.', 'Not sure about the rate!\nApprove the refinancing.',
    'I did not. Approve the refinancing.', 'It is not clear what happened; approve the refinancing.', 'We do not approve the refinancing at 8%, but we approve the refinancing at 6%.', 'We know, note and nothing: approve the refinancing.', 'Knot annotate cannotation approve the refinancing.',
    'Recommendation: approve the refinancing', 'Not recommended in general, but on balance the board should approve the refinancing.',
  ]) {
    const result = decide(affirmed);
    assert.equal(result.verdict, 'matches-frozen-gold', affirmed);
    assert.deepEqual(result.decision.found, [keyword], affirmed);
    assert.ok(!('reason' in result), affirmed);
  }
  /* one keyword negated, the other not */
  const two = suggest(freeze({ gold: { decision: 'approve the refinancing; reject the extension', figures: [{ label: 'units', value: 482, tolerance: 0.5 }] } }), 'Units are 482. We do not approve the refinancing; we reject the extension.', '');
  assert.equal(two.verdict, 'matches-frozen-gold');
  assert.deepEqual(two.decision.found, ['reject the extension']);
  /* a comma ends the clause, so a negation before it is not seen (documented limit of the heuristic) */
  assert.equal(decide('We do not, in this case, approve the refinancing.').verdict, 'matches-frozen-gold');
  /* the negation has to come before: a word after the keyword does nothing */
  assert.equal(decide('Approve the refinancing, which is not cheap.').verdict, 'matches-frozen-gold');
  /* a keyword that holds a negation word itself is still found */
  const own = suggest({ gold: { decision: 'do not extend; no change', figures: [{ label: 'units', value: 482, tolerance: 0 }] }, fingerprints: [] }, 'Units 482. We do not extend the loan.', '');
  assert.equal(own.verdict, 'matches-frozen-gold');
  assert.deepEqual(own.decision.found, ['do not extend']);
  assert.equal(suggest({ gold: { decision: 'no change', figures: [] }, fingerprints: [] }, 'There is no change in plan.', '').verdict, 'matches-frozen-gold');
  /* negation is about decision keywords only: a fingerprint token and a gold figure are not read for it */
  assert.equal(suggest(freeze(), 'We did not use gross units of 611 here.', '').fingerprints[0].hit, true);
  assert.equal(suggest(freeze(), 'Approve the refinancing. We did not see units of 482 and margin 31.5%.', '').verdict, 'matches-frozen-gold');
  /* keywords that are only negated leave no keyword, so a gold with no other criterion is no match */
  assert.equal(suggest({ gold: { decision: 'approve' }, fingerprints: [] }, 'we do not approve', '').verdict, 'unclear');
  assert.equal(suggest({ gold: { decision: 'approve' }, fingerprints: [] }, 'we approve', '').verdict, 'matches-frozen-gold');
});

test('a clause boundary ends the negation window; "no," is an answer; avoid counts only right before the keyword', () => {
  const on = (keyword, text) => suggest({ gold: { decision: keyword, figures: [{ label: 'units', value: 482, tolerance: 0 }] }, fingerprints: [] }, 'Units are 482. ' + text, '');
  const affirmed = (keyword, text) => {
    const result = on(keyword, text);
    assert.equal(result.verdict, 'matches-frozen-gold', text);
    assert.deepEqual(result.decision.found, [keyword], text);
    assert.ok(!('reason' in result), text);
  };
  const negated = (keyword, text) => {
    const result = on(keyword, text);
    assert.equal(result.verdict, 'unclear', text);
    assert.deepEqual(result.decision.found, [], text);
    assert.match(result.reason, /only after a negation/, text);
  };
  /* the four sentences of the review */
  affirmed('reject the proposal', 'Should the lender accept? No, reject the proposal.');
  affirmed('refinance', 'To avoid default, refinance the term loan now.');
  affirmed('approve', 'There are no issues, approve the refinancing.');
  affirmed('approve the refinancing', 'The board should not delay: approve the refinancing.');
  /* each boundary: , : ; . ! ? a spaced dash (any kind), a new line */
  for (const mark of [',', ':', ';', '.', '!', '?']) affirmed('approve the refinancing', `We would not wait${mark} approve the refinancing.`);
  for (const dash of ['-', '--', '\u2013', '\u2014']) affirmed('approve the refinancing', `We would not wait ${dash} approve the refinancing.`);
  affirmed('approve the refinancing', 'We would not wait\napprove the refinancing.');
  affirmed('approve the refinancing', 'No: approve the refinancing.');
  affirmed('approve the refinancing', 'No; approve the refinancing.');
  affirmed('approve the refinancing', 'No - approve the refinancing.');
  affirmed('approve the refinancing', 'NO, APPROVE THE REFINANCING.');
  affirmed('approve the refinancing', 'Never mind, approve the refinancing.');
  affirmed('approve the refinancing', '(no), approve the refinancing.');
  /* a dash inside a word is not a boundary */
  negated('approve the refinancing', 'We do not co-sign then approve the refinancing.');
  negated('approve the refinancing', 'We do not re-approve the refinancing.');
  /* still negated: not, no, never, cannot and n't within three words of the keyword in the same clause */
  negated('approve the refinancing', 'We should not approve the refinancing.');
  negated('approve the first offer', 'We do not approve the first offer.');
  negated('approve the first offer', 'I would not now approve the first offer.');
  negated('approve the refinancing', 'There is no case to approve the refinancing.');
  negated('approve the refinancing', "Lenders shouldn't approve the refinancing.");
  negated('approve the refinancing', 'We cannot approve the refinancing.');
  negated('approve the refinancing', 'Never will they approve the refinancing.');
  negated('approve the refinancing', 'Rejected. We do not approve the refinancing.');
  negated('approve the refinancing', 'Yes? No. We do not now approve the refinancing.');
  /* avoid counts only as the word right before the keyword */
  negated('refinancing', 'We should avoid refinancing the term loan.');
  negated('refinancing', 'Avoid refinancing.');
  affirmed('refinance', 'We should avoid default and refinance the term loan.');
  affirmed('refinance', 'We avoid trying to refinance the term loan.');
  affirmed('refinance', 'To avoid default and delay, refinance the term loan.');
  affirmed('refinance', 'Avoid: refinance the term loan.');
  /* the same keyword said both ways: one plain use is enough */
  affirmed('approve the refinancing', 'We do not approve the refinancing at 8%. We approve the refinancing at 6%.');
});

test('negation checking is bounded on a text full of negated keywords', () => {
  const started = Date.now();
  const text = 'not approve the refinancing '.repeat(150000) + 'units 482';
  const result = suggest(freeze({ gold: { decision: 'approve the refinancing', figures: [{ label: 'units', value: 482, tolerance: 0 }] } }), text, '');
  assert.equal(result.verdict, 'unclear');
  const affirmedLast = suggest(freeze({ gold: { decision: 'approve the refinancing', figures: [] } }), 'not approve the refinancing '.repeat(100000) + 'so approve the refinancing', '');
  assert.ok(['unclear', 'matches-frozen-gold'].includes(affirmedLast.verdict));
  assert.ok(Date.now() - started < 5000, `negation checks took ${Date.now() - started} ms`);
});

/* ------------------------------------------------------------------ weak evidence: a single digit */

test('a gold figure that is a single digit cannot make a match by itself, and the suggestion says why', () => {
  const single = (value, decision = '') => ({ gold: { decision, figures: [{ label: 'breaches', value, tolerance: 0 }] }, fingerprints: [] });
  const result = suggest(single(3), 'There were 3 covenants in the pack.', '');
  assert.equal(result.verdict, 'unclear');
  assert.equal(result.matches[0].found, true, 'it is found, and still listed as found');
  assert.equal(result.matches[0].weak, true);
  assert.equal(result.matches[0].where, 'final, a single digit that may be incidental', 'the page prints "found in the" and this');
  assert.match(result.matches[0].reason, /single-digit figure can match by chance/);
  assert.equal(result.reason, 'Weak evidence: the gold figure breaches (3) is a single digit, so the match may be incidental, and no decision keyword confirms it.');
  /* a gold value written as one digit, with an optional sign and spaces around it */
  for (const [value, text] of [[0, 'the figure was 0 overall'], [1, 'the figure was 1 overall'], [5, 'the figure was 5 overall'], [9, 'the figure was 9 overall'], [-4, 'the figure was -4 overall'], ['7', 'the figure was 7 overall'],
    ['-4', 'the figure was -4 overall'], ['+4', 'the figure was 4 overall'], [' 3 ', 'the figure was 3 overall'], [2.0, 'the figure was 2 overall']]) {
    const weak = suggest(single(value), text, '');
    assert.equal(weak.verdict, 'unclear', String(value));
    assert.equal(weak.matches[0].weak, true, String(value));
  }
  /* written with more than a bare digit, the writer was specific: a decimal point, a percent or currency sign, a multiple, brackets */
  for (const [value, text] of [['3.0', 'it was 3'], ['2.0x', 'it was 2'], ['5%', 'it was 5'], ['$8', 'it was 8'], ['(6)', 'it was -6'], ['4.', 'it was 4'], ['0.0', 'it was 0'], ['1,0', 'it was 10'], ['5 %', 'it was 5']]) {
    const specific = suggest(single(value), text, '');
    assert.equal(specific.verdict, 'matches-frozen-gold', String(value));
    assert.ok(!('weak' in specific.matches[0]), String(value));
    assert.equal(specific.matches[0].where, 'final', String(value));
    assert.ok(!('reason' in specific), String(value));
  }
  /* not single digits: two digits, a fraction, a larger number */
  for (const [value, text] of [[10, 'it was 10'], [3.5, 'it was 3.5'], [482, 'it was 482'], [-12, 'it was -12'], ['0.5', 'it was 0.5'], [9.5, 'it was 9.5']]) {
    const strong = suggest(single(value), text, '');
    assert.equal(strong.verdict, 'matches-frozen-gold', String(value));
    assert.ok(!('weak' in strong.matches[0]), String(value));
    assert.equal(strong.matches[0].where, 'final');
    assert.ok(!('reason' in strong));
  }
  /* a decision keyword that is in the answer confirms it */
  const confirmed = suggest(single(3, 'approve'), 'Approve. There were 3 breaches.', '');
  assert.equal(confirmed.verdict, 'matches-frozen-gold');
  assert.equal(confirmed.matches[0].weak, true, 'the figure is still marked weak');
  assert.ok(!('reason' in confirmed), 'nothing kept the match from counting');
  assert.equal(suggest(single(3, 'approve'), 'Do not approve. There were 3 breaches.', '').verdict, 'unclear', 'a negated keyword confirms nothing');
  assert.equal(suggest(single(3, 'approve'), 'There were 3 breaches.', '').verdict, 'unclear', 'neither does one that is missing');
  /* another gold figure that is not a single digit */
  const together = suggest({ gold: { decision: '', figures: [{ label: 'breaches', value: 3, tolerance: 0 }, { label: 'units', value: 482, tolerance: 0 }] }, fingerprints: [] }, '3 breaches and 482 units', '');
  assert.equal(together.verdict, 'matches-frozen-gold');
  assert.deepEqual(together.matches.map(m => m.weak === true), [true, false]);
  assert.ok(!('reason' in together));
  /* all gold figures weak: still no match */
  const allWeak = suggest({ gold: { decision: '', figures: [{ label: 'a', value: 3 }, { label: 'b', value: 4 }] }, fingerprints: [] }, 'a 3 and b 4', '');
  assert.equal(allWeak.verdict, 'unclear');
  assert.equal(allWeak.reason, 'Weak evidence: the gold figures a (3), b (4) are single digits, so the match may be incidental, and no decision keyword confirms them.');
  /* not found, or only in the outputs: nothing to call weak */
  const absent = suggest(single(3), 'nothing numeric', '');
  assert.ok(!('weak' in absent.matches[0]) && absent.matches[0].where === null && !('reason' in absent));
  const inOutputs = suggest(single(3), 'See the file.', 'breaches 3');
  assert.ok(!('weak' in inOutputs.matches[0]) && inOutputs.matches[0].where === 'outputs');
  assert.match(inOutputs.reason, /^The gold figure breaches \(3\) appears only in the output files/);
  assert.ok(!/Weak evidence/.test(inOutputs.reason));
  /* a weak gold does not hide a fingerprint that the answer states */
  const withPrint = suggest({ gold: single(3).gold, fingerprints: [{ id: 'fp', label: 'wrong', tokens: ['gross units'], figures: [] }] }, 'There were 3 breaches on gross units.', '');
  assert.equal(withPrint.verdict, 'fingerprint');
  assert.match(withPrint.reason, /^Weak evidence/);
  /* the freeze and the gold are not changed by looking */
  const record = { gold: single(3).gold, fingerprints: [] };
  const copy = JSON.parse(JSON.stringify(record));
  suggest(record, 'There were 3 breaches.', 'x');
  assert.deepEqual(record, copy);
});
