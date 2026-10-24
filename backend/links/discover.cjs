'use strict';
/* Finding every file a page offers takes more than one look. A single-page app fills in after the load, a list may be virtualised (only
   the rows on screen exist), files may sit in a closed <details>, behind a tab, after "Load more", on page 2 of a pager. So the loader
   takes several snapshots and works with the UNION of what they hold:

     stabilize   a second snapshot 1 s and a third 3 s after the page settled; it stops as soon as two in a row are identical
     expand      open <details>, click expanders (aria-expanded=false, no popup menu, nothing that would submit a form), looking again after
                 every click; expandAll repeats it until nothing new opens, at most 6 passes
     gather      the open tab, then each other tab one at a time: expand, press every "Load more" while it adds files, scroll the scrollable
                 boxes until each one is at its bottom and the list stopped growing, follow the pager (Next, page numbers, or links that
                 change only a page parameter); every step is a snapshot
     replay      put the page back into the state a snapshot was taken in (its address, its tab, its page of the pager, the number of "Load
                 more" presses, its scroll steps), so a button that only exists there can be found and pressed later

   Every snapshot gather takes is stamped with its view { tab, pages, pageUrl, more, scroll } (snap.view); fileCandidates copies it into
   each candidate. A click candidate is identified by what it IS (the whole file-name phrase or the name cell of its row, its group, the
   tab it was seen in, its text), not by where it sat, so the same row seen twice is one candidate and two rows with the same words are two
   (the k-th occurrence in a snapshot is the k-th). As a backstop the set also counts the distinct rows it has seen (tab, text and
   name phrase of the row text); more rows than candidates means rows were taken for one another, and the loader says so in a note.

   NOTHING IS CUT WITHOUT A WORD. gather returns capped: [text], a plain sentence for every place it could not cover: a limit that ended a
   step while files were still appearing, a tab it could not open, tabs or "Load more" controls past the caps, a persistent "Load more", a
   pager it could not follow, a control that opens a menu or dialog that may hold files, a request that had not answered.

   Every click goes through pageOps' activate (which refuses an element that is not of the kind it was listed as, or that changed), and
   the person's page is put back (scrolled to the top, the first tab selected). Exports: stabilize, expand, expandAll, gather, replay,
   signature, CandidateSet, unionCandidates, unionDropped, mergeSections, candidateKey, nap. */

const { takePage, pageOp, fileCandidates, droppedCandidates, navigateKey, namePhrase, pagerSteps, pageLinkOk, tabLinkProblem, LIMITS } = require('./page.cjs');
const { guardWrites } = require('./gate.cjs');
const { waitForSettled } = require('./tab.cjs');
const { CdpError, sleep } = require('./cdp.cjs');

const cancelled = () => new CdpError('Cancelled.', { code: 'CANCELLED' });
const checker = (signal) => () => { if (signal && signal.aborted) throw cancelled(); };

/* A sleep that notices a cancel. */
async function nap(ms, signal) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (signal && signal.aborted) throw cancelled();
    await sleep(Math.min(100, Math.max(1, end - Date.now())));
  }
}

/* What a snapshot shows, short enough to compare: section headings and text, file links and buttons, switches and their state. A
   link is compared without its signature: a platform that signs every address anew on each render is not "still changing". */
function signature(snap) {
  return JSON.stringify([
    (snap.sections || []).map((s) => [s.heading, s.text.length, s.text.slice(0, 40), s.text.slice(-40)]),
    (snap.links || []).map((l) => navigateKey(l.href, l.text)), (snap.buttons || []).map((b) => `${b.path}|${b.text}`),
    (snap.toggles || []).map((t) => [t.label, t.checked, t.path, t.option]),
  ]);
}

/* A tab is known by its label with the numbers taken out: "Reference (3)" becomes "Reference (9)" when the list grows. */
const tabKey = (label) => String(label || '').replace(/\d+/g, '#');
const hasExtension = (name) => /\.[A-Za-z0-9]{1,8}$/.test(String(name || ''));
const GENERIC_TEXT = /^(download|export)\b/i;
/* The identity of a candidate: a file link is its address without the signature; a click candidate is the file name phrase (or the text
   of its row), its group, the tab it was seen in, the text of the control and its address. A bare "Download" with no row text says
   nothing, so its position counts. withGroup:false and withTab:false leave out the heading above it (it can change when a switch adds
   a section above the file) and the tab (the live page shows only one). */
function candidateKey(c, { withGroup = true, withTab = true } = {}) {
  if (c.mode === 'navigate') return navigateKey(c.href || '', c.label || '', withTab && c.view && c.view.tab ? tabKey(c.view.tab.label) : '');
  const stable = Array.isArray(c.rowParts) && c.rowParts.length ? c.rowParts.join(' ') : '';   /* the row without what changes every minute */
  const name = hasExtension(c.nameHint) ? c.nameHint : (stable || c.label || '');
  const generic = (c.label || '') === (c.text || '') && GENERIC_TEXT.test(c.text || '');
  const tab = withTab && c.view && c.view.tab ? tabKey(c.view.tab.label) : '';
  return `c|${name}|${withGroup ? c.group || '' : ''}|${tab}|${c.text || ''}|${c.href || ''}${generic ? `|${c.path || ''}` : ''}`;
}
/* A row as the reader sees it, independent of how the name was cut: the tab, the control's text and the name phrase of the row text.
   Used only to count: if more distinct rows were seen than candidates kept, some rows were merged. */
const rowSignature = (c) => `${c.view && c.view.tab ? tabKey(c.view.tab.label) : ''}|${c.text || ''}|${Array.isArray(c.rowParts) && c.rowParts.length ? c.rowParts.join(' ') : namePhrase(c.label || c.text || '')}`;

/* Candidates from several snapshots as one list, in order of first appearance. Each candidate gets occ, its occurrence number among
   the candidates with the same key in the snapshot it first appeared in. A file link seen again keeps its place and takes the newest
   address (an older signature may have expired). A button whose heading changed between two snapshots (a switch added a section above
   it) is the same button: when the earlier one is gone from the newer snapshot and only the group differs, the group is updated.
   rows counts the distinct rows seen (see rowSignature); merged() is how many more rows than click candidates there are. */
class CandidateSet {
  constructor() { this.items = []; this.index = new Map(); this.loose = new Map(); this.rows = new Set(); }
  add(list) {
    const seen = new Map();
    const entries = list.map((c) => {
      const base = candidateKey(c);
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      return { c, n, key: `${base}#${n}`, loose: c.mode === 'click' ? `${candidateKey(c, { withGroup: false })}#${n}` : null };
    });
    const here = new Set(entries.map((e) => e.key));
    let fresh = 0;
    for (const e of entries) {
      let item = this.index.get(e.key);
      if (!item && e.loose) {
        const old = this.loose.get(e.loose);
        if (old && !here.has(old.key)) { item = old.item; item.c.group = e.c.group; this.index.set(e.key, item); }
      }
      if (!item) { item = { c: { ...e.c, occ: e.n } }; this.items.push(item); this.index.set(e.key, item); fresh += 1; } else if (e.c.mode === 'navigate') item.c.href = e.c.href;
      if (e.loose) { this.loose.set(e.loose, { key: e.key, item }); this.rows.add(rowSignature(e.c)); }
    }
    return fresh;
  }
  get size() { return this.items.length; }
  list() { return this.items.map((i) => i.c); }
  merged() { return Math.max(0, this.rows.size - this.items.filter((i) => i.c.mode === 'click').length); }
}
function unionCandidates(lists) {
  const set = new CandidateSet();
  for (const list of lists) set.add(list);
  return set.list();
}
/* Like unionCandidates, with the number of rows that look different but were merged (0 when all is well). */
function unionWithCheck(lists) {
  const set = new CandidateSet();
  for (const list of lists) set.add(list);
  return { list: set.list(), merged: set.merged() };
}
/* The controls that look like files and were left out, once each. */
function unionDropped(lists) {
  const seen = new Map();
  for (const list of lists) for (const d of list) { const key = `${d.label}\u0000${d.group}\u0000${d.reason}`; if (!seen.has(key)) seen.set(key, d); }
  return [...seen.values()];
}

/* Several snapshots' sections as one. The k-th section with a given heading in one snapshot is the k-th in the next; lines the
   first snapshot did not have are added at the end of that section, so a list that is virtualised, or loads more, ends up complete. */
function mergeSections(lists, { sections = 200, sectionChars = 20000 } = {}) {
  const merged = new Map();
  const order = [];
  for (const list of lists) {
    const counts = new Map();
    for (const s of list || []) {
      const n = (counts.get(s.heading) || 0) + 1;
      counts.set(s.heading, n);
      const key = `${s.heading}\u0000${n}`;
      const lines = String(s.text).split('\n');
      if (!merged.has(key)) { merged.set(key, { heading: s.heading, lines: [...lines], have: new Set(lines) }); order.push(key); continue; }
      const m = merged.get(key);
      for (const line of lines) if (!m.have.has(line)) { m.have.add(line); m.lines.push(line); }
    }
  }
  return order.slice(0, sections).map((key) => ({ heading: merged.get(key).heading, text: merged.get(key).lines.join('\n').slice(0, sectionChars) }));
}

/* snaps[0] was taken when the page settled. Returns every snapshot taken (first one included). */
async function stabilize(tab, first, { signal, waits = [1000, 2000] } = {}) {
  const snaps = [first];
  let previous = first;
  for (const wait of waits) {
    await nap(wait, signal);
    const next = await takePage(tab);
    snaps.push(next);
    if (signature(next) === signature(previous)) break;
    previous = next;
  }
  return snaps;
}

/* The short settle after a click, a press or a scroll step. A DOM that keeps changing ends it at 2.5 s, but an API request that was started
   by the step and has not answered yet is waited for (up to 22 s): a tab or a "Load more" served by a slow API. lost: how many such
   requests had not answered when it ended (those given up on at 20 s included). */
const quick = (tab, signal, since = 0, patientMs = 22000) => waitForSettled(tab, { idleMs: 250, quietMs: 250, maxMs: 2500, patientMs, since, graceMs: 350, signal });
const LOST = (where) => `a request of the page was still waiting for its answer ${where}, so some files may be missing`;
const stamp = (snap, view) => { if (view) snap.view = { tab: view.tab ? { ...view.tab } : null, pages: view.pages || 0, pageUrl: view.pageUrl || null, more: view.more, scroll: view.scroll }; return snap; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const urlKey = (href) => { try { const u = new URL(href); u.hash = ''; return u.href; } catch (e) { return String(href); } };

/* EVERY press the loader makes (a tab, an expander, "Load more", a pager, the "show all files" switch, a download) runs with the write guard
   on, from before the press until the page has settled after it: a request that is not a read (PUT, PATCH, DELETE, a POST that is not a data
   query) is failed before it leaves the browser. The control that was pressed when the page tried to save something is put in
   ctx.banned (it is not pressed again, here or in replay) and ctx.skip (its path, for the expanders), and ctx.say gets the sentence. */
const blockedNote = (label) => `The page tried to save a change when '${label}' was pressed; it was blocked`;
const newCtx = (say = () => {}) => ({ banned: new Set(), skip: new Set(), say });
const keyOf = (kind, path, label) => `${kind}|${path}|${label}`;
async function guarded(tab, ctx, fn) {
  const st = { count: 0, seen: 0, last: null };
  const guard = await guardWrites(tab, { onBlocked: () => { st.count += 1; } });
  try { return await fn(st); } finally {
    await guard.stop();
    if (st.count > st.seen && st.last) {   /* a write that came after the last press was looked at: it was that control's */
      st.seen = st.count; ctx.banned.add(st.last.key); ctx.skip.add(st.last.path); ctx.say(blockedNote(st.last.label));
    }
  }
}
/* One press under a guard (st comes from guarded). { ok, why? } like the page op, and blocked: true when a write was failed because of it. */
async function pressOne(tab, st, ctx, kind, item, extra = {}) {
  st.last = { key: keyOf(kind, item.path, item.label), label: item.label, path: item.path };
  const r = await pageOp(tab, 'activate', { path: item.path, kind, label: item.label, ...extra });
  if (!r.ok) return r;
  await sleep(20);   /* a write the press started reaches the guard in this time */
  if (st.count > st.seen) { st.seen = st.count; ctx.banned.add(st.last.key); ctx.skip.add(item.path); ctx.say(blockedNote(item.label)); return { ok: true, blocked: true }; }
  return { ok: true, blocked: false };
}
/* A single press with its settle, guarded all the way: { r, since }. */
async function pressControl(tab, ctx, kind, item, extra, { signal, patientMs } = {}) {
  return guarded(tab, ctx, async (st) => {
    const since = Date.now() - 50;
    const r = await pressOne(tab, st, ctx, kind, item, extra);
    if (r.ok) await quick(tab, signal, since, patientMs);
    return r;
  });
}

/* The cheap part, one pass: details and expanders. Pushes a snapshot into `snaps` when it did anything. Returns what it did. */
async function expand(tab, snaps, { signal, view, ctx = null } = {}) {
  const c = ctx || newCtx();
  const since = Date.now() - 50;
  const did = await guarded(tab, c, async (st) => {
    const r = await pageOp(tab, 'expand', { skip: [...c.skip] });
    st.last = { key: keyOf('expander', r.path || '', r.label || ''), label: r.label || '', path: r.path || '' };
    if (r.opened || r.expanded) await quick(tab, signal, since);
    return r;
  });
  if (did.opened || did.expanded) { did.lost = 0; snaps.push(stamp(await takePage(tab), view)); }
  return did;
}

/* Repeat it until nothing new opens, at most `passes` times: a folder opened in one pass can show another closed folder. A pass presses the
   expanders ONE AT A TIME (looking again after each: a tree that draws itself anew has new nodes), then settles. With snapshots:false the
   page is only put into the state (no look is taken). Returns the totals; capped: the last pass still opened something (or a pass was cut);
   blocked: expanders that would submit a form (not pressed); popups: openers of a menu or dialog whose name says files (not pressed). */
async function expandAll(tab, snaps, { signal, view, passes = 6, snapshots = true, patientMs, ctx = null } = {}) {
  const c = ctx || newCtx();
  const total = { opened: 0, expanded: 0, passes: 0, lost: 0, blocked: 0, popups: [], capped: false };
  for (let i = 0; i < passes; i += 1) {
    checker(signal)();
    const since = Date.now() - 50;
    const pass = { opened: 0, expanded: 0, cut: false };
    const lost = await guarded(tab, c, async (st) => {
      for (let n = 0; n < 400; n += 1) {
        checker(signal)();
        const before = st.count;
        const r = await pageOp(tab, 'expand', { one: true, skip: [...c.skip] });
        total.blocked += r.blocked || 0;
        for (const p of r.popups || []) if (!total.popups.includes(p)) total.popups.push(p);
        pass.opened += r.opened || 0; pass.expanded += r.expanded || 0;
        if (r.cut) pass.cut = true;
        if (!r.expanded) break;
        st.last = { key: keyOf('expander', r.path || '', r.label || ''), label: r.label || '', path: r.path || '' };
        await sleep(20);
        if (st.count > before) { st.seen = st.count; c.banned.add(st.last.key); c.skip.add(st.last.path); c.say(blockedNote(st.last.label)); }
        if (n === 399) pass.cut = true;
      }
      if (!pass.opened && !pass.expanded) return 0;
      return (await quick(tab, signal, since, patientMs)).lost || 0;
    });
    if (!pass.opened && !pass.expanded) break;
    total.opened += pass.opened; total.expanded += pass.expanded; total.passes += 1;
    if (pass.cut) total.capped = true;
    total.lost += lost;
    if (snapshots) snaps.push(stamp(await takePage(tab), view));
    if (i === passes - 1) total.capped = true;
  }
  return total;
}

/* Put the page back into the state a snapshot was taken in: its address (a page of a pager made of links), the tab (or the home tab), the
   page of the pager, the "Load more" presses, the scroll steps. pos is the loader's idea of where the pager is now
   ({ pages, url }); goto(url) loads an address; ctx holds the controls that must not be pressed again. Returns { ok } or { ok: false, why }. */
async function replay(tab, view, home, { signal, pos = null, goto = null, homeUrl = null, ctx = null } = {}) {
  const check = checker(signal);
  const c = ctx || newCtx();
  const at = pos || { pages: 0, url: null };
  const wantUrl = (view && view.pageUrl) || null;
  const wantPages = (view && view.pages) || 0;
  if (goto && ((wantUrl || null) !== (at.url || null) || wantPages < at.pages)) { await goto(wantUrl || homeUrl); at.url = wantUrl; at.pages = 0; }
  const want = (view && view.tab) || home || null;
  const controls = await pageOp(tab, 'controls');
  if (want && controls.tabs.length) {
    const wantKey = tabKey(want.label);
    const fresh = controls.tabs.find((t) => tabKey(t.label) === wantKey && t.path === want.path) || controls.tabs.find((t) => tabKey(t.label) === wantKey);
    if (!fresh) return { ok: false, why: `the tab "${want.label}" is no longer on the page` };
    if (!fresh.selected) {
      if (c.banned.has(keyOf('tab', fresh.path, fresh.label))) return { ok: false, why: `the tab "${want.label}" is not pressed again: the page tried to save a change when it was pressed` };
      if (fresh.href) {
        const here = (await pageOp(tab, 'where')).href;
        const why = tabLinkProblem(fresh.href, here);
        if (why) return { ok: false, why: `the tab "${want.label}" is a link to an address the loader does not open (${why})` };
      }
      const r = await pressControl(tab, c, 'tab', fresh, fresh.href ? { href: fresh.href } : {}, { signal });
      if (!r.ok) return { ok: false, why: `the tab "${want.label}" could not be opened again (${r.why})` };
      at.pages = 0;
    }
  }
  while (at.pages < wantPages) {
    check();
    const step = pagerSteps((await pageOp(tab, 'controls')).pager)[0];
    if (!step || step.href) return { ok: false, why: 'the page of the list it was on could not be reached again' };
    if (c.banned.has(keyOf('pager', step.path, step.label))) return { ok: false, why: 'the page control is not pressed again: the page tried to save a change when it was pressed' };
    const r = await pressControl(tab, c, 'pager', step, {}, { signal });
    if (!r.ok) return { ok: false, why: `the page of the list could not be reached again (${r.why})` };
    at.pages += 1;
  }
  await expandAll(tab, [], { signal, snapshots: false, ctx: c });
  for (let round = 0; round < ((view && view.more) || 0); round += 1) {   /* a round presses every "Load more" the page shows, as gather did */
    check();
    const buttons = ((await pageOp(tab, 'controls')).more || []).filter((m) => !c.banned.has(keyOf('more', m.path, m.label)));
    const pressed = await guarded(tab, c, async (st) => {
      const since = Date.now() - 50;
      let n = 0;
      for (const more of buttons) { const r = await pressOne(tab, st, c, 'more', more); if (r.ok && !r.blocked) n += 1; }
      if (n) await quick(tab, signal, since);
      return n;
    });
    if (!pressed) break;
    await expandAll(tab, [], { signal, snapshots: false, ctx: c });
  }
  await pageOp(tab, 'scroll', { reset: true });
  for (let i = 0; i < ((view && view.scroll) || 0); i += 1) {
    check();
    const since = Date.now() - 50;
    const r = await pageOp(tab, 'scroll');
    if (!r.moved) break;
    await sleep(120);
    await quick(tab, signal, since);
  }
  return { ok: true };
}

/* The slow part: for the open tab and then for each other tab, expand, press every "Load more" while the presses add files, scroll until
   every scrollable box is at its bottom and the list stopped growing, follow the pager. Pushes a snapshot after every step. Every step waits
   for the answer of an API request that it started (a slow tab, a slow page of the list). budgetMs is the time for the whole page; every
   tab gets at least minPerTabMs. pos: where the pager is ({ pages, url }, kept by the caller); goto(url): load an address (pager links);
   homeUrl: the address of the task page; ctx: the controls that were blocked (shared with replay and the caller). Returns { tabs, more,
   scrolls, pages, home, capped: [sentence] }: capped is the list of things it could not cover completely. */
async function gather(tab, snaps, { signal, budgetMs = 60000, maxScroll = 300, maxMore = 200, maxPages = 100, minPerTabMs = 8000, patientMs, pos = null, goto = null, homeUrl = null, ctx = null } = {}) {
  const check = checker(signal);
  const started = Date.now();
  const at = pos || { pages: 0, url: null };
  const known = new CandidateSet();
  for (const s of snaps) known.add(fileCandidates(s));
  const did = { tabs: 0, more: 0, scrolls: 0, pages: 0, home: null, capped: [] };
  const say = (text) => { if (!did.capped.includes(text)) did.capped.push(text); };
  const base = ctx || newCtx();
  const c = { banned: base.banned, skip: base.skip, say: (text) => { say(text); base.say(text); } };
  const grab = async (view, since, where) => {
    check();
    const r = await quick(tab, signal, since, patientMs);
    if (r.lost) say(LOST(where));
    const s = stamp(await takePage(tab), view);
    snaps.push(s);
    return known.add(fileCandidates(s));
  };
  const grabAfter = async (view, where) => {   /* snapshots the expansion takes also count */
    const before = snaps.length;
    const total = await expandAll(tab, snaps, { signal, view, patientMs, ctx: c });
    if (total.lost) say(LOST(where));
    if (total.capped) say(`folders or sections were still opening when the loader stopped (${plural(total.expanded, 'press', 'presses')} in ${plural(total.passes, 'pass', 'passes')})${where}, so some files may be missing`);
    if (total.blocked) say(`${plural(total.blocked, 'section', 'sections')} that would submit a form if opened ${total.blocked === 1 ? 'was' : 'were'} not opened`);
    for (const p of total.popups) say(`"${p}" opens a menu or dialog that may hold files; it was not opened`);
    let fresh = 0;
    for (let i = before; i < snaps.length; i += 1) fresh += known.add(fileCandidates(snaps[i]));
    return fresh;
  };
  const reportControls = (ctl) => {
    if (ctl.cut && ctl.cut.tabs) say(`${plural(ctl.cut.tabs, 'tab', 'tabs')} past the ${LIMITS.tabsMax} the loader opens ${ctl.cut.tabs === 1 ? 'was' : 'were'} not opened`);
    if (ctl.cut && ctl.cut.more) say(`${plural(ctl.cut.more, 'control', 'controls')} like "Load more" past the ${LIMITS.moreMax} the loader presses ${ctl.cut.more === 1 ? 'was' : 'were'} not pressed`);
    if (ctl.blocked) say(`${plural(ctl.blocked, 'control', 'controls')} like "Load more" that would submit a form ${ctl.blocked === 1 ? 'was' : 'were'} not pressed`);
    for (const l of ctl.popups || []) say(`"${l}" opens a menu or dialog that may hold files; it was not opened`);
  };

  const here0 = (await pageOp(tab, 'where')).href;
  const controls = await pageOp(tab, 'controls');
  reportControls(controls);
  const homeTab = controls.tabs.find((t) => t.selected) || null;
  /* a tab that is a link is followed only when its address passes the same tests as a file's, and stays on the site */
  const tabs = controls.tabs.filter((t) => {
    if (c.banned.has(keyOf('tab', t.path, t.label))) return false;
    if (t.href && !t.selected) {
      const why = tabLinkProblem(t.href, here0);
      if (why) { say(`the tab "${t.label}" is a link to an address the loader does not open (${why}), so its files were not looked at`); return false; }
    }
    return true;
  });
  did.home = homeTab ? { label: homeTab.label, path: homeTab.path } : null;

  /* "Load more": every button the page shows is pressed, round after round, while the rounds add files */
  const moreLoop = async (view, where, over) => {
    let flat = 0; let ended = 'done';
    for (let i = 0; ; i += 1) {
      check();
      if (i >= maxMore) { ended = 'steps'; break; }
      if (over()) { ended = 'time'; break; }
      const ctl = await pageOp(tab, 'controls');
      reportControls(ctl);
      const buttons = (ctl.more || []).filter((m) => !c.banned.has(keyOf('more', m.path, m.label)));
      if (!buttons.length) break;
      const round = await guarded(tab, c, async (st) => {
        const since = Date.now() - 50;
        let pressed = 0; let why = '';
        for (const more of buttons) { const r = await pressOne(tab, st, c, 'more', more); if (r.ok && !r.blocked) pressed += 1; else if (!r.ok) why = r.why; }
        if (!pressed) return { pressed, why, fresh: 0 };
        did.more += pressed; view.more += 1;
        const fresh = (await grab(view, since, `after "Load more"${where}`)) + (await grabAfter(view, `after "Load more"${where}`));
        return { pressed, why, fresh };
      });
      if (!round.pressed) { if (round.why) say(`"${buttons[0].label}"${where} could not be pressed (${round.why}), so the list may have more files`); break; }
      flat = round.fresh ? 0 : flat + 1;
      if (flat >= 2) { ended = 'flat'; break; }
    }
    if (ended === 'steps' || ended === 'time') say(`"Load more"${where} stopped at ${ended === 'time' ? 'the time limit' : `${maxMore} presses`} and may have more files`);
    else if (ended === 'flat') {
      const left = ((await pageOp(tab, 'controls')).more || []).filter((m) => !c.banned.has(keyOf('more', m.path, m.label)));
      if (left.length) say(`"${left[0].label}"${where} was still on the page after ${plural(view.more, 'press', 'presses')}; the last 2 added no files`);
    }
  };

  /* scrolling: until every scrollable box is at its bottom and the page stopped growing (an infinite scroller adds a chunk when its end is reached) */
  const scrollLoop = async (view, where, over) => {
    let idle = 0; let ended = 'done'; let stuck = 0; let lastHeight = -1;
    for (let step = 0; ; step += 1) {
      check();
      if (step >= maxScroll) { ended = 'steps'; break; }
      if (over()) { ended = 'time'; break; }
      const since = Date.now() - 50;
      const r = await pageOp(tab, 'scroll');
      if (!r.moved && r.atBottom && step === 0) break;   /* nothing to scroll */
      if (r.moved) { did.scrolls += 1; view.scroll += 1; }
      await sleep(120);
      const fresh = await grab(view, since, `after scrolling${where}`);
      const probe = await pageOp(tab, 'scroll', { probe: true });
      if (!probe.atBottom) {
        idle = 0;
        stuck = r.moved ? 0 : stuck + 1;
        if (stuck >= 3) { ended = 'stuck'; break; }
        continue;
      }
      stuck = 0;
      const grew = probe.height > Math.max(lastHeight, r.height || 0);
      lastHeight = Math.max(lastHeight, probe.height, r.height || 0);
      idle = fresh || grew ? 0 : idle + 1;
      if (idle >= 2) break;
    }
    if (ended === 'steps' || ended === 'time') say(`scrolling${where} stopped at ${ended === 'time' ? 'the time limit' : `${maxScroll} steps`} before the end of the page, which may still have more files`);
    else if (ended === 'stuck') say(`a scrollable part of the page${where} could not be scrolled to its end, so it may have more files`);
    if (view.scroll) await pageOp(tab, 'scroll', { reset: true });
  };

  const explorePage = async (view, where, over) => {
    await grabAfter(view, `after something was opened${where}`);
    await moreLoop(view, where, over);
    await scrollLoop(view, where, over);
  };

  /* the pager: press Next (or the next number), or follow a link that changes only a page parameter, page after page */
  const pageLoop = async (tabInfo, view0, where, over, linksOk) => {
    let flat = 0;
    const visited = new Set();
    let here = (await pageOp(tab, 'where')).href;
    visited.add(urlKey(here));
    for (let k = 0; ; k += 1) {
      check();
      const ctl = await pageOp(tab, 'controls');
      reportControls(ctl);
      const pager = ctl.pager || { found: false, hinted: false };
      if (!pager.found) { if (pager.hinted && k === 0) say(`the page${where} has pagination that the loader did not recognise, so only its first page was read`); break; }
      if (k >= maxPages) { say(`pagination${where} stopped at ${maxPages} pages and may have more files`); break; }
      if (over()) { say(`pagination${where} stopped at the time limit and may have more files`); break; }
      let step = null;
      for (const s of pagerSteps(pager)) {
        if (c.banned.has(keyOf('pager', s.path, s.label))) continue;
        if (s.href) {
          if (visited.has(urlKey(s.href))) continue;
          if (!linksOk || !goto) { say(`the page${where} has pagination links ("${s.label}") that the loader does not follow here, so its other pages were not read`); continue; }
          if (!pageLinkOk(s.href, here)) { say(`the pagination link "${s.label}"${where} goes to another address than the page, so its other pages were not read`); continue; }
        }
        step = s; break;
      }
      if (!step) {
        if (!pager.next && pager.nums.length && pager.current === null) say(`the page${where} has numbered pages but does not show which one is open, so only the first page was read`);
        break;
      }
      const before = known.size;
      const baseline = signature(await takePage(tab));   /* the page as it is, to see whether the press moved it */
      let view;
      let moved = true;
      if (step.href) {
        await goto(step.href);
        here = (await pageOp(tab, 'where')).href;
        visited.add(urlKey(step.href)); visited.add(urlKey(here));
        at.url = step.href; at.pages = 0;
        view = { tab: tabInfo, pages: 0, pageUrl: step.href, more: 0, scroll: 0 };
        const s = stamp(await takePage(tab), view);
        snaps.push(s);
        known.add(fileCandidates(s));
      } else {
        const outcome = await guarded(tab, c, async (st) => {
          const since = Date.now() - 50;
          const r = await pressOne(tab, st, c, 'pager', step);
          if (!r.ok || r.blocked) return { r, view: null };
          const v = { tab: tabInfo, pages: at.pages + 1, pageUrl: at.url, more: 0, scroll: 0 };
          await grab(v, since, `after page ${at.pages + 2}${where}`);
          return { r, view: v };
        });
        if (!outcome.r.ok) { say(`the page control "${step.label}"${where} could not be pressed (${outcome.r.why}), so later pages were not read`); break; }
        if (outcome.r.blocked) continue;   /* that control is banned; another one may do */
        at.pages += 1;
        view = outcome.view;
        if (signature(snaps[snaps.length - 1]) === baseline) { at.pages -= 1; moved = false; }   /* nothing moved: the pager is at its end (a Next that never turns off) */
      }
      if (!moved) break;
      did.pages += 1;
      await explorePage(view, where, over);
      flat = known.size > before ? 0 : flat + 1;
      if (flat >= 2) { say(`pagination${where} stopped after 2 pages that added no files`); break; }
    }
  };

  const explore = async (tabInfo, deadline, view, linksOk) => {
    const where = tabInfo ? ` in the tab "${tabInfo.label}"` : '';
    const over = () => Date.now() > deadline;
    await explorePage(view, where, over);
    await pageLoop(tabInfo, view, where, over, linksOk);
  };

  await explore(did.home, started + budgetMs, { tab: did.home, pages: 0, pageUrl: at.url, more: 0, scroll: 0 }, true);
  for (const t of tabs) {
    if (t.selected) continue;
    check();
    const info = { label: t.label, path: t.path };
    const view = { tab: info, pages: 0, pageUrl: at.url, more: 0, scroll: 0 };
    /* the press, the settle and the first look at the tab are one guarded step */
    const opened = await guarded(tab, c, async (st) => {
      const since = Date.now() - 50;
      const r = await pressOne(tab, st, c, 'tab', t, t.href ? { href: t.href } : {});
      if (!r.ok || r.blocked) return r;
      await grab(view, since, `after the tab "${t.label}" was opened`);
      return r;
    });
    if (!opened.ok) { say(`the tab "${t.label}" could not be opened (${opened.why}), so its files were not looked at`); continue; }
    did.tabs += 1;
    at.pages = 0;
    if (opened.blocked) continue;   /* the page tried to save something when it was pressed: that tab is not read (it is in the notes) */
    await explore(info, Math.max(started + budgetMs, Date.now() + minPerTabMs), view, false);
  }
  if (did.tabs && homeTab && !c.banned.has(keyOf('tab', homeTab.path, homeTab.label))) { await pressControl(tab, c, 'tab', homeTab, homeTab.href ? { href: homeTab.href } : {}, { signal }); at.pages = 0; }
  if (did.pages && at.url && goto) { await goto(homeUrl); at.url = null; at.pages = 0; }   /* back on the first page of a pager made of links */
  return did;
}

module.exports = { stabilize, expand, expandAll, gather, replay, pressControl, guarded, newCtx, keyOf, blockedNote, signature, CandidateSet, unionCandidates, unionWithCheck, unionDropped, mergeSections, candidateKey, tabKey, nap, droppedCandidates, LOST };
