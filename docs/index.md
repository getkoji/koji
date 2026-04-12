---
title: Koji Documentation
description: Self-hosted document processing platform. Documents in, structured data out.
---

# Koji Documentation

Koji is a self-hosted, config-driven document processing platform. Parse and extract structured data from any document — PDFs, Word, images, scans — using local models or any OpenAI-compatible API provider.

## Get started

New to Koji? Start here:

- **[Getting Started](getting-started.md)** — install, configure, and extract data from your first document in five minutes

## Core concepts

- **[Schemas](schema-guide.md)** — define what to extract: field types, hints, arrays, enums, custom signals
- **[Configuration](configuration.md)** — full `koji.yaml` reference
- **[Architecture](architecture.md)** — how the pipeline works (map → route → extract → validate → reconcile)

## Reference

- **[CLI Reference](cli.md)** — all commands, flags, and usage examples
- **[API Reference](api-reference.md)** — every HTTP endpoint, request/response shape, and example

## Key ideas

**Config-driven.** One YAML schema defines what to extract. The pipeline is generic — domain knowledge lives in your schema, not in the engine.

**Self-hosted.** Runs on your infrastructure. `docker compose` for development, the same containers for production. Documents never leave the network you control unless you want them to.

**Model-agnostic.** Use any OpenAI-compatible API provider, local models via ollama, or your own inference endpoint. Mix and match per pipeline step.

**Open source.** Apache 2.0. Read the code, fork it, run it anywhere.
