/**
 * Webhook delivery handler — registered as handlers['webhook.deliver']
 * in the worker.
 *
 * Loads the target, decrypts the signing secret, computes the HMAC
 * signature, POSTs to the target URL, and records the delivery. Each
 * attempt writes a `webhook_deliveries` row (one per attempt, good for
 * audit / debugging).
 *
 * In addition — when the delivery is part of a document's lifecycle
 * event (we get a `documentId` in the job payload) — the handler updates
 * the document's Deliver trace stage via `advanceDeliverStage`. The
 * stage counter (`targets_delivered` / `targets_failed`) is maintained
 * per-target on its *terminal* outcome only:
 *
 *   - first attempt succeeds                → count once as delivered
 *   - fails, retries, eventually succeeds   → count once as delivered
 *   - fails, retries, exhausts maxAttempts  → count once as failed
 *   - intermediate failed attempt           → bump attempts, don't settle
 *
 * The stage is finalised (status flips from `in_flight` to `ok` or
 * `fail`) when every target has reached a terminal outcome.
 *
 * The decrypted secret exists only in memory for the duration of this
 * function call — never logged, cached, or returned.
 */

import { and, eq, sql } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { schema, withRLS } from "@koji/db";
import type { Db } from "@koji/db";
import { decrypt, getMasterKey } from "../crypto/envelope";
import type { QueuedJob } from "../queue/provider";
import { TerminalError } from "../queue/worker";

let _db: Db | null = null;

export function initDeliveryHandler(db: Db) {
  _db = db;
}

export async function handleWebhookDeliver(job: QueuedJob): Promise<void> {
  if (!_db) throw new Error("Delivery handler not initialized");

  const db = _db;
  const {
    webhookTargetId,
    eventId,
    eventType,
    payload,
    documentId,
  } = job.payload as {
    webhookTargetId: string;
    eventId: string;
    eventType: string;
    payload: object;
    documentId?: string;
  };

  // Load the target
  const [target] = await withRLS(db, job.tenantId, (tx) =>
    tx
      .select()
      .from(schema.webhookTargets)
      .where(eq(schema.webhookTargets.id, webhookTargetId))
      .limit(1)
  );

  if (!target) {
    // The target was deleted mid-flight. Settle the per-target counter so
    // the Deliver stage can still finalise instead of hanging forever.
    if (documentId) {
      await advanceDeliverStage(db, {
        tenantId: job.tenantId,
        documentId,
        eventId,
        targetId: webhookTargetId,
        succeeded: false,
        isFinalAttempt: true,
        httpStatus: null,
        attempt: job.attempt,
      });
    }
    throw new TerminalError(`Webhook target ${webhookTargetId} not found`);
  }

  if (target.status !== "active") {
    if (documentId) {
      await advanceDeliverStage(db, {
        tenantId: job.tenantId,
        documentId,
        eventId,
        targetId: webhookTargetId,
        succeeded: false,
        isFinalAttempt: true,
        httpStatus: null,
        attempt: job.attempt,
      });
    }
    throw new TerminalError(`Webhook target ${webhookTargetId} is ${target.status}`);
  }

  // Decrypt the signing secret
  const masterKey = getMasterKey();
  if (!masterKey) {
    throw new TerminalError("KOJI_MASTER_KEY is not set");
  }

  const secretBlob = target.secretEncrypted.toString("utf8");
  const secret = decrypt(secretBlob, masterKey, job.tenantId);

  // Build HMAC signature
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${JSON.stringify(payload)}`;
  const v1 = createHmac("sha256", secret).update(signedPayload).digest("hex");

  // Deliver
  let httpStatus = 0;
  let responseBody = "";
  let succeeded = false;

  try {
    const resp = await fetch(target.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Koji-Signature": `t=${timestamp},v1=${v1}`,
        "Koji-Event-Id": eventId,
        "Koji-Event-Type": eventType,
        "User-Agent": "Koji-Webhooks/1.0",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    httpStatus = resp.status;
    responseBody = (await resp.text()).slice(0, 2048);
    succeeded = resp.ok;
  } catch (err: unknown) {
    responseBody = err instanceof Error ? err.message : "Connection failed";
  }

  // Record delivery attempt (one row per attempt — unchanged)
  await withRLS(db, job.tenantId, (tx) =>
    tx.insert(schema.webhookDeliveries).values({
      tenantId: job.tenantId,
      targetId: webhookTargetId,
      eventType,
      payloadJson: payload,
      attemptCount: job.attempt,
      status: succeeded ? "succeeded" : "failed",
      httpStatus: httpStatus || null,
      responseBody: responseBody || null,
      deliveredAt: succeeded ? new Date() : null,
    })
  );

  // Update target's last delivery time / last error (unchanged)
  if (succeeded) {
    await withRLS(db, job.tenantId, (tx) =>
      tx
        .update(schema.webhookTargets)
        .set({ lastDeliveredAt: new Date(), lastError: null })
        .where(eq(schema.webhookTargets.id, webhookTargetId))
    );
  } else {
    await withRLS(db, job.tenantId, (tx) =>
      tx
        .update(schema.webhookTargets)
        .set({ lastError: `HTTP ${httpStatus}: ${responseBody.slice(0, 200)}` })
        .where(eq(schema.webhookTargets.id, webhookTargetId))
    );
  }

  // Count toward the Deliver stage counter ONLY on terminal outcomes —
  // success counts every time (a single success ends this target's story)
  // and a failure counts only on the last scheduled attempt.
  const isFinalAttempt = !succeeded && job.attempt >= job.maxAttempts;

  if (documentId) {
    await advanceDeliverStage(db, {
      tenantId: job.tenantId,
      documentId,
      eventId,
      targetId: webhookTargetId,
      succeeded,
      isFinalAttempt,
      httpStatus: httpStatus || null,
      attempt: job.attempt,
    });
  }

  if (!succeeded) {
    // Throw to trigger retry via nack (or terminal fail once exhausted —
    // the queue decides based on `attempt >= maxRetries`).
    throw new Error(`Webhook delivery failed: HTTP ${httpStatus}`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Deliver trace stage — per-target counter

export type DeliverTargetStatus = "delivered" | "failed" | "in_flight";

export interface DeliverTargetEntry {
  status: DeliverTargetStatus;
  http_status?: number | null;
  attempts: number;
}

export interface DeliverSummary {
  event_id?: string;
  event_type?: string;
  targets_total: number;
  targets: Record<string, DeliverTargetEntry>;
  targets_delivered: number;
  targets_failed: number;
}

export interface MergeDeliverTargetInput {
  targetId: string;
  succeeded: boolean;
  isFinalAttempt: boolean;
  httpStatus: number | null;
  attempt: number;
}

export interface MergeDeliverTargetResult {
  summary: DeliverSummary;
  /** True when every target has reached a terminal status AND the map is
   *  fully populated. The stage row should be flipped out of `in_flight`. */
  isFinal: boolean;
}

/**
 * Pure merge function for the Deliver stage summary. Extracted so it can
 * be unit-tested without a database.
 *
 * Settling rules:
 *   - succeeded                          → target → `delivered` (+1)
 *   - failed on the final attempt        → target → `failed`    (+1)
 *   - failed with retries remaining      → target → `in_flight` (no count bump)
 *
 * Aggregate counts are always recomputed from `targets` so they can never
 * drift from the per-target truth. `attempts` is tracked as a high-water
 * mark — a late-arriving intermediate failure (pathological reorder)
 * can't decrement it.
 */
export function mergeDeliverTarget(
  prev: DeliverSummary,
  input: MergeDeliverTargetInput,
): MergeDeliverTargetResult {
  const targets = { ...prev.targets };
  const existing = targets[input.targetId];
  const nextAttempts = Math.max(existing?.attempts ?? 0, input.attempt);

  if (input.succeeded) {
    targets[input.targetId] = {
      status: "delivered",
      http_status: input.httpStatus,
      attempts: nextAttempts,
    };
  } else if (input.isFinalAttempt) {
    targets[input.targetId] = {
      status: "failed",
      http_status: input.httpStatus,
      attempts: nextAttempts,
    };
  } else {
    targets[input.targetId] = {
      status: "in_flight",
      http_status: input.httpStatus,
      attempts: nextAttempts,
    };
  }

  let delivered = 0;
  let failed = 0;
  for (const entry of Object.values(targets)) {
    if (entry.status === "delivered") delivered++;
    else if (entry.status === "failed") failed++;
  }

  const mapped = Object.keys(targets).length;
  const settled = delivered + failed;
  const isFinal =
    prev.targets_total > 0 && mapped >= prev.targets_total && settled === mapped;

  return {
    summary: {
      ...(prev.event_id ? { event_id: prev.event_id } : {}),
      ...(prev.event_type ? { event_type: prev.event_type } : {}),
      targets_total: prev.targets_total,
      targets,
      targets_delivered: delivered,
      targets_failed: failed,
    },
    isFinal,
  };
}

interface AdvanceArgs {
  tenantId: string;
  documentId: string;
  eventId: string;
  targetId: string;
  succeeded: boolean;
  /** True when this attempt exhausted the retry budget. On intermediate
   *  failures we only bump the attempt count — we don't settle the target. */
  isFinalAttempt: boolean;
  httpStatus: number | null;
  attempt: number;
}

/**
 * Update the Deliver trace stage for a single target. Runs under
 * `SELECT ... FOR UPDATE` so concurrent webhook workers can't race each
 * other and produce inconsistent counters.
 *
 * Settling rules:
 *   - succeeded → target flipped to `delivered` (regardless of attempt)
 *   - failed on the final attempt → flipped to `failed`
 *   - failed with retries remaining → keep `in_flight`, bump attempt count
 *
 * Aggregate counters (`targets_delivered`, `targets_failed`) are always
 * recomputed from the per-target map so they can never drift. The stage
 * is finalised (status → `ok` / `fail`, completed_at + duration set) when
 * every known target has reached a terminal status AND the map has
 * `targets_total` entries.
 */
export async function advanceDeliverStage(
  db: Db,
  args: AdvanceArgs,
): Promise<void> {
  const {
    tenantId,
    documentId,
    eventId,
    targetId,
    succeeded,
    isFinalAttempt,
    httpStatus,
    attempt,
  } = args;

  await withRLS(db, tenantId, async (tx) => {
    // Find the Deliver stage row for this document. We scope by event id
    // too so `document.delivered` and `document.review_requested` events
    // (which share a document) never cross-update each other.
    const locked = await tx.execute(sql`
      SELECT ts.id, ts.summary_json, ts.started_at, ts.status
      FROM ${schema.traceStages} ts
      JOIN ${schema.traces} tr ON tr.id = ts.trace_id
      WHERE tr.document_id = ${documentId}
        AND ts.stage_name = 'deliver'
        AND ts.summary_json->>'event_id' = ${eventId}
      ORDER BY ts.stage_order DESC
      LIMIT 1
      FOR UPDATE OF ts
    `);

    // drizzle-orm's `execute` returns either an array (postgres-js) or an
    // object with `.rows` (node-postgres) depending on the driver — handle
    // both rather than assume.
    // Driver-dependent serialisation: postgres-js returns timestamp cols as
    // ISO strings from raw execute(), node-postgres returns Date. Type the
    // field as the union so downstream code is forced to normalise.
    type LockedRow = {
      id: string;
      summary_json: DeliverSummary | null;
      started_at: Date | string | null;
      status: string;
    };
    const rows: LockedRow[] = Array.isArray(locked)
      ? (locked as unknown as LockedRow[])
      : ((locked as unknown as { rows?: LockedRow[] }).rows ?? []);
    const row = rows[0];

    if (!row || !row.summary_json) {
      // Stage not found — either the motor hasn't finished flushing yet
      // (extremely narrow race) or this is a route-level emit with no
      // document trace. Nothing to do; the next retry (on failure) or a
      // subsequent sibling target's delivery (on success) will still
      // progress overall.
      return;
    }

    const prev: DeliverSummary = {
      targets_total: row.summary_json.targets_total ?? 0,
      targets: row.summary_json.targets ?? {},
      targets_delivered: row.summary_json.targets_delivered ?? 0,
      targets_failed: row.summary_json.targets_failed ?? 0,
      ...(row.summary_json.event_id ? { event_id: row.summary_json.event_id } : {}),
      ...(row.summary_json.event_type ? { event_type: row.summary_json.event_type } : {}),
    };

    const { summary, isFinal } = mergeDeliverTarget(prev, {
      targetId,
      succeeded,
      isFinalAttempt,
      httpStatus,
      attempt,
    });

    if (isFinal) {
      const completedAt = new Date();
      // ``row.started_at`` comes back from drizzle's raw ``tx.execute`` call
      // as whatever the underlying driver serialises — ``postgres-js`` hands
      // back an ISO string, ``node-postgres`` hands back a ``Date``. Wrap
      // in ``new Date(...)`` so we end up with a Date regardless. Empty /
      // missing values fall through to ``completedAt`` so durationMs clamps
      // to zero instead of producing NaN.
      const startedMs = row.started_at
        ? new Date(row.started_at).getTime()
        : completedAt.getTime();
      await tx
        .update(schema.traceStages)
        .set({
          summaryJson: summary,
          status: summary.targets_failed > 0 ? "fail" : "ok",
          completedAt,
          durationMs: Math.max(0, completedAt.getTime() - startedMs),
        })
        .where(and(eq(schema.traceStages.id, row.id), eq(schema.traceStages.tenantId, tenantId)));
    } else {
      await tx
        .update(schema.traceStages)
        .set({ summaryJson: summary })
        .where(and(eq(schema.traceStages.id, row.id), eq(schema.traceStages.tenantId, tenantId)));
    }
  });
}
