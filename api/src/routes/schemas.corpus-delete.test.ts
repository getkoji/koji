import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../env";
import type { Permission } from "../auth/roles";

// Mock withRLS to bypass the real DB transaction, but capture the tenantId it is
// called with so we can assert the delete is tenant-scoped.
const rlsTenants: string[] = [];
vi.mock("@koji/db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    withRLS: (_db: any, tenantId: string, fn: (tx: any) => Promise<any>) => {
      rlsTenants.push(tenantId);
      return fn(_db);
    },
  };
});

// Imported after the mock is registered.
const { schemas } = await import("./schemas");

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const SCHEMA_ID = "00000000-0000-0000-0000-000000000010";
const USER_ID = "00000000-0000-0000-0000-000000000099";
const ENTRY_ID = "00000000-0000-0000-0000-0000000000aa";

function createApp(opts: {
  schemaExists?: boolean;
  entryExists?: boolean;
  grants?: Permission[];
}) {
  const schemaExists = opts.schemaExists ?? true;
  const entryExists = opts.entryExists ?? true;
  const grants = opts.grants ?? ["corpus:read", "corpus:write", "schema:read"];

  let updateSet: Record<string, unknown> | null = null;

  const mockDb = {
    // Schema lookup by slug.
    select: () => {
      const chain: any = {
        from: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(schemaExists ? [{ id: SCHEMA_ID }] : []),
      };
      return chain;
    },
    // Soft-delete update.
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        updateSet = payload;
        const chain: any = {
          where: () => chain,
          returning: () => Promise.resolve(entryExists ? [{ id: ENTRY_ID }] : []),
        };
        return chain;
      },
    }),
  };

  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("tenantId", TENANT_ID);
    c.set("principal", { userId: USER_ID, email: "test@koji.dev", name: "Test" } as any);
    c.set("grants", new Set(grants));
    c.set("roles", ["owner"]);
    c.set("db", mockDb as any);
    await next();
  });
  app.route("/api/schemas", schemas);
  return { app, getUpdateSet: () => updateSet };
}

describe("DELETE /api/schemas/:slug/corpus/:entryId", () => {
  it("soft-deletes the entry and returns 204", async () => {
    rlsTenants.length = 0;
    const { app, getUpdateSet } = createApp({});
    const res = await app.request(`/api/schemas/my-schema/corpus/${ENTRY_ID}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(204);
    // Soft-delete: sets deletedAt rather than removing the row.
    const set = getUpdateSet();
    expect(set).not.toBeNull();
    expect(set!.deletedAt).toBeInstanceOf(Date);
    // Every query runs scoped to the caller's tenant.
    expect(rlsTenants.every((t) => t === TENANT_ID)).toBe(true);
  });

  it("returns 404 when the schema does not exist", async () => {
    const { app } = createApp({ schemaExists: false });
    const res = await app.request(`/api/schemas/nope/corpus/${ENTRY_ID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the entry is missing or already deleted", async () => {
    const { app } = createApp({ entryExists: false });
    const res = await app.request(`/api/schemas/my-schema/corpus/${ENTRY_ID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 without corpus:write", async () => {
    const { app } = createApp({ grants: ["corpus:read", "schema:read"] });
    const res = await app.request(`/api/schemas/my-schema/corpus/${ENTRY_ID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });
});
