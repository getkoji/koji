/**
 * Endpoint health state-machine tests. We mock webhook + notification
 * emitters and a minimal Drizzle db, then exercise the transition logic
 * directly (via _transitionAndEmit) plus the wrapper's success/failure
 * paths.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const emittedWebhooks: Array<{ tenantId: string; projectId: string | null; type: string; data: any }> = [];
const createdNotifications: Array<{ tenantId: string; notification: any }> = [];

vi.mock("../webhooks/emit", () => ({
  emitWebhookEvent: vi.fn(async (scope: string | { tenantId: string; projectId?: string | null }, type: string, data: any) => {
    const tenantId = typeof scope === "string" ? scope : scope.tenantId;
    const projectId = typeof scope === "string" ? null : (scope.projectId ?? null);
    emittedWebhooks.push({ tenantId, projectId, type, data });
  }),
}));
vi.mock("../notifications/emit", () => ({
  createNotification: vi.fn((scope: string | { tenantId: string; projectId?: string | null }, notification: any) => {
    const tenantId = typeof scope === "string" ? scope : scope.tenantId;
    createdNotifications.push({ tenantId, notification });
  }),
}));

import {
  UNHEALTHY_THRESHOLD,
  wrapProviderWithHealthTracking,
  _transitionAndEmit,
} from "./endpoint-health";

const TENANT = "00000000-0000-0000-0000-00000000000a";
const ENDPOINT = "00000000-0000-0000-0000-0000000000e1";

interface FakeEndpoint {
  id: string;
  credentialId: string;
  tenantId: string;
  slug: string;
  consecutiveFailures: number;
  healthState: "healthy" | "unhealthy";
}

// Minimal Drizzle-shaped db: select returns the current row, update
// applies the patch in place. Each test gets its own endpoint state via
// makeDb so the state machine is observable. The chain mocks innerJoin
// because resolve reads via tenant_models → provider_credentials.
function makeDb(endpoint: FakeEndpoint) {
  const ep = { ...endpoint };
  const db: any = {
    select: (proj?: Record<string, unknown>) => {
      void proj;
      const chain: any = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        limit: () => Promise.resolve([{ ...ep }]),
      };
      return chain;
    },
    update: () => {
      const chain: any = {
        set: (patch: Partial<FakeEndpoint> & { updatedAt?: Date }) => ({
          where: () => {
            Object.assign(ep, patch);
            return Promise.resolve(undefined);
          },
        }),
      };
      return chain;
    },
    // For the readState helper in tests.
    _getEp: () => ep,
  };
  return db;
}

beforeEach(() => {
  emittedWebhooks.length = 0;
  createdNotifications.length = 0;
});

const CREDENTIAL = "00000000-0000-0000-0000-0000000000c1";

const baseEndpoint: FakeEndpoint = {
  id: ENDPOINT,
  credentialId: CREDENTIAL,
  tenantId: TENANT,
  slug: "openai-prod",
  consecutiveFailures: 0,
  healthState: "healthy",
};

describe("_transitionAndEmit — state machine", () => {
  it("first failure: increments counter, no transition, no event", async () => {
    const db = makeDb({ ...baseEndpoint });
    await _transitionAndEmit(db, ENDPOINT, "failure", "timeout");
    const ep = db._getEp();
    expect(ep.consecutiveFailures).toBe(1);
    expect(ep.healthState).toBe("healthy");
    expect(emittedWebhooks).toHaveLength(0);
    expect(createdNotifications).toHaveLength(0);
  });

  it("failure that crosses threshold: flips to unhealthy and emits one event", async () => {
    const db = makeDb({ ...baseEndpoint, consecutiveFailures: UNHEALTHY_THRESHOLD - 1 });
    await _transitionAndEmit(db, ENDPOINT, "failure", "503 from openai");
    const ep = db._getEp();
    expect(ep.consecutiveFailures).toBe(UNHEALTHY_THRESHOLD);
    expect(ep.healthState).toBe("unhealthy");
    expect(emittedWebhooks).toHaveLength(1);
    expect(emittedWebhooks[0]!.tenantId).toBe(TENANT);
    expect(emittedWebhooks[0]!.type).toBe("endpoint.unhealthy");
    expect(emittedWebhooks[0]!.data.consecutive_failures).toBe(UNHEALTHY_THRESHOLD);
    expect(emittedWebhooks[0]!.data.reason).toBe("503 from openai");
    expect(createdNotifications).toHaveLength(1);
    expect(createdNotifications[0]!.notification.type).toBe("endpoint.unhealthy");
  });

  it("failure while already unhealthy: increments but does NOT re-emit", async () => {
    const db = makeDb({
      ...baseEndpoint,
      consecutiveFailures: UNHEALTHY_THRESHOLD + 2,
      healthState: "unhealthy",
    });
    await _transitionAndEmit(db, ENDPOINT, "failure", "another timeout");
    const ep = db._getEp();
    expect(ep.consecutiveFailures).toBe(UNHEALTHY_THRESHOLD + 3);
    expect(ep.healthState).toBe("unhealthy");
    expect(emittedWebhooks).toHaveLength(0);
    expect(createdNotifications).toHaveLength(0);
  });

  it("success on a healthy endpoint: resets counter, no event", async () => {
    const db = makeDb({ ...baseEndpoint, consecutiveFailures: 1 });
    await _transitionAndEmit(db, ENDPOINT, "success");
    const ep = db._getEp();
    expect(ep.consecutiveFailures).toBe(0);
    expect(ep.healthState).toBe("healthy");
    expect(emittedWebhooks).toHaveLength(0);
  });

  it("success on an unhealthy endpoint: flips to healthy + emits endpoint.recovered", async () => {
    const db = makeDb({
      ...baseEndpoint,
      consecutiveFailures: UNHEALTHY_THRESHOLD + 1,
      healthState: "unhealthy",
    });
    await _transitionAndEmit(db, ENDPOINT, "success");
    const ep = db._getEp();
    expect(ep.consecutiveFailures).toBe(0);
    expect(ep.healthState).toBe("healthy");
    expect(emittedWebhooks).toHaveLength(1);
    expect(emittedWebhooks[0]!.type).toBe("endpoint.recovered");
    expect(createdNotifications[0]!.notification.type).toBe("endpoint.recovered");
  });

  it("does nothing for a deleted endpoint (no row)", async () => {
    const db: any = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => Promise.resolve([]), // no row
            }),
          }),
        }),
      }),
      update: vi.fn(),
    };
    await _transitionAndEmit(db, ENDPOINT, "failure", "boom");
    expect(db.update).not.toHaveBeenCalled();
    expect(emittedWebhooks).toHaveLength(0);
  });

  it("emits to the row's tenantId, not a caller-supplied one", async () => {
    const REAL_TENANT = "00000000-0000-0000-0000-00000000000b";
    const db = makeDb({
      ...baseEndpoint,
      tenantId: REAL_TENANT, // row says tenant B
      consecutiveFailures: UNHEALTHY_THRESHOLD - 1,
    });
    await _transitionAndEmit(db, ENDPOINT, "failure", "x");
    // No way to influence which tenant the event goes to other than the
    // row itself — this is the safety property we want to encode.
    expect(emittedWebhooks[0]!.tenantId).toBe(REAL_TENANT);
  });
});

describe("wrapProviderWithHealthTracking", () => {
  it("records success after a successful generate()", async () => {
    const db = makeDb({ ...baseEndpoint, consecutiveFailures: 2 });
    const wrapped = wrapProviderWithHealthTracking(
      { generate: async () => "ok" },
      db,
      ENDPOINT,
    );
    const out = await wrapped.generate("hi");
    expect(out).toBe("ok");
    // Yield to the floating promise in the wrapper
    await new Promise((r) => setImmediate(r));
    expect(db._getEp().consecutiveFailures).toBe(0);
  });

  it("records failure and re-throws when generate() throws", async () => {
    const db = makeDb({ ...baseEndpoint });
    const wrapped = wrapProviderWithHealthTracking(
      {
        generate: async () => {
          throw new Error("rate limited");
        },
      },
      db,
      ENDPOINT,
    );
    await expect(wrapped.generate("hi")).rejects.toThrow("rate limited");
    await new Promise((r) => setImmediate(r));
    expect(db._getEp().consecutiveFailures).toBe(1);
  });

  it("returns the provider unwrapped when no endpointId is given", async () => {
    const inner = { generate: vi.fn().mockResolvedValue("ok") };
    const wrapped = wrapProviderWithHealthTracking(inner, makeDb(baseEndpoint), null);
    expect(wrapped).toBe(inner);
  });

  it("preserves the generateWithImage capability", async () => {
    const db = makeDb({ ...baseEndpoint });
    const wrapped = wrapProviderWithHealthTracking(
      {
        generate: async () => "txt",
        generateWithImage: async () => "vision-ok",
      },
      db,
      ENDPOINT,
    );
    expect(wrapped.generateWithImage).toBeDefined();
    const out = await wrapped.generateWithImage!("hi", "base64data");
    expect(out).toBe("vision-ok");
  });

  it("a tracking-side failure does not bubble up", async () => {
    // Inner generate succeeds but our tracking write throws. Caller
    // must still see "ok".
    const badDb: any = {
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.reject(new Error("db down")) }) }) }),
    };
    const wrapped = wrapProviderWithHealthTracking(
      { generate: async () => "ok" },
      badDb,
      ENDPOINT,
    );
    const out = await wrapped.generate("hi");
    expect(out).toBe("ok");
  });
});
