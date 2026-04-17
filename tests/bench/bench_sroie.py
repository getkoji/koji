"""SROIE receipt benchmark — vision bypass vs text extraction.

Runs a sample of SROIE receipt images through koji serve's /extract
endpoint with vision bypass enabled and disabled, then compares field-
level accuracy against ground truth.

Usage:
    python tests/bench/bench_sroie.py [--n 20] [--vision-only] [--text-only]

Requires:
    - OPENAI_API_KEY set in environment
    - koji serve running (or use --direct to call the pipeline in-process)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path

# Add repo root to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from services.extract.vision import VisionBypassConfig, vision_extract
from services.extract.providers import create_provider


SROIE_DIR = Path(__file__).parent / "sroie" / "sroie-repo" / "data"
SCHEMA_PATH = Path(__file__).parent / "receipt_schema.yaml"


def load_ground_truth(key_path: Path) -> dict:
    with open(key_path) as f:
        return json.load(f)


def normalize_value(v: str) -> str:
    """Normalize a value for comparison."""
    v = str(v).strip().lower()
    # Normalize whitespace
    v = re.sub(r"\s+", " ", v)
    return v


def normalize_date(v: str) -> str | None:
    """Parse a date string into YYYY-MM-DD for comparison."""
    import re
    v = str(v).strip()

    # DD/MM/YYYY or DD-MM-YYYY
    m = re.match(r"(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})", v)
    if m:
        return f"{m.group(3)}-{m.group(2).zfill(2)}-{m.group(1).zfill(2)}"

    # YYYY-MM-DD (already ISO)
    m = re.match(r"(\d{4})-(\d{1,2})-(\d{1,2})", v)
    if m:
        return f"{m.group(1)}-{m.group(2).zfill(2)}-{m.group(3).zfill(2)}"

    # MM/DD/YYYY
    m = re.match(r"(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})", v)
    if m:
        return f"{m.group(3)}-{m.group(1).zfill(2)}-{m.group(2).zfill(2)}"

    return None


def score_field(field_name: str, expected: str, actual: str | None) -> tuple[bool, float]:
    """Score a single field extraction. Returns (match, score)."""
    if actual is None or str(actual).strip() == "":
        return False, 0.0

    # Date comparison — normalize to ISO before comparing
    if field_name == "date":
        exp_date = normalize_date(expected)
        act_date = normalize_date(str(actual))
        if exp_date and act_date and exp_date == act_date:
            return True, 1.0
        return False, 0.0

    # Numeric comparison — handle formatting (9.00 vs 9.0 vs 9)
    if field_name == "total":
        try:
            exp_num = float(re.sub(r"[^\d.]", "", str(expected)))
            act_num = float(re.sub(r"[^\d.]", "", str(actual)))
            if abs(exp_num - act_num) < 0.02:
                return True, 1.0
        except (ValueError, TypeError):
            pass
        return False, 0.0

    # String comparison (company, address)
    exp = normalize_value(expected)
    act = normalize_value(str(actual))

    if exp == act:
        return True, 1.0

    # Fuzzy: one contains the other
    if exp in act or act in exp:
        return True, 0.8

    return False, 0.0


def _image_to_base64(file_path: str) -> list[str]:
    """Read an image file as base64 — inline to avoid docling import."""
    import base64
    with open(file_path, "rb") as f:
        return [base64.b64encode(f.read()).decode("ascii")]


async def run_vision_extract(image_path: str, schema_def: dict) -> dict:
    """Run vision extraction on a single image."""
    images = _image_to_base64(image_path)
    provider = create_provider("openai/gpt-4o-mini")
    result = await vision_extract(images, schema_def, provider)
    return result.get("extracted", {})


async def run_text_extract(image_path: str, schema_def: dict) -> dict:
    """Run text extraction (OCR → markdown → LLM)."""
    import asyncio
    import functools
    from services.parse.main import _convert_sync

    # Parse to markdown
    try:
        parse_result = await asyncio.get_event_loop().run_in_executor(
            None, functools.partial(_convert_sync, image_path),
        )
        markdown = parse_result.get("markdown", "")
    except Exception:
        markdown = ""

    if not markdown or len(markdown.strip()) < 10:
        return {}

    try:
        from services.extract.pipeline import intelligent_extract
        result = await intelligent_extract(markdown, schema_def, model="openai/gpt-4o-mini")
        return result.get("extracted", {})
    except Exception as e:
        print(f"  text extract error: {e}")
        return {}


async def benchmark(n: int = 20, run_vision: bool = True, run_text: bool = True):
    """Run the benchmark on n SROIE images."""
    import yaml

    with open(SCHEMA_PATH) as f:
        schema_def = yaml.safe_load(f)

    img_dir = SROIE_DIR / "img"
    key_dir = SROIE_DIR / "key"

    # Get first n images that have ground truth
    samples = []
    for img_file in sorted(img_dir.glob("*.jpg"))[:n * 2]:
        key_file = key_dir / f"{img_file.stem}.json"
        if key_file.exists():
            samples.append((img_file, key_file))
        if len(samples) >= n:
            break

    print(f"\nSROIE Receipt Benchmark — {len(samples)} images")
    print("=" * 60)

    results = {"vision": [], "text": []}

    for i, (img_path, key_path) in enumerate(samples):
        gt = load_ground_truth(key_path)
        print(f"\n[{i+1}/{len(samples)}] {img_path.name}")
        print(f"  GT: company={gt.get('company','')[:30]}, total={gt.get('total')}")

        if run_vision:
            t0 = time.time()
            try:
                vision_result = await run_vision_extract(str(img_path), schema_def)
                elapsed = round(time.time() - t0, 1)
                print(f"  Vision ({elapsed}s): company={str(vision_result.get('company',''))[:30]}, total={vision_result.get('total')}")
            except Exception as e:
                vision_result = {}
                elapsed = round(time.time() - t0, 1)
                print(f"  Vision ({elapsed}s): ERROR {e}")

            field_scores = {}
            for field in ["company", "date", "address", "total"]:
                if field in gt:
                    match, score = score_field(field, gt[field], str(vision_result.get(field, "")))
                    field_scores[field] = score
            results["vision"].append({
                "file": img_path.name,
                "scores": field_scores,
                "avg": sum(field_scores.values()) / max(len(field_scores), 1),
                "elapsed": elapsed,
            })

        if run_text:
            t0 = time.time()
            try:
                text_result = await run_text_extract(str(img_path), schema_def)
                elapsed = round(time.time() - t0, 1)
                print(f"  Text  ({elapsed}s): company={str(text_result.get('company',''))[:30]}, total={text_result.get('total')}")
            except Exception as e:
                text_result = {}
                elapsed = round(time.time() - t0, 1)
                print(f"  Text  ({elapsed}s): ERROR {e}")

            field_scores = {}
            for field in ["company", "date", "address", "total"]:
                if field in gt:
                    match, score = score_field(field, gt[field], str(text_result.get(field, "")))
                    field_scores[field] = score
            results["text"].append({
                "file": img_path.name,
                "scores": field_scores,
                "avg": sum(field_scores.values()) / max(len(field_scores), 1),
                "elapsed": elapsed,
            })

    # Print summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)

    for method in ["vision", "text"]:
        if not results[method]:
            continue
        entries = results[method]
        avg_accuracy = sum(e["avg"] for e in entries) / len(entries)
        avg_elapsed = sum(e["elapsed"] for e in entries) / len(entries)

        field_avgs = {}
        for field in ["company", "date", "address", "total"]:
            scores = [e["scores"].get(field, 0) for e in entries if field in e["scores"]]
            if scores:
                field_avgs[field] = sum(scores) / len(scores)

        print(f"\n{method.upper()} PATH:")
        print(f"  Overall accuracy: {avg_accuracy:.1%}")
        print(f"  Avg latency:      {avg_elapsed:.1f}s")
        for field, avg in field_avgs.items():
            print(f"  {field:15s}   {avg:.1%}")

    # Write results JSON
    out_path = Path(__file__).parent / "sroie_results.json"
    with open(out_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nDetailed results → {out_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--n", type=int, default=20, help="Number of images to test")
    parser.add_argument("--vision-only", action="store_true")
    parser.add_argument("--text-only", action="store_true")
    args = parser.parse_args()

    asyncio.run(benchmark(
        n=args.n,
        run_vision=not args.text_only,
        run_text=not args.vision_only,
    ))
