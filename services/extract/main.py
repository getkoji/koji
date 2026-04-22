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

from .normalize import normalize_extracted
from .validate import validate_extracted

app = FastAPI(title="Koji Extract Service", version="0.1.0")


def _apply_post_extract(result: dict, schema_def: dict) -> dict:
    """Run normalization and validation over every extracted payload in `result`.

    Handles both response shapes:
      - classifier-off: `result["extracted"]` is a dict
      - classifier-on:  `result["sections"]` is a list of per-section dicts
                        each with its own `extracted` payload
    """
    if "sections" in result and isinstance(result["sections"], list):
        for section in result["sections"]:
            if isinstance(section, dict) and "extracted" in section:
                _apply_one(section, schema_def)
        return result

    if "extracted" in result:
        _apply_one(result, schema_def)
    return result


def _apply_one(payload: dict, schema_def: dict) -> None:
    normalized, norm_report = normalize_extracted(payload.get("extracted"), schema_def)
    validation_report = validate_extracted(normalized, schema_def)
    payload["extracted"] = normalized
    payload["normalization"] = {
        "applied": [{"field": f, "transform": t} for f, t in norm_report.applied],
        "warnings": norm_report.warnings,
    }
    payload["validation"] = validation_report.to_dict()


OLLAMA_URL = os.environ.get("KOJI_OLLAMA_URL", "http://ollama:11434")
DEFAULT_MODEL = os.environ.get("KOJI_EXTRACT_MODEL", "llama3.2")
DEFAULT_STRATEGY = os.environ.get("KOJI_EXTRACT_STRATEGY", "intelligent")


class EndpointConfig(BaseModel):
    """Per-request model endpoint config.

    The Node API resolves this from the pipeline's ``modelProviderId``
    (decrypted ``authJson``) and passes it on every extract call. When
    None, the extract service falls back to env-var defaults
    (OPENAI_API_KEY + KOJI_OPENAI_URL or ollama). See
    api/src/extract/resolve-endpoint.ts on the Node side and
    providers.create_provider here.

    Fields are intentionally loose: the Node side doesn't know which
    adapter will be picked, so it sends the superset. The Python
    adapter pulls only the fields it cares about.
    """

    provider: str  # "openai" | "azure-openai" | "anthropic" | "bedrock" | "ollama"
    model: str
    base_url: str | None = None
    api_key: str | None = None
    # Azure-specific
    deployment_name: str | None = None
    api_version: str | None = None
    # Bedrock-specific
    aws_region: str | None = None
    aws_access_key_id: str | None = None
    aws_secret_access_key: str | None = None
    aws_session_token: str | None = None


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
    # Per-request model endpoint config. When provided, overrides the
    # env-var defaults and routes to the matching provider adapter. Node
    # passes this after fetching + decrypting the pipeline's model
    # endpoint row.
    endpoint: EndpointConfig | None = None


@app.get("/health")
def health():
    return {"status": "healthy", "service": "koji-extract", "version": "0.1.0"}


@app.post("/extract")
async def extract(req: ExtractionRequest):
    """Extract structured data from markdown."""
    # When an explicit endpoint config is provided, prefer its model over
    # the legacy req.model. This lets the Node side choose the target
    # model per pipeline without the caller having to keep req.model in
    # sync with the endpoint row.
    model = (req.endpoint.model if req.endpoint else None) or req.model or DEFAULT_MODEL
    strategy = req.strategy or DEFAULT_STRATEGY
    start = time.time()
    endpoint_label = f"endpoint.provider={req.endpoint.provider!r}" if req.endpoint else "endpoint=None"
    print(
        f"[koji-extract] Request: model={model!r} {endpoint_label}, strategy={strategy}, "
        f"markdown={len(req.markdown)} chars, fields={list(req.schema_def.get('fields', {}).keys())}"
    )

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
                endpoint_cfg=req.endpoint,
            )
        elif strategy == "agent":
            result = await _run_agent(req.markdown, req.schema_def, model, endpoint_cfg=req.endpoint)
        else:
            from .parallel import parallel_extract

            result = await parallel_extract(
                req.markdown,
                req.schema_def,
                model,
                OLLAMA_URL,
                relevant_categories=relevant,
                classify_mode=classify_mode,
                endpoint_cfg=req.endpoint,
            )

        _apply_post_extract(result, req.schema_def)
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


async def _run_agent(
    markdown: str,
    schema_def: dict,
    model: str,
    endpoint_cfg: EndpointConfig | None = None,  # accepted for signature parity; see note below
) -> dict:
    """Run the agent-based extraction loop.

    NOTE: ``endpoint_cfg`` is accepted so callers can pass it uniformly,
    but the agent path currently makes raw Ollama HTTP calls and does
    NOT honor a non-Ollama endpoint. Using ``strategy=agent`` with a
    BYO endpoint is undefined today — filed as a follow-up in the
    tasks list.
    """
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
