"""Tests for space-mangled text-layer detection + poppler recovery (oss-400).

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


class TestLooksSpaceMangled:
    def test_detects_collapsed_phrases(self):
        # Whole phrases collapsed into single tokens, as Type-3 fonts produce.
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
        assert main._looks_space_mangled(md) is True

    def test_clean_prose_not_flagged(self):
        md = (
            "Issued to Acme Corporation on March 15, 2026. Total amount payable "
            "within thirty days. Line items below detail the services rendered "
            "during the billing period from January to March. Please remit payment "
            "via bank transfer or check made out to our accounts receivable "
            "department for the full outstanding balance shown on this invoice."
        )
        assert main._looks_space_mangled(md) is False

    def test_occasional_long_tokens_not_flagged(self):
        # A few long URLs stay under the 10% threshold.
        tokens = ["https://example.com/very/long/path/segment" if i % 15 == 0 else "word" for i in range(90)]
        assert main._looks_space_mangled(" ".join(tokens)) is False

    def test_short_input_not_flagged(self):
        # Under 50 tokens — not enough signal.
        assert main._looks_space_mangled("STATEFARMFIREANDCASUALTYCOMPANY foo bar") is False

    def test_empty_and_none(self):
        assert main._looks_space_mangled("") is False
        assert main._looks_space_mangled(None) is False


class TestPopplerExtractUnavailable:
    def test_returns_none_when_pdftotext_missing(self, monkeypatch):
        def _raise(*_args, **_kwargs):
            raise FileNotFoundError("pdftotext")

        monkeypatch.setattr(main.subprocess, "run", _raise)
        assert main._poppler_extract("/nonexistent.pdf") is None
