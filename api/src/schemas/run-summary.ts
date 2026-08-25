/**
 * Summarising a version's validate runs (oss-508).
 *
 * A schema version's accuracy used to be read off ONE run — the most recent
 * completed one (`ORDER BY created_at DESC LIMIT 1`). Validate accuracy is not
 * deterministic: replicate runs of the same version over the same corpus differ
 * by around 1.5 points, and roughly 6% of production runs land more than five
 * points from their own group's median. Reporting a single draw means one
 * unlucky run becomes the number a customer reads — and in production
 * `policy_generic` displayed version 1 at 67.80%, recorded after two version-3
 * runs in the same minute.
 *
 * The median is reported instead, with `n` and the observed spread, so a figure
 * carries its own uncertainty. Runs are never mixed across versions: each
 * version is summarised from its own runs only.
 */

/** Accuracy is stored as a `decimal(6,4)` in 0..1, which Drizzle returns as a string. */
export interface RunAccuracy {
  accuracy: string | null;
  regressionsCount: number | null;
  createdAt: Date;
}

export interface RunSummary {
  /** Median accuracy over the version's completed runs, in 0..1, or null when it has none. */
  accuracy: string | null;
  /** How many completed runs the median is over. 0 when the version was never validated. */
  accuracyRuns: number;
  /** Lowest and highest accuracy observed for this version — the spread behind the median. */
  accuracyMin: string | null;
  accuracyMax: string | null;
  /**
   * Regression count from the representative run — the one at the median, so
   * the accuracy and the regression count describe the same run rather than
   * two different ones.
   */
  regressions: number | null;
}

/** Format back to the column's own precision so the API's shape doesn't drift. */
function fmt(n: number): string {
  return n.toFixed(4);
}

/**
 * Median accuracy over a version's completed runs, plus the spread it hides.
 *
 * With an even number of runs the lower of the two middle values is taken as
 * the representative run rather than averaging them — an average is not a run,
 * and `regressions` has to come from an actual one.
 */
export function summarizeRuns(runs: RunAccuracy[]): RunSummary {
  const scored = runs
    .filter((r) => r.accuracy !== null && Number.isFinite(Number(r.accuracy)))
    .map((r) => ({ value: Number(r.accuracy), regressionsCount: r.regressionsCount }))
    .sort((a, b) => a.value - b.value);

  if (scored.length === 0) {
    return {
      accuracy: null,
      accuracyRuns: 0,
      accuracyMin: null,
      accuracyMax: null,
      regressions: null,
    };
  }

  const mid = Math.floor((scored.length - 1) / 2);
  const representative = scored[mid]!;
  return {
    accuracy: fmt(representative.value),
    accuracyRuns: scored.length,
    accuracyMin: fmt(scored[0]!.value),
    accuracyMax: fmt(scored[scored.length - 1]!.value),
    regressions: representative.regressionsCount,
  };
}
