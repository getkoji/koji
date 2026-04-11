"""Schema CRUD API endpoints."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml
from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field, field_validator

router = APIRouter(prefix="/api/schemas", tags=["schemas"])


def get_schemas_dir() -> Path:
    """Return the schemas directory path, creating it if needed."""
    schemas_dir = Path(os.environ.get("KOJI_SCHEMAS_DIR", "./schemas/"))
    schemas_dir.mkdir(parents=True, exist_ok=True)
    return schemas_dir


# --- Pydantic models ---


class SchemaField(BaseModel):
    type: str
    required: bool | None = None
    description: str | None = None
    hints: dict[str, Any] | None = None
    items: dict[str, Any] | None = None
    options: list[str] | None = None
    default: Any | None = None
    properties: dict[str, Any] | None = None


class SchemaCreate(BaseModel):
    name: str
    description: str | None = None
    categories: dict[str, Any] | None = None
    fields: dict[str, Any] = Field(..., min_length=1)

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("name must not be empty")
        # Sanitize: only allow alphanumeric, hyphens, underscores
        sanitized = v.strip().lower().replace(" ", "_")
        if not all(c.isalnum() or c in "-_" for c in sanitized):
            raise ValueError("name must contain only alphanumeric characters, hyphens, or underscores")
        return sanitized


class SchemaUpdate(BaseModel):
    description: str | None = None
    categories: dict[str, Any] | None = None
    fields: dict[str, Any] | None = None

    @field_validator("fields")
    @classmethod
    def validate_fields(cls, v: dict[str, Any] | None) -> dict[str, Any] | None:
        if v is not None and len(v) == 0:
            raise ValueError("fields must not be empty")
        return v


class RawYAMLBody(BaseModel):
    content: str


class SchemaSummary(BaseModel):
    name: str
    description: str | None = None
    field_count: int


class SchemaDetail(BaseModel):
    name: str
    description: str | None = None
    categories: dict[str, Any] | None = None
    fields: dict[str, Any]


# --- Helper functions ---


def _schema_path(name: str) -> Path:
    return get_schemas_dir() / f"{name}.yaml"


def _load_schema(path: Path) -> dict[str, Any]:
    with open(path) as f:
        return yaml.safe_load(f) or {}


def _save_schema(path: Path, data: dict[str, Any]) -> None:
    with open(path, "w") as f:
        yaml.dump(data, f, default_flow_style=False, sort_keys=False, allow_unicode=True)


# --- Endpoints ---


@router.get("", response_model=list[SchemaSummary])
def list_schemas():
    """List all schemas with summary info."""
    schemas_dir = get_schemas_dir()
    results: list[SchemaSummary] = []
    for path in sorted(schemas_dir.glob("*.yaml")):
        try:
            data = _load_schema(path)
            if "name" not in data or "fields" not in data:
                continue
            results.append(
                SchemaSummary(
                    name=data["name"],
                    description=data.get("description"),
                    field_count=len(data.get("fields", {})),
                )
            )
        except Exception:
            continue
    return results


@router.get("/{name}", response_model=SchemaDetail)
def get_schema(name: str):
    """Get a full schema definition."""
    path = _schema_path(name)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Schema '{name}' not found")
    data = _load_schema(path)
    return SchemaDetail(
        name=data["name"],
        description=data.get("description"),
        categories=data.get("categories"),
        fields=data["fields"],
    )


@router.post("", response_model=SchemaDetail, status_code=201)
def create_schema(body: SchemaCreate):
    """Create a new schema."""
    path = _schema_path(body.name)
    if path.exists():
        raise HTTPException(status_code=409, detail=f"Schema '{body.name}' already exists")

    data: dict[str, Any] = {"name": body.name}
    if body.description:
        data["description"] = body.description
    if body.categories:
        data["categories"] = body.categories
    data["fields"] = body.fields

    _save_schema(path, data)
    return SchemaDetail(
        name=body.name,
        description=body.description,
        categories=body.categories,
        fields=body.fields,
    )


@router.put("/{name}", response_model=SchemaDetail)
def update_schema(name: str, body: SchemaUpdate):
    """Update an existing schema."""
    path = _schema_path(name)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Schema '{name}' not found")

    data = _load_schema(path)
    if body.description is not None:
        data["description"] = body.description
    if body.categories is not None:
        data["categories"] = body.categories
    if body.fields is not None:
        data["fields"] = body.fields

    _save_schema(path, data)
    return SchemaDetail(
        name=data["name"],
        description=data.get("description"),
        categories=data.get("categories"),
        fields=data["fields"],
    )


@router.delete("/{name}", status_code=204)
def delete_schema(name: str):
    """Delete a schema."""
    path = _schema_path(name)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Schema '{name}' not found")
    path.unlink()


# --- Raw YAML endpoints (used by the dashboard schema editor) ---


@router.get("/{name}/raw", response_class=PlainTextResponse)
def get_schema_raw(name: str):
    """Get a schema as raw YAML text."""
    path = _schema_path(name)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Schema '{name}' not found")
    return path.read_text()


@router.put("/{name}/raw", response_class=PlainTextResponse)
def update_schema_raw(name: str, body: RawYAMLBody):
    """Update a schema from raw YAML text."""
    path = _schema_path(name)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Schema '{name}' not found")
    try:
        data = yaml.safe_load(body.content)
    except yaml.YAMLError as e:
        raise HTTPException(status_code=422, detail=f"Invalid YAML: {e}")
    if not isinstance(data, dict):
        raise HTTPException(status_code=422, detail="YAML must be a mapping")
    if "name" not in data or "fields" not in data:
        raise HTTPException(status_code=422, detail="Schema must have 'name' and 'fields' keys")
    if not isinstance(data["fields"], dict) or len(data["fields"]) == 0:
        raise HTTPException(status_code=422, detail="'fields' must be a non-empty mapping")
    # Ensure the name in the YAML matches the URL
    data["name"] = name
    _save_schema(path, data)
    return path.read_text()


@router.post("/raw", response_class=PlainTextResponse, status_code=201)
def create_schema_raw(body: RawYAMLBody):
    """Create a schema from raw YAML text."""
    try:
        data = yaml.safe_load(body.content)
    except yaml.YAMLError as e:
        raise HTTPException(status_code=422, detail=f"Invalid YAML: {e}")
    if not isinstance(data, dict):
        raise HTTPException(status_code=422, detail="YAML must be a mapping")
    if "name" not in data or "fields" not in data:
        raise HTTPException(status_code=422, detail="Schema must have 'name' and 'fields' keys")
    if not isinstance(data["fields"], dict) or len(data["fields"]) == 0:
        raise HTTPException(status_code=422, detail="'fields' must be a non-empty mapping")

    # Sanitize name
    raw_name = data["name"].strip().lower().replace(" ", "_")
    if not all(c.isalnum() or c in "-_" for c in raw_name):
        raise HTTPException(
            status_code=422,
            detail="name must contain only alphanumeric characters, hyphens, or underscores",
        )
    data["name"] = raw_name

    path = _schema_path(raw_name)
    if path.exists():
        raise HTTPException(status_code=409, detail=f"Schema '{raw_name}' already exists")
    _save_schema(path, data)
    return path.read_text()
