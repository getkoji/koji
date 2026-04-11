"""Tests for schema CRUD operations (file-based)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
import yaml

from server.schemas import (
    SchemaCreate,
    SchemaUpdate,
    _load_schema,
    _save_schema,
    create_schema,
    delete_schema,
    get_schema,
    get_schemas_dir,
    list_schemas,
    update_schema,
)


@pytest.fixture()
def schemas_dir(tmp_path: Path):
    """Patch KOJI_SCHEMAS_DIR to use a temporary directory."""
    with patch.dict("os.environ", {"KOJI_SCHEMAS_DIR": str(tmp_path)}):
        yield tmp_path


@pytest.fixture()
def sample_schema_data() -> dict:
    return {
        "name": "invoice",
        "description": "Standard invoice extraction",
        "fields": {
            "invoice_number": {"type": "string", "required": True},
            "total_amount": {"type": "number", "required": True},
        },
    }


def _write_schema(schemas_dir: Path, data: dict) -> Path:
    """Helper to write a schema YAML file."""
    path = schemas_dir / f"{data['name']}.yaml"
    with open(path, "w") as f:
        yaml.dump(data, f, default_flow_style=False, sort_keys=False)
    return path


class TestGetSchemasDir:
    def test_default_dir(self, tmp_path: Path):
        with patch.dict("os.environ", {"KOJI_SCHEMAS_DIR": str(tmp_path / "sub")}):
            result = get_schemas_dir()
            assert result == tmp_path / "sub"
            assert result.exists()

    def test_creates_dir_if_missing(self, tmp_path: Path):
        new_dir = tmp_path / "new" / "nested"
        with patch.dict("os.environ", {"KOJI_SCHEMAS_DIR": str(new_dir)}):
            result = get_schemas_dir()
            assert result.exists()


class TestListSchemas:
    def test_empty_dir(self, schemas_dir: Path):
        result = list_schemas()
        assert result == []

    def test_lists_valid_schemas(self, schemas_dir: Path, sample_schema_data: dict):
        _write_schema(schemas_dir, sample_schema_data)
        _write_schema(
            schemas_dir,
            {"name": "receipt", "fields": {"vendor": {"type": "string"}}},
        )

        result = list_schemas()
        assert len(result) == 2
        names = {s.name for s in result}
        assert names == {"invoice", "receipt"}

    def test_skips_invalid_files(self, schemas_dir: Path):
        # File without 'name' field
        (schemas_dir / "bad.yaml").write_text("foo: bar\n")
        # File without 'fields'
        (schemas_dir / "no_fields.yaml").write_text("name: test\n")

        result = list_schemas()
        assert result == []

    def test_field_count(self, schemas_dir: Path, sample_schema_data: dict):
        _write_schema(schemas_dir, sample_schema_data)
        result = list_schemas()
        assert result[0].field_count == 2


class TestGetSchema:
    def test_found(self, schemas_dir: Path, sample_schema_data: dict):
        _write_schema(schemas_dir, sample_schema_data)
        result = get_schema("invoice")
        assert result.name == "invoice"
        assert result.description == "Standard invoice extraction"
        assert "invoice_number" in result.fields

    def test_not_found(self, schemas_dir: Path):
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc_info:
            get_schema("nonexistent")
        assert exc_info.value.status_code == 404


class TestCreateSchema:
    def test_create_new(self, schemas_dir: Path):
        body = SchemaCreate(
            name="receipt",
            description="Receipt extraction",
            fields={"vendor": {"type": "string"}, "total": {"type": "number"}},
        )
        result = create_schema(body)
        assert result.name == "receipt"
        assert result.description == "Receipt extraction"
        assert len(result.fields) == 2

        # Verify file was written
        path = schemas_dir / "receipt.yaml"
        assert path.exists()
        data = yaml.safe_load(path.read_text())
        assert data["name"] == "receipt"
        assert "vendor" in data["fields"]

    def test_conflict(self, schemas_dir: Path, sample_schema_data: dict):
        _write_schema(schemas_dir, sample_schema_data)
        from fastapi import HTTPException

        body = SchemaCreate(
            name="invoice",
            fields={"x": {"type": "string"}},
        )
        with pytest.raises(HTTPException) as exc_info:
            create_schema(body)
        assert exc_info.value.status_code == 409

    def test_name_sanitization(self, schemas_dir: Path):
        body = SchemaCreate(
            name="My Schema",
            fields={"x": {"type": "string"}},
        )
        result = create_schema(body)
        assert result.name == "my_schema"
        assert (schemas_dir / "my_schema.yaml").exists()


class TestUpdateSchema:
    def test_update_fields(self, schemas_dir: Path, sample_schema_data: dict):
        _write_schema(schemas_dir, sample_schema_data)
        body = SchemaUpdate(fields={"new_field": {"type": "string"}})
        result = update_schema("invoice", body)
        assert "new_field" in result.fields
        assert "invoice_number" not in result.fields

    def test_update_description(self, schemas_dir: Path, sample_schema_data: dict):
        _write_schema(schemas_dir, sample_schema_data)
        body = SchemaUpdate(description="Updated description")
        result = update_schema("invoice", body)
        assert result.description == "Updated description"
        # Fields unchanged
        assert "invoice_number" in result.fields

    def test_not_found(self, schemas_dir: Path):
        from fastapi import HTTPException

        body = SchemaUpdate(description="x")
        with pytest.raises(HTTPException) as exc_info:
            update_schema("nonexistent", body)
        assert exc_info.value.status_code == 404


class TestDeleteSchema:
    def test_delete_existing(self, schemas_dir: Path, sample_schema_data: dict):
        _write_schema(schemas_dir, sample_schema_data)
        path = schemas_dir / "invoice.yaml"
        assert path.exists()
        delete_schema("invoice")
        assert not path.exists()

    def test_delete_not_found(self, schemas_dir: Path):
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc_info:
            delete_schema("nonexistent")
        assert exc_info.value.status_code == 404


class TestLoadAndSave:
    def test_roundtrip(self, tmp_path: Path):
        path = tmp_path / "test.yaml"
        data = {"name": "test", "fields": {"x": {"type": "string"}}}
        _save_schema(path, data)
        loaded = _load_schema(path)
        assert loaded == data
