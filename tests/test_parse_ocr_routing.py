"""Tests for parse service OCR routing logic.

Verifies that the Docker parse service routes file types correctly:
  - PDFs → scanned check (OCR or skip based on text layer)
  - Images → always OCR
  - DOCX/HTML/PPTX/etc → skip OCR (Docling handles natively)

This was a parity bug with the Modal service (oss-117).

The parse service has heavy native dependencies (pypdfium2, docling,
easyocr) that are only present inside the Docker image.  We mock
them at the sys.modules level so these unit tests run in the normal
dev venv without GPU libraries.
"""

from __future__ import annotations

import sys
import types
from io import BytesIO
from unittest.mock import MagicMock, patch

import pytest

# ── Stub out heavy native deps before importing the module ──────────────


def _install_stubs():
    """Insert lightweight stubs for parse-service-only deps."""
    stubs = {}
    for mod_name in [
        "pypdfium2",
        "docling",
        "docling.datamodel",
        "docling.datamodel.base_models",
        "docling.datamodel.pipeline_options",
        "docling.document_converter",
        "easyocr",
        "sse_starlette",
        "sse_starlette.sse",
    ]:
        if mod_name not in sys.modules:
            m = types.ModuleType(mod_name)
            stubs[mod_name] = m
            sys.modules[mod_name] = m

    # Provide the names the module imports at top level
    docling_base = sys.modules["docling.datamodel.base_models"]
    docling_base.InputFormat = MagicMock()

    docling_opts = sys.modules["docling.datamodel.pipeline_options"]
    docling_opts.EasyOcrOptions = MagicMock()
    docling_opts.PdfPipelineOptions = MagicMock()

    docling_conv = sys.modules["docling.document_converter"]
    docling_conv.DocumentConverter = MagicMock()
    docling_conv.PdfFormatOption = MagicMock()

    sse_mod = sys.modules["sse_starlette.sse"]
    sse_mod.EventSourceResponse = MagicMock()

    return stubs


_stubs = _install_stubs()

from fastapi.testclient import TestClient  # noqa: E402

from services.parse.main import (  # noqa: E402
    _is_image,
    app,
    classify_input,
)

# ── _is_image ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "filename, content_type, expected",
    [
        ("photo.jpg", None, True),
        ("photo.JPEG", None, True),
        ("scan.png", None, True),
        ("scan.tiff", None, True),
        ("scan.tif", None, True),
        ("photo.bmp", None, True),
        ("photo.webp", None, True),
        ("report.pdf", None, False),
        ("report.docx", None, False),
        ("page.html", None, False),
        ("deck.pptx", None, False),
        ("data.csv", None, False),
        # MIME type override
        ("noext", "image/png", True),
        ("noext", "image/jpeg", True),
        ("noext", "application/pdf", False),
        ("noext", None, False),
    ],
)
def test_is_image(filename: str, content_type: str | None, expected: bool):
    assert _is_image(filename, content_type) == expected


# ── classify_input ──────────────────────────────────────────────────────


def test_classify_input_image():
    assert classify_input("/tmp/photo.jpg") == "image"
    assert classify_input("/tmp/scan.png") == "image"


def test_classify_input_image_by_mimetype():
    assert classify_input("/tmp/noext", content_type="image/png") == "image"


def test_classify_input_non_pdf_non_image():
    """DOCX, HTML, PPTX, etc. should return 'digital' — NOT 'digital_pdf'."""
    assert classify_input("/tmp/report.docx") == "digital"
    assert classify_input("/tmp/page.html") == "digital"
    assert classify_input("/tmp/deck.pptx") == "digital"
    assert classify_input("/tmp/data.csv") == "digital"
    assert classify_input("/tmp/notes.txt") == "digital"


# ── /parse endpoint OCR routing ─────────────────────────────────────────

client = TestClient(app)

MOCK_RESULT = {"markdown": "# Hello", "pages": 1}


def _upload(
    filename: str,
    content: bytes = b"fake content",
    content_type: str = "application/octet-stream",
):
    return client.post(
        "/parse",
        files={"file": (filename, BytesIO(content), content_type)},
    )


@patch("services.parse.main._convert_sync", return_value=MOCK_RESULT)
def test_parse_docx_skips_ocr(mock_convert):
    resp = _upload("report.docx")
    assert resp.status_code == 200
    assert resp.json()["ocr_skipped"] is True
    _, kwargs = mock_convert.call_args
    assert kwargs["skip_ocr"] is True


@patch("services.parse.main._convert_sync", return_value=MOCK_RESULT)
def test_parse_html_skips_ocr(mock_convert):
    resp = _upload("page.html")
    assert resp.status_code == 200
    assert resp.json()["ocr_skipped"] is True
    _, kwargs = mock_convert.call_args
    assert kwargs["skip_ocr"] is True


@patch("services.parse.main._convert_sync", return_value=MOCK_RESULT)
def test_parse_pptx_skips_ocr(mock_convert):
    resp = _upload("deck.pptx")
    assert resp.status_code == 200
    assert resp.json()["ocr_skipped"] is True
    _, kwargs = mock_convert.call_args
    assert kwargs["skip_ocr"] is True


@patch("services.parse.main._convert_sync", return_value=MOCK_RESULT)
def test_parse_image_uses_ocr(mock_convert):
    resp = _upload("scan.png", content_type="image/png")
    assert resp.status_code == 200
    assert resp.json()["ocr_skipped"] is False
    _, kwargs = mock_convert.call_args
    assert kwargs["skip_ocr"] is False


@patch("services.parse.main._convert_sync", return_value=MOCK_RESULT)
@patch(
    "services.parse.main.get_pdf_info",
    return_value={"pages": 3, "scanned": False},
)
def test_parse_digital_pdf_skips_ocr(mock_info, mock_convert):
    resp = _upload("report.pdf")
    assert resp.status_code == 200
    assert resp.json()["ocr_skipped"] is True
    _, kwargs = mock_convert.call_args
    assert kwargs["skip_ocr"] is True


@patch("services.parse.main._convert_sync", return_value=MOCK_RESULT)
@patch(
    "services.parse.main.get_pdf_info",
    return_value={"pages": 3, "scanned": True},
)
def test_parse_scanned_pdf_uses_ocr(mock_info, mock_convert):
    resp = _upload("scan.pdf")
    assert resp.status_code == 200
    assert resp.json()["ocr_skipped"] is False
    _, kwargs = mock_convert.call_args
    assert kwargs["skip_ocr"] is False
