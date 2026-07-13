import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the iteration primitive so we test ONLY the loop's control flow
// (stop reasons, apply-and-advance, best-tracking, stuck detection) without
// any parse/extract/LLM. compileSchema (real) still runs on each currentYaml,
// so the proposed YAMLs below are valid schemas.
vi.mock("./tune", () => ({ runTuneIteration: vi.fn() }));
import { runTuneIteration } from "./tune";
import { runTuneLoop } from "./tune-loop";

const mockIter = runTuneIteration as unknown as ReturnType<typeof vi.fn>;

const VALID = "name: t\nfields:\n  a:\n    type: string";
const P1 = "name: t\nfields:\n  a:\n    type: string\n    description: one";
const P2 = "name: t\nfields:\n  a:\n    type: string\n    description: two";

function result(accuracy: number, proposedYaml: string | null) {
  return {
    before: {
      accuracy,
      passed: accuracy >= 100,
      failing: accuracy >= 100 ? [] : [{ name: "a", expected: "x", got: "y", routingHint: "h" }],
    },
    proposedYaml,
    explanation: "expl",
  };
}

const baseArgs = () =>
  ({
    db: {} as never,
    storage: {} as never,
    scope: {} as never,
    tenantId: "t",
    defaultParseProvider: {} as never,
    parseConfig: null,
    entry: { id: "e", filename: "f", storageKey: "k", mimeType: "m", contentHash: "h" },
    groundTruth: { a: "x" },
    startYaml: VALID,
  }) as Parameters<typeof runTuneLoop>[0];

beforeEach(() => mockIter.mockReset());

describe("runTuneLoop control flow", () => {
  it("stops with 'passed' when a scored schema passes; finalYaml is the winning one", async () => {
    // iter1: base scores 80, proposes P1; iter2: P1 scores 100 (passed)
    mockIter.mockResolvedValueOnce(result(80, P1)).mockResolvedValueOnce(result(100, null));
    const r = await runTuneLoop({ ...baseArgs(), maxIterations: 5 });
    expect(r.stopReason).toBe("passed");
    expect(r.iterations).toHaveLength(2);
    expect(r.finalAccuracy).toBe(100);
    expect(r.finalYaml).toBe(P1); // the schema that scored 100 was P1
  });

  it("stops 'stuck_no_proposal' when the model returns no proposal", async () => {
    mockIter.mockResolvedValueOnce(result(50, null));
    const r = await runTuneLoop({ ...baseArgs(), maxIterations: 5 });
    expect(r.stopReason).toBe("stuck_no_proposal");
    expect(r.iterations).toHaveLength(1);
    expect(r.finalYaml).toBe(VALID); // best (and only) schema tried
    expect(r.finalAccuracy).toBe(50);
  });

  it("stops 'stuck_no_improvement' after consecutive non-improving iterations", async () => {
    mockIter
      .mockResolvedValueOnce(result(80, P1))
      .mockResolvedValueOnce(result(80, P2)) // no gain → noImprove=1
      .mockResolvedValueOnce(result(80, P1)); // no gain → noImprove=2 → stop
    const r = await runTuneLoop({ ...baseArgs(), maxIterations: 10 });
    expect(r.stopReason).toBe("stuck_no_improvement");
    expect(r.iterations).toHaveLength(3);
    expect(r.finalAccuracy).toBe(80);
  });

  it("stops 'max_iterations' and returns the best schema seen", async () => {
    // strictly improving but never reaching 100 within the cap of 2
    mockIter.mockResolvedValueOnce(result(70, P1)).mockResolvedValueOnce(result(85, P2));
    const r = await runTuneLoop({ ...baseArgs(), maxIterations: 2 });
    expect(r.stopReason).toBe("max_iterations");
    expect(r.iterations).toHaveLength(2);
    expect(r.finalAccuracy).toBe(85);
    expect(r.finalYaml).toBe(P1); // P1 was the schema scored at the 85 iteration
  });

  it("emits an onIteration callback per iteration and onEdit per applied proposal", async () => {
    mockIter.mockResolvedValueOnce(result(80, P1)).mockResolvedValueOnce(result(100, null));
    const seen: number[] = [];
    const edits: number[] = [];
    await runTuneLoop({
      ...baseArgs(),
      maxIterations: 5,
      onIteration: (it) => { seen.push(it.n); },
      onEdit: (n) => { edits.push(n); },
    });
    expect(seen).toEqual([1, 2]);
    expect(edits).toEqual([1]); // only iter1's proposal was applied (iter2 passed)
  });
});
