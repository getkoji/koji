"""Tests for the HTTP wiring of the classify+split feature (oss-48).

oss-28 / oss-29 landed the classifier + normalizer + pipeline integration
but left the feature unreachable from the HTTP surface — neither the
user-facing /api/extract on server/main.py nor the internal /extract on
services/extract/main.py threaded `classify_config` through. This test
file covers both sides of that wiring.
"""

from __future__ import annotations

import json as _json
from unittest.mock import AsyncMock, patch

import pytest

from server.config import ClassifyTypeConfig, KojiConfig, PipelineStep
from server.main import ExtractRequest, _run_extract
from services.extract.main import ExtractionRequest
from services.extract.main import extract as extract_endpoint


def _koji_config_with_classify_step() -> KojiConfig:
    return KojiConfig(
        pipeline=[
            PipelineStep(step="parse", engine="docling"),
            PipelineStep(
                step="classify",
                model="openai/gpt-4o-mini",
                require_apply_to=False,
                types=[
                    ClassifyTypeConfig(id="invoice", description="Commercial invoice."),
                    ClassifyTypeConfig(id="policy", description="Insurance policy."),
                ],
            ),
            PipelineStep(step="extract", model="openai/gpt-4o-mini"),
        ]
    )


def _koji_config_without_classify_step() -> KojiConfig:
    return KojiConfig(
        pipeline=[
            PipelineStep(step="parse", engine="docling"),
            PipelineStep(step="extract", model="openai/gpt-4o-mini"),
        ]
    )


class _FakeResponse:
    """Minimal stand-in for httpx.Response used by the mocks below."""

    def __init__(self, body: dict, status_code: int = 200):
        self._body = body
        self.status_code = status_code

    def json(self) -> dict:
        return self._body

    @property
    def text(self) -> str:
        return ""


# ── server/main.py::_run_extract ─────────────────────────────────────


class TestServerRunExtractClassifyWiring:
    """The upstream /api/extract handler should read koji.yaml's classify
    step at request time and include it in the payload sent to the extract
    service. Absent classify step = byte-identical pre-wiring payload."""

    @pytest.mark.asyncio
    async def test_classify_step_present_injects_classify_config(self):
        captured: dict = {}

        async def _fake_post(client_self, url, json=None, **_kwargs):
            captured["url"] = url
            captured["json"] = json
            return _FakeResponse({"extracted": {"filer_name": "Acme"}})

        req = ExtractRequest(
            markdown="# Header\n\nSome content",
            schema="name: test\nfields:\n  filer_name:\n    type: string",
        )

        with (
            patch("server.main.get_config", return_value=_koji_config_with_classify_step()),
            patch("httpx.AsyncClient.post", new=_fake_post),
        ):
            result = await _run_extract(req)

        assert result == {"extracted": {"filer_name": "Acme"}}
        payload = captured["json"]
        assert "classify_config" in payload
        classify = payload["classify_config"]
        assert classify["model"] == "openai/gpt-4o-mini"
        assert classify["require_apply_to"] is False
        assert {t["id"] for t in classify["types"]} == {"invoice", "policy"}
        # The `step` field is stripped — intelligent_extract only reads
        # model / types / require_apply_to.
        assert "step" not in classify

    @pytest.mark.asyncio
    async def test_no_classify_step_leaves_payload_untouched(self):
        captured: dict = {}

        async def _fake_post(client_self, url, json=None, **_kwargs):
            captured["json"] = json
            return _FakeResponse({"extracted": {}})

        req = ExtractRequest(
            markdown="# H\n\nstuff",
            schema="name: test\nfields:\n  title:\n    type: string",
        )

        with (
            patch("server.main.get_config", return_value=_koji_config_without_classify_step()),
            patch("httpx.AsyncClient.post", new=_fake_post),
        ):
            await _run_extract(req)

        payload = captured["json"]
        assert "classify_config" not in payload
        # Classic payload keys unchanged
        assert set(payload.keys()) == {"markdown", "schema_def"}

    @pytest.mark.asyncio
    async def test_strategy_and_model_overrides_still_flow_through(self):
        """Pre-wiring fields still land in the payload even when the
        classify step is present — no regression on the existing contract."""
        captured: dict = {}

        async def _fake_post(client_self, url, json=None, **_kwargs):
            captured["json"] = json
            return _FakeResponse({"extracted": {}})

        req = ExtractRequest(
            markdown="# H\n\nstuff",
            schema="name: test\nfields:\n  title:\n    type: string",
            strategy="intelligent",
            model="openai/gpt-4o",
        )

        with (
            patch("server.main.get_config", return_value=_koji_config_with_classify_step()),
            patch("httpx.AsyncClient.post", new=_fake_post),
        ):
            await _run_extract(req)

        payload = captured["json"]
        assert payload["strategy"] == "intelligent"
        assert payload["model"] == "openai/gpt-4o"
        assert "classify_config" in payload


# ── server/main.py::_run_process (upload + parse + extract) ─────────


# A minimal valid PDF header — enough to pass the services/integrity.py
# magic-byte check that runs before /api/process hits the parse service.
# The integrity validator only inspects the first few bytes; the mocked
# parse service response shape handles everything beyond that.
_MINIMAL_PDF_BYTES = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n%%EOF\n"


class TestServerRunProcessClassifyWiring:
    """/api/process (file upload flow) must also thread classify_config
    through to the extract service and handle the sections-wrapped
    response when the classifier is enabled."""

    @pytest.mark.asyncio
    async def test_classify_step_forwarded_and_sections_returned(self):
        from server.main import _run_process

        captured_payloads: list[dict] = []

        async def _fake_post(client_self, url, json=None, files=None, **_kwargs):
            if "parse" in url:
                return _FakeResponse(
                    {
                        "filename": "packet.pdf",
                        "markdown": "# Section\n\nContent",
                        "pages": 1,
                        "elapsed_seconds": 0.1,
                    }
                )
            # Extract service call
            captured_payloads.append(json)
            return _FakeResponse(
                {
                    "model": "mock/test",
                    "strategy": "intelligent",
                    "schema": "test",
                    "elapsed_ms": 100,
                    "sections": [
                        {
                            "section_type": "policy",
                            "section_title": "Section 0 — policy",
                            "section_confidence": 0.97,
                            "chunk_indices": [0],
                            "extracted": {"policy_number": "BOP-42"},
                            "confidence": {"policy_number": "high"},
                            "confidence_scores": {"policy_number": 0.95},
                            "gap_filled": [],
                            "routing_plan": {},
                            "groups": [],
                        }
                    ],
                    "classifier": {
                        "model": "openai/gpt-4o-mini",
                        "total_sections": 1,
                        "sections_matched": 1,
                        "normalizer_corrections": 0,
                        "elapsed_ms": 5,
                    },
                    "document_map_summary": {},
                }
            )

        with (
            patch("server.main.get_config", return_value=_koji_config_with_classify_step()),
            patch("httpx.AsyncClient.post", new=_fake_post),
        ):
            result = await _run_process(
                content=_MINIMAL_PDF_BYTES,
                filename="packet.pdf",
                content_type="application/pdf",
                schema="name: p\napply_to: [policy]\nfields:\n  policy_number:\n    type: string",
            )

        # Extract call included classify_config
        assert len(captured_payloads) == 1
        assert "classify_config" in captured_payloads[0]
        classify = captured_payloads[0]["classify_config"]
        assert classify["model"] == "openai/gpt-4o-mini"
        assert {t["id"] for t in classify["types"]} == {"invoice", "policy"}

        # _run_process returned the wrapped shape, not the flat one
        assert "sections" in result
        assert "extracted" not in result
        assert result["sections"][0]["section_type"] == "policy"
        assert result["sections"][0]["extracted"] == {"policy_number": "BOP-42"}
        assert result["classifier"]["sections_matched"] == 1

    @pytest.mark.asyncio
    async def test_no_classify_step_keeps_flat_process_response(self):
        """Without a classify step in koji.yaml, /api/process returns the
        pre-classifier flat shape with an `extracted` field."""
        from server.main import _run_process

        async def _fake_post(client_self, url, json=None, files=None, **_kwargs):
            if "parse" in url:
                return _FakeResponse(
                    {
                        "filename": "doc.pdf",
                        "markdown": "# Section\n\nContent",
                        "pages": 1,
                        "elapsed_seconds": 0.1,
                    }
                )
            return _FakeResponse(
                {
                    "extracted": {"title": "Hello"},
                    "model": "mock/test",
                    "strategy": "intelligent",
                    "schema": "test",
                    "elapsed_ms": 80,
                    "confidence": {"title": "high"},
                    "confidence_scores": {"title": 0.9},
                    "document_map_summary": {},
                    "routing_plan": {},
                    "groups": [],
                }
            )

        with (
            patch("server.main.get_config", return_value=_koji_config_without_classify_step()),
            patch("httpx.AsyncClient.post", new=_fake_post),
        ):
            result = await _run_process(
                content=_MINIMAL_PDF_BYTES,
                filename="doc.pdf",
                content_type="application/pdf",
                schema="name: t\nfields:\n  title:\n    type: string",
            )

        assert "extracted" in result
        assert "sections" not in result
        assert result["extracted"] == {"title": "Hello"}


# ── services/extract/main.py::extract endpoint ──────────────────────


class TestExtractServiceEndpointClassifyWiring:
    """The internal /extract endpoint should pass classify_config through
    to intelligent_extract when the request carries it, and leave it as
    None when the field is absent."""

    @pytest.mark.asyncio
    async def test_classify_config_forwarded_to_intelligent_extract(self):
        captured: dict = {}

        async def _fake_intelligent_extract(markdown, schema_def, model, classify_config=None, **_kwargs):
            captured["markdown"] = markdown
            captured["schema_def"] = schema_def
            captured["model"] = model
            captured["classify_config"] = classify_config
            return {
                "sections": [
                    {
                        "section_type": "invoice",
                        "section_title": "Section 0 — invoice",
                        "section_confidence": 0.95,
                        "chunk_indices": [0],
                        "extracted": {"invoice_number": "INV-001"},
                        "confidence": {"invoice_number": "high"},
                        "confidence_scores": {"invoice_number": 0.95},
                        "gap_filled": [],
                        "routing_plan": {},
                        "groups": [],
                    }
                ],
                "chunks_total": 1,
                "elapsed_ms": 10,
                "document_map_summary": {},
                "classifier": {
                    "model": "openai/gpt-4o-mini",
                    "total_sections": 1,
                    "sections_matched": 1,
                    "normalizer_corrections": 0,
                    "elapsed_ms": 5,
                },
            }

        req = ExtractionRequest(
            markdown="# Header\n\nInvoice body",
            schema_def={"name": "inv", "fields": {"invoice_number": {"type": "string"}}},
            strategy="intelligent",
            model="mock/test",
            classify_config={
                "model": "mock/classify",
                "require_apply_to": False,
                "types": [{"id": "invoice", "description": "Invoice"}],
            },
        )

        with patch(
            "services.extract.pipeline.intelligent_extract",
            new=AsyncMock(side_effect=_fake_intelligent_extract),
        ):
            response = await extract_endpoint(req)

        assert captured["classify_config"] is not None
        assert captured["classify_config"]["model"] == "mock/classify"
        assert captured["classify_config"]["types"][0]["id"] == "invoice"
        body = _json.loads(response.body.decode())
        assert "sections" in body
        assert body["sections"][0]["section_type"] == "invoice"

    @pytest.mark.asyncio
    async def test_classify_config_absent_yields_flat_response(self):
        captured: dict = {}

        async def _fake_intelligent_extract(markdown, schema_def, model, classify_config=None, **_kwargs):
            captured["classify_config"] = classify_config
            return {
                "extracted": {"invoice_number": "INV-001"},
                "confidence": {"invoice_number": "high"},
                "confidence_scores": {"invoice_number": 0.95},
                "chunks_total": 1,
                "extraction_groups": 1,
                "elapsed_ms": 10,
                "gap_filled": [],
                "document_map_summary": {},
                "routing_plan": {},
                "groups": [],
            }

        req = ExtractionRequest(
            markdown="# Header\n\nInvoice body",
            schema_def={"name": "inv", "fields": {"invoice_number": {"type": "string"}}},
            strategy="intelligent",
            model="mock/test",
            # No classify_config
        )

        with patch(
            "services.extract.pipeline.intelligent_extract",
            new=AsyncMock(side_effect=_fake_intelligent_extract),
        ):
            response = await extract_endpoint(req)

        assert captured["classify_config"] is None
        body = _json.loads(response.body.decode())
        assert "extracted" in body
        assert "sections" not in body

    @pytest.mark.asyncio
    async def test_classify_config_ignored_for_non_intelligent_strategy(self):
        """Parallel / agent strategies don't run intelligent_extract, so a
        classify_config in the request shouldn't surface to them. This
        prevents accidental classifier calls under the agent path."""
        agent_called: dict = {"count": 0}

        async def _fake_agent(markdown, schema_def, model):
            agent_called["count"] += 1
            return {"extracted": {"x": 1}, "tool_calls": 0, "rounds": 1}

        req = ExtractionRequest(
            markdown="# H\n\nstuff",
            schema_def={"name": "t", "fields": {"x": {"type": "number"}}},
            strategy="agent",
            model="mock/test",
            classify_config={
                "model": "mock/classify",
                "types": [{"id": "t"}],
            },
        )

        with patch("services.extract.main._run_agent", new=AsyncMock(side_effect=_fake_agent)):
            response = await extract_endpoint(req)

        assert agent_called["count"] == 1
        body = _json.loads(response.body.decode())
        assert body["extracted"] == {"x": 1}
