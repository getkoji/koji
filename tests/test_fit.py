"""Tests for the schema-level document-fit check (services/extract/fit.py)."""

from __future__ import annotations

import json

from services.extract.fit import (
    FitConfig,
    assemble,
    check_assertion,
    check_derived,
    check_keywords,
)
from services.extract.pipeline import intelligent_extract
from tests.conftest import MockProvider

# A schema with two required fields used as the default anchors.
SCHEMA = {
    "name": "insurance_policy",
    "fields": {
        "policy_number": {"type": "string", "required": True},
        "insured_name": {"type": "string", "required": True},
        "notes": {"type": "string"},
    },
}


# ── FitConfig.from_schema ────────────────────────────────────────────


class TestFitConfig:
    def test_no_block_returns_none(self):
        assert FitConfig.from_schema({"fields": {}}) is None
        assert FitConfig.from_schema({"fit": {}}) is None
        assert FitConfig.from_schema(None) is None

    def test_full_block_parses(self):
        cfg = FitConfig.from_schema(
            {
                "fit": {
                    "keywords": ["Policy", "Insured"],
                    "min_keywords": 2,
                    "requires": "an insurance policy",
                    "anchor_fields": ["policy_number"],
                    "min_score": 0.6,
                    "on_misfit": "reject",
                }
            }
        )
        assert cfg.keywords == ("policy", "insured")  # lowercased
        assert cfg.min_keywords == 2
        assert cfg.requires == "an insurance policy"
        assert cfg.anchor_fields == ("policy_number",)
        assert cfg.min_score == 0.6
        assert cfg.on_misfit == "reject"
        assert cfg.has_pre_gate is True

    def test_invalid_values_fall_back_to_defaults(self):
        cfg = FitConfig.from_schema(
            {
                "fit": {
                    "min_keywords": 0,  # invalid → 1
                    "min_score": 5,  # out of range → 0.4
                    "on_misfit": "explode",  # invalid → warn
                    "requires": "   ",  # blank → None
                }
            }
        )
        assert cfg.min_keywords == 1
        assert cfg.min_score == 0.4
        assert cfg.on_misfit == "warn"
        assert cfg.requires is None
        assert cfg.has_pre_gate is False  # no keywords, no requires

    def test_bool_is_not_a_valid_min_keywords(self):
        # bool is a subclass of int; make sure True/False don't sneak through
        cfg = FitConfig.from_schema({"fit": {"min_keywords": True, "keywords": ["x"]}})
        assert cfg.min_keywords == 1


# ── check_keywords ───────────────────────────────────────────────────


class TestCheckKeywords:
    def test_none_when_no_keywords(self):
        cfg = FitConfig.from_schema({"fit": {"requires": "x"}})
        assert check_keywords("anything", cfg) is None

    def test_pass(self):
        cfg = FitConfig.from_schema({"fit": {"keywords": ["policy", "insured"], "min_keywords": 2}})
        check = check_keywords("This POLICY covers the INSURED party.", cfg)
        assert check.ok is True
        assert check.detail["matched"] == 2

    def test_fail(self):
        cfg = FitConfig.from_schema({"fit": {"keywords": ["policy", "insured", "premium"], "min_keywords": 2}})
        check = check_keywords("This is an invoice for services.", cfg)
        assert check.ok is False
        assert check.detail["matched"] == 0


# ── check_derived ────────────────────────────────────────────────────


class TestCheckDerived:
    def test_defaults_to_required_fields(self):
        cfg = FitConfig.from_schema({"fit": {"min_score": 0.4}})
        # Both required anchors grounded
        check = check_derived({"policy_number": 1.0, "insured_name": 0.9, "notes": 0.0}, cfg, SCHEMA)
        assert check.detail["anchor_fields"] == ["policy_number", "insured_name"]
        assert check.detail["anchors_total"] == 2
        assert check.ok is True

    def test_misfit_when_anchors_ungrounded(self):
        cfg = FitConfig.from_schema({"fit": {"min_score": 0.4}})
        check = check_derived({"policy_number": 0.0, "insured_name": 0.0}, cfg, SCHEMA)
        assert check.ok is False
        assert check.detail["score"] == 0.0
        assert check.detail["anchors_found"] == 0

    def test_explicit_anchor_fields(self):
        cfg = FitConfig.from_schema({"fit": {"anchor_fields": ["policy_number"], "min_score": 0.5}})
        check = check_derived({"policy_number": 0.9, "insured_name": 0.0}, cfg, SCHEMA)
        assert check.detail["anchor_fields"] == ["policy_number"]
        assert check.ok is True

    def test_missing_score_treated_as_zero(self):
        cfg = FitConfig.from_schema({"fit": {"min_score": 0.4}})
        check = check_derived({}, cfg, SCHEMA)  # no scores at all
        assert check.ok is False
        assert check.detail["score"] == 0.0


# ── check_assertion ──────────────────────────────────────────────────


class TestCheckAssertion:
    async def test_matches_true(self):
        cfg = FitConfig.from_schema({"fit": {"requires": "an insurance policy"}})
        provider = MockProvider(responses=[json.dumps({"matches": True, "reason": "looks like a policy"})])
        check = await check_assertion("Policy declarations...", cfg, provider)
        assert check.ok is True
        assert check.detail["reason"] == "looks like a policy"

    async def test_matches_false(self):
        cfg = FitConfig.from_schema({"fit": {"requires": "an insurance policy"}})
        provider = MockProvider(responses=[json.dumps({"matches": False, "reason": "this is an invoice"})])
        check = await check_assertion("Invoice #123...", cfg, provider)
        assert check.ok is False

    async def test_garbage_response_fails_open(self):
        cfg = FitConfig.from_schema({"fit": {"requires": "an insurance policy"}})
        provider = MockProvider(responses=["not json at all"])
        check = await check_assertion("...", cfg, provider)
        assert check.ok is True  # fail-open

    async def test_provider_exception_fails_open(self):
        cfg = FitConfig.from_schema({"fit": {"requires": "an insurance policy"}})

        class FailingProvider:
            async def generate(self, prompt, json_mode=True):
                raise RuntimeError("boom")

        check = await check_assertion("...", cfg, FailingProvider())
        assert check.ok is True
        assert check.detail["errored"] is True


# ── assemble ─────────────────────────────────────────────────────────


class TestAssemble:
    def test_all_pass(self):
        cfg = FitConfig.from_schema({"fit": {"keywords": ["x"]}})
        report = assemble([check_keywords("x y z", cfg)], cfg, "doc")
        assert report.ok is True
        assert report.reason is None
        assert report.action == "warn"

    def test_first_failure_drives_reason(self):
        cfg = FitConfig.from_schema({"fit": {"keywords": ["zzz"], "min_keywords": 1, "min_score": 0.4}})
        kw = check_keywords("no match here", cfg)
        derived = check_derived({"policy_number": 0.0, "insured_name": 0.0}, cfg, SCHEMA)
        report = assemble([kw, derived], cfg, "insurance_policy")
        assert report.ok is False
        assert report.reason == "insufficient_keywords"  # keyword check listed first
        assert report.message
        assert report.score == 0.0  # derived score still surfaced

    def test_empty_checks_is_ok(self):
        cfg = FitConfig.from_schema({"fit": {"keywords": ["x"]}})
        report = assemble([None, None], cfg, "doc")
        assert report.ok is True

    def test_to_dict_shape(self):
        cfg = FitConfig.from_schema({"fit": {"keywords": ["x"], "on_misfit": "reject"}})
        report = assemble([check_keywords("nope", cfg)], cfg, "doc", extraction_skipped=True)
        d = report.to_dict()
        assert set(d) == {"ok", "action", "reason", "message", "score", "extraction_skipped", "checks"}
        assert d["action"] == "reject"
        assert d["extraction_skipped"] is True
        assert d["checks"][0]["name"] == "keywords"


# ── Integration through intelligent_extract ──────────────────────────

MARKDOWN_MATCH = "# Insurance Policy\n\nPolicy Number: BOP-99\nInsured: Acme Corp\nThis policy covers the insured."
MARKDOWN_WRONG = "# Invoice\n\nInvoice #555\nBill to: Someone\nThank you for your business."


class TestFitIntegration:
    async def test_warn_misfit_still_extracts_and_flags(self, monkeypatch):
        # Wrong document: provider returns nulls (nothing grounded).
        provider = MockProvider(responses=[json.dumps({"policy_number": None, "insured_name": None})])
        monkeypatch.setattr("services.extract.pipeline.create_provider", lambda model: provider)

        schema = {**SCHEMA, "fit": {"min_score": 0.4, "on_misfit": "warn"}}
        result = await intelligent_extract(markdown=MARKDOWN_WRONG, schema_def=schema, model="mock/test")

        assert "fit" in result
        assert result["fit"]["ok"] is False
        assert result["fit"]["reason"] == "low_field_grounding"
        # warn still returns extracted payload (not skipped)
        assert result["fit"]["extraction_skipped"] is False
        assert "extracted" in result

    async def test_reject_keyword_gate_skips_extraction(self, monkeypatch):
        # Provider should never be called for extraction — keyword gate rejects first.
        provider = MockProvider(responses=[json.dumps({"policy_number": "X"})])
        monkeypatch.setattr("services.extract.pipeline.create_provider", lambda model: provider)

        schema = {
            **SCHEMA,
            "fit": {"keywords": ["policy", "insured", "premium"], "min_keywords": 2, "on_misfit": "reject"},
        }
        result = await intelligent_extract(markdown=MARKDOWN_WRONG, schema_def=schema, model="mock/test")

        assert result["extracted"] is None
        assert result["fit"]["ok"] is False
        assert result["fit"]["extraction_skipped"] is True
        assert result["extraction_groups"] == 0
        # No extraction calls were made
        assert len(provider.calls) == 0

    async def test_good_document_fits(self, monkeypatch):
        provider = MockProvider(responses=[json.dumps({"policy_number": "BOP-99", "insured_name": "Acme Corp"})])
        monkeypatch.setattr("services.extract.pipeline.create_provider", lambda model: provider)

        schema = {
            **SCHEMA,
            "fit": {"keywords": ["policy", "insured"], "min_keywords": 2, "min_score": 0.4},
        }
        result = await intelligent_extract(markdown=MARKDOWN_MATCH, schema_def=schema, model="mock/test")

        assert result["fit"]["ok"] is True
        assert result["fit"]["score"] >= 0.4

    async def test_no_fit_block_no_fit_key(self, monkeypatch):
        provider = MockProvider(responses=[json.dumps({"policy_number": "BOP-99"})])
        monkeypatch.setattr("services.extract.pipeline.create_provider", lambda model: provider)

        result = await intelligent_extract(markdown=MARKDOWN_MATCH, schema_def=SCHEMA, model="mock/test")
        assert "fit" not in result

    async def test_post_extract_handles_rejected_none_payload(self, monkeypatch):
        # The reject path returns extracted=None; the extract service's
        # normalize/validate pass must tolerate it without raising.
        from services.extract.main import _apply_post_extract

        provider = MockProvider(responses=[json.dumps({"policy_number": "X"})])
        monkeypatch.setattr("services.extract.pipeline.create_provider", lambda model: provider)

        schema = {**SCHEMA, "fit": {"keywords": ["zzz"], "min_keywords": 1, "on_misfit": "reject"}}
        result = await intelligent_extract(markdown=MARKDOWN_WRONG, schema_def=schema, model="mock/test")
        assert result["extracted"] is None

        _apply_post_extract(result, schema)  # must not raise
        assert result["normalization"] == {"applied": [], "warnings": []}
        assert result["validation"] == {"ok": True, "issues": []}
