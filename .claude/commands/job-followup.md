---
description: Draft follow-up / thank-you emails for an application
argument-hint: <tracker id or company name> [context, e.g. "interviewed yesterday with Jane"]
---

Draft a follow-up email for the application in `$ARGUMENTS`. Resolve the application via
`python3 jobsearch/tools/jobsearch.py list` / `show <id>`, and read its job folder
(posting.md, notes.md, history) for specifics.

## Pick the right type from status + context

- **applied, ~1-2 weeks, no response** → short status nudge: reaffirm interest with ONE concrete,
  role-specific reason, offer to provide anything they need. Not needy, not apologetic.
- **after an interview** (same day ideally) → thank-you: reference one actual moment or topic
  from the conversation (ask the user what was discussed if you don't know), reinforce the one
  qualification that matters most, keep the door open. If multiple interviewers, offer one
  variant each — distinct, not find-and-replace copies.
- **recruiter went quiet after a screen** → polite check-in asking about timeline.
- **offer stage** → do not improvise negotiation emails from a template; draft collaboratively
  with the user, anchored on their salary_expectation in answers.yaml and the posted range.

## Rules

- Under 120 words, plain text, no markdown. Subject line included.
- Specific to this company and conversation — if you only have generic material, ask the user
  one question to get a real detail rather than sending filler.
- Never fabricate (meetings that didn't happen, competing offers that don't exist).

## Output

- Show the draft(s) in chat for approval.
- If the Gmail MCP is available (`mcp__Gmail__create_draft`), offer to place it in their Gmail
  drafts — addressed but **never sent**; sending is always the user's click.
- Save to `<job folder>/followup-YYYY-MM-DD.md` and log:
  `python3 jobsearch/tools/jobsearch.py note <id> "follow-up drafted (<type>)"`.
