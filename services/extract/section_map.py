"""Two-pass section map — lightweight LLM outline before extraction.

For documents with many chunks, a first-pass LLM call scans chunk
titles and previews to build a structural outline. The map tells the
router which chunks belong to which document sections, improving
field routing accuracy for large, complex documents.

The section map is cheap: it sends only titles and first lines (not
full content), so it uses a fraction of the tokens the main extraction
call requires. It runs only when the chunk count exceeds a threshold.

Schema authors can opt out by setting `section_map: false` in the
schema, or tune the threshold via `section_map.threshold`.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from .document_map import Chunk

# Documents with fewer chunks than this skip the section map pass.
DEFAULT_THRESHOLD = 10

# Maximum preview chars per chunk sent to the LLM for mapping.
_PREVIEW_CHARS = 150


@dataclass
class SectionMapEntry:
    """A section in the document outline."""

    label: str
    chunk_indices: list[int] = field(default_factory=list)
    description: str = ""


@dataclass
class SectionMap:
    """The structural outline of a document."""

    sections: list[SectionMapEntry] = field(default_factory=list)

    def label_for_chunk(self, chunk_index: int) -> str | None:
        """Return the section label for a chunk, or None if unmapped."""
        for section in self.sections:
            if chunk_index in section.chunk_indices:
                return section.label
        return None

    def chunks_for_label(self, label: str) -> list[int]:
        """Return chunk indices for a given section label."""
        label_lower = label.lower()
        for section in self.sections:
            if section.label.lower() == label_lower:
                return section.chunk_indices
        return []


def _build_outline_prompt(chunks: list[Chunk], schema_def: dict) -> str:
    """Build the LLM prompt for section map generation."""
    field_names = list((schema_def.get("fields") or {}).keys())
    schema_name = schema_def.get("name", "document")

    chunk_lines = []
    for chunk in chunks:
        preview = chunk.content[:_PREVIEW_CHARS].replace("\n", " ").strip()
        if len(chunk.content) > _PREVIEW_CHARS:
            preview += "..."
        chunk_lines.append(f"  [{chunk.index}] {chunk.title or '(no title)'}: {preview}")

    return f"""Analyze this document's structure. The document is a "{schema_name}" with {len(chunks)} sections.

Document outline (chunk index, title, preview):
{chr(10).join(chunk_lines)}

Fields we need to extract: {", ".join(field_names[:30])}

Return a JSON array of sections. Each section groups consecutive chunks that belong together.
For each section, provide:
- "label": a short descriptive name (e.g. "header", "line_items", "payment_terms", "signatures")
- "chunks": array of chunk indices (integers) that belong to this section
- "description": one-line summary of what this section contains

Rules:
- Every chunk index (0 to {len(chunks) - 1}) must appear in exactly one section
- Sections should be contiguous where possible
- Use 3-8 sections for most documents
- Labels should be lowercase_snake_case

Return ONLY the JSON array, no markdown fences."""


def parse_section_map(raw: str, total_chunks: int) -> SectionMap:
    """Parse LLM response into a SectionMap, handling common formatting issues."""
    # Strip markdown code fences if present
    cleaned = re.sub(r"```(?:json)?\s*", "", raw).strip()
    cleaned = re.sub(r"```\s*$", "", cleaned).strip()

    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        return SectionMap()

    if not isinstance(parsed, list):
        return SectionMap()

    sections = []
    seen_indices: set[int] = set()

    for entry in parsed:
        if not isinstance(entry, dict):
            continue
        label = str(entry.get("label", "unknown")).strip().lower().replace(" ", "_")
        chunk_indices = entry.get("chunks", [])
        description = str(entry.get("description", ""))

        # Validate and deduplicate indices
        valid_indices = []
        for idx in chunk_indices:
            if isinstance(idx, int) and 0 <= idx < total_chunks and idx not in seen_indices:
                valid_indices.append(idx)
                seen_indices.add(idx)

        if valid_indices:
            sections.append(
                SectionMapEntry(
                    label=label,
                    chunk_indices=valid_indices,
                    description=description,
                )
            )

    # Assign any unmapped chunks to an "other" section
    unmapped = [i for i in range(total_chunks) if i not in seen_indices]
    if unmapped:
        sections.append(
            SectionMapEntry(
                label="other",
                chunk_indices=unmapped,
                description="Unmapped chunks",
            )
        )

    return SectionMap(sections=sections)


async def build_section_map(
    chunks: list[Chunk],
    schema_def: dict,
    provider,
) -> SectionMap | None:
    """Build a section map for a document using a lightweight LLM call.

    Returns None if the document is too small to benefit from mapping
    or if the schema opts out.
    """
    # Check opt-out and threshold
    section_map_config = schema_def.get("section_map")
    if section_map_config is False:
        return None

    threshold = DEFAULT_THRESHOLD
    if isinstance(section_map_config, dict):
        threshold = int(section_map_config.get("threshold", DEFAULT_THRESHOLD))

    if len(chunks) < threshold:
        return None

    prompt = _build_outline_prompt(chunks, schema_def)

    try:
        response = await provider.generate(prompt, json_mode=True)
    except Exception:
        # Section map is best-effort; extraction proceeds without it
        return None

    return parse_section_map(response, len(chunks))


def apply_section_labels(chunks: list[Chunk], section_map: SectionMap) -> None:
    """Annotate chunks with section labels from the map.

    Adds a `section_label` key to each chunk's signals dict so the
    router can use it for scoring.
    """
    for chunk in chunks:
        label = section_map.label_for_chunk(chunk.index)
        if label:
            chunk.signals["section_label"] = label
