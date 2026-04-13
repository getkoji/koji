"""Intelligent extraction pipeline: Map → Route → Extract → Validate → Reconcile."""

from __future__ import annotations

import asyncio
import json
import re
import time

from .document_map import Chunk, build_document_map, summarize_map
from .providers import ModelProvider, create_provider
from .router import group_routes, route_fields, summarize_routing


def _describe_array_item(spec: dict) -> str:
    """Render the shape of an array's items for the prompt.

    When a schema field says `items: {type: object, properties: {...}}`, the
    LLM needs to know which properties to extract for each element and what
    types they should be. Otherwise it will guess at names and drop fields
    it thinks are redundant.
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
            prop_type = (prop_spec or {}).get("type", "string") if isinstance(prop_spec, dict) else "string"
            parts.append(f"{prop_name}: {prop_type}")
        return " of objects with properties {" + ", ".join(parts) + "}"

    if item_type:
        return f" of {item_type}"

    return ""


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


def build_group_prompt(group: dict, schema_name: str) -> str:
    """Build a focused extraction prompt for a group of fields from specific chunks."""
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

    # Combine chunk content
    content_blocks = []
    for chunk in chunks:
        content_blocks.append(f"### {chunk.title}\n\n{chunk.content}")
    content = "\n\n---\n\n".join(content_blocks)

    notes_section = f"\n## Extraction notes\n\n{notes_block}\n" if notes_block else ""

    return f"""Extract the following fields from the document sections below. Return ONLY valid JSON with the fields you find. If a field is not present, use null.

## Fields to extract ({schema_name})

{fields_block}
{notes_section}
## Document sections

{content}

## Instructions

Return a JSON object with ONLY the listed fields. Dates as YYYY-MM-DD. Numbers as numbers (not strings). For enum/pick fields, choose the closest match from the allowed values. Do not invent data — only extract what is explicitly in the text.

JSON:"""


async def extract_group(
    group: dict,
    schema_name: str,
    provider: ModelProvider,
    semaphore: asyncio.Semaphore,
) -> dict:
    """Extract fields from a group of co-located fields."""
    prompt = build_group_prompt(group, schema_name)

    async with semaphore:
        try:
            raw = await provider.generate(prompt, json_mode=True)

            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                match = re.search(r"\{[\s\S]*\}", raw)
                if match:
                    try:
                        return json.loads(match.group())
                    except json.JSONDecodeError:
                        pass
                print(f"[koji-extract] Group {group['fields']} returned invalid JSON")
                return {}

        except Exception as e:
            print(f"[koji-extract] Group {group['fields']} error: {e}")
            return {}


def build_gap_fill_prompt(field_name: str, field_spec: dict, chunks: list[Chunk], schema_name: str) -> str:
    """Build a targeted prompt to find a single missing field across broadened chunks."""
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

    return f"""The field below was not found in an earlier extraction pass. Search thoroughly in ALL sections below and extract it if present. Return ONLY valid JSON. If the field is truly not present, return {{"{field_name}": null}}.

## Missing field to find ({schema_name})

{field_line}
{notes_section}
## Document sections (broadened search)

{content}

## Instructions

Look carefully through every section. The value may be embedded in prose, tables, or key-value pairs. Return a JSON object with ONLY the single field. Dates as YYYY-MM-DD. Numbers as numbers (not strings). Do not invent data.

JSON:"""


async def fill_gap(
    field_name: str,
    field_spec: dict,
    chunks: list[Chunk],
    schema_name: str,
    provider: ModelProvider,
    semaphore: asyncio.Semaphore,
) -> dict:
    """Attempt to extract a single missing field from broadened chunks."""
    prompt = build_gap_fill_prompt(field_name, field_spec, chunks, schema_name)

    async with semaphore:
        try:
            raw = await provider.generate(prompt, json_mode=True)
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                match = re.search(r"\{[\s\S]*\}", raw)
                if match:
                    try:
                        return json.loads(match.group())
                    except json.JSONDecodeError:
                        pass
                print(f"[koji-extract] Gap fill for {field_name} returned invalid JSON")
                return {}
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


async def intelligent_extract(
    markdown: str,
    schema_def: dict,
    model: str,
    max_concurrent: int = 5,
) -> dict:
    """Run the full intelligent extraction pipeline."""
    start = time.time()
    provider = create_provider(model)
    schema_name = schema_def.get("name", "document")

    # Phase 1: Document mapping
    chunks = build_document_map(markdown, schema_def)
    doc_summary = summarize_map(chunks)
    print(f"[koji-extract] Map: {doc_summary['total_chunks']} chunks, categories: {doc_summary['by_category']}")

    # Phase 2: Field routing
    routes = route_fields(schema_def, chunks)
    routing_plan = summarize_routing(routes)
    print("[koji-extract] Routing plan:")
    for field, info in routing_plan.items():
        print(f"  {field}: {info['source']} → {info['chunks']}")

    # Phase 3: Group and extract
    groups = group_routes(routes)
    print(f"[koji-extract] Grouped into {len(groups)} extraction calls")

    semaphore = asyncio.Semaphore(max_concurrent)
    tasks = [extract_group(group, schema_name, provider, semaphore) for group in groups]
    group_results = await asyncio.gather(*tasks)

    non_empty = [r for r in group_results if r]
    print(f"[koji-extract] {len(non_empty)}/{len(groups)} groups returned results")

    # Phase 4 + 5: Validate and reconcile
    result = reconcile(list(group_results), schema_def, routes=routes)

    # Check for missing required fields
    missing_required = [
        f
        for f, conf in result["confidence"].items()
        if conf == "not_found" and schema_def.get("fields", {}).get(f, {}).get("required")
    ]
    gap_filled: list[str] = []
    if missing_required:
        print(f"[koji-extract] Missing required fields: {missing_required}")
        print(f"[koji-extract] Gap filling: broadened retry for {len(missing_required)} fields")

        gap_tasks = []
        for field_name in missing_required:
            field_spec = schema_def["fields"][field_name]
            # Re-route with broadened search: double chunks, no category filtering
            broadened_routes = route_fields(
                {"fields": {field_name: field_spec}},
                chunks,
                max_chunks_per_field=6,
            )
            broadened_chunks = broadened_routes[0].chunks if broadened_routes else chunks[:6]
            gap_tasks.append(
                (
                    field_name,
                    fill_gap(field_name, field_spec, broadened_chunks, schema_name, provider, semaphore),
                )
            )

        gap_results = await asyncio.gather(*[t[1] for t in gap_tasks])

        for (field_name, _), gap_result in zip(gap_tasks, gap_results):
            value = gap_result.get(field_name)
            if value is not None:
                field_spec = schema_def["fields"][field_name]
                value, is_valid, issue = validate_field(field_name, value, field_spec)
                result["extracted"][field_name] = value
                # Gap-filled fields use broadened source, single source
                gap_score = compute_confidence_score(
                    route_source="broadened",
                    multi_source_agree=False,
                    single_source=True,
                    validation_passed=is_valid,
                    has_relevant_signals=False,
                )
                result["confidence_scores"][field_name] = gap_score
                result["confidence"][field_name] = _score_label(gap_score)
                gap_filled.append(field_name)
                print(f"[koji-extract] Gap filled: {field_name} = {value}")
            else:
                print(f"[koji-extract] Gap fill failed: {field_name} still missing")

    elapsed_ms = int((time.time() - start) * 1000)

    return {
        "extracted": result["extracted"],
        "confidence": result["confidence"],
        "confidence_scores": result["confidence_scores"],
        "chunks_total": doc_summary["total_chunks"],
        "extraction_groups": len(groups),
        "elapsed_ms": elapsed_ms,
        "gap_filled": gap_filled,
        "document_map_summary": doc_summary,
        "routing_plan": routing_plan,
        "groups": [
            {
                "fields": group["fields"],
                "chunk_count": len(group["chunks"]),
            }
            for group in groups
        ],
    }
