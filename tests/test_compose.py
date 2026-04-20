"""Tests for cli/compose.py — docker-compose generation."""

from __future__ import annotations

from cli.compose import generate_compose
from cli.config import KojiConfig, ServicesConfig


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
        assert "koji-api" in svc
        assert "koji-dashboard" in svc
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
        assert "koji-api" in svc
        assert "koji-dashboard" in svc
        assert "koji-extract" in svc
        assert "koji-parse" not in svc
        assert "ollama" not in svc

    def test_no_optional_volumes(self):
        compose = generate_compose(_make_config(parse=False, ollama=False), PROJECT_DIR)
        volumes = compose["volumes"]
        assert "koji-test-hf-cache" not in volumes
        assert "koji-test-torch-cache" not in volumes
        assert "koji-test-ollama-data" not in volumes


# ── Pull vs build mode tests ─────────────────────────────────────────

from cli.config import ClusterConfig  # noqa: E402


class TestPullModeDefault:
    """Default mode: services reference ghcr.io/getkoji images, no build blocks."""

    def _koji_services(self, compose: dict) -> list[str]:
        return [name for name in compose["services"] if name.startswith("koji-")]

    def test_all_koji_services_use_image_ref(self):
        compose = generate_compose(KojiConfig(project="test"), PROJECT_DIR)
        for name in self._koji_services(compose):
            svc = compose["services"][name]
            assert "image" in svc, f"{name} should have an image ref in pull mode"
            assert "build" not in svc, f"{name} should not have a build block in pull mode"

    def test_server_image_ref(self):
        compose = generate_compose(KojiConfig(project="test"), PROJECT_DIR)
        assert compose["services"]["koji-api"]["image"] == "ghcr.io/getkoji/api:latest"

    def test_dashboard_image_ref(self):
        compose = generate_compose(KojiConfig(project="test"), PROJECT_DIR)
        assert compose["services"]["koji-dashboard"]["image"] == "ghcr.io/getkoji/dashboard:latest"

    def test_parse_image_ref(self):
        compose = generate_compose(KojiConfig(project="test"), PROJECT_DIR)
        assert compose["services"]["koji-parse"]["image"] == "ghcr.io/getkoji/parse:latest"

    def test_extract_image_ref(self):
        compose = generate_compose(KojiConfig(project="test"), PROJECT_DIR)
        assert compose["services"]["koji-extract"]["image"] == "ghcr.io/getkoji/extract:latest"

    def test_ollama_still_uses_upstream_image(self):
        compose = generate_compose(KojiConfig(project="test"), PROJECT_DIR)
        assert compose["services"]["ollama"]["image"] == "ollama/ollama:latest"


class TestVersionTag:
    """The cluster.version field controls the image tag for all Koji services."""

    def test_custom_version_tag_applied_to_all_services(self):
        config = KojiConfig(project="test", cluster=ClusterConfig(version="v0.2.0"))
        compose = generate_compose(config, PROJECT_DIR)
        assert compose["services"]["koji-api"]["image"] == "ghcr.io/getkoji/api:v0.2.0"
        assert compose["services"]["koji-dashboard"]["image"] == "ghcr.io/getkoji/dashboard:v0.2.0"
        assert compose["services"]["koji-parse"]["image"] == "ghcr.io/getkoji/parse:v0.2.0"
        assert compose["services"]["koji-extract"]["image"] == "ghcr.io/getkoji/extract:v0.2.0"

    def test_default_version_is_latest(self):
        config = KojiConfig(project="test")
        assert config.cluster.version == "latest"


class TestDevMode:
    """Dev mode preserves the old build-from-source behavior for contributors."""

    def _koji_services(self, compose: dict) -> list[str]:
        return [name for name in compose["services"] if name.startswith("koji-")]

    def test_dev_arg_produces_build_blocks(self):
        compose = generate_compose(KojiConfig(project="test"), PROJECT_DIR, dev=True)
        # Only Koji-built services have build blocks (not koji-db, koji-minio, koji-mailpit, koji-minio-init)
        buildable = ["koji-api", "koji-dashboard", "koji-parse", "koji-extract"]
        for name in buildable:
            svc = compose["services"][name]
            assert "build" in svc, f"{name} should have a build block in dev mode"
            assert "image" not in svc, f"{name} should not have an image ref in dev mode"

    def test_dev_build_context_and_dockerfile(self):
        compose = generate_compose(KojiConfig(project="test"), PROJECT_DIR, dev=True)
        api_build = compose["services"]["koji-api"]["build"]
        assert api_build["context"] == PROJECT_DIR
        assert api_build["dockerfile"] == "docker/api.Dockerfile"

        parse_build = compose["services"]["koji-parse"]["build"]
        assert parse_build["dockerfile"] == "docker/parse.Dockerfile"

        extract_build = compose["services"]["koji-extract"]["build"]
        assert extract_build["dockerfile"] == "docker/extract.Dockerfile"

        dashboard_build = compose["services"]["koji-dashboard"]["build"]
        assert dashboard_build["dockerfile"] == "docker/dashboard.Dockerfile"

    def test_cluster_dev_flag_also_triggers_build(self):
        config = KojiConfig(project="test", cluster=ClusterConfig(dev=True))
        compose = generate_compose(config, PROJECT_DIR)
        assert "build" in compose["services"]["koji-api"]
        assert "image" not in compose["services"]["koji-api"]

    def test_explicit_dev_false_overrides_cluster_flag(self):
        config = KojiConfig(project="test", cluster=ClusterConfig(dev=True))
        compose = generate_compose(config, PROJECT_DIR, dev=False)
        assert "image" in compose["services"]["koji-api"]
        assert "build" not in compose["services"]["koji-api"]
