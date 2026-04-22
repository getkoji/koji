import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { authMiddleware, requires } from "../auth/middleware";
import { encrypt, decrypt, keyHint } from "../crypto/envelope";
import { randomBytes } from "node:crypto";
import type { AuthAdapter, Principal, Session } from "../auth/adapter";
import type { Env } from "../env";
import {
  validateCreatePayload,
  buildConfigJson,
  buildAuthJson,
} from "./model-providers";

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

describe("validateCreatePayload", () => {
  it("azure-openai requires base_url, deployment_name, api_version", () => {
    expect(validateCreatePayload({ provider: "azure-openai" })).toMatch(/base_url/);
    expect(
      validateCreatePayload({
        provider: "azure-openai",
        base_url: "https://x.openai.azure.com",
      }),
    ).toMatch(/deployment_name/);
    expect(
      validateCreatePayload({
        provider: "azure-openai",
        base_url: "https://x.openai.azure.com",
        deployment_name: "gpt4",
      }),
    ).toMatch(/api_version/);
    expect(
      validateCreatePayload({
        provider: "azure-openai",
        base_url: "https://x.openai.azure.com",
        deployment_name: "gpt4",
        api_version: "2024-02-15-preview",
      }),
    ).toBeNull();
  });

  it("ollama requires base_url", () => {
    expect(validateCreatePayload({ provider: "ollama" })).toMatch(/base_url/);
    expect(validateCreatePayload({ provider: "ollama", base_url: "http://localhost:11434" })).toBeNull();
  });

  it("bedrock requires region + access key id + secret", () => {
    expect(validateCreatePayload({ provider: "bedrock" })).toMatch(/aws_region/);
    expect(validateCreatePayload({ provider: "bedrock", aws_region: "us-east-1" })).toMatch(/aws_access_key_id/);
    expect(
      validateCreatePayload({
        provider: "bedrock",
        aws_region: "us-east-1",
        aws_access_key_id: "AKIA",
      }),
    ).toMatch(/aws_secret_access_key/);
    expect(
      validateCreatePayload({
        provider: "bedrock",
        aws_region: "us-east-1",
        aws_access_key_id: "AKIA",
        aws_secret_access_key: "supersecret",
      }),
    ).toBeNull();
  });

  it("openai/anthropic/custom have no strict required fields", () => {
    expect(validateCreatePayload({ provider: "openai" })).toBeNull();
    expect(validateCreatePayload({ provider: "anthropic" })).toBeNull();
    expect(validateCreatePayload({ provider: "custom" })).toBeNull();
  });
});

describe("buildConfigJson", () => {
  it("openai keeps only base_url", () => {
    const cfg = buildConfigJson("openai", {
      base_url: "https://api.openai.com/v1",
      deployment_name: "should-not-appear",
      api_version: "should-not-appear",
      aws_region: "should-not-appear",
    });
    expect(cfg).toEqual({ base_url: "https://api.openai.com/v1" });
  });

  it("azure-openai keeps base_url, deployment_name, api_version", () => {
    const cfg = buildConfigJson("azure-openai", {
      base_url: "https://x.openai.azure.com",
      deployment_name: "prod-gpt4o",
      api_version: "2024-02-15-preview",
      aws_region: "should-not-appear",
    });
    expect(cfg).toEqual({
      base_url: "https://x.openai.azure.com",
      deployment_name: "prod-gpt4o",
      api_version: "2024-02-15-preview",
    });
  });

  it("bedrock keeps only aws_region and drops base_url", () => {
    const cfg = buildConfigJson("bedrock", {
      base_url: "should-not-appear",
      deployment_name: "should-not-appear",
      api_version: "should-not-appear",
      aws_region: "us-east-1",
    });
    expect(cfg).toEqual({ aws_region: "us-east-1" });
  });
});

describe("buildAuthJson — stored shape matches resolve-endpoint expectations", () => {
  const tenantId = "tenant-test-uuid";

  it("single-key provider stores key_blob (not encrypted_key)", () => {
    const auth = buildAuthJson("openai", { api_key: "sk-abcd1234" }, MASTER_KEY, tenantId);
    expect(auth).not.toBeNull();
    expect(auth!.key_hint).toBe("1234");
    expect(auth!.key_blob).toBeDefined();
    // resolve-endpoint.ts reads from `key_blob`, so the field name is
    // load-bearing and must not regress to `encrypted_key`.
    expect((auth as Record<string, unknown>).encrypted_key).toBeUndefined();
    expect(decrypt(auth!.key_blob!, MASTER_KEY, tenantId)).toBe("sk-abcd1234");
  });

  it("bedrock stores access_key_id plaintext + secret/session blobs encrypted", () => {
    const auth = buildAuthJson(
      "bedrock",
      {
        aws_access_key_id: "AKIAEXAMPLE1234",
        aws_secret_access_key: "secret-40-chars",
        aws_session_token: "session-token-xyz",
      },
      MASTER_KEY,
      tenantId,
    );
    expect(auth).not.toBeNull();
    expect(auth!.aws_access_key_id).toBe("AKIAEXAMPLE1234");
    expect(auth!.key_hint).toBe("1234"); // last 4 of access key id
    expect(auth!.aws_secret_access_key_blob).toBeDefined();
    expect(auth!.aws_session_token_blob).toBeDefined();
    // plaintext secret must not leak into the stored blob
    expect(auth!.aws_secret_access_key_blob).not.toContain("secret-40-chars");
    // both secrets roundtrip through decrypt
    expect(decrypt(auth!.aws_secret_access_key_blob!, MASTER_KEY, tenantId)).toBe("secret-40-chars");
    expect(decrypt(auth!.aws_session_token_blob!, MASTER_KEY, tenantId)).toBe("session-token-xyz");
  });

  it("bedrock without session token omits the session blob", () => {
    const auth = buildAuthJson(
      "bedrock",
      {
        aws_access_key_id: "AKIAEXAMPLE1234",
        aws_secret_access_key: "secret",
      },
      MASTER_KEY,
      tenantId,
    );
    expect(auth!.aws_session_token_blob).toBeUndefined();
  });

  it("returns null when single-key provider has no api_key", () => {
    expect(buildAuthJson("ollama", {}, MASTER_KEY, tenantId)).toBeNull();
    expect(buildAuthJson("openai", {}, MASTER_KEY, tenantId)).toBeNull();
  });

  it("returns null when bedrock is missing access key id or secret", () => {
    expect(buildAuthJson("bedrock", { aws_access_key_id: "AKIA" }, MASTER_KEY, tenantId)).toBeNull();
    expect(
      buildAuthJson("bedrock", { aws_secret_access_key: "secret" }, MASTER_KEY, tenantId),
    ).toBeNull();
  });
});
