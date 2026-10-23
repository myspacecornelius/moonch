'use strict';
/* The model runs the pipeline starts itself: the classifier (tool-less) and the trap designer (with tools, in its own folder). Pilots and
   the simulated grader are the agent service's: rounds and graderSim. Every run here goes through the same pieces as theirs: the
   runtime the service detected, its pre-flight (flags, sign-in), the pilot environment (a private config and temp folder, no memory
   files, the dedicated token when there is one), the argument list of claude-runner.cjs buildArgs, and the runner.

   The prompt goes to the process on stdin, never on its command line, because it holds task text that any process of this account
   could read from a command line. The designer's tool calls are audited with path-audit.cjs against its own folder; one violation
   fails the stage. */

const fs = require('node:fs');
const path = require('node:path');
const { AgentError } = require('../agents/rounds.cjs');
const { buildArgs, ClaudeRun, summarizeEvents, detectClaude, pilotEnv, preparePilotConfigDir, claudeConfigDirOf } = require('../agents/claude-runner.cjs');
const { auditToolCalls } = require('../agents/path-audit.cjs');
const { redactFilesUnder } = require('../agents/pilot-token.cjs');
const C = require('../agents/constants.cjs');

const TOOL_LESS_TIMEOUT_MS = 10 * 60 * 1000;
const NOT_FOUND = 'Claude Code was not found. Install it, or run it once in your own terminal to sign in. Nothing was started';

/* The pieces of the agent service this module uses (agents.runtime()), or, for a service that has none (a test double), the same pieces
   built from the pipeline's own options. The fallback has no pre-flight: it is only for services that cannot give one. */
function runtimeOf(agents, options) {
  if (agents && typeof agents.runtime === 'function') return agents.runtime();
  const env = options.env || process.env;
  const pinned = options.claudeBin || null;
  const exists = file => file === pinned && fs.existsSync(file);
  const runners = new Set();
  return {
    root: options.root,
    tmpRoot: options.tmpRoot,
    spawnFn: options.spawnFn,
    limits: { timeoutMs: C.LIMITS.timeoutMs, killGraceMs: C.LIMITS.killGraceMs, drainMs: undefined },
    now: () => new Date().toISOString(),
    detect: () => detectClaude({ env: pinned ? { ...env, CLAUDE_BIN: pinned } : env, exists: pinned ? exists : undefined }),
    preflight: async () => ({ token: null, source: null, dropped: [] }),
    preparedEnv: (scratch, token) => { preparePilotConfigDir(scratch); return pilotEnv(env, scratch, { token }); },
    childEnv: (scratch, token) => pilotEnv(env, scratch, { token }),
    originalConfigDir: () => claudeConfigDirOf(env, undefined),
    companionPort: () => null,
    runners,
  };
}

/* detect + pre-flight for one argument list. Returns { runtime, token }. Throws AgentError 409 when the runtime is missing or not ready. */
async function prepare(rt, args) {
  const runtime = await rt.detect(true);
  if (!runtime || !runtime.found) throw new AgentError(409, NOT_FOUND);
  const flight = await rt.preflight(runtime, [args]);
  return { runtime, token: flight.token || null };
}

/* A running process is registered in rt.runners (stopped by the service's shutdown and killPilots) and handed to onRunner (the stop button). */
async function runProcess(rt, runner, onRunner) {
  rt.runners.add(runner);
  if (onRunner) onRunner(runner);
  try {
    return await runner.start();
  } finally {
    rt.runners.delete(runner);
    if (onRunner) onRunner(null);
  }
}

/* One tool-less run in an empty folder. Resolves { summary, facts, costUsd, toolCalls }; the caller decides what the answer is worth. */
async function runToolLess({ rt, folder, prompt, model, effort, capUsd, onRunner }) {
  const args = buildArgs({ prompt, model, effort, tools: [], maxBudgetUsd: capUsd, promptVia: 'stdin' });
  const { runtime, token } = await prepare(rt, args);
  const scratch = path.join(folder, '.tmp');
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const runner = new ClaudeRun({
    bin: runtime.path,
    args,
    promptVia: 'stdin',
    prompt,
    cwd: folder,
    env: rt.preparedEnv(scratch, token),
    spawnFn: rt.spawnFn,
    timeoutMs: Math.min(rt.limits.timeoutMs, TOOL_LESS_TIMEOUT_MS),
    killGraceMs: rt.limits.killGraceMs,
    drainMs: rt.limits.drainMs,
    redact: token ? [token] : [],
  });
  const summary = await runProcess(rt, runner, onRunner);
  const facts = summarizeEvents(summary.events);
  return { summary, facts, costUsd: summary.result.total_cost_usd, toolCalls: facts.toolCalls.total };
}

/* The designer: a run with the six tools in `folder` (its working folder, which must exist). Resolves
   { summary, costUsd, audit: { status, violations, notes }, answer }. The audit covers every tool call; the token, when there is one, is
   looked for in everything the run left in the folder, and a run that left it is DISCARDED like a pilot. */
async function runDesigner({ rt, folder, prompt, model, effort, capUsd, transcriptPath, projectRoot, onRunner }) {
  const args = buildArgs({ prompt, model, effort, tools: C.TOOLS.slice(), maxBudgetUsd: capUsd, promptVia: 'stdin' });
  const { runtime, token } = await prepare(rt, args);
  const scratch = path.join(folder, '.tmp');
  const runner = new ClaudeRun({
    bin: runtime.path,
    args,
    promptVia: 'stdin',
    prompt,
    cwd: folder,
    env: rt.preparedEnv(scratch, token),
    spawnFn: rt.spawnFn,
    timeoutMs: rt.limits.timeoutMs,
    killGraceMs: rt.limits.killGraceMs,
    drainMs: rt.limits.drainMs,
    transcriptPath,
    redact: token ? [token] : [],
  });
  const summary = await runProcess(rt, runner, onRunner);
  if (summary.state === 'cancelled') return { summary, costUsd: summary.result.total_cost_usd, audit: null, answer: '' };
  const audit = auditToolCalls(summary.events, {
    folder,
    claudeConfigDir: rt.originalConfigDir(),
    projectRoot,
    env: rt.childEnv(scratch, token),
    companionPort: rt.companionPort(),
    runtimeBin: typeof runtime.path === 'string' && path.isAbsolute(runtime.path) ? runtime.path : null,
    secretValues: token ? [token] : [],
  });
  const violations = audit.violations.slice();
  const notes = audit.notes.slice();
  if (summary.redactions && !violations.some(item => item.kind === 'secret')) {
    violations.push({ tool: '(runtime output)', kind: 'secret', path: '(the pilot token)', call: 'blanked out of the runtime output' });
  }
  if (token) {
    const left = redactFilesUnder(folder, [token]);
    if (left.redacted.length) violations.push({ tool: '(files)', kind: 'secret', path: '(the pilot token in a file)', call: left.redacted.slice(0, 5).join(', ') });
  }
  return {
    summary,
    costUsd: summary.result.total_cost_usd,
    audit: { status: violations.length ? 'DISCARDED' : 'CLEAN', violations, notes },
    answer: summary.result.text,
  };
}

module.exports = { runtimeOf, runToolLess, runDesigner, NOT_FOUND };
