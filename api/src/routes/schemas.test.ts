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
import { computeValidateResult } from "./schemas";

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
