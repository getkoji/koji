import { describe, it, expect } from "vitest";
import { resolveProvenance, type TextMap } from "./provenance";

// ---------------------------------------------------------------------------
// Exact string match
// ---------------------------------------------------------------------------

describe("exact string match", () => {
  it("finds an exact string in the markdown", () => {
    const markdown = "Invoice Number: INV-2024-001\nDate: 2024-01-15";
    const result = resolveProvenance({ invoice_number: "INV-2024-001" }, markdown);

    expect(result.invoice_number).not.toBeNull();
    expect(result.invoice_number!.offset).toBe(markdown.indexOf("INV-2024-001"));
    expect(result.invoice_number!.length).toBe("INV-2024-001".length);
    expect(result.invoice_number!.chunk).toBe("INV-2024-001");
  });
});

// ---------------------------------------------------------------------------
// Case-insensitive match
// ---------------------------------------------------------------------------

describe("case-insensitive match", () => {
  it("finds a value with different casing", () => {
    const markdown = "Company: ACME CORPORATION\nTotal: $500";
    const result = resolveProvenance({ company: "Acme Corporation" }, markdown);

    expect(result.company).not.toBeNull();
    expect(result.company!.offset).toBe(markdown.indexOf("ACME CORPORATION"));
    expect(result.company!.length).toBe("ACME CORPORATION".length);
  });
});

// ---------------------------------------------------------------------------
// Dollar amount matching
// ---------------------------------------------------------------------------

describe("dollar amount matching", () => {
  it("matches $1,000,000 when extracted as 1000000", () => {
    const markdown = "Total amount due: $1,000,000\nPayable immediately.";
    const result = resolveProvenance({ total: 1000000 }, markdown);

    expect(result.total).not.toBeNull();
    expect(result.total!.chunk).toBe("$1,000,000");
  });

  it("matches $1,234.56 when extracted as number", () => {
    const markdown = "Subtotal: $1,234.56 USD";
    const result = resolveProvenance({ subtotal: 1234.56 }, markdown);

    expect(result.subtotal).not.toBeNull();
    expect(result.subtotal!.chunk).toBe("$1,234.56");
  });

  it("matches amount without $ prefix", () => {
    const markdown = "Balance: 5,000.00 remaining";
    const result = resolveProvenance({ balance: 5000 }, markdown);

    expect(result.balance).not.toBeNull();
    expect(result.balance!.chunk).toContain("5,000");
  });

  it("matches string dollar amounts", () => {
    const markdown = "Fee: $250.00 per month";
    const result = resolveProvenance({ fee: "$250.00" }, markdown);

    expect(result.fee).not.toBeNull();
    expect(result.fee!.chunk).toBe("$250.00");
  });
});

// ---------------------------------------------------------------------------
// Date format matching
// ---------------------------------------------------------------------------

describe("date format matching", () => {
  it("finds MM/DD/YYYY when extracted as YYYY-MM-DD", () => {
    const markdown = "Effective Date: 03/15/2024\nExpires: 03/15/2025";
    const result = resolveProvenance({ effective_date: "2024-03-15" }, markdown);

    expect(result.effective_date).not.toBeNull();
    expect(result.effective_date!.chunk).toBe("03/15/2024");
  });

  it("finds Month DD, YYYY format", () => {
    const markdown = "Signed on January 5, 2024 by the undersigned.";
    const result = resolveProvenance({ signed_date: "2024-01-05" }, markdown);

    expect(result.signed_date).not.toBeNull();
    expect(result.signed_date!.chunk).toBe("January 5, 2024");
  });

  it("finds abbreviated month format", () => {
    const markdown = "Due: Mar 15, 2024";
    const result = resolveProvenance({ due_date: "2024-03-15" }, markdown);

    expect(result.due_date).not.toBeNull();
    expect(result.due_date!.chunk).toBe("Mar 15, 2024");
  });

  it("finds YYYY-MM-DD as-is", () => {
    const markdown = "Date: 2024-03-15 | Reference: ABC";
    const result = resolveProvenance({ date: "2024-03-15" }, markdown);

    expect(result.date).not.toBeNull();
    expect(result.date!.chunk).toBe("2024-03-15");
  });
});

// ---------------------------------------------------------------------------
// Number matching
// ---------------------------------------------------------------------------

describe("number matching", () => {
  it("finds a plain integer in the markdown", () => {
    const markdown = "Pages: 42\nSize: large";
    const result = resolveProvenance({ pages: 42 }, markdown);

    expect(result.pages).not.toBeNull();
    expect(result.pages!.chunk).toBe("42");
  });

  it("finds a comma-formatted number", () => {
    const markdown = "Population: 1,234,567 people";
    const result = resolveProvenance({ population: 1234567 }, markdown);

    expect(result.population).not.toBeNull();
    expect(result.population!.chunk).toBe("1,234,567");
  });

  it("finds a decimal number", () => {
    const markdown = "Rate: 3.75% annual";
    const result = resolveProvenance({ rate: 3.75 }, markdown);

    expect(result.rate).not.toBeNull();
    expect(result.rate!.chunk).toBe("3.75");
  });
});

// ---------------------------------------------------------------------------
// Null for unfound values
// ---------------------------------------------------------------------------

describe("null for unfound values", () => {
  it("returns null when the value is not in the markdown", () => {
    const markdown = "This document has no relevant content.";
    const result = resolveProvenance({ missing_field: "XYZ-NOTFOUND-999" }, markdown);

    expect(result.missing_field).toBeNull();
  });

  it("returns null for null extracted values", () => {
    const markdown = "Some content here.";
    const result = resolveProvenance({ empty: null }, markdown);

    expect(result.empty).toBeNull();
  });

  it("returns null for boolean values (not searchable)", () => {
    const markdown = "Status: true\nEnabled: yes";
    const result = resolveProvenance({ status: true as unknown }, markdown);

    // Booleans are not strings or numbers, so provenance returns null
    expect(result.status).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Multi-field provenance
// ---------------------------------------------------------------------------

describe("multi-field provenance", () => {
  it("resolves provenance for multiple fields simultaneously", () => {
    const markdown = [
      "INVOICE",
      "Invoice Number: INV-2024-001",
      "Date: 03/15/2024",
      "Bill To: ACME Corp",
      "",
      "Total Due: $1,500.00",
      "Payment Terms: Net 30",
    ].join("\n");

    const extracted = {
      invoice_number: "INV-2024-001",
      date: "2024-03-15",
      company: "ACME Corp",
      total: 1500,
      terms: "Net 30",
      notes: null,
    };

    const result = resolveProvenance(extracted, markdown);

    // All present fields should be found
    expect(result.invoice_number).not.toBeNull();
    expect(result.invoice_number!.chunk).toBe("INV-2024-001");

    expect(result.date).not.toBeNull();
    expect(result.date!.chunk).toBe("03/15/2024");

    expect(result.company).not.toBeNull();
    expect(result.company!.chunk).toBe("ACME Corp");

    expect(result.total).not.toBeNull();
    expect(result.total!.chunk).toBe("$1,500.00");

    expect(result.terms).not.toBeNull();
    expect(result.terms!.chunk).toBe("Net 30");

    // Null field stays null
    expect(result.notes).toBeNull();

    // Offsets should be strictly increasing (fields appear in document order)
    const offsets = [
      result.invoice_number!.offset,
      result.date!.offset,
      result.company!.offset,
      result.total!.offset,
      result.terms!.offset,
    ];
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBeGreaterThan(offsets[i - 1]!);
    }
  });
});

// ---------------------------------------------------------------------------
// Word-level bounding box matching
// ---------------------------------------------------------------------------

describe("word-level bbox matching", () => {
  const textMap: TextMap = [
    { text: "Invoice", page: 1, bbox: { x: 0.1, y: 0.1, w: 0.1, h: 0.02 } },
    { text: "Number:", page: 1, bbox: { x: 0.2, y: 0.1, w: 0.1, h: 0.02 } },
    { text: "INV-2024-001", page: 1, bbox: { x: 0.3, y: 0.1, w: 0.15, h: 0.02 } },
    { text: "Total:", page: 1, bbox: { x: 0.1, y: 0.2, w: 0.08, h: 0.02 } },
    { text: "$1,500.00", page: 1, bbox: { x: 0.2, y: 0.2, w: 0.12, h: 0.02 } },
    { text: "ACME", page: 1, bbox: { x: 0.1, y: 0.3, w: 0.06, h: 0.02 } },
    { text: "CORPORATION", page: 1, bbox: { x: 0.17, y: 0.3, w: 0.15, h: 0.02 } },
  ];

  it("returns word-level boxes for a single-word match", () => {
    const markdown = "Invoice Number: INV-2024-001\nTotal: $1,500.00\nACME CORPORATION";
    const result = resolveProvenance({ invoice_number: "INV-2024-001" }, markdown, textMap);

    expect(result.invoice_number).not.toBeNull();
    expect(result.invoice_number!.words).toBeDefined();
    expect(result.invoice_number!.words!.length).toBe(1);
    expect(result.invoice_number!.words![0]!.text).toBe("INV-2024-001");
    expect(result.invoice_number!.words![0]!.page).toBe(1);
  });

  it("returns multiple word boxes for a multi-word match", () => {
    const markdown = "Invoice Number: INV-2024-001\nTotal: $1,500.00\nACME CORPORATION";
    const result = resolveProvenance({ company: "ACME CORPORATION" }, markdown, textMap);

    expect(result.company).not.toBeNull();
    expect(result.company!.words).toBeDefined();
    expect(result.company!.words!.length).toBe(2);
    expect(result.company!.words![0]!.text).toBe("ACME");
    expect(result.company!.words![1]!.text).toBe("CORPORATION");
  });

  it("returns page number from word boxes", () => {
    const markdown = "Invoice Number: INV-2024-001\nTotal: $1,500.00\nACME CORPORATION";
    const result = resolveProvenance({ company: "ACME CORPORATION" }, markdown, textMap);

    expect(result.company!.page).toBe(1);
  });

  it("returns enclosing bbox alongside word boxes", () => {
    const markdown = "Invoice Number: INV-2024-001\nTotal: $1,500.00\nACME CORPORATION";
    const result = resolveProvenance({ company: "ACME CORPORATION" }, markdown, textMap);

    expect(result.company!.bbox).toBeDefined();
    // Enclosing bbox should span from ACME's left edge to CORPORATION's right edge
    expect(result.company!.bbox!.x).toBe(0.1); // ACME's x
    expect(result.company!.bbox!.w).toBeCloseTo(0.22, 2); // span to end of CORPORATION
  });

  it("falls back to paragraph-level match when no word match found", () => {
    // Use a value that exists in markdown but not in word-level textMap
    const markdown = "Invoice Number: INV-2024-001\nNote: special-value-xyz";
    const result = resolveProvenance({ note: "special-value-xyz" }, markdown, textMap);

    // Should find in markdown but no word-level boxes (not in textMap)
    expect(result.note).not.toBeNull();
    expect(result.note!.chunk).toBe("special-value-xyz");
    expect(result.note!.words).toBeUndefined();
  });

  it("works without textMap (backward compat)", () => {
    const markdown = "Invoice Number: INV-2024-001";
    const result = resolveProvenance({ invoice_number: "INV-2024-001" }, markdown);

    expect(result.invoice_number).not.toBeNull();
    expect(result.invoice_number!.chunk).toBe("INV-2024-001");
    expect(result.invoice_number!.words).toBeUndefined();
    expect(result.invoice_number!.page).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dollar amount word matching with textMap
// ---------------------------------------------------------------------------

describe("dollar amount word matching", () => {
  const textMap: TextMap = [
    { text: "$1,500.00", page: 1, bbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.02 } },
  ];

  it("matches a number value to a dollar-formatted word in textMap", () => {
    const markdown = "Total: $1,500.00";
    const result = resolveProvenance({ total: 1500 }, markdown, textMap);

    expect(result.total).not.toBeNull();
    expect(result.total!.words).toBeDefined();
    expect(result.total!.words!.length).toBe(1);
    expect(result.total!.words![0]!.text).toBe("$1,500.00");
  });
});
