"""Tests for koji bench — corpus benchmark runner."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

from cli.bench import (
    DocumentEntry,
    _unwrap_extracted,
    benchmark_document,
    discover_categories,
    discover_documents,
    format_report,
    run_bench,
)

# ── Fixtures ──────────────────────────────────────────────────────────


def _make_corpus(tmp_path: Path) -> Path:
    """Build a minimal valid corpus tree in a tmp dir."""
    root = tmp_path / "corpus"

    # Category: invoices
    inv = root / "invoices"
    (inv / "documents").mkdir(parents=True)
    (inv / "expected").mkdir(parents=True)
    (inv / "manifests").mkdir(parents=True)
    (inv / "schemas").mkdir(parents=True)

    (inv / "schemas" / "invoice_basic.yaml").write_text(
        "name: invoice_basic\nfields:\n  merchant_name:\n    type: string\n    required: true\n"
    )

    # Document 1
    (inv / "documents" / "sample_01.md").write_text("# Invoice\n\nMerchant: Acme Corp\nTotal: $100.00\n")
    (inv / "expected" / "sample_01.expected.json").write_text(
        json.dumps({"merchant_name": "Acme Corp", "total_amount": 100.00})
    )
    (inv / "manifests" / "sample_01.json").write_text(
        json.dumps({"filename": "sample_01.md", "schema": "invoices/schemas/invoice_basic.yaml"})
    )

    # Document 2
    (inv / "documents" / "sample_02.md").write_text("# Invoice\n\nMerchant: Widget Co\nTotal: $250.00\n")
    (inv / "expected" / "sample_02.expected.json").write_text(
        json.dumps({"merchant_name": "Widget Co", "total_amount": 250.00})
    )
    (inv / "manifests" / "sample_02.json").write_text(
        json.dumps({"filename": "sample_02.md", "schema": "invoices/schemas/invoice_basic.yaml"})
    )

    return root


def _make_mock_response(status_code: int, body: dict) -> MagicMock:
    """Create a mock httpx Response."""
    response = MagicMock()
    response.status_code = status_code
    response.json.return_value = body
    return response


def _make_mock_client(responses: list) -> MagicMock:
    """Create a mock httpx Client that returns the given responses in order."""
    client = MagicMock()
    client.post.side_effect = responses
    return client


# ── Corpus discovery ──────────────────────────────────────────────────


class TestDiscoverCategories:
    def test_finds_valid_category(self, tmp_path):
        root = _make_corpus(tmp_path)
        categories = discover_categories(root)
        assert categories == ["invoices"]

    def test_empty_corpus(self, tmp_path):
        (tmp_path / "corpus").mkdir()
        assert discover_categories(tmp_path / "corpus") == []

    def test_missing_corpus(self, tmp_path):
        assert discover_categories(tmp_path / "nonexistent") == []

    def test_skips_category_missing_required_dir(self, tmp_path):
        root = tmp_path / "corpus"
        partial = root / "partial"
        (partial / "documents").mkdir(parents=True)
        (partial / "expected").mkdir(parents=True)
        # Missing manifests/ and schemas/ — should be skipped
        assert discover_categories(root) == []

    def test_skips_hidden_and_dunder(self, tmp_path):
        root = tmp_path / "corpus"
        root.mkdir()
        for hidden in [".git", "_internal", ".hidden"]:
            d = root / hidden
            for sub in ["documents", "expected", "manifests", "schemas"]:
                (d / sub).mkdir(parents=True)
        assert discover_categories(root) == []

    def test_sorted_alphabetically(self, tmp_path):
        root = tmp_path / "corpus"
        for name in ["zebra", "alpha", "mango"]:
            d = root / name
            for sub in ["documents", "expected", "manifests", "schemas"]:
                (d / sub).mkdir(parents=True)
        assert discover_categories(root) == ["alpha", "mango", "zebra"]


class TestDiscoverDocuments:
    def test_finds_all_documents(self, tmp_path):
        root = _make_corpus(tmp_path)
        entries = discover_documents(root, "invoices")
        assert len(entries) == 2
        assert {e.document_path.name for e in entries} == {"sample_01.md", "sample_02.md"}

    def test_skips_document_without_expected(self, tmp_path):
        root = _make_corpus(tmp_path)
        # Add a dangling document with no expected file
        (root / "invoices" / "documents" / "orphan.md").write_text("orphan")
        entries = discover_documents(root, "invoices")
        assert len(entries) == 2
        assert "orphan.md" not in {e.document_path.name for e in entries}

    def test_skips_document_without_manifest(self, tmp_path):
        root = _make_corpus(tmp_path)
        (root / "invoices" / "documents" / "no_manifest.md").write_text("x")
        (root / "invoices" / "expected" / "no_manifest.expected.json").write_text("{}")
        # No manifest file — should be skipped
        entries = discover_documents(root, "invoices")
        assert "no_manifest.md" not in {e.document_path.name for e in entries}

    def test_skips_manifest_with_missing_schema(self, tmp_path):
        root = _make_corpus(tmp_path)
        (root / "invoices" / "documents" / "bad_schema.md").write_text("x")
        (root / "invoices" / "expected" / "bad_schema.expected.json").write_text("{}")
        (root / "invoices" / "manifests" / "bad_schema.json").write_text(
            json.dumps({"schema": "invoices/schemas/does_not_exist.yaml"})
        )
        entries = discover_documents(root, "invoices")
        assert "bad_schema.md" not in {e.document_path.name for e in entries}

    def test_skips_manifest_without_schema_field(self, tmp_path):
        root = _make_corpus(tmp_path)
        (root / "invoices" / "documents" / "no_schema.md").write_text("x")
        (root / "invoices" / "expected" / "no_schema.expected.json").write_text("{}")
        (root / "invoices" / "manifests" / "no_schema.json").write_text(json.dumps({"filename": "no_schema.md"}))
        entries = discover_documents(root, "invoices")
        assert "no_schema.md" not in {e.document_path.name for e in entries}

    def test_returns_empty_for_unknown_category(self, tmp_path):
        root = _make_corpus(tmp_path)
        assert discover_documents(root, "nonexistent") == []

    def test_entries_have_resolved_schema_path(self, tmp_path):
        root = _make_corpus(tmp_path)
        entries = discover_documents(root, "invoices")
        for e in entries:
            assert e.schema_path.exists()
            assert e.schema_path.suffix == ".yaml"


# ── benchmark_document ────────────────────────────────────────────────


class TestBenchmarkDocument:
    def _make_entry(self, tmp_path: Path) -> DocumentEntry:
        root = _make_corpus(tmp_path)
        entries = discover_documents(root, "invoices")
        return entries[0]  # sample_01

    def test_successful_extraction_matches_expected(self, tmp_path):
        entry = self._make_entry(tmp_path)
        client = _make_mock_client(
            [
                _make_mock_response(
                    200,
                    {"extracted": {"merchant_name": "Acme Corp", "total_amount": 100.00}},
                )
            ]
        )
        result = benchmark_document(entry, "http://test", None, client)
        assert result.error is None
        assert result.total == 2
        assert result.passed == 2
        assert result.all_passed

    def test_partial_match(self, tmp_path):
        entry = self._make_entry(tmp_path)
        # Merchant wrong, total correct
        client = _make_mock_client(
            [
                _make_mock_response(
                    200,
                    {"extracted": {"merchant_name": "Wrong Name", "total_amount": 100.00}},
                )
            ]
        )
        result = benchmark_document(entry, "http://test", None, client)
        assert result.total == 2
        assert result.passed == 1
        assert not result.all_passed

    def test_missing_field_fails(self, tmp_path):
        entry = self._make_entry(tmp_path)
        client = _make_mock_client(
            [
                _make_mock_response(200, {"extracted": {"merchant_name": "Acme Corp"}}),
            ]
        )
        result = benchmark_document(entry, "http://test", None, client)
        assert result.passed == 1  # merchant_name
        # total_amount missing → failure

    def test_http_error_recorded(self, tmp_path):
        entry = self._make_entry(tmp_path)
        client = _make_mock_client([_make_mock_response(500, {"error": "boom"})])
        result = benchmark_document(entry, "http://test", None, client)
        assert result.error is not None
        assert "boom" in result.error or "500" in result.error

    def test_connection_error_recorded(self, tmp_path):
        entry = self._make_entry(tmp_path)
        client = MagicMock()
        client.post.side_effect = ConnectionError("connection refused")
        result = benchmark_document(entry, "http://test", None, client)
        assert result.error is not None
        assert "connection refused" in result.error

    def test_model_parameter_forwarded(self, tmp_path):
        entry = self._make_entry(tmp_path)
        client = _make_mock_client(
            [_make_mock_response(200, {"extracted": {"merchant_name": "Acme Corp", "total_amount": 100.00}})]
        )
        benchmark_document(entry, "http://test", "openai/gpt-4o-mini", client)
        call_kwargs = client.post.call_args.kwargs
        assert call_kwargs["json"]["model"] == "openai/gpt-4o-mini"

    def test_elapsed_ms_recorded(self, tmp_path):
        entry = self._make_entry(tmp_path)
        client = _make_mock_client(
            [_make_mock_response(200, {"extracted": {"merchant_name": "Acme Corp", "total_amount": 100.00}})]
        )
        result = benchmark_document(entry, "http://test", None, client)
        assert result.elapsed_ms >= 0

    def test_fuzzy_number_match(self, tmp_path):
        entry = self._make_entry(tmp_path)
        # 100 vs 100.00 should pass
        client = _make_mock_client(
            [_make_mock_response(200, {"extracted": {"merchant_name": "Acme Corp", "total_amount": 100}})]
        )
        result = benchmark_document(entry, "http://test", None, client)
        assert result.passed == 2


# ── Classify-wrapped response shape (oss-54) ────────────────────────


class TestUnwrapExtracted:
    """Unit tests for the classify-aware response unwrapper.

    Before oss-54, bench.py naively did `data.get("extracted", data)`
    which returned the whole response dict for classify-wrapped shapes,
    producing 0/N field matches for every doc in a classify-enabled run.
    """

    def test_flat_shape_returns_extracted(self):
        data = {"extracted": {"field_a": 1, "field_b": 2}}
        assert _unwrap_extracted(data) == {"field_a": 1, "field_b": 2}

    def test_single_wrapped_section(self):
        data = {
            "sections": [
                {
                    "section_type": "invoice",
                    "extracted": {"merchant": "Acme", "total": 100},
                }
            ],
            "classifier": {"total_sections": 1},
        }
        assert _unwrap_extracted(data) == {"merchant": "Acme", "total": 100}

    def test_multi_section_merges_field_wise(self):
        """Stapled packet with multiple same-type sections — union the fields,
        first non-null wins per key, so bench can score against a single
        expected JSON."""
        data = {
            "sections": [
                {"section_type": "invoice", "extracted": {"merchant": "Acme", "total": None}},
                {"section_type": "invoice", "extracted": {"merchant": None, "total": 100}},
                {"section_type": "invoice", "extracted": {"merchant": "Widget", "total": 200}},
            ]
        }
        result = _unwrap_extracted(data)
        # first non-null wins
        assert result == {"merchant": "Acme", "total": 100}

    def test_zero_matching_sections_returns_empty_dict(self):
        """apply_to didn't match any section — classifier correctly
        refused. Return an empty dict so compare_results can score
        against expected naturally (all-null expected → all-pass,
        non-null expected → fails the field, but doesn't blow up
        the doc as an error). Regression guard for oss-63."""
        data = {
            "sections": [],
            "classifier": {
                "total_sections": 3,
                "sections_matched": 0,
                "reason": "no_matching_section",
            },
        }
        assert _unwrap_extracted(data) == {}

    def test_section_without_extracted_is_empty_dict(self):
        """Defensive: a section with no `extracted` key produces {} for
        that section, not a crash."""
        data = {"sections": [{"section_type": "invoice"}]}
        assert _unwrap_extracted(data) == {}

    def test_multi_section_skips_non_dict_extracted(self):
        data = {
            "sections": [
                {"section_type": "x", "extracted": "not a dict"},
                {"section_type": "x", "extracted": {"merchant": "Acme"}},
            ]
        }
        assert _unwrap_extracted(data) == {"merchant": "Acme"}

    def test_non_dict_input_returns_none(self):
        assert _unwrap_extracted(None) is None
        assert _unwrap_extracted("string") is None
        assert _unwrap_extracted([1, 2, 3]) is None


class TestBenchmarkDocumentClassifyShape:
    """End-to-end bench against the two shapes (regression guards)."""

    def _make_entry(self, tmp_path: Path) -> DocumentEntry:
        root = _make_corpus(tmp_path)
        entries = discover_documents(root, "invoices")
        return entries[0]

    def test_classify_single_section_scores_correctly(self, tmp_path):
        entry = self._make_entry(tmp_path)
        client = _make_mock_client(
            [
                _make_mock_response(
                    200,
                    {
                        "sections": [
                            {
                                "section_type": "invoice",
                                "section_title": "Section 0 — invoice",
                                "chunk_indices": [0, 1],
                                "extracted": {"merchant_name": "Acme Corp", "total_amount": 100.00},
                                "confidence": {"merchant_name": "high", "total_amount": "high"},
                            }
                        ],
                        "classifier": {
                            "model": "openai/gpt-4o-mini",
                            "total_sections": 1,
                            "sections_matched": 1,
                        },
                    },
                )
            ]
        )
        result = benchmark_document(entry, "http://test", None, client)
        assert result.error is None
        assert result.total == 2
        assert result.passed == 2
        assert result.all_passed

    def test_classify_no_matching_sections_scores_against_expected(self, tmp_path):
        """oss-63: zero matching sections is not a doc error. It's a
        correctly-null extraction that gets compared against the expected
        JSON field-by-field. Adversarial cases with all-null expected
        pass; cases with non-null expected fail their fields (which is
        the accurate score)."""
        entry = self._make_entry(tmp_path)  # sample_01, non-null expected
        client = _make_mock_client(
            [
                _make_mock_response(
                    200,
                    {
                        "sections": [],
                        "classifier": {
                            "total_sections": 2,
                            "sections_matched": 0,
                            "reason": "no_matching_section",
                        },
                    },
                )
            ]
        )
        result = benchmark_document(entry, "http://test", None, client)
        # No doc error — the classifier gave us a valid (empty) answer.
        assert result.error is None
        # Expected has two non-null fields, actual is empty → 0/2.
        assert result.total == 2
        assert result.passed == 0
        assert not result.all_passed

    def test_classify_no_matching_sections_all_null_expected_passes(self, tmp_path):
        """Adversarial doc where the corpus expected JSON is all-null
        (e.g. a recipe handed to an SEC schema). Classifier refuses,
        actual={}, null-aware comparator scores it as all-pass."""
        root = _make_corpus(tmp_path)
        # Add an all-null adversarial entry — matches the convention
        # used by corpus/adversarial/anomaly_out_of_scope.
        inv = root / "invoices"
        (inv / "documents" / "adversarial.md").write_text("# Recipe\n\nChocolate chip cookies.\n")
        (inv / "expected" / "adversarial.expected.json").write_text(
            json.dumps({"merchant_name": None, "total_amount": None})
        )
        (inv / "manifests" / "adversarial.json").write_text(
            json.dumps({"filename": "adversarial.md", "schema": "invoices/schemas/invoice_basic.yaml"})
        )
        entries = [e for e in discover_documents(root, "invoices") if "adversarial" in e.document_path.name]
        assert entries, "adversarial entry not discovered"
        entry = entries[0]

        client = _make_mock_client(
            [
                _make_mock_response(
                    200,
                    {
                        "sections": [],
                        "classifier": {
                            "total_sections": 1,
                            "sections_matched": 0,
                            "reason": "no_matching_section",
                        },
                    },
                )
            ]
        )
        result = benchmark_document(entry, "http://test", None, client)
        assert result.error is None
        assert result.total == 2
        assert result.passed == 2
        assert result.all_passed

    def test_classify_multi_section_merges(self, tmp_path):
        """Stapled packet with three invoices → merged fields beat expected."""
        entry = self._make_entry(tmp_path)
        client = _make_mock_client(
            [
                _make_mock_response(
                    200,
                    {
                        "sections": [
                            {
                                "section_type": "invoice",
                                "extracted": {"merchant_name": "Acme Corp", "total_amount": None},
                            },
                            {
                                "section_type": "invoice",
                                "extracted": {"merchant_name": None, "total_amount": 100.00},
                            },
                        ],
                    },
                )
            ]
        )
        result = benchmark_document(entry, "http://test", None, client)
        assert result.error is None
        # Merged: Acme Corp + total_amount 100 → both fields match expected
        assert result.passed == 2


# ── run_bench aggregation ─────────────────────────────────────────────


class TestRunBench:
    def test_aggregates_category_results(self, tmp_path):
        root = _make_corpus(tmp_path)
        client = _make_mock_client(
            [
                _make_mock_response(200, {"extracted": {"merchant_name": "Acme Corp", "total_amount": 100.00}}),
                _make_mock_response(200, {"extracted": {"merchant_name": "Widget Co", "total_amount": 250.00}}),
            ]
        )
        result = run_bench(
            corpus_root=root,
            server_url="http://test",
            model=None,
            http_client=client,
        )
        assert result.total_documents == 2
        assert result.total_fields == 4
        assert result.passed_fields == 4
        assert result.accuracy == 1.0
        assert result.all_passed

    def test_category_filter(self, tmp_path):
        root = _make_corpus(tmp_path)

        # Add a second category
        receipts = root / "receipts"
        for sub in ["documents", "expected", "manifests", "schemas"]:
            (receipts / sub).mkdir(parents=True)
        (receipts / "schemas" / "receipt.yaml").write_text("name: receipt\nfields:\n  store:\n    type: string\n")
        (receipts / "documents" / "r1.md").write_text("x")
        (receipts / "expected" / "r1.expected.json").write_text(json.dumps({"store": "Big Mart"}))
        (receipts / "manifests" / "r1.json").write_text(json.dumps({"schema": "receipts/schemas/receipt.yaml"}))

        client = _make_mock_client(
            [
                _make_mock_response(200, {"extracted": {"merchant_name": "Acme Corp", "total_amount": 100.00}}),
                _make_mock_response(200, {"extracted": {"merchant_name": "Widget Co", "total_amount": 250.00}}),
            ]
        )
        result = run_bench(
            corpus_root=root,
            server_url="http://test",
            model=None,
            http_client=client,
            category_filter="invoices",
        )
        assert len(result.category_results) == 1
        assert result.category_results[0].category == "invoices"
        assert result.total_documents == 2

    def test_document_limit(self, tmp_path):
        root = _make_corpus(tmp_path)
        client = _make_mock_client(
            [
                _make_mock_response(200, {"extracted": {"merchant_name": "Acme Corp", "total_amount": 100.00}}),
            ]
        )
        result = run_bench(
            corpus_root=root,
            server_url="http://test",
            model=None,
            http_client=client,
            document_limit=1,
        )
        assert result.total_documents == 1

    def test_all_passed_false_on_regression(self, tmp_path):
        root = _make_corpus(tmp_path)
        client = _make_mock_client(
            [
                _make_mock_response(200, {"extracted": {"merchant_name": "WRONG", "total_amount": 100.00}}),
                _make_mock_response(200, {"extracted": {"merchant_name": "Widget Co", "total_amount": 250.00}}),
            ]
        )
        result = run_bench(
            corpus_root=root,
            server_url="http://test",
            model=None,
            http_client=client,
        )
        assert not result.all_passed
        assert result.passed_fields == 3  # 1 failure out of 4

    def test_all_passed_false_on_error(self, tmp_path):
        root = _make_corpus(tmp_path)
        client = _make_mock_client(
            [
                _make_mock_response(500, {"error": "boom"}),
                _make_mock_response(200, {"extracted": {"merchant_name": "Widget Co", "total_amount": 250.00}}),
            ]
        )
        result = run_bench(
            corpus_root=root,
            server_url="http://test",
            model=None,
            http_client=client,
        )
        assert not result.all_passed
        assert result.error_count == 1


# ── Report formatting ────────────────────────────────────────────────


class TestFormatReport:
    def test_shows_per_category_summary(self, tmp_path):
        root = _make_corpus(tmp_path)
        client = _make_mock_client(
            [
                _make_mock_response(200, {"extracted": {"merchant_name": "Acme Corp", "total_amount": 100.00}}),
                _make_mock_response(200, {"extracted": {"merchant_name": "Widget Co", "total_amount": 250.00}}),
            ]
        )
        result = run_bench(
            corpus_root=root,
            server_url="http://test",
            model="openai/gpt-4o-mini",
            http_client=client,
        )
        report = format_report(result)
        assert "invoices" in report
        assert "openai/gpt-4o-mini" in report
        assert "TOTAL" in report
        assert "100.0%" in report or "100%" in report

    def test_shows_failures(self, tmp_path):
        root = _make_corpus(tmp_path)
        client = _make_mock_client(
            [
                _make_mock_response(200, {"extracted": {"merchant_name": "WRONG", "total_amount": 100.00}}),
                _make_mock_response(200, {"extracted": {"merchant_name": "Widget Co", "total_amount": 250.00}}),
            ]
        )
        result = run_bench(
            corpus_root=root,
            server_url="http://test",
            model=None,
            http_client=client,
        )
        report = format_report(result)
        assert "merchant_name" in report

    def test_shows_errors(self, tmp_path):
        root = _make_corpus(tmp_path)
        client = _make_mock_client(
            [
                _make_mock_response(500, {"error": "extract service down"}),
                _make_mock_response(200, {"extracted": {"merchant_name": "Widget Co", "total_amount": 250.00}}),
            ]
        )
        result = run_bench(
            corpus_root=root,
            server_url="http://test",
            model=None,
            http_client=client,
        )
        report = format_report(result)
        assert "extract service down" in report or "500" in report
        assert "Errors" in report


# ── to_dict (JSON output) ────────────────────────────────────────────


class TestToDict:
    def test_roundtrip(self, tmp_path):
        root = _make_corpus(tmp_path)
        client = _make_mock_client(
            [
                _make_mock_response(200, {"extracted": {"merchant_name": "Acme Corp", "total_amount": 100.00}}),
                _make_mock_response(200, {"extracted": {"merchant_name": "Widget Co", "total_amount": 250.00}}),
            ]
        )
        result = run_bench(
            corpus_root=root,
            server_url="http://test",
            model="test-model",
            http_client=client,
        )
        data = result.to_dict()
        # Should be JSON-serializable
        encoded = json.dumps(data)
        decoded = json.loads(encoded)

        assert decoded["model"] == "test-model"
        assert decoded["total_documents"] == 2
        assert decoded["accuracy"] == 1.0
        assert len(decoded["categories"]) == 1
        assert decoded["categories"][0]["category"] == "invoices"

    def test_failures_only_in_output(self, tmp_path):
        root = _make_corpus(tmp_path)
        client = _make_mock_client(
            [
                _make_mock_response(200, {"extracted": {"merchant_name": "WRONG", "total_amount": 100.00}}),
                _make_mock_response(200, {"extracted": {"merchant_name": "Widget Co", "total_amount": 250.00}}),
            ]
        )
        result = run_bench(
            corpus_root=root,
            server_url="http://test",
            model=None,
            http_client=client,
        )
        data = result.to_dict()
        docs = data["categories"][0]["documents_detail"]
        # First doc has one failure, second has none
        assert len(docs[0]["failures"]) == 1
        assert len(docs[1]["failures"]) == 0
        assert docs[0]["failures"][0]["field"] == "merchant_name"
