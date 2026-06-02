"""Shared fixtures for the Koji test suite.

After the Python extract service was removed (oss-152), this file
only contains config-test fixtures. The rest of the conftest content
(MockProvider, Chunk, ModelProvider, FieldRoute) was specific to the
deleted services/extract codebase.
"""

from __future__ import annotations

import pytest
import yaml

# ----------------------------------------------------------------------
# koji.yaml config fixtures — used by tests/test_config.py
# ----------------------------------------------------------------------

SAMPLE_CONFIG_DICT = {
    "project": "test-project",
    "cluster": {
        "name": "test",
        "base_port": 9500,
    },
    "pipeline": [
        {"step": "parse", "engine": "docling"},
        {"step": "extract", "model": "openai/gpt-4o-mini"},
    ],
    "output": {
        "structured": "./test-output/",
    },
}


@pytest.fixture
def sample_config_dict():
    """A sample koji.yaml config as a dict."""
    return SAMPLE_CONFIG_DICT


@pytest.fixture
def sample_config_yaml(tmp_path):
    """Write a sample koji.yaml to a temp dir and return the path."""
    config_path = tmp_path / "koji.yaml"
    config_path.write_text(yaml.dump(SAMPLE_CONFIG_DICT))
    return config_path
