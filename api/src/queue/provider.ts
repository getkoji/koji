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
  attempt: number;
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

export type HandlerMap = Record<string, (job: QueuedJob) => Promise<void>>;
