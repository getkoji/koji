# Design: Classify + Split pipeline stage

**Status**: Proposed
**Task**: oss-28
**Motivation**: accuracy-9 (adversarial corpus — `anomaly_wrong_schema`, `anomaly_stapled`, `anomaly_multi_union`) and a real user report.

## The problem

Today, Koji assumes the input document is a single instance of the schema you hand it. The pipeline is:

```
document → parse → chunk → route → extract → reconcile
```

That falls apart when the input is a **packet** — a single upload containing several logically distinct documents stapled together. A real scenario from a user:

> Page 1 is an invoice, page 2 is a certificate of insurance, pages 3–10 are policy declaration pages. I want to extract *policy* fields. Today Koji hands the full markdown to the insurance schema, and the extractor latches onto whatever value it finds first — usually invoice data or random text from page 1 — and returns garbage.

Three adversarial fixtures in `accuracy-9` exercise this class of failure:

| Fixture | Shape | Current behavior |
|---|---|---|
| `anomaly_wrong_schema` | A 10-K filing handed to the invoice schema | Model invents invoice fields from 10-K text |
| `anomaly_stapled` | Invoice + COI + policy in one packet | Only the first section extracts correctly |
| `anomaly_multi_union` | Three invoices stapled | Only the first invoice is returned; the other two are lost |

Under the hood, the chunker can already split the document into chunks, and the router already scores chunks against fields. What's missing is a layer that:

1. Recognizes a chunk as belonging to a *different document type* than the schema expects.
2. Groups adjacent chunks of the same type into a **section**.
3. Lets each schema declare which section types it applies to.
4. Runs extraction once per (schema, matching section) pair.

## Out of scope (for this design)

Things that could land in follow-up work but are **not** part of the MVP proposed here:

- Parallel extraction across sections when the same schema matches multiple sections. The MVP runs sequentially per section; parallelization is a straightforward optimization.
- Cross-section reconciliation (e.g., a COI referencing a policy number that also appears in a stapled policy doc). Each section is extracted independently; linking them is a post-processing concern.
- Learning-based classifiers. The MVP classifier is a small LLM pass with schema-author-declared document types. Training a classifier head is a future consideration if accuracy demands it.
- Multi-schema auto-routing ("here's a packet, figure out every schema that applies"). The MVP is still driven by a specific schema per extraction call; the caller decides which schemas to run.
- Vision-based classification. The MVP operates on parsed markdown. Vision-path classification can hook into the same interface later.

## Pipeline shape

New optional stage between chunking and routing:

```
document → parse → chunk → [classify + split] → route → extract → reconcile
                            └────── optional ──────┘
```

When the classify stage is **disabled** (default), the pipeline is byte-for-byte identical to today's. The whole document becomes one unnamed section of type `document` and every schema's `apply_to` matches it. No behavior change for any existing schema.

When the classify stage is **enabled**, it emits a list of sections:

```python
@dataclass
class Section:
    type: str                      # e.g., "invoice", "coi", "policy", "sec_filing"
    title: str                     # short human label ("Section 1 — invoice")
    chunk_indices: list[int]       # which chunks from the document_map belong to this section
    confidence: float              # classifier confidence 0.0..1.0
```

Sections are **contiguous chunk runs** — the classifier labels each chunk with a type, then adjacent chunks with the same label merge into a section. This keeps the implementation simple and lets existing chunker features (heading inference, stanza handling, table dedupe) pay off for classification too.

The router sees only the chunks belonging to sections that match the current schema's `apply_to`. Everything downstream (routing, grouping, extraction, reconciliation, gap-fill) operates on that slice of chunks exactly as today.

## Config surface — `koji.yaml`

A new optional top-level `classify` block:

```yaml
pipeline:
  parse:
    engine: docling
  classify:
    enabled: true
    model: openai/gpt-4o-mini     # small/cheap model; separate from extract model
    require_apply_to: false       # optional — see below
    types:
      - id: invoice
        description: Commercial invoice with line items, bill-to, and totals.
      - id: coi
        description: Certificate of insurance showing coverage, policyholder, and insurer.
      - id: policy
        description: Insurance policy document with declarations, coverages, endorsements.
      - id: sec_filing
        description: SEC EDGAR filing (10-K, 10-Q, 8-K, DEF 14A, or amendment variants).
      - id: other
        description: Catch-all for content that doesn't match any declared type.
  extract:
    model: openai/gpt-4o-mini
```

Key decisions:

- **Classify model is a separate config key from extract model.** Classification is a cheap, bounded-output task — a small model (or even a local one) is usually fine, and we shouldn't force users to pay extract-model token rates for it.
- **Types are schema-author-declared.** Koji ships with no built-in document type taxonomy. You list the types your pipeline cares about in `koji.yaml`, and those are the only labels the classifier can emit (plus a reserved `other` fallback).
- **The `enabled: true` flag is the only way to turn it on.** Defaulting to off keeps existing single-document deployments unchanged. Migration is a one-line addition to `koji.yaml`.
- **`require_apply_to` toggles strict vs forgiving mode for schemas without an `apply_to` declaration.** When `false` (default), a schema without `apply_to` runs against every section the classifier produces — migration is painless and forgiving. When `true`, a schema without `apply_to` is a config error at extraction time; strict mode forces deliberate opt-in for every schema that lives alongside the classifier. Strict mode is useful once a deployment has more than a handful of schemas and you want to prevent accidental cross-section extraction.
- **No section count limits, page limits, or sampling in the MVP.** The classifier sees every chunk. If scale becomes a problem, chunk-level batching is a trivial optimization later.

## Schema surface — `apply_to`

A new top-level schema key:

```yaml
name: insurance_policy
description: Commercial insurance policy extraction.
apply_to: [policy]          # optional, defaults to any section type

fields:
  policy_number: ...
```

Semantics:

- `apply_to` is a list of type IDs (matching `classify.types[].id` in `koji.yaml`).
- When the classify stage is **disabled**, `apply_to` is ignored — the whole document is always a match. This guarantees backward compat: adding `apply_to` to a schema never breaks a pipeline that hasn't opted into classification.
- When the classify stage is **enabled** and a schema has no `apply_to`, behavior depends on `classify.require_apply_to` in `koji.yaml`:
  - `false` (default, forgiving): the schema runs against *every* section regardless of type — "I don't care about types, just extract everything this schema can find".
  - `true` (strict): the schema is a config error and extraction raises a clear message at call time.
- When `apply_to` is set and matches multiple sections, the extractor runs **once per matching section**. Results come back as a list — see "Output shape" below.
- When `apply_to` is set and matches zero sections, extraction returns an empty `sections` list with an explicit `"no_matching_section"` reason in the metadata. This is a successful pipeline run, not an error.

## Classifier implementation

Approach: **one LLM call per document**, asking the model for **section ranges directly** rather than per-chunk labels.

Why section ranges and not per-chunk labels: the decision that matters most for accuracy is *where the boundary between two documents falls*. Per-chunk labeling makes N independent decisions, losing the document-level narrative at boundary chunks — adjacent chunks get labeled inconsistently because the model considers them in isolation. Direct section output lets the model reason holistically ("this block from chunk 5 to 12 is one policy document") in one decision, which matches how humans read packets. Validation of the range output is harder but deterministic (see below).

Input: the full chunk list serialized as a numbered outline (chunk index, title, first N chars of content per chunk — enough for the model to decide a type, not enough to blow out the prompt).

Prompt:

```
You're given a document that may be a single item or a packet of several
stapled-together documents. Identify each logical document in the packet
and return its type and chunk range.

Types:
- invoice: Commercial invoice with line items, bill-to, and totals.
- coi: Certificate of insurance showing coverage, policyholder, and insurer.
- policy: Insurance policy document with declarations, coverages, endorsements.
- sec_filing: SEC EDGAR filing (10-K, 10-Q, 8-K, DEF 14A, or amendment variants).
- other: Anything not matching above.

Rules:
- Each chunk belongs to exactly one section.
- Section ranges must be contiguous (start_chunk to end_chunk, inclusive).
- Sections must not overlap.
- Every chunk in the document must belong to some section — no gaps.
- If unsure about a block, use type "other" rather than inventing.

Return JSON in this exact shape:
{
  "sections": [
    {"type": "invoice",  "start_chunk": 0, "end_chunk": 4, "confidence": 0.96},
    {"type": "coi",      "start_chunk": 5, "end_chunk": 7, "confidence": 0.91},
    {"type": "policy",   "start_chunk": 8, "end_chunk": 19, "confidence": 0.97}
  ]
}

Chunks to classify:

[0] Invoice Header
INVOICE Amazona Parts Supply Co 2847 Industrial Blvd Phoenix AZ...

[1] Bill To
Mojave Engineering LLC Accounts Payable 15500 N Perimeter Dr...

[2] Services
Stainless bolt M12x40 500 1.25 625.00...
```

### Normalizer

The model output is run through a normalizer (`_normalize_classifier_response`) before it becomes the section list. The normalizer is deterministic and handles every failure mode a non-trivial LLM response could produce:

1. **Out-of-range indices** (`start_chunk: 20` when the document has 10 chunks): drop the section entirely. If every section is invalid, fall back to whole-document single section.
2. **Inverted ranges** (`start_chunk > end_chunk`): drop the section.
3. **Overlapping ranges** (section A = 0–5, section B = 3–7): resolve by first-start-wins: the earlier section keeps its full range, the later section's overlap is trimmed off the front (or dropped entirely if no range remains after trimming).
4. **Gaps** (chunks 6–8 not claimed by any section): fill automatically with an `other` section so document content never vanishes.
5. **Unknown types** (`type: "widget"` when `widget` isn't declared in `koji.yaml`): coerce to `other`.
6. **Missing required fields** (`type` absent): drop the section.
7. **Invalid JSON or LLM exception**: fall back to whole-document single section.
8. **Zero sections returned**: fall back to whole-document single section.

The normalizer logs every correction it makes at info level so operators running `koji bench` can see how often the classifier output needed massaging.

### Fallback behavior

When the normalizer can't produce any valid section (all sections invalid, empty response, exception):

- The pipeline logs a warning and treats the whole document as one section of type `document`.
- Schemas with no `apply_to` still run against that fallback section.
- Schemas with `apply_to: [specific_type]` produce an empty result with metadata noting `"classifier_fallback"` as the reason.

This fallback is deliberately conservative: a broken classifier should degrade gracefully to "today's behavior", not error out the whole pipeline.

## Output shape

The rule is simple and orthogonal to `apply_to`:

- **Classifier disabled** (current default): `intelligent_extract` returns the existing flat shape. Byte-identical to today. Every existing caller keeps working with no changes.
- **Classifier enabled**: the response is *always* wrapped in a `sections` list, even for a single-document packet that produces one section. Predictable. Callers that enable the classifier know they'll always get a list.

### Classifier disabled (unchanged)

```python
{
  "extracted": {...},
  "confidence": {...},
  "confidence_scores": {...},
  "gap_filled": [...],
  "document_map_summary": {...},
  "routing_plan": {...},
  "groups": [...],
  "elapsed_ms": 3200
}
```

### Classifier enabled (always wrapped)

```python
{
  "sections": [
    {
      "section_type": "policy",
      "section_title": "Section 3 — policy",
      "section_confidence": 0.96,
      "chunk_indices": [2, 3, 4, 5],
      "extracted": {...},
      "confidence": {...},
      "confidence_scores": {...},
      "gap_filled": [...],
      "routing_plan": {...},
      "groups": [...]
    },
    # ...one entry per matching section; may be empty if no section matched
  ],
  "document_map_summary": {...},
  "classifier": {
    "enabled": true,
    "model": "openai/gpt-4o-mini",
    "total_sections": 3,
    "sections_matched": 1,
    "tokens_in": 2104,
    "tokens_out": 187,
    "elapsed_ms": 412,
    "normalizer_corrections": 0
  },
  "elapsed_ms": 8420
}
```

Single-document packets (the common case even with the classifier on) produce a one-element `sections` list. Callers that only care about a single result reach for `result["sections"][0]["extracted"]`. Callers handling stapled packets iterate naturally.

**This shape change only triggers when a deployment explicitly sets `classify.enabled: true` in `koji.yaml`.** Adding that flag is a deliberate opt-in that requires the caller-side code change to handle the wrapped shape. The docs and changelog flag this loudly.

Alternative considered and rejected: conditional shape based on whether `apply_to` was set on the schema. That leaked the decision into the caller ("sometimes you get flat, sometimes wrapped, depending on what the schema author wrote"), which is confusing. The current rule — classifier on ⇒ always wrapped — is the simpler, more honest abstraction.

### Classifier cost disclosure in `koji bench`

Because the classifier adds one LLM call per document, `koji bench --output bench.json` breaks out classifier cost as its own line item in the summary:

```json
{
  "summary": {
    "total_documents": 35,
    "total_elapsed_ms": 294000,
    "extract": {"tokens_in": 72814, "tokens_out": 5213, "elapsed_ms": 282000},
    "classify": {"tokens_in": 28150, "tokens_out": 2104, "elapsed_ms": 12000}
  }
}
```

When the classifier is disabled, the `classify` block is absent. This lets users see exactly how much overhead the classifier adds on their corpus and decide whether to turn it on per deployment.

## Backward compatibility matrix

| Existing schema | Existing `koji.yaml` | Existing caller | Behavior under MVP |
|---|---|---|---|
| No `apply_to` | No `classify` block | Reads `result["extracted"]` | Unchanged — flat shape |
| No `apply_to` | `classify.enabled: false` | Reads `result["extracted"]` | Unchanged — flat shape |
| No `apply_to` | `classify.enabled: true`, `require_apply_to: false` | Reads `result["sections"]` | New — schema runs against every section, always wrapped |
| No `apply_to` | `classify.enabled: true`, `require_apply_to: true` | — | Config error at extraction time, clear message |
| Adds `apply_to` | No `classify` block | Reads `result["extracted"]` | Unchanged — `apply_to` ignored when classifier off |
| Adds `apply_to` | `classify.enabled: true` | Reads `result["sections"]` | New — per-section extraction |

The only breaking change triggers when a user explicitly sets `classify.enabled: true` in `koji.yaml`. That's a deliberate opt-in and the one-line caller update (`result["sections"][0]["extracted"]` for single-doc use) is flagged in the docs and changelog. Every path where the classifier is off stays byte-identical.

## Testing plan

Unit tests live in `tests/test_classifier.py` (new) and `tests/test_pipeline.py` (extended):

1. **`_merge_classified_chunks_into_sections`** — pure function that takes a list of `(chunk_index, type)` pairs and returns `Section` objects. Covers: single-type document → one section; two types alternating → four sections; every chunk `other` → one `other` section; edge cases (empty list, single chunk).
2. **Classifier LLM response parsing** — given a canned LLM JSON response, the parser produces correct `Section` objects. Covers: valid JSON, missing chunks in response, chunks out of order, invalid types (coerced to `other`), confidence clamping.
3. **End-to-end wave via `intelligent_extract`** (mocked provider):
   - classifier disabled → existing behavior
   - classifier enabled, single section → extraction runs on that section, output shape includes `sections` wrapper
   - classifier enabled, multi-section matching schema `apply_to` → extraction runs once per section, results come back as a list
   - classifier enabled, zero matching sections → empty `sections` list with reason metadata
   - classifier failure (exception / invalid JSON / empty response) → graceful fallback to whole-document single section
4. **Backward compat guards** — existing pipeline tests that don't opt into classification still pass without modification. All 572 current tests should be green.

Integration test against the accuracy corpus:

1. Build a small stapled fixture (invoice + COI + policy) in `tests/fixtures/stapled.md`.
2. Configure a test `koji.yaml` with the classifier enabled and `classify.types` declared.
3. Run three schemas (`invoice`, `coi`, `policy`), each with `apply_to`, and assert each one extracts only its own section's data.

The accuracy corpus repros (`anomaly_stapled`, `anomaly_multi_union`, `anomaly_wrong_schema`) live in the accuracy lane — a follow-up accuracy-lane task adopts the feature to unblock those fixtures.

## Decisions locked in from review (2026-04-13)

1. **Classifier scope — direct section ranges, not per-chunk labels.** The model reasons holistically about document boundaries; boundary chunks are where the accuracy signal lives. Per-chunk labeling forces N independent decisions and loses the packet-level narrative. Validation is deterministic (see the Normalizer section): ~30 lines of code handles overlaps, gaps, and out-of-range indices without sacrificing model accuracy.
2. **Schemas without `apply_to` when classifier is enabled — configurable.** New `classify.require_apply_to` flag in `koji.yaml`. Default `false` (forgiving — schema runs against every section). Set to `true` for strict mode that errors on any schema without `apply_to`.
3. **Response shape — classifier off ⇒ flat, classifier on ⇒ always wrapped in `sections` even for single-doc packets.** Simple, predictable, opt-in via the explicit `classify.enabled: true` flag.
4. **Classifier cost disclosed in `koji bench`.** Separate `classify` block in the summary output showing tokens_in, tokens_out, elapsed_ms, and normalizer_corrections.

## Open questions still for reviewer

1. **Section ordering and chunk gaps.** If the classifier emits `invoice → invoice → other → invoice → invoice`, should that be one invoice section (ignoring the middle `other`) or two? Proposal: two — strict contiguous runs. Users who want cross-gap merging can post-process. This keeps the splitter logic simple and deterministic.
2. **Confidence thresholding.** Should low-confidence sections get demoted to `other` before routing? Proposal: no thresholding in the MVP — trust the classifier's labels. If accuracy work shows thresholding helps, add it in a follow-up as a `classify.min_confidence` config knob.
3. **Dashboard / API surface.** `/api/extract` returns extract results today. Does the new `sections`-wrapped shape flow through the REST API unchanged, or does the API need a versioning decision? Proposal: the API returns whatever the pipeline returns, same shape rules as above. A `/api/v2/extract` can come later if the shape change proves disruptive in the wild.

## Rollout

Ship this in three PRs so nothing feels like a big-bang change:

1. **PR 1 — Design doc (this document).** Land the design, collect feedback, adjust before writing code. *This is oss-28.*
2. **PR 2 — Classifier + splitter + no-op wiring.** Implement the classifier, the splitter, the `Section` dataclass, and the `koji.yaml` surface. Wire them into `intelligent_extract` behind `classify.enabled`. When disabled, behavior is byte-identical to today. When enabled, the pipeline produces a single wrapped section for every document. No `apply_to` support yet. Full unit tests for the classifier + splitter.
3. **PR 3 — `apply_to` schema surface + per-section extraction.** Add the schema key, the section-matching logic, and per-section extraction loops. Response shape change lands here. Integration test against a stapled fixture.

Each PR is individually reviewable, mergeable, and backward-compatible until PR 3 flips on the apply_to semantics. Accuracy-lane follow-up task adopts the feature in the SEC / insurance corpora.

## Recommendation

Land this design doc as-is under oss-28, resolve the open questions above with the reviewer, then implement PR 2 and PR 3 as separate follow-up oss-* tasks. The design doc makes the feature reviewable before the code exists, which is the whole reason the task was flagged for a design pass.
