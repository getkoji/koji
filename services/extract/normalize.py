"""Post-extraction normalization — schema-declared value transforms.

Runs after the LLM returns and after reconciliation. Transforms extracted
values into canonical shapes the schema author has declared, so downstream
systems get consistent output regardless of how the model phrased things.

Transforms are declared per-field via a `normalize:` directive that accepts
a single transform name or a list applied in order:

    fields:
      vendor_name:
        type: string
        normalize: [trim, lowercase]
      total_amount:
        type: number
        normalize: minor_units
      phone:
        type: string
        normalize: e164
      state:
        type: enum
        normalize: slugify

All transforms are pure and deterministic. Unknown transform names are
recorded as warnings and the value is passed through unchanged, so a
schema typo never loses data.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class NormalizationReport:
    """Records which transforms ran and any that failed to apply."""

    applied: list[tuple[str, str]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def note(self, field_name: str, transform: str) -> None:
        self.applied.append((field_name, transform))

    def warn(self, message: str) -> None:
        self.warnings.append(message)


# ── Transform implementations ───────────────────────────────────────


def _trim(value):
    if isinstance(value, str):
        return value.strip()
    return value


def _lowercase(value):
    if isinstance(value, str):
        return value.lower()
    return value


def _uppercase(value):
    if isinstance(value, str):
        return value.upper()
    return value


_SLUG_STRIP_RE = re.compile(r"[^a-z0-9]+")


def _slugify(value):
    if value is None:
        return None
    slug = _SLUG_STRIP_RE.sub("_", str(value).lower())
    return slug.strip("_")


_ISO_DATE_RE = re.compile(r"(\d{4})-(\d{1,2})-(\d{1,2})")
_US_DATE_RE = re.compile(r"(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})")


def _iso8601(value):
    """Best-effort date normalization to YYYY-MM-DD.

    Matches ISO-ish strings and common US formats. Falls back to the
    original value (with a caller-side warning) if nothing parses.
    """
    if value is None or not isinstance(value, str):
        return value
    s = value.strip()
    m = _ISO_DATE_RE.search(s)
    if m:
        y, mo, d = m.group(1), m.group(2).zfill(2), m.group(3).zfill(2)
        return f"{y}-{mo}-{d}"
    m = _US_DATE_RE.search(s)
    if m:
        mo, d, y = m.group(1).zfill(2), m.group(2).zfill(2), m.group(3)
        if len(y) == 2:
            y = ("20" + y) if int(y) < 70 else ("19" + y)
        return f"{y}-{mo}-{d}"
    return value


_CURRENCY_STRIP_RE = re.compile(r"[^\d.\-]")


def _minor_units(value):
    """Convert currency-like value to integer minor units (cents).

    Accepts numbers and strings like "$1,234.56", "1234.56 USD", "(1,234.56)"
    (parens → negative). Returns an int when parsing succeeds, otherwise
    the original value.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    negative = False
    if isinstance(value, str):
        s = value.strip()
        if s.startswith("(") and s.endswith(")"):
            negative = True
            s = s[1:-1]
        cleaned = _CURRENCY_STRIP_RE.sub("", s)
        if not cleaned or cleaned in {"-", "."}:
            return value
        try:
            amount = float(cleaned)
        except ValueError:
            return value
    else:
        try:
            amount = float(value)
        except (TypeError, ValueError):
            return value
    cents = round(amount * 100)
    if negative:
        cents = -cents
    return int(cents)


def _e164(value):
    """Strip phone formatting into +<digits>. US 10-digit numbers get +1 prepended."""
    if value is None or not isinstance(value, str):
        return value
    s = value.strip()
    if not s:
        return value
    has_plus = s.startswith("+")
    digits = re.sub(r"\D", "", s)
    if not digits:
        return value
    if has_plus:
        return "+" + digits
    if len(digits) == 10:
        return "+1" + digits
    if len(digits) == 11 and digits.startswith("1"):
        return "+" + digits
    return "+" + digits


TRANSFORMS = {
    "trim": _trim,
    "lowercase": _lowercase,
    "uppercase": _uppercase,
    "slugify": _slugify,
    "iso8601": _iso8601,
    "minor_units": _minor_units,
    "e164": _e164,
}


# ── Entry point ─────────────────────────────────────────────────────


def _as_transform_list(directive) -> list[str]:
    if directive is None:
        return []
    if isinstance(directive, str):
        return [directive]
    if isinstance(directive, list):
        return [str(t) for t in directive]
    return []


def _apply_transforms(value, transforms: list[str], field_name: str, report: NormalizationReport):
    for name in transforms:
        fn = TRANSFORMS.get(name)
        if fn is None:
            report.warn(f"{field_name}: unknown normalize transform '{name}' — skipped")
            continue
        before = value
        value = fn(value)
        if value != before:
            report.note(field_name, name)
    return value


def normalize_extracted(
    extracted: dict,
    schema_def: dict,
) -> tuple[dict, NormalizationReport]:
    """Apply schema-declared `normalize:` transforms to extracted output.

    Returns a new dict with transformed values plus a report of what was
    applied. The input dict is not mutated. Fields without a `normalize:`
    directive are passed through untouched. Array-of-objects fields apply
    per-item normalization using the declared item schema (when provided).
    """
    report = NormalizationReport()
    if not isinstance(extracted, dict):
        return extracted, report

    fields_spec = (schema_def or {}).get("fields", {}) or {}
    result: dict = dict(extracted)

    for field_name, spec in fields_spec.items():
        if field_name not in result:
            continue
        if not isinstance(spec, dict):
            continue

        directive = spec.get("normalize")
        transforms = _as_transform_list(directive)

        value = result[field_name]

        # Array of objects → apply item-level normalization to each row.
        item_spec = spec.get("items") if isinstance(spec.get("items"), dict) else None
        if isinstance(value, list) and item_spec and isinstance(item_spec.get("properties"), dict):
            item_schema = {"fields": item_spec["properties"]}
            new_rows = []
            for row in value:
                if isinstance(row, dict):
                    new_row, _ = normalize_extracted(row, item_schema)
                    new_rows.append(new_row)
                else:
                    new_rows.append(row)
            value = new_rows

        if transforms:
            value = _apply_transforms(value, transforms, field_name, report)

        result[field_name] = value

    return result, report
