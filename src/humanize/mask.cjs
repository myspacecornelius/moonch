'use strict';
/* Masking: figures and locked terms go to the rewriter as opaque placeholders (K01, K02, ...) and come back verified. Every OCCURRENCE gets
   its own key, so a key that comes back twice, or not at all, names exactly one place in the source. Any digit the secretary did not
   recognise is masked too, so the rewriter never sees a bare number.

   choosePrefix(text) -> 'K' unless the source already holds K01-like tokens, then the first of Q, Z, J, X that it does not.
   maskSegments(texts, tokens, { prefix, next }) -> { masked: [string], map: { [key]: { text, role, basis?, kind? } }, next }
   unmask(text, map, prefix) -> text with every known key replaced by its token.
   normalizeKeys(text, map, prefix) -> text with near-miss keys a rewriter produced ("k01", "K-01", "K 01") written as the key, when that
     key exists in the map.
   keyRe(prefix) -> a global RegExp for keys. */

const PREFIXES = ['K', 'Q', 'Z', 'J', 'X'];

const keyRe = prefix => new RegExp(`\\b${prefix}\\d{2,}\\b`, 'g');
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tokenRe = text => new RegExp(`(?<![\\w])${escapeRe(text)}(?![\\w])`, 'g');

function choosePrefix(text) {
  const source = String(text == null ? '' : text);
  return PREFIXES.find(p => !keyRe(p).test(source)) || 'K';
}

function maskSegments(texts, tokenList, options = {}) {
  const prefix = options.prefix || 'K';
  let next = Number.isInteger(options.next) && options.next > 0 ? options.next : 1;
  const map = { ...(options.map || {}) };
  const masked = texts.map(text => {
    const source = String(text == null ? '' : text);
    const hits = [];
    tokenList.forEach((tok, priority) => {
      const re = tokenRe(tok.text);
      let m;
      while ((m = re.exec(source))) hits.push({ start: m.index, end: m.index + m[0].length, tok, priority });
    });
    hits.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.priority - b.priority || a.start - b.start);
    const picked = [];
    for (const hit of hits) if (!picked.some(p => p.start < hit.end && hit.start < p.end)) picked.push(hit);
    /* digits the ledger missed: masked as plain numbers */
    const loose = /\d(?:[\d,.]*\d)?/g;
    let m;
    while ((m = loose.exec(source))) {
      const start = m.index;
      const end = start + m[0].length;
      if (!picked.some(p => p.start < end && start < p.end)) picked.push({ start, end, tok: { text: m[0], role: 'fact', basis: 'number' } });
    }
    picked.sort((a, b) => a.start - b.start);
    let out = '';
    let pos = 0;
    for (const hit of picked) {
      out += source.slice(pos, hit.start);
      const key = `${prefix}${String(next).padStart(2, '0')}`;
      next += 1;
      const entry = { text: source.slice(hit.start, hit.end), role: hit.tok.role };
      if (hit.tok.basis) entry.basis = hit.tok.basis;
      if (hit.tok.kind) entry.kind = hit.tok.kind;
      map[key] = entry;
      out += key;
      pos = hit.end;
    }
    return out + source.slice(pos);
  });
  return { masked, map, next };
}

function unmask(text, map, prefix = 'K') {
  return String(text == null ? '' : text).replace(keyRe(prefix), key => (map[key] ? map[key].text : key));
}

function normalizeKeys(text, map, prefix = 'K') {
  const near = new RegExp(`(?<![\\w])[${prefix}${prefix.toLowerCase()}][\\s-]?(\\d{2,})(?![\\w])`, 'g');
  return String(text == null ? '' : text).replace(near, (whole, digits) => (map[`${prefix}${digits}`] ? `${prefix}${digits}` : whole));
}

module.exports = { choosePrefix, maskSegments, unmask, normalizeKeys, keyRe, tokenRe, PREFIXES };
