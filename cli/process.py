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
    schema_path: Path | None = None,
) -> bool:
    """Send a file through the pipeline and save results."""
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    # Build the request
    files = {"file": (file_path.name, open(file_path, "rb"))}
    data = {}

    if schema_path:
        schema_content = schema_path.read_text()
        data["schema"] = schema_content

    try:
        endpoint = "/api/process" if schema_path else "/api/parse"
        resp = httpx.post(
            f"{server_url}{endpoint}",
            files=files,
            data=data,
            timeout=1800,
        )

        if resp.status_code != 200:
            try:
                error = resp.json().get("error", "Unknown error")
            except Exception:
                error = resp.text[:200] or f"HTTP {resp.status_code}"
            console.print(f"  [red]x[/red] {file_path.name} — {error}")
            return False

        result = resp.json()

        if schema_path and "extracted" in result:
            # Full pipeline result — save extracted JSON
            json_path = out / f"{file_path.stem}.json"
            json_path.write_text(json.dumps(result["extracted"], indent=2))

            pages = result.get("pages", "?")
            parse_time = result.get("parse_seconds", "?")
            model = result.get("model", "?")
            extract_ms = result.get("extract_ms", "?")
            console.print(
                f"  [green]✓[/green] {file_path.name} — {pages} pages, "
                f"parsed {parse_time}s, extracted via {model} ({extract_ms}ms) → {json_path}"
            )

            # Also save markdown as a bonus
            if "markdown" not in result:
                # The /api/process endpoint doesn't return markdown in the response
                # to keep it lightweight — the markdown was used internally for extraction
                pass
        else:
            # Parse-only result — save markdown
            md_path = out / f"{file_path.stem}.md"
            md_path.write_text(result["markdown"])

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
