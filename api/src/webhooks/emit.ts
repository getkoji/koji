/**
 * Webhook event emitter — finds matching targets and enqueues deliveries.
 *
 * Call emitWebhookEvent() from any event site (one line per event).
 * The actual delivery is handled asynchronously by the queue worker.
 */

import { eq, and } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Db } from "@koji/db";
import type { QueueProvider } from "../queue/provider";
import { randomBytes } from "node:crypto";

let _queue: QueueProvider | null = null;
let _db: Db | null = null;

/** Initialize the emitter with the queue and DB instances. */
export function initEmitter(queue: QueueProvider, db: Db) {
  _queue = queue;
  _db = db;
}

/**
 * Emit a webhook event. Finds matching active targets for the tenant
 * and enqueues a delivery job for each.
 */
export async function emitWebhookEvent(
  tenantId: string,
  eventType: string,
  data: object,
): Promise<void> {
  if (!_queue || !_db) return; // Emitter not initialized (e.g., during tests)

  const targets = await withRLS(_db, tenantId, (tx) =>
    tx
      .select({
        id: schema.webhookTargets.id,
        subscribedEvents: schema.webhookTargets.subscribedEvents,
      })
      .from(schema.webhookTargets)
      .where(eq(schema.webhookTargets.status, "active"))
  );

  const matching = targets.filter(
    (t) => t.subscribedEvents.includes(eventType) || t.subscribedEvents.includes("*"),
  );

  const eventId = `evt_${randomBytes(12).toString("hex")}`;

  for (const target of matching) {
    await _queue.enqueue(
      "webhook.deliver",
      {
        webhookTargetId: target.id,
        eventId,
        eventType,
        payload: {
          id: eventId,
          type: eventType,
          created_at: new Date().toISOString(),
          api_version: "2026-04-01",
          data,
        },
      },
      { tenantId },
    );
  }
}
