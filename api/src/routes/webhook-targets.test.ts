/**
 * Tests for the encrypted-custom-headers code paths on
 * /api/webhook-targets and the deliver path.
 *
 * What we verify:
 *   1. Encrypt → store → decrypt round-trips through the real envelope
 *      crypto (no mocking @koji/db's encrypt/decrypt).
 *   2. POST and PATCH reject reserved header names (Koji-* and
 *      Content-Type) so a caller can't shadow the signature headers we
 *      add at delivery time.
 *   3. POST and PATCH reject oversize headers (>4KB serialized).
 *   4. PATCH refuses to "drop" headers when masterKey is missing —
 *      returns 500 rather than silently no-op'ing a write that would
 *      leave the caller thinking they configured something.
 *   5. GET returns headerCount + headerNames but NEVER values, even with
 *      the masterKey available.
 *   6. The decryptHeadersOrEmpty helper logs and returns {} on bad blobs
 *      rather than throwing — so a master-key rotation doesn't break the
 *      whole route.
 *
 * RLS-isolation is covered by withRLS' own round-trip test in
 * packages/db/src/rls.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import type { Env } from "../env";
import { encrypt, decrypt } from "../crypto/envelope";

const MASTER_KEY = randomBytes(32).toString("hex");
const TENANT_A = "00000000-0000-0000-0000-00000000000a";
const USER = "00000000-0000-0000-0000-000000000099";
const TARGET_ID = "00000000-0000-0000-0000-0000000000aa";

// Minimal DB mock — we let withRLS pass through (already tested), and
// stub the chain calls the route makes. The "stored" header blob lives
// in a let-binding so PATCH/POST/GET can observe each other.
let storedRows: any[] = [];

vi.mock("@koji/db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    withRLS: async (_db: unknown, _tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
      const tx: any = {
        select: (proj?: Record<string, unknown>) => {
          // Distinguish requireQuantityGate's count query (single "count"
          // projection) from row-level selects so each returns the right
          // shape when awaited.
          const isCount =
            !!proj && Object.keys(proj).length === 1 && "count" in proj;
          const resolveValue = () =>
            isCount ? [{ count: storedRows.length }] : storedRows;
          // Chain is thenable — any await point along the chain resolves
          // to the right shape, whether the route called .limit() or
          // stopped at .from()/.where().
          const chain: any = {
            from: () => chain,
            where: () => chain,
            orderBy: () => chain,
            limit: () => chain,
            then: (onFulfilled: (v: unknown) => void) =>
              Promise.resolve(resolveValue()).then(onFulfilled),
          };
          return chain;
        },
        insert: () => ({
          values: (row: any) => ({
            returning: () => {
              const id = TARGET_ID;
              const inserted = {
                id,
                slug: row.slug,
                displayName: row.displayName,
                url: row.url,
                subscribedEvents: row.subscribedEvents,
                status: "active",
                createdAt: new Date(),
                headersEncrypted: row.headersEncrypted ?? null,
                lastDeliveredAt: null,
                lastError: null,
              };
              storedRows = [inserted];
              return Promise.resolve([inserted]);
            },
          }),
        }),
        update: () => ({
          set: (patch: Record<string, unknown>) => ({
            where: () => ({
              returning: () => {
                if (storedRows[0]) Object.assign(storedRows[0], patch);
                return Promise.resolve(storedRows);
              },
            }),
          }),
        }),
        delete: () => ({ where: () => Promise.resolve(undefined) }),
      };
      return fn(tx);
    },
  };
});

import { webhookTargets } from "./webhook-targets";

function createApp(opts: { masterKey?: string | null } = {}) {
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("tenantId", TENANT_A);
    c.set("principal", { userId: USER, email: "test@koji.dev", name: "Test" } as any);
    c.set("grants", new Set(["webhook:read", "webhook:write"]));
    c.set("roles", ["owner"]);
    c.set("masterKey", "masterKey" in opts ? opts.masterKey : MASTER_KEY);
    // requireQuantityGate consults c.get("billing").checkQuantityGate.
    // Stub a billing adapter that never refuses.
    c.set("billing", {
      checkQuantityGate: async () => ({ allowed: true, currentPlan: "scale" }),
    } as any);
    c.set("db", {} as any);
    await next();
  });
  app.route("/api/webhook-targets", webhookTargets);
  return app;
}

function postBody(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: "Test target",
    slug: "test-target",
    url: "https://example.com/hook",
    event_filters: ["job.completed"],
    ...extra,
  });
}

const hdrs = { "Content-Type": "application/json" };

describe("POST /api/webhook-targets — header validation", () => {
  it("accepts a simple header map and stores it encrypted", async () => {
    storedRows = [];
    const app = createApp();
    const res = await app.request("/api/webhook-targets", {
      method: "POST",
      headers: hdrs,
      body: postBody({ headers: { Authorization: "Bearer secret-token", "X-API-Key": "k1" } }),
    });
    expect(res.status).toBe(201);
    // Inspect the stored blob: it must NOT contain the plaintext token.
    const blob = storedRows[0]?.headersEncrypted as Buffer;
    expect(blob).toBeInstanceOf(Buffer);
    const blobStr = blob.toString("utf8");
    expect(blobStr).not.toContain("Bearer secret-token");
    expect(blobStr).not.toContain("k1");
    // And it must decrypt back to the same map.
    const decrypted = JSON.parse(decrypt(blobStr, MASTER_KEY, TENANT_A));
    expect(decrypted).toEqual({ Authorization: "Bearer secret-token", "X-API-Key": "k1" });
  });

  it("rejects reserved header names (Koji-*)", async () => {
    const app = createApp();
    const res = await app.request("/api/webhook-targets", {
      method: "POST",
      headers: hdrs,
      body: postBody({ headers: { "Koji-Signature": "spoof" } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Reserved");
  });

  it("rejects reserved Content-Type", async () => {
    const app = createApp();
    const res = await app.request("/api/webhook-targets", {
      method: "POST",
      headers: hdrs,
      body: postBody({ headers: { "content-type": "text/plain" } }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects headers serialized >4KB", async () => {
    const app = createApp();
    const big = "x".repeat(5000);
    const res = await app.request("/api/webhook-targets", {
      method: "POST",
      headers: hdrs,
      body: postBody({ headers: { "X-Huge": big } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("4096");
  });

  it("returns 500 when KOJI_MASTER_KEY is missing", async () => {
    const app = createApp({ masterKey: null });
    const res = await app.request("/api/webhook-targets", {
      method: "POST",
      headers: hdrs,
      body: postBody({ headers: { "X-Custom": "v" } }),
    });
    expect(res.status).toBe(500);
  });
});

describe("PATCH /api/webhook-targets/:id — header updates", () => {
  it("updates headers when masterKey is present", async () => {
    // Seed a row first by POSTing
    const app = createApp();
    await app.request("/api/webhook-targets", {
      method: "POST",
      headers: hdrs,
      body: postBody({ headers: { Authorization: "Bearer old" } }),
    });

    const res = await app.request(`/api/webhook-targets/${TARGET_ID}`, {
      method: "PATCH",
      headers: hdrs,
      body: JSON.stringify({ headers: { Authorization: "Bearer new" } }),
    });
    expect(res.status).toBe(200);
    const blob = storedRows[0]?.headersEncrypted as Buffer;
    const decrypted = JSON.parse(decrypt(blob.toString("utf8"), MASTER_KEY, TENANT_A));
    expect(decrypted).toEqual({ Authorization: "Bearer new" });
  });

  it("clears headers when body.headers is null", async () => {
    const app = createApp();
    await app.request("/api/webhook-targets", {
      method: "POST",
      headers: hdrs,
      body: postBody({ headers: { Authorization: "Bearer x" } }),
    });
    const res = await app.request(`/api/webhook-targets/${TARGET_ID}`, {
      method: "PATCH",
      headers: hdrs,
      body: JSON.stringify({ headers: null }),
    });
    expect(res.status).toBe(200);
    expect(storedRows[0]?.headersEncrypted).toBeNull();
  });

  it("rejects reserved header names on update", async () => {
    const app = createApp();
    await app.request("/api/webhook-targets", {
      method: "POST",
      headers: hdrs,
      body: postBody({ headers: { Authorization: "ok" } }),
    });
    const res = await app.request(`/api/webhook-targets/${TARGET_ID}`, {
      method: "PATCH",
      headers: hdrs,
      body: JSON.stringify({ headers: { "koji-event-id": "spoof" } }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects oversize headers on update", async () => {
    const app = createApp();
    await app.request("/api/webhook-targets", {
      method: "POST",
      headers: hdrs,
      body: postBody({ headers: { Authorization: "ok" } }),
    });
    const big = "x".repeat(5000);
    const res = await app.request(`/api/webhook-targets/${TARGET_ID}`, {
      method: "PATCH",
      headers: hdrs,
      body: JSON.stringify({ headers: { "X-Huge": big } }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 500 (not 200) when masterKey is missing and caller asked to set non-empty headers", async () => {
    // POST under a present masterKey to seed
    const app = createApp();
    await app.request("/api/webhook-targets", {
      method: "POST",
      headers: hdrs,
      body: postBody({ headers: { Authorization: "ok" } }),
    });
    // Now PATCH under a missing masterKey
    const noKeyApp = createApp({ masterKey: null });
    const res = await noKeyApp.request(`/api/webhook-targets/${TARGET_ID}`, {
      method: "PATCH",
      headers: hdrs,
      body: JSON.stringify({ headers: { "X-New": "v" } }),
    });
    expect(res.status).toBe(500);
  });
});

describe("GET /api/webhook-targets — masks header values", () => {
  it("returns headerCount + headerNames but never values", async () => {
    storedRows = [];
    const app = createApp();
    await app.request("/api/webhook-targets", {
      method: "POST",
      headers: hdrs,
      body: postBody({
        headers: { Authorization: "Bearer should-not-appear", "X-API-Key": "k1" },
      }),
    });

    const res = await app.request("/api/webhook-targets");
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ headerCount: number; headerNames: string[] }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.headerCount).toBe(2);
    expect(body.data[0]!.headerNames.sort()).toEqual(["Authorization", "X-API-Key"]);

    // The response must NOT contain plaintext values anywhere.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("Bearer should-not-appear");
    expect(raw).not.toContain("k1");
    // And must not leak the encrypted blob either.
    expect(raw).not.toContain("headersEncrypted");
  });

  it("returns empty headerNames when blob can't be decrypted (e.g. wrong master key)", async () => {
    storedRows = [];
    // Seed a row directly with a blob encrypted under DIFFERENT bytes than
    // the master key in the request context. This is what would happen on
    // a botched key rotation.
    const wrongKey = randomBytes(32).toString("hex");
    const blob = Buffer.from(
      encrypt(JSON.stringify({ Authorization: "x" }), wrongKey, TENANT_A),
      "utf8",
    );
    storedRows = [
      {
        id: TARGET_ID,
        slug: "t",
        displayName: "t",
        url: "https://example.com/h",
        subscribedEvents: ["job.completed"],
        headersEncrypted: blob,
        status: "active",
        lastDeliveredAt: null,
        lastError: null,
        createdAt: new Date(),
      },
    ];

    const app = createApp(); // app's masterKey is MASTER_KEY, blob was encrypted with wrongKey
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await app.request("/api/webhook-targets");
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ headerCount: number; headerNames: string[] }> };
    expect(body.data[0]!.headerCount).toBe(0);
    expect(body.data[0]!.headerNames).toEqual([]);
    // We loudly logged — not silent — so an operator can spot the failure.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to decrypt custom headers"),
    );
    warn.mockRestore();
  });
});
