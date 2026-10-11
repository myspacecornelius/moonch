'use strict';
/* The environment the tests give the companion, the service and the stub: this process's environment without the
   variables that would route a pilot through a gateway or sign it in some other way (a build machine may set
   ANTHROPIC_BASE_URL for its own tools), and without any pilot token, so every test states its own sign-in. */

const { DROPPED_WITH_TOKEN } = require('../../backend/agents/pilot-token.cjs');

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of DROPPED_WITH_TOKEN) delete env[name];
  return { ...env, ...extra };
}

module.exports = { cleanEnv };
