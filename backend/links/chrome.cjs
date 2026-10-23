'use strict';
/* Starting, supervising and stopping Chrome. Everything about the browser PROCESS lives here; nothing about pages.

   Rules the code follows (each has a test in tests/links-loader.test.cjs or tests/links-browser.cjs):
   - The profile is a dedicated folder, created 0700, never the person's own Chrome profile (Chrome 136 and later ignores the
     remote-debugging switches on the default one). One Chrome per profile (a SingletonLock); a second launch reports PROFILE_IN_USE.
   - CDP only over the pipe (file descriptors 3 and 4). No --remote-debugging-port: a port is reachable by every local process.
   - The link is never on the command line (ps shows argv to every local account): the only positional argument is about:blank and the
     page is opened later with Page.navigate.
   - Chrome gets an ALLOW LIST of environment variables, not the companion's: no API key, token or proxy password reaches a process
     that renders other people's pages. On Linux HOME and XDG_* point inside the profile folder, which also moves the crash handler's
     database (it outlives Chrome and is otherwise written to the real home folder).
   - The product never passes --no-sandbox. A test that runs as root adds it through spawnFn.
   - Downloads start denied (loader.cjs sets that before any page exists), so nothing reaches the person's own Downloads folder.
   - After a load the profile forgets where it has been (History, download database, saved sessions, caches: they hold signed links).
     Cookies and local storage stay, so the sign-in survives. */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Cdp, CdpError, sleep } = require('./cdp.cjs');

/* Where a Chrome or Chromium might be. FINANCE_STUDIO_CHROME and CHROME_BIN win, in that order. */
const BINARY_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];

/* An absolute path to an executable regular file that no other account can write to (a browser binary someone else can replace is a
   program the companion would run for them). */
function usableBinary(file) {
  try {
    if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
    const stat = fs.statSync(file);
    if (!stat.isFile() || (stat.mode & 0o022) !== 0) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch (e) { return false; }
}

function findChromeBinary(env = process.env) {
  for (const candidate of [env.FINANCE_STUDIO_CHROME, env.CHROME_BIN, ...BINARY_CANDIDATES]) if (candidate && usableBinary(candidate)) return candidate;
  return null;
}

const BASE_FLAGS = [
  '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-default-apps', '--disable-background-networking',
  '--disable-component-update', '--disable-breakpad', '--metrics-recording-only', '--noerrdialogs',
  '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,PrivacySandboxSettings4',
  '--restore-last-session',   /* with the seeded preference it keeps session cookies (a login without Max-Age) across a restart, see prepareProfile */
];

function chromeArgs({ profileDir, headless }) {
  const args = [`--user-data-dir=${profileDir}`, '--remote-debugging-pipe', ...BASE_FLAGS, '--window-size=1280,900'];
  if (headless) args.push('--headless=new');
  else args.push('--hide-crash-restore-bubble', '--disable-search-engine-choice-screen');
  if (process.platform === 'linux') args.push('--password-store=basic');   /* never open the desktop keyring */
  args.push('about:blank');
  return args;
}

const ENV_ALLOW = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ', 'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY', '__CF_USER_TEXT_ENCODING'];
function browserEnv(env = process.env, homeDir = null) {
  const out = {};
  for (const name of ENV_ALLOW) if (typeof env[name] === 'string') out[name] = env[name];
  if (process.platform === 'linux') {
    /* A process in the plain "C" locale makes Chrome give up on any non-ASCII download name. */
    if (!/utf-?8/i.test(`${env.LC_ALL || ''}${env.LC_CTYPE || ''}${env.LANG || ''}`)) { out.LC_ALL = 'C.UTF-8'; out.LANG = 'C.UTF-8'; }
    if (homeDir) Object.assign(out, { HOME: homeDir, XDG_CONFIG_HOME: path.join(homeDir, '.config'), XDG_CACHE_HOME: path.join(homeDir, '.cache'), XDG_DATA_HOME: path.join(homeDir, '.local', 'share') });
  }
  return out;
}

/* Make the profile ready. Safe only while no Chrome owns it. The preferences switch the password manager and autofill off (the Studio
   never offers to remember a password) and set "continue where you left off", which keeps session cookies on disk without this code
   ever reading one. The side effect is that Chrome reopens the previous tabs, so the old session files are deleted first. */
function prepareProfile(profileDir) {
  const defaultDir = path.join(profileDir, 'Default');
  fs.mkdirSync(defaultDir, { recursive: true, mode: 0o700 });
  const file = path.join(defaultDir, 'Preferences');
  let prefs = {};
  try { prefs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { prefs = {}; }
  prefs.session = { ...(prefs.session || {}), restore_on_startup: 1 };
  prefs.credentials_enable_service = false;
  prefs.profile = { ...(prefs.profile || {}), password_manager_enabled: false };
  prefs.autofill = { ...(prefs.autofill || {}), profile_enabled: false, credit_card_enabled: false };
  fs.writeFileSync(file, JSON.stringify(prefs), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  fs.rmSync(path.join(defaultDir, 'Sessions'), { recursive: true, force: true });
  for (const name of ['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']) fs.rmSync(path.join(defaultDir, name), { force: true });
}

/* After a run: forget where we have been. Chrome writes every URL it visits, signed download links included (the signature is in the query
   string), to Default/History, to Default/shared_proto_db (its download database), to the saved session files and to a usage-statistics
   database, and it keeps cached copies of responses. Cookies, local storage, IndexedDB and service workers are NOT touched: the sign-in
   lives there. Only call this while no Chrome owns the profile. */
const SCRUB_FILES = ['History', 'History-journal', 'Visited Links', 'Top Sites', 'Top Sites-journal', 'Favicons', 'Favicons-journal', 'Network Action Predictor', 'Shortcuts', 'Shortcuts-journal', 'Web Data', 'Web Data-journal', 'DownloadMetadata'];
const SCRUB_DIRS = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Service Worker/CacheStorage', 'shared_proto_db', 'Download Service', 'Feature Engagement Tracker', 'Sessions', 'optimization_guide_hint_cache_store', 'optimization_guide_model_store'];
const SCRUB_ROOT_DIRS = ['segmentation_platform', 'optimization_guide_model_store', 'GraphiteDawnCache', 'GrShaderCache', 'ShaderCache', 'component_crx_cache'];
function scrubProfile(profileDir) {
  const defaultDir = path.join(profileDir, 'Default');
  for (const name of SCRUB_FILES) fs.rmSync(path.join(defaultDir, name), { force: true });
  for (const name of SCRUB_DIRS) fs.rmSync(path.join(defaultDir, name), { recursive: true, force: true });
  for (const name of SCRUB_ROOT_DIRS) fs.rmSync(path.join(profileDir, name), { recursive: true, force: true });
  for (const name of ['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']) fs.rmSync(path.join(defaultDir, name), { force: true });
}

/* Chrome keeps its profile lock as symlinks in the profile folder. SingletonSocket points into a private folder in the temp directory
   (Linux /tmp/.org.chromium.Chromium.XXXXXX). A clean quit removes that folder, a SIGKILL leaves it. */
const SINGLETON_DIR_RE = /^\.(org\.chromium|com\.google)\.[A-Za-z.]+\.[A-Za-z0-9]{4,}$/;
function singletonFolder(profileDir) {
  try {
    const dir = path.dirname(fs.readlinkSync(path.join(profileDir, 'SingletonSocket')));
    return SINGLETON_DIR_RE.test(path.basename(dir)) && fs.lstatSync(dir).isDirectory() && fs.readdirSync(dir).every((n) => n.startsWith('Singleton')) ? dir : null;
  } catch (e) { return null; }
}

/* ps, because /proc exists on Linux only. Same call on macOS (the column keyword there is `command`). */
function listProcesses() {
  const out = spawnSync('ps', ['-A', '-o', process.platform === 'darwin' ? 'pid=,ppid=,pgid=,stat=,command=' : 'pid=,ppid=,pgid=,stat=,args='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const rows = [];
  for (const line of String(out.stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), state: m[4], cmd: m[5] });
  }
  return rows;
}

/* Processes that belong to one browser: its process group, or ORPHANS (parent pid 1) whose command line carries its profile directory.
   Not "any process that mentions the profile": a second Chrome that tried to open a profile another Chrome owns would otherwise be
   cleaned up by sweeping the first one too. */
function browserProcesses({ pgid, profileDir } = {}) {
  return listProcesses().filter((p) => (pgid && p.pgid === pgid) || (profileDir && p.ppid === 1 && p.cmd.includes(`--user-data-dir=${profileDir}`)));
}

/* Kill a browser for good. Returns the processes that were still alive (not zombies) when it finished, which should be none. */
async function killTree({ pid, profileDir, graceMs = 5000 }) {
  const real = Number.isInteger(pid) && pid > 1;
  if (real) { try { process.kill(-pid, 'SIGKILL'); } catch (e) { try { process.kill(pid, 'SIGKILL'); } catch (e2) { /* already gone */ } } }
  const until = Date.now() + graceMs;
  let alive = [];
  for (;;) {
    alive = browserProcesses({ pgid: real ? pid : 0, profileDir }).filter((p) => !p.state.startsWith('Z') && p.pid !== process.pid);
    if (!alive.length || Date.now() > until) break;
    for (const p of alive) { try { process.kill(p.pid, 'SIGKILL'); } catch (e) { /* gone */ } }
    await sleep(40);
  }
  return alive;
}

/* options: { binary, profileDir, headless, spawnFn (default child_process.spawn), env }
   Returns { cdp, child, pid, profileDir, version, headless, close({ graceful, scrub }), kill(), hasExited(), exited, stderrTail() }. */
async function launchBrowser({ binary, profileDir, headless = true, spawnFn = spawn, env = process.env }) {
  if (!binary) throw new Error('No Chrome or Chromium found. Install Google Chrome, or set FINANCE_STUDIO_CHROME to its path.');
  prepareProfile(profileDir);
  const homeDir = path.join(profileDir, 'home');
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  /* stdio: 0 stdin, 1 stdout (ignored), 2 stderr (a small tail is kept for error messages), 3 = our write end to Chrome's fd 3,
     4 = Chrome's fd 4 to us. detached makes Chrome the leader of its own process group so ONE signal reaches every child. */
  const child = spawnFn(binary, chromeArgs({ profileDir, headless }), { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], detached: true, env: browserEnv(env, homeDir) });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
  let exitInfo = null;
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => { exitInfo = { code, signal }; resolve(exitInfo); }));
  const cdp = new Cdp(child.stdio[3], child.stdio[4]);
  child.once('error', (error) => cdp.fail(new CdpError(`Could not start the browser: ${error.message}`, { code: 'SPAWN' })));

  const handle = {
    cdp, child, pid: child.pid, profileDir, headless, exited,
    stderrTail: () => stderr,
    hasExited: () => exitInfo !== null,
    /* SIGKILL the whole tree, prove nothing is left, and wait until this process has collected the leader's exit and seen the pipe close. */
    async kill() {
      const singleton = handle.singletonDir || singletonFolder(profileDir);
      const left = await killTree({ pid: child.pid, profileDir });
      if (singleton) fs.rmSync(singleton, { recursive: true, force: true });
      await Promise.race([exited, sleep(2000)]);
      if (!cdp.closed) await Promise.race([new Promise((resolve) => cdp.once('closed', resolve)), sleep(500)]);
      return left;
    },
    /* Ask Chrome to quit (it flushes cookies and local storage to disk), fall back to the group kill after graceMs, then forget the
       history of the profile (scrub) once nothing holds it. */
    async close({ graceful = true, graceMs = 4000, scrub = true } = {}) {
      if (graceful && exitInfo === null && !cdp.closed) {
        try { await cdp.send('Browser.close', {}, { timeout: 3000 }); } catch (e) { /* the pipe may drop first */ }
        await Promise.race([exited, sleep(graceMs)]);
      }
      const left = await handle.kill();
      if (scrub && !left.length) scrubProfile(profileDir);
      return left;
    },
  };
  /* A pending exit of THIS process must not leave Chrome behind. A SIGKILL of this process is covered by the pipe closing. */
  const guard = () => { if (exitInfo === null && Number.isInteger(child.pid) && child.pid > 1) { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* gone */ } } };
  process.once('exit', guard);
  exited.then(() => process.removeListener('exit', guard));

  try {
    handle.version = await cdp.send('Browser.getVersion', {}, { timeout: 15000 });
  } catch (error) {
    await handle.kill();
    /* A second Chrome on a profile that another Chrome owns hands its job to the first and exits at once. */
    if (/process_singleton|SingletonLock|profile.*in use/i.test(stderr)) throw new CdpError('The loader\'s Chrome window is already open. Close it and try again.', { code: 'PROFILE_IN_USE' });
    error.message += ` Browser output: ${stderr.slice(-300)}`;
    throw error;
  }
  /* Chrome's default, when nobody has said otherwise, is to SAVE a download that a page starts into the person's own Downloads folder,
     with no prompt. So a launched browser starts in "deny": nothing reaches that folder unless the loader later allows downloads, into
     a private folder (downloads.cjs). */
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true }, { timeout: 5000 }).catch(() => {});
  handle.singletonDir = singletonFolder(profileDir);
  return handle;
}

module.exports = { findChromeBinary, usableBinary, chromeArgs, browserEnv, ENV_ALLOW, prepareProfile, scrubProfile, listProcesses, browserProcesses, killTree, launchBrowser };
