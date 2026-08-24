import { describe, it, expect } from "vitest";
import { generateFingerprint } from "./form-match";

/**
 * Fingerprints used to get their high-signal terms from a hardcoded list of
 * insurance phrases (`acord \d+`, `certificate of liability insurance`,
 * `declarations page`, …). Any form outside that list — a claim form, a tax
 * form, a shipping document, a permit — had no distinctive terms at all and
 * fell back to frequent-word overlap, which is far weaker at telling two forms
 * apart. The signals are now structural: a form's own title line and its
 * printed form code (oss-498).
 */
describe("generateFingerprint", () => {
  it("extracts keywords from page text", () => {
    const text = "CERTIFICATE OF LIABILITY INSURANCE  DATE  ACORD 25  PRODUCER  INSURED";
    const fp = generateFingerprint(text);
    expect(fp.keywords.length).toBeGreaterThan(0);
    expect(fp.page1_chars).toBeGreaterThan(0);
  });

  // The same forms the hardcoded list covered, plus the ones it never could.
  // Each asserts the form's own name and its own printed code, with no term in
  // the engine that knows what any of them are.
  it.each([
    {
      form: "an insurance certificate",
      page1: "ACORD 25\nCERTIFICATE OF LIABILITY INSURANCE\nDATE (MM/DD/YYYY)\nPRODUCER\nINSURED",
      title: "certificate of liability insurance",
      code: "acord 25",
    },
    {
      form: "a health claim form",
      page1:
        "HEALTH INSURANCE CLAIM FORM\nAPPROVED BY NATIONAL UNIFORM CLAIM COMMITTEE\nFORM CMS-1500 (02-12)\nPATIENT NAME",
      title: "health insurance claim form",
      code: "cms-1500",
    },
    {
      form: "a tax form",
      page1:
        "Form W-9\nRequest for Taxpayer Identification Number and Certification\nDepartment of the Treasury",
      title: "request for taxpayer identification number and certification",
      code: "form w-9",
    },
    {
      form: "a shipping document",
      page1: "STRAIGHT BILL OF LADING\nShipper No. 88213\nConsignee\nOrigin\nDestination",
      title: "straight bill of lading",
      code: "no. 88213",
    },
    {
      form: "a building permit",
      page1: "BUILDING PERMIT APPLICATION\nCity of Springfield\nPermit No. BP-2026-0043\nParcel",
      title: "building permit application",
      code: "bp-2026-0043",
    },
  ])("fingerprints $form by its own title and code", ({ page1, title, code }) => {
    const fp = generateFingerprint(page1);
    expect(fp.keywords).toContain(title);
    expect(fp.keywords).toContain(code);
  });

  it("does not treat running prose as a title", () => {
    const text =
      "This is an agreement between the parties named below and it goes on at some length.";
    expect(generateFingerprint(text).keywords).not.toContain(text.toLowerCase());
  });

  it("filters short words", () => {
    const text = "a an the is of to in for on at by";
    const fp = generateFingerprint(text);
    // All words are <= 3 chars, and the line is not heading-shaped.
    expect(fp.keywords.length).toBe(0);
  });

  it("deduplicates keywords", () => {
    const text = "ACORD 25 ACORD 25 certificate certificate certificate policy policy";
    const fp = generateFingerprint(text);
    const unique = new Set(fp.keywords);
    expect(fp.keywords.length).toBe(unique.size);
  });

  it("returns page character count", () => {
    const text = "Hello world test document";
    const fp = generateFingerprint(text);
    expect(fp.page1_chars).toBe(text.length);
  });
});
