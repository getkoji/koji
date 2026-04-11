"""Intelligent extraction pipeline: Map → Route → Extract → Validate → Reconcile."""

from __future__ import annotations

import asyncio
import json
import re
import time

from .document_map import Chunk, build_document_map, summarize_map
from .providers import ModelProvider, create_provider
from .router import FieldRoute, group_routes, route_fields, summarize_routing


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

        options = spec.get("options", spec.get("enum", []))
        if options:
            opts = ", ".join(str(o) for o in options)
            desc_label += f" [pick from: {opts}]"

        field_descriptions.append(f"  - {name}: {field_type}{req_label}{desc_label}")

    fields_block = "\n".join(field_descriptions)

    # Combine chunk content
    content_blocks = []
    for chunk in chunks:
        content_blocks.append(f"### {chunk.title}\n\n{chunk.content}")
    content = "\n\n---\n\n".join(content_blocks)

    return f"""Extract the following fields from the document sections below. Return ONLY valid JSON with the fields you find. If a field is not present, use null.

## Fields to extract ({schema_name})

{fields_block}

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
                match = re.search(r'\{[\s\S]*\}', raw)
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
        date_match = re.search(r'(\d{4})-(\d{1,2})-(\d{1,2})', value)
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

    return value, issues is None, issues


def reconcile(group_results: list[dict], schema_def: dict) -> dict:
    """Merge and reconcile results from multiple extraction groups."""
    fields = schema_def.get("fields", {})
    merged: dict = {}
    confidence: dict = {}

    for field_name, field_spec in fields.items():
        field_type = field_spec.get("type", "string")
        candidates = []

        for result in group_results:
            if field_name in result and result[field_name] is not None:
                candidates.append(result[field_name])

        if not candidates:
            merged[field_name] = None
            confidence[field_name] = "not_found"
            continue

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
            confidence[field_name] = "high" if len(candidates) > 1 else "medium"
        else:
            # For scalars, use the first value but note agreement
            value = candidates[0]
            value, is_valid, issue = validate_field(field_name, value, field_spec)
            merged[field_name] = value

            if len(candidates) > 1 and all(str(c) == str(candidates[0]) for c in candidates):
                confidence[field_name] = "high"  # Multiple sources agree
            elif is_valid:
                confidence[field_name] = "medium"
            else:
                confidence[field_name] = "low"

    return {"extracted": merged, "confidence": confidence}


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
    chunks = build_document_map(markdown)
    doc_summary = summarize_map(chunks)
    print(f"[koji-extract] Map: {doc_summary['total_chunks']} chunks, categories: {doc_summary['by_category']}")

    # Phase 2: Field routing
    routes = route_fields(schema_def, chunks)
    routing_plan = summarize_routing(routes)
    print(f"[koji-extract] Routing plan:")
    for field, info in routing_plan.items():
        print(f"  {field}: {info['source']} → {info['chunks']}")

    # Phase 3: Group and extract
    groups = group_routes(routes)
    print(f"[koji-extract] Grouped into {len(groups)} extraction calls")

    semaphore = asyncio.Semaphore(max_concurrent)
    tasks = [
        extract_group(group, schema_name, provider, semaphore)
        for group in groups
    ]
    group_results = await asyncio.gather(*tasks)

    non_empty = [r for r in group_results if r]
    print(f"[koji-extract] {len(non_empty)}/{len(groups)} groups returned results")

    # Phase 4 + 5: Validate and reconcile
    result = reconcile(list(group_results), schema_def)

    # Check for missing required fields
    missing_required = [
        f for f, conf in result["confidence"].items()
        if conf == "not_found" and schema_def.get("fields", {}).get(f, {}).get("required")
    ]
    if missing_required:
        print(f"[koji-extract] Missing required fields: {missing_required}")
        # TODO: Phase 5 gap filling — broaden search for missing required fields

    elapsed_ms = int((time.time() - start) * 1000)

    return {
        "extracted": result["extracted"],
        "confidence": result["confidence"],
        "chunks_total": doc_summary["total_chunks"],
        "extraction_groups": len(groups),
        "elapsed_ms": elapsed_ms,
    }
