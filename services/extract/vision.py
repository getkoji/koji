"""Vision bypass — skip OCR and send raw page images to the vision model.

When conditions are met (low OCR confidence, short docs, schema hints),
this module bypasses the markdown-based extraction pipeline and sends
page images directly to a multimodal model. The result is the same
shape as the text-based pipeline: extracted fields + confidence scores.

This eliminates OCR error accumulation on thermal prints, handwritten
docs, and other cases where OCR degrades the source signal.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass

from .providers import ModelProvider


@dataclass
class VisionBypassConfig:
    """Parsed from the schema or pipeline YAML's ocr.vision_bypass block."""

    enabled: bool = False
    max_pages: int = 3
    min_ocr_confidence: float = 0.70
    schema_hints: list[str] | None = None  # e.g. ["receipt", "thermal"]

    @classmethod
    def from_dict(cls, raw: dict | None) -> VisionBypassConfig:
        if not raw:
            return cls()
        if not raw.get("enabled", False):
            return cls()

        conditions = raw.get("when", [])
        max_pages = 3
        min_conf = 0.70
        hints: list[str] = []

        for cond in conditions:
            if isinstance(cond, str):
                if "page_count" in cond:
                    m = re.search(r"<=?\s*(\d+)", cond)
                    if m:
                        max_pages = int(m.group(1))
                elif "ocr_confidence" in cond:
                    m = re.search(r"<\s*([\d.]+)", cond)
                    if m:
                        min_conf = float(m.group(1))
            elif isinstance(cond, dict):
                if "schema_hint" in cond:
                    hint = cond["schema_hint"]
                    if isinstance(hint, list):
                        hints.extend(hint)
                    else:
                        hints.append(hint)

        return cls(
            enabled=True,
            max_pages=max_pages,
            min_ocr_confidence=min_conf,
            schema_hints=hints or None,
        )


def should_bypass(
    page_count: int,
    ocr_confidence: float | None,
    schema_def: dict,
    config: VisionBypassConfig,
) -> tuple[bool, str | None]:
    """Evaluate whether to bypass OCR and use vision extraction.

    Returns (should_bypass, reason). Reason is None if no bypass.
    Any single matching condition triggers the bypass.
    """
    if not config.enabled:
        return False, None

    # Condition: page count
    if page_count <= config.max_pages and page_count > 0:
        # Only trigger on page count if another condition also suggests
        # vision is beneficial — page count alone isn't enough.
        pass

    # Condition: low OCR confidence
    if ocr_confidence is not None and ocr_confidence < config.min_ocr_confidence:
        return True, f"ocr_confidence={ocr_confidence:.2f} < {config.min_ocr_confidence}"

    # Condition: schema hint
    schema_hint = schema_def.get("hint")
    if schema_hint and config.schema_hints:
        if isinstance(schema_hint, str):
            schema_hint = [schema_hint]
        for hint in schema_hint:
            if hint.lower() in [h.lower() for h in config.schema_hints]:
                return True, f"schema_hint={hint}"

    return False, None


def estimate_ocr_confidence(markdown: str, page_count: int) -> float:
    """Estimate OCR confidence from the parsed markdown output.

    Heuristic based on:
    - Text density: expected ~500-2000 chars per page for a typical doc
    - Character quality: ratio of printable vs garbage characters
    - Structure: presence of expected patterns (numbers, dates, addresses)

    Returns a float 0.0 to 1.0.
    """
    if not markdown or page_count == 0:
        return 0.0

    chars_per_page = len(markdown) / page_count

    # Very sparse text suggests OCR failure or image-heavy doc
    if chars_per_page < 50:
        return 0.2
    elif chars_per_page < 150:
        return 0.4
    elif chars_per_page < 300:
        return 0.6

    # Check character quality — high ratio of non-printable or unusual
    # characters suggests OCR noise
    printable = sum(1 for c in markdown if c.isprintable() or c in "\n\t")
    quality = printable / len(markdown) if markdown else 0

    # Check for structural patterns that indicate good OCR
    has_numbers = bool(re.search(r"\d{2,}", markdown))
    has_dates = bool(re.search(r"\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}", markdown))
    has_amounts = bool(re.search(r"\$[\d,]+\.?\d*", markdown))
    structure_score = sum([has_numbers, has_dates, has_amounts]) / 3

    confidence = (quality * 0.6) + (min(chars_per_page / 1000, 1.0) * 0.2) + (structure_score * 0.2)
    return round(min(confidence, 1.0), 3)


def _build_vision_prompt(schema_def: dict) -> str:
    """Build the extraction prompt for vision mode."""
    fields = schema_def.get("fields", {})
    field_descriptions = []
    for name, spec in fields.items():
        desc = f"  - {name}"
        if isinstance(spec, dict):
            ftype = spec.get("type", "string")
            desc += f" ({ftype})"
            if spec.get("required"):
                desc += " [required]"
            if spec.get("description"):
                desc += f": {spec['description']}"
        field_descriptions.append(desc)

    return f"""Extract structured data from this document image.

Schema: {schema_def.get("name", "document")}
{schema_def.get("description", "")}

Fields to extract:
{chr(10).join(field_descriptions)}

Return a JSON object with:
- "extracted": a map of field_name → extracted value
- "confidence": a map of field_name → confidence score (0.0 to 1.0)

Only include fields you can confidently identify in the image. For array
fields, return a list of objects matching the items schema. For number
fields, return numeric values without currency symbols.

Return ONLY valid JSON, no markdown fences."""


async def vision_extract(
    page_images: list[str],
    schema_def: dict,
    provider: ModelProvider,
) -> dict:
    """Run extraction via vision model on page images.

    Args:
        page_images: list of base64-encoded PNG page images
        schema_def: the schema definition
        provider: the model provider (must support vision)

    Returns:
        dict with extracted, confidence, confidence_scores keys
        matching the text-based pipeline's output shape.
    """
    start = time.time()
    prompt = _build_vision_prompt(schema_def)

    # Build multimodal message with text + images
    content: list[dict] = [{"type": "text", "text": prompt}]
    for img_b64 in page_images:
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{img_b64}"},
            }
        )

    messages = [{"role": "user", "content": content}]

    # Call the vision model
    response = await provider.chat(messages)
    raw_text = response.get("content", "")

    # Parse the JSON response
    try:
        # Strip markdown fences if present
        cleaned = re.sub(r"```(?:json)?\s*", "", raw_text)
        cleaned = cleaned.strip().rstrip("`")
        result = json.loads(cleaned)
    except json.JSONDecodeError:
        result = {"extracted": {}, "confidence": {}}

    extracted = result.get("extracted", {})
    confidence = result.get("confidence", {})

    # Build confidence_scores in the same shape as the text pipeline
    confidence_scores = {}
    for field_name, conf in confidence.items():
        confidence_scores[field_name] = {
            "score": conf if isinstance(conf, (int, float)) else 0.5,
            "source": "vision",
        }

    elapsed_ms = round((time.time() - start) * 1000)

    return {
        "extracted": extracted,
        "confidence": confidence,
        "confidence_scores": confidence_scores,
        "model": getattr(provider, "model", "unknown"),
        "elapsed_ms": elapsed_ms,
        "vision_bypass": True,
        "ocr_skipped": "vision_bypass",
    }
