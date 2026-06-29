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
| **Google Document AI** | Teams already on GCP — structured tables | Project ID + processor ID + region + service-account key |
| **AWS Textract** | Teams already on AWS — structured tables | Region + access key ID + secret access key |

The model / processor field defaults sensibly per provider (`mistral-ocr-latest`,
`prebuilt-layout`, etc.) — override it only if you need a specific one.

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
