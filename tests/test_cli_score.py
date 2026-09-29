"""Tests for `koji score` — the CLI front end to the single scorer.

The comparison semantics themselves are tested in `packages/score`
(`src/compare.test.ts`). These tests cover the parts that live in Python: bin
resolution, payload construction, and the fact that nothing here reimplements
comparison.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest
import typer

from cli.score import _field_specs, _repo_root, resolve_scorer, run_scorer

CLI_DIR = Path(__file__).parent.parent / "cli"


# ── The anti-divergence guard ─────────────────────────────────────────


def test_cli_does_not_reimplement_comparison():
    """`koji score` must delegate, not compare.

    The whole point of the command is that there is one scorer. A Python
    comparison helper creeping back into cli/score.py would recreate the
    divergence it exists to remove.
    """
    source = (CLI_DIR / "score.py").read_text()
    banned = ("def _levenshtein", "def string_similarity", "def _normalize_date", "def _to_number")
    offenders = [name for name in banned if name in source]
    assert not offenders, "cli/score.py must delegate to @koji/score, not compare values itself; found: " + ", ".join(
        offenders
    )


# ── Bin resolution ────────────────────────────────────────────────────


class TestResolveScorer:
    def test_env_override_wins(self, tmp_path):
        bin_path = tmp_path / "bin.js"
        bin_path.write_text("// stub")
        with patch.dict(os.environ, {"KOJI_SCORE_BIN": str(bin_path)}):
            with patch("cli.score.shutil.which", return_value="/usr/bin/node"):
                argv = resolve_scorer()
        assert argv == ["/usr/bin/node", str(bin_path)]

    def test_env_override_missing_file_raises(self, tmp_path):
        with patch.dict(os.environ, {"KOJI_SCORE_BIN": str(tmp_path / "nope.js")}):
            with pytest.raises(FileNotFoundError, match="does not exist"):
                resolve_scorer()

    def test_finds_workspace_build(self, tmp_path, monkeypatch):
        (tmp_path / "pnpm-workspace.yaml").write_text("packages:\n")
        built = tmp_path / "packages" / "score" / "dist" / "bin.js"
        built.parent.mkdir(parents=True)
        built.write_text("// stub")
        monkeypatch.chdir(tmp_path)
        with patch.dict(os.environ, {}, clear=True):
            with patch("cli.score.shutil.which", return_value="/usr/bin/node"):
                argv = resolve_scorer()
        assert argv == ["/usr/bin/node", str(built)]

    def test_falls_back_to_npx_outside_a_checkout(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        with patch.dict(os.environ, {}, clear=True):
            with patch("cli.score.shutil.which", side_effect=lambda c: "/usr/bin/npx" if c == "npx" else None):
                argv = resolve_scorer()
        assert argv == ["npx", "--yes", "@koji/score"]

    def test_actionable_error_when_nothing_is_available(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        with patch.dict(os.environ, {}, clear=True):
            with patch("cli.score.shutil.which", return_value=None):
                with pytest.raises(FileNotFoundError) as exc:
                    resolve_scorer()
        # The message has to tell the user how to fix it, not just that it broke.
        assert "pnpm --filter @koji/score build" in str(exc.value)
        assert "KOJI_SCORE_BIN" in str(exc.value)

    def test_missing_node_is_reported_clearly(self, tmp_path):
        bin_path = tmp_path / "bin.js"
        bin_path.write_text("// stub")
        with patch.dict(os.environ, {"KOJI_SCORE_BIN": str(bin_path)}):
            with patch("cli.score.shutil.which", return_value=None):
                with pytest.raises(FileNotFoundError, match="node"):
                    resolve_scorer()

    def test_executable_shim_runs_without_node(self, tmp_path):
        shim = tmp_path / "koji-score"
        shim.write_text("#!/bin/sh\n")
        with patch.dict(os.environ, {"KOJI_SCORE_BIN": str(shim)}):
            argv = resolve_scorer()
        assert argv == [str(shim)]


class TestRepoRoot:
    def test_finds_workspace_marker_from_a_subdirectory(self, tmp_path):
        (tmp_path / "pnpm-workspace.yaml").write_text("packages:\n")
        deep = tmp_path / "a" / "b" / "c"
        deep.mkdir(parents=True)
        assert _repo_root(deep) == tmp_path.resolve()

    def test_returns_none_outside_a_checkout(self, tmp_path):
        assert _repo_root(tmp_path) is None


# ── Subprocess handling ───────────────────────────────────────────────


class TestRunScorer:
    def _completed(self, returncode=0, stdout="", stderr=""):
        return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=stderr)

    def test_parses_the_bin_result(self):
        payload = {"scorer_version": "0.1.0", "total": 1, "matched": 1}
        with patch("cli.score.resolve_scorer", return_value=["node", "bin.js"]):
            with patch("cli.score.subprocess.run", return_value=self._completed(stdout=json.dumps(payload))):
                assert run_scorer({"fields": {}}) == payload

    def test_surfaces_stderr_on_failure(self):
        with patch("cli.score.resolve_scorer", return_value=["node", "bin.js"]):
            with patch("cli.score.subprocess.run", return_value=self._completed(1, stderr="koji-score: boom")):
                with pytest.raises(RuntimeError, match="boom"):
                    run_scorer({"fields": {}})

    def test_non_json_output_is_an_error_not_a_crash(self):
        with patch("cli.score.resolve_scorer", return_value=["node", "bin.js"]):
            with patch("cli.score.subprocess.run", return_value=self._completed(stdout="<html>502</html>")):
                with pytest.raises(RuntimeError, match="non-JSON"):
                    run_scorer({"fields": {}})


# ── Schema spec extraction ────────────────────────────────────────────


class TestFieldSpecs:
    def test_none_schema_yields_no_specs(self):
        assert _field_specs(None) == {}

    def test_reads_the_fields_block(self, tmp_path):
        path = tmp_path / "s.yaml"
        path.write_text("name: demo\nfields:\n  total:\n    type: number\n")
        assert _field_specs(path) == {"total": {"type": "number"}}

    def test_schema_without_fields_yields_no_specs(self, tmp_path):
        path = tmp_path / "s.yaml"
        path.write_text("name: demo\n")
        assert _field_specs(path) == {}

    def test_missing_schema_is_a_usage_error(self, tmp_path):
        with pytest.raises(typer.BadParameter, match="not found"):
            _field_specs(tmp_path / "nope.yaml")

    def test_invalid_yaml_is_a_usage_error(self, tmp_path):
        path = tmp_path / "s.yaml"
        path.write_text("fields:\n  - [unclosed\n")
        with pytest.raises(typer.BadParameter, match="not valid YAML"):
            _field_specs(path)
