'use strict';
/* Which workers fill each field. rewriter: verva (Chrome) or stub; detector: gptzero or stub. */

const { stubRewriter, stubDetector } = require('./stub.cjs');
const { createGptZero } = require('./gptzero.cjs');
const { HumanizeError } = require('../errors.cjs');

const REWRITERS = Object.freeze([
  { id: 'verva', label: 'Verva (in Chrome)', external: true },
  { id: 'stub', label: 'Offline rewriter (stub, for a dry run)', external: false },
]);
const DETECTORS = Object.freeze([
  { id: 'gptzero', label: 'GPTZero', external: true },
  { id: 'stub', label: 'Offline estimate (stub, never signs off)', external: false },
]);

/* deps: { verva (a createVervaWeb instance), keys (a key store), fetch } */
function pickProviders({ rewriter = 'verva', detector = 'gptzero' } = {}, deps = {}) {
  let r;
  if (rewriter === 'stub') r = stubRewriter();
  else if (rewriter === 'verva') {
    if (!deps.verva) throw new HumanizeError('The Verva worker is not available here.', 'config', 400);
    r = deps.verva;
  } else throw new HumanizeError(`Unknown rewriter "${String(rewriter).slice(0, 40)}". Choose ${REWRITERS.map(x => x.id).join(' or ')}.`, 'config', 400);
  let d;
  if (detector === 'stub') d = stubDetector();
  else if (detector === 'gptzero') d = createGptZero({ keys: deps.keys, fetch: deps.fetch });
  else throw new HumanizeError(`Unknown detector "${String(detector).slice(0, 40)}". Choose ${DETECTORS.map(x => x.id).join(' or ')}.`, 'config', 400);
  return { rewriter: r, detector: d, external: Boolean(r.external || d.external) };
}

module.exports = { pickProviders, REWRITERS, DETECTORS };
