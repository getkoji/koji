---
title: Integration Guide
description: Add Koji to your application — local dev with Docker, production with Koji Cloud.
---

# Integration Guide

Add document extraction to your application. Use self-hosted Koji in local dev, Koji Cloud in production — same API, different URL.

## Architecture

```
Your App                    Koji
┌──────────┐    POST /extract    ┌───────────┐
│ Your API │ ──────────────────▶ │ Koji API  │
│ (Node,   │                     │ :9401     │
│  Python, │ ◀────────────────── │           │
│  etc.)   │    { extracted }    └───────────┘
└──────────┘
```

- **Local dev**: Koji runs in Docker alongside your app
- **Production**: Call `api.getkoji.dev` with an API key

---

## Local Development

### Option A: Add to your docker-compose

Add Koji's services to your existing `docker-compose.yaml`:

```yaml
services:
  # ... your existing services ...

  koji-db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: koji
      POSTGRES_USER: koji
      POSTGRES_PASSWORD: koji
    volumes:
      - koji-db:/var/lib/postgresql/data

  koji-parse:
    image: ghcr.io/getkoji/parse:latest
    ports: ["9411:9411"]

  koji-extract:
    image: ghcr.io/getkoji/extract:latest
    ports: ["9412:9420"]
    environment:
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      KOJI_EXTRACT_MODEL: openai/gpt-4o-mini

  koji-api:
    image: ghcr.io/getkoji/api:latest
    ports: ["9401:9401"]
    environment:
      DATABASE_URL: postgres://koji:koji@koji-db:5432/koji
      KOJI_PARSE_URL: http://koji-parse:9411
      KOJI_EXTRACT_URL: http://koji-extract:9420
      OPENAI_API_KEY: ${OPENAI_API_KEY}
    depends_on:
      - koji-db
      - koji-parse
      - koji-extract

volumes:
  koji-db:
```

### Option B: Use the Koji CLI

If you prefer Koji managing its own stack:

```bash
# Install
uv tool install git+https://github.com/getkoji/koji.git

# Initialize with a template
koji init myproject --template insurance
cd myproject

# Start the cluster
export OPENAI_API_KEY=sk-...
koji start

# Dashboard at http://localhost:9400
# API at http://localhost:9401
```

---

## HTTP API

### `POST /api/process` — Parse + extract from a file

Upload a document and get structured data back in one call. The `schema`
field must be the **full schema definition as JSON** — not a slug or filename.

```bash
# Convert YAML schema to JSON and send with the file
curl -X POST http://localhost:9401/api/process \
  -H "Authorization: Bearer koji_yourkey" \
  -F "file=@document.pdf" \
  -F "schema=$(python3 -c 'import yaml,json; print(json.dumps(yaml.safe_load(open(\"schemas/claim.yaml\"))))')"
```

If you omit `schema`, the endpoint returns just the parsed markdown (no extraction).

**The `schema` field must be JSON, not a slug.** Sending `"schema": "claim"` will not work — send the full `{"name": "claim", "fields": {...}}` object.

**Response:**

```json
{
  "filename": "document.pdf",
  "pages": 3,
  "parse_seconds": 2.1,
  "model": "gpt-4o-mini",
  "elapsed_ms": 1200,
  "extracted": {
    "vendor": "Acme Corp",
    "total": 1500.00
  },
  "confidence": {
    "vendor": "high",
    "total": "high"
  },
  "confidence_scores": {
    "vendor": 1.0,
    "total": 1.0
  }
}
```

### `POST /api/extract` — Extract from pre-parsed markdown

If you've already parsed the document (or have text/markdown), skip the parse step:

```bash
curl -X POST http://localhost:9401/api/extract \
  -H "Authorization: Bearer koji_yourkey" \
  -H "Content-Type: application/json" \
  -d '{
    "markdown": "# Invoice\n\nVendor: Acme Corp\nTotal: $1,500.00",
    "schema_def": {
      "name": "invoice",
      "fields": {
        "vendor": {"type": "string", "required": true},
        "total": {"type": "number", "required": true}
      }
    }
  }'
```

### `POST /api/parse` — Parse only (no extraction)

```bash
curl -X POST http://localhost:9401/api/parse \
  -H "Authorization: Bearer koji_yourkey" \
  -F "file=@document.pdf"
```

Returns parsed markdown, page count, and text map for provenance.

### Programmatic usage (Node.js / Python)

```typescript
// Node.js — call /api/process with a file + schema
import fs from "fs";
import yaml from "yaml";

const schema = yaml.parse(fs.readFileSync("schemas/claim.yaml", "utf8"));
const form = new FormData();
form.append("file", new Blob([fs.readFileSync("document.pdf")]));
form.append("schema", JSON.stringify(schema));

const resp = await fetch(`${KOJI_URL}/api/process`, {
  method: "POST",
  headers: { Authorization: `Bearer ${KOJI_API_KEY}` },
  body: form,
});
const { extracted } = await resp.json();
```

```python
# Python — call /api/process with a file + schema
import httpx, yaml, json

schema = yaml.safe_load(open("schemas/claim.yaml"))
resp = httpx.post(
    f"{KOJI_URL}/api/process",
    headers={"Authorization": f"Bearer {KOJI_API_KEY}"},
    files={"file": open("document.pdf", "rb")},
    data={"schema": json.dumps(schema)},
)
extracted = resp.json()["extracted"]
```

### Model configuration

The model used for extraction is configured in the **dashboard** under
**Settings → Model Endpoints** — not in `koji.yaml`. Add your OpenAI,
Anthropic, or other LLM API key there. The endpoint you configure in
the dashboard is what `/api/process` and `/api/extract` use.

---

## Production: Koji Cloud

In production, point your API calls at Koji Cloud instead of localhost.

### 1. Get an API key

```bash
koji login
# Opens browser → creates API key at console.getkoji.dev
```

Or create one in the dashboard: **Settings → API Keys**.

### 2. Push schemas and pipelines

```bash
koji push -d .
```

This scans for YAML files in `schemas/` and `pipelines/` subdirectories.
Each file declares its type with a `kind` field.

### 3. Call the API

```bash
curl -X POST https://api.getkoji.dev/extract/upload \
  -H "Authorization: Bearer koji_your_api_key" \
  -H "x-koji-tenant: your-tenant-slug" \
  -F "file=@document.pdf" \
  -F "schema_slug=claim_form"
```

### Environment switching

Use the same code in dev and prod — just change the URL:

```typescript
const KOJI_URL = process.env.KOJI_URL ?? "http://localhost:9401";
const KOJI_API_KEY = process.env.KOJI_API_KEY; // only needed for Cloud

const headers: Record<string, string> = { "Content-Type": "application/json" };
if (KOJI_API_KEY) {
  headers["Authorization"] = `Bearer ${KOJI_API_KEY}`;
}

const response = await fetch(`${KOJI_URL}/extract`, {
  method: "POST",
  headers,
  body: JSON.stringify({ markdown, schema_def: schema }),
});

const { extracted } = await response.json();
```

```python
import os, httpx

KOJI_URL = os.environ.get("KOJI_URL", "http://localhost:9401")
KOJI_API_KEY = os.environ.get("KOJI_API_KEY")

headers = {}
if KOJI_API_KEY:
    headers["Authorization"] = f"Bearer {KOJI_API_KEY}"

resp = httpx.post(
    f"{KOJI_URL}/extract",
    json={"markdown": markdown, "schema_def": schema},
    headers=headers,
)
extracted = resp.json()["extracted"]
```

---

## Schema Management

Schemas define what to extract. Store them in git, push to Koji:

```bash
# Create a schema
cat > schemas/claim.yaml << 'EOF'
name: claim
fields:
  claimant_name:
    type: string
    required: true
  date_of_loss:
    type: date
    required: true
  amount_claimed:
    type: number
EOF

# Create a pipeline that uses the schema
cat > pipelines/claims.yaml << 'EOF'
kind: pipeline
name: Claims Processing
slug: claims
schema: claim
EOF

# Push everything (schemas + pipelines)
koji push -d . -m "initial setup"

# Push to a local cluster (env var override)
KOJI_API_URL=http://localhost:9501 KOJI_API_KEY=koji_yourkey \
  koji push -d . -m "initial setup"

# Pull latest from Koji Cloud
koji pull -o ./schemas
```

### YAML `kind` field

Every YAML file **must** declare its type with a `kind` field.
`koji push` only processes files with `kind: schema` or `kind: pipeline` —
all other files (including `koji.yaml` which uses `kind: config`) are skipped.

```yaml
# Schema — defines what to extract
kind: schema
name: claim
fields:
  claimant_name:
    type: string
    required: true

# Pipeline — connects a schema to processing
kind: pipeline
name: Claims Processing
slug: claims
schema: claim          # references schema by name
```

`koji push` reads `kind` and routes to the right API. Files without
`kind: schema` or `kind: pipeline` are skipped. Pipelines auto-link
to the first active model endpoint.

### Authentication

**Koji Cloud**: Run `koji login` to create a profile, or set env vars:
```bash
export KOJI_API_URL=https://api.getkoji.dev
export KOJI_API_KEY=koji_yourkey
```

**Local cluster**: After setup at `http://localhost:9500/setup`, create an API key in **Settings → API Keys**, then:
```bash
export KOJI_API_URL=http://localhost:9501
export KOJI_API_KEY=koji_yourkey
```

All CLI commands (`push`, `pull`, `bench`) respect `KOJI_API_URL` and `KOJI_API_KEY` env vars. These override the active CLI profile.

---

## Docker Images

All images are published to GitHub Container Registry:

| Image | Purpose | Default Port |
|-------|---------|-------------|
| `ghcr.io/getkoji/api` | API server + dashboard | 9401 |
| `ghcr.io/getkoji/parse` | Document parsing (PDF, Word, images) | 9411 |
| `ghcr.io/getkoji/extract` | LLM extraction engine | 9412 |

Pull with:

```bash
docker pull ghcr.io/getkoji/api:latest
docker pull ghcr.io/getkoji/parse:latest
docker pull ghcr.io/getkoji/extract:latest
```
