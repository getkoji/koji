"""Post-extract validation — schema-declared sanity checks.

Runs after normalization. Turns "extracted JSON" into "extracted JSON plus
a report saying whether it passed the schema author's declared rules."

Rules live in a top-level `validation:` block in the schema, as a list of
single-key dicts. Each key is a rule type; its value is either a list of
field names (for rules that only need field references) or a dict of
parameters:

    validation:
      - required: [invoice_number, total_amount, invoice_date]
      - not_empty: [line_items]
      - enum_in: { field: currency, allowed: [USD, EUR, GBP] }
      - date_order: [issue_date, due_date]
      - sum_equals: { field: total_amount, sum_of: line_items.total, tolerance: 0.01 }
      - regex: { field: invoice_number, pattern: "^INV-\\d+$" }

The result is a `ValidationReport` with an `ok` flag and a list of issues.
Issues are emitted only for failing rules; passing rules contribute nothing
to keep the report compact.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class ValidationIssue:
    rule: str
    field: str | None
    message: str


@dataclass
class ValidationReport:
    ok: bool = True
    issues: list[ValidationIssue] = field(default_factory=list)

    def fail(self, rule: str, field_name: str | None, message: str) -> None:
        self.ok = False
        self.issues.append(ValidationIssue(rule=rule, field=field_name, message=message))

    def to_dict(self) -> dict:
        return {"ok": self.ok, "issues": [asdict(i) for i in self.issues]}


# ── Helpers ─────────────────────────────────────────────────────────


def _is_missing(value: Any) -> bool:
    """A field is 'missing' if null, empty string, or an empty list/dict."""
    if value is None:
        return True
    if isinstance(value, str) and value.strip() == "":
        return True
    if isinstance(value, (list, dict)) and len(value) == 0:
        return True
    return False


def _get_path(data: Any, path: str) -> list[Any]:
    """Walk a dotted path. A path segment traversing a list returns every
    element; the output is always a flat list of matched values.

    Examples:
      _get_path(d, "total_amount")       → [d["total_amount"]]
      _get_path(d, "line_items.total")   → [row["total"] for row in d["line_items"]]
    """
    if not path:
        return [data]

    parts = path.split(".")
    current: list[Any] = [data]
    for part in parts:
        next_values: list[Any] = []
        for node in current:
            if isinstance(node, dict):
                if part in node:
                    next_values.append(node[part])
            elif isinstance(node, list):
                for item in node:
                    if isinstance(item, dict) and part in item:
                        next_values.append(item[part])
        current = next_values
    return current


def _coerce_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = re.sub(r"[^\d.\-]", "", value)
        if cleaned in {"", "-", ".", "-."}:
            return None
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


# ── Rule implementations ────────────────────────────────────────────


def _check_required(params: Any, data: dict, report: ValidationReport) -> None:
    fields = params if isinstance(params, list) else []
    for fname in fields:
        if _is_missing(data.get(fname)):
            report.fail("required", fname, f"required field '{fname}' is missing")


def _check_not_empty(params: Any, data: dict, report: ValidationReport) -> None:
    fields = params if isinstance(params, list) else []
    for fname in fields:
        value = data.get(fname)
        if value is None or (hasattr(value, "__len__") and len(value) == 0):
            report.fail("not_empty", fname, f"field '{fname}' must not be empty")


def _check_enum_in(params: Any, data: dict, report: ValidationReport) -> None:
    if not isinstance(params, dict):
        return
    fname = params.get("field")
    allowed = params.get("allowed") or []
    if not fname or not isinstance(allowed, list):
        return
    value = data.get(fname)
    if value is None:
        return
    if value not in allowed:
        allowed_str = ", ".join(str(a) for a in allowed)
        report.fail("enum_in", fname, f"value {value!r} not in allowed set [{allowed_str}]")


def _check_date_order(params: Any, data: dict, report: ValidationReport) -> None:
    fields = params if isinstance(params, list) else []
    if len(fields) < 2:
        return
    values = []
    for fname in fields:
        v = data.get(fname)
        if not isinstance(v, str) or not v:
            return
        values.append((fname, v))
    for (a_name, a), (b_name, b) in zip(values, values[1:], strict=False):
        if a > b:
            report.fail(
                "date_order",
                b_name,
                f"'{a_name}' ({a}) must not be after '{b_name}' ({b})",
            )
            return


def _check_sum_equals(params: Any, data: dict, report: ValidationReport) -> None:
    if not isinstance(params, dict):
        return
    fname = params.get("field")
    sum_path = params.get("sum_of")
    tolerance = params.get("tolerance", 0.01)
    if not fname or not sum_path:
        return
    expected = _coerce_number(data.get(fname))
    if expected is None:
        return
    parts = _get_path(data, sum_path)
    numeric = [n for n in (_coerce_number(v) for v in parts) if n is not None]
    if not numeric:
        return
    actual = sum(numeric)
    if abs(expected - actual) > float(tolerance):
        report.fail(
            "sum_equals",
            fname,
            f"{fname}={expected} but sum of {sum_path}={actual} (tolerance {tolerance})",
        )


def _check_regex(params: Any, data: dict, report: ValidationReport) -> None:
    if not isinstance(params, dict):
        return
    fname = params.get("field")
    pattern = params.get("pattern")
    if not fname or not pattern:
        return
    value = data.get(fname)
    if value is None:
        return
    try:
        regex = re.compile(pattern)
    except re.error as e:
        report.fail("regex", fname, f"invalid pattern: {e}")
        return
    if not regex.search(str(value)):
        report.fail("regex", fname, f"value {value!r} does not match /{pattern}/")


RULES = {
    "required": _check_required,
    "not_empty": _check_not_empty,
    "enum_in": _check_enum_in,
    "date_order": _check_date_order,
    "sum_equals": _check_sum_equals,
    "regex": _check_regex,
}


# ── Entry point ─────────────────────────────────────────────────────


def validate_extracted(extracted: dict, schema_def: dict) -> ValidationReport:
    """Run all schema-declared validation rules against extracted data.

    Missing or malformed rule entries are skipped silently with a report
    warning-style issue — validation should never raise on bad schema input.
    """
    report = ValidationReport()

    if not isinstance(extracted, dict):
        return report

    rules = (schema_def or {}).get("validation")
    if not isinstance(rules, list):
        return report

    for rule_entry in rules:
        if not isinstance(rule_entry, dict) or len(rule_entry) != 1:
            report.fail(
                "malformed",
                None,
                "validation rule must be a single-key dict",
            )
            continue
        rule_name, params = next(iter(rule_entry.items()))
        handler = RULES.get(rule_name)
        if handler is None:
            report.fail("unknown", None, f"unknown validation rule '{rule_name}'")
            continue
        handler(params, extracted, report)

    return report
