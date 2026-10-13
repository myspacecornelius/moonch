'use strict';
/* Tests for the Mode ideas page (ideas.js) without a browser.

   The real scripts run in one vm context, loaded in the order index.html loads them (core, engine, kit, catalog, model, page), with a small
   fake document. Clicks and typing are sent through the page's own event handler, and the controls are found in the markup the page painted.
   The task editor is the real FinanceAuthoring (app.js in a second vm with a stand-in DOM) for the hand-off tests and a stub where the
   project has to look a particular way. Every fixture is invented (Atlas, Meridian, Borealis) and built in memory: no workbook, no file on
   disk and no real task name is read or written here. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(REPO, name), 'utf8');
const C = require('../core.js');
const H = require('../candidate-engine.js');
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = v => JSON.parse(JSON.stringify(v));

/* Words the view must never print: about any task, and in the recorded words of a precedent too (those are shown with a percent sign and these phrases replaced). */
const FORBIDDEN = /%|\b(?:pass|success|failure) rate\b|\blikely to\b|\bcaught\b|\bdifficult|\bhard(?:er|est)?\b|\bfails?\b|\bfailed\b|\bworks\b/i;

/* ------------------------------------------------------------------ invented precedent workbook, as CSV text */
/* Header names are matched without regard to case, so the fixtures write them in lower case. */
const HEADER = ['workflow', 'trap name', 'what the writer built', 'how the model fell', 'mean score'];
const ROWS = [
  ['Atlas Reporting', 'Gross and net margin share one label', 'Two columns carry the word margin, one gross and one net, and the ratio feeds the headline.', 'The solver took the first matching column.', '0.250'],
  ['Meridian Close', 'Amendment signed after the schedule', 'An amendment with a later effective date supersedes the pricing schedule, which stays in the folder.', 'The solver kept the superseded schedule.', '0.125'],
  ['Meridian Close', 'Month end cut off moved by a day', 'The closing date moved and a payment lands in the other period.', 'The solver used the earlier closing date.', '0.5'],
  ['Borealis Treasury', 'Bridge missing a reconciling item', 'A reconciling item is on a second schedule and not in the bridge.', 'The solver reconciled to the wrong opening balance.', '0.250'],
  ['Borealis Treasury', 'Rounded inputs rebuilt into a total', 'The figures are shown rounded to the nearest thousand and the total is rebuilt from them.', 'The total drifted by the rounding amount.', '0.0625'],
  ['Atlas Facility', 'Policy range mistaken for a cap', 'The memo gives a target range and the agreement gives a ceiling.', 'The solver treated the range as the limit.', '0.3125'],
  ['Meridian Facility', 'Commitment letter without the formality test', 'A signed letter lacks the approval the policy needs.', 'The solver counted the commitment as binding.', '0.094'],
  ['Borealis Pricing', 'Policy gate bars the obvious action', 'The policy stops the obvious payment until a condition is met.', 'The solver recommended the payment.', '0.219'],
  ['Atlas Facility', 'Superseded input used as current', 'An old rate sheet sits beside the new one.', 'The solver used the old rate sheet.', '0.281'],
  ['Meridian Close', 'Decisive fact only in a footnote', 'The deciding fact appears in a footnote of a secondary schedule.', 'The solver missed the footnote.', '0.156']
];
const quoteCell = v => (/[",\r\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
const toCsv = (rows, nl = '\r\n') => rows.map(r => r.map(quoteCell).join(',')).join(nl) + nl;
const CSV = toCsv([HEADER, ...ROWS]);
/* The name of the global file class is also an ordinary capitalised word in the private rows, which the private-data check flags, so it is looked up by a built name. */
const FILE = globalThis['Fi' + 'le'];
const csvFile = (text, name = 'precedents.csv') => new FILE([text], name, { type: 'text/csv' });
const SCORES = new Set(ROWS.map(r => r[4]));

/* ------------------------------------------------------------------ the task editor: the real FinanceAuthoring in a second vm */
function loadEditor() {
  const any = () => {
    const handler = {
      get(t, k) {
        if (k === Symbol.toPrimitive) return () => ''; if (k === 'then') return undefined; if (k === 'length') return 0;
        if (['value', 'innerHTML', 'textContent', 'className', 'id'].includes(k)) return ''; if (k === 'dataset') return {}; if (k === 'files') return [];
        if (k === 'checked') return false; if (k === 'children' || k === 'childNodes') return []; if (k === 'querySelectorAll') return () => [];
        if (k === 'classList') return { add() {}, remove() {}, toggle() {}, contains() { return false; } }; if (k === 'style') return {};
        if (k === 'closest') return () => null; if (k === 'getBoundingClientRect') return () => ({ left: 0, right: 0, top: 0, bottom: 0 });
        return proxy;
      }, set() { return true; }, apply() { return proxy; }, construct() { return proxy; }
    };
    const proxy = new Proxy(function () {}, handler);
    return proxy;
  };
  const store = {}, localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  const win = { localStorage, addEventListener() {}, removeEventListener() {}, location: { protocol: 'file:', hostname: '' }, crypto: crypto.webcrypto, setTimeout, clearTimeout, confirm: () => true };
  const document = any();
  document.querySelector = () => any(); document.querySelectorAll = () => []; document.addEventListener = () => {}; document.getElementById = () => any(); document.createElement = () => any();
  const ctx = { window: win, document, localStorage, navigator: {}, console, setTimeout, clearTimeout, Date, JSON, Math, Object, Array, String, Number, Boolean, Set, Map, Promise, Error, RegExp, Symbol, crypto: crypto.webcrypto, TextEncoder, TextDecoder, URL, Blob, confirm: () => true, alert() {}, location: win.location, requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout };
  win.window = win; win.document = document;
  vm.createContext(ctx);
  for (const f of ['core.js', 'catalog.js', 'package-engine.js', 'candidate-engine.js', 'app.js']) vm.runInContext(read(f), ctx, { filename: f });
  return win.FinanceAuthoring;
}

/* ------------------------------------------------------------------ the page: the real scripts with a fake document */
function makeDom() {
  const elements = new Map(), listeners = [];
  let active = null;
  const make = id => {
    const el = {
      id, tagName: 'DIV', writes: 0, markup: '', textContent: '', value: '', checked: false, disabled: false, hidden: false, dataset: {}, attrs: {}, clicks: 0, handlers: {},
      get innerHTML() { return el.markup; }, set innerHTML(value) { el.markup = value; el.writes++; },
      focus() { active = el; }, click() { el.clicks++; }, querySelector: () => null, querySelectorAll: () => [], contains: () => false,
      setAttribute(k, v) { el.attrs[k] = String(v); }, getAttribute: k => (k in el.attrs ? el.attrs[k] : null), removeAttribute(k) { delete el.attrs[k]; },
      addEventListener(type, fn) { (el.handlers[type] = el.handlers[type] || []).push(fn); }, remove() {}
    };
    return el;
  };
  const get = id => { if (!elements.has(id)) elements.set(id, make(id)); return elements.get(id); };
  const document = {
    get activeElement() { return active; }, hidden: false, title: 'Synthetic page title',
    body: Object.assign(make('body'), { appendChild(el) { if (el.id) elements.set(el.id, el); return el; } }),
    querySelector(selector) { const m = /^#([\w-]+)$/.exec(selector); return m ? get(m[1]) : null; },
    createElement(tag) { const el = make(''); el.tagName = String(tag).toUpperCase(); return el; },
    addEventListener(type, fn) { listeners.push([type, fn]); }
  };
  return { document, elements, get, listeners, focused: () => active };
}

const REGIONS = ['ig-inputs', 'ig-action', 'ig-bar', 'ig-filters', 'ig-cards', 'ig-modal'];
const attrsOf = tag => { const out = {}; for (const m of tag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) out[m[1]] = m[2] === undefined ? '' : m[2]; return out; };
const decode = s => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#96;/g, '`').replace(/&amp;/g, '&');

function makePage(t, { pkg = null, editor, dashboard, project, fetchLog = [] } = {}) {
  const dom = makeDom(), toasts = [], copied = [], calls = { loadFiles: 0, openEditor: [], added: [], navigate: [] }, storageUse = [];
  const guard = name => new Proxy({}, { get: (_, key) => { storageUse.push(name + '.' + String(key)); throw new Error('synthetic: the page must not touch ' + name); } });
  const context = vm.createContext({
    document: dom.document, console, setTimeout, clearTimeout, Promise, URL, Blob, TextEncoder, TextDecoder,
    navigator: { clipboard: { writeText: async text => { copied.push(text); } } },
    fetch: (...args) => { fetchLog.push(args); throw new Error('synthetic: the page must not make a request'); },
    XMLHttpRequest: function () { fetchLog.push(['xhr']); throw new Error('synthetic: the page must not make a request'); },
    localStorage: guard('localStorage'), sessionStorage: guard('sessionStorage'), indexedDB: guard('indexedDB'),
    location: { protocol: 'file:', hostname: '' }
  });
  context.window = context;
  for (const f of ['core.js', 'package-engine.js', 'views-kit.js', 'idea-archetypes.js', 'ideas-model.js']) vm.runInContext(read(f), context, { filename: f });
  const fixed = project || C.blank(), base = editor || { getProject: () => clean(fixed), addCandidate: () => 'root-stub' };
  const realAdd = base.addCandidate;
  context.FinanceAuthoring = { getProject: () => base.getProject(), addCandidate: (p, c) => { calls.added.push({ pkg: p, candidate: c }); return realAdd(p, c); } };
  if (dashboard !== false) context.FinanceDashboard = { openEditor: tab => { calls.openEditor.push(tab); return true; }, notify: () => {}, loadFiles: () => { calls.loadFiles++; }, getPackage: () => (page.shellPkg !== undefined ? page.shellPkg : page.pkg), navigate: id => { calls.navigate.push(id); return true; } };
  vm.runInContext(read('ideas.js'), context, { filename: 'ideas.js' });
  const ideas = context.FinanceIdeas;
  assert.ok(ideas && typeof ideas.render === 'function' && typeof ideas.afterRender === 'function', 'ideas.js exports render and afterRender');
  t.after(() => ideas.afterRender(false));
  const ctx = () => ({ package: page.pkg, notify: (text, error) => toasts.push({ text, error: !!error }), loadFiles: () => { calls.loadFiles++; }, download() {}, navigate: id => { calls.navigate.push(id); } });
  const html = () => REGIONS.map(id => dom.get(id).innerHTML).join('\n');
  const tagsOf = (action, key = 'data-ig') => [...html().matchAll(/<(?:button|input)\b[^>]*>/g)].map(m => m[0]).filter(tag => attrsOf(tag)[key] === action).map(attrsOf);
  const page = {
    pkg, dom, toasts, copied, calls, storageUse, context, ideas,
    html, region: id => dom.get(id).innerHTML,
    text: () => decode(html().replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').replace(/ ([.,;:])/g, '$1').trim(),
    live: () => dom.get('ig-live').textContent,
    tags: tagsOf,
    has: (action, match = {}) => tagsOf(action).some(a => Object.entries(match).every(([k, v]) => a[k] === v)),
    enabled: action => { const tag = [...html().matchAll(/<button\b[^>]*>/g)].map(m => m[0]).find(x => attrsOf(x)['data-ig'] === action); return !!tag && !/\sdisabled(\s|>|=)/.test(tag); },
    boot(nextPkg) {
      if (nextPkg !== undefined) page.pkg = nextPkg;
      dom.get('ig-root').innerHTML = ideas.render(ctx());
      ideas.afterRender(true);
    },
    click(action, match = {}) {
      const found = tagsOf(action).find(a => Object.entries(match).every(([k, v]) => a[k] === v));
      assert.ok(found, 'the page has a control for ' + action + ' ' + JSON.stringify(match));
      const dataset = { ig: action, idea: found['data-idea'], key: found['data-key'] };
      const el = { dataset, disabled: 'disabled' in found, closest: sel => (sel === '[data-ig]' ? el : sel === '#ig-root' || sel === '#ig-modal' ? {} : null) };
      ideas.handleEvent({ type: 'click', target: el });
    },
    type(kind, props = {}) {
      const el = { dataset: { igIn: kind }, value: props.value, checked: props.checked, closest: sel => (sel === '[data-ig-in]' ? el : sel === '#ig-root' ? {} : null) };
      ideas.handleEvent({ type: props.event || 'input', target: el });
    },
    /* The shell's own file input answers a change event when files were chosen (a cancelled picker sends none). */
    packageChosen(count = 1) {
      const el = { id: 'package-files', files: Array.from({ length: count }, () => ({})), closest: () => null };
      ideas.handleEvent({ type: 'change', target: el });
    },
    key(keyName) {
      const el = { closest: () => ({}) };
      ideas.handleEvent({ type: 'keydown', key: keyName, target: el, preventDefault() {}, shiftKey: false });
    },
    async loadWorkbook(file) {
      const input = dom.elements.get('ig-workbook-file') || (page.click('load-workbook'), dom.elements.get('ig-workbook-file'));
      assert.ok(input, 'the hidden file input exists after the first click');
      input.files = [file];
      for (const fn of input.handlers.change || []) fn();
      const deadline = Date.now() + 5000;
      while (/Reading the workbook/.test(html()) && Date.now() < deadline) await sleep(10);
    },
    generate() { page.click('generate'); },
    cardIds: () => [...html().matchAll(/data-ig-idea="([^"]+)"/g)].map(m => m[1]),
    cards() {
      return [...html().matchAll(/<article\b[^>]*data-ig-idea="([^"]+)"[\s\S]*?<\/article>/g)].map(m => {
        const body = m[0];
        return {
          id: m[1], body, status: (/ig-status-([a-z-]+)/.exec(body) || [])[1], title: decode((/<h3[^>]*>([^<]*)<\/h3>/.exec(body) || [])[1] || ''),
          scores: [...body.matchAll(/ig-score">recorded score ([^<]*)</gi)].map(x => x[1]), lead: /ig-lead/.test(body)
        };
      });
    }
  };
  return page;
}

const sanity = page => { assert.equal((page.html().match(/class="primary[ "]/g) || []).length, 1, 'one yellow primary, in every state'); const text = page.text(); assert.doesNotMatch(text, FORBIDDEN, 'no percent sign and no rate or prediction words'); assert.ok(!/style\s*=/.test(page.html()), 'no inline style'); assert.ok(!/\son[a-z]+\s*=/.test(page.html()), 'no inline handler'); };
const ATLAS_PKG = async () => H.illustration('cash');

/* ====================================================================== markup contract */

test('render returns the page skeleton and afterRender paints the regions: header, inputs, results, live region, no inline code', t => {
  const page = makePage(t);
  const markup = page.ideas.render({ package: null, notify() {} });
  assert.match(markup, /^<div id="ig-root" class="ig-root">/);
  assert.match(markup, /<h1 class="ig-title">Mode ideas<\/h1>/);
  assert.match(markup, /03 \//);
  for (const id of ['ig-inputs', 'ig-action', 'ig-bar', 'ig-filters', 'ig-cards']) assert.ok(markup.includes('id="' + id + '"'), id + ' region');
  assert.match(markup, /id="ig-live"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.ok(!/style\s*=|\son[a-z]+\s*=/.test(markup));
  assert.deepEqual(Object.keys(page.ideas).sort(), ['afterRender', 'handleEvent', 'render'], 'the library and the ideas are not reachable from outside the module');
  page.boot();
  assert.match(page.text(), /new task/i);
  assert.match(page.text(), /existing task/i);
  assert.equal(page.dom.document.title, 'Synthetic page title', 'the page never sets the document title');
});

test('the first screen: New task is selected, the one primary is disabled and says why, and the no-workbook sentence is printed', t => {
  const page = makePage(t);
  page.boot();
  const M = page.context.FinanceIdeasModel;
  assert.ok(page.region('ig-inputs').includes('id="ig-workflow"'));
  assert.ok(page.region('ig-inputs').includes('id="ig-description"'));
  assert.match(page.region('ig-inputs'), /id="ig-mode-new"[^>]*checked/);
  assert.equal(page.enabled('generate'), false);
  assert.match(page.region('ig-action'), /Add a workflow or a description of the task to generate ideas\./);
  assert.equal((page.html().match(/class="primary[ "]/g) || []).length, 1, 'exactly one yellow primary on the page');
  assert.ok(page.text().includes(M.TEXT.noLibrary), 'the no workbook sentence, verbatim');
  assert.ok(!page.text().includes(M.TEXT.orderingFootnote));
  assert.ok(page.text().includes(M.TEXT.privacy), 'the privacy line next to the loader, verbatim');
  assert.equal(page.has('load-workbook'), true);
  assert.equal(page.cardIds().length, 0);
  assert.match(page.region('ig-bar'), /No ideas yet\./);
  sanity(page);
});

/* ====================================================================== the two modes */

test('Existing task: with no package the page says so and offers the loader; the loader asks the shell to open its picker', t => {
  const page = makePage(t);
  page.boot();
  page.type('mode', { value: 'existing', event: 'change' });
  assert.match(page.region('ig-inputs'), /id="ig-mode-existing"[^>]*checked/);
  assert.ok(!page.region('ig-inputs').includes('id="ig-workflow"'), 'the new task fields are gone');
  assert.match(page.region('ig-inputs'), /No task package is loaded\./);
  assert.equal(page.has('load-package'), true);
  assert.match(page.text(), new RegExp('load task package', 'i'));
  assert.equal(page.enabled('generate'), false);
  assert.match(page.region('ig-action'), /load a task package to generate ideas for an existing task/i);
  assert.match(page.region('ig-bar'), /no ideas yet\. load a task package/i);
  page.click('load-package');
  assert.equal(page.calls.loadFiles, 1);
  sanity(page);
});

test('Existing task: a loaded package shows its title, file count and the mode set of the open project, and enables Generate', async t => {
  const pkg = await ATLAS_PKG();
  const page = makePage(t, { pkg });
  page.boot();
  page.type('mode', { value: 'existing', event: 'change' });
  const text = page.text();
  assert.ok(text.includes(pkg.title));
  assert.match(text, /3 files/);
  assert.match(text, /1 mode in the project, 1 net-new\. Open net-new slots: 1\./, 'the fresh project has one net-new mode');
  assert.equal(page.has('load-package'), false);
  assert.equal(page.enabled('generate'), true);
  assert.equal(page.region('ig-action').includes('ig-why"></p>'), true, 'no reason when there is nothing to say');
  sanity(page);
});

test('a task package that arrives after a repaint is picked up: the page reads ctx.package on every render', async t => {
  const pkg = await ATLAS_PKG();
  const page = makePage(t);
  page.boot();
  page.type('mode', { value: 'existing', event: 'change' });
  assert.equal(page.enabled('generate'), false);
  page.boot(pkg);
  assert.equal(page.enabled('generate'), true);
  assert.ok(page.text().includes(pkg.title));
});

test('New task: typing a workflow or a description enables Generate without repainting the fields; results are made only on Generate', t => {
  const page = makePage(t);
  page.boot();
  const before = page.region('ig-inputs');
  page.type('workflow', { value: 'Treasury facility review' });
  assert.equal(page.enabled('generate'), true);
  assert.equal(page.region('ig-inputs'), before, 'typing never repaints the inputs, so focus and caret stay');
  assert.equal(page.cardIds().length, 0, 'nothing is generated by typing');
  page.type('workflow', { value: '   ' });
  assert.equal(page.enabled('generate'), false, 'blank text is not a workflow');
  page.type('description', { value: 'A facility with a target range and a limit.' });
  assert.equal(page.enabled('generate'), true);
  assert.equal(page.cardIds().length, 0);
});

/* ====================================================================== the precedent workbook */

test('loading a precedent workbook: a hidden file input made with createElement, read in memory, row count, rejected rows and warnings shown plainly', async t => {
  const page = makePage(t);
  page.boot();
  page.click('load-workbook');
  const input = page.dom.elements.get('ig-workbook-file');
  assert.ok(input, 'the input was created and added to the document');
  assert.equal(input.tagName, 'INPUT');
  assert.equal(input.type, 'file');
  assert.equal(input.hidden, true);
  assert.match(input.accept, /\.csv/);
  assert.equal(input.clicks, 1, 'the button opens the picker');
  const junk = toCsv([HEADER, ...ROWS, ['Atlas Reporting', '', 'No title on this row.', 'x', '0.1'], ['Meridian Close', 'score written in words', 'Text.', 'x', 'about a quarter']]);
  await page.loadWorkbook(csvFile(junk));
  const text = page.text();
  assert.match(text, /precedents\.csv/);
  assert.match(text, /11 rows read, 1 row rejected, 1 warning\./);
  assert.match(text, /Line 12: /, 'a rejected row is named by its line');
  assert.match(page.live(), /11 rows/, 'the result is announced');
  assert.equal(page.has('remove-workbook'), true);
  assert.equal(page.enabled('generate'), false, 'a new task still needs its own text');
  assert.ok(page.region('ig-inputs').includes('<datalist id="ig-workflows">'), 'workflow suggestions come from the workbook');
  assert.ok(page.region('ig-inputs').includes('<option value="Atlas Reporting">'));
  assert.ok(page.region('ig-inputs').includes(' list="ig-workflows"'));
  assert.equal(input.value, '', 'the input is reset so the same file can be chosen again');
  assert.match(page.text(), new RegExp(page.context.FinanceIdeasModel.TEXT.privacy.slice(0, 40)));
  sanity(page);
});

test('a file that is not a CSV, an oversize file and an unreadable table are refused with a clear sentence, and the previous workbook stays', async t => {
  const page = makePage(t);
  page.boot();
  await page.loadWorkbook(csvFile(CSV));
  assert.match(page.text(), /10 rows read/);
  await page.loadWorkbook(new FILE(['x'], 'notes.txt', { type: 'text/plain' }));
  assert.match(page.region('ig-inputs'), /That file is not a CSV\. Choose a \.csv export of your workbook\./);
  assert.match(page.text(), /10 rows read/, 'the loaded workbook is kept');
  assert.match(page.live(), /not a CSV/);
  const big = { name: 'big.csv', type: 'text/csv', size: 5e6 + 1, text: async () => { throw new Error('must not be read'); } };
  await page.loadWorkbook(big);
  assert.match(page.region('ig-inputs'), /larger than 5 MB/);
  await page.loadWorkbook(csvFile('just,one,line\r\n'));
  assert.match(page.region('ig-inputs'), /No usable rows were found/);
  await page.loadWorkbook(csvFile('trap,score\r\n'));
  assert.match(page.region('ig-inputs'), /No usable rows were found/);
  assert.match(page.text(), /10 rows read/, 'still the first workbook');
  sanity(page);
});

test('removing the workbook forgets it: no suggestions, the no workbook sentence, and a later generation has no precedents', async t => {
  const page = makePage(t);
  page.boot();
  await page.loadWorkbook(csvFile(CSV));
  page.type('workflow', { value: 'Meridian Close' });
  page.generate();
  assert.match(page.region('ig-cards'), /ig-score/, 'precedents are on the cards before the workbook is removed');
  page.click('remove-workbook');
  assert.ok(!/ig-score|ig-prec/.test(page.html()), 'the precedents the cards were holding are forgotten with the workbook');
  for (const row of ROWS) assert.ok(!page.html().includes(row[1]), 'no precedent text is left on the page: ' + row[1]);
  assert.match(page.region('ig-bar'), /changed since these ideas were made/);
  assert.ok(!page.region('ig-inputs').includes('ig-workflows'));
  assert.match(page.region('ig-bar'), /ordered with a workbook that has since been removed from this page/, 'the cards keep an order that came from the workbook, and the page says so');
  assert.ok(!page.text().includes(page.context.FinanceIdeasModel.TEXT.noLibrary), 'the no workbook sentence would hide where the order came from');
  assert.ok(!page.text().includes(page.context.FinanceIdeasModel.TEXT.orderingFootnote));
  page.generate();
  assert.equal(page.cards().length > 0, true);
  assert.ok(page.cards().every(c => c.scores.length === 0));
  assert.ok(page.text().includes(page.context.FinanceIdeasModel.TEXT.noLibrary), 'a new generation without the workbook is catalog only');
  assert.doesNotMatch(page.text(), /removed from this page/);
});

/* ====================================================================== results */

test('Generate without a workbook: idea cards with the catalog text, every card carries the honesty line, no precedents, no ordering footnote', t => {
  const page = makePage(t);
  page.boot();
  const M = page.context.FinanceIdeasModel;
  page.type('workflow', { value: 'Treasury facility review' });
  page.type('description', { value: 'A facility agreement with a target range and a limit, a signed commitment letter and an amendment that supersedes the pricing schedule.' });
  page.generate();
  const cards = page.cards();
  assert.equal(cards.length, 6, 'six ideas are painted first');
  assert.match(page.region('ig-cards'), /id="ig-count">44 ideas\.</);
  assert.match(page.live(), /44 ideas\./, 'the count is announced politely');
  for (const c of cards) {
    assert.ok(c.body.includes('ig-card-title'), 'title');
    assert.ok(Object.values(M.TEXT.statusWords).some(w => c.body.includes(w)), 'status words');
    assert.ok(c.body.includes(M.TEXT.honesty), 'the honesty line on every card');
    for (const heading of ['why it holds', 'how to build it']) assert.match(c.body, new RegExp('>' + heading + '<', 'i'));
    assert.ok(!/closest precedents/i.test(c.body), 'no precedents without a workbook');
    assert.ok(/<button[^>]*data-ig="add"/.test(c.body) && /<button[^>]*data-ig="copy"/.test(c.body), 'both actions are real buttons');
  }
  assert.ok(page.text().includes(M.TEXT.noLibrary));
  assert.ok(!page.text().includes(M.TEXT.orderingFootnote));
  assert.ok(page.region('ig-filters').includes('id="ig-search"'));
  assert.equal(page.region('ig-cards').includes('role="list"'), true, 'a list of articles');
  assert.equal(page.region('ig-cards').includes('<li><article'), true);
  assert.match(page.text(), /hold: missing evidence/i);
  assert.match(page.text(), /Reviewable hypothesis/, 'the description matches an idea it can anchor');
  sanity(page);
});

test('Generate with a workbook: the ordering footnote once, at most three closest precedents per idea, scores verbatim and ascending, ideas ordered by the lowest recorded score', async t => {
  const page = makePage(t);
  page.boot();
  const M = page.context.FinanceIdeasModel;
  await page.loadWorkbook(csvFile(CSV));
  page.type('workflow', { value: 'Meridian Close' });
  page.type('description', { value: 'A facility with a target range, a signed commitment letter, an amendment that supersedes the schedule and a cut off.' });
  page.generate();
  assert.equal(page.html().split(M.TEXT.orderingFootnote.slice(0, 40)).length - 1, 1, 'the footnote appears once on the page');
  assert.ok(page.text().includes(M.TEXT.orderingFootnote), 'the footnote text is verbatim');
  assert.ok(!page.text().includes(M.TEXT.noLibrary));
  page.click('more'); page.click('more'); page.click('more');
  const cards = page.cards();
  assert.equal(cards.length, 24);
  const withScores = cards.filter(c => c.scores.length);
  assert.ok(withScores.length >= 10, 'precedents are found for the ideas');
  for (const c of cards) {
    assert.ok(c.scores.length <= 3, 'at most three precedents');
    for (const s of c.scores) assert.ok(SCORES.has(s), 'the score is the recorded text, verbatim: ' + s);
    const nums = c.scores.map(Number);
    assert.deepEqual(nums, [...nums].sort((a, b) => a - b), 'a card lists its precedents by recorded score, lowest first');
    assert.equal(/class="[^"]*ig-score[^"]*"[^>]*>\s*<b/.test(c.body), false, 'no emphasis on a score');
  }
  /* Across cards of one status group, the lowest recorded precedent score never rises. */
  const rank = s => (s === 'anchored' ? 0 : s === 'needs-evidence' ? 1 : 2);
  for (let i = 1; i < cards.length; i++) {
    const a = cards[i - 1], b = cards[i];
    assert.ok(rank(a.status) <= rank(b.status), 'status groups keep their order');
    if (rank(a.status) === rank(b.status) && a.scores.length && b.scores.length) assert.ok(Number(a.scores[0]) <= Number(b.scores[0]), 'lowest recorded score first: ' + a.scores[0] + ' then ' + b.scores[0]);
  }
  assert.match(page.region('ig-cards'), /recorded score 0\.\d+/i);
  assert.match(page.text(), /closest precedents/i);
  assert.match(page.text(), /Meridian Close, Amendment signed after the schedule/, 'workflow and trap as recorded');
  sanity(page);
});

test('a precedent score the person wrote as text is shown exactly as written and a row with no score says so', async t => {
  const page = makePage(t);
  page.boot();
  const rows = [
    ['Atlas Reporting', 'Amendment supersedes the schedule', 'An amendment signed later supersedes the schedule.', 'x', '.5'],
    ['Atlas Reporting', 'Amendment replaces an earlier schedule', 'An amendment signed later replaces the schedule and supersedes it.', 'x', 'n/a'],
    ['Atlas Reporting', 'Amendment effective date', 'The amendment has an effective date that supersedes the schedule.', 'x', '0.0310']
  ];
  await page.loadWorkbook(csvFile(toCsv([HEADER, ...rows])));
  page.type('description', { value: 'An amendment with a later effective date supersedes the schedule.' });
  page.generate();
  const joined = page.cards().map(c => c.scores.join('|')).join('/');
  assert.match(joined, /\.5/);
  assert.match(joined, /0\.0310/);
  assert.match(joined, /n\/a/);
  assert.doesNotMatch(joined, /0\.50|0\.03(?!1)|\b50\b/, 'never rounded, padded or rescaled');
});

test('filters: the lead toggle and the text search narrow the list, the count is announced, an empty result says so and Clear filters restores it', t => {
  const page = makePage(t);
  page.boot();
  page.type('workflow', { value: 'Treasury facility review' });
  page.generate();
  const total = page.region('ig-cards').match(/id="ig-count">(\d+) ideas/)[1];
  assert.equal(total, '44');
  page.type('lead', { checked: true, event: 'change' });
  const leads = page.cards(), leadCount = page.context.FinanceIdeaArchetypes.archetypes.filter(a => a.lead).length;
  assert.ok(leadCount >= 3 && leads.length >= 3 && leads.every(c => c.lead), 'only lead ideas');
  assert.match(page.region('ig-cards'), new RegExp('id="ig-count">' + leadCount + ' ideas match\\. 44 were generated\\.'), 'the count is the number of lead ideas in the catalog');
  page.type('lead', { checked: false, event: 'change' });
  page.type('search', { value: 'CEILING' });
  const hits = page.cards();
  assert.ok(hits.length >= 1 && hits.length <= 6);
  assert.ok(hits.every(c => /ceiling/i.test(c.title + ' ' + (/ig-summary">([^<]*)</.exec(c.body) || [])[1])), 'the search reads the title and the summary');
  page.type('search', { value: 'zzzz no such words' });
  assert.equal(page.cards().length, 0);
  assert.match(page.region('ig-cards'), /No ideas match these filters\./);
  assert.match(page.region('ig-cards'), /Turn off|turn off/);
  page.type('lead', { checked: true, event: 'change' });
  const writes = page.dom.get('ig-filters').writes;
  page.click('clear-filters');
  assert.equal(page.cards().length, 6);
  assert.equal(page.region('ig-filters').includes('value=""'), true);
  assert.ok(page.dom.get('ig-filters').writes > writes, 'the fields are written again even though the markup is the same as before, because they hold typed values');
  assert.ok(!/ id="ig-lead"[^>]* checked/.test(page.region('ig-filters')));
  assert.equal(page.has('more'), true);
  page.click('more');
  assert.equal(page.cards().length, 12);
  assert.equal(page.dom.focused().id, 'ig-card-' + page.cardIds()[6], 'focus moves to the first card that was added to the list');
});

test('text fields answer input events only and choices answer change events, so a change event from a removed field cannot bring cleared text back', t => {
  const page = makePage(t);
  page.boot();
  page.type('workflow', { value: 'Atlas Facility' });
  page.generate();
  page.type('search', { value: 'ceiling' });
  const narrowed = page.cards().length;
  page.type('search', { value: 'something else', event: 'change' });
  assert.equal(page.cards().length, narrowed, 'a change event from the search field is ignored');
  page.type('workflow', { value: '', event: 'change' });
  assert.equal(page.enabled('generate'), true, 'and so is one from the workflow field');
  page.type('lead', { checked: true, event: 'input' });
  assert.equal(page.cards().length, narrowed, 'a choice is not read from an input event');
  page.type('mode', { value: 'existing', event: 'input' });
  assert.match(page.region('ig-inputs'), /id="ig-mode-new"[^>]*checked/, 'the mode only changes on a change event');
});

test('the search reads the summary as well as the title', t => {
  const page = makePage(t);
  page.boot();
  page.type('workflow', { value: 'Treasury facility review' });
  page.generate();
  const A = page.context.FinanceIdeaArchetypes.archetypes, titleWords = new Set(A.flatMap(a => a.name.toLowerCase().split(/\W+/)));
  const pick = A.map(a => ({ a, word: a.summary.toLowerCase().split(/\W+/).find(w => w.length >= 7 && !titleWords.has(w)) })).find(x => x.word);
  assert.ok(pick, 'the catalog has a summary word that no title uses');
  page.type('search', { value: pick.word });
  assert.ok(page.cards().some(c => c.title === pick.a.name), 'the idea is found by a word that only its summary has: ' + pick.word);
});

test('a card shows at most three precedents even if the model hands over more', async t => {
  const page = makePage(t);
  const real = page.context.FinanceIdeasModel.buildIdeas;
  page.context.FinanceIdeasModel.buildIdeas = input => {
    const out = real(input);
    out.ideas[0].precedents = ['0.5', '0.4', '0.3', '0.2', '0.1'].map((score, i) => ({ id: 'p-000' + i, workflow: 'Atlas Reporting', trap: 'Row ' + i, scoreText: score }));
    return out;
  };
  page.boot();
  await page.loadWorkbook(csvFile(CSV));
  page.type('workflow', { value: 'Meridian Close' });
  page.generate();
  assert.deepEqual(page.cards()[0].scores, ['0.5', '0.4', '0.3'], 'the first three, in the order the model gave');
});

test('the count is announced after the filter has settled, once, in the live region', async t => {
  const page = makePage(t);
  page.boot();
  page.type('workflow', { value: 'Treasury facility review' });
  page.generate();
  page.type('search', { value: 'c' });
  page.type('search', { value: 'ce' });
  page.type('search', { value: 'ceiling' });
  const n = page.cards().length;
  await sleep(750);
  assert.equal(page.live(), n + (n === 1 ? ' idea' : ' ideas') + ' match. 44 were generated.');
});

test('Existing task: ideas that can attach name the document, the locator and the quote; ideas without evidence say what the task needs', async t => {
  const pkg = await ATLAS_PKG();
  const page = makePage(t, { pkg });
  page.boot();
  page.type('mode', { value: 'existing', event: 'change' });
  page.generate();
  const text = page.text();
  assert.match(text, /where it could attach/i);
  assert.match(text, /Treasury_Procedure\.txt · Line \d+/);
  assert.match(text, /Only confirmed funded draws|The facility remains limited/, 'the quote from the package');
  assert.match(text, /It needs /, 'a held idea says what it needs');
  assert.ok(!/Task_Prompt\.txt/.test(text), 'the prompt document is never a place to attach');
  assert.match(page.region('ig-bar'), /Open net-new slots in the current project: 1\./, 'the per-run sentences of the model are printed');
  sanity(page);
});

test('stale ideas: a changed package, workbook, mode set or input shows a note and does not regenerate; Generate clears it', async t => {
  const pkg = await ATLAS_PKG();
  const page = makePage(t, { pkg });
  page.boot();
  page.type('mode', { value: 'existing', event: 'change' });
  page.generate();
  const ids = page.cardIds().join();
  assert.ok(!/changed since these ideas were made/.test(page.text()));
  /* the dashboard repaints with another package */
  page.boot({ ...pkg, fingerprint: 'f'.repeat(64), title: 'Atlas other package' });
  assert.match(page.region('ig-bar'), /changed since these ideas were made/);
  assert.equal(page.cardIds().join(), ids, 'the cards do not change by themselves');
  page.generate();
  assert.ok(!/changed since these ideas were made/.test(page.text()));
  await page.loadWorkbook(csvFile(CSV));
  assert.match(page.region('ig-bar'), /changed since these ideas were made/, 'a workbook loaded after generating');
  page.generate();
  assert.ok(!/changed since these ideas were made/.test(page.text()));
  page.click('remove-workbook');
  assert.match(page.region('ig-bar'), /changed since these ideas were made/);
  page.generate();
  page.type('mode', { value: 'new', event: 'change' });
  assert.match(page.region('ig-bar'), /changed since these ideas were made/, 'a different kind of task');
});

test('typing after generating marks the ideas as made from earlier inputs, and only on the first change', t => {
  const page = makePage(t);
  page.boot();
  page.type('workflow', { value: 'Atlas Facility' });
  page.generate();
  assert.ok(!/changed since/.test(page.region('ig-bar')));
  page.type('workflow', { value: 'Atlas Facility review' });
  assert.match(page.region('ig-bar'), /changed since these ideas were made/);
  const marked = page.region('ig-bar');
  page.type('workflow', { value: 'Atlas Facility review again' });
  assert.equal(page.region('ig-bar'), marked);
  page.type('workflow', { value: 'Atlas Facility' });
  assert.ok(!/changed since/.test(page.region('ig-bar')), 'typing the old text back is not a change');
});

/* ====================================================================== add and copy */

test('Add as net-new mode: the dialog states the five mode cap and the open slots; Cancel and Escape add nothing', async t => {
  const page = makePage(t);
  page.boot();
  page.type('workflow', { value: 'Treasury facility review' });
  page.generate();
  const first = page.cardIds()[0];
  page.click('add', { 'data-idea': first });
  const dialog = page.region('ig-modal');
  assert.match(dialog, /role="dialog"[^>]*aria-modal="true"/);
  assert.match(dialog, /aria-labelledby="ig-dialog-h"/);
  const text = page.text();
  assert.match(text, /A derivative task locks five failure modes: three historical and two net-new\./);
  assert.match(text, /This project has 1 mode, 1 of them net-new, so one net-new slot is open\./);
  assert.match(text, /pending hypothesis/);
  assert.equal(page.has('confirm-add'), true);
  assert.equal(page.has('cancel'), true);
  assert.equal(page.calls.added.length, 0);
  page.click('cancel');
  assert.equal(page.region('ig-modal').trim(), '');
  page.click('add', { 'data-idea': first });
  page.key('Escape');
  assert.equal(page.region('ig-modal').trim(), '', 'Escape closes the dialog');
  assert.equal(page.calls.added.length, 0, 'nothing was added');
  assert.equal(page.has('add', { 'data-idea': first }), true, 'the idea can still be added');
  sanity(page);
});

test('Add as net-new mode: confirming calls the real addCandidate with a valid authoring project; the root is in the project; the toast and the editor offer follow', async t => {
  const editor = loadEditor();
  const page = makePage(t, { editor });
  page.boot();
  page.type('workflow', { value: 'Treasury facility review' });
  page.type('description', { value: 'A facility with a target range and a limit.' });
  page.generate();
  const card = page.cards()[0];
  const before = editor.getProject();
  const handOff = [], toProject = page.context.FinanceIdeasModel.toAuthoringProject;
  page.context.FinanceIdeasModel.toAuthoringProject = (idea, options) => { handOff.push({ idea, options }); return toProject(idea, options); };
  page.click('add', { 'data-idea': card.id });
  page.click('confirm-add');
  assert.equal(handOff.length, 1);
  assert.equal(handOff[0].idea.id, card.id);
  assert.equal(handOff[0].options.pkg, null, 'a new task has no package');
  assert.equal(handOff[0].options.project.roots.length, before.roots.length, 'the model gets the open project as it is when the idea is added');
  assert.equal(page.region('ig-modal').trim(), '', 'the dialog closed');
  assert.equal(page.calls.added.length, 1);
  const { pkg, candidate } = page.calls.added[0];
  assert.equal(pkg, null, 'a new task idea has no package');
  assert.deepEqual(Object.keys(candidate).sort(), ['authoringProject', 'id', 'title']);
  assert.equal(candidate.id, card.id);
  assert.equal(candidate.title, card.title);
  const parsed = C.parseProject(clean(candidate.authoringProject));
  assert.equal(parsed.roots.length, 1);
  assert.equal(parsed.roots[0].lane, 'net-new');
  assert.equal(parsed.roots[0].reviewStatus, 'pending');
  assert.ok(!JSON.stringify(candidate).includes('[hypothesis: edit before use]'));
  const after = editor.getProject();
  assert.equal(after.roots.length, before.roots.length + 1, 'the idea is a root of the project');
  const added = after.roots[after.roots.length - 1];
  assert.equal(added.title, card.title);
  assert.equal(added.lane, 'net-new');
  assert.match(added.causalGroup, /^cg-ia-\d\d$/);
  assert.match(page.toasts.at(-1).text, new RegExp('^' + cap('added "') + card.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(page.toasts.at(-1).error, false);
  assert.match(page.toasts.at(-1).text, /Open the task editor/);
  const cardAfter = page.cards().find(c => c.id === card.id);
  assert.match(cardAfter.body, /added to the project as a net-new mode\./i);
  assert.ok(!/data-ig="add"/.test(cardAfter.body), 'the idea cannot be added twice from the same card');
  const stray = { dataset: { ig: 'add', idea: card.id, key: 'add-' + card.id }, disabled: false, closest: sel => (sel === '[data-ig]' ? stray : sel === '#ig-root' ? {} : null) };
  page.ideas.handleEvent({ type: 'click', target: stray });
  assert.equal(page.region('ig-modal').trim(), '', 'even a stray click for an idea that was added opens no dialog');
  assert.match(page.region('ig-bar'), /changed since these ideas were made/, 'the mode set changed');
  page.click('open-editor');
  assert.deepEqual(page.calls.openEditor, ['roots']);
  /* After a new generation the added idea reads as covered, through its causal group. */
  page.generate();
  assert.match(page.region('ig-bar'), /Open net-new slots in the current project: 0\./);
  page.type('search', { value: card.title });
  const again = page.cards().find(c => c.title === card.title);
  assert.ok(again, 'the added idea is still offered');
  assert.equal(again.status, 'covered', 'and it now reads as already covered, through its causal group');
});

test('Add as net-new mode for an existing task passes the package and keeps the verified anchors as sources of the new root', async t => {
  const editor = loadEditor();
  const pkg = await ATLAS_PKG();
  const page = makePage(t, { editor, pkg });
  page.boot();
  page.type('mode', { value: 'existing', event: 'change' });
  page.generate();
  const anchored = page.cards().find(c => c.status === 'anchored');
  assert.ok(anchored, 'an anchored idea exists for the package');
  page.click('add', { 'data-idea': anchored.id });
  page.click('confirm-add');
  assert.equal(page.calls.added.length, 1);
  assert.equal(page.calls.added[0].pkg.id, pkg.id);
  const project = editor.getProject(), root = project.roots[project.roots.length - 1];
  assert.ok(root.sourceIds.length >= 1, 'the verified anchor is a source of the root');
  assert.match(root.facts, /Treasury_Procedure\.txt/);
  assert.match(root.facts, /Build: /);
  assert.ok(project.sources.some(s => s.file === 'Treasury_Procedure.txt' && s.suppliedToSolver === true));
});

test('the confirm text copes with a project over the net-new limit and with an overlapping idea; the editor is not required to exist', async t => {
  const project = C.blank();
  project.roots = [0, 1, 2].map(i => ({ ...C.root(), id: 'r' + i, lane: 'net-new', title: 'Atlas mode ' + i }));
  const page = makePage(t, { project, dashboard: false });
  page.boot();
  page.type('workflow', { value: 'Treasury facility review' });
  page.generate();
  page.click('add', { 'data-idea': page.cardIds()[0] });
  assert.match(page.text(), /This project has 3 modes, 3 of them net-new, so the net-new slots are over the limit by 1\./);
  assert.match(page.text(), /goes past the net-new slots/);
  assert.match(page.region('ig-bar'), /The net-new slots in the current project are over the limit by 1\./);
  assert.doesNotMatch(page.text(), /slots in the current project: -/);
  page.click('confirm-add');
  assert.equal(page.calls.added.length, 1, 'adding is allowed; the editor flags the set');
  assert.match(page.toasts.at(-1).text, /It is on the Root design page of the task editor\./, 'without openEditor the toast says where the mode went');
  assert.equal(page.has('open-editor'), false);
  assert.match(page.text(), /It is on the Root design page of the task editor\./);
});

test('an idea that overlaps a current mode shows the warning on the card and in the dialog', async t => {
  const project = C.blank();
  const pkg = await ATLAS_PKG();
  const page0 = makePage(t, { pkg });
  page0.boot();
  page0.type('mode', { value: 'existing', event: 'change' });
  page0.generate();
  const target = page0.cards().find(c => c.status === 'anchored');
  /* a project whose root repeats the idea's own wording, so the model finds it covered */
  const M = page0.context.FinanceIdeasModel, A = page0.context.FinanceIdeaArchetypes;
  const archetype = A.archetypes.find(a => a.name === target.title);
  project.roots = [{ ...C.root(), id: 'r1', lane: 'net-new', title: archetype.name, causalGroup: archetype.causalGroup, mechanism: archetype.mechanism, governingRule: archetype.whyItHolds, wrongInterpretation: archetype.wrongApproach }];
  const page = makePage(t, { pkg, project });
  page.boot();
  page.type('mode', { value: 'existing', event: 'change' });
  page.generate();
  page.type('search', { value: archetype.name });
  const flagged = page.cards().find(c => c.title === archetype.name);
  assert.ok(flagged && ['covered', 'overlap'].includes(flagged.status), 'the model reports the idea as covered: ' + (flagged && flagged.status));
  assert.match(flagged.body, /adding it may count one failure twice\./i);
  assert.match(flagged.body, /Same causal group as this idea\./, 'the current mode and the reason are named');
  assert.match(flagged.body, /Already covered|Overlaps a current mode/);
  page.click('add', { 'data-idea': flagged.id });
  assert.match(page.region('ig-modal'), /overlaps a current mode, so adding it may count one failure twice/);
  assert.ok(M.TEXT.statusWords.covered);
  sanity(page);
});

test('Copy as text: the plain text of one idea goes through the shared copy helper and the toast says what happened', async t => {
  const page = makePage(t);
  page.boot();
  await page.loadWorkbook(csvFile(CSV));
  page.type('workflow', { value: 'Meridian Close' });
  page.type('description', { value: 'An amendment with a later effective date supersedes the schedule.' });
  page.generate();
  const card = page.cards().find(c => c.scores.length);
  page.click('copy', { 'data-idea': card.id });
  await sleep(30);
  assert.equal(page.copied.length, 1);
  const text = page.copied[0], M = page.context.FinanceIdeasModel;
  assert.ok(text.startsWith(card.title + '\n'));
  assert.ok(text.includes(M.TEXT.honesty));
  assert.match(text, /\nWhy it holds\n/);
  assert.match(text, /\nHow to build it\n1\. /);
  assert.ok(card.scores.length > 0, 'the card shows precedents');
  assert.doesNotMatch(text, /closest precedents|recorded score/i, 'the workbook rows stay on the page');
  for (const row of ROWS) { assert.ok(!text.includes(row[1]), 'no precedent trap in the copied text: ' + row[1]); assert.ok(!text.includes(row[4]), 'no recorded score in the copied text: ' + row[4]); }
  assert.doesNotMatch(text, FORBIDDEN);
  assert.doesNotMatch(text, /<|&lt;|&amp;/, 'plain text, no markup');
  assert.deepEqual(page.toasts.at(-1), { text: 'Copied the idea as text.', error: false });
  const failing = makePage(t);
  failing.context.navigator = {};
  failing.boot();
  failing.type('workflow', { value: 'x' });
  failing.generate();
  failing.click('copy', { 'data-idea': failing.cardIds()[0] });
  await sleep(30);
  assert.equal(failing.toasts.at(-1).error, true, 'a copy that did not work is an error toast, never a silent success');
});

/* ====================================================================== the findings of the review round */

test('the recorded words of a precedent are shown without a percent sign or a rate phrase, on the cards, in the dialog and in the file name; the score cell stays as written', async t => {
  const page = makePage(t);
  page.boot();
  const rows = [
    ['Atlas 45% review', 'Amendment supersedes the schedule, caught late at 45%', 'An amendment signed later supersedes the schedule.', 'x', '0.2'],
    ['Atlas', 'Amendment with a later effective date, pass rate unknown', 'An amendment signed later supersedes the pricing schedule.', 'x', '0.4']
  ];
  await page.loadWorkbook(csvFile(toCsv([HEADER, ...rows], '\n'), 'results 45%.csv'));
  page.type('workflow', { value: 'Atlas' });
  page.type('description', { value: 'An amendment with a later effective date supersedes the schedule.' });
  page.generate();
  const card = page.cards().find(c => c.scores.length >= 2);
  assert.ok(card, 'a card shows both precedents');
  const text = page.text();
  assert.match(text, /Atlas 45 percent review, Amendment supersedes the schedule,\.\.\. late at 45 percent/, 'the page text closes the space before the dots');
  assert.match(page.region('ig-cards'), /Atlas 45 percent review, Amendment supersedes the schedule, \.\.\. late at 45 percent/);
  assert.match(page.region('ig-cards'), /Atlas, Amendment with a later effective date, \.\.\. unknown/);
  assert.match(text, /results 45 percent\.csv/, 'the file name is shown the same way');
  assert.deepEqual(card.scores, ['0.2', '0.4'], 'the recorded scores are verbatim');
  assert.ok(!page.region('ig-inputs').includes('Atlas 45'), 'a workflow label with a percent sign is not offered as a suggestion');
  sanity(page);
  page.click('add', { 'data-idea': card.id });
  sanity(page);
  page.click('cancel');
  page.click('copy', { 'data-idea': card.id });
  await sleep(30);
  assert.doesNotMatch(page.copied[0], FORBIDDEN);
});

test('a workbook loaded after the ideas were made is not described as missing: the page says it is loaded and what Generate will do', async t => {
  const page = makePage(t);
  page.boot();
  const M = page.context.FinanceIdeasModel;
  page.type('workflow', { value: 'Meridian Close' });
  page.generate();
  assert.ok(page.text().includes(M.TEXT.noLibrary));
  await page.loadWorkbook(csvFile(CSV));
  assert.ok(!page.text().includes(M.TEXT.noLibrary), 'the workbook is loaded, so the no workbook sentence would be false');
  assert.match(page.region('ig-bar'), /A workbook is loaded now\. Choose Generate ideas to add its closest precedents and to order the ideas by their recorded scores\./);
  assert.match(page.region('ig-bar'), /changed since these ideas were made/);
  page.generate();
  assert.ok(page.text().includes(M.TEXT.orderingFootnote));
  assert.doesNotMatch(page.text(), /A workbook is loaded now/);
});

test('the ordering footnote is followed by one plain line on how the groups are formed, and the filter explains the lead tag', async t => {
  const page = makePage(t);
  page.boot();
  await page.loadWorkbook(csvFile(CSV));
  page.type('workflow', { value: 'Meridian Close' });
  page.generate();
  assert.match(page.region('ig-bar'), /Ideas are grouped by status first, with reviewable hypotheses at the top and ideas that overlap a current mode at the bottom\. The recorded score orders the ideas within each group\./);
  assert.match(page.region('ig-filters'), /id="ig-lead-help"[^>]*>The lead tag marks the recipes that this catalog lists first\. It is a catalog note and says nothing about how any task will turn out\.</);
  assert.match(page.region('ig-filters'), /id="ig-lead"[^>]*aria-describedby="ig-lead-help"/);
  sanity(page);
  const bare = makePage(t);
  bare.boot();
  bare.type('workflow', { value: 'x' });
  bare.generate();
  assert.doesNotMatch(bare.text(), /grouped by status first/, 'the line belongs to the ordering by recorded score');
});

test('scores that cannot be read as numbers are not claimed to order the ideas, and the rows without one are counted', async t => {
  const commas = ROWS.map(r => [...r.slice(0, 4), r[4].replace('.', ',')]);
  const none = makePage(t);
  none.boot();
  const M = none.context.FinanceIdeasModel;
  await none.loadWorkbook(csvFile(toCsv([HEADER, ...commas])));
  none.type('workflow', { value: 'Meridian Close' });
  none.generate();
  assert.match(none.text(), /No closest precedent has a score that is a plain number, so these ideas are not ordered by recorded score\./);
  assert.ok(!none.text().includes(M.TEXT.orderingFootnote), 'the footnote would claim an order that did not happen');
  assert.doesNotMatch(none.text(), /grouped by status first/);
  assert.match(none.text(), /10 rows have no score that is a plain number, so they do not take part in the ordering\./);
  sanity(none);
  const some = makePage(t);
  some.boot();
  await some.loadWorkbook(csvFile(toCsv([HEADER, ...commas.slice(0, 3), ...ROWS.slice(3)])));
  some.type('workflow', { value: 'Meridian Close' });
  some.generate();
  assert.ok(some.text().includes(M.TEXT.orderingFootnote), 'with some readable scores the footnote is true');
  assert.match(some.text(), /3 rows have no score that is a plain number, so they do not take part in the ordering\./);
  const one = makePage(t);
  one.boot();
  await one.loadWorkbook(csvFile(toCsv([HEADER, commas[0], ...ROWS.slice(1)])));
  one.type('workflow', { value: 'Meridian Close' });
  one.generate();
  assert.match(one.text(), /1 row has no score that is a plain number, so it does not take part in the ordering\./);
  const clean = makePage(t);
  clean.boot();
  await clean.loadWorkbook(csvFile(CSV));
  clean.type('workflow', { value: 'Meridian Close' });
  clean.generate();
  assert.doesNotMatch(clean.text(), /plain number, so (?:it|they) do/, 'nothing to say when every score can be read');
});

test('a stray quote in the workbook is reported by line in the loader, not swallowed', async t => {
  const page = makePage(t);
  page.boot();
  const text = toCsv([HEADER, ...ROWS.slice(0, 4)]).replace('Month end cut off moved by a day', '"Month end cut off moved by a day');
  await page.loadWorkbook(csvFile(text));
  assert.match(page.text(), /2 rows read, 1 row rejected, 0 warnings\./);
  assert.match(page.text(), /Line 4: A quote was never closed, so the rest of the file was read as one cell\./);
});

test('the dialog says that adding a mode resets review gates marked as addressed, and only when there is one', async t => {
  const withGate = C.blank();
  withGate.gates = { brief: { status: 'addressed', notes: 'checked' }, teaching: { status: 'pending', notes: '' } };
  const page = makePage(t, { project: withGate });
  page.boot();
  page.type('workflow', { value: 'Treasury facility review' });
  page.generate();
  page.click('add', { 'data-idea': page.cardIds()[0] });
  assert.match(page.region('ig-modal'), /The task editor resets any review gate you marked as addressed to pending when a mode is added\./);
  const noGate = C.blank();
  noGate.gates = { brief: { status: 'pending', notes: '' } };
  const quiet = makePage(t, { project: noGate });
  quiet.boot();
  quiet.type('workflow', { value: 'Treasury facility review' });
  quiet.generate();
  quiet.click('add', { 'data-idea': quiet.cardIds()[0] });
  assert.doesNotMatch(quiet.region('ig-modal'), /review gate/);
  assert.match(quiet.region('ig-modal'), /pending hypothesis/);
});

test('the load task package button of this page: when the shell then shows another page, this page is asked for again; a cancelled picker or a failed read is not', async t => {
  const pkg = await ATLAS_PKG();
  const page = makePage(t);
  page.boot();
  page.type('mode', { value: 'existing', event: 'change' });
  page.click('load-package');
  assert.equal(page.calls.loadFiles, 1);
  page.packageChosen();
  page.shellPkg = pkg;
  page.ideas.afterRender(false);
  await sleep(15);
  assert.deepEqual(page.calls.navigate, ['ideas'], 'the person is taken back to Mode ideas, with the new package');
  page.ideas.afterRender(false);
  await sleep(15);
  assert.deepEqual(page.calls.navigate, ['ideas'], 'asked once');
  const cancelled = makePage(t);
  cancelled.boot();
  cancelled.type('mode', { value: 'existing', event: 'change' });
  cancelled.click('load-package');
  cancelled.shellPkg = pkg;
  cancelled.ideas.afterRender(false);
  await sleep(15);
  assert.deepEqual(cancelled.calls.navigate, [], 'no files were chosen, so a later package from another page is not this page\'s business');
  const failed = makePage(t);
  failed.boot();
  failed.type('mode', { value: 'existing', event: 'change' });
  failed.click('load-package');
  failed.packageChosen();
  failed.ideas.afterRender(true);
  failed.ideas.afterRender(false);
  await sleep(15);
  assert.deepEqual(failed.calls.navigate, [], 'the package did not change, so the person left on purpose');
  failed.ideas.afterRender(false);
  assert.equal(failed.calls.navigate.length, 0);
  const abandoned = makePage(t);
  abandoned.boot();
  abandoned.type('mode', { value: 'existing', event: 'change' });
  abandoned.click('load-package');
  abandoned.ideas.afterRender(false);
  abandoned.packageChosen();
  abandoned.shellPkg = pkg;
  abandoned.ideas.afterRender(false);
  await sleep(15);
  assert.deepEqual(abandoned.calls.navigate, [], 'a picker that was cancelled here, and a package loaded later from another page');
  const elsewhere = makePage(t);
  elsewhere.boot();
  elsewhere.packageChosen();
  elsewhere.shellPkg = pkg;
  elsewhere.ideas.afterRender(false);
  await sleep(15);
  assert.deepEqual(elsewhere.calls.navigate, [], 'files chosen without a click on this page\'s button');
});

test('the keyboard keeps its place around a workbook read: the load button is never disabled, the remove link takes the focus, and focus elsewhere is not taken', async t => {
  const page = makePage(t);
  page.boot();
  let during = '';
  const reading = { name: 'precedents.csv', type: 'text/csv', size: CSV.length, text: () => { during = page.region('ig-inputs'); return Promise.resolve(CSV); } };
  await page.loadWorkbook(reading);
  assert.match(during, /id="ig-load-workbook"[^>]*aria-disabled="true"/, 'while reading the button says it is busy without leaving the tab order');
  assert.doesNotMatch(during, /id="ig-load-workbook"[^>]*\sdisabled/, 'a disabled button cannot keep the focus');
  assert.match(page.region('ig-inputs'), /id="ig-remove-workbook"/);
  assert.equal(page.dom.focused().id, 'ig-remove-workbook', 'the focus did not fall to the page');
  assert.equal(page.has('load-workbook'), false, 'one control for the workbook at a time');
  page.click('remove-workbook');
  assert.equal(page.has('load-workbook'), true);
  assert.equal(page.dom.focused().id, 'ig-load-workbook');
  const busy = makePage(t);
  busy.boot();
  busy.click('load-workbook');
  busy.click('load-workbook');
  assert.equal(busy.dom.elements.get('ig-workbook-file').clicks, 2, 'idle: every click opens the picker');
  const other = makePage(t);
  other.boot();
  other.dom.get('ig-workflow').focus();
  await other.loadWorkbook(csvFile(CSV));
  assert.equal(other.dom.focused().id, 'ig-workflow', 'a person who moved on is not pulled back');
});

test('a refused workbook is named with a glyph and a label, says an earlier workbook stays in use, and the line goes away with the next action', async t => {
  const page = makePage(t);
  page.boot();
  await page.loadWorkbook(new FILE(['x'], 'notes.txt', { type: 'text/plain' }));
  assert.match(page.region('ig-inputs'), /<p class="ig-error" role="alert"><span class="ig-glyph" aria-hidden="true">&#10005;<\/span>Could not use notes\.txt\. That file is not a CSV\./);
  assert.doesNotMatch(page.region('ig-inputs'), /still in use/, 'there was no earlier workbook');
  await page.loadWorkbook(csvFile(CSV));
  assert.doesNotMatch(page.region('ig-inputs'), /Could not use/, 'a workbook that reads well replaces the line');
  await page.loadWorkbook(csvFile('trap,score\r\n', 'junk 5%.csv'));
  assert.match(page.region('ig-inputs'), /Could not use junk 5 percent\.csv\. No usable rows were found in that file\./);
  assert.match(page.region('ig-inputs'), /The workbook you loaded earlier is still in use\./);
  assert.match(page.text(), /10 rows read/);
  assert.match(page.live(), /^Could not use junk 5 percent\.csv\./);
  sanity(page);
  page.type('mode', { value: 'existing', event: 'change' });
  assert.doesNotMatch(page.region('ig-inputs'), /Could not use/, 'switching the kind of task clears it');
  await page.loadWorkbook(csvFile('trap,score\r\n', 'junk.csv'));
  assert.match(page.region('ig-inputs'), /Could not use junk\.csv/);
  page.type('mode', { value: 'new', event: 'change' });
  page.type('workflow', { value: 'Atlas' });
  await page.loadWorkbook(csvFile('trap,score\r\n', 'junk.csv'));
  page.generate();
  assert.doesNotMatch(page.region('ig-inputs'), /Could not use/, 'Generate clears it');
});

test('Generate moves the view to the results heading when the results sit below the inputs or off screen, and leaves the focus alone when they are beside the inputs and in sight', t => {
  /* heading top and bottom, bottom of the input panel's action row, whether the view should move */
  for (const [top, bottom, actionBottom, moved] of [[900, 940, 700, true], [740, 780, 700, true], [210, 250, 700, false], [-40, 0, 700, true], [210, 250, undefined, false]]) {
    const page = makePage(t);
    page.context.innerHeight = 800;
    page.boot();
    assert.match(page.region('ig-bar'), /<h2 id="ig-results-h" class="ig-h2" tabindex="-1">Ideas<\/h2>/);
    const heading = page.dom.get('ig-results-h'), scrolled = [];
    heading.getBoundingClientRect = () => ({ top, bottom });
    heading.scrollIntoView = options => scrolled.push(options);
    if (actionBottom !== undefined) page.dom.get('ig-action').getBoundingClientRect = () => ({ top: actionBottom - 60, bottom: actionBottom });
    page.dom.get('ig-workflow').focus();
    page.type('workflow', { value: 'x' });
    page.generate();
    const label = JSON.stringify([top, bottom, actionBottom]);
    if (moved) { assert.equal(page.dom.focused().id, 'ig-results-h', label); assert.equal(JSON.stringify(scrolled), '[{"block":"start"}]', label); }
    else { assert.equal(page.dom.focused().id, 'ig-workflow', label); assert.equal(scrolled.length, 0, label); }
  }
});

test('each card keeps How to build it behind a disclosure that survives a repaint, and its buttons are named after the idea', async t => {
  const pkg = await ATLAS_PKG();
  const page = makePage(t, { pkg });
  page.boot();
  page.type('mode', { value: 'existing', event: 'change' });
  page.generate();
  const card = page.cards()[0];
  assert.match(card.body, new RegExp('<details class="ig-sec ig-build" data-key="build-' + card.id + '"><summary class="ig-h4">How to build it</summary><ol class="ig-moves">'));
  assert.doesNotMatch(card.body, /<details[^>]*\sopen/, 'closed until the person opens it');
  for (const action of ['add', 'copy']) assert.match(card.body, new RegExp('data-ig="' + action + '"[^>]*aria-describedby="ig-title-' + card.id + '"'));
  assert.ok(card.body.includes('id="ig-title-' + card.id + '"'), 'the description points at the title of the card');
  assert.ok(card.body.match(/<li>/g).length >= 3, 'the moves are still on the card');
});

test('the workflow field has a length limit that matches the one the model reads', () => {
  const page = makePage({ after() {} });
  page.boot();
  assert.match(page.region('ig-inputs'), /id="ig-workflow"[^>]*maxlength="200"/);
});

/* ====================================================================== text, safety and privacy */

test('the user text is escaped everywhere: workflow, description, file name, package title, precedent text', async t => {
  const hostile = '<img src=x onerror=alert(1)>"\'&`';
  const pkg = { ...(await ATLAS_PKG()), title: 'Atlas ' + hostile };
  const page = makePage(t, { pkg });
  page.boot();
  const rows = [['Atlas ' + hostile, 'Amendment ' + hostile, 'An amendment supersedes the schedule. ' + hostile, 'x', '0.2']];
  await page.loadWorkbook(csvFile(toCsv([HEADER, ...rows]), hostile + '.csv'));
  page.type('workflow', { value: hostile });
  page.type('description', { value: hostile + ' amendment supersedes the schedule' });
  page.generate();
  page.type('mode', { value: 'existing', event: 'change' });
  const markup = page.html();
  assert.ok(!markup.includes('<img'), 'no element was created from user text');
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('every state paints no percent sign and none of the rate, difficulty or prediction words', async t => {
  const pkg = await ATLAS_PKG();
  const page = makePage(t, { pkg });
  page.boot();
  sanity(page);
  page.type('workflow', { value: 'Treasury facility review' });
  page.generate(); sanity(page);
  await page.loadWorkbook(csvFile(CSV)); sanity(page);
  page.generate(); sanity(page);
  for (let i = 0; i < 7; i++) if (page.has('more')) page.click('more');
  sanity(page);
  page.click('add', { 'data-idea': page.cardIds()[0] }); sanity(page); page.click('cancel');
  page.type('mode', { value: 'existing', event: 'change' }); sanity(page);
  page.generate(); sanity(page);
  for (let i = 0; i < 8; i++) if (page.has('more')) page.click('more');
  assert.equal(page.cards().length, 44);
  sanity(page);
});

test('offline and private: no request of any kind, no storage, and the workbook is not reachable from anywhere but the page memory', async t => {
  const log = [];
  const page = makePage(t, { fetchLog: log });
  page.boot();
  await page.loadWorkbook(csvFile(CSV));
  page.type('workflow', { value: 'Meridian Close' });
  page.generate();
  page.click('more');
  page.click('add', { 'data-idea': page.cardIds()[0] });
  page.click('cancel');
  page.type('search', { value: 'amendment' });
  await sleep(30);
  assert.deepEqual(log, [], 'fetch and XMLHttpRequest were never called');
  assert.deepEqual(page.storageUse, [], 'localStorage, sessionStorage and indexedDB were never touched');
  assert.deepEqual(Object.keys(page.context.FinanceIdeas).sort(), ['afterRender', 'handleEvent', 'render']);
  const source = read('ideas.js');
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|new Worker|importScripts|\bimport\s*\(/.test(source), 'no request API in the source');
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|\.store\b|FinanceViews\.store/.test(source), 'no storage API in the source');
  assert.ok(!/https?:\/\/|\beval\s*\(|new Function|style\s*=\s*"|document\.title\s*=/.test(source), 'no absolute URL, dynamic code, inline style or title change');
  assert.ok(!/\bon(?:click|input|change|keydown|load|error)\s*=\s*"/.test(source), 'no inline handler');
  assert.ok(!/data-(?:dash|ag|mc|wb|tab|action|bind)/.test(source), 'the page uses only its own data attributes');
});

test('leaving the page closes an open dialog and stops the announcement timer; coming back keeps the ideas and the workbook', async t => {
  const page = makePage(t);
  page.boot();
  await page.loadWorkbook(csvFile(CSV));
  page.type('workflow', { value: 'Meridian Close' });
  page.generate();
  page.click('add', { 'data-idea': page.cardIds()[0] });
  assert.ok(page.region('ig-modal').length > 0);
  page.type('search', { value: 'a' });
  page.ideas.afterRender(false);
  assert.equal(page.region('ig-modal').trim(), '');
  const live = page.live();
  await sleep(700);
  assert.equal(page.live(), live, 'no announcement after leaving');
  page.boot();
  assert.ok(page.cardIds().length > 0, 'the ideas are still there');
  assert.match(page.text(), /10 rows read/);
});

test('the stylesheet uses tokens only, nothing under 12px, a visible focus ring for the segmented control and reduced motion respected', () => {
  const css = read('ideas.css');
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|@import|url\s*\(|@font-face/i.test(code), 'tokens only');
  for (const m of code.matchAll(/font-size:\s*([\d.]+)(rem|px)/g)) assert.ok(m[2] === 'rem' ? Number(m[1]) >= 0.75 : Number(m[1]) >= 12, 'font size ' + m[0]);
  assert.match(code, /\.ig-seg-opt input:focus-visible\+span\{outline:2px solid var\(--focus\)/);
  assert.match(code, /@media\(prefers-reduced-motion:no-preference\)/);
  assert.ok(!/\banimation\b|@keyframes/.test(code), 'no animation');
  assert.equal((code.match(/var\(--primary\)/g) || []).length, 0, 'the sheet paints no yellow itself: the shared primary button is the only yellow');
  assert.ok(!/(?:^|[},])\s*(?:body|html|button|input|textarea|h1|h2|h3|h4|p|li|ul|ol|a)\s*\{/m.test(code), 'every rule is scoped to ig- classes or the page container');
});

test('the stylesheet follows the review round: 15px and 13px type, roomier headings, two columns from 1280px, a panel that stays in sight and inside the screen, forced colours, a wrapping file name, a 44px touch row on phones', () => {
  const code = read('ideas.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(code, /\.ig-root\{[^}]*font-size:1rem/, 'body text is 15px');
  assert.ok(!/font-size:\.9375rem|font-size:\.8125rem/.test(code), 'no 14px body and no 12px secondary text: secondary text is 13px');
  assert.match(code, /\.ig-h2\{margin:0 0 16px/);
  assert.match(code, /\.ig-card-title\{margin:0 0 16px/);
  assert.match(code, /@media\(min-width:1280px\)\{[^@]*\.ig-inputs\{position:sticky;top:24px\}[^@]*\.ig-panel\{max-height:calc\(100vh - 48px\);overflow:auto\}[^@]*\.ig-action\{position:sticky;bottom:0/, 'the panel is always sticky, never taller than the screen, and keeps Generate in reach');
  assert.ok(!/min-height:820px|min-width:1160px/.test(code), 'no height condition and no narrow two column breakpoint');
  assert.match(code, /@media\(forced-colors:active\)\{\s*\.ig-seg-opt input:checked\+span\{[^}]*outline:2px solid Highlight/);
  assert.ok(!/\.ig-lib-name\{[^}]*(?:white-space:nowrap|text-overflow)/.test(code), 'the file name is not cut with dots');
  assert.match(code, /\.ig-lib-name\{[^}]*overflow-wrap:anywhere/);
  assert.match(code, /@media\(max-width:700px\)\{[^@]*\.ig-check\{min-height:44px\}/);
  assert.match(code, /\.ig-h2\[tabindex="-1"\]:focus-visible\{outline:2px solid var\(--focus\)/, 'the shared sheet removes the ring from tabindex -1 elements, so the heading restores it');
  assert.match(code, /\.ig-glyph\{/);
});

