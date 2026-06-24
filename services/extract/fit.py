"""Schema-level document-fit check.

A third schema-level guard, alongside `intake` (file properties, checked
before parsing) and `validation` (extracted values, checked after
extraction). `fit` answers a different question entirely: *does this
document even belong to this schema?*

The motivating case: a user drops a document into a slot in their portal
that is bound to one schema, and sometimes drops the wrong document. Rather
than let a mismatched document produce a wall of nulls that the user has to
squint at and guess about, `fit` returns a structured "this doesn't look
right" signal the caller can render directly.

Two complementary mechanisms, both schema-declared and fully generic — no
document-type knowledge lives in the engine:

    fit:
      # ── Asserted pre-extraction gate (cheap; can skip extraction) ──
      keywords: [policy, insured, premium]        # zero-cost text scan
      min_keywords: 2                              # how many must appear (default 1)
      requires: "a commercial insurance policy"    # one yes/no LLM call

      # ── Derived post-extraction signal (free; reuses provenance) ──
      anchor_fields: [policy_number, effective_date]  # default: the required fields
      min_score: 0.4                               # misfit below this mean anchor score

      # ── Action ──
      on_misfit: warn                              # warn (default) | reject

The two mechanisms are independent — declare either, both, or neither.

* The **asserted gate** runs *before* extraction. The keyword check is pure
  Python and free; the `requires` assertion is a single yes/no LLM call. When
  `on_misfit: reject` and a pre-extraction check fails, extraction is skipped
  entirely (no extraction cost) and the response carries `fit.ok = false`.

* The **derived signal** runs *after* extraction and costs nothing: it reuses
  the per-field provenance grounding already computed for confidence scoring.
  A document where none of the anchor fields can be grounded in the source is,
  by that very fact, the wrong document.

`on_misfit: warn` (the default) never blocks: the document is always
extracted and the fit signal rides along so the caller decides. `reject`
short-circuits the pre-extraction gate and flags the response for the caller
to discard.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

# A field whose grounding score clears this floor is considered "found" in the
# source. Mirrors the "medium" confidence label boundary in pipeline.py so the
# fit signal lines up with the confidence the caller already sees per field.
_GROUNDED_FLOOR = 0.4

# How much source text the LLM assertion gets to look at. The fit question
# ("is this the right kind of document?") is answerable from the opening of a
# document; sending the whole thing would just burn tokens.
_ASSERTION_EXCERPT_CHARS = 3000


@dataclass(frozen=True)
class FitConfig:
    """Parsed `fit:` block from a schema. ``None`` when no block is present."""

    keywords: tuple[str, ...] = ()
    min_keywords: int = 1
    requires: str | None = None
    anchor_fields: tuple[str, ...] | None = None
    min_score: float = 0.4
    on_misfit: str = "warn"  # "warn" | "reject"

    @property
    def has_pre_gate(self) -> bool:
        """True when a pre-extraction check (keyword or assertion) is declared."""
        return bool(self.keywords) or self.requires is not None

    @classmethod
    def from_schema(cls, schema_def: dict | None) -> FitConfig | None:
        """Parse the `fit` block. Returns None when the schema declares none.

        Invalid sub-values fall back to their defaults rather than raising —
        a malformed `min_keywords` should weaken the guard, not break
        extraction outright.
        """
        if not schema_def:
            return None
        raw = schema_def.get("fit")
        if not isinstance(raw, dict) or not raw:
            return None

        keywords = tuple(str(k).strip().lower() for k in raw.get("keywords", []) if str(k).strip())

        min_keywords = raw.get("min_keywords")
        if not isinstance(min_keywords, int) or isinstance(min_keywords, bool) or min_keywords < 1:
            min_keywords = 1

        requires = raw.get("requires")
        requires = requires.strip() if isinstance(requires, str) and requires.strip() else None

        anchors_raw = raw.get("anchor_fields")
        if isinstance(anchors_raw, list) and anchors_raw:
            anchor_fields: tuple[str, ...] | None = tuple(str(a) for a in anchors_raw)
        else:
            anchor_fields = None

        min_score = raw.get("min_score")
        if not isinstance(min_score, (int, float)) or isinstance(min_score, bool) or not (0.0 <= min_score <= 1.0):
            min_score = 0.4

        on_misfit = raw.get("on_misfit")
        if on_misfit not in ("warn", "reject"):
            on_misfit = "warn"

        return cls(
            keywords=keywords,
            min_keywords=min_keywords,
            requires=requires,
            anchor_fields=anchor_fields,
            min_score=float(min_score),
            on_misfit=on_misfit,
        )


@dataclass
class FitCheck:
    """One evaluated check (`keywords` | `assertion` | `derived`)."""

    name: str
    ok: bool
    detail: dict


@dataclass
class FitReport:
    ok: bool = True
    action: str = "warn"  # echoes FitConfig.on_misfit
    checks: list[FitCheck] = field(default_factory=list)
    reason: str | None = None
    message: str | None = None
    score: float | None = None
    extraction_skipped: bool = False

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "action": self.action,
            "reason": self.reason,
            "message": self.message,
            "score": self.score,
            "extraction_skipped": self.extraction_skipped,
            "checks": [{"name": c.name, "ok": c.ok, "detail": c.detail} for c in self.checks],
        }


# ── Individual checks ───────────────────────────────────────────────


def check_keywords(text: str, cfg: FitConfig) -> FitCheck | None:
    """Zero-cost pre-extraction check: do enough declared keywords appear?"""
    if not cfg.keywords:
        return None
    haystack = (text or "").lower()
    matched = [kw for kw in cfg.keywords if kw in haystack]
    ok = len(matched) >= cfg.min_keywords
    return FitCheck(
        name="keywords",
        ok=ok,
        detail={
            "required": cfg.min_keywords,
            "matched": len(matched),
            "matched_keywords": matched,
            "keywords": list(cfg.keywords),
        },
    )


def build_assertion_prompt(excerpt: str, requires: str) -> str:
    """Prompt for the single yes/no document-fit assertion call."""
    return f"""You are checking whether a document matches an expected description.

Expected description: {requires}

Below is the beginning of an uploaded document. Decide whether it matches the
expected description. Judge the document's *kind*, not whether every detail is
present. Respond with ONLY a JSON object:

{{"matches": true or false, "reason": "<one short sentence>"}}

--- DOCUMENT START ---
{excerpt}
--- DOCUMENT END ---"""


def _parse_assertion_response(raw: str) -> tuple[bool, str | None]:
    """Parse the assertion call's JSON. Fail-open (matches=True) on garbage.

    A transient model hiccup must not silently reject a legitimate document —
    same principle as the classifier-error escape hatch in pipeline.py. When we
    can't read a clear "no", we let the document through and say so.
    """
    if not raw:
        return True, None
    text = raw.strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", text)
        if not match:
            return True, "assertion response unparseable; failing open"
        try:
            data = json.loads(match.group())
        except json.JSONDecodeError:
            return True, "assertion response unparseable; failing open"
    if not isinstance(data, dict) or "matches" not in data:
        return True, "assertion response missing 'matches'; failing open"
    return bool(data.get("matches")), (data.get("reason") if isinstance(data.get("reason"), str) else None)


async def check_assertion(excerpt: str, cfg: FitConfig, provider) -> FitCheck | None:
    """One yes/no LLM call asking whether the document matches `requires`.

    Fails open: if the provider raises or returns garbage, the check passes
    (ok=True) so a model outage never blocks ingestion.
    """
    if not cfg.requires:
        return None
    prompt = build_assertion_prompt(excerpt[:_ASSERTION_EXCERPT_CHARS], cfg.requires)
    try:
        raw = await provider.generate(prompt, json_mode=True)
    except Exception as e:  # noqa: BLE001 — fail-open is deliberate (see docstring)
        return FitCheck(
            name="assertion",
            ok=True,
            detail={"requires": cfg.requires, "reason": f"assertion call failed: {e}", "errored": True},
        )
    matches, reason = _parse_assertion_response(raw)
    return FitCheck(
        name="assertion",
        ok=matches,
        detail={"requires": cfg.requires, "reason": reason},
    )


def _resolve_anchors(cfg: FitConfig, schema_def: dict) -> tuple[str, ...]:
    """Anchor fields for the derived signal.

    Explicit `anchor_fields` win. Otherwise default to the schema's required
    fields (the fields that *must* exist in a genuine instance of this
    document). If nothing is marked required, fall back to all fields.
    """
    if cfg.anchor_fields is not None:
        return cfg.anchor_fields
    fields = schema_def.get("fields", {})
    required = tuple(f for f, spec in fields.items() if isinstance(spec, dict) and spec.get("required"))
    return required or tuple(fields.keys())


def check_derived(
    confidence_scores: dict,
    cfg: FitConfig,
    schema_def: dict,
) -> FitCheck | None:
    """Free post-extraction signal: are the anchor fields grounded in source?

    Reuses the per-field grounding already computed during confidence scoring.
    The mean anchor score is the document-fit score; a document whose anchors
    are uniformly ungrounded (all null / not-found) is the wrong document.
    """
    anchors = _resolve_anchors(cfg, schema_def)
    if not anchors:
        return None
    scores = [float(confidence_scores.get(f, 0.0)) for f in anchors]
    mean = sum(scores) / len(scores) if scores else 0.0
    found = sum(1 for s in scores if s >= _GROUNDED_FLOOR)
    ok = mean >= cfg.min_score
    return FitCheck(
        name="derived",
        ok=ok,
        detail={
            "score": round(mean, 3),
            "min_score": cfg.min_score,
            "anchors_found": found,
            "anchors_total": len(anchors),
            "anchor_fields": list(anchors),
        },
    )


# ── Assembly ────────────────────────────────────────────────────────

_REASON_BY_CHECK = {
    "keywords": "insufficient_keywords",
    "assertion": "failed_assertion",
    "derived": "low_field_grounding",
}


def _message_for(check: FitCheck, schema_name: str) -> str:
    """Human-readable, domain-agnostic explanation for a failed check."""
    d = check.detail
    if check.name == "keywords":
        return (
            f"This does not look like a '{schema_name}' document: expected at least "
            f"{d['required']} of {d['keywords']} but found {d['matched']}."
        )
    if check.name == "assertion":
        base = f"This does not appear to be {d['requires']}."
        return f"{base} {d['reason']}" if d.get("reason") else base
    # derived
    return (
        f"This does not look like a '{schema_name}' document: only {d['anchors_found']} of "
        f"{d['anchors_total']} anchor field(s) ({d['anchor_fields']}) were found in the source."
    )


def assemble(
    checks: list[FitCheck | None],
    cfg: FitConfig,
    schema_name: str,
    *,
    extraction_skipped: bool = False,
) -> FitReport:
    """Combine evaluated checks into a single report.

    `ok` is the AND of every declared check. When something failed, the
    report's `reason`/`message` come from the first failed check (pre-extraction
    checks are appended before the derived check, so a gate failure surfaces
    ahead of a grounding failure).
    """
    present = [c for c in checks if c is not None]
    derived = next((c for c in present if c.name == "derived"), None)
    score = derived.detail["score"] if derived else None

    failed = [c for c in present if not c.ok]
    ok = not failed
    reason = _REASON_BY_CHECK.get(failed[0].name) if failed else None
    message = _message_for(failed[0], schema_name) if failed else None

    return FitReport(
        ok=ok,
        action=cfg.on_misfit,
        checks=present,
        reason=reason,
        message=message,
        score=score,
        extraction_skipped=extraction_skipped,
    )
