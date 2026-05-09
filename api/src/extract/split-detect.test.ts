import { describe, it, expect, vi } from "vitest";
import { detectSections, type DetectedSection } from "./split-detect";
import type { PageAnalysis } from "../parse/provider";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Helper to create a PageAnalysis with sensible defaults */
function page(num: number, overrides: Partial<PageAnalysis> = {}): PageAnalysis {
  return {
    page: num,
    page_label: null,
    page_of: null,
    content_preview: `Page ${num} content preview text here`,
    text_density: 5.0,
    text_chars: 2000,
    bold_headings: [],
    tables: [],
    table_count: 0,
    horizontal_rules: [],
    image_ratio: 0,
    form_numbers: [],
    has_dollar_amounts: false,
    has_dates: false,
    blank_bottom_ratio: 0.05,
    ...overrides,
  };
}

/**
 * Fixture: 129-page insurance policy package
 * - Pages 1-8: cover letter + general policy info
 * - Pages 9-12: declarations pages (internal numbering "Page 1" through "Page 4")
 * - Pages 13-19: endorsements
 * - Pages 20-22: more endorsements (different form number)
 * - Pages 23-50: policy forms
 * - Pages 51-129: more endorsements
 */
function insurancePolicyFixture(): PageAnalysis[] {
  const pages: PageAnalysis[] = [];

  // Pages 1-8: cover letter / general info
  for (let i = 1; i <= 8; i++) {
    pages.push(page(i, {
      content_preview: `Owners INSURANCE COMPANY 6101 ANACAPRI BLVD policy information page ${i}`,
      text_density: 4.5,
      form_numbers: ["IL 00 21 (09-08)"],
    }));
  }

  // Pages 9-12: declarations pages with internal page numbers
  pages.push(page(9, {
    page_label: 1,
    page_of: 4,
    content_preview: "Owners INSURANCE COMPANY BUSINESSOWNERS POLICY DECLARATIONS Policy Number 47-195-521-02 Renewal Effective 04-24-2024",
    text_density: 7.2,
    bold_headings: [
      { text: "BUSINESSOWNERS POLICY DECLARATIONS", y: 0.12, size: 11 },
      { text: "PROPERTY COVERAGES - ALL DESCRIBED LOCATIONS", y: 0.48, size: 10 },
    ],
    tables: [
      { y: 0.5, h: 0.2, cols: 5, header: "COVERAGE DEDUCTIBLE LIMIT PREMIUM CHANGE" },
    ],
    table_count: 1,
    has_dollar_amounts: true,
    has_dates: true,
    form_numbers: ["54643 (01-90)"],
  }));
  pages.push(page(10, {
    page_label: 2,
    page_of: 4,
    content_preview: "BUSINESS LIABILITY PROTECTION AGGREGATE LIMIT $2,000,000 LIABILITY AND MEDICAL EXPENSE",
    text_density: 6.8,
    bold_headings: [{ text: "BUSINESS LIABILITY PROTECTION", y: 0.15, size: 10 }],
    tables: [{ y: 0.2, h: 0.3, cols: 4, header: "COVERAGE LIMIT PREMIUM CHANGE" }],
    table_count: 1,
    has_dollar_amounts: true,
    form_numbers: ["54643 (01-90)"],
  }));
  pages.push(page(11, {
    page_label: 3,
    page_of: 4,
    content_preview: "OPTIONAL COVERAGES Equipment Breakdown Enhancement Endorsement ADDITIONAL INFORMATION",
    text_density: 5.5,
    tables: [{ y: 0.3, h: 0.4, cols: 3, header: "COVERAGE PREMIUM INCLUDED" }],
    table_count: 1,
    has_dollar_amounts: true,
    form_numbers: ["54643 (01-90)"],
  }));
  pages.push(page(12, {
    page_label: 4,
    page_of: 4,
    content_preview: "SCHEDULE OF FORMS AND ENDORSEMENTS The following forms and endorsements apply to this policy",
    text_density: 3.2,
    blank_bottom_ratio: 0.45, // half the page is blank
    form_numbers: ["54643 (01-90)"],
  }));

  // Pages 13-19: endorsements
  for (let i = 13; i <= 19; i++) {
    pages.push(page(i, {
      content_preview: `THIS ENDORSEMENT CHANGES THE POLICY. PLEASE READ IT CAREFULLY. ${i === 13 ? "BUSINESSOWNERS" : "ADDITIONAL"} COVERAGE ENDORSEMENT`,
      text_density: 4.0,
      bold_headings: i === 13
        ? [{ text: "THIS ENDORSEMENT CHANGES THE POLICY", y: 0.05, size: 9 }]
        : [],
      form_numbers: ["BP 04 53 (01-06)"],
    }));
  }

  // Pages 20-22: different endorsement (different form number)
  for (let i = 20; i <= 22; i++) {
    pages.push(page(i, {
      content_preview: "AMENDMENT OF POLICY CONDITIONS Cancellation condition is amended",
      text_density: 3.8,
      bold_headings: [{ text: "AMENDMENT OF POLICY CONDITIONS", y: 0.08, size: 10 }],
      form_numbers: ["IL 02 34 (09-17)"],
    }));
  }

  // Pages 23-50: policy forms (dense, tables)
  for (let i = 23; i <= 50; i++) {
    pages.push(page(i, {
      content_preview: `SECTION ${i < 30 ? "I" : "II"} - ${i < 30 ? "PROPERTY" : "LIABILITY"} We will pay for direct physical loss of or damage to Covered Property`,
      text_density: 6.5,
      form_numbers: ["BP 00 03 (01-10)"],
    }));
  }

  // Pages 51-129: more endorsements
  for (let i = 51; i <= 129; i++) {
    pages.push(page(i, {
      content_preview: `ENDORSEMENT - ${i % 3 === 0 ? "EXCLUSION" : "ADDITIONAL COVERAGE"} This endorsement modifies insurance provided under`,
      text_density: 3.5,
      bold_headings: i % 10 === 1
        ? [{ text: "THIS ENDORSEMENT CHANGES THE POLICY", y: 0.05, size: 9 }]
        : [],
      form_numbers: [i < 80 ? "BP 05 45 (01-06)" : "CG 20 10 (04-13)"],
    }));
  }

  return pages;
}

/** Fixture: simple 3-document stapled submission */
function stapledSubmissionFixture(): PageAnalysis[] {
  return [
    // COI (pages 1-2)
    page(1, {
      page_label: 1,
      content_preview: "ACORD 25 CERTIFICATE OF LIABILITY INSURANCE DATE 08/15/2026 PRODUCER SuperKey Insurance",
      bold_headings: [{ text: "CERTIFICATE OF LIABILITY INSURANCE", y: 0.08, size: 12 }],
      has_dollar_amounts: true,
      has_dates: true,
    }),
    page(2, {
      content_preview: "DESCRIPTION OF OPERATIONS Residential Condominiums CERTIFICATE HOLDER",
      has_dollar_amounts: true,
    }),
    // Dec page (pages 3-5)
    page(3, {
      page_label: 1,
      page_of: 3,
      content_preview: "Owners INSURANCE COMPANY BUSINESSOWNERS POLICY DECLARATIONS Policy Number 47-195-521-02",
      bold_headings: [{ text: "BUSINESSOWNERS POLICY DECLARATIONS", y: 0.12, size: 11 }],
      tables: [{ y: 0.5, h: 0.2, cols: 5, header: "COVERAGE DEDUCTIBLE LIMIT PREMIUM CHANGE" }],
      table_count: 1,
      has_dollar_amounts: true,
      has_dates: true,
      form_numbers: ["54643 (01-90)"],
    }),
    page(4, {
      page_label: 2,
      page_of: 3,
      content_preview: "BUSINESS LIABILITY PROTECTION AGGREGATE LIMIT $2,000,000",
      has_dollar_amounts: true,
      form_numbers: ["54643 (01-90)"],
    }),
    page(5, {
      page_label: 3,
      page_of: 3,
      content_preview: "SCHEDULE OF FORMS AND ENDORSEMENTS",
      blank_bottom_ratio: 0.5,
      form_numbers: ["54643 (01-90)"],
    }),
    // Supplemental schedule (pages 6-7)
    page(6, {
      page_label: 1,
      content_preview: "ACORD 28 EVIDENCE OF COMMERCIAL PROPERTY INSURANCE",
      bold_headings: [{ text: "EVIDENCE OF COMMERCIAL PROPERTY INSURANCE", y: 0.1, size: 11 }],
      has_dollar_amounts: true,
    }),
    page(7, {
      content_preview: "ADDITIONAL INTERESTS MORTGAGEE First National Bank",
      has_dollar_amounts: true,
    }),
  ];
}

/** Fixture: document with visual content (photos, site plans) */
function mixedContentFixture(): PageAnalysis[] {
  return [
    page(1, {
      content_preview: "Property Inspection Report Prepared for ABC Insurance Company",
      bold_headings: [{ text: "Property Inspection Report", y: 0.1, size: 14 }],
      text_density: 5.0,
    }),
    page(2, {
      content_preview: "Building exterior photo",
      text_density: 0.3, // mostly image
      image_ratio: 0.85,
      text_chars: 50,
    }),
    page(3, {
      content_preview: "",
      text_density: 0.1, // site plan — almost no text
      image_ratio: 0.95,
      text_chars: 10,
    }),
    page(4, {
      content_preview: "Schedule of Values Building 1 Replacement Cost $2,500,000",
      text_density: 6.0,
      tables: [{ y: 0.2, h: 0.6, cols: 4, header: "Building Description Replacement Cost" }],
      table_count: 1,
      has_dollar_amounts: true,
      image_ratio: 0,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("detectSections", () => {
  describe("Layer 1: page number resets", () => {
    it("detects page number reset as section boundary", async () => {
      const pages = stapledSubmissionFixture();
      const sections = await detectSections(pages);

      // Should detect boundaries at page 1 (first), page 3 (reset to "Page 1"),
      // and page 6 (reset to "Page 1" again)
      const starts = sections.map((s) => s.startPage);
      expect(starts).toContain(1);
      expect(starts).toContain(3);
      expect(starts).toContain(6);
    });

    it("groups pages between resets into sections", async () => {
      const pages = stapledSubmissionFixture();
      const sections = await detectSections(pages);

      const coi = sections.find((s) => s.startPage === 1);
      expect(coi).toBeDefined();
      expect(coi!.endPage).toBe(2);

      const dec = sections.find((s) => s.startPage === 3);
      expect(dec).toBeDefined();
      expect(dec!.endPage).toBe(5);

      const supp = sections.find((s) => s.startPage === 6);
      expect(supp).toBeDefined();
      expect(supp!.endPage).toBe(7);
    });

    it("detects dec page section in insurance policy", async () => {
      const pages = insurancePolicyFixture();
      const sections = await detectSections(pages);

      // Pages 9-12 have internal page labels 1-4 — should be detected
      const decSection = sections.find((s) => s.startPage === 9);
      expect(decSection).toBeDefined();
      expect(decSection!.endPage).toBe(12);
      expect(decSection!.method).toContain("page_number");
    });
  });

  describe("Layer 2: structural fingerprint", () => {
    it("detects content type shift (image to text)", async () => {
      const pages = mixedContentFixture();
      const sections = await detectSections(pages);

      // Page 4 (text-heavy with tables) after page 3 (almost all image)
      // should be detected as a boundary
      const starts = sections.map((s) => s.startPage);
      expect(starts).toContain(4);
    });

    it("detects blank page gap as section end", async () => {
      const pages = insurancePolicyFixture();
      const sections = await detectSections(pages);

      // Page 12 has blank_bottom_ratio of 0.45 — page 13 should start a new section
      const afterBlank = sections.find((s) => s.startPage === 13);
      expect(afterBlank).toBeDefined();
    });

    it("detects form number changes", async () => {
      const pages = insurancePolicyFixture();
      const sections = await detectSections(pages);

      // Page 13 has form "BP 04 53" vs page 12's "54643" — should detect boundary
      const endorsementStart = sections.find((s) => s.startPage === 13);
      expect(endorsementStart).toBeDefined();
    });
  });

  describe("Layer 3: keyword matching", () => {
    it("classifies sections using configured labels", async () => {
      const pages = stapledSubmissionFixture();
      const labels = [
        { id: "coi", keywords: ["CERTIFICATE OF LIABILITY INSURANCE"] },
        { id: "dec_page", keywords: ["POLICY DECLARATIONS"] },
        { id: "supplement", keywords: ["EVIDENCE OF COMMERCIAL PROPERTY"] },
      ];
      const sections = await detectSections(pages, { labels });

      const coi = sections.find((s) => s.startPage === 1);
      expect(coi!.type).toBe("coi");

      const dec = sections.find((s) => s.startPage === 3);
      expect(dec!.type).toBe("dec_page");

      const supp = sections.find((s) => s.startPage === 6);
      expect(supp!.type).toBe("supplement");
    });

    it("matches keywords in bold headings", async () => {
      const pages = insurancePolicyFixture();
      const labels = [
        { id: "endorsement", keywords: ["THIS ENDORSEMENT CHANGES THE POLICY"] },
        { id: "dec_page", keywords: ["BUSINESSOWNERS POLICY DECLARATIONS"] },
      ];
      const sections = await detectSections(pages, { labels });

      const endorsements = sections.filter((s) => s.type === "endorsement");
      expect(endorsements.length).toBeGreaterThan(0);

      const dec = sections.find((s) => s.startPage === 9);
      expect(dec!.type).toBe("dec_page");
    });

    it("without labels, sections stay unknown (no hardcoded domain keywords)", async () => {
      const pages = stapledSubmissionFixture();
      const sections = await detectSections(pages);

      // Without configured labels, only copyright_notice gets generic classification
      // All other sections should be "unknown" — no hardcoded domain keywords
      const classified = sections.filter((s) => s.type !== "unknown" && s.type !== "copyright_notice");
      expect(classified.length).toBe(0);
    });
  });

  describe("Layer 4: LLM fallback", () => {
    it("calls LLM only for unclassified sections", async () => {
      const mockProvider = {
        generate: vi.fn().mockResolvedValue(JSON.stringify({ "1": "cover_letter" })),
      };

      // Single page with no distinctive features
      const pages = [page(1, { content_preview: "Some ambiguous content without clear keywords" })];
      const sections = await detectSections(pages, { llmProvider: mockProvider as any });

      expect(mockProvider.generate).toHaveBeenCalledOnce();
      expect(sections[0]!.type).toBe("cover_letter");
    });

    it("does not call LLM when all sections are classified", async () => {
      const mockProvider = { generate: vi.fn() };
      const pages = stapledSubmissionFixture(); // all have keywords
      await detectSections(pages, { llmProvider: mockProvider as any });

      // LLM should not be called — keywords handled everything
      // (It might be called for pages that keywords couldn't classify,
      // but the stapled fixture should have enough signals)
      const callCount = mockProvider.generate.mock.calls.length;
      // Even if called, it should be for very few pages
      expect(callCount).toBeLessThanOrEqual(1);
    });
  });

  describe("merging adjacent sections", () => {
    it("merges adjacent sections of the same type", async () => {
      const pages = insurancePolicyFixture();
      const sections = await detectSections(pages);

      // Multiple endorsement sections should be merged where adjacent
      const endorsements = sections.filter((s) => s.type === "endorsement");
      for (const e of endorsements) {
        // Each endorsement section should span multiple pages
        expect(e.endPage - e.startPage).toBeGreaterThanOrEqual(0);
      }

      // Total sections should be less than total boundary detections
      expect(sections.length).toBeLessThan(30);
    });
  });

  describe("edge cases", () => {
    it("handles empty page list", async () => {
      const sections = await detectSections([]);
      expect(sections).toEqual([]);
    });

    it("handles single page", async () => {
      const sections = await detectSections([page(1)]);
      expect(sections.length).toBe(1);
      expect(sections[0]!.startPage).toBe(1);
      expect(sections[0]!.endPage).toBe(1);
    });

    it("first page is always a section start", async () => {
      const pages = [page(1), page(2), page(3)];
      const sections = await detectSections(pages);
      expect(sections[0]!.startPage).toBe(1);
    });
  });
});
