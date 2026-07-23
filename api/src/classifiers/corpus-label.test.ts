import { describe, it, expect } from "vitest";
import { validateCorpusLabel } from "./corpus-label";
import { UNKNOWN_LABEL } from "../classify";

const CLASSES = ["invoice", "receipt", "policy"];

describe("validateCorpusLabel", () => {
  it("accepts a declared class id", () => {
    expect(validateCorpusLabel("invoice", CLASSES)).toEqual({ ok: true, label: "invoice" });
  });

  it("accepts UNKNOWN_LABEL — 'should fall through' is a real ground truth", () => {
    expect(validateCorpusLabel(UNKNOWN_LABEL, CLASSES)).toEqual({ ok: true, label: UNKNOWN_LABEL });
  });

  it("trims surrounding whitespace", () => {
    expect(validateCorpusLabel("  receipt  ", CLASSES)).toEqual({ ok: true, label: "receipt" });
  });

  it("rejects a label that is not a declared class", () => {
    const r = validateCorpusLabel("contract", CLASSES);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("contract");
      // names the valid options so the caller can fix it
      expect(r.message).toContain("invoice");
    }
  });

  it("rejects an empty or missing label", () => {
    expect(validateCorpusLabel("", CLASSES).ok).toBe(false);
    expect(validateCorpusLabel("   ", CLASSES).ok).toBe(false);
    expect(validateCorpusLabel(undefined, CLASSES).ok).toBe(false);
    expect(validateCorpusLabel(null, CLASSES).ok).toBe(false);
  });

  it("rejects a non-string label rather than coercing it", () => {
    expect(validateCorpusLabel(42, CLASSES).ok).toBe(false);
    expect(validateCorpusLabel({ label: "invoice" }, CLASSES).ok).toBe(false);
  });

  it("accepts UNKNOWN_LABEL even when the class list is empty", () => {
    expect(validateCorpusLabel(UNKNOWN_LABEL, []).ok).toBe(true);
  });
});
