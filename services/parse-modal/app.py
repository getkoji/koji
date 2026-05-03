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
# Torch comes from the default CUDA wheel — we run on L4 GPUs for the
# Docling + EasyOCR inference path. EasyOCR auto-detects CUDA via
# ``torch.cuda.is_available()``. The CUDA build is ~2GB larger than
# the CPU build but Modal caches image layers so the cost is a
# one-time pull, not per-deploy.

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
    # One pip_install call so pip's resolver sees every pin at once.
    # The previous two-step install let docling's transitive deps
    # upgrade torch from 2.4.1 to 2.11 (which ships CUDA-13 kernels
    # and misses `libnvrtc-builtins.so.13.0` on L4), making every
    # invocation fail at the first torch kernel launch.
    #
    # Use the cu121 wheel index so torch bundles its own CUDA 12.1
    # runtime libs (Modal L4 containers speak that ABI). Keeping
    # torchvision and torchaudio pinned too so the resolver doesn't
    # pull in a mismatched set.
    .pip_install(
        "torch==2.4.1",
        "torchvision==0.19.1",
        "docling==2.14.0",
        "transformers==4.44.2",
        "sentencepiece==0.2.0",
        "tokenizers==0.19.1",
        "huggingface-hub==0.25.2",
        "pillow==10.4.0",
        "pypdfium2==4.30.0",
        "pdfplumber==0.11.4",
        # Required by @modal.fastapi_endpoint. Modal 1.x removed the
        # implicit fastapi install from runtime images; web endpoints
        # now have to declare it themselves. `fastapi[standard]` pulls
        # the common extras (uvicorn, python-multipart for form bodies,
        # etc.) that the endpoint actually uses.
        "fastapi[standard]==0.115.6",
        extra_index_url="https://download.pytorch.org/whl/cu121",
    )
    # Pre-download model weights at image build time so cold starts
    # don't stall pulling from HuggingFace or EasyOCR's weight host
    # mid-request — the latter is the one that actually matters in
    # production because its download host has been flaky (connection
    # reset mid-fetch → first scanned-PDF invocation 422s).
    #
    # Docling: ``StandardPdfPipeline.download_models_hf()`` grabs the
    # layout + tableformer weights. EasyOCR: instantiating a
    # ``Reader(['en'])`` triggers the detector + recognizer download.
    # We bake both into the image so the first scanned-PDF invocation
    # is compute-only, not network-bound.
    .run_commands(
        "python -c 'from docling.pipeline.standard_pdf_pipeline import "
        "StandardPdfPipeline; StandardPdfPipeline.download_models_hf()'",
        "python -c 'import easyocr; easyocr.Reader([\"en\"], gpu=False, download_enabled=True)'",
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


def _build_text_map(document) -> list[dict]:
    """Extract text segments with normalized bounding boxes from a DoclingDocument.

    Returns a flat list of {text, page, bbox: {x, y, w, h}} where coordinates
    are fractions of the page dimensions (0.0-1.0).
    """
    try:
        from docling_core.types.doc.base import CoordOrigin

        segments: list[dict] = []
        for item, _level in document.iterate_items():
            text = getattr(item, "text", None)
            if not text:
                continue
            for prov in item.prov or []:
                page_no = prov.page_no
                page = document.pages.get(page_no)
                if page is None or page.size is None:
                    continue
                pw, ph = page.size.width, page.size.height
                if pw <= 0 or ph <= 0:
                    continue
                bbox = prov.bbox
                if bbox.coord_origin == CoordOrigin.BOTTOMLEFT:
                    bbox = bbox.to_top_left_origin(ph)
                segments.append(
                    {
                        "text": text,
                        "page": page_no,
                        "bbox": {
                            "x": round(bbox.l / pw, 6),
                            "y": round(bbox.t / ph, 6),
                            "w": round((bbox.r - bbox.l) / pw, 6),
                            "h": round((bbox.b - bbox.t) / ph, 6),
                        },
                    }
                )
        return segments
    except Exception as e:
        print(f"[koji-parse-modal] Warning: failed to build text_map: {e}")
        return []


def _convert_bytes(
    filename: str,
    mime_type: str | None,
    file_bytes: bytes,
) -> dict:
    """Write bytes to a tempfile and run the Docling pipeline.

    Mirrors ``_convert_sync`` in services/parse/main.py. Returns a dict
    with the fields the client expects: ``markdown``, ``pages``,
    ``ocr_skipped``, ``text_map``.
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
            "text_map": _build_text_map(result.document),
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
# GPU-backed: Docling + EasyOCR are 10-30x faster on an L4 than on
# CPU for scanned-PDF workloads. ``min_containers`` intentionally
# unset (defaults to 0) — L4s cost ~$0.80/hr idle, so we scale to
# zero between jobs and accept a ~20-30s cold start on the first
# invocation. Flip to ``min_containers=1`` when we have real demo
# traffic worth pinning a warm container for.


@app.function(
    gpu="L4",
    timeout=600,
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


# Need the ``Request`` type on the endpoint signature — FastAPI inspects
# parameter annotations at route-registration time to decide "is this the
# request body?" vs "is this a query param?". Without the annotation it
# falls through to query-param injection and every call 422s with
# ``{"detail":[{"type":"missing","loc":["query","request"]}]}``.
#
# Import from ``fastapi`` (not ``starlette``) — FastAPI's param-source
# detector matches on the fully-qualified ``fastapi.Request`` class and
# doesn't always recognise the raw ``starlette.requests.Request`` even
# though they are the same underlying type. Using ``fastapi.Request``
# is the documented path.
#
# ``modal deploy`` imports this module locally, so ``fastapi`` has to
# be importable on the deploy machine (`pip install fastapi`). The
# Modal runtime container already has it via the image's
# ``fastapi[standard]`` pin.
from fastapi import Request  # noqa: E402


@app.function(
    gpu="L4",
    timeout=600,
    memory=4096,
    cpu=2.0,
)
@modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
async def parse_http(request: Request):
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
                "text_map": result.get("text_map", []),
            }
        )
    except Exception as e:
        print(f"[koji-parse-modal] error processing {filename}:\n{traceback.format_exc()}")
        return JSONResponse(
            {"error": str(e), "filename": filename},
            status_code=422,
        )


# ---------------------------------------------------------------------------
# Coordinate extraction endpoint — reads text at PDF coordinates
# ---------------------------------------------------------------------------


def _extract_words_in_box(page, x0: float, y0: float, x1: float, y1: float) -> str:
    """Extract text from a PDF page region using word-level spatial filtering.

    Instead of page.crop().extract_text() which garbles text in form PDFs
    with overlapping text layers, this:
    1. Gets all words with their coordinates
    2. Filters to words whose center falls inside the box
    3. Groups into lines by Y proximity
    4. Sorts left-to-right within each line
    5. Joins into clean multi-line text
    """
    words = page.extract_words(keep_blank_chars=False, extra_attrs=["top", "bottom"])

    # Filter words whose center point falls inside the box
    inside = []
    for w in words:
        cx = (w["x0"] + w["x1"]) / 2
        cy = (w["top"] + w["bottom"]) / 2
        if x0 <= cx <= x1 and y0 <= cy <= y1:
            inside.append(w)

    if not inside:
        return ""

    # Sort by vertical position first
    inside.sort(key=lambda w: (w["top"], w["x0"]))

    # Group into lines: words within 3px vertical distance are same line
    lines: list[list] = []
    current_line: list = [inside[0]]
    for w in inside[1:]:
        if abs(w["top"] - current_line[0]["top"]) < 3:
            current_line.append(w)
        else:
            lines.append(current_line)
            current_line = [w]
    lines.append(current_line)

    # Sort each line left-to-right and join
    result_lines = []
    for line in lines:
        line.sort(key=lambda w: w["x0"])
        result_lines.append(" ".join(w["text"] for w in line))

    return "\n".join(result_lines)


@app.function(
    timeout=60,
    memory=512,
    cpu=1.0,
)
@modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
async def extract_coordinates(request: Request):
    """Extract text at specified PDF coordinates using pdfplumber.

    Accepts multipart form with:
    - ``file`` — the PDF bytes
    - ``mappings`` — JSON string of field → {page, x, y, w, h} mappings
    """
    import json
    import tempfile
    from pathlib import Path

    import pdfplumber
    from fastapi.responses import JSONResponse

    try:
        form = await request.form()
    except Exception as e:
        return JSONResponse({"error": f"invalid form body: {e}"}, status_code=400)

    upload = form.get("file")
    if upload is None or not hasattr(upload, "read"):
        return JSONResponse({"error": "missing 'file' field"}, status_code=400)

    mappings_str = form.get("mappings")
    if not mappings_str:
        return JSONResponse({"error": "mappings JSON is required"}, status_code=400)

    try:
        field_mappings = json.loads(str(mappings_str))
    except json.JSONDecodeError:
        return JSONResponse({"error": "Invalid mappings JSON"}, status_code=400)

    file_bytes = await upload.read()

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(file_bytes)
        tmp_path = tmp.name

    try:
        result = {}
        has_text = True

        with pdfplumber.open(tmp_path) as pdf:
            if pdf.pages:
                first_page_text = pdf.pages[0].extract_text() or ""
                if len(first_page_text.strip()) < 20:
                    has_text = False

            if not has_text:
                return JSONResponse(
                    {
                        "warning": "This PDF appears to be scanned. Coordinate-based extraction requires a digital PDF with a text layer.",
                        "extracted": {},
                        "has_text_layer": False,
                    }
                )

            for field_name, mapping in field_mappings.items():
                page_num = mapping.get("page", 1)
                if page_num < 1 or page_num > len(pdf.pages):
                    result[field_name] = {
                        "value": None,
                        "error": f"Page {page_num} out of range",
                    }
                    continue

                page = pdf.pages[page_num - 1]
                pw, ph = float(page.width), float(page.height)

                x0 = mapping["x"] * pw
                y0 = mapping["y"] * ph
                x1 = (mapping["x"] + mapping["w"]) * pw
                y1 = (mapping["y"] + mapping["h"]) * ph

                try:
                    text = _extract_words_in_box(page, x0, y0, x1, y1)
                    result[field_name] = {
                        "value": text if text else None,
                        "page": page_num,
                        "bbox": {
                            "x": mapping["x"],
                            "y": mapping["y"],
                            "w": mapping["w"],
                            "h": mapping["h"],
                        },
                    }
                except Exception as e:
                    result[field_name] = {"value": None, "error": str(e)}

        return JSONResponse(
            {
                "extracted": result,
                "has_text_layer": has_text,
                "pages": len(pdfplumber.open(tmp_path).pages),
            }
        )
    finally:
        Path(tmp_path).unlink(missing_ok=True)


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
