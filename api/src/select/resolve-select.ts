/**
 * Resolve which `select` / `adjudicate` implementation a scope gets.
 *
 * The default is the OSS one, always. A tenant that configures nothing gets
 * LLM-choice over whatever chat model they already configured — which is the
 * design rule made operational: no configuration step stands between an OSS
 * install and a working selector.
 *
 * Resolution order for `select`:
 *
 *   1. An explicit strategy from the caller (a pipeline or schema will supply
 *      this in the selection stage — Track C).
 *   2. A `select`-capability model the tenant configured, whose credential
 *      provider names the implementation (`typesafe` -> jev, `laya` -> laya).
 *   3. `KOJI_SELECT_PROVIDER` — an operator-level default for a self-hosted
 *      install, naming *which implementation*, never a credential.
 *   4. LLM-choice over the tenant's chat model.
 *
 * Credentials come out of the credential store, decrypted per call, exactly
 * like every other model key. Nothing here reads an API key out of the
 * environment on the hosted path: users configure their own keys, and the
 * env-var fallbacks exist for local development and CI.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Db, RlsScope } from "@koji/db";
import { resolveExtractEndpoint, resolveTenantProvider } from "../extract/resolve-endpoint";
import { NoAdjudicateProvider } from "./adjudicate";
import { JevAdjudicateProvider, JevSelectProvider, typesafeKeyFromEnv } from "./jev";
import { LayaAdjudicateProvider, LayaSelectProvider } from "./laya";
import { LlmAdjudicateProvider, LlmChoiceSelectProvider } from "./llm-choice";
import { HumanQueueReviewProvider, AgentReviewProvider } from "./review";
import {
  SelectUnavailableError,
  type AdjudicateProvider,
  type ReviewItem,
  type ReviewProvider,
  type SelectProvider,
} from "./types";

/** The implementations a tenant can be routed to. */
export type SelectStrategy = "llm-choice" | "laya" | "jev";

export const SELECT_STRATEGIES: readonly SelectStrategy[] = ["llm-choice", "laya", "jev"];

/** The capability tag a `tenant_models` row carries to be a selector. */
export const SELECT_CAPABILITY = "select";

/**
 * Credential provider -> implementation. A credential whose provider isn't a
 * dedicated selection service (an ordinary OpenAI or Anthropic key tagged
 * `select`) resolves to LLM-choice, which is the right answer: that *is* how
 * you select with a chat key.
 */
const PROVIDER_STRATEGY: Readonly<Record<string, SelectStrategy>> = {
  typesafe: "jev",
  jev: "jev",
  laya: "laya",
};

export function strategyForProvider(provider: string): SelectStrategy {
  return PROVIDER_STRATEGY[provider.toLowerCase()] ?? "llm-choice";
}

/** Parse `KOJI_SELECT_PROVIDER`, ignoring an unrecognized value rather than failing boot. */
export function strategyFromEnv(): SelectStrategy | null {
  const raw = process.env.KOJI_SELECT_PROVIDER?.trim().toLowerCase();
  if (!raw) return null;
  if ((SELECT_STRATEGIES as readonly string[]).includes(raw)) return raw as SelectStrategy;
  console.warn(
    `[koji-select] ignoring KOJI_SELECT_PROVIDER=${JSON.stringify(raw)} — ` +
      `expected one of ${SELECT_STRATEGIES.join(", ")}`,
  );
  return null;
}

export interface SelectEndpointRow {
  /** `tenant_models.id`, for `resolveExtractEndpoint`. */
  id: string;
  /** The credential's provider, which names the implementation. */
  provider: string;
  model: string;
}

/**
 * The tenant's configured selector model, or null.
 *
 * Every read goes through `withRLS` with the caller's scope, so a row belonging
 * to another tenant is unreachable regardless of what this query asks for —
 * that is asserted against a real Postgres in
 * `resolve-select.isolation.test.ts`.
 *
 * This is deliberately a separate query from `pickActiveTenantModel` rather
 * than a flag on it: it filters on the `select` capability and returns the
 * credential's provider, which is the field that decides the implementation.
 * It keeps that function's soft-delete and override discipline — deleted rows
 * excluded on both sides of the join, project-scoped credentials ahead of
 * workspace-shared ones, oldest first within a scope.
 */
export async function pickSelectEndpoint(
  db: Db,
  scope: RlsScope,
): Promise<SelectEndpointRow | null> {
  const rows = await withRLS(db, scope, (tx) =>
    tx
      .select({
        id: schema.tenantModels.id,
        provider: schema.providerCredentials.provider,
        model: schema.tenantModels.model,
      })
      .from(schema.tenantModels)
      .innerJoin(
        schema.providerCredentials,
        eq(schema.providerCredentials.id, schema.tenantModels.credentialId),
      )
      .where(
        and(
          eq(schema.tenantModels.capability, SELECT_CAPABILITY),
          eq(schema.tenantModels.status, "active"),
          eq(schema.providerCredentials.status, "active"),
          isNull(schema.tenantModels.deletedAt),
          isNull(schema.providerCredentials.deletedAt),
        ),
      )
      .orderBy(
        sql`${schema.providerCredentials.projectId} IS NULL`,
        schema.tenantModels.createdAt,
        schema.tenantModels.id,
      ),
  );
  return rows[0] ?? null;
}

export interface ResolveSelectOptions {
  /** Force an implementation (a pipeline or schema decision). */
  strategy?: SelectStrategy | null;
  /** Use a specific `tenant_models` row for the underlying chat model. */
  modelProviderId?: string | null;
  /** Prefer a chat model by name, for the LLM-choice path. */
  preferModel?: string | null;
}

export interface ResolvedSelectProvider {
  provider: SelectProvider;
  strategy: SelectStrategy;
  /** The model behind it, for the trace. Empty for a local model with no id. */
  model: string;
}

/**
 * The entry point callers use. Returns a ready selector, or throws
 * `SelectUnavailableError` when an explicitly requested implementation cannot
 * run here — never a silent downgrade, because a caller that asked for a
 * calibrated selector and quietly got an uncalibrated one would read its
 * confidence numbers as something they are not.
 */
export async function resolveSelectProvider(
  db: Db,
  scope: RlsScope,
  opts: ResolveSelectOptions = {},
): Promise<ResolvedSelectProvider> {
  const configured = opts.strategy ? null : await pickSelectEndpointSafely(db, scope);
  const strategy: SelectStrategy =
    opts.strategy ??
    (configured ? strategyForProvider(configured.provider) : null) ??
    strategyFromEnv() ??
    "llm-choice";

  switch (strategy) {
    case "jev": {
      const apiKey = await resolveTypesafeKey(db, scope, configured);
      return {
        provider: new JevSelectProvider({ apiKey, model: configured?.model }),
        strategy,
        model: configured?.model ?? "jev-latest",
      };
    }
    case "laya": {
      const provider = await LayaSelectProvider.create({});
      return { provider, strategy, model: configured?.model ?? "laya" };
    }
    case "llm-choice": {
      const { provider, model } = await resolveTenantProvider(db, scope, {
        ...(opts.modelProviderId !== undefined ? { modelProviderId: opts.modelProviderId } : {}),
        ...(opts.preferModel !== undefined ? { preferModel: opts.preferModel } : {}),
      });
      return { provider: new LlmChoiceSelectProvider(provider), strategy, model };
    }
  }
}

/**
 * A configured-selector lookup must never be the reason selection fails: a
 * transient DB error here should fall through to the default, not take down a
 * capability that works without any configuration at all.
 */
async function pickSelectEndpointSafely(
  db: Db,
  scope: RlsScope,
): Promise<SelectEndpointRow | null> {
  try {
    return await pickSelectEndpoint(db, scope);
  } catch (err) {
    console.warn(
      "[koji-select] could not read the configured selector; falling back to the default —",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * The tenant's TypeSafe key, decrypted. Falls back to the environment only
 * when nothing is configured — local development and CI, as with every other
 * provider's env fallback.
 */
async function resolveTypesafeKey(
  db: Db,
  scope: RlsScope,
  configured: SelectEndpointRow | null,
): Promise<string> {
  if (configured) {
    const payload = await resolveExtractEndpoint(db, scope, configured.id);
    if (payload?.api_key) return payload.api_key;
  }
  const fromEnv = typesafeKeyFromEnv();
  if (fromEnv) return fromEnv;
  throw new SelectUnavailableError(
    "jev",
    "no TypeSafe credential is configured for this project. Add one under " +
      'Settings → Model Catalog (provider "typesafe", capability "select"), or use the ' +
      "default BYO-key selector, which needs no extra credential.",
  );
}

// ---------------------------------------------------------------------------
// adjudicate
// ---------------------------------------------------------------------------

export type AdjudicateStrategy = "none" | "llm" | "laya" | "jev";

export const ADJUDICATE_STRATEGIES: readonly AdjudicateStrategy[] = ["none", "llm", "laya", "jev"];

/**
 * `KOJI_ADJUDICATE_PROVIDER` picks the judge. Default `none`: a scorer
 * disagreement stands as a disagreement unless someone opted into a judge.
 *
 * Adjudication is offline-only — the guard in `./adjudicate` throws if this is
 * ever reached from the request path — so the env var is the right knob here.
 * It names an implementation, and the credential still comes from the store.
 */
export function adjudicateStrategyFromEnv(): AdjudicateStrategy {
  const raw = process.env.KOJI_ADJUDICATE_PROVIDER?.trim().toLowerCase();
  if (!raw) return "none";
  if ((ADJUDICATE_STRATEGIES as readonly string[]).includes(raw)) {
    return raw as AdjudicateStrategy;
  }
  console.warn(
    `[koji-select] ignoring KOJI_ADJUDICATE_PROVIDER=${JSON.stringify(raw)} — ` +
      `expected one of ${ADJUDICATE_STRATEGIES.join(", ")}`,
  );
  return "none";
}

export async function resolveAdjudicateProvider(
  db: Db,
  scope: RlsScope,
  opts: { strategy?: AdjudicateStrategy | null } = {},
): Promise<{ provider: AdjudicateProvider; strategy: AdjudicateStrategy }> {
  const strategy = opts.strategy ?? adjudicateStrategyFromEnv();
  switch (strategy) {
    case "none":
      return { provider: new NoAdjudicateProvider(), strategy };
    case "jev": {
      const configured = await pickSelectEndpointSafely(db, scope);
      const apiKey = await resolveTypesafeKey(db, scope, configured);
      return {
        provider: new JevAdjudicateProvider({ apiKey, model: configured?.model }),
        strategy,
      };
    }
    case "laya":
      return { provider: await LayaAdjudicateProvider.create({}), strategy };
    case "llm": {
      const { provider } = await resolveTenantProvider(db, scope);
      return { provider: new LlmAdjudicateProvider(provider), strategy };
    }
  }
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

export type ReviewStrategy = "human" | "agent";

/**
 * The review tier. `human` is the default and needs nothing configured;
 * `agent` first-passes the queue with the tenant's resolved selector, so it
 * inherits whichever `select` implementation they are on.
 */
export async function resolveReviewProvider(
  db: Db,
  scope: RlsScope,
  opts: {
    strategy?: ReviewStrategy | null;
    enqueue?: (items: readonly ReviewItem[]) => Promise<void> | void;
    minConfidence?: number;
  } = {},
): Promise<{ provider: ReviewProvider; strategy: ReviewStrategy }> {
  const strategy = opts.strategy ?? "human";
  if (strategy === "agent") {
    const { provider } = await resolveSelectProvider(db, scope);
    return {
      provider: new AgentReviewProvider({
        select: provider,
        ...(opts.minConfidence !== undefined ? { minConfidence: opts.minConfidence } : {}),
      }),
      strategy,
    };
  }
  return {
    provider: new HumanQueueReviewProvider({
      ...(opts.enqueue !== undefined ? { enqueue: opts.enqueue } : {}),
    }),
    strategy,
  };
}
