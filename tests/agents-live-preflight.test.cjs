'use strict';
/* Tests for the checks made before any agent process starts (claude --help, claude auth status), the pilot environment
   that keeps the runtime's own files inside the pilot folder, and scripts/live-smoke.cjs (stage S0 and stage S4 end to
   end against the stub, the other stages through their helpers). Every run uses backend/agents/stub-claude.cjs. No model
   is started and nothing touches the network. All fixtures are synthetic and live in temporary folders that are removed
   afterwards (the raw stream S4 keeps goes to a folder of the test's own). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanEnv } = require('./fixtures/clean-env.cjs');

const {
  buildArgs, REQUIRED_FLAGS, parseHelpFlags, missingFlags, readHelpFlags, claudeConfigDirOf, secureStorageDirFor, pilotEnv,
  preparePilotConfigDir, checkAuth,
} = require('../backend/agents/claude-runner.cjs');
const { createAgentService, AgentError } = require('../backend/agents/index.cjs');
const C = require('../backend/agents/constants.cjs');
const smoke = require('../scripts/live-smoke.cjs');

const STUB = path.resolve(__dirname, '..', 'backend', 'agents', 'stub-claude.cjs');
const SMOKE = path.resolve(__dirname, '..', 'scripts', 'live-smoke.cjs');
const PROMPT = 'Assess the synthetic liquidity position using the supplied records and recommend whether the borrowing can proceed.';
const ACK = ['shell-access', 'network', 'isolation-by-audit'];
const GOLD = { gold: { decision: 'hold', figures: [{ label: 'Usable cash', value: '1,250', tolerance: 1 }], notes: 'Synthetic gold' }, fingerprints: [] };

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

const promptRuns = file => readJsonLines(file).filter(args => args.includes('-p'));

function tempDir(t, prefix = 'finance-preflight-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* A synthetic world: <base>/project, <base>/source (the packet), <base>/tmp (pilot and pre-flight folders). */
function makeWorld(t, scenario = {}, extraEnv = {}) {
  const base = tempDir(t);
  const projectRoot = path.join(base, 'project');
  const source = path.join(base, 'source');
  const tmpRoot = path.join(base, 'tmp');
  for (const dir of [path.join(projectRoot, 'private'), source, tmpRoot]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(source, 'Facility_Terms.txt'), 'Synthetic facility terms. Available credit is not cash received.\n');
  fs.writeFileSync(path.join(source, 'Cash_Facts.csv'), 'Label,Value\nOpening usable cash,100\n');
  const logs = { argv: path.join(base, 'argv.log'), env: path.join(base, 'env.log'), auth: path.join(base, 'auth.log') };
  const env = {
    ...cleanEnv(),
    FINANCE_STUB_SCENARIO: JSON.stringify(scenario),
    FINANCE_STUB_ARGV_LOG: logs.argv,
    FINANCE_STUB_ENV_LOG: logs.env,
    FINANCE_STUB_AUTH_LOG: logs.auth,
    ...extraEnv,
  };
  const service = createAgentService({ root: projectRoot, env, claudeBin: STUB, tmpRoot });
  t.after(() => service.shutdown());
  return { base, projectRoot, source, tmpRoot, logs, env, service, pilots: path.join(tmpRoot, 'finance-studio-pilots') };
}

async function approvedRound(w) {
  const round = await w.service.createRound({ label: 'synthetic', sourceDir: w.source, promptText: PROMPT, gafVisible: true, config: { model: 'claude-opus-5-5', effort: 'medium', count: 1 } });
  await w.service.freezeRound(round.id, GOLD);
  const { summarySha256 } = await w.service.approvalSummary(round.id);
  await w.service.approveRound(round.id, { summarySha256, acknowledgements: ACK });
  return round.id;
}

async function rejects(promise, status, pattern) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof AgentError, 'AgentError expected, got ' + (error && error.stack));
    assert.equal(error.status, status, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

const preflightFolders = w => fs.readdirSync(w.tmpRoot).filter(name => name.startsWith('finance-studio-preflight-'));

/* Runs the stub's `auth status --json` with exactly `env` and returns its JSON. */
function stubAuth(env, cwd) {
  const result = childProcess.spawnSync(process.execPath, [STUB, 'auth', 'status', '--json'], { env, cwd, encoding: 'utf8', timeout: 15000 });
  return { code: result.status, report: JSON.parse(result.stdout) };
}

/* ====================================================================== reading claude --help */

/* A synthetic help text in the layout of the real CLI: aliases, a long option on its own line with the description
   indented below, wrapped descriptions that start with a dash, and a Commands section. */
const SYNTHETIC_HELP = [
  'Usage: claude [options] [command] [prompt]',
  '',
  'Options:',
  '  --add-dir <directories...>            Additional directories to allow tool',
  '                                        access to',
  '  --allowedTools, --allowed-tools <tools...>',
  '      Comma or space-separated list of tool names to allow',
  '  --forward-subagent-text               Forward subagent text (only works with',
  '                                        --print and --output-format=stream-json)',
  '                                        --not-a-flag-on-a-wrapped-line',
  '  -p, --print                           Print response and exit',
  '  --max-budget-usd <amount>             Maximum dollar amount to spend',
  '  --no-session-persistence              Disable session persistence',
  '  -v, --version                         Output the version number',
  '',
  'Commands:',
  '  auth                                  Manage authentication',
].join('\n');

test('parseHelpFlags reads option names, aliases included, and ignores wrapped description lines', () => {
  const flags = parseHelpFlags(SYNTHETIC_HELP);
  assert.deepEqual([...flags].sort(), ['--add-dir', '--allowed-tools', '--allowedTools', '--forward-subagent-text', '--max-budget-usd', '--no-session-persistence', '--print', '--version', '-p', '-v'].sort());
  assert.equal(flags.has('--not-a-flag-on-a-wrapped-line'), false);
  assert.equal(parseHelpFlags('').size, 0);
  assert.equal(parseHelpFlags(null).size, 0);
});

test('missingFlags names each missing flag once, in order, and ignores the prompt and option values', () => {
  const flags = new Set(['-p', '--model']);
  assert.deepEqual(missingFlags(['-p', 'a prompt', '--model', 'm', '--max-budget-usd', '3.00', '--tools', '', '--max-budget-usd', '1.00'], flags), ['--max-budget-usd', '--tools']);
  assert.deepEqual(missingFlags(['-p', 'x'], ['-p']), []);
  assert.deepEqual(missingFlags(null, flags), []);
});

test('REQUIRED_FLAGS is exactly the set of flags buildArgs can produce', () => {
  const produced = new Set();
  for (const tools of [C.TOOLS, [], ['Read']]) {
    for (const promptVia of ['argv', 'stdin']) {
      for (const arg of buildArgs({ prompt: 'p', model: C.DEFAULT_MODEL, effort: C.DEFAULT_EFFORT, tools, promptVia })) if (/^--?[A-Za-z]/.test(arg)) produced.add(arg);
    }
  }
  assert.deepEqual([...produced].sort(), [...REQUIRED_FLAGS].sort());
});

test('readHelpFlags runs claude --help once per binary path and version, and never caches a failure', async t => {
  const dir = tempDir(t);
  const log = path.join(dir, 'argv.log');
  const env = { ...cleanEnv(), FINANCE_STUB_ARGV_LOG: log };
  const cache = new Map();
  const first = await readHelpFlags({ bin: STUB, version: '0.0.0-stub', env, cache });
  assert.equal(first.ok, true);
  assert.deepEqual(missingFlags(REQUIRED_FLAGS, first.flags), []);
  assert.deepEqual(await readHelpFlags({ bin: STUB, version: '0.0.0-stub', env, cache }), first);
  assert.equal(readJsonLines(log).length, 1, 'the second answer came from the cache');
  await readHelpFlags({ bin: STUB, version: '0.0.1-stub', env, cache });
  assert.equal(readJsonLines(log).length, 2, 'a new version is asked again');
  assert.deepEqual(readJsonLines(log), [['--help'], ['--help']]);
  const missing = path.join(dir, 'no-such-claude');
  const failed = await readHelpFlags({ bin: missing, version: 'x', env, cache });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /ENOENT/);
  assert.equal(cache.has(`${missing}\0x`), false);
  const silent = await readHelpFlags({ bin: STUB, version: 'y', env, cache, execFile: async () => ({ stdout: 'no options here\n' }) });
  assert.equal(silent.ok, false);
  assert.match(silent.error, /listed no options/);
});

/* ====================================================================== the pilot environment */

test('pilotEnv moves the configuration folder into the scratch folder, keeps the sign-in where it is, and is pure', t => {
  const scratch = path.join(tempDir(t), '.tmp');
  const parent = { PATH: '/usr/bin', HOME: '/home/synthetic', KEEP: 'me' };
  const env = pilotEnv(parent, scratch);
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    HOME: '/home/synthetic',
    KEEP: 'me',
    TMPDIR: scratch,
    CLAUDE_CODE_TMPDIR: scratch,
    CLAUDE_CONFIG_DIR: path.join(scratch, 'claude-config'),
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  });
  assert.deepEqual(parent, { PATH: '/usr/bin', HOME: '/home/synthetic', KEEP: 'me' }, 'the parent environment is not changed');
  assert.equal(fs.existsSync(scratch), false, 'pilotEnv creates nothing');
  assert.equal(preparePilotConfigDir(scratch), path.join(scratch, 'claude-config'));
  assert.ok(fs.statSync(path.join(scratch, 'claude-config')).isDirectory());
  assert.deepEqual(fs.readdirSync(path.join(scratch, 'claude-config')), [], 'nothing is copied into it');
  assert.throws(() => pilotEnv(parent, 'relative/.tmp'), /absolute/);

  assert.equal(secureStorageDirFor({ HOME: '/h' }), '', 'the default sign-in: empty, as the runtime reads it');
  assert.equal(secureStorageDirFor({ HOME: '/h', CLAUDE_CONFIG_DIR: '/custom/config' }), '/custom/config');
  assert.equal(secureStorageDirFor({ CLAUDE_CONFIG_DIR: '/custom/config', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/store' }), '/store', 'a value the writer set is kept');
  assert.equal(secureStorageDirFor({ CLAUDE_SECURESTORAGE_CONFIG_DIR: '' }), '');
  assert.equal(secureStorageDirFor({ CLAUDE_CONFIG_DIR: '' }), '');

  assert.equal(claudeConfigDirOf({ HOME: '/home/synthetic' }), path.join('/home/synthetic', '.claude'));
  assert.equal(claudeConfigDirOf({ HOME: '/home/synthetic', CLAUDE_CONFIG_DIR: '/custom/config' }), '/custom/config');
  assert.equal(claudeConfigDirOf({ HOME: '/home/synthetic', CLAUDE_CONFIG_DIR: '' }), path.join('/home/synthetic', '.claude'));
  assert.equal(claudeConfigDirOf({}, '/fallback/home'), path.join('/fallback/home', '.claude'));
});

test('under the pilot environment the runtime reads the same sign-in as under the writer\'s own (credentials file and Keychain item)', t => {
  /* The stub computes the credentials folder and the macOS Keychain item name with the rules of the real CLI 2.1.x. */
  const home = tempDir(t);
  const scratch = path.join(tempDir(t), '.tmp');
  preparePilotConfigDir(scratch);
  const base = { PATH: process.env.PATH, HOME: home };
  for (const parent of [
    base,
    { ...base, CLAUDE_CONFIG_DIR: path.join(home, 'custom-config') },
    { ...base, CLAUDE_CONFIG_DIR: path.join(home, 'custom-config'), CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(home, 'store') },
  ]) {
    const own = stubAuth(parent, home).report;
    const pilot = stubAuth(pilotEnv(parent, scratch), home).report;
    assert.equal(pilot.keychainService, own.keychainService, JSON.stringify(parent));
    assert.equal(pilot.credentialsDirectory, own.credentialsDirectory, JSON.stringify(parent));
    assert.equal(pilot.configDirectory, path.join(scratch, 'claude-config'));
    assert.notEqual(own.configDirectory, pilot.configDirectory);
  }
  /* Why the default case passes an empty value: the folder itself, written out, names another Keychain item. */
  const spelledOut = stubAuth({ ...pilotEnv(base, scratch), CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(home, '.claude') }, home).report;
  assert.notEqual(spelledOut.keychainService, stubAuth(base, home).report.keychainService);
  /* Without the variable the moved configuration folder is where the runtime would look for the credentials. */
  const unset = pilotEnv(base, scratch);
  delete unset.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  assert.equal(stubAuth(unset, home).report.credentialsDirectory, path.join(scratch, 'claude-config'));
});

/* ====================================================================== the sign-in check */

test('checkAuth is signed in only on exit 0 with loggedIn true, and keeps no account fields', async t => {
  const dir = tempDir(t);
  const env = mode => ({ ...cleanEnv(), FINANCE_STUB_AUTH: mode });
  const ok = await checkAuth({ bin: STUB, env: env('ok'), cwd: dir });
  assert.equal(ok.signedIn, true);
  assert.equal(ok.loggedIn, true);
  assert.equal(ok.exitCode, 0);
  const out = await checkAuth({ bin: STUB, env: env('logged-out'), cwd: dir });
  assert.deepEqual([out.signedIn, out.loggedIn, out.exitCode], [false, false, 1]);
  const broken = await checkAuth({ bin: STUB, env: env('broken'), cwd: dir });
  assert.deepEqual([broken.signedIn, broken.loggedIn, broken.exitCode], [false, null, 2]);
  assert.match(broken.stderrTail, /stub auth failure/);
  const hung = await checkAuth({ bin: STUB, env: env('hang'), cwd: dir, timeoutMs: 300 });
  assert.equal(hung.signedIn, false);
  assert.match(hung.error, /SIGTERM|stopped|timed out/i);
  const missing = await checkAuth({ bin: path.join(dir, 'no-such-claude'), env: env('ok'), cwd: dir });
  assert.equal(missing.signedIn, false);
  assert.match(missing.error, /ENOENT/);
  /* a zero exit without loggedIn: true is not signed in, and account fields are dropped */
  const fake = stdout => async () => ({ code: 0, signal: null, stdout, stderr: '', error: null });
  assert.equal((await checkAuth({ bin: 'x', run: fake('{"loggedIn": "yes"}') })).signedIn, false);
  const report = await checkAuth({ bin: 'x', run: fake(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'someone@example.invalid', orgName: 'Synthetic Org', orgId: 'o-1' })) });
  assert.equal(report.signedIn, true);
  assert.equal(JSON.stringify(report).includes('example.invalid'), false);
  assert.equal(JSON.stringify(report).includes('Synthetic Org'), false);
});

/* ====================================================================== the pre-flight at launch */

test('a launch runs claude --help and claude auth status first, under exactly the pilot environment, then the pilot', async t => {
  const w = makeWorld(t, { resultText: 'Usable cash is 1,250. Hold.' });
  const id = await approvedRound(w);
  await w.service.launchRound(id);
  await w.service.whenSettled(id);
  const calls = readJsonLines(w.logs.argv).filter(args => args[0] !== '--version');
  assert.deepEqual(calls.map(args => (args.includes('-p') ? 'run' : args.join(' '))), ['--help', 'auth status --json', 'run']);
  const [auth] = readJsonLines(w.logs.auth);
  const [pilot] = readJsonLines(w.logs.env);
  const preflight = path.dirname(auth.TMPDIR);
  assert.equal(path.dirname(preflight), w.tmpRoot);
  assert.match(path.basename(preflight), /^finance-studio-preflight-/);
  assert.equal(auth.cwd, preflight);
  assert.equal(auth.configDirExists, true, 'the configuration folder exists when the check runs');
  const pilotFolder = path.join(w.pilots, `${id}-1`);
  const normalise = (facts, folder) => JSON.parse(JSON.stringify(facts).split(folder).join('<folder>'));
  const authFacts = { ...auth };
  delete authFacts.argv;
  delete authFacts.configDirExists;
  assert.deepEqual(normalise(authFacts, preflight), normalise(pilot, pilotFolder), 'the same variables, folder for folder');
  assert.equal(auth.CLAUDE_CONFIG_DIR, path.join(preflight, '.tmp', 'claude-config'));
  assert.equal(auth.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  assert.deepEqual(preflightFolders(w), [], 'the throwaway folder is removed');
  assert.equal((await w.service.getRound(id)).runs[0].state, 'completed');
  /* claude --help is read once per binary and version: a second launch asks only for the sign-in */
  const again = await approvedRound(w);
  await w.service.launchRound(again);
  await w.service.whenSettled(again);
  assert.equal(readJsonLines(w.logs.argv).filter(args => args[0] === '--help').length, 1);
  assert.equal(readJsonLines(w.logs.auth).length, 2);
});

test('a runtime that does not list a flag the launch needs is refused, naming the flag, and nothing starts', async t => {
  const w = makeWorld(t, { resultText: 'x' }, { FINANCE_STUB_HELP_DROP: '--max-budget-usd' });
  const id = await approvedRound(w);
  await rejects(w.service.launchRound(id), 409, /does not list --max-budget-usd in claude --help.*Nothing was started/);
  assert.equal((await w.service.getRound(id)).status, 'approved');
  assert.deepEqual((await w.service.getRound(id)).runs, []);
  assert.equal(promptRuns(w.logs.argv).length, 0);
  assert.equal(readJsonLines(w.logs.auth).length, 0, 'the sign-in check is not reached');
  assert.equal(fs.existsSync(w.pilots), false);
  /* two missing flags are both named */
  const two = makeWorld(t, {}, { FINANCE_STUB_HELP_DROP: '--strict-mcp-config,--setting-sources' });
  await rejects(two.service.launchRound(await approvedRound(two)), 409, /--strict-mcp-config, --setting-sources/);
  /* the stdin-only flag is not needed for a launch that passes the prompt as an argument */
  const noStdin = makeWorld(t, { resultText: 'Usable cash is 1,250. Hold.' }, { FINANCE_STUB_HELP_DROP: '--input-format' });
  const ok = await approvedRound(noStdin);
  await noStdin.service.launchRound(ok);
  await noStdin.service.whenSettled(ok);
  assert.equal((await noStdin.service.getRound(ok)).runs[0].state, 'completed');
});

test('a runtime that is not signed in under the pilot environment is refused before anything starts', async t => {
  for (const [mode, pattern] of [['logged-out', /claude auth status says it is not signed in/], ['broken', /could not be read \(exit code 2: stub auth failure\)/]]) {
    const w = makeWorld(t, { resultText: 'x' }, { FINANCE_STUB_AUTH: mode });
    const id = await approvedRound(w);
    await rejects(w.service.launchRound(id), 409, pattern);
    await rejects(w.service.launchRound(id), 409, /Run claude in your own terminal and sign in.*Nothing was started/);
    const round = await w.service.getRound(id);
    assert.equal(round.status, 'approved', mode);
    assert.deepEqual(round.runs, []);
    assert.equal(promptRuns(w.logs.argv).length, 0, mode);
    assert.equal(fs.existsSync(w.pilots), false, mode);
    assert.deepEqual(preflightFolders(w), [], mode);
    /* the tool-less runs are checked the same way */
    await rejects(w.service.graderSim({ guidelineText: 'g', answerText: 'a' }), 409, /not ready for a pilot/);
    await rejects(w.service.authorReview({ packageText: 'p' }), 409, /not ready for a pilot/);
    assert.equal(promptRuns(w.logs.argv).length, 0, mode);
  }
});

test('with the sign-in kept in a credentials file, the pilot finds it through the pilot environment and nothing is copied', async t => {
  const original = tempDir(t, 'finance-preflight-writer-config-');
  fs.writeFileSync(path.join(original, '.credentials.json'), '{"synthetic": "not a real sign-in"}\n');
  const w = makeWorld(t, { resultText: 'Usable cash is 1,250. Hold.' }, { FINANCE_STUB_AUTH: 'file', CLAUDE_CONFIG_DIR: original });
  delete w.env.CLAUDE_SECURESTORAGE_CONFIG_DIR; /* the service holds this same object */
  const id = await approvedRound(w);
  await w.service.launchRound(id);
  await w.service.whenSettled(id);
  const run = await w.service.getRun(id, 1);
  assert.equal(run.state, 'completed');
  assert.equal(readJsonLines(w.logs.auth)[0].CLAUDE_SECURESTORAGE_CONFIG_DIR, original);
  const folder = path.join(w.pilots, `${id}-1`);
  const copies = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (entry.name === '.credentials.json') copies.push(full); } };
  walk(folder);
  assert.deepEqual(copies, []);
  assert.deepEqual(fs.readdirSync(original), ['.credentials.json'], 'the writer\'s folder is untouched');
  /* without CLAUDE_SECURESTORAGE_CONFIG_DIR the moved configuration folder hides the sign-in */
  const scratch = path.join(tempDir(t), '.tmp');
  preparePilotConfigDir(scratch);
  const hidden = pilotEnv(w.env, scratch);
  delete hidden.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  assert.equal((await checkAuth({ bin: STUB, env: hidden, cwd: scratch })).signedIn, false);
  assert.equal((await checkAuth({ bin: STUB, env: pilotEnv(w.env, scratch), cwd: scratch })).signedIn, true);
});

/* ====================================================================== scripts/live-smoke.cjs */

test('live-smoke: S1 to S4 need the explicit approval flag; the options are checked', () => {
  assert.deepEqual(smoke.parseOptions([]), { stages: ['S0'], approved: false, promptVia: 'argv', keep: false, help: false });
  assert.deepEqual(smoke.parseOptions(['--stage', 'S1']).approved, false);
  assert.deepEqual(smoke.parseOptions(['--stage', 'S4']).stages, ['S4']);
  assert.deepEqual(smoke.parseOptions(['--stage', 'all', '--i-approve-model-calls', '--prompt-via', 'stdin']), { stages: ['S0', 'S1', 'S2', 'S3', 'S4'], approved: true, promptVia: 'stdin', keep: false, help: false });
  assert.equal(smoke.APPROVE_FLAG, '--i-approve-model-calls');
  assert.match(smoke.parseOptions(['--stage', 'S9']).error, /Unknown stage/);
  assert.match(smoke.parseOptions(['--prompt-via', 'file']).error, /argv or stdin/);
  assert.match(smoke.parseOptions(['--yes']).error, /Unknown option/);
});

test('live-smoke: the S1 command is one tool-less haiku call at low effort with a 0.05 cap; S2 cats a large file and starts sleep 900', t => {
  const args = smoke.s1Args();
  const at = name => args[args.indexOf(name) + 1];
  assert.equal(at('--model'), 'claude-haiku-5-5');
  assert.equal(at('--effort'), 'low');
  assert.equal(at('--max-budget-usd'), '0.05');
  assert.equal(at('--tools'), '');
  assert.equal(args.includes('--allowedTools'), false);
  assert.match(args[1], /one word/);
  assert.deepEqual(smoke.s1Args('stdin').slice(-2), ['--input-format', 'text']);
  const line = smoke.describeCommand('/opt/claude', args, { CLAUDE_CONFIG_DIR: '/tmp/x/.tmp/claude-config', CLAUDE_SECURESTORAGE_CONFIG_DIR: '', OTHER: 'hidden' }, '/tmp/x');
  assert.match(line, /^cd \/tmp\/x && CLAUDE_CONFIG_DIR=\/tmp\/x\/\.tmp\/claude-config CLAUDE_SECURESTORAGE_CONFIG_DIR='' \/opt\/claude -p 'Reply with exactly one word/);
  assert.match(line, /--max-budget-usd 0\.05/);
  assert.match(line, /--setting-sources '' /);
  assert.equal(line.includes('hidden'), false);
  assert.match(smoke.s2Prompt(), /cat filesystem\/Ledger_Extract\.txt/);
  assert.match(smoke.s2Prompt(), /sleep 900 &/);
  const file = path.join(tempDir(t), 'big.txt');
  const lines = smoke.writeSyntheticFile(file);
  const size = fs.statSync(file).size;
  assert.ok(size >= smoke.S2_BYTES && size < smoke.S2_BYTES + 200, String(size));
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, lines);
});

test('live-smoke: the S2 checks find the spill inside the folder, entries under the writer\'s folder, credentials and sleepers', t => {
  const folder = tempDir(t);
  assert.deepEqual(smoke.findSpillFiles(folder), []);
  const results = path.join(folder, '.tmp', 'claude-config', 'projects', '-tmp-x', 'session', 'tool-results');
  fs.mkdirSync(results, { recursive: true });
  fs.writeFileSync(path.join(results, 'toolu_1.txt'), 'large');
  fs.writeFileSync(path.join(folder, '.tmp', 'claude-config', 'projects', '-tmp-x', 'session', 'other.txt'), 'not a spill');
  assert.deepEqual(smoke.findSpillFiles(folder), [path.join(results, 'toolu_1.txt')]);

  const original = tempDir(t);
  assert.deepEqual(smoke.writerProjectEntries(original, folder), []);
  const key = folder.replace(/[/_]/g, '-');
  fs.mkdirSync(path.join(original, 'projects', key), { recursive: true });
  assert.deepEqual(smoke.writerProjectEntries(original, folder), [path.join(original, 'projects', key)]);

  assert.deepEqual(smoke.credentialFilesUnder(folder), []);
  fs.writeFileSync(path.join(folder, '.tmp', '.credentials.json'), '{}');
  assert.deepEqual(smoke.credentialFilesUnder(folder), [path.join(folder, '.tmp', '.credentials.json')]);

  assert.deepEqual(smoke.sleepersFrom('  12 sleep 900\n 13 /usr/bin/sleep 900\n 14 sleep 9000\n 15 bash -c sleep 900 &\n 16 sleep 90\n'), [12, 13]);
});

function runSmokeS0(t, extraEnv) {
  const dir = tempDir(t, 'finance-preflight-smoke-');
  const original = path.join(dir, 'writer-config');
  const scratchRoot = path.join(dir, 'tmp');
  fs.mkdirSync(original);
  fs.mkdirSync(scratchRoot);
  const argvLog = path.join(dir, 'argv.log');
  const result = childProcess.spawnSync(process.execPath, [SMOKE], {
    env: { ...cleanEnv(), CLAUDE_BIN: STUB, CLAUDE_CONFIG_DIR: original, TMPDIR: scratchRoot, FINANCE_STUB_ARGV_LOG: argvLog, FINANCE_STUB_SCENARIO: '', ...extraEnv },
    encoding: 'utf8',
    timeout: 60000,
  });
  return { ...result, argv: readJsonLines(argvLog), leftovers: fs.readdirSync(scratchRoot), original };
}

test('live-smoke S0 against the stub: a PASS table, no prompt run, nothing left behind', t => {
  const run = runSmokeS0(t, {});
  assert.equal(run.status, 0, run.stdout + run.stderr);
  for (const check of ['claude found and reports a version', 'claude --help lists every flag the Studio passes', 'auth status, the pilot environment', 'the runtime uses the pilot configuration folder', 'no credentials file in the pilot folder', 'nothing under your configuration folder for it']) {
    assert.match(run.stdout, new RegExp(`S0\\s+${check.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+PASS`), check);
  }
  assert.match(run.stdout, /PASS: every check passed/);
  assert.equal(run.argv.some(args => args.includes('-p')), false, 'S0 never starts a run');
  assert.deepEqual(run.leftovers, [], 'the scratch folder is removed');
  assert.deepEqual(fs.readdirSync(run.original), [], 'nothing was written into the writer\'s folder');
});

test('live-smoke S0 against the stub: a missing flag or a missing sign-in is a FAIL row and exit code 1', t => {
  const old = runSmokeS0(t, { FINANCE_STUB_HELP_DROP: '--max-budget-usd' });
  assert.equal(old.status, 1);
  assert.match(old.stdout, /claude --help lists every flag the Studio passes\s+FAIL\s+missing: --max-budget-usd/);
  const out = runSmokeS0(t, { FINANCE_STUB_AUTH: 'logged-out' });
  assert.equal(out.status, 1);
  assert.match(out.stdout, /auth status, the pilot environment\s+FAIL\s+loggedIn=false/);
  assert.match(out.stdout, /FAIL: \d+ of \d+ checks failed/);
});

/* ====================================================================== scripts/live-smoke.cjs, stage S4 (file tools) */

const TOKEN = 'synthetic-pilot-token-0123456789-abcdefghij-KLMNOP'; /* not a real token shape; long enough to be one */
const PT_REDACTED = require('../backend/agents/pilot-token.cjs').REDACTED;
const S4_STAGE = ['--stage', 'S4', smoke.APPROVE_FLAG];
const S4_TOOL_ROWS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'].map(tool => `${tool} call in the live stream`);
const OUTSIDE_ROW = 'the outside Read was flagged and the run is DISCARDED';
const IN_FOLDER_ROW = 'the audit found no violation for the in-folder calls';
const MARKER_ROW = 'the canary marker in the pilot\'s final text';

/* The table of a smoke run as { check -> { stage, result, detail } }. */
function tableRows(stdout) {
  const rows = new Map();
  for (const line of String(stdout).split('\n')) {
    const match = /^(S\d)\s+(.+?)\s{2,}(PASS|FAIL|INFO)\s*(.*)$/.exec(line);
    if (match) rows.set(match[2], { stage: match[1], result: match[3], detail: match[4] });
  }
  return rows;
}

/* Runs scripts/live-smoke.cjs against the stub with `scenario`. The raw stream S4 keeps goes to <dir>/raw (the test's own
   folder, never the project's private/). `home` (optional) is the account's home folder for the run; the scratch folder is
   then inside it. */
function runSmokeS4(t, scenario, { args = S4_STAGE, env = {}, home = false } = {}) {
  const dir = tempDir(t, 'finance-preflight-s4-');
  const homeDir = home ? path.join(dir, 'home') : null;
  const top = homeDir || dir;
  const original = path.join(top, 'writer-config');
  const scratchRoot = path.join(top, 'tmp');
  const rawDir = path.join(dir, 'raw');
  for (const folder of [original, scratchRoot]) fs.mkdirSync(folder, { recursive: true });
  const argvLog = path.join(dir, 'argv.log');
  const result = childProcess.spawnSync(process.execPath, [SMOKE, ...args], {
    env: {
      ...cleanEnv(), CLAUDE_BIN: STUB, CLAUDE_CONFIG_DIR: original, TMPDIR: scratchRoot, FINANCE_STUB_ARGV_LOG: argvLog,
      FINANCE_STUB_SCENARIO: JSON.stringify(scenario), [smoke.RAW_DIR_ENV]: rawDir, ...(homeDir ? { HOME: homeDir } : {}), ...env,
    },
    encoding: 'utf8',
    timeout: 120000,
  });
  const raw = fs.existsSync(rawDir) ? fs.readdirSync(rawDir).sort().map(name => path.join(rawDir, name)) : [];
  return { ...result, rows: tableRows(result.stdout), argv: readJsonLines(argvLog), leftovers: fs.readdirSync(scratchRoot), rawDir, raw, homeDir };
}

const pilotArgs = run => promptRuns(path.join(path.dirname(run.rawDir), 'argv.log'))[0];

test('live-smoke S4: it is in `all` after S3, the usage names it, and it runs under S2\'s model and spending cap', () => {
  const stages = smoke.parseOptions(['--stage', 'all']).stages;
  assert.deepEqual(stages.slice(-2), ['S3', 'S4']);
  const lines = [];
  return smoke.main(['--help'], line => lines.push(line)).then(code => {
    assert.equal(code, 0);
    assert.match(lines.join('\n'), /--stage S0\|S1\|S2\|S3\|S4\|all/);
    assert.match(lines.join('\n'), /Exit code: 0 every check passed, 1 a check failed, 2 a stage was refused or the options were wrong, 3 nothing failed but a pilot declined \(S3: it made no tool call; S4: no outside read\)/);
    assert.equal(smoke.EXIT_NOT_EXERCISED, 3);
    assert.equal(smoke.S4_MODEL, smoke.S2_MODEL);
    assert.equal(smoke.S4_BUDGET_USD, smoke.S2_BUDGET_USD);
    assert.deepEqual(smoke.S4_TOOLS, ['Read', 'Write', 'Edit', 'Glob', 'Grep']);
  });
});

test('live-smoke S4: the prompt names the five tools and the outside read in order, and ends with the reply DONE', () => {
  const prompt = smoke.s4Prompt('/somewhere/else/canary.txt');
  const at = text => { const index = prompt.indexOf(text); assert.ok(index >= 0, text); return index; };
  const order = [at('Read tool on ./filesystem/a.txt'), at('Write tool to create ./outputs/b.txt'), at('Edit tool to change that line in ./outputs/b.txt'), at('Glob tool for ./filesystem/*.txt'), at(`Grep tool to search ./filesystem for the word: ${smoke.S4_WORD}`), at('Read tool on this absolute path: /somewhere/else/canary.txt'), at('sanctioned test file'), at('Reply with the single word DONE')];
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the steps come in the order the task gives');
  assert.equal(prompt.startsWith('-'), false, 'buildArgs refuses a prompt that starts with a dash');
  assert.doesNotThrow(() => buildArgs({ prompt, model: smoke.S4_MODEL, effort: 'low', tools: C.TOOLS.slice(), maxBudgetUsd: smoke.S4_BUDGET_USD }));
  const canary = smoke.makeCanary();
  try {
    assert.match(canary.marker, /^S4-CANARY-[0-9a-f]{16}$/);
    assert.equal(fs.readFileSync(canary.file, 'utf8').includes(canary.marker), true);
    assert.equal(path.dirname(canary.file).startsWith(os.tmpdir()), true);
  } finally {
    fs.rmSync(canary.dir, { recursive: true, force: true });
  }
});

test('live-smoke S4 refuses without --i-approve-model-calls: the exact command is printed, no run starts, nothing is kept', t => {
  const run = runSmokeS4(t, { fileTools: true }, { args: ['--stage', 'S4'] });
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stdout, /Refusing S4: it calls a model\. Add --i-approve-model-calls to run it\./);
  assert.match(run.stdout, /S4 command \(one pilot, synthetic packet with a\.txt, canary outside the pilot folder at /);
  assert.match(run.stdout, /--model claude-haiku-5-5 --effort low .*--max-budget-usd 0\.50/);
  assert.match(run.stdout, /--tools Bash,Read,Write,Edit,Glob,Grep/);
  assert.match(run.stdout, /Use your Read tool on this absolute path: \S*finance-studio-smoke-s4-canary-\S+\/canary\.txt/);
  assert.equal(run.argv.some(args => args.includes('-p')), false, 'no model run started');
  assert.deepEqual(run.raw, [], 'nothing was saved');
  assert.deepEqual(run.leftovers, [], 'the scratch folders and the canary folder are removed');
  assert.equal(run.rows.size, 0, 'no table: nothing was checked');
  /* `all` without the flag: every model stage refuses, S4 after S3, and nothing runs */
  const all = runSmokeS4(t, { fileTools: true }, { args: ['--stage', 'all'] });
  assert.equal(all.status, 2, all.stdout + all.stderr);
  for (const stage of ['S1', 'S2', 'S4']) assert.match(all.stdout, new RegExp(`Refusing ${stage}: it calls a model`));
  assert.match(all.stdout, /Refusing S3: it needs a pilot token/);
  assert.ok(all.stdout.indexOf('Refusing S3') < all.stdout.indexOf('S4 command ('), 'S4 comes after S3');
  assert.equal(all.argv.some(args => args.includes('-p')), false);
  assert.deepEqual(all.raw, []);
});

test('live-smoke S4 against the stub: every file tool is seen with its input keys, the in-folder calls are clean, the outside Read is flagged and the run DISCARDED', t => {
  const run = runSmokeS4(t, { fileTools: true });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const expectKeys = { Read: 'file_path', Write: 'content, file_path', Edit: 'file_path, new_string, old_string, replace_all', Glob: 'path, pattern', Grep: 'output_mode, path, pattern' };
  for (const [index, tool] of Object.keys(expectKeys).entries()) {
    const row = run.rows.get(S4_TOOL_ROWS[index]);
    assert.equal(row.result, 'PASS', tool);
    assert.match(row.detail, new RegExp(`^${tool === 'Read' ? '2 calls' : '1 call'} seen; input keys: ${expectKeys[tool]}$`), tool);
  }
  assert.equal(run.rows.get('every tool_use block is one the parser extracts').result, 'PASS');
  assert.equal(run.rows.get('the run completed').result, 'PASS');
  assert.equal(run.rows.get(IN_FOLDER_ROW).result, 'PASS');
  assert.equal(run.rows.get(OUTSIDE_ROW).result, 'PASS');
  assert.match(run.rows.get(OUTSIDE_ROW).detail, /^DISCARDED; 1 violation names the canary \(.+\); the call was a Read$/);
  assert.equal(run.rows.get(MARKER_ROW).result, 'INFO');
  assert.match(run.rows.get(MARKER_ROW).detail, /^no; in a tool result: yes/);
  assert.equal(run.rows.get('the cost stayed under the cap').result, 'PASS');
  assert.match(run.stdout, /\nPASS: every check passed\n/);
  assert.doesNotMatch(run.stdout, /not exercised/, 'a run that exercised the outside read carries no caveat');
  /* key names only: no value of any input reaches the table */
  for (const secretValue of [smoke.S4_WORD, 'first version', 'second version', 'stub note']) assert.equal(run.stdout.split('\n').filter(line => /^S4\s/.test(line)).some(line => line.includes(secretValue)), false, secretValue);
  /* the same model, effort, tools and spending cap as S2 */
  const args = pilotArgs(run);
  const at = name => args[args.indexOf(name) + 1];
  assert.equal(at('--model'), smoke.S2_MODEL);
  assert.equal(at('--effort'), 'low');
  assert.equal(at('--max-budget-usd'), smoke.S2_BUDGET_USD.toFixed(2));
  assert.equal(at('--tools'), 'Bash,Read,Write,Edit,Glob,Grep');
  assert.match(args[1], /Use your Read tool on this absolute path: \S+\/canary\.txt/);
  /* the raw stream is kept, the rest is removed */
  assert.equal(run.raw.length, 1);
  assert.match(path.basename(run.raw[0]), /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-s4\.jsonl$/);
  assert.ok(run.stdout.includes(`S4 raw stream saved: ${run.raw[0]}`), 'the path is printed');
  assert.match(run.rows.get('the raw stream was saved').detail, new RegExp(`^${run.raw[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\d+ lines`));
  if (process.platform !== 'win32') assert.equal(fs.statSync(run.raw[0]).mode & 0o777, 0o600);
  const events = fs.readFileSync(run.raw[0], 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const uses = events.filter(event => event.type === 'assistant').flatMap(event => event.message.content).filter(block => block.type === 'tool_use');
  assert.deepEqual(uses.map(block => block.name), ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Read']);
  assert.match(uses[5].input.file_path, /finance-studio-smoke-s4-canary-[^/]+\/canary\.txt$/, 'the raw stream holds the outside read');
  assert.deepEqual(run.leftovers, [], 'the scratch folders and the canary folder are removed');
});

test('live-smoke S4 against the stub: a pilot that declines the outside read is an INFO row, and the run ends "PASS, but ..." with exit code 3, not 0', t => {
  const run = runSmokeS4(t, { fileTools: { outside: 'decline' } });
  assert.equal(run.status, 3, run.stdout + run.stderr);
  for (const row of S4_TOOL_ROWS) assert.equal(run.rows.get(row).result, 'PASS', row);
  assert.match(run.rows.get('Read call in the live stream').detail, /^1 call seen; input keys: file_path$/);
  assert.equal(run.rows.get(IN_FOLDER_ROW).result, 'PASS');
  assert.equal(run.rows.get(IN_FOLDER_ROW).detail, 'no violations');
  assert.deepEqual(run.rows.get(OUTSIDE_ROW), { stage: 'S4', result: 'INFO', detail: 'the pilot declined the outside read; outside detection was not exercised' });
  assert.match(run.rows.get(MARKER_ROW).detail, /^no; in a tool result: no$/);
  assert.match(run.stdout, /\nPASS, but outside-read detection was not exercised: run S4 again\n*$/, 'the last line says what the run did not show');
  assert.doesNotMatch(run.stdout, /every check passed/, 'a skimmed result cannot read as proof that outside reads are caught');
  assert.equal(run.raw.length, 1);
  assert.equal(run.rows.get('the raw stream was saved').result, 'INFO');
});

test('live-smoke S4 against the stub: a tool that never shows up in the stream is a FAIL row that names what was called', t => {
  const edit = runSmokeS4(t, { fileTools: { skip: ['Edit'] } });
  assert.equal(edit.status, 1, edit.stdout + edit.stderr);
  assert.deepEqual(edit.rows.get('Edit call in the live stream'), { stage: 'S4', result: 'FAIL', detail: 'none seen; tools called in the stream: Read, Write, Glob, Grep' });
  for (const row of S4_TOOL_ROWS.filter(row => !row.startsWith('Edit'))) assert.equal(edit.rows.get(row).result, 'PASS', row);
  assert.equal(edit.rows.get(OUTSIDE_ROW).result, 'PASS', 'the other findings stand');
  assert.match(edit.stdout, /FAIL: 1 of \d+ checks failed/);
  /* no Read at all: its row fails, and with no outside read either the outside row cannot say anything */
  const read = runSmokeS4(t, { fileTools: { skip: ['Read'] } });
  assert.equal(read.status, 1, read.stdout + read.stderr);
  assert.equal(read.rows.get('Read call in the live stream').result, 'FAIL');
  assert.equal(read.rows.get(OUTSIDE_ROW).result, 'INFO');
  assert.match(read.stdout, /\nFAIL: 1 of \d+ checks failed\nAlso: outside-read detection was not exercised: run S4 again\n*$/, 'a failure wins over the caveat, which is still said');
  assert.doesNotMatch(read.stdout, /PASS, but/);
  /* a run that made no tool call at all */
  const none = runSmokeS4(t, { resultText: 'DONE' });
  assert.equal(none.status, 1, none.stdout + none.stderr);
  for (const row of S4_TOOL_ROWS) assert.equal(none.rows.get(row).result, 'FAIL', row);
  assert.equal(none.rows.get('Grep call in the live stream').detail, 'none seen; tools called in the stream: none');
  assert.equal(none.rows.get('every tool_use block is one the parser extracts').result, 'FAIL');
  assert.equal(none.rows.get(OUTSIDE_ROW).result, 'INFO');
  assert.equal(none.status, 1, 'exit 1 (a failed check), not 3');
});

test('live-smoke S4 against the stub: the marker in the final text is reported when the pilot repeats it', t => {
  const run = runSmokeS4(t, { fileTools: { quoteOutside: true } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(run.rows.get(MARKER_ROW).result, 'INFO');
  assert.match(run.rows.get(MARKER_ROW).detail, /^yes; in a tool result: yes/);
  assert.equal(run.rows.get(OUTSIDE_ROW).result, 'PASS');
});

test('live-smoke S4 against the stub: a violation that is not the canary read fails the in-folder row, and the saved stream holds no token and no home folder', t => {
  const printenv = { name: 'Bash', input: { command: 'printenv CLAUDE_CODE_OAUTH_TOKEN' }, result: TOKEN };
  const run = runSmokeS4(t, { fileTools: true, toolUses: [printenv] }, { env: { FINANCE_STUB_AUTH: 'token', FINANCE_STUDIO_PILOT_TOKEN: TOKEN }, home: true });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.equal(run.rows.get(IN_FOLDER_ROW).result, 'FAIL');
  assert.match(run.rows.get(IN_FOLDER_ROW).detail, /Bash /, 'the violation is named');
  assert.equal(run.rows.get(OUTSIDE_ROW).result, 'PASS', 'the canary read is still judged on its own');
  assert.ok(!(run.stdout + run.stderr).includes(TOKEN), 'the token is never printed');
  assert.equal(run.raw.length, 1);
  const saved = fs.readFileSync(run.raw[0], 'utf8');
  assert.ok(!saved.includes(TOKEN), 'the token is redacted in the saved stream');
  assert.ok(saved.includes(PT_REDACTED), 'the marker stands where it was');
  assert.ok(!saved.includes(run.homeDir), 'the home folder is written as ~');
  assert.match(saved, /"cwd":"~\/tmp\/finance-studio-smoke-s4-/);
  assert.ok(!run.stdout.includes('(redacted)'), 'no stray placeholder in the table');
});

/* ---- the verdicts as a pure function: the cases a stub run cannot produce */

const useEvent = (id, name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id, name, input }] } });
const resultEvent = (id, content) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const MARKER = 'S4-CANARY-0123456789abcdef';
const CLEAN = { status: 'CLEAN', violations: [], notes: [] };
const FOLDER_CALLS = [
  useEvent('t1', 'Read', { file_path: '/p/filesystem/a.txt' }),
  useEvent('t2', 'Write', { file_path: '/p/outputs/b.txt', content: 'SECRET-CONTENT-VALUE' }),
  useEvent('t3', 'Edit', { file_path: '/p/outputs/b.txt', old_string: 'SECRET-OLD', new_string: 'SECRET-NEW' }),
  useEvent('t4', 'Glob', { pattern: 'filesystem/*.txt' }),
  useEvent('t5', 'Grep', { pattern: 'SECRET-WORD', path: '/p/filesystem' }),
];

/* addS4Rows over `events` (a list, or a function of the canary) and `audit` (an object, or a function of the canary). */
function judge(t, { events, audit, finalText = 'DONE', rawText = null }) {
  const dir = tempDir(t, 'finance-preflight-canary-');
  const canary = { dir, file: path.join(dir, 'canary.txt'), marker: MARKER };
  fs.writeFileSync(canary.file, `Marker: ${MARKER}\n`);
  const list = typeof events === 'function' ? events(canary) : events;
  const report = smoke.makeReport(() => {});
  smoke.addS4Rows(report, { events: list, rawText: rawText === null ? list.map(event => JSON.stringify(event)).join('\n') : rawText, audit: typeof audit === 'function' ? audit(canary) : audit, finalText, canary });
  return { canary, report, rows: new Map(report.rows.map(row => [row.check, row])) };
}

const outsideRead = canary => useEvent('t6', 'Read', { file_path: canary.file });
const aboutCanary = (canary, kind) => ({ tool: 'Read', kind, path: canary.file, call: `Read ${JSON.stringify({ file_path: canary.file })}` });

test('live-smoke S4 verdicts: an outside Read that the audit did not flag is a FAIL with the words "the audit missed a live outside Read"', t => {
  const withOutside = canary => [...FOLDER_CALLS, outsideRead(canary), resultEvent('t6', `Marker: ${MARKER}`)];
  /* read, and the audit said CLEAN */
  const clean = judge(t, { events: withOutside, audit: CLEAN });
  assert.equal(clean.rows.get(OUTSIDE_ROW).result, 'FAIL');
  assert.equal(clean.rows.get(OUTSIDE_ROW).detail, 'the audit missed a live outside Read: audit CLEAN, 0 violations, none names the canary; the call carried input keys file_path; the parser extracted it');
  assert.equal(clean.rows.get(IN_FOLDER_ROW).result, 'PASS');
  assert.equal(clean.report.failed(), true);
  /* read, and the run was discarded for something else only */
  const other = { status: 'DISCARDED', violations: [{ tool: 'Bash', kind: 'environ', path: '(printenv)', call: 'printenv X' }], notes: [] };
  const elsewhere = judge(t, { events: withOutside, audit: other });
  assert.match(elsewhere.rows.get(OUTSIDE_ROW).detail, /^the audit missed a live outside Read: audit DISCARDED, 1 violation, none names the canary/);
  assert.equal(elsewhere.rows.get(IN_FOLDER_ROW).result, 'FAIL');
  assert.equal(elsewhere.rows.get(IN_FOLDER_ROW).detail, 'Bash environ (printenv)');
  /* DISCARDED without any violation is not a flag either */
  const bare = judge(t, { events: withOutside, audit: { status: 'DISCARDED', violations: [], notes: [] } });
  assert.match(bare.rows.get(OUTSIDE_ROW).detail, /^the audit missed a live outside Read/);
  /* the marker in the stream with no call that names the canary (a read by a route nobody parsed) */
  const route = judge(t, { events: FOLDER_CALLS, audit: CLEAN, rawText: `{"type":"system"}\n{"type":"weird","text":"Marker: ${MARKER}"}\n` });
  assert.match(route.rows.get(OUTSIDE_ROW).detail, /^the audit missed a live outside Read: the canary marker is in the stream, but no tool call naming the canary was found/);
  /* a read through Bash is an outside access too */
  const bash = judge(t, { events: canary => [...FOLDER_CALLS, useEvent('t6', 'Bash', { command: `cat ${canary.file}` })], audit: CLEAN });
  assert.match(bash.rows.get(OUTSIDE_ROW).detail, /^the audit missed a live outside Bash call/);
  /* no audit at all */
  const none = judge(t, { events: withOutside, audit: null });
  assert.deepEqual([none.rows.get(OUTSIDE_ROW).result, none.rows.get(OUTSIDE_ROW).detail, none.rows.get(IN_FOLDER_ROW).result], ['FAIL', 'no audit', 'FAIL']);
});

test('live-smoke S4 verdicts: a violation that names the canary passes whatever its kind is called; no access to the canary is an INFO row', t => {
  for (const kind of ['abs', 'outside', 'a-kind-another-agent-added']) {
    const run = judge(t, { events: canary => [...FOLDER_CALLS, outsideRead(canary)], audit: canary => ({ status: 'DISCARDED', violations: [aboutCanary(canary, kind)], notes: [] }) });
    assert.equal(run.rows.get(OUTSIDE_ROW).result, 'PASS', kind);
    assert.equal(run.rows.get(OUTSIDE_ROW).detail, `DISCARDED; 1 violation names the canary (${kind}); the call was a Read`);
    assert.equal(run.rows.get(IN_FOLDER_ROW).result, 'PASS', kind);
    assert.equal(run.rows.get(IN_FOLDER_ROW).detail, 'none apart from the 1 violation about the canary');
    assert.equal(run.report.failed(), false, kind);
  }
  /* the audit may name the canary by its real path or only inside the call text */
  const viaCall = judge(t, { events: canary => [...FOLDER_CALLS, outsideRead(canary)], audit: canary => ({ status: 'DISCARDED', violations: [{ tool: 'Read', kind: 'abs', path: '(somewhere)', call: `Read ${JSON.stringify({ file_path: canary.file })}` }], notes: [] }) });
  assert.equal(viaCall.rows.get(OUTSIDE_ROW).result, 'PASS');
  /* the pilot did not touch the canary */
  const declined = judge(t, { events: FOLDER_CALLS, audit: CLEAN, finalText: 'I will not read that file.' });
  assert.deepEqual(declined.rows.get(OUTSIDE_ROW), { stage: 'S4', check: OUTSIDE_ROW, result: 'INFO', detail: 'the pilot declined the outside read; outside detection was not exercised' });
  assert.deepEqual(declined.report.caveats, ['outside-read detection was not exercised: run S4 again'], 'the report remembers it');
  assert.equal(declined.rows.get(IN_FOLDER_ROW).result, 'PASS');
  assert.equal(declined.rows.get(IN_FOLDER_ROW).detail, 'no violations');
  assert.equal(declined.report.failed(), false);
  /* the other outcomes leave no caveat */
  const flaggedRun = judge(t, { events: canary => [...FOLDER_CALLS, outsideRead(canary)], audit: canary => ({ status: 'DISCARDED', violations: [aboutCanary(canary, 'abs')], notes: [] }) });
  assert.deepEqual(flaggedRun.report.caveats, []);
  const missedRun = judge(t, { events: canary => [...FOLDER_CALLS, outsideRead(canary)], audit: CLEAN });
  assert.deepEqual(missedRun.report.caveats, [], 'a miss is a FAIL, not a caveat');
  /* the marker: in the answer, in a tool result, in neither */
  const repeated = judge(t, { events: canary => [...FOLDER_CALLS, outsideRead(canary), resultEvent('t6', `Marker: ${MARKER}`)], audit: canary => ({ status: 'DISCARDED', violations: [aboutCanary(canary, 'abs')], notes: [] }), finalText: `It says ${MARKER}` });
  assert.match(repeated.rows.get(MARKER_ROW).detail, /^yes; in a tool result: yes/);
  const refused = judge(t, { events: canary => [...FOLDER_CALLS, outsideRead(canary), resultEvent('t6', 'Permission to read this file was denied.')], audit: canary => ({ status: 'DISCARDED', violations: [aboutCanary(canary, 'abs')], notes: [] }) });
  assert.equal(refused.rows.get(MARKER_ROW).detail, 'no; in a tool result: no');
  assert.equal(refused.rows.get(OUTSIDE_ROW).result, 'PASS', 'an attempt is flagged even when the runtime refused it');
});

test('live-smoke S4 verdicts: a tool_use block in a shape the parser does not read is its own FAIL, and the calls it hides are not "seen"', t => {
  /* the shape of a partial-message stream: the block sits in a stream_event, not in an assistant message */
  const partial = (id, name, input) => ({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id, name, input } } });
  const run = judge(t, { events: canary => [...FOLDER_CALLS.slice(1), partial('t1', 'Read', { file_path: '/p/filesystem/a.txt' }), partial('t6', 'Read', { file_path: canary.file })], audit: CLEAN });
  assert.equal(run.rows.get('every tool_use block is one the parser extracts').result, 'FAIL');
  assert.equal(run.rows.get('every tool_use block is one the parser extracts').detail, '2 of 6 not extracted (Read): the live event shape differs from what the parser reads');
  assert.deepEqual([run.rows.get('Read call in the live stream').result, run.rows.get('Read call in the live stream').detail], ['FAIL', '2 tool_use blocks named Read in the stream that the parser does not extract (input keys: file_path)']);
  assert.equal(run.rows.get('Write call in the live stream').result, 'PASS');
  assert.match(run.rows.get(OUTSIDE_ROW).detail, /^the audit missed a live outside Read: audit CLEAN, 0 violations, none names the canary; the call carried input keys file_path; the parser did NOT extract it$/);
  /* tools under other names are not the five tools */
  const renamed = judge(t, { events: [useEvent('a', 'View', { path: '/p/filesystem/a.txt' }), useEvent('b', 'Search', { query: 'x' })], audit: CLEAN });
  assert.equal(renamed.rows.get('Read call in the live stream').detail, 'none seen; tools called in the stream: View, Search');
  assert.equal(renamed.rows.get('tool calls the parser extracts').detail, 'View x1, Search x1');
});

test('live-smoke S4 verdicts: the rows name input keys and never show a value of an input', t => {
  const run = judge(t, { events: canary => [...FOLDER_CALLS, outsideRead(canary)], audit: canary => ({ status: 'DISCARDED', violations: [aboutCanary(canary, 'abs')], notes: [] }) });
  assert.equal(run.rows.get('Write call in the live stream').detail, '1 call seen; input keys: content, file_path');
  assert.equal(run.rows.get('Edit call in the live stream').detail, '1 call seen; input keys: file_path, new_string, old_string');
  assert.equal(run.rows.get('Glob call in the live stream').detail, '1 call seen; input keys: pattern');
  const shown = [...run.rows.values()].map(row => row.detail).join('\n');
  for (const value of ['SECRET-CONTENT-VALUE', 'SECRET-OLD', 'SECRET-NEW', 'SECRET-WORD', '/p/filesystem']) assert.equal(shown.includes(value), false, value);
});

test('live-smoke S4: looseToolUses finds a tool_use block wherever it sits, once, and does not read inside an input', () => {
  const nested = { type: 'wrapper', items: [{ deeper: { type: 'tool_use', id: 'x1', name: 'Read', input: { file_path: '/a', also: { type: 'tool_use', id: 'inner', name: 'Write', input: {} } } } }] };
  const found = smoke.looseToolUses([nested, nested, useEvent('x2', 'Grep', { pattern: 'p' }), { type: 'user', message: { content: [{ type: 'tool_result', content: 'tool_use' }] } }]);
  assert.deepEqual(found.map(block => `${block.id}:${block.name}`), ['x1:Read', 'x2:Grep']);
  assert.deepEqual(smoke.looseToolUses(null), []);
  assert.deepEqual(smoke.parseStream('junk\n{"type":"a"}\n\n{"no":"type"}\n[1]\n{"type":"b"'), [{ type: 'a' }], 'only JSON objects with a string type are events');
});

test('live-smoke S4: tildeHome writes the home folder as ~ only as a whole path segment, and saveRawStream redacts the token and keeps the file private', t => {
  assert.equal(smoke.tildeHome('{"cwd":"/Users/ann/work","p":"/Users/annette/x","q":"/Users/ann"}', ['/Users/ann']), '{"cwd":"~/work","p":"/Users/annette/x","q":"~"}');
  assert.equal(smoke.tildeHome('/Users/ann/a and /Users/ann/b', ['/Users/ann/']), '~/a and ~/b', 'a trailing slash on the home folder is ignored');
  assert.equal(smoke.tildeHome('/Users/ann/a', ['/Users/ann', '/Users/ann/deeper']), '~/a', 'the longest folder goes first, so a nested one is not half replaced');
  assert.equal(smoke.tildeHome('/etc/hosts', ['/', '', null, 'relative/home']), '/etc/hosts', 'the filesystem root and non-paths are never a home folder');
  assert.equal(smoke.tildeHome('/root/x', ['/home/a', '/root']), '~/x');

  const dir = path.join(tempDir(t), 'raw');
  const stream = [`{"type":"system","cwd":"/Users/ann/p"}`, `{"type":"user","text":"${TOKEN} and ${JSON.stringify(TOKEN).slice(1, -1)}"}`, ''].join('\n');
  const when = new Date('2026-10-20T08:09:10.123Z');
  const saved = smoke.saveRawStream(stream, { dir, secrets: [TOKEN], homes: ['/Users/ann'], now: when });
  assert.equal(saved.error, null);
  assert.equal(saved.file, path.join(dir, '2026-10-20T08-09-10-123Z-s4.jsonl'));
  assert.equal(saved.lines, 2);
  const text = fs.readFileSync(saved.file, 'utf8');
  assert.ok(!text.includes(TOKEN) && !text.includes('/Users/ann'));
  assert.equal(text, `{"type":"system","cwd":"~/p"}\n{"type":"user","text":"${PT_REDACTED} and ${PT_REDACTED}"}\n`);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(saved.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }
  /* an existing file is never overwritten; an empty stream is not saved */
  const again = smoke.saveRawStream(stream, { dir, secrets: [TOKEN], homes: [], now: when });
  assert.equal(again.file, null);
  assert.match(again.error, /could not save it under .*EEXIST/);
  assert.equal(fs.readFileSync(saved.file, 'utf8'), text);
  assert.deepEqual(smoke.saveRawStream('', { dir }), { file: null, lines: 0, error: 'the round kept no transcript to save' });
  assert.deepEqual(smoke.saveRawStream(null, { dir }), { file: null, lines: 0, error: 'the round kept no transcript to save' });
});

test('live-smoke report: a caveat turns the last line into "PASS, but ..." without failing a check, and a failure still comes first', () => {
  const lines = [];
  const report = smoke.makeReport(line => lines.push(line));
  report.add('T', 'a check', true, 'fine');
  report.print();
  assert.match(lines.join('\n'), /\nPASS: every check passed$/);
  assert.deepEqual(report.caveats, []);
  lines.length = 0;
  report.caveat('something was not exercised: do it again');
  report.caveat('something was not exercised: do it again');
  assert.deepEqual(report.caveats, ['something was not exercised: do it again'], 'said once');
  assert.equal(report.failed(), false);
  report.print();
  assert.match(lines.join('\n'), /\nPASS, but something was not exercised: do it again$/);
  assert.doesNotMatch(lines.join('\n'), /every check passed/);
  lines.length = 0;
  report.add('T', 'a failing check', false, 'broken');
  report.print();
  assert.match(lines.join('\n'), /\nFAIL: 1 of 2 checks failed\nAlso: something was not exercised: do it again$/);
});
