"""Koji Dashboard — lightweight HTTP server with API proxy."""

import http.server
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

KOJI_SERVER_URL = os.environ.get("KOJI_SERVER_URL", "http://koji-server:9401")
PORT = int(os.environ.get("PORT", "9400"))
STATIC_DIR = Path(__file__).parent / "static"


class DashboardHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def do_GET(self):
        if self.path.startswith("/api/"):
            self._proxy("GET")
        else:
            super().do_GET()

    def _proxy(self, method: str):
        target_url = f"{KOJI_SERVER_URL}{self.path}"
        req = urllib.request.Request(target_url, method=method)
        req.add_header("Accept", "application/json")

        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                body = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)
        except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
            error = json.dumps({"error": "Backend unavailable", "detail": str(e)}).encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(error)

    def log_message(self, fmt, *args):
        print(f"[koji-ui] {args[0]} {args[1]} {args[2]}")


def main():
    server = http.server.HTTPServer(("0.0.0.0", PORT), DashboardHandler)
    print(f"[koji-ui] Dashboard at http://0.0.0.0:{PORT}")
    print(f"[koji-ui] Proxying /api/* -> {KOJI_SERVER_URL}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()


if __name__ == "__main__":
    main()
