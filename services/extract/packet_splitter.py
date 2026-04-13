"""Packet splitter — classifies a multi-document packet into typed sections.

An optional pipeline stage between chunking and routing that recognizes
when a single upload contains multiple logically distinct documents
(invoice + COI + policy stapled together, SEC filing + cover letter, etc.)
and splits them into contiguous chunk-range sections so each can be
extracted with the appropriate schema.

Design doc: docs/design/classify-split.md
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field

from .document_map import Chunk
from .providers import ModelProvider

# Reserved type IDs — always valid even if the schema author didn't
# declare them in koji.yaml.
# - `other` is the catch-all the classifier can use when it doesn't
#   recognize a block as one of the declared types.
# - `document` is the fallback type written by the normalizer when the
#   classifier fails entirely (invalid JSON, every section rejected, etc.)
#   and the whole document collapses back to a single section.
_OTHER_TYPE_ID = "other"
_FALLBACK_TYPE_ID = "document"

_CHUNK_PREVIEW_CHARS = 400


@dataclass
class Section:
    """A contiguous chunk range classified as a single document type.

    The splitter produces one Section per distinct document it finds in
    a packet. Each section owns a contiguous range of chunk indices so
    downstream routing and extraction can operate on a slice of the
    original document_map without losing identity.
    """

    type: str
    title: str
    chunk_indices: list[int] = field(default_factory=list)
    confidence: float = 0.0

    @property
    def start_chunk(self) -> int:
        return self.chunk_indices[0] if self.chunk_indices else 0

    @property
    def end_chunk(self) -> int:
        return self.chunk_indices[-1] if self.chunk_indices else 0


def _build_classifier_prompt(chunks: list[Chunk], types: list[dict]) -> str:
    """Build the LLM prompt asking for direct section ranges."""
    type_lines = []
    for t in types:
        if not isinstance(t, dict):
            continue
        type_id = t.get("id")
        if not isinstance(type_id, str) or not type_id.strip():
            continue
        description = (t.get("description") or "").strip() or type_id
        type_lines.append(f"- {type_id}: {description}")
    type_lines.append(f"- {_OTHER_TYPE_ID}: Anything not matching the types above.")
    types_block = "\n".join(type_lines)

    chunk_block = "\n\n".join(f"[{c.index}] {c.title}\n{c.content[:_CHUNK_PREVIEW_CHARS]}" for c in chunks)

    return f"""You're given a document that may be a single item or a packet of several stapled-together documents. Identify each logical document in the packet and return its type and chunk range.

Types:
{types_block}

Rules:
- Each chunk belongs to exactly one section.
- Section ranges must be contiguous (start_chunk to end_chunk, inclusive).
- Sections must not overlap.
- Every chunk in the document must belong to some section — no gaps.
- If unsure about a block, use type "{_OTHER_TYPE_ID}" rather than inventing.

Return JSON in this exact shape:
{{
  "sections": [
    {{"type": "invoice", "start_chunk": 0, "end_chunk": 4, "confidence": 0.96}}
  ]
}}

Chunks to classify:

{chunk_block}
"""


def _parse_classifier_json(raw: str) -> dict | None:
    """Extract the JSON object from the classifier's raw response."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", raw)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                return None
    return None


def _fallback_section(total_chunks: int) -> Section:
    """Single-section fallback covering every chunk.

    Used whenever the classifier fails or returns nothing usable — this
    is the "behave like classify was never enabled for this document"
    escape hatch.
    """
    return Section(
        type=_FALLBACK_TYPE_ID,
        title="Document (classifier fallback)",
        chunk_indices=list(range(total_chunks)),
        confidence=0.0,
    )


def _normalize_classifier_response(
    raw_response: dict | None,
    total_chunks: int,
    valid_type_ids: set[str],
) -> tuple[list[Section], int]:
    """Turn a classifier response into a clean validated list of Sections.

    Handles every failure mode the LLM response can produce:

    1. Invalid JSON / non-dict response: fall back to single section.
    2. Empty `sections` list: fall back.
    3. Section with missing / malformed fields: drop it.
    4. Out-of-range indices (start or end beyond the chunk count, or
       negative): drop the section.
    5. Inverted range (start > end): drop the section.
    6. Overlapping ranges: resolve with first-start-wins (the later
       section's overlap is trimmed off the front; if nothing remains,
       drop it entirely).
    7. Gaps between sections: fill with an `other` section so no chunk
       is orphaned.
    8. Unknown type IDs (type not in valid_type_ids or "other"):
       coerce to `other`.

    Returns (sections, corrections_count) where corrections_count tracks
    how many fixups the normalizer applied — useful observability for
    tuning prompts or spotting a classifier that's going off the rails.
    """
    corrections = 0

    if total_chunks <= 0:
        return ([], 0)

    if not isinstance(raw_response, dict):
        return ([_fallback_section(total_chunks)], 1)

    raw_sections = raw_response.get("sections")
    if not isinstance(raw_sections, list) or not raw_sections:
        return ([_fallback_section(total_chunks)], 1)

    # Step 1: validate each section in isolation.
    validated: list[dict] = []
    for entry in raw_sections:
        if not isinstance(entry, dict):
            corrections += 1
            continue

        stype = entry.get("type")
        start = entry.get("start_chunk")
        end = entry.get("end_chunk")
        conf_raw = entry.get("confidence", 0.0)

        if not isinstance(stype, str) or not stype.strip():
            corrections += 1
            continue
        if not isinstance(start, int) or not isinstance(end, int):
            corrections += 1
            continue
        if start < 0 or end < 0 or start >= total_chunks or end >= total_chunks:
            corrections += 1
            continue
        if start > end:
            corrections += 1
            continue

        if stype not in valid_type_ids and stype != _OTHER_TYPE_ID:
            corrections += 1
            stype = _OTHER_TYPE_ID

        try:
            conf = float(conf_raw)
        except (TypeError, ValueError):
            conf = 0.0
        conf = max(0.0, min(1.0, conf))

        validated.append(
            {
                "type": stype,
                "start": start,
                "end": end,
                "confidence": conf,
            }
        )

    if not validated:
        return ([_fallback_section(total_chunks)], corrections + 1)

    # Step 2: sort by start_chunk and resolve overlaps (first-start-wins).
    validated.sort(key=lambda s: (s["start"], s["end"]))
    cleaned: list[dict] = []
    last_end = -1
    for entry in validated:
        start = entry["start"]
        end = entry["end"]
        if start <= last_end:
            corrections += 1
            new_start = last_end + 1
            if new_start > end:
                # Entirely consumed by a previous section; drop it.
                continue
            entry = {**entry, "start": new_start}
        cleaned.append(entry)
        last_end = entry["end"]

    if not cleaned:
        return ([_fallback_section(total_chunks)], corrections + 1)

    # Step 3: fill gaps with "other" sections so every chunk is claimed.
    with_gaps: list[dict] = []
    cursor = 0
    for entry in cleaned:
        if entry["start"] > cursor:
            corrections += 1
            with_gaps.append(
                {
                    "type": _OTHER_TYPE_ID,
                    "start": cursor,
                    "end": entry["start"] - 1,
                    "confidence": 0.0,
                }
            )
        with_gaps.append(entry)
        cursor = entry["end"] + 1

    if cursor < total_chunks:
        corrections += 1
        with_gaps.append(
            {
                "type": _OTHER_TYPE_ID,
                "start": cursor,
                "end": total_chunks - 1,
                "confidence": 0.0,
            }
        )

    sections = [
        Section(
            type=entry["type"],
            title=f"Section {i} — {entry['type']}",
            chunk_indices=list(range(entry["start"], entry["end"] + 1)),
            confidence=entry["confidence"],
        )
        for i, entry in enumerate(with_gaps)
    ]
    return (sections, corrections)


async def classify_chunks_to_sections(
    chunks: list[Chunk],
    provider: ModelProvider,
    types: list[dict],
) -> tuple[list[Section], dict]:
    """Run the classifier and return (sections, metadata).

    metadata shape:
        - total_sections: int — final section count after normalization
        - elapsed_ms: int — wall time for the classifier call + normalizer
        - normalizer_corrections: int — number of fix-ups applied
        - error: str (optional) — present if the LLM call raised or JSON
          failed to parse, indicating the pipeline fell back to a single
          default section
    """
    start = time.time()

    if not chunks:
        return (
            [],
            {
                "total_sections": 0,
                "elapsed_ms": 0,
                "normalizer_corrections": 0,
            },
        )

    valid_type_ids = {
        t["id"] for t in types if isinstance(t, dict) and isinstance(t.get("id"), str) and t["id"].strip()
    }
    prompt = _build_classifier_prompt(chunks, types)

    raw: str | None = None
    error: str | None = None
    try:
        raw = await provider.generate(prompt, json_mode=True)
    except Exception as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"
        print(f"[koji-classify] Classifier error: {error} — falling back to whole-document section")

    parsed = _parse_classifier_json(raw) if raw is not None else None
    sections, corrections = _normalize_classifier_response(parsed, len(chunks), valid_type_ids)

    metadata: dict = {
        "total_sections": len(sections),
        "elapsed_ms": int((time.time() - start) * 1000),
        "normalizer_corrections": corrections,
    }
    if error is not None:
        metadata["error"] = error
    return (sections, metadata)
