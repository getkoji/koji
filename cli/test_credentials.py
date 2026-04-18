"""Tests for the CLI credentials store."""

import os
import tempfile
from pathlib import Path

import pytest
import yaml

# Patch the credentials path before import
_tmpdir = tempfile.mkdtemp()
os.environ["XDG_CONFIG_HOME"] = _tmpdir

from cli.credentials import (
    Credentials,
    Profile,
    _credentials_path,
    get_active_profile,
    get_api_headers,
    get_server_url,
    load_credentials,
)


def _reset():
    """Remove credentials file between tests."""
    p = _credentials_path()
    if p.exists():
        p.unlink()


class TestCredentialsPath:
    def test_respects_xdg(self):
        path = _credentials_path()
        assert str(path).startswith(_tmpdir)
        assert path.name == "credentials"


class TestSaveAndLoad:
    def setup_method(self):
        _reset()

    def test_roundtrip(self):
        creds = Credentials(
            current="acme",
            profiles={
                "acme": Profile(url="https://koji.acme.dev", api_key="koji_abc123", project="claims"),
                "local": Profile(url="http://localhost:9401", api_key="koji_def456"),
            },
        )
        creds.save()

        loaded = load_credentials()
        assert loaded.current == "acme"
        assert len(loaded.profiles) == 2
        assert loaded.profiles["acme"].url == "https://koji.acme.dev"
        assert loaded.profiles["acme"].api_key == "koji_abc123"
        assert loaded.profiles["acme"].project == "claims"
        assert loaded.profiles["local"].url == "http://localhost:9401"
        assert loaded.profiles["local"].project is None

    def test_file_permissions(self):
        creds = Credentials(current="test", profiles={"test": Profile(url="http://x", api_key="k")})
        creds.save()

        path = _credentials_path()
        mode = oct(path.stat().st_mode)[-3:]
        assert mode == "600"

    def test_empty_load(self):
        creds = load_credentials()
        assert creds.current is None
        assert len(creds.profiles) == 0

    def test_overwrite(self):
        c1 = Credentials(current="a", profiles={"a": Profile(url="http://1", api_key="k1")})
        c1.save()

        c2 = Credentials(current="b", profiles={"b": Profile(url="http://2", api_key="k2")})
        c2.save()

        loaded = load_credentials()
        assert loaded.current == "b"
        assert "a" not in loaded.profiles
        assert loaded.profiles["b"].api_key == "k2"


class TestActiveProfile:
    def setup_method(self):
        _reset()

    def test_returns_active(self):
        creds = Credentials(
            current="prod",
            profiles={"prod": Profile(url="http://x", api_key="koji_key")},
        )
        creds.save()

        profile = get_active_profile()
        assert profile is not None
        assert profile.api_key == "koji_key"

    def test_returns_none_when_no_current(self):
        creds = Credentials(profiles={"a": Profile(url="http://x", api_key="k")})
        creds.save()

        assert get_active_profile() is None

    def test_returns_none_when_no_file(self):
        assert get_active_profile() is None


class TestHelpers:
    def setup_method(self):
        _reset()

    def test_get_api_headers(self):
        creds = Credentials(
            current="test",
            profiles={"test": Profile(url="http://x", api_key="koji_secret")},
        )
        creds.save()

        headers = get_api_headers()
        assert headers == {"Authorization": "Bearer koji_secret"}

    def test_get_api_headers_empty(self):
        assert get_api_headers() == {}

    def test_get_server_url(self):
        creds = Credentials(
            current="test",
            profiles={"test": Profile(url="http://localhost:9401", api_key="k")},
        )
        creds.save()

        assert get_server_url() == "http://localhost:9401"

    def test_get_server_url_none(self):
        assert get_server_url() is None


class TestMultipleProfiles:
    def setup_method(self):
        _reset()

    def test_switch_profile(self):
        creds = Credentials(
            current="staging",
            profiles={
                "prod": Profile(url="http://prod", api_key="k1"),
                "staging": Profile(url="http://staging", api_key="k2"),
            },
        )
        creds.save()

        assert get_server_url() == "http://staging"

        # Switch
        creds = load_credentials()
        creds.current = "prod"
        creds.save()

        assert get_server_url() == "http://prod"
        assert get_api_headers() == {"Authorization": "Bearer k1"}
