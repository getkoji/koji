import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { getTableName } from "drizzle-orm";
import { authMiddleware } from "./middleware";
import type { AuthAdapter, Session } from "./adapter";
import type { Env } from "../env";

/**
 * oss-496 — `api_keys.last_used_at` is stamped when a key authenticates.
 *
 * The column was read by GET /api/api-keys and rendered in the dashboard as
 * "used <time ago>", but no code path ever wrote it: on prod it was NULL for
 * all 22 keys, including ones that had driven tens of thousands of jobs. That
 * made key rotation and offboarding guesswork — a live key was
 * indistinguishable from one abandoned months earlier.
 *
 * The write is throttled so a high-volume key doesn't add a row update to
 * every request, and it must never be able to fail an otherwise-valid request.
 */

const TENANT = "11111111-1111-4111-8111-111111111111";
const CREATOR = "22222222-2222-4222-8222-222222222222";
const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function nullAdapter(): AuthAdapter {
  return {
    async resolve() {
      return null; // force the api_keys hash-lookup fallback
    },
    async createSession(userId: string): Promise<Session> {
      return { token: `sess_${userId}`, expiresAt: new Date(Date.now() + 86400_000) };
    },
    async destroySession() {},
  };
}

interface Recorded {
  /** Values passed to .set() on api_keys, one entry per update issued. */
  sets: Array<Record<string, unknown>>;
}

function createApp(opts: { lastUsedAt: Date | null; updateThrows?: boolean }) {
  const recorded: Recorded = { sets: [] };
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    const rowsFor = (table: string): unknown[] => {
      switch (table) {
        case "api_keys":
          return [
            {
              id: KEY_ID,
              tenantId: TENANT,
              projectId: PROJECT,
              userId: CREATOR,
              email: "key@test.com",
              name: "Key Creator",
              lastUsedAt: opts.lastUsedAt,
            },
          ];
        case "api_key_project_access":
          return [];
        case "projects":
          return [{ id: PROJECT }];
        case "memberships":
          return [{ roles: ["owner"] }];
        case "tenants":
          return [{ id: TENANT }];
        default:
          return [];
      }
    };

    const select = () => {
      let table = "";
      const chain: any = {
        from: (t: unknown) => {
          try {
            table = getTableName(t as never);
          } catch {
            table = "";
          }
          return chain;
        },
        innerJoin: () => chain,
        leftJoin: () => chain,
        orderBy: () => chain,
        where: () => chain,
        limit: () => rowsFor(table),
        then: (onF: (v: unknown) => unknown) => Promise.resolve(rowsFor(table)).then(onF),
      };
      return chain;
    };

    const update = () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          if (opts.updateThrows) throw new Error("connection reset");
          recorded.sets.push(values);
        },
      }),
    });

    c.set("db", { select, update } as any);
    await next();
  });

  app.use("*", authMiddleware(nullAdapter()));
  app.get("/api/schemas", (c) => c.json({ ok: true }));
  return { app, recorded };
}

const hdrs = { Authorization: "Bearer koji_testkey" };

describe("api_keys.last_used_at stamping (oss-496)", () => {
  it("stamps a key that has never been used", async () => {
    const { app, recorded } = createApp({ lastUsedAt: null });
    const res = await app.request("/api/schemas", { headers: hdrs });

    expect(res.status).toBe(200);
    expect(recorded.sets).toHaveLength(1);
    expect(recorded.sets[0]!.lastUsedAt).toBeInstanceOf(Date);
  });

  it("stamps a key whose timestamp has gone stale", async () => {
    const stale = new Date(Date.now() - 60 * 60 * 1000); // an hour ago
    const { app, recorded } = createApp({ lastUsedAt: stale });
    const res = await app.request("/api/schemas", { headers: hdrs });

    expect(res.status).toBe(200);
    expect(recorded.sets).toHaveLength(1);
  });

  it("does not write on a key used moments ago", async () => {
    // The throttle is the difference between one write per key per 5 minutes
    // and one write per request on a key serving thousands of jobs an hour.
    const recent = new Date(Date.now() - 30 * 1000);
    const { app, recorded } = createApp({ lastUsedAt: recent });
    const res = await app.request("/api/schemas", { headers: hdrs });

    expect(res.status).toBe(200);
    expect(recorded.sets).toHaveLength(0);
  });

  it("still authenticates when the stamp write fails", async () => {
    // A telemetry column must never turn a valid API key into a failed
    // request.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app } = createApp({ lastUsedAt: null, updateThrows: true });
    const res = await app.request("/api/schemas", { headers: hdrs });

    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
