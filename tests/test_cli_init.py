"""Tests for koji init command."""

from __future__ import annotations

import io
import os

import pytest
import yaml
from rich.console import Console

from cli.init import list_templates, run_init, run_list_templates


def _console() -> Console:
    return Console(quiet=True)


def _capture_console() -> Console:
    return Console(
        file=io.StringIO(),
        force_terminal=False,
        width=120,
        color_system=None,
        highlight=False,
        soft_wrap=True,
    )


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


def test_init_invoice_template_includes_sample(tmp_path):
    """koji init --template invoice ships with a sample markdown file."""
    os.chdir(tmp_path)
    run_init(project_dir=None, quickstart=False, console=_console(), template="invoice")

    sample_path = tmp_path / "samples" / "invoice_sample.md"
    assert sample_path.exists(), "invoice template should ship with a sample markdown file"

    content = sample_path.read_text()
    assert "Invoice" in content
    assert "INV-" in content  # has an invoice number
    assert "Total" in content  # has a total line


def test_init_receipt_template_includes_sample(tmp_path):
    """koji init --template receipt ships with a sample markdown file."""
    os.chdir(tmp_path)
    run_init(project_dir=None, quickstart=False, console=_console(), template="receipt")

    sample_path = tmp_path / "samples" / "receipt_sample.md"
    assert sample_path.exists()


def test_init_contract_template_includes_sample(tmp_path):
    """koji init --template contract ships with a sample markdown file."""
    os.chdir(tmp_path)
    run_init(project_dir=None, quickstart=False, console=_console(), template="contract")

    sample_path = tmp_path / "samples" / "contract_sample.md"
    assert sample_path.exists()


def test_init_generated_yaml_is_valid(tmp_path):
    """The generated koji.yaml is valid YAML that can be parsed."""
    os.chdir(tmp_path)
    run_init(project_dir=None, quickstart=False, console=_console())

    config = yaml.safe_load((tmp_path / "koji.yaml").read_text())
    assert config["project"] == tmp_path.name
    assert config["cluster"]["base_port"] == 9400
    assert config["output"]["structured"] == "./output/"


# ---------------------------------------------------------------------------
# Template system
# ---------------------------------------------------------------------------


EXPECTED_TEMPLATES = {"invoice", "insurance", "receipt", "contract", "form"}


def test_list_templates_returns_all_bundled_templates():
    """list_templates() returns every template shipped in cli/templates/."""
    names = {t.name for t in list_templates()}
    assert EXPECTED_TEMPLATES.issubset(names)


def test_list_templates_have_descriptions():
    """Every bundled template has a human-readable description."""
    for info in list_templates():
        if info.name in EXPECTED_TEMPLATES:
            assert info.description, f"template {info.name} has no description"


def test_init_template_invoice_creates_expected_files(tmp_path):
    """`koji init --template invoice` scaffolds koji.yaml and schemas/invoice.yaml."""
    project = tmp_path / "myproject"
    run_init(project_dir=str(project), quickstart=False, console=_console(), template="invoice")

    assert (project / "koji.yaml").exists()
    schema_path = project / "schemas" / "invoice.yaml"
    assert schema_path.exists()

    schema = yaml.safe_load(schema_path.read_text())
    assert schema["name"] == "invoice"
    assert "invoice_number" in schema["fields"]
    assert "vendor_name" in schema["fields"]
    assert "total_amount" in schema["fields"]

    # The rendered koji.yaml should be valid YAML with the expected project name.
    config = yaml.safe_load((project / "koji.yaml").read_text())
    assert config["project"] == "myproject"
    assert config["cluster"]["base_port"] == 9400

    # README from the template should NOT be copied into the scaffolded project.
    assert not (project / "README.md").exists()


def test_init_template_insurance_creates_expected_files(tmp_path):
    """`koji init --template insurance` scaffolds the insurance policy schema."""
    project = tmp_path / "broker"
    run_init(project_dir=str(project), quickstart=False, console=_console(), template="insurance")

    schema_path = project / "schemas" / "insurance_policy.yaml"
    assert schema_path.exists()

    schema = yaml.safe_load(schema_path.read_text())
    assert schema["name"] == "insurance_policy"
    assert "policy_number" in schema["fields"]
    assert "insured_name" in schema["fields"]
    assert "coverages" in schema["fields"]
    # Hints-driven routing requires categories.
    assert "categories" in schema
    assert "declarations" in schema["categories"]["keywords"]


def test_init_template_receipt_creates_expected_files(tmp_path):
    project = tmp_path / "expenses"
    run_init(project_dir=str(project), quickstart=False, console=_console(), template="receipt")

    schema = yaml.safe_load((project / "schemas" / "receipt.yaml").read_text())
    assert schema["name"] == "receipt"
    assert "merchant_name" in schema["fields"]
    assert "total" in schema["fields"]
    assert "items" in schema["fields"]


def test_init_template_contract_creates_expected_files(tmp_path):
    project = tmp_path / "legal"
    run_init(project_dir=str(project), quickstart=False, console=_console(), template="contract")

    schema = yaml.safe_load((project / "schemas" / "contract.yaml").read_text())
    assert schema["name"] == "contract"
    assert "parties" in schema["fields"]
    assert "effective_date" in schema["fields"]
    assert schema["fields"]["parties"]["required"] is True


def test_init_template_form_creates_expected_files(tmp_path):
    project = tmp_path / "intake"
    run_init(project_dir=str(project), quickstart=False, console=_console(), template="form")

    schema = yaml.safe_load((project / "schemas" / "form.yaml").read_text())
    assert schema["name"] == "form"
    assert "full_name" in schema["fields"]
    assert "mailing_address" in schema["fields"]
    assert "checkboxes" in schema["fields"]


def test_init_template_nonexistent_errors_gracefully(tmp_path):
    """An unknown template name prints available templates and exits 1."""
    os.chdir(tmp_path)
    console = _capture_console()

    with pytest.raises(SystemExit) as exc:
        run_init(project_dir=None, quickstart=False, console=console, template="nonexistent")
    assert exc.value.code == 1

    output = console.file.getvalue()
    assert "Unknown template" in output
    # The error path should surface the available templates.
    assert "invoice" in output
    # Nothing should have been written.
    assert not (tmp_path / "koji.yaml").exists()


def test_init_quickstart_is_alias_for_invoice_template(tmp_path):
    """`--quickstart` remains an alias for `--template invoice`."""
    project = tmp_path / "proj"
    run_init(project_dir=str(project), quickstart=True, console=_console())

    assert (project / "schemas" / "invoice.yaml").exists()
    schema = yaml.safe_load((project / "schemas" / "invoice.yaml").read_text())
    assert schema["name"] == "invoice"


def test_init_template_takes_precedence_over_quickstart(tmp_path):
    """An explicit --template overrides --quickstart."""
    project = tmp_path / "mix"
    run_init(project_dir=str(project), quickstart=True, console=_console(), template="receipt")

    # Receipt schema should exist, not invoice.
    assert (project / "schemas" / "receipt.yaml").exists()
    assert not (project / "schemas" / "invoice.yaml").exists()


def test_list_templates_command_output():
    """`koji init --list-templates` prints each bundled template by name."""
    console = _capture_console()
    run_list_templates(console)
    output = console.file.getvalue()

    for name in EXPECTED_TEMPLATES:
        assert name in output
    assert "koji init" in output


def test_bundled_template_schemas_parse_as_valid_yaml():
    """Every template's schema files must parse as valid YAML with a `name` field."""
    from importlib.resources import files

    templates_root = files("cli") / "templates"
    for template in templates_root.iterdir():
        if not template.is_dir() or template.name.startswith(("_", ".")):
            continue
        # koji.yaml renders with a {project} placeholder, so we skip YAML parsing
        # of the raw template file and only check the schemas directory.
        schemas_dir = template / "schemas"
        if not schemas_dir.is_dir():
            continue
        for schema_file in schemas_dir.iterdir():
            if not schema_file.is_file():
                continue
            if not (schema_file.name.endswith(".yaml") or schema_file.name.endswith(".yml")):
                continue
            schema = yaml.safe_load(schema_file.read_text())
            assert isinstance(schema, dict), f"{schema_file} did not parse to a dict"
            assert "name" in schema, f"{schema_file} is missing a `name` field"
            assert "fields" in schema, f"{schema_file} is missing a `fields` block"


def test_rendered_koji_yaml_substitutes_project_name(tmp_path):
    """The {project} placeholder in template koji.yaml is substituted with the project name."""
    project = tmp_path / "acme-intake"
    run_init(project_dir=str(project), quickstart=False, console=_console(), template="contract")

    text = (project / "koji.yaml").read_text()
    assert "{project}" not in text  # no unsubstituted placeholders
    config = yaml.safe_load(text)
    assert config["project"] == "acme-intake"
