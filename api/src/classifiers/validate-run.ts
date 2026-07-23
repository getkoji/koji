/**
 * Classifier validate-run execution (oss-451) — the schema-sibling of
 * api/src/schemas/validate-run.ts, for `koji classify validate`.
 *
 * A run backtests a classifier version against its corpus: classify each
 * labelled document through the SAME cascade production uses
 * (`classifyWithConfig`, the DAG classify step's path), compare the predicted
 * label to the ground truth, and score. Decomposed into independent per-document
 * units so corpus size never races a request timeout (the oss-348 lesson):
 *
 *   - {@link runClassifyDoc} — classify ONE corpus entry, record the prediction
 *     in `classifier_run_docs` (ok/failed).
 *   - {@link maybeFinalizeClassifierRun} — when every entry has a row, exactly
 *     one caller claims the run (atomic status flip) and scores it.
 *
 * A `classifier.validate.doc` queue job drives one document each; the last one
 * to finish wins the finalize claim. The sync driver (oss-453) will reuse these
 * same units so sync and async can't drift.
 */
import { and, eq, inArray } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Db } from "@koji/db";
import type { StorageProvider } from "../storage/provider";
import type { ParseProvider } from "../parse/provider";
import type { QueuedJob } from "../queue/provider";
import { classifyWithConfig, loadClassifierConfig, UNKNOWN_LABEL } from "../classify";
import type { ClassifierConfig } from "../classify";
import { computeClassifierResult, type ClassifyDocResult } from "./classify-scoring";

/** The `classifier.validate.doc` job payload — one corpus entry of one run. */
export interface ClassifierValidateDocJobPayload {
  classifierRunId: string;
  corpusEntryId: string;
}

/** Everything a per-doc unit needs that is constant across the run. */
export interface ClassifierRunContext {
  tenantId: string;
  projectId: string;
  classifierRunId: string;
  config: ClassifierConfig;
}

// Module state for the queue handler — mirrors initValidateRunner.
let _db: Db | null = null;
let _storage: StorageProvider | null = null;
let _parseProvider: ParseProvider | null = null;

export function initClassifierValidateRunner(
  db: Db,
  storage: StorageProvider,
  parseProvider: ParseProvider,
) {
  _db = db;
  _storage = storage;
  _parseProvider = parseProvider;
}

/**
 * Rebuild the run-constant context from the classifier_runs row — used by the
 * queue handler, where each job starts from nothing but ids. Returns null when
 * the run (or its version) is gone (classifier deleted mid-run); the job no-ops.
 */
export async function loadClassifierRunContext(
  db: Db,
  tenantId: string,
  classifierRunId: string,
): Promise<ClassifierRunContext | null> {
  const [run] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        projectId: schema.classifierRuns.projectId,
        classifierVersionId: schema.classifierRuns.classifierVersionId,
      })
      .from(schema.classifierRuns)
      .where(eq(schema.classifierRuns.id, classifierRunId))
      .limit(1),
  );
  if (!run) return null;

  const [version] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ yamlSource: schema.classifierVersions.yamlSource })
      .from(schema.classifierVersions)
      .where(eq(schema.classifierVersions.id, run.classifierVersionId))
      .limit(1),
  );
  if (!version?.yamlSource) return null;

  let config: ClassifierConfig;
  try {
    config = loadClassifierConfig(version.yamlSource);
  } catch {
    return null;
  }

  return { tenantId, projectId: run.projectId, classifierRunId, config };
}

/** The ground-truth label a corpus entry asserts, or null if unlabeled. */
function expectedLabelOf(groundTruthJson: unknown): string | null {
  const gt = groundTruthJson as { label?: unknown } | null;
  return gt && typeof gt.label === "string" ? gt.label : null;
}

/** Upsert this entry's progress+prediction row — retries overwrite, never double-count. */
async function recordDocRow(
  db: Db,
  ctx: ClassifierRunContext,
  corpusEntryId: string,
  row: {
    status: "ok" | "failed";
    expectedLabel: string | null;
    predictedLabel?: string | null;
    confidence?: number | null;
    method?: string | null;
    tierUsed?: number | null;
    evidencePage?: number | null;
    errorMessage?: string | null;
    durationMs: number;
  },
): Promise<void> {
  await withRLS(db, ctx.tenantId, (tx) =>
    tx
      .insert(schema.classifierRunDocs)
      .values({
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        classifierRunId: ctx.classifierRunId,
        corpusEntryId,
        status: row.status,
        expectedLabel: row.expectedLabel,
        predictedLabel: row.predictedLabel ?? null,
        confidence: row.confidence != null ? String(row.confidence) : null,
        method: row.method ?? null,
        tierUsed: row.tierUsed ?? null,
        evidencePage: row.evidencePage ?? null,
        errorMessage: row.errorMessage ?? null,
        durationMs: row.durationMs,
      })
      .onConflictDoUpdate({
        target: [schema.classifierRunDocs.classifierRunId, schema.classifierRunDocs.corpusEntryId],
        set: {
          status: row.status,
          expectedLabel: row.expectedLabel,
          predictedLabel: row.predictedLabel ?? null,
          confidence: row.confidence != null ? String(row.confidence) : null,
          method: row.method ?? null,
          tierUsed: row.tierUsed ?? null,
          evidencePage: row.evidencePage ?? null,
          errorMessage: row.errorMessage ?? null,
          durationMs: row.durationMs,
        },
      }),
  );
}

/**
 * Classify ONE corpus entry of a run and record the outcome. Never throws for
 * document-level failures — those become a `failed` progress row (a provider
 * outage is honest data, not a run-killer). Only infrastructure errors (the
 * progress write itself failing) propagate, so a queue retry re-runs cleanly.
 */
export async function runClassifyDoc(
  db: Db,
  storage: StorageProvider,
  parseProvider: ParseProvider | undefined,
  ctx: ClassifierRunContext,
  corpusEntryId: string,
): Promise<void> {
  const started = Date.now();

  const [entry] = await withRLS(db, ctx.tenantId, (tx) =>
    tx
      .select({
        id: schema.corpusEntries.id,
        filename: schema.corpusEntries.filename,
        storageKey: schema.corpusEntries.storageKey,
        mimeType: schema.corpusEntries.mimeType,
        groundTruthJson: schema.corpusEntries.groundTruthJson,
      })
      .from(schema.corpusEntries)
      .where(eq(schema.corpusEntries.id, corpusEntryId))
      .limit(1),
  );
  if (!entry) {
    await recordDocRow(db, ctx, corpusEntryId, {
      status: "failed",
      expectedLabel: null,
      errorMessage: "corpus entry not found",
      durationMs: Date.now() - started,
    });
    return;
  }

  const expectedLabel = expectedLabelOf(entry.groundTruthJson);

  try {
    const fileResult = await storage.getBuffer(entry.storageKey!);
    if (!fileResult) throw new Error("file not found in storage");

    const outcome = await classifyWithConfig(
      db,
      { tenantId: ctx.tenantId, projectId: ctx.projectId },
      { filename: entry.filename ?? "document", mimeType: entry.mimeType ?? "application/octet-stream", fileBuffer: fileResult.data },
      ctx.config,
      parseProvider,
    );

    await recordDocRow(db, ctx, corpusEntryId, {
      status: "ok",
      expectedLabel,
      predictedLabel: outcome.label ?? UNKNOWN_LABEL,
      confidence: outcome.confidence,
      method: outcome.method,
      tierUsed: outcome.tierUsed,
      evidencePage: outcome.evidencePage,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`[classify-validate] Failed to classify ${entry.filename}:`, error);
    await recordDocRow(db, ctx, corpusEntryId, {
      status: "failed",
      expectedLabel,
      errorMessage: error,
      durationMs: Date.now() - started,
    });
  }
}

export type ClassifierFinalizeOutcome =
  | { finalized: false }
  | { finalized: true; result: ReturnType<typeof computeClassifierResult> };

/**
 * Score + persist the run once every corpus entry has a progress row.
 *
 * Safe to call after every doc: no-ops until the last row lands, and the
 * `queued|running → finalizing` flip is atomic, so two docs finishing at once
 * can't both score the run.
 */
export async function maybeFinalizeClassifierRun(
  db: Db,
  tenantId: string,
  classifierRunId: string,
): Promise<ClassifierFinalizeOutcome> {
  const [run] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        status: schema.classifierRuns.status,
        docsTotal: schema.classifierRuns.docsTotal,
        startedAt: schema.classifierRuns.startedAt,
        createdAt: schema.classifierRuns.createdAt,
      })
      .from(schema.classifierRuns)
      .where(eq(schema.classifierRuns.id, classifierRunId))
      .limit(1),
  );
  if (!run || (run.status !== "queued" && run.status !== "running")) return { finalized: false };

  const docRows = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        corpusEntryId: schema.classifierRunDocs.corpusEntryId,
        status: schema.classifierRunDocs.status,
        expectedLabel: schema.classifierRunDocs.expectedLabel,
        predictedLabel: schema.classifierRunDocs.predictedLabel,
        tierUsed: schema.classifierRunDocs.tierUsed,
        errorMessage: schema.classifierRunDocs.errorMessage,
      })
      .from(schema.classifierRunDocs)
      .where(eq(schema.classifierRunDocs.classifierRunId, classifierRunId)),
  );
  if (docRows.length < run.docsTotal) return { finalized: false };

  // Atomic claim — exactly one finisher proceeds.
  const claimed = await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.classifierRuns)
      .set({ status: "finalizing" })
      .where(
        and(
          eq(schema.classifierRuns.id, classifierRunId),
          inArray(schema.classifierRuns.status, ["queued", "running"]),
        ),
      )
      .returning({ id: schema.classifierRuns.id }),
  );
  if (claimed.length === 0) return { finalized: false };

  const scored: ClassifyDocResult[] = docRows.map((d) => ({
    corpusEntryId: d.corpusEntryId,
    status: d.status === "ok" ? "ok" : "failed",
    expectedLabel: d.expectedLabel,
    predictedLabel: d.predictedLabel,
    tierUsed: d.tierUsed,
    errorMessage: d.errorMessage,
  }));
  const result = computeClassifierResult(scored);
  const startTime = (run.startedAt ?? run.createdAt).getTime();

  await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.classifierRuns)
      .set({
        status: "completed",
        completedAt: new Date(),
        docsTotal: result.docsTotal,
        docsCorrect: result.docsCorrect,
        docsFailed: result.docsFailed,
        accuracy: result.accuracy != null ? String(result.accuracy / 100) : null,
        durationMs: Date.now() - startTime,
        resultJson: result,
      })
      .where(eq(schema.classifierRuns.id, classifierRunId)),
  );

  return { finalized: true, result };
}

/**
 * Queue handler for `classifier.validate.doc` — one corpus entry per job.
 * Registered in createApp's HandlerMap; the platform's Inngest adapter picks it
 * up from the same registry, so each doc runs as its own invocation.
 */
export async function handleClassifierValidateDoc(job: QueuedJob): Promise<void> {
  if (!_db || !_storage) {
    throw new Error("Classifier validate runner not initialized — call initClassifierValidateRunner() first");
  }
  const { classifierRunId, corpusEntryId } = job.payload as unknown as ClassifierValidateDocJobPayload;

  const ctx = await loadClassifierRunContext(_db, job.tenantId, classifierRunId);
  if (!ctx) return; // run or version gone

  await runClassifyDoc(_db, _storage, _parseProvider ?? undefined, ctx, corpusEntryId);
  await maybeFinalizeClassifierRun(_db, job.tenantId, classifierRunId);
}
