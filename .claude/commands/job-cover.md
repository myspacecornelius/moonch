---
description: Write a cover letter for a tailored job application
argument-hint: <job folder name or tracker id> [tone/extra context]
---

Write a cover letter for the application identified by `$ARGUMENTS` (a folder under
`jobsearch/jobs/`, or a tracker id — resolve via `python3 jobsearch/tools/jobsearch.py show <id>`).
If no job folder exists yet, run the /job-tailor flow first or ask for the posting.

## Inputs

Read the job folder's `posting.md`, `resume.yaml`, and `notes.md`, plus
`jobsearch/profile/profile.yaml` for any extra detail. The letter must only claim what these
files support — same no-fabrication rule as everywhere in this toolkit.

## The letter

Max 250-300 words, three paragraphs:

1. **Hook** — why this company/role specifically. One concrete, current reason (their product,
   a launch, the team's problem space from the posting) — not "I was excited to see your posting".
2. **Evidence** — map the user's 2-3 strongest, most relevant outcomes (real numbers from
   resume.yaml) onto the posting's top requirements. If notes.md lists a significant gap the
   reviewer will notice, address it in one confident sentence rather than hoping it goes unseen.
3. **Close** — short, specific, forward-looking. No begging, no "I look forward to hopefully...".

Voice: plain, direct, first person. Ban the clichés: "passionate", "team player", "perfect fit",
"dynamic", "fast-paced", "I believe my skills". Vary sentence length. It should read like a
sharp human wrote it in one sitting.

## Output

- Save to `<job folder>/cover.md` and a plain `cover.txt` (no markdown) for paste-into-form use.
- Show the letter in chat and offer one alternative angle for the hook in case the user
  prefers it.
- Log it: `python3 jobsearch/tools/jobsearch.py note <id> "cover letter drafted"`.
