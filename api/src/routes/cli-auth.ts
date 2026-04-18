import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import { schema } from "@koji/db";
import type { Env } from "../env";
import { getPrincipal } from "../auth/middleware";
export const cliAuth = new Hono<Env>();

/**
 * POST /api/cli/authorize — create an API key for the CLI.
 *
 * Called by the dashboard's /cli/authorize page after the user
 * approves. Returns the raw key so the dashboard can redirect
 * to the CLI's localhost callback.
 *
 * Requires an authenticated session (the user must be logged in
 * to the dashboard).
 */
cliAuth.post("/authorize", async (c) => {
  const db = c.get("db");
  const principal = getPrincipal(c);
  const body = await c.req.json<{ tenant_id: string }>();

  if (!body.tenant_id) {
    return c.json({ error: "tenant_id is required" }, 400);
  }

  // Verify user is a member of the tenant
  const [membership] = await db
    .select({ id: schema.memberships.id })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.userId, principal.userId),
        eq(schema.memberships.tenantId, body.tenant_id),
      ),
    )
    .limit(1);

  if (!membership) {
    return c.json({ error: "You are not a member of this workspace" }, 403);
  }

  // Generate the key
  const rawKey = `koji_${randomBytes(32).toString("hex")}`;
  const prefix = rawKey.slice(0, 8) + "..." + rawKey.slice(-4); // fits varchar(16)
  const keyHash = createHash("sha256").update(rawKey).digest();

  const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const keyName = `CLI — ${principal.name ?? principal.email} (${timestamp})`;

  await db.insert(schema.apiKeys).values({
    tenantId: body.tenant_id,
    name: keyName,
    keyPrefix: prefix,
    keyHash,
    scopes: ["*"],
    createdBy: principal.userId,
  });

  return c.json({ key: rawKey }, 201);
});
