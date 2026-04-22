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
# one-time on the deploy machine — fastapi has to be importable
# locally because `modal deploy` parses app.py before uploading (the
# endpoint's type annotation references fastapi.Request).
pip install modal fastapi

cd koji/services/parse-modal
modal deploy app.py
```

The first build takes ~10 min — Docling + torch-cu121 is a ~7 GB image
and model weights (Docling layout/tableformer + EasyOCR detector/
recognizer) are pre-baked into the image so runtime invocations never
hit the network for weights. Subsequent deploys that only touch Python
source rebuild in seconds off cached layers.

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

### 303 polling for long parses

Modal's `fastapi_endpoint` proxy has a 150 s response-write deadline.
If the function is still running when that deadline hits, Modal
returns `303 See Other` with a `Location` header pointing at the same
URL + a `?__modal_function_call_id=fc-...` query param. The client is
expected to follow that redirect (as a GET) to keep polling until the
function settles — and subsequent poll responses can themselves be
303s that the client must keep following.

`api/src/parse/modal.ts` (the Node client) handles this manually with
`redirect: "manual"` + a poll loop that reattaches the `Modal-Key` /
`Modal-Secret` headers on every hop. Don't replace it with fetch's
default redirect-follow — default redirect follow drops auth headers
across the 303 → GET transition and the subsequent hops will 401.

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

- `gpu="L4"` — Docling + EasyOCR run 10-30× faster on an L4 than on CPU
  for scanned-PDF OCR workloads. L4 ($0.80/hr) is the price/perf sweet
  spot; drop to `T4` ($0.59/hr) if latency allows, upgrade to `A10G`
  ($1.10/hr) only if throughput is the bottleneck.
- `timeout=600` — max 10 min per parse. A 232-page scanned PDF through
  full OCR on L4 finishes in ~50s; 10 min is a safe ceiling for
  worst-case cold-start + enormous doc.
- **No `min_containers` pinned.** Defaults to 0 → container scales to
  zero when idle. L4s idle at ~$0.80/hr, which is ~$580/mo for a
  pinned warm container. First call after idle eats a ~20-30 s cold
  start (L4 boot + CUDA init + Docling model load from baked image).
  Flip to `min_containers=1` temporarily around a demo or under known
  load, then revert.
- `memory=4096`, `cpu=2.0` — paired with the L4 for Docling's GPU +
  CPU pre/post-processing. Bump if OOMing on very large PDFs.

## Secrets

None today. Docling runs locally inside the container; no outbound API
calls. If a future change adds one (e.g. upload parsed markdown to
object storage, call a cloud OCR service), create the secret in the
Modal dashboard and attach it via `modal.Secret.from_name("...")` on
the `@app.function(...)` decorator — do not read secrets from env at
runtime.

## Troubleshooting

### `modal deploy` fails with `ModuleNotFoundError: No module named 'fastapi'`

`modal deploy` imports `app.py` locally before uploading so it can
enumerate the `@app.function` and `@modal.fastapi_endpoint` decorators.
The endpoint's signature references `fastapi.Request`, so fastapi has
to be importable on the deploy machine. Fix:

```bash
pip install modal fastapi
```

The Modal runtime container already has fastapi via the image's
`fastapi[standard]` pin — this is purely a build-time concern.

### First runtime invocation 422s with `<urlopen error [Errno 104] Connection reset by peer>`

A model download is hitting the network mid-request. All weights are
supposed to be baked into the image by the `run_commands` step that
calls `StandardPdfPipeline.download_models_hf()` and
`easyocr.Reader(["en"])`. If a new model class gets added to the
Docling pipeline and nobody updates that preload step, the first
runtime invocation that triggers it will try to download mid-request
and fail. Add the new download to the `run_commands` list and redeploy.

### Runtime crashes with `nvrtc: error: failed to open libnvrtc-builtins.so.13.0`

torch's CUDA version doesn't match the Modal L4's CUDA runtime. The
image pins torch against the cu121 wheel index
(`extra_index_url="https://download.pytorch.org/whl/cu121"`), which
bundles CUDA 12.1 runtime libs that work on L4. If you change torch
pins, keep the extra_index_url in sync or torch will pull a wheel with
mismatched CUDA libs. Also: pin `torchvision` (and `torchaudio` if you
add it) — otherwise pip's resolver is free to upgrade torch under the
hood to a version that doesn't match your pins.

### Parses that complete server-side but the client reports "bad redirect method"

Modal returned a 303 after its 150 s proxy deadline and the client
couldn't follow it correctly — usually because it's using fetch's
default redirect-follow, which 307/308s with preserved POST method
eventually return a response the client rejects. Use the manual-redirect
polling loop in `api/src/parse/modal.ts` as the reference
implementation.

### Cold start takes 30-60 s every invocation

L4 idle with `min_containers=0` scales to zero between jobs. Cold
start includes: L4 allocation (~10 s), CUDA init (~5 s), Docling model
load from the baked image (~10 s), EasyOCR reader warm-up (~5 s). If
the cold-start cost is unacceptable for an imminent use (demo,
benchmark), flip `min_containers=1` temporarily and revert once done.

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
