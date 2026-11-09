'use strict';
/* The humanize service the companion mounts (backend/server.cjs, /api/humanize). One run at a time: the Verva worker owns one Chrome
   profile. Runs live in memory; each finished run is also written to <root>/private/humanize/runs/<id>.json (0600), which git ignores.

   createHumanizeService({ root, env, keys?, verva?, fetch?, now? })
     The GPTZero key is moved out of `env` here (keys.takeFromEnv): the companion builds this service BEFORE the agent service, so a
     pilot, which inherits the companion's environment, never sees it.
   status()                       -> { bars, limits, rewriters, detectors, acknowledgement, gptzero: { found, source }, verva: {...} }
   list()                         -> { runs: [row], running, config: status() }
   start(body)                    -> { id }   body: { text, rewriter, detector, workers?, maxPasses?, maxRounds?, acknowledgements: [] }
   get(id) / stop(id)             -> the run's view
   configureVerva(body)           -> verva status   body: { url?, input?, button?, output?, minWords?, headless? }
   vervaSignIn() / vervaSignInDone()
   busy(), shutdown()
   Errors are HumanizeError with an HTTP status; the companion turns them into answers. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { runHumanize, settingsOf } = require('./orchestrator.cjs');
const { pickProviders, REWRITERS, DETECTORS } = require('./providers/index.cjs');
const { createVervaWeb, writeConfig } = require('./providers/verva-web.cjs');
const { createKeyStore } = require('./keys.cjs');
const { HumanizeError } = require('./errors.cjs');
const { BARS, LIMITS, ENDED, THIRD_PARTY_ACK, THIRD_PARTY_TEXT } = require('./constants.cjs');

const ID_RE = /^hz-[a-z0-9]{6,20}-[a-f0-9]{6}$/;
const KEEP_RUNS = 20;

function createHumanizeService(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const env = options.env || process.env;
  const keys = options.keys || createKeyStore({ env });
  if (typeof keys.takeFromEnv === 'function') keys.takeFromEnv();
  const verva = options.verva || createVervaWeb({ root, env });
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const runs = new Map(); /* id -> { view, controller, done } */
  let current = null;

  const runsDir = () => path.join(root, 'private', 'humanize', 'runs');

  async function status() {
    return {
      bars: { ...BARS },
      limits: { maxPasses: LIMITS.maxPasses, maxPassesCap: LIMITS.maxPassesCap, maxRounds: LIMITS.maxRounds, maxRoundsCap: LIMITS.maxRoundsCap, maxWorkers: LIMITS.maxWorkers, flaggedSpan: LIMITS.flaggedSpan, maxTextChars: LIMITS.maxTextChars },
      rewriters: REWRITERS.map(r => ({ ...r })),
      detectors: DETECTORS.map(d => ({ ...d })),
      acknowledgement: { id: THIRD_PARTY_ACK, text: THIRD_PARTY_TEXT },
      gptzero: await keys.describe('gptzero'),
      verva: verva.status(),
    };
  }

  const row = (id, view) => ({
    id, status: view.status, stage: view.stage, round: view.round, pass: view.pass, startedAt: view.startedAt, endedAt: view.endedAt,
    aggregate: view.aggregate ? view.aggregate.human : null, signedOff: Boolean(view.signedOff),
    rewriter: view.providers && view.providers.rewriter ? view.providers.rewriter.id : null,
    detector: view.providers && view.providers.detector ? view.providers.detector.id : null,
    chunks: Array.isArray(view.chunks) ? view.chunks.length : 0,
  });

  function need(id) {
    if (typeof id !== 'string' || !ID_RE.test(id) || !runs.has(id)) throw new HumanizeError('There is no such humanize run.', 'input', 404);
    return runs.get(id);
  }

  function save(id, view) {
    try {
      fs.mkdirSync(runsDir(), { recursive: true, mode: 0o700 });
      const file = path.join(runsDir(), `${id}.json`);
      fs.writeFileSync(file, JSON.stringify({ id, ...view }, null, 2), { mode: 0o600 });
    } catch { /* the run's result is still in memory and on the page */ }
  }

  function prune() {
    const ended = [...runs].filter(([, r]) => ENDED.includes(r.view.status));
    while (runs.size > KEEP_RUNS && ended.length) runs.delete(ended.shift()[0]);
  }

  async function start(body = {}) {
    if (current) throw new HumanizeError('A humanize run is already running. Stop it or wait until it ends.', 'busy', 409);
    if (!body || typeof body !== 'object') throw new HumanizeError('Send the run as a JSON object.', 'input', 400);
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) throw new HumanizeError('Paste the text to humanize.', 'input', 400);
    if (text.length > LIMITS.maxTextChars) throw new HumanizeError(`The text is longer than ${LIMITS.maxTextChars} characters.`, 'input', 400);
    const providers = pickProviders({ rewriter: body.rewriter, detector: body.detector }, { verva, keys, fetch: options.fetch });
    const acks = Array.isArray(body.acknowledgements) ? body.acknowledgements : [];
    if (providers.external && !acks.includes(THIRD_PARTY_ACK)) throw new HumanizeError(`Confirm that text leaves this computer: ${THIRD_PARTY_TEXT}`, 'input', 400);
    const runOptions = {
      maxPasses: body.maxPasses, maxRounds: body.maxRounds,
      workers: Number.isInteger(body.workers) ? { rewrite: body.workers, scan: body.workers } : undefined,
    };
    const id = `hz-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const controller = new AbortController();
    const entry = { view: { status: 'running', stage: 'secretary', round: 0, pass: 0, startedAt: now(), endedAt: null, settings: settingsOf(runOptions), providers: { rewriter: { id: providers.rewriter.id, label: providers.rewriter.label }, detector: { id: providers.detector.id, label: providers.detector.label, estimate: Boolean(providers.detector.estimate) } }, chunks: [], log: [] }, controller, done: null };
    runs.set(id, entry);
    current = id;
    entry.done = runHumanize(text, { rewriter: providers.rewriter, detector: providers.detector, options: runOptions, signal: controller.signal, now, onUpdate: v => { entry.view = v; } })
      .then(view => { entry.view = view; save(id, view); })
      .catch(error => { entry.view = { ...entry.view, status: 'failed', error: String(error && error.message ? error.message : error), endedAt: now() }; })
      /* Verva's Chrome closes after every run: it writes the sign-in to the profile and the profile forgets its history */
      .finally(async () => {
        if (providers.rewriter === verva) await verva.close().catch(() => {});
        if (current === id) current = null;
        prune();
      });
    return { id };
  }

  return {
    status,
    async list() {
      return { runs: [...runs].map(([id, r]) => row(id, r.view)).reverse(), running: current, config: await status() };
    },
    start,
    get(id) { return { id, ...need(id).view }; },
    async stop(id) {
      const entry = need(id);
      entry.controller.abort();
      await Promise.race([entry.done, new Promise(resolve => setTimeout(resolve, 5000))]);
      return { id, ...entry.view };
    },
    async configureVerva(body = {}) {
      if (current) throw new HumanizeError('Change the Verva settings when no humanize run is running.', 'busy', 409);
      const patch = {};
      for (const key of ['url', 'input', 'button', 'output', 'minWords', 'headless']) if (body[key] !== undefined) patch[key] = body[key];
      writeConfig(root, patch);
      await verva.close();
      return verva.status();
    },
    async vervaSignIn() {
      if (current) throw new HumanizeError('Sign in when no humanize run is running.', 'busy', 409);
      await verva.signIn();
      return verva.status();
    },
    async vervaSignInDone() {
      await verva.finishSignIn();
      return verva.status();
    },
    busy: () => Boolean(current),
    async shutdown() {
      for (const entry of runs.values()) entry.controller.abort();
      await Promise.race([Promise.allSettled([...runs.values()].map(r => r.done)), new Promise(resolve => setTimeout(resolve, 5000))]);
      await verva.finishSignIn().catch(() => {});
      await verva.close().catch(() => {});
    },
  };
}

const { redactHumanizeData } = require('./redact.cjs');

module.exports = { createHumanizeService, redactHumanizeData, ID_RE };
