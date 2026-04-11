"""Tests for cli/compose.py — docker-compose generation."""

from __future__ import annotations

from cli.compose import generate_compose
from server.config import KojiConfig, ServicesConfig


class TestGenerateCompose:
    def test_parse_service_has_hf_cache_volume(self):
        config = KojiConfig(project="test")
        compose = generate_compose(config, "/tmp/koji")
        parse_volumes = compose["services"]["koji-parse"]["volumes"]
        assert "koji-test-hf-cache:/root/.cache/huggingface" in parse_volumes

    def test_parse_service_has_torch_cache_volume(self):
        config = KojiConfig(project="test")
        compose = generate_compose(config, "/tmp/koji")
        parse_volumes = compose["services"]["koji-parse"]["volumes"]
        assert "koji-test-torch-cache:/root/.cache/torch" in parse_volumes

    def test_top_level_volumes_include_cache_volumes(self):
        config = KojiConfig(project="test")
        compose = generate_compose(config, "/tmp/koji")
        volumes = compose["volumes"]
        assert "koji-test-hf-cache" in volumes
        assert "koji-test-torch-cache" in volumes

    def test_ollama_volume_unchanged(self):
        config = KojiConfig(project="test")
        compose = generate_compose(config, "/tmp/koji")
        volumes = compose["volumes"]
        assert "koji-test-ollama-data" in volumes
        ollama_volumes = compose["services"]["ollama"]["volumes"]
        assert "koji-test-ollama-data:/root/.ollama" in ollama_volumes

    def test_cache_volumes_use_project_name(self):
        config = KojiConfig(project="myapp")
        compose = generate_compose(config, "/tmp/koji")
        parse_volumes = compose["services"]["koji-parse"]["volumes"]
        assert "koji-myapp-hf-cache:/root/.cache/huggingface" in parse_volumes
        assert "koji-myapp-torch-cache:/root/.cache/torch" in parse_volumes
        assert "koji-myapp-hf-cache" in compose["volumes"]
        assert "koji-myapp-torch-cache" in compose["volumes"]


# ── Services config tests ─────────────────────────────────────────────

PROJECT_DIR = "/tmp/koji"


def _make_config(**services_kwargs) -> KojiConfig:
    """Build a KojiConfig with the given services overrides."""
    return KojiConfig(
        project="test",
        services=ServicesConfig(**services_kwargs),
    )


class TestServicesDefaults:
    """Default config includes all services."""

    def test_includes_all_services(self):
        compose = generate_compose(_make_config(), PROJECT_DIR)
        svc = compose["services"]
        assert "koji-server" in svc
        assert "koji-ui" in svc
        assert "koji-parse" in svc
        assert "koji-extract" in svc
        assert "ollama" in svc

    def test_extract_depends_on_ollama(self):
        compose = generate_compose(_make_config(), PROJECT_DIR)
        extract = compose["services"]["koji-extract"]
        assert "depends_on" in extract
        assert "ollama" in extract["depends_on"]

    def test_extract_has_ollama_url(self):
        compose = generate_compose(_make_config(), PROJECT_DIR)
        env = compose["services"]["koji-extract"]["environment"]
        assert "KOJI_OLLAMA_URL" in env


class TestOllamaDisabled:
    """services.ollama: false excludes ollama and its dependency."""

    def test_no_ollama_service(self):
        compose = generate_compose(_make_config(ollama=False), PROJECT_DIR)
        assert "ollama" not in compose["services"]

    def test_extract_no_ollama_dependency(self):
        compose = generate_compose(_make_config(ollama=False), PROJECT_DIR)
        extract = compose["services"]["koji-extract"]
        assert "depends_on" not in extract

    def test_extract_no_ollama_url(self):
        compose = generate_compose(_make_config(ollama=False), PROJECT_DIR)
        env = compose["services"]["koji-extract"]["environment"]
        assert "KOJI_OLLAMA_URL" not in env

    def test_no_ollama_volume(self):
        compose = generate_compose(_make_config(ollama=False), PROJECT_DIR)
        assert "koji-test-ollama-data" not in compose["volumes"]

    def test_extract_still_present(self):
        compose = generate_compose(_make_config(ollama=False), PROJECT_DIR)
        assert "koji-extract" in compose["services"]

    def test_parse_still_present(self):
        compose = generate_compose(_make_config(ollama=False), PROJECT_DIR)
        assert "koji-parse" in compose["services"]


class TestParseDisabled:
    """services.parse: false excludes the parse service."""

    def test_no_parse_service(self):
        compose = generate_compose(_make_config(parse=False), PROJECT_DIR)
        assert "koji-parse" not in compose["services"]

    def test_no_parse_volumes(self):
        compose = generate_compose(_make_config(parse=False), PROJECT_DIR)
        volumes = compose["volumes"]
        assert "koji-test-hf-cache" not in volumes
        assert "koji-test-torch-cache" not in volumes

    def test_ollama_still_present(self):
        compose = generate_compose(_make_config(parse=False), PROJECT_DIR)
        assert "ollama" in compose["services"]

    def test_extract_still_present(self):
        compose = generate_compose(_make_config(parse=False), PROJECT_DIR)
        assert "koji-extract" in compose["services"]


class TestBothDisabled:
    """Both parse and ollama disabled — only core services remain."""

    def test_only_core_services(self):
        compose = generate_compose(_make_config(parse=False, ollama=False), PROJECT_DIR)
        svc = compose["services"]
        assert "koji-server" in svc
        assert "koji-ui" in svc
        assert "koji-extract" in svc
        assert "koji-parse" not in svc
        assert "ollama" not in svc

    def test_no_optional_volumes(self):
        compose = generate_compose(_make_config(parse=False, ollama=False), PROJECT_DIR)
        assert compose["volumes"] == {}
