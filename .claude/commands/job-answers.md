---
description: Draft answers for an application form's questions (copy-paste ready)
argument-hint: <paste the form's questions, or job folder + questions>
---

The user is filling out a job application form. `$ARGUMENTS` contains the form's questions
(and possibly a job folder name or tracker id for context). Produce copy-paste-ready answers.

## Sources — in this order

1. `jobsearch/profile/answers.yaml` — logistics fields, reusable answers, STAR stories.
2. `jobsearch/profile/profile.yaml` — facts about experience and skills.
3. The matching `jobsearch/jobs/<folder>/posting.md` and `notes.md` if a job folder exists for
   this application (check `python3 jobsearch/tools/jobsearch.py list` to find it).

If the profile files still contain `STATUS: TEMPLATE`, stop and point the user to `/job-setup`.

## Rules

- For standard fields (contact, work auth, salary, notice, education/employment rows), don't
  re-derive — run `python3 jobsearch/tools/jobsearch.py sheet` and pull from it.
- Respect stated character/word limits; if a limit is given, show the character count.
- Behavioral questions: adapt the best-matching STAR story by theme; name the company/team
  specifics from the posting where they fit naturally.
- "Why us" questions: be specific to the company (use posting.md, or a quick web search for
  recent company news/products) — no interchangeable flattery.
- **Never invent facts** — experience, eligibility, availability, or anything else. If the
  truthful answer to a question is unknown or unfavorable, write `[FILL IN: ...]` with a one-line
  note on how the user might want to handle it, and flag it in your summary.
- Salary questions: use `salary_expectation` from answers.yaml verbatim; if it's empty, mark
  `[FILL IN]` and suggest the user set it via /job-setup rather than improvising a number.
- Write in the user's voice — plain, confident, first person, no clichés ("passionate",
  "team player", "fast-paced environment").

## Output

- Each question followed by its ready-to-paste answer (with char count when limits apply).
- Save the set to `<job folder>/answers.md` when a folder exists, else `jobsearch/out/answers.md`.
- End with the list of `[FILL IN]` items needing the user's input, if any.
- If new reusable answers emerged, offer to save them back into answers.yaml for next time.
