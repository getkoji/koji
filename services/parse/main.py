"""Koji Parse Service — documents in, markdown out."""

from __future__ import annotations

import asyncio
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

        return JSONResponse({
            "filename": file.filename,
            "markdown": result["markdown"],
            "pages": result["pages"],
            "elapsed_seconds": elapsed,
        })
    except Exception as e:
        tb = traceback.format_exc()
        print(f"[koji-parse] Error processing {file.filename}:\n{tb}")
        return JSONResponse(
            {"error": str(e), "filename": file.filename},
            status_code=422,
        )
    finally:
        Path(tmp_path).unlink(missing_ok=True)
