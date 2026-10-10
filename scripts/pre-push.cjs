#!/usr/bin/env node
'use strict';
/* Pre-push hook that runs the privacy scan over what the push publishes (docs/local-agents.md section 14).

   Install it in each clone (hooks are not versioned). From the top of the work tree:

     printf '#!/bin/sh\nexec node scripts/pre-push.cjs "$@"\n' > .git/hooks/pre-push && chmod +x .git/hooks/pre-push

   Git runs the hook with the remote name and address as arguments and, on stdin, one line per ref being pushed:
     <local ref> <local sha> <remote ref> <remote sha>
   For every ref that is not a deletion the hook scans the commits that push would publish, so a term added in one commit and
   removed in the next still counts, as well as the files in the work tree (scripts/privacy-scan.cjs does both when it is given
   --range). Any hit, and any failure to scan, blocks the push (the scan fails closed).

   - An existing branch: the range is <remote sha>..<local sha>.
   - A new branch, or a remote sha this clone does not have: the commits not on any remote-tracking branch of that remote,
     from the first of them. Push to a named remote (git push origin ...) so that the hook knows which one that is.
   - FINANCE_PRIVACY_TERMS names another term list (the scan's --terms). The default is private/privacy-terms.txt. */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ZEROS = /^0+$/;
const SHA = /^[0-9a-f]{40,64}$/;
const SCANNER = path.join(__dirname, 'privacy-scan.cjs');

/* Parse the lines git writes to a pre-push hook. Lines that do not have four fields are ignored. */
function parseRefLines(text) {
  const entries = [];
  for (const line of String(text || '').split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) continue;
    entries.push({ localRef: fields[0], localSha: fields[1], remoteRef: fields[2], remoteSha: fields[3] });
  }
  return entries;
}

function defaultGit(args, options = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', input: options.input, cwd: options.cwd });
  return { ok: result.status === 0, out: String(result.stdout || '').trim() };
}

/* The ranges to scan, as '<base>..<head>' strings, for the refs being pushed.
   git(args, { input }) -> { ok, out } runs git in the repository. remote is the remote name git passed to the hook. */
function planRanges(entries, remote, git) {
  const ranges = [];
  for (const entry of entries) {
    if (!SHA.test(entry.localSha) || ZEROS.test(entry.localSha)) continue; /* a deletion publishes nothing */
    if (SHA.test(entry.remoteSha) && !ZEROS.test(entry.remoteSha) && git(['cat-file', '-e', `${entry.remoteSha}^{commit}`]).ok) {
      ranges.push(`${entry.remoteSha}..${entry.localSha}`);
      continue;
    }
    const unpushed = git(['rev-list', '--reverse', entry.localSha, '--not', `--remotes=${remote}`]);
    const first = unpushed.ok ? unpushed.out.split('\n')[0] : '';
    if (!first) {
      if (unpushed.ok) continue; /* everything is on the remote already */
      throw new Error('could not list the commits that this push would publish');
    }
    const parent = git(['rev-parse', '--verify', '--quiet', `${first}^`]);
    const base = parent.ok && parent.out ? parent.out : git(['hash-object', '-t', 'tree', '--stdin'], { input: '' }).out;
    ranges.push(`${base}..${entry.localSha}`);
  }
  return ranges;
}

/* Run the hook. Returns the exit code: 0 to let the push go on. */
function main(argv, stdinText, options = {}) {
  const git = options.git || defaultGit;
  const run = options.run || (args => spawnSync(process.execPath, [SCANNER, ...args], { stdio: 'inherit', env: process.env }).status);
  const err = options.err || (line => process.stderr.write(line + '\n'));
  const env = options.env || process.env;
  const top = git(['rev-parse', '--show-toplevel']);
  if (!top.ok || !top.out) {
    err('pre-push: not inside a git work tree, so the privacy scan was not run. Push blocked.');
    return 1;
  }
  let ranges;
  try {
    ranges = planRanges(parseRefLines(stdinText), argv[0] || '', git);
  } catch (error) {
    err(`pre-push: ${error.message}. Push blocked.`);
    return 1;
  }
  const base = ['--root', top.out];
  if (env.FINANCE_PRIVACY_TERMS) base.push('--terms', env.FINANCE_PRIVACY_TERMS);
  let failed = false;
  for (const range of ranges.length ? ranges : [null]) {
    const status = run(range ? [...base, '--range', range] : base);
    if (status !== 0) failed = true;
  }
  if (failed) err('pre-push: the privacy scan did not pass. Push blocked.');
  return failed ? 1 : 0;
}

module.exports = { parseRefLines, planRanges, main };

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => { process.exitCode = main(process.argv.slice(2), input); });
}
