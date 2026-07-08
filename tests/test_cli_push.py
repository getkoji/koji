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

from cli.main import _pipeline_yaml_body, app

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
