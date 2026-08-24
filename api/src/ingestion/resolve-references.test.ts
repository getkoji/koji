import { describe, it, expect } from "vitest";
import {
  matchReferenceToFilename,
  detectReferences,
  resolveAgainstGroup,
  type GroupDocument,
} from "./resolve-references";

describe("matchReferenceToFilename", () => {
  // The rule this replaced carried a fixed list of document types (bylaws,
  // CC&Rs, budget, policy…), so a reference resolved for one industry and
  // silently failed for every other. These cases span industries on purpose:
  // none of the nouns below appear anywhere in the engine.
  it.each([
    ["see the Bylaws", "Bylaws.pdf"],
    ["refer to the Bill of Lading", "bill_of_lading_2026.pdf"],
    ["per the Lab Report", "patient-lab-report.pdf"],
    ["pursuant to the Master Lease", "MasterLease-signed.docx"],
    ["as defined in the Loan Agreement", "loan agreement (executed).pdf"],
    ["in accordance with the Safety Datasheet", "SAFETY_DATASHEET.PDF"],
  ])("resolves %j to %j", (ref, filename) => {
    expect(matchReferenceToFilename(ref, ["unrelated.pdf", filename])).toBe(filename);
  });

  it("matches across singular/plural", () => {
    expect(matchReferenceToFilename("see the Rules", ["house-rule.pdf"])).toBe("house-rule.pdf");
    expect(matchReferenceToFilename("see the Rule", ["house-rules.pdf"])).toBe("house-rules.pdf");
  });

  it("ignores punctuation, so CC&Rs finds CCRs.pdf", () => {
    expect(matchReferenceToFilename("refer to the CC&Rs", ["CCRs.pdf"])).toBe("CCRs.pdf");
  });

  it("returns null when only connective words remain", () => {
    expect(matchReferenceToFilename("see the", ["bylaws.pdf"])).toBeNull();
    expect(matchReferenceToFilename("pursuant to the", ["bylaws.pdf"])).toBeNull();
  });

  it("does not match on the connective words themselves", () => {
    // "per" and "the" are in the reference; a filename built from them alone
    // must not resolve.
    expect(matchReferenceToFilename("per the Schedule", ["see-the-other.pdf"])).toBeNull();
  });

  it("does not match on bare numbers or 1-2 char tokens", () => {
    expect(matchReferenceToFilename("Section 4", ["4.pdf", "a.pdf"])).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(matchReferenceToFilename("see the Bylaws", ["invoice.pdf", "receipt.pdf"])).toBeNull();
  });

  it("returns the first matching filename in the given order", () => {
    expect(matchReferenceToFilename("see the Budget", ["budget-2025.pdf", "budget-2026.pdf"]))
      .toBe("budget-2025.pdf");
  });
});

const chunk = (index: number, title: string, content: string) => ({ index, title, content });

describe("detectReferences", () => {
  it("finds both reference shapes across chunks", () => {
    const found = detectReferences([
      chunk(0, "Coverage", "See the Bylaws for the full list."),
      chunk(1, "Limits", "Amounts are set forth in Exhibit B."),
    ]);
    expect(found.map(r => r.text)).toEqual(
      expect.arrayContaining([expect.stringMatching(/Bylaws/i), expect.stringMatching(/Exhibit B/i)]),
    );
    expect(found.every(r => typeof r.chunkIndex === "number")).toBe(true);
  });

  it("is not stateful across calls (regex lastIndex is reset)", () => {
    const chunks = [chunk(0, "A", "See the Bylaws. Refer to the Budget.")];
    expect(detectReferences(chunks).length).toBe(detectReferences(chunks).length);
  });

  it("returns nothing for prose with no references", () => {
    expect(detectReferences([chunk(0, "Intro", "This document describes the policy.")])).toEqual([]);
  });
});

describe("resolveAgainstGroup", () => {
  const doc = (id: string, filename: string, titles: string[] = []): GroupDocument => ({
    id,
    filename,
    extractionJson: {},
    chunksJson: titles.map((t, i) => chunk(i, t, `${t} body text`)),
  });

  it("prefers a section-title match over a filename match", () => {
    const refs = detectReferences([chunk(0, "Src", "See the Quiet Hours policy.")]);
    const [r] = resolveAgainstGroup(refs, [doc("d1", "rules.pdf", ["Quiet Hours"])]);
    expect(r!.method).toBe("chunk_match");
    expect(r!.target_section).toBe("Quiet Hours");
    expect(r!.target_content).toContain("Quiet Hours");
  });

  it("falls back to a filename match when no section title matches", () => {
    const refs = detectReferences([chunk(0, "Src", "See the Bylaws for details.")]);
    const [r] = resolveAgainstGroup(refs, [doc("d1", "Bylaws.pdf", ["Something Else"])]);
    expect(r!.method).toBe("filename_match");
    expect(r!.target_filename).toBe("Bylaws.pdf");
    expect(r!.target_section).toBeNull();
  });

  it("marks a reference unresolved when the group has nothing matching", () => {
    const refs = detectReferences([chunk(0, "Src", "See the Bylaws for details.")]);
    const [r] = resolveAgainstGroup(refs, [doc("d1", "invoice.pdf", ["Totals"])]);
    expect(r!.method).toBe("unresolved");
    expect(r!.resolved).toBe(false);
    expect(r!.target_filename).toBeNull();
  });

  it("does not let a blank chunk title swallow every reference", () => {
    // `refLower.includes("")` is always true, so an untitled section used to
    // match anything and resolve the whole document to one arbitrary chunk.
    const refs = detectReferences([chunk(0, "Src", "See the Bylaws for details.")]);
    const withBlankTitle: GroupDocument = {
      id: "d1",
      filename: "invoice.pdf",
      extractionJson: {},
      chunksJson: [chunk(0, "  ", "untitled section body")],
    };
    const [r] = resolveAgainstGroup(refs, [withBlankTitle]);
    expect(r!.method).toBe("unresolved");
  });

  it("returns one entry per detected reference, resolved or not", () => {
    const refs = detectReferences([chunk(0, "Src", "See the Bylaws. Refer to the Ledger.")]);
    const out = resolveAgainstGroup(refs, [doc("d1", "Bylaws.pdf")]);
    expect(out).toHaveLength(refs.length);
    expect(out.filter(r => r.resolved).length).toBe(1);
    expect(out.filter(r => !r.resolved).length).toBe(refs.length - 1);
  });

  it("handles a group document with no chunks", () => {
    const noChunks: GroupDocument = { id: "d1", filename: "Bylaws.pdf", extractionJson: {}, chunksJson: null };
    const refs = detectReferences([chunk(0, "Src", "See the Bylaws.")]);
    expect(resolveAgainstGroup(refs, [noChunks])[0]!.method).toBe("filename_match");
  });
});
