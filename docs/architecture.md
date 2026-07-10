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
  |           |        |  (Hono/TS)  |        |  (Docling)     |
  +-----------+        +------+-----+        +---------------+
                              |
       +------------+         |        +------------------+
       |            |  HTTP   |  LLM    |                  |
       |  Dashboard +-------->+------->+  Ollama (local)  |
       |  (Web UI)  |        |        |  or OpenAI API   |
       +------------+        |        +------------------+
                              |
                        Webhooks
                     (job.completed,
                      job.failed)
```

All services live on an isolated Docker network (`koji-<project>`). The CLI and Dashboard talk to the API Server. The API Server orchestrates Parse (document → markdown) and runs extraction in-process (markdown + schema → structured data via LLM calls).

## Service architecture

### API Server

**Port:** 9401 (internal) | **Technology:** FastAPI + Uvicorn

The API Server is the single entry point for all operations. It:

- Receives document uploads and schema definitions
- Forwards documents to the Parse Service for conversion
- Runs extraction in-process (markdown + schema → structured data via LLM)
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

The Parse Service converts any document into clean markdown. It handles PDFs, Word documents, images, and scanned documents.

#### Smart parse routing

The API automatically routes documents to the fastest parser that can handle them:

| Document type | Parser | Speed | How it's detected |
|--------------|--------|-------|-------------------|
| Digital PDFs (has text layer) | **pdfjs-dist** (in-process JS) | Fast (~20-50ms/page) | Average ≥ 50 chars/page over first 3 pages |
| Scanned PDFs (no text layer) | **Docling** (OCR + layout) | Slow (~5-10s) | Average < 50 chars/page |
| Images (JPEG, PNG, TIFF, etc.) | **Docling** | Slow | Detected by MIME type or extension |
| Other formats (DOCX, HTML, etc.) | **Docling** | Slow | Everything that isn't a PDF or image |

This is transparent — callers don't choose a parser. If pdfjs throws or returns output that looks corrupt, the request falls back to Docling automatically with zero caller-side changes. The corruption check catches two opposite failure shapes: heavy 1-2 character fragmentation (seen historically on some carrier PDFs), and **space-mangled** output where whole phrases collapse into one token (`STATEFARMFIREANDCASUALTYCOMPANY`) — the signature of Type-3 / custom-encoded fonts whose inter-word spacing lives in glyph positioning, which pdfjs and Docling's default backend both drop. When the text layer can't be determined at all (corrupt or encrypted header, unexpected parse error), the document is treated conservatively as scanned and routed to the heavy provider — which reads both scanned and digital PDFs — so it never silently ships empty markdown.

> **Serverless note.** pdfjs-dist's Node build needs two things that don't survive a serverless bundle untouched, both handled by the single wrapper at `api/src/parse/pdfjs-loader.ts`:
>
> 1. **Browser globals.** The Node build references `DOMMatrix`, `ImageData`, and `Path2D` at import time and tries to source them from its optional native dependency `@napi-rs/canvas`. That native binary fails to load in some serverless runtimes (e.g. Vercel functions), which would make every digital PDF crash the pdfjs path. The wrapper installs pure-JS polyfills for those globals first, so text extraction works without the native module — no canvas binary is shipped.
> 2. **The worker module.** In Node, pdfjs runs its PDF engine on the main thread but still lazily does `import(GlobalWorkerOptions.workerSrc)` to load `pdf.worker.mjs`. Because the specifier is a runtime variable, bundlers/file-tracers (e.g. Vercel's) can't see it and don't ship the worker file, so the function dies with *"Setting up fake worker failed: Cannot find module …/pdf.worker.mjs"*. The wrapper imports the worker itself with a **static** specifier (so the file is traced and shipped) and registers it on `globalThis.pdfjsWorker`, which makes pdfjs use the already-loaded main-thread handler and skip the runtime import entirely.

#### Bring-your-own parse (per-tenant providers)

The "heavy" parser above is resolved **per document at ingestion time**, not fixed at boot. When a tenant has configured a parse endpoint (Settings → Parse Catalog, or a pipeline-pinned override stored in the pipeline's `config_json.parse_provider_id`), that provider replaces Docling for the document's scanned/image/non-PDF path. The credential is decrypted at call time, mirroring how BYO model endpoints work for extraction — the customer pays the parse vendor directly.

This resolution is uniform across every execution path that parses a document: the single-document ingestion worker, the DAG pipeline runner, and build/test mode all resolve the tenant's parse provider the same way (honoring the pipeline pin) and key the provider-aware parse cache under the resolved provider's fingerprint — so a pipeline run, a manual upload, and a test run all parse a given document identically.

**Dormant until configured.** A tenant with no parse endpoint configured gets exactly the default behavior described above (Docling for the heavy path). The resolver returns nothing when there's no endpoint, no driver, or no decryptable credential, and every path falls back to the same default provider instance — so existing deployments are unaffected.

#### Doc-type routing (table-heavy → structured)

When a tenant configures a **structured** parse provider (one that preserves row/column structure — e.g. Google Document AI, Textract, or the digital-positional path), the smart router adds a second routing dimension on top of source-type detection:

| Content shape | Routes to | Why |
|--------------|-----------|-----|
| **Table-heavy** (dec pages, schedules, grids) | the structured provider | flattening a grid to markdown scrambles which value belongs to which column |
| **Text-heavy** (letters, covenants, prose) | the markdown/Docling path | markdown is the right representation; no table-extraction premium |

Table- vs text-heaviness is a **geometric** signal (the fraction of lines that read as multi-column grids in the PDF's text-item layout), not a per-document-type rule — the engine never inspects field names or document categories. The structured path has the same safety net as pdfjs: if it errors, the request falls through to source-type routing (digital → pdfjs, otherwise → Docling). This routing is **inert unless a structured provider is configured** — the content-shape classifier isn't even invoked otherwise, so the default path pays nothing.

#### Docling (heavy provider)

[Docling](https://github.com/DS4SD/docling) provides OCR, table detection, and layout analysis:

- Accepts file uploads at `/parse`
- Runs Docling conversion in a thread pool to avoid blocking the event loop
- Returns markdown text, page count, and a `text_map` of word-level bounding boxes
- Caches Hugging Face and Torch model weights in Docker volumes for fast restarts
- Also exposes `/normalize-pdf`: a pypdfium2 re-save (with security removal)
  for PDFs the API's local pdf-lib tooling can't read — owner-password
  encryption with object-stream page trees. The API calls it once before
  slicing such documents (Doc AI slice-and-merge, chunked parse); see
  `api/src/parse/pdf-normalize.ts`.
- Recovers **space-mangled** digital text layers: when Docling's own output
  shows the long-token signature (Type-3 / custom-encoded fonts whose spacing
  its default and pypdfium backends both drop), the service re-extracts with
  poppler's `pdftotext -bbox-layout` — which resolves spacing at the glyph
  level — and returns poppler's markdown + word bounding boxes instead. The
  recovery is only accepted when it actually unmangles the text; otherwise
  Docling's output is kept. `poppler-utils` already ships in the base image, so
  this adds no dependency. (This mirrors the API-side corruption check, so a
  digital PDF that pdfjs mangles is re-extracted cleanly even after it falls
  back to the heavy provider.)

This service is memory-intensive. Allocate 8-12GB to Docker Desktop for reliable operation.

#### Base image split

The parse service image is split into two layers to keep rebuilds fast:

- `docker/parse.base.Dockerfile` — a heavyweight base image (`ghcr.io/getkoji/parse-base`) that pins Python, docling, torch (CPU), transformers, and the OCR system stack (tesseract, poppler). It is ~5GB and rebuilds rarely — only when `parse.base.Dockerfile` changes or on a manual workflow dispatch.
- `docker/parse.Dockerfile` — a thin application image that `FROM`s the base and only copies `services/parse/`. It is ~50MB on top of the base and rebuilds in seconds on every push.

This means editing the parse service's Python code triggers a tiny rebuild instead of reinstalling docling, torch, and the OCR toolchain every time. Dependency bumps still require a base image rebuild; bump the pinned versions in `parse.base.Dockerfile` and run the `Publish Images` workflow with `build_parse_base=true` (or push a tag). All pinned versions are explicit — no `latest` — so both images are reproducible.

### Ollama

**Port:** 11434 (internal) | **Technology:** Ollama

Optional local model hosting. When enabled, the API Server routes LLM requests to Ollama for fully local, air-gapped processing. Model weights are persisted in a Docker volume so they survive container restarts.

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

The mapper splits markdown into **chunks** by heading structure, then refines the split at **thematic breaks** — CommonMark horizontal rules (`---`, `***`, `___`) that parsers emit at page/section boundaries. When a parser packs two logically distinct sections under one heading with only a page rule between them (e.g. a notice page immediately followed by a declarations page), splitting there lets each part be classified on its own text instead of the head of the merged block — otherwise a category filter (`look_in`) would drop the second part. To avoid over-fragmenting, adjacent fragments of the same category (and small or unclassified fragments like page headers/footers) are **coalesced** back together, so a homogeneous section stays one chunk and only a genuine, substantial category shift creates a boundary. Each chunk gets:

- A **category** (e.g., `header`, `line_items`, `totals` — or anything you define) inferred from your schema's `categories.keywords` block. Without a schema, every chunk is `other`.
- **Signals** — built-in structural detectors: `has_dollar_amounts`, `has_dates`, `has_key_value_pairs`, `has_tables`. Schemas can define **custom signals** via regex patterns (e.g., `has_policy_numbers` for insurance, `has_invoice_numbers` for invoices).

When the parsed markdown contains no `#` headings — common for OCR'd scans, invoices, and table-heavy forms — the mapper runs a **heading inference** pass first, promoting standalone bold lines, ALL CAPS labels, and schema-defined patterns to `##` headings so the chunker has structure to split on. See [Heading inference](schema-guide.md#heading-inference) in the schema guide.

The mapper also normalizes table rows before splitting: parsers like docling sometimes represent column-spanning cells by duplicating the cell content N times across a row (e.g. `| Dated | Dated | Dated | April 9, 2026 | April 9, 2026 | April 9, 2026 |`). Runs of three or more identical adjacent cells are collapsed to a single cell when the row shows an alphabetic-cell triplication signal, so downstream extraction sees the original value instead of treating the repetition as distinct data points. Financial rows that legitimately repeat a value (e.g. `| Revenue | $100 | $100 | $100 |`) are left alone.

The result is a structural map of the document — what kind of data is in it and where. The mapper itself is fully domain-agnostic; all domain knowledge lives in your schema.

### Phase 1.5: Classify and split (optional)

When a `step: classify` entry is present in `koji.yaml`, an optional stage runs between mapping and routing. It takes the chunk list and asks a small LLM to partition it into **typed sections** — invoice, COI, policy, SEC filing, or whatever document types the config declares. Each section owns a contiguous run of chunks and carries a type label.

This solves the "stapled packet" problem: if a user uploads one file that contains an invoice (page 1), a certificate of insurance (page 2), and an insurance policy (pages 3–10), the classifier recognizes the three distinct documents, the splitter emits three sections, and the router downstream can be told (via a schema's `apply_to` field) to only run against the sections it cares about. Without this stage, extraction would blend the three documents' text together and usually latch onto whatever keyword appears first.

The classifier is a separate LLM call from extraction, with its own `model` config key so cheap models can be used for classification without sacrificing extraction quality. Its output is validated by a normalizer that deterministically handles overlap, gap, and out-of-range errors — when the classifier fails entirely, the pipeline gracefully falls back to treating the whole document as one section, preserving pre-classifier behavior.

When the classify stage is disabled (the default), the pipeline is byte-identical to single-document processing. See [classify-split design doc](design/classify-split.md) for the full pipeline contract, the `apply_to` schema surface, and the normalizer's failure-mode handling.

### Phase 2: Route

The router matches each schema field to the chunks most likely to contain its value. Routing uses a scoring system with three tiers:

1. **Schema hints** (highest priority) -- if the schema author specified `hints.look_in`, `hints.patterns`, or `hints.signals`, those drive routing directly
2. **Generic inference** -- field type maps to expected signals (date fields look for chunks with `has_dates`, number fields look for `has_dollar_amounts`), plus field name matching against chunk titles and content
3. **Broadened fallback** -- if nothing scored, route to any chunk with signals, or as a last resort, the first chunks of the document

Each field is routed to the top 3 scoring chunks by default. Fields that legitimately aggregate data from many chunks — like a `policies` array on an insurance certificate, where each policy's detail lives in its own section — can override this with `hints.max_chunks: N` in the schema.

The key design decision: **no hardcoded domain knowledge in the pipeline**. The router is entirely generic. Domain knowledge lives in the schema via hints. This means the same pipeline works for invoices, insurance policies, medical records, or any document type — change the schema, not the code.

### Phase 3: Extract (grouped, wave-ordered)

Before extraction runs, Koji topologically sorts fields into **extraction waves** based on any `depends_on` declarations in the schema. Wave 0 holds every field with no dependencies and runs exactly like the old single-pass extraction. Wave 1+ fields can't start until their parents have been extracted in earlier waves. Between waves, Koji resolves any `extraction_hint_by` conditional hints against the values accumulated so far — so a field like `period_of_report` can see a form-type-specific hint that only makes sense after `form_type` has been extracted. See [Conditional hints](schema-guide.md#conditional-hints-based-on-other-fields) in the schema guide.

Within each wave, fields that route to overlapping chunks are **grouped together** into a single LLM call. This is where the efficiency gain comes from: instead of one LLM call per field, or one massive call for the whole document, Koji makes the minimum number of calls needed.

For example, if `policy_number`, `effective_date`, and `insured_name` all route to the declarations page, they become one extraction group with one focused prompt.

Each group's prompt contains only the relevant document chunks and field specifications. Groups run concurrently (up to 5 in parallel by default). Schemas without any `depends_on` declarations always produce a single wave, so grouping maximizes across every field as before.

Every prompt is checked against the model's **context window budget** before it's sent (128k tokens assumed, minus the 16k completion reserve). When a group's chunks are too large for one call — big packets, heading-poor scans, wide tables — the chunk set is packed into consecutive window-sized subsets and one call runs per subset. Scalar fields take the first value found in document order; array fields union their rows across subsets (deduplicated by content, per-row provenance preserved). The same guard applies to gap-fill and row-enumeration passes, so no document is too large to extract.

### Phase 4: Validate

Each extracted value is validated and normalized against its field spec:

- **Dates** are normalized to ISO 8601 (`YYYY-MM-DD`)
- **Numbers** are cleaned of currency symbols and commas, converted to numeric types
- **Text** (when the field opts in via `normalize: prose`) gets standard English spacing — trim, collapse whitespace runs, remove space before punctuation. Use on names, addresses, descriptions where OCR or source formatting introduces non-standard spacing; leave off for identifiers and codes that may legitimately contain whitespace runs.
- **Enums** are fuzzy-matched against allowed options (case-insensitive, substring matching)
- **Mappings** resolve aliases to canonical values (e.g., "NY" and "New York" both resolve to "New York")
- **Required fields** are flagged if null

### Phase 5: Reconcile

Results from all extraction groups are merged into a single output. When multiple groups extract the same field (from overlapping chunks), the reconciler combines them and the value is scored against the schema.

After reconciliation, any required fields still missing trigger **gap filling**: a broadened retry that searches up to 6 chunks with a targeted single-field prompt. Routing hints (`look_in`, `patterns`, `prefer_contains`) are *stripped* for the gap-fill re-route so it truly escapes whatever over-filtering the main pass ran into — the router falls back to generic type-based scoring across the full chunk pool. Per-field `extraction_hint` guidance is preserved in the prompt so the model still gets the disambiguation context. This catches values that were missed because the main pass's declared scope didn't include the right chunk.

### Phase 6: Per-field confidence (deterministic)

Each extracted value gets a confidence score in `[0.0, 1.0]` derived **entirely from the schema and the value** — never from the LLM's self-rated `__confidence` (which is conservatively calibrated noise; unambiguous correct picks routinely come back at ~0.7 and trip review thresholds for no reason). The LLM's `__confidence` key is stripped at JSON parse time so it can't leak into downstream code.

Per-type scoring rules:

| Type | 1.0 | 0.5 | 0.0 |
|------|-----|-----|-----|
| `enum` | value is in `options` (case-sensitive) | — | not in options |
| `mapping` | value is a canonical key (case-sensitive) | — | not a canonical |
| `integer` | parses + in `min`/`max` range | parses, no range declared | doesn't parse to int |
| `number` | parses + in range | parses, no range declared | doesn't parse |
| `date` | parses in schema's `format` (default `YYYY-MM-DD`) | valid date, wrong format | not a date |
| `boolean` | strictly `true` or `false` | — | anything else |
| `string` w/ `pattern` | matches regex | — | doesn't match |
| `string` w/o pattern | non-empty + provenance found it | non-empty, no provenance hit (= 0.7) | empty |
| `object` | mean of its declared sub-fields' scores (each scored recursively from per-property provenance) | — | not an object |
| `array` | mean of its elements' scores (each element scored recursively from per-element provenance); empty array = 1.0 if optional | — | empty array + required |
| any | value is `null`, schema doesn't require it | — | required field is null |

`array` and `object` fields are scored by **recursing into the per-element / per-property provenance** the resolver already produces and averaging — so a correct, well-grounded array reflects its true confidence instead of collapsing to 0.0 and force-tripping review on every document.

**Doc-level confidence = `min` of per-field scores** (strict). The document is only as confident as its weakest field. The HITL review gate routes the doc to review when *any* field falls below the pipeline's `review_threshold` (default 0.85). Optional fields that come back null are scored 1.0 (legitimate absence) so they don't drag the doc down.

**Review routing uses the engine's scores, not a recomputation.** The ingestion review gate flags off the same per-field `confidence_scores` the extraction engine emits — the numbers persisted with the document and shown in the UI — so a review item's confidence can never disagree with the document's own scores. The only adjustment at the gate is for null values: the engine scores every null 0.0 (`not_found`), so the gate re-credits optional nulls at 1.0 (required nulls stay 0.0). The schema-based scoring matrix above serves as the fallback when a non-null field is missing an engine score.

**Every pipeline entrypoint shares one outcome path.** The routing decision and its effects (per-field score persistence, review-item creation, provenance/fit JSON, job counters, `document.review_requested` / `document.delivered` webhooks and notifications) live in a single module (`ingestion/outcome.ts`) called by both the simple ingestion path and the DAG runner. A document that ends a DAG run on an extract step is scored and review-routed exactly like a single-schema document — DAG pipelines don't get a private, weaker delivery contract.

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
5. API Server runs the extraction pipeline in-process:
   a. EXTRACT   — send prompts to the model provider (LLM) concurrently
   b. VALIDATE  — normalize types, fuzzy-match enums, check required fields
   c. RECONCILE — merge results, gap-fill missing required fields
   |
6. API Server returns structured JSON + confidence scores + metadata
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

`job.failed` also fires for jobs that the API detects as stuck — running for more than 30 minutes, or running for more than 10 minutes without processing any documents. The `reason` field on the payload explains which condition tripped. Detection runs every 60 seconds in the background; consumers don't need to poll.

Every tenant-configured model endpoint also reports its own health: three consecutive call failures flip the endpoint to `unhealthy` and emit an `endpoint.unhealthy` event; the next successful call flips it back and emits `endpoint.recovered`. The payload identifies the endpoint by slug and ID so consumers can route alerts per-endpoint.

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
               docker pull ghcr.io/getkoji/api:latest
               docker compose up
```

### Production (Koji Cloud)

The hosted version runs the same services with managed infrastructure. The architecture is identical — the only additions are auth, billing, and persistent multi-tenant storage.

### Tenancy & project isolation

Isolation is enforced in Postgres with row-level security, at two levels:

- **Tenant** — every tenant-scoped table carries a denormalized `tenant_id`
  and a permissive RLS policy that matches it against a per-transaction
  setting. A transaction that never names a tenant sees zero rows.
- **Project** — the boundary *within* a tenant. Directly-listed resources
  (schemas, pipelines, jobs, sources, classifiers, review items, model/parse
  endpoints, webhooks, API keys, agent sessions) also carry a `project_id`
  with a **restrictive** policy: when a request resolves a project (via the
  `x-koji-project` header, the API key's bound project, or the tenant's
  default project), rows outside that project are invisible; when no project
  is set — background workers, org-level queries — access stays tenant-wide.

Every request path reaches the database through `withRLS(db, scope, fn)`,
which applies both settings with `SET LOCAL` inside a transaction. Child rows
that are only reachable through a project-checked parent (schema versions,
documents, traces, corpus entries, …) inherit the boundary transitively.

`notifications` is a special case: its `project_id` is **nullable** and its
restrictive policy is null-aware — a notification with no project (queue
failures, billing alerts) stays visible in every project, while a
project-scoped notification is only visible in its project. This lets the
dashboard notification bell scope to the selected project without hiding
tenant-level alerts.

## Hosted architecture (Koji Cloud)

Best-of-breed services, each chosen for a specific strength. The hosted platform runs at console.getkoji.dev.

```
                    ┌──────────────────┐
                    │     Vercel       │
                    │    (Next.js)     │
                    │    Dashboard     │
                    └────────┬─────────┘
                             │
                    ┌────────┴─────────┐
                    │      Clerk       │
                    │     (Auth)       │
                    └────────┬─────────┘
                             │ JWT
                    ┌────────┴─────────┐
                    │  Vercel Funcs    │
                    │  API (Hono)      │──── Neon (Postgres)
                    │  api.getkoji.dev │──── R2 (documents)
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
        ┌─────┴──────┐ ┌────┴────┐ ┌──────┴──────┐
        │    Parse   │ │ Extract │ │   Inngest   │
        │   Modal    │ │  Vercel │ │ (job queue) │
        │  GPU/OCR   │ │  Funcs  │ │             │
        │ auto-scale │ │         │ │             │
        └────────────┘ └─────────┘ └─────────────┘
```

### Stack choices

| Layer | Product | Details | Cost |
|-------|---------|---------|------|
| **Frontend** | Vercel (Next.js) | Dashboard at console.getkoji.dev, auto-deploys on push to main | Free tier (Hobby) |
| **API** | Vercel Serverless Functions (Hono) | api.getkoji.dev, Node.js + Hono, esbuild-bundled, 300s max duration | Included in Vercel plan |
| **Database** | Neon (Postgres) | Drizzle ORM, connection pooling, migrations via @koji/db | Generous free tier |
| **Auth** | Clerk | Org/user management, JWT validation, webhook sync to Postgres | Free to 10k MAU |
| **Parse/OCR** | Modal | GPU compute for Docling PDF parsing, auto-scales, per-second billing | Pay-per-second GPU |
| **Documents** | Cloudflare R2 | S3-compatible. Zero egress fees. | $0.015/GB stored |
| **Job queue** | Inngest | Background job orchestration, durable execution, retry logic | Free tier available |
| **Billing** | Stripe | Subscription management, webhook validation via Svix | Per-transaction |

**Estimated cost at launch:** ~$0-20/mo before first paying customer. Vercel, Neon, and Inngest all have generous free tiers. Modal charges only for active GPU seconds. R2 storage is the only ongoing baseline cost.

**Why best-of-breed:**
- **Vercel** for frontend/API: native Next.js support, preview deployments, zero-config serverless
- **Neon** for database: serverless Postgres, branching for preview environments, scales to zero
- **Modal** for GPU compute: parse/OCR needs GPU, Modal auto-scales and auto-sleeps, per-second billing
- **R2** for storage: zero egress fees (critical for document processing where users download results)
- **Inngest** for jobs: durable execution, automatic retries, built-in observability

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
- **Hosted:** deployed on Vercel. `NEXT_PUBLIC_KOJI_MODE=cloud` enables the Clerk provider, team switcher, and billing page.

The pages are identical: jobs, schemas, pipeline viz, logs, settings. Only the auth wrapper and billing page differ.

### Postgres everywhere

The database story is the key to local/prod parity:

- **Self-hosted:** Postgres in a Docker container (via docker-compose)
- **Hosted:** Neon (serverless Postgres)

Same engine, same Drizzle schema, same migrations. A schema developed locally works identically in production. The `@koji/db` package owns all migrations and runs them through CI — never manually applied.

## Next steps

- [Getting Started](getting-started.md) -- install and process your first document
- [Configuration Reference](configuration.md) -- full `koji.yaml` options
- [Schema Guide](schema-guide.md) -- field types, hints, and validation
