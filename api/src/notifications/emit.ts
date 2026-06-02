/**
 * In-app notification emitter — writes notification rows to the DB.
 *
 * Separate from webhook events: webhooks go to external endpoints,
 * notifications show up in the dashboard bell icon dropdown.
 */

import { schema, withRLS } from "@koji/db";
import type { Db } from "@koji/db";

let _db: Db | null = null;

export function initNotifications(db: Db) {
  _db = db;
}

export async function createNotification(
  tenantId: string,
  notification: {
    type: string;
    title: string;
    body?: string;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  if (!_db) return;

  try {
    await withRLS(_db, tenantId, (tx) =>
      tx.insert(schema.notifications).values({
        tenantId,
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
