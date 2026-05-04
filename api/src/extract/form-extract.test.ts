import { describe, it, expect } from "vitest";
import { formExtractToResult, fieldsNeedingLlm } from "./form-extract";

const SCHEMA_DEF = {
  name: "test_coi",
  fields: {
    insured_name: { type: "string", required: true },
    policy_number: { type: "string" },
    effective_date: { type: "date", normalize: "iso8601" },
    premium: { type: "number" },
    gl_occurrence: { type: "boolean" },
  },
};

describe("formExtractToResult", () => {
  it("converts coordinate results into standard extraction result", () => {
    const coords = {
      insured_name: { value: "Acme Corp", page: 1 },
      policy_number: { value: "POL-123", page: 1 },
      effective_date: { value: "3/15/2026", page: 1 },
      premium: { value: "1500", page: 1 },
    };
    const result = formExtractToResult(coords, SCHEMA_DEF);
    expect(result.model).toBe("coordinates");
    expect(result.strategy).toBe("form-mapping");
    expect(result.extracted.insured_name).toBe("Acme Corp");
    expect(result.extracted.policy_number).toBe("POL-123");
    expect(result.extracted.effective_date).toBe("2026-03-15"); // normalized
  });

  it("scores mapped fields as high confidence", () => {
    const coords = {
      insured_name: { value: "Acme Corp", page: 1 },
    };
    const result = formExtractToResult(coords, SCHEMA_DEF);
    expect(result.confidence_scores.insured_name).toBe(0.98);
    expect(result.confidence.insured_name).toBe("high");
  });

  it("excludes unmapped fields from confidence scoring", () => {
    const coords = {
      insured_name: { value: "Acme Corp", page: 1 },
    };
    const result = formExtractToResult(coords, SCHEMA_DEF);
    // policy_number has no coordinate result — should not be scored
    expect(result.confidence_scores.policy_number).toBeUndefined();
  });

  it("scores error fields as low confidence", () => {
    const coords = {
      insured_name: { value: "garbled", page: 1, error: "extraction failed" },
    };
    const result = formExtractToResult(coords, SCHEMA_DEF);
    expect(result.confidence_scores.insured_name).toBe(0.3);
    expect(result.confidence.insured_name).toBe("low");
  });

  it("includes extra fields from coordinate results not in schema", () => {
    const coords = {
      insured_name: { value: "Acme Corp", page: 1 },
      insured_address: { value: "123 Main St", page: 1 },
    };
    const result = formExtractToResult(coords, SCHEMA_DEF);
    expect(result.extracted.insured_address).toBe("123 Main St");
  });

  it("builds provenance from coordinate positions", () => {
    const coords = {
      insured_name: { value: "Acme Corp", page: 1, bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.04 } },
    };
    const result = formExtractToResult(coords, SCHEMA_DEF);
    expect(result.provenance?.insured_name).toMatchObject({
      page: 1,
      chunk: "Acme Corp",
    });
  });
});

describe("fieldsNeedingLlm", () => {
  it("identifies null required fields", () => {
    const coords = {
      policy_number: { value: "POL-123", page: 1 },
    };
    const result = formExtractToResult(coords, SCHEMA_DEF);
    const needs = fieldsNeedingLlm(result, SCHEMA_DEF);
    expect(needs).toContain("insured_name");
  });

  it("does not flag non-required null fields", () => {
    const coords = {
      insured_name: { value: "Acme", page: 1 },
    };
    const result = formExtractToResult(coords, SCHEMA_DEF);
    const needs = fieldsNeedingLlm(result, SCHEMA_DEF);
    expect(needs).not.toContain("premium");
  });
});
