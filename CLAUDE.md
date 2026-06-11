# moonch

Two independent parts:

- `src/` — legacy web-crawler demo (Apollo.io API, BeautifulSoup, Selenium). Untouched by the rest.
- `jobsearch/` — the owner's job-search toolkit, driven by the `/job-*` slash commands in
  `.claude/commands/`. Read `jobsearch/README.md` before working on it.

## Job-search toolkit — rules that always apply

- `jobsearch/profile/profile.yaml` is the single source of truth for resume facts.
  **Never fabricate or inflate** resume content: tailored resumes (`jobsearch/jobs/*/resume.yaml`)
  may select, reorder, and rephrase facts from the master profile — never add skills, employers,
  titles, dates, degrees, or numbers that aren't there. Posting requirements the profile can't
  meet are recorded as gaps in `notes.md`, not written into the resume.
- Never send anything (emails, applications) on the user's behalf. Gmail integration stops at
  creating drafts. The Chrome extension (`jobsearch/extension/`) auto-FILLS application forms
  from `jobsearch.py export` data but must never auto-submit or auto-consent — keep it that way.
- A profile file containing the line `STATUS: TEMPLATE` is unfilled — direct the user to
  `/job-setup` instead of working from placeholder data.
- Privacy: this repo is **public** and on 2026-06-11 the user chose **local-only mode**:
  `jobsearch/profile/profile.yaml`, `answers.yaml`, `tracker.json`, and `jobsearch/jobs/` are
  gitignored — NEVER commit them while the repo is public. Sanitized templates live in
  `jobsearch/profile/*.example.yaml`. In a fresh session those gitignored files won't exist:
  ask the user to re-upload their resume and re-run `/job-setup` (or to make the repo private,
  remove the gitignore entries, and switch to committed mode).
- The tracker (`jobsearch/tracker.json`) is only modified through
  `python3 jobsearch/tools/jobsearch.py` (add/set/note/list/show/next) — don't hand-edit it.
- Cloud sessions are ephemeral: after changing profile, tracker, or job folders, commit and push.

## Useful one-liners

```bash
python3 jobsearch/tools/jobsearch.py next     # what the user should do today
python3 jobsearch/tools/jobsearch.py sheet    # form-filling cheat sheet
python3 jobsearch/tools/jobsearch.py render --job <folder>   # rebuild a tailored resume
```
