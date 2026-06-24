import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseFitConfig,
  hasPreGate,
  checkKeywords,
  checkDerived,
  checkAssertion,
  assembleFit,
  parseAssertionResponse,
} from "./fit";
import { intelligentExtract } from "./intelligent-pipeline";
import { extractFields } from "./pipeline";
import type { ModelProvider } from "./providers";

function mockProvider(responses: string | string[]): ModelProvider {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  return {
    generate: vi.fn().mockImplementation(async () => (queue.length > 1 ? queue.shift()! : queue[0]!)),
  };
}

const SCHEMA = {
  name: "insurance_policy",
  fields: {
    policy_number: { type: "string", required: true },
    insured_name: { type: "string", required: true },
    notes: { type: "string" },
  },
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

// ── parseFitConfig ───────────────────────────────────────────────────

describe("parseFitConfig", () => {
  it("returns null when no fit block", () => {
    expect(parseFitConfig({ fields: {} })).toBeNull();
    expect(parseFitConfig({ fit: {} })).toBeNull();
    expect(parseFitConfig(null)).toBeNull();
  });

  it("parses a full block", () => {
    const cfg = parseFitConfig({
      fit: {
        keywords: ["Policy", "Insured"],
        min_keywords: 2,
        requires: "an insurance policy",
        anchor_fields: ["policy_number"],
        min_score: 0.6,
        on_misfit: "reject",
      },
    })!;
    expect(cfg.keywords).toEqual(["policy", "insured"]); // lowercased
    expect(cfg.minKeywords).toBe(2);
    expect(cfg.requires).toBe("an insurance policy");
    expect(cfg.anchorFields).toEqual(["policy_number"]);
    expect(cfg.minScore).toBe(0.6);
    expect(cfg.onMisfit).toBe("reject");
    expect(hasPreGate(cfg)).toBe(true);
  });

  it("falls back to defaults on invalid values", () => {
    const cfg = parseFitConfig({
      fit: { min_keywords: 0, min_score: 5, on_misfit: "explode", requires: "   " },
    })!;
    expect(cfg.minKeywords).toBe(1);
    expect(cfg.minScore).toBe(0.4);
    expect(cfg.onMisfit).toBe("warn");
    expect(cfg.requires).toBeNull();
    expect(hasPreGate(cfg)).toBe(false);
  });
});

// ── checkKeywords ────────────────────────────────────────────────────

describe("checkKeywords", () => {
  it("returns null when no keywords declared", () => {
    const cfg = parseFitConfig({ fit: { requires: "x" } })!;
    expect(checkKeywords("anything", cfg)).toBeNull();
  });

  it("passes when enough keywords match (case-insensitive)", () => {
    const cfg = parseFitConfig({ fit: { keywords: ["policy", "insured"], min_keywords: 2 } })!;
    const check = checkKeywords("This POLICY covers the INSURED party.", cfg)!;
    expect(check.ok).toBe(true);
    expect(check.detail.matched).toBe(2);
  });

  it("fails when too few match", () => {
    const cfg = parseFitConfig({ fit: { keywords: ["policy", "insured", "premium"], min_keywords: 2 } })!;
    const check = checkKeywords("This is an invoice for services.", cfg)!;
    expect(check.ok).toBe(false);
    expect(check.detail.matched).toBe(0);
  });
});

// ── checkDerived ─────────────────────────────────────────────────────

describe("checkDerived", () => {
  it("defaults anchors to the required fields", () => {
    const cfg = parseFitConfig({ fit: { min_score: 0.4 } })!;
    const check = checkDerived({ policy_number: 1.0, insured_name: 0.9, notes: 0.0 }, cfg, SCHEMA)!;
    expect(check.detail.anchor_fields).toEqual(["policy_number", "insured_name"]);
    expect(check.detail.anchors_total).toBe(2);
    expect(check.ok).toBe(true);
  });

  it("misfits when anchors are ungrounded", () => {
    const cfg = parseFitConfig({ fit: { min_score: 0.4 } })!;
    const check = checkDerived({ policy_number: 0.0, insured_name: 0.0 }, cfg, SCHEMA)!;
    expect(check.ok).toBe(false);
    expect(check.detail.score).toBe(0.0);
    expect(check.detail.anchors_found).toBe(0);
  });

  it("honors explicit anchor_fields", () => {
    const cfg = parseFitConfig({ fit: { anchor_fields: ["policy_number"], min_score: 0.5 } })!;
    const check = checkDerived({ policy_number: 0.9, insured_name: 0.0 }, cfg, SCHEMA)!;
    expect(check.detail.anchor_fields).toEqual(["policy_number"]);
    expect(check.ok).toBe(true);
  });

  it("treats missing scores as zero", () => {
    const cfg = parseFitConfig({ fit: { min_score: 0.4 } })!;
    const check = checkDerived({}, cfg, SCHEMA)!;
    expect(check.ok).toBe(false);
    expect(check.detail.score).toBe(0.0);
  });
});

// ── checkAssertion ───────────────────────────────────────────────────

describe("checkAssertion", () => {
  it("passes when the model says it matches", async () => {
    const cfg = parseFitConfig({ fit: { requires: "an insurance policy" } })!;
    const provider = mockProvider(JSON.stringify({ matches: true, reason: "looks like a policy" }));
    const check = (await checkAssertion("Policy declarations...", cfg, provider))!;
    expect(check.ok).toBe(true);
    expect(check.detail.reason).toBe("looks like a policy");
  });

  it("fails when the model says it does not match", async () => {
    const cfg = parseFitConfig({ fit: { requires: "an insurance policy" } })!;
    const provider = mockProvider(JSON.stringify({ matches: false, reason: "this is an invoice" }));
    const check = (await checkAssertion("Invoice #123...", cfg, provider))!;
    expect(check.ok).toBe(false);
  });

  it("fails open on garbage response", async () => {
    const cfg = parseFitConfig({ fit: { requires: "an insurance policy" } })!;
    const provider = mockProvider("not json at all");
    const check = (await checkAssertion("...", cfg, provider))!;
    expect(check.ok).toBe(true);
  });

  it("fails open when the provider throws", async () => {
    const cfg = parseFitConfig({ fit: { requires: "an insurance policy" } })!;
    const provider: ModelProvider = {
      generate: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const check = (await checkAssertion("...", cfg, provider))!;
    expect(check.ok).toBe(true);
    expect(check.detail.errored).toBe(true);
  });
});

describe("parseAssertionResponse", () => {
  it("extracts embedded JSON", () => {
    expect(parseAssertionResponse('here: {"matches": false, "reason": "x"}').matches).toBe(false);
  });
  it("fails open on missing matches key", () => {
    expect(parseAssertionResponse('{"foo": 1}').matches).toBe(true);
  });
});

// ── assembleFit ──────────────────────────────────────────────────────

describe("assembleFit", () => {
  it("ok when all checks pass", () => {
    const cfg = parseFitConfig({ fit: { keywords: ["x"] } })!;
    const report = assembleFit([checkKeywords("x y z", cfg)], cfg, "doc");
    expect(report.ok).toBe(true);
    expect(report.reason).toBeNull();
    expect(report.action).toBe("warn");
  });

  it("first failure drives the reason; derived score is surfaced", () => {
    const cfg = parseFitConfig({ fit: { keywords: ["zzz"], min_keywords: 1, min_score: 0.4 } })!;
    const kw = checkKeywords("no match here", cfg);
    const derived = checkDerived({ policy_number: 0.0, insured_name: 0.0 }, cfg, SCHEMA);
    const report = assembleFit([kw, derived], cfg, "insurance_policy");
    expect(report.ok).toBe(false);
    expect(report.reason).toBe("insufficient_keywords");
    expect(report.message).toBeTruthy();
    expect(report.score).toBe(0.0);
  });

  it("empty checks is ok", () => {
    const cfg = parseFitConfig({ fit: { keywords: ["x"] } })!;
    expect(assembleFit([null, null], cfg, "doc").ok).toBe(true);
  });
});

// ── Integration through intelligentExtract ───────────────────────────

const MD_MATCH = "# Insurance Policy\n\nPolicy Number: BOP-99\nInsured: Acme Corp\nThis policy covers the insured.";
const MD_WRONG = "# Invoice\n\nInvoice #555\nBill to: Someone\nThank you for your business.";

describe("fit integration", () => {
  it("warn misfit still extracts and flags", async () => {
    const provider = mockProvider(JSON.stringify({ policy_number: null, insured_name: null }));
    const schema = { ...SCHEMA, fit: { min_score: 0.4, on_misfit: "warn" } };
    const result = await intelligentExtract(MD_WRONG, schema, provider, "mock");
    expect(result.fit).toBeDefined();
    expect(result.fit!.ok).toBe(false);
    expect(result.fit!.reason).toBe("low_field_grounding");
    expect(result.fit!.extraction_skipped).toBe(false);
    expect(result.extracted).toBeDefined();
  });

  it("reject keyword gate skips extraction (no LLM call)", async () => {
    const provider = mockProvider(JSON.stringify({ policy_number: "X" }));
    const schema = {
      ...SCHEMA,
      fit: { keywords: ["policy", "insured", "premium"], min_keywords: 2, on_misfit: "reject" },
    };
    const result = await intelligentExtract(MD_WRONG, schema, provider, "mock");
    expect(result.fit!.ok).toBe(false);
    expect(result.fit!.extraction_skipped).toBe(true);
    expect(result.extracted.policy_number).toBeNull();
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("good document fits", async () => {
    const provider = mockProvider(JSON.stringify({ policy_number: "BOP-99", insured_name: "Acme Corp" }));
    const schema = { ...SCHEMA, fit: { keywords: ["policy", "insured"], min_keywords: 2, min_score: 0.4 } };
    const result = await intelligentExtract(MD_MATCH, schema, provider, "mock");
    expect(result.fit!.ok).toBe(true);
    expect(result.fit!.score).toBeGreaterThanOrEqual(0.4);
  });

  it("no fit block → no fit key", async () => {
    const provider = mockProvider(JSON.stringify({ policy_number: "BOP-99" }));
    const result = await intelligentExtract(MD_MATCH, SCHEMA, provider, "mock");
    expect(result.fit).toBeUndefined();
  });

  it("extractFields tolerates the rejected (skipped) result", async () => {
    const provider = mockProvider(JSON.stringify({ policy_number: "X" }));
    const schema = { ...SCHEMA, fit: { keywords: ["zzz"], min_keywords: 1, on_misfit: "reject" } };
    const result = await extractFields(MD_WRONG, schema, provider, "mock");
    expect(result.fit!.extraction_skipped).toBe(true);
    expect(result.normalization).toEqual({ applied: [], warnings: [] });
    expect(result.validation).toEqual({ ok: true, issues: [] });
  });
});
