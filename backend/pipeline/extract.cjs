'use strict';
/* Text out of a file, without running anything: a plain text file as it is, and the text of a word-processing, spreadsheet or slide file
   (a zip of XML parts, read with package-engine.js readZip, no browser parser). Used to find a passage of the withheld material in a file
   that carries no telltale name, to give the reviewers the text of the packet, and to give the simulated grader the files a pilot wrote next to its answer.
   Returns null when a file has no readable text (a picture, a PDF, a file too large for the zip reader). Never throws.

   What is read: a plain text file (UTF-8, UTF-16 with a byte order mark, or an 8-bit code page); the text of a Word, Excel or slide file (and of the OpenDocument
   kinds) with the parts a status can be written in, each labelled as what it is: a tracked deletion is "[deleted: ...]", a comment "[comment: ...]", a header
   or footer "[header: ...]" or "[footer: ...]", a note "[footnote: ...]" or "[notes: ...]", a watermark "[watermark: ...]"; every sheet of a workbook under
   "Sheet: <name>", its cells in columns (a tab between two cells, an empty cell kept), dates as dates, and a formula with no stored value as
   "[formula: ...]"; an RTF file as text; and any other file whose bytes are text, whatever it is called: a notice saved as .eml, .text or with no extension is a
   notice. PDFs, pictures, the old binary Office kinds, archives and the like have no text here.

   The XML is read by a scanner whose cost grows with the length of the part and no faster (a hostile part cannot hold the process), and no part is read beyond
   PART_CHARS characters; a file that was not read to its end is reported as partial (extractDetailed). */

const fs = require('node:fs');
const path = require('node:path');
const { readZip } = require('../../package-engine.js');
const { TEXT_EXTENSIONS } = require('./util.cjs');
const { containsLeak } = require('./safety.cjs');

const ZIP_EXTENSIONS = new Set(['.docx', '.docm', '.xlsx', '.xlsm', '.pptx', '.pptm', '.odt', '.ods', '.odp']);
/* Kinds that are never read as text, whatever their bytes: the extension says what they are. */
const BINARY_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff', '.webp', '.ico', '.heic', '.svgz', '.zip', '.gz', '.tgz', '.7z', '.rar', '.tar', '.bz2', '.xz',
  '.doc', '.xls', '.ppt', '.xlsb', '.msg', '.pst', '.mp3', '.mp4', '.mov', '.wav', '.avi', '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.db', '.sqlite', '.parquet', '.pkl', '.pickle', '.npy', '.epub', '.psd']);
/* What the blind reviewer's Read tool opens by itself, besides text: PDFs and pictures (the harness cannot give a tool-less reviewer their text). */
const NATIVE_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp']);
/* Kinds whose text the harness writes out as a plain text rendering for the blind reviewer, because the Read tool refuses them. */
const RENDERED_EXTENSIONS = new Set(['.docx', '.docm', '.xlsx', '.xlsm', '.pptx', '.pptm', '.odt', '.ods', '.odp', '.rtf']);
const ZIP_READ_BYTES = 50 * 1024 * 1024; /* the zip reader's own limit */
const DEFAULT_CHARS = 4 * 1024 * 1024;
const PART_CHARS = 8 * 1024 * 1024; /* one XML part is read to this many characters at most */
const RTF_BYTES = 32 * 1024 * 1024; /* an RTF file is read to this many bytes at most (a picture in it is most of its size) */
const MAX_TAG_CHARS = 8192; /* a tag longer than this is text */
const CHUNK = 1024 * 1024;
const CARRY_CHARS = 16 * 1024; /* the overlap kept between two chunks: far more than a window (80 characters) with its white space */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };
function decodeXml(text) {
  return String(text).replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-z]{2,6});/g, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : whole;
  });
}

/* ------------------------------------------------------------------ bytes to text */

/* The byte order mark of a text: 'utf-8', 'utf-16le', 'utf-16be', 'utf-32' (not read) or null. */
function bomOf(buffer) {
  if (buffer.length >= 4 && ((buffer[0] === 0xff && buffer[1] === 0xfe && buffer[2] === 0 && buffer[3] === 0) || (buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 0xfe && buffer[3] === 0xff))) return 'utf-32';
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return 'utf-8';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf-16le';
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf-16be';
  return null;
}

/* Windows-1252: Latin-1 for every byte but 0x80 to 0x9f, where it has the typographic quotes, the dashes, the euro sign and the like (Node's own decoder of that name
   gives the control characters of Latin-1 there). */
const CP1252_HIGH = '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';
function windows1252(buffer) {
  return buffer.toString('latin1').replace(/[\u0080-\u009f]/g, ch => CP1252_HIGH[ch.charCodeAt(0) - 0x80]);
}
const strictUtf8 = (() => { try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }); } catch { return null; } })();

/* The text of the bytes of a text file: by its byte order mark when it has one (UTF-8, UTF-16 in either order), else UTF-8, and a file that is not valid UTF-8 as
   Windows-1252 (the 8-bit code page of most Western text files). null when the bytes are not text: a NUL byte in a file with no UTF-16 mark, UTF-32, or a NUL left
   after decoding. */
function decodeBuffer(buffer) {
  const mark = bomOf(buffer);
  let text;
  if (mark === 'utf-32') return null;
  if (mark === 'utf-8') text = buffer.subarray(3).toString('utf8');
  else if (mark === 'utf-16le') text = buffer.subarray(2, 2 + ((buffer.length - 2) & ~1)).toString('utf16le');
  else if (mark === 'utf-16be') text = Buffer.from(buffer.subarray(2, 2 + ((buffer.length - 2) & ~1))).swap16().toString('utf16le');
  else {
    if (buffer.includes(0)) return null;
    if (strictUtf8) {
      try { text = strictUtf8.decode(buffer); } catch { text = windows1252(buffer); }
    } else {
      text = buffer.toString('utf8');
      if (text.includes('\ufffd')) text = windows1252(buffer);
    }
  }
  return text.includes('\0') ? null : text;
}

/* Is a text that was not named as one a text? Hardly any control character (a tab, a line end, a form feed, a vertical tab and the escape of a colour code are
   not). Colour codes are taken out. */
function plainTextOf(buffer) {
  if (!buffer.length) return null;
  const decoded = decodeBuffer(buffer);
  if (decoded === null) return null;
  let bad = 0;
  for (let i = 0; i < decoded.length; i++) {
    const code = decoded.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 11 && code !== 12 && code !== 13 && code !== 27) bad++;
  }
  if (bad > Math.max(2, decoded.length * 0.01)) return null;
  return decoded.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b/g, '');
}

/* ------------------------------------------------------------------ the XML scanner */

/* The value of an attribute in the text of a tag (no decoding of anything but the entities), or undefined. */
function attr(raw, name) {
  for (let from = 0; ;) {
    const at = raw.indexOf(name, from);
    if (at < 0) return undefined;
    const before = at === 0 ? ' ' : raw[at - 1];
    let k = at + name.length;
    if (/\s/.test(before)) {
      while (raw[k] === ' ') k++;
      if (raw[k] === '=') {
        k++;
        while (raw[k] === ' ') k++;
        const quote = raw[k];
        if (quote === '"' || quote === '\'') {
          const end = raw.indexOf(quote, k + 1);
          if (end >= 0) return decodeXml(raw.slice(k + 1, end));
        }
      }
    }
    from = at + 1;
  }
}

/* Walks a part of XML once, in time that grows with its length: onTag(name, closing, selfClosing, raw) for every tag, onText(text) for the text between them.
   Comments, processing instructions and the document type are passed over; CDATA is text. A '<' that does not open a tag (no '>' before the next '<', or a tag
   longer than MAX_TAG_CHARS) is text. */
function scanXml(xml, onTag, onText) {
  const length = xml.length;
  let i = 0;
  let gt = -1;
  while (i < length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) { onText(xml.slice(i)); return; }
    if (lt > i) onText(xml.slice(i, lt));
    if (xml.startsWith('<!--', lt)) { const end = xml.indexOf('-->', lt + 4); i = end < 0 ? length : end + 3; continue; }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      onText(xml.slice(lt + 9, end < 0 ? length : end).replace(/&/g, '&amp;').replace(/</g, '&lt;'));
      i = end < 0 ? length : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) { const end = xml.indexOf('?>', lt + 2); i = end < 0 ? length : end + 2; continue; }
    if (xml.startsWith('<!', lt)) { const end = xml.indexOf('>', lt + 2); i = end < 0 ? length : end + 1; continue; }
    if (gt < lt) {
      gt = xml.indexOf('>', lt + 1);
      if (gt < 0) { onText(xml.slice(lt).replace(/</g, '&lt;')); return; }
    }
    const next = xml.indexOf('<', lt + 1);
    if ((next >= 0 && next < gt) || gt - lt > MAX_TAG_CHARS) { onText('&lt;'); i = lt + 1; continue; }
    const raw = xml.slice(lt + 1, gt);
    const named = /^(\/)?\s*([^\s/>]+)/.exec(raw);
    if (named) onTag(named[2], Boolean(named[1]), /\/\s*$/.test(raw), raw);
    i = gt + 1;
  }
}

/* How the text of one kind of XML part is made. keep: elements whose text is kept; skip: elements dropped with everything in them; lines: elements whose end ends
   a line; cells: elements whose end (or an empty one) is a tab; breaks: elements that put a separator (an object of name to text); opens: elements that put text
   made from the tag (name to a function of its attributes); spaces: elements whose end is a space; regions: elements whose text is shown as "[label: text]". */
function markup(xml, config) {
  const keep = config.keep || new Set();
  const skip = config.skip || new Set();
  const lines = config.lines || new Set();
  const cells = config.cells || new Set();
  const spaces = config.spaces || new Set();
  const breaks = config.breaks || {};
  const opens = config.opens || {};
  const regions = config.regions || {};
  let out = '';
  let keeping = 0;
  let skipping = 0;
  let labelled = 0; /* only the outermost region is labelled: a nest of them (a hostile part) costs no more than a flat run */
  const stack = [];
  const open = new Map();
  const emit = text => { if (!skipping) out += text; };
  scanXml(xml, (name, closing, selfClosing, raw) => {
    if (closing) {
      if (!open.get(name)) return;
      for (;;) {
        const entry = stack.pop();
        open.set(entry.name, open.get(entry.name) - 1);
        if (entry.keep) keeping--;
        if (entry.skip) skipping--;
        if (entry.region) {
          labelled--;
          const inner = out.replace(/\s+/g, ' ').trim();
          out = entry.saved + (inner ? `[${entry.region}: ${inner}] ` : '');
        }
        if (entry.name === name) break;
      }
      if (lines.has(name)) emit('\n');
      if (spaces.has(name)) emit(' ');
      if (cells.has(name)) emit('\t');
      return;
    }
    if (name === 'v:textpath') { const mark = attr(raw, 'string'); if (mark && mark.trim()) emit(` [watermark: ${mark.trim()}] `); return; }
    if (Object.prototype.hasOwnProperty.call(breaks, name)) emit(breaks[name]);
    if (Object.prototype.hasOwnProperty.call(opens, name)) emit(opens[name](raw));
    if (selfClosing) {
      if (cells.has(name)) emit('\t');
      return;
    }
    const entry = { name, keep: keep.has(name), skip: skip.has(name), region: regions[name] && labelled === 0 ? regions[name] : null, saved: '' };
    /* a region is made in a string of its own and joined to what came before when it ends (cutting the text so far at every region would cost the length of it each time) */
    if (entry.region) { labelled++; entry.saved = out; out = ''; }
    stack.push(entry);
    open.set(name, (open.get(name) || 0) + 1);
    if (entry.keep) keeping++;
    if (entry.skip) skipping++;
  }, text => { if (keeping && !skipping) out += decodeXml(text); });
  while (stack.length) {
    const entry = stack.pop();
    if (entry.region) {
      labelled--;
      const inner = out.replace(/\s+/g, ' ').trim();
      out = entry.saved + (inner ? `[${entry.region}: ${inner}] ` : '');
    }
  }
  return out;
}

const WORD = {
  keep: new Set(['w:t', 'w:delText']), skip: new Set(['w:instrText', 'mc:Fallback']), lines: new Set(['w:p']),
  breaks: { 'w:tab': ' ', 'w:br': '\n', 'w:cr': '\n', 'w:noBreakHyphen': '-' },
  regions: { 'w:del': 'deleted', 'w:comment': 'comment', 'w:footnote': 'footnote', 'w:endnote': 'endnote' },
};
const SLIDE = {
  keep: new Set(['a:t', 'p:text']), skip: new Set(['mc:Fallback']), lines: new Set(['a:p']), cells: new Set(), breaks: { 'a:br': '\n', 'a:tab': ' ' },
  regions: {},
};
const MODERN_COMMENT = { ...SLIDE, regions: { 'p188:cm': 'comment', 'p:cm': 'comment' } };
const ODF = {
  keep: new Set(['text:p', 'text:h']), skip: new Set(['office:change-info', 'dc:creator', 'dc:date']), lines: new Set(['text:p', 'text:h']),
  breaks: { 'text:tab': ' ', 'text:line-break': '\n', 'text:s': ' ' },
  regions: { 'text:deletion': 'deleted', 'office:annotation': 'comment', 'text:note': 'footnote', 'style:header': 'header', 'style:header-left': 'header', 'style:header-first': 'header', 'style:footer': 'footer', 'style:footer-left': 'footer', 'style:footer-first': 'footer' },
};
const ODS = {
  ...ODF, lines: new Set(['table:table-row']), spaces: new Set(['text:p', 'text:h']), cells: new Set(['table:table-cell', 'table:covered-table-cell']),
  opens: { 'table:table': raw => `\nSheet: ${attr(raw, 'table:name') || ''}\n` },
};
const ODF_META = { keep: new Set(['dc:title', 'dc:subject', 'dc:description', 'meta:keyword', 'meta:user-defined']), lines: new Set(['dc:title', 'dc:subject', 'dc:description', 'meta:keyword', 'meta:user-defined']) };

/* "slide2" before "slide10": the numbers in a name compared as numbers. */
function natural(a, b) {
  const x = String(a).split(/(\d+)/);
  const y = String(b).split(/(\d+)/);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    if (i % 2 === 1) return Number(x[i]) - Number(y[i]);
    return x[i] < y[i] ? -1 : 1;
  }
  return x.length - y.length;
}

const tidy = text => text.replace(/[ \u00a0]+\t/g, '\t').replace(/\t+\n/g, '\n').replace(/[ \u00a0]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/* The document properties (title, subject, description, keywords, status) and the custom ones of an Office file: where a notice that it is withdrawn may also stand. */
function propertyText(xml) {
  const names = new Set(['dc:title', 'dc:subject', 'dc:description', 'cp:keywords', 'cp:contentStatus', 'cp:category']);
  const lines = [];
  let current = null;
  let property = null;
  scanXml(xml, (name, closing, selfClosing, raw) => {
    if (closing) { if (name === current || name === 'property') { current = null; property = null; } return; }
    if (names.has(name) && !selfClosing) current = name;
    else if (name === 'property' && !selfClosing) { property = attr(raw, 'name') || ''; current = 'property'; lines.push(`${property}: `); }
  }, text => {
    if (current === 'property' && lines.length) lines[lines.length - 1] += decodeXml(text);
    else if (current && text.trim()) lines.push(decodeXml(text));
  });
  return lines.map(line => line.trim()).filter(line => line && !/^[^:]*:$/.test(line)).join('\n');
}

/* ------------------------------------------------------------------ workbooks */

const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const isDateCode = code => /[dmyhs]/i.test(String(code).replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').replace(/General/gi, ''));

/* A serial number of a spreadsheet as a date (and a time when it has one). */
function serialDate(serial, date1904) {
  const days = Math.floor(serial);
  const fraction = serial - days;
  const base = date1904 ? Date.UTC(1904, 0, 1) : days < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const when = new Date(base + days * 86400000);
  if (!Number.isFinite(when.getTime())) return String(serial);
  const date = when.toISOString().slice(0, 10);
  if (fraction <= 0) return date;
  const minutes = Math.round(fraction * 1440);
  return `${date} ${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

const columnIndex = ref => {
  const letters = /^[A-Za-z]+/.exec(String(ref || ''));
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[0].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/* The strings of a workbook, in order (the text of a phonetic guide is left out). */
function sharedStrings(xml) {
  const items = [];
  let item = null;
  let inText = false;
  let phonetic = 0;
  scanXml(xml, (name, closing, selfClosing) => {
    if (name === 'si') { if (closing) { if (item !== null) items.push(item); item = null; } else if (!selfClosing) item = ''; else items.push(''); }
    else if (name === 'rPh') phonetic += closing ? -1 : selfClosing ? 0 : 1;
    else if (name === 't') inText = !closing && !selfClosing;
  }, text => { if (item !== null && inText && phonetic <= 0) item += decodeXml(text); });
  return items;
}

/* Which styles of a workbook show a date: the number format of each cell format. */
function dateStyles(xml) {
  const custom = new Map();
  const styles = [];
  let inCellFormats = false;
  scanXml(xml, (name, closing, selfClosing, raw) => {
    if (name === 'cellXfs') inCellFormats = !closing && !selfClosing;
    else if (name === 'numFmt' && !closing) custom.set(Number(attr(raw, 'numFmtId')), attr(raw, 'formatCode') || '');
    else if (name === 'xf' && !closing && inCellFormats) styles.push(Number(attr(raw, 'numFmtId') || 0));
  }, () => {});
  return styles.map(id => DATE_FORMATS.has(id) || (custom.has(id) && isDateCode(custom.get(id))));
}

/* The rows of one sheet as lines (the cells of a row in columns, a tab between two, an empty cell kept) and whether a formula had no stored value. */
function sheetRows(xml, shared, dates, date1904) {
  const rows = [];
  let row = null;
  let cell = null;
  let field = '';
  let nextColumn = 0;
  let uncached = 0;
  const finishCell = () => {
    if (!cell) return;
    let value = cell.value;
    if (cell.type === 's') value = cell.value === undefined ? '' : shared[Number(cell.value)] || '';
    else if (cell.type === 'inlineStr') value = cell.inline;
    else if (cell.type === 'b') value = cell.value === '1' ? 'TRUE' : cell.value === '0' ? 'FALSE' : '';
    else if (cell.type === 'd') value = cell.value;
    else if (cell.type !== 'str' && cell.type !== 'e' && cell.value !== undefined && dates[cell.style] && Number.isFinite(Number(cell.value))) value = serialDate(Number(cell.value), date1904);
    if ((value === undefined || value === '') && cell.formula !== null) { value = `[formula: ${cell.formula.trim() || 'shared formula'}]`; uncached++; }
    const at = cell.column >= 0 ? cell.column : nextColumn;
    nextColumn = at + 1;
    if (row && value !== undefined && value !== '' && at < 16384) { while (row.length < at) row.push(''); row[at] = String(value); }
    cell = null;
  };
  scanXml(xml, (name, closing, selfClosing, raw) => {
    if (name === 'row') {
      if (closing || selfClosing) { finishCell(); if (row && row.some(Boolean)) rows.push(row.join('\t')); row = null; nextColumn = 0; } else { row = []; nextColumn = 0; }
    } else if (name === 'c') {
      if (closing) { finishCell(); field = ''; return; }
      finishCell();
      cell = { column: columnIndex(attr(raw, 'r')), type: attr(raw, 't') || '', style: Number(attr(raw, 's') || 0), value: undefined, inline: '', formula: null };
      if (selfClosing) finishCell();
    } else if (cell && !closing && (name === 'v' || name === 'f' || name === 't')) {
      if (name === 'f' && cell.formula === null) cell.formula = '';
      field = selfClosing ? '' : name;
    } else if (closing && (name === 'v' || name === 'f' || name === 't')) field = '';
  }, text => {
    if (!cell || !field) return;
    const value = decodeXml(text);
    if (field === 'v') cell.value = (cell.value || '') + value;
    else if (field === 'f') cell.formula += value;
    else if (field === 't') cell.inline += value;
  });
  finishCell();
  return { lines: rows, uncached };
}

/* The target of a relationship, as the name of a part of the package. */
function partName(base, target) {
  const parts = (String(target).startsWith('/') ? String(target).slice(1) : `${base}${target}`).split('/');
  const out = [];
  for (const piece of parts) { if (piece === '..') out.pop(); else if (piece && piece !== '.') out.push(piece); }
  return out.join('/');
}

/* ------------------------------------------------------------------ the zip kinds */

/* The text of a zip file of XML parts and whether it was cut: { text, partial }. */
async function zipText(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > ZIP_READ_BYTES) return null;
  const zip = await readZip(new Uint8Array(fs.readFileSync(file)));
  const names = [...zip.entries.keys()];
  const ext = path.extname(file).toLowerCase();
  const parts = [];
  let partial = false;
  const read = async name => { const xml = await zip.text(name); if (xml.length > PART_CHARS) partial = true; return xml.length > PART_CHARS ? xml.slice(0, PART_CHARS) : xml; };
  const pick = pattern => names.filter(name => pattern.test(name)).sort(natural);
  const take = async (pattern, config, label = null) => {
    for (const name of pick(pattern)) {
      const text = tidy(markup(await read(name), config));
      if (text) parts.push(label ? `[${label}: ${text.replace(/\s+/g, ' ')}]` : text);
    }
  };
  let properties = true;
  if (ext === '.docx' || ext === '.docm') {
    await take(/^word\/document\.xml$/, WORD);
    await take(/^word\/(?:footnotes|endnotes)\.xml$/, WORD);
    await take(/^word\/header\d*\.xml$/, WORD, 'header');
    await take(/^word\/footer\d*\.xml$/, WORD, 'footer');
    await take(/^word\/comments\.xml$/, WORD);
  } else if (ext === '.xlsx' || ext === '.xlsm') {
    const sheets = [];
    let date1904 = false;
    if (zip.entries.has('xl/workbook.xml')) {
      scanXml(await read('xl/workbook.xml'), (name, closing, selfClosing, raw) => {
        if (closing) return;
        if (name === 'sheet') sheets.push({ name: attr(raw, 'name') || '', rid: attr(raw, 'r:id'), hidden: /^(?:hidden|veryHidden)$/.test(attr(raw, 'state') || '') });
        else if (name === 'workbookPr') date1904 = /^(?:1|true)$/i.test(attr(raw, 'date1904') || '');
      }, () => {});
    }
    const targets = new Map();
    if (zip.entries.has('xl/_rels/workbook.xml.rels')) {
      scanXml(await read('xl/_rels/workbook.xml.rels'), (name, closing, selfClosing, raw) => {
        if (!closing && name === 'Relationship' && attr(raw, 'TargetMode') !== 'External') targets.set(attr(raw, 'Id'), partName('xl/', attr(raw, 'Target') || ''));
      }, () => {});
    }
    const shared = zip.entries.has('xl/sharedStrings.xml') ? sharedStrings(await read('xl/sharedStrings.xml')) : [];
    const dates = zip.entries.has('xl/styles.xml') ? dateStyles(await read('xl/styles.xml')) : [];
    const files = pick(/^xl\/worksheets\/sheet\d+\.xml$/);
    const ordered = sheets.length ? sheets.map((sheet, index) => ({ ...sheet, file: targets.get(sheet.rid) || files[index] })) : files.map(file => ({ name: '', hidden: false, file }));
    let uncached = 0;
    for (const sheet of ordered) {
      /* a sheet is shown under its name (a workbook with no names to give shows its rows alone) */
      const label = sheet.name ? [`Sheet: ${sheet.name}${sheet.hidden ? ' (hidden)' : ''}`] : [];
      if (!sheet.file || !zip.entries.has(sheet.file)) { if (label.length) parts.push(label[0]); continue; }
      const rows = sheetRows(await read(sheet.file), shared, dates, date1904);
      uncached += rows.uncached;
      parts.push([...label, ...rows.lines].join('\n'));
    }
    if (uncached) { partial = true; parts.push(`[${uncached} formula${uncached === 1 ? '' : 's'} of this workbook had no stored value and ${uncached === 1 ? 'is' : 'are'} shown as the formula]`); }
    await take(/^xl\/comments\d*\.xml$/, { keep: new Set(['t']), skip: new Set(['rPh']), lines: new Set(['comment']), regions: { comment: 'comment' } });
    await take(/^xl\/threadedComments\/threadedComment\d+\.xml$/, { keep: new Set(['text']), regions: { threadedComment: 'comment' } });
    await take(/^xl\/drawings\/drawing\d+\.xml$/, SLIDE, 'drawing');
  } else if (ext === '.odt' || ext === '.ods' || ext === '.odp') {
    properties = false;
    await take(/^content\.xml$/, ext === '.ods' ? ODS : ODF);
    await take(/^styles\.xml$/, ODF);
    await take(/^meta\.xml$/, ODF_META);
  } else {
    const slides = pick(/^ppt\/slides\/slide\d+\.xml$/);
    for (const name of slides) { const text = tidy(markup(await read(name), SLIDE)); if (text) parts.push(text); }
    await take(/^ppt\/notesSlides\/notesSlide\d+\.xml$/, SLIDE, 'notes');
    await take(/^ppt\/comments\/comment\d+\.xml$/, MODERN_COMMENT);
    await take(/^ppt\/comments\/modernComment_[^/]*\.xml$/, MODERN_COMMENT);
    for (const [pattern, label] of [[/^ppt\/slideMasters\/slideMaster\d+\.xml$/, 'master'], [/^ppt\/slideLayouts\/slideLayout\d+\.xml$/, 'layout']]) {
      for (const name of pick(pattern)) {
        /* the prompts of a template ("Click to edit Master title style") say nothing */
        const text = tidy(markup(await read(name), SLIDE).split('\n').filter(line => line.trim() && !/^\s*(?:click to edit|edit master|second level|third level|fourth level|fifth level|\u2039#\u203a|\d{0,2}\/?\d{0,2}\/?\d{0,4})\s*/i.test(line) || /\bsuperseded|withdrawn|draft|replaced|obsolete|cancelled|void\b/i.test(line)).join('\n'));
        if (text) parts.push(`[${label}: ${text.replace(/\s+/g, ' ')}]`);
      }
    }
  }
  if (properties && zip.entries.has('docProps/core.xml')) { const props = propertyText(await read('docProps/core.xml')); if (props) parts.push(props); }
  if (properties && zip.entries.has('docProps/custom.xml')) { const props = propertyText(await read('docProps/custom.xml')); if (props) parts.push(props); }
  return { text: parts.join('\n\n'), partial };
}

/* ------------------------------------------------------------------ RTF */

const RTF_SYMBOLS = { endash: '\u2013', emdash: '\u2014', lquote: '\u2018', rquote: '\u2019', ldblquote: '\u201c', rdblquote: '\u201d', bullet: '\u2022', emspace: ' ', enspace: ' ', qmspace: ' ', tab: '\t', cell: '\t', nestcell: '\t', row: '\n', nestrow: '\n', par: '\n', line: '\n', sect: '\n', page: '\n', lbr: '\n' };
/* Groups that are not text: fonts, colours, styles, pictures and objects, document data, and the facts a file keeps about itself that are no words. */
const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'pict', 'object', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'filetbl', 'listtable', 'listoverridetable', 'rsidtbl', 'generator',
  'private', 'xmlnstbl', 'pgdsctbl', 'revtbl', 'template', 'blipuid', 'author', 'operator', 'company', 'manager', 'creatim', 'revtim', 'printim', 'buptim', 'nofpages', 'nofwords', 'nofchars', 'nofcharsws', 'vern', 'edmins',
  'userprops', 'fldinst', 'bkmkstart', 'bkmkend', 'xe', 'tc', 'tcn']);
const RTF_LABELS = { header: 'header', headerl: 'header', headerr: 'header', headerf: 'header', footer: 'footer', footerl: 'footer', footerr: 'footer', footerf: 'footer', deleted: 'deleted', annotation: 'comment' };

/* RTF as text: the groups that are not text are dropped, the symbols a word processor writes for a dash, a quote or a cell are the characters (or the separators)
   they stand for, \par and \line end a line, \'hh is a character of the Windows code page and \uN a Unicode one (with the fallback characters after it skipped), the
   text of a header, a footer, a comment or a tracked deletion is kept and labelled. Raw line breaks in the file are not text. */
function rtfText(raw) {
  const source = String(raw);
  const length = source.length;
  const special = /[{}\\\r\n]/g;
  let out = '';
  let skipping = 0;
  let unicodeSkip = 1;
  const groups = [];
  let labelled = 0; /* only the outermost labelled group is labelled */
  const emit = text => { if (!skipping) out += text; };
  const cp = hex => windows1252(Buffer.from([parseInt(hex, 16)]));
  let i = 0;
  while (i < length) {
    special.lastIndex = i;
    const found = special.exec(source);
    const stop = found ? found.index : length;
    if (stop > i) { emit(source.slice(i, stop)); i = stop; }
    if (i >= length) break;
    const ch = source[i];
    if (ch === '\r' || ch === '\n') { i++; continue; }
    if (ch === '{') {
      const head = /^\{\s*(\\\*\s*)?\\([a-zA-Z]+)/.exec(source.slice(i, i + 48));
      const word = head ? head[2] : '';
      const named = head && !head[1] ? RTF_LABELS[word] || null : head && head[1] && word === 'annotation' ? 'comment' : null;
      const label = named && labelled === 0 ? named : null;
      const skip = Boolean(head) && !named && ((head[1] && !named) || RTF_SKIP.has(word));
      groups.push({ skip, label, saved: out });
      if (skip) skipping++;
      if (label) { labelled++; out = ''; }
      i++;
      continue;
    }
    if (ch === '}') {
      const group = groups.pop();
      if (group) {
        if (group.skip) skipping--;
        if (group.label) {
          labelled--;
          const inner = out.replace(/\s+/g, ' ').trim();
          out = group.saved + (!skipping && inner ? `[${group.label}: ${inner}] ` : '');
        }
      }
      i++;
      continue;
    }
    /* a backslash */
    const next = source[i + 1];
    if (next === '\'') { const hex = source.slice(i + 2, i + 4); if (/^[0-9a-fA-F]{2}$/.test(hex)) { emit(cp(hex)); i += 4; } else i += 2; continue; }
    if (next === '\\' || next === '{' || next === '}') { emit(next); i += 2; continue; }
    if (next === '~') { emit(' '); i += 2; continue; }
    if (next === '_') { emit('-'); i += 2; continue; }
    if (next === '\r' || next === '\n') { emit('\n'); i += 2; continue; }
    if (next === undefined || !/[a-zA-Z]/.test(next)) { i += 2; continue; }
    const word = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(source.slice(i, i + 40));
    if (!word) { i += 2; continue; }
    i += word[0].length;
    const name = word[1];
    const param = word[2] === undefined ? null : Number(word[2]);
    if (name === 'u' && param !== null) {
      emit(String.fromCharCode(param < 0 ? param + 65536 : param & 0xffff));
      for (let left = unicodeSkip; left > 0 && i < length; left--) {
        if (source[i] === '\\' && source[i + 1] === '\'') i += 4;
        else i++;
      }
    } else if (name === 'uc' && param !== null) unicodeSkip = Math.max(0, Math.min(8, param));
    else if (name === 'bin' && param !== null && param > 0) i += param;
    else if (Object.prototype.hasOwnProperty.call(RTF_SYMBOLS, name)) emit(RTF_SYMBOLS[name]);
  }
  return out.replace(/ {2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ ]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ------------------------------------------------------------------ files */

function readHead(file, maxBytes) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) return null;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    return { buffer, truncated: stat.size > buffer.length };
  } finally {
    fs.closeSync(fd);
  }
}

const NOTHING = Object.freeze({ text: null, partial: false });

/* The readable text of a file, at most maxChars characters, and whether it is only part of the file's text (the file was not read to its end, a part of it
   was too long, or a formula of a workbook had no stored value): { text, partial }; text is null when the file has none. */
async function extractDetailed(file, options = {}) {
  const maxChars = options.maxChars || DEFAULT_CHARS;
  const ext = path.extname(file).toLowerCase();
  try {
    if (ZIP_EXTENSIONS.has(ext)) {
      const result = await zipText(file);
      return result === null ? NOTHING : { text: result.text.slice(0, maxChars), partial: result.partial || result.text.length > maxChars };
    }
    if (BINARY_EXTENSIONS.has(ext)) return NOTHING;
    const head = readHead(file, ext === '.rtf' ? Math.max(maxChars * 4, RTF_BYTES) : maxChars * 4);
    if (head === null) return NOTHING;
    if (TEXT_EXTENSIONS.has(ext)) {
      const text = decodeBuffer(head.buffer);
      return text === null ? NOTHING : { text: text.slice(0, maxChars), partial: head.truncated || text.length > maxChars };
    }
    const text = plainTextOf(head.buffer);
    if (text === null) return NOTHING;
    const converted = ext === '.rtf' ? rtfText(text) : text;
    return { text: converted.slice(0, maxChars), partial: head.truncated || converted.length > maxChars };
  } catch {
    return NOTHING;
  }
}

/* The readable text of a file, at most maxChars characters, or null. */
async function extractText(file, options = {}) {
  return (await extractDetailed(file, options)).text;
}

/* How a reviewer can read a file of the packet: 'text' (the Read tool opens it and the harness has its text), 'rendered' (Read refuses it; the harness writes
   a text rendering for the blind reviewer), 'native' (a PDF or a picture: Read opens it, but no tool-less reviewer can, and the harness has no text) or
   'unreadable' (nobody can read it). text: what extractText gave for the file. */
function readerKind(name, text) {
  const ext = path.extname(String(name)).toLowerCase();
  if (NATIVE_EXTENSIONS.has(ext)) return 'native';
  if (RENDERED_EXTENSIONS.has(ext)) return typeof text === 'string' && text.trim() ? 'rendered' : 'unreadable';
  if (typeof text === 'string' && text.trim()) return 'text';
  return TEXT_EXTENSIONS.has(ext) && typeof text === 'string' ? 'text' : 'unreadable';
}

/* readerKind for a file on disk, without reading what the name already says: text kinds are text, PDFs and pictures are native, the old binary kinds are
   unreadable; the rest (a Word, Excel or slide file, an RTF file, anything with another name) is read to see whether there is text in it. */
async function readerKindOfFile(file, name = file) {
  const ext = path.extname(String(name)).toLowerCase();
  if (NATIVE_EXTENSIONS.has(ext)) return 'native';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (BINARY_EXTENSIONS.has(ext)) return 'unreadable';
  return readerKind(name, await extractText(file, { maxChars: 1024 * 1024 }));
}

/* Reads a file of any type and size as text, in chunks (the end of one chunk is carried into the next, so a passage that spans a boundary is found), and says
   whether one of the windows (safety.leakWindows) is in it, stopping at the first. The file is read as UTF-8, or as UTF-16 when it starts with a byte order mark
   (the mark of UTF-8 is dropped). Also whether the part read holds a NUL byte (and is no UTF-16 text), which a text file does not. { leak: true | false | null,
   binary }: leak is null when the file could not be read or shouldStop said so. */
async function scanFile(file, windows, shouldStop) {
  let handle;
  let binary = false;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const buffer = Buffer.alloc(CHUNK);
    let decoder = null;
    /* The end of the last chunk as it is in the file, white space and all: the next chunk is joined to it as it is, without a space put
       between them (a boundary can fall inside a word) and without one taken away (it can fall on a space). containsLeak squashes. */
    let carry = '';
    let leak = false;
    let first = true;
    for (;;) {
      if (shouldStop && shouldStop()) return { leak: null, binary };
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, null);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (first) {
        first = false;
        const mark = bomOf(chunk);
        if (mark === 'utf-32') { binary = true; decoder = new TextDecoder('utf-8'); }
        else if (mark === 'utf-16le' || mark === 'utf-16be') decoder = new TextDecoder(mark);
        else decoder = new TextDecoder('utf-8', { ignoreBOM: false });
        if (mark !== 'utf-16le' && mark !== 'utf-16be' && chunk.includes(0)) binary = true;
      } else if (decoder.encoding === 'utf-8' && chunk.includes(0)) binary = true;
      if (!leak && windows.length) {
        const raw = carry + decoder.decode(chunk, { stream: true });
        if (containsLeak(raw, windows)) leak = true;
        carry = raw.slice(-CARRY_CHARS);
      }
      if (leak) break;
    }
    return { leak, binary };
  } catch {
    return { leak: null, binary };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/* Does a plain text file of any size hold one of the windows? Returns true, false, or null when the file is not text or could not be read in full (a file with a NUL
   byte is never said to be clean). */
async function textHoldsWindows(file, windows, shouldStop) {
  if (!windows.length || !TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) return null;
  const scan = await scanFile(file, windows, shouldStop);
  return scan.leak === true ? true : scan.binary ? null : scan.leak;
}

module.exports = { extractText, extractDetailed, textHoldsWindows, scanFile, decodeXml, decodeBuffer, readerKind, readerKindOfFile, rtfText, natural, ZIP_EXTENSIONS, RENDERED_EXTENSIONS, NATIVE_EXTENSIONS, BINARY_EXTENSIONS };
