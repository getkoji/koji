"""Shared fixtures for the Koji test suite."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import yaml

from services.extract.document_map import Chunk
from services.extract.providers import ModelProvider
from services.extract.router import FieldRoute

# ── Paths ──────────────────────────────────────────────────────────────

FIXTURES_DIR = Path(__file__).parent / "fixtures"


# ── Mock Provider ──────────────────────────────────────────────────────


class MockProvider(ModelProvider):
    """A model provider that returns canned responses for testing.

    Usage:
        provider = MockProvider(responses=[
            '{"policy_number": "BOP123456"}',
            '{"insured_name": "Acme Corp"}',
        ])

    Each call to generate() pops the next response. If responses are
    exhausted, returns an empty JSON object.
    """

    def __init__(self, responses: list[str] | None = None):
        self.responses: list[str] = responses or ["{}"]
        self.calls: list[dict[str, Any]] = []
        self._call_index = 0

    async def generate(self, prompt: str, json_mode: bool = True) -> str:
        self.calls.append({"method": "generate", "prompt": prompt, "json_mode": json_mode})
        if self._call_index < len(self.responses):
            resp = self.responses[self._call_index]
            self._call_index += 1
            return resp
        return "{}"

    async def chat(self, messages: list[dict], tools: list[dict] | None = None) -> dict:
        self.calls.append({"method": "chat", "messages": messages, "tools": tools})
        if self._call_index < len(self.responses):
            resp = self.responses[self._call_index]
            self._call_index += 1
            return {"content": resp}
        return {"content": "{}"}

    def reset(self) -> None:
        self.calls.clear()
        self._call_index = 0


@pytest.fixture
def mock_provider():
    """A fresh MockProvider with a default empty response."""
    return MockProvider()


# ── Chunk / FieldRoute Factories ───────────────────────────────────────


def make_chunk(
    index: int = 0,
    title: str = "Test Section",
    content: str = "Some content",
    category: str = "other",
    signals: dict | None = None,
) -> Chunk:
    return Chunk(
        index=index,
        title=title,
        content=content,
        category=category,
        signals=signals or {},
    )


def make_field_route(
    field_name: str = "test_field",
    field_spec: dict | None = None,
    chunks: list[Chunk] | None = None,
    source: str = "hint",
) -> FieldRoute:
    return FieldRoute(
        field_name=field_name,
        field_spec=field_spec or {"type": "string"},
        chunks=chunks or [make_chunk()],
        source=source,
    )


@pytest.fixture
def chunk_factory():
    """Factory fixture for creating Chunk objects."""
    return make_chunk


@pytest.fixture
def field_route_factory():
    """Factory fixture for creating FieldRoute objects."""
    return make_field_route


# ── Markdown Fixtures ──────────────────────────────────────────────────


SAMPLE_INSURANCE_MARKDOWN = """\
# Declarations Page

Named Insured: Acme Widget Corporation
Policy Number: BOP7284930
Policy Period: 01/15/2025 to 01/15/2026
Carrier: National Insurance Company
Agent: John Smith
Agency: Smith & Associates Insurance

Total Premium: $4,250.00
Policy Type: Business Owners Policy

# Schedule of Coverages

| Coverage | Limit | Deductible |
|---|---|---|
| Building | $500,000 | $1,000 |
| Business Personal Property | $250,000 | $1,000 |
| Business Income | $100,000 | 72 hours |
| General Liability | $1,000,000 per occurrence | N/A |

# General Conditions

This policy is subject to the following conditions:

1. Duties After Loss: You must notify us promptly of any loss.
2. Examination Under Oath: We may examine you under oath.
3. Valuation: We will determine the value of covered property.

# Definitions

As used in this policy:

"Bodily injury" means physical injury, sickness, or disease.
"Property damage" means physical injury to tangible property.
"Occurrence" means an accident, including continuous or repeated exposure.

# Exclusions

This insurance does not apply to:

1. Expected or intended injury
2. Contractual liability
3. Liquor liability
4. Workers compensation
5. Pollution

# Business Liability Endorsement

This endorsement modifies insurance provided under the Business Owners Coverage Form.

Amendment of Insured Contract Definition:
The definition of "insured contract" is replaced by the following...
"""


@pytest.fixture
def sample_markdown():
    """A representative insurance policy markdown document."""
    return SAMPLE_INSURANCE_MARKDOWN


SAMPLE_SCHEMA = {
    "name": "insurance_policy",
    "description": "Commercial insurance policy extraction",
    "categories": {
        "keywords": {
            "declarations": ["declaration", "dec page", "named insured", "policy period"],
            "schedule_of_coverages": ["schedule of", "coverage schedule", "limits of"],
            "endorsement": ["endorsement", "amendment", "rider"],
            "conditions": ["conditions", "general conditions"],
            "definitions": ["definitions", "defined terms"],
            "exclusions": ["exclusion", "does not apply"],
        },
    },
    "signals": {
        "has_policy_numbers": {"pattern": r"[A-Z]{2,5}\d{5,}"},
        "has_name_references": {
            "pattern": r"(?:named insured|insured|policyholder|name)\s*:?\s*(.+)",
            "flags": "i",
        },
    },
    "fields": {
        "policy_number": {
            "type": "string",
            "required": True,
            "description": "Policy number or ID",
            "hints": {
                "look_in": ["declarations"],
                "patterns": ["policy.*(?:number|no|#)"],
                "signals": ["has_policy_numbers", "has_key_value_pairs"],
            },
        },
        "insured_name": {
            "type": "string",
            "required": True,
            "description": "Named insured (policyholder)",
            "hints": {
                "look_in": ["declarations"],
                "patterns": ["(?:named\\s+)?insured"],
                "signals": ["has_name_references"],
            },
        },
        "effective_date": {
            "type": "date",
            "required": True,
            "description": "Policy effective date",
            "hints": {
                "look_in": ["declarations"],
                "patterns": ["effective.*date", "policy\\s+period"],
                "signals": ["has_dates"],
            },
        },
        "expiration_date": {
            "type": "date",
            "required": True,
            "description": "Policy expiration date",
            "hints": {
                "look_in": ["declarations"],
                "patterns": ["expir", "policy\\s+period"],
                "signals": ["has_dates"],
            },
        },
        "premium": {
            "type": "number",
            "description": "Total premium amount",
            "hints": {
                "look_in": ["declarations"],
                "patterns": ["(?:total\\s+)?premium"],
                "signals": ["has_dollar_amounts"],
            },
        },
        "policy_type": {
            "type": "enum",
            "description": "Type of policy",
            "options": [
                "BOP",
                "General Liability",
                "Workers Compensation",
                "Commercial Property",
            ],
            "hints": {
                "look_in": ["declarations"],
            },
        },
        "coverages": {
            "type": "array",
            "description": "List of coverages with limits",
            "items": {
                "type": "object",
                "properties": {
                    "coverage_name": {"type": "string"},
                    "limit": {"type": "string"},
                    "deductible": {"type": "string"},
                },
            },
            "hints": {
                "look_in": ["schedule_of_coverages", "declarations"],
                "signals": ["has_tables", "has_dollar_amounts"],
            },
        },
    },
}


@pytest.fixture
def sample_schema():
    """A representative insurance policy extraction schema."""
    return SAMPLE_SCHEMA


MINIMAL_SCHEMA = {
    "name": "simple",
    "fields": {
        "title": {"type": "string", "required": True},
        "amount": {"type": "number"},
    },
}


@pytest.fixture
def minimal_schema():
    """A minimal schema for quick tests."""
    return MINIMAL_SCHEMA


# ── Config Fixtures ────────────────────────────────────────────────────


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
