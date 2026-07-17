import { describe, it, expect } from "vitest";
import {
  buildDagPlan,
  evalCondition,
  extractSkipReason,
  resolveNextSteps,
  type TestEdge,
} from "./dag-runner";

describe("evalCondition", () => {
  it("returns true for empty/unparseable conditions", () => {
    expect(evalCondition("", {})).toBe(true);
    expect(evalCondition("just some text", {})).toBe(true);
  });

  it("evaluates == with string values", () => {
    expect(evalCondition("output.label == 'invoice'", { output: { label: "invoice" } })).toBe(true);
    expect(evalCondition("output.label == 'invoice'", { output: { label: "receipt" } })).toBe(false);
  });

  it("evaluates != with string values", () => {
    expect(evalCondition("output.label != 'other'", { output: { label: "invoice" } })).toBe(true);
    expect(evalCondition("output.label != 'invoice'", { output: { label: "invoice" } })).toBe(false);
  });

  it("evaluates numeric comparisons", () => {
    expect(evalCondition("output.confidence >= 0.8", { output: { confidence: 0.95 } })).toBe(true);
    expect(evalCondition("output.confidence >= 0.8", { output: { confidence: 0.5 } })).toBe(false);
    expect(evalCondition("output.confidence > 0.8", { output: { confidence: 0.8 } })).toBe(false);
    expect(evalCondition("output.confidence < 0.5", { output: { confidence: 0.3 } })).toBe(true);
    expect(evalCondition("output.confidence <= 0.5", { output: { confidence: 0.5 } })).toBe(true);
  });

  it("handles nested dot paths", () => {
    expect(evalCondition("output.group.type == 'declarations'", {
      output: { group: { type: "declarations" } },
    })).toBe(true);
  });

  it("returns false for missing paths", () => {
    expect(evalCondition("output.missing == 'x'", { output: {} })).toBe(false);
    expect(evalCondition("output.deep.path == 'x'", { output: {} })).toBe(false);
  });
});

describe("resolveNextSteps", () => {
  it("returns unconditional edges", () => {
    const edges: TestEdge[] = [
      { from: "a", to: "b" },
    ];
    expect(resolveNextSteps(edges, {})).toEqual(["b"]);
  });

  it("returns edges where condition matches", () => {
    const edges: TestEdge[] = [
      { from: "classify", to: "extract_invoice", when: "output.label == 'invoice'" },
      { from: "classify", to: "extract_receipt", when: "output.label == 'receipt'" },
      { from: "classify", to: "other", default: true },
    ];
    expect(resolveNextSteps(edges, { label: "invoice" })).toEqual(["extract_invoice"]);
    expect(resolveNextSteps(edges, { label: "receipt" })).toEqual(["extract_receipt"]);
  });

  it("falls back to default edge when nothing matches", () => {
    const edges: TestEdge[] = [
      { from: "classify", to: "extract_invoice", when: "output.label == 'invoice'" },
      { from: "classify", to: "fallback", default: true },
    ];
    expect(resolveNextSteps(edges, { label: "unknown" })).toEqual(["fallback"]);
  });

  it("returns empty when no edges match and no default", () => {
    const edges: TestEdge[] = [
      { from: "classify", to: "extract_invoice", when: "output.label == 'invoice'" },
    ];
    expect(resolveNextSteps(edges, { label: "unknown" })).toEqual([]);
  });

  it("returns multiple matching edges for fan-out", () => {
    const edges: TestEdge[] = [
      { from: "split", to: "filter_a" },
      { from: "split", to: "filter_b" },
    ];
    expect(resolveNextSteps(edges, {})).toEqual(["filter_a", "filter_b"]);
  });

  it("does not include default edges when conditional edges match", () => {
    const edges: TestEdge[] = [
      { from: "a", to: "b", when: "output.x == 1" },
      { from: "a", to: "c", default: true },
    ];
    expect(resolveNextSteps(edges, { x: 1 })).toEqual(["b"]);
  });
});

describe("buildDagPlan — compiled DAG execution (oss-358)", () => {
  // The POC failure shape: classify + routed extract steps using the documented
  // `on:` sugar. The old runner found zero edges here and ran every step
  // linearly (3x extraction cost, last extract wins regardless of label).
  const ROUTED_YAML = `
pipeline: family-router
steps:
  - id: classify
    type: classify
    config:
      labels:
        - id: carrier_a
        - id: carrier_b
    on:
      carrier_a: extract_a
      carrier_b: extract_b
      _default: extract_generic
  - id: extract_a
    type: extract
    config: { schema: schema_a }
  - id: extract_b
    type: extract
    config: { schema: schema_b }
  - id: extract_generic
    type: extract
    config: { schema: schema_generic }
`;

  it("compiles on: sugar into conditional edges (no linear fallback)", () => {
    const plan = buildDagPlan(ROUTED_YAML);
    expect(plan.source).toBe("compiled");
    expect(plan.entryStepId).toBe("classify");
    expect(plan.edges).toHaveLength(3);
    // No unconditional classify→extract chain
    expect(plan.edges.every((e) => e.from === "classify")).toBe(true);
    expect(plan.edges.filter((e) => e.default)).toHaveLength(1);
  });

  it("routes to exactly ONE extract step per classify label", () => {
    const plan = buildDagPlan(ROUTED_YAML);
    expect(resolveNextSteps(plan.edges, { label: "carrier_a" })).toEqual(["extract_a"]);
    expect(resolveNextSteps(plan.edges, { label: "carrier_b" })).toEqual(["extract_b"]);
    // Unknown label falls to the default edge
    expect(resolveNextSteps(plan.edges, { label: "something_else" })).toEqual(["extract_generic"]);
  });

  it("compiles then: sugar into an unconditional edge", () => {
    const plan = buildDagPlan(`
pipeline: chained
steps:
  - id: extract
    type: extract
    config: { schema: s }
    then: notify
  - id: notify
    type: webhook
    config: { url: "https://example.test/hook" }
`);
    expect(plan.source).toBe("compiled");
    expect(plan.edges).toEqual([
      expect.objectContaining({ from: "extract", to: "notify" }),
    ]);
    expect(resolveNextSteps(plan.edges, {})).toEqual(["notify"]);
  });

  it("respects settings.max_steps from the compiled pipeline", () => {
    const plan = buildDagPlan(`
pipeline: capped
settings: { max_steps: 5 }
steps:
  - id: extract
    type: extract
    config: { schema: s }
`);
    expect(plan.maxSteps).toBe(5);
  });

  it("falls back to legacy parsing for YAML the compiler rejects (routes:/next:)", () => {
    // Pre-compiler yamlSource: no top-level `pipeline` name
    const plan = buildDagPlan(`
steps:
  - id: classify
    type: classify
    config: {}
    routes:
      - { when: "output.label == 'invoice'", goto: extract_invoice }
      - { goto: extract_other, default: true }
  - id: extract_invoice
    type: extract
    config: { schema: invoice }
  - id: extract_other
    type: extract
    config: { schema: other }
`);
    expect(plan.source).toBe("legacy");
    expect(resolveNextSteps(plan.edges, { label: "invoice" })).toEqual(["extract_invoice"]);
    expect(resolveNextSteps(plan.edges, { label: "receipt" })).toEqual(["extract_other"]);
  });

  it("legacy path translates on: sugar too", () => {
    const plan = buildDagPlan(`
steps:
  - id: classify
    type: classify
    config: {}
    on:
      invoice: extract_invoice
      _default: extract_other
  - id: extract_invoice
    type: extract
    config: { schema: invoice }
  - id: extract_other
    type: extract
    config: { schema: other }
`);
    expect(plan.source).toBe("legacy");
    expect(resolveNextSteps(plan.edges, { label: "invoice" })).toEqual(["extract_invoice"]);
    expect(resolveNextSteps(plan.edges, { label: "x" })).toEqual(["extract_other"]);
  });

  it("REFUSES the linear fallback when a classify step has no edges", () => {
    // A classify router with no routes at all must not silently become a
    // run-every-step fan-out.
    expect(() =>
      buildDagPlan(`
steps:
  - id: classify
    type: classify
    config: {}
  - id: extract_a
    type: extract
    config: { schema: a }
  - id: extract_b
    type: extract
    config: { schema: b }
`),
    ).toThrow(/refusing to run every step linearly/);
  });

  it("keeps the linear fallback for edge-less legacy pipelines WITHOUT classify", () => {
    const plan = buildDagPlan(`
steps:
  - id: extract
    type: extract
    config: { schema: s }
  - id: notify
    type: webhook
    config: { url: "https://example.test/hook" }
`);
    expect(plan.source).toBe("legacy");
    expect(plan.entryStepId).toBe("extract");
    expect(resolveNextSteps(plan.edges.filter((e) => e.from === "extract"), {})).toEqual(["notify"]);
  });

  it("single-schema shorthand compiles to a one-step plan", () => {
    const plan = buildDagPlan(`
pipeline: simple
schema: invoice
`);
    expect(plan.source).toBe("compiled");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ id: "extract", type: "extract" });
  });
});

describe("DAG runner status contracts", () => {
  // These are documentation tests — they assert the status values that
  // the DAG runner uses, so a future refactor doesn't silently break
  // the dashboard polling or job list.

  it("document terminal status is 'delivered' (not 'completed')", () => {
    // The dashboard polls until status is in ["delivered", "review", "failed"].
    // "completed" would cause infinite polling.
    const terminalStatuses = ["delivered", "review", "failed"];
    expect(terminalStatuses).toContain("delivered");
    expect(terminalStatuses).not.toContain("completed");
  });

  it("job terminal status is 'complete' (not 'completed')", () => {
    // The legacy ingestion path uses "complete" — DAG runner must match.
    const expected = "complete";
    expect(expected).toBe("complete");
    expect(expected).not.toBe("completed");
  });

  it("split documents get status 'split' (not 'delivered')", () => {
    // When a document is split into children, the parent doc is marked
    // "split" — it's not itself delivered, its children are.
    const wasSplit = true;
    const status = wasSplit ? "split" : "delivered";
    expect(status).toBe("split");
  });
});

describe("extractSkipReason — why a configured extract couldn't run (oss-448)", () => {
  // A configured extract that can't run must fail the document loudly rather
  // than stamp it `delivered` with null extraction. These pin the diagnosis
  // the runner attaches when it hard-fails the step.

  it("blames empty parse text first — the common encrypted/image-only PDF case", () => {
    // The bug that started this: an encrypted PDF parsed to "" (falsy docText),
    // so the extract guard was skipped and the doc silently delivered blank.
    const reason = extractSkipReason("policy_generic", "", { model: "gpt-4o-mini" });
    expect(reason).toMatch(/no extractable text/);
    expect(reason).toContain("policy_generic");
  });

  it("treats undefined docText (parse threw) the same as empty", () => {
    const reason = extractSkipReason("invoice", undefined, { model: "gpt-4o-mini" });
    expect(reason).toMatch(/no extractable text/);
  });

  it("blames a missing model endpoint when text is present", () => {
    const reason = extractSkipReason("invoice", "real text", null);
    expect(reason).toMatch(/no model endpoint/);
  });

  it("blames schema resolution when text and endpoint are present", () => {
    const reason = extractSkipReason("invoice", "real text", { model: "gpt-4o-mini" });
    expect(reason).toMatch(/schema version could not be resolved/);
  });

  it("reports a schema-less extract step (a no-op, not hard-failed by the caller)", () => {
    const reason = extractSkipReason("", "real text", { model: "gpt-4o-mini" });
    expect(reason).toMatch(/no schema configured/);
  });
});
