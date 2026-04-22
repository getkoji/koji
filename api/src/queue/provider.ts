/**
 * Queue provider interface — abstracts the background job queue.
 *
 * Default implementation: PostgresQueue (SELECT...FOR UPDATE SKIP LOCKED).
 * Platform can swap in CloudflareQueue for hosted deployments.
 */

export interface EnqueueOptions {
  tenantId: string;
  projectId?: string;
  priority?: "high" | "normal" | "low";
  runAt?: Date;
  idempotencyKey?: string;
  maxRetries?: number;
}

export interface QueuedJob {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  tenantId: string;
  /** 1-based attempt counter — incremented at poll time. */
  attempt: number;
  /** Total attempts the queue will make before this job becomes terminal.
   *  Handlers that need to distinguish "fails, will retry" from "fails,
   *  final attempt" (e.g. Deliver stage accounting) compare
   *  `attempt >= maxAttempts`. */
  maxAttempts: number;
}

export interface QueueProvider {
  /** Enqueue a job. Returns the job ID. */
  enqueue(kind: string, payload: object, opts: EnqueueOptions): Promise<string>;

  /** Poll for pending jobs. Returns up to `limit` jobs and marks them running. */
  poll(kinds: string[], limit?: number): Promise<QueuedJob[]>;

  /** Acknowledge successful completion. */
  ack(jobId: string): Promise<void>;

  /** Negative-acknowledge: retry or fail permanently. */
  nack(jobId: string, retryable: boolean, errorMessage?: string): Promise<void>;
}

/** Info returned when the reaper terminally fails a stuck job. */
export interface ReapedJob {
  id: string;
  kind: string;
  tenantId: string;
  payload: Record<string, unknown>;
}

export interface ReapResult {
  /** Number of stuck jobs reset to pending for retry. */
  retried: number;
  /** Jobs that exceeded max retries and were terminally failed. */
  terminal: ReapedJob[];
}

export type HandlerMap = Record<string, (job: QueuedJob) => Promise<void>>;
