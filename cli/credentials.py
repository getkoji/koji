"""Koji CLI credentials store.

Stores API keys and server URLs in ~/.koji/credentials (YAML).
Supports multiple profiles for different servers/projects.

Format:
    current: acme
    profiles:
      acme:
        url: https://koji.acme.internal
        api_key: koji_abc123...
        project: claims-prod
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


def _credentials_path() -> Path:
    """Return the credentials file path, respecting XDG on Linux."""
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        return Path(xdg) / "koji" / "credentials"
    return Path.home() / ".koji" / "credentials"


@dataclass
class Profile:
    url: str
    api_key: str
    project: str | None = None
    name: str | None = None  # profile name, set when loaded


@dataclass
class Credentials:
    current: str | None = None
    profiles: dict[str, Profile] = field(default_factory=dict)

    def active_profile(self) -> Profile | None:
        if self.current and self.current in self.profiles:
            return self.profiles[self.current]
        return None

    def save(self) -> None:
        path = _credentials_path()
        path.parent.mkdir(parents=True, exist_ok=True)

        data: dict[str, Any] = {}
        if self.current:
            data["current"] = self.current
        data["profiles"] = {}
        for name, p in self.profiles.items():
            entry: dict[str, str] = {"url": p.url, "api_key": p.api_key}
            if p.project:
                entry["project"] = p.project
            data["profiles"][name] = entry

        path.write_text(yaml.dump(data, default_flow_style=False))
        # Restrict permissions — this file contains secrets
        path.chmod(0o600)


def load_credentials() -> Credentials:
    path = _credentials_path()
    if not path.exists():
        return Credentials()

    raw = yaml.safe_load(path.read_text()) or {}
    creds = Credentials(current=raw.get("current"))

    for name, entry in raw.get("profiles", {}).items():
        if isinstance(entry, dict) and "url" in entry and "api_key" in entry:
            creds.profiles[name] = Profile(
                url=entry["url"],
                api_key=entry["api_key"],
                project=entry.get("project"),
                name=name,
            )

    return creds


def get_active_profile() -> Profile | None:
    """Load credentials and return the active profile, or None."""
    return load_credentials().active_profile()


def get_api_headers() -> dict[str, str]:
    """Return headers for authenticated API requests, or empty dict."""
    profile = get_active_profile()
    if not profile:
        return {}
    return {"Authorization": f"Bearer {profile.api_key}"}


def get_server_url() -> str | None:
    """Return the active profile's server URL, or None."""
    profile = get_active_profile()
    return profile.url if profile else None


def verify_profile_connectivity(profile: Profile) -> tuple[bool, str]:
    """Check whether the profile's API key actually authenticates.

    Probes ``GET /api/me`` *with the key* — not the public ``/api/health`` — so an
    expired or invalid key is reported as such instead of a false "connected".
    On success the message names the authenticated user and org(s), which is what
    actually answers "who/where am I".

    Returns (ok, message).
    """
    import httpx

    headers = {"Authorization": f"Bearer {profile.api_key}"}
    try:
        resp = httpx.get(f"{profile.url}/api/me", headers=headers, timeout=5)
    except httpx.ConnectError:
        return False, (
            f"cannot connect to {profile.url} — is the server running? "
            f"If the port changed, run: koji login {profile.url.rsplit(':', 1)[0]}:<new-port>"
        )
    except httpx.TimeoutException:
        return False, f"connection to {profile.url} timed out"

    if resp.status_code in (401, 403):
        return False, "API key is invalid or expired — run `koji login` to refresh it"
    if resp.status_code != 200:
        return False, f"server reachable but /api/me returned HTTP {resp.status_code}"

    # Authenticated. Enrich with identity + org(s) so whoami is actually useful.
    who = ""
    try:
        user = resp.json()
        who = user.get("email") or user.get("name") or ""
    except Exception:
        pass

    org = ""
    try:
        t = httpx.get(f"{profile.url}/api/tenants", headers=headers, timeout=5)
        if t.status_code == 200:
            names = [r.get("slug") or r.get("name") for r in t.json().get("data", [])]
            names = [n for n in names if n]
            if names:
                org = ", ".join(names[:5])
    except Exception:
        pass

    # Note: /api/tenants lists the user's memberships, not the single tenant the
    # API key is bound to — so this is "member of", not "current org".
    if who and org:
        return True, f"authenticated as {who} · member of: {org}"
    if who:
        return True, f"authenticated as {who}"
    if org:
        return True, f"authenticated · member of: {org}"
    return True, "authenticated"
