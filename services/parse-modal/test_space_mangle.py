"""Tests for space-mangled detection + poppler recovery in the Modal parse
service (oss-401). Mirrors services/parse/test_space_mangle.py.

`modal` and `fastapi` are mocked before importing app.py so the pure helpers
can be exercised without the Modal package or a GPU.
"""

from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock

_modal_mock = types.ModuleType("modal")
_modal_mock.App = MagicMock(return_value=MagicMock())
_modal_mock.Image = MagicMock()
_modal_mock.fastapi_endpoint = MagicMock(return_value=lambda f: f)
_app_instance = _modal_mock.App.return_value
_app_instance.function = MagicMock(return_value=lambda f: f)
sys.modules["modal"] = _modal_mock

if "fastapi" not in sys.modules:
    _fastapi_mock = types.ModuleType("fastapi")
    _fastapi_mock.Request = MagicMock()
    sys.modules["fastapi"] = _fastapi_mock

from app import _looks_space_mangled, _looks_undecodable, _poppler_extract  # noqa: E402


class TestLooksUndecodable:
    """oss-434: a broken/absent ToUnicode CMap makes Docling emit unresolved
    glyphs as `/NNN` / `/iNNN` index escapes. Mirrors
    services/parse/test_glyph_garble.py."""

    def test_detects_glyph_index_escapes(self):
        assert _looks_undecodable("/14 /2 /49 /28 /0 /1 /2 /3 /i255 /7 /8 /9 /18 /19 /20 " * 100) is True

    def test_clean_prose_not_flagged(self):
        assert _looks_undecodable("NOTICE OF PRIVACY PRACTICES. We value your business. " * 100) is False

    def test_dates_fractions_and_paths_not_flagged(self):
        assert _looks_undecodable("See 12/25/2026 or 24/7 support, ratio 1/2, path /usr/bin, N/A. " * 100) is False

    def test_legitimate_accented_text_not_flagged(self):
        assert _looks_undecodable("Café Müller — naïve résumé €50 “quoted” façade Zürich " * 100) is False

    def test_short_and_empty_not_flagged(self):
        assert _looks_undecodable("") is False
        assert _looks_undecodable(None) is False
        assert _looks_undecodable("/14 /2 /49") is False


class TestLooksSpaceMangled:
    def test_detects_collapsed_phrases(self):
        mashed = [
            "STATEFARMFIREANDCASUALTYCOMPANY",
            "ASTOCKCOMPANYWITHHOMEOFFICESINBLOOMINGTONILLINOIS",
            "AUTOMATICRENEWALIFTHEPOLICYPERIODISSHOWNAS12MONTHS",
            "THISPOLICYWILLBERENEWEDAUTOMATICALLYSUBJECTTOTHEPREMIUMS",
            "FORMSINEFFECTFOREACHSUCCEEDINGPOLICYPERIOD",
            "COMPLIANCEWITHTHEPOLICYPROVISIONSORASREQUIREDBYLAW",
        ]
        shorts = [f"w{i}" for i in range(46)]
        md = " ".join(mashed + mashed + shorts)
        assert _looks_space_mangled(md) is True

    def test_clean_prose_not_flagged(self):
        md = (
            "Issued to Acme Corporation on March 15, 2026. Total amount payable "
            "within thirty days. Line items below detail the services rendered "
            "during the billing period from January to March. Please remit payment "
            "via bank transfer or check made out to our accounts receivable "
            "department for the full outstanding balance shown on this invoice."
        )
        assert _looks_space_mangled(md) is False

    def test_occasional_long_tokens_not_flagged(self):
        tokens = ["https://example.com/very/long/path/segment" if i % 15 == 0 else "word" for i in range(90)]
        assert _looks_space_mangled(" ".join(tokens)) is False

    def test_short_input_not_flagged(self):
        assert _looks_space_mangled("STATEFARMFIREANDCASUALTYCOMPANY foo bar") is False

    def test_empty_and_none(self):
        assert _looks_space_mangled("") is False
        assert _looks_space_mangled(None) is False


class TestPopplerExtractUnavailable:
    def test_returns_none_when_pdftotext_missing(self, monkeypatch):
        import subprocess

        def _raise(*_args, **_kwargs):
            raise FileNotFoundError("pdftotext")

        monkeypatch.setattr(subprocess, "run", _raise)
        assert _poppler_extract("/nonexistent.pdf") is None
