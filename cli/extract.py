"""Extract structured data from already-parsed markdown."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
from rich.console import Console


def extract_from_markdown(
    md_path: Path,
    schema_path: Path,
    server_url: str,
    output_dir: str,
    console: Console,
) -> bool:
    """Send markdown + schema to the extract service."""
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    markdown = md_path.read_text()
    schema_content = schema_path.read_text()

    try:
        resp = httpx.post(
            f"{server_url}/api/extract",
            json={
                "markdown": markdown,
                "schema": schema_content,
            },
            timeout=1800,
        )

        if resp.status_code != 200:
            try:
                error = resp.json().get("error", "Unknown error")
            except Exception:
                error = resp.text[:200] or f"HTTP {resp.status_code}"
            console.print(f"  [red]x[/red] {md_path.name} — {error}")
            return False

        result = resp.json()
        extracted = result.get("extracted", result)

        json_path = out / f"{md_path.stem}.json"
        json_path.write_text(json.dumps(extracted, indent=2))

        model = result.get("model", "?")
        extract_ms = result.get("extract_ms", "?")
        console.print(f"  [green]✓[/green] {md_path.name} — extracted via {model} ({extract_ms}ms) → {json_path}")
        return True

    except httpx.ConnectError:
        console.print(f"  [red]x[/red] {md_path.name} — server unreachable")
        return False
    except httpx.ReadTimeout:
        console.print(f"  [red]x[/red] {md_path.name} — timeout")
        return False
