/**
 * Post-extraction document outcome — ONE implementation for every pipeline
 * entrypoint (oss-359).
 *
 * The simple ingestion path (`process.ts`) scored fields, routed low-confidence
 * documents to review, and persisted the full extraction contract
 * (per-field confidence scores, provenance, fit, doc confidence, review items,
 * job counters, webhook events, notifications). The DAG runner persisted only
 * `extractionJson` plus a naive average confidence and marked every document
 * `delivered` — so DAG documents silently bypassed HITL review and shipped
 * without per-field scores for the dashboard/review UI to read.
 *
 * This module factors the ingestion behavior into:
 *  - {@link decideDocumentOutcome} — pure: engine scores + schema + threshold
 *    → routing decision. Deterministically testable.
 *  - {@link persistDocumentOutcome} — the DB/webhook/notification effects,
 *    parameterized only where entrypoints genuinely differ (extra document
 *    columns, trace hooks). Callers enqueue the returned webhook event
 *    themselves so trace-flush ordering stays under their control.
 */
import { eq, sql } from "drizzle-orm";
import { schema, withRLS, type Db } from "@koji/db";
import { jobCounterRecompute } from "./job-counters";
import {
  resolveFieldConfidences,
  aggregateDocConfidence,
  findLowestField,
} from "../extract/field-confidence";
import type { ProvenanceSpan } from "../extract/provenance";
import { prepareWebhookEvent, type PreparedWebhookEvent } from "../webhooks/emit";
import { createNotification } from "../notifications/emit";

/** The subset of the engine's extraction result the outcome logic reads. */
export interface OutcomeExtraction {
  extracted?: Record<string, unknown> | null;
  confidence_scores?: Record<string, number> | null;
  provenance?: Record<string, ProvenanceSpan | null> | null;
  fit?: Record<string, unknown> | null;
}

export interface DocumentOutcome {
  fieldScores: Record<string, number>;
  /** Doc-level confidence (min of field scores), or null with no scores. */
  docConfidence: number | null;
  routeToReview: boolean;
  lowField: { name: string; confidence: number } | null;
  /** The field a review item is filed under (worst field, else first, else doc). */
  reviewField: string;
  /** The confidence recorded on the review item. */
  reviewConfidence: number;
  /** The value proposed for review — the low field's value, else the whole record. */
  proposedValue: unknown;
}

function firstFieldName(scores: Record<string, number>): string | null {
  const keys = Object.keys(scores);
  return keys.length > 0 ? (keys[0] ?? null) : null;
}

/**
 * Pure routing decision: same numbers everywhere. Field scores come from the
 * engine (provenance strength + validation) via `resolveFieldConfidences`
 * (which re-credits optional nulls — see extract/field-confidence.ts), doc
 * confidence is the min, and any field below threshold routes to review.
 */
export function decideDocumentOutcome(args: {
  schemaDef: Record<string, unknown> | undefined;
  extractResult: OutcomeExtraction;
  reviewThreshold: string | number | null | undefined;
}): DocumentOutcome {
  const extractedValues = (args.extractResult.extracted ?? {}) as Record<string, unknown>;
  const fieldScores = resolveFieldConfidences(
    args.schemaDef,
    extractedValues,
    args.extractResult.confidence_scores ?? null,
    args.extractResult.provenance ?? undefined,
  );
  const docConfidence = aggregateDocConfidence(fieldScores);
  const threshold = Number(args.reviewThreshold);
  const lowField = Number.isFinite(threshold) ? findLowestField(fieldScores, threshold) : null;
  const routeToReview = lowField !== null;

  const reviewField = lowField?.name ?? firstFieldName(fieldScores) ?? "document";
  const reviewConfidence = lowField?.confidence ?? docConfidence ?? 0;
  const proposedValue = lowField?.name
    ? (extractedValues[lowField.name] ?? null)
    : ((args.extractResult.extracted ?? null) as unknown);

  return { fieldScores, docConfidence, routeToReview, lowField, reviewField, reviewConfidence, proposedValue };
}

/**
 * Persist the outcome — document row, review item, job counters, webhook
 * event, notification. Mirrors the (previously inline) ingestion behavior
 * exactly; the returned webhook event is prepared but NOT enqueued.
 */
export async function persistDocumentOutcome(args: {
  db: Db;
  tenantId: string;
  documentId: string;
  jobId: string;
  jobSlug: string;
  pipelineId: string;
  /** Schema the review item files under. Required when routing to review. */
  schemaId: string | null;
  /**
   * Schema version the document was actually extracted with, when the caller
   * resolved one. Null means "don't know" — never "clear it".
   */
  schemaVersionId?: string | null;
  threshold: number;
  outcome: DocumentOutcome;
  extractResult: OutcomeExtraction;
  durationMs: number;
  /** Entrypoint-specific document columns (e.g. the DAG's costUsd/pageCount). */
  extraDocUpdates?: Record<string, unknown>;
}): Promise<PreparedWebhookEvent | null> {
  const { db, tenantId, documentId, jobId, jobSlug, pipelineId, outcome } = args;
  const now = new Date();
  const docExtraction = args.extractResult.extracted ?? null;
  const docConfidence = outcome.docConfidence === null ? null : outcome.docConfidence.toFixed(4);
  // Stamp the schema the document was actually extracted with. On the simple
  // path this rewrites the value the document already inherited from the
  // pipeline; on the router/DAG path it's the only chance to record it, since
  // the pipeline itself has no schema and the row was inserted null. Both are
  // written only when known — a null here means "caller couldn't resolve one",
  // and clobbering a real id with null would lose the link permanently.
  const resolvedSchemaUpdates = {
    ...(args.schemaId ? { schemaId: args.schemaId } : {}),
    ...(args.schemaVersionId ? { schemaVersionId: args.schemaVersionId } : {}),
  };
  const commonDocUpdates = {
    extractionJson: docExtraction,
    confidenceScoresJson: outcome.fieldScores,
    provenanceJson: args.extractResult.provenance ?? null,
    fitJson: args.extractResult.fit ?? null,
    confidence: docConfidence,
    durationMs: args.durationMs,
    completedAt: now,
    ...resolvedSchemaUpdates,
    ...(args.extraDocUpdates ?? {}),
  };

  let prepared: PreparedWebhookEvent | null = null;

  // The outcome belongs to the job's project: review items are filed under
  // it, and webhook fan-out is confined to that project's targets.
  const [jobRow] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ projectId: schema.jobs.projectId })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, jobId))
      .limit(1),
  );
  if (!jobRow) throw new Error(`persistDocumentOutcome: job ${jobId} not found`);
  const scope = { tenantId, projectId: jobRow.projectId };


  if (outcome.routeToReview && args.schemaId) {
    const reviewConfidence = outcome.reviewConfidence.toFixed(4);
    await withRLS(db, scope, (tx) =>
      tx.insert(schema.reviewItems).values({
        tenantId,
        projectId: jobRow.projectId,
        documentId,
        schemaId: args.schemaId!,
        fieldName: outcome.reviewField,
        reason: "low_confidence",
        proposedValue: outcome.proposedValue,
        confidence: reviewConfidence,
        status: "pending",
      }),
    );

    await withRLS(db, tenantId, (tx) =>
      tx
        .update(schema.documents)
        .set({ status: "review", ...commonDocUpdates })
        .where(eq(schema.documents.id, documentId)),
    );

    await withRLS(db, tenantId, (tx) =>
      tx
        .update(schema.jobs)
        .set({
          // Counters are a projection of the documents table, not a tally of
          // events — a rerun moves a document between buckets instead of
          // adding to the totals (oss-495).
          ...jobCounterRecompute(jobId),
          completedAt: now,
          status: "complete",
        })
        .where(eq(schema.jobs.id, jobId)),
    );

    prepared = await prepareWebhookEvent(scope, "document.review_requested", {
      document_id: documentId,
      job_id: jobId,
      job_slug: jobSlug,
      pipeline_id: pipelineId,
      field: outcome.reviewField,
      confidence: reviewConfidence,
      threshold: args.threshold,
    });

    createNotification(scope, {
      type: "document.review_requested",
      title: "Document needs review",
      body: `Low confidence on ${outcome.reviewField} (${(outcome.reviewConfidence * 100).toFixed(0)}%)`,
      data: { documentId, jobId, field: outcome.reviewField, confidence: reviewConfidence },
    });
  } else {
    if (outcome.routeToReview && !args.schemaId) {
      // A review-worthy document with no schema to file the item under is a
      // config gap, not a reason to lose the low-confidence signal entirely —
      // deliver, but say so loudly.
      console.warn(
        `[ingestion] document ${documentId} scored below threshold but the pipeline has no schema to file review under — delivering`,
      );
    }
    await withRLS(db, tenantId, (tx) =>
      tx
        .update(schema.documents)
        .set({ status: "delivered", emittedAt: now, ...commonDocUpdates })
        .where(eq(schema.documents.id, documentId)),
    );

    await withRLS(db, tenantId, (tx) =>
      tx
        .update(schema.jobs)
        .set({
          // Counters are a projection of the documents table, not a tally of
          // events — a rerun moves a document between buckets instead of
          // adding to the totals (oss-495).
          ...jobCounterRecompute(jobId),
          completedAt: now,
          status: "complete",
        })
        .where(eq(schema.jobs.id, jobId)),
    );

    prepared = await prepareWebhookEvent(scope, "document.delivered", {
      document_id: documentId,
      job_id: jobId,
      job_slug: jobSlug,
      pipeline_id: pipelineId,
      extraction: docExtraction,
      confidence: docConfidence,
    });
  }


  return prepared;
}
