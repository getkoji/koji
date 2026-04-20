"""Koji configuration models and loader."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field


class ClusterConfig(BaseModel):
    name: str = "default"
    base_port: int = Field(default=9400, description="Base port for the cluster")
    version: str = Field(
        default="latest",
        description="Image tag to pull from ghcr.io/getkoji (e.g. 'latest', 'v0.2.0')",
    )
    dev: bool = Field(
        default=False,
        description="Build images from local source instead of pulling from ghcr.io/getkoji",
    )

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
    def mailpit_ui_port(self) -> int:
        return self.base_port + 13

    @property
    def mailpit_smtp_port(self) -> int:
        return self.base_port + 14

    @property
    def extract_port(self) -> int:
        return self.base_port + 12

    @property
    def minio_port(self) -> int:
        return self.base_port + 15

    @property
    def minio_console_port(self) -> int:
        return self.base_port + 16


class ClassifyTypeConfig(BaseModel):
    """A document type the classifier can emit for a section."""

    id: str
    description: str = ""


class PipelineStep(BaseModel):
    step: str
    engine: str | None = None
    model: str | None = None
    schemas: list[str] | None = None
    ocr: str | None = None
    strategy: str | None = None
    categories: list[str] | None = None
    max_tokens: int | None = None
    # classify-step fields (ignored for other step types)
    types: list[ClassifyTypeConfig] | None = None
    require_apply_to: bool | None = None
    short_doc_chunks: int | None = None
    coalesce_other_threshold: float | None = None


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


class StorageConfig(BaseModel):
    """Object storage configuration. Defaults to MinIO in the local cluster."""

    provider: str = "s3"  # only 's3' for now (covers MinIO, AWS, R2)
    endpoint: str | None = None  # auto-set to MinIO container in cluster mode
    bucket: str = "koji"
    access_key: str = "koji"
    secret_key: str = "kojisecret"
    region: str = "us-east-1"
    force_path_style: bool = True  # required for MinIO, not for AWS/R2


class ServicesConfig(BaseModel):
    dashboard: bool = True
    parse: bool = True
    ollama: bool = True


class WebhookConfig(BaseModel):
    url: str
    events: list[str] = ["job.completed", "job.failed"]
    secret: str | None = None  # for HMAC signing


class KojiConfig(BaseModel):
    project: str = "koji"
    cluster: ClusterConfig = Field(default_factory=ClusterConfig)
    storage: StorageConfig = Field(default_factory=StorageConfig)
    services: ServicesConfig = Field(default_factory=ServicesConfig)
    pipeline: list[PipelineStep] = Field(default_factory=list)
    models: ModelsConfig = Field(default_factory=ModelsConfig)
    output: OutputConfig = Field(default_factory=OutputConfig)
    webhooks: list[WebhookConfig] = Field(default_factory=list)

    def classify_step(self) -> PipelineStep | None:
        """Return the classify pipeline step if present, else None.

        Presence of a `step: classify` entry in the pipeline list is the
        only way to turn the classifier on — there's no separate enable
        flag. When this returns None, the extraction pipeline falls back
        to its pre-classifier single-pass behavior.
        """
        for step in self.pipeline:
            if step.step == "classify":
                return step
        return None


def load_config(path: str | Path = "koji.yaml") -> KojiConfig:
    """Load and validate a koji.yaml config file."""
    config_path = Path(path)
    if not config_path.exists():
        return KojiConfig()

    with open(config_path) as f:
        raw: dict[str, Any] = yaml.safe_load(f) or {}

    return KojiConfig(**raw)
