"""Tests for the Koji Python SDK."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import httpx
import pytest

from sdk.client import (
    ExtractResponse,
    HealthResponse,
    KojiAPIError,
    KojiClient,
    KojiConnectionError,
    KojiError,
    ParseResponse,
    ProcessResponse,
    StatusResponse,
)


def mock_response(status_code: int = 200, json_data: dict | None = None) -> httpx.Response:
    """Create a mock httpx.Response."""
    return httpx.Response(
        status_code=status_code,
        json=json_data or {},
        request=httpx.Request("GET", "http://test"),
    )


class TestHealth:
    def test_health_success(self):
        client = KojiClient(base_url="http://127.0.0.1:9401")
        response_data = {"status": "healthy", "service": "koji-server", "version": "0.1.0"}

        with patch.object(client._client, "request", return_value=mock_response(json_data=response_data)):
            result = client.health()

        assert isinstance(result, HealthResponse)
        assert result.status == "healthy"
        assert result.service == "koji-server"
        assert result.version == "0.1.0"

    def test_health_connection_error(self):
        client = KojiClient(base_url="http://127.0.0.1:9401")

        with patch.object(client._client, "request", side_effect=httpx.ConnectError("Connection refused")):
            with pytest.raises(KojiConnectionError) as exc_info:
                client.health()

        assert "Cannot connect to Koji server" in str(exc_info.value)
        assert "koji start" in str(exc_info.value)

    def test_health_timeout(self):
        client = KojiClient(base_url="http://127.0.0.1:9401")

        with patch.object(client._client, "request", side_effect=httpx.TimeoutException("timed out")):
            with pytest.raises(KojiError) as exc_info:
                client.health()

        assert "timed out" in str(exc_info.value)


class TestStatus:
    def test_status_success(self):
        client = KojiClient(base_url="http://127.0.0.1:9401")
        response_data = {
            "services": {
                "server": {"status": "healthy", "url": "http://127.0.0.1:9401", "response_ms": 0},
                "parse": {"status": "healthy", "url": "http://koji-parse:9410", "response_ms": 15},
                "extract": {"status": "unreachable", "url": "http://koji-extract:9420", "response_ms": None},
            },
            "cluster": {"project": "koji", "name": "default", "uptime_seconds": 120},
            "pipeline": [{"step": "parse", "engine": "docling"}],
        }

        with patch.object(client._client, "request", return_value=mock_response(json_data=response_data)):
            result = client.status()

        assert isinstance(result, StatusResponse)
        assert result.services["server"].status == "healthy"
        assert result.services["extract"].status == "unreachable"
        assert result.cluster.project == "koji"
        assert result.cluster.uptime_seconds == 120
        assert len(result.pipeline) == 1


class TestParse:
    def test_parse_success(self, tmp_path: Path):
        client = KojiClient(base_url="http://127.0.0.1:9401")
        test_file = tmp_path / "test.pdf"
        test_file.write_bytes(b"%PDF-1.4 fake content")

        response_data = {
            "markdown": "# Invoice\nAmount: $100",
            "filename": "test.pdf",
            "pages": 1,
            "elapsed_seconds": 2.5,
        }

        with patch.object(client._client, "request", return_value=mock_response(json_data=response_data)):
            result = client.parse(str(test_file))

        assert isinstance(result, ParseResponse)
        assert result.markdown == "# Invoice\nAmount: $100"
        assert result.filename == "test.pdf"
        assert result.pages == 1
        assert result.elapsed_seconds == 2.5

    def test_parse_file_not_found(self):
        client = KojiClient(base_url="http://127.0.0.1:9401")

        with pytest.raises(KojiError) as exc_info:
            client.parse("/nonexistent/file.pdf")

        assert "File not found" in str(exc_info.value)


class TestProcess:
    def test_process_without_schema(self, tmp_path: Path):
        client = KojiClient(base_url="http://127.0.0.1:9401")
        test_file = tmp_path / "doc.pdf"
        test_file.write_bytes(b"%PDF-1.4 fake")

        response_data = {"markdown": "# Hello", "filename": "doc.pdf", "pages": 2}

        with patch.object(client._client, "request", return_value=mock_response(json_data=response_data)):
            result = client.process(str(test_file))

        assert isinstance(result, ProcessResponse)
        assert result.markdown == "# Hello"
        assert result.filename == "doc.pdf"

    def test_process_with_schema_file(self, tmp_path: Path):
        client = KojiClient(base_url="http://127.0.0.1:9401")
        test_file = tmp_path / "invoice.pdf"
        test_file.write_bytes(b"%PDF-1.4 fake")
        schema_file = tmp_path / "schema.yaml"
        schema_file.write_text("type: object\nproperties:\n  amount:\n    type: number\n")

        response_data = {
            "filename": "invoice.pdf",
            "pages": 1,
            "parse_seconds": 3.0,
            "extracted": {"amount": 100.0},
            "model": "gpt-4o-mini",
            "schema": {"type": "object"},
            "elapsed_ms": 1500,
            "tool_calls": 1,
            "rounds": 1,
        }

        with patch.object(client._client, "request", return_value=mock_response(json_data=response_data)):
            result = client.process(str(test_file), schema=str(schema_file))

        assert isinstance(result, ProcessResponse)
        assert result.extracted == {"amount": 100.0}
        assert result.model == "gpt-4o-mini"

    def test_process_file_not_found(self):
        client = KojiClient(base_url="http://127.0.0.1:9401")

        with pytest.raises(KojiError) as exc_info:
            client.process("/nonexistent/file.pdf")

        assert "File not found" in str(exc_info.value)


class TestExtract:
    def test_extract_success(self, tmp_path: Path):
        client = KojiClient(base_url="http://127.0.0.1:9401")
        md_file = tmp_path / "doc.md"
        md_file.write_text("# Invoice\nTotal: $500")
        schema_file = tmp_path / "schema.yaml"
        schema_file.write_text("type: object\nproperties:\n  total:\n    type: number\n")

        response_data = {
            "extracted": {"total": 500.0},
            "model": "openai/gpt-4o-mini",
            "schema": {"type": "object"},
            "elapsed_ms": 800,
            "tool_calls": 1,
            "rounds": 1,
        }

        with patch.object(client._client, "request", return_value=mock_response(json_data=response_data)):
            result = client.extract(str(md_file), schema=str(schema_file), model="openai/gpt-4o-mini")

        assert isinstance(result, ExtractResponse)
        assert result.extracted == {"total": 500.0}
        assert result.model == "openai/gpt-4o-mini"
        assert result.elapsed_ms == 800

    def test_extract_with_strategy(self, tmp_path: Path):
        client = KojiClient(base_url="http://127.0.0.1:9401")
        md_file = tmp_path / "doc.md"
        md_file.write_text("# Data")
        schema_file = tmp_path / "schema.yaml"
        schema_file.write_text("type: object\n")

        response_data = {"extracted": {}, "model": "gpt-4o"}

        with patch.object(client._client, "request", return_value=mock_response(json_data=response_data)) as mock_req:
            client.extract(str(md_file), schema=str(schema_file), strategy="simple")

        # Verify strategy was passed in the payload
        call_kwargs = mock_req.call_args[1]
        assert call_kwargs["json"]["strategy"] == "simple"

    def test_extract_markdown_not_found(self):
        client = KojiClient(base_url="http://127.0.0.1:9401")

        with pytest.raises(KojiError) as exc_info:
            client.extract("/nonexistent/doc.md", schema="type: object")

        assert "File not found" in str(exc_info.value)

    def test_extract_raw_schema_string(self, tmp_path: Path):
        client = KojiClient(base_url="http://127.0.0.1:9401")
        md_file = tmp_path / "doc.md"
        md_file.write_text("# Test")

        response_data = {"extracted": {"name": "test"}, "model": "gpt-4o"}

        with patch.object(client._client, "request", return_value=mock_response(json_data=response_data)) as mock_req:
            result = client.extract(str(md_file), schema="type: object\nproperties:\n  name:\n    type: string")

        assert result.extracted == {"name": "test"}
        call_kwargs = mock_req.call_args[1]
        assert "type: object" in call_kwargs["json"]["schema"]


class TestAPIError:
    def test_api_error_response(self):
        client = KojiClient(base_url="http://127.0.0.1:9401")
        error_response = httpx.Response(
            status_code=400,
            json={"error": "Invalid schema format"},
            request=httpx.Request("POST", "http://test"),
            headers={"content-type": "application/json"},
        )

        with patch.object(client._client, "request", return_value=error_response):
            with pytest.raises(KojiAPIError) as exc_info:
                client.health()

        assert exc_info.value.status_code == 400
        assert "Invalid schema format" in str(exc_info.value)


class TestClientContextManager:
    def test_context_manager(self):
        with KojiClient(base_url="http://127.0.0.1:9401") as client:
            assert client.base_url == "http://127.0.0.1:9401"

    def test_trailing_slash_stripped(self):
        client = KojiClient(base_url="http://127.0.0.1:9401/")
        assert client.base_url == "http://127.0.0.1:9401"
