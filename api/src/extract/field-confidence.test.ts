/**
 * Tests for the per-field deterministic confidence scorer.
 *
 * One describe block per field type covers every branch of the scoring
 * matrix documented in `field-confidence.ts`. The final block covers the
 * helper functions `resolveFieldConfidences` and `aggregateDocConfidence`
 * which the routing layer in `ingestion/process.ts` actually consumes.
 */

import { describe, it, expect } from "vitest";
import {
  computeFieldConfidence,
  resolveFieldConfidences,
  aggregateDocConfidence,
  findLowestField,
  elementValidationRate,
  hasDeclaredElementShape,
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

describe("resolveFieldConfidences (engine scores + schema sweep)", () => {
  it("uses the engine's score verbatim for non-null values", () => {
    const schemaDef = {
      fields: {
        coverages: { type: "array", items: { type: "object", properties: { limit: { type: "string" } } } },
        name: { type: "string" },
      },
    };
    const extracted = {
      coverages: [{ limit: "$1,000,000" }],
      name: "Acme",
    };
    const scores = resolveFieldConfidences(schemaDef, extracted, {
      coverages: 0.93,
      name: 1.0,
    });
    expect(scores.coverages).toBe(0.93);
    expect(scores.name).toBe(1.0);
  });

  it("re-credits optional nulls the engine scored 0.0 as not_found", () => {
    const schemaDef = {
      fields: {
        required_field: { type: "string", required: true },
        optional_field: { type: "string" },
      },
    };
    const extracted = { required_field: null, optional_field: null };
    const scores = resolveFieldConfidences(schemaDef, extracted, {
      required_field: 0.0,
      optional_field: 0.0,
    });
    expect(scores.required_field).toBe(0.0); // required null still flags
    expect(scores.optional_field).toBe(1.0); // optional null is not a review reason
  });

  it("treats an empty array like a null: optional [] → 1.0, required [] → 0.0 (oss-444)", () => {
    const schemaDef = {
      fields: {
        required_list: { type: "array", required: true, items: { type: "string" } },
        optional_list: { type: "array", items: { type: "string" } },
      },
    };
    const extracted = { required_list: [], optional_list: [] };
    // The engine scores an empty array 0.30 (prov 0.0, val "passed") — that
    // number must NOT be used verbatim for the "no value" case.
    const scores = resolveFieldConfidences(schemaDef, extracted, {
      required_list: 0.3,
      optional_list: 0.3,
    });
    expect(scores.required_list).toBe(0.0); // required empty list flags (symmetric with null)
    expect(scores.optional_list).toBe(1.0); // optional empty list auto-delivers
  });

  it("does not disturb non-empty arrays — engine score used verbatim", () => {
    const schemaDef = {
      fields: {
        coverages: { type: "array", items: { type: "object", properties: { limit: { type: "string" } } } },
      },
    };
    const extracted = { coverages: [{ limit: "$1,000,000" }] };
    const scores = resolveFieldConfidences(schemaDef, extracted, { coverages: 0.87 });
    expect(scores.coverages).toBe(0.87);
  });

  it("scores an empty optional array from the schema even with no engine score", () => {
    const schemaDef = {
      fields: {
        tags: { type: "array", items: { type: "string" } },
        codes: { type: "array", required: true, items: { type: "string" } },
      },
    };
    const scores = resolveFieldConfidences(schemaDef, { tags: [], codes: [] }, null);
    expect(scores.tags).toBe(1.0);
    expect(scores.codes).toBe(0.0);
  });

  it("a doc whose only low field is an optional empty array does not route to review", () => {
    const schemaDef = {
      fields: {
        name: { type: "string" },
        endorsements: { type: "array", items: { type: "string" } },
      },
    };
    const extracted = { name: "Acme", endorsements: [] };
    const scores = resolveFieldConfidences(schemaDef, extracted, {
      name: 1.0,
      endorsements: 0.3, // engine's empty-array score
    });
    const docConfidence = aggregateDocConfidence(scores);
    expect(docConfidence).toBe(1.0);
    // Default review threshold 0.9 → nothing below it → no review.
    expect(findLowestField(scores, 0.9)).toBeNull();
  });

  it("falls back to the deterministic scorer when the engine has no score", () => {
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
    const scores = resolveFieldConfidences(schemaDef, extracted, null, {
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

  it("handles missing provenance map gracefully on the fallback path", () => {
    const schemaDef = { fields: { name: { type: "string" } } };
    const scores = resolveFieldConfidences(schemaDef, { name: "Acme" }, {});
    expect(scores.name).toBe(0.7); // string, non-empty, no provenance
  });

  it("ignores non-finite engine scores", () => {
    const schemaDef = { fields: { name: { type: "string" } } };
    const scores = resolveFieldConfidences(schemaDef, { name: "Acme" }, {
      name: Number.NaN,
    });
    expect(scores.name).toBe(0.7); // fallback, not NaN
  });

  it("returns empty object when schema has no fields", () => {
    expect(resolveFieldConfidences({}, {}, {})).toEqual({});
    expect(resolveFieldConfidences(undefined, {}, null)).toEqual({});
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

// ---------------------------------------------------------------------------
// array / object confidence (oss-338) — arrays used to fall through to the
// string scorer and always return 0.0, tripping review on every array field.
// ---------------------------------------------------------------------------

describe("computeFieldConfidence — array", () => {
  const schema = {
    type: "array",
    items: {
      type: "object",
      properties: {
        coverage_code: { type: "string" },
        limit: { type: "string" },
      },
    },
  };

  // Per-element + per-property provenance, as the resolver produces it.
  const prov: ProvenanceSpan = {
    offset: 10,
    length: 5,
    items: [
      { offset: 10, length: 5, properties: { coverage_code: { offset: 10, length: 3 }, limit: { offset: 20, length: 4 } } },
      { offset: 40, length: 5, properties: { coverage_code: { offset: 40, length: 3 }, limit: { offset: 50, length: 4 } } },
    ],
  };

  it("does NOT return 0 for a correct, located array (the bug)", () => {
    const value = [
      { coverage_code: "GL", limit: "$1,000,000" },
      { coverage_code: "PROP", limit: "$2,000,000" },
    ];
    // Every property located → each element 1.0 → mean 1.0.
    expect(computeFieldConfidence(value, schema, prov)).toBe(1.0);
  });

  it("aggregates element confidences by mean", () => {
    const value = [
      { coverage_code: "GL", limit: "$1,000,000" }, // located → 1.0
      { coverage_code: "PROP", limit: "$2,000,000" }, // no per-item prov → soft
    ];
    // Second element has no provenance items[1]? It does here; drop it to force a soft score.
    const partialProv: ProvenanceSpan = { offset: 10, length: 5, items: [prov.items![0]!] };
    const score = computeFieldConfidence(value, schema, partialProv);
    // elem0 = 1.0 (located), elem1 = mean(0.7, 0.7) = 0.7 → mean(1.0, 0.7) = 0.85
    expect(score).toBeCloseTo(0.85, 3);
  });

  it("soft-scores a located-but-unresolved array instead of zero", () => {
    const value = [{ coverage_code: "GL", limit: "$1,000,000" }];
    // No provenance at all → each property 0.7 → element 0.7 → array 0.7.
    expect(computeFieldConfidence(value, schema, null)).toBe(0.7);
  });

  it("scores an empty array as not-found (0 if required, else 1)", () => {
    expect(computeFieldConfidence([], { type: "array", required: true })).toBe(0.0);
    expect(computeFieldConfidence([], { type: "array" })).toBe(1.0);
  });

  it("handles arrays of scalars via the element scorer", () => {
    const strArr = { type: "array", items: { type: "string" } };
    const p: ProvenanceSpan = { offset: 1, length: 1, items: [FOUND, FOUND] };
    expect(computeFieldConfidence(["a", "b"], strArr, p)).toBe(1.0);
  });
});

describe("computeFieldConfidence — object", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, code: { type: "string" } },
  };

  it("scores the mean of located sub-fields instead of zero", () => {
    const value = { name: "Acme", code: "GL" };
    const prov: ProvenanceSpan = { offset: 0, length: 1, properties: { name: FOUND, code: FOUND } };
    expect(computeFieldConfidence(value, schema, prov)).toBe(1.0);
  });

  it("soft-scores unresolved sub-fields (0.7) rather than 0", () => {
    const value = { name: "Acme", code: "GL" };
    expect(computeFieldConfidence(value, schema, null)).toBe(0.7);
  });
});

// ---------------------------------------------------------------------------
// Array validation term (oss-504)
// ---------------------------------------------------------------------------

describe("elementValidationRate — the validation term arrays never had", () => {
  const COVERAGES = {
    type: "array",
    items: {
      type: "object",
      properties: {
        coverage_name: { type: "string" },
        limit: { type: "number" },
        effective_date: { type: "date" },
        status: { type: "enum", options: ["active", "expired"] },
      },
    },
  };

  it("returns null when there is nothing to check", () => {
    expect(elementValidationRate("not an array", COVERAGES)).toBeNull();
    // `type: array` with no declared element shape — nothing to validate.
    expect(elementValidationRate([{ a: 1 }], { type: "array" })).toBeNull();
    // An empty array is scored as absence elsewhere, not as a failed check.
    expect(elementValidationRate([], COVERAGES)).toBeNull();
  });

  it("returns 1.0 when every declared sub-field satisfies its type", () => {
    const rate = elementValidationRate(
      [
        { coverage_name: "General Liability", limit: 1000000, effective_date: "2026-01-01", status: "active" },
        { coverage_name: "Property", limit: 500000, effective_date: "2026-03-15", status: "expired" },
      ],
      COVERAGES,
    );
    expect(rate).toBe(1.0);
  });

  it("returns 0.0 when every declared sub-field violates its type", () => {
    // This is the case the engine used to score as a full pass: `true`,
    // hardcoded, because "arrays skip type validation".
    const rate = elementValidationRate(
      [
        { coverage_name: "", limit: "see endorsement", effective_date: "whenever", status: "banana" },
        { coverage_name: "", limit: "n/a", effective_date: "soon", status: "kiwi" },
      ],
      COVERAGES,
    );
    expect(rate).toBe(0.0);
  });

  it("grades a partial failure rather than collapsing it to pass/fail", () => {
    // Row 1 clean (4/4), row 2 has a bad limit and a bad status (2/4).
    const rate = elementValidationRate(
      [
        { coverage_name: "General Liability", limit: 1000000, effective_date: "2026-01-01", status: "active" },
        { coverage_name: "Property", limit: "included", effective_date: "2026-03-15", status: "banana" },
      ],
      COVERAGES,
    );
    expect(rate).toBe(0.75); // mean(1.0, 0.5)
  });

  it("does not treat an absent sub-field as a type failure", () => {
    // Absence is scored as absence (required/optional) elsewhere. A model that
    // correctly declines to invent a limit must not be penalized here.
    const rate = elementValidationRate(
      [{ coverage_name: "General Liability", limit: null, effective_date: undefined }],
      COVERAGES,
    );
    expect(rate).toBe(1.0);
  });

  it("checks scalar elements against the declared item type", () => {
    const schema = { type: "array", items: { type: "date" } };
    expect(elementValidationRate(["2026-01-01", "2026-02-01"], schema)).toBe(1.0);
    expect(elementValidationRate(["2026-01-01", "nonsense"], schema)).toBe(0.5);
  });

  it("recognizes the array-of-object shorthand (properties on the field)", () => {
    const shorthand = { type: "array", properties: { limit: { type: "number" } } };
    expect(hasDeclaredElementShape(shorthand)).toBe(true);
    expect(elementValidationRate([{ limit: "nope" }], shorthand)).toBe(0.0);
  });
});
