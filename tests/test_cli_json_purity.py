"""Guard: machine-readable CLI output must never route through rich.

rich's print_json injects ANSI style codes whenever stdout looks like a
terminal (agent harnesses run CLI commands under a pty), which breaks
json.loads for anything piping `--json` output. All JSON emission goes
through cli.remote.emit_json (plain print) instead.
"""

from pathlib import Path

CLI_DIR = Path(__file__).parent.parent / "cli"


def test_no_rich_print_json_in_cli():
    offenders = []
    for path in sorted(CLI_DIR.glob("*.py")):
        for lineno, line in enumerate(path.read_text().splitlines(), 1):
            if ".print_json(" in line:
                offenders.append(f"{path.name}:{lineno}: {line.strip()}")
    assert not offenders, (
        "rich print_json emits ANSI under a pty and breaks --json consumers; "
        "use cli.remote.emit_json instead:\n" + "\n".join(offenders)
    )
