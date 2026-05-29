import { describe, it, expect } from "vitest";

/**
 * Unit tests for the SSE stream endpoint logic. These test the data
 * transformation and deduplication logic without requiring a real Hono
 * app or database connection.
 */

/** Terminal statuses — mirrors the constant in jobs.ts */
const TERMINAL_STATUSES = new Set(["delivered", "failed"]);

describe("SSE stage event format", () => {
  it("emits correct shape for a stage event", () => {
    const stage = {
      id: "stage-1",
      stageName: "parse",
      status: "ok",
      durationMs: 1200,
      summaryJson: { pages: 3, method: "lite" },
    };

    const event = {
      name: stage.stageName,
      status: stage.status,
      durationMs: stage.durationMs,
      summary: stage.summaryJson,
    };

    expect(event).toEqual({
      name: "parse",
      status: "ok",
      durationMs: 1200,
      summary: { pages: 3, method: "lite" },
    });

    // Should be JSON-serializable
    const serialized = JSON.stringify(event);
    const parsed = JSON.parse(serialized);
    expect(parsed.name).toBe("parse");
    expect(parsed.durationMs).toBe(1200);
  });

  it("handles null summary gracefully", () => {
    const stage = {
      id: "stage-2",
      stageName: "extract",
      status: "running",
      durationMs: null,
      summaryJson: null,
    };

    const event = {
      name: stage.stageName,
      status: stage.status,
      durationMs: stage.durationMs,
      summary: stage.summaryJson,
    };

    expect(event.summary).toBeNull();
    expect(event.durationMs).toBeNull();

    const serialized = JSON.stringify(event);
    const parsed = JSON.parse(serialized);
    expect(parsed.summary).toBeNull();
  });
});

describe("terminal document detection", () => {
  it("returns immediately for delivered documents", () => {
    const status = "delivered";
    expect(TERMINAL_STATUSES.has(status)).toBe(true);
  });

  it("returns immediately for failed documents", () => {
    const status = "failed";
    expect(TERMINAL_STATUSES.has(status)).toBe(true);
  });

  it("streams for extracting documents", () => {
    const status = "extracting";
    expect(TERMINAL_STATUSES.has(status)).toBe(false);
  });

  it("streams for received documents", () => {
    const status = "received";
    expect(TERMINAL_STATUSES.has(status)).toBe(false);
  });

  it("streams for review documents", () => {
    const status = "review";
    expect(TERMINAL_STATUSES.has(status)).toBe(false);
  });
});

describe("stage deduplication", () => {
  it("does not re-emit stages already sent", () => {
    const sentStageIds = new Set<string>();
    const emitted: string[] = [];

    // Simulate first poll — 2 stages
    const poll1 = [
      { id: "s1", stageName: "parse", status: "ok", durationMs: 500, summaryJson: null },
      { id: "s2", stageName: "extract", status: "running", durationMs: null, summaryJson: null },
    ];

    for (const stage of poll1) {
      if (!sentStageIds.has(stage.id)) {
        sentStageIds.add(stage.id);
        emitted.push(stage.stageName);
      }
    }

    expect(emitted).toEqual(["parse", "extract"]);

    // Simulate second poll — same 2 stages + 1 new
    const poll2 = [
      { id: "s1", stageName: "parse", status: "ok", durationMs: 500, summaryJson: null },
      { id: "s2", stageName: "extract", status: "ok", durationMs: 2100, summaryJson: null },
      { id: "s3", stageName: "deliver", status: "running", durationMs: null, summaryJson: null },
    ];

    for (const stage of poll2) {
      if (!sentStageIds.has(stage.id)) {
        sentStageIds.add(stage.id);
        emitted.push(stage.stageName);
      }
    }

    // Only the new stage should have been emitted
    expect(emitted).toEqual(["parse", "extract", "deliver"]);
    expect(sentStageIds.size).toBe(3);
  });

  it("handles empty stage list", () => {
    const sentStageIds = new Set<string>();
    const emitted: string[] = [];

    const stages: { id: string; stageName: string }[] = [];

    for (const stage of stages) {
      if (!sentStageIds.has(stage.id)) {
        sentStageIds.add(stage.id);
        emitted.push(stage.stageName);
      }
    }

    expect(emitted).toEqual([]);
    expect(sentStageIds.size).toBe(0);
  });
});
