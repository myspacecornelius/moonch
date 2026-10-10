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

test('the outputs text is searched too and the result says where a figure was found', () => {
  const result = suggest(freeze(), 'Approve the refinancing. Units are 482.', 'Summary table\nmargin 31.5%\n');
  assert.equal(result.verdict, 'matches-frozen-gold');
  assert.deepEqual(result.matches.map(m => m.where), ['final', 'outputs']);
  assert.equal(suggest(freeze(), 'Approve the refinancing.', 'units 482 margin 31.5%').verdict, 'matches-frozen-gold');
  const fromOutputs = suggest(freeze(), 'I am done.', 'gross units 611');
  assert.equal(fromOutputs.verdict, 'fingerprint');
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
  /* The phrase side and the text side fold case the same way, in the outputs text too. */
  const viaOutputs = suggest({ gold: { decision: 'Hold For The Board', figures: [] }, fingerprints: [] }, 'See the file.', 'hold for the board');
  assert.equal(viaOutputs.verdict, 'matches-frozen-gold');
});

test('curly quotes and dashes in a phrase match their plain forms, and a mixed-case token is not found inside a longer word', () => {
  const only = token => ({ gold: { figures: [{ label: 'u', value: 482, tolerance: 0 }] }, fingerprints: [{ id: 'f', label: 'f', tokens: [token], figures: [] }] });
  const hit = (token, text) => suggest(only(token), text, '').fingerprints[0].hit;
  assert.equal(hit('Atlas’ Plan', "units 482; the atlas' plan applies"), true, 'curly quote in the phrase');
  assert.equal(hit("Atlas' Plan", 'units 482; the ATLAS’ PLAN applies'), true, 'curly quote in the text');
  assert.equal(hit('Net Debt', 'units 482; Internet Debtors'), false, 'word boundaries still hold with capitals');
});
