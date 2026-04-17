"""Chunk classification — label chunks with caller-provided categories.

The module is fully generic. Callers pass in the category list and the
keyword-to-category rules that come from the schema's `categories` block.
No document-type or field-name defaults live here — domain knowledge is
the schema author's territory, not the engine's.
"""

from __future__ import annotations

import asyncio

import httpx

# Type alias: a list of (keywords, category_name) pairs. A chunk matches
# a category when its title contains any keyword, or its title+content
# contains two or more keywords.
KeywordRules = list[tuple[list[str], str]]


def classify_by_keywords(chunk: dict, rules: KeywordRules) -> str | None:
    """Classify a chunk using caller-provided keyword rules.

    Returns the category name or None if no rule fires.
    """
    if not rules:
        return None

    text = f"{chunk['title']} {chunk['content'][:500]}".lower()
    title = chunk["title"].lower()

    for keywords, category in rules:
        matches = sum(1 for kw in keywords if kw in text)
        if matches >= 2:
            return category
        for kw in keywords:
            if kw in title:
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

Section title: {chunk["title"]}
Section content (first 500 chars): {chunk["content"][:500]}

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
    categories: list[str],
    keyword_rules: KeywordRules,
    model: str,
    ollama_url: str,
    max_concurrent: int = 5,
    use_llm: bool = False,
) -> list[dict]:
    """Classify all chunks. Keyword-first, LLM fallback if `use_llm=True`.

    `categories` and `keyword_rules` come from the schema's
    `categories` block — the engine never supplies defaults.
    """
    if not categories:
        return [{**chunk, "category": "other"} for chunk in chunks]

    semaphore = asyncio.Semaphore(max_concurrent)

    classified: list[dict] = []
    llm_needed: list[dict] = []

    for chunk in chunks:
        label = classify_by_keywords(chunk, keyword_rules)
        if label:
            classified.append({**chunk, "category": label})
        else:
            llm_needed.append(chunk)

    print(f"[koji-extract] Classified {len(classified)} by keywords, {len(llm_needed)} unmatched")

    if use_llm and llm_needed:
        print(f"[koji-extract] Running LLM classification on {len(llm_needed)} chunks")
        tasks = [classify_chunk_llm(chunk, categories, model, ollama_url, semaphore) for chunk in llm_needed]
        labels = await asyncio.gather(*tasks)
        for chunk, label in zip(llm_needed, labels):
            classified.append({**chunk, "category": label})
    else:
        for chunk in llm_needed:
            classified.append({**chunk, "category": "other"})

    return classified


def filter_relevant(classified_chunks: list[dict], relevant: set[str]) -> list[dict]:
    """Filter chunks to only those whose category is in `relevant`.

    `relevant` is required. An empty set returns an empty list, which
    gives the caller a clear signal to fall back to the full chunk list.
    """
    filtered = [c for c in classified_chunks if c["category"] in relevant]
    print(f"[koji-extract] Filtered: {len(filtered)} relevant chunks out of {len(classified_chunks)}")
    return filtered
