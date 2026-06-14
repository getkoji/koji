/**
 * Tests for the per-field deterministic confidence scorer.
 *
 * One describe block per field type covers every branch of the scoring
 * matrix documented in `field-confidence.ts`. The final block covers the
 * helper functions `computeFieldConfidences` and `aggregateDocConfidence`
 * which the routing layer in `ingestion/process.ts` actually consumes.
 */

import { describe, it, expect } from "vitest";
import {
  computeFieldConfidence,
  computeFieldConfidences,
  aggregateDocConfidence,
  findLowestField,
} from "./field-confidence";
import type { ProvenanceSpan } from "./provenance";

// A "found in source" provenance span — only `.offset >= 0` matters for scoring.
const FOUND: ProvenanceSpan = { offset: 42, length: 5 };
// A "not found" provenance — the resolver returns `null` for misses, not an
// offset of -1, but we cover the defensive offset check explicitly too.
const NOT_FOUND: ProvenanceSpan = { offset: -1, length: 0 };

describe("computeFieldConfidence — enum", () => {
  const schema = { type: "enum", options: ["BOP", "GL", "Workers Compensation"] };

  it("scores 1.0 when value is in the enum set", () => {
    expect(computeFieldConfidence("BOP", schema)).toBe(1.0);
    expect(computeFieldConfidence("Workers Compensation", schema)).toBe(1.0);
  });

  it("scores 0.0 when value is not in the enum set", () => {
    expect(computeFieldConfidence("Auto", schema)).toBe(0.0);
    expect(computeFieldConfidence("Other Policy", schema)).toBe(0.0);
  });

  it("is case-sensitive (validate_field upstream snaps casing)", () => {
    // Schema author declared "BOP" — a lowercase "bop" at this stage means
    // the upstream snapping failed and we treat it as a real miss.
    expect(computeFieldConfidence("bop", schema)).toBe(0.0);
  });

  it("scores 1.0 when enum has no options declared (no constraint to violate)", () => {
    expect(computeFieldConfidence("anything", { type: "enum" })).toBe(1.0);
  });

  it("falls through to mapping semantics when only mappings are declared", () => {
    const mapSchema = {
      type: "enum",
      mappings: { directors_and_officers: ["D&O", "Directors and Officers"] },
    };
    expect(computeFieldConfidence("directors_and_officers", mapSchema)).toBe(1.0);
    expect(computeFieldConfidence("D&O", mapSchema)).toBe(0.0);
  });
});

describe("computeFieldConfidence — mapping", () => {
  const schema = {
    type: "mapping",
    mappings: {
      directors_and_officers: ["D&O", "Directors and Officers"],
      employment_practices: ["EPL", "EPLI"],
    },
  };

  it("scores 1.0 when value matches a canonical key", () => {
    expect(computeFieldConfidence("directors_and_officers", schema)).toBe(1.0);
    expect(computeFieldConfidence("employment_practices", schema)).toBe(1.0);
  });

  it("scores 0.0 when value is an alias rather than canonical", () => {
    expect(computeFieldConfidence("D&O", schema)).toBe(0.0);
  });

  it("scores 1.0 when no mappings declared (no constraint)", () => {
    expect(computeFieldConfidence("anything", { type: "mapping" })).toBe(1.0);
  });
});

describe("computeFieldConfidence — integer", () => {
  it("scores 1.0 when value parses and is in range", () => {
    expect(
      computeFieldConfidence(5, { type: "integer", min: 1, max: 10 }),
    ).toBe(1.0);
  });

  it("scores 0.5 when value parses but no range is declared", () => {
    expect(computeFieldConfidence(5, { type: "integer" })).toBe(0.5);
    expect(computeFieldConfidence(0, { type: "integer" })).toBe(0.5);
    expect(computeFieldConfidence(-42, { type: "integer" })).toBe(0.5);
  });

  it("scores 0.0 when value is below min or above max", () => {
    expect(
      computeFieldConfidence(0, { type: "integer", min: 1, max: 10 }),
    ).toBe(0.0);
    expect(
      computeFieldConfidence(11, { type: "integer", min: 1, max: 10 }),
    ).toBe(0.0);
  });

  it("scores 0.0 when value doesn't parse to an integer", () => {
    expect(computeFieldConfidence(5.5, { type: "integer" })).toBe(0.0);
    expect(computeFieldConfidence("abc", { type: "integer" })).toBe(0.0);
    expect(computeFieldConfidence({}, { type: "integer" })).toBe(0.0);
  });

  it("accepts numeric strings", () => {
    expect(computeFieldConfidence("42", { type: "integer" })).toBe(0.5);
    expect(
      computeFieldConfidence("42", { type: "integer", min: 0, max: 100 }),
    ).toBe(1.0);
  });

  it("handles range with only min or only max", () => {
    expect(computeFieldConfidence(5, { type: "integer", min: 1 })).toBe(1.0);
    expect(computeFieldConfidence(0, { type: "integer", min: 1 })).toBe(0.0);
    expect(computeFieldConfidence(5, { type: "integer", max: 10 })).toBe(1.0);
    expect(computeFieldConfidence(11, { type: "integer", max: 10 })).toBe(0.0);
  });
});

describe("computeFieldConfidence — number", () => {
  it("scores 1.0 when value parses and is in range", () => {
    expect(
      computeFieldConfidence(1500.5, { type: "number", min: 0, max: 10000 }),
    ).toBe(1.0);
  });

  it("scores 0.5 when value parses but no range is declared", () => {
    expect(computeFieldConfidence(1500.5, { type: "number" })).toBe(0.5);
    expect(computeFieldConfidence(0, { type: "number" })).toBe(0.5);
  });

  it("scores 0.0 when value is out of range", () => {
    expect(
      computeFieldConfidence(-1, { type: "number", min: 0, max: 10000 }),
    ).toBe(0.0);
    expect(
      computeFieldConfidence(20000, { type: "number", min: 0, max: 10000 }),
    ).toBe(0.0);
  });

  it("scores 0.0 when value doesn't parse to a number", () => {
    expect(computeFieldConfidence("not a number", { type: "number" })).toBe(0.0);
    expect(computeFieldConfidence({}, { type: "number" })).toBe(0.0);
    expect(computeFieldConfidence([], { type: "number" })).toBe(0.0);
    expect(computeFieldConfidence(true, { type: "number" })).toBe(0.0);
  });

  it("strips currency formatting from string values", () => {
    expect(computeFieldConfidence("$1,500.00", { type: "number" })).toBe(0.5);
    expect(
      computeFieldConfidence("$1,500.00", { type: "number", min: 0, max: 10000 }),
    ).toBe(1.0);
  });

  it("treats NaN and Infinity as un-parseable", () => {
    expect(computeFieldConfidence(NaN, { type: "number" })).toBe(0.0);
    expect(computeFieldConfidence(Infinity, { type: "number" })).toBe(0.0);
    expect(computeFieldConfidence(-Infinity, { type: "number" })).toBe(0.0);
  });
});

describe("computeFieldConfidence — date", () => {
  it("scores 1.0 when value parses in the schema's expected format (YYYY-MM-DD default)", () => {
    expect(computeFieldConfidence("2025-12-04", { type: "date" })).toBe(1.0);
    expect(
      computeFieldConfidence("2025-01-01", { type: "date", format: "YYYY-MM-DD" }),
    ).toBe(1.0);
  });

  it("scores 0.5 when value is a valid date but in the wrong format", () => {
    expect(computeFieldConfidence("12/04/2025", { type: "date" })).toBe(0.5);
    expect(computeFieldConfidence("December 4, 2025", { type: "date" })).toBe(0.5);
    expect(computeFieldConfidence("4 December 2025", { type: "date" })).toBe(0.5);
  });

  it("scores 0.0 when value doesn't parse to any date", () => {
    expect(computeFieldConfidence("nonsense", { type: "date" })).toBe(0.0);
    expect(computeFieldConfidence("", { type: "date" })).toBe(0.0);
    expect(computeFieldConfidence("13/45/2025", { type: "date" })).toBe(0.0);
    expect(computeFieldConfidence(2025, { type: "date" })).toBe(0.0);
  });

  it("rejects impossible calendar dates (Feb 30 etc.)", () => {
    expect(computeFieldConfidence("2025-02-30", { type: "date" })).toBe(0.0);
    expect(computeFieldConfidence("2025-13-01", { type: "date" })).toBe(0.0);
  });

  it("accepts leap-day Feb 29 on leap years and rejects on common years", () => {
    expect(computeFieldConfidence("2024-02-29", { type: "date" })).toBe(1.0);
    expect(computeFieldConfidence("2025-02-29", { type: "date" })).toBe(0.0);
  });
});

describe("computeFieldConfidence — boolean", () => {
  it("scores 1.0 for exact true or false", () => {
    expect(computeFieldConfidence(true, { type: "boolean" })).toBe(1.0);
    expect(computeFieldConfidence(false, { type: "boolean" })).toBe(1.0);
  });

  it("scores 0.0 for anything that isn't strictly a boolean", () => {
    expect(computeFieldConfidence("true", { type: "boolean" })).toBe(0.0);
    expect(computeFieldConfidence("yes", { type: "boolean" })).toBe(0.0);
    expect(computeFieldConfidence(1, { type: "boolean" })).toBe(0.0);
    expect(computeFieldConfidence(0, { type: "boolean" })).toBe(0.0);
  });
});

describe("computeFieldConfidence — string with pattern", () => {
  const schema = { type: "string", pattern: "^[A-Z]{2,5}\\d{5,}$" };

  it("scores 1.0 when value matches the pattern", () => {
    expect(computeFieldConfidence("ABC12345", schema)).toBe(1.0);
    expect(computeFieldConfidence("AB12345", schema)).toBe(1.0);
  });

  it("scores 0.0 when value does not match the pattern", () => {
    expect(computeFieldConfidence("nope", schema)).toBe(0.0);
    expect(computeFieldConfidence("abc12345", schema)).toBe(0.0); // case
    expect(computeFieldConfidence("ABC123", schema)).toBe(0.0); // too short
  });

  it("ignores malformed regex (doesn't false-flag schema-author bugs)", () => {
    // An invalid regex shouldn't cascade into every extraction looking suspicious.
    const bad = { type: "string", pattern: "[unclosed" };
    expect(computeFieldConfidence("anything", bad)).toBe(1.0);
  });
});

describe("computeFieldConfidence — string without pattern", () => {
  const schema = { type: "string" };

  it("scores 1.0 when non-empty and provenance confirms a hit", () => {
    expect(computeFieldConfidence("Acme Corp", schema, FOUND)).toBe(1.0);
  });

  it("scores 0.7 when non-empty but provenance does not confirm a hit", () => {
    // Either no provenance map was passed, or the resolver returned null,
    // or the offset is negative AND the chunk is empty — all collapse to
    // "no hit".
    expect(computeFieldConfidence("Acme Corp", schema)).toBe(0.7);
    expect(computeFieldConfidence("Acme Corp", schema, null)).toBe(0.7);
    expect(computeFieldConfidence("Acme Corp", schema, NOT_FOUND)).toBe(0.7);
  });

  it("counts form-extract coordinate provenance (offset=-1, chunk set) as a hit", () => {
    // Form-extract sets offset=-1 because there is no source markdown to
    // index against — the chunk is the coordinate-extracted text and is
    // proof the value came from the document.
    const formProv: ProvenanceSpan = {
      offset: -1,
      length: 0,
      chunk: "Acme Corp",
      page: 1,
    };
    expect(computeFieldConfidence("Acme Corp", schema, formProv)).toBe(1.0);
  });

  it("scores 0.0 when string is empty", () => {
    expect(computeFieldConfidence("", schema, FOUND)).toBe(0.0);
    expect(computeFieldConfidence("", schema)).toBe(0.0);
  });

  it("treats unknown field types as free-text strings (no false-flagging)", () => {
    expect(computeFieldConfidence("value", { type: "weird_unknown_type" }, FOUND)).toBe(1.0);
    expect(computeFieldConfidence("value", undefined, FOUND)).toBe(1.0);
  });
});

describe("computeFieldConfidence — null / absent value", () => {
  it("scores 1.0 for null when the schema does not mark the field required", () => {
    expect(computeFieldConfidence(null, { type: "string" })).toBe(1.0);
    expect(computeFieldConfidence(undefined, { type: "string" })).toBe(1.0);
    expect(computeFieldConfidence(null, { type: "number" })).toBe(1.0);
    expect(computeFieldConfidence(null, { type: "date" })).toBe(1.0);
  });

  it("scores 0.0 for null when the field is required", () => {
    expect(
      computeFieldConfidence(null, { type: "string", required: true }),
    ).toBe(0.0);
    expect(
      computeFieldConfidence(undefined, { type: "string", required: true }),
    ).toBe(0.0);
  });

  it("credits an optional null regardless of provenance (legitimately absent)", () => {
    expect(computeFieldConfidence(null, { type: "string" }, null)).toBe(1.0);
    expect(computeFieldConfidence(null, { type: "string" }, FOUND)).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Aggregation helpers — what process.ts actually calls
// ---------------------------------------------------------------------------

describe("computeFieldConfidences (schema sweep)", () => {
  it("scores every schema field, even ones the LLM returned null for", () => {
    const schemaDef = {
      fields: {
        name: { type: "string" },
        amount: { type: "number" },
        status: { type: "enum", options: ["active", "inactive"] },
        missing_optional: { type: "string" },
      },
    };
    const extracted = {
      name: "Acme",
      amount: 1000,
      status: "active",
      missing_optional: null,
    };
    const scores = computeFieldConfidences(schemaDef, extracted, {
      name: FOUND,
      amount: FOUND,
      status: FOUND,
      missing_optional: null,
    });
    expect(scores.name).toBe(1.0); // string w/ provenance
    expect(scores.amount).toBe(0.5); // number, no range
    expect(scores.status).toBe(1.0); // enum match
    expect(scores.missing_optional).toBe(1.0); // optional null
  });

  it("handles missing provenance map gracefully", () => {
    const schemaDef = { fields: { name: { type: "string" } } };
    const scores = computeFieldConfidences(schemaDef, { name: "Acme" });
    expect(scores.name).toBe(0.7); // string, non-empty, no provenance
  });

  it("returns empty object when schema has no fields", () => {
    expect(computeFieldConfidences({}, {})).toEqual({});
    expect(computeFieldConfidences(undefined, {})).toEqual({});
  });
});

describe("aggregateDocConfidence (strict min)", () => {
  it("returns the minimum field score (strict aggregation)", () => {
    expect(aggregateDocConfidence({ a: 1.0, b: 0.7, c: 0.5 })).toBe(0.5);
    expect(aggregateDocConfidence({ a: 1.0, b: 1.0 })).toBe(1.0);
  });

  it("returns null for an empty score set", () => {
    expect(aggregateDocConfidence({})).toBeNull();
  });

  it("ignores non-finite scores (defense-in-depth)", () => {
    expect(aggregateDocConfidence({ a: 1.0, b: NaN, c: 0.5 })).toBe(0.5);
  });

  it("returns 0.0 when at least one field scores 0", () => {
    expect(aggregateDocConfidence({ a: 1.0, b: 0.0 })).toBe(0.0);
  });
});

describe("findLowestField", () => {
  it("returns the worst-scoring field below the threshold", () => {
    const scores = { a: 1.0, b: 0.5, c: 0.7 };
    const lowest = findLowestField(scores, 0.85);
    expect(lowest).toEqual({ name: "b", confidence: 0.5 });
  });

  it("returns null when every field is at or above the threshold", () => {
    const scores = { a: 1.0, b: 0.9 };
    expect(findLowestField(scores, 0.85)).toBeNull();
  });

  it("returns null for an empty score set", () => {
    expect(findLowestField({}, 0.85)).toBeNull();
  });
});
