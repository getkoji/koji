"""Tests for the --config flag — running koji commands against a non-default koji.yaml."""

from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from cli.cluster import get_project_dir, load_cluster_state, load_project_config
from cli.main import app

runner = CliRunner()

KOJI_YAML = """\
project: elsewhere
cluster:
  base_port: 9700
"""


def _write_project(tmp_path: Path) -> Path:
    """Create a koji project (koji.yaml + .koji/cluster.json) in tmp_path."""
    config_path = tmp_path / "koji.yaml"
    config_path.write_text(KOJI_YAML)
    koji_dir = tmp_path / ".koji"
    koji_dir.mkdir()
    (koji_dir / "cluster.json").write_text(
        json.dumps(
            {
                "project": "elsewhere",
                "cluster_name": "koji-elsewhere",
                "base_port": 9700,
                "ui_port": 9700,
                "server_port": 9701,
                "parse_port": 9711,
                "ollama_port": 9734,
            }
        )
    )
    return config_path


# ── Helpers ───────────────────────────────────────────────────────────


def test_get_project_dir_defaults_to_cwd():
    assert get_project_dir() == str(Path.cwd())


def test_get_project_dir_uses_config_parent(tmp_path):
    config_path = _write_project(tmp_path)
    assert get_project_dir(config_path) == str(tmp_path.resolve())


def test_load_project_config_explicit_path(tmp_path):
    config_path = _write_project(tmp_path)
    config = load_project_config(config_path)
    assert config.project == "elsewhere"
    assert config.cluster.base_port == 9700


def test_load_project_config_explicit_path_missing(tmp_path, capsys):
    missing = tmp_path / "nope" / "koji.yaml"
    try:
        load_project_config(missing)
        raise AssertionError("expected SystemExit")
    except SystemExit as e:
        assert e.code == 1
    out = capsys.readouterr().out
    assert "No koji.yaml found" in out


def test_load_cluster_state_from_project_dir(tmp_path):
    _write_project(tmp_path)
    state = load_cluster_state(str(tmp_path))
    assert state is not None
    assert state["project"] == "elsewhere"
    assert state["server_port"] == 9701


def test_load_cluster_state_missing_project_dir(tmp_path):
    assert load_cluster_state(str(tmp_path)) is None


# ── CLI wiring ────────────────────────────────────────────────────────


def test_status_with_config_finds_remote_project(tmp_path):
    """koji status --config <path> reads cluster state next to that koji.yaml."""
    config_path = _write_project(tmp_path)
    result = runner.invoke(app, ["status", "--config", str(config_path)])
    assert result.exit_code == 0
    assert "elsewhere" in result.output


def test_status_with_config_no_state(tmp_path):
    config_path = tmp_path / "koji.yaml"
    config_path.write_text(KOJI_YAML)
    result = runner.invoke(app, ["status", "--config", str(config_path)])
    assert result.exit_code == 1


def test_config_flag_registered_on_cluster_commands():
    for cmd in ["start", "stop", "destroy", "status", "logs", "doctor", "process", "extract"]:
        result = runner.invoke(app, [cmd, "--help"])
        assert result.exit_code == 0, f"{cmd} --help failed"
        assert "config" in result.output, f"{cmd} is missing --config"


def test_start_with_missing_config_path(tmp_path):
    result = runner.invoke(app, ["start", "--config", str(tmp_path / "absent.yaml")])
    assert result.exit_code == 1
    assert "No koji.yaml found" in result.output
