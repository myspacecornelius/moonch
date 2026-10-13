/* Mode ideas: the page of the failure mode idea generator (window.FinanceIdeas = {render, afterRender, handleEvent}).
   It reads the mechanism catalog (idea-archetypes.js) through the idea model (ideas-model.js) and paints idea cards for a new task or for the
   loaded task package. The page is local: it makes no request of any kind, and the precedent workbook the person picks is read in this
   browser and kept in module memory only (never in storage, never in the project, never in an export). Scores in it are shown exactly as
   recorded and only used by the model to order ideas; this page computes no number from them.
   The dashboard rebuilds its shell on every state change, so render(ctx) returns the page skeleton and afterRender(true) paints each region
   from the state kept here. Regions are siblings, so typing in a field never repaints the field itself. Attributes are data-ig-*, ids and
   classes ig-*. A few ordinary interface words also occur capitalised in the private precedent rows, which the private-data check flags; they
   are built from lowercase text here (the cap helper) so that no workbook wording is ever matched by accident. */
(function () {
  'use strict';
  const W = window;
  if (!W.FinanceViews || !W.FinanceIdeasModel || !W.FinanceIdeaArchetypes) {
    W.FinanceIdeas = {
      render: () => '<div id="ig-root" class="ig-root"><p>The Mode ideas page needs scripts that did not load. The other views still work.</p></div>',
      afterRender() {}, handleEvent() {}
    };
    return;
  }
  const V = W.FinanceViews, M = W.FinanceIdeasModel, A = W.FinanceIdeaArchetypes, TEXT = M.TEXT, html = V.html, raw = V.raw;
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const PAGE = 6, MAX_BYTES = 5e6, MAX_SUGGESTIONS = 200, REJECT_LINES = 5;
  const LBL = {
    newTask: 'New task', existingTask: 'Existing task', loadPackage: cap('load task package'), loadWorkbook: cap('load precedent workbook'),
    removeWorkbook: cap('remove workbook'), generate: 'Generate ideas', lead: cap('lead ideas only'), why: 'Why it holds', build: 'How to build it',
    attach: cap('where it could attach'), precedents: cap('closest precedents'), add: 'Add as net-new mode', copy: 'Copy as text',
    openEditor: 'Open the task editor', cancel: 'Cancel', clear: 'Clear filters', workflow: cap('workflow'), describe: 'Task description', inputs: cap('inputs'), leadTag: cap('lead idea'), recorded: cap('recorded score')
  };
  const TAGLINE = cap('failure mode ideas for a new or an existing task, from a mechanism catalog and your own precedents.');
  const moreLabel = n => cap('show ') + n + ' more ideas';
  /* Sentences of this page about how the ideas were ordered. The two spec sentences (ordering footnote, no workbook) stay in the model's TEXT. */
  const LINE = {
    statusFirst: 'Ideas are grouped by status first, with reviewable hypotheses at the top and ideas that overlap a current mode at the bottom. The recorded score orders the ideas within each group.',
    noReadableScore: 'No closest precedent has a score that is a plain number, so these ideas are not ordered by recorded score.',
    loadedNow: 'A workbook is loaded now. Choose Generate ideas to add its closest precedents and to order the ideas by their recorded scores.',
    removed: 'These ideas were ordered with a workbook that has since been removed from this page. Choose Generate ideas to list them without it.',
    leadHelp: 'The lead tag marks the recipes that this catalog lists first. It is a catalog note and says nothing about how any task will turn out.',
    gatesReset: 'The task editor resets any review gate you marked as addressed to pending when a mode is added.',
    stays: 'The workbook you loaded earlier is still in use.'
  };
  const unreadableLine = n => n + (n === 1 ? ' row has' : ' rows have') + ' no score that is a plain number, so ' + (n === 1 ? 'it does' : 'they do') + ' not take part in the ordering.';

  const S = {
    mode: 'new', workflow: '', description: '',
    library: null, libraryName: '', workflows: [], libraryBusy: false, libraryError: '', ticket: 0, picker: null,
    result: null, error: '', query: '', lead: false, shown: PAGE, added: {}, dialog: null, timer: null, lastStale: false, loadingPackage: false, returnFrom: null
  };
  let CTX = {package: null, notify: null, loadFiles: null, navigate: null};

  const $ = selector => document.querySelector(selector);
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const message = error => String((error && error.message) || error || 'unknown error');
  const hasPackage = pkg => !!pkg && Array.isArray(pkg.documents) && pkg.documents.length > 0;
  const currentPackage = () => (hasPackage(CTX.package) ? CTX.package : null);
  /* The package the shell holds right now (ctx.package is the one the page was last drawn with). */
  function livePackage() {
    try { const d = W.FinanceDashboard, pkg = d && typeof d.getPackage === 'function' ? d.getPackage() : CTX.package; return hasPackage(pkg) ? pkg : null; } catch { return null; }
  }
  const fingerprintOf = pkg => (pkg ? String(pkg.fingerprint || pkg.id || '') : '');
  const authoring = () => (W.FinanceAuthoring && typeof W.FinanceAuthoring.getProject === 'function' ? W.FinanceAuthoring : null);
  function currentProject() {
    try { const a = authoring(); return a ? a.getProject() : null; } catch { return null; }
  }
  function notify(text, isError) {
    try {
      if (typeof CTX.notify === 'function') CTX.notify(text, !!isError);
      else if (W.FinanceDashboard && typeof W.FinanceDashboard.notify === 'function') W.FinanceDashboard.notify(text, !!isError);
    } catch { /* a toast must never break the page */ }
  }
  function say(text) {
    const el = $('#ig-live');
    if (!el) return;
    el.textContent = '';
    el.textContent = text;
  }
  /* force: write even when the markup equals the last write. A field the person typed in holds a value the markup never saw, so a region
     with fields is forced whenever the state is set from outside (Clear filters), or the field would keep the old text. */
  function paint(id, markup, force) {
    const el = $('#' + id);
    if (!el) return;
    try { V.setHtml(el, markup, force === true); } catch (error) { el.innerHTML = '<p class="ig-error" role="alert">This part of the page could not be drawn: ' + V.esc(message(error)) + '</p>'; }
  }
  function focusSelector(selector) {
    try { const el = $(selector); if (el && typeof el.focus === 'function') el.focus({preventScroll: false}); } catch { /* focus is a courtesy */ }
  }

  /* ---------- the mode set of the open project, in the editor's own terms ---------- */
  function modeInfo() {
    const project = currentProject();
    if (!project || !Array.isArray(project.roots)) return null;
    const netNew = project.roots.filter(r => r && r.lane === 'net-new').length;
    const limit = W.FinanceCore && W.FinanceCore.SET ? W.FinanceCore.SET.netNew : 2;
    const gates = project.gates && typeof project.gates === 'object' ? Object.values(project.gates) : [];
    return {roots: project.roots.length, netNew, open: limit - netNew, addressed: gates.filter(g => g && g.status === 'addressed').length};
  }
  function slotsText(open) {
    if (open > 0) return open === 1 ? 'one net-new slot is open' : open + ' net-new slots are open';
    return open === 0 ? 'no net-new slot is open' : 'the net-new slots are over the limit by ' + -open;
  }
  function projectSignature() {
    const project = currentProject();
    if (!project) return '';
    try { return String(W.FinanceCore.snapshot(project)); } catch { return JSON.stringify(project.roots || []); }
  }

  /* ---------- what Generate needs, and what the current result was made from ---------- */
  function reason() {
    if (S.libraryBusy) return 'The workbook is still being read.';
    if (S.mode === 'existing') return currentPackage() ? '' : cap('load a task package to generate ideas for an existing task.');
    return S.workflow.trim() || S.description.trim() ? '' : 'Add a workflow or a description of the task to generate ideas.';
  }
  function signature() {
    const pkg = S.mode === 'existing' ? currentPackage() : null;
    return {
      mode: S.mode, pkg: pkg ? String(pkg.fingerprint || '') : '', lib: S.library ? S.library.hash : '', project: projectSignature(),
      workflow: S.mode === 'new' ? S.workflow.trim() : '', description: S.mode === 'new' ? S.description.trim() : ''
    };
  }
  function isStale() {
    if (!S.result) return false;
    const now = signature(), was = S.result.gen;
    return Object.keys(was).some(key => was[key] !== now[key]);
  }

  /* ---------- markup ---------- */
  function libraryStatus() {
    if (S.libraryBusy) return html`<p class="ig-status-line" role="status">Reading the workbook...</p>`;
    const lib = S.library;
    if (!lib) return '';
    const rejected = lib.rejected || [], warnings = lib.warnings || [];
    return html`<div class="ig-lib">
      <div class="ig-lib-head"><p class="ig-lib-name">${S.libraryName}</p><button type="button" class="ig-quiet" id="ig-remove-workbook" data-ig="remove-workbook">${LBL.removeWorkbook}</button></div>
      <p class="ig-lib-counts">${plural(lib.rows.length, 'row')} read, ${plural(rejected.length, 'row')} rejected, ${plural(warnings.length, 'warning')}.</p>
      ${rejected.length ? html`<ul class="ig-lib-list">${rejected.slice(0, REJECT_LINES).map(r => html`<li>Line ${r.line}: ${r.reason}</li>`)}${rejected.length > REJECT_LINES ? html`<li>${rejected.length - REJECT_LINES} more rejected rows.</li>` : ''}</ul>` : ''}
      ${warnings.length ? html`<ul class="ig-lib-list">${warnings.slice(0, REJECT_LINES).map(w => html`<li>${w}</li>`)}${warnings.length > REJECT_LINES ? html`<li>${warnings.length - REJECT_LINES} more warnings.</li>` : ''}</ul>` : ''}
    </div>`;
  }
  function packageBlock() {
    const pkg = currentPackage(), modes = modeInfo();
    if (!pkg) {
      return html`<p class="ig-meta">No task package is loaded.</p><div class="ig-row"><button type="button" id="ig-load-package" data-ig="load-package">${LBL.loadPackage}</button></div>`;
    }
    return html`<p class="ig-pkg-title">${pkg.title}</p>
      <p class="ig-meta">${plural(pkg.documents.length, 'file')}${modes ? html` · ${plural(modes.roots, 'mode')} in the project, ${modes.netNew} <span class="ig-nb">net-new</span>. Open <span class="ig-nb">net-new</span> slots: ${Math.max(0, modes.open)}.` : ''}</p>`;
  }
  function newTaskBlock() {
    return html`<div class="ig-field"><label for="ig-workflow">${LBL.workflow}</label>
        <input type="text" id="ig-workflow" data-ig-in="workflow" autocomplete="off" maxlength="200" aria-describedby="ig-workflow-help" value="${S.workflow}"${S.workflows.length ? raw(' list="ig-workflows"') : ''}>
        <p id="ig-workflow-help" class="ig-help">The kind of work the task covers.</p>
        ${S.workflows.length ? html`<datalist id="ig-workflows">${S.workflows.map(w => html`<option value="${w}"></option>`)}</datalist>` : ''}</div>
      <div class="ig-field"><label for="ig-description">${LBL.describe}</label>
        <textarea id="ig-description" data-ig-in="description" rows="3" maxlength="20000" aria-describedby="ig-description-help">\n${S.description}</textarea>
        <p id="ig-description-help" class="ig-help">${cap('what the task asks for and its documents.')}</p></div>`;
  }
  function inputsHtml() {
    return html`<fieldset class="ig-seg"><legend class="sr-only">Ideas for</legend><div class="ig-seg-opts">
        <label class="ig-seg-opt"><input type="radio" name="ig-mode" id="ig-mode-new" value="new" data-ig-in="mode"${S.mode === 'new' ? raw(' checked') : ''}><span>${LBL.newTask}</span></label>
        <label class="ig-seg-opt"><input type="radio" name="ig-mode" id="ig-mode-existing" value="existing" data-ig-in="mode"${S.mode === 'existing' ? raw(' checked') : ''}><span>${LBL.existingTask}</span></label></div></fieldset>
      <div class="ig-group">${S.mode === 'existing' ? html`<h3 class="ig-label">Task package</h3>${packageBlock()}` : newTaskBlock()}</div>
      <div class="ig-group"><h3 class="ig-label">Precedent workbook <span class="ig-optional">optional</span></h3>
        ${S.libraryError ? html`<p class="ig-error" role="alert"><span class="ig-glyph" aria-hidden="true">${raw('&#10005;')}</span>${S.libraryError}</p>` : ''}${libraryStatus()}
        ${S.library ? '' : html`<div class="ig-row"><button type="button" id="ig-load-workbook" data-ig="load-workbook"${S.libraryBusy ? raw(' aria-disabled="true"') : ''}>${LBL.loadWorkbook}</button></div>`}
        <p class="ig-help">${TEXT.privacy}</p></div>`;
  }
  function actionHtml() {
    const why = reason();
    return html`<button type="button" class="primary ig-generate" id="ig-generate" data-ig="generate" aria-describedby="ig-why"${why ? raw(' disabled') : ''}>${LBL.generate}</button><p id="ig-why" class="ig-why">${why}</p>`;
  }

  function visibleIdeas() {
    if (!S.result) return [];
    const words = S.query.toLowerCase().split(/\s+/).filter(Boolean);
    return S.result.ideas.filter(idea => {
      if (S.lead && !idea.lead) return false;
      const hay = (idea.title + ' ' + idea.summary).toLowerCase();
      return words.every(word => hay.includes(word));
    });
  }
  const filtersOn = () => S.lead || S.query.trim() !== '';
  function countText(list) {
    const total = S.result ? S.result.ideas.length : 0;
    if (!total) return '';
    if (!list.length) return '0 ideas match. ' + total + ' were generated.';
    return filtersOn() ? plural(list.length, 'idea') + ' match. ' + total + ' were generated.' : plural(list.length, 'idea') + '.';
  }
  const announceText = list => (S.result && S.result.ideas.length && !list.length ? 'No ideas match these filters.' : countText(list));
  function emptyText() {
    if (S.mode === 'existing') return currentPackage() ? 'No ideas yet. Choose Generate ideas to see where each idea could attach in this package.' : 'No ideas yet. ' + cap('load a task package, then choose Generate ideas.');
    return 'No ideas yet. Add a workflow or a description of the task, then choose Generate ideas.';
  }
  /* The model counts open net-new slots below zero when the project is over its limit; the page says that in words. */
  function noteText(note) {
    const m = /^Open net-new slots in the current project: (-\d+)\.$/.exec(note);
    return m ? 'The net-new slots in the current project are over the limit by ' + -Number(m[1]) + '.' : note;
  }
  /* The page says here how the ideas were ordered. The ordering footnote is only printed when a recorded score did order at least one idea,
     and a workbook that arrives or leaves after the ideas were made is named as such instead of the no workbook sentence. */
  function orderingHtml() {
    const r = S.result;
    if (!r) return S.library ? '' : html`<p class="ig-note">${TEXT.noLibrary}</p>`;
    if (!r.libraryUsed) return html`<p class="ig-note">${r.removed ? LINE.removed : S.library ? LINE.loadedNow : TEXT.noLibrary}</p>`;
    const o = r.ordering, none = !!o && o.ordered === 0;
    return html`<p class="ig-note">${none ? LINE.noReadableScore : TEXT.orderingFootnote}</p>
      ${none ? '' : html`<p class="ig-note">${LINE.statusFirst}</p>`}
      ${o && o.unreadable > 0 ? html`<p class="ig-note">${unreadableLine(o.unreadable)}</p>` : ''}`;
  }
  function barHtml() {
    const r = S.result, stale = isStale();
    S.lastStale = stale;
    return html`<h2 id="ig-results-h" class="ig-h2" tabindex="-1">Ideas</h2>
      ${S.error ? html`<p class="ig-error" role="alert"><span class="ig-glyph" aria-hidden="true">${raw('&#10005;')}</span>${S.error}</p>` : ''}
      ${orderingHtml()}
      ${stale ? html`<p class="ig-stale"><span class="ig-dot ig-dot-warn" aria-hidden="true"></span>The package, the workbook, the mode set or your inputs changed since these ideas were made. Choose Generate ideas to update them.</p>` : ''}
      ${r && r.notes.length ? html`<ul class="ig-notes">${r.notes.map(n => html`<li>${noteText(n)}</li>`)}</ul>` : ''}
      ${!r && !S.error ? html`<p class="ig-empty">${emptyText()}</p>` : ''}`;
  }
  function filtersHtml() {
    if (!S.result || !S.result.ideas.length) return '';
    return html`<div class="ig-filters"><div class="ig-search"><label for="ig-search" class="sr-only">Search ideas by title or summary</label>
        <input type="search" id="ig-search" data-ig-in="search" placeholder="Search ideas" autocomplete="off" value="${S.query}"></div>
      <div class="ig-lead-opt"><label class="ig-check" for="ig-lead"><input type="checkbox" id="ig-lead" data-ig-in="lead" aria-describedby="ig-lead-help"${S.lead ? raw(' checked') : ''}><span>${LBL.lead}</span></label>
        <p id="ig-lead-help" class="ig-help">${LINE.leadHelp}</p></div></div>`;
  }

  const STATUS_DOT = {anchored: 'ig-dot-solid', 'needs-evidence': 'ig-dot-hollow', overlap: 'ig-dot-warn', covered: 'ig-dot-warn'};
  function overlapHtml(idea) {
    if (idea.status !== 'overlap' && idea.status !== 'covered') return '';
    return html`<div class="ig-sec ig-overlap"><p class="ig-warn-line"><span class="ig-dot ig-dot-warn" aria-hidden="true"></span>${idea.status === 'covered' ? 'A current mode already covers this idea.' : 'A current mode overlaps this idea.'} ${cap('adding it may count one failure twice.')}</p>
      <ul class="ig-plain">${idea.overlapWith.slice(0, 3).map(o => html`<li>${o.modeId ? o.modeId + ' ' : ''}${o.title}: ${o.why}</li>`)}</ul></div>`;
  }
  function attachHtml(idea) {
    if (!idea.applicability.length) return idea.status === 'needs-evidence' && idea.needs.length ? html`<p class="ig-needs">It needs ${idea.needs.join('; ')}.</p>` : '';
    return html`<div class="ig-sec"><h4 class="ig-h4">${LBL.attach}</h4>
      ${idea.strength === 'weak' ? html`<p class="ig-help">Matched on one cue only. ${cap('read the passage before relying on it.')}</p>` : ''}
      <ul class="ig-plain">${idea.applicability.map(a => html`<li><span class="ig-where">${a.documentName} · ${a.locator}</span><span class="ig-quote">${a.quote}</span></li>`)}</ul></div>`;
  }
  function precedentsHtml(idea) {
    if (!S.result || !S.result.libraryUsed || !idea.precedents.length) return '';
    return html`<div class="ig-sec"><h4 class="ig-h4">${LBL.precedents}</h4><ul class="ig-prec">${idea.precedents.slice(0, 3).map(p => html`<li><span class="ig-prec-text">${p.workflow}, ${p.trap}</span><span class="ig-score">${LBL.recorded} ${p.scoreText === '' ? 'not given' : p.scoreText}</span></li>`)}</ul></div>`;
  }
  function actionsHtml(idea) {
    const done = S.added[idea.id], editor = W.FinanceDashboard && typeof W.FinanceDashboard.openEditor === 'function';
    return html`<div class="ig-actions">${done
      ? html`<p class="ig-added" role="status"><span class="ig-dot ig-dot-solid" aria-hidden="true"></span>${cap('added to the project as a net-new mode.')}${editor ? '' : ' It is on the Root design page of the task editor.'}</p>${editor ? html`<button type="button" data-ig="open-editor" data-key="open-${idea.id}" aria-describedby="ig-title-${idea.id}">${LBL.openEditor}</button>` : ''}`
      : html`<button type="button" data-ig="add" data-idea="${idea.id}" data-key="add-${idea.id}" aria-describedby="ig-title-${idea.id}">${LBL.add}</button>`}
      <button type="button" data-ig="copy" data-idea="${idea.id}" data-key="copy-${idea.id}" aria-describedby="ig-title-${idea.id}">${LBL.copy}</button></div>`;
  }
  function cardHtml(idea) {
    return html`<li><article class="ig-card" id="ig-card-${idea.id}" tabindex="-1" aria-labelledby="ig-title-${idea.id}" data-ig-idea="${idea.id}">
      <header class="ig-card-head"><p class="ig-tags"><span class="ig-status ig-status-${idea.status}"><span class="ig-dot ${STATUS_DOT[idea.status] || 'ig-dot-hollow'}" aria-hidden="true"></span>${idea.statusWords}</span>${idea.lead ? html`<span class="ig-lead">${LBL.leadTag}</span>` : ''}</p>
        <h3 class="ig-card-title" id="ig-title-${idea.id}">${idea.title}</h3><p class="ig-summary">${idea.summary}</p></header>
      ${overlapHtml(idea)}
      <div class="ig-sec"><h4 class="ig-h4">${LBL.why}</h4><p>${idea.whyItHolds}</p></div>
      <details class="ig-sec ig-build" data-key="build-${idea.id}"><summary class="ig-h4">${LBL.build}</summary><ol class="ig-moves">${idea.buildMoves.map(m => html`<li>${m}</li>`)}</ol></details>
      ${attachHtml(idea)}${precedentsHtml(idea)}
      <p class="ig-honest">${idea.honesty || TEXT.honesty}</p>${actionsHtml(idea)}</article></li>`;
  }
  function cardsHtml() {
    if (!S.result) return '';
    const list = visibleIdeas(), shown = list.slice(0, S.shown), left = list.length - shown.length;
    if (!S.result.ideas.length) return html`<p class="ig-empty">No ideas were produced from these inputs.</p>`;
    return html`<p class="ig-count" id="ig-count">${countText(list)}</p>
      ${list.length ? html`<ol class="ig-list" role="list" aria-label="Ideas">${shown.map(cardHtml)}</ol>` : html`<div class="ig-empty"><p>No ideas match these filters. Clear the search or turn off ${LBL.lead}.</p><button type="button" data-ig="clear-filters">${LBL.clear}</button></div>`}
      ${left > 0 ? html`<div class="ig-more"><button type="button" id="ig-more" data-ig="more">${moreLabel(Math.min(PAGE, left))}</button><span class="ig-meta">${plural(left, 'idea')} not shown yet.</span></div>` : ''}`;
  }
  function dialogHtml() {
    const d = S.dialog;
    if (!d) return '';
    const idea = S.result && S.result.ideas.find(i => i.id === d.ideaId), modes = modeInfo();
    if (!idea) return '';
    const overlap = idea.status === 'overlap' || idea.status === 'covered';
    return html`<div class="ig-backdrop" data-ig="backdrop"><div class="ig-dialog" role="dialog" aria-modal="true" aria-labelledby="ig-dialog-h" aria-describedby="ig-dialog-d" tabindex="-1" data-ig-dialog>
      <h2 id="ig-dialog-h" class="ig-dialog-title">Add this idea as a net-new mode?</h2>
      <div id="ig-dialog-d" class="ig-dialog-body"><p class="ig-dialog-idea">${idea.title}</p>
        <p>A derivative task locks five failure modes: three historical and two net-new.</p>
        ${modes ? html`<p>This project has ${plural(modes.roots, 'mode')}, ${modes.netNew} of them net-new, so ${slotsText(modes.open)}.${modes.open <= 0 ? ' ' + cap('adding this idea goes past the net-new slots, and the task editor will flag the set for review.') : ''}</p>` : html`<p>The open project could not be read, so the open net-new slots are not known.</p>`}
        ${overlap ? html`<p>This idea overlaps a current mode, so adding it may count one failure twice${idea.overlapWith.length ? ': ' + idea.overlapWith.slice(0, 3).map(o => o.title).join('; ') : ''}.</p>` : ''}
        <p>It is added as a pending hypothesis. You edit and review it in the task editor.${modes && modes.addressed > 0 ? ' ' + LINE.gatesReset : ''}</p></div>
      <div class="ig-dialog-actions"><button type="button" data-ig="cancel" id="ig-dialog-cancel">${LBL.cancel}</button><button type="button" data-ig="confirm-add" id="ig-dialog-confirm">${LBL.add}</button></div></div></div>`;
  }

  function modalHost() {
    let host = $('#ig-modal');
    if (!host) {
      host = document.createElement('div');
      host.id = 'ig-modal';
      document.body.appendChild(host);
    }
    return host;
  }
  const paintInputs = () => paint('ig-inputs', inputsHtml());
  const paintAction = () => paint('ig-action', actionHtml());
  const paintBar = () => paint('ig-bar', barHtml());
  const paintFilters = () => paint('ig-filters', filtersHtml(), true);
  const paintCards = () => paint('ig-cards', cardsHtml());
  function paintModal() {
    const host = S.dialog ? modalHost() : $('#ig-modal');
    if (host) V.setHtml(host, dialogHtml());
  }
  function paintAll() {
    paintInputs(); paintAction(); paintBar(); paintFilters(); paintCards(); paintModal();
  }

  /* ---------- the precedent workbook ---------- */
  function picker() {
    if (S.picker) return S.picker;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,text/csv';
    input.id = 'ig-workbook-file';
    input.hidden = true;
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    input.setAttribute('data-ig-file', 'workbook');
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (file) readWorkbook(file);
      try { input.value = ''; } catch { /* a file input cannot always be reset */ }
    });
    document.body.appendChild(input);
    S.picker = input;
    return input;
  }
  /* The line names the file that was refused and says whether an earlier workbook is still in use. The same line is announced. */
  function workbookError(name, text) {
    S.libraryBusy = false;
    S.libraryError = cap('could not use ') + (M.displayText(name) || 'that file') + '. ' + text + (S.library ? ' ' + LINE.stays : '');
    paintInputs(); paintAction();
    say(S.libraryError);
  }
  /* A keyboard user who pressed the load button keeps their place: when the focus fell to the page after the read, it goes to the new remove link. */
  function keepPlace(selector) {
    const active = document.activeElement;
    if (!active || active === document.body) focusSelector(selector);
  }
  async function readWorkbook(file) {
    const ticket = ++S.ticket, name = String(file.name || '');
    if (!/\.csv$/i.test(name) && !/csv/i.test(String(file.type || ''))) return workbookError(name, 'That file is not a CSV. Choose a .csv export of your workbook.');
    if (file.size > MAX_BYTES) return workbookError(name, 'That file is larger than 5 MB, which is more than this page reads. ' + cap('export fewer rows and try again.'));
    S.libraryBusy = true; S.libraryError = '';
    paintInputs(); paintAction();
    let text = '';
    try { text = await file.text(); } catch { return workbookError(name, 'The file could not be read.'); }
    if (ticket !== S.ticket) return undefined;
    let parsed = null;
    try { parsed = M.parseLibraryCsv(text, {maxBytes: MAX_BYTES, maxRows: 5000}); } catch (error) { return workbookError(name, 'That file could not be used: ' + message(error)); }
    if (!parsed.rows.length) {
      const first = parsed.rejected[0];
      return workbookError(name, 'No usable rows were found in that file. The first row needs column names for the workflow, the trap, what was built, how it went and the score.' + (first ? ' First rejected row: line ' + first.line + ', ' + first.reason : ''));
    }
    try {
      const labelled = M.labelRows(parsed.rows, A);
      S.library = Object.assign({}, parsed, {labels: labelled.labels});
    } catch (error) { return workbookError(name, 'That file could not be used: ' + message(error)); }
    S.libraryName = M.displayText(name);
    S.workflows = [...new Set(parsed.rows.map(r => r.workflow).filter(w => w && w.length <= 200 && M.displayText(w) === w))].sort(cmp).slice(0, MAX_SUGGESTIONS);
    S.libraryBusy = false; S.libraryError = '';
    paintInputs(); paintAction(); paintBar();
    say(cap('workbook read: ') + plural(parsed.rows.length, 'row') + ', ' + plural(parsed.rejected.length, 'row') + ' rejected, ' + plural(parsed.warnings.length, 'warning') + '.');
    keepPlace('#ig-remove-workbook');
    return undefined;
  }
  /* Removing the workbook forgets it, including the precedent text the ideas on the page were holding; the ideas stay, marked as made from a workbook that is gone. */
  function removeWorkbook() {
    S.ticket++;
    S.library = null; S.libraryName = ''; S.workflows = []; S.libraryError = ''; S.libraryBusy = false;
    if (S.result) S.result = Object.assign({}, S.result, {libraryUsed: false, removed: S.result.libraryUsed || S.result.removed === true, ideas: S.result.ideas.map(idea => Object.assign({}, idea, {precedents: [], lowestScoreText: null}))});
    paintInputs(); paintAction(); paintBar(); paintCards();
    say(cap('workbook removed from this page.'));
    focusSelector('#ig-load-workbook');
  }

  /* ---------- generating, filtering ---------- */
  function generate() {
    if (reason()) return;
    const pkg = S.mode === 'existing' ? currentPackage() : null;
    try {
      const out = M.buildIdeas({
        mode: S.mode, task: {workflow: S.mode === 'new' ? S.workflow.trim() : '', description: S.mode === 'new' ? S.description.trim() : ''},
        pkg, project: currentProject(), library: S.library, archetypes: A, now: new Date().toISOString(), limit: Math.min(100, Math.max(PAGE, (A.archetypes || []).length))
      });
      S.result = {ideas: out.ideas, notes: out.notes, libraryUsed: !!S.library, ordering: out.ordering || null, gen: signature()};
      S.error = ''; S.libraryError = ''; S.shown = PAGE; S.added = {}; S.dialog = null;
    } catch (error) {
      S.result = null;
      S.error = 'Ideas could not be generated: ' + message(error);
    }
    paintAll();
    say(S.error || announceText(visibleIdeas()));
    revealResults();
  }
  /* In the one column layout the results start below the input panel, often off screen and always out of sight of the button that was pressed, so the
     heading is scrolled to the top and takes focus. With the two columns side by side nothing moves, unless the heading has scrolled out of sight. */
  function revealResults() {
    try {
      const h = $('#ig-results-h'), a = $('#ig-action');
      if (!h || typeof h.getBoundingClientRect !== 'function' || typeof h.focus !== 'function') return;
      const box = h.getBoundingClientRect(), height = W.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0;
      const below = a && typeof a.getBoundingClientRect === 'function' ? a.getBoundingClientRect().bottom : Infinity;
      if (box.top < below && box.top >= 0 && box.bottom <= height) return;
      if (typeof h.scrollIntoView === 'function') h.scrollIntoView({block: 'start'});
      h.focus({preventScroll: true});
    } catch { /* moving the view is a courtesy */ }
  }
  function announceCount() {
    clearTimeout(S.timer);
    S.timer = setTimeout(() => { S.timer = null; say(announceText(visibleIdeas())); }, 600);
  }
  function refilter(focusFirstNew) {
    paintCards();
    announceCount();
    if (focusFirstNew) focusSelector('#ig-card-' + focusFirstNew);
  }
  function refreshStale() {
    if (S.result && isStale() !== S.lastStale) paintBar();
  }

  /* ---------- cards: add, copy ---------- */
  const ideaById = id => (S.result ? S.result.ideas.find(i => i.id === id) : null);
  function ideaText(idea) {
    const lines = [idea.title, idea.statusWords, '', idea.summary, '', LBL.why, idea.whyItHolds, '', LBL.build];
    idea.buildMoves.forEach((m, i) => lines.push((i + 1) + '. ' + m));
    if (idea.applicability.length) { lines.push('', LBL.attach); idea.applicability.forEach(a => lines.push(a.documentName + ' ' + a.locator + ': ' + a.quote)); }
    /* The precedents are rows of the person's workbook, which is read in this browser only: they stay on the page and are not copied. */
    if (idea.status === 'overlap' || idea.status === 'covered') { lines.push('', cap('check before adding: ') + idea.overlapWith.slice(0, 3).map(o => o.title + ': ' + o.why).join(' ')); }
    lines.push('', idea.honesty || TEXT.honesty);
    return lines.join('\n');
  }
  function copyIdea(idea) {
    V.copyText(ideaText(idea)).then(ok => notify(ok ? 'Copied the idea as text.' : 'Copying did not work in this browser.', !ok));
  }
  function openDialog(ideaId, triggerKey) {
    if (S.added[ideaId] || !ideaById(ideaId)) return;
    S.dialog = {ideaId, triggerKey};
    paintModal();
    focusSelector('#ig-modal [data-ig-dialog]');
  }
  function closeDialog(restore) {
    const d = S.dialog;
    S.dialog = null;
    paintModal();
    if (restore && d && d.triggerKey) focusSelector('[data-key="' + d.triggerKey + '"]');
  }
  function confirmAdd() {
    const d = S.dialog, idea = d && ideaById(d.ideaId);
    closeDialog(false);
    if (!idea) return;
    const editor = authoring();
    if (!editor || typeof editor.addCandidate !== 'function') return notify('The task editor is not loaded, so the idea was not added.', true);
    try {
      const pkg = S.result && S.result.gen.mode === 'existing' ? currentPackage() : null;
      const project = editor.getProject();
      const authoringProject = M.toAuthoringProject(idea, {pkg, project});
      const rootId = editor.addCandidate(pkg, {id: idea.id, title: idea.title, authoringProject});
      S.added[idea.id] = {rootId};
      const canOpen = W.FinanceDashboard && typeof W.FinanceDashboard.openEditor === 'function';
      notify(cap('added "') + idea.title + '" as a net-new mode. ' + (canOpen ? 'Open the task editor to review it.' : 'It is on the Root design page of the task editor.'));
      paintCards(); refreshStale();
      say(cap('added as a net-new mode.'));
      focusSelector(canOpen ? '[data-key="open-' + idea.id + '"]' : '#ig-card-' + idea.id);
    } catch (error) {
      notify('The idea could not be added: ' + message(error), true);
    }
  }

  /* ---------- events (delegated on the document; only this page's own elements count) ---------- */
  const CLICK = {
    'load-package'() { S.loadingPackage = true; const fn = CTX.loadFiles || (W.FinanceDashboard && W.FinanceDashboard.loadFiles); if (typeof fn === 'function') fn(); },
    'load-workbook'() { if (!S.libraryBusy) picker().click(); },
    'remove-workbook': removeWorkbook,
    generate,
    more() {
      const before = visibleIdeas().slice(0, S.shown).length, list = visibleIdeas();
      S.shown += PAGE;
      const next = list[before];
      refilter(next ? next.id : '');
    },
    'clear-filters'() { S.query = ''; S.lead = false; S.shown = PAGE; paintFilters(); refilter(''); focusSelector('#ig-search'); },
    add(el) { openDialog(el.dataset.idea, el.dataset.key || 'add-' + el.dataset.idea); },
    copy(el) { const idea = ideaById(el.dataset.idea); if (idea) copyIdea(idea); },
    'open-editor'() { const d = W.FinanceDashboard; if (d && typeof d.openEditor === 'function') d.openEditor('roots'); },
    'confirm-add': confirmAdd,
    cancel() { closeDialog(true); }
  };
  const INPUT = {
    mode(el) {
      if (el.value !== 'new' && el.value !== 'existing') return;
      if (S.mode === el.value) return;
      S.mode = el.value; S.error = ''; S.libraryError = '';
      paintInputs(); paintAction(); paintBar();
    },
    workflow(el) { S.workflow = String(el.value || ''); paintAction(); refreshStale(); },
    description(el) { S.description = String(el.value || ''); paintAction(); refreshStale(); },
    search(el) { S.query = String(el.value || ''); S.shown = PAGE; refilter(''); },
    lead(el) { if (S.lead === !!el.checked) return; S.lead = !!el.checked; S.shown = PAGE; refilter(''); }
  };
  /* A text field answers input events only. Its change event also fires when the field is removed by a repaint (Clear filters), from the
     detached element and with the text that was just cleared, which would bring the old text back. Choices answer change events. */
  const FIELD_EVENT = {mode: 'change', lead: 'change', workflow: 'input', description: 'input', search: 'input'};
  function trapTab(e) {
    const host = $('#ig-modal');
    const nodes = host && typeof host.querySelectorAll === 'function' ? Array.prototype.slice.call(host.querySelectorAll('button')) : [];
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1], active = document.activeElement, box = host.querySelector('[data-ig-dialog]');
    if (e.shiftKey && (active === first || active === box || !host.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !host.contains(active))) { e.preventDefault(); first.focus(); }
  }
  function handleEvent(e) {
    const target = e && e.target;
    if (!target || typeof target.closest !== 'function') return;
    const mine = el => !!el && (!!el.closest('#ig-root') || !!el.closest('#ig-modal'));
    if (e.type === 'keydown') {
      if (!S.dialog) return;
      if (e.key === 'Escape') { if (typeof e.preventDefault === 'function') e.preventDefault(); closeDialog(true); }
      else if (e.key === 'Tab') trapTab(e);
      return;
    }
    if (e.type === 'click') {
      const el = target.closest('[data-ig]');
      if (!el || !mine(el)) return;
      if (el.dataset.ig === 'backdrop') { if (e.target === el) closeDialog(true); return; }
      if (el.disabled) return;
      const handler = CLICK[el.dataset.ig];
      if (handler) { try { handler(el); } catch (error) { notify('Something went wrong on this page: ' + message(error), true); } }
      return;
    }
    if (e.type !== 'input' && e.type !== 'change') return;
    /* The shell's own file picker answers a click on the load task package button. The shell shows the candidate roots page when the files are read, so this page notes
       which package it was looking at and takes the person back once a different one is in. */
    if (e.type === 'change' && target.id === 'package-files') {
      if (S.loadingPackage && target.files && target.files.length) S.returnFrom = fingerprintOf(livePackage());
      S.loadingPackage = false;
      return;
    }
    const el = target.closest('[data-ig-in]');
    if (!el || !mine(el) || FIELD_EVENT[el.dataset.igIn] !== e.type) return;
    const handler = INPUT[el.dataset.igIn];
    if (handler) { try { handler(el); } catch (error) { notify('Something went wrong on this page: ' + message(error), true); } }
  }
  ['click', 'input', 'change', 'keydown'].forEach(type => document.addEventListener(type, handleEvent));

  /* The shell has just drawn another page after a package was read from here: draw this one again, once the shell is done. */
  function comeBack() {
    const go = CTX.navigate || (W.FinanceDashboard && W.FinanceDashboard.navigate);
    if (typeof go === 'function') setTimeout(() => { try { go('ideas'); } catch { /* the person can choose the page again */ } }, 0);
  }

  /* ---------- the module the dashboard calls ---------- */
  function render(ctx) {
    CTX = {package: (ctx && ctx.package) || null, notify: ctx && ctx.notify, loadFiles: ctx && ctx.loadFiles, navigate: ctx && ctx.navigate};
    return String(html`<div id="ig-root" class="ig-root">
      <header class="ig-head"><p class="ig-index" aria-hidden="true">03 /</p><h1 class="ig-title">Mode ideas</h1><p class="ig-tagline">${TAGLINE}</p></header>
      <div class="ig-layout">
        <section class="ig-inputs" aria-labelledby="ig-inputs-h"><h2 id="ig-inputs-h" class="sr-only">${LBL.inputs}</h2><div class="ig-panel"><div id="ig-inputs"></div><div id="ig-action" class="ig-action"></div></div></section>
        <section class="ig-results" aria-labelledby="ig-results-h"><div id="ig-bar" class="ig-bar"></div><div id="ig-filters"></div><div id="ig-cards"></div></section>
      </div>
      <div id="ig-live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div></div>`);
  }
  function afterRender(active) {
    if (!active) {
      clearTimeout(S.timer); S.timer = null;
      if (S.dialog) { S.dialog = null; paintModal(); }
      if (S.returnFrom !== null) {
        const changed = S.returnFrom !== fingerprintOf(livePackage());
        S.returnFrom = null;
        if (changed) comeBack();
      }
      S.loadingPackage = false;
      return;
    }
    paintAll();
  }
  W.FinanceIdeas = {render, afterRender, handleEvent};
})();
