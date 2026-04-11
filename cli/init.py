"""koji init — scaffold a new Koji project."""

from __future__ import annotations

from pathlib import Path

from rich.console import Console

KOJI_YAML_TEMPLATE = """\
# Koji configuration
# Docs: https://getkoji.dev/docs/configuration

project: {project}

cluster:
  base_port: 9400

output:
  structured: ./output/
"""

EXAMPLE_SCHEMA = """\
name: invoice
description: Simple invoice extraction schema

fields:
  invoice_number:
    type: string
    required: true
    description: The invoice or reference number

  vendor_name:
    type: string
    required: true
    description: Vendor or supplier name

  date:
    type: date
    required: true
    description: Invoice date

  total_amount:
    type: number
    required: true
    description: Total invoice amount

  line_items:
    type: array
    description: Individual line items on the invoice
    items:
      type: object
      properties:
        description:
          type: string
        quantity:
          type: number
        unit_price:
          type: number
        amount:
          type: number
"""


def run_init(
    project_dir: str | None,
    quickstart: bool,
    console: Console,
) -> None:
    """Scaffold a new Koji project directory."""
    if project_dir:
        target = Path(project_dir)
        target.mkdir(parents=True, exist_ok=True)
        project_name = target.name
    else:
        target = Path.cwd()
        project_name = target.name

    config_path = target / "koji.yaml"

    if config_path.exists():
        console.print(
            f"[yellow]koji.yaml already exists in {target}. Remove it first if you want to re-initialize.[/yellow]"
        )
        raise SystemExit(1)

    # Write koji.yaml
    config_path.write_text(KOJI_YAML_TEMPLATE.format(project=project_name))
    console.print(f"  [green]created[/green] {config_path}")

    # Write example schema with --quickstart
    if quickstart:
        schemas_dir = target / "schemas"
        schemas_dir.mkdir(parents=True, exist_ok=True)
        schema_path = schemas_dir / "invoice.yaml"
        schema_path.write_text(EXAMPLE_SCHEMA)
        console.print(f"  [green]created[/green] {schema_path}")

    # What's next
    console.print()
    console.print("[bold]What's next?[/bold]")
    console.print("  1. [cyan]koji start[/cyan]    — start the processing cluster")
    if quickstart:
        console.print("  2. [cyan]koji process ./doc.pdf --schema schemas/invoice.yaml[/cyan]")
    else:
        console.print("  2. Create a schema: [cyan]schemas/my_schema.yaml[/cyan]")
        console.print("  3. [cyan]koji process ./doc.pdf --schema schemas/my_schema.yaml[/cyan]")
