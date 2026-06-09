import { describe, it, expect } from "vitest";
import {
  buildDocumentMap,
  classifyChunk,
  detectSignals,
  type Chunk,
} from "./document-map";

// ── Table Dedup ─────────────────────────────────────────────────────

describe("table row dedup", () => {
  it("collapses tripled alphabetic cells", () => {
    const md = "| Dated | Dated | Dated | April 9, 2026 | April 9, 2026 | April 9, 2026 |";
    const chunks = buildDocumentMap(md);
    const content = chunks[0]!.content;
    // "Dated" should appear once, not three times
    expect(content.split("Dated").length - 1).toBe(1);
    // "April 9, 2026" should appear once, not three times
    expect(content.split("April 9, 2026").length - 1).toBe(1);
  });

  it("preserves numeric-only repeated cells", () => {
    const md = "| Revenue | $100 | $100 | $100 |";
    const chunks = buildDocumentMap(md);
    const content = chunks[0]!.content;
    // All three $100 should remain — legitimate financial data
    expect(content.split("$100").length - 1).toBe(3);
  });

  it("preserves separator rows", () => {
    const md = "|---|---|---|";
    const chunks = buildDocumentMap(md);
    expect(chunks[0]!.content).toContain("|---|---|---|");
  });

  it("passes through non-table content unchanged", () => {
    const md = "Just a regular paragraph with no pipes.";
    const chunks = buildDocumentMap(md);
    expect(chunks[0]!.content).toBe("Just a regular paragraph with no pipes.");
  });
});

// ── Heading Inference ───────────────────────────────────────────────

describe("heading inference", () => {
  it("leaves markdown with existing headings unchanged", () => {
    const md = "# Real Heading\n\nSome content here.";
    const chunks = buildDocumentMap(md);
    expect(chunks[0]!.title).toBe("Real Heading");
    expect(chunks.length).toBe(1);
  });

  it("promotes bold lines to headings", () => {
    const md = "**INVOICE SUMMARY**\n\nSome invoice content here.";
    const chunks = buildDocumentMap(md);
    expect(chunks[0]!.title).toBe("INVOICE SUMMARY");
  });

  it("promotes ALL CAPS lines to headings", () => {
    const md = "INVOICE SUMMARY\n\nSome invoice content here.";
    const chunks = buildDocumentMap(md);
    expect(chunks[0]!.title).toBe("INVOICE SUMMARY");
  });

  it("merges blank-separated bold lines into one heading (stanza)", () => {
    const md = "**Book Title**\n\n**Author Name**\n\nContent below the title.";
    const chunks = buildDocumentMap(md);
    expect(chunks[0]!.title).toBe("Book Title Author Name");
  });

  it("disbands stanzas of 5+ bold lines (no headings promoted)", () => {
    // Each bold line must have a blank above to be a heading candidate.
    // When 5+ such candidates form a stanza, they're all disbanded.
    const lines: string[] = [];
    for (let i = 1; i <= 5; i++) {
      lines.push("", `**Line ${i}**`);
    }
    lines.push("", "Some real content.");
    const md = lines.join("\n");
    const chunks = buildDocumentMap(md);
    // The stanza is disbanded — none of the bold lines become headings.
    // Everything stays in one chunk under "Document Start".
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.title).toBe("Document Start");
  });

  it("does not promote short non-alphabetic bold spans", () => {
    const md = "**12345**\n\nContent after number.";
    const chunks = buildDocumentMap(md);
    // "12345" should not become a heading (fails alpha >= 3 check)
    expect(chunks[0]!.title).toBe("Document Start");
  });

  it("uses schema heading patterns", () => {
    const md = "SECTION 42\n\nContent for section 42.";
    const schema = {
      headings: {
        patterns: ["^SECTION \\d+$"],
      },
    };
    const chunks = buildDocumentMap(md, schema);
    expect(chunks[0]!.title).toBe("SECTION 42");
  });

  it("respects headings.infer: false", () => {
    const md = "**INVOICE SUMMARY**\n\nSome content.";
    const schema = { headings: { infer: false } };
    const chunks = buildDocumentMap(md, schema);
    // Should NOT promote the bold line
    expect(chunks[0]!.title).toBe("Document Start");
  });

  it("respects headings.generic: false but keeps schema patterns", () => {
    const md = "**Bold Line**\n\nSECTION 1\n\nContent.";
    const schema = {
      headings: {
        generic: false,
        patterns: ["^SECTION \\d+$"],
      },
    };
    const chunks = buildDocumentMap(md, schema);
    // Bold line should NOT be promoted (generic disabled)
    // But SECTION 1 should be promoted (schema pattern)
    const titles = chunks.map((c) => c.title);
    expect(titles).not.toContain("Bold Line");
    expect(titles).toContain("SECTION 1");
  });
});

// ── Signal Detection ────────────────────────────────────────────────

describe("detectSignals", () => {
  it("detects dollar amounts", () => {
    const signals = detectSignals("Total: $1,234.56 and €500.00");
    expect(signals.has_dollar_amounts).toBe(true);
    expect(signals.dollar_count).toBeGreaterThanOrEqual(1);
  });

  it("detects dates — numeric separators", () => {
    const signals = detectSignals("Date: 04/10/2026");
    expect(signals.has_dates).toBe(true);
  });

  it("detects dates — month-name leading", () => {
    const signals = detectSignals("Effective: April 10, 2026");
    expect(signals.has_dates).toBe(true);
  });

  it("detects dates — day-leading European", () => {
    const signals = detectSignals("Signed: 10 April 2026");
    expect(signals.has_dates).toBe(true);
  });

  it("detects dates — month + year only", () => {
    const signals = detectSignals("Period: April 2026");
    expect(signals.has_dates).toBe(true);
  });

  it("detects dates — quarter references", () => {
    const signals = detectSignals("Q1 2026 results");
    expect(signals.has_dates).toBe(true);
  });

  it("detects dates — fiscal year prefix", () => {
    const signals = detectSignals("FY2026 budget");
    expect(signals.has_dates).toBe(true);
  });

  it("detects dates — non-English month names", () => {
    const signals = detectSignals("10 avril 2026");
    expect(signals.has_dates).toBe(true);
  });

  it("detects dates — German months", () => {
    const signals = detectSignals("15 März 2025");
    expect(signals.has_dates).toBe(true);
  });

  it("detects dates — Spanish months", () => {
    const signals = detectSignals("1 de enero de 2026");
    expect(signals.has_dates).toBe(true);
  });

  it("detects key-value pairs", () => {
    const signals = detectSignals("Policy Number: ABC-123\nInsured: John Doe");
    expect(signals.has_key_value_pairs).toBe(true);
    expect(signals.kv_count).toBe(2);
  });

  it("detects tables", () => {
    const signals = detectSignals("| Name | Amount |\n|---|---|\n| Alice | $100 |");
    expect(signals.has_tables).toBe(true);
    expect(signals.table_row_count).toBeGreaterThanOrEqual(2);
  });

  it("returns empty signals for plain text", () => {
    const signals = detectSignals("Just some plain text with nothing special.");
    expect(signals.has_dollar_amounts).toBeUndefined();
    expect(signals.has_dates).toBeUndefined();
    expect(signals.has_key_value_pairs).toBeUndefined();
    expect(signals.has_tables).toBeUndefined();
  });

  it("detects custom signals from schema", () => {
    const custom: [string, RegExp][] = [
      ["has_policy_numbers", /[A-Z]{2,5}\d{5,}/],
    ];
    const signals = detectSignals("Policy: CGL2867825", custom);
    expect(signals.has_policy_numbers).toBe(true);
    expect(signals.has_policy_numbers_count).toBe(1);
  });
});

// ── Chunk Classification ────────────────────────────────────────────

describe("classifyChunk", () => {
  const keywords: [string[], string][] = [
    [["invoice", "receipt", "bill to"], "header"],
    [["description", "quantity", "unit price"], "line_items"],
    [["subtotal", "tax", "total due"], "totals"],
  ];

  it("returns 'other' with no keywords", () => {
    expect(classifyChunk("Some Title", "Some content")).toBe("other");
  });

  it("matches by title when title_priority is true", () => {
    expect(classifyChunk("Invoice Details", "random content", keywords)).toBe("header");
  });

  it("matches by content threshold", () => {
    const content = "The subtotal is $100. Total due is $110. Tax is $10.";
    expect(classifyChunk("Amounts", content, keywords)).toBe("totals");
  });

  it("requires threshold hits (single keyword not enough)", () => {
    const content = "The subtotal is $100.";
    expect(classifyChunk("Amounts", content, keywords)).toBe("other");
  });

  it("respects window size (head strategy)", () => {
    // Put keyword at beginning — should match with small window
    const content = "invoice receipt " + "x".repeat(1000) + " description quantity";
    expect(
      classifyChunk("Title", content, keywords, {
        window: 50,
        threshold: 2,
        scan: "head",
        title_priority: false,
      }),
    ).toBe("header");
  });

  it("head_and_tail scans both ends", () => {
    const content = "invoice " + "x".repeat(2000) + " receipt";
    expect(
      classifyChunk("Title", content, keywords, {
        window: 100,
        threshold: 2,
        scan: "head_and_tail",
        title_priority: false,
      }),
    ).toBe("header");
  });
});

// ── Full Document Map ───────────────────────────────────────────────

describe("buildDocumentMap", () => {
  it("splits at heading boundaries", () => {
    const md = [
      "# Section One",
      "Content for section one.",
      "# Section Two",
      "Content for section two.",
    ].join("\n");
    const chunks = buildDocumentMap(md);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.title).toBe("Section One");
    expect(chunks[1]!.title).toBe("Section Two");
    expect(chunks[0]!.index).toBe(0);
    expect(chunks[1]!.index).toBe(1);
  });

  it("classifies chunks using schema categories", () => {
    const md = [
      "# Invoice Header",
      "Invoice number: INV-001",
      "Bill to: Acme Corp",
      "# Line Items",
      "| Description | Quantity | Unit Price |",
      "|---|---|---|",
      "| Widget | 5 | $10.00 |",
    ].join("\n");
    const schema = {
      categories: {
        keywords: {
          header: ["invoice", "bill to"],
          line_items: ["description", "quantity", "unit price"],
        },
      },
    };
    const chunks = buildDocumentMap(md, schema);
    expect(chunks[0]!.category).toBe("header");
    expect(chunks[1]!.category).toBe("line_items");
  });

  it("detects signals on each chunk", () => {
    const md = [
      "# Header",
      "Date: 04/10/2026",
      "# Amounts",
      "Total: $1,234.56",
    ].join("\n");
    const chunks = buildDocumentMap(md);
    expect(chunks[0]!.signals.has_dates).toBe(true);
    expect(chunks[1]!.signals.has_dollar_amounts).toBe(true);
  });

  it("splits oversized chunks at paragraph boundaries", () => {
    // Build a chunk with 600 lines (over the 500-line limit)
    const lines = ["# Big Section"];
    for (let i = 0; i < 600; i++) {
      lines.push(`Line ${i}`);
      if (i === 300) lines.push(""); // blank line as paragraph boundary
    }
    const chunks = buildDocumentMap(lines.join("\n"));
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be at most 500 lines
    for (const chunk of chunks) {
      expect(chunk.content.split("\n").length).toBeLessThanOrEqual(500);
    }
  });

  it("hard-cuts when no paragraph boundaries exist", () => {
    // 600 lines with no blanks
    const lines = ["# Wall of Text"];
    for (let i = 0; i < 600; i++) {
      lines.push(`Line ${i}`);
    }
    const chunks = buildDocumentMap(lines.join("\n"));
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("handles empty input", () => {
    const chunks = buildDocumentMap("");
    expect(chunks.length).toBe(0);
  });

  it("handles single chunk with no headings", () => {
    const md = "Just some content without any headings or structure.";
    const chunks = buildDocumentMap(md);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.title).toBe("Document Start");
  });

  it("reindexes chunks after oversized split", () => {
    const lines = ["# First", "Short content.", "# Big Section"];
    for (let i = 0; i < 600; i++) {
      lines.push(`Line ${i}`);
      if (i === 300) lines.push("");
    }
    const chunks = buildDocumentMap(lines.join("\n"));
    // All indices should be sequential
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.index).toBe(i);
    }
  });

  it("provides line_count and char_count on chunks", () => {
    const md = "# Test\nLine one\nLine two\nLine three";
    const chunks = buildDocumentMap(md);
    expect(chunks[0]!.lineCount).toBe(3);
    expect(chunks[0]!.charCount).toBeGreaterThan(0);
  });
});
