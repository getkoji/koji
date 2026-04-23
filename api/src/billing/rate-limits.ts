/**
 * Plan-aware rate limiter for upload/ingestion endpoints.
 *
 * Extends the existing createRateLimiter pattern with per-plan tiers.
 * Keyed by tenantId (not IP) since plan limits are per-tenant.
 */

import type { Context, Next } from "hono";
import type { Env } from "../env";
import type { PlanId } from "./adapter";
import { PLANS } from "./plans";

interface PlanRateLimits {
  uploadsPerMinute: number;
}

const RATE_LIMITS: Record<PlanId, PlanRateLimits> = {
  free: { uploadsPerMinute: 10 },
  scale: { uploadsPerMinute: 60 },
  enterprise: { uploadsPerMinute: 200 },
};

function limitsForPlan(plan: string): PlanRateLimits {
  return RATE_LIMITS[plan as PlanId] ?? RATE_LIMITS.free;
}

interface WindowEntry {
  timestamps: number[];
}

const uploadWindows = new Map<string, WindowEntry>();

// Prune stale entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of uploadWindows) {
    entry.timestamps = entry.timestamps.filter((t) => now - t < 60_000);
    if (entry.timestamps.length === 0) uploadWindows.delete(key);
  }
}, 60_000).unref();

/**
 * Middleware that rate-limits uploads per tenant based on their plan tier.
 * Returns 429 with Retry-After header when exceeded.
 */
export function requireUploadRateLimit() {
  return async (c: Context<Env>, next: Next) => {
    const tenantId = c.get("tenantId");
    if (!tenantId) {
      await next();
      return;
    }

    // Resolve plan from billing adapter
    const billing = c.get("billing");
    const result = await billing.canUse(tenantId, "max_schemas"); // any feature — we just need currentPlan
    const limits = limitsForPlan(result.currentPlan);

    const now = Date.now();
    let entry = uploadWindows.get(tenantId);
    if (!entry) {
      entry = { timestamps: [] };
      uploadWindows.set(tenantId, entry);
    }

    entry.timestamps = entry.timestamps.filter((t) => now - t < 60_000);

    if (entry.timestamps.length >= limits.uploadsPerMinute) {
      return c.json(
        {
          error: {
            code: "rate_limited",
            message: `Upload rate limit exceeded (${limits.uploadsPerMinute}/min on ${result.currentPlan} plan). Try again shortly.`,
          },
        },
        { status: 429, headers: { "Retry-After": "60" } },
      );
    }

    entry.timestamps.push(now);
    await next();
  };
}
