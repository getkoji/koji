"""Koji SDK client for interacting with the Koji API server."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx


class KojiError(Exception):
    """Base exception for Koji SDK errors."""

    def __init__(self, message: str, status_code: int | None = None):
        self.message = message
        self.status_code = status_code
        super().__init__(message)


class KojiConnectionError(KojiError):
    """Raised when the Koji server is unreachable."""

    pass


class KojiAPIError(KojiError):
    """Raised when the API returns an error response."""

    pass


@dataclass
class HealthResponse:
    """Response from the health endpoint."""

    status: str
    service: str
    version: str


@dataclass
class ServiceStatus:
    """Status of an individual service."""

    status: str
    url: str
    response_ms: int | None = None


@dataclass
class ClusterInfo:
    """Cluster metadata."""

    project: str
    name: str
    uptime_seconds: int


@dataclass
class StatusResponse:
    """Response from the status endpoint."""

    services: dict[str, ServiceStatus]
    cluster: ClusterInfo
    pipeline: list[dict[str, Any]]


@dataclass
class ParseResponse:
    """Response from the parse endpoint."""

    markdown: str
    filename: str | None = None
    pages: int | None = None
    elapsed_seconds: float | None = None


@dataclass
class ProcessResponse:
    """Response from the process endpoint."""

    filename: str | None = None
    pages: int | None = None
    parse_seconds: float | None = None
    extracted: dict[str, Any] | None = None
    model: str | None = None
    schema: dict[str, Any] | None = None
    elapsed_ms: float | None = None
    tool_calls: int | None = None
    rounds: int | None = None
    markdown: str | None = None


@dataclass
class ExtractResponse:
    """Response from the extract endpoint."""

    extracted: dict[str, Any] = field(default_factory=dict)
    model: str | None = None
    schema: dict[str, Any] | None = None
    elapsed_ms: float | None = None
    tool_calls: int | None = None
    rounds: int | None = None


class KojiClient:
    """Synchronous client for the Koji API.

    Usage:
        client = KojiClient(base_url="http://127.0.0.1:9401")
        status = client.status()
        result = client.process("./invoice.pdf", schema="./schemas/invoice.yaml")
    """

    def __init__(self, base_url: str = "http://127.0.0.1:9401"):
        self.base_url = base_url.rstrip("/")
        self._client = httpx.Client(base_url=self.base_url)

    def close(self):
        """Close the underlying HTTP client."""
        self._client.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def _request(self, method: str, path: str, timeout: float = 30, **kwargs) -> httpx.Response:
        """Make an HTTP request with error handling."""
        try:
            resp = self._client.request(method, path, timeout=timeout, **kwargs)
        except httpx.ConnectError:
            raise KojiConnectionError(
                f"Cannot connect to Koji server at {self.base_url}. Is the server running? Start it with: koji start"
            )
        except httpx.TimeoutException:
            raise KojiError(f"Request to {path} timed out after {timeout}s")

        if resp.status_code >= 400:
            body = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
            error_msg = body.get("error", body.get("detail", f"HTTP {resp.status_code}"))
            raise KojiAPIError(error_msg, status_code=resp.status_code)

        return resp

    def health(self) -> HealthResponse:
        """Check if the Koji server is healthy."""
        resp = self._request("GET", "/health", timeout=30)
        data = resp.json()
        return HealthResponse(
            status=data["status"],
            service=data["service"],
            version=data["version"],
        )

    def status(self) -> StatusResponse:
        """Get the status of all services in the cluster."""
        resp = self._request("GET", "/api/status", timeout=30)
        data = resp.json()

        services = {}
        for name, svc in data["services"].items():
            services[name] = ServiceStatus(
                status=svc["status"],
                url=svc["url"],
                response_ms=svc.get("response_ms"),
            )

        cluster = ClusterInfo(
            project=data["cluster"]["project"],
            name=data["cluster"]["name"],
            uptime_seconds=data["cluster"]["uptime_seconds"],
        )

        return StatusResponse(
            services=services,
            cluster=cluster,
            pipeline=data.get("pipeline", []),
        )

    def parse(self, path: str | Path) -> ParseResponse:
        """Parse a document into markdown.

        Args:
            path: Path to the document file (PDF, Word, image, etc.)

        Returns:
            ParseResponse with the extracted markdown content.
        """
        file_path = Path(path)
        if not file_path.exists():
            raise KojiError(f"File not found: {file_path}")

        with open(file_path, "rb") as f:
            resp = self._request(
                "POST",
                "/api/parse",
                timeout=300,
                files={"file": (file_path.name, f, "application/octet-stream")},
            )

        data = resp.json()
        return ParseResponse(
            markdown=data["markdown"],
            filename=data.get("filename"),
            pages=data.get("pages"),
            elapsed_seconds=data.get("elapsed_seconds"),
        )

    def process(self, path: str | Path, schema: str | Path | None = None) -> ProcessResponse:
        """Run the full pipeline: parse a document, then optionally extract with a schema.

        Args:
            path: Path to the document file.
            schema: Path to a YAML/JSON schema file, or a raw schema string.

        Returns:
            ProcessResponse with parsed and optionally extracted data.
        """
        file_path = Path(path)
        if not file_path.exists():
            raise KojiError(f"File not found: {file_path}")

        schema_content: str | None = None
        if schema is not None:
            schema_path = Path(schema)
            if schema_path.exists():
                schema_content = schema_path.read_text()
            else:
                # Treat as raw schema string
                schema_content = str(schema)

        with open(file_path, "rb") as f:
            data: dict[str, Any] = {}
            if schema_content:
                data["schema"] = schema_content

            resp = self._request(
                "POST",
                "/api/process",
                timeout=600,
                files={"file": (file_path.name, f, "application/octet-stream")},
                data=data,
            )

        result = resp.json()
        return ProcessResponse(
            filename=result.get("filename"),
            pages=result.get("pages"),
            parse_seconds=result.get("parse_seconds"),
            extracted=result.get("extracted"),
            model=result.get("model"),
            schema=result.get("schema"),
            elapsed_ms=result.get("elapsed_ms"),
            tool_calls=result.get("tool_calls"),
            rounds=result.get("rounds"),
            markdown=result.get("markdown"),
        )

    def extract(
        self,
        markdown_path: str | Path,
        schema: str | Path,
        model: str | None = None,
        strategy: str | None = None,
    ) -> ExtractResponse:
        """Extract structured data from markdown using a schema.

        Args:
            markdown_path: Path to a markdown file.
            schema: Path to a YAML/JSON schema file, or a raw schema string.
            model: Model identifier (e.g. "openai/gpt-4o-mini").
            strategy: Extraction strategy override.

        Returns:
            ExtractResponse with the extracted structured data.
        """
        md_path = Path(markdown_path)
        if not md_path.exists():
            raise KojiError(f"File not found: {md_path}")

        markdown_content = md_path.read_text()

        schema_path = Path(schema)
        if schema_path.exists():
            schema_content = schema_path.read_text()
        else:
            schema_content = str(schema)

        payload: dict[str, Any] = {
            "markdown": markdown_content,
            "schema": schema_content,
        }
        if model:
            payload["model"] = model
        if strategy:
            payload["strategy"] = strategy

        resp = self._request(
            "POST",
            "/api/extract",
            timeout=600,
            json=payload,
        )

        result = resp.json()
        return ExtractResponse(
            extracted=result.get("extracted", {}),
            model=result.get("model"),
            schema=result.get("schema"),
            elapsed_ms=result.get("elapsed_ms"),
            tool_calls=result.get("tool_calls"),
            rounds=result.get("rounds"),
        )
