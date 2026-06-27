import { describe, it, expect } from "vitest";
import { applyKeepRaw, schemaHasKeepRaw } from "./keep-raw";
import type { ProvenanceMap } from "./provenance";

const span = (chunk: string) => ({ offset: 0, length: chunk.length, chunk });

describe("schemaHasKeepRaw", () => {
  it("detects keep_raw at top level", () => {
    expect(schemaHasKeepRaw({ a: { type: "string", keep_raw: true } })).toBe(true);
  });
  it("detects keep_raw inside array items", () => {
    expect(
      schemaHasKeepRaw({
        rows: { type: "array", items: { type: "object", properties: { a: { type: "string", keep_raw: true } } } },
      }),
    ).toBe(true);
  });
  it("detects keep_raw inside a nested object", () => {
    expect(
      schemaHasKeepRaw({ obj: { type: "object", properties: { a: { type: "string", keep_raw: true } } } }),
    ).toBe(true);
  });
  it("returns false when no field opts in", () => {
    expect(schemaHasKeepRaw({ a: { type: "string" } })).toBe(false);
    expect(schemaHasKeepRaw(undefined)).toBe(false);
  });
});

describe("applyKeepRaw", () => {
  it("adds a top-level _raw companion from provenance chunk", () => {
    const extracted = { coverage: "general_liability" };
    const fields = { coverage: { type: "mapping", keep_raw: true } };
    const provenance: ProvenanceMap = { coverage: span("General Liability") };
    applyKeepRaw(extracted, fields, provenance);
    expect(extracted).toEqual({ coverage: "general_liability", coverage_raw: "General Liability" });
  });

  it("adds _raw per array item from per-property provenance", () => {
    const extracted = {
      coverages: [
        { applies_to: "each_occurrence" },
        { applies_to: "general_aggregate" },
      ],
    };
    const fields = {
      coverages: {
        type: "array",
        items: { type: "object", properties: { applies_to: { type: "mapping", keep_raw: true } } },
      },
    };
    const provenance: ProvenanceMap = {
      coverages: {
        offset: 0,
        length: 0,
        items: [
          { offset: 0, length: 0, properties: { applies_to: span("Each Occurrence") } },
          { offset: 0, length: 0, properties: { applies_to: span("Aggregate") } },
        ],
      },
    };
    applyKeepRaw(extracted, fields, provenance);
    expect(extracted.coverages[0]).toEqual({ applies_to: "each_occurrence", applies_to_raw: "Each Occurrence" });
    expect(extracted.coverages[1]).toEqual({ applies_to: "general_aggregate", applies_to_raw: "Aggregate" });
  });

  it("adds _raw inside a nested object from per-property provenance", () => {
    const extracted = { insured: { state: "CA" } };
    const fields = { insured: { type: "object", properties: { state: { type: "enum", keep_raw: true } } } };
    const provenance: ProvenanceMap = {
      insured: { offset: 0, length: 0, properties: { state: span("California") } },
    };
    applyKeepRaw(extracted, fields, provenance);
    expect((extracted.insured as Record<string, unknown>).state_raw).toBe("California");
  });

  it("only adds _raw for fields that opt in", () => {
    const extracted = { a: "x", b: "y" };
    const fields = { a: { type: "string", keep_raw: true }, b: { type: "string" } };
    applyKeepRaw(extracted, fields, { a: span("X"), b: span("Y") });
    expect(extracted).toEqual({ a: "x", a_raw: "X", b: "y" });
  });

  it("does nothing when provenance has no chunk for the field", () => {
    const extracted = { a: "x" };
    applyKeepRaw(extracted, { a: { type: "string", keep_raw: true } }, { a: null });
    expect(extracted).toEqual({ a: "x" });
  });

  it("does not overwrite an existing _raw key", () => {
    const extracted = { a: "x", a_raw: "preset" };
    applyKeepRaw(extracted, { a: { type: "string", keep_raw: true } }, { a: span("X") });
    expect(extracted.a_raw).toBe("preset");
  });
});
