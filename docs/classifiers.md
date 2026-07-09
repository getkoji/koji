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
| `window` | Per-class override of how many leading pages to consider. |

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

**API.** `POST /api/classify` with the document and an inline config — see the
[API Reference](api-reference.md#classify). The response:

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

## Managing classifiers

Create, edit, and version classifiers from the dashboard (**Classifiers** in the
sidebar), the `koji classify` CLI, or the `/api/classifiers` endpoints — whichever
fits your workflow. The config artifact is the single source of truth across all
three.
