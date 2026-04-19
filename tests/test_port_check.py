"""Tests for port conflict detection in koji start."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from cli.cluster import _get_port_map, check_port_conflicts, find_available_base_port
from cli.config import KojiConfig


def _make_config(base_port: int = 9400) -> KojiConfig:
    return KojiConfig(project="test", cluster={"base_port": base_port})


# ── _get_port_map ────────────────────────────────────────────────────


class TestGetPortMap:
    def test_returns_all_five_services(self):
        config = _make_config(9400)
        ports = _get_port_map(config)
        assert len(ports) == 5
        assert set(ports.keys()) == {"UI", "Server", "Ollama", "Parse", "Extract"}

    def test_ports_derived_from_base(self):
        config = _make_config(9400)
        ports = _get_port_map(config)
        assert ports["UI"] == 9400
        assert ports["Server"] == 9401
        assert ports["Ollama"] == 9410
        assert ports["Parse"] == 9411
        assert ports["Extract"] == 9412


# ── check_port_conflicts ─────────────────────────────────────────────


class TestCheckPortConflicts:
    def test_all_ports_available_passes(self):
        config = _make_config()
        with patch("cli.cluster._port_available", return_value=True):
            # Should not raise
            check_port_conflicts(config)

    def test_exits_when_port_in_use(self):
        config = _make_config()
        with (
            patch("cli.cluster._port_available", return_value=False),
            patch("cli.cluster.find_available_base_port", return_value=9500),
            pytest.raises(SystemExit) as exc_info,
        ):
            check_port_conflicts(config)
        assert exc_info.value.code == 1

    def test_prints_conflict_details(self, capsys):
        config = _make_config(9400)

        def fake_available(port):
            # UI (9400) and Server (9401) in use, rest free
            return port not in (9400, 9401)

        with (
            patch("cli.cluster._port_available", side_effect=fake_available),
            patch("cli.cluster.find_available_base_port", return_value=9500),
            pytest.raises(SystemExit),
        ):
            check_port_conflicts(config)

        captured = capsys.readouterr()
        assert "9400" in captured.out
        assert "already in use" in captured.out
        assert "9500" in captured.out

    def test_partial_conflict_shows_available_and_in_use(self, capsys):
        config = _make_config(9400)

        def fake_available(port):
            return port != 9400  # only UI port in use

        with (
            patch("cli.cluster._port_available", side_effect=fake_available),
            patch("cli.cluster.find_available_base_port", return_value=9500),
            pytest.raises(SystemExit),
        ):
            check_port_conflicts(config)

        captured = capsys.readouterr()
        assert "already in use" in captured.out
        assert "available" in captured.out


# ── find_available_base_port ─────────────────────────────────────────


class TestFindAvailableBasePort:
    def test_finds_next_available_range(self):
        # Current is 9400, next candidate is 9500
        with patch("cli.cluster._port_available", return_value=True):
            result = find_available_base_port(9400)
        assert result == 9500

    def test_skips_occupied_ranges(self):
        def fake_available(port):
            # 9500 range: fail on first port checked
            # 9600 range: all pass
            if 9500 <= port < 9600:
                return False
            return True

        with patch("cli.cluster._port_available", side_effect=fake_available):
            result = find_available_base_port(9400)
        assert result == 9600

    def test_returns_none_when_nothing_free(self):
        with patch("cli.cluster._port_available", return_value=False):
            result = find_available_base_port(9400)
        assert result is None

    def test_base_port_not_on_hundred_boundary(self):
        # base_port 9450 -> next candidate should be 9500
        with patch("cli.cluster._port_available", return_value=True):
            result = find_available_base_port(9450)
        assert result == 9500
