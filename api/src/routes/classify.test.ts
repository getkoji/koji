import { describe, it, expect } from "vitest";
import { classifyResponseBody, applyOnUnknown } from "./classify";
import { Tier, UNKNOWN_LABEL } from "../classify";
import type { ClassifyOutcome } from "../classify";

const matched: ClassifyOutcome = {
  label: "invoice",
  confidence: 0.9,
  method: "keyword",
  tierUsed: Tier.KEYWORD,
  evidencePage: 2,
  scores: [{ id: "invoice", score: 0.9, hits: 3, total: 3, evidencePage: 2 }],
};

const unknown: ClassifyOutcome = {
  label: UNKNOWN_LABEL,
  confidence: 0,
  method: "unknown",
  tierUsed: Tier.KEYWORD,
  evidencePage: null,
};

describe("classifyResponseBody", () => {
  it("maps the outcome to the snake_case wire shape", () => {
    const body = classifyResponseBody(matched);
    expect(body).toMatchObject({
      label: "invoice",
      confidence: 0.9,
      method: "keyword",
      tier_used: 2,
      evidence_page: 2,
    });
    expect(body.scores?.[0]).toMatchObject({ id: "invoice", evidence_page: 2 });
  });
});

describe("applyOnUnknown", () => {
  it("returns 200 with the label for a match", () => {
    const { status, body } = applyOnUnknown(matched, "reject");
    expect(status).toBe(200);
    expect(body.label).toBe("invoice");
  });

  it("returns 200 unknown when the policy is `return`", () => {
    const { status, body } = applyOnUnknown(unknown, "return");
    expect(status).toBe(200);
    expect(body.label).toBe(UNKNOWN_LABEL);
  });

  it("returns 422 for an unmatched document when the policy is `reject`", () => {
    const { status, body } = applyOnUnknown(unknown, "reject");
    expect(status).toBe(422);
    expect(body.error).toBe("no class matched");
    expect(body.label).toBe(UNKNOWN_LABEL);
  });
});
