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
        ["classify", "delete", "--help"],
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


# A classified result body, kept terse.
_CLASSIFIED = {"label": "invoice", "confidence": 0.92, "method": "keyword", "tier_used": 1, "evidence_page": 2}


def _record(*, current="v1", latest=None, draft=None):
    return {"slug": "docs", "currentVersionId": current, "latestVersion": latest, "draftYaml": draft}


def _posted_config(client) -> str:
    """The `config` field the CLI POSTed to /api/classify."""
    return client.post.call_args_list[0].kwargs["data"]["config"]


def test_run_uses_released_version_matching_the_pipeline(monkeypatch, doc):
    # Released == latest (versionNumber 1): the resolver reuses the inlined yaml,
    # no extra version fetch. Sequence: GET record, GET versions, POST.
    client = _install_client(
        monkeypatch,
        [
            _make_response(
                200,
                _record(latest={"versionNumber": 1, "version": "v0.0.1", "yamlSource": "name: docs\n# RELEASED\n"}),
            ),
            _make_response(200, {"data": [{"id": "v1", "versionNumber": 1, "version": "v0.0.1", "active": True}]}),
            _make_response(200, _CLASSIFIED),
        ],
    )
    result = runner.invoke(app, ["classify", "run", "docs", str(doc)])
    assert result.exit_code == 0, result.output
    assert "invoice" in result.output
    assert "released v0.0.1" in result.output  # source is surfaced
    assert "# RELEASED" in _posted_config(client)
    assert client.get.call_args_list[0].args[0].endswith("/api/classifiers/docs")
    assert client.post.call_args_list[0].args[0].endswith("/api/classify")


def test_run_ignores_unreleased_higher_version(monkeypatch, doc):
    # THE BUG: latest is an unreleased v2, but the released pointer is v1. The
    # pipeline runs v1, so `classify run` must too — not the v2 draft.
    client = _install_client(
        monkeypatch,
        [
            _make_response(
                200,
                _record(
                    current="v1-id",
                    latest={"versionNumber": 2, "version": "v0.0.2", "yamlSource": "name: docs\n# UNRELEASED V2\n"},
                ),
            ),
            _make_response(
                200,
                {
                    "data": [
                        {"id": "v2-id", "versionNumber": 2, "version": "v0.0.2", "active": False},
                        {"id": "v1-id", "versionNumber": 1, "version": "v0.0.1", "active": True},
                    ]
                },
            ),
            _make_response(200, {"versionNumber": 1, "yamlSource": "name: docs\n# RELEASED V1\n"}),
            _make_response(200, _CLASSIFIED),
        ],
    )
    result = runner.invoke(app, ["classify", "run", "docs", str(doc)])
    assert result.exit_code == 0, result.output
    posted = _posted_config(client)
    assert "# RELEASED V1" in posted
    assert "UNRELEASED V2" not in posted
    assert "released v0.0.1" in result.output
    # It fetched the released version explicitly by its number.
    assert client.get.call_args_list[2].args[0].endswith("/api/classifiers/docs/versions/1")


def test_run_draft_flag_runs_the_unreleased_draft(monkeypatch, doc):
    client = _install_client(
        monkeypatch,
        [
            _make_response(
                200, _record(latest={"versionNumber": 1, "version": "v0.0.1"}, draft="name: docs\n# DRAFT\n")
            ),
            _make_response(200, _CLASSIFIED),
        ],
    )
    result = runner.invoke(app, ["classify", "run", "docs", str(doc), "--draft"])
    assert result.exit_code == 0, result.output
    assert "# DRAFT" in _posted_config(client)
    assert "config: draft" in result.output
    # --draft short-circuits the version lookup: only GET record, then POST.
    assert client.get.call_count == 1


def test_run_falls_back_to_draft_when_no_release(monkeypatch, doc):
    _install_client(
        monkeypatch,
        [
            _make_response(200, _record(current=None, latest=None, draft="name: docs\n")),
            _make_response(200, {"data": []}),  # no versions → no active release
            _make_response(
                200, {"label": "receipt", "confidence": 0.5, "method": "llm", "tier_used": 3, "evidence_page": 1}
            ),
        ],
    )
    result = runner.invoke(app, ["classify", "run", "docs", str(doc)])
    assert result.exit_code == 0, result.output
    assert "receipt" in result.output
    assert "draft (no released version)" in result.output


def test_run_no_config_available_exits(monkeypatch, doc):
    _install_client(
        monkeypatch,
        [
            _make_response(200, _record(current=None, latest=None, draft=None)),
            _make_response(200, {"data": []}),
        ],
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


def _released_seq(*trailing):
    """[GET record, GET versions] for a released==latest v0.0.1, then trailing responses."""
    return [
        _make_response(200, _record(latest={"versionNumber": 1, "version": "v0.0.1", "yamlSource": "name: docs\n"})),
        _make_response(200, {"data": [{"id": "v1", "versionNumber": 1, "version": "v0.0.1", "active": True}]}),
        *trailing,
    ]


def test_run_json_output(monkeypatch, doc):
    _install_client(
        monkeypatch,
        _released_seq(
            _make_response(
                200, {"label": "invoice", "confidence": 0.9, "method": "keyword", "tier_used": 1, "evidence_page": 2}
            ),
        ),
    )
    result = runner.invoke(app, ["classify", "run", "docs", str(doc), "--json"])
    assert result.exit_code == 0, result.output
    assert '"label": "invoice"' in result.output


def test_run_unknown_label_note(monkeypatch, doc):
    _install_client(
        monkeypatch,
        _released_seq(
            _make_response(
                422, {"error": "no class matched", "label": "unknown", "confidence": 0, "method": None, "tier_used": 0}
            ),
        ),
    )
    result = runner.invoke(app, ["classify", "run", "docs", str(doc)])
    assert result.exit_code == 0, result.output
    assert "unknown" in result.output.lower()


def test_run_error_exits(monkeypatch, doc):
    _install_client(monkeypatch, _released_seq(_make_response(500, {"error": "boom"})))
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


# ── classify delete ───────────────────────────────────────────────────


def test_delete_success(monkeypatch):
    client = _install_client(monkeypatch, [])
    client.delete.return_value = _make_response(204, {})
    result = runner.invoke(app, ["classify", "delete", "family_line_test", "--yes"])
    assert result.exit_code == 0, result.output
    assert "deleted" in result.output.lower()
    assert client.delete.call_args_list[0].args[0].endswith("/api/classifiers/family_line_test")


def test_delete_aborts_without_confirmation(monkeypatch):
    client = _install_client(monkeypatch, [])
    client.delete.return_value = _make_response(204, {})
    # No --yes and the prompt gets "n" → abort, no request sent.
    result = runner.invoke(app, ["classify", "delete", "docs"], input="n\n")
    assert result.exit_code != 0
    assert client.delete.call_count == 0


def test_delete_error_exits(monkeypatch):
    client = _install_client(monkeypatch, [])
    client.delete.return_value = _make_response(404, {"error": "Classifier not found"})
    result = runner.invoke(app, ["classify", "delete", "missing", "--yes"])
    assert result.exit_code != 0
    assert "delete" in result.output.lower()


# ── Validate (backtest) ───────────────────────────────────────────────

_VALIDATE_RESULT = {
    "version": "v1.2.0",
    "docsTotal": 3,
    "docsCorrect": 2,
    "docsFailed": 0,
    "accuracy": 66.7,
    "escalationRate": 0.33,
    "byClass": [
        {
            "label": "invoice",
            "support": 2,
            "predicted": 2,
            "tp": 2,
            "fp": 0,
            "fn": 0,
            "precision": 1.0,
            "recall": 1.0,
            "f1": 1.0,
        },
        {
            "label": "receipt",
            "support": 1,
            "predicted": 1,
            "tp": 0,
            "fp": 1,
            "fn": 1,
            "precision": 0.0,
            "recall": 0.0,
            "f1": None,
        },
    ],
    "confusion": [
        {"expected": "invoice", "predicted": "invoice", "count": 2},
        {"expected": "receipt", "predicted": "invoice", "count": 1},
    ],
    "tierHistogram": {"2": 2, "3": 1},
    "flips": {"fixed": 0, "regressed": 0, "churned": 0, "items": []},
    "costUsd": None,
}


@pytest.mark.parametrize(
    "args",
    [
        ["classify", "validate", "--help"],
        ["classify", "corpus", "--help"],
        ["classify", "corpus", "ls", "--help"],
        ["classify", "corpus", "add", "--help"],
        ["classify", "corpus", "rm", "--help"],
    ],
)
def test_new_commands_registered(args):
    result = runner.invoke(app, args)
    assert result.exit_code == 0, result.output


def test_validate_async_polls_and_renders(monkeypatch):
    # POST 202 (queued), then a poll GET that is already completed.
    client = _install_client(
        monkeypatch,
        [
            _make_response(202, {"runId": "run-1", "docsTotal": 3, "status": "queued", "version": "v1.2.0"}),
            _make_response(
                200, {"status": "completed", "docsTotal": 3, "docsProcessed": 3, "result": _VALIDATE_RESULT}
            ),
        ],
    )
    result = runner.invoke(app, ["classify", "validate", "inbound_mail"])
    assert result.exit_code == 0, result.output
    # The confusion matrix + per-class readout rendered, not just a number.
    assert "accuracy" in result.output
    assert "confusion" in result.output
    assert "invoice" in result.output
    # POST body requested an async run.
    post_kwargs = client.post.call_args_list[0].kwargs
    assert post_kwargs["json"]["async"] is True
    assert "version" not in post_kwargs["json"]  # no --version → server default (released)


def test_validate_version_flag_is_sent(monkeypatch):
    _install_client(
        monkeypatch,
        [
            _make_response(202, {"runId": "r", "docsTotal": 1, "version": "v2.0.0"}),
            _make_response(
                200, {"status": "completed", "docsTotal": 1, "docsProcessed": 1, "result": _VALIDATE_RESULT}
            ),
        ],
    )
    result = runner.invoke(app, ["classify", "validate", "inbound_mail", "--version", "v2.0.0"])
    assert result.exit_code == 0, result.output


def test_validate_version_flag_populates_body(monkeypatch):
    client = _install_client(
        monkeypatch,
        [
            _make_response(202, {"runId": "r", "docsTotal": 1, "version": "v2.0.0"}),
            _make_response(
                200, {"status": "completed", "docsTotal": 1, "docsProcessed": 1, "result": _VALIDATE_RESULT}
            ),
        ],
    )
    runner.invoke(app, ["classify", "validate", "inbound_mail", "--version", "v2.0.0"])
    assert client.post.call_args_list[0].kwargs["json"]["version"] == "v2.0.0"


def test_validate_check_exits_nonzero_on_regression(monkeypatch):
    regressed = {**_VALIDATE_RESULT, "flips": {"fixed": 0, "regressed": 1, "churned": 0, "items": []}}
    _install_client(
        monkeypatch,
        [
            _make_response(202, {"runId": "r", "docsTotal": 3}),
            _make_response(200, {"status": "completed", "docsTotal": 3, "docsProcessed": 3, "result": regressed}),
        ],
    )
    result = runner.invoke(app, ["classify", "validate", "inbound_mail", "--check"])
    assert result.exit_code == 1, result.output


def test_validate_check_passes_when_no_regression(monkeypatch):
    _install_client(
        monkeypatch,
        [
            _make_response(202, {"runId": "r", "docsTotal": 3}),
            _make_response(
                200, {"status": "completed", "docsTotal": 3, "docsProcessed": 3, "result": _VALIDATE_RESULT}
            ),
        ],
    )
    result = runner.invoke(app, ["classify", "validate", "inbound_mail", "--check"])
    assert result.exit_code == 0, result.output


def test_validate_json_output_is_raw(monkeypatch):
    _install_client(
        monkeypatch,
        [
            _make_response(202, {"runId": "r", "docsTotal": 3}),
            _make_response(
                200, {"status": "completed", "docsTotal": 3, "docsProcessed": 3, "result": _VALIDATE_RESULT}
            ),
        ],
    )
    result = runner.invoke(app, ["classify", "validate", "inbound_mail", "--json"])
    assert result.exit_code == 0, result.output
    import json as _json

    payload = _json.loads(result.output)
    assert payload["accuracy"] == 66.7


# ── Classifier corpus (ls / add / rm) ─────────────────────────────────


def test_corpus_ls_table(monkeypatch):
    client = _install_client(monkeypatch, [])
    client.get.side_effect = None
    client.get.return_value = _make_response(
        200,
        {
            "data": [
                {"id": "e1abcdef", "filename": "a.pdf", "label": "invoice", "source": "upload"},
                {"id": "e2abcdef", "filename": "b.pdf", "label": "receipt", "source": "upload"},
            ]
        },
    )
    result = runner.invoke(app, ["classify", "corpus", "ls", "inbound_mail"])
    assert result.exit_code == 0, result.output
    assert "a.pdf" in result.output
    assert "invoice" in result.output
    assert "2 doc" in result.output


def test_corpus_ls_label_filter(monkeypatch):
    client = _install_client(monkeypatch, [])
    client.get.side_effect = None
    client.get.return_value = _make_response(
        200,
        {
            "data": [
                {"id": "e1", "filename": "a.pdf", "label": "invoice", "source": "upload"},
                {"id": "e2", "filename": "b.pdf", "label": "receipt", "source": "upload"},
            ]
        },
    )
    result = runner.invoke(app, ["classify", "corpus", "ls", "inbound_mail", "--label", "invoice"])
    assert result.exit_code == 0, result.output
    assert "a.pdf" in result.output
    assert "b.pdf" not in result.output


def test_corpus_add_uploads_and_labels(monkeypatch, doc):
    client = _install_client(monkeypatch, [])
    client.post.side_effect = None
    client.post.return_value = _make_response(201, {"id": "e1"})
    result = runner.invoke(app, ["classify", "corpus", "add", "inbound_mail", "invoice", str(doc)])
    assert result.exit_code == 0, result.output
    assert "invoice" in result.output
    # multipart file + label form field.
    kwargs = client.post.call_args.kwargs
    assert "file" in kwargs["files"]
    assert kwargs["data"] == {"label": "invoice"}


def test_corpus_add_dedup_note(monkeypatch, doc):
    client = _install_client(monkeypatch, [])
    client.post.side_effect = None
    client.post.return_value = _make_response(200, {"id": "existing"})
    result = runner.invoke(app, ["classify", "corpus", "add", "inbound_mail", "invoice", str(doc)])
    assert result.exit_code == 0, result.output
    assert "already labelled" in result.output


def test_corpus_rm_deletes(monkeypatch):
    client = _install_client(monkeypatch, [])
    client.get.side_effect = None
    client.get.return_value = _make_response(
        200, {"data": [{"id": "e1abcdef", "filename": "a.pdf", "label": "invoice"}]}
    )
    client.delete.return_value = _make_response(204, {})
    result = runner.invoke(app, ["classify", "corpus", "rm", "inbound_mail", "a.pdf", "--yes"])
    assert result.exit_code == 0, result.output
    assert "removed" in result.output.lower()
    client.delete.assert_called_once()


def test_corpus_ls_404(monkeypatch):
    client = _install_client(monkeypatch, [])
    client.get.side_effect = None
    client.get.return_value = _make_response(404, {"error": "not found"})
    result = runner.invoke(app, ["classify", "corpus", "ls", "missing"])
    assert result.exit_code != 0


# ── classify promote — regression gate (oss-464) ──────────────────────


def test_promote_gate_flags_map_to_body(monkeypatch):
    client = _install_client(monkeypatch, [_make_response(200, {"released": "v1.3.0"})])
    result = runner.invoke(
        app,
        [
            "classify",
            "promote",
            "docs",
            "--require-no-regressions",
            "--must-not-regress",
            "coi",
            "--must-not-regress",
            "policy",
            "--min-recall",
            "coi=0.9",
            "--min-precision",
            "policy=0.8",
        ],
    )
    assert result.exit_code == 0, result.output
    body = client.post.call_args_list[0].kwargs["json"]
    assert body["requireNoRegressions"] is True
    assert body["mustNotRegress"] == ["coi", "policy"]
    assert body["minRecall"] == {"coi": 0.9}
    assert body["minPrecision"] == {"policy": 0.8}


def test_promote_no_gate_sends_empty_body(monkeypatch):
    client = _install_client(monkeypatch, [_make_response(200, {"released": "v1.3.0"})])
    result = runner.invoke(app, ["classify", "promote", "docs"])
    assert result.exit_code == 0, result.output
    assert client.post.call_args_list[0].kwargs["json"] == {}


def test_promote_blocked_renders_before_after(monkeypatch):
    blocked = _make_response(
        409,
        {
            "error": "Refusing to promote: coi recall regressed 100% → 91%.",
            "blocked": [
                {"class": "coi", "metric": "recall", "kind": "regression", "before": 1.0, "after": 0.91},
                {"class": "coi", "metric": "precision", "kind": "regression", "before": 1.0, "after": 0.8},
            ],
        },
    )
    blocked.headers = {"content-type": "application/json"}
    _install_client(monkeypatch, [blocked])
    result = runner.invoke(app, ["classify", "promote", "docs", "--must-not-regress", "coi"])
    assert result.exit_code == 1
    assert "blocked" in result.output.lower()
    assert "coi" in result.output
    assert "100% → 91%" in result.output


def test_promote_blocked_floor_renders(monkeypatch):
    blocked = _make_response(
        409,
        {
            "error": "Refusing to promote: coi recall 80% is below the required floor 90%.",
            "blocked": [{"class": "coi", "metric": "recall", "kind": "floor", "after": 0.8, "floor": 0.9}],
        },
    )
    blocked.headers = {"content-type": "application/json"}
    _install_client(monkeypatch, [blocked])
    result = runner.invoke(app, ["classify", "promote", "docs", "--min-recall", "coi=0.9"])
    assert result.exit_code == 1
    assert "floor" in result.output.lower()
    assert "80%" in result.output


def test_promote_no_backtest_409_shows_message(monkeypatch):
    resp = _make_response(409, {"error": "Refusing to promote: no completed backtest for this candidate to gate on."})
    resp.headers = {"content-type": "application/json"}
    _install_client(monkeypatch, [resp])
    result = runner.invoke(app, ["classify", "promote", "docs", "--require-no-regressions"])
    assert result.exit_code != 0
    assert "backtest" in result.output.lower()


def test_promote_bad_min_recall_pair_exits(monkeypatch):
    _install_client(monkeypatch, [])
    result = runner.invoke(app, ["classify", "promote", "docs", "--min-recall", "coi"])
    assert result.exit_code == 1
    assert "class=value" in result.output


def test_promote_bad_min_recall_value_exits(monkeypatch):
    _install_client(monkeypatch, [])
    result = runner.invoke(app, ["classify", "promote", "docs", "--min-recall", "coi=high"])
    assert result.exit_code == 1
    assert "must be a number" in result.output
