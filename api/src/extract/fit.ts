/**
 * Schema-level document-fit check.
 *
 * A third schema-level guard, alongside `intake` (file properties, checked
 * before parsing) and `validation` (extracted values, checked after
 * extraction). `fit` answers a different question entirely: *does this
 * document even belong to this schema?*
 *
 * The motivating case: a user drops a document into a slot in their portal
 * that is bound to one schema, and sometimes drops the wrong document. Rather
 * than let a mismatched document produce a wall of nulls that the user has to
 * squint at and guess about, `fit` returns a structured "this doesn't look
 * right" signal the caller can render directly.
 *
 * Two complementary mechanisms, both schema-declared and fully generic — no
 * document-type knowledge lives in the engine:
 *
 *     fit:
 *       # ── Asserted pre-extraction gate (cheap; can skip extraction) ──
 *       keywords: [policy, insured, premium]        # zero-cost text scan
 *       min_keywords: 2                              # how many must appear (default 1)
 *       requires: "a commercial insurance policy"    # one yes/no LLM call
 *
 *       # ── Derived post-extraction signal (free; reuses provenance) ──
 *       anchor_fields: [policy_number, effective_date]  # default: the required fields
 *       min_score: 0.4                               # misfit below this mean anchor score
 *
 *       # ── Action ──
 *       on_misfit: warn                              # warn (default) | reject
 *
 * The asserted gate runs *before* extraction (so an `on_misfit: reject` schema
 * can skip extraction entirely on a misfit). The derived signal runs *after*
 * extraction and costs nothing: it reuses the per-field provenance grounding
 * already computed for confidence scoring. A document where none of the anchor
 * fields can be grounded in the source is, by that fact, the wrong document.
 */

import type { ModelProvider } from "./providers";

// A field whose grounding score clears this floor counts as "found" in the
// source. Mirrors the "medium" confidence boundary in reconcile.scoreLabel so
// the fit signal lines up with the per-field confidence the caller already sees.
const GROUNDED_FLOOR = 0.4;

// How much source text the LLM assertion sees. The fit question ("is this the
// right kind of document?") is answerable from the opening of a document.
const ASSERTION_EXCERPT_CHARS = 3000;

export type OnMisfit = "warn" | "reject";

export interface FitConfig {
  keywords: string[];
  minKeywords: number;
  requires: string | null;
  /** null → default to the schema's required fields at evaluation time. */
  anchorFields: string[] | null;
  minScore: number;
  onMisfit: OnMisfit;
}

export interface FitCheck {
  name: "keywords" | "assertion" | "derived";
  ok: boolean;
  detail: Record<string, unknown>;
}

export interface FitReport {
  ok: boolean;
  action: OnMisfit;
  reason: string | null;
  message: string | null;
  score: number | null;
  extraction_skipped: boolean;
  checks: FitCheck[];
}

/** True when a pre-extraction check (keyword or assertion) is declared. */
export function hasPreGate(cfg: FitConfig): boolean {
  return cfg.keywords.length > 0 || cfg.requires !== null;
}

/**
 * Parse the `fit` block from a schema. Returns null when none is declared.
 * Invalid sub-values fall back to defaults rather than throwing — a malformed
 * `min_keywords` should weaken the guard, not break extraction.
 */
export function parseFitConfig(schemaDef: Record<string, unknown> | null | undefined): FitConfig | null {
  if (!schemaDef) return null;
  const raw = schemaDef.fit;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).length === 0) return null;

  const keywords = Array.isArray(r.keywords)
    ? r.keywords.map((k) => String(k).trim().toLowerCase()).filter((k) => k.length > 0)
    : [];

  let minKeywords = 1;
  if (typeof r.min_keywords === "number" && Number.isInteger(r.min_keywords) && r.min_keywords >= 1) {
    minKeywords = r.min_keywords;
  }

  const requires =
    typeof r.requires === "string" && r.requires.trim().length > 0 ? r.requires.trim() : null;

  const anchorFields =
    Array.isArray(r.anchor_fields) && r.anchor_fields.length > 0
      ? r.anchor_fields.map((a) => String(a))
      : null;

  let minScore = 0.4;
  if (typeof r.min_score === "number" && r.min_score >= 0 && r.min_score <= 1) {
    minScore = r.min_score;
  }

  const onMisfit: OnMisfit = r.on_misfit === "reject" ? "reject" : "warn";

  return { keywords, minKeywords, requires, anchorFields, minScore, onMisfit };
}

// ── Individual checks ───────────────────────────────────────────────

/** Zero-cost pre-extraction check: do enough declared keywords appear? */
export function checkKeywords(text: string, cfg: FitConfig): FitCheck | null {
  if (cfg.keywords.length === 0) return null;
  const haystack = (text ?? "").toLowerCase();
  const matched = cfg.keywords.filter((kw) => haystack.includes(kw));
  return {
    name: "keywords",
    ok: matched.length >= cfg.minKeywords,
    detail: {
      required: cfg.minKeywords,
      matched: matched.length,
      matched_keywords: matched,
      keywords: cfg.keywords,
    },
  };
}

export function buildAssertionPrompt(excerpt: string, requires: string): string {
  return `You are checking whether a document matches an expected description.

Expected description: ${requires}

Below is the beginning of an uploaded document. Decide whether it matches the
expected description. Judge the document's *kind*, not whether every detail is
present. Respond with ONLY a JSON object:

{"matches": true or false, "reason": "<one short sentence>"}

--- DOCUMENT START ---
${excerpt}
--- DOCUMENT END ---`;
}

/**
 * Parse the assertion call's JSON. Fails open (matches=true) on garbage — a
 * transient model hiccup must not silently reject a legitimate document.
 */
export function parseAssertionResponse(raw: string): { matches: boolean; reason: string | null } {
  if (!raw) return { matches: true, reason: null };
  const text = raw.trim();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { matches: true, reason: "assertion response unparseable; failing open" };
    try {
      data = JSON.parse(match[0]);
    } catch {
      return { matches: true, reason: "assertion response unparseable; failing open" };
    }
  }
  if (!data || typeof data !== "object" || !("matches" in data)) {
    return { matches: true, reason: "assertion response missing 'matches'; failing open" };
  }
  const d = data as Record<string, unknown>;
  return { matches: Boolean(d.matches), reason: typeof d.reason === "string" ? d.reason : null };
}

/**
 * One yes/no LLM call asking whether the document matches `requires`.
 * Fails open: a provider error or garbage response passes (ok=true) so a model
 * outage never blocks ingestion.
 */
export async function checkAssertion(
  excerpt: string,
  cfg: FitConfig,
  provider: ModelProvider,
): Promise<FitCheck | null> {
  if (!cfg.requires) return null;
  const prompt = buildAssertionPrompt(excerpt.slice(0, ASSERTION_EXCERPT_CHARS), cfg.requires);
  let raw: string;
  try {
    raw = await provider.generate(prompt, true);
  } catch (e) {
    return {
      name: "assertion",
      ok: true,
      detail: { requires: cfg.requires, reason: `assertion call failed: ${String(e)}`, errored: true },
    };
  }
  const { matches, reason } = parseAssertionResponse(raw);
  return { name: "assertion", ok: matches, detail: { requires: cfg.requires, reason } };
}

/**
 * Anchor fields for the derived signal. Explicit `anchor_fields` win; otherwise
 * default to the schema's required fields (the fields that must exist in a
 * genuine instance of this document). Fall back to all fields if none required.
 */
function resolveAnchors(cfg: FitConfig, schemaDef: Record<string, unknown>): string[] {
  if (cfg.anchorFields !== null) return cfg.anchorFields;
  const fields = (schemaDef.fields ?? {}) as Record<string, Record<string, unknown>>;
  const required = Object.entries(fields)
    .filter(([, spec]) => spec && typeof spec === "object" && spec.required)
    .map(([name]) => name);
  return required.length > 0 ? required : Object.keys(fields);
}

/**
 * Free post-extraction signal: are the anchor fields grounded in source? Reuses
 * the per-field grounding already computed during confidence scoring. The mean
 * anchor score is the document-fit score; a document whose anchors are uniformly
 * ungrounded (all null / not-found) is the wrong document.
 */
export function checkDerived(
  confidenceScores: Record<string, number>,
  cfg: FitConfig,
  schemaDef: Record<string, unknown>,
): FitCheck | null {
  const anchors = resolveAnchors(cfg, schemaDef);
  if (anchors.length === 0) return null;
  const scores = anchors.map((f) => Number(confidenceScores[f] ?? 0));
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const found = scores.filter((s) => s >= GROUNDED_FLOOR).length;
  return {
    name: "derived",
    ok: mean >= cfg.minScore,
    detail: {
      score: Math.round(mean * 1000) / 1000,
      min_score: cfg.minScore,
      anchors_found: found,
      anchors_total: anchors.length,
      anchor_fields: anchors,
    },
  };
}

// ── Assembly ────────────────────────────────────────────────────────

const REASON_BY_CHECK: Record<string, string> = {
  keywords: "insufficient_keywords",
  assertion: "failed_assertion",
  derived: "low_field_grounding",
};

function messageFor(check: FitCheck, schemaName: string): string {
  const d = check.detail;
  if (check.name === "keywords") {
    return (
      `This does not look like a '${schemaName}' document: expected at least ` +
      `${d.required} of ${JSON.stringify(d.keywords)} but found ${d.matched}.`
    );
  }
  if (check.name === "assertion") {
    const base = `This does not appear to be ${d.requires}.`;
    return d.reason ? `${base} ${d.reason}` : base;
  }
  return (
    `This does not look like a '${schemaName}' document: only ${d.anchors_found} of ` +
    `${d.anchors_total} anchor field(s) (${JSON.stringify(d.anchor_fields)}) were found in the source.`
  );
}

/**
 * Combine evaluated checks into a single report. `ok` is the AND of every
 * declared check; `reason`/`message` come from the first failed check.
 * Pre-extraction checks are passed before the derived check, so a gate failure
 * surfaces ahead of a grounding failure.
 */
export function assembleFit(
  checks: Array<FitCheck | null>,
  cfg: FitConfig,
  schemaName: string,
  extractionSkipped = false,
): FitReport {
  const present = checks.filter((c): c is FitCheck => c !== null);
  const derived = present.find((c) => c.name === "derived");
  const score = derived ? (derived.detail.score as number) : null;

  const failed = present.filter((c) => !c.ok);
  const ok = failed.length === 0;
  const first = failed[0];

  return {
    ok,
    action: cfg.onMisfit,
    reason: first ? REASON_BY_CHECK[first.name]! : null,
    message: first ? messageFor(first, schemaName) : null,
    score,
    extraction_skipped: extractionSkipped,
    checks: present,
  };
}
