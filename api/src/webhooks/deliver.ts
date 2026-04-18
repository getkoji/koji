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

import { eq } from "drizzle-orm";
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
  } = job.payload as {
    webhookTargetId: string;
    eventId: string;
    eventType: string;
    payload: object;
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
    // Throw to trigger retry via nack
    throw new Error(`Webhook delivery failed: HTTP ${httpStatus}`);
  }
}
