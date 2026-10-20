/**
 * Unit tests for the System-1 wire layer shared by the hosted and local
 * implementations. Mostly about tolerating shape drift *without* tolerating a
 * missing answer: an unreadable response must come back as "no answer", never
 * as a plausible default.
 */

import { describe, expect, it } from "vitest";
import {
  CHARS_PER_TOKEN,
  buildChoiceQuestion,
  buildEquivalenceQuestion,
  candidateNote,
  estimateStateTokens,
  parseChoiceAnswer,
  parseNoulAnswer,
  parseUsage,
  serializeState,
} from "./system-one";
import { ABSTAIN, type SelectCandidate } from "./types";

const OPTIONS: SelectCandidate[] = [
  { value: "2026-01-04", raw: "January 4, 2026", offset: 0 },
  { value: "2026-02-03", offset: 10 },
  { value: "2025-12-15", note: "appears in the shipping block", offset: 20 },
];

describe("buildChoiceQuestion", () => {
  it("keys criteria by candidate value and names how the source writes it", () => {
    const q = buildChoiceQuestion(OPTIONS, "which is the due date?", { allowAbstain: false });
    expect(q.type).toBe("choice");
    expect(Object.keys(q.criteria)).toEqual(["2026-01-04", "2026-02-03", "2025-12-15"]);
    expect(q.criteria["2026-01-04"]).toBe('written in the source as "January 4, 2026"');
    expect(q.criteria["2026-02-03"]).toBeNull();
    expect(q.criteria["2025-12-15"]).toBe("appears in the shipping block");
  });

  it("appends the abstain option when offered, and not otherwise", () => {
    expect(
      Object.keys(buildChoiceQuestion(OPTIONS, "x", { allowAbstain: true }).criteria),
    ).toContain(ABSTAIN);
    expect(
      Object.keys(buildChoiceQuestion(OPTIONS, "x", { allowAbstain: false }).criteria),
    ).not.toContain(ABSTAIN);
  });

  it("uses a caller-supplied abstain note", () => {
    const q = buildChoiceQuestion(OPTIONS, "x", {
      allowAbstain: true,
      abstainNote: "the policy has no expiry",
    });
    expect(q.criteria[ABSTAIN]).toBe("the policy has no expiry");
  });
});

describe("candidateNote", () => {
  it("prefers the caller's note, then the raw spelling, then nothing", () => {
    expect(candidateNote({ value: "a", note: "n", raw: "r" })).toBe("n");
    expect(candidateNote({ value: "a", raw: "A." })).toBe('written in the source as "A."');
    expect(candidateNote({ value: "a", raw: "a" })).toBeNull();
    expect(candidateNote({ value: "a" })).toBeNull();
  });
});

describe("buildEquivalenceQuestion", () => {
  it("states both values and spells out that normalization counts", () => {
    const q = buildEquivalenceQuestion("Delaware", "State of Delaware", {
      name: "state",
      description: "state of incorporation",
      type: "string",
      match: "normalized",
    });
    expect(q.type).toBe("noul");
    expect(q.instructions).toContain("Delaware");
    expect(q.instructions).toContain("State of Delaware");
    expect(q.instructions).toContain("state of incorporation");
    expect(q.instructions).toContain("equivalence policy: normalized");
    expect(q.criteria!.true).toMatch(/reformatted, normalized/);
    expect(q.criteria!.false).toMatch(/mean something different/);
  });

  it("omits the policy line when the field declares none", () => {
    expect(buildEquivalenceQuestion("a", "b", { name: "f" }).instructions).not.toContain(
      "equivalence policy",
    );
  });
});

describe("parseChoiceAnswer", () => {
  it("reads the documented shape", () => {
    expect(
      parseChoiceAnswer({
        type: "choice",
        choice: "2026-02-03",
        probabilities: { "2026-02-03": 0.8, "2026-01-04": 0.2 },
        confidence: 0.6,
        answer_confidence: 0.8,
      }),
    ).toEqual({
      choice: "2026-02-03",
      probabilities: { "2026-02-03": 0.8, "2026-01-04": 0.2 },
      confidence: 0.6,
    });
  });

  it("tolerates an alternative key spelling", () => {
    expect(parseChoiceAnswer({ answer: "x" }).choice).toBe("x");
    expect(parseChoiceAnswer({ selected: "y" }).choice).toBe("y");
  });

  it("tolerates a bare string answer", () => {
    expect(parseChoiceAnswer("x").choice).toBe("x");
  });

  it("drops non-numeric probability entries rather than coercing them", () => {
    const parsed = parseChoiceAnswer({ choice: "a", probabilities: { a: 0.5, b: "high" } });
    expect(parsed.probabilities).toEqual({ a: 0.5 });
  });

  it("reports no choice for a shape it cannot read", () => {
    expect(parseChoiceAnswer({ unexpected: true }).choice).toBeNull();
    expect(parseChoiceAnswer(null).choice).toBeNull();
    expect(parseChoiceAnswer(42).choice).toBeNull();
  });
});

describe("parseNoulAnswer", () => {
  it("reads P(true) and the answer confidence", () => {
    expect(parseNoulAnswer({ type: "noul", noul: 0.91, answer_confidence: 0.91 })).toEqual({
      noul: 0.91,
      confidence: 0.91,
    });
  });

  it("tolerates a bare number and alternative keys", () => {
    expect(parseNoulAnswer(0.4).noul).toBe(0.4);
    expect(parseNoulAnswer({ probability: 0.3 }).noul).toBe(0.3);
    expect(parseNoulAnswer({ p_true: 0.2 }).noul).toBe(0.2);
  });

  it("reports null rather than defaulting to 0.5, which would read as real uncertainty", () => {
    expect(parseNoulAnswer({ type: "noul" }).noul).toBeNull();
    expect(parseNoulAnswer(Number.NaN).noul).toBeNull();
    expect(parseNoulAnswer(undefined).noul).toBeNull();
  });
});

describe("parseUsage", () => {
  it("maps the wire names onto the result's", () => {
    expect(parseUsage({ usage: { input_tokens: 10, output_tokens: 0 } })).toEqual({
      inputTokens: 10,
      outputTokens: 0,
    });
  });

  it("is undefined when nothing was reported", () => {
    expect(parseUsage({})).toBeUndefined();
    expect(parseUsage({ usage: {} })).toBeUndefined();
    expect(parseUsage(undefined)).toBeUndefined();
  });
});

describe("state sizing", () => {
  it("measures a string state by its length and an object state by its JSON", () => {
    expect(serializeState("abc")).toEqual({ state: "abc", chars: 3 });
    const obj = { a: 1 };
    const out = serializeState(obj);
    expect(out.state).toBe(obj);
    expect(out.chars).toBe(JSON.stringify(obj).length);
  });

  it("estimates tokens against a measured ratio, not a guess", () => {
    expect(CHARS_PER_TOKEN).toBeCloseTo(5.09, 2);
    expect(estimateStateTokens(5090)).toBe(1000);
  });
});
