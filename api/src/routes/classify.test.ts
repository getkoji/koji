import { describe, it, expect } from "vitest";
import { classifyResponseBody, applyOnUnknown, resolveConfigSource } from "./classify";
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

describe("resolveConfigSource", () => {
  it("takes an inline config when only `config` is given", () => {
    expect(resolveConfigSource({ config: "classes:\n  a: {}" })).toEqual({
      kind: "inline",
      raw: "classes:\n  a: {}",
    });
  });

  it("takes a slug reference when only `classifier` is given", () => {
    expect(resolveConfigSource({ classifier: "document_type" })).toEqual({
      kind: "named",
      slug: "document_type",
      version: null,
    });
  });

  it("carries an explicit pin from `classifier_version`", () => {
    expect(resolveConfigSource({ classifier: "docs", classifier_version: "v0.0.3" })).toEqual({
      kind: "named",
      slug: "docs",
      version: "v0.0.3",
    });
  });

  it("accepts `version` as an alias for `classifier_version`", () => {
    expect(resolveConfigSource({ classifier: "docs", version: "v0.0.3" })).toEqual({
      kind: "named",
      slug: "docs",
      version: "v0.0.3",
    });
  });

  it("prefers `classifier_version` when both spellings are present", () => {
    const src = resolveConfigSource({ classifier: "docs", classifier_version: "v1.0.0", version: "v2.0.0" });
    expect(src).toEqual({ kind: "named", slug: "docs", version: "v1.0.0" });
  });

  it("reports a conflict when both a config and a slug are given", () => {
    // Silently honouring one would classify against a config the caller did
    // not intend — the whole reason this is rejected rather than ranked.
    expect(resolveConfigSource({ config: "classes:\n  a: {}", classifier: "docs" })).toEqual({
      kind: "conflict",
    });
  });

  it("reports none when neither is given", () => {
    expect(resolveConfigSource({})).toEqual({ kind: "none" });
  });

  it("treats blank/whitespace values as absent, not as a reference", () => {
    expect(resolveConfigSource({ classifier: "   " })).toEqual({ kind: "none" });
    expect(resolveConfigSource({ config: "" })).toEqual({ kind: "none" });
    expect(resolveConfigSource({ classifier: "docs", classifier_version: "  " })).toEqual({
      kind: "named",
      slug: "docs",
      version: null,
    });
  });

  it("trims a slug so a stray form-field space still resolves", () => {
    expect(resolveConfigSource({ classifier: " docs " })).toEqual({
      kind: "named",
      slug: "docs",
      version: null,
    });
  });

  it("ignores a non-string classifier rather than coercing it", () => {
    expect(resolveConfigSource({ classifier: 42 })).toEqual({ kind: "none" });
  });
});
