import { describe, it, expect } from "vitest";
import { spatialToMarkdown, type ParsedPage, type TextItem } from "./spatial-to-markdown";

// Helper to create text items at specific positions
function item(text: string, x: number, y: number, opts?: Partial<TextItem>): TextItem {
  const fontSize = opts?.fontSize ?? 12;
  return {
    text,
    x,
    y,
    width: text.length * fontSize * 0.6, // approximate
    height: fontSize * 1.2,
    fontName: opts?.fontName ?? "Helvetica",
    fontSize,
    ...opts,
  };
}

function page(items: TextItem[], pageNum = 1): ParsedPage {
  return {
    pageNum,
    width: 612, // standard US Letter
    height: 792,
    text: items.map((i) => i.text).join(" "),
    textItems: items,
  };
}

describe("spatialToMarkdown", () => {
  describe("basic text", () => {
    it("converts a single line of text", () => {
      const result = spatialToMarkdown([
        page([item("Hello world", 72, 100)]),
      ]);
      expect(result).toBe("Hello world");
    });

    it("handles empty pages with raw text fallback", () => {
      const p: ParsedPage = {
        pageNum: 1,
        width: 612,
        height: 792,
        text: "Fallback text",
        textItems: [],
      };
      const result = spatialToMarkdown([p]);
      expect(result).toBe("Fallback text");
    });

    it("joins items on the same line with spaces", () => {
      const result = spatialToMarkdown([
        page([
          item("Hello", 72, 100),
          item("world", 120, 100),
        ]),
      ]);
      expect(result).toBe("Hello world");
    });

    it("creates paragraphs from vertically separated text", () => {
      const result = spatialToMarkdown([
        page([
          item("First paragraph.", 72, 100),
          item("Second paragraph.", 72, 140), // large y gap
        ]),
      ]);
      expect(result).toContain("First paragraph.");
      expect(result).toContain("Second paragraph.");
      expect(result.split("\n\n").length).toBeGreaterThanOrEqual(2);
    });

    it("joins lines in the same paragraph", () => {
      const result = spatialToMarkdown([
        page([
          item("This is the start of", 72, 100, { fontSize: 12 }),
          item("a sentence that wraps.", 72, 114, { fontSize: 12 }), // small y gap
        ]),
      ]);
      expect(result).toContain("This is the start of a sentence that wraps.");
    });
  });

  describe("headings", () => {
    it("detects headings by larger font size", () => {
      const result = spatialToMarkdown([
        page([
          item("Main Title", 72, 80, { fontSize: 24 }),
          item("Body text here.", 72, 130, { fontSize: 12 }),
          item("More body text.", 72, 145, { fontSize: 12 }),
        ]),
      ]);
      expect(result).toMatch(/^# Main Title/m);
      expect(result).toContain("Body text here.");
    });

    it("assigns heading levels by font size ratio", () => {
      const result = spatialToMarkdown([
        page([
          item("H1 Title", 72, 50, { fontSize: 28 }),
          item("Body.", 72, 100, { fontSize: 12 }),
          item("H2 Section", 72, 150, { fontSize: 20 }),
          item("Body.", 72, 200, { fontSize: 12 }),
          item("H3 Subsection", 72, 250, { fontSize: 16 }),
          item("Body.", 72, 300, { fontSize: 12 }),
        ]),
      ]);
      expect(result).toMatch(/^# H1 Title/m);
      expect(result).toMatch(/^## H2 Section/m);
      expect(result).toMatch(/^### H3 Subsection/m);
    });

    it("detects bold short lines as headings", () => {
      const result = spatialToMarkdown([
        page([
          item("Section Title", 72, 80, { fontSize: 12, fontName: "Helvetica-Bold" }),
          item("Regular body text goes here.", 72, 130, { fontSize: 12 }),
        ]),
      ]);
      expect(result).toMatch(/^#{1,4} Section Title/m);
    });
  });

  describe("bold text", () => {
    it("wraps bold body text in ** markers", () => {
      const result = spatialToMarkdown([
        page([
          item("Normal text first.", 72, 80, { fontSize: 12 }),
          item("This is a really important sentence that should be noticed by everyone reading this document carefully.", 72, 130, {
            fontSize: 12,
            fontName: "Helvetica-Bold",
          }),
          item("Back to normal.", 72, 180, { fontSize: 12 }),
        ]),
      ]);
      // Bold long text (> 60 chars, not a heading) should be wrapped in **
      expect(result).toContain("**This is a really important");
    });
  });

  describe("lists", () => {
    it("detects bullet lists", () => {
      const result = spatialToMarkdown([
        page([
          item("• First item", 90, 100),
          item("• Second item", 90, 115),
          item("• Third item", 90, 130),
        ]),
      ]);
      expect(result).toMatch(/^- First item/m);
      expect(result).toMatch(/^- Second item/m);
      expect(result).toMatch(/^- Third item/m);
    });

    it("detects numbered lists", () => {
      const result = spatialToMarkdown([
        page([
          item("1. First", 90, 100),
          item("2. Second", 90, 115),
          item("3. Third", 90, 130),
        ]),
      ]);
      expect(result).toMatch(/^1\.\s+First/m);
      expect(result).toMatch(/^2\.\s+Second/m);
    });

    it("detects dash-style lists", () => {
      const result = spatialToMarkdown([
        page([
          item("- Alpha", 90, 100),
          item("- Beta", 90, 115),
          item("- Gamma", 90, 130),
        ]),
      ]);
      expect(result).toMatch(/^- Alpha/m);
      expect(result).toMatch(/^- Beta/m);
    });
  });

  describe("tables", () => {
    it("detects a simple 3-column table", () => {
      const result = spatialToMarkdown([
        page([
          // Header row
          item("Name", 72, 100),
          item("Age", 250, 100),
          item("City", 400, 100),
          // Row 1
          item("Alice", 72, 120),
          item("30", 250, 120),
          item("NYC", 400, 120),
          // Row 2
          item("Bob", 72, 140),
          item("25", 250, 140),
          item("LA", 400, 140),
          // Row 3
          item("Carol", 72, 160),
          item("35", 250, 160),
          item("Chicago", 400, 160),
        ]),
      ]);
      expect(result).toContain("| Name");
      expect(result).toContain("| ---");
      expect(result).toContain("| Alice");
      expect(result).toContain("| Bob");
    });

    it("detects a 2-column key-value table", () => {
      const result = spatialToMarkdown([
        page([
          item("Policy Number", 72, 100),
          item("POL-12345", 300, 100),
          item("Effective Date", 72, 120),
          item("2026-01-01", 300, 120),
          item("Expiration Date", 72, 140),
          item("2027-01-01", 300, 140),
          item("Premium", 72, 160),
          item("$1,200.00", 300, 160),
        ]),
      ]);
      expect(result).toContain("|");
      expect(result).toContain("Policy Number");
      expect(result).toContain("POL-12345");
    });

    it("handles table followed by regular text", () => {
      const result = spatialToMarkdown([
        page([
          // Table
          item("Col A", 72, 100),
          item("Col B", 300, 100),
          item("Val 1", 72, 120),
          item("Val 2", 300, 120),
          item("Val 3", 72, 140),
          item("Val 4", 300, 140),
          item("Val 5", 72, 160),
          item("Val 6", 300, 160),
          // Regular text after gap
          item("This is a note below the table.", 72, 220),
        ]),
      ]);
      expect(result).toContain("| Col A");
      expect(result).toContain("This is a note below the table.");
    });
  });

  describe("multi-page documents", () => {
    it("separates pages with horizontal rules", () => {
      const result = spatialToMarkdown([
        page([item("Page one content.", 72, 100)], 1),
        page([item("Page two content.", 72, 100)], 2),
      ]);
      expect(result).toContain("Page one content.");
      expect(result).toContain("---");
      expect(result).toContain("Page two content.");
    });
  });

  describe("mixed document structure", () => {
    it("handles heading + paragraph + list + table", () => {
      const result = spatialToMarkdown([
        page([
          // Heading
          item("Insurance Policy Summary", 72, 50, { fontSize: 22 }),
          // Paragraph
          item("This policy provides coverage for the insured property", 72, 100, { fontSize: 12 }),
          item("located at the address listed below.", 72, 114, { fontSize: 12 }),
          // Subheading — large y gap before table so it's not absorbed
          item("Coverage Details", 72, 160, { fontSize: 16 }),
          // Key-value table — starts after a big gap
          item("Type", 72, 220),
          item("Amount", 300, 220),
          item("Dwelling", 72, 250),
          item("$500,000", 300, 250),
          item("Liability", 72, 280),
          item("$300,000", 300, 280),
          item("Contents", 72, 310),
          item("$100,000", 300, 310),
          // List after table (big gap)
          item("Exclusions:", 72, 380, { fontSize: 12, fontName: "Helvetica-Bold" }),
          item("• Flood damage", 90, 410),
          item("• Earthquake damage", 90, 430),
          item("• Acts of war", 90, 450),
        ]),
      ]);

      expect(result).toMatch(/^# Insurance Policy Summary/m);
      expect(result).toContain("coverage for the insured property");
      expect(result).toMatch(/^#{2,3} Coverage Details/m);
      expect(result).toContain("| Type");
      expect(result).toContain("| Dwelling");
      expect(result).toContain("- Flood damage");
      expect(result).toContain("- Earthquake damage");
    });
  });

  describe("edge cases", () => {
    it("handles single-item pages", () => {
      const result = spatialToMarkdown([
        page([item("Just one line.", 72, 400)]),
      ]);
      expect(result).toBe("Just one line.");
    });

    it("handles pages with only whitespace items", () => {
      const result = spatialToMarkdown([
        page([item("   ", 72, 100)]),
      ]);
      expect(result).toBe("");
    });

    it("handles items with no font metadata", () => {
      const result = spatialToMarkdown([
        page([
          { text: "No font info", x: 72, y: 100, width: 80, height: 14 },
        ]),
      ]);
      expect(result).toBe("No font info");
    });
  });
});
