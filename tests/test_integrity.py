"""Tests for services/integrity.py — fail-fast intake validation."""

from __future__ import annotations

import pytest

from services.integrity import (
    IntakeLimits,
    IntegrityError,
    check_bytes,
    check_parsed,
)

PDF_HEADER = b"%PDF-1.5\n%\xe2\xe3\xcf\xd3\n"
DOCX_HEADER = b"PK\x03\x04" + b"\x00" * 32
PNG_HEADER = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
JPG_HEADER = b"\xff\xd8\xff\xe0" + b"\x00" * 16


# ── IntakeLimits.from_schema ─────────────────────────────────────────


class TestIntakeLimits:
    def test_no_schema(self):
        limits = IntakeLimits.from_schema(None)
        assert limits.max_size_mb is None
        assert limits.max_pages is None
        assert limits.allowed_types is None

    def test_no_intake_block(self):
        limits = IntakeLimits.from_schema({"fields": {}})
        assert limits.max_size_mb is None

    def test_parses_all_fields(self):
        limits = IntakeLimits.from_schema(
            {
                "intake": {
                    "max_size_mb": 10,
                    "max_pages": 50,
                    "allowed_types": ["pdf", "docx"],
                }
            }
        )
        assert limits.max_size_mb == 10
        assert limits.max_pages == 50
        assert limits.allowed_types == ("pdf", "docx")

    def test_ignores_invalid_values(self):
        limits = IntakeLimits.from_schema({"intake": {"max_size_mb": -1, "max_pages": 0, "allowed_types": []}})
        assert limits.max_size_mb is None
        assert limits.max_pages is None
        assert limits.allowed_types is None

    def test_lowercases_allowed_types(self):
        limits = IntakeLimits.from_schema({"intake": {"allowed_types": ["PDF", "Docx"]}})
        assert limits.allowed_types == ("pdf", "docx")


# ── check_bytes ──────────────────────────────────────────────────────


class TestCheckBytes:
    def test_valid_pdf_passes(self):
        check_bytes(PDF_HEADER + b"\x00" * 512, "sample.pdf")

    def test_valid_docx_passes(self):
        check_bytes(DOCX_HEADER, "sample.docx")

    def test_valid_png_passes(self):
        check_bytes(PNG_HEADER, "image.png")

    def test_valid_jpg_passes(self):
        check_bytes(JPG_HEADER, "photo.jpeg")

    def test_plaintext_markdown_passes_without_magic(self):
        check_bytes(b"# Hello\nworld", "notes.md")

    def test_empty_file_rejected(self):
        with pytest.raises(IntegrityError, match="empty"):
            check_bytes(b"", "sample.pdf")

    def test_missing_extension_rejected(self):
        with pytest.raises(IntegrityError, match="no extension"):
            check_bytes(PDF_HEADER, "sample")

    def test_unsupported_extension_rejected(self):
        with pytest.raises(IntegrityError, match="Unsupported file type"):
            check_bytes(b"anything", "sample.xyz")

    def test_wrong_header_rejected(self):
        with pytest.raises(IntegrityError, match="header does not match"):
            check_bytes(b"Not a PDF at all", "sample.pdf")

    def test_jpg_with_png_bytes_rejected(self):
        with pytest.raises(IntegrityError, match="header does not match"):
            check_bytes(PNG_HEADER, "photo.jpg")

    def test_size_under_limit_passes(self):
        content = PDF_HEADER + b"\x00" * 1024
        limits = IntakeLimits(max_size_mb=1)
        check_bytes(content, "small.pdf", limits)

    def test_size_over_limit_rejected(self):
        content = PDF_HEADER + b"\x00" * (2 * 1024 * 1024)
        limits = IntakeLimits(max_size_mb=1)
        with pytest.raises(IntegrityError, match="exceeds schema limit"):
            check_bytes(content, "big.pdf", limits)

    def test_allowed_types_filter(self):
        limits = IntakeLimits(allowed_types=("pdf",))
        check_bytes(PDF_HEADER, "sample.pdf", limits)
        with pytest.raises(IntegrityError, match="not allowed by this schema"):
            check_bytes(DOCX_HEADER, "sample.docx", limits)


# ── check_parsed ─────────────────────────────────────────────────────


class TestCheckParsed:
    def test_one_page_passes(self):
        check_parsed(1)

    def test_zero_pages_rejected(self):
        with pytest.raises(IntegrityError, match="zero pages"):
            check_parsed(0)

    def test_none_pages_rejected(self):
        with pytest.raises(IntegrityError, match="zero pages"):
            check_parsed(None)

    def test_under_max_pages_passes(self):
        check_parsed(10, IntakeLimits(max_pages=20))

    def test_over_max_pages_rejected(self):
        with pytest.raises(IntegrityError, match="exceeds schema limit"):
            check_parsed(30, IntakeLimits(max_pages=20))

    def test_no_limits_any_positive_passes(self):
        check_parsed(10_000)
