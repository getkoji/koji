"""Koji Extract — Modal app.

Serverless deployment of the extraction service. Same FastAPI app as the
Docker sidecar at services/extract/, running on Modal.

CPU-only — extraction calls external LLM APIs (OpenAI, Anthropic, etc.).

Deploy: ``modal deploy services/extract-modal/app.py`` from the koji/ root.
"""

from __future__ import annotations

from pathlib import Path

import modal

EXTRACT_DIR = Path(__file__).parent.parent / "extract"

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        "fastapi[standard]==0.115.6",
        "httpx==0.27.0",
        "pydantic==2.10.0",
        "pyyaml==6.0.2",
    )
    .add_local_dir(str(EXTRACT_DIR), remote_path="/root/extract")
)

app = modal.App("koji-extract", image=image)

from fastapi import Request  # noqa: E402


@app.function(
    timeout=600,
    memory=512,
    cpu=1.0,
)
@modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
async def extract_http(request: Request):
    """HTTP endpoint wrapping the extract service."""
    import sys

    sys.path.insert(0, "/root")

    import traceback

    from fastapi.responses import JSONResponse

    try:
        body = await request.json()
    except Exception as e:
        return JSONResponse({"error": f"Invalid request body: {e}"}, status_code=400)

    from extract.main import ExtractionRequest
    from extract.main import extract as do_extract

    try:
        req = ExtractionRequest(**body)
        return await do_extract(req)
    except Exception as e:
        print(f"[koji-extract-modal] error:\n{traceback.format_exc()}")
        return JSONResponse({"error": str(e)}, status_code=422)
