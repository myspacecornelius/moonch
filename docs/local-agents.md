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

1. **Nothing starts without an explicit approval click** for that round. The approval dialog shows model, effort, number of pilots, how many run at once, the spending cap per pilot and the round maximum, tool list, working folder, packet hash and the isolation statement. Starting the companion never starts a model.
2. **At most 5 pilots per round.** The cap is a constant in `backend/agents/constants.cjs` and is enforced on the server, not only in the UI. A new round needs a new approval.
3. **Gold is frozen before launch.** The server refuses to launch a pilot round without a freeze record (hash and timestamp). Edits after launch create a new freeze version labelled post-hoc and never overwrite the original.
4. **Blind means blind.** Each pilot runs in its own folder outside the project root (`<os tmpdir>/finance-studio-pilots/<runId>/`). The folder holds only the approved solver files, an empty `outputs/` and an empty `.tmp/` that is the agent's `TMPDIR`. No grader file, gold, fingerprint, evidence module, log or earlier output is ever copied in. The runner refuses to build a folder if a selected file is under `private/`, or the shared path rule (`classifyPath` in `package-engine.js`, section 9) gives it the evaluator role, unless the writer overrides that file by name in the UI (recorded in the round).
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

It runs `claude --version` with a 5 second timeout. It never runs a model. Reading the status (`GET /api/status`) runs only this.

**Pre-flight.** Before anything starts (a launch, a simulated grader, an author review) and when the page asks for it before approval (`POST /api/agents/rounds/:id/preflight`), the server detects the runtime again and makes four checks. None runs a model; a failure is a 409 that names the problem and says nothing was started.

1. `claude --help` must list every option in the argument lists about to run (`REQUIRED_FLAGS` in `claude-runner.cjs` is exactly what `buildArgs` can produce). An older or newer CLI that lacks one, for example `--max-budget-usd`, is refused by name. The parsed option list is cached per binary path and version; a failure is never cached.
2. The pilot token is read (section 3.4): `FINANCE_STUDIO_PILOT_TOKEN` in the companion's environment, else on macOS the Keychain item `finance-studio-pilot-token`. No token is fine (pilots use the writer's own sign-in). A token that is there but cannot be used or read is refused, naming its place and never its text.
3. The companion's environment must not route a pilot elsewhere (`gatewayFindings` in `pilot-token.cjs`): `ANTHROPIC_BASE_URL` at any host but `https://api.anthropic.com`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_USE_BEDROCK|VERTEX|FOUNDRY`, or a model override (`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`). With the pilot token such a variable is simply left out of the pilot environment and the answer says so; without it the pre-flight is refused by variable name (host names and the word "set", never a value), because the Studio could not tell what such a pilot tests.
4. `claude auth status --json` must exit 0 and say `loggedIn: true`, run with exactly the pilot environment (section 3.2, pilot token included) in a throwaway `<tmpdir>/finance-studio-preflight-*` folder that is removed afterwards. Email and organisation fields are dropped. For a launch it runs after the packet hash check, and the round state is checked again after the wait. With the token the refusal says so and points at `claude setup-token`. Checked live (2.1.296): with `CLAUDE_CODE_OAUTH_TOKEN` set the command answers `loggedIn: true, authMethod: oauth_token` for any value of the right shape, so this check proves the runtime accepts the token, not that Anthropic does; the first model call does that (smoke S1).

The pre-flight returns `{token, source, dropped}` to its caller; the token lives in memory for that launch (`live.token`) and is never written.

### 3.2 Argument list (fixed, built by the server)

```
claude -p <prompt-text>
  --model <allowlisted id> --effort <allowlisted level>
  --output-format stream-json --verbose
  --tools "Bash,Read,Write,Edit,Glob,Grep" --allowedTools "Bash,Read,Write,Edit,Glob,Grep"
  --permission-mode acceptEdits
  --disable-slash-commands --strict-mcp-config --setting-sources ""
  --no-session-persistence
  --max-budget-usd <x.xx>
```

- `cwd` is the pilot folder. `stdin` is closed. Timeout 50 minutes (`timeout` semantics: SIGTERM, then SIGKILL after 5 s).
- **Spending cap.** `--max-budget-usd` is the last argument of every round's list; with `promptVia: 'stdin'` (next item), `--input-format text` follows it. A pilot round chooses the cap per round (`config.maxBudgetUsd`, USD 0.05 to 20.00 in whole cents, default 3.00); tool-less runs use 0.50. A run the runtime stops at the cap ends with a `result` event of subtype `error_max_budget_usd` (the name the 2.1.296 CLI uses for this case, read from its text, not yet seen in a live run; the stub sends that shape); it is `failed` with `failureReason: "budget"`.
- **What the cap covers.** The cap applies to each pilot process the Studio starts. It is not a ceiling on everything a pilot's shell can start: the pilot environment keeps `PATH`, `CLAUDE_BIN` and the sign-in reachable (below), the runtime has no environment variable for a budget, so a `claude` process that a pilot starts itself runs under the writer's sign-in with no cap, and its tool calls appear only inside the outer pilot's tool output, unaudited. The audit discards such a run after the fact (violation kind `runtime`, section 6); it cannot stop the process or see a start under a name built at run time. The approval summary states the cap per pilot, pilots × cap "for the pilot processes the Studio starts", and this limit in words; the settings card and the approval dialog repeat it.
- **Prompt on stdin (available, not used by rounds).** `buildArgs({promptVia: 'stdin'})` leaves the prompt out and appends `--input-format text`; `ClaudeRun` then writes the prompt to stdin and closes it. Rounds keep the prompt as the argument after `-p` until a live run confirms stdin delivery (`scripts/live-smoke.cjs --stage S1 --prompt-via stdin`). The 120 KiB prompt limit applies either way.
- **Environment** (`pilotEnv` in `claude-runner.cjs`): the parent environment plus
  - `TMPDIR` and `CLAUDE_CODE_TMPDIR` = `<folder>/.tmp`, so scratch space and temporary files are inside the folder;
  - `CLAUDE_CONFIG_DIR` = `<folder>/.tmp/claude-config`, created before the process starts, so the runtime's own files (for example a large tool output it saves under `projects/<cwd key>/<session>/tool-results/` and points the agent at) stay inside the folder;
  - `CLAUDE_SECURESTORAGE_CONFIG_DIR`, so the runtime still finds the writer's sign-in where it always is: a value the writer already set is kept, else the writer's `CLAUDE_CONFIG_DIR`, else the empty string (Claude Code 2.1.x reads empty as `~/.claude` for the credentials file and as "no suffix" for the macOS Keychain item name, exactly as when neither variable is set). Nothing is copied into the pilot folder; no credentials file is ever written there;
  - `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, so no memory or `CLAUDE.md` file reaches a blind pilot;
  - with the dedicated pilot token (section 3.4): `CLAUDE_CODE_OAUTH_TOKEN` = the token, and none of `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_USE_BEDROCK|VERTEX|FOUNDRY`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL` or the writer's own `CLAUDE_CODE_OAUTH_TOKEN` (`DROPPED_WITH_TOKEN` in `pilot-token.cjs`), so the pilot reaches Anthropic directly with the token and nothing else.

  `FINANCE_STUDIO_PILOT_TOKEN`, the companion's own source of the token, is always left out. Nothing else is added or removed. No API key is read, logged or forwarded explicitly. The child environment is otherwise not scrubbed; the audit is given the same environment so inherited path variables are resolved. The runtime writes its own `.claude.json` into `<folder>/.tmp/claude-config`. It can hold account metadata (in a test container: account and organisation ids and the email address; no tokens). A pilot can read it without a violation, and it stays with the private (0700) pilot folder. Tool-less runs and the sign-in check use the same environment.
- **What has been checked against the real CLI.** Only stage S0 of `scripts/live-smoke.cjs` (section 11), which starts no model: `claude --help` lists every option above, and `claude auth status` in the pilot environment says signed in and reports the moved folder as its configuration folder. S1 and S2 call a model and were **not run in this build**, so three things above are still unconfirmed against a live run: that the runtime saves a large tool output under `<folder>/.tmp/claude-config`, that `--max-budget-usd` stops a live pilot (and with which exit code), and that a prompt on stdin arrives intact. Sign-in under the moved folder was shown only in a container where every environment signs in; a machine with a file-based sign-in (Linux) or the Keychain (macOS) has not been checked.
- Prompt text for a pilot: `The task materials are in ./filesystem. Save any files you produce to ./outputs. When you finish, give your answer in your final message.\n\n` followed by the writer's prompt.
- Allowlists: models `claude-opus-5-5` (default), `claude-sonnet-5-5`, `claude-fable-5-1`, `claude-haiku-5-5`; efforts `low`, `medium` (default), `high`, `xhigh`, `max`.
- Other agent kinds use the same runner with `tools: []` (`--tools ""`), no folder content, and a prompt built by the server:
  - `grader-sim`: a **simulated** grader. Input is the guideline text and one answer. It returns JSON with `verdict`, `reason`. Always labelled "simulated grader, not Studio grading".
  - `author-review`: one tool-less analysis of the package text the page extracts (replaces the archived DeepSeek run, which stays in the tree, unlinked and unchanged). It returns text for the author to read, is never stored or classified, and never enters an export. Labelled "author review of the loaded package, not a blind pilot and not a score".

### 3.3 Stream parsing

`claude-runner.cjs` parses newline-delimited JSON. It records:

- the `system/init` event: resolved `model`, `tools`, `skills`, `mcp_servers`;
- every assistant `tool_use` block (name and input) for the audit;
- `tool_result` text only for the leak check (not stored in the summary);
- the final `result` event: `result` text, `num_turns`, `total_cost_usd`, `terminal_reason`, `subtype`, `is_error`, `modelUsage` keys;
- a stderr tail (last 4 KB).

A run is `completed` only if exit code is 0 **and** there is a `result` event with non-empty text. Otherwise it is `failed` (or `cancelled`) and carries a `failureReason`: `cancelled`, `spawn-error`, `timeout`, `budget` (the result subtype is `error_max_budget_usd`, whatever the exit code), `signal`, `no-exit-code`, `exit-code`, `no-result`, `error-result`, `empty-result`; the rounds add `setup-error` and `interrupted`. The page explains each in words. A cancelled run is `cancelled`. Requested versus resolved model is reported separately; a mismatch is an audit note (`model-mismatch`), never silently corrected.

**Redaction at the source.** `ClaudeRun` takes `redact` (the pilot token). Every stdout line is passed through it before it is written to the transcript, parsed or emitted, and so is the stderr tail; `[pilot-token redacted]` stands where the token stood. The summary counts the lines it changed (`redactions`), and the rounds turn a count above zero into a `secret` violation, because the token was in the runtime's output whatever the stored events show (a tool result is kept to 2000 characters).

### 3.4 Pilot sign-in: the dedicated token

A pilot does not have to run under the writer's own sign-in, and when the writer's own Claude Code goes through a gateway (settings that set `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`) it cannot: pilots load no settings (`--setting-sources ""`), so they would have no sign-in at all, and a pilot that did go through the gateway would test whatever the gateway serves, which the Studio cannot tell. The answer is a token of the writer's own Claude subscription, made with `claude setup-token`, that only pilots use (`backend/agents/pilot-token.cjs`).

- **Where it lives.** On macOS, the Keychain item `finance-studio-pilot-token` (`security add-generic-password -U -a "$USER" -s finance-studio-pilot-token -w`; the token is typed at the prompt, so it is in no shell history). On any system, `FINANCE_STUDIO_PILOT_TOKEN` in the companion's own environment, which wins over the Keychain because it is an explicit choice of whoever started the companion. Never in the repository, in `private/`, in a settings file or in a round record.
- **How it is read.** `readPilotToken` runs `security find-generic-password -s finance-studio-pilot-token -w` (10 second limit; exit 44 means no item) at every pre-flight, and the companion reads it once more at start-up for one terminal line (`Pilot sign-in: …`). A token must be printable ASCII of 16 to 4096 characters. Errors name the place the token came from and never its text or any output of `security`.
- **Who gets it.** Only the processes the Studio starts: pilots, the sign-in check, simulated graders and author reviews, as `CLAUDE_CODE_OAUTH_TOKEN` (section 3.2), with the gateway, provider, model and other sign-in variables left out of their environment.
- **What keeps it out of the record.** The runner blanks it out of the stream before anything is parsed or written (section 3.3). The audit is given the value (`secretValues`) and discards a run that reads the environment (`environ`) or shows the token anywhere (`secret`, section 6); its report says "(the pilot token)" and every text it shows passes through the same redaction. After a run, the whole pilot folder (outputs, scratch space, the runtime's own files under `.tmp/claude-config`, the copied inputs) and the evidence copy under `private/agent-rounds/<round>/runs/<n>/outputs` are scanned, and the token is blanked out of any file that holds it; such a run is `DISCARDED` with the files named (note `secret-redacted`). The output snapshot hashes are taken before that scan, so they describe the files as the pilot left them.
- **What it does not do, stated plainly.** The token is in the pilot's process environment, so a pilot can read it, and a pilot with network access can send it somewhere before the run ends. The audit discards such a run afterwards; it cannot stop it. A token that is sent away is compromised: make a new one with `claude setup-token` and store it again. A pilot can also use the token to start another `claude` process (section 3.2, "What the cap covers"), which the `runtime` rule discards after the fact. The sign-in check proves the runtime accepts the token, not that Anthropic does (section 3.1); the first model call does that. On a system that is not macOS and has no `FINANCE_STUDIO_PILOT_TOKEN`, pilots use the writer's own sign-in as before.

## 4. Data model (all JSON, schema `finance-agent-round` version 1)

```
Round {
  id: "rnd-<12 hex>", createdAt, label,
  packet: { sourceDir, files:[{path, sha256, bytes, role, include, overridden}], promptText, promptSha256, packetSha256, gafVisible:boolean },
  freeze: null | { version:1, frozenAt, sha256, contentSha256, gold:{ decision, figures:[{label, value, tolerance}] , notes }, fingerprints:[{ id, label, tokens:[string], figures:[{label,value,tolerance}] }], postHoc:false },
  config: { kind:"pilot", model, effort, count:1..5, tools:[...], maxBudgetUsd:0.05..20, concurrency:1..count },
  carriedFrom: null | "<earlier round id>",
  carried: null | { roundId, freezeVersion, postHoc, freezeSha256, contentSha256, packetSha256, promptSha256, gafVisible, config, content:{gold, fingerprints} },
  approval: null | { approvedAt, summarySha256, acknowledgements:["shell-access","network","isolation-by-audit"] },
  runs: [ Run ],
  status: "draft"|"frozen"|"approved"|"running"|"finished"|"cancelled"|"failed"
}
Run {
  id: "<roundId>-<n>", n, folder, state:"queued"|"running"|"completed"|"failed"|"cancelled",
  startedAt, endedAt, exitCode, signal, failureReason (null | section 3.3), requestedModel, requestedEffort, resolvedModel,
  numTurns, costUsd, terminalReason, stderrTail,
  toolCalls:{total,bash,file},
  audit:{ status:"CLEAN"|"DISCARDED", violations:[{tool,kind,path,call}], inputsModified:[string], notes:[string] },
  final:{ text, chars }, outputs:[{name,bytes,sha256}],
  classification: null | { suggested:{verdict,matches,fingerprints}, human:{verdict, fingerprintIds:[string], note, at} }
}
```

`contentSha256` hashes the gold and fingerprints only (no time stamp), so two freezes of the same content compare equal; `sha256` covers it as well as `frozenAt`. Freezes stored before this field are hashed on demand. `config.concurrency` is how many pilots run at once (default: all of them). A round stored before `maxBudgetUsd` and `concurrency` existed and not launched yet (draft, frozen or approved) gets them when the companion loads it: USD 3.00 per pilot and every pilot at once, the values its approval summary already showed, so it can be frozen again, approved and launched as it is. A launched round keeps the config it ran with. Approval refuses a round whose stored config `parseConfig` would change, because the launch refuses it (409, "Freeze again from the form, which creates a new round"). An approved round that no longer matches its approval (for example one approved by an earlier version over a different summary text) can never launch: cancel it, then freeze a new round from the form or start the next round from it; the launch refusal says so. Round views also carry `carryChanges` (`packet`, `prompt`, `gafVisible`, `settings`, `freezeContent`: what differs from the round it was carried from).

Persisted files per round under `private/agent-rounds/<roundId>/`: `round.json`, `freeze.json`, `packet.sha256`, and per run `runs/<n>/{transcript.jsonl, stderr.txt, run.json, outputs/}`. Transcripts are written as they arrive and never edited.

## 5. HTTP API (companion, `127.0.0.1` only)

All routes require `Host == 127.0.0.1:<port>`. All non-GET routes also require `Origin == http://<host>`, `Content-Type: application/json`, and header `x-finance-local == nonce` (the nonce comes from `GET /api/status`). Bodies are capped at 1 MB (packet inspection and round creation: 256 KB; they carry paths, not bytes). IDs match `^[a-z0-9-]{4,64}$`; any other value is a 400. No route echoes a filesystem path the client did not already send.

| Method and path | Purpose |
|---|---|
| `GET /api/status` | Existing fields plus `agents: { runtime: detectClaude(), maxPilotsPerRound, models, efforts }`, `nonce`. |
| `POST /api/agents/packet/inspect` `{sourceDir}` | Lists regular files (no symlinks, depth ≤ 4, ≤ 150 files, ≤ 100 MB) with `{path, bytes, sha256, inferredRole, defaultInclude, reason}`. Rejects paths under the project root, under `private/`, or that are not directories. |
| `POST /api/agents/rounds` `{label, sourceDir, include:[path], overrides:[path], promptText, gafVisible, config, carriedFrom?}` | Creates a round in `draft`. Computes hashes. `carriedFrom` (optional) is the id of an earlier round whose latest gold and fingerprints are recorded in `carried`, as `/next` does: 400 if it is not a round id, 404 if that round is unknown, 409 if it has no freeze. Nothing is frozen or approved by it. The page sends it when a form filled by **Start next round** is frozen. |
| `POST /api/agents/rounds/:id/freeze` `{gold, fingerprints}` | Writes `freeze.json`; status `frozen`. Refused after launch (use `/refreeze` for a post-hoc version). |
| `POST /api/agents/rounds/:id/approve` `{summarySha256, acknowledgements}` | `summarySha256` must equal the server's hash of the approval summary (so the writer approves exactly what will run). |
| `POST /api/agents/rounds/:id/preflight` | The launch pre-flight (section 3.1) without approving or starting anything. 200 `{ok, roundId, version, checkedAt, signIn, checks}` (`signIn` is one sentence on where pilots sign in from; `checks` has four lines) or 409 with the reason. |
| `POST /api/agents/rounds/:id/launch` | Requires `approved`. Verifies packet hashes again, runs the pre-flight, builds folders, starts runs (all pilots of the round at once by default; `config.concurrency` can ask for fewer, never above 5). Returns immediately. 409 while a simulated grader or author review is running. |
| `POST /api/agents/rounds/:id/next` | Start the next round from a frozen round: a new `draft` with the same source folder (listed again, so hashes are current), selection and overrides, prompt, gaf setting, config and label, and `carried` holding the earlier round's latest gold and fingerprints. Nothing is frozen or approved. The body carries nothing. 409 for a round without a freeze or a packet that can no longer be built as it was. |
| `GET /api/agents/rounds` / `GET /api/agents/rounds/:id` | Round state. Polled every 1.5 s. No transcript bodies. |
| `GET /api/agents/rounds/:id/runs/:n` | Run detail incl. final text and output list. |
| `POST /api/agents/rounds/:id/runs/:n/classify` `{verdict, fingerprintIds, note}` | Human classification. Allowed only if audit is `CLEAN`. |
| `POST /api/agents/rounds/:id/cancel` | SIGTERM all runs; state `cancelled`. |
| `POST /api/agents/rounds/:id/export` | Returns run-evidence JSON (section 8). |
| `POST /api/agents/rounds/:id/refreeze` `{gold, fingerprints}` | After launch only. Stores a post-hoc freeze version beside the original, which is never overwritten. |
| `POST /api/agents/grader-sim` `{guidelineText, answerText, model}` | One tool-less simulated grader run. Counts toward a separate cap of 5 per call batch. 409 while any round runs or is being launched (section 16). |
| `POST /api/agents/author-review` `{promptText, packageText, model}` | One tool-less author review. `packageText` is at most 100,000 characters. One at a time. 409 while any round runs or is being launched. |

Errors: `{error: "<message>"}` with 400, 403, 404, 405, 409, 413, 415 or 500. A launch refusal for a changed packet is 409 with `PACKET HASH MISMATCH`. A wrong `Content-Type` is 415. An error the server did not expect is a generic 500 and the cause goes only to the terminal log; server folder paths are redacted from every message.

## 6. Audit (port of the field-tested checker)

`auditToolCalls(events, {folder, claudeConfigDir, env, companionPort, runtimeBin, secretValues})` is pure and always strict. For each assistant `tool_use` it inspects the tool input strings (for `Bash`: the command; for others: every string value) and reports `violations`:

- `abs`: an absolute path that is not inside the pilot folder and not allowlisted (`/dev/null`, `/dev/stdout`, `/dev/stderr`, and files directly under `/usr/bin`, `/bin`, `/usr/local/bin`, `/usr/sbin`, `/sbin`). URLs are stripped first. Symlinks are resolved with `fs.realpathSync` when the path exists.
- `bare-root`: `ls /`, `find / ...`, `cd /` and similar commands that take bare `/` as an argument.
- `dotdot`: `..` segments are resolved against a **tracked working directory**. The tracker starts at the folder and follows `cd` in each Bash command. Only a resolved path outside the folder is a violation.
- `home`: `~`, `$HOME`, `${HOME}`, `$OLDPWD`.
- `harness-spill`: an absolute path under the writer's own Claude configuration directory (`claudeConfigDir`: the writer's `CLAUDE_CONFIG_DIR`, else `$HOME/.claude`; never the pilot's moved one), for example the large-output files the runtime would point an agent at if its configuration were not moved. It is a violation like any other path outside the folder; the kind only explains the cause so the writer can read the report. The pilot's own `<folder>/.tmp/claude-config` is inside the folder, so with the moved configuration (section 3.2) such spills are clean.
- `loopback`: a tool input that reaches for this machine over the network. The companion answers every local process and its rounds hold the gold, so this discards the run. Loopback is `127.0.0.0/8`, `localhost` (and `*.localhost`, `localhost.localdomain`, `ip6-localhost`), `::1`, `[::1]`, `::ffff:127.x.y.z` and `0.0.0.0`; the companion's own port (`companionPort`, handed over by the server after it listens) counts with any host. Flagged: a URL with a loopback host (any scheme but `file:`; in a URL host also `127.1`, `2130706433`, `0x7f000001`, `0`), `host:port` with a loopback host (also a port built at run time), a quoted loopback host string, `127.a.b.c` or `0.0.0.0` written out, `/dev/tcp` and `/dev/udp` to a loopback host or the companion port, a line naming a network client together with `localhost`, a shell word that is only a loopback host (`curl localhost`, `H=localhost`), and the companion port as `:<port>`, `port=<port>`, `port: <port>` or a URL port. Not flagged, by decision: the bare word `localhost` in prose (a sentence in a written file, an echo of a sentence, a here-document line that names no network client), remote URLs, other ports, and the companion port as a plain figure. `companionPort` must be a whole number from 1 to 65535 or null; anything else throws, and a throwing audit discards the run. At most 50 loopback findings are examined per text and per call.
- `bare-cd`: `cd` with no argument.
- `runtime`: a tool input that starts the agent runtime again. Such a process runs under the writer's sign-in with no `--max-budget-usd` cap (only the process the Studio starts gets one) and its tool calls are never audited. `auditToolCalls` takes `runtimeBin` (the runtime the round started, `live.bin` in the store; an absolute path or null, anything else throws). Flagged: in a shell command, any word whose value after expansion is the runtime, that is a last path segment `claude` (any case, also `claude.exe`), or the `runtimeBin` path, its real path or, as a bare name, its file name. Any word counts, not only the command name, because `xargs`, `find -exec`, `watch` and the like start their arguments (so `which claude` is flagged too); `$CLAUDE_BIN -p` and `C=claude; $C` are seen through expansion. In any text of any tool (the command, inline code, a file a pilot writes, a description): `claude` followed by an option (`claude -p`, `/usr/local/bin/claude --print`), a quoted `'claude'` or quoted path ending in `/claude` (how code names a program for `subprocess`, `spawn` or `execFile`), `@anthropic-ai/claude-code`, and the `runtimeBin` path. Not flagged: `claude` in a sentence ("prepared with Claude"), names that only contain it (`claude-config`, `claude_notes.txt`, `.claude`). Not seen: a start under a name built at run time or through a copy whose name the call does not show. The Studio does not put a `claude` that refuses to start first on the pilot's `PATH`: the pilot could change `PATH` back, and such a shim could not be checked against the live runtime here; the audit is the check.
- `environ`: a tool input that reads the process environment, which holds the pilot's sign-in (section 3.4) and whatever the writer's shell exported, and which no finance task needs. Flagged in a shell command: `env` with nothing to run after it (only options, their values and `NAME=value` words; also behind `nohup`, `time`, `timeout 5`), `printenv` anywhere in the command (also after `xargs`, `find -exec`, `watch`), a bare `export` or `export -p`, `declare`/`typeset` with no name (bare, `-p`, `-x`), a bare `set`, `compgen -e|-v|-A export|-A variable`, `ps` with an `e` in a BSD style option word (`ps e`, `ps axeww`; only when no dash option precedes it), `ps -E`, a `ps` format naming `env`, and `launchctl getenv|export`. Flagged in any text of any tool: `/proc/<pid>/environ`, the names `CLAUDE_CODE_OAUTH_TOKEN`, `FINANCE_STUDIO_PILOT_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, code that reads the environment (`os.environ`, `process.env`, `getenv(`, `System.getenv`, `%ENV`, `$ENV{`, Ruby `ENV[`/`ENV.fetch`, `os.Environ(`, `std::env::`, `Sys.getenv`, `Environment.GetEnvironmentVariable`) and `${!name}`. Not flagged: `env python3 x.py`, `export NAME=value`, `set -e`, `ps aux`, `ps -ef`, `ps -C sleep`, and the words env or environment in prose.
- `secret`: the pilot token itself (`secretValues`: strings of at least 8 characters, anything else throws), in plain or JSON-escaped form, or the runner's marker `[pilot-token redacted]`, in any tool input, tool result, assistant text or final answer; and a read of a credential store: `security find-generic-password|find-internet-password|dump-keychain|export|find-key`, or the names `finance-studio-pilot-token`, `Claude Code-credentials`, `.credentials.json` in any text. The report says "(the pilot token)", or "(the pilot token in a tool result | the final answer | the assistant text)", and every path and call text in the report passes through the same redaction, so the report never holds the value. The rounds add two more sources of this kind: the runner's own redaction count (the token was in the output whatever the kept events show) and the files scan after the run (`(the pilot token in a file)`, the files named in `call`).

**Implementation notes (as built).** The audit tokenises shell commands (quotes, substitutions, here-documents, subshells, redirects, `bash -c`, `eval`), splits on unquoted `$IFS`, expands brace words such as `{cat,/etc/x}`, and tracks `cd`, `cd -`, `pushd`/`popd` and `$PWD`. A word is a URL only when it has a real host and nothing left to expand; `x://../..` is a relative path. It accepts `env` (the environment the pilot actually received, so `$VAR/path` is checked for inherited variables), `budgetMs` and `clock`. Work is bounded and **fails closed**: a call that cannot be analysed is a violation, not a pass. Notes that never discard a run: `unverifiable-command`, `unverifiable-code`, `unverifiable-input`, `cwd-unresolved` (relative paths after an unresolvable `cd` are not checked). The audit remains a heuristic: paths built at run time, shell functions and aliases, and encoded text passed to a shell can evade it. The UI and README say so.

Must **not** be flagged: `sed -n '/a/,/b/p'` style address ranges, division such as `a / b`, `x/y` inside Python, remote URLs, `/dev/null`, `localhost` in prose.

The folder's own `.tmp/` is inside the folder, so it needs no special case. A run whose only violations are `harness-spill` is still `DISCARDED`; the UI explains the cause and the writer can re-run it.

Additional audit notes: `inputs-modified` (a solver file's sha256 changed at the end), `model-mismatch`, `leak-in-results` (a tool result mentioning the project root or `private/`), `secret-redacted` (the pilot token was blanked out of named files after the run) and `secret-scan-skipped` (a file too large or unreadable to scan for it).

Fixtures for the tests use these patterns: `cd ../../other` from a folder two levels deep is a violation; `cd /tmp/x/filesystem; ... > ../out.txt` is **not** a violation when `/tmp/x` is the folder; a Read of a file under `claudeConfigDir` is a `harness-spill` violation; a write to `<folder>/.tmp/a.txt` is clean; a Read of a spill file under `<folder>/.tmp/claude-config` is clean; `curl http://127.0.0.1:<port>/api/status` is a `loopback` violation; `claude -p x`, in a Bash call or in a script a pilot writes, is a `runtime` violation. The audit cannot see a host assembled at run time, the machine's own host name or LAN address, or an unquoted bare `localhost` on a line that names no network client.

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
2. **Packet.** Folder path input, **Inspect**, a table of files with include boxes, prompt box (word count against the project limit), `gaf/` toggle (**on by default**: the production solver is assumed to see it; the choice is part of the round, the approval summary and every exported record) with the sentence "Matches production only if the production solver sees this file." Default inclusion follows one shared rule, `classifyPath` in `package-engine.js`, used by the browser and the companion alike (`EVALUATOR_PATTERN` in `constants.cjs` is that rule's evaluator test):
   1. A folder named `grader(s)`, `grading`, `evaluator(s)`, `reference(s)`, `answer(s)` or `private`, at any depth, withholds the file as evaluator material, also inside `gaf/`.
   2. Otherwise a `gaf` folder makes the file a template, included by default (the gaf toggle still applies). Grading words in the file name do not withhold it here, because `gaf/` is what the production solver sees; the packet table marks such a file ("Check: grading word in a gaf/ file") so the writer looks at it.
   3. Otherwise only whole words of the relative path count, folder names included (split on `/`, punctuation, spaces, camel case and letter/digit boundaries, so `solutions/x.csv` is withheld by its folder word). Grading words fail closed (guideline, guidance, grading, grader, rubric, solution, expected, answer, golden, gold, reference, memo, evaluator, fingerprint, attestation, private, with plurals, and run-together pairs such as `answerkey`). A gaf file name (`GAF_PATTERN` in `package-engine.js`: `gaf` after the start, `/`, `_`, a space or `-`, and before `/`, `_`, `.`, a space, `-` or the end, so `gaf-hedge.csv` and `GAF_notes.txt` but not `gafHedge.csv`, `gaf2024.xlsx` or `x.gaf.csv`) and the words `template(s)` make a template. That pattern is also the companion's and the page's test for which files the gaf toggle hides (`GAF_RE` in `pilot-folder.cjs`, `isGaf` in `agents.js`), so every gaf template is hidden with the toggle. The words `prompt(s)`, `instruction(s)` and `task request` make a prompt, included by default. Run evidence needs context (`trajectory`, `run 03`, `run_log`, `pilot run`, ...), so `runway` and `rerun` stay sources. The review words `review`, `audit` and `candidate` withhold a file on their own, except in ordinary phrases such as `audit committee` or `credit review`; `analysis` alone is a source. A run-together name of more than two parts (`answerkeyfinal`, `ANSWERKEYFINAL`) is not split, so it is not caught; written with camel case or separators (`AnswerKeyFinal`, `answer_key_final`) it is.
   4. Everything else is a source. Every withheld file shows a reason that starts "Withheld by default:" and names the folder or word that matched, built from the fixed lists only. Including a withheld file needs a per-file override, recorded in the round: in the page, ticking a withheld file is that override. The companion refuses an evaluator-role file sent without one (400, and again when the folder is built), and records every included file that was not included by default as `overridden`.
3. **Settings.** Model, effort, pilots (default 5, never above the cap), pilots at a time ("All N at once" by default), spending cap per pilot (USD 0.05 to 20.00, checked in the form) and the round maximum spend. They are part of the freeze signature: changing one after freezing marks the freeze stale.
4. **Freeze.** Gold decision phrase (alternatives separated by semicolons), figures with tolerance, fingerprints (id, label, tokens). **Freeze** button shows the hash, content hash and timestamp. Launch stays disabled until frozen. For a carried-forward round it shows both rounds' hashes and whether gold and fingerprints changed.
5. **Round.** The round's own settings (model, effort, pacing, cap per pilot with `--max-budget-usd`, round maximum, carried from). The isolation statement and the shell-access statement are printed here, not hidden in a tooltip.
6. **Approve and launch.** Before the modal opens the page asks for the pre-flight; a problem shows "Fix this before you approve." with the companion's reason and **Check again**, and approval stays disabled (an older companion without the route falls back to the check at launch). The modal repeats the summary (cap per pilot, round maximum, pacing, carry-forward comparison), shows the exact command line with the prompt elided, requires three checkboxes (shell access as me, network use by the agent runtime, isolation by audit only), then calls approve and launch.
7. **Runs.** One row per pilot: state, turns, tool calls, resolved model, audit badge, elapsed. Click opens the detail drawer (final answer, outputs, violations with the offending call and the plain cause for every kind, including `harness-spill`, `loopback` and `runtime`; for a failed run the reason in words, including a spent cap). **Start next round from this round** (shown in this card for a frozen round that is running or has ended: finished, failed or cancelled) calls `/next` and refills the form; it is disabled while any round runs.
8. **Classify.** Suggested verdict (heuristic), human verdict control, fingerprint chips, note. Disabled for `DISCARDED`, and while the run's details are withheld (section 16).
9. **Directional banner.** "Directional only, n = k. No rate or difficulty is computed."
10. **Export.** Adds the records as experiments on the project (confirmation), and downloads the round JSON.
11. **Simulated grader and author review** buttons sit under the runs table, each behind its own approval. Both are disabled while any round runs, with the reason in words.

A sticky status strip shows the selected round, its status, pilots done, running, waiting, failed and cancelled, elapsed time, and any other running round. While the Agents page shows, the tab title reads `(ended/total) Agents · Finance Task Studio`. The form (folder, include boxes, prompt, label, gaf setting, settings, gold, fingerprints, carry origin, and the form signatures of rounds not yet launched) is kept as a draft in `localStorage` (`finance-studio.agents.draft.v1`): saved 400 ms after a change, never while a round runs, removed by a successful launch, restored with type and length checks on load, and emptied by **Clear draft**. Every storage call is guarded, so blocked storage only loses the draft. The companion binds a free port by default, so a restarted companion is a new origin with an empty draft unless `FINANCE_STUDIO_PORT` is fixed.

Accessibility and layout follow the existing views (mobile no horizontal overflow, keyboard reachable controls, `aria-live` status).

## 10. Files

New: `backend/agents/{constants,claude-runner,pilot-folder,path-audit,classify,rounds,index,pilot-token}.cjs`, `backend/agents/stub-claude.cjs` (test double), `agents.js`, `scripts/privacy-scan.cjs`, `scripts/live-smoke.cjs` (S0 without a model; S1, S2 and S3 only with explicit approval), `docs/local-agents.md`, `tests/fixtures/clean-env.cjs` (the test environment without gateway variables or a pilot token), tests listed below.

The stub parses options like the real CLI: an option `buildArgs` does not use is refused with `error: unknown option '--x'` and exit 1, `--help` uses the real layout, and it answers `auth status`. `FINANCE_STUB_AUTH` (`ok`, `logged-out`, `file`, `token`, `broken`, `hang`), `FINANCE_STUB_HELP_DROP` (pretend to be an older CLI), `FINANCE_STUB_AUTH_LOG`, `FINANCE_STUB_PROMPT_LOG` and the scenario fields `spill`, `echoPrompt`, `echoToken` (a pilot that prints its sign-in everywhere a run leaves traces) and `budgetExhausted` drive the new tests. Its environment log records a token's presence and length, never its text. Its header lists every field.

Changed: `core.js` (lint alignment, section 13), `app.js` (extra lint terms), research catalog files (scrub, section 15), `backend/server.cjs` (routes), `index.html` (+ `agents.js` script tag), `scripts/build-standalone.cjs` (script count 9 → 10), `dashboard.js` (+ nav entry and view dispatch), `styles.css`, `package.json` (`start` script, version 3.0.0), `Start Finance Task Studio.command`, `README.md`, `VERIFICATION.md`, `.gitignore` (`/private/agent-rounds/` is already covered by `/private/`).

Unchanged: `backend/harness.cjs` (archived DeepSeek adapter), `core.js` schema and exports, `candidate-engine.js` public API.

## 11. Tests (must pass without any model call or network)

| File | Covers |
|---|---|
| `tests/agents-audit.test.cjs` | Every violation kind and every must-not-flag case from section 6, including the tracked working directory, symlink escape, `.tmp/` clean, `harness-spill` discarded, and no allowance flags. |
| `tests/agents-folder.test.cjs` | Folder build is byte-identical; refuses `private/`, evaluator names, symlinks, path traversal in include list, > limits; override recorded; `.tmp` created; verify-unchanged detects a modified input. |
| `tests/agents-runner.test.cjs` | With `stub-claude.cjs`: args are exactly section 3.2 (spending cap included), stream parsing, completed/failed/cancelled, the `budget` failure reason, timeout kill, model mismatch note, stderr tail, one wave of 5 by default and a lower `config.concurrency`, cap of 5 enforced, hash mismatch refuses launch, approval hash must match, freeze required, the moved configuration folder (a spill is CLEAN when moved and DISCARDED when not), stdin delivery, carry-forward, the pre-flight route, the companion port reaching the audit, and the service-side overlap rule. |
| `tests/agents-live-preflight.test.cjs` | Help parsing, `REQUIRED_FLAGS` equals what `buildArgs` produces, the help cache, `pilotEnv` and its helpers (same credentials folder and Keychain item name as the writer's own environment), `checkAuth`, the pre-flight order and refusals at launch, grader and author review, and `scripts/live-smoke.cjs` (option gate, S1/S2 command construction, S2 checks, S0 end to end against the stub). |
| `tests/agents-pilot-token.test.cjs` | The dedicated pilot sign-in (section 3.4): reading the token (variable first, Keychain on macOS only through an injected `security`, every refusal without the token's text), `pilotEnv` with and without it, `gatewayFindings`, the redaction helpers, the runner's redaction and count, the audit kinds `environ` and `secret` (flagged and not flagged lists, the report never holding the token), a launch under the token with gateway variables left out, the pre-flight refusals (gateway without a token, unusable token, runtime that rejects it, reader errors), a pilot that reads its sign-in ending `DISCARDED` with every kept file and the whole pilot folder scrubbed, tool-less runs, the companion's start-up line, and smoke S0 rows with a token. |
| `tests/agents-hardening.test.cjs` | The places where a change would leave the other suites green: the audit runs on each pilot's own folder and knows the runtime the round started, every field of the approval summary is bound, process groups are stopped, state survives a restart, client config keys are dropped, loopback through a written script. |
| `tests/agents-page.test.cjs` | The real `agents.js` in a fake document against a real companion with the stub: settings, pre-flight before approval, one wave, strip and title, carry-forward, draft storage, disabled grader and review, withheld views while a round runs, failed-run explanations. |
| `tests/agents-classify.test.cjs` | Tolerance matching, fingerprint all-tokens rule, `unclear`, never final. |
| `tests/agents-server.test.cjs` | Ephemeral port. Host check, Origin check, nonce, content type, body cap, id validation, path rules, no route runs without approval, status shape, export shape validates through `core.validateExperiment`, redaction while a round runs, the 409s for grader, review and launch overlap, `/next` and `/preflight`, the port hand-off and a pilot that curls the companion ending DISCARDED. |
| `tests/agents-browser.cjs` (not in `npm test`) | Headless Chromium against the companion with the stub: Agents page flow end to end, mobile and desktop screenshots in `qa/agents/`, zero console errors, requests only to `127.0.0.1`. |
| `tests/bundle.test.cjs` (updated) | Standalone still embeds every exact script byte, includes `agents.js`, and carries no private module. |

Baseline before this work: `npm test` is 80 pass and 1 skipped. It must stay green and grow.

**Live smoke (not in `npm test`).** `npm run smoke` runs `scripts/live-smoke.cjs` stage S0 against the installed CLI without starting a model: `claude --version`, the `--help` flag check, the pilot token (where it came from and its length, never its text), the gateway variables a pilot would inherit (a FAIL row without a token, "left out" with one), `claude auth status` in the writer's environment (judged only without a token) and in the pilot environment (token included), that the runtime reports the moved configuration folder, that no credentials file appears in the pilot folder, and that nothing appears under the writer's own `projects/` folder. S1 (one tool-less haiku call, cap USD 0.05, optional `--prompt-via stdin`; with a token, the run's files are checked for it afterwards), S2 (one pilot through the Studio's own round flow on a synthetic packet: spill inside the folder, CLEAN audit, no leftover background process, cost under the cap) and S3 (one pilot told to print `CLAUDE_CODE_OAUTH_TOKEN`, save it under `outputs/` and repeat it: the audit must be DISCARDED with `environ` and `secret`, and the token must be in no file the round kept nor anywhere in the pilot folder; refused without a token; cap USD 0.25) call a model; they print the exact command (the token shown as `<redacted>`) and run only with `--i-approve-model-calls`. In this build S0 passed against `claude` 2.1.296, with and without a synthetic token in `FINANCE_STUDIO_PILOT_TOKEN`; **S1, S2 and S3 were not run**, so no model was called (`VERIFICATION.md`).

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

## 16. As built: response shapes and behaviour the contract left open

These are the shapes the page and the tests rely on. A change to any of them needs a change to `agents.js` and `tests/agents-server.test.cjs`.

- **Lists and rounds.** `GET /api/agents/rounds` returns `{rounds: [row]}`, newest first, where a row has `id, createdAt, label, status, carriedFrom, config, packetSha256, freezeSha256, gafVisible, runCount, counts`. A round view (every round route) has the section 4 fields plus `postHocFreezes`, `carryChanges`, `counts` and `directional`. Its `runs` are rows: `audit` is `{status, violationCount, inputsModified, notes}`, `final` is `{chars}`, `classification` is `{suggestedVerdict, humanVerdict}`, and a failed run has its `failureReason` (section 3.3). The full record (final text, violations, outputs, `classification: {suggested, human}`) comes only from `GET .../runs/:n`.
- **Approval.** While a round is `frozen` or `approved`, its view also carries `summarySha256` and `approvalSummary` (`text, summarySha256, commandLine, workingFolder, model, effort, count, tools, maxBudgetUsd, concurrency, packetSha256, freezeSha256, gafVisible, overrides`; the last two settings are null when the stored round lacks them; a round that has not been launched gets them when it is loaded, section 4). The page approves by sending that hash back, so the server checks it against a hash of the summary it computes again. The command line is built by the server and has the prompt elided.
- **Suggestion.** `classification.suggested` is `{verdict, matches: [{label, value, found, where}], fingerprints: [{id, label, hit, tokensFound, figuresFound}], decision, label: "heuristic", freezeVersion, freezeSha256}`. Only fingerprints with `hit: true` are candidates.
- **Export.** `POST .../export` returns `{schema: "finance-agent-round-export", roundId, records, discarded, excluded, notes, freeze, directional, gafVisible}`. The page stamps each record with the project snapshot before it validates it with `core.validateExperiment`.
- **Client keys.** Keys such as `bin`, `args`, `folder` and `env` in any body are ignored. A tool list that differs from the fixed one is refused with 400.
- **Extra HTTP rules.** A GET with a foreign `Origin` header is 403. Every response carries `X-Frame-Options: DENY`. While the server shuts down, new requests get 503.
- **Shutdown.** On SIGINT or SIGTERM the server cancels the archived adapter and every running round, waits for the processes to stop, then exits. Pilots run in their own process group, so Ctrl-C reaches them only through this handler. A SIGKILL of the server leaves running pilots running.
- **Launch.** A launch with no `claude` found, or a failed pre-flight, is refused with 409 and the round stays `approved`. Only one round runs at a time. A round that was running when the server stopped is marked interrupted on the next start.
- **Blindness while a round runs.** A pilot has a shell on this machine and can reach the companion like any local process (the nonce is in `GET /api/status`). While any round is `running`, every route that answers with round data (the list, a round, a run, and the POST answers of create, freeze, `/next`, refreeze, approve, launch, cancel and classify) is passed through `redactRoundData` in `server.cjs`. Each freeze record shrinks to `{sha256, frozenAt}`. `gold`, `fingerprints`, `promptText`, `approvalSummary`, `summarySha256` and `sourceDir` are removed wherever they appear. A run's `final` becomes `{chars}`. `classification.suggested` keeps `verdict, label, freezeVersion, freezeSha256` and `classification.human` keeps `verdict, at, freezeVersion, freezeSha256`. The answer carries `redacted: true`. The freeze answer alone keeps the approval summary and its hash, so the next round can be frozen and approved while another runs. If the round list cannot be read, the server redacts. The full view returns when the round ends. Known gaps, not closed yet: `GET /api/status` still returns the archived adapter's state (including its result text), because `dashboard.js` keeps the polled snapshot; the export is not redacted (it carries fingerprint ids and the writer's classification notes, no gold); and the write routes (cancel, freeze, refreeze, classify) still accept a request carrying the nonce. Their answers are redacted, and the audit discards a pilot that reaches the companion.
- **Overlap.** `POST /api/agents/grader-sim` and `/author-review` answer 409 while any round runs or a launch is in flight, because their text would be on a command line a pilot can read; a launch answers 409 while one of them is in flight. Each side counts itself in before it checks the other. The service applies the same rule again.
- **Companion port.** After `listen()` the server calls `service.setCompanionPort(port)` when the service has it (anything but 1..65535 is a 400). The store passes it to the audit as `companionPort`.
- **Pilot sign-in.** `createAgentService` takes `pilotToken` (use this token) and `readPilotToken` (replace the Keychain and variable read) for tests; otherwise the store reads the token at every pre-flight (section 3.4). The pre-flight answer carries `signIn`, which the page appends to its "Claude Code is ready" notice. `runCompanion` prints one `Pilot sign-in:` line at start-up (`describePilotSignIn` in `server.cjs`): where the token comes from and which gateway variables are left out, that a stored token cannot be used, or that pilots will be refused because the environment sets a gateway variable and no token is stored. A run's `audit.violations` can carry `tool: "(runtime output)"` (the runner's redaction count) and `tool: "(files)"` (the files scan) with kind `secret`.
- **Test isolation.** The browser test copies the files it needs to a temporary folder and runs the companion from there, so round state is written under that copy and the project's own `private/` folder is neither read nor written.
- **Archived adapter.** `--run-approved-once` still starts the archived one-run analysis, and nothing else does. `LOCAL_SERVER.json` records `modelCallsOnLaunch: 0` unless that flag was given.
