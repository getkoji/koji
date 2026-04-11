---
title: Koji
description: Self-hosted document processing platform. Documents in, structured data out.
---

# Koji

**Documents in. Structured data out.**

Koji is a self-hosted document processing platform. Parse, split, classify, and extract structured data from any document — PDFs, Word, images, scans — using local models or any API provider.

## Why Koji?

- **Config-driven** — one YAML file defines your entire pipeline
- **Self-hosted** — runs on your infra (docker-compose for dev, k8s for prod)
- **Modular** — each processing step is an independent service
- **Model-agnostic** — BYO models (local via ollama/vllm, or any API provider)

## Quick Start

```bash
# Install the CLI
pip install koji-cli

# Start a cluster
koji start

# Open the dashboard
open http://127.0.0.1:9400
```

That's it. Your cluster is running. The dashboard shows service health, and you're ready to process documents.

## Process Your First Document

Create a schema that describes what you want to extract:

```yaml
# schemas/invoice.yaml
name: invoice
fields:
  invoice_number:
    type: string
    required: true
  date:
    type: date
  vendor:
    type: string
  total_amount:
    type: number
    required: true
```

Process a document:

```bash
koji process ./invoice.pdf --schema ./schemas/invoice.yaml
```

Output:

```json
{
  "invoice_number": "INV-2026-0042",
  "date": "2026-03-15",
  "vendor": "Acme Corp",
  "total_amount": 4250.00
}
```

## Next Steps

- [Getting Started](getting-started.md) — full setup walkthrough
- [Configuration](configuration.md) — `koji.yaml` reference
- [Schemas](schemas.md) — define what you want to extract
- [Architecture](architecture.md) — how the pieces fit together
- [CLI Reference](cli.md) — all commands and flags
