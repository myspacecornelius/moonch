'use strict';
/* API keys for the humanize providers. A key is read when a run needs it, held in memory only, never written to disk, never logged and
   never part of a message (an error names where a key was looked for, not what it is).

   Where a key comes from, in order:
     1. the environment variable (GPTZERO_API_KEY), as the companion or the CLI was started;
     2. on macOS, the Keychain item (finance-studio-gptzero-key), unless FINANCE_STUDIO_KEYCHAIN=off.
   Store one with:  security add-generic-password -a "$USER" -s finance-studio-gptzero-key -w

   takeFromEnv(env, names) removes the variables from `env` and keeps their values in a private holder. The companion calls it before the
   agent service exists: a pilot inherits the companion's environment (backend/agents/claude-runner.cjs pilotEnv), and a detector key
   must never reach a pilot. Chrome gets an allow list of variables anyway (backend/links/chrome.cjs browserEnv). */

const childProcess = require('node:child_process');

const KEYS = Object.freeze({
  gptzero: { env: 'GPTZERO_API_KEY', keychain: 'finance-studio-gptzero-key', label: 'GPTZero API key' },
});
const KEYCHAIN_SWITCH = 'FINANCE_STUDIO_KEYCHAIN';
const SECURITY_NOT_FOUND = 44;

const usable = value => (typeof value === 'string' && /^[\x21-\x7e]{8,4096}$/.test(value.trim()) ? value.trim() : null);

function execFile(file, args, options) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, options, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
  });
}

/* A key store: get(name) -> Promise<{ key, source, error }>, describe(name) -> Promise<{ found, source, error }> (no value). */
function createKeyStore(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const run = typeof options.execFile === 'function' ? options.execFile : execFile;
  const held = new Map();
  const store = {
    /* Move the named variables out of env into this store. Returns the names that were moved. */
    takeFromEnv(names = Object.values(KEYS).map(k => k.env)) {
      const moved = [];
      for (const name of names) {
        if (typeof env[name] === 'string') {
          held.set(name, env[name]);
          delete env[name];
          moved.push(name);
        }
      }
      return moved;
    },
    async get(name) {
      const spec = KEYS[name];
      if (!spec) return { key: null, source: null, error: `unknown key ${name}` };
      const fromEnv = held.has(spec.env) ? held.get(spec.env) : env[spec.env];
      if (typeof fromEnv === 'string' && fromEnv !== '') {
        const key = usable(fromEnv);
        return key ? { key, source: 'env', error: null } : { key: null, source: 'env', error: `${spec.env} is set but does not look like a key` };
      }
      if (platform !== 'darwin' || env[KEYCHAIN_SWITCH] === 'off') return { key: null, source: null, error: null };
      try {
        const out = await run('security', ['find-generic-password', '-s', spec.keychain, '-w'], { timeout: 10000, maxBuffer: 64 * 1024, windowsHide: true });
        const key = usable(out);
        return key ? { key, source: 'keychain', error: null } : { key: null, source: 'keychain', error: `the Keychain item ${spec.keychain} does not hold a usable key` };
      } catch (error) {
        if (error && error.code === SECURITY_NOT_FOUND) return { key: null, source: null, error: null };
        return { key: null, source: 'keychain', error: `the Keychain item ${spec.keychain} could not be read` };
      }
    },
    async describe(name) {
      const { key, source, error } = await store.get(name);
      return { found: Boolean(key), source, error };
    },
  };
  return store;
}

const whereToStore = name => {
  const spec = KEYS[name];
  return spec ? `Set ${spec.env}, or on macOS store it in the Keychain: security add-generic-password -a "$USER" -s ${spec.keychain} -w` : '';
};

module.exports = { createKeyStore, whereToStore, KEYS };
