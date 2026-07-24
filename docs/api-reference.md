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
jobs, sources, classifiers, review items, model/parse endpoints, and webhooks
each belong to exactly one project, and requests only see the resources of the
project they resolve to. Resolution order:

1. `x-koji-project: <project-slug>` header, when present (`404` if the slug
   doesn't exist in the tenant; `403` if it exists but is outside the caller's
   scope — see below).
2. The API key's default project (the project it was created in, for a
   single-project key).
3. The tenant's default project (the one whose slug matches the tenant slug,
   falling back to the oldest project).

```
Authorization: Bearer koji_yourkey
x-koji-tenant: your-tenant-slug
x-koji-project: your-project-slug   # optional with session auth
```

**An API key's project scope.** A key is scoped to one of:

- **single project** (the default; every legacy key) — the project it was
  created in. An `x-koji-project` header naming another project in the same
  tenant answers `403` ("not scoped to that project"), and a key whose only
  project is deleted stops working (`403`).
- **specific projects** — a chosen set. The `x-koji-project` header may name any
  project in the set; anything else answers `403`. With no header the key
  defaults to its bound project (or the first in the set). **This set is a
  fixed list: a project created after the key is _not_ in it.** Only *all
  projects* keeps up with new projects automatically.
- **all projects** (tenant-wide) — the header may name any live project in the
  tenant, including projects created after the key; with no header it resolves
  the tenant default.

A key's scope is **not fixed at creation** — `PATCH /api/api-keys/{id}` takes
the same `project_scope` block as create and moves an existing key between
these modes without changing the secret, so widening a key never means
reissuing it to every consumer. Granting *all projects* requires a caller who
can themselves reach every project.

A key still cannot cross tenants — it is rejected (`403`) for any tenant other
than its own. A key acts with its creator's role permissions; its project scope
limits **which** projects it can reach, not its capability within them.
Multi-project and all-access keys are an organization/enterprise feature.
Session-authenticated requests (the dashboard) may name any live project the
member can access.

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
returns the current setting + roles. API keys are scoped independently (see
"An API key's project scope" above). Existing members are grandfathered (keep
current access).

**Managing a project's roster.** The endpoints above are member-centric (one
member across projects). To manage a single project's roster instead:
`GET /api/projects/{slug}/members` returns everyone with access —
`access:"granted"` members (with their project `roles`) and `access:"all"`
members (unrestricted; `workspaceAdmin` marks owners/tenant-admins, and
`defaultRole` is the project role their workspace role maps to) — plus
`candidates` (restricted members not yet on the project).
`PUT /api/projects/{slug}/members/{membershipId}` with `{ roles: [...] }`
grants or updates a member's role in that project.
`DELETE /api/projects/{slug}/members/{membershipId}` revokes access. When
either targets an unrestricted non-admin member, their implicit all-projects
access is first **materialized**: they become project-restricted with an
explicit grant in every other live project at their `defaultRole`, and the
requested change applies to this one (the response carries
`materialized: true`). Owners and tenant-admins are all-access by design —
`400`; change their workspace role instead. All require `member:invite` and
enforce the same role ceiling.

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
| `file` | file | Yes | The document to parse (PDF, DOCX, image, plain text, markdown, etc.) |

Plain-text and markdown files (`.txt`, `.md`, `.markdown`) are returned verbatim as markdown — they need no OCR or layout parsing, so `text_map` is empty and `pages` is `1`.

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
as the test surface. Classes, keywords, and windows are all yours (the engine
ships no built-in classes).

Supply the config **either** inline (`config`) **or** by referencing a
registered classifier (`classifier`). Supplying both is a `400` — they could
resolve to different configs, so the request is ambiguous rather than ranked.

**Request** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | Yes | The document to classify. |
| `config` | string | * | Classifier config as YAML or JSON (see below). |
| `classifier` | string | * | Slug of a registered classifier. Uses its **released** version. |
| `classifier_version` | string | No | Pin a version (`v0.0.3`, `0.0.3`, or a version-id prefix). `version` is accepted as an alias. |

Or `application/json` with a stored document:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `storage_key` | string | Yes | Key of a previously uploaded document. |
| `config` | object \| string | * | Classifier config — an object, **or a YAML string**. |
| `classifier` | string | * | Slug of a registered classifier. |
| `classifier_version` | string | No | Pin a version; `version` is an alias. |
| `filename` | string | No | Overrides the name inferred from `storage_key`. |
| `mime_type` | string | No | Overrides the inferred content type. |

\* Exactly one of `config` or `classifier` is required.

**Large documents (over the 4.5 MB request-body cap)**

Do not skip them, and do not slice them client-side — neither is necessary:

1. **Send the config as a YAML string in the JSON form.** The `config` field accepts *either* a config object *or* a YAML string, on **both** the multipart and the JSON form. So a document already in Koji storage needs no multipart upload at all.
2. **Reference the bytes with `storage_key` instead of uploading them.** Get one with the [presigned upload flow](#post-apiuploadpresign) — `presign` → `PUT` → `complete` — which is the same path extraction uses and is not subject to the request-body cap.

```json
{ "storage_key": "docs/abc123", "classifier": "document_type" }
```

**You do not need a PDF library to classify a masthead.** The cascade only ever reads the pages the config's `window` (and `scan`) select — `window: 1` reads one page regardless of how long the document is. Client-side page slicing buys nothing: the cost ceiling is already config, not payload size.

**Running a registered classifier by slug**

```json
{ "storage_key": "docs/abc123", "classifier": "document_type" }
```

This resolves the classifier's released version through the same path the
ingestion DAG's `classifier:` step uses, so a standalone classify and a pipeline
route agree on the config *and* the version. The response echoes `classifier`
and `classifier_version`, so a consumer can see what ran.

Prefer it over fetching `yamlSource` and posting it back: it is one round trip
instead of two, and re-tuning becomes a `koji classify release` with **no
consumer redeploy**. An unknown slug, or a pin that matches no version, is a
`404` — a bad pin never silently falls back to the live release.

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
| `503` | The config admits the LLM/vision tier but no model provider could be resolved, and the cheaper tiers did not decide. |

A `503` is distinct from an `unknown` label: `unknown` means the classifier ran
and could not tell, while `503` means it never got to look. Only the former
routes a pipeline down its `default` edge. If a keyword match decides the label
first, no model provider is needed and the request succeeds normally.

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

### `GET /api/documents`

The tenant/project-wide document list — find a document without knowing which
job ingested it. Powers the dashboard's Documents page.

**Auth:** Bearer token. Requires `job:read` permission. Project-scoped: with an
`x-koji-project` header (or a project-bound API key) only that project's
documents are returned.

**Query parameters** (all optional)

| Param | Description |
|-------|-------------|
| `search` | Filename match, case-insensitive. Multi-word queries are split on whitespace and every word must match (AND), so `park walk` matches `walk-in-the-park.pdf` even though the words aren't adjacent. |
| `status` | Exact document status (`delivered`, `review`, `failed`, …). |
| `pipeline` | Pipeline slug. |
| `since` | Shorthand (`today` \| `7d` \| `30d` \| `all`) or ISO timestamp. |
| `cursor` | `nextCursor` from the previous page (keyset pagination). |
| `limit` | Page size — default 50, max 200. |

**Response** `200 OK`

```json
{
  "data": [
    {
      "id": "…", "filename": "invoice-0042.pdf", "status": "delivered",
      "mimeType": "application/pdf", "pageCount": 2, "confidence": "0.9600",
      "createdAt": "…", "completedAt": "…",
      "jobSlug": "acme-invoices-20260706",
      "pipelineSlug": "invoices", "pipelineName": "Invoices",
      "schemaName": "Invoice", "hasPendingReview": false
    }
  ],
  "nextCursor": null,
  "counts": { "total": 86, "byStatus": { "delivered": 72, "review": 4, "failed": 7, "extracting": 3 } }
}
```

`hasPendingReview` marks documents with open review items. `counts` reflects
the full filtered set (not just the page), for facet bars. Document detail,
preview, corrections, etc. remain addressed via
`/api/jobs/{jobSlug}/documents/{docId}` — use the row's `jobSlug` to build
those paths.

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

### `POST /api/jobs/{slug}/documents/{docId}/resolve-region`

Resolve a region of a page to the text underneath it. Point at where a value
lives on the document — a rectangle in the same normalized coordinate space
the highlights use — and get back the words in that region, snapped to their
exact boxes. This is the primitive behind highlight-to-correct: derive a
corrected value from a selection instead of retyping it. Same token auth as
`/preview`; stateless (nothing is written, no model is called).

**Request**

```json
{ "page": 1, "bbox": { "x": 0.60, "y": 0.80, "w": 0.22, "h": 0.05 } }
```

`page` is 1-indexed. `bbox` is normalized to the page (0–1, origin top-left):
divide a pixel-space selection by the rendered page's width/height. A word
counts as selected when at least half of it lies inside the rectangle, so a
sloppy drag snaps to clean word boundaries.

**Response** `200 OK`

```json
{
  "text": "$6,000.00",
  "words": [ { "text": "$6,000.00", "page": 1, "x": 0.62, "y": 0.81, "w": 0.18, "h": 0.03 } ],
  "bbox": { "x": 0.62, "y": 0.81, "w": 0.18, "h": 0.03 }
}
```

`words` are in reading order (top→bottom, left→right); multi-line selections
join lines with `\n` in `text`. `bbox` is the union of the matched words — the
"snapped" selection, ready to echo back as a highlight.

When the region resolves to nothing — no words there, or the document has no
positional text data (e.g. it was never parsed with a geometry-capable
provider) — the response is `200` with:

```json
{ "text": null, "words": [], "bbox": null }
```

Treat `text: null` as "fall back to manual input"; it is not an error.

**Errors**

| Status | Description |
|--------|-------------|
| `400` | Malformed body — `page` must be an integer ≥ 1, `bbox` must have finite `x`/`y`/`w`/`h` with positive extents intersecting the page. |
| `403` | Missing, invalid, or expired preview token (and no session). |
| `404` | Document not found. |

### `POST /api/jobs/{slug}/documents/{docId}/corrections`

Manually correct extracted values on a document — the fix path for errors the
review queue never flagged. Each correction is recorded as an already-resolved
review item (`reason: "manual"`), so corrections carry a full audit trail
(who/when/what replaced what), count in review analytics, and can be promoted
to corpus ground truth like any reviewed record.

**Auth:** Bearer token (session or API key). Requires `review:act` permission.
The HMAC preview token is **not** accepted — it stays read-only. External
integrations should call this from their backend with an API key (e.g. after
receiving `koji:regionSelected` from the embedded viewer).

**Request body**

```json
{
  "corrections": [
    { "field": "total_amount", "value": 6000,
      "provenance": { "page": 1, "bbox": { "x": 0.62, "y": 0.81, "w": 0.18, "h": 0.03 },
                      "words": [ { "text": "$6,000.00", "page": 1, "x": 0.62, "y": 0.81, "w": 0.18, "h": 0.03 } ],
                      "chunk": "$6,000.00" } },
    { "field": "vendor", "value": "Northwind Traders Inc" }
  ],
  "note": "fixed after customer call"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `corrections` | array | yes | 1–50 entries, unique `field` names. `value` must be present on each (send `null` to clear a field). |
| `corrections[].provenance` | object | no | Anchored provenance — same shape as the [review override](#post-apireviewidoverride)'s, typically from [`resolve-region`](#post-apijobsslugdocumentsdociresolve-region). Written to the document's provenance as a `resolution: "anchored"` span. |
| `note` | string | no | Stored on each created review item. |

**Effects:** one `reason: "manual"` review item per field (created resolved:
`proposedValue` = the replaced value, `finalValue` = the correction,
`resolvedBy` = the caller); one merge into the document's `extractionJson`;
anchored provenance spans for entries that carry geometry; and one
**`document.corrected`** webhook event (below).

**Response** `201 Created` — `{ ok, reviewItemIds, extraction }` (the full
corrected extraction).

**Errors**

| Status | Description |
|--------|-------------|
| `400` | Malformed body (empty array, duplicate fields, missing `value`, bad provenance). |
| `404` | Document not found (or not visible to the caller). |
| `422` | Document has no extraction to correct (no schema, or extraction not produced yet). |

#### Webhook event: `document.corrected`

Subscribable per webhook target (Settings → Webhooks → "Document corrected";
on by default for new targets). Fired once per corrections call. **Consume it
if you consume `document.delivered`** — otherwise corrections made after
delivery silently diverge from the copy in your system.

```json
{
  "document_id": "…",
  "job_id": "…",
  "job_slug": "acme-invoices-20260706",
  "fields": {
    "total_amount": { "previous": 600, "value": 6000 },
    "vendor": { "previous": "Northwind", "value": "Northwind Traders Inc" }
  },
  "extraction": { "…": "the full corrected record" },
  "corrected_by": "<user id>",
  "corrected_at": "2026-07-06T13:00:00.000Z"
}
```

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

### `POST /api/review/{id}/override`

Approve the item with a corrected value. The correction is merged into the
document's `extractionJson` so downstream consumers see the corrected record.

**Auth:** Bearer token. Requires `review:act` permission.

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `value` | any | yes | The corrected value for the flagged field. |
| `note` | string | no | Reviewer note stored on the item. |
| `fieldOverrides` | object | no | `{ field: value }` corrections for *other* fields edited in the same pass. |
| `provenance` | object | no | **Anchored provenance** (highlight-to-correct): where on the document the corrected value lives — `{ page, bbox: {x,y,w,h}, words?, chunk? }`, normalized page coordinates. Typically the output of [`resolve-region`](#post-apijobsslugdocumentsdocidresolve-region) (`chunk` = its `text`). Written to the document's provenance as a `resolution: "anchored"` span, so the corrected field keeps a source highlight everywhere provenance renders (trace page, embed viewer). Malformed shapes are rejected with `400`. |

A correction with `provenance` is strictly richer than a typed one: the value
carries geometry, which flows into the corpus on
[`promote`](#post-apireviewidpromote) and renders as an exact highlight.

**Response** `200 OK` — the resolved review item row.

### `POST /api/review/{id}/promote`

Promote a reviewed document into the schema's corpus as ground truth.

**Auth:** Bearer token. Requires `corpus:promote` permission (held by the `reviewer` role and above).

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provisional` | boolean | no | When `false` (default), the item **must** be resolved with resolution `approved`; the document's corrected record becomes **approved** ground truth that `validate` scores immediately. When `true`, writes a **draft**, agent-authored label that is excluded from `validate` until a human approves it. |
| `to` | string | no | Tag applied to the new corpus entry. |
| `groundTruth` | object | no | `{ field: value }` label to use (provisional only). Defaults to the document's current extraction. |

The source file is copied into a corpus-scoped storage key. Dedup is by `(schemaId, contentHash)`: re-promoting a document appends a new ground-truth version to the existing entry instead of duplicating it. Any anchored provenance the document carries (from [`resolve-region`](#post-apijobsslugdocumentsdociresolve-region) corrections) travels with the label into the corpus, gated identically to the values — geometry only reaches the scored (denormalized) ground truth for **approved** labels, never for provisional drafts.

**Response** `201 Created` — `{ corpusEntryId, groundTruthId, reviewStatus, provisional, deduped, filename, fieldCount }`.

**Errors**

| Status | Meaning |
|--------|---------|
| `409` | Item is not resolved+approved and `provisional` was not set. |
| `400` | Item has no associated document or no extracted values to promote. |
| `404` | Review item or source file not found. |

### `POST /api/schemas/{slug}/corpus/{entryId}/ground-truth`

Save ground truth for a corpus entry. Append-only: creates a new draft ground-truth version (previous versions are preserved via `supersedesId`) and updates the entry's denormalized `groundTruthJson` for quick access.

**Auth:** Bearer token. Requires `corpus:write` permission.

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `values` | object | yes | The `{ field: value }` ground-truth label. This is what `validate` scores against. |
| `provenance` | object | no | Per-field provenance map (`{ field: ProvenanceSpan }`) — the same shape extraction returns alongside its values, retaining each value's `page`, `bbox`, source `chunk`, and resolution rung. Captured by the ground-truth builder when a value is confirmed or anchored via [`resolve-region`](#post-apischemasslugcorpusentryidresolve-region). Additive: omit it for a value-only label. Retained so a label stays auditable and region-anchored. |

**Response** `201 Created` — the new ground-truth row.

### `POST /api/schemas/{slug}/corpus/{entryId}/resolve-region`

Resolve a page region to the document text underneath it — the corpus-scoped twin of [`/api/jobs/{slug}/documents/{docId}/resolve-region`](#post-apijobsslugdocumentsdociresolve-region), used by the ground-truth builder's draw-a-box-to-correct flow. Stateless read against the cached parse `text_map`; no LLM, no writes.

**Auth:** Bearer token. Requires `corpus:read` permission.

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `page` | integer | yes | Page number, 1-indexed. |
| `bbox` | object | yes | `{ x, y, w, h }` normalized to `[0,1]`, top-left origin, with `w, h > 0`. |

**Response** `200 OK` — `{ text, words, bbox }` snapped to the matched words, or `{ text: null, words: [], bbox: null }` when the selection resolves to nothing (no parse cache, no geometry, or a region over whitespace). Callers treat `text: null` as "fall back to typed input" — a correction is never blocked on geometry.

**Errors**

| Status | Meaning |
|--------|---------|
| `400` | `page`/`bbox` missing or malformed. |
| `404` | Corpus entry not found. |

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

### `POST /api/schemas/{slug}/tune`

Run **one schema-tuning iteration** against a single labeled corpus entry: extract the document with the given schema, score it against the entry's ground truth, diagnose each failing field (including *routing* — did the model even see the answer?), and ask the model to propose a minimal edit. Read-only — it does **not** apply, snapshot, or persist anything; the caller decides what to do with the proposal. This is the score-aware counterpart to the free-form build agent, and the unit the autonomous tuning loop drives repeatedly. Auth: `job:run`.

**Request body**

| Field | Type | Description |
|-------|------|-------------|
| `corpus_entry_id` | string | The labeled exemplar to tune against. Must have ground truth (`400` otherwise). |
| `yaml` | string | The current schema YAML to evaluate and improve. |
| `model` | string? | Override the extraction/proposal model. |

**Response** `200 OK`:

```jsonc
{
  "before": {
    "accuracy": 60.0,           // % of ground-truth fields correct before the edit
    "passed": false,            // true ⇒ nothing to fix, no proposal returned
    "failing": [
      { "name": "premium",
        "expected": "1200",
        "got": "12000",
        "routingHint": "model saw the text but chose the wrong value (fix the field description/hint)" }
    ]
  },
  "proposedYaml": "name: ...\nfields:\n  ...",  // null if the model produced no valid YAML
  "explanation": "Tightened the premium field description to the annual figure."
}
```

`routingHint` distinguishes a **routing miss** (the answer never reached the model) from a **selection error** (the model saw it and chose wrong — fix the field description). Proposals are compiled before returning (with one retry); an uncompilable proposal returns `proposedYaml: null` with a `compileError`. `422` for invalid input YAML, `404` for an unknown entry.

### `POST /api/schemas/{slug}/tune/loop`

Run the tuning iteration **autonomously**: extract → score → propose → apply → re-run, repeating until the schema passes on the exemplar or the loop stalls. Returns the best-scoring schema found plus the full trace. Applies nothing durable — snapshotting a candidate and whole-corpus validation/promote is a separate, human-gated step. Auth: `job:run`.

**Request body**

| Field | Type | Description |
|-------|------|-------------|
| `corpus_entry_id` | string | The labeled exemplar to tune against (must have ground truth). |
| `yaml` | string | The starting schema YAML. |
| `model` | string? | Override the extraction/proposal model. |
| `max_iterations` | number? | Iteration cap, 1–10 (default 5). |

**Response.** Streams **SSE** by default: an `iteration` event per round (`{ n, accuracy, failing, proposed, explanation }`) then a final `complete` event with the aggregate. Send `Accept: application/json` for a single aggregate response:

```jsonc
{
  "iterations": [
    { "n": 1, "accuracy": 83.3, "failing": ["currency"], "proposed": true, "explanation": "..." },
    { "n": 2, "accuracy": 83.3, "failing": ["currency"], "proposed": true, "explanation": "..." },
    { "n": 3, "accuracy": 100, "failing": [], "proposed": false, "explanation": "..." }
  ],
  "finalYaml": "name: ...\nfields:\n  ...",   // the best-scoring schema tried
  "finalAccuracy": 100,
  "stopReason": "passed"    // passed | stuck_no_proposal | stuck_no_improvement | max_iterations | compile_error
}
```

The loop stops early when the schema passes, when the model can't propose a fix (`stuck_no_proposal`), or when two consecutive iterations don't improve (`stuck_no_improvement`). Each applied proposal is recorded to `agent_proposed_edits` for audit. `422` for invalid input YAML, `404` for an unknown entry, `400` when the entry has no ground truth.

### `POST /api/schemas/{slug}/tune/runs`

Start a **durable** corpus-tuning run. The loop can't complete in one request (the API function is capped at 300s; a real corpus exceeds it), so this creates a persisted run and drives it with background jobs — surviving disconnects and the time cap. Every corpus scoring itself **fans out one job per document** (the baseline pass alone can approach the cap), so runs of any corpus size stay well under it and report live per-document progress. Returns the run id immediately; poll for progress. Rejected proposals are persisted and fed back into later rounds (and future runs) so the model doesn't retread failed edits. Auth: `job:run`.

**Body**: `{ yaml, model?, max_iterations? (1–8, default 5) }`. **Response** `202`: `{ runId, status: "queued" }`. Requires ≥1 corpus doc with ground truth (`400`).

### `GET /api/schemas/{slug}/tune/runs/{runId}`

Poll a run: `{ id, status (queued|running|passed|stopped|failed), stopReason, baselineAccuracy, bestAccuracy, currentRound, maxIterations, phase (baseline|proposal|proposing|null), docsScored, docsTotal, bestYaml, rounds: [{ n, accuracy, docsPassed, docsTotal, accepted, focusDoc, fixing, regressions, explanation, thinking }] }`. `phase` + `docsScored`/`docsTotal` report the in-flight scoring pass so the UI can show live "N/M documents" progress. Auth: `job:read`.

### `GET /api/schemas/{slug}/tune/runs`

The latest run for the schema (`{ latest: { id, status, createdAt } | null }`) — used to resume the UI. Auth: `job:read`.

### `POST /api/schemas/{slug}/tune/corpus-loop`

Run the tuning loop optimizing for **whole-corpus accuracy** (not one document). Each round scores the schema across every labeled corpus doc, focuses on a failing one to guide the edit, proposes a change, then **re-scores the whole corpus** — keeping the edit only if overall accuracy improved and nothing regressed. This is the corpus-optimizing counterpart to `tune/loop`: a failing document guides the schema's evolution while the objective stays the corpus. Auth: `job:run`.

**Request body**

| Field | Type | Description |
|-------|------|-------------|
| `yaml` | string | The starting schema YAML. |
| `model` | string? | Override the extraction/proposal model. |
| `max_iterations` | number? | Round cap, 1–8 (default 5). |

**Response.** Streams **SSE** by default: a `round` event per round (`{ n, accuracy, docsPassed, docsTotal, accepted, focusDoc, fixing, regressions, explanation }`) then a `complete` event. A `status` event also streams fine-grained progress (`{ message }`) between rounds — scoring, focus, proposing, re-scoring — for a live "thinking" view. Send `Accept: application/json` for a single aggregate:

```jsonc
{
  "rounds": [
    { "n": 1, "accuracy": 91.7, "docsPassed": 1, "docsTotal": 2, "accepted": true, "focusDoc": "meridian_invoice.docx", "fixing": ["currency"], "regressions": [], "explanation": "..." },
    { "n": 2, "accuracy": 100, "docsPassed": 2, "docsTotal": 2, "accepted": true, "focusDoc": "sample_01.md", "fixing": ["currency"], "regressions": [], "explanation": "..." }
  ],
  "finalYaml": "name: ...",
  "finalAccuracy": 100,
  "baselineAccuracy": 83.3,
  "stopReason": "passed"    // passed | no_improvement | max_iterations | propose_failed
}
```

A proposal is accepted only when corpus accuracy does not drop **and** no field regresses; otherwise it's rejected and the next round tries again. Requires at least one corpus doc with ground truth (`400` otherwise). Each accepted proposal is recorded to `agent_proposed_edits`.

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

Create a version. `candidate: true` snapshots a non-active candidate; otherwise releases directly and activates. Auth: `schema:write`. Returns `{ id, version, released, action, displaced }`.

<a id="release-actions"></a>
**`action`** tells you what actually happened to the **live release pointer** — do not infer it from the `201`:

| `action` | Meaning |
|----------|---------|
| `created` | New version created and made live. |
| `unchanged` | This content is already the live release. **Nothing was written** — not even `updatedAt`. |
| `graduated` | The content matched an existing candidate; it was released and made live. |
| `activated` | The content matched an existing release and nothing was live yet. |
| `reactivated` | The live pointer moved to a **different** existing release. Only possible with `allow_reactivate: true`. |

`displaced` is the release the pointer moved off (`{ id, label }`), or `null`.

**Publishing content that matches a different existing release is refused by default.** Versions are deduplicated by content hash, so re-publishing the exact YAML of an older version would otherwise silently roll the live release backward. That case returns `409` with `reason: "requires_reactivate"`:

```json
{
  "error": "This content is already released as v2.0.5, so publishing it would roll the live release BACK from v2.0.9 to v2.0.5. ...",
  "reason": "requires_reactivate",
  "matched_version": "v2.0.5",
  "current_version": "v2.0.9",
  "direction": "backward",
  "hashed_bytes": 52732,
  "hashed_sha256_prefix": "d8ff0b04",
  "hint": "Verify hashed_bytes matches the payload you sent. ..."
}
```

Pass `allow_reactivate: true` to move the pointer on purpose, or use [`POST /api/schemas/{slug}/promote`](#post-apischemasslugpromote) to promote that version explicitly. The same rule and response shape apply to `POST /api/schemas/{slug}/release` and to both classifier equivalents.

### `POST /api/schemas/{slug}/promote`

Graduate a candidate to a release and make it live — **manual, gated by `schema:deploy`**.

**Request body**

| Field | Type | Description |
|-------|------|-------------|
| `versionId` | string? | Candidate to promote. Default: the latest candidate. |
| `requireNoRegressions` | boolean? | Refuse (`409`) if the candidate's latest run regressed. |

**Response** `200 OK` — `{ released: "v0.0.4" }`. `409` if a release already occupies that `x.y.z`.

### `POST /api/schemas/{slug}/release`

Release YAML directly (skip the rc loop) and make it live — the early-stage / empty-corpus path. Auth: `schema:deploy`. Body: `{ yaml?, allow_reactivate? }` (`yaml_source` is accepted as an alias). Returns `{ released, versionId, action, displaced }` — see [release actions](#release-actions), including the `409 requires_reactivate` refusal.

**The stored draft is released only when you send no body at all.** A body the endpoint cannot interpret is a `400`, never a fallback:

| Request | Result |
|---------|--------|
| no body | releases the stored draft |
| `{ "yaml": "..." }` | releases exactly that YAML |
| `{ "allow_reactivate": true }` | releases the stored draft |
| `{ "content": "..." }` — unrecognized field | **`400`**, naming the field |
| malformed JSON | **`400`** |
| `{ "yaml": null }` / `{ "yaml": "" }` | **`400`** |

Earlier releases fell back to the draft in every one of those failure cases, so a payload sent under the wrong field name silently released stored draft content the caller never supplied.

### Per-pipeline version mode

Promoting a schema changes its live release; each pipeline chooses how to react via `pipelines.versionMode`: **`auto`** (default) always runs the schema's live release, **`pinned`** holds a specific version until bumped (staged rollout). Set it with `POST /api/pipelines/{idOrSlug}/deploy` (auth `schema:deploy`): body `{ schema_version_id }` pins that version (sets `versionMode: "pinned"`); body `{ mode: "auto" }` unpins. The runner honors a pin only for the schema the pinned version belongs to; other schemas in a DAG fall back to live.

---

## Classifiers

A **classifier** is a config artifact — the schema-sibling of an extraction schema. Where a schema stores YAML defining `fields` to extract, a classifier stores YAML defining `classes` a document can be assigned to, plus the cost controls the [`POST /api/classify`](#post-apiclassify) cascade obeys. Classifiers use the same CRUD shape, the same semver versioning (released + `rc.N` candidates), and the same permissions as schemas: read is `schema:read`, create/update is `schema:write`, promote/release is `schema:deploy`. The engine ships no built-in classes — every class is user config.

Committing or creating a classifier validates the YAML with the classifier engine and stores the normalized config as the version's `parsedJson`. Invalid YAML (or a config that isn't a valid classifier — e.g. no `classes`) returns `400` with the validation message in `error`/`details`.

### `GET /api/classifiers`

List the tenant's classifiers. Each row carries `id`, `slug`, `displayName`, `description`, `currentVersionId`, `createdAt`, `latestVersion` (the highest committed version number, or `null`), and `latestVersionLabel` (its semver label, e.g. `"v1.2.0"` or `"v1.2.0-rc.3"`, or `null`). Auth: `schema:read`.

### `GET /api/classifiers/{slug}`

The classifier plus:

- `latestVersion` — the **highest committed** version (`{ versionNumber, version, yamlSource, commitMessage, createdAt }` or `null`), and `latestVersionLabel`, its semver label. This may be a *candidate*.
- `activeVersion` — the **live released** version `currentVersionId` points at (`{ versionId, versionNumber, version }` or `null`), and `activeVersionLabel`.

`activeVersion` is what routing actually runs; `latestVersion` is not necessarily live. Checking "what is live" no longer needs a second call to `/versions` to find the row flagged `active`. `404` for an unknown slug. Auth: `schema:read`.

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

A single version, including `yamlSource` and the normalized `parsedJson`. Auth: `schema:read`.

`{v}` accepts any of:

| Form | Example |
|------|---------|
| version number | `2` |
| semver label (with or without `v`) | `v0.0.1`, `0.0.1` |
| candidate label | `v1.2.0-rc.7` |
| version-id prefix | `bbbb2222` |

These are the same identifiers a pipeline's `classifier_version:` pin accepts, and the labels [`GET /api/classifiers/{slug}/versions`](#get-apiclassifiersslugversions) returns in its `version` field. A segment that identifies nothing is `400`; a well-formed identifier matching no version is `404`.

### `POST /api/classifiers/{slug}/versions`

Commit a version. Auth: `schema:write`.

**Request body**

| Field | Type | Description |
|-------|------|-------------|
| `yaml_source` | string | Required. Classifier YAML (`yaml` is accepted as an alias). |
| `commit_message` | string? | Message for the version. |
| `candidate` | boolean? | `true` snapshots a non-active candidate (dedup by content hash); otherwise releases directly and activates. |
| `bump` | `"major"\|"minor"\|"patch"`? | Override the auto-derived bump. |
| `allow_reactivate` | boolean? | Permit moving the live pointer to a **different existing release** when the content matches one. Default `false`. |

Returns `{ released, versionId, action, displaced }`. `400` on invalid YAML; `409` if a release already occupies that `x.y.z`, or with `reason: "requires_reactivate"` when publishing would move the live pointer to a different existing release — see [release actions](#release-actions) for `action`, `displaced`, and the refusal shape.

### `POST /api/classifiers/{slug}/promote`

Graduate a candidate to a release and make it live — **manual, gated by `schema:deploy`**. Body: `{ versionId? }` (defaults to the latest candidate). Returns `{ released: "v0.0.4" }`. `400` if there's no candidate; `409` if a release already occupies that `x.y.z`.

**Regression gate (optional).** The body also accepts gate fields that refuse the promotion when the candidate's latest backtest ([validate](#classifier-validate)) shows a class regressing vs. the live release or falling under an absolute floor — so tuning that lifts one class can't quietly cost another:

- `requireNoRegressions: true` — refuse if **any** class's recall or precision dropped vs. the live release.
- `mustNotRegress: ["policy", "coi"]` — refuse only if a **named** class regressed.
- `minRecall: { coi: 0.95 }` / `minPrecision: { policy: 0.9 }` — absolute per-class floors (0..1), independent of the baseline.

The candidate is compared against the live release's most recent completed backtest. A refusal is `409` with `{ error, blocked: [{ class, metric, kind, before, after, floor? }] }` — `kind` is `"regression"` (a drop vs. baseline, with `before`/`after`) or `"floor"` (`after` below `floor`). If a gate is requested but the candidate has no completed backtest to evaluate, the promotion is refused (`409`) rather than passed blindly. `POST /release` is the un-gated bypass (it skips the candidate/backtest loop).

### `POST /api/classifiers/{slug}/release`

Release YAML directly (skip the rc loop) and make it live — the early-stage path. Auth: `schema:deploy`. Body: `{ yaml_source?, allow_reactivate? }` (`yaml` accepted as an alias). Returns `{ released, versionId, action, displaced }` — see [release actions](#release-actions), including the `409 requires_reactivate` refusal. The stored draft is released only when you send **no body at all**; the same body rules as [`POST /api/schemas/{slug}/release`](#post-apischemasslugrelease) apply.

## Classifier corpus

A classifier can hold a **corpus** — documents labelled with the class they *should* be assigned — exactly as a schema holds ground-truth documents. It backs `koji classify validate` (backtesting a classifier config against known-correct labels). Corpus documents live in a **project-level pool** shared with schema corpora, so a document uploaded once can be labelled for a schema *and* for a classifier without re-uploading.

### `GET /api/classifiers/{slug}/corpus`

List the classifier's labelled documents: `id`, `documentId` (the pooled file), `filename`, `fileSize`, `mimeType`, `source`, `label` (the ground-truth class id, or `null` if unlabeled), `createdAt`. Auth: `corpus:read`.

### `POST /api/classifiers/{slug}/corpus`

Label a document for this classifier. **Two input modes:**

- **multipart** `file` + `label` — upload a new document, pool it, and label it.
- **JSON** `{ "document_id": "...", "label": "..." }` — label a document already in the project pool (see [`GET /api/corpus/documents`](#get-apicorpusdocuments)), with no re-upload.

`label` must be one of the classifier's **released** class ids, or `unknown` (a legitimate ground truth — "this document should fall through", which is what an `on_unknown: reject` config needs to backtest). An unknown label is a `400` that lists the valid ids. If the classifier has no released version, labels can't be validated → `409` (release it first). Re-labelling a document already in the corpus returns the existing entry (`200`). Auth: `corpus:write`. Returns the created entry (`201`).

### `DELETE /api/classifiers/{slug}/corpus/{entryId}`

Soft-delete a label. `204` on success, `404` if the entry isn't in this classifier's corpus. Auth: `corpus:write`.

### `POST /api/classifiers/{slug}/corpus/bootstrap`

Agent-assisted labeling. Runs the classifier at `max_tier: 4` over the project's **unlabeled** pool documents (those not already in this classifier's corpus) and writes each result as a **draft** ground-truth label (`authored_via_agent: true`, `review_status: "draft"`). The entry's denormalized ground truth stays empty, so **a draft is never scored by a backtest until approved** — grading the classifier against its own guesses would measure nothing. Body: `{ limit? }` (default 25, max 50 — bounded so a large pool is labelled in review-sized batches; call again to continue). Returns `{ proposed, skipped, remainingHint, proposals: [{ entryId, gtId, documentId, filename, proposedLabel, confidence, method, tierUsed }] }`. `409` if the classifier has no released version. Auth: `corpus:write`.

### `POST /api/classifiers/{slug}/corpus/{entryId}/ground-truth/{gtId}/approve`

Approve a draft label — the human exit ramp from bootstrap. Marks the ground-truth row `approved` and writes the denormalized `groundTruthJson` so the backtest begins scoring it. Optional body `{ label }` corrects the proposal first (validated against the released class ids, or `unknown`). `404` if the draft isn't for this classifier; `400` for an invalid correction. Auth: `corpus:write`. Mirrors [`POST /api/schemas/{slug}/corpus/{entryId}/ground-truth/{gtId}/approve`](#post-apischemasslugcorpusentryidground-truthgtidapprove).

The classifier corpus **list** (`GET /api/classifiers/{slug}/corpus`) surfaces the review state per entry: `label` (the approved, scored label, or `null`), `proposedLabel` + `reviewStatus` (`draft`/`approved`) for the latest ground-truth version, and `authoredViaAgent`.

## Classifier validate

Backtest a classifier version against its labelled corpus: classify every labelled document through the **same cascade production uses** and score predicted vs. ground truth. The mirror of the [schema validate surface](#post-apischemasslugvalidate). Auth: `job:run`.

### `POST /api/classifiers/{slug}/validate`

Run a backtest. Body (all optional):

- `version` — the version to backtest (a semver label like `"v1.2.0"`, or a version-id prefix). Defaults to the **released** version. A pin that doesn't resolve to exactly one version is a `404` (never a silent fall back to the release), matching classify-run semantics.
- `async` — when `true`, enqueue one job per labelled document and return `202` immediately (see below). Defaults to `false` (synchronous).

Only corpus entries that carry a ground-truth label enter the run. If none do, `400`. If the classifier has no released version to resolve, `409` (release it first).

**Synchronous** (default): documents run in-request with bounded parallelism and the full result is returned (`200`):

```json
{
  "runId": "…",
  "version": "v1.2.0",
  "docsTotal": 40,
  "docsCorrect": 37,
  "docsFailed": 1,
  "accuracy": 94.87,
  "byClass": [ { "label": "invoice", "support": 12, "predicted": 13, "tp": 12, "fp": 1, "fn": 0, "precision": 0.923, "recall": 1.0, "f1": 0.96 } ],
  "confusion": [ { "expected": "receipt", "predicted": "invoice", "count": 1 } ],
  "tierHistogram": { "2": 30, "3": 9 },
  "escalationRate": 0.23,
  "flips": { "fixed": 2, "regressed": 0, "churned": 1, "items": [ … ] },
  "costUsd": null
}
```

`docsFailed` (the cascade errored — e.g. provider outage) are excluded from the accuracy denominator. `escalationRate` is the share of scored documents that needed tier ≥ 3 (the paid model tail). `flips` compares each document against the classifier's previous completed run. `costUsd` is `null` until per-tier cost is wired in.

**Asynchronous** (`{ "async": true }`): one `classifier.validate.doc` job is enqueued per labelled document — no single request carries more than one document of classify work — and the call returns `202 { "runId", "status": "queued", "docsTotal", "version" }`. Poll the run endpoint below.

### `GET /api/classifiers/{slug}/validate/runs/{runId}`

Poll an async run. Returns `{ "runId", "status", "docsTotal", "docsProcessed", "result", "error" }`. `result` is the full scored object above once `status` is `"completed"`, otherwise `null`. Auth: `job:run`.

### `GET /api/classifiers/{slug}/validate`

Return the classifier's **most recent completed** backtest — the scored object above plus `runId`, `version` (the semver label that run scored), and `completedAt`. `null` if the classifier has never been backtested. A cheap single read; does not re-run classification. Auth: `job:run`.

## Corpus pool

### `GET /api/corpus/documents`

List the current **project's** pooled documents — every file any corpus surface (schema or classifier) has uploaded, so a picker can attach one to a new label by `document_id` instead of re-uploading. Project-scoped (needs the `x-koji-project` header). Optional `?content_hash=` filters to a specific file. Each row: `id`, `filename`, `fileSize`, `mimeType`, `contentHash`, `source`, `createdAt` — never the storage key. Auth: `corpus:read`.

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
