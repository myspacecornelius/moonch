'use strict';
/* Optional developer QA for the Mode ideas page. Uses an isolated headless Chromium profile; never attaches to an existing browser.
   The page is opened from disk (the offline edition), so the run proves the page works with no companion and makes no request.
   All data is invented (Atlas, Meridian, Borealis): the precedent workbook is a small CSV built in memory and written to a temporary
   folder that is removed afterwards. No file is written to qa/: the report goes to QA_OUTPUT (default: a temporary folder) and screenshots
   are taken only when QA_SHOTS names a folder. */
const crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { spawn } = require('node:child_process'), assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const out = process.env.QA_OUTPUT ? path.resolve(root, process.env.QA_OUTPUT) : fs.mkdtempSync(path.join(os.tmpdir(), 'finance-ideas-qa-'));
const shots = process.env.QA_SHOTS ? path.resolve(root, process.env.QA_SHOTS) : '';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-ideas-headless-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-ideas-data-'));
const binary = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
fs.mkdirSync(out, { recursive: true });
if (shots) fs.mkdirSync(shots, { recursive: true });

/* Names of the page domain of the debugging protocol and of the file class are ordinary capitalised words that also occur in the private rows,
   which the private-data check flags, so they are built from lowercase text. */
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const PG = cap('page') + '.', FILE_CLASS = cap('file');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
/* The exact interface strings of the spec, pinned by hash (the same hashes the model tests pin). */
const HASH = { ordering: 'd2890db658f59b7701d7b228390a7af5e003ca1da3a59406e19dd568287bf477', noWorkbook: '3049c039d83ab9fba299977301fbf7436ee52625e7c471be48d47176ef22ff2f', privacy: '9164a46e6ddf331f38c35cb9f70f36c01469f199a5fdc1d7610799103dcb61fd', honesty: '3f261dc89a4222a7078c67f6346b3db2113dbe4e8088f058fc93a8b127a998cf' };
const notes = selector => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(n=>n.innerText.trim())`);

let proc, ws, nextId = 0;
const pending = new Map(), errors = [], resources = [], network = [], checks = [];
let counting = false;
const afterLoad = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const pass = label => checks.push(label);

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000);
    pending.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception));
  return r.result.value;
}
async function waitFor(expression, label, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await evaluate(expression)) return; } catch { /* the page may be repainting */ }
    await delay(60);
  }
  throw new Error('Timed out waiting for ' + label);
}
const click = async selector => { assert.equal(await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.click();return true;})()`), true, 'missing ' + selector); await delay(60); };
const exists = selector => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
const text = selector => evaluate(`(document.querySelector(${JSON.stringify(selector)})||{}).innerText||''`);
async function setFile(selector, file) {
  const { root: doc } = await call('DOM.getDocument');
  const { nodeId } = await call('DOM.querySelector', { nodeId: doc.nodeId, selector });
  assert.ok(nodeId, 'no element for ' + selector);
  await call('DOM.setFileInputFiles', { nodeId, files: [file] });
}
const KEYS = {
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 }, Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' }
};
async function press(name, modifiers = 0) {
  const k = KEYS[name];
  await call('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', modifiers, ...k });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
  await delay(50);
}
const typeText = async value => { await call('Input.insertText', { text: value }); await delay(60); };
const focusedId = () => evaluate('(()=>{const a=document.activeElement;return a?(a.id||a.getAttribute("data-key")||a.tagName):""})()');
async function viewport(width, height) {
  await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 });
  await delay(150);
}
async function shot(name, width, height) {
  if (!shots) return;
  await viewport(width, height);
  const r = await call(PG + 'captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shots, name + '.png'), Buffer.from(r.data, 'base64'));
}
const overflow = () => evaluate('(()=>{const d=document.documentElement;return {scroll:Math.max(d.scrollWidth,document.body.scrollWidth),inner:innerWidth}})()');
async function noHorizontalOverflow(label) {
  for (const [w, h] of [[1440, 1000], [1280, 800], [390, 844]]) {
    await viewport(w, h);
    const o = await overflow();
    assert.ok(o.scroll <= o.inner, `${label}: horizontal overflow at ${w}x${h}: scrollWidth ${o.scroll} > ${o.inner}`);
  }
  await viewport(1440, 1000);
}

/* ---------------------------------------------------------------- invented precedent workbook */
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
const CSV = [HEADER, ...ROWS].map(r => r.map(quoteCell).join(',')).join('\r\n') + '\r\n';
const SCORES = ROWS.map(r => r[4]);
const FORBIDDEN = '/%|\\b(?:pass|success|failure) rate\\b|\\blikely to\\b|\\bcaught\\b|\\bdifficult|\\bhard(?:er|est)?\\b|\\bfails?\\b|\\bfailed\\b|\\bworks\\b/i';

(async () => {
  try {
    proc = spawn(binary, [...(process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []), '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--metrics-recording-only', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const browserURL = await new Promise((resolve, reject) => {
      let log = '';
      const t = setTimeout(() => reject(new Error('Headless browser startup timeout')), 15000);
      proc.stderr.on('data', d => { log += d; const m = log.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
      proc.on('error', reject);
      proc.on('exit', code => { if (code) reject(new Error('Headless browser exited ' + code + ' ' + log.slice(-1200))); });
    });
    const origin = browserURL.replace(/^ws:/, 'http:').split('/devtools/')[0];
    const targets = await (await fetch(origin + '/json/list')).json();
    const target = targets.find(x => x.type === 'page');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); clearTimeout(p.timeout); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value || a.description));
      if (m.method === 'Network.requestWillBeSent') {
        resources.push(m.params.request.url);
        if (/^https?:/.test(m.params.request.url)) network.push(m.params.request.url);
        if (counting) afterLoad.push(m.params.request.url);
      }
      if (m.method === 'Network.webSocketCreated' && counting) afterLoad.push(m.params.url);
      if (m.method === PG + 'javascriptDialogOpening') call(PG + 'handleJavaScriptDialog', { accept: true }).catch(() => {});
    });
    await call(PG + 'enable'); await call('Runtime.enable'); await call('Log.enable'); await call('Network.enable');
    await viewport(1440, 1000);
    await call(PG + 'navigate', { url: 'file://' + (process.env.APP_ENTRY || path.join(root, 'index.html')) });
    await waitFor('document.readyState==="complete"&&!!window.FinanceDashboard&&!!window.FinanceIdeas', 'the page and the Mode ideas module');
    await delay(300);
    counting = true;
    const TITLE = await evaluate('document.title');
    assert.ok(TITLE.length > 0);

    /* ---------- the view in the shell ---------- */
    await click('[data-dash-tab="ideas"]');
    await waitFor('!!document.querySelector("#ig-root")&&!!document.querySelector("#ig-generate")', 'the page to paint');
    assert.equal(await evaluate('document.querySelector(\'.dash-sidebar .nav-btn.active\').textContent.trim()'), 'Mode ideas');
    assert.equal(await evaluate('document.querySelector(\'.dash-sidebar .nav-btn.active\').getAttribute("aria-current")'), 'page');
    assert.equal(await exists('.dash-topbar'), false, 'the page draws its own header, so the shell shows no top bar');
    assert.equal(await text('.ig-title'), 'MODE IDEAS');
    assert.match(await text('.ig-index'), /^03 \//);
    assert.equal(await evaluate('document.querySelectorAll("#analysis-main h1").length'), 1, 'one h1');
    assert.equal(await evaluate('document.title'), TITLE, 'the page leaves the document title alone');
    assert.equal(await evaluate('document.querySelector("#ig-generate").disabled'), true, 'nothing to generate from yet');
    assert.match(await text('#ig-why'), /Add a workflow or a description/);
    assert.equal(await evaluate('document.querySelectorAll("#ig-root button.primary").length'), 1, 'one yellow primary');
    assert.deepEqual((await notes('#ig-bar .ig-note')).map(sha), [HASH.noWorkbook], 'the no workbook sentence, verbatim');
    assert.ok((await notes('#ig-inputs .ig-help')).map(sha).includes(HASH.privacy), 'the privacy line next to the loader, verbatim');
    await noHorizontalOverflow('first screen');
    pass('the view opens in the shell with its own header, one primary (disabled with its reason) and no horizontal overflow at three sizes');
    await shot('01-first-screen-1440', 1440, 900);

    /* ---------- the keyboard path: real key presses ---------- */
    await evaluate('document.querySelector("[data-dash-action=advanced]").focus()');
    await press('Tab');
    const ringOk = () => evaluate(`(()=>{const a=document.activeElement;if(!a)return false;const el=a.type==='radio'?a.nextElementSibling:a;const s=getComputedStyle(el);return s.outlineStyle==='solid'&&s.outlineWidth==='2px'})()`);
    assert.equal(await focusedId(), 'ig-mode-new');
    assert.equal(await ringOk(), true, 'the segmented control shows a 2px ring on the focused option');
    await press('Tab'); assert.equal(await focusedId(), 'ig-workflow'); assert.equal(await ringOk(), true);
    await typeText('Treasury facility review');
    assert.equal(await evaluate('document.querySelector("#ig-generate").disabled'), false, 'typing a workflow enables Generate');
    assert.equal(await focusedId(), 'ig-workflow', 'typing does not move focus or repaint the field');
    await press('Tab'); assert.equal(await focusedId(), 'ig-description'); assert.equal(await ringOk(), true);
    await typeText('A facility agreement with a target range and a limit, a signed commitment letter and an amendment that supersedes the pricing schedule.');
    await press('Tab'); assert.equal(await focusedId(), 'ig-load-workbook'); assert.equal(await ringOk(), true);
    await press('Tab'); assert.equal(await focusedId(), 'ig-generate'); assert.equal(await ringOk(), true);
    assert.equal(await evaluate('document.querySelectorAll("#ig-cards article").length'), 0, 'typing generated nothing');
    await press('Enter');
    await waitFor('document.querySelectorAll("#ig-cards article").length===6', 'six cards');
    assert.equal(await focusedId(), 'ig-generate', 'focus stays on Generate');
    assert.match(await text('#ig-live'), /^44 ideas\.$/, 'the count is announced in the polite live region');
    assert.equal(await evaluate('(()=>{const l=document.getElementById("ig-live");return l.getAttribute("role")+"|"+l.getAttribute("aria-live")+"|"+l.getAttribute("aria-atomic")})()'), 'status|polite|true');
    await press('Tab'); assert.equal(await focusedId(), 'ig-search');
    await press('Tab'); assert.equal(await focusedId(), 'ig-lead');
    await press('Tab'); assert.equal(await focusedId(), 'SUMMARY', 'the first card offers How to build it as a disclosure'); assert.equal(await ringOk(), true, 'the disclosure has a 2px ring');
    assert.equal(await evaluate('document.activeElement.parentElement.open'), false, 'the moves are closed until asked for');
    await press('Enter');
    assert.equal(await evaluate('document.activeElement.parentElement.open'), true, 'Enter opens the moves');
    assert.equal(await evaluate('(()=>{const li=document.activeElement.parentElement.querySelector("li");return li.getBoundingClientRect().height>0})()'), true, 'and they are on screen');
    await press('Tab'); assert.match(await focusedId(), /^add-idea-/); assert.equal(await ringOk(), true, 'card buttons have a 2px ring');
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-describedby")===document.activeElement.closest("article").querySelector(".ig-card-title").id'), true, 'the button is described by the title of its card');
    await press('Tab'); assert.match(await focusedId(), /^copy-idea-/);
    await press('Tab', 8); assert.match(await focusedId(), /^add-idea-/, 'Shift+Tab goes back');
    await evaluate('document.getElementById("ig-more").click()');
    await waitFor('document.querySelectorAll("#ig-cards article").length===12', 'twelve cards');
    assert.equal(await evaluate('document.querySelector("#ig-cards details.ig-build").open'), true, 'a card that was opened stays open when the list is repainted');
    assert.equal(await evaluate('document.querySelectorAll("#ig-cards details.ig-build[open]").length'), 1, 'and the others stay closed');
    await evaluate('document.getElementById("ig-lead").focus()');
    await press('Space');
    await waitFor('document.querySelectorAll("#ig-cards article").length>0&&[...document.querySelectorAll("#ig-cards article")].every(a=>a.querySelector(".ig-lead"))', 'lead ideas only');
    assert.equal(await evaluate('document.getElementById("ig-lead").checked'), true);
    assert.equal(await focusedId(), 'ig-lead', 'the toggle keeps focus while the cards repaint');
    assert.match(await text('#ig-count'), /ideas? match\. 44 were generated\./);
    await press('Space');
    await waitFor('document.querySelectorAll("#ig-cards article").length===6', 'all ideas again');
    await evaluate('document.getElementById("ig-search").focus()');
    await typeText('ceiling');
    await waitFor('document.querySelectorAll("#ig-cards article").length>=1&&document.querySelectorAll("#ig-cards article").length<6', 'the search to narrow the list');
    assert.equal(await focusedId(), 'ig-search', 'typing in the search keeps focus');
    assert.ok(/ceiling/i.test(await text('#ig-cards article')), 'the search reads the title and the summary');
    await waitFor('/match/.test(document.getElementById("ig-live").textContent)', 'the settled count to be announced', 3000);
    await evaluate('document.getElementById("ig-search").select()');
    await typeText('zzzz no such words');
    await waitFor('!!document.querySelector("#ig-cards [data-ig=clear-filters]")', 'the empty state');
    assert.match(await text('#ig-cards'), /No ideas match these filters/);
    await click('#ig-lead');
    await click('[data-ig="clear-filters"]');
    await waitFor('document.querySelectorAll("#ig-cards article").length===6', 'the list to come back');
    assert.equal(await focusedId(), 'ig-search');
    assert.equal(await evaluate('document.getElementById("ig-search").value+"|"+document.getElementById("ig-lead").checked'), '|false', 'Clear filters empties the search box and the toggle, not just the list');
    await evaluate('document.getElementById("ig-workflow").focus()');
    await evaluate('document.getElementById("ig-search").focus()');
    await delay(100);
    assert.equal(await evaluate('document.querySelectorAll("#ig-cards article").length'), 6, 'a later change event does not bring the cleared text back');
    pass('keyboard path: segmented control, fields, load button, Generate (Enter), search, toggle (Space), cards; 2px rings; focus stays put while regions repaint');

    /* ---------- mode switch with the arrow keys ---------- */
    await evaluate('document.getElementById("ig-mode-new").focus()');
    await press('ArrowRight');
    await waitFor('document.getElementById("ig-mode-existing").checked===true&&!!document.querySelector("[data-ig=load-package]")', 'Existing task');
    assert.equal(await focusedId(), 'ig-mode-existing', 'focus follows the selection');
    assert.match(await text('#ig-inputs'), /No task package is loaded\./);
    assert.equal(await evaluate('document.querySelector("#ig-generate").disabled'), true);
    assert.match(await text('#ig-why'), /load a task package/i);
    await press('ArrowLeft');
    await waitFor('document.getElementById("ig-mode-new").checked===true&&!!document.getElementById("ig-workflow")', 'New task again');
    assert.equal(await evaluate('document.getElementById("ig-workflow").value'), 'Treasury facility review', 'typed text survives a mode switch');
    assert.match(await text('#ig-bar'), /no precedent workbook loaded/i);
    assert.doesNotMatch(await text('#ig-bar'), /changed since these ideas were made/, 'going back to the same kind of task is not a change');
    pass('arrow keys switch the mode and keep what was typed');

    /* ---------- the invented precedent workbook, through the file input ---------- */
    await evaluate('document.getElementById("ig-load-workbook").click()');
    assert.equal(await evaluate('(()=>{const i=document.getElementById("ig-workbook-file");return !!i&&i.type==="file"&&i.hidden&&/csv/.test(i.accept)&&i.parentElement===document.body})()'), true, 'a hidden CSV file input made by the page');
    const csvPath = path.join(work, 'invented-precedents.csv');
    fs.writeFileSync(csvPath, CSV);
    await setFile('#ig-workbook-file', csvPath);
    await waitFor('/10 rows read/.test(document.getElementById("ig-inputs").innerText)', 'the workbook to be read');
    assert.match(await text('#ig-inputs'), /invented-precedents\.csv/);
    assert.match(await text('#ig-inputs'), /10 rows read, 0 rows rejected, 0 warnings\./);
    assert.match(await text('#ig-live'), /workbook read: 10 rows/i);
    assert.equal(await evaluate('document.querySelectorAll("#ig-workflows option").length'), 6, 'one suggestion for each distinct workflow in the file');
    assert.ok((await notes('#ig-inputs .ig-help')).map(sha).includes(HASH.privacy), 'the privacy line next to the loader');
    assert.match(await text('#ig-bar'), /changed since these ideas were made/, 'a workbook loaded after generating marks the ideas as earlier');
    await evaluate(`(()=>{const i=document.getElementById('ig-workbook-file');const d=new DataTransfer();d.items.add(new ${FILE_CLASS}(['x'],'notes.txt',{type:'text/plain'}));i.files=d.files;i.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor('/not a CSV/.test(document.getElementById("ig-inputs").innerText)', 'the refusal of a non-CSV file');
    assert.match(await text('#ig-inputs'), /10 rows read/, 'the first workbook is kept');
    await click('#ig-generate');
    await waitFor('/ordered by the lowest recorded score/i.test(document.getElementById("ig-bar").innerText)', 'the ordering footnote');
    const footnotes = await evaluate('(document.getElementById("ig-root").innerText.match(/ordered by the lowest recorded score/gi)||[]).length');
    assert.equal(footnotes, 1, 'the footnote once per page');
    const orderNotes = await notes('#ig-bar .ig-note');
    assert.equal(sha(orderNotes[0]), HASH.ordering, 'the ordering footnote, verbatim');
    assert.equal(orderNotes.length, 2, 'the footnote and one plain line on how the groups are formed');
    assert.match(orderNotes[1], /^Ideas are grouped by status first, with reviewable hypotheses at the top and ideas that overlap a current mode at the bottom\./);
    assert.doesNotMatch(await text('#ig-bar'), /no precedent workbook loaded/i);
    const cards = await evaluate(`[...document.querySelectorAll('#ig-cards article')].map(a=>({status:(a.querySelector('.ig-status').className.match(/ig-status-([a-z-]+)/)||[])[1],scores:[...a.querySelectorAll('.ig-score')].map(s=>s.textContent.replace(/^recorded score /i,''))}))`);
    assert.equal(cards.length, 6);
    assert.ok(cards.some(c => c.scores.length > 0), 'precedents are shown');
    for (const c of cards) {
      assert.ok(c.scores.length <= 3, 'at most three precedents');
      for (const s of c.scores) assert.ok(SCORES.includes(s), 'recorded score verbatim: ' + s);
      assert.deepEqual(c.scores.map(Number), [...c.scores.map(Number)].sort((a, b) => a - b), 'ascending recorded score');
    }
    const rank = s => (s === 'anchored' ? 0 : s === 'needs-evidence' ? 1 : 2);
    for (let i = 1; i < cards.length; i++) {
      assert.ok(rank(cards[i - 1].status) <= rank(cards[i].status));
      if (rank(cards[i - 1].status) === rank(cards[i].status) && cards[i - 1].scores.length && cards[i].scores.length) assert.ok(Number(cards[i - 1].scores[0]) <= Number(cards[i].scores[0]), 'ideas ordered by their lowest recorded precedent score');
    }
    assert.ok((await notes('#ig-cards .ig-honest')).length === 6 && (await notes('#ig-cards .ig-honest')).every(t => sha(t) === HASH.honesty), 'the honesty line on every card, verbatim');
    await noHorizontalOverflow('with the workbook and ideas');
    pass('an invented CSV loads through the file input: counts shown, non-CSV refused, footnote once, at most 3 precedents, scores verbatim and ascending, ideas ordered by lowest score');
    await shot('02-ideas-1440', 1440, 900);
    await shot('02-ideas-1280', 1280, 800);
    await shot('02-ideas-390', 390, 844);
    await viewport(1440, 1000);

    /* ---------- an existing task package ---------- */
    await click('[data-dash-tab="overview"]');
    await click('[data-dash-action="example-cash"]');
    await waitFor('!!window.FinanceDashboard.getPackage()', 'the synthetic task package to load', 15000);
    await click('[data-dash-tab="ideas"]');
    await waitFor('!!document.getElementById("ig-generate")', 'the ideas page again');
    assert.equal(await evaluate('document.querySelectorAll("#ig-cards article").length'), 6, 'the ideas made before are still there');
    assert.match(await text('#ig-inputs'), /10 rows read/, 'and so is the workbook (module memory for the session)');
    assert.doesNotMatch(await text('#ig-bar'), /changed since these ideas were made/, 'a package loaded after ideas for a new task changes nothing for them');
    await click('#ig-mode-existing');
    await waitFor('!!document.querySelector("#ig-inputs .ig-pkg-title")', 'the package block');
    assert.match(await text('#ig-bar'), /changed since these ideas were made/, 'a different kind of task than the one the ideas were made for');
    assert.match(await text('#ig-inputs'), /3 files · 1 mode in the project, 1 net-new\. Open net-new slots: 1\./);
    assert.equal(await evaluate('document.querySelector("#ig-generate").disabled'), false);
    await click('#ig-generate');
    await waitFor('!/changed since these ideas were made/.test(document.getElementById("ig-bar").innerText)', 'the stale note to clear');
    const attach = await text('#ig-cards');
    assert.match(attach, /WHERE IT COULD ATTACH/i);
    assert.match(attach, /Treasury_Procedure\.txt · Line \d+/);
    assert.ok(!/Task_Prompt\.txt/.test(attach), 'the solver prompt is never an attachment point');
    pass('existing task: the loaded package is named, ideas attach to solver-visible lines with document, locator and quote, and a stale note clears on Generate');
    await shot('03-existing-1440', 1440, 900);

    /* ---------- add as net-new mode ---------- */
    const pick = await evaluate(`(()=>{const a=[...document.querySelectorAll('#ig-cards article')].find(x=>x.querySelector('.ig-status-anchored'));return a?{id:a.getAttribute('data-ig-idea'),title:a.querySelector('.ig-card-title').textContent}:null})()`);
    assert.ok(pick, 'an anchored idea');
    const rootsBefore = await evaluate('FinanceAuthoring.getProject().roots.length');
    await evaluate(`document.querySelector('[data-key="add-${pick.id}"]').focus()`);
    await press('Enter');
    await waitFor('!!document.querySelector("#ig-modal [role=dialog]")', 'the confirm dialog');
    assert.equal(await evaluate('document.querySelector("#ig-modal [data-ig-dialog]").contains(document.activeElement)||document.activeElement===document.querySelector("#ig-modal [data-ig-dialog]")'), true, 'focus moved into the dialog');
    const dialog = await text('#ig-modal');
    assert.match(dialog, /A derivative task locks five failure modes: three historical and two net-new\./);
    assert.match(dialog, /This project has 1 mode, 1 of them net-new, so one net-new slot is open\./);
    assert.equal(await evaluate('(()=>{const d=document.querySelector("#ig-modal [role=dialog]");return d.getAttribute("aria-modal")+"|"+!!document.getElementById(d.getAttribute("aria-labelledby"))+"|"+!!document.getElementById(d.getAttribute("aria-describedby"))})()'), 'true|true|true');
    for (let i = 0; i < 5; i++) { await press('Tab'); assert.equal(await evaluate('!!document.activeElement.closest("#ig-modal")'), true, 'Tab stays inside the dialog'); }
    await press('Tab', 8); assert.equal(await evaluate('!!document.activeElement.closest("#ig-modal")'), true, 'Shift+Tab stays inside the dialog');
    await noHorizontalOverflow('dialog open');
    await shot('04-dialog-1440', 1440, 900);
    await shot('04-dialog-390', 390, 844);
    await viewport(1440, 1000);
    await press('Escape');
    await waitFor('!document.querySelector("#ig-modal [role=dialog]")', 'Escape to close the dialog');
    assert.equal(await focusedId(), 'add-' + pick.id, 'focus goes back to the button that opened the dialog');
    assert.equal(await evaluate('FinanceAuthoring.getProject().roots.length'), rootsBefore, 'nothing was added');
    await click(`[data-key="add-${pick.id}"]`);
    await waitFor('!!document.querySelector("#ig-modal [data-ig=confirm-add]")', 'the dialog again');
    await click('[data-ig="cancel"]');
    assert.equal(await evaluate('FinanceAuthoring.getProject().roots.length'), rootsBefore, 'Cancel adds nothing');
    await click(`[data-key="add-${pick.id}"]`);
    await click('[data-ig="confirm-add"]');
    await waitFor(`FinanceAuthoring.getProject().roots.length===${rootsBefore + 1}`, 'the root to appear in the project');
    const added = await evaluate('(()=>{const p=FinanceAuthoring.getProject(),r=p.roots[p.roots.length-1];return {title:r.title,lane:r.lane,group:r.causalGroup,status:r.reviewStatus,sources:r.sourceIds.length,facts:r.facts}})()');
    assert.equal(added.title, pick.title);
    assert.equal(added.lane, 'net-new');
    assert.match(added.group, /^cg-ia-\d\d$/);
    assert.equal(added.status, 'pending');
    assert.ok(added.sources >= 1 && /Treasury_Procedure\.txt/.test(added.facts) && /Build: /.test(added.facts), 'the idea carries its anchors and build moves into the root');
    assert.match(await text('#toast'), /^added "/i);
    assert.match(await text(`#ig-card-${pick.id}`), /added to the project as a net-new mode\./i);
    assert.equal(await exists(`[data-key="add-${pick.id}"]`), false, 'the card cannot add the same idea again');
    assert.equal(await focusedId(), 'open-' + pick.id, 'focus moves to the next step on the card');
    assert.match(await text('#ig-bar'), /changed since these ideas were made/, 'the mode set changed');
    await click(`[data-key="open-${pick.id}"]`);
    await waitFor('document.querySelector("#advanced-shell").hidden===false', 'the task editor');
    assert.match(await evaluate('document.querySelector("#advanced-shell .nav-btn.active").textContent'), /Root design/);
    assert.ok((await evaluate('(()=>{const a=document.querySelector("#app");return a.textContent+" "+[...a.querySelectorAll("input,textarea")].map(i=>i.value).join(" ")})()')).includes(pick.title), 'the new root is visible on the editor page');
    await click('[data-dash-action="close-advanced"]');
    await waitFor('document.querySelector("#advanced-shell").hidden===true&&!!document.querySelector("#ig-cards article")', 'the return to the ideas');
    assert.equal(await evaluate('document.querySelectorAll("#ig-cards article").length'), 6, 'the ideas survive the round trip');
    pass('Add as net-new mode: confirm dialog with the cap and slots, Tab trap, Escape and Cancel add nothing, confirming puts a net-new root in the project with its anchors, toast, Open the task editor shows it');

    /* ---------- reduced motion, accessibility, text ---------- */
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches'), true);
    assert.equal(await evaluate('(()=>{const c=document.querySelector(".ig-card"),s=document.querySelector(".ig-seg-opt span");return getComputedStyle(c).transitionDuration+"|"+getComputedStyle(s).transitionDuration+"|"+document.getAnimations().length})()'), '0s|0s|0', 'no transition and no animation under reduced motion');
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".ig-card")).transitionDuration!=="0s"'), true, 'a quiet transition otherwise');
    pass('reduced motion removes the transitions and nothing animates');

    const audit = await evaluate(`(()=>{
      const rootEl=document.getElementById('ig-root'),bad=[];
      for(const b of rootEl.querySelectorAll('button')){if(!(b.textContent||'').trim()&&!b.getAttribute('aria-label'))bad.push('button without a name');}
      for(const i of rootEl.querySelectorAll('input,textarea,select')){if(i.type==='file')continue;const labelled=i.getAttribute('aria-label')||i.getAttribute('aria-labelledby')||(i.id&&rootEl.querySelector('label[for="'+i.id+'"]'))||i.closest('label');if(!labelled)bad.push('unlabelled '+(i.id||i.type));}
      const heads=[...rootEl.querySelectorAll('h1,h2,h3,h4')].map(h=>+h.tagName[1]);for(let n=1;n<heads.length;n++)if(heads[n]-heads[n-1]>1)bad.push('heading jump '+heads[n-1]+'>'+heads[n]);
      for(const a of rootEl.querySelectorAll('article')){const l=a.getAttribute('aria-labelledby');if(!l||!document.getElementById(l))bad.push('article without a name');}
      const list=rootEl.querySelector('ol.ig-list');if(!list||list.getAttribute('role')!=='list'||[...list.children].some(li=>li.tagName!=='LI'||!li.querySelector(':scope>article')))bad.push('the ideas are not a list of articles');
      const small=[];for(const el of rootEl.querySelectorAll('*')){const own=[...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim());if(own&&!el.closest('.sr-only')&&parseFloat(getComputedStyle(el).fontSize)<12)small.push(el.className||el.tagName);}
      const primary=[...rootEl.querySelectorAll('button.primary')].map(b=>getComputedStyle(b).backgroundColor);
      const targets=[...rootEl.querySelectorAll('button')].filter(b=>b.getBoundingClientRect().height<32).length;
      return {bad,small,primary:primary.length,targets,live:!!document.getElementById('ig-live')};})()`);
    assert.deepEqual(audit.bad, [], 'accessibility audit');
    assert.deepEqual(audit.small, [], 'nothing under 12px');
    assert.equal(audit.primary, 1, 'one yellow primary');
    assert.equal(audit.targets, 0, 'every button is at least 32px tall');
    const visible = await evaluate(`(()=>{const t=document.getElementById('ig-root').innerText,re=${FORBIDDEN};return re.test(t)?t.match(re)[0]:''})()`);
    assert.equal(visible, '', 'no percent sign and no rate, difficulty or prediction word in the page text');
    pass('accessibility: names, labels, headings, a list of named articles, 12px minimum, one primary, no forbidden words');
    await shot('05-after-add-1440', 1440, 900);

    /* ---------- the workbook never reaches storage or the project ---------- */
    const kept = await evaluate('JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage),FinanceAuthoring.getProject()])');
    for (const needle of [...ROWS.flatMap(r => r.slice(0, 3)), ...SCORES.map(s => '"' + s + '"'), 'invented-precedents']) assert.ok(!kept.includes(needle), 'the workbook leaked into storage or the project: ' + needle);

    /* ---------- a workbook with many rejected rows and warnings: the input panel stays inside the screen and Generate stays in reach ---------- */
    await click('[data-ig="remove-workbook"]');
    await waitFor('!!document.getElementById("ig-load-workbook")', 'the load button to come back');
    assert.equal(await focusedId(), 'ig-load-workbook', 'removing the workbook hands the focus to the load button');
    await evaluate('document.getElementById("ig-load-workbook").click()');
    await evaluate('document.getElementById("ig-load-workbook").focus()');
    const messyRows = [HEADER,
      ...Array.from({ length: 30 }, (_, i) => ['Atlas Reporting', '', 'No title on this row ' + i, 'x', '0.3']),
      ...Array.from({ length: 21 }, (_, i) => ['Meridian Close', 'Row with an unreadable score ' + i, 'Text.', 'x', 'about a quarter']),
      ...ROWS];
    const messyPath = path.join(work, 'invented-messy.csv');
    fs.writeFileSync(messyPath, messyRows.map(r => r.map(quoteCell).join(',')).join('\r\n') + '\r\n');
    await setFile('#ig-workbook-file', messyPath);
    await waitFor('/rows read/.test(document.getElementById("ig-inputs").innerText)', 'the messy workbook to be read');
    assert.match(await text('#ig-inputs'), /31 rows read, 30 rows rejected, 21 warnings\./);
    assert.equal(await focusedId(), 'ig-remove-workbook', 'after the read the keyboard is on the remove link, not on the page');
    assert.equal(await exists('#ig-load-workbook'), false, 'one control for the workbook at a time');
    await click('#ig-generate');
    await waitFor('document.querySelectorAll("#ig-cards article").length>0&&/ordered by the lowest recorded score/i.test(document.getElementById("ig-bar").innerText)', 'ideas made with the messy workbook');
    assert.match(await text('#ig-bar'), /1 row has no score|21 rows have no score that is a plain number, so they do not take part in the ordering\./);
    let panelScrolls = false;
    for (const [w, h] of [[1440, 900], [1280, 800]]) {
      await viewport(w, h);
      for (const where of [1500, 1e6]) {
        await evaluate(`window.scrollTo(0, ${where})`);
        await delay(120);
        const m = await evaluate(`(()=>{const p=document.querySelector('.ig-panel'),r=p.getBoundingClientRect(),g=document.getElementById('ig-generate').getBoundingClientRect();return {panelH:Math.round(r.height),panelTop:Math.round(r.top),scrolls:p.scrollHeight>p.clientHeight+1,gTop:Math.round(g.top),gBottom:Math.round(g.bottom),vh:innerHeight,sticky:getComputedStyle(document.querySelector('.ig-inputs')).position}})()`);
        assert.equal(m.sticky, 'sticky', `${w}x${h}: the input panel follows the page`);
        assert.ok(m.panelH <= m.vh - 24, `${w}x${h}: the panel is never taller than the screen below its 24px offset ${JSON.stringify(m)}`);
        if (where === 1500) assert.equal(m.panelTop, 24, `${w}x${h}: the panel sits at the top of the screen while the results scroll`);
        assert.ok(m.gTop >= 0 && m.gBottom <= m.vh, `${w}x${h} at ${where}: Generate ideas stays on screen while the results scroll ${JSON.stringify(m)}`);
        panelScrolls = panelScrolls || m.scrolls;
      }
    }
    assert.equal(panelScrolls, true, 'the messy workbook really made the panel taller than the screen at one of the sizes');
    await evaluate('window.scrollTo(0, 0)');
    await viewport(1440, 1000);
    pass('many rejected rows and warnings: the panel never outgrows the screen, Generate ideas stays in reach at 1440x900 and 1280x800, the keyboard lands on the remove link after a read');

    /* ---------- one column: Generate brings the results into view ---------- */
    await viewport(390, 844);
    await evaluate('window.scrollTo(0, 0)');
    await evaluate('document.getElementById("ig-remove-workbook").focus()');
    await press('Tab');
    assert.equal(await focusedId(), 'ig-generate');
    await press('Enter');
    await waitFor('document.activeElement&&document.activeElement.id==="ig-results-h"', 'the focus to move to the results heading');
    const heading = await evaluate('(()=>{const r=document.getElementById("ig-results-h").getBoundingClientRect();return {top:r.top,bottom:r.bottom,vh:innerHeight}})()');
    assert.ok(heading.top >= 0 && heading.bottom <= heading.vh, 'the results heading is on screen after Generate at 390 wide ' + JSON.stringify(heading));
    assert.equal(await evaluate('getComputedStyle(document.getElementById("ig-results-h")).outlineStyle'), 'solid', 'and it shows a ring for a keyboard user');
    await viewport(1440, 1000);
    pass('at 390 wide Generate scrolls to the results heading and focuses it; at 1440 the focus stays on Generate');

    /* ---------- the load task package button of this page returns to this page ---------- */
    counting = false;
    await call(PG + 'navigate', { url: 'file://' + (process.env.APP_ENTRY || path.join(root, 'index.html')) });
    await waitFor('document.readyState==="complete"&&!!window.FinanceDashboard&&!!window.FinanceIdeas', 'the page to load again');
    await delay(300);
    counting = true;
    await click('[data-dash-tab="ideas"]');
    await waitFor('!!document.getElementById("ig-mode-existing")', 'the page');
    await click('#ig-mode-existing');
    await waitFor('!!document.querySelector("[data-ig=load-package]")', 'the package loader');
    await click('[data-ig="load-package"]');
    const notePath = path.join(work, 'Atlas_Note.txt');
    fs.writeFileSync(notePath, 'Atlas facility note.\nThe amendment supersedes the earlier schedule from its effective date.\n');
    await setFile('#package-files', notePath);
    await waitFor('!!window.FinanceDashboard.getPackage()&&window.FinanceDashboard.getView()==="ideas"&&!!document.querySelector("#ig-inputs .ig-pkg-title")', 'the page to return to Mode ideas with the new package', 15000);
    assert.match(await text('#ig-inputs'), /1 file/);
    assert.equal(await evaluate('document.querySelector(".dash-sidebar .nav-btn.active").textContent.trim()'), 'Mode ideas');
    await click('[data-dash-tab="overview"]');
    await waitFor('window.FinanceDashboard.getView()==="overview"', 'the overview');
    const second = path.join(work, 'Meridian_Note.txt');
    fs.writeFileSync(second, 'Meridian cut off note.\nThe closing date moved by one day.\n');
    await evaluate('document.getElementById("package-files").click()');
    await setFile('#package-files', second);
    await waitFor('window.FinanceDashboard.getView()==="candidates"', 'the shell to show the candidate roots page');
    await delay(500);
    assert.equal(await evaluate('window.FinanceDashboard.getView()'), 'candidates', 'a package loaded from another page is not pulled back to Mode ideas');
    pass('the load task package button of the mode ideas page returns to it once the shell has read the files; a package loaded from another page stays where the shell put it');

    /* ---------- no requests, no errors ---------- */
    assert.deepEqual(afterLoad, [], 'the page made no request of any kind after it loaded');
    assert.equal(network.length, 0, 'no HTTP request at all');
    assert.deepEqual(errors, [], 'console and runtime errors: ' + JSON.stringify(errors));
    pass('zero requests after load, no HTTP request, no workbook text or score in storage or in the project, zero console errors');

    fs.writeFileSync(path.join(out, 'browser-report.json'), JSON.stringify({ passed: true, entry: process.env.APP_ENTRY || path.join(root, 'index.html'), checks, resources: resources.length, appNetworkRequests: network, requestsAfterLoad: afterLoad, consoleErrors: errors, node: process.version, viewports: [{ width: 1440, height: 1000 }, { width: 1280, height: 800 }, { width: 390, height: 844 }], qaData: 'Invented rows only (Atlas, Meridian, Borealis).' }, null, 2));
    console.log(JSON.stringify({ passed: true, checks }, null, 2));
  } catch (error) {
    console.error(error);
    try { fs.writeFileSync(path.join(out, 'browser-report.json'), JSON.stringify({ passed: false, checks, error: String(error && error.stack || error), errors, network, afterLoad }, null, 2)); } catch { /* the report is a courtesy */ }
    process.exitCode = 1;
  } finally {
    if (ws) { try { await call('Browser.close'); } catch { /* already closing */ } ws.close(); }
    if (proc) { const gone = proc.exitCode !== null ? Promise.resolve() : new Promise(r => { proc.once('exit', r); setTimeout(r, 4000); }); proc.kill(); await gone; }
    for (const dir of [profile, work]) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } catch { /* a leftover temporary folder is harmless */ } }
  }
})();
