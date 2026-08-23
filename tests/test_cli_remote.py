"""Tests for the remote loop commands — koji validate / run / corpus."""

from __future__ import annotations

from pathlib import Path

import pytest
import typer
from typer.testing import CliRunner

import cli.remote as remote_mod
from cli.main import app
from cli.remote import (
    _TERMINAL_DOC_STATES,
    _api_error,
    _cap_pdf_pages,
    _classifier_window,
    _diff_fields,
    _elem_labels,
    _expand_input_paths,
    _find_local_schema,
    _fmt_value,
    _format_details,
    _load_schema_arg,
    _looks_like_path,
    _norm,
    _render_array_element_diffs,
    _render_pipeline_docs,
    _render_pipeline_test,
    _resolve_entry,
    _slice_for_upload,
    err_console,
    resolve_api,
)

runner = CliRunner()


# ── Command registration ──────────────────────────────────────────────


@pytest.mark.parametrize(
    "args",
    [
        ["validate", "--help"],
        ["run", "--help"],
        ["corpus", "--help"],
        ["corpus", "ls", "--help"],
        ["corpus", "diff", "--help"],
        ["corpus", "get", "--help"],
        ["corpus", "add", "--help"],
        ["corpus", "rm", "--help"],
        ["corpus", "tag", "--help"],
        ["corpus", "gt", "show", "--help"],
        ["corpus", "gt", "accept", "--help"],
        ["corpus", "gt", "set", "--help"],
        ["pipeline", "run", "--help"],
        ["pipeline", "result", "--help"],
        ["pipeline", "test", "--help"],
    ],
)
def test_commands_registered(args):
    result = runner.invoke(app, args)
    assert result.exit_code == 0, result.output


def test_status_console_writes_to_stderr():
    # push/progress status must go to stderr so --json stdout stays pure JSON
    assert err_console.stderr is True


def test_top_level_help_lists_loop_commands():
    out = runner.invoke(app, ["--help"]).output
    assert "validate" in out
    assert "run" in out
    assert "corpus" in out


# ── resolve_api ───────────────────────────────────────────────────────


def test_resolve_api_env_vars_override(monkeypatch):
    monkeypatch.setenv("KOJI_API_URL", "https://example.test/")
    monkeypatch.setenv("KOJI_API_KEY", "koji_secret")
    base_url, headers = resolve_api()
    assert base_url == "https://example.test"  # trailing slash stripped
    assert headers == {"Authorization": "Bearer koji_secret"}


def test_resolve_api_unauthenticated_exits(monkeypatch):
    monkeypatch.delenv("KOJI_API_URL", raising=False)
    monkeypatch.delenv("KOJI_API_KEY", raising=False)
    monkeypatch.setattr("cli.remote.get_active_profile", lambda: None)
    with pytest.raises(typer.Exit):
        resolve_api()


# ── _norm / _diff_fields (comparison) ─────────────────────────────────


def test_norm_case_and_space_insensitive():
    assert _norm("  Acme Corp ") == _norm("acme corp")
    assert _norm(None) == ""
    assert _norm(["b", "a"]) != _norm(["a", "b"])  # lists are order-sensitive here
    assert _norm({"x": 1, "y": 2}) == _norm({"y": 2, "x": 1})  # dicts sorted


def test_diff_fields_matches_and_mismatches():
    gt = {"invoice_number": "INV-1", "total": "100.00", "vendor": "Acme"}
    extracted = {"invoice_number": "inv-1", "total": "999", "currency": "USD"}
    rows = {r["field"]: r for r in _diff_fields(gt, extracted)}
    assert rows["invoice_number"]["match"] is True  # case-insensitive
    assert rows["total"]["match"] is False
    assert rows["vendor"]["match"] is False  # missing from extraction
    assert rows["currency"]["match"] is False  # missing from ground truth
    # union of keys, sorted
    assert [r["field"] for r in _diff_fields(gt, extracted)] == sorted(
        {"invoice_number", "total", "vendor", "currency"}
    )


# ── _fmt_value ────────────────────────────────────────────────────────


def test_fmt_value_handles_types_and_truncation():
    assert _fmt_value(None) == "—"
    assert _fmt_value({"a": 1}) == '{"a": 1}'
    assert _fmt_value("line1\nline2") == "line1 line2"
    long = "x" * 100
    out = _fmt_value(long, width=10)
    assert len(out) == 10 and out.endswith("…")


# ── entry resolution ──────────────────────────────────────────────────


def _entries():
    return [
        {"id": "abc123", "filename": "acme_2021.pdf"},
        {"id": "def456", "filename": "acme_2022.pdf"},
        {"id": "ghi789", "filename": "gore_renewal.pdf"},
    ]


def test_resolve_entry_by_id():
    assert _resolve_entry(_entries(), "def456")["filename"] == "acme_2022.pdf"


def test_resolve_entry_by_id_prefix():
    # the displayed (truncated) id resolves to the full entry
    assert _resolve_entry(_entries(), "ghi")["filename"] == "gore_renewal.pdf"


def test_resolve_entry_by_exact_filename():
    assert _resolve_entry(_entries(), "gore_renewal.pdf")["id"] == "ghi789"


def test_resolve_entry_by_unique_substring():
    assert _resolve_entry(_entries(), "gore")["id"] == "ghi789"


def test_resolve_entry_ambiguous_substring_exits():
    with pytest.raises(typer.Exit):
        _resolve_entry(_entries(), "acme")  # matches two


def test_resolve_entry_no_match_exits():
    with pytest.raises(typer.Exit):
        _resolve_entry(_entries(), "nope")


# ── schema argument resolution ────────────────────────────────────────


def test_looks_like_path():
    assert _looks_like_path("foo.yaml")
    assert _looks_like_path("schemas/foo.yml")
    assert not _looks_like_path("invoice")


def test_load_schema_arg_from_file(tmp_path: Path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    f = tmp_path / "my.yaml"
    f.write_text("name: my_schema\nfields:\n  a:\n    type: string\n")
    slug, raw, path = _load_schema_arg("my.yaml")
    assert slug == "my_schema"  # derived from `name`, not filename
    assert "fields" in raw
    assert path == Path("my.yaml")


def test_load_schema_arg_bare_slug_finds_local(tmp_path: Path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "schemas").mkdir()
    (tmp_path / "schemas" / "invoice.yaml").write_text("name: invoice\nfields: {}\n")
    assert _find_local_schema("invoice") == Path("schemas") / "invoice.yaml"
    slug, raw, path = _load_schema_arg("invoice")
    assert slug == "invoice"
    assert raw is not None


def test_load_schema_arg_bare_slug_no_local(tmp_path: Path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    slug, raw, path = _load_schema_arg("remote_only")
    assert slug == "remote_only"
    assert raw is None
    assert path is None


def test_load_schema_arg_missing_file_exits(tmp_path: Path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with pytest.raises(typer.Exit):
        _load_schema_arg("does_not_exist.yaml")


# ---------------------------------------------------------------------------
# array element diagnostics (validate --explain)
# ---------------------------------------------------------------------------


def test_elem_labels_prefers_element_key():
    elems = [{"status": "extra", "got": "{ code: UMB, limit: 5000000 }", "key": "UMB"}]
    assert _elem_labels(elems, "got") == "UMB"


def test_elem_labels_falls_back_to_formatted_value():
    elems = [{"status": "missing", "expected": "{ code: PROP }"}]
    assert _elem_labels(elems, "expected") == "{ code: PROP }"


def test_elem_labels_truncates_long_lists():
    elems = [{"status": "extra", "got": f"row{i}", "key": f"K{i}"} for i in range(9)]
    out = _elem_labels(elems, "got")
    assert out.endswith("…+3")
    assert "K5" in out and "K6" not in out


def _capture_render(payload: dict) -> str:
    from rich.console import Console

    import cli.remote as remote

    rec = Console(record=True, width=200)
    orig = remote.console
    remote.console = rec
    try:
        _render_array_element_diffs(payload)
    finally:
        remote.console = orig
    return rec.export_text()


def test_render_array_element_diffs_lists_fp_and_fn_by_key():
    payload = {
        "fields": [
            {
                "name": "coverages",
                "failingDocs": [
                    {
                        "filename": "pkg.pdf",
                        "diff": {
                            "kind": "array",
                            "elements": [
                                {"status": "matched", "expected": "{ code: GL }", "key": "GL"},
                                {"status": "extra", "got": "{ code: UMB }", "key": "UMB"},
                                {"status": "missing", "expected": "{ code: PROP }", "key": "PROP"},
                                {"status": "changed", "expected": "x", "got": "y", "key": "CRIME"},
                            ],
                        },
                    }
                ],
            }
        ]
    }
    out = _capture_render(payload)
    assert "array element diagnostics" in out
    assert "UMB" in out  # FP column
    assert "PROP" in out  # FN column
    assert "GL" not in out  # matched elements are not listed


def test_render_array_element_diffs_silent_without_array_diffs():
    payload = {
        "fields": [
            {
                "name": "insured_name",
                "failingDocs": [{"filename": "a.pdf", "diff": {"kind": "scalar", "expected": "A", "got": "B"}}],
            }
        ]
    }
    assert _capture_render(payload) == ""


# ── Schema-compile error rendering (oss-397) ──────────────────────────


class _FakeResponse:
    """Minimal stand-in for an httpx.Response for _api_error tests."""

    def __init__(self, status_code: int, body: object, text: str = ""):
        self.status_code = status_code
        self._body = body
        self.text = text
        self.request = None

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


def _capture_api_error(resp: _FakeResponse, context: str) -> str:
    from rich.console import Console

    import cli.remote as remote

    rec = Console(record=True, width=200)
    orig = remote.console
    remote.console = rec
    try:
        _api_error(resp, context)
    except typer.Exit:
        pass
    finally:
        remote.console = orig
    return rec.export_text()


def test_format_details_list_of_compiler_errors():
    lines = _format_details(
        [
            {"message": "Map keys must be unique at line 391"},
            {"field": "max_chunks", "message": "element_key set at the wrong level"},
        ]
    )
    assert lines == [
        "Map keys must be unique at line 391",
        "max_chunks: element_key set at the wrong level",
    ]


def test_format_details_string_and_none():
    assert _format_details("plain string reason") == ["plain string reason"]
    assert _format_details(None) == []


def test_api_error_renders_compile_details_not_just_http_422():
    resp = _FakeResponse(
        422,
        {
            "error": "Schema validation failed",
            "details": [
                {"message": "Map keys must be unique at line 391"},
                {"field": "coverages", "message": "unknown property 'max_chunk'"},
            ],
        },
    )
    out = _capture_api_error(resp, "validate insurance_policy")
    # Header still present…
    assert "HTTP 422" in out
    assert "Schema validation failed" in out
    # …but the real cause is no longer swallowed.
    assert "Map keys must be unique at line 391" in out
    assert "coverages: unknown property 'max_chunk'" in out


def test_api_error_falls_back_to_error_then_text():
    # No details[] → use `error`.
    out = _capture_api_error(_FakeResponse(400, {"error": "yaml is required"}), "push foo")
    assert "yaml is required" in out
    # Non-JSON body → fall back to raw text.
    out = _capture_api_error(_FakeResponse(500, None, text="upstream boom"), "validate foo")
    assert "upstream boom" in out


# ── pipeline run: terminal states + input expansion + rendering ───────


def test_terminal_doc_states_includes_delivered():
    # Regression guard: the ingestion pipeline leaves a *successful* document in
    # the "delivered" state (not "completed" — that's a job status). If this set
    # ever drops "delivered", `koji pipeline run` would poll forever on the happy
    # path and time out. "review" and "failed" are the other terminals.
    assert "delivered" in _TERMINAL_DOC_STATES
    assert "review" in _TERMINAL_DOC_STATES
    assert "failed" in _TERMINAL_DOC_STATES


def test_expand_input_paths_file_and_dir(tmp_path: Path):
    a = tmp_path / "a.pdf"
    a.write_text("x")
    sub = tmp_path / "docs"
    sub.mkdir()
    (sub / "b.pdf").write_text("y")
    (sub / "c.pdf").write_text("z")
    (sub / ".hidden").write_text("skip")  # dotfiles are skipped

    # A single file → just that file.
    assert _expand_input_paths([str(a)]) == [a]
    # A directory → its (non-hidden) files, sorted, dotfiles excluded.
    got = _expand_input_paths([str(sub)])
    assert [p.name for p in got] == ["b.pdf", "c.pdf"]


def test_expand_input_paths_missing_exits(tmp_path: Path):
    with pytest.raises(typer.Exit):
        _expand_input_paths([str(tmp_path / "nope.pdf")])


def test_expand_input_paths_empty_dir_exits(tmp_path: Path):
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(typer.Exit):
        _expand_input_paths([str(empty)])


def test_render_pipeline_docs_smoke():
    # A delivered doc with an extraction payload renders without raising, whether
    # or not provenance is requested. (rich would raise on a bad markup string.)
    docs = [
        {
            "filename": "invoice.pdf",
            "status": "delivered",
            "jobSlug": "job-xyz",
            "confidence": 1.0,
            "pageCount": 1,
            "durationMs": 3800,
            "extractionJson": {"total": 739.8, "vendor": "ACME"},
            "confidenceScoresJson": {"total": 1.0, "vendor": 0.4},
            "provenanceJson": {"total": {"chunk": "$739.80"}},
        },
        {"filename": "bad.pdf", "status": "failed", "jobSlug": "job-abc"},
    ]
    _render_pipeline_docs(docs, show_prov=False)
    _render_pipeline_docs(docs, show_prov=True)


# ── pipeline test: dry-run router rendering ───────────────────────────


def test_render_pipeline_test_smoke():
    # A 2-tier router dry-run: classify → route → classify → route → extract.
    # Renders without raising, including escaping LLM reasoning that contains
    # rich-markup-like brackets (would crash console.print if unescaped).
    result = {
        "status": "completed",
        "path": ["classify_kind", "classify_fin", "extract_invoice"],
        "skippedSteps": ["extract_receipt"],
        "totalDurationMs": 2712,
        "totalCostUsd": 0.08,
        "steps": [
            {
                "stepId": "classify_kind",
                "stepType": "classify",
                "status": "completed",
                "durationMs": 1,
                "output": {
                    "label": "financial",
                    "confidence": 1.0,
                    "method": "keyword",
                    "reasoning": "Matched [invoice] and [total]",
                },
                "edgeEvaluations": [
                    {"to": "classify_fin", "condition": "output.label == 'financial'", "matched": True},
                    {"to": "extract_invoice", "condition": "output.label == 'other'", "matched": False},
                ],
            },
            {
                "stepId": "extract_invoice",
                "stepType": "extract",
                "status": "completed",
                "durationMs": 2704,
                "output": {
                    "schema": "invoice",
                    "fieldCount": 2,
                    "totalFields": 2,
                    "confidence": 1.0,
                    "fields": {"invoice_number": "INV-1", "total": 739.8},
                    "confidenceScores": {"invoice_number": 1.0, "total": 0.4},
                },
                "edgeEvaluations": [],
            },
        ],
    }
    _render_pipeline_test("doc-router", "acme.pdf", result)


def test_render_pipeline_test_handles_failed_and_notes():
    # A step that failed / a schema-not-found note must render, not raise.
    result = {
        "status": "completed",
        "path": ["extract_x"],
        "steps": [
            {
                "stepId": "extract_x",
                "stepType": "extract",
                "status": "completed",
                "durationMs": 3,
                "output": {"schema": "x", "note": 'Schema "x" not found or has no committed version'},
                "edgeEvaluations": [],
            },
        ],
    }
    _render_pipeline_test("p", "d.pdf", result)


# ── classify run: PDF page capping ────────────────────────────────────


def _make_pdf(pages: int) -> bytes:
    import io

    from pypdf import PdfWriter

    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(width=200, height=200)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def test_cap_pdf_pages_slices_multipage():
    import io

    from pypdf import PdfReader

    data = _make_pdf(6)
    capped = _cap_pdf_pages(data, 3)
    assert capped is not None
    sliced, kept, total = capped
    assert (kept, total) == (3, 6)
    assert len(PdfReader(io.BytesIO(sliced)).pages) == 3


def test_cap_pdf_pages_none_when_short_or_invalid():
    # PDF already within the cap → no slicing needed.
    assert _cap_pdf_pages(_make_pdf(2), 3) is None
    # Exactly at the cap → no slicing.
    assert _cap_pdf_pages(_make_pdf(3), 3) is None
    # Non-PDF / malformed bytes → None (caller sends original).
    assert _cap_pdf_pages(b"not a pdf at all", 3) is None


# ── classify run: the window the upload has to cover (oss-490) ─────────


def test_classifier_window_takes_the_deepest_class_window():
    """The cascade reads ONE window for every class — the deepest any asks for.
    A hardcoded 3-page upload defeated a class that declared `window: 20`: the
    server never saw the pages carrying its keywords."""
    window, scan = _classifier_window(
        """
classify:
  window: 2
  scan: head
classes:
  invoice:
    keywords: ["invoice"]
  umbrella:
    window: 20
    keywords: ["retained limit"]
"""
    )
    assert (window, scan) == (20, "head")


def test_classifier_window_defaults_and_survives_bad_yaml():
    assert _classifier_window("classes: {invoice: {keywords: [x]}}") == (1, "head")
    assert _classifier_window("scan: [unbalanced") == (1, "head")
    assert _classifier_window("classify:\n  scan: head_and_tail\n  window: 8\n") == (
        8,
        "head_and_tail",
    )


def test_slice_for_upload_sends_a_small_document_whole():
    """The default no longer slices: the server reads only what `window` selects,
    so client-side slicing buys nothing until the upload limit is in play."""
    data = _make_pdf(40)
    assert _slice_for_upload(data, -1, 20, "head") is data


def test_slice_for_upload_honors_an_explicit_max_pages():
    import io

    from pypdf import PdfReader

    sliced = _slice_for_upload(_make_pdf(9), 2, 20, "head")
    assert len(PdfReader(io.BytesIO(sliced)).pages) == 2


def test_slice_for_upload_warns_when_an_explicit_cap_is_under_the_window(capsys):
    _slice_for_upload(_make_pdf(9), 2, 20, "head")
    assert "window of 20" in capsys.readouterr().err


def test_slice_for_upload_slices_an_oversize_document_to_the_window(monkeypatch):
    import io

    from pypdf import PdfReader

    monkeypatch.setattr(remote_mod, "_UPLOAD_SLICE_THRESHOLD", 1)
    sliced = _slice_for_upload(_make_pdf(30), -1, 6, "head")
    assert len(PdfReader(io.BytesIO(sliced)).pages) == 6


def test_slice_for_upload_never_head_slices_a_head_and_tail_window(monkeypatch):
    """A head-only slice would drop the tail pages the server reads, so an
    oversize head_and_tail document goes up whole and the API answers."""
    monkeypatch.setattr(remote_mod, "_UPLOAD_SLICE_THRESHOLD", 1)
    data = _make_pdf(30)
    assert _slice_for_upload(data, -1, 6, "head_and_tail") is data
