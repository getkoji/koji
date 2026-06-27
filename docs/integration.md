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

  koji-api:
    image: ghcr.io/getkoji/api:latest
    ports: ["9401:9401"]
    environment:
      DATABASE_URL: postgres://koji:koji@koji-db:5432/koji
      KOJI_PARSE_URL: http://koji-parse:9411
      OPENAI_API_KEY: ${OPENAI_API_KEY}
    depends_on:
      - koji-db
      - koji-parse

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

### Uploading large files (presigned URL)

On Koji Cloud, direct file uploads are limited to 4.5 MB by the hosting
platform. For larger documents, use the presigned URL flow — the client
uploads directly to storage, bypassing the API server entirely.

**Step 1: Get a presigned URL**

```bash
curl -X POST https://console.getkoji.dev/api/upload/presign \
  -H "Authorization: Bearer koji_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "large-document.pdf",
    "contentType": "application/pdf",
    "context": "corpus",
    "schemaSlug": "claim_form"
  }'
```

Response:

```json
{
  "uploadUrl": "https://storage.example.com/presigned-put-url...",
  "storageKey": "corpus/tenant-id/schema-id/1718000000-large-document.pdf"
}
```

**Step 2: Upload the file directly to storage**

```bash
curl -X PUT "$UPLOAD_URL" \
  -H "Content-Type: application/pdf" \
  --data-binary @large-document.pdf
```

**Step 3: Finalize the upload**

```bash
curl -X POST https://console.getkoji.dev/api/upload/complete \
  -H "Authorization: Bearer koji_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "storageKey": "corpus/tenant-id/schema-id/1718000000-large-document.pdf",
    "filename": "large-document.pdf",
    "context": "corpus",
    "schemaSlug": "claim_form"
  }'
```

The complete endpoint verifies the file exists, deduplicates by content
hash, and creates the corpus entry. If the file was already uploaded
(same hash), the duplicate is cleaned up and the existing entry is
returned.

**Programmatic example (Node.js):**

```typescript
async function uploadLargeFile(file: File, schemaSlug: string) {
  // Step 1: Get presigned URL
  const { uploadUrl, storageKey } = await fetch(`${KOJI_URL}/api/upload/presign`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${KOJI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type,
      context: "corpus",
      schemaSlug,
    }),
  }).then(r => r.json());

  // Step 2: Upload directly to storage
  await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });

  // Step 3: Finalize
  const entry = await fetch(`${KOJI_URL}/api/upload/complete`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${KOJI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ storageKey, filename: file.name, context: "corpus", schemaSlug }),
  }).then(r => r.json());

  return entry;
}
```

> **When to use presigned uploads:** Always use this flow on Koji Cloud
> for files that may exceed 4.5 MB. For self-hosted deployments without
> a body size limit, the direct `POST /api/process` flow works for any
> file size. The dashboard uses presigned uploads automatically.

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

For small files (< 4.5 MB):

```bash
curl -X POST https://console.getkoji.dev/api/process \
  -H "Authorization: Bearer koji_your_api_key" \
  -F "file=@document.pdf" \
  -F "schema=$(cat schema.json)"
```

For large files, use the [presigned URL flow](#uploading-large-files-presigned-url) — see the HTTP API section above.

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

## Embedding the PDF Viewer

Koji includes a standalone PDF viewer that you can embed in your application via an iframe. It renders the original document with provenance highlights showing where each extracted field was found.

### Quick start

```html
<iframe
  src="https://console.getkoji.dev/embed/viewer?job=JOB_SLUG&doc=DOC_ID&token=PREVIEW_TOKEN"
  style="width: 100%; height: 600px; border: none;"
></iframe>
```

### Getting the embed parameters

When you fetch a document's detail via the API, the response includes a signed preview token:

```bash
curl https://api.getkoji.dev/api/jobs/JOB_SLUG/documents/DOC_ID \
  -H "Authorization: Bearer koji_yourkey" \
  -H "x-koji-tenant: your-tenant-slug"
```

The response includes `documentPreviewUrl` and `documentToken`. Use these to construct the embed URL:

```typescript
const detail = await fetch(`${KOJI_URL}/api/jobs/${jobSlug}/documents/${docId}`, {
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "x-koji-tenant": tenantSlug,
  },
}).then((r) => r.json());

const embedUrl = new URL("/embed/viewer", KOJI_DASHBOARD_URL);
embedUrl.searchParams.set("job", jobSlug);
embedUrl.searchParams.set("doc", docId);
embedUrl.searchParams.set("token", detail.documentToken);
// Optional: jump to a specific field
embedUrl.searchParams.set("field", "vendor_name");

document.getElementById("viewer").src = embedUrl.toString();
```

### Two modes

| Mode | When to use | Query params |
|------|-------------|--------------|
| **Document mode** | You have a Koji job/document and want the API to provide the PDF and highlights | `job`, `doc`, `token` |
| **URL mode** | You have your own PDF URL and want to provide highlights directly | `url`, `highlights` (base64 JSON) |

**Document mode** fetches the PDF and provenance highlights from the Koji API automatically. The HMAC token grants 1-hour access without requiring the iframe to have a session cookie.

**URL mode** lets you bring your own PDF — no Koji API calls from the iframe:

```html
<iframe src="https://console.getkoji.dev/embed/viewer?url=https://example.com/doc.pdf&highlights=BASE64_JSON"></iframe>
```

The `highlights` param is a base64-encoded JSON array:

```typescript
const highlights = [
  { field: "vendor", page: 1, bbox: { x: 100, y: 200, w: 300, h: 20 } },
  { field: "total",  page: 1, bbox: { x: 100, y: 250, w: 200, h: 20 } },
];
const encoded = btoa(JSON.stringify(highlights));
// → use as ?highlights=<encoded>
```

### Messaging schema (postMessage)

Control runs over `window.postMessage`. Every message is a plain object with a
`type` string prefixed `koji:`. The viewer ignores anything without that prefix.

**Inbound** — parent → viewer (`iframe.contentWindow.postMessage(msg, viewerOrigin)`):

| `type` | Payload | Effect |
|--------|---------|--------|
| `koji:setActiveField` | `{ field: string \| null }` | Highlight a field and scroll/page to it. `null` clears the selection. |
| `koji:setHighlights` | `{ highlights: BBoxHighlight[] }` | Replace all highlights (e.g. after re-extraction). |
| `koji:goToPage` | `{ page: number }` | Jump to a 1-based page (clamped to the document). |
| `koji:setToken` | `{ token: string }` | Swap in a fresh `documentToken` without reloading the iframe — see [Token refresh](#token-refresh-for-long-sessions). |
| `koji:setTheme` | `{ theme: { activeColor?: string; inactiveColor?: string } }` | Recolor the highlight boxes (any CSS color; pass `rgba()`/`hsla()` for translucency). |
| `koji:setViewMode` | `{ mode?: "paginated" \| "scroll"; overflow?: "auto" \| "scroll" \| "hidden" }` | Switch the layout at runtime — see [Layout](#layout-scroll-vs-paginated). Both fields optional; unknown values are ignored. |

**Outbound** — viewer → parent (your `window.addEventListener("message", …)`):

| `type` | Payload | When |
|--------|---------|------|
| `koji:ready` | `{ pageCount: number }` | The PDF has loaded and the viewer is ready to accept commands. |
| `koji:fieldClicked` | `{ field: string; page: number }` | The user clicked a highlight box in the PDF. |

> **Always pass a real `targetOrigin` — never `"*"`.** When you post *to* the
> viewer, the second arg is the **viewer's** origin (e.g.
> `https://console.getkoji.dev`). For the viewer to post *back* to you, tell it
> your origin with `?parentOrigin=https://your-app.com` on the iframe `src`. If
> you omit it, the viewer falls back to the embedding page's origin
> (`document.referrer`) and only posts to `"*"` as a last resort (with a console
> warning). Outbound payloads contain no document bytes, but scoping the origin
> is still the correct posture.

```typescript
const iframe = document.getElementById("viewer") as HTMLIFrameElement;
const VIEWER_ORIGIN = "https://console.getkoji.dev";

// Listen for outbound events from the viewer
window.addEventListener("message", (e) => {
  if (e.origin !== VIEWER_ORIGIN) return;          // verify the sender
  const msg = e.data;
  if (msg?.type === "koji:ready") {
    console.log(`viewer ready, ${msg.pageCount} pages`);
  }
  if (msg?.type === "koji:fieldClicked") {
    // sync selection back into your own UI
    selectFieldInMyApp(msg.field);
  }
});

// Drive the viewer from your UI
function onFieldClick(fieldName: string) {
  iframe.contentWindow!.postMessage(
    { type: "koji:setActiveField", field: fieldName },
    VIEWER_ORIGIN,                                   // not "*"
  );
}

// Navigate, recolor
iframe.contentWindow!.postMessage({ type: "koji:goToPage", page: 3 }, VIEWER_ORIGIN);
iframe.contentWindow!.postMessage(
  { type: "koji:setTheme", theme: { activeColor: "rgba(220,38,38,0.4)", inactiveColor: "rgba(0,0,0,0.12)" } },
  VIEWER_ORIGIN,
);
```

### Theming

Match the highlight colors to your host UI either at load time via query params
or at runtime via `koji:setTheme`:

```html
<iframe src="https://console.getkoji.dev/embed/viewer?job=JOB&doc=DOC&token=TOKEN&activeColor=rgba(220,38,38,0.4)&inactiveColor=rgba(0,0,0,0.12)"></iframe>
```

`activeColor` styles the selected highlight; `inactiveColor` styles the rest.
Both accept any CSS color — use `rgba()`/`hsla()` for translucent fills so the
underlying text stays readable.

### Layout: scroll vs paginated

The viewer defaults to **paginated** layout — one page at a time with `‹` / `›`
arrow navigation. To render every page stacked in a continuous scrollable
column instead, set `mode=scroll`. Control the scrollbar with `overflow`
(`auto` default, `scroll` always-visible, `hidden` none). Set them at load time:

```html
<iframe src="https://console.getkoji.dev/embed/viewer?job=JOB&doc=DOC&token=TOKEN&mode=scroll&overflow=auto"></iframe>
```

…or switch at runtime (both fields optional):

```typescript
iframe.contentWindow!.postMessage(
  { type: "koji:setViewMode", mode: "scroll" },
  VIEWER_ORIGIN,
);
```

| Param | Values | Default | Meaning |
|-------|--------|---------|---------|
| `mode` | `paginated`, `scroll` | `paginated` | Arrow-paged single page vs. all pages stacked. |
| `overflow` | `auto`, `scroll`, `hidden` | `auto` | Scrollbar behavior of the viewer container. |

`koji:goToPage` works in both layouts — it flips the page in paginated mode and
scrolls the page into view in scroll mode. Unknown values fall back to the
defaults.

### Field picker

In **Document mode**, the viewer shows a built-in dropdown in the toolbar listing
each extracted field and its value. Selecting an entry jumps to that field's
highlight — flipping the page in paginated mode or scrolling it into view in
scroll mode — and marks it active. The dropdown stays in sync with
`koji:setActiveField` and with clicks on the highlights themselves
(`koji:fieldClicked`).

The values come from the [`/embed-data`](api-reference.md#get-apijobsslugdocumentsdocidembed-data)
response (each highlight carries a `value`). Hide the dropdown when your host UI
already provides field navigation:

```html
<iframe src="https://console.getkoji.dev/embed/viewer?job=JOB&doc=DOC&token=TOKEN&fieldPicker=off"></iframe>
```

> URL mode (`?url=…`) can supply the same `value` on each highlight in the
> base64 `highlights` payload to populate the picker.

### Authentication & static assets

The embed viewer is **cookieless and cross-origin by design** — it never relies
on a session cookie, so it works with third-party cookies fully blocked (Safari
ITP, Chrome). Document-mode auth is the HMAC `documentToken`:

- **Tokens are time-limited** (1 hour) and **path-scoped** — signed against
  `/api/jobs/{slug}/documents/{docId}`, so a token for one document cannot
  access another, and the document PDF + provenance are inaccessible without a
  valid, unexpired, correctly-scoped token.
- **The viewer's own static assets are served unauthenticated.** The PDF.js
  worker (`/pdf.worker.mjs`), JS/wasm chunks, fonts, and source maps are
  generic and non-sensitive, so they return `200` to an unauthenticated,
  cookieless request and never redirect to `/sign-in`. Only the document bytes
  stay gated by the token. (Previously the worker was auth-gated and 302'd to
  sign-in, so the PDF never rendered in a cross-origin iframe — that's fixed.)
- **`X-Frame-Options` is removed and `Content-Security-Policy: frame-ancestors`
  permits external origins** for `/embed/*`. By default any origin may embed
  (`frame-ancestors *`); self-hosters can restrict it to an allowlist via the
  `KOJI_EMBED_FRAME_ANCESTORS` env var (a space-separated CSP source list, e.g.
  `https://app.acme.com https://*.acme.com`).
- **No CORS configuration needed** — the iframe loads the viewer page directly,
  and the viewer fetches the PDF from its own (same) origin.

#### Token refresh for long sessions

The `documentToken` expires after 1 hour. For multi-hour review sessions, mint a
fresh token server-side (re-`GET /api/jobs/{slug}/documents/{docId}`) and push it
in with `koji:setToken` — **do not reload the iframe**. The viewer swaps the
token on its preview URL so subsequent fetches stay authorized, while the current
page and selection are preserved:

```typescript
// Every ~50 minutes, before the current token expires:
const { documentToken } = await fetchFreshTokenFromYourServer(jobSlug, docId);
iframe.contentWindow!.postMessage(
  { type: "koji:setToken", token: documentToken },
  VIEWER_ORIGIN,
);
```

### Self-hosted

If you're running Koji locally or self-hosted, replace `console.getkoji.dev` with your dashboard URL (e.g. `http://localhost:9400`):

```html
<iframe src="http://localhost:9400/embed/viewer?job=my-job&doc=DOC_ID&token=TOKEN"></iframe>
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
