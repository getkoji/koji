/**
 * Endpoint health tracking — wraps a ModelProvider so every LLM call
 * records success or failure against the credential, transitions it
 * between healthy and unhealthy state, and emits endpoint.unhealthy /
 * endpoint.recovered events on the transition.
 *
 * Health is a property of the credential (key + base_url + provider),
 * not the model — a 401 on one model means every model on the same
 * credential will 401 too. Callers pass a `tenant_models.id`; we look
 * up the credential it belongs to and record health there.
 *
 * Threshold: UNHEALTHY_THRESHOLD consecutive failures move the credential
 * from 'healthy' to 'unhealthy' (default 3). Any single success moves it
 * back. Both transitions emit a webhook + in-app notification so
 * consumers can react in either direction.
 *
 * State writes go through the system DB connection (no RLS context).
 * The row's tenant_id is read from the existing row, not passed in by
 * callers, so a bad caller can't redirect a write to the wrong tenant.
 */

import { eq } from "drizzle-orm";

import type { Db } from "@koji/db";
import { schema } from "@koji/db";

import { createNotification } from "../notifications/emit";
import { emitWebhookEvent } from "../webhooks/emit";
import type { ModelProvider } from "./providers";

/** Failures in a row before health_state flips to 'unhealthy'. */
export const UNHEALTHY_THRESHOLD = 3;

/** Maximum length we'll store for a failure reason (DB column is text). */
const MAX_REASON_LEN = 1024;

interface HealthRow {
  id: string;
  credentialId: string;
  tenantId: string;
  projectId: string;
  slug: string;
  consecutiveFailures: number;
  healthState: string;
}

async function transitionAndEmit(
  db: Db,
  endpointId: string,
  outcome: "success" | "failure",
  reason?: string,
): Promise<void> {
  // endpointId is a tenant_models.id. Health lives on the credential —
  // join through and update there. Two-step: read current state, decide
  // transition, write the new row. The decision is made in app code so
  // the state machine is explicit and testable without writing SQL
  // fixtures.
  const [row] = await db
    .select({
      id: schema.tenantModels.id,
      credentialId: schema.providerCredentials.id,
      tenantId: schema.providerCredentials.tenantId,
      projectId: schema.providerCredentials.projectId,
      slug: schema.providerCredentials.slug,
      consecutiveFailures: schema.providerCredentials.consecutiveFailures,
      healthState: schema.providerCredentials.healthState,
    })
    .from(schema.tenantModels)
    .innerJoin(
      schema.providerCredentials,
      eq(schema.providerCredentials.id, schema.tenantModels.credentialId),
    )
    .where(eq(schema.tenantModels.id, endpointId))
    .limit(1);
  if (!row) return; // endpoint deleted between resolve and call — drop silently

  const r: HealthRow = row as HealthRow;
  const now = new Date();

  if (outcome === "success") {
    const nextState = r.healthState === "unhealthy" ? "healthy" : r.healthState;
    await db
      .update(schema.providerCredentials)
      .set({
        consecutiveFailures: 0,
        lastSuccessAt: now,
        healthState: nextState,
        updatedAt: now,
      })
      .where(eq(schema.providerCredentials.id, r.credentialId));

    if (r.healthState === "unhealthy") {
      // Transition: unhealthy → healthy
      await emitEvent(r, "endpoint.recovered", {
        endpoint_id: r.id,
        credential_id: r.credentialId,
        slug: r.slug,
        previous_consecutive_failures: r.consecutiveFailures,
      });
    }
    return;
  }

  // failure
  const nextFailures = r.consecutiveFailures + 1;
  const reasonShort = (reason ?? "unknown error").slice(0, MAX_REASON_LEN);
  const nextState =
    r.healthState === "healthy" && nextFailures >= UNHEALTHY_THRESHOLD
      ? "unhealthy"
      : r.healthState;

  await db
    .update(schema.providerCredentials)
    .set({
      consecutiveFailures: nextFailures,
      lastFailureAt: now,
      lastFailureReason: reasonShort,
      healthState: nextState,
      updatedAt: now,
    })
    .where(eq(schema.providerCredentials.id, r.credentialId));

  if (nextState === "unhealthy" && r.healthState === "healthy") {
    // Transition: healthy → unhealthy
    await emitEvent(r, "endpoint.unhealthy", {
      endpoint_id: r.id,
      credential_id: r.credentialId,
      slug: r.slug,
      consecutive_failures: nextFailures,
      reason: reasonShort,
    });
  }
}

async function emitEvent(
  r: HealthRow,
  type: "endpoint.unhealthy" | "endpoint.recovered",
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await emitWebhookEvent({ tenantId: r.tenantId, projectId: r.projectId }, type, data);
  } catch (err) {
    console.warn(
      `[endpoint-health] webhook emit failed for ${type} on ${r.id}:`,
      err instanceof Error ? err.message : err,
    );
  }
  const title =
    type === "endpoint.unhealthy"
      ? `Endpoint unhealthy: ${r.slug}`
      : `Endpoint recovered: ${r.slug}`;
  const body =
    type === "endpoint.unhealthy"
      ? `${(data.consecutive_failures as number) ?? UNHEALTHY_THRESHOLD} consecutive failures. Last error: ${data.reason ?? "unknown"}`
      : `Endpoint is responding again after a string of failures.`;
  createNotification(r.tenantId, { type, title, body, data });
}

/**
 * Wrap a ModelProvider so each call records health to the named endpoint.
 * If endpointId is null/undefined (env-var fallback path), returns the
 * provider unwrapped — health tracking only applies to user-configured
 * endpoints we can write back to.
 */
export function wrapProviderWithHealthTracking(
  provider: ModelProvider,
  db: Db,
  endpointId: string | null | undefined,
): ModelProvider {
  if (!endpointId) return provider;

  return {
    async generate(prompt: string, jsonMode?: boolean): Promise<string> {
      try {
        const out = await provider.generate(prompt, jsonMode);
        // Don't let a tracking failure ever bubble up — the call itself
        // succeeded and that's what the caller cares about.
        transitionAndEmit(db, endpointId, "success").catch((e) => {
          console.warn(`[endpoint-health] success record failed for ${endpointId}:`, e);
        });
        return out;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        transitionAndEmit(db, endpointId, "failure", msg).catch((e) => {
          console.warn(`[endpoint-health] failure record failed for ${endpointId}:`, e);
        });
        throw err;
      }
    },
    generateWithImage: provider.generateWithImage
      ? async (prompt: string, imageBase64: string, jsonMode?: boolean) => {
          try {
            const out = await provider.generateWithImage!(prompt, imageBase64, jsonMode);
            transitionAndEmit(db, endpointId, "success").catch((e) => {
              console.warn(`[endpoint-health] success record failed for ${endpointId}:`, e);
            });
            return out;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            transitionAndEmit(db, endpointId, "failure", msg).catch((e) => {
              console.warn(`[endpoint-health] failure record failed for ${endpointId}:`, e);
            });
            throw err;
          }
        }
      : undefined,
  };
}

// Exported for tests; the wrapper above is what production code uses.
export { transitionAndEmit as _transitionAndEmit };
