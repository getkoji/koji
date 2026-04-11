---
title: Koji Documentation
description: Self-hosted document processing platform. Documents in, structured data out.
---

# Koji Documentation

Koji is a self-hosted, config-driven document processing platform. Parse, split, classify, and extract structured data from any document -- PDFs, Word, images, scans -- using local models or any API provider.

## Get started

New to Koji? Start here:

- **[Getting Started](getting-started.md)** -- install, configure, and extract data from your first document in five minutes

## Core concepts

- **[Configuration](configuration.md)** -- everything you can do in `koji.yaml`
- **[Schemas](schemas.md)** -- define what structured data to extract (field types, arrays, nested objects, hints)
- **[Architecture](architecture.md)** -- how the pipeline works (parse, split, classify, extract, embed)

## Reference

- **[CLI Reference](cli.md)** -- all commands, flags, and usage examples

## Key ideas

**Config-driven.** One YAML file defines your entire pipeline. No code to write unless you want to.

**Self-hosted.** Runs on your infrastructure. `docker-compose` for development, Kubernetes for production. Same containers, same behavior.

**Model-agnostic.** Use OpenAI, Anthropic, local models via ollama/vllm, or your own inference endpoint. Mix and match per pipeline step.

**Modular.** Each processing step is an independent service. Use the full pipeline or any step on its own.
