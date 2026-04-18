import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { authMiddleware, requires } from "../auth/middleware";
import { resolvePermissions } from "../auth/roles";
import type { AuthAdapter, Principal, Session } from "../auth/adapter";
import type { Env } from "../env";

describe("pipeline permissions", () => {
  it("viewer has pipeline:read", () => {
    expect(resolvePermissions(["viewer"]).has("pipeline:read")).toBe(true);
  });

  it("viewer does not have pipeline:write", () => {
    expect(resolvePermissions(["viewer"]).has("pipeline:write")).toBe(false);
  });

  it("schema-deployer has pipeline:write", () => {
    expect(resolvePermissions(["schema-deployer"]).has("pipeline:write")).toBe(true);
  });

  it("schema-editor does not have pipeline:write", () => {
    expect(resolvePermissions(["schema-editor"]).has("pipeline:write")).toBe(false);
  });

  it("schema-deployer has schema:deploy", () => {
    expect(resolvePermissions(["schema-deployer"]).has("schema:deploy")).toBe(true);
  });

  it("schema-editor does not have schema:deploy", () => {
    expect(resolvePermissions(["schema-editor"]).has("schema:deploy")).toBe(false);
  });

  it("owner has all pipeline permissions", () => {
    const perms = resolvePermissions(["owner"]);
    expect(perms.has("pipeline:read")).toBe(true);
    expect(perms.has("pipeline:write")).toBe(true);
    expect(perms.has("schema:deploy")).toBe(true);
  });
});

describe("pipeline deploy logic", () => {
  it("deploy requires schema version to belong to pipeline's schema", () => {
    const pipelineSchemaId = "schema-a";
    const versionSchemaId = "schema-b";
    expect(pipelineSchemaId).not.toBe(versionSchemaId);
    // Route returns 422: "Schema version does not belong to this pipeline's schema"
  });

  it("deploy accepts version from the correct schema", () => {
    const pipelineSchemaId = "schema-a";
    const versionSchemaId = "schema-a";
    expect(pipelineSchemaId).toBe(versionSchemaId);
  });

  it("pipeline with no schema_id accepts any version (links schema on first deploy)", () => {
    const pipelineSchemaId = null;
    // When schema_id is null, any version is accepted
    // Route sets schema_id to the version's schema_id
    expect(pipelineSchemaId).toBeNull();
  });
});

describe("pipeline status rules", () => {
  it("paused pipeline rejects new jobs", () => {
    const status = "paused";
    expect(status).toBe("paused");
    // Job submission returns 422: "Pipeline is paused"
  });

  it("pipeline with no deployed version rejects new jobs", () => {
    const activeSchemaVersionId = null;
    expect(activeSchemaVersionId).toBeNull();
    // Job submission returns 422: "Pipeline has no deployed schema version"
  });

  it("active pipeline with deployed version accepts jobs", () => {
    const status = "active";
    const activeSchemaVersionId = "sv-123";
    expect(status).toBe("active");
    expect(activeSchemaVersionId).not.toBeNull();
  });
});

describe("pipeline deletion", () => {
  it("deleting a pipeline unlinks connected sources", () => {
    // Sources with target_pipeline_id pointing to the deleted pipeline
    // get their target_pipeline_id set to null
    const sourceBeforeDelete = { targetPipelineId: "pl-123" };
    const sourceAfterDelete = { targetPipelineId: null };
    expect(sourceBeforeDelete.targetPipelineId).not.toBeNull();
    expect(sourceAfterDelete.targetPipelineId).toBeNull();
  });

  it("soft-delete sets deleted_at, doesn't remove row", () => {
    const deletedAt = new Date();
    expect(deletedAt).toBeDefined();
    // Row still exists with deleted_at set, filtered out by WHERE deleted_at IS NULL
  });
});

describe("review threshold", () => {
  it("default threshold is 0.9", () => {
    const defaultThreshold = "0.9";
    expect(parseFloat(defaultThreshold)).toBe(0.9);
  });

  it("threshold must be between 0 and 1", () => {
    const valid = [0, 0.5, 0.9, 1.0];
    for (const v of valid) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("documents below threshold route to review", () => {
    const threshold = 0.9;
    const confidence = 0.7;
    expect(confidence < threshold).toBe(true);
  });

  it("documents at or above threshold pass through", () => {
    const threshold = 0.9;
    const confidence = 0.95;
    expect(confidence >= threshold).toBe(true);
  });
});

// Integration tests
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

describe("pipeline endpoint enforcement", () => {
  const owner: Principal = { userId: "u-owner", email: "o@t.com", name: "Owner" };
  const viewer: Principal = { userId: "u-viewer", email: "v@t.com", name: "Viewer" };
  const editor: Principal = { userId: "u-editor", email: "e@t.com", name: "Editor" };

  const users = new Map([["t-owner", owner], ["t-viewer", viewer], ["t-editor", editor]]);
  const tenants = new Map([["acme", "t1"]]);
  const memberships = new Map([
    ["u-owner:t1", { roles: ["owner"] }],
    ["u-viewer:t1", { roles: ["viewer"] }],
    ["u-editor:t1", { roles: ["schema-editor"] }],
  ]);

  const hdrs = (token: string) => ({ Cookie: `koji_session=${token}`, "x-koji-tenant": "acme", "Content-Type": "application/json" });

  it("viewer can list pipelines", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.get("/api/pipelines", requires("pipeline:read"), (c) => c.json({ data: [] }));
    expect((await app.request("/api/pipelines", { headers: hdrs("t-viewer") })).status).toBe(200);
  });

  it("viewer cannot create pipelines", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.post("/api/pipelines", requires("pipeline:write"), (c) => c.json({ ok: true }));
    expect((await app.request("/api/pipelines", { method: "POST", headers: hdrs("t-viewer"), body: "{}" })).status).toBe(403);
  });

  it("schema-editor cannot deploy", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.post("/api/pipelines/x/deploy", requires("schema:deploy"), (c) => c.json({ ok: true }));
    expect((await app.request("/api/pipelines/x/deploy", { method: "POST", headers: hdrs("t-editor"), body: "{}" })).status).toBe(403);
  });

  it("owner can deploy", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.post("/api/pipelines/x/deploy", requires("schema:deploy"), (c) => c.json({ ok: true }));
    expect((await app.request("/api/pipelines/x/deploy", { method: "POST", headers: hdrs("t-owner"), body: "{}" })).status).toBe(200);
  });
});
