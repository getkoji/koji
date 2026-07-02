---
name: schema-loop
description: Iterate on a Koji extraction schema from the terminal — when a document doesn't extract correctly, fix the schema and backtest it against the corpus for regressions. Use whenever the user wants to improve a schema, debug a bad extraction, tighten a field, add a doc to the corpus, or asks to "test/validate/iterate on" a schema against real documents on the connected platform.
allowed-tools: Bash(koji:*) Bash(eval:*) Read Edit Write
---

# Schema loop — improve a Koji schema and backtest it

This is the **industry inner loop**: a document doesn't extract correctly → fix the
schema → prove the fix didn't regress anything else → repeat. It runs against a
**connected Koji platform** (the same data the dashboard's Build / Validate / Corpus
tabs use), driven entirely from the CLI so you can run it without the UI.

For the **academic** path (batch-scoring a local 1000-doc corpus), use `koji bench`
instead — that's a different, file-based world and not what this skill is for.

## Prerequisites

- Authenticated: `koji whoami` should show a server. If not, the user runs `koji login`
  (or sets `KOJI_API_URL` + `KOJI_API_KEY`). Use `--profile <name>` to target a tenant.
- You know the **schema slug** and have its **local YAML file** (usually `schemas/<slug>.yaml`).
  If there's no local file, `koji pull` it first so edits can be pushed.

## The commands (all take `--json`)

Always pass `--json` and parse the result — don't scrape the table. Key shapes:

- `koji validate <schema> --json` → `{ overallAccuracy, prevAccuracy, docsPassed, docsTotal,
  version, bump, deduped, fields: [{name, accuracy, prevAccuracy, status: "pass"|"regressed"|"failing",
  failingDocs: [{filename, expected, got, confidence, routingDiagnosis?}]}], failingDocs: [{filename, failedFields}] }`.
  Snapshots the local YAML as a release **candidate** (`v0.0.4-rc.N`, deduped by content),
  then re-extracts every corpus doc with ground truth and scores it. **The candidate is NOT
  made live** — iterating never touches the schema production pipelines run. `--bump
  major|minor|patch` overrides the auto-derived bump; `--no-push` validates the live server
  version instead; `--check` exits non-zero if any field regressed.
  - **`--explain`** (or read `fields[].failingDocs[].routingDiagnosis` from `--json`) is the
    single most important diagnostic. For every failing field it reports **why** it failed:
    `{ source, answerInRoutedChunks, chunks: [{index, title}] }`.
    - `source` — how the chunks were selected: `hint` | `signal_inferred` | `broadened` |
      `fallback` | `full_document`. `broadened`/`fallback` mean routing found no signal and
      guessed — a smell.
    - `answerInRoutedChunks` — **the key field.** `false` ⇒ the correct answer was never in the
      chunks the model saw. This is a **routing miss**: no prompt tweak and no bigger model can
      fix it — you must change *which chunks reach the field* via `hints`. `true` ⇒ the model saw
      the answer and still got it wrong — a prompt/description problem. `null` ⇒ couldn't
      determine (non-scalar value, or the read-only `GET` path with no fresh routing data).
- `koji schema versions <schema> --json` → released lineage + candidates with scores and which
  is live. `koji schema promote <schema> [--version v0.0.4-rc.7] [--require-no-regressions]`
  graduates a candidate to a release and makes it live (gated by `schema:deploy`). `koji schema
  release <schema>` releases directly, skipping the rc loop (early-stage / empty corpus).
- `koji run <schema> <doc> --json` → `{ extracted: {field: value}, confidence_scores: {field: 0..1},
  provenance, model, pages }`. One-doc extraction with the **local** schema (no version pushed).
  `<doc>` is a corpus-entry id (prefix ok) or a filename (substring ok).
- `koji corpus ls <schema> --json` → `[{id, filename, hasGroundTruth, tags, source}]`.
  Filters: `--no-gt`, `--gt`, `--tag <t>`.
- `koji corpus diff <schema> <doc> --json` → `{fields: [{field, expected, got, match}]}`.
  Latest stored extraction vs ground truth; `--run` extracts fresh first.
- `koji corpus get <schema> <doc> -o <path>` → download the **source file** so you can `Read`
  it yourself (PDFs/images included). `--markdown` writes the parsed text instead. This is how
  you check what a document actually says.
- `koji corpus rm <schema> <doc> [--yes]` → remove a doc from the corpus (soft-delete, recoverable
  via `corpus add`). Use it when a document isn't really this schema's type and is skewing the
  scores — don't burn iterations tuning against a doc that doesn't belong.
- `koji corpus add <schema> <file>` → upload a document into the corpus.
- `koji corpus gt show <schema> <doc> --json` → current ground truth.
- `koji corpus gt accept <schema> <doc>` → promote the doc's latest `koji run` extraction to
  ground truth (use only when that extraction is verified correct).
- `koji corpus gt set <schema> <doc> --from truth.json` → set ground truth from a JSON file.

## The loop

### 0. Establish a baseline
Run `koji validate <schema> --no-push --json` and record `overallAccuracy` and each field's
accuracy. This is what you must not regress.

### 1. Bring the problem doc into the corpus
If the failing document isn't already a corpus entry: `koji corpus add <schema> <file>`, then
find it with `koji corpus ls <schema> --json`.

### 2. See what the schema currently does with it
`koji run <schema> <doc> --json`. Compare `extracted` to what the correct answer should be.
Identify which fields are wrong and *why* (wrong value, hallucinated, missed, wrong type).

### 3. Make sure the doc has correct ground truth
A doc can only be backtested if it has ground truth, and the ground truth must itself be correct —
don't trust it blind.
- `koji corpus gt show <schema> <doc> --json` — is there ground truth, and is it right?
- **When the extraction and ground truth disagree, adjudicate against the document — don't
  guess which side is right.** Download it and read it yourself:
  `koji corpus get <schema> <doc> -o /tmp/doc.pdf` then `Read` the file (or `--markdown` and
  read/grep the parsed text). Find what the document actually says for the disputed field.
  - If ground truth is wrong, fix it: write the correct values to a JSON file and
    `koji corpus gt set <schema> <doc> --from truth.json`.
  - If ground truth is right and the extraction is wrong, that's a real schema miss — go to step 4.
  - If the document is genuinely ambiguous (e.g. it contains both an abbreviated and a full legal
    name), decide the canonical answer, set it as ground truth, and capture the rule in the field's
    schema `description` so extraction matches it going forward. Surface the ambiguity to the user.
- Only use `gt accept` when the latest extraction is already verified correct — never rubber-stamp
  a wrong extraction as truth.

### 4. Classify the failure, THEN fix the right lever
**Don't reach for a bigger model as a reflex.** Most extraction failures are one of two very
different classes, and only one of them is a model problem. Run `koji validate <schema> --explain`
(or read `routingDiagnosis`) and branch on `answerInRoutedChunks` for each failing field:

**A. Routing miss (`answerInRoutedChunks: false`, or `source: fallback`/`broadened`).**
The model never saw the answer — the router sent the wrong chunks. A bigger model cannot fix
this; it can only misread text it isn't given. The fix is to steer routing via the field's
`hints` in the YAML:
- `look_in: [<category>]` — hard-restrict the field to chunks of a given category (needs
  `categories.keywords` defined so chunks get classified). Strongest routing lever.
- `prefer_contains: ["<phrase>"]` — bias toward chunks whose text contains an anchor phrase near
  the value (e.g. a label that sits beside it).
- `patterns: ["<regex>"]` — bias toward chunks matching a shape (e.g. a date or currency pattern).
- `prefer_position: top|bottom` — bias toward the start/end of the document.
- `max_chunks: <n>` — widen how many chunks the field is allowed to see (default 3) when the
  answer sits just outside the top-scoring chunks.
Confirm the fix moved the needle by re-checking `routingDiagnosis` — `answerInRoutedChunks` should
flip to `true` before you expect the value to be correct.

**B. Model misread (`answerInRoutedChunks: true`).**
The right chunk reached the model and it still got the value wrong. NOW it's a
prompt/description/type problem — and only here is a model change even a candidate:
field `description` (the strongest lever — make it unambiguous), `type`, `required`, enum values /
aliases in a `compare` section, `extraction_hint`. **A bigger model is a last resort**, tried only
after the description is already unambiguous and the answer demonstrably reached the model.

Edit `schemas/<slug>.yaml`. Make **one focused change at a time** so you can attribute the effect.
Keep every fix schema-side, never engine-side.

### 5. Backtest
`koji validate <schema> --json`. Read the result and judge:
- Did the target doc's failing fields move to `pass`? (check `fields[].failingDocs` / `failingDocs`)
- **Did anything regress?** Any field with `status: "regressed"`, or `overallAccuracy` below the
  baseline from step 0, is a regression. A fix that improves the target doc but regresses another
  is **not** acceptable — refine or revert the change and try a narrower one.

### 6. Repeat
Loop steps 4–5 until the target doc passes **and** `overallAccuracy >= baseline` with zero
regressions. For tight iteration on one doc, `koji run` (step 2) is faster than a full validate;
use it to check a single doc, then `koji validate` to confirm no collateral damage.

### 7. Promote, then report
Once the target doc passes with zero regressions, **promote** the winning candidate to make it
live: `koji schema promote <schema> --require-no-regressions`. Until you promote, every validate
ran against a candidate and the live schema is unchanged — promotion is the one step that affects
production pipelines. Then summarize: which fields were failing, what schema change fixed them,
the before/after `overallAccuracy`, the released version, and confirm zero regressions.

## Guardrails

- **Never ship a regression.** A higher target-doc score that lowers overall accuracy or
  regresses another field is a failure, not a win. Default to the narrowest schema change.
- **Keep fixes in the schema, not the engine.** If a fix seems to need engine changes, stop and
  flag it — that's a separate `oss` task, and the engine must stay document-type-agnostic.
- **Don't blanket-recommend a bigger model.** "Try a higher model" is only justified for fields
  where `routingDiagnosis.answerInRoutedChunks` is `true` (the model saw the answer and misread
  it) *and* the field `description` is already unambiguous. If the answer never reached the model
  (`false`), a model upgrade is wasted spend — fix the routing `hints` instead. When you do
  suggest a model change, cite the specific fields and their `routingDiagnosis` that justify it.
- **Ground truth is sacred.** Don't change ground truth just to make a number go up; only correct
  it when it's genuinely wrong, ideally confirmed against the source document.
- **Validate is safe to iterate; promote is the gated, prod-affecting step.** Validate only ever
  snapshots a non-live candidate (deduped by content, so re-running identical YAML doesn't churn
  versions). Nothing reaches production until `koji schema promote`. Use `koji run` for single-doc
  iteration to keep the loop fast; `koji validate` costs LLM calls (it re-extracts all GT docs).
