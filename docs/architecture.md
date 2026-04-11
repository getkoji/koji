---
title: Architecture
description: How Koji's processing pipeline, services, and cluster model work together.
---

# Architecture

Koji runs as a set of independent services coordinated by a central server. Each pipeline step is its own service with a clean API boundary.

## Overview

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  koji CLI    │────▶│  koji server│────▶│  services   │
│              │     │  (:9401)    │     │  (:9410+)   │
└─────────────┘     └──────┬──────┘     └─────────────┘
                           │
                    ┌──────▼──────┐
                    │  dashboard  │
                    │  (:9400)    │
                    └─────────────┘
```

- **CLI** — the `koji` command. Sends requests to the server.
- **Server** — orchestrates pipeline execution, manages service lifecycle.
- **Services** — one per pipeline step (parse, split, classify, extract, embed). Each runs in its own container.
- **Dashboard** — web UI for monitoring cluster health and job progress.

## Processing Flow

1. CLI sends a process request to the server
2. Server reads `koji.yaml` to determine the pipeline
3. For each step, the server sends the document to the appropriate service
4. Each service processes the document and returns results
5. Results flow through the pipeline in order
6. Final output is written to the configured output directory

## Services

Each service is:

- **Independent** — services don't know about each other
- **Stateless** — all state lives in the server
- **Containerized** — runs in Docker, same image locally and in production
- **Replaceable** — swap implementations by changing config

### Service Ports

The server assigns ports automatically from the `base_port` in your cluster config:

| Service | Default Port |
|---------|-------------|
| Dashboard | 9400 |
| Server | 9401 |
| Parse | 9410 |
| Split | 9411 |
| Classify | 9412 |
| Extract | 9413 |
| Embed | 9414 |

## Deployment

### Local Development

```bash
koji start
```

Uses docker-compose under the hood. All services run as containers on your machine.

### Kubernetes

```bash
koji start --k8s
```

Generates Kubernetes manifests for your pipeline. Same containers, same config, production-ready.

## Design Principles

- **Config over code** — change behavior by editing YAML, not writing code
- **No lock-in** — swap models, providers, or deployment targets without code changes
- **Same local and prod** — what runs on your laptop runs in production
- **Clean boundaries** — services communicate through defined APIs, never directly
