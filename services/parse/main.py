"""Koji Parse Service — documents in, markdown out.

Smart routing: digital PDFs skip OCR for 3-5x speedup.
SSE progress streaming for long-running parses.
"""

from __future__ import annotations

import asyncio
import base64
import functools
import json
import tempfile
import time
import traceback
from pathlib import Path

import pypdfium2 as pdfium
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse

app = FastAPI(title="Koji Parse Service", version="0.1.0")

# Two converters: one with OCR, one without
_converter_ocr: DocumentConverter | None = None
_converter_no_ocr: DocumentConverter | None = None


def get_converter(ocr: bool = True) -> DocumentConverter:
    """Lazy-load converters on first use."""
    global _converter_ocr, _converter_no_ocr

    if ocr:
        if _converter_ocr is None:
            _converter_ocr = DocumentConverter()
        return _converter_ocr
    else:
        if _converter_no_ocr is None:
            opts = PdfPipelineOptions(do_ocr=False)
            _converter_no_ocr = DocumentConverter(
                format_options={
                    InputFormat.PDF: PdfFormatOption(pipeline_options=opts),
                },
            )
        return _converter_no_ocr


# ── Detection helpers ────────────────────────────────────────────────────


def get_pdf_info(file_bytes: bytes) -> dict:
    """Quick PDF metadata: page count + text layer detection.

    Uses pypdfium2 (already bundled with docling, no conflicts).
    Checks first 3 pages for extractable text.
    Returns: {"pages": int, "scanned": bool}
    """
    try:
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


def estimate_seconds(pages: int, scanned: bool) -> float:
    """Rough estimate of parse time."""
    per_page = 1.3 if scanned else 0.3
    return round(pages * per_page, 1)


# ── Conversion ───────────────────────────────────────────────────────────


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tiff", ".tif", ".bmp", ".webp"}
IMAGE_MIMETYPES = {"image/jpeg", "image/png", "image/tiff", "image/bmp", "image/webp"}


def classify_input(file_path: str, content_type: str | None = None) -> str:
    ext = Path(file_path).suffix.lower()
    if ext in IMAGE_EXTENSIONS or (content_type and content_type in IMAGE_MIMETYPES):
        return "image"
    if ext == ".pdf":
        with open(file_path, "rb") as f:
            info = get_pdf_info(f.read())
        return "scanned_pdf" if info["scanned"] else "digital_pdf"
    return "digital_pdf"


def _convert_sync(file_path: str, skip_ocr: bool = False) -> dict:
    """Run conversion synchronously — called from thread pool."""
    conv = get_converter(ocr=not skip_ocr)
    result = conv.convert(file_path)
    markdown = result.document.export_to_markdown()
    return {
        "markdown": markdown,
        "pages": result.document.num_pages(),
    }


def image_to_base64(file_path: str) -> list[str]:
    with open(file_path, "rb") as f:
        raw = f.read()
    return [base64.b64encode(raw).decode("ascii")]


def pdf_pages_to_images(file_path: str, max_pages: int = 10) -> list[str]:
    try:
        import fitz

        doc = fitz.open(file_path)
        images = []
        for page_num in range(min(len(doc), max_pages)):
            page = doc[page_num]
            pix = page.get_pixmap(dpi=150)
            img_bytes = pix.tobytes("png")
            images.append(base64.b64encode(img_bytes).decode("ascii"))
        doc.close()
        return images
    except (ImportError, Exception):
        return []


def get_page_images(file_path: str, input_type: str, max_pages: int = 10) -> list[str]:
    if input_type == "image":
        return image_to_base64(file_path)
    elif input_type == "scanned_pdf":
        return pdf_pages_to_images(file_path, max_pages)
    return []


# ── Endpoints ────────────────────────────────────────────────────────────


@app.get("/health")
def health():
    return {"status": "healthy", "service": "koji-parse", "version": "0.1.0"}


@app.post("/parse")
async def parse(file: UploadFile = File(...)):
    """Parse a document and return markdown (non-streaming)."""
    start = time.time()

    suffix = Path(file.filename or "doc").suffix or ".pdf"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        # Detect PDF type
        skip_ocr = False
        info = {"pages": 0, "scanned": False}
        if suffix.lower() == ".pdf":
            info = get_pdf_info(content)
            skip_ocr = not info["scanned"]
            mode = "digital (OCR skipped)" if skip_ocr else "scanned (full OCR)"
            print(f"[koji-parse] {file.filename}: {info['pages']} pages, {mode}")

        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            functools.partial(_convert_sync, tmp_path, skip_ocr=skip_ocr),
        )
        elapsed = round(time.time() - start, 2)

        return JSONResponse(
            {
                "filename": file.filename,
                "markdown": result["markdown"],
                "pages": result["pages"],
                "elapsed_seconds": elapsed,
                "ocr_skipped": skip_ocr,
            }
        )
    except Exception as e:
        tb = traceback.format_exc()
        print(f"[koji-parse] Error processing {file.filename}:\n{tb}")
        return JSONResponse(
            {"error": str(e), "filename": file.filename},
            status_code=422,
        )
    finally:
        Path(tmp_path).unlink(missing_ok=True)


@app.post("/parse/stream")
async def parse_stream(file: UploadFile = File(...)):
    """Parse a document with SSE progress updates."""
    suffix = Path(file.filename or "doc").suffix or ".pdf"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    # Quick detection phase
    skip_ocr = False
    info = {"pages": 0, "scanned": False}
    if suffix.lower() == ".pdf":
        info = get_pdf_info(content)
        skip_ocr = not info["scanned"]
        mode = "digital (OCR skipped)" if skip_ocr else "scanned (full OCR)"
        print(f"[koji-parse] {file.filename}: {info['pages']} pages, {mode}")

    estimated = estimate_seconds(info["pages"], info["scanned"])

    async def event_generator():
        start = time.time()

        # Send detection results immediately
        yield {
            "event": "started",
            "data": json.dumps(
                {
                    "filename": file.filename,
                    "pages": info["pages"],
                    "scanned": info["scanned"],
                    "ocr_skipped": skip_ocr,
                    "estimated_seconds": estimated,
                }
            ),
        }

        # Run conversion in background thread
        loop = asyncio.get_event_loop()
        future = loop.run_in_executor(
            None,
            functools.partial(_convert_sync, tmp_path, skip_ocr=skip_ocr),
        )

        # Stream estimated progress while waiting
        poll_interval = 2.0
        while not future.done():
            elapsed = time.time() - start
            if estimated > 0:
                percent = min(int((elapsed / estimated) * 100), 95)
                remaining = max(estimated - elapsed, 0)
                est_page = min(int((elapsed / estimated) * info["pages"]), info["pages"])
            else:
                percent = 50
                remaining = 0
                est_page = 0

            yield {
                "event": "progress",
                "data": json.dumps(
                    {
                        "page": est_page,
                        "total": info["pages"],
                        "percent": percent,
                        "elapsed_seconds": round(elapsed, 1),
                        "estimated_remaining_seconds": round(remaining, 1),
                    }
                ),
            }

            await asyncio.sleep(poll_interval)

        # Get result
        try:
            result = future.result()
            elapsed = round(time.time() - start, 2)

            yield {
                "event": "complete",
                "data": json.dumps(
                    {
                        "filename": file.filename,
                        "markdown": result["markdown"],
                        "pages": result["pages"],
                        "elapsed_seconds": elapsed,
                        "ocr_skipped": skip_ocr,
                    }
                ),
            }
        except Exception as e:
            yield {
                "event": "error",
                "data": json.dumps({"error": str(e)}),
            }
        finally:
            Path(tmp_path).unlink(missing_ok=True)

    return EventSourceResponse(event_generator())
