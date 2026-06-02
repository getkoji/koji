import { describe, it, expect } from "vitest";
import {
  isTableHeavy,
  markdownTablesToHtml,
  adaptiveTableFormat,
} from "./table-format";

// ---------------------------------------------------------------------------
// isTableHeavy
// ---------------------------------------------------------------------------

describe("isTableHeavy", () => {
  it("returns false for plain text", () => {
    expect(isTableHeavy("Hello world\nThis is a paragraph.\nNothing tabular here.")).toBe(false);
  });

  it("returns false for a tiny table (under threshold)", () => {
    const md = [
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
    ].join("\n");
    expect(isTableHeavy(md)).toBe(false);
  });

  it("returns true for a table-dominated document", () => {
    const md = [
      "# Loss Run Report",
      "",
      "| Policy | Claim | Date | Amount | Status |",
      "|--------|-------|------|--------|--------|",
      "| P-001  | C-100 | 2024-01-15 | 5000 | Open |",
      "| P-001  | C-101 | 2024-02-20 | 3200 | Closed |",
      "| P-002  | C-102 | 2024-03-10 | 12000 | Open |",
      "| P-002  | C-103 | 2024-04-05 | 800 | Closed |",
      "| P-003  | C-104 | 2024-05-18 | 45000 | Open |",
      "| P-003  | C-105 | 2024-06-01 | 1500 | Closed |",
    ].join("\n");
    expect(isTableHeavy(md)).toBe(true);
  });

  it("returns false when tables are a small part of a large document", () => {
    const paragraphs = Array(20).fill("This is a paragraph of text about the policy.").join("\n");
    const md = [
      paragraphs,
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "| 3 | 4 |",
    ].join("\n");
    expect(isTableHeavy(md)).toBe(false);
  });

  it("returns false for empty text", () => {
    expect(isTableHeavy("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// markdownTablesToHtml
// ---------------------------------------------------------------------------

describe("markdownTablesToHtml", () => {
  it("converts a simple table to HTML", () => {
    const md = [
      "| Name | Amount |",
      "|------|--------|",
      "| Alice | 100 |",
      "| Bob | 200 |",
    ].join("\n");

    const html = markdownTablesToHtml(md);
    expect(html).toContain("<table>");
    expect(html).toContain("<thead>");
    expect(html).toContain("<th>Name</th>");
    expect(html).toContain("<th>Amount</th>");
    expect(html).toContain("<tbody>");
    expect(html).toContain("<td>Alice</td>");
    expect(html).toContain("<td>100</td>");
    expect(html).toContain("<td>Bob</td>");
    expect(html).toContain("<td>200</td>");
    expect(html).toContain("</table>");
  });

  it("preserves non-table content", () => {
    const md = [
      "# Header",
      "",
      "Some paragraph text.",
      "",
      "| Col1 | Col2 |",
      "|------|------|",
      "| A | B |",
      "",
      "More text after the table.",
    ].join("\n");

    const result = markdownTablesToHtml(md);
    expect(result).toContain("# Header");
    expect(result).toContain("Some paragraph text.");
    expect(result).toContain("More text after the table.");
    expect(result).toContain("<table>");
    expect(result).toContain("<th>Col1</th>");
  });

  it("handles multiple tables", () => {
    const md = [
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "Break between tables.",
      "",
      "| X | Y |",
      "|---|---|",
      "| 3 | 4 |",
    ].join("\n");

    const result = markdownTablesToHtml(md);
    const tableCount = (result.match(/<table>/g) || []).length;
    expect(tableCount).toBe(2);
  });

  it("escapes HTML entities in cell content", () => {
    const md = [
      "| Field | Value |",
      "|-------|-------|",
      "| tax | <5% |",
      "| name | A & B |",
    ].join("\n");

    const result = markdownTablesToHtml(md);
    expect(result).toContain("&lt;5%");
    expect(result).toContain("A &amp; B");
  });

  it("handles table without separator (no header)", () => {
    const md = [
      "| A | B |",
      "| 1 | 2 |",
      "| 3 | 4 |",
    ].join("\n");

    const result = markdownTablesToHtml(md);
    expect(result).toContain("<table>");
    expect(result).not.toContain("<thead>");
    expect(result).toContain("<td>A</td>");
  });

  it("returns input unchanged when no tables present", () => {
    const text = "Just some plain text.\nNo tables here.";
    expect(markdownTablesToHtml(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// adaptiveTableFormat
// ---------------------------------------------------------------------------

describe("adaptiveTableFormat", () => {
  it("returns converted=false for non-table content", () => {
    const result = adaptiveTableFormat("Hello world\nNo tables.");
    expect(result.converted).toBe(false);
    expect(result.text).toBe("Hello world\nNo tables.");
  });

  it("converts tables and sets converted=true for table-heavy content", () => {
    const md = [
      "# Report",
      "| Policy | Claim | Date | Amount | Status |",
      "|--------|-------|------|--------|--------|",
      "| P-001  | C-100 | 2024-01-15 | 5000 | Open |",
      "| P-001  | C-101 | 2024-02-20 | 3200 | Closed |",
      "| P-002  | C-102 | 2024-03-10 | 12000 | Open |",
      "| P-002  | C-103 | 2024-04-05 | 800 | Closed |",
      "| P-003  | C-104 | 2024-05-18 | 45000 | Open |",
      "| P-003  | C-105 | 2024-06-01 | 1500 | Closed |",
    ].join("\n");

    const result = adaptiveTableFormat(md);
    expect(result.converted).toBe(true);
    expect(result.text).toContain("<table>");
    expect(result.text).toContain("# Report");
  });
});
