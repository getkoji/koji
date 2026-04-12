"""koji init — scaffold a new Koji project."""

from __future__ import annotations

from dataclasses import dataclass
from importlib.resources import files
from pathlib import Path
from typing import TYPE_CHECKING

from rich.console import Console

if TYPE_CHECKING:
    from importlib.resources.abc import Traversable

# Fallback koji.yaml used when no template is selected.
DEFAULT_KOJI_YAML = """\
# Koji configuration
# Docs: https://getkoji.dev/docs/configuration

project: {project}

cluster:
  base_port: 9400
  # By default, koji start pulls pre-built images from ghcr.io/getkoji.
  # Pin a release by setting version: v0.2.0 (default: "latest").
  # Contributors can build from local source with `koji start --dev`.

output:
  structured: ./output/
"""


@dataclass
class TemplateInfo:
    """Metadata about a bundled template."""

    name: str
    description: str


def _templates_root() -> Traversable:
    """Return the root Traversable for bundled templates."""
    return files("cli") / "templates"


def list_templates() -> list[TemplateInfo]:
    """List all available templates, sorted by name."""
    root = _templates_root()
    templates: list[TemplateInfo] = []
    for entry in sorted(root.iterdir(), key=lambda p: p.name):
        if not entry.is_dir():
            continue
        # Skip dunder / hidden entries like __pycache__.
        if entry.name.startswith(("_", ".")):
            continue
        # Every real template must have a koji.yaml.
        if not (entry / "koji.yaml").is_file():
            continue
        templates.append(TemplateInfo(name=entry.name, description=_read_description(entry)))
    return templates


def _read_description(template: Traversable) -> str:
    """Extract a short description for a template.

    Priority:
      1. A "# description: <text>" comment inside the template's koji.yaml.
      2. The first non-heading, non-empty line from README.md.
      3. An empty string.
    """
    koji_yaml = template / "koji.yaml"
    if koji_yaml.is_file():
        for line in koji_yaml.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped.lower().startswith("# description:"):
                return stripped.split(":", 1)[1].strip()

    readme = template / "README.md"
    if readme.is_file():
        for line in readme.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            return stripped
    return ""


def _template_exists(name: str) -> bool:
    template = _templates_root() / name
    return template.is_dir() and (template / "koji.yaml").is_file()


def _render_koji_yaml(template_name: str | None, project_name: str) -> str:
    """Return the koji.yaml text for a template, with the project name rendered.

    Bundled koji.yaml files contain a literal `{project}` placeholder which is
    substituted here via str.replace — avoids str.format consuming other
    curly braces that may appear elsewhere in the file.
    """
    if template_name is None:
        text = DEFAULT_KOJI_YAML
    else:
        koji_yaml = _templates_root() / template_name / "koji.yaml"
        text = koji_yaml.read_text(encoding="utf-8")
    return text.replace("{project}", project_name)


def _copy_template_extras(
    template_name: str,
    target: Path,
    console: Console,
) -> None:
    """Copy every file in a template into target, skipping koji.yaml and README.md."""
    template_root = _templates_root() / template_name

    def _walk(src: Traversable, rel: Path) -> None:
        for entry in sorted(src.iterdir(), key=lambda p: p.name):
            entry_rel = rel / entry.name
            if entry.is_dir():
                _walk(entry, entry_rel)
                continue
            # Skip the template's own koji.yaml and README at the top level —
            # koji.yaml is rendered separately, README is documentation only.
            if rel == Path(".") and entry.name in {"koji.yaml", "README.md"}:
                continue
            dest = target / entry_rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(entry.read_bytes())
            console.print(f"  [green]created[/green] {dest}")

    _walk(template_root, Path("."))


def _print_available_templates(console: Console) -> None:
    console.print("[bold]Available templates:[/bold]")
    for info in list_templates():
        suffix = f" — {info.description}" if info.description else ""
        console.print(f"  [cyan]{info.name}[/cyan]{suffix}")


def run_list_templates(console: Console) -> None:
    """Implement `koji init --list-templates`."""
    templates = list_templates()
    if not templates:
        console.print("[yellow]No templates found.[/yellow]")
        return
    console.print("[bold]Koji project templates[/bold]\n")
    for info in templates:
        suffix = f" — {info.description}" if info.description else ""
        console.print(f"  [cyan]{info.name}[/cyan]{suffix}")
    console.print()
    console.print("Use with: [cyan]koji init <name> --template <template>[/cyan]")


def _first_schema_path(target: Path) -> Path | None:
    schemas_dir = target / "schemas"
    if not schemas_dir.is_dir():
        return None
    for entry in sorted(schemas_dir.iterdir()):
        if entry.is_file() and entry.suffix in {".yaml", ".yml"}:
            return entry
    return None


def _first_sample_path(target: Path) -> Path | None:
    samples_dir = target / "samples"
    if not samples_dir.is_dir():
        return None
    for entry in sorted(samples_dir.iterdir()):
        if entry.is_file() and entry.suffix == ".md":
            return entry
    return None


def run_init(
    project_dir: str | None,
    quickstart: bool,
    console: Console,
    template: str | None = None,
) -> None:
    """Scaffold a new Koji project directory.

    `--template` takes precedence over `--quickstart`. The `--quickstart`
    flag is kept for backwards compatibility and is equivalent to
    `--template invoice`.
    """
    if template is None and quickstart:
        template = "invoice"

    if template is not None and not _template_exists(template):
        console.print(f"[red]Unknown template: {template}[/red]\n")
        _print_available_templates(console)
        raise SystemExit(1)

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

    # Write koji.yaml (template-aware)
    config_path.write_text(_render_koji_yaml(template, project_name))
    console.print(f"  [green]created[/green] {config_path}")

    # Copy any extra files from the template (schemas, etc.)
    if template is not None:
        _copy_template_extras(template, target, console)

    # What's next
    console.print()
    console.print("[bold]What's next?[/bold]")
    console.print("  1. [cyan]koji start[/cyan]    — start the processing cluster")
    if template is not None:
        schema_hint = _first_schema_path(target)
        sample_hint = _first_sample_path(target)
        if sample_hint is not None and schema_hint is not None:
            schema_rel = schema_hint.relative_to(target)
            sample_rel = sample_hint.relative_to(target)
            console.print(
                f"  2. [cyan]koji extract ./{sample_rel} --schema {schema_rel} --model openai/gpt-4o-mini[/cyan]"
            )
            console.print(
                f"     [dim]Try it on the bundled sample, or use "
                f"[cyan]koji process ./your.pdf --schema {schema_rel}[/cyan] for your own docs.[/dim]"
            )
        elif schema_hint is not None:
            rel = schema_hint.relative_to(target)
            console.print(f"  2. [cyan]koji process ./doc.pdf --schema {rel}[/cyan]")
        else:
            console.print("  2. [cyan]koji process ./doc.pdf[/cyan]")
    else:
        console.print("  2. Create a schema: [cyan]schemas/my_schema.yaml[/cyan]")
        console.print("  3. [cyan]koji process ./doc.pdf --schema schemas/my_schema.yaml[/cyan]")
