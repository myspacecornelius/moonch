# Verification — 2026-10-10

Delivered application version: 3.0.0 (local agents edition). Verification is engineering QA, not a task difficulty claim. This pass ran in a Linux container with Node v22.22.0 and an isolated headless Chromium (version recorded in each `qa/*/browser-report.json`).

**No model was called and no network request was made during this verification.** Every agent run below used `backend/agents/stub-claude.cjs`, a test double that prints the event stream the real CLI would, or an injected fake. The real `claude` program was only asked for `--version`, and only where a test targets detection. **Live pilots are untested in this build**: the agent runtime has not been run against the live CLI, so the first approved round on a real installation is the remaining check.

## What was run

- **Syntax**: `node --check` on all 44 `.js` and `.cjs` files that git does not ignore. All pass.
- **Deterministic suite**: `npm test` in the public configuration (`PRIVATE_EVIDENCE=none`), log in `qa/unit-tests.txt`. **416 tests: 414 pass, 0 fail, 2 skipped.** The two skips are one test that needs a locally kept private evidence module, and one opt-in whole-tree privacy test that needs a term list supplied in `FINANCE_PRIVACY_TERMS`. Each file, run on its own:

  | File | Tests | Notes |
  |---|---|---|
  | `agents-audit` | 52 | |
  | `agents-classify` | 23 | |
  | `agents-folder` | 35 | |
  | `agents-hardening` | 27 | |
  | `agents-page` | 13 | |
  | `agents-runner` | 68 | |
  | `agents-server` | 50 | |
  | `bundle` | 3 | |
  | `candidates` | 14 | 13 pass, 1 skipped |
  | `core` | 61 | 60 pass, 1 skipped |
  | `harness` | 6 | |
  | `package-engine` | 11 | |
  | `pre-push` | 6 | |
  | `privacy-scan` | 45 | |
  | `repo-hygiene` | 2 | |

- **Build**: `npm run build` (20 research sources, 14 mechanisms and 16 review gates; `Finance_Task_Studio.html` about 400 KB; `FILEBASE_MANIFEST.json` listing 124 files, regenerated last).
- **Headless browser suites**, each exit code 0 with zero console errors and no application network request (`CHROME_BIN` set, `PRIVATE_EVIDENCE=none`):
  - Task editor, 33 checks (`qa/legacy/browser-report.json`).
  - Package dashboard, 15 checks (`qa/dashboard/browser-report.json`).
  - Candidate workflow, 12 checks (`qa/candidates/browser-report.json`).
  - Agents page, 21 checks (`qa/agents/browser-report.json`, retained screenshots `qa/agents/desktop-agents.png` and `mobile-agents.png`).
  - Standalone edition: `Finance_Task_Studio.html` copied alone into an empty directory, 34 task editor checks and 16 dashboard checks (`qa/standalone-legacy`, `qa/standalone-dashboard`), loading only its own file.
- **Companion by hand**: the real server started from a scratch copy of the files, with the stub as the runtime and a synthetic packet, driven over loopback with a short script (28 steps, all passed). It showed the status shape (runtime found, cap of 5, four models, five efforts, a nonce); a wrong Host, a missing nonce and a foreign Origin each answered 403 (also for a GET); a wrong content type 415; a bad id 400; the project folder refused as a packet folder; a changed tool list and a sixth pilot each refused with 400; a client-supplied binary, argument list, folder and environment ignored; and launch and approval each refused before the freeze. After the freeze, a launch without approval, a wrong approval hash and an approval missing an acknowledgement were refused. Approving started nothing. The launch then recorded exactly one prompt run whose argument list matches the contract, and the pilot finished `completed` with audit `CLEAN`. `LOCAL_SERVER.json` recorded `modelCallsOnLaunch: 0` and SIGTERM stopped the server with exit code 0.
- **Privacy and scrub**: `npm run privacy` over the work tree (67 files scanned, 9 binary files skipped, 0 hits) and a case-insensitive search of every non-ignored file for the names of the evaluation platform and its contractor (no match). The retained screenshots were looked at by eye and show invented data only. Nothing under `private/` is tracked.

## What the browser suites cover

- **Task editor**: all nine views at desktop and mobile widths with no horizontal overflow; the synthetic worked example with its five modes; the ten-mode shortlist; library JSON import; mechanism scaffolds; the 60-word solver limit (a 61-word prompt is blocked); review resets after record edits; calculator recording; the guidance draft with zero lint blockers and live blockers on scoring language, jargon and dashes; real downloads of every export with audience separation; invalid import rejection; the actual-run form with a labeled QA fixture.
- **Package dashboard**: opens with nothing loaded; real ZIP extraction; deterministic local checks labeled heuristic; file inventory; run history; workspace round trip; invalid ZIP rejection; the bridge into the editor. With a private module present the same suite runs additional checks whose report stays local under `private/qa/`, not committed.
- **Candidate workflow**: synthetic cash and lending cases, private review pack and assistant request, solver downloads with audience separation, rejected candidates cannot export, candidates open as projects and join the failure-mode set.
- **Agents page**: the file edition shows only the offline message with no controls and no request. Against the real companion with the stub: runtime detection, packet inspection with a hostile file name rendered as text, evaluator-looking files off by default and overrides labelled, the `gaf/` toggle, the pilot stepper capped at 5, launch disabled until frozen, a freeze marked stale when the prompt changes, an approval dialog needing three acknowledgements and showing the command line with the prompt elided, two pilots finishing CLEAN with "Directional only, n = 2", the heuristic suggestion copied into the verdict controls, verdicts saved and listed, the simulated grader and the author review each behind their own approval, export into the project's experiments, the round JSON download, and a second companion run in which a pilot reads outside its folder and is kept as DISCARDED, explained, not classifiable and not exported. Every request went to `127.0.0.1`. The suite runs the companion from a temporary copy of the files it serves, so the project's own `private/` folder is neither read nor written.

## What the stub-based agent tests do and do not prove

They prove that the companion, the runner, the pilot folders, the audit, the classifier and the Agents page behave as the contract in `docs/local-agents.md` says when the runtime prints the event stream the stub prints: the argument list is exactly the fixed one, nothing starts before the freeze and the approval, the cap of 5 is enforced on the server, packet hashes are re-checked at launch, a pilot gets only the approved files, and a recorded tool call that reads or writes outside the pilot folder discards the run.

They do **not** prove anything about the live CLI or a live model:

- No test called a model, so no claim is made about how a pilot behaves, what it answers, or how often it would reach a given answer.
- The stream parser and the audit were written against the documented event shapes and the stub. Whether the live stream puts file-tool paths and shell commands in the fields the audit reads is unconfirmed until a first approved round runs on a real installation.
- Stub scenarios are scripted: a tool call that the audit flags was put there by the test author, not chosen by an agent.
- Sign-in, permission policy refusals and real timeouts of the live CLI were not exercised; the failure paths were tested with a process that cannot be started, a non-zero exit, a missing result, a timeout and a missing runtime, all produced by the stub or by injected fakes.

## Privacy restructure

The repository is public, so task evidence stays out of the tree. The bundled task audit and the model-run receipt live under `private/` (ignored by git) and load through *Load private evidence module*; every agent round is stored under `private/agent-rounds/`. Illustrations, tests and fixtures use invented data. The research catalog and lint rules name neither the evaluation platform nor its contractor; text that mirrored the evaluation platform's own guidance is kept in `private/research-originals/`. Organisations and sources that the research itself cites (for example the publishers of the papers) are named, because they are part of the cited facts. Git history from earlier commits still contains the older text, including text already pushed; rewriting history is a separate decision for the repository owner. `scripts/privacy-scan.cjs` fails closed when that list is missing and reports any term from the local, untracked list that it finds in the work tree or, with `--range`, in the commits being pushed. It blocks a push only through the `pre-push` hook described in the README (`scripts/pre-push.cjs`), which runs it over exactly the commits the push publishes, so a term added in one commit and removed in the next is caught; a hook that scans only the work tree would miss that. Hooks are not versioned, so each clone installs its own; `tests/pre-push.test.cjs` shows a real push being refused.

## Boundaries

- Structural checks, lint, and the shortlist ranking are deterministic; wording cues are explicitly heuristic. None of them judges financial semantics or predicts a score.
- **Isolation is by instruction and audit, not by an operating system sandbox.** A pilot is a Claude Code agent with shell access running as the writer. The audit reads recorded tool calls as text and **can be evaded by shell constructs** it does not model: paths assembled at run time inside a script, shell functions and aliases, encoded text passed to a shell or `eval`, a directory change whose target cannot be resolved, and words that are entirely dynamic. It is a heuristic. Where the text shows such a gap it adds a note (`cwd-unresolved`, `unverifiable-command`, `unverifiable-code`, `unverifiable-input`), which never discards a run. Its work per call is capped and timed, and a call that exceeds a cap fails closed. Pilot folders are kept in the temporary directory until the writer deletes them. A pilot can still touch the network and other files. The approval dialog says so and asks for an acknowledgement.
- Pilots run in their own process group. SIGINT and SIGTERM to the companion cancel them; a SIGKILL of the companion does not. A process the pilot leaves running in that group when it finishes normally is stopped before the audit and the output snapshot; one that moved itself into another session is out of reach. The group stop and the pilots-root ownership checks are skipped on Windows.
- Pilot results are directional. No pass rate, difficulty score or works/fails label is computed. A simulated grader is one sample of a model reading the guidance, not the evaluation's grading. The classification suggestion is a keyword and number match; the writer's verdict is what is stored.
- The suggestion reads text-like outputs only; spreadsheets and other binaries are not searched.
- On a page reload the Agents page shows only server-side configuration for earlier rounds; the gold and fingerprint form is not refilled from the freeze.
- XLSX extraction reads formulas and saved values; it does not recalculate. DOCX anchors are paragraph and table indices; PDF text is not extracted.
- The guidance draft is a template over the author's records; it must be rewritten in the author's own words before use.
- The synthetic illustrations, library records, and QA fixtures are invented. No task answer, research finding, or observed run is represented.
- `Start Finance Task Studio.command` was not run in this verification (macOS launcher; no zsh in this container). `npm start` is the equivalent.
