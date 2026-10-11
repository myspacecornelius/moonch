'use strict';
/* The dedicated pilot sign-in (docs/local-agents.md section 3.4).

   A pilot does not have to run under the writer's own sign-in. The writer can make a long-lived token with
   `claude setup-token` and store it in the macOS Keychain item `finance-studio-pilot-token` (or, on any system, in
   FINANCE_STUDIO_PILOT_TOKEN in the companion's own environment). The Studio reads it when a pre-flight runs, hands it
   only to the processes it starts, as CLAUDE_CODE_OAUTH_TOKEN, and keeps it out of every record: the runner blanks it
   out of the stream before a line is parsed or written, the audit discards a run that reads the environment or shows
   the token anywhere, and the files a run leaves behind are scanned and scrubbed.

   Nothing here starts a model. The token is never logged, never written to disk by the Studio, and never part of a
   message: an error names the place it was read from, not its text. */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const KEYCHAIN_SERVICE = 'finance-studio-pilot-token';
const TOKEN_ENV = 'FINANCE_STUDIO_PILOT_TOKEN';
/* Set to `off` in the companion's environment to never read the Keychain (the tests set it, so a token stored on a
   developer's Mac cannot reach a test; a writer can use it to run pilots under their own sign-in on purpose). */
const KEYCHAIN_SWITCH = 'FINANCE_STUDIO_KEYCHAIN';
const RUNTIME_TOKEN_VAR = 'CLAUDE_CODE_OAUTH_TOKEN';
/* What stands where the token stood, in a transcript line, a stderr tail or a file. */
const REDACTED = '[pilot-token redacted]';
const MIN_TOKEN_CHARS = 16;
const MAX_TOKEN_CHARS = 4096;
const MIN_SECRET_CHARS = 8; /* a shorter value would be found in ordinary text */
const SECURITY_TIMEOUT_MS = 10000;
const SECURITY_NOT_FOUND = 44; /* `security` exits 44 (errSecItemNotFound) when there is no such item */
const MAX_REDACT_FILE_BYTES = 128 * 1024 * 1024;
const MAX_REDACT_FILES = 20000;
const MAX_REDACT_DEPTH = 16;
const ANTHROPIC_HOST = 'api.anthropic.com';

/* Variables that would route the runtime through a gateway or another provider, or sign it in to one. */
const ROUTING_VARS = Object.freeze(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']);
/* Variables that rename what a model id or alias points to. */
const MODEL_VARS = Object.freeze(['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']);
/* Everything a pilot with the token does not inherit: the gateway variables, every other sign-in, and the token's own
   source. The pilot then reaches Anthropic directly with the token and nothing else. */
const DROPPED_WITH_TOKEN = Object.freeze(['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', RUNTIME_TOKEN_VAR, TOKEN_ENV, ...ROUTING_VARS, ...MODEL_VARS]);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const firstLine = text => String(text || '').trim().split(/\r?\n/)[0].slice(0, 200);

/* validToken(text) -> the token with surrounding whitespace removed, or null when the text cannot be a token: not a
   string, shorter than 16 or longer than 4096 characters, or holding anything but printable ASCII without spaces. */
function validToken(text) {
  if (typeof text !== 'string') return null;
  const token = text.trim();
  if (token.length < MIN_TOKEN_CHARS || token.length > MAX_TOKEN_CHARS) return null;
  if (!/^[\x21-\x7e]+$/.test(token)) return null;
  return token;
}

/* Why a text is not a token, without quoting it. */
function describeInvalid(text) {
  const trimmed = String(text).trim();
  if (trimmed.length < MIN_TOKEN_CHARS) return `only ${trimmed.length} characters`;
  if (trimmed.length > MAX_TOKEN_CHARS) return `${trimmed.length} characters, more than a token has`;
  return 'it holds spaces or characters that are not printable ASCII';
}

function defaultExecFile(file, args, options) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/* readPilotToken({ env, platform, execFile, timeoutMs }) -> Promise<{ token, source, error }>
   source is 'env' (FINANCE_STUDIO_PILOT_TOKEN), 'keychain' (the macOS item) or null when there is no token. error is a
   sentence when a token was there but could not be used or read; it never holds the token or any output of the
   `security` tool. The environment variable wins over the Keychain, because it is an explicit choice of whoever started
   the companion. The Keychain is only asked on macOS. Never rejects. */
async function readPilotToken(options = {}) {
  const env = isObject(options.env) ? options.env : process.env;
  const platform = typeof options.platform === 'string' ? options.platform : process.platform;
  const fromEnv = env[TOKEN_ENV];
  if (typeof fromEnv === 'string' && fromEnv !== '') {
    const token = validToken(fromEnv);
    if (token) return { token, source: 'env', error: null };
    return { token: null, source: 'env', error: `${TOKEN_ENV} is set but is not a usable token (${describeInvalid(fromEnv)})` };
  }
  if (platform !== 'darwin' || env[KEYCHAIN_SWITCH] === 'off') return { token: null, source: null, error: null };
  const run = typeof options.execFile === 'function' ? options.execFile : defaultExecFile;
  const timeout = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : SECURITY_TIMEOUT_MS;
  let output;
  try {
    output = await run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { env, timeout, maxBuffer: 64 * 1024, windowsHide: true });
  } catch (error) {
    const code = error && error.code;
    if (code === SECURITY_NOT_FOUND) return { token: null, source: null, error: null };
    const why = error && error.killed ? 'it did not answer in time' : Number.isInteger(code) ? `exit code ${code}${error.stderr ? ': ' + firstLine(error.stderr) : ''}` : firstLine(error && error.message ? error.message : error);
    return { token: null, source: 'keychain', error: `the Keychain item ${KEYCHAIN_SERVICE} could not be read (${why})` };
  }
  const text = typeof output === 'string' ? output : output && output.stdout !== undefined ? String(output.stdout) : '';
  const token = validToken(text);
  if (token) return { token, source: 'keychain', error: null };
  return { token: null, source: 'keychain', error: `the Keychain item ${KEYCHAIN_SERVICE} does not hold a usable token (${describeInvalid(text)})` };
}

/* A short name for where a token came from, for a sentence a writer reads. */
function sourceText(source) {
  if (source === 'keychain') return `the Keychain item ${KEYCHAIN_SERVICE}`;
  if (source === 'env') return TOKEN_ENV;
  if (source === 'option') return 'the companion\'s own setting';
  return 'nowhere';
}

/* ------------------------------------------------------------------ gateway variables */

function isAnthropicUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && url.hostname.toLowerCase() === ANTHROPIC_HOST;
  } catch {
    return false;
  }
}

function hostOf(value) {
  try { return new URL(String(value)).host || '(no host)'; } catch { return '(not a URL)'; }
}

const isOn = value => typeof value === 'string' && value !== '' && value !== '0' && value.toLowerCase() !== 'false';

/* gatewayFindings(env) -> [{ name, detail }]: the variables in an environment that would send a pilot somewhere other
   than Anthropic, sign it in some other way, or rename its models. ANTHROPIC_BASE_URL counts unless it is an https URL
   at api.anthropic.com. A value is never returned, only a host name or the word set. */
function gatewayFindings(env) {
  const source = isObject(env) ? env : process.env;
  const findings = [];
  const base = source.ANTHROPIC_BASE_URL;
  if (typeof base === 'string' && base !== '' && !isAnthropicUrl(base)) findings.push({ name: 'ANTHROPIC_BASE_URL', detail: hostOf(base) });
  for (const name of ROUTING_VARS) {
    const value = source[name];
    if (name.startsWith('CLAUDE_CODE_USE_') ? isOn(value) : typeof value === 'string' && value !== '') findings.push({ name, detail: 'set' });
  }
  for (const name of MODEL_VARS) {
    const value = source[name];
    if (typeof value === 'string' && value !== '') findings.push({ name, detail: value.slice(0, 60) });
  }
  return findings;
}

/* One phrase for a message: "ANTHROPIC_BASE_URL=proxy.example.test, ANTHROPIC_AUTH_TOKEN set". */
function describeFindings(findings) {
  return findings.map(finding => (finding.detail === 'set' ? `${finding.name} set` : `${finding.name}=${finding.detail}`)).join(', ');
}

/* ------------------------------------------------------------------ redaction */

/* The forms a secret can take inside text the runner sees: as it is, and as JSON writes it inside a string. */
function formsOf(secret) {
  const forms = [secret];
  const escaped = JSON.stringify(secret).slice(1, -1);
  if (escaped !== secret) forms.push(escaped);
  return forms;
}

/* makeRedactor(secrets) -> text => text with every secret replaced by REDACTED. Values that are not strings of at least
   8 characters are ignored, so an empty list gives back the text unchanged. */
function makeRedactor(secrets) {
  const forms = [];
  for (const secret of Array.isArray(secrets) ? secrets : []) {
    if (typeof secret !== 'string' || secret.length < MIN_SECRET_CHARS) continue;
    for (const form of formsOf(secret)) if (!forms.includes(form)) forms.push(form);
  }
  if (!forms.length) return text => text;
  return text => {
    let out = String(text);
    for (const form of forms) if (out.includes(form)) out = out.split(form).join(REDACTED);
    return out;
  };
}

/* containsSecret(text, secrets) -> true when the text holds one of the secrets (in either form) or the REDACTED marker,
   which only stands where a secret stood. */
function containsSecret(text, secrets) {
  if (typeof text !== 'string' || !text) return false;
  if (text.includes(REDACTED)) return true;
  for (const secret of Array.isArray(secrets) ? secrets : []) {
    if (typeof secret !== 'string' || secret.length < MIN_SECRET_CHARS) continue;
    for (const form of formsOf(secret)) if (text.includes(form)) return true;
  }
  return false;
}

/* redactFilesUnder(folder, secrets) -> { redacted: [relative paths], skipped: [relative paths] }
   Walks a folder (regular files and folders; symbolic links are not followed) and rewrites every file that holds one of
   the secrets, with the secret replaced by REDACTED. The file keeps its mode. A file or folder whose NAME holds a secret
   is renamed the same way (a name that is taken gets " (2)", " (3)" and so on). The lists name entries as they are
   after the change, so they never hold a secret. A file over 128 MB, or beyond the file and depth caps, is listed as
   skipped. Secrets are ASCII, so the bytes of a file are handled as latin1 text and written back unchanged where
   nothing matched. */
function redactFilesUnder(folder, secrets) {
  const forms = [];
  for (const secret of Array.isArray(secrets) ? secrets : []) {
    if (typeof secret === 'string' && secret.length >= MIN_SECRET_CHARS && /^[\x21-\x7e]+$/.test(secret)) for (const form of formsOf(secret)) forms.push(form);
  }
  const redacted = [];
  const skipped = [];
  if (!forms.length || typeof folder !== 'string') return { redacted, skipped };
  const scrub = text => forms.reduce((value, form) => (value.includes(form) ? value.split(form).join(REDACTED) : value), text);
  /* Renames dir/oldName to its scrubbed name. Returns the new name, or null when the rename failed. */
  const rename = (dir, oldName) => {
    const base = scrub(oldName);
    let target = base;
    try {
      for (let n = 2; fs.existsSync(path.join(dir, target)); n++) target = `${base} (${n})`;
      fs.renameSync(path.join(dir, oldName), path.join(dir, target));
      return target;
    } catch {
      return null;
    }
  };
  let count = 0;
  const walk = (dir, rel, depth) => {
    if (depth > MAX_REDACT_DEPTH) { skipped.push(scrub(rel) + '/'); return; }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      const named = scrub(entry.name) !== entry.name;
      if (entry.isSymbolicLink()) {
        if (named) skipped.push(scrub(name)); /* a link is never followed, so it is not renamed; it is reported */
        continue;
      }
      if (entry.isDirectory()) {
        walk(full, name, depth + 1);
        if (named) {
          if (rename(dir, entry.name) === null) skipped.push(scrub(name) + '/');
          else redacted.push(scrub(name) + '/');
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (++count > MAX_REDACT_FILES) { skipped.push(scrub(name)); continue; }
      let changed = false;
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.size > MAX_REDACT_FILE_BYTES) {
        skipped.push(scrub(name));
      } else {
        let buffer = null;
        try { buffer = fs.readFileSync(full); } catch { skipped.push(scrub(name)); }
        if (buffer !== null && forms.some(form => buffer.indexOf(form) >= 0)) {
          let text = buffer.toString('latin1');
          for (const form of forms) text = text.split(form).join(REDACTED);
          try {
            fs.writeFileSync(full, Buffer.from(text, 'latin1'), { mode: stat.mode & 0o777 });
            changed = true;
          } catch {
            skipped.push(scrub(name));
          }
        }
      }
      if (named) {
        if (rename(dir, entry.name) === null) skipped.push(scrub(name));
        else changed = true;
      }
      if (changed) redacted.push(scrub(name));
    }
  };
  walk(path.resolve(folder), '', 0);
  return { redacted: [...new Set(redacted)].sort(), skipped: [...new Set(skipped)].sort() };
}

module.exports = {
  KEYCHAIN_SERVICE,
  KEYCHAIN_SWITCH,
  TOKEN_ENV,
  RUNTIME_TOKEN_VAR,
  REDACTED,
  ROUTING_VARS,
  MODEL_VARS,
  DROPPED_WITH_TOKEN,
  validToken,
  readPilotToken,
  sourceText,
  isAnthropicUrl,
  gatewayFindings,
  describeFindings,
  makeRedactor,
  containsSecret,
  redactFilesUnder,
};
