"""Phase 2: Field Router — match schema fields to the right chunks using schema hints.

For short documents (chunk count ≤ max_chunks_per_field), the heuristic
scorer in `route_fields` is sufficient — every chunk is within reach.

For long documents, the LLM section map (`build_section_map`) provides a
smarter first pass: it asks the LLM which chunks are relevant to which
fields, then `route_fields` uses that mapping instead of heuristics.
This is triggered automatically in the pipeline when the document is
large enough that heuristic routing would be forced to drop content.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from .document_map import Chunk


# Type alias — the map pass returns {field_name: [chunk_index, ...]}
SectionMap = dict[str, list[int]]


@dataclass
class FieldRoute:
    """A field mapped to specific chunks for extraction."""

    field_name: str
    field_spec: dict
    chunks: list[Chunk]
    source: str  # "hint", "signal_inferred", "broadened", "fallback", "section_map"


# ── Generic signal inference ────────────────────────────────────────
# When the schema has no hints, infer what to look for based on field type.
# This is generic, not domain-specific.

TYPE_SIGNAL_MAP = {
    "date": ["has_dates"],
    "number": ["has_dollar_amounts", "has_key_value_pairs"],
    "string": ["has_key_value_pairs"],
    "enum": ["has_key_value_pairs"],
    "array": ["has_tables"],
}


def _score_chunk(chunk: Chunk, field_name: str, field_spec: dict, total_chunks: int = 1) -> float:
    """Score how likely a chunk is to contain a field. Uses schema hints or generic inference."""
    score = 0.0
    hints = field_spec.get("hints", {})

    # ── Hint-based scoring (user-defined, highest priority) ──

    look_in = hints.get("look_in", [])
    if look_in:
        if chunk.category in look_in:
            score += 15.0

    prefer_contains = hints.get("prefer_contains") or []
    if prefer_contains:
        haystack = f"{chunk.title} {chunk.content}".lower()
        for phrase in prefer_contains:
            if isinstance(phrase, str) and phrase and phrase.lower() in haystack:
                score += 15.0
                break

    prefer_position = hints.get("prefer_position")
    if prefer_position:
        # Positional bias: 0-10 point bonus that favors chunks near
        # the requested end of the document. "top" gives max bonus to
        # chunk 0 (the header), decaying linearly; "bottom" is the
        # mirror. Designed for fields like merchant_name (always at
        # the top) or signature blocks (always at the bottom).
        if total_chunks <= 1:
            frac = 0.0
        else:
            frac = chunk.index / (total_chunks - 1)
        if prefer_position == "top":
            score += 10.0 * (1.0 - frac)
        elif prefer_position == "bottom":
            score += 10.0 * frac

    patterns = hints.get("patterns", [])
    if patterns:
        text = f"{chunk.title} {chunk.content[:1500]}".lower()
        for pattern in patterns:
            if re.search(pattern, text, re.IGNORECASE):
                score += 8.0
                break

    signals = hints.get("signals", [])
    if signals:
        for signal in signals:
            if signal in chunk.signals:
                score += 4.0

    # If we had hints and scored, return early — hints are authoritative
    if hints and score > 0:
        return score

    # ── Generic inference (no hints provided) ──

    # Infer useful signals from field type
    field_type = field_spec.get("type", "string")
    inferred_signals = TYPE_SIGNAL_MAP.get(field_type, [])
    for signal in inferred_signals:
        if signal in chunk.signals:
            score += 2.0

    # Field name appears in chunk title or content (fuzzy)
    field_words = field_name.replace("_", " ").lower()
    if field_words in chunk.title.lower():
        score += 6.0
    elif field_words in chunk.content[:500].lower():
        score += 3.0

    # Individual words from field name
    words = field_name.lower().split("_")
    text = f"{chunk.title} {chunk.content[:500]}".lower()
    word_hits = sum(1 for w in words if w in text and len(w) > 2)
    score += word_hits * 1.5

    return score


def _field_max_chunks(field_spec: dict, default: int) -> int:
    """Get the max chunks to route for this field.

    Per-field override via `hints.max_chunks` lets schema authors tell
    the router that a field legitimately needs to aggregate data from
    many chunks. Array-of-objects fields (like a list of policies
    spread across detail sections) often need this.
    """
    hints = field_spec.get("hints") or {}
    override = hints.get("max_chunks")
    if isinstance(override, int) and override > 0:
        return override
    return default


def route_fields(
    schema_def: dict,
    chunks: list[Chunk],
    max_chunks_per_field: int = 3,
    section_map: SectionMap | None = None,
) -> list[FieldRoute]:
    """Route each schema field to the most relevant chunks.

    `max_chunks_per_field` is the default cap. Individual fields can
    override via `hints.max_chunks` in the schema — useful for array
    fields that aggregate data across many detail sections.

    When `section_map` is provided (from `build_section_map`), it takes
    priority: fields use the LLM-assigned chunks directly, with no cap.
    Fields not in the map or mapped to empty lists fall through to the
    heuristic scorer so nothing is silently dropped.
    """
    fields = schema_def.get("fields", {})
    routes: list[FieldRoute] = []
    chunk_by_index = {c.index: c for c in chunks}

    for field_name, field_spec in fields.items():
        has_hints = bool(field_spec.get("hints"))
        field_cap = _field_max_chunks(field_spec, max_chunks_per_field)

        # ── Section map path (LLM-assigned chunks) ──
        if section_map and field_name in section_map and section_map[field_name]:
            mapped_chunks = [
                chunk_by_index[i] for i in section_map[field_name] if i in chunk_by_index
            ]
            if mapped_chunks:
                routes.append(
                    FieldRoute(
                        field_name=field_name,
                        field_spec=field_spec,
                        chunks=mapped_chunks,
                        source="section_map",
                    )
                )
                continue
            # Empty after filtering — fall through to heuristic

        # ── Heuristic path (original scorer) ──

        # look_in is a hard filter when any chunks match — schema authors
        # who declare a category are asserting the field lives there, so a
        # higher-scoring chunk in a different category should not win. Falls
        # back to the full pool when the category is absent from the doc,
        # so the field still gets routed somewhere.
        hints = field_spec.get("hints") or {}
        look_in = hints.get("look_in") or []
        candidate_chunks: list[Chunk] = chunks
        if look_in:
            matches = [c for c in chunks if c.category in look_in]
            if matches:
                candidate_chunks = matches

        # Score every candidate chunk for this field
        total_chunks = len(chunks)
        scored = []
        for chunk in candidate_chunks:
            score = _score_chunk(chunk, field_name, field_spec, total_chunks)
            if score > 0:
                scored.append((score, chunk))

        scored.sort(key=lambda x: x[0], reverse=True)
        top_chunks = [chunk for _, chunk in scored[:field_cap]]

        if top_chunks:
            source = "hint" if has_hints else "signal_inferred"
            routes.append(
                FieldRoute(
                    field_name=field_name,
                    field_spec=field_spec,
                    chunks=top_chunks,
                    source=source,
                )
            )
        else:
            # Nothing matched — broaden to any chunk with generic signals
            broadened = [c for c in chunks if c.signals]
            if broadened:
                routes.append(
                    FieldRoute(
                        field_name=field_name,
                        field_spec=field_spec,
                        chunks=broadened[:field_cap],
                        source="broadened",
                    )
                )
            else:
                # Last resort — first chunks
                routes.append(
                    FieldRoute(
                        field_name=field_name,
                        field_spec=field_spec,
                        chunks=chunks[:field_cap],
                        source="fallback",
                    )
                )

    return routes


def group_routes(routes: list[FieldRoute]) -> list[dict]:
    """Group fields that share the same chunks into extraction groups.
    Minimizes LLM calls — fields from the same chunk get extracted together."""
    groups: list[dict] = []
    used_fields: set[str] = set()

    for route in sorted(routes, key=lambda r: tuple(c.index for c in r.chunks)):
        if route.field_name in used_fields:
            continue

        chunk_indices = frozenset(c.index for c in route.chunks)

        # Find other fields that share the same chunks
        group_fields = [route]
        for other in routes:
            if other.field_name in used_fields or other.field_name == route.field_name:
                continue
            other_indices = frozenset(c.index for c in other.chunks)
            overlap = len(chunk_indices & other_indices) / max(len(chunk_indices), 1)
            if overlap >= 0.5:
                group_fields.append(other)

        # Collect unique chunks
        all_chunks: dict[int, Chunk] = {}
        for field_route in group_fields:
            for chunk in field_route.chunks:
                all_chunks[chunk.index] = chunk

        field_names = [f.field_name for f in group_fields]
        field_specs = {f.field_name: f.field_spec for f in group_fields}

        for name in field_names:
            used_fields.add(name)

        groups.append(
            {
                "fields": field_names,
                "field_specs": field_specs,
                "chunks": list(all_chunks.values()),
            }
        )

    return groups


def summarize_routing(routes: list[FieldRoute]) -> dict:
    """Summarize routing plan for logging."""
    plan = {}
    for route in routes:
        plan[route.field_name] = {
            "chunks": [f"{route.chunks[i].index}: {route.chunks[i].title}" for i in range(len(route.chunks))],
            "source": route.source,
        }
    return plan


# ── LLM Section Map ───────────────────────────────────────────────
#
# For long documents, ask the LLM which chunks contain which fields.
# This replaces the heuristic scorer with a content-aware assignment.


_CHUNK_PREVIEW_CHARS = 400


def _build_section_map_prompt(
    chunks: list[Chunk],
    schema_def: dict,
) -> str:
    """Build the prompt for the LLM section map pass.

    Sends a numbered list of chunk previews and a list of schema fields.
    Asks the LLM to return a JSON mapping of field_name → [chunk_indices].
    """
    fields = schema_def.get("fields", {})

    # Build chunk previews
    chunk_lines = []
    for chunk in chunks:
        preview = chunk.content[:_CHUNK_PREVIEW_CHARS].replace("\n", " ").strip()
        if len(chunk.content) > _CHUNK_PREVIEW_CHARS:
            preview += "..."
        chunk_lines.append(f"  [{chunk.index}] {chunk.title}: {preview}")
    chunk_list = "\n".join(chunk_lines)

    # Build field descriptions
    field_lines = []
    for name, spec in fields.items():
        ftype = spec.get("type", "string")
        desc = spec.get("description", "").strip().split("\n")[0]  # first line only
        field_lines.append(f"  - {name} ({ftype}): {desc}" if desc else f"  - {name} ({ftype})")
    field_list = "\n".join(field_lines)

    field_names = list(fields.keys())

    return f"""You are analyzing a document to determine which sections contain which fields.

## Document sections

{chunk_list}

## Fields to locate

{field_list}

## Instructions

For each field, identify which document sections (by index number) are most likely to contain that field's value. A field may appear in multiple sections, or not at all.

Return ONLY valid JSON — a single object mapping each field name to an array of section indices. If a field is not present in any section, map it to an empty array.

Example format:
{{
  "{field_names[0] if field_names else "field_name"}": [0, 1],
  "{field_names[1] if len(field_names) > 1 else "other_field"}": [3]
}}

JSON:"""


async def build_section_map(
    chunks: list[Chunk],
    schema_def: dict,
    provider: "ModelProvider",
) -> SectionMap | None:
    """Ask the LLM to map fields to chunks for a long document.

    Returns a dict of {field_name: [chunk_indices]} or None if the
    LLM call fails. The caller should fall back to heuristic routing
    when None is returned.
    """
    from .providers import ModelProvider  # avoid circular import at module level

    prompt = _build_section_map_prompt(chunks, schema_def)
    fields = schema_def.get("fields", {})

    try:
        raw = await provider.generate(prompt, json_mode=True)
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            match = re.search(r"\{[\s\S]*\}", raw)
            if match:
                parsed = json.loads(match.group())
            else:
                print("[koji-extract] Section map: LLM returned invalid JSON")
                return None

        if not isinstance(parsed, dict):
            print("[koji-extract] Section map: LLM returned non-object")
            return None

        # Validate and normalize the response
        valid_indices = {c.index for c in chunks}
        section_map: SectionMap = {}
        for field_name in fields:
            indices = parsed.get(field_name, [])
            if not isinstance(indices, list):
                indices = [indices] if isinstance(indices, int) else []
            # Filter to valid chunk indices
            section_map[field_name] = [i for i in indices if isinstance(i, int) and i in valid_indices]

        return section_map

    except Exception as e:
        print(f"[koji-extract] Section map failed: {e}")
        return None


def needs_section_map(chunks: list[Chunk], max_chunks_per_field: int = 3) -> bool:
    """Determine whether a document is large enough to benefit from an LLM section map.

    The map pass adds one LLM call. It's worth it when the heuristic
    router would be forced to drop content — i.e., there are more
    chunks than any single field can see.
    """
    return len(chunks) > max_chunks_per_field * 2
