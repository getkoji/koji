/**
 * Classifier validate scoring (oss-451, minimal).
 *
 * Given the per-document predictions of a classifier validate run, compute the
 * run-level result. This is intentionally minimal — overall accuracy + the
 * counts. The rich diagnostic (per-class precision/recall, the confusion
 * matrix, the tier histogram) lands in oss-452, which reads the same stored
 * `classifier_run_docs` rows and enriches `resultJson`.
 *
 * Pure and unit-tested — no DB.
 */

/** One scored document: what the corpus asserted vs what the cascade predicted. */
export interface ClassifyDocResult {
  corpusEntryId: string;
  status: "ok" | "failed";
  expectedLabel: string | null;
  predictedLabel: string | null;
  tierUsed: number | null;
  errorMessage?: string | null;
}

export interface ClassifierValidateResult {
  docsTotal: number;
  /** Predicted label equals the ground-truth label. */
  docsCorrect: number;
  /** Cascade errored (provider out, unreadable bytes) — excluded from accuracy. */
  docsFailed: number;
  /** docsCorrect / (docsTotal − docsFailed), as a percentage, or null if none scored. */
  accuracy: number | null;
  /** Placeholder for the oss-452 confusion matrix + per-class metrics. */
  byClass: null;
}

/**
 * Score a run. A doc is *correct* when it ran and its predicted label matches
 * the expected label exactly (`unknown` vs `unknown` counts as correct — the
 * corpus can assert a document should fall through). Failed docs are counted
 * but excluded from the accuracy denominator: a provider outage is not a
 * classification error, and folding it into accuracy would hide config quality
 * behind infra noise.
 */
export function computeClassifierResult(docRows: ClassifyDocResult[]): ClassifierValidateResult {
  const docsTotal = docRows.length;
  let docsFailed = 0;
  let docsCorrect = 0;
  for (const d of docRows) {
    if (d.status !== "ok") {
      docsFailed++;
      continue;
    }
    if (d.expectedLabel !== null && d.predictedLabel === d.expectedLabel) docsCorrect++;
  }
  const scored = docsTotal - docsFailed;
  const accuracy = scored > 0 ? (docsCorrect / scored) * 100 : null;
  return { docsTotal, docsCorrect, docsFailed, accuracy, byClass: null };
}
