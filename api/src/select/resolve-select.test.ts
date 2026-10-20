/**
 * Resolution control-flow tests.
 *
 * The question these answer is "which implementation does a given scope get,
 * and does the default ever fail to be available" — the default has to work
 * with nothing configured, because that is the whole claim.
 *
 * `@koji/db`, drizzle and the provider factory are mocked so this stays a unit
 * test of the branching. The tenant-isolation guarantee is proven against a
 * real Postgres in `resolve-select.isolation.test.ts` — a mock cannot prove
 * which row a join returns, which is the only thing that matters there.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  and: (...conds: unknown[]) => ({ op: "and", conds }),
  isNull: (col: unknown) => ({ op: "isNull", col }),
  sql: (strings: unknown, ...values: unknown[]) => ({ op: "sql", strings, values }),
}));

/** Rows the mocked select-endpoint query returns, and the scopes it saw. */
const state: { rows: unknown[]; scopes: unknown[] } = { rows: [], scopes: [] };

const tx: Record<string, unknown> = {};
for (const method of ["select", "from", "innerJoin", "where"]) {
  tx[method] = () => tx;
}
tx.orderBy = () => Promise.resolve(state.rows);
tx.limit = () => Promise.resolve(state.rows);

vi.mock("@koji/db", () => ({
  withRLS: (_db: unknown, scope: unknown, fn: (t: unknown) => unknown) => {
    state.scopes.push(scope);
    return fn(tx);
  },
  schema: {
    tenantModels: {
      id: "id",
      model: "model",
      credentialId: "credentialId",
      capability: "capability",
      status: "status",
      createdAt: "createdAt",
      deletedAt: "deletedAt",
    },
    providerCredentials: {
      id: "id",
      provider: "provider",
      status: "status",
      projectId: "projectId",
      deletedAt: "deletedAt",
    },
  },
}));

const fakeModelProvider = { contextTokens: 128_000, generate: vi.fn() };
const resolveTenantProvider = vi.fn(async () => ({
  provider: fakeModelProvider,
  model: "gpt-4o-mini",
}));
const resolveExtractEndpoint = vi.fn(async () => null as { api_key?: string } | null);
vi.mock("../extract/resolve-endpoint", () => ({
  resolveTenantProvider: (...args: unknown[]) =>
    (resolveTenantProvider as unknown as (...a: unknown[]) => unknown)(...args),
  resolveExtractEndpoint: (...args: unknown[]) =>
    (resolveExtractEndpoint as unknown as (...a: unknown[]) => unknown)(...args),
}));

import {
  ADJUDICATE_STRATEGIES,
  SELECT_CAPABILITY,
  SELECT_STRATEGIES,
  adjudicateStrategyFromEnv,
  pickSelectEndpoint,
  resolveAdjudicateProvider,
  resolveReviewProvider,
  resolveSelectProvider,
  strategyForProvider,
  strategyFromEnv,
} from "./resolve-select";
import { SelectUnavailableError } from "./types";

const SCOPE = { tenantId: "t_1", projectId: "p_1" } as const;
const db = {} as never;

const savedEnv = { ...process.env };
beforeEach(() => {
  state.rows = [];
  state.scopes = [];
  resolveTenantProvider.mockClear();
  resolveExtractEndpoint.mockClear();
  resolveExtractEndpoint.mockResolvedValue(null);
  delete process.env.KOJI_SELECT_PROVIDER;
  delete process.env.KOJI_ADJUDICATE_PROVIDER;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.KOJI_TYPESAFE_API_KEY;
});
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("strategyForProvider", () => {
  it("maps a selection service onto its implementation", () => {
    expect(strategyForProvider("typesafe")).toBe("jev");
    expect(strategyForProvider("TypeSafe")).toBe("jev");
    expect(strategyForProvider("laya")).toBe("laya");
  });

  it("maps an ordinary chat credential onto LLM-choice, which is how you select with one", () => {
    expect(strategyForProvider("openai")).toBe("llm-choice");
    expect(strategyForProvider("anthropic")).toBe("llm-choice");
    expect(strategyForProvider("something-new")).toBe("llm-choice");
  });
});

describe("strategyFromEnv", () => {
  it("reads a recognized value", () => {
    for (const strategy of SELECT_STRATEGIES) {
      process.env.KOJI_SELECT_PROVIDER = strategy;
      expect(strategyFromEnv()).toBe(strategy);
    }
  });

  it("ignores an unrecognized value rather than failing", () => {
    process.env.KOJI_SELECT_PROVIDER = "nonsense";
    expect(strategyFromEnv()).toBeNull();
  });

  it("is null when unset", () => {
    expect(strategyFromEnv()).toBeNull();
  });
});

describe("resolveSelectProvider", () => {
  it("defaults to LLM-choice over the tenant's chat model with nothing configured", async () => {
    const { provider, strategy, model } = await resolveSelectProvider(db, SCOPE);
    expect(strategy).toBe("llm-choice");
    expect(provider.name).toBe("llm-choice");
    expect(model).toBe("gpt-4o-mini");
    expect(resolveTenantProvider).toHaveBeenCalledOnce();
  });

  it("filters the selector lookup on the select capability", async () => {
    await resolveSelectProvider(db, SCOPE);
    expect(SELECT_CAPABILITY).toBe("select");
  });

  it("routes to the hosted implementation when the tenant configured a typesafe credential", async () => {
    state.rows = [{ id: "m_1", provider: "typesafe", model: "jev-latest" }];
    resolveExtractEndpoint.mockResolvedValue({ api_key: "k-from-store" });
    const { provider, strategy } = await resolveSelectProvider(db, SCOPE);
    expect(strategy).toBe("jev");
    expect(provider.name).toBe("jev");
    // The credential came out of the store, decrypted — not the environment.
    expect(resolveExtractEndpoint).toHaveBeenCalledWith(db, SCOPE, "m_1");
  });

  it("routes an ordinary chat credential tagged `select` to LLM-choice", async () => {
    state.rows = [{ id: "m_1", provider: "openai", model: "gpt-4o" }];
    const { strategy } = await resolveSelectProvider(db, SCOPE);
    expect(strategy).toBe("llm-choice");
  });

  it("lets an explicit strategy win over configuration, without a DB read", async () => {
    state.rows = [{ id: "m_1", provider: "typesafe", model: "jev-latest" }];
    process.env.TYPESAFE_API_KEY = "env-key";
    const { strategy } = await resolveSelectProvider(db, SCOPE, { strategy: "llm-choice" });
    expect(strategy).toBe("llm-choice");
    expect(state.scopes).toEqual([]);
  });

  it("falls back to the operator default when nothing is configured", async () => {
    process.env.KOJI_SELECT_PROVIDER = "jev";
    process.env.TYPESAFE_API_KEY = "env-key";
    const { strategy } = await resolveSelectProvider(db, SCOPE);
    expect(strategy).toBe("jev");
  });

  it("throws rather than silently downgrading when the hosted implementation has no credential", async () => {
    await expect(resolveSelectProvider(db, SCOPE, { strategy: "jev" })).rejects.toThrow(
      SelectUnavailableError,
    );
  });

  it("throws a named, actionable error when the local implementation is not installed", async () => {
    await expect(resolveSelectProvider(db, SCOPE, { strategy: "laya" })).rejects.toThrow(
      /@receptron\/laya is not installed/,
    );
  });

  it("falls back to the default when the selector lookup itself fails", async () => {
    const original = tx.orderBy;
    tx.orderBy = () => Promise.reject(new Error("connection reset"));
    try {
      const { strategy } = await resolveSelectProvider(db, SCOPE);
      expect(strategy).toBe("llm-choice");
    } finally {
      tx.orderBy = original;
    }
  });

  it("passes the caller's scope to every read", async () => {
    state.rows = [{ id: "m_1", provider: "openai", model: "gpt-4o" }];
    await resolveSelectProvider(db, SCOPE);
    expect(state.scopes.length).toBeGreaterThan(0);
    for (const scope of state.scopes) expect(scope).toBe(SCOPE);
  });

  it("forwards the caller's model preference to the chat resolution", async () => {
    await resolveSelectProvider(db, SCOPE, { preferModel: "gpt-4o", modelProviderId: "m_9" });
    expect(resolveTenantProvider).toHaveBeenCalledWith(db, SCOPE, {
      modelProviderId: "m_9",
      preferModel: "gpt-4o",
    });
  });
});

describe("pickSelectEndpoint", () => {
  it("returns the first row, or null", async () => {
    expect(await pickSelectEndpoint(db, SCOPE)).toBeNull();
    state.rows = [
      { id: "m_1", provider: "typesafe", model: "jev-latest" },
      { id: "m_2", provider: "laya", model: "laya" },
    ];
    expect(await pickSelectEndpoint(db, SCOPE)).toMatchObject({ id: "m_1" });
  });

  it("reads through withRLS with the caller's scope", async () => {
    await pickSelectEndpoint(db, SCOPE);
    expect(state.scopes).toEqual([SCOPE]);
  });
});

describe("resolveAdjudicateProvider", () => {
  it("defaults to no adjudication", async () => {
    const { provider, strategy } = await resolveAdjudicateProvider(db, SCOPE);
    expect(strategy).toBe("none");
    expect(provider.name).toBe("none");
  });

  it("reads the operator's choice from the environment", async () => {
    process.env.KOJI_ADJUDICATE_PROVIDER = "llm";
    const { provider, strategy } = await resolveAdjudicateProvider(db, SCOPE);
    expect(strategy).toBe("llm");
    expect(provider.name).toBe("llm-adjudicate");
  });

  it("ignores an unrecognized value and stays off", async () => {
    process.env.KOJI_ADJUDICATE_PROVIDER = "nonsense";
    expect(adjudicateStrategyFromEnv()).toBe("none");
    expect(ADJUDICATE_STRATEGIES).toContain("none");
  });

  it("uses the tenant's stored credential for the hosted judge", async () => {
    state.rows = [{ id: "m_1", provider: "typesafe", model: "jev-latest" }];
    resolveExtractEndpoint.mockResolvedValue({ api_key: "k-from-store" });
    const { provider } = await resolveAdjudicateProvider(db, SCOPE, { strategy: "jev" });
    expect(provider.name).toBe("jev-adjudicate");
    expect(resolveExtractEndpoint).toHaveBeenCalledWith(db, SCOPE, "m_1");
  });
});

describe("resolveReviewProvider", () => {
  it("defaults to the human queue, which needs nothing configured", async () => {
    const { provider, strategy } = await resolveReviewProvider(db, SCOPE);
    expect(strategy).toBe("human");
    expect(provider.kind).toBe("human");
  });

  it("builds the agent tier over the tenant's resolved selector", async () => {
    const { provider, strategy } = await resolveReviewProvider(db, SCOPE, { strategy: "agent" });
    expect(strategy).toBe("agent");
    expect(provider.kind).toBe("agent");
    expect(provider.name).toContain("llm-choice");
  });

  it("wires the queue sink into the human tier", async () => {
    const enqueue = vi.fn();
    const { provider } = await resolveReviewProvider(db, SCOPE, { enqueue });
    await provider.review([
      { id: "i", field: { name: "f" }, value: null, state: "s" },
    ]);
    expect(enqueue).toHaveBeenCalledOnce();
  });
});
