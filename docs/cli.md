---
title: CLI Reference
description: All koji commands — start, stop, process, status, and their flags.
---

# CLI Reference

The `koji` CLI manages clusters and processes documents.

## Commands

### `koji init`

Scaffold a new Koji project.

```bash
koji init                              # bare koji.yaml in the current directory
koji init myproject                    # new project directory with koji.yaml
koji init myproject --template invoice # scaffold from a bundled template
koji init --list-templates             # show all available templates
```

| Flag | Description |
|------|-------------|
| `--template`, `-t` | Scaffold from a bundled template (`invoice`, `receipt`, `contract`, `insurance`, `form`) |
| `--quickstart`, `-q` | Alias for `--template invoice` |
| `--list-templates` | List available templates and exit |

### `koji start`

Start the cluster defined in `koji.yaml`.

```bash
koji start              # local development (docker-compose)
koji start --k8s        # generate Kubernetes manifests
```

| Flag | Description |
|------|-------------|
| `--k8s` | Generate Kubernetes manifests instead of running docker-compose |
| `--config` | Path to `koji.yaml` (default: `./koji.yaml`) |

### `koji stop`

Stop the running cluster.

```bash
koji stop
```

### `koji process`

Process documents through the pipeline.

```bash
koji process ./invoice.pdf --schema ./schemas/invoice.yaml
koji process ./documents/                                    # process a directory
koji process ./doc.pdf --schema ./schemas/invoice.yaml --output ./results/
```

| Flag | Description |
|------|-------------|
| `--schema` | Path to extraction schema (overrides `koji.yaml`) |
| `--output` | Output directory (overrides `koji.yaml`) |
| `--config` | Path to `koji.yaml` (default: `./koji.yaml`) |

### `koji status`

Show cluster health and service status.

```bash
koji status
```

Output shows each running service, its port, and health status.

## Global Options

| Flag | Description |
|------|-------------|
| `--version` | Show version and exit |
| `--help` | Show help and exit |
