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

### Extract from a file

```bash
curl -X POST http://localhost:9401/extract/upload \
  -F "file=@document.pdf" \
  -F "schema=$(cat schemas/claim.yaml)"
```

### Extract from pre-parsed markdown

```bash
curl -X POST http://localhost:9401/extract \
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

**Response:**

```json
{
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
  },
  "elapsed_ms": 1200
}
```

### Parse a document (without extraction)

```bash
curl -X POST http://localhost:9411/parse \
  -F "file=@document.pdf"
```

Returns parsed markdown, page count, and text map for provenance.

---

## Production: Koji Cloud

In production, point your API calls at Koji Cloud instead of localhost.

### 1. Get an API key

```bash
koji login
# Opens browser → creates API key at console.getkoji.dev
```

Or create one in the dashboard: **Settings → API Keys**.

### 2. Push your schemas

```bash
koji push -s ./schemas
```

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

# Push to Koji Cloud
koji push -s ./schemas -m "initial claim schema"

# Pull latest from Koji Cloud
koji pull -o ./schemas
```

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
