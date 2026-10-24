'use strict';
/* The owner's reference documents (designer v2): private files that show the designer what good tasks of a kind look like. They live in
   <root>/private/references/ (never committed) or in a folder the owner names. They go to the designer and to the reviews that see the
   brief; pilots never see them, and no word of them is allowed into a file the pilots receive (the leak guard uses leakWindows on their text).

   The folder is checked the way an import is: a real folder, regular files only, no links, nothing outside it, at most REFERENCES.files files
   and REFERENCES.bytes bytes in all, in the extensions the designer can read. A folder that breaks a rule is refused whole: a silent subset
   would change what the designer is shown. The summary the page gets holds names and sizes, never content. */

const fs = require('node:fs');
const path = require('node:path');
const { REFERENCES } = require('./constants.cjs');
const { walkFiles, nameProblem, copyHashed, oneLine } = require('./util.cjs');
const { extractText } = require('./extract.cjs');

const EXTENSIONS = new Set(REFERENCES.extensions);

/* dir -> { dir, files: [{ name, abs, bytes }], bytes, problems: [text] }. Never throws; problems says what is wrong. dir is used as it is
   (the caller resolved it); a folder that is a link, or not a folder, is a problem. */
function scanReferences(dir) {
  const out = { dir, files: [], bytes: 0, problems: [] };
  let stat;
  try { stat = fs.lstatSync(dir); } catch { out.problems.push('The reference folder does not exist'); return out; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) { out.problems.push('The reference folder is not a plain folder (a link or a file stands in its place)'); return out; }
  let walked;
  try {
    walked = walkFiles(dir, { maxFiles: REFERENCES.files + 1, depth: REFERENCES.depth });
  } catch (error) {
    out.problems.push(`The reference folder holds more than ${REFERENCES.files} files`);
    return out;
  }
  for (const item of walked.skipped) {
    if (/symbolic link|not a regular file|control character|nested deeper/.test(item.why)) out.problems.push(`The reference folder holds an entry that cannot be used (${oneLine(item.rel, 80)}: ${item.why})`);
  }
  for (const file of walked.files) {
    const problem = nameProblem(file.rel, REFERENCES.depth);
    if (problem) { out.problems.push(`The reference file ${oneLine(file.rel, 80)} cannot be used: ${problem}`); continue; }
    if (!EXTENSIONS.has(path.extname(file.rel).toLowerCase())) { out.problems.push(`The reference file ${oneLine(file.rel, 80)} is not one of ${REFERENCES.extensions.join(' ')}`); continue; }
    out.files.push({ name: file.rel, abs: file.abs, bytes: file.bytes });
    out.bytes += file.bytes;
  }
  if (out.files.length > REFERENCES.files) out.problems.push(`The reference folder holds ${out.files.length} files; the limit is ${REFERENCES.files}`);
  if (out.bytes > REFERENCES.bytes) out.problems.push(`The reference files together are ${Math.ceil(out.bytes / 1048576)} MB; the limit is ${Math.round(REFERENCES.bytes / 1048576)} MB`);
  return out;
}

/* What the page may show: how many and their names, never a word of content. */
function referenceSummary(dir) {
  const scan = scanReferences(dir);
  /* problems is how many there are; problemList says what they are, each one a short plain sentence that names a file or the folder and the reason, never
     a word of a document (at most 20, each cut to 200 characters). */
  return {
    found: scan.problems.length ? 0 : scan.files.length, names: scan.problems.length ? [] : scan.files.map(file => file.name), bytes: scan.problems.length ? 0 : scan.bytes,
    problems: scan.problems.length, problemList: scan.problems.slice(0, 20).map(problem => oneLine(problem, 200)),
  };
}

/* Copies the files into destDir (streamed, hashed, never through a link) and returns [{ name, bytes, sha256 }]. */
async function copyReferences(files, destDir, shouldStop) {
  const out = [];
  for (const file of files) {
    const copied = await copyHashed(file.abs, path.join(destDir, ...file.name.split('/')), { shouldStop });
    out.push({ name: file.name, bytes: copied.bytes, sha256: copied.sha256 });
  }
  return out;
}

/* The text of the reference files, where it can be read: [{ name, text }] with text null for a file with no readable text (a PDF). */
const TEXT_LIMIT = REFERENCES.bytes; /* a text file is read whole (the folder holds at most this many bytes); an office file's text is cut at the same number of characters */
async function referenceTexts(dir, files) {
  const out = [];
  for (const file of files) {
    const text = await extractText(path.join(dir, ...file.name.split('/')), { maxChars: TEXT_LIMIT });
    /* a text that reaches the limit may go on beyond it: the caller names it as partly scanned */
    out.push({ name: file.name, text, cut: typeof text === 'string' && text.length >= TEXT_LIMIT });
  }
  return out;
}

module.exports = { scanReferences, referenceSummary, copyReferences, referenceTexts };
