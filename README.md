# Finance Task Studio

A workspace for building the **failure-mode set** of a derivative finance task: three historical modes from a failure-mode library plus two net-new modes from your own practice, each anchored to source evidence and recomputed economics, then carried into lint-checked grader guidance. It reads task packages (ZIP, XLSX, DOCX, CSV, text) in the browser, proposes source-linked candidate roots, and exports the solver draft, the private evaluator draft, the failure-mode records, and the persistent working document separately.

It comes in two editions:

| Edition | How you run it | Agents | Network |
|---|---|---|---|
| **Local agents** (primary) | `npm start`, or `Start Finance Task Studio.command` on macOS. A companion server listens on `127.0.0.1`. | Yes, after you approve each round. | The page talks only to its own companion on `127.0.0.1`. The agent runtime (the `claude` CLI) talks to Anthropic. |
| **Offline** | Open `Finance_Task_Studio.html` from disk. | No. The Agents page says so. | None. The page's content security policy is `connect-src 'none'`, and no model is called. |

Private task evidence never ships with the app. A bundled task audit is kept locally as a *private evidence module* (see below), loaded through a file picker, and ignored by git.

## What the agents do

The Agents page runs the loop used to harden a task by hand, on your machine, with Claude Code (`claude -p`):

- **Blind pilots.** Up to 5 agents per round solve the task from the solver files you approve and the prompt you write. Each runs in its own folder. No grader file, gold, fingerprint, evidence module, log, or earlier output is copied into that folder.
- **Audit.** Every tool call a pilot makes is checked. Any read or write to a path outside the pilot's folder marks the run `DISCARDED`: it stays on disk and visible, and is excluded from classification and export counts. The audit reads commands as text and does not run anything; see *What the audit cannot see* below.
- **Classification.** Answers are compared with a gold and with fingerprints of expected wrong answers that you freeze **before** launch. The app suggests a verdict by matching figures (with your tolerances) and tokens. That suggestion is a heuristic. The verdict you record is the one stored and exported.
- **Simulated grader.** A tool-less agent reads the guidance text and one answer and returns a verdict and a reason. It is a simulation and a single sample, not the evaluation's grading.
- **Author review.** A tool-less agent reads an extract of the task package loaded on Overview and writes one analysis.

## Safety model

- **Approval per round.** Nothing starts without an explicit approval click for that round. The approval dialog shows the model, effort, number of pilots, tool list, working folder, packet hash, and the isolation statement, and asks for three acknowledgements: shell access as you, network use by the agent runtime, and isolation by audit only. The simulated grader and the author review each ask for their own approval of a single run.
- **Cap of 5 pilots per round.** The cap is a constant in `backend/agents/constants.cjs` and is enforced on the server as well as in the page. A new round needs a new approval. Pilots run three at a time with a 50 minute limit each.
- **Gold frozen before launch.** The server refuses to launch a round without a freeze record (hash and timestamp). Edits after launch create a new version labelled post-hoc and never overwrite the original.
- **Shell access as you.** A pilot is a Claude Code agent with Bash, Read, Write, Edit, Glob, and Grep, running with your user permissions.
- **Isolation by instruction and audit, not by an operating system sandbox.** The pilot folder is created in the operating system's temporary directory (`finance-studio-pilots/<run id>`), outside the project. It holds only the approved solver files, an empty `outputs/`, and an empty `.tmp/` that is the agent's `TMPDIR`. Nothing at the operating system level stops a command from touching other files or the network. The audit finds path violations afterward and discards those runs. There is no allowance for harness paths and no setting that relaxes it. **Pilot folders are kept**: they hold copies of the packet files and the pilot's work, and they stay in the temporary directory until you delete them (the approval dialog says so). The companion checks that the folder holding them is a real directory that your account owns, makes it private (mode 0700) if it is open, and refuses a link. When a pilot finishes normally, anything it left running in its process group is stopped before the audit and the output snapshot, and a note says so.

### What the audit cannot see

The audit works on the text of the tool calls. It follows `cd`, variables the command sets, quoting, command substitution, here documents, `eval`, `bash -c`, `${IFS}` splitting and brace words, and it resolves symbolic links that exist. It does not execute anything, so these are **not** seen, and a run that used one can still be `CLEAN`:

- a path assembled while a command runs (a variable or command output the audit cannot see, a script that builds a path, encoded text passed to `eval` or a shell, a program started from a name built at run time);
- a directory change whose target cannot be resolved (`cd "$SOMEWHERE"`): later relative paths are then not checked, and only `..` paths are still flagged;
- anything done by a program the pilot started that the text of the call does not name.

Where the text shows that one of these happened, the run gets a **note** (`cwd-unresolved`, `unverifiable-command`, `unverifiable-code`, `unverifiable-input`). A note never discards a run. Read the notes in the run details. The audit is told the environment the pilot received, so a path held in an inherited variable (for example one that `npm start` sets) is checked when a command uses that variable by name. The environment is still passed on whole, as the design says. `npm start` adds variables that name the project folder (`INIT_CWD`, `npm_config_local_prefix`, and others), and your shell may export `OLDPWD`; if you do not want a pilot to be able to read them, start the companion with `node backend/server.cjs --open` from a shell where they are unset. `cd -` is only trusted after a `cd` in the same command, because its target is otherwise whatever the shell inherited. The work per call is capped and timed; a call that exceeds a cap fails closed and discards the run.
- **The agent runtime talks to Anthropic; the page talks only to localhost.** The solver files and prompt you approve are sent to Anthropic by the `claude` program, as are the guidance text and one answer for a simulated grader, and an extract of the loaded package text for an author review. The page itself makes requests only to `127.0.0.1`.
- **Nothing starts on launch.** Starting the companion, with `npm start` or the launcher, never starts a model. The launcher only asks `claude --version`.
- **No workarounds.** If `claude` cannot start (not found, not signed in, blocked by a permission policy), the run is marked `failed` with the real error text. Run the command from your own terminal instead.
- **Directional results only.** With fewer than 20 runs every count is shown as "directional only, n = k". The app computes no pass rate, no difficulty score, and no works/fails label.

## Quick start

Requires Node 22 or newer and the `claude` CLI, installed and signed in (run `claude` once in a terminal). There is nothing to install with npm.

```sh
npm start
```

This runs `node backend/server.cjs --open`. The companion binds to `127.0.0.1` on a free port (set `FINANCE_STUDIO_PORT` to choose one), prints its address, writes `LOCAL_SERVER.json` (ignored by git), and asks the system to open the page (`open` on macOS; elsewhere use the printed address). Open the **Agents** view in the sidebar.

To use a specific `claude` binary: `CLAUDE_BIN=/path/to/claude npm start`. Detection order is `CLAUDE_BIN`, then `claude` on `PATH`, then `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, `~/.claude/local/claude`, and `~/.local/bin/claude`. Detection runs `claude --version` with a 5 second limit and nothing else.

On macOS you can double-click **Start Finance Task Studio.command** instead. It looks for Node in `/opt/homebrew/bin`, `/usr/local/bin`, and on `PATH` (the runtime bundled with the archived harness app is the last candidate), prints the Node version and whether `claude` was found, then starts the same server.

## Open it

- **Finance_Task_Studio.html** is the single-file Offline edition: download it and open it in a current desktop browser. No installation, account, server, or internet connection is needed. It never runs agents.
- **index.html** is the source-folder edition for development; keep every file beside it. Served by the companion, its Agents page can run agents; opened from disk it behaves like the Offline edition.
- **Start Finance Task Studio.command** (macOS) starts the companion as described above.

## The Agents page

Five cards, top to bottom. Launch stays disabled until the earlier steps are done.

1. **Runtime.** Whether Claude Code was found, its version and path, and a *Check again* button.
2. **Packet.** Enter the folder that holds the solver files and press *Inspect*. Pilots see the ticked files under `./filesystem/` with their folder structure kept, so choose the folder that is the production `filesystem` folder itself (the page warns when the folder you chose already contains one). Regular files only (no symlinks, depth up to 4, up to 150 files, up to 100 MB; a file name with a control character is listed but cannot be used). Files whose names look like grading material (answer, golden, gold, grader, evaluator, rubric, reference solution, fingerprint, attestation, private) are excluded by default; including one needs an explicit per-file override, which is recorded in the round. Folders inside the project or under `private/` are refused. Write the pilot prompt in the box (word count shown against the project limit). The `gaf/` toggle (off by default) records whether that folder is part of what the solver sees; it matches production only if the production solver sees it. A file counts as a gaf file when `gaf` is a whole word in its path (`gaf/x.csv`, `gaf-hedge.csv`, `GAF_notes.txt`); the page and the companion use the same rule. The choice is shown in the approval dialog and recorded in the round and in every exported record.
3. **Freeze.** Enter the gold decision phrase, the gold figures with tolerances, and the fingerprints of expected wrong answers (id, label, tokens or figures). *Freeze gold* shows the hash and timestamp.
4. **Round.** Choose model, effort, and the number of pilots (1 to 5). The shell-access and isolation statements are printed here. *Review and approve* opens the approval dialog, which shows the prompt and its hash, the files delivered and the files withheld, the command line with the prompt elided, and the exact text that the approval hash covers. *Approve and launch* stays disabled until all three acknowledgements are ticked. If the launch is refused after the approval (another round is running, or Claude Code is missing), the round stays approved and the same dialog launches it once the cause is gone. *Review and approve* is disabled while Claude Code is not found.
5. **Runs.** One row per pilot with state, turns, tool calls, resolved model, audit badge, and elapsed time. *Details* opens the final answer, outputs, and any violations with the offending call. A failed run explains itself: the reason in words, the runtime's own message, and the command (prompt elided) to run from your terminal. Classify each `CLEAN` run (suggested verdict, your verdict, fingerprint chips, note). The chips include fingerprints that a post-hoc freeze added. Under the table: *Simulated grader*, *Author review*, and **Export**, which adds run-evidence records to the project's experiments (after a confirmation) or downloads the round JSON. `DISCARDED` runs are exported only in a separate list.

## Workflow

1. **Load the task package.** Drop the task ZIP or source files on Overview. Files are inventoried and extracted locally (formulas with saved values; PDFs stay unparsed). *Run local checks* reports saved formula errors, missing caches, hidden sheets, version clues, and prompt-wording cues, all labeled structural or heuristic.
2. **Generate candidate roots.** Three source-linked hypotheses are ranked by evidence, arithmetic, and causal independence. Same-root duplicates and non-binding variants are rejected; a candidate without a source-resolved answer is held. Ranking is not a difficulty prediction.
3. **Lock the set (Failure modes page).** Enter the task context from the task pull. Import the saved JSON of the failure-mode library pull; the app never calls the endpoint and the shared task key never enters it. The shortlist is deterministic: approved, uses above zero, numeric average score; lowest average first, then most uses, then not overused, then lowest usage share, then Mode ID. Exactly ten are shown; fewer is reported, never padded. Select exactly three by Mode ID. Add exactly two net-new modes from work you did or reviewed, or promote a candidate root with *Add as net-new mode*; record the duplicate check against the shortlist for each. Write the thesis that ties the five together.
4. **Instantiate each mode (Root design).** Complete the record contract: triggering condition, plausible wrong approach, detection method, corrective action, expected model behavior (solve, reconcile, push back), classification (strict error or judgment-call divergence), governing rule, facts, anchors, acceptable variations, and tolerance rationale. *Scaffold blanks from mechanism* fills empty fields from the research catalog, marked as hypotheses the audit keeps flagging until edited. One causal group per root: several changed outputs are one failure.
5. **Recompute both branches (Economics).** Enter correct and wrong outputs with units, tolerances, and an optional decision threshold. The helpers (cash bridge, whole-cent ceiling, record-date dividend capacity, affine fixed point) show their equation and limits.
6. **Draft, lint, export (Review and export).** *Draft from failure modes* writes deterministic grader guidance from the records; rewrite it in your own words. The lint flags what gets guidance returned (see *Lint limits* below). Blockers are exact tokens; the rest are labeled heuristics. Exports: solver JSON/text (prompt and file manifest only), evaluator JSON/text, grader guidance text, failure-mode records, and the working document.
7. **Test the design (Agents page, Local agents edition).** Run a blind pilot round on the exact solver package, classify the answers against the frozen gold, and add the evidence to the project's experiments.
8. **Record actual runs.** Observed results need a run ID, exact versions, score scale, evidence location, and the modes actually observed. Planned modes are never reused as observed evidence.

## Lint limits

The lint follows the format that actually ships, not a stricter one.

- **Business prompt: 60 words.** The 44-word `exportPolicy` exception from earlier projects still imports and validates as before, but never lowers the limit: the effective limit is the larger of 60 and the policy value. The draft generator still writes prompts of 40 words or fewer; a writer may keep to 40.
- **Grader guidance: review above 650 words; blocker at 800 or more.**
- **Titled sections.** The five block headings are accepted (exact match, with or without the leading number and period): `Context`, `Golden Response`, `1. Must-haves`, `2. Common Failures`, `3. Acceptable Variation`. Any other titled section, markdown heading, or bold title is still flagged.
- **Scoring words.** `You are grading` and `You are grading a` are not flagged. Every other use of `grading`, `score`, `scoring`, and `points` keeps its behavior, and the scoring-language blockers (for example `penalise`, `partial credit`, `weighting`) are unchanged.
- **Internal jargon.** The built-in list is generic and names no platform or company. A private evidence module may carry a `lintTerms` array of strings; when such a module is loaded, the editor passes those terms to the lint as extra case-insensitive jargon terms, so platform-specific terms stay on your machine.
- Unchanged: the cell-reference check, the dash and unicode check, the check for mentions of models or prompts, and the vague-failure heuristic.

## Private evidence modules

A bundled task audit (`kind: "bundled-task-audit"`) carries a task's extracted source records, the candidate and screening projects, the review text, and paired calculation rows. Keep such files under `private/` (ignored by git, never bundled by the build) as `private/evidence-module.js` or any `*-audit.js`, and load them with *Load private evidence module*; the saved script form (`window.X = {...};`) and plain JSON both load. The audit views render from the module's own projects and rows, so no task-specific text lives in the code. A saved workspace embeds the loaded module so the analysis round-trips locally. Task-specific module builders also live under `private/` (for example `private/scripts/build-evidence-module.py`, which reads a completed audit package named by environment variables and writes the module next to it); they are not part of the public tree. An evidence module is never copied into a pilot folder. The optional `lintTerms` array is described under *Lint limits*.

## Privacy

- **`private/` is git ignored.** It holds evidence modules, their builders, and every agent round: `private/agent-rounds/<round id>/` has `round.json`, `freeze.json`, `packet.sha256`, and for each pilot `runs/<n>/` with `transcript.jsonl`, `stderr.txt`, `run.json`, and `outputs/`. Transcripts are written as they arrive and never edited. The agent features write only to `private/agent-rounds/`, the pilot folders in the temporary directory (kept until you delete them), and `LOCAL_SERVER.json` at the project root (ignored by git), plus the files your browser downloads when you ask it to. They read the packet folder you choose, and the `claude` program reads its own configuration. The round JSON that the page downloads (`Finance_Agent_Round_<id>_PRIVATE.json`) holds the frozen gold and the prompt: keep it outside the repository. `*_PRIVATE.*` is ignored by git as a safety net.
- **The public tree carries no task content.** Code, tests, fixtures, comments, and docs use synthetic data only.
- **Privacy scan.** `scripts/privacy-scan.cjs`, run with `npm run privacy`, is generic: the term list is not in the repository. It reads one term per line from `private/privacy-terms.txt` (lines starting with `#` are ignored; a term written as `/.../i` is a regular expression; anything else is a case-insensitive literal). It scans every tracked file and every untracked file that git does not ignore. Text files are scanned; binary files are counted, listed by name, and skipped. `--range <base>..<head>` also scans the added lines of the commits about to be pushed, and `--terms <file>` uses another list. It prints `file:line` and the number of the matching term, never the line itself, and exits 1 on any hit.
- **It fails closed.** If the term list is missing or empty, it exits non-zero with `no privacy term list: refusing to pass`.
- **Block pushes locally.** A `pre-push` hook is recommended. Hooks are not versioned, so install it in each clone, from the top of the work tree:

  ```sh
  printf '#!/bin/sh\nexec node scripts/pre-push.cjs "$@"\n' > .git/hooks/pre-push && chmod +x .git/hooks/pre-push
  ```

  `scripts/pre-push.cjs` reads the refs that git is about to push and runs the scan with `--range` over exactly the commits the push would publish (`<remote sha>..<local sha>`; for a new branch, from its first commit that is not on the remote). A term that one commit adds and the next removes is therefore still caught, which a scan of the work tree alone would miss. It scans the work tree as well, ignores deletions, and blocks the push on any hit and on any failure to scan. Push to a named remote (`git push origin ...`) so the hook knows which remote's history to leave out. Set `FINANCE_PRIVACY_TERMS=/path/to/terms.txt` to use another term list; the default is `private/privacy-terms.txt`. Without the hook, run `npm run privacy -- --range <remote>/main..HEAD` before every push.
- **A test for the whole tree.** `FINANCE_PRIVACY_TERMS=private/privacy-terms.txt npm test` also runs the scan over every tracked and untracked file as part of `tests/core.test.cjs`. The list is never in the repository, and the test is skipped without the variable.

## Illustrations are synthetic

The three illustrations (Atlas cash, Meridian lending, Carve-out) use invented names, figures, and library records to show a complete five-mode set, a build in progress, and an incomplete design. The candidate-engine illustrations use the same synthetic cases. Nothing in them is a task answer, a research finding, or an observed run.

## Data and export contract

- Project schema `finance-task-design` version 2; version 1 projects import with defaults. Each root carries lane, Mode ID, the record-contract fields, and the returned library record; the project carries task context, thesis, grader guidance, and the imported library. Unknown fields are discarded, unsafe keys rejected, calculator results recomputed.
- Library import accepts the endpoint shape `{activity, count, modes: [{mode_id, name, mechanism, grader_detection_guidance, status, uses, avg_task_score, usage_share, overused}]}` (up to 500 modes) or a previously saved normalized library; every returned record is kept.
- Solver export is an allowlist: the authored prompt, word count, prompt and workbook versions, and supplied filenames with versions. Evaluator export adds the failure-mode set, root records, source excerpts, guidance with lint, review findings, gates, runs, and calculator state. Official human-only analysis fields and attestations are never generated.
- Agent round export (Agents page) produces run-evidence records of kind `local-blind-pilot` that pass the project's experiment validation: resolved model, audit status, the root failures the writer recorded, the evidence location under `private/agent-rounds/`, and a note stating "directional", the number of runs, whether `gaf/` was visible, and the freeze hash. They carry no score.
- Generated text passes a deterministic cleanup (dashes, curly quotes, zero-width characters, repeated spaces); the working document keeps its indentation.
- Package schema `finance-task-package` version 1 and workspace schema `finance-analysis-workspace` version 2 are unchanged. Archive limits: 50 MB per file, 100 MB expanded, 1,500 entries, 150 documents, three nesting levels.

## Research and playbook provenance

The research catalog incorporates a primary-source review dated 2026-10-07: 20 source records, 14 mechanism hypotheses, and 16 acceptance gates; the ten playbook gates adapt a user-provided playbook. Complete JSON is in `research/`; `scripts/build-catalog.cjs` rebuilds the browser projection. "Verified" describes the review scope, not replication; every mechanism remains an untested design hypothesis, and no failure percentage is generated. Identity corrections are retained: GAUGE is 2607.24889v2; 2605.22664v5 is MBABench; FinVerBench defines twelve subtypes and instantiates eleven; CreditQA's paper/release count discrepancy stays unresolved.

## Developer checks

No package installation. With Node 22 or newer:

```sh
npm test                      # deterministic suites: core, candidates, package engine, harness, bundle, agents (audit, folder, runner, hardening, classify, server, page), privacy scan, pre-push hook, repository hygiene
npm run test:browser          # task editor, headless Chromium
npm run test:dashboard        # package dashboard
npm run test:candidates       # candidate workflow
npm run test:agents           # Agents page end to end against the stub, headless Chromium (not part of npm test)
npm run privacy               # privacy scan; needs private/privacy-terms.txt
npm run build                 # catalog, Finance_Task_Studio.html, FILEBASE_MANIFEST.json
```

The agents suites make no model call and no network request. They use `backend/agents/stub-claude.cjs`, a test double that writes the event stream the real CLI would, or injected fakes. New test files:

- `tests/agents-audit.test.cjs`: every violation kind and every must-not-flag case of the path audit, including the tracked working directory, symlink escape, `.tmp/` clean, and discarded runs.
- `tests/agents-folder.test.cjs`: pilot folder build (byte-identical copies, refused paths and names, recorded overrides, `.tmp/`, detection of a modified input).
- `tests/agents-runner.test.cjs`: exact argument list, stream parsing, completed/failed/cancelled states, timeout kill, model mismatch note, concurrency, the cap of 5, packet hash mismatch, approval hash, freeze required, the simulated grader and the author review.
- `tests/agents-hardening.test.cjs`: the places where a change would leave the other suites green: the audit runs on each pilot's own folder, every field of the approval summary is bound, process groups are stopped, state survives a restart, counts and exports agree, the pilots root is checked.
- `tests/agents-page.test.cjs`: the real `agents.js` in a fake document against a real companion backed by the stub (a refused launch after approval, post-hoc fingerprints, failed-run explanations, the approval dialog contents), and the edition-dependent copy of the other pages.
- `tests/agents-classify.test.cjs`: tolerance matching, the all-tokens fingerprint rule, `unclear`, never final.
- `tests/agents-server.test.cjs`: ephemeral port; host, origin, nonce, content type, body cap, id validation, path rules, nothing runs without approval, status shape, export shape.
- `tests/agents-browser.cjs`: the Agents page flow in headless Chromium against the companion with the stub (run from a temporary copy, so `private/` is not touched), desktop and mobile screenshots in `qa/agents/`, zero console errors, requests only to `127.0.0.1`.
- `tests/bundle.test.cjs` also checks that the standalone page embeds `agents.js` byte for byte and carries no private module.
- The privacy scan has its own test, which uses a synthetic term list and never reads `private/`. `tests/pre-push.test.cjs` runs the push hook against throwaway repositories with a real push, and `tests/repo-hygiene.test.cjs` checks what `.gitignore` covers.

Headless suites need an existing Chromium (`CHROME_BIN=/path/to/chromium`); they use isolated temporary profiles and never attach to your browser. They write to `qa/<suite>/`; set `QA_OUTPUT` to change it. When a module exists under `private/`, the dashboard and candidate suites also exercise the private-module branch; set `PRIVATE_EVIDENCE=none` for the public configuration, or `PRIVATE_EVIDENCE=/path/to/module.js` to point at another module. For standalone QA, copy the HTML into an empty directory and set `APP_ENTRY` with `STANDALONE=1`. `tests/model-browser.cjs` is retained only as historical verification of the former connected companion.

Source map: `dashboard.js` package views and the private-module loader; `agents.js` the Agents page; `candidate-engine.js` source-linked hypotheses and the generic imported-audit mapping; `package-engine.js` local parsing and checks; `core.js` schema, library ranking, lint, cleanup, drafts, audit, and exports; `app.js` the task editor; `examples.js` synthetic illustrations; `backend/server.cjs` the local companion (static assets and the `/api/agents` routes); `backend/agents/` the agent runtime (limits, `claude` runner, pilot folders, path audit, classification, rounds); `backend/harness.cjs` the archived one-run adapter, unchanged and not used by the Agents page; `scripts/` builds and the privacy scan; `tests/` deterministic and headless checks; `docs/local-agents.md` the design and API contract for the local agents edition; `VERIFICATION.md` the delivered validation scope.

## Boundaries

Structural checks and lint are not semantic verification, a difficulty score, or a grading decision. Pilot results are directional: a few runs of one model cannot establish how hard a task is, and a simulated grader is not the evaluation's grading. The app does not recalculate workbooks, authenticate run IDs, or submit anything. The Offline edition calls no model. The Local agents edition calls a model only through the `claude` CLI, and only after an approval for that round or that single run. A qualified reviewer and a matched actual run are still required before any claim about a task's difficulty.
