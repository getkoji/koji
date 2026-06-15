---
title: API Reference
description: Complete reference for the Koji HTTP API.
---

# API Reference

The Koji API server runs on port `base_port + 1` (default `9401`). All endpoints return JSON.

Base URL: `http://localhost:9401`

---

## Health

### `GET /health`

Liveness check for the API server.

**Response** `200 OK`

```json
{
  "status": "healthy",
  "service": "koji-server",
  "version": "0.9.1"
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
    "extract": {
      "status": "healthy",
      "url": "http://koji-extract:9420",
      "response_ms": 32
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
    { "text": "Invoice", "page": 1, "bbox": { "x": 72, "y": 50, "w": 120, "h": 18 }, "level": "word" },
    { "text": "Number:", "page": 1, "bbox": { "x": 72, "y": 75, "w": 80, "h": 14 }, "level": "word" }
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

## Provenance

When extraction runs with a `text_map` (returned by the parse service), Koji resolves **provenance** for each extracted field — the exact location in the source document where the value was found. Provenance is returned in the `provenance` field of extraction responses and used by the [embeddable PDF viewer](integration.md#embedding-the-pdf-viewer) to render highlights.

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
  "bbox": { "x": 72, "y": 50, "w": 120, "h": 18 },
  "level": "word"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `text` | string | The word or text segment. |
| `page` | integer | Page number (1-indexed). |
| `bbox` | object | Bounding box in PDF points. Origin is top-left of the page. |
| `level` | string | Always `"word"` for word-level segments. |

The `text_map` is threaded automatically from parse → extract when using `POST /api/process`. When using `POST /api/extract` with pre-parsed content, pass the `text_map` from the parse response to enable provenance resolution.
