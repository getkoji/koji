"""Koji Parse Service — documents in, markdown out.

Also supports extracting raw page images (base64 PNG) for the vision
bypass path (oss-79). When a document triggers vision bypass conditions,
the caller can request page images instead of (or alongside) markdown.
"""

from __future__ import annotations

import asyncio
import base64
import functools
import tempfile
import time
import traceback
from pathlib import Path

from docling.document_converter import DocumentConverter
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse

app = FastAPI(title="Koji Parse Service", version="0.1.0")

converter: DocumentConverter | None = None


def get_converter() -> DocumentConverter:
    """Lazy-load the converter on first request, not at import time."""
    global converter
    if converter is None:
        converter = DocumentConverter()
    return converter


@app.get("/health")
def health():
    return {"status": "healthy", "service": "koji-parse", "version": "0.1.0"}


def _convert_sync(file_path: str) -> dict:
    """Run conversion synchronously — called from thread pool."""
    conv = get_converter()
    result = conv.convert(file_path)
    markdown = result.document.export_to_markdown()
    return {
        "markdown": markdown,
        "pages": result.document.num_pages(),
    }


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tiff", ".tif", ".bmp", ".webp"}
IMAGE_MIMETYPES = {
    "image/jpeg",
    "image/png",
    "image/tiff",
    "image/bmp",
    "image/webp",
}


def classify_input(file_path: str, content_type: str | None = None) -> str:
    """Classify an input file into one of three categories.

    Returns:
        "image"        — input is already an image (JPEG/PNG/TIFF). Send
                         directly to vision model, no conversion needed.
        "scanned_pdf"  — PDF with no usable text layer. Render to images,
                         then send to vision model.
        "digital_pdf"  — PDF with a real text layer. Extract text natively,
                         never use vision path.
    """
    ext = Path(file_path).suffix.lower()

    # Check by extension or content type
    if ext in IMAGE_EXTENSIONS or (content_type and content_type in IMAGE_MIMETYPES):
        return "image"

    # For PDFs, check for a text layer
    if ext == ".pdf":
        return "scanned_pdf" if _is_scanned_pdf(file_path) else "digital_pdf"

    # Default: treat as digital (text-extractable)
    return "digital_pdf"


def _is_scanned_pdf(file_path: str) -> bool:
    """Check whether a PDF has a usable text layer.

    A scanned PDF has pages that are essentially images with no embedded
    text, or text so sparse it's not useful. We check by extracting text
    from the first few pages — if the total character count is very low
    relative to page count, it's scanned.
    """
    try:
        import fitz  # pymupdf

        doc = fitz.open(file_path)
        total_chars = 0
        pages_checked = min(len(doc), 3)
        for i in range(pages_checked):
            text = doc[i].get_text()
            total_chars += len(text.strip())
        doc.close()

        # Fewer than 50 chars per page = effectively no text layer
        chars_per_page = total_chars / max(pages_checked, 1)
        return chars_per_page < 50
    except ImportError:
        # No pymupdf — can't check, assume digital (safe default)
        return False
    except Exception:
        return False


def image_to_base64(file_path: str) -> list[str]:
    """Read an image file and return it as a single-element base64 list.

    For direct image inputs (JPEG/PNG/TIFF) — no conversion, just encode.
    """
    with open(file_path, "rb") as f:
        raw = f.read()
    return [base64.b64encode(raw).decode("ascii")]


def pdf_pages_to_images(file_path: str, max_pages: int = 10) -> list[str]:
    """Render PDF pages to base64 PNGs for scanned PDFs.

    Uses pymupdf (fitz). Returns a list of base64-encoded PNG strings.
    """
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
    except ImportError:
        return []
    except Exception:
        return []


def get_page_images(file_path: str, input_type: str, max_pages: int = 10) -> list[str]:
    """Get base64 page images for any input type.

    Routes to the right extraction method based on classify_input result:
      "image"       → read the file as-is
      "scanned_pdf" → render PDF pages to PNG
      "digital_pdf" → should not be called (caller uses text path)
    """
    if input_type == "image":
        return image_to_base64(file_path)
    elif input_type == "scanned_pdf":
        return pdf_pages_to_images(file_path, max_pages)
    else:
        return []


@app.post("/parse")
async def parse(file: UploadFile = File(...)):
    """Parse a document and return markdown."""
    start = time.time()

    # Write uploaded file to temp location
    suffix = Path(file.filename or "doc").suffix or ".pdf"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        # Run heavy conversion in thread pool to not block uvicorn
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            functools.partial(_convert_sync, tmp_path),
        )
        elapsed = round(time.time() - start, 2)

        return JSONResponse(
            {
                "filename": file.filename,
                "markdown": result["markdown"],
                "pages": result["pages"],
                "elapsed_seconds": elapsed,
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
