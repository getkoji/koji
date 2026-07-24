import { describe, it, expect } from "vitest";
import { computeClassifierResult, type ClassifyDocResult } from "./classify-scoring";

const doc = (p: Partial<ClassifyDocResult>): ClassifyDocResult => ({
  corpusEntryId: "e",
  status: "ok",
  expectedLabel: "invoice",
  predictedLabel: "invoice",
  tierUsed: 2,
  ...p,
});

describe("computeClassifierResult", () => {
  it("counts a correct prediction as accurate", () => {
    const r = computeClassifierResult([doc({ predictedLabel: "invoice", expectedLabel: "invoice" })]);
    expect(r).toMatchObject({ docsTotal: 1, docsCorrect: 1, docsFailed: 0, accuracy: 100 });
  });

  it("counts a wrong prediction against accuracy", () => {
    const r = computeClassifierResult([
      doc({ predictedLabel: "invoice", expectedLabel: "invoice" }),
      doc({ predictedLabel: "receipt", expectedLabel: "invoice" }),
    ]);
    expect(r.docsTotal).toBe(2);
    expect(r.docsCorrect).toBe(1);
    expect(r.accuracy).toBe(50);
  });

  it("treats unknown==unknown as correct (a document that should fall through)", () => {
    const r = computeClassifierResult([doc({ predictedLabel: "unknown", expectedLabel: "unknown" })]);
    expect(r.docsCorrect).toBe(1);
    expect(r.accuracy).toBe(100);
  });

  it("excludes failed docs from the accuracy denominator", () => {
    // 1 correct, 1 failed (provider out). Accuracy is 1/1 = 100%, not 1/2.
    const r = computeClassifierResult([
      doc({ predictedLabel: "invoice", expectedLabel: "invoice" }),
      doc({ status: "failed", predictedLabel: null, errorMessage: "provider out" }),
    ]);
    expect(r.docsTotal).toBe(2);
    expect(r.docsFailed).toBe(1);
    expect(r.docsCorrect).toBe(1);
    expect(r.accuracy).toBe(100);
  });

  it("returns null accuracy when nothing scored", () => {
    const r = computeClassifierResult([doc({ status: "failed", predictedLabel: null })]);
    expect(r.accuracy).toBeNull();
    expect(r.docsFailed).toBe(1);
  });

  it("excludes an unlabeled entry from scoring entirely (not a wrong answer)", () => {
    // expected null = no ground truth. It cannot be scored, so it leaves the
    // denominator rather than counting as a miss.
    const r = computeClassifierResult([doc({ expectedLabel: null, predictedLabel: "invoice" })]);
    expect(r.docsCorrect).toBe(0);
    expect(r.accuracy).toBeNull();
  });
});

describe("computeClassifierResult — per-class metrics", () => {
  it("computes tp/fp/fn/precision/recall/F1 per class", () => {
    // invoice: 2 correct, 1 missed (predicted receipt). receipt: predicted once
    // wrongly (that missed invoice), never actually a receipt.
    const r = computeClassifierResult([
      doc({ corpusEntryId: "1", expectedLabel: "invoice", predictedLabel: "invoice" }),
      doc({ corpusEntryId: "2", expectedLabel: "invoice", predictedLabel: "invoice" }),
      doc({ corpusEntryId: "3", expectedLabel: "invoice", predictedLabel: "receipt" }),
    ]);
    const invoice = r.byClass.find((c) => c.label === "invoice")!;
    expect(invoice).toMatchObject({ support: 3, predicted: 2, tp: 2, fp: 0, fn: 1 });
    expect(invoice.precision).toBe(1); // 2/(2+0)
    expect(invoice.recall).toBeCloseTo(2 / 3); // 2/(2+1)

    const receipt = r.byClass.find((c) => c.label === "receipt")!;
    expect(receipt).toMatchObject({ support: 0, predicted: 1, tp: 0, fp: 1, fn: 0 });
    expect(receipt.precision).toBe(0); // 0/(0+1)
    expect(receipt.recall).toBeNull(); // no support
  });

  it("sorts classes by support descending", () => {
    const r = computeClassifierResult([
      doc({ corpusEntryId: "1", expectedLabel: "rare", predictedLabel: "rare" }),
      doc({ corpusEntryId: "2", expectedLabel: "common", predictedLabel: "common" }),
      doc({ corpusEntryId: "3", expectedLabel: "common", predictedLabel: "common" }),
    ]);
    expect(r.byClass[0]?.label).toBe("common");
  });
});

describe("computeClassifierResult — confusion matrix", () => {
  it("names which class each miss was confused with", () => {
    // The actionable output: 2 invoices were called receipts → tighten receipt.
    const r = computeClassifierResult([
      doc({ corpusEntryId: "1", expectedLabel: "invoice", predictedLabel: "receipt" }),
      doc({ corpusEntryId: "2", expectedLabel: "invoice", predictedLabel: "receipt" }),
      doc({ corpusEntryId: "3", expectedLabel: "invoice", predictedLabel: "invoice" }),
    ]);
    const miss = r.confusion.find((c) => c.expected === "invoice" && c.predicted === "receipt");
    expect(miss?.count).toBe(2);
    const hit = r.confusion.find((c) => c.expected === "invoice" && c.predicted === "invoice");
    expect(hit?.count).toBe(1);
  });

  it("buckets a null prediction as 'unknown' in the matrix", () => {
    const r = computeClassifierResult([doc({ expectedLabel: "invoice", predictedLabel: null })]);
    expect(r.confusion[0]).toMatchObject({ expected: "invoice", predicted: "unknown", count: 1 });
  });
});

describe("computeClassifierResult — tier histogram + escalation", () => {
  it("counts docs per tier and the share that needed tier >= 3", () => {
    const r = computeClassifierResult([
      doc({ corpusEntryId: "1", tierUsed: 2 }), // keyword — free
      doc({ corpusEntryId: "2", tierUsed: 2 }),
      doc({ corpusEntryId: "3", tierUsed: 3 }), // llm — paid
      doc({ corpusEntryId: "4", tierUsed: 4 }), // vision — paid
    ]);
    expect(r.tierHistogram).toEqual({ "2": 2, "3": 1, "4": 1 });
    expect(r.escalationRate).toBe(50); // 2 of 4 needed tier >= 3
  });

  it("excludes failed docs from the tier histogram", () => {
    const r = computeClassifierResult([
      doc({ corpusEntryId: "1", tierUsed: 2 }),
      doc({ corpusEntryId: "2", status: "failed", predictedLabel: null, tierUsed: null }),
    ]);
    expect(r.tierHistogram).toEqual({ "2": 1 });
  });
});

describe("computeClassifierResult — flips vs baseline", () => {
  const base = (entries: Array<[string, string | null]>) =>
    new Map(entries.map(([id, pred]) => [id, { predictedLabel: pred, status: "ok" as const }]));

  it("classifies a fix, a regression, and a churn", () => {
    const prev = base([
      ["fix", "receipt"],   // was wrong (expected invoice), now right
      ["reg", "invoice"],   // was right, now wrong
      ["churn", "receipt"], // was wrong, still wrong but different
      ["same", "invoice"],  // unchanged — not a flip
    ]);
    const r = computeClassifierResult(
      [
        doc({ corpusEntryId: "fix", expectedLabel: "invoice", predictedLabel: "invoice" }),
        doc({ corpusEntryId: "reg", expectedLabel: "invoice", predictedLabel: "receipt" }),
        doc({ corpusEntryId: "churn", expectedLabel: "invoice", predictedLabel: "policy" }),
        doc({ corpusEntryId: "same", expectedLabel: "invoice", predictedLabel: "invoice" }),
      ],
      prev,
    );
    expect(r.flips).toMatchObject({ fixed: 1, regressed: 1, churned: 1 });
    expect(r.flips.items).toHaveLength(3);
    expect(r.flips.items.find((f) => f.corpusEntryId === "reg")?.kind).toBe("regressed");
  });

  it("reports no flips when there is no baseline", () => {
    const r = computeClassifierResult([doc({ predictedLabel: "receipt", expectedLabel: "invoice" })]);
    expect(r.flips).toEqual({ fixed: 0, regressed: 0, churned: 0, items: [] });
  });

  it("skips a doc the baseline failed on (no comparable prediction)", () => {
    const prev = new Map([["e1", { predictedLabel: null, status: "failed" as const }]]);
    const r = computeClassifierResult(
      [doc({ corpusEntryId: "e1", expectedLabel: "invoice", predictedLabel: "invoice" })],
      prev,
    );
    expect(r.flips.items).toHaveLength(0);
  });
});
