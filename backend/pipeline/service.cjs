'use strict';
/* The pipeline orchestrator: link or folder -> classify -> design traps -> 2-pilot screen -> 5-pilot test, with redesigns, one total
   spending cap and one approval for the whole run. Pilots and the simulated grader are the agent service's (rounds, graderSim); the
   classifier, the trap designer and the fairness review are runs of models.cjs. The link loader is only reached through
   createLinkLoader's API (start, get, continue, cancel).

   One pipeline at a time, and none while a round runs. State lives in <root>/private/pipelines/<id>/state.json (atomic), with the
   downloaded files (original/), the designer's folder (designer/), its runs (runs/) and the design of each attempt
   (attempts/<n>/out). Only the pilot packet, work/filesystem, is OUTSIDE the project, in <tmpRoot>/finance-studio-pipelines/<id>/, and
   that folder is removed when the pipeline ends.

   Stages: import -> classify -> design -> screen -> grade-screen -> (redesign -> design ...) -> test -> grade-test -> done,
   or failed | stopped | budget at any point. A design is checked before any pilot runs (the golden answer must score well against its own
   guideline, the guideline must be fair, nothing may leak into the prompt); a design that fails a check is rejected and uses a redesign. */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AgentError, buildGraderPrompt, parseGraderOutput } = require('../agents/rounds.cjs');
const C = require('../agents/constants.cjs');
const { budgetText } = require('../agents/claude-runner.cjs');
const { checkPilotsRoot, resolveSourceDir } = require('../agents/pilot-folder.cjs');
const P = require('./constants.cjs');
const { isObject, sha256Hex, clone, capText, oneLine, writeJsonAtomic, writeTextAtomic, readJson, within, delay, readTextFile, hashFile, squash, Stopped, copyHashed, isJunkName, TEXT_EXTENSIONS } = require('./util.cjs');
const { IntakeError, intakeFromLoader, intakeFromFolder } = require('./intake.cjs');
const { buildClassifierPrompt, classify } = require('./classify.cjs');
const { DesignError, catalogText, designerPrompt, repairPrompt, rejectionFeedback, feedbackText, readDesign, scanDesignFiles, buildWork, numbersIn, canonNumber } = require('./design.cjs');
const { minCapParts, minCapUsd } = require('./budget.cjs');
const { SafetyError, verifyPacket, verifyRoundPacket, leakWindows, containsLeak } = require('./safety.cjs');
const { extractText, textHoldsWindows, ZIP_EXTENSIONS } = require('./extract.cjs');
const { buildFairnessPrompt, parseFairness, composeGraderInput, graderEffort, regradeBand } = require('./gates.cjs');
const { runtimeOf, runToolLess, runDesigner, NOT_FOUND } = require('./models.cjs');
const { buildExport } = require('./export.cjs');

const SCHEMA = 'finance-pipeline';
const SCHEMA_VERSION = 1;
const MAX_LABEL = 60;
const GRADER_FOOTER = '\n\nScoring scale for this rehearsal: report "score" as a number from 0 to 1, the share of the points the guidance names that the answer earns (1 means every point is met, 0 means none), and list each point in "items".';
const MAX_ANSWER_FOR_GRADER = 59000;
const MAX_REASON = 1500;
const MAX_OUTPUT_FILES = 50;
const MAX_CORPUS_CHARS = 24 * 1024 * 1024;
const UNREADABLE_FINAL_CHARS = 600; /* a final message shorter than this, with files written and none readable, is not gradable */

class StopSignal extends Error {}
class BudgetStop extends Error {}
/* A failure whose message is safe to show the owner as it is. */
class Failure extends Error {}
/* A design that failed a check before any pilot ran. reasons are safe to show; details go to the designer's feedback only. */
class AttemptRejected extends Error {
  constructor(kind, reasons, details) {
    super(reasons[0]);
    this.kind = kind;
    this.reasons = reasons;
    this.details = details || reasons;
  }
}

const bad = message => new AgentError(400, message);
const round6 = value => Math.round(value * 1e6) / 1e6;
const money = value => `USD ${value.toFixed(2)}`;
const isTerminal = stage => P.TERMINAL.includes(stage);
const LOADER_MESSAGE_CHARS = 1000;
const CONFIRM_FILES_MESSAGE = 'Check the file list against the task page. Press Continue if every file is there, or Stop and use Import from folder.';
const HEADROOM_TEXT = `${Math.round((P.HEADROOM - 1) * 100)}% headroom`;

/* The promise, or undefined after `ms` (the timer is cleared, so it never keeps the process alive). */
function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise(resolve => { timer = setTimeout(resolve, ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/* ------------------------------------------------------------------ input checks */

/* An https address (http only for a loopback host, for the tests), without credentials. Returns { origin, path }: the query and the
   fragment are dropped because they can carry a token; this is all the pipeline ever stores or shows of the address. */
function parseLink(text) {
  if (typeof text !== 'string' || !text.trim()) throw bad('url must be text');
  const value = text.trim();
  if (value.length > 2048 || /[\u0000- \u007f]/.test(value)) throw bad('That is not a usable address');
  let url;
  try { url = new URL(value); } catch { throw bad('That is not a usable address'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw bad('The address must start with https://');
  if (url.username || url.password) throw bad('The address must not hold a user name or a password');
  return { origin: url.origin, path: url.pathname };
}

function checkMoney(value, what, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw bad(`${what} must be a number of US dollars`);
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 1e-6 || cents < Math.round(min * 100) || cents > Math.round(max * 100)) {
    throw bad(`${what} must be from ${min.toFixed(2)} to ${max.toFixed(2)} US dollars, in whole cents`);
  }
  return cents / 100;
}

/* ------------------------------------------------------------------ the service */

class PipelineService {
  constructor(options = {}) {
    this.root = path.resolve(options.root || path.join(__dirname, '..', '..'));
    this.agents = options.agents;
    if (!this.agents || typeof this.agents.createRound !== 'function') throw new TypeError('createPipelineService needs the agent service');
    this.links = options.links || null;
    this.clock = typeof options.clock === 'function' ? options.clock : () => new Date();
    this.tmpRoot = path.resolve(options.tmpRoot || require('node:os').tmpdir());
    this.workRoot = path.join(this.tmpRoot, P.WORKSPACE_DIRNAME);
    this.dir = path.join(this.root, 'private', 'pipelines');
    this.pollMs = Number.isFinite(options.pollMs) && options.pollMs > 0 ? options.pollMs : 500;
    this.importTimeoutMs = Number.isFinite(options.importTimeoutMs) && options.importTimeoutMs > 0 ? options.importTimeoutMs : 60 * 60 * 1000;
    /* How long the pipeline waits, after it has cancelled the link load, for the loader to close its browser and scrub its profile. */
    this.linkCloseMs = Number.isFinite(options.linkCloseMs) && options.linkCloseMs >= 0 ? options.linkCloseMs : 10000;
    /* start() refuses a total cap that cannot pay for one full attempt. The tests of the budget stop turn that off to use tiny caps. */
    this.minCapCheck = options.minCapCheck === true; /* off by default: the owner sets the cap, and a run that cannot afford the next step ends in 'budget' */
    /* After a link import the pipeline waits for the owner to check the file list against the task page (the loader cannot be perfect on
       an unknown page). The tests that are not about the gate turn it off. */
    this.confirmFiles = options.confirmFiles !== false;
    /* The regrade band of each stage; a fallback band that does not suit a stage throws here, not in the middle of a run. options.regradeBands
       ({ screen, test, fallback }) is for the tests of the bands. */
    const bands = isObject(options.regradeBands) ? options.regradeBands : {};
    const bandOptions = { overrides: { screen: bands.screen === undefined ? P.SCREEN_REGRADE_BAND : bands.screen, test: bands.test === undefined ? P.TEST_REGRADE_BAND : bands.test } };
    if ('fallback' in bands) bandOptions.fallback = bands.fallback;
    this.bands = { screen: regradeBand('screen', bandOptions), test: regradeBand('test', bandOptions) };
    this.bandFallback = ('fallback' in bands ? bands.fallback : P.REGRADE_BAND).slice();
    this.onStage = typeof options.onStage === 'function' ? options.onStage : null; /* an observer for tests; errors are ignored */
    this.options = options;
    this._rt = null;
    this.pipelines = new Map(); /* id -> { state, ctl } */
    this.active = null;
    this._load();
  }

  now() {
    const value = this.clock();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }

  get rt() {
    if (!this._rt) this._rt = runtimeOf(this.agents, { root: this.root, tmpRoot: this.tmpRoot, env: this.options.env, claudeBin: this.options.claudeBin, spawnFn: this.options.spawnFn });
    return this._rt;
  }

  /* -------------------------------------------------------------- loading and saving */

  _priv(id) { return path.join(this.dir, id); }
  _stateFile(id) { return path.join(this._priv(id), 'state.json'); }
  _attemptDir(id, n) { return path.join(this._priv(id), 'attempts', String(n)); }
  _origDir(id) { return path.join(this._priv(id), 'original'); }
  _designerDir(id) { return path.join(this._priv(id), 'designer'); }
  /* The only folder outside the project: <tmpRoot>/finance-studio-pipelines/<id>/work/filesystem is the pilot packet. */
  _workspace(id) { return path.join(this.workRoot, id); }
  _packetDir(id) { return path.join(this._workspace(id), 'work', 'filesystem'); }
  _removeWorkspace(id) { try { fs.rmSync(this._workspace(id), { recursive: true, force: true }); } catch { /* a folder in use is removed by the next start */ } }

  /* A pipeline that was running when the companion stopped has nothing behind it any more: it is closed as failed. */
  _load() {
    if (!fs.existsSync(this.dir)) return;
    for (const name of fs.readdirSync(this.dir)) {
      if (!P.ID_RE.test(name)) continue;
      try {
        const state = readJson(this._stateFile(name));
        if (!isObject(state) || state.id !== name || state.schema !== SCHEMA || !isObject(state.config) || !Array.isArray(state.attempts)) continue;
        for (const attempt of state.attempts) {
          if (isObject(attempt) && attempt.outcome === 'in-progress') { attempt.outcome = 'failed'; attempt.note = 'The companion stopped while this attempt was running.'; }
        }
        if (!isTerminal(state.stage)) {
          state.stage = 'failed';
          state.waiting = null;
          state.message = 'The companion stopped while this pipeline was running, so it was closed.';
          state.error = 'interrupted';
          state.endedAt = this.now();
          state.updatedAt = state.endedAt;
          state.result = { verdict: 'failed', message: state.message };
        }
        writeJsonAtomic(this._stateFile(name), state);
        this._removeWorkspace(name); /* a working folder left by an earlier start (or by a version that kept more there) */
        this.pipelines.set(name, { state, ctl: null });
      } catch {
        /* A damaged record is left alone on disk and not offered. */
      }
    }
  }

  _save(p) {
    p.updatedAt = this.now();
    fs.mkdirSync(path.join(this.dir, p.id), { recursive: true, mode: 0o700 });
    writeJsonAtomic(this._stateFile(p.id), p);
  }

  _entry(id) {
    if (typeof id !== 'string' || !P.ID_RE.test(id)) throw bad('That is not a valid pipeline id');
    const entry = this.pipelines.get(id);
    if (!entry) throw new AgentError(404, 'No such pipeline');
    return entry;
  }

  /* quotes: true when the message quotes the reasons a design was rejected (redact.cjs withholds such a message while a round runs). */
  _setStage(p, stage, message, quotes = false) {
    p.stage = stage;
    p.message = message;
    p.quotesRejection = quotes === true;
    this._save(p);
    if (this.onStage) { try { this.onStage(stage, { id: p.id, attempt: p.attempt }); } catch { /* an observer never changes a run */ } }
  }

  /* The line the page shows, changed without a change of stage. */
  _note(p, message) {
    p.message = message;
    p.quotesRejection = false;
    this._save(p);
  }

  /* -------------------------------------------------------------- budget */

  /* Stops before a step whose worst case, with P.HEADROOM on top (a run can end a little over its cap), does not fit under the cap. */
  _reserve(p, what, usd) {
    const need = round6(usd * P.HEADROOM);
    if (round6(p.spentUsd + need) > p.config.capUsd + 1e-9) {
      throw new BudgetStop(`Stopped before ${what}: ${money(p.spentUsd)} spent, the step could cost up to ${money(need)} (with ${HEADROOM_TEXT}), and the cap is ${money(p.config.capUsd)}.`);
    }
  }

  /* cost: the number the run reported, or null. A run that started and reported none is counted at its cap (estimated). */
  _spend(p, stage, kind, ref, cost, cap, started) {
    const known = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0;
    const usd = known ? cost : started ? cap : 0;
    if (!known && !started) return 0;
    p.spentUsd = round6(p.spentUsd + usd);
    p.ledger.push({ at: this.now(), stage, kind, ref, costUsd: round6(usd), estimated: !known });
    this._save(p);
    return usd;
  }

  _checkStop(ctl) {
    if (ctl.stop) throw new StopSignal('stopped');
  }

  /* The onRunner hook of a model run: the runner is remembered for Stop, and when Stop was pressed before it existed it is cancelled
     now, before it has spawned a process (ClaudeRun.cancel before start ends the run without starting the program). */
  _track(ctl) {
    return runner => {
      ctl.runner = runner;
      if (runner && ctl.stop) runner.cancel();
    };
  }

  /* One cancel of the link load, however many times Stop asks, and then the wait until the loader has really ended (its browser closed,
     its profile scrubbed), at most linkCloseMs: the pipeline does not report an end, and busy() does not turn false, while Chrome is
     still closing. Every caller gets the same promise. */
  _cancelLink(ctl) {
    if (!ctl.linkId || !this.links) return Promise.resolve();
    if (!ctl.linkClosing) {
      ctl.linkClosing = (async () => {
        if (typeof this.links.cancel === 'function') { try { await this.links.cancel(ctl.linkId); } catch { /* the loader may already be over */ } }
        if (typeof this.links.waitFor === 'function') { try { await withTimeout(Promise.resolve(this.links.waitFor(ctl.linkId)), this.linkCloseMs); } catch { /* ended, or gone */ } }
      })();
    }
    return ctl.linkClosing;
  }

  /* -------------------------------------------------------------- the HTTP-facing methods */

  /* The answer of GET /api/pipeline: the pipelines, newest first, and the rules the page shows. */
  async list() {
    const rows = [...this.pipelines.values()].map(entry => this._row(entry.state)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
    return { pipelines: rows, running: this.active, config: this._rules() };
  }

  _rules() {
    return {
      passBar: P.PASS_BAR, screenBar: P.SCREEN_BAR, testBar: P.TEST_BAR, screenPilots: P.SCREEN_PILOTS, testPilots: P.TEST_PILOTS, testNeed: P.TEST_NEED, maxRedesigns: P.MAX_REDESIGNS,
      defaultCapUsd: P.DEFAULT_CAP_USD, maxCapUsd: P.MAX_CAP_USD, defaultPilotCapUsd: C.BUDGET_USD.pilotDefault,
      minPilotCapUsd: C.BUDGET_USD.minUsd, maxPilotCapUsd: C.BUDGET_USD.maxUsd, designCapUsd: P.CAPS.designUsd, classifyCapUsd: P.CAPS.classifyUsd, graderCapUsd: P.CAPS.graderUsd,
      repairCapUsd: P.CAPS.repairUsd, fairnessCapUsd: P.CAPS.fairnessUsd, goldenMin: P.GOLDEN_MIN, regradeBand: this.bandFallback.slice(), screenRegradeBand: this.bands.screen.slice(), testRegradeBand: this.bands.test.slice(), headroom: P.HEADROOM,
      /* The total cap must be at least ceil to the cent of headroom x (fixedUsd + pilots x (pilotCapUsd + perPilotUsd)); fixedUsd is at the default designer cap. */
      minCap: minCapParts(),
      stages: P.STAGES.slice(), acknowledgements: P.ACKNOWLEDGEMENTS.slice(), linksAvailable: Boolean(this.links),
      models: C.MODELS.slice(), efforts: C.EFFORTS.slice(), defaultModel: C.DEFAULT_MODEL, defaultEffort: C.DEFAULT_EFFORT, graderModel: C.GRADER_MODEL,
    };
  }

  _row(p) {
    return {
      id: p.id, label: p.label, createdAt: p.createdAt, updatedAt: p.updatedAt, endedAt: p.endedAt,
      stage: p.stage, running: !isTerminal(p.stage), message: p.message, quotesRejection: p.quotesRejection === true, spentUsd: p.spentUsd, capUsd: p.config.capUsd,
      attempt: p.attempt, redesigns: p.redesigns, verdict: p.result ? p.result.verdict : null,
    };
  }

  async get(id) {
    return this._view(this._entry(id).state);
  }

  /* Is a pipeline running? The companion refuses other launches and the simulated grader while one is (backend/server.cjs). */
  busy() {
    return this.active !== null;
  }

  /* start(body): { url | sourceDir, capUsd, model, effort, pilotCapUsd, designCapUsd?, graderModel?, label?, acceptMissing?, acknowledgements } -> { id }.
     Everything is checked here, in one synchronous block, before anything is created or started. */
  async start(body) {
    if (!isObject(body)) throw bad('The request body must be an object');
    const hasUrl = body.url !== undefined && body.url !== null && body.url !== '';
    const hasDir = body.sourceDir !== undefined && body.sourceDir !== null && body.sourceDir !== '';
    if (hasUrl === hasDir) throw bad('Give either url or sourceDir, not both and not neither');
    const acknowledged = Array.isArray(body.acknowledgements) ? body.acknowledgements : null;
    if (!acknowledged || acknowledged.length !== P.ACKNOWLEDGEMENTS.length || new Set(acknowledged).size !== acknowledged.length || !P.ACKNOWLEDGEMENTS.every(item => acknowledged.includes(item))) {
      throw bad(`Every acknowledgement is required, and no other: ${P.ACKNOWLEDGEMENTS.join(', ')}`);
    }
    const capUsd = body.capUsd === undefined || body.capUsd === null ? P.DEFAULT_CAP_USD : checkMoney(body.capUsd, 'The total cap', 0.01, P.MAX_CAP_USD);
    const model = body.model === undefined || body.model === null ? C.DEFAULT_MODEL : body.model;
    if (typeof model !== 'string' || !C.MODELS.includes(model)) throw bad(`The model must be one of: ${C.MODELS.join(', ')}`);
    const effort = body.effort === undefined || body.effort === null ? C.DEFAULT_EFFORT : body.effort;
    if (typeof effort !== 'string' || !C.EFFORTS.includes(effort)) throw bad(`The effort must be one of: ${C.EFFORTS.join(', ')}`);
    const graderModel = body.graderModel === undefined || body.graderModel === null ? C.GRADER_MODEL : body.graderModel;
    if (typeof graderModel !== 'string' || !C.MODELS.includes(graderModel)) throw bad(`The grader model must be one of: ${C.MODELS.join(', ')}`);
    const pilotCapUsd = body.pilotCapUsd === undefined || body.pilotCapUsd === null ? C.BUDGET_USD.pilotDefault : body.pilotCapUsd;
    if (budgetText(pilotCapUsd) === null) throw bad(`The spending cap per pilot must be a number of US dollars from ${C.BUDGET_USD.minUsd.toFixed(2)} to ${C.BUDGET_USD.maxUsd.toFixed(2)}, in whole cents`);
    /* The designer's cap, when none is given: USD 5.00 (the minimum total cap is worked out from it, so it does not move with the total). */
    const designCapUsd = body.designCapUsd === undefined || body.designCapUsd === null ? P.CAPS.designUsd : body.designCapUsd;
    if (budgetText(designCapUsd) === null) throw bad(`The spending cap for the designer must be a number of US dollars from ${C.BUDGET_USD.minUsd.toFixed(2)} to ${C.BUDGET_USD.maxUsd.toFixed(2)}, in whole cents`);
    /* A total cap that cannot pay for one full attempt would stop at the cap before the 5-pilot test: refuse it now, and say what it needs. */
    if (this.minCapCheck) {
      const least = minCapUsd({ designCapUsd, pilotCapUsd });
      if (capUsd + 1e-9 < least) {
        throw bad(`A full attempt (design, the ${P.SCREEN_PILOTS}-pilot screen and the ${P.TEST_PILOTS}-pilot test) can cost up to ${money(least)} with these caps; set the total cap to at least ${money(least)}`);
      }
    }
    if (body.label !== undefined && body.label !== null && typeof body.label !== 'string') throw bad('label must be text');
    if (body.acceptMissing !== undefined && body.acceptMissing !== null && typeof body.acceptMissing !== 'boolean') throw bad('acceptMissing must be true or false');
    let source;
    let url = null;
    let realDir = null;
    if (hasUrl) {
      if (!this.links) throw new AgentError(409, 'The link loader is not available in this companion. Download the files by hand and use a folder instead');
      source = { kind: 'url', ...parseLink(body.url) };
      url = body.url.trim();
    } else {
      if (typeof body.sourceDir !== 'string') throw bad('sourceDir must be text');
      try { realDir = resolveSourceDir(body.sourceDir, this.root); } catch (error) {
        if (error && error.name === 'PacketError') throw new AgentError(error.status, error.message);
        throw error;
      }
      for (const own of [path.join(this.tmpRoot, 'finance-studio-pilots'), this.workRoot]) {
        let ownReal = own;
        try { ownReal = fs.realpathSync(own); } catch { /* not created yet */ }
        if (within(realDir, ownReal) || within(ownReal, realDir)) throw bad('That folder holds working folders of the Studio. Choose the folder the task files are in');
      }
      source = { kind: 'folder', name: oneLine(path.basename(realDir), 120) };
    }
    if (this.active) throw new AgentError(409, 'A pipeline is already running. Stop it or wait for it to end');
    const id = this._newId();
    this.active = id; /* claimed before the first await, so two starts that arrive together cannot both go on */
    let entry;
    try {
      const rows = await this.agents.listRounds();
      if (!Array.isArray(rows) || rows.some(row => isObject(row) && row.status === 'running')) throw new AgentError(409, 'A round of pilots is running. Start the pipeline when it has ended');
      /* Before Chrome is opened for a link: is there a Claude Code to run the classifier? */
      const runtime = await this.rt.detect(true);
      if (!runtime || !runtime.found) throw new AgentError(409, NOT_FOUND);
      const createdAt = this.now();
      const label = oneLine(body.label, MAX_LABEL) || `Pipeline ${id.slice(4, 10)}`;
      const state = {
        schema: SCHEMA, schemaVersion: SCHEMA_VERSION, id, label, createdAt, updatedAt: createdAt, endedAt: null,
        stage: 'import', message: 'Starting', error: null, waiting: null, source,
        config: { capUsd, pilotCapUsd, designCapUsd, model, effort, graderModel, graderEffort: graderEffort(effort), acceptMissing: body.acceptMissing === true, passBar: P.PASS_BAR, screenBar: P.SCREEN_BAR, testBar: P.TEST_BAR, screenPilots: P.SCREEN_PILOTS, testPilots: P.TEST_PILOTS, testNeed: P.TEST_NEED, maxRedesigns: P.MAX_REDESIGNS },
        acknowledgements: P.ACKNOWLEDGEMENTS.slice(),
        loader: null, spentUsd: 0, ledger: [], import: null, classification: null, attempt: 0, redesigns: 0, design: null, attempts: [], result: null,
      };
      this._makeWorkspace(id);
      this._save(state);
      const ctl = { stop: false, url, realDir, linkId: null, runner: null, roundId: null, answers: new Map(), done: null, texts: null, packet: null, manifest: null, feedback: '', sections: [] };
      entry = { state, ctl };
      this.pipelines.set(id, entry);
      ctl.done = this._run(state, ctl).catch(() => {});
    } catch (error) {
      if (!entry) this.active = null;
      throw error;
    }
    return { id };
  }

  _newId() {
    let id;
    do { id = 'pln-' + crypto.randomBytes(6).toString('hex'); } while (this.pipelines.has(id));
    return id;
  }

  /* The private folders of the pipeline, and <tmpRoot>/finance-studio-pipelines/<id>/work, outside the project: a link or a foreign owner
     is refused. */
  _makeWorkspace(id) {
    try {
      fs.mkdirSync(this.workRoot, { recursive: true, mode: 0o700 });
      checkPilotsRoot(this.workRoot);
      const real = fs.realpathSync(this.workRoot);
      let project = this.root;
      try { project = fs.realpathSync(this.root); } catch { /* the root exists in practice */ }
      if (within(real, project)) throw new AgentError(409, 'The working folder would be inside the Studio project. Choose another temporary folder');
      fs.mkdirSync(this._workspace(id), { mode: 0o700 });
      fs.mkdirSync(path.join(this._workspace(id), 'work'), { mode: 0o700 });
      for (const sub of ['original', 'runs']) fs.mkdirSync(path.join(this._priv(id), sub), { recursive: true, mode: 0o700 });
    } catch (error) {
      if (error instanceof AgentError) throw error;
      if (error && error.name === 'PacketError') throw new AgentError(error.status, error.message);
      throw new AgentError(409, 'The working folder could not be made. Nothing was started');
    }
  }

  /* The owner pressed Continue after signing in or turning on the option that shows all files. */
  async continue(id) {
    const { state: p, ctl } = this._entry(id);
    if (isTerminal(p.stage) || !p.waiting || !ctl) throw new AgentError(409, 'Nothing is waiting for you');
    /* The owner has checked the files: this wait is the pipeline's own, the loader is not asked. */
    if (p.waiting.kind === 'confirm-files') {
      const resume = ctl.confirm;
      ctl.confirm = null;
      p.waiting = null;
      this._save(p);
      if (resume) resume();
      return this._view(p);
    }
    if (!ctl.linkId) throw new AgentError(409, 'Nothing is waiting for you');
    if (!this.links || typeof this.links.continue !== 'function') throw new AgentError(409, 'The link loader cannot continue');
    try {
      await this.links.continue(ctl.linkId);
    } catch (error) {
      /* The loader moved on by itself (it left the wait, or the wait timed out): nothing is waiting any more. Any other fault is the loader's. */
      const stale = Boolean(error) && error.status === 409;
      if (stale) { p.waiting = null; this._save(p); }
      throw new AgentError(stale ? 409 : 502, this._scrubLink(error && error.message) || 'The link loader could not continue');
    }
    p.waiting = null;
    this._save(p);
    return this._view(p);
  }

  /* Stops the pipeline: the link load, the model run or the round that is in progress is cancelled and the state becomes stopped. */
  async stop(id) {
    const { state: p, ctl } = this._entry(id);
    if (isTerminal(p.stage) || !ctl) throw new AgentError(409, 'This pipeline has already ended');
    await this._stopAndWait(ctl);
    return this._view(p);
  }

  /* Asks whatever is in progress to stop, again and again until the run has ended (at most 20 seconds): a process that was about to
     start when the request came is caught by the next ask. */
  async _stopAndWait(ctl) {
    ctl.stop = true;
    let over = false;
    ctl.done.then(() => { over = true; });
    const deadline = Date.now() + 20000;
    while (!over && Date.now() < deadline) {
      await this._cancelCurrent(ctl);
      await withTimeout(ctl.done, 150);
    }
  }

  async _cancelCurrent(ctl) {
    const tasks = [];
    if (ctl.confirm) { const resume = ctl.confirm; ctl.confirm = null; resume(); } /* the wait for the owner ends; the run sees the stop */
    tasks.push(this._cancelLink(ctl));
    if (ctl.runner) { try { ctl.runner.cancel(); } catch { /* already over */ } }
    if (ctl.graderRunning) { for (const runner of this.rt.runners) { try { runner.cancel(); } catch { /* already over */ } } }
    if (ctl.roundId && ctl.roundCancelled !== ctl.roundId) {
      ctl.roundCancelled = ctl.roundId;
      tasks.push(Promise.resolve().then(() => this.agents.cancelRound(ctl.roundId)).catch(() => {}));
    }
    await Promise.all(tasks);
  }

  /* Stops everything that is running (the companion is closing). */
  async shutdown() {
    const waits = [];
    for (const { state, ctl } of this.pipelines.values()) {
      if (isTerminal(state.stage) || !ctl) continue;
      waits.push(this._stopAndWait(ctl));
    }
    await Promise.all(waits);
    if (this.links && typeof this.links.shutdown === 'function') { try { await this.links.shutdown(); } catch { /* the loader is closing anyway */ } }
  }

  /* Resolves when the pipeline has reached a final stage (for tests and for callers that wait). */
  async whenDone(id) {
    const { state, ctl } = this._entry(id);
    if (ctl && ctl.done) await ctl.done;
    return this._view(state);
  }

  /* The private zip of the final design. Refused while any round runs: it holds the guideline and the golden answer. */
  async export(id) {
    const { state: p } = this._entry(id);
    if (!isTerminal(p.stage)) throw new AgentError(409, 'The pipeline is still running. Export it when it has ended');
    if (!p.design) throw new AgentError(409, 'This pipeline made no design to export');
    const rows = await this.agents.listRounds();
    if (!Array.isArray(rows) || rows.some(row => isObject(row) && row.status === 'running')) throw new AgentError(409, 'A round of pilots is running. The export holds the guideline and the golden answer, so it waits until the round has ended');
    const outDir = path.join(this._attemptDir(p.id, p.design.attempt), 'out');
    let built;
    try {
      built = buildExport({ outDir, state: this._exportState(p), note: this._exportNote(p) });
    } catch (error) {
      throw new AgentError(409, `The export could not be made (${oneLine(error && error.message, 160)})`);
    }
    return { name: built.name, size: built.bytes.length, sha256: built.sha256, files: built.files, zipBase64: Buffer.from(built.bytes).toString('base64') };
  }

  _exportState(p) {
    return { label: p.label, stage: p.stage, message: p.message, attempts: p.attempts, redesigns: p.redesigns, spentUsd: p.spentUsd, config: p.config, designAttempt: p.design ? p.design.attempt : null };
  }

  /* What became of the design that is exported (p.design.attempt, which is not always the last attempt: later ones may have been rejected). */
  _exportNote(p) {
    const attempt = p.design ? p.attempts.find(item => item.n === p.design.attempt) : null;
    const outcome = attempt ? attempt.outcome : null;
    if (outcome === 'passed') return 'this design passed the test';
    if (outcome === 'screen-failed') return 'this design did not pass the screen';
    if (outcome === 'test-failed') return 'this design did not pass the test';
    return 'this design was not judged: the run ended before its pilots finished';
  }

  /* -------------------------------------------------------------- views */

  _designTexts(p) {
    if (!p.design) return null;
    const outDir = path.join(this._attemptDir(p.id, p.design.attempt), 'out');
    const read = name => { try { return fs.readFileSync(path.join(outDir, name), 'utf8').replace(/\s+$/, ''); } catch { return ''; } };
    return { prompt: read('prompt.txt'), guideline: read('guideline.md'), goldenAnswer: read('golden-answer.md') };
  }

  _view(p) {
    const texts = this._designTexts(p);
    const design = p.design ? {
      attempt: p.design.attempt,
      traps: clone(p.design.traps),
      gold: clone(p.design.gold),
      fingerprints: clone(p.design.fingerprints),
      newFiles: p.design.newFiles.map(file => ({ name: file.name, bytes: file.bytes })),
      editedFiles: p.design.editedFiles.map(file => ({ name: file.name, reason: file.reason, bytes: file.bytes, beforeBytes: file.beforeBytes, diff: file.diff })),
      packet: clone(p.design.packet),
      audit: clone(p.design.audit),
      notes: p.design.notes.slice(),
      repaired: p.design.repaired === true,
      calibration: clone(p.design.calibration),
      fairness: clone(p.design.fairness),
      guidelineDiff: clone(p.design.guidelineDiff),
      rubricChanges: clone(p.design.rubricChanges),
      /* New or edited files whose content could not be read as text, so they were not checked for passages of the withheld material: [{ name, kind: 'new'|'edited' }] */
      unscanned: Array.isArray(p.design.unscanned) ? clone(p.design.unscanned) : [],
      prompt: texts.prompt,
      guideline: texts.guideline,
      goldenAnswer: texts.goldenAnswer,
    } : null;
    /* A reference to the prompt, the guideline or the golden answer: names only, {section, number} or {file}. */
    const ref = item => (item ? (item.kind === 'section' ? { kind: 'section', section: item.name, number: item.index + 1 } : { kind: 'file', file: item.name }) : null);
    const c = p.classification;
    const classification = c ? { ...c, prompt: ref(c.prompt), guideline: ref(c.guideline), goldenAnswer: ref(c.goldenAnswer) } : null;
    return clone({
      schema: p.schema, schemaVersion: p.schemaVersion, id: p.id, label: p.label, createdAt: p.createdAt, updatedAt: p.updatedAt, endedAt: p.endedAt,
      stage: p.stage, running: !isTerminal(p.stage), message: p.message, quotesRejection: p.quotesRejection === true, summary: p.result ? p.result.message : '', error: p.error, waiting: p.waiting, source: p.source,
      config: p.config, capUsd: p.config.capUsd, pilotCapUsd: p.config.pilotCapUsd, model: p.config.model, effort: p.config.effort,
      acknowledgements: p.acknowledgements, spentUsd: p.spentUsd, remainingUsd: round6(Math.max(0, p.config.capUsd - p.spentUsd)), ledger: p.ledger,
      loader: p.loader, import: p.import, classification, attempt: p.attempt, redesigns: p.redesigns, design, attempts: p.attempts, result: p.result,
    });
  }

  /* -------------------------------------------------------------- the run */

  async _run(p, ctl) {
    try {
      await this._import(p, ctl);
      await this._classify(p, ctl);
      for (;;) {
        let rejection = null;
        try {
          await this._design(p, ctl);
        } catch (error) {
          if (!(error instanceof AttemptRejected)) throw error;
          rejection = error;
        }
        const attempt = p.attempts[p.attempts.length - 1];
        if (rejection) {
          /* The design failed a check before any pilot ran: it uses a redesign, and the designer is told what was wrong. */
          attempt.outcome = 'rejected';
          attempt.rejection = { kind: rejection.kind, reasons: rejection.reasons };
          if (p.redesigns >= P.MAX_REDESIGNS) {
            return this._finish(p, 'failed', `Stopped after ${P.MAX_REDESIGNS} redesigns: the design of attempt ${attempt.n} was rejected before any pilot ran (${rejection.reasons[0]}). Nothing from it was run.`, 'failed', true);
          }
          p.redesigns++;
          this._setStage(p, 'redesign', `The design was rejected (${rejection.reasons[0]}). Preparing feedback for redesign ${p.redesigns} of ${P.MAX_REDESIGNS}.`, true);
          this._prepareRejectionFeedback(p, ctl, attempt, rejection);
          continue;
        }
        const screen = await this._pilotStage(p, ctl, 'screen');
        if (screen.passed) {
          const test = await this._pilotStage(p, ctl, 'test');
          if (test.passed) {
            attempt.outcome = 'passed';
            return this._finish(p, 'done', `The test passed: ${test.belowBar} of ${test.of} pilots scored below ${test.bar.toFixed(2)}${this._stoppedNote(test)} (design attempt ${attempt.n}). Export the private zip to take the design away.`, 'success');
          }
          attempt.outcome = 'test-failed';
        } else {
          attempt.outcome = 'screen-failed';
        }
        const failed = attempt.outcome === 'screen-failed' ? attempt.screen : attempt.test;
        if (p.redesigns >= P.MAX_REDESIGNS) {
          return this._finish(p, 'failed', `Stopped after ${P.MAX_REDESIGNS} redesigns: the ${failed.name} of attempt ${attempt.n} did not pass (${failed.belowBar} of ${failed.of} pilots scored below ${failed.bar.toFixed(2)}; the rule needs ${failed.need}${this._stoppedNote(failed)}). The last design is kept for you to look at.`, 'failed');
        }
        p.redesigns++;
        this._setStage(p, 'redesign', `The ${failed.name} did not pass. Preparing feedback for redesign ${p.redesigns} of ${P.MAX_REDESIGNS}.`);
        this._prepareFeedback(p, ctl, attempt, failed);
      }
    } catch (error) {
      this._fail(p, ctl, error);
    } finally {
      ctl.runner = null;
      ctl.roundId = null;
      ctl.answers.clear();
      if (this.active === p.id) this.active = null;
    }
  }

  /* Every end of a pipeline comes through here: the result is recorded and the pilot packet outside the project is removed. */
  _finish(p, stage, message, verdict, quotes = false) {
    p.waiting = null;
    p.endedAt = this.now();
    p.result = { verdict, message };
    this._removeWorkspace(p.id);
    this._setStage(p, stage, message, quotes);
  }

  _fail(p, ctl, error) {
    if (error instanceof StopSignal || error instanceof Stopped) {
      const attempt = p.attempts[p.attempts.length - 1];
      if (attempt && attempt.outcome === 'in-progress') attempt.outcome = 'stopped';
      return this._finish(p, 'stopped', 'Stopped by the owner.', 'stopped');
    }
    if (error instanceof BudgetStop) {
      const attempt = p.attempts[p.attempts.length - 1];
      if (attempt && attempt.outcome === 'in-progress') attempt.outcome = 'budget';
      return this._finish(p, 'budget', error.message, 'budget');
    }
    let message;
    if (error instanceof SafetyError) {
      message = `SAFETY STOP: ${error.message}. Nothing was started.`;
      /* the exact file is for the owner, in the pipeline's private folder */
      try { writeTextAtomic(path.join(this.dir, p.id, 'error.log'), `${error.detail}\n`); } catch { /* the message above is enough to stop */ }
    }
    else if (error instanceof Failure || error instanceof DesignError || error instanceof IntakeError || error instanceof AgentError) message = oneLine(error.message, 400);
    else {
      message = 'The pipeline hit an internal error. The details are in its error.log.';
      try { writeTextAtomic(path.join(this.dir, p.id, 'error.log'), String(error && error.stack ? error.stack : error) + '\n'); } catch { /* nothing more to do */ }
    }
    p.error = message;
    const attempt = p.attempts[p.attempts.length - 1];
    if (attempt && attempt.outcome === 'in-progress') attempt.outcome = 'failed';
    return this._finish(p, 'failed', message, 'failed');
  }

  /* -------------------------------------------------------------- import */

  async _import(p, ctl) {
    this._setStage(p, 'import', p.source.kind === 'url' ? 'Opening the task page' : 'Reading the task folder');
    const original = this._origDir(p.id);
    let intake;
    let loaderState = null;
    if (p.source.kind === 'url') {
      const url = ctl.url;
      ctl.url = null; /* the address is held in memory only until the loader has it */
      try {
        ctl.linkId = await this.links.start(url);
      } catch (error) {
        throw new Failure(`The link loader could not start: ${this._scrubLink(error && error.message, url)}`);
      }
      if (ctl.stop) { await this._cancelLink(ctl); throw new StopSignal('stopped'); }
      try {
        loaderState = await this._pollLoader(p, ctl);
      } catch (error) {
        /* A stop ends the load: the pipeline ends when the loader has closed its browser, not before. */
        if (error instanceof StopSignal) await this._cancelLink(ctl);
        throw error;
      }
      this._setStage(p, 'import', 'Copying the downloaded files');
      intake = await intakeFromLoader({ state: loaderState, root: this.root, original, shouldStop: () => ctl.stop });
    } else {
      intake = await intakeFromFolder({ realDir: ctl.realDir, original, shouldStop: () => ctl.stop });
    }
    this._checkStop(ctl);
    ctl.sections = intake.sections;
    const groups = {};
    for (const file of intake.files) groups[file.group || '(none)'] = (groups[file.group || '(none)'] || 0) + 1;
    if (!intake.files.length) throw new Failure('The task has no files, so there is nothing to build traps on.');
    p.import = {
      fileCount: intake.files.length,
      totalBytes: intake.files.reduce((sum, file) => sum + file.bytes, 0),
      groups,
      sections: intake.sections.map(section => ({ heading: section.heading, chars: section.text.length })),
      toggle: intake.toggle,
      page: intake.page,
      skipped: intake.skipped,
      notes: Array.isArray(intake.notes) ? intake.notes : [],
      files: intake.files,
    };
    p.waiting = null;
    this._save(p);
    if (p.source.kind === 'url' && this.confirmFiles) await this._confirmFiles(p, ctl);
  }

  /* The owner checks what the loader fetched before any model is paid for. The stage stays import; continue() ends the wait without
     asking the loader, stop() ends the pipeline. The wait is not part of the import time limit (that limit is the loader's). */
  async _confirmFiles(p, ctl) {
    this._checkStop(ctl);
    const waited = new Promise(resolve => { ctl.confirm = resolve; });
    p.waiting = { kind: 'confirm-files', message: CONFIRM_FILES_MESSAGE, since: this.now() };
    this._note(p, CONFIRM_FILES_MESSAGE);
    await waited;
    ctl.confirm = null;
    this._checkStop(ctl);
    p.waiting = null;
    this._note(p, 'Files confirmed');
  }

  _scrubLink(text, url, max = 300) {
    let out = String(text === undefined || text === null ? '' : text);
    if (typeof url === 'string' && url) out = out.split(url).join('<link>');
    return oneLine(out.replace(/https?:\/\/[^\s"'<>]+/gi, '<link>'), max);
  }

  async _pollLoader(p, ctl) {
    const deadline = Date.now() + this.importTimeoutMs;
    let last = '';
    for (;;) {
      this._checkStop(ctl);
      let state;
      try {
        state = await this.links.get(ctl.linkId);
      } catch (error) {
        throw new Failure(`The link loader could not be read: ${this._scrubLink(error && error.message)}`);
      }
      if (!isObject(state)) throw new Failure('The link loader gave no state');
      /* What the loader says while it waits can be long (it lists the files it could not download): up to LOADER_MESSAGE_CHARS, with any address in it scrubbed. */
      const loaderMessage = this._scrubLink(state.message, undefined, LOADER_MESSAGE_CHARS);
      if (state.state === 'done') return state;
      if (state.state === 'failed' || state.state === 'cancelled') {
        if (ctl.stop) throw new StopSignal('stopped');
        throw new Failure(`The link loader ${state.state}${state.error || loaderMessage ? `: ${this._scrubLink(state.error || loaderMessage)}` : ''}`);
      }
      const waiting = state.state === 'needs-sign-in' || state.state === 'needs-person';
      const key = `${state.state}|${loaderMessage}`;
      if (key !== last) {
        last = key;
        p.waiting = waiting ? { kind: state.state, message: loaderMessage, since: this.now() } : null;
        p.message = waiting ? loaderMessage : loaderMessage || 'Loading the task page';
        p.loader = { state: oneLine(state.state, 40), message: loaderMessage };
        this._save(p);
      }
      if (Date.now() > deadline) {
        await this._cancelLink(ctl);
        throw new Failure('The link loader did not finish in time.');
      }
      await delay(this.pollMs);
    }
  }

  /* -------------------------------------------------------------- classify */

  _originalFile(p, name) { return path.join(this._origDir(p.id), ...name.split('/')); }

  async _classify(p, ctl) {
    this._setStage(p, 'classify', 'Classifying what was captured');
    this._checkStop(ctl);
    this._reserve(p, 'the classifier', P.CAPS.classifyUsd);
    const files = p.import.files;
    const sections = ctl.sections;
    const folder = path.join(this._priv(p.id), 'runs', 'classify');
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    this._checkStop(ctl);
    const run = await runToolLess({
      rt: this.rt, folder, prompt: buildClassifierPrompt({ sections, files }), model: p.config.model, effort: p.config.effort, capUsd: P.CAPS.classifyUsd,
      onRunner: this._track(ctl),
    });
    this._spend(p, 'classify', 'classify', 'classifier', run.costUsd, P.CAPS.classifyUsd, !run.summary.spawnError);
    if (run.summary.state === 'cancelled' || ctl.stop) throw new StopSignal('stopped');
    const usable = run.summary.state === 'completed' && run.toolCalls === 0;
    const settled = classify({ answer: usable ? run.summary.result.text : null, sections, files });
    if (!usable && run.toolCalls > 0) settled.notes.push('The classifier tried to use a tool, so its answer was discarded.');
    if (settled.problems.length) {
      throw new Failure(`Could not tell which part of the page is ${settled.problems.join(' and ')}. Name them in the page text or the file names, or load the task by hand.`);
    }
    delete settled.problems;
    /* A file that looks like the golden answer, when none was named: stop rather than guess. */
    if (!settled.goldenAnswer && settled.goldenSuspects.length) {
      p.classification = settled;
      this._save(p);
      throw new Failure(`The page has a file that looks like the golden answer (${settled.goldenSuspects.slice(0, 3).map(name => oneLine(name, 80)).join(', ')}) but none was identified as the golden answer. Nothing was started. Check the page text and the file labels, then start again.`);
    }
    const byName = new Map(files.map(file => [file.name, file]));
    const withhold = (name, why) => {
      if (!settled.withheld.some(item => item.name === name)) settled.withheld.push({ name, why });
      if (!settled.warnings.some(item => item.name === name)) settled.warnings.push({ name, why });
    };
    /* A packet file that is byte for byte a withheld file is withheld too, whatever its name. */
    const withheldHashes = new Set(settled.withheld.map(item => byName.get(item.name)).filter(Boolean).map(file => file.sha256));
    const identical = list => list.filter(name => {
      const file = byName.get(name);
      if (file && file.bytes > 0 && withheldHashes.has(file.sha256)) { withhold(name, 'it is byte for byte the same as withheld material'); return false; }
      return true;
    });
    settled.worldFiles = identical(settled.worldFiles);
    settled.taskFiles = identical(settled.taskFiles);
    ctl.texts = await this._loadOriginalTexts(p, ctl, settled);
    /* ...and so is a file that holds a passage of the guideline or the golden answer, found in the file itself: plain text, and the text of a
       word-processing, spreadsheet or slide file. What the other files say is kept to tell, later, what the original task already states. */
    const windows = [...leakWindows(ctl.texts.guideline || ctl.texts.guidelineExtracted || ''), ...leakWindows(ctl.texts.goldenAnswer || ctl.texts.goldenExtracted || '')];
    const original = { numbers: new Set(), corpus: '', guidelineLength: ctl.texts.guideline ? ctl.texts.guideline.length : null, guidelineText: ctl.texts.guideline || null };
    const addText = text => {
      for (const number of numbersIn(text)) if (number.replace(/[^0-9]/g, '').length >= 3) original.numbers.add(number);
      if (original.corpus.length < MAX_CORPUS_CHARS) original.corpus += ' ' + squash(text);
    };
    addText(ctl.texts.prompt);
    settled.unscanned = [];
    const survivors = { worldFiles: [], taskFiles: [] };
    for (const kind of ['worldFiles', 'taskFiles']) {
      for (const name of settled[kind]) {
        this._checkStop(ctl);
        const abs = this._originalFile(p, name);
        const ext = path.extname(name).toLowerCase();
        let leak = null;
        let text = null;
        if (TEXT_EXTENSIONS.has(ext)) {
          leak = await textHoldsWindows(abs, windows, () => ctl.stop);
          text = await extractText(abs, { maxChars: 1024 * 1024 });
        } else if (ZIP_EXTENSIONS.has(ext)) {
          text = await extractText(abs, { maxChars: 4 * 1024 * 1024 });
          leak = text === null ? null : containsLeak(text, windows);
        }
        if (leak === null && text === null) settled.unscanned.push(name);
        if (leak === true) { withhold(name, 'it holds a long passage of the guideline or the golden answer'); continue; }
        if (text !== null) addText(text);
        survivors[kind].push(name);
      }
    }
    this._checkStop(ctl);
    settled.worldFiles = survivors.worldFiles;
    settled.taskFiles = survivors.taskFiles;
    ctl.original = original;
    const packetNames = [...settled.worldFiles, ...settled.taskFiles];
    p.classification = settled;
    p.import.facts = { world: settled.worldFiles.length, task: settled.taskFiles.length, withheld: settled.withheld.length, other: settled.other.length };
    this._save(p);
    if (!packetNames.length) throw new Failure('No world or task file is left after the withheld files were taken out.');
    ctl.packet = new Map(packetNames.map(name => [name, { sha256: byName.get(name).sha256, bytes: byName.get(name).bytes }]));
    /* The packet must fit what the agent service takes, before a designer is paid to add to it. */
    const bytes = [...ctl.packet.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    const deepest = Math.max(...packetNames.map(name => name.split('/').length));
    if (ctl.packet.size > C.LIMITS.files) throw new Failure(`The pilot packet would hold ${ctl.packet.size} files; the limit is ${C.LIMITS.files}. Take files out of the task, then start again.`);
    if (bytes > C.LIMITS.bytes) throw new Failure(`The pilot packet would be ${Math.ceil(bytes / 1048576)} MB; the limit is ${Math.round(C.LIMITS.bytes / 1048576)} MB. Take files out of the task, then start again.`);
    if (deepest > C.LIMITS.depth) throw new Failure(`A file of the pilot packet is nested ${deepest} levels deep; the limit is ${C.LIMITS.depth}. Flatten the task, then start again.`);
    /* A file the classifier called a world or task file that the pilots would not get: stop unless the owner said that is fine. */
    if (settled.warnings.length && !p.config.acceptMissing) {
      const names = settled.warnings.slice(0, 5).map(item => oneLine(item.name, 80)).join(', ');
      throw new Failure(`${settled.warnings.length} file${settled.warnings.length === 1 ? '' : 's'} the classifier called world or task files ${settled.warnings.length === 1 ? 'is' : 'are'} withheld, so the pilots would not get ${settled.warnings.length === 1 ? 'it' : 'them'}: ${names}${settled.warnings.length > 5 ? `, and ${settled.warnings.length - 5} more` : ''}. If the pilots can do without ${settled.warnings.length === 1 ? 'it' : 'them'}, start again with acceptMissing.`);
    }
  }

  /* The text of the prompt, the guideline and the golden answer: a page section, or a text file. A guideline or golden answer that is a
     binary file (a spreadsheet, a document) is copied for the designer as it is; its text, when it can be read, only feeds the checks. */
  async _loadOriginalTexts(p, ctl, settled) {
    const out = { prompt: '', guideline: '', goldenAnswer: '', guidelineExtracted: null, goldenExtracted: null, binary: {} };
    for (const [role, ref] of [['prompt', settled.prompt], ['guideline', settled.guideline], ['goldenAnswer', settled.goldenAnswer]]) {
      if (!ref) continue;
      if (ref.kind === 'section') { out[role] = ctl.sections[ref.index].text; continue; }
      const text = readTextFile(this._originalFile(p, ref.name), P.INTAKE.textBytes);
      if (text === null) {
        if (role === 'prompt') throw new Failure('The business prompt is a file that is not text, so it cannot be used. Put the prompt on the page or in a text file.');
        out.binary[role] = ref.name;
        out[`${role === 'goldenAnswer' ? 'golden' : role}Extracted`] = await extractText(this._originalFile(p, ref.name), { maxChars: 1024 * 1024 });
      } else {
        out[role] = text;
      }
    }
    if (!out.prompt.trim()) throw new Failure('The business prompt is empty.');
    return out;
  }

  /* Hashes of everything withheld: the withheld originals, the originals' texts, and every attempt's guideline, golden answer and traps file. */
  _withheldSets(p, ctl) {
    const hashes = new Set();
    const names = new Set();
    const byName = new Map(p.import.files.map(file => [file.name, file]));
    for (const item of p.classification.withheld) {
      names.add(item.name.toLowerCase());
      const file = byName.get(item.name);
      if (file && file.bytes > 0) hashes.add(file.sha256);
    }
    for (const text of [ctl.texts.guideline, ctl.texts.goldenAnswer]) {
      if (text) { hashes.add(sha256Hex(text)); hashes.add(sha256Hex(text + '\n')); }
    }
    for (const attempt of p.attempts) {
      for (const name of ['guideline.md', 'golden-answer.md', 'traps.json']) {
        try { hashes.add(hashFile(path.join(this._attemptDir(p.id, attempt.n), 'out', name))); } catch { /* the attempt wrote no such file */ }
      }
    }
    return { hashes, names };
  }

  /* -------------------------------------------------------------- design */

  /* One attempt at a design. Resolves when the design is accepted (p.design is the new design and the pilot packet is built) and throws
     AttemptRejected when it is not: a designer that could not deliver even after a repair turn, or a design that failed a check. */
  async _design(p, ctl) {
    const n = p.attempt + 1;
    const total = P.MAX_REDESIGNS + 1;
    this._setStage(p, 'design', `Designing the traps (attempt ${n} of ${total})`);
    this._checkStop(ctl);
    this._reserve(p, 'the trap designer', p.config.designCapUsd);
    const designer = this._designerDir(p.id);
    fs.rmSync(designer, { recursive: true, force: true });
    fs.mkdirSync(path.join(designer, 'out'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(designer, '.tmp'), { recursive: true, mode: 0o700 });
    const redesign = n > 1;
    await this._writeDesignerInputs(p, ctl, designer, redesign);
    p.attempt = n;
    const attempt = { n, startedAt: this.now(), traps: [], newFiles: 0, editedFiles: 0, screen: null, test: null, outcome: 'in-progress', repaired: false, rejection: null };
    p.attempts.push(attempt);
    this._save(p);
    const attemptDir = this._attemptDir(p.id, n);
    fs.mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
    const outDir = path.join(designer, 'out');

    /* The designer's run, and what is wrong with it, if anything. A problem with the work gets one repair turn in the same folder. */
    let turn = await this._designerTurn(p, ctl, { prompt: designerPrompt({ attempt: n, attempts: total, redesign }), cap: p.config.designCapUsd, kind: 'design', ref: `attempt ${n}`, transcript: path.join(attemptDir, 'design.transcript.jsonl'), designer });
    let problem = turn.problem;
    let design = null;
    const read = () => {
      const sets = this._withheldSets(p, ctl);
      const windows = [...leakWindows(ctl.texts.guideline || ctl.texts.guidelineExtracted || ''), ...leakWindows(ctl.texts.goldenAnswer || ctl.texts.goldenExtracted || '')];
      return readDesign({ outDir, packet: ctl.packet, withheldHashes: sets.hashes, windows, original: ctl.original, originalDir: this._origDir(p.id) });
    };
    /* What the designer wrote, read and then scanned: the files by their content (text of any size, the text inside office files), which
       readDesign cannot do synchronously. */
    const tryRead = async () => {
      try {
        design = read();
        const scanned = await scanDesignFiles({ outDir, design, shouldStop: () => ctl.stop });
        design.unscanned = scanned.unscanned;
        return null;
      } catch (error) {
        design = null;
        if (error instanceof DesignError) return { message: error.message, detail: error.detail };
        throw error;
      }
    };
    if (!problem) problem = await tryRead();
    if (problem) {
      attempt.repaired = true;
      this._note(p, `Asking the trap designer to fix its work (attempt ${n} of ${total})`);
      this._checkStop(ctl);
      this._reserve(p, 'the repair turn', P.CAPS.repairUsd);
      turn = await this._designerTurn(p, ctl, { prompt: repairPrompt({ attempt: n, attempts: total, problem: problem.detail }), cap: P.CAPS.repairUsd, kind: 'design-repair', ref: `attempt ${n}`, transcript: path.join(attemptDir, 'repair.transcript.jsonl'), designer });
      design = null;
      problem = turn.problem || await tryRead();
      if (problem) {
        this._keepOut(outDir, path.join(attemptDir, 'out'));
        throw new AttemptRejected('design', [problem.message], [problem.detail]);
      }
    }
    attempt.audit = { status: 'CLEAN', violationCount: 0 };
    writeTextAtomic(path.join(attemptDir, 'design-summary.txt'), capText(turn.answer, 20000) + '\n');
    this._keepOut(outDir, path.join(attemptDir, 'out'));
    attempt.traps = design.traps.map(trap => ({ id: trap.id, title: trap.title }));
    attempt.newFiles = design.newFiles.length;
    attempt.editedFiles = design.editedFiles.length;
    attempt.promptSha256 = sha256Hex(design.prompt);
    this._save(p);

    /* The checks before any pilot runs. */
    this._note(p, `Checking the design of attempt ${n}: the golden answer against its guideline, and the fairness of the guideline`);
    const reasons = [];
    const details = [];
    const calibration = await this._calibrate(p, ctl, design, n);
    attempt.calibration = calibration;
    if (calibration.score === null) {
      reasons.push('The simulated grader gave the golden answer no usable score, so the guideline could not be checked against it');
      details.push('The simulated grader could not score your golden answer against your guideline (no usable score). Make the guideline a clear list of points with how many each is worth, and make sure the golden answer meets every one.');
    } else if (calibration.score < P.GOLDEN_MIN) {
      reasons.push(`The golden answer scored ${calibration.score.toFixed(2)} against its own guideline; at least ${P.GOLDEN_MIN.toFixed(2)} is needed`);
      details.push(`Your golden answer scored ${calibration.score.toFixed(2)}: ${calibration.reason || '(no reason given)'}. A golden answer must score at least ${P.GOLDEN_MIN.toFixed(2)} against your own guideline. Fix the golden answer or the guideline so that they agree.`);
    }
    const names = [...ctl.packet.keys(), ...design.newFiles.map(file => file.name)];
    const fairness = await this._fairness(p, ctl, design, names, n, outDir);
    attempt.fairness = { status: fairness.status, count: fairness.unfair.length };
    if (fairness.status === 'unusable') {
      reasons.push('The fairness review gave no usable answer');
      details.push('The fairness review of your guideline gave no usable answer. Make each point of the guideline short and plain.');
    } else if (fairness.unfair.length) {
      reasons.push(`The fairness review found ${fairness.unfair.length} guideline item${fairness.unfair.length === 1 ? '' : 's'} that a solver could not know from the prompt and the files, or that no trap explains`);
      details.push(`The fairness review found guideline items a solver could not know from the prompt and the files, or that are not tied to a trap: ${fairness.unfair.map(entry => (entry.why ? `"${entry.item}" (${entry.why})` : `"${entry.item}"`)).join('; ')}. Take them out, or make the prompt and the files settle them.`);
    }
    if (reasons.length) throw new AttemptRejected('checks', reasons, details);

    /* Accepted: the pilot packet. */
    const manifest = await buildWork({ originalDir: this._origDir(p.id), outDir, workDir: this._packetDir(p.id), packet: ctl.packet, design, shouldStop: () => ctl.stop });
    this._checkStop(ctl);
    ctl.manifest = manifest;
    const after = this._withheldSets(p, ctl);
    verifyPacket({ dir: this._packetDir(p.id), manifest, withheldHashes: after.hashes, withheldNames: after.names });
    const bytes = manifest.reduce((sum, file) => sum + file.bytes, 0);
    p.design = {
      attempt: n,
      traps: design.traps,
      gold: design.gold,
      fingerprints: design.fingerprints,
      newFiles: design.newFiles,
      editedFiles: design.editedFiles,
      packet: { fileCount: manifest.length, bytes, files: manifest },
      audit: attempt.audit,
      notes: design.notes,
      repaired: attempt.repaired,
      calibration,
      fairness,
      guidelineDiff: design.guidelineDiff,
      rubricChanges: design.rubricChanges,
      unscanned: design.unscanned,
    };
    this._save(p);
  }

  /* One run of the designer (the first, or the repair) with its cost counted. Returns { problem, answer }: problem is null when the run
     finished and the audit cleared it, else { message, detail }. A designer that could not be started, or a stop, ends the pipeline. */
  async _designerTurn(p, ctl, { prompt, cap, kind, ref, transcript, designer }) {
    this._checkStop(ctl);
    const run = await runDesigner({
      rt: this.rt, folder: designer, prompt, model: p.config.model, effort: p.config.effort, capUsd: cap, transcriptPath: transcript, projectRoot: this.root,
      onRunner: this._track(ctl),
    });
    this._spend(p, 'design', kind, ref, run.costUsd, cap, !run.summary.spawnError);
    if (run.summary.state === 'cancelled' || ctl.stop) throw new StopSignal('stopped');
    if (run.summary.spawnError && !run.summary.events.length) throw new Failure('The trap designer could not be started.');
    if (run.audit && run.audit.status !== 'CLEAN') {
      const kinds = [...new Set(run.audit.violations.map(item => item.kind))].join(', ');
      const attempt = p.attempts[p.attempts.length - 1];
      attempt.audit = { status: run.audit.status, violationCount: run.audit.violations.length };
      const message = `The trap designer was DISCARDED by the audit (${run.audit.violations.length} violation${run.audit.violations.length === 1 ? '' : 's'}: ${kinds}). Its work was not used.`;
      return { problem: { message, detail: `${message} Do not read or write outside this folder, do not use the network and do not start other programs that call a model.` }, answer: '' };
    }
    if (run.summary.state !== 'completed') {
      const message = `The trap designer did not finish (${run.summary.failureReason || run.summary.state}). Its work was not used.`;
      return { problem: { message, detail: `${message} The run stopped before it was done${run.summary.failureReason === 'budget' ? ' (it reached its spending cap)' : ''}: finish what is in out/ and keep it short.` }, answer: '' };
    }
    return { problem: null, answer: run.answer };
  }

  /* A copy of the designer's out/ next to the attempt, regular files only, for the feedback (previous/) and the export. */
  _keepOut(outDir, target) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(outDir, target, { recursive: true, filter: source => { const stat = fs.lstatSync(source); return (stat.isDirectory() || stat.isFile()) && !isJunkName(path.basename(source)); } });
    } catch { /* what could not be copied is not kept */ }
  }

  /* The golden answer, scored by the simulated grader against the design's own guideline. One more call when the first gave no score. */
  async _calibrate(p, ctl, design, n) {
    const guideline = design.guideline + GRADER_FOOTER;
    const answer = capText(design.goldenAnswer, MAX_ANSWER_FOR_GRADER);
    let last = { score: null, verdict: null, reason: '' };
    for (let attemptNo = 1; attemptNo <= 2; attemptNo++) {
      this._checkStop(ctl);
      this._reserve(p, 'the check of the golden answer', P.CAPS.graderUsd);
      const result = await this._graderCall(p, ctl, { stage: 'design', kind: 'calibration', ref: `attempt ${n}`, guideline, answer });
      last = { score: result.score, verdict: result.verdict, reason: result.reason };
      if (result.score !== null) break;
    }
    return last;
  }

  /* The fairness review: one tool-less call (a second when the first gave nothing usable). Resolves { status: 'ok'|'unfair'|'unusable', unfair }. */
  async _fairness(p, ctl, design, names, n, outDir) {
    let trapsText = '';
    try { trapsText = fs.readFileSync(path.join(outDir, 'traps.json'), 'utf8'); } catch { trapsText = ''; }
    const prompt = buildFairnessPrompt({ prompt: design.prompt, files: names, originalGuideline: ctl.texts.guideline || ctl.texts.guidelineExtracted || '', guideline: design.guideline, trapsText });
    for (let attemptNo = 1; attemptNo <= 2; attemptNo++) {
      this._checkStop(ctl);
      this._reserve(p, 'the fairness review', P.CAPS.fairnessUsd);
      const folder = path.join(this._priv(p.id), 'runs', `fairness-${n}-${attemptNo}`);
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      const run = await runToolLess({ rt: this.rt, folder, prompt, model: p.config.model, effort: p.config.effort, capUsd: P.CAPS.fairnessUsd, onRunner: this._track(ctl) });
      this._spend(p, 'design', 'fairness', `attempt ${n}`, run.costUsd, P.CAPS.fairnessUsd, !run.summary.spawnError);
      if (run.summary.state === 'cancelled' || ctl.stop) throw new StopSignal('stopped');
      if (run.summary.state !== 'completed' || run.toolCalls > 0) continue;
      const parsed = parseFairness(run.summary.result.text);
      if (parsed.ok) return { status: parsed.unfair.length ? 'unfair' : 'ok', unfair: parsed.unfair };
    }
    return { status: 'unusable', unfair: [] };
  }

  async _writeDesignerInputs(p, ctl, designer, redesign) {
    const put = (rel, text) => fs.writeFileSync(path.join(designer, rel), text, { mode: 0o600 });
    const stop = () => ctl.stop;
    for (const name of ctl.packet.keys()) {
      if (ctl.stop) throw new StopSignal('stopped');
      await copyHashed(this._originalFile(p, name), path.join(designer, 'task', ...name.split('/')), { shouldStop: stop });
    }
    put('prompt.txt', ctl.texts.prompt);
    for (const [role, rel, label] of [['guideline', 'guideline.md', 'grader guideline'], ['goldenAnswer', 'golden-answer.md', 'golden answer']]) {
      const binary = ctl.texts.binary[role];
      if (binary) {
        await copyHashed(this._originalFile(p, binary), path.join(designer, `${role}-original`, ...binary.split('/')), { shouldStop: stop });
        put(rel, `The ${label} is the file ${role}-original/${binary}. It is not plain text: open it with a tool (for example a script) to read it.\n`);
      } else {
        put(rel, ctl.texts[role] || `(The page has no ${label}.)\n`);
      }
    }
    put('ideas.txt', catalogText());
    if (redesign) {
      put('feedback.md', ctl.feedback || '(no feedback)\n');
      const previous = path.join(this._attemptDir(p.id, p.attempt), 'out');
      if (fs.existsSync(previous)) fs.cpSync(previous, path.join(designer, 'previous'), { recursive: true });
    }
  }

  /* feedback.md for the next design after a design that failed a check: what each check found. */
  _prepareRejectionFeedback(p, ctl, attempt, rejection) {
    const history = p.attempts.filter(item => item.n !== attempt.n).map(item => ({ n: item.n, outcome: this._outcomeLine(item) }));
    ctl.feedback = rejectionFeedback({ attempt: attempt.n, details: rejection.details, history });
    try { writeTextAtomic(path.join(this._attemptDir(p.id, attempt.n), 'feedback.md'), ctl.feedback); } catch { /* the copy in memory is what the designer gets */ }
  }

  /* feedback.md for the next design: every pilot's score, verdict, the grader's reason and the final answer. */
  _prepareFeedback(p, ctl, attempt, failed) {
    const pilots = failed.pilots.map(pilot => ({ ...pilot, answer: ctl.answers.get(`${pilot.round}#${pilot.run}`) || '' }));
    const history = p.attempts.filter(item => item.n !== attempt.n).map(item => ({ n: item.n, outcome: this._outcomeLine(item) }));
    ctl.feedback = feedbackText({
      attempt: attempt.n,
      stage: { name: failed.name, rule: failed.rule, bar: failed.bar, belowBar: failed.belowBar, pilotsWanted: failed.of, pilots, stoppedEarly: failed.stoppedEarly },
      history,
      traps: p.design.traps,
    });
    try { writeTextAtomic(path.join(this._attemptDir(p.id, attempt.n), 'feedback.md'), ctl.feedback); } catch { /* the copy in memory is what the designer gets */ }
  }

  /* "; 1 pilot stopped early: the result was decided after pilot 1 scored 0.52", or nothing when every pilot ran to the end. */
  _stoppedNote(stage) {
    const stopped = stage.pilots.filter(pilot => pilot.stoppedEarly).length;
    if (!stage.stoppedEarly || !stopped) return '';
    const score = typeof stage.stoppedEarly.score === 'number' ? ` scored ${stage.stoppedEarly.score.toFixed(2)}` : '';
    return `; ${stopped} pilot${stopped === 1 ? ' was' : 's were'} stopped early because the result was decided after pilot ${stage.stoppedEarly.afterPilot}${score}`;
  }

  _outcomeLine(attempt) {
    if (attempt.rejection) return `${attempt.outcome} before any pilot ran: ${attempt.rejection.reasons.join('; ')}`;
    const scores = stage => (stage ? stage.pilots.map(pilot => (typeof pilot.score === 'number' ? pilot.score.toFixed(2) : 'none')).join(', ') : '');
    return `${attempt.outcome}; screen scores: ${scores(attempt.screen) || 'none'}${attempt.test ? `; test scores: ${scores(attempt.test)}` : ''}`;
  }

  /* -------------------------------------------------------------- screen and test */

  /* One pilot stage: a round of pilots, each graded as soon as its run ends, and, when a pilot did not give a usable score, one
     replacement round for the missing ones. The stage ends as soon as its result is decided (see _pilotsAndGrades). Decides from what
     exists: a missing score counts as the pilot getting through (against the design). */
  async _pilotStage(p, ctl, kind) {
    const screen = kind === 'screen';
    const wanted = screen ? P.SCREEN_PILOTS : P.TEST_PILOTS;
    const need = screen ? P.SCREEN_PILOTS : P.TEST_NEED;
    const bar = screen ? P.SCREEN_BAR : P.TEST_BAR;
    const result = {
      name: kind,
      rule: screen ? `both of the ${wanted} pilots score below ${bar.toFixed(2)}` : `at least ${need} of the ${wanted} pilots score below ${bar.toFixed(2)}`,
      bar, need, of: wanted, roundIds: [], pilots: [], counted: 0, belowBar: 0, passed: null, stoppedEarly: null, replacementRound: false, replacementSkipped: false, startedAt: this.now(), endedAt: null,
    };
    await this._pilotsAndGrades(p, ctl, kind, result, wanted, false);
    /* A pilot that was stopped because the result was decided is not missing. */
    const missing = result.pilots.filter(pilot => !pilot.valid && !pilot.stoppedEarly).length;
    if (missing > 0 && !result.stoppedEarly) {
      /* A replacement round runs once per stage, and only when it could change the decision. */
      if (result.belowBar >= need || result.belowBar + missing < need) {
        result.replacementSkipped = true;
      } else {
        result.replacementRound = true;
        await this._pilotsAndGrades(p, ctl, kind, result, missing, true);
      }
    }
    result.passed = result.belowBar >= need;
    result.endedAt = this.now();
    this._save(p);
    return result;
  }

  /* One round of `count` pilots. Each pilot is graded the moment its run ends, while the others go on, and after each grade the stage
     asks whether its result is decided:
       passed  when `need` pilots have a usable score below the bar (the test: 4 of 5);
       failed  when so many have a usable score at or above it that `need` can no longer be reached (the screen: one; the test: two).
     A decided stage cancels the pilots that have not ended and does not grade the ones that ended after the decision: they are marked
     stoppedEarly (with a reason) and are not missing, so they get no replacement; result.stoppedEarly = { afterPilot, score } says which
     score decided it. A cancelled pilot's spend is still counted (at its cap, marked estimated, when the run reported none). */
  async _pilotsAndGrades(p, ctl, kind, result, count, replacement) {
    const screen = kind === 'screen';
    const gradeStage = screen ? 'grade-screen' : 'grade-test';
    const bar = result.bar;
    const band = this.bands[kind];
    const what = `the ${replacement ? 'replacement round of the ' : ''}${kind}`;
    this._checkStop(ctl);
    this._reserve(p, what, count * (p.config.pilotCapUsd + P.GRADE_CALLS_PER_PILOT * P.CAPS.graderUsd));
    const attempt = p.attempts[p.attempts.length - 1];
    if (!attempt[kind]) attempt[kind] = result;
    this._setStage(p, kind, replacement ? `Running ${count} replacement pilot${count === 1 ? '' : 's'} for the ${kind}` : `Running ${count} pilot${count === 1 ? '' : 's'} for the ${kind}`);
    const roundId = await this._launchPilotRound(p, ctl, kind, count, replacement);

    /* Every pilot has its place in the stage from the start, so the page can show the round as it goes. */
    const startIndex = result.pilots.length;
    const records = [];
    for (let k = 1; k <= count; k++) {
      const record = {
        n: startIndex + k, id: `p${startIndex + k}`, round: roundId, run: k, replacement, state: 'queued', audit: null, costUsd: 0, estimated: false,
        outputs: { count: 0, readable: 0 }, score: null, regrade: null, verdict: null, reason: '', valid: false, belowBar: null, stoppedEarly: false, stoppedReason: '',
      };
      records.push(record);
      result.pilots.push(record);
    }
    result.roundIds.push(roundId);
    this._save(p);

    const tally = () => {
      const valid = result.pilots.filter(pilot => pilot.valid);
      const below = valid.filter(pilot => pilot.score < bar).length;
      result.counted = valid.length;
      result.belowBar = below;
      return { below, atOrAbove: valid.length - below };
    };
    const decide = () => {
      const { below, atOrAbove } = tally();
      if (below >= result.need) return 'passed';
      if (atOrAbove > result.of - result.need) return 'failed';
      return null;
    };
    const settled = this.agents.whenSettled(roundId);
    let over = false;
    settled.then(() => { over = true; }, () => { over = true; });
    const taken = new Set();
    const grading = { calls: 0, refused: 0, firstError: '' };
    let decision = null;
    let gradeStageSet = false;

    /* A run that has ended: its cost is counted whatever happens to it. */
    const account = (row, record) => {
      taken.add(row.n);
      const started = Boolean(row.startedAt);
      const usd = this._spend(p, kind, 'pilot', `${roundId}#${row.n}`, row.costUsd, p.config.pilotCapUsd, started);
      record.state = row.state;
      record.audit = row.audit ? { status: row.audit.status, violationCount: row.audit.violationCount } : null;
      record.costUsd = round6(usd);
      record.estimated = started && typeof row.costUsd !== 'number';
    };
    const markStopped = (row, record) => {
      record.stoppedEarly = true;
      record.stoppedReason = row.state === 'completed'
        ? `Not graded: the ${kind} was already decided after pilot ${result.stoppedEarly ? result.stoppedEarly.afterPilot : '?'}.`
        : `Stopped before it finished: the ${kind} was already decided after pilot ${result.stoppedEarly ? result.stoppedEarly.afterPilot : '?'}.`;
    };
    const take = async (row, record) => {
      account(row, record);
      if (decision) { markStopped(row, record); this._save(p); return; }
      if (row.state === 'completed' && row.audit && row.audit.status === 'CLEAN') {
        const collected = await this._collectAnswer(roundId, row.n);
        ctl.answers.set(`${roundId}#${row.n}`, collected.text);
        record.outputs = collected.outputs;
        if (collected.gradable) await this._scorePilot(p, ctl, { stage: gradeStage, record, ref: `${roundId}#${row.n}`, band, bar, grading });
      }
      decision = decide();
      if (decision && taken.size < records.length) {
        /* The rest cannot change the result: stop them now. */
        result.stoppedEarly = { afterPilot: record.n, score: record.score };
        await Promise.resolve().then(() => this.agents.cancelRound(roundId)).catch(() => {});
      }
      this._save(p);
    };

    let failure = null;
    try {
      for (;;) {
        this._checkStop(ctl);
        const view = await this.agents.getRound(roundId);
        for (const row of view.runs) {
          const record = records[row.n - 1];
          if (!record || taken.has(row.n)) continue;
          if (row.state !== 'completed' && row.state !== 'failed' && row.state !== 'cancelled') {
            if (record.state !== row.state) { record.state = row.state; }
            continue;
          }
          if (!gradeStageSet) {
            gradeStageSet = true;
            this._setStage(p, gradeStage, `Grading the answers of the ${kind} pilots as they finish`);
          }
          await take(row, record);
          this._checkStop(ctl);
        }
        if (taken.size >= records.length) break;
        await Promise.race([settled, delay(this.pollMs)]);
      }
      if (grading.calls > 0 && grading.refused === grading.calls && !decision) throw new Failure(`The simulated grader could not be used: ${grading.firstError}`);
    } catch (error) {
      failure = error;
    }

    /* However the loop ended, the round is over before this returns: pilots still running are cancelled, and every run is accounted for. */
    if (!over) await Promise.resolve().then(() => this.agents.cancelRound(roundId)).catch(() => {});
    await settled;
    ctl.roundId = null;
    if (taken.size < records.length) {
      let view = null;
      try { view = await this.agents.getRound(roundId); } catch { view = null; }
      for (const row of view ? view.runs : []) {
        const record = records[row.n - 1];
        if (!record || taken.has(row.n)) continue;
        account(row, record);
        if (decision) markStopped(row, record);
      }
    }
    for (const record of records) {
      delete record.gradable;
      if (decision && !record.valid && !record.stoppedEarly && record.state === 'cancelled') markStopped({ state: record.state }, record);
    }
    tally();
    this._save(p);
    if (failure) throw failure;
    this._checkStop(ctl);
  }

  /* Safety checks, then the start of one round of the agent service: create, freeze (the gold and fingerprints of the design), approve,
     launch. Resolves the round's id. */
  async _launchPilotRound(p, ctl, kind, count, replacement) {
    this._checkStop(ctl);
    const attempt = p.attempts[p.attempts.length - 1];
    const texts = this._designTexts(p);
    if (sha256Hex(texts.prompt) !== attempt.promptSha256) throw new SafetyError('The prompt changed after it was checked');
    const sets = this._withheldSets(p, ctl);
    verifyPacket({ dir: this._packetDir(p.id), manifest: ctl.manifest, withheldHashes: sets.hashes, withheldNames: sets.names });
    const windows = [...leakWindows(ctl.texts.guideline || ctl.texts.guidelineExtracted || ''), ...leakWindows(ctl.texts.goldenAnswer || ctl.texts.goldenExtracted || ''), ...leakWindows(texts.guideline), ...leakWindows(texts.goldenAnswer)];
    if (windows.length && windows.some(window => window && this._squashIncludes(texts.prompt, window))) throw new SafetyError('The prompt holds a long passage of the guideline or the golden answer');

    let roundId = null;
    try {
      const created = await this.agents.createRound({
        label: `${p.label} attempt ${attempt.n} ${kind}${replacement ? ' replacement' : ''}`.slice(0, 120),
        task: `Pipeline ${p.id}`,
        sourceDir: this._packetDir(p.id),
        include: ctl.manifest.map(file => file.name),
        promptText: texts.prompt,
        gafVisible: true, /* the production solver sees the gaf folder, so the pilots do too: the packet is delivered whole */
        config: { model: p.config.model, effort: p.config.effort, count, maxBudgetUsd: p.config.pilotCapUsd },
      });
      roundId = created.id;
      ctl.roundId = roundId;
      this._checkStop(ctl);
      verifyRoundPacket(created, ctl.manifest);
      await this.agents.freezeRound(roundId, { gold: p.design.gold, fingerprints: p.design.fingerprints });
      const summary = await this.agents.approvalSummary(roundId);
      await this.agents.approveRound(roundId, { summarySha256: summary.summarySha256, acknowledgements: P.AGENT_ACKNOWLEDGEMENTS.slice() });
      this._checkStop(ctl);
      await this.agents.launchRound(roundId);
    } catch (error) {
      ctl.roundId = null;
      if (roundId) { try { await this.agents.cancelRound(roundId); } catch { /* it may have ended already */ } }
      if (ctl.stop) throw new StopSignal('stopped');
      throw error;
    }
    return roundId;
  }

  _squashIncludes(text, window) {
    return String(text).replace(/\s+/gu, ' ').trim().toLowerCase().includes(window);
  }

  /* What the simulated grader reads for one clean pilot: its final message and the files it wrote as text (plain text files, and the text
     of spreadsheets and documents), under "--- outputs/<name> ---", within the grader's limit. A pilot that wrote files but gave a final
     message of under 600 characters and nothing readable cannot be graded. Resolves { text, gradable, outputs: { count, readable } }. */
  async _collectAnswer(roundId, n) {
    let detail;
    try { detail = await this.agents.getRun(roundId, n); } catch { return { text: '', gradable: false, outputs: { count: 0, readable: 0 } }; }
    const final = String((detail.final && detail.final.text) || '');
    const listed = Array.isArray(detail.outputs) ? detail.outputs.filter(entry => isObject(entry) && typeof entry.name === 'string') : [];
    const base = path.join(this.root, 'private', 'agent-rounds', roundId, 'runs', String(n), 'outputs');
    const readable = [];
    for (const entry of listed.slice(0, MAX_OUTPUT_FILES)) {
      if (!entry.name || entry.name.includes('\0') || entry.name.split('/').some(part => part === '' || part === '.' || part === '..')) continue;
      const abs = path.join(base, ...entry.name.split('/'));
      if (!within(abs, base)) continue;
      let stat;
      try { stat = fs.lstatSync(abs); } catch { continue; }
      if (!stat.isFile()) continue;
      const text = await extractText(abs, { maxChars: 30000 });
      if (text && text.trim()) readable.push({ name: entry.name, text });
    }
    const outputs = { count: listed.length, readable: readable.length };
    const gradable = Boolean(final.trim()) && !(listed.length > 0 && final.length < UNREADABLE_FINAL_CHARS && readable.length === 0);
    return { text: composeGraderInput({ final, outputs: readable, cap: MAX_ANSWER_FOR_GRADER }), gradable, outputs };
  }

  /* One call of the simulated grader. A call the service refuses or cannot take (400, 409, 413) gives no score and no failure of the
     pipeline; anything else ends it. Resolves { ok, score, verdict, reason, error? }; score is null when there is none. */
  async _graderCall(p, ctl, { stage, kind, ref, guideline, answer }) {
    let res;
    ctl.graderRunning = true;
    try {
      res = await this.agents.graderSim({ guidelineText: guideline, answerTexts: [answer], model: p.config.graderModel, effort: p.config.graderEffort });
    } catch (error) {
      if (ctl.stop) throw new StopSignal('stopped');
      if (error instanceof AgentError && [400, 409, 413].includes(error.status)) return { ok: false, score: null, verdict: null, reason: '', error: oneLine(error.message, 200) };
      throw error instanceof AgentError ? error : new Failure('The simulated grader could not be run');
    } finally {
      ctl.graderRunning = false;
    }
    const one = Array.isArray(res.results) && res.results.length ? res.results[0] : {};
    this._spend(p, stage, kind, ref, one.costUsd, P.CAPS.graderUsd, typeof one.state === 'string');
    if (ctl.stop || one.state === 'cancelled') throw new StopSignal('stopped');
    const score = typeof res.score === 'number' && Number.isFinite(res.score) && !one.discarded ? res.score : null;
    return { ok: true, score, verdict: typeof res.verdict === 'string' ? res.verdict : null, reason: capText(typeof res.reason === 'string' ? res.reason : '', MAX_REASON) };
  }

  /* Scores one clean answer for a pilot of the stage: a grader call, and a second one when the score is within the regrade band around
     the stage's bar (the two are averaged and both recorded). Sets the record's score, regrade, verdict and reason. A call that could not
     be made leaves the pilot without a score; grading counts the calls and the refused ones, so that a stage in which no call at all
     could be made fails (that is the grader, not one answer). */
  async _scorePilot(p, ctl, { stage, record, ref, band, bar, grading }) {
    const guideline = this._designTexts(p).guideline + GRADER_FOOTER;
    const answer = capText(ctl.answers.get(ref) || '', MAX_ANSWER_FOR_GRADER);
    const [low, high] = band;
    grading.calls++;
    const first = await this._pilotGrade(p, ctl, { stage, ref, guideline, answer, call: 1 });
    if (!first.ok) {
      grading.refused++;
      grading.firstError = grading.firstError || first.error;
      record.reason = 'The simulated grader could not take this answer.';
      return;
    }
    record.verdict = first.verdict;
    record.reason = first.reason;
    let score = first.score;
    if (score !== null && score >= low && score <= high) {
      this._checkStop(ctl);
      const second = await this._pilotGrade(p, ctl, { stage, ref, guideline, answer, call: 2 });
      if (second.ok && second.score !== null) {
        score = round6((first.score + second.score) / 2);
        record.regrade = { first: first.score, second: second.score, average: score };
      }
    }
    if (score !== null) {
      record.score = score;
      record.valid = true;
      record.belowBar = score < bar;
    }
  }

  /* One call of the simulated grader for a pilot's answer, while other pilots may still be running. The prompt is the agent service's own
     grader prompt, but it goes to the process on stdin and not on its command line: the agent service keeps its own grader away from a
     running round because its text would be on a command line that a pilot could read. Resolves { ok, score, verdict, reason, error? };
     ok is false when the call could not be made at all (the runtime is not ready, or the prompt is too large for the runtime). */
  async _pilotGrade(p, ctl, { stage, ref, guideline, answer, call }) {
    const prompt = buildGraderPrompt(guideline, answer);
    if (Buffer.byteLength(prompt) > 120 * 1024) return { ok: false, score: null, verdict: null, reason: '', error: 'The guidance and answer are too large for one simulated grading call' };
    this._checkStop(ctl);
    const folder = path.join(this._priv(p.id), 'runs', `grade-${ref.replace(/[^A-Za-z0-9]+/g, '-')}-${call}`);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    let run;
    try {
      run = await runToolLess({ rt: this.rt, folder, prompt, model: p.config.graderModel, effort: p.config.graderEffort, capUsd: P.CAPS.graderUsd, onRunner: this._track(ctl) });
    } catch (error) {
      if (ctl.stop) throw new StopSignal('stopped');
      if (error instanceof AgentError && [400, 409, 413].includes(error.status)) return { ok: false, score: null, verdict: null, reason: '', error: oneLine(error.message, 200) };
      throw error instanceof AgentError ? error : new Failure('The simulated grader could not be run');
    } finally {
      try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* a leftover folder is private and empty */ }
    }
    this._spend(p, stage, 'grader', ref, run.costUsd, P.CAPS.graderUsd, !run.summary.spawnError);
    if (ctl.stop || run.summary.state === 'cancelled') throw new StopSignal('stopped');
    if (run.toolCalls > 0 || run.summary.state !== 'completed') return { ok: true, score: null, verdict: null, reason: '' };
    const parsed = parseGraderOutput(run.summary.result.text);
    return { ok: true, score: typeof parsed.score === 'number' && Number.isFinite(parsed.score) ? parsed.score : null, verdict: parsed.verdict, reason: capText(parsed.reason || '', MAX_REASON) };
  }
}

function createPipelineService(options = {}) {
  return new PipelineService(options);
}

module.exports = { PipelineService, createPipelineService, parseLink, PipelineStopSignal: StopSignal };
