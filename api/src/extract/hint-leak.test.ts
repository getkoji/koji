import { describe, it, expect } from "vitest";
import { collectHintText, matchesHintText, stripHintLeaks } from "./hint-leak";
import type { Chunk } from "./document-map";

function chunk(content: string, index = 0): Chunk {
  return { index, title: `Chunk ${index}`, content, signals: {} };
}

const INSURED_HINT = [
  "Return the FIRST NAMED INSURED. A 'NAMED INSURED AND ADDRESS' block stacks",
  "the name on the first line:",
  "  NAMED INSURED AND ADDRESS:",
  "  EXAMPLEVILLE OWNERS ASSOCIATION   <- the insured (return THIS)",
  "  100 SAMPLE RD STE 1               <- street (NOT the insured)",
].join("\n");

describe("collectHintText", () => {
  it("gathers extraction_hint from the field spec", () => {
    const hint = collectHintText({ extraction_hint: "Look for ACME CORP examples" });
    expect(hint).toContain("acme corp");
  });

  it("gathers conditional extraction_hint_by variants", () => {
    const hint = collectHintText({
      extraction_hint_by: {
        doc_type: { policy: "POLICY EXAMPLE TEXT", invoice: "INVOICE EXAMPLE TEXT" },
      },
    });
    expect(hint).toContain("policy example text");
    expect(hint).toContain("invoice example text");
  });

  it("gathers hints from nested array-item property specs", () => {
    const hint = collectHintText({
      type: "array",
      items: {
        properties: {
          name: { type: "string", extraction_hint: "e.g. NESTED EXAMPLE HOLDINGS LLC" },
        },
      },
    });
    expect(hint).toContain("nested example holdings llc");
  });

  it("returns empty string for a spec with no hints", () => {
    expect(collectHintText({ type: "string" })).toBe("");
    expect(collectHintText(undefined)).toBe("");
  });
});

describe("matchesHintText", () => {
  const hint = collectHintText({ extraction_hint: INSURED_HINT });

  it("matches a value copied verbatim from the hint", () => {
    expect(matchesHintText("EXAMPLEVILLE OWNERS ASSOCIATION", hint)).toBe(true);
  });

  it("matches case-insensitively and across whitespace differences", () => {
    expect(matchesHintText("exampleville   owners association", hint)).toBe(true);
  });

  it("does not match short fragments (below the length floor)", () => {
    expect(matchesHintText("NAMED", hint)).toBe(false);
    expect(matchesHintText("STE 1", hint)).toBe(false);
  });

  it("does not match values absent from the hint", () => {
    expect(matchesHintText("LATTA HEIGHTS CONDOMINIUM ASSOCIATION", hint)).toBe(false);
  });
});

describe("stripHintLeaks", () => {
  const fields = {
    insured_name: { type: "string", extraction_hint: INSURED_HINT },
    policy_number: { type: "string" },
  };

  it("nulls a scalar string copied from the hint when it has no source in the section", () => {
    const extracted: Record<string, unknown> = {
      insured_name: "EXAMPLEVILLE OWNERS ASSOCIATION",
      policy_number: "CR 1556312",
    };
    const chunks = [chunk("POLICY\nCR1556312\nRETAIL AGENCY ADDRESS COVER SHEET")];

    const affected = stripHintLeaks(extracted, fields, chunks);

    expect(affected).toEqual(["insured_name"]);
    expect(extracted.insured_name).toBeNull();
    expect(extracted.policy_number).toBe("CR 1556312");
  });

  it("keeps a hint-matching value that IS present in the document", () => {
    const extracted: Record<string, unknown> = {
      insured_name: "EXAMPLEVILLE OWNERS ASSOCIATION",
    };
    const chunks = [chunk("NAMED INSURED AND ADDRESS:\nEXAMPLEVILLE OWNERS ASSOCIATION\n100 SAMPLE RD")];

    const affected = stripHintLeaks(extracted, fields, chunks);

    expect(affected).toEqual([]);
    expect(extracted.insured_name).toBe("EXAMPLEVILLE OWNERS ASSOCIATION");
  });

  it("keeps a value with no provenance that does not appear in the hint", () => {
    const extracted: Record<string, unknown> = {
      insured_name: "SOME REFORMATTED ENTITY NAME LLC",
    };
    const affected = stripHintLeaks(extracted, fields, [chunk("unrelated text")]);

    expect(affected).toEqual([]);
    expect(extracted.insured_name).toBe("SOME REFORMATTED ENTITY NAME LLC");
  });

  it("credits an LLM-provided source text that matches the document", () => {
    const extracted: Record<string, unknown> = {
      insured_name: "EXAMPLEVILLE OWNERS ASSOCIATION",
    };
    // Value itself isn't in the chunk text, but the model's verbatim source is.
    const chunks = [chunk("Insured: EXAMPLEVILLE OWNERS ASSN")];
    const affected = stripHintLeaks(extracted, fields, chunks, {
      insured_name: "EXAMPLEVILLE OWNERS ASSN",
    });

    expect(affected).toEqual([]);
    expect(extracted.insured_name).toBe("EXAMPLEVILLE OWNERS ASSOCIATION");
  });

  it("removes leaked string items from arrays and keeps sourced ones", () => {
    const arrayFields = {
      additional_insureds: {
        type: "array",
        extraction_hint: "e.g. SAMPLE MANAGEMENT PARTNERS INC as the managing agent",
      },
    };
    const extracted: Record<string, unknown> = {
      additional_insureds: ["SAMPLE MANAGEMENT PARTNERS INC", "REAL PARTY FROM DOC LLC"],
    };
    const chunks = [chunk("Additional insured: REAL PARTY FROM DOC LLC")];

    const affected = stripHintLeaks(extracted, arrayFields, chunks);

    expect(affected).toEqual(["additional_insureds"]);
    expect(extracted.additional_insureds).toEqual(["REAL PARTY FROM DOC LLC"]);
  });

  it("nulls leaked object-item properties and drops items emptied by stripping", () => {
    const arrayFields = {
      additional_insureds: {
        type: "array",
        extraction_hint: "e.g. SAMPLE MANAGEMENT PARTNERS INC",
        items: { properties: { name: { type: "string" }, role: { type: "string" } } },
      },
    };
    const extracted: Record<string, unknown> = {
      additional_insureds: [
        { name: "SAMPLE MANAGEMENT PARTNERS INC", role: null },
        { name: "REAL PARTY FROM DOC LLC", role: "mortgagee" },
      ],
    };
    const chunks = [chunk("Mortgagee: REAL PARTY FROM DOC LLC")];

    const affected = stripHintLeaks(extracted, arrayFields, chunks);

    expect(affected).toEqual(["additional_insureds"]);
    expect(extracted.additional_insureds).toEqual([
      { name: "REAL PARTY FROM DOC LLC", role: "mortgagee" },
    ]);
  });

  it("nulls leaked properties on top-level object fields", () => {
    const objFields = {
      agency: {
        type: "object",
        extraction_hint: "The producing agency, e.g. SAMPLE INSURANCE PARTNERS LLC",
        properties: { name: { type: "string" }, phone: { type: "string" } },
      },
    };
    const extracted: Record<string, unknown> = {
      agency: { name: "SAMPLE INSURANCE PARTNERS LLC", phone: "704-555-0100" },
    };
    const chunks = [chunk("Phone: 704-555-0100")];

    const affected = stripHintLeaks(extracted, objFields, chunks);

    expect(affected).toEqual(["agency"]);
    expect(extracted.agency).toEqual({ name: null, phone: "704-555-0100" });
  });

  it("ignores fields whose spec declares no hint text", () => {
    const extracted: Record<string, unknown> = { policy_number: "TOTALLY-FABRICATED-123" };
    const affected = stripHintLeaks(extracted, fields, [chunk("nothing relevant")]);

    expect(affected).toEqual([]);
    expect(extracted.policy_number).toBe("TOTALLY-FABRICATED-123");
  });

  describe("canonical (enum/mapping) values are exempt", () => {
    it("keeps a mapping-typed scalar whose canonical value appears in its own hint", () => {
      const mappingFields = {
        package_type: {
          type: "mapping",
          extraction_hint: 'Resolve to a code, e.g. "Businessowners" → businessowners_package.',
          mappings: { businessowners_package: ["Businessowners", "BOP"] },
        },
      };
      // Canonical code: never in the doc, always in the hint — NOT a leak.
      const extracted: Record<string, unknown> = { package_type: "businessowners_package" };
      const affected = stripHintLeaks(extracted, mappingFields, [chunk("BUSINESSOWNERS POLICY DECLARATIONS")]);

      expect(affected).toEqual([]);
      expect(extracted.package_type).toBe("businessowners_package");
    });

    it("keeps mapping-typed array-item properties (coverage_code scenario)", () => {
      const coverageFields = {
        coverages: {
          type: "array",
          extraction_hint: "One row per coverage part.",
          items: {
            type: "object",
            properties: {
              coverage_code: {
                type: "mapping",
                extraction_hint:
                  'Worked examples: "Commercial General Liability" → general_liability; "Commercial Property" → property.',
                mappings: {
                  general_liability: ["Commercial General Liability", "GL"],
                  property: ["Commercial Property"],
                },
              },
              label: { type: "string" },
            },
          },
        },
      };
      const extracted: Record<string, unknown> = {
        coverages: [
          { coverage_code: "general_liability", label: "Commercial General Liability" },
          { coverage_code: "property", label: "Commercial Property" },
        ],
      };
      // Doc contains the printed labels but never the canonical codes.
      const chunks = [chunk("Commercial General Liability\nCommercial Property\nLimits of Insurance")];

      const affected = stripHintLeaks(extracted, coverageFields, chunks);

      expect(affected).toEqual([]);
      expect(extracted.coverages).toEqual([
        { coverage_code: "general_liability", label: "Commercial General Liability" },
        { coverage_code: "property", label: "Commercial Property" },
      ]);
    });

    it("keeps enum values declared via options", () => {
      const enumFields = {
        billing_type: {
          type: "enum",
          extraction_hint: 'Pick "direct_bill_installments" when the dec page says DIRECT BILL.',
          options: ["direct_bill_installments", "agency_bill"],
        },
      };
      const extracted: Record<string, unknown> = { billing_type: "direct_bill_installments" };
      const affected = stripHintLeaks(extracted, enumFields, [chunk("DIRECT BILL")]);

      expect(affected).toEqual([]);
      expect(extracted.billing_type).toBe("direct_bill_installments");
    });

    it("still strips a non-canonical sibling property next to an exempt one", () => {
      const coverageFields = {
        coverages: {
          type: "array",
          extraction_hint:
            'e.g. a Crime part underwritten by "EXAMPLE UNDERWRITERS OF AMERICA INC" maps to fidelity_crime.',
          items: {
            type: "object",
            properties: {
              coverage_code: { type: "mapping", mappings: { fidelity_crime: ["Crime"] } },
              underwriter: { type: "string" },
            },
          },
        },
      };
      const extracted: Record<string, unknown> = {
        coverages: [{ coverage_code: "fidelity_crime", underwriter: "EXAMPLE UNDERWRITERS OF AMERICA INC" }],
      };
      const chunks = [chunk("CRIME COVERAGE PART DECLARATIONS")];

      const affected = stripHintLeaks(extracted, coverageFields, chunks);

      expect(affected).toEqual(["coverages"]);
      expect(extracted.coverages).toEqual([{ coverage_code: "fidelity_crime", underwriter: null }]);
    });
  });
});
