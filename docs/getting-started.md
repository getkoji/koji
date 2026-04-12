---
title: Getting Started
description: Install Koji, start a cluster, and extract structured data from your first document in five minutes.
---

# Getting Started

Zero to structured data in five minutes. This guide walks you through installing Koji, starting a processing cluster, and extracting data from a document.

## Prerequisites

- **Docker Desktop** (or Docker Engine with Compose v2) — running, with 8GB+ RAM allocated
- **Python 3.11+**
- **An OpenAI API key** (or [ollama](https://ollama.com) installed for fully local processing)

## Install

```bash
pip install koji-cli
```

Verify it worked:

```bash
koji version
# koji 0.1.0
```

> Installing from source? Clone the repo and `pip install -e .` from the project root.

## Initialize a project

Koji ships with a set of domain templates so you can scaffold a project with a working schema in one command:

```bash
koji init myproject --template invoice
cd myproject
```

This creates:

```
myproject/
  koji.yaml              # pipeline configuration
  schemas/
    invoice.yaml         # extraction schema
```

### Available templates

| Template | What you get |
|----------|--------------|
| `invoice` | Invoice number, vendor, dates, totals, line items |
| `receipt` | POS receipt: merchant, items, tax, tip, payment method |
| `contract` | Contract: parties, term, effective/expiration dates, governing law |
| `insurance` | Commercial insurance policy with category routing and hints |
| `form` | Government form: name, DOB, address, checkboxes |

List them at any time:

```bash
koji init --list-templates
```

Plain `koji init myproject` (no template) creates just a `koji.yaml` so you can define your own schema from scratch. `--quickstart` still works and is an alias for `--template invoice`.

## Configure

Set your OpenAI API key so Koji can pass it through to containers:

```bash
export OPENAI_API_KEY="sk-..."
```

Templates ship with a working pipeline already wired up. The generated `koji.yaml` from `--template invoice` looks like this:

```yaml
project: myproject

cluster:
  base_port: 9400

pipeline:
  - step: parse
    engine: docling

  - step: extract
    model: openai/gpt-4o-mini
    schemas:
      - ./schemas/invoice.yaml

output:
  structured: ./output/
```

Using ollama instead? Set `model: llama3.2` and make sure ollama is running locally. No API key needed.

> Running plain `koji init` with no template? You'll get just the `project`, `cluster`, and `output` sections — add a `pipeline:` block yourself when you're ready to wire up extraction.

## Start the cluster

```bash
koji start
```

This pulls Docker images and starts the processing services: a parse engine (docling), extraction service, API server, and dashboard. First run takes a minute or two for image pulls. Subsequent starts are fast.

The dashboard is at [http://127.0.0.1:9400](http://127.0.0.1:9400).

Check that everything came up:

```bash
koji status
```

If something looks wrong, run the diagnostic tool:

```bash
koji doctor
```

```
Koji Doctor

  ✓ Docker installed (Docker version 27.x.x)
  ✓ Docker Compose available
  ✓ Docker daemon running
  ✓ koji.yaml found
  ✓ koji.yaml valid (project: myproject)
  ✓ Ports available (base: 9400)
  ✓ OPENAI_API_KEY set

7 passed, 0 warning, 0 failed
```

`koji doctor` checks Docker, your config file, port availability, and API keys. Fix anything marked with a failure before proceeding.

## Process your first document

Run the full pipeline (parse + extract) on a document:

```bash
koji process ./invoice.pdf --schema schemas/invoice.yaml
```

This sends the document through the parse step (PDF to markdown), then extracts structured data using your schema. Results are written to `./output/`:

```json
{
  "invoice_number": "INV-2026-0042",
  "date": "2026-03-15",
  "vendor": "Acme Corp",
  "line_items": [
    {
      "description": "Consulting services",
      "quantity": 40,
      "unit_price": 150.00,
      "total": 6000.00
    }
  ],
  "total_amount": 6000.00,
  "currency": "USD"
}
```

You can also process an entire directory:

```bash
koji process ./documents/ --schema schemas/invoice.yaml
```

## Extract from existing markdown

Already have parsed markdown from a previous run? Skip the slow parse step and go straight to extraction:

```bash
koji extract ./output/invoice.md --schema schemas/invoice.yaml --model openai/gpt-4o-mini
```

This is much faster and useful for iterating on your schema. The `--model` flag lets you override the model from your config on the fly.

Options:

| Flag | Description |
|------|-------------|
| `--schema`, `-s` | Path to extraction schema (required) |
| `--model`, `-m` | Model override (e.g., `openai/gpt-4o-mini`, `llama3.2`) |
| `--output`, `-o` | Output directory (default: `./output/`) |
| `--strategy` | Extraction strategy: `parallel` (default) or `agent` |

## Write your own schema

A schema is a YAML file that tells Koji what to extract. Here's the structure:

```yaml
name: purchase_order
description: Purchase order extraction

fields:
  po_number:
    type: string
    required: true
    description: The purchase order number

  vendor:
    type: string
    description: Vendor or supplier name

  items:
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
```

Field types: `string`, `number`, `date`, `enum`, `mapping`, `array`. Arrays can hold nested objects with their own properties — see the [Schema Authoring Guide](schema-guide.md) for the full reference.

The `description` on each field matters -- it guides the extraction model. Be specific about what the field represents and where it typically appears in the document.

### Schema hints

For complex documents, add hints to improve extraction accuracy. Hints tell the extraction pipeline where to look and what patterns to expect:

```yaml
fields:
  invoice_number:
    type: string
    required: true
    description: The invoice number
    hints:
      look_in: [header]
      patterns: ["invoice\\s*(?:number|no|#)"]
      signals: [has_key_value_pairs]
```

- `look_in` — which document sections to search (sections you define yourself in `categories.keywords`)
- `patterns` — regex patterns that indicate where the value lives
- `signals` — structural cues like `has_dollar_amounts`, `has_dates`, `has_tables`, `has_key_value_pairs`. You can also define your own custom signals via regex.

See `schemas/examples/insurance_policy.yaml` for a complete working example with custom categories, hints, and patterns. The [Schema Authoring Guide](schema-guide.md) has the complete reference.

## What's next

Useful commands while you work:

```bash
koji status          # cluster health
koji logs            # all service logs
koji logs extract -f # follow extraction service logs
koji stop            # shut down the cluster
```

Once you have a schema you trust, you can lock it in with regression tests and benchmarks:

```bash
koji test --schema schemas/invoice.yaml      # run schema regression tests
koji bench --corpus ./corpus --model openai/gpt-4o-mini   # benchmark across a corpus
```

Further reading:

- [Schemas](schema-guide.md) — full schema authoring guide: field types, hints, arrays, enums, custom signals
- [Configuration Reference](configuration.md) — every `koji.yaml` option
- [CLI Reference](cli.md) — every command and flag
- [Architecture](architecture.md) — how the pipeline works
