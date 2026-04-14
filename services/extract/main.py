"""Koji Extract Service — agent or parallel extraction."""

from __future__ import annotations

import json
import os
import time
import traceback

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI(title="Koji Extract Service", version="0.1.0")

OLLAMA_URL = os.environ.get("KOJI_OLLAMA_URL", "http://ollama:11434")
DEFAULT_MODEL = os.environ.get("KOJI_EXTRACT_MODEL", "llama3.2")
DEFAULT_STRATEGY = os.environ.get("KOJI_EXTRACT_STRATEGY", "intelligent")


class ExtractionRequest(BaseModel):
    markdown: str
    schema_def: dict
    model: str | None = None
    strategy: str | None = None  # "parallel" or "agent"
    classify_mode: str | None = None  # "keywords" (default), "llm", "all"
    relevant_categories: list[str] | None = None  # which chunk categories to extract from
    # Optional document-type classifier config from koji.yaml's `step: classify`
    # pipeline entry. When present AND strategy is "intelligent", the pipeline
    # runs the classify+split stage: partition the chunk list into typed
    # sections and extract each independently. None means disabled (default
    # behavior, byte-identical to pre-classifier pipeline).
    # Shape matches pipeline.intelligent_extract's classify_config param —
    # see docs/design/classify-split.md.
    classify_config: dict | None = None


@app.get("/health")
def health():
    return {"status": "healthy", "service": "koji-extract", "version": "0.1.0"}


@app.post("/extract")
async def extract(req: ExtractionRequest):
    """Extract structured data from markdown."""
    model = req.model or DEFAULT_MODEL
    strategy = req.strategy or DEFAULT_STRATEGY
    start = time.time()

    classify_mode = req.classify_mode or "keywords"
    relevant = set(req.relevant_categories) if req.relevant_categories else None

    try:
        if strategy == "intelligent":
            from .pipeline import intelligent_extract

            result = await intelligent_extract(
                req.markdown,
                req.schema_def,
                model,
                classify_config=req.classify_config,
            )
        elif strategy == "agent":
            result = await _run_agent(req.markdown, req.schema_def, model)
        else:
            from .parallel import parallel_extract

            result = await parallel_extract(
                req.markdown,
                req.schema_def,
                model,
                OLLAMA_URL,
                relevant_categories=relevant,
                classify_mode=classify_mode,
            )

        elapsed_ms = int((time.time() - start) * 1000)

        # The pipeline returns one of two shapes depending on whether the
        # classifier ran:
        #   - classifier off → flat shape with top-level `extracted` key
        #   - classifier on  → wrapped shape with `sections` list + classifier
        #                      metadata; extracted values live inside each
        #                      section.
        # Detect and forward the right shape. Caller code (server/main.py,
        # bench, CLI) checks for `sections` before falling back to the flat
        # shape, so both paths are handled downstream.
        envelope = {
            "model": model,
            "strategy": strategy,
            "schema": req.schema_def.get("name", "unknown"),
            "elapsed_ms": elapsed_ms,
        }
        if "sections" in result:
            return JSONResponse({**envelope, **result})
        return JSONResponse(
            {
                **envelope,
                "extracted": result.get("extracted"),
                **{k: v for k, v in result.items() if k != "extracted"},
            }
        )

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


async def _run_agent(markdown: str, schema_def: dict, model: str) -> dict:
    """Run the agent-based extraction loop."""
    from .tools import DocumentTools

    MAX_TOOL_ROUNDS = 15
    tools = DocumentTools(markdown)
    tool_defs = DocumentTools.tool_definitions()

    fields = schema_def.get("fields", {})
    schema_name = schema_def.get("name", "document")

    field_descriptions = []
    for name, spec in fields.items():
        field_type = spec.get("type", "string")
        required = spec.get("required", False)
        description = spec.get("description", "")
        req_label = " (REQUIRED)" if required else ""
        desc_label = f" — {description}" if description else ""
        options = spec.get("options", spec.get("enum", []))
        if options:
            opts = ", ".join(str(o) for o in options)
            desc_label += f" [allowed values: {opts}]"
        field_descriptions.append(f"  - {name}: {field_type}{req_label}{desc_label}")

    fields_block = "\n".join(field_descriptions)

    system_prompt = f"""You are a document extraction agent. Extract structured data from a document using the provided tools.

## Schema: {schema_name}

Fields to extract:
{fields_block}

## Strategy
1. Call list_sections to see the document structure.
2. Use grep to search for specific values.
3. Use read_section to read relevant sections.
4. When done, respond with ONLY a JSON object. Use null for unfound fields. Dates as YYYY-MM-DD. Numbers as numbers."""

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": "Extract the fields. Start by listing sections."},
    ]

    tool_calls_made = 0
    import re

    async with httpx.AsyncClient(timeout=1800) as client:
        for round_num in range(MAX_TOOL_ROUNDS):
            resp = await client.post(
                f"{OLLAMA_URL}/api/chat",
                json={
                    "model": model,
                    "messages": messages,
                    "tools": tool_defs,
                    "stream": False,
                    "options": {"temperature": 0, "num_predict": 4096},
                },
            )

            if resp.status_code != 200:
                raise Exception(f"Ollama returned {resp.status_code}: {resp.text}")

            result = resp.json()
            message = result.get("message", {})
            tool_calls = message.get("tool_calls", [])

            if not tool_calls:
                content = message.get("content", "")
                try:
                    extracted = json.loads(content)
                except json.JSONDecodeError:
                    match = re.search(r"\{[\s\S]*\}", content)
                    if match:
                        try:
                            extracted = json.loads(match.group())
                        except json.JSONDecodeError:
                            messages.append(message)
                            messages.append({"role": "user", "content": "Return ONLY valid JSON."})
                            continue
                    else:
                        messages.append(message)
                        messages.append({"role": "user", "content": "Return ONLY valid JSON."})
                        continue

                return {
                    "extracted": extracted,
                    "tool_calls": tool_calls_made,
                    "rounds": round_num + 1,
                }

            messages.append(message)
            for tool_call in tool_calls:
                fn = tool_call.get("function", {})
                tool_name = fn.get("name", "")
                tool_args = fn.get("arguments", {})
                print(f"[koji-extract] Agent tool: {tool_name}({json.dumps(tool_args)})")
                tool_result = tools.call_tool(tool_name, tool_args)
                tool_calls_made += 1
                messages.append({"role": "tool", "content": tool_result})

    raise Exception(f"Agent did not produce a result after {MAX_TOOL_ROUNDS} rounds")
