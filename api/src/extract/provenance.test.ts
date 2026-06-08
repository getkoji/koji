import { describe, it, expect } from "vitest";
import { resolveProvenance, estimatePageFromOffset, type TextMap } from "./provenance";

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

  it("resolves boolean values via common representations", () => {
    const markdown = "Status: true\nEnabled: yes";
    const result = resolveProvenance({ status: true as unknown }, markdown);

    // Booleans now resolve via common representations (Yes, true, ✓, etc.)
    expect(result.status).not.toBeNull();
    expect(result.status!.chunk).toBe("yes");
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
    expect(result.invoice_number!.page).toBe(1);
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

// ---------------------------------------------------------------------------
// Page estimation from markdown offset
// ---------------------------------------------------------------------------

describe("estimatePageFromOffset", () => {
  it("returns page 1 when no separators exist", () => {
    expect(estimatePageFromOffset("hello world", 5)).toBe(1);
  });

  it("returns page 1 for offset before first separator", () => {
    const md = "page one\n\n---\n\npage two";
    expect(estimatePageFromOffset(md, 3)).toBe(1);
  });

  it("returns page 2 for offset after first separator", () => {
    const md = "page one\n\n---\n\npage two";
    expect(estimatePageFromOffset(md, md.indexOf("page two"))).toBe(2);
  });

  it("returns page 3 for offset after second separator", () => {
    const md = "page one\n\n---\n\npage two\n\n---\n\npage three content";
    expect(estimatePageFromOffset(md, md.indexOf("page three"))).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Array provenance — per-item resolution
// ---------------------------------------------------------------------------

describe("array of strings", () => {
  it("resolves provenance for each string item in an array", () => {
    const markdown = "Board Members:\n- John Smith\n- Jane Doe\n- Bob Johnson";
    const result = resolveProvenance(
      { board_members: ["John Smith", "Jane Doe", "Bob Johnson"] },
      markdown,
    );
    expect(result.board_members).not.toBeNull();
    expect(result.board_members!.items).toBeDefined();
    expect(result.board_members!.items!.length).toBe(3);
    expect(result.board_members!.items![0]!.chunk).toBe("John Smith");
    expect(result.board_members!.items![1]!.chunk).toBe("Jane Doe");
    expect(result.board_members!.items![2]!.chunk).toBe("Bob Johnson");
  });

  it("parent span uses first item's provenance", () => {
    const markdown = "Names: Alice, Bob, Charlie";
    const result = resolveProvenance({ names: ["Alice", "Bob"] }, markdown);
    expect(result.names).not.toBeNull();
    expect(result.names!.chunk).toBe("Alice");
    expect(result.names!.offset).toBe(markdown.indexOf("Alice"));
  });

  it("skips items that cannot be found", () => {
    const markdown = "Present: Alice and Bob";
    const result = resolveProvenance(
      { attendees: ["Alice", "NOT_IN_DOCUMENT", "Bob"] },
      markdown,
    );
    expect(result.attendees).not.toBeNull();
    expect(result.attendees!.items!.length).toBe(2);
    expect(result.attendees!.items![0]!.chunk).toBe("Alice");
    expect(result.attendees!.items![1]!.chunk).toBe("Bob");
  });

  it("returns null for empty arrays", () => {
    const result = resolveProvenance({ tags: [] }, "Some content");
    expect(result.tags).toBeNull();
  });

  it("returns null when no items can be found", () => {
    const result = resolveProvenance(
      { names: ["AAAA_NOTFOUND", "BBBB_NOTFOUND"] },
      "Unrelated document content",
    );
    expect(result.names).toBeNull();
  });
});

describe("array of objects — page-level provenance", () => {
  it("resolves to the page containing the most property values", () => {
    const markdown = [
      "Page one: CG 20 10 — Additional Insured",
      "\n\n---\n\n",
      "Page two: CG 20 37 — Products Completed Operations",
    ].join("");

    const result = resolveProvenance(
      {
        endorsements: [
          { form_number: "CG 20 10", title: "Additional Insured" },
          { form_number: "CG 20 37", title: "Products Completed Operations" },
        ],
      },
      markdown,
    );
    expect(result.endorsements).not.toBeNull();
    expect(result.endorsements!.items).toBeDefined();
    expect(result.endorsements!.items!.length).toBe(2);
    expect(result.endorsements!.items![0]!.page).toBe(1);
    expect(result.endorsements!.items![1]!.page).toBe(2);
  });

  it("returns page only, no bbox or words", () => {
    const markdown = "CG 20 10 — Additional Insured";
    const result = resolveProvenance(
      { endorsements: [{ form_number: "CG 20 10", title: "Additional Insured" }] },
      markdown,
    );
    expect(result.endorsements).not.toBeNull();
    const item = result.endorsements!.items![0]!;
    expect(item.page).toBe(1);
    expect(item.bbox).toBeUndefined();
    expect(item.words).toBeUndefined();
  });

  it("skips null and short properties when scoring pages", () => {
    const markdown = "Name: John Smith, Role: Director";
    const result = resolveProvenance(
      { members: [{ name: "John Smith", phone: null, id: "A" }] },
      markdown,
    );
    expect(result.members).not.toBeNull();
    expect(result.members!.items!.length).toBe(1);
    expect(result.members!.items![0]!.page).toBe(1);
  });

  it("maps coverages to correct pages, not unrelated content", () => {
    const markdown = [
      "Building: 001, Protection Class: 1",
      "\n\n---\n\n",
      "Coverage A — Dwelling, premium 196, deductible 1000",
      "\n\n---\n\n",
      "Coverage B — Liability, premium 350, deductible 500",
    ].join("");

    const result = resolveProvenance(
      {
        coverages: [
          { name: "Coverage A — Dwelling", premium: 196, deductible: 1000 },
          { name: "Coverage B — Liability", premium: 350, deductible: 500 },
        ],
      },
      markdown,
    );
    expect(result.coverages).not.toBeNull();
    expect(result.coverages!.items!.length).toBe(2);
    // Coverage A on page 2 (after building info on page 1)
    expect(result.coverages!.items![0]!.page).toBe(2);
    // Coverage B on page 3
    expect(result.coverages!.items![1]!.page).toBe(3);
  });

  it("returns null when no properties match any page", () => {
    const markdown = "Unrelated document content";
    const result = resolveProvenance(
      { items: [{ name: "NOTFOUND_ITEM", code: "XX" }] },
      markdown,
    );
    // "XX" is too short, "NOTFOUND_ITEM" doesn't appear → null
    expect(result.items).toBeNull();
  });
});

describe("array of numbers", () => {
  it("resolves provenance for numeric array items", () => {
    const markdown = "Unit numbers: 100, 200, 305";
    const result = resolveProvenance({ units: [100, 200, 305] }, markdown);
    expect(result.units).not.toBeNull();
    expect(result.units!.items!.length).toBe(3);
    expect(result.units!.items![0]!.chunk).toBe("100");
    expect(result.units!.items![1]!.chunk).toBe("200");
    expect(result.units!.items![2]!.chunk).toBe("305");
  });
});

describe("mixed scalar and array fields", () => {
  it("resolves both scalar and array fields in the same call", () => {
    const markdown = "Policy: POL-001\nInsured: Acme\nAdditional:\n- Widget Inc\n- Gadget LLC";
    const result = resolveProvenance(
      {
        policy_number: "POL-001",
        insured: "Acme",
        additional_insureds: ["Widget Inc", "Gadget LLC"],
      },
      markdown,
    );
    expect(result.policy_number).not.toBeNull();
    expect(result.policy_number!.chunk).toBe("POL-001");
    expect(result.policy_number!.items).toBeUndefined();
    expect(result.additional_insureds).not.toBeNull();
    expect(result.additional_insureds!.items!.length).toBe(2);
    expect(result.additional_insureds!.items![0]!.chunk).toBe("Widget Inc");
    expect(result.additional_insureds!.items![1]!.chunk).toBe("Gadget LLC");
  });
});

describe("array with textMap bounding boxes", () => {
  const textMap: TextMap = [
    { text: "Widget", page: 1, bbox: { x: 0.1, y: 0.3, w: 0.08, h: 0.02 } },
    { text: "Inc", page: 1, bbox: { x: 0.19, y: 0.3, w: 0.04, h: 0.02 } },
    { text: "Gadget", page: 1, bbox: { x: 0.1, y: 0.35, w: 0.08, h: 0.02 } },
    { text: "LLC", page: 1, bbox: { x: 0.19, y: 0.35, w: 0.04, h: 0.02 } },
  ];

  it("resolves per-item bounding boxes for array items", () => {
    const markdown = "Additional Insureds:\n- Widget Inc\n- Gadget LLC";
    const result = resolveProvenance(
      { additional_insureds: ["Widget Inc", "Gadget LLC"] },
      markdown,
      textMap,
    );
    expect(result.additional_insureds).not.toBeNull();
    const items = result.additional_insureds!.items!;
    expect(items.length).toBe(2);
    expect(items[0]!.words).toBeDefined();
    expect(items[0]!.words!.length).toBe(2);
    expect(items[0]!.page).toBe(1);
    expect(items[1]!.words).toBeDefined();
    expect(items[1]!.words!.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Duplicate text across pages — bbox should match the correct page
// ---------------------------------------------------------------------------

describe("duplicate text across pages", () => {
  // Simulate a document where "December 4, 2025" appears on page 1 (declarations)
  // and page 3 (endorsements). The text_map has entries for both occurrences.
  const textMap: TextMap = [
    { text: "Declarations", page: 1, bbox: { x: 0.1, y: 0.05, w: 0.2, h: 0.02 } },
    { text: "December", page: 1, bbox: { x: 0.3, y: 0.1, w: 0.1, h: 0.02 } },
    { text: "4,", page: 1, bbox: { x: 0.41, y: 0.1, w: 0.03, h: 0.02 } },
    { text: "2025", page: 1, bbox: { x: 0.45, y: 0.1, w: 0.05, h: 0.02 } },
    { text: "Endorsements", page: 3, bbox: { x: 0.1, y: 0.05, w: 0.2, h: 0.02 } },
    { text: "December", page: 3, bbox: { x: 0.3, y: 0.2, w: 0.1, h: 0.02 } },
    { text: "4,", page: 3, bbox: { x: 0.41, y: 0.2, w: 0.03, h: 0.02 } },
    { text: "2025", page: 3, bbox: { x: 0.45, y: 0.2, w: 0.05, h: 0.02 } },
  ];

  // Markdown with page separators: page 1, page 2, page 3
  const markdown = [
    "Declarations\nEffective: December 4, 2025",
    "Some other page content",
    "Endorsements\nDate: December 4, 2025",
  ].join("\n\n---\n\n");

  it("resolves bbox to page 1 when markdown offset points to page 1", () => {
    // The LLM extracts the date and the text search finds it on page 1 first
    const result = resolveProvenance(
      { effective_date: "December 4, 2025" },
      markdown,
      textMap,
    );

    expect(result.effective_date).not.toBeNull();
    // The first occurrence in markdown is on page 1
    expect(result.effective_date!.offset).toBe(markdown.indexOf("December 4, 2025"));
    expect(result.effective_date!.page).toBe(1);
    expect(result.effective_date!.words).toBeDefined();
    expect(result.effective_date!.words![0]!.page).toBe(1);
  });

  it("resolves bbox to page 3 when a second field matches the page-3 occurrence", () => {
    // Build a markdown where the page-3 occurrence is found by the text search.
    // We need the extracted value to match the second occurrence.
    // Use a field that only appears on page 3 to force the offset there.
    const page3Markdown = [
      "Declarations\nEffective: January 1, 2025",
      "Some other page content",
      "Endorsements\nDate: December 4, 2025",
    ].join("\n\n---\n\n");

    const result = resolveProvenance(
      { endorsement_date: "December 4, 2025" },
      page3Markdown,
      textMap,
    );

    expect(result.endorsement_date).not.toBeNull();
    // The only occurrence in this markdown is on page 3
    expect(result.endorsement_date!.page).toBe(3);
    expect(result.endorsement_date!.words).toBeDefined();
    expect(result.endorsement_date!.words![0]!.page).toBe(3);
  });

  it("prefers page-2 text_map match when markdown offset is on page 2", () => {
    // Text map has "$500" on pages 1 and 2
    const amountTextMap: TextMap = [
      { text: "$500", page: 1, bbox: { x: 0.1, y: 0.1, w: 0.05, h: 0.02 } },
      { text: "$500", page: 2, bbox: { x: 0.3, y: 0.3, w: 0.05, h: 0.02 } },
    ];
    const md = "Page one: $500\n\n---\n\nPage two: $500";
    // findExact returns the first occurrence (page 1), but we also test
    // that the second field would get page 2 if only that occurrence existed.
    const result = resolveProvenance({ amount: "$500" }, md, amountTextMap);

    // findExact finds the first "$500" in the markdown (page 1 offset)
    expect(result.amount).not.toBeNull();
    expect(result.amount!.page).toBe(1);

    // Now test with markdown where "$500" only appears on page 2
    const md2 = "Page one: some text\n\n---\n\nPage two: $500";
    const result2 = resolveProvenance({ amount: "$500" }, md2, amountTextMap);
    expect(result2.amount).not.toBeNull();
    expect(result2.amount!.page).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Array provenance with source texts
// ---------------------------------------------------------------------------

describe("array provenance with source texts", () => {
  it("uses source texts for precise array item matching", () => {
    const markdown =
      "Page 1: Widget 2 pcs $10.00\n\n---\n\nPage 2: Gadget 5 pcs $25.00";
    const sourceTexts = {
      items: ["Widget 2 pcs $10.00", "Gadget 5 pcs $25.00"],
    };

    const result = resolveProvenance(
      { items: [{ desc: "Widget", qty: 2 }, { desc: "Gadget", qty: 5 }] },
      markdown,
      undefined,
      sourceTexts,
    );

    expect(result.items).not.toBeNull();
    expect(result.items!.items).toHaveLength(2);
    // First item should have a precise offset matching the source text
    expect(result.items!.items![0]!.chunk).toBe("Widget 2 pcs $10.00");
    expect(result.items!.items![0]!.page).toBe(1);
    // Second item on page 2
    expect(result.items!.items![1]!.chunk).toBe("Gadget 5 pcs $25.00");
    expect(result.items!.items![1]!.page).toBe(2);
  });

  it("falls back to heuristic when source text not found", () => {
    const markdown = "Page 1: Widget info here";
    const sourceTexts = {
      items: ["text that does not appear anywhere"],
    };

    const result = resolveProvenance(
      { items: [{ desc: "Widget" }] },
      markdown,
      undefined,
      sourceTexts,
    );

    // Should still resolve via heuristic fallback
    expect(result.items).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Numeric boundary matching — $1,000 must not match inside $1,000,000
// ---------------------------------------------------------------------------

describe("numeric boundary matching", () => {
  it("$1,000 does not match inside $1,000,000", () => {
    const markdown = "Limit: $1,000,000\nRetention: $1,000 each claim";
    const result = resolveProvenance({ deductible: 1000 }, markdown);

    expect(result.deductible).not.toBeNull();
    expect(result.deductible!.chunk).toBe("$1,000");
    // Should match the standalone $1,000, not the one inside $1,000,000
    expect(result.deductible!.offset).toBe(markdown.indexOf("$1,000 each") );
  });

  it("$1,000 as string does not match inside $1,000,000", () => {
    const markdown = "Limit: $1,000,000\nRetention: $1,000 each claim";
    const result = resolveProvenance({ deductible: "$1,000" }, markdown);

    expect(result.deductible).not.toBeNull();
    expect(result.deductible!.chunk).toBe("$1,000");
    expect(result.deductible!.offset).toBe(markdown.indexOf("$1,000 each"));
  });

  it("$1,500 does not match inside $1,500.00", () => {
    const markdown = "Total: $1,500.00\nDeposit: $1,500 paid";
    // When extracted as number 1500, should find $1,500.00 first (with .00)
    const result = resolveProvenance({ total: 1500 }, markdown);
    expect(result.total).not.toBeNull();
    expect(result.total!.chunk).toBe("$1,500.00");
  });

  it("per-property provenance uses bounded matching within source text", () => {
    const markdown = "Coverage:\nLimit: $1,000,000\nRetention: $1,000 each claim";
    const sourceTexts = {
      coverages: ["Limit: $1,000,000\nRetention: $1,000 each claim"],
    };

    const result = resolveProvenance(
      { coverages: [{ limit: 1000000, deductible: 1000 }] },
      markdown,
      undefined,
      sourceTexts,
    );

    expect(result.coverages).not.toBeNull();
    const item = result.coverages!.items![0]!;
    expect(item.properties).toBeDefined();
    expect(item.properties!.limit).not.toBeNull();
    expect(item.properties!.limit!.chunk).toBe("$1,000,000");
    expect(item.properties!.deductible).not.toBeNull();
    expect(item.properties!.deductible!.chunk).toBe("$1,000");
  });
});

// ---------------------------------------------------------------------------
// Date bbox matching — ISO dates must not false-match components
// ---------------------------------------------------------------------------

describe("date bbox word matching", () => {
  it("2025-12-04 does not bbox-match random '2025' or '04' words", () => {
    const markdown = "Effective Date: December 4, 2025\nExpiration Date: December 4, 2026";
    // Build a text_map with individual words
    const textMap: TextMap = [
      { text: "Effective", page: 1, bbox: { x: 0.1, y: 0.1, w: 0.1, h: 0.02 } },
      { text: "Date:", page: 1, bbox: { x: 0.2, y: 0.1, w: 0.05, h: 0.02 } },
      { text: "December", page: 1, bbox: { x: 0.3, y: 0.1, w: 0.1, h: 0.02 } },
      { text: "4,", page: 1, bbox: { x: 0.4, y: 0.1, w: 0.02, h: 0.02 } },
      { text: "2025", page: 1, bbox: { x: 0.42, y: 0.1, w: 0.05, h: 0.02 } },
      { text: "Expiration", page: 1, bbox: { x: 0.1, y: 0.2, w: 0.1, h: 0.02 } },
      { text: "Date:", page: 1, bbox: { x: 0.2, y: 0.2, w: 0.05, h: 0.02 } },
      { text: "December", page: 1, bbox: { x: 0.3, y: 0.2, w: 0.1, h: 0.02 } },
      { text: "4,", page: 1, bbox: { x: 0.4, y: 0.2, w: 0.02, h: 0.02 } },
      { text: "2026", page: 1, bbox: { x: 0.42, y: 0.2, w: 0.05, h: 0.02 } },
    ];

    const result = resolveProvenance(
      { effective_date: "2025-12-04", expiration_date: "2026-12-04" },
      markdown,
      textMap,
    );

    // Both should resolve to the correct date line
    expect(result.effective_date).not.toBeNull();
    expect(result.effective_date!.words).toBeDefined();
    expect(result.effective_date!.words!.length).toBe(3); // December, 4, 2025
    expect(result.effective_date!.words![2]!.text).toBe("2025");

    expect(result.expiration_date).not.toBeNull();
    expect(result.expiration_date!.words).toBeDefined();
    expect(result.expiration_date!.words![2]!.text).toBe("2026");
  });
});

// ---------------------------------------------------------------------------
// HTML entity matching — & vs &amp;
// ---------------------------------------------------------------------------

describe("HTML entity matching", () => {
  it("finds value with & when markdown has &amp;", () => {
    const markdown = "Coverage: Condominium &amp; Homeowners D&amp;O Liability Insurance";
    const result = resolveProvenance(
      { coverage: "Condominium & Homeowners D&O Liability Insurance" },
      markdown,
    );

    expect(result.coverage).not.toBeNull();
    expect(result.coverage!.chunk).toContain("Condominium");
    expect(result.coverage!.chunk).toContain("Liability Insurance");
  });

  it("finds value with &amp; when markdown has &", () => {
    const markdown = "Coverage: Condominium & Homeowners D&O Liability Insurance";
    const result = resolveProvenance(
      { coverage: "Condominium &amp; Homeowners D&amp;O Liability Insurance" },
      markdown,
    );

    expect(result.coverage).not.toBeNull();
    expect(result.coverage!.chunk).toContain("Condominium");
  });
});

// ---------------------------------------------------------------------------
// Enum/mapping alias provenance
// ---------------------------------------------------------------------------

describe("enum/mapping alias provenance", () => {
  it("finds provenance via mapping aliases when canonical value not in document", () => {
    const markdown = "Coverage: D&O Liability Insurance\nLimit: $1,000,000";
    const fieldSpecs = {
      policy_type: {
        type: "mapping",
        mappings: {
          directors_and_officers: ["D&O", "Directors and Officers", "Directors & Officers"],
          general_liability: ["GL", "General Liability", "CGL"],
        },
      },
    };

    const result = resolveProvenance(
      { policy_type: "directors_and_officers" },
      markdown,
      undefined,
      undefined,
      fieldSpecs,
    );

    expect(result.policy_type).not.toBeNull();
    expect(result.policy_type!.chunk).toBe("D&O");
  });

  it("uses canonical value with spaces when no aliases match", () => {
    const markdown = "Type: directors and officers\nLimit: $1,000,000";
    const fieldSpecs = {
      policy_type: {
        type: "mapping",
        mappings: {
          directors_and_officers: [],
        },
      },
    };

    const result = resolveProvenance(
      { policy_type: "directors_and_officers" },
      markdown,
      undefined,
      undefined,
      fieldSpecs,
    );

    expect(result.policy_type).not.toBeNull();
    expect(result.policy_type!.chunk).toBe("directors and officers");
  });

  it("returns null when neither canonical nor aliases found", () => {
    const markdown = "Some unrelated content about widgets";
    const fieldSpecs = {
      policy_type: {
        type: "mapping",
        mappings: {
          directors_and_officers: ["D&O"],
        },
      },
    };

    const result = resolveProvenance(
      { policy_type: "directors_and_officers" },
      markdown,
      undefined,
      undefined,
      fieldSpecs,
    );

    expect(result.policy_type).toBeNull();
  });

  it("prefers direct match over alias when canonical value exists in document", () => {
    const markdown = "Policy Type: directors_and_officers\nCoverage: D&O";
    const fieldSpecs = {
      policy_type: {
        type: "mapping",
        mappings: {
          directors_and_officers: ["D&O"],
        },
      },
    };

    const result = resolveProvenance(
      { policy_type: "directors_and_officers" },
      markdown,
      undefined,
      undefined,
      fieldSpecs,
    );

    expect(result.policy_type).not.toBeNull();
    // Direct match should win
    expect(result.policy_type!.chunk).toBe("directors_and_officers");
  });
});

// ---------------------------------------------------------------------------
// Boolean provenance
// ---------------------------------------------------------------------------

describe("boolean provenance", () => {
  it("finds 'Yes' for true value", () => {
    const markdown = "Name: John\nActive: Yes\nTotal: $500";
    const result = resolveProvenance({ active: true }, markdown);

    expect(result.active).not.toBeNull();
    expect(result.active!.chunk).toBe("Yes");
  });

  it("finds 'No' for false value", () => {
    const markdown = "Name: John\nInsured: No\nTotal: $500";
    const result = resolveProvenance({ insured: false }, markdown);

    expect(result.insured).not.toBeNull();
    expect(result.insured!.chunk).toBe("No");
  });

  it("finds checkmark for true value", () => {
    const markdown = "Coverage A: ✓\nCoverage B: ☐";
    const result = resolveProvenance({ coverage_a: true }, markdown);

    expect(result.coverage_a).not.toBeNull();
    expect(result.coverage_a!.chunk).toBe("✓");
  });

  it("finds unchecked box for false value", () => {
    const markdown = "Coverage A: ✓\nCoverage B: ☐";
    const result = resolveProvenance({ coverage_b: false }, markdown);

    expect(result.coverage_b).not.toBeNull();
    expect(result.coverage_b!.chunk).toBe("☐");
  });

  it("finds X for true value using word boundary", () => {
    const markdown = "Extra coverage: X\nExcluded items: None";
    const result = resolveProvenance({ extra_coverage: true }, markdown);

    expect(result.extra_coverage).not.toBeNull();
    expect(result.extra_coverage!.chunk).toBe("X");
  });

  it("returns null when no boolean representation found", () => {
    const markdown = "Some content with no boolean indicators";
    const result = resolveProvenance({ flag: true }, markdown);

    expect(result.flag).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Additional date format variants
// ---------------------------------------------------------------------------

describe("date format variants", () => {
  it("finds hyphen 2-digit year: 12-04-17", () => {
    const markdown = "Date: 12-04-17\nOther content";
    const result = resolveProvenance({ date: "2017-12-04" }, markdown);

    expect(result.date).not.toBeNull();
    expect(result.date!.chunk).toBe("12-04-17");
  });

  it("finds dot-separated date: 12.04.2017", () => {
    const markdown = "Datum: 12.04.2017\nSomething else";
    const result = resolveProvenance({ date: "2017-12-04" }, markdown);

    expect(result.date).not.toBeNull();
    expect(result.date!.chunk).toBe("12.04.2017");
  });

  it("finds month-no-comma: December 4 2017", () => {
    const markdown = "Signed December 4 2017 by the parties";
    const result = resolveProvenance({ date: "2017-12-04" }, markdown);

    expect(result.date).not.toBeNull();
    expect(result.date!.chunk).toBe("December 4 2017");
  });

  it("finds DD Mon YYYY: 4 Dec 2017", () => {
    const markdown = "Date: 4 Dec 2017\nRef: ABC";
    const result = resolveProvenance({ date: "2017-12-04" }, markdown);

    expect(result.date).not.toBeNull();
    expect(result.date!.chunk).toBe("4 Dec 2017");
  });

  it("finds DD/MM/YY: 04/12/17", () => {
    const markdown = "Date: 04/12/17\nSomething";
    const result = resolveProvenance({ date: "2017-12-04" }, markdown);

    expect(result.date).not.toBeNull();
    expect(result.date!.chunk).toBe("04/12/17");
  });

  it("finds YYYY/MM/DD: 2017/12/04", () => {
    const markdown = "Date: 2017/12/04\nContent";
    const result = resolveProvenance({ date: "2017-12-04" }, markdown);

    expect(result.date).not.toBeNull();
    expect(result.date!.chunk).toBe("2017/12/04");
  });
});

// ---------------------------------------------------------------------------
// Scalar __source_text provenance
// ---------------------------------------------------------------------------

describe("scalar __source_text provenance", () => {
  it("uses scalar source text for provenance matching", () => {
    const markdown = "Effective: 12-04-17\nExpires: 12-04-18";
    // The LLM returns normalized ISO date, but also provides source text
    const result = resolveProvenance(
      { effective_date: "2017-12-04" },
      markdown,
      undefined,
      undefined,
      undefined,
      { effective_date: "12-04-17" },
    );

    expect(result.effective_date).not.toBeNull();
    expect(result.effective_date!.chunk).toBe("12-04-17");
    expect(result.effective_date!.offset).toBe(markdown.indexOf("12-04-17"));
  });

  it("__source_context constrains search region", () => {
    // "500" appears twice; context narrows to the right occurrence
    const markdown = "Limit: 500\nDeductible: 500 per claim";
    const result = resolveProvenance(
      { deductible: "500" },
      markdown,
      undefined,
      undefined,
      undefined,
      { deductible: "500" },
      { deductible: "Deductible: 500 per claim" },
    );

    expect(result.deductible).not.toBeNull();
    // Should match the second "500" (inside the context region)
    expect(result.deductible!.offset).toBe(markdown.indexOf("Deductible: 500 per claim") + "Deductible: ".length);
  });

  it("falls back to format-variant matching when source text not found", () => {
    const markdown = "Effective Date: 03/15/2024";
    const result = resolveProvenance(
      { effective_date: "2024-03-15" },
      markdown,
      undefined,
      undefined,
      undefined,
      { effective_date: "March 15, 2024" }, // source text not in markdown
    );

    expect(result.effective_date).not.toBeNull();
    // Falls back to date format matching
    expect(result.effective_date!.chunk).toBe("03/15/2024");
  });
});
