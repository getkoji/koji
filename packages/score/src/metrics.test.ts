import { describe, expect, it } from "vitest";

import {
  emptyCounts,
  fieldOutcome,
  hasValue,
  metricsFromCounts,
  summarizeFields,
  summarizeOutcomes,
  tally,
} from "./metrics.js";

describe("hasValue — the presence predicate", () => {
  it("treats every shape of 'no data' as absent", () => {
    for (const v of [undefined, null, "", "   ", "\n", [], {}]) {
      expect(hasValue(v)).toBe(false);
    }
  });

  it("treats an object of nothing but provenance metadata as absent", () => {
    // The model attaches `__source_text` inline. An object carrying only those
    // is a declined field, not an extracted one — counting it as a value would
    // turn every correctly-declined object field into a fabrication.
    expect(hasValue({ __source_text: "page 2", __source_context: "…" })).toBe(false);
    expect(hasValue({ __source_text: "page 2", limit: "1000" })).toBe(true);
  });

  it("treats falsy-but-real values as present", () => {
    // 0 and false are answers. Reading them as absent would score a correct
    // "zero deductible" as a miss.
    expect(hasValue(0)).toBe(true);
    expect(hasValue(false)).toBe(true);
  });

  it("treats any non-empty value as present", () => {
    expect(hasValue("x")).toBe(true);
    expect(hasValue([null])).toBe(true);
    expect(hasValue({ a: 1 })).toBe(true);
  });
});

describe("fieldOutcome — bucketing", () => {
  it("found: ground truth has a value and so do we", () => {
    const o = fieldOutcome("ABC-1", "abc 1");
    expect(o.bucket).toBe("found");
    expect(o.expectedPresent).toBe(true);
    expect(o.gotPresent).toBe(true);
    expect(o.match).toBe(true);
  });

  it("found but wrong: still found — presence and value are separate questions", () => {
    const o = fieldOutcome("PA", "LA");
    expect(o.bucket).toBe("found");
    expect(o.score).toBe(0);
  });

  it("missed: ground truth has a value and we produced nothing", () => {
    expect(fieldOutcome("ABC-1", null).bucket).toBe("missed");
    expect(fieldOutcome("ABC-1", "").bucket).toBe("missed");
    expect(fieldOutcome([{ a: 1 }], []).bucket).toBe("missed");
  });

  it("fabricated: ground truth is empty and we invented a value", () => {
    expect(fieldOutcome(null, "ABC-1").bucket).toBe("fabricated");
    expect(fieldOutcome([], [{ a: 1 }]).bucket).toBe("fabricated");
  });

  it("agreed: ground truth is empty and we declined", () => {
    expect(fieldOutcome(null, null).bucket).toBe("agreed");
    expect(fieldOutcome(null, []).bucket).toBe("agreed");
    expect(fieldOutcome("", "  ").bucket).toBe("agreed");
  });

  it("honours a declared match policy", () => {
    expect(fieldOutcome("State of Delaware", "Delaware").match).toBe(false);
    expect(fieldOutcome("State of Delaware", "Delaware", { match: "contains" }).match).toBe(true);
  });
});

describe("the four metrics", () => {
  const score = (fields: Record<string, { expected?: unknown; got?: unknown }>) =>
    summarizeFields(fields).metrics;

  it("a document that extracts NOTHING scores 0 presence recall, not a floor", () => {
    // The whole point of the split. Seven fields; three legitimately empty in
    // ground truth. The old single number counted the three as passes and
    // reported 3/7 = 42.9% for an extractor that produced nothing at all.
    const m = score({
      filer_name: { expected: "Acme Corp", got: null },
      form_type: { expected: "10-K", got: null },
      filing_date: { expected: "2026-03-26", got: null },
      total_assets: { expected: 1250, got: null },
      auditor: { expected: null, got: null },
      restatement: { expected: null, got: null },
      subsidiary: { expected: null, got: null },
    });

    expect(m.presenceRecall).toBe(0);
    // No value was produced, so there is no population to judge accuracy over.
    expect(m.valueAccuracy).toBeNull();
    expect(m.fabricationRate).toBe(0);
    expect(m.nullAgreement).toBe(1);
    expect(m.counts).toMatchObject({ present: 4, found: 0, missed: 4, absent: 3, agreed: 3 });
  });

  it("null agreement is reported but cannot lift presence recall or value accuracy", () => {
    // Same extraction, more correctly-empty fields. Under one folded number the
    // score would climb with every empty field added; here nothing moves.
    const base = {
      a: { expected: "x", got: null },
      b: { expected: "y", got: null },
    };
    const padded = {
      ...base,
      c: { expected: null, got: null },
      d: { expected: null, got: null },
      e: { expected: null, got: null },
      f: { expected: null, got: null },
    };
    expect(score(base).presenceRecall).toBe(0);
    expect(score(padded).presenceRecall).toBe(0);
    expect(score(padded).nullAgreement).toBe(1);
  });

  it("presence recall counts producing a value, even a wrong one", () => {
    const m = score({
      a: { expected: "PA", got: "LA" },
      b: { expected: "NC", got: "NC" },
      c: { expected: "SC", got: null },
    });
    expect(m.presenceRecall).toBeCloseTo(2 / 3);
    expect(m.valueAccuracy).toBeCloseTo(1 / 2);
  });

  it("value accuracy awards array partial credit", () => {
    // One expected element of two found → F1 of precision 1 / recall 0.5.
    const m = score({ rows: { expected: [{ k: "a" }, { k: "b" }], got: [{ k: "a" }] } });
    expect(m.presenceRecall).toBe(1);
    expect(m.valueAccuracy).toBeCloseTo(2 / 3);
  });

  it("fabrication rate measures inventing values ground truth says aren't there", () => {
    const m = score({
      a: { expected: null, got: "invented" },
      b: { expected: null, got: null },
      c: { expected: null, got: null },
      d: { expected: null, got: null },
      e: { expected: "real", got: "real" },
    });
    expect(m.fabricationRate).toBeCloseTo(0.25);
    expect(m.nullAgreement).toBeCloseTo(0.75);
    // Fabrication must not touch the present-field metrics.
    expect(m.presenceRecall).toBe(1);
    expect(m.valueAccuracy).toBe(1);
  });

  it("fabrication rate and null agreement are complements", () => {
    const m = score({
      a: { expected: null, got: "x" },
      b: { expected: null, got: null },
      c: { expected: null, got: "y" },
    });
    expect(m.fabricationRate! + m.nullAgreement!).toBeCloseTo(1);
  });

  it("reports null — not 0 or 1 — for a population the run never tested", () => {
    // Reporting 0 for a fabrication rate nothing measured reads as "it never
    // fabricates", which is the substitution that let the old number claim
    // 100% for scoring nothing.
    const noAbsent = score({ a: { expected: "x", got: "x" } });
    expect(noAbsent.fabricationRate).toBeNull();
    expect(noAbsent.nullAgreement).toBeNull();

    const noPresent = score({ a: { expected: null, got: null } });
    expect(noPresent.presenceRecall).toBeNull();
    expect(noPresent.valueAccuracy).toBeNull();

    const nothing = score({});
    expect(nothing.presenceRecall).toBeNull();
    expect(nothing.valueAccuracy).toBeNull();
    expect(nothing.fabricationRate).toBeNull();
    expect(nothing.nullAgreement).toBeNull();
  });

  it("a perfect extraction reports 1 / 1 / 0 / 1", () => {
    const m = score({
      a: { expected: "x", got: "x" },
      b: { expected: null, got: null },
    });
    expect(m.presenceRecall).toBe(1);
    expect(m.valueAccuracy).toBe(1);
    expect(m.fabricationRate).toBe(0);
    expect(m.nullAgreement).toBe(1);
  });
});

describe("counts", () => {
  it("are additive, so slices aggregate into a run", () => {
    const docA = summarizeFields({ a: { expected: "x", got: "x" }, b: { expected: "y", got: null } });
    const docB = summarizeFields({ a: { expected: null, got: "z" } });

    const combined = emptyCounts();
    for (const part of [docA.metrics.counts, docB.metrics.counts]) {
      combined.present += part.present;
      combined.found += part.found;
      combined.missed += part.missed;
      combined.absent += part.absent;
      combined.fabricated += part.fabricated;
      combined.agreed += part.agreed;
      combined.credit += part.credit;
      combined.exact += part.exact;
    }
    const run = metricsFromCounts(combined);
    expect(run.presenceRecall).toBeCloseTo(0.5);
    expect(run.valueAccuracy).toBe(1);
    expect(run.fabricationRate).toBe(1);
  });

  it("partition every field exactly once", () => {
    const fields = {
      a: { expected: "x", got: "x" },
      b: { expected: "y", got: "wrong" },
      c: { expected: "z", got: null },
      d: { expected: null, got: "made up" },
      e: { expected: null, got: null },
    };
    const { counts } = summarizeFields(fields).metrics;
    expect(counts.present + counts.absent).toBe(Object.keys(fields).length);
    expect(counts.found + counts.missed).toBe(counts.present);
    expect(counts.fabricated + counts.agreed).toBe(counts.absent);
  });

  it("tally folds one outcome at a time", () => {
    const counts = emptyCounts();
    tally(counts, fieldOutcome("x", "x"));
    tally(counts, fieldOutcome(null, "y"));
    expect(counts).toMatchObject({ present: 1, found: 1, exact: 1, absent: 1, fabricated: 1 });
  });
});

describe("summarizeOutcomes", () => {
  it("aggregates an iterable of outcomes", () => {
    const m = summarizeOutcomes([fieldOutcome("x", "x"), fieldOutcome("y", null)]);
    expect(m.presenceRecall).toBe(0.5);
    expect(m.valueAccuracy).toBe(1);
  });
});
