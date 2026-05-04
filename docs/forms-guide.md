---
title: Form Mappings Guide
description: Extract data from fixed-layout PDFs by position — no LLM needed. Draw boxes on a sample, map them to schema fields, and extract at near-zero cost.
---

# Form Mappings

Form mappings let you extract data from fixed-layout PDFs (ACORD certificates, carrier dec pages, government forms) by reading text at known coordinates. Instead of sending the entire document through an LLM, you draw boxes on a sample PDF and map them to schema fields.

**Why use form mappings?**

- **Speed.** Coordinate extraction is sub-second. No parse step, no LLM cold start.
- **Cost.** Direct text reads are free. Even LLM interpret regions cost ~$0.001 per document.
- **Accuracy.** You're reading text from exact positions — no model interpretation needed for simple fields.

Form mappings work alongside normal LLM extraction. Fields you map by coordinate are extracted instantly; fields you don't map get backfilled by the LLM automatically. Best of both worlds.

## How it works

1. **Upload a sample PDF** — a representative instance of the form you want to extract from.
2. **Draw boxes** on the PDF and assign each to a schema field.
3. **Test** with a different instance of the same form to verify coordinates line up.
4. **Activate** the form mapping — this generates a fingerprint for auto-detection.
5. **Run documents** through a pipeline — incoming PDFs that match the fingerprint use coordinate extraction automatically.

## Creating a form mapping

Navigate to a schema and click **Forms** in the sidebar. Click **New form mapping**, give it a name and slug, and upload a sample PDF.

The annotation page has two panels:

- **Left:** The sample PDF with a drawing overlay
- **Right:** Schema fields list with mapping status

### Drawing boxes

1. Click **Draw mode** to enable drawing.
2. Click and drag on the PDF to draw a rectangle around a field value.
3. A popover appears — pick the schema field to assign it to.
4. The box appears as a colored overlay with the field name.

Turn off draw mode to select, move, and resize existing boxes.

### Mapping types

Each mapping has a type that controls how the text is read:

**Text** (default) — reads the text inside the box directly. Use for simple fields: policy numbers, names, dates, dollar amounts.

**Checkbox** — detects whether text is present in the box (checked) or empty (unchecked). Set the "checked value" and "unchecked value" for what to return in each case.

**LLM Interpret** — reads the text at the coordinates, then sends it to the LLM with a scoped prompt. Use for regions where the layout is complex or values need parsing. For example, an insured name+address block where you want the name separated from the address.

### Value types

For text mappings, set the value type to control normalization:

| Type | What it does |
|------|-------------|
| Text | No normalization (default) |
| Number | Strips non-numeric characters, converts to number |
| Currency ($) | Parses currency values ($1,000.00 → 1000) |
| Date | Normalizes to ISO 8601 (YYYY-MM-DD) |
| Percentage (%) | Parses percentage values |
| Phone | Normalizes phone numbers |
| Email | Validates email format |
| Enum | Restricts to allowed values |

### Label exclusion

Many form fields include a label in the same cell (e.g., "INSURER A: Trisura Insurance Company"). Set the **Label to exclude** field to strip the label text from the extracted value. Enter "INSURER A:" and the extraction returns just "Trisura Insurance Company".

### LLM interpret regions

For complex regions where coordinate extraction alone isn't enough:

1. Draw a box over the region.
2. Select **LLM** as the mapping type.
3. Select the **target fields** — the schema fields this region should populate.
4. Write a **prompt** telling the LLM what to extract.

Example: draw a box over the entire insurers section of an ACORD 25, target `insurer_a` through `insurer_e` plus `naic_a` through `naic_e`, and prompt: "Extract each insurer's company name and NAIC code. Match the letter (A-E) to the corresponding fields. Ignore labels. Return null for empty rows."

The LLM only sees the text from that specific region — not the entire document. This keeps calls fast and cheap (~100-300 tokens per region).

## Editing mappings

Click the **pencil icon** next to any mapped field in the right panel to edit its properties (mapping type, value type, label exclusion). Click **Save changes** when done.

To move or resize a box, turn off draw mode and click the box to select it. Drag the body to move, drag the corner/edge handles to resize.

## Testing

Switch to **Test** mode in the annotation page. Upload a different instance of the same form type and click **Run test**. The results show each field's extracted value with confidence scores.

If the PDF is scanned (no text layer), a warning banner appears. Coordinate extraction requires digital PDFs with embedded text.

## Activating for production

Click **Activate** in the annotation page header. This:

1. Saves the current mappings.
2. Sets the form mapping status to "active".
3. Generates a **fingerprint** from the sample PDF's first page — keywords and layout signatures used for auto-detection.

Once active, any document that enters a pipeline linked to this schema is checked against the fingerprint. If it matches (60%+ keyword overlap), coordinate extraction runs instead of the full LLM pipeline.

## Hybrid extraction

Form mappings don't need to cover every schema field. The pipeline automatically handles the split:

1. **Mapped fields** — extracted by coordinates (instant, free).
2. **LLM interpret regions** — scoped LLM calls on specific regions (fast, cheap).
3. **Unmapped fields** — backfilled by normal full-document LLM extraction.

The trace view shows `strategy: "form-mapping+llm"` when both paths ran, or `strategy: "form-mapping"` when coordinates covered everything.

## Layout tolerance

Coordinate extraction assumes the same field is at the same position in every instance of the form. This works well for:

- Checkbox positions
- Single-line fields in fixed cells
- Header fields (date, certificate number)

For sections that shift between carriers or software versions (insurer tables, coverage rows), use **LLM interpret regions** instead of coordinate boxes. The LLM reads the text regardless of exact position.

## Cost comparison

| Method | Cost per 1,000 docs | Latency |
|--------|---------------------|---------|
| Full LLM extraction | $5-10 | 3-8 seconds |
| Coordinate only | $0 | < 1 second |
| Hybrid (coordinates + LLM regions) | $0.50-2 | 1-3 seconds |

The hybrid approach gives you the accuracy of LLM extraction at a fraction of the cost, with the speed of direct text reads for simple fields.
