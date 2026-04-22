/**
 * In-process worker loop — polls the queue and executes handlers.
 *
 * Starts N concurrent loops (KOJI_WORKER_CONCURRENCY, default 2).
 * Each loop polls for one job, runs the handler, acks/nacks.
 * Graceful shutdown on SIGTERM: finishes current job, stops polling.
 *
 * Also runs a reaper loop that reclaims jobs stuck in 'running' when a
 * worker dies mid-processing. The reaper resets retryable jobs to 'pending'
 * and terminally fails exhausted ones. See PostgresQueue.reapStale().
 */

import type { QueueProvider, HandlerMap, ReapedJob, ReapResult } from "./provider";

const POLL_INTERVAL_MS = 1500;
const REAPER_INTERVAL_MS = 60_000; // 1 minute
const VISIBILITY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

export interface WorkerOptions {
  /**
   * Called for each job the reaper terminally fails (retries exhausted while
   * stuck in 'running'). Use this to clean up domain state — e.g. marking
   * orphaned documents as failed.
   */
  onTerminalReap?: (job: ReapedJob) => Promise<void>;
}

export function startWorker(
  queue: QueueProvider,
  handlers: HandlerMap,
  options?: WorkerOptions,
): () => void {
  const concurrency = parseInt(process.env.KOJI_WORKER_CONCURRENCY ?? "2", 10);
  const kinds = Object.keys(handlers);
  let running = true;

  if (kinds.length === 0) {
    console.log("[worker] No handlers registered, skipping worker start");
    return () => {};
  }

  console.log(`[worker] Starting ${concurrency} worker loop(s) for: ${kinds.join(", ")}`);

  const loops: Promise<void>[] = [];

  for (let i = 0; i < concurrency; i++) {
    loops.push(workerLoop(i));
  }

  // Start the reaper if the queue supports it
  if ('reapStale' in queue && typeof (queue as any).reapStale === 'function') {
    loops.push(reaperLoop(queue as QueueProvider & { reapStale: (ms: number) => Promise<ReapResult> }, options));
    console.log("[worker] Reaper loop started (visibility timeout: 15m, interval: 60s)");
  }

  async function workerLoop(id: number): Promise<void> {
    while (running) {
      try {
        const jobs = await queue.poll(kinds, 1);

        if (jobs.length === 0) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        const job = jobs[0]!;
        const handler = handlers[job.kind];

        if (!handler) {
          console.warn(`[worker-${id}] No handler for kind: ${job.kind}`);
          await queue.nack(job.id, false, `No handler registered for kind: ${job.kind}`);
          continue;
        }

        try {
          await handler(job);
          await queue.ack(job.id);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          const retryable = !(err instanceof TerminalError);
          await queue.nack(job.id, retryable, message);
        }
      } catch (err) {
        // Queue poll error — wait and retry
        console.error(`[worker-${id}] Poll error:`, err);
        await sleep(POLL_INTERVAL_MS * 2);
      }
    }
  }

  async function reaperLoop(
    q: QueueProvider & { reapStale: (ms: number) => Promise<ReapResult> },
    opts?: WorkerOptions,
  ): Promise<void> {
    // Stagger the first run so we don't reap immediately on boot
    await sleep(REAPER_INTERVAL_MS);

    while (running) {
      try {
        const result = await q.reapStale(VISIBILITY_TIMEOUT_MS);

        if (result.retried > 0) {
          console.log(`[reaper] Reset ${result.retried} stuck job(s) to pending`);
        }

        if (result.terminal.length > 0) {
          console.warn(
            `[reaper] Terminally failed ${result.terminal.length} job(s) after max retries:`,
            result.terminal.map((j) => `${j.kind}:${j.id}`).join(", "),
          );

          if (opts?.onTerminalReap) {
            for (const job of result.terminal) {
              try {
                await opts.onTerminalReap(job);
              } catch (err) {
                console.error(
                  `[reaper] onTerminalReap failed for ${job.kind}:${job.id}:`,
                  err instanceof Error ? err.message : err,
                );
              }
            }
          }
        }
      } catch (err) {
        console.error("[reaper] Sweep error:", err instanceof Error ? err.message : err);
      }

      await sleep(REAPER_INTERVAL_MS);
    }
  }

  function stop() {
    running = false;
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    console.log("[worker] Shutting down...");
  }

  // Graceful shutdown
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  return stop;
}

/**
 * Throw this from a handler to indicate the job should NOT be retried.
 */
export class TerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
