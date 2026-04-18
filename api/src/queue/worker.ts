/**
 * In-process worker loop — polls the queue and executes handlers.
 *
 * Starts N concurrent loops (KOJI_WORKER_CONCURRENCY, default 2).
 * Each loop polls for one job, runs the handler, acks/nacks.
 * Graceful shutdown on SIGTERM: finishes current job, stops polling.
 */

import type { QueueProvider, HandlerMap } from "./provider";

const POLL_INTERVAL_MS = 1500;

export function startWorker(queue: QueueProvider, handlers: HandlerMap): () => void {
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

  function stop() {
    running = false;
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
