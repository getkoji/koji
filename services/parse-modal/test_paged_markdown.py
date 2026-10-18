"""Tests for the page contract of the Modal parse service's markdown.

A document with N pages comes back as N page pieces joined by the page break
(``PAGE_SEPARATOR``), piece k being page k. Docling's whole-document export
joins pages with a blank line, so a scanned multi-page document used to come
back as one block of text.
"""

from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock

import pytest

_modal_mock = types.ModuleType("modal")
_modal_mock.App = MagicMock(return_value=MagicMock())
_modal_mock.Image = MagicMock()
_modal_mock.fastapi_endpoint = MagicMock(return_value=lambda f: f)
_modal_mock.App.return_value.function = MagicMock(return_value=lambda f: f)
sys.modules.setdefault("modal", _modal_mock)
if "fastapi" not in sys.modules:
    _fastapi_mock = types.ModuleType("fastapi")
    _fastapi_mock.Request = MagicMock()
    sys.modules["fastapi"] = _fastapi_mock

import fitz  # noqa: E402
from app import (  # noqa: E402
    PAGE_SEPARATOR,
    _join_pages,
    _paged_docling_markdown,
    _raw_text_fallback,
)


class _FakeDoc:
    """Duck-typed DoclingDocument: per-page export plus a whole export."""

    def __init__(self, pages: list[str]):
        self._pages = pages

    def num_pages(self) -> int:
        return len(self._pages)

    def export_to_markdown(self, page_no: int | None = None) -> str:
        if page_no is None:
            return "\n\n".join(p for p in self._pages if p)
        return self._pages[page_no - 1]


def test_join_pages_keeps_empty_slots_and_text():
    md = _join_pages(["one", "", "three"])
    assert md.split(PAGE_SEPARATOR) == ["one", "", "three"]


def test_join_pages_is_empty_when_no_page_has_text():
    assert _join_pages(["", "  ", ""]) == ""


def test_docling_markdown_is_paged_one_piece_per_page():
    doc = _FakeDoc(["# Page one\n\nBody one", "", "Body three"])
    whole = doc.export_to_markdown()
    md = _paged_docling_markdown(doc, whole, "[test]")
    assert md.split(PAGE_SEPARATOR) == ["# Page one\n\nBody one", "", "Body three"]


def test_one_page_docling_markdown_is_unchanged():
    doc = _FakeDoc(["only page"])
    assert _paged_docling_markdown(doc, "only page", "[test]") == "only page"


def test_keeps_whole_markdown_when_per_page_export_would_drop_text():
    # The whole export carries text no page export does — never drop it.
    doc = _FakeDoc(["Body one", "Body two"])
    whole = "Body one\n\nBody two\n\nFooter only in the whole export"
    assert _paged_docling_markdown(doc, whole, "[test]") == whole


def test_keeps_whole_markdown_without_per_page_export():
    class _Old:
        def num_pages(self):
            return 2

        def export_to_markdown(self):
            return "a\n\nb"

    assert _paged_docling_markdown(_Old(), "a\n\nb", "[test]") == "a\n\nb"


def test_raw_text_fallback_is_paged():
    doc = fitz.open()
    for i in range(3):
        page = doc.new_page()
        if i != 1:
            page.insert_text((72, 72), f"Text on page {i + 1}")
    result = _raw_text_fallback(doc.tobytes(), "x.pdf")
    pieces = result["markdown"].split(PAGE_SEPARATOR)
    assert len(pieces) == 3
    assert "Text on page 1" in pieces[0]
    assert "Text on page 3" in pieces[2]


def test_real_docling_document_is_paged():
    """With docling-core installed, a real DoclingDocument pages correctly."""
    dc = pytest.importorskip("docling_core.types.doc")
    doc = dc.DoclingDocument(name="t")
    for n in (1, 2, 3):
        doc.add_page(page_no=n, size=dc.Size(width=600, height=800))
    box = dc.BoundingBox(l=10, t=10, r=100, b=30)
    for n, text in ((1, "First page text"), (3, "Third page text")):
        doc.add_text(
            label=dc.DocItemLabel.TEXT,
            text=text,
            prov=dc.ProvenanceItem(page_no=n, bbox=box, charspan=(0, len(text))),
        )
    md = _paged_docling_markdown(doc, doc.export_to_markdown(), "[test]")
    assert md.split(PAGE_SEPARATOR) == ["First page text", "", "Third page text"]
