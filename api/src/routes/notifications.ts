import { Hono } from "hono";
import { eq, and, sql, desc, isNull } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId } from "../auth/middleware";

export const notifications = new Hono<Env>();

/**
 * GET /api/notifications — list recent notifications.
 * Query params: limit (default 20), unread_only (default false).
 */
notifications.get("/", requires("permission:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
  const unreadOnly = c.req.query("unread_only") === "true";

  const rows = await withRLS(db, tenantId, (tx) => {
    let q = tx
      .select({
        id: schema.notifications.id,
        type: schema.notifications.type,
        title: schema.notifications.title,
        body: schema.notifications.body,
        dataJson: schema.notifications.dataJson,
        readAt: schema.notifications.readAt,
        createdAt: schema.notifications.createdAt,
      })
      .from(schema.notifications)
      .orderBy(desc(schema.notifications.createdAt))
      .limit(limit);

    if (unreadOnly) {
      q = q.where(isNull(schema.notifications.readAt)) as typeof q;
    }

    return q;
  });

  return c.json({ data: rows });
});

/**
 * GET /api/notifications/count — unread notification count.
 */
notifications.get("/count", requires("permission:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);

  const [row] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.notifications)
      .where(isNull(schema.notifications.readAt)),
  );

  return c.json({ unread: row?.count ?? 0 });
});

/**
 * PATCH /api/notifications/:id/read — mark a single notification as read.
 */
notifications.patch("/:id/read", requires("permission:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const id = c.req.param("id");

  await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(schema.notifications.id, id),
          isNull(schema.notifications.readAt),
        ),
      ),
  );

  return c.json({ ok: true });
});

/**
 * POST /api/notifications/read-all — mark all notifications as read.
 */
notifications.post("/read-all", requires("permission:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);

  const result = await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.notifications)
      .set({ readAt: new Date() })
      .where(isNull(schema.notifications.readAt)),
  );

  return c.json({ ok: true });
});
