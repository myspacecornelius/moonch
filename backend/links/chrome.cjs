'use strict';
/* Starting, supervising and stopping Chrome. Everything about the browser PROCESS lives here; nothing about pages.

   Rules the code follows (each has a test in tests/links-loader.test.cjs or tests/links-browser.cjs):
   - The profile is a dedicated folder, created 0700, never the person's own Chrome profile (Chrome 136 and later ignores the
     remote-debugging switches on the default one). One Chrome per profile (a SingletonLock); a second launch reports PROFILE_IN_USE.
   - CDP only over the pipe (file descriptors 3 and 4). No --remote-debugging-port: a port is reachable by every local process.
   - The link is never on the command line (ps shows argv to every local account): the only positional argument is about:blank (or, for
     the person's sign-in window, the platform's ORIGIN) and the task page is opened later with Page.navigate.
   - Sign-in happens in a separate Chrome on the same profile with NO debugging channel (launchWindow): nothing in the Studio can read the
     page or the keystrokes, no automation flag is set (sites such as Google refuse a browser that announces it is automated), and
     downloads are blocked by a seeded preference. It is stopped with SIGINT, which makes Chrome write its cookies, then relaunched on
     the pipe.
   - Chrome gets an ALLOW LIST of environment variables, not the companion's: no API key, token or proxy password reaches a process
     that renders other people's pages. On Linux HOME and XDG_* point inside the profile folder, which also moves the crash handler's
     database (it outlives Chrome and is otherwise written to the real home folder).
   - The product never passes --no-sandbox. A test that runs as root adds it through spawnFn.
   - Downloads start denied (loader.cjs sets that before any page exists), so nothing reaches the person's own Downloads folder.
   - After a load the profile forgets where it has been (History, download database, saved sessions, caches: they hold signed links).
     Cookies and local storage stay, so the sign-in survives. */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Cdp, CdpError, sleep } = require('./cdp.cjs');
const { safeText } = require('./tab.cjs');

/* Where a Chrome or Chromium might be, after FINANCE_STUDIO_CHROME and CHROME_BIN (in that order). A path that ends in .app is a macOS
   application folder: the program is Contents/MacOS/<CFBundleExecutable>. */
const APP_NAMES = ['Google Chrome.app', 'Chromium.app', 'Google Chrome for Testing.app'];
const LINUX_BINARIES = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const defaultCandidates = (home) => [...[path.join('/Applications'), path.join(home, 'Applications')].flatMap((dir) => APP_NAMES.map((name) => path.join(dir, name))), ...LINUX_BINARIES];

function resolveBinary(file) {
  if (typeof file !== 'string' || !/\.app\/?$/i.test(file)) return file;
  const app = file.replace(/\/$/, '');
  let exe = path.basename(app, '.app');
  try {
    const m = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8'));
    if (m && !/[\\/]/.test(m[1])) exe = m[1];
  } catch (e) { /* a binary plist or none: the app's own name is the usual executable */ }
  return path.join(app, 'Contents', 'MacOS', exe);
}

/* { ok: true } or { ok: false, why }: an absolute path to an executable regular file that no other account can write to (a browser
   binary someone else can replace is a program the companion would run for them). */
function checkBinary(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return { ok: false, why: 'it is not an absolute path' };
  let stat;
  try { stat = fs.statSync(file); } catch (e) { return { ok: false, why: 'it does not exist' }; }
  if (!stat.isFile()) return { ok: false, why: 'it is not a file' };
  if ((stat.mode & 0o022) !== 0) return { ok: false, why: `other accounts can write to it (mode ${(stat.mode & 0o777).toString(8)})` };
  try { fs.accessSync(file, fs.constants.X_OK); } catch (e) { return { ok: false, why: 'it is not executable' }; }
  return { ok: true };
}
const usableBinary = (file) => checkBinary(resolveBinary(file)).ok;

/* { binary, tried }: the first usable candidate (the resolved program path), and why each candidate that was named or that exists was
   passed over. A default location that simply is not there is not worth a line. */
function findChrome(env = process.env, home = os.homedir()) {
  const tried = [];
  const named = [env.FINANCE_STUDIO_CHROME, env.CHROME_BIN].filter(Boolean);
  for (const candidate of [...named, ...defaultCandidates(home)]) {
    const resolved = resolveBinary(candidate);
    const check = checkBinary(resolved);
    if (check.ok) return { binary: resolved, tried };
    if (named.includes(candidate) || check.why !== 'it does not exist') tried.push({ path: candidate, why: check.why });
  }
  return { binary: null, tried };
}
const findChromeBinary = (env = process.env) => findChrome(env).binary;

const missingChromeMessage = (tried) => `No Chrome or Chromium found. Install Google Chrome, or set FINANCE_STUDIO_CHROME to its path.${tried.length ? ` Not used: ${tried.map((t) => `${t.path} (${t.why})`).join('; ')}.` : ''}`;

const BASE_FLAGS = [
  '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-default-apps', '--disable-background-networking',
  '--disable-component-update', '--disable-breakpad', '--metrics-recording-only', '--noerrdialogs',
  '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,PrivacySandboxSettings4',
  '--restore-last-session',   /* with the seeded preference it keeps session cookies (a login without Max-Age) across a restart, see prepareProfile */
];

/* url: the one positional argument. The loader's browser opens about:blank and is sent to the link over the pipe; the person's sign-in
   window (pipe: false) opens the platform's origin and nothing else. */
function chromeArgs({ profileDir, headless, url = 'about:blank', pipe = true }) {
  const args = [`--user-data-dir=${profileDir}`, ...(pipe ? ['--remote-debugging-pipe'] : []), ...BASE_FLAGS, '--window-size=1280,900'];
  if (headless) args.push('--headless=new');
  else {
    args.push('--hide-crash-restore-bubble', '--disable-search-engine-choice-screen');
    /* A window the person has covered or minimised must not slow the page down: a page in a background tab runs its timers once a second. */
    args.push('--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling');
  }
  if (process.platform === 'linux') args.push('--password-store=basic');   /* never open the desktop keyring */
  args.push(url);
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

/* Is a Chrome running on this profile? Its command line carries the profile path. */
const holdsProfile = (profileDir) => listProcesses().some((p) => !p.state.startsWith('Z') && p.cmd.includes(`--user-data-dir=${profileDir}`));

/* A Chrome that was killed leaves its lock (SingletonLock, SingletonSocket, SingletonCookie) and the folder the socket points into; the
   next Chrome would then refuse the profile. Removed only when no Chrome holds the profile. Returns whether anything was cleaned. */
function removeStaleLocks(profileDir) {
  if (holdsProfile(profileDir)) return false;
  const folder = singletonFolder(profileDir);
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) fs.rmSync(path.join(profileDir, name), { force: true });
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  return true;
}

/* Make the profile ready. Safe only while no Chrome owns it. The preferences:
   - session.restore_on_startup keeps session cookies on disk without this code ever reading one (the side effect is that Chrome reopens
     the previous tabs, so the old session files are deleted first);
   - the password manager, autofill, sync sign-in and Safe Browsing are off (the Studio never offers to remember a password, and Safe
     Browsing's "dangerous file" hold would stall a download that nobody can click through);
   - download_restrictions=3 blocks every download that Chrome's own window starts (the sign-in window has no debugging channel, so the
     loader cannot tell it to deny them), and the default download folder is inside the profile, so nothing reaches the person's own
     Downloads folder. The loader's own downloads over the pipe are not affected. */
function prepareProfile(profileDir) {
  const defaultDir = path.join(profileDir, 'Default');
  fs.mkdirSync(defaultDir, { recursive: true, mode: 0o700 });
  const quarantine = path.join(profileDir, 'quarantine');
  fs.mkdirSync(quarantine, { recursive: true, mode: 0o700 });
  removeStaleLocks(profileDir);
  const file = path.join(defaultDir, 'Preferences');
  let prefs = {};
  try { prefs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { prefs = {}; }
  prefs.session = { ...(prefs.session || {}), restore_on_startup: 1 };
  prefs.credentials_enable_service = false;
  prefs.profile = { ...(prefs.profile || {}), password_manager_enabled: false };
  prefs.autofill = { ...(prefs.autofill || {}), profile_enabled: false, credit_card_enabled: false };
  prefs.signin = { ...(prefs.signin || {}), allowed: false };
  prefs.safebrowsing = { ...(prefs.safebrowsing || {}), enabled: false, enhanced: false };
  prefs.download_restrictions = 3;
  prefs.profile.default_content_setting_values = { ...(prefs.profile.default_content_setting_values || {}), automatic_downloads: 1 };   /* Chrome's limit on the downloads a page starts by itself (it drops some) */
  prefs.download = { ...(prefs.download || {}), default_directory: quarantine, prompt_for_download: false };
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

const PROFILE_IN_USE_MESSAGE = 'Quit the loader\'s Chrome (Cmd+Q) and try again.';
const SINGLETON_RE = /process_singleton|SingletonLock|profile.*in use/i;

/* Signal a browser's whole process group (it was spawned detached, so the group is its own). A test double without a real pid is
   signalled through its own kill(). Never signals pid 0 or 1. */
function signalTree(child, signal) {
  if (Number.isInteger(child.pid) && child.pid > 1) {
    try { process.kill(-child.pid, signal); return true; } catch (e) { /* not a group leader any more */ }
    try { process.kill(child.pid, signal); return true; } catch (e) { return false; }
  }
  if (typeof child.kill === 'function') { try { child.kill(signal); return true; } catch (e) { return false; } }
  return false;
}

/* options: { binary, profileDir, headless, spawnFn (default child_process.spawn), env }
   Returns { cdp, child, pid, profileDir, version, headless, close({ graceful, scrub }), kill(), hasExited(), exited, stderrTail() }. */
async function launchBrowser({ binary, profileDir, headless = true, spawnFn = spawn, env = process.env }) {
  if (!binary) throw new Error(missingChromeMessage([]));
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
    /* A second Chrome on a profile that another Chrome owns hands its job to the first and exits at once. The holder is somebody else's
       (a Chrome the owner started, or the sign-in window of a run that crashed): only THIS child is ended, never the holder, and the
       lock it keeps is left alone. */
    if (SINGLETON_RE.test(stderr)) {
      await killTree({ pid: child.pid, graceMs: 2000 });
      await Promise.race([exited, sleep(2000)]);
      throw new CdpError(PROFILE_IN_USE_MESSAGE, { code: 'PROFILE_IN_USE' });
    }
    const left = await handle.kill();
    if (!left.length && !holdsProfile(profileDir)) scrubProfile(profileDir);
    const tail = safeText(stderr.slice(-300), 200);
    /* a pipe that closed before the browser answered: it never started (no display, a missing library, a refused sandbox ...) */
    if (error.code === 'PIPE_CLOSED' || exitInfo !== null) throw new CdpError(`Chrome did not start. ${tail}`.trim(), { code: 'LAUNCH' });
    error.message += ` Browser output: ${tail}`;
    throw error;
  }
  /* Chrome's default, when nobody has said otherwise, is to SAVE a download that a page starts into the person's own Downloads folder,
     with no prompt. So a launched browser starts in "deny": nothing reaches that folder unless the loader later allows downloads, into
     a private folder (downloads.cjs). */
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true }, { timeout: 5000 }).catch(() => {});
  handle.singletonDir = singletonFolder(profileDir);
  return handle;
}

/* The person's sign-in window: the same binary on the same profile, WITHOUT --remote-debugging-pipe, opening only `url` (the platform's
   origin: never a path or a query). Returns { child, pid, exited, hasExited(), stderrTail(), stop() }. It resolves nothing by itself: the
   caller waits for the person (Continue) or for hasExited(). stop() asks Chrome to quit the way Ctrl-C does (SIGINT: Chrome writes its
   cookies and local storage, measured: the sign-in is still there on the next start; SIGTERM makes it exit at once and loses a cookie
   younger than about 30 seconds), then SIGTERM, then the group kill, and proves nothing is left. */
function launchWindow({ binary, profileDir, headless = false, spawnFn = spawn, env = process.env, url }) {
  if (!binary) throw new Error(missingChromeMessage([]));
  prepareProfile(profileDir);
  const homeDir = path.join(profileDir, 'home');
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  const child = spawnFn(binary, chromeArgs({ profileDir, headless, url, pipe: false }), { stdio: ['ignore', 'ignore', 'pipe'], detached: true, env: browserEnv(env, homeDir) });
  let stderr = '';
  if (child.stderr) child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
  let exitInfo = null;
  let spawnError = '';
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => { exitInfo = { code, signal }; resolve(exitInfo); }));
  child.once('error', (error) => { spawnError = error.message; exitInfo = exitInfo || { code: null, signal: null }; });
  const guard = () => { if (exitInfo === null && Number.isInteger(child.pid) && child.pid > 1) { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* gone */ } } };
  process.once('exit', guard);
  exited.then(() => process.removeListener('exit', guard));
  return {
    child, pid: child.pid, profileDir, exited,
    stderrTail: () => stderr,
    hasExited: () => exitInfo !== null,
    error: () => spawnError,
    async stop({ graceMs = 8000 } = {}) {
      /* a window that gave up because ANOTHER Chrome owns the profile: that Chrome is not ours to sweep */
      const handedOff = exitInfo !== null && SINGLETON_RE.test(stderr);
      const singleton = handedOff ? null : singletonFolder(profileDir);
      if (exitInfo === null) { signalTree(child, 'SIGINT'); await Promise.race([exited, sleep(graceMs)]); }
      if (exitInfo === null) { signalTree(child, 'SIGTERM'); await Promise.race([exited, sleep(3000)]); }
      const left = await killTree({ pid: child.pid, profileDir: handedOff ? undefined : profileDir });
      if (singleton) fs.rmSync(singleton, { recursive: true, force: true });
      return left;
    },
  };
}

/* macOS: the Studio folder may sit in a place that is uploaded or backed up (iCloud Drive, Dropbox, OneDrive, Documents and Desktop when
   they are synced). The profile holds a saved sign-in and the load folders hold the task files, so the person is told. '' when fine. */
function syncWarning(realRoot, home = os.homedir(), platform = process.platform) {
  if (platform !== 'darwin') return '';
  const within = (dir) => realRoot === dir || realRoot.startsWith(dir + path.sep);
  const named = [path.join(home, 'Documents'), path.join(home, 'Desktop'), path.join(home, 'Library', 'Mobile Documents'), path.join(home, 'Library', 'CloudStorage')];
  const hit = named.find(within) || realRoot.split(path.sep).find((seg) => /^(Dropbox|OneDrive)/i.test(seg));
  return hit ? `The Studio folder is in a place that may be synced or backed up (${hit.startsWith(path.sep) ? hit.replace(home, '~') : hit}); the saved sign-in and the downloaded task files could be uploaded.` : '';
}

/* macOS: keep Spotlight and Time Machine away from the saved sign-in and the downloaded files. Failures are ignored. Once per path. */
const excluded = new Set();
function protectStorage({ privateDir, paths = [], platform = process.platform, run = spawnSync }) {
  if (platform !== 'darwin') return [];
  try { fs.writeFileSync(path.join(privateDir, '.metadata_never_index'), '', { flag: 'a', mode: 0o600 }); } catch (e) { /* not worth failing a load */ }
  const done = [];
  for (const target of paths) {
    if (excluded.has(target)) continue;
    excluded.add(target);
    try { run('tmutil', ['addexclusion', target], { stdio: 'ignore', timeout: 5000 }); done.push(target); } catch (e) { /* tmutil is optional */ }
  }
  return done;
}

module.exports = {
  findChrome, findChromeBinary, defaultCandidates, usableBinary, checkBinary, resolveBinary, missingChromeMessage, chromeArgs, browserEnv, ENV_ALLOW, prepareProfile, removeStaleLocks, holdsProfile, scrubProfile,
  listProcesses, browserProcesses, killTree, signalTree, launchBrowser, launchWindow, syncWarning, protectStorage, PROFILE_IN_USE_MESSAGE,
};
