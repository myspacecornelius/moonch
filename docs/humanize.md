# Humanize: an orchestrator and its network of workers

`src/humanize/` takes one field of text and returns one final text field. In between, workers run in lock step. A secretary reads the source first. Verva rewrites masked chunks. Repair workers put back anything that slipped. GPTZero signs off each chunk. Every stage finishes for every chunk before the next stage starts, and each field of workers returns its results in chunk order. The output never depends on timing. With `workers: 1` every call runs one after the other.

It runs **on its own**, with no Studio and no companion (`npm run humanize`). It also runs **alongside the Studio**: the companion mounts it at `/api/humanize`, and the Humanize page sits under *Writing* in the sidebar. Both use the same code.

```
            ┌────────────┐
 text ────▶ │ secretary  │  terminology lock · noun-verb map · fact ledger with each figure's basis
            └─────┬──────┘  chunks (prose / other / fixed) · every figure and locked term masked (K01, K02 …)
                  ▼
            ┌────────────┐
            │ sign-off   │  pass 0: GPTZero scans each chunk as written; a chunk already at its bar is deposited
            └─────┬──────┘
   per round, up to 3 passes per chunk:
                  ▼
   ┌──────────────────────────┐   ┌──────────────────┐   ┌──────────────────────┐
   │ rewriters (Verva, n)     │──▶│ repair (n)       │──▶│ sign-off (GPTZero, n)│──▶ ≥ bar: deposited in the final text
   │ whole chunk, then only   │   │ facts, basis,    │   │ prose 90 %, other 70 %│
   │ flagged spans (≥ 0.80)   │   │ subject, negation│   └──────────┬───────────┘
   └──────────────────────────┘   │ direction, swaps │              │ < bar after 3 passes
                                  └──────────────────┘              ▼
                         aggregate (word-weighted mean of every chunk's best reading) ≥ 80 %? ── yes ─▶ done
                                                                    │ no
                                                                    ▼
                         resplice the chunks that missed their bar and go round again (at most 3 rounds)
```

## Running it

On its own:

```bash
npm run humanize -- config --verva-url "https://<the Verva humanizer page>"
```

```bash
npm run humanize -- sign-in
```

```bash
npm run humanize -- run --in draft.txt --out final.txt --report report.json --yes
```

- `--rewriter stub --detector stub` is an offline dry run: nothing leaves the computer and no account is needed. The stub detector's numbers are an **estimate**, and a run scored by it is never signed off.
- `brief --in draft.txt` prints the secretary's brief and nothing else (no browser, no network).
- `--passes`, `--rounds` and `--workers` change the defaults (3, 3, 1). `--headless` runs Verva's Chrome without a window.
- Exit codes: 0 when the aggregate reached its bar; 1 when it ended below the bar, stalled or hit a call cap; 2 for a usage or setup error; 3 when Verva asks for a sign-in; 130 after Ctrl-C (the best version so far is still written).

In the Studio, run `npm start` and open **Humanize**. The page shows whether a GPTZero key was found, whether the Verva address is set, whether Chrome was found, and the sign-in state. It then takes the text, the two worker choices, passes, rounds and workers, and the acknowledgement. While a run goes, it shows each chunk's passes and the final text field, with Copy and Download.

## Setup

- **GPTZero key.** Set `GPTZERO_API_KEY` before `npm start` or the CLI, or on macOS store it in the Keychain: `security add-generic-password -a "$USER" -s finance-studio-gptzero-key -w`. The companion moves the variable out of its own environment before the agent service exists, so a pilot never inherits it. Chrome gets an allow list of variables, so it never sees the key either. The key is never written to disk, logged, or put in an answer or an error.
- **Verva.** Set the address of Verva's humanizer page on the Humanize page, with `config --verva-url`, or with `FINANCE_STUDIO_VERVA_URL`. It must be `https://`. Then sign in once with *Sign in to Verva* (or `sign-in`). A separate Chrome window opens on the worker's own profile (`private/humanize/verva-profile`, 0700). That window has **no debugging channel**, so nothing in the Studio can read the page or your keystrokes. Closing it with *Done signing in* keeps the sign-in.
- **When the page is not found.** Verva has no published interface, so the worker finds the text box, the button and the result on the page itself. If it picks the wrong ones, pin them as CSS selectors (`input`, `button`, `output`) on the page or in `private/humanize/verva.json`. Set `minWords` there if Verva refuses short inputs.

## The rules

| | |
|---|---|
| Prose chunk bar | 90 % human (GPTZero `class_probabilities.human`) |
| Other chunk bar | 70 % (bullets and figure-heavy lines) |
| Run bar | 80 %: the word-weighted mean of every chunk's best reading |
| Passes per chunk per round | 3 (at most 5) |
| Rounds | 3 (at most 6). Two rounds in a row without a gain stop the run (`stalled`) |
| Flagged span | a sentence GPTZero reads at `generated_prob` ≥ 0.80. After the first reading only those go back to Verva, widened to `minWords` |
| Length | a rewritten segment more than 15 % longer or shorter than its source is rejected |
| Call caps | 200 rewriter calls and 200 scans per run (`budget`) |

**Chunks.** A paragraph or bullet of at least 12 words (15 for a bullet), with fewer than 12 figures per 100 words, is *prose*. Any other paragraph or bullet is *other*: short or figure-heavy lines, grouped into runs of up to 220 words. Headings, tables, code, quotes, rules and blocks under four words are *fixed*: they ship exactly as written and are never sent anywhere. Prose paragraphs under 40 words merge with the next one. A paragraph over 220 words is cut at sentence boundaries. Joining every segment gives back the source byte for byte.

**Resplicing.** A chunk that used its passes without reaching its bar is respliced for the next round. A chunk of several paragraphs or bullets becomes one chunk per paragraph, each with its own passes. A single paragraph goes back to Verva from its source. The best version of every chunk is kept across rounds, and a chunk that reached its bar is never touched again.

**Scans.** A text a chunk already had scanned is not scanned again; the earlier reading stands.

## The secretary's brief

- **Fact ledger.** Every figure with its basis: `currency` ($4.1m, ($1.2m), USD 5bn), `percent` (12%, 8–10%, 3 pp), `bps`, `multiple` (3.5x, 2.0–2.5x), `ratio`, `date`, `period` (Q3 2025, FY2026, 1H25), `year` and `number`. Any digit it does not recognise is still masked as a number.
- **Terminology lock.** Defined terms (`(the "Company")`, locked wherever they appear), acronyms, proper names and capitalised phrases, quoted phrases and file names. All are masked. Repeated lower-case finance phrases (`operating margin`) are *watched*: they are not masked, and a rewrite that uses them fewer times gets a note.
- **Noun-verb map.** For each clause that carries a figure: the subject it describes, the verb it hangs on, whether that verb points up or down, and whether the clause is negated.

## What the repair workers hold a rewrite to

Each returned segment is checked against its frozen source, on masked text, where every key names one place in the source.

- **Inventory.** Every key appears exactly once. No key comes from another paragraph or bullet, no key was never sent, and no digit sits outside a key.
- **Basis.** The word after a figure and the symbol before it still give it its basis. A percent gains no "x", and no "million" is added to a number that had none.
- **Binding.** The figures of one clause stay in one sentence with their subject. The negation is unchanged, the verb does not point the other way, and two figures that described two subjects are each still nearest their own (a swap).
- **Voice.** No first person where the source had none.
- **Logic.** With the same number of sentences, each sentence keeps its source sentence's negation. Otherwise a changed count of negations is a note.

A slip is repaired by splicing the whole source sentence back in. The rewriter's other sentences stay. A slip that cannot be placed, an unknown key, or a length outside the limit rejects the pass: the chunk keeps its previous text, and the rejected text is never scanned. A locked term retyped in another letter case is written back the locked way.

**What the gate cannot catch.** It is a tripwire on figures, bases, subjects, negations and directions, not a reading of meaning. A sentence can still say something else with every figure in place. The run lists the chunks whose shipped text carries a note (`first-person`, `negation-count`, `terminology`), and a person should read them.

## Statuses

`passed` (the aggregate reached its bar; `signedOff` is true only when GPTZero did the reading), `below-bar`, `stalled`, `budget`, `cancelled`, `needs-sign-in`, `failed`. Whatever the status, `final` is the document assembled from the best version of every chunk that passed the gate, or from the source where none did. Nothing is edited after its last scan.

## What leaves the computer

- **To Verva:** masked chunks only. Every figure and locked term is a placeholder, so Verva never sees a figure, a name or a quote.
- **To GPTZero:** the unmasked text of each chunk.

The CLI needs `--yes` and the page needs the acknowledgement before a run with either. Check that Verva's terms allow automated use of your account.

The Chrome the worker drives follows the link loader's rules (`backend/links/chrome.cjs`). It uses its own profile, never yours. The DevTools protocol runs over the pipe only, with no port. Downloads are denied, and the profile's history is forgotten after every close. Page code runs in an isolated world and is never built from strings.

While any round of pilots runs, every humanize answer from the companion is redacted, the same way pipeline answers are: the source and final text, each chunk's text, the brief, the log lines and the gate's reasons become `{ withheld: true }`. Starting a run, changing the Verva settings, and opening the Verva sign-in are all refused with 409 while a round runs. A pilot that reaches the companion therefore cannot make it send text to Verva or GPTZero.

Finished runs are kept in `private/humanize/runs/<id>.json` (0600), and the CLI's `--report` is also 0600. `private/` is ignored by git.

## Companion routes

| Route | |
|---|---|
| `GET /api/humanize` | `{ runs, running, config }`. `config` holds the bars, the limits, the workers, the acknowledgement, whether a GPTZero key was found (never the key), and the Verva worker's state |
| `POST /api/humanize/start` | `{ text, rewriter: verva\|stub, detector: gptzero\|stub, maxPasses?, maxRounds?, workers?, acknowledgements }` → `{ id }`. One run at a time (409) |
| `GET /api/humanize/:id` | the run's view |
| `POST /api/humanize/:id/stop` | stops it; the best version so far is the final text |
| `POST /api/humanize/verva/config` | `{ url?, input?, button?, output?, minWords?, headless? }` |
| `POST /api/humanize/verva/sign-in`, `/sign-in/done` | the separate sign-in window |

Every POST carries the nonce, the Origin and the JSON type, like every other companion route. Errors use the same mapping.

## Files

`constants.cjs` (the bars and limits), `text.cjs` (sentences, tokens, blocks), `secretary.cjs`, `chunks.cjs`, `mask.cjs`, `repair.cjs`, `pool.cjs` (a field of workers), `orchestrator.cjs`, `providers/` (`verva-web.cjs`, `gptzero.cjs`, `stub.cjs`), `keys.cjs`, `service.cjs` and `redact.cjs` (for the companion), `cli.cjs` and `index.cjs`. The page is `humanize.js` and `humanize.css` at the root, next to the other pages.

Tests: `tests/humanize.test.cjs` runs in `npm test`, with no network and no browser. `tests/humanize-browser.cjs` (`npm run test:humanize`) drives the Verva worker in a real headless Chromium against fake Verva pages: streaming results, a contenteditable editor, pinned selectors, a sign-in wall, an out-of-credits message, a full run, the pipe-only Chrome, and no key in Chrome's environment.

## Known gaps

- Verva's real page has not been driven yet. The worker was built and tested against fake pages that behave like a humanizer page. The first run against Verva may need the selectors pinned, or `minWords` set.
- If Verva returns exactly the text it returned for the same input last time, the worker cannot tell it is new, and waits until `resultTimeoutMs`.
- The 80 % run bar is the word-weighted mean of the chunk scans, not one scan of the whole document. A whole-document scan with every figure in place reads far more machine-like than its parts.
- GPTZero's API has a quota per key. The call caps are this tool's own caps and do not know about it.
