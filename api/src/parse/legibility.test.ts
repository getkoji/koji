import { describe, it, expect, vi } from "vitest";
import {
  checkLegibility,
  parseLegibilityResponse,
  isBadScan,
  DEFAULT_LEGIBILITY_THRESHOLD,
  type LegibilityVerdict,
} from "./legibility";
import type { ModelProvider } from "../extract/providers";
import { DEFAULT_CONTEXT_TOKENS } from "../extract/context-budget";

function mockProvider(response: string): ModelProvider {
  return { contextTokens: DEFAULT_CONTEXT_TOKENS, generate: vi.fn().mockResolvedValue(response) };
}

describe("parseLegibilityResponse", () => {
  it("parses a clean legible verdict", () => {
    const r = parseLegibilityResponse('{"legible": true, "confidence": 0.95, "reason": "clean"}');
    expect(r.legible).toBe(true);
    expect(r.confidence).toBe(0.95);
  });

  it("parses an illegible verdict", () => {
    const r = parseLegibilityResponse('{"legible": false, "confidence": 0.1, "reason": "garbled"}');
    expect(r.legible).toBe(false);
    expect(r.confidence).toBe(0.1);
  });

  it("extracts embedded JSON", () => {
    expect(parseLegibilityResponse('verdict: {"legible": false, "confidence": 0.2}').legible).toBe(false);
  });

  it("clamps out-of-range confidence", () => {
    expect(parseLegibilityResponse('{"legible": true, "confidence": 5}').confidence).toBe(1);
    expect(parseLegibilityResponse('{"legible": false, "confidence": -2}').confidence).toBe(0);
  });

  it("fails open on garbage / missing key", () => {
    expect(parseLegibilityResponse("not json").legible).toBe(true);
    expect(parseLegibilityResponse('{"foo": 1}').legible).toBe(true);
    expect(parseLegibilityResponse("").legible).toBe(true);
  });
});

describe("checkLegibility", () => {
  it("returns legible for a coherent verdict", async () => {
    const v = await checkLegibility("BALLANMOOR HOMEOWNERS ASSN INC ...", mockProvider('{"legible": true, "confidence": 0.97}'));
    expect(v.legible).toBe(true);
    expect(v.errored).toBe(false);
  });

  it("returns illegible for a garbled verdict", async () => {
    const v = await checkLegibility("BALL4NM00R H0ME0WNE5 4SSN 1NC ...", mockProvider('{"legible": false, "confidence": 0.15, "reason": "OCR noise"}'));
    expect(v.legible).toBe(false);
    expect(v.confidence).toBe(0.15);
  });

  it("skips the call for empty text (legible, no judge)", async () => {
    const provider = mockProvider('{"legible": false, "confidence": 0}');
    const v = await checkLegibility("   ", provider);
    expect(v.legible).toBe(true);
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("fails open when the provider throws", async () => {
    const provider: ModelProvider = {
      contextTokens: DEFAULT_CONTEXT_TOKENS,
      generate: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const v = await checkLegibility("some text", provider);
    expect(v.legible).toBe(true);
    expect(v.errored).toBe(true);
  });

  it("only samples the opening of long markdown", async () => {
    const provider = mockProvider('{"legible": true, "confidence": 1}');
    await checkLegibility("x".repeat(50_000), provider);
    const prompt = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    // Prompt carries the wrapper + a bounded sample, not all 50k chars.
    expect(prompt.length).toBeLessThan(3000);
  });
});

describe("isBadScan", () => {
  const v = (over: Partial<LegibilityVerdict>): LegibilityVerdict => ({
    legible: true,
    confidence: 1,
    reason: null,
    errored: false,
    ...over,
  });

  it("flags an illegible verdict", () => {
    expect(isBadScan(v({ legible: false, confidence: 0.2 }))).toBe(true);
  });

  it("flags legible-but-low-confidence below threshold", () => {
    expect(isBadScan(v({ legible: true, confidence: 0.4 }), 0.6)).toBe(true);
  });

  it("does not flag a confident legible verdict", () => {
    expect(isBadScan(v({ legible: true, confidence: 0.95 }))).toBe(false);
  });

  it("never flags an errored (fail-open) check", () => {
    expect(isBadScan(v({ legible: true, confidence: 1, errored: true }))).toBe(false);
  });

  it("uses the default threshold", () => {
    expect(DEFAULT_LEGIBILITY_THRESHOLD).toBeGreaterThan(0);
    expect(isBadScan(v({ confidence: DEFAULT_LEGIBILITY_THRESHOLD - 0.01 }))).toBe(true);
  });
});
