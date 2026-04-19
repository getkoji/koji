import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { authMiddleware, requires } from "../auth/middleware";
import { encrypt, decrypt, keyHint } from "../crypto/envelope";
import { randomBytes } from "node:crypto";
import type { AuthAdapter, Principal, Session } from "../auth/adapter";
import type { Env } from "../env";

const MASTER_KEY = randomBytes(32).toString("hex");

function createMockAdapter(users: Map<string, Principal>): AuthAdapter {
  return {
    async resolve(token: string) { return users.get(token) ?? null; },
    async createSession(): Promise<Session> {
      return { token: "s", expiresAt: new Date(Date.now() + 86400_000) };
    },
    async destroySession() {},
  };
}

function createTestApp(opts: {
  users: Map<string, Principal>;
  memberships: Map<string, { roles: string[] }>;
  tenants: Map<string, string>;
}) {
  const adapter = createMockAdapter(opts.users);
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    let qi = 0;
    const chain = () => {
      const idx = qi++;
      const obj = {
        from: () => obj, where: () => obj,
        limit: () => {
          if (idx === 0) {
            const slug = c.req.header("x-koji-tenant");
            return opts.tenants.has(slug ?? "") ? [{ id: opts.tenants.get(slug!)! }] : [];
          }
          if (idx === 1) {
            const p = c.get("principal") as Principal | undefined;
            const t = c.get("tenantId") as string | undefined;
            if (p && t) { const m = opts.memberships.get(`${p.userId}:${t}`); return m ? [m] : []; }
            return [];
          }
          return [];
        },
      };
      return obj;
    };
    c.set("db", { select: chain } as any);
    await next();
  });

  app.use("*", authMiddleware(adapter));
  return app;
}

describe("model providers permission enforcement", () => {
  const owner: Principal = { userId: "u-owner", email: "owner@test.com", name: "Owner" };
  const viewer: Principal = { userId: "u-viewer", email: "viewer@test.com", name: "Viewer" };
  const editor: Principal = { userId: "u-editor", email: "editor@test.com", name: "Editor" };

  const users = new Map([
    ["token-owner", owner],
    ["token-viewer", viewer],
    ["token-editor", editor],
  ]);
  const tenants = new Map([["acme", "t1"]]);
  const memberships = new Map([
    ["u-owner:t1", { roles: ["owner"] }],
    ["u-viewer:t1", { roles: ["viewer"] }],
    ["u-editor:t1", { roles: ["schema-editor"] }],
  ]);

  const hdrs = (token: string) => ({
    Cookie: `koji_session=${token}`,
    "x-koji-tenant": "acme",
    "Content-Type": "application/json",
  });

  it("viewer can list model providers (endpoint:read)", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.get("/api/model-providers", requires("endpoint:read"), (c) => c.json({ data: [] }));
    expect((await app.request("/api/model-providers", { headers: hdrs("token-viewer") })).status).toBe(200);
  });

  it("viewer cannot create model providers", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.post("/api/model-providers", requires("endpoint:write"), (c) => c.json({ ok: true }));
    expect((await app.request("/api/model-providers", { method: "POST", headers: hdrs("token-viewer"), body: "{}" })).status).toBe(403);
  });

  it("schema-editor cannot create model providers", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.post("/api/model-providers", requires("endpoint:write"), (c) => c.json({ ok: true }));
    expect((await app.request("/api/model-providers", { method: "POST", headers: hdrs("token-editor"), body: "{}" })).status).toBe(403);
  });

  it("owner can create model providers", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.post("/api/model-providers", requires("endpoint:write"), (c) => c.json({ ok: true }));
    expect((await app.request("/api/model-providers", { method: "POST", headers: hdrs("token-owner"), body: "{}" })).status).toBe(200);
  });

  it("viewer cannot rotate credentials", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.post("/api/model-providers/:id/rotate", requires("endpoint:write"), (c) => c.json({ ok: true }));
    expect((await app.request("/api/model-providers/x/rotate", { method: "POST", headers: hdrs("token-viewer"), body: "{}" })).status).toBe(403);
  });

  it("owner can rotate credentials", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.post("/api/model-providers/:id/rotate", requires("endpoint:write"), (c) => c.json({ ok: true }));
    expect((await app.request("/api/model-providers/x/rotate", { method: "POST", headers: hdrs("token-owner"), body: "{}" })).status).toBe(200);
  });
});

describe("credential encryption behavior", () => {
  const tenantId = "tenant-test-uuid";

  it("encrypted key is not plaintext", () => {
    const apiKey = "sk-abc123secretkey";
    const blob = encrypt(apiKey, MASTER_KEY, tenantId);
    expect(blob).not.toContain("sk-abc123");
    expect(blob).not.toBe(apiKey);
  });

  it("key hint is correct last 4 chars", () => {
    expect(keyHint("sk-abc123secretkey")).toBe("tkey");
    expect(keyHint("sk-proj-abcdef1234")).toBe("1234");
  });

  it("rotate produces different ciphertext", () => {
    const key1 = "sk-original-key-123";
    const key2 = "sk-rotated-key-456";
    const blob1 = encrypt(key1, MASTER_KEY, tenantId);
    const blob2 = encrypt(key2, MASTER_KEY, tenantId);
    expect(blob1).not.toBe(blob2);
    // Both decrypt to their respective values
    expect(decrypt(blob1, MASTER_KEY, tenantId)).toBe(key1);
    expect(decrypt(blob2, MASTER_KEY, tenantId)).toBe(key2);
  });

  it("same key encrypted twice produces different blobs (unique IV)", () => {
    const key = "sk-same-key";
    const blob1 = encrypt(key, MASTER_KEY, tenantId);
    const blob2 = encrypt(key, MASTER_KEY, tenantId);
    expect(blob1).not.toBe(blob2);
  });

  it("multi-field credentials roundtrip as JSON", () => {
    const creds = { api_key: "sk-123", deployment: "gpt4", region: "us-east-1" };
    const blob = encrypt(JSON.stringify(creds), MASTER_KEY, tenantId);
    const decrypted = JSON.parse(decrypt(blob, MASTER_KEY, tenantId));
    expect(decrypted.api_key).toBe("sk-123");
    expect(decrypted.deployment).toBe("gpt4");
    expect(decrypted.region).toBe("us-east-1");
  });

  it("tenant A cannot decrypt tenant B's credentials", () => {
    const blob = encrypt("sk-secret", MASTER_KEY, "tenant-a");
    expect(() => decrypt(blob, MASTER_KEY, "tenant-b")).toThrow();
  });
});
