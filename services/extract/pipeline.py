"""Intelligent extraction pipeline: Map → Route → Extract → Validate → Reconcile."""

from __future__ import annotations

import asyncio
import json
import re
import time

from .document_map import Chunk, build_document_map, summarize_map
from .packet_splitter import Section, classify_chunks_to_sections
from .providers import ModelProvider, create_provider
from .router import group_routes, route_fields, summarize_routing


def _describe_array_item(spec: dict) -> str:
    """Render the shape of an array's items for the prompt.

    When a schema field says `items: {type: object, properties: {...}}`, the
    LLM needs to know which properties to extract for each element and what
    types they should be. Otherwise it will guess at names and drop fields
    it thinks are redundant.

    Recurses into nested arrays and objects so a top-level `policies` array
    of objects whose `limits` sub-property is itself an array of `{name,
    amount}` objects renders the full shape end-to-end. Without recursion
    the inner array reaches the prompt as the bare token `array`, the LLM
    has nothing to extract into, and returns `[]` (oss-65).
    """
    item_spec = spec.get("items") or {}
    if not isinstance(item_spec, dict):
        return ""

    item_type = item_spec.get("type")
    if item_type == "object":
        properties = item_spec.get("properties") or {}
        if not properties:
            return " of objects"
        parts = []
        for prop_name, prop_spec in properties.items():
            parts.append(_describe_property(prop_name, prop_spec))
        return " of objects with properties {" + ", ".join(parts) + "}"

    if item_type == "array":
        return " of arrays" + _describe_array_item(item_spec)

    if item_type:
        return f" of {item_type}"

    return ""


def _describe_property(prop_name: str, prop_spec) -> str:
    """Render a single property name + type for use inside a nested object
    description. Walks into nested arrays/objects via _describe_array_item
    so the rendered prompt carries full shape information all the way down.
    """
    if not isinstance(prop_spec, dict):
        return f"{prop_name}: string"
    prop_type = prop_spec.get("type", "string")
    if prop_type == "array":
        return f"{prop_name}: array{_describe_array_item(prop_spec)}"
    if prop_type == "object":
        nested_props = prop_spec.get("properties") or {}
        if not nested_props:
            return f"{prop_name}: object"
        nested_parts = [_describe_property(n, s) for n, s in nested_props.items()]
        return f"{prop_name}: object with properties {{" + ", ".join(nested_parts) + "}"
    return f"{prop_name}: {prop_type}"


# ── Field dependency ordering ───────────────────────────────────────


def _toposort_fields(schema_def: dict) -> list[list[str]]:
    """Topologically sort schema fields into extraction waves.

    Each wave is a list of field names that can be extracted in parallel.
    Wave N depends only on values produced by waves 0..N-1. A field with
    no `depends_on` lands in wave 0.

    Raises ValueError on:
    - A `depends_on` reference to a field that isn't defined in the schema.
    - A cycle in the dependency graph.

    Schemas with no `depends_on` declarations return a single wave
    containing every field — behavior is identical to the pre-wave
    pipeline.
    """
    fields = schema_def.get("fields") or {}
    field_names = list(fields.keys())

    # Build dependency edges — parent -> {children}
    depends: dict[str, set[str]] = {name: set() for name in field_names}
    for name, spec in fields.items():
        if not isinstance(spec, dict):
            continue
        raw = spec.get("depends_on") or []
        if not isinstance(raw, list):
            continue
        for parent in raw:
            if not isinstance(parent, str):
                continue
            if parent not in fields:
                raise ValueError(
                    f"Field {name!r} depends_on unknown field {parent!r}",
                )
            if parent == name:
                raise ValueError(f"Field {name!r} cannot depend on itself")
            depends[name].add(parent)

    waves: list[list[str]] = []
    resolved: set[str] = set()
    remaining = set(field_names)

    while remaining:
        ready = sorted(name for name in remaining if depends[name].issubset(resolved))
        if not ready:
            cycle = ", ".join(sorted(remaining))
            raise ValueError(
                f"Circular field dependency detected among: {cycle}",
            )
        waves.append(ready)
        resolved.update(ready)
        remaining.difference_update(ready)

    return waves


def _resolve_conditional_hints(field_spec: dict, extracted_so_far: dict) -> dict:
    """Return a copy of `field_spec` with `extraction_hint` resolved.

    Schemas can declare conditional per-parent hints under
    `extraction_hint_by`, keyed on a parent field name, then on the
    parent's extracted value:

        extraction_hint_by:
          form_type:
            "10-K":    "Look for 'For the fiscal year ended <date>'"
            "10-K/A":  "Use the ORIGINAL fiscal year, not the amendment date"
            "10-Q":    "Look for 'For the quarterly period ended <date>'"

    Resolution picks the first parent whose extracted value matches a
    declared key, and writes that value into the returned copy's
    `extraction_hint`. If no parent value matches any key (parent is
    missing, null, or has a value not in the map), the returned copy
    keeps whatever default `extraction_hint` the schema already had.

    The original `field_spec` is never mutated.
    """
    if not isinstance(field_spec, dict):
        return field_spec
    by_parent = field_spec.get("extraction_hint_by")
    if not isinstance(by_parent, dict) or not by_parent:
        return field_spec

    for parent_name, value_map in by_parent.items():
        if not isinstance(value_map, dict):
            continue
        parent_value = extracted_so_far.get(parent_name) if isinstance(extracted_so_far, dict) else None
        if parent_value is None:
            continue
        # Match by exact string first, then by string coercion, so enum
        # values like "10-K/A" still hit without requiring schema authors
        # to think about types.
        matched = value_map.get(parent_value)
        if matched is None:
            matched = value_map.get(str(parent_value))
        if isinstance(matched, str) and matched.strip():
            resolved = dict(field_spec)
            resolved["extraction_hint"] = matched
            return resolved

    return field_spec


def _resolve_wave_fields(schema_def: dict, wave: list[str], extracted_so_far: dict) -> dict:
    """Build a shallow schema copy whose `fields` block contains only the
    given wave's fields with their conditional hints resolved against the
    accumulated state. Used by the wave-based extraction loop.
    """
    resolved_fields = {
        name: _resolve_conditional_hints(schema_def["fields"][name], extracted_so_far)
        for name in wave
        if name in schema_def.get("fields", {})
    }
    return {**schema_def, "fields": resolved_fields}


def _collect_extraction_notes(fields: dict) -> str:
    """Render per-field extraction_hint strings into a notes block.

    Returns an empty string if no field has a hint. Otherwise returns a
    newline-separated list of bullets, one per field that provided a hint.
    The caller decides whether/how to include the block in the final prompt.
    """
    notes: list[str] = []
    for name, spec in fields.items():
        hint = spec.get("extraction_hint") if isinstance(spec, dict) else None
        if isinstance(hint, str) and hint.strip():
            notes.append(f"- **{name}**: {hint.strip()}")
    return "\n".join(notes)


def _render_context_chunks(
    context_chunks: list[Chunk] | None,
    routed_chunks: list[Chunk],
) -> str:
    """Render a `## Document context` section for non-routed context chunks.

    Every document type has an identifying region at the top: invoices
    have a header with vendor and bill-to; contracts have a preamble
    naming the parties; medical records have a patient block; legal
    filings have a caption; SEC filings have a cover page. The schema
    author's extraction rules frequently depend on that identifying
    region — "return the full vendor name", "use the filing date from
    the signature block UNLESS this is an amendment", "extract the
    effective date from the preamble".

    When the router scores a field toward chunks deep in the body (a
    signature block, a financial table, a diagnosis section), the group
    that field lands in loses visibility into the document's identity.
    The model then can't apply the conditional rules the schema author
    wrote, and falls back to null or guesses.

    This helper injects a small context block — typically the first one
    or two chunks of the document — into every group's prompt so the
    model always sees the document's opening, regardless of where the
    field actually routes. Chunks already present in the group's routed
    set are skipped to avoid duplication.

    Returns an empty string when there are no context chunks to add
    (either `context_chunks` is None/empty or every candidate is already
    in the group's routed chunks).
    """
    if not context_chunks:
        return ""
    routed_ids = {c.index for c in routed_chunks}
    fresh = [c for c in context_chunks if c.index not in routed_ids]
    if not fresh:
        return ""
    blocks = [f"### {c.title}\n\n{c.content}" for c in fresh]
    joined = "\n\n---\n\n".join(blocks)
    return f"\n## Document context\n\n{joined}\n"


def build_group_prompt(
    group: dict,
    schema_name: str,
    context_chunks: list[Chunk] | None = None,
    schema_config: dict | None = None,
) -> str:
    """Build a focused extraction prompt for a group of fields from specific chunks.

    When `context_chunks` is provided, a `## Document context` section is
    rendered above the routed chunks carrying the document's opening
    region (typically the first one or two chunks). This gives groups
    whose routing landed deep in the body enough top-of-document context
    to disambiguate schema-level conditions — form type on filings,
    amendment status, contract parties, patient identity, vendor header,
    whatever the schema author's extraction rules depend on. The context
    chunks are agnostic to domain; what makes the top of the document
    meaningful is set by the schema and the document itself.
    """
    fields = group["field_specs"]
    chunks = group["chunks"]

    field_descriptions = []
    for name, spec in fields.items():
        field_type = spec.get("type", "string")
        required = spec.get("required", False)
        description = spec.get("description", "")
        req_label = " (REQUIRED)" if required else ""
        desc_label = f" — {description}" if description else ""

        type_label = field_type
        if field_type == "array":
            type_label = "array" + _describe_array_item(spec)

        options = spec.get("options", spec.get("enum", []))
        mappings = spec.get("mappings", {})
        if mappings:
            # mapping type: show canonical values with their aliases
            parts = []
            for canonical, aliases in mappings.items():
                alias_list = ", ".join(str(a) for a in aliases if str(a) != str(canonical))
                if alias_list:
                    parts.append(f"{canonical} ({alias_list})")
                else:
                    parts.append(str(canonical))
            desc_label += f" [pick from: {', '.join(parts)}]"
        elif options:
            opts = ", ".join(str(o) for o in options)
            desc_label += f" [pick from: {opts}]"

        field_descriptions.append(f"  - {name}: {type_label}{req_label}{desc_label}")

    fields_block = "\n".join(field_descriptions)
    notes_block = _collect_extraction_notes(fields)

    # Collect exclude_contains patterns from all fields in this group.
    # Lines matching any pattern are stripped from the chunk content
    # before the LLM sees them — deterministic exclusion that can't be
    # ignored the way a prompt-level "do NOT use" instruction can.
    exclude_patterns: list[str] = []
    for spec in fields.values():
        for phrase in (spec.get("hints") or {}).get("exclude_contains") or []:
            if isinstance(phrase, str) and phrase.strip():
                exclude_patterns.append(phrase.strip().lower())

    # Combine chunk content
    content_blocks = []
    for chunk in chunks:
        chunk_text = chunk.content
        if exclude_patterns:
            filtered_lines = []
            for line in chunk_text.split("\n"):
                line_lower = line.lower()
                if any(pat in line_lower for pat in exclude_patterns):
                    continue
                filtered_lines.append(line)
            chunk_text = "\n".join(filtered_lines)
        content_blocks.append(f"### {chunk.title}\n\n{chunk_text}")
    content = "\n\n---\n\n".join(content_blocks)

    notes_section = f"\n## Extraction notes\n\n{notes_block}\n" if notes_block else ""
    context_section = _render_context_chunks(context_chunks, chunks)

    cfg = schema_config or {}
    extra_instructions = []
    date_locale = cfg.get("date_locale")
    if date_locale:
        extra_instructions.append(
            f"Dates in this document use {date_locale} format. "
            f"When you encounter an ambiguous date like 04/06/2018, "
            f"interpret it according to {date_locale} ordering. "
            f"Output all dates as YYYY-MM-DD regardless of input format."
        )
    default_currency = cfg.get("default_currency")
    if default_currency:
        extra_instructions.append(f"When no explicit currency code is present, assume {default_currency}.")

    date_instruction = "Dates as YYYY-MM-DD."
    if date_locale:
        date_instruction = f"Dates as YYYY-MM-DD (input uses {date_locale})."
    extra_block = "\n".join(extra_instructions)
    if extra_block:
        extra_block = "\n\n" + extra_block

    return f"""Extract the following fields from the document sections below. Return ONLY valid JSON with the fields you find. If a field is not present, use null.

## Fields to extract

{fields_block}
{notes_section}{context_section}
## Document sections

{content}

## Instructions

Return a FLAT JSON object with the listed field NAMES as top-level keys — do NOT nest the result under a schema name or a wrapper object. Example: return `{{"field_a": ..., "field_b": ...}}`, not `{{"{schema_name}": {{"field_a": ..., "field_b": ...}}}}`. {date_instruction} Numbers as numbers (not strings). For enum/pick fields, choose the closest match from the allowed values. Do not invent data — only extract what is explicitly in the text.{extra_block}

JSON:"""


def _unwrap_nested_result(result: dict, expected_fields: set[str]) -> dict:
    """Flatten a result the LLM wrapped under a single non-field key.

    Despite a prompt that explicitly asks for a flat JSON object with the
    listed field names as top-level keys, gpt-4o-mini occasionally wraps
    single-field output under the schema name (or some other label it
    picked up from the prompt). For example: expected
    `{"filing_date": "2026-04-10"}` but got
    `{"filing_metadata": {"filing_date": "2026-04-10"}}`. The wrapped form
    is semantically correct — the field IS extracted — but `reconcile`
    only looks at top-level keys and marks the field not_found.

    This helper detects and flattens that case. It only activates when:

      1. No expected field name appears as a top-level key (otherwise the
         result is already flat and there is nothing to do), AND
      2. There is exactly one nested dict at the top level whose keys
         overlap with the expected field set.

    In all other cases the result passes through unchanged, so legitimate
    nested outputs (e.g., array items, struct fields) are never touched.
    """
    if not isinstance(result, dict) or not result or not expected_fields:
        return result
    if any(f in result for f in expected_fields):
        return result
    nested_candidates = [v for v in result.values() if isinstance(v, dict) and any(f in v for f in expected_fields)]
    if len(nested_candidates) == 1:
        return nested_candidates[0]
    return result


async def extract_group(
    group: dict,
    schema_name: str,
    provider: ModelProvider,
    semaphore: asyncio.Semaphore,
    context_chunks: list[Chunk] | None = None,
    schema_config: dict | None = None,
) -> dict:
    """Extract fields from a group of co-located fields."""
    prompt = build_group_prompt(group, schema_name, context_chunks=context_chunks, schema_config=schema_config)
    expected_fields = set(group.get("field_specs", {}).keys())

    async with semaphore:
        try:
            raw = await provider.generate(prompt, json_mode=True)

            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                match = re.search(r"\{[\s\S]*\}", raw)
                if match:
                    try:
                        parsed = json.loads(match.group())
                    except json.JSONDecodeError:
                        print(f"[koji-extract] Group {group['fields']} returned invalid JSON")
                        return {}
                else:
                    print(f"[koji-extract] Group {group['fields']} returned invalid JSON")
                    return {}

            return _unwrap_nested_result(parsed, expected_fields)

        except Exception as e:
            print(f"[koji-extract] Group {group['fields']} error: {e}")
            return {}


def build_gap_fill_prompt(
    field_name: str,
    field_spec: dict,
    chunks: list[Chunk],
    schema_name: str,
    context_chunks: list[Chunk] | None = None,
) -> str:
    """Build a targeted prompt to find a single missing field across broadened chunks.

    Like `build_group_prompt`, accepts optional `context_chunks` so the
    gap-fill retry also sees the document's opening region. Gap-fill
    fires specifically on fields that the main pass missed, and those
    are exactly the fields most likely to need cross-document
    disambiguation context.
    """
    field_type = field_spec.get("type", "string")
    required = field_spec.get("required", False)
    description = field_spec.get("description", "")
    req_label = " (REQUIRED)" if required else ""
    desc_label = f" — {description}" if description else ""

    type_label = field_type
    if field_type == "array":
        type_label = "array" + _describe_array_item(field_spec)

    options = field_spec.get("options", field_spec.get("enum", []))
    mappings = field_spec.get("mappings", {})
    if mappings:
        parts = []
        for canonical, aliases in mappings.items():
            alias_list = ", ".join(str(a) for a in aliases if str(a) != str(canonical))
            if alias_list:
                parts.append(f"{canonical} ({alias_list})")
            else:
                parts.append(str(canonical))
        desc_label += f" [pick from: {', '.join(parts)}]"
    elif options:
        opts = ", ".join(str(o) for o in options)
        desc_label += f" [pick from: {opts}]"

    field_line = f"  - {field_name}: {type_label}{req_label}{desc_label}"

    hint = field_spec.get("extraction_hint") if isinstance(field_spec, dict) else None
    notes_section = ""
    if isinstance(hint, str) and hint.strip():
        notes_section = f"\n## Extraction notes\n\n- **{field_name}**: {hint.strip()}\n"

    content_blocks = []
    for chunk in chunks:
        content_blocks.append(f"### {chunk.title}\n\n{chunk.content}")
    content = "\n\n---\n\n".join(content_blocks)

    context_section = _render_context_chunks(context_chunks, chunks)

    # schema_name intentionally omitted from the header for the same
    # reason as build_group_prompt — see oss-60. A schema name there is
    # enough to push gpt-4o-mini to wrap the gap-fill output under that
    # key, which then fails the top-level lookup in _run_gap_fill.
    return f"""The field below was not found in an earlier extraction pass. Search thoroughly in ALL sections below and extract it if present. Return ONLY valid JSON. If the field is truly not present, return {{"{field_name}": null}}.

## Missing field to find

{field_line}
{notes_section}{context_section}
## Document sections (broadened search)

{content}

## Instructions

Look carefully through every section. The value may be embedded in prose, tables, or key-value pairs. Return a FLAT JSON object with ONLY the single field — do NOT nest the result under a schema name or a wrapper object. Example: return `{{"{field_name}": ...}}`, not `{{"{schema_name}": {{"{field_name}": ...}}}}`. Dates as YYYY-MM-DD. Numbers as numbers (not strings). Do not invent data.

JSON:"""


async def fill_gap(
    field_name: str,
    field_spec: dict,
    chunks: list[Chunk],
    schema_name: str,
    provider: ModelProvider,
    semaphore: asyncio.Semaphore,
    context_chunks: list[Chunk] | None = None,
) -> dict:
    """Attempt to extract a single missing field from broadened chunks."""
    prompt = build_gap_fill_prompt(field_name, field_spec, chunks, schema_name, context_chunks=context_chunks)

    async with semaphore:
        try:
            raw = await provider.generate(prompt, json_mode=True)
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                match = re.search(r"\{[\s\S]*\}", raw)
                if match:
                    try:
                        parsed = json.loads(match.group())
                    except json.JSONDecodeError:
                        print(f"[koji-extract] Gap fill for {field_name} returned invalid JSON")
                        return {}
                else:
                    print(f"[koji-extract] Gap fill for {field_name} returned invalid JSON")
                    return {}

            return _unwrap_nested_result(parsed, {field_name})
        except Exception as e:
            print(f"[koji-extract] Gap fill for {field_name} error: {e}")
            return {}


def validate_field(name: str, value, spec: dict) -> tuple:
    """Validate and normalize a field value. Returns (value, is_valid, issues)."""
    if value is None:
        if spec.get("required"):
            return None, False, "required field is null"
        return None, True, None

    field_type = spec.get("type", "string")
    issues = None

    # Type validation + normalization
    if field_type == "date" and isinstance(value, str):
        # Try to normalize common date formats to ISO 8601
        date_match = re.search(r"(\d{4})-(\d{1,2})-(\d{1,2})", value)
        if date_match:
            value = f"{date_match.group(1)}-{date_match.group(2).zfill(2)}-{date_match.group(3).zfill(2)}"
        else:
            issues = f"could not parse date: {value}"

    elif field_type == "number":
        if isinstance(value, str):
            cleaned = value.replace("$", "").replace(",", "").strip()
            try:
                value = float(cleaned)
                if value == int(value):
                    value = int(value)
            except ValueError:
                issues = f"could not parse number: {value}"

    elif field_type == "enum":
        options = spec.get("options", [])
        if options and value not in options:
            # Fuzzy match
            value_lower = str(value).lower()
            for opt in options:
                if opt.lower() == value_lower or opt.lower() in value_lower or value_lower in opt.lower():
                    value = opt
                    break
            else:
                issues = f"value '{value}' not in allowed options"

    elif field_type == "mapping":
        mappings = spec.get("mappings", {})
        if mappings:
            value_str = str(value)
            value_lower = value_str.lower()

            # Check if value is already a canonical key (exact)
            if value_str in mappings:
                value = value_str
            else:
                # Check aliases: exact case-insensitive match first
                matched = False
                for canonical, aliases in mappings.items():
                    if value_lower == canonical.lower():
                        value = canonical
                        matched = True
                        break
                    for alias in aliases:
                        if value_lower == str(alias).lower():
                            value = canonical
                            matched = True
                            break
                    if matched:
                        break

                if not matched:
                    # Fuzzy substring match against all aliases
                    for canonical, aliases in mappings.items():
                        for alias in aliases:
                            alias_lower = str(alias).lower()
                            if alias_lower in value_lower or value_lower in alias_lower:
                                value = canonical
                                matched = True
                                break
                        if matched:
                            break

                if not matched:
                    issues = f"value '{value}' not in allowed mappings"

    return value, issues is None, issues


def _score_label(score: float) -> str:
    """Convert a numeric confidence score to a string label."""
    if score >= 0.7:
        return "high"
    if score >= 0.4:
        return "medium"
    if score > 0:
        return "low"
    return "not_found"


# Weights for route source quality factor (0.0–0.4)
ROUTE_SOURCE_WEIGHTS: dict[str, float] = {
    "hint": 0.4,
    "signal_inferred": 0.25,
    "broadened": 0.1,
    "fallback": 0.05,
}


def compute_confidence_score(
    *,
    route_source: str | None,
    multi_source_agree: bool,
    single_source: bool,
    validation_passed: bool,
    has_relevant_signals: bool,
) -> float:
    """Compute a numeric confidence score (0.0-1.0) from individual factors.

    Factors:
      - Route source quality (0.0-0.4): hint=0.4, signal_inferred=0.25,
        broadened=0.1, fallback=0.05
      - Source agreement  (0.0-0.3): multi-source agree=0.3, single=0.15
      - Validation pass   (0.0-0.2): passed=0.2, failed=0.0
      - Signal density    (0.0-0.1): relevant signals present=0.1
    """
    score = 0.0

    # Route source quality (0.0-0.4)
    if route_source is not None:
        score += ROUTE_SOURCE_WEIGHTS.get(route_source, 0.0)

    # Source agreement (0.0-0.3)
    if multi_source_agree:
        score += 0.3
    elif single_source:
        score += 0.15

    # Validation pass (0.0-0.2)
    if validation_passed:
        score += 0.2

    # Signal density (0.0-0.1)
    if has_relevant_signals:
        score += 0.1

    return min(score, 1.0)


def _field_has_relevant_signals(field_spec: dict, chunks: list) -> bool:
    """Check whether any routed chunks have signals relevant to the field type."""
    field_type = field_spec.get("type", "string")
    from .router import TYPE_SIGNAL_MAP

    relevant = TYPE_SIGNAL_MAP.get(field_type, [])
    if not relevant:
        return False
    for chunk in chunks:
        for signal in relevant:
            if signal in chunk.signals:
                return True
    return False


def reconcile(
    group_results: list[dict],
    schema_def: dict,
    routes: list | None = None,
) -> dict:
    """Merge and reconcile results from multiple extraction groups.

    Args:
        group_results: Raw extraction dicts from each LLM call.
        schema_def: The schema definition with field specs.
        routes: Optional list of FieldRoute objects for per-field scoring.
    """
    fields = schema_def.get("fields", {})
    merged: dict = {}
    confidence: dict = {}
    confidence_scores: dict = {}

    # Build a lookup from field name to route metadata
    route_map: dict = {}
    if routes:
        for route in routes:
            route_map[route.field_name] = route

    for field_name, field_spec in fields.items():
        field_type = field_spec.get("type", "string")
        candidates = []

        for result in group_results:
            if field_name in result and result[field_name] is not None:
                candidates.append(result[field_name])

        if not candidates:
            merged[field_name] = None
            confidence[field_name] = "not_found"
            confidence_scores[field_name] = 0.0
            continue

        route = route_map.get(field_name)
        route_source = route.source if route else None
        has_signals = _field_has_relevant_signals(field_spec, route.chunks if route else [])

        if field_type == "array":
            # Concatenate and deduplicate arrays
            all_items = []
            seen = set()
            for candidate in candidates:
                if isinstance(candidate, list):
                    for item in candidate:
                        item_key = json.dumps(item, sort_keys=True) if isinstance(item, dict) else str(item)
                        if item_key not in seen:
                            seen.add(item_key)
                            all_items.append(item)
            merged[field_name] = all_items

            multi = len(candidates) > 1
            score = compute_confidence_score(
                route_source=route_source,
                multi_source_agree=multi,
                single_source=not multi,
                validation_passed=True,  # arrays skip type validation
                has_relevant_signals=has_signals,
            )
            confidence_scores[field_name] = score
            confidence[field_name] = _score_label(score)
        else:
            # For scalars, use the first value but note agreement
            value = candidates[0]
            value, is_valid, issue = validate_field(field_name, value, field_spec)
            merged[field_name] = value

            multi = len(candidates) > 1 and all(str(c) == str(candidates[0]) for c in candidates)
            single = not multi
            score = compute_confidence_score(
                route_source=route_source,
                multi_source_agree=multi,
                single_source=single,
                validation_passed=is_valid,
                has_relevant_signals=has_signals,
            )
            confidence_scores[field_name] = score
            confidence[field_name] = _score_label(score)

    return {
        "extracted": merged,
        "confidence": confidence,
        "confidence_scores": confidence_scores,
    }


def _schema_matches_section(
    schema_def: dict,
    section: Section,
    require_apply_to: bool,
    classifier_errored: bool = False,
) -> bool:
    """Does this schema want to run against this section?

    When the classifier is on and the schema declares `apply_to`, only
    sections whose type is in the list are a match. When the schema has
    no `apply_to`, behavior depends on `classify.require_apply_to`:
    forgiving (default) matches every section; strict raises at call
    time via the caller's ValueError check — this helper only returns
    True/False.

    Fallback sections (type == `document`) get special treatment:

    - **Classifier errored** (LLM threw, network failure, etc.):
      bypass apply_to. The classifier had a transient failure, not
      a classification judgment. Silently filtering a legit filing
      because the classifier hiccupped is the regression oss-55
      tracked down.
    - **Classifier succeeded** but fell back to `document` (normalizer
      corrected garbage JSON into the default type): do NOT bypass
      apply_to. The classifier ran, processed the content, and
      couldn't match it to any declared type. That's the classifier
      saying "this doesn't look like what the schema is looking for"
      — exactly the signal apply_to is designed to act on.
    """
    apply_to = schema_def.get("apply_to")
    if apply_to is None:
        return not require_apply_to
    if not isinstance(apply_to, list):
        return False
    if section.type == "document":
        return classifier_errored
    return section.type in apply_to


async def intelligent_extract(
    markdown: str,
    schema_def: dict,
    model: str,
    max_concurrent: int = 5,
    classify_config: dict | None = None,
) -> dict:
    """Run the full intelligent extraction pipeline.

    Fields can declare `depends_on: [other_field]` to request that their
    parent fields be extracted first. The pipeline topologically sorts
    fields into waves; within each wave, fields route/group/extract
    normally. Between waves, any conditional hints (`extraction_hint_by`)
    are resolved against the values already extracted in earlier waves.

    When `classify_config` is provided, an extra classification stage runs
    between document mapping and routing. It splits the document into
    typed sections (invoice / coi / policy / etc.) using a small LLM
    call, then extracts each section independently so a single upload
    containing multiple stapled documents can be processed correctly.
    The response shape changes to wrap extraction results in a `sections`
    list; see docs/design/classify-split.md for the full design.

    `classify_config` shape (a plain dict so the pipeline module stays
    independent of the pydantic config models):

        {
          "model": "openai/gpt-4o-mini",       # optional; defaults to extract model
          "require_apply_to": False,           # optional; defaults to False
          "types": [                           # required when classifier enabled
            {"id": "invoice",  "description": "Commercial invoice."},
            {"id": "policy",   "description": "Insurance policy."},
          ]
        }

    Passing `classify_config=None` leaves the response shape and behavior
    byte-identical to the pre-classifier pipeline.
    """
    start = time.time()
    provider = create_provider(model)
    schema_name = schema_def.get("name", "document")
    semaphore = asyncio.Semaphore(max_concurrent)

    # Phase 1: Document mapping
    chunks = build_document_map(markdown, schema_def)
    doc_summary = summarize_map(chunks)
    print(f"[koji-extract] Map: {doc_summary['total_chunks']} chunks, categories: {doc_summary['by_category']}")

    async def _extract_one_section(section_chunks: list[Chunk]) -> dict:
        """Run the wave + gap-fill extraction pipeline against a chunk slice.

        Returns a dict with extracted / confidence / confidence_scores /
        gap_filled / routing_plan / groups keys. The caller decides
        whether to return this as the whole response or wrap it inside
        a sections list.
        """
        # Every group's prompt gets the first chunks of the section as
        # identifying context — see _render_context_chunks for why. Cap
        # at 2 to keep the per-group token overhead small while still
        # carrying typical header / cover / preamble content.
        context_chunks = section_chunks[:2] if section_chunks else []

        # Toposort fields into extraction waves
        waves = _toposort_fields(schema_def)
        if len(waves) > 1:
            print(f"[koji-extract] Field waves: {waves}")

        accumulated: dict = {"extracted": {}, "confidence": {}, "confidence_scores": {}}
        routing_plan: dict = {}
        all_groups: list[dict] = []

        for wave_index, wave in enumerate(waves):
            wave_schema = _resolve_wave_fields(schema_def, wave, accumulated["extracted"])

            wave_routes = route_fields(wave_schema, section_chunks)
            wave_plan = summarize_routing(wave_routes)
            routing_plan.update(wave_plan)
            if len(waves) > 1:
                print(f"[koji-extract] Wave {wave_index} routing plan:")
            else:
                print("[koji-extract] Routing plan:")
            for field, info in wave_plan.items():
                print(f"  {field}: {info['source']} → {info['chunks']}")

            wave_groups = group_routes(wave_routes)
            all_groups.extend(wave_groups)
            print(f"[koji-extract] Wave {wave_index}: grouped into {len(wave_groups)} extraction calls")

            tasks = [
                extract_group(
                    g, schema_name, provider, semaphore, context_chunks=context_chunks, schema_config=schema_def
                )
                for g in wave_groups
            ]
            wave_group_results = await asyncio.gather(*tasks)
            non_empty = [r for r in wave_group_results if r]
            print(f"[koji-extract] Wave {wave_index}: {len(non_empty)}/{len(wave_groups)} groups returned results")

            wave_result = reconcile(list(wave_group_results), wave_schema, routes=wave_routes)
            accumulated["extracted"].update(wave_result["extracted"])
            accumulated["confidence"].update(wave_result["confidence"])
            accumulated["confidence_scores"].update(wave_result["confidence_scores"])

        # Gap-fill for missing required fields
        missing_required = [
            f
            for f, conf in accumulated["confidence"].items()
            if conf == "not_found" and schema_def.get("fields", {}).get(f, {}).get("required")
        ]
        gap_filled: list[str] = []
        if missing_required:
            print(f"[koji-extract] Missing required fields: {missing_required}")
            print(f"[koji-extract] Gap filling: broadened retry for {len(missing_required)} fields")

            gap_tasks = []
            for field_name in missing_required:
                # Resolve conditional hints against the final accumulated state
                # before gap-fill, so dependent fields get their form-specific
                # extraction_hint even on the retry pass.
                field_spec = _resolve_conditional_hints(schema_def["fields"][field_name], accumulated["extracted"])
                # Re-route with hints stripped so the broadened pass actually
                # broadens — see oss-10 for why this matters.
                stripped_spec = {k: v for k, v in field_spec.items() if k != "hints"}
                broadened_routes = route_fields(
                    {"fields": {field_name: stripped_spec}},
                    section_chunks,
                    max_chunks_per_field=6,
                )
                broadened_chunks = broadened_routes[0].chunks if broadened_routes else section_chunks[:6]
                gap_tasks.append(
                    (
                        field_name,
                        fill_gap(
                            field_name,
                            field_spec,
                            broadened_chunks,
                            schema_name,
                            provider,
                            semaphore,
                            context_chunks=context_chunks,
                        ),
                    )
                )

            gap_results = await asyncio.gather(*[t[1] for t in gap_tasks])

            for (field_name, _), gap_result in zip(gap_tasks, gap_results):
                value = gap_result.get(field_name)
                if value is not None:
                    field_spec = schema_def["fields"][field_name]
                    value, is_valid, issue = validate_field(field_name, value, field_spec)
                    accumulated["extracted"][field_name] = value
                    gap_score = compute_confidence_score(
                        route_source="broadened",
                        multi_source_agree=False,
                        single_source=True,
                        validation_passed=is_valid,
                        has_relevant_signals=False,
                    )
                    accumulated["confidence_scores"][field_name] = gap_score
                    accumulated["confidence"][field_name] = _score_label(gap_score)
                    gap_filled.append(field_name)
                    print(f"[koji-extract] Gap filled: {field_name} = {value}")
                else:
                    print(f"[koji-extract] Gap fill failed: {field_name} still missing")

        return {
            "extracted": accumulated["extracted"],
            "confidence": accumulated["confidence"],
            "confidence_scores": accumulated["confidence_scores"],
            "gap_filled": gap_filled,
            "routing_plan": routing_plan,
            "groups": [
                {
                    "fields": group["fields"],
                    "chunk_count": len(group["chunks"]),
                }
                for group in all_groups
            ],
        }

    # ── Classifier OFF: classic single-section response shape ───────
    if not classify_config:
        section_result = await _extract_one_section(chunks)
        elapsed_ms = int((time.time() - start) * 1000)
        return {
            "extracted": section_result["extracted"],
            "confidence": section_result["confidence"],
            "confidence_scores": section_result["confidence_scores"],
            "chunks_total": doc_summary["total_chunks"],
            "extraction_groups": len(section_result["groups"]),
            "elapsed_ms": elapsed_ms,
            "gap_filled": section_result["gap_filled"],
            "document_map_summary": doc_summary,
            "routing_plan": section_result["routing_plan"],
            "groups": section_result["groups"],
        }

    # ── Classifier ON: classify, filter by apply_to, extract per-section ──
    require_apply_to = bool(classify_config.get("require_apply_to", False))
    apply_to = schema_def.get("apply_to")
    if require_apply_to and apply_to is None:
        raise ValueError(
            f"Schema {schema_name!r} must declare `apply_to` when classify.require_apply_to is true",
        )

    classify_model = classify_config.get("model") or model
    classify_provider = create_provider(classify_model)
    types = classify_config.get("types") or []
    short_doc_chunks = classify_config.get("short_doc_chunks")
    coalesce_threshold = classify_config.get("coalesce_other_threshold")
    classify_kwargs: dict = {}
    if isinstance(short_doc_chunks, int) and short_doc_chunks >= 0:
        classify_kwargs["short_doc_chunks"] = short_doc_chunks
    if isinstance(coalesce_threshold, (int, float)) and coalesce_threshold >= 0:
        classify_kwargs["coalesce_other_threshold"] = float(coalesce_threshold)
    # oss-62: when the schema declares apply_to, force the classifier to
    # run even on short docs. The short-doc fast path emits a single
    # `document`-typed section, which _schema_matches_section treats as
    # matching regardless of apply_to (the oss-55 escape hatch for
    # classifier-failure fallbacks). Without this override, a one-chunk
    # adversarial doc (e.g. a COI handed to the SEC schema) would bypass
    # the filter and hallucinate. Schemas that don't declare apply_to
    # keep the fast path and the LLM-free short-circuit.
    if apply_to is not None:
        classify_kwargs["short_doc_chunks"] = 0
    sections, classifier_meta = await classify_chunks_to_sections(
        chunks,
        classify_provider,
        types,
        **classify_kwargs,
    )
    classifier_meta["model"] = classify_model
    print(
        f"[koji-extract] Classifier: {len(sections)} section(s) "
        f"({classifier_meta.get('normalizer_corrections', 0)} corrections, "
        f"{classifier_meta.get('elapsed_ms', 0)}ms)"
    )

    classifier_errored = "error" in classifier_meta
    section_results: list[dict] = []
    for section in sections:
        if not _schema_matches_section(schema_def, section, require_apply_to, classifier_errored):
            continue
        section_chunks = [chunks[i] for i in section.chunk_indices if 0 <= i < len(chunks)]
        if not section_chunks:
            continue
        print(f"[koji-extract] Extracting section {section.title} ({len(section_chunks)} chunks, type={section.type})")
        sr = await _extract_one_section(section_chunks)
        section_results.append(
            {
                "section_type": section.type,
                "section_title": section.title,
                "section_confidence": section.confidence,
                "chunk_indices": section.chunk_indices,
                **sr,
            }
        )

    classifier_meta["sections_matched"] = len(section_results)
    if not section_results:
        classifier_meta["reason"] = "no_matching_section"

    elapsed_ms = int((time.time() - start) * 1000)
    return {
        "sections": section_results,
        "chunks_total": doc_summary["total_chunks"],
        "elapsed_ms": elapsed_ms,
        "document_map_summary": doc_summary,
        "classifier": classifier_meta,
    }
