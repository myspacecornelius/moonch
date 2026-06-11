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
  creating drafts.
- A profile file containing the line `STATUS: TEMPLATE` is unfilled — direct the user to
  `/job-setup` instead of working from placeholder data.
- Privacy: as of 2026-06-11 this repo was **public**. Before committing real personal data,
  verify it has been made private (or that the user explicitly accepted gitignore/local-only mode).
- The tracker (`jobsearch/tracker.json`) is only modified through
  `python3 jobsearch/tools/jobsearch.py` (add/set/note/list/show/next) — don't hand-edit it.
- Cloud sessions are ephemeral: after changing profile, tracker, or job folders, commit and push.

## Useful one-liners

```bash
python3 jobsearch/tools/jobsearch.py next     # what the user should do today
python3 jobsearch/tools/jobsearch.py sheet    # form-filling cheat sheet
python3 jobsearch/tools/jobsearch.py render --job <folder>   # rebuild a tailored resume
```
