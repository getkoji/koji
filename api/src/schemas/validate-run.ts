/**
 * Validate run execution — per-document extraction + run finalization.
 *
 * A validate run used to execute as one sequential doc loop inside the POST
 * /validate request, which hit the 300s ceiling on both the CLI client and
 * the hosted Vercel function as soon as per-doc extraction got expensive
 * (`enumerate_rows` adds a full LLM completion pass per array field per doc
 * — oss-348). The run is now decomposed into independent per-document units:
 *
 *   - {@link runValidateDoc} — parse + extract + persist ONE corpus entry,
 *     recording the outcome in `schema_run_docs` (ok/failed + routing plan).
 *   - {@link maybeFinalizeValidateRun} — when every entry has a row, exactly
 *     one caller claims the run (atomic status flip) and scores it, persisting
 *     the full ValidateResult onto `schema_runs.result_json`.
 *
 * Two drivers share these units, so sync and async cannot drift:
 *
 *   - POST /validate (sync, back-compat): runs the docs through
 *     `mapWithConcurrency` in-request and finalizes inline. Same response
 *     shape as before, just parallel.
 *   - POST /validate {async:true}: enqueues one `schema.validate.doc` job per
 *     entry and returns the run id immediately; each job runs its doc and
 *     attempts finalization (the last one wins the claim). Clients poll
 *     GET /:slug/validate/runs/:runId. No invocation ever holds more than one
 *     document's worth of work, so corpus size no longer races any timeout.
 */

import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { schema, withRLS } from "@koji/db";
import type { Db } from "@koji/db";
import type { StorageProvider } from "../storage/provider";
import type { ParseProvider } from "../parse/provider";
import type { ParseConfig } from "../parse/factory";
import type { QueuedJob } from "../queue/provider";
import { extractFields, type ModelProvider } from "../extract";
import { resolveTenantProvider } from "../extract/resolve-endpoint";
import { resolveMimeType } from "../ingestion/mime";
import { resolveParse, parseDocument } from "../ingestion/seam";
import { createNotification } from "../notifications/emit";
import { formatSemver } from "./semver";
import {
  computeValidateResult,
  type RoutingPlan,
  type ValidateDocResult,
  type ValidateParseFailure,
  type ValidateResult,
} from "./validate-scoring";

/** The `schema.validate.doc` job payload — one corpus entry of one run. */
export interface ValidateDocJobPayload {
  schemaRunId: string;
  corpusEntryId: string;
  /** Model preference forwarded from the validate request body. */
  model?: string | null;
}

/** Everything a per-doc unit needs that is constant across the run. */
export interface ValidateRunContext {
  tenantId: string;
  schemaRunId: string;
  schemaId: string;
  schemaVersionId: string;
  schemaDef: Record<string, unknown>;
  yamlHash: string;
  provider: ModelProvider;
  extractModel: string;
  parseProvider: ParseProvider;
  parseFingerprint: string;
  triggeredBy: string | null;
}

// Module state for the queue handler — mirrors initIngestionHandler. The
// routes drive these units with request-scoped deps instead.
let _db: Db | null = null;
let _storage: StorageProvider | null = null;
let _parseProvider: ParseProvider | null = null;
let _parseConfig: ParseConfig | null = null;

export function initValidateRunner(
  db: Db,
  storage: StorageProvider,
  parseProvider: ParseProvider,
  parseConfig?: ParseConfig,
) {
  _db = db;
  _storage = storage;
  _parseProvider = parseProvider;
  _parseConfig = parseConfig ?? null;
}

/**
 * Rebuild the run-constant context from the schema_run row — used by the
 * queue handler, where each job starts from nothing but ids. Returns null
 * when the run (or its version) no longer exists; the job then no-ops.
 */
export async function loadValidateRunContext(
  db: Db,
  tenantId: string,
  schemaRunId: string,
  opts: {
    model?: string | null;
    defaultParseProvider: ParseProvider;
    parseConfig: ParseConfig | null;
  },
): Promise<ValidateRunContext | null> {
  const [run] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        schemaId: schema.schemaRuns.schemaId,
        schemaVersionId: schema.schemaRuns.schemaVersionId,
        triggeredBy: schema.schemaRuns.triggeredBy,
      })
      .from(schema.schemaRuns)
      .where(eq(schema.schemaRuns.id, schemaRunId))
      .limit(1),
  );
  if (!run) return null;

  // Provider resolution below is confined to the schema's project —
  // model/parse endpoints are project-scoped resources.
  const [schemaRow] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ projectId: schema.schemas.projectId })
      .from(schema.schemas)
      .where(eq(schema.schemas.id, run.schemaId))
      .limit(1),
  );
  const rlsScope = schemaRow ? { tenantId, projectId: schemaRow.projectId } : tenantId;

  const [version] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ yamlSource: schema.schemaVersions.yamlSource })
      .from(schema.schemaVersions)
      .where(eq(schema.schemaVersions.id, run.schemaVersionId))
      .limit(1),
  );
  if (!version?.yamlSource) return null;

  let schemaDef: Record<string, unknown>;
  try {
    schemaDef = parseYaml(version.yamlSource) as Record<string, unknown>;
  } catch {
    return null;
  }

  const { provider, model: extractModel } = await resolveTenantProvider(db, rlsScope, {
    preferModel: opts.model ?? null,
  });
  const { provider: parseProvider, fingerprint: parseFingerprint } = await resolveParse(
    db,
    rlsScope,
    {
      parseProviderId: null,
      defaultProvider: opts.defaultParseProvider,
      parseConfig: opts.parseConfig,
    },
  );

  return {
    tenantId,
    schemaRunId,
    schemaId: run.schemaId,
    schemaVersionId: run.schemaVersionId,
    schemaDef,
    yamlHash: createHash("sha256").update(version.yamlSource).digest("hex"),
    provider,
    extractModel,
    parseProvider,
    parseFingerprint,
    triggeredBy: run.triggeredBy,
  };
}

/** Upsert this entry's progress row — retried jobs overwrite, never double-count. */
async function recordDocRow(
  db: Db,
  ctx: ValidateRunContext,
  corpusEntryId: string,
  row: {
    status: "ok" | "failed";
    errorMessage?: string | null;
    routingPlanJson?: RoutingPlan | null;
    durationMs: number;
  },
): Promise<void> {
  await withRLS(db, ctx.tenantId, (tx) =>
    tx
      .insert(schema.schemaRunDocs)
      .values({
        tenantId: ctx.tenantId,
        schemaRunId: ctx.schemaRunId,
        corpusEntryId,
        status: row.status,
        errorMessage: row.errorMessage ?? null,
        routingPlanJson: row.routingPlanJson ?? null,
        durationMs: row.durationMs,
      })
      .onConflictDoUpdate({
        target: [schema.schemaRunDocs.schemaRunId, schema.schemaRunDocs.corpusEntryId],
        set: {
          status: row.status,
          errorMessage: row.errorMessage ?? null,
          routingPlanJson: row.routingPlanJson ?? null,
          durationMs: row.durationMs,
        },
      }),
  );
}

/**
 * Run ONE corpus entry of a validate run: parse (via the shared seam + cache),
 * extract, persist the extraction_runs row, and record the outcome in
 * schema_run_docs. Never throws for document-level failures — those become a
 * `failed` progress row (the async equivalent of the old loop's
 * `parseFailures` bucket). Only infrastructure errors (e.g. the progress-row
 * write itself failing) propagate, so a queue retry gets a clean re-run.
 */
export async function runValidateDoc(
  db: Db,
  storage: StorageProvider,
  ctx: ValidateRunContext,
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
        contentHash: schema.corpusEntries.contentHash,
      })
      .from(schema.corpusEntries)
      .where(eq(schema.corpusEntries.id, corpusEntryId))
      .limit(1),
  );
  if (!entry) {
    await recordDocRow(db, ctx, corpusEntryId, {
      status: "failed",
      errorMessage: "corpus entry not found",
      durationMs: Date.now() - started,
    });
    return;
  }

  try {
    const fileResult = await storage.getBuffer(entry.storageKey);
    if (!fileResult) throw new Error("file not found in storage");

    // Parse via the shared seam (oss-310): provider-aware cache, nested
    // text_map. MIME is normalized with the buffer first so a sloppy stored
    // value never hard-fails the parse (#401).
    const mimeType = resolveMimeType(entry.mimeType, entry.filename, fileResult.data);
    const parsed = await parseDocument({
      db,
      storage,
      tenantId: ctx.tenantId,
      document: {
        id: entry.id,
        storageKey: entry.storageKey,
        filename: entry.filename,
        mimeType,
        contentHash: entry.contentHash,
      },
      provider: ctx.parseProvider,
      fingerprint: ctx.parseFingerprint,
    });
    if (!parsed.markdown) throw new Error("parse returned empty markdown");

    const extractResult = await extractFields(
      parsed.markdown,
      ctx.schemaDef,
      ctx.provider,
      ctx.extractModel,
      parsed.textMap,
      parsed.chunks,
    );

    // Persist the per-doc extraction, linked to this schema_run. The finalizer
    // reads extracted values back from this row (it's the only copy), the
    // performance heatmap joins on schema_run_id, and the next validate's
    // regression baseline reads the latest run per corpus entry. Unlike the
    // old in-memory loop this insert MUST succeed — a failure here fails the
    // doc (honest) instead of silently scoring it as an empty extraction.
    await withRLS(db, ctx.tenantId, (tx) =>
      tx.insert(schema.extractionRuns).values({
        tenantId: ctx.tenantId,
        schemaId: ctx.schemaId,
        schemaVersionId: ctx.schemaVersionId,
        schemaRunId: ctx.schemaRunId,
        corpusEntryId: entry.id,
        model: String(extractResult.model ?? ctx.extractModel ?? "unknown"),
        schemaYamlHash: ctx.yamlHash,
        extractedJson: extractResult.extracted ?? {},
        confidenceJson: extractResult.confidence ?? null,
        confidenceScoresJson: extractResult.confidence_scores ?? null,
        provenanceJson: extractResult.provenance ?? null,
        markdownText: parsed.markdown,
        parseSeconds: null,
        extractMs: (extractResult.elapsed_ms as number) ?? null,
        ocrSkipped: parsed.ocr_skipped ? "true" : "false",
        cached: parsed.cached ? "true" : "false",
        triggeredBy: ctx.triggeredBy,
      }),
    );

    await recordDocRow(db, ctx, corpusEntryId, {
      status: "ok",
      routingPlanJson: (extractResult.routing_plan as RoutingPlan) ?? null,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`[validate] Failed to extract ${entry.filename}:`, error);
    await recordDocRow(db, ctx, corpusEntryId, {
      status: "failed",
      errorMessage: error,
      durationMs: Date.now() - started,
    });
  }
}

/** A schema_run_docs progress row, as the finalizer reads it. */
export interface FinalizeDocRow {
  corpusEntryId: string;
  status: string;
  errorMessage: string | null;
  routingPlanJson: unknown;
}

/**
 * Sort every progress row into exactly one of `results` (scored) or
 * `parseFailures` (surfaced, counted in docsTotal — oss-308). A doc whose
 * extraction row is missing (insert failed, or a partial retry) fails
 * honestly instead of scoring as an empty extraction. Pure — unit-tested
 * without a database.
 */
export function assembleValidateInputs(
  docRows: FinalizeDocRow[],
  entryById: Map<string, { filename: string; groundTruthJson: unknown }>,
  extractionByEntry: Map<string, { extractedJson: unknown; confidenceScoresJson: unknown }>,
): { results: ValidateDocResult[]; parseFailures: ValidateParseFailure[] } {
  const results: ValidateDocResult[] = [];
  const parseFailures: ValidateParseFailure[] = [];
  for (const docRow of docRows) {
    const entry = entryById.get(docRow.corpusEntryId);
    const filename = entry?.filename ?? docRow.corpusEntryId;
    const extraction = extractionByEntry.get(docRow.corpusEntryId);
    if (docRow.status !== "ok" || !extraction || !entry) {
      parseFailures.push({
        entryId: docRow.corpusEntryId,
        filename,
        error: docRow.errorMessage ?? "extraction result missing",
      });
      continue;
    }
    results.push({
      entryId: docRow.corpusEntryId,
      filename,
      groundTruth: entry.groundTruthJson as Record<string, unknown>,
      extracted: (extraction.extractedJson as Record<string, unknown>) ?? {},
      confidenceScores: (extraction.confidenceScoresJson as Record<string, number>) ?? {},
      routingPlan: (docRow.routingPlanJson as RoutingPlan) ?? undefined,
    });
  }
  return { results, parseFailures };
}

export type FinalizeOutcome =
  | { finalized: false }
  | { finalized: true; status: "failed"; error: string; parseFailures: ValidateParseFailure[] }
  | { finalized: true; status: "completed"; result: ValidateResult & { version: string | null } };

/**
 * Score + persist the run once every corpus entry has a progress row.
 *
 * Safe to call after every doc (both drivers do): it no-ops until the last
 * row lands, and the `running/queued → finalizing` status flip is atomic, so
 * two docs finishing simultaneously can't both score the run. Returns the
 * outcome so the sync driver can serve it without a re-read.
 */
export async function maybeFinalizeValidateRun(
  db: Db,
  tenantId: string,
  schemaRunId: string,
): Promise<FinalizeOutcome> {
  const [run] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.schemaRuns.id,
        schemaVersionId: schema.schemaRuns.schemaVersionId,
        status: schema.schemaRuns.status,
        docsTotal: schema.schemaRuns.docsTotal,
        startedAt: schema.schemaRuns.startedAt,
        createdAt: schema.schemaRuns.createdAt,
        projectId: schema.schemas.projectId,
      })
      .from(schema.schemaRuns)
      .innerJoin(schema.schemas, eq(schema.schemas.id, schema.schemaRuns.schemaId))
      .where(eq(schema.schemaRuns.id, schemaRunId))
      .limit(1),
  );
  if (!run || (run.status !== "queued" && run.status !== "running")) return { finalized: false };

  const docRows = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        corpusEntryId: schema.schemaRunDocs.corpusEntryId,
        status: schema.schemaRunDocs.status,
        errorMessage: schema.schemaRunDocs.errorMessage,
        routingPlanJson: schema.schemaRunDocs.routingPlanJson,
      })
      .from(schema.schemaRunDocs)
      .where(eq(schema.schemaRunDocs.schemaRunId, schemaRunId)),
  );
  if (docRows.length < run.docsTotal) return { finalized: false };

  // Atomic claim — exactly one finisher proceeds past this line.
  const claimed = await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.schemaRuns)
      .set({ status: "finalizing" })
      .where(
        and(
          eq(schema.schemaRuns.id, schemaRunId),
          inArray(schema.schemaRuns.status, ["queued", "running"]),
        ),
      )
      .returning({ id: schema.schemaRuns.id }),
  );
  if (claimed.length === 0) return { finalized: false };

  const [version] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        versionNumber: schema.schemaVersions.versionNumber,
        yamlSource: schema.schemaVersions.yamlSource,
        major: schema.schemaVersions.major,
        minor: schema.schemaVersions.minor,
        patch: schema.schemaVersions.patch,
        prerelease: schema.schemaVersions.prerelease,
      })
      .from(schema.schemaVersions)
      .where(eq(schema.schemaVersions.id, run.schemaVersionId))
      .limit(1),
  );

  let schemaFields: Record<string, Record<string, unknown>> | undefined;
  try {
    const parsed = version?.yamlSource
      ? (parseYaml(version.yamlSource) as Record<string, unknown>)
      : undefined;
    schemaFields = (parsed?.fields as Record<string, Record<string, unknown>>) ?? undefined;
  } catch {
    schemaFields = undefined;
  }

  const entryIds = docRows.map((d) => d.corpusEntryId);
  const entries = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.corpusEntries.id,
        filename: schema.corpusEntries.filename,
        groundTruthJson: schema.corpusEntries.groundTruthJson,
      })
      .from(schema.corpusEntries)
      .where(inArray(schema.corpusEntries.id, entryIds)),
  );
  const entryById = new Map(entries.map((e) => [e.id, e]));

  // This run's extractions — the only copy of what each doc produced.
  const extractionRows = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        corpusEntryId: schema.extractionRuns.corpusEntryId,
        extractedJson: schema.extractionRuns.extractedJson,
        confidenceScoresJson: schema.extractionRuns.confidenceScoresJson,
      })
      .from(schema.extractionRuns)
      .where(eq(schema.extractionRuns.schemaRunId, schemaRunId))
      .orderBy(desc(schema.extractionRuns.createdAt)),
  );
  const extractionByEntry = new Map<string, (typeof extractionRows)[number]>();
  for (const row of extractionRows) {
    if (row.corpusEntryId && !extractionByEntry.has(row.corpusEntryId)) {
      extractionByEntry.set(row.corpusEntryId, row);
    }
  }

  // Regression baseline: the latest extraction per entry from BEFORE this run
  // was created — same baseline the old in-request loop captured up front.
  const prevExtractedMap = new Map<string, Record<string, unknown>>();
  for (const entryId of entryIds) {
    const [prev] = await withRLS(db, tenantId, (tx) =>
      tx
        .select({ extractedJson: schema.extractionRuns.extractedJson })
        .from(schema.extractionRuns)
        .where(
          and(
            eq(schema.extractionRuns.corpusEntryId, entryId),
            lt(schema.extractionRuns.createdAt, run.createdAt),
          ),
        )
        .orderBy(desc(schema.extractionRuns.createdAt))
        .limit(1),
    );
    if (prev) prevExtractedMap.set(entryId, prev.extractedJson as Record<string, unknown>);
  }

  const { results, parseFailures } = assembleValidateInputs(docRows, entryById, extractionByEntry);

  const startTime = (run.startedAt ?? run.createdAt).getTime();

  if (results.length === 0) {
    const error = "All extractions failed";
    await withRLS(db, tenantId, (tx) =>
      tx
        .update(schema.schemaRuns)
        .set({
          status: "failed",
          completedAt: new Date(),
          errorMessage: error,
          durationMs: Date.now() - startTime,
          resultJson: { error, parseFailures },
        })
        .where(eq(schema.schemaRuns.id, schemaRunId)),
    );
    return { finalized: true, status: "failed", error, parseFailures };
  }

  const validateResult = computeValidateResult(
    results,
    prevExtractedMap,
    version?.versionNumber ?? 0,
    startTime,
    parseFailures,
    schemaFields,
  );
  const versionLabel = version ? formatSemver(version) : null;
  const resultJson = { ...validateResult, version: versionLabel };

  await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.schemaRuns)
      .set({
        status: "completed",
        completedAt: new Date(),
        docsTotal: validateResult.docsTotal,
        docsPassed: validateResult.docsPassed,
        regressionsCount: validateResult.regressions.length,
        accuracy: String(validateResult.overallAccuracy / 100), // stored as 0.0-1.0
        durationMs: validateResult.durationMs,
        resultJson,
      })
      .where(eq(schema.schemaRuns.id, schemaRunId)),
  );

  if (validateResult.regressions.length > 0) {
    createNotification({ tenantId, projectId: run.projectId }, {
      type: "validate.regression",
      title: `Validate regression detected`,
      body: `${validateResult.regressions.length} field regression(s) on ${validateResult.docsTotal} docs (${validateResult.overallAccuracy.toFixed(1)}% accuracy)`,
      data: {
        schemaRunId,
        regressionsCount: validateResult.regressions.length,
        docsTotal: validateResult.docsTotal,
        accuracy: validateResult.overallAccuracy,
      },
    });
  }

  return { finalized: true, status: "completed", result: resultJson };
}

/**
 * Queue handler for `schema.validate.doc` — one corpus entry per job.
 * Registered in createApp's HandlerMap; the platform's Inngest adapter picks
 * it up from the same registry, so each doc runs as its own invocation and
 * the run's wall clock never races a per-request timeout.
 */
export async function handleSchemaValidateDoc(job: QueuedJob): Promise<void> {
  if (!_db || !_storage || !_parseProvider) {
    throw new Error("Validate runner not initialized — call initValidateRunner() first");
  }
  const { schemaRunId, corpusEntryId, model } = job.payload as unknown as ValidateDocJobPayload;

  const ctx = await loadValidateRunContext(_db, job.tenantId, schemaRunId, {
    model: model ?? null,
    defaultParseProvider: _parseProvider,
    parseConfig: _parseConfig,
  });
  // Run or version gone (schema deleted mid-run) — nothing to do.
  if (!ctx) return;

  await runValidateDoc(_db, _storage, ctx, corpusEntryId);
  await maybeFinalizeValidateRun(_db, job.tenantId, schemaRunId);
}
