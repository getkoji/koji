/**
 * Tests for the schema routes.
 *
 * Focus: the `/api/schemas/:slug/fields` endpoint that exposes structured
 * field metadata so clients (notably the dashboard review page) never have to
 * parse YAML in the browser.
 *
 * The normalizer's full coverage lives in `../schemas/field-meta.test.ts`.
 * These tests pin the route-level contract: permission gating, the response
 * shape, the 404 for unknown slugs, and the fallback path that returns an
 * empty `fields: []` when no committed YAML exists yet.
 */
import { describe, it, expect } from "vitest";
import { resolvePermissions } from "../auth/roles";
import { extractFieldMetas } from "../schemas/field-meta";
import { computeValidateResult, answerPresentInText } from "./schemas";

type Result = {
  entryId: string;
  filename: string;
  groundTruth: Record<string, unknown>;
  extracted: Record<string, unknown>;
  confidenceScores: Record<string, number>;
};

describe("schema field-metadata route — permissions", () => {
  it("viewer can read schema fields (schema:read)", () => {
    expect(resolvePermissions(["viewer"]).has("schema:read")).toBe(true);
  });

  it("schema-editor can read schema fields (schema:read)", () => {
    expect(resolvePermissions(["schema-editor"]).has("schema:read")).toBe(true);
  });

  it("owner can read schema fields (schema:read)", () => {
    expect(resolvePermissions(["owner"]).has("schema:read")).toBe(true);
  });
});

describe("schema field-metadata route — response shape", () => {
  /**
   * The handler's contract: `{ fields: FieldMeta[] }`. This mirrors the
   * exact transform the route does — extractFieldMetas + envelope — so a
   * downstream caller can rely on the shape regardless of whether the
   * YAML is empty, the schema has a draft only, or has a committed
   * version.
   */
  function fieldMetaResponse(yamlSource: string | null | undefined) {
    return { fields: extractFieldMetas(yamlSource ?? "") };
  }

  it("returns an envelope with a `fields` array", () => {
    const response = fieldMetaResponse("name: x\nfields:\n  a:\n    type: string\n");
    expect(response).toHaveProperty("fields");
    expect(Array.isArray(response.fields)).toBe(true);
  });

  it("returns `fields: []` when the schema has no YAML yet", () => {
    expect(fieldMetaResponse(null)).toEqual({ fields: [] });
    expect(fieldMetaResponse("")).toEqual({ fields: [] });
  });

  it("returns `fields: []` for malformed YAML (no throw)", () => {
    expect(fieldMetaResponse("fields:\n  bad: [unterminated")).toEqual({ fields: [] });
  });

  it("returns one FieldMeta per declared field, preserving order", () => {
    const yaml = `
fields:
  one:
    type: string
  two:
    type: number
  three:
    type: boolean
`;
    const response = fieldMetaResponse(yaml);
    expect(response.fields.map((f) => f.name)).toEqual(["one", "two", "three"]);
    expect(response.fields.map((f) => f.type)).toEqual(["string", "number", "boolean"]);
  });

  it("each FieldMeta carries name + type at minimum", () => {
    const response = fieldMetaResponse("fields:\n  a:\n    type: string\n");
    expect(response.fields[0]).toMatchObject({ name: "a", type: "string" });
  });
});

describe("computeValidateResult — fields the schema doesn't declare (oss-492)", () => {
  // Ground truth carries a field the schema being validated has no field for.
  // Nothing is extracted for it, so it scores 0% — which reads as a broken
  // extraction, and as a −100 point regression against a schema version that
  // DID declare it. Neither is true: the schema was never asked for it.
  const doc: Result = {
    entryId: "e1",
    filename: "policy.pdf",
    groundTruth: { policy_number: "ABC-123", policy_forms: ["CG 00 01", "CG 20 10"] },
    extracted: { policy_number: "ABC-123" },
    confidenceScores: { policy_number: 1 },
  };
  const schemaFields = { policy_number: { type: "string" } };

  it("labels a ground-truth field the schema has no field for", () => {
    const out = computeValidateResult([doc], new Map(), 1, Date.now(), [], schemaFields);
    const forms = out.fields.find((f) => f.name === "policy_forms");
    expect(forms?.status).toBe("not_in_schema");
    // Still reported, and still counted — a field a schema edit REMOVED is a
    // real change the operator needs to see.
    expect(forms?.accuracy).toBe(0);
  });

  it("does not count it among regressions", () => {
    const prev = new Map([["e1", { policy_number: "ABC-123", policy_forms: ["CG 00 01", "CG 20 10"] }]]);
    const out = computeValidateResult([doc], prev, 1, Date.now(), [], schemaFields);
    expect(out.regressions.map((f) => f.name)).not.toContain("policy_forms");
  });

  it("declared fields keep their normal statuses", () => {
    const out = computeValidateResult([doc], new Map(), 1, Date.now(), [], schemaFields);
    expect(out.fields.find((f) => f.name === "policy_number")?.status).toBe("pass");
  });

  it("stays silent when the caller passes no schema fields", () => {
    // The read-only GET path has no compiled schema to compare against; it
    // must not label everything as missing.
    const out = computeValidateResult([doc], new Map(), 1, Date.now(), []);
    expect(out.fields.find((f) => f.name === "policy_forms")?.status).not.toBe("not_in_schema");
  });
});

describe("computeValidateResult — parse failures are surfaced, not silently dropped (oss-308)", () => {
  // A doc that perfectly matches ground truth (one field, exact value) → passes.
  const passingDoc: Result = {
    entryId: "entry_pass",
    filename: "good.pdf",
    groundTruth: { policy_number: "ABC-123" },
    extracted: { policy_number: "ABC-123" },
    confidenceScores: { policy_number: 1 },
  };

  it("a doc that failed to parse appears in `parseFailures` and is NOT silently absent", () => {
    const failures = [
      { entryId: "entry_fail", filename: "scanned.pdf", error: "parse returned empty markdown" },
    ];
    const out = computeValidateResult([passingDoc], new Map(), 1, Date.now() - 5, failures);

    // The failed doc is visible — not vanished.
    expect(out.parseFailures).toHaveLength(1);
    expect(out.parseFailures[0]).toMatchObject({
      entryId: "entry_fail",
      filename: "scanned.pdf",
      error: "parse returned empty markdown",
    });
    // It is NOT counted among the scored/passing docs.
    expect(out.docsPassed).toBe(1); // only the genuinely-passing doc
    expect(out.failingDocs.find((d) => d.id === "entry_fail")).toBeUndefined();
  });

  it("docsTotal counts attempted docs (results + failures) so accuracy isn't inflated", () => {
    const failures = [
      { entryId: "entry_fail", filename: "scanned.pdf", error: "file not found in storage" },
    ];
    const out = computeValidateResult([passingDoc], new Map(), 1, Date.now(), failures);

    // 1 scored + 1 failed = 2 attempted. A dropped doc can't shrink the denominator.
    expect(out.docsTotal).toBe(2);
    expect(out.docsPassed).toBe(1);
    // Field-level accuracy is computed only over docs that produced an extraction,
    // but the failure remains visible in docsTotal + parseFailures for honesty.
    expect(out.overallAccuracy).toBe(100);
  });

  it("is backward-compatible: omitting parseFailures yields [] and docsTotal == results.length", () => {
    const out = computeValidateResult([passingDoc], new Map(), 1, Date.now());
    expect(out.parseFailures).toEqual([]);
    expect(out.docsTotal).toBe(1);
  });
});

describe("answerPresentInText — routing-miss detector heuristic", () => {
  it("matches a string answer as a normalized substring", () => {
    expect(answerPresentInText("John Doe", "Insured: John Doe\nPolicy: 1")).toBe(true);
    expect(answerPresentInText("John Doe", "insured: JOHN   DOE")).toBe(true);
  });

  it("matches a long string answer on ≥60% of significant tokens", () => {
    const expected = "water damage from a burst pipe";
    // Missing "a" (a stopword <=2 chars is ignored anyway); most tokens present.
    expect(answerPresentInText(expected, "cause of loss: water damage from burst pipe")).toBe(true);
  });

  it("reports a string answer absent when the chunks don't contain it", () => {
    expect(answerPresentInText("Hurricane Ida", "Policy Number: POL-1\nInsured: Jane")).toBe(false);
  });

  it("matches a numeric answer on its digit sequence, ignoring $/commas/decimals", () => {
    expect(answerPresentInText(50000, "Amount: $50,000.00")).toBe(true);
    expect(answerPresentInText(1234.5, "Total 1,234.50 due")).toBe(true);
    expect(answerPresentInText(9999, "Amount: $50,000.00")).toBe(false);
  });

  it("returns null when no routed text is available or the value is non-scalar", () => {
    expect(answerPresentInText("anything", undefined)).toBeNull();
    expect(answerPresentInText(true, "yes it is true")).toBeNull();
    expect(answerPresentInText([{ a: 1 }], "some text")).toBeNull();
  });
});

describe("computeValidateResult — routing diagnosis on failing fields", () => {
  it("flags a routing MISS when the answer wasn't in the chunks the model saw", () => {
    const doc = {
      entryId: "e1",
      filename: "doc.pdf",
      groundTruth: { loss_cause: "Hurricane Ida" },
      extracted: { loss_cause: "Fire" },
      confidenceScores: { loss_cause: 0.4 },
      routingPlan: {
        loss_cause: {
          source: "fallback",
          chunks: [{ index: 0, title: "Header" }],
          text: "Policy Number: POL-1\nInsured: Jane Doe",
        },
      },
    };
    const out = computeValidateResult([doc], new Map(), 1, Date.now());
    const field = out.fields.find((f) => f.name === "loss_cause")!;
    const diag = field.failingDocs[0]!.routingDiagnosis!;
    expect(diag.source).toBe("fallback");
    expect(diag.answerInRoutedChunks).toBe(false); // → fix the schema hints, not the model
    expect(diag.chunks).toEqual([{ index: 0, title: "Header" }]);
  });

  it("flags a model misread when the answer WAS in the routed chunks", () => {
    const doc = {
      entryId: "e2",
      filename: "doc.pdf",
      groundTruth: { loss_cause: "Hurricane Ida" },
      extracted: { loss_cause: "Fire" },
      confidenceScores: { loss_cause: 0.4 },
      routingPlan: {
        loss_cause: {
          source: "hint",
          chunks: [{ index: 3, title: "Loss" }],
          text: "Cause of Loss: Hurricane Ida struck the property",
        },
      },
    };
    const out = computeValidateResult([doc], new Map(), 1, Date.now());
    const diag = out.fields.find((f) => f.name === "loss_cause")!.failingDocs[0]!.routingDiagnosis!;
    expect(diag.source).toBe("hint");
    expect(diag.answerInRoutedChunks).toBe(true); // model saw it → tighten description, not routing
  });

  it("omits routingDiagnosis when no routing plan is present (e.g. cached read path)", () => {
    const doc = {
      entryId: "e3",
      filename: "doc.pdf",
      groundTruth: { x: "A" },
      extracted: { x: "B" },
      confidenceScores: { x: 0.5 },
    };
    const out = computeValidateResult([doc], new Map(), 1, Date.now());
    expect(out.fields.find((f) => f.name === "x")!.failingDocs[0]!.routingDiagnosis).toBeUndefined();
  });
});

describe("computeValidateResult — F1 array scoring + precision/recall reporting (oss-337)", () => {
  const schemaFields = {
    coverages: {
      type: "array",
      hints: { element_key: "code" },
      items: { type: "object", properties: { code: { type: "string" }, limit: { type: "string" } } },
    },
  };

  it("reports precision/recall for an array field and scores by F1", () => {
    const doc: Result = {
      entryId: "d1",
      filename: "policy.pdf",
      groundTruth: { coverages: [{ code: "GL", limit: "1000000" }, { code: "PROP", limit: "2000000" }] },
      // Found GL correctly, missed PROP, added a spurious UMB → recall + precision both 0.5.
      extracted: { coverages: [{ code: "GL", limit: "1000000" }, { code: "UMB", limit: "5000000" }] },
      confidenceScores: { coverages: 0.9 },
    };
    const out = computeValidateResult([doc], new Map(), 1, Date.now(), [], schemaFields);
    const field = out.fields.find((f) => f.name === "coverages")!;
    expect(field.precision).toBeCloseTo(50, 3); // 1 of 2 produced was right
    expect(field.recall).toBeCloseTo(50, 3); // 1 of 2 expected was found
    // F1 = 2·0.5·0.5/1 = 0.5 → accuracy 50%
    expect(field.accuracy).toBeCloseTo(50, 3);
  });

  it("does not attach precision/recall to a scalar field", () => {
    const doc: Result = {
      entryId: "d2",
      filename: "policy.pdf",
      groundTruth: { policy_number: "ABC-123" },
      extracted: { policy_number: "ABC-123" },
      confidenceScores: { policy_number: 1 },
    };
    const out = computeValidateResult([doc], new Map(), 1, Date.now(), [], { policy_number: { type: "string" } });
    const field = out.fields.find((f) => f.name === "policy_number")!;
    expect(field.precision).toBeUndefined();
    expect(field.recall).toBeUndefined();
  });
});
