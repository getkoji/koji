/**
 * Provenance resolution → UI confidence mapping.
 *
 * The extraction pipeline records HOW each field's geometry (bbox) was resolved
 * on every provenance span — the resolution "rung" (see
 * `api/src/extract/provenance.ts` and `docs/parse-spine-model.md`). This module
 * is the single place the dashboard translates that rung into the buckets the
 * UI actually renders, so an exact locate looks different from a best guess and
 * a missing location is surfaced honestly instead of silently dropped.
 *
 * Keep the rung → bucket → label/style mapping HERE. Do not scatter
 * `"fuzzy"` / `"none"` string literals across components.
 */

/** The resolution rung recorded on a provenance span. */
export type ResolutionRung = "anchored" | "offset" | "chunk" | "fuzzy" | "none";

/**
 * The UI-facing confidence bucket a rung collapses into:
 *   - `exact`       — anchored / offset / chunk: matched precisely.
 *   - `approximate` — fuzzy: a best-effort guess at the location.
 *   - `none`        — no location in the source could be matched.
 */
export type SourceConfidence = "exact" | "approximate" | "none";

/**
 * Map a resolution rung to a UI confidence bucket.
 *
 * `anchored` / `offset` / `chunk` → `exact`; `fuzzy` → `approximate`;
 * `none` → `none`.
 *
 * When the rung is absent (legacy provenance written before the rung existed),
 * fall back to `hasSource`: if the span carries any location (bbox / words /
 * page / text offset) treat it as `exact`, otherwise `none`. New provenance
 * always stamps a rung, so the fallback only matters for old records.
 */
export function sourceConfidence(
  resolution: ResolutionRung | string | null | undefined,
  hasSource: boolean,
): SourceConfidence {
  switch (resolution) {
    case "anchored":
    case "offset":
    case "chunk":
      return "exact";
    case "fuzzy":
      return "approximate";
    case "none":
      return "none";
    default:
      return hasSource ? "exact" : "none";
  }
}

/** Short label for the confidence bucket (badge / chip text). */
export const SOURCE_CONFIDENCE_LABEL: Record<SourceConfidence, string> = {
  exact: "Exact source",
  approximate: "Best guess",
  none: "No source located",
};

/** One-line explanation for the confidence bucket (tooltip / title). */
export const SOURCE_CONFIDENCE_DESCRIPTION: Record<SourceConfidence, string> = {
  exact: "This value was matched to an exact location in the source document.",
  approximate:
    "This location is approximate — the value was matched by best-effort text similarity, so the highlight may be off.",
  none: "No location in the source document could be matched to this value.",
};
