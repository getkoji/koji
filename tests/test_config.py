"""Tests for server/config.py — configuration models and loading."""

from __future__ import annotations

import yaml

from cli.config import (
    ClusterConfig,
    KojiConfig,
    PipelineStep,
    load_config,
)
from tests.conftest import SAMPLE_CONFIG_DICT

# ── KojiConfig defaults ──────────────────────────────────────────────


class TestKojiConfigDefaults:
    def test_default_project(self):
        config = KojiConfig()
        assert config.project == "koji"

    def test_default_cluster(self):
        config = KojiConfig()
        assert config.cluster.name == "default"
        assert config.cluster.base_port == 9400

    def test_default_pipeline_empty(self):
        config = KojiConfig()
        assert config.pipeline == []

    def test_default_output(self):
        config = KojiConfig()
        assert config.output.structured == "./output/"
        assert config.output.vectors is None

    def test_default_models(self):
        config = KojiConfig()
        assert config.models.providers == {}


# ── ClusterConfig port calculations ──────────────────────────────────


class TestClusterConfig:
    def test_default_ports(self):
        c = ClusterConfig()
        assert c.ui_port == 9400
        assert c.server_port == 9401
        assert c.ollama_port == 9410
        assert c.parse_port == 9411
        assert c.extract_port == 9412

    def test_custom_base_port(self):
        c = ClusterConfig(base_port=9500)
        assert c.ui_port == 9500
        assert c.server_port == 9501
        assert c.ollama_port == 9510
        assert c.parse_port == 9511
        assert c.extract_port == 9512

    def test_port_offsets(self):
        c = ClusterConfig(base_port=8000)
        assert c.ui_port == c.base_port + 0
        assert c.server_port == c.base_port + 1
        assert c.ollama_port == c.base_port + 10
        assert c.parse_port == c.base_port + 11
        assert c.extract_port == c.base_port + 12

    def test_custom_name(self):
        c = ClusterConfig(name="production")
        assert c.name == "production"


# ── load_config from YAML ────────────────────────────────────────────


class TestLoadConfig:
    def test_load_from_yaml(self, tmp_path):
        config_path = tmp_path / "koji.yaml"
        config_path.write_text(yaml.dump(SAMPLE_CONFIG_DICT))

        config = load_config(config_path)
        assert config.project == "test-project"
        assert config.cluster.name == "test"
        assert config.cluster.base_port == 9500

    def test_load_pipeline_steps(self, tmp_path):
        config_path = tmp_path / "koji.yaml"
        config_path.write_text(yaml.dump(SAMPLE_CONFIG_DICT))

        config = load_config(config_path)
        assert len(config.pipeline) == 2
        assert config.pipeline[0].step == "parse"
        assert config.pipeline[0].engine == "docling"
        assert config.pipeline[1].step == "extract"
        assert config.pipeline[1].model == "openai/gpt-4o-mini"

    def test_load_output_config(self, tmp_path):
        config_path = tmp_path / "koji.yaml"
        config_path.write_text(yaml.dump(SAMPLE_CONFIG_DICT))

        config = load_config(config_path)
        assert config.output.structured == "./test-output/"

    def test_missing_file_returns_defaults(self, tmp_path):
        config = load_config(tmp_path / "nonexistent.yaml")
        assert config.project == "koji"
        assert config.cluster.base_port == 9400

    def test_empty_yaml_returns_defaults(self, tmp_path):
        config_path = tmp_path / "koji.yaml"
        config_path.write_text("")

        config = load_config(config_path)
        assert config.project == "koji"

    def test_partial_config(self, tmp_path):
        config_path = tmp_path / "koji.yaml"
        config_path.write_text(yaml.dump({"project": "custom-name"}))

        config = load_config(config_path)
        assert config.project == "custom-name"
        assert config.cluster.base_port == 9400  # default

    def test_load_with_path_string(self, tmp_path):
        config_path = tmp_path / "koji.yaml"
        config_path.write_text(yaml.dump(SAMPLE_CONFIG_DICT))

        config = load_config(str(config_path))
        assert config.project == "test-project"


# ── PipelineStep ──────────────────────────────────────────────────────


class TestPipelineStep:
    def test_minimal_step(self):
        step = PipelineStep(step="parse")
        assert step.step == "parse"
        assert step.engine is None
        assert step.model is None

    def test_full_step(self):
        step = PipelineStep(step="extract", model="openai/gpt-4o-mini", max_tokens=8192)
        assert step.step == "extract"
        assert step.model == "openai/gpt-4o-mini"
        assert step.max_tokens == 8192
