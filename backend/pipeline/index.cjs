'use strict';
/* The pipeline service (docs: README "Pipeline"). backend/server.cjs calls these methods and maps AgentError.status to the HTTP status.
   Every method is async, takes and returns plain JSON, and throws AgentError on a refusal.

     createPipelineService({ root, agents, links, claudeBin, spawnFn, clock, tmpRoot, env, pollMs, importTimeoutMs, linkCloseMs, minCapCheck, confirmFiles, onStage })
       root     the Studio project folder (state lives in <root>/private/pipelines)
       agents   the agent service (backend/agents/index.cjs): rounds and the simulated grader; its runtime() gives the pre-flight,
                the environment and the runtime path for the classifier and the designer
       links    the link loader (backend/links, createLinkLoader): start(url) -> id, get(id) -> state, continue(id), cancel(id); null
                when it is not installed (then only a folder can be imported)
       claudeBin, spawnFn, env   used only when `agents` has no runtime() (a test double)
       tmpRoot  where finance-studio-pipelines/ is created (default os.tmpdir())
       pollMs   how often the loader is asked for its state while a page loads (default 500)
       linkCloseMs   how long, after a cancel, the end of a pipeline waits for the loader to close its browser (default 10000)
       minCapCheck   true: start() refuses a total cap below the cost of one full attempt (default false: the cap is the owner's, and a run that
                     cannot afford its next step ends in 'budget')
       confirmFiles  false: a link import goes straight on to the classifier. Default true: it waits first (stage import, waiting kind
                     'confirm-files') until the owner has checked the file list against the task page and pressed Continue (continue(id)
                     ends this wait itself; the loader is not asked). A folder import never waits.
       onStage  an observer called with (stage, { id, attempt }) at every stage change; for tests, errors ignored

     start(body) -> { id }          list() -> { pipelines, running, config }       get(id) -> view      busy() -> true while one runs
       body: { url | sourceDir, capUsd, model, effort, pilotCapUsd, acknowledgements, designCapUsd?, graderModel?, label?, acceptMissing? }
       capUsd must pay for one full attempt (design, the 2-pilot screen and the 5-pilot test): list().config.minCap holds the parts
       { fixedUsd, perPilotUsd, pilots, headroom } of the least cap, ceil to the cent of headroom x (fixedUsd + pilots x (pilotCapUsd + perPilotUsd))
     view.import: { fileCount, totalBytes, groups, sections, toggle, page, skipped, notes, files, facts }; notes are the loader's notes with
       any address scrubbed (at most 50 of 500 characters).
     Pilot stages: the screen bar is 0.40 (both pilots below it), the test bar 0.45 (4 of 5 below it); config.screenBar and config.testBar
       (config.passBar is the test's). Each pilot is graded as soon as its run ends and a stage ends as soon as its result is decided: the
       pilots that have not ended are cancelled (pilots[].stoppedEarly, stage.stoppedEarly = { afterPilot, score }). A score within the regrade
       band of the stage (config.screenRegradeBand, config.testRegradeBand) is graded twice and averaged first.
     continue(id) -> view           stop(id) -> view                               export(id) -> { name, size, sha256, files, zipBase64 }
     whenDone(id) -> view (waits)   shutdown() (stops everything)                  */

const { createPipelineService, PipelineService, parseLink } = require('./service.cjs');
const { redactPipelineData } = require('./redact.cjs');
const constants = require('./constants.cjs');

module.exports = { createPipelineService, PipelineService, parseLink, redactPipelineData, constants };
