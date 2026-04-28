"""Intelligent extraction pipeline: Map → Route → Extract → Validate → Reconcile."""

from __future__ import annotations

import asyncio
import difflib
import json
import re
import time

from .document_map import Chunk, build_document_map, summarize_map
from .packet_splitter import Section, classify_chunks_to_sections
from .providers import ModelProvider, build_provider, create_provider
from .router import group_routes, route_fields, summarize_routing


def _snap_to_source(value: str, chunks: list[Chunk], min_ratio: float = 0.5) -> str:
    """Find the best matching substring in the source chunks for a value.

    Used for fields with `verbatim: true`. The LLM's extraction may
    paraphrase or truncate; this snaps the output back to the actual
    document text. Uses difflib.SequenceMatcher for sliding-window
    fuzzy matching.

    Returns the best matching substring if the similarity ratio exceeds
    `min_ratio`, otherwise returns the original value unchanged.
    """
    if not value or not chunks:
        return value

    source_text = "\n".join(c.content for c in chunks)
    value_lower = value.strip().lower()
    best_match = value
    best_ratio = min_ratio

    # Slide a window roughly the size of the value across the source
    words = source_text.split()
    val_word_count = len(value.split())
    window_sizes = [val_word_count, val_word_count + 3, val_word_count + 6, val_word_count - 2]

    for window_size in window_sizes:
        if window_size < 2:
            continue
        for i in range(len(words) - window_size + 1):
            candidate = " ".join(words[i : i + window_size])
            ratio = difflib.SequenceMatcher(None, value_lower, candidate.lower()).ratio()
            if ratio > best_ratio:
                best_ratio = ratio
                best_match = candidate

    return best_match


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

    # Locale: unified block or legacy standalone keys
    locale = cfg.get("locale") or {}
    locale_fallback = locale.get("fallback") or {}
    date_locale = locale_fallback.get("date_format") or cfg.get("date_locale")
    default_currency = locale_fallback.get("currency") or cfg.get("default_currency")

    if date_locale:
        extra_instructions.append(
            f"Dates in this document use {date_locale} format. "
            f"When you encounter an ambiguous date like 04/06/2018, "
            f"interpret it according to {date_locale} ordering. "
            f"Output all dates as YYYY-MM-DD regardless of input format."
        )
    if default_currency:
        extra_instructions.append(f"When no explicit currency code is present, assume {default_currency}.")
    if cfg.get("blank_form_aware"):
        extra_instructions.append(
            "If this document appears to be a BLANK unfilled form with placeholder text "
            "(underscores, empty brackets, 'MM/DD/YYYY' placeholders, '___________'), "
            "return null for ALL fields. Do not extract from form labels or instructions — "
            "only extract actual filled-in data."
        )

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

Return a FLAT JSON object with the listed field NAMES as top-level keys — do NOT nest the result under a schema name or a wrapper object. Example: return `{{"field_a": ..., "field_b": ...}}`, not `{{"{schema_name}": {{"field_a": ..., "field_b": ...}}}}`. {date_instruction} Numbers as numbers (not strings). For enum/pick fields, choose the closest match from the allowed values. Do not invent data — only extract what is explicitly in the text.

Also include a "__confidence" key mapping each field name to your confidence (0.0-1.0) that the extracted value is correct. 1.0 = value is explicitly and unambiguously stated in the text. 0.5 = value is inferred or only partially visible. 0.0 = pure guess. For null fields, use 0.0.{extra_block}

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


def _extract_llm_confidence(parsed: dict, expected_fields: set[str]) -> dict[str, float]:
    """Pop __confidence from a parsed LLM response and return per-field scores.

    Returns a dict mapping field names to floats in [0.0, 1.0].
    If __confidence is missing or malformed, returns an empty dict.
    """
    raw = parsed.pop("__confidence", None)
    if not isinstance(raw, dict):
        return {}
    result: dict[str, float] = {}
    for key, val in raw.items():
        if key in expected_fields and isinstance(val, (int, float)):
            result[key] = max(0.0, min(1.0, float(val)))
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

            llm_conf = _extract_llm_confidence(parsed, expected_fields)
            result = _unwrap_nested_result(parsed, expected_fields)
            if llm_conf:
                result["__llm_confidence"] = llm_conf
            return result

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

Also include a "__confidence" key with your confidence (0.0-1.0) that the value is correct. Example: `{{"{field_name}": "value", "__confidence": {{"{field_name}": 0.85}}}}`. Use 0.0 if the field is null.

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

            llm_conf = _extract_llm_confidence(parsed, {field_name})
            result = _unwrap_nested_result(parsed, {field_name})
            if llm_conf:
                result["__llm_confidence"] = llm_conf
            return result
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


# ---------------------------------------------------------------------------
# Confidence scoring v2 — LLM self-reported confidence + provenance strength
# ---------------------------------------------------------------------------

# Weights when LLM confidence is available
_W_LLM = 0.50
_W_PROV = 0.35
_W_VAL = 0.15

# Weights when LLM confidence is missing (fallback)
_W_PROV_FALLBACK = 0.70
_W_VAL_FALLBACK = 0.30


def compute_provenance_strength(
    value,
    chunks: list[Chunk],
    field_type: str = "string",
) -> float:
    """Compute how well an extracted value can be found in source text (0.0-1.0).

    Returns a continuous score reflecting match quality:
      1.0  — exact substring match
      0.9  — case-insensitive match
      0.85 — normalized whitespace match
      0.8  — date/number format alternative found
      0.0  — not found
    """
    if value is None:
        return 0.0

    # For arrays, score each item individually and average
    if isinstance(value, list):
        if not value:
            return 0.0
        item_scores = [compute_provenance_strength(item, chunks, "string") for item in value]
        return sum(item_scores) / len(item_scores)

    needle = str(value).strip()
    if not needle:
        return 0.0

    source = "\n".join(c.content for c in chunks)
    if not source:
        return 0.0

    # Exact substring
    if needle in source:
        return 1.0

    # Case-insensitive
    if needle.lower() in source.lower():
        return 0.9

    # Normalized whitespace
    normalized_needle = " ".join(needle.split()).lower()
    normalized_source = " ".join(source.split()).lower()
    if normalized_needle in normalized_source:
        return 0.85

    # Date format alternatives (YYYY-MM-DD → try common input formats)
    if isinstance(value, str) and re.match(r"^\d{4}-\d{1,2}-\d{1,2}$", value):
        parts = value.split("-")
        if len(parts) == 3:
            y, m, d = parts
            for alt in [f"{m}/{d}/{y}", f"{d}/{m}/{y}", f"{m}-{d}-{y}", f"{m}.{d}.{y}"]:
                if alt in source:
                    return 0.8

    # Number format alternatives (strip commas, try with $)
    if isinstance(value, (int, float)) or (isinstance(value, str) and re.match(r"^[\d,.]+$", value)):
        numeric_str = str(value).replace(",", "")
        source_stripped = source.replace(",", "")
        if numeric_str in source_stripped:
            return 0.8

    return 0.0


def compute_field_confidence(
    *,
    llm_confidence: float | None = None,
    provenance_strength: float = 0.0,
    validation_passed: bool = True,
) -> float:
    """Compute confidence score from continuous signals.

    When llm_confidence is available:
      score = 0.50 * llm + 0.35 * provenance + 0.15 * validation
    When missing (fallback — provenance + validation only):
      score = 0.70 * provenance + 0.30 * validation
    """
    val_bonus = 1.0 if validation_passed else 0.0

    if llm_confidence is not None:
        llm_clamped = max(0.0, min(1.0, llm_confidence))
        score = _W_LLM * llm_clamped + _W_PROV * provenance_strength + _W_VAL * val_bonus
    else:
        score = _W_PROV_FALLBACK * provenance_strength + _W_VAL_FALLBACK * val_bonus

    return max(0.0, min(score, 1.0))


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

    # Merge LLM-reported confidence from all group results
    llm_conf_map: dict[str, list[float]] = {}
    for result in group_results:
        llm_conf = result.get("__llm_confidence", {})
        if isinstance(llm_conf, dict):
            for k, v in llm_conf.items():
                if isinstance(v, (int, float)):
                    llm_conf_map.setdefault(k, []).append(float(v))

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
        route_chunks = route.chunks if route else []

        # LLM confidence: average if reported by multiple groups
        llm_conf_values = llm_conf_map.get(field_name)
        llm_conf = sum(llm_conf_values) / len(llm_conf_values) if llm_conf_values else None

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

            prov = compute_provenance_strength(all_items, route_chunks, field_type)
            score = compute_field_confidence(
                llm_confidence=llm_conf,
                provenance_strength=prov,
                validation_passed=True,  # arrays skip type validation
            )
            confidence_scores[field_name] = score
            confidence[field_name] = _score_label(score)
        else:
            # For scalars, use the first value but note agreement
            value = candidates[0]
            value, is_valid, issue = validate_field(field_name, value, field_spec)
            merged[field_name] = value

            prov = compute_provenance_strength(value, route_chunks, field_type)
            score = compute_field_confidence(
                llm_confidence=llm_conf,
                provenance_strength=prov,
                validation_passed=is_valid,
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
    endpoint_cfg=None,  # EndpointConfig from main.py; forward-referenced to avoid circular import
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
    # When an endpoint is configured, go straight through build_provider.
    # When not, call create_provider directly so test suites that
    # monkeypatch pipeline.create_provider (lambda model: mock) still
    # intercept — see providers.build_provider docstring.
    provider = build_provider(model, endpoint_cfg) if endpoint_cfg else create_provider(model)
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
                        broadened_chunks,
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

            gap_results = await asyncio.gather(*[t[2] for t in gap_tasks])

            for (field_name, b_chunks, _), gap_result in zip(gap_tasks, gap_results):
                value = gap_result.get(field_name)
                if value is not None:
                    field_spec = schema_def["fields"][field_name]
                    value, is_valid, issue = validate_field(field_name, value, field_spec)
                    accumulated["extracted"][field_name] = value
                    llm_conf = gap_result.get("__llm_confidence", {}).get(field_name)
                    prov = compute_provenance_strength(
                        value,
                        b_chunks,
                        field_spec.get("type", "string"),
                    )
                    gap_score = compute_field_confidence(
                        llm_confidence=llm_conf,
                        provenance_strength=prov,
                        validation_passed=is_valid,
                    )
                    accumulated["confidence_scores"][field_name] = gap_score
                    accumulated["confidence"][field_name] = _score_label(gap_score)
                    gap_filled.append(field_name)
                    print(f"[koji-extract] Gap filled: {field_name} = {value}")
                else:
                    print(f"[koji-extract] Gap fill failed: {field_name} still missing")

        # Verbatim snap-to-source: for fields with verbatim: true, replace
        # the LLM's potentially-paraphrased output with the closest matching
        # substring from the actual document chunks.
        for field_name, value in accumulated["extracted"].items():
            if not isinstance(value, str) or not value:
                continue
            field_spec = schema_def.get("fields", {}).get(field_name, {})
            if field_spec.get("verbatim"):
                snapped = _snap_to_source(value, section_chunks)
                if snapped != value:
                    accumulated["extracted"][field_name] = snapped

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
    # The classifier reuses the same tenant endpoint as the main extract
    # unless the schema explicitly overrides the model string — in which
    # case endpoint_cfg no longer applies (different model, potentially
    # different provider) and we fall back to env-var routing.
    classify_endpoint_cfg = endpoint_cfg if classify_config.get("model") is None else None
    classify_provider = (
        build_provider(classify_model, classify_endpoint_cfg)
        if classify_endpoint_cfg
        else create_provider(classify_model)
    )
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
