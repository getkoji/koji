/**
 * Webhook event emitter — finds matching targets and enqueues deliveries.
 *
 * Two shapes:
 *   - `emitWebhookEvent(tenantId, eventType, data)` — one-shot emit. Use
 *     from any fire-and-forget site (route handlers, schedulers) where the
 *     caller doesn't need to record a Deliver trace stage.
 *   - `prepareWebhookEvent(...)` + `enqueueWebhookDeliveries(...)` — used
 *     by the motor (ingestion/process.ts) so it can insert the Deliver
 *     trace stage with the correct `targets_total` *before* any delivery
 *     job becomes visible to the worker. Without this split the worker
 *     could run `advanceDeliverStage` on a stage row that doesn't exist
 *     yet.
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

export interface PreparedWebhookEvent {
  /** The event id shared by every delivery job for this event. */
  eventId: string;
  /** The fully-built payload envelope that will ship to every target. */
  payload: {
    id: string;
    type: string;
    created_at: string;
    api_version: string;
    data: object;
  };
  /** The matching active targets for this tenant + event type. */
  targets: Array<{ id: string }>;
}

/**
 * Phase 1 of a two-phase emit — resolves the matching targets and builds
 * the payload envelope, but does NOT enqueue. Used by the motor so it can
 * seed the Deliver trace stage with `targets_total = targets.length` in the
 * same transaction that records the trace, before any delivery job becomes
 * visible to the worker.
 */
export async function prepareWebhookEvent(
  tenantId: string,
  eventType: string,
  data: object,
): Promise<PreparedWebhookEvent> {
  const eventId = `evt_${randomBytes(12).toString("hex")}`;
  const payload = {
    id: eventId,
    type: eventType,
    created_at: new Date().toISOString(),
    api_version: "2026-04-01",
    data,
  };

  if (!_db) return { eventId, payload, targets: [] };

  const targets = await withRLS(_db, tenantId, (tx) =>
    tx
      .select({
        id: schema.webhookTargets.id,
        subscribedEvents: schema.webhookTargets.subscribedEvents,
      })
      .from(schema.webhookTargets)
      .where(eq(schema.webhookTargets.status, "active"))
  );

  const matching = targets
    .filter(
      (t) => t.subscribedEvents.includes(eventType) || t.subscribedEvents.includes("*"),
    )
    .map((t) => ({ id: t.id }));

  return { eventId, payload, targets: matching };
}

export interface EnqueueDeliveriesOptions {
  /** If set, each enqueued job carries the document id through so the
   *  worker can find the Deliver trace stage row. */
  documentId?: string;
}

/**
 * Phase 2 of a two-phase emit — enqueues a delivery job for each target
 * returned by `prepareWebhookEvent`. Call this AFTER the Deliver trace
 * stage row is written so the worker can always find it.
 */
export async function enqueueWebhookDeliveries(
  tenantId: string,
  prepared: PreparedWebhookEvent,
  opts: EnqueueDeliveriesOptions = {},
): Promise<void> {
  if (!_queue) return;

  for (const target of prepared.targets) {
    await _queue.enqueue(
      "webhook.deliver",
      {
        webhookTargetId: target.id,
        eventId: prepared.eventId,
        eventType: prepared.payload.type,
        ...(opts.documentId ? { documentId: opts.documentId } : {}),
        payload: prepared.payload,
      },
      { tenantId },
    );
  }
}

/**
 * Fire-and-forget emit. Combines prepare + enqueue for callers that don't
 * need to record a Deliver trace stage (e.g. `schema.deployed` from a
 * route handler — there's no document timeline to attach to).
 */
export async function emitWebhookEvent(
  tenantId: string,
  eventType: string,
  data: object,
): Promise<void> {
  const prepared = await prepareWebhookEvent(tenantId, eventType, data);
  await enqueueWebhookDeliveries(tenantId, prepared);
}
