---
title: API Reference
description: Complete reference for the Koji HTTP API.
---

# API Reference

The Koji API server runs on port `base_port + 1` (default `9401`). All endpoints return JSON.

Base URL: `http://localhost:9401`

---

## Tenant & project scoping

Tenant-scoped endpoints identify the workspace via the `x-koji-tenant` header
(or, on hosted deployments, the auth token's organization claim).

Within a tenant, **projects are the isolation boundary**: schemas, pipelines,
jobs, sources, classifiers, review items, model/parse endpoints, webhooks, and
API keys each belong to exactly one project, and requests only see the
resources of the project they resolve to. Resolution order:

1. `x-koji-project: <project-slug>` header, when present (`404` if the slug
   doesn't exist in the tenant).
2. The API key's own project — every API key is created inside a project.
3. The tenant's default project (the one whose slug matches the tenant slug,
   falling back to the oldest project).

```
Authorization: Bearer koji_yourkey
x-koji-tenant: your-tenant-slug
x-koji-project: your-project-slug   # optional with session auth
```

**API keys are a project boundary, not a default.** A key can only operate
inside the project it was created in: an `x-koji-project` header naming any
other project answers `404`, a key is rejected (`403`) for any tenant other
than its own, and a key whose project has been deleted stops working (`403`).
To work in another project, create a key there. Session-authenticated
requests (the dashboard) may name any live project in the tenant.

Resource slugs are unique **per project**, not per tenant: two projects can
each have a pipeline named `invoices`. Deleting a workspace's last remaining
project is rejected (`400`).

**Per-member access + roles.** New members are default-deny (need-to-know):
they see no project until an admin grants access; owners/tenant-admins see all.
An admin grants access **with a per-project role** via
`PUT /api/members/{id}/project-access`, body
`{ restricted, projects: [{ slug, roles: [project-viewer|project-member|project-editor|project-admin] }] }`.
Within a granted project the member's capability comes from that project role
(not their workspace role); org-level powers (member/tenant/billing) always come
from the workspace role and are never granted per-project. Requests to a project
the member can't access return `403`. `GET /api/members/{id}/project-access`
returns the current setting + roles. API keys are unaffected — a key is bound to
one project. Existing members are grandfathered (keep current access).

### `POST /api/projects/{slug}/move`

Move a resource into the project named by `{slug}`. Requires the moved
resource's own write permission (e.g. `pipeline:write` to move a pipeline).

**Body**

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `schema` \| `pipeline` \| `source` \| `classifier` \| `model_endpoint` \| `parse_endpoint` \| `webhook_target` \| `api_key`. |
| `id` | string | The resource's UUID. |
| `dry_run` | boolean | Optional. Validate only — report blockers without moving. |

History follows the resource: moving a pipeline moves its jobs and their
review items too. Because resources resolve **within** a project, a move that
would leave a resource referencing another project (a pipeline whose schema
stays behind) is rejected:

- `409` with `{ blockers: [{ type, slug, reason }] }` — move those into the
  destination first (or move into the same project).
- `409` with `{ conflict }` — the destination already has a resource of that
  type with the same slug.

Returns `200 { ok: true }` on success (`dryRun: true` echoed on a dry run).

---

## Health

### `GET /health`

Liveness check for the API server.

**Response** `200 OK`

```json
{
  "status": "healthy",
  "service": "koji-server",
  "version": "0.19.0"
}
```

---

## Status

### `GET /api/status`

Cluster status including health of all downstream services, cluster metadata, and the active pipeline configuration.

**Response** `200 OK`

```json
{
  "services": {
    "server": {
      "status": "healthy",
      "url": "http://127.0.0.1:9401",
      "response_ms": 0
    },
    "parse": {
      "status": "healthy",
      "url": "http://koji-parse:9410",
      "response_ms": 45
    },
    "ollama": {
      "status": "unreachable",
      "url": "http://ollama:11434",
      "response_ms": null
    }
  },
  "cluster": {
    "project": "koji-dev",
    "name": "default",
    "uptime_seconds": 3600
  },
  "pipeline": [
    { "step": "parse", "engine": "docling" },
    { "step": "extract", "model": "openai/gpt-4o-mini", "schemas": ["./schemas/invoice.yaml"] }
  ]
}
```

Service status values: `healthy`, `unhealthy`, `unreachable`.

---

## Config

### `GET /api/config`

Returns the active `koji.yaml` configuration as JSON, with `null` fields omitted.

**Response** `200 OK`

```json
{
  "project": "koji-dev",
  "cluster": { "name": "default", "base_port": 9400 },
  "services": { "parse": true, "ollama": true },
  "pipeline": [
    { "step": "parse", "engine": "docling" },
    { "step": "extract", "model": "openai/gpt-4o-mini" }
  ],
  "output": { "structured": "./output/" }
}
```

---

## Parse

### `POST /api/parse`

Send a document to the parse service and get markdown back. This calls the parse service directly -- no extraction.

**Request** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | Yes | The document to parse (PDF, DOCX, image, etc.) |

**Response** `200 OK`

```json
{
  "filename": "invoice.pdf",
  "pages": 3,
  "markdown": "# Invoice\n\nInvoice Number: INV-2026-0042\n...",
  "text_map": [
    { "text": "Invoice", "page": 1, "bbox": { "x": 0.12, "y": 0.06, "w": 0.2, "h": 0.02 }, "level": "word" },
    { "text": "Number:", "page": 1, "bbox": { "x": 0.12, "y": 0.09, "w": 0.13, "h": 0.02 }, "level": "word" }
  ],
  "elapsed_seconds": 4.2
}
```

| Field | Type | Description |
|-------|------|-------------|
| `markdown` | string | The document converted to markdown. |
| `pages` | integer | Page count of the source document. |
| `text_map` | array | Word-level bounding boxes mapping text to positions in the source document. Used by the extraction pipeline to resolve provenance highlights. See [Provenance](#provenance). |
| `elapsed_seconds` | number | Parse time in seconds. |

**Errors**

| Status | Description |
|--------|-------------|
| `502` | Parse service unavailable. |

---

## Process

### `POST /api/process`

Full pipeline: parse a document, then optionally extract structured data using a schema. Supports both synchronous and asynchronous modes.

**Request** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | Yes | The document to process. |
| `schema` | string | No | Schema definition (YAML or JSON string). When omitted, returns parse results only. |

**Query parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `async` | boolean | `false` | When `true`, returns immediately with a job ID. Poll `/api/jobs/{id}` for results. |

#### Synchronous response `200 OK`

Without schema (parse only):

```json
{
  "filename": "invoice.pdf",
  "pages": 3,
  "markdown": "# Invoice\n...",
  "elapsed_seconds": 4.2
}
```

With schema (parse + extract):

```json
{
  "filename": "invoice.pdf",
  "pages": 3,
  "parse_seconds": 4.2,
  "extracted": {
    "invoice_number": "INV-2026-0042",
    "date": "2026-03-15",
    "total_amount": 6000.00
  },
  "model": "openai/gpt-4o-mini",
  "schema": "invoice",
  "elapsed_ms": 2340,
  "tool_calls": 3,
  "rounds": 1,
  "trace": { "version": 1, "trace_id": "trc_8f3a91c2", "status": "complete", "stages": [/* ... */] }
}
```

The `trace` object describes the pipeline run — its shape is locked and documented in [Trace Format](trace-format.md). Every stage maps 1:1 onto the `trace_stages` table so downstream consumers can persist it directly.

#### Async response `202 Accepted`

```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending"
}
```

**Errors**

| Status | Description |
|--------|-------------|
| `400` | Invalid schema format. |
| `502` | Upstream service (parse or extract) unavailable or returned an error. |

**Webhooks:** Fires `job.completed` or `job.failed` on completion (synchronous mode).

---

## Classify

### `POST /api/classify`

Classify a document into one of a user-defined set of classes. Runs a cost
cascade — cheap deterministic signals first, paid model calls only for the hard
tail — and stops at the first confident tier. Non-persisting, so it also serves
as the test surface. Config is inline; classes, keywords, and windows are all
yours (the engine ships no built-in classes).

**Request** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | Yes | The document to classify. |
| `config` | string | Yes | Classifier config as YAML or JSON (see below). |

Or `application/json` with a stored document:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `storage_key` | string | Yes | Key of a previously uploaded document. |
| `config` | object | Yes | Classifier config. |
| `filename` | string | No | Overrides the name inferred from `storage_key`. |
| `mime_type` | string | No | Overrides the inferred content type. |

**Config**

```yaml
classify:
  window: 3            # default leading pages to consider
  scan: head           # head | head_and_tail
  max_tier: 4          # cost ceiling: 0 meta · 1 text · 2 keyword · 3 llm · 4 vision
  on_unknown: return   # return unknown, or reject (422)
classes:
  invoice:
    description: "a vendor bill"
    keywords: ["invoice", "amount due", "remit to"]
    window: 2          # per-class cost dial
  policy:
    keywords: ["declarations", "insuring agreement"]
```

**Response** `200 OK`

```json
{
  "label": "invoice",
  "confidence": 0.9,
  "method": "keyword",
  "tier_used": 2,
  "evidence_page": 2,
  "scores": [
    { "id": "invoice", "score": 0.9, "hits": 3, "total": 3, "evidence_page": 2 }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `label` | string | Winning class id, or `"unknown"`. |
| `confidence` | number | Confidence in the label (0–1). Semantics vary by `method`. |
| `method` | string | Tier that produced the label: `keyword`, `llm`, `vision`, or `unknown`. |
| `tier_used` | integer | Numeric tier reached (0 metadata … 4 vision). Conveys the cost paid. |
| `evidence_page` | integer\|null | Page the label was keyed on — helps debug cover-sheet misses. |
| `scores` | array | Per-class deterministic scores, when the keyword tier ran. |

**Errors**

| Status | Description |
|--------|-------------|
| `400` | Missing file/config, or an invalid classifier config. |
| `404` | `storage_key` not found. |
| `422` | No class matched and the config set `on_unknown: reject`. |

---

## Content-Type and Ingestion Warnings

Every ingestion endpoint expects an RFC-compliant `Content-Type` (`type/subtype`) — for example `application/pdf`, `image/png`, `text/csv`. The server uses it as the canonical document type for downstream parsing and rendering.

When the server can't trust the supplied value, it coerces it from the filename extension and surfaces a warning rather than rejecting the request:

| Supplied `Content-Type` | What happens |
|-------------------------|--------------|
| Valid (`application/pdf`) | Used as-is. |
| Bare extension (`pdf`) | Coerced from filename. **Warning emitted.** |
| Missing / empty | Coerced from filename. **Warning emitted.** |
| Valid but mismatched (`application/zip` on a `.pdf`) | Used as-is — the server does not second-guess valid MIME types. |
| No usable signal at all | Falls back to `application/octet-stream`. **Warning emitted.** |

When a warning is emitted, the JSON response includes a `warnings` array. The document is still accepted and processed.

```json
{
  "jobId": "abc...",
  "documentId": "doc_...",
  "warnings": [
    "Content-Type \"pdf\" is not a valid MIME type (must be in the form \"type/subtype\"). Coerced to \"application/pdf\" based on filename \"policy.pdf\". Send an RFC-compliant Content-Type header on upload."
  ]
}
```

Bare-extension headers (`Content-Type: pdf`) are the most common cause and typically come from a misconfigured presigned-upload client. Fix the client header and the warning goes away.

The same warning is also written to the server logs as `[mime-normalize] ...` for operators triaging integration issues.

---

## Upload (Presigned)

For files larger than 4.5 MB on Koji Cloud, use the presigned upload flow.

### `POST /api/upload/presign`

Generate a presigned PUT URL for direct-to-storage upload.

**Auth:** Bearer token. Requires `corpus:write` permission.

**Request body:**

```json
{
  "filename": "document.pdf",
  "contentType": "application/pdf",
  "context": "corpus",
  "schemaSlug": "claim_form"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `filename` | string | yes | Original filename |
| `contentType` | string | yes | MIME type (e.g., `application/pdf`) |
| `context` | string | yes | `"corpus"` for schema corpus, `"test"` for ephemeral test uploads |
| `schemaSlug` | string | for corpus | Schema slug to associate the upload with |

**Response** `200 OK`

```json
{
  "uploadUrl": "https://storage.example.com/presigned-put-url...",
  "storageKey": "corpus/tenant-id/schema-id/1718000000-document.pdf"
}
```

The client PUTs the file directly to `uploadUrl`, then calls `/api/upload/complete`.

### `POST /api/upload/complete`

Finalize a presigned upload and create the corpus entry.

**Auth:** Bearer token. Requires `corpus:write` permission.

**Request body:**

```json
{
  "storageKey": "corpus/tenant-id/schema-id/1718000000-document.pdf",
  "filename": "document.pdf",
  "context": "corpus",
  "schemaSlug": "claim_form"
}
```

**Response** `201 Created` — the new corpus entry.

If a file with the same content hash already exists, returns `200 OK` with the existing entry (duplicate is cleaned up from storage).

---

## Extract

### `POST /api/extract`

Extract structured data from markdown using a schema. No file upload -- operates on text directly. Useful for re-running extraction on previously parsed documents.

**Request** `application/json`

```json
{
  "markdown": "# Invoice\n\nInvoice Number: INV-2026-0042\n...",
  "schema": "name: invoice\nfields:\n  invoice_number:\n    type: string\n    required: true",
  "strategy": "parallel",
  "model": "openai/gpt-4o-mini"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `markdown` | string | Yes | The markdown text to extract from. |
| `schema` | string | Yes | Schema definition as a YAML or JSON string. |
| `strategy` | string | No | Extraction strategy: `parallel` or `agent`. |
| `model` | string | No | Model override (e.g., `openai/gpt-4o-mini`). |

**Query parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `async` | boolean | `false` | When `true`, returns immediately with a job ID. |

#### Synchronous response `200 OK`

```json
{
  "extracted": {
    "invoice_number": "INV-2026-0042",
    "date": "2026-03-15",
    "total_amount": 6000.00
  },
  "model": "openai/gpt-4o-mini",
  "schema": "invoice",
  "elapsed_ms": 1200,
  "tool_calls": 3,
  "rounds": 1,
  "trace": { "version": 1, "trace_id": "trc_8f3a91c2", "status": "complete", "stages": [/* ... */] }
}
```

The `trace` object is the locked pipeline-observability envelope. See [Trace Format](trace-format.md) for the full schema, stage catalog, and per-stage `summary_json` contents.

When the schema declares a [`fit` block](schema-guide.md#document-fit-is-this-even-the-right-document), the response also carries a `fit` object reporting whether the document belongs to this schema:

```json
{
  "extracted": { /* ... */ },
  "fit": {
    "ok": false,
    "action": "warn",
    "reason": "low_field_grounding",
    "message": "This does not look like a 'invoice' document: only 0 of 2 anchor field(s) ([...]) were found in the source.",
    "score": 0.0,
    "extraction_skipped": false,
    "checks": [ /* per-check detail */ ]
  }
}
```

`fit.ok` is `true` only when every declared check passes. Under `on_misfit: reject`, a failed pre-extraction check skips extraction entirely — the extracted fields are `null` and `fit.extraction_skipped` is `true`. A misfit is reported as a normal `200` (not a `400`); see the [schema guide](schema-guide.md#document-fit-is-this-even-the-right-document) for the full contract.

#### Async response `202 Accepted`

```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending"
}
```

**Errors**

| Status | Description |
|--------|-------------|
| `400` | Invalid schema format. |
| `502` | Extract service unavailable or returned an error. |

**Webhooks:** Fires `job.completed` or `job.failed` on completion (synchronous mode).

---

## Jobs

Jobs track the status and results of asynchronous processing requests. Jobs are stored in memory with a TTL of 1 hour. The most recent 50 jobs are returned by the list endpoint.

### `GET /api/jobs`

List recent jobs, newest first.

**Response** `200 OK`

```json
[
  {
    "job_id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "completed",
    "created_at": "2026-04-11T12:00:00+00:00",
    "completed_at": "2026-04-11T12:00:04+00:00",
    "schema_name": "invoice"
  },
  {
    "job_id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "status": "processing",
    "created_at": "2026-04-11T12:01:00+00:00",
    "completed_at": null,
    "schema_name": null
  }
]
```

### `GET /api/jobs/{job_id}`

Get the status and result of a specific job.

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `job_id` | string | UUID of the job. |

**Response** `200 OK` (completed job)

```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "created_at": "2026-04-11T12:00:00+00:00",
  "completed_at": "2026-04-11T12:00:04+00:00",
  "schema_name": "invoice",
  "result": {
    "extracted": {
      "invoice_number": "INV-2026-0042",
      "total_amount": 6000.00
    },
    "model": "openai/gpt-4o-mini",
    "elapsed_ms": 2340
  }
}
```

**Response** `200 OK` (failed job)

```json
{
  "job_id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  "status": "failed",
  "created_at": "2026-04-11T12:01:00+00:00",
  "completed_at": "2026-04-11T12:01:05+00:00",
  "schema_name": "invoice",
  "error": "Extract failed: model timeout"
}
```

**Job status values**

| Status | Description |
|--------|-------------|
| `pending` | Job created, not yet started. |
| `processing` | Job is actively running. |
| `completed` | Job finished successfully. `result` field contains output. |
| `failed` | Job failed. `error` field contains the error message. |

**Errors**

| Status | Description |
|--------|-------------|
| `404` | Job not found (expired or invalid ID). |

---

## Documents

Cloud-only, tenant-scoped endpoints for a processed document and its rendered
preview. Unlike the in-memory `/api/jobs` endpoints above, these address a
document by its job **slug** and document **id**, and require a tenant-scoped
API key:

```
Authorization: Bearer koji_yourkey
x-koji-tenant: your-tenant-slug
```

They are the data source behind the [embeddable PDF viewer](integration.md#embedding-the-pdf-viewer). If you only want to render the viewer, you usually don't call `/preview` or `/embed-data` yourself — fetch the document detail for the `documentToken` and hand it to the iframe. Call them directly when you need the signed PDF URL (or the highlights) outside the viewer.

### `GET /api/jobs/{slug}/documents/{docId}`

The full document record — extraction, provenance, validation, and the trace
with its stages — plus the fields needed to render the document:

| Field | Type | Description |
|-------|------|-------------|
| `documentPreviewUrl` | string \| null | App-relative URL that streams the original file inline (see `/preview` below). Includes a signed `?token=` when a master key is configured. `null` if the document has no stored file. |
| `documentToken` | string \| null | HMAC preview token, scoped to `/api/jobs/{slug}/documents/{docId}` and valid for **1 hour**. Authorizes `/preview` and `/embed-data` without a session cookie. `null` if no master key is configured (self-hosted dev). |
| `embedUrl` | string \| null | Ready-made `/embed/viewer?job=…&doc=…&token=…` URL for the iframe. `null` when `documentToken` is `null`. |

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `slug` | string | The job slug. |
| `docId` | string | The document UUID. |

**Response** `200 OK` (preview-relevant fields shown; the full body also
includes `filename`, `mimeType`, `pageCount`, `status`, `extractionJson`,
`provenanceJson`, `trace`, `stages`, …)

```json
{
  "documentId": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  "filename": "invoice-0042.pdf",
  "pageCount": 2,
  "status": "completed",
  "documentPreviewUrl": "/api/jobs/acme-invoices/documents/6ba7b810-9dad-11d1-80b4-00c04fd430c8/preview?token=68a1c3f0.9f2b…",
  "documentToken": "68a1c3f0.9f2b…",
  "embedUrl": "/embed/viewer?job=acme-invoices&doc=6ba7b810-9dad-11d1-80b4-00c04fd430c8&token=68a1c3f0.9f2b…"
}
```

URLs are app-relative — resolve them against your dashboard origin (e.g.
`https://console.getkoji.dev`).

**Errors**

| Status | Description |
|--------|-------------|
| `401` | Missing or invalid API key / tenant. |
| `404` | Document not found in this tenant. |

### `GET /api/jobs/{slug}/documents/{docId}/preview`

Streams the document bytes for inline rendering. Auth is the HMAC
`documentToken` (`?token=…`) **or** a session/API-key — so it works from a
cookieless cross-origin iframe.

By default this serves the **searchable** copy of a document when one exists
— a derivative with an OCR text layer added so the inline viewer is
`⌘F`-searchable — and falls back to the original bytes otherwise.

- `Content-Disposition: inline` and the real `Content-Type` (e.g.
  `application/pdf`), so browsers render rather than download.
- `Accept-Ranges: bytes` — honours `Range:` requests (and `HEAD`) so PDF.js
  streams the file in chunks instead of downloading it whole. A range request
  returns `206 Partial Content` with `Content-Range`; a plain GET returns the
  full body.

**Query parameters**

| Param | Description |
|-------|-------------|
| `original` | `1` to bypass the searchable derivative and stream the **original source document** as uploaded. Use this for "download" / "open original" affordances — the searchable copy adds an OCR text layer (and, for signed PDFs, may drop the digital signature), so it is not byte-identical to the source. |

```bash
# Full body (searchable copy when available)
curl -L "https://console.getkoji.dev/api/jobs/acme-invoices/documents/DOC_ID/preview?token=TOKEN" -o invoice.pdf

# The original source document, exactly as uploaded
curl -L "https://console.getkoji.dev/api/jobs/acme-invoices/documents/DOC_ID/preview?token=TOKEN&original=1" -o invoice-original.pdf

# First 64 KB only (range)
curl -H "Range: bytes=0-65535" \
  "https://console.getkoji.dev/api/jobs/acme-invoices/documents/DOC_ID/preview?token=TOKEN"
```

**Errors**

| Status | Description |
|--------|-------------|
| `403` | Missing, invalid, or expired preview token (and no session). |
| `404` | Document or stored file not found. |

### `GET /api/jobs/{slug}/documents/{docId}/embed-data`

Everything the embed viewer needs in one call — the signed preview URL plus the
provenance highlights. Same token auth as `/preview`.

**Response** `200 OK`

```json
{
  "previewUrl": "/api/jobs/acme-invoices/documents/DOC_ID/preview?token=TOKEN",
  "highlights": [
    {
      "field": "total_amount",
      "value": "6000",
      "page": 1,
      "bbox": { "x": 0.62, "y": 0.81, "w": 0.18, "h": 0.03 },
      "words": [ { "text": "$6,000.00", "page": 1, "x": 0.62, "y": 0.81, "w": 0.18, "h": 0.03 } ],
      "reasoning": "labeled 'Total Due'",
      "resolution": "offset"
    }
  ],
  "filename": "invoice-0042.pdf",
  "pageCount": 2
}
```

`highlights` is derived from the document's provenance (see
[Provenance](#provenance)). `bbox`/`words` coordinates are normalized fractions
of the page (0–1). `value` is the extracted value for the field (the scalar
from the extraction, or the highlighted words' text when the value isn't a
scalar) — the embed viewer's field picker shows it. `resolution` is the
provenance [resolution rung](#provenance-span) (`offset`/`chunk`/`fuzzy`/…): the
embed viewer draws `fuzzy` (best-guess) highlights with a dashed, muted border
and an "approximate location" hover note, so an exact locate is visually
distinct from a guess. The embed viewer consumes this shape directly; you can
also use it to drive your own renderer.

**Errors**

| Status | Description |
|--------|-------------|
| `403` | Missing, invalid, or expired preview token (and no session). |
| `404` | Document not found. |

---

## Review

The human-review queue. A pipeline routes a document here when a field's confidence falls below the pipeline's review threshold, a validation rule fails, or values conflict. Resolving an item (accept/override/reject) merges the corrected values back into the document. Promotion turns a reviewed document into corpus ground truth, closing the **review → corpus → schema** loop.

### `GET /api/review`

List review-queue items, joined with their document/pipeline/schema context.

**Auth:** Bearer token. Requires `review:read` permission.

**Query parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `status` | string | `pending` | `pending` or `completed`. Pending items are ordered by confidence ascending (worst first); completed by resolution time descending. |
| `reason` | string | — | Filter by routing reason (e.g. `low_confidence`, `validation_failed`, `conflicting_values`). |
| `limit` | number | `100` | Max items returned. |

**Response** `200 OK` — `{ "data": [ … ] }`, each item carrying `id`, `fieldName`, `reason`, `proposedValue`, `confidence`, `status`, `resolution`, `documentId`, `documentFilename`, `schemaSlug`, `pipelineSlug`.

### `GET /api/review/__queue/stats`

Queue-level counts, computed server-side with `count(*)` so they stay accurate regardless of any list fetch limit. Use this for queue-size displays — deriving counts from a limited `GET /api/review` page caps every number at the page size.

**Auth:** Bearer token. Requires `review:read` permission.

**Query parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `urgent_below` | number | `0.7` | Confidence threshold for the `urgent` count. Clamped to `[0, 1]`; malformed values fall back to the default. |

**Response** `200 OK`

```json
{ "pending": 3351, "urgent": 214, "completed": 633, "reviewedToday": 41 }
```

`pending`/`completed` are status counts, `urgent` counts pending items with `confidence < urgent_below`, and `reviewedToday` counts items resolved in the last 24 hours.

### `GET /api/review/{id}`

A single review item with full document context — the flagged field, the document's complete `documentExtractionJson`, the schema/pipeline it ran under, and an inline `documentPreviewUrl` + `documentToken` for the shared viewer.

**Auth:** Bearer token. Requires `review:read` permission.

### `POST /api/review/{id}/promote`

Promote a reviewed document into the schema's corpus as ground truth.

**Auth:** Bearer token. Requires `corpus:promote` permission (held by the `reviewer` role and above).

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provisional` | boolean | no | When `false` (default), the item **must** be resolved with resolution `approved`; the document's corrected record becomes **approved** ground truth that `validate` scores immediately. When `true`, writes a **draft**, agent-authored label that is excluded from `validate` until a human approves it. |
| `to` | string | no | Tag applied to the new corpus entry. |
| `groundTruth` | object | no | `{ field: value }` label to use (provisional only). Defaults to the document's current extraction. |

The source file is copied into a corpus-scoped storage key. Dedup is by `(schemaId, contentHash)`: re-promoting a document appends a new ground-truth version to the existing entry instead of duplicating it.

**Response** `201 Created` — `{ corpusEntryId, groundTruthId, reviewStatus, provisional, deduped, filename, fieldCount }`.

**Errors**

| Status | Meaning |
|--------|---------|
| `409` | Item is not resolved+approved and `provisional` was not set. |
| `400` | Item has no associated document or no extracted values to promote. |
| `404` | Review item or source file not found. |

### `POST /api/schemas/{slug}/corpus/{entryId}/ground-truth/{gtId}/approve`

Approve a draft ground-truth version — the human exit ramp for provisional labels. Marks the version `approved` and writes the denormalized `groundTruthJson` so `validate` begins scoring against it.

**Auth:** Bearer token. Requires `corpus:write` permission.

**Response** `200 OK` — the updated ground-truth row.

---

## Schemas

CRUD endpoints for managing extraction schemas. Schemas are stored as YAML files in the `KOJI_SCHEMAS_DIR` directory (default `./schemas/`).

### `GET /api/schemas`

List all schemas with summary info.

**Response** `200 OK`

```json
[
  {
    "name": "invoice",
    "description": "Invoice data extraction",
    "field_count": 6
  },
  {
    "name": "receipt",
    "description": null,
    "field_count": 4
  }
]
```

### `GET /api/schemas/{name}`

Get the full definition of a schema.

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Schema name (alphanumeric, hyphens, underscores). |

**Response** `200 OK`

```json
{
  "name": "invoice",
  "description": "Invoice data extraction",
  "categories": null,
  "fields": {
    "invoice_number": {
      "type": "string",
      "required": true,
      "description": "The invoice number"
    },
    "date": {
      "type": "date",
      "description": "Invoice date"
    },
    "total_amount": {
      "type": "number",
      "description": "Total amount due"
    }
  }
}
```

**Errors**

| Status | Description |
|--------|-------------|
| `404` | Schema not found. |

### `GET /api/schemas/{name}/fields`

Structured field metadata for a schema. The server parses the schema YAML once and returns a stable JSON shape — clients (notably the review UI's override dropdown) consume this instead of parsing YAML in the browser. Unknown YAML keys are silently dropped server-side, so adding new schema features doesn't break clients.

Reads from the latest committed version's YAML. Falls back to the in-progress draft when no version has been committed yet; if neither exists, returns `{ "fields": [] }`.

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Schema slug. |

**Response** `200 OK`

```json
{
  "fields": [
    {
      "name": "governance",
      "type": "string",
      "description": "Community governance model",
      "required": true,
      "enum": ["hoa", "condo", "coop"]
    },
    {
      "name": "state",
      "type": "string",
      "mappings": {
        "CA": ["California", "Calif"],
        "NY": ["New York", "NYS"]
      }
    },
    {
      "name": "zip",
      "type": "string",
      "pattern": "^[0-9]{5}$"
    }
  ]
}
```

**Field shape**

| Property | Type | Description |
|----------|------|-------------|
| `name` | string | Field name as declared in the schema. |
| `type` | string | `string`, `number`, `integer`, `boolean`, `date`, `object`, `array`, `enum`, `mapping`, or any future type. Consume permissively. |
| `description` | string? | Schema-author description. |
| `required` | boolean? | Whether the field is required. |
| `enum` | string[]? | Enum values, coerced to strings + deduped. Omitted when empty/absent. |
| `options` | string[]? | Legacy `options` alias. Surfaced only when present and not equivalent to `enum`. Treat the same as `enum`. |
| `mappings` | object? | Bucket key → aliases. Bucket keys are the canonical/normalized values (use as dropdown options); aliases are surface forms the extractor folds in. |
| `pattern` | string? | Regex pattern (from `validate.regex` or top-level `pattern`). |

**Errors**

| Status | Description |
|--------|-------------|
| `404` | Schema not found. |

### `POST /api/schemas`

Create a new schema.

**Request** `application/json`

```json
{
  "name": "purchase_order",
  "description": "Purchase order extraction",
  "fields": {
    "po_number": {
      "type": "string",
      "required": true,
      "description": "Purchase order number"
    },
    "vendor": {
      "type": "string",
      "description": "Vendor name"
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Schema name. Alphanumeric, hyphens, underscores only. Auto-lowercased. |
| `description` | string | No | Human-readable description. |
| `categories` | object | No | Document category definitions. |
| `fields` | object | Yes | Field definitions. Must contain at least one field. |

**Response** `201 Created`

Returns the created schema in the same format as `GET /api/schemas/{name}`.

**Errors**

| Status | Description |
|--------|-------------|
| `409` | Schema with that name already exists. |
| `422` | Validation error (empty name, empty fields, invalid characters). |

### `PUT /api/schemas/{name}`

Update an existing schema. Only provided fields are updated; omitted fields are left unchanged.

**Request** `application/json`

```json
{
  "description": "Updated description",
  "fields": {
    "po_number": {
      "type": "string",
      "required": true
    },
    "vendor": {
      "type": "string"
    },
    "ship_date": {
      "type": "date"
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | string | No | Updated description. |
| `categories` | object | No | Updated categories. |
| `fields` | object | No | Updated field definitions. Must not be empty if provided. |

**Response** `200 OK`

Returns the updated schema.

**Errors**

| Status | Description |
|--------|-------------|
| `404` | Schema not found. |
| `422` | Validation error (empty fields object). |

### `DELETE /api/schemas/{name}`

Delete a schema.

**Response** `204 No Content`

**Errors**

| Status | Description |
|--------|-------------|
| `404` | Schema not found. |

---

## Schema versions

Versions use semver. **Candidates** carry a prerelease tag (`v0.0.4-rc.7`) and are never live; **releases** (`v0.0.4`) are activatable. `schemas.currentVersionId` points at the live release. The major/minor/patch bump is auto-derived by diffing the candidate's output shape against the active release (`required→optional` / removed / retyped fields = major; additive/stricter = minor; tuning only = patch).

### `POST /api/schemas/{slug}/validate`

Backtest against corpus ground truth. With `yaml` in the body, snapshots it as a **candidate** (dedup by content hash) **without activating it**, ties the run to that candidate, and scores it. Without `yaml`, scores the latest stored version (back-compat). Auth: `job:run`.

**Request body**

| Field | Type | Description |
|-------|------|-------------|
| `yaml` | string? | Candidate YAML to snapshot + backtest. Omit to validate the live version. |
| `bump` | `"major"\|"minor"\|"patch"`? | Override the auto-derived bump. |
| `model` | string? | Override the extraction model. |
| `commitMessage` | string? | Message for the candidate snapshot. |
| `async` | boolean? | When `true`, run in the background: each corpus doc executes as its own queued job and the response is an immediate `202` with `{ runId, status, docsTotal, version, bump, deduped }`. Poll the run endpoint below for progress and the final result. Recommended for any real corpus — the synchronous mode holds one HTTP request for the whole run and is subject to request timeouts. |

**Response** `200 OK` (sync) — the validate result plus `version` (semver label), `bump`, and `deduped` — or `202 Accepted` (async) with the run handle. Requires corpus ground truth (`400` otherwise). The candidate is **not** activated.

Documents are parsed with the tenant's configured parse provider (the same one the live extraction path uses), falling back to the system default when none is configured, and reuse the shared parse cache. Any corpus entry that fails to parse or extract is reported in a `parseFailures` array (`[{ entryId, filename, error }]`) rather than being silently dropped, and `docsTotal` counts every attempted document (scored + failed) so accuracy is not inflated by dropped docs.

Per-document failures are also **persisted** (not just returned in the response): each doc's outcome lands in a `schema_run_docs` row (`status`, `error_message`), and a run where every document fails is marked `failed` with an `errorMessage`. `GET /api/schemas/{slug}/performance` returns `status`, `errorMessage`, and a `failures` array (`[{ entryId, filename, error }]`) for each run, so failed runs stay diagnosable after the fact — the dashboard Performance page renders them as failed with the per-document errors instead of a bare `0/N`.

### `GET /api/schemas/{slug}/validate/runs/{runId}`

Poll an async validate run. Auth: `job:run`. Returns:

| Field | Type | Description |
|-------|------|-------------|
| `runId` | string | The schema run id from the `202`. |
| `status` | string | `queued` → `running` → `finalizing` → `completed` (or `failed`). |
| `docsTotal` | number | Corpus docs in the run. |
| `docsProcessed` | number | Docs finished so far (ok or failed). |
| `result` | object? | The full validate result (same shape as the sync `200` body) once `status` is `completed`; `null` before that. |
| `error` | string? | Failure reason when `status` is `failed` (with `parseFailures` alongside). |

Each entry in `fields[]` carries `name`, `accuracy` (%), `prevAccuracy`, `status`, and `failingDocs`. **Array fields** are scored by F1 and additionally carry `precision` and `recall` (percentages), so a low score can be read as missed elements (low recall) vs spurious/wrong elements (low precision). Element matching uses the array's `element_key` hint when declared, and sub-fields marked `informational` are excluded from scoring (see the schema guide).

Each successfully extracted document is persisted as an extraction run linked to the validate run. These per-document records power the per-field accuracy heatmap on the Performance page (`GET /api/schemas/{slug}/performance`) and serve as the regression baseline for the next validate.

### `GET /api/schemas/{slug}/versions`

The released lineage + candidates, each with `version` (semver label), `released`, `active` (is the live release), latest `accuracy` and `regressions`, plus `versionNumber`, `commitMessage`, `committedByName`, `createdAt`. Auth: `schema:read`.

### `POST /api/schemas/{slug}/versions`

Create a version. `candidate: true` snapshots a non-active candidate; otherwise releases directly and activates. Auth: `schema:write`. Returns `{ id, version, released, ... }`.

### `POST /api/schemas/{slug}/promote`

Graduate a candidate to a release and make it live — **manual, gated by `schema:deploy`**.

**Request body**

| Field | Type | Description |
|-------|------|-------------|
| `versionId` | string? | Candidate to promote. Default: the latest candidate. |
| `requireNoRegressions` | boolean? | Refuse (`409`) if the candidate's latest run regressed. |

**Response** `200 OK` — `{ released: "v0.0.4" }`. `409` if a release already occupies that `x.y.z`.

### `POST /api/schemas/{slug}/release`

Release YAML directly (skip the rc loop) and make it live — the early-stage / empty-corpus path. Defaults to the schema's draft. Auth: `schema:deploy`. Body: `{ yaml? }`. Returns `{ released, versionId }`.

### Per-pipeline version mode

Promoting a schema changes its live release; each pipeline chooses how to react via `pipelines.versionMode`: **`auto`** (default) always runs the schema's live release, **`pinned`** holds a specific version until bumped (staged rollout). Set it with `POST /api/pipelines/{idOrSlug}/deploy` (auth `schema:deploy`): body `{ schema_version_id }` pins that version (sets `versionMode: "pinned"`); body `{ mode: "auto" }` unpins. The runner honors a pin only for the schema the pinned version belongs to; other schemas in a DAG fall back to live.

---

## Classifiers

A **classifier** is a config artifact — the schema-sibling of an extraction schema. Where a schema stores YAML defining `fields` to extract, a classifier stores YAML defining `classes` a document can be assigned to, plus the cost controls the [`POST /api/classify`](#post-apiclassify) cascade obeys. Classifiers use the same CRUD shape, the same semver versioning (released + `rc.N` candidates), and the same permissions as schemas: read is `schema:read`, create/update is `schema:write`, promote/release is `schema:deploy`. The engine ships no built-in classes — every class is user config.

Committing or creating a classifier validates the YAML with the classifier engine and stores the normalized config as the version's `parsedJson`. Invalid YAML (or a config that isn't a valid classifier — e.g. no `classes`) returns `400` with the validation message in `error`/`details`.

### `GET /api/classifiers`

List the tenant's classifiers. Each row carries `id`, `slug`, `displayName`, `description`, `currentVersionId`, `createdAt`, `latestVersion` (the highest committed version number, or `null`), and `latestVersionLabel` (its semver label, e.g. `"v1.2.0"` or `"v1.2.0-rc.3"`, or `null`). Auth: `schema:read`.

### `GET /api/classifiers/{slug}`

The classifier plus its `latestVersion` (`{ versionNumber, version, yamlSource, commitMessage, createdAt }` or `null`; `version` is the semver label). `404` for an unknown slug. Auth: `schema:read`.

### `POST /api/classifiers`

Create a classifier. Auth: `schema:write`.

**Request body**

| Field | Type | Description |
|-------|------|-------------|
| `slug` | string | Required. Unique per tenant. |
| `display_name` | string | Required. |
| `description` | string? | Optional. |
| `initial_yaml` | string? | Classifier YAML for v1. Defaults to a minimal one-class template. |

Creates the classifier and commits **v1** (released, semver `v0.0.1`), then returns the classifier with `latestVersion: 1` and `latestVersionLabel: "v0.0.1"`. `400` when `slug`/`display_name` are missing or the YAML is not a valid classifier config.

### `PATCH /api/classifiers/{slug}`

Update metadata or the working draft. Body: `{ display_name?, description?, draft_yaml? }`. Setting `draft_yaml` also stamps `draftUpdatedAt`. `404` for an unknown slug. Auth: `schema:write`.

### `DELETE /api/classifiers/{slug}`

Soft-delete (sets `deletedAt`; the row is filtered from every read path). Returns `204`. Auth: `schema:write`.

## Classifier versions

Versions use semver, identical to schema versions. **Candidates** carry a prerelease tag (`v0.0.4-rc.7`) and are never live; **releases** (`v0.0.4`) are activatable, and `classifiers.currentVersionId` points at the live release. The bump is auto-derived by diffing the candidate's **label set** against the active release: a removed class = **major**, an added class = **minor**, tuning only (descriptions, keywords, patterns, windows, cost controls) = **patch**. Override with `bump` in the request.

### `GET /api/classifiers/{slug}/versions`

The released lineage + candidates, each with `version` (semver label), `released`, `active` (is the live release), plus `versionNumber`, `major`/`minor`/`patch`/`prerelease`, `commitMessage`, `committedByName`, `createdAt`. Auth: `schema:read`.

### `GET /api/classifiers/{slug}/versions/{v}`

A single version by its `versionNumber`, including `yamlSource` and the normalized `parsedJson`. `404` if the version doesn't exist. Auth: `schema:read`.

### `POST /api/classifiers/{slug}/versions`

Commit a version. Auth: `schema:write`.

**Request body**

| Field | Type | Description |
|-------|------|-------------|
| `yaml_source` | string | Required. Classifier YAML (`yaml` is accepted as an alias). |
| `commit_message` | string? | Message for the version. |
| `candidate` | boolean? | `true` snapshots a non-active candidate (dedup by content hash); otherwise releases directly and activates. |
| `bump` | `"major"\|"minor"\|"patch"`? | Override the auto-derived bump. |

Returns `{ id, version, released, ... }` (`201`). `400` on invalid YAML; `409` if a release already occupies that `x.y.z`.

### `POST /api/classifiers/{slug}/promote`

Graduate a candidate to a release and make it live — **manual, gated by `schema:deploy`**. Body: `{ versionId? }` (defaults to the latest candidate). Returns `{ released: "v0.0.4" }`. `400` if there's no candidate; `409` if a release already occupies that `x.y.z`.

### `POST /api/classifiers/{slug}/release`

Release YAML directly (skip the rc loop) and make it live — the early-stage path. Defaults to the classifier's draft. Auth: `schema:deploy`. Body: `{ yaml_source? }` (`yaml` accepted as an alias). Returns `{ released, versionId }`.

---

## Provenance

When extraction runs with a `text_map` (returned by the parse service), Koji resolves **provenance** for each extracted field — the exact location in the source document where the value was found. Provenance is returned in the `provenance` field of extraction responses and used by the [embeddable PDF viewer](integration.md#embedding-the-pdf-viewer) to render highlights.

When the parse provider instead emits structured/positional **chunks** carrying geometry (the positional and JSON-native parse paths), Koji uses each chunk's bounding box directly as authoritative geometry rather than re-deriving coordinates from the flattened markdown. Markdown-native parses (no chunk geometry) are unaffected and continue to resolve highlights via the `text_map`.

When the `text_map` carries **offset annotations** (`md_offset`/`md_length` — see [`text_map` format](#text_map-format)), Koji resolves a field's bounding box deterministically: it maps the value to its character range in the markdown, then looks up the covering word boxes by offset overlap instead of fuzzily re-scanning the `text_map` text. This is more precise for repeated values (the same date on two pages resolves to the correct occurrence). Parses without offset annotations fall back to fuzzy text matching, unchanged. The digital-PDF (pdfjs) parser emits these offsets today; OCR/markdown-native parses do not.

When a value string appears in **more than one table cell** (e.g. the same dollar amount under two different columns of a declarations grid) and the chunks carry table coordinates (`tableId`/`row`/`col`, emitted by structured providers like Google Document AI and Textract), Koji disambiguates deterministically: it matches the field's identity (its key plus any schema `label`/`title`/`description`/`aliases`) against each candidate cell's column header and row label, and highlights the best-matching occurrence rather than the first textual match. This is a pure geometry-selection step — no extra model call — and it is strictly additive: it only changes the highlight when there are at least two candidate occurrences, the candidates carry table coordinates, and one occurrence clearly out-scores the rest. Otherwise (single occurrence, no table coordinates, or an ambiguous tie) resolution falls back to the previous behavior unchanged.

### Provenance span

Each field maps to a provenance span (or `null` if the value couldn't be located in the source):

```json
{
  "vendor_name": {
    "offset": 245,
    "length": 10,
    "chunk": "Acme Corp.",
    "page": 1,
    "bbox": { "x": 150, "y": 200, "w": 120, "h": 16 },
    "words": [
      { "text": "Acme", "page": 1, "x": 150, "y": 200, "w": 55, "h": 16 },
      { "text": "Corp.", "page": 1, "x": 210, "y": 200, "w": 60, "h": 16 }
    ]
  },
  "date": null
}
```

| Field | Type | Description |
|-------|------|-------------|
| `offset` | integer | Character offset in the parsed markdown where the value was found. |
| `length` | integer | Length of the matched text in the markdown. |
| `chunk` | string | The matched text snippet. |
| `page` | integer | Page number in the source document (1-indexed). Present when `text_map` was available. |
| `bbox` | object | Bounding box (`x`, `y`, `w`, `h`) in PDF points. Present when `text_map` was available. |
| `words` | array | Per-word bounding boxes for precise multi-word highlighting. |
| `reasoning` | string | LLM-provided reasoning for why this value was selected (when available). |
| `column_mismatch` | boolean | Set only when chunk geometry is available and a column header for the field is found. `true` flags a likely wrong-column association — the value's bounding box does not sit horizontally under its column header's bounding box (a common failure mode when a table is flattened with garbled reading order). `false` means the value sits under its header; omitted when not checked. |
| `resolution` | string | How the span's **geometry** (`bbox`) was resolved — the durable provenance rung: `"offset"` (exact `md_offset` overlap lookup), `"chunk"` (authoritative structured/positional chunk bbox), `"fuzzy"` (best-effort text/value matching), or `"none"` (value located but no geometry — nothing to highlight). Lets a viewer distinguish an exact locate from a best guess. |
| `items` | array | Per-item provenance for array fields. See below. |

### Array field provenance

When a schema field has type `array`, provenance resolves each item independently. The top-level span points to the first item's location, and the `items` array contains a span per element:

```json
{
  "line_items": {
    "offset": 500,
    "length": 12,
    "chunk": "Widget A",
    "page": 1,
    "bbox": { "x": 72, "y": 300, "w": 100, "h": 14 },
    "items": [
      {
        "offset": 500,
        "length": 12,
        "chunk": "Widget A",
        "page": 1,
        "bbox": { "x": 72, "y": 300, "w": 100, "h": 14 },
        "words": [{ "text": "Widget", "page": 1, "x": 72, "y": 300, "w": 60, "h": 14 }]
      },
      {
        "offset": 580,
        "length": 12,
        "chunk": "Widget B",
        "page": 1,
        "bbox": { "x": 72, "y": 320, "w": 100, "h": 14 },
        "words": [{ "text": "Widget", "page": 1, "x": 72, "y": 320, "w": 60, "h": 14 }]
      }
    ]
  }
}
```

For array items that are objects (e.g. `{ "description": "Widget A", "amount": 100 }`), provenance resolves each scalar property within the object and picks the best match — preferring spans with word-level bounding boxes.

### `text_map` format

The `text_map` array returned by `POST /api/parse` contains word-level position data from the source document. Each entry maps a word to its page and bounding box:

```json
{
  "text": "Invoice",
  "page": 1,
  "bbox": { "x": 0.12, "y": 0.06, "w": 0.2, "h": 0.02 },
  "level": "word",
  "md_offset": 0,
  "md_length": 7
}
```

| Field | Type | Description |
|-------|------|-------------|
| `text` | string | The word or text segment. |
| `page` | integer | Page number (1-indexed). |
| `bbox` | object | Bounding box in **normalized page fractions** — `x`/`w` as a fraction of page width, `y`/`h` as a fraction of page height, each in `[0, 1]`. Origin is the **top-left** of the page (y increases downward). This is the one canonical coordinate convention every parse provider emits. |
| `level` | string | Always `"word"` for word-level segments. |
| `md_offset` | integer | Optional. Character offset of this segment's text in the parse `markdown`. Present for parsers that stamp offsets (digital-PDF / pdfjs); enables deterministic (offset-based) provenance resolution. |
| `md_length` | integer | Optional. Character length of the segment's text as it appears in the `markdown`. Paired with `md_offset`. |

The `text_map` is threaded automatically from parse → extract when using `POST /api/process`. When using `POST /api/extract` with pre-parsed content, pass the `text_map` from the parse response to enable provenance resolution.
