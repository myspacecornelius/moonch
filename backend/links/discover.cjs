'use strict';
/* Finding every file a page offers takes more than one look. A single-page app fills in after the load, a list may be virtualised (only
   the rows on screen exist), files may sit in a closed <details>, behind a tab, or after "Load more". So the loader takes several
   snapshots and works with the UNION of what they hold:

     stabilize   a second snapshot 1 s and a third 3 s after the page settled; it stops as soon as two in a row are identical
     expand      open <details>, click expanders (aria-expanded=false with aria-controls, no popup menu, nothing destructive)
     gather      activate each tab one at a time, press "Load more" / "Show more" while it adds files, scroll the scrollable boxes in
                 steps (at most 20) until two steps in a row add nothing; every step is a snapshot

   Every step is bounded (a time budget, a step count), every click goes through pageOps' activate (which refuses a destructive or a
   changed element), and the person's page is put back (scrolled to the top, the first tab selected). Exports: stabilize, expand, gather,
   signature, unionCandidates, mergeSections. */

const { takePage, pageOp, fileCandidates } = require('./page.cjs');
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

/* What a snapshot shows, short enough to compare: section headings and text, file links and buttons, switches and their state. */
function signature(snap) {
  return JSON.stringify([
    (snap.sections || []).map((s) => [s.heading, s.text.length, s.text.slice(0, 40), s.text.slice(-40)]),
    (snap.links || []).map((l) => l.href), (snap.buttons || []).map((b) => `${b.path}|${b.text}`),
    (snap.toggles || []).map((t) => [t.label, t.checked, t.path, t.option]),
  ]);
}

const candidateKey = (c) => (c.mode === 'navigate' ? `n|${c.href}` : `c|${c.path || ''}|${c.text}|${c.href || ''}`);
/* Several lists of candidates as one, in order of first appearance. */
function unionCandidates(lists) {
  const seen = new Map();
  for (const list of lists) for (const c of list) { const key = candidateKey(c); if (!seen.has(key)) seen.set(key, c); }
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

/* The cheap part: details and expanders. Pushes a snapshot into `snaps` when it did anything. Returns what it did. */
async function expand(tab, snaps, { signal } = {}) {
  const did = await pageOp(tab, 'expand');
  if (did.opened || did.expanded) { await quick(tab, signal); snaps.push(await takePage(tab)); }
  return did;
}

/* The slow part: tabs, "Load more", scrolling. Pushes a snapshot into `snaps` after every step. */
async function gather(tab, snaps, { signal, budgetMs = 30000, maxScroll = 20 } = {}) {
  const check = checker(signal);
  const started = Date.now();
  const over = () => Date.now() - started > budgetMs;
  const count = () => unionCandidates(snaps.map(fileCandidates)).length;
  const grab = async () => { check(); await quick(tab, signal); snaps.push(await takePage(tab)); };
  const did = { tabs: 0, more: 0, scrolls: 0 };

  const controls = await pageOp(tab, 'controls');
  const home = controls.tabs.find((t) => t.selected);
  for (const t of controls.tabs) {
    if (t.selected || over()) continue;
    check();
    const r = await pageOp(tab, 'activate', { path: t.path, label: t.label });
    if (r.ok) { did.tabs += 1; await grab(); }
  }
  if (did.tabs && home) { await pageOp(tab, 'activate', { path: home.path, label: home.label }); await quick(tab, signal); }

  for (let i = 0; i < 10 && !over(); i += 1) {
    check();
    const more = (await pageOp(tab, 'controls')).more[0];
    if (!more) break;
    const before = count();
    const r = await pageOp(tab, 'activate', { path: more.path, label: more.label });
    if (!r.ok) break;
    did.more += 1;
    await grab();
    if (count() <= before && i >= 1) break;
  }

  let idle = 0;
  for (let step = 0; step < maxScroll && !over(); step += 1) {
    check();
    const r = await pageOp(tab, 'scroll');
    if (!r.moved) break;
    did.scrolls += 1;
    await sleep(120);
    const before = count();
    await grab();
    idle = count() === before ? idle + 1 : 0;
    if (idle >= 2) break;
  }
  if (did.scrolls) await pageOp(tab, 'scroll', { reset: true });
  return did;
}

module.exports = { stabilize, expand, gather, signature, unionCandidates, mergeSections, candidateKey, nap };
