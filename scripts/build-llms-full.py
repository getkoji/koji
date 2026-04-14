#!/usr/bin/env python3
"""Generate llms-full.txt by concatenating all doc pages.

Run from the koji project root:
    python scripts/build-llms-full.py

Output is written to docs/llms-full.txt. This is also run as part of
the MkDocs build via the hook in scripts/mkdocs-hooks.py.
"""

from pathlib import Path

DOCS_DIR = Path(__file__).resolve().parent.parent / "docs"
NAV_ORDER = [
    "index.md",
    "getting-started.md",
    "schema-guide.md",
    "configuration.md",
    "architecture.md",
    "cli.md",
    "api-reference.md",
]


def strip_frontmatter(text: str) -> str:
    """Remove YAML frontmatter from markdown."""
    if text.startswith("---"):
        end = text.find("---", 3)
        if end != -1:
            return text[end + 3 :].lstrip("\n")
    return text


def build() -> str:
    parts = ["# Koji — Full Documentation\n"]
    for filename in NAV_ORDER:
        path = DOCS_DIR / filename
        if not path.exists():
            continue
        content = strip_frontmatter(path.read_text())
        parts.append(content.strip())
    return "\n\n---\n\n".join(parts) + "\n"


def main() -> None:
    output = DOCS_DIR / "llms-full.txt"
    output.write_text(build())
    print(f"Wrote {output}")


if __name__ == "__main__":
    main()
