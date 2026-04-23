import { Hono } from "hono";
import { eq, and, sql, desc } from "drizzle-orm";
import { randomBytes, createHmac } from "node:crypto";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal } from "../auth/middleware";
import { requireQuantityGate } from "../billing/middleware";
import { encrypt, decrypt, keyHint } from "../crypto/envelope";

export const webhookTargets = new Hono<Env>();

/**
 * GET /api/webhook-targets — list active targets.
 */
webhookTargets.get("/", requires("webhook:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.webhookTargets.id,
        slug: schema.webhookTargets.slug,
        displayName: schema.webhookTargets.displayName,
        url: schema.webhookTargets.url,
        subscribedEvents: schema.webhookTargets.subscribedEvents,
        status: schema.webhookTargets.status,
        lastDeliveredAt: schema.webhookTargets.lastDeliveredAt,
        lastError: schema.webhookTargets.lastError,
        createdAt: schema.webhookTargets.createdAt,
      })
      .from(schema.webhookTargets)
  );

  return c.json({ data: rows });
});

/**
 * POST /api/webhook-targets — create a target.
 * Auto-generates signing secret, encrypts it, returns it ONCE.
 */
webhookTargets.post(
  "/",
  requires("webhook:write"),
  requireQuantityGate("max_webhooks", async (c) => {
    const db = c.get("db");
    const tenantId = getTenantId(c);
    const [row] = await withRLS(db, tenantId, (tx) =>
      tx.select({ count: sql<number>`count(*)::int` }).from(schema.webhookTargets),
    );
    return row?.count ?? 0;
  }),
  async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const principal = getPrincipal(c);

  const masterKey = c.get("masterKey");
  if (!masterKey) {
    return c.json({ error: "KOJI_MASTER_KEY is not set" }, 500);
  }

  const body = await c.req.json<{
    name: string;
    slug: string;
    url: string;
    event_filters: string[];
  }>();

  if (!body.name || !body.slug || !body.url) {
    return c.json({ error: "name, slug, and url are required" }, 400);
  }
  if (!body.event_filters?.length) {
    return c.json({ error: "At least one event filter is required" }, 400);
  }

  // URL validation
  if (body.url.length > 2048) {
    return c.json({ error: "URL must be under 2048 characters" }, 400);
  }

  const isDev = process.env.NODE_ENV !== "production";
  try {
    const parsed = new URL(body.url);
    if (!isDev && parsed.protocol !== "https:") {
      return c.json({ error: "Webhook URL must use HTTPS" }, 400);
    }
    // SSRF: block private IPs
    const hostname = parsed.hostname;
    if (!isDev && (
      hostname === "localhost" ||
      hostname.startsWith("127.") ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      hostname === "169.254.169.254" ||
      hostname.startsWith("172.") // simplified check
    )) {
      return c.json({ error: "Webhook URL must not point to a private IP address" }, 400);
    }
  } catch {
    return c.json({ error: "Invalid URL" }, 400);
  }

  // Generate signing secret
  const secret = randomBytes(32).toString("hex");
  const secretEncryptedBlob = encrypt(secret, masterKey, tenantId);
  const secretHintStr = keyHint(secret);

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .insert(schema.webhookTargets)
      .values({
        tenantId,
        slug: body.slug,
        displayName: body.name,
        url: body.url,
        secretEncrypted: Buffer.from(secretEncryptedBlob, "utf8"),
        subscribedEvents: body.event_filters,
        createdBy: principal.userId,
      })
      .returning({
        id: schema.webhookTargets.id,
        slug: schema.webhookTargets.slug,
        displayName: schema.webhookTargets.displayName,
        url: schema.webhookTargets.url,
        subscribedEvents: schema.webhookTargets.subscribedEvents,
        status: schema.webhookTargets.status,
        createdAt: schema.webhookTargets.createdAt,
      })
  );

  return c.json({
    ...rows[0],
    secret, // Returned ONCE — never again
    secretHint: secretHintStr,
  }, 201);
});

/**
 * PATCH /api/webhook-targets/:id — update a target.
 */
webhookTargets.patch("/:id", requires("webhook:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const targetId = c.req.param("id")!;

  const body = await c.req.json<{
    name?: string;
    url?: string;
    event_filters?: string[];
    status?: string;
  }>();

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name) updates.displayName = body.name;
  if (body.url) updates.url = body.url;
  if (body.event_filters) updates.subscribedEvents = body.event_filters;
  if (body.status) updates.status = body.status;

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.webhookTargets)
      .set(updates)
      .where(eq(schema.webhookTargets.id, targetId))
      .returning()
  );

  if (rows.length === 0) {
    return c.json({ error: "Webhook target not found" }, 404);
  }

  return c.json(rows[0]);
});

/**
 * DELETE /api/webhook-targets/:id — delete a target.
 */
webhookTargets.delete("/:id", requires("webhook:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const targetId = c.req.param("id")!;

  await withRLS(db, tenantId, (tx) =>
    tx.delete(schema.webhookTargets).where(eq(schema.webhookTargets.id, targetId))
  );

  return c.body(null, 204);
});

/**
 * POST /api/webhook-targets/:id/test — send a test event.
 */
webhookTargets.post("/:id/test", requires("webhook:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const targetId = c.req.param("id")!;

  const masterKey = c.get("masterKey");
  if (!masterKey) {
    return c.json({ error: "KOJI_MASTER_KEY is not set" }, 500);
  }

  const [target] = await withRLS(db, tenantId, (tx) =>
    tx
      .select()
      .from(schema.webhookTargets)
      .where(eq(schema.webhookTargets.id, targetId))
      .limit(1)
  );

  if (!target) {
    return c.json({ error: "Webhook target not found" }, 404);
  }

  // Decrypt signing secret
  const secretBlob = target.secretEncrypted.toString("utf8");
  const secret = decrypt(secretBlob, masterKey, tenantId);

  const payload = {
    id: `evt_test_${Date.now()}`,
    type: "webhook.test",
    created_at: new Date().toISOString(),
    api_version: "2026-04-01",
    data: { message: "This is a test webhook delivery from Koji." },
  };

  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${JSON.stringify(payload)}`;
  const v1 = createHmac("sha256", secret).update(signedPayload).digest("hex");

  const start = Date.now();
  try {
    const resp = await fetch(target.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Koji-Signature": `t=${timestamp},v1=${v1}`,
        "Koji-Event-Id": payload.id,
        "Koji-Event-Type": "webhook.test",
        "User-Agent": "Koji-Webhooks/1.0",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    const latency = Date.now() - start;
    return c.json({
      ok: resp.ok,
      status: resp.status,
      latencyMs: latency,
    });
  } catch (err: unknown) {
    const latency = Date.now() - start;
    return c.json({
      ok: false,
      status: 0,
      latencyMs: latency,
      error: err instanceof Error ? err.message : "Connection failed",
    });
  }
});

/**
 * GET /api/webhook-targets/:id/deliveries — delivery history.
 */
webhookTargets.get("/:id/deliveries", requires("webhook:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const targetId = c.req.param("id")!;

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.webhookDeliveries.id,
        eventType: schema.webhookDeliveries.eventType,
        status: schema.webhookDeliveries.status,
        attemptCount: schema.webhookDeliveries.attemptCount,
        httpStatus: schema.webhookDeliveries.httpStatus,
        deliveredAt: schema.webhookDeliveries.deliveredAt,
        createdAt: schema.webhookDeliveries.createdAt,
      })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.targetId, targetId))
      .orderBy(desc(schema.webhookDeliveries.createdAt))
      .limit(100)
  );

  return c.json({ data: rows });
});
