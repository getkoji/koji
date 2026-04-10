"""Document processing via the Koji API."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
from rich.console import Console


def process_file(
    file_path: Path,
    server_url: str,
    output_dir: str,
    console: Console,
) -> bool:
    """Send a file to the parse service and save results."""
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    try:
        with open(file_path, "rb") as f:
            resp = httpx.post(
                f"{server_url}/api/parse",
                files={"file": (file_path.name, f)},
                timeout=300,
            )

        if resp.status_code != 200:
            error = resp.json().get("error", "Unknown error")
            console.print(f"  [red]x[/red] {file_path.name} — {error}")
            return False

        result = resp.json()

        # Save markdown
        md_path = out / f"{file_path.stem}.md"
        md_path.write_text(result["markdown"])

        # Save full result as JSON
        json_path = out / f"{file_path.stem}.json"
        json_path.write_text(json.dumps(result, indent=2))

        pages = result.get("pages", "?")
        elapsed = result.get("elapsed_seconds", "?")
        console.print(f"  [green]✓[/green] {file_path.name} — {pages} pages, {elapsed}s → {md_path}")
        return True

    except httpx.ConnectError:
        console.print(f"  [red]x[/red] {file_path.name} — server unreachable")
        return False
    except httpx.ReadTimeout:
        console.print(f"  [red]x[/red] {file_path.name} — timeout (document may be too large)")
        return False
