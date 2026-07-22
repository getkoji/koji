"""Tests for `koji push` pipeline handling — DAG YAML must reach the server.

Regression tests for the bug where the update/create body gated the yaml on
`"yaml" in parsed.get("kind", "")` — `kind` is the literal string "pipeline",
which never contains "yaml", so the DAG source was silently dropped and the
pipeline landed as type "simple" with an empty yamlSource.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest
import yaml as yaml_mod
from typer.testing import CliRunner

from cli.main import _pipeline_yaml_body, app, push_error_line, push_version_line

runner = CliRunner()

DAG_PIPELINE = """\
kind: pipeline
name: Family Router
slug: family-router
steps:
  - id: classify
    type: classify
    config:
      labels:
        - id: carrier_a
    on:
      carrier_a: extract_a
      _default: extract_a
  - id: extract_a
    type: extract
    config:
      schema: schema-a
"""

SIMPLE_PIPELINE = """\
kind: pipeline
name: Claims Processing
slug: claims
schema: claim
"""


# ── _pipeline_yaml_body ───────────────────────────────────────────────


def test_yaml_body_built_for_dag_files():
    parsed = yaml_mod.safe_load(DAG_PIPELINE)
    body = _pipeline_yaml_body(parsed, DAG_PIPELINE)
    assert body is not None
    # Compiler-required `pipeline:` name prepended
    assert body.startswith('pipeline: "Family Router"\n')
    # Raw text sent verbatim — NOT re-serialized. PyYAML round-trips are
    # YAML 1.1 and would corrupt the bare `on:` routing key into `true:`.
    assert body.endswith(DAG_PIPELINE)
    assert "    on:\n" in body
    assert "true:" not in body


def test_yaml_body_none_for_simple_shorthand():
    # `schema: <name>` files with no steps stay simple schema-linked pipelines
    assert _pipeline_yaml_body(yaml_mod.safe_load(SIMPLE_PIPELINE), SIMPLE_PIPELINE) is None


def test_yaml_body_respects_existing_pipeline_key():
    raw = "pipeline: explicit-name\n" + DAG_PIPELINE
    parsed = yaml_mod.safe_load(raw)
    assert _pipeline_yaml_body(parsed, raw) == raw


def test_yaml_body_falls_back_to_slug_without_name():
    raw = DAG_PIPELINE.replace("name: Family Router\n", "")
    parsed = yaml_mod.safe_load(raw)
    body = _pipeline_yaml_body(parsed, raw)
    assert body.startswith('pipeline: "family-router"\n')


# ── koji push wiring ──────────────────────────────────────────────────


def _make_response(status_code: int, body: dict | list) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = body
    resp.text = str(body)
    return resp


def _install_client(monkeypatch, *, existing_pipeline: bool) -> MagicMock:
    """Patch httpx.Client for a push of one pipeline file (no schemas)."""
    client = MagicMock()

    def _get(url, **_kwargs):
        if url.endswith("/api/schemas"):
            return _make_response(200, {"data": []})
        if url.endswith("/api/model-providers"):
            return _make_response(200, {"data": []})
        # GET /api/pipelines/<slug>
        if existing_pipeline:
            return _make_response(200, {"id": "p1", "slug": "family-router"})
        return _make_response(404, {"error": "not found"})

    client.get.side_effect = _get
    client.post.return_value = _make_response(201, {"id": "p1"})
    client.patch.return_value = _make_response(200, {"id": "p1"})

    ctx = MagicMock()
    ctx.__enter__.return_value = client
    ctx.__exit__.return_value = False
    monkeypatch.setattr("httpx.Client", lambda *a, **k: ctx)
    return client


@pytest.fixture()
def push_env(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("KOJI_API_URL", "http://test")
    monkeypatch.setenv("KOJI_API_KEY", "koji_test")
    monkeypatch.chdir(tmp_path)
    return tmp_path


def test_push_creates_dag_pipeline_with_yaml(push_env: Path, monkeypatch):
    (push_env / "router.yaml").write_text(DAG_PIPELINE)
    client = _install_client(monkeypatch, existing_pipeline=False)

    result = runner.invoke(app, ["push", "-d", str(push_env)])
    assert result.exit_code == 0, result.output

    (url,), kwargs = client.post.call_args
    assert url == "http://test/api/pipelines"
    body = kwargs["json"]
    assert body["slug"] == "family-router"
    assert "yaml" in body, "create body must carry the DAG YAML"
    assert body["yaml"].startswith('pipeline: "Family Router"\n')
    assert "    on:\n" in body["yaml"]


def test_push_updates_dag_pipeline_with_yaml(push_env: Path, monkeypatch):
    (push_env / "router.yaml").write_text(DAG_PIPELINE)
    client = _install_client(monkeypatch, existing_pipeline=True)

    result = runner.invoke(app, ["push", "-d", str(push_env)])
    assert result.exit_code == 0, result.output

    (url,), kwargs = client.patch.call_args
    assert url == "http://test/api/pipelines/family-router"
    body = kwargs["json"]
    assert "yaml" in body, "update body must carry the DAG YAML"
    assert body["yaml"].startswith('pipeline: "Family Router"\n')


def test_push_simple_pipeline_sends_no_yaml(push_env: Path, monkeypatch):
    (push_env / "claims.yaml").write_text(SIMPLE_PIPELINE)
    client = _install_client(monkeypatch, existing_pipeline=False)

    result = runner.invoke(app, ["push", "-d", str(push_env)])
    assert result.exit_code == 0, result.output

    (_url,), kwargs = client.post.call_args
    assert "yaml" not in kwargs["json"], "simple shorthand must stay a simple pipeline"


# ── classifier push + unknown-kind reporting ──────────────────────────

CLASSIFIER = """kind: classifier
name: doc_type
description: "Classify docs as invoice or receipt"
classes:
  invoice:
    keywords: [invoice]
  receipt:
    keywords: [receipt]
"""


def _install_classifier_client(monkeypatch, *, existing: bool) -> MagicMock:
    """Patch httpx.Client for a push of one classifier file."""
    client = MagicMock()

    def _get(url, **_kwargs):
        if "/api/classifiers/" in url:
            if existing:
                return _make_response(200, {"latestVersion": {"yamlSource": "stale", "version": "v0.0.1"}})
            return _make_response(404, {"error": "not found"})
        return _make_response(200, {"data": []})

    client.get.side_effect = _get
    client.post.return_value = _make_response(201, {"id": "c1", "version": "v0.0.1"})
    ctx = MagicMock()
    ctx.__enter__.return_value = client
    ctx.__exit__.return_value = False
    monkeypatch.setattr("httpx.Client", lambda *a, **k: ctx)
    return client


def test_push_creates_classifier(push_env: Path, monkeypatch):
    (push_env / "doc_type.yaml").write_text(CLASSIFIER)
    client = _install_classifier_client(monkeypatch, existing=False)

    result = runner.invoke(app, ["push", "-d", str(push_env)])
    assert result.exit_code == 0, result.output

    (url,), kwargs = client.post.call_args
    assert url == "http://test/api/classifiers"
    body = kwargs["json"]
    assert body["slug"] == "doc_type"
    assert body["display_name"] == "doc_type"
    assert body["description"] == "Classify docs as invoice or receipt"
    assert "kind: classifier" in body["initial_yaml"]


def test_push_versions_existing_classifier(push_env: Path, monkeypatch):
    (push_env / "doc_type.yaml").write_text(CLASSIFIER)
    client = _install_classifier_client(monkeypatch, existing=True)

    result = runner.invoke(app, ["push", "-d", str(push_env)])
    assert result.exit_code == 0, result.output

    # Existing + changed YAML → POST a new version, not a create.
    (url,), kwargs = client.post.call_args
    assert url == "http://test/api/classifiers/doc_type/versions"
    assert "yaml" in kwargs["json"]


def test_push_reports_skipped_unknown_kind(push_env: Path, monkeypatch):
    (push_env / "koji.yaml").write_text("kind: config\nname: koji\n")
    _install_classifier_client(monkeypatch, existing=False)

    result = runner.invoke(app, ["push", "-d", str(push_env)])
    assert result.exit_code == 0, result.output
    assert "Skipped 1 file(s) with unhandled kind: config" in result.output
    assert "koji.yaml" in result.output


# ── Scope filters, kind inference, and staging (oss-458) ──────────────


SCHEMA_A = "name: alpha\nfields:\n  a: {type: string}\n"
SCHEMA_B = "name: beta\nfields:\n  b: {type: string}\n"
UNTAGGED_CLASSIFIER = """name: doc_type
classes:
  invoice:
    keywords: [invoice]
"""


def _install_any_client(monkeypatch, *, existing: bool = False) -> MagicMock:
    """Patch httpx.Client so every artifact lookup 200s (existing) or 404s."""
    client = MagicMock()

    def _get(url, **_kwargs):
        if url.endswith("/api/schemas") or url.endswith("/api/model-providers"):
            return _make_response(200, {"data": []})
        if existing:
            return _make_response(200, {"id": "x1", "latestVersion": {"yamlSource": "stale", "version": "v0.0.1"}})
        return _make_response(404, {"error": "not found"})

    client.get.side_effect = _get
    client.post.return_value = _make_response(201, {"id": "x1", "version": "v0.0.2"})
    client.patch.return_value = _make_response(200, {"id": "x1"})
    ctx = MagicMock()
    ctx.__enter__.return_value = client
    ctx.__exit__.return_value = False
    monkeypatch.setattr("httpx.Client", lambda *a, **k: ctx)
    return client


def _posted_urls(client: MagicMock) -> list[str]:
    return [c.args[0] for c in client.post.call_args_list]


def test_dry_run_writes_nothing(push_env: Path, monkeypatch):
    (push_env / "alpha.yaml").write_text(SCHEMA_A)
    client = _install_any_client(monkeypatch)

    result = runner.invoke(app, ["push", "-d", str(push_env), "--dry-run"])
    assert result.exit_code == 0, result.output
    assert "would push" in result.output
    # The whole point of --dry-run: no writes of any kind.
    assert client.post.call_count == 0
    assert client.patch.call_count == 0


def test_only_scopes_the_push_to_one_slug(push_env: Path, monkeypatch):
    (push_env / "alpha.yaml").write_text(SCHEMA_A)
    (push_env / "beta.yaml").write_text(SCHEMA_B)
    client = _install_any_client(monkeypatch)

    result = runner.invoke(app, ["push", "-d", str(push_env), "--only", "alpha"])
    assert result.exit_code == 0, result.output

    urls = _posted_urls(client)
    assert any("alpha" in u or u.endswith("/api/schemas") for u in urls)
    assert not any("beta" in u for u in urls)


def test_only_warns_when_a_slug_matches_nothing(push_env: Path, monkeypatch):
    (push_env / "alpha.yaml").write_text(SCHEMA_A)
    _install_any_client(monkeypatch)

    result = runner.invoke(app, ["push", "-d", str(push_env), "--only", "nope"])
    assert result.exit_code == 0, result.output
    assert "no matching file found" in result.output


def test_kind_filter_excludes_other_kinds(push_env: Path, monkeypatch):
    (push_env / "alpha.yaml").write_text(SCHEMA_A)
    (push_env / "router.yaml").write_text(DAG_PIPELINE)
    client = _install_any_client(monkeypatch)

    result = runner.invoke(app, ["push", "-d", str(push_env), "--kind", "pipeline"])
    assert result.exit_code == 0, result.output
    assert not any("/api/schemas/" in u for u in _posted_urls(client))


def test_unknown_kind_filter_is_rejected(push_env: Path, monkeypatch):
    (push_env / "alpha.yaml").write_text(SCHEMA_A)
    _install_any_client(monkeypatch)

    result = runner.invoke(app, ["push", "-d", str(push_env), "--kind", "nonsense"])
    assert result.exit_code == 1


def test_untagged_file_in_classifiers_dir_is_a_classifier(push_env: Path, monkeypatch):
    # The reported bug: no `kind:` + classifiers/ → silently created as a SCHEMA.
    (push_env / "classifiers").mkdir()
    (push_env / "classifiers" / "doc_type.yaml").write_text(UNTAGGED_CLASSIFIER)
    client = _install_any_client(monkeypatch)

    result = runner.invoke(app, ["push", "-d", str(push_env)])
    assert result.exit_code == 0, result.output

    urls = _posted_urls(client)
    assert any("/api/classifiers" in u for u in urls)
    assert not any(u.endswith("/api/schemas") for u in urls)


def test_untagged_file_at_root_is_still_a_schema(push_env: Path, monkeypatch):
    (push_env / "alpha.yaml").write_text(SCHEMA_A)
    client = _install_any_client(monkeypatch)

    result = runner.invoke(app, ["push", "-d", str(push_env)])
    assert result.exit_code == 0, result.output
    assert any(u.endswith("/api/schemas") for u in _posted_urls(client))


def test_update_stages_a_candidate_by_default(push_env: Path, monkeypatch):
    (push_env / "alpha.yaml").write_text(SCHEMA_A)
    client = _install_any_client(monkeypatch, existing=True)

    result = runner.invoke(app, ["push", "-d", str(push_env)])
    assert result.exit_code == 0, result.output

    (_url,), kwargs = client.post.call_args
    assert kwargs["json"]["candidate"] is True
    assert "candidate" in result.output


def test_release_flag_publishes_live(push_env: Path, monkeypatch):
    (push_env / "alpha.yaml").write_text(SCHEMA_A)
    client = _install_any_client(monkeypatch, existing=True)

    result = runner.invoke(app, ["push", "-d", str(push_env), "--release"])
    assert result.exit_code == 0, result.output

    (_url,), kwargs = client.post.call_args
    assert kwargs["json"]["candidate"] is False


def test_creating_a_new_artifact_still_releases(push_env: Path, monkeypatch):
    # Nothing live to displace, so a brand-new artifact must not be staged —
    # otherwise a first push leaves the project unusable until promoted.
    (push_env / "alpha.yaml").write_text(SCHEMA_A)
    client = _install_any_client(monkeypatch, existing=False)

    result = runner.invoke(app, ["push", "-d", str(push_env)])
    assert result.exit_code == 0, result.output
    (url,), kwargs = client.post.call_args
    assert url == "http://test/api/schemas"
    assert "candidate" not in kwargs["json"]
    assert "live" in result.output


# ── Output honesty: push_version_line / push_error_line ───────────────


def test_version_line_never_prints_v_question_mark():
    # The reported bug: push read a `versionNumber` key neither endpoint
    # returns, so EVERY update printed "updated to v?".
    for payload in (
        {"version": "v2.0.10", "released": True, "action": "created", "displaced": None},
        {"released": "v0.0.4", "versionId": "x", "action": "created", "displaced": None},
        {"version": "v0.0.5-rc.2", "released": False, "bump": "patch", "deduped": False},
    ):
        for released in (True, False):
            assert "v?" not in push_version_line("schema", "alpha", payload, released=released)


def test_version_line_distinguishes_unchanged_from_updated():
    line = push_version_line(
        "schema", "alpha", {"version": "v2.0.9", "action": "unchanged", "displaced": None}, released=True
    )
    assert "unchanged" in line
    assert "updated" not in line


def test_version_line_flags_a_live_pointer_move():
    line = push_version_line(
        "schema",
        "alpha",
        {"version": "v2.0.5", "action": "reactivated", "displaced": {"label": "v2.0.9"}},
        released=True,
    )
    assert "v2.0.9" in line and "v2.0.5" in line


def test_version_line_tells_you_a_candidate_is_not_live():
    line = push_version_line("schema", "alpha", {"version": "v0.0.5-rc.1", "released": False}, released=False)
    assert "candidate" in line
    assert "not live" in line
    assert "promote" in line


def test_error_line_renders_the_rollback_refusal_readably():
    line = push_error_line(
        "schema",
        "alpha",
        409,
        {
            "reason": "requires_reactivate",
            "matched_version": "v2.0.5",
            "current_version": "v2.0.9",
            "direction": "backward",
        },
        "",
    )
    assert "ROLL BACK" in line
    assert "v2.0.5" in line and "v2.0.9" in line


def test_error_line_falls_back_to_the_api_message():
    assert "boom" in push_error_line("schema", "alpha", 400, {"error": "boom"}, "")
    assert "HTTP 500" in push_error_line("schema", "alpha", 500, {}, "")
