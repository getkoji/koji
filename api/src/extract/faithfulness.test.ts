import { describe, it, expect } from "vitest";
import { nullUnanchoredNumerics } from "./faithfulness";
import { numericAnchoredInText, findNumericInRegion } from "./provenance";

describe("numericAnchoredInText", () => {
  it("matches a standalone number and its formatted variants", () => {
    expect(numericAnchoredInText("Building | $50,000", 50000)).toBe(true);
    expect(numericAnchoredInText("Limit: 50000", 50000)).toBe(true);
    expect(numericAnchoredInText("Each Occurrence $1,000,000", 1000000)).toBe(true);
  });

  it("does NOT match a number embedded inside a larger number", () => {
    // The core case: a fabricated deductible of 0 must not anchor to the
    // zeros inside "$50,000".
    expect(numericAnchoredInText("BUILDING STRETCH Blanket Limit: $50,000", 0)).toBe(false);
    // "$1,000" must not match inside "$1,000,000".
    expect(numericAnchoredInText("Aggregate $1,000,000", 1000)).toBe(false);
  });

  it("matches a genuine printed zero", () => {
    expect(numericAnchoredInText("Business Personal Property | $0", 0)).toBe(true);
    expect(findNumericInRegion("Tenant's Improvements: 0", 0)).not.toBeNull();
  });

  it("compares numerically across format differences (integer vs decimal)", () => {
    // Regression: an integer value must match a decimal-formatted source and
    // vice versa — the row text often prints "$9.00" for the value 9.
    expect(numericAnchoredInText("TOTAL: $9.00", 9)).toBe(true);
    expect(numericAnchoredInText("Amount 70.30", 70.3)).toBe(true);
    expect(numericAnchoredInText("Balance Due $1,234.56", 1234.56)).toBe(true);
    // ...but a genuinely different number still fails.
    expect(numericAnchoredInText("TOTAL: $9.00", 90)).toBe(false);
  });
});

describe("nullUnanchoredNumerics — array rows", () => {
  it("nulls a fabricated deductible/premium but keeps the anchored limit", () => {
    const parsed = {
      coverages: [
        {
          label: "Property Coverage Part",
          coverage_code: "property",
          limits: [
            {
              applies_to_raw: "Building",
              applies_to: ["building"],
              limit: 50000,
              deductible: 0,
              premium: 0,
              __source_text: "BUILDING STRETCH | ® | Blanket Limit: $50,000",
            },
          ],
        },
      ],
    };

    const nulled = nullUnanchoredNumerics(parsed);

    const row = parsed.coverages[0]!.limits[0] as Record<string, unknown>;
    expect(row.limit).toBe(50000); // anchored → kept
    expect(row.deductible).toBeNull(); // fabricated → nulled
    expect(row.premium).toBeNull(); // fabricated → nulled
    expect(nulled.map((n) => n.path).sort()).toEqual([
      "coverages[0].limits[0].deductible",
      "coverages[0].limits[0].premium",
    ]);
    // non-numeric fields untouched
    expect(row.applies_to).toEqual(["building"]);
    expect(row.applies_to_raw).toBe("Building");
  });

  it("keeps a genuine printed $0 in its row", () => {
    const parsed = {
      coverages: [
        {
          limits: [
            {
              applies_to_raw: "Tenant's Improvements and Betterments",
              limit: 0,
              __source_text: "Tenant's Improvements and Betterments | $0",
            },
          ],
        },
      ],
    };
    nullUnanchoredNumerics(parsed);
    expect((parsed.coverages[0]!.limits[0] as Record<string, unknown>).limit).toBe(0);
  });

  it("keeps values when the row cites no source text (cannot verify)", () => {
    const parsed = {
      coverages: [{ limits: [{ limit: 1234, deductible: 0 }] }],
    };
    const nulled = nullUnanchoredNumerics(parsed);
    expect(nulled).toHaveLength(0);
    expect((parsed.coverages[0]!.limits[0] as Record<string, unknown>).deductible).toBe(0);
  });
});

describe("nullUnanchoredNumerics — top-level scalars", () => {
  it("verifies each scalar against its own __source_text map entry", () => {
    const parsed = {
      premium: 65355,
      building_count: 19,
      __source_text: {
        premium: "TOTAL PREMIUM: $65,355*",
        // building_count deliberately absent from the doc → model invented 19
      },
    };
    const nulled = nullUnanchoredNumerics(parsed);
    expect(parsed.premium).toBe(65355); // anchored → kept
    // building_count HAS no map entry → cannot verify → kept (conservative)
    expect(parsed.building_count).toBe(19);
    expect(nulled).toHaveLength(0);
  });

  it("nulls a scalar whose cited text does not contain it", () => {
    const parsed = {
      premium: 99999,
      __source_text: { premium: "TOTAL PREMIUM: $65,355*" },
    };
    const nulled = nullUnanchoredNumerics(parsed);
    expect(parsed.premium).toBeNull();
    expect(nulled).toEqual([{ path: "premium", value: 99999 }]);
  });
});

describe("nullUnanchoredNumerics — safety", () => {
  it("does not touch strings, booleans, or string arrays", () => {
    const parsed = {
      policy_number: "22 SBA BL5DHM",
      active: true,
      tags: ["a", "b"],
      __source_text: { policy_number: "Policy Number: 22 SBA BL5DHM" },
    };
    const before = JSON.stringify(parsed);
    const nulled = nullUnanchoredNumerics(parsed);
    expect(nulled).toHaveLength(0);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it("handles empty / meta-only objects without throwing", () => {
    expect(nullUnanchoredNumerics({})).toEqual([]);
    expect(nullUnanchoredNumerics({ __source_text: {} })).toEqual([]);
  });
});
