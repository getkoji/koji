/**
 * Unit tests for the `review` capability.
 *
 * The interesting assertions are about what the agent reviewer *refuses* to
 * do: it never writes a value that was not a candidate, it never decides a
 * free-form item, and a failure inside it is a deferral rather than a verdict.
 */

import { describe, expect, it, vi } from "vitest";
import {
  AgentReviewProvider,
  HumanQueueReviewProvider,
  reviewInstructions,
  valuesMatch,
} from "./review";
import {
  ABSTAIN,
  type ReviewItem,
  type SelectCandidate,
  type SelectProvider,
  type SelectResult,
} from "./types";

const OPTIONS: SelectCandidate[] = [
  { value: "2026-01-04", offset: 7 },
  { value: "2026-02-03", offset: 29 },
];

function item(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "doc-1#due_date",
    field: { name: "due_date", description: "the date payment is due", type: "date" },
    value: "2026-01-04",
    confidence: 0.4,
    state: "Issued January 4, 2026. Due 2026-02-03.",
    options: OPTIONS,
    ...overrides,
  };
}

function selector(result: Partial<SelectResult> | Error): SelectProvider {
  return {
    name: "stub",
    maxOptions: 10,
    select: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return {
        choice: "2026-02-03",
        selected: OPTIONS[1]!,
        abstained: false,
        probabilities: { "2026-02-03": 1 },
        confidence: 0.95,
        answerConfidence: 1,
        calibrated: true,
        provider: "stub",
        ...result,
      } as SelectResult;
    }),
  };
}

describe("HumanQueueReviewProvider", () => {
  it("defers every item and parks it on the queue", async () => {
    const enqueue = vi.fn();
    const provider = new HumanQueueReviewProvider({ enqueue });
    const verdicts = await provider.review([item(), item({ id: "b" })]);
    expect(provider.kind).toBe("human");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(verdicts.map((v) => v.decision)).toEqual(["defer", "defer"]);
    // A deferral is the absence of a judgement, so it carries no confidence.
    expect(verdicts.every((v) => v.confidence === 0)).toBe(true);
    expect(verdicts[0]!.value).toBe("2026-01-04");
  });

  it("carries the pipeline's reason through when it gave one", async () => {
    const [verdict] = await new HumanQueueReviewProvider().review([
      item({ reason: "confidence below gate" }),
    ]);
    expect(verdict!.reason).toBe("confidence below gate");
  });

  it("does not call the queue for an empty batch", async () => {
    const enqueue = vi.fn();
    expect(await new HumanQueueReviewProvider({ enqueue }).review([])).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("AgentReviewProvider", () => {
  it("corrects to a selected candidate, carrying its provenance", async () => {
    const provider = new AgentReviewProvider({ select: selector({}) });
    const [verdict] = await provider.review([item()]);
    expect(provider.kind).toBe("agent");
    expect(verdict).toMatchObject({ decision: "correct", value: "2026-02-03", confidence: 0.95 });
    expect(verdict!.selected).toBe(OPTIONS[1]);
    expect(verdict!.selected!.offset).toBe(29);
  });

  it("accepts when it picks the value the extraction already proposed", async () => {
    const provider = new AgentReviewProvider({
      select: selector({ choice: "2026-01-04", selected: OPTIONS[0]! }),
    });
    const [verdict] = await provider.review([item()]);
    expect(verdict!.decision).toBe("accept");
    expect(verdict!.value).toBe("2026-01-04");
  });

  it("defers an item with no candidate set rather than writing free-form text", async () => {
    const select = selector({});
    const provider = new AgentReviewProvider({ select });
    const [verdict] = await provider.review([item({ options: undefined })]);
    expect(verdict!.decision).toBe("defer");
    expect(verdict!.reason).toMatch(/no candidate set/);
    expect(select.select).not.toHaveBeenCalled();
  });

  it("defers below the confidence gate instead of rubber-stamping", async () => {
    const provider = new AgentReviewProvider({ select: selector({ confidence: 0.5 }) });
    const [verdict] = await provider.review([item()]);
    expect(verdict!.decision).toBe("defer");
    expect(verdict!.reason).toMatch(/below the 0.8 gate/);
    expect(verdict!.value).toBe("2026-01-04");
  });

  it("rejects the field when it confidently finds no value", async () => {
    const provider = new AgentReviewProvider({
      select: selector({ choice: ABSTAIN, selected: null, abstained: true, confidence: 0.97 }),
    });
    const [verdict] = await provider.review([item()]);
    expect(verdict).toMatchObject({ decision: "reject", value: null, selected: null });
  });

  it("defers an unconfident abstention rather than deleting a value", async () => {
    const provider = new AgentReviewProvider({
      select: selector({ choice: ABSTAIN, selected: null, abstained: true, confidence: 0.2 }),
    });
    const [verdict] = await provider.review([item()]);
    expect(verdict!.decision).toBe("defer");
    expect(verdict!.value).toBe("2026-01-04");
  });

  it("turns a selector failure into a deferral, not a verdict", async () => {
    const provider = new AgentReviewProvider({ select: selector(new Error("upstream 503")) });
    const [verdict] = await provider.review([item()]);
    expect(verdict!.decision).toBe("defer");
    expect(verdict!.reason).toMatch(/agent review failed: upstream 503/);
  });

  it("honours a custom gate", async () => {
    const provider = new AgentReviewProvider({
      select: selector({ confidence: 0.5 }),
      minConfidence: 0.3,
    });
    const [verdict] = await provider.review([item()]);
    expect(verdict!.decision).toBe("correct");
  });

  it("one failing item does not stop the batch", async () => {
    const provider = new AgentReviewProvider({ select: selector({}) });
    const verdicts = await provider.review([item({ options: undefined }), item({ id: "b" })]);
    expect(verdicts.map((v) => v.decision)).toEqual(["defer", "correct"]);
    expect(verdicts.map((v) => v.id)).toEqual(["doc-1#due_date", "b"]);
  });
});

describe("reviewInstructions", () => {
  it("states the proposed value so the agent confirms or overturns a claim", () => {
    expect(reviewInstructions(item())).toContain('proposed "2026-01-04"');
    expect(reviewInstructions(item())).toContain("due_date");
    expect(reviewInstructions(item())).toContain("the date payment is due");
  });

  it("names an absent value explicitly", () => {
    expect(reviewInstructions(item({ value: null }))).toContain("no value");
  });
});

describe("valuesMatch", () => {
  it("compares strings after trimming only", () => {
    expect(valuesMatch(" 2026-02-03 ", "2026-02-03")).toBe(true);
    expect(valuesMatch("2026-02-03", "2026-02-04")).toBe(false);
  });

  it("does not normalize — equivalence is the schema's decision, not this helper's", () => {
    expect(valuesMatch("1,000", "1000")).toBe(false);
    expect(valuesMatch("YES", "yes")).toBe(false);
  });

  it("treats an absent value as not matching anything", () => {
    expect(valuesMatch(null, "x")).toBe(false);
    expect(valuesMatch(undefined, "x")).toBe(false);
  });

  it("stringifies a non-string value", () => {
    expect(valuesMatch(42, "42")).toBe(true);
  });
});
