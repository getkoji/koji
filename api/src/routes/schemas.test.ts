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
import { assertComparableScorerVersion, scorerVersionMismatch, SCORER_VERSION } from "@koji/score";
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

describe("computeValidateResult — element tallies make array quality legible (oss-507)", () => {
  const schemaFields = {
    coverages: {
      type: "array",
      hints: { element_key: "code" },
      items: { type: "object", properties: { code: { type: "string" }, limit: { type: "string" } } },
    },
    policy_number: { type: "string" },
  };

  it("counts one wrong cell in a ten-row table as one changed element, not a failed document", () => {
    // This is the saturation the tally exists to break: `docsPassed` is
    // all-or-nothing, so ten rows with a single wrong sub-field score the same
    // as ten rows of garbage.
    const rows = Array.from({ length: 10 }, (_, i) => ({ code: `C${i}`, limit: `${i}000` }));
    const emitted = rows.map((r, i) => (i === 3 ? { code: r.code, limit: "WRONG" } : r));
    const out = computeValidateResult(
      [
        {
          entryId: "d1",
          filename: "policy.pdf",
          groundTruth: { coverages: rows },
          extracted: { coverages: emitted },
          confidenceScores: { coverages: 0.9 },
        } as Result,
      ],
      new Map(),
      1,
      Date.now(),
      [],
      schemaFields,
    );
    expect(out.docsPassed).toBe(0); // the document still "fails" — unchanged
    expect(out.elements).toEqual({
      expected: 10,
      got: 10,
      matched: 9,
      changed: 1,
      missing: 0,
      extra: 0,
    });
  });

  it("separates the three array failure modes a boolean collapses", () => {
    const out = computeValidateResult(
      [
        {
          entryId: "d1",
          filename: "policy.pdf",
          groundTruth: {
            coverages: [
              { code: "GL", limit: "1000000" },
              { code: "PROP", limit: "2000000" },
              { code: "AUTO", limit: "500000" },
            ],
          },
          // GL exact, PROP found with a wrong limit, AUTO never found, UMB invented.
          extracted: {
            coverages: [
              { code: "GL", limit: "1000000" },
              { code: "PROP", limit: "9999999" },
              { code: "UMB", limit: "5000000" },
            ],
          },
          confidenceScores: { coverages: 0.9 },
        } as Result,
      ],
      new Map(),
      1,
      Date.now(),
      [],
      schemaFields,
    );
    expect(out.elements).toEqual({
      expected: 3,
      got: 3,
      matched: 1,
      changed: 1, // row found, sub-field differs
      missing: 1, // recall loss
      extra: 1, // precision loss
    });
  });

  it("attaches per-field tallies to array fields only", () => {
    const out = computeValidateResult(
      [
        {
          entryId: "d1",
          filename: "policy.pdf",
          groundTruth: { coverages: [{ code: "GL", limit: "1" }], policy_number: "ABC-123" },
          extracted: { coverages: [{ code: "GL", limit: "1" }], policy_number: "ABC-123" },
          confidenceScores: {},
        } as Result,
      ],
      new Map(),
      1,
      Date.now(),
      [],
      schemaFields,
    );
    expect(out.fields.find((f) => f.name === "coverages")!.elements).toEqual({
      expected: 1,
      got: 1,
      matched: 1,
      changed: 0,
      missing: 0,
      extra: 0,
    });
    expect(out.fields.find((f) => f.name === "policy_number")!.elements).toBeUndefined();
  });

  it("reports null when the run scored no arrays at all", () => {
    const out = computeValidateResult(
      [
        {
          entryId: "d1",
          filename: "policy.pdf",
          groundTruth: { policy_number: "ABC-123" },
          extracted: { policy_number: "ABC-123" },
          confidenceScores: {},
        } as Result,
      ],
      new Map(),
      1,
      Date.now(),
      [],
      { policy_number: { type: "string" } },
    );
    expect(out.elements).toBeNull();
  });
});

describe("computeValidateResult — the four metrics replace one accuracy number (oss-523)", () => {
  const doc = (
    groundTruth: Record<string, unknown>,
    extracted: Record<string, unknown>,
  ): Result => ({
    entryId: "d1",
    filename: "filing.pdf",
    groundTruth,
    extracted,
    confidenceScores: {},
  });

  it("a document that extracts NOTHING scores 0 presence recall", () => {
    // The all-null floor. Four fields with values, three legitimately empty:
    // a single folded number counted the three empties as passes and reported
    // a non-zero score for an extraction that produced nothing.
    const out = computeValidateResult(
      [
        doc(
          {
            filer_name: "Acme Corp",
            form_type: "10-K",
            filing_date: "2026-03-26",
            total_assets: 1250,
            auditor: null,
            restatement: null,
            subsidiary: null,
          },
          {},
        ),
      ],
      new Map(),
      1,
      Date.now(),
    );

    expect(out.metrics.presenceRecall).toBe(0);
    expect(out.metrics.valueAccuracy).toBeNull();
    expect(out.metrics.fabricationRate).toBe(0);
    expect(out.metrics.nullAgreement).toBe(1);
    expect(out.metrics.counts).toMatchObject({ present: 4, found: 0, missed: 4, absent: 3, agreed: 3 });
  });

  it("adding correctly-empty fields cannot lift any reported metric", () => {
    const bare = computeValidateResult([doc({ a: "x" }, {})], new Map(), 1, Date.now());
    const padded = computeValidateResult(
      [doc({ a: "x", b: null, c: null, d: null, e: null, f: null }, {})],
      new Map(),
      1,
      Date.now(),
    );
    expect(bare.metrics.presenceRecall).toBe(0);
    expect(padded.metrics.presenceRecall).toBe(0);
    expect(padded.metrics.valueAccuracy).toBeNull();
    // Null agreement is where the empties land, and only there.
    expect(padded.metrics.nullAgreement).toBe(1);
  });

  it("separates finding a value from getting it right", () => {
    const out = computeValidateResult(
      [doc({ a: "PA", b: "NC", c: "SC" }, { a: "LA", b: "NC" })],
      new Map(),
      1,
      Date.now(),
    );
    expect(out.metrics.presenceRecall).toBeCloseTo(2 / 3);
    expect(out.metrics.valueAccuracy).toBeCloseTo(1 / 2);
  });

  it("measures fabrication, which overallAccuracy structurally cannot", () => {
    // `overallAccuracy` skips every field whose ground truth is null, so a run
    // that invented values for all of them scored 100% before oss-523.
    const out = computeValidateResult(
      [doc({ a: "real", b: null, c: null }, { a: "real", b: "invented", c: null })],
      new Map(),
      1,
      Date.now(),
    );
    expect(out.overallAccuracy).toBe(100);
    expect(out.metrics.fabricationRate).toBeCloseTo(0.5);
    expect(out.metrics.nullAgreement).toBeCloseTo(0.5);
  });

  it("reports metrics per field as well as per run", () => {
    const out = computeValidateResult(
      [
        doc({ a: "x", b: "y" }, { a: "x", b: null }),
        doc({ a: "x", b: "y" }, { a: "wrong", b: "y" }),
      ],
      new Map(),
      1,
      Date.now(),
    );
    const a = out.fields.find((f) => f.name === "a")!;
    const b = out.fields.find((f) => f.name === "b")!;
    expect(a.metrics.presenceRecall).toBe(1);
    expect(a.metrics.valueAccuracy).toBe(0.5);
    expect(b.metrics.presenceRecall).toBe(0.5);
    expect(b.metrics.valueAccuracy).toBe(1);
  });

  it("leaves overallAccuracy exactly where it was", () => {
    // The split is additive. Anything reading `overallAccuracy` — the DB
    // column, the dashboard, the tune loops, the sanity gate — must see the
    // same number it saw before.
    const out = computeValidateResult(
      [doc({ a: "x", b: "y", c: null }, { a: "x", b: "wrong", c: "fabricated" })],
      new Map(),
      1,
      Date.now(),
    );
    expect(out.overallAccuracy).toBe(50);
    expect(out.scoredCount).toBe(2);
  });

  it("is null for a population the run never tested", () => {
    const noAbsent = computeValidateResult([doc({ a: "x" }, { a: "x" })], new Map(), 1, Date.now());
    expect(noAbsent.metrics.fabricationRate).toBeNull();
    expect(noAbsent.metrics.nullAgreement).toBeNull();

    const noPresent = computeValidateResult([doc({ a: null }, {})], new Map(), 1, Date.now());
    expect(noPresent.metrics.presenceRecall).toBeNull();
    expect(noPresent.metrics.valueAccuracy).toBeNull();
  });
});

describe("computeValidateResult — scorer_version stamp (oss-525)", () => {
  it("stamps the scorer that produced the numbers", () => {
    const out = computeValidateResult(
      [
        {
          entryId: "d1",
          filename: "f.pdf",
          groundTruth: { a: "x" },
          extracted: { a: "x" },
          confidenceScores: {},
        } as Result,
      ],
      new Map(),
      1,
      Date.now(),
    );
    expect(out.scorerVersion).toBe(SCORER_VERSION);
  });

  it("refuses a comparison across scorer versions", () => {
    expect(() => assertComparableScorerVersion("0.0.1", "baseline run")).toThrow(/not comparable/);
    expect(() => assertComparableScorerVersion(SCORER_VERSION)).not.toThrow();
  });

  it("flags — rather than throws on — a stored run scored by another version", () => {
    // What the GET run endpoint attaches: reading an old run is legitimate,
    // comparing its number to a fresh one is what isn't.
    expect(scorerVersionMismatch(SCORER_VERSION)).toBeNull();
    expect(scorerVersionMismatch("0.0.1", "validate run abc")).toContain("validate run abc");
  });
});
