---
title: Getting Started
description: Install Koji, start a cluster, and process your first document in under five minutes.
---

# Getting Started

## Prerequisites

- Python 3.11+
- Docker (Docker Desktop or Docker Engine with Compose)

## Install

```bash
pip install koji-cli
```

Verify the installation:

```bash
koji --version
```

## Start a Cluster

Navigate to your project directory and start Koji:

```bash
koji start
```

This pulls the required Docker images and starts all services. On first run, this may take a minute. Subsequent starts are fast.

The dashboard is available at [http://127.0.0.1:9400](http://127.0.0.1:9400). You can check service health with:

```bash
koji status
```

## Create a Configuration

If you don't already have one, create a `koji.yaml` in your project root:

```yaml
project: my-first-pipeline

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

!!! tip
    Set your `OPENAI_API_KEY` environment variable, or switch to a local model like `ollama/llama3.2` for fully offline processing.

## Create a Schema

Schemas tell Koji what data to extract. Create `schemas/invoice.yaml`:

```yaml
name: invoice
fields:
  invoice_number:
    type: string
    required: true
    description: The invoice or reference number
  date:
    type: date
    required: true
    description: Invoice date
  vendor:
    type: string
    description: Vendor or supplier name
  total_amount:
    type: number
    required: true
    description: Total invoice amount
```

## Process a Document

```bash
koji process ./invoice.pdf --schema ./schemas/invoice.yaml
```

The extracted data is written to `./output/` as JSON.

## Process a Directory

```bash
koji process ./documents/ --schema ./schemas/invoice.yaml
```

All supported files in the directory are processed. Results are written to the output directory with matching filenames.

## Stop the Cluster

```bash
koji stop
```

## Next Steps

- [Configuration Reference](configuration.md) — full `koji.yaml` options
- [Schema Reference](schemas.md) — field types, arrays, nested objects
- [Architecture](architecture.md) — understand the processing pipeline
