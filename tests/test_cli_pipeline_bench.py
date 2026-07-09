"""Tests for koji pipeline bench — run a corpus against a DAG (pipeline)."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

from cli.pipeline_bench import (
    PipelineBenchResult,
    PipelineDocResult,
    _classify_steps,
    _terminal_extraction,
    bench_document,
    format_report,
    run_pipeline_bench,
    schema_slug,
)

# ── Fixtures ──────────────────────────────────────────────────────────


def _make_mixed_corpus(tmp_path: Path) -> Path:
    """Build a two-category corpus: docs that should route to different schemas."""
    root = tmp_path / "corpus"

    # Category: invoices → schema slug "invoice_basic"
    inv = root / "invoices"
    for sub in ("documents", "expected", "manifests", "schemas"):
        (inv / sub).mkdir(parents=True)
    (inv / "schemas" / "invoice_basic.yaml").write_text(
        "name: invoice_basic\nfields:\n  merchant_name:\n    type: string\n"
    )
    (inv / "documents" / "inv_01.md").write_text("Merchant: Acme Corp\n")
    (inv / "expected" / "inv_01.expected.json").write_text(json.dumps({"merchant_name": "Acme Corp"}))
    (inv / "manifests" / "inv_01.json").write_text(
        json.dumps({"filename": "inv_01.md", "schema": "invoices/schemas/invoice_basic.yaml"})
    )

    # Category: receipts → schema slug "receipt_basic"
    rec = root / "receipts"
    for sub in ("documents", "expected", "manifests", "schemas"):
        (rec / sub).mkdir(parents=True)
    (rec / "schemas" / "receipt_basic.yaml").write_text("name: receipt_basic\nfields:\n  store:\n    type: string\n")
    (rec / "documents" / "rec_01.md").write_text("Store: Widget Co\n")
    (rec / "expected" / "rec_01.expected.json").write_text(json.dumps({"store": "Widget Co"}))
    (rec / "manifests" / "rec_01.json").write_text(
        json.dumps({"filename": "rec_01.md", "schema": "receipts/schemas/receipt_basic.yaml"})
    )

    return root


def _test_response(routed_schema: str | None, fields: dict | None, path: list[str] | None = None):
    """Build a mock /test response with a classify + (optional) extract step."""
    steps: list[dict] = [
        {"stepId": "classify", "stepType": "classify", "status": "completed", "output": {"label": "x"}},
    ]
    if routed_schema is not None:
        steps.append(
            {
                "stepId": "extract",
                "stepType": "extract",
                "status": "completed",
                "output": {"schema": routed_schema, "fields": fields, "fieldCount": len(fields or {})},
            }
        )
    body = {
        "status": "completed",
        "steps": steps,
        "path": path or [s["stepId"] for s in steps],
        "totalCostUsd": 0.001,
    }
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = body
    return resp


def _mock_client(responses: list) -> MagicMock:
    client = MagicMock()
    client.post.side_effect = responses
    return client


# ── schema_slug ───────────────────────────────────────────────────────


class TestSchemaSlug:
    def test_reads_name_field(self, tmp_path):
        p = tmp_path / "s.yaml"
        p.write_text("name: insurance_policy\nfields: {}\n")
        assert schema_slug(p) == "insurance_policy"

    def test_falls_back_to_slug_field(self, tmp_path):
        p = tmp_path / "s.yaml"
        p.write_text("slug: foo_slug\nfields: {}\n")
        assert schema_slug(p) == "foo_slug"

    def test_falls_back_to_stem(self, tmp_path):
        p = tmp_path / "policy_v2.yaml"
        p.write_text("fields: {}\n")
        assert schema_slug(p) == "policy_v2"


# ── _terminal_extraction ──────────────────────────────────────────────


class TestTerminalExtraction:
    def test_picks_extract_step(self):
        steps = [
            {"stepType": "classify", "output": {"label": "a"}},
            {"stepType": "extract", "output": {"schema": "s1", "fields": {"a": 1}}},
        ]
        routed, fields, _ = _terminal_extraction(steps)
        assert routed == "s1"
        assert fields == {"a": 1}

    def test_picks_last_extract_when_multiple(self):
        steps = [
            {"stepType": "extract", "output": {"schema": "s1", "fields": {"a": 1}}},
            {"stepType": "extract", "output": {"schema": "s2", "fields": {"b": 2}}},
        ]
        routed, fields, _ = _terminal_extraction(steps)
        assert routed == "s2"
        assert fields == {"b": 2}

    def test_none_when_no_extract(self):
        steps = [{"stepType": "classify", "output": {"label": "a"}}]
        assert _terminal_extraction(steps) == (None, None, None)

    def test_skips_extract_without_fields(self):
        steps = [{"stepType": "extract", "output": {"schema": "s1", "note": "no match"}}]
        assert _terminal_extraction(steps) == (None, None, None)


# ── bench_document ────────────────────────────────────────────────────


class TestBenchDocument:
    def _entry(self, corpus: Path):
        from cli.bench import discover_documents

        return discover_documents(corpus, "invoices")[0]

    def test_correct_route_and_extraction(self, tmp_path):
        corpus = _make_mixed_corpus(tmp_path)
        entry = self._entry(corpus)
        client = _mock_client([_test_response("invoice_basic", {"merchant_name": "Acme Corp"})])

        result = bench_document(entry, "my-pipeline", "http://x", {}, client)

        assert result.error is None
        assert result.routed_schema == "invoice_basic"
        assert result.expected_schema == "invoice_basic"
        assert result.routing_ok is True
        assert result.scored is True
        assert result.all_passed is True

    def test_misroute_skips_extraction_scoring(self, tmp_path):
        corpus = _make_mixed_corpus(tmp_path)
        entry = self._entry(corpus)
        # Pipeline routed an invoice to the receipt schema.
        client = _mock_client([_test_response("receipt_basic", {"store": "Acme Corp"})])

        result = bench_document(entry, "my-pipeline", "http://x", {}, client)

        assert result.error is None
        assert result.routed_schema == "receipt_basic"
        assert result.routing_ok is False
        assert result.field_results == []  # not scored on a mis-route
        assert result.scored is False

    def test_no_extract_step_is_routing_failure(self, tmp_path):
        corpus = _make_mixed_corpus(tmp_path)
        entry = self._entry(corpus)
        client = _mock_client([_test_response(None, None)])  # dead-ended before extract

        result = bench_document(entry, "my-pipeline", "http://x", {}, client)

        assert result.error is None
        assert result.routed_schema is None
        assert result.routing_ok is False

    def test_extraction_mismatch_counts_field(self, tmp_path):
        corpus = _make_mixed_corpus(tmp_path)
        entry = self._entry(corpus)
        client = _mock_client([_test_response("invoice_basic", {"merchant_name": "Wrong Co"})])

        result = bench_document(entry, "my-pipeline", "http://x", {}, client)

        assert result.routing_ok is True
        assert result.total == 1
        assert result.passed == 0
        assert result.all_passed is False

    def test_http_error_becomes_doc_error(self, tmp_path):
        corpus = _make_mixed_corpus(tmp_path)
        entry = self._entry(corpus)
        resp = MagicMock()
        resp.status_code = 404
        resp.json.return_value = {"error": "Pipeline not found"}
        result = bench_document(entry, "nope", "http://x", {}, _mock_client([resp]))

        assert result.error == "Pipeline not found"
        assert result.routing_ok is False


# ── run_pipeline_bench + aggregation ──────────────────────────────────


class TestRunPipelineBench:
    def test_aggregates_routing_and_extraction(self, tmp_path):
        corpus = _make_mixed_corpus(tmp_path)
        # inv_01 routes correctly and extracts right; rec_01 mis-routes to invoice.
        client = _mock_client(
            [
                _test_response("invoice_basic", {"merchant_name": "Acme Corp"}),
                _test_response("invoice_basic", {"store": "Widget Co"}),
            ]
        )
        result = run_pipeline_bench("p", corpus, "http://x", {}, client)

        assert result.total_documents == 2
        assert result.routable_documents == 2
        assert result.routed_correct == 1
        assert result.routing_accuracy == 0.5
        # Only inv_01 (correctly routed) contributes to extraction scoring.
        assert result.scored_fields == 1
        assert result.passed_fields == 1
        assert result.extraction_accuracy == 1.0

    def test_confusion_matrix_records_misroute(self, tmp_path):
        corpus = _make_mixed_corpus(tmp_path)
        client = _mock_client(
            [
                _test_response("invoice_basic", {"merchant_name": "Acme Corp"}),
                _test_response("invoice_basic", {"store": "x"}),  # receipt → invoice
            ]
        )
        result = run_pipeline_bench("p", corpus, "http://x", {}, client)
        confusion = result.routing_confusion()

        assert confusion["invoice_basic"] == {"invoice_basic": 1}
        assert confusion["receipt_basic"] == {"invoice_basic": 1}

    def test_extraction_by_schema_only_correct_routes(self, tmp_path):
        corpus = _make_mixed_corpus(tmp_path)
        client = _mock_client(
            [
                _test_response("invoice_basic", {"merchant_name": "Acme Corp"}),
                _test_response("receipt_basic", {"store": "Widget Co"}),
            ]
        )
        result = run_pipeline_bench("p", corpus, "http://x", {}, client)
        by_schema = result.extraction_by_schema()

        assert by_schema["invoice_basic"] == (1, 1)
        assert by_schema["receipt_basic"] == (1, 1)

    def test_category_filter(self, tmp_path):
        corpus = _make_mixed_corpus(tmp_path)
        client = _mock_client([_test_response("invoice_basic", {"merchant_name": "Acme Corp"})])
        result = run_pipeline_bench("p", corpus, "http://x", {}, client, category_filter="invoices")

        assert result.total_documents == 1
        assert result.doc_results[0].category == "invoices"

    def test_document_limit(self, tmp_path):
        corpus = _make_mixed_corpus(tmp_path)
        # One extra invoice so the category has 2 docs, then limit to 1.
        inv = corpus / "invoices"
        (inv / "documents" / "inv_02.md").write_text("Merchant: Beta\n")
        (inv / "expected" / "inv_02.expected.json").write_text(json.dumps({"merchant_name": "Beta"}))
        (inv / "manifests" / "inv_02.json").write_text(
            json.dumps({"filename": "inv_02.md", "schema": "invoices/schemas/invoice_basic.yaml"})
        )
        client = _mock_client(
            [
                _test_response("invoice_basic", {"merchant_name": "Acme Corp"}),
                _test_response("receipt_basic", {"store": "Widget Co"}),
            ]
        )
        result = run_pipeline_bench("p", corpus, "http://x", {}, client, document_limit=1)

        # 1 invoice + 1 receipt = 2 docs total (limit is per category).
        assert result.total_documents == 2


# ── format_report ─────────────────────────────────────────────────────


class TestFormatReport:
    def test_report_mentions_routing_and_extraction(self, tmp_path):
        corpus = _make_mixed_corpus(tmp_path)
        client = _mock_client(
            [
                _test_response("invoice_basic", {"merchant_name": "Acme Corp"}),
                _test_response("invoice_basic", {"store": "x"}),  # receipt mis-routed
            ]
        )
        result = run_pipeline_bench("p", corpus, "http://x", {}, client)
        report = format_report(result)

        assert "ROUTING:" in report
        assert "EXTRACTION" in report
        assert "MISROUTE" in report

    def test_empty_result_reports_no_docs(self):
        result = PipelineBenchResult(pipeline="p", corpus_path="/nope")
        assert result.total_documents == 0
        # to_dict must not blow up on an empty run
        assert result.to_dict()["routing"]["accuracy"] == 0.0


# ── PipelineDocResult properties ──────────────────────────────────────


class TestDocResultProps:
    def test_routing_ok_requires_match_and_no_error(self):
        d = PipelineDocResult("d", "c", expected_schema="a", routed_schema="a")
        assert d.routing_ok is True
        d.error = "boom"
        assert d.routing_ok is False


# ── Classify diagnostics ──────────────────────────────────────────────


def _classify_steps_from(outputs: list[dict]):
    """Run raw classify-step outputs through the real parser."""
    return _classify_steps(
        [{"stepId": o.get("stepId", "classify"), "stepType": "classify", "output": o} for o in outputs]
    )


def _classify_response(classify_outputs: list[dict], routed_schema: str | None = None, fields: dict | None = None):
    """A /test response with arbitrary classify step outputs."""
    steps: list[dict] = [
        {"stepId": o.pop("stepId", f"classify_{i}"), "stepType": "classify", "status": "completed", "output": o}
        for i, o in enumerate(classify_outputs)
    ]
    if routed_schema is not None:
        steps.append(
            {
                "stepId": "extract",
                "stepType": "extract",
                "status": "completed",
                "output": {"schema": routed_schema, "fields": fields or {}, "fieldCount": len(fields or {})},
            }
        )
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {"status": "completed", "steps": steps, "path": [], "totalCostUsd": 0.0}
    return resp


class TestClassifyDiagnostics:
    def test_captures_method_and_version_from_test_response(self, tmp_path):
        corpus = _make_mixed_corpus(tmp_path)
        client = _mock_client(
            [
                _classify_response(
                    [
                        {
                            "stepId": "classify_line",
                            "label": "package",
                            "method": "llm",
                            "classifier": "family_line",
                            "classifier_version": "v0.0.1",
                        }
                    ],
                    routed_schema="invoice_basic",
                    fields={"merchant_name": "Acme Corp"},
                ),
                _classify_response(
                    [
                        {
                            "stepId": "classify_line",
                            "label": "package",
                            "method": "llm",
                            "classifier": "family_line",
                            "classifier_version": "v0.0.1",
                        }
                    ],
                    routed_schema="receipt_basic",
                    fields={"store": "Widget Co"},
                ),
            ]
        )
        result = run_pipeline_bench("p", corpus, "http://x", {}, client)

        steps = result.doc_results[0].classify_steps
        assert len(steps) == 1
        assert steps[0].method == "llm"
        assert steps[0].classifier_version == "v0.0.1"
        assert steps[0].decided is True
        assert steps[0].failed_to_run is False
        assert result.classify_method_counts() == {"llm": 2}
        assert result.docs_with_classifier_failures() == []

    def test_distinguishes_resolution_failure_from_genuine_unknown(self):
        """`no_classifier` never inspected the doc; `unknown` looked and couldn't tell."""
        broken = PipelineDocResult("d", "c", expected_schema="a")
        broken.classify_steps = _classify_steps_from(
            [
                {
                    "stepId": "classify_line",
                    "label": "unknown",
                    "method": "no_classifier",
                    "reasoning": "no released version",
                }
            ]
        )
        honest = PipelineDocResult("d", "c", expected_schema="a")
        honest.classify_steps = _classify_steps_from(
            [{"stepId": "classify_line", "label": "unknown", "method": "unknown"}]
        )

        assert broken.classifier_failures and broken.classify_steps[0].failed_to_run
        # A genuine unknown is not a failure — it legitimately routes to default.
        assert honest.classifier_failures == []
        assert honest.classify_steps[0].failed_to_run is False
        assert honest.classify_steps[0].decided is False

    def test_report_shouts_when_a_classifier_never_ran(self, tmp_path):
        """The 0%-routing-with-no-explanation case that motivated this."""
        corpus = _make_mixed_corpus(tmp_path)
        failure = {
            "stepId": "classify_line",
            "label": "unknown",
            "method": "no_provider",
            "reasoning": "no active model endpoint",
        }
        client = _mock_client(
            [
                _classify_response([dict(failure)], routed_schema="policy_generic", fields={}),
                _classify_response([dict(failure)], routed_schema="policy_generic", fields={}),
            ]
        )
        result = run_pipeline_bench("p", corpus, "http://x", {}, client)
        report = format_report(result)

        assert result.routing_accuracy == 0.0
        assert len(result.docs_with_classifier_failures()) == 2
        assert "never inspected the document" in report
        assert "no_provider" in report
        assert "no active model endpoint" in report
        # The trail must explain each misroute inline, too.
        assert "classify_line=unknown(no_provider)" in report

    def test_report_stays_quiet_when_classifiers_ran(self, tmp_path):
        corpus = _make_mixed_corpus(tmp_path)
        client = _mock_client(
            [
                _classify_response(
                    [{"stepId": "c", "label": "inv", "method": "keyword"}],
                    routed_schema="invoice_basic",
                    fields={"merchant_name": "Acme Corp"},
                ),
                _classify_response(
                    [{"stepId": "c", "label": "rec", "method": "keyword"}],
                    routed_schema="receipt_basic",
                    fields={"store": "Widget Co"},
                ),
            ]
        )
        report = format_report(run_pipeline_bench("p", corpus, "http://x", {}, client))

        assert "CLASSIFY: 2 steps — keyword 2" in report
        assert "never inspected the document" not in report

    def test_to_dict_exposes_classify_methods(self, tmp_path):
        corpus = _make_mixed_corpus(tmp_path)
        client = _mock_client(
            [
                _classify_response(
                    [{"stepId": "c", "label": "unknown", "method": "no_version", "reasoning": "no match for v9"}],
                    routed_schema="policy_generic",
                    fields={},
                ),
                _classify_response(
                    [{"stepId": "c", "label": "rec", "method": "llm"}],
                    routed_schema="receipt_basic",
                    fields={"store": "Widget Co"},
                ),
            ]
        )
        d = run_pipeline_bench("p", corpus, "http://x", {}, client).to_dict()

        assert d["classify"]["method_counts"] == {"no_version": 1, "llm": 1}
        assert d["classify"]["docs_with_classifier_failures"] == ["inv_01.md"]
        inv = next(x for x in d["documents"] if x["document"] == "inv_01.md")
        assert inv["classify"][0]["failed_to_run"] is True
        assert inv["classify"][0]["reasoning"] == "no match for v9"
