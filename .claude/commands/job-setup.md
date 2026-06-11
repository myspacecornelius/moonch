---
description: One-time setup — build the master profile and answers bank from my real resume
argument-hint: [path to resume file, or leave empty to paste/import]
---

Set up the job-search toolkit's data files from the user's real resume. Files to fill:
`jobsearch/profile/profile.yaml` (master resume data) and `jobsearch/profile/answers.yaml`
(application answers bank). The schema is documented by comments inside each file — read both first.

## Step 0 — Privacy gate (do not skip)

These files will hold personal data. Check whether this repo is public (GitHub MCP
`search_repositories` for the repo, or ask the user). If it is public, STOP and give the user
two options before writing any real data:
1. **Recommended:** make the repo private (GitHub → Settings → Danger Zone → Change visibility),
   then continue. Data persists across cloud sessions.
2. Keep the repo public but add `jobsearch/profile/`, `jobsearch/jobs/`, `jobsearch/out/`, and
   `jobsearch/tracker.json` to `.gitignore` — warn clearly that in cloud sessions the data will
   NOT persist (fresh clone each session) so this only works for local use.

## Step 1 — Get the source material

Use `$ARGUMENTS` as a file path if given. Otherwise offer, in order:
- paste the resume text into the chat,
- a file path in the repo,
- import from Google Drive (if `mcp__Google_Drive__search_files` is available, search for
  "resume" and let the user pick).

## Step 2 — Fill profile.yaml

- Transfer every fact faithfully. **Never invent, inflate, or guess** employers, titles, dates,
  skills, degrees, or numbers. If something is unclear, ask.
- Ask short follow-ups to strengthen weak spots: missing metrics on bullets ("how many users /
  how much faster / what scale?"), missing dates, skills used but not listed.
- Encourage MORE bullets per recent role than a one-page resume holds (6-10) — tailoring selects
  from them later.
- Interview briefly for the `preferences` section (target titles, locations, remote, salary floor,
  dealbreakers).
- Delete the `STATUS: TEMPLATE` line from the file header once filled.

## Step 3 — Fill answers.yaml

- Logistics fields: ask directly (work authorization, sponsorship, relocation, start date, notice
  period, salary expectation, default "how did you hear about us").
- Draft 4-6 STAR stories: propose candidates from the resume's strongest bullets, then ask the
  user to confirm details. Cover varied themes (leadership, conflict, failure, ambiguity, deadline).
- Draft the reusable question answers WITH the user, in their voice.
- Delete the `STATUS: TEMPLATE` line once filled.

## Step 4 — Validate

Run `python3 jobsearch/tools/jobsearch.py render` and send the generated
`jobsearch/out/resume.html` to the user with SendUserFile so they can check the master resume
renders correctly. Fix anything that looks off. Also run
`python3 jobsearch/tools/jobsearch.py sheet` to show them their form-filling cheat sheet.

## Step 5 — Persist

If privacy was resolved in favor of committing (private repo): commit and push the filled files,
since cloud session containers are ephemeral. If the user chose gitignore mode, remind them the
files live only in this session/machine.
