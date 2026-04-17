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
_EU_DATE_RE = re.compile(r"(\d{1,2})\.(\d{1,2})\.(\d{2,4})")
_MONTH_NAMES = {
    "january": 1,
    "february": 2,
    "march": 3,
    "april": 4,
    "may": 5,
    "june": 6,
    "july": 7,
    "august": 8,
    "september": 9,
    "october": 10,
    "november": 11,
    "december": 12,
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "sept": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}
# "January 15, 2025" or "Jan 15, 2025"
_VERBOSE_MDY_RE = re.compile(
    r"(?:^|\b)(" + "|".join(_MONTH_NAMES) + r")\s+(\d{1,2}),?\s+(\d{4})\b",
    re.IGNORECASE,
)
# "15 January 2025" or "15 Jan 2025"
_VERBOSE_DMY_RE = re.compile(
    r"(?:^|\b)(\d{1,2})\s+(" + "|".join(_MONTH_NAMES) + r"),?\s+(\d{4})\b",
    re.IGNORECASE,
)


def _iso8601(value, dayfirst: bool = False):
    """Best-effort date normalization to YYYY-MM-DD.

    Tries formats in order: ISO, verbose month-day-year, verbose
    day-month-year, ambiguous numeric (locale-aware), European
    DD.MM.YYYY. Falls back to the original value if nothing parses.

    When `dayfirst` is True, ambiguous numeric dates like 04/06/2025
    are interpreted as DD/MM (April 6 → June 4). Default is MM/DD
    (US convention).
    """
    if value is None or not isinstance(value, str):
        return value
    s = value.strip()
    # ISO: 2025-01-15
    m = _ISO_DATE_RE.search(s)
    if m:
        y, mo, d = m.group(1), m.group(2).zfill(2), m.group(3).zfill(2)
        return f"{y}-{mo}-{d}"
    # Verbose MDY: January 15, 2025 / Jan 15 2025
    m = _VERBOSE_MDY_RE.search(s)
    if m:
        mo = _MONTH_NAMES.get(m.group(1).lower())
        if mo:
            return f"{m.group(3)}-{mo:02d}-{int(m.group(2)):02d}"
    # Verbose DMY: 15 January 2025 / 15 Jan 2025
    m = _VERBOSE_DMY_RE.search(s)
    if m:
        mo = _MONTH_NAMES.get(m.group(2).lower())
        if mo:
            return f"{m.group(3)}-{mo:02d}-{int(m.group(1)):02d}"
    # Numeric with / or - separator: locale-aware
    m = _US_DATE_RE.search(s)
    if m:
        a, b, y = m.group(1).zfill(2), m.group(2).zfill(2), m.group(3)
        if len(y) == 2:
            y = ("20" + y) if int(y) < 70 else ("19" + y)
        if dayfirst:
            d, mo = a, b
        else:
            mo, d = a, b
        return f"{y}-{mo}-{d}"
    # European: DD.MM.YYYY (dot separator is always DD.MM)
    m = _EU_DATE_RE.search(s)
    if m:
        d, mo, y = m.group(1).zfill(2), m.group(2).zfill(2), m.group(3)
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


# ── State-from-address derivation ──────────────────────────────────

_US_STATES = {
    "alabama": "AL",
    "alaska": "AK",
    "arizona": "AZ",
    "arkansas": "AR",
    "california": "CA",
    "colorado": "CO",
    "connecticut": "CT",
    "delaware": "DE",
    "florida": "FL",
    "georgia": "GA",
    "hawaii": "HI",
    "idaho": "ID",
    "illinois": "IL",
    "indiana": "IN",
    "iowa": "IA",
    "kansas": "KS",
    "kentucky": "KY",
    "louisiana": "LA",
    "maine": "ME",
    "maryland": "MD",
    "massachusetts": "MA",
    "michigan": "MI",
    "minnesota": "MN",
    "mississippi": "MS",
    "missouri": "MO",
    "montana": "MT",
    "nebraska": "NE",
    "nevada": "NV",
    "new hampshire": "NH",
    "new jersey": "NJ",
    "new mexico": "NM",
    "new york": "NY",
    "north carolina": "NC",
    "north dakota": "ND",
    "ohio": "OH",
    "oklahoma": "OK",
    "oregon": "OR",
    "pennsylvania": "PA",
    "rhode island": "RI",
    "south carolina": "SC",
    "south dakota": "SD",
    "tennessee": "TN",
    "texas": "TX",
    "utah": "UT",
    "vermont": "VT",
    "virginia": "VA",
    "washington": "WA",
    "west virginia": "WV",
    "wisconsin": "WI",
    "wyoming": "WY",
    "district of columbia": "DC",
}
_STATE_ABBREVS = set(_US_STATES.values())
# Regex: two-letter state code preceded by comma+space or standalone, followed
# by a ZIP code or end of string. Catches "Albany, NY 12207" and "Charlotte, NC".
_STATE_ABBREV_RE = re.compile(
    r"(?:,\s*|\b)(" + "|".join(_STATE_ABBREVS) + r")\b\s*(?:\d{5}|$)",
    re.IGNORECASE,
)


def _us_state_lookup(text: str, prefer: str = "last") -> str | None:
    """Extract a US state abbreviation from text containing an address.

    `prefer` is "first" or "last" — controls which match to return
    when multiple states appear in the same text.
    """
    if not text:
        return None
    matches = _STATE_ABBREV_RE.findall(text)
    if matches:
        pick = matches[-1] if prefer == "last" else matches[0]
        return pick.upper()
    text_lower = text.lower()
    found: list[tuple[int, str]] = []
    for name, abbrev in _US_STATES.items():
        pos = text_lower.rfind(name) if prefer == "last" else text_lower.find(name)
        if pos >= 0:
            found.append((pos, abbrev))
    if found:
        found.sort(key=lambda x: x[0], reverse=(prefer == "last"))
        return found[0][1]
    return None


# Registry of derivation methods. Each takes (text, **kwargs) and returns
# the derived value (or None). The engine dispatches by name from the
# schema's `derived_from.method`. Extra schema keys (like `prefer`)
# are passed through as kwargs.
DERIVATION_METHODS: dict[str, callable] = {
    "us_state_lookup": _us_state_lookup,
}


# ── Locale inference ───────────────────────────────────────────────

# Maps country/region signals found in document text to locale properties.
# The engine scans extracted fields for these signals and infers locale
# when the schema doesn't declare one explicitly.
_LOCALE_SIGNALS = {
    # Currency symbols → (currency_code, date_format, decimal_separator)
    "RM": ("MYR", "DD/MM/YYYY", "."),
    "S$": ("SGD", "DD/MM/YYYY", "."),
    "C$": ("CAD", "DD/MM/YYYY", "."),
    "CA$": ("CAD", "DD/MM/YYYY", "."),
    "A$": ("AUD", "DD/MM/YYYY", "."),
    "AU$": ("AUD", "DD/MM/YYYY", "."),
    "€": ("EUR", "DD/MM/YYYY", ","),
    "£": ("GBP", "DD/MM/YYYY", "."),
    "¥": ("JPY", "YYYY/MM/DD", "."),
    "₹": ("INR", "DD/MM/YYYY", "."),
}

_COUNTRY_LOCALES = {
    "malaysia": ("MYR", "DD/MM/YYYY", "."),
    "singapore": ("SGD", "DD/MM/YYYY", "."),
    "canada": ("CAD", "DD/MM/YYYY", "."),
    "australia": ("AUD", "DD/MM/YYYY", "."),
    "united kingdom": ("GBP", "DD/MM/YYYY", "."),
    "uk": ("GBP", "DD/MM/YYYY", "."),
    "germany": ("EUR", "DD.MM.YYYY", ","),
    "france": ("EUR", "DD/MM/YYYY", ","),
    "japan": ("JPY", "YYYY/MM/DD", "."),
    "india": ("INR", "DD/MM/YYYY", "."),
    "new zealand": ("NZD", "DD/MM/YYYY", "."),
    "brazil": ("BRL", "DD/MM/YYYY", ","),
    "mexico": ("MXN", "DD/MM/YYYY", "."),
}

# US state abbreviations → US locale (already have the full list above)
_US_LOCALE = ("USD", "MM/DD/YYYY", ".")


def infer_locale(extracted: dict, scan_fields: list[str] | None = None) -> dict:
    """Infer locale properties from extracted field values.

    Scans the named fields (or all string fields if none specified) for
    currency symbols, country names, and US state abbreviations. Returns
    a dict with keys: currency, date_format, decimal_separator. Missing
    keys mean no signal was found for that property.
    """
    if scan_fields:
        texts = [str(extracted.get(f, "")) for f in scan_fields if extracted.get(f)]
    else:
        texts = [str(v) for v in extracted.values() if isinstance(v, str) and len(v) > 3]

    combined = " ".join(texts)
    if not combined.strip():
        return {}

    # Check currency symbols first (most specific)
    for symbol, (currency, date_fmt, dec_sep) in _LOCALE_SIGNALS.items():
        if symbol in combined:
            return {"currency": currency, "date_format": date_fmt, "decimal_separator": dec_sep}

    # Check country names
    combined_lower = combined.lower()
    for country, (currency, date_fmt, dec_sep) in _COUNTRY_LOCALES.items():
        if country in combined_lower:
            return {"currency": currency, "date_format": date_fmt, "decimal_separator": dec_sep}

    # Check for US state abbreviations → US locale
    if _STATE_ABBREV_RE.search(combined):
        return {"currency": "USD", "date_format": "MM/DD/YYYY", "decimal_separator": "."}

    return {}


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


def _apply_transforms(
    value, transforms: list[str], field_name: str, report: NormalizationReport, locale: dict | None = None
):
    dayfirst = False
    if locale and locale.get("date_format", "").startswith("DD"):
        dayfirst = True
    for name in transforms:
        fn = TRANSFORMS.get(name)
        if fn is None:
            report.warn(f"{field_name}: unknown normalize transform '{name}' — skipped")
            continue
        before = value
        if name == "iso8601" and dayfirst:
            value = fn(value, dayfirst=True)
        else:
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

    # Locale inference: scan extracted fields for location/currency signals
    # and use them to guide date/currency normalization. Schema declares:
    #   locale:
    #     infer_from: [vendor_address, merchant_name]
    #     fallback: { date_format: MM/DD/YYYY, currency: USD }
    locale_config = (schema_def or {}).get("locale") or {}
    scan_fields = locale_config.get("infer_from")
    fallback = locale_config.get("fallback") or {}
    inferred = infer_locale(result, scan_fields) if locale_config else {}
    # Merge: inferred wins over fallback, explicit schema keys win over both
    effective_locale = {**fallback, **inferred}
    if effective_locale:
        report.note("_locale", f"inferred {effective_locale}")

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
            value = _apply_transforms(value, transforms, field_name, report, locale=effective_locale)

        # Enum snapping: if the field has options and the value isn't in
        # the list, snap to the closest match via edit distance. Catches
        # the common case where the model returns a plausible synonym
        # ("Loss Report" → "Loss Run", "First Report of Injury" →
        # "Employer's First Report") without requiring explicit mappings.
        options = spec.get("options") or spec.get("enum")
        if isinstance(value, str) and isinstance(options, list) and options:
            value_lower = value.strip().lower()
            if not any(value_lower == str(o).strip().lower() for o in options):
                best_opt = None
                best_dist = float("inf")
                for opt in options:
                    opt_str = str(opt).strip().lower()
                    dist = _levenshtein_distance(value_lower, opt_str)
                    if dist < best_dist:
                        best_dist = dist
                        best_opt = opt
                max_len = max(len(value_lower), 1)
                if best_opt is not None and best_dist / max_len < 0.5:
                    report.note(field_name, f"enum snap {value!r} → {best_opt!r}")
                    value = best_opt

        result[field_name] = value

    # Derived fields: populate fields whose values can be computed from
    # other extracted fields. Schema declares:
    #
    #   state:
    #     derived_from:
    #       field: description_of_loss   # source field (or "*" for all strings)
    #       method: us_state_lookup      # registered derivation method
    #       prefer: last                 # optional: "first" or "last" match
    #
    # Runs after all transforms so source fields are in their final form.
    for field_name, spec in fields_spec.items():
        if not isinstance(spec, dict):
            continue
        derived = spec.get("derived_from")
        if not isinstance(derived, dict):
            continue
        source_field = derived.get("field")
        method_name = derived.get("method") or derived.get("transform")
        if not method_name:
            continue
        method = DERIVATION_METHODS.get(method_name)
        if method is None:
            report.warn(f"{field_name}: unknown derivation method {method_name!r}")
            continue
        # Only derive if the target field is empty/missing
        current = result.get(field_name)
        if current is not None and str(current).strip():
            continue
        # Collect source text(s)
        if source_field == "*" or not source_field:
            # Scan all string fields
            sources = [(k, v) for k, v in result.items() if isinstance(v, str) and len(v) > 5]
        else:
            v = result.get(source_field)
            sources = [(source_field, v)] if isinstance(v, str) and v else []
        # Pass any extra keys from the schema config as kwargs to the method
        method_kwargs = {k: v for k, v in derived.items() if k not in ("field", "method", "transform")}
        for src_name, src_value in sources:
            derived_val = method(src_value, **method_kwargs)
            if derived_val:
                result[field_name] = derived_val
                report.note(field_name, f"derived via {method_name} from {src_name}")
                break

    return result, report


def _levenshtein_distance(a: str, b: str) -> int:
    """Pure-Python Levenshtein edit distance."""
    if len(a) < len(b):
        return _levenshtein_distance(b, a)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a):
        curr = [i + 1]
        for j, cb in enumerate(b):
            curr.append(min(prev[j + 1] + 1, curr[j] + 1, prev[j] + (ca != cb)))
        prev = curr
    return prev[-1]
