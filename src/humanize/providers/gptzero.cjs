'use strict';
/* The sign-off detector: GPTZero's API (POST https://api.gptzero.me/v2/predict/text, header x-api-key, body { document }).

   createGptZero({ keys, fetch, endpoint, timeoutMs, retries }) -> detector
     scan(text, { signal }) -> { human, ai, mixed, predictedClass, confidence, sentences: [{ text, generatedProb }] }
       human: documents[0].class_probabilities.human (or 1 - completely_generated_prob from an older answer).
     preflight() refuses to start a run without a key.
   The key comes from keys.cjs on every scan and goes only into the x-api-key header. Error messages carry the HTTP status and a fixed
   sentence, never the key and never the answer's body. A 429 or a 5xx is retried twice with a growing wait; a 401 or 403 is not. */

const { HumanizeError } = require('../errors.cjs');
const { whereToStore } = require('../keys.cjs');

const ENDPOINT = 'https://api.gptzero.me/v2/predict/text';
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('The run was stopped.'), { code: 'cancelled' })); }, { once: true });
});

function readAnswer(body) {
  const doc = body && Array.isArray(body.documents) ? body.documents[0] : null;
  if (!doc || typeof doc !== 'object') return null;
  const probs = doc.class_probabilities && typeof doc.class_probabilities === 'object' ? doc.class_probabilities : null;
  let human = probs && Number.isFinite(probs.human) ? probs.human : null;
  if (human === null && Number.isFinite(doc.completely_generated_prob)) human = 1 - doc.completely_generated_prob;
  if (human === null) return null;
  const sentences = Array.isArray(doc.sentences)
    ? doc.sentences.filter(s => s && typeof s.sentence === 'string' && Number.isFinite(s.generated_prob)).map(s => ({ text: s.sentence, generatedProb: s.generated_prob }))
    : [];
  return {
    human,
    ai: probs && Number.isFinite(probs.ai) ? probs.ai : null,
    mixed: probs && Number.isFinite(probs.mixed) ? probs.mixed : null,
    predictedClass: typeof doc.predicted_class === 'string' ? doc.predicted_class : typeof doc.document_classification === 'string' ? doc.document_classification : null,
    confidence: typeof doc.confidence_category === 'string' ? doc.confidence_category : null,
    sentences,
  };
}

function createGptZero(options = {}) {
  const keys = options.keys;
  const doFetch = typeof options.fetch === 'function' ? options.fetch : globalThis.fetch;
  const endpoint = options.endpoint || ENDPOINT;
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 60000;
  const retries = Number.isInteger(options.retries) ? options.retries : 2;
  const waitMs = Number.isInteger(options.waitMs) ? options.waitMs : 2000;

  async function key() {
    const found = keys ? await keys.get('gptzero') : { key: null, error: null };
    if (!found.key) throw new HumanizeError(`No GPTZero API key${found.error ? ` (${found.error})` : ''}. ${whereToStore('gptzero')}`, 'config', 400);
    return found.key;
  }

  return {
    id: 'gptzero',
    label: 'GPTZero',
    estimate: false,
    external: true,
    async preflight() { await key(); },
    async scan(text, { signal } = {}) {
      const apiKey = await key();
      for (let attempt = 0; ; attempt += 1) {
        const timeout = AbortSignal.timeout(timeoutMs);
        let res;
        try {
          res = await doFetch(endpoint, {
            method: 'POST',
            headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ document: String(text) }),
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          });
        } catch (error) {
          if (signal && signal.aborted) throw Object.assign(new Error('The run was stopped.'), { code: 'cancelled' });
          if (attempt < retries) { await sleep(waitMs * (attempt + 1), signal); continue; }
          throw new HumanizeError(`GPTZero could not be reached (${timeout.aborted ? `no answer within ${Math.round(timeoutMs / 1000)} s` : 'network error'}).`, 'detector', 502);
        }
        if (res.status === 401 || res.status === 403) throw new HumanizeError(`GPTZero refused the API key (HTTP ${res.status}).`, 'detector', 502);
        if ((res.status === 429 || res.status >= 500) && attempt < retries) { await sleep(waitMs * (attempt + 1), signal); continue; }
        if (!res.ok) throw new HumanizeError(`GPTZero answered HTTP ${res.status}.`, 'detector', 502);
        let body;
        try { body = await res.json(); } catch { throw new HumanizeError('GPTZero sent an answer that is not JSON.', 'detector', 502); }
        const answer = readAnswer(body);
        if (!answer) throw new HumanizeError('GPTZero\'s answer had no human probability.', 'detector', 502);
        return answer;
      }
    },
  };
}

module.exports = { createGptZero, readAnswer, ENDPOINT };
