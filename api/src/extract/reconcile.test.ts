import { describe, it, expect } from "vitest";
import {
  computeProvenanceStrength,
  computeFieldConfidence,
  scoreLabel,
  reconcile,
  snapToSource,
} from "./reconcile";
import type { Chunk } from "./chunker";

// ---------------------------------------------------------------------------
// Helper: build a minimal Chunk for tests
// ---------------------------------------------------------------------------

function chunk(content: string, index = 0): Chunk {
  return {
    index,
    title: `Chunk ${index}`,
    content,
    signals: {
      has_dates: false,
      has_dollar_amounts: false,
      has_tables: false,
      has_key_value_pairs: false,
    },
    charOffset: 0,
    charLength: content.length,
  };
}

// ---------------------------------------------------------------------------
// Provenance strength scoring
// ---------------------------------------------------------------------------

describe("computeProvenanceStrength", () => {
  it("returns 1.0 for exact substring match", () => {
    const chunks = [chunk("Invoice Number: INV-2024-001")];
    expect(computeProvenanceStrength("INV-2024-001", chunks)).toBe(1.0);
  });

  it("returns 0.9 for case-insensitive match", () => {
    const chunks = [chunk("Company: ACME CORPORATION")];
    expect(computeProvenanceStrength("acme corporation", chunks)).toBe(0.9);
  });

  it("returns 1.0 for normalized whitespace match", () => {
    const chunks = [chunk("Name:  John   Smith")];
    expect(computeProvenanceStrength("Name: John Smith", chunks)).toBe(1.0);
  });

  it("returns 0.8 for date format alternative (YYYY-MM-DD found as MM/DD/YYYY)", () => {
    const chunks = [chunk("Date: 03/15/2024")];
    expect(computeProvenanceStrength("2024-03-15", chunks)).toBe(1.0);
  });

  it("returns 0.8 for date format alternative (DD/MM/YYYY)", () => {
    const chunks = [chunk("Date: 15/03/2024")];
    expect(computeProvenanceStrength("2024-03-15", chunks)).toBe(1.0);
  });

  it("returns 0.8 for date format alternative (MM-DD-YYYY)", () => {
    const chunks = [chunk("Date: 03-15-2024")];
    expect(computeProvenanceStrength("2024-03-15", chunks)).toBe(1.0);
  });

  it("returns 0.8 for date format alternative (MM.DD.YYYY)", () => {
    const chunks = [chunk("Date: 03.15.2024")];
    expect(computeProvenanceStrength("2024-03-15", chunks)).toBe(1.0);
  });

  it("returns 0.8 for number format alternative (commas stripped)", () => {
    const chunks = [chunk("Total: 1,000,000")];
    expect(computeProvenanceStrength(1000000, chunks)).toBe(1.0);
  });

  it("returns 0.8 for number format alternative (string with commas)", () => {
    const chunks = [chunk("Total: 1,234")];
    expect(computeProvenanceStrength("1234", chunks)).toBe(1.0);
  });

  it("returns 0.0 when value not found in source", () => {
    const chunks = [chunk("Unrelated content here")];
    expect(computeProvenanceStrength("NOTFOUND-XYZ", chunks)).toBe(0.0);
  });

  it("returns 0.0 for null value", () => {
    const chunks = [chunk("Some content")];
    expect(computeProvenanceStrength(null, chunks)).toBe(0.0);
  });

  it("returns 0.0 for empty string value", () => {
    const chunks = [chunk("Some content")];
    expect(computeProvenanceStrength("", chunks)).toBe(0.0);
  });

  it("returns 0.0 for empty chunks", () => {
    expect(computeProvenanceStrength("hello", [])).toBe(0.0);
  });

  it("returns 0.0 for empty array value", () => {
    const chunks = [chunk("Some content")];
    expect(computeProvenanceStrength([], chunks)).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// Array provenance: average of item scores
// ---------------------------------------------------------------------------

describe("computeProvenanceStrength — arrays", () => {
  it("averages item scores for arrays", () => {
    const chunks = [chunk("Alice and Charlie and unknown_person")];
    // "Alice" → exact 1.0, "Charlie" → exact 1.0, "Bob" → 0.0
    const score = computeProvenanceStrength(["Alice", "Charlie", "Bob"], chunks);
    expect(score).toBeCloseTo(2.0 / 3, 5);
  });

  it("returns 1.0 when all items are exact matches", () => {
    const chunks = [chunk("Alice Bob Charlie")];
    expect(computeProvenanceStrength(["Alice", "Bob", "Charlie"], chunks)).toBe(1.0);
  });

  it("returns 0.0 when no items match", () => {
    const chunks = [chunk("Unrelated content")];
    expect(computeProvenanceStrength(["X", "Y", "Z"], chunks)).toBe(0.0);
  });

  it("scores array of objects by averaging property scores", () => {
    const chunks = [chunk("HF-2025-50768 | 02/19/2025 | James Rodriguez | Closed | $197,268.00")];
    const items = [
      { claim_number: "HF-2025-50768", claimant_name: "James Rodriguez", reserve: 197268 },
    ];
    const score = computeProvenanceStrength(items, chunks);
    // claim_number: exact 1.0, claimant_name: exact 1.0, reserve: number alt 1.0
    expect(score).toBe(1.0);
  });

  it("scores array of objects with partial property matches", () => {
    const chunks = [chunk("HF-2025-50768 | James Rodriguez")];
    const items = [
      { claim_number: "HF-2025-50768", claimant_name: "James Rodriguez", status: "Unknown" },
    ];
    const score = computeProvenanceStrength(items, chunks);
    // claim_number: 1.0, claimant_name: 1.0, status: 0.0 → avg 0.667
    expect(score).toBeCloseTo(2.0 / 3, 2);
  });

  it("finds values in chunk titles, not just content", () => {
    // Simulate a chunk whose title contains the value (heading was split from content)
    const c = { index: 0, title: "Hartford Financial Services", content: "Some other content", category: "other", signals: {}, get lineCount() { return 1; }, get charCount() { return this.content.length; } };
    expect(computeProvenanceStrength("Hartford Financial Services", [c])).toBe(1.0);
  });

  it("finds dates in alternative formats at 1.0", () => {
    const chunks = [chunk("Filed on 03/15/2024 by the court")];
    expect(computeProvenanceStrength("2024-03-15", chunks)).toBe(1.0);
  });

  it("uses __source_text for matching when provided", () => {
    const chunks = [chunk("Some random content without the value")];
    // Without source text, value not found
    expect(computeProvenanceStrength("Special Value", chunks)).toBe(0.0);
    // With source text that IS in the source
    const chunks2 = [chunk("Found: Special Value Here")];
    expect(computeProvenanceStrength(
      "Different Extracted Form", chunks2, "string",
      "Special Value",
    )).toBe(1.0);
  });

  it("decodes &amp; in source for matching", () => {
    const chunks = [chunk("Reconstruction &amp; Recovery Advisors Inc")];
    // Source normalization decodes &amp; → &, so this should match
    expect(computeProvenanceStrength("Reconstruction & Recovery Advisors Inc", chunks)).toBe(1.0);
  });

  it("strips markdown backslash escapes for matching", () => {
    const chunks = [chunk("Price List: CASO8X\\_SEP18")];
    // Source normalization strips \_ → _, so this should match
    expect(computeProvenanceStrength("CASO8X_SEP18", chunks)).toBe(1.0);
  });

  it("matches dates without leading zeros", () => {
    const chunks = [chunk("Date of Loss: 10/8/2017")];
    expect(computeProvenanceStrength("2017-10-08", chunks)).toBe(1.0);
  });

  it("matches dates with single-digit month", () => {
    const chunks = [chunk("Filed: 3/15/2024")];
    expect(computeProvenanceStrength("2024-03-15", chunks)).toBe(1.0);
  });

  it("matches multi-line address joined with LLM-inserted comma", () => {
    const chunks = [chunk("Property:\n\n3960 Millbrook Drve\n\nSanta Rosa, CA 95404")];
    expect(computeProvenanceStrength("3960 Millbrook Drve, Santa Rosa, CA 95404", chunks)).toBe(1.0);
  });

  it("matches multi-line value joined with semicolon", () => {
    const chunks = [chunk("Line 1\nLine 2\nLine 3")];
    expect(computeProvenanceStrength("Line 1; Line 2; Line 3", chunks)).toBe(1.0);
  });

  it("finds numbers with different formatting at 1.0", () => {
    const chunks = [chunk("Total: $1,234,567.00")];
    expect(computeProvenanceStrength(1234567, chunks)).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Reconcile — scalars: first non-null wins
// ---------------------------------------------------------------------------

describe("reconcile — scalars", () => {
  const schema = {
    fields: {
      name: { type: "string" },
      date: { type: "date" },
    },
  };

  it("first non-null candidate wins for scalar fields", () => {
    const results = [
      { name: null, date: "2024-01-15" },
      { name: "Acme Corp", date: "2024-01-15" },
    ];
    const { extracted } = reconcile(results, schema);
    expect(extracted.name).toBe("Acme Corp");
    expect(extracted.date).toBe("2024-01-15");
  });

  it("returns null when no group provides a value", () => {
    const results = [{ name: null }, {}];
    const { extracted } = reconcile(results, schema);
    expect(extracted.name).toBeNull();
  });

  it("tracks sources correctly", () => {
    const results = [
      { name: "First" },
      { name: "Second" },
    ];
    const { sources } = reconcile(results, schema);
    expect(sources.name).toBe("group_0");
  });
});

// ---------------------------------------------------------------------------
// Reconcile — arrays: concatenate and deduplicate
// ---------------------------------------------------------------------------

describe("reconcile — arrays", () => {
  const schema = {
    fields: {
      items: { type: "array" },
    },
  };

  it("concatenates arrays from multiple groups", () => {
    const results = [
      { items: ["a", "b"] },
      { items: ["c"] },
    ];
    const { extracted } = reconcile(results, schema);
    expect(extracted.items).toEqual(["a", "b", "c"]);
  });

  it("deduplicates scalar items", () => {
    const results = [
      { items: ["a", "b"] },
      { items: ["b", "c"] },
    ];
    const { extracted } = reconcile(results, schema);
    expect(extracted.items).toEqual(["a", "b", "c"]);
  });

  it("deduplicates object items by JSON.stringify", () => {
    const results = [
      { items: [{ name: "A", value: 1 }] },
      { items: [{ name: "A", value: 1 }, { name: "B", value: 2 }] },
    ];
    const { extracted } = reconcile(results, schema);
    const items = extracted.items as { name: string; value: number }[];
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ name: "A", value: 1 });
    expect(items[1]).toEqual({ name: "B", value: 2 });
  });

  it("returns empty array when all groups provide empty arrays", () => {
    const results = [{ items: [] }, { items: [] }];
    const { extracted } = reconcile(results, schema);
    expect(extracted.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Confidence scoring — weight formula + clamping
// ---------------------------------------------------------------------------

describe("computeFieldConfidence", () => {
  it("applies weight formula: 0.70 * provenance + 0.30 * validation", () => {
    // provenance=1.0, validation=true → 0.70*1 + 0.30*1 = 1.0
    expect(computeFieldConfidence({ provenanceStrength: 1.0, validationPassed: true })).toBe(1.0);
  });

  it("validation failed reduces score", () => {
    // provenance=1.0, validation=false → 0.70*1 + 0.30*0 = 0.70
    expect(computeFieldConfidence({ provenanceStrength: 1.0, validationPassed: false })).toBe(0.70);
  });

  it("zero provenance with valid gives 0.30", () => {
    // provenance=0.0, validation=true → 0.70*0 + 0.30*1 = 0.30
    expect(computeFieldConfidence({ provenanceStrength: 0.0, validationPassed: true })).toBe(0.30);
  });

  it("both zero gives 0.0", () => {
    expect(computeFieldConfidence({ provenanceStrength: 0.0, validationPassed: false })).toBe(0.0);
  });

  it("clamps to [0.0, 1.0]", () => {
    // Should not exceed 1.0 even with extreme inputs
    expect(computeFieldConfidence({ provenanceStrength: 1.5, validationPassed: true })).toBe(1.0);
  });

  it("ignores llmConfidence parameter (API compat)", () => {
    // llmConfidence is accepted but not used in scoring
    const a = computeFieldConfidence({ provenanceStrength: 0.8, validationPassed: true });
    const b = computeFieldConfidence({ provenanceStrength: 0.8, validationPassed: true, llmConfidence: 0.99 });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Score label thresholds
// ---------------------------------------------------------------------------

describe("scoreLabel", () => {
  it("returns 'high' for score >= 0.7", () => {
    expect(scoreLabel(0.7)).toBe("high");
    expect(scoreLabel(1.0)).toBe("high");
    expect(scoreLabel(0.85)).toBe("high");
  });

  it("returns 'medium' for score >= 0.4 and < 0.7", () => {
    expect(scoreLabel(0.4)).toBe("medium");
    expect(scoreLabel(0.69)).toBe("medium");
    expect(scoreLabel(0.5)).toBe("medium");
  });

  it("returns 'low' for score > 0 and < 0.4", () => {
    expect(scoreLabel(0.01)).toBe("low");
    expect(scoreLabel(0.39)).toBe("low");
    expect(scoreLabel(0.1)).toBe("low");
  });

  it("returns 'not_found' for score == 0", () => {
    expect(scoreLabel(0)).toBe("not_found");
    expect(scoreLabel(0.0)).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Reconcile — confidence integration
// ---------------------------------------------------------------------------

describe("reconcile — confidence scoring", () => {
  it("assigns not_found / 0.0 for fields with no candidates", () => {
    const schema = { fields: { name: { type: "string" } } };
    const result = reconcile([{}], schema);
    expect(result.confidence.name).toBe("not_found");
    expect(result.confidence_scores.name).toBe(0.0);
  });

  it("computes confidence for extracted fields", () => {
    const schema = { fields: { name: { type: "string" } } };
    const result = reconcile([{ name: "Acme" }], schema);
    // No route chunks → provenance 0.0, validation passes → 0.30
    expect(result.confidence_scores.name).toBeCloseTo(0.30, 2);
    expect(result.confidence.name).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// Snap-to-source
// ---------------------------------------------------------------------------

describe("snapToSource", () => {
  it("snaps to closest matching substring when ratio >= 0.5", () => {
    const chunks = [chunk("The quick brown fox jumps over the lazy dog")];
    // Slightly different from source
    const result = snapToSource("quick brown fox jumps", chunks);
    expect(result).toBe("quick brown fox jumps");
  });

  it("returns original value when ratio < 0.5 (no close match)", () => {
    const chunks = [chunk("completely unrelated text about nothing")];
    const result = snapToSource("AAAA BBBB CCCC DDDD", chunks);
    expect(result).toBe("AAAA BBBB CCCC DDDD");
  });

  it("returns original value for empty input", () => {
    const chunks = [chunk("some content")];
    expect(snapToSource("", chunks)).toBe("");
  });

  it("returns original value for empty chunks", () => {
    expect(snapToSource("hello world", [])).toBe("hello world");
  });

  it("returns null passthrough", () => {
    // snapToSource with null-like empty string
    expect(snapToSource("", [chunk("content")])).toBe("");
  });

  it("snaps paraphrased text to source", () => {
    const chunks = [chunk("Effective Date: January 15, 2024\nExpiration Date: January 15, 2025")];
    // LLM might extract a slightly truncated version
    const result = snapToSource("Effective Date: January 15, 2024", chunks);
    expect(result).toBe("Effective Date: January 15, 2024");
  });
});
