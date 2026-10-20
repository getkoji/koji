/**
 * Unit tests for the OSS default selector.
 *
 * The parity suite covers the contract. These cover the parts specific to
 * driving a chat model: which path runs, how the prompt is built, and the
 * answer-resolution ladder — which is where tolerance has to stop short of
 * guessing.
 */

import { describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "../extract/providers";
import {
  LlmChoiceSelectProvider,
  LlmAdjudicateProvider,
  assignLabels,
  buildAdjudicatePrompt,
  buildChoicePrompt,
  parseAdjudicateText,
  parseChoiceText,
  resolveToValue,
} from "./llm-choice";
import { disableAdjudication, enableAdjudication } from "./adjudicate";
import { ABSTAIN, SelectNoAnswerError, type SelectCandidate } from "./types";

const DOC = "Issued January 4, 2026. Due 2026-02-03.";
const OPTIONS: SelectCandidate[] = [
  { value: "2026-01-04", raw: "January 4, 2026", offset: 7 },
  { value: "2026-02-03", raw: "2026-02-03", offset: 29 },
];

function model(opts: {
  generate?: (prompt: string) => string;
  labelProbabilities?: (prompt: string, labels: readonly string[]) => Record<string, number>;
}): ModelProvider {
  const base: ModelProvider = {
    contextTokens: 128_000,
    generate: vi.fn(async (prompt: string) => opts.generate?.(prompt) ?? "{}"),
  };
  if (!opts.labelProbabilities) return base;
  return {
    ...base,
    labelProbabilities: vi.fn(async (prompt: string, labels: readonly string[]) =>
      opts.labelProbabilities!(prompt, labels),
    ),
  };
}

describe("path selection", () => {
  it("uses the logprob path when the provider reports label probabilities", async () => {
    const m = model({ labelProbabilities: () => ({ B: 0.7, A: 0.3 }) });
    const result = await new LlmChoiceSelectProvider(m).select(DOC, OPTIONS, "which?");
    expect(result.calibrated).toBe(true);
    expect(result.choice).toBe("2026-02-03");
    expect(result.probabilities["2026-02-03"]).toBeCloseTo(0.7, 6);
    expect(m.generate).not.toHaveBeenCalled();
  });

  it("falls through to the text path when the endpoint ignores the logprob parameter", async () => {
    const m = model({
      labelProbabilities: () => ({}),
      generate: () => JSON.stringify({ choice: "A", confidence: 0.6 }),
    });
    const result = await new LlmChoiceSelectProvider(m).select(DOC, OPTIONS, "which?");
    expect(result.calibrated).toBe(false);
    expect(result.choice).toBe("2026-01-04");
    expect(m.generate).toHaveBeenCalledTimes(1);
  });

  it("skips the logprob path past the logprob window", async () => {
    const many = Array.from({ length: 24 }, (_, i) => ({ value: `v${i}`, offset: i }));
    const m = model({
      labelProbabilities: () => {
        throw new Error("should not be called");
      },
      generate: () => JSON.stringify({ choice: "C" }),
    });
    const result = await new LlmChoiceSelectProvider(m).select(DOC, many, "which?");
    expect(result.choice).toBe("v2");
    expect(result.calibrated).toBe(false);
  });

  it("honours forceTextPath", async () => {
    const m = model({
      labelProbabilities: () => ({ A: 1 }),
      generate: () => JSON.stringify({ choice: "B" }),
    });
    const result = await new LlmChoiceSelectProvider(m, { forceTextPath: true }).select(
      DOC,
      OPTIONS,
      "which?",
    );
    expect(result.choice).toBe("2026-02-03");
    expect(m.labelProbabilities).not.toHaveBeenCalled();
  });

  it("ignores logprob mass on labels it never offered", async () => {
    const m = model({
      labelProbabilities: () => ({ Z: 0.9, A: 0.1 }),
      generate: () => JSON.stringify({ choice: "B" }),
    });
    const result = await new LlmChoiceSelectProvider(m).select(DOC, OPTIONS, "which?");
    // Mass on Z is discarded; A is the only real answer left.
    expect(result.choice).toBe("2026-01-04");
    expect(Object.keys(result.probabilities)).toEqual(["2026-01-04"]);
  });
});

describe("unresolvable answers", () => {
  it("abstains rather than passing the model's string through", async () => {
    const m = model({ generate: () => JSON.stringify({ choice: "2026-06-06" }) });
    const result = await new LlmChoiceSelectProvider(m).select(DOC, OPTIONS, "which?");
    expect(result.choice).toBe(ABSTAIN);
    expect(result.confidence).toBe(0);
  });

  it("throws rather than picking arbitrarily when abstention is not allowed", async () => {
    const m = model({ generate: () => "no idea" });
    await expect(
      new LlmChoiceSelectProvider(m).select(DOC, OPTIONS, "which?", { allowAbstain: false }),
    ).rejects.toThrow(SelectNoAnswerError);
  });
});

describe("prompt building", () => {
  it("lists every option with its label and how the source writes it", () => {
    const labelled = assignLabels(OPTIONS, true);
    const prompt = buildChoicePrompt(DOC, labelled, "which is the due date?", "json");
    expect(prompt).toContain("A. 2026-01-04 — written in the source as \"January 4, 2026\"");
    expect(prompt).toContain("B. 2026-02-03");
    expect(prompt).toContain("C. (none of the above)");
    expect(prompt).toContain(DOC);
    expect(prompt).toContain('{"choice": "<label>", "confidence": <0.0-1.0>}');
  });

  it("asks for a bare label on the logprob path", () => {
    const prompt = buildChoicePrompt(DOC, assignLabels(OPTIONS, false), "which?", "label");
    expect(prompt).toContain("single label");
    expect(prompt).not.toContain('"confidence"');
  });

  it("serializes a structured state", () => {
    const prompt = buildChoicePrompt({ doc_type: "invoice" }, assignLabels(OPTIONS, false), "x", "json");
    expect(prompt).toContain('"doc_type": "invoice"');
  });

  it("names the field and spells out that normalization counts, when adjudicating", () => {
    const prompt = buildAdjudicatePrompt("Delaware", "State of Delaware", {
      name: "state_of_incorporation",
      type: "string",
      match: "normalized",
    });
    expect(prompt).toContain("state_of_incorporation");
    expect(prompt).toContain("Delaware");
    expect(prompt).toContain("State of Delaware");
    expect(prompt).toContain("normalized");
    expect(prompt).toContain('"equivalent"');
  });

  it("renders an empty value explicitly rather than as nothing", () => {
    expect(buildAdjudicatePrompt(null, "", { name: "f" })).toContain("(empty)");
  });
});

describe("assignLabels", () => {
  it("adds the abstain option last, with its own label", () => {
    const labelled = assignLabels(OPTIONS, true);
    expect(labelled.map((l) => l.label)).toEqual(["A", "B", "C"]);
    expect(labelled[2]!.value).toBe(ABSTAIN);
    expect(labelled[2]!.isAbstain).toBe(true);
  });

  it("falls back to ordinals past the alphabet", () => {
    const many = Array.from({ length: 28 }, (_, i) => ({ value: `v${i}` }));
    const labelled = assignLabels(many, false);
    expect(labelled[25]!.label).toBe("Z");
    expect(labelled[26]!.label).toBe("27");
  });
});

describe("parseChoiceText", () => {
  it("reads a plain JSON answer", () => {
    expect(parseChoiceText('{"choice":"B","confidence":0.7}')).toEqual({
      choice: "B",
      confidence: 0.7,
    });
  });

  it("reads a fenced JSON answer", () => {
    expect(parseChoiceText('```json\n{"choice":"A"}\n```').choice).toBe("A");
  });

  it("reads JSON wrapped in prose", () => {
    expect(parseChoiceText('Sure! {"choice":"C"} Hope that helps.').choice).toBe("C");
  });

  it("accepts an alternative key spelling", () => {
    expect(parseChoiceText('{"answer":"B"}').choice).toBe("B");
    expect(parseChoiceText('{"label":2}').choice).toBe("2");
  });

  it("treats a bare answer as an answer", () => {
    expect(parseChoiceText("  B  ").choice).toBe("B");
  });

  it("reports no answer for empty output", () => {
    expect(parseChoiceText("   ").choice).toBeNull();
  });
});

describe("resolveToValue", () => {
  const labelled = assignLabels(OPTIONS, true);

  it("resolves an exact label", () => {
    expect(resolveToValue("B", labelled)).toBe("2026-02-03");
  });

  it("resolves a label wearing punctuation or the wrong case", () => {
    expect(resolveToValue("a.", labelled)).toBe("2026-01-04");
    expect(resolveToValue('"B"', labelled)).toBe("2026-02-03");
    expect(resolveToValue("(b)", labelled)).toBe("2026-02-03");
  });

  it("resolves a 1-based ordinal", () => {
    expect(resolveToValue("2", labelled)).toBe("2026-02-03");
    expect(resolveToValue("option 1", labelled)).toBe("2026-01-04");
  });

  it("resolves the option's own value", () => {
    expect(resolveToValue("2026-02-03", labelled)).toBe("2026-02-03");
    expect(resolveToValue("  2026-01-04 ", labelled)).toBe("2026-01-04");
  });

  it("resolves 'none' to the abstain option", () => {
    expect(resolveToValue("none", labelled)).toBe(ABSTAIN);
    expect(resolveToValue("None of the above", labelled)).toBe(ABSTAIN);
    expect(resolveToValue("n/a", labelled)).toBe(ABSTAIN);
  });

  it("refuses to resolve anything that is not an option", () => {
    expect(resolveToValue("2026-06-06", labelled)).toBeNull();
    expect(resolveToValue("the second one, probably", labelled)).toBeNull();
    expect(resolveToValue("", labelled)).toBeNull();
    expect(resolveToValue(null, labelled)).toBeNull();
  });

  it("refuses an out-of-range ordinal", () => {
    expect(resolveToValue("99", labelled)).toBeNull();
  });

  it("refuses an ambiguous normalized match rather than picking one", () => {
    // Two options that differ only by case cannot both be the answer, so the
    // normalized rung must decline instead of taking the first.
    const ambiguous = assignLabels([{ value: "Yes" }, { value: "yes" }], false);
    expect(resolveToValue("YES", ambiguous)).toBeNull();
  });
});

describe("parseAdjudicateText", () => {
  it("reads a boolean verdict", () => {
    expect(parseAdjudicateText('{"equivalent":true,"confidence":0.9,"reason":"same"}')).toEqual({
      equivalent: true,
      confidence: 0.9,
      reason: "same",
    });
  });

  it("reads a stringified boolean", () => {
    expect(parseAdjudicateText('{"equivalent":"no"}')?.equivalent).toBe(false);
  });

  it("reads an alternative key", () => {
    expect(parseAdjudicateText('{"same":true}')?.equivalent).toBe(true);
  });

  it("reads a bare yes/no", () => {
    expect(parseAdjudicateText("yes")?.equivalent).toBe(true);
    expect(parseAdjudicateText("FALSE")?.equivalent).toBe(false);
  });

  it("reports no verdict rather than defaulting to one", () => {
    expect(parseAdjudicateText("it depends")).toBeNull();
    expect(parseAdjudicateText('{"equivalent":"maybe"}')).toBeNull();
  });
});

describe("LlmAdjudicateProvider", () => {
  it("clamps the model's self-reported confidence and marks it uncalibrated", async () => {
    enableAdjudication("unit test");
    try {
      const m = model({ generate: () => JSON.stringify({ equivalent: true, confidence: 4 }) });
      const result = await new LlmAdjudicateProvider(m).adjudicate("a", "A", { name: "f" });
      expect(result).toMatchObject({ equivalent: true, confidence: 1, calibrated: false });
    } finally {
      disableAdjudication();
    }
  });

  it("throws on an unreadable verdict instead of inventing one", async () => {
    enableAdjudication("unit test");
    try {
      const m = model({ generate: () => "hmm" });
      await expect(
        new LlmAdjudicateProvider(m).adjudicate("a", "b", { name: "f" }),
      ).rejects.toThrow(/could not parse an equivalence verdict/);
    } finally {
      disableAdjudication();
    }
  });
});
