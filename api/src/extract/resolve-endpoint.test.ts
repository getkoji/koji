/**
 * resolveTenantProvider fallback-guard tests (oss-394).
 *
 * When a scope resolves no configured model endpoint, the only thing left is
 * the env-var fallback. If no env credential is present either (a fresh
 * project that hasn't configured a model provider), resolution must throw an
 * actionable error rather than build a keyless provider that 401s upstream.
 *
 * @koji/db, drizzle-orm, the provider factory, and health tracking are mocked
 * so this is a pure unit test of the resolution control flow.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock drizzle-orm condition builders ──────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  and: (...conds: unknown[]) => ({ op: "and", conds }),
}));

// ── Mock @koji/db: withRLS runs the callback against a fake query tx that
// resolves to an empty result set (no active tenant model). ──────────────────
const tx: any = {
  select: () => tx,
  from: () => tx,
  innerJoin: () => tx,
  where: () => Promise.resolve([]),
  limit: () => Promise.resolve([]),
};
vi.mock("@koji/db", () => ({
  withRLS: (_db: unknown, _scope: unknown, fn: (t: typeof tx) => unknown) => fn(tx),
  schema: {
    tenantModels: { id: "id", model: "model", credentialId: "credentialId", status: "status" },
    providerCredentials: { id: "id", provider: "provider", status: "status" },
  },
}));

// ── Mock the provider factory + health wrapper so no real provider is built ──
const fakeProvider = { generate: vi.fn() };
vi.mock("./providers", () => ({
  createProvider: vi.fn(() => fakeProvider),
}));
vi.mock("./endpoint-health", () => ({
  wrapProviderWithHealthTracking: (p: unknown) => p,
}));
vi.mock("../crypto/envelope", () => ({
  decrypt: vi.fn(() => "decrypted"),
  getMasterKey: vi.fn(() => "master-key"),
}));

import { resolveTenantProvider } from "./resolve-endpoint";

describe("resolveTenantProvider — no configured endpoint", () => {
  const savedOpenai = process.env.OPENAI_API_KEY;
  const savedAnthropic = process.env.ANTHROPIC_API_KEY;
  const savedModel = process.env.KOJI_EXTRACT_MODEL;

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.KOJI_EXTRACT_MODEL;
  });
  afterEach(() => {
    process.env.OPENAI_API_KEY = savedOpenai;
    process.env.ANTHROPIC_API_KEY = savedAnthropic;
    process.env.KOJI_EXTRACT_MODEL = savedModel;
  });

  it("throws an actionable error when neither an endpoint nor an env key is available", async () => {
    await expect(
      resolveTenantProvider({} as any, { tenantId: "t_1", projectId: "p_fresh" }),
    ).rejects.toThrow(/No model provider is configured for this project/);
  });

  it("still falls back to the env-var default when OPENAI_API_KEY is set (local dev / seed)", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const { provider, model } = await resolveTenantProvider({} as any, {
      tenantId: "t_1",
      projectId: "p_fresh",
    });
    expect(model).toBe("gpt-4o-mini");
    expect(provider).toBe(fakeProvider);
  });
});
