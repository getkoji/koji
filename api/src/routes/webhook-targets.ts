import { Hono } from "hono";
import { eq, and, sql, desc } from "drizzle-orm";
import { randomBytes, createHmac } from "node:crypto";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal, getProjectId, requireProjectId } from "../auth/middleware";
import { requireQuantityGate } from "../billing/middleware";
import { encrypt, decrypt, keyHint } from "../crypto/envelope";

export const webhookTargets = new Hono<Env>();

/**
 * Max bytes for the JSON-serialized headers map. Keeps the encrypted blob
 * small enough to fit comfortably in any HTTP server's header limits at
 * delivery time and prevents unbounded storage growth from a misconfigured
 * caller. Auth tokens, bearer JWTs, and custom routing keys easily fit.
 */
const MAX_HEADERS_BYTES = 4096;

/**
 * Reject the body when:
 *   - any header name is reserved (Koji-* or Content-Type — we own those
 *     at delivery time, can't let a caller shadow them)
 *   - the JSON-serialized headers map exceeds MAX_HEADERS_BYTES
 *
 * Returns null on success, a `{ error }` object the caller should pass to
 * `c.json(..., 400)` on rejection.
 */
function validateHeaders(headers: Record<string, string>): { error: string } | null {
  const reserved = Object.keys(headers).filter(
    (k) => k.toLowerCase().startsWith("koji-") || k.toLowerCase() === "content-type",
  );
  if (reserved.length > 0) {
    return { error: `Reserved header names: ${reserved.join(", ")}` };
  }
  const serialized = JSON.stringify(headers);
  if (Buffer.byteLength(serialized, "utf8") > MAX_HEADERS_BYTES) {
    return {
      error: `Headers exceed ${MAX_HEADERS_BYTES} bytes when serialized`,
    };
  }
  return null;
}

/**
 * Decrypt a stored header blob into the original header map. On failure
 * (corrupt blob, wrong master key, etc.) returns {} and logs — never
 * throws, so the caller can keep delivering the webhook even if the
 * custom headers were lost to a rotation event.
 */
function decryptHeadersOrEmpty(
  blob: Buffer | null,
  masterKey: string | null,
  tenantId: string,
  context: string,
): Record<string, string> {
  if (!blob || !masterKey) return {};
  try {
    return JSON.parse(decrypt(blob.toString("utf8"), masterKey, tenantId)) as Record<
      string,
      string
    >;
  } catch (err) {
    console.warn(
      `[webhook-targets] failed to decrypt custom headers in ${context} for tenant ${tenantId}: ${err instanceof Error ? err.message : err}. Headers will be omitted from this request.`,
    );
    return {};
  }
}

/**
 * GET /api/webhook-targets — list active targets.
 */
webhookTargets.get("/", requires("webhook:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({
        id: schema.webhookTargets.id,
        slug: schema.webhookTargets.slug,
        displayName: schema.webhookTargets.displayName,
        url: schema.webhookTargets.url,
        subscribedEvents: schema.webhookTargets.subscribedEvents,
        headersEncrypted: schema.webhookTargets.headersEncrypted,
        status: schema.webhookTargets.status,
        lastDeliveredAt: schema.webhookTargets.lastDeliveredAt,
        lastError: schema.webhookTargets.lastError,
        createdAt: schema.webhookTargets.createdAt,
      })
      .from(schema.webhookTargets)
  );

  // Mask encrypted headers: only return header names, never values.
  // We still need to decrypt to recover the names — the alternative would
  // be storing names in plaintext, which leaks "this endpoint has an
  // Authorization header" to anyone who can read the row.
  const masterKey = c.get("masterKey");
  const data = rows.map((r) => {
    const { headersEncrypted, ...rest } = r;
    const headers = decryptHeadersOrEmpty(headersEncrypted, masterKey, tenantId, "GET /");
    const headerNames = Object.keys(headers);
    return { ...rest, headerCount: headerNames.length, headerNames };
  });

  return c.json({ data });
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
    // Plan quantity limits are per-TENANT — count tenant-wide, not per-project,
    // or each new project would multiply the quota.
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
    headers?: Record<string, string>;
  }>();

  if (!body.name || !body.slug || !body.url) {
    return c.json({ error: "name, slug, and url are required" }, 400);
  }

  // Validate custom headers — block reserved prefixes + size cap
  if (body.headers && typeof body.headers === "object") {
    const err = validateHeaders(body.headers);
    if (err) return c.json(err, 400);
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

  // Encrypt custom headers if provided
  const headersBlob = body.headers && Object.keys(body.headers).length > 0
    ? Buffer.from(encrypt(JSON.stringify(body.headers), masterKey, tenantId), "utf8")
    : null;

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .insert(schema.webhookTargets)
      .values({
        tenantId,
        projectId: requireProjectId(c),
        slug: body.slug,
        displayName: body.name,
        url: body.url,
        secretEncrypted: Buffer.from(secretEncryptedBlob, "utf8"),
        headersEncrypted: headersBlob,
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
    headers?: Record<string, string> | null;
  }>();

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name) updates.displayName = body.name;
  if (body.url) updates.url = body.url;
  if (body.event_filters) updates.subscribedEvents = body.event_filters;
  if (body.status) updates.status = body.status;

  // Update encrypted headers (null to clear, object to set)
  if (body.headers !== undefined) {
    const masterKey = c.get("masterKey");
    if (body.headers === null || Object.keys(body.headers).length === 0) {
      updates.headersEncrypted = null;
    } else if (!masterKey) {
      // Caller asked to set headers but we can't encrypt — fail loudly
      // rather than silently dropping the update, which would let them
      // think they'd configured headers that never get sent.
      return c.json({ error: "KOJI_MASTER_KEY is not set" }, 500);
    } else {
      const err = validateHeaders(body.headers);
      if (err) return c.json(err, 400);
      updates.headersEncrypted = Buffer.from(
        encrypt(JSON.stringify(body.headers), masterKey, tenantId),
        "utf8",
      );
    }
  }

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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

  await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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

  const [target] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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

  // Decrypt custom headers if present
  const customHeaders = decryptHeadersOrEmpty(
    target.headersEncrypted,
    masterKey,
    tenantId,
    `POST /${targetId}/test`,
  );

  const start = Date.now();
  try {
    const resp = await fetch(target.url, {
      method: "POST",
      headers: {
        ...customHeaders,
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

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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
