# Local agents: design and contract

Status: design for Finance Task Studio 3.0. This file is the contract the implementation and its tests follow.

## 1. Why

Studio 2.x was an offline authoring workspace. It could not test a design. Testing a design means running a blind solver on the exact package a writer plans to ship, and reading what it does. The workflow that works is the one used to harden tasks by hand: build a frozen solver packet, run a few blind Claude Code agents on it, audit every tool call, and classify the answers against a gold and fingerprints written **before** any output was seen.

3.0 moves that loop into the app. The Studio, when served by the local companion, starts Claude Code agents (`claude -p`) on the writer's machine.

Two editions remain:

| Edition | How it runs | Agents |
|---|---|---|
| **Local agents** (primary) | `npm start`, or `Start Finance Task Studio.command`. Companion on `127.0.0.1`. | Yes |
| **Offline** | `Finance_Task_Studio.html` opened from disk. CSP `connect-src 'none'`. | No. The Agents page says so. |

The page never talks to anything except its own companion. The **agent runtime** (the `claude` CLI) makes network calls to Anthropic. That is disclosed in the approval dialog and the README.

## 2. Non-negotiables

1. **Nothing starts without an explicit approval click** for that round. The approval dialog shows model, effort, number of pilots, tool list, working folder, packet hash and the isolation statement. Starting the companion never starts a model.
2. **At most 5 pilots per round.** The cap is a constant in `backend/agents/constants.cjs` and is enforced on the server, not only in the UI. A new round needs a new approval.
3. **Gold is frozen before launch.** The server refuses to launch a pilot round without a freeze record (hash and timestamp). Edits after launch create a new freeze version labelled post-hoc and never overwrite the original.
4. **Blind means blind.** Each pilot runs in its own folder outside the project root (`<os tmpdir>/finance-studio-pilots/<runId>/`). The folder holds only the approved solver files, an empty `outputs/` and an empty `.tmp/` that is the agent's `TMPDIR`. No grader file, gold, fingerprint, evidence module, log or earlier output is ever copied in. The runner refuses to build a folder if a selected file is under `private/`, or its name matches the evaluator patterns, unless the writer overrides that file by name in the UI (recorded in the round).
5. **Every tool call is audited, strictly.** Any read or write to a path outside the pilot folder (the folder includes its own `.tmp/`) marks the run `DISCARDED`. It is kept on disk, shown in the UI, and excluded from classification and export counts. There is no allowance for harness owned paths and no toggle that weakens this. See section 6.
6. **Isolation is by instruction and audit, not by an operating system sandbox.** The UI says this in plain words at approval time. A pilot is a Claude Code agent with shell access running as the writer. The server must not claim otherwise anywhere.
7. **Results are directional.** With fewer than 20 runs the UI shows "directional only, n = k" next to every count. No pass rate, difficulty score, or "works / fails" label is generated. This matches `README.md` and `VERIFICATION.md`.
8. **Private task content stays local.** Round state lives in `private/agent-rounds/` (git ignored). Nothing task specific is hard coded in code, tests or docs. Fixtures are synthetic.
9. **The browser never supplies a command, a binary path or an argument list.** It supplies a folder path to read from, file names to include, text, and choices from allowlists. The server builds every argument.
10. **Denials are not worked around.** If `claude` refuses to start (not found, not signed in, permission policy), the run is `failed` with the real stderr tail. The UI tells the writer to run it from their own terminal and offers the exact command.

## 3. Runtime: Claude Code CLI

### 3.1 Detection

`detectClaude({env, exists, execFile})` returns `{found, path, version, source}`:

1. `CLAUDE_BIN` if set and executable.
2. `claude` on `PATH`.
3. Known locations: `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, `~/.claude/local/claude`, `~/.local/bin/claude`.

It runs `claude --version` with a 5 second timeout. It never runs a model.

### 3.2 Argument list (fixed, built by the server)

```
claude -p <prompt-text>
  --model <allowlisted id> --effort <allowlisted level>
  --output-format stream-json --verbose
  --tools "Bash,Read,Write,Edit,Glob,Grep" --allowedTools "Bash,Read,Write,Edit,Glob,Grep"
  --permission-mode acceptEdits
  --disable-slash-commands --strict-mcp-config --setting-sources ""
  --no-session-persistence
```

- `cwd` is the pilot folder. `stdin` is closed. Timeout 50 minutes (`timeout` semantics: SIGTERM, then SIGKILL after 5 s).
- Environment: the parent environment plus `TMPDIR=<folder>/.tmp` and `CLAUDE_CODE_TMPDIR=<folder>/.tmp`, so the agent's scratch space and temporary files are inside the folder. Nothing else is added or removed. No API key is read, logged or forwarded explicitly. The pilot's own configuration directory is the user's normal one (needed for sign-in); the strict audit still treats any agent access to it as a violation.
- Prompt text for a pilot: `The task materials are in ./filesystem. Save any files you produce to ./outputs. When you finish, give your answer in your final message.\n\n` followed by the writer's prompt.
- Allowlists: models `claude-opus-5-5` (default), `claude-sonnet-5-5`, `claude-fable-5-1`, `claude-haiku-5-5`; efforts `low`, `medium` (default), `high`, `xhigh`, `max`.
- Other agent kinds use the same runner with `tools: []` (`--tools ""`), no folder content, and a prompt built by the server:
  - `grader-sim`: a **simulated** grader. Input is the guideline text and one answer. It returns JSON with `verdict`, `reason`. Always labelled "simulated grader, not Studio grading".
  - `author-review`: one analysis of the loaded package (replaces the archived DeepSeek run, which stays in the tree, unlinked and unchanged).

### 3.3 Stream parsing

`claude-runner.cjs` parses newline-delimited JSON. It records:

- the `system/init` event: resolved `model`, `tools`, `skills`, `mcp_servers`;
- every assistant `tool_use` block (name and input) for the audit;
- `tool_result` text only for the leak check (not stored in the summary);
- the final `result` event: `result` text, `num_turns`, `total_cost_usd`, `terminal_reason`, `is_error`, `modelUsage` keys;
- a stderr tail (last 4 KB).

A run is `completed` only if exit code is 0 **and** there is a `result` event with non-empty text. Otherwise `failed`. A cancelled run is `cancelled`. Requested versus resolved model is reported separately; a mismatch is an audit note (`model-mismatch`), never silently corrected.

## 4. Data model (all JSON, schema `finance-agent-round` version 1)

```
Round {
  id: "rnd-<12 hex>", createdAt, label,
  packet: { sourceDir, files:[{path, sha256, bytes, role, include, overridden}], promptText, promptSha256, packetSha256, gafVisible:boolean },
  freeze: null | { version:1, frozenAt, sha256, gold:{ decision, figures:[{label, value, tolerance}] , notes }, fingerprints:[{ id, label, tokens:[string], figures:[{label,value,tolerance}] }], postHoc:false },
  config: { kind:"pilot", model, effort, count:1..5, tools:[...] },
  approval: null | { approvedAt, summarySha256, acknowledgements:["shell-access","network","isolation-by-audit"] },
  runs: [ Run ],
  status: "draft"|"frozen"|"approved"|"running"|"finished"|"cancelled"|"failed"
}
Run {
  id: "<roundId>-<n>", n, folder, state:"queued"|"running"|"completed"|"failed"|"cancelled",
  startedAt, endedAt, exitCode, requestedModel, requestedEffort, resolvedModel,
  numTurns, costUsd, terminalReason, stderrTail,
  toolCalls:{total,bash,file},
  audit:{ status:"CLEAN"|"DISCARDED", violations:[{tool,kind,path,call}], inputsModified:[string], notes:[string] },
  final:{ text, chars }, outputs:[{name,bytes,sha256}],
  classification: null | { suggested:{verdict,matches,fingerprints}, human:{verdict, fingerprintIds:[string], note, at} }
}
```

Persisted files per round under `private/agent-rounds/<roundId>/`: `round.json`, `freeze.json`, `packet.sha256`, and per run `runs/<n>/{transcript.jsonl, stderr.txt, run.json, outputs/}`. Transcripts are written as they arrive and never edited.

## 5. HTTP API (companion, `127.0.0.1` only)

All routes require `Host == 127.0.0.1:<port>`. All non-GET routes also require `Origin == http://<host>`, `Content-Type: application/json`, and header `x-finance-local == nonce` (the nonce comes from `GET /api/status`). Bodies are capped at 1 MB (packet stage: 256 KB; it carries paths, not bytes). IDs match `^[a-z0-9-]{4,64}$`; any other value is a 400. No route echoes a filesystem path the client did not already send.

| Method and path | Purpose |
|---|---|
| `GET /api/status` | Existing fields plus `agents: { runtime: detectClaude(), maxPilotsPerRound, models, efforts }`, `nonce`. |
| `POST /api/agents/packet/inspect` `{sourceDir}` | Lists regular files (no symlinks, depth ≤ 4, ≤ 150 files, ≤ 100 MB) with `{path, bytes, sha256, inferredRole, defaultInclude, reason}`. Rejects paths under the project root, under `private/`, or that are not directories. |
| `POST /api/agents/rounds` `{label, sourceDir, include:[path], overrides:[path], promptText, gafVisible, config}` | Creates a round in `draft`. Computes hashes. |
| `POST /api/agents/rounds/:id/freeze` `{gold, fingerprints}` | Writes `freeze.json`; status `frozen`. Refused after launch (use `/refreeze` for a post-hoc version). |
| `POST /api/agents/rounds/:id/approve` `{summarySha256, acknowledgements}` | `summarySha256` must equal the server's hash of the approval summary (so the writer approves exactly what will run). |
| `POST /api/agents/rounds/:id/launch` | Requires `approved`. Verifies packet hashes again, builds folders, starts runs (concurrency 3). Returns immediately. |
| `GET /api/agents/rounds` / `GET /api/agents/rounds/:id` | Round state. Polled every 1.5 s. No transcript bodies. |
| `GET /api/agents/rounds/:id/runs/:n` | Run detail incl. final text and output list. |
| `POST /api/agents/rounds/:id/runs/:n/classify` `{verdict, fingerprintIds, note}` | Human classification. Allowed only if audit is `CLEAN`. |
| `POST /api/agents/rounds/:id/cancel` | SIGTERM all runs; state `cancelled`. |
| `POST /api/agents/rounds/:id/export` | Returns run-evidence JSON (section 8). |
| `POST /api/agents/grader-sim` `{guidelineText, answerText, model}` | One tool-less simulated grader run. Counts toward a separate cap of 5 per call batch. |

Errors: `{error: "<message>"}` with 400, 403, 404, 409, 413 or 500. A launch refusal for a changed packet is 409 with `PACKET HASH MISMATCH`.

## 6. Audit (port of the field-tested checker)

`auditToolCalls(events, {folder, claudeConfigDir})` is pure and always strict. For each assistant `tool_use` it inspects the tool input strings (for `Bash`: the command; for others: every string value) and reports `violations`:

- `abs`: an absolute path that is not inside the pilot folder and not allowlisted (`/dev/null`, `/dev/stdout`, `/dev/stderr`, and files directly under `/usr/bin`, `/bin`, `/usr/local/bin`, `/usr/sbin`, `/sbin`). URLs are stripped first. Symlinks are resolved with `fs.realpathSync` when the path exists.
- `bare-root`: `ls /`, `find / ...`, `cd /` and similar commands that take bare `/` as an argument.
- `dotdot`: `..` segments are resolved against a **tracked working directory**. The tracker starts at the folder and follows `cd` in each Bash command. Only a resolved path outside the folder is a violation.
- `home`: `~`, `$HOME`, `${HOME}`, `$OLDPWD`.
- `harness-spill`: an absolute path under the user's Claude configuration directory (`claudeConfigDir`, default `~/.claude`), for example the large-output files the runtime may point an agent at. It is a violation like any other path outside the folder; the kind only explains the cause so the writer can read the report.
- `bare-cd`: `cd` with no argument.

Must **not** be flagged: `sed -n '/a/,/b/p'` style address ranges, division such as `a / b`, `x/y` inside Python, URLs, `/dev/null`.

The folder's own `.tmp/` is inside the folder, so it needs no special case. A run whose only violations are `harness-spill` is still `DISCARDED`; the UI explains the cause and the writer can re-run it.

Additional audit notes: `inputs-modified` (a solver file's sha256 changed at the end), `model-mismatch`, `leak-in-results` (a tool result mentioning the project root or `private/`).

Fixtures for the tests use these patterns: `cd ../../other` from a folder two levels deep is a violation; `cd /tmp/x/filesystem; ... > ../out.txt` is **not** a violation when `/tmp/x` is the folder; a Read of a file under `claudeConfigDir` is a `harness-spill` violation; a write to `<folder>/.tmp/a.txt` is clean.

## 7. Classification (assistive, never final)

`classify.suggest(freeze, finalText, outputsText)` returns tokens found and `verdict` in `matches-frozen-gold | fingerprint | unclear`. Numbers match with the freeze tolerance after stripping thousands separators. A verdict of `matches-frozen-gold` requires every gold figure, plus a decision phrase check supplied by the writer (`gold.decision` keywords). A fingerprint hit requires all of that fingerprint's tokens or figures. The result is labelled "heuristic" in the UI. The human verdict is the one stored and exported.

## 8. Evidence export

`export` returns an array of records accepted by `candidate-engine.js` `logs()` and by `core.js` `validateExperiment`:

```
{ runId, date, model (resolved), versions:{prompt,workbook,evaluator}, sourceFingerprint, score:null, scoreMax:null,
  kind:"local-blind-pilot", audit:"CLEAN", classification:"no-root-failure"|"model-error", rootFailures:[fingerprint ids],
  evidence:"private/agent-rounds/<id>/runs/<n>", notes:"Local blind pilot, directional, n=<k>, GAF visible=<bool>, freeze <sha>" }
```

`DISCARDED` runs are exported only in a separate `discarded` array. The experiment's `snapshot` equals `core.snapshot(project)` at export time.

## 9. UI: the Agents page

A new top-level view `agents` in `dashboard.js`, implemented in `agents.js`.

1. **Runtime.** Found / not found, version, path. Offline edition: "Local agents need the companion. Run `npm start`."
2. **Packet.** Folder path input, **Inspect**, a table of files with include boxes (defaults exclude evaluator, answer, rubric, golden, `private`), prompt box (word count against the project limit), `gaf/` toggle with the sentence "Matches production only if the production solver sees this file."
3. **Freeze.** Gold decision phrase, figures with tolerance, fingerprints (id, label, tokens). **Freeze** button shows the hash and timestamp. Launch stays disabled until frozen.
4. **Round.** Model, effort, pilots (1 to 5, stepper cannot exceed the cap). The isolation statement and the shell-access statement are printed here, not hidden in a tooltip.
5. **Approve and launch.** A modal repeats the summary, shows the exact command line with the prompt elided, requires three checkboxes (shell access as me, network use by the agent runtime, isolation by audit only), then calls approve and launch.
6. **Runs.** One row per pilot: state, turns, tool calls, resolved model, audit badge, elapsed. Click opens the detail drawer (final answer, outputs, violations with the offending call and the plain cause for `harness-spill`).
7. **Classify.** Suggested verdict (heuristic), human verdict control, fingerprint chips, note. Disabled for `DISCARDED`.
8. **Directional banner.** "Directional only, n = k. No rate or difficulty is computed."
9. **Export.** Adds the records as experiments on the project (confirmation), and downloads the round JSON.
10. **Simulated grader and author review** buttons sit under the runs table, each behind its own approval.

Accessibility and layout follow the existing views (mobile no horizontal overflow, keyboard reachable controls, `aria-live` status).

## 10. Files

New: `backend/agents/{constants,claude-runner,pilot-folder,path-audit,classify,rounds,index}.cjs`, `backend/agents/stub-claude.cjs` (test double), `agents.js`, `scripts/privacy-scan.cjs`, `docs/local-agents.md`, tests listed below.

Changed: `core.js` (lint alignment, section 13), `app.js` (extra lint terms), research catalog files (scrub, section 15), `backend/server.cjs` (routes), `index.html` (+ `agents.js` script tag), `scripts/build-standalone.cjs` (script count 9 → 10), `dashboard.js` (+ nav entry and view dispatch), `styles.css`, `package.json` (`start` script, version 3.0.0), `Start Finance Task Studio.command`, `README.md`, `VERIFICATION.md`, `.gitignore` (`/private/agent-rounds/` is already covered by `/private/`).

Unchanged: `backend/harness.cjs` (archived DeepSeek adapter), `core.js` schema and exports, `candidate-engine.js` public API.

## 11. Tests (must pass without any model call or network)

| File | Covers |
|---|---|
| `tests/agents-audit.test.cjs` | Every violation kind and every must-not-flag case from section 6, including the tracked working directory, symlink escape, `.tmp/` clean, `harness-spill` discarded, and no allowance flags. |
| `tests/agents-folder.test.cjs` | Folder build is byte-identical; refuses `private/`, evaluator names, symlinks, path traversal in include list, > limits; override recorded; `.tmp` created; verify-unchanged detects a modified input. |
| `tests/agents-runner.test.cjs` | With `stub-claude.cjs`: args are exactly section 3.2, stream parsing, completed/failed/cancelled, timeout kill, model mismatch note, stderr tail, concurrency 3, cap of 5 enforced, hash mismatch refuses launch, approval hash must match, freeze required. |
| `tests/agents-classify.test.cjs` | Tolerance matching, fingerprint all-tokens rule, `unclear`, never final. |
| `tests/agents-server.test.cjs` | Ephemeral port. Host check, Origin check, nonce, content type, body cap, id validation, path rules, no route runs without approval, status shape, export shape validates through `core.validateExperiment`. |
| `tests/agents-browser.cjs` (not in `npm test`) | Headless Chromium against the companion with the stub: Agents page flow end to end, mobile and desktop screenshots in `qa/agents/`, zero console errors, requests only to `127.0.0.1`. |
| `tests/bundle.test.cjs` (updated) | Standalone still embeds every exact script byte, includes `agents.js`, and carries no private module. |

Baseline before this work: `npm test` is 80 pass and 1 skipped. It must stay green and grow.

## 12. Out of scope (stated, not hidden)

- An operating system sandbox (`sandbox-exec`, `bwrap`). Not shipped because it cannot be validated from the build environment. The audit and the folder boundary are what ship, and the UI says so.
- Zip upload of packets. v1 reads a folder on disk.
- A pass rate or difficulty estimate.
- Running agents from the offline edition.
- Reading or writing anything outside `private/agent-rounds/` and the pilot folders.

## 13. Lint alignment: the shipped format governs

The lint in `core.js` was written against a stricter format than the tasks that actually run. The lint changes, not the tasks. Observed shipped format: a business prompt of up to about 60 words, and grader guidance of roughly 550 to 650 words in five titled blocks (`Context`, `Golden Response`, `1. Must-haves`, `2. Common Failures`, `3. Acceptable Variation`) whose first sentence says the reader is grading something.

Changes (each with a test in `tests/core.test.cjs`):

1. `promptLimit` default becomes 60 words. The 44-word `exportPolicy` exception stays importable for old projects, validated as before, but is never lower than the default: the effective limit is `max(60, policy)`. `generatePrompt` keeps generating prompts of 40 words or fewer (a writer may still choose 40; the lint only rejects more than the limit).
2. `guidance-long` (review) moves from over 500 words to over 650 words. The blocker at 800 or more stays.
3. `guidance-titled-section` does not flag the five block headings above (exact match, with or without the leading number and period). Other titled sections, markdown headings and bold titles are still flagged.
4. `guidance-scoring-word` no longer flags the word `grading` when it appears in the sentence form `You are grading` or `You are grading a`. Other uses of `grading`, `score`, `scoring` and `points` keep their current behaviour. Scoring blockers (`penalise`, `partial credit`, `weighting`, and the rest) are unchanged.
5. The internal-jargon check keeps its generic terms and **no longer names any platform or company**. `lintGuidance(text, {extraJargon: [string]})` accepts extra case-insensitive terms. `dashboard.js` / `app.js` pass `lintTerms` from a loaded private evidence module (array of strings) when it carries one, so a writer can keep platform specific terms locally.
6. `audit()` and `README.md` state the new limits.

Not changed: the scoring-language blockers, the cell-reference check, the dash and unicode check, the AI-mention check, the vague-failure heuristic.

## 14. Privacy scan: block pushes that carry task content

`scripts/privacy-scan.cjs` is generic. Its term list is **not** in the repository: it reads one term per line from `private/privacy-terms.txt` (lines starting with `#` ignored; a term wrapped in `/.../i` is a regular expression, anything else is a case-insensitive literal). It fails closed: if the file is missing or empty it exits non-zero with the message `no privacy term list: refusing to pass`.

- It scans every tracked file and every untracked file that git does not ignore (text files only; binary files are counted, listed by name, and skipped), and with `--range <base>..<head>` also the added lines of the commits about to be pushed.
- It prints `file:line` and the matched term index, never the full line, and exits 1 on any hit.
- `npm run privacy` runs it. A local `pre-push` hook (installed by the writer or the main session, not versioned) runs it and blocks the push.
- Tests use a synthetic term list passed with `--terms <file>`; they never read `private/`.

## 15. Scrub: no platform names in public lint rules or research text

The public tree must not name the evaluation platform or the contractor. Remove those names from `core.js` (jargon list), `catalog.js`, `research-catalog.json`, `research/*.json`, `research-gates.js`, `README.md`, `VERIFICATION.md` and regenerated outputs. Where a sentence only exists to mirror Studio's own guidance for that platform, move the original text to `private/research-originals/` (a copy of the file as it was) and replace the public wording with a neutral phrase ("the target platform", "the evaluation"). Facts about the cited papers stay. Git history already contains the old text; rewriting history is a separate decision for the repository owner and is not done by this change.
