"""MkDocs hook to regenerate llms-full.txt on every build."""

import subprocess
import sys
from pathlib import Path


def on_pre_build(**kwargs):
    script = Path(__file__).resolve().parent / "build-llms-full.py"
    subprocess.run([sys.executable, str(script)], check=True)
