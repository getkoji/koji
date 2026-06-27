---
title: Schema Authoring Guide
description: How to write extraction schemas that turn documents into structured data. Field types, hints, arrays, enums, and patterns for every document type.
---

# Schema Authoring Guide

Schemas are the core of Koji. A schema tells the extraction pipeline exactly what data to pull from your documents and where to find it. This guide covers everything from basic field definitions to advanced hint-driven routing.

## Schema basics

A schema is a YAML file with a name, description, and a set of fields:

```yaml
name: purchase_order
description: Standard purchase order extraction

fields:
  po_number:
    type: string
    required: true
    description: The purchase order number

  vendor:
    type: string
    description: Vendor or supplier name

  total:
    type: number
    description: Total order amount
```

- `name` -- identifies the schema in logs and output
- `description` -- helps you remember what this schema targets (not used by extraction)
- `fields` -- the data you want extracted, keyed by field name

Field names become the keys in your output JSON. Use `snake_case` -- these show up in your downstream systems.

The `description` on each field is sent to the extraction model. Be specific. "The invoice number, usually in the top-right header" is better than "invoice number".

## Field types

### string

The default. Use for names, IDs, addresses, free-text values.

```yaml
company_name:
  type: string
  description: The company or organization name
```

Output: `"company_name": "Acme Corp"`

### number

Numeric values. Koji strips currency symbols and commas automatically -- `$1,234.56` becomes `1234.56`.

```yaml
total_amount:
  type: number
  required: true
  description: Total invoice amount including tax
```

Output: `"total_amount": 1234.56`

Integer values stay as integers (no `.0` suffix).

### date

Dates are normalized to ISO 8601 (`YYYY-MM-DD`) regardless of the source format.

```yaml
invoice_date:
  type: date
  required: true
  description: The date the invoice was issued
```

Input document might say "March 15, 2026" or "03/15/2026" or "2026-03-15" -- all produce:

Output: `"invoice_date": "2026-03-15"`

### enum

A constrained set of allowed values. The extraction model picks the closest match.

```yaml
policy_type:
  type: enum
  description: Type of insurance policy
  options:
    - General Liability
    - Workers Compensation
    - Commercial Property
    - Commercial Auto
    - Umbrella
    - Professional Liability
    - Cyber Liability
    - Other
```

Output: `"policy_type": "General Liability"`

Enum matching is fuzzy — if the document says "Gen. Liability" or "GL", Koji matches it to "General Liability". See [Enum matching](#enum-matching) for details.

### mapping

Like `enum`, but with **explicit aliases** for normalization. Use this when real-world documents have many different ways of writing the same canonical value.

```yaml
policy_type:
  type: mapping
  description: Type of insurance policy
  mappings:
    BOP: ["Business Owners Policy", "Businessowners", "Bus. Owners", "BOP"]
    GL: ["General Liability", "CGL", "Commercial General Liability"]
    WC: ["Workers Compensation", "Workers Comp", "Work Comp", "WC"]
```

Each canonical key has a list of aliases. The extracted value is normalized to the canonical key:

- "Business Owners Policy" → `"BOP"`
- "CGL" → `"GL"`
- "Workers Comp" → `"WC"`

Matching is case-insensitive, with fuzzy substring fallback. Use `mapping` when downstream systems expect a fixed set of identifiers (e.g., insurance product codes, country codes, currency codes) rather than the raw text the document uses.

### array

Lists of items. Define the shape of each item with `items`:

```yaml
line_items:
  type: array
  items:
    type: object
    properties:
      description:
        type: string
      quantity:
        type: number
      unit_price:
        type: number
      total:
        type: number
```

Output:

```json
"line_items": [
  {
    "description": "Consulting services",
    "quantity": 40,
    "unit_price": 150.00,
    "total": 6000.00
  },
  {
    "description": "Travel expenses",
    "quantity": 1,
    "unit_price": 450.00,
    "total": 450.00
  }
]
```

Arrays can also hold simple values:

```yaml
tags:
  type: array
  items:
    type: string
```

Output: `"tags": ["urgent", "reviewed", "approved"]`

### boolean

True/false values. Koji normalizes common representations automatically:

```yaml
gl_claims_made:
  type: boolean
  description: Whether General Liability is claims-made (vs occurrence)
```

The following are all recognized as `true`: `"true"`, `"yes"`, `"Y"`, `"X"`, `"1"`, `"checked"`. And as `false`: `"false"`, `"no"`, `"N"`, `"0"`, `""`, `"unchecked"`.

Output: `"gl_claims_made": true`

Booleans are especially useful with [form mappings](forms-guide.md) -- checkbox mapping types detect whether a checkbox is marked and return the boolean value directly.

### object

A single nested object — a group of related fields under one key. Declare the child fields under `properties` (the same key array items use):

```yaml
insured:
  type: object
  properties:
    name:
      type: string
    state:
      type: enum
      options: [CA, NY, TX]
```

Output: `"insured": { "name": "Acme Corp", "state": "CA" }`

Child fields are full field specs, so type coercion, `enum`/`mapping` vocabularies, `normalize`, and `vocab_by` all apply inside an object exactly as they do at the top level (and as they do inside [array items](#field-types-and-rules-apply-inside-items)). Use `object` for a *single* nested group; use [`array`](#array) of objects for a *repeated* group.

> `fields` is accepted as an alias for `properties` on object types, but `properties` is canonical — prefer it for consistency with array items.

## Reusing definitions (DRY schemas)

Large schemas tend to repeat the same things — the same `mappings` vocabulary in several fields, the same `items` shape across multiple arrays, the same number/date setup over and over. You don't have to copy-paste. Schemas are YAML, so you can use **YAML anchors** — a native YAML feature, no special Koji syntax — to define a block once and reuse it everywhere.

Mark a block with an anchor (`&name`), then reuse it with an alias (`*name`):

```yaml
name: insurance_certificate
fields:
  gl_applies_to: &applies_to        # define once, name it "applies_to"
    type: mapping
    mappings:
      each_occurrence: ["Each Occurrence", "Per Occurrence"]
      general_aggregate: ["Aggregate", "Gen Agg"]
  umbrella_applies_to: *applies_to  # reuse the exact same definition
  excess_applies_to: *applies_to
```

All three fields end up with identical definitions, but you maintain only one.

### A definitions block with `_defs`

For bigger schemas, keep every reusable piece in one place. Koji ignores unknown top-level keys, so a top-level `_defs` block is a safe home for definitions you only reference through aliases — it never becomes a field itself:

```yaml
name: insurance_certificate
_defs:
  applies_to: &applies_to
    type: mapping
    mappings:
      each_occurrence: ["Each Occurrence", "Per Occurrence"]
      general_aggregate: ["Aggregate", "Gen Agg"]
  money: &money
    type: number
fields:
  gl_applies_to:       *applies_to
  gl_limit:            *money
  umbrella_applies_to: *applies_to
  umbrella_limit:      *money
```

You can anchor anything that repeats — a whole field definition, a nested `items` structure, a `mappings` vocabulary, a `hints` block.

> **Anchors are a copy mechanism.** An alias expands to a full copy of the anchored block at parse time. Editing the anchored definition updates every field that references it — that's the point. There's no runtime cost; by the time extraction runs, the schema looks exactly as if you'd written each block out by hand.

## Required fields

Mark fields as `required: true` when the extraction is incomplete without them:

```yaml
invoice_number:
  type: string
  required: true
  description: The invoice or reference number
```

When a required field is not found:

1. The field appears as `null` in the output
2. Its confidence is marked as `not_found`
3. Koji logs a warning: `Missing required fields: [invoice_number]`
4. Future: gap-filling will broaden the search automatically

Use `required` sparingly. Not every field needs it -- only fields where a missing value means the extraction failed.

## Intake limits

Before Koji parses a document or sends a single token to an LLM, an intake integrity check runs. Header validation (MIME matches extension, PDF magic bytes are valid) and "at least one page was produced" are **always on** and require no configuration. Size, page, and type limits are opt-in per schema via the top-level `intake:` block:

```yaml
name: invoice
description: Standard invoice extraction

intake:
  max_size_mb: 25         # reject files bigger than 25 MB
  max_pages: 50           # reject documents longer than 50 pages
  allowed_types: [pdf]    # only accept PDFs — block docx, images, etc.

fields:
  invoice_number: ...
```

All three fields are optional. Any integrity failure is surfaced to the caller as an HTTP 400 with a clear reason (e.g. `"File is 34.2 MB, exceeds schema limit of 25 MB."`). Use limits to protect yourself from runaway cost, oversize uploads, or wrong-type files hitting a pipeline tuned for a specific format.

Recognized canonical types for `allowed_types`: `pdf`, `docx`, `xlsx`, `pptx`, `png`, `jpg`, `tiff`, `html`, `md`, `txt`.

## Normalization

Extraction gives you the values the LLM pulled from the document. Normalization turns those values into the shape your downstream systems actually want — currency as minor units, dates as ISO 8601, phone numbers as E.164, strings trimmed and slugified — without any LLM calls. It's pure Python running after the model returns.

Declare transforms per-field with a `normalize:` directive:

```yaml
fields:
  vendor_name:
    type: string
    normalize: [trim, lowercase]    # chain transforms, applied in order
  total_amount:
    type: number
    normalize: minor_units          # $1,234.56 → 123456 (cents)
  invoice_date:
    type: date
    normalize: iso8601              # "4/3/26" → "2026-04-03"
  contact_phone:
    type: string
    normalize: e164                 # (555) 123-4567 → +15551234567
  status:
    type: enum
    normalize: slugify              # "Active Status" → "active_status"
```

Transforms also apply to array-of-object rows — declare them on the inner property:

```yaml
line_items:
  type: array
  items:
    type: object
    properties:
      description:
        type: string
        normalize: trim
      total:
        type: number
        normalize: minor_units
```

### Built-in transforms

| Name | Effect |
|------|--------|
| **Strings & casing** | |
| `trim` | Strip leading/trailing whitespace |
| `lowercase` | ASCII-insensitive lowercasing |
| `uppercase` | ASCII-insensitive uppercasing |
| `title_case` | Capitalize the first letter of each word, lowercase the rest. Preserves already-uppercase tokens as acronyms. `"acme corp"` → `"Acme Corp"`; `"ACME corp"` → `"ACME Corp"` |
| `slugify` | Lowercase + replace non-alphanumerics with `_` + strip underscores at edges |
| **Whitespace & punctuation** | |
| `collapse_spaces` | Collapse runs of spaces/tabs to a single space. Preserves newlines (multi-line addresses keep their breaks). `"ACME   Corp"` → `"ACME Corp"` |
| `remove_spaces` | Strip every whitespace character — spaces, tabs, newlines, non-breaking spaces. For codes and identifiers where any embedded whitespace is noise. `"ABC 123"` → `"ABC123"`, `"555 123 4567"` → `"5551234567"` |
| `fix_punctuation_spacing` | Apply English-typographic spacing: remove space before `, . ; : ! ? )`; insert single space after `, ; :` when followed by a letter. Preserves initials (`J. R. R. Tolkien`) and decimals (`$1,234.56`). `"Smith , Jones"` → `"Smith, Jones"` |
| `prose` | Convenience preset for human-readable fields = `trim` + `collapse_spaces` + `fix_punctuation_spacing`. Use for names, addresses, descriptions — any field where readers expect standard English spacing. Codes and identifiers that may legitimately contain runs of whitespace should use `trim` alone instead. |
| **Dates** | |
| `iso8601` | Parse common date formats (ISO, `MM/DD/YYYY`, `MM-DD-YY`, etc.) to `YYYY-MM-DD` |
| **Numbers & money** | |
| `integer` | Parse a human-formatted integer to a Number; drops grouping commas, spaces, and underscores. `"1,234"` → `1234` |
| `decimal_amount` | Parse a human-formatted decimal to a Number; strips currency symbols and grouping, recognises accounting parentheses for negatives. `"$1,234.56"` → `1234.56`; `"(50.00)"` → `-50` |
| `minor_units` | Parse currency strings or numbers to integer minor units (cents). `($50.00)` → `-5000` |
| `percent` | Strip a trailing `%` and parse as a number. Does NOT divide by 100 — `"12%"` → `12`, preserving the human-written magnitude |
| `digits_only` | Strip every non-digit character. For account numbers, IDs, anything where formatting is presentational. `"(555) 123-4567"` → `"5551234567"` |
| **Booleans** | |
| `boolean` | Coerce common truthy/falsy strings to a real Boolean. Case-insensitive. `"yes"`, `"Y"`, `"true"`, `"1"`, `"on"` → `true`; the negative variants → `false` |
| **Identifiers** | |
| `email` | Trim + lowercase. Emails are case-insensitive in practice; lowering avoids accidental duplicates downstream |
| `url` | Trim, lowercase the scheme and host, drop a trailing `/` on path-root URLs. Preserves path case (path components are case-sensitive). Invalid URLs pass through unchanged |
| `e164` | Strip phone formatting; prefix `+1` for bare 10-digit US numbers |

Transforms are deterministic and fault-tolerant: if a value can't be parsed (e.g. `"next Tuesday"` through `iso8601`), the original value is passed through unchanged. Unknown transform names are recorded as warnings in the response's `normalization.warnings` list rather than raising.

### Resolve (field reference lookup)

Use `resolve` to populate a field by looking up another field's value. The template string uses `{field_name}` syntax to interpolate extracted values into a field name, then returns the value of that field.

```yaml
fields:
  insurer_a:
    type: string
  insurer_b:
    type: string
  gl_insurer_letter:
    type: string
    description: "Letter (A-E) identifying which insurer covers General Liability"
  gl_insurer_name:
    type: string
    resolve: "insurer_{gl_insurer_letter}"
```

If `gl_insurer_letter` extracts as `"A"`, the template resolves to `"insurer_a"`, and `gl_insurer_name` is set to whatever `insurer_a` contains (e.g. `"Trisura Insurance Company"`).

Resolve runs after all other normalization. It only fills fields that are null or empty -- it won't overwrite a value that was already extracted. This makes it safe to use alongside [form mappings](forms-guide.md) where some fields come from coordinates and others from LLM interpretation.

## Validation rules

Validation runs immediately after normalization. It evaluates a list of schema-declared rules against the extracted output and returns a report indicating which rules passed and which failed. Think of it as "turn extracted JSON into extracted and verified JSON" — the schema is the contract, and validation is the enforcement point before the data leaves Koji for downstream systems.

Declare rules at the top level of the schema:

```yaml
validation:
  - required: [invoice_number, total_amount, invoice_date]
  - not_empty: [line_items]
  - enum_in:
      field: currency
      allowed: [USD, EUR, GBP]
  - date_order: [issue_date, due_date]
  - sum_equals:
      field: total_amount
      sum_of: line_items.total
      tolerance: 0.01
  - regex:
      field: invoice_number
      pattern: "^INV-\\d+$"
```

Each list entry is a single-key dict. The key is the rule type; the value is either a list of field names (for rules that just reference fields) or a dict of parameters.

### Built-in rules

| Rule | Shape | Description |
|------|-------|-------------|
| `required` | list of fields | Fail if any listed field is null, empty string, or empty list |
| `not_empty` | list of fields | Fail if any listed field has zero length |
| `enum_in` | `{field, allowed}` | Fail if the field's value is not in the allowed list |
| `date_order` | list of date fields | Fail if the dates are not in ascending order (ties allowed) |
| `sum_equals` | `{field, sum_of, tolerance?}` | Fail if `field` != sum of the dotted `sum_of` path (default tolerance 0.01) |
| `field_sum` | `{field, addends, tolerance?, auto_correct?}` | Fail if `field` != sum of the listed top-level fields; `auto_correct: true` replaces `field` with the computed sum |
| `min_words` | `{field, min?, on_fail?}` | Enforce a minimum word count on a string field (default `min: 5`). `on_fail: null` (default) nulls the field; `on_fail: error` keeps the field and reports a hard error |
| `max_words` | `{field, max?, on_fail?}` | Enforce a maximum word count on a string field (default `max: 500`). Same `on_fail` semantics as `min_words` |
| `regex` | `{field, pattern}` | Fail if the field's value does not match the regex |

`sum_of` accepts a dotted path that crosses arrays: `line_items.total` sums `row.total` across every row.

`min_words` / `max_words` example — catch a classification code where a narrative is expected, without hard-failing the extraction:

```yaml
validation:
  - min_words:
      field: description
      min: 20
      on_fail: null   # soft: null the field so downstream sees "no value" rather than a short code
  - max_words:
      field: summary
      max: 100
      on_fail: error  # hard: report a failure if the summary is too long
```

### Response shape

Every extraction response now includes a `validation` block alongside `extracted`:

```json
{
  "extracted": { ... },
  "validation": {
    "ok": false,
    "issues": [
      {"rule": "sum_equals", "field": "total_amount", "message": "total_amount=100 but sum of line_items.total=95 (tolerance 0.01)"}
    ]
  },
  "normalization": {
    "applied": [
      {"field": "vendor_name", "transform": "trim"},
      {"field": "total_amount", "transform": "minor_units"}
    ],
    "warnings": []
  }
}
```

`validation.ok` is `true` only when every rule passes. The `issues` list contains only failures, so a passing run returns an empty list. Use this to decide whether to accept the extraction into your downstream system, hand it off for human review, or reject it outright.

Validation never raises on malformed rule entries: a bad rule definition surfaces as an issue in the report so your pipeline keeps running and you can see exactly which rule is broken.

## Document fit — "is this even the right document?"

`intake` guards on file properties and `validation` guards on extracted values. The `fit` block guards on something in between: **does this document belong to this schema at all?**

The motivating case: a user uploads into a slot in their portal that is bound to one schema, and sometimes drops in the wrong document — an invoice where a policy was expected. Without `fit`, the pipeline extracts anyway and hands back a payload full of nulls, leaving the user to squint at a bad result and guess what went wrong. With `fit`, Koji returns a clear signal — *"this doesn't look like a policy"* — that your portal can render directly.

`fit` combines two independent mechanisms. Declare either, both, or neither:

```yaml
name: insurance_policy

fit:
  # ── Asserted pre-extraction gate (cheap; can skip extraction) ──
  keywords: [policy, insured, premium]        # zero-cost text scan
  min_keywords: 2                              # how many must appear (default 1)
  requires: "a commercial insurance policy"    # one yes/no LLM call

  # ── Derived post-extraction signal (free; reuses provenance) ──
  anchor_fields: [policy_number, effective_date]  # default: the required fields
  min_score: 0.4                               # misfit below this mean anchor score

  # ── Action ──
  on_misfit: warn                              # warn (default) | reject

fields:
  policy_number: { type: string, required: true }
  effective_date: { type: date, required: true }
```

**The asserted gate runs *before* extraction.** The `keywords` check is pure string matching and free — it asks whether at least `min_keywords` of the listed terms appear anywhere in the document. The `requires` check is a single yes/no LLM call that asks the model whether the document matches your plain-language description. Because both run up front, a misfit can skip extraction entirely and save the cost.

**The derived signal runs *after* extraction and costs nothing.** It reuses the per-field grounding Koji already computes for [confidence scoring](#response-shape): for each anchor field, how strongly was the extracted value found in the source text? `anchor_fields` defaults to your schema's `required` fields — the fields that must exist in a genuine instance of this document. The mean anchor grounding is the **fit score**; a document whose anchors are all ungrounded (everything came back null) is, by that fact, the wrong document.

### `on_misfit`: warn vs. reject

- **`warn`** (default) never blocks. The document is always extracted and the `fit` verdict rides along in the response, so your application decides what to do — accept, flag for review, or discard.
- **`reject`** short-circuits the pre-extraction gate: if a keyword or `requires` check fails, extraction is skipped, the extracted fields come back as `null`, and `fit.extraction_skipped` is `true`. (The derived signal can't skip extraction — it's computed from the extraction itself — so under `reject` it still flags the response but the work has already run.)

Unlike `intake`, a fit misfit is **not** an HTTP 400. A well-formed PDF that happens to be the wrong *kind* of document is a legitimate request that simply doesn't belong in this slot — so the caller gets a normal `200` response with `fit.ok = false` and a human-readable `message`, not an error.

### Response shape

Every response from a schema with a `fit` block carries a `fit` object alongside `extracted` and `validation`:

```json
{
  "extracted": { "policy_number": null, "effective_date": null },
  "fit": {
    "ok": false,
    "action": "warn",
    "reason": "low_field_grounding",
    "message": "This does not look like a 'insurance_policy' document: only 0 of 2 anchor field(s) ([\"policy_number\",\"effective_date\"]) were found in the source.",
    "score": 0.0,
    "extraction_skipped": false,
    "checks": [
      {"name": "keywords", "ok": false, "detail": {"required": 2, "matched": 0, "matched_keywords": [], "keywords": ["policy", "insured", "premium"]}},
      {"name": "derived",  "ok": false, "detail": {"score": 0.0, "min_score": 0.4, "anchors_found": 0, "anchors_total": 2, "anchor_fields": ["policy_number", "effective_date"]}}
    ]
  }
}
```

`fit.ok` is `true` only when every declared check passes. When it's `false`, `reason` is one of `insufficient_keywords`, `failed_assertion`, or `low_field_grounding`, and `message` is a ready-to-display explanation. `checks` lists every check that ran so you can see exactly which one tripped.

The `requires` assertion **fails open**: if the model call errors or returns unparseable JSON, the check passes rather than blocking a legitimate upload on a transient model hiccup.

**With the classifier enabled** ([`apply_to`](#targeting-specific-document-types-with-apply_to)), the derived grounding signal is a no-op — per-section relevance is already `apply_to`'s job — but the document-level `keywords`/`requires` gate still runs and rides at the top level of the response.

## Targeting specific document types with `apply_to`

When you run Koji against a **packet** — a single upload containing multiple stapled-together documents (an invoice + a certificate of insurance + a policy declaration, say) — you usually want each schema to extract only from the section that contains its type of data. The classifier stage in the pipeline can split a packet into typed sections, and the `apply_to` schema key tells the router which of those sections this schema should run against.

```yaml
name: insurance_policy
description: Commercial insurance policy extraction
apply_to: [policy]          # only run against sections classified as "policy"

fields:
  policy_number: ...
```

The type IDs in `apply_to` must match the ones declared in your `koji.yaml` classifier config (see `docs/configuration.md` for the classify block). You can target multiple types in one schema:

```yaml
apply_to: [policy, coi]     # match either policy OR coi sections
```

**When the classifier is disabled** (the default, and the state of every Koji install that hasn't opted in), `apply_to` is ignored. Adding it to a schema is a no-op under a single-document pipeline — safe to sprinkle in now and activate later.

**When the classifier is enabled and a schema has no `apply_to`**, behavior depends on the `require_apply_to` flag in `koji.yaml`:

- `require_apply_to: false` (default, forgiving): the schema runs against *every* section the classifier produces, regardless of type. Good for migration.
- `require_apply_to: true` (strict): missing `apply_to` is a config error and extraction raises a clear message at call time. Turn this on once you have more than a few schemas and want to prevent accidental cross-section extraction.

**When `apply_to` matches multiple sections** — a packet with three stapled invoices and an invoice schema — extraction runs once per matching section and each result comes back as its own entry in the output. When it matches zero sections, extraction returns an empty list and an explicit `no_matching_section` reason. See the [classify-split design doc](design/classify-split.md) for the full output shape and pipeline contract.

## Schema hints

Hints are the key differentiator in Koji's extraction pipeline. Instead of sending the entire document to the model and hoping it finds your fields, hints tell the router exactly where to look.

Without hints, Koji uses generic inference -- matching field names and types against document content. This works for simple documents. For complex multi-section documents (insurance policies, contracts, regulatory filings), hints dramatically improve accuracy and reduce token usage.

```yaml
policy_number:
  type: string
  required: true
  description: Policy number or ID
  hints:
    look_in: [declarations]
    patterns: ["policy.*(?:number|no|#)", "[A-Z]{2,5}\\d{5,}"]
    signals: [has_key_value_pairs]
```

> Want a domain-specific signal like `has_policy_numbers`? Define it as a custom signal in your schema. See the [signals](#signals) section below.

### look_in

Routes the field to specific document categories. `look_in` is a **hard filter**: when any chunk matches one of the listed categories, the router only considers those chunks for this field. Patterns and signals then rank within that filtered pool. If no chunk matches the listed categories, the router falls back to scoring the full document with the remaining hints so the field still gets routed.

```yaml
hints:
  look_in: [header, totals]
```

Categories are **defined entirely by your schema**. Koji ships with no built-in categories — instead, the schema's `categories.keywords` block tells the mapper which keywords identify which sections of your documents. Without category definitions, every chunk is `other` and `look_in` has nothing to match against.

Define categories at the top of your schema:

```yaml
name: invoice
description: Commercial invoice extraction

categories:
  keywords:
    header: ["invoice", "bill to", "ship to", "invoice number"]
    line_items: ["description", "quantity", "unit price"]
    totals: ["subtotal", "tax", "total due", "balance"]

fields:
  invoice_number:
    type: string
    required: true
    hints:
      look_in: [header]
  ...
```

Categories are detected from section titles (strong signal — one keyword in the title matches) and content keywords (weaker signal — requires 2+ keyword matches in the body). Sections that don't match any defined category are labeled `other`.

For an insurance schema, you might define categories like `declarations`, `endorsement`, `conditions`, `exclusions`, etc. For a contract, `parties`, `term`, `compensation`, `termination`. The right categories are the ones that match your document type.

#### Tuning classification

The defaults work well for most documents, but long-section or sparse-keyword documents sometimes need different tradeoffs. Override them under a top-level `classification` block:

```yaml
classification:
  window: 1500          # chars of chunk content scanned for keywords (default 500)
  threshold: 1          # min keyword hits required to match a category (default 2)
  scan: head_and_tail   # head | all | head_and_tail (default head)
  title_priority: true  # title keyword match short-circuits content scan (default true)
```

- **`window`** — how much of each chunk's body is scanned. Raise it for long sections where the classifying keywords live deep in the body. Lower it on short documents where you want to avoid incidental matches.
- **`threshold`** — how many distinct keywords from the category must appear in the scanned text. The default (2) reduces false positives from single-word overlap. Drop it to 1 when your categories are already specific enough that a single keyword is unambiguous.
- **`scan`** — how the window is sampled from the content:
    - `head` (default): first `window` characters
    - `all`: the entire chunk, regardless of `window`
    - `head_and_tail`: first `window/2` + last `window/2` characters — useful when a category's keywords consistently cluster at the top *or* bottom of a long section
- **`title_priority`** — when `true` (default), a title match short-circuits the content scan. Set to `false` if your document titles are generic (e.g. "Section 1", "Page 2") and misleading.

Unknown or invalid values silently fall back to defaults, so you can add these knobs without worrying about breaking the schema.

### prefer_contains

A list of case-insensitive phrases. Chunks whose title or content contains *any* of the phrases get a strong score bonus (below `look_in` but above `patterns`). Use it when the right chunk for a field is reliably identified by a distinctive phrase that regex patterns can't easily express — or when body chunks with generic keyword matches would otherwise outscore the chunk that actually holds the value.

```yaml
fields:
  filing_date:
    hints:
      prefer_contains: ["/s/", "Dated:", "SIGNATURES"]
```

Common pattern: the real value lives in a signature block at the bottom of the document (e.g. SEC filings, contracts), while the body text is full of matches for "filing date" / "dated" that score higher under category and pattern hints alone. `prefer_contains` boosts the signature chunk so it wins.

The bonus is applied at most once per chunk no matter how many phrases match — if you want an additional bump for stronger matches, use `patterns` or `signals` as well.

### patterns

Regex patterns matched against chunk titles and content. Medium priority -- patterns score below `look_in` but above signals.

```yaml
hints:
  patterns: ["policy.*(?:number|no|#)", "[A-Z]{2,5}\\d{5,}"]
```

Patterns are matched case-insensitively against the first 1500 characters of each chunk (title + content). Use them to:

- Match labels near your target value: `"effective.*date"`, `"total.*premium"`
- Match the value format itself: `"[A-Z]{2,5}\\d{5,}"` for policy numbers
- Match section indicators: `"schedule of.*coverage"`

Tips:
- Use `.*` for flexible spacing between words
- Use `(?:...)` for non-capturing groups
- Keep patterns broad enough to match variations (abbreviations, different formatting)
- One matching pattern is enough -- you don't need all patterns to match

### signals

Content signals detected automatically by the document mapper. Lowest priority among hints, but useful for disambiguation when multiple chunks could match a field.

```yaml
hints:
  signals: [has_dollar_amounts, has_tables]
```

**Built-in signals:**

| Signal | Detects |
|--------|---------|
| `has_dollar_amounts` | Currency amounts: `$1,234.56`, `€500`, `£200`, `¥1000`, `1234.56 USD`, etc. |
| `has_dates` | Date patterns (`MM/DD/YYYY`, `YYYY-MM-DD`, `DD.MM.YYYY`, etc.) |
| `has_key_value_pairs` | Lines formatted as `Key: Value` |
| `has_tables` | Pipe-delimited table rows (`\| ... \| ... \|`) |

Signals are boolean — either the chunk has the signal or it doesn't. Each matching signal adds a small score boost.

**Custom signals**

Built-in signals are purely structural. For domain-specific patterns (policy numbers, invoice numbers, named insured references, etc.), define **custom signals** in your schema:

```yaml
signals:
  has_policy_numbers:
    pattern: "[A-Z]{2,5}\\d{5,}"

  has_named_insured:
    pattern: "(?:named\\s+insured|policyholder)\\s*[:.]"
    flags: "i"

  has_invoice_id:
    pattern: "INV[\\s-]?\\d{4,}"
    flags: "i"
```

Each custom signal needs a `pattern` (a regex). Optional `flags` accept `i` (case-insensitive), `m` (multiline), and `s` (dotall). If the regex matches anywhere in a chunk's content, the signal is set to `true` and a `<name>_count` is set to the number of matches.

Once defined, custom signals can be referenced in field hints just like built-in ones:

```yaml
fields:
  policy_number:
    type: string
    hints:
      signals: [has_policy_numbers, has_key_value_pairs]
```

This is how Koji stays domain-agnostic: structural signals are built in, anything insurance-specific (or invoice-specific, or contract-specific) lives in your schema.

### max_chunks

By default, each field is routed to the top 3 scoring chunks. Override this for fields that legitimately need to aggregate data from many chunks:

```yaml
hints:
  max_chunks: 12
```

Use this for arrays of objects that span the document. Example: an insurance certificate's `policies` array, where each policy's detail lives in its own H3 section. The default cap of 3 misses most of the policies; setting `max_chunks: 12` lets the router pull from every detail section.

Don't set this for simple scalar fields — it just wastes tokens.

### How hints interact

`look_in` is a **hard filter**. If any chunk matches one of the listed categories, the router considers *only* those chunks for the field — other chunks are excluded entirely, even if their patterns or signals would have scored higher. Declaring `look_in: [declarations]` is a promise from the schema author that the value lives in declarations; the router takes the promise at face value.

Within the filtered pool, `prefer_contains`, `patterns`, and `signals` rank which chunks win the slots:

1. **prefer_contains** — +15 points if any phrase is found (applied at most once; matches the `look_in` weight so a distinctive phrase is decisive against a body chunk that only matches broad patterns + signals)
2. **patterns** — +8 points if any regex pattern matches (only the first match counts)
3. **signals** — +4 points per matching signal

If `look_in` is set but no chunks match the listed categories (e.g., the schema author referenced a category the document doesn't have), the router falls back to scoring every chunk with `patterns` + `signals` so the field still gets routed somewhere. Generic inference (field name matching, type-based signals) is skipped whenever any hint is defined — hints are authoritative.

The top 3 scoring chunks are selected for each field by default (or up to `max_chunks` if you've set it). Fields that share the same top chunks are grouped into a single extraction call to minimize LLM usage.

### When to use hints vs. letting the router infer

**Skip hints when:**
- Your document is short (1-3 pages)
- Field names are descriptive and match how they appear in the document
- There's only one place a value could be

**Add hints when:**
- Documents have multiple sections where a value *could* appear but only one is correct
- The same term appears in different contexts (e.g., "date" appears in 10 places)
- You need precision on complex documents (20+ pages)
- Extraction is returning values from the wrong section

Start without hints, test extraction, and add hints where accuracy is poor.

## Extraction hints

`description` on a field tells Koji (and the reader) what a field *means*. For tricky fields you also need to tell the model *how* to pick the right value — especially when the document has many plausible candidates and simple keyword matching isn't enough. That's what `extraction_hint` is for:

```yaml
fields:
  filing_date:
    type: date
    required: true
    description: Date the filing was submitted to SEC.
    extraction_hint: |
      The authoritative filing date is in the signature block at the
      bottom of the document — look for lines like
      "/s/ Officer Name ... Dated: April 9, 2026".

      For AMENDMENT forms (10-K/A, 10-Q/A, 8-K/A), the EXPLANATORY NOTE
      may reference the ORIGINAL filing date. Do NOT use that — the
      filing_date is the date the AMENDMENT was filed, which appears
      in the signature block.

  period_of_report:
    type: date
    description: Fiscal period the filing covers.
    extraction_hint: |
      period_of_report is the fiscal period the filing covers — NOT the
      submission date, signature date, or preparer date. Look on the
      COVER PAGE for the form-specific label:
        - 10-K:    "For the fiscal year ended <date>"
        - 10-Q:    "For the quarterly period ended <date>"
        - 8-K:     "Date of Report (Date of earliest event reported): <date>"
        - DEF 14A: the scheduled meeting date ("to be held on <date>")
```

Extraction hints are rendered into a dedicated `## Extraction notes` block in the prompt the LLM sees, right under the field list. The wording is free-form — write whatever the model needs to disambiguate.

**When to use `extraction_hint` instead of `description`:**

- `description` is a short, reader-facing summary of what the field means. It ends up in the field list line (`- filing_date: date — Date the filing was submitted`). Keep it under one sentence.
- `extraction_hint` is multi-line model-facing guidance about *which of several candidates* to pick and *why*. Use it for fields where the document has obvious-looking distractors (e.g. an amendment form's EXPLANATORY NOTE references both the original and current dates).

Hints also flow into the gap-fill pass, so fields that time out on the main extraction attempt still get the guidance on retry. Fields without an `extraction_hint` don't get an "Extraction notes" block — it's only rendered when at least one field in the group provides one.

### Conditional hints based on other fields

Sometimes the right guidance for a field depends on another field's value. Classic SEC example: `period_of_report` means different things across form types — "fiscal year ended" for a 10-K, "quarterly period ended" for a 10-Q, "Date of Report" for an 8-K, and the annual meeting date for a DEF 14A. Writing one `extraction_hint` covering all of them would overwhelm the model; writing a narrow one would only help for one form.

Two things make this work: `depends_on` declares that a field's extraction should run *after* another field, and `extraction_hint_by` maps the parent field's value to a specific hint:

```yaml
fields:
  form_type:
    type: enum
    required: true
    options: [10-K, 10-K/A, 10-Q, 8-K, DEF 14A]
    hints:
      look_in: [header]

  period_of_report:
    type: date
    required: true
    depends_on: [form_type]
    extraction_hint: |
      Fallback: the fiscal period the filing covers, on the cover page.
    extraction_hint_by:
      form_type:
        "10-K":    "Look for 'For the fiscal year ended <date>' on the cover page."
        "10-K/A":  "Same fiscal period as the ORIGINAL 10-K this amends — NOT the amendment filing date."
        "10-Q":    "Look for 'For the quarterly period ended <date>' on the cover page."
        "8-K":     "Use the 'Date of Report (Date of earliest event reported)' from the cover."
        "DEF 14A": "The scheduled annual meeting date ('to be held on <date>' near the top)."
```

Under the hood, Koji topologically sorts fields into **extraction waves**. `form_type` has no `depends_on`, so it lands in wave 0 and extracts normally. `period_of_report` depends on `form_type`, so it lands in wave 1 and only routes/extracts after wave 0 completes. Before wave 1 runs, Koji resolves every dependent field's `extraction_hint_by` against the values already extracted — in this example, `period_of_report`'s `extraction_hint` becomes the 10-K/A line if that's what the document turned out to be.

**Fallback behavior**:
- If the parent field is still null after its wave (extraction failed, optional and missing), the dependent field falls back to its unconditional `extraction_hint`.
- If the parent's extracted value isn't in the `extraction_hint_by` map, same fallback.
- Empty or whitespace-only hint strings are ignored — also a fallback.

**Cost**: within a wave, field grouping still minimizes LLM calls the same way as before. Across waves, dependent fields can't group with their parents, so you pay one extra LLM call per dependent wave. For a typical SEC schema that's 1 extra call per document — worth it for targeted per-form guidance.

**Rules**:
- `depends_on` must reference fields defined in the same schema — unknown names raise a schema error.
- Circular dependencies (`a` depends on `b`, `b` depends on `a`) raise an error at extraction time.
- Self-dependencies are rejected.
- `depends_on` applies the ordering constraint regardless of whether `extraction_hint_by` is present, so you can use it just to sequence extraction if that's useful on its own.

If `depends_on` becomes too heavy for your schema, the alternative is to split the polymorphic field into form-specific fields (`period_fiscal_year_end`, `period_quarter_end`, `period_date_of_report`, `period_meeting_date`) with narrow hints each, and normalize them at a later layer. Both approaches are supported.

### Conditional vocabularies based on other fields

`extraction_hint_by` changes the *guidance* based on a sibling field. `vocab_by` goes a step further and changes the *allowed values* (a `mapping` or `enum` vocabulary) based on a sibling field's value.

The classic case: a coverage row's valid `applies_to` codes depend on the row's `coverage`. Declare the per-value vocabularies under `vocab_by`, keyed by the sibling field and then by its value:

```yaml
coverages:
  type: array
  items:
    type: object
    properties:
      coverage:
        type: enum
        options: [crime, general_liability]
      applies_to:
        type: mapping
        vocab_by:
          coverage:                         # the sibling field, in the same row
            crime:
              mappings:
                employee_theft: ["Employee Theft", "EE Theft"]
                forgery: ["Forgery or Alteration"]
            general_liability:
              mappings:
                each_occurrence: ["Each Occurrence", "Per Occurrence"]
                general_aggregate: ["Aggregate", "Gen Agg"]
        vocab_default:                       # optional: used when no branch matches
          mappings:
            other: []
```

How it resolves, per row:

1. Koji picks the branch whose key matches the row's `coverage` value (e.g. `crime`).
2. The row's `applies_to` is resolved against *only that branch* — so `"EE Theft"` on a crime row becomes `employee_theft`, but a general-liability code on a crime row will not match and is flagged as a validation issue (`rule: conditional_vocab`).
3. If no branch matches and a `vocab_default` is declared, the default vocabulary is used. If no branch matches and there's no default, the value is left as-is and a validation issue is reported so it surfaces in review.

For **array items** (above), all rows come back from a single extraction call, so Koji can't pre-pick a per-row vocabulary in the prompt. Instead it shows the model the whole decision table as guidance and then enforces the correct branch deterministically after extraction. Correctness comes from that post-extraction step — as long as the row's `coverage` is extracted, the `applies_to` is resolved against the right vocabulary regardless of what the model guessed.

For **top-level scalar fields**, add `depends_on` so the sibling extracts first (same wave mechanics as `extraction_hint_by`); once its value is known, the dependent field's prompt is narrowed to just the selected branch:

```yaml
fields:
  coverage:
    type: enum
    options: [crime, general_liability]
  applies_to:
    type: mapping
    depends_on: [coverage]
    vocab_by:
      coverage:
        crime: { mappings: { employee_theft: ["EE Theft"] } }
        general_liability: { mappings: { each_occurrence: ["Each Occ"] } }
```

Each branch is an ordinary vocabulary block (`mappings`, `options`, or `values`), so it composes with [anchors and `_defs`](#reusing-definitions-dry-schemas) — define a vocabulary once and reference it from multiple branches:

```yaml
_defs:
  crime_codes: &crime_codes
    mappings:
      employee_theft: ["EE Theft"]
      forgery: []
fields:
  # ...
  applies_to:
    type: mapping
    vocab_by:
      coverage:
        crime: *crime_codes
```

## Heading inference

The document mapper splits parsed markdown into chunks at `#` headings. For clean PDFs with structured layout, docling emits headings just fine. For OCR'd scans, invoices, and table-heavy forms, the parsed markdown often comes out with no `#` markers at all — and the chunker collapses the whole document into one giant chunk.

When that happens, Koji runs a **heading inference** pass before chunking. It promotes visually prominent standalone lines to `##` headings so the chunker has something to split on:

- **Bold lines** on their own paragraph: `**Bill To**`, `**Invoice Summary:**`
- **ALL CAPS short lines** above content: `INVOICE`, `SOLD TO:`, `SECTION 1`
- **Schema-defined regex patterns** (see below)

Inference only runs when the parsed markdown contains zero `#` headings — well-structured input is left untouched. Lines must start a fresh paragraph (blank line above) to be promoted, which avoids over-promoting bold spans inside flowing prose.

Consecutive bold or ALL CAPS lines separated only by blanks are treated as a single **stanza** — think cover pages, title blocks, multi-line company names. Short stanzas (up to four lines) are merged into one heading so multi-line titles like `**CXJ**` / `**GROUP CO., Limited**` stay intact as a single chunk anchor. Longer stanzas (five or more lines) are assumed to be word-wrapped boilerplate — common when parsers bold every word on an SEC cover page or legal front matter — and nothing is promoted; the whole block falls through to `Document Start` instead. The stanza resets on any non-heuristic content, so a real chapter heading after the stanza is still detected.

Bold lines whose content is mostly digits or punctuation (phone numbers, ZIP codes, registration IDs) are skipped entirely — they aren't semantic headings even when the parser marks them bold.

### Custom heading patterns

If your documents have structural markers that don't fit the bold / ALL CAPS heuristics, declare them explicitly:

```yaml
headings:
  patterns:
    - "^EXHIBIT [A-Z]$"
    - "^ARTICLE \\d+\\."
```

Patterns must `fullmatch` the line. They take priority over the generic heuristics and are matched even on short lines that the all-caps rule would skip. A pattern match also breaks out of a stanza, so you can use patterns to carve up sections that the bold/ALL CAPS heuristics would otherwise merge.

### Patterns-only mode

If your documents have stylistic bold or ALL CAPS lines that aren't actually structural (marketing copy, emphasized phrases, legalese boilerplate), you can disable the generic heuristics while keeping explicit schema patterns:

```yaml
headings:
  generic: false
  patterns:
    - "^PART [IVX]+$"
    - "^SCHEDULE [A-Z]$"
```

With `generic: false`, bold and ALL CAPS lines are left alone and only your declared patterns produce synthetic headings.

### Disabling inference

If your parser already produces clean headings and you'd rather skip the whole pass:

```yaml
headings:
  infer: false
```

`infer: false` is the master kill-switch — it disables both generic heuristics and schema patterns.

## Arrays and nested objects

Arrays extract repeated structures -- tables, line items, coverage lists, anything that appears multiple times.

### Table extraction

The most common array pattern extracts tabular data:

```yaml
coverages:
  type: array
  description: List of coverages with limits
  items:
    type: object
    properties:
      coverage_name:
        type: string
      limit:
        type: string
      deductible:
        type: string
  hints:
    look_in: [schedule_of_coverages, declarations]
    signals: [has_tables, has_dollar_amounts]
    patterns: ["coverage", "limit", "deductible"]
```

The extraction model identifies rows in tables, bulleted lists, or repeated structures and returns them as an array of objects.

### Field types and rules apply inside items

An item property is a full field spec, not just a type label. Everything you can declare on a top-level field works identically on a field nested inside an array item (or a nested object):

- **Type coercion** — `type: number` strips currency/grouping and parses to a number, `type: date` normalizes to `YYYY-MM-DD`, `type: boolean` coerces yes/no/checkbox text — the same at depth as at the top level.
- **Controlled vocabularies** — `type: enum` (`options:`) and `type: mapping` (`mappings:` with aliases) are shown to the model in the prompt *and* resolved to their canonical value for nested fields, so an `applies_to` code or carrier label inside `coverages[]` lands on the canonical form.
- **Normalization** — per-item `normalize:` transforms (see [Normalization](#normalization)).
- **Per-item validation** — declare a `validation:` block on the `items` schema to run rules against each row; failures are reported with a `field[i].subfield` path.

```yaml
coverages:
  type: array
  items:
    type: object
    properties:
      applies_to:
        type: mapping            # resolved per row, vocabulary shown to the model
        mappings:
          each_occurrence: ["Each Occurrence", "Per Occurrence"]
          general_aggregate: ["Aggregate", "Gen Agg"]
      limit:
        type: number             # "$1,000,000" -> 1000000, per row
    validation:
      - required: [applies_to]    # checked on every row
```

Nesting can go two levels deep — an item property can itself be an `array` of objects (e.g. `coverages[] -> limits[] -> {applies_to, limit}`), and type coercion, vocabularies, normalization, and validation all apply at the deeper level too.

### Arrays with hints

Hints on array fields route to chunks containing the tabular/repeated data. The `has_tables` signal is particularly useful -- it fires on any chunk with pipe-delimited markdown tables.

```yaml
line_items:
  type: array
  items:
    type: object
    properties:
      description:
        type: string
      amount:
        type: number
  hints:
    signals: [has_tables, has_dollar_amounts]
    patterns: ["item", "description", "amount"]
```

### Reconciliation for arrays

When multiple extraction groups return results for the same array field, Koji concatenates and deduplicates them. This means array fields spanning multiple pages or sections are merged automatically.

## Enum matching

Enum fields constrain extraction to a predefined set of values. Koji applies fuzzy matching in this order:

1. **Exact match** -- value matches an option exactly
2. **Case-insensitive match** -- `"general liability"` matches `"General Liability"`
3. **Substring match** -- `"Gen. Liability"` matches `"General Liability"` (option contains value or value contains option)

If no match is found, the raw extracted value is returned with a validation issue logged.

Best practices for enum options:
- Use the full, unabbreviated form as the option value
- Include an "Other" option as a catch-all
- Keep the list to 15 or fewer options (more options = more ambiguity for the model)

```yaml
status:
  type: enum
  options:
    - Active
    - Cancelled
    - Expired
    - Pending
    - Other
```

## Tips and patterns

### Invoices

Invoices are usually short, well-structured documents. Hints are often unnecessary.

```yaml
name: invoice
description: Standard invoice extraction

fields:
  invoice_number:
    type: string
    required: true
    description: The invoice or reference number

  date:
    type: date
    required: true
    description: Invoice issue date

  due_date:
    type: date
    description: Payment due date

  vendor:
    type: string
    description: Vendor or supplier name

  bill_to:
    type: string
    description: Customer or recipient name

  line_items:
    type: array
    items:
      type: object
      properties:
        description:
          type: string
        quantity:
          type: number
        unit_price:
          type: number
        total:
          type: number

  subtotal:
    type: number
    description: Subtotal before tax

  tax:
    type: number
    description: Tax amount

  total_amount:
    type: number
    required: true
    description: Total amount due
```

### Contracts

Contracts are long and multi-section. Use `look_in` heavily.

```yaml
name: contract
description: Commercial contract extraction

categories:
  keywords:
    parties: ["party", "parties", "between", "by and between"]
    terms: ["term", "effective date", "commencement", "duration"]
    payment: ["payment", "compensation", "fee", "invoice"]
    termination: ["termination", "cancel", "expir"]

fields:
  party_a:
    type: string
    required: true
    description: First party name
    hints:
      look_in: [parties]
      patterns: ["(?:party|first party|between).*?(?:,|and)"]

  party_b:
    type: string
    required: true
    description: Second party name
    hints:
      look_in: [parties]
      patterns: ["(?:and|second party)"]

  effective_date:
    type: date
    hints:
      look_in: [terms]
      patterns: ["effective.*date", "commenc"]
      signals: [has_dates]

  termination_date:
    type: date
    hints:
      look_in: [terms, termination]
      patterns: ["terminat", "expir", "end.*date"]
      signals: [has_dates]

  contract_value:
    type: number
    description: Total contract value or annual fee
    hints:
      look_in: [payment]
      patterns: ["(?:total|contract).*(?:value|amount|fee)"]
      signals: [has_dollar_amounts]
```

### Insurance policies

Policies are the most complex -- many sections, many fields, overlapping terminology. Use the full hint system.

See `schemas/examples/insurance_policy.yaml` for a complete working example with custom categories, pattern matching, and signal routing.

Key patterns:
- Define custom categories matching your document's section structure
- Use `look_in: [declarations]` for most identifying fields (policy number, dates, insured name)
- Use `look_in: [schedule_of_coverages]` for coverage arrays
- Combine `has_dollar_amounts` with patterns to distinguish premium from limits

### Forms and applications

Forms have dense key-value pairs. The `has_key_value_pairs` signal is your friend.

```yaml
name: application
description: Insurance application form

fields:
  applicant_name:
    type: string
    required: true
    description: Applicant full name
    hints:
      patterns: ["(?:applicant|insured).*name"]
      signals: [has_key_value_pairs]

  business_type:
    type: enum
    options:
      - Corporation
      - LLC
      - Partnership
      - Sole Proprietor
      - Non-Profit
      - Other
    hints:
      patterns: ["(?:business|entity|organization).*(?:type|form)"]

  annual_revenue:
    type: number
    description: Annual revenue or gross sales
    hints:
      patterns: ["(?:annual|gross).*(?:revenue|sales|receipts)"]
      signals: [has_dollar_amounts]

  employee_count:
    type: number
    description: Number of employees
    hints:
      patterns: ["(?:number|#|num).*(?:employee|staff|worker)"]
```

## Full example: building a schema from scratch

Let's build a schema for medical bills. Walk through the process step by step.

**Step 1: Identify the fields you need.**

Look at a sample document. What data do you need in your system? Start with the obvious fields:

```yaml
name: medical_bill
description: Medical bill / explanation of benefits

fields:
  patient_name:
    type: string
    required: true
    description: Patient full name

  provider_name:
    type: string
    required: true
    description: Healthcare provider or facility name

  date_of_service:
    type: date
    description: Date services were rendered

  total_charges:
    type: number
    description: Total billed charges

  amount_due:
    type: number
    required: true
    description: Amount the patient owes
```

**Step 2: Test extraction without hints.**

```bash
koji extract ./parsed_bill.md --schema schemas/medical_bill.yaml --model openai/gpt-4o-mini
```

Check the output. Are fields correct? Missing? Pulled from the wrong section?

**Step 3: Add arrays for line items.**

Medical bills have procedure line items. Add them:

```yaml
  procedures:
    type: array
    description: List of procedures / services billed
    items:
      type: object
      properties:
        cpt_code:
          type: string
        description:
          type: string
        charges:
          type: number
        adjustments:
          type: number
        patient_responsibility:
          type: number
```

**Step 4: Add hints where extraction was inaccurate.**

Say `date_of_service` was pulling the statement date instead of the service date. Add hints:

```yaml
  date_of_service:
    type: date
    description: Date services were rendered
    hints:
      patterns: ["(?:date of|dos|service.*date)", "(?:from|through)"]
      signals: [has_dates]
```

Say `amount_due` was pulling total charges instead of patient responsibility:

```yaml
  amount_due:
    type: number
    required: true
    description: Amount the patient owes after insurance
    hints:
      patterns: ["(?:amount|balance).*(?:due|owe)", "patient.*(?:responsib|pay)"]
      signals: [has_dollar_amounts]
```

**Step 5: Add an enum for categorization.**

```yaml
  bill_type:
    type: enum
    description: Type of medical bill
    options:
      - Hospital
      - Physician
      - Laboratory
      - Pharmacy
      - Dental
      - Vision
      - Other
```

**Step 6: Final schema.**

```yaml
name: medical_bill
description: Medical bill / explanation of benefits

fields:
  patient_name:
    type: string
    required: true
    description: Patient full name
    hints:
      patterns: ["patient.*name", "member.*name"]
      signals: [has_key_value_pairs]

  provider_name:
    type: string
    required: true
    description: Healthcare provider or facility name
    hints:
      patterns: ["provider", "facility", "physician", "hospital"]

  date_of_service:
    type: date
    description: Date services were rendered
    hints:
      patterns: ["(?:date of|dos|service.*date)", "(?:from|through)"]
      signals: [has_dates]

  statement_date:
    type: date
    description: Date the bill/statement was generated
    hints:
      patterns: ["statement.*date", "bill.*date", "printed"]
      signals: [has_dates]

  bill_type:
    type: enum
    options:
      - Hospital
      - Physician
      - Laboratory
      - Pharmacy
      - Dental
      - Vision
      - Other

  procedures:
    type: array
    description: List of procedures / services billed
    items:
      type: object
      properties:
        cpt_code:
          type: string
        description:
          type: string
        charges:
          type: number
        adjustments:
          type: number
        patient_responsibility:
          type: number
    hints:
      signals: [has_tables, has_dollar_amounts]
      patterns: ["procedure", "service", "cpt", "charge"]

  total_charges:
    type: number
    description: Total billed charges before adjustments
    hints:
      patterns: ["total.*charge", "gross.*charge"]
      signals: [has_dollar_amounts]

  insurance_paid:
    type: number
    description: Amount paid by insurance
    hints:
      patterns: ["(?:insurance|plan).*paid", "(?:allowed|covered).*amount"]
      signals: [has_dollar_amounts]

  amount_due:
    type: number
    required: true
    description: Amount the patient owes after insurance
    hints:
      patterns: ["(?:amount|balance).*(?:due|owe)", "patient.*(?:responsib|pay)"]
      signals: [has_dollar_amounts]
```

Run extraction again. Iterate until accuracy is where you need it. Hints are surgical -- add them only where the router needs guidance.

## Adaptive routing (small documents)

Routing splits a document into chunks and sends each field only the chunks it scored highest for. That's essential on long documents, but on **small** documents it can drop useful surrounding context — and it costs extra LLM calls (one per field group, plus gap-fill retries). When a document has only a handful of chunks, sending the whole thing to the model in a single pass is at least as accurate and cheaper.

Koji does this automatically: when a document has **fewer than 10 chunks**, the pipeline skips per-field routing and extracts the whole document in one pass. Above the threshold it routes normally. The switch is keyed purely on chunk count — it is document-type agnostic.

You can tune or disable it per schema:

```yaml
routing:
  full_document_below: 10   # default. Documents with fewer chunks → single full-document pass.
                            # Set to 0 to always route per-field, regardless of size.
```

- **Default (`10`)**: full-document extraction below 10 chunks, routed extraction at 10+. Recommended.
- **`0`**: disables adaptive routing — every document is routed per-field. Use only if you have a specific reason to force routing on small documents.
- **Higher values**: extend full-document extraction to larger documents. Not recommended above ~10 — extraction accuracy degrades as the document grows, even when it still fits in the model's context window.

This only affects the single-document path. Documents processed through a `classify` step are routed per matched section as before.

## Key-value pair scanning

For documents with structured label-value data (forms, certificates, declarations pages), you can enable automatic key-value pair extraction alongside the schema-driven extraction:

```yaml
name: insurance_universal_scan
include_kv_pairs: true

fields:
  policy_number:
    type: string
    nullable: true
    description: Any policy or certificate number

  named_insured:
    type: string
    nullable: true
    description: Primary named insured or policyholder
```

When `include_kv_pairs: true` is set, the extraction result includes a `kv_pairs` array alongside the schema-defined fields:

```json
{
  "extracted": {
    "policy_number": "BKS-123456-78",
    "named_insured": "ABC Corporation"
  },
  "kv_pairs": [
    { "label": "Policy Number", "value": "BKS-123456-78" },
    { "label": "Named Insured", "value": "ABC Corporation" },
    { "label": "Effective Date", "value": "04/01/2026" },
    { "label": "General Aggregate Limit", "value": "$2,000,000" },
    { "label": "Each Occurrence", "value": "$1,000,000" },
    ...
  ]
}
```

**Key differences from schema-driven extraction:**

| | Schema fields | KV pairs |
|---|---|---|
| **Precision** | High — you define exactly what to extract | Lower — finds all label-value patterns |
| **Cost** | LLM API call per extraction | Zero — pure pattern matching on parsed markdown |
| **Coverage** | Only the fields you define | Everything that looks like `Label: Value` |
| **Use case** | Production pipelines with known document types | Document triage, universal scanning, discovery |

**When to use KV pairs:**

- **Document discovery** — "what's in this document?" before writing a schema
- **Universal scanning** — extract common identifiers (policy numbers, names, dates) from any document type without a specific schema
- **Triage and routing** — use KV pair content to classify documents and route them to specialized schemas
- **Audit** — capture everything the document says alongside the schema-driven extraction for compliance

KV pairs detect these patterns:
- `Label: Value` (colon-separated, including multi-word labels and values)
- `**Bold Label**: Value` (markdown bold labels)
- `| Label | Value |` (markdown table rows)

The default is `include_kv_pairs: false` — KV pairs are not included unless the schema opts in.
