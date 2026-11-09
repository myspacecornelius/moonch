'use strict';
/* The rewriter field: Verva, driven in a real Chrome tab over the DevTools protocol. It reuses the link loader's browser code
   (backend/links/chrome.cjs, cdp.cjs, tab.cjs) and keeps its rules:
   - Chrome runs on a dedicated profile (<root>/private/humanize/verva-profile, 0700), never the person's own, with CDP over the pipe only
     (no debugging port), an allow list of environment variables (no API key reaches it) and downloads denied.
   - The person signs in to Verva once, in a separate Chrome window on the same profile WITH NO DEBUGGING CHANNEL (launchWindow): nothing in
     the Studio can read that page or the keystrokes. The window is stopped with SIGINT so Chrome writes its cookies; the sign-in then
     lives in the profile and the piped browser uses it. After a sign-in and after every close the profile forgets its history (scrubProfile).
   - Page code is never built from strings: one constant function (vervaPage) runs in an isolated world, its argument goes in as JSON.
   - Text goes in with Input.insertText and the button is pressed with real mouse events, so the page sees the same events a person makes.
   - Only MASKED text is typed into Verva: every figure and locked term is a placeholder (mask.cjs). Verva never sees a figure.

   Verva's page is not a published interface, so where the editor, the button and the result are is found on the page, and can be pinned in
   <root>/private/humanize/verva.json:
     { "url": "https://...", "input": "css selector", "button": "css selector", "output": "css selector",
       "minWords": 0, "maxWords": 0, "headless": false, "resultTimeoutMs": 180000 }
   url defaults to https://verva.com/dashboard (Verva, formerly TwainGPT; the dashboard redirects to /login until the profile is signed in),
   and FINANCE_STUDIO_VERVA_URL or the stored url replaces it. Without selectors: the editor is the largest visible empty textarea or contenteditable,
   the button is the visible button whose text starts with Humanize / Rewrite / Paraphrase / Generate / Submit / Run, and the result is the
   visible text box or result-like element (other than the editor) whose text changed after the click, read once it has stopped changing for
   stableMs and nothing on the page is marked busy.

   createVervaWeb({ root, env, chromePath, spawnFn, headless, allowLoopback, tabs, config, timeouts }) -> rewriter
     preflight()            opens the page; needs-sign-in when the page asks for a sign-in, no-editor when no text box is found
     rewrite(masked)        one segment in, Verva's text out
     signIn() / finishSignIn()   the separate sign-in window
     status()               { configured, url, chrome, browser, signIn }
     close()                closes the browser (it flushes the sign-in) and scrubs the profile's history */

const fs = require('node:fs');
const path = require('node:path');
const { findChrome, launchBrowser, launchWindow, holdsProfile, scrubProfile, protectStorage, missingChromeMessage } = require('../../../backend/links/chrome.cjs');
const { Tab, waitForSettled, safeText, safeUrl } = require('../../../backend/links/tab.cjs');
const { sleep } = require('../../../backend/links/cdp.cjs');
const { ensurePrivateDir, writeJsonAtomic } = require('../../../backend/links/store.cjs');
const { HumanizeError } = require('../errors.cjs');

const CONFIG_NAME = 'verva.json';
const URL_ENV = 'FINANCE_STUDIO_VERVA_URL';
const BUTTON_PATTERN = '^(?:humani[sz]e|rewrite|paraphrase|generate|submit|run)\\b';
const DEFAULT_URL = 'https://verva.com/dashboard';
const DEFAULTS = Object.freeze({ url: DEFAULT_URL, input: '', button: '', output: '', minWords: 0, maxWords: 0, headless: false, resultTimeoutMs: 180000, stableMs: 1500, pollMs: 400 });
const SELECTOR_MAX = 200;

function privateDir(root) { return path.join(root, 'private', 'humanize'); }

/* The URL Verva is opened at: https only (http on this machine with allowLoopback, for tests), no user name or password in it. */
function validateUrl(raw, { allowLoopback = false } = {}) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch { return { ok: false, message: 'That is not a web address.' }; }
  if (url.username || url.password) return { ok: false, message: 'The address must not carry a user name or password.' };
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowLoopback && loopback && url.protocol === 'http:')) return { ok: false, message: 'The Verva address must start with https://.' };
  if (loopback && !allowLoopback) return { ok: false, message: 'The Verva address cannot be this computer.' };
  url.hash = '';
  return { ok: true, url: url.toString() };
}

function cleanConfig(raw, options = {}) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.url === 'string' && raw.url.trim()) {
    const checked = validateUrl(raw.url, options);
    if (!checked.ok) throw new HumanizeError(checked.message, 'config', 400);
    out.url = checked.url;
  }
  for (const key of ['input', 'button', 'output']) {
    if (raw[key] === undefined || raw[key] === null || raw[key] === '') continue;
    if (typeof raw[key] !== 'string' || raw[key].length > SELECTOR_MAX || /[\u0000-\u001f]/.test(raw[key])) throw new HumanizeError(`The ${key} selector must be a CSS selector of at most ${SELECTOR_MAX} characters.`, 'config', 400);
    out[key] = raw[key];
  }
  for (const [key, min, max] of [['minWords', 0, 2000], ['maxWords', 0, 20000], ['resultTimeoutMs', 5000, 900000], ['stableMs', 200, 30000], ['pollMs', 50, 5000]]) {
    if (raw[key] === undefined) continue;
    if (!Number.isInteger(raw[key]) || raw[key] < min || raw[key] > max) throw new HumanizeError(`${key} must be a whole number from ${min} to ${max}.`, 'config', 400);
    out[key] = raw[key];
  }
  if (raw.headless !== undefined) out.headless = raw.headless === true;
  return out;
}

function readConfig(root, env = process.env, options = {}) {
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(path.join(privateDir(root), CONFIG_NAME), 'utf8')); } catch { stored = {}; }
  const merged = { ...(stored && typeof stored === 'object' ? stored : {}) };
  if (typeof env[URL_ENV] === 'string' && env[URL_ENV].trim()) merged.url = env[URL_ENV];
  try { return cleanConfig(merged, options); } catch { return cleanConfig({ ...merged, url: '' }, options); }
}

function writeConfig(root, patch, options = {}) {
  const current = readConfig(root, {}, options);
  const next = cleanConfig({ ...current, ...patch }, options);
  fs.mkdirSync(path.join(root, 'private'), { recursive: true, mode: 0o700 });
  ensurePrivateDir(privateDir(root));
  const stored = {};
  for (const key of Object.keys(DEFAULTS)) if (next[key] !== DEFAULTS[key]) stored[key] = next[key];
  writeJsonAtomic(path.join(privateDir(root), CONFIG_NAME), stored);
  return next;
}

/* Runs in the page's isolated world. One JSON argument; returns JSON. Never touches the page's own world or its variables. */
function vervaPage(arg) {
  const visible = el => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  };
  const textOf = el => (!el ? '' : el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : el.innerText || '');
  const wordsOf = t => (String(t).match(/\S+/g) || []).length;
  const norm = t => String(t).replace(/\s+/g, ' ').trim();
  const pick = sel => { if (!sel) return []; try { return Array.from(document.querySelectorAll(sel)); } catch (e) { return []; } };
  const area = el => { const r = el.getBoundingClientRect(); return r.width * r.height; };
  const centre = el => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 40)) };
  };
  const editable = el => visible(el) && !el.disabled && !el.readOnly && el.getAttribute('aria-readonly') !== 'true' && el.getAttribute('aria-disabled') !== 'true';
  const findInput = () => {
    const own = pick(arg.selectors.input).filter(editable);
    if (own.length) return own[0];
    const list = Array.from(document.querySelectorAll('textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]')).filter(editable);
    if (!list.length) return null;
    const stamp = globalThis.__hzInput;
    if (stamp && list.includes(stamp)) return stamp;
    list.sort((a, b) => (wordsOf(textOf(a)) ? 1 : 0) - (wordsOf(textOf(b)) ? 1 : 0) || area(b) - area(a));
    return list[0];
  };
  const BUTTON_RE = new RegExp(arg.buttonPattern, 'i');
  const labelOf = el => norm(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '');
  const findButton = () => {
    const own = pick(arg.selectors.button).filter(visible);
    if (own.length) return own[0];
    const list = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')).filter(el => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    return list.find(el => BUTTON_RE.test(labelOf(el))) || null;
  };
  const OUT_RE = /output|result|humani[sz]|rewrit|answer|response|paraphras/i;
  const keyOf = el => `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''} ${el.getAttribute('data-testid') || ''} ${el.getAttribute('aria-label') || ''}`;
  const candidates = input => {
    const set = new Set(pick(arg.selectors.output));
    if (!arg.selectors.output) {
      for (const el of document.querySelectorAll('textarea, [contenteditable], [role="textbox"], [aria-live], output')) set.add(el);
      for (const el of document.querySelectorAll('[id], [class], [data-testid], [aria-label]')) if (OUT_RE.test(keyOf(el))) set.add(el);
    }
    return Array.from(set).filter(el => el !== input && !(input && (el.contains(input) || input.contains(el))) && visible(el));
  };
  const ERROR_RE = /(?:not enough|insufficient|out of|no)\s+(?:credits?|words?)|upgrade (?:your|to)|limit (?:reached|exceeded)|(?:at least|minimum of)\s+\d+\s+words|too short|something went wrong|try again later|session (?:has )?expired/i;
  const pageError = () => {
    for (const el of document.querySelectorAll('[role="alert"], [role="alertdialog"], [aria-live="assertive"], [class*="error" i], [class*="toast" i], [class*="alert" i]')) {
      if (!visible(el)) continue;
      const t = norm(el.innerText || '');
      if (t && ERROR_RE.test(t)) return t.slice(0, 200);
    }
    return '';
  };
  /* a password box, a sign-in path, or (with no editor on the page) a button that starts a sign-in, as a modal would show it */
  const SIGN_IN_RE = /^(?:log ?in|sign ?in|continue with (?:google|apple|email|microsoft))\b/i;
  const signInWall = () => Boolean(Array.from(document.querySelectorAll('input[type="password"]')).find(visible))
    || /\/(?:log-?in|sign-?in|auth|register|sign-?up)(?:\/|$)/i.test(location.pathname)
    || (!findInput() && Array.from(document.querySelectorAll('button, [role="button"]')).some(el => visible(el) && SIGN_IN_RE.test(labelOf(el))));

  const op = arg.op;
  if (op === 'probe') {
    const input = findInput();
    const button = findButton();
    return { signInWall: signInWall(), input: Boolean(input), button: button ? labelOf(button).slice(0, 40) : null, path: location.pathname.slice(0, 120) };
  }
  if (op === 'focus') {
    const input = findInput();
    if (!input) return null;
    globalThis.__hzInput = input;
    const point = centre(input);
    input.focus();
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') input.select();
    else {
      const range = document.createRange();
      range.selectNodeContents(input);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return point;
  }
  if (op === 'typed') return norm(textOf(findInput()));
  if (op === 'setValue') {
    const input = findInput();
    if (!input || (input.tagName !== 'TEXTAREA' && input.tagName !== 'INPUT')) return false;
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, arg.text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (op === 'snapshot') {
    const input = findInput();
    globalThis.__hzBefore = new Map(candidates(input).map(el => [el, textOf(el)]));
    const button = findButton();
    return { button: button ? centre(button) : null };
  }
  if (op === 'read') {
    const input = findInput();
    const before = globalThis.__hzBefore || new Map();
    const sent = norm(arg.sent);
    const sentWords = wordsOf(sent);
    let best = null;
    for (const el of candidates(input)) {
      const t = textOf(el);
      const n = norm(t);
      if (!n || n === sent || (before.has(el) && before.get(el) === t)) continue;
      const w = wordsOf(n);
      if (w < Math.max(arg.minWords, Math.ceil(sentWords * 0.3))) continue;
      if (arg.maxWords && w > arg.maxWords) continue;
      if (w > Math.max(sentWords * 3, sentWords + 60)) continue;
      const score = (pick(arg.selectors.output).includes(el) ? 4 : 0) + (OUT_RE.test(keyOf(el)) ? 2 : 0) + (el.tagName === 'TEXTAREA' || el.isContentEditable ? 1 : 0);
      if (!best || score > best.score || (score === best.score && w > best.w)) best = { el, t, w, score };
    }
    const busy = Boolean(Array.from(document.querySelectorAll('[aria-busy="true"], [role="progressbar"], progress')).find(visible));
    return { text: best ? best.t : '', busy, error: best ? '' : pageError(), signInWall: signInWall() };
  }
  return null;
}

function createVervaWeb(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const env = options.env || process.env;
  const allowLoopback = options.allowLoopback === true;
  const maxTabs = Number.isInteger(options.tabs) && options.tabs > 0 ? Math.min(options.tabs, 4) : 1;
  const profileDir = path.join(privateDir(root), 'verva-profile');
  const timeouts = { navigation: 30000, settle: 15000, ...(options.timeouts || {}) };
  let browser = null;
  let opening = null;
  const tabs = [];       /* { tab, busy } */
  const waiters = [];
  let windowHandle = null;
  const config = () => (options.config ? cleanConfig(options.config, { allowLoopback }) : readConfig(root, env, { allowLoopback }));
  const headless = () => (options.headless === undefined ? config().headless : options.headless === true);

  function chrome() {
    if (options.chromePath) return options.chromePath;
    const found = findChrome(env);
    if (!found.binary) throw new HumanizeError(missingChromeMessage(found.tried || []), 'config', 400);
    return found.binary;
  }

  function needUrl() {
    const { url } = config();
    if (!url) throw new HumanizeError(`Set the Verva page address first (the Humanize page, ${URL_ENV}, or "url" in private/humanize/${CONFIG_NAME}).`, 'config', 400);
    return url;
  }

  async function ensureBrowser() {
    if (browser && !browser.hasExited()) return browser;
    if (opening) return opening;
    if (windowHandle && !windowHandle.hasExited()) throw new HumanizeError('The Verva sign-in window is still open. Finish signing in first.', 'needs-sign-in', 409);
    opening = (async () => {
      fs.mkdirSync(path.join(root, 'private'), { recursive: true, mode: 0o700 });
      ensurePrivateDir(privateDir(root));
      ensurePrivateDir(profileDir);
      protectStorage({ privateDir: path.join(root, 'private'), paths: [profileDir] });
      browser = await launchBrowser({ binary: chrome(), profileDir, headless: headless(), spawnFn: options.spawnFn, env });
      tabs.length = 0;
      return browser;
    })();
    try { return await opening; } finally { opening = null; }
  }

  const op = (tab, name, extra = {}) => {
    const c = config();
    return tab.evalFn(vervaPage, { op: name, selectors: { input: c.input, button: c.button, output: c.output }, buttonPattern: BUTTON_PATTERN, ...extra }, { timeout: 8000, userGesture: name === 'focus' });
  };

  async function openPage(tab) {
    const url = needUrl();
    const nav = await tab.navigate(url, { timeout: timeouts.navigation });
    if (nav.errorText) throw new HumanizeError(`The Verva page did not open (${safeText(nav.errorText, 80)}).`, 'rewriter', 502);
    await waitForSettled(tab, { maxMs: timeouts.settle });
    const probe = await op(tab, 'probe');
    if (probe.signInWall) throw new HumanizeError('Verva asks you to sign in. Use "Sign in to Verva" (or npm run humanize -- sign-in), then start again.', 'needs-sign-in', 409);
    if (!probe.input) throw new HumanizeError(`No text box was found on ${safeUrl(url)}. Pin it with "input" in private/humanize/${CONFIG_NAME}.`, 'no-editor', 502);
    return probe;
  }

  async function acquire() {
    await ensureBrowser();
    for (;;) {
      const free = tabs.find(t => !t.busy);
      if (free) { free.busy = true; return free; }
      if (tabs.length < maxTabs) {
        const entry = { tab: null, busy: true };
        tabs.push(entry);
        try {
          entry.tab = await Tab.open(browser.cdp, { newWindow: browser.headless });
          if (!browser.headless) await entry.tab.front();
          await openPage(entry.tab);
        } catch (error) {
          tabs.splice(tabs.indexOf(entry), 1);
          if (entry.tab) await entry.tab.close().catch(() => {});
          throw error;
        }
        return entry;
      }
      await new Promise(resolve => waiters.push(resolve));
    }
  }

  function release(entry, broken) {
    entry.busy = false;
    if (broken) {
      tabs.splice(tabs.indexOf(entry), 1);
      if (entry.tab) entry.tab.close().catch(() => {});
    }
    const next = waiters.shift();
    if (next) next();
  }

  async function click(tab, point) {
    const s = tab.s;
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }

  const normalize = t => String(t).replace(/\s+/g, ' ').trim();

  async function rewriteOn(entry, text, signal) {
    const c = config();
    const tab = entry.tab;
    let point = await op(tab, 'focus');
    if (!point) { await openPage(tab); point = await op(tab, 'focus'); }
    if (!point) throw new HumanizeError('The Verva text box went away.', 'no-editor', 502);
    await click(tab, point);
    await op(tab, 'focus');
    await tab.s.send('Input.insertText', { text });
    if ((await op(tab, 'typed')) !== normalize(text)) {
      await op(tab, 'setValue', { text });
      if ((await op(tab, 'typed')) !== normalize(text)) throw new HumanizeError('The text could not be typed into the Verva text box.', 'rewriter', 502);
    }
    const snap = await op(tab, 'snapshot');
    if (!snap.button) throw new HumanizeError(`No Humanize button was found on the Verva page. Pin it with "button" in private/humanize/${CONFIG_NAME}.`, 'no-editor', 502);
    await click(tab, snap.button);
    const started = Date.now();
    let last = '';
    let changedAt = Date.now();
    while (Date.now() - started < c.resultTimeoutMs) {
      if (signal && signal.aborted) throw Object.assign(new Error('The run was stopped.'), { code: 'cancelled' });
      await sleep(c.pollMs);
      const r = await op(tab, 'read', { sent: text, minWords: c.minWords, maxWords: c.maxWords });
      if (r.signInWall) throw new HumanizeError('Verva asks you to sign in again. Use "Sign in to Verva", then start again.', 'needs-sign-in', 409);
      if (!r.text) {
        if (r.error) throw new HumanizeError(`Verva said: ${safeText(r.error, 200)}`, 'rewriter', 502);
        continue;
      }
      if (r.text !== last) { last = r.text; changedAt = Date.now(); continue; }
      if (!r.busy && Date.now() - changedAt >= c.stableMs) return last.replace(/\r\n?/g, '\n').trim();
    }
    throw new HumanizeError(`Verva did not return a result within ${Math.round(c.resultTimeoutMs / 1000)} s.`, 'rewriter', 504);
  }

  const self = {
    id: 'verva',
    label: 'Verva (Chrome)',
    external: true,
    get minWords() { return config().minWords; },
    async preflight() {
      needUrl();
      const entry = await acquire();
      release(entry, false);
    },
    async rewrite(text, { signal } = {}) {
      const entry = await acquire();
      let broken = false;
      try {
        return await rewriteOn(entry, String(text), signal);
      } catch (error) {
        broken = !(error instanceof HumanizeError);
        if (error && /tab is gone|closed the pipe|detached|crashed/i.test(String(error.message))) broken = true;
        throw error instanceof HumanizeError || (error && error.code === 'cancelled') ? error : new HumanizeError(`The Verva tab failed: ${safeText(error && error.message, 160)}`, 'rewriter', 502);
      } finally {
        release(entry, broken);
      }
    },
    /* The separate sign-in window: no debugging channel. It opens the configured page itself (Verva's address carries no secret), which
       sends the person to Verva's login and, once signed in, back to the dashboard. */
    async signIn() {
      if (windowHandle && !windowHandle.hasExited()) return { signIn: 'open', exited: windowHandle.exited };
      const url = needUrl();
      await self.close();
      fs.mkdirSync(path.join(root, 'private'), { recursive: true, mode: 0o700 });
      ensurePrivateDir(privateDir(root));
      ensurePrivateDir(profileDir);
      windowHandle = launchWindow({ binary: chrome(), profileDir, headless: options.signInHeadless === true, spawnFn: options.spawnFn, env, url });
      return { signIn: 'open', exited: windowHandle.exited };
    },
    async finishSignIn() {
      if (!windowHandle) return { signIn: 'closed' };
      const handle = windowHandle;
      windowHandle = null;
      const left = await handle.stop();
      try { if (!left.length && !holdsProfile(profileDir)) scrubProfile(profileDir); } catch { /* the next close tries again */ }
      return { signIn: 'closed' };
    },
    status() {
      let chromeFound = true;
      try { chrome(); } catch { chromeFound = false; }
      const c = config();
      return {
        configured: Boolean(c.url),
        url: c.url ? safeUrl(c.url) : null,
        chrome: chromeFound,
        browser: browser && !browser.hasExited() ? 'open' : 'closed',
        signIn: windowHandle && !windowHandle.hasExited() ? 'open' : 'closed',
        pinned: { input: Boolean(c.input), button: Boolean(c.button), output: Boolean(c.output) },
      };
    },
    async close() {
      for (const entry of tabs.splice(0)) if (entry.tab) await entry.tab.close().catch(() => {});
      const handle = browser;
      browser = null;
      if (handle && !handle.hasExited()) await handle.close({ graceful: true }).catch(() => {});
    },
  };
  return self;
}

module.exports = { createVervaWeb, readConfig, writeConfig, cleanConfig, validateUrl, vervaPage, CONFIG_NAME, URL_ENV, DEFAULTS, DEFAULT_URL };
