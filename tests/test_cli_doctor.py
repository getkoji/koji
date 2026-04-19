"""Tests for koji doctor check functions."""

from __future__ import annotations

import subprocess
from unittest.mock import patch

from cli.doctor import (
    CheckResult,
    check_api_keys,
    check_compose_available,
    check_config_exists,
    check_config_valid,
    check_docker_installed,
    check_docker_running,
    check_ports_available,
    run_all_checks,
)
from cli.config import KojiConfig

# ── Docker checks ─────────────────────────────────────────────────────


class TestCheckDockerInstalled:
    def test_pass(self):
        fake = subprocess.CompletedProcess(args=[], returncode=0, stdout="Docker version 27.0.1", stderr="")
        with patch("cli.doctor.subprocess.run", return_value=fake):
            result = check_docker_installed()
        assert result.status == "pass"
        assert "27.0.1" in result.detail

    def test_fail_not_found(self):
        with patch("cli.doctor.subprocess.run", side_effect=FileNotFoundError):
            result = check_docker_installed()
        assert result.status == "fail"

    def test_fail_nonzero(self):
        fake = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="err")
        with patch("cli.doctor.subprocess.run", return_value=fake):
            result = check_docker_installed()
        assert result.status == "fail"

    def test_fail_timeout(self):
        with patch("cli.doctor.subprocess.run", side_effect=subprocess.TimeoutExpired("docker", 10)):
            result = check_docker_installed()
        assert result.status == "fail"


class TestCheckComposeAvailable:
    def test_pass(self):
        fake = subprocess.CompletedProcess(args=[], returncode=0, stdout="Docker Compose version v2.20.0", stderr="")
        with patch("cli.doctor.subprocess.run", return_value=fake):
            result = check_compose_available()
        assert result.status == "pass"
        assert "v2.20" in result.detail

    def test_fail(self):
        fake = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="err")
        with patch("cli.doctor.subprocess.run", return_value=fake):
            result = check_compose_available()
        assert result.status == "fail"


class TestCheckDockerRunning:
    def test_pass(self):
        fake = subprocess.CompletedProcess(args=[], returncode=0, stdout="info", stderr="")
        with patch("cli.doctor.subprocess.run", return_value=fake):
            result = check_docker_running()
        assert result.status == "pass"

    def test_fail_daemon_not_running(self):
        fake = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="Cannot connect")
        with patch("cli.doctor.subprocess.run", return_value=fake):
            result = check_docker_running()
        assert result.status == "fail"


# ── Config checks ─────────────────────────────────────────────────────


class TestCheckConfigExists:
    def test_pass(self, tmp_path):
        config_file = tmp_path / "koji.yaml"
        config_file.write_text("project: test\n")
        result = check_config_exists(config_file)
        assert result.status == "pass"

    def test_fail(self, tmp_path):
        result = check_config_exists(tmp_path / "koji.yaml")
        assert result.status == "fail"


class TestCheckConfigValid:
    def test_pass(self, tmp_path):
        config_file = tmp_path / "koji.yaml"
        config_file.write_text("project: myproject\ncluster:\n  base_port: 9400\n")
        result = check_config_valid(config_file)
        assert result.status == "pass"
        assert "myproject" in result.detail

    def test_fail_missing(self, tmp_path):
        result = check_config_valid(tmp_path / "koji.yaml")
        assert result.status == "fail"

    def test_fail_invalid(self, tmp_path):
        config_file = tmp_path / "koji.yaml"
        config_file.write_text("cluster:\n  base_port: not_a_number\n")
        result = check_config_valid(config_file)
        assert result.status == "fail"


# ── Port checks ───────────────────────────────────────────────────────


class TestCheckPortsAvailable:
    def test_all_available(self):
        config = KojiConfig(project="test", cluster={"base_port": 19400})
        with patch("cli.doctor._port_available", return_value=True):
            result = check_ports_available(config)
        assert result.status == "pass"
        assert "19400" in result.detail

    def test_some_in_use(self):
        config = KojiConfig(project="test", cluster={"base_port": 19400})

        def fake_available(port):
            return port != 19401  # server port in use

        with patch("cli.doctor._port_available", side_effect=fake_available):
            result = check_ports_available(config)
        assert result.status == "fail"
        assert "server:19401" in result.detail

    def test_default_config(self):
        with patch("cli.doctor._port_available", return_value=True):
            result = check_ports_available()
        assert result.status == "pass"
        assert "9400" in result.detail


# ── API key checks ────────────────────────────────────────────────────


class TestCheckApiKeys:
    def test_key_set(self):
        with patch.dict("os.environ", {"OPENAI_API_KEY": "sk-test"}):
            result = check_api_keys()
        assert result.status == "pass"

    def test_key_not_set(self):
        with patch.dict("os.environ", {}, clear=True):
            result = check_api_keys()
        assert result.status == "warn"
        assert "not required for ollama" in result.detail


# ── run_all_checks ────────────────────────────────────────────────────


class TestRunAllChecks:
    def test_returns_list_of_results(self, tmp_path):
        config_file = tmp_path / "koji.yaml"
        config_file.write_text("project: test\n")

        fake_ok = subprocess.CompletedProcess(args=[], returncode=0, stdout="ok", stderr="")
        with (
            patch("cli.doctor.subprocess.run", return_value=fake_ok),
            patch("cli.doctor._port_available", return_value=True),
            patch.dict("os.environ", {"OPENAI_API_KEY": "sk-test"}),
        ):
            results = run_all_checks(config_file)

        assert all(isinstance(r, CheckResult) for r in results)
        # Should have 7 checks when config exists
        assert len(results) == 7

    def test_skips_config_valid_when_missing(self, tmp_path):
        fake_ok = subprocess.CompletedProcess(args=[], returncode=0, stdout="ok", stderr="")
        with (
            patch("cli.doctor.subprocess.run", return_value=fake_ok),
            patch("cli.doctor._port_available", return_value=True),
            patch.dict("os.environ", {"OPENAI_API_KEY": "sk-test"}),
        ):
            results = run_all_checks(tmp_path / "koji.yaml")

        # Should have 6 checks when config is missing (no config_valid)
        assert len(results) == 6
