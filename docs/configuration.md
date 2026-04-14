---
title: Configuration Reference
description: Complete reference for every koji.yaml option.
---

# Configuration Reference

Koji is configured through a single `koji.yaml` file in your project root. Every option has a sensible default -- a minimal config can be just a project name.

For a walkthrough of setting up your first config, see [Getting Started](getting-started.md).

## Minimal config

```yaml
project: myproject
```

## Full example

```yaml
project: myproject

cluster:
  name: default
  base_port: 9400

services:
  parse: true
  ollama: true

pipeline:
  - step: parse
    engine: docling

  - step: extract
    model: openai/gpt-4o-mini
    schemas:
      - ./schemas/invoice.yaml

models:
  providers:
    openai:
      backend: openai
      api_key: ${OPENAI_API_KEY}
    local:
      backend: ollama
      endpoint: http://localhost:11434

output:
  structured: ./output/
  vectors: ./vectors/
  raw_markdown: ./markdown/

webhooks:
  - url: https://my-app.com/api/koji-callback
    events: [job.completed, job.failed]
    secret: my-hmac-secret
```

---

## `project`

| | |
|---|---|
| **Type** | `string` |
| **Default** | `"koji"` |
| **Required** | No |

The project name. Used as a namespace for Docker containers, logs, and the dashboard.

```yaml
project: invoice-processing
```

---

## `cluster`

Cluster-level settings that control networking and service identity.

### `cluster.name`

| | |
|---|---|
| **Type** | `string` |
| **Default** | `"default"` |
| **Required** | No |

Name of the cluster. Useful when running multiple Koji clusters on the same machine.

### `cluster.base_port`

| | |
|---|---|
| **Type** | `integer` |
| **Default** | `9400` |
| **Required** | No |

Base port for the cluster. All service ports are derived from this value using fixed offsets:

| Service | Offset | Default port |
|---------|--------|--------------|
| UI (dashboard) | +0 | 9400 |
| API server | +1 | 9401 |
| Ollama | +10 | 9410 |
| Parse | +11 | 9411 |
| Extract | +12 | 9412 |

To run a second cluster on the same machine, set a different `base_port`:

```yaml
cluster:
  name: production
  base_port: 9500
# dashboard at :9500, server at :9501, parse at :9511, etc.
```

### `cluster.version`

| | |
|---|---|
| **Type** | `string` |
| **Default** | `"latest"` |
| **Required** | No |

The image tag to pull from `ghcr.io/getkoji`. Defaults to `latest`. Pin a specific release for reproducible deployments:

```yaml
cluster:
  version: v0.2.0
```

### `cluster.dev`

| | |
|---|---|
| **Type** | `boolean` |
| **Default** | `false` |
| **Required** | No |

Build images from local source instead of pulling from `ghcr.io/getkoji`. Required when developing on Koji itself. The `koji start --dev` CLI flag sets this for one invocation.

```yaml
cluster:
  dev: true
```

Most users should leave this `false` and let Koji pull pre-built images.

---

## `services`

Toggle optional services on or off. Disabling a service prevents Koji from starting its container.

### `services.parse`

| | |
|---|---|
| **Type** | `boolean` |
| **Default** | `true` |
| **Required** | No |

Enable the parse service. Set to `false` if you only need extraction from pre-parsed markdown (via `koji extract`).

### `services.ollama`

| | |
|---|---|
| **Type** | `boolean` |
| **Default** | `true` |
| **Required** | No |

Enable the bundled ollama service for local model inference. Set to `false` if you are using only API-based providers (e.g., OpenAI) and don't need local models.

```yaml
services:
  parse: true
  ollama: false  # using OpenAI only, no local models needed
```

---

## `pipeline`

| | |
|---|---|
| **Type** | `list[PipelineStep]` |
| **Default** | `[]` |
| **Required** | No (but nothing processes without it) |

An ordered list of processing steps. Each step defines one stage of the document processing pipeline. Steps are independent services -- use the full pipeline or any subset.

### Pipeline step fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `step` | `string` | — | **Required.** Step type: `parse` or `extract`. |
| `engine` | `string` | `null` | Processing engine for parsing (e.g., `docling`). |
| `model` | `string` | `null` | Model in `provider/model-name` format (e.g., `openai/gpt-4o-mini`, `ollama/llama3.2`). |
| `schemas` | `list[string]` | `null` | Paths to schema YAML files for extraction. |
| `ocr` | `string` | `null` | OCR engine for the parse step (engine-specific). |
| `strategy` | `string` | `"intelligent"` | Extraction strategy: `intelligent` (default), `parallel`, or `agent`. |
| `categories` | `list[string]` | `null` | (`parallel` strategy only) Restrict extraction to these chunk categories. Ignored by the default `intelligent` strategy, which routes via schema hints. |
| `max_tokens` | `integer` | `null` | Maximum token limit for model calls in this step. |

### Parse step

Converts documents (PDF, Word, images) into clean markdown.

```yaml
pipeline:
  - step: parse
    engine: docling
```

### Extract step

Extracts structured data from markdown using schemas and an LLM.

```yaml
pipeline:
  - step: extract
    model: openai/gpt-4o-mini
    strategy: parallel
    schemas:
      - ./schemas/invoice.yaml
      - ./schemas/receipt.yaml
    max_tokens: 4096
```

Reference models as `provider/model-name`. The provider name must match a key under `models.providers`, or use a well-known provider prefix like `openai/` or `ollama/`.

### Classify step (optional)

Inserts a document-type classifier between parse and extract. This is the stage that handles **packets** — a single upload containing multiple stapled-together documents — by splitting the input into typed sections that downstream schemas can target via their `apply_to` field.

```yaml
pipeline:
  - step: parse
    engine: docling

  - step: classify
    model: openai/gpt-4o-mini         # cheap model recommended; separate from extract model
    require_apply_to: false           # default false; set true to error on schemas missing apply_to
    short_doc_chunks: 2               # docs at or below this chunk count skip the classifier
    coalesce_other_threshold: 0.5     # if one type covers ≥50% of chunks + rest are `other`, collapse to a single typed section
    types:
      - id: invoice
        description: Commercial invoice with line items, bill-to, and totals.
      - id: coi
        description: Certificate of insurance showing coverage, policyholder, and insurer.
      - id: policy
        description: Insurance policy document with declarations, coverages, endorsements.
      - id: sec_filing
        description: SEC EDGAR filing (10-K, 10-Q, 8-K, DEF 14A, or amendment variants).

  - step: extract
    model: openai/gpt-4o-mini
    schemas:
      - ./schemas/invoice.yaml
      - ./schemas/insurance_policy.yaml
```

**Presence of the `classify` step is the only way to turn classification on.** When it's absent, the pipeline is byte-identical to single-document processing — no behavior change for existing deployments.

Each entry in `types` declares a document type the classifier is allowed to emit. Koji ships with no built-in type taxonomy; you declare the types your pipeline cares about. The reserved type `other` is always valid (used as a catch-all) and `document` is used internally as a fallback when the classifier has no useful answer. Type IDs are referenced from schema files via `apply_to` — see [schema-guide.md](schema-guide.md#targeting-specific-document-types-with-apply_to) for how schemas opt into a specific type.

**`require_apply_to`**: when `false` (default), a schema without `apply_to` runs against every section the classifier produces. When `true`, such a schema is a config error at extraction time. Forgiving is fine for small deployments; strict mode is safer once you have many schemas and want to prevent accidental cross-section extraction.

**`short_doc_chunks`**: the inclusive chunk-count threshold below which the classifier is bypassed entirely. Documents at or below this size return a single fallback `document` section with **no LLM call** — useful for tiny synthetic fixtures, truncated cover pages, and any upload where there's too little structure for a classifier to help. The default is `2`. Set to `0` to disable the fast path and force the classifier on every document. The fallback `document` section is specifically designed to match any schema's `apply_to` list, so you won't silently lose extraction when the classifier has no opinion.

**`coalesce_other_threshold`**: a post-classify safety net that undoes LLM over-splitting on multi-section single documents (the motivating case: a DEF 14A proxy statement where the cover and voting-rights section get labeled `sec_filing` but the comp-table and signature sections get labeled `other`, halving extraction). If any `other` sections are present **and** one non-`other` type covers at least this fraction of chunks, the classifier output is collapsed into a single section of the dominant type covering the whole document. Defaults to `0.5`. Set to `0` to disable — which you'd want only if your pipeline regularly processes genuine packets where a small minority section of type X is surrounded by a majority of type Y and both need independent extraction. When coalesce fires, `classifier.coalesced_type` in the response records the type that won.

The classify step issues one extra LLM call per document (unless the short-doc fast path applies). That call shows up in `koji bench` output as its own cost line alongside the extract call, so you can measure the overhead on your corpus before deciding whether to enable it in production.

---

## `models`

Configuration for model providers. Mix local and API providers freely.

### `models.providers`

| | |
|---|---|
| **Type** | `dict[string, ModelProviderConfig]` |
| **Default** | `{}` |
| **Required** | No |

A map of provider names to their configuration. The key is a label you choose (e.g., `openai`, `local`, `anthropic`).

### Provider config fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `backend` | `string` | `null` | Provider backend: `openai`, `ollama`, `anthropic`, etc. |
| `api_key` | `string` | `null` | API key. Supports `${VAR}` environment variable syntax. |
| `endpoint` | `string` | `null` | Custom API endpoint URL. Required for self-hosted providers. |
| `format` | `string` | `null` | Response format hint (provider-specific). |

```yaml
models:
  providers:
    openai:
      backend: openai
      api_key: ${OPENAI_API_KEY}
    local:
      backend: ollama
      endpoint: http://localhost:11434
    custom:
      backend: openai
      api_key: ${CUSTOM_API_KEY}
      endpoint: https://my-inference-server.com/v1
```

Reference models in pipeline steps as `provider/model-name`:

```yaml
pipeline:
  - step: extract
    model: openai/gpt-4o-mini   # uses the openai provider
  - step: classify
    model: local/llama3.2       # uses the local (ollama) provider
```

---

## `output`

Controls where processed results are written.

### `output.structured`

| | |
|---|---|
| **Type** | `string` |
| **Default** | `"./output/"` |
| **Required** | No |

Directory for structured extraction output (JSON files).

### `output.vectors`

| | |
|---|---|
| **Type** | `string` |
| **Default** | `null` (disabled) |
| **Required** | No |

Directory for vector embeddings output. When set, Koji writes vector representations alongside structured output.

### `output.raw_markdown`

| | |
|---|---|
| **Type** | `string` |
| **Default** | `null` (disabled) |
| **Required** | No |

Directory for raw markdown from the parse step. Useful for debugging or re-running extraction without re-parsing.

```yaml
output:
  structured: ./output/
  vectors: ./vectors/
  raw_markdown: ./markdown/
```

---

## `webhooks`

| | |
|---|---|
| **Type** | `list[WebhookConfig]` |
| **Default** | `[]` |
| **Required** | No |

Webhooks receive HTTP POST notifications when processing events occur. Each webhook is delivered asynchronously and does not block the pipeline.

### Webhook config fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | `string` | -- | **Required.** Endpoint URL to receive webhook deliveries. |
| `events` | `list[string]` | `["job.completed", "job.failed"]` | Events that trigger this webhook. |
| `secret` | `string` | `null` | HMAC-SHA256 secret for signing payloads. When set, deliveries include an `X-Koji-Signature` header. |

### Supported events

| Event | Fired when |
|-------|------------|
| `job.completed` | A processing job finishes successfully. |
| `job.failed` | A processing job fails. |

### Webhook payload format

```json
{
  "event": "job.completed",
  "timestamp": "2026-04-11T12:00:00+00:00",
  "data": {
    "filename": "invoice.pdf",
    "schema": "invoice",
    "extracted": { "...": "..." },
    "elapsed_ms": 2340
  }
}
```

### Webhook delivery headers

| Header | Description |
|--------|-------------|
| `Content-Type` | `application/json` |
| `X-Koji-Event` | Event name (e.g., `job.completed`) |
| `X-Koji-Signature` | HMAC-SHA256 hex digest of the raw JSON body (only when `secret` is set) |

```yaml
webhooks:
  - url: https://my-app.com/api/koji-callback
    events: [job.completed, job.failed]
    secret: my-hmac-secret
```

---

## Environment variables

These environment variables affect Koji at runtime:

| Variable | Description | Default |
|----------|-------------|---------|
| `KOJI_CONFIG_PATH` | Path to `koji.yaml` inside the server container. | `/etc/koji/koji.yaml` |
| `KOJI_SCHEMAS_DIR` | Directory where schema YAML files are stored. | `./schemas/` |
| `OPENAI_API_KEY` | OpenAI API key. Must be set before `koji start` to pass through to containers. | -- |

Use `${VAR_NAME}` syntax anywhere in `koji.yaml` to reference environment variables:

```yaml
models:
  providers:
    openai:
      api_key: ${OPENAI_API_KEY}
```
