#!/usr/bin/env node
'use strict';
/* Test double for the Claude Code CLI. It never calls a model and never touches the network.

   Tests point CLAUDE_BIN (or the service's claudeBin option) at this file. It answers `--version`, otherwise it plays a
   scenario and exits. Everything it prints is deterministic.

   Environment:
     FINANCE_STUB_SCENARIO   JSON text (not a path). One scenario object, or an array of them. With an array, the
                             scenario for a run is chosen by the trailing -<n> of the working folder name (run 1 uses
                             the first entry, run 2 the second, and so on, wrapping around).
     FINANCE_STUB_ARGV_LOG   file that receives one JSON line per invocation: the argument list.
     FINANCE_STUB_ENV_LOG    file that receives one JSON line per run: { TMPDIR, CLAUDE_CODE_TMPDIR, cwd }.

   Scenario fields (all optional):
     init:{model, tools}     resolved model reported in system/init (default: the --model argument)
     toolUses:[{name,input,result}]  assistant tool_use blocks, each followed by a user tool_result block
     writeFiles:[{path,content}]     files written (relative to the working folder) before the result
     deleteFiles:[path]              files removed (relative to the working folder) before the result
     background              true: start a long lived child process (same process group) and leave it running; its pid
                             is written to .tmp/background.pid
     resultText              final answer text (default "stub answer"; "" gives an empty result)
     noResult                true: no result event at all
     isError, numTurns, costUsd, terminalReason, modelUsage   fields of the result event
     exitCode                process exit code (default 0)
     delayMs                 wait before the result event
     hang                    true: print system/init, then wait forever
     ignoreSigterm           true: ignore SIGTERM, so only SIGKILL stops it
     stderr                  text written to stderr at the start
     junk                    true: write lines that are not JSON between events
     chunked                 true: split every line over two writes */

const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);

function appendJsonLine(file, value) {
  if (!file) return;
  try { fs.appendFileSync(file, JSON.stringify(value) + '\n'); } catch { /* the log is a convenience for tests */ }
}

function argValue(name) {
  const at = argv.indexOf(name);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : undefined;
}

function loadScenario() {
  let parsed = {};
  const text = process.env.FINANCE_STUB_SCENARIO;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = {}; }
  }
  if (!Array.isArray(parsed)) return parsed && typeof parsed === 'object' ? parsed : {};
  if (!parsed.length) return {};
  const match = /-(\d+)$/.exec(path.basename(process.cwd()));
  const index = match ? (Number(match[1]) - 1) % parsed.length : 0;
  return parsed[Math.max(0, index)] || {};
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function write(stream, text) {
  return new Promise(resolve => stream.write(text, resolve));
}

async function main() {
  appendJsonLine(process.env.FINANCE_STUB_ARGV_LOG, argv);
  if (argv.includes('--version')) {
    await write(process.stdout, '0.0.0-stub\n');
    return;
  }

  const scenario = loadScenario();
  appendJsonLine(process.env.FINANCE_STUB_ENV_LOG, {
    TMPDIR: process.env.TMPDIR === undefined ? null : process.env.TMPDIR,
    CLAUDE_CODE_TMPDIR: process.env.CLAUDE_CODE_TMPDIR === undefined ? null : process.env.CLAUDE_CODE_TMPDIR,
    cwd: process.cwd(),
  });
  if (scenario.ignoreSigterm) process.on('SIGTERM', () => {});

  const model = (scenario.init && scenario.init.model) || argValue('--model') || 'claude-stub';
  const requestedTools = (argValue('--tools') || '').split(',').filter(Boolean);
  const sessionId = 'stub-session';
  const emitLine = async text => {
    if (scenario.chunked) {
      const middle = Math.max(1, Math.floor(text.length / 2));
      await write(process.stdout, text.slice(0, middle));
      await sleep(5);
      await write(process.stdout, text.slice(middle));
    } else {
      await write(process.stdout, text);
    }
  };
  const emit = event => emitLine(JSON.stringify(event) + '\n');
  const junk = async label => { if (scenario.junk) await write(process.stdout, 'not json ' + label + '\n\n[stub debug line]\n'); };

  if (typeof scenario.stderr === 'string' && scenario.stderr) await write(process.stderr, scenario.stderr);

  await junk('before init');
  await emit({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: sessionId,
    model,
    tools: (scenario.init && scenario.init.tools) || requestedTools,
    skills: [],
    mcp_servers: [],
    permissionMode: argValue('--permission-mode') || 'default',
  });

  if (scenario.hang) {
    setInterval(() => {}, 1000);
    return;
  }

  const toolUses = Array.isArray(scenario.toolUses) ? scenario.toolUses : [];
  for (let index = 0; index < toolUses.length; index++) {
    const use = toolUses[index] || {};
    const id = 'toolu_stub_' + (index + 1);
    await emit({
      type: 'assistant',
      message: {
        id: 'msg_stub_' + (index + 1),
        role: 'assistant',
        model,
        content: [
          { type: 'text', text: 'Working on step ' + (index + 1) + '.' },
          { type: 'tool_use', id, name: use.name || 'Bash', input: use.input || {} },
        ],
      },
      session_id: sessionId,
    });
    await junk('after tool use ' + (index + 1));
    await emit({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: typeof use.result === 'string' ? use.result : 'ok' }] },
      session_id: sessionId,
    });
  }

  for (const file of Array.isArray(scenario.writeFiles) ? scenario.writeFiles : []) {
    if (!file || typeof file.path !== 'string') continue;
    const target = path.resolve(process.cwd(), file.path);
    if (target !== process.cwd() && !target.startsWith(process.cwd() + path.sep)) continue; /* a test double stays in its folder */
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof file.content === 'string' ? file.content : '');
  }

  for (const rel of Array.isArray(scenario.deleteFiles) ? scenario.deleteFiles : []) {
    if (typeof rel !== 'string') continue;
    const target = path.resolve(process.cwd(), rel);
    if (target === process.cwd() || !target.startsWith(process.cwd() + path.sep)) continue;
    fs.rmSync(target, { force: true });
  }

  if (scenario.background) {
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    child.unref(); /* the stub itself must still be able to exit */
    fs.mkdirSync(path.join(process.cwd(), '.tmp'), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), '.tmp', 'background.pid'), String(child.pid));
  }

  if (scenario.delayMs) await sleep(Number(scenario.delayMs));

  if (!scenario.noResult) {
    const resultText = typeof scenario.resultText === 'string' ? scenario.resultText : 'stub answer';
    await emit({
      type: 'result',
      subtype: scenario.isError ? 'error_during_execution' : 'success',
      is_error: Boolean(scenario.isError),
      duration_ms: 1,
      num_turns: typeof scenario.numTurns === 'number' ? scenario.numTurns : toolUses.length + 1,
      result: resultText,
      session_id: sessionId,
      total_cost_usd: typeof scenario.costUsd === 'number' ? scenario.costUsd : 0.0123,
      terminal_reason: scenario.terminalReason || 'completed',
      modelUsage: scenario.modelUsage || { [model]: { inputTokens: 1, outputTokens: 1, costUSD: 0.0123 } },
    });
  }
  process.exitCode = typeof scenario.exitCode === 'number' ? scenario.exitCode : 0;
}

main().catch(error => {
  process.stderr.write('stub-claude failed: ' + (error && error.message ? error.message : String(error)) + '\n');
  process.exitCode = 99;
});
