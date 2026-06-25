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


class TestConverterCache:
    def test_cached_per_backend(self):
        d1 = main.get_converter(ocr=False, backend="default")
        d2 = main.get_converter(ocr=False, backend="default")
        p = main.get_converter(ocr=False, backend="pypdfium")
        assert d1 is d2  # same (ocr, backend) → cached instance
        assert d1 is not p  # distinct backend → distinct converter

    def test_cached_per_ocr(self):
        assert main.get_converter(ocr=False) is not main.get_converter(ocr=True)
