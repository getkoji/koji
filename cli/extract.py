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
    strategy: str | None = None,
    model: str | None = None,
) -> bool:
    """Send markdown + schema to the extract service."""
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    markdown = md_path.read_text()
    schema_content = schema_path.read_text()

    payload: dict = {
        "markdown": markdown,
        "schema": schema_content,
    }
    if strategy:
        payload["strategy"] = strategy
    if model:
        payload["model"] = model

    try:
        resp = httpx.post(
            f"{server_url}/api/extract",
            json=payload,
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
        elapsed_ms = result.get("elapsed_ms", "?")
        strategy = result.get("strategy", "")

        # Build a clean summary based on strategy
        details = []
        if result.get("extraction_groups"):
            details.append(f"{result['extraction_groups']} calls")
        if result.get("chunks_total"):
            details.append(f"{result['chunks_total']} chunks")
        if result.get("tool_calls"):
            details.append(f"{result['tool_calls']} tool calls")

        detail_str = f" ({', '.join(details)})" if details else ""
        console.print(
            f"  [green]✓[/green] {md_path.name} — {model}, "
            f"{elapsed_ms}ms{detail_str} → {json_path}"
        )
        return True

    except httpx.ConnectError:
        console.print(f"  [red]x[/red] {md_path.name} — server unreachable")
        return False
    except httpx.ReadTimeout:
        console.print(f"  [red]x[/red] {md_path.name} — timeout")
        return False
