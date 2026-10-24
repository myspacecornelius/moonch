'use strict';
/* What one full attempt can cost at most, so that a total cap which cannot pay for it is refused before anything starts.

   A full attempt is the classifier, the designer (and its one repair turn), the check of the golden answer (two grader calls at most),
   the fairness review (two calls at most), and then the 2-pilot screen and the 5-pilot test, each pilot with its own cap and two grader
   calls at most. Every step is reserved with the headroom on top (service.cjs _reserve), so the minimum is the headroom times the sum.

   minCap (GET /api/pipeline, config.minCap) hands the parts to the page: ceil to the cent of
     headroom x (fixedUsd + pilots x (pilotCapUsd + perPilotUsd)). */

const P = require('./constants.cjs');

const round6 = value => Math.round(value * 1e6) / 1e6;

/* The parts that do not depend on the pilots' cap. designCapUsd: the designer's cap (the default one when none is given). */
function minCapParts(designCapUsd = P.CAPS.designUsd) {
  return {
    fixedUsd: round6(P.CAPS.classifyUsd + designCapUsd + P.CAPS.repairUsd + 2 * P.CAPS.graderUsd + 2 * P.CAPS.fairnessUsd),
    perPilotUsd: round6(P.GRADE_CALLS_PER_PILOT * P.CAPS.graderUsd),
    pilots: P.SCREEN_PILOTS + P.TEST_PILOTS,
    headroom: P.HEADROOM,
  };
}

/* The smallest total cap that pays for one full attempt, in whole cents. */
function minCapUsd({ designCapUsd, pilotCapUsd }) {
  const parts = minCapParts(designCapUsd);
  const raw = parts.headroom * (parts.fixedUsd + parts.pilots * (pilotCapUsd + parts.perPilotUsd));
  return Math.ceil(Math.round(raw * 1e6) / 1e4) / 100;
}

module.exports = { minCapParts, minCapUsd };
