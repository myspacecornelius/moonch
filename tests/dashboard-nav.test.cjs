'use strict';
/* The dashboard shell's navigation (dashboard.js), without a browser: the real file runs inside a vm with a small fake document.
   Mission Control and the Evidence Workbench are placeholder pages for now, so the shell does not list them and sends anything
   that asks for them to Overview. Their modules and scripts still load. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..');
const DASHBOARD_SOURCE = fs.readFileSync(path.join(REPO, 'dashboard.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

function makeShell({ location = { protocol: 'file:', hostname: '' } } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, innerHTML: '', textContent: '', className: '', hidden: false, dataset: {}, focus() {}, click() {} });
    return elements.get(id);
  };
  const listeners = {};
  const document = {
    activeElement: null, body: element('body'),
    querySelector: selector => { const match = /^#([\w-]+)$/.exec(selector); return match ? element(match[1]) : null; },
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
  };
  const context = vm.createContext({ document, location, setTimeout, clearTimeout, console, URL, Blob, TextEncoder, TextDecoder });
  context.window = context;
  context.scrollTo = () => {};
  context.FinancePackageEngine = { ENGINE_VERSION: 'test' };
  context.FinanceCore = {};
  context.FinanceCandidates = {};
  vm.runInContext(DASHBOARD_SOURCE, context, { filename: 'dashboard.js' });
  const dashboard = context.FinanceDashboard;
  assert.ok(dashboard && typeof dashboard.navigate === 'function', 'dashboard.js exports its API');
  const markup = () => element('dashboard-app').innerHTML;
  /* Navigation buttons as the sidebar draws them, in order: [view, label]. */
  const navButtons = () => [...markup().matchAll(/<button type="button" class="nav-btn[^"]*" data-dash-tab="([\w-]+)"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]*)/g)].map(m => [m[1], m[2]]);
  const groups = () => [...markup().matchAll(/<p class="nav-group">([^<]*)<\/p>/g)].map(m => m[1]);
  /* A click on any element that carries data-dash-tab, sent through the page's own listener. */
  const clickTab = (view, fromNav = true) => {
    const tab = { dataset: { dashTab: view }, closest: selector => (selector === '.dash-sidebar' && fromNav ? {} : null) };
    const target = { closest: selector => (selector === '[data-dash-tab]' ? tab : null) };
    for (const fn of listeners.click || []) fn({ target });
  };
  return { dashboard, markup, navButtons, groups, clickTab, element };
}

test('the sidebar lists the working pages only: no Workspace group, no Mission Control, no Evidence Workbench', () => {
  const shell = makeShell();
  assert.deepEqual(shell.groups(), ['Package analysis', 'Pilots']);
  assert.deepEqual(shell.navButtons(), [
    ['overview', 'Overview'], ['candidates', 'Candidate roots'], ['ideas', 'Mode ideas'], ['results', 'Results'], ['files', 'Source files'], ['history', 'Run history'], ['agents', 'Agents'],
  ]);
  for (const gone of ['Workspace', 'Mission Control', 'Evidence Workbench', 'data-dash-tab="mission"', 'data-dash-tab="workbench"']) assert.ok(!shell.markup().includes(gone), `the shell no longer draws: ${gone}`);
  assert.match(shell.markup(), /<p class="nav-group">Package analysis<\/p><button type="button" class="nav-btn active" data-dash-tab="overview"/, 'Package analysis is the first group and Overview its first page');
});

test('the shell starts on Overview, with the start page showing, not a blank or placeholder page', () => {
  const shell = makeShell();
  assert.equal(shell.dashboard.getView(), 'overview');
  assert.match(shell.markup(), /aria-current="page">[\s\S]*?Overview/);
  assert.match(shell.markup(), /Load a task package/);
  assert.doesNotMatch(shell.markup(), /id="mc-root"|id="wb-root"|<p>Mission Control<\/p>|<p>Evidence Workbench<\/p>/);
});

test('asking for Mission Control or the Evidence Workbench by navigate() is refused and the view stays where it was', () => {
  const shell = makeShell();
  assert.equal(shell.dashboard.navigate('mission'), false);
  assert.equal(shell.dashboard.navigate('workbench'), false);
  assert.equal(shell.dashboard.getView(), 'overview');
  assert.equal(shell.dashboard.navigate('ideas'), true);
  assert.equal(shell.dashboard.getView(), 'ideas');
  assert.equal(shell.dashboard.navigate('workbench'), false);
  assert.equal(shell.dashboard.getView(), 'ideas', 'a refused request does not move the person');
  assert.equal(shell.dashboard.navigate('nothing'), false);
  assert.equal(shell.dashboard.navigate('export'), true, 'the Save / export page is still reachable though it has no sidebar row');
  assert.equal(shell.dashboard.getView(), 'export');
});

test('a stale button, a hash or any other request for those pages lands on Overview, drawn, not blank', () => {
  const shell = makeShell();
  shell.clickTab('agents');
  assert.equal(shell.dashboard.getView(), 'agents');
  for (const stale of ['mission', 'workbench', 'Mission', '', 'constructor', '__proto__']) {
    shell.clickTab('agents');
    shell.clickTab(stale);
    assert.equal(shell.dashboard.getView(), 'overview', `a click that asks for ${JSON.stringify(stale)}`);
    assert.match(shell.markup(), /Load a task package/, 'Overview is drawn');
  }
  /* the shell reads no location hash or stored view today; a page opened with one still starts on Overview */
  for (const hash of ['#mission', '#workbench', '#view=mission']) {
    const opened = makeShell({ location: { protocol: 'file:', hostname: '', hash } });
    assert.equal(opened.dashboard.getView(), 'overview', hash);
    assert.match(opened.markup(), /Load a task package/);
  }
});

test('the placeholder modules still load: their scripts stay in index.html and the shell keeps its dispatch for them', () => {
  for (const name of ['mission.js', 'workbench.js', 'mission-model.js', 'workbench-model.js']) assert.ok(INDEX.includes(`<script defer src="${name}"></script>`), `${name} is still loaded by index.html`);
  assert.ok(fs.existsSync(path.join(REPO, 'mission.js')) && fs.existsSync(path.join(REPO, 'workbench.js')));
  assert.match(DASHBOARD_SOURCE, /mission:missionView,workbench:workbenchView/, 'the page dispatch still knows both views, so adding the rows back is a one-line change');
});
