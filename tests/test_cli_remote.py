"""Tests for the remote loop commands — koji validate / run / corpus."""

from __future__ import annotations

from pathlib import Path

import pytest
import typer
from typer.testing import CliRunner

from cli.main import app
from cli.remote import (
    _api_error,
    _diff_fields,
    _elem_labels,
    _find_local_schema,
    _fmt_value,
    _format_details,
    _load_schema_arg,
    _looks_like_path,
    _norm,
    _render_array_element_diffs,
    _resolve_entry,
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
