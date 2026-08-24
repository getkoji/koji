"""Tests for glyph-name garble detection + the backend-cached converter.

The parse service imports docling/fastapi at module load, so these are skipped
in environments without those heavy deps (e.g. the playbook CLI CI) and run in
the parse service's own test image.
"""

import sys
from pathlib import Path

import pytest

pytest.importorskip("docling")
pytest.importorskip("fastapi")
pytest.importorskip("sse_starlette")

sys.path.insert(0, str(Path(__file__).parent))
import main  # noqa: E402


class TestHasGlyphGarble:
    def test_detects_uni_escapes(self):
        assert main._has_glyph_garble("BALLANM/uni004F/uni004F R H/uni004F M E") is True

    def test_clean_text_not_flagged(self):
        assert main._has_glyph_garble("BALLANMOOR HOMEOWNERS ASSN INC C/O CUSICK") is False

    def test_empty_and_none(self):
        assert main._has_glyph_garble("") is False
        assert main._has_glyph_garble(None) is False

    def test_lowercase_hex_matches(self):
        assert main._has_glyph_garble("X/uni00af Y") is True

    def test_non_hex_not_matched(self):
        # "/uniZZZZ" is not a valid glyph escape — must not false-positive.
        assert main._has_glyph_garble("see /unique value") is False
        assert main._has_glyph_garble("X/uniZZZZ Y") is False


class TestLooksUndecodable:
    """oss-434: a broken/absent ToUnicode CMap makes Docling emit unresolved
    glyphs as `/NNN` / `/iNNN` index escapes (verified against the failing doc's
    real Docling output)."""

    def test_detects_glyph_index_escapes(self):
        # Docling's real output signature for the failing document.
        garbage = "/14 /2 /49 /28 /0 /1 /2 /3 /4 /5 /i255 /7 /8 /9 /18 /19 /20 " * 100
        assert main._looks_undecodable(garbage) is True

    def test_clean_prose_not_flagged(self):
        clean = "NOTICE OF PRIVACY PRACTICES. At Northgate we value your business. " * 100
        assert main._looks_undecodable(clean) is False

    def test_dates_fractions_and_paths_not_flagged(self):
        # Slashes in real text (dates, fractions, paths, and/or) are part of
        # longer tokens or not digit-led, so they must not false-positive.
        text = "See 12/25/2026 or 24/7 support, ratio 1/2, path /usr/bin, N/A and/or c/o. " * 100
        assert main._looks_undecodable(text) is False

    def test_legitimate_accented_text_not_flagged(self):
        text = "Café Müller — naïve résumé €50 “quoted” façade Zürich " * 100
        assert main._looks_undecodable(text) is False

    def test_short_and_empty_not_flagged(self):
        assert main._looks_undecodable("") is False
        assert main._looks_undecodable(None) is False
        assert main._looks_undecodable("/14 /2 /49") is False  # under the min-token floor


class TestConverterCache:
    def test_cached_per_backend(self):
        d1 = main.get_converter(ocr=False, backend="default")
        d2 = main.get_converter(ocr=False, backend="default")
        p = main.get_converter(ocr=False, backend="pypdfium")
        assert d1 is d2  # same (ocr, backend) → cached instance
        assert d1 is not p  # distinct backend → distinct converter

    def test_cached_per_ocr(self):
        assert main.get_converter(ocr=False) is not main.get_converter(ocr=True)
