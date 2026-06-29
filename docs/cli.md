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
koji logs parse                 # tail just the parse service
koji logs parse --follow        # follow parse logs in real time
koji logs server --tail 500     # show last 500 lines of server logs
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

## The schema loop (connected platform)

These commands drive the **Build → Validate → Corpus** workflow from the dashboard, but from the terminal. They talk to a running Koji platform (the same API the dashboard uses), so they need credentials: run `koji login` first, or set `KOJI_API_URL` + `KOJI_API_KEY`. Pass `--profile` to target a specific saved profile.

Every command below accepts `--json` to emit raw machine-readable output instead of a table — handy for scripting and for driving the loop from an agent.

The inner loop is: edit the schema YAML → `koji validate` to backtest it against ground truth → drill into a failing doc with `koji corpus diff` → repeat.

### `koji validate`

Backtest a schema against its corpus ground truth. Pushes the local schema (so your edits take effect), then runs the platform's validation — re-extracting every corpus doc that has ground truth and scoring it — and prints overall + per-field accuracy, regressions, and failing docs.

```bash
koji validate insurance_policy                       # push schemas/insurance_policy.yaml, then validate
koji validate ./schemas/insurance_policy.yaml        # explicit path
koji validate insurance_policy --no-push             # validate the version already on the server
koji validate insurance_policy --watch               # re-run whenever the local file changes
koji validate insurance_policy --check               # exit non-zero if any field regressed (CI / loops)
koji validate insurance_policy --json                # raw result for an agent to read
```

| Flag | Description |
|------|-------------|
| `--model` | Override the extraction model (e.g. `openai/gpt-4o-mini`). |
| `--no-push` | Validate the version already on the server; don't push local edits. |
| `--message`, `-m` | Commit message when pushing the schema. |
| `--watch`, `-w` | Re-run whenever the local schema file changes. |
| `--check` | Exit non-zero if any field regressed (for CI / loops). |
| `--json` | Emit raw JSON instead of a table. |
| `--profile`, `-p` | CLI profile to use. |

The `<schema>` argument is either a slug (a local `schemas/<slug>.yaml` is found and pushed automatically) or a path to a YAML file. The slug is taken from the file's `name:` field.

### `koji run`

Run one corpus document through a schema and show the extraction — the Build tab's **Run** button. Uses your local schema YAML if a file is found (so you can iterate without committing a version), otherwise the server's latest version.

```bash
koji run insurance_policy "10th street townes.pdf"   # match a doc by filename
koji run insurance_policy 561c6e69                    # …or by id (prefix is fine)
koji run insurance_policy 561c6e69 --provenance       # show the source snippet per value
koji run insurance_policy 561c6e69 --json             # raw extraction for an agent
```

| Flag | Description |
|------|-------------|
| `--model` | Override the extraction model. |
| `--provenance` | Show the source snippet each value came from. |
| `--json` | Emit raw JSON. |
| `--profile`, `-p` | CLI profile to use. |

### `koji corpus`

Manage a schema's validation corpus — documents and their ground-truth annotations.

```bash
koji corpus ls insurance_policy                      # list docs (id, filename, ground-truth?, source, tags)
koji corpus ls insurance_policy --no-gt              # only docs missing ground truth
koji corpus ls insurance_policy --tag edge-case      # filter by tag

koji corpus diff insurance_policy 561c6e69           # extracted vs ground truth, field by field
koji corpus diff insurance_policy 561c6e69 --run     # extract fresh first, then diff

koji corpus get insurance_policy 561c6e69 -o doc.pdf # download the source file to read it
koji corpus get insurance_policy 561c6e69 --markdown # …or the parsed markdown text

koji corpus add insurance_policy ./new-doc.pdf       # upload a doc into the corpus
koji corpus tag insurance_policy 561c6e69 --add edge-case --remove synthetic

koji corpus gt show insurance_policy 561c6e69        # show current ground truth
koji corpus gt accept insurance_policy 561c6e69      # promote the latest extraction to ground truth
koji corpus gt set insurance_policy 561c6e69 --from truth.json
```

A document is addressed by corpus-entry id (a unique prefix is enough — the id shown by `corpus ls` is truncated) or by filename (exact, or a unique substring). All `corpus` subcommands accept `--json` and `--profile`.

`koji corpus get` downloads the document so you can read it directly — the source file by default (PDFs, images, etc.), or the parsed markdown with `--markdown`. This is how you settle a disagreement between an extraction and ground truth: pull the document, read what it actually says, and correct ground truth with `koji corpus gt set`.

`koji corpus gt accept` reads the document's latest extraction (run `koji run` first) and saves those values as ground truth — the fast path for "this extraction is correct." `koji corpus gt set --from <file>` sets ground truth from a JSON file of `{field: value}`.

### `koji review`

Inspect the human-review queue and promote reviewed documents into the corpus. Documents land in this queue when a pipeline routes them for review — a field's confidence fell below the pipeline's review threshold, a validation rule failed, etc. These are the highest-signal documents to add to your corpus, because they're exactly the ones the current schema struggles with.

```bash
koji review ls                                       # pending items, worst confidence first
koji review ls --status completed                    # resolved items (ready to promote)
koji review ls --reason low_confidence               # filter by routing reason
koji review ls --limit 50 --json                     # raw rows for an agent to read

koji review show <id>                                # full context: flagged field, why it
                                                     #   routed, the doc's whole extracted record
koji review promote <id>                             # resolved+approved → corpus ground truth
koji review promote <id> --to edge-case              # …and tag the new corpus entry
koji review promote <id> --provisional --gt-from label.json   # agent draft label (needs approval)
```

`koji review promote` closes the **review → corpus** loop. By default it requires the item to be resolved and approved (in the dashboard); the human's corrected record becomes ground truth that `koji validate` scores immediately. With `--provisional`, an agent-supplied label is written as a **draft** that stays out of validation until a human approves it in the dashboard Corpus tab. A review item is addressed by its id (a unique prefix is enough). All `review` subcommands accept `--json` and `--profile`.

The full loop — promote the flagged docs, then fix the schema so they stop getting flagged — is encoded in the `review-corpus-loop` Claude skill (which hands off to `schema-loop` for the schema-improvement half).

---

## Misc

### `koji version`

Print the installed Koji version.

```bash
koji version
# koji 0.23.0
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
