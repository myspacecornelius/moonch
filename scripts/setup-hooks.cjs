#!/usr/bin/env node
'use strict';

/*
 * npm run setup: installs the privacy pre-push hook into this repository (docs/local-agents.md, section 14).
 *
 *   node scripts/setup-hooks.cjs [--force]
 *
 * It copies .githooks/pre-push (a small shim) to <git common dir>/hooks/pre-push. That folder is shared by every worktree
 * and every branch of the repository, so a push from an older branch or a linked worktree still runs the scan: the shim
 * finds the top of the checkout it is pushed from and runs that checkout's scripts/pre-push.cjs, and it blocks the push
 * when node or that script is missing.
 *
 * It does not set core.hooksPath (a relative one points at a folder that older branches do not have, and any value hides
 * the hooks of a global hooks folder). A core.hooksPath of .githooks left by an earlier version of this setup is unset.
 *
 * An existing pre-push hook that is not this shim (or the one-line hook that the README used to show) is never overwritten
 * unless --force is given; it is then kept as pre-push.replaced beside the new one.
 *
 * Exit codes: 0 installed or already up to date, 1 refused, or installed but git will not run it, 2 usage error.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join('.githooks', 'pre-push');
const MARKER = 'finance-task-studio pre-push shim';
const USAGE = 'usage: node scripts/setup-hooks.cjs [--force]';
const OLD_MANUAL_HOOK = /^#!\/bin\/sh\s*\n\s*exec node scripts\/pre-push\.cjs "\$@"\s*$/;

/* Variables that would make git look at a different repository than the one this script belongs to. */
const GIT_ENV_TO_DROP = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE'];

function gitIn(root, args) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const name of GIT_ENV_TO_DROP) delete env[name];
  const run = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
  return { ok: run.status === 0, out: String(run.stdout || '').trim(), err: String(run.stderr || '').trim() };
}

function realpath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

/** True when the existing hook text is this shim (any version) or the old one-line hook, so that it may be replaced. */
function isOurs(text) {
  return text.includes(MARKER) || OLD_MANUAL_HOOK.test(text.trim());
}

function main(argv, io = { out: line => process.stdout.write(`${line}\n`), err: line => process.stderr.write(`${line}\n`) }, root = ROOT) {
  const unknown = argv.filter(arg => arg !== '--force');
  if (unknown.length > 0) {
    io.err(`setup: unknown argument: ${unknown[0]}`);
    io.err(USAGE);
    return 2;
  }
  const force = argv.includes('--force');

  /* This folder must be the top of a git checkout. Inside another repository (or a copy with no .git) the hook would go to the wrong place. */
  const top = gitIn(root, ['rev-parse', '--show-toplevel']);
  if (!fs.existsSync(path.join(root, '.git')) || !top.ok || realpath(top.out) !== realpath(root)) {
    io.err(`setup: ${root} is not the top level of a git checkout, so no hook was installed. Run npm run setup from a clone of the repository.`);
    return 1;
  }
  const common = gitIn(root, ['rev-parse', '--git-common-dir']);
  if (!common.ok || !common.out) {
    io.err('setup: git could not say where its hooks folder is, so no hook was installed.');
    return 1;
  }
  const hooksDir = path.join(path.resolve(root, common.out), 'hooks');
  const target = path.join(hooksDir, 'pre-push');

  let shim;
  try {
    shim = fs.readFileSync(path.join(root, SOURCE), 'utf8');
  } catch {
    io.err(`setup: ${SOURCE} is missing from this checkout, so there is nothing to install. Update the checkout and run npm run setup again.`);
    return 1;
  }
  if (!shim.includes(MARKER)) {
    io.err(`setup: ${SOURCE} is not the privacy shim, so it was not installed.`);
    return 1;
  }

  let existing = null;
  try {
    existing = fs.lstatSync(target);
  } catch {
    existing = null;
  }
  let message;
  if (existing === null) {
    message = `installed the privacy hook at ${target}`;
  } else {
    let text = null;
    if (existing.isFile()) {
      try {
        text = fs.readFileSync(target, 'utf8');
      } catch {
        text = null;
      }
    }
    if (text === shim && (existing.mode & 0o111) !== 0) {
      message = `the privacy hook at ${target} is already up to date`;
    } else if (text !== null && isOurs(text)) {
      message = `updated the privacy hook at ${target}`;
    } else if (force) {
      fs.renameSync(target, `${target}.replaced`);
      message = `installed the privacy hook at ${target} (the hook that was there is kept as ${target}.replaced)`;
    } else {
      io.err(`setup: ${target} already holds a pre-push hook that is not this one, so it was left alone.`);
      io.err('setup: add a call to it from your hook (it must run node scripts/pre-push.cjs and pass its arguments and standard input), '
        + 'or run npm run setup -- --force to replace it (the old one is kept as pre-push.replaced).');
      return 1;
    }
  }
  if (!message.endsWith('is already up to date')) {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(target, shim, { mode: 0o755 });
    fs.chmodSync(target, 0o755);
  }
  io.out(`setup: ${message}`);
  io.out('setup: every checkout and worktree of this repository now runs the privacy scan from its own scripts/pre-push.cjs on git push.');

  /* An earlier version set core.hooksPath to .githooks. It is not needed now and is missing on older branches. */
  const local = gitIn(root, ['config', '--local', '--get', 'core.hooksPath']);
  if (local.ok && /^\.githooks\/?$/.test(local.out)) {
    const unset = gitIn(root, ['config', '--local', '--unset', 'core.hooksPath']);
    if (unset.ok) io.out('setup: core.hooksPath was set to .githooks; it is now unset, so git uses the hooks folder above.');
    else io.err('setup: core.hooksPath is set to .githooks and could not be unset; run git config --unset core.hooksPath.');
  }

  /* Whatever core.hooksPath is now decides which folder git runs hooks from. */
  const effective = gitIn(root, ['config', '--get', 'core.hooksPath']);
  if (effective.ok && effective.out !== '') {
    const folder = path.resolve(root, effective.out);
    if (realpath(folder) !== realpath(hooksDir)) {
      io.err(`setup: git is configured to run hooks from ${effective.out} (core.hooksPath), not from ${hooksDir}, so the privacy hook will NOT run on push.`);
      io.err(`setup: unset core.hooksPath (git config --unset core.hooksPath, or --global) or make the pre-push hook in ${effective.out} run node scripts/pre-push.cjs.`);
      return 1;
    }
  }
  return 0;
}

module.exports = { main, isOurs, MARKER };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
