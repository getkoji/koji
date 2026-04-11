"""Koji Extract Service — markdown + schema in, structured JSON out."""

from __future__ import annotations

import json
import os
import traceback

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI(title="Koji Extract Service", version="0.1.0")

OLLAMA_URL = os.environ.get("KOJI_OLLAMA_URL", "http://ollama:11434")
DEFAULT_MODEL = os.environ.get("KOJI_EXTRACT_MODEL", "llama3.2")


class ExtractionRequest(BaseModel):
    markdown: str
    schema_def: dict
    model: str | None = None


def build_prompt(markdown: str, schema_def: dict) -> str:
    """Build an extraction prompt from markdown content and a schema."""
    fields = schema_def.get("fields", {})

    field_descriptions = []
    for name, spec in fields.items():
        field_type = spec.get("type", "string")
        required = spec.get("required", False)
        description = spec.get("description", "")
        req_label = " (REQUIRED)" if required else " (optional)"
        desc_label = f" — {description}" if description else ""
        field_descriptions.append(f"  - {name}: {field_type}{req_label}{desc_label}")

    fields_block = "\n".join(field_descriptions)
    schema_name = schema_def.get("name", "document")

    return f"""Extract structured data from the following document. Return ONLY valid JSON matching the schema below. Do not include any explanation or markdown formatting.

## Schema: {schema_name}

Fields to extract:
{fields_block}

## Document

{markdown}

## Instructions

Return a single JSON object with the extracted fields. Use null for fields you cannot find. For array fields, return an array of objects. Dates should be in ISO 8601 format (YYYY-MM-DD). Numbers should be numeric, not strings.

JSON output:"""


@app.get("/health")
def health():
    return {"status": "healthy", "service": "koji-extract", "version": "0.1.0"}


@app.post("/extract")
async def extract(req: ExtractionRequest):
    """Extract structured data from markdown using an LLM."""
    model = req.model or DEFAULT_MODEL
    prompt = build_prompt(req.markdown, req.schema_def)

    try:
        async with httpx.AsyncClient(timeout=1800) as client:
            resp = await client.post(
                f"{OLLAMA_URL}/api/generate",
                json={
                    "model": model,
                    "prompt": prompt,
                    "stream": False,
                    "format": "json",
                    "options": {
                        "temperature": 0,
                        "num_predict": 4096,
                    },
                },
            )

            if resp.status_code != 200:
                return JSONResponse(
                    {"error": f"Ollama returned {resp.status_code}", "detail": resp.text},
                    status_code=502,
                )

            result = resp.json()
            raw_response = result.get("response", "")

            # Parse the JSON from the LLM response
            try:
                extracted = json.loads(raw_response)
            except json.JSONDecodeError:
                return JSONResponse(
                    {
                        "error": "LLM returned invalid JSON",
                        "raw_response": raw_response,
                    },
                    status_code=422,
                )

            return JSONResponse({
                "extracted": extracted,
                "model": model,
                "schema": req.schema_def.get("name", "unknown"),
                "eval_duration_ms": result.get("eval_duration", 0) // 1_000_000,
            })

    except httpx.ConnectError:
        return JSONResponse(
            {"error": "Ollama unavailable", "detail": f"Could not connect to {OLLAMA_URL}"},
            status_code=502,
        )
    except Exception as e:
        tb = traceback.format_exc()
        print(f"[koji-extract] Error:\n{tb}")
        return JSONResponse(
            {"error": str(e)},
            status_code=500,
        )
