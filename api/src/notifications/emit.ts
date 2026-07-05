/**
 * In-app notification emitter — writes notification rows to the DB.
 *
 * Separate from webhook events: webhooks go to external endpoints,
 * notifications show up in the dashboard bell icon dropdown.
 */

import { schema, withRLS } from "@koji/db";
import type { Db, RlsScope } from "@koji/db";

let _db: Db | null = null;

export function initNotifications(db: Db) {
  _db = db;
}

export async function createNotification(
  scope: RlsScope,
  notification: {
    type: string;
    title: string;
    body?: string;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  if (!_db) return;

  const tenantId = typeof scope === "string" ? scope : scope.tenantId;
  // A bare tenantId means a tenant-level notification (no project) — visible
  // in every project via the null-aware RLS policy. A scope object carries
  // the originating project so the bell can file it under that project.
  const projectId = typeof scope === "string" ? null : (scope.projectId ?? null);

  try {
    await withRLS(_db, tenantId, (tx) =>
      tx.insert(schema.notifications).values({
        tenantId,
        projectId,
        type: notification.type,
        title: notification.title,
        body: notification.body ?? null,
        dataJson: notification.data ?? null,
      }),
    );
  } catch (err) {
    console.warn(
      `[notifications] failed to create notification:`,
      err instanceof Error ? err.message : err,
    );
  }
}
