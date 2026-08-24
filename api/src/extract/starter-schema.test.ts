import { describe, it, expect } from "vitest";
import { buildStarterSchema, inferFieldType, toFieldName } from "./starter-schema";
import { compileSchema } from "../schemas/compiler";

/**
 * The schema builder used to seed its first turn from one of eight built-in
 * vertical templates chosen by a regex classifier, so a document outside those
 * verticals got an empty skeleton and a document that merely mentioned "policy
 * number" got insurance field names proposed for it. The seed now comes from
 * the document's own labels (oss-498).
 */
describe("toFieldName", () => {
  it.each([
    ["Effective Date", "effective_date"],
    ["Total (USD)", "total_usd"],
    ["Patient  Name", "patient_name"],
    ["Container No.", "container_no"],
    ["  Gross Weight  ", "gross_weight"],
  ])("snake-cases %s", (label, expected) => {
    expect(toFieldName(label)).toBe(expected);
  });

  it("does not produce a name that leads with a digit", () => {
    expect(toFieldName("2026 Total")).toBe("field_2026_total");
  });

  it("does not collide with a reserved schema key", () => {
    expect(toFieldName("Name")).toBe("name_value");
    expect(toFieldName("Type")).toBe("type_value");
  });

  it("returns empty for a label with nothing usable in it", () => {
    expect(toFieldName("***")).toBe("");
  });
});

describe("inferFieldType", () => {
  it.each([
    ["2026-04-01", "date"],
    ["04/01/2026", "date"],
    ["1.4.2026", "date"],
    ["March 12, 2026", "date"],
    ["12 March 2026", "date"],
    ["$12,500.00", "number"],
    ["1200", "number"],
    ["-4.5", "number"],
    ["12.5%", "number"],
    ["€980,00", "number"],
    ["Yes", "boolean"],
    ["false", "boolean"],
    ["Acme Supply Co.", "string"],
    ["", "string"],
  ])("reads %s as %s", (value, expected) => {
    expect(inferFieldType(value)).toBe(expected);
  });
});

describe("buildStarterSchema", () => {
  // The point of the change: the same code produces a fitting skeleton for
  // documents from unrelated industries, because it reads the document.
  it.each([
    {
      kind: "a lab report",
      pairs: [
        { label: "Specimen ID", value: "SP-90210" },
        { label: "Collected On", value: "2026-03-04" },
        { label: "Result Value", value: "13.2" },
      ],
      expect: ["specimen_id:", "collected_on:", "result_value:"],
    },
    {
      kind: "a lease",
      pairs: [
        { label: "Tenant Name", value: "Maria Gonzalez" },
        { label: "Monthly Rent", value: "$2,400.00" },
        { label: "Lease Start", value: "05/01/2026" },
      ],
      expect: ["tenant_name:", "monthly_rent:", "lease_start:"],
    },
    {
      kind: "a shipping manifest",
      pairs: [
        { label: "Container No.", value: "MSKU4471" },
        { label: "Gross Weight", value: "18,400" },
        { label: "Ship Date", value: "03/14/2026" },
      ],
      expect: ["container_no:", "gross_weight:", "ship_date:"],
    },
  ])("drafts fields from $kind", ({ pairs, expect: wanted }) => {
    const yaml = buildStarterSchema("doc", pairs)!;
    for (const field of wanted) expect(yaml).toContain(field);
  });

  it("types each field from the shape of its value", () => {
    const yaml = buildStarterSchema("doc", [
      { label: "Issued On", value: "2026-03-04" },
      { label: "Amount Due", value: "$1,200.00" },
      { label: "Expedited", value: "Yes" },
      { label: "Supplier", value: "Acme Supply Co." },
    ])!;
    expect(yaml).toContain("  issued_on:\n    type: date");
    expect(yaml).toContain("  amount_due:\n    type: number");
    expect(yaml).toContain("  expedited:\n    type: boolean");
    expect(yaml).toContain("  supplier:\n    type: string");
  });

  it("carries the document's own wording through as guidance", () => {
    const yaml = buildStarterSchema("doc", [
      { label: "Date of Service", value: "2026-03-04" },
      { label: "Facility Name", value: "Central Valley" },
      { label: "Total Charges", value: "412.00" },
    ])!;
    expect(yaml).toContain('extraction_guidance: "Date of Service"');
  });

  it("names the schema after the schema being edited", () => {
    const yaml = buildStarterSchema("lab_result", [
      { label: "Specimen ID", value: "SP-1" },
      { label: "Collected On", value: "2026-03-04" },
      { label: "Result Value", value: "13.2" },
    ])!;
    expect(yaml.startsWith("name: lab_result\n")).toBe(true);
  });

  it("caps how many fields it proposes", () => {
    const pairs = Array.from({ length: 40 }, (_, i) => ({ label: `Field ${i}`, value: `${i}` }));
    const yaml = buildStarterSchema("doc", pairs)!;
    expect((yaml.match(/^ {4}type:/gm) ?? []).length).toBe(15);
  });

  it("drops duplicate labels", () => {
    const yaml = buildStarterSchema("doc", [
      { label: "Order Number", value: "A-1" },
      { label: "order number", value: "A-2" },
      { label: "Ship Date", value: "03/14/2026" },
      { label: "Gross Weight", value: "18,400" },
    ])!;
    expect((yaml.match(/order_number:/g) ?? []).length).toBe(1);
  });

  // Real documents — scanned ones especially — yield pairs whose "label" is an
  // OCR artifact, a form code, or a sentence fragment. Proposing those as
  // schema fields is worse than proposing nothing.
  it.each([
    ["a form code", "NI 00 62 01"],
    ["garbled glyphs", "AdOOGSYNSNI"],
    ["a bare number", "88213"],
    ["a consonant run", "PRXX"],
  ])("skips a label that is not a label — %s", (_kind, junk) => {
    const yaml = buildStarterSchema("doc", [
      { label: junk, value: "x" },
      { label: "Order Number", value: "A-1" },
      { label: "Ship Date", value: "03/14/2026" },
      { label: "Gross Weight", value: "18,400" },
    ])!;
    expect(yaml).toContain("order_number:");
    expect(yaml.split("\n").filter((l) => /^ {2}\w+:$/.test(l))).toHaveLength(3);
  });

  it("ranks data-carrying fields above prose", () => {
    // A long document's first pairs are often its noisiest. Document order
    // would fill the draft with them.
    const yaml = buildStarterSchema("doc", [
      { label: "What you", value: "should read this notice carefully before you continue reading" },
      { label: "Online Support", value: "available at all hours through the customer portal system" },
      { label: "Named Insured", value: "Harbor Imports" },
      { label: "Effective Date", value: "05/01/2026" },
      { label: "Total Amount", value: "$4,120.00" },
    ])!;
    const order = [...yaml.matchAll(/^ {2}(\w+):$/gm)].map((m) => m[1]);
    expect(order.slice(0, 3)).toEqual(["effective_date", "total_amount", "named_insured"]);
  });

  it("returns null when the document yielded too little to seed from", () => {
    expect(buildStarterSchema("doc", [])).toBeNull();
    expect(buildStarterSchema("doc", [{ label: "***", value: "x" }])).toBeNull();
    // Below the minimum, the caller leaves the editor alone and lets the model
    // propose from the document text — better than a draft of one field.
    expect(buildStarterSchema("doc", [{ label: "Order Number", value: "A-1" }])).toBeNull();
  });

  // The seed is handed straight to the schema editor and to the model, so it
  // has to be a schema the compiler accepts — not merely well-formed YAML.
  it.each([
    [
      "a lab report",
      [
        { label: "Specimen ID", value: "SP-90210" },
        { label: "Collected On", value: "2026-03-04" },
        { label: "Result Value", value: "13.2" },
        { label: "Expedited", value: "Yes" },
      ],
    ],
    [
      "a shipping manifest",
      [
        { label: "Container No.", value: "MSKU4471" },
        { label: 'Owner "Primary"', value: "Pacific Freight Ltd" },
        { label: "Gross Weight", value: "18,400" },
      ],
    ],
  ])("compiles as a real schema — %s", (_kind, pairs) => {
    const result = compileSchema(buildStarterSchema("doc", pairs)!);
    expect(result.ok).toBe(true);
  });

  it("escapes a quote in a label rather than emitting broken YAML", () => {
    const yaml = buildStarterSchema("doc", [
      { label: 'Owner "Primary"', value: "Pacific Freight" },
      { label: "Ship Date", value: "03/14/2026" },
      { label: "Gross Weight", value: "18,400" },
    ])!;
    expect(yaml).toContain('extraction_guidance: "Owner \\"Primary\\""');
  });
});
