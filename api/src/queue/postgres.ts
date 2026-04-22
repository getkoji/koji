/**
 * Postgres-backed queue using SELECT...FOR UPDATE SKIP LOCKED.
 *
 * Jobs are stored in the background_jobs table. Polling atomically
 * selects and marks jobs as running. Retry uses exponential backoff
 * with jitter.
 */

import { eq, and, lte, inArray, sql } from "drizzle-orm";
import { schema } from "@koji/db";
import type { Db } from "@koji/db";
import type { QueueProvider, QueuedJob, EnqueueOptions, ReapResult, ReapedJob } from "./provider";

const PRIORITY_MAP = { high: 10, normal: 0, low: -10 } as const;
const BASE_BACKOFF_MS = 30_000; // 30 seconds
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000; // 24 hours

export class PostgresQueue implements QueueProvider {
  constructor(private db: Db) {}

  async enqueue(kind: string, payload: object, opts: EnqueueOptions): Promise<string> {
    const priority = PRIORITY_MAP[opts.priority ?? "normal"];

    const [row] = await this.db
      .insert(schema.backgroundJobs)
      .values({
        tenantId: opts.tenantId,
        kind,
        payloadJson: payload,
        priority,
        runAt: opts.runAt ?? new Date(),
        idempotencyKey: opts.idempotencyKey ?? null,
        maxRetries: opts.maxRetries ?? 12,
      })
      .returning({ id: schema.backgroundJobs.id });

    return row!.id;
  }

  async poll(kinds: string[], limit = 1): Promise<QueuedJob[]> {
    // Use raw SQL for FOR UPDATE SKIP LOCKED — Drizzle doesn't support it natively
    const kindsArray = `{${kinds.map((k) => `"${k}"`).join(",")}}`;
    const result = await this.db.execute(sql.raw(`
      UPDATE background_jobs
      SET status = 'running', started_at = NOW(), attempt = attempt + 1
      WHERE id IN (
        SELECT id FROM background_jobs
        WHERE status = 'pending'
          AND run_at <= NOW()
          AND kind = ANY('${kindsArray}')
        ORDER BY priority DESC, created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, kind, payload_json, tenant_id, attempt, max_retries
    `));

    return (result as unknown as Array<{
      id: string;
      kind: string;
      payload_json: Record<string, unknown>;
      tenant_id: string;
      attempt: number;
      max_retries: number;
    }>).map((r) => ({
      id: r.id,
      kind: r.kind,
      payload: r.payload_json,
      tenantId: r.tenant_id,
      attempt: r.attempt,
      // Surface `max_retries` as `maxAttempts` so handlers can tell
      // "this was the last attempt" without another DB round-trip.
      maxAttempts: r.max_retries,
    }));
  }

  async ack(jobId: string): Promise<void> {
    await this.db
      .update(schema.backgroundJobs)
      .set({ status: "succeeded", completedAt: new Date() })
      .where(eq(schema.backgroundJobs.id, jobId));
  }

  async nack(jobId: string, retryable: boolean, errorMessage?: string): Promise<void> {
    if (!retryable) {
      await this.db
        .update(schema.backgroundJobs)
        .set({
          status: "failed_terminal",
          completedAt: new Date(),
          errorMessage: errorMessage ?? null,
        })
        .where(eq(schema.backgroundJobs.id, jobId));
      return;
    }

    // Check if retries exhausted
    const [job] = await this.db
      .select({
        attempt: schema.backgroundJobs.attempt,
        maxRetries: schema.backgroundJobs.maxRetries,
      })
      .from(schema.backgroundJobs)
      .where(eq(schema.backgroundJobs.id, jobId))
      .limit(1);

    if (!job || job.attempt >= job.maxRetries) {
      await this.db
        .update(schema.backgroundJobs)
        .set({
          status: "failed_terminal",
          completedAt: new Date(),
          errorMessage: errorMessage ?? "Max retries exhausted",
        })
        .where(eq(schema.backgroundJobs.id, jobId));
      return;
    }

    // Exponential backoff with jitter
    const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, job.attempt - 1), MAX_BACKOFF_MS);
    const jitter = Math.random() * backoffMs * 0.1; // ±10% jitter
    const runAt = new Date(Date.now() + backoffMs + jitter);

    await this.db
      .update(schema.backgroundJobs)
      .set({
        status: "pending",
        runAt,
        errorMessage: errorMessage ?? null,
      })
      .where(eq(schema.backgroundJobs.id, jobId));
  }

  /**
   * Reclaim jobs stuck in 'running' past the visibility timeout.
   *
   * A job stays 'running' when the worker dies mid-processing (OOM, deploy,
   * container restart). The committed status update from poll() is durable
   * but the handler never acked/nacked.
   *
   * - Under max_retries: reset to 'pending' with backoff so the normal
   *   worker loop retries it. The attempt counter was already bumped by
   *   poll(), so the reaper doesn't touch it.
   * - At/above max_retries: mark 'failed_terminal' and return the job info
   *   so the caller can do domain-level cleanup (e.g. mark orphaned
   *   documents as failed).
   */
  async reapStale(visibilityTimeoutMs: number): Promise<ReapResult> {
    const intervalSec = Math.floor(visibilityTimeoutMs / 1000);

    // 1. Reset retryable stuck jobs
    const retryable = await this.db.execute(sql.raw(`
      UPDATE background_jobs
      SET status = 'pending',
          run_at = NOW() + (interval '30 seconds' * POW(2, LEAST(attempt, 10)))
      WHERE status = 'running'
        AND started_at < NOW() - interval '${intervalSec} seconds'
        AND attempt < max_retries
      RETURNING id
    `));

    // 2. Terminally fail exhausted stuck jobs
    const terminal = await this.db.execute(sql.raw(`
      UPDATE background_jobs
      SET status = 'failed_terminal',
          completed_at = NOW(),
          error_message = 'Worker lost — exceeded visibility timeout after max retries'
      WHERE status = 'running'
        AND started_at < NOW() - interval '${intervalSec} seconds'
        AND attempt >= max_retries
      RETURNING id, kind, payload_json, tenant_id
    `));

    const terminalJobs: ReapedJob[] = (terminal as unknown as Array<{
      id: string;
      kind: string;
      payload_json: Record<string, unknown>;
      tenant_id: string;
    }>).map((r) => ({
      id: r.id,
      kind: r.kind,
      tenantId: r.tenant_id,
      payload: r.payload_json,
    }));

    return {
      retried: (retryable as unknown as unknown[]).length,
      terminal: terminalJobs,
    };
  }
}
