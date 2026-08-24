/**
 * Validate scoring — compares extraction results against corpus ground truth
 * and computes per-field accuracy, regressions, and routing diagnosis.
 *
 * Shared by the POST /validate sync path, the read-only GET /validate path,
 * and the async `schema.validate.doc` run finalizer (validate-run.ts). Lives
 * outside routes/schemas.ts so the finalizer can import it without a cycle.
 */

import { compareValues, type ValueDiff } from "../extract/value-compare";

/** Per-field chunk-routing record produced by the intelligent pipeline. */
export type RoutingPlan = Record<
  string,
  { source: string; chunks: Array<{ index: number; title: string }>; text: string }
>;

/** Diagnosis attached to a failing (field, doc) pair to explain *why* it failed. */
export interface RoutingDiagnosis {
  /** How the chunks were selected: hint | signal_inferred | broadened | fallback | full_document. */
  source: string | null;
  /**
   * Whether the ground-truth answer's text appears in the chunks the model was
   * shown. `false` ⇒ a routing miss — the model never saw the answer, so no
   * prompt or model change can fix it; fix the schema `hints`. `true` ⇒ the
   * answer reached the model and it still got it wrong — a prompt/description
   * (or, last resort, model) problem. `null` ⇒ couldn't determine (no routing
   * data, or a non-scalar expected value the heuristic doesn't score).
   */
  answerInRoutedChunks: boolean | null;
  /** The chunks the field was routed to (index + heading), for display. */
  chunks: Array<{ index: number; title: string }>;
}

/** One scored document: ground truth vs what this run extracted for it. */
export interface ValidateDocResult {
  entryId: string;
  filename: string;
  groundTruth: Record<string, unknown>;
  extracted: Record<string, unknown>;
  confidenceScores: Record<string, number>;
  routingPlan?: RoutingPlan;
}

/** A doc that failed to parse/extract and never produced a result. */
export interface ValidateParseFailure {
  entryId: string;
  filename: string;
  error: string;
}

/**
 * Heuristic: does the ground-truth `expected` value appear in `text` (the
 * concatenated content of the chunks the field was routed to)? Numbers match on
 * their digit sequence (tolerating `$`, commas, decimals); strings match as a
 * normalized substring or ≥60% of their significant word tokens. Booleans and
 * complex values return `null` — the routing `source` still applies. Intended as
 * a diagnostic hint, not a hard gate.
 */
export function answerPresentInText(expected: unknown, text: string | undefined): boolean | null {
  if (!text) return null;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const hay = norm(text);
  if (!hay) return null;

  if (typeof expected === "number") {
    const digits = String(expected).replace(/[^0-9]/g, "");
    if (!digits) return null;
    return hay.replace(/[^0-9]/g, "").includes(digits);
  }
  if (typeof expected === "string") {
    const needle = norm(expected);
    if (!needle) return null;
    if (hay.includes(needle)) return true;
    const tokens = needle.split(" ").filter((t) => t.length > 2);
    if (tokens.length === 0) return hay.includes(needle);
    const hits = tokens.filter((t) => hay.includes(t)).length;
    return hits / tokens.length >= 0.6;
  }
  return null;
}

/** Compare extraction results against ground truth and compute accuracy/regressions. */
export function computeValidateResult(
  results: ValidateDocResult[],
  prevExtractedMap: Map<string, Record<string, unknown>>,
  schemaVersion: number,
  startTime: number,
  /**
   * Docs that failed to parse/extract and never made it into `results`. Threaded
   * through so they're visible in the response (`parseFailures`) and counted in
   * `docsTotal` — a dropped doc must not silently inflate accuracy (oss-308).
   * Defaults to `[]` for the GET (read-only) caller that has no failure list.
   */
  parseFailures: ValidateParseFailure[] = [],
  /**
   * Schema field specs, so array fields can be scored with their declared
   * `element_key` (identity matching) and `informational` sub-fields (excluded
   * from scoring), and so precision/recall can be reported per array field.
   * Optional — without it, arrays still get F1 scoring via greedy matching.
   */
  schemaFields?: Record<string, Record<string, unknown>>,
) {
  const allFields = new Set<string>();
  for (const r of results) {
    for (const k of Object.keys(r.groundTruth)) allFields.add(k);
  }

  const fieldResults: Array<{ name: string; accuracy: number; prevAccuracy: number | null; status: string; precision?: number; recall?: number; failingDocs: Array<{ id: string; filename: string; diff: ValueDiff; score: number; confidence: number; routingDiagnosis?: RoutingDiagnosis }> }> = [];
  let totalScore = 0;
  let totalChecked = 0;
  const failingDocsMap = new Map<string, { id: string; filename: string; failedFields: string[]; worstConfidence: number }>();

  for (const fieldName of allFields) {
    const fieldSpec = schemaFields?.[fieldName];
    let scoreSum = 0, checked = 0, prevScoreSum = 0, prevChecked = 0;
    // Precision/recall accumulate only over docs whose expected value is an
    // array, so array fields can report both alongside the F1 accuracy.
    let precSum = 0, recSum = 0, arrChecked = 0;
    const failing: Array<{ id: string; filename: string; diff: ValueDiff; score: number; confidence: number; routingDiagnosis?: RoutingDiagnosis }> = [];

    for (const r of results) {
      const expected = r.groundTruth[fieldName];
      if (expected === undefined || expected === null) continue;
      checked++;
      const cmp = compareValues(expected, r.extracted[fieldName], fieldSpec);
      scoreSum += cmp.score;
      if (cmp.diff.kind === "array") {
        precSum += cmp.diff.precision;
        recSum += cmp.diff.recall;
        arrChecked++;
      }

      if (!cmp.match) {
        const conf = r.confidenceScores[fieldName] ?? 0;
        // Explain the failure: did the answer even reach the model? A routing
        // miss (answerInRoutedChunks=false) is schema-fixable via hints and no
        // model change helps; a hit points at prompt/description instead.
        const route = r.routingPlan?.[fieldName];
        const routingDiagnosis: RoutingDiagnosis | undefined = route
          ? {
              source: route.source,
              answerInRoutedChunks: answerPresentInText(expected, route.text),
              chunks: route.chunks,
            }
          : undefined;
        failing.push({ id: r.entryId, filename: r.filename, diff: cmp.diff, score: cmp.score, confidence: conf, ...(routingDiagnosis ? { routingDiagnosis } : {}) });
        const existing = failingDocsMap.get(r.entryId);
        if (existing) { existing.failedFields.push(fieldName); existing.worstConfidence = Math.min(existing.worstConfidence, conf); }
        else { failingDocsMap.set(r.entryId, { id: r.entryId, filename: r.filename, failedFields: [fieldName], worstConfidence: conf }); }
      }

      const prevExtracted = prevExtractedMap.get(r.entryId);
      if (prevExtracted) {
        prevChecked++;
        prevScoreSum += compareValues(expected, prevExtracted[fieldName], fieldSpec).score;
      }
    }

    const accuracy = checked > 0 ? (scoreSum / checked) * 100 : 100;
    const prevAccuracy = prevChecked > 0 ? (prevScoreSum / prevChecked) * 100 : null;
    totalScore += scoreSum;
    totalChecked += checked;
    // A ground-truth key the schema doesn't declare scores 0% for a reason that
    // has nothing to do with extraction quality: the schema was never asked for
    // it. Reported as its own status so it can't be read as a failing field —
    // and so comparing two schema versions that differ in which fields they
    // declare doesn't look like a −67 point regression (oss-492). Only
    // detectable when the caller passed the schema's field specs.
    const notInSchema = schemaFields !== undefined && fieldSpec === undefined;
    const status = notInSchema
      ? "not_in_schema"
      : failing.length > 0
        ? prevAccuracy !== null && prevAccuracy > accuracy
          ? "regressed"
          : "failing"
        : "pass";
    // Report precision/recall for array fields (mean over docs, as percentages)
    // so a low F1 can be read as "missed elements" (recall) vs "spurious/wrong
    // elements" (precision) — the diagnosis needed on under-counted arrays.
    const prAgg =
      arrChecked > 0
        ? { precision: (precSum / arrChecked) * 100, recall: (recSum / arrChecked) * 100 }
        : {};
    fieldResults.push({ name: fieldName, accuracy, prevAccuracy, status, ...prAgg, failingDocs: failing });
  }

  fieldResults.sort((a, b) => a.accuracy - b.accuracy);
  const overallAccuracy = totalChecked > 0 ? (totalScore / totalChecked) * 100 : 100;

  return {
    overallAccuracy,
    /**
     * How many field-value comparisons this run actually made. Zero means
     * nothing was scored — and `overallAccuracy` reports 100 in that case,
     * because there is nothing failing. A run that measured nothing must not
     * be recorded as a perfect one, so `checkRunSanity` gates on this.
     */
    scoredCount: totalChecked,
    prevAccuracy: null,
    // Attempted docs = scored docs + docs that failed to parse/extract. Counting
    // failures keeps accuracy honest — a dropped doc can't silently shrink the
    // denominator (oss-308).
    docsTotal: results.length + parseFailures.length,
    docsPassed: results.length - failingDocsMap.size,
    fieldCount: fieldResults.length,
    durationMs: Date.now() - startTime,
    costUsd: 0,
    passed: overallAccuracy >= 95,
    schemaVersion,
    ranAt: new Date().toISOString(),
    regressions: fieldResults.filter((f) => f.status === "regressed"),
    fields: fieldResults,
    failingDocs: Array.from(failingDocsMap.values()),
    // Docs that never produced an extraction (parse/storage/extract failure).
    // Additive field — read-only callers omit it and get [].
    parseFailures,
  };
}

export type ValidateResult = ReturnType<typeof computeValidateResult>;

// ---------------------------------------------------------------------------
// Run sanity (oss-500)
// ---------------------------------------------------------------------------

/**
 * A run is only allowed to finalize as `completed` if its result could
 * plausibly be a measurement. Below this many documents, a clean 0% is a
 * believable verdict on a badly-matched schema; at or above it, a clean 0%
 * across every field of every document is much more likely to mean the run
 * measured the wrong thing.
 */
const ZERO_ACCURACY_MIN_DOCS = 5;

/**
 * Reject results that cannot be measurements (oss-500).
 *
 * Returns an operator-facing reason to fail the run, or `null` if it looks
 * like a real result. This exists because a validate run finalized as
 * `completed` on the sole condition that the runner did not throw — no gate on
 * accuracy, on how many fields were scored, or on anything else. In production
 * that recorded two 50-document runs at exactly 0.0000 accuracy as successes,
 * after 248s and 387s of work, and left them to be read as the schema's score.
 * A confidently wrong number is worse than a wide error bar, because it
 * invites no caution.
 *
 * Deliberately NOT gated here: duration. A run that is merely slow is not
 * wrong, and calling it wrong needs a per-schema distribution this function
 * does not have.
 */
export function checkRunSanity(result: {
  overallAccuracy: number;
  scoredCount: number;
  docsTotal: number;
}): string | null {
  if (result.scoredCount === 0) {
    return (
      `Nothing was scored: ${result.docsTotal} document(s) produced no comparable ` +
      `fields. Accuracy is reported as 100% when no comparison is made, so this ` +
      `run would have recorded a perfect score for measuring nothing. Check that ` +
      `the corpus entries carry ground truth and that its keys match the schema's ` +
      `field names.`
    );
  }
  if (result.overallAccuracy === 0 && result.docsTotal >= ZERO_ACCURACY_MIN_DOCS) {
    return (
      `Scored 0.0% across ${result.scoredCount} field comparison(s) on ` +
      `${result.docsTotal} documents. Scoring awards partial credit, so a clean ` +
      `zero at this size is far more often a run that measured the wrong thing — ` +
      `no extractions, the wrong schema version, or ground-truth keys that don't ` +
      `match the schema's fields — than a schema that is perfectly wrong. Failing ` +
      `the run rather than publishing the number; re-run to record a real 0% if ` +
      `that is genuinely the result.`
    );
  }
  return null;
}
