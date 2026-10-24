'use strict';
/* Shared limits, rules and wording of the pipeline (link -> traps -> 2-pilot screen -> 5-pilot test).
   The server enforces every value here. The browser only displays them (GET /api/pipeline carries them as `config`). */

/* A pilot "beats" the design when the simulated grader scores its answer below the bar of the stage. The screen is the stricter: it passes
   only when both of its pilots score below SCREEN_BAR; the test needs at least TEST_NEED of its pilots below TEST_BAR. */
const SCREEN_BAR = 0.40;
const TEST_BAR = 0.45;
const PASS_BAR = TEST_BAR; /* the name the first version used for the test's bar; config.passBar is still sent, with this value */
const SCREEN_PILOTS = 2; /* the screen passes when BOTH score below the bar */
const TEST_PILOTS = 5;
const TEST_NEED = 4; /* the test succeeds when at least this many of the pilots score below the bar */
const MAX_REDESIGNS = 3; /* then stop and show the owner */
const DEFAULT_CAP_USD = 60; /* pays for one full attempt of the 'new' mode at the default caps (budget.cjs: 59.80; the 'harden' mode needs 41.40) */
const MAX_CAP_USD = 200;

/* The three the agent service asks for before a round, plus the one the pipeline adds: the classifier, the designer and the
   grader send the task text, the guideline and the golden answer to Anthropic. */
const AGENT_ACKNOWLEDGEMENTS = ['shell-access', 'network', 'isolation-by-audit'];
const MODEL_READS_TASK = 'model-reads-task';
const ACKNOWLEDGEMENTS = [...AGENT_ACKNOWLEDGEMENTS, MODEL_READS_TASK];
const MODEL_READS_TASK_TEXT = 'Model reads the task: the classifier, the trap designer and the simulated grader are Claude Code runs that send the task text, the grader guideline and the golden answer to Anthropic. The trap designer is an agent with the same tools as a pilot (Bash, Read, Write, Edit, Glob and Grep) in its own working folder, held to that folder by the same after-the-fact audit and not by a sandbox. The reviewers of a new design are Claude Code runs too: the blind reviewer reads a copy of the packet with the Read, Glob and Grep tools, and the others have no tools. When reference documents are used, the trap designer reads them and they are sent to Anthropic as well.';

const STAGES = ['import', 'classify', 'design', 'screen', 'grade-screen', 'redesign', 'test', 'grade-test', 'done', 'failed', 'stopped', 'budget'];
const TERMINAL = ['done', 'failed', 'stopped', 'budget'];

/* Spending caps (--max-budget-usd) of the calls that are not pilots. A grader call uses the agent service's tool-less default
   (a test ties graderUsd to BUDGET_USD.toolLessDefault). repairUsd is the one repair turn of the designer, fairnessUsd one fairness review. */
const CAPS = {
  classifyUsd: 0.5, designUsd: 5, graderUsd: 0.5, repairUsd: 1,
  fairnessUsd: 0.25, /* the single tool-less fairness review of the 'harden' mode */
  blindReviewUsd: 1.5, /* designer v2 stage 1: a reviewer that reads a copy of the pilot packet, blind */
  revealReviewUsd: 0.5, /* stage 2: the reveal, tool-less */
  applicationUsd: 0.5, /* stage 2b: does the quoted clause govern, is it in force, is it not superseded, does it exclude the alternative */
  adjudicationUsd: 0.5, /* one call for every pilot that scored below its bar */
};

/* Every reservation before a step is its worst case times this: a run can finish a little over its cap (the runtime checks the cap
   between turns). */
const HEADROOM = 1.15;

/* The golden answer of a design must score at least this against the design's own guideline, or the design is rejected before any pilot
   runs. A pilot score within a regrade band (both ends included; one around each bar) is graded a second time and the two are averaged,
   before the score counts toward a decision. */
const GOLDEN_MIN = 0.9;
/* Designer v2 (designMode 'new'): the fixed answer set that every guideline must be able to grade. The golden answer must reach GOLDEN_MIN, each
   permitted alternative ALTERNATIVE_MIN. Each answer is graded twice, a third time when the two straddle the threshold (the majority decides),
   so ANSWER_SET_GRADES is the worst case per answer; MAX_ALTERNATIVES is how many permitted alternatives a design may declare. */
const ALTERNATIVE_MIN = 0.85;
const ANSWER_SET_GRADES = 3;
const MAX_ALTERNATIVES = 2;
/* The optional diagnostic suite (the start-form switch fairnessSet): up to this much per attempt. */
const FAIRNESS_SET_USD = 3;
const DESIGN_MODES = ['new', 'harden'];
const DEFAULT_DESIGN_MODE = 'new';
/* The reference documents of the owner: the designer and the reveal-side reviews read them, pilots never. */
const REFERENCES = { files: 20, bytes: 8 * 1024 * 1024, depth: 2, extensions: ['.md', '.txt', '.pdf', '.docx', '.xlsx', '.csv', '.json'] };
/* A quote in a review or in the brief is only evidence when it is this long and found, word for word, in the text it names. */
const MIN_QUOTE_CHARS = 12;
/* A quote of a clause, a scope sentence, a date or a reason in the packet is evidence only when it is a sentence's worth: this many characters, or, when it is
   shorter than MIN_CLAUSE_QUOTE_CHARS, a whole sentence of at least MIN_SENTENCE_QUOTE_CHARS. (MIN_QUOTE_CHARS still applies to the words of a pilot's answer.) */
const MIN_CLAUSE_QUOTE_CHARS = 40;
const MIN_SENTENCE_QUOTE_CHARS = 20;
const ADJUDICATION_CLASSES = ['intended', 'other_valid_error', 'permitted_alternative', 'grader_defect', 'ambiguous', 'tool_failure', 'unsupported'];
const SCREEN_REGRADE_BAND = [0.35, 0.45];
const TEST_REGRADE_BAND = [0.4, 0.5];
const REGRADE_BAND = TEST_REGRADE_BAND; /* the first version's name for the test's band */
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
  SCREEN_BAR, TEST_BAR, PASS_BAR, SCREEN_PILOTS, TEST_PILOTS, TEST_NEED, MAX_REDESIGNS, DEFAULT_CAP_USD, MAX_CAP_USD,
  AGENT_ACKNOWLEDGEMENTS, MODEL_READS_TASK, ACKNOWLEDGEMENTS, MODEL_READS_TASK_TEXT,
  STAGES, TERMINAL, CAPS, HEADROOM, GOLDEN_MIN, ALTERNATIVE_MIN, ANSWER_SET_GRADES, MAX_ALTERNATIVES, FAIRNESS_SET_USD, DESIGN_MODES, DEFAULT_DESIGN_MODE, REFERENCES, MIN_QUOTE_CHARS, MIN_CLAUSE_QUOTE_CHARS, MIN_SENTENCE_QUOTE_CHARS, ADJUDICATION_CLASSES, SCREEN_REGRADE_BAND, TEST_REGRADE_BAND, REGRADE_BAND, MIN_GRADER_EFFORT, GRADE_CALLS_PER_PILOT, INTAKE, DESIGN, ID_RE, WORKSPACE_DIRNAME,
});
