"""Tests for parallel page-range parsing helpers.

These tests exercise the pure functions (_split_pdf, _merge_chunk_results)
and page-offset arithmetic without requiring GPU, Docling, or Modal.
Only pymupdf (fitz) is needed.
"""

from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock

# ---------------------------------------------------------------------------
# Mock modal before importing app.py so we don't need the modal package.
# The pure functions under test don't use Modal at all — only the decorated
# functions (parse, parse_chunk, parse_http) do.
# ---------------------------------------------------------------------------

_modal_mock = types.ModuleType("modal")
_modal_mock.App = MagicMock(return_value=MagicMock())
# Image needs to support chained calls: .debian_slim().apt_install().pip_install().run_commands()
_modal_mock.Image = MagicMock()
_modal_mock.fastapi_endpoint = MagicMock(return_value=lambda f: f)

# modal.App().function() is used as a decorator — make it return identity
_app_instance = _modal_mock.App.return_value
_app_instance.function = MagicMock(return_value=lambda f: f)

sys.modules["modal"] = _modal_mock

# Mock fastapi if not installed (app.py imports Request at module level)
if "fastapi" not in sys.modules:
    _fastapi_mock = types.ModuleType("fastapi")
    _fastapi_mock.Request = MagicMock()
    sys.modules["fastapi"] = _fastapi_mock

import fitz
import pytest

from app import _merge_chunk_results, _split_pdf


# ---------------------------------------------------------------------------
# Test fixture: create synthetic PDFs with N pages
# ---------------------------------------------------------------------------


def _make_pdf(num_pages: int) -> bytes:
    """Create a minimal PDF with `num_pages` blank pages using pymupdf."""
    doc = fitz.open()
    for i in range(num_pages):
        page = doc.new_page()
        # Add text so we can verify page identity when needed
        page.insert_text((72, 72), f"Page {i + 1}")
    pdf_bytes = doc.tobytes()
    doc.close()
    return pdf_bytes


def _page_count(pdf_bytes: bytes) -> int:
    """Return the number of pages in a PDF."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    count = len(doc)
    doc.close()
    return count


def _get_page_text(pdf_bytes: bytes, page_idx: int) -> str:
    """Return the text on a specific page (0-indexed)."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    text = doc[page_idx].get_text("text").strip()
    doc.close()
    return text


# ===================================================================
# _split_pdf tests
# ===================================================================


class TestSplitPdf:
    """Tests for _split_pdf."""

    def test_single_page(self):
        """A 1-page PDF produces a single chunk with pages 1-1."""
        pdf = _make_pdf(1)
        chunks = _split_pdf(pdf, chunk_size=50)
        assert len(chunks) == 1
        chunk_bytes, start, end = chunks[0]
        assert start == 1
        assert end == 1
        assert _page_count(chunk_bytes) == 1

    def test_under_chunk_size(self):
        """A 49-page PDF (under the 50-page threshold) stays as one chunk."""
        pdf = _make_pdf(49)
        chunks = _split_pdf(pdf, chunk_size=50)
        assert len(chunks) == 1
        chunk_bytes, start, end = chunks[0]
        assert start == 1
        assert end == 49
        assert _page_count(chunk_bytes) == 49

    def test_exact_chunk_size(self):
        """A 50-page PDF produces exactly one chunk."""
        pdf = _make_pdf(50)
        chunks = _split_pdf(pdf, chunk_size=50)
        assert len(chunks) == 1
        chunk_bytes, start, end = chunks[0]
        assert start == 1
        assert end == 50
        assert _page_count(chunk_bytes) == 50

    def test_one_over_chunk_size(self):
        """A 51-page PDF produces two chunks: 50 + 1."""
        pdf = _make_pdf(51)
        chunks = _split_pdf(pdf, chunk_size=50)
        assert len(chunks) == 2

        b1, s1, e1 = chunks[0]
        assert (s1, e1) == (1, 50)
        assert _page_count(b1) == 50

        b2, s2, e2 = chunks[1]
        assert (s2, e2) == (51, 51)
        assert _page_count(b2) == 1

    def test_100_pages(self):
        """A 100-page PDF splits into exactly 2 chunks of 50."""
        pdf = _make_pdf(100)
        chunks = _split_pdf(pdf, chunk_size=50)
        assert len(chunks) == 2

        for i, (chunk_bytes, start, end) in enumerate(chunks):
            assert _page_count(chunk_bytes) == 50
            assert start == i * 50 + 1
            assert end == (i + 1) * 50

    def test_252_pages(self):
        """A 252-page PDF splits into 6 chunks: 5x50 + 1x2."""
        pdf = _make_pdf(252)
        chunks = _split_pdf(pdf, chunk_size=50)
        assert len(chunks) == 6

        # First 5 chunks: 50 pages each
        for i in range(5):
            chunk_bytes, start, end = chunks[i]
            assert _page_count(chunk_bytes) == 50
            assert start == i * 50 + 1
            assert end == (i + 1) * 50

        # Last chunk: 2 pages
        chunk_bytes, start, end = chunks[5]
        assert _page_count(chunk_bytes) == 2
        assert start == 251
        assert end == 252

    def test_all_pages_covered(self):
        """Every page from the original PDF appears in exactly one chunk."""
        pdf = _make_pdf(130)
        chunks = _split_pdf(pdf, chunk_size=50)

        # Collect all page ranges
        covered = set()
        for _chunk_bytes, start, end in chunks:
            for p in range(start, end + 1):
                assert p not in covered, f"Page {p} appears in multiple chunks"
                covered.add(p)

        assert covered == set(range(1, 131))

    def test_chunks_are_valid_pdfs(self):
        """Each chunk can be opened as a valid PDF."""
        pdf = _make_pdf(120)
        chunks = _split_pdf(pdf, chunk_size=50)

        for chunk_bytes, _start, _end in chunks:
            doc = fitz.open(stream=chunk_bytes, filetype="pdf")
            assert len(doc) > 0
            doc.close()

    def test_page_content_preserved(self):
        """Text content on each page is preserved after splitting."""
        pdf = _make_pdf(75)
        chunks = _split_pdf(pdf, chunk_size=50)

        # Check first page of first chunk
        text = _get_page_text(chunks[0][0], 0)
        assert "Page 1" in text

        # Check first page of second chunk (should be original page 51)
        text = _get_page_text(chunks[1][0], 0)
        assert "Page 51" in text

    def test_custom_chunk_size(self):
        """Non-default chunk sizes work correctly."""
        pdf = _make_pdf(25)
        chunks = _split_pdf(pdf, chunk_size=10)
        assert len(chunks) == 3  # 10 + 10 + 5

        assert _page_count(chunks[0][0]) == 10
        assert _page_count(chunks[1][0]) == 10
        assert _page_count(chunks[2][0]) == 5

    def test_single_page_pdf(self):
        """A single-page PDF returns one chunk."""
        pdf_bytes = _make_pdf(1)
        chunks = _split_pdf(pdf_bytes, chunk_size=50)
        assert len(chunks) == 1
        assert chunks[0][1] == 1  # start page
        assert chunks[0][2] == 1  # end page


# ===================================================================
# _merge_chunk_results tests
# ===================================================================


class TestMergeChunkResults:
    """Tests for _merge_chunk_results."""

    def test_single_chunk_passthrough(self):
        """A single chunk result is returned as-is (with total_pages set)."""
        chunk = {
            "markdown": "# Hello\nWorld",
            "pages": 10,
            "ocr_skipped": False,
            "text_map": [{"text": "Hello", "page": 1, "bbox": {}}],
        }
        result = _merge_chunk_results([chunk], total_pages=10)
        assert result["markdown"] == "# Hello\nWorld"
        assert result["pages"] == 10
        assert result["ocr_skipped"] is False
        assert len(result["text_map"]) == 1

    def test_markdown_concatenation_order(self):
        """Markdown from multiple chunks is joined with double newlines in order."""
        chunks = [
            {"markdown": "# Chunk 1", "pages": 50, "ocr_skipped": False, "text_map": []},
            {"markdown": "# Chunk 2", "pages": 50, "ocr_skipped": False, "text_map": []},
            {"markdown": "# Chunk 3", "pages": 2, "ocr_skipped": False, "text_map": []},
        ]
        result = _merge_chunk_results(chunks, total_pages=102)
        assert result["markdown"] == "# Chunk 1\n\n# Chunk 2\n\n# Chunk 3"

    def test_text_map_concatenation(self):
        """Text maps from all chunks are concatenated in order."""
        chunks = [
            {
                "markdown": "A",
                "pages": 50,
                "ocr_skipped": False,
                "text_map": [
                    {"text": "seg1", "page": 1, "bbox": {}},
                    {"text": "seg2", "page": 30, "bbox": {}},
                ],
            },
            {
                "markdown": "B",
                "pages": 50,
                "ocr_skipped": False,
                "text_map": [
                    {"text": "seg3", "page": 51, "bbox": {}},
                    {"text": "seg4", "page": 80, "bbox": {}},
                ],
            },
        ]
        result = _merge_chunk_results(chunks, total_pages=100)
        assert len(result["text_map"]) == 4
        assert result["text_map"][0]["text"] == "seg1"
        assert result["text_map"][0]["page"] == 1
        assert result["text_map"][2]["text"] == "seg3"
        assert result["text_map"][2]["page"] == 51

    def test_empty_text_map_handling(self):
        """Chunks with empty text_map are handled gracefully."""
        chunks = [
            {"markdown": "A", "pages": 50, "ocr_skipped": False, "text_map": []},
            {
                "markdown": "B",
                "pages": 50,
                "ocr_skipped": False,
                "text_map": [{"text": "x", "page": 51, "bbox": {}}],
            },
            {"markdown": "C", "pages": 2, "ocr_skipped": False, "text_map": []},
        ]
        result = _merge_chunk_results(chunks, total_pages=102)
        assert len(result["text_map"]) == 1
        assert result["text_map"][0]["page"] == 51

    def test_total_pages_set(self):
        """The result always uses the provided total_pages, not the sum of chunk pages."""
        chunks = [
            {"markdown": "A", "pages": 50, "ocr_skipped": False, "text_map": []},
            {"markdown": "B", "pages": 3, "ocr_skipped": False, "text_map": []},
        ]
        result = _merge_chunk_results(chunks, total_pages=53)
        assert result["pages"] == 53

    def test_ocr_skipped_always_false(self):
        """Parallel path is only used for scanned PDFs, so ocr_skipped is always False."""
        chunks = [
            {"markdown": "A", "pages": 50, "ocr_skipped": True, "text_map": []},
        ]
        # Even if a chunk says ocr_skipped=True, the merged result should be False
        # because the parallel path is only for scanned docs (OCR is always run)
        result = _merge_chunk_results(chunks, total_pages=50)
        assert result["ocr_skipped"] is False

    def test_empty_chunks_list(self):
        """An empty chunk list returns an empty result."""
        result = _merge_chunk_results([], total_pages=0)
        assert result["markdown"] == ""
        assert result["pages"] == 0
        assert result["text_map"] == []
        assert result["ocr_skipped"] is False

    def test_empty_markdown_skipped_in_join(self):
        """Chunks with empty markdown don't produce extra blank separators."""
        chunks = [
            {"markdown": "A", "pages": 50, "ocr_skipped": False, "text_map": []},
            {"markdown": "", "pages": 50, "ocr_skipped": False, "text_map": []},
            {"markdown": "C", "pages": 2, "ocr_skipped": False, "text_map": []},
        ]
        result = _merge_chunk_results(chunks, total_pages=102)
        assert result["markdown"] == "A\n\nC"

    def test_response_shape(self):
        """The merged result has exactly the expected keys."""
        chunks = [
            {"markdown": "A", "pages": 50, "ocr_skipped": False, "text_map": []},
        ]
        result = _merge_chunk_results(chunks, total_pages=50)
        assert set(result.keys()) == {"markdown", "pages", "ocr_skipped", "text_map"}


# ===================================================================
# Page offset arithmetic tests
# ===================================================================


class TestPageOffsetArithmetic:
    """Test that page offsets are computed correctly for the starmap args."""

    def test_first_chunk_offset_zero(self):
        """First chunk (pages 1-50) should have offset 0."""
        pdf = _make_pdf(100)
        chunks = _split_pdf(pdf, chunk_size=50)

        # Simulate the args_list construction from parse()
        args_list = [
            (chunk_bytes, start - 1, "test.pdf", None)
            for chunk_bytes, start, _end in chunks
        ]

        # First chunk: offset should be 0
        assert args_list[0][1] == 0

    def test_second_chunk_offset_50(self):
        """Second chunk (pages 51-100) should have offset 50."""
        pdf = _make_pdf(100)
        chunks = _split_pdf(pdf, chunk_size=50)

        args_list = [
            (chunk_bytes, start - 1, "test.pdf", None)
            for chunk_bytes, start, _end in chunks
        ]

        # Second chunk: offset should be 50
        assert args_list[1][1] == 50

    def test_offsets_for_252_pages(self):
        """Verify all offsets for a 252-page document."""
        pdf = _make_pdf(252)
        chunks = _split_pdf(pdf, chunk_size=50)

        args_list = [
            (chunk_bytes, start - 1, "test.pdf", None)
            for chunk_bytes, start, _end in chunks
        ]

        expected_offsets = [0, 50, 100, 150, 200, 250]
        actual_offsets = [args[1] for args in args_list]
        assert actual_offsets == expected_offsets

    def test_text_map_offset_applied(self):
        """Simulate what parse_chunk does: offset text_map page numbers."""
        # Simulate a chunk result with text_map having chunk-local page numbers
        chunk_result = {
            "markdown": "content",
            "pages": 50,
            "ocr_skipped": False,
            "text_map": [
                {"text": "first", "page": 1, "bbox": {}},
                {"text": "last", "page": 50, "bbox": {}},
            ],
        }

        # Apply offset as parse_chunk would for the second chunk (offset=50)
        page_offset = 50
        if page_offset > 0:
            for segment in chunk_result["text_map"]:
                segment["page"] = segment["page"] + page_offset

        assert chunk_result["text_map"][0]["page"] == 51
        assert chunk_result["text_map"][1]["page"] == 100

    def test_text_map_no_offset_for_first_chunk(self):
        """First chunk (offset=0) leaves text_map page numbers unchanged."""
        chunk_result = {
            "markdown": "content",
            "pages": 50,
            "ocr_skipped": False,
            "text_map": [
                {"text": "first", "page": 1, "bbox": {}},
                {"text": "mid", "page": 25, "bbox": {}},
            ],
        }

        page_offset = 0
        if page_offset > 0:
            for segment in chunk_result["text_map"]:
                segment["page"] = segment["page"] + page_offset

        assert chunk_result["text_map"][0]["page"] == 1
        assert chunk_result["text_map"][1]["page"] == 25

    def test_end_to_end_merge_with_offsets(self):
        """Full simulation: split, compute offsets, apply to text_maps, merge."""
        # Simulate 3-chunk scenario (120 pages)
        chunk_results = [
            {
                "markdown": "Chunk 1 content",
                "pages": 50,
                "ocr_skipped": False,
                "text_map": [
                    {"text": "a", "page": 1, "bbox": {}},   # offset 0 → page 1
                    {"text": "b", "page": 50, "bbox": {}},  # offset 0 → page 50
                ],
            },
            {
                "markdown": "Chunk 2 content",
                "pages": 50,
                "ocr_skipped": False,
                "text_map": [
                    {"text": "c", "page": 51, "bbox": {}},  # already offset by parse_chunk
                    {"text": "d", "page": 100, "bbox": {}},
                ],
            },
            {
                "markdown": "Chunk 3 content",
                "pages": 20,
                "ocr_skipped": False,
                "text_map": [
                    {"text": "e", "page": 101, "bbox": {}},
                    {"text": "f", "page": 120, "bbox": {}},
                ],
            },
        ]

        result = _merge_chunk_results(chunk_results, total_pages=120)

        assert result["pages"] == 120
        assert result["markdown"] == "Chunk 1 content\n\nChunk 2 content\n\nChunk 3 content"
        assert len(result["text_map"]) == 6

        # Verify page numbers are in ascending order
        pages = [seg["page"] for seg in result["text_map"]]
        assert pages == [1, 50, 51, 100, 101, 120]
