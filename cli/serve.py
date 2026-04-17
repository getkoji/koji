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

    Three extraction paths based on input type:

      image (JPEG/PNG/TIFF) → vision model directly (no OCR)
      scanned PDF (no text) → render pages to images → vision model
      digital PDF (text)    → native text extraction → LLM extraction

    The routing happens in preflight, not after OCR. A JPEG never touches
    the parse/OCR pipeline. A digital PDF never touches the vision model.

    The schema's `ocr.vision_bypass` config controls whether vision bypass
    is enabled and under what conditions for scanned PDFs. Image inputs
    always use the vision path when bypass is enabled — they have no text
    to fall back to.
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
    content_type = file.content_type or ""

    # Write to temp file for classification and processing
    suffix = Path(filename).suffix or ".pdf"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    try:
        return await _route_and_extract(
            tmp_path,
            filename,
            content_type,
            content,
            schema_def,
            start,
        )
    finally:
        Path(tmp_path).unlink(missing_ok=True)


async def _route_and_extract(
    tmp_path: str,
    filename: str,
    content_type: str,
    content: bytes,
    schema_def: dict,
    start: float,
) -> JSONResponse | dict:
    """Classify input and route to the correct extraction path."""
    from services.extract.providers import create_provider
    from services.extract.vision import (
        VisionBypassConfig,
        estimate_ocr_confidence,
        should_bypass,
        vision_extract,
    )
    from services.parse.main import classify_input, get_page_images

    # Step 1: Classify the input
    input_type = classify_input(tmp_path, content_type)
    ocr_config = schema_def.get("ocr", {})
    bypass_config = VisionBypassConfig.from_dict(
        ocr_config.get("vision_bypass") if isinstance(ocr_config, dict) else None
    )

    use_vision = False
    bypass_reason: str | None = None
    ocr_confidence: float | None = None
    parse_result: dict | None = None

    if input_type == "image":
        # Image input: always use vision path (there's no text to extract)
        if bypass_config.enabled:
            use_vision = True
            bypass_reason = f"input_type=image ({Path(filename).suffix})"
        else:
            # Vision not enabled — try to OCR the image via parse
            parse_result = await _parse_document(content, filename)
            ocr_confidence = estimate_ocr_confidence(
                parse_result.get("markdown", ""),
                parse_result.get("pages", 1),
            )

    elif input_type == "scanned_pdf":
        # Scanned PDF: vision bypass if enabled + conditions met
        if bypass_config.enabled:
            # For scanned PDFs, try parse first to get OCR confidence
            parse_result = await _parse_document(content, filename)
            markdown = parse_result.get("markdown", "")
            page_count = parse_result.get("pages", 0)
            ocr_confidence = estimate_ocr_confidence(markdown, page_count)

            do_bypass, reason = should_bypass(
                page_count,
                ocr_confidence,
                schema_def,
                bypass_config,
            )
            if do_bypass:
                use_vision = True
                bypass_reason = reason
        else:
            parse_result = await _parse_document(content, filename)

    else:
        # Digital PDF: always use text path (native text, perfect accuracy)
        parse_result = await _parse_document(content, filename)
        bypass_reason = None

    # Route to the correct extraction path
    if use_vision:
        page_images = get_page_images(tmp_path, input_type, max_pages=bypass_config.max_pages)
        if not page_images:
            # Failed to get images — fall back to text
            use_vision = False
            if parse_result is None:
                parse_result = await _parse_document(content, filename)

    extract_result: dict
    trace_stages: list[dict] = []

    if parse_result:
        trace_stages.append(
            {
                "name": "parse",
                "duration_ms": round((parse_result.get("elapsed_seconds", 0)) * 1000),
                "input_type": input_type,
            }
        )

    if use_vision:
        # Vision extraction
        model_str = (
            schema_def.get("model")
            or (ocr_config.get("model") if isinstance(ocr_config, dict) else None)
            or "openai/gpt-4o-mini"
        )
        provider = create_provider(model_str)

        try:
            extract_result = await vision_extract(page_images, schema_def, provider)
        except Exception as e:
            return JSONResponse(
                {"error": "Vision extraction failed", "detail": str(e), "traceback": traceback.format_exc()},
                status_code=500,
            )

        trace_stages.append(
            {
                "name": "vision_extract",
                "duration_ms": extract_result.get("elapsed_ms", 0),
                "ocr_skipped": "vision_bypass",
                "bypass_reason": bypass_reason,
                "input_type": input_type,
            }
        )
    else:
        # Text extraction (standard pipeline)
        markdown = (parse_result or {}).get("markdown", "")
        if not markdown:
            return JSONResponse(
                {"error": "No text extracted from document"},
                status_code=422,
            )

        try:
            from services.extract.pipeline import intelligent_extract

            extract_result = await intelligent_extract(
                markdown,
                schema_def,
                model=None,
            )
        except Exception as e:
            return JSONResponse(
                {"error": "Extraction failed", "detail": str(e), "traceback": traceback.format_exc()},
                status_code=500,
            )

        trace_stages.append(
            {
                "name": "extract",
                "duration_ms": extract_result.get("elapsed_ms", 0),
            }
        )

    # Post-processing (normalize + validate)
    try:
        from services.extract.main import _apply_post_extract

        _apply_post_extract(extract_result, schema_def)
    except Exception:
        pass

    elapsed_s = round(time.time() - start, 3)
    page_count = (parse_result or {}).get("pages", 1 if input_type == "image" else 0)

    return {
        "filename": filename,
        "pages": page_count,
        "input_type": input_type,
        "result": extract_result.get("extracted"),
        "confidence": extract_result.get("confidence"),
        "confidence_scores": extract_result.get("confidence_scores"),
        "model": extract_result.get("model"),
        "elapsed_seconds": elapsed_s,
        "ocr_confidence": ocr_confidence,
        "vision_bypass": use_vision,
        "trace": {
            "input_type": input_type,
            "parse_seconds": (parse_result or {}).get("elapsed_seconds"),
            "extract_ms": extract_result.get("elapsed_ms"),
            "total_seconds": elapsed_s,
            "ocr_confidence": ocr_confidence,
            "vision_bypass": use_vision,
            "bypass_reason": bypass_reason,
            "stages": trace_stages,
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
        result = await asyncio.get_event_loop().run_in_executor(None, functools.partial(_convert_sync, tmp_path))
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
