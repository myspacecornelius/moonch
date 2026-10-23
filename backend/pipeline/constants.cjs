'use strict';
/* Shared limits, rules and wording of the pipeline (link -> traps -> 2-pilot screen -> 5-pilot test).
   The server enforces every value here. The browser only displays them (GET /api/pipeline carries them as `config`). */

const PASS_BAR = 0.45; /* a pilot "beats" the design when the simulated grader scores its answer below this */
const SCREEN_PILOTS = 2; /* the screen passes when BOTH score below the bar */
const TEST_PILOTS = 5;
const TEST_NEED = 4; /* the test succeeds when at least this many of the pilots score below the bar */
const MAX_REDESIGNS = 3; /* then stop and show the owner */
const DEFAULT_CAP_USD = 30;
const MAX_CAP_USD = 200;

/* The three the agent service asks for before a round, plus the one the pipeline adds: the classifier, the designer and the
   grader send the task text, the guideline and the golden answer to Anthropic. */
const AGENT_ACKNOWLEDGEMENTS = ['shell-access', 'network', 'isolation-by-audit'];
const MODEL_READS_TASK = 'model-reads-task';
const ACKNOWLEDGEMENTS = [...AGENT_ACKNOWLEDGEMENTS, MODEL_READS_TASK];
const MODEL_READS_TASK_TEXT = 'Model reads the task: the classifier, the trap designer and the simulated grader are Claude Code runs that send the task text, the grader guideline and the golden answer to Anthropic. The trap designer is an agent with the same tools as a pilot (Bash, Read, Write, Edit, Glob and Grep) in its own working folder, held to that folder by the same after-the-fact audit and not by a sandbox.';

const STAGES = ['import', 'classify', 'design', 'screen', 'grade-screen', 'redesign', 'test', 'grade-test', 'done', 'failed', 'stopped', 'budget'];
const TERMINAL = ['done', 'failed', 'stopped', 'budget'];

/* Spending caps (--max-budget-usd) of the calls that are not pilots. A grader call uses the agent service's tool-less default
   (a test ties graderUsd to BUDGET_USD.toolLessDefault). repairUsd is the one repair turn of the designer, fairnessUsd one fairness review. */
const CAPS = { classifyUsd: 0.5, designUsd: 5, graderUsd: 0.5, repairUsd: 1, fairnessUsd: 0.25 };

/* Every reservation before a step is its worst case times this: a run can finish a little over its cap (the runtime checks the cap
   between turns). */
const HEADROOM = 1.15;

/* The golden answer of a design must score at least this against the design's own guideline, or the design is rejected before any pilot
   runs. A pilot score in REGRADE_BAND (both ends included) is graded a second time and the two are averaged. */
const GOLDEN_MIN = 0.9;
const REGRADE_BAND = [0.4, 0.5];
/* The simulated grader runs at least at this effort, whatever the pilots use. */
const MIN_GRADER_EFFORT = 'medium';
/* A grader call at most twice per pilot (the second only in the regrade band). */
const GRADE_CALLS_PER_PILOT = 2;

/* What a link or a folder may bring in (the link loader has the same caps). */
const INTAKE = { files: 300, fileBytes: 200 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024, depth: 4, sections: 200, sectionChars: 20000, pageBytes: 8 * 1024 * 1024, textBytes: 1024 * 1024 };

/* What the designer may hand back. The prompt and the guideline limits are the agent service's (rounds.cjs). */
const DESIGN = { traps: 3, promptChars: 20000, guidelineChars: 29000, goldenChars: 60000, newFiles: 100, titleChars: 200, textChars: 1000, reasonChars: 500, leakWindow: 80, leakStep: 30, guidelineGrowth: 1.5, editShrinkMax: 0.2, rubricChanges: 20, diffLines: 200 };

const ID_RE = /^pln-[0-9a-f]{12}$/;
const WORKSPACE_DIRNAME = 'finance-studio-pipelines';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

module.exports = deepFreeze({
  PASS_BAR, SCREEN_PILOTS, TEST_PILOTS, TEST_NEED, MAX_REDESIGNS, DEFAULT_CAP_USD, MAX_CAP_USD,
  AGENT_ACKNOWLEDGEMENTS, MODEL_READS_TASK, ACKNOWLEDGEMENTS, MODEL_READS_TASK_TEXT,
  STAGES, TERMINAL, CAPS, HEADROOM, GOLDEN_MIN, REGRADE_BAND, MIN_GRADER_EFFORT, GRADE_CALLS_PER_PILOT, INTAKE, DESIGN, ID_RE, WORKSPACE_DIRNAME,
});
