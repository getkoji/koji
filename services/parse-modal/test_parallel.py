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

import fitz  # noqa: E402
from app import (  # noqa: E402
    _annotate_md_offsets,
    _merge_chunk_results,
    _raw_text_fallback,
    _should_retry_with_ocr,
    _should_retry_with_pypdfium,
    _split_pdf,
)

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
        args_list = [(chunk_bytes, start - 1, "test.pdf", None) for chunk_bytes, start, _end in chunks]

        # First chunk: offset should be 0
        assert args_list[0][1] == 0

    def test_second_chunk_offset_50(self):
        """Second chunk (pages 51-100) should have offset 50."""
        pdf = _make_pdf(100)
        chunks = _split_pdf(pdf, chunk_size=50)

        args_list = [(chunk_bytes, start - 1, "test.pdf", None) for chunk_bytes, start, _end in chunks]

        # Second chunk: offset should be 50
        assert args_list[1][1] == 50

    def test_offsets_for_252_pages(self):
        """Verify all offsets for a 252-page document."""
        pdf = _make_pdf(252)
        chunks = _split_pdf(pdf, chunk_size=50)

        args_list = [(chunk_bytes, start - 1, "test.pdf", None) for chunk_bytes, start, _end in chunks]

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
                    {"text": "a", "page": 1, "bbox": {}},  # offset 0 → page 1
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


# ---------------------------------------------------------------------------
# OCR-retry decision
#
# When Docling fails on a scanned PDF that slipped past
# `_get_pdf_info`'s heuristic, the parse endpoint retries once with
# force_ocr=True. The decision must:
#   - trigger on the known Docling "no extractable text" wording
#   - NOT trigger if force_ocr was already on (then the heuristic isn't
#     to blame and a retry would just fail the same way)
#   - NOT trigger on unrelated errors
# Drift in the matcher would reintroduce the production 422 we shipped
# this for: "parse 422 (modal): can not retrieve a line, no lines are
# known" on documents the heuristic mis-classifies.
# ---------------------------------------------------------------------------


class TestShouldRetryWithOcr:
    def test_triggers_on_canonical_docling_message(self):
        # The exact wording that surfaced in production.
        msg = "can not retrieve a line, no lines are known"
        assert _should_retry_with_ocr(msg, already_force_ocr=False) is True

    def test_triggers_on_alternate_wordings(self):
        # Docling has drifted across versions — match a couple of
        # equivalent failure phrasings too.
        assert _should_retry_with_ocr("no text found in document", False) is True
        assert _should_retry_with_ocr("Error: no lines parsed", False) is True

    def test_case_insensitive(self):
        assert _should_retry_with_ocr("NO LINES ARE KNOWN", False) is True

    def test_does_not_trigger_when_already_force_ocr(self):
        # If OCR was on for the first attempt and Docling still produced
        # an empty-text error, retrying with the same flag would be a
        # waste — propagate the original error instead.
        msg = "can not retrieve a line, no lines are known"
        assert _should_retry_with_ocr(msg, already_force_ocr=True) is False

    def test_does_not_trigger_on_unrelated_errors(self):
        # Real errors (timeouts, decode failures, OOM) should NOT trip
        # the OCR retry — those won't be fixed by turning on OCR and
        # silently retrying would mask real bugs.
        assert _should_retry_with_ocr("HTTP 504 from Modal", False) is False
        assert _should_retry_with_ocr("Memory limit exceeded", False) is False
        assert _should_retry_with_ocr("Invalid PDF header", False) is False

    def test_handles_none_or_empty(self):
        assert _should_retry_with_ocr(None, False) is False
        assert _should_retry_with_ocr("", False) is False


# ---------------------------------------------------------------------------
# PyPdfium-backend retry decision
#
# When the DoclingParseV2 backend can't even load the page tree (e.g.
# "The Poplar 1.20.2024.pdf" — corrupt xref, missing object refs), OCR
# can't save us because OCR runs AFTER page-load. The third fallback
# layer swaps to the PyPdfium backend, which goes through pypdfium2
# and tolerates malformed PDFs.
#
# Decision rules:
#   - Must be currently on the "default" backend (no point swapping if
#     we're already on pypdfium and STILL hit the same error)
#   - Error message must name an empty-text-layer condition (same
#     marker set as the OCR retry)
# ---------------------------------------------------------------------------


class TestShouldRetryWithPypdfium:
    # The signature error from production for the Poplar PDF — both the
    # initial no-OCR attempt AND the force_ocr=True retry failed with
    # this, because the V2 page-tree parser can't load the document at
    # all.
    POPLAR_ERROR = "can not retrieve a line, no lines are known"

    def test_triggers_on_canonical_v2_backend_error(self):
        assert _should_retry_with_pypdfium(self.POPLAR_ERROR, "default") is True

    def test_triggers_on_alternate_wordings(self):
        assert _should_retry_with_pypdfium("no text found in document", "default") is True

    def test_does_not_trigger_when_already_on_pypdfium(self):
        # If PyPdfium ALSO failed with the same error, the document is
        # genuinely unreadable — propagate the error rather than loop.
        assert _should_retry_with_pypdfium(self.POPLAR_ERROR, "pypdfium") is False

    def test_does_not_trigger_on_unrelated_errors(self):
        # OOM, timeouts, malformed headers — keep these propagating
        # naturally so real bugs don't hide behind a backend swap.
        assert _should_retry_with_pypdfium("HTTP 504 from Modal", "default") is False
        assert _should_retry_with_pypdfium("Memory limit exceeded", "default") is False

    def test_triggers_on_docling_internal_stl_error(self):
        # Sharon Lakes Covenants 2nd Amendment.pdf production error —
        # a C++ STL out-of-bounds from inside docling-parse's native
        # bindings. Different from the Poplar empty-text case but
        # similarly best handled by swapping to PyPdfium because the
        # failure is inside Docling's internals.
        sharon_lakes_error = "basic_string::at: __n (which is 1) >= this->size() (which is 1)"
        assert _should_retry_with_pypdfium(sharon_lakes_error, "default") is True

    def test_triggers_on_other_stl_markers(self):
        # Any std::-prefixed message bubbling up from native bindings —
        # we treat them all as "Docling internal, try a different
        # backend". Wording drifts across Docling versions and we'd
        # rather over-retry on a real error than under-retry and let a
        # parseable document permanently fail.
        assert _should_retry_with_pypdfium("std::out_of_range", "default") is True
        assert _should_retry_with_pypdfium("STL exception: ...", "default") is True

    def test_handles_none_or_empty(self):
        assert _should_retry_with_pypdfium(None, "default") is False
        assert _should_retry_with_pypdfium("", "default") is False


# ---------------------------------------------------------------------------
# Raw-text fallback
#
# When every Docling backend has failed, _raw_text_fallback uses pymupdf
# to pull the text layer out and return a "## Page N\n\n<text>\n\n" markdown
# block per page. Quality-degraded (no layout, no OCR) but better than a
# permanent 422 — the document moves through the pipeline and the user
# sees something.
# ---------------------------------------------------------------------------


class TestRawTextFallback:
    def test_extracts_text_from_a_digital_pdf(self):
        pdf = _make_pdf(3)
        result = _raw_text_fallback(pdf, "test.pdf")
        assert result["pages"] == 3
        assert result["ocr_skipped"] is True
        # _make_pdf writes "Page N" on each page
        assert "Page 1" in result["markdown"]
        assert "Page 2" in result["markdown"]
        assert "Page 3" in result["markdown"]
        # Headings present
        assert "## Page 1" in result["markdown"]
        assert "## Page 2" in result["markdown"]

    def test_returns_parse_response_shape(self):
        # The downstream API consumer expects {markdown, pages,
        # ocr_skipped, text_map} — same keys as the Docling path.
        # Drift would silently break the inngest queue which destructures
        # these.
        pdf = _make_pdf(1)
        result = _raw_text_fallback(pdf, "test.pdf")
        assert set(result.keys()) == {"markdown", "pages", "ocr_skipped", "text_map"}
        assert isinstance(result["markdown"], str)
        assert isinstance(result["pages"], int)
        assert isinstance(result["ocr_skipped"], bool)
        assert isinstance(result["text_map"], list)

    def test_handles_empty_text_layer(self):
        # Scanned PDFs return empty text per page from pymupdf — we
        # still return a result with the page count rather than raise.
        # The user gets a parse "success" but empty content, which is
        # better than a parse 422 that gets stuck.
        pdf = fitz.open()
        pdf.new_page()
        pdf.new_page()
        empty_pdf_bytes = pdf.tobytes()
        pdf.close()

        result = _raw_text_fallback(empty_pdf_bytes, "scanned.pdf")
        assert result["pages"] == 2
        # Markdown has the page headings but no real text content
        assert "## Page 1" in result["markdown"]
        assert "## Page 2" in result["markdown"]


# ---------------------------------------------------------------------------
# L3 provenance — markdown character offset annotation
#
# _annotate_md_offsets stamps each text_map segment with md_offset and
# md_length so downstream extraction (api/src/extract/provenance.ts) can
# resolve bounding boxes via a direct O(n) overlap scan instead of fuzzy
# string matching. Mirrors services/parse/main.py — parity with the
# docker service is the whole point of this app (see module docstring).
#
# Algorithm: single forward pass with a cursor (`pos`) advancing past
# each matched segment, so duplicate text resolves to the next
# occurrence rather than the first one. Segments that can't be located
# are left unannotated (no md_offset field) so the consumer falls back
# to the fuzzy path for those individual segments.
# ---------------------------------------------------------------------------


class TestAnnotateMdOffsets:
    def test_simple_forward_match(self):
        """Segments appearing once in the markdown resolve to their offset."""
        markdown = "Invoice Number: INV-001"
        text_map = [
            {"text": "Invoice", "page": 1, "bbox": {}},
            {"text": "Number:", "page": 1, "bbox": {}},
            {"text": "INV-001", "page": 1, "bbox": {}},
        ]
        _annotate_md_offsets(markdown, text_map)

        assert text_map[0]["md_offset"] == 0
        assert text_map[0]["md_length"] == 7
        assert text_map[1]["md_offset"] == 8
        assert text_map[1]["md_length"] == 7
        assert text_map[2]["md_offset"] == 16
        assert text_map[2]["md_length"] == 7

        # Offsets must point at the exact substring
        for seg in text_map:
            o, n = seg["md_offset"], seg["md_length"]
            assert markdown[o : o + n] == seg["text"]

    def test_duplicate_text_resolves_to_successive_occurrences(self):
        """Cursor advances past each match so duplicates resolve in order.

        Without the cursor, every "2024-03-15" segment would resolve
        to offset 11 (the first occurrence). The forward-cursor design
        ensures the second segment resolves to the second occurrence.
        """
        markdown = "Effective: 2024-03-15\n\nRenewal: 2024-03-15"
        text_map = [
            {"text": "Effective:", "page": 1, "bbox": {}},
            {"text": "2024-03-15", "page": 1, "bbox": {}},
            {"text": "Renewal:", "page": 2, "bbox": {}},
            {"text": "2024-03-15", "page": 2, "bbox": {}},
        ]
        _annotate_md_offsets(markdown, text_map)

        # First "2024-03-15" at offset 11, second at offset 32
        assert text_map[1]["md_offset"] == 11
        assert text_map[3]["md_offset"] == 32
        assert text_map[1]["md_offset"] != text_map[3]["md_offset"]

    def test_case_insensitive_fallback(self):
        """Falls back to case-insensitive search when exact-case fails.

        Docling sometimes upper/lower-cases segment text differently
        from the markdown it exports (e.g. heading normalisation). The
        annotator falls back to a case-insensitive find so those
        segments still get annotated.
        """
        markdown = "Total Amount Due: $500"
        text_map = [
            {"text": "TOTAL", "page": 1, "bbox": {}},  # uppercased
        ]
        _annotate_md_offsets(markdown, text_map)
        assert text_map[0]["md_offset"] == 0
        assert text_map[0]["md_length"] == 5

    def test_unfindable_segment_left_unannotated(self):
        """Segments that don't appear in the markdown get no md_offset.

        Whitespace/encoding differences between Docling's emitted text
        and the markdown can make some segments unfindable. Those
        segments must be left without md_offset so the consumer falls
        back to fuzzy matching for them individually instead of getting
        a wrong offset.
        """
        markdown = "Hello world"
        text_map = [
            {"text": "Hello", "page": 1, "bbox": {}},
            {"text": "NOTFOUND", "page": 1, "bbox": {}},
            {"text": "world", "page": 1, "bbox": {}},
        ]
        _annotate_md_offsets(markdown, text_map)

        assert text_map[0]["md_offset"] == 0
        assert "md_offset" not in text_map[1]
        assert "md_length" not in text_map[1]
        # The cursor stays put after the missing segment, so "world"
        # still resolves correctly.
        assert text_map[2]["md_offset"] == 6

    def test_cursor_prevents_backward_match(self):
        """Once we've passed a position, we don't rewind to match earlier.

        If segment N is unfindable forward of pos, segment N+1 must
        still resolve forward of pos — never to a position earlier in
        the markdown. This prevents an unfindable middle segment from
        causing the rest of the document to misalign.
        """
        markdown = "alpha beta alpha gamma"
        text_map = [
            {"text": "alpha", "page": 1, "bbox": {}},  # first occurrence
            {"text": "beta", "page": 1, "bbox": {}},
            {"text": "alpha", "page": 1, "bbox": {}},  # second occurrence
            {"text": "gamma", "page": 1, "bbox": {}},
        ]
        _annotate_md_offsets(markdown, text_map)

        assert text_map[0]["md_offset"] == 0
        assert text_map[2]["md_offset"] == 11  # the second "alpha", not the first

    def test_handles_empty_text_map(self):
        """Empty text_map is a no-op."""
        markdown = "Hello world"
        text_map: list[dict] = []
        _annotate_md_offsets(markdown, text_map)
        assert text_map == []

    def test_handles_empty_markdown(self):
        """No markdown to match against — every segment left unannotated."""
        markdown = ""
        text_map = [
            {"text": "Hello", "page": 1, "bbox": {}},
        ]
        _annotate_md_offsets(markdown, text_map)
        assert "md_offset" not in text_map[0]

    def test_mutates_in_place(self):
        """Function returns None and mutates the input list."""
        text_map = [{"text": "Hello", "page": 1, "bbox": {}}]
        ret = _annotate_md_offsets("Hello", text_map)
        assert ret is None
        assert text_map[0]["md_offset"] == 0


# ---------------------------------------------------------------------------
# L3 provenance — chunked merge offset adjustment
#
# Each chunk's text_map carries md_offset values local to that chunk's
# markdown. When _merge_chunk_results concatenates chunks with "\n\n"
# separators, those local offsets need to be shifted into the merged
# markdown's coordinate space — otherwise the consumer's offset lookup
# would point at the wrong position in the final document.
# ---------------------------------------------------------------------------


class TestMergeChunkResultsMdOffset:
    def test_single_chunk_offsets_unchanged(self):
        """Single-chunk passthrough leaves md_offset values as-is.

        With one chunk there's no offset shift to apply; the chunk's
        markdown IS the merged markdown.
        """
        chunk = {
            "markdown": "Hello world",
            "pages": 10,
            "ocr_skipped": False,
            "text_map": [
                {"text": "Hello", "page": 1, "bbox": {}, "md_offset": 0, "md_length": 5},
                {"text": "world", "page": 1, "bbox": {}, "md_offset": 6, "md_length": 5},
            ],
        }
        result = _merge_chunk_results([chunk], total_pages=10)
        assert result["text_map"][0]["md_offset"] == 0
        assert result["text_map"][1]["md_offset"] == 6

    def test_two_chunks_shift_by_first_length_plus_separator(self):
        """Second chunk's offsets shift by len(chunk1) + len(separator)."""
        chunk_a = {
            "markdown": "Hello world",  # length 11
            "pages": 50,
            "ocr_skipped": False,
            "text_map": [
                {"text": "Hello", "page": 1, "bbox": {}, "md_offset": 0, "md_length": 5},
                {"text": "world", "page": 1, "bbox": {}, "md_offset": 6, "md_length": 5},
            ],
        }
        chunk_b = {
            "markdown": "Foo bar",  # length 7
            "pages": 50,
            "ocr_skipped": False,
            "text_map": [
                {"text": "Foo", "page": 51, "bbox": {}, "md_offset": 0, "md_length": 3},
                {"text": "bar", "page": 51, "bbox": {}, "md_offset": 4, "md_length": 3},
            ],
        }
        result = _merge_chunk_results([chunk_a, chunk_b], total_pages=100)

        merged_md = result["markdown"]
        assert merged_md == "Hello world\n\nFoo bar"  # 11 + 2 + 7 = 20 chars

        # Chunk A offsets unchanged
        assert result["text_map"][0]["md_offset"] == 0
        assert result["text_map"][1]["md_offset"] == 6
        # Chunk B offsets shifted by 13 (11 + separator len 2)
        assert result["text_map"][2]["md_offset"] == 13
        assert result["text_map"][3]["md_offset"] == 17

        # And each shifted offset must point at the right substring
        for seg in result["text_map"]:
            o, n = seg["md_offset"], seg["md_length"]
            assert merged_md[o : o + n] == seg["text"]

    def test_three_chunks_cumulative_shift(self):
        """Each chunk's offsets shift by the cumulative preceding length."""
        chunks = [
            {
                "markdown": "AAAA",  # len 4
                "pages": 50,
                "ocr_skipped": False,
                "text_map": [{"text": "AAAA", "page": 1, "bbox": {}, "md_offset": 0, "md_length": 4}],
            },
            {
                "markdown": "BB",  # len 2
                "pages": 50,
                "ocr_skipped": False,
                "text_map": [{"text": "BB", "page": 51, "bbox": {}, "md_offset": 0, "md_length": 2}],
            },
            {
                "markdown": "CCC",  # len 3
                "pages": 50,
                "ocr_skipped": False,
                "text_map": [{"text": "CCC", "page": 101, "bbox": {}, "md_offset": 0, "md_length": 3}],
            },
        ]
        result = _merge_chunk_results(chunks, total_pages=150)

        # Merged: "AAAA\n\nBB\n\nCCC"
        # Offsets: A=0, B=4+2=6, C=4+2+2+2=10
        assert result["markdown"] == "AAAA\n\nBB\n\nCCC"
        assert result["text_map"][0]["md_offset"] == 0
        assert result["text_map"][1]["md_offset"] == 6
        assert result["text_map"][2]["md_offset"] == 10
        for seg in result["text_map"]:
            o, n = seg["md_offset"], seg["md_length"]
            assert result["markdown"][o : o + n] == seg["text"]

    def test_segments_without_md_offset_pass_through(self):
        """Segments lacking md_offset are not shifted (defensive merge)."""
        chunks = [
            {
                "markdown": "first",
                "pages": 50,
                "ocr_skipped": False,
                "text_map": [{"text": "first", "page": 1, "bbox": {}, "md_offset": 0, "md_length": 5}],
            },
            {
                "markdown": "second",
                "pages": 50,
                "ocr_skipped": False,
                # No md_offset — segment that the annotator couldn't locate
                "text_map": [{"text": "second", "page": 51, "bbox": {}}],
            },
        ]
        result = _merge_chunk_results(chunks, total_pages=100)
        # First segment annotated, offset unchanged (it was the only one
        # in chunk A which is the leading chunk)
        assert result["text_map"][0]["md_offset"] == 0
        # Second segment — no md_offset means the consumer falls back to
        # fuzzy match. We MUST NOT invent an offset for it.
        assert "md_offset" not in result["text_map"][1]

    def test_empty_chunk_does_not_consume_offset_budget(self):
        """Chunks with empty markdown contribute zero to the running offset.

        Empty-markdown chunks are skipped in the join (no separator
        added either — see existing test_empty_markdown_skipped_in_join)
        so they must also not advance the offset accumulator. Otherwise
        the next chunk's segments would shift too far.
        """
        chunks = [
            {
                "markdown": "Hello",  # len 5
                "pages": 50,
                "ocr_skipped": False,
                "text_map": [{"text": "Hello", "page": 1, "bbox": {}, "md_offset": 0, "md_length": 5}],
            },
            {
                "markdown": "",  # empty chunk
                "pages": 50,
                "ocr_skipped": False,
                "text_map": [],
            },
            {
                "markdown": "world",
                "pages": 2,
                "ocr_skipped": False,
                "text_map": [{"text": "world", "page": 101, "bbox": {}, "md_offset": 0, "md_length": 5}],
            },
        ]
        result = _merge_chunk_results(chunks, total_pages=102)
        # Merged: "Hello\n\nworld" — empty chunk did not introduce a separator
        assert result["markdown"] == "Hello\n\nworld"
        # "world" lives at offset 7 in the merged markdown
        assert result["text_map"][1]["md_offset"] == 7
        assert result["markdown"][7:12] == "world"

    def test_does_not_mutate_input_segments(self):
        """The shift creates new dicts rather than mutating chunk inputs.

        Modal returns chunk results from remote functions; if we
        mutated the dicts in place we'd be reaching across what is
        logically a network boundary and breaking idempotency for
        retries.
        """
        seg = {"text": "Foo", "page": 51, "bbox": {}, "md_offset": 0, "md_length": 3}
        chunks = [
            {
                "markdown": "abc",
                "pages": 50,
                "ocr_skipped": False,
                "text_map": [{"text": "abc", "page": 1, "bbox": {}, "md_offset": 0, "md_length": 3}],
            },
            {
                "markdown": "Foo",
                "pages": 50,
                "ocr_skipped": False,
                "text_map": [seg],
            },
        ]
        _merge_chunk_results(chunks, total_pages=100)
        # Original segment dict still has its original md_offset
        assert seg["md_offset"] == 0


# ---------------------------------------------------------------------------
# L3 provenance — end-to-end via _convert_bytes (synthetic digital PDF)
#
# These tests exercise the full annotate-during-parse path on a tiny
# synthetic PDF, validating that md_offset/md_length actually point at
# the right substring in the exported markdown. Skipped automatically
# when Docling isn't installed (the docker service has docling; the
# Modal image has it; pytest in a bare venv may not).
# ---------------------------------------------------------------------------


class TestConvertBytesMdOffsets:
    def _make_digital_pdf(self) -> bytes:
        """Build a digital PDF with two text segments we can reason about."""
        doc = fitz.open()
        page = doc.new_page()
        page.insert_text((72, 72), "Invoice Number: INV-12345")
        page.insert_text((72, 120), "Total Due: $1,234.56")
        pdf_bytes = doc.tobytes()
        doc.close()
        return pdf_bytes

    def test_segments_carry_offset_into_markdown(self):
        try:
            import docling  # noqa: F401
        except ImportError:
            import pytest

            pytest.skip("docling not installed in this environment")

        from app import _convert_bytes

        pdf = self._make_digital_pdf()
        result = _convert_bytes("invoice.pdf", "application/pdf", pdf)

        text_map = result["text_map"]
        markdown = result["markdown"]
        assert len(text_map) > 0

        # Every annotated segment's (offset, length) must point at the
        # correct substring (case-insensitive — the annotator falls back
        # to case-insensitive matching).
        annotated = [s for s in text_map if "md_offset" in s]
        assert len(annotated) > 0
        for seg in annotated:
            o, n = seg["md_offset"], seg["md_length"]
            assert markdown[o : o + n].lower() == seg["text"].lower()
