/**
 * Form-table grammar interpreter tests (oss-367).
 *
 * Region snippets are real parser output shapes observed in production
 * documents: a run-on line where several table rows flattened into one line, a
 * pipe-table with per-row cells, blank-amount rows, and "INCL" premiums.
 */
import { describe, it, expect } from "vitest";
import { runFormTableSpec, seedRowsMerge, applyFormTables, type FormTableSpec } from "./form-tables";
import { collapseKeyedRows } from "./pipeline";

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

  describe("union mode (oss-390)", () => {
    it("keeps keyed LLM rows the grammar missed, parser still winning on conflict", () => {
      const llm = [
        { code: "property", limits: [{ limit: 517068 }], premium: 9999 }, // wrong premium
        { code: "wrongful_acts", premium: 1200 }, // grammar missed this bound row
        { code: "edp", premium: 340 }, // grammar missed this too
      ];
      const llmSrc = ["src-prop-llm", "src-wa", "src-edp"];
      const m = seedRowsMerge(parserRows, parserSrc, llm, llmSrc, "code", "union");

      // 2 parser rows + 2 kept LLM-only rows.
      expect(m.rows).toHaveLength(4);
      expect(m.rows[0]!.premium).toBe(3539); // parser wins where it captured
      expect(m.rows[0]!.limits).toEqual([{ limit: 517068 }]); // enriched from LLM
      expect(m.rows.map((r) => r.code)).toEqual(["property", "terrorism", "wrongful_acts", "edp"]);
      expect(m.enriched).toBe(1);
      expect(m.keptLlmRows).toBe(2);
      expect(m.droppedLlmRows).toBe(0);
      // Provenance stays aligned: kept rows carry their LLM source line.
      expect(m.sourceLines).toEqual(["src-prop", "src-terror", "src-wa", "src-edp"]);
    });

    it("drops LLM rows with no element key even under union", () => {
      const llm = [{ premium: 500 }]; // no `code` — can't be positioned
      const m = seedRowsMerge(parserRows, parserSrc, llm, undefined, "code", "union");
      expect(m.rows).toHaveLength(2);
      expect(m.keptLlmRows).toBe(0);
      expect(m.droppedLlmRows).toBe(1);
    });

    it("seed_rows remains the default (unmatched LLM rows dropped)", () => {
      const llm = [{ code: "flood", premium: 500 }];
      const m = seedRowsMerge(parserRows, parserSrc, llm, undefined, "code");
      expect(m.rows).toHaveLength(2);
      expect(m.keptLlmRows).toBe(0);
      expect(m.droppedLlmRows).toBe(1);
    });
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

/**
 * Region-carve regression (oss-395, oss-396).
 *
 * Two defects made the deterministic row floor vanish on real documents:
 *   1. `detect`/`anchor`/`end` matched RAW markdown while rows matched
 *      NORMALIZED text, so a heading with a pipe or a double space (routine in
 *      parser output) made the anchor miss and the whole grammar return null.
 *   2. Only the FIRST anchor-delimited region was scanned, so a repeated
 *      structure whose sections are separated by an `end` token seeded only the
 *      first section — or nothing when the first anchor hit boilerplate directly
 *      followed by the `end` token.
 *
 * With the floor gone, a union grammar on a per_section field returned `[]`
 * whenever the LLM/per_section pass returned nothing — the floor is exactly what
 * is supposed to survive that.
 */
describe("region carve robustness (oss-395, oss-396)", () => {
  // A grammar whose anchor/end/rows all key off the same heading phrase — the
  // shape of the field that regressed. element_key on `label`, union mode.
  const DECL_SPEC: FormTableSpec = {
    id: "decl_parts",
    detect: "(PROPERTY|LIABILITY) DECLARATIONS",
    anchor: "(PROPERTY|LIABILITY) DECLARATIONS",
    end: "SCHEDULE OF FORMS|IN WITNESS WHEREOF|Common Policy Conditions",
    field: "coverages",
    mode: "union",
    row: { pattern: "(?<label>(?:PROPERTY|LIABILITY) DECLARATIONS)", require: ["label"] },
    set: { label: "{label}" },
  };
  const DECL_FIELD = {
    type: "array",
    hints: { element_key: "label", per_section: true },
    items: { type: "object", properties: { label: { type: "string" } } },
  } as Record<string, unknown>;

  it("matches an anchor whose heading carries a double space (normalize before anchoring)", () => {
    // Parser emitted "PROPERTY  DECLARATIONS" (two spaces). Before the fix the
    // raw-markdown anchor (single space) missed and the grammar returned null.
    const md = `PROPERTY  DECLARATIONS
row body
LIABILITY  DECLARATIONS
row body
SCHEDULE OF FORMS`;
    const r = runFormTableSpec(md, DECL_SPEC, DECL_FIELD);
    expect(r).not.toBeNull();
    expect(r!.rows.map((x) => x.label)).toEqual(["PROPERTY DECLARATIONS", "LIABILITY DECLARATIONS"]);
  });

  it("matches an anchor whose heading is a pipe-table cell", () => {
    const md = `| PROPERTY DECLARATIONS |
row body
| LIABILITY DECLARATIONS |
SCHEDULE OF FORMS`;
    const r = runFormTableSpec(md, DECL_SPEC, DECL_FIELD);
    expect(r!.rows.map((x) => x.label)).toEqual(["PROPERTY DECLARATIONS", "LIABILITY DECLARATIONS"]);
  });

  it("scans every anchor region, not just the first (end token separates sections)", () => {
    // The first anchor is a running header immediately followed by an `end`
    // token; the real declarations rows repeat further down. Before the fix the
    // region truncated after the first `end` and only the first row seeded.
    const md = `PROPERTY DECLARATIONS
Common Policy Conditions apply to this policy.
${"filler text ".repeat(40)}
PROPERTY DECLARATIONS
property coverage rows
Common Policy Conditions apply to this policy.
${"filler text ".repeat(40)}
LIABILITY DECLARATIONS
liability coverage rows
SCHEDULE OF FORMS`;
    const r = runFormTableSpec(md, DECL_SPEC, DECL_FIELD);
    expect(r).not.toBeNull();
    // All three heading occurrences seed a row (dedup is by offset, not text).
    expect(r!.rows).toHaveLength(3);
    expect(r!.rows.map((x) => x.label)).toEqual([
      "PROPERTY DECLARATIONS",
      "PROPERTY DECLARATIONS",
      "LIABILITY DECLARATIONS",
    ]);
  });

  it("translates a leading PCRE-style (?i) inline flag so the spec compiles", () => {
    // Schema authors naturally write `(?i)` — universal everywhere except JS,
    // where a LEADING `(?i)` throws and silently no-ops the whole grammar.
    const spec: FormTableSpec = {
      ...DECL_SPEC,
      detect: "(?i)(property|liability) declarations",
      anchor: "(?i)(property|liability) declarations",
      row: { pattern: "(?i)(?<label>(?:property|liability) declarations)", require: ["label"] },
    };
    const md = `PROPERTY DECLARATIONS
row body
LIABILITY DECLARATIONS
SCHEDULE OF FORMS`;
    const r = runFormTableSpec(md, spec, DECL_FIELD);
    expect(r).not.toBeNull();
    expect(r!.rows.map((x) => x.label)).toEqual(["PROPERTY DECLARATIONS", "LIABILITY DECLARATIONS"]);
  });

  it("translates a combined leading inline flag group (?im)", () => {
    const spec: FormTableSpec = {
      ...DECL_SPEC,
      anchor: "(?im)(property|liability) declarations",
      detect: "(?im)(property|liability) declarations",
      row: { pattern: "(?im)^(?<label>(?:property|liability) declarations)$", require: ["label"] },
    };
    const md = `PROPERTY DECLARATIONS
LIABILITY DECLARATIONS
SCHEDULE OF FORMS`;
    const r = runFormTableSpec(md, spec, DECL_FIELD);
    expect(r).not.toBeNull();
    expect(r!.rows.map((x) => x.label)).toEqual(["PROPERTY DECLARATIONS", "LIABILITY DECLARATIONS"]);
  });

  it("leaves a scoped (?i:...) group untouched (still works in V8)", () => {
    const spec: FormTableSpec = {
      ...DECL_SPEC,
      anchor: "(?i:property|liability) DECLARATIONS",
      detect: "(?i:property|liability) DECLARATIONS",
      row: { pattern: "(?<label>(?i:property|liability) DECLARATIONS)", require: ["label"] },
    };
    const md = `property DECLARATIONS
LIABILITY DECLARATIONS
SCHEDULE OF FORMS`;
    const r = runFormTableSpec(md, spec, DECL_FIELD);
    expect(r).not.toBeNull();
    expect(r!.rows.map((x) => x.label)).toEqual(["property DECLARATIONS", "LIABILITY DECLARATIONS"]);
  });

  it("a genuinely malformed pattern still fails safe (null, no throw)", () => {
    const spec: FormTableSpec = { ...DECL_SPEC, anchor: "PROPERTY DECLARATIONS", row: { pattern: "(?<label>[" } };
    const md = `PROPERTY DECLARATIONS\nSCHEDULE OF FORMS`;
    expect(() => runFormTableSpec(md, spec, DECL_FIELD)).not.toThrow();
    expect(runFormTableSpec(md, spec, DECL_FIELD)).toBeNull();
  });

  it("union floor survives when the per_section LLM pass returns nothing (oss-395)", () => {
    // The end-to-end failure: per_section coverages field, union grammar, LLM
    // returned []. The deterministic floor must still surface. Before the fix
    // the anchor (double-space heading) missed → grammar null → field stayed [].
    const md = `PROPERTY  DECLARATIONS
property coverage detail
LIABILITY  DECLARATIONS
liability coverage detail
SCHEDULE OF FORMS`;
    const schemaDef = { name: "t", fields: { coverages: DECL_FIELD }, forms: [DECL_SPEC] };
    const extracted: Record<string, unknown> = { coverages: [] }; // per_section LLM found nothing
    const sourceTexts: Record<string, string[]> = { coverages: [] };
    const report = applyFormTables(md, schemaDef, extracted, sourceTexts);

    const rows = extracted.coverages as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.label)).toEqual(["PROPERTY DECLARATIONS", "LIABILITY DECLARATIONS"]);
    expect(sourceTexts.coverages).toHaveLength(2);
    expect(report[0]).toContain("2 row(s) unioned");

    // And the seeded floor survives the downstream element_key collapse — the
    // step the leading hypothesis suspected of re-dropping the seed.
    const collapsed = collapseKeyedRows(
      extracted,
      schemaDef.fields as Record<string, Record<string, unknown>>,
      sourceTexts,
    );
    expect(collapsed).toEqual([]); // distinct keys → nothing collapsed
    expect((extracted.coverages as unknown[]).map((r) => (r as Record<string, unknown>).label)).toEqual([
      "PROPERTY DECLARATIONS",
      "LIABILITY DECLARATIONS",
    ]);
  });
});
