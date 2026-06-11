# Jobsearch Autofill — Chrome extension

Fills job application forms (Greenhouse, Lever, Ashby, and most label-based forms) from
your jobsearch profile. Highlights what it filled (green) and what needs your attention
(orange). **It never submits** — reviewing and clicking submit is always you.

## Install (once)

1. Get this repo onto the machine running Chrome (`git clone` / `git pull`).
2. Chrome → `chrome://extensions` → toggle **Developer mode** (top right).
3. **Load unpacked** → select the `jobsearch/extension/` folder.

## Load your data (whenever it changes)

1. Generate the data bundle: `python3 jobsearch/tools/jobsearch.py export`
   → writes `jobsearch/out/autofill.json` (gitignored — it contains your personal data).
2. Click the extension icon → **Import** → pick `autofill.json`.
   It's stored in the extension's local storage (`chrome.storage.local`), never sent anywhere.

Re-run export + re-import after tailoring new applications or editing your profile.

## Use

1. Open a job application form.
2. Click the extension icon, pick which application this is (loads its cover letter), hit
   **Fill this form**.
3. Green outline = filled; orange = needs you (file uploads, unanswered questions, custom
   essays). The popup lists both.
4. Attach your resume PDF manually (browsers don't allow extensions to attach local files
   for you — that's a security feature, not a bug).
5. Review every field — you're certifying this information — then submit.

Quick-copy chips (email, LinkedIn, salary, etc.) cover any field the matcher missed, and
the **Copy cover letter / Copy resume (text)** buttons handle paste-into-box forms.

## What it deliberately does NOT do

- No auto-submit. Ever.
- No guessing: questions whose answers aren't in your `answers.yaml` are flagged orange,
  not invented. (Custom essay questions: paste them to `/job-answers` in Claude Code.)
- No background access: it only touches a page when you click Fill (activeTab permission),
  and your data never leaves the browser.

## Known limits

- Embedded forms inside cross-origin iframes may be unreachable — open the ATS posting
  directly (the `posting.md` link) and fill there.
- Workday and other multi-step wizard ATSs are only partially covered: fill each step,
  use the chips for the rest.
- Date-picker widgets that aren't real `<input type="date">` fields usually need a manual
  click-through.
