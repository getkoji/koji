---
title: CLI Reference
description: All koji commands — start, stop, process, status, and their flags.
---

# CLI Reference

The `koji` CLI manages clusters and processes documents.

## Commands

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
