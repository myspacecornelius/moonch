'use strict';
/* What one full attempt can cost at most, so that a total cap which cannot pay for it is refused before anything starts.

   A full attempt of the 'harden' mode is the classifier, the designer (and its one repair turn), the check of the golden answer (two grader calls at
   most), the fairness review (two calls at most), and then the 2-pilot screen and the 5-pilot test, each pilot with its own cap and two grader calls at most.
   A full attempt of the 'new' mode (the default) is the classifier, the designer and its repair turn, the blind review and the reveal (each twice at worst),
   the application checks of the reveal's clause and of every clause of the brief, two repairs for what the reviews find, the answer set (three grades of
   each fixed answer at worst), and the same pilots with one adjudication call for each. Every step is reserved with the headroom on top (service.cjs
   _reserve), so the minimum is the headroom times the sum.

   minCap (GET /api/pipeline, config.minCap) hands the parts to the page: ceil to the cent of
     headroom x (fixedUsd + pilots x (pilotCapUsd + perPilotUsd)).
   At the default caps: 'new' 59.80 (63.25 with the optional diagnostic suite), 'harden' 41.40. */

const P = require('./constants.cjs');

const round6 = value => Math.round(value * 1e6) / 1e6;
/* The application checks of one review at the most traps a brief may have: the clause the reveal quotes against the alternative, and, for every trap, its rule
   and the quote that rules its strongest alternative out. A check that was already made on the same packet is not made again, and a call that has to be
   repeated is reserved when it is needed. */
const APPLICATION_CHECKS = 1 + 2 * P.DESIGN.traps;

/* The parts that do not depend on the pilots' cap. designCapUsd: the designer's cap (the default one when none is given). options.fairnessSet:
   the optional diagnostic suite is on (FAIRNESS_SET_USD more per attempt). mode:
     'harden'  the classifier, the designer and its repair turn, the check of the golden answer (2 grader calls at most), the single
               fairness review (2 calls at most); per pilot the grader calls.
     'new'     the classifier, the designer and its repair turn, the blind and the reveal review (each twice at worst: a retry, or the
               rerun after a repair), the application checks of the reveal's clause and of every clause of the brief (APPLICATION_CHECKS calls), two repair
               turns for what the reviews find, and the answer set (the golden answer and up to MAX_ALTERNATIVES
               permitted alternatives, ANSWER_SET_GRADES grades each at worst); per pilot the grader calls and one adjudication call.
   This is a typical worst case and not the last one: every review retried in each of two evaluations, every application check failing, the answer set graded
   again after each repair and a null grade asked for again come to about USD 48 before the first pilot, which no usable cap pays for. Whatever goes beyond the
   reserve (a second try of a review, a regrade after a guideline revision, a second pass of the reviews) is reserved call by call when it is needed; a call the
   cap cannot pay for ends the run as incomplete, and nothing passes without its checks. */
function minCapParts(designCapUsd = P.CAPS.designUsd, mode = P.DEFAULT_DESIGN_MODE, options = {}) {
  const caps = P.CAPS;
  const common = caps.classifyUsd + designCapUsd + caps.repairUsd;
  const fixedUsd = mode === 'harden'
    ? common + 2 * caps.graderUsd + 2 * caps.fairnessUsd
    : common + 2 * (caps.blindReviewUsd + caps.revealReviewUsd) + APPLICATION_CHECKS * caps.applicationUsd + 2 * caps.repairUsd + (1 + P.MAX_ALTERNATIVES) * P.ANSWER_SET_GRADES * caps.graderUsd;
  return {
    fixedUsd: round6(fixedUsd + (mode === 'new' && options.fairnessSet === true ? P.FAIRNESS_SET_USD : 0)),
    perPilotUsd: round6(P.GRADE_CALLS_PER_PILOT * caps.graderUsd + (mode === 'harden' ? 0 : caps.adjudicationUsd)),
    pilots: P.SCREEN_PILOTS + P.TEST_PILOTS,
    headroom: P.HEADROOM,
  };
}

/* What a 'new' attempt reserves before it starts, apart from the classifier (which ran once): every check that is mandatory for the attempt. */
function attemptReserveUsd(designCapUsd = P.CAPS.designUsd, options = {}) {
  const parts = minCapParts(designCapUsd, 'new', options);
  return round6(parts.fixedUsd - P.CAPS.classifyUsd + parts.pilots * P.CAPS.adjudicationUsd);
}

/* The smallest total cap that pays for one full attempt, in whole cents. */
function minCapUsd({ designCapUsd, pilotCapUsd, mode = P.DEFAULT_DESIGN_MODE, fairnessSet = false }) {
  const parts = minCapParts(designCapUsd, mode, { fairnessSet });
  const raw = parts.headroom * (parts.fixedUsd + parts.pilots * (pilotCapUsd + parts.perPilotUsd));
  return Math.ceil(Math.round(raw * 1e6) / 1e4) / 100;
}

module.exports = { minCapParts, minCapUsd, attemptReserveUsd, APPLICATION_CHECKS };
