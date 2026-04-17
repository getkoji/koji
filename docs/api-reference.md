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
  "version": "0.1.0"
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
  "elapsed_seconds": 4.2
}
```

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
