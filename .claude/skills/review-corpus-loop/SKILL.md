---
name: review-corpus-loop
description: Mine the human-review queue for hard documents, promote them into the validation corpus as ground truth, then improve the schema so that class of document stops routing to review. Use whenever the user wants to turn reviewed/low-confidence documents into corpus coverage, "learn from review", grow the corpus from production traffic, or run an agent loop that improves a schema from the docs that get flagged.
allowed-tools: Bash(koji:*) Bash(eval:*) Bash(jq:*) Read Edit Write
---

# Review → corpus loop — turn flagged documents into schema improvements

This is the **outer loop**. Production documents that route to human review are the
highest-signal training data you have: each one is a document the current schema
couldn't extract confidently. This skill mines that queue, promotes the corrected
documents into the corpus as ground truth, and then hands off to the **inner loop**
(`schema-loop`) to fix the schema so that class of document stops getting flagged.

```
doc routes to review (low_confidence on field X)
  → a human resolves it (or an agent proposes a draft label)
  → promote it into the corpus as ground truth
  → improve the schema for field X      ← this is the `schema-loop` skill
  → validate until accuracy recovers
  → that class of doc stops routing to review
```

It runs against a **connected Koji platform** (same data as the dashboard's Review /
Corpus / Validate tabs), driven entirely from the CLI.

## Prerequisites

- Authenticated: `koji whoami` shows a server. If not, the user runs `koji login`
  (or sets `KOJI_API_URL` + `KOJI_API_KEY`). Use `--profile <name>` to target a tenant.
- You know the **schema slug** and ideally have its local YAML (`koji pull` if not).

## The commands (all take `--json`)

- `koji review stats --json` → `{pending, urgent, completed, reviewedToday}` computed
  server-side with `count(*)`. **This is the only correct way to measure queue size or
  burn-down progress.** `--urgent-below 0.5` adjusts the urgent threshold.
- `koji review ls --json` → `[{id, documentFilename, fieldName, reason, confidence,
  status, resolution, schemaSlug, pipelineSlug, documentId}]`. Pending items, worst
  confidence first. Filters: `--status pending|completed`, `--reason <reason>`,
  `--limit N`. `reason` is the routing cause — `low_confidence`, `validation_failed`,
  `conflicting_values`, etc. **This is a page, not the queue**: it returns at most
  `--limit` rows (default 100). Never count its output to size the queue — a queue of
  thousands reads as exactly `--limit` and burning items down never moves the number.
- `koji review show <id> --json` → the full item: flagged field, reason, `proposedValue`,
  `confidence`, the document's **complete** `documentExtractionJson`, and the
  schema/pipeline it ran under. This is what you read to decide the correct value and
  *which schema knob to turn*.
- `koji review promote <id> --json` → promote a **resolved + approved** review item into
  the corpus as APPROVED ground truth. The document's corrected record (already merged
  on resolution) becomes ground truth that `koji validate` scores immediately. `--to <tag>`
  tags the new corpus entry. Returns `{corpusEntryId, groundTruthId, reviewStatus,
  provisional, deduped, fieldCount}`.
- `koji review promote <id> --provisional [--gt-from label.json] --json` → for an item
  that has **not** been human-resolved. Writes a `draft`, agent-authored label.
  **Draft labels are deliberately excluded from `koji validate`** until a human approves
  them (in the dashboard Corpus tab — the draft shows an "Approve" button). Optional
  `--gt-from` supplies your corrected `{field: value}` record; otherwise the document's
  current (possibly-wrong) extraction is used.

## Two modes — pick based on who supplies the label

The corpus is the one asset that must stay trustworthy: `koji validate`'s entire signal
depends on it. So the question is always **who supplies the ground-truth label**.

### Human-gated (default — safe, recommended)

The human has already resolved the item in the dashboard (accept/override). The label is
theirs; you just move it into the corpus. Fully autonomous and zero-risk.

```bash
# promote every approved-but-not-yet-corpus item
koji review ls --status completed --json \
  | jq -r '.[] | select(.resolution=="approved") | .id' \
  | while read -r id; do koji review promote "$id" --json; done
```

### Provisional (autonomous — you supply the label, human confirms later)

No human has resolved the item yet and you (the agent) are reading the document to
determine the correct value. **You must not let your guess silently become golden** —
that would corrupt validation. So provisional labels land as `draft` and stay out of
`validate` until a human approves them.

```bash
koji review show <id> --json          # read the doc + extraction
# decide the correct values; write them to label.json
koji review promote <id> --provisional --gt-from label.json --json
# → draft. A human approves it in the dashboard Corpus tab before it counts.
```

**Default to human-gated.** Only use `--provisional` when the user has explicitly asked
for a fully autonomous loop and accepts that drafts need human approval before they
affect validation.

## The loop

### 1. Survey the queue
`koji review stats --json` first — record `pending` as the true queue size (and the
burn-down baseline you'll compare against in step 5). Then `koji review ls --json`
(and `--status completed --json`) for the work list; page with `--limit` if you want
more than the default 100. Group by `schemaSlug` and
`fieldName`. A field that shows up repeatedly is a schema weakness, not bad luck — that
`reason` (usually `low_confidence`) tells you the schema is missing a hint/pattern/
description for that field, not that the model is broken.

### 2. Promote the corrected documents into the corpus
- Human-gated: promote the approved items (loop above).
- Provisional: for each, `koji review show`, read the document if needed
  (`documentExtractionJson` is in the response; for the raw file pull it via the
  document's job), decide the correct label, `promote --provisional --gt-from`.
  Then get the drafts approved before relying on them.

### 3. Improve the schema → hand off to `schema-loop`
Now you have new corpus coverage for the exact documents that were failing. Switch to the
**`schema-loop`** skill: edit the schema's local YAML to fix the field(s) that kept
routing to review (description is the strongest lever), then `koji validate <schema>
--check --json` until the target docs pass with **zero regressions**.

The signal from step 1 tells you what to change: if `field X` kept routing
`low_confidence`, that field's `description` / hints / patterns are the place to work.

### 4. Confirm the loop closed
After the schema improves, the same class of document should extract confidently and stop
generating review items. Re-run the relevant documents (`koji run <schema> <doc> --json`)
and confirm the field's confidence is now above the pipeline's review threshold.

### 5. Report
Summarize: the queue's before/after `pending` count from `koji review stats --json`
(never from counting `review ls` rows), how many review items you promoted, which
fields kept failing, the schema change that fixed them, the before/after
`overallAccuracy`, and (for provisional) how many drafts are awaiting human approval.

## Guardrails

- **The corpus must stay trustworthy.** Human-gated promotion is always safe. Provisional
  drafts must never count in `validate` until a human approves them — that's enforced
  server-side (drafts aren't written to the scored ground truth), but don't try to route
  around it.
- **Never auto-approve your own drafts.** The whole point of `--provisional` is that a
  human confirms the label. An agent approving its own guesses is grading its own homework.
- **Promote requires a resolution** (unless `--provisional`). If `koji review promote`
  returns a 409, the item isn't resolved+approved yet — surface it for human review rather
  than forcing a provisional label, unless the user asked for the autonomous path.
- **Fixes go in the schema, never the engine.** The schema-improvement half is the
  `schema-loop` skill; its guardrails apply (one change at a time, ship no regression,
  keep the engine document-type-agnostic).
- **Adjudicate against the document.** When you supply a provisional label, base it on
  what the document actually says — don't echo the model's flagged value, which is the
  thing that was low-confidence in the first place.
