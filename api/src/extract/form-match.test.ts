import { describe, it, expect } from "vitest";
import { generateFingerprint } from "./form-match";

describe("generateFingerprint", () => {
  it("extracts keywords from page text", () => {
    const text = "CERTIFICATE OF LIABILITY INSURANCE  DATE  ACORD 25  PRODUCER  INSURED";
    const fp = generateFingerprint(text);
    expect(fp.keywords.length).toBeGreaterThan(0);
    expect(fp.page1_chars).toBeGreaterThan(0);
  });

  it("captures ACORD form identifiers", () => {
    const text = "This is an ACORD 25 Certificate of Liability Insurance form with various fields";
    const fp = generateFingerprint(text);
    expect(fp.keywords).toContain("acord 25");
    expect(fp.keywords).toContain("certificate of liability insurance");
  });

  it("captures certificate of insurance pattern", () => {
    const text = "CERTIFICATE OF INSURANCE issued by SuperKey Insurance LLC";
    const fp = generateFingerprint(text);
    expect(fp.keywords).toContain("certificate of insurance");
  });

  it("filters short words", () => {
    const text = "a an the is of to in for on at by";
    const fp = generateFingerprint(text);
    // All words are <= 3 chars, should be filtered
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
