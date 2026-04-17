"""Koji serve — stateless HTTP wrapper around the extraction engine.

Exposes three endpoints:
  POST /extract  — multipart (file + schema YAML) → extraction result
  GET  /health   — liveness check
  POST /schemas/compile — validate and parse a schema YAML

This is the integration seam between the OSS core and the hosted
platform. The platform's Containers runtime calls this server to run
extraction. No auth, no rate limiting, no persistence — just bytes in,
structured data out.
"""

from __future__ import annotations

import asyncio
import functools
import tempfile
import time
import traceback
from pathlib import Path

import yaml
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI(
    title="Koji Extraction Server",
    description="Stateless extraction endpoint for platform integration.",
    version="0.1.0",
)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


@app.get("/health")
def health():
    return {"ok": True, "version": "0.1.0"}


# ---------------------------------------------------------------------------
# Schema compile
# ---------------------------------------------------------------------------


class CompileRequest(BaseModel):
    content: str


@app.post("/schemas/compile")
def compile_schema(req: CompileRequest):
    """Parse and validate a schema YAML without running extraction."""
    try:
        schema_def = yaml.safe_load(req.content)
    except yaml.YAMLError as e:
        return JSONResponse(
            {"error": "Invalid YAML", "detail": str(e)},
            status_code=422,
        )

    if not isinstance(schema_def, dict):
        return JSONResponse(
            {"error": "Schema must be a YAML mapping", "detail": f"Got {type(schema_def).__name__}"},
            status_code=422,
        )

    fields = schema_def.get("fields", {})
    if not isinstance(fields, dict):
        return JSONResponse(
            {"error": "Schema 'fields' must be a mapping", "detail": f"Got {type(fields).__name__}"},
            status_code=422,
        )

    compiled_fields = []
    for name, spec in fields.items():
        field_info = {"name": name}
        if isinstance(spec, dict):
            field_info["type"] = spec.get("type", "string")
            field_info["required"] = spec.get("required", False)
            field_info["description"] = spec.get("description")
            if "aliases" in spec:
                field_info["aliases"] = spec["aliases"]
            if "items" in spec:
                field_info["items"] = spec["items"]
        compiled_fields.append(field_info)

    return {
        "name": schema_def.get("name"),
        "version": schema_def.get("version"),
        "fields": compiled_fields,
        "field_count": len(compiled_fields),
        "valid": True,
    }


# ---------------------------------------------------------------------------
# Extract — the core endpoint
# ---------------------------------------------------------------------------


@app.post("/extract")
async def extract(
    file: UploadFile = File(...),
    schema: str = Form(...),
):
    """Parse a document and extract structured data using the given schema.

    Accepts multipart form data:
      - file: the document (PDF, image, etc.)
      - schema: the schema YAML as a string

    Returns the extraction result with per-field confidence and trace
    metadata.
    """
    start = time.time()

    # Parse the schema
    try:
        schema_def = yaml.safe_load(schema)
    except yaml.YAMLError as e:
        return JSONResponse(
            {"error": "Invalid schema YAML", "detail": str(e)},
            status_code=400,
        )

    if not isinstance(schema_def, dict):
        return JSONResponse(
            {"error": "Schema must be a YAML mapping"},
            status_code=400,
        )

    content = await file.read()
    filename = file.filename or "document"

    # Step 1: Parse the document to markdown
    try:
        parse_result = await _parse_document(content, filename)
    except Exception as e:
        return JSONResponse(
            {"error": "Parse failed", "detail": str(e)},
            status_code=500,
        )

    markdown = parse_result.get("markdown", "")
    if not markdown:
        return JSONResponse(
            {"error": "No text extracted from document"},
            status_code=422,
        )

    # Step 2: Run extraction
    try:
        from services.extract.pipeline import intelligent_extract

        extract_result = await intelligent_extract(
            markdown,
            schema_def,
            model=None,  # uses default
        )
    except Exception as e:
        return JSONResponse(
            {"error": "Extraction failed", "detail": str(e), "traceback": traceback.format_exc()},
            status_code=500,
        )

    # Step 3: Apply post-processing (normalize + validate)
    try:
        from services.extract.main import _apply_post_extract

        _apply_post_extract(extract_result, schema_def)
    except Exception:
        pass  # non-fatal — return raw result if post-processing fails

    elapsed_s = round(time.time() - start, 3)

    return {
        "filename": filename,
        "pages": parse_result.get("pages"),
        "result": extract_result.get("extracted"),
        "confidence": extract_result.get("confidence"),
        "confidence_scores": extract_result.get("confidence_scores"),
        "model": extract_result.get("model"),
        "elapsed_seconds": elapsed_s,
        "trace": {
            "parse_seconds": parse_result.get("elapsed_seconds"),
            "extract_ms": extract_result.get("elapsed_ms"),
            "total_seconds": elapsed_s,
            "stages": [
                {"name": "parse", "duration_ms": round((parse_result.get("elapsed_seconds", 0)) * 1000)},
                {"name": "extract", "duration_ms": extract_result.get("elapsed_ms", 0)},
            ],
        },
    }


async def _parse_document(content: bytes, filename: str) -> dict:
    """Parse a document to markdown using the parse service's converter."""
    from services.parse.main import _convert_sync

    with tempfile.NamedTemporaryFile(suffix=Path(filename).suffix, delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    start = time.time()
    try:
        result = await asyncio.get_event_loop().run_in_executor(
            None, functools.partial(_convert_sync, tmp_path)
        )
        result["elapsed_seconds"] = round(time.time() - start, 3)
        result["filename"] = filename
        return result
    finally:
        Path(tmp_path).unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Server runner
# ---------------------------------------------------------------------------


def run_server(port: int = 9000) -> None:
    """Start the extraction server on the given port."""
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=port)
