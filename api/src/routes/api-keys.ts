import { Hono } from "hono";
import { eq, and, isNull } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import { schema } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal, getProjectId, requireProjectId } from "../auth/middleware";

export const apiKeys = new Hono<Env>();

/**
 * GET /api/api-keys — list active (non-revoked) API keys for the tenant.
 */
apiKeys.get("/", requires("api_key:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  // This route uses raw db (not withRLS), so the project filter is explicit.
  const projectId = getProjectId(c);

  const rows = await db
    .select({
      id: schema.apiKeys.id,
      name: schema.apiKeys.name,
      keyPrefix: schema.apiKeys.keyPrefix,
      scopes: schema.apiKeys.scopes,
      lastUsedAt: schema.apiKeys.lastUsedAt,
      expiresAt: schema.apiKeys.expiresAt,
      createdAt: schema.apiKeys.createdAt,
      revokedAt: schema.apiKeys.revokedAt,
      createdByName: schema.users.name,
    })
    .from(schema.apiKeys)
    .innerJoin(schema.users, eq(schema.users.id, schema.apiKeys.createdBy))
    .where(
      and(
        eq(schema.apiKeys.tenantId, tenantId),
        ...(projectId ? [eq(schema.apiKeys.projectId, projectId)] : []),
      ),
    )
    .orderBy(schema.apiKeys.createdAt);

  return c.json({
    data: rows.map((r) => ({
      id: r.id,
      name: r.name,
      keyPrefix: r.keyPrefix,
      scopes: r.scopes,
      lastUsedAt: r.lastUsedAt,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      revokedAt: r.revokedAt,
      createdBy: r.createdByName,
    })),
  });
});

/**
 * POST /api/api-keys — create a new API key.
 *
 * Returns the full key ONCE in the response. After this, only the
 * prefix is available (the full key is hashed for storage).
 */
apiKeys.post("/", requires("api_key:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const principal = getPrincipal(c);
  const body = await c.req.json<{
    name: string;
    scopes?: string[];
    expires_in_days?: number;
  }>();

  if (!body.name || body.name.trim().length === 0) {
    return c.json({ error: "Name is required" }, 400);
  }

  // Generate the key: koji_<32 random hex chars>
  const rawKey = `koji_${randomBytes(32).toString("hex")}`;
  const prefix = rawKey.slice(0, 8) + "..." + rawKey.slice(-4); // fits varchar(16)
  const keyHash = createHash("sha256").update(rawKey).digest();

  const scopes = body.scopes ?? ["*"];
  const expiresAt = body.expires_in_days
    ? new Date(Date.now() + body.expires_in_days * 24 * 60 * 60 * 1000)
    : null;

  const [row] = await db
    .insert(schema.apiKeys)
    .values({
      tenantId,
      projectId: requireProjectId(c),
      name: body.name.trim(),
      keyPrefix: prefix,
      keyHash,
      scopes,
      createdBy: principal.userId,
      expiresAt,
    })
    .returning();

  return c.json({
    id: row!.id,
    name: row!.name,
    keyPrefix: prefix,
    key: rawKey, // Only returned on creation — store it now!
    scopes,
    expiresAt,
    createdAt: row!.createdAt,
  }, 201);
});

/**
 * DELETE /api/api-keys/:id — revoke an API key (soft-delete).
 */
apiKeys.delete("/:id", requires("api_key:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  // Scope revocation to the resolved project, exactly like the list (GET) —
  // now that api_key:write is reachable per-project (project-admin), a member
  // must not be able to revoke a key bound to a project they can't access.
  const projectId = getProjectId(c);
  const keyId = c.req.param("id")!;

  const [key] = await db
    .select({ id: schema.apiKeys.id })
    .from(schema.apiKeys)
    .where(
      and(
        eq(schema.apiKeys.id, keyId),
        eq(schema.apiKeys.tenantId, tenantId),
        ...(projectId ? [eq(schema.apiKeys.projectId, projectId)] : []),
      ),
    )
    .limit(1);

  if (!key) {
    return c.json({ error: "API key not found" }, 404);
  }

  await db
    .update(schema.apiKeys)
    .set({ revokedAt: new Date() })
    .where(eq(schema.apiKeys.id, keyId));

  return c.json({ ok: true });
});
