'use strict';
/* The environment the tests give the companion, the service and the stub: this process's environment without the
   variables that would route a pilot through a gateway or sign it in some other way (a build machine may set
   ANTHROPIC_BASE_URL for its own tools), and without any pilot token, so every test states its own sign-in. */

const { DROPPED_WITH_TOKEN, KEYCHAIN_SWITCH } = require('../../backend/agents/pilot-token.cjs');

/* The Keychain is switched off as well: a token stored on a developer's Mac must never reach a test. */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of DROPPED_WITH_TOKEN) delete env[name];
  return { ...env, [KEYCHAIN_SWITCH]: 'off', ...extra };
}

module.exports = { cleanEnv };
