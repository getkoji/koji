"""Phase 2: Field Router — match schema fields to the right chunks using schema hints."""

from __future__ import annotations

import re
from dataclasses import dataclass

from .document_map import Chunk


@dataclass
class FieldRoute:
    """A field mapped to specific chunks for extraction."""

    field_name: str
    field_spec: dict
    chunks: list[Chunk]
    source: str  # "hint", "signal_inferred", "broadened", "fallback"


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


def _score_chunk(chunk: Chunk, field_name: str, field_spec: dict) -> float:
    """Score how likely a chunk is to contain a field. Uses schema hints or generic inference."""
    score = 0.0
    hints = field_spec.get("hints", {})

    # ── Hint-based scoring (user-defined, highest priority) ──

    look_in = hints.get("look_in", [])
    if look_in:
        if chunk.category in look_in:
            score += 15.0

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
) -> list[FieldRoute]:
    """Route each schema field to the most relevant chunks.

    `max_chunks_per_field` is the default cap. Individual fields can
    override via `hints.max_chunks` in the schema — useful for array
    fields that aggregate data across many detail sections.
    """
    fields = schema_def.get("fields", {})
    routes: list[FieldRoute] = []

    for field_name, field_spec in fields.items():
        has_hints = bool(field_spec.get("hints"))
        field_cap = _field_max_chunks(field_spec, max_chunks_per_field)

        # Score every chunk for this field
        scored = []
        for chunk in chunks:
            score = _score_chunk(chunk, field_name, field_spec)
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
