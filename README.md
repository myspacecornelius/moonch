# Finance Task Studio

A local, offline workspace for building the **failure-mode set** of a derivative finance task: three historical modes from the activity's failure-mode library plus two net-new modes from your own practice, each anchored to source evidence and recomputed economics, then carried into lint-checked grader guidance. It reads task packages (ZIP, XLSX, DOCX, CSV, text) in the browser, proposes source-linked candidate roots, and exports the solver draft, the private evaluator draft, the failure-mode records, and the persistent working document separately. It makes no network requests and calls no model.

Private task evidence never ships with the app. A bundled task audit is kept locally as a *private evidence module* (see below), loaded through a file picker, and ignored by git.

## Open it

- **Finance_Task_Studio.html** is the single-file edition: download it and open it in a current desktop browser. No installation, account, server, or internet connection is needed.
- **index.html** is the source-folder edition for development; keep every file beside it.
- **Start Finance Task Studio.command** (macOS) starts the optional localhost viewer with an installed Node runtime. It never starts a model run.

## Workflow

1. **Load the task package.** Drop the task ZIP or source files on Overview. Files are inventoried and extracted locally (formulas with saved values; PDFs stay unparsed). *Run local checks* reports saved formula errors, missing caches, hidden sheets, version clues, and prompt-wording cues, all labeled structural or heuristic.
2. **Generate candidate roots.** Three source-linked hypotheses are ranked by evidence, arithmetic, and causal independence. Same-root duplicates and non-binding variants are rejected; a candidate without a source-resolved answer is held. Ranking is not a difficulty prediction.
3. **Lock the set (Failure modes page).** Enter the task context from the task pull. Import the saved JSON of the activity's library pull; the app never calls the endpoint and the shared task key never enters it. The shortlist is deterministic: approved, uses above zero, numeric average score; lowest average first, then most uses, then not overused, then lowest usage share, then Mode ID. Exactly ten are shown; fewer is reported, never padded. Select exactly three by Mode ID. Add exactly two net-new modes from work you did or reviewed, or promote a candidate root with *Add as net-new mode*; record the duplicate check against the shortlist for each. Write the thesis that ties the five together.
4. **Instantiate each mode (Root design).** Complete the record contract: triggering condition, plausible wrong approach, detection method, corrective action, expected model behavior (solve, reconcile, push back), classification (strict error or judgment-call divergence), governing rule, facts, anchors, acceptable variations, and tolerance rationale. *Scaffold blanks from mechanism* fills empty fields from the research catalog, marked as hypotheses the audit keeps flagging until edited. One causal group per root: several changed outputs are one failure.
5. **Recompute both branches (Economics).** Enter correct and wrong outputs with units, tolerances, and an optional decision threshold. The helpers (cash bridge, whole-cent ceiling, record-date dividend capacity, affine fixed point) show their equation and limits.
6. **Draft, lint, export (Review and export).** *Draft from failure modes* writes deterministic grader guidance from the records; rewrite it in your own words. The lint flags what gets guidance returned: scoring or grading language, weighted rubrics, titled sections, raw cell references, internal jargon, dashes, arrows, multiplication signs, mentions of models or prompts, vague failure modes, and length past 500 or 800 words. Blockers are exact tokens; the rest are labeled heuristics. Exports: solver JSON/text (prompt and file manifest only), evaluator JSON/text, grader guidance text, failure-mode records, and the working document.
7. **Record actual runs.** Observed results need a run ID, exact versions, score scale, evidence location, and the modes actually observed. Planned modes are never reused as observed evidence.

The business prompt keeps the 40-word maximum; a project-level `exportPolicy` records an explicitly authorized 44-word exception.

## Private evidence modules

A bundled task audit (`kind: "bundled-task-audit"`) carries a task's extracted source records, the candidate and screening projects, the review text, and paired calculation rows. Keep such files under `private/` (ignored by git, never bundled by the build) as `private/evidence-module.js` or any `*-audit.js`, and load them with *Load private evidence module*; the saved script form (`window.X = {...};`) and plain JSON both load. The audit views render from the module's own projects and rows, so no task-specific text lives in the code. A saved workspace embeds the loaded module so the analysis round-trips locally. Task-specific module builders also live under `private/` (for example `private/scripts/build-evidence-module.py`, which reads a completed audit package named by environment variables and writes the module next to it); they are not part of the public tree.

## Illustrations are synthetic

The three illustrations (Atlas cash, Meridian lending, Carve-out) use invented names, figures, and library records to show a complete five-mode set, a build in progress, and an incomplete design. The candidate-engine illustrations use the same synthetic cases. Nothing in them is a task answer, a research finding, or an observed run.

## Data and export contract

- Project schema `finance-task-design` version 2; version 1 projects import with defaults. Each root carries lane, Mode ID, the record-contract fields, and the returned library record; the project carries task context, thesis, grader guidance, and the imported library. Unknown fields are discarded, unsafe keys rejected, calculator results recomputed.
- Library import accepts the endpoint shape `{activity, count, modes: [{mode_id, name, mechanism, grader_detection_guidance, status, uses, avg_task_score, usage_share, overused}]}` (up to 500 modes) or a previously saved normalized library; every returned record is kept.
- Solver export is an allowlist: the authored prompt, word count, prompt and workbook versions, and supplied filenames with versions. Evaluator export adds the failure-mode set, root records, source excerpts, guidance with lint, review findings, gates, runs, and calculator state. Official human-only FailureAnalysis, GraderAnalysis, and attestations are never generated.
- Generated text passes a deterministic cleanup (dashes, curly quotes, zero-width characters, repeated spaces); the working document keeps its indentation.
- Package schema `finance-task-package` version 1 and workspace schema `finance-analysis-workspace` version 2 are unchanged. Archive limits: 50 MB per file, 100 MB expanded, 1,500 entries, 150 documents, three nesting levels.

## Research and playbook provenance

The research catalog incorporates a primary-source review dated 2026-10-07: 20 source records, 14 mechanism hypotheses, and 16 acceptance gates; the ten playbook gates adapt the user-provided *Under-60 Playbook*. Complete JSON is in `research/`; `scripts/build-catalog.cjs` rebuilds the browser projection. "Verified" describes the review scope, not replication; every mechanism remains an untested design hypothesis, and no failure percentage is generated. Identity corrections are retained: GAUGE is 2607.24889v2; 2605.22664v5 is MBABench; FinVerBench defines twelve subtypes and instantiates eleven; CreditQA's paper/release count discrepancy stays unresolved.

## Developer checks

No package installation. With Node 22 or newer:

```sh
npm test                      # deterministic suites: core, candidates, package engine, harness, bundle
npm run test:browser          # task editor, headless Chromium
npm run test:dashboard        # package dashboard
npm run test:candidates       # candidate workflow
npm run build                 # catalog, Finance_Task_Studio.html, FILEBASE_MANIFEST.json
```

Headless suites need an existing Chromium (`CHROME_BIN=/path/to/chromium`); they use isolated temporary profiles and never attach to your browser. They write to `qa/<suite>/`; set `QA_OUTPUT` to change it. When a module exists under `private/`, the dashboard and candidate suites also exercise the private-module branch; set `PRIVATE_EVIDENCE=none` for the public configuration, or `PRIVATE_EVIDENCE=/path/to/module.js` to point at another module. For standalone QA, copy the HTML into an empty directory and set `APP_ENTRY` with `STANDALONE=1`. `tests/model-browser.cjs` is retained only as historical verification of the former connected companion.

Source map: `dashboard.js` package views and the private-module loader; `candidate-engine.js` source-linked hypotheses and the generic imported-audit mapping; `package-engine.js` local parsing and checks; `core.js` schema, library ranking, lint, cleanup, drafts, audit, and exports; `app.js` the task editor; `examples.js` synthetic illustrations; `backend/` the optional local companion; `scripts/` builds; `tests/` deterministic and headless checks; `VERIFICATION.md` the delivered validation scope.

## Boundaries

Structural checks and lint are not semantic verification, a difficulty score, or a grading decision. The app does not recalculate workbooks, authenticate run IDs, submit anything, or call a model. A qualified reviewer and a matched actual run are still required before any claim about a task's difficulty.
