"""Koji configuration models and loader."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field


class ClusterConfig(BaseModel):
    name: str = "default"
    base_port: int = Field(default=9400, description="Base port for the cluster")

    @property
    def ui_port(self) -> int:
        return self.base_port

    @property
    def server_port(self) -> int:
        return self.base_port + 1

    @property
    def ollama_port(self) -> int:
        return self.base_port + 10

    @property
    def parse_port(self) -> int:
        return self.base_port + 11

    @property
    def extract_port(self) -> int:
        return self.base_port + 12


class PipelineStep(BaseModel):
    step: str
    engine: str | None = None
    model: str | None = None
    schemas: list[str] | None = None
    ocr: str | None = None
    strategy: str | None = None
    categories: list[str] | None = None
    max_tokens: int | None = None


class ModelProviderConfig(BaseModel):
    backend: str | None = None
    api_key: str | None = None
    endpoint: str | None = None
    format: str | None = None


class ModelsConfig(BaseModel):
    providers: dict[str, ModelProviderConfig] = Field(default_factory=dict)


class OutputConfig(BaseModel):
    structured: str = "./output/"
    vectors: str | None = None
    raw_markdown: str | None = None


class KojiConfig(BaseModel):
    project: str = "koji"
    cluster: ClusterConfig = Field(default_factory=ClusterConfig)
    pipeline: list[PipelineStep] = Field(default_factory=list)
    models: ModelsConfig = Field(default_factory=ModelsConfig)
    output: OutputConfig = Field(default_factory=OutputConfig)


def load_config(path: str | Path = "koji.yaml") -> KojiConfig:
    """Load and validate a koji.yaml config file."""
    config_path = Path(path)
    if not config_path.exists():
        return KojiConfig()

    with open(config_path) as f:
        raw: dict[str, Any] = yaml.safe_load(f) or {}

    return KojiConfig(**raw)
