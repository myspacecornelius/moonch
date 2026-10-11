'use strict';
/* The local agent service (docs/local-agents.md). backend/server.cjs calls these methods and maps AgentError.status to
   the HTTP status. Every method is async, takes and returns plain JSON, and throws AgentError on a refusal.

     createAgentService({ root, env, spawnFn, claudeBin, clock, tmpRoot, companionPort })
       root       the Studio project folder (round state lives in <root>/private/agent-rounds)
       env        environment handed to every pilot (default process.env)
       spawnFn    replaces child_process.spawn (tests)
       claudeBin  use exactly this binary instead of detecting one (tests use backend/agents/stub-claude.cjs)
       clock      () => Date or milliseconds
       tmpRoot    where finance-studio-pilots/ is created (default os.tmpdir())
       companionPort  the companion's port, when it is known in advance (otherwise setCompanionPort after listen)
     Test only: limits ({ timeoutMs, killGraceMs, concurrency, drainMs } can be lowered, never raised), exists,
     execFile, home, pilotToken (the dedicated pilot sign-in, instead of reading it) and readPilotToken (replaces the
     Keychain and environment read, pilot-token.cjs). */

const { RoundStore, AgentError } = require('./rounds.cjs');

function createAgentService(options = {}) {
  const store = new RoundStore(options);
  /* async wrappers turn a synchronous throw into a rejection, so callers handle one failure style. */
  return {
    status: async () => store.status(),
    inspectPacket: async body => store.inspectPacket(body),
    createRound: async body => store.createRound(body),
    nextRound: async id => store.nextRound(id),
    approvalSummary: async id => store.approvalSummary(id),
    preflightRound: async id => store.preflightRound(id),
    freezeRound: async (id, body) => store.freezeRound(id, body),
    refreezeRound: async (id, body) => store.refreezeRound(id, body),
    approveRound: async (id, body) => store.approveRound(id, body),
    launchRound: async id => store.launchRound(id),
    listRounds: async () => store.listRounds(),
    getRound: async id => store.getRound(id),
    getRun: async (id, n) => store.getRun(id, n),
    classifyRun: async (id, n, body) => store.classifyRun(id, n, body),
    cancelRound: async id => store.cancelRound(id),
    exportRound: async id => store.exportRound(id),
    graderSim: async body => store.graderSim(body),
    authorReview: async body => store.authorReview(body),
    /* Not part of the HTTP API. setCompanionPort is called by the companion once it listens (the loopback audit);
       whenSettled resolves when a launched round has ended; shutdown cancels every live round (call it from the
       companion's SIGINT and SIGTERM handlers) and waits for the processes to stop. */
    setCompanionPort: async port => store.setCompanionPort(port),
    whenSettled: async id => store.whenSettled(id),
    shutdown: async () => store.shutdown(),
  };
}

module.exports = { createAgentService, AgentError };
