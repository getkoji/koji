/**
 * Form-table grammar interpreter tests (oss-367).
 *
 * Region snippets are real parser output shapes observed in production
 * documents: a run-on line where several table rows flattened into one line, a
 * pipe-table with per-row cells, blank-amount rows, and "INCL" premiums.
 */
import { describe, it, expect } from "vitest";
import { runFormTableSpec, seedRowsMerge, applyFormTables, type FormTableSpec } from "./form-tables";

const SPEC: FormTableSpec = {
  id: "premium_summary",
  detect: "SUMMARY OF PREMIUMS CHARGED",
  anchor: "SUMMARY OF PREMIUMS CHARGED",
  end: "ANNUAL TOTAL",
  field: "parts",
  row: {
    pattern:
      "(?<label>[A-Z][A-Za-z /&']+?(?:Coverage Part|Coverage Plus|Coverage|WRONGFUL ACTS|SIGNS))\\s*(?:W/\\w+\\s*)?\\$\\s*(?<amount>[\\d,]+|INCL)?",
    require: ["label"],
    skip_when_blank: ["amount"],
  },
  set: {
    label: "{label}",
    code: { resolve: "{label}", via: "code" },
    premium: { money: "{amount}", null_tokens: ["INCL"] },
  },
};

const FIELD_SPEC = {
  type: "array",
  hints: { element_key: "code" },
  items: {
    type: "object",
    properties: {
      code: {
        type: "mapping",
        mappings: {
          property: ["Commercial Property"],
          general_liability: ["Commercial General Liability", "General Liability"],
          auto: ["Commercial Auto"],
          umbrella: ["Commercial Umbrella", "Excess Liability"],
          fidelity_crime: ["Commercial Crime", "Crime Expanded Coverage"],
          terrorism: ["Terrorism"],
        },
      },
      premium: { type: "number" },
      label: { type: "string" },
    },
  },
} as Record<string, unknown>;

// Run-on shape: several rows flattened onto one line (real parser output).
const RUN_ON = `
SUMMARY OF PREMIUMS CHARGED

Named Insured: EXAMPLE ASSOCIATION INC THIS POLICY CONSISTS OF THE FOLLOWING COVERAGE PARTS FOR WHICH A PREMIUM CHARGE IS INDICATED

Commercial Property Coverage Part $ 3,539 Commercial General Liability Coverage Part $ 2,749 Commercial Auto Coverage Part $ 117 Commercial Umbrella / Excess Liability Coverage Part $ 1,000

| Terrorism Coverage | $ 67 |
| ANNUAL TOTAL | $ 8,771 |
`;

// Pipe-table shape with INCL and a blank-amount row (not bound).
const PIPE_TABLE = `
SUMMARY OF PREMIUMS CHARGED |
| Commercial Property Coverage Part | W/EBC   $ 2,090 |
| Commercial General Liability Coverage Part | $ 157 |
| Commercial Crime Coverage Part | $ INCL |
| Commercial Umbrella / Excess Liability Coverage Part | $ |
| Terrorism Coverage | $ 25 |
| ANNUAL TOTAL | $ 2,470 |
`;

describe("runFormTableSpec", () => {
  it("parses flattened run-on rows and pipe rows with one grammar", () => {
    const r = runFormTableSpec(RUN_ON, SPEC, FIELD_SPEC)!;
    expect(r.rows.map((x) => x.code)).toEqual([
      "property",
      "general_liability",
      "auto",
      "umbrella",
      "terrorism",
    ]);
    expect(r.rows.map((x) => x.premium)).toEqual([3539, 2749, 117, 1000, 67]);
    expect(r.sourceLines).toHaveLength(5);
  });

  it("skips blank-amount rows and maps INCL to a null premium", () => {
    const r = runFormTableSpec(PIPE_TABLE, SPEC, FIELD_SPEC)!;
    expect(r.rows.map((x) => x.code)).toEqual([
      "property",
      "general_liability",
      "fidelity_crime",
      "terrorism",
    ]); // umbrella's blank $ row is NOT emitted
    const crime = r.rows.find((x) => x.code === "fidelity_crime")!;
    expect(crime.premium).toBeNull();
    expect(r.rows.find((x) => x.code === "property")!.premium).toBe(2090);
  });

  it("is inactive when detect misses, anchor misses, or zero rows match", () => {
    expect(runFormTableSpec("nothing here", SPEC, FIELD_SPEC)).toBeNull();
    expect(
      runFormTableSpec("SUMMARY OF PREMIUMS CHARGED then no rows at all", SPEC, FIELD_SPEC),
    ).toBeNull();
  });

  it("survives a malformed pattern without throwing", () => {
    const bad = { ...SPEC, row: { pattern: "([" } };
    expect(runFormTableSpec(RUN_ON, bad, FIELD_SPEC)).toBeNull();
  });
});

describe("seedRowsMerge", () => {
  const parserRows = [
    { code: "property", premium: 3539, label: "Commercial Property Coverage Part" },
    { code: "terrorism", premium: 67, label: "Terrorism Coverage" },
  ];
  const parserSrc = ["src-prop", "src-terror"];

  it("enriches parser rows with LLM sub-fields and drops unmatched LLM rows", () => {
    const llm = [
      { code: "property", limits: [{ limit: 517068 }], premium: 9999 }, // wrong premium
      { code: "flood", limits: [] }, // spurious — dropped
    ];
    const m = seedRowsMerge(parserRows, parserSrc, llm, undefined, "code");
    expect(m.rows).toHaveLength(2);
    const prop = m.rows[0]!;
    expect(prop.limits).toEqual([{ limit: 517068 }]); // enriched from LLM
    expect(prop.premium).toBe(3539); // parser wins where it captured
    expect(m.enriched).toBe(1);
    expect(m.droppedLlmRows).toBe(1);
    expect(m.sourceLines).toEqual(["src-prop", "src-terror"]);
  });

  it("keeps parser rows bare when no LLM row matches", () => {
    const m = seedRowsMerge(parserRows, parserSrc, [], undefined, "code");
    expect(m.rows).toEqual(parserRows);
    expect(m.enriched).toBe(0);
  });
});

describe("applyFormTables", () => {
  it("seeds the field, aligns source_texts, and reports", () => {
    const schemaDef = { name: "t", fields: { parts: FIELD_SPEC }, forms: [SPEC] };
    const extracted: Record<string, unknown> = {
      parts: [
        { code: "property", limits: [{ limit: 1 }] },
        { code: "wind" }, // spurious
      ],
    };
    const sourceTexts: Record<string, string[]> = { parts: ["llm-src-1", "llm-src-2"] };
    const report = applyFormTables(RUN_ON, schemaDef, extracted, sourceTexts);
    const rows = extracted.parts as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.code)).toEqual(["property", "general_liability", "auto", "umbrella", "terrorism"]);
    expect(rows[0]!.limits).toEqual([{ limit: 1 }]);
    expect(sourceTexts.parts).toHaveLength(5);
    expect(report[0]).toContain("5 row(s) seeded from form table 'premium_summary'");
    expect(report[0]).toContain("1 enriched");
    expect(report[0]).toContain("1 extraction row(s) dropped");
  });

  it("no-ops without a forms block or when the spec is inactive", () => {
    const schemaDef = { name: "t", fields: { parts: FIELD_SPEC } } as Record<string, unknown>;
    const extracted: Record<string, unknown> = { parts: [{ code: "property" }] };
    expect(applyFormTables(RUN_ON, schemaDef, extracted, undefined)).toEqual([]);
    expect(extracted.parts).toHaveLength(1);
  });
});
