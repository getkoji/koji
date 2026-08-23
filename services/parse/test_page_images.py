"""Tests for page rasterization (oss-489).

`pdf_pages_to_images` imported `fitz` (PyMuPDF) — a dependency declared in
neither Dockerfile and installed in no image — inside a bare
`except (ImportError, Exception): return []`. So `/page-images` answered every
request with `{"images": [], "pages": 0}` and HTTP 200, and the classifier's
vision tier plus the vision-OCR parse fallback silently did nothing on the
docker backend. These tests pin the two properties that were missing: it
actually renders, and it fails loudly when it can't.

Skipped where the parse service's heavy deps aren't installed (e.g. the
playbook CLI CI); they run in the parse service's own test image.
"""

import base64
import io
import sys
from pathlib import Path

import pytest

pytest.importorskip("docling")
pytest.importorskip("fastapi")
pytest.importorskip("sse_starlette")

import pypdfium2 as pdfium  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from services.parse.main import pdf_pages_to_images  # noqa: E402

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _pdf(pages: int) -> bytes:
    """A minimal multi-page PDF, built with the renderer's own library."""
    doc = pdfium.PdfDocument.new()
    for _ in range(pages):
        doc.new_page(612, 792)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def test_renders_every_page_as_png(tmp_path):
    src = tmp_path / "doc.pdf"
    src.write_bytes(_pdf(3))

    images = pdf_pages_to_images(str(src), max_pages=10)

    assert len(images) == 3
    for encoded in images:
        assert base64.b64decode(encoded).startswith(PNG_MAGIC)


def test_caps_at_max_pages(tmp_path):
    src = tmp_path / "doc.pdf"
    src.write_bytes(_pdf(5))

    assert len(pdf_pages_to_images(str(src), max_pages=2)) == 2


def test_raises_instead_of_returning_an_empty_list(tmp_path):
    """The regression this file exists for: an unreadable document must not be
    reported as a document with no pages."""
    src = tmp_path / "broken.pdf"
    src.write_bytes(b"this is not a pdf")

    with pytest.raises(Exception):
        pdf_pages_to_images(str(src))
