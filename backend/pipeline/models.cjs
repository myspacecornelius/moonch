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
const { isolationProblems } = require('./isolation.cjs');

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

/* An isolated run (designer v2: a reviewer, an adjudicator, the blind reader) is checked, before its process exists, against the exclusions of
   isolation.cjs: the options and environment it would get and its working folder. A run that fails one is not started. `isolated` is true or
   { forbiddenText: [strings that no environment value or argument may hold] }. */
function requireIsolation(rt, isolated, { args, env, folder, tools }) {
  if (!isolated) return;
  const problems = isolationProblems({
    args, env, cwd: folder, tmpRoot: rt.tmpRoot, projectRoot: rt.root, homeDir: require('node:os').homedir(),
    forbiddenText: isolated && Array.isArray(isolated.forbiddenText) ? isolated.forbiddenText : [],
    /* the tools this kind of run may have, fixed by the kind of run and not by its caller: none for a tool-less review, the reader's three for an audited one */
    tools,
  });
  if (problems.length) throw new AgentError(409, `A review run was not started because it would not be isolated (${problems.slice(0, 3).join('; ')}). Nothing was started`);
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
async function runToolLess({ rt, folder, prompt, model, effort, capUsd, onRunner, isolated = false }) {
  const args = buildArgs({ prompt, model, effort, tools: [], maxBudgetUsd: capUsd, promptVia: 'stdin' });
  const { runtime, token } = await prepare(rt, args);
  const scratch = path.join(folder, '.tmp');
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const env = rt.preparedEnv(scratch, token);
  requireIsolation(rt, isolated, { args, env, folder, tools: [] });
  const runner = new ClaudeRun({
    bin: runtime.path,
    args,
    promptVia: 'stdin',
    prompt,
    cwd: folder,
    env,
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

/* A run with tools in `folder` (its working folder, which must exist), audited like a pilot: every tool call against the folder, the token, when
   there is one, looked for in everything the run left in it. Resolves { summary, costUsd, audit: { status, violations, notes }, answer }. A
   run that left the token, or a tool call outside the folder, is DISCARDED. tools: the tools of the run, from the allowlist. */
async function runAudited({ rt, folder, prompt, model, effort, capUsd, tools, transcriptPath, projectRoot, onRunner, isolated = false }) {
  const args = buildArgs({ prompt, model, effort, tools, maxBudgetUsd: capUsd, promptVia: 'stdin' });
  const { runtime, token } = await prepare(rt, args);
  const scratch = path.join(folder, '.tmp');
  const env = rt.preparedEnv(scratch, token);
  /* an isolated run with tools is a reader: it never has more than the reader's three, whatever the caller asked for */
  requireIsolation(rt, isolated, { args, env, folder, tools: REVIEWER_TOOLS });
  const runner = new ClaudeRun({
    bin: runtime.path,
    args,
    promptVia: 'stdin',
    prompt,
    cwd: folder,
    env,
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

/* The designer: a run with the six tools in its own folder. */
const runDesigner = options => runAudited({ ...options, tools: C.TOOLS.slice() });

/* The blind reviewer (designer v2, stage 1): a run that can only read, in a copy of the pilot packet. */
const REVIEWER_TOOLS = Object.freeze(['Read', 'Glob', 'Grep']);
const runReviewer = options => runAudited({ ...options, tools: REVIEWER_TOOLS.slice() });

module.exports = { runtimeOf, runToolLess, runDesigner, runReviewer, runAudited, REVIEWER_TOOLS, NOT_FOUND };
