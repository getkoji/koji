"""Extraction regression test runner — field-level comparison engine."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class FieldResult:
    """Result of comparing a single field."""

    field_name: str
    passed: bool
    expected: Any = None
    actual: Any = None
    detail: str = ""


@dataclass
class FixtureResult:
    """Result of running one fixture."""

    fixture_name: str
    field_results: list[FieldResult] = field(default_factory=list)
    error: str | None = None

    @property
    def passed(self) -> int:
        return sum(1 for r in self.field_results if r.passed)

    @property
    def failed(self) -> int:
        return sum(1 for r in self.field_results if not r.passed)


@dataclass
class TestSuiteResult:
    """Result of running all fixtures for a schema."""

    schema_name: str
    fixture_results: list[FixtureResult] = field(default_factory=list)

    @property
    def total_fixtures(self) -> int:
        return len(self.fixture_results)

    @property
    def total_fields(self) -> int:
        return sum(len(f.field_results) for f in self.fixture_results)

    @property
    def total_passed(self) -> int:
        return sum(f.passed for f in self.fixture_results)

    @property
    def total_failed(self) -> int:
        return sum(f.failed for f in self.fixture_results)

    @property
    def all_passed(self) -> bool:
        return self.total_failed == 0 and all(f.error is None for f in self.fixture_results)

    def to_dict(self) -> dict:
        """Machine-readable JSON output."""
        return {
            "schema": self.schema_name,
            "fixtures": self.total_fixtures,
            "fields_checked": self.total_fields,
            "passed": self.total_passed,
            "regressions": self.total_failed,
            "results": [
                {
                    "fixture": fr.fixture_name,
                    "error": fr.error,
                    "fields": [
                        {
                            "field": r.field_name,
                            "passed": r.passed,
                            "expected": r.expected,
                            "actual": r.actual,
                            "detail": r.detail,
                        }
                        for r in fr.field_results
                    ],
                }
                for fr in self.fixture_results
            ],
        }


# ── Normalization helpers ─────────────────────────────────────────────


def _normalize_date(value: Any) -> str | None:
    """Try to normalize a value to YYYY-MM-DD. Returns None if not a date."""
    if not isinstance(value, str):
        return None

    s = value.strip()

    # YYYY-MM-DD already
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})$", s)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"

    # MM/DD/YYYY
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", s)
    if m:
        return f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}"

    # DD-MM-YYYY or DD.MM.YYYY  (ambiguous, but try)
    m = re.match(r"^(\d{1,2})[.\-](\d{1,2})[.\-](\d{4})$", s)
    if m:
        return f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}"

    return None


def _to_number(value: Any) -> float | None:
    """Try to coerce a value to a float."""
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.replace("$", "").replace(",", "").strip()
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def _normalize_for_set_compare(items: list) -> list[str]:
    """Produce canonical string keys for order-insensitive comparison."""
    keys = []
    for item in items:
        if isinstance(item, dict):
            keys.append(json.dumps(item, sort_keys=True))
        else:
            keys.append(json.dumps(item))
    return keys


# ── Core comparison ───────────────────────────────────────────────────


def compare_field(field_name: str, expected: Any, actual: Any) -> FieldResult:
    """Compare a single expected value against the actual extraction output."""
    if actual is None:
        return FieldResult(
            field_name=field_name,
            passed=False,
            expected=expected,
            actual=None,
            detail="missing from actual",
        )

    # Date comparison
    exp_date = _normalize_date(expected)
    act_date = _normalize_date(actual)
    if exp_date is not None and act_date is not None:
        ok = exp_date == act_date
        return FieldResult(
            field_name=field_name,
            passed=ok,
            expected=expected,
            actual=actual,
            detail="" if ok else f"expected {exp_date}, got {act_date}",
        )

    # Number comparison (tolerance 0.01)
    exp_num = _to_number(expected)
    act_num = _to_number(actual)
    if exp_num is not None and act_num is not None:
        ok = round(abs(exp_num - act_num), 10) <= 0.01
        return FieldResult(
            field_name=field_name,
            passed=ok,
            expected=expected,
            actual=actual,
            detail="" if ok else f"expected {expected}, got {actual}",
        )

    # Array comparison
    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            return FieldResult(
                field_name=field_name,
                passed=False,
                expected=expected,
                actual=actual,
                detail=f"array length: expected {len(expected)}, got {len(actual)}",
            )
        # Order-insensitive comparison for objects, ordered for primitives
        exp_keys = sorted(_normalize_for_set_compare(expected))
        act_keys = sorted(_normalize_for_set_compare(actual))
        ok = exp_keys == act_keys
        return FieldResult(
            field_name=field_name,
            passed=ok,
            expected=expected,
            actual=actual,
            detail="" if ok else "array items differ",
        )

    # String / fallback: exact match
    ok = str(expected) == str(actual)
    return FieldResult(
        field_name=field_name,
        passed=ok,
        expected=expected,
        actual=actual,
        detail="" if ok else f"expected {expected!r}, got {actual!r}",
    )


def compare_results(expected: dict, actual: dict) -> list[FieldResult]:
    """Compare expected fields against actual extraction output.

    Only fields present in *expected* are checked (partial expectations).
    Fields in actual but not in expected are ignored.
    """
    results = []
    for field_name, exp_value in expected.items():
        act_value = actual.get(field_name)
        results.append(compare_field(field_name, exp_value, act_value))
    return results


# ── Fixture discovery ─────────────────────────────────────────────────


def discover_fixtures(schema_path: Path) -> list[tuple[Path, Path | None]]:
    """Find fixture files for a schema.

    Returns list of (markdown_path, expected_json_path_or_None).
    """
    fixtures_dir = schema_path.parent / (schema_path.stem + ".fixtures")
    if not fixtures_dir.is_dir():
        return []

    pairs: list[tuple[Path, Path | None]] = []
    for md_file in sorted(fixtures_dir.glob("*.md")):
        expected_path = fixtures_dir / (md_file.stem + ".expected.json")
        pairs.append((md_file, expected_path if expected_path.exists() else None))

    return pairs
