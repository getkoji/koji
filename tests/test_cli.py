"""Tests for CLI commands — argument parsing and registration."""

from __future__ import annotations

from unittest.mock import patch

from typer.testing import CliRunner

from cli.logs import SERVICE_TO_COMPOSE, VALID_SERVICES
from cli.main import app

runner = CliRunner()

FAKE_STATE = {
    "project": "test",
    "server_port": 9401,
    "ui_port": 9400,
    "parse_port": 9410,
    "extract_port": 9420,
    "ollama_port": 11434,
}


# ── Command registration ──────────────────────────────────────────────


def test_logs_command_registered():
    """The logs command should be registered on the CLI app."""
    result = runner.invoke(app, ["logs", "--help"])
    assert result.exit_code == 0


def test_help_includes_logs():
    """koji --help should list the logs command."""
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    assert "logs" in result.output


def test_logs_help():
    """koji logs --help should describe the command and options."""
    result = runner.invoke(app, ["logs", "--help"])
    assert result.exit_code == 0
    # Rich may split flags with ANSI codes (e.g., "--follow" → "-" + "-follow")
    assert "follow" in result.output
    assert "tail" in result.output
    assert "SERVICE" in result.output.upper() or "service" in result.output


# ── No cluster running ────────────────────────────────────────────────


@patch("cli.main.load_cluster_state", return_value=None)
def test_logs_no_cluster(mock_state):
    """Should show error when no cluster is running."""
    result = runner.invoke(app, ["logs"])
    assert result.exit_code == 1
    assert "No cluster running" in result.output


# ── Invalid service name ──────────────────────────────────────────────


@patch("cli.main.load_cluster_state", return_value=FAKE_STATE)
def test_logs_invalid_service(mock_state):
    """Should reject unknown service names."""
    result = runner.invoke(app, ["logs", "bogus"])
    assert result.exit_code == 1
    assert "Unknown service" in result.output


# ── Valid invocations (subprocess mocked) ─────────────────────────────


@patch("cli.logs.subprocess.run")
@patch("cli.logs.Path.cwd")
@patch("cli.main.load_cluster_state", return_value=FAKE_STATE)
def test_logs_all_services(mock_state, mock_cwd, mock_run, tmp_path):
    """koji logs — should call docker compose logs for all services."""
    koji_dir = tmp_path / ".koji"
    koji_dir.mkdir()
    (koji_dir / "docker-compose.yaml").write_text("version: '3'")
    mock_cwd.return_value = tmp_path

    result = runner.invoke(app, ["logs"])
    assert result.exit_code == 0
    assert mock_run.called

    cmd = mock_run.call_args[0][0]
    assert "docker" in cmd
    assert "logs" in cmd
    assert "--tail=100" in cmd
    assert "--follow" not in cmd


@patch("cli.logs.subprocess.run")
@patch("cli.logs.Path.cwd")
@patch("cli.main.load_cluster_state", return_value=FAKE_STATE)
def test_logs_single_service(mock_state, mock_cwd, mock_run, tmp_path):
    """koji logs parse — should target the koji-parse compose service."""
    koji_dir = tmp_path / ".koji"
    koji_dir.mkdir()
    (koji_dir / "docker-compose.yaml").write_text("version: '3'")
    mock_cwd.return_value = tmp_path

    result = runner.invoke(app, ["logs", "parse"])
    assert result.exit_code == 0

    cmd = mock_run.call_args[0][0]
    assert "koji-parse" in cmd


@patch("cli.logs.subprocess.run")
@patch("cli.logs.Path.cwd")
@patch("cli.main.load_cluster_state", return_value=FAKE_STATE)
def test_logs_follow_flag(mock_state, mock_cwd, mock_run, tmp_path):
    """koji logs -f — should pass --follow to docker compose."""
    koji_dir = tmp_path / ".koji"
    koji_dir.mkdir()
    (koji_dir / "docker-compose.yaml").write_text("version: '3'")
    mock_cwd.return_value = tmp_path

    result = runner.invoke(app, ["logs", "-f"])
    assert result.exit_code == 0

    cmd = mock_run.call_args[0][0]
    assert "--follow" in cmd


@patch("cli.logs.subprocess.run")
@patch("cli.logs.Path.cwd")
@patch("cli.main.load_cluster_state", return_value=FAKE_STATE)
def test_logs_custom_tail(mock_state, mock_cwd, mock_run, tmp_path):
    """koji logs --tail 50 — should pass --tail=50."""
    koji_dir = tmp_path / ".koji"
    koji_dir.mkdir()
    (koji_dir / "docker-compose.yaml").write_text("version: '3'")
    mock_cwd.return_value = tmp_path

    result = runner.invoke(app, ["logs", "--tail", "50"])
    assert result.exit_code == 0

    cmd = mock_run.call_args[0][0]
    assert "--tail=50" in cmd


@patch("cli.logs.subprocess.run")
@patch("cli.logs.Path.cwd")
@patch("cli.main.load_cluster_state", return_value=FAKE_STATE)
def test_logs_service_with_follow_and_tail(mock_state, mock_cwd, mock_run, tmp_path):
    """koji logs extract -f --tail 20 — combines service, follow, and tail."""
    koji_dir = tmp_path / ".koji"
    koji_dir.mkdir()
    (koji_dir / "docker-compose.yaml").write_text("version: '3'")
    mock_cwd.return_value = tmp_path

    result = runner.invoke(app, ["logs", "extract", "-f", "--tail", "20"])
    assert result.exit_code == 0

    cmd = mock_run.call_args[0][0]
    assert "--follow" in cmd
    assert "--tail=20" in cmd
    assert "koji-extract" in cmd


# ── Unit tests for constants ──────────────────────────────────────────


def test_valid_services():
    assert VALID_SERVICES == {"server", "parse", "extract", "ui", "ollama"}


def test_service_to_compose_mapping():
    assert SERVICE_TO_COMPOSE["server"] == "koji-server"
    assert SERVICE_TO_COMPOSE["parse"] == "koji-parse"
    assert SERVICE_TO_COMPOSE["extract"] == "koji-extract"
    assert SERVICE_TO_COMPOSE["ui"] == "koji-ui"
    assert SERVICE_TO_COMPOSE["ollama"] == "ollama"
