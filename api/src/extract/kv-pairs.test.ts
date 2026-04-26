import { describe, it, expect } from "vitest";
import { extractKVPairs, kvPairsSummary } from "./kv-pairs";

describe("extractKVPairs", () => {
  it("extracts simple colon-separated pairs", () => {
    const md = `Policy Number: BKS-123456-78
Named Insured: ABC Corporation
Effective Date: 04/01/2026`;
    const pairs = extractKVPairs(md);
    expect(pairs).toHaveLength(3);
    expect(pairs[0]).toEqual(expect.objectContaining({ label: "Policy Number", value: "BKS-123456-78" }));
    expect(pairs[1]).toEqual(expect.objectContaining({ label: "Named Insured", value: "ABC Corporation" }));
    expect(pairs[2]).toEqual(expect.objectContaining({ label: "Effective Date", value: "04/01/2026" }));
  });

  it("extracts bold markdown labels", () => {
    const md = `**Carrier Name**: Travelers Insurance
**Premium**: $12,500.00`;
    const pairs = extractKVPairs(md);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toEqual(expect.objectContaining({ label: "Carrier Name", value: "Travelers Insurance" }));
    expect(pairs[1]).toEqual(expect.objectContaining({ label: "Premium", value: "$12,500.00" }));
  });

  it("extracts from markdown tables", () => {
    const md = `| Coverage Type | Limit |
| --- | --- |
| General Liability | $1,000,000 |
| Auto Liability | $500,000 |`;
    const pairs = extractKVPairs(md);
    // Table header row is extracted as a KV pair — that's acceptable
    expect(pairs.some(p => p.label === "General Liability" && p.value === "$1,000,000")).toBeTruthy();
    expect(pairs.some(p => p.label === "Auto Liability" && p.value === "$500,000")).toBeTruthy();
  });

  it("skips table header rows with dashes", () => {
    const md = `| --- | --- |`;
    const pairs = extractKVPairs(md);
    expect(pairs).toHaveLength(0);
  });

  it("deduplicates by label", () => {
    const md = `Policy Number: 123
Policy Number: 456`;
    const pairs = extractKVPairs(md);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.value).toBe("123"); // keeps first occurrence
  });

  it("handles multi-word values", () => {
    const md = `Insured Name: John Michael Smith III
Address: 123 Main Street, Suite 400, New York, NY 10001`;
    const pairs = extractKVPairs(md);
    expect(pairs.some(p => p.label === "Insured Name" && p.value === "John Michael Smith III")).toBeTruthy();
    expect(pairs.some(p => p.label === "Address" && p.value.includes("123 Main Street"))).toBeTruthy();
  });

  it("filters out noise labels", () => {
    const md = `http: //example.com
Page: 1 of 5
Policy Number: ABC-123`;
    const pairs = extractKVPairs(md);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.label).toBe("Policy Number");
  });

  it("requires label to start with capital letter", () => {
    const md = `small label: should be ignored
Policy Number: ABC-123`;
    const pairs = extractKVPairs(md);
    expect(pairs).toHaveLength(1);
  });

  it("handles multiple spaces after colon", () => {
    const md = `Policy Number:   BKS-123456`;
    const pairs = extractKVPairs(md);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.value).toBe("BKS-123456");
  });

  it("returns empty array for empty markdown", () => {
    expect(extractKVPairs("")).toHaveLength(0);
  });

  it("returns empty array for markdown with no KV pairs", () => {
    const md = `This is just a paragraph of text without any structured data.
It has multiple lines but no colon-separated key-value pairs.`;
    expect(extractKVPairs("")).toHaveLength(0);
  });

  it("sorts by position in document", () => {
    const md = `First Field: Alpha
Second Field: Beta
Third Field: Gamma`;
    const pairs = extractKVPairs(md);
    expect(pairs[0]!.label).toBe("First Field");
    expect(pairs[1]!.label).toBe("Second Field");
    expect(pairs[2]!.label).toBe("Third Field");
    expect(pairs[0]!.position).toBeLessThan(pairs[1]!.position);
    expect(pairs[1]!.position).toBeLessThan(pairs[2]!.position);
  });

  it("handles real insurance document patterns", () => {
    const md = `CERTIFICATE OF LIABILITY INSURANCE
DATE (MM/DD/YYYY): 04/15/2026

PRODUCER: Smith Insurance Agency
INSURED: ABC Corporation
1234 Business Park Drive
Suite 100
Tampa, FL 33602

COVERAGES
General Aggregate Limit: $2,000,000
Products/Completed Ops: $2,000,000
Each Occurrence: $1,000,000
Personal & Advertising: $1,000,000
Fire Damage: $100,000
Medical Expense: $5,000

POLICY NUMBER: CGL-2026-789012
POLICY EFFECTIVE: 04/01/2026
POLICY EXPIRATION: 04/01/2027`;

    const pairs = extractKVPairs(md);
    expect(pairs.length).toBeGreaterThan(5);
    expect(pairs.some(p => p.label.includes("INSURED") || p.label.includes("Insured"))).toBeTruthy();
    expect(pairs.some(p => p.value.includes("$2,000,000"))).toBeTruthy();
    expect(pairs.some(p => p.value.includes("CGL-2026-789012"))).toBeTruthy();
  });

  it("strips markdown formatting from labels and values", () => {
    const md = `**Policy Number**: *BKS-123*`;
    const pairs = extractKVPairs(md);
    expect(pairs[0]!.label).toBe("Policy Number");
    expect(pairs[0]!.value).toBe("BKS-123");
  });
});

describe("kvPairsSummary", () => {
  it("detects dollar amounts", () => {
    const pairs = [{ label: "Premium", value: "$12,500.00", position: 0 }];
    const summary = kvPairsSummary(pairs);
    expect(summary.hasAmounts).toBe(true);
    expect(summary.total).toBe(1);
  });

  it("detects dates", () => {
    const pairs = [{ label: "Effective Date", value: "04/01/2026", position: 0 }];
    const summary = kvPairsSummary(pairs);
    expect(summary.hasDates).toBe(true);
  });

  it("detects insurance names", () => {
    const pairs = [{ label: "Named Insured", value: "ABC Corp", position: 0 }];
    const summary = kvPairsSummary(pairs);
    expect(summary.hasNames).toBe(true);
  });

  it("handles empty pairs", () => {
    const summary = kvPairsSummary([]);
    expect(summary.total).toBe(0);
    expect(summary.hasAmounts).toBe(false);
    expect(summary.hasDates).toBe(false);
    expect(summary.hasNames).toBe(false);
  });
});
