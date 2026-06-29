---
title: Parse / OCR Providers (BYO)
description: Bring your own OCR / parse engine — Mistral, Azure Document Intelligence, Google Document AI, or AWS Textract — so parse cost stays on your bill.
---

# Parse / OCR Providers

Koji parses digital PDFs in-process for free (text is already embedded). Scanned
PDFs, images, and the hard long tail — faxes, dot-matrix loss runs, handwritten
annotations — need real OCR. You bring your own OCR / parse engine the same way
you bring your own model: configure a vendor key once, and the per-page parse
cost stays on **your** bill. Koji never marks it up.

With no parse endpoint configured, Koji uses its built-in default engine — so this
is entirely opt-in.

## Where to configure

**Project settings → Parse Endpoints → Add provider.**

Credentials are encrypted at rest (envelope encryption, same as model
endpoints) and can never be retrieved — only rotated.

| Provider | Best for | What you need |
|----------|----------|---------------|
| **Mistral OCR** | SMB / cost-sensitive — markdown-native, self-serve, cheap per page | API key |
| **Azure Document Intelligence** | Teams already on Azure — runs under your existing MSA | Resource endpoint URL + key |
| **Google Document AI** | Teams already on GCP — structured tables, handles large docs by slicing (no GCS needed) | Project ID + processor ID + region + service-account key |
| **AWS Textract** | Teams already on AWS — structured tables | Region + access key ID + secret access key |

The model / processor field defaults sensibly per provider (`mistral-ocr-latest`,
`prebuilt-layout`, etc.) — override it only if you need a specific one.

## Large documents (Google Document AI)

Google Document AI's synchronous `:process` API caps at **15 pages**. Most
real-world documents — multi-hundred-page policies, large SOV/COPE schedules,
wrap-up specs — are bigger, so Koji handles them automatically; you don't pick a
mode.

**By default, Koji slices large documents and processes the slices in parallel
on the synchronous endpoint — no Google Cloud Storage required.**

| Document size | Default path |
|---------------|--------------|
| ≤ 15 pages | A single synchronous `:process` call. |
| > 15 pages | Sliced into ≤ 15-page segments, each sent to `:process` **in parallel** (bounded by a concurrency cap), then merged back into one result with page numbers and bounding boxes renumbered globally. |

Slicing at page boundaries is quality-neutral for a page-local OCR processor:
each page is processed exactly as it would be on its own, and parallel
synchronous calls are typically faster per document than the asynchronous batch
API. No bucket, no IAM grant for storage, no temporary objects to clean up.

If a segment is rejected as too large (e.g. very image-heavy pages), Koji
automatically bisects it into smaller slices and retries; a segment that still
can't be processed surfaces a clear error rather than silently dropping pages.

### Tuning (optional)

| Config field | Default | Meaning |
|--------------|---------|---------|
| `slice_pages` | `15` | Pages per slice for the slice-and-merge path. Clamped to 1–30 (the synchronous endpoint can't exceed 30 pages even with imageless mode). |
| `online_concurrency` | `6` | Maximum number of slices processed in parallel. Lower it if you hit Document AI online QPS quotas. |

### Bulk imports: opt-in batch processing

For high-volume historical imports, you can opt into Document AI's asynchronous
**batch** API instead of slicing. Set `parse_mode: "batch"` (or
`use_batch: true`) in the endpoint config. Batch uploads the source to a GCS
bucket you own, runs the asynchronous batch operation, reads the structured
output back, and **deletes the temporary objects it created** — Koji never
retains your documents in your bucket.

Batch is **opt-in**, not the default. Use it for bulk back-fills; the default
slice-and-merge path is the better choice for interactive, per-document parsing.

When `parse_mode: "batch"` is set, add a **GCS bucket** to the endpoint config:

| Config field | Meaning |
|--------------|---------|
| `gcs_bucket` | Bucket Koji uses for batch input + output (it namespaces each job under `koji-docai/input/<run-id>/` and `koji-docai/output/<run-id>/`). |
| `gcs_input_uri` *(optional)* | Override the input prefix with an explicit `gs://…` location. |
| `gcs_output_uri` *(optional)* | Override the output prefix with an explicit `gs://…` location. |

Supplying `gcs_bucket` alone is enough; the explicit URIs are for teams that
want batch I/O under a specific path. With batch opted in but no bucket
configured, large documents fail with a clear error.

#### Required IAM for batch

The service account behind your endpoint's access token needs, in addition to
Document AI access:

- **`roles/documentai.apiUser`** on the processor — to run batch operations.
- **`roles/storage.objectAdmin`** on the configured bucket — to write the input,
  read the output shards, and delete both afterward. (A narrower split of
  object create / view / delete also works; `objectAdmin` is the simplest
  correct grant.)

The default slice-and-merge path needs **neither** of these storage grants —
just Document AI `:process` access.

## The default endpoint

The tenant's single **active** endpoint is the default heavy parse engine: it's
what runs when a pipeline doesn't pin one. The first endpoint you add becomes the
default automatically; adding more leaves them on standby. Use **Set as default**
on any endpoint to switch.

Standby endpoints are still usable — pin one to a specific pipeline (below) even
when it isn't the tenant default.

## Test a configured endpoint

**Test** on an endpoint card validates that the stored key decrypts with the
current master key and reports whether the runtime driver for that provider is
available in this build yet. (Drivers ship incrementally — a configured endpoint
whose driver hasn't landed shows **driver pending**; its credentials are stored
and validated, and it activates automatically once the driver is released.)

## Per-pipeline override

A pipeline can pin a specific parse endpoint instead of using the tenant default.
When creating a pipeline, set **Parse engine (optional)** — leave it on *Tenant
default (auto)* to follow the tenant default, or choose a configured endpoint to
pin it. The pinned engine shows on the pipeline detail under **Parse engine**.

This mirrors how a pipeline pins a model endpoint: the tenant default applies
unless a pipeline overrides it.

## Why BYO parse

OCR is an inference cost, like model calls — and it belongs on the customer's
bill the same way. Routing parse to your own vendor key keeps Koji a pure
platform layer and keeps you portable across parse vendors: switch engines
without re-tooling your schemas, pipelines, or review queues.
