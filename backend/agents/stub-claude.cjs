#!/usr/bin/env node
'use strict';
/* Test double for the Claude Code CLI. It never calls a model and never touches the network.

   Tests point CLAUDE_BIN (or the service's claudeBin option) at this file. Like the real CLI it parses its options and
   refuses an option it does not know ("error: unknown option '--x'", exit 1). It knows exactly the options the real
   CLI lists in `claude --help` that buildArgs uses, plus -h/--help and -v/--version, and the `auth status` command.
   `--help` prints them in the real CLI's layout. A prompt comes from the argument after -p, or from stdin with
   --input-format text when there is no prompt argument. Otherwise it plays a scenario and exits. Everything it prints
   is deterministic.

   Environment:
     FINANCE_STUB_SCENARIO   JSON text (not a path). One scenario object, or an array of them. With an array, the
                             scenario for a run is chosen by the trailing -<n> of the working folder name (run 1 uses
                             the first entry, run 2 the second, and so on, wrapping around).
     FINANCE_STUB_ARGV_LOG   file that receives one JSON line per invocation: the argument list.
     FINANCE_STUB_ENV_LOG    file that receives one JSON line per run: { TMPDIR, CLAUDE_CODE_TMPDIR, CLAUDE_CONFIG_DIR,
                             CLAUDE_SECURESTORAGE_CONFIG_DIR, CLAUDE_CODE_DISABLE_AUTO_MEMORY,
                             CLAUDE_CODE_DISABLE_CLAUDE_MDS, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL, cwd } (null for an
                             unset variable), plus CLAUDE_CODE_OAUTH_TOKEN_SET, CLAUDE_CODE_OAUTH_TOKEN_CHARS,
                             ANTHROPIC_AUTH_TOKEN_SET and FINANCE_STUDIO_PILOT_TOKEN_SET (a token's presence and length,
                             never its text).
     FINANCE_STUB_PROMPT_LOG file that receives one JSON line per run: { via: 'argv' | 'stdin', prompt }.
     FINANCE_STUB_HELP_DROP  comma separated options this "older CLI" does not have: left out of --help and refused.
     FINANCE_STUB_AUTH       what `auth status` answers:
                               ok (default)  signed in, exit 0
                               logged-out    {"loggedIn": false}, exit 1
                               file          signed in only when <credentials folder>/.credentials.json exists, where
                                             the credentials folder follows the real CLI's rule (see credentialsDir)
                               token         signed in only when CLAUDE_CODE_OAUTH_TOKEN is set and not empty
                               broken        text that is not JSON on stdout, a message on stderr, exit 2
                               hang          never answers
     FINANCE_STUB_AUTH_LOG   file that receives one JSON line per `auth status`: the same fields as the env log, plus
                             argv and whether CLAUDE_CONFIG_DIR exists.

   Scenario fields (all optional):
     init:{model, tools}     resolved model reported in system/init (default: the --model argument)
     toolUses:[{name,input,result}]  assistant tool_use blocks, each followed by a user tool_result block
     spill:{bytes, command}  after toolUses: a Bash call (default command "cat filesystem/big.txt") whose output is too
                             large, saved the way the runtime saves it, under
                             $CLAUDE_CONFIG_DIR/projects/<cwd key>/<session>/tool-results/<tool id>.txt, then a Read of
                             that file. CLAUDE_CONFIG_DIR must be set: the stub never writes under a home folder.
     echoToken               true: after toolUses, the stub behaves like a pilot that reads its sign-in: a Bash call
                             `printenv CLAUDE_CODE_OAUTH_TOKEN` whose result is the variable's real value, a Write of
                             outputs/token_note.txt holding it (the file is really written, and a copy goes to
                             .tmp/token_copy.txt), a line with it on stderr, and the final answer repeats it. Without the
                             variable the text "(no token)" stands in. For the redaction and secret tests only.
     fileTools               true, or { skip, outside, quoteOutside, word }: after toolUses (and the spill and echoToken
                             steps), the stub behaves like the pilot of scripts/live-smoke.cjs stage S4 and makes, in
                             order, a Read of filesystem/a.txt, a Write of outputs/b.txt, an Edit of outputs/b.txt, a Glob of
                             filesystem/*.txt and a Grep of filesystem for a word, then a Read of a file OUTSIDE the working
                             folder. Each call is an assistant tool_use block in the shape the parser reads (message.content
                             of an assistant event) with the input keys of the real tools (Read {file_path}; Write
                             {file_path, content}; Edit {file_path, old_string, new_string, replace_all}; Glob {pattern, path};
                             Grep {pattern, path, output_mode}), absolute paths as the real tools take them, followed by its
                             tool_result. The calls do what they say in the working folder: the Write and the Edit really
                             change outputs/b.txt. The outside path and the word come from the prompt, as they would for a
                             pilot: the text after "Read tool on this absolute path:" and the first word after "Grep tool to
                             search ./filesystem for the word:" (the word falls back to `word`, then "word"; with no outside
                             path in the prompt the stub exits with 98). The final answer is "DONE" unless resultText says
                             otherwise.
                               skip:["Edit",...]   tools left out of the stream, as for a runtime that never called them
                               outside:"decline"   no outside Read at all: a pilot that declined it (the answer says so)
                               quoteOutside:true   the final answer repeats the first line of the outside file, so it holds
                                                   the file's marker
     writeFiles:[{path,content}]     files written (relative to the working folder) before the result
     deleteFiles:[path]              files removed (relative to the working folder) before the result
     background              true: start a long lived child process (same process group) and leave it running; its pid
                             is written to .tmp/background.pid
     resultText              final answer text (default "stub answer"; "" gives an empty result)
     echoPrompt              true: the final answer is the prompt the stub received
     noResult                true: no result event at all
     isError, numTurns, costUsd, terminalReason, modelUsage   fields of the result event
     budgetExhausted         true: the result event the runtime sends when the --max-budget-usd cap is reached
                             (subtype error_max_budget_usd, is_error true, terminal_reason budget_exhausted, an errors
                             list and no result text). The exit code still comes from exitCode.
     exitCode                process exit code (default 0)
     delayMs                 wait before the result event
     hang                    true: print system/init, then wait forever
     ignoreSigterm           true: ignore SIGTERM, so only SIGKILL stops it
     stderr                  text written to stderr at the start
     junk                    true: write lines that are not JSON between events
     chunked                 true: split every line over two writes */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cwdKeyFor } = require('./path-audit.cjs');

const argv = process.argv.slice(2);
const VERSION = '0.0.0-stub';

/* The options of the real CLI (claude --help) that buildArgs uses, with the real argument placeholders. Variadic
   options (<x...>) take every following argument up to the next one that starts with a dash, as the real CLI does. */
const OPTIONS = [
  { names: ['--allowedTools', '--allowed-tools'], arg: '<tools...>', help: 'Comma or space-separated list of tool names to allow' },
  { names: ['--disable-slash-commands'], help: 'Disable all skills' },
  { names: ['--effort'], arg: '<level>', help: 'Effort level for the current session (low, medium, high, xhigh, max)' },
  { names: ['-h', '--help'], help: 'Display help for command' },
  { names: ['--input-format'], arg: '<format>', choices: ['text', 'stream-json'], help: 'Input format (only works with --print)' },
  { names: ['--max-budget-usd'], arg: '<amount>', help: 'Maximum dollar amount to spend on API calls (only works with --print)' },
  { names: ['--model'], arg: '<model>', help: 'Model for the current session' },
  { names: ['--no-session-persistence'], help: 'Disable session persistence (only works with --print)' },
  { names: ['--output-format'], arg: '<format>', choices: ['text', 'json', 'stream-json'], help: 'Output format (only works with --print)' },
  { names: ['-p', '--print'], help: 'Print response and exit (useful for pipes)' },
  { names: ['--permission-mode'], arg: '<mode>', choices: ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'], help: 'Permission mode to use for the session' },
  { names: ['--setting-sources'], arg: '<sources>', help: 'Comma-separated list of setting sources to load (user, project, local).' },
  { names: ['--strict-mcp-config'], help: 'Only use MCP servers from --mcp-config, ignoring all other MCP configurations' },
  { names: ['--tools'], arg: '<tools...>', help: 'Specify the list of available tools from the built-in set' },
  { names: ['--verbose'], help: 'Override verbose mode setting from config' },
  { names: ['-v', '--version'], help: 'Output the version number' },
];

const dropped = new Set(String(process.env.FINANCE_STUB_HELP_DROP || '').split(',').map(name => name.trim()).filter(Boolean));
const available = OPTIONS.map(option => ({ ...option, names: option.names.filter(name => !dropped.has(name)) })).filter(option => option.names.length);

function appendJsonLine(file, value) {
  if (!file) return;
  try { fs.appendFileSync(file, JSON.stringify(value) + '\n'); } catch { /* the log is a convenience for tests */ }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function write(stream, text) {
  return new Promise(resolve => stream.write(text, resolve));
}

/* Exit like the real CLI does on a usage error. */
async function usageError(message) {
  await write(process.stderr, message + '\n');
  process.exit(1);
}

function helpText() {
  const rows = available.map(option => [`${option.names.join(', ')}${option.arg ? ' ' + option.arg : ''}`, option.help + (option.choices ? ` (choices: ${option.choices.map(choice => `"${choice}"`).join(', ')})` : '')]);
  const lines = ['Usage: claude [options] [command] [prompt]', '', 'Claude Code test double (stub-claude.cjs). It never calls a model.', '', 'Arguments:', '  prompt                                Your prompt', '', 'Options:'];
  for (const [names, text] of rows) {
    if (names.length > 36) lines.push('  ' + names, '      ' + text);
    else lines.push('  ' + names.padEnd(38) + text);
  }
  lines.push('', 'Commands:', '  auth                                  Manage authentication', '');
  return lines.join('\n');
}

/* argv -> { options: Map(long name -> value | true), positional: [string] }, or a usage error. */
async function parseArgs(list) {
  const options = new Map();
  const positional = [];
  for (let index = 0; index < list.length; index++) {
    const raw = list[index];
    if (typeof raw !== 'string' || raw === '-' || !raw.startsWith('-')) { positional.push(raw); continue; }
    if (raw === '--') { positional.push(...list.slice(index + 1)); break; }
    const equals = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const name = equals > 0 ? raw.slice(0, equals) : raw;
    const option = available.find(entry => entry.names.includes(name));
    if (!option) return usageError(`error: unknown option '${name}'`);
    const key = option.names[option.names.length - 1];
    const label = `${option.names.join(', ')}${option.arg ? ' ' + option.arg : ''}`;
    if (!option.arg) {
      if (equals > 0) return usageError(`error: option '${label}' does not take an argument`);
      options.set(key, true);
      continue;
    }
    const values = [];
    if (equals > 0) values.push(raw.slice(equals + 1));
    else {
      if (index + 1 >= list.length || (list[index + 1].startsWith('-') && list[index + 1] !== '-')) return usageError(`error: option '${label}' argument missing`);
      values.push(list[++index]);
      if (option.arg.endsWith('...>')) while (index + 1 < list.length && !list[index + 1].startsWith('-')) values.push(list[++index]);
    }
    if (option.choices && !option.choices.includes(values[0])) {
      return usageError(`error: option '${label}' argument '${values[0]}' is invalid. Allowed choices are ${option.choices.join(', ')}.`);
    }
    options.set(key, option.arg.endsWith('...>') ? values.join(',') : values[0]);
  }
  return { options, positional };
}

/* ------------------------------------------------------------------ auth status */

/* The folder the real CLI (2.1.x) reads the sign-in from on Linux: CLAUDE_SECURESTORAGE_CONFIG_DIR when it is set (an
   empty value means ~/.claude), otherwise the configuration folder (CLAUDE_CONFIG_DIR or ~/.claude). */
function credentialsDir(env) {
  const home = env.HOME || os.homedir();
  if (env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined) return env.CLAUDE_SECURESTORAGE_CONFIG_DIR || path.join(home, '.claude');
  return env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
}

/* The name of the macOS Keychain item the real CLI (2.1.x) uses: no suffix when CLAUDE_SECURESTORAGE_CONFIG_DIR is
   empty, or when neither it nor CLAUDE_CONFIG_DIR is set; otherwise a suffix from the sha256 of that folder. */
function keychainService(env) {
  const store = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const plain = store !== undefined ? !store : !env.CLAUDE_CONFIG_DIR;
  const dir = store !== undefined ? store : env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
  return 'Claude Code-credentials' + (plain ? '' : '-' + crypto.createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8));
}

function envFacts() {
  const value = name => (process.env[name] === undefined ? null : process.env[name]);
  return {
    TMPDIR: value('TMPDIR'),
    CLAUDE_CODE_TMPDIR: value('CLAUDE_CODE_TMPDIR'),
    CLAUDE_CONFIG_DIR: value('CLAUDE_CONFIG_DIR'),
    CLAUDE_SECURESTORAGE_CONFIG_DIR: value('CLAUDE_SECURESTORAGE_CONFIG_DIR'),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: value('CLAUDE_CODE_DISABLE_AUTO_MEMORY'),
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: value('CLAUDE_CODE_DISABLE_CLAUDE_MDS'),
    ANTHROPIC_BASE_URL: value('ANTHROPIC_BASE_URL'),
    ANTHROPIC_MODEL: value('ANTHROPIC_MODEL'),
    CLAUDE_CODE_OAUTH_TOKEN_SET: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
    CLAUDE_CODE_OAUTH_TOKEN_CHARS: (process.env.CLAUDE_CODE_OAUTH_TOKEN || '').length,
    ANTHROPIC_AUTH_TOKEN_SET: Boolean(process.env.ANTHROPIC_AUTH_TOKEN),
    FINANCE_STUDIO_PILOT_TOKEN_SET: Boolean(process.env.FINANCE_STUDIO_PILOT_TOKEN),
    cwd: process.cwd(),
  };
}

async function authCommand(list) {
  if (list[0] === '-h' || list[0] === '--help' || !list.length) {
    await write(process.stdout, 'Usage: claude auth [options] [command]\n\nManage authentication\n\nCommands:\n  status [options]  Show authentication status\n');
    return;
  }
  if (list[0] !== 'status') return usageError(`error: unknown command '${list[0]}'`);
  for (const option of list.slice(1)) {
    if (!['--json', '--text', '-h', '--help'].includes(option)) return usageError(`error: unknown option '${option}'`);
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude');
  appendJsonLine(process.env.FINANCE_STUB_AUTH_LOG, { argv: list, ...envFacts(), configDirExists: fs.existsSync(configDir) });
  const mode = process.env.FINANCE_STUB_AUTH || 'ok';
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'broken') {
    await write(process.stdout, 'something that is not JSON\n');
    await write(process.stderr, 'stub auth failure\n');
    process.exitCode = 2;
    return;
  }
  const store = credentialsDir(process.env);
  const byToken = mode === 'token' && Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  const loggedIn = mode === 'ok' || byToken || (mode === 'file' && fs.existsSync(path.join(store, '.credentials.json')));
  const report = {
    loggedIn,
    authMethod: byToken ? 'oauth-token' : loggedIn ? 'claude.ai' : 'none',
    apiProvider: 'firstParty',
    configDirectory: configDir,
    credentialsDirectory: store,
    keychainService: keychainService(process.env),
  };
  await write(process.stdout, JSON.stringify(report, null, 2) + '\n');
  process.exitCode = loggedIn ? 0 : 1;
}

/* ------------------------------------------------------------------ a run */

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

function readStdin() {
  return new Promise(resolve => {
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function main() {
  appendJsonLine(process.env.FINANCE_STUB_ARGV_LOG, argv);
  if (argv[0] === 'auth') return authCommand(argv.slice(1));
  const { options, positional } = await parseArgs(argv);
  if (options.has('--help')) { await write(process.stdout, helpText()); return; }
  if (options.has('--version')) { await write(process.stdout, VERSION + '\n'); return; }
  if (!options.has('--print')) return usageError('stub-claude: only --print runs are supported by this test double');
  if (options.has('--max-budget-usd')) {
    const budget = Number(options.get('--max-budget-usd'));
    if (!Number.isFinite(budget) || budget <= 0) return usageError('Error: --max-budget-usd must be a positive number greater than 0');
  }
  let prompt = positional.length ? positional[0] : '';
  let via = 'argv';
  if (!positional.length && options.get('--input-format') !== 'stream-json') {
    prompt = await readStdin();
    via = 'stdin';
  }
  if (!prompt.trim()) return usageError('Error: Input must be provided either through stdin or as a prompt argument when using --print');
  appendJsonLine(process.env.FINANCE_STUB_PROMPT_LOG, { via, prompt });

  const scenario = loadScenario();
  appendJsonLine(process.env.FINANCE_STUB_ENV_LOG, envFacts());
  if (scenario.ignoreSigterm) process.on('SIGTERM', () => {});

  const model = (scenario.init && scenario.init.model) || options.get('--model') || 'claude-stub';
  const requestedTools = String(options.get('--tools') || '').split(',').filter(Boolean);
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
    permissionMode: options.get('--permission-mode') || 'default',
  });

  if (scenario.hang) {
    setInterval(() => {}, 1000);
    return;
  }

  let step = 0;
  const toolCall = async (name, input, result) => {
    step++;
    const id = 'toolu_stub_' + step;
    await emit({
      type: 'assistant',
      message: {
        id: 'msg_stub_' + step,
        role: 'assistant',
        model,
        content: [
          { type: 'text', text: 'Working on step ' + step + '.' },
          { type: 'tool_use', id, name, input },
        ],
      },
      session_id: sessionId,
    });
    await junk('after tool use ' + step);
    const content = typeof result === 'function' ? result(id) : result;
    await emit({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
      session_id: sessionId,
    });
  };

  const toolUses = Array.isArray(scenario.toolUses) ? scenario.toolUses : [];
  for (const use of toolUses) {
    const entry = use || {};
    await toolCall(entry.name || 'Bash', entry.input || {}, typeof entry.result === 'string' ? entry.result : 'ok');
  }

  if (scenario.spill) {
    /* The runtime keeps a tool output that is too large for the conversation in its configuration folder and hands the
       agent the path; the agent then reads that file. */
    const configDir = process.env.CLAUDE_CONFIG_DIR;
    if (!configDir || !path.isAbsolute(configDir)) {
      await write(process.stderr, 'stub-claude: the spill scenario needs an absolute CLAUDE_CONFIG_DIR\n');
      process.exitCode = 98;
      return;
    }
    const bytes = Math.max(1, Math.min(Number(scenario.spill.bytes) || 64 * 1024, 4 * 1024 * 1024));
    const body = 'synthetic large output line\n'.repeat(Math.ceil(bytes / 28)).slice(0, bytes);
    let spillPath = '';
    await toolCall('Bash', { command: scenario.spill.command || 'cat filesystem/big.txt' }, id => {
      spillPath = path.join(configDir, 'projects', cwdKeyFor(process.cwd()), sessionId, 'tool-results', id + '.txt');
      fs.mkdirSync(path.dirname(spillPath), { recursive: true });
      fs.writeFileSync(spillPath, body);
      return `Output too large (${bytes} bytes). Full output saved to: ${spillPath}\n\nPreview (first 200 characters):\n${body.slice(0, 200)}`;
    });
    await toolCall('Read', { file_path: spillPath }, fs.readFileSync(spillPath, 'utf8').slice(0, 2000));
  }

  let tokenEcho = '';
  if (scenario.echoToken) {
    /* A pilot that reads its sign-in and lets it out everywhere a run leaves traces: a tool result, a file in outputs/,
       a file in its scratch space, stderr and the final answer. */
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || '(no token)';
    await toolCall('Bash', { command: 'printenv CLAUDE_CODE_OAUTH_TOKEN' }, token + '\n');
    const note = 'pilot token: ' + token + '\n';
    fs.mkdirSync(path.join(process.cwd(), 'outputs'), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), 'outputs', 'token_note.txt'), note);
    fs.mkdirSync(path.join(process.cwd(), '.tmp'), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), '.tmp', 'token_copy.txt'), note);
    await toolCall('Write', { file_path: 'outputs/token_note.txt', content: note }, 'File written');
    await write(process.stderr, 'stub debug: token=' + token + '\n');
    tokenEcho = ' The token is ' + token + '.';
  }

  let fileToolsEcho = '';
  if (scenario.fileTools) {
    const spec = typeof scenario.fileTools === 'object' && !Array.isArray(scenario.fileTools) ? scenario.fileTools : {};
    const skip = new Set(Array.isArray(spec.skip) ? spec.skip : []);
    const declined = spec.outside === 'decline';
    const inFolder = rel => path.join(process.cwd(), ...rel.split('/'));
    const word = (/Grep tool to search \.\/filesystem for the word:[ \t]*(\S+)/.exec(prompt) || [])[1] || (typeof spec.word === 'string' && spec.word ? spec.word : 'word');
    const outside = (/Read tool on this absolute path:[ \t]*(\/[^\r\n]*?)[ \t]*(?:\r?\n|$)/.exec(prompt) || [])[1] || '';
    if (!declined && !outside) {
      await write(process.stderr, 'stub-claude: the fileTools scenario needs the prompt to name an absolute path after "Read tool on this absolute path:" (or outside: "decline")\n');
      process.exitCode = 98;
      return;
    }
    /* What the real Read tool returns: the file with line numbers. */
    const readResult = file => {
      try {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        if (lines.length && lines[lines.length - 1] === '') lines.pop();
        return lines.map((line, index) => String(index + 1).padStart(6) + '\t' + line).join('\n');
      } catch {
        return 'File does not exist: ' + file;
      }
    };
    const steps = [
      ['Read', () => ({ file_path: inFolder('filesystem/a.txt') }), input => readResult(input.file_path)],
      ['Write', () => ({ file_path: inFolder('outputs/b.txt'), content: 'stub note: first version\n' }), input => {
        fs.mkdirSync(path.dirname(input.file_path), { recursive: true });
        fs.writeFileSync(input.file_path, input.content);
        return 'File created successfully at: ' + input.file_path;
      }],
      ['Edit', () => ({ file_path: inFolder('outputs/b.txt'), old_string: 'first version', new_string: 'second version', replace_all: false }), input => {
        try {
          fs.writeFileSync(input.file_path, fs.readFileSync(input.file_path, 'utf8').replace(input.old_string, input.new_string));
        } catch {
          return 'File does not exist: ' + input.file_path;
        }
        return 'The file ' + input.file_path + ' has been updated successfully.';
      }],
      ['Glob', () => ({ pattern: '*.txt', path: inFolder('filesystem') }), input => {
        let names = [];
        try { names = fs.readdirSync(input.path).filter(name => name.endsWith('.txt')).sort(); } catch { /* nothing to list */ }
        return names.length ? names.map(name => path.join(input.path, name)).join('\n') : 'No files found';
      }],
      ['Grep', () => ({ pattern: word, path: inFolder('filesystem'), output_mode: 'files_with_matches' }), input => {
        let hits = [];
        try { hits = fs.readdirSync(input.path).sort().filter(name => fs.readFileSync(path.join(input.path, name), 'utf8').includes(input.pattern)); } catch { /* nothing to search */ }
        return hits.length ? `Found ${hits.length} file${hits.length === 1 ? '' : 's'}\n` + hits.map(name => path.join(input.path, name)).join('\n') : 'No files found';
      }],
    ];
    for (const [name, makeInput, act] of steps) {
      if (skip.has(name)) continue;
      const input = makeInput();
      await toolCall(name, input, act(input));
    }
    if (declined) {
      fileToolsEcho = ' I did not read the file outside my folder.';
    } else if (!skip.has('Read')) {
      await toolCall('Read', { file_path: outside }, readResult(outside));
      if (spec.quoteOutside) {
        let first = '';
        try { first = fs.readFileSync(outside, 'utf8').split('\n')[0]; } catch { /* the file is gone */ }
        fileToolsEcho = ' The outside file says: ' + first;
      }
    }
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

  if (!scenario.noResult && scenario.budgetExhausted) {
    const cap = Number(options.get('--max-budget-usd'));
    await emit({
      type: 'result',
      subtype: 'error_max_budget_usd',
      is_error: true,
      duration_ms: 1,
      num_turns: typeof scenario.numTurns === 'number' ? scenario.numTurns : step + 1,
      session_id: sessionId,
      total_cost_usd: typeof scenario.costUsd === 'number' ? scenario.costUsd : Number.isFinite(cap) ? cap : 0.0123,
      terminal_reason: 'budget_exhausted',
      errors: ['Reached maximum budget ($' + (Number.isFinite(cap) ? cap : 0) + ')'],
      modelUsage: scenario.modelUsage || { [model]: { inputTokens: 1, outputTokens: 1, costUSD: 0.0123 } },
    });
  } else if (!scenario.noResult) {
    const resultText = (scenario.echoPrompt ? prompt : typeof scenario.resultText === 'string' ? scenario.resultText : scenario.fileTools ? 'DONE' : 'stub answer') + fileToolsEcho + tokenEcho;
    await emit({
      type: 'result',
      subtype: scenario.isError ? 'error_during_execution' : 'success',
      is_error: Boolean(scenario.isError),
      duration_ms: 1,
      num_turns: typeof scenario.numTurns === 'number' ? scenario.numTurns : step + 1,
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
