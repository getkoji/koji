"""Koji Parse Service — documents in, markdown out."""

from __future__ import annotations

import tempfile
import time
from pathlib import Path

from docling.document_converter import DocumentConverter
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse

app = FastAPI(title="Koji Parse Service", version="0.1.0")

converter = DocumentConverter()


@app.get("/health")
def health():
    return {"status": "healthy", "service": "koji-parse", "version": "0.1.0"}


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
        result = converter.convert(tmp_path)
        markdown = result.document.export_to_markdown()
        elapsed = round(time.time() - start, 2)

        return JSONResponse({
            "filename": file.filename,
            "markdown": markdown,
            "pages": result.document.num_pages(),
            "elapsed_seconds": elapsed,
        })
    except Exception as e:
        return JSONResponse(
            {"error": str(e), "filename": file.filename},
            status_code=422,
        )
    finally:
        Path(tmp_path).unlink(missing_ok=True)
