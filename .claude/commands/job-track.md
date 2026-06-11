---
description: Manage my application pipeline (add, update status, list, what's next)
argument-hint: [e.g. "applied to #3" | "list" | "what's next" | "add Acme - Staff Eng <url>"]
---

Manage the application tracker based on the user's intent in `$ARGUMENTS`. The tracker is
`jobsearch/tracker.json`, operated through the CLI (never edit the JSON by hand):

```
python3 jobsearch/tools/jobsearch.py add "<Company>" "<Role>" [--url U] [--folder F] [--status S] [--note N]
python3 jobsearch/tools/jobsearch.py set <id> [--status S] [--url U] [--folder F] [--note N]
python3 jobsearch/tools/jobsearch.py note <id> "<text>"
python3 jobsearch/tools/jobsearch.py list [--all | --status S]
python3 jobsearch/tools/jobsearch.py show <id>
python3 jobsearch/tools/jobsearch.py next
```

Statuses: `found → tailored → applied → interview → offer`, terminal: `rejected`, `archived`.

## Interpreting the user

- "applied to Acme" / "applied to #3" → `set <id> --status applied` (find the id via `list` if
  they gave a company name). Stamp useful notes: where they applied, any confirmation number.
- "got an interview", "rejected", "they made an offer" → corresponding `set --status`, with the
  details as `--note` (interview date/time, format, interviewer names if mentioned).
- "list" / "where am I" / "status" → `list`, then summarize the pipeline in one or two sentences
  (counts per stage, anything stale).
- "what's next" / no arguments → `next`, plus your own read: which application deserves attention
  first and why. Mention `/job-followup` for stale applied ones and `/job-find` if the top of the
  funnel is empty.
- Anything with a date the user must not miss (interview, deadline) → repeat it back explicitly
  in your summary.

After any change in a cloud session, commit and push `jobsearch/tracker.json` (and any job
folders touched) so the state survives the ephemeral container.
