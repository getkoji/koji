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

Enum matching is fuzzy -- if the document says "Gen. Liability" or "GL", Koji matches it to "General Liability". See [Enum matching](#enum-matching) for details.

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
    signals: [has_policy_numbers, has_key_value_pairs]
```

### look_in

Routes the field to specific document categories. This is the highest-priority hint -- if a chunk matches the category, it gets a large score boost.

```yaml
hints:
  look_in: [declarations, schedule_of_coverages]
```

**Available categories** (built-in):

| Category | Detected by keywords |
|----------|---------------------|
| `declarations` | "declaration", "dec page", "named insured", "policy period" |
| `schedule_of_coverages` | "schedule of", "coverage schedule", "limits of" |
| `endorsement` | "endorsement", "amendment", "rider", "this endorsement modifies" |
| `conditions` | "conditions", "general conditions", "policy conditions" |
| `definitions` | "definitions", "defined terms", "as used in this" |
| `exclusions` | "exclusion", "does not apply", "we will not pay" |
| `table_of_contents` | "table of contents", "index of forms" |
| `common_policy` | "common policy", "interline" |

Categories are detected from section titles (strong signal) and content keywords (requires 2+ keyword matches). Sections that don't match any category are labeled `other`.

You can also define **custom categories** in your schema using the `categories` block:

```yaml
name: insurance_policy
description: Commercial insurance policy extraction

categories:
  keywords:
    declarations: ["declaration", "dec page", "named insured", "policy period"]
    schedule_of_coverages: ["schedule of", "coverage schedule", "limits of"]
    endorsement: ["endorsement", "amendment", "rider", "this endorsement modifies"]
    conditions: ["conditions", "general conditions", "policy conditions"]
    exclusions: ["exclusion", "does not apply", "we will not"]
```

Custom categories extend the built-in ones. Define them when your document type has domain-specific sections.

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

Content signals detected automatically by the document mapper. Lowest priority among hints, but useful for disambiguation.

```yaml
hints:
  signals: [has_dollar_amounts, has_tables]
```

**Available signals:**

| Signal | Detects |
|--------|---------|
| `has_dollar_amounts` | Dollar signs followed by numbers (`$1,234.56`) |
| `has_dates` | Date patterns (`MM/DD/YYYY`, `YYYY-MM-DD`, etc.) |
| `has_tables` | Pipe-delimited table rows (`\| ... \| ... \|`) |
| `has_key_value_pairs` | Lines formatted as `Key: Value` |
| `has_policy_numbers` | Alphanumeric IDs matching `[A-Z]{2,5}\d{5,}` |
| `has_name_references` | Lines with "named insured", "policyholder", "name:" patterns |

Signals are boolean -- either the chunk has the signal or it doesn't. Each matching signal adds a small score boost.

### How hints interact

The router scores every chunk against every field. The scoring priority:

1. **look_in** -- +15 points if the chunk's category matches
2. **patterns** -- +8 points if any regex pattern matches (only the first match counts)
3. **signals** -- +4 points per matching signal

If a field has hints and any of them score > 0, the router uses only the hint-based score. Generic inference (field name matching, type-based signals) is skipped entirely. This means hints are authoritative -- once you add them, you're in control.

The top 3 scoring chunks are selected for each field. Fields that share the same top chunks are grouped into a single extraction call to minimize LLM usage.

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
      signals: [has_key_value_pairs, has_name_references]

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
      signals: [has_name_references]

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
