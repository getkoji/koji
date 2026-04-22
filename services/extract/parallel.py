"""Parallel chunk extraction — split document, extract per chunk, merge results."""

from __future__ import annotations

import asyncio
import json
import re


def split_into_chunks(markdown: str, max_tokens: int = 2000) -> list[dict]:
    """Split markdown into chunks by sections, falling back to line-based splitting."""
    sections = []
    current_title = "Document Start"
    current_lines: list[str] = []

    for line in markdown.split("\n"):
        if line.startswith("#"):
            if current_lines:
                content = "\n".join(current_lines).strip()
                if content:
                    sections.append({"title": current_title, "content": content})
            current_title = line.lstrip("#").strip()
            current_lines = []
        else:
            current_lines.append(line)

    if current_lines:
        content = "\n".join(current_lines).strip()
        if content:
            sections.append({"title": current_title, "content": content})

    if not sections:
        # No headers — split by approximate token count (rough: 4 chars per token)
        lines = markdown.split("\n")
        chunk_lines: list[str] = []
        char_count = 0
        for line in lines:
            chunk_lines.append(line)
            char_count += len(line)
            if char_count > max_tokens * 4:
                sections.append(
                    {
                        "title": f"Chunk {len(sections) + 1}",
                        "content": "\n".join(chunk_lines).strip(),
                    }
                )
                chunk_lines = []
                char_count = 0
        if chunk_lines:
            sections.append(
                {
                    "title": f"Chunk {len(sections) + 1}",
                    "content": "\n".join(chunk_lines).strip(),
                }
            )

    return sections


def build_chunk_prompt(chunk: dict, schema_def: dict) -> str:
    """Build extraction prompt for a single chunk."""
    fields = schema_def.get("fields", {})
    schema_name = schema_def.get("name", "document")

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

    return f"""Extract any of the following fields from this document section. Return ONLY valid JSON. Only include fields that are actually present in this section. If a field is not found in this section, do not include it.

## Schema: {schema_name}

Fields:
{fields_block}

## Section: {chunk["title"]}

{chunk["content"]}

## Instructions

Return a JSON object with ONLY the fields you found in this section. Do not guess. Dates in YYYY-MM-DD format. Numbers as numbers. For enum/pick fields, choose the closest match from the allowed values.

JSON:"""


async def extract_chunk(
    chunk: dict,
    schema_def: dict,
    provider,
    semaphore: asyncio.Semaphore,
) -> dict:
    """Extract fields from a single chunk."""
    prompt = build_chunk_prompt(chunk, schema_def)

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
                print(f"[koji-extract] Chunk '{chunk['title']}' returned invalid JSON")
                return {}

        except Exception as e:
            print(f"[koji-extract] Chunk '{chunk['title']}' error: {e}")
            return {}


def merge_results(chunk_results: list[dict], schema_def: dict) -> dict:
    """Merge extraction results from multiple chunks. First non-null value wins for scalars, arrays get concatenated."""
    fields = schema_def.get("fields", {})
    merged: dict = {}

    for field_name, field_spec in fields.items():
        field_type = field_spec.get("type", "string")

        for result in chunk_results:
            if field_name not in result:
                continue

            value = result[field_name]
            if value is None:
                continue

            if field_type == "array":
                # Concatenate arrays
                if field_name not in merged:
                    merged[field_name] = []
                if isinstance(value, list):
                    merged[field_name].extend(value)
                else:
                    merged[field_name].append(value)
            else:
                # First non-null value wins
                if field_name not in merged:
                    merged[field_name] = value

    # Set null for fields not found anywhere
    for field_name in fields:
        if field_name not in merged:
            merged[field_name] = None

    return merged


def _categories_from_schema(
    schema_def: dict | None,
) -> tuple[list[str], list[tuple[list[str], str]], set[str]]:
    """Extract (categories, keyword_rules, default_relevant) from schema.

    Schema format:
        categories:
          keywords:
            header: ["title", "abstract"]
            body: ["section", "paragraph"]
          relevant: ["body"]   # optional — defaults to every declared category

    When the schema declares no categories, returns empty containers and
    `parallel_extract` skips the classify/filter step entirely.
    """
    categories_cfg = (schema_def or {}).get("categories") or {}
    keywords = categories_cfg.get("keywords") or {}
    if not isinstance(keywords, dict):
        keywords = {}
    rules = [(list(kws), cat) for cat, kws in keywords.items() if kws]
    categories = list(keywords.keys())
    declared_relevant = categories_cfg.get("relevant")
    if isinstance(declared_relevant, list) and declared_relevant:
        relevant = set(declared_relevant)
    else:
        relevant = set(categories)
    return categories, rules, relevant


async def parallel_extract(
    markdown: str,
    schema_def: dict,
    model: str,
    ollama_url: str,
    max_concurrent: int = 3,
    relevant_categories: set[str] | None = None,
    classify_mode: str = "keywords",
    endpoint_cfg=None,  # EndpointConfig from main.py; see providers.create_provider
) -> dict:
    """Split → classify → filter → extract in parallel → merge."""
    from .classify import classify_chunks, filter_relevant
    from .providers import create_provider

    provider = create_provider(model, endpoint_cfg=endpoint_cfg)

    all_chunks = split_into_chunks(markdown)
    print(f"[koji-extract] Split: {len(all_chunks)} chunks")

    categories, keyword_rules, schema_relevant = _categories_from_schema(schema_def)
    effective_relevant = relevant_categories if relevant_categories else schema_relevant

    if classify_mode == "all" or not categories:
        chunks = all_chunks
        classified = all_chunks
        reason = "Mode 'all'" if classify_mode == "all" else "No schema categories declared"
        print(f"[koji-extract] {reason}: extracting from all {len(chunks)} chunks")
    else:
        use_llm = classify_mode == "llm"
        classified = await classify_chunks(
            all_chunks,
            categories,
            keyword_rules,
            model,
            ollama_url,
            use_llm=use_llm,
        )
        chunks = filter_relevant(classified, effective_relevant)

    if not chunks:
        print("[koji-extract] No relevant chunks found, falling back to all chunks")
        chunks = all_chunks

    print(f"[koji-extract] Extracting from {len(chunks)} chunks via {model}, max {max_concurrent} concurrent")

    semaphore = asyncio.Semaphore(max_concurrent)

    tasks = [extract_chunk(chunk, schema_def, provider, semaphore) for chunk in chunks]

    chunk_results = await asyncio.gather(*tasks)

    # Filter empty results
    non_empty = [r for r in chunk_results if r]
    print(f"[koji-extract] {len(non_empty)}/{len(chunks)} chunks returned results")

    merged = merge_results(list(chunk_results), schema_def)

    return {
        "extracted": merged,
        "chunks_total": len(all_chunks),
        "chunks_classified": len(classified),
        "chunks_relevant": len(chunks),
        "chunks_with_results": len(non_empty),
    }
