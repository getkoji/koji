---
title: Trace Format
description: The trace envelope returned by POST /api/extract and POST /api/process — the wire contract that the hosted platform persists into trace_stages.
---

# Trace Format

Every synchronous `POST /api/extract` and `POST /api/process` response includes a `trace` object describing the pipeline run that produced the result. Async responses include the same object inside the job result at `GET /api/jobs/{id}`.

The envelope is stable, row-shaped, and **maps 1:1 onto the `trace_stages` table** so a downstream consumer (the hosted control plane, a SIEM, a custom Postgres) can persist it without rewriting fields.

This page is the wire contract. Treat it as a versioned schema: additive changes only within a major version, breaking changes bump `trace.version`.

---

## Why this exists

Koji's value is the pipeline, not a single LLM call. A document moves through mapping, optional classification, routing, extraction, gap-fill, normalization, and validation — each stage is observable, priceable, and debuggable on its own. The trace is how we expose that observability on the wire.

Two consumers drive the shape:

1. **The hosted platform** (`platform/`) persists the trace to Postgres and renders the Trace view. To avoid a translation layer, each stage object mirrors the `trace_stages` column set.
2. **Self-hosted operators** who pipe the envelope into their own systems (Grafana, Splunk, Datadog). A flat, predictable, enumerated stage list is friendlier than nested stage-specific shapes.

---

## Top-level envelope

```json
{
  "trace": {
    "version": 1,
    "trace_id": "trc_8f3a91c2",
    "status": "complete",
    "started_at": "2026-04-17T10:00:00.000Z",
    "completed_at": "2026-04-17T10:00:02.340Z",
    "duration_ms": 2340,
    "stages": [ ... ]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `version` | integer | Schema version of the trace envelope. Currently `1`. Consumers MUST reject unknown versions or degrade gracefully. |
| `trace_id` | string | External trace ID, `trc_` + 8 lowercase hex chars. Stable across retries; unique per document run. Safe to search in the platform trace bar. |
| `status` | enum | `running`, `complete`, or `failed`. Matches `traces.status`. |
| `started_at` | RFC 3339 timestamp | When the first stage entered `running`. UTC, millisecond precision. |
| `completed_at` | RFC 3339 timestamp or null | When the last stage reached a terminal status. `null` while `status = running`. |
| `duration_ms` | integer or null | Wall-clock total. `null` while running. |
| `stages` | array | Ordered list of stage objects, described below. |

**Timestamp format.** Always RFC 3339 / ISO 8601 with a `Z` suffix and millisecond precision. No local offsets. No Unix epochs. One format across every field.

---

## Stage object

Each element of `stages[]` is one row-shaped record. The field names intentionally match `trace_stages` columns in [`database-schema.md`](https://github.com/getkoji/playbook/blob/main/docs/specs/database-schema.md) §8.3 — the platform ingestor can `INSERT` a row per stage with no renaming.

```json
{
  "stage_name": "extract",
  "stage_order": 5,
  "status": "complete",
  "started_at": "2026-04-17T10:00:00.125Z",
  "completed_at": "2026-04-17T10:00:02.100Z",
  "duration_ms": 1975,
  "summary_json": { ... },
  "error_message": null
}
```

| Field | Type | Column it maps to | Notes |
|-------|------|-------------------|-------|
| `stage_name` | enum (string) | `trace_stages.stage_name` | One of the names in the catalog below. Unknown names are rejected. |
| `stage_order` | integer ≥ 1 | `trace_stages.stage_order` | Dense, monotonic within a trace. Skipped stages keep their slot (no gaps). |
| `status` | enum | `trace_stages.status` | `pending`, `running`, `complete`, `failed`, or `skipped`. |
| `started_at` | timestamp or null | `trace_stages.started_at` | `null` for `pending`/`skipped`. |
| `completed_at` | timestamp or null | `trace_stages.completed_at` | `null` until terminal. |
| `duration_ms` | integer or null | `trace_stages.duration_ms` | `null` until terminal. |
| `summary_json` | object | `trace_stages.summary_json` | Stage-specific detail. Shape documented per-stage below. **Never null** — use `{}` for stages with no summary. |
| `error_message` | string or null | `trace_stages.error_message` | One-line human-readable error. Full stack traces belong in logs, not here. |

**What's not on the wire.** Columns that are server-side-only (`id`, `tenant_id`, `trace_id` as an FK) are **not** emitted. The platform fills them on ingestion from the surrounding request context.

---

## Status lifecycle

```
pending ──► running ──► complete
                   └──► failed
skipped (terminal, no timestamps)
```

- `pending` — stage exists in the plan but hasn't started. Rarely seen in a synchronous response; mostly a streaming-trace concept reserved for a later version.
- `running` — currently executing. In a completed trace, no stage has this status.
- `complete` — finished successfully.
- `failed` — finished unsuccessfully. `error_message` MUST be set.
- `skipped` — stage was configured out or the pipeline short-circuited past it (e.g. `classify` when no `classify_config` is provided). `summary_json` carries a `reason` field.

A trace with `status: failed` has exactly one stage in `failed`; all later stages are `skipped`.

---

## Stage catalog

Stage names are a closed enum. Adding a new stage is a minor-version envelope change (consumers must tolerate unknown stage names by logging + passing through). Removing or renaming is major-version.

Koji v0.1 emits stages in this order when they're active:

| Order | `stage_name` | Always runs? | Purpose |
|------:|-------------|:------------:|---------|
| 1 | `ingress` | yes | Accept request, validate schema, resolve model. |
| 2 | `parse` | only on `/api/process` | PDF/DOCX/image → markdown via the parse service. |
| 3 | `map` | yes | Build the document map — chunking, category tagging. |
| 4 | `classify` | only when `classify_config` set | Split the doc into typed sections (invoice / policy / etc.). |
| 5 | `route` | yes | Per-field routing plan — which chunks feed which extraction groups. |
| 6 | `extract` | yes | Per-group LLM calls across extraction waves. The hot stage. |
| 7 | `gap_fill` | when fields still missing | Second-pass targeted extraction for unfilled required fields. |
| 8 | `normalize` | yes | Type coercion, date normalization, enum snapping. |
| 9 | `validate` | yes | Schema rule enforcement, required-field checks, cross-field validators. |

Stages that don't run for a given request appear with `status: "skipped"` and a one-word `reason` in `summary_json`. This keeps `stage_order` dense and predictable so consumers can index by name or ordinal without surprises.

**Reserved names** (emitted in future versions, should be accepted by forward-looking consumers):
`ocr`, `preflight`, `merge`, `score`, `review_gate`, `emit`.

---

## `summary_json` by stage

Every `summary_json` is a flat object. Keys are stable within a major version; consumers MUST ignore unknown keys.

### `ingress`

```json
{
  "schema": "invoice",
  "schema_version": 3,
  "model": "openai/gpt-4o-mini",
  "strategy": "intelligent",
  "input_bytes": 48210
}
```

### `parse`

```json
{
  "engine": "docling",
  "pages": 3,
  "markdown_bytes": 12480
}
```

### `map`

```json
{
  "total_chunks": 17,
  "by_category": { "header": 2, "line_items": 9, "other": 6 },
  "avg_chunk_tokens": 420
}
```

### `classify`

```json
{
  "model": "openai/gpt-4o-mini",
  "sections": 2,
  "sections_matched": 1,
  "types_seen": ["invoice", "document"],
  "normalizer_corrections": 0,
  "elapsed_ms": 180
}
```

When skipped: `{ "reason": "no_classify_config" }`.

### `route`

```json
{
  "groups": 4,
  "waves": 2,
  "plan": {
    "invoice_number": { "group": 0, "chunks": [0, 1] },
    "line_items": { "group": 2, "chunks": [5, 6, 7, 8] }
  }
}
```

The `plan` object is compact — field → group + chunk indices. The trace view renders it as a waterfall alignment; platform operators rarely read it raw.

### `extract`

This is the expensive stage. The summary is a roll-up; per-group detail lives in the raw I/O bucket (see below).

```json
{
  "groups": 4,
  "waves": 2,
  "prompt_tokens": 3240,
  "completion_tokens": 240,
  "cost_usd": 0.00095,
  "raw_prompt_key": "traces/{trace_id}/stage-06-extract-prompt.jsonl",
  "raw_response_key": "traces/{trace_id}/stage-06-extract-response.jsonl"
}
```

The `raw_prompt_key` / `raw_response_key` fields are present only when the deployment has raw-I/O capture enabled (default on for hosted, default off for self-hosted). When absent, the raw prompts were not persisted.

### `gap_fill`

```json
{
  "attempted": ["policy_number", "effective_date"],
  "filled": ["effective_date"],
  "still_missing": ["policy_number"],
  "prompt_tokens": 820,
  "completion_tokens": 40
}
```

When skipped: `{ "reason": "no_missing_fields" }`.

### `normalize`

```json
{
  "applied": [
    { "field": "date", "transform": "date_yyyymmdd" },
    { "field": "total_amount", "transform": "currency_to_number" }
  ],
  "warnings": []
}
```

### `validate`

```json
{
  "result": "passed",
  "violations": [],
  "required_fields_missing": []
}
```

On failure:

```json
{
  "result": "failed",
  "violations": [
    { "field": "policy_number", "rule": "required", "message": "value is null" }
  ],
  "required_fields_missing": ["policy_number"]
}
```

---

## Direct persistence

The platform ingestor does this, row-for-row:

```sql
INSERT INTO traces (id, tenant_id, document_id, job_id, trace_external_id,
                    status, total_duration_ms, started_at, completed_at)
VALUES (gen_random_uuid(), $tenant, $doc, $job, $envelope.trace_id,
        $envelope.status, $envelope.duration_ms,
        $envelope.started_at, $envelope.completed_at)
RETURNING id;

-- then, per stage in $envelope.stages:
INSERT INTO trace_stages (id, tenant_id, trace_id, stage_name, stage_order,
                          status, started_at, completed_at, duration_ms,
                          summary_json, error_message)
VALUES (gen_random_uuid(), $tenant, $trace_row_id,
        $stage.stage_name, $stage.stage_order, $stage.status,
        $stage.started_at, $stage.completed_at, $stage.duration_ms,
        $stage.summary_json, $stage.error_message);
```

No field renames. No enum translations. No JSON re-shaping. That's the whole point of locking the shape.

Self-hosted operators can use the same model: drop the envelope into a Postgres extension, a Kafka topic, or a flat file, and every row is already the right shape.

---

## Error traces

A failed run still emits a complete envelope. Stages up to and including the failure are present; stages after it are `skipped` with `reason: "upstream_failure"`.

```json
{
  "trace": {
    "version": 1,
    "trace_id": "trc_1d2e3f4a",
    "status": "failed",
    "started_at": "2026-04-17T10:00:00.000Z",
    "completed_at": "2026-04-17T10:00:00.450Z",
    "duration_ms": 450,
    "stages": [
      { "stage_name": "ingress", "stage_order": 1, "status": "complete", "duration_ms": 5,
        "started_at": "2026-04-17T10:00:00.000Z", "completed_at": "2026-04-17T10:00:00.005Z",
        "summary_json": { "schema": "invoice", "model": "openai/gpt-4o-mini", "strategy": "intelligent", "input_bytes": 48210 },
        "error_message": null },
      { "stage_name": "map", "stage_order": 3, "status": "complete", "duration_ms": 40,
        "started_at": "2026-04-17T10:00:00.005Z", "completed_at": "2026-04-17T10:00:00.045Z",
        "summary_json": { "total_chunks": 12, "by_category": { "header": 1, "other": 11 }, "avg_chunk_tokens": 390 },
        "error_message": null },
      { "stage_name": "extract", "stage_order": 6, "status": "failed", "duration_ms": 405,
        "started_at": "2026-04-17T10:00:00.045Z", "completed_at": "2026-04-17T10:00:00.450Z",
        "summary_json": { "groups": 4, "waves": 1, "prompt_tokens": 3100, "completion_tokens": 0 },
        "error_message": "upstream model endpoint returned 503" },
      { "stage_name": "normalize", "stage_order": 8, "status": "skipped",
        "started_at": null, "completed_at": null, "duration_ms": null,
        "summary_json": { "reason": "upstream_failure" }, "error_message": null },
      { "stage_name": "validate", "stage_order": 9, "status": "skipped",
        "started_at": null, "completed_at": null, "duration_ms": null,
        "summary_json": { "reason": "upstream_failure" }, "error_message": null }
    ]
  },
  "error": "upstream model endpoint returned 503"
}
```

Note `parse` and `classify` are absent (not skipped) because they were never in the pipeline plan for this particular `/api/extract` call with no classifier. Stage `stage_order` values reflect the canonical catalog ordering even when some slots are unused, so downstream waterfall rendering stays aligned.

---

## Versioning

- `trace.version = 1` is the initial locked version.
- **Additive changes** (new `summary_json` key, new reserved stage name) do not bump the version. Consumers MUST ignore unknown keys and tolerate unknown stage names.
- **Breaking changes** (renamed field, removed field, changed enum semantics) bump `trace.version` to `2`. Servers and consumers negotiate via the version field; there is no request-side content negotiation.

Koji will keep emitting the highest version it supports. Consumers pinned to an older version should treat unknown versions as opaque or fail fast — do not attempt to downgrade.

---

## Full example

A clean classifier-off invoice extraction:

```json
{
  "extracted": {
    "invoice_number": "INV-2026-0042",
    "date": "2026-03-15",
    "total_amount": 6000.00
  },
  "model": "openai/gpt-4o-mini",
  "schema": "invoice",
  "elapsed_ms": 2340,
  "trace": {
    "version": 1,
    "trace_id": "trc_8f3a91c2",
    "status": "complete",
    "started_at": "2026-04-17T10:00:00.000Z",
    "completed_at": "2026-04-17T10:00:02.340Z",
    "duration_ms": 2340,
    "stages": [
      { "stage_name": "ingress", "stage_order": 1, "status": "complete",
        "started_at": "2026-04-17T10:00:00.000Z", "completed_at": "2026-04-17T10:00:00.005Z", "duration_ms": 5,
        "summary_json": { "schema": "invoice", "schema_version": 3, "model": "openai/gpt-4o-mini", "strategy": "intelligent", "input_bytes": 48210 },
        "error_message": null },
      { "stage_name": "map", "stage_order": 3, "status": "complete",
        "started_at": "2026-04-17T10:00:00.005Z", "completed_at": "2026-04-17T10:00:00.050Z", "duration_ms": 45,
        "summary_json": { "total_chunks": 17, "by_category": { "header": 2, "line_items": 9, "other": 6 }, "avg_chunk_tokens": 420 },
        "error_message": null },
      { "stage_name": "classify", "stage_order": 4, "status": "skipped",
        "started_at": null, "completed_at": null, "duration_ms": null,
        "summary_json": { "reason": "no_classify_config" }, "error_message": null },
      { "stage_name": "route", "stage_order": 5, "status": "complete",
        "started_at": "2026-04-17T10:00:00.050Z", "completed_at": "2026-04-17T10:00:00.125Z", "duration_ms": 75,
        "summary_json": { "groups": 4, "waves": 2, "plan": { "invoice_number": { "group": 0, "chunks": [0, 1] } } },
        "error_message": null },
      { "stage_name": "extract", "stage_order": 6, "status": "complete",
        "started_at": "2026-04-17T10:00:00.125Z", "completed_at": "2026-04-17T10:00:02.100Z", "duration_ms": 1975,
        "summary_json": { "groups": 4, "waves": 2, "prompt_tokens": 3240, "completion_tokens": 240, "cost_usd": 0.00095 },
        "error_message": null },
      { "stage_name": "gap_fill", "stage_order": 7, "status": "skipped",
        "started_at": null, "completed_at": null, "duration_ms": null,
        "summary_json": { "reason": "no_missing_fields" }, "error_message": null },
      { "stage_name": "normalize", "stage_order": 8, "status": "complete",
        "started_at": "2026-04-17T10:00:02.100Z", "completed_at": "2026-04-17T10:00:02.115Z", "duration_ms": 15,
        "summary_json": { "applied": [ { "field": "date", "transform": "date_yyyymmdd" }, { "field": "total_amount", "transform": "currency_to_number" } ], "warnings": [] },
        "error_message": null },
      { "stage_name": "validate", "stage_order": 9, "status": "complete",
        "started_at": "2026-04-17T10:00:02.115Z", "completed_at": "2026-04-17T10:00:02.340Z", "duration_ms": 225,
        "summary_json": { "result": "passed", "violations": [], "required_fields_missing": [] },
        "error_message": null }
    ]
  }
}
```

The response still carries the existing top-level fields (`extracted`, `model`, `schema`, `elapsed_ms`, etc.) for back-compat with v0.1 clients. The `trace` object is additive.
