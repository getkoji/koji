#!/usr/bin/env python3
"""Local static server for the Scalar preview at docs/index.html.

Registers `application/yaml` for .yaml/.yml so Scalar's fetch-and-parse path
accepts the OpenAPI document. Python's default mimetypes table serves these
as application/octet-stream, which Scalar rejects with a "could not be
loaded" error.

Binds to 127.0.0.1 only — this is a dev tool, never exposed publicly.
"""
from __future__ import annotations

import http.server
import mimetypes

PORT = 9601
BIND = "127.0.0.1"

mimetypes.add_type("application/yaml", ".yaml")
mimetypes.add_type("application/yaml", ".yml")


def main() -> None:
    http.server.test(
        HandlerClass=http.server.SimpleHTTPRequestHandler,
        port=PORT,
        bind=BIND,
    )


if __name__ == "__main__":
    main()
