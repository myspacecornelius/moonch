'use strict';
/* Finding every file a page offers takes more than one look. A single-page app fills in after the load, a list may be virtualised (only
   the rows on screen exist), files may sit in a closed <details>, behind a tab, or after "Load more". So the loader takes several
   snapshots and works with the UNION of what they hold:

     stabilize   a second snapshot 1 s and a third 3 s after the page settled; it stops as soon as two in a row are identical
     expand      open <details>, click expanders (aria-expanded=false, no popup menu, nothing destructive); expandAll repeats it until
                 nothing new opens (a folder that appears when another one is opened), at most 4 passes
     gather      the open tab, then each other tab one at a time: expand, press "Load more" while it adds files, scroll the scrollable
                 boxes in steps until two steps in a row add nothing; every step is a snapshot
     replay      put the page back into the state a snapshot was taken in (its tab, the number of "Load more" presses, its scroll
                 steps), so a button that only exists there can be found and pressed later

   Every snapshot gather takes is stamped with its view { tab, more, scroll } (snap.view); fileCandidates copies it into each
   candidate. A click candidate is identified by what it IS (the file name or the text of its row, its group, its text), not by where it
   sat, so the same row seen twice is one candidate and two rows with the same words are two (the k-th occurrence in a snapshot is the
   k-th). Nothing is capped without saying so: gather returns capped: [text] for a limit that ended a step while files were still
   appearing, or a tab it could not open.

   Every click goes through pageOps' activate (which refuses a destructive or a changed element), and the person's page is put back
   (scrolled to the top, the first tab selected). Exports: stabilize, expand, expandAll, gather, replay, signature, CandidateSet,
   unionCandidates, unionDropped, mergeSections, candidateKey, nap. */

const { takePage, pageOp, fileCandidates, droppedCandidates, navigateKey } = require('./page.cjs');
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

const hasExtension = (name) => /\.[A-Za-z0-9]{1,8}$/.test(String(name || ''));
const GENERIC_TEXT = /^(download|export)\b/i;
/* The identity of a candidate: a file link is its address without the signature; a click candidate is the file name (or the text of its
   row), its group, the text of the control and its address. A bare "Download" with no row text says nothing, so its position counts.
   withGroup:false is the same without the heading above it (a heading can change when a switch adds a section above the file). */
function candidateKey(c, { withGroup = true } = {}) {
  if (c.mode === 'navigate') return navigateKey(c.href || '', c.label || '');
  const name = hasExtension(c.nameHint) ? c.nameHint : (c.label || '');
  const generic = (c.label || '') === (c.text || '') && GENERIC_TEXT.test(c.text || '');
  return `c|${name}|${withGroup ? c.group || '' : ''}|${c.text || ''}|${c.href || ''}${generic ? `|${c.path || ''}` : ''}`;
}

/* Candidates from several snapshots as one list, in order of first appearance. Each candidate gets occ, its occurrence number among
   the candidates with the same key in the snapshot it first appeared in. A file link seen again keeps its place and takes the newest
   address (an older signature may have expired). A button whose heading changed between two snapshots (a switch added a section above
   it) is the same button: when the earlier one is gone from the newer snapshot and only the group differs, the group is updated. */
class CandidateSet {
  constructor() { this.items = []; this.index = new Map(); this.loose = new Map(); }
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
      if (e.loose) this.loose.set(e.loose, { key: e.key, item });
    }
    return fresh;
  }
  get size() { return this.items.length; }
  list() { return this.items.map((i) => i.c); }
}
function unionCandidates(lists) {
  const set = new CandidateSet();
  for (const list of lists) set.add(list);
  return set.list();
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

const quick = (tab, signal) => waitForSettled(tab, { idleMs: 250, quietMs: 250, maxMs: 2500, signal });
const stamp = (snap, view) => { if (view) snap.view = { tab: view.tab ? { ...view.tab } : null, more: view.more, scroll: view.scroll }; return snap; };

/* The cheap part, one pass: details and expanders. Pushes a snapshot into `snaps` when it did anything. Returns what it did. */
async function expand(tab, snaps, { signal, view } = {}) {
  const did = await pageOp(tab, 'expand');
  if (did.opened || did.expanded) { await quick(tab, signal); snaps.push(stamp(await takePage(tab), view)); }
  return did;
}

/* Repeat it until nothing new opens, at most `passes` times: a folder opened in one pass can show another closed folder. With
   snapshots:false the page is only put into the state (no look is taken). Returns the totals. */
async function expandAll(tab, snaps, { signal, view, passes = 4, snapshots = true } = {}) {
  const total = { opened: 0, expanded: 0, passes: 0 };
  for (let i = 0; i < passes; i += 1) {
    checker(signal)();
    const did = await pageOp(tab, 'expand');
    if (!did.opened && !did.expanded) break;
    total.opened += did.opened; total.expanded += did.expanded; total.passes += 1;
    await quick(tab, signal);
    if (snapshots) snaps.push(stamp(await takePage(tab), view));
  }
  return total;
}

/* Put the page back into the state a snapshot was taken in: the tab (or the home tab), the "Load more" presses, the scroll steps.
   Returns { ok } or { ok: false, why }. */
async function replay(tab, view, home, { signal } = {}) {
  const check = checker(signal);
  const want = (view && view.tab) || home || null;
  const controls = await pageOp(tab, 'controls');
  if (want && controls.tabs.length) {
    const current = controls.tabs.find((t) => t.selected);
    if (!current || current.label !== want.label) {
      const r = await pageOp(tab, 'activate', { path: want.path, label: want.label });
      if (!r.ok) return { ok: false, why: `the tab "${want.label}" could not be opened again (${r.why})` };
      await quick(tab, signal);
    }
  }
  await expandAll(tab, [], { signal, snapshots: false });
  for (let i = 0; i < ((view && view.more) || 0); i += 1) {
    check();
    const more = (await pageOp(tab, 'controls')).more[0];
    if (!more) break;
    const r = await pageOp(tab, 'activate', { path: more.path, label: more.label });
    if (!r.ok) break;
    await quick(tab, signal);
    await expandAll(tab, [], { signal, snapshots: false });
  }
  await pageOp(tab, 'scroll', { reset: true });
  for (let i = 0; i < ((view && view.scroll) || 0); i += 1) {
    check();
    const r = await pageOp(tab, 'scroll');
    if (!r.moved) break;
    await sleep(120);
    await quick(tab, signal);
  }
  return { ok: true };
}

/* The slow part: for the open tab and then for each other tab, expand, press "Load more" while it adds files, scroll in steps until two
   steps in a row add nothing. Pushes a snapshot after every step. budgetMs is the time for the whole page; every tab gets at least
   minPerTabMs. Returns { tabs, more, scrolls, home, capped: [text] }. */
async function gather(tab, snaps, { signal, budgetMs = 60000, maxScroll = 300, maxMore = 200, minPerTabMs = 8000 } = {}) {
  const check = checker(signal);
  const started = Date.now();
  const known = new CandidateSet();
  for (const s of snaps) known.add(fileCandidates(s));
  const did = { tabs: 0, more: 0, scrolls: 0, home: null, capped: [] };
  const grab = async (view) => { check(); await quick(tab, signal); const s = stamp(await takePage(tab), view); snaps.push(s); return known.add(fileCandidates(s)); };
  const grabAfter = async (view) => {   /* snapshots the expansion takes also count */
    const before = snaps.length;
    await expandAll(tab, snaps, { signal, view });
    let fresh = 0;
    for (let i = before; i < snaps.length; i += 1) fresh += known.add(fileCandidates(snaps[i]));
    return fresh;
  };

  const controls = await pageOp(tab, 'controls');
  const tabs = controls.tabs;
  const homeTab = tabs.find((t) => t.selected) || null;
  did.home = homeTab ? { label: homeTab.label, path: homeTab.path } : null;

  const explore = async (tabInfo, deadline, opened) => {
    const where = tabInfo ? ` in the tab "${tabInfo.label}"` : '';
    const view = { tab: tabInfo, more: 0, scroll: 0 };
    const over = () => Date.now() > deadline;
    if (opened) await grab(view);   /* the tab as it opens */
    await grabAfter(view);

    let flat = 0; let ended = 'done';
    for (let i = 0; ; i += 1) {
      check();
      if (i >= maxMore) { ended = 'steps'; break; }
      if (over()) { ended = 'time'; break; }
      const more = (await pageOp(tab, 'controls')).more[0];
      if (!more) break;
      const r = await pageOp(tab, 'activate', { path: more.path, label: more.label });
      if (!r.ok) break;
      did.more += 1; view.more += 1;
      const fresh = (await grab(view)) + (await grabAfter(view));
      flat = fresh ? 0 : flat + 1;
      if (flat >= 2) break;
    }
    if (ended !== 'done') did.capped.push(`"Load more"${where} stopped at ${ended === 'time' ? 'the time limit' : `${maxMore} presses`} and may have more files`);

    let idle = 0; ended = 'done';
    for (let step = 0; ; step += 1) {
      check();
      if (step >= maxScroll) { ended = 'steps'; break; }
      if (over()) { ended = 'time'; break; }
      const r = await pageOp(tab, 'scroll');
      if (!r.moved) break;
      did.scrolls += 1; view.scroll += 1;
      await sleep(120);
      const fresh = await grab(view);
      idle = fresh ? 0 : idle + 1;
      if (idle >= 2) break;
    }
    if (ended !== 'done') did.capped.push(`scrolling${where} stopped at ${ended === 'time' ? 'the time limit' : `${maxScroll} steps`} while the page may still have more files`);
    if (view.scroll) await pageOp(tab, 'scroll', { reset: true });
  };

  await explore(did.home, started + budgetMs, false);
  for (const t of tabs) {
    if (t.selected) continue;
    check();
    const r = await pageOp(tab, 'activate', { path: t.path, label: t.label });
    if (!r.ok) { did.capped.push(`the tab "${t.label}" could not be opened (${r.why}), so its files were not looked at`); continue; }
    did.tabs += 1;
    await explore({ label: t.label, path: t.path }, Math.max(started + budgetMs, Date.now() + minPerTabMs), true);
  }
  if (did.tabs && homeTab) { await pageOp(tab, 'activate', { path: homeTab.path, label: homeTab.label }); await quick(tab, signal); }
  return did;
}

module.exports = { stabilize, expand, expandAll, gather, replay, signature, CandidateSet, unionCandidates, unionDropped, mergeSections, candidateKey, nap, droppedCandidates };
