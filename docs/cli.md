---
title: CLI Reference
description: Every koji command — init, start, process, extract, test, bench, logs, doctor, and their flags.
---

# CLI Reference

The `koji` CLI manages clusters, processes documents, and runs benchmarks. Install via `pip install koji-cli`.

## Project lifecycle

### `koji init`

Scaffold a new Koji project. Creates `koji.yaml` and (optionally) a starter schema.

```bash
koji init                                    # bare koji.yaml in the current directory
koji init myproject                          # new project directory with koji.yaml
koji init myproject --template invoice       # scaffold from a bundled template
koji init myproject --quickstart             # alias for --template invoice
koji init --list-templates                   # show all available templates
```

| Flag | Description |
|------|-------------|
| `project_dir` (positional) | Optional. Directory name to create. Defaults to the current directory. |
| `--template`, `-t` | Scaffold from a bundled template. Run `--list-templates` to see all options. |
| `--quickstart`, `-q` | Alias for `--template invoice`. |
| `--list-templates` | List available templates and exit. |

Bundled templates: `invoice`, `receipt`, `contract`, `insurance`, `form`. Each ships with a working schema and a sample document so you can run extraction immediately.

---

### `koji doctor`

Check that your environment is ready to run Koji. Verifies Docker, Docker Compose, the Koji configuration file, port availability, and required environment variables.

```bash
koji doctor
```

```
Koji Doctor

  ✓ Docker installed (Docker version 27.x.x)
  ✓ Docker Compose available
  ✓ Docker daemon running
  ✓ koji.yaml found
  ✓ koji.yaml valid (project: myproject)
  ✓ Ports available (base: 9400)
  ✓ OPENAI_API_KEY set

7 passed, 0 warning, 0 failed
```

Run this any time something looks wrong. It's the fastest way to diagnose setup issues.

---

## Cluster lifecycle

### `koji start`

Start the cluster defined in `koji.yaml`. By default, pulls pre-built images from `ghcr.io/getkoji`.

```bash
koji start                # pull pre-built images and run (default)
koji start --dev          # build images from local source (for contributors)
```

| Flag | Description |
|------|-------------|
| `--dev` | Build images from the local source tree instead of pulling. Required when developing on Koji itself. |

First start with `--dev` takes a few minutes for the docling/torch image build. Default `koji start` pulls pre-built images and is usually under a minute once images are cached locally.

The dashboard comes up at `http://127.0.0.1:9400` (or whatever `cluster.base_port` is set to in `koji.yaml`).

---

### `koji stop`

Stop the running cluster.

```bash
koji stop
```

Tears down all containers but preserves Docker volumes (model caches, etc.). Run `koji start` again to bring the cluster back up.

---

### `koji status`

Show cluster health and per-service status.

```bash
koji status
```

Output shows each running service, its port, and health check result. Use this to verify the cluster is fully up before processing documents.

---

### `koji logs`

Stream container logs for one or all services.

```bash
koji logs                       # tail all services (last 100 lines)
koji logs extract               # tail just the extract service
koji logs extract --follow      # follow extract logs in real time
koji logs parse --tail 500      # show last 500 lines of parse logs
```

| Flag | Description |
|------|-------------|
| `service` (positional) | Service name: `server`, `parse`, `extract`, `ui`, `ollama`. Omit to show all services. |
| `--follow`, `-f` | Follow log output (like `tail -f`). Press Ctrl-C to stop. |
| `--tail`, `-t` | Number of lines to show from the end of the log (default: 100). |

---

## Document processing

### `koji process`

Run the full pipeline: parse a source document into markdown, then extract structured data using a schema.

```bash
koji process ./invoice.pdf --schema schemas/invoice.yaml
koji process ./documents/                                  # process a whole directory
koji process ./doc.pdf --schema schemas/invoice.yaml --output ./results/
```

| Flag | Description |
|------|-------------|
| `path` (positional) | Path to a document file or a directory of documents. |
| `--schema`, `-s` | Path to an extraction schema YAML. If omitted, only the parse step runs. |
| `--output`, `-o` | Output directory (default: `./output/`). |

When `--schema` is provided, you get the full pipeline: parse → extract → JSON output. Without `--schema`, you get parsed markdown only — useful for inspecting how Koji sees a document before writing a schema.

---

### `koji extract`

Skip the parse step and run extraction against an already-parsed markdown file. Much faster than `koji process` because parsing (Docling + OCR) is the slow step.

```bash
koji extract ./output/invoice.md \
  --schema schemas/invoice.yaml \
  --model openai/gpt-4o-mini
```

| Flag | Description |
|------|-------------|
| `path` (positional) | Path to a markdown file (from a previous parse). |
| `--schema`, `-s` | **Required.** Path to an extraction schema YAML. |
| `--model`, `-m` | Model override. Format: `provider/model-name`. Examples: `openai/gpt-4o-mini`, `openai/gpt-4o`, `ollama/llama3.2`. |
| `--output`, `-o` | Output directory (default: `./output/`). |
| `--strategy` | Extraction strategy: `parallel` (default, recommended) or `agent`. |

This is the fastest feedback loop while iterating on a schema. Parse once, extract many times with different schemas or models.

---

## Quality and benchmarking

### `koji test`

Run regression tests against fixture files. Catches schema or pipeline changes that break extraction on documents you care about.

```bash
koji test --schema schemas/invoice.yaml
koji test --schema schemas/invoice.yaml --update           # snapshot mode: save current outputs as new baseline
koji test --schema schemas/invoice.yaml --json             # machine-readable output for CI
```

| Flag | Description |
|------|-------------|
| `--schema`, `-s` | **Required.** Path to the schema being tested. |
| `--model`, `-m` | Model override. |
| `--update` | Snapshot mode: run extraction and save outputs as the new expected baseline. Use this for first-time setup or after intentional schema changes. |
| `--json` | Output machine-readable JSON results. |
| `--strategy` | Extraction strategy. |

`koji test` looks for fixture files alongside your schema. Place markdown documents in `<schema>.fixtures/` and corresponding `<name>.expected.json` files for ground truth. Field-level comparison: numbers and dates are matched semantically, strings case-insensitively, arrays order-insensitively. Exit code is 0 on full pass, 1 on any regression.

**Adversarial fixtures (`expected: null`)**: a field in the expected JSON that's explicitly set to `null` (or an empty string / empty list / empty dict) asserts that the model should **not** extract that field — either because the value isn't in the document or because the document is a trap meant to measure hallucination resistance. Both empty → pass ("correctly absent"); expected empty but actual populated → fail ("hallucinated"); expected populated but actual empty → fail ("missing"). Use this to build a trap corpus of documents where the right answer is "I don't know" and grade models on how often they correctly decline.

---

### `koji bench`

Benchmark extraction accuracy across an entire validation corpus. Use this to measure accuracy before shipping schema changes, compare models, or produce numbers for an accuracy dashboard.

```bash
koji bench --corpus ./corpus --model openai/gpt-4o-mini
koji bench --corpus ./corpus --category invoices --limit 10
koji bench --corpus ./corpus --model openai/gpt-4o --output bench.json
```

| Flag | Description |
|------|-------------|
| `--corpus`, `-c` | **Required.** Path to a corpus directory (with `documents/`, `expected/`, `manifests/`, `schemas/` subdirectories per category). |
| `--model`, `-m` | Model override. |
| `--category` | Only benchmark a single category (e.g., `invoices`). |
| `--limit` | Maximum documents to process per category. Useful for fast CI runs. |
| `--json` | Output machine-readable JSON. |
| `--output`, `-o` | Write JSON results to a file (always JSON, regardless of `--json`). |

The corpus format is the convention used by [getkoji/corpus](https://github.com/getkoji/corpus). Per-category, per-document, and aggregate accuracy are reported. Exit code is 0 on full pass, 1 on any regression or error.

---

## Misc

### `koji version`

Print the installed Koji version.

```bash
koji version
# koji 0.1.0
```

---

## Global options

| Flag | Description |
|------|-------------|
| `--help` | Show help for any command. Pass `--help` to a subcommand for details. |
| `--install-completion` | Install shell completion for your shell. |
| `--show-completion` | Show shell completion script. |

---

## What's missing here?

If you find a command, flag, or behavior in this doc that doesn't match what `koji --help` shows, please [open an issue](https://github.com/getkoji/koji/issues). The CLI is the source of truth — this document follows it.
