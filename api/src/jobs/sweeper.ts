/**
 * Stuck-job sweeper — finds Koji-level jobs (schema.jobs) that have been
 * in 'running' state too long without progress and transitions them to
 * 'failed', emitting webhook + in-app notification events.
 *
 * Distinct from the queue reaper in queue/worker.ts: that one resets stuck
 * QUEUE rows (workers that died holding a job lock). This one watches
 * APPLICATION jobs — the user-visible pipeline runs in schema.jobs. A job
 * row can sit in 'running' even when the queue is healthy if (e.g.) the
 * ingestion handler crashes between popping work and ack-ing it.
 *
 * Stuck definitions (any one triggers a sweep):
 *   - status='running' AND startedAt < now - HARD_MAX_MS (default 30m).
 *     Catches "running forever" regardless of progress.
 *   - status='running' AND startedAt < now - NO_PROGRESS_MS (default 10m)
 *     AND docs_processed = 0. Catches the common "stuck before any
 *     document moved" case while giving real batches a generous window.
 *
 * Default sweep interval is 60s, matching the queue reaper cadence. Each
 * sweep runs as a single SQL query against the jobs table — RLS is NOT
 * applied because the sweeper is a system process, not a tenant request.
 * The result rows include tenant_id so events emit to the right tenant.
 */

import { sql } from "drizzle-orm";

import type { Db } from "@koji/db";
import { schema } from "@koji/db";

import { createNotification } from "../notifications/emit";
import { emitWebhookEvent } from "../webhooks/emit";

/** Maximum time a job can sit in 'running' before being swept regardless of progress. */
export const HARD_MAX_MS = 30 * 60 * 1000;
/** Time before a zero-progress job is considered stuck. */
export const NO_PROGRESS_MS = 10 * 60 * 1000;
/** Default sweep cadence. */
export const SWEEP_INTERVAL_MS = 60_000;

export interface StuckJobRow {
  id: string;
  tenantId: string;
  slug: string;
  startedAt: Date;
  docsProcessed: number;
  docsTotal: number;
}

/**
 * Run one sweep pass: detect stuck jobs, transition them to 'failed',
 * emit events. Returns the count of jobs that were swept.
 *
 * Failures of individual event emissions are caught and logged — they
 * never block the status transition or hold up other sweeps.
 */
export async function sweepStuckJobs(
  db: Db,
  now: Date = new Date(),
  opts: { hardMaxMs?: number; noProgressMs?: number } = {},
): Promise<number> {
  const hardMaxMs = opts.hardMaxMs ?? HARD_MAX_MS;
  const noProgressMs = opts.noProgressMs ?? NO_PROGRESS_MS;
  const hardCutoff = new Date(now.getTime() - hardMaxMs);
  const noProgressCutoff = new Date(now.getTime() - noProgressMs);

  // Single UPDATE … RETURNING transitions matching rows AND hands us the
  // payload to emit events with. Two predicates joined by OR mirror the
  // doc above.
  const stuck = (await db.execute(sql`
    UPDATE jobs
    SET status = 'failed',
        completed_at = ${now},
        updated_at = ${now}
    WHERE status = 'running'
      AND started_at IS NOT NULL
      AND (
        started_at < ${hardCutoff}
        OR (started_at < ${noProgressCutoff} AND docs_processed = 0)
      )
    RETURNING id, tenant_id, project_id, slug, started_at, docs_processed, docs_total
  `)) as unknown as Array<{
    id: string;
    tenant_id: string;
    project_id: string;
    slug: string;
    started_at: Date;
    docs_processed: number;
    docs_total: number;
  }>;

  if (stuck.length === 0) return 0;

  for (const row of stuck) {
    const ageMs = now.getTime() - row.started_at.getTime();
    const reason =
      row.docs_processed === 0
        ? `Job stuck before making progress (${Math.round(ageMs / 60_000)}m running, 0 of ${row.docs_total} docs processed)`
        : `Job exceeded max running time (${Math.round(ageMs / 60_000)}m, ${row.docs_processed} of ${row.docs_total} docs processed)`;

    try {
      await emitWebhookEvent({ tenantId: row.tenant_id, projectId: row.project_id }, "job.failed", {
        job_id: row.id,
        slug: row.slug,
        reason,
        docs_processed: row.docs_processed,
        docs_total: row.docs_total,
      });
    } catch (err) {
      console.warn(
        `[sweeper] webhook emit failed for job ${row.id}:`,
        err instanceof Error ? err.message : err,
      );
    }

    createNotification({ tenantId: row.tenant_id, projectId: row.project_id }, {
      type: "job.failed",
      title: `Job failed: ${row.slug}`,
      body: reason,
      data: {
        jobId: row.id,
        slug: row.slug,
        docsProcessed: row.docs_processed,
        docsTotal: row.docs_total,
      },
    });

    console.warn(`[sweeper] Failed stuck job ${row.id}: ${reason}`);
  }

  return stuck.length;
}

/**
 * Start a sweeper loop. Returns a stop function that ends the loop cleanly.
 *
 * The loop staggers its first run by SWEEP_INTERVAL_MS so newly-booted
 * APIs don't sweep on first cold start (before any job has had time to
 * make progress).
 */
export function startStuckJobSweeper(
  db: Db,
  opts: { intervalMs?: number; hardMaxMs?: number; noProgressMs?: number } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? SWEEP_INTERVAL_MS;
  let running = true;

  (async () => {
    await sleep(intervalMs);
    while (running) {
      try {
        const swept = await sweepStuckJobs(db, new Date(), {
          hardMaxMs: opts.hardMaxMs,
          noProgressMs: opts.noProgressMs,
        });
        if (swept > 0) {
          console.warn(`[sweeper] Swept ${swept} stuck job(s)`);
        }
      } catch (err) {
        console.error(
          "[sweeper] Sweep failed:",
          err instanceof Error ? err.message : err,
        );
      }
      await sleep(intervalMs);
    }
  })();

  return () => {
    running = false;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
