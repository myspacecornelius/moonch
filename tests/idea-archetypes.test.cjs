'use strict';
/* Tests for idea-archetypes.js (global FinanceIdeaArchetypes): the generic mechanism catalog of the idea generator.
   All fixtures here are synthetic. The catalog is checked as data: its shape, its ids and causal groups, its mechanism ids against the
   research catalog, its text against the repo lint (the real FinanceCore.lintGuidance on fragments and the real FinanceCore.generateGuidance, which
   splice the fields into fixed sentences), the vocabulary the product keeps out of generated text, and its signals (they compile, they
   are lowercase, they stay fast on a large text and on hostile text). No fixture contains a workbook row, a score or an entity name. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const C = require('../core.js');
const A = require('../idea-archetypes.js');
const CATALOG = require('../research-catalog.json');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'idea-archetypes.js'), 'utf8');
const LIST = A.archetypes;
const KINDS = ['base-or-definition', 'timing-or-date', 'scope-or-classification', 'source-conflict', 'arithmetic-or-structure', 'instruction-or-presentation'];
const KEYS = ['id', 'name', 'kind', 'mechanism', 'summary', 'whyItHolds', 'buildMoves', 'wrongApproach', 'correctTreatment', 'detection', 'consequence',
  'howSolversGoWrong', 'needs', 'signals', 'workflowHints', 'lead', 'supporting', 'causalGroup'].sort();

/* The same sentence builders as FinanceCore.generateGuidance (core.js), so a spliced paragraph can be rebuilt here. */
const lower = s => { s = String(s).trim().replace(/\s+/g, ' '); return s ? s[0].toLowerCase() + s.slice(1) : ''; };
const sentence = s => { s = String(s).trim().replace(/\s+/g, ' '); return s ? s.replace(/[.!?]+$/, '') + '.' : ''; };
const spliced = a => [
  sentence('A tempting mistake is to ' + lower(a.wrongApproach)),
  sentence('The correct treatment is to ' + lower(a.correctTreatment)),
  sentence('To check it, ' + lower(a.detection)),
  sentence('If missed, ' + lower(a.consequence))].join(' ');

/* Every string a person can read, with its field name. Signals and hints are listed separately. */
function prose(a) {
  return [['name', a.name], ['summary', a.summary], ['whyItHolds', a.whyItHolds], ['wrongApproach', a.wrongApproach], ['correctTreatment', a.correctTreatment],
    ['detection', a.detection], ['consequence', a.consequence],
    ...a.buildMoves.map((x, i) => ['buildMoves[' + i + ']', x]),
    ...a.howSolversGoWrong.map((x, i) => ['howSolversGoWrong[' + i + ']', x]),
    ...a.needs.map((x, i) => ['needs[' + i + ']', x])];
}
function cues(a) {
  return [...a.signals.terms, ...a.signals.regex, ...(a.signals.needsAll || []), ...(a.signals.negative || []), ...a.workflowHints].map(x => ['signal', x]);
}

/* Words and marks that generated idea text must never carry: the lint blockers and reviews of core.js, the teaching words of the audit,
   the directional vocabulary of the views, and the marker of an unedited scaffold. */
const PCT = String.fromCharCode(37);
const DASHES_AND_ARROWS = new RegExp('[' + [0x2014, 0x2013, 0x2192, 0x2190, 0x21d2, 0x2191, 0x2193, 0xd7, 0xf7].map(c => String.fromCharCode(c)).join('') + ']');
const CURRENCY = new RegExp('[$' + String.fromCharCode(0xa3, 0x20ac) + ']');
const BANNED = [
  new RegExp(PCT), DASHES_AND_ARROWS,
  /\b(?:pass|success|failure|fail) rate\b/i, /\bdifficult/i, /\bhard(?:er|est)?\b/i, /\bcaught\b/i, /\bcatch/i, /\bfail(?:s|ed)?\b/i,
  /\bworks\b/i, /\bpredict/i, /\blikel(?:y|ihood)\b/i, /\bprobab/i,
  /\bscor(?:e|es|ed|ing)\b/i, /\bpoints?\b/i, /\bgrading\b/i, /\bpenal/i, /\b(?:partial|full|no) credit\b/i, /\brubric/i, /\bweighting/i, /\bdeduct/i, /\breward/i,
  /\btrap/i, /\bpitfall/i, /\bgotcha/i, /\bfixed.point\b/i, /\bremember to\b/i, /\bbe sure to\b/i, /\buse the formula\b/i, /\bdo not forget\b/i, /\bround down\b/i,
  /\bprompt/i, /\bai\b/i, /\b(?:claude|llm|gpt|chatgpt|language model|model-generated)\b/i,
  /\b(?:saf|gaf|mgp|difftest)\b/i, /\bgolden\b/i, /\bground truth\b/i, /\bgrader\b/i, /gaf\//i,
  /\[hypothesis: edit before use\]/i];

/* A repeated sentence of plain finance wording, cut to the requested size. */
function bulk(n) {
  const unit = 'the executed agreement states that the covenant test date falls after the cure period and the approval matrix requires board approval for the revolver availability. ';
  return unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
}
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termRe = t => new RegExp('(?:^|[^a-z0-9])' + esc(t));

test('the catalog has the documented shape: a version, 44 archetypes and the six kinds', () => {
  assert.deepEqual(Object.keys(A).sort(), ['archetypes', 'kinds', 'version']);
  assert.equal(A.version, 1);
  assert.deepEqual(A.kinds, KINDS);
  assert.equal(LIST.length, 44);
  assert.equal(Array.isArray(LIST), true);
});

test('ids run from ia-01 to ia-44 and are unique; causal groups are deterministic and unique', () => {
  LIST.forEach((a, i) => assert.equal(a.id, 'ia-' + String(i + 1).padStart(2, '0')));
  assert.equal(new Set(LIST.map(a => a.id)).size, LIST.length);
  for (const a of LIST) assert.equal(a.causalGroup, 'cg-' + a.id);
  assert.equal(new Set(LIST.map(a => a.causalGroup)).size, LIST.length);
  for (const a of LIST) assert.match(a.id, /^[A-Za-z0-9_-]{1,120}$/);
  assert.equal(new Set(LIST.map(a => a.name)).size, LIST.length, 'names are unique');
});

test('every archetype carries exactly the contract fields and no field is empty', () => {
  for (const a of LIST) {
    assert.deepEqual(Object.keys(a).sort(), KEYS, a.id);
    for (const k of ['id', 'name', 'kind', 'mechanism', 'summary', 'whyItHolds', 'wrongApproach', 'correctTreatment', 'detection', 'consequence', 'causalGroup']) {
      assert.equal(typeof a[k], 'string', a.id + ' ' + k);
      assert.ok(a[k].trim().length > 0, a.id + ' ' + k + ' is empty');
      assert.equal(a[k], a[k].trim(), a.id + ' ' + k + ' has stray space');
    }
    for (const k of ['buildMoves', 'howSolversGoWrong', 'needs', 'workflowHints']) {
      assert.ok(Array.isArray(a[k]) && a[k].length > 0, a.id + ' ' + k + ' is empty');
      for (const x of a[k]) assert.ok(typeof x === 'string' && x.trim() === x && x.length > 0, a.id + ' ' + k + ' holds a bad entry');
      assert.equal(new Set(a[k]).size, a[k].length, a.id + ' ' + k + ' repeats an entry');
    }
    assert.ok(a.buildMoves.length >= 2 && a.buildMoves.length <= 4, a.id + ' needs two to four build moves');
    assert.ok(a.howSolversGoWrong.length >= 2 && a.needs.length >= 2, a.id);
    assert.equal(typeof a.lead, 'boolean');
    assert.equal(typeof a.supporting, 'boolean');
    assert.ok(!(a.lead && a.supporting), a.id + ' cannot be both lead and supporting');
    assert.equal(typeof a.signals, 'object');
  }
});

test('kinds are valid and each of the six is used; mechanisms are catalog ids from the research catalog', () => {
  const ids = CATALOG.mechanisms.map(m => m.id);
  assert.equal(ids.length, 14);
  for (const a of LIST) {
    assert.ok(KINDS.includes(a.kind), a.id + ' kind ' + a.kind);
    assert.ok(ids.includes(a.mechanism), a.id + ' mechanism ' + a.mechanism);
  }
  assert.deepEqual([...new Set(LIST.map(a => a.kind))].sort(), [...KINDS].sort());
  assert.ok(new Set(LIST.map(a => a.mechanism)).size >= 10, 'the catalog spreads over the mechanisms');
});

test('the lead flag marks the authority gates and the recipes that let one wrong figure feed the headline; the supporting flag marks the secondary layers', () => {
  const lead = LIST.filter(a => a.lead).map(a => a.id);
  for (const id of ['ia-12', 'ia-36', 'ia-37']) assert.ok(lead.includes(id), id + ' is an authority gate');
  assert.ok(lead.includes('ia-27'), 'the carry-through recipe is a lead recipe');
  assert.ok(lead.length >= 4 && lead.length <= 8, 'lead stays a short list');
  const supporting = LIST.filter(a => a.supporting).map(a => a.id);
  for (const id of ['ia-05', 'ia-06']) assert.ok(supporting.includes(id), id + ' is a secondary layer');
  for (const id of supporting) assert.ok(!lead.includes(id));
});

test('field grammar: each phrase reads after its lead-in and the moves are imperative sentences', () => {
  for (const a of LIST) {
    for (const k of ['wrongApproach', 'correctTreatment', 'detection', 'consequence']) {
      assert.match(a[k], /^[a-z]/, a.id + ' ' + k + ' starts in lower case');
      assert.doesNotMatch(a[k], /[.!?]$/, a.id + ' ' + k + ' has no closing mark');
      assert.doesNotMatch(a[k], /\n/);
    }
    for (const m of a.buildMoves) {
      assert.match(m, /^[A-Z][a-z]+ /, a.id + ' move starts with a capital verb');
      assert.match(m, /\.$/, a.id + ' move ends with a full stop');
      assert.equal((m.match(/\. /g) || []).length, 0, a.id + ' move is one sentence');
    }
    assert.match(a.summary, /^[A-Z].*\.$/);
    assert.match(a.whyItHolds, /^[A-Z].*\.$/);
    assert.ok(a.summary.split(/(?<=\.)\s/).length === 1, a.id + ' summary is one sentence');
    for (const x of [...a.howSolversGoWrong, ...a.needs]) {
      assert.match(x, /^[a-z]/, a.id + ' list phrase starts in lower case');
      assert.doesNotMatch(x, /\.$/);
    }
  }
});

test('every spliced sentence passes the real lint, both rebuilt by hand and through the real guidance generator', () => {
  const root = a => Object.assign(C.root(), {
    title: a.name, mechanism: a.mechanism, causalGroup: a.causalGroup, wrongInterpretation: a.wrongApproach, correctInterpretation: a.correctTreatment,
    detectionMethod: a.detection, headlineWrong: a.consequence });
  for (const a of LIST) {
    const own = C.lintGuidance(spliced(a), {fragment: true});
    assert.deepEqual(own, [], a.id + ' rebuilt paragraph: ' + JSON.stringify(own));
    const p = C.blank();
    p.business = { objective: 'funding headroom for the planned payment', deliverable: 'a short memo', decision: 'whether to proceed', prompt: '' };
    p.roots = [root(a)];
    const g = C.generateGuidance(p);
    assert.deepEqual(g.lint, [], a.id + ' generated guidance: ' + JSON.stringify(g.lint));
    assert.ok(g.text.includes(sentence('A tempting mistake is to ' + lower(a.wrongApproach))), a.id);
    assert.ok(g.text.includes(sentence('If missed, ' + lower(a.consequence))), a.id);
  }
});

test('every other sentence also passes the lint when it stands alone', () => {
  for (const a of LIST) {
    for (const [field, text] of prose(a)) {
      const items = C.lintGuidance(sentence(text), {fragment: true});
      assert.deepEqual(items, [], a.id + ' ' + field + ': ' + JSON.stringify(items));
    }
    // the shipped build moves read as one block too, the way an author would paste them
    assert.deepEqual(C.lintGuidance(a.buildMoves.join(' '), {fragment: true}), [], a.id + ' build moves');
  }
});

test('forbidden vocabulary sweep over every string, including names, signals and workflow hints', () => {
  for (const a of LIST) {
    for (const [field, text] of [...prose(a), ...cues(a)]) {
      for (const re of BANNED) assert.doesNotMatch(text, re, a.id + ' ' + field + ' trips ' + re + ': ' + text);
    }
  }
  assert.doesNotMatch(SRC, /\[hypothesis: edit before use\]/i);
  assert.equal(SRC.includes(PCT), false, 'the source carries no percent sign at all');
  assert.doesNotMatch(SRC, DASHES_AND_ARROWS, 'the source carries no dash or arrow');
});

test('the statements a card makes as fact never describe what a solver does: the word is kept to the advice for the person building the task', () => {
  for (const a of LIST) {
    for (const k of ['name', 'summary', 'whyItHolds', 'wrongApproach', 'correctTreatment', 'detection', 'consequence']) {
      assert.doesNotMatch(a[k], /solver/i, a.id + ' ' + k + ' makes a claim about a solver: ' + a[k]);
    }
  }
});

test('names are short, plain and distinct from each other, and no summary repeats another summary or its own name', () => {
  const names = new Set(), summaries = new Set();
  for (const a of LIST) {
    assert.ok(a.name.split(/\s+/).length >= 3 && a.name.split(/\s+/).length <= 11, a.id + ' name length: ' + a.name);
    assert.ok(a.summary.split(/\s+/).length >= 18 && a.summary.split(/\s+/).length <= 50, a.id + ' summary length');
    assert.notEqual(a.summary.toLowerCase().replace(/\.$/, ''), a.name.toLowerCase());
    assert.equal(names.has(a.name.toLowerCase()), false);
    assert.equal(summaries.has(a.summary), false);
    names.add(a.name.toLowerCase()); summaries.add(a.summary);
  }
});

test('the prose carries no digits, no figures and no proper nouns', () => {
  for (const a of LIST) {
    for (const [field, text] of prose(a)) {
      assert.doesNotMatch(text, /\d/, a.id + ' ' + field + ' holds a digit');
      assert.doesNotMatch(text, CURRENCY, a.id + ' ' + field + ' holds a currency sign');
      if (/^(?:wrongApproach|correctTreatment|detection|consequence|howSolversGoWrong|needs)/.test(field)) {
        assert.doesNotMatch(text, /[A-Z]/, a.id + ' ' + field + ' holds a capital letter');
      } else {
        for (const s of text.split(/(?<=[.!?])\s+/)) {
          const rest = s.split(/\s+/).slice(1);
          for (const w of rest) assert.doesNotMatch(w, /^[("']?[A-Z]/, a.id + ' ' + field + ' holds a capitalised word: ' + w);
        }
      }
    }
  }
});

test('signals are well formed: lowercase terms and regexes that compile, no empty or empty-matching entries', () => {
  for (const a of LIST) {
    const s = a.signals;
    assert.ok(Object.keys(s).every(k => ['terms', 'regex', 'needsAll', 'negative'].includes(k)), a.id + ' signal keys');
    assert.ok(Array.isArray(s.terms) && s.terms.length >= 5, a.id + ' has at least five terms');
    assert.ok(Array.isArray(s.regex), a.id);
    for (const k of ['terms', 'regex', 'needsAll', 'negative']) {
      if (s[k] === undefined) continue;
      assert.ok(Array.isArray(s[k]), a.id + ' ' + k);
      assert.equal(new Set(s[k]).size, s[k].length, a.id + ' ' + k + ' repeats an entry');
      for (const x of s[k]) {
        assert.equal(typeof x, 'string');
        assert.ok(x.length >= 3 && x === x.trim(), a.id + ' ' + k + ' entry ' + JSON.stringify(x));
      }
    }
    for (const t of [...s.terms, ...(s.needsAll || []), ...(s.negative || [])]) assert.equal(t, t.toLowerCase(), a.id + ' term ' + t);
    for (const src of s.regex) {
      assert.equal(src.replace(/\\[A-Za-z]/g, ''), src.replace(/\\[A-Za-z]/g, '').toLowerCase(), a.id + ' regex is lowercase: ' + src);
      const re = new RegExp(src, 'i');
      assert.equal(re.test(''), false, a.id + ' regex matches the empty text: ' + src);
      assert.equal(re.test(' '), false);
      assert.equal(re.test('x'), false);
    }
    for (const t of s.terms) assert.equal(termRe(t).test(''), false);
    for (const h of a.workflowHints) assert.equal(h, h.toLowerCase());
  }
});

test('signals stay fast on a 200 KB text and on hostile text', () => {
  const texts = {
    plain: bulk(200 * 1024),
    repeatedWord: 'executed '.repeat(24000),
    singleLetters: 'a '.repeat(100000),
    noSpaces: 'x'.repeat(200 * 1024),
    separators: '- '.repeat(100000),
    people: 'cfo '.repeat(50000),
    longWords: ('approval' + 'a'.repeat(60) + ' ').repeat(3000)
  };
  let total = 0;
  // One archetype at a time runs in a vm with a time limit, so a pattern with runaway backtracking fails the test instead of hanging the run.
  const sandbox = vm.createContext({ res: [], texts: {}, out: [] });
  const batch = '(function () { const out = []; for (const re of res) for (const key of Object.keys(texts)) { const t0 = Date.now(); re.test(texts[key]); out.push(Date.now() - t0); } return out; })()';
  for (const a of LIST) {
    sandbox.res = [...a.signals.terms.map(t => termRe(t)), ...a.signals.regex.map(r => new RegExp(r, 'i'))];
    sandbox.texts = texts;
    let times;
    try { times = vm.runInContext(batch, sandbox, { timeout: 5000 }); } catch (e) { assert.fail(a.id + ' has a signal that did not finish in time: ' + e.code); }
    assert.equal(times.length, sandbox.res.length * Object.keys(texts).length);
    for (const ms of times) { total += ms; assert.ok(ms < 400, a.id + ' has a signal that took ' + ms + ' ms'); }
  }
  assert.ok(total < 8000, 'all signals together took ' + total.toFixed(0) + ' ms');
});

test('the prose of each archetype is found by its own signals, and needsAll is met by it', () => {
  for (const a of LIST) {
    const text = prose(a).map(x => x[1]).join(' \n ').toLowerCase().replace(/\s+/g, ' ');
    const hit = a.signals.terms.some(t => termRe(t).test(text)) || a.signals.regex.some(r => new RegExp(r, 'i').test(text));
    assert.ok(hit, a.id + ' prose is not found by its own signals');
    for (const t of a.signals.needsAll || []) assert.ok(termRe(t).test(text), a.id + ' needsAll ' + t);
    for (const t of a.signals.negative || []) assert.equal(termRe(t).test(text), false, a.id + ' negative ' + t);
  }
});

test('signals separate the archetypes: no two share an identical set of cues', () => {
  const seen = new Map();
  for (const a of LIST) {
    const key = JSON.stringify([[...a.signals.terms].sort(), [...a.signals.regex].sort()]);
    assert.equal(seen.has(key), false, a.id + ' repeats the cues of ' + seen.get(key));
    seen.set(key, a.id);
  }
});

test('the module is plain data: it loads as a global, serialises to JSON and touches no browser, clock or network API', () => {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const loaded = ctx.window.FinanceIdeaArchetypes;
  assert.ok(loaded && Array.isArray(loaded.archetypes));
  assert.deepEqual(JSON.parse(JSON.stringify(loaded)), JSON.parse(JSON.stringify(A)));
  assert.deepEqual(JSON.parse(JSON.stringify(A)), JSON.parse(JSON.stringify(require('../idea-archetypes.js'))));
  assert.doesNotMatch(SRC, /\b(?:fetch|XMLHttpRequest|localStorage|sessionStorage|indexedDB)\b|\bdocument\.[A-Za-z]|\beval\(|new Function|Math\.random|Date\.now|\bIntl\b|localeCompare|setTimeout|\bimport\(|\brequire\(/);
  const clean = (v) => { if (typeof v === 'function') throw new Error('function value'); if (v && typeof v === 'object') Object.values(v).forEach(clean); };
  clean(A);
  assert.equal(A.archetypes.every(a => Object.getPrototypeOf(a) === Object.prototype), true);
});

test('the catalog is deterministic and callers cannot corrupt a second load by editing a copy', () => {
  const copy = JSON.parse(JSON.stringify(A));
  copy.archetypes[0].name = 'changed';
  copy.archetypes[0].buildMoves.push('Extra move.');
  assert.notEqual(A.archetypes[0].name, 'changed');
  assert.equal(A.archetypes[0].buildMoves.length <= 4, true);
  delete require.cache[require.resolve('../idea-archetypes.js')];
  const again = require('../idea-archetypes.js');
  assert.deepEqual(JSON.parse(JSON.stringify(again)), JSON.parse(JSON.stringify(A)));
});
