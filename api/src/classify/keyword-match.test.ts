import { describe, it, expect } from "vitest";
import { scoreClass, scoreClasses } from "./keyword-match";
import type { PageText } from "./types";

const pages = (texts: string[]): PageText[] => texts.map((text, i) => ({ page: i + 1, text }));

describe("scoreClass", () => {
  it("scores the fraction of matched signals and reports the evidence page", () => {
    const p = pages(["cover sheet, please route", "INVOICE — amount due $500, remit to Acme"]);
    const s = scoreClass(p, { id: "invoice", keywords: ["invoice", "amount due", "remit to"] }, 3);
    expect(s.hits).toBe(3);
    expect(s.total).toBe(3);
    expect(s.score).toBe(1);
    expect(s.evidencePage).toBe(2); // matched on page 2, not the cover sheet
  });

  it("matches single words on word membership, multi-word as substring", () => {
    const p = pages(["the invoiced amount"]);
    // "invoice" as a single word should NOT match "invoiced"
    const s = scoreClass(p, { id: "x", keywords: ["invoice"] }, 3);
    expect(s.hits).toBe(0);
    // multi-word substring DOES match within the run
    const s2 = scoreClass(p, { id: "x", keywords: ["invoiced amount"] }, 3);
    expect(s2.hits).toBe(1);
  });

  it("counts regex patterns", () => {
    const p = pages(["Form ACORD 25 (2016/03)"]);
    const s = scoreClass(p, { id: "coi", patterns: ["ACORD\\s*25"] }, 3);
    expect(s.hits).toBe(1);
    expect(s.total).toBe(1);
  });

  it("respects a per-class window narrower than the page set", () => {
    const p = pages(["invoice here", "unrelated", "invoice again"]);
    // window 1 → only page 1 considered; still matches once
    const s = scoreClass(p, { id: "x", keywords: ["invoice"], window: 1 }, 3);
    expect(s.evidencePage).toBe(1);
    expect(s.hits).toBe(1);
  });

  it("returns score 0 for a class with no deterministic signals", () => {
    const s = scoreClass(pages(["anything"]), { id: "x" }, 3);
    expect(s.score).toBe(0);
    expect(s.total).toBe(0);
    expect(s.evidencePage).toBeNull();
  });
});

describe("scoreClasses", () => {
  it("sorts by score descending", () => {
    const p = pages(["invoice amount due", "policy declarations"]);
    const scores = scoreClasses(
      p,
      [
        { id: "invoice", keywords: ["invoice", "amount due"] },
        { id: "policy", keywords: ["declarations", "policy", "insuring agreement"] },
      ],
      3,
    );
    expect(scores[0].id).toBe("invoice"); // 2/2 = 1.0 beats 2/3
    expect(scores[0].score).toBeGreaterThan(scores[1].score);
  });
});
