"""Which project a command targets must be visible (oss-491).

Project scope resolves from three places the operator can't see at once: a
`KOJI_PROJECT` env var, the profile's `project`, or — when neither names one —
whatever project the API key itself is bound to. Nothing printed which of them
won, and `koji pull` didn't even send the scope it had resolved, so it read the
key's project no matter which project the profile selected. Against a key bound
elsewhere that wrote a different project's schemas into the working directory
and reported success.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest
from typer.testing import CliRunner

import cli.remote as remote_mod
from cli.credentials import Profile
from cli.main import app
from cli.remote import note_resolved_project

runner = CliRunner()


@pytest.fixture(autouse=True)
def _reset_scope_announcement(monkeypatch):
    """The scope line prints once per process; each test wants a fresh one."""
    monkeypatch.setattr(remote_mod, "_scope_announced", False)


def _response(headers: dict[str, str], request_headers: dict[str, str]) -> MagicMock:
    resp = MagicMock()
    resp.headers = headers
    resp.request = MagicMock()
    resp.request.headers = request_headers
    return resp


# ── note_resolved_project ─────────────────────────────────────────────


def test_silent_when_the_server_confirms_the_project_we_asked_for(capsys):
    note_resolved_project(_response({"x-koji-project-resolved": "acme"}, {"x-koji-project": "acme"}))
    assert capsys.readouterr().err == ""


def test_reports_the_project_when_we_asked_for_none(capsys):
    """The dangerous case: no scope sent, so the API key's binding decided."""
    note_resolved_project(_response({"x-koji-project-resolved": "acme"}, {}))
    assert "acme" in capsys.readouterr().err


def test_warns_when_the_server_used_a_different_project(capsys):
    note_resolved_project(_response({"x-koji-project-resolved": "acme"}, {"x-koji-project": "acme-policy"}))
    err = capsys.readouterr().err
    assert "acme" in err and "acme-policy" in err


def test_silent_against_a_server_that_does_not_report_one(capsys):
    note_resolved_project(_response({}, {"x-koji-project": "acme"}))
    assert capsys.readouterr().err == ""


# ── koji pull sends the scope it resolved ─────────────────────────────


def _install_pull_stubs(monkeypatch) -> dict[str, dict]:
    """Capture the headers `pull` sends, and answer with one empty schema list."""
    seen: dict[str, dict] = {}

    def _get(url, headers=None, **_kwargs):
        seen["headers"] = dict(headers or {})
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = {"data": []}
        resp.headers = {}
        resp.request = MagicMock()
        resp.request.headers = dict(headers or {})
        return resp

    monkeypatch.setattr("httpx.get", _get)
    return seen


def test_pull_sends_the_profile_project(monkeypatch, tmp_path: Path):
    monkeypatch.delenv("KOJI_API_URL", raising=False)
    monkeypatch.delenv("KOJI_API_KEY", raising=False)
    monkeypatch.setattr(
        remote_mod,
        "get_active_profile",
        lambda: Profile(url="http://test", api_key="koji_test", project="acme-policy", name="acme-policy"),
    )
    seen = _install_pull_stubs(monkeypatch)
    monkeypatch.chdir(tmp_path)

    runner.invoke(app, ["pull"])

    assert seen["headers"].get("x-koji-project") == "acme-policy"


def test_pull_sends_the_env_project(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("KOJI_API_URL", "http://test")
    monkeypatch.setenv("KOJI_API_KEY", "koji_test")
    monkeypatch.setenv("KOJI_PROJECT", "acme-policy")
    seen = _install_pull_stubs(monkeypatch)
    monkeypatch.chdir(tmp_path)

    runner.invoke(app, ["pull"])

    assert seen["headers"].get("x-koji-project") == "acme-policy"


def test_pull_announces_the_scope_it_resolved(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("KOJI_API_URL", "http://test")
    monkeypatch.setenv("KOJI_API_KEY", "koji_test")
    monkeypatch.setenv("KOJI_PROJECT", "acme-policy")
    _install_pull_stubs(monkeypatch)
    monkeypatch.chdir(tmp_path)

    result = runner.invoke(app, ["pull"])

    assert "acme-policy" in result.output
