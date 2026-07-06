/**
 * Tests for the review → corpus promotion contract.
 *
 * The promotion handler's safety-critical logic — who may promote, and whether
 * the resulting label is scored by `validate` — is extracted into the pure
 * `resolvePromotion` helper so it can be pinned without a database. These tests
 * lock the invariant that an agent cannot grade its own homework: provisional
 * (agent-authored) labels are always `draft` and are NEVER written to the
 * denormalized ground truth that `validate` scores.
 *
 * Permission gating mirrors the route's `requires("corpus:write")` guard.
 */
import { describe, it, expect } from "vitest";
import {
  resolvePromotion,
  isUuid,
  parseUrgentBelow,
  parseOverrideProvenance,
  buildAnchoredSpan,
} from "./review";
import { resolvePermissions } from "../auth/roles";

describe("parseOverrideProvenance — override provenance validation", () => {
  const bbox = { x: 0.62, y: 0.81, w: 0.18, h: 0.03 };
  const word = { text: "$6,000.00", page: 1, x: 0.62, y: 0.81, w: 0.18, h: 0.03 };

  it("returns null when absent (typed override, no geometry)", () => {
    expect(parseOverrideProvenance(undefined)).toBeNull();
    expect(parseOverrideProvenance(null)).toBeNull();
  });

  it("accepts a full anchored payload", () => {
    const p = parseOverrideProvenance({ page: 1, bbox, words: [word], chunk: "$6,000.00" });
    expect(p).toEqual({ page: 1, bbox, words: [word], chunk: "$6,000.00" });
  });

  it("accepts bbox-only (words and chunk optional)", () => {
    expect(parseOverrideProvenance({ page: 2, bbox })).toEqual({ page: 2, bbox });
  });

  it("rejects malformed payloads as 'invalid', not silently null", () => {
    expect(parseOverrideProvenance("x")).toBe("invalid");
    expect(parseOverrideProvenance({ bbox })).toBe("invalid");
    expect(parseOverrideProvenance({ page: 0, bbox })).toBe("invalid");
    expect(parseOverrideProvenance({ page: 1, bbox: { x: 0.1, y: 0.2, w: 0.3 } })).toBe("invalid");
    expect(parseOverrideProvenance({ page: 1, bbox: { ...bbox, x: NaN } })).toBe("invalid");
    expect(parseOverrideProvenance({ page: 1, bbox, words: [{ text: "a" }] })).toBe("invalid");
    expect(parseOverrideProvenance({ page: 1, bbox, chunk: 42 })).toBe("invalid");
  });

  it("strips unknown keys from words (no payload smuggling into provenanceJson)", () => {
    const p = parseOverrideProvenance({
      page: 1,
      bbox,
      words: [{ ...word, injected: "<script>" }],
    });
    expect(p).toEqual({ page: 1, bbox, words: [word] });
  });
});

describe("buildAnchoredSpan — stored provenance shape", () => {
  it("carries the anchored rung and the no-markdown-offset sentinel", () => {
    const span = buildAnchoredSpan({
      page: 1,
      bbox: { x: 0.62, y: 0.81, w: 0.18, h: 0.03 },
      words: [{ text: "$6,000.00", page: 1, x: 0.62, y: 0.81, w: 0.18, h: 0.03 }],
      chunk: "$6,000.00",
    });
    expect(span.resolution).toBe("anchored");
    expect(span.offset).toBe(-1);
    expect(span.length).toBe(0);
    expect(span.chunk).toBe("$6,000.00");
    expect(span.page).toBe(1);
    expect(span.words).toHaveLength(1);
  });

  it("omits empty words and absent chunk", () => {
    const span = buildAnchoredSpan({ page: 3, bbox: { x: 0, y: 0, w: 1, h: 1 }, words: [] });
    expect(span).not.toHaveProperty("words");
    expect(span).not.toHaveProperty("chunk");
  });
});

describe("isUuid — malformed ids are rejected (→ 404, not a Postgres 500)", () => {
  it("accepts a well-formed uuid", () => {
    expect(isUuid("94f9271d-4d16-40e3-a6c6-6217398a8242")).toBe(true);
  });

  it("rejects the 8-char prefix shown in `review ls`", () => {
    // The exact footgun that crashed prod: a truncated id reaching the uuid cast.
    expect(isUuid("e100cad1")).toBe(false);
  });

  it("rejects other malformed ids", () => {
    expect(isUuid("")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("94f9271d-4d16-40e3-a6c6-6217398a8242-extra")).toBe(false);
  });
});

describe("resolvePromotion — gating", () => {
  it("rejects human-gated promotion of an unresolved item (409 path)", () => {
    const d = resolvePromotion({ provisional: false, status: "pending", resolution: null });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error).toMatch(/resolved and approved/i);
  });

  it("rejects human-gated promotion of a resolved-but-rejected item", () => {
    const d = resolvePromotion({ provisional: false, status: "completed", resolution: "rejected" });
    expect(d.ok).toBe(false);
  });

  it("allows human-gated promotion of a completed + approved item", () => {
    const d = resolvePromotion({ provisional: false, status: "completed", resolution: "approved" });
    expect(d.ok).toBe(true);
  });

  it("allows provisional promotion regardless of status", () => {
    for (const status of ["pending", "in_review", "completed"]) {
      const d = resolvePromotion({ provisional: true, status, resolution: null });
      expect(d.ok).toBe(true);
    }
  });
});

describe("resolvePromotion — draft/approved + validate-exclusion invariant", () => {
  it("human-gated → approved label, written to the scored ground truth", () => {
    const d = resolvePromotion({ provisional: false, status: "completed", resolution: "approved" });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.reviewStatus).toBe("approved");
      expect(d.authoredViaAgent).toBe(false);
      expect(d.writeDenormalizedGt).toBe(true); // counts in validate
    }
  });

  it("provisional → draft label, EXCLUDED from the scored ground truth", () => {
    const d = resolvePromotion({ provisional: true, status: "pending", resolution: null });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.reviewStatus).toBe("draft");
      expect(d.authoredViaAgent).toBe(true);
      // The whole safety property: an agent label never reaches validate until
      // a human approves the draft.
      expect(d.writeDenormalizedGt).toBe(false);
    }
  });
});

describe("review promotion — permission gating", () => {
  // `review promote` is gated on corpus:promote — the reviewer persona, who
  // works the queue, holds it (alongside review:act) without needing the
  // broader corpus:write.
  it("reviewer can promote reviewed docs (corpus:promote)", () => {
    expect(resolvePermissions(["reviewer"]).has("corpus:promote")).toBe(true);
  });

  it("a read-only viewer cannot promote", () => {
    expect(resolvePermissions(["viewer"]).has("corpus:promote")).toBe(false);
  });

  // Approving a draft into the validated set is corpus authoring — gated on
  // the stronger corpus:write, which starts at schema-editor (a reviewer can
  // create drafts but not approve them).
  it("approving a draft requires corpus:write (schema-editor+, not reviewer)", () => {
    expect(resolvePermissions(["schema-editor"]).has("corpus:write")).toBe(true);
    expect(resolvePermissions(["reviewer"]).has("corpus:write")).toBe(false);
    expect(resolvePermissions(["viewer"]).has("corpus:write")).toBe(false);
  });
});

describe("parseUrgentBelow — stats threshold clamping", () => {
  it("passes through a valid threshold", () => {
    expect(parseUrgentBelow("0.5")).toBe(0.5);
    expect(parseUrgentBelow("0")).toBe(0);
    expect(parseUrgentBelow("1")).toBe(1);
  });

  it("defaults when the param is absent", () => {
    expect(parseUrgentBelow(undefined)).toBe(0.7);
  });

  it("falls back to 0.7 on malformed or out-of-range values", () => {
    expect(parseUrgentBelow("abc")).toBe(0.7);
    expect(parseUrgentBelow("-1")).toBe(0.7);
    expect(parseUrgentBelow("2")).toBe(0.7);
    expect(parseUrgentBelow("NaN")).toBe(0.7);
  });
});
