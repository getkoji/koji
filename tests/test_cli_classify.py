"""Tests for the classifier loop commands — koji classify run / versions / promote / release."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest
from typer.testing import CliRunner

from cli.main import app
from cli.remote import (
    _find_local_classifier,
    _load_classifier_arg,
)

runner = CliRunner()


@pytest.fixture(autouse=True)
def _isolate_cwd(tmp_path, monkeypatch):
    """Run in an empty temp dir so a bare slug can't collide with a repo directory
    (e.g. `docs/`) and get mistaken for a local path by _looks_like_path."""
    monkeypatch.chdir(tmp_path)


# ── Fixtures / helpers ────────────────────────────────────────────────


def _make_response(status_code: int, body: dict) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = body
    return resp


def _install_client(monkeypatch, responses: list) -> MagicMock:
    """Patch resolve_api + httpx.Client so a command runs against canned responses.

    `responses` are returned in order across get/post calls. Returns the mock
    client so tests can assert on the calls made.
    """
    monkeypatch.setattr(
        "cli.remote.resolve_api", lambda profile_name=None: ("http://test", {"Authorization": "Bearer k"})
    )

    client = MagicMock()
    seq = list(responses)

    def _next(*_args, **_kwargs):
        return seq.pop(0)

    client.get.side_effect = _next
    client.post.side_effect = _next

    ctx = MagicMock()
    ctx.__enter__.return_value = client
    ctx.__exit__.return_value = False
    monkeypatch.setattr("cli.remote.httpx.Client", lambda *a, **k: ctx)
    return client


@pytest.fixture
def doc(tmp_path: Path) -> Path:
    p = tmp_path / "sample.pdf"
    p.write_bytes(b"%PDF-1.4 fake")
    return p


# ── Command registration ──────────────────────────────────────────────


@pytest.mark.parametrize(
    "args",
    [
        ["classify", "--help"],
        ["classify", "run", "--help"],
        ["classify", "versions", "--help"],
        ["classify", "promote", "--help"],
        ["classify", "release", "--help"],
    ],
)
def test_commands_registered(args):
    result = runner.invoke(app, args)
    assert result.exit_code == 0, result.output


def test_top_level_help_lists_classify():
    out = runner.invoke(app, ["--help"]).output
    assert "classify" in out


# ── Local-config resolution ───────────────────────────────────────────


def test_find_local_classifier(tmp_path: Path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "classifiers").mkdir()
    (tmp_path / "classifiers" / "docs.yaml").write_text("name: docs\n")
    assert _find_local_classifier("docs") == Path("classifiers") / "docs.yaml"
    assert _find_local_classifier("missing") is None


def test_load_classifier_arg_from_file(tmp_path: Path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    f = tmp_path / "mine.yaml"
    f.write_text("name: mine\nclasses: []\n")
    slug, local_yaml, path = _load_classifier_arg(str(f))
    assert slug == "mine"
    assert "classes" in local_yaml
    assert path == f


def test_load_classifier_arg_bare_slug_no_local(tmp_path: Path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    slug, local_yaml, path = _load_classifier_arg("docs")
    assert slug == "docs"
    assert local_yaml is None
    assert path is None


def test_load_classifier_arg_missing_file_exits(tmp_path: Path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["classify", "run", "nope.yaml", str(tmp_path)])
    assert result.exit_code != 0


# ── classify run ──────────────────────────────────────────────────────


def test_run_fetches_config_then_classifies(monkeypatch, doc):
    client = _install_client(
        monkeypatch,
        [
            _make_response(200, {"slug": "docs", "latestVersion": {"yamlSource": "name: docs\n"}, "draftYaml": None}),
            _make_response(
                200,
                {"label": "invoice", "confidence": 0.92, "method": "keyword", "tier_used": 1, "evidence_page": 2},
            ),
        ],
    )
    result = runner.invoke(app, ["classify", "run", "docs", str(doc)])
    assert result.exit_code == 0, result.output
    assert "invoice" in result.output
    assert "92.0%" in result.output
    # First call fetches the classifier record, second posts to /api/classify.
    assert client.get.call_args_list[0].args[0].endswith("/api/classifiers/docs")
    post_url = client.post.call_args_list[0].args[0]
    assert post_url.endswith("/api/classify")


def test_run_falls_back_to_draft_yaml(monkeypatch, doc):
    _install_client(
        monkeypatch,
        [
            _make_response(200, {"slug": "docs", "latestVersion": None, "draftYaml": "name: docs\n"}),
            _make_response(
                200,
                {"label": "receipt", "confidence": 0.5, "method": "llm", "tier_used": 3, "evidence_page": 1},
            ),
        ],
    )
    result = runner.invoke(app, ["classify", "run", "docs", str(doc)])
    assert result.exit_code == 0, result.output
    assert "receipt" in result.output


def test_run_no_config_available_exits(monkeypatch, doc):
    _install_client(
        monkeypatch,
        [_make_response(200, {"slug": "docs", "latestVersion": None, "draftYaml": None})],
    )
    result = runner.invoke(app, ["classify", "run", "docs", str(doc)])
    assert result.exit_code != 0
    assert "no released version" in result.output.lower()


def test_run_uses_local_yaml_without_fetch(monkeypatch, doc, tmp_path):
    cfg = tmp_path / "local.yaml"
    cfg.write_text("name: docs\nclasses: []\n")
    client = _install_client(
        monkeypatch,
        [
            _make_response(
                200,
                {"label": "contract", "confidence": 0.8, "method": "keyword", "tier_used": 1, "evidence_page": 3},
            ),
        ],
    )
    result = runner.invoke(app, ["classify", "run", str(cfg), str(doc)])
    assert result.exit_code == 0, result.output
    assert "contract" in result.output
    # No GET — local YAML skips the config fetch.
    assert client.get.call_count == 0


def test_run_json_output(monkeypatch, doc):
    _install_client(
        monkeypatch,
        [
            _make_response(200, {"slug": "docs", "latestVersion": {"yamlSource": "name: docs\n"}}),
            _make_response(
                200,
                {"label": "invoice", "confidence": 0.9, "method": "keyword", "tier_used": 1, "evidence_page": 2},
            ),
        ],
    )
    result = runner.invoke(app, ["classify", "run", "docs", str(doc), "--json"])
    assert result.exit_code == 0, result.output
    assert '"label": "invoice"' in result.output


def test_run_unknown_label_note(monkeypatch, doc):
    _install_client(
        monkeypatch,
        [
            _make_response(200, {"slug": "docs", "latestVersion": {"yamlSource": "name: docs\n"}}),
            _make_response(
                422,
                {"error": "no class matched", "label": "unknown", "confidence": 0, "method": None, "tier_used": 0},
            ),
        ],
    )
    result = runner.invoke(app, ["classify", "run", "docs", str(doc)])
    assert result.exit_code == 0, result.output
    assert "unknown" in result.output.lower()


def test_run_error_exits(monkeypatch, doc):
    _install_client(
        monkeypatch,
        [
            _make_response(200, {"slug": "docs", "latestVersion": {"yamlSource": "name: docs\n"}}),
            _make_response(500, {"error": "boom"}),
        ],
    )
    result = runner.invoke(app, ["classify", "run", "docs", str(doc)])
    assert result.exit_code != 0
    assert "classify" in result.output.lower()


# ── classify versions ─────────────────────────────────────────────────


def test_versions_table(monkeypatch):
    _install_client(
        monkeypatch,
        [
            _make_response(
                200,
                {
                    "versions": [
                        {
                            "versionNumber": "v0.0.2",
                            "prerelease": False,
                            "commitMessage": "ship it",
                            "committedByName": "Ada",
                        },
                        {
                            "versionNumber": "v0.0.3-rc.1",
                            "prerelease": True,
                            "commitMessage": "tweak",
                            "committedByName": "Ada",
                        },
                    ]
                },
            )
        ],
    )
    result = runner.invoke(app, ["classify", "versions", "docs"])
    assert result.exit_code == 0, result.output
    assert "v0.0.2" in result.output
    assert "released" in result.output
    assert "candidate" in result.output


def test_versions_empty(monkeypatch):
    _install_client(monkeypatch, [_make_response(200, {"versions": []})])
    result = runner.invoke(app, ["classify", "versions", "docs"])
    assert result.exit_code == 0, result.output
    assert "No versions" in result.output


def test_versions_json(monkeypatch):
    _install_client(
        monkeypatch,
        [_make_response(200, {"versions": [{"versionNumber": "v0.0.1", "prerelease": False}]})],
    )
    result = runner.invoke(app, ["classify", "versions", "docs", "--json"])
    assert result.exit_code == 0, result.output
    assert '"versionNumber": "v0.0.1"' in result.output


def test_versions_error_exits(monkeypatch):
    _install_client(monkeypatch, [_make_response(404, {"error": "not found"})])
    result = runner.invoke(app, ["classify", "versions", "docs"])
    assert result.exit_code != 0


# ── classify promote ──────────────────────────────────────────────────


def test_promote_success(monkeypatch):
    client = _install_client(monkeypatch, [_make_response(200, {"released": "v0.0.3"})])
    result = runner.invoke(app, ["classify", "promote", "docs"])
    assert result.exit_code == 0, result.output
    assert "v0.0.3" in result.output
    assert client.post.call_args_list[0].args[0].endswith("/api/classifiers/docs/promote")


def test_promote_json(monkeypatch):
    _install_client(monkeypatch, [_make_response(200, {"released": "v0.0.3"})])
    result = runner.invoke(app, ["classify", "promote", "docs", "--json"])
    assert result.exit_code == 0, result.output
    assert '"released": "v0.0.3"' in result.output


def test_promote_error_exits(monkeypatch):
    _install_client(monkeypatch, [_make_response(409, {"error": "no candidate to promote"})])
    result = runner.invoke(app, ["classify", "promote", "docs"])
    assert result.exit_code != 0
    assert "promote" in result.output.lower()


# ── classify release ──────────────────────────────────────────────────


def test_release_draft(monkeypatch):
    client = _install_client(monkeypatch, [_make_response(200, {"released": "v0.1.0"})])
    result = runner.invoke(app, ["classify", "release", "docs"])
    assert result.exit_code == 0, result.output
    assert "v0.1.0" in result.output
    call = client.post.call_args_list[0]
    assert call.args[0].endswith("/api/classifiers/docs/release")
    # No local file → no yaml in the body.
    assert call.kwargs["json"] == {}


def test_release_from_local_file(monkeypatch, tmp_path):
    cfg = tmp_path / "docs.yaml"
    cfg.write_text("name: docs\nclasses: []\n")
    client = _install_client(monkeypatch, [_make_response(200, {"released": "v0.1.0"})])
    result = runner.invoke(app, ["classify", "release", str(cfg)])
    assert result.exit_code == 0, result.output
    call = client.post.call_args_list[0]
    assert "yaml" in call.kwargs["json"]
    assert "classes" in call.kwargs["json"]["yaml"]


def test_release_error_exits(monkeypatch):
    _install_client(monkeypatch, [_make_response(400, {"error": "invalid config"})])
    result = runner.invoke(app, ["classify", "release", "docs"])
    assert result.exit_code != 0
    assert "release" in result.output.lower()
