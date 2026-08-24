/**
 * Job document counters — current state, not lifetime totals (oss-495).
 *
 * `jobs.docs_processed / docs_passed / docs_failed / docs_reviewing` were each
 * incremented with `+ 1` at every terminal transition and never adjusted when a
 * document was reprocessed or retried. So a document that failed on bad input
 * and later succeeded after a fix stayed counted as failed forever, and a
 * document reprocessed N times incremented `docs_processed` N times.
 *
 * On production this had `docs_processed` (17,246) exceeding `docs_total`
 * (15,826) — the counter claimed more documents than existed — and
 * `docs_failed` reading 194 against 108 documents whose latest attempt had
 * actually failed, overstating the true failure rate by 1.80x. These counters
 * are what `GET /api/pipelines` exposes as docsTotal/docsPassed/docsFailed, so
 * every failure rate read off the CLI or dashboard was wrong the same way.
 *
 * ## Why a recompute rather than a corrected increment
 *
 * The obvious fix — decrement the old bucket when a document moves between
 * terminal states — cannot work here. Every entrypoint marks the document
 * `processing` / `extracting` *before* it starts work, so by the time the
 * outcome is persisted the previous terminal state has already been
 * overwritten and there is nothing left to decrement. Threading the prior
 * status down from each entrypoint would put the invariant in five places and
 * leave already-drifted rows drifted.
 *
 * Counting the documents instead makes the counters a projection of the table
 * that actually holds the truth. It is idempotent, order-independent, correct
 * no matter how a document got to its current state — and it repairs rows that
 * drifted before this existed, on their next write.
 *
 * Jobs hold a handful of documents each (production averages ~1.0), and
 * `documents_job_idx` covers the lookup, so the counting subqueries are
 * cheaper than the round-trip that used to read the row first.
 */
import { sql, type SQL } from "drizzle-orm";

import { schema } from "@koji/db";

/**
 * Document statuses that mean the document reached a terminal state and should
 * be counted as processed. `split` is terminal for the parent of a fan-out: it
 * did finish, but it has no outcome of its own — its children each carry their
 * own outcome and count themselves.
 */
const PROCESSED_STATUSES = ["delivered", "review", "failed", "split"] as const;

function countDocs(jobId: string, predicate: SQL): SQL {
  return sql`(
    SELECT COUNT(*)::int FROM ${schema.documents}
    WHERE ${schema.documents.jobId} = ${jobId} AND ${predicate}
  )`;
}

/**
 * The counter columns for a job, as a `.set()` fragment to merge into whatever
 * update a caller is already making.
 *
 * Returning a fragment rather than running its own statement matters in two
 * ways: the recompute costs no extra round trip, and it composes inside a
 * caller's transaction — the force-fail path reads the counters back in the
 * same transaction to decide whether the job is finished, so a separate
 * statement outside it would read stale values.
 *
 * `docs_total` is deliberately absent: it is the number of documents the job
 * expects, set at ingest and bumped by split fan-out, not a function of
 * current state.
 */
export function jobCounterRecompute(jobId: string): Record<string, SQL> {
  return {
    docsProcessed: countDocs(
      jobId,
      sql`${schema.documents.status} IN ${PROCESSED_STATUSES}`,
    ),
    docsPassed: countDocs(jobId, sql`${schema.documents.status} = 'delivered'`),
    docsFailed: countDocs(jobId, sql`${schema.documents.status} = 'failed'`),
    docsReviewing: countDocs(jobId, sql`${schema.documents.status} = 'review'`),
  };
}
