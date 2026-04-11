---
title: Schema Reference
description: Define extraction schemas — field types, arrays, nested objects, and validation.
---

# Schema Reference

Schemas define what structured data Koji extracts from your documents. Each schema is a YAML file.

## Basic Schema

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
  vendor:
    type: string
  total_amount:
    type: number
    required: true
```

## Field Types

| Type | Description | Example Value |
|------|-------------|---------------|
| `string` | Text value | `"INV-2026-0042"` |
| `number` | Integer or decimal | `4250.00` |
| `date` | Date value (ISO 8601) | `"2026-03-15"` |
| `boolean` | True or false | `true` |
| `array` | List of values | `[...]` |
| `object` | Nested structure | `{...}` |

## Field Options

```yaml
fields:
  vendor:
    type: string
    required: true        # fail extraction if missing (default: false)
    description: Vendor name  # hints for the extraction model
    default: "Unknown"    # fallback value
```

The `description` field is important — it guides the extraction model. Be specific about what the field represents and where it might appear in the document.

## Arrays

Extract repeating items like line items on an invoice:

```yaml
fields:
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
{
  "line_items": [
    {
      "description": "Widget A",
      "quantity": 10,
      "unit_price": 25.00,
      "total": 250.00
    },
    {
      "description": "Widget B",
      "quantity": 5,
      "unit_price": 50.00,
      "total": 250.00
    }
  ]
}
```

## Nested Objects

For structured sub-fields:

```yaml
fields:
  address:
    type: object
    properties:
      street:
        type: string
      city:
        type: string
      state:
        type: string
      zip:
        type: string
```

## Multiple Schemas

Point your pipeline at multiple schemas to handle different document types:

```yaml
pipeline:
  - step: extract
    model: openai/gpt-4o-mini
    schemas:
      - ./schemas/invoice.yaml
      - ./schemas/receipt.yaml
      - ./schemas/contract.yaml
```

Pair with a `classify` step to route documents to the right schema automatically.

## Schema Location

Schemas are referenced by path in `koji.yaml`. You can organize them however you like:

```
schemas/
  invoice.yaml
  receipt.yaml
  contracts/
    nda.yaml
    sow.yaml
```
