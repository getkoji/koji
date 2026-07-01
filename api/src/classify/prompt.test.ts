import { describe, it, expect } from "vitest";
import {
  buildClassifyPrompt,
  buildVisionClassifyPrompt,
  parseClassifyResponse,
} from "./prompt";
import { UNKNOWN_LABEL } from "./types";

describe("buildClassifyPrompt", () => {
  it("lists classes with descriptions and page-tagged text", () => {
    const prompt = buildClassifyPrompt(
      [{ page: 2, text: "amount due" }],
      [{ id: "invoice", description: "a bill" }],
    );
    expect(prompt).toContain("- invoice: a bill");
    expect(prompt).toContain(`- ${UNKNOWN_LABEL}:`);
    expect(prompt).toContain("--- page 2 ---");
    expect(prompt).toContain("amount due");
    expect(prompt).toContain("ignore those"); // cover-sheet instruction
  });
});

describe("buildVisionClassifyPrompt", () => {
  it("omits text blocks and keeps the class list + contract", () => {
    const prompt = buildVisionClassifyPrompt([{ id: "policy" }]);
    expect(prompt).toContain("- policy: policy");
    expect(prompt).toContain("page image");
    expect(prompt).not.toContain("--- page");
  });
});

describe("parseClassifyResponse", () => {
  const valid = new Set(["invoice", "policy"]);

  it("parses a clean JSON object", () => {
    const r = parseClassifyResponse('{"label":"invoice","confidence":0.9,"evidence_page":2}', valid);
    expect(r).toEqual({ label: "invoice", confidence: 0.9, evidencePage: 2 });
  });

  it("recovers JSON wrapped in prose / fences", () => {
    const r = parseClassifyResponse('```json\n{"label":"policy","confidence":0.5}\n```', valid);
    expect(r?.label).toBe("policy");
    expect(r?.evidencePage).toBeNull();
  });

  it("coerces an unknown label to the unknown sentinel", () => {
    const r = parseClassifyResponse('{"label":"spaceship","confidence":1}', valid);
    expect(r?.label).toBe(UNKNOWN_LABEL);
  });

  it("clamps confidence to [0,1]", () => {
    expect(parseClassifyResponse('{"label":"invoice","confidence":5}', valid)?.confidence).toBe(1);
    expect(parseClassifyResponse('{"label":"invoice","confidence":-3}', valid)?.confidence).toBe(0);
  });

  it("returns null when no JSON is recoverable", () => {
    expect(parseClassifyResponse("not json at all", valid)).toBeNull();
    expect(parseClassifyResponse("", valid)).toBeNull();
    expect(parseClassifyResponse(null, valid)).toBeNull();
  });
});
