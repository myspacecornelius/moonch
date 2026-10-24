'use strict';
/* Text out of a file, without running anything: a plain text file as it is, and the text of a word-processing, spreadsheet or slide file
   (a zip of XML parts, read with package-engine.js readZip, no browser parser). Used to find a passage of the withheld material in a file
   that carries no telltale name, and to give the simulated grader the files a pilot wrote next to its answer.
   Returns null when a file has no readable text (a picture, a PDF, a file too large for the zip reader). Never throws.

   What is read: a plain text file; the text of a Word, Excel or slide file (and of the OpenDocument kinds) including its headers, footers, comments, notes,
   sheet names, text boxes and the document properties; an RTF file as text; and any other file whose bytes are text (no NUL byte, hardly any control
   characters), whatever it is called: a notice saved as .eml, .text or with no extension is a notice. PDFs, pictures, the old binary Office kinds,
   archives and the like have no text here. */

const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
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
const CHUNK = 1024 * 1024;
const CARRY_CHARS = 16 * 1024; /* the overlap kept between two chunks: far more than a window (80 characters) with its white space */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };
function decodeXml(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : whole;
  });
}

/* The text runs of an XML part (w:t, a:t, t), paragraph ends as new lines. The text of a drawing's watermark (a VML text path) sits in an attribute and is kept. */
function runsOf(xml) {
  return decodeXml(xml
    .replace(/<v:textpath\b[^>]*\bstring="([^"]*)"[^>]*\/?>/g, ' $1 ')
    .replace(/<\/(?:w:p|a:p|si|row|text:p|text:h|p:text)>/g, '\n')
    .replace(/<(?:w:tab|w:br|w:cr)\b[^>]*\/>/g, ' ')
    .replace(/<[^>]+>/g, ''));
}

function sharedStrings(xml) {
  return (xml.match(/<si\b[\s\S]*?<\/si>/g) || []).map(item => decodeXml((item.match(/<t\b[^>]*>[\s\S]*?<\/t>/g) || []).map(part => part.replace(/<[^>]+>/g, '')).join('')));
}

function sheetText(xml, shared) {
  const rows = [];
  for (const row of xml.match(/<row\b[\s\S]*?<\/row>/g) || []) {
    const cells = [];
    for (const cell of row.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
      const type = (/\bt="([^"]*)"/.exec(cell) || [])[1];
      const value = (/<v>([\s\S]*?)<\/v>/.exec(cell) || [])[1];
      if (type === 's' && value !== undefined) cells.push(shared[Number(value)] || '');
      else if (type === 'inlineStr') cells.push(decodeXml((cell.match(/<t\b[^>]*>[\s\S]*?<\/t>/g) || []).map(part => part.replace(/<[^>]+>/g, '')).join('')));
      else if (value !== undefined) cells.push(decodeXml(value));
    }
    if (cells.length) rows.push(cells.join(' '));
  }
  return rows.join('\n');
}

/* The names of the sheets of a workbook (a tab can carry the status of the whole sheet) */
function sheetNames(xml) {
  return [...xml.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map(match => decodeXml(match[1]));
}

/* The document properties (title, subject, description, keywords, status) of an Office file: where a notice that it is withdrawn may also stand. */
function propertyText(xml) {
  return [...xml.matchAll(/<(?:dc:title|dc:subject|dc:description|cp:keywords|cp:contentStatus|cp:category)\b[^>]*>([\s\S]*?)<\/(?:dc:title|dc:subject|dc:description|cp:keywords|cp:contentStatus|cp:category)>/g)].map(match => decodeXml(match[1].replace(/<[^>]+>/g, ''))).filter(Boolean).join('\n');
}

async function zipText(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > ZIP_READ_BYTES) return null;
  const zip = await readZip(new Uint8Array(fs.readFileSync(file)));
  const names = [...zip.entries.keys()].sort();
  const ext = path.extname(file).toLowerCase();
  const parts = [];
  const take = async (pattern, convert = runsOf) => { for (const name of names.filter(item => pattern.test(item))) parts.push(convert(await zip.text(name))); };
  if (ext.startsWith('.docx') || ext === '.docm') {
    await take(/^word\/(?:document|footnotes|endnotes|comments|commentsExtended|header\d*|footer\d*)\.xml$/);
  } else if (ext.startsWith('.xlsx') || ext === '.xlsm') {
    if (zip.entries.has('xl/workbook.xml')) { const sheets = sheetNames(await zip.text('xl/workbook.xml')); if (sheets.length) parts.push(`Sheets: ${sheets.join(' | ')}`); }
    const shared = zip.entries.has('xl/sharedStrings.xml') ? sharedStrings(await zip.text('xl/sharedStrings.xml')) : [];
    for (const name of names.filter(item => /^xl\/worksheets\/sheet\d+\.xml$/.test(item))) parts.push(sheetText(await zip.text(name), shared));
    await take(/^xl\/(?:comments\d*|threadedComments\/threadedComment\d+)\.xml$/);
    await take(/^xl\/drawings\/drawing\d+\.xml$/);
  } else if (ext === '.odt' || ext === '.ods' || ext === '.odp') {
    await take(/^(?:content|styles|meta)\.xml$/);
  } else {
    await take(/^ppt\/(?:slides\/slide|notesSlides\/notesSlide)\d+\.xml$/);
    await take(/^ppt\/comments\/comment\d+\.xml$/);
  }
  if (ext !== '.odt' && ext !== '.ods' && ext !== '.odp' && zip.entries.has('docProps/core.xml')) { const props = propertyText(await zip.text('docProps/core.xml')); if (props) parts.push(props); }
  return parts.join('\n');
}

/* RTF as text: the control words and the groups that are not text (font and colour tables, pictures, anything marked as a destination) are dropped; \par
   and \line end a line; \'hh and \uN are characters. Not a faithful rendering; the words are there. */
function rtfText(raw) {
  const source = String(raw);
  const skip = /^\{\\(?:\*|fonttbl|colortbl|stylesheet|info|pict|object|header|footer|themedata|colorschememapping|latentstyles|datastore)/;
  let text = '';
  for (let at = 0; at < source.length; at++) {
    const ch = source[at];
    if (ch === '\\' && (source[at + 1] === '{' || source[at + 1] === '}' || source[at + 1] === '\\')) { text += ch + source[at + 1]; at++; continue; }
    if (ch === '{' && skip.test(source.slice(at, at + 16))) {
      /* a group that is not text: skip to its closing brace (escaped braces do not count) */
      let depth = 0;
      for (; at < source.length; at++) {
        if (source[at] === '\\') { at++; continue; }
        if (source[at] === '{') depth++;
        else if (source[at] === '}' && --depth === 0) break;
      }
      text += ' '; /* so that a control word before the group does not run into the text after it */
      continue;
    }
    text += ch;
  }
  return text
    .replace(/\\(?:par|line|sect|page)d?\b ?/g, '\n')
    .replace(/\\(?:tab)\b ?/g, ' ')
    .replace(/\\'([0-9a-fA-F]{2})/g, (whole, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u(-?\d+)\??/g, (whole, number) => { const code = Number(number); return String.fromCodePoint(code < 0 ? code + 65536 : code); })
    .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
    .replace(/\\([\\{}])/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}

/* Bytes that are text: no NUL, and hardly any control character or broken UTF-8 sequence. */
function looksLikeText(buffer) {
  if (!buffer.length) return false;
  if (buffer.includes(0)) return false;
  const text = buffer.toString('utf8');
  let bad = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0xfffd || (code < 32 && code !== 9 && code !== 10 && code !== 13 && code !== 12)) bad++;
  }
  return bad <= Math.max(2, text.length * 0.01);
}

function readHead(file, maxBytes) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) return null;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

/* The readable text of a file, at most maxChars characters, or null. */
async function extractText(file, options = {}) {
  const maxChars = options.maxChars || DEFAULT_CHARS;
  const ext = path.extname(file).toLowerCase();
  try {
    if (ZIP_EXTENSIONS.has(ext)) {
      const text = await zipText(file);
      return text === null ? null : text.slice(0, maxChars);
    }
    if (BINARY_EXTENSIONS.has(ext)) return null;
    const buffer = readHead(file, maxChars * 4);
    if (buffer === null) return null;
    if (TEXT_EXTENSIONS.has(ext)) return buffer.includes(0) ? null : buffer.toString('utf8').slice(0, maxChars);
    if (!looksLikeText(buffer)) return null;
    const text = buffer.toString('utf8');
    return (ext === '.rtf' ? rtfText(text) : text).slice(0, maxChars);
  } catch {
    return null;
  }
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

/* Reads a file of any type and size as utf8 text, in chunks (the end of one chunk is carried into the next, so a passage that spans a
   boundary is found), and says whether one of the windows (safety.leakWindows) is in it, stopping at the first. Also whether the part
   read holds a NUL byte, which a text file does not. { leak: true | false | null, binary }: leak is null when the file could not be read
   or shouldStop said so. */
async function scanFile(file, windows, shouldStop) {
  let handle;
  let binary = false;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.alloc(CHUNK);
    /* The end of the last chunk as it is in the file, white space and all: the next chunk is joined to it as it is, without a space put
       between them (a boundary can fall inside a word) and without one taken away (it can fall on a space). containsLeak squashes. */
    let carry = '';
    let leak = false;
    for (;;) {
      if (shouldStop && shouldStop()) return { leak: null, binary };
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, null);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (!binary && chunk.includes(0)) binary = true;
      if (!leak && windows.length) {
        const raw = carry + decoder.write(chunk);
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

/* Does a plain text file of any size hold one of the windows? Returns true, false, or null when the file is not text. */
async function textHoldsWindows(file, windows, shouldStop) {
  if (!windows.length || !TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) return null;
  return (await scanFile(file, windows, shouldStop)).leak;
}

module.exports = { extractText, textHoldsWindows, scanFile, decodeXml, readerKind, readerKindOfFile, rtfText, ZIP_EXTENSIONS, RENDERED_EXTENSIONS, NATIVE_EXTENSIONS, BINARY_EXTENSIONS };
