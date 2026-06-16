import { describe, it, expect } from "vitest";
import { prettyStageName, STAGE_LABELS } from "./format";

describe("prettyStageName", () => {
  it("returns the canonical label for a known stage name", () => {
    expect(prettyStageName("extract")).toBe("Extract");
    expect(prettyStageName("ocr_quality")).toBe("OCR quality");
    expect(prettyStageName("hitl_router")).toBe("Review queue");
  });

  it("falls back to underscore-to-space for unknown names", () => {
    expect(prettyStageName("some_new_stage")).toBe("some new stage");
    expect(prettyStageName("custom")).toBe("custom");
  });

  it("returns 'unknown stage' for undefined / null / empty input", () => {
    // The regression that motivated this whole change: the SSE stream
    // briefly emitted stages without a `stageName` field, the dashboard
    // mapped over them, and `undefined.replaceAll` crashed the whole
    // trace page. The crash surfaced to users as
    //   "This page couldn't load — Reload to try again, or go back."
    // Now we render a visible placeholder instead.
    expect(prettyStageName(undefined)).toBe("unknown stage");
    expect(prettyStageName(null)).toBe("unknown stage");
    expect(prettyStageName("")).toBe("unknown stage");
  });

  it("handles non-string inputs without throwing (defensive)", () => {
    // TypeScript types prevent these at compile time, but the helper is
    // called on data from the wire — drift between server and client
    // can sneak through. Locking in numeric / object / boolean inputs
    // returning the placeholder string is what prevents the crash from
    // re-emerging.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(prettyStageName(123 as any)).toBe("unknown stage");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(prettyStageName({} as any)).toBe("unknown stage");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(prettyStageName(true as any)).toBe("unknown stage");
  });

  it("every STAGE_LABELS key passes through the helper cleanly", () => {
    // Catches typos that would make a known label fall through to the
    // underscore-replace path.
    for (const [key, label] of Object.entries(STAGE_LABELS)) {
      expect(prettyStageName(key)).toBe(label);
    }
  });
});
