'use strict';
/* Text out of a file, without running anything: a plain text file as it is, and the text of a word-processing, spreadsheet or slide file
   (a zip of XML parts, read with package-engine.js readZip, no browser parser). Used to find a passage of the withheld material in a file
   that carries no telltale name, and to give the simulated grader the files a pilot wrote next to its answer.
   Returns null when a file has no readable text (a picture, a PDF, a file too large for the zip reader). Never throws. */

const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { readZip } = require('../../package-engine.js');
const { TEXT_EXTENSIONS, squash } = require('./util.cjs');
const { containsLeak } = require('./safety.cjs');

const ZIP_EXTENSIONS = new Set(['.docx', '.docm', '.xlsx', '.xlsm', '.pptx', '.pptm']);
const ZIP_READ_BYTES = 50 * 1024 * 1024; /* the zip reader's own limit */
const DEFAULT_CHARS = 4 * 1024 * 1024;
const CHUNK = 1024 * 1024;

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

/* The text runs of an XML part (w:t, a:t, t), paragraph ends as new lines. */
function runsOf(xml) {
  return decodeXml(xml
    .replace(/<\/(?:w:p|a:p|si|row)>/g, '\n')
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

async function zipText(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > ZIP_READ_BYTES) return null;
  const zip = await readZip(new Uint8Array(fs.readFileSync(file)));
  const names = [...zip.entries.keys()].sort();
  const ext = path.extname(file).toLowerCase();
  const parts = [];
  if (ext.startsWith('.docx') || ext === '.docm') {
    for (const name of names.filter(item => /^word\/(?:document|footnotes|endnotes|comments|header\d*|footer\d*)\.xml$/.test(item))) parts.push(runsOf(await zip.text(name)));
  } else if (ext.startsWith('.xlsx') || ext === '.xlsm') {
    const shared = zip.entries.has('xl/sharedStrings.xml') ? sharedStrings(await zip.text('xl/sharedStrings.xml')) : [];
    for (const name of names.filter(item => /^xl\/worksheets\/sheet\d+\.xml$/.test(item))) parts.push(sheetText(await zip.text(name), shared));
  } else {
    for (const name of names.filter(item => /^ppt\/(?:slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(item))) parts.push(runsOf(await zip.text(name)));
  }
  return parts.join('\n');
}

/* The readable text of a file, at most maxChars characters, or null. */
async function extractText(file, options = {}) {
  const maxChars = options.maxChars || DEFAULT_CHARS;
  const ext = path.extname(file).toLowerCase();
  try {
    if (TEXT_EXTENSIONS.has(ext)) {
      const stat = fs.statSync(file);
      if (!stat.isFile()) return null;
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, maxChars * 4));
        fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (buffer.includes(0)) return null;
        return buffer.toString('utf8').slice(0, maxChars);
      } finally {
        fs.closeSync(fd);
      }
    }
    if (ZIP_EXTENSIONS.has(ext)) {
      const text = await zipText(file);
      return text === null ? null : text.slice(0, maxChars);
    }
  } catch {
    return null;
  }
  return null;
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
    let carry = '';
    let leak = false;
    const widest = windows.length ? Math.max(...windows.map(window => window.length)) + 8 : 0;
    for (;;) {
      if (shouldStop && shouldStop()) return { leak: null, binary };
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, null);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (!binary && chunk.includes(0)) binary = true;
      if (!leak && windows.length) {
        const text = squash(carry + ' ' + decoder.write(chunk));
        if (containsLeak(text, windows)) leak = true;
        carry = text.slice(-widest);
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

module.exports = { extractText, textHoldsWindows, scanFile, decodeXml, ZIP_EXTENSIONS };
