"""Tests for the project management commands — koji project list / create / use."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from typer.testing import CliRunner

from cli.credentials import Credentials, Profile
from cli.main import app

runner = CliRunner()


def _make_response(status_code: int, body: dict) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = body
    return resp


def _install_client(monkeypatch, responses: list) -> MagicMock:
    monkeypatch.setattr(
        "cli.remote.resolve_api",
        lambda profile_name=None: ("http://test", {"Authorization": "Bearer k"}),
    )
    client = MagicMock()
    seq = list(responses)
    client.get.side_effect = lambda *a, **k: seq.pop(0)
    client.post.side_effect = lambda *a, **k: seq.pop(0)
    ctx = MagicMock()
    ctx.__enter__.return_value = client
    ctx.__exit__.return_value = False
    monkeypatch.setattr("cli.remote.httpx.Client", lambda *a, **k: ctx)
    return client


def _install_creds(monkeypatch) -> Credentials:
    """A fake credentials store whose .save() is a no-op spy."""
    creds = Credentials(
        current="rnd", profiles={"rnd": Profile(url="http://test", api_key="k", project=None, name="rnd")}
    )
    creds.save = MagicMock()  # don't touch the real ~/.koji file
    monkeypatch.setattr("cli.remote.load_credentials", lambda: creds)
    return creds


# ── list ──────────────────────────────────────────────────────────────


def test_list_renders_projects(monkeypatch):
    _install_creds(monkeypatch)
    _install_client(
        monkeypatch,
        [
            _make_response(
                200,
                {
                    "data": [
                        {"slug": "rnd", "displayName": "R&D", "description": "routing poc"},
                        {"slug": "prod", "displayName": "Production", "description": None},
                    ]
                },
            )
        ],
    )
    result = runner.invoke(app, ["project", "list"])
    assert result.exit_code == 0, result.output
    assert "rnd" in result.output and "prod" in result.output


def test_list_json(monkeypatch):
    _install_creds(monkeypatch)
    _install_client(monkeypatch, [_make_response(200, {"data": [{"slug": "rnd", "displayName": "R&D"}]})])
    result = runner.invoke(app, ["project", "list", "--json"])
    assert result.exit_code == 0, result.output
    assert '"slug": "rnd"' in result.output


def test_list_error_exits(monkeypatch):
    _install_creds(monkeypatch)
    _install_client(monkeypatch, [_make_response(403, {"error": "forbidden"})])
    result = runner.invoke(app, ["project", "list"])
    assert result.exit_code != 0


# ── create ────────────────────────────────────────────────────────────


def test_create_success(monkeypatch):
    creds = _install_creds(monkeypatch)
    client = _install_client(monkeypatch, [_make_response(201, {"slug": "newco", "displayName": "newco"})])
    result = runner.invoke(app, ["project", "create", "newco"])
    assert result.exit_code == 0, result.output
    assert "created" in result.output.lower() and "newco" in result.output
    # POSTs slug + display_name (defaulted to slug when --name omitted)
    body = client.post.call_args_list[0].kwargs["json"]
    assert body == {"slug": "newco", "display_name": "newco"}
    # Without --use, the active profile is NOT switched.
    assert creds.profiles["rnd"].project is None
    creds.save.assert_not_called()


def test_create_with_name_and_description(monkeypatch):
    _install_creds(monkeypatch)
    client = _install_client(monkeypatch, [_make_response(201, {"slug": "newco"})])
    runner.invoke(app, ["project", "create", "newco", "--name", "New Co", "--description", "the co"])
    body = client.post.call_args_list[0].kwargs["json"]
    assert body == {"slug": "newco", "display_name": "New Co", "description": "the co"}


def test_create_use_switches_active_profile(monkeypatch):
    creds = _install_creds(monkeypatch)
    _install_client(monkeypatch, [_make_response(201, {"slug": "newco"})])
    result = runner.invoke(app, ["project", "create", "newco", "--use"])
    assert result.exit_code == 0, result.output
    assert creds.profiles["rnd"].project == "newco"
    creds.save.assert_called_once()


def test_create_conflict_exits(monkeypatch):
    _install_creds(monkeypatch)
    _install_client(monkeypatch, [_make_response(409, {"error": 'Project "rnd" already exists'})])
    result = runner.invoke(app, ["project", "create", "rnd"])
    assert result.exit_code != 0
    assert "already exists" in result.output.lower()


# ── use ───────────────────────────────────────────────────────────────


def test_use_switches_after_verifying(monkeypatch):
    creds = _install_creds(monkeypatch)
    _install_client(monkeypatch, [_make_response(200, {"slug": "prod"})])
    result = runner.invoke(app, ["project", "use", "prod"])
    assert result.exit_code == 0, result.output
    assert creds.profiles["rnd"].project == "prod"
    creds.save.assert_called_once()


def test_use_unknown_project_exits(monkeypatch):
    creds = _install_creds(monkeypatch)
    _install_client(monkeypatch, [_make_response(404, {"error": "Project not found"})])
    result = runner.invoke(app, ["project", "use", "ghost"])
    assert result.exit_code != 0
    assert "not found" in result.output.lower()
    # No switch on a bad project.
    assert creds.profiles["rnd"].project is None
    creds.save.assert_not_called()


@pytest.mark.parametrize(
    "args",
    [
        ["project", "--help"],
        ["project", "create", "--help"],
        ["project", "use", "--help"],
        ["project", "list", "--help"],
    ],
)
def test_help(args):
    assert runner.invoke(app, args).exit_code == 0


# ── delete ────────────────────────────────────────────────────────────


def test_delete_success(monkeypatch):
    _install_creds(monkeypatch)
    client = _install_client(monkeypatch, [])
    client.delete.return_value = _make_response(204, {})
    result = runner.invoke(app, ["project", "delete", "oldproj", "--yes"])
    assert result.exit_code == 0, result.output
    assert "deleted" in result.output.lower()
    assert client.delete.call_args_list[0].args[0].endswith("/api/projects/oldproj")


def test_delete_aborts_without_confirmation(monkeypatch):
    _install_creds(monkeypatch)
    client = _install_client(monkeypatch, [])
    client.delete.return_value = _make_response(204, {})
    result = runner.invoke(app, ["project", "delete", "rnd"], input="n\n")
    assert result.exit_code != 0
    assert client.delete.call_count == 0
