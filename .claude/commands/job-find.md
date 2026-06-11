---
description: Search the web for job postings matching my profile preferences
argument-hint: [optional focus, e.g. "fintech, staff level, posted this week"]
---

Find current job postings that match the user's profile. Extra focus/constraints: `$ARGUMENTS`.

## Inputs

Read `jobsearch/profile/profile.yaml` — especially `preferences` (target_titles, locations,
remote, salary_floor, industries, dealbreakers) and `skills`/recent `experience` to judge fit.
If the file still contains `STATUS: TEMPLATE`, stop and point the user to `/job-setup`.
Read `jobsearch/tracker.json` so you don't re-suggest postings already tracked.

## Search strategy

Use WebSearch with several query shapes, not just one:
- ATS-hosted postings fetch reliably — bias toward them:
  `site:boards.greenhouse.io <title> <location>`, `site:jobs.lever.co ...`,
  `site:jobs.ashbyhq.com ...`, `site:job-boards.greenhouse.io ...`
- `"<target title>" job <key skill> <location/remote> posted` for the open web.
- If the user named companies or industries, search their careers pages directly.
- LinkedIn/Indeed results usually can't be fetched — skip them unless nothing else surfaces,
  and then just report the link.

WebFetch the promising ones to confirm they're real, current, and to extract requirements.

## Scoring and output

For each candidate, judge against the profile: title match, must-have requirements the user
meets/misses, location/remote fit, salary vs salary_floor (when listed), dealbreakers.

Present the top 5-10 as a ranked list: company — role — location/remote — salary if listed —
link — one line on why it fits and one on the biggest gap or unknown. Be honest about stretch
roles; don't pad the list with weak matches to hit a count.

## Follow-through

Ask which ones to pursue. For each chosen posting:
`python3 jobsearch/tools/jobsearch.py add "<Company>" "<Role>" --url <url> --status found`
— then offer to run the /job-tailor flow on the best one right away.
