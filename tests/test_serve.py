"""Tests for koji serve HTTP endpoints."""

from fastapi.testclient import TestClient

from cli.serve import app

client = TestClient(app)


def test_health():
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert "version" in data


def test_compile_valid_schema():
    resp = client.post("/schemas/compile", json={
        "content": "name: invoice\nfields:\n  total:\n    type: number\n    required: true\n"
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["valid"] is True
    assert data["field_count"] == 1
    assert data["fields"][0]["name"] == "total"
    assert data["fields"][0]["type"] == "number"


def test_compile_invalid_yaml():
    resp = client.post("/schemas/compile", json={
        "content": "not: valid: yaml: {{{"
    })
    assert resp.status_code == 422
    assert "error" in resp.json()


def test_compile_non_mapping():
    resp = client.post("/schemas/compile", json={
        "content": "- just\n- a\n- list\n"
    })
    assert resp.status_code == 422
    assert "error" in resp.json()
