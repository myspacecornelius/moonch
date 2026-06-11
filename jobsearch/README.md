# Job Search Toolkit

A Claude Code-powered job search assistant. Your resume data lives in one YAML file;
slash commands do the intelligent work (tailoring, cover letters, form answers); a small
Python CLI does the deterministic work (rendering, tracking). No API keys needed — Claude
Code itself is the engine.

## ⚠️ Privacy first

This toolkit stores your personal data (resume, salary expectations, application history)
inside the repo so it persists across sessions. **Make this repo private before running
`/job-setup`.** If it must stay public, setup will offer a gitignore mode instead (data
won't persist across Claude Code cloud sessions, which clone fresh each time).

## Quick start

1. Make the repo private (GitHub → Settings → change visibility).
2. In Claude Code, run **`/job-setup`** and paste your current resume — it builds your
   master profile and answers bank interactively.
3. Then the daily loop:

| Command | What it does |
|---|---|
| `/job-find` | Searches the web for postings matching your preferences, ranks by fit |
| `/job-tailor <url>` | Builds a tailored resume for one posting + honest fit/gap analysis |
| `/job-cover <folder>` | Cover letter grounded in the tailored resume |
| `/job-answers <paste questions>` | Copy-paste-ready answers for application form questions |
| `/job-track <anything>` | "applied to #3", "what's next", "list" — pipeline management |
| `/job-followup <id>` | Follow-up / thank-you email drafts (can drop into Gmail drafts) |

A typical application: `/job-tailor <posting url>` → review `resume.html`, print to PDF →
open the company's form, run `/job-answers` with the form's questions pasted in → submit →
`/job-track applied to #N`. A week later `/job-track what's next` will tell you to
`/job-followup`.

## The CLI (no Claude needed)

```bash
python3 jobsearch/tools/jobsearch.py list            # pipeline at a glance
python3 jobsearch/tools/jobsearch.py next            # what needs action
python3 jobsearch/tools/jobsearch.py sheet           # copy-paste cheat sheet for form fields
python3 jobsearch/tools/jobsearch.py render          # master resume → HTML + ATS txt
python3 jobsearch/tools/jobsearch.py render --job 2026-06-11-acme-staff-eng
python3 jobsearch/tools/jobsearch.py add "Acme" "Staff Engineer" --url https://...
python3 jobsearch/tools/jobsearch.py set 3 --status applied --note "via Greenhouse"
```

Requires Python 3 and PyYAML (`pip3 install pyyaml`).

## Layout

```
jobsearch/
├── profile/
│   ├── profile.yaml      # master resume — single source of truth, tailored resumes are subsets
│   └── answers.yaml      # logistics, reusable answers, STAR story bank
├── jobs/                 # one folder per application (posting, tailored resume, cover, answers, notes)
├── out/                  # renders of the master resume (gitignored)
├── tracker.json          # application pipeline (managed via the CLI)
└── tools/jobsearch.py    # tracker + renderer + cheat sheet CLI
```

## Ground rules baked into every command

- **Nothing is ever fabricated.** Tailoring selects, reorders, and rephrases what's in
  profile.yaml — it never adds skills, employers, dates, or numbers. Gaps between you and a
  posting are listed honestly in `notes.md` with talking points, not papered over.
- **Nothing is ever sent on your behalf.** Emails land in drafts at most; applications are
  always submitted by you.
- Resume PDFs: open `resume.html` in a browser → Print → Save as PDF. The layout is
  single-column and ATS-friendly; `resume.txt` is for paste-into-form fields.
- Cloud sessions are ephemeral: commit and push after profile/tracker changes (the commands
  do this for you).
