import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocked before importing the module under test so `run-named` picks up the fakes.
vi.mock("./cascade", () => ({ runCascade: vi.fn() }));
vi.mock("../extract/resolve-endpoint", () => ({ resolveTenantProvider: vi.fn() }));

import { classifyWithConfig, ClassifyProviderError } from "./run-named";
import { runCascade } from "./cascade";
import { normalizeConfig } from "./config";
import { resolveTenantProvider } from "../extract/resolve-endpoint";
import { Tier, type ClassifyOutcome } from "./types";

const db = {} as never;
const scope = { tenantId: "t", projectId: null };
const input = { filename: "doc.pdf", mimeType: "application/pdf", fileBuffer: Buffer.from("x") };

/** A config whose ceiling admits the LLM tier but not vision. */
const llmConfig = normalizeConfig({
  max_tier: Tier.LLM,
  classes: [{ id: "invoice", keywords: ["invoice"] }, { id: "receipt", keywords: ["receipt"] }],
});

/** Same, but the ceiling admits vision — reachable even with no text layer. */
const visionConfig = normalizeConfig({
  max_tier: Tier.VISION,
  classes: [{ id: "invoice", keywords: ["invoice"] }, { id: "receipt", keywords: ["receipt"] }],
});

function outcome(over: Partial<ClassifyOutcome>): ClassifyOutcome {
  return { label: "unknown", confidence: 0, method: "unknown", tierUsed: Tier.TEXT, evidencePage: null, ...over };
}

const providerFails = () =>
  vi.mocked(resolveTenantProvider).mockRejectedValue(new Error("no active model endpoint"));

beforeEach(() => vi.resetAllMocks());

describe("classifyWithConfig — provider outage vs honest unknown", () => {
  it("throws when the LLM tier was reachable but the provider was not", async () => {
    providerFails();
    // tierUsed === KEYWORD means the doc had a text layer, so the LLM tier was
    // next and got skipped purely for want of a provider.
    vi.mocked(runCascade).mockResolvedValue(outcome({ tierUsed: Tier.KEYWORD }));

    await expect(classifyWithConfig(db, scope, input, llmConfig)).rejects.toBeInstanceOf(
      ClassifyProviderError,
    );
    await expect(classifyWithConfig(db, scope, input, llmConfig)).rejects.toThrow(
      /no active model endpoint/,
    );
  });

  it("throws when the vision tier was reachable but the provider was not", async () => {
    providerFails();
    // No text layer (tierUsed stalls at TEXT), but vision needs no text — only
    // a provider and rendered pages. So the provider is still the cause.
    vi.mocked(runCascade).mockResolvedValue(outcome({ tierUsed: Tier.TEXT }));
    const parseProvider = { pageImages: vi.fn() } as never;

    await expect(classifyWithConfig(db, scope, input, visionConfig, parseProvider)).rejects.toBeInstanceOf(
      ClassifyProviderError,
    );
  });

  it("returns the keyword label when the provider is down but a cheap tier decided", async () => {
    providerFails();
    // The keyword tier short-circuits before the LLM tier ever runs. A tenant
    // with no model endpoint must still classify deterministically.
    vi.mocked(runCascade).mockResolvedValue(
      outcome({ label: "invoice", confidence: 1, method: "keyword", tierUsed: Tier.KEYWORD }),
    );

    const result = await classifyWithConfig(db, scope, input, llmConfig);
    expect(result.label).toBe("invoice");
    expect(result.method).toBe("keyword");
  });

  it("returns an honest unknown when no provider-backed tier could have run", async () => {
    providerFails();
    // No text layer and no vision ceiling: the LLM tier is gated on text, so a
    // provider would not have changed the answer. `unknown` is the truth.
    vi.mocked(runCascade).mockResolvedValue(outcome({ tierUsed: Tier.TEXT }));

    const result = await classifyWithConfig(db, scope, input, llmConfig);
    expect(result.label).toBe("unknown");
    expect(result.method).toBe("unknown");
  });

  it("does not throw on a genuine unknown when the provider resolved fine", async () => {
    vi.mocked(resolveTenantProvider).mockResolvedValue({ provider: {}, model: "gpt-4o-mini" } as never);
    vi.mocked(runCascade).mockResolvedValue(outcome({ tierUsed: Tier.LLM }));

    const result = await classifyWithConfig(db, scope, input, llmConfig);
    expect(result.label).toBe("unknown");
  });
});
