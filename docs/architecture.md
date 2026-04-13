---
title: Architecture
description: How Koji turns documents into structured data — services, pipeline, configuration, and data flow.
---

# Architecture

Koji is a set of independent services orchestrated by a central API server. Each service runs in its own container, communicates over HTTP, and can be scaled or replaced independently. A single YAML file drives the entire configuration.

## System overview

```
                          koji.yaml
                             |
                             v
  +-----------+        +------------+        +---------------+
  |           |  HTTP   |            |  HTTP   |               |
  |  koji CLI +------->+  API Server +------->+  Parse Service |
  |           |        |  (FastAPI)  |        |  (Docling)     |
  +-----------+        +------+-----+        +---------------+
                              |
       +------------+         |        +------------------+
       |            |  HTTP   |  HTTP   |                  |
       |  Dashboard +-------->+------->+  Extract Service  |
       |  (Web UI)  |        |        |  (Pipeline)       |
       +------------+        |        +--------+---------+
                              |                 |
                              |                 v
                              |        +------------------+
                              |        |                  |
                              +------->+  Ollama (local)  |
                                       |  or OpenAI API   |
                                       +------------------+
                                                |
                        Webhooks <---------------+
                     (job.completed,
                      job.failed)
```

All services live on an isolated Docker network (`koji-<project>`). The CLI and Dashboard talk to the API Server. The API Server orchestrates Parse and Extract. Extract talks to model providers (Ollama for local, OpenAI API for cloud).

## Service architecture

### API Server

**Port:** 9401 (internal) | **Technology:** FastAPI + Uvicorn

The API Server is the single entry point for all operations. It:

- Receives document uploads and schema definitions
- Forwards documents to the Parse Service for conversion
- Forwards parsed markdown and schemas to the Extract Service
- Manages async jobs with an in-memory store backed by SQLite for history
- Fires webhooks on job completion or failure
- Exposes health, status, config, and log-streaming endpoints
- Serves as the backend for the Dashboard

Key endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/process` | POST | Full pipeline: parse + extract |
| `/api/parse` | POST | Parse only: document to markdown |
| `/api/extract` | POST | Extract only: markdown + schema to JSON |
| `/api/jobs/{id}` | GET | Job status and results |
| `/api/status` | GET | Health of all services |
| `/api/logs/stream` | GET | SSE log stream from all services |

All mutation endpoints support both synchronous and asynchronous modes. Pass `?async=true` to get a job ID back immediately and poll for results.

### Parse Service

**Port:** 9410 (internal) | **Technology:** Docling + FastAPI

The Parse Service converts any document into clean markdown. It handles PDFs, Word documents, images, and scanned documents. Under the hood it uses [Docling](https://github.com/DS4SD/docling), which provides OCR, table detection, and layout analysis.

- Accepts file uploads at `/parse`
- Runs Docling conversion in a thread pool to avoid blocking the event loop
- Returns markdown text plus page count
- Caches Hugging Face and Torch model weights in Docker volumes for fast restarts

This service is memory-intensive. Allocate 8-12GB to Docker Desktop for reliable operation.

#### Base image split

The parse service image is split into two layers to keep rebuilds fast:

- `docker/parse.base.Dockerfile` — a heavyweight base image (`ghcr.io/getkoji/parse-base`) that pins Python, docling, torch (CPU), transformers, and the OCR system stack (tesseract, poppler). It is ~5GB and rebuilds rarely — only when `parse.base.Dockerfile` changes or on a manual workflow dispatch.
- `docker/parse.Dockerfile` — a thin application image that `FROM`s the base and only copies `services/parse/`. It is ~50MB on top of the base and rebuilds in seconds on every push.

This means editing the parse service's Python code triggers a tiny rebuild instead of reinstalling docling, torch, and the OCR toolchain every time. Dependency bumps still require a base image rebuild; bump the pinned versions in `parse.base.Dockerfile` and run the `Publish Images` workflow with `build_parse_base=true` (or push a tag). All pinned versions are explicit — no `latest` — so both images are reproducible.

### Extract Service

**Port:** 9420 (internal) | **Technology:** Custom pipeline + FastAPI

The Extract Service runs the intelligent extraction pipeline (detailed in the next section). It takes markdown and a schema definition, then returns structured JSON with per-field confidence scores. It communicates with model providers (Ollama or OpenAI-compatible APIs) to perform the actual LLM-based extraction.

### Ollama

**Port:** 11434 (internal) | **Technology:** Ollama

Optional local model hosting. When enabled, the Extract Service routes requests to Ollama for fully local, air-gapped processing. Model weights are persisted in a Docker volume so they survive container restarts.

Disable it in `koji.yaml` if you only use cloud providers:

```yaml
services:
  ollama: false
```

### Dashboard

**Port:** 9400 (internal) | **Technology:** Single-page HTML app

A lightweight web UI for monitoring. It connects to the API Server to show service health, job history, logs, and pipeline configuration.

## Intelligent extraction pipeline

The extraction pipeline is the core of Koji. Instead of sending an entire document to an LLM in one prompt, it breaks the problem into five phases that minimize token usage and maximize accuracy.

```
  Document        Schema
  (markdown)      (YAML)
      |               |
      v               |
  +-------+           |
  |  MAP  |           |
  +---+---+           |
      |               |
      v               v
  +--------+    +---------+
  | chunks |--->|  ROUTE  |
  +--------+    +----+----+
                     |
                     v
              +-----------+
              |  EXTRACT  |  (grouped LLM calls)
              +-----+-----+
                    |
                    v
              +-----------+
              | VALIDATE  |
              +-----+-----+
                    |
                    v
              +-----------+
              | RECONCILE | ---> structured JSON
              +-----------+
```

### Phase 1: Map

The mapper splits markdown into **chunks** by heading structure. Each chunk gets:

- A **category** (e.g., `header`, `line_items`, `totals` — or anything you define) inferred from your schema's `categories.keywords` block. Without a schema, every chunk is `other`.
- **Signals** — built-in structural detectors: `has_dollar_amounts`, `has_dates`, `has_key_value_pairs`, `has_tables`. Schemas can define **custom signals** via regex patterns (e.g., `has_policy_numbers` for insurance, `has_invoice_numbers` for invoices).

When the parsed markdown contains no `#` headings — common for OCR'd scans, invoices, and table-heavy forms — the mapper runs a **heading inference** pass first, promoting standalone bold lines, ALL CAPS labels, and schema-defined patterns to `##` headings so the chunker has structure to split on. See [Heading inference](schema-guide.md#heading-inference) in the schema guide.

The mapper also normalizes table rows before splitting: parsers like docling sometimes represent column-spanning cells by duplicating the cell content N times across a row (e.g. `| Dated | Dated | Dated | April 9, 2026 | April 9, 2026 | April 9, 2026 |`). Runs of three or more identical adjacent cells are collapsed to a single cell when the row shows an alphabetic-cell triplication signal, so downstream extraction sees the original value instead of treating the repetition as distinct data points. Financial rows that legitimately repeat a value (e.g. `| Revenue | $100 | $100 | $100 |`) are left alone.

The result is a structural map of the document — what kind of data is in it and where. The mapper itself is fully domain-agnostic; all domain knowledge lives in your schema.

### Phase 2: Route

The router matches each schema field to the chunks most likely to contain its value. Routing uses a scoring system with three tiers:

1. **Schema hints** (highest priority) -- if the schema author specified `hints.look_in`, `hints.patterns`, or `hints.signals`, those drive routing directly
2. **Generic inference** -- field type maps to expected signals (date fields look for chunks with `has_dates`, number fields look for `has_dollar_amounts`), plus field name matching against chunk titles and content
3. **Broadened fallback** -- if nothing scored, route to any chunk with signals, or as a last resort, the first chunks of the document

Each field is routed to the top 3 scoring chunks by default. Fields that legitimately aggregate data from many chunks — like a `policies` array on an insurance certificate, where each policy's detail lives in its own section — can override this with `hints.max_chunks: N` in the schema.

The key design decision: **no hardcoded domain knowledge in the pipeline**. The router is entirely generic. Domain knowledge lives in the schema via hints. This means the same pipeline works for invoices, insurance policies, medical records, or any document type — change the schema, not the code.

### Phase 3: Extract (grouped)

Fields that route to overlapping chunks are **grouped together** into a single LLM call. This is where the efficiency gain comes from: instead of one LLM call per field, or one massive call for the whole document, Koji makes the minimum number of calls needed.

For example, if `policy_number`, `effective_date`, and `insured_name` all route to the declarations page, they become one extraction group with one focused prompt.

Each group's prompt contains only the relevant document chunks and field specifications. Groups run concurrently (up to 5 in parallel by default).

### Phase 4: Validate

Each extracted value is validated and normalized against its field spec:

- **Dates** are normalized to ISO 8601 (`YYYY-MM-DD`)
- **Numbers** are cleaned of currency symbols and commas, converted to numeric types
- **Enums** are fuzzy-matched against allowed options (case-insensitive, substring matching)
- **Mappings** resolve aliases to canonical values (e.g., "NY" and "New York" both resolve to "New York")
- **Required fields** are flagged if null

### Phase 5: Reconcile

Results from all extraction groups are merged into a single output. When multiple groups extract the same field (from overlapping chunks), the reconciler uses agreement as a confidence signal:

- **High confidence** -- multiple independent sources agree on the same value
- **Medium confidence** -- single source, passes validation
- **Low confidence** -- validation issues or conflicting sources

After reconciliation, any required fields still missing trigger **gap filling**: a broadened retry that searches up to 6 chunks with a targeted single-field prompt. This catches values that were missed because the initial routing was too narrow.

The final output includes the extracted data, per-field confidence scores, and metadata about the extraction process (chunk count, group count, timing, gap-filled fields).

## Configuration system

Everything is driven by `koji.yaml`. The config layers from broad to specific:

```yaml
# Project identity
project: myproject

# Cluster settings (ports, networking)
cluster:
  name: default
  base_port: 9400       # All service ports are derived from this

# Which services to run
services:
  parse: true           # Docling-based document parsing
  ollama: true          # Local model hosting

# Processing pipeline steps
pipeline:
  - step: parse
    engine: docling
  - step: extract
    model: openai/gpt-4o-mini
    schemas:
      - ./schemas/invoice.yaml

# Model provider configuration
models:
  providers:
    openai:
      backend: openai
    ollama:
      backend: ollama
      endpoint: http://ollama:11434

# Where results go
output:
  structured: ./output/

# Event notifications
webhooks:
  - url: https://your-app.com/webhook
    events: [job.completed, job.failed]
    secret: your-hmac-secret
```

### Port allocation

Ports are deterministic, derived from `base_port`:

| Service | Offset | Default |
|---------|--------|---------|
| Dashboard | +0 | 9400 |
| API Server | +1 | 9401 |
| Ollama | +10 | 9410 |
| Parse | +11 | 9411 |
| Extract | +12 | 9412 |

This means you can run multiple Koji clusters side by side on the same machine by giving each project a different `base_port`.

## Data flow

Here is what happens when you run `koji process ./invoice.pdf --schema schemas/invoice.yaml`:

```
1. CLI reads koji.yaml and loads the schema file
   |
2. CLI sends POST /api/process with file + schema to the API Server
   |
3. API Server forwards the file to the Parse Service (POST /parse)
   |
4. Parse Service:
   - Writes the upload to a temp file
   - Runs Docling converter (OCR, layout analysis, table detection)
   - Returns markdown text + page count
   |
5. API Server forwards markdown + schema to the Extract Service (POST /extract)
   |
6. Extract Service runs the 5-phase pipeline:
   a. MAP       — split markdown into classified, annotated chunks
   b. ROUTE     — score and match schema fields to relevant chunks
   c. EXTRACT   — send grouped prompts to the model provider concurrently
   d. VALIDATE  — normalize types, fuzzy-match enums, check required fields
   e. RECONCILE — merge group results, gap-fill missing required fields
   |
7. Extract Service returns structured JSON + confidence scores + metadata
   |
8. API Server:
   - Persists the job to SQLite history
   - Fires webhooks (job.completed event)
   - Returns JSON response to the CLI
   |
9. CLI writes the result to the output directory
```

For the `koji extract` command, steps 3-4 are skipped entirely -- you pass pre-parsed markdown directly, which makes iteration on schemas much faster.

## Extension points

Koji is designed to be customized without forking:

### Model providers

Use any LLM. The provider system supports:

- **Ollama** -- any model Ollama can run (`llama3.2`, `mistral`, `mixtral`, etc.)
- **OpenAI** -- GPT-4o, GPT-4o-mini, or any model on the OpenAI API
- **OpenAI-compatible** -- any API that speaks the OpenAI chat completions format (vLLM, LiteLLM, Azure OpenAI, etc.). Set the `KOJI_OPENAI_URL` environment variable to point at your endpoint.

Model selection is per-command (`--model openai/gpt-4o-mini`) or per-pipeline-step in `koji.yaml`.

### Schema hints

The schema hint system lets you encode domain knowledge without touching pipeline code:

- `look_in` -- which document categories to search (e.g., `[declarations]`)
- `patterns` -- regex patterns that indicate where a value lives
- `signals` -- structural cues like `has_tables`, `has_dates`, `has_dollar_amounts`

This is how you tune extraction accuracy for your specific document types. See the [Schema Guide](schema-guide.md) for the full reference.

### Webhooks

Subscribe to `job.completed` and `job.failed` events. Payloads include the extracted data, timing, and metadata. Optional HMAC-SHA256 signing for payload verification:

```yaml
webhooks:
  - url: https://your-app.com/webhook
    events: [job.completed, job.failed]
    secret: your-hmac-secret   # X-Koji-Signature header
```

### Python SDK

Integrate Koji into your applications programmatically:

```python
from koji import KojiClient

client = KojiClient(base_url="http://127.0.0.1:9401")
result = client.process("./invoice.pdf", schema="./schemas/invoice.yaml")
print(result.extracted)
```

The SDK provides typed response objects (`ProcessResponse`, `ExtractResponse`, `ParseResponse`) and structured error handling.

## Deployment

### Local development

```bash
koji start
```

This generates a `docker-compose.yaml` in `.koji/` and runs it. All services build from local Dockerfiles. Persistent data (model weights, job history) lives in Docker volumes.

### Multiple clusters

Run independent clusters on the same machine by giving each project a different `base_port`:

```yaml
# Project A
project: invoices
cluster:
  base_port: 9400

# Project B
project: contracts
cluster:
  base_port: 9500
```

Each cluster gets its own Docker network, containers, and volumes. They do not interfere with each other.

### Container registry (no local builds)

`koji start` pulls pre-built images from a container registry (GitHub Container Registry). Users never run `docker build` — that's slow, memory-intensive, and error-prone. Dockerfiles stay in the repo for development and CI, but production users always pull.

```
koji start  →  docker pull ghcr.io/getkoji/parse:latest
               docker pull ghcr.io/getkoji/extract:latest
               docker pull ghcr.io/getkoji/server:latest
               docker compose up
```

### Production (Koji Cloud)

The hosted version runs the same services with managed infrastructure. The architecture is identical — the only additions are auth, billing, and persistent multi-tenant storage.

## Hosted architecture (Koji Cloud)

All-Cloudflare stack. One vendor, one bill, zero egress fees, containers auto-sleep when idle.

```
                    ┌──────────────────┐
                    │  Cloudflare Pages │
                    │     (Next.js)     │
                    │    Dashboard      │
                    └────────┬─────────┘
                             │
                    ┌────────┴─────────┐
                    │      Clerk       │
                    │     (Auth)       │
                    └────────┬─────────┘
                             │ JWT
                    ┌────────┴─────────┐
                    │  CF Workers      │
                    │  API (light)     │──── D1 (SQLite)
                    │  auth, routing   │──── R2 (documents)
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
        ┌─────┴──────┐ ┌────┴────┐ ┌──────┴──────┐
        │    Parse   │ │ Extract │ │ CF Queues   │
        │ CF Container│ │CF Cont. │ │ (job queue) │
        │ 4cpu/12GB  │ │1cpu/4GB │ │             │
        │ auto-sleep │ │auto-sleep│ │             │
        └────────────┘ └─────────┘ └─────────────┘
```

### Stack choices

| Layer | Cloudflare Product | Spec | Cost |
|-------|-------------------|------|------|
| **Frontend** | Pages | Next.js, unlimited bandwidth | Free |
| **API (light)** | Workers | Auth validation, schema CRUD, job status, routing | $5/mo (Workers Paid) |
| **Parse** | Containers (standard-4) | 4 vCPU, 12GB RAM, 20GB disk. Auto-sleeps after idle. | Per-second billing |
| **Extract** | Containers (standard-1) | 1 vCPU, 4GB RAM. Auto-sleeps after idle. | Per-second billing |
| **Database** | D1 | SQLite at the edge. Same engine as self-hosted. | Free tier generous |
| **Documents** | R2 | S3-compatible. Zero egress fees. | $0.015/GB stored |
| **Job queue** | Queues | Job orchestration, async processing | $0.40/M messages |
| **Auth** | Clerk (external) | SSO, MFA, team management. Only non-CF piece. | Free to 10k MAU |

**Container limits (no runtime duration limit):**
- Max instance: 4 vCPU, 12 GiB RAM, 20 GB disk
- Containers run as long as needed, billed per 10ms active
- Auto-sleep after configurable `sleepAfter` period (e.g., 10 minutes)
- Account limits (beta): 6 TiB memory, 1500 vCPU across all containers

**Estimated cost at launch:** ~$10-20/mo before first paying customer (mostly idle containers + $5 Workers Paid plan).

**Why all-Cloudflare:**
- One vendor, one bill, one dashboard
- D1 is literally SQLite — same local-to-prod parity as self-hosted
- R2 has zero egress fees (critical for document processing where users download results)
- Pages is free with no pricing cliffs
- Containers auto-sleep when idle — you don't pay for downtime
- No multi-vendor networking complexity

### Auth architecture

The API server has a single auth middleware with two modes:

```python
# server/auth.py
KOJI_AUTH_MODE = os.environ.get("KOJI_AUTH_MODE", "none")

# If "none" (self-hosted): all requests pass through, synthetic admin user
# If "clerk" (hosted): validate JWT from Authorization header, extract user/team/role
```

**Self-hosted:** No auth. No users. No tokens. Every request is implicitly admin. The dashboard shows no login screen.

**Hosted:** Clerk handles authentication in the Next.js middleware layer. The frontend gets a session, passes a JWT to the API. The API validates the JWT against Clerk's public keys and extracts:
- `user_id` — who is making the request
- `team_id` — which team context (a user can belong to multiple teams)
- `role` — admin, member, or viewer

RBAC is simple: 3 roles.
- **Admin** — manage team members, billing, delete schemas, configure webhooks
- **Member** — process documents, create/edit schemas, view results
- **Viewer** — read-only access to results and schemas

The core extraction endpoints work identically in both modes. The auth layer is a thin wrapper, not a different system.

### One UI everywhere

The dashboard is a single Next.js app that runs in both environments:

- **Self-hosted:** built into a Docker container, served alongside the API. `NEXT_PUBLIC_KOJI_MODE=selfhosted` hides login/billing UI.
- **Hosted:** deployed on Cloudflare Pages. `NEXT_PUBLIC_KOJI_MODE=cloud` enables the Clerk provider, team switcher, and billing page.

The pages are identical: jobs, schemas, pipeline viz, logs, settings. Only the auth wrapper and billing page differ.

### SQLite everywhere

The database story is the key to the Supabase-like local/prod parity:

- **Self-hosted:** plain SQLite file at `.koji/jobs.db`
- **Hosted:** Cloudflare D1 (SQLite at the edge)

Same engine, same schema, same queries. D1 is SQLite — not a Postgres-compatible layer, not an emulation, actual SQLite. A schema developed locally works identically in production. Users `koji test` locally, then deploy to cloud with confidence.

## Next steps

- [Getting Started](getting-started.md) -- install and process your first document
- [Configuration Reference](configuration.md) -- full `koji.yaml` options
- [Schema Guide](schema-guide.md) -- field types, hints, and validation
