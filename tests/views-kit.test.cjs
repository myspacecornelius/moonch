'use strict';
/* Tests for the shared UI kit (views-kit.js, global FinanceViews).
   The pure parts run directly under node. The DOM parts run against a small hand-written fake DOM defined below (elements, a
   fragment, a tiny HTML parser, simple selectors, events that bubble, focus that is lost when a node is detached, a layout hook),
   and the file is also loaded into the minimal fake documents the page tests use, to show it loads and degrades quietly there.
   Every name and text in here is synthetic. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..');
const KIT_SOURCE = fs.readFileSync(path.join(REPO, 'views-kit.js'), 'utf8');
const K = require('../views-kit.js');

/* ------------------------------------------------------------------ the fake DOM */

function makeDom() {
  const stats = { insertBefore: 0, fragAppend: 0, removeChild: 0, remove: 0, innerHTMLWrites: 0, focusCalls: 0, created: 0, lastFocus: null };
  const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link']);
  const doc = {};
  const dom = { doc, stats, layout: null };

  /* One compound selector: tag, #id, .class, [attr], [attr=value], [attr="value"] (backslash escapes inside quotes). */
  function parseCompound(text) {
    const out = { tag: null, id: null, classes: [], attrs: [] };
    let rest = text.trim();
    const tag = /^([a-zA-Z][\w-]*|\*)/.exec(rest);
    if (tag) { out.tag = tag[1] === '*' ? null : tag[1].toUpperCase(); rest = rest.slice(tag[0].length); }
    while (rest) {
      let m;
      if ((m = /^#([\w-]+)/.exec(rest))) out.id = m[1];
      else if ((m = /^\.([\w-]+)/.exec(rest))) out.classes.push(m[1]);
      else if ((m = /^\[([\w-]+)(?:=(?:"((?:\\.|[^"\\])*)"|([^\]]*)))?\]/.exec(rest))) {
        const value = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3];
        out.attrs.push([m[1], value === undefined ? null : value]);
      } else throw new Error('fake DOM: unsupported selector ' + text);
      rest = rest.slice(m[0].length);
    }
    return out;
  }
  const splitSelectors = selector => selector.split(/,(?![^[]*\])/).map(s => s.trim()).filter(Boolean);
  function matchesCompound(el, c) {
    if (!(el instanceof FElement)) return false;
    if (c.tag && el.tagName !== c.tag) return false;
    if (c.id && el.getAttribute('id') !== c.id) return false;
    const classes = (el.getAttribute('class') || '').split(/\s+/);
    if (!c.classes.every(x => classes.includes(x))) return false;
    return c.attrs.every(([name, value]) => (value === null ? el.hasAttribute(name) : el.getAttribute(name) === value));
  }
  const matchesSelector = (el, selector) => splitSelectors(selector).some(s => matchesCompound(el, parseCompound(s)));

  function parseInto(parent, markup) {
    const re = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/)?>|([^<]+)/g;
    const attrRe = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    const stack = [parent];
    const adopt = (to, child) => { child.parentNode = to; to.childNodes.push(child); };
    let m;
    while ((m = re.exec(markup))) {
      const top = stack[stack.length - 1];
      if (m[5] !== undefined) { adopt(top, new FText(m[5])); continue; }
      if (m[0].startsWith('<!--')) continue;
      const tag = m[2].toLowerCase();
      if (m[1]) {
        for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName.toLowerCase() === tag) { stack.length = i; break; }
        continue;
      }
      const el = new FElement(tag);
      let a;
      attrRe.lastIndex = 0;
      while ((a = attrRe.exec(m[3] || ''))) el._attrs.set(a[1], a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : '');
      if (el._attrs.has('value')) el.value = el._attrs.get('value');
      adopt(top, el);
      if (!VOID.has(tag) && !m[4]) stack.push(el);
    }
  }

  class FNode {
    constructor() { this.parentNode = null; this.childNodes = []; this.ownerDocument = doc; this._listeners = {}; }
    get firstChild() { return this.childNodes[0] || null; }
    get nextSibling() {
      const p = this.parentNode;
      if (!p) return null;
      const i = p.childNodes.indexOf(this);
      return i < 0 ? null : p.childNodes[i + 1] || null;
    }
    get children() { return this.childNodes.filter(n => n instanceof FElement); }
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    _unlink() {
      const p = this.parentNode;
      if (!p) return;
      const i = p.childNodes.indexOf(this);
      if (i >= 0) p.childNodes.splice(i, 1);
      this.parentNode = null;
      /* A browser drops focus from a node that leaves the document, and from one that is moved. */
      if (doc.activeElement && this.contains(doc.activeElement)) doc.activeElement = doc.body;
    }
    insertBefore(node, ref) {
      if (this instanceof FFrag) stats.fragAppend++; else stats.insertBefore++;
      if (ref && ref.parentNode !== this) throw new Error('fake DOM: the reference node is not a child');
      const incoming = node instanceof FFrag ? node.childNodes.splice(0) : [node];
      incoming.forEach(k => { if (k.parentNode) k._unlink(); });
      const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
      incoming.forEach((k, i) => { k.parentNode = this; this.childNodes.splice(at + i, 0, k); });
      return node;
    }
    appendChild(node) { return this.insertBefore(node, null); }
    removeChild(node) {
      stats.removeChild++;
      if (node.parentNode !== this) throw new Error('fake DOM: not a child');
      node._unlink();
      return node;
    }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter(f => f !== fn); }
    listenerCount(type) { return (this._listeners[type] || []).length; }
    /* Dispatch an event at this node; it bubbles up through the parents. */
    fire(type, props = {}) {
      const ev = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props };
      for (let n = this; n; n = n.parentNode) {
        ev.currentTarget = n;
        (n._listeners[type] || []).slice().forEach(fn => fn(ev));
      }
      return ev;
    }
  }
  class FText extends FNode { constructor(data) { super(); this.data = data; } }
  class FFrag extends FNode {}
  class FElement extends FNode {
    constructor(tag) {
      super();
      this.tagName = tag.toUpperCase();
      this._attrs = new Map();
      this.scrollTop = 0; this.scrollLeft = 0;
      this.selectionStart = null; this.selectionEnd = null;
      this.value = '';
      this._html = '';
    }
    getAttribute(name) { return this._attrs.has(name) ? this._attrs.get(name) : null; }
    setAttribute(name, value) { this._attrs.set(name, String(value)); }
    removeAttribute(name) { this._attrs.delete(name); }
    hasAttribute(name) { return this._attrs.has(name); }
    get id() { return this.getAttribute('id') || ''; }
    set id(v) { this.setAttribute('id', v); }
    get className() { return this.getAttribute('class') || ''; }
    set className(v) { this.setAttribute('class', v); }
    get open() { return this._attrs.has('open'); }
    set open(v) { if (v) this.setAttribute('open', ''); else this.removeAttribute('open'); }
    get disabled() { return this._attrs.has('disabled'); }
    get tabIndex() { const v = this.getAttribute('tabindex'); return v === null ? -1 : Number(v); }
    get innerHTML() { return this._html; }
    set innerHTML(markup) {
      stats.innerHTMLWrites++;
      this.childNodes.slice().forEach(k => k._unlink());
      this._html = String(markup);
      parseInto(this, this._html);
    }
    get textContent() { return this.childNodes.map(k => (k instanceof FText ? k.data : k.textContent)).join(''); }
    set textContent(text) {
      this.childNodes.slice().forEach(k => k._unlink());
      if (text) { const t = new FText(String(text)); t.parentNode = this; this.childNodes.push(t); }
    }
    matches(selector) { return matchesSelector(this, selector); }
    closest(selector) { for (let n = this; n instanceof FElement; n = n.parentNode) if (n.matches(selector)) return n; return null; }
    querySelectorAll(selector) {
      const out = [];
      const walk = node => node.childNodes.forEach(k => { if (k instanceof FElement) { if (matchesSelector(k, selector)) out.push(k); walk(k); } });
      walk(this);
      return out;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    focus(opts) {
      if (this.disabled) return;
      stats.focusCalls++;
      stats.lastFocus = opts || null;
      doc.activeElement = this;
    }
    blur() { if (doc.activeElement === this) doc.activeElement = doc.body; }
    select() {}
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
    remove() { stats.remove++; this._unlink(); }
    getBoundingClientRect() { return dom.layout ? dom.layout(this) : { top: 0, bottom: 0, left: 0, right: 0, height: 0, width: 0 }; }
  }
  Object.assign(doc, {
    hidden: false, execCommand: null, _listeners: {},
    createElement(tag) { stats.created++; return new FElement(tag); },
    createDocumentFragment() { return new FFrag(); },
    createTextNode(data) { return new FText(data); },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter(f => f !== fn); },
    fire(type) { (this._listeners[type] || []).slice().forEach(fn => fn({ type })); },
  });
  doc.body = new FElement('body');
  doc.activeElement = doc.body;
  /* make(tag, markup): an element attached to the body, optionally with markup parsed into it. */
  dom.make = (tag = 'div', markup = '') => {
    const el = doc.createElement(tag);
    doc.body.appendChild(el);
    if (markup) el.innerHTML = markup;
    stats.innerHTMLWrites = 0; stats.insertBefore = 0; stats.created = 0;
    return el;
  };
  dom.resetStats = () => { Object.keys(stats).forEach(k => { stats[k] = k === 'lastFocus' ? null : 0; }); };
  return dom;
}

const keysOf = container => container.children.map(c => c.getAttribute('data-key'));

/* ------------------------------------------------------------------ html and raw */

test('html escapes every interpolation: & < > " \' and the backtick, in text and in attributes', () => {
  const nasty = '<img src=x onerror="alert(1)"> & \'single\' "double" `tick`';
  const out = String(K.html`<p>${nasty}</p>`);
  assert.equal(out, '<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;single&#39; &quot;double&quot; &#96;tick&#96;</p>');
  for (const bad of ['<', '>', '"', "'", '`']) assert.ok(!out.slice(3, -4).includes(bad), 'no raw ' + bad + ' survives in the interpolation');
});

test('attribute-breaking input stays inside its attribute', () => {
  for (const evil of ['" onmouseover="alert(1)', "' onfocus='alert(1)", '"><script>alert(1)</script>', '`` onclick=x', '\u0022 autofocus x=\u0022']) {
    const out = String(K.html`<a title="${evil}" href="#">x</a>`);
    /* Parse the way a browser tokenizes: the title value runs to the next double quote. */
    const m = /^<a title="([^"]*)" href="#">x<\/a>$/.exec(out);
    assert.ok(m, 'one title attribute and nothing else: ' + out);
    assert.ok(!/[<>"]/.test(m[1]), 'no markup characters inside the value');
    const single = String(K.html`<a title='${evil}'>x</a>`);
    assert.ok(/^<a title='[^'"<>]*'>x<\/a>$/.test(single), 'a single-quoted attribute holds too: ' + single);
  }
});

test('arrays join, html and raw results pass through, null/undefined/false/true are empty, 0 and NaN print', () => {
  assert.equal(String(K.html`<ul>${['a', 'b<'].map(x => K.html`<li>${x}</li>`)}</ul>`), '<ul><li>a</li><li>b&lt;</li></ul>');
  assert.equal(String(K.html`[${null}][${undefined}][${false}][${true}][${0}][${NaN}][${''}]`), '[][][][][0][NaN][]');
  assert.equal(String(K.html`${['x', null, false, [K.raw('<b>'), '<i>']]}`), 'x<b>&lt;i&gt;');
  assert.equal(String(K.html`${K.raw('<b>ok</b>')}`), '<b>ok</b>');
  assert.equal(String(K.html`a${K.html`<em>${'<'}</em>`}b`), 'a<em>&lt;</em>b');
  assert.equal(String(K.raw(5)), '5');
  const once = K.raw('<x>');
  assert.equal(K.raw(once), once);
  assert.ok(K.isRaw(once) && !K.isRaw('<x>') && !K.isRaw({ text: '<x>' }));
  assert.equal(K.html`${{ toString() { throw new Error('boom'); } }}`.text, '', 'an object that cannot be printed becomes empty, not an exception');
  assert.equal(K.esc(Symbol('s')), 'Symbol(s)');
  assert.equal(K.escapeHtml, K.esc);
});

test('a plain object that looks like html output is escaped, not trusted', () => {
  const fake = { text: '<script>x</script>', isRaw: true };
  assert.ok(!String(K.html`${fake}`).includes('<script>'));
});

/* ------------------------------------------------------------------ clamp, stepClass */

test('clamp keeps a number inside the range, swaps reversed bounds, and turns NaN into a value inside the range', () => {
  assert.equal(K.clamp(5, 0, 3), 3);
  assert.equal(K.clamp(-1, 0, 3), 0);
  assert.equal(K.clamp(2, 0, 3), 2);
  assert.equal(K.clamp(2, 3, 0), 2);
  assert.equal(K.clamp(9, 3, 0), 3);
  assert.equal(K.clamp(NaN, 2, 5), 2);
  assert.equal(K.clamp(NaN, -5, 5), 0);
  assert.equal(K.clamp('7', 0, 10), 7);
  assert.equal(K.clamp(Infinity, 0, 10), 10);
  assert.equal(K.clamp(-Infinity, 0, 10), 0);
  assert.equal(K.clamp(4, NaN, 3), 3);
});

test('stepClass names one of N steps, clamped', () => {
  assert.equal(K.stepClass(3, 6), 'step-3');
  assert.equal(K.stepClass(0, 6), 'step-0');
  assert.equal(K.stepClass(5, 6), 'step-5');
  assert.equal(K.stepClass(9, 6), 'step-5');
  assert.equal(K.stepClass(-2, 6), 'step-0');
  assert.equal(K.stepClass(2.6, 6), 'step-3');
  assert.equal(K.stepClass(NaN, 6), 'step-0');
  assert.equal(K.stepClass(4, 1), 'step-0');
  assert.equal(K.stepClass(4, 0), 'step-0');
  assert.equal(K.stepClass(2, 6, 'wb-log-'), 'wb-log-2');
});

/* ------------------------------------------------------------------ planKeyed */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/* The reference answer for the minimum number of moves: n common keys minus the longest increasing subsequence (O(n^2) dynamic programme). */
function lisLength(seq) {
  const best = [];
  let top = 0;
  for (let i = 0; i < seq.length; i++) {
    best[i] = 1;
    for (let j = 0; j < i; j++) if (seq[j] < seq[i] && best[j] + 1 > best[i]) best[i] = best[j] + 1;
    top = Math.max(top, best[i]);
  }
  return top;
}
/* Apply a plan the way a DOM does: take the node out (remove, move) and insertBefore the anchor (move, insert). */
function applyLikeDom(prev, ops) {
  const list = prev.slice();
  const take = key => { const i = list.indexOf(key); assert.ok(i >= 0, 'op refers to a key that is in the list: ' + key); list.splice(i, 1); };
  for (const op of ops) {
    if (op.op === 'remove') take(op.key);
    else if (op.op === 'move') { take(op.key); list.splice(op.before === null ? list.length : list.indexOf(op.before), 0, op.key); }
    else if (op.op === 'insert') { assert.ok(!list.includes(op.key)); list.splice(op.before === null ? list.length : list.indexOf(op.before), 0, op.key); }
    else assert.equal(op.op, 'keep');
  }
  return list;
}
function shuffled(rand, list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
function checkPlan(prevIn, nextIn, label) {
  const prevBefore = prevIn.slice(), nextBefore = nextIn.slice();
  const ops = K.planKeyed(prevIn, nextIn);
  assert.deepEqual(prevIn, prevBefore, label + ': prevKeys not mutated');
  assert.deepEqual(nextIn, nextBefore, label + ': nextKeys not mutated');
  const prev = prevIn.map(String), next = nextIn.map(String); // keys are compared as text, like data-key
  assert.deepEqual(applyLikeDom(prev, ops), next, label + ': applying the ops to prev gives next');
  assert.deepEqual(K.applyPlan(prev, ops), next, label + ': applyPlan agrees');
  const nextSet = new Set(next), prevSet = new Set(prev);
  const removes = ops.filter(o => o.op === 'remove'), inserts = ops.filter(o => o.op === 'insert');
  const moves = ops.filter(o => o.op === 'move'), keeps = ops.filter(o => o.op === 'keep');
  assert.equal(removes.length, prev.filter(k => !nextSet.has(k)).length, label + ': one remove per vanished key');
  assert.equal(inserts.length, next.filter(k => !prevSet.has(k)).length, label + ': one insert per new key');
  assert.equal(keeps.length + moves.length + inserts.length, next.length, label + ': every next key has exactly one op');
  const common = next.filter(k => prevSet.has(k)).map(k => prev.indexOf(k));
  assert.equal(moves.length, common.length - lisLength(common), label + ': the number of moves is the minimum');
  assert.equal(ops.slice(0, removes.length).every(o => o.op === 'remove'), true, label + ': removals come first');
  const placing = ops.slice(removes.length);
  assert.deepEqual(placing.map(o => o.to), next.map((_, i) => next.length - 1 - i), label + ': then next is walked from its end to its start');
  for (const o of ops) {
    if (o.op === 'remove') assert.equal(prev[o.from], o.key);
    else {
      assert.equal(next[o.to], o.key);
      assert.equal(o.before, o.to + 1 < next.length ? next[o.to + 1] : null);
      if (o.op !== 'insert') assert.equal(prev[o.from], o.key);
    }
  }
  const keptFrom = keeps.map(o => o.from).reverse();
  assert.deepEqual(keptFrom, keptFrom.slice().sort((a, b) => a - b), label + ': kept keys keep their relative order');
  return ops;
}

test('planKeyed: 500 random cases (shuffles, edits, bursts), applying the ops to prev yields next, with the minimum number of moves', () => {
  const rand = mulberry32(20260711);
  const alphabet = Array.from({ length: 60 }, (_, i) => 'k' + i);
  for (let n = 0; n < 500; n++) {
    const size = n % 5 === 0 ? 45 : n % 3 === 0 ? 14 : 7;
    const universe = shuffled(rand, alphabet.slice(0, size + 6));
    const prev = universe.slice(0, Math.floor(rand() * (size + 1)));
    let next;
    const mode = n % 5;
    if (mode === 0) next = shuffled(rand, universe).slice(0, Math.floor(rand() * (size + 1)));
    else if (mode === 1) next = shuffled(rand, prev);
    else if (mode === 2) {
      next = prev.filter(() => rand() > 0.3);
      for (let i = 0, count = Math.floor(rand() * 5); i < count; i++) { const fresh = universe.find(k => !prev.includes(k) && !next.includes(k)); if (fresh) next.splice(Math.floor(rand() * (next.length + 1)), 0, fresh); }
    } else if (mode === 3) {
      next = prev.slice();
      for (let i = 0, count = Math.floor(rand() * 4); i < count && next.length; i++) { const [k] = next.splice(Math.floor(rand() * next.length), 1); next.splice(Math.floor(rand() * (next.length + 1)), 0, k); }
    } else next = [...universe.filter(k => !prev.includes(k)).slice(0, Math.floor(rand() * 4)), ...prev.slice(Math.floor(rand() * 3))];
    checkPlan(prev, next, 'case ' + n + ' ' + mode + ' ' + JSON.stringify([prev, next]));
  }
});

test('planKeyed: the shapes the views produce (arrivals at the top, trimming, rotation, reversal, empty lists)', () => {
  const ids = n => Array.from({ length: n }, (_, i) => 'r1:' + (i + 1));
  const cases = {
    'same list': [ids(6), ids(6)],
    'both empty': [[], []],
    'first paint': [[], ids(5)],
    'everything vanishes': [ids(5), []],
    'three arrivals on top': [ids(5), ['n:1', 'n:2', 'n:3', ...ids(5)]],
    'append at the end': [ids(5), [...ids(5), 'x']],
    'oldest trimmed': [ids(8), ids(8).slice(3)],
    'one in the middle': [ids(5), ['r1:1', 'r1:2', 'mid', 'r1:3', 'r1:4', 'r1:5']],
    'rotate left': [ids(6), [...ids(6).slice(1), ids(6)[0]]],
    'rotate right': [ids(6), [ids(6)[5], ...ids(6).slice(0, 5)]],
    'reverse': [ids(7), ids(7).slice().reverse()],
    'swap neighbours': [ids(4), ['r1:2', 'r1:1', 'r1:3', 'r1:4']],
    'single key': [['a'], ['a']],
    'single replaced': [['a'], ['b']],
    'numbers are keys too': [[1, 2, 3], [3, 1, 2]],
  };
  for (const [label, [prev, next]] of Object.entries(cases)) checkPlan(prev, next, label);
  /* Concrete shapes: a rotation is one move; a pure arrival burst has no moves at all. */
  assert.equal(K.planKeyed(ids(6), [...ids(6).slice(1), ids(6)[0]]).filter(o => o.op === 'move').length, 1);
  const burst = K.planKeyed(ids(5), ['n:1', 'n:2', 'n:3', ...ids(5)]);
  assert.deepEqual(burst.map(o => o.op), ['keep', 'keep', 'keep', 'keep', 'keep', 'insert', 'insert', 'insert']);
  assert.deepEqual(K.planKeyed(['a', 'b', 'c', 'd'], ['b', 'c', 'd', 'a']).filter(o => o.op === 'move'), [{ op: 'move', key: 'a', from: 0, to: 3, before: null }]);
  assert.deepEqual(K.planKeyed([1, 2], ['2', '1']).map(o => o.key), ['1', '2'], 'numeric keys are compared as text, like data-key');
});

test('planKeyed: keys that are names on Object.prototype are ordinary keys, and 20000 keys plan quickly', () => {
  const odd = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'a b', '', ' ', '\u00e9', '\ud83d\ude00'];
  checkPlan(odd, odd.slice().reverse(), 'prototype names');
  checkPlan(odd.slice(0, 5), [...odd.slice(3), 'zz'], 'prototype names, edited');
  const rand = mulberry32(5);
  const prev = Array.from({ length: 20000 }, (_, i) => 'k' + i);
  const next = shuffled(rand, prev.slice(0, 18000)).concat(Array.from({ length: 500 }, (_, i) => 'n' + i));
  const started = Date.now();
  const ops = K.planKeyed(prev, next);
  assert.ok(Date.now() - started < 1500, 'planned in ' + (Date.now() - started) + ' ms');
  assert.deepEqual(K.applyPlan(prev, ops), next.map(String));
});

test('planKeyed: duplicate keys are rejected with a message that names the list, the key and the positions', () => {
  assert.throws(() => K.planKeyed(['a', 'b', 'a'], []), /duplicate key "a" in prevKeys at index 2 \(first at 0\)/);
  assert.throws(() => K.planKeyed([], ['x', 'y', 'y']), /duplicate key "y" in nextKeys at index 2 \(first at 1\)/);
  assert.throws(() => K.planKeyed([1], ['1', '1']), /duplicate key "1" in nextKeys/);
  assert.throws(() => K.planKeyed(['k'], [1, '1']), /duplicate key "1"/);
  assert.throws(() => K.planKeyed(null, []), /prevKeys must be an array/);
  assert.throws(() => K.planKeyed([], 'abc'), /nextKeys must be an array/);
  assert.throws(() => K.planKeyed([null], []), /prevKeys\[0\] is not a string or finite number key/);
  assert.throws(() => K.planKeyed([], [{}]), /nextKeys\[0\] is not a string or finite number key/);
  assert.throws(() => K.planKeyed([], [NaN]), /not a string or finite number key/);
  assert.throws(() => K.planKeyed([], ['x'.repeat(200), 'x'.repeat(200)]), err => err.message.length < 200 && /duplicate key/.test(err.message), 'a long key is shortened in the message');
  assert.throws(() => K.applyPlan(['a'], [{ op: 'remove', key: 'zzz', from: 0 }]), /unknown key/);
  assert.throws(() => K.applyPlan(['a'], [{ op: 'insert', key: 'a', to: 0, before: null }]), /existing key/);
});

/* ------------------------------------------------------------------ announcer (pure core) */

/* Drive the announcer like the page does: timers fire exactly when the announcer says the next message is due. */
function driveAnnouncer(steps, config = {}) {
  let t = 0;
  const emitted = [];
  const a = K.makeAnnouncer({ now: () => t, emit: (text, detail) => emitted.push([t, text, detail.assertive]), ...config });
  const advance = to => {
    for (;;) {
      const d = a.delay();
      if (d === null || t + d > to) break;
      t += d;
      a.tick();
    }
    t = Math.max(t, to);
  };
  const results = [];
  for (const step of steps) {
    advance(step.at);
    if (step.say !== undefined) results.push(a.say(step.say, step.opts));
    if (step.alert !== undefined) results.push(a.alert(step.alert, step.opts));
    if (step.resolve !== undefined) a.resolve(step.resolve);
    if (step.setClock !== undefined) t = step.setClock;
  }
  advance(steps.length ? steps[steps.length - 1].until || 200000 : 0);
  return { emitted, results, a };
}

test('announcer timing table: coalesce 4 s, at most one message per 8 s', () => {
  const P1 = 'Pilot 1 completed.', P2 = 'Pilot 2 failed.', P3 = 'Pilot 3 discarded.', P4 = 'Pilot 4 cancelled.';
  const table = [
    ['one sentence goes out after the 4 s window', [{ at: 0, say: P1 }], [[4000, P1, false]]],
    ['sentences inside the window are one message', [{ at: 0, say: P1 }, { at: 1500, say: P2 }, { at: 3900, say: P3 }], [[4000, 'Pilot 1 completed. Pilot 2 failed. Pilot 3 discarded.', false]]],
    ['a sentence just after the window waits for the 8 s gap', [{ at: 0, say: P1 }, { at: 4500, say: P2 }], [[4000, P1, false], [12000, P2, false]]],
    ['sentences queued during the gap join the waiting message', [{ at: 0, say: P1 }, { at: 4500, say: P2 }, { at: 9000, say: P3 }, { at: 11999, say: P4 }], [[4000, P1, false], [12000, 'Pilot 2 failed. Pilot 3 discarded. Pilot 4 cancelled.', false]]],
    ['after a quiet spell the window alone applies', [{ at: 0, say: P1 }, { at: 30000, say: P2 }], [[4000, P1, false], [34000, P2, false]]],
    ['the same sentence twice is said once', [{ at: 0, say: P1 }, { at: 1000, say: P1 }, { at: 2000, say: '  Pilot   1\ncompleted.  ' }], [[4000, P1, false]]],
    ['empty and blank sentences are ignored', [{ at: 0, say: '' }, { at: 10, say: '   ' }, { at: 20, say: null }], []],
    ['a fresh sentence exactly 8 s after the last message needs only the window', [{ at: 0, say: P1 }, { at: 8000, say: P2 }], [[4000, P1, false], [12000, P2, false]]],
    ['two sentences 8 s apart are two messages', [{ at: 0, say: P1 }, { at: 4000, say: P2 }], [[4000, P1, false], [12000, P2, false]]],
  ];
  for (const [label, steps, expected] of table) assert.deepEqual(driveAnnouncer(steps).emitted, expected, label);
});

test('announcer: say returns the milliseconds until the next message is due', () => {
  const { results } = driveAnnouncer([{ at: 0, say: 'Pilot 1 completed.' }, { at: 1000, say: 'Pilot 2 failed.' }, { at: 5000, say: 'Pilot 3 failed.' }]);
  assert.deepEqual(results, [4000, 3000, 7000]);
});

test('announcer: an overdue batch goes out when the next sentence arrives, before the new one starts its own window', () => {
  const clock = { t: 0 };
  const out = [];
  const a = K.makeAnnouncer({ now: () => clock.t, emit: (text, d) => out.push([clock.t, text, d.assertive]) });
  a.say('Pilot 1 completed.');
  clock.t = 50000;
  const wait = a.say('Pilot 2 failed.');
  assert.deepEqual(out, [[50000, 'Pilot 1 completed.', false]], 'the old batch is flushed without waiting for a timer');
  assert.equal(wait, 8000, 'the new sentence waits for the 8 s gap measured from that message');
  clock.t = 58000;
  assert.equal(a.tick(), null);
  assert.deepEqual(out[1], [58000, 'Pilot 2 failed.', false]);
});

test('announcer: a message is at most 160 characters; whole sentences, then "+N more"', () => {
  const sentences = Array.from({ length: 12 }, (_, i) => 'Pilot ' + (i + 1) + ' completed in ' + (i + 3) + ' minutes.');
  const { emitted } = driveAnnouncer(sentences.map((say, i) => ({ at: i * 100, say })));
  assert.equal(emitted.length, 1);
  const text = emitted[0][1];
  assert.ok(text.length <= 160, text.length + ' chars');
  const m = /^(.*\.) \+(\d+) more$/.exec(text);
  assert.ok(m, 'ends with a count of the sentences left out: ' + text);
  const kept = m[1].split(/(?<=\.) /);
  assert.deepEqual(kept, sentences.slice(0, kept.length), 'the first sentences are kept whole and in order');
  assert.equal(kept.length + Number(m[2]), 12, 'kept plus left out is everything');

  const long = driveAnnouncer([{ at: 0, say: 'Pilot 4 failed because ' + 'the runtime stopped '.repeat(30) }]).emitted[0][1];
  assert.equal(long.length, 160);
  assert.ok(long.endsWith('\u2026'));

  const longThenMore = driveAnnouncer([{ at: 0, say: 'x'.repeat(400) }, { at: 10, say: 'Pilot 2 failed.' }, { at: 20, say: 'Pilot 3 failed.' }]).emitted[0][1];
  assert.ok(longThenMore.length <= 160 && /\u2026 \+2 more$/.test(longThenMore), longThenMore);

  const emoji = driveAnnouncer([{ at: 0, say: '\ud83d\ude00'.repeat(200) }]).emitted[0][1];
  assert.ok(emoji.length <= 160 && !/[\ud800-\udbff]\u2026$/.test(emoji) && !/[\ud800-\udbff]$/.test(emoji), 'no half a surrogate pair at the cut');
  assert.equal(driveAnnouncer([{ at: 0, say: 'Link restored' }]).emitted[0][1], 'Link restored', 'a single sentence is left as written');
  assert.ok(driveAnnouncer([{ at: 0, say: 'a'.repeat(100) }, { at: 1, say: 'b'.repeat(100) }]).emitted[0][1].length <= 160);
});

test('announcer: whatever is queued, a message is never above the limit, never empty, and accounts for every sentence', () => {
  const rand = mulberry32(31);
  const words = ['Pilot', 'round', 'failed', 'completed', 'the', 'runtime', 'stopped', 'audit', 'CLEAN', 'discarded', 'Atlas', 'Meridian', 'x'.repeat(30), 'y'.repeat(90)];
  for (let n = 0; n < 300; n++) {
    const sentences = Array.from({ length: 1 + Math.floor(rand() * 14) }, (_, i) => {
      const len = 1 + Math.floor(rand() * 12);
      return Array.from({ length: len }, () => words[Math.floor(rand() * words.length)]).join(' ') + (rand() < 0.5 ? '.' : '') + ' #' + i;
    });
    const max = [160, 40, 25][n % 3];
    const out = [];
    const a = K.makeAnnouncer({ now: () => 0, emit: t => out.push(t), maxChars: max });
    sentences.forEach(x => a.say(x));
    a.flush();
    assert.equal(out.length, 1);
    assert.ok(out[0].length > 0 && out[0].length <= Math.max(8, max), `${out[0].length} chars with a limit of ${max}: ${out[0]}`);
    const more = /^(.*) \+(\d+) more$/.exec(out[0]);
    if (more && sentences.length > 1) {
      const kept = sentences.slice(0, sentences.length - Number(more[2]));
      assert.ok(Number(more[2]) <= sentences.length);
      assert.ok(kept.length === 0 || more[1].startsWith(kept[0].replace(/\s+$/, '').slice(0, 5)), 'the first sentences come first');
    }
  }
});

test('announcer: only terminal transitions are announced', () => {
  assert.deepEqual([...K.TERMINAL_KINDS], ['completed', 'failed', 'discarded', 'cancelled', 'new-round', 'link-lost', 'link-restored']);
  const run = driveAnnouncer([
    { at: 0, say: 'Pilot 1 used 12 tool calls.', opts: { kind: 'tool-call' } },
    { at: 10, say: 'Pilot 1 is at 4m 12s.', opts: { kind: 'progress' } },
    { at: 20, say: 'Pilot 1 completed.', opts: { kind: 'completed' } },
    { at: 30, say: 'Pilot 2 failed.', opts: { kind: 'failed' } },
    { at: 40, say: 'Round 2 started.' },
  ]);
  assert.deepEqual(run.results.slice(0, 2), [null, null], 'a progress kind is dropped');
  assert.equal(run.a.dropped(), 2);
  assert.deepEqual(run.emitted, [[4020, 'Pilot 1 completed. Pilot 2 failed. Round 2 started.', false]]);
});

test('announcer: link loss goes out at once on the assertive path, once per transition', () => {
  const run = driveAnnouncer([
    { at: 100, alert: 'The local companion stopped answering.', opts: { key: 'link' } },
    { at: 200, alert: 'The local companion stopped answering.', opts: { key: 'link' } },
    { at: 300, say: 'Pilot 1 completed.', opts: { kind: 'completed' } },
    { at: 20000, resolve: 'link' },
    { at: 20100, say: 'The local companion is back.', opts: { kind: 'link-restored' } },
    { at: 20200, alert: 'The local companion stopped answering.', opts: { key: 'link' } },
    { at: 20300, alert: 'Unkeyed alert.' },
    { at: 20400, alert: 'Unkeyed alert.' },
  ]);
  assert.deepEqual(run.results.filter(r => typeof r === 'boolean'), [true, false, true, true, true]);
  assert.deepEqual(run.emitted, [
    [100, 'The local companion stopped answering.', true],
    [8100, 'Pilot 1 completed.', false],
    [20200, 'The local companion stopped answering.', true],
    [20300, 'Unkeyed alert.', true],
    [20400, 'Unkeyed alert.', true],
    [28400, 'The local companion is back.', false],
  ].sort((a, b) => a[0] - b[0]));
  assert.equal(K.makeAnnouncer({ emit() {} }).alert('', { key: 'x' }), false);
});

test('announcer: a clock that jumps back does not wedge the queue; a throwing emit does not escape; flush and reset work', () => {
  const run = driveAnnouncer([{ at: 0, say: 'Pilot 1 completed.' }, { at: 4000, setClock: 1000 }, { at: 1000, say: 'Pilot 2 failed.', until: 40000 }]);
  assert.equal(run.emitted.length, 2);
  assert.deepEqual(run.emitted.map(e => e[0]), [4000, 9000], 'after the jump back the 8 s gap is measured from the new clock, not from a time in the future');

  const boom = K.makeAnnouncer({ now: () => 0, emit() { throw new Error('emit failed'); } });
  boom.say('x');
  assert.doesNotThrow(() => boom.flush());
  const out = [];
  const a = K.makeAnnouncer({ now: () => 5, emit: t => out.push(t) });
  a.say('A.'); a.say('B.');
  assert.equal(a.pending(), 2);
  assert.equal(a.flush(), true);
  assert.deepEqual(out, ['A. B.']);
  assert.equal(a.flush(), false);
  a.say('C.'); a.reset();
  assert.equal(a.pending(), 0);
  assert.equal(a.delay(), null);
  assert.equal(K.makeAnnouncer().say('no config'), 4000, 'defaults: real clock, 4 s window');
  const custom = K.makeAnnouncer({ now: () => 0, emit() {}, coalesceMs: 1000, minGapMs: 2000, maxChars: 30 });
  assert.equal(custom.say('x'), 1000);
});

/* ------------------------------------------------------------------ trimRing, time */

test('trimRing keeps the newest lines: whole steps of trimBy are dropped past max, never mutating, never emptying the ring', () => {
  const lines = n => Array.from({ length: n }, (_, i) => 'l' + i);
  const same = lines(600);
  assert.equal(K.trimRing(same, 600, 100), same, 'the same array comes back when nothing is dropped');
  const one = K.trimRing(lines(601), 600, 100);
  assert.equal(one.length, 501);
  assert.equal(one[0], 'l100');
  assert.equal(one[500], 'l600', 'the newest line is kept');
  assert.equal(K.trimRing(lines(750), 600, 100).length, 550);
  assert.equal(K.trimRing(lines(1000), 600, 100).length, 600);
  assert.equal(K.trimRing(lines(11), 10, 1).length, 10);
  assert.equal(K.trimRing(lines(11), 10, 500).length, 1, 'trimBy larger than max is cut to max');
  assert.equal(K.trimRing(lines(5), 3, 0).length, 3, 'a step below 1 is 1');
  assert.deepEqual(K.trimRing(null, 10, 1), []);
  assert.deepEqual(K.trimRing(lines(3), NaN, 1), ['l2'], 'a bad max is 1');
  assert.deepEqual(K.trimRing([], 10, 1), []);
  const input = lines(700), copy = input.slice();
  const out = K.trimRing(input, 600, 100);
  assert.deepEqual(input, copy);
  assert.notEqual(out, input);
  /* The count of dropped lines, for the "N earlier lines trimmed" row. */
  assert.deepEqual([[600, 600, 100], [601, 600, 100], [750, 600, 100], [1000, 600, 100], [11, 10, 500], [0, 5, 1], [4, 0, 1]].map(a => K.ringDrop(...a)), [0, 100, 200, 400, 10, 0, 3]);
  for (let len = 0; len < 1500; len += 37) for (const [max, by] of [[600, 100], [2000, 100], [10, 3], [1, 1], [7, 7]]) {
    const kept = K.trimRing(lines(len), max, by), dropped = K.ringDrop(len, max, by);
    assert.ok(kept.length <= max, `len ${len} max ${max} by ${by}`);
    assert.equal(kept.length, len - dropped);
    if (len > 0) assert.ok(kept.length >= 1, 'something is always left');
    assert.ok(dropped === 0 || dropped % by === 0);
    if (dropped) assert.equal(kept[kept.length - 1], 'l' + (len - 1));
  }
});

test('formatTime prints local hh:mm:ss, ago and duration use the Agents wording, bad input never throws', () => {
  const at = new Date(2026, 9, 12, 14, 5, 9, 500);
  assert.equal(K.formatTime(at), '14:05:09');
  assert.equal(K.formatTime(at.getTime()), '14:05:09');
  assert.equal(K.formatTime(at.toISOString()), '14:05:09');
  assert.equal(K.formatTime(new Date(2026, 0, 2, 3, 4, 5), { seconds: false }), '03:04');
  assert.equal(K.formatTime(new Date(2026, 0, 2, 0, 0, 0)), '00:00:00');
  for (const bad of [null, undefined, '', 'not a time', NaN, {}, new Date(NaN), Infinity]) {
    assert.equal(K.formatTime(bad), '--:--:--');
    assert.equal(K.formatTime(bad, { seconds: false }), '--:--');
  }

  const now = Date.parse('2026-10-12T12:00:00Z');
  const s = n => new Date(now - n * 1000).toISOString();
  const table = [[0, 'just now'], [4, 'just now'], [5, '5 s ago'], [59, '59 s ago'], [60, '1 min ago'], [125, '2 min ago'], [3599, '59 min ago'], [3600, '1 h ago'], [86399, '23 h ago'], [86400, '1 d ago'], [3 * 86400 + 5, '3 d ago']];
  for (const [seconds, text] of table) assert.equal(K.ago(s(seconds), now), text, seconds + ' s');
  assert.equal(K.ago(now + 60000, now), 'just now', 'a time in the future');
  assert.equal(K.ago('garbage', now), '');
  assert.equal(K.ago(now, 'garbage'), '');
  assert.equal(K.ago(new Date(now - 7000), new Date(now)), '7 s ago');
  assert.match(K.ago(Date.now() - 20000), /^2[01] s ago$/, 'the clock is the default for now');
  assert.equal(K.formatAgo, K.ago);

  assert.equal(K.duration(0), '0m 00s');
  assert.equal(K.duration(252000), '4m 12s');
  assert.equal(K.duration(59499), '0m 59s');
  assert.equal(K.duration(59500), '1m 00s');
  assert.equal(K.duration(3_723_000), '62m 03s');
  assert.equal(K.duration(-5000), '0m 00s');
  for (const bad of [NaN, '5', null, undefined, Infinity]) assert.equal(K.duration(bad), '-');
  assert.equal(K.formatDuration, K.duration);
  for (const out of [K.ago(s(30), now), K.duration(1000), K.formatTime(at)]) assert.ok(!out.includes('%'));
});

/* ------------------------------------------------------------------ keyboard plans */

test('nextListIndex: arrows, Home/End and pages of 8, clamped and never wrapping', () => {
  assert.equal(K.nextListIndex(20, 3, 'ArrowDown'), 4);
  assert.equal(K.nextListIndex(20, 3, 'ArrowUp'), 2);
  assert.equal(K.nextListIndex(20, 19, 'ArrowDown'), 19);
  assert.equal(K.nextListIndex(20, 0, 'ArrowUp'), 0);
  assert.equal(K.nextListIndex(20, 5, 'Home'), 0);
  assert.equal(K.nextListIndex(20, 5, 'End'), 19);
  assert.equal(K.nextListIndex(20, 5, 'PageDown'), 13);
  assert.equal(K.nextListIndex(20, 15, 'PageDown'), 19);
  assert.equal(K.nextListIndex(20, 9, 'PageUp'), 1);
  assert.equal(K.nextListIndex(20, 3, 'PageUp'), 0);
  assert.equal(K.nextListIndex(20, 0, 'PageDown', 5), 5);
  assert.equal(K.nextListIndex(20, -1, 'ArrowDown'), 0);
  assert.equal(K.nextListIndex(20, -1, 'PageDown'), 0);
  assert.equal(K.nextListIndex(20, -1, 'ArrowUp'), 19);
  assert.equal(K.nextListIndex(20, -1, 'PageUp'), 19);
  assert.equal(K.nextListIndex(20, 99, 'ArrowDown'), 0, 'an index out of range counts as none');
  assert.equal(K.nextListIndex(1, 0, 'End'), 0);
  assert.equal(K.nextListIndex(0, -1, 'ArrowDown'), null);
  for (const key of ['Enter', ' ', 'a', 'Tab', 'Escape', 'ArrowLeft', undefined]) assert.equal(K.nextListIndex(20, 3, key), null);
});

test('rovingTabindex puts tabindex 0 on the current item only', () => {
  assert.deepEqual(K.rovingTabindex(4, 2), [-1, -1, 0, -1]);
  assert.deepEqual(K.rovingTabindex(3, -1), [-1, -1, -1]);
  assert.deepEqual(K.rovingTabindex(0, 0), []);
  assert.deepEqual(K.rovingTabindex(2, 9), [-1, -1]);
});

test('nextTreeIndex: Up/Down/Home/End, Right expands then enters, Left collapses then leaves, by aria-level', () => {
  /* Facility_Terms.txt is a leaf under Atlas; Cash_Facts.csv sits in a closed folder. */
  const tree = [
    { level: 1, expanded: true },   // 0 Atlas
    { level: 2 },                   // 1 Facility_Terms.txt
    { level: 2, expanded: false },  // 2 Cash folder (closed)
    { level: 1, expanded: false },  // 3 Meridian (closed)
    { level: 1 },                   // 4 Borealis.txt
  ];
  const at = (i, k, items = tree) => K.nextTreeIndex(items, i, k);
  assert.deepEqual(at(0, 'ArrowDown'), { index: 1, action: 'move' });
  assert.deepEqual(at(4, 'ArrowDown'), { index: 4, action: 'none' });
  assert.deepEqual(at(1, 'ArrowUp'), { index: 0, action: 'move' });
  assert.deepEqual(at(0, 'ArrowUp'), { index: 0, action: 'none' });
  assert.deepEqual(at(2, 'Home'), { index: 0, action: 'move' });
  assert.deepEqual(at(2, 'End'), { index: 4, action: 'move' });
  assert.deepEqual(at(0, 'Home'), { index: 0, action: 'none' });
  assert.deepEqual(at(2, 'ArrowRight'), { index: 2, action: 'expand' }, 'closed parent opens');
  assert.deepEqual(at(0, 'ArrowRight'), { index: 1, action: 'move' }, 'open parent goes to its first child');
  assert.deepEqual(at(1, 'ArrowRight'), { index: 1, action: 'none' }, 'a leaf does nothing');
  assert.deepEqual(at(0, 'ArrowLeft'), { index: 0, action: 'collapse' }, 'open parent closes');
  assert.deepEqual(at(1, 'ArrowLeft'), { index: 0, action: 'move' }, 'a child goes to its parent');
  assert.deepEqual(at(2, 'ArrowLeft'), { index: 0, action: 'move' }, 'a closed child folder goes to its parent');
  assert.deepEqual(at(3, 'ArrowLeft'), { index: 3, action: 'none' }, 'a closed top-level folder has nowhere to go');
  assert.deepEqual(at(4, 'ArrowLeft'), { index: 4, action: 'none' });
  assert.deepEqual(at(-1, 'ArrowDown'), { index: 0, action: 'move' });
  assert.deepEqual(at(-1, 'ArrowUp'), { index: 4, action: 'move' });
  assert.deepEqual(at(-1, 'ArrowRight'), { index: -1, action: 'none' });
  assert.deepEqual(at(NaN, 'End'), { index: 4, action: 'move' });
  const noChildren = [{ level: 1, expanded: true }, { level: 1 }];
  assert.deepEqual(at(0, 'ArrowRight', noChildren), { index: 0, action: 'none' }, 'an open parent with no child row after it');
  const deep = [{ level: 1, expanded: true }, { level: 2, expanded: true }, { level: 3 }, { level: 2 }];
  assert.deepEqual(at(2, 'ArrowLeft', deep), { index: 1, action: 'move' });
  assert.deepEqual(at(3, 'ArrowLeft', deep), { index: 0, action: 'move' });
  const skipping = [{ level: 1 }, { level: 1, disabled: true }, { level: 1 }];
  assert.deepEqual(at(0, 'ArrowDown', skipping), { index: 2, action: 'move' });
  assert.deepEqual(at(2, 'ArrowUp', skipping), { index: 0, action: 'move' });
  for (const key of ['Enter', ' ', 'a', 'Tab', 'PageDown', undefined]) assert.equal(at(1, key), null);
  assert.equal(K.nextTreeIndex([], 0, 'ArrowDown'), null);
  assert.equal(K.nextTreeIndex(null, 0, 'ArrowDown'), null);
  assert.deepEqual(K.nextTreeIndex([null, undefined], 0, 'ArrowDown'), { index: 1, action: 'move' }, 'rows that are not objects are plain level-1 leaves');
});

test('nextSplitterStep: Up grows, Down shrinks, pages of 3, Home collapses, End is the largest, Enter toggles, within 0..5', () => {
  const up = [[0, 1], [1, 2], [4, 5], [5, 5]], down = [[5, 4], [1, 0], [0, 0]], pgUp = [[0, 3], [2, 5], [5, 5]], pgDown = [[5, 2], [2, 0], [0, 0]];
  for (const [from, to] of up) assert.equal(K.nextSplitterStep(from, 'ArrowUp'), to, 'Up from ' + from);
  for (const [from, to] of down) assert.equal(K.nextSplitterStep(from, 'ArrowDown'), to, 'Down from ' + from);
  for (const [from, to] of pgUp) assert.equal(K.nextSplitterStep(from, 'PageUp'), to, 'PageUp from ' + from);
  for (const [from, to] of pgDown) assert.equal(K.nextSplitterStep(from, 'PageDown'), to, 'PageDown from ' + from);
  for (let s = 0; s <= 5; s++) { assert.equal(K.nextSplitterStep(s, 'Home'), 0); assert.equal(K.nextSplitterStep(s, 'End'), 5); }
  assert.equal(K.nextSplitterStep(4, 'Enter'), 0, 'open to collapsed');
  assert.equal(K.nextSplitterStep(0, 'Enter'), 3, 'collapsed to the default');
  assert.equal(K.nextSplitterStep(0, 'Enter', { restore: 2 }), 2);
  assert.equal(K.nextSplitterStep(0, 'Enter', { restore: 99 }), 5);
  assert.equal(K.nextSplitterStep(0, 'Enter', { restore: 0 }), 1, 'a restore step is never the collapsed step');
  assert.equal(K.nextSplitterStep(0, ' '), 3);
  assert.equal(K.nextSplitterStep(3, 'ArrowUp', { invert: true }), 2);
  assert.equal(K.nextSplitterStep(3, 'ArrowDown', { invert: true }), 4);
  assert.equal(K.nextSplitterStep(1, 'End', { max: 8 }), 8);
  assert.equal(K.nextSplitterStep(9, 'ArrowDown'), 4, 'a step above the range is clamped first');
  assert.equal(K.nextSplitterStep(NaN, 'ArrowUp'), 1);
  assert.equal(K.nextSplitterStep(2, 'Escape'), null, 'Escape never collapses it');
  for (const key of ['Tab', 'ArrowLeft', 'ArrowRight', 'a', undefined]) assert.equal(K.nextSplitterStep(2, key), null);
  assert.equal(K.SPLITTER_MAX, 5);
  /* Every key sequence stays in range. */
  const rand = mulberry32(7), keys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', 'Enter'];
  for (let s = 3, n = 0; n < 500; n++) { s = K.nextSplitterStep(s, keys[Math.floor(rand() * keys.length)]); assert.ok(Number.isInteger(s) && s >= 0 && s <= 5); }
});

/* ------------------------------------------------------------------ store */

function memoryStorage() {
  const map = new Map();
  return { map, getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
}

test('store: JSON round trips, fallbacks for missing, corrupt and wrongly shaped values, and the four keys', () => {
  assert.deepEqual({ ...K.STORE_KEYS }, { evals: 'fts.evals.v1', links: 'fts.links.v1', mc: 'fts.mc.v1', wb: 'fts.wb.v1' });
  const backing = memoryStorage();
  const s = K.makeStore(() => backing);
  assert.deepEqual({ ...s.keys }, { ...K.STORE_KEYS });
  assert.equal(s.get('fts.mc.v1', 'none'), 'none');
  assert.equal(s.get('fts.mc.v1'), undefined);
  assert.equal(s.set('fts.mc.v1', { task: 'Atlas', state: 'running', n: [1, 2] }), true);
  assert.equal(backing.map.get('fts.mc.v1'), '{"task":"Atlas","state":"running","n":[1,2]}');
  assert.deepEqual(s.get('fts.mc.v1', null), { task: 'Atlas', state: 'running', n: [1, 2] });
  const a = s.get('fts.mc.v1'), b = s.get('fts.mc.v1');
  a.task = 'changed';
  assert.equal(b.task, 'Atlas', 'every read is a fresh copy');
  backing.map.set('fts.wb.v1', '{not json');
  assert.equal(s.get('fts.wb.v1', 'fallback'), 'fallback');
  backing.map.set('fts.links.v1', '"a string"');
  assert.deepEqual(s.get('fts.links.v1', [], Array.isArray), [], 'a value the check refuses is replaced by the fallback');
  assert.equal(s.get('fts.links.v1', [], () => { throw new Error('check blew up'); }).length, 0);
  assert.equal(s.get('fts.links.v1', [], v => typeof v === 'string'), 'a string');
  assert.equal(s.remove('fts.mc.v1'), true);
  assert.equal(s.get('fts.mc.v1', 'gone'), 'gone');
  assert.equal(s.set('fts.evals.v1', undefined), false, 'undefined is not storable: it removes the key');
  assert.equal(s.set('k', 0), true);
  assert.equal(s.get('k', 'x'), 0);
  assert.equal(s.set('k', null), true);
  assert.equal(s.get('k', 'x'), null);
  assert.equal(s.available(), true);
});

test('store never throws: storage that throws on every call, a getter that throws, quota errors, circular values', () => {
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const s = K.makeStore(() => broken);
  assert.equal(s.get('fts.mc.v1', 'fb'), 'fb');
  assert.equal(s.set('fts.mc.v1', { a: 1 }), false, 'false means it did not reach storage');
  assert.deepEqual(s.get('fts.mc.v1', 'fb'), { a: 1 }, 'but this page still sees it');
  assert.equal(s.set('fts.mc.v1', { a: 2 }), false);
  assert.deepEqual(s.get('fts.mc.v1'), { a: 2 }, 'the latest write wins');
  assert.equal(s.remove('fts.mc.v1'), false);
  assert.equal(s.get('fts.mc.v1', 'fb'), 'fb', 'a removal that storage refused still hides the value');
  assert.equal(s.available(), false);

  const noGetter = K.makeStore(() => { throw new Error('SecurityError: storage is denied'); });
  assert.equal(noGetter.get('x', 7), 7);
  assert.equal(noGetter.set('x', [1]), false);
  assert.deepEqual(noGetter.get('x'), [1]);
  assert.equal(noGetter.available(), false);
  for (const nothing of [null, undefined, {}, { getItem() {} }, 'storage']) {
    const none = K.makeStore(() => nothing);
    assert.equal(none.set('a', 1), false);
    assert.equal(none.get('a'), 1);
    assert.equal(none.get('missing', 'm'), 'm');
  }

  /* Quota: reads still work and the new value is kept in memory; the old stored value is not served over it. */
  const backing = memoryStorage();
  backing.setItem('fts.wb.v1', '{"step":2}');
  let full = false;
  const quota = { getItem: k => backing.getItem(k), removeItem: k => backing.removeItem(k), setItem: (k, v) => { if (full) throw new Error('QuotaExceededError'); backing.setItem(k, v); } };
  const q = K.makeStore(() => quota);
  assert.deepEqual(q.get('fts.wb.v1'), { step: 2 });
  full = true;
  assert.equal(q.set('fts.wb.v1', { step: 4 }), false);
  assert.deepEqual(q.get('fts.wb.v1'), { step: 4 });
  full = false;
  assert.equal(q.set('fts.wb.v1', { step: 5 }), true, 'storage works again');
  assert.deepEqual(q.get('fts.wb.v1'), { step: 5 });
  assert.equal(backing.getItem('fts.wb.v1'), '{"step":5}');

  const circular = {}; circular.self = circular;
  assert.equal(s.set('c', circular), false);
  assert.equal(s.set('big', 10n), false, 'a BigInt cannot be stored');
  const getterThrows = { get v() { throw new Error('x'); } };
  assert.equal(s.set('g', getterThrows), false);
  const readThrows = K.makeStore(() => ({ getItem() { throw new Error('read blocked'); }, setItem() {}, removeItem() {} }));
  assert.equal(readThrows.get('a', 'fb'), 'fb');
});

test('the default store reads window.localStorage when it is called, and survives it being absent, blocked or replaced', () => {
  const context = loadKit({});
  const V = context.FinanceViews;
  assert.equal(V.store.get('fts.mc.v1', 'fresh'), 'fresh');
  assert.equal(V.store.set('fts.mc.v1', { ok: true }), false, 'no localStorage: kept in memory');
  assert.deepEqual(JSON.parse(JSON.stringify(V.store.get('fts.mc.v1'))), { ok: true });
  context.localStorage = memoryStorage();
  assert.equal(V.store.set('fts.wb.v1', { step: 1 }), true, 'storage that appears later is used');
  assert.equal(context.localStorage.map.get('fts.wb.v1'), '{"step":1}');
  context.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.deepEqual(JSON.parse(JSON.stringify(V.store.get('fts.mc.v1'))), { ok: true }, 'still served from memory');
  assert.equal(V.store.get('fts.wb.v1', 'fb'), 'fb', 'a blocked store reads as empty');
  assert.equal(V.store.available(), false);
});

/* ------------------------------------------------------------------ setHtml */

test('setHtml: writes once, skips identical markup, accepts html results and strings, force writes again', () => {
  const dom = makeDom();
  const el = dom.make('div');
  assert.equal(K.setHtml(el, '<p>one</p>'), true);
  assert.equal(el.innerHTML, '<p>one</p>');
  assert.equal(K.setHtml(el, '<p>one</p>'), false);
  assert.equal(K.setHtml(el, K.html`<p>${'one'}</p>`), false, 'an html result compares by its text');
  assert.equal(dom.stats.innerHTMLWrites, 1);
  assert.equal(K.setHtml(el, '<p>one</p>', { force: true }), true);
  assert.equal(K.setHtml(el, '<p>one</p>', true), true, 'the agents.js style boolean works too');
  assert.equal(dom.stats.innerHTMLWrites, 3);
  assert.equal(K.setHtml(el, null), true);
  assert.equal(el.innerHTML, '');
  assert.equal(K.setHtml(el, undefined), false);
  assert.equal(K.setHtml(null, 'x'), false);
  /* Children changed another way: invalidate makes the next write happen. */
  K.setHtml(el, '<p>two</p>');
  el.childNodes.slice().forEach(c => c._unlink());
  assert.equal(K.setHtml(el, '<p>two</p>'), false);
  K.invalidate(el);
  assert.equal(K.setHtml(el, '<p>two</p>'), true);
  assert.equal(el.children.length, 1);
  K.invalidate(null);
});

test('setHtml keeps scrollTop and scrollLeft of data-keep-scroll descendants, by name, key, id or position, and of the element itself', () => {
  const dom = makeDom();
  const el = dom.make('div');
  const page = extra => K.html`<section><div data-keep-scroll="log" class="a">${extra}</div><div data-keep-scroll data-key="inspector"></div><div data-keep-scroll id="side"></div><div data-keep-scroll></div><div class="nope"></div></section>`;
  K.setHtml(el, page('one'));
  const [log, inspector, side, plain] = el.querySelectorAll('[data-keep-scroll]');
  log.scrollTop = 321; log.scrollLeft = 7;
  inspector.scrollTop = 40;
  side.scrollTop = 55;
  plain.scrollTop = 9;
  el.querySelector('.nope').scrollTop = 99;
  K.setHtml(el, page('two'));
  const [log2, inspector2, side2, plain2] = el.querySelectorAll('[data-keep-scroll]');
  assert.notEqual(log2, log, 'the node itself is new');
  assert.deepEqual([log2.scrollTop, log2.scrollLeft, inspector2.scrollTop, side2.scrollTop, plain2.scrollTop], [321, 7, 40, 55, 9]);
  assert.equal(el.querySelector('.nope').scrollTop, 0, 'only marked scrollers are restored');
  /* A scroller that had not been scrolled is left alone (a view may set it itself). */
  K.setHtml(el, page('three'));
  assert.equal(el.querySelectorAll('[data-keep-scroll]')[0].scrollTop, 321);
  K.setHtml(el, K.html`<div data-keep-scroll="other"></div>`);
  assert.equal(el.querySelector('[data-keep-scroll]').scrollTop, 0, 'a scroller with another name gets nothing');
  const self = dom.make('div');
  self.setAttribute('data-keep-scroll', 'self');
  K.setHtml(self, '<p>a</p>');
  self.scrollTop = 77;
  K.setHtml(self, '<p>b</p>');
  assert.equal(self.scrollTop, 77);
});

test('setHtml keeps <details> open that were open, by key, id or position, and opens nothing else', () => {
  const dom = makeDom();
  const el = dom.make('div');
  const page = n => K.html`<details data-key="a"><summary>A ${n}</summary></details><details id="b"><summary>B</summary></details><details><summary>C</summary></details><details open data-key="d"><summary>D</summary></details>`;
  K.setHtml(el, page(1));
  const [a, b, c, d] = el.querySelectorAll('details');
  assert.equal(d.open, true, 'markup that says open is open');
  a.open = true;
  c.open = true;
  d.open = false; // the reader closed D
  K.setHtml(el, page(2));
  const [a2, b2, c2, d2] = el.querySelectorAll('details');
  assert.notEqual(a2, a);
  assert.deepEqual([a2.open, b2.open, c2.open], [true, false, true]);
  assert.equal(d2.open, true, 'markup that says open stays open: only open is preserved, nothing is forced shut');
  el.querySelectorAll('details')[1].open = true;
  K.setHtml(el, page(3));
  assert.equal(el.querySelectorAll('details')[1].open, true);
  assert.equal(b.open, false, 'the node from before the repaint is not the live one');
});

test('setHtml puts focus back by data-key (or id) without scrolling, and keeps the caret', () => {
  const dom = makeDom();
  const el = dom.make('div');
  const form = text => K.html`<label>Task <input data-key="task" value="${text}"></label><button data-key="go">Go</button><input id="plain" value="x"><button>no key</button>`;
  K.setHtml(el, form('Atlas'));
  const input = el.querySelector('[data-key="task"]');
  input.focus();
  input.setSelectionRange(2, 4);
  dom.resetStats();
  K.setHtml(el, form('Atlas round'));
  const next = el.querySelector('[data-key="task"]');
  assert.notEqual(next, input);
  assert.equal(dom.doc.activeElement, next);
  assert.deepEqual(dom.stats.lastFocus, { preventScroll: true });
  assert.equal(dom.stats.focusCalls, 1);
  assert.deepEqual([next.selectionStart, next.selectionEnd], [2, 4]);

  el.querySelector('[data-key="go"]').focus();
  K.setHtml(el, form('Atlas again'));
  assert.equal(dom.doc.activeElement.getAttribute('data-key'), 'go');

  el.querySelector('#plain').focus();
  K.setHtml(el, form('Atlas third'));
  assert.equal(dom.doc.activeElement.id, 'plain', 'an element with an id is found again when it has no data-key');

  /* The control vanished: nothing to focus, no error. */
  el.querySelector('[data-key="go"]').focus();
  assert.doesNotThrow(() => K.setHtml(el, K.html`<p>empty</p>`));
  assert.equal(dom.doc.activeElement, dom.doc.body);

  /* A disabled replacement is not focused. */
  K.setHtml(el, K.html`<button data-key="b">B</button>`);
  el.querySelector('[data-key="b"]').focus();
  dom.resetStats();
  K.setHtml(el, K.html`<button data-key="b" disabled>B</button>`);
  assert.equal(dom.stats.focusCalls, 0);

  /* Focus outside the element, or on a node with neither key nor id, is not touched. */
  const outside = dom.make('button');
  outside.focus();
  dom.resetStats();
  K.setHtml(el, K.html`<button data-key="b">changed</button>`);
  assert.equal(dom.doc.activeElement, outside);
  assert.equal(dom.stats.focusCalls, 0);
  K.setHtml(el, K.html`<button>anonymous</button>`);
  el.querySelector('button').focus();
  assert.doesNotThrow(() => K.setHtml(el, K.html`<button>anonymous 2</button>`));

  /* A key with quotes and backslashes is escaped in the lookup. */
  const odd = 'a"b\\c';
  K.setHtml(el, K.html`<button data-key="${odd}">x</button>`);
  el.querySelector('button').focus();
  K.setHtml(el, K.html`<button data-key="${odd}">y</button>`);
  assert.equal(dom.doc.activeElement.textContent, 'y');
});

test('setHtml restores focus even when the field refuses to report a caret (number inputs in some browsers)', () => {
  const dom = makeDom();
  const el = dom.make('div', '<input data-key="n" value="1">');
  const input = el.querySelector('input');
  Object.defineProperty(input, 'selectionStart', { get() { throw new Error('InvalidStateError'); } });
  input.focus();
  K.setHtml(el, '<input data-key="n" value="2">');
  assert.equal(dom.doc.activeElement, el.querySelector('input'), 'focus is back on the new field');
});

test('setHtml still writes when keeping state fails, and never moves focus when the element is itself the focused one', () => {
  const dom = makeDom();
  const el = dom.make('div', '<p>a</p>');
  el.querySelectorAll = () => { throw new Error('selector engine exploded'); };
  assert.equal(K.setHtml(el, '<p>b</p>'), true);
  assert.equal(el.innerHTML, '<p>b</p>');
  const host = dom.make('div');
  host.setAttribute('data-key', 'host');
  host.setAttribute('tabindex', '0');
  host.focus();
  dom.resetStats();
  K.setHtml(host, '<span data-key="host">inner</span>');
  assert.equal(dom.stats.focusCalls, 0);
});

/* ------------------------------------------------------------------ keyedPatch */

function rowPatcher(container, extra = {}) {
  return items => K.keyedPatch(container, items, {
    key: i => i.key,
    render: i => K.html`<span class="t">${i.text === undefined ? i.key : i.text}</span>`,
    attrs: i => ({ role: 'option', id: 'opt-' + i.key, 'aria-selected': i.selected ? 'true' : 'false' }),
    tag: 'li',
    ...extra,
  });
}
const rowsOf = (...keys) => keys.map(k => ({ key: k }));

test('keyedPatch: first paint builds one node per key in order, with data-key, attributes and markup; the container is never written with innerHTML', () => {
  const dom = makeDom();
  const el = dom.make('ul');
  Object.defineProperty(el, 'innerHTML', { get() { return ''; }, set() { throw new Error('innerHTML on the scroller'); } });
  const result = rowPatcher(el)([{ key: 'r1:1', text: 'Pilot 1 <b>' }, { key: 'r1:2', selected: true }]);
  assert.deepEqual(keysOf(el), ['r1:1', 'r1:2']);
  assert.equal(el.children[0].tagName, 'LI');
  assert.equal(el.children[0].getAttribute('role'), 'option');
  assert.equal(el.children[0].id, 'opt-r1:1');
  assert.equal(el.children[1].getAttribute('aria-selected'), 'true');
  assert.equal(el.children[0].innerHTML, '<span class="t">Pilot 1 &lt;b&gt;</span>', 'the row text is escaped markup');
  assert.deepEqual(result.inserted, ['r1:1', 'r1:2']);
  assert.deepEqual([result.removed, result.moved, result.updated, result.errors], [[], [], [], []]);
  assert.deepEqual(result.keys, ['r1:1', 'r1:2']);
  assert.equal(dom.stats.insertBefore, 1, 'two new neighbours arrive in one flush');
});

test('keyedPatch keeps node identity for unchanged keys and rewrites only the row that changed', () => {
  const dom = makeDom();
  const el = dom.make('ul');
  const patch = rowPatcher(el);
  patch([{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
  const [a, b, c] = el.children;
  dom.resetStats();
  const result = patch([{ key: 'a' }, { key: 'b', text: 'Pilot 2 completed' }, { key: 'c' }]);
  assert.deepEqual(el.children, [a, b, c], 'the same three nodes, in place');
  assert.deepEqual(result.updated, ['b']);
  assert.equal(b.textContent, 'Pilot 2 completed');
  assert.equal(dom.stats.innerHTMLWrites, 1, 'one row was rewritten');
  assert.equal(dom.stats.insertBefore + dom.stats.removeChild + dom.stats.remove, 0, 'nothing was inserted, removed or moved');
  dom.resetStats();
  const quiet = patch([{ key: 'a' }, { key: 'b', text: 'Pilot 2 completed' }, { key: 'c' }]);
  assert.deepEqual([quiet.inserted, quiet.removed, quiet.moved, quiet.updated], [[], [], [], []]);
  assert.deepEqual(Object.values(dom.stats).filter(v => typeof v === 'number'), Array(7).fill(0), 'a repeat patch does no DOM work at all');
});

test('keyedPatch: arrivals at the top are inserted in one fragment flush and the old rows stay put', () => {
  const dom = makeDom();
  const el = dom.make('ul');
  const patch = rowPatcher(el);
  patch(rowsOf('r1:1', 'r1:2', 'r1:3'));
  const old = el.children.slice();
  dom.resetStats();
  const result = patch(rowsOf('n:1', 'n:2', 'n:3', 'r1:1', 'r1:2', 'r1:3'));
  assert.deepEqual(keysOf(el), ['n:1', 'n:2', 'n:3', 'r1:1', 'r1:2', 'r1:3']);
  assert.deepEqual(el.children.slice(3), old, 'the old nodes are the same nodes');
  assert.equal(dom.stats.insertBefore, 1, 'one insertBefore for three arrivals');
  assert.equal(dom.stats.fragAppend, 3);
  assert.deepEqual(result.inserted, ['n:1', 'n:2', 'n:3']);
  dom.resetStats();
  const single = patch(rowsOf('n:0', 'n:1', 'n:2', 'n:3', 'r1:1', 'r1:2', 'r1:3'));
  assert.equal(dom.stats.insertBefore, 1);
  assert.equal(dom.stats.fragAppend, 0, 'a lone arrival needs no fragment');
  assert.deepEqual(single.inserted, ['n:0']);
  /* Arrivals at both ends and in the middle: one flush per run. */
  dom.resetStats();
  patch(rowsOf('t1', 't2', 'n:0', 'n:1', 'm1', 'm2', 'n:2', 'n:3', 'r1:1', 'r1:2', 'r1:3', 'e1', 'e2'));
  assert.deepEqual(keysOf(el), ['t1', 't2', 'n:0', 'n:1', 'm1', 'm2', 'n:2', 'n:3', 'r1:1', 'r1:2', 'r1:3', 'e1', 'e2']);
  assert.equal(dom.stats.insertBefore, 3);
});

test('keyedPatch: vanished keys are removed, a reorder moves only what it must, and the rest keep their nodes', () => {
  const dom = makeDom();
  const el = dom.make('ul');
  const patch = rowPatcher(el);
  patch(rowsOf('a', 'b', 'c', 'd', 'e'));
  const node = Object.fromEntries(el.children.map(c => [c.getAttribute('data-key'), c]));
  dom.resetStats();
  const gone = patch(rowsOf('a', 'c', 'e'));
  assert.deepEqual(gone.removed, ['b', 'd']);
  assert.deepEqual(keysOf(el), ['a', 'c', 'e']);
  assert.equal(node.b.parentNode, null);
  assert.equal(node.c.parentNode, el);
  assert.equal(dom.stats.remove + dom.stats.removeChild, 2);
  patch(rowsOf('a', 'b', 'c', 'd', 'e'));
  dom.resetStats();
  const rotated = patch(rowsOf('b', 'c', 'd', 'e', 'a'));
  assert.deepEqual(rotated.moved, ['a'], 'one move for a rotation');
  assert.equal(dom.stats.insertBefore, 1);
  assert.deepEqual(keysOf(el), ['b', 'c', 'd', 'e', 'a']);
  assert.equal(el.children[4].getAttribute('data-key'), 'a');
  const everything = patch([]);
  assert.deepEqual(everything.removed.length, 5);
  assert.equal(el.children.length, 0);
  patch(rowsOf('x', 'y'));
  assert.deepEqual(keysOf(el), ['x', 'y']);
});

test('keyedPatch: random reorders, filters and arrivals always end in the requested order', () => {
  const rand = mulberry32(99);
  const dom = makeDom();
  const el = dom.make('ul');
  const patch = rowPatcher(el);
  const pool = Array.from({ length: 30 }, (_, i) => 'k' + i);
  for (let n = 0; n < 150; n++) {
    const next = shuffled(rand, pool).slice(0, Math.floor(rand() * 20));
    const before = new Map(el.children.map(c => [c.getAttribute('data-key'), c]));
    patch(next.map(key => ({ key })));
    assert.deepEqual(keysOf(el), next);
    for (const c of el.children) if (before.has(c.getAttribute('data-key'))) assert.equal(c, before.get(c.getAttribute('data-key')), 'a key that stayed in the list keeps its node');
  }
});

test('keyedPatch: duplicate or missing keys throw before the DOM is touched', () => {
  const dom = makeDom();
  const el = dom.make('ul');
  const patch = rowPatcher(el);
  patch(rowsOf('a', 'b'));
  const before = el.children.slice();
  dom.resetStats();
  assert.throws(() => patch(rowsOf('a', 'x', 'x')), /duplicate key "x" in nextKeys/);
  assert.throws(() => patch([{ key: 'a' }, {}]), /item 1 has no key/);
  assert.throws(() => patch([{ key: '' }]), /item 0 has no key/);
  assert.throws(() => K.keyedPatch(el, 'nope', {}), /items must be an array/);
  assert.deepEqual(el.children, before);
  assert.deepEqual(Object.values(dom.stats).filter(v => typeof v === 'number'), Array(7).fill(0), 'no DOM call was made');
  /* Duplicate keys already in the DOM (someone else's doing) are cleaned out. */
  el.appendChild(Object.assign(dom.doc.createElement('li'), {})).setAttribute('data-key', 'a');
  assert.equal(el.children.length, 3);
  patch(rowsOf('a', 'b'));
  assert.deepEqual(keysOf(el), ['a', 'b']);
});

test('keyedPatch: a row whose render throws shows a fallback and is reported; its neighbours are fine', () => {
  const dom = makeDom();
  const el = dom.make('ul');
  const result = K.keyedPatch(el, [{ key: 'a' }, { key: 'bad' }, { key: 'c' }], {
    key: i => i.key,
    render: i => { if (i.key === 'bad') throw new Error('cannot render this one'); return K.html`<b>${i.key}</b>`; },
    attrs: i => { if (i.key === 'c') throw new Error('attrs failed'); return { 'data-x': i.key }; },
  });
  assert.deepEqual(keysOf(el), ['a', 'bad', 'c']);
  assert.match(el.children[1].textContent, /could not be displayed/);
  assert.equal(el.children[0].textContent, 'a');
  assert.equal(el.children[0].getAttribute('data-x'), 'a');
  assert.deepEqual(result.errors.map(e => [e.key, e.error.message]), [['bad', 'cannot render this one'], ['c', 'attrs failed']]);
});

test('keyedPatch: attributes follow attrs(), null removes one, data-key / style / on* are refused', () => {
  const dom = makeDom();
  const el = dom.make('div');
  let on = true;
  const patch = () => K.keyedPatch(el, [{ key: 'a' }], {
    key: i => i.key,
    render: () => 'x',
    attrs: () => (on ? { role: 'option', 'aria-selected': true, 'data-n': 3, hidden: '', gone: null, 'data-key': 'evil', style: 'color:red', onclick: 'x()', ONFOCUS: 'y()' } : { role: 'option' }),
  });
  patch();
  const row = el.children[0];
  assert.deepEqual([row.getAttribute('role'), row.getAttribute('aria-selected'), row.getAttribute('data-n'), row.getAttribute('hidden')], ['option', 'true', '3', '']);
  assert.equal(row.getAttribute('data-key'), 'a');
  for (const refused of ['style', 'onclick', 'ONFOCUS', 'onfocus', 'gone']) assert.equal(row.getAttribute(refused), null, refused);
  on = false;
  const r = patch();
  assert.equal(el.children[0], row);
  assert.deepEqual([row.getAttribute('aria-selected'), row.getAttribute('data-n'), row.getAttribute('hidden')], [null, null, null], 'attributes attrs() stopped naming are removed');
  assert.equal(row.getAttribute('role'), 'option');
  assert.deepEqual(r.updated, ['a']);
  /* An attribute changed behind the kit's back is put right on the next patch. */
  row.setAttribute('role', 'tampered');
  patch();
  assert.equal(row.getAttribute('role'), 'option');
});

test('keyedPatch: attribute names that merely start with "on" are not mistaken for event handlers', () => {
  const dom = makeDom();
  const el = dom.make('div');
  K.keyedPatch(el, [{ key: 'a' }], { key: i => i.key, render: () => 'x', attrs: () => ({ 'on-this-day': 'yes', onion: 'no', 'ONCLICK': 'x()', onmouseover: 'x()' }) });
  const row = el.children[0];
  assert.equal(row.getAttribute('on-this-day'), 'yes');
  assert.equal(row.getAttribute('onclick'), null);
  assert.equal(row.getAttribute('ONCLICK'), null);
  assert.equal(row.getAttribute('onmouseover'), null);
});

test('keyedPatch leaves children without data-key alone: a header before the rows, a footer after them', () => {
  const dom = makeDom();
  const el = dom.make('div', '<p class="head">N earlier lines trimmed</p>');
  const patch = rowPatcher(el, { tag: 'div' });
  patch(rowsOf('a', 'b'));
  assert.deepEqual(el.children.map(c => c.getAttribute('class') || c.getAttribute('data-key')), ['head', 'a', 'b']);
  const foot = dom.doc.createElement('p');
  foot.setAttribute('class', 'foot');
  el.appendChild(foot);
  patch(rowsOf('a', 'b', 'c'));
  assert.deepEqual(el.children.map(c => c.getAttribute('class') || c.getAttribute('data-key')), ['head', 'a', 'b', 'c', 'foot'], 'the new row goes before the footer');
  patch(rowsOf('z', 'a', 'b', 'c'));
  assert.deepEqual(el.children.map(c => c.getAttribute('class') || c.getAttribute('data-key')), ['head', 'z', 'a', 'b', 'c', 'foot']);
  patch([]);
  assert.deepEqual(el.children.map(c => c.getAttribute('class')), ['head', 'foot']);
  patch(rowsOf('q'));
  assert.equal(el.children.length, 3);
  const withTail = dom.make('div', '<p class="foot">f</p>');
  K.keyedPatch(withTail, rowsOf('a'), { key: i => i.key, render: () => 'x', tail: withTail.children[0] });
  assert.deepEqual(withTail.children.map(c => c.getAttribute('class') || c.getAttribute('data-key')), ['a', 'foot'], 'the tail option marks where rows go when there are none yet');
});

test('keyedPatch: keyboard focus inside a row survives a content rewrite and a move; focus on a removed row is simply gone', () => {
  const dom = makeDom();
  const el = dom.make('div');
  const patch = items => K.keyedPatch(el, items, { key: i => i.key, render: i => K.html`<button data-key="copy-${i.key}">Copy ${i.n || 0}</button>` });
  patch([{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
  el.children[1].querySelector('button').focus();
  patch([{ key: 'a' }, { key: 'b', n: 1 }, { key: 'c' }]);
  assert.equal(dom.doc.activeElement.getAttribute('data-key'), 'copy-b', 'a rewritten row gets its focus back');
  assert.equal(dom.doc.activeElement.textContent, 'Copy 1');
  patch([{ key: 'b', n: 1 }, { key: 'c' }, { key: 'a' }]);
  assert.equal(dom.doc.activeElement.getAttribute('data-key'), 'copy-b');
  dom.resetStats();
  patch([{ key: 'c' }, { key: 'a' }, { key: 'b', n: 1 }]);
  assert.equal(dom.doc.activeElement.getAttribute('data-key'), 'copy-b', 'a moved row keeps keyboard focus');
  assert.deepEqual(dom.stats.lastFocus, { preventScroll: true });
  patch([{ key: 'c' }, { key: 'a' }]);
  assert.equal(dom.doc.activeElement, dom.doc.body, 'the row that held focus is gone');
});

test('keyedPatch: scrolled away from the top, the first visible row keeps its place when rows arrive above it; pinned at the top it follows', () => {
  const dom = makeDom();
  const el = dom.make('ul');
  el.setAttribute('data-scroller', 'true');
  const ROW = 20;
  dom.layout = node => {
    const p = node.parentNode;
    if (p && p.getAttribute && p.getAttribute('data-scroller')) {
      const top = p.children.indexOf(node) * ROW - p.scrollTop;
      return { top, bottom: top + ROW, left: 0, right: 100, height: ROW, width: 100 };
    }
    return { top: 0, bottom: 200, left: 0, right: 100, height: 200, width: 100 };
  };
  const patch = (items, extra) => K.keyedPatch(el, items, { key: i => i.key, render: i => i.key, tag: 'li', ...extra });
  const rows = n => Array.from({ length: n }, (_, i) => ({ key: 'r' + i }));
  patch(rows(30));
  el.scrollTop = 100; // row 5 is the first row in view
  const firstVisible = () => el.children.find((c, i) => i * ROW - el.scrollTop + ROW > 0).getAttribute('data-key');
  assert.equal(firstVisible(), 'r5');
  const arrivals = [{ key: 'n0' }, { key: 'n1' }, { key: 'n2' }];
  const result = patch([...arrivals, ...rows(30)]);
  assert.equal(result.scrolledAway, true);
  assert.equal(el.scrollTop, 160, 'three rows of 20 above: the scroll position moved down by 60');
  assert.equal(firstVisible(), 'r5', 'the same row is at the top of the view');
  /* Rows trimmed from above are compensated the same way. */
  patch([...arrivals, ...rows(30)].slice(3));
  assert.equal(el.scrollTop, 100);
  assert.equal(firstVisible(), 'r5');
  /* Rows appended below change nothing. */
  patch([...rows(30), { key: 'tail1' }, { key: 'tail2' }]);
  assert.equal(el.scrollTop, 100);
  /* Opt out. */
  patch([...arrivals, ...rows(30)], { keepScroll: false });
  assert.equal(el.scrollTop, 100);
  /* Pinned at the top: no correction, the new rows are what you see. */
  el.scrollTop = 0;
  const pinned = patch([{ key: 'p0' }, { key: 'p1' }, ...arrivals, ...rows(30)]);
  assert.equal(pinned.scrolledAway, false);
  assert.equal(el.scrollTop, 0);
  /* A removed anchor falls to the next surviving row; a layout that throws leaves the position alone. */
  el.scrollTop = 100;
  patch(rows(30).filter((_, i) => i !== 5 && i !== 0 && i !== 1));
  assert.ok(el.scrollTop <= 100);
  dom.layout = () => { throw new Error('no layout'); };
  el.scrollTop = 80;
  assert.doesNotThrow(() => patch(rows(10)));
  assert.equal(el.scrollTop, 80);
  assert.equal(patch(rows(10), { pinThreshold: 1000 }).scrolledAway, false, 'the pin threshold is adjustable');
});

test('keyedPatch without a DOM does nothing and says so', () => {
  assert.equal(K.keyedPatch(null, [], {}), null);
  assert.equal(K.keyedPatch({}, [{ key: 'a' }], {}), null);
  assert.equal(K.keyedPatch({ ownerDocument: { createElement() {} } }, [], {}), null, 'a container that cannot insert children');
});

/* ------------------------------------------------------------------ bindListbox */

function listboxFixture(count = 20, optionsExtra = {}) {
  const dom = makeDom();
  const el = dom.make('ul');
  const items = Array.from({ length: count }, (_, i) => ({ key: 'r' + (i + 1) }));
  const patch = list => K.keyedPatch(el, list, {
    key: i => i.key, tag: 'li',
    render: i => K.html`<span>${i.key}</span> <button data-key="copy-${i.key}">Copy</button>`,
    attrs: i => ({ role: 'option', id: 'opt-' + i.key, 'aria-selected': i.selected ? 'true' : 'false' }),
  });
  patch(items);
  const calls = [];
  const lb = K.bindListbox(el, { label: 'Run feed', onActivate: (key, opt, ev) => calls.push([key, ev && ev.type, opt && opt.getAttribute('data-key')]), onActive: (key, opt, d) => calls.push(['active', key, d.reason]), ...optionsExtra });
  calls.length = 0;
  dom.resetStats();
  return { dom, el, items, patch, lb, calls };
}
const press = (el, key, props = {}) => el.fire('keydown', { key, ...props });
const cursor = el => (el.getAttribute('aria-activedescendant') || '').replace('opt-', '');

test('bindListbox: role, label, tabindex, focus picks the first option (or the selected one), and the cursor is virtual', () => {
  const { dom, el, lb } = listboxFixture();
  assert.equal(el.getAttribute('role'), 'listbox');
  assert.equal(el.getAttribute('aria-label'), 'Run feed');
  assert.equal(el.getAttribute('tabindex'), '0');
  assert.equal(el.getAttribute('aria-activedescendant'), null, 'no cursor until the reader asks for one');
  assert.equal(lb.active, null);
  el.fire('focus');
  assert.equal(lb.active, 'r1');
  assert.equal(cursor(el), 'r1');
  assert.equal(el.children[0].getAttribute('data-active'), 'true');
  assert.equal(el.children.filter(c => c.hasAttribute('data-active')).length, 1);
  assert.equal(dom.stats.focusCalls, 0, 'DOM focus is never moved by the kit');

  const keepTab = dom.make('ul');
  keepTab.setAttribute('tabindex', '-1');
  K.bindListbox(keepTab, {});
  assert.equal(keepTab.getAttribute('tabindex'), '-1', 'an existing tabindex is respected');

  /* Focus goes to the option marked selected. */
  const second = listboxFixture();
  second.patch(second.items.map(i => ({ ...i, selected: i.key === 'r4' })));
  second.el.fire('focus');
  assert.equal(second.lb.active, 'r4');
  const empty = listboxFixture(0);
  empty.el.fire('focus');
  assert.equal(empty.lb.active, null);
  assert.equal(empty.el.getAttribute('aria-activedescendant'), null);
  assert.equal(K.bindListbox(null, {}), null);
});

test('bindListbox key handling: arrows, Home/End, pages of 8, Enter and Space activate, modifiers and inner controls are left alone', () => {
  const { dom, el, lb, calls } = listboxFixture();
  el.fire('focus');
  const seq = [['ArrowDown', 'r2'], ['ArrowDown', 'r3'], ['ArrowDown', 'r4'], ['ArrowUp', 'r3'], ['End', 'r20'], ['ArrowDown', 'r20'], ['Home', 'r1'], ['ArrowUp', 'r1'], ['PageDown', 'r9'], ['PageDown', 'r17'], ['PageDown', 'r20'], ['PageUp', 'r12'], ['PageUp', 'r4'], ['PageUp', 'r1']];
  for (const [key, want] of seq) {
    const ev = press(el, key);
    assert.equal(lb.active, want, key);
    assert.equal(cursor(el), want, key + ' updates aria-activedescendant');
    assert.equal(ev.defaultPrevented, true, key + ' is a handled key: the page must not scroll');
    assert.equal(el.children.filter(c => c.hasAttribute('data-active')).length, 1);
    assert.equal(el.querySelector('[data-active="true"]').getAttribute('data-key'), want);
  }
  press(el, 'ArrowDown');
  calls.length = 0;
  const enter = press(el, 'Enter');
  const space = press(el, ' ');
  assert.deepEqual(calls, [['r2', 'keydown', 'r2'], ['r2', 'keydown', 'r2']]);
  assert.equal(enter.defaultPrevented && space.defaultPrevented, true);
  press(el, 'Spacebar');
  assert.equal(calls.length, 3);
  calls.length = 0;
  for (const key of ['Tab', 'Escape', 'a', 'ArrowLeft']) assert.equal(press(el, key).defaultPrevented, false, key + ' is not handled');
  for (const mod of ['ctrlKey', 'metaKey', 'altKey']) {
    const ev = press(el, 'ArrowDown', { [mod]: true });
    assert.equal(ev.defaultPrevented, false);
    assert.equal(lb.active, 'r2');
  }
  assert.deepEqual(calls, []);
  /* A key pressed in a button inside the list is the button's: Enter must not activate the row. */
  const button = el.children[1].querySelector('button');
  const inner = button.fire('keydown', { key: 'Enter' });
  assert.equal(inner.defaultPrevented, false);
  assert.deepEqual(calls, []);
  assert.equal(dom.stats.focusCalls, 0, 'no key press moved DOM focus');
  assert.equal(dom.stats.lastFocus, null);
  /* The first arrow key with no cursor starts at the first row; Up starts at the last. */
  const fresh = listboxFixture();
  press(fresh.el, 'ArrowDown');
  assert.equal(fresh.lb.active, 'r1');
  const fresh2 = listboxFixture();
  press(fresh2.el, 'ArrowUp');
  assert.equal(fresh2.lb.active, 'r20');
  const fresh3 = listboxFixture();
  assert.equal(press(fresh3.el, 'Enter').defaultPrevented, false, 'Enter with no cursor does nothing');
  assert.deepEqual(fresh3.calls, []);
});

test('bindListbox: onActive reports key presses; onKey can take a key first; the page size is configurable', () => {
  const taken = [];
  const { el, lb, calls } = listboxFixture(20, { pageSize: 3, onKey: (e, active) => { if (e.key === 'o') { taken.push(active); return true; } return false; } });
  el.fire('focus');
  press(el, 'PageDown');
  assert.equal(lb.active, 'r4', 'pages of 3');
  assert.deepEqual(calls.filter(c => c[0] === 'active').map(c => c.slice(1)), [['r1', 'focus'], ['r4', 'key']]);
  const ev = press(el, 'o');
  assert.deepEqual(taken, ['r4']);
  assert.equal(ev.defaultPrevented, false);
  assert.equal(lb.setActive('nope'), false);
  assert.equal(lb.active, 'r4');
  assert.equal(lb.setActive('r9', { scroll: false, reason: 'test' }), true);
  assert.equal(cursor(el), 'r9');
  assert.equal(calls.pop()[2], 'test');
  assert.equal(lb.setActive(null), true);
  assert.equal(el.getAttribute('aria-activedescendant'), null);
  assert.equal(el.querySelectorAll('[data-active]').length, 0);
});

test('bindListbox: a click on an option moves the cursor and activates; a click on a button inside it does neither', () => {
  const { dom, el, lb, calls } = listboxFixture();
  const row = el.children[6];
  row.querySelector('span').fire('click');
  assert.equal(lb.active, 'r7');
  assert.deepEqual(calls.filter(c => c[0] !== 'active'), [['r7', 'click', 'r7']]);
  calls.length = 0;
  row.querySelector('button').fire('click');
  assert.equal(lb.active, 'r7');
  el.children[2].querySelector('button').fire('click');
  assert.equal(lb.active, 'r7', 'the button belongs to its own handler');
  assert.deepEqual(calls, []);
  el.fire('click');
  assert.equal(lb.active, 'r7');
  assert.equal(dom.stats.focusCalls, 0);
  const quiet = listboxFixture(5, { activateOnClick: false });
  quiet.el.children[1].fire('click');
  assert.equal(quiet.lb.active, 'r2');
  assert.deepEqual(quiet.calls.filter(c => c[0] !== 'active'), []);
});

test('bindListbox: a repaint never moves DOM focus or the scroll position, and the cursor stays on its row', () => {
  const { dom, el, lb, patch, items } = listboxFixture();
  el.focus();
  el.fire('focus');
  dom.resetStats();
  press(el, 'ArrowDown'); press(el, 'ArrowDown'); press(el, 'ArrowDown');
  assert.equal(lb.active, 'r4');
  el.scrollTop = 140;
  const row4 = el.children[3];
  for (let n = 0; n < 5; n++) patch([{ key: 'new' + n }, ...items]);
  patch(items);
  assert.equal(lb.active, 'r4');
  assert.equal(cursor(el), 'r4');
  assert.equal(el.children[3], row4);
  assert.equal(el.scrollTop, 140);
  assert.equal(dom.stats.focusCalls, 0, 'polling repaints never call focus()');
  assert.equal(dom.doc.activeElement, el);
  /* A new node for the same key (the row was removed and came back) gets the cursor marks again. */
  patch(items.filter(i => i.key !== 'r4'));
  assert.equal(lb.active, 'r5');
  patch(items);
  assert.equal(lb.active, 'r5');
  assert.equal(el.querySelectorAll('[data-active]').length, 1);
});

test('bindListbox: when the active row is filtered out the cursor moves to the nearest surviving neighbour in the same pass', () => {
  const { dom, el, lb, patch, items, calls } = listboxFixture();
  el.fire('focus');
  for (let i = 0; i < 4; i++) press(el, 'ArrowDown');
  assert.equal(lb.active, 'r5');
  calls.length = 0;
  patch(items.filter(i => i.key !== 'r5'));
  assert.equal(lb.active, 'r6', 'the following row first');
  assert.equal(cursor(el), 'r6', 'aria-activedescendant follows in the same pass');
  assert.equal(el.querySelector('[data-active]').getAttribute('data-key'), 'r6');
  assert.deepEqual(calls, [['active', 'r6', 'refresh']]);
  /* The last row filtered out: the previous one. */
  press(el, 'End');
  assert.equal(lb.active, 'r20');
  patch(items.filter(i => i.key !== 'r5' && i.key !== 'r20'));
  assert.equal(lb.active, 'r19');
  /* A run of rows goes with it: the nearest survivor in the old order, ties to the following row. */
  lb.setActive('r10');
  patch(items.filter(i => !['r5', 'r20', 'r9', 'r10', 'r11', 'r12'].includes(i.key)));
  assert.equal(lb.active, 'r8', 'r8 is 2 away, r13 is 3 away');
  lb.setActive('r7');
  patch(items.filter(i => !['r5', 'r20', 'r9', 'r10', 'r11', 'r12', 'r7', 'r8', 'r6'].includes(i.key)));
  assert.equal(lb.active, 'r13', 'r4 and r13 are both 2 and 3 away in the previous order (r4, r6, r7, r8, r13): r13 is nearer');
  lb.setActive('r14');
  patch(items.filter(i => ['r1', 'r2', 'r3', 'r4', 'r16', 'r17', 'r18', 'r19'].includes(i.key)));
  assert.equal(lb.active, 'r16', 'r15 and r13 are gone too: the first surviving row outward is r16, 2 away');
  lb.setActive('r16');
  patch(items.filter(i => ['r1', 'r2', 'r3', 'r4', 'r19'].includes(i.key)));
  assert.equal(lb.active, 'r4', 'r17 and r18 went too: the row before (1 away) beats r19 (3 away)');
  /* Everything gone: no cursor, no dangling aria-activedescendant. */
  patch([]);
  assert.equal(lb.active, null);
  assert.equal(el.getAttribute('aria-activedescendant'), null);
  patch(items);
  assert.equal(lb.active, null, 'the cursor does not come back by itself');
  assert.equal(dom.stats.focusCalls, 0);
  /* The active row is replaced by completely different rows: first row of the new list. */
  lb.setActive('r3');
  patch([{ key: 'z1' }, { key: 'z2' }]);
  assert.equal(lb.active, 'z1');
});

test('bindListbox: keyboard moves scroll the list (not the page) just far enough to show the active row', () => {
  const { dom, el, lb } = listboxFixture(40);
  const ROW = 20;
  dom.layout = node => {
    if (node === el) return { top: 0, bottom: 100, left: 0, right: 100, height: 100, width: 100 };
    const top = el.children.indexOf(node) * ROW - el.scrollTop;
    return { top, bottom: top + ROW, left: 0, right: 100, height: ROW, width: 100 };
  };
  el.fire('focus');
  for (let i = 0; i < 4; i++) press(el, 'ArrowDown');
  assert.equal(el.scrollTop, 0, 'row 5 is still fully in view');
  press(el, 'ArrowDown');
  assert.equal(el.scrollTop, 20, 'row 6 bottom edge is brought into view');
  press(el, 'End');
  assert.equal(el.scrollTop, 40 * ROW - 100);
  press(el, 'Home');
  assert.equal(el.scrollTop, 0);
  press(el, 'PageDown');
  assert.equal(lb.active, 'r9');
  assert.equal(el.scrollTop, 9 * ROW - 100);
  el.scrollTop = 300;
  lb.setActive('r2', { scroll: false });
  assert.equal(el.scrollTop, 300, 'scroll: false leaves it');
  /* Clicks and refreshes do not scroll either. */
  el.children[15].fire('click');
  assert.equal(el.scrollTop, 300);
  dom.layout = () => { throw new Error('layout unavailable'); };
  assert.doesNotThrow(() => press(el, 'ArrowDown'));
});

test('bindListbox: options without an id get a stable generated one; ids the view gave are used as they are', () => {
  const dom = makeDom();
  const el = dom.make('div', '<div role="option" data-key="a">A</div><div role="option" data-key="b" id="mine">B</div><div role="group" data-key="hdr">Round 1</div>');
  const lb = K.bindListbox(el, {});
  assert.deepEqual(lb.keys(), ['a', 'b'], 'groups are not options');
  lb.setActive('a');
  const id = el.getAttribute('aria-activedescendant');
  assert.match(id, /^vk-lb\d+-opt\d+$/);
  assert.equal(el.children[0].id, id);
  lb.setActive('b');
  assert.equal(el.getAttribute('aria-activedescendant'), 'mine');
  lb.setActive('a');
  assert.equal(el.getAttribute('aria-activedescendant'), id, 'the same option keeps its generated id');
  const ids = new Set();
  for (let n = 0; n < 3; n++) { const e = dom.make('div', '<div role="option" data-key="a">A</div>'); const b = K.bindListbox(e, {}); b.setActive('a'); ids.add(e.getAttribute('aria-activedescendant')); }
  assert.equal(ids.size, 3, 'two listboxes never share an id');
  /* Another option selector and key attribute. */
  const custom = dom.make('div', '<p class="row" data-id="x">X</p><p class="row" data-id="y">Y</p>');
  const c = K.bindListbox(custom, { optionSelector: '.row', keyAttr: 'data-id', activeAttr: 'data-cursor' });
  c.setActive('y');
  assert.equal(custom.children[1].getAttribute('data-cursor'), 'true');
});

test('bindListbox: destroy removes the listeners and the attribute; binding again replaces the old binding; keyedPatch refreshes the bound list', () => {
  const { el, lb, patch, items } = listboxFixture(6);
  assert.equal(el.listenerCount('keydown'), 1);
  press(el, 'ArrowDown');
  assert.equal(lb.active, 'r1');
  lb.destroy();
  assert.equal(el.listenerCount('keydown') + el.listenerCount('click') + el.listenerCount('focus'), 0);
  assert.equal(el.getAttribute('aria-activedescendant'), null);
  press(el, 'ArrowDown');
  assert.equal(lb.active, 'r1', 'a destroyed binding ignores keys');
  const again = K.bindListbox(el, {});
  const third = K.bindListbox(el, {});
  assert.equal(el.listenerCount('keydown'), 1, 'only the newest binding listens');
  assert.equal(el.vkListbox, third);
  assert.notEqual(again, third);
  third.setActive('r2');
  let refreshed = 0;
  const real = third.refresh;
  el.vkListbox = { refresh() { refreshed++; real(); } };
  patch(items.slice(1));
  assert.equal(refreshed, 1, 'keyedPatch refreshes the bound listbox');
  el.vkListbox = { refresh() { throw new Error('refresh blew up'); } };
  assert.doesNotThrow(() => patch(items));
});

/* ------------------------------------------------------------------ announcer (DOM) */

function fakeTimers() {
  let now = 0, id = 0;
  let queue = [];
  const api = {
    now: () => now,
    setTimeout: (fn, ms) => { queue.push({ id: ++id, at: now + ms, fn }); return id; },
    clearTimeout: i => { queue = queue.filter(t => t.id !== i); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at);
        if (!queue.length || queue[0].at > target) break;
        const t = queue.shift();
        now = Math.max(now, t.at);
        t.fn();
      }
      now = target;
    },
    pending: () => queue.length,
  };
  return api;
}

test('announcer(root): one sr-only polite status region, reused, timed by the announcer rules', () => {
  const dom = makeDom();
  const root = dom.make('div');
  const timers = fakeTimers();
  const a = K.announcer(root, timers);
  const regions = root.querySelectorAll('[role="status"]');
  assert.equal(regions.length, 1, 'exactly one role=status region');
  const polite = regions[0];
  assert.equal(polite.getAttribute('aria-live'), 'polite');
  assert.equal(polite.getAttribute('aria-atomic'), 'true');
  assert.match(polite.getAttribute('class'), /\bsr-only\b/);
  assert.equal(root.querySelectorAll('[role="alert"]').length, 1);
  assert.equal(root.querySelectorAll('[aria-live="assertive"]').length, 0, 'the alert region relies on role=alert');
  assert.equal(a.region(), polite);
  K.announcer(root, timers);
  assert.equal(root.querySelectorAll('[role="status"]').length, 1, 'a second announcer on the same root reuses the region');
  assert.equal(root.querySelectorAll('[role="alert"]').length, 1);

  assert.equal(a.say('Pilot 1 completed.', { kind: 'completed' }), true);
  assert.equal(a.say('Tool calls: 31', { kind: 'progress' }), false);
  timers.advance(3999);
  assert.equal(polite.textContent, '', 'still inside the 4 s window');
  a.say('Pilot 2 failed.', { kind: 'failed' });
  timers.advance(10);
  assert.equal(polite.textContent, 'Pilot 1 completed. Pilot 2 failed.');
  a.say('Pilot 3 discarded.', { kind: 'discarded' });
  timers.advance(7000);
  assert.equal(polite.textContent, 'Pilot 1 completed. Pilot 2 failed.', 'not before the 8 s gap');
  timers.advance(1100);
  assert.equal(polite.textContent, 'Pilot 3 discarded.');
  assert.equal(timers.pending(), 0, 'no timer is left running when nothing is queued');
  /* The same sentence again: the region is cleared first so a screen reader hears it. */
  const wait = a.say('Pilot 3 discarded.') && timers.now();
  assert.equal(wait, timers.now());
  timers.advance(7899);
  assert.equal(polite.textContent, 'Pilot 3 discarded.', 'still the old text before it is due');
  timers.advance(10);
  assert.equal(polite.textContent, '', 'cleared at the moment the same sentence is announced again');
  timers.advance(60);
  assert.equal(polite.textContent, 'Pilot 3 discarded.');
});

test('announcer(root): alerts use the role=alert region at once; repaint of the root recreates the regions; attach moves them; destroy cleans up', () => {
  const dom = makeDom();
  const root = dom.make('div');
  const timers = fakeTimers();
  const a = K.announcer(root, timers);
  assert.equal(a.alert('The local companion stopped answering.', { key: 'link' }), true);
  assert.equal(root.querySelector('[role="alert"]').textContent, 'The local companion stopped answering.');
  assert.equal(root.querySelector('[role="status"]').textContent, '');
  assert.equal(a.alert('The local companion stopped answering.', { key: 'link' }), false);
  a.resolve('link');
  timers.advance(100);
  assert.equal(a.alert('The local companion stopped answering.', { key: 'link' }), true);

  root.innerHTML = '<p>the view repainted its whole root</p>';
  assert.equal(root.querySelectorAll('[role="status"]').length, 0);
  a.say('Round 2 started.', { kind: 'new-round' });
  timers.advance(8100);
  assert.equal(root.querySelectorAll('[role="status"]').length, 1, 'recreated when the next message needed it');
  assert.equal(root.querySelector('[role="status"]').textContent, 'Round 2 started.');

  const other = dom.make('div');
  a.attach(other);
  assert.equal(other.querySelectorAll('[role="status"]').length, 1);
  assert.equal(other.querySelectorAll('[role="alert"]').length, 1);
  a.say('Round 3 started.');
  assert.equal(a.flush(), true);
  assert.equal(other.querySelector('[role="status"]').textContent, 'Round 3 started.');
  a.destroy();
  assert.equal(other.querySelectorAll('[role="status"]').length + other.querySelectorAll('[role="alert"]').length, 0);
  a.say('after destroy');
  timers.advance(60000);
  assert.equal(other.querySelectorAll('[role="status"]').length, 0);
  assert.equal(timers.pending(), 0);
});

test('announcer without a DOM or timers returns a controller that does nothing and does not throw', () => {
  const dead = K.announcer(null, {});
  assert.doesNotThrow(() => { dead.say('x'); dead.alert('y'); dead.resolve('k'); dead.flush(); dead.attach(null); dead.destroy(); });
  assert.equal(dead.region(), null);
  const dom = makeDom();
  const root = dom.make('div');
  const noTimers = K.announcer(root, { now: () => 0, setTimeout: () => null });
  noTimers.say('Pilot 1 completed.');
  assert.equal(noTimers.flush(), true, 'flush still works without timers');
  assert.equal(root.querySelector('[role="status"]').textContent, 'Pilot 1 completed.');
  noTimers.say('Pilot 1 completed.');
  noTimers.flush();
  assert.equal(root.querySelector('[role="status"]').textContent, 'Pilot 1 completed.', 'with no timer the sentence is simply set again');
});

/* ------------------------------------------------------------------ copyText */

test('copyText: the clipboard API when there is one, the textarea fallback when it fails or is missing, never rejects', async () => {
  const written = [];
  const good = { navigator: { clipboard: { writeText: async text => { written.push(text); } } } };
  assert.equal(await K.copyText('private/agent-rounds/rnd-0123abcd/runs/2/outputs/', good), true);
  assert.deepEqual(written, ['private/agent-rounds/rnd-0123abcd/runs/2/outputs/']);
  assert.equal(await K.copyText(null, good), true);
  assert.equal(written[1], '');

  /* Fallback fixture: a document whose execCommand reports what was selected. */
  const withDoc = (exec, nav) => {
    const dom = makeDom();
    const button = dom.make('button');
    button.focus();
    let copied = null;
    dom.doc.execCommand = command => { copied = { command, text: dom.doc.body.querySelector('textarea').value, active: dom.doc.activeElement.tagName }; return exec(); };
    dom.resetStats();
    return { dom, button, env: { navigator: nav, document: dom.doc }, seen: () => copied };
  };
  for (const nav of [{}, { clipboard: {} }, { clipboard: { writeText: () => Promise.reject(new Error('denied')) } }, { clipboard: { writeText: () => { throw new Error('sync throw'); } } }, undefined]) {
    const f = withDoc(() => true, nav === undefined ? {} : nav);
    assert.equal(await K.copyText('line 1\nline 2', f.env), true);
    assert.deepEqual(f.seen(), { command: 'copy', text: 'line 1\nline 2', active: 'TEXTAREA' });
    assert.equal(f.dom.doc.body.querySelectorAll('textarea').length, 0, 'the textarea is removed');
    assert.equal(f.dom.doc.activeElement, f.button, 'focus goes back where it was');
  }
  const refused = withDoc(() => false, {});
  assert.equal(await K.copyText('x', refused.env), false);
  assert.equal(refused.dom.doc.body.querySelectorAll('textarea').length, 0);
  const throwing = withDoc(() => { throw new Error('execCommand blew up'); }, {});
  assert.equal(await K.copyText('x', throwing.env), false);
  assert.equal(throwing.dom.doc.body.querySelectorAll('textarea').length, 0);
  const textarea = withDoc(() => true, {});
  await K.copyText('x', textarea.env);
  assert.equal(textarea.dom.stats.created, 1);
  assert.equal(await K.copyText('x', { navigator: {}, document: { createElement() {}, body: null } }), false);
  assert.equal(await K.copyText('x', { navigator: undefined, document: undefined }), false, 'nothing to copy with: false, not an error');
  assert.equal(await K.copyText('x', { navigator: { clipboard: { writeText: () => 'not a promise' } } }), true);
});

test('copyText: a clipboard request that never settles is abandoned for the textarea after 1.5 s; the first outcome wins', async () => {
  const dom = makeDom();
  const timers = fakeTimers();
  dom.doc.execCommand = () => true;
  let late;
  const stuck = { navigator: { clipboard: { writeText: () => new Promise(resolve => { late = resolve; }) } }, document: dom.doc, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout };
  const result = K.copyText('x', stuck);
  let settled = false;
  result.then(() => { settled = true; });
  timers.advance(1499);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false, 'still waiting for the clipboard');
  timers.advance(2);
  assert.equal(await result, true, 'the textarea copied it');
  late();
  assert.equal(dom.doc.body.querySelectorAll('textarea').length, 0);
  /* A clipboard that answers in time cancels the timer. */
  const quick = { navigator: { clipboard: { writeText: () => Promise.resolve() } }, document: dom.doc, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout };
  assert.equal(await K.copyText('y', quick), true);
  assert.equal(timers.pending(), 0);
  /* The textarea refuses and the clipboard never answers: false, not a hang. */
  dom.doc.execCommand = () => false;
  const none = K.copyText('z', stuck);
  timers.advance(1600);
  assert.equal(await none, false);
  /* A timer function that throws does not break copying. */
  assert.equal(await K.copyText('w', { navigator: { clipboard: { writeText: () => Promise.resolve() } }, setTimeout() { throw new Error('no timers'); } }), true);
});

/* ------------------------------------------------------------------ onVisible */

test('onVisible calls back when the tab becomes visible, not when it hides, and stops after the returned function runs', () => {
  const dom = makeDom();
  const doc = dom.doc;
  let calls = 0;
  const stop = K.onVisible(() => { calls++; }, { document: doc });
  assert.equal(typeof stop, 'function');
  doc.hidden = true; doc.fire('visibilitychange');
  assert.equal(calls, 0);
  doc.hidden = false; doc.fire('visibilitychange');
  assert.equal(calls, 1);
  doc.fire('visibilitychange');
  assert.equal(calls, 2);
  stop();
  doc.fire('visibilitychange');
  assert.equal(calls, 2);
  assert.equal((doc._listeners.visibilitychange || []).length, 0, 'the listener is removed');
  assert.doesNotThrow(() => stop());
  /* A document that cannot remove listeners still stops calling. */
  const bare = { hidden: false, listeners: [], addEventListener(type, fn) { this.listeners.push(fn); } };
  let n = 0;
  const stopBare = K.onVisible(() => { n++; }, { document: bare });
  bare.listeners.forEach(fn => fn());
  stopBare();
  bare.listeners.forEach(fn => fn());
  assert.equal(n, 1);
  assert.equal(typeof K.onVisible(() => {}, { document: {} }), 'function');
  assert.equal(typeof K.onVisible(null, { document: doc }), 'function');
  assert.equal(typeof K.onVisible(() => {}), 'function', 'no document at all: a no-op');
  assert.equal(K.isHidden({ hidden: true }), true);
  assert.equal(K.isHidden({ hidden: false }), false);
  assert.equal(K.isHidden(), false);
});

/* ------------------------------------------------------------------ frames and motion */

test('nextFrame runs once after the next frame, falls back to a timeout and then to an immediate call, and can be cancelled', () => {
  const frames = [];
  const withRaf = loadKit({ requestAnimationFrame: fn => frames.push(fn), cancelAnimationFrame() {} }).FinanceViews;
  let n = 0;
  withRaf.nextFrame(() => { n++; });
  assert.equal(n, 0);
  frames.shift()();
  assert.equal(n, 1);
  const cancel = withRaf.nextFrame(() => { n++; });
  cancel();
  frames.shift()();
  assert.equal(n, 1, 'a cancelled callback does not run');

  const timeouts = [];
  const cleared = [];
  const withTimeout = loadKit({ setTimeout: (fn, ms) => { timeouts.push([fn, ms]); return timeouts.length; }, clearTimeout: id => cleared.push(id) }).FinanceViews;
  withTimeout.nextFrame(() => { n++; });
  assert.equal(timeouts[0][1], 16);
  timeouts[0][0]();
  assert.equal(n, 2);
  withTimeout.nextFrame(() => { n++; })();
  assert.deepEqual(cleared, [2]);

  const bare = vm.createContext({});
  bare.window = bare;
  vm.runInContext(KIT_SOURCE, bare);
  bare.FinanceViews.nextFrame(() => { n++; });
  assert.equal(n, 3, 'no timers at all: it runs at once');
  assert.equal(typeof bare.FinanceViews.nextFrame(null), 'function');
  const throwing = loadKit({ requestAnimationFrame() { throw new Error('rAF unavailable'); } }).FinanceViews;
  throwing.nextFrame(() => { n++; });
  assert.equal(n, 4, 'a requestAnimationFrame that throws falls back to running at once');
  const once = loadKit({ requestAnimationFrame: fn => frames.push(fn) }).FinanceViews;
  once.nextFrame(() => { n++; });
  const run = frames.shift();
  run(); run();
  assert.equal(n, 5, 'a callback runs once even if the frame fires twice');
});

test('reducedMotion follows matchMedia, and says "reduced" when it cannot tell', () => {
  assert.equal(loadKit({}).FinanceViews.reducedMotion(), true, 'no matchMedia');
  assert.equal(loadKit({ matchMedia: () => ({ matches: true }) }).FinanceViews.reducedMotion(), true);
  assert.equal(loadKit({ matchMedia: () => ({ matches: false }) }).FinanceViews.reducedMotion(), false);
  assert.equal(loadKit({ matchMedia: () => { throw new Error('nope'); } }).FinanceViews.reducedMotion(), true);
  assert.equal(loadKit({ matchMedia: () => null }).FinanceViews.reducedMotion(), true);
  let asked = null;
  loadKit({ matchMedia: q => { asked = q; return { matches: false }; } }).FinanceViews.reducedMotion();
  assert.equal(asked, '(prefers-reduced-motion: reduce)');
});

/* ------------------------------------------------------------------ loading inside the page tests' fake documents */

/* The fake element of tests/agents-page.test.cjs, copied: no querySelectorAll, no setAttribute, contains() always false. */
function pageTestElement(id) {
  return {
    id, innerHTML: '', textContent: '', agHtml: null, disabled: false, className: '', dataset: {}, tabIndex: 0,
    classList: { toggle() {}, add() {}, remove() {} },
    contains: () => false, querySelector: () => null, getAttribute: () => null, focus() {}, getClientRects: () => [],
  };
}
function loadKit(globals) {
  const context = vm.createContext({ console, setTimeout, clearTimeout, ...globals });
  context.window = context;
  vm.runInContext(KIT_SOURCE, context, { filename: 'views-kit.js' });
  return context;
}

test('the kit loads in the minimal fake document of tests/agents-page.test.cjs and every part degrades quietly', async () => {
  const body = pageTestElement('body');
  const document = { activeElement: null, hidden: false, body, title: 'Finance Task Studio', querySelector: s => (/^#([\w-]+)$/.test(s) ? pageTestElement(s.slice(1)) : null), addEventListener() {} };
  const context = loadKit({ document, location: { protocol: 'http:', hostname: '127.0.0.1' }, CSS: { escape: v => String(v) } });
  const V = context.FinanceViews;
  assert.ok(V && typeof V.setHtml === 'function' && typeof V.planKeyed === 'function', 'window.FinanceViews exists');
  const el = pageTestElement('x');
  assert.equal(V.setHtml(el, V.html`<p>${'a<b'}</p>`), true);
  assert.equal(el.innerHTML, '<p>a&lt;b</p>');
  assert.equal(V.setHtml(el, V.html`<p>${'a<b'}</p>`), false);
  assert.equal(V.keyedPatch(el, [{ key: 'a' }], {}), null);
  const lb = V.bindListbox(el, {});
  assert.ok(lb, 'a listbox can be bound to an element that cannot do much');
  assert.doesNotThrow(() => { lb.refresh(); lb.setActive('a'); lb.destroy(); });
  const ann = V.announcer(el, {});
  assert.doesNotThrow(() => { ann.say('x'); ann.alert('y'); ann.flush(); ann.destroy(); });
  assert.equal(await V.copyText('x'), false);
  assert.equal(typeof V.onVisible(() => {}), 'function');
  assert.equal(V.store.get('fts.mc.v1', 'fresh'), 'fresh', 'no localStorage in this document: memory only');
  assert.equal(V.store.set('fts.mc.v1', { a: 1 }), false);
  assert.deepEqual(JSON.parse(JSON.stringify(V.store.get('fts.mc.v1'))), { a: 1 });
  assert.equal(document.title, 'Finance Task Studio', 'the kit never changes the tab title');
  assert.equal(V.planKeyed(['a'], ['a', 'b']).length, 2);
});

test('the kit loads in the generous fake of the edition test (tests/agents-page.test.cjs runEdition) and with throwing globals', async () => {
  const fake = () => ({
    innerHTML: '', textContent: '', className: '', dataset: {}, style: {}, hidden: false, value: '', checked: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, setAttribute() {}, getAttribute: () => null, append() {}, remove() {}, focus() {},
    click() {}, closest: () => null, contains: () => false, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, scrollIntoView() {},
    setSelectionRange() {},
  });
  const store = new Map();
  const document = {
    activeElement: null, hidden: false, title: '',
    querySelector: s => { if (!store.has(s)) store.set(s, fake()); return store.get(s); },
    querySelectorAll: () => [], addEventListener() {}, createElement: fake, body: fake(), documentElement: fake(),
  };
  const context = loadKit({ document, location: { protocol: 'file:', hostname: '' }, navigator: {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, requestAnimationFrame: () => 0, setInterval: () => 0, clearInterval() {} });
  const V = context.FinanceViews;
  const el = fake();
  assert.equal(V.setHtml(el, '<p>x</p>'), true);
  assert.equal(V.keyedPatch(el, [{ key: 'a' }], {}), null, 'no insertBefore on this fake: nothing to patch');
  const lb = V.bindListbox(el, {});
  assert.doesNotThrow(() => { lb.setActive('a'); lb.refresh(); lb.destroy(); });
  assert.doesNotThrow(() => { const a = V.announcer(el, {}); a.say('x'); a.destroy(); });
  assert.equal(await V.copyText('x'), false);
  assert.equal(V.store.set('fts.wb.v1', { step: 3 }), true, 'a working localStorage is used');
  assert.equal(document.title, '');

  /* Globals that throw when touched: loading must not touch any of them, and later calls must survive them. */
  const trap = name => { throw new Error('the kit touched ' + name + ' while loading'); };
  const hostile = vm.createContext({ console, setTimeout, clearTimeout });
  for (const name of ['document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'matchMedia', 'requestAnimationFrame']) Object.defineProperty(hostile, name, { configurable: true, get() { return trap(name); } });
  hostile.window = hostile;
  vm.runInContext(KIT_SOURCE, hostile, { filename: 'views-kit.js' });
  const H = hostile.FinanceViews;
  assert.equal(H.store.get('fts.mc.v1', 'ok'), 'ok');
  assert.equal(H.store.set('fts.mc.v1', 1), false);
  assert.equal(await H.copyText('x'), false);
  assert.equal(typeof H.onVisible(() => {}), 'function');
  assert.equal(H.setHtml({ innerHTML: '' }, 'x'), true);
  assert.equal(H.keyedPatch({}, [], {}), null);
  assert.equal(H.isHidden(), false);
  assert.doesNotThrow(() => H.announcer({}, {}).say('x'));
  assert.equal(H.bindListbox({}, {}) !== null, true);
});

test('require() in Node exports the same API as the global, and the UMD tail is the repo pattern', () => {
  assert.ok(/if\(typeof module!=='undefined'&&module\.exports\)module\.exports=api;else scope\.FinanceViews=api;/.test(KIT_SOURCE));
  const context = loadKit({});
  assert.deepEqual(Object.keys(context.FinanceViews).sort(), Object.keys(K).sort());
  const exported = ['html', 'raw', 'isRaw', 'esc', 'clamp', 'stepClass', 'planKeyed', 'applyPlan', 'makeAnnouncer', 'trimRing', 'formatTime', 'ago', 'duration', 'nextListIndex', 'nextTreeIndex', 'rovingTabindex', 'nextSplitterStep', 'makeStore', 'store', 'setHtml', 'keyedPatch', 'bindListbox', 'announcer', 'copyText', 'onVisible'];
  for (const name of exported) assert.ok(name in K, name + ' is exported');
});

/* ------------------------------------------------------------------ what the page may not contain */

test('views-kit.js obeys the repo rules: no dynamic code, no network, no absolute URL, no inline style or handler, no tab title, no observers', () => {
  const code = KIT_SOURCE;
  assert.ok(!/\beval\s*\(|new Function|\bFunction\s*\(/.test(code), 'no dynamic code');
  assert.ok(!/https?:\/\//.test(code), 'no absolute URL');
  assert.ok(!/\bfetch\b|XMLHttpRequest|WebSocket|sendBeacon|importScripts|EventSource/.test(code), 'no transport');
  assert.ok(!/style\s*=\s*"/.test(code) && !/\.style\b|cssText/.test(code), 'no inline style, by attribute or by property');
  assert.ok(!/\bon(?:click|input|change|keydown|load|error)\s*=/.test(code), 'no inline event handler');
  assert.ok(!/document\.title|\.title\s*=/.test(code), 'the kit never sets the tab title');
  assert.ok(!/MutationObserver|ResizeObserver|IntersectionObserver|CustomEvent|location\.hash/.test(code), 'no observers, custom events or hash routing');
  assert.ok(!/\binnerHTML\s*=\s*['"`]?\s*['"`]/.test(code.replace(/el\.innerHTML=text;/, '')) , 'only setHtml writes innerHTML');
  assert.ok(!/localStorage\.|sessionStorage|indexedDB/.test(code), 'storage is reached only through scope.localStorage inside makeStore');
  const writes = [...code.matchAll(/\.innerHTML\s*=(?!=)/g)];
  assert.equal(writes.length, 1, 'innerHTML is written in exactly one place (setHtml)');
});
