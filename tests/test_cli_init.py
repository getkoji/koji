"""Tests for koji init command."""

from __future__ import annotations

import os

import yaml
from rich.console import Console

from cli.init import run_init


def _console() -> Console:
    return Console(quiet=True)


def test_init_creates_koji_yaml(tmp_path):
    """koji init in an empty directory creates koji.yaml with expected content."""
    os.chdir(tmp_path)
    run_init(project_dir=None, quickstart=False, console=_console())

    config_path = tmp_path / "koji.yaml"
    assert config_path.exists()

    content = config_path.read_text()
    assert "project:" in content
    # Project name should be the directory name
    assert f"project: {tmp_path.name}" in content
    assert "base_port: 9400" in content
    assert "structured: ./output/" in content


def test_init_quickstart_creates_example_schema(tmp_path):
    """koji init --quickstart creates schemas/invoice.yaml with expected fields."""
    os.chdir(tmp_path)
    run_init(project_dir=None, quickstart=True, console=_console())

    schema_path = tmp_path / "schemas" / "invoice.yaml"
    assert schema_path.exists()

    schema = yaml.safe_load(schema_path.read_text())
    assert schema["name"] == "invoice"
    assert "invoice_number" in schema["fields"]
    assert "vendor_name" in schema["fields"]
    assert "date" in schema["fields"]
    assert "total_amount" in schema["fields"]
    assert "line_items" in schema["fields"]


def test_init_with_project_dir(tmp_path):
    """koji init myproject creates myproject/ with koji.yaml inside."""
    os.chdir(tmp_path)
    run_init(project_dir=str(tmp_path / "myproject"), quickstart=True, console=_console())

    config_path = tmp_path / "myproject" / "koji.yaml"
    assert config_path.exists()

    content = config_path.read_text()
    assert "project: myproject" in content

    schema_path = tmp_path / "myproject" / "schemas" / "invoice.yaml"
    assert schema_path.exists()


def test_init_wont_overwrite(tmp_path):
    """koji init refuses to overwrite an existing koji.yaml."""
    os.chdir(tmp_path)
    (tmp_path / "koji.yaml").write_text("existing config")

    try:
        run_init(project_dir=None, quickstart=True, console=_console())
        assert False, "Expected SystemExit"
    except SystemExit as e:
        assert e.code == 1

    # Original content should be untouched
    assert (tmp_path / "koji.yaml").read_text() == "existing config"


def test_init_default_skips_schema(tmp_path):
    """koji init creates koji.yaml but no schemas directory by default."""
    os.chdir(tmp_path)
    run_init(project_dir=None, quickstart=False, console=_console())

    assert (tmp_path / "koji.yaml").exists()
    assert not (tmp_path / "schemas").exists()


def test_init_generated_yaml_is_valid(tmp_path):
    """The generated koji.yaml is valid YAML that can be parsed."""
    os.chdir(tmp_path)
    run_init(project_dir=None, quickstart=False, console=_console())

    config = yaml.safe_load((tmp_path / "koji.yaml").read_text())
    assert config["project"] == tmp_path.name
    assert config["cluster"]["base_port"] == 9400
    assert config["output"]["structured"] == "./output/"
