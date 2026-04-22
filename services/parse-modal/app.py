"""Koji Parse — Modal app.

Mirror of ``services/parse/main.py`` (the FastAPI + Docling service that
runs behind ``ghcr.io/getkoji/parse-base``) but packaged as a serverless
Modal function. Bytes in, ``{markdown, pages, ocr_skipped}`` out.

Parity with the docker service is the non-negotiable requirement:

- same Docling version (2.14.0) and pipeline option set
- same ``EasyOcrOptions(force_full_page_ocr=True)`` for scanned inputs
- same "digital PDF → skip OCR" heuristic via pypdfium2 text-layer probe
- same two-converter split (full-OCR / no-OCR) cached per-container

This module is the serverless surface only. The Node client adapter that
decides when to invoke Modal vs the in-cluster docker service lives in
platform (task platform-60) and calls ``parse.remote(...)`` via the JS
SDK.

Deploy: ``modal deploy app.py`` (requires ``MODAL_TOKEN_ID`` +
``MODAL_TOKEN_SECRET``). See README.md.
"""

from __future__ import annotations

import modal

# ---------------------------------------------------------------------------
# Container image
# ---------------------------------------------------------------------------
# Keep the dep set in lockstep with ``docker/parse.base.Dockerfile``. When
# you bump Docling or torch in one place, bump it in the other in the
# same PR — parity between the docker service and the Modal function is
# the whole point of this app.
#
# System packages mirror the apt-get block in parse.base.Dockerfile:
# OpenCV/docling image stack, tesseract (+ English data), poppler, image
# format libraries, base fonts, CA certs for model downloads.
#
# Torch comes from the CPU-only wheel index — CUDA builds are ~2GB
# larger and we don't need them for Docling's CPU inference path.

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install(
        "libgl1",
        "libglib2.0-0",
        "tesseract-ocr",
        "tesseract-ocr-eng",
        "poppler-utils",
        "libjpeg62-turbo",
        "libpng16-16",
        "libtiff6",
        "fonts-dejavu-core",
        "ca-certificates",
    )
    .pip_install(
        "torch==2.4.1",
        index_url="https://download.pytorch.org/whl/cpu",
    )
    .pip_install(
        "docling==2.14.0",
        "transformers==4.44.2",
        "sentencepiece==0.2.0",
        "tokenizers==0.19.1",
        "huggingface-hub==0.25.2",
        "pillow==10.4.0",
        "pypdfium2==4.30.0",
    )
    # Pre-download the Docling layout/OCR model weights at image build
    # time. Without this, the first invocation on a cold container stalls
    # for 20-40s pulling weights from HuggingFace, which defeats the
    # point of keeping a warm container.
    #
    # ``StandardPdfPipeline.download_models_hf()`` (Docling 2.x) fetches
    # the layout + tableformer weights. EasyOCR weights are fetched
    # lazily by EasyOCR itself the first time OCR runs; those get cached
    # on the first real invocation. Acceptable today — revisit if the
    # first-scan latency shows up in user-facing metrics.
    .run_commands(
        "python -c 'from docling.pipeline.standard_pdf_pipeline import "
        "StandardPdfPipeline; StandardPdfPipeline.download_models_hf()'"
    )
)

app = modal.App("koji-parse", image=image)


# ---------------------------------------------------------------------------
# Module-level converter cache
# ---------------------------------------------------------------------------
# Populated lazily on first use inside a container and reused for the
# life of that container. Same two-converter split as the docker service
# (see services/parse/main.py for the rationale — notably that
# ``force_full_page_ocr=True`` is required for fully scanned docs or
# Docling only OCRs the small bitmap regions it tags as "image content"
# and returns near-empty markdown).
_converter_full_ocr = None
_converter_no_ocr = None


def _get_converter(ocr: bool):
    """Return a cached DocumentConverter (OCR on or off)."""
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import EasyOcrOptions, PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    global _converter_full_ocr, _converter_no_ocr

    if ocr:
        if _converter_full_ocr is None:
            opts = PdfPipelineOptions(
                do_ocr=True,
                ocr_options=EasyOcrOptions(force_full_page_ocr=True),
            )
            _converter_full_ocr = DocumentConverter(
                format_options={
                    InputFormat.PDF: PdfFormatOption(pipeline_options=opts),
                },
            )
        return _converter_full_ocr

    if _converter_no_ocr is None:
        opts = PdfPipelineOptions(do_ocr=False)
        _converter_no_ocr = DocumentConverter(
            format_options={
                InputFormat.PDF: PdfFormatOption(pipeline_options=opts),
            },
        )
    return _converter_no_ocr


# ---------------------------------------------------------------------------
# Detection helpers (kept behaviorally identical to services/parse/main.py)
# ---------------------------------------------------------------------------

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tiff", ".tif", ".bmp", ".webp"}
IMAGE_MIMETYPES = {
    "image/jpeg",
    "image/png",
    "image/tiff",
    "image/bmp",
    "image/webp",
}


def _get_pdf_info(file_bytes: bytes) -> dict:
    """Quick PDF metadata: page count + text-layer detection.

    Checks the first 3 pages for extractable text and flags the doc as
    scanned if average chars/page is below 50. Identical heuristic to
    the docker service so routing decisions match.
    """
    try:
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(file_bytes)
        page_count = len(pdf)
        total_chars = 0
        for i in range(min(page_count, 3)):
            page = pdf[i]
            textpage = page.get_textpage()
            text = textpage.get_text_range()
            total_chars += len(text.strip())
            textpage.close()
            page.close()
        pdf.close()
        chars_per_page = total_chars / max(min(page_count, 3), 1)
        return {"pages": page_count, "scanned": chars_per_page < 50}
    except Exception:
        return {"pages": 0, "scanned": False}


def _is_image(filename: str, mime_type: str | None) -> bool:
    from pathlib import Path

    ext = Path(filename).suffix.lower()
    if ext in IMAGE_EXTENSIONS:
        return True
    if mime_type and mime_type in IMAGE_MIMETYPES:
        return True
    return False


def _suffix_for(filename: str, mime_type: str | None) -> str:
    """Best-effort suffix so Docling's input detection picks the right path."""
    from pathlib import Path

    ext = Path(filename).suffix.lower()
    if ext:
        return ext
    if mime_type:
        for suffix, mt in (
            (".pdf", "application/pdf"),
            (".jpg", "image/jpeg"),
            (".png", "image/png"),
            (".tiff", "image/tiff"),
            (".bmp", "image/bmp"),
            (".webp", "image/webp"),
        ):
            if mt == mime_type:
                return suffix
    return ".pdf"


def _convert_bytes(
    filename: str,
    mime_type: str | None,
    file_bytes: bytes,
) -> dict:
    """Write bytes to a tempfile and run the Docling pipeline.

    Mirrors ``_convert_sync`` in services/parse/main.py. Returns a dict
    with the fields the client expects: ``markdown``, ``pages``,
    ``ocr_skipped``.
    """
    import tempfile
    from pathlib import Path

    suffix = _suffix_for(filename, mime_type)

    # Decide OCR strategy using the same heuristic as the docker service.
    #   - images         → always OCR (force_full_page)
    #   - digital PDFs   → skip OCR (trust the text layer)
    #   - scanned PDFs   → full OCR
    #   - anything else  → run the no-OCR converter (docling handles
    #                      docx/html/pptx via its digital pipeline)
    skip_ocr = False
    if suffix == ".pdf":
        info = _get_pdf_info(file_bytes)
        skip_ocr = not info["scanned"]
    elif _is_image(filename, mime_type):
        skip_ocr = False
    else:
        skip_ocr = True

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(file_bytes)
        tmp_path = tmp.name

    try:
        conv = _get_converter(ocr=not skip_ocr)
        result = conv.convert(tmp_path)
        markdown = result.document.export_to_markdown()
        pages = result.document.num_pages()
        return {
            "markdown": markdown,
            "pages": pages,
            "ocr_skipped": skip_ocr,
        }
    finally:
        Path(tmp_path).unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Modal function
# ---------------------------------------------------------------------------
# SDK-invocable (``parse.remote(...)``) rather than a web endpoint — the
# Node client (platform-60) uses the Modal JS SDK, which is cleaner than
# HTTP for this synchronous request/response shape.
#
# ``min_containers=1`` keeps one instance warm so the first parse of the
# day doesn't pay the cold-start cost (loading torch + docling models
# into memory is ~15s even with the weights pre-baked into the image).
# Tune this after we see real traffic — for light hosted volume a
# scheduled warm-up might be cheaper than a pinned container.


@app.function(
    timeout=600,
    min_containers=1,
    memory=4096,
    cpu=2.0,
)
def parse(
    filename: str,
    mime_type: str | None,
    file_bytes: bytes,
) -> dict:
    """Parse a document and return ``{markdown, pages, ocr_skipped}``.

    Args:
        filename: Original filename (used for suffix-based format
            detection and in error messages).
        mime_type: Optional MIME type. Used as a secondary signal for
            image detection when the filename lacks an extension.
        file_bytes: Raw document bytes.

    Returns:
        ``{"markdown": str, "pages": int, "ocr_skipped": bool}`` —
        the same shape the docker service returns on its ``/parse``
        endpoint (minus ``filename`` / ``elapsed_seconds``, which the
        caller can attach itself).
    """
    return _convert_bytes(filename, mime_type, file_bytes)


# ---------------------------------------------------------------------------
# HTTP entry point for the Node API client (platform-60)
# ---------------------------------------------------------------------------
# Modal's mature SDK is Python-only — there is no stable Node client for
# remote-invoking an ``@app.function``. So we expose a thin HTTP wrapper
# here and let the platform Node API call it with a plain ``fetch``.
#
# ``requires_proxy_auth=True`` tells Modal to reject any request that is
# not carrying a valid ``Modal-Key`` / ``Modal-Secret`` header pair. The
# secrets are generated in the Modal dashboard (Settings → Proxy Auth
# Tokens) and plumbed into the API as ``MODAL_TOKEN_ID`` /
# ``MODAL_TOKEN_SECRET`` env vars — same naming the Python CLI uses for
# its own account tokens, so ops only has to learn one convention.
#
# The endpoint calls ``parse.local(...)`` rather than ``parse.remote(...)``
# so the work runs in-process inside the ``parse_http`` container instead
# of hopping to a second container. Same image, same warm converter cache
# — no extra cold-start, no extra network hop.


# Don't import starlette at module scope. ``modal deploy`` parses this
# file locally to discover functions, and the deploy machine doesn't
# need starlette on its python path — starlette + fastapi are bundled
# into the Modal runtime container (the one where ``parse_http``
# actually executes). Keep the parameter untyped so the deploy-time
# import works and let the runtime do its own resolution.


@app.function(
    timeout=600,
    min_containers=1,
    memory=4096,
    cpu=2.0,
)
@modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
async def parse_http(request):
    """HTTP wrapper around :func:`parse`.

    Accepts a multipart form with:

    - ``file`` — the document bytes (required)
    - ``filename`` — original filename (optional; falls back to ``file.filename``)
    - ``mime_type`` — optional MIME type string (falls back to ``file.content_type``)

    Returns JSON matching the docker ``/parse`` response shape:
    ``{filename, markdown, pages, elapsed_seconds, ocr_skipped}``.
    """
    import time
    import traceback

    from fastapi.responses import JSONResponse

    try:
        form = await request.form()
    except Exception as e:
        # Not JSONResponse-wrapped — Starlette renders this as plain JSON.
        return JSONResponse({"error": f"invalid form body: {e}"}, status_code=400)

    upload = form.get("file")
    if upload is None or not hasattr(upload, "read"):
        return JSONResponse(
            {"error": "missing 'file' field in multipart body"},
            status_code=400,
        )

    # Resolve the effective filename / MIME type. Prefer the explicit
    # form fields so the Node client controls them, but fall back to
    # the upload's own metadata for ad-hoc curl usage.
    filename = form.get("filename") or getattr(upload, "filename", None) or ""
    mime_type = form.get("mime_type") or getattr(upload, "content_type", None) or None

    if not filename:
        return JSONResponse(
            {"error": "missing 'filename' field in multipart body"},
            status_code=400,
        )

    start = time.time()
    try:
        file_bytes = await upload.read()
        # ``parse.local()`` invokes the same-container function directly
        # (no cross-container RPC) since we live in the same Modal app.
        result = parse.local(filename, mime_type, file_bytes)
        elapsed = round(time.time() - start, 2)
        return JSONResponse(
            {
                "filename": filename,
                "markdown": result["markdown"],
                "pages": result["pages"],
                "elapsed_seconds": elapsed,
                "ocr_skipped": result["ocr_skipped"],
            }
        )
    except Exception as e:
        print(
            f"[koji-parse-modal] error processing {filename}:\n"
            f"{traceback.format_exc()}"
        )
        return JSONResponse(
            {"error": str(e), "filename": filename},
            status_code=422,
        )


# ---------------------------------------------------------------------------
# Local entry point — ``modal run app.py --filename foo.pdf --file-bytes @foo.pdf``
# ---------------------------------------------------------------------------
# Convenience wrapper so humans can smoke-test without writing a client.
# Not used by the platform API.


@app.local_entrypoint()
def main(filename: str, file_bytes: bytes, mime_type: str | None = None):
    result = parse.remote(filename, mime_type, file_bytes)
    print(
        f"parsed {filename}: {result['pages']} pages, "
        f"ocr_skipped={result['ocr_skipped']}, "
        f"markdown={len(result['markdown'])} chars"
    )
