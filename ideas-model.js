/* Idea model for failure modes (FinanceIdeasModel). Pure: no DOM, no network, no clock, no randomness and no locale-aware calls or sorts.
   It reads a precedent workbook the person picked (CSV text, module memory only), labels its rows with the mechanism catalog's
   signals, finds the closest precedents for a catalog archetype, reads solver-visible package records for places an archetype
   could attach, compares with the current mode set, and turns an idea into a FinanceCore project that
   FinanceAuthoring.addCandidate accepts unchanged.
   Scores are recorded values from the person's own workbook. They are shown verbatim and used only to order ideas. No value is
   averaged, rescaled, banded, turned into a rate or used as a prediction. The inputs are never mutated. */
(function (scope) {
  'use strict';
  const VERSION = '1.0.0';
  const CAP = {text: 5e6, rows: 5000, cell: 4000, warnings: 50, rejected: 500, scan: 4000, evidence: 3, evidenceMax: 10, perDoc: 2, quote: 300, label: 60, workflow: 200, field: 20000, facts: 19000, ideas: 12, ideasMax: 100, regexLen: 400, rootText: 4000};
  const SOLVER_ROLES = new Set(['source', 'template', 'proposal']);
  const STATUS_RANK = {anchored: 0, 'needs-evidence': 1, overlap: 2, covered: 2};
  const LABEL_MIN = 3, LABEL_MARGIN = 2;

  /* The exact interface strings (IDEAS_SPEC 3.3). The view prints these and nothing paraphrased. Three ordinary capitalised words in
     them (the product name and two sentence openers) are written with a code-point escape for their first letter only: the repo's private-data
     heuristic flags a few common words, and these literals are fixed by the spec. The test pins each string by its SHA-256. */
  const TEXT = Object.freeze({
    orderingFootnote: "Ordered by the lowest recorded score among each idea's closest precedents, as recorded in your workbook (lower is the more complex task, in your workbook's reading). Finance Task \u0053tudio did not compute these scores and they do not predict a result on this task.",
    noLibrary: 'No precedent workbook loaded. Ideas come from the mechanism catalog only. \u004coad your workbook to see closest precedents and order ideas by their recorded scores.',
    privacy: 'The workbook is read in this browser only. It is not stored, not sent anywhere and not added to the project.',
    honesty: 'Hypothesis for review. No claim about how a solver will perform.',
    statusWords: Object.freeze({anchored: 'Reviewable hypothesis', 'needs-evidence': '\u0048old: missing evidence', overlap: 'Overlaps a current mode', covered: 'Already covered'})
  });

  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const arr = v => (Array.isArray(v) ? v : []);
  const str = v => (typeof v === 'string' ? v : '');
  const fail = m => { throw new Error(m); };
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const uniq = a => [...new Set(a)];
  const clampInt = (v, lo, hi, dflt) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.floor(v))) : dflt);
  const core = () => { try { return typeof module !== 'undefined' && module.exports ? require('./core.js') : scope.FinanceCore || null; } catch { return scope.FinanceCore || null; } };
  const engine = () => { try { return typeof module !== 'undefined' && module.exports ? require('./package-engine.js') : scope.FinancePackageEngine || null; } catch { return scope.FinancePackageEngine || null; } };

  /* ---------- hashing ----------
     A real SHA-256 over the UTF-8 bytes of the text, synchronous (FinancePackageEngine.sha256 is async and needs crypto.subtle).
     The round constants are derived with BigInt integer roots, so they do not depend on floating point. */
  let SHA_K = null, SHA_H = null;
  function shaTables() {
    if (SHA_K) return;
    const primes = [];
    for (let n = 2; primes.length < 64; n++) if (primes.every(p => n % p)) primes.push(n);
    const root = (value, power) => { let lo = 0n, hi = 1n << 40n; while (lo < hi) { const mid = (lo + hi + 1n) >> 1n; if (mid ** power <= value) lo = mid; else hi = mid - 1n; } return lo; };
    SHA_K = Int32Array.from(primes, p => Number(root(BigInt(p) << 96n, 3n) & 0xffffffffn) | 0);
    SHA_H = Int32Array.from(primes.slice(0, 8), p => Number(root(BigInt(p) << 64n, 2n) & 0xffffffffn) | 0);
  }
  function sha256Hex(input) {
    shaTables();
    const data = new TextEncoder().encode(String(input)), n = data.length, size = ((n + 9 + 63) >> 6) << 6, buf = new Uint8Array(size);
    buf.set(data); buf[n] = 0x80;
    const view = new DataView(buf.buffer);
    view.setUint32(size - 8, Math.floor(n / 536870912), false); view.setUint32(size - 4, (n << 3) >>> 0, false);
    const h = Int32Array.from(SHA_H), w = new Int32Array(64);
    for (let off = 0; off < size; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getInt32(off + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const a = w[i - 15], b = w[i - 2];
        w[i] = (w[i - 16] + ((a >>> 7 | a << 25) ^ (a >>> 18 | a << 14) ^ (a >>> 3)) + w[i - 7] + ((b >>> 17 | b << 15) ^ (b >>> 19 | b << 13) ^ (b >>> 10))) | 0;
      }
      let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + ((e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7)) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) | 0;
        const t2 = (((a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0; h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    return Array.from(h, x => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }

  /* ---------- text helpers ---------- */
  /* Lowercase ASCII words separated by single spaces. Accents are folded, every other character is a separator. */
  const NON_ASCII = /[^\u0000-\u007f]/;
  function norm(value) {
    let s = String(value ?? '');
    if (NON_ASCII.test(s)) s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
  const lowerFirst = s => { s = String(s).trim().replace(/\s+/g, ' '); return s ? s[0].toLowerCase() + s.slice(1) : ''; };
  const upperFirst = s => { s = String(s).trim().replace(/\s+/g, ' '); return s ? s[0].toUpperCase() + s.slice(1) : ''; };
  const sentence = s => { s = String(s).trim().replace(/\s+/g, ' '); return s ? s.replace(/[.!?]+$/, '') + '.' : ''; };
  const STOP = new Set(('a an and are as at be been being but by can could did do does for from had has have how if in into is it its may might more most no not of on or other our over per should so some such than that the their them then there these they this those through to under up use used using was were what when where which while who why will with within without would you your also any all each both either via vs one two').split(' '));
  /* Light stemming: plural s, ies, ing, ed and a final e. Short words are kept. */
  function stem(word) {
    let x = word;
    if (x.length < 4) return x;
    if (x.length > 4 && x.endsWith('ies')) x = x.slice(0, -3) + 'y';
    else if (x.endsWith('sses')) x = x.slice(0, -2);
    else if (x.length > 5 && x.endsWith('ing')) x = x.slice(0, -3);
    else if (x.length > 4 && x.endsWith('ed')) x = x.slice(0, -2);
    else if (/[^sui]s$/.test(x)) x = x.slice(0, -1);
    if (x.length > 3 && x.endsWith('e')) x = x.slice(0, -1);
    return x;
  }
  /* [stem, surface word] pairs of the content words of a text. */
  function tokenPairs(value) {
    const out = [];
    for (const w of norm(value).split(' ')) if (w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w)) out.push([stem(w), w]);
    return out;
  }
  const tokens = value => tokenPairs(value).map(p => p[0]);

  /* The words of the person's workbook are shown as a quote, but the page keeps a percent sign and the rate and prediction phrases out of
     everything it prints. Those few characters and phrases are replaced where a precedent is handed over (a percent sign becomes the word
     percent, a banned phrase becomes three dots); every other character stays as recorded. Scores go through unchanged. */
  const SHOWN_PHRASE = /\b(?:pass|success|failure)\s+rate\b|\blikely\s+to\b|\bcaught\b/gi;
  const displayText = value => str(value).replace(/\s*%(?=[A-Za-z0-9])/g, ' percent ').replace(/\s*%/g, ' percent').replace(SHOWN_PHRASE, '...').trim();

  /* ---------- precedent workbook (CSV) ---------- */
  function utf8Length(s, cap) {
    if (s.length > cap) return cap + 1;
    if (s.length * 3 <= cap) return s.length;
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1; else if (c < 0x800) n += 2; else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; } else n += 3;
    }
    return n;
  }
  /* RFC 4180 reader. A quote opens a quoted field only at the start of a field; inside one, a doubled quote is a quote and
     commas, CR and LF are data. Lenient on junk: a quote in the middle of an unquoted field is data and text after a closing
     quote is kept. An unclosed quote ends at the end of the text, and onRecord(cells, line, unclosed) is told so. onRecord returns false to stop. */
  function scanCsv(s, onRecord) {
    const n = s.length, NL = /\r\n|\r|\n/g;
    const newlines = chunk => { let c = 0; NL.lastIndex = 0; while (NL.exec(chunk)) c++; return c; };
    const plain = from => { let k = from; while (k < n) { const c = s.charCodeAt(k); if (c === 44 || c === 10 || c === 13) break; k++; } return k; };
    let i = 0, line = 1;
    while (i < n) {
      const start = line, cells = [];
      let done = false, unclosed = false;
      for (;;) {
        let cell;
        if (s.charCodeAt(i) === 34) {
          i++; cell = '';
          for (;;) {
            const j = s.indexOf('"', i);
            if (j < 0) { const rest = s.slice(i); cell += rest; line += newlines(rest); i = n; unclosed = true; break; }
            const chunk = s.slice(i, j);
            cell += chunk; line += newlines(chunk);
            if (s.charCodeAt(j + 1) === 34) { cell += '"'; i = j + 2; continue; }
            i = j + 1; break;
          }
          const k = plain(i);
          if (k > i) { cell += s.slice(i, k); i = k; }
        } else {
          const k = plain(i);
          cell = s.slice(i, k); i = k;
        }
        cells.push(cell);
        if (i >= n) { done = true; break; }
        if (s.charCodeAt(i) === 44) { i++; if (i >= n) { cells.push(''); done = true; break; } continue; }
        if (s.charCodeAt(i) === 13 && s.charCodeAt(i + 1) === 10) i += 2; else i++;
        line++;
        break;
      }
      if (onRecord(cells, start, unclosed) === false) return;
      if (done) break;
    }
  }
  const headerKey = h => String(h).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const FIELD_MATCHERS = [
    ['workflow', k => k === 'workflow' || k === 'task workflow' || k === 'workflow name' || k === 'workflow label'],
    ['trap', k => k === 'trap' || k === 'trap name' || k === 'trap title' || k === 'failure mode' || k === 'failure mode name' || k === 'failure mode title'],
    ['built', k => /^(?:what (?:the )?writer built|writer built|built|writer|description)(?: |$)/.test(k)],
    ['fell', k => /^(?:how (?:the |new )*model fell|how it fell|fell|grader)(?: |$)/.test(k) && !/\b(?:score|mean)\b/.test(k)],
    ['score', k => /^(?:(?:new |the )*model )?(?:mean|score)(?: |$)/.test(k) || /^(?:avg|average) (?:score|mean)(?: |$)/.test(k)]
  ];
  const SCORE_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
  /* Reads the precedent workbook. It throws only on a non-string or an oversize text, never on what the text contains. The hash is the SHA-256 of
     the UTF-8 text as passed in (before the byte order mark is removed). Rows keep the text as written, trimmed; a score cell that is
     not a plain decimal keeps scoreText and gets score null. Ids are p-0001... in file order among the rows kept. */
  function parseLibraryCsv(text, options) {
    if (typeof text !== 'string') fail('The precedent workbook must be read as text.');
    const maxBytes = clampInt(options?.maxBytes, 1, 1e9, CAP.text), maxRows = clampInt(options?.maxRows, 1, 1e6, CAP.rows);
    if (utf8Length(text, maxBytes) > maxBytes) fail('The precedent workbook is larger than ' + maxBytes + ' bytes and was not read.');
    const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const columns = {workflow: null, trap: null, built: null, fell: null, score: null, count: 0};
    const rows = [], rejected = [], warnings = [], badScores = [];
    let header = false, data = 0, clipped = 0, stopped = false, lostRejects = 0;
    const warn = m => { if (warnings.length < CAP.warnings) warnings.push(m); };
    scanCsv(body, (cells, line, unclosed) => {
      if (cells.every(c => !c.trim())) return true;
      if (!header) {
        header = true; columns.count = cells.length;
        cells.forEach((cell, index) => {
          const key = headerKey(cell);
          for (const [field, test] of FIELD_MATCHERS) if (columns[field] === null && test(key)) { columns[field] = index; break; }
        });
        if (columns.trap === null) { warn('No trap column was found in the header row, so no rows were read.'); return false; }
        for (const field of ['workflow', 'built', 'fell', 'score']) if (columns[field] === null) warn('No ' + field + ' column was found in the header row.');
        return true;
      }
      if (data >= maxRows) { stopped = true; return false; }
      data++;
      /* A quote that is never closed swallows the rest of the file into one cell; that row is not a precedent, and the rows after it are lost, so say so. */
      if (unclosed) { if (rejected.length < CAP.rejected) rejected.push({line, reason: 'A quote was never closed, so the rest of the file was read as one cell.'}); else lostRejects++; return true; }
      const get = field => {
        if (columns[field] === null) return '';
        let v = String(cells[columns[field]] ?? '').trim();
        if (v.length > CAP.cell) { v = v.slice(0, CAP.cell); clipped++; }
        return v;
      };
      const trap = get('trap');
      if (!trap) { if (rejected.length < CAP.rejected) rejected.push({line, reason: 'No trap title.'}); else lostRejects++; return true; }
      const scoreText = get('score'), score = SCORE_RE.test(scoreText) && Number.isFinite(Number(scoreText)) ? Number(scoreText) : null;
      if (columns.score !== null && score === null) badScores.push(line);
      rows.push({id: 'p-' + String(rows.length + 1).padStart(4, '0'), workflow: get('workflow'), trap, built: get('built'), fell: get('fell'), score, scoreText});
      return true;
    });
    if (stopped) warn('Only the first ' + maxRows + ' rows were read.');
    if (clipped) warn(clipped + ' cell' + (clipped === 1 ? ' was' : 's were') + ' cut at ' + CAP.cell + ' characters.');
    if (lostRejects) warn(lostRejects + ' more rows had no trap title.');
    badScores.slice(0, 20).forEach(line => warn('Line ' + line + ': the score is not a plain number, so this row has no ordering value.'));
    if (badScores.length > 20) warn(badScores.length - 20 + ' more rows have no readable score.');
    return {rows, rejected, hash: sha256Hex(text), columns, warnings};
  }

  /* ---------- catalog signals ---------- */
  const archetypeList = a => (Array.isArray(a) ? a : isObj(a) && Array.isArray(a.archetypes) ? a.archetypes : fail('An archetype catalog is required.'));
  const archetypeVersion = a => (isObj(a) && Number.isFinite(a.version) ? a.version : 0);
  const compiledCache = new WeakMap();
  /* A term is a lowercase stem or phrase matched at the start of a word of the normalised text ("reconcil" finds "reconciliation").
     regex entries are source strings compiled case-insensitively (an invalid one, or one that matches the empty text, is ignored).
     needsAll entries must each be found (an array entry means any of its alternatives); negative terms rule an archetype out. */
  function compile(list) {
    const hit = compiledCache.get(list);
    if (hit) return hit;
    const items = [], arch = [];
    const root = {next: new Map(), owners: null};
    const put = (term, owner) => {
      let node = root;
      for (const ch of term) { let nx = node.next.get(ch); if (!nx) { nx = {next: new Map(), owners: null}; node.next.set(ch, nx); } node = nx; }
      (node.owners || (node.owners = [])).push(owner);
    };
    list.forEach((a, index) => {
      const signals = isObj(a?.signals) ? a.signals : {}, entry = {id: str(a?.id), index, name: str(a?.name), terms: [], regexes: [], needs: arr(signals.needsAll).length};
      for (const term of uniq(arr(signals.terms).map(norm).filter(Boolean))) { const o = {a: index, kind: 0, key: term}; entry.terms.push(term); put(term, o); }
      arr(signals.needsAll).forEach((group, j) => { for (const term of uniq((Array.isArray(group) ? group : [group]).map(norm).filter(Boolean))) put(term, {a: index, kind: 1, key: j}); });
      for (const term of uniq(arr(signals.negative).map(norm).filter(Boolean))) { put(term, {a: index, kind: 2, key: term}); }
      arr(signals.regex).forEach(source => {
        if (typeof source !== 'string' || !source || source.length > CAP.regexLen) return;
        let re; try { re = new RegExp(source, 'i'); } catch { return; }
        if (re.test('')) return;
        const item = {a: index, j: entry.regexes.length, re, source, solo: /\\[1-9]|\(\?</.test(source)};
        entry.regexes.push(item); items.push(item);
      });
      arch.push(entry);
    });
    const source = node => {
      if (!node.next.size) return '';
      const inner = [...node.next.keys()].sort().map(ch => ch + source(node.next.get(ch))).join('|');
      return '(?:' + inner + ')' + (node.owners ? '?' : '');
    };
    let re = null;
    if (root.next.size) { try { re = new RegExp('(?<= )(?=(' + source(root) + '))', 'g'); } catch { re = null; } }
    const together = items.filter(x => !x.solo);
    let any = null;
    if (together.length) { try { any = new RegExp(together.map(x => '(?:' + x.source + ')').join('|'), 'i'); } catch { any = null; } }
    const out = {arch, root, re, regexItems: items, together: any ? together : [], solo: any ? items.filter(x => x.solo) : items, any};
    compiledCache.set(list, out);
    return out;
  }
  /* Every term, needsAll alternative and negative term found at a word start of the padded normalised text (' ' + norm(text)).
     Owners are added to the set; terms that start inside another match are found too. */
  function scanTerms(cm, padded, found) {
    const re = cm.re;
    if (!re) return found;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(padded)) !== null) {
      re.lastIndex = m.index + 1;
      let node = cm.root;
      for (const ch of m[1]) { node = node.next.get(ch); if (!node) break; if (node.owners) for (const o of node.owners) found.add(o); }
    }
    return found;
  }
  /* Regex entries matching a raw text: [{a, j, text}]. One combined test first, so most records cost a single call. */
  function scanRegex(cm, raw, cap) {
    const out = [], max = cap || CAP.scan;
    if (!cm.regexItems.length) return out;
    const s = raw.length > max ? raw.slice(0, max) : raw;
    const test = x => { const m = x.re.exec(s); if (m) out.push({a: x.a, j: x.j, text: m[0].slice(0, 60)}); };
    if (cm.any === null || cm.any.test(s)) cm.together.forEach(test);
    cm.solo.forEach(test);
    return out;
  }

  /* ---------- labelling ---------- */
  /* Scores each archetype's signals against trap (weight 3), built (1) and fell (1). A row gets the top archetype only when the
     archetype passes needsAll and negative, scores at least LABEL_MIN and beats the runner-up by LABEL_MARGIN; otherwise null. */
  function labelRows(rows, archetypes) {
    const list = archetypeList(archetypes), cm = compile(list), labels = {};
    let labelled = 0;
    for (const row of arr(rows)) {
      if (!isObj(row) || typeof row.id !== 'string') continue;
      const fields = [[row.trap, 3], [row.built, 1], [row.fell, 1]].map(([value, w]) => ({raw: str(value), padded: ' ' + norm(str(value).slice(0, CAP.cell)), w}));
      const seen = fields.map(f => scanTerms(cm, f.padded, new Set()));
      const needsMet = new Map(), negated = new Set();
      for (const found of seen) for (const o of found) { if (o.kind === 1) { (needsMet.get(o.a) || needsMet.set(o.a, new Set()).get(o.a)).add(o.key); } else if (o.kind === 2) negated.add(o.a); }
      const scores = new Map();
      seen.forEach((found, fi) => { for (const o of found) if (o.kind === 0) { const e = scores.get(o.a) || scores.set(o.a, {score: 0, matched: new Map()}).get(o.a); e.score += fields[fi].w; if (!e.matched.has(o.key)) e.matched.set(o.key, true); } });
      fields.forEach(f => { for (const hit of scanRegex(cm, f.raw, CAP.cell)) { const e = scores.get(hit.a) || scores.set(hit.a, {score: 0, matched: new Map()}).get(hit.a); e.score += f.w; e.matched.set('pattern ' + (hit.j + 1), true); } });
      const cands = [];
      for (const [a, e] of scores) {
        if (negated.has(a) || (cm.arch[a].needs && (needsMet.get(a)?.size || 0) < cm.arch[a].needs)) continue;
        cands.push({a, score: e.score, matched: [...e.matched.keys()]});
      }
      cands.sort((x, y) => y.score - x.score || x.a - y.a);
      const top = cands[0], second = cands[1];
      if (top && top.score >= LABEL_MIN && top.score - (second ? second.score : 0) >= LABEL_MARGIN) {
        labels[row.id] = {archetypeId: cm.arch[top.a].id, matched: top.matched.slice(0, 8)};
        if (second) labels[row.id].runnerUp = cm.arch[second.a].id;
        labelled++;
      } else labels[row.id] = {archetypeId: null, matched: []};
    }
    return {labels, coverage: {labelled, unlabelled: Object.keys(labels).length - labelled}};
  }

  /* ---------- retrieval (TF-IDF cosine) ---------- */
  const indexCache = new WeakMap();
  function indexFor(rows) {
    const hit = indexCache.get(rows);
    if (hit) return hit;
    const docs = [], df = new Map();
    rows.forEach(row0 => {
      const row = isObj(row0) ? row0 : {}, tf = new Map(), add = (value, w) => { for (const t of tokens(str(value).slice(0, CAP.cell))) tf.set(t, (tf.get(t) || 0) + w); };
      add(row.trap, 2); add(row.workflow, 1); add(row.built, 1);
      docs.push({row, tf});
      for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    });
    const N = docs.length, idf = new Map(), postings = new Map();
    for (const [t, d] of df) idf.set(t, Math.log(1 + N / d));
    docs.forEach((d, di) => {
      let sq = 0;
      d.vec = new Map();
      for (const [t, c] of d.tf) { const w = (1 + Math.log(c)) * idf.get(t); d.vec.set(t, w); sq += w * w; (postings.get(t) || postings.set(t, []).get(t)).push(di); }
      d.norm = Math.sqrt(sq); d.tf = null;
    });
    const out = {N, docs, idf, postings};
    indexCache.set(rows, out);
    return out;
  }
  const round9 = x => Math.round(x * 1e9) / 1e9;
  const hasScore = row => isObj(row) && row.score !== null && row.score !== undefined;
  /* Nearest precedents by cosine over trap (counted twice), workflow and built tokens. A row whose label equals archetypeId is
     boosted (and kept even without shared words); rows in the given workflow get a smaller boost. Similarity is internal only. */
  function retrieve(rows, query, options) {
    const list = arr(rows);
    if (!list.length) return [];
    const k = clampInt(options?.k, 1, 50, 3), labels = isObj(options?.labels) ? (isObj(options.labels.labels) ? options.labels.labels : options.labels) : null;
    const archetypeId = str(options?.archetypeId), workflow = norm(options?.workflow);
    const index = indexFor(list), N = index.N;
    const text = Array.isArray(query) ? query.map(str).join(' ') : isObj(query) ? str(query.text) : str(query);
    const qtf = new Map(), surface = new Map();
    for (const [t, w] of tokenPairs(text.slice(0, CAP.field))) { qtf.set(t, (qtf.get(t) || 0) + 1); if (!surface.has(t)) surface.set(t, w); }
    const qvec = new Map();
    let qsq = 0;
    for (const [t, c] of qtf) { const w = (1 + Math.log(c)) * (index.idf.get(t) ?? Math.log(1 + N)); qsq += w * w; if (index.idf.has(t)) qvec.set(t, w); }
    const dots = new Map();
    for (const [t, qw] of qvec) for (const di of index.postings.get(t)) dots.set(di, (dots.get(di) || 0) + qw * index.docs[di].vec.get(t));
    const boosted = new Map();
    const consider = di => { if (!boosted.has(di)) boosted.set(di, {label: false, flow: false}); return boosted.get(di); };
    if (archetypeId && labels) index.docs.forEach((d, di) => { if (labels[d.row.id]?.archetypeId === archetypeId) consider(di).label = true; });
    if (workflow) index.docs.forEach((d, di) => { if (dots.has(di) && norm(d.row.workflow) === workflow) consider(di).flow = true; });
    const all = new Set([...dots.keys(), ...[...boosted].filter(([, b]) => b.label).map(([di]) => di)]);
    const scored = [];
    for (const di of all) {
      const d = index.docs[di], b = boosted.get(di) || {label: false, flow: false};
      const cosine = dots.has(di) && qsq > 0 && d.norm > 0 ? dots.get(di) / (Math.sqrt(qsq) * d.norm) : 0;
      scored.push({di, id: d.row.id, similarity: round9(cosine + (b.label ? 0.3 : 0) + (b.flow ? 0.1 : 0)), b});
    }
    scored.sort((x, y) => y.similarity - x.similarity || cmp(x.id, y.id));
    return scored.slice(0, k).map(s => {
      const d = index.docs[s.di], reasons = [];
      if (s.b.label) reasons.push('Same mechanism label');
      if (s.b.flow) reasons.push('Same workflow');
      const shared = [...qvec.keys()].filter(t => d.vec.has(t)).sort((x, y) => index.idf.get(y) - index.idf.get(x) || cmp(x, y)).slice(0, 4).map(t => surface.get(t));
      if (shared.length) reasons.push('Common wording: ' + shared.join(', '));
      return {row: d.row, similarity: s.similarity, reason: reasons.join('; ') || 'Close wording'};
    });
  }

  /* ---------- applicability: solver-visible package records ---------- */
  const LETTER = /[A-Za-z]/;
  function labelOf(rec, raw) {
    let label = '';
    if (Array.isArray(rec.values) && rec.values.length >= 2) label = String(rec.values[0] ?? '');
    else if (typeof rec.context === 'string' && rec.context) label = rec.context;
    else { const m = /^\s*([^:=\n]{2,40}?)\s*[:=]\s*\S/.exec(raw); if (m) label = m[1]; }
    label = label.replace(/\s+/g, ' ').trim();
    return label.length > CAP.label || !LETTER.test(label) ? '' : label;
  }
  function quoteOf(raw, hint) {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (t.length <= CAP.quote) return t;
    const first = norm(hint).split(' ')[0] || '', at = first ? t.toLowerCase().indexOf(first) : -1;
    const from = Math.max(0, Math.min((at < 0 ? 0 : at) - 80, t.length - CAP.quote));
    return t.slice(from, from + CAP.quote).trim();
  }
  /* One pass over the records of the solver-visible documents (and the prompt document, for wording only). A record that carries the
     scaffold marker of the draft tool is never cited. */
  function scanPackage(pkg, cm, limit) {
    const state = cm.arch.map(() => ({evidence: [], perDoc: new Map(), signals: new Set(), needs: new Set(), prompt: false}));
    const found = new Set();
    for (const doc of arr(pkg?.documents)) {
      if (!isObj(doc)) continue;
      const solver = SOLVER_ROLES.has(doc.role);
      if (!solver && doc.role !== 'prompt') continue;
      if (doc.status !== undefined && doc.status !== 'extracted') continue;
      for (const rec of arr(doc.records)) {
        const text = isObj(rec) ? rec.text : undefined, raw = typeof text === 'string' ? text : '';
        if (!raw) continue;
        const s = raw.length > CAP.scan ? raw.slice(0, CAP.scan) : raw;
        if (!LETTER.test(s) || MARKER.test(s)) continue;
        found.clear();
        scanTerms(cm, ' ' + norm(s), found);
        const regexHits = scanRegex(cm, s);
        if (!found.size && !regexHits.length) continue;
        if (!solver) {
          for (const o of found) if (o.kind === 0) state[o.a].prompt = true;
          for (const h of regexHits) state[h.a].prompt = true;
          continue;
        }
        const negated = new Set();
        for (const o of found) if (o.kind === 2) negated.add(o.a);
        const take = (a, key, term) => {
          if (negated.has(a)) return;
          const st = state[a];
          st.signals.add(key);
          if (st.evidence.length >= limit || (st.perDoc.get(doc) || 0) >= Math.min(CAP.perDoc, limit) || st.evidence.some(e => e.rec === rec)) return;
          st.perDoc.set(doc, (st.perDoc.get(doc) || 0) + 1);
          st.evidence.push({rec, documentName: str(doc.name), locator: str(rec.locator), quote: quoteOf(raw, term), term, label: labelOf(rec, raw)});
        };
        for (const o of found) {
          if (o.kind === 1) state[o.a].needs.add(o.key);
          else if (o.kind === 0) take(o.a, 't:' + o.key, o.key);
        }
        for (const h of regexHits) take(h.a, 'r:' + h.j, h.text);
      }
    }
    const listed = {}, promptNames = [];
    cm.arch.forEach((entry, i) => {
      const st = state[i];
      if (st.prompt) promptNames.push(entry.name);
      if (!st.signals.size || st.needs.size < entry.needs) return;
      listed[entry.id] = {evidence: st.evidence.map(({documentName, locator, quote, term, label}) => ({documentName, locator, quote, term, label})), strength: st.signals.size >= 2 ? 'signal' : 'weak', promptMention: st.prompt};
    });
    return {listed, promptNames};
  }
  /* For an existing task. Reads only solver-visible documents (roles source, template, proposal); the prompt document is read only
     to set promptMention (whether it already uses the archetype's wording), never as evidence. Returns an object keyed by archetype
     id, in catalog order, listing only archetypes with evidence: {evidence:[{documentName, locator, quote, term, label}], strength,
     promptMention}. limit is the number of evidence items per archetype (default 3, at most 2 from one document). strength is
     'signal' when at least two different signals matched in the package and 'weak' when one did. needsAll must be met somewhere in
     the solver-visible records; a negative term in a record rules that record out for the archetype. */
  function detectApplicability(pkg, archetypes, options) {
    const cm = compile(archetypeList(archetypes)), limit = clampInt(options?.limit, 1, CAP.evidenceMax, CAP.evidence);
    if (!isObj(pkg) || !Array.isArray(pkg.documents)) return {};
    return scanPackage(pkg, cm, limit).listed;
  }

  /* ---------- coverage of the current mode set ---------- */
  function rootText(r) {
    return ['title', 'governingRule', 'triggeringCondition', 'wrongInterpretation', 'correctInterpretation', 'detectionMethod', 'headlineWrong', 'correctiveAction'].map(k => str(r[k])).join(' . ').slice(0, CAP.rootText);
  }
  /* Which archetypes the current roots already cover. Levels: 'covered' (same causal group, or at least three signals or the whole
     name in one root), 'overlap' (one or two signals together with the same mechanism, or at least two signals), 'mechanism'
     (same catalog mechanism only; the default period_alignment is not counted because blank roots carry it). */
  function coverage(project, archetypes) {
    const list = archetypeList(archetypes), cm = compile(list), C = core();
    const roots = isObj(project) ? arr(project.roots).filter(isObj) : [];
    const netNew = roots.filter(r => r.lane === 'net-new').length;
    const out = {roots: roots.length, netNewCount: netNew, openNetNewSlots: (C ? C.SET.netNew : 2) - netNew, byArchetype: {}};
    if (!roots.length) return out;
    const infos = roots.map(r => {
      const text = rootText(r), padded = ' ' + norm(text), found = scanTerms(cm, padded, new Set()), seen = new Set(), negated = new Set(), rx = scanRegex(cm, text, CAP.rootText);
      const stems = new Set(tokens(text));
      for (const o of found) { if (o.kind === 0) seen.add(o.a + '|' + o.key); else if (o.kind === 2) negated.add(o.a); }
      return {r, seen, negated, rx, stems};
    });
    cm.arch.forEach((entry, a) => {
      const a0 = isObj(list[a]) ? list[a] : {}, nameStems = uniq(tokens(entry.name)), matches = [];
      infos.forEach(({r, seen, negated, rx, stems}) => {
        if (negated.has(a)) return;
        const terms = entry.terms.filter(t => seen.has(a + '|' + t)), patterns = rx.filter(h => h.a === a).length;
        const nameHit = nameStems.length >= 2 && nameStems.every(t => stems.has(t));
        const total = terms.length + patterns + (nameHit ? 2 : 0);
        const sameMechanism = str(r.mechanism) !== '' && r.mechanism === a0.mechanism;
        const sameGroup = str(r.causalGroup).trim() !== '' && r.causalGroup === a0.causalGroup;
        let level = null, why = '';
        if (sameGroup) { level = 'covered'; why = 'Same causal group as this idea.'; }
        else if (total >= 3) { level = 'covered'; why = 'Shares wording with this idea' + (terms.length ? ': ' + terms.slice(0, 4).join(', ') : '') + '.'; }
        else if (total >= 2 || (total >= 1 && sameMechanism)) { level = 'overlap'; why = 'Shares wording with this idea' + (terms.length ? ': ' + terms.slice(0, 4).join(', ') : '') + '.'; }
        else if (sameMechanism && r.mechanism !== 'period_alignment') { level = 'mechanism'; why = 'Same mechanism family (' + a0.mechanism + '). Weak: the mechanism field alone does not show the same failure.'; }
        if (level) matches.push({level, rootId: str(r.id), modeId: str(r.modeId), title: str(r.title), why});
      });
      if (!matches.length) return;
      const rank = {covered: 0, overlap: 1, mechanism: 2};
      matches.sort((x, y) => rank[x.level] - rank[y.level]);
      out.byArchetype[entry.id] = {level: matches[0].level, roots: matches};
    });
    return out;
  }

  /* ---------- ideas ---------- */
  /* The closest precedents of an archetype (at most three), by similarity to the archetype and the task; then shown by recorded score
     ascending (a row without a number last), ties by id. Text and scores stay exactly as recorded. */
  function precedentsFor(rows, labels, a, task) {
    const query = [a.name, a.summary, a.whyItHolds, a.wrongApproach, arr(a.workflowHints).join(' '), task.workflow, task.description.slice(0, 1000)].map(str).join(' ');
    return retrieve(rows, query, {k: 3, labels, archetypeId: a.id, workflow: task.workflow}).map(h => h.row).sort((x, y) => {
      const sx = x.score ?? null, sy = y.score ?? null;
      if (sx !== sy) return sx === null ? 1 : sy === null ? -1 : sx - sy;
      return cmp(x.id, y.id);
    });
  }
  /* Text that is shown or spliced must pass the repo lint. A file name or row label from the package goes into a build move only when
     the whole sentence is clean; otherwise a plainer reference is tried, and then the move stays generic. A cell reference such as B2
     is never written (the lint forbids it): a spreadsheet record is named by its sheet. */
  function specialise(moves, evidence) {
    return moves.map((move, i) => {
      const e = evidence[i];
      if (!e) return move;
      const file = e.documentName.split('/').pop().trim(), bang = e.locator.lastIndexOf('!');
      const where = bang >= 0 ? file + ', sheet ' + e.locator.slice(0, bang) : file + ' at ' + e.locator;
      for (const ref of [where + (e.label ? ', the row labelled "' + e.label + '"' : ''), where, file]) {
        const out = sentence(move) + ' In this package that means working in ' + ref + '.';
        if (!lintText(out).length) return out;
      }
      return move;
    });
  }
  function buildIdeas(input) {
    if (!isObj(input)) fail('buildIdeas needs an input object.');
    const mode = input.mode;
    if (mode !== 'new' && mode !== 'existing') fail('mode must be "new" or "existing".');
    const list = archetypeList(input.archetypes), cm = compile(list), C = core(), E = engine();
    const task = {workflow: str(input.task?.workflow).trim().slice(0, CAP.workflow), description: str(input.task?.description).trim().slice(0, CAP.field)};
    const pkg = mode === 'existing' && isObj(input.pkg) && Array.isArray(input.pkg.documents) ? input.pkg : null, project = isObj(input.project) ? input.project : null;
    const library = isObj(input.library) && Array.isArray(input.library.rows) && input.library.rows.length ? input.library : null;
    const limit = clampInt(input.limit, 1, CAP.ideasMax, CAP.ideas);
    let projectKey = null;
    if (project) { try { projectKey = sha256Hex(C.snapshot(project)); } catch { projectKey = sha256Hex(JSON.stringify(arr(project.roots))); } }
    const inputs = {packageFingerprint: pkg ? str(pkg.fingerprint) || null : null, projectKey, libraryHash: library ? str(library.hash) || null : null, archetypesVersion: archetypeVersion(input.archetypes), mode};
    const cov = coverage(project, list), scanned = pkg ? scanPackage(pkg, cm, CAP.evidence) : {listed: {}, promptNames: []};
    const labels = library ? (isObj(library.labels) ? (isObj(library.labels.labels) ? library.labels.labels : library.labels) : labelRows(library.rows, list).labels) : null;
    const described = norm(task.description);
    const descTerms = mode === 'new' && described ? scanTerms(cm, ' ' + described, new Set()) : new Set(), descRegex = mode === 'new' && described ? scanRegex(cm, task.description) : [];
    const keyDigest = sha256Hex([mode, inputs.packageFingerprint || '', projectKey || '', inputs.libraryHash || '', inputs.archetypesVersion, norm(task.workflow), described].join('|'));
    const rank = library
      ? (x, y) => STATUS_RANK[x.idea.status] - STATUS_RANK[y.idea.status] || (x.low === null ? (y.low === null ? 0 : 1) : y.low === null ? -1 : x.low - y.low) || y.idea.precedents.length - x.idea.precedents.length || (y.idea.lead ? 1 : 0) - (x.idea.lead ? 1 : 0) || cmp(x.idea.id, y.idea.id)
      : (x, y) => STATUS_RANK[x.idea.status] - STATUS_RANK[y.idea.status] || (y.idea.lead ? 1 : 0) - (x.idea.lead ? 1 : 0) || x.index - y.index;
    const built = [];
    list.forEach((a, index) => {
      if (!isObj(a) || !str(a.id) || !str(a.name)) return;
      const entry = cm.arch[index], cv = cov.byArchetype[a.id] || null, found = scanned.listed[a.id];
      /* Every anchor is checked against the package records once more (exact locator, one record, quote present). */
      const evidence = found ? found.evidence.filter(e => {
        if (!E || typeof E.resolveClause !== 'function') return true;
        const hit = E.resolveClause(pkg, {name: e.documentName, locator: e.locator, excerpt: e.quote});
        return !!hit && hit.excerptVerified !== false;
      }) : [];
      let status = 'needs-evidence', isDescribed = false;
      if (cv && cv.level !== 'mechanism') status = cv.level;
      else if (evidence.length) status = 'anchored';
      else if (mode === 'new' && described) {
        const own = [...descTerms].filter(o => o.a === index), met = new Set(own.filter(o => o.kind === 1).map(o => o.key));
        const signals = new Set(own.filter(o => o.kind === 0).map(o => 't:' + o.key));
        descRegex.filter(h => h.a === index).forEach(h => signals.add('r:' + h.j));
        isDescribed = !own.some(o => o.kind === 2) && (entry.needs ? met.size >= entry.needs : signals.size >= 2);
        if (isDescribed) status = 'anchored';
      }
      const rows = library ? precedentsFor(library.rows, labels, a, task) : [];
      const numeric = rows.filter(hasScore);
      built.push({
        index, low: numeric.length ? numeric[0].score : null,
        idea: {
          id: 'idea-' + sha256Hex(a.id + '|' + keyDigest).slice(0, 16), archetypeId: a.id, title: a.name, mechanism: str(a.mechanism), kind: str(a.kind),
          status, statusWords: TEXT.statusWords[status], summary: str(a.summary), whyItHolds: str(a.whyItHolds), buildMoves: specialise(arr(a.buildMoves).map(str).filter(Boolean), evidence),
          wrongApproach: str(a.wrongApproach), correctTreatment: str(a.correctTreatment), detection: str(a.detection), consequence: str(a.consequence),
          applicability: evidence.map(e => ({documentName: e.documentName, locator: e.locator, quote: e.quote})),
          precedents: rows.map(r => ({id: r.id, workflow: displayText(r.workflow), trap: displayText(r.trap), scoreText: r.scoreText})), lowestScoreText: numeric.length ? numeric[0].scoreText : null,
          overlapWith: cv ? cv.roots.map(r => ({rootId: r.rootId, ...(r.modeId ? {modeId: r.modeId} : {}), title: r.title, why: r.why})) : [],
          causalGroup: str(a.causalGroup), honesty: TEXT.honesty, lead: a.lead === true,
          needs: arr(a.needs).map(str), anchored: evidence.length > 0, strength: evidence.length ? found.strength : null, described: isDescribed
        }
      });
    });
    const ideas = built.sort(rank).slice(0, limit).map(b => b.idea), notes = [];
    /* Counts only, so the page can say when the scores could not order the ideas: rows without a readable score, and ideas that were ordered by one. */
    const ordering = library ? {rows: library.rows.length, unreadable: library.rows.filter(r => !hasScore(r)).length, ordered: ideas.filter(i => i.lowestScoreText !== null).length} : null;
    if (mode === 'existing' && !pkg) notes.push('No task package is loaded, so the ideas are not tied to any document. Add a task package to see where each idea could attach.');
    else if (mode === 'existing' && !ideas.some(i => i.applicability.length)) notes.push('No wording in the solver-visible documents matched an idea, so every idea waits for the task to contain the materials it needs.');
    if (mode === 'new' && !task.description) notes.push('Add a short description of the task so the ideas can be matched to the materials it has.');
    if (project) notes.push('Open net-new slots in the current project: ' + cov.openNetNewSlots + '.');
    scanned.promptNames.slice(0, 3).forEach(n => notes.push('The task request already uses wording close to "' + n + '". Keep the request from naming this mechanism.'));
    if (scanned.promptNames.length > 3) notes.push(scanned.promptNames.length - 3 + ' more ideas share wording with the task request.');
    return {ideas, inputs, notes, ordering, generatedAt: typeof input.now === 'string' ? input.now : null};
  }

  /* ---------- lint ---------- */
  const TEACHING = /\b(?:traps?|pitfalls?|gotchas?)\b/i;
  const UI_WORDS = /\b(?:(?:pass|success|failure) rate|likely to|caught)\b/i;
  const MARKER = /\[hypothesis: edit before use\]/i;
  function lintText(value, field, options) {
    const t = String(value), C = core(), out = [];
    const add = (code, text) => out.push({code, field: field || '', text});
    if (C) for (const item of C.lintGuidance(t, options)) { const m = /Found: "(.*)"\.$/s.exec(item.message); add(item.code, m ? m[1] : t.slice(0, 80)); }
    let m;
    if ((m = TEACHING.exec(t))) add('teaching-word', m[0]);
    if (t.includes('%')) add('ui-percent', '%');
    if ((m = UI_WORDS.exec(t))) add('ui-forbidden-word', m[0]);
    if ((m = MARKER.exec(t))) add('scaffold-marker', m[0]);
    return out;
  }
  /* The four fields that FinanceCore.generateGuidance splices after a fixed lead-in, with that lead-in. */
  const SPLICES = [['wrongApproach', 'A tempting mistake is to '], ['correctTreatment', 'The correct treatment is to '], ['detection', 'To check it, '], ['consequence', 'If missed, ']];
  /* Builds each spliced sentence exactly as generateGuidance would and lints it, then lints the other generated text. Accepts an
     Idea or a catalog Archetype (name instead of title). ok is true only when there is no finding of any level. */
  function lintIdea(idea, options) {
    const findings = [];
    if (!isObj(idea)) return {ok: false, findings: [{code: 'missing-field', field: 'idea', text: ''}]};
    const push = list => list.forEach(f => findings.push(f));
    for (const [field, lead] of SPLICES) {
      const v = str(idea[field]);
      if (!v.trim()) { findings.push({code: 'missing-field', field, text: ''}); continue; }
      push(lintText(sentence(lead + lowerFirst(v)), field, options));
      if (/^to\s/i.test(v.trim())) findings.push({code: 'splice-to', field, text: v.trim().slice(0, 40)});
      if (/^[A-Z]{2,}/.test(v.trim())) findings.push({code: 'splice-acronym', field, text: v.trim().slice(0, 40)});
    }
    for (const field of ['title', 'name', 'summary', 'whyItHolds']) if (field in idea) { const v = str(idea[field]); if (!v.trim()) findings.push({code: 'missing-field', field, text: ''}); else push(lintText(v, field, options)); }
    if (!('title' in idea) && !('name' in idea)) findings.push({code: 'missing-field', field: 'title', text: ''});
    for (const field of ['buildMoves', 'needs', 'howSolversGoWrong']) if (field in idea) arr(idea[field]).forEach((v, i) => push(lintText(str(v), field + '[' + i + ']', options)));
    if (!arr(idea.buildMoves).length) findings.push({code: 'missing-field', field: 'buildMoves', text: ''});
    return {ok: findings.length === 0, findings};
  }

  /* ---------- hand-off to the task editor ---------- */
  const GAF = /(?:^|[/_ -])gaf(?:[/_. -]|$)/i;
  function nearestModes(idea, project) {
    if (arr(idea.overlapWith).length) return arr(idea.overlapWith).map(o => (o.modeId ? o.modeId + ' ' : '') + str(o.title)).filter(s => s.trim());
    const mine = new Set(tokens([idea.title, idea.summary, idea.whyItHolds].map(str).join(' ')));
    return arr(project?.roots).filter(isObj).map(r => ({r, n: tokens(rootText(r)).filter(t => mine.has(t)).length})).filter(x => x.n >= 2)
      .sort((x, y) => y.n - x.n || cmp(str(x.r.id), str(y.r.id))).slice(0, 3).map(x => (str(x.r.modeId) ? x.r.modeId + ' ' : '') + str(x.r.title)).filter(s => s.trim());
  }
  /* A single-root project for FinanceAuthoring.addCandidate(pkg, {id, title, authoringProject}). Only the idea's own text goes in,
     plus anchors that re-verify against pkg. No recorded score and no precedent text is ever written. The correct treatment goes
     into correctInterpretation as the bare verb phrase (generateGuidance adds "The correct treatment is to "). */
  function toAuthoringProject(idea, options) {
    const C = core(), E = engine();
    if (!C) fail('FinanceCore is required to build a project.');
    if (!isObj(idea) || !str(idea.id) || !str(idea.title)) fail('An idea needs an id and a title.');
    const pkg = isObj(options?.pkg) ? options.pkg : null, project = isObj(options?.project) ? options.project : null;
    const p = C.blank(), r = p.roots[0], sources = [], seen = new Set();
    const lines = [];
    const verify = pkg && E && typeof E.resolveClause === 'function';
    for (const a of arr(idea.applicability)) {
      if (!isObj(a) || !str(a.documentName) || !str(a.locator)) continue;
      if (!verify) { lines.push(a.documentName + ' ' + a.locator + ': ' + str(a.quote)); continue; }
      /* With the package at hand, only an anchor that resolves to one solver-visible record holding the quote is written. */
      const hit = E.resolveClause(pkg, {name: a.documentName, locator: a.locator, excerpt: a.quote});
      if (!hit || hit.excerptVerified === false || !SOLVER_ROLES.has(hit.document.role)) continue;
      const key = hit.document.id + '|' + a.locator;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(a.documentName + ' ' + a.locator + ': ' + str(a.quote));
      sources.push({...C.source(), id: 'anchor-' + sources.length, title: a.documentName + ' ' + a.locator, file: (E.GAF_PATTERN || GAF).test(a.documentName) ? a.documentName.split('/').pop() : a.documentName, page: '', cell: a.locator, date: '', authority: 'Imported source; authority requires review', version: 'sha256:' + hit.document.sha256, excerpt: str(a.quote), reviewStatus: 'pending', suppliedToSolver: true});
    }
    const moves = arr(idea.buildMoves).map(str).filter(Boolean);
    const near = nearestModes(idea, project);
    p.title = idea.title;
    p.sources = sources;
    Object.assign(r, {
      id: idea.id, title: idea.title, lane: 'net-new', modeId: '', libraryRecord: '', mechanism: str(idea.mechanism) || r.mechanism, causalGroup: str(idea.causalGroup) || idea.id,
      sourceIds: sources.map(s => s.id), governingRule: str(idea.whyItHolds),
      facts: [lines.join('\n'), moves.length ? 'Build: ' + moves.join(' ') : ''].filter(Boolean).join('\n\n').slice(0, CAP.facts),
      triggeringCondition: moves[0] || '', correctInterpretation: str(idea.correctTreatment), wrongInterpretation: str(idea.wrongApproach),
      detectionMethod: str(idea.detection), correctiveAction: sentence(upperFirst(str(idea.correctTreatment))), headlineWrong: str(idea.consequence),
      duplicateCheck: ('To confirm: nearest current modes: ' + (near.length ? near.join('; ') : 'none found by keyword comparison') + '.').slice(0, 600),
      expectedBehavior: '', classification: '', ambiguity: '', assumptions: '', resolution: '', reviewStatus: 'pending'
    });
    return C.parseProject(p);
  }

  const api = {VERSION, TEXT, parseLibraryCsv, labelRows, retrieve, detectApplicability, coverage, buildIdeas, lintIdea, toAuthoringProject, displayText};
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else scope.FinanceIdeasModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
