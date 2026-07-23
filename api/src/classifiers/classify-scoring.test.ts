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

  it("does not credit a correct match against an unlabeled entry", () => {
    // expected null (no ground truth) never counts as correct, even if predicted.
    const r = computeClassifierResult([doc({ expectedLabel: null, predictedLabel: "invoice" })]);
    expect(r.docsCorrect).toBe(0);
    expect(r.accuracy).toBe(0);
  });
});
