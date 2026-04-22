/**
 * Webhook event emitter — finds matching targets and enqueues deliveries.
 *
 * Call emitWebhookEvent() from any event site (one line per event).
 * The actual delivery is handled asynchronously by the queue worker.
 */

import { eq } from "drizzle-orm";
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
 * and enqueues a delivery job for each. Returns the number of targets
 * a job was enqueued for — callers that care about trace accounting
 * (e.g. the ingestion motor's Deliver stage) need this count.
 *
 * The optional `traceStageId` is threaded into each queued job so the
 * delivery handler can update the aggregate Deliver stage row when
 * the HTTP POST completes.
 */
export async function emitWebhookEvent(
  tenantId: string,
  eventType: string,
  data: object,
  opts: { traceStageId?: string } = {},
): Promise<{ enqueuedCount: number; eventId: string }> {
  const eventId = `evt_${randomBytes(12).toString("hex")}`;
  if (!_queue || !_db) return { enqueuedCount: 0, eventId };

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

  for (const target of matching) {
    await _queue.enqueue(
      "webhook.deliver",
      {
        webhookTargetId: target.id,
        eventId,
        eventType,
        traceStageId: opts.traceStageId ?? null,
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

  return { enqueuedCount: matching.length, eventId };
}

/**
 * Count active targets matching an event type without enqueuing. Used
 * by the motor to pre-size the Deliver trace stage before emit — so
 * a doc with zero targets still gets an honest "skipped" row instead
 * of being omitted from the timeline.
 */
export async function countMatchingTargets(
  tenantId: string,
  eventType: string,
): Promise<number> {
  if (!_db) return 0;
  const targets = await withRLS(_db, tenantId, (tx) =>
    tx
      .select({ subscribedEvents: schema.webhookTargets.subscribedEvents })
      .from(schema.webhookTargets)
      .where(eq(schema.webhookTargets.status, "active")),
  );
  return targets.filter(
    (t) => t.subscribedEvents.includes(eventType) || t.subscribedEvents.includes("*"),
  ).length;
}
