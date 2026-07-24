---
title: Classifiers
description: Sort documents into your own classes with a cost cascade — cheap deterministic signals first, model calls only for the hard tail. Config, cost control, and the test loop.
---

# Classifiers

A classifier decides which of *your* classes a document belongs to — invoice vs.
policy vs. receipt, or whatever set you define. It's a config artifact, a sibling
to a [schema](schema-guide.md): you author it as YAML, version it, and test it by
uploading documents.

The design goal is **low cost**. Classifying a document can be expensive — a
scanned page needs OCR or a vision model — so the classifier spends the minimum
to reach a confident label and stops. Most documents are classified for
effectively nothing; only the hard tail pays for a model call, and even then the
cost is bounded to the first few pages.

## How it works: the cost cascade

Every document runs through increasingly expensive tiers. The first tier that
produces a confident label wins; the rest never run.

| Tier | Signal | Cost |
|------|--------|------|
| **0 metadata** | MIME type, extension, page count | free |
| **1 text** | Cheap text-layer read of the leading pages (no OCR) | free |
| **2 keyword** | Deterministic keyword / regex match on that text | free |
| **3 llm** | A model classifies from the extracted text | small |
| **4 vision** | A vision model classifies from the rendered page image | bounded |

Two properties keep this cheap:

- **Short-circuit.** A class that clears the keyword threshold at tier 2 never
  pays for the LLM or vision tier.
- **Cost is O(1) in page count.** The classifier only ever reads the first few
  pages (the `window`), so a 100-page scanned packet costs the same to classify
  as a 2-page one.

Tiers 3 and 4 require a model endpoint configured in your
[Model Catalog](configuration.md); tier 4 additionally needs a vision-capable
model. If a free tier decides the label, no model is needed at all. But if the
cheap tiers can't decide and no model endpoint can be reached, the classifier
**fails** rather than returning `unknown` — an outage must not be mistaken for
"looked and couldn't tell", because a `classify` step's `unknown` sends a
document down its pipeline's `default` route.

**Input formats.** Tier 1 reads page text from a PDF. For a text-like document
(`.md`, `.txt`, `.csv`, `.json`, `.yaml`, `.html`) the bytes are the text and
are read directly. For any other format the parse stage handles — `.docx`,
`.xlsx` — the classifier falls back to the text the pipeline already parsed. A
scanned PDF has no text layer, so it skips to the vision tier as designed.

## Defining a classifier

A classifier is YAML with a `classify` block (cost controls) and a `classes` map:

```yaml
name: inbound_mail
description: Route incoming documents by type

classify:
  window: 3            # default leading pages to consider
  scan: head           # head | head_and_tail
  max_tier: 4          # cost ceiling: 0 meta · 1 text · 2 keyword · 3 llm · 4 vision
  on_unknown: return   # return "unknown", or reject (422)

classes:
  invoice:
    description: A vendor bill
    keywords: ["invoice", "amount due", "remit to"]
    window: 2          # per-class cost dial — short docs, look at fewer pages
  policy:
    description: An insurance policy with declarations
    keywords: ["declarations", "insuring agreement", "policy number"]
    window: 5          # prone to a routing slip stapled on top — look deeper
  certificate:
    description: ACORD-style certificate of liability
    keywords: ["certificate of liability"]
    patterns: ["ACORD\\s*25"]
```

### Classes

Each entry under `classes` is a label you can receive back. A class may declare:

| Field | Purpose |
|-------|---------|
| `description` | Human description; also given to the LLM/vision tiers as the class definition. |
| `keywords` | Case-insensitive keyword signals for the free keyword tier. Multi-word entries match as a phrase; single words match whole-word. |
| `patterns` | Regular-expression signals for the keyword tier (case-insensitive). |
| `exclude_keywords` | Disqualifying keywords. If **any** appears in the window text, this class is ruled out — it can't win the keyword tier and is removed from the LLM/vision candidate list. |
| `exclude_patterns` | Disqualifying regexes, same rule-out semantics as `exclude_keywords`. |
| `window` | Per-class override of how many leading pages to consider. |

#### Disqualifying signals

`keywords`/`patterns` say "this document *might* be class X." `exclude_keywords`/`exclude_patterns` say the opposite — "if the document has this, it is *definitely not* class X." An excluded class is a hard, deterministic gate across every tier: it can't score on keywords, and it isn't even offered to the LLM or vision model, so nothing can pick it.

This is how you route classes that share vocabulary with a class they must not be confused for. A standalone commercial umbrella and a package policy both mention "schedule of underlying insurance," so no positive keyword can separate them — but a package carries its *own* coverage-part declarations, which an umbrella never does. Exclude the umbrella class when those appear:

```yaml
classes:
  umbrella:
    description: A standalone commercial umbrella / excess policy
    exclude_keywords:
      - "commercial property coverage part"
      - "commercial general liability coverage part"
  package:
    description: A commercial package policy with its own property/GL coverage parts
```

Disqualification needs textual evidence: a scanned PDF with no text layer that reaches the vision tier has nothing to match, so no class is excluded there. The engine only matches the strings — which strings rule out which class is entirely your configuration, so nothing document-type-specific lives in the engine.

`unknown` is reserved — you can't name a class `unknown`, because it's the label
returned when nothing matches.

### Cost controls (`classify`)

| Field | Default | Purpose |
|-------|---------|---------|
| `window` | `3` | Default number of leading pages to read. |
| `scan` | `head` | Where the window samples from — `head`, or `head_and_tail` when junk trails too. |
| `max_tier` | `4` | The cost ceiling. Set to `2` to stay entirely free and accept `unknown` for anything the deterministic tiers can't decide. |
| `on_unknown` | `return` | `return` surfaces `unknown`; `reject` fails the request with `422` so a caller can hard-branch on it. |

**`window` is your cost dial.** You know your documents better than we do: set a
small window for short document types and a larger one for types that arrive with
cover sheets stapled on top. The cascade still short-circuits — a keyword hit
never pays for a model call regardless of the window.

## Cover pages and junk on top

The first page isn't always the document — fax cover sheets, routing slips, and
sticky-note scans land on top. The classifier handles this generically: it ranks
the pages in the window by information density so a near-empty cover page sinks
below the real document, and the result reports the **evidence page** the label
came from — so a misclassification caused by a cover sheet is easy to spot. Use
`scan: head_and_tail` when junk sometimes trails the document too.

## Scanned documents

A scanned document has no text layer, so the free tiers find nothing and the
classifier escalates to the vision tier (4): it renders the leading pages to
images and asks a vision-capable model. Cost stays bounded to the window — the
classifier never renders the whole document just to label it.

## Testing a classifier

Testing runs the exact same cascade production would — nothing is simulated, and
nothing is persisted.

**Dashboard.** Open the classifier, edit its config, and use the **Test** panel to
upload a document. You'll see the label, confidence, the **tier** that produced it
(so you can see what it cost), the evidence page, and the per-class deterministic
scores.

**CLI.**

```bash
koji classify run inbound_mail ./document.pdf
```

**API.** `POST /api/classify` with the document and **either** an inline config
**or** the slug of a registered classifier — see the
[API Reference](api-reference.md#classify).

```json
{ "storage_key": "docs/abc123", "classifier": "inbound_mail" }
```

Referencing by slug runs the classifier's **released** version (add
`classifier_version` to pin one). Prefer it in production code: it is one round
trip instead of fetching `yamlSource` and posting it back, and re-tuning ships
via `koji classify release` with **no consumer redeploy** — which matters,
because tuning a classifier normally takes several versions. The response echoes
`classifier` and `classifier_version` so you can see exactly what ran.

For a document over the 4.5 MB request-body cap, upload it with the presigned
flow and pass `storage_key` instead of the bytes — and note the `config` field
takes a **YAML string** as well as an object, on both the multipart and JSON
forms. There is also no need to slice pages client-side: the cascade only reads
the pages `window` selects, so `window: 1` reads one page no matter how long the
document is.

The response:

```json
{
  "label": "invoice",
  "confidence": 0.9,
  "method": "keyword",
  "tier_used": 2,
  "evidence_page": 2,
  "scores": [
    { "id": "invoice", "score": 0.9, "hits": 3, "total": 3, "evidence_page": 2 }
  ]
}
```

`method` names the tier that decided (`keyword`, `llm`, `vision`, or `unknown`),
and `tier_used` is its numeric cost tier.

## Versioning

Classifiers version exactly like schemas — a draft you edit freely, release
candidates, and a live released version:

```bash
koji classify versions inbound_mail   # list released + candidate versions
koji classify release inbound_mail    # release the current config directly
koji classify promote inbound_mail    # graduate the latest candidate to live
```

The same lifecycle is available from the dashboard (**Save draft**, **Save as
candidate**, **Release**, **Promote**) and the
[API](api-reference.md#classifiers). See the
[CLI Reference](cli.md) for the full command set.

## Corpus & backtesting

A classifier can hold a **corpus** — documents labelled with the class they
*should* be assigned — the same way a schema holds ground-truth documents. This
is what lets you tune a classifier against real numbers instead of guessing:
widen a class's keywords, re-run the corpus, and see whether recall on another
class dropped.

A label is `{ label: "<class id>" }`, where the id is one of the classifier's
**released** classes (or `unknown` — asserting a document *should* fall through,
which is exactly what an `on_unknown: reject` config needs to test).

Corpus documents live in a **project-level pool** shared with schema corpora, so
a PDF uploaded once can be labelled for a schema *and* for a classifier without
re-uploading — attach it by `document_id`:

```bash
# via the API
curl -X POST .../api/classifiers/inbound_mail/corpus \
  -H 'content-type: application/json' \
  -d '{ "document_id": "<pool doc id>", "label": "invoice" }'
```

See the [API Reference](api-reference.md#classifier-corpus) for the full corpus
endpoints and [`GET /api/corpus/documents`](api-reference.md#get-apicorpusdocuments)
to list the pool.

### Running a backtest

Once the corpus is labelled, backtest a classifier version against it — from the
CLI (labels the corpus and reads the result in the terminal):

```bash
koji classify corpus add inbound_mail invoice ./samples/*.pdf   # label some docs
koji classify validate inbound_mail                             # backtest + render
koji classify validate inbound_mail --version v1.2.0 --check    # pin a version; fail on regression
```

or directly over the API:

```bash
curl -X POST .../api/classifiers/inbound_mail/validate \
  -H 'content-type: application/json' \
  -d '{}'
```

The run classifies every labelled document through the **same cascade production
uses** and scores predicted vs. ground truth. By default it backtests the
**released** version; pass `{ "version": "v1.2.0" }` (a semver label or a
version-id prefix) to pin a specific one — the same selector the classify run
and pipeline routes use, so a backtest and a live route agree on the same config.

The result carries the diagnostics you tune against:

- **`accuracy`** and per-document counts (failed documents — provider outages —
  are excluded from the denominator, not scored as wrong).
- **`byClass`** — precision / recall / F1 per class.
- **`confusion`** — the expected→predicted matrix. With more than two classes,
  *which* class a document was mistaken for is the actionable signal: it points
  at the keywords to tighten.
- **`tierHistogram`** and **`escalationRate`** — the share of documents that
  needed the paid LLM/vision tail (tier ≥ 3), so raising `max_tier` has a
  measured cost, not a guessed one.
- **`flips`** — fixed / regressed / churned vs. the previous run, so a change
  that lifts one class while quietly breaking another is visible.

For a large corpus, pass `{ "async": true }`: the call returns `202 { runId }`
immediately and fans the work out one document per job. Poll
`GET /api/classifiers/{slug}/validate/runs/{runId}` for progress and the final
result; `GET /api/classifiers/{slug}/validate` returns the most recent completed
run. See the [API Reference](api-reference.md#classifier-validate).

### Gating a promotion on no regressions

Tuning is a balancing act: widening one class's keywords to lift its recall can
also make those keywords match a *different* class's documents — dropping the
other class's recall and leaking cross-class false positives. Per-class metrics
make that visible; a **promotion gate** makes it blocking, so a candidate that
regresses a class you weren't watching can't quietly go live.

Gate a promotion on the candidate's latest backtest:

```bash
# refuse if ANY class dropped vs. the live release
koji classify promote inbound_mail --require-no-regressions

# refuse only if specific classes regressed
koji classify promote inbound_mail --must-not-regress policy --must-not-regress coi

# require an absolute floor, regardless of the baseline
koji classify promote inbound_mail --min-recall coi=0.95 --min-precision policy=0.9
```

The candidate is compared against the **live release's** most recent backtest
(the "before"). If a guarded class regressed or fell under a floor, the promotion
is refused and each offending class is listed with its before → after numbers:

```
✗ promotion blocked — inbound_mail would regress:
  • coi recall 100% → 91%
  • coi precision 100% → 80%
```

Fix the regression, re-validate, and promote again. The same gate is available
on the API (`POST /api/classifiers/{slug}/promote` with `requireNoRegressions` /
`mustNotRegress` / `minRecall` / `minPrecision`). A gate needs a completed
backtest of the candidate to evaluate — without one, the promotion is refused
rather than passed blindly. `koji classify release` is the explicit un-gated
path: it releases directly, skipping the candidate/backtest loop by design.

## Managing classifiers

Create, edit, and version classifiers from the dashboard (**Classifiers** in the
sidebar), the `koji classify` CLI, or the `/api/classifiers` endpoints — whichever
fits your workflow. The config artifact is the single source of truth across all
three.
