"""Chunk classification — quickly label chunks to filter before extraction."""

from __future__ import annotations

import asyncio
import json
import re

import httpx


# Common insurance document section types
DEFAULT_CATEGORIES = [
    "declarations",
    "schedule_of_coverages",
    "endorsement",
    "conditions",
    "definitions",
    "exclusions",
    "boilerplate",
    "table_of_contents",
    "other",
]

# Keywords that can classify without hitting the LLM
KEYWORD_RULES: list[tuple[list[str], str]] = [
    (["declaration", "dec page", "named insured", "policy period"], "declarations"),
    (["schedule of", "coverage schedule", "limits of"], "schedule_of_coverages"),
    (["endorsement", "amendment", "rider"], "endorsement"),
    (["conditions", "general conditions", "policy conditions"], "conditions"),
    (["definitions", "defined terms", "as used in"], "definitions"),
    (["exclusion", "does not apply", "we will not"], "exclusions"),
    (["table of contents", "index"], "table_of_contents"),
]


def classify_by_keywords(chunk: dict) -> str | None:
    """Try to classify a chunk using simple keyword matching. Returns None if uncertain."""
    text = f"{chunk['title']} {chunk['content'][:500]}".lower()

    for keywords, category in KEYWORD_RULES:
        matches = sum(1 for kw in keywords if kw in text)
        if matches >= 2:
            return category
        # Title match is strong signal
        for kw in keywords:
            if kw in chunk["title"].lower():
                return category

    return None


async def classify_chunk_llm(
    chunk: dict,
    categories: list[str],
    model: str,
    ollama_url: str,
    semaphore: asyncio.Semaphore,
) -> str:
    """Classify a chunk using the LLM. Fast — just returns a label."""
    cats = ", ".join(categories)
    prompt = f"""Classify this document section into exactly one category.

Categories: {cats}

Section title: {chunk['title']}
Section content (first 500 chars): {chunk['content'][:500]}

Return ONLY the category name, nothing else."""

    async with semaphore:
        async with httpx.AsyncClient(timeout=60) as client:
            try:
                resp = await client.post(
                    f"{ollama_url}/api/generate",
                    json={
                        "model": model,
                        "prompt": prompt,
                        "stream": False,
                        "options": {
                            "temperature": 0,
                            "num_predict": 20,
                        },
                    },
                )
                if resp.status_code == 200:
                    result = resp.json()
                    label = result.get("response", "").strip().lower()
                    # Fuzzy match to valid categories
                    for cat in categories:
                        if cat in label or label in cat:
                            return cat
                    return "other"
            except Exception as e:
                print(f"[koji-extract] Classify error: {e}")
                return "other"

    return "other"


async def classify_chunks(
    chunks: list[dict],
    categories: list[str] | None,
    model: str,
    ollama_url: str,
    max_concurrent: int = 5,
    use_llm: bool = False,
) -> list[dict]:
    """Classify all chunks. Uses keywords first. LLM fallback only if use_llm=True."""
    cats = categories or DEFAULT_CATEGORIES
    semaphore = asyncio.Semaphore(max_concurrent)

    classified = []
    llm_needed = []

    # First pass: keyword classification (instant, free)
    for chunk in chunks:
        label = classify_by_keywords(chunk)
        if label:
            classified.append({**chunk, "category": label})
        else:
            llm_needed.append(chunk)

    print(f"[koji-extract] Classified {len(classified)} by keywords, {len(llm_needed)} unmatched")

    if use_llm and llm_needed:
        # LLM classification for uncertain chunks (requires decent compute)
        print(f"[koji-extract] Running LLM classification on {len(llm_needed)} chunks")
        tasks = [
            classify_chunk_llm(chunk, cats, model, ollama_url, semaphore)
            for chunk in llm_needed
        ]
        labels = await asyncio.gather(*tasks)
        for chunk, label in zip(llm_needed, labels):
            classified.append({**chunk, "category": label})
    else:
        # Keywords only — label everything else as "other"
        for chunk in llm_needed:
            classified.append({**chunk, "category": "other"})

    return classified


# Which categories are relevant for extraction (vs boilerplate/legal text)
RELEVANT_CATEGORIES = {
    "declarations",
    "schedule_of_coverages",
    "endorsement",
}


def filter_relevant(
    classified_chunks: list[dict],
    relevant: set[str] | None = None,
) -> list[dict]:
    """Filter chunks to only those relevant for extraction."""
    relevant_cats = relevant or RELEVANT_CATEGORIES
    filtered = [c for c in classified_chunks if c["category"] in relevant_cats]
    print(f"[koji-extract] Filtered: {len(filtered)} relevant chunks out of {len(classified_chunks)}")
    return filtered
