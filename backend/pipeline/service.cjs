'use strict';
/* The pipeline orchestrator: link or folder -> classify -> design traps -> 2-pilot screen -> 5-pilot test, with redesigns, one total
   spending cap and one approval for the whole run. Pilots and the simulated grader are the agent service's (rounds, graderSim); the
   classifier and the trap designer are runs of models.cjs. The link loader is only reached through createLinkLoader's API
   (start, get, continue, cancel).

   One pipeline at a time, and none while a round runs. State lives in <root>/private/pipelines/<id>/state.json (atomic), the
   design of each attempt in <root>/private/pipelines/<id>/attempts/<n>/out, and the working folders OUTSIDE the project in
   <tmpRoot>/finance-studio-pipelines/<id>/ (original/, designer/, work/filesystem/ = the pilot packet, runs/).

   Stages: import -> classify -> design -> screen -> grade-screen -> (redesign -> design ...) -> test -> grade-test -> done,
   or failed | stopped | budget at any point. See docs of each method below for the rules. */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AgentError } = require('../agents/rounds.cjs');
const C = require('../agents/constants.cjs');
const { budgetText } = require('../agents/claude-runner.cjs');
const { checkPilotsRoot, resolveSourceDir } = require('../agents/pilot-folder.cjs');
const P = require('./constants.cjs');
const { isObject, sha256Hex, clone, capText, oneLine, writeJsonAtomic, writeTextAtomic, readJson, within, delay, readTextFile, hashFile } = require('./util.cjs');
const { IntakeError, intakeFromLoader, intakeFromFolder } = require('./intake.cjs');
const { buildClassifierPrompt, classify } = require('./classify.cjs');
const { DesignError, catalogText, designerPrompt, feedbackText, readDesign, buildWork } = require('./design.cjs');
const { SafetyError, verifyPacket, verifyRoundPacket, leakWindows } = require('./safety.cjs');
const { runtimeOf, runToolLess, runDesigner } = require('./models.cjs');
const { buildExport } = require('./export.cjs');

const SCHEMA = 'finance-pipeline';
const SCHEMA_VERSION = 1;
const MAX_LABEL = 60;
const GRADER_FOOTER = '\n\nScoring scale for this rehearsal: report "score" as a number from 0 to 1, the share of the points the guidance names that the answer earns (1 means every point is met, 0 means none), and list each point in "items".';
const MAX_ANSWER_FOR_GRADER = 59000;
const MAX_REASON = 1500;

class StopSignal extends Error {}
class BudgetStop extends Error {}
/* A failure whose message is safe to show the owner as it is. */
class Failure extends Error {}

const bad = message => new AgentError(400, message);
const round6 = value => Math.round(value * 1e6) / 1e6;
const money = value => `USD ${value.toFixed(2)}`;
const isTerminal = stage => P.TERMINAL.includes(stage);

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

  _stateFile(id) { return path.join(this.dir, id, 'state.json'); }
  _attemptDir(id, n) { return path.join(this.dir, id, 'attempts', String(n)); }
  _workspace(id) { return path.join(this.workRoot, id); }

  /* A pipeline that was running when the companion stopped has nothing behind it any more: it is closed as failed. */
  _load() {
    if (!fs.existsSync(this.dir)) return;
    for (const name of fs.readdirSync(this.dir)) {
      if (!P.ID_RE.test(name)) continue;
      try {
        const state = readJson(this._stateFile(name));
        if (!isObject(state) || state.id !== name || state.schema !== SCHEMA || !isObject(state.config) || !Array.isArray(state.attempts)) continue;
        if (!isTerminal(state.stage)) {
          state.stage = 'failed';
          state.waiting = null;
          state.message = 'The companion stopped while this pipeline was running, so it was closed.';
          state.error = 'interrupted';
          state.endedAt = this.now();
          state.updatedAt = state.endedAt;
          state.result = { verdict: 'failed', message: state.message };
          writeJsonAtomic(this._stateFile(name), state);
        }
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

  _setStage(p, stage, message) {
    p.stage = stage;
    p.message = message;
    this._save(p);
    if (this.onStage) { try { this.onStage(stage, { id: p.id, attempt: p.attempt }); } catch { /* an observer never changes a run */ } }
  }

  /* -------------------------------------------------------------- budget */

  /* Stops before a step whose worst case does not fit under the cap. */
  _reserve(p, what, usd) {
    if (round6(p.spentUsd + usd) > p.config.capUsd + 1e-9) {
      throw new BudgetStop(`Stopped before ${what}: ${money(p.spentUsd)} spent, the step could cost up to ${money(usd)}, and the cap is ${money(p.config.capUsd)}.`);
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

  /* One cancel of the link load, however many times Stop asks. */
  async _cancelLink(ctl) {
    if (!ctl.linkId || ctl.linkCancelled || !this.links || typeof this.links.cancel !== 'function') return;
    ctl.linkCancelled = true;
    try { await this.links.cancel(ctl.linkId); } catch { /* the loader may already be over */ }
  }

  /* -------------------------------------------------------------- the HTTP-facing methods */

  /* The answer of GET /api/pipeline: the pipelines, newest first, and the rules the page shows. */
  async list() {
    const rows = [...this.pipelines.values()].map(entry => this._row(entry.state)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
    return { pipelines: rows, running: this.active, config: this._rules() };
  }

  _rules() {
    return {
      passBar: P.PASS_BAR, screenPilots: P.SCREEN_PILOTS, testPilots: P.TEST_PILOTS, testNeed: P.TEST_NEED, maxRedesigns: P.MAX_REDESIGNS,
      defaultCapUsd: P.DEFAULT_CAP_USD, maxCapUsd: P.MAX_CAP_USD, defaultPilotCapUsd: C.BUDGET_USD.pilotDefault,
      minPilotCapUsd: C.BUDGET_USD.minUsd, maxPilotCapUsd: C.BUDGET_USD.maxUsd, designCapUsd: P.CAPS.designUsd, classifyCapUsd: P.CAPS.classifyUsd, graderCapUsd: P.CAPS.graderUsd,
      stages: P.STAGES.slice(), acknowledgements: P.ACKNOWLEDGEMENTS.slice(), linksAvailable: Boolean(this.links),
      models: C.MODELS.slice(), efforts: C.EFFORTS.slice(), defaultModel: C.DEFAULT_MODEL, defaultEffort: C.DEFAULT_EFFORT, graderModel: C.GRADER_MODEL,
    };
  }

  _row(p) {
    return {
      id: p.id, label: p.label, createdAt: p.createdAt, updatedAt: p.updatedAt, endedAt: p.endedAt,
      stage: p.stage, running: !isTerminal(p.stage), message: p.message, spentUsd: p.spentUsd, capUsd: p.config.capUsd,
      attempt: p.attempt, redesigns: p.redesigns, verdict: p.result ? p.result.verdict : null,
    };
  }

  async get(id) {
    return this._view(this._entry(id).state);
  }

  /* start(body): { url | sourceDir, capUsd, model, effort, pilotCapUsd, designCapUsd?, graderModel?, label?, acknowledgements } -> { id }.
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
    /* The designer's cap, when none is given: a fifth of the total cap, at most USD 5.00 and at least USD 0.50, so a small total cap still leaves room for pilots. */
    const designCapUsd = body.designCapUsd === undefined || body.designCapUsd === null ? Math.min(P.CAPS.designUsd, Math.max(0.5, Math.round(capUsd * 20) / 100)) : body.designCapUsd;
    if (budgetText(designCapUsd) === null) throw bad(`The spending cap for the designer must be a number of US dollars from ${C.BUDGET_USD.minUsd.toFixed(2)} to ${C.BUDGET_USD.maxUsd.toFixed(2)}, in whole cents`);
    if (body.label !== undefined && body.label !== null && typeof body.label !== 'string') throw bad('label must be text');
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
      const createdAt = this.now();
      const label = oneLine(body.label, MAX_LABEL) || `Pipeline ${id.slice(4, 10)}`;
      const state = {
        schema: SCHEMA, schemaVersion: SCHEMA_VERSION, id, label, createdAt, updatedAt: createdAt, endedAt: null,
        stage: 'import', message: 'Starting', error: null, waiting: null, source,
        config: { capUsd, pilotCapUsd, designCapUsd, model, effort, graderModel, passBar: P.PASS_BAR, screenPilots: P.SCREEN_PILOTS, testPilots: P.TEST_PILOTS, testNeed: P.TEST_NEED, maxRedesigns: P.MAX_REDESIGNS },
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

  /* <tmpRoot>/finance-studio-pipelines/<id> and its folders, outside the project; a link or a foreign owner is refused. */
  _makeWorkspace(id) {
    try {
      fs.mkdirSync(this.workRoot, { recursive: true, mode: 0o700 });
      checkPilotsRoot(this.workRoot);
      const real = fs.realpathSync(this.workRoot);
      let project = this.root;
      try { project = fs.realpathSync(this.root); } catch { /* the root exists in practice */ }
      if (within(real, project)) throw new AgentError(409, 'The working folder would be inside the Studio project. Choose another temporary folder');
      fs.mkdirSync(this._workspace(id), { mode: 0o700 });
      for (const sub of ['original', 'designer', 'work', 'runs']) fs.mkdirSync(path.join(this._workspace(id), sub), { mode: 0o700 });
    } catch (error) {
      if (error instanceof AgentError) throw error;
      if (error && error.name === 'PacketError') throw new AgentError(error.status, error.message);
      throw new AgentError(409, 'The working folder could not be made. Nothing was started');
    }
  }

  /* The owner pressed Continue after signing in or turning on the option that shows all files. */
  async continue(id) {
    const { state: p, ctl } = this._entry(id);
    if (isTerminal(p.stage) || !p.waiting || !ctl || !ctl.linkId) throw new AgentError(409, 'Nothing is waiting for you');
    if (!this.links || typeof this.links.continue !== 'function') throw new AgentError(409, 'The link loader cannot continue');
    await this.links.continue(ctl.linkId);
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
      built = buildExport({ outDir, state: this._exportState(p), note: p.result && p.result.verdict === 'success' ? 'this design passed the test' : 'this design did not pass' });
    } catch (error) {
      throw new AgentError(409, `The export could not be made (${oneLine(error && error.message, 160)})`);
    }
    return { name: built.name, size: built.bytes.length, sha256: built.sha256, files: built.files, zipBase64: Buffer.from(built.bytes).toString('base64') };
  }

  _exportState(p) {
    return { label: p.label, stage: p.stage, message: p.message, attempts: p.attempts, redesigns: p.redesigns, spentUsd: p.spentUsd, config: p.config };
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
      editedFiles: p.design.editedFiles.map(file => ({ name: file.name, reason: file.reason, bytes: file.bytes })),
      packet: clone(p.design.packet),
      audit: clone(p.design.audit),
      notes: p.design.notes.slice(),
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
      stage: p.stage, running: !isTerminal(p.stage), message: p.message, summary: p.result ? p.result.message : '', error: p.error, waiting: p.waiting, source: p.source,
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
        await this._design(p, ctl);
        const attempt = p.attempts[p.attempts.length - 1];
        const screen = await this._pilotStage(p, ctl, 'screen');
        if (screen.passed) {
          const test = await this._pilotStage(p, ctl, 'test');
          if (test.passed) {
            attempt.outcome = 'passed';
            return this._finish(p, 'done', `The test passed: ${test.belowBar} of ${test.of} pilots scored below ${P.PASS_BAR} (design attempt ${attempt.n}). Export the private zip to take the design away.`, 'success');
          }
          attempt.outcome = 'test-failed';
        } else {
          attempt.outcome = 'screen-failed';
        }
        const failed = attempt.outcome === 'screen-failed' ? attempt.screen : attempt.test;
        if (p.redesigns >= P.MAX_REDESIGNS) {
          return this._finish(p, 'failed', `Stopped after ${P.MAX_REDESIGNS} redesigns: the ${failed.name} of attempt ${attempt.n} did not pass (${failed.belowBar} of ${failed.of} pilots scored below ${P.PASS_BAR}; the rule needs ${failed.need}). The last design is kept for you to look at.`, 'failed');
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

  _finish(p, stage, message, verdict) {
    p.waiting = null;
    p.endedAt = this.now();
    p.result = { verdict, message };
    this._setStage(p, stage, message);
  }

  _fail(p, ctl, error) {
    if (error instanceof StopSignal) {
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
    if (error instanceof SafetyError) message = `SAFETY STOP: ${error.message}. Nothing was started.`;
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
    const original = path.join(this._workspace(p.id), 'original');
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
      loaderState = await this._pollLoader(p, ctl);
      this._setStage(p, 'import', 'Copying the downloaded files');
      intake = intakeFromLoader({ state: loaderState, root: this.root, original });
    } else {
      intake = intakeFromFolder({ realDir: ctl.realDir, original });
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
      files: intake.files,
    };
    p.waiting = null;
    writeJsonAtomic(path.join(this._workspace(p.id), 'page.json'), { sections: intake.sections, fileList: intake.files.map(file => ({ name: file.name, group: file.group, label: file.label })), page: intake.page });
    this._save(p);
  }

  _scrubLink(text, url) {
    let out = String(text === undefined || text === null ? '' : text);
    if (typeof url === 'string' && url) out = out.split(url).join('<link>');
    return oneLine(out.replace(/https?:\/\/[^\s"'<>]+/gi, '<link>'), 300);
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
      const loaderMessage = oneLine(state.message, 300);
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
        try { await this.links.cancel(ctl.linkId); } catch { /* the loader may already be over */ }
        throw new Failure('The link loader did not finish in time.');
      }
      await delay(this.pollMs);
    }
  }

  /* -------------------------------------------------------------- classify */

  _originalFile(p, name) { return path.join(this._workspace(p.id), 'original', ...name.split('/')); }

  async _classify(p, ctl) {
    this._setStage(p, 'classify', 'Classifying what was captured');
    this._checkStop(ctl);
    this._reserve(p, 'the classifier', P.CAPS.classifyUsd);
    const files = p.import.files;
    const sections = ctl.sections;
    const folder = path.join(this._workspace(p.id), 'runs', 'classify');
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
    /* A packet file that is byte for byte a withheld file is withheld too, whatever its name. */
    const byName = new Map(files.map(file => [file.name, file]));
    const withheldHashes = new Set(settled.withheld.map(item => byName.get(item.name)).filter(Boolean).map(file => file.sha256));
    const identical = list => list.filter(name => {
      const file = byName.get(name);
      if (file && file.bytes > 0 && withheldHashes.has(file.sha256)) {
        settled.withheld.push({ name, why: 'it is byte for byte the same as withheld material' });
        return false;
      }
      return true;
    });
    settled.worldFiles = identical(settled.worldFiles);
    settled.taskFiles = identical(settled.taskFiles);
    const packetNames = [...settled.worldFiles, ...settled.taskFiles];
    if (!packetNames.length) throw new Failure('No world or task file is left after the withheld files were taken out.');
    ctl.packet = new Map(packetNames.map(name => [name, { sha256: byName.get(name).sha256, bytes: byName.get(name).bytes }]));
    ctl.texts = this._loadOriginalTexts(p, ctl, settled);
    delete settled.problems;
    p.classification = settled;
    p.import.facts = { world: settled.worldFiles.length, task: settled.taskFiles.length, withheld: settled.withheld.length, other: settled.other.length };
    this._save(p);
  }

  /* The text of the prompt, the guideline and the golden answer: a page section, or a text file. A guideline or golden answer that is a
     binary file (a spreadsheet, a document) is copied for the designer as it is and has no text here. */
  _loadOriginalTexts(p, ctl, settled) {
    const out = { prompt: '', guideline: '', goldenAnswer: '', binary: {} };
    for (const [role, ref] of [['prompt', settled.prompt], ['guideline', settled.guideline], ['goldenAnswer', settled.goldenAnswer]]) {
      if (!ref) continue;
      if (ref.kind === 'section') { out[role] = ctl.sections[ref.index].text; continue; }
      const text = readTextFile(this._originalFile(p, ref.name), P.INTAKE.textBytes);
      if (text === null) {
        if (role === 'prompt') throw new Failure('The business prompt is a file that is not text, so it cannot be used. Put the prompt on the page or in a text file.');
        out.binary[role] = ref.name;
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

  async _design(p, ctl) {
    const n = p.attempt + 1;
    const total = P.MAX_REDESIGNS + 1;
    this._setStage(p, 'design', `Designing the traps (attempt ${n} of ${total})`);
    this._checkStop(ctl);
    this._reserve(p, 'the trap designer', p.config.designCapUsd);
    const ws = this._workspace(p.id);
    const designer = path.join(ws, 'designer');
    fs.rmSync(designer, { recursive: true, force: true });
    fs.mkdirSync(path.join(designer, 'out'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(designer, '.tmp'), { recursive: true, mode: 0o700 });
    const redesign = n > 1;
    this._writeDesignerInputs(p, ctl, designer, redesign);
    p.attempt = n;
    const attempt = { n, startedAt: this.now(), traps: [], newFiles: 0, editedFiles: 0, screen: null, test: null, outcome: 'in-progress' };
    p.attempts.push(attempt);
    this._save(p);

    const attemptDir = this._attemptDir(p.id, n);
    fs.mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
    this._checkStop(ctl);
    const run = await runDesigner({
      rt: this.rt, folder: designer, prompt: designerPrompt({ attempt: n, attempts: total, redesign }), model: p.config.model, effort: p.config.effort,
      capUsd: p.config.designCapUsd, transcriptPath: path.join(attemptDir, 'design.transcript.jsonl'), projectRoot: this.root,
      onRunner: this._track(ctl),
    });
    this._spend(p, 'design', 'design', `attempt ${n}`, run.costUsd, p.config.designCapUsd, !run.summary.spawnError);
    if (run.summary.state === 'cancelled' || ctl.stop) throw new StopSignal('stopped');
    if (run.audit && run.audit.status !== 'CLEAN') {
      const kinds = [...new Set(run.audit.violations.map(item => item.kind))].join(', ');
      attempt.audit = { status: run.audit.status, violationCount: run.audit.violations.length };
      throw new Failure(`The trap designer was DISCARDED by the audit (${run.audit.violations.length} violation${run.audit.violations.length === 1 ? '' : 's'}: ${kinds}). Its work was not used.`);
    }
    if (run.summary.state !== 'completed') {
      throw new Failure(`The trap designer did not finish (${run.summary.failureReason || run.summary.state}). Its work was not used.`);
    }
    writeTextAtomic(path.join(attemptDir, 'design-summary.txt'), capText(run.answer, 20000) + '\n');

    const sets = this._withheldSets(p, ctl);
    const windows = [...leakWindows(ctl.texts.guideline), ...leakWindows(ctl.texts.goldenAnswer)];
    const outDir = path.join(designer, 'out');
    const design = readDesign({ outDir, packet: ctl.packet, withheldHashes: sets.hashes, windows });
    fs.cpSync(outDir, path.join(attemptDir, 'out'), { recursive: true, errorOnExist: true });
    const manifest = buildWork({ originalDir: path.join(ws, 'original'), outDir, workDir: path.join(ws, 'work', 'filesystem'), packet: ctl.packet, design });
    ctl.manifest = manifest;
    const after = this._withheldSets(p, ctl);
    verifyPacket({ dir: path.join(ws, 'work', 'filesystem'), manifest, withheldHashes: after.hashes, withheldNames: after.names });

    const bytes = manifest.reduce((sum, file) => sum + file.bytes, 0);
    attempt.traps = design.traps.map(trap => ({ id: trap.id, title: trap.title }));
    attempt.newFiles = design.newFiles.length;
    attempt.editedFiles = design.editedFiles.length;
    attempt.audit = { status: run.audit.status, violationCount: 0 };
    attempt.promptSha256 = sha256Hex(design.prompt);
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
    };
    this._save(p);
  }

  _writeDesignerInputs(p, ctl, designer, redesign) {
    const put = (rel, text) => fs.writeFileSync(path.join(designer, rel), text, { mode: 0o600 });
    for (const name of ctl.packet.keys()) {
      const target = path.join(designer, 'task', ...name.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(this._originalFile(p, name), target, fs.constants.COPYFILE_EXCL);
    }
    put('prompt.txt', ctl.texts.prompt);
    for (const [role, rel, label] of [['guideline', 'guideline.md', 'grader guideline'], ['goldenAnswer', 'golden-answer.md', 'golden answer']]) {
      const binary = ctl.texts.binary[role];
      if (binary) {
        const target = path.join(designer, `${role}-original`, ...binary.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.copyFileSync(this._originalFile(p, binary), target, fs.constants.COPYFILE_EXCL);
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

  /* feedback.md for the next design: every pilot's score, verdict, the grader's reason and the final answer. */
  _prepareFeedback(p, ctl, attempt, failed) {
    const pilots = failed.pilots.map(pilot => ({ ...pilot, answer: ctl.answers.get(`${pilot.round}#${pilot.run}`) || '' }));
    const history = p.attempts.filter(item => item.n !== attempt.n).map(item => ({ n: item.n, outcome: this._outcomeLine(item) }));
    ctl.feedback = feedbackText({
      attempt: attempt.n,
      stage: { name: failed.name, rule: failed.rule, bar: P.PASS_BAR, belowBar: failed.belowBar, pilotsWanted: failed.of, pilots },
      history,
      traps: p.design.traps,
    });
    try { writeTextAtomic(path.join(this._attemptDir(p.id, attempt.n), 'feedback.md'), ctl.feedback); } catch { /* the copy in memory is what the designer gets */ }
  }

  _outcomeLine(attempt) {
    const scores = stage => (stage ? stage.pilots.map(pilot => (typeof pilot.score === 'number' ? pilot.score.toFixed(2) : 'none')).join(', ') : '');
    return `${attempt.outcome}; screen scores: ${scores(attempt.screen) || 'none'}${attempt.test ? `; test scores: ${scores(attempt.test)}` : ''}`;
  }

  /* -------------------------------------------------------------- screen and test */

  /* One pilot stage: a round of pilots, the grading of their answers, and, when a pilot did not give a usable score, one replacement
     round for the missing ones. Decides from what exists: a missing score counts as the pilot getting through (against the design). */
  async _pilotStage(p, ctl, kind) {
    const screen = kind === 'screen';
    const wanted = screen ? P.SCREEN_PILOTS : P.TEST_PILOTS;
    const need = screen ? P.SCREEN_PILOTS : P.TEST_NEED;
    const attempt = p.attempts[p.attempts.length - 1];
    const result = {
      name: kind,
      rule: screen ? `both of the ${wanted} pilots score below ${P.PASS_BAR}` : `at least ${need} of the ${wanted} pilots score below ${P.PASS_BAR}`,
      bar: P.PASS_BAR, need, of: wanted, roundIds: [], pilots: [], counted: 0, belowBar: 0, passed: null, replacementRound: false, startedAt: this.now(), endedAt: null,
    };
    await this._pilotsAndGrades(p, ctl, kind, result, wanted, false);
    if (result.counted < wanted) {
      result.replacementRound = true;
      await this._pilotsAndGrades(p, ctl, kind, result, wanted - result.counted, true);
    }
    result.passed = result.belowBar >= need;
    result.endedAt = this.now();
    this._save(p);
    return result;
  }

  async _pilotsAndGrades(p, ctl, kind, result, count, replacement) {
    const gradeStage = kind === 'screen' ? 'grade-screen' : 'grade-test';
    const what = `the ${replacement ? 'replacement round of the ' : ''}${kind}`;
    this._checkStop(ctl);
    this._reserve(p, what, count * (p.config.pilotCapUsd + P.CAPS.graderUsd));
    const attempt = p.attempts[p.attempts.length - 1];
    if (!attempt[kind]) attempt[kind] = result;
    this._setStage(p, kind, replacement ? `Running ${count} replacement pilot${count === 1 ? '' : 's'} for the ${kind}` : `Running ${count} pilot${count === 1 ? '' : 's'} for the ${kind}`);
    const records = await this._runRound(p, ctl, kind, count, replacement, result.pilots.length);
    for (const record of records) result.pilots.push(record);
    result.roundIds.push(records.length ? records[0].round : null);
    this._save(p);
    this._checkStop(ctl);
    this._setStage(p, gradeStage, `Grading the answers of the ${kind} pilots`);
    await this._grade(p, ctl, gradeStage, records);
    for (const record of records) delete record.gradable;
    result.counted = result.pilots.filter(pilot => pilot.valid).length;
    result.belowBar = result.pilots.filter(pilot => pilot.valid && pilot.score < P.PASS_BAR).length;
    this._save(p);
    this._checkStop(ctl);
  }

  /* Safety checks, then one round of the agent service: create, freeze (the gold and fingerprints of the design), approve, launch, wait.
     Returns one record per pilot. */
  async _runRound(p, ctl, kind, count, replacement, startIndex) {
    this._checkStop(ctl);
    const attempt = p.attempts[p.attempts.length - 1];
    const ws = this._workspace(p.id);
    const texts = this._designTexts(p);
    if (sha256Hex(texts.prompt) !== attempt.promptSha256) throw new SafetyError('The prompt changed after it was checked');
    const sets = this._withheldSets(p, ctl);
    verifyPacket({ dir: path.join(ws, 'work', 'filesystem'), manifest: ctl.manifest, withheldHashes: sets.hashes, withheldNames: sets.names });
    const windows = [...leakWindows(ctl.texts.guideline), ...leakWindows(ctl.texts.goldenAnswer), ...leakWindows(texts.guideline), ...leakWindows(texts.goldenAnswer)];
    if (windows.length && windows.some(window => window && this._squashIncludes(texts.prompt, window))) throw new SafetyError('The prompt holds a long passage of the guideline or the golden answer');

    let roundId = null;
    try {
      const created = await this.agents.createRound({
        label: `${p.label} attempt ${attempt.n} ${kind}${replacement ? ' replacement' : ''}`.slice(0, 120),
        task: `Pipeline ${p.id}`,
        sourceDir: path.join(ws, 'work', 'filesystem'),
        include: ctl.manifest.map(file => file.name),
        promptText: texts.prompt,
        gafVisible: false,
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
    await this.agents.whenSettled(roundId);
    const view = await this.agents.getRound(roundId);
    ctl.roundId = null;
    const records = [];
    for (const row of view.runs) {
      const started = Boolean(row.startedAt);
      const usd = this._spend(p, kind, 'pilot', `${roundId}#${row.n}`, row.costUsd, p.config.pilotCapUsd, started);
      const clean = row.state === 'completed' && row.audit && row.audit.status === 'CLEAN';
      let answer = '';
      if (clean) {
        try { answer = String((await this.agents.getRun(roundId, row.n)).final.text || ''); } catch { answer = ''; }
        ctl.answers.set(`${roundId}#${row.n}`, answer);
      }
      records.push({
        n: startIndex + records.length + 1,
        id: `p${startIndex + records.length + 1}`,
        round: roundId, run: row.n, replacement, state: row.state,
        audit: row.audit ? { status: row.audit.status, violationCount: row.audit.violationCount } : null,
        costUsd: round6(usd), estimated: started && typeof row.costUsd !== 'number',
        gradable: clean && Boolean(answer.trim()), score: null, verdict: null, reason: '', valid: false, belowBar: null,
      });
    }
    this._checkStop(ctl);
    return records;
  }

  _squashIncludes(text, window) {
    return String(text).replace(/\s+/gu, ' ').trim().toLowerCase().includes(window);
  }

  /* The simulated grader scores each clean answer against the design's guideline, one call per answer (so Stop is prompt). A call that
     gives no usable score leaves the pilot without one; a call the service refuses fails the stage. */
  async _grade(p, ctl, stage, records) {
    const todo = records.filter(record => record.gradable);
    if (!todo.length) return;
    this._reserve(p, 'grading', todo.length * P.CAPS.graderUsd);
    const guideline = this._designTexts(p).guideline + GRADER_FOOTER;
    for (const record of todo) {
      this._checkStop(ctl);
      const answer = capText(ctl.answers.get(`${record.round}#${record.run}`) || '', MAX_ANSWER_FOR_GRADER);
      let res;
      ctl.graderRunning = true;
      try {
        res = await this.agents.graderSim({ guidelineText: guideline, answerTexts: [answer], model: p.config.graderModel, effort: p.config.effort });
      } catch (error) {
        if (ctl.stop) throw new StopSignal('stopped');
        throw error instanceof AgentError ? error : new Failure('The simulated grader could not be run');
      } finally {
        ctl.graderRunning = false;
      }
      const one = Array.isArray(res.results) && res.results.length ? res.results[0] : {};
      this._spend(p, stage, 'grader', `${record.round}#${record.run}`, one.costUsd, P.CAPS.graderUsd, typeof one.state === 'string');
      if (ctl.stop || one.state === 'cancelled') throw new StopSignal('stopped');
      record.verdict = typeof res.verdict === 'string' ? res.verdict : null;
      record.reason = capText(typeof res.reason === 'string' ? res.reason : '', MAX_REASON);
      if (typeof res.score === 'number' && Number.isFinite(res.score) && !one.discarded) {
        record.score = res.score;
        record.valid = true;
        record.belowBar = res.score < P.PASS_BAR;
      }
      this._save(p);
    }
  }
}

function createPipelineService(options = {}) {
  return new PipelineService(options);
}

module.exports = { PipelineService, createPipelineService, parseLink, PipelineStopSignal: StopSignal };
