---
description: Tailor my resume to a specific job posting (creates a job folder with resume + analysis)
argument-hint: <posting URL | file path | pasted posting text>
---

Tailor the user's resume to the job posting in `$ARGUMENTS`.

## Preconditions

Read `jobsearch/profile/profile.yaml`. If it still contains `STATUS: TEMPLATE`, stop and tell the
user to run `/job-setup` first.

## 1. Get and analyze the posting

- If given a URL, fetch it (WebFetch). Greenhouse/Lever/Ashby postings fetch cleanly; LinkedIn and
  Indeed often block — if the fetch fails or returns junk, ask the user to paste the posting text.
- Extract: company, role title, location/remote policy, salary if listed, and the requirements —
  split into must-haves vs nice-to-haves. Identify the exact keywords an ATS would scan for
  (technologies, methodologies, certifications, as literally phrased in the posting).

## 2. Create the job folder

`jobsearch/jobs/YYYY-MM-DD-<company-slug>-<role-slug>/` containing:

- **`posting.md`** — the posting text (cached, postings get taken down) plus your analysis:
  requirements list, ATS keywords, salary/location facts.
- **`resume.yaml`** — the tailored resume, same schema as profile.yaml. Tailoring rules:
  - Select and reorder: lead with the most relevant experience bullets (use `tags`), trim to
    3-5 bullets per role, drop irrelevant projects/extras. Keep it to one page worth of content
    (two only if 10+ years and the posting is senior).
  - Rephrase bullets to mirror the posting's vocabulary where it is truthful to do so (posting
    says "Kubernetes", profile bullet says "k8s" → write "Kubernetes").
  - Rewrite `summary` and reorder `skills` groups toward this role.
  - **Hard rule — never fabricate:** no skills, employers, titles, dates, degrees, or numbers
    that are not in profile.yaml. Emphasis and wording may change; facts may not. If the posting
    wants something the profile lacks, it goes in notes.md as a gap — not into the resume.
- **`notes.md`** — honest fit assessment: estimated fit (strong/decent/stretch and why), keyword
  coverage (covered vs missing), gaps + suggested talking points to address them, and anything
  to verify before applying (salary vs floor, location vs preferences, dealbreakers from
  profile preferences).

## 3. Render and track

- Run `python3 jobsearch/tools/jobsearch.py render --job <folder-name>`.
- Add to tracker: `python3 jobsearch/tools/jobsearch.py add "<Company>" "<Role>" --url <url> --folder jobsearch/jobs/<folder> --status tailored`
  (or `set` if an entry for this posting already exists — check `list` first).
- Send `resume.html` to the user with SendUserFile.

## 4. Report

Summarize: fit assessment, what you changed vs the master resume and why, keyword coverage,
honest gaps. Offer `/job-cover` for the cover letter and `/job-answers` when they have the
application form open. If working in a cloud session, commit and push the new folder.
