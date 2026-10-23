'use strict';
/* The pipeline service (docs: README "Pipeline"). backend/server.cjs calls these methods and maps AgentError.status to the HTTP status.
   Every method is async, takes and returns plain JSON, and throws AgentError on a refusal.

     createPipelineService({ root, agents, links, claudeBin, spawnFn, clock, tmpRoot, env, pollMs, importTimeoutMs, onStage })
       root     the Studio project folder (state lives in <root>/private/pipelines)
       agents   the agent service (backend/agents/index.cjs): rounds and the simulated grader; its runtime() gives the pre-flight,
                the environment and the runtime path for the classifier and the designer
       links    the link loader (backend/links, createLinkLoader): start(url) -> id, get(id) -> state, continue(id), cancel(id); null
                when it is not installed (then only a folder can be imported)
       claudeBin, spawnFn, env   used only when `agents` has no runtime() (a test double)
       tmpRoot  where finance-studio-pipelines/ is created (default os.tmpdir())
       pollMs   how often the loader is asked for its state while a page loads (default 500)
       onStage  an observer called with (stage, { id, attempt }) at every stage change; for tests, errors ignored

     start(body) -> { id }          list() -> { pipelines, running, config }       get(id) -> view      busy() -> true while one runs
       body: { url | sourceDir, capUsd, model, effort, pilotCapUsd, acknowledgements, designCapUsd?, graderModel?, label?, acceptMissing? }
     continue(id) -> view           stop(id) -> view                               export(id) -> { name, size, sha256, files, zipBase64 }
     whenDone(id) -> view (waits)   shutdown() (stops everything)                  */

const { createPipelineService, PipelineService, parseLink } = require('./service.cjs');
const { redactPipelineData } = require('./redact.cjs');
const constants = require('./constants.cjs');

module.exports = { createPipelineService, PipelineService, parseLink, redactPipelineData, constants };
