import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { authMiddleware, requires } from "../auth/middleware";
import { decrypt } from "../crypto/envelope";
import { randomBytes } from "node:crypto";
import type { AuthAdapter, Principal, Session } from "../auth/adapter";
import type { Env } from "../env";
import {
  validateParseCreatePayload,
  buildParseConfigJson,
  buildParseAuthJson,
  PARSE_PROVIDERS,
} from "./parse-providers";

const MASTER_KEY = randomBytes(32).toString("hex");

function createMockAdapter(users: Map<string, Principal>): AuthAdapter {
  return {
    async resolve(token: string) {
      return users.get(token) ?? null;
    },
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
        from: () => obj,
        where: () => obj,
        limit: () => {
          if (idx === 0) {
            const slug = c.req.header("x-koji-tenant");
            return opts.tenants.has(slug ?? "") ? [{ id: opts.tenants.get(slug!)! }] : [];
          }
          if (idx === 1) {
            const p = c.get("principal") as Principal | undefined;
            const t = c.get("tenantId") as string | undefined;
            if (p && t) {
              const m = opts.memberships.get(`${p.userId}:${t}`);
              return m ? [m] : [];
            }
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

describe("parse providers permission enforcement", () => {
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

  it("viewer can list parse providers (endpoint:read)", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.get("/api/parse-providers", requires("endpoint:read"), (c) => c.json({ data: [] }));
    expect(
      (await app.request("/api/parse-providers", { headers: hdrs("token-viewer") })).status,
    ).toBe(200);
  });

  it("viewer cannot create parse providers", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.post("/api/parse-providers", requires("endpoint:write"), (c) => c.json({ ok: true }));
    expect(
      (
        await app.request("/api/parse-providers", {
          method: "POST",
          headers: hdrs("token-viewer"),
          body: "{}",
        })
      ).status,
    ).toBe(403);
  });

  it("schema-editor cannot create parse providers", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.post("/api/parse-providers", requires("endpoint:write"), (c) => c.json({ ok: true }));
    expect(
      (
        await app.request("/api/parse-providers", {
          method: "POST",
          headers: hdrs("token-editor"),
          body: "{}",
        })
      ).status,
    ).toBe(403);
  });

  it("owner can create parse providers", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.post("/api/parse-providers", requires("endpoint:write"), (c) => c.json({ ok: true }));
    expect(
      (
        await app.request("/api/parse-providers", {
          method: "POST",
          headers: hdrs("token-owner"),
          body: "{}",
        })
      ).status,
    ).toBe(200);
  });

  it("viewer cannot set a parse default", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.post("/api/parse-providers/:id/default", requires("endpoint:write"), (c) =>
      c.json({ ok: true }),
    );
    expect(
      (
        await app.request("/api/parse-providers/x/default", {
          method: "POST",
          headers: hdrs("token-viewer"),
          body: "{}",
        })
      ).status,
    ).toBe(403);
  });

  it("owner can set a parse default", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.post("/api/parse-providers/:id/default", requires("endpoint:write"), (c) =>
      c.json({ ok: true }),
    );
    expect(
      (
        await app.request("/api/parse-providers/x/default", {
          method: "POST",
          headers: hdrs("token-owner"),
          body: "{}",
        })
      ).status,
    ).toBe(200);
  });
});

describe("validateParseCreatePayload", () => {
  it("rejects unknown providers", () => {
    expect(validateParseCreatePayload({ provider: "not-a-thing" })).toMatch(/provider must be/);
  });

  it("mistral-ocr requires api_key", () => {
    expect(validateParseCreatePayload({ provider: "mistral-ocr" })).toMatch(/api_key/);
    expect(validateParseCreatePayload({ provider: "mistral-ocr", api_key: "k" })).toBeNull();
  });

  it("azure-document-intel requires base_url + api_key", () => {
    expect(validateParseCreatePayload({ provider: "azure-document-intel" })).toMatch(/base_url/);
    expect(
      validateParseCreatePayload({
        provider: "azure-document-intel",
        base_url: "https://x.cognitiveservices.azure.com",
      }),
    ).toMatch(/api_key/);
    expect(
      validateParseCreatePayload({
        provider: "azure-document-intel",
        base_url: "https://x.cognitiveservices.azure.com",
        api_key: "k",
      }),
    ).toBeNull();
  });

  it("google-docai requires project_id + processor_id + api_key", () => {
    expect(validateParseCreatePayload({ provider: "google-docai" })).toMatch(/project_id/);
    expect(
      validateParseCreatePayload({ provider: "google-docai", project_id: "p" }),
    ).toMatch(/processor_id/);
    expect(
      validateParseCreatePayload({
        provider: "google-docai",
        project_id: "p",
        processor_id: "proc",
      }),
    ).toMatch(/api_key/);
    expect(
      validateParseCreatePayload({
        provider: "google-docai",
        project_id: "p",
        processor_id: "proc",
        api_key: "k",
      }),
    ).toBeNull();
  });

  it("textract requires region + access key id + secret", () => {
    expect(validateParseCreatePayload({ provider: "textract" })).toMatch(/region/);
    expect(
      validateParseCreatePayload({ provider: "textract", region: "us-east-1" }),
    ).toMatch(/aws_access_key_id/);
    expect(
      validateParseCreatePayload({
        provider: "textract",
        region: "us-east-1",
        aws_access_key_id: "AKIA",
      }),
    ).toMatch(/aws_secret_access_key/);
    expect(
      validateParseCreatePayload({
        provider: "textract",
        region: "us-east-1",
        aws_access_key_id: "AKIA",
        aws_secret_access_key: "secret",
      }),
    ).toBeNull();
  });

  it("covers every advertised provider slug", () => {
    for (const p of PARSE_PROVIDERS) {
      // An empty body for a known provider returns a required-field error, not
      // the unknown-provider error.
      expect(validateParseCreatePayload({ provider: p })).not.toMatch(/provider must be/);
    }
  });
});

describe("buildParseConfigJson", () => {
  it("mistral-ocr keeps only base_url", () => {
    expect(
      buildParseConfigJson("mistral-ocr", {
        base_url: "https://api.mistral.ai",
        region: "drop",
        project_id: "drop",
      }),
    ).toEqual({ base_url: "https://api.mistral.ai" });
  });

  it("google-docai keeps project/processor/region (defaulting region to us)", () => {
    expect(
      buildParseConfigJson("google-docai", { project_id: "p", processor_id: "proc" }),
    ).toEqual({ project_id: "p", processor_id: "proc", region: "us" });
  });

  it("textract keeps region + plaintext access key id, never the secret", () => {
    const cfg = buildParseConfigJson("textract", {
      region: "us-east-1",
      aws_access_key_id: "AKIAEXAMPLE",
    });
    expect(cfg).toEqual({ region: "us-east-1", aws_access_key_id: "AKIAEXAMPLE" });
  });
});

describe("buildParseAuthJson — encrypted single-secret shape", () => {
  const tenantId = "tenant-test-uuid";

  it("single-key provider encrypts api_key into key_blob", () => {
    const auth = buildParseAuthJson("mistral-ocr", { api_key: "sk-mistral-1234" }, MASTER_KEY, tenantId);
    expect(auth).not.toBeNull();
    expect(auth!.key_hint).toBe("1234");
    expect(auth!.key_blob).toBeDefined();
    expect(auth!.key_blob).not.toContain("sk-mistral");
    // resolveTenantParseProvider reads key_blob — field name is load-bearing.
    expect(decrypt(auth!.key_blob!, MASTER_KEY, tenantId)).toBe("sk-mistral-1234");
  });

  it("textract encrypts the aws secret (not the access key id) into key_blob", () => {
    const auth = buildParseAuthJson(
      "textract",
      { aws_secret_access_key: "super-secret-9999" },
      MASTER_KEY,
      tenantId,
    );
    expect(auth).not.toBeNull();
    expect(auth!.key_hint).toBe("9999");
    expect(auth!.key_blob).not.toContain("super-secret");
    expect(decrypt(auth!.key_blob!, MASTER_KEY, tenantId)).toBe("super-secret-9999");
  });

  it("returns null when no secret supplied", () => {
    expect(buildParseAuthJson("mistral-ocr", {}, MASTER_KEY, tenantId)).toBeNull();
    expect(buildParseAuthJson("textract", {}, MASTER_KEY, tenantId)).toBeNull();
  });

  it("tenant A cannot decrypt tenant B's parse key", () => {
    const auth = buildParseAuthJson("mistral-ocr", { api_key: "sk-secret" }, MASTER_KEY, "tenant-a");
    expect(() => decrypt(auth!.key_blob!, MASTER_KEY, "tenant-b")).toThrow();
  });
});
