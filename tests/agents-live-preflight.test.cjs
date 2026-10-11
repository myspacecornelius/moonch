'use strict';
/* Tests for the checks made before any agent process starts (claude --help, claude auth status), the pilot environment
   that keeps the runtime's own files inside the pilot folder, and scripts/live-smoke.cjs (stage S0 only, against the
   stub). Every run uses backend/agents/stub-claude.cjs. No model is started and nothing touches the network. All
   fixtures are synthetic and live in temporary folders that are removed afterwards. */

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

test('live-smoke: S1 and S2 need the explicit approval flag; the options are checked', () => {
  assert.deepEqual(smoke.parseOptions([]), { stages: ['S0'], approved: false, promptVia: 'argv', keep: false, help: false });
  assert.deepEqual(smoke.parseOptions(['--stage', 'S1']).approved, false);
  assert.deepEqual(smoke.parseOptions(['--stage', 'all', '--i-approve-model-calls', '--prompt-via', 'stdin']), { stages: ['S0', 'S1', 'S2', 'S3'], approved: true, promptVia: 'stdin', keep: false, help: false });
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
