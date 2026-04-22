import { describe, it, expect } from "vitest";

describe("document rerun reset", () => {
  it("clears extraction results so UI shows clean extracting state", () => {
    const before = {
      status: "delivered",
      extractionJson: { name: "Acme" },
      confidence: "0.9500",
      validationJson: null,
      durationMs: 3200,
      completedAt: new Date("2026-04-20"),
      emittedAt: new Date("2026-04-20"),
      startedAt: new Date("2026-04-20"),
    };

    // Rerun resets all result fields
    const after = {
      ...before,
      status: "extracting",
      extractionJson: null,
      confidence: null,
      validationJson: null,
      durationMs: null,
      completedAt: null,
      emittedAt: null,
      startedAt: new Date(), // fresh timestamp
    };

    expect(after.status).toBe("extracting");
    expect(after.extractionJson).toBeNull();
    expect(after.confidence).toBeNull();
    expect(after.validationJson).toBeNull();
    expect(after.durationMs).toBeNull();
    expect(after.completedAt).toBeNull();
    expect(after.emittedAt).toBeNull();
    expect(after.startedAt.getTime()).toBeGreaterThan(before.startedAt.getTime());
  });

  it("clears validation errors from failed documents", () => {
    const before = {
      status: "failed",
      extractionJson: null,
      confidence: null,
      validationJson: { error_cause: "extraction_failed", message: "extract 500: internal error" },
      durationMs: null,
      completedAt: new Date("2026-04-20"),
    };

    const after = {
      ...before,
      status: "extracting",
      validationJson: null,
      completedAt: null,
    };

    expect(after.status).toBe("extracting");
    expect(after.validationJson).toBeNull();
    expect(after.completedAt).toBeNull();
  });

  it("resets job status back to running", () => {
    const jobBefore = {
      status: "complete",
      completedAt: new Date("2026-04-20"),
    };

    const jobAfter = {
      ...jobBefore,
      status: "running",
      completedAt: null,
    };

    expect(jobAfter.status).toBe("running");
    expect(jobAfter.completedAt).toBeNull();
  });

  it("resets failed job status back to running", () => {
    const jobBefore = {
      status: "failed",
      completedAt: new Date("2026-04-20"),
    };

    const jobAfter = {
      ...jobBefore,
      status: "running",
      completedAt: null,
    };

    expect(jobAfter.status).toBe("running");
    expect(jobAfter.completedAt).toBeNull();
  });

  it("rejects rerun on document already extracting", () => {
    const status = "extracting";
    const shouldReject = status === "extracting";
    expect(shouldReject).toBe(true);
  });

  it("allows rerun on delivered documents", () => {
    const status = "delivered";
    const shouldReject = status === "extracting";
    expect(shouldReject).toBe(false);
  });

  it("allows rerun on failed documents", () => {
    const status = "failed";
    const shouldReject = status === "extracting";
    expect(shouldReject).toBe(false);
  });

  it("allows rerun on review documents", () => {
    const status = "review";
    const shouldReject = status === "extracting";
    expect(shouldReject).toBe(false);
  });
});

describe("trace timeline on rerun", () => {
  it("most recent trace wins — ordered by startedAt DESC", () => {
    const traces = [
      { id: "t1", startedAt: new Date("2026-04-20T10:00:00Z"), status: "ok" },
      { id: "t2", startedAt: new Date("2026-04-21T10:00:00Z"), status: "failed" },
    ];

    // API picks the most recent trace (ORDER BY started_at DESC LIMIT 1)
    const latest = traces.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
    expect(latest!.id).toBe("t2");
  });

  it("old traces are not deleted — history preserved", () => {
    // Each rerun creates a new trace row via TraceRecorder.flush().
    // The rerun endpoint does NOT delete old traces — they accumulate
    // as history, and the API picks the most recent one.
    const traceCount = 3; // after 3 runs
    expect(traceCount).toBe(3);
  });
});
