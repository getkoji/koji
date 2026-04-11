---
title: Configuration Reference
description: Complete reference for koji.yaml — pipelines, models, clusters, and output settings.
---

# Configuration Reference

All Koji behavior is driven by `koji.yaml` in your project root.

## Minimal Example

```yaml
project: my-pipeline

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

## Full Reference

### `project`

A name for your pipeline. Used in logs and the dashboard.

```yaml
project: invoice-processing
```

### `cluster`

Controls how the local cluster is configured.

```yaml
cluster:
  name: default
  base_port: 9400  # dashboard at :9400, server at :9401, services from :9410+
```

When running multiple clusters simultaneously, each project gets its own port range:

```bash
cd ~/project-a && koji start  # dashboard at :9400
cd ~/project-b && koji start  # dashboard at :9500
```

### `pipeline`

An ordered list of processing steps. Each step runs as an independent service.

```yaml
pipeline:
  - step: parse
    engine: docling

  - step: split
    strategy: heading

  - step: classify
    model: local/llama3.2
    labels:
      - invoice
      - receipt
      - contract

  - step: extract
    model: openai/gpt-4o-mini
    schemas:
      - ./schemas/invoice.yaml
      - ./schemas/receipt.yaml

  - step: embed
    model: local/nomic-embed-text
```

#### Pipeline Steps

| Step | Purpose | Key Options |
|------|---------|-------------|
| `parse` | Document → clean markdown | `engine` |
| `split` | Markdown → chunks | `strategy` |
| `classify` | Document/chunk → labels | `model`, `labels` |
| `extract` | Document/chunk → structured JSON | `model`, `schemas` |
| `embed` | Text → vector embeddings | `model` |

Use the full pipeline or any subset. Steps are independent.

### `models`

Configure model providers. Mix local and API providers freely.

```yaml
models:
  providers:
    local:
      backend: ollama
    openai:
      api_key: ${OPENAI_API_KEY}
    anthropic:
      api_key: ${ANTHROPIC_API_KEY}
    custom:
      endpoint: https://your-inference.internal/v1
```

Reference models in pipeline steps as `provider/model-name`:

```yaml
pipeline:
  - step: extract
    model: openai/gpt-4o-mini  # uses the openai provider
  - step: classify
    model: local/llama3.2      # uses the local (ollama) provider
```

### `output`

Where extracted data goes.

```yaml
output:
  structured: ./output/
```

## Environment Variables

Use `${VAR_NAME}` syntax anywhere in `koji.yaml` to reference environment variables:

```yaml
models:
  providers:
    openai:
      api_key: ${OPENAI_API_KEY}
```

Koji will error at startup if a referenced variable is not set.
