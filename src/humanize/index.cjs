'use strict';
/* src/humanize: the humanize orchestrator and its network of workers (docs/humanize.md). It runs on its own (cli.cjs, npm run humanize)
   or inside the Studio's companion (service.cjs, mounted by backend/server.cjs at /api/humanize). No dependencies beyond Node 22 and,
   for the Verva worker, the link loader's Chrome code in backend/links. */

const { runHumanize, settingsOf, sentenceReadings } = require('./orchestrator.cjs');
const { brief, findFacts, findTerms } = require('./secretary.cjs');
const { segment, assemble } = require('./chunks.cjs');
const { maskSegments, unmask } = require('./mask.cjs');
const { repairSegment } = require('./repair.cjs');
const { pickProviders, REWRITERS, DETECTORS } = require('./providers/index.cjs');
const { stubRewriter, stubDetector } = require('./providers/stub.cjs');
const { createGptZero } = require('./providers/gptzero.cjs');
const { createVervaWeb } = require('./providers/verva-web.cjs');
const { createHumanizeService } = require('./service.cjs');
const { redactHumanizeData } = require('./redact.cjs');
const { createKeyStore } = require('./keys.cjs');
const { HumanizeError, BudgetError } = require('./errors.cjs');
const constants = require('./constants.cjs');

module.exports = {
  runHumanize, settingsOf, sentenceReadings, brief, findFacts, findTerms, segment, assemble, maskSegments, unmask, repairSegment,
  pickProviders, REWRITERS, DETECTORS, stubRewriter, stubDetector, createGptZero, createVervaWeb, createHumanizeService, redactHumanizeData,
  createKeyStore, HumanizeError, BudgetError, constants,
};
