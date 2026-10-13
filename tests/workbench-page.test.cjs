'use strict';
/* Tests for the Evidence Workbench page (workbench.js) without a browser.

   The real workbench.js runs in a vm with the real kit (views-kit.js), the real model (workbench-model.js), the real package engine and the real
   agents.js client, on a small fake DOM that parses markup into nodes, answers selectors and bubbles events. Its requests go to a real companion
   (backend/server.cjs) on an ephemeral port, backed by backend/agents/stub-claude.cjs, so no model is started and nothing leaves this machine.
   Packages are synthetic hand-built records (Atlas, Meridian, Borealis, Cobalt); the diff between them is the real diffPackages. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { cleanEnv } = require('./fixtures/clean-env.cjs');
const { createServer } = require('../backend/server.cjs');
const { createAgentService } = require('../backend/agents/index.cjs');

const REPO = path.resolve(__dirname, '..');
const STUB = path.join(REPO, 'backend', 'agents', 'stub-claude.cjs');
const read = name => fs.readFileSync(path.join(REPO, name), 'utf8');
const SCRIPTS = ['core.js', 'package-engine.js', 'views-kit.js', 'workbench-model.js', 'agents.js', 'workbench.js'];
const E = require('../package-engine.js');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, { timeout = 15000, interval = 20, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + label);
    await sleep(interval);
  }
}

/* ------------------------------------------------------------------ the fake DOM */

function makeDom() {
  const stats = { scrolled: [], focusCalls: 0 };
  const doc = {};
  const dom = { doc, stats, pickers: [], layout: null };
  const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link']);
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#96': '`', middot: '\u00b7', rarr: '\u2192', larr: '\u2190', lsaquo: '\u2039', rsaquo: '\u203a', hellip: '\u2026', ndash: '\u2013' };
  const decode = text => text.replace(/&(#\d+|[a-z]+);/gi, (all, name) => (name[0] === '#' && /^#\d+$/.test(name) && !(name in ENTITIES) ? String.fromCodePoint(Number(name.slice(1))) : name in ENTITIES ? ENTITIES[name] : all));

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
        const value = m[2] !== undefined ? m[2].replace(/\\([0-9a-fA-F]{1,6}) ?|\\(.)/g, (_, hex, ch) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch)) : m[3];
        out.attrs.push([m[1], value === undefined ? null : value]);
      } else throw new Error('fake DOM: unsupported selector ' + text);
      rest = rest.slice(m[0].length);
    }
    return out;
  }
  const splitList = selector => selector.split(/,(?![^[]*\])/).map(s => s.trim()).filter(Boolean);
  const splitChain = selector => selector.match(/(?:\[[^\]]*\]|[^\s[])+/g) || [];
  function matchesCompound(el, c) {
    if (!(el instanceof FElement)) return false;
    if (c.tag && el.tagName !== c.tag) return false;
    if (c.id && el.getAttribute('id') !== c.id) return false;
    const classes = (el.getAttribute('class') || '').split(/\s+/);
    if (!c.classes.every(x => classes.includes(x))) return false;
    return c.attrs.every(([name, value]) => (value === null ? el.hasAttribute(name) : el.getAttribute(name) === value));
  }
  /* A chain of compound selectors separated by spaces (descendants). */
  function matchesSelector(el, selector) {
    return splitList(selector).some(one => {
      const chain = splitChain(one).map(parseCompound);
      if (!matchesCompound(el, chain[chain.length - 1])) return false;
      let node = el.parentNode;
      for (let i = chain.length - 2; i >= 0; i--) {
        while (node && !matchesCompound(node, chain[i])) node = node.parentNode;
        if (!node) return false;
        node = node.parentNode;
      }
      return true;
    });
  }
  function parseInto(parent, markup) {
    const re = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/)?>|([^<]+)/g;
    const attrRe = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    const stack = [parent];
    const adopt = (to, child) => { child.parentNode = to; to.childNodes.push(child); };
    let m;
    while ((m = re.exec(markup))) {
      const top = stack[stack.length - 1];
      if (m[5] !== undefined) { adopt(top, new FText(decode(m[5]))); continue; }
      if (m[0].startsWith('<!--')) continue;
      const tag = m[2].toLowerCase();
      if (m[1]) {
        for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName.toLowerCase() === tag) { stack.length = i; break; }
        continue;
      }
      const el = new FElement(tag);
      let a;
      attrRe.lastIndex = 0;
      while ((a = attrRe.exec(m[3] || ''))) el._attrs.set(a[1], decode(a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : ''));
      if (el._attrs.has('value')) el.value = el._attrs.get('value');
      adopt(top, el);
      if (!VOID.has(tag) && !m[4]) stack.push(el);
    }
  }
  class FNode {
    constructor() { this.parentNode = null; this.childNodes = []; this.ownerDocument = doc; this._listeners = {}; }
    get firstChild() { return this.childNodes[0] || null; }
    get nextSibling() { const p = this.parentNode; if (!p) return null; const i = p.childNodes.indexOf(this); return i < 0 ? null : p.childNodes[i + 1] || null; }
    get children() { return this.childNodes.filter(n => n instanceof FElement); }
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    _unlink() {
      const p = this.parentNode;
      if (!p) return;
      const i = p.childNodes.indexOf(this);
      if (i >= 0) p.childNodes.splice(i, 1);
      this.parentNode = null;
      if (doc.activeElement && this.contains(doc.activeElement)) doc.activeElement = doc.body;
    }
    insertBefore(node, ref) {
      if (ref && ref.parentNode !== this) throw new Error('fake DOM: the reference node is not a child');
      const incoming = node instanceof FFrag ? node.childNodes.splice(0) : [node];
      incoming.forEach(k => { if (k.parentNode) k._unlink(); });
      const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
      incoming.forEach((k, i) => { k.parentNode = this; this.childNodes.splice(at + i, 0, k); });
      return node;
    }
    appendChild(node) { return this.insertBefore(node, null); }
    removeChild(node) { if (node.parentNode !== this) throw new Error('fake DOM: not a child'); node._unlink(); return node; }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter(f => f !== fn); }
    /* Dispatch at this node; it bubbles through the parents, then reaches the document's listeners. */
    fire(type, props = {}) {
      const ev = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props };
      for (let n = this; n; n = n.parentNode) { ev.currentTarget = n; (n._listeners[type] || []).slice().forEach(fn => fn(ev)); }
      (doc._listeners[type] || []).slice().forEach(fn => fn(ev));
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
      this.scrollTop = 0; this.scrollLeft = 0; this.scrollHeight = 0; this.clientHeight = 0;
      this.selectionStart = null; this.selectionEnd = null;
      this.value = '';
      this._html = '';
      this.files = [];
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
    get hidden() { return this._attrs.has('hidden'); }
    set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
    get tabIndex() { const v = this.getAttribute('tabindex'); return v === null ? -1 : Number(v); }
    get innerHTML() { return this._html; }
    set innerHTML(markup) { this.childNodes.slice().forEach(k => k._unlink()); this._html = String(markup); parseInto(this, this._html); }
    get textContent() { return this.childNodes.map(k => (k instanceof FText ? k.data : k.textContent)).join(''); }
    set textContent(text) { this.childNodes.slice().forEach(k => k._unlink()); if (text) { const t = new FText(String(text)); t.parentNode = this; this.childNodes.push(t); } }
    matches(selector) { return matchesSelector(this, selector); }
    closest(selector) { for (let n = this; n instanceof FElement; n = n.parentNode) if (n.matches(selector)) return n; return null; }
    querySelectorAll(selector) {
      const out = [];
      const walk = node => node.childNodes.forEach(k => { if (k instanceof FElement) { if (matchesSelector(k, selector)) out.push(k); walk(k); } });
      walk(this);
      return out;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    focus() { if (this.disabled) return; stats.focusCalls++; doc.activeElement = this; }
    blur() { if (doc.activeElement === this) doc.activeElement = doc.body; }
    select() {}
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
    remove() { this._unlink(); }
    scrollIntoView() { stats.scrolled.push(this); }
    click() {
      if (this.type === 'file') { dom.pickers.push(this); return; }
      if (this.disabled) return;
      this.fire('click', { button: 0 });
    }
    getBoundingClientRect() { return dom.layout ? dom.layout(this) : { top: 0, bottom: 0, left: 0, right: 0, height: 0, width: 0 }; }
  }
  Object.assign(doc, {
    hidden: false, execCommand: null, _listeners: {},
    createElement(tag) { return new FElement(tag); },
    createDocumentFragment() { return new FFrag(); },
    createTextNode(data) { return new FText(data); },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter(f => f !== fn); },
    querySelector(selector) { return doc.body.querySelector(selector); },
    querySelectorAll(selector) { return doc.body.querySelectorAll(selector); },
    getElementById(id) { return doc.body.querySelector('#' + id); },
  });
  doc.body = new FElement('body');
  doc.activeElement = doc.body;
  return dom;
}

/* ------------------------------------------------------------------ synthetic packages (hand-built records in the package-engine shape) */

const digest = s => crypto.createHash('sha256').update(s).digest('hex');
const doc = (name, kind, records, extra = {}) => ({ id: 'doc-' + digest(name).slice(0, 10), name, bytes: 100, sha256: digest(name + JSON.stringify(records)), role: 'source', roleBasis: 'QA fixture', status: 'extracted', kind, records, metadata: {}, warnings: [], ...extra });
const txt = (name, lines, extra) => doc(name, 'txt', lines.map((t, i) => ({ locator: 'Line ' + (i + 1), text: t })).filter(r => r.text), extra);
const csv = (name, rows, extra) => doc(name, 'csv', rows.map((v, i) => ({ locator: 'Row ' + (i + 1), text: v.join(' | '), values: v })), extra);
const cell = (sheet, ref, value, extra = {}) => ({ locator: sheet + '!' + ref, text: String(value), sheet, cell: ref, value: String(value), type: 'n', formula: '', hasFormula: false, formulaType: '', cachePresent: true, hidden: false, context: '', ...extra });
const xlsx = (name, records, extra) => doc(name, 'xlsx', records, extra);
const pkg = (documents, title = 'QA fixture') => ({ schemaVersion: 1, kind: 'finance-task-package', id: 'package-qa', title, fingerprint: digest(documents.map(d => d.name + d.sha256).sort().join('\n')), documents });
const TERMS = (limit = '3,000') => txt('Facility_Terms.txt', ['Atlas Holdings owes Meridian Partners 2,480 units', 'Facility limit is ' + limit + ' units', '', 'Borealis review on 2026-09-30', 'Cobalt reserve 1,200.00 units', 'Line six', 'Line seven', 'Line eight', 'Line nine', 'Line ten', 'Line eleven', 'Line twelve', 'Line thirteen']);
const FACTS = (due = '1850') => csv('Cash_Facts.csv', [['Label', 'Value'], ['Opening usable cash', '100'], ['Payments due', due], ['Requested draw', '2,480']]);
const MODEL = (b3, more = {}) => xlsx('Atlas_Model.xlsx', [cell('Bridge', 'B2', 1850), cell('Bridge', 'B3', b3), cell('Bridge', 'B10', 77), cell('Bridge', 'C9', 1200), ...(more.b20 ? [cell('Bridge', 'B20', 5)] : []), ...(more.b100 ? [] : [cell('Bridge', 'B100', 9)]), cell('Summary', 'A1', 'Atlas', { type: 's' })]);
const NOTES = () => txt('Grader_Notes.txt', ['Expected bridge 1,200 units and headroom 500 units'], { role: 'evaluator' });
const BIG = () => txt('Big_Log.txt', Array.from({ length: 450 }, (_, i) => 'Borealis schedule entry ' + (i + 1)));
const SIDE = () => [txt('inputs/Cobalt_Notes.txt', ['Cobalt note one', 'Cobalt note two']), csv('inputs/Borealis_Schedule.csv', [['Item', 'Amount'], ['Reserve', '40']])];
const basePkg = () => pkg([TERMS('2,000'), FACTS('1850'), MODEL(100), NOTES(), BIG(), ...SIDE()], 'Atlas base');
const candPkg = () => pkg([TERMS('3,000'), FACTS('1900'), MODEL(150, { b20: true, b100: true }), NOTES(), BIG(), ...SIDE()], 'Atlas changed');
const PROJECT = () => ({
  title: 'Atlas bridge (QA fixture)', versions: { prompt: 'v1', workbook: 'v1', evaluator: 'v1' },
  sources: [
    { id: 's-terms', title: 'Terms', file: 'Facility_Terms.txt', page: 'Lines 1 to 2', cell: '', date: '', authority: '', version: '', excerpt: 'Atlas Holdings owes Meridian Partners 2,480 units', reviewStatus: 'pending', suppliedToSolver: true },
    { id: 's-model', title: 'Model', file: 'Atlas_Model.xlsx', page: '', cell: 'Bridge!B3; B2', date: '', authority: '', version: '', excerpt: '', reviewStatus: 'pending', suppliedToSolver: true },
    { id: 's-bad', title: 'Clause', file: 'Facility_Terms.txt', page: 'Clause 4.2', cell: '', date: '', authority: '', version: '', excerpt: '', reviewStatus: 'pending', suppliedToSolver: true },
  ],
  roots: [{ id: 'r1', title: 'Credit counted as cash', outputs: [
    { id: 'o-bridge', label: 'Cash bridge', unit: 'units', correct: '1200', wrong: '0', absTolerance: '0', relTolerance: '0', threshold: '0', direction: 'at-most', calculation: '', sourceIds: ['s-terms', 's-model'] },
    { id: 'o-limit', label: 'Facility headroom', unit: 'units', correct: '500', wrong: '500.2', absTolerance: '0', relTolerance: '0', threshold: '', direction: 'at-least', calculation: '', sourceIds: ['s-bad'] },
  ] }],
});

/* ------------------------------------------------------------------ the world: a real companion with the stub runtime */

async function makeWorld(t, scenario = {}, options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-wb-test-'));
  const projectRoot = path.join(base, 'project');
  const source = path.join(base, 'source');
  const tmpRoot = path.join(base, 'tmp');
  fs.mkdirSync(path.join(projectRoot, 'private'), { recursive: true });
  fs.mkdirSync(source);
  fs.mkdirSync(tmpRoot);
  fs.writeFileSync(path.join(source, 'Facility_Terms.txt'), 'Atlas facility terms, synthetic. Available credit is not cash received.\n');
  fs.writeFileSync(path.join(source, 'Cash_Facts.csv'), 'Label,Value\nOpening usable cash,100\nConfirmed funded draw,500\n');
  const env = { ...cleanEnv(), FINANCE_STUB_SCENARIO: JSON.stringify(scenario), ...(options.env || {}) };
  const service = createAgentService({ root: projectRoot, env, claudeBin: STUB, tmpRoot, limits: options.limits });
  const app = createServer({ root: projectRoot, service, port: 0, log: () => {} });
  const { port } = await app.listen();
  const w = { base, projectRoot, source, service, app, port, env, origin: `http://127.0.0.1:${port}`, scenario: value => { env.FINANCE_STUB_SCENARIO = JSON.stringify(value); } };
  t.after(async () => { await app.shutdown(); fs.rmSync(base, { recursive: true, force: true }); });
  return w;
}
const PROMPT = 'Assess the Atlas liquidity position using the supplied records and recommend whether the borrowing can proceed.';
const ACK = ['shell-access', 'network', 'isolation-by-audit'];
const GOLD = {
  gold: { decision: 'hold', figures: [{ label: 'Usable cash', value: '1,250', tolerance: 1 }, { label: 'Requested draw', value: '2,480', tolerance: 0 }, { label: 'Facility headroom', value: '500', tolerance: 0 }], notes: 'Synthetic gold' },
  fingerprints: [{ id: 'fp-alpha', label: 'Counts available credit as cash', tokens: ['available facility counted'], figures: [] }],
};
async function seedRound(w, { label = 'Atlas round 1', task = 'Atlas', run = true, wait = true } = {}) {
  const round = await w.service.createRound({ label, task, sourceDir: w.source, promptText: PROMPT, gafVisible: true, config: { model: 'claude-opus-5-5', effort: 'medium', count: 1 } });
  await w.service.freezeRound(round.id, GOLD);
  const { summarySha256 } = await w.service.approvalSummary(round.id);
  await w.service.approveRound(round.id, { summarySha256, acknowledgements: ACK });
  if (run) { await w.service.launchRound(round.id); if (wait) await w.service.whenSettled(round.id); }
  return round.id;
}

/* ------------------------------------------------------------------ the page: the real scripts in a vm on the fake DOM */

function makeStorage({ broken = false } = {}) {
  const map = new Map();
  const guard = () => { if (broken) throw new Error('synthetic: storage is blocked'); };
  return { map, getItem: k => { guard(); return map.has(k) ? map.get(k) : null; }, setItem: (k, v) => { guard(); map.set(k, String(v)); }, removeItem: k => { guard(); map.delete(k); } };
}

function makePage(t, world, opts = {}) {
  const dom = makeDom();
  const document = dom.doc;
  const shell = document.createElement('div');
  shell.setAttribute('id', 'dashboard-app');
  document.body.appendChild(shell);
  const toast = { messages: [] };
  const state = { pkg: opts.pkg || null, pair: opts.pair || null, project: opts.project || null, loadCalls: 0, navigated: [] };
  const requests = [];
  const clip = [];
  const storage = opts.storage || makeStorage();
  const pageFetch = async (url, init = {}) => {
    requests.push({ url, method: init.method || 'GET' });
    if (!world) throw new Error('synthetic: the companion is not reachable');
    const headers = { ...(init.headers || {}) };
    if (init.method && init.method !== 'GET') headers.Origin = world.origin;
    return fetch(world.origin + url, { ...init, headers });
  };
  const context = vm.createContext({
    document, fetch: pageFetch, setTimeout, clearTimeout, setInterval, clearInterval, console, URL, Blob, TextEncoder, TextDecoder, crypto: globalThis.crypto, queueMicrotask,
    location: opts.location || { protocol: 'http:', hostname: '127.0.0.1' }, localStorage: storage,
    navigator: { clipboard: { writeText: async text => { clip.push(text); } } },
  });
  context.window = context;
  context.FinanceDashboard = {
    getPackage: () => state.pkg, getEvidencePair: () => state.pair,
    loadFiles() { state.loadCalls++; }, navigate(id) { state.navigated.push(id); return true; }, notify(m) { toast.messages.push(m); },
  };
  if (opts.project !== undefined) context.FinanceAuthoring = { getProject: () => (state.project ? JSON.parse(JSON.stringify(state.project)) : null) };
  for (const name of SCRIPTS) vm.runInContext(read(name), context, { filename: name });
  const WB = context.FinanceWorkbench;
  assert.ok(WB && typeof WB.render === 'function' && typeof WB.afterRender === 'function' && typeof WB.open === 'function', 'workbench.js exports render, afterRender and open');
  t.after(() => WB.afterRender(false));
  const q = sel => document.querySelector(sel);
  const qa = sel => document.querySelectorAll(sel);
  const page = {
    dom, document, context, WB, state, requests, clip, storage, toast, q, qa,
    rerender() { shell.innerHTML = WB.render({ package: state.pkg, notify() {}, loadFiles: context.FinanceDashboard.loadFiles }); WB.afterRender(true); },
    text: sel => (q(sel) || { textContent: '' }).textContent.replace(/\s+/g, ' ').trim(),
    root: () => q('#wb-root'),
    all: () => (q('#wb-root') ? q('#wb-root').textContent.replace(/\s+/g, ' ') : ''),
    async mount() { page.rerender(); await page.settle(); },
    async settle(ms = 60) { let quiet = 0; while (quiet < 3) { await sleep(ms / 3); quiet++; } },
    click(sel) { const el = typeof sel === 'string' ? q(sel) : sel; assert.ok(el, 'missing ' + sel); el.fire('click', { button: 0 }); return el; },
    key(sel, key, props = {}) { const el = typeof sel === 'string' ? q(sel) : sel; assert.ok(el, 'missing ' + sel); return el.fire('keydown', { key, ...props }); },
    type(sel, value) { const el = typeof sel === 'string' ? q(sel) : sel; assert.ok(el, 'missing ' + sel); el.value = value; el.fire('input'); },
    choose(sel, value) { const el = q(sel); assert.ok(el, 'missing ' + sel); el.value = value; el.fire('change'); },
    byKey: key => qa('[data-key]').find(el => el.getAttribute('data-key') === key) || null,
    file: name => qa('#wb-tree [role="treeitem"]').find(el => el.querySelector('.wb-fn') && el.querySelector('.wb-fn').textContent === name) || null,
    crit: text => qa('#wb-crit [role="option"]').find(el => el.textContent.includes(text)) || null,
    primaries: () => qa('#wb-root button.primary'),
  };
  return page;
}

/* ====================================================================== shared fixtures */

const ANSWER = 'Usable cash is 1,250. Hold the borrowing.';
const file = (name, text) => ({ name, size: text.length, webkitRelativePath: '', text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer });
const FORBIDDEN = /%|pass rate|success rate|failure rate|difficulty|caught/i;

/* One companion with a finished round, shared by the tests that only read. */
let sharedWorld = null;
async function finishedWorld(t) {
  if (!sharedWorld) {
    sharedWorld = (async () => {
      const w = await makeWorld({ after() {} }, { resultText: ANSWER });
      w.roundId = await seedRound(w);
      return w;
    })();
  }
  return sharedWorld;
}
test.after(async () => { if (sharedWorld) { const w = await sharedWorld; await w.app.shutdown(); fs.rmSync(w.base, { recursive: true, force: true }); } });

async function fullPage(t, { pair = true, project = true, pkgs, storage, selectRun = true } = {}) {
  const w = await finishedWorld(t);
  const base = basePkg(), cand = candPkg();
  const page = makePage(t, w, { pkg: cand, pair: pair ? { baseline: base, candidate: cand } : null, project: project ? PROJECT() : undefined, storage, ...(pkgs || {}) });
  await page.mount();
  await waitFor(() => page.qa('#wb-crit [role="option"]').length > 0 && page.text('#wb-log-note') !== undefined, { label: 'criteria' });
  await waitFor(() => page.qa('#wb-log .wb-ll').length > 0, { label: 'log lines' });
  await page.settle();
  return { page, w, roundId: w.roundId, base, cand };
}
const rowText = el => el.textContent.replace(/\s+/g, ' ').trim();
const critNames = page => page.qa('#wb-crit [role="option"]').map(rowText);

/* ====================================================================== the page as a whole */

test('an empty page says what is missing and offers one yellow primary; no style attributes, no forbidden words', async t => {
  const page = makePage(t, null);
  await page.mount();
  assert.ok(page.root());
  assert.equal(page.primaries().length, 1, 'exactly one yellow primary');
  assert.match(page.text('#wb-mid-body'), /No task package is loaded\./);
  assert.match(page.text('#wb-mid-body'), /Load a task package to read its files, clauses and changes here\./);
  assert.equal(page.qa('#wb-mid-body button').filter(b => b.textContent === 'Load task package').length, 1, 'the empty state offers its own default button');
  assert.equal(page.qa('#wb-mid-body button.primary').length, 0, 'that button is not a second yellow one');
  page.click('#wb-mid-body button');
  assert.equal(page.state.loadCalls, 1, 'the empty state button opens the existing package picker');
  page.click('#wb-load');
  assert.equal(page.state.loadCalls, 2, 'so does the header primary');
  assert.doesNotMatch(page.root().innerHTML, /style\s*=\s*"/);
  assert.doesNotMatch(page.all(), FORBIDDEN);
  assert.equal(page.q('#wb-files').getAttribute('aria-label'), 'Files');
  assert.match(page.text('#wb-files'), /No files yet/);
});

test('the file edition makes no request, says the companion is needed, and still reads a loaded package', async t => {
  const page = makePage(t, null, { pkg: basePkg(), location: { protocol: 'file:', hostname: '' } });
  await page.mount();
  assert.equal(page.requests.length, 0, 'no request in the file edition');
  assert.match(page.text('#wb-notes'), /Local agents need the companion: run npm start\./);
  assert.match(page.text('#wb-notes'), /Package files, comparisons and imported evaluation results still work/);
  assert.equal(page.q('#wb-run').hasAttribute('disabled'), true, 'the run picker is off');
  assert.match(page.text('#wb-run'), /Not available offline/);
  assert.match(page.text('#wb-drawer-bar'), /Live logs · not available offline/);
  assert.ok(page.file('Facility_Terms.txt'), 'the loaded package is still listed');
  assert.equal(page.primaries().length, 1);
});

test('files: names and role words, a tree with one tab stop, and the changed marker only on the selected file', async t => {
  const { page } = await fullPage(t);
  const tree = page.q('#wb-tree');
  assert.equal(tree.getAttribute('role'), 'tree');
  const names = page.qa('#wb-tree [role="treeitem"]').map(el => (el.querySelector('.wb-fn') || {}).textContent);
  assert.deepEqual(names, ['Atlas_Model.xlsx', 'Big_Log.txt', 'Cash_Facts.csv', 'Facility_Terms.txt', 'Grader_Notes.txt', 'inputs', 'Borealis_Schedule.csv', 'Cobalt_Notes.txt']);
  const role = name => (page.file(name).querySelector('.wb-role') || {}).textContent;
  assert.equal(role('Facility_Terms.txt'), 'Solver');
  assert.equal(role('Grader_Notes.txt'), 'Evaluator-only');
  assert.equal(page.qa('#wb-tree [tabindex="0"]').length, 1, 'roving tabindex: exactly one tab stop');
  assert.equal(page.qa('#wb-tree .wb-fchg').length, 1, 'a change line only on the selected file');
  assert.equal(page.file('Atlas_Model.xlsx').getAttribute('aria-selected'), 'true', 'the first changed file is selected');
  assert.match(page.text('.wb-fchg'), /Changed · 3 cells/);
  page.click(page.file('Cash_Facts.csv'));
  assert.equal(page.qa('#wb-tree .wb-fchg').length, 1);
  assert.match(page.text('.wb-fchg'), /Changed · 1 cell/);
  assert.equal(page.file('Cash_Facts.csv').getAttribute('aria-selected'), 'true');
  assert.equal(page.file('Atlas_Model.xlsx').getAttribute('aria-selected'), 'false');
  assert.equal(page.qa('#wb-tree .wb-fchg').filter(el => /Atlas_Model/.test(el.parentNode.textContent)).length, 0);
  assert.equal(page.qa('#wb-tree [role="treeitem"][aria-level="2"]').length, 2, 'two files sit under the inputs folder');
  assert.doesNotMatch(page.text('#wb-files'), /Changed only/, 'a short list needs no filter');
});

test('source mode: records by locator, a go-to box, and paging of 200 records', async t => {
  const { page } = await fullPage(t);
  page.click(page.file('Facility_Terms.txt'));
  page.click('[data-wb-act="mode"][data-mode="source"]');
  const options = () => page.qa('#wb-recs [role="option"]');
  assert.equal(page.q('#wb-recs').getAttribute('role'), 'listbox');
  assert.equal(options().length, 12, 'twelve records (the blank line is not a record)');
  assert.equal(options()[0].getAttribute('data-wb-loc'), 'Line 1');
  assert.match(rowText(options()[0]), /Line 1\s*Atlas Holdings owes Meridian Partners 2,480 units/);
  page.type('#wb-goto-in', 'Line 5');
  page.click('[data-wb-act="goto"]');
  assert.match(page.text('#wb-goto-msg'), /Showing Line 5/);
  assert.equal(options().find(el => el.getAttribute('data-wb-loc') === 'Line 5').getAttribute('aria-selected'), 'true');
  assert.ok(page.dom.stats.scrolled.length > 0, 'the located record is scrolled into view');
  page.type('#wb-goto-in', 'Line 99');
  page.key('#wb-goto-in', 'Enter');
  assert.match(page.text('#wb-goto-msg'), /No record in this file has the locator Line 99/);

  page.click(page.file('Atlas_Model.xlsx'));
  page.type('#wb-goto-in', 'B3');
  page.click('[data-wb-act="goto"]');
  assert.match(page.text('#wb-goto-msg'), /Showing Bridge!B3/, 'a bare cell reference that exists on one sheet resolves');

  page.click(page.file('Big_Log.txt'));
  assert.equal(options().length, 200, 'a page holds 200 records');
  assert.match(page.text('#wb-mid-body'), /Records 1 to 200 of 450/);
  assert.equal(page.q('[data-wb-act="page-prev"]').hasAttribute('disabled'), true);
  page.click('[data-wb-act="page-next"]');
  assert.match(page.text('#wb-mid-body'), /Records 201 to 400 of 450/);
  assert.equal(options()[0].getAttribute('data-wb-loc'), 'Line 201');
  page.click('[data-wb-act="page-next"]');
  assert.equal(options().length, 50);
  assert.equal(page.q('[data-wb-act="page-next"]').hasAttribute('disabled'), true);
  page.type('#wb-goto-in', 'Line 450');
  page.click('[data-wb-act="goto"]');
  assert.equal(options().find(el => el.getAttribute('data-wb-loc') === 'Line 450').getAttribute('aria-selected'), 'true');
  page.type('#wb-goto-in', 'Line 3');
  page.click('[data-wb-act="goto"]');
  assert.match(page.text('#wb-mid-body'), /Records 1 to 200 of 450/, 'a go-to on another page moves to that page');
});

/* ====================================================================== the middle pane: diff */

test('diff mode on a workbook: changed cells with two rows of context, the decision-changing number marked only where the model says, previous and next', async t => {
  const { page } = await fullPage(t);
  assert.equal(page.file('Atlas_Model.xlsx').getAttribute('aria-selected'), 'true');
  assert.equal(page.q('#wb-mt-diff').getAttribute('aria-selected'), 'true', 'a changed file opens in Diff when a comparison exists');
  const changed = () => page.qa('#wb-mid-body td.wb-changed');
  assert.equal(changed().length, 3, 'a value change, an added cell and a removed cell');
  assert.deepEqual(page.qa('#wb-mid-body tbody th.wb-rn').map(el => el.textContent).filter(Boolean), ['1', '2', '3', '4', '5', '18', '19', '20', '21', '22', '98', '99', '100', '101', '102'], 'two rows of context on each side of every change');
  assert.match(page.text('#wb-mid-body'), /12 rows not shown/);
  const b3 = page.q('#wb-mid-body td[data-wb-loc="Bridge!B3"]');
  assert.match(rowText(b3), /Bridge!B3, Value changed\. Before: 100\s*→\s*Now: Decision-changing: 150/);
  const marks = page.qa('#wb-mid-body mark.wb-decision');
  assert.equal(marks.length, 1, 'exactly one decision-changing number');
  assert.equal(marks[0].textContent, '150');
  assert.equal(marks[0].querySelector('b').textContent, '150', 'bold as well as marked');
  assert.ok(b3.contains(marks[0]));
  assert.equal((page.text('#wb-mid-body').match(/Decision-changing:/g) || []).length, 1);
  assert.match(rowText(page.q('#wb-mid-body td[data-wb-loc="Bridge!B20"]')), /Added: 5/);
  assert.match(rowText(page.q('#wb-mid-body td[data-wb-loc="Bridge!B100"]')), /Removed: 9/);
  assert.equal(page.qa('#wb-mid-body .wb-dt').length, 1, 'one sheet has changes, so one table');
  assert.match(page.text('#wb-mid-body'), /Bridge/);
  assert.equal(page.q('[data-wb-act="prev-change"]').hasAttribute('disabled'), true);
  assert.match(page.text('#wb-chg-count'), /3 changed cells/);
  page.click('[data-wb-act="next-change"]');
  assert.match(page.text('#wb-chg-count'), /Change 1 of 3/);
  assert.equal(changed().filter(td => td.getAttribute('class').includes('is-current')).length, 1);
  assert.equal(page.q('td.is-current').getAttribute('data-wb-loc'), 'Bridge!B3');
  page.click('[data-wb-act="next-change"]');
  assert.equal(page.q('td.is-current').getAttribute('data-wb-loc'), 'Bridge!B20');
  assert.equal(page.q('[data-wb-act="prev-change"]').hasAttribute('disabled'), false);
  page.click('[data-wb-act="next-change"]');
  assert.equal(page.q('td.is-current').getAttribute('data-wb-loc'), 'Bridge!B100');
  assert.equal(page.q('[data-wb-act="next-change"]').hasAttribute('disabled'), true, 'no wrap at the end');
  page.click('[data-wb-act="prev-change"]');
  assert.equal(page.q('td.is-current').getAttribute('data-wb-loc'), 'Bridge!B20');
  assert.equal(page.qa('#wb-mid-body button.wb-chg').filter(b => b.getAttribute('tabindex') === '0').length, 1, 'one tab stop among the changed cells');
  assert.match(page.text('#wb-status'), /Change 2 of 3/);
});

test('without a project there is no decision-changing mark at all: the highlight needs the model to say so', async t => {
  const { page } = await fullPage(t, { project: false });
  assert.equal(page.qa('#wb-mid-body td.wb-changed').length, 3);
  assert.equal(page.qa('mark').length, 0);
  assert.doesNotMatch(page.all(), /Decision-changing/);
});

test('diff mode on a text file: added and removed lines with spoken labels, and unchanged runs collapsed until asked for', async t => {
  const { page } = await fullPage(t);
  page.click(page.file('Facility_Terms.txt'));
  assert.equal(page.q('#wb-mt-diff').getAttribute('aria-selected'), 'true');
  const rows = () => page.qa('#wb-recs [role="option"]');
  const del = page.q('#wb-recs .wb-ln.is-del'), add = page.q('#wb-recs .wb-ln.is-add');
  assert.match(rowText(del), /Removed: Facility limit is 2,000 units/);
  assert.match(rowText(add), /Added: Facility limit is 3,000 units/);
  assert.equal(page.qa('#wb-recs .wb-ln.is-equal').length, 1, 'only the head line is shown while the unchanged run is collapsed');
  const gap = page.q('#wb-recs .wb-collapsed');
  assert.match(rowText(gap), /10 unchanged lines hidden\. Press Enter to show them\./);
  assert.match(rowText(rows()[0]), /Unchanged: Atlas Holdings owes Meridian Partners 2,480 units/);
  page.click(gap);
  assert.equal(page.qa('#wb-recs .wb-ln.is-equal').length, 11, 'the ten lines are now shown (and line 1)');
  assert.equal(page.qa('#wb-recs .wb-collapsed').length, 0);
  assert.equal(page.q('#wb-recs').getAttribute('role'), 'listbox');
  assert.match(page.text('#wb-chg-count'), /1 change/);
  assert.equal(page.qa('mark').length, 0, 'a text change is never marked as decision-changing');
});

test('the Diff tab is aria-disabled with its reason when there is no comparison; Source still works', async t => {
  const { page } = await fullPage(t, { pair: false });
  const diffTab = page.q('#wb-mt-diff');
  assert.equal(diffTab.getAttribute('aria-disabled'), 'true');
  assert.equal(diffTab.getAttribute('aria-describedby'), 'wb-diff-why');
  assert.match(page.text('#wb-diff-why'), /^Diff needs a changed package\. Compare with a changed package$/);
  assert.equal(page.qa('#wb-diff-why [data-wb-act="compare-load"]').length, 1, 'the control that fixes it is right there');
  assert.equal(page.q('#wb-mt-source').getAttribute('aria-selected'), 'true');
  page.click(diffTab);
  assert.equal(page.q('#wb-mt-source').getAttribute('aria-selected'), 'true', 'a click on the disabled tab changes nothing');
  assert.match(page.text('#wb-status'), /Diff needs a changed package/);
  assert.equal(page.qa('#wb-recs [role="option"]').length > 0, true);
  assert.equal(page.qa('#wb-tree .wb-fchg').length, 0, 'no change marker without a comparison');
  assert.match(page.text('#wb-card'), /^Choose a criterion/);
  page.click(page.qa('#wb-crit [role="option"]')[0]);
  assert.match(page.text('#wb-card'), /Load a changed package to see which cells changed/);
});

/* ====================================================================== the right pane: criteria and the evidence card */

test('criteria say Met, Not met and Unknown with a glyph and a basis; Not met only ever comes from the allowed bases', async t => {
  const { page } = await fullPage(t);
  const rows = page.qa('#wb-crit [role="option"]');
  assert.equal(rows.length, 5);
  for (const row of rows) assert.ok(row.getAttribute('aria-selected') === 'true' || row.getAttribute('aria-selected') === 'false');
  const by = (text, status) => rows.find(r => rowText(r).includes(text) && rowText(r).includes(status));
  assert.match(rowText(by('Usable cash', 'Met')), /✓\s*MetUsable cashFound in the final answer \(text search\)/);
  assert.match(rowText(by('Requested draw', 'Not met')), /✕\s*Not metRequested drawNot found in the answer or outputs \(text search\)/);
  assert.match(rowText(by('Facility headroom', 'Not met')), /Not found in the answer or outputs/);
  const unknown = rows.filter(r => /Unknown/.test(rowText(r)));
  assert.equal(unknown.length, 2);
  for (const u of unknown) assert.match(rowText(u), /No basis to decide yet/, 'no guess: an unpaired criterion stays Unknown');
  for (const r of rows.filter(r => /Not met/.test(rowText(r)))) assert.match(rowText(r), /Not found in the answer or outputs \(text search\)|Marked in the evaluation text|Your recorded verdict/);
  assert.match(page.text('#wb-evid-head'), /2 Not met.*1 Met.*2 Unknown/);
  assert.doesNotMatch(page.all(), /failed/i, 'failed is for process state only; criteria say Not met');
  assert.doesNotMatch(page.all(), FORBIDDEN);
  /* the Not met only toggle */
  const toggle = page.q('[data-wb-act="only-not-met"]');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  page.click(toggle);
  assert.equal(page.q('[data-wb-act="only-not-met"]').getAttribute('aria-pressed'), 'true');
  assert.equal(page.qa('#wb-crit [role="option"]').length, 2);
  assert.ok(page.qa('#wb-crit [role="option"]').every(r => /Not met/.test(rowText(r))));
  assert.match(page.text('#wb-evid-head'), /2 Not met.*1 Met.*2 Unknown/, 'the counts do not change with the filter');
  assert.equal(JSON.parse(page.storage.getItem('fts.wb.v1')).notMet, true, 'the choice is a layout setting and is kept');
  page.click('[data-wb-act="only-not-met"]');
  assert.equal(page.qa('#wb-crit [role="option"]').length, 5);
});

test('selecting a criterion puts the source clause, the changed cell and the solver conclusion together and marks the clause in the middle pane', async t => {
  const { page } = await fullPage(t);
  const bridge = page.qa('#wb-crit [role="option"]').find(r => /Cash bridge/.test(rowText(r)));
  page.click(bridge);
  assert.equal(bridge.getAttribute('aria-selected'), 'true');
  const card = page.text('#wb-card');
  assert.match(card, /Task output/);
  assert.match(card, /Cash bridge/);
  assert.match(card, /Source clause/);
  assert.match(card, /Atlas Holdings owes Meridian Partners 2,480 units/, 'the clause quote');
  assert.match(card, /Facility_Terms\.txt · Line 1/, 'the file and the locator');
  assert.match(card, /The quote matches the source text\./, 'the excerpt flag');
  assert.match(card, /Changed cell/);
  assert.match(card, /Atlas_Model\.xlsx · Bridge!B3/);
  assert.match(card, /100.*→.*now.*Decision-changing: 150/);
  assert.match(card, /Solver conclusion/);
  assert.match(card, /No frozen figure is paired with this output\./);
  assert.match(card, /Completed, audit CLEAN/);
  assert.match(card, /Suggested verdict: Unclear \(a text search, not grading\)/);
  const parts = page.qa('#wb-card section.wb-part');
  assert.equal(parts.length, 3, 'three parts: clause, changed cell, solver conclusion');
  assert.equal(page.qa('#wb-card section.wb-part').every(p => !/border/.test(p.getAttribute('class') || '')), true);
  /* the clause is marked in the middle pane with the chip */
  assert.equal(page.file('Facility_Terms.txt').getAttribute('aria-selected'), 'true', 'the clause file is opened');
  const linked = page.qa('#wb-recs .is-linked').map(el => el.getAttribute('data-wb-loc'));
  assert.ok(linked.includes('Line 1'), 'the exact locator is outlined: ' + linked);
  assert.equal(page.q('#wb-chip').hasAttribute('hidden'), false);
  assert.equal(page.text('#wb-chip'), 'Linked: Cash bridge');
  /* no repaint: choosing another criterion and coming back only toggles marks on the same nodes */
  const nodes = page.qa('#wb-recs [role="option"]');
  page.click(page.qa('#wb-crit [role="option"]').find(r => /Usable cash/.test(rowText(r))));
  assert.equal(page.qa('#wb-recs .is-linked').length, 0, 'the mark is gone with the criterion');
  assert.equal(page.q('#wb-chip').hasAttribute('hidden'), true);
  assert.ok(nodes.every((n, i) => page.qa('#wb-recs [role="option"]')[i] === n), 'the same row nodes: the pane was not repainted');
  page.click(page.qa('#wb-crit [role="option"]').find(r => /Cash bridge/.test(rowText(r))));
  assert.ok(nodes.every((n, i) => page.qa('#wb-recs [role="option"]')[i] === n), 'still the same row nodes');
  assert.ok(page.qa('#wb-recs .is-linked').length > 0);
});

test('a clause that does not resolve stays unresolved: the reason is shown and no quote is invented', async t => {
  const { page } = await fullPage(t);
  const headroomOutput = page.qa('#wb-crit [role="option"]').find(r => /Facility headroom/.test(rowText(r)) && /Unknown/.test(rowText(r)));
  page.click(headroomOutput);
  const card = page.text('#wb-card');
  assert.match(card, /Not resolved\./);
  assert.match(card, /This is not a locator the package uses/);
  assert.match(card, /Facility_Terms\.txt · Clause 4\.2/);
  assert.equal(page.qa('#wb-card blockquote.wb-quote').length, 0, 'no quote for a clause that did not resolve');
  assert.equal(page.qa('#wb-card .wb-unres').length, 1);
  assert.equal(page.qa('#wb-card button.wb-where').length, 0, 'an unresolved clause is not a link to a record');
  assert.equal(page.q('#wb-chip').hasAttribute('hidden'), true, 'nothing is marked in the middle pane for it');
  assert.equal(page.qa('#wb-recs .is-linked').length, 0);
});

test('a text-match suggestion is labelled as unconfirmed and never changes the status or marks the middle pane', async t => {
  const { page } = await fullPage(t);
  const row = page.qa('#wb-crit [role="option"]').find(r => /Requested draw/.test(rowText(r)));
  page.click(row);
  const card = page.text('#wb-card');
  assert.match(card, /✕ Not met/);
  assert.match(card, /No source clause is linked to this criterion\./);
  assert.match(card, /Suggested by a text match, not confirmed\. A suggestion never changes the status\./);
  assert.match(card, /Atlas Holdings owes Meridian Partners 2,480 units/);
  assert.match(card, /Unconfirmed: this never changes the status\./);
  assert.match(rowText(page.qa('#wb-crit [role="option"]').find(r => /Requested draw/.test(rowText(r)))), /Not met/, 'the status is unchanged');
  assert.equal(page.qa('#wb-recs .is-linked').length, 0, 'a suggestion is not outlined as a link');
  assert.equal(page.q('#wb-chip').hasAttribute('hidden'), true);
  assert.equal(page.qa('#wb-card .wb-sugg').length, 1);
  assert.equal(page.q('#wb-card [data-wb-act="link-clause"]').getAttribute('aria-disabled'), 'true', 'nothing is selected to link yet');
});

test('Link clause stores an author link for the criterion and the selected record, survives a reload, and can be removed', async t => {
  const storage = makeStorage();
  const { page } = await fullPage(t, { storage });
  page.click(page.qa('#wb-crit [role="option"]').find(r => /Requested draw/.test(rowText(r))));
  page.click('[data-wb-act="link-clause"]');
  assert.match(page.text('#wb-status'), /Select a record in the middle pane first/);
  assert.equal(storage.getItem('fts.links.v1'), null, 'nothing is stored without a record');
  /* choose the record: Source mode of the facts file, the Requested draw row */
  page.click(page.file('Cash_Facts.csv'));
  page.click('[data-wb-act="mode"][data-mode="source"]');
  const rec = page.qa('#wb-recs [role="option"]').find(el => el.getAttribute('data-wb-loc') === 'Row 4');
  page.click(rec);
  assert.equal(page.qa('#wb-recs [role="option"]').find(el => el.getAttribute('data-wb-loc') === 'Row 4').getAttribute('aria-selected'), 'true');
  assert.equal(page.q('#wb-card [data-wb-act="link-clause"]').hasAttribute('aria-disabled'), false, 'a record is selected, so the button is live');
  page.click('[data-wb-act="link-clause"]');
  const stored = JSON.parse(storage.getItem('fts.links.v1'));
  assert.equal(stored.length, 1);
  assert.deepEqual(Object.keys(stored[0]).sort(), ['criterionId', 'documentName', 'linkedAt', 'locator', 'sha256', 'taskKey']);
  assert.equal(stored[0].taskKey, 'atlas');
  assert.equal(stored[0].criterionId, 'figure:requested-draw');
  assert.equal(stored[0].documentName, 'Cash_Facts.csv');
  assert.equal(stored[0].locator, 'Row 4');
  assert.match(stored[0].sha256, /^[0-9a-f]{64}$/);
  assert.match(page.text('#wb-status'), /Linked Cash_Facts\.csv, Row 4 to this criterion/);
  const card = page.text('#wb-card');
  assert.match(card, /Requested draw \| 2,480/, 'the linked clause is shown with its quote');
  assert.match(card, /Cash_Facts\.csv · Row 4/);
  assert.match(card, /Linked by you/);
  assert.match(card, /Remove link/);
  assert.ok(page.qa('#wb-recs .is-linked').some(el => el.getAttribute('data-wb-loc') === 'Row 4'), 'the record is outlined as linked');
  assert.match(rowText(page.qa('#wb-crit [role="option"]').find(r => /Requested draw/.test(rowText(r)))), /Not met/, 'a link never changes the status');
  /* a new page with the same storage: the link is still there */
  const again = await fullPage(t, { storage });
  assert.match(again.page.text('#wb-card'), /^Choose a criterion/, 'a fresh page shows the list; the card opens on a choice');
  again.page.click(again.page.qa('#wb-crit [role="option"]').find(r => /Requested draw/.test(rowText(r))));
  assert.match(again.page.text('#wb-card'), /Linked by you/);
  assert.match(again.page.text('#wb-card'), /Cash_Facts\.csv · Row 4/);
  assert.equal(again.page.file('Cash_Facts.csv').getAttribute('aria-selected'), 'true', 'the linked file opens');
  /* remove it */
  again.page.click(again.page.q('#wb-card [data-wb-act="unlink"]'));
  assert.deepEqual(JSON.parse(storage.getItem('fts.links.v1')), []);
  assert.doesNotMatch(again.page.text('#wb-card'), /Linked by you/);
});

/* ====================================================================== runs, the pending selection, the log drawer */

const STUDIO_REASONING = ['Lead paragraph about Borealis.', '', '**Inputs**', '- PASS Used the funded draw (invented bullet)', '- FAIL Counted the facility as cash (invented bullet)', '- Checked the dates (no token)', '', '**Outputs:**', '* ✓ Bridge figure stated', '* ✗ Headroom missing', '* NOT MET Reserve not shown', '', 'Trailing summary paragraph.'].join('\n');
const STUDIO_GRADING = () => ({ grading_runs: [{ grading_run_id: 'gr-qa-1', final_score: 0.5, scoring_method: 'rubric', grading_run_status: 'completed', judge: { llm_model: { provider: 'qa-provider', model: 'qa-judge' } }, judge_grades: [{ verifier_result_values: { problem_run_id: 'pr-qa-1' } }] }], trajectory_output: { attempt_number: 2, final_score: 0.5, problem_run_id: 'pr-qa-1', rewards: [{ subscores: [{ name: 'overall', score: 0.5, max_score: 1, weight: 1, reasoning: STUDIO_REASONING, grading_criteria: null }] }] } });
const STUDIO_MESSAGES = () => [{ role: 'assistant', content: 'Checking the bridge.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'python bridge.py' }) } }] }, { role: 'tool', tool_call_id: 'c1', content: 'bridge 1200' }, { role: 'assistant', content: 'Imported final answer: the bridge is 1,200.' }];

test('the run picker lists every pilot with its round and state, and choosing one reads that run', async t => {
  const { page, roundId } = await fullPage(t);
  const run = page.q('#wb-run');
  assert.equal(run.getAttribute('aria-label'), null, 'the picker is named by its visible label');
  assert.match(page.text('#wb-runblock'), /Run/);
  assert.equal(page.q('#wb-runblock label').getAttribute('for'), 'wb-run', 'a visible label names the picker');
  assert.ok(page.q('#wb-evid').contains(page.q('#wb-run')), 'the run picker is in the evidence pane');
  const options = page.qa('#wb-run option').map(o => ({ value: o.getAttribute('value'), text: o.textContent }));
  assert.deepEqual(options.map(o => o.text), ['No run selected', 'Atlas round 1 · Pilot 1 · Completed']);
  assert.equal(options[1].value, roundId + ':1');
  assert.equal(page.qa('#wb-run option').find(o => o.getAttribute('value') === roundId + ':1').hasAttribute('selected'), true, 'the newest completed run is chosen on arrival');
  page.choose('#wb-run', '');
  await page.settle();
  assert.match(page.text('#wb-solver'), /No answer to show/);
  assert.match(page.text('#wb-drawer-bar'), /no run selected/);
  const before = page.requests.length;
  page.choose('#wb-run', roundId + ':1');
  await waitFor(() => /Usable cash is 1,250/.test(page.text('#wb-solver')), { label: 'the run to load' });
  const urls = page.requests.slice(before).map(r => r.url);
  assert.ok(urls.some(u => u === `/api/agents/rounds/${roundId}`), urls.join());
  assert.ok(urls.some(u => u === `/api/agents/rounds/${roundId}/runs/1`), urls.join());
  assert.ok(urls.every(u => u.startsWith('/api/')), 'only /api/ paths are requested');
  assert.match(page.text('#wb-solver'), /Usable cash is 1,250\. Hold the borrowing\./);
  page.click('[data-wb-act="solver-tab"][data-tab="conclusion"]');
  assert.match(page.text('#wb-solver'), /State\s*Completed\s*Audit\s*CLEAN\s*Suggested verdict\s*Unclear/);
  assert.equal(page.q('#wb-sv-conclusion').getAttribute('aria-selected'), 'true');
  assert.equal(page.q('#wb-sv-answer').getAttribute('aria-selected'), 'false');
});

test('FinanceWorkbench.open records a pending run and criterion that the next paint applies; bad input is refused', async t => {
  const w = await finishedWorld(t);
  const page = makePage(t, w, { pkg: candPkg(), pair: { baseline: basePkg(), candidate: candPkg() }, project: PROJECT() });
  assert.equal(page.WB.open(null), false);
  assert.equal(page.WB.open({ roundId: 'x', n: 1 }), false, 'a round id has at least four characters');
  assert.equal(page.WB.open({ roundId: w.roundId, n: 0 }), false);
  assert.equal(page.WB.open({ roundId: w.roundId, n: 1.5 }), false);
  assert.equal(page.WB.open({ roundId: '../etc/passwd', n: 1 }), false);
  assert.equal(page.WB.open({ roundId: w.roundId, n: 1, criterionId: 'figure:facility-headroom' }), true);
  await page.mount();
  await waitFor(() => page.qa('#wb-crit [role="option"][aria-selected="true"]').length === 1, { label: 'the criterion to be selected' });
  assert.match(page.text('#wb-card'), /Facility headroom/);
  assert.match(page.text('#wb-card'), /Not met/);
  assert.equal(page.qa('#wb-crit').length, 1);
  assert.equal(page.q('#wb-crit').hasAttribute('hidden'), true, 'a criterion asked for by name opens its card, so the list steps aside');
  assert.equal(page.qa('#wb-run').length, 0, 'and so does the run picker');
  page.click('[data-wb-act="crit-back"]');
  assert.equal(page.qa('#wb-run option').find(o => o.getAttribute('value') === w.roundId + ':1').hasAttribute('selected'), true);
  /* a request for a run the companion does not have */
  assert.equal(page.WB.open({ roundId: 'rnd-000000000000', n: 1 }), true);
  page.rerender();
  await waitFor(() => /That run is not in the run list of this companion\./.test(page.text('#wb-notes')), { label: 'the notice' });
  assert.equal(page.qa('#wb-run option').find(o => o.getAttribute('value') === w.roundId + ':1').hasAttribute('selected'), true, 'the earlier selection stays');
});

test('the log drawer starts collapsed as a 48px summary bar and opens on a click; its parts carry the right roles', async t => {
  const { page } = await fullPage(t);
  const drawer = page.q('#wb-drawer');
  assert.equal(drawer.getAttribute('role'), 'region');
  assert.equal(drawer.getAttribute('aria-label'), 'Live logs');
  assert.match(drawer.getAttribute('class'), /\bstep-0\b/, 'collapsed');
  assert.match(page.text('#wb-drawer-bar'), /Live logs · 2 lines · Follow tail on/);
  const toggle = page.q('[data-wb-act="drawer-toggle"]');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-controls'), 'wb-log');
  const log = page.q('#wb-log');
  assert.equal(log.getAttribute('role'), 'log');
  assert.equal(log.getAttribute('aria-live'), 'off');
  const sep = page.q('#wb-splitter');
  assert.equal(sep.getAttribute('role'), 'separator');
  assert.equal(sep.getAttribute('aria-orientation'), 'horizontal');
  assert.equal(sep.getAttribute('aria-valuenow'), '0');
  assert.equal(sep.getAttribute('aria-valuemax'), '5');
  assert.equal(page.qa('[data-wb-act="follow"]').length, 0, 'the log actions show only while it is open');
  page.click(toggle);
  assert.match(page.q('#wb-drawer').getAttribute('class'), /\bstep-2\b/);
  assert.equal(page.q('[data-wb-act="drawer-toggle"]').getAttribute('aria-expanded'), 'true');
  assert.equal(page.q('#wb-splitter').getAttribute('aria-valuenow'), '2');
  assert.equal(page.q('[data-wb-act="follow"]').getAttribute('aria-pressed'), 'true');
  const lines = page.qa('#wb-log .wb-ll').map(el => [el.querySelector('.wb-ll-n').textContent, el.querySelector('.wb-ll-k').textContent, el.querySelector('.wb-ll-x').textContent]);
  assert.deepEqual(lines, [['1', 'init', 'Session started with model claude-opus-5-5.'], ['2', 'result', 'Usable cash is 1,250. Hold the borrowing.']], 'the lines: number, kind, text');
  assert.doesNotMatch(drawer.innerHTML, /style\s*=\s*"/);
  /* six step classes by keyboard, no other way to size it */
  page.q('#wb-splitter').focus();
  const step = () => (page.q('#wb-drawer').getAttribute('class').match(/step-(\d)/) || [])[1];
  page.key('#wb-splitter', 'ArrowUp'); assert.equal(step(), '3');
  page.key('#wb-splitter', 'PageUp'); assert.equal(step(), '5');
  page.key('#wb-splitter', 'ArrowUp'); assert.equal(step(), '5', 'no further than the largest');
  page.key('#wb-splitter', 'ArrowDown'); assert.equal(step(), '4');
  page.key('#wb-splitter', 'Home'); assert.equal(step(), '0');
  assert.equal(page.q('[data-wb-act="drawer-toggle"]').getAttribute('aria-expanded'), 'false');
  page.key('#wb-splitter', 'Enter'); assert.equal(step(), '4', 'Enter opens it again at the last size');
  page.key('#wb-splitter', 'Escape'); assert.equal(step(), '4', 'Escape does not collapse it');
  page.key('#wb-splitter', 'End'); assert.equal(step(), '5');
  page.key('#wb-splitter', ' '); assert.equal(step(), '0', 'Space collapses');
  assert.equal(JSON.parse(page.storage.getItem('fts.wb.v1')).restore, 5, 'the size is a layout setting; the open state is not kept');
  /* Follow, Clear, Copy */
  page.click('[data-wb-act="drawer-toggle"]');
  page.click('[data-wb-act="follow"]');
  assert.equal(page.q('[data-wb-act="follow"]').getAttribute('aria-pressed'), 'false');
  assert.match(page.text('#wb-drawer-bar'), /Follow tail off/);
  page.click('[data-wb-act="log-copy"]');
  await waitFor(() => page.clip.length > 0, { label: 'the clipboard' });
  assert.equal(page.clip[0], 'init Session started with model claude-opus-5-5.\nresult Usable cash is 1,250. Hold the borrowing.');
  page.click('[data-wb-act="log-clear"]');
  assert.equal(page.qa('#wb-log .wb-ll').length, 0);
  assert.match(page.text('#wb-drawer-bar'), /0 lines/);
});

test('the log keeps a ring of 2000 lines and draws at most 500; Follow tail follows until the reader scrolls away; no polling once the run is done', async t => {
  const w = await makeWorld(t, { resultText: ANSWER });
  const roundId = await seedRound(w);
  const transcript = path.join(w.projectRoot, 'private', 'agent-rounds', roundId, 'runs', '1', 'transcript.jsonl');
  const lines = Array.from({ length: 2300 }, (_, i) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'synthetic line ' + (i + 1) }] } }));
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
  const page = makePage(t, w, { pkg: candPkg(), pair: { baseline: basePkg(), candidate: candPkg() }, project: PROJECT() });
  await page.mount();
  await waitFor(() => /200\+ lines/.test(page.text('#wb-drawer-bar')), { label: 'the first page' });
  const logRequests = () => page.requests.filter(r => r.url.includes('/log?')).map(r => r.url);
  assert.equal(logRequests().length, 1, 'collapsed, only one page is read, to count the lines');
  assert.ok(logRequests()[0].endsWith('/log?after=0&limit=200'));
  assert.equal(page.qa('#wb-log .wb-ll').length, 200);
  page.click('[data-wb-act="drawer-toggle"]');
  await waitFor(() => /2,300 lines/.test(page.text('#wb-drawer-bar')), { label: 'every page' });
  await page.settle();
  const rows = () => page.qa('#wb-log .wb-ll');
  assert.equal(rows().length, 500, 'at most 500 lines are in the DOM');
  const seqs = rows().map(r => Number(r.querySelector('.wb-ll-n').textContent));
  assert.equal(seqs[0], 1801);
  assert.equal(seqs[seqs.length - 1], 2300);
  assert.match(rows()[499].textContent, /synthetic line 2300/);
  assert.equal(rows().filter(r => /synthetic line 1800$/.test(r.textContent)).length, 0, 'older lines were dropped');
  assert.deepEqual(logRequests().slice(-1)[0].match(/after=(\d+)/)[1], '2200', 'pages follow the cursor');
  assert.equal(logRequests().length, 12, 'twelve pages of 200 for 2300 lines');
  /* the whole 2300 lines are never all held: the copy is the 500 that are drawn */
  page.click('[data-wb-act="log-copy"]');
  await waitFor(() => page.clip.length > 0, { label: 'the clipboard' });
  assert.equal(page.clip[0].split('\n').length, 500);
  /* done: nothing more is requested */
  const settled = logRequests().length;
  await sleep(2600);
  assert.equal(logRequests().length, settled, 'no polling for a run that is done');
  /* Follow tail: new rows keep the end in view; scrolling up turns it off */
  const log = page.q('#wb-log');
  log.scrollHeight = 5000; log.clientHeight = 300; log.scrollTop = 0;
  page.click('[data-wb-act="follow"]');
  assert.equal(page.q('[data-wb-act="follow"]').getAttribute('aria-pressed'), 'false');
  page.click('[data-wb-act="follow"]');
  assert.equal(page.q('#wb-log').scrollTop, 5000, 'turning it on scrolls to the end');
  page.q('#wb-log').scrollTop = 1000;
  page.q('#wb-log').fire('scroll');
  assert.equal(page.q('[data-wb-act="follow"]').getAttribute('aria-pressed'), 'false', 'scrolling up from the end turns it off');
  assert.match(page.text('#wb-drawer-bar'), /Follow tail off/);
});

test('while a round runs every detail is withheld, the log shows kinds only, polling goes on while the drawer is open and the tab visible, and the details return when the round ends', async t => {
  const w = await makeWorld(t, { resultText: ANSWER });
  const finished = await seedRound(w);
  w.scenario({ hang: true });
  const running = await seedRound(w, { label: 'Borealis round 1', task: 'Borealis', wait: false });
  await waitFor(async () => (await w.service.getRound(running)).runs.some(r => r.state === 'running'), { label: 'a pilot to be running' });
  const page = makePage(t, w, { pkg: candPkg(), pair: { baseline: basePkg(), candidate: candPkg() }, project: PROJECT() });
  await page.mount();
  await waitFor(() => page.qa('#wb-run option').length >= 3, { label: 'both rounds' });
  /* the finished run, read while the other round runs: withheld, never blank */
  page.choose('#wb-run', finished + ':1');
  await waitFor(() => /Details withheld while a round runs/.test(page.text('#wb-notes')), { label: 'the banner' });
  await page.settle();
  const all = page.all();
  assert.match(page.text('#wb-solver'), /Details withheld while a round runs\./);
  assert.doesNotMatch(all, /Usable cash is 1,250|Synthetic gold|Hold the borrowing/, 'no answer text');
  assert.doesNotMatch(page.text('#wb-crit'), /Usable cash|Requested draw/, 'the frozen figures are not listed while they are withheld');
  const rows = page.qa('#wb-crit [role="option"]');
  assert.ok(rows.length > 0, 'the list is not blank: the task outputs are still there');
  for (const r of rows) assert.match(rowText(r), /Unknown.*Details withheld while a round runs/, 'every criterion is Unknown');
  page.click(rows[0]);
  assert.match(page.text('#wb-card'), /Details withheld while a round runs\./, 'the opened card says it too, never blank');
  assert.doesNotMatch(page.text('#wb-card'), /Usable cash|1,250|Synthetic gold|Hold the borrowing/, 'no gold figure and no answer text');
  page.click('[data-wb-act="crit-back"]');
  assert.equal(page.qa('#wb-notes p').length > 0, true);
  page.click('[data-wb-act="solver-tab"][data-tab="conclusion"]');
  assert.match(page.text('#wb-solver'), /Details withheld while a round runs\./);
  assert.match(page.text('#wb-drawer-bar'), /kinds only while a round runs/);
  /* the log of the running pilot: kinds and tool names only */
  page.choose('#wb-run', running + ':1');
  await waitFor(() => page.qa('#wb-log .wb-ll').length > 0, { label: 'the running pilot log' });
  page.click('[data-wb-act="drawer-toggle"]');
  await waitFor(() => /Details withheld while a round runs: only the kind and tool name of each line are shown\./.test(page.text('#wb-log-note')), { label: 'the log note' });
  for (const row of page.qa('#wb-log .wb-ll')) assert.equal(row.querySelector('.wb-ll-x').textContent === '' || /^\d+ characters?$/.test(row.querySelector('.wb-ll-x').textContent), true, 'no text: ' + row.textContent);
  assert.doesNotMatch(page.q('#wb-log').textContent, /Session started/);
  /* polling while open and visible, not while hidden */
  const logRequests = () => page.requests.filter(r => r.url.includes('/log?')).length;
  const n0 = logRequests();
  await waitFor(() => logRequests() >= n0 + 2, { timeout: 8000, label: 'polling' });
  page.document.hidden = true;
  await sleep(300);
  const hiddenAt = logRequests();
  await sleep(2600);
  assert.equal(logRequests(), hiddenAt, 'no polling in a hidden tab');
  page.document.hidden = false;
  (page.document._listeners.visibilitychange || []).forEach(fn => fn({ type: 'visibilitychange' }));
  await waitFor(() => logRequests() > hiddenAt, { timeout: 6000, label: 'polling again once visible' });
  page.click('[data-wb-act="drawer-toggle"]');
  await sleep(300);
  const closedAt = logRequests();
  await sleep(2600);
  assert.equal(logRequests(), closedAt, 'no polling while the drawer is closed');
  /* the round ends: the end is announced, and the details come back without a reload */
  page.choose('#wb-run', running + ':1');
  await page.settle();
  await w.service.cancelRound(running);
  await w.service.whenSettled(running);
  await waitFor(() => /Borealis round 1 · Pilot 1 cancelled\./.test(page.text('[data-views-live="polite"]')), { timeout: 15000, label: 'the announcement' });
  assert.equal(page.q('[data-views-live="polite"]').getAttribute('role'), 'status');
  page.choose('#wb-run', finished + ':1');
  await waitFor(() => { page.click('[data-wb-act="solver-tab"][data-tab="answer"]'); return /Usable cash is 1,250\. Hold the borrowing\./.test(page.text('#wb-solver')); }, { timeout: 15000, label: 'the details to return' });
  assert.doesNotMatch(page.text('#wb-notes'), /Details withheld/);
  assert.match(page.text('#wb-crit'), /Usable cash/);
});

/* ====================================================================== an imported evaluation result */

test('an imported evaluation: parsed in memory, only the score record is stored, explicit tokens are the only way an item becomes Met or Not met', async t => {
  const storage = makeStorage();
  const { page } = await fullPage(t, { storage });
  const before = page.qa('#wb-crit [role="option"]').length;
  page.click('[data-wb-act="import-open"]');
  assert.equal(page.q('[data-wb-act="import-open"]').getAttribute('aria-expanded'), 'true');
  assert.match(page.text('#wb-import'), /Nothing is uploaded\. Only the score record is kept in this browser\./);
  assert.equal(page.q('[data-wb-act="import-go"]').getAttribute('aria-disabled'), 'true', 'nothing to import yet');
  /* a file that is not JSON, then one with the wrong shape */
  page.click('[data-wb-act="import-grading"]');
  let input = page.dom.pickers[page.dom.pickers.length - 1];
  assert.equal(input.accept.includes('.json'), true);
  input.files = [file('broken.json', 'not json {')]; input.fire('change');
  await waitFor(() => /That file is not valid JSON\./.test(page.text('#wb-import')), { label: 'the JSON error' });
  assert.equal(page.q('#wb-import [role="alert"]').textContent, 'That file is not valid JSON.');
  page.click('[data-wb-act="import-grading"]');
  input = page.dom.pickers[page.dom.pickers.length - 1];
  input.files = [file('wrong.json', JSON.stringify({ hello: 'world' }))]; input.fire('change');
  await waitFor(() => /grading_runs/.test(page.text('#wb-import')), { label: 'the shape error' });
  assert.equal(storage.getItem('fts.evals.v1'), null, 'nothing is stored for a bad file');
  /* the real thing */
  page.click('[data-wb-act="import-grading"]');
  input = page.dom.pickers[page.dom.pickers.length - 1];
  input.files = [file('grading_results.json', JSON.stringify(STUDIO_GRADING()))]; input.fire('change');
  await waitFor(() => /grading_results\.json/.test(page.text('#wb-import')), { label: 'the file name' });
  page.click('[data-wb-act="import-messages"]');
  input = page.dom.pickers[page.dom.pickers.length - 1];
  input.files = [file('solver_messages.json', JSON.stringify(STUDIO_MESSAGES()))]; input.fire('change');
  await waitFor(() => /solver_messages\.json/.test(page.text('#wb-import')), { label: 'the messages file' });
  assert.equal(page.qa('#wb-import .wb-err').length, 0);
  assert.equal(page.text('#wb-import-facts'), 'Read: score 0.5 / 1, run gr-qa-1, 6 items listed.', 'what was read is said before anything is recorded');
  assert.ok(page.q('#wb-evid').contains(page.q('#wb-import')), 'the panel is in the evidence pane');
  assert.equal(page.q('#wb-import-task').getAttribute('aria-required'), 'true');
  page.click('[data-wb-act="import-go"]');
  assert.equal(page.q('#wb-import [role="alert"]').textContent, 'Type the task name this result belongs to.', 'the task name is required, as in Mission Control');
  assert.equal(page.q('#wb-import-task').getAttribute('aria-describedby'), 'wb-import-err', 'and the field points at its error');
  assert.ok(page.document.activeElement === page.q('#wb-import-task'), 'focus goes to the field that needs it');
  assert.equal(storage.getItem('fts.evals.v1'), null, 'nothing is recorded without a task');
  page.type('#wb-import-task', 'Atlas');
  assert.equal(page.q('[data-wb-act="import-go"]').hasAttribute('aria-disabled'), false);
  page.click('[data-wb-act="import-go"]');
  assert.equal(page.qa('#wb-import section').length, 0, 'the panel closes');
  assert.ok(page.document.activeElement === page.q('[data-wb-act="import-open"]'), 'focus returns to the button that opened it');
  const stored = JSON.parse(storage.getItem('fts.evals.v1'));
  assert.equal(stored.length, 1);
  assert.deepEqual(Object.keys(stored[0]).sort(), ['attempt', 'id', 'importedAt', 'judge', 'runId', 'score', 'scoreMax', 'scoringMethod', 'sourceName', 'task']);
  assert.equal(stored[0].task, 'Atlas');
  assert.equal(stored[0].score, 0.5);
  assert.equal(stored[0].scoreMax, 1);
  assert.equal(stored[0].sourceName, 'grading_results.json');
  assert.match(stored[0].importedAt, /^\d{4}-\d{2}-\d{2}T/);
  const raw = storage.getItem('fts.evals.v1');
  for (const secret of ['Used the funded draw', 'Counted the facility', 'Borealis', 'Imported final answer', 'python bridge.py', 'reasoning']) assert.ok(!raw.includes(secret), 'the stored record carries no ' + secret);
  /* the same file again replaces the record: one per result */
  page.click('[data-wb-act="import-open"]');
  page.click('[data-wb-act="import-grading"]');
  input = page.dom.pickers[page.dom.pickers.length - 1];
  input.files = [file('grading_results.json', JSON.stringify(STUDIO_GRADING()))]; input.fire('change');
  await waitFor(() => /grading_results\.json/.test(page.text('#wb-import')), { label: 'the file name again' });
  page.click('[data-wb-act="import-go"]');
  assert.equal(JSON.parse(storage.getItem('fts.evals.v1')).length, 1, 'de-duplicated by id');
  /* what the view shows */
  assert.match(page.text('#wb-evid-head'), /Imported evaluation result: 0\.5 \/ 1, run gr-qa-1, \d{4}-\d{2}-\d{2}\. Recorded by you from the evaluation; Finance Task Studio did not compute it\./);
  const rows = page.qa('#wb-crit [role="option"]').map(rowText);
  assert.equal(rows.length, before + 6, 'six imported items');
  const item = text => rows.find(r => r.includes(text));
  assert.match(item('Used the funded draw'), /Met.*Marked in the evaluation text/);
  assert.match(item('Counted the facility as cash'), /Not met.*Marked in the evaluation text/);
  assert.match(item('Bridge figure stated'), /Met.*Marked in the evaluation text/);
  assert.match(item('Headroom missing'), /Not met.*Marked in the evaluation text/);
  assert.match(item('Reserve not shown'), /Not met.*Marked in the evaluation text/);
  assert.match(item('Checked the dates'), /Unknown.*No basis to decide yet/, 'no token, no status');
  assert.doesNotMatch(page.all(), FORBIDDEN);
  /* the solver messages stay in memory and show when there is no run answer */
  page.choose('#wb-run', '');
  await page.settle();
  assert.match(page.text('#wb-solver'), /Final answer from the imported solver messages \(read in this browser only\)\./);
  assert.match(page.text('#wb-solver'), /Imported final answer: the bridge is 1,200\./);
  /* removing it from the view keeps the saved score record */
  page.click('[data-wb-act="eval-remove"]');
  assert.equal(page.qa('#wb-crit [role="option"]').length < rows.length, true);
  assert.equal(JSON.parse(storage.getItem('fts.evals.v1')).length, 1);
  /* cancelling closes the panel and returns focus to its button */
  page.click('[data-wb-act="import-open"]');
  page.click('[data-wb-act="import-cancel"]');
  assert.equal(page.qa('#wb-import section').length, 0);
  assert.equal(page.document.activeElement.getAttribute('data-wb-act'), 'import-open');
});

/* ====================================================================== the other package */

test('Compare with a changed package reads files through the package engine, diffs once per pair and can be removed', async t => {
  const baseFiles = [file('Cash_Facts.csv', 'Label,Value\nOpening usable cash,100\nPayments due,1850\nRequested draw,2480\n'), file('Facility_Terms.txt', 'Atlas facility terms.\nLimit 2,000 units.\nBorealis review.\n')];
  const changedFiles = [file('Cash_Facts.csv', 'Label,Value\nOpening usable cash,100\nPayments due,2150\nRequested draw,2480\n'), file('Facility_Terms.txt', 'Atlas facility terms.\nLimit 3,000 units.\nBorealis review.\n')];
  const live = await E.ingestFiles(baseFiles);
  const page = makePage(t, null, { pkg: live, location: { protocol: 'file:', hostname: '' } });
  let calls = 0;
  const orig = page.context.FinancePackageEngine.diffPackages;
  page.context.FinancePackageEngine.diffPackages = (...args) => { calls++; return orig(...args); };
  await page.mount();
  assert.equal(page.q('#wb-mt-diff').getAttribute('aria-disabled'), 'true');
  assert.equal(page.qa('[data-wb-act="compare-load"]').length, 1);
  assert.match(page.text('#wb-mid-head'), /Compare with a changed package/);
  page.click('[data-wb-act="compare-load"]');
  const input = page.dom.pickers[page.dom.pickers.length - 1];
  assert.equal(input.multiple, true, 'several files or a ZIP');
  assert.match(input.accept, /\.zip/);
  input.files = changedFiles; input.fire('change');
  await waitFor(() => /Comparing with 2 files/.test(page.text('#wb-mid-head')), { label: 'the comparison' });
  await page.settle();
  assert.equal(page.document.activeElement.getAttribute('data-key'), 'compare-clear', 'focus lands on the control that replaced the one that was used');
  assert.equal(calls, 1, 'the diff is computed once');
  assert.equal(page.q('#wb-mt-diff').hasAttribute('aria-disabled'), false);
  assert.equal(page.q('#wb-mt-diff').getAttribute('aria-selected'), 'true', 'a changed file opens in Diff');
  const changed = page.qa('#wb-mid-body td.wb-changed');
  assert.equal(changed.length, 1);
  assert.match(rowText(changed[0]), /Payments due|Value changed\. Before: 1850\s*→\s*Now: 2150/);
  assert.match(page.text('#wb-tree'), /Changed/);
  page.click(page.file('Facility_Terms.txt'));
  page.click(page.file('Cash_Facts.csv'));
  page.click('[data-wb-act="mode"][data-mode="source"]');
  page.click('[data-wb-act="mode"][data-mode="diff"]');
  assert.equal(calls, 1, 'selecting files and switching modes does not diff again');
  assert.equal(page.requests.length, 0, 'reading the files made no request');
  /* a read error is said plainly and leaves the page as it was */
  page.click('[data-wb-act="compare-clear"]');
  assert.equal(page.q('#wb-mt-diff').getAttribute('aria-disabled'), 'true');
  assert.match(page.text('#wb-status'), /Comparison removed/);
  assert.equal(page.document.activeElement.getAttribute('data-key'), 'compare-load', 'and back again when it is removed');
  page.click('[data-wb-act="compare-load"]');
  input.files = [{ name: 'broken.zip', size: 4, arrayBuffer: async () => { throw new Error('synthetic: the file could not be read'); } }]; input.fire('change');
  await waitFor(() => /The changed package could not be read: synthetic: the file could not be read/.test(page.text('#wb-notes')), { label: 'the error' });
  assert.equal(page.q('#wb-notes [role="alert"]').textContent.includes('could not be read'), true);
  assert.equal(page.q('#wb-mt-diff').getAttribute('aria-disabled'), 'true');
  /* the same two files again: the memoised diff is used */
  page.click('[data-wb-act="compare-load"]');
  input.files = changedFiles; input.fire('change');
  await waitFor(() => /Comparing with 2 files/.test(page.text('#wb-mid-head')), { label: 'the comparison again' });
  assert.equal(calls, 1, 'the same pair is not diffed twice');
});

test('an evidence pair from the dashboard is diffed once and compared without any control; a loaded package that is neither side is not compared', async t => {
  const base = basePkg(), cand = candPkg();
  const page = makePage(t, null, { pkg: cand, pair: { baseline: base, candidate: cand } });
  let calls = 0;
  const orig = page.context.FinancePackageEngine.diffPackages;
  page.context.FinancePackageEngine.diffPackages = (...args) => { calls++; return orig(...args); };
  await page.mount();
  assert.match(page.text('#wb-mid-head'), /Comparing the baseline with the proposed revision/);
  assert.equal(page.qa('[data-wb-act="compare-load"]').length, 0);
  page.click(page.file('Cash_Facts.csv'));
  page.rerender();
  assert.equal(calls, 1);
  assert.equal(page.qa('#wb-mid-body td.wb-changed').length, 1);
  /* the loaded package changes to something else: the pair no longer applies */
  page.state.pkg = pkg([TERMS('9,000')], 'Another package');
  page.rerender();
  assert.match(page.text('#wb-mid-head'), /Compare with a changed package/);
  assert.equal(page.q('#wb-mt-diff').getAttribute('aria-disabled'), 'true');
  assert.equal(page.qa('#wb-tree [role="treeitem"]').length, 1);
});

/* ====================================================================== keyboard, narrow layouts, failures */

const focusedKey = page => page.document.activeElement && page.document.activeElement.getAttribute('data-key');

test('keyboard: the file tree, the criteria list, the mode tabs, the splitter, Ctrl K and Escape', async t => {
  const { page } = await fullPage(t);
  /* the tree: arrows move focus and the one tab stop; Enter selects */
  const items = () => page.qa('#wb-tree [role="treeitem"]');
  const stop = () => items().find(el => el.getAttribute('tabindex') === '0');
  stop().focus();
  assert.ok(page.document.activeElement === stop(), 'the tab stop took focus');
  const names = () => items().map(el => el.querySelector('.wb-fn').textContent);
  const at = () => names().indexOf(page.document.activeElement.querySelector('.wb-fn').textContent);
  const start = at();
  page.key(page.document.activeElement, 'ArrowDown');
  assert.equal(at(), start + 1, 'ArrowDown moves to the next row');
  assert.equal(page.document.activeElement.getAttribute('tabindex'), '0');
  assert.equal(items().filter(el => el.getAttribute('tabindex') === '0').length, 1, 'still one tab stop');
  page.key(page.document.activeElement, 'End');
  assert.equal(names()[at()], 'Cobalt_Notes.txt');
  page.key(page.document.activeElement, 'ArrowLeft');
  assert.equal(names()[at()], 'inputs', 'ArrowLeft on a child goes to its folder');
  page.key(page.document.activeElement, 'ArrowLeft');
  assert.equal(page.qa('#wb-tree [role="treeitem"][aria-level="2"]').length, 0, 'ArrowLeft collapses an open folder');
  assert.equal(page.document.activeElement.getAttribute('aria-expanded'), 'false', 'focus stays on the folder after the repaint');
  page.key(page.document.activeElement, 'ArrowRight');
  assert.equal(page.qa('#wb-tree [role="treeitem"][aria-level="2"]').length, 2, 'ArrowRight opens it');
  page.key(page.document.activeElement, 'ArrowRight');
  assert.equal(names()[at()], 'Borealis_Schedule.csv', 'a second ArrowRight goes to the first child');
  page.key(page.document.activeElement, 'Enter');
  assert.equal(page.file('Borealis_Schedule.csv').getAttribute('aria-selected'), 'true', 'Enter selects the file');
  assert.match(page.text('#wb-mid-head'), /Borealis_Schedule\.csv/);
  page.key(page.document.activeElement, 'Home');
  assert.equal(names()[at()], 'Atlas_Model.xlsx');

  /* the criteria list: a virtual cursor, Enter selects, DOM focus stays on the list */
  const list = page.q('#wb-crit');
  list.focus();
  const cursor = () => (page.qa('#wb-crit [role="option"]').find(o => o.getAttribute('id') === list.getAttribute('aria-activedescendant')) || { textContent: '' }).textContent;
  const first = cursor();
  page.key(list, 'ArrowDown');
  assert.notEqual(cursor(), first, 'the cursor moved');
  page.key(list, 'End');
  assert.match(cursor(), /Facility headroom/);
  page.key(list, 'Enter');
  assert.equal(page.q('#wb-crit').hasAttribute('hidden'), true, 'Enter opens the card and the list steps aside');
  assert.equal(page.document.activeElement.getAttribute('id'), 'wb-card-title', 'focus moves to the card');
  assert.match(page.text('#wb-card'), /Facility headroom/);
  assert.match(page.text('#wb-evid-head'), /All criteria\s*5 of 5/, 'a way back, and where this one sits');
  page.key(page.document.activeElement, 'Escape');
  assert.equal(page.q('#wb-crit').hasAttribute('hidden'), false, 'Escape returns to the list');
  assert.ok(page.document.activeElement === list, 'with focus on the list');
  assert.equal(page.q('#wb-crit [aria-selected="true"]').textContent, cursor(), 'and the cursor on the criterion that was open');
  page.key(list, 'Home');
  page.key(list, 'Enter');
  assert.match(page.text('#wb-card'), /Usable cash/);
  page.key(page.document.activeElement, 'Escape');

  /* the mode tabs */
  page.click(page.file('Atlas_Model.xlsx'));
  const diffTab = page.q('#wb-mt-diff');
  diffTab.focus();
  page.key(diffTab, 'ArrowLeft');
  assert.equal(page.q('#wb-mt-source').getAttribute('aria-selected'), 'true');
  assert.equal(page.document.activeElement.getAttribute('id'), 'wb-mt-source');
  page.key(page.q('#wb-mt-source'), 'ArrowRight');
  assert.equal(page.q('#wb-mt-diff').getAttribute('aria-selected'), 'true');
  assert.equal(page.q('#wb-mt-diff').getAttribute('tabindex'), '0');
  assert.equal(page.q('#wb-mt-source').getAttribute('tabindex'), '-1');

  /* Ctrl K reaches the search from anywhere; typing narrows the files and the criteria; Escape clears */
  page.document.body.fire('keydown', { key: 'k', ctrlKey: true });
  assert.equal(page.document.activeElement.getAttribute('id'), 'wb-search');
  page.type('#wb-search', 'cobalt');
  assert.deepEqual(names(), ['inputs', 'Cobalt_Notes.txt']);
  assert.match(page.text('#wb-status'), /1 file and 0 criteria match\./);
  assert.match(page.text('#wb-crit-note'), /No criterion matches the search\./);
  assert.equal(page.q('#wb-crit').hasAttribute('hidden'), true);
  page.key('#wb-search', 'Escape');
  assert.equal(page.q('#wb-search').value, '');
  assert.equal(names().length, 8);
  assert.equal(page.qa('#wb-crit [role="option"]').length, 5);
  page.type('#wb-search', 'headroom');
  assert.equal(page.qa('#wb-crit [role="option"]').length, 2);
  page.type('#wb-search', '');
  page.document.body.fire('keydown', { key: 'K', metaKey: true });
  assert.equal(page.document.activeElement.getAttribute('id'), 'wb-search', 'the command key works too');
  assert.equal(page.primaries().length, 1);
});

test('the files overlay opens behind Files (n), takes focus, and Escape closes it and returns focus', async t => {
  const { page } = await fullPage(t);
  const button = () => page.q('.wb-files-btn');
  assert.match(button().textContent, /^Files \(7\)$/);
  assert.equal(button().getAttribute('aria-expanded'), 'false');
  assert.equal(button().getAttribute('aria-controls'), 'wb-files');
  assert.equal(page.root().getAttribute('data-wb-files'), 'closed');
  page.click(button());
  assert.equal(page.root().getAttribute('data-wb-files'), 'open');
  assert.equal(page.q('.wb-files-btn').getAttribute('aria-expanded'), 'true');
  assert.equal(page.document.activeElement.getAttribute('role'), 'treeitem', 'focus goes into the tree');
  page.key(page.document.activeElement, 'Escape');
  assert.equal(page.root().getAttribute('data-wb-files'), 'closed');
  assert.equal(page.document.activeElement.getAttribute('class').includes('wb-files-btn'), true, 'focus returns to the button');
  page.click(page.q('.wb-files-btn'));
  page.click(page.file('Cash_Facts.csv'));
  assert.equal(page.root().getAttribute('data-wb-files'), 'closed', 'choosing a file closes it');
  page.click(page.q('.wb-files-btn'));
  assert.equal(page.root().getAttribute('data-wb-files'), 'open');
  page.click('.wb-mid-title');
  assert.equal(page.root().getAttribute('data-wb-files'), 'closed', 'a click outside the pane closes it');
});

test('under 1024 one pane shows at a time behind a tab list and a numbered stepper; choosing a file moves on to the diff', async t => {
  const w = await finishedWorld(t);
  const page = makePage(t, w, { pkg: candPkg(), pair: { baseline: basePkg(), candidate: candPkg() }, project: PROJECT() });
  page.context.matchMedia = query => ({ matches: /max-width:\s*1023px/.test(String(query)) });
  await page.mount();
  await waitFor(() => page.qa('#wb-crit [role="option"]').length > 0, { label: 'criteria' });
  const tabs = page.qa('.wb-tablist [role="tab"]');
  assert.deepEqual(tabs.map(el => el.textContent), ['Files (7)', 'Diff', 'Evidence']);
  assert.equal(page.q('.wb-tablist').getAttribute('role'), 'tablist');
  assert.equal(page.root().getAttribute('data-wb-pane'), 'diff');
  assert.equal(page.q('#wb-pt-diff').getAttribute('aria-selected'), 'true');
  assert.deepEqual(tabs.map(el => el.getAttribute('tabindex')), ['-1', '0', '-1']);
  page.click('#wb-pt-evidence');
  assert.equal(page.root().getAttribute('data-wb-pane'), 'evidence');
  assert.equal(page.q('#wb-pt-evidence').getAttribute('aria-selected'), 'true');
  page.key('#wb-pt-evidence', 'ArrowLeft');
  assert.equal(page.root().getAttribute('data-wb-pane'), 'diff', 'arrow keys move between tabs and show the pane');
  page.key('#wb-pt-diff', 'ArrowLeft');
  assert.equal(page.root().getAttribute('data-wb-pane'), 'files');
  page.key('#wb-pt-files', 'End');
  assert.equal(page.root().getAttribute('data-wb-pane'), 'evidence');
  /* the stepper */
  const steps = () => page.qa('.wb-steps button').map(el => el.textContent);
  assert.deepEqual(steps(), ['1Files', '2Diff', '3Evidence']);
  assert.equal(page.q('.wb-steps [aria-current="step"]').textContent, '3Evidence');
  assert.equal(page.q('[data-wb-act="step-next"]').hasAttribute('disabled'), true);
  page.click('[data-wb-act="step-back"]');
  assert.equal(page.root().getAttribute('data-wb-pane'), 'diff');
  page.click('[data-wb-act="step-back"]');
  assert.equal(page.root().getAttribute('data-wb-pane'), 'files');
  assert.equal(page.q('[data-wb-act="step-back"]').hasAttribute('disabled'), true);
  page.click(page.file('Cash_Facts.csv'));
  assert.equal(page.root().getAttribute('data-wb-pane'), 'diff', 'a file was chosen: on to the diff');
  assert.equal(page.qa('[data-wb-act="step-back"]').length, 1);
  assert.equal(page.qa('#wb-root button').filter(b => b.getAttribute('class') === 'wb-sb').length, 2, 'Back and Next');
});

test('a pane that fails to draw shows an alert card with Retry, and the other panes keep working', async t => {
  const { page } = await fullPage(t);
  const model = page.context.FinanceWorkbenchModel;
  const orig = model.diffViewRows;
  model.diffViewRows = () => { throw new Error('synthetic: the diff rows failed'); };
  page.click(page.file('Facility_Terms.txt'));
  page.click(page.file('Atlas_Model.xlsx'));
  const alert = page.q('#wb-mid-body [role="alert"]');
  assert.ok(alert, 'the middle pane shows an alert');
  assert.match(alert.textContent, /This part could not be drawn\. synthetic: the diff rows failed/);
  assert.equal(alert.querySelector('button').textContent, 'Retry');
  assert.ok(page.qa('#wb-tree [role="treeitem"]').length > 0, 'the files pane is intact');
  assert.equal(page.qa('#wb-crit [role="option"]').length, 5, 'the criteria are intact');
  assert.match(page.text('#wb-drawer-bar'), /Live logs/);
  model.diffViewRows = orig;
  page.click(alert.querySelector('button'));
  assert.equal(page.qa('#wb-mid-body [role="alert"]').length, 0);
  assert.equal(page.qa('#wb-mid-body td.wb-changed').length, 3, 'the retry draws the table');
  /* a failing run read has its own Retry */
  const w = await finishedWorld(t);
  const broken = makePage(t, w, { pkg: candPkg(), pair: null });
  await broken.mount();
  await waitFor(() => broken.qa('#wb-run option').length >= 2, { label: 'the run list' });
  const realFetch = broken.context.fetch;
  let fail = true;
  broken.context.fetch = (url, init) => (fail && /\/runs\/1$/.test(url) ? Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'synthetic: the run could not be read' }), text: async () => '' }) : realFetch(url, init));
  broken.choose('#wb-run', '');
  await broken.settle();
  broken.choose('#wb-run', w.roundId + ':1');
  await waitFor(() => broken.qa('#wb-crit-note [role="alert"]').length > 0, { label: 'the run error' });
  assert.match(broken.text('#wb-crit-note'), /The run could not be read\./);
  fail = false;
  broken.click('[data-wb-act="retry-detail"]');
  await waitFor(() => broken.qa('#wb-crit [role="option"]').length > 0, { label: 'the retry' });
});

test('every state has exactly one yellow primary, and leaving the page stops the requests', async t => {
  const { page } = await fullPage(t);
  const checks = [];
  const check = label => checks.push([label, page.primaries().length]);
  check('arrival');
  page.click(page.qa('#wb-crit [role="option"]')[1]); check('criterion');
  page.click('[data-wb-act="crit-back"]'); check('back to the list');
  page.click('[data-wb-act="import-open"]'); check('import panel');
  page.click('[data-wb-act="import-cancel"]');
  page.click('[data-wb-act="drawer-toggle"]'); check('drawer');
  page.click(page.file('Facility_Terms.txt')); check('lines');
  page.click('[data-wb-act="mode"][data-mode="source"]'); check('source');
  page.click('[data-wb-act="only-not-met"]'); check('not met only');
  for (const [label, n] of checks) assert.equal(n, 1, label);
  assert.deepEqual(page.qa('#wb-root button.primary').map(b => b.textContent), ['Load task package']);
  /* leaving the page: no more requests, even with the drawer open */
  page.WB.afterRender(false);
  const n = page.requests.length;
  await sleep(2300);
  assert.equal(page.requests.length, n, 'no polling after the view is left');
  page.rerender();
  assert.ok(page.q('#wb-root'), 'and it paints again when shown');
});

/* ====================================================================== the evidence pane: list and card, one at a time */

test('choosing a criterion opens its card in the whole pane: the list steps aside, and All criteria, Previous, Next and Escape lead back', async t => {
  const { page } = await fullPage(t);
  const rows = () => page.qa('#wb-crit [role="option"]');
  const list = page.q('#wb-crit');
  assert.equal(list.hasAttribute('hidden'), false, 'the list is the default');
  assert.match(page.text('#wb-card'), /^Choose a criterion to see its source clause, the changed cell and the solver's conclusion together\.$/);
  assert.equal(page.qa('#wb-card article').length, 0, 'no card until a criterion is chosen');
  assert.ok(page.q('#wb-run'), 'the run picker is in the evidence pane while the list shows');
  const names = rows().map(rowText);
  page.click(rows()[1]);
  assert.equal(list.hasAttribute('hidden'), true, 'the list steps aside');
  assert.equal(page.qa('#wb-runblock *').length, 0, 'and so does the run picker');
  assert.equal(page.q('#wb-card article').getAttribute('aria-labelledby'), 'wb-card-title');
  assert.ok(page.document.activeElement === page.q('#wb-card-title'), 'focus moves to the card heading');
  assert.equal(page.q('#wb-card-title').getAttribute('tabindex'), '-1');
  assert.match(page.text('#wb-evid-head'), /^← All criteria2 of 5‹›$/);
  assert.equal(page.q('[data-wb-act="crit-prev"]').hasAttribute('aria-disabled'), false);
  assert.equal(page.q('[data-wb-act="crit-prev"]').getAttribute('aria-label'), 'Previous criterion');
  assert.equal(page.q('[data-wb-act="crit-next"]').getAttribute('aria-label'), 'Next criterion');
  /* Next and Previous step through the list in its order and say where they are */
  page.click('[data-wb-act="crit-next"]');
  assert.match(page.text('#wb-evid-head'), /3 of 5/);
  assert.match(page.text('#wb-card-title'), /Facility headroom/);
  assert.match(page.text('#wb-status'), /^Criterion 3 of 5: Facility headroom, Not met\.$/);
  assert.equal(page.qa('#wb-crit [aria-selected="true"]').length, 1);
  page.click('[data-wb-act="crit-next"]'); page.click('[data-wb-act="crit-next"]');
  assert.match(page.text('#wb-evid-head'), /5 of 5/);
  assert.equal(page.q('[data-wb-act="crit-next"]').getAttribute('aria-disabled'), 'true', 'no wrap at the end');
  page.q('[data-wb-act="crit-next"]').focus();
  page.click('[data-wb-act="crit-next"]');
  assert.match(page.text('#wb-evid-head'), /5 of 5/, 'a click on the disabled step changes nothing');
  assert.ok(page.document.activeElement === page.q('[data-wb-act="crit-next"]'), 'and focus stays on the step control');
  page.click('[data-wb-act="crit-prev"]');
  assert.match(page.text('#wb-evid-head'), /4 of 5/);
  /* the same criterion is still the selected one when the list comes back, with the cursor on it and focus on the list */
  page.click('[data-wb-act="crit-back"]');
  assert.equal(list.hasAttribute('hidden'), false);
  assert.ok(page.document.activeElement === list);
  assert.equal(page.q('#wb-crit [aria-selected="true"]').textContent, rows()[3].textContent);
  assert.equal(list.getAttribute('aria-activedescendant'), rows()[3].getAttribute('id'));
  assert.deepEqual(rows().map(rowText), names, 'the list is unchanged');
  assert.ok(page.q('#wb-run'), 'the run picker is back');
  assert.match(page.text('#wb-card'), /^Choose a criterion/);
  /* Escape anywhere in the pane does the same, and a key press elsewhere does not */
  page.click(rows()[0]);
  assert.equal(list.hasAttribute('hidden'), true);
  page.key('#wb-search', 'Escape');
  assert.equal(list.hasAttribute('hidden'), true, 'Escape in the search box does not close the card');
  page.key('[data-wb-act="crit-next"]', 'Escape');
  assert.equal(list.hasAttribute('hidden'), false);
  /* Not met only: the steps follow the filtered list */
  page.click('[data-wb-act="only-not-met"]');
  assert.equal(rows().length, 2);
  page.click(rows()[0]);
  assert.match(page.text('#wb-evid-head'), /1 of 2/);
  assert.equal(page.q('[data-wb-act="crit-prev"]').getAttribute('aria-disabled'), 'true');
  page.click('[data-wb-act="crit-next"]');
  assert.match(page.text('#wb-evid-head'), /2 of 2/);
  assert.equal(page.primaries().length, 1);
  assert.doesNotMatch(page.all(), FORBIDDEN);
});

test('the log shows a tool call and its result as two kinds of line, and the copy says the same', async t => {
  const w = await makeWorld(t, { resultText: ANSWER });
  const roundId = await seedRound(w);
  const transcript = path.join(w.projectRoot, 'private', 'agent-rounds', roundId, 'runs', '1', 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'python3 bridge.py' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'bridge 1200' }] } },
    { type: 'result', subtype: 'success', result: 'Done.' },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  const page = makePage(t, w, { pkg: candPkg(), pair: { baseline: basePkg(), candidate: candPkg() }, project: PROJECT() });
  await page.mount();
  await waitFor(() => /4 lines/.test(page.text('#wb-drawer-bar')), { label: 'the log' });
  page.click('[data-wb-act="drawer-toggle"]');
  const kinds = page.qa('#wb-log .wb-ll').map(el => [el.querySelector('.wb-ll-k').textContent, (el.querySelector('.wb-ll-t') || { textContent: '' }).textContent, el.querySelector('.wb-ll-x').textContent]);
  assert.deepEqual(kinds, [['init', '', 'Session started with model claude-opus-5-5.'], ['tool', 'Bash', 'python3 bridge.py'], ['tool result', '', 'bridge 1200'], ['result', '', 'Done.']]);
  page.click('[data-wb-act="log-copy"]');
  await waitFor(() => page.clip.length > 0, { label: 'the clipboard' });
  assert.equal(page.clip[0], 'init Session started with model claude-opus-5-5.\ntool Bash python3 bridge.py\ntool result bridge 1200\nresult Done.');
});

/* ====================================================================== what the card and the diff say about a mutation */

test('a long clause is shown as an excerpt around the value, on whole words, with the full quote behind a disclosure', async t => {
  const sentence = 'The treasury team reviews the facility every quarter and records each draw and each repayment in the ledger. ';
  const text = 'Atlas treasury review, synthetic. ' + sentence.repeat(3) + 'After the funded draw the cash bridge is 1,200 units, and only confirmed draws count as usable cash. ' + sentence.repeat(3);
  assert.ok(text.length > 700);
  const doc1 = txt('Facility_Review.txt', [text]);
  const project = { title: 'Atlas (QA fixture)', versions: { prompt: 'v1', workbook: 'v1', evaluator: 'v1' }, sources: [{ id: 's1', title: 'Review', file: 'Facility_Review.txt', page: 'Line 1', cell: '', date: '', authority: '', version: '', excerpt: '', reviewStatus: 'pending', suppliedToSolver: true }, { id: 's2', title: 'Short', file: 'Facility_Terms.txt', page: 'Line 2', cell: '', date: '', authority: '', version: '', excerpt: '', reviewStatus: 'pending', suppliedToSolver: true }], roots: [{ id: 'r1', title: 'Credit', outputs: [{ id: 'o1', label: 'Bridge after the draw', unit: 'units', correct: '1200', wrong: '1500', absTolerance: '0', relTolerance: '0', threshold: '1300', direction: 'at-most', calculation: '', sourceIds: ['s1', 's2'] }] }] };
  const page = makePage(t, null, { pkg: pkg([doc1, TERMS('3,000')], 'Atlas long'), project, location: { protocol: 'file:', hostname: '' } });
  await page.mount();
  page.click(page.qa('#wb-crit [role="option"]')[0]);
  const quote = page.q('#wb-card blockquote.wb-quote');
  const shown = quote.textContent;
  assert.match(shown, /^…\S/, 'it starts on a word after an ellipsis');
  assert.match(shown, /\S…$/, 'and ends on a word before one');
  assert.ok(shown.length < 300, 'an excerpt, not the record: ' + shown.length);
  assert.match(shown, /the cash bridge is 1,200 units/);
  assert.equal(page.qa('#wb-card blockquote.wb-quote b').length >= 1 && page.q('#wb-card blockquote.wb-quote b').textContent, '1,200', 'the value is bold');
  assert.doesNotMatch(shown, /^…[a-z]*\b(?<!\bThe)\s*[a-z]{1,2}\s/, 'no cut word');
  const more = page.q('#wb-card details.wb-fullquote');
  assert.ok(more, 'the whole quote waits behind a disclosure');
  assert.match(more.querySelector('summary').textContent, /^Show the full quote \(\d{3} characters\)$/);
  assert.equal(more.querySelector('blockquote').textContent, text, 'and it is the whole record');
  assert.equal(more.hasAttribute('open'), false, 'closed by default');
  assert.ok(more.getAttribute('data-key'), 'it keeps its state across repaints');
  /* the second clause (the short one) is not an excerpt and sits behind "1 more clause" */
  assert.equal(page.qa('#wb-card .wb-more summary').filter(el => /^1 more clause$/.test(el.textContent)).length, 1);
  assert.equal(page.qa('#wb-card details.wb-more blockquote.wb-quote').map(el => el.textContent).includes('Facility limit is 3,000 units'), true, 'a short quote is shown as it is');
});

test('a changed workbook says how a cell changed (the formulas), when it sits in a hidden place, and what changed around the cells (sheets and names)', async t => {
  const f = (ref, formula, value, extra = {}) => cell('Bridge', ref, value, { hasFormula: true, formula, text: '=' + formula + ' [cached: ' + value + ']', ...extra });
  const base = pkg([xlsx('Atlas_Model.xlsx', [cell('Bridge', 'B5', 1850), f('B6', 'B5-B2-B3-B4', 1200), f('B7', 'B9-B6', 500), cell('Bridge', 'B8', 3000), cell('Bridge', 'B9', 1700)], { metadata: { sheets: [{ name: 'Bridge', state: 'visible', populatedCells: 5 }], definedNames: [{ name: 'Rate', ref: 'Bridge!$B$8' }, { name: 'Gone', ref: 'Bridge!$B$1' }] } }), TERMS('3,000')], 'Atlas base');
  const cand = pkg([xlsx('Atlas_Model.xlsx', [cell('Bridge', 'B5', 2150), f('B6', 'B5-B2-B3', 1500), cell('Bridge', 'B7', 500), cell('Bridge', 'B8', 3500, { hidden: true }), cell('Bridge', 'B9', 1700), cell('Scratch', 'A1', 42, { hidden: true })], { metadata: { sheets: [{ name: 'Bridge', state: 'visible', populatedCells: 5 }, { name: 'Scratch', state: 'hidden', populatedCells: 1 }], definedNames: [{ name: 'Rate', ref: 'Bridge!$B$9' }] } }), TERMS('3,000')], 'Atlas changed');
  const project = { title: 'Atlas (QA fixture)', versions: { prompt: 'v1', workbook: 'v1', evaluator: 'v1' }, sources: [{ id: 's1', title: 'Bridge cell', file: 'Atlas_Model.xlsx', page: '', cell: 'Bridge!B6', date: '', authority: '', version: '', excerpt: '', reviewStatus: 'pending', suppliedToSolver: true }], roots: [{ id: 'r1', title: 'Credit', outputs: [{ id: 'o1', label: 'Bridge after the draw', unit: 'units', correct: '1200', wrong: '1500', absTolerance: '0', relTolerance: '0', threshold: '1300', direction: 'at-most', calculation: '', sourceIds: ['s1'] }] }] };
  const page = makePage(t, null, { pkg: base, pair: { baseline: base, candidate: cand }, project, location: { protocol: 'file:', hostname: '' } });
  await page.mount();
  assert.match(page.text('.wb-fchg'), /Changed · 5 cells, 3 workbook changes/, 'the selected file says what changed, workbook changes included');
  const b6 = page.q('#wb-mid-body td[data-wb-loc="Bridge!B6"]');
  assert.match(rowText(b6), /Formula: =B5-B2-B3-B4 → =B5-B2-B3/);
  assert.match(rowText(page.q('#wb-mid-body td[data-wb-loc="Bridge!B7"]')), /Formula: =B9-B6 → a typed value/, 'a typed value over a formula is a formula change');
  assert.match(rowText(page.q('#wb-mid-body td[data-wb-loc="Bridge!B8"]')), /In a hidden row, column or sheet/);
  const block = page.q('#wb-mid-body .wb-metachg');
  assert.ok(block, 'workbook-level changes are listed');
  assert.deepEqual(block.querySelectorAll('li').map(el => el.textContent).sort(), ['Name Gone was removed.', 'Name Rate now points at Bridge!$B$9 (it pointed at Bridge!$B$8).', 'Sheet Scratch was added.']);
  assert.equal(block.getAttribute('aria-label'), 'Workbook changes');
  /* the card says the same for the criterion whose clause is that cell */
  page.click(page.qa('#wb-crit [role="option"]')[0]);
  assert.match(page.text('#wb-card'), /Formula: =B5-B2-B3-B4 → =B5-B2-B3/);
  assert.match(page.text('#wb-card'), /1200.*→.*Decision-changing: 1500/);
  /* 5 changes: the count is every changed cell, and the toolbar steps through them */
  assert.match(page.text('#wb-chg-count'), /5 changed cells|Change \d of 5/);
});

test('the go-to box looks for a value that is not a locator in the records, and each exact match opens its record', async t => {
  const { page } = await fullPage(t);
  page.click(page.file('Facility_Terms.txt'));
  page.click('[data-wb-act="mode"][data-mode="source"]');
  page.type('#wb-goto-in', '2,480');
  page.click('[data-wb-act="goto"]');
  assert.equal(page.text('#wb-goto-msg'), 'No record in this file has the locator 2,480. These records hold it as text:');
  const hits = page.qa('#wb-mid-body ul.wb-hits button').map(el => el.textContent);
  assert.deepEqual(hits, ['Facility_Terms.txt · Line 1', 'Cash_Facts.csv · Row 4'], 'exact matches only, in package order, evaluator files left out');
  assert.equal(page.q('#wb-mid-body ul.wb-hits').getAttribute('aria-label'), 'Records that hold 2,480');
  page.click(page.qa('#wb-mid-body ul.wb-hits button')[1]);
  assert.equal(page.file('Cash_Facts.csv').getAttribute('aria-selected'), 'true', 'the file of the match opens');
  assert.equal(page.qa('#wb-recs [role="option"]').find(el => el.getAttribute('aria-selected') === 'true').getAttribute('data-wb-loc'), 'Row 4', 'with the record selected');
  assert.equal(page.qa('#wb-mid-body ul.wb-hits').length, 0, 'the matches go away with the file change');
  /* nothing matches: only the plain sentence */
  page.type('#wb-goto-in', 'no such text anywhere');
  page.click('[data-wb-act="goto"]');
  assert.equal(page.text('#wb-goto-msg'), 'No record in this file has the locator no such text anywhere.');
  assert.equal(page.qa('#wb-mid-body ul.wb-hits').length, 0);
  /* a locator still wins over a text search */
  page.type('#wb-goto-in', 'Row 2');
  page.click('[data-wb-act="goto"]');
  assert.match(page.text('#wb-goto-msg'), /^Showing Row 2\.$/);
});

test('Changed only narrows a long file list to the files that changed', async t => {
  const extra = Array.from({ length: 6 }, (_, i) => txt('inputs/Cobalt_Extra_' + (i + 1) + '.txt', ['Cobalt extra ' + (i + 1)]));
  const base = pkg([TERMS('2,000'), FACTS('1850'), MODEL(100), NOTES(), BIG(), ...SIDE(), ...extra], 'Atlas base');
  const cand = pkg([TERMS('3,000'), FACTS('1900'), MODEL(150, { b20: true, b100: true }), NOTES(), BIG(), ...SIDE(), ...extra], 'Atlas changed');
  const page = makePage(t, null, { pkg: cand, pair: { baseline: base, candidate: cand }, location: { protocol: 'file:', hostname: '' } });
  await page.mount();
  const names = () => page.qa('#wb-tree [role="treeitem"] .wb-fn').map(el => el.textContent);
  assert.equal(page.qa('#wb-tree [role="treeitem"][aria-level="2"]').length, 8, 'eight files sit under inputs');
  const toggle = () => page.q('[data-wb-act="changed-only"]');
  assert.ok(toggle(), 'twelve or more files offer the filter');
  assert.equal(toggle().getAttribute('aria-pressed'), 'false');
  page.click(toggle());
  assert.equal(toggle().getAttribute('aria-pressed'), 'true');
  assert.deepEqual(names(), ['Atlas_Model.xlsx', 'Cash_Facts.csv', 'Facility_Terms.txt']);
  page.click(toggle());
  assert.equal(names().length, 14);
});
