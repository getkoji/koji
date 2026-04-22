/**
 * Webhook delivery handler — registered as handlers['webhook.deliver']
 * in the worker.
 *
 * Loads the target, decrypts the signing secret, computes the HMAC
 * signature, POSTs to the target URL, and records the delivery.
 *
 * The decrypted secret exists only in memory for the duration of
 * this function call — never logged, cached, or returned.
 */

import { eq, sql } from "drizzle-orm";
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
    traceStageId,
  } = job.payload as {
    webhookTargetId: string;
    eventId: string;
    eventType: string;
    payload: object;
    traceStageId?: string | null;
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
    throw new TerminalError(`Webhook target ${webhookTargetId} not found`);
  }

  if (target.status !== "active") {
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

  // Record delivery attempt
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

  // Update target's last delivery time
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

  // Advance the Deliver trace stage (if the motor created one for this
  // event). Each delivery increments the aggregate success/fail counter.
  // When the last attempt lands (delivered + failed == total) we also
  // finalise the stage: completed_at + duration_ms + status.
  //
  // Best-effort — if the trace update fails we still want the delivery
  // itself to succeed (or the retry to re-fire on HTTP failure).
  if (traceStageId) {
    try {
      await advanceDeliverStage(db, job.tenantId, traceStageId, succeeded);
    } catch (err) {
      console.warn(
        "[webhook.deliver] trace-stage update failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (!succeeded) {
    // Throw to trigger retry via nack
    throw new Error(`Webhook delivery failed: HTTP ${httpStatus}`);
  }
}

/**
 * Atomically bump the Deliver stage's success/failure counter and, if
 * all expected deliveries have landed, mark the stage complete.
 *
 * Uses a SELECT ... FOR UPDATE inside a transaction so concurrent
 * delivery workers don't race on the jsonb counter.
 */
async function advanceDeliverStage(
  db: Db,
  tenantId: string,
  traceStageId: string,
  succeeded: boolean,
): Promise<void> {
  await withRLS(db, tenantId, async (tx) => {
    const [stage] = await tx
      .select({
        id: schema.traceStages.id,
        startedAt: schema.traceStages.startedAt,
        summaryJson: schema.traceStages.summaryJson,
      })
      .from(schema.traceStages)
      .where(eq(schema.traceStages.id, traceStageId))
      .for("update")
      .limit(1);

    if (!stage) return;

    const summary = (stage.summaryJson ?? {}) as {
      targets_total?: number;
      targets_delivered?: number;
      targets_failed?: number;
      [k: string]: unknown;
    };

    const total = Number(summary.targets_total ?? 0);
    const delivered = Number(summary.targets_delivered ?? 0) + (succeeded ? 1 : 0);
    const failed = Number(summary.targets_failed ?? 0) + (succeeded ? 0 : 1);
    const settled = delivered + failed;

    const isFinal = total > 0 && settled >= total;
    const completedAt = isFinal ? new Date() : null;
    const durationMs =
      isFinal && stage.startedAt
        ? Math.max(0, completedAt!.getTime() - stage.startedAt.getTime())
        : null;

    // Any failed attempt taints the whole row — the timeline should show
    // red if even one target didn't receive the payload.
    const finalStatus = isFinal ? (failed > 0 ? "fail" : "ok") : "in_flight";

    await tx
      .update(schema.traceStages)
      .set({
        summaryJson: {
          ...summary,
          targets_delivered: delivered,
          targets_failed: failed,
        },
        status: finalStatus,
        completedAt: isFinal ? completedAt : null,
        durationMs: isFinal ? durationMs : null,
      })
      .where(eq(schema.traceStages.id, traceStageId));

    // If the stage is finalising, also roll its duration into the parent
    // trace's total_duration_ms so the metrics strip at the top of the
    // trace view reflects the full lifecycle, not just Parse + Extract.
    if (isFinal && durationMs !== null) {
      await tx
        .update(schema.traces)
        .set({
          totalDurationMs: sql`${schema.traces.totalDurationMs} + ${durationMs}`,
          completedAt,
        })
        .where(
          eq(
            schema.traces.id,
            sql`(SELECT trace_id FROM trace_stages WHERE id = ${traceStageId})`,
          ),
        );
    }
  });
}
