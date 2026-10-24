'use strict';
/* A line diff for the owner to read: what the designer changed in the guideline and in each world file it edited. Pure and bounded:
   the common start and end are cut off, the middle is compared by longest common subsequence when it is small, and by "everything
   removed, everything added" when it is not. Output lines are { op: ' ' | '-' | '+', text }, changed lines with one line of context. */

const MAX_MIDDLE = 1500; /* lines of the changed middle, per side, compared exactly */
const MAX_TEXT = 300; /* characters of a line kept */

const cut = line => (line.length > MAX_TEXT ? line.slice(0, MAX_TEXT) + '...' : line);
const linesOf = text => String(text).replace(/\r\n/g, '\n').split('\n');

function lineDiff(before, after, options = {}) {
  const max = options.maxLines || 200;
  const a = linesOf(before);
  const b = linesOf(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops = [];
  if (midA.length <= MAX_MIDDLE && midB.length <= MAX_MIDDLE) {
    const width = midB.length + 1;
    const table = new Uint16Array((midA.length + 1) * width);
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        table[i * width + j] = midA[i] === midB[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) { ops.push([' ', midA[i]]); i++; j++; }
      else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) { ops.push(['-', midA[i]]); i++; }
      else { ops.push(['+', midB[j]]); j++; }
    }
    while (i < midA.length) ops.push(['-', midA[i++]]);
    while (j < midB.length) ops.push(['+', midB[j++]]);
  } else {
    for (const line of midA) ops.push(['-', line]);
    for (const line of midB) ops.push(['+', line]);
  }
  const added = ops.filter(op => op[0] === '+').length;
  const removed = ops.filter(op => op[0] === '-').length;
  /* the changed lines with one line of context on each side */
  const before1 = start > 0 ? [[' ', a[start - 1]]] : [];
  const after1 = endA < a.length ? [[' ', a[endA]]] : [];
  if (!added && !removed) return { added: 0, removed: 0, lines: [], truncated: false };
  const all = [...before1, ...ops, ...after1];
  const keep = all.map((op, index) => op[0] !== ' ' || (all[index - 1] && all[index - 1][0] !== ' ') || (all[index + 1] && all[index + 1][0] !== ' ') || index === 0 || index === all.length - 1);
  const lines = [];
  let truncated = false;
  all.forEach((op, index) => {
    if (!keep[index]) return;
    if (lines.length >= max) { truncated = true; return; }
    lines.push({ op: op[0], text: cut(op[1]) });
  });
  return { added, removed, lines, truncated };
}

module.exports = { lineDiff };
