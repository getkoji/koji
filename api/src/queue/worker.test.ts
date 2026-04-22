import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startWorker, TerminalError } from "./worker";
import type { QueueProvider, QueuedJob, ReapResult, ReapedJob } from "./provider";

/**
 * Worker + reaper loop tests using a fake in-memory queue.
 * Uses fake timers to drive the loops without real delays.
 */

function makeFakeQueue(overrides?: {
  pollResult?: QueuedJob[] | (() => Promise<QueuedJob[]>);
  reapResult?: ReapResult;
}): QueueProvider & { reapStale: (ms: number) => Promise<ReapResult> } {
  const pollDefault = overrides?.pollResult ?? [];
  return {
    enqueue: vi.fn().mockResolvedValue("fake-id"),
    poll: typeof pollDefault === "function"
      ? vi.fn().mockImplementation(pollDefault)
      : vi.fn().mockResolvedValue(pollDefault),
    ack: vi.fn().mockResolvedValue(undefined),
    nack: vi.fn().mockResolvedValue(undefined),
    reapStale: vi.fn().mockResolvedValue(
      overrides?.reapResult ?? { retried: 0, terminal: [] },
    ),
  };
}

let stopFn: (() => void) | null = null;

afterEach(() => {
  stopFn?.();
  stopFn = null;
});

describe("worker loop", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("calls handler and acks on success", async () => {
    const job: QueuedJob = {
      id: "j1", kind: "test.job", payload: { foo: "bar" },
      tenantId: "t1", attempt: 1, maxAttempts: 12,
    };

    let polled = false;
    const queue = makeFakeQueue({
      pollResult: async () => {
        if (!polled) { polled = true; return [job]; }
        return [];
      },
    });
    const handler = vi.fn().mockResolvedValue(undefined);

    stopFn = startWorker(queue, { "test.job": handler });
    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledWith(job);
    expect(queue.ack).toHaveBeenCalledWith("j1");
  });

  it("nacks with retryable=true on regular error", async () => {
    const job: QueuedJob = {
      id: "j2", kind: "test.job", payload: {},
      tenantId: "t1", attempt: 1, maxAttempts: 12,
    };

    let polled = false;
    const queue = makeFakeQueue({
      pollResult: async () => {
        if (!polled) { polled = true; return [job]; }
        return [];
      },
    });
    const handler = vi.fn().mockRejectedValue(new Error("transient boom"));

    stopFn = startWorker(queue, { "test.job": handler });
    await vi.advanceTimersByTimeAsync(100);

    expect(queue.nack).toHaveBeenCalledWith("j2", true, "transient boom");
  });

  it("nacks with retryable=false on TerminalError", async () => {
    const job: QueuedJob = {
      id: "j3", kind: "test.job", payload: {},
      tenantId: "t1", attempt: 1, maxAttempts: 12,
    };

    let polled = false;
    const queue = makeFakeQueue({
      pollResult: async () => {
        if (!polled) { polled = true; return [job]; }
        return [];
      },
    });
    const handler = vi.fn().mockRejectedValue(new TerminalError("bad input"));

    stopFn = startWorker(queue, { "test.job": handler });
    await vi.advanceTimersByTimeAsync(100);

    expect(queue.nack).toHaveBeenCalledWith("j3", false, "bad input");
  });
});

describe("reaper loop", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("calls reapStale with visibility timeout after initial delay", async () => {
    const queue = makeFakeQueue();
    stopFn = startWorker(queue, { "test.job": vi.fn() });

    await vi.advanceTimersByTimeAsync(59_000);
    expect(queue.reapStale).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(queue.reapStale).toHaveBeenCalledWith(15 * 60 * 1000);
  });

  it("calls onTerminalReap for each terminally failed job", async () => {
    const terminalJob: ReapedJob = {
      id: "bg-1", kind: "ingestion.process",
      tenantId: "t1", payload: { documentId: "doc-1" },
    };

    const queue = makeFakeQueue({
      reapResult: { retried: 2, terminal: [terminalJob] },
    });

    const onTerminalReap = vi.fn().mockResolvedValue(undefined);
    stopFn = startWorker(queue, { "test.job": vi.fn() }, { onTerminalReap });

    await vi.advanceTimersByTimeAsync(61_000);

    expect(onTerminalReap).toHaveBeenCalledWith(terminalJob);
  });

  it("continues reaping even if onTerminalReap throws", async () => {
    const queue = makeFakeQueue({
      reapResult: {
        retried: 0,
        terminal: [
          { id: "bg-1", kind: "test", tenantId: "t1", payload: {} },
          { id: "bg-2", kind: "test", tenantId: "t1", payload: {} },
        ],
      },
    });

    const onTerminalReap = vi.fn()
      .mockRejectedValueOnce(new Error("cleanup failed"))
      .mockResolvedValueOnce(undefined);

    stopFn = startWorker(queue, { "test.job": vi.fn() }, { onTerminalReap });
    await vi.advanceTimersByTimeAsync(61_000);

    expect(onTerminalReap).toHaveBeenCalledTimes(2);
  });

  it("does not start reaper if queue lacks reapStale", async () => {
    const queue: QueueProvider = {
      enqueue: vi.fn().mockResolvedValue("id"),
      poll: vi.fn().mockResolvedValue([]),
      ack: vi.fn(),
      nack: vi.fn(),
    };

    const onTerminalReap = vi.fn();
    stopFn = startWorker(queue, { "test.job": vi.fn() }, { onTerminalReap });

    await vi.advanceTimersByTimeAsync(120_000);

    expect(onTerminalReap).not.toHaveBeenCalled();
  });
});
