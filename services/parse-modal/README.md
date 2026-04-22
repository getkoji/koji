# koji-parse (Modal)

Serverless variant of `services/parse/` — the Docling-based document
parser. Same pipeline, same defaults, same output shape; deployed to
[Modal](https://modal.com) instead of run as a long-lived FastAPI
container inside a koji cluster.

Bytes in, `{markdown, pages, ocr_skipped}` out.

## When is this used?

The in-cluster docker service (`services/parse/`) stays the default for
self-hosted / enterprise deployments. The Modal app is the hosted-cloud
path — `apps/hosted/` in the platform monorepo will route parse work
here when it runs on a tenant that does not include its own parse
container (see task **platform-60** for the Node client adapter that
picks between the two at runtime).

Parity with the docker service is the whole point — same Docling
version, same `EasyOcrOptions(force_full_page_ocr=True)`, same
"digital-PDF → skip OCR" heuristic. A doc that produces N chars of
markdown from the docker service should produce the same N chars
(within trivial tolerance) from this one.

## Prerequisites

- A Modal account and the CLI:
  ```bash
  pip install modal
  modal setup   # one-time, writes ~/.modal.toml
  ```
- Or, for CI / non-interactive use, set:
  ```bash
  export MODAL_TOKEN_ID=ak-...
  export MODAL_TOKEN_SECRET=as-...
  ```
  These same env vars are what the Node client (platform-60) uses from
  the platform Worker.

## Deploy

```bash
cd koji/services/parse-modal
modal deploy app.py
```

The first build takes ~10 min — Docling + torch-cpu is a ~5 GB image
and model weights are pre-baked into the image. Subsequent deploys that
only touch Python source are seconds.

The deployed app exposes two entry points:

- **SDK function** — `modal.Function.lookup("koji-parse", "parse").remote(...)` in Python. Direct byte-in / dict-out.
- **HTTP endpoint** — `parse_http` is a `@modal.fastapi_endpoint(requires_proxy_auth=True)` wrapper around the same function. Modal prints the generated URL at deploy time (something like `https://<workspace>--koji-parse-parse-http.modal.run`). The Node API client (see `api/src/parse/modal.ts`) hits this endpoint with a multipart POST.

The HTTP endpoint is what the platform uses — Modal's Python SDK has no stable Node equivalent for remote-invoking a function, so we go through HTTP instead.

## Local smoke test

```bash
# Run the local entrypoint — uploads bytes, invokes the remote function
# against your deployed app, prints a one-line summary.
modal run app.py::main --filename sample.pdf --file-bytes @sample.pdf
```

`@sample.pdf` tells the Modal CLI to read the file as bytes and pass
those as the `file_bytes` argument. Any PDF or supported image format
works.

For ad-hoc debugging without redeploying:

```bash
modal run app.py   # builds the image, runs, tears down
```

## Function contract

```python
parse(filename: str, mime_type: str | None, file_bytes: bytes) -> dict
```

Returns:

```jsonc
{
  "markdown": "...",     // Docling-exported markdown
  "pages": 7,            // result.document.num_pages()
  "ocr_skipped": true    // true if the PDF had a usable text layer
}
```

The docker service's `/parse` endpoint returns the same fields plus
`filename` and `elapsed_seconds`. The HTTP wrapper below adds those
back in so the response shape matches the docker service 1:1.

### HTTP endpoint contract

```
POST https://<workspace>--koji-parse-parse-http.modal.run
Modal-Key: <proxy-auth-token-id>
Modal-Secret: <proxy-auth-token-secret>
Content-Type: multipart/form-data

fields:
  file       - the document bytes (required)
  filename   - original filename (required)
  mime_type  - optional MIME type
```

Returns `{filename, markdown, pages, elapsed_seconds, ocr_skipped}` on
success or `{error, filename}` with status 422 on parse failures.

#### `curl` smoke test

```bash
curl -sS -X POST "$KOJI_PARSE_MODAL_URL" \
  -H "Modal-Key: $MODAL_TOKEN_ID" \
  -H "Modal-Secret: $MODAL_TOKEN_SECRET" \
  -F "file=@sample.pdf" \
  -F "filename=sample.pdf" \
  -F "mime_type=application/pdf"
```

### Error handling

Modal surfaces exceptions from `parse.remote(...)` / `parse.local(...)`
to the caller. The HTTP wrapper (`parse_http`) catches them and returns
the 422 `{error, filename}` shape the docker `/parse` endpoint uses, so
the Node adapter can treat both providers identically.

## Wiring the API

The platform API (`koji/api`) reads these env vars:

| Var | Meaning |
|-----|---------|
| `KOJI_PARSE_BACKEND=modal` | Switch the factory to `ModalParseProvider`. Default is `docker`. |
| `KOJI_PARSE_MODAL_URL` | The `parse_http` endpoint URL printed by `modal deploy`. |
| `MODAL_TOKEN_ID` | Proxy-auth token ID, sent as `Modal-Key` header. |
| `MODAL_TOKEN_SECRET` | Proxy-auth token secret, sent as `Modal-Secret` header. |

Deploy flow:

1. `modal deploy app.py` — builds the image, pushes the functions, prints the `parse-http` URL.
2. Copy that URL into `KOJI_PARSE_MODAL_URL` in the API's env (Cloudflare Worker secret / `.env` / etc.).
3. Create a proxy-auth token in the Modal dashboard (Settings → Proxy Auth Tokens) and set `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` to the generated values. These are **not** the same as the CLI account tokens — proxy-auth tokens are specifically for protecting web endpoints.
4. Restart the API.

## Tuning

- `timeout=600` — max 10 min per parse. A 100-page scanned PDF at full
  OCR takes ~2 min on the default container; 10 min is a safe ceiling.
- `min_containers=1` — keeps one container warm so the first parse
  of the day doesn't pay the 15-30 s torch+docling load cost. If
  hosted traffic is spiky or low-volume, consider dropping this and
  using a scheduled warmup ping instead — compare $$ after a week of
  real usage.
- `memory=4096`, `cpu=2.0` — tuned for single-document Docling at CPU
  inference. OCR on long documents is CPU-bound; bump `cpu` first if
  p95 latency regresses.

## Secrets

None today. Docling runs locally inside the container; no outbound API
calls. If a future change adds one (e.g. upload parsed markdown to
object storage, call a cloud OCR service), create the secret in the
Modal dashboard and attach it via `modal.Secret.from_name("...")` on
the `@app.function(...)` decorator — do not read secrets from env at
runtime.

## Keeping parity with the docker service

When you change anything in this file, check whether the docker service
needs the matching change. The dep pins and pipeline options must stay
in lockstep:

| Pinned in | Also pinned in |
|-----------|----------------|
| `app.py` `image` | `docker/parse.base.Dockerfile` |
| `app.py` `_get_converter` | `services/parse/main.py` `get_converter` |

A PR that bumps Docling in one place and not the other will silently
produce different markdown on Modal vs docker for the same document —
that is exactly the bug we cannot afford to ship, since downstream
extraction depends on markdown shape being stable.
