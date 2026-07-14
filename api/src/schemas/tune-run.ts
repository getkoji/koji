/**
 * Durable, resumable corpus-tuning run (oss — fan-out scoring).
 *
 * The corpus loop can't finish in one request (300s function cap), and even a
 * single corpus scoring is too big for one job — the baseline pass alone can
 * approach the cap on a real corpus. So a run is a small state machine advanced
 * by background jobs, and every corpus scoring FANS OUT one job per document:
 *
 *   tune.run.start    → init run, begin the BASELINE scoring pass (fan out)
 *   tune.score.doc    → extract ONE doc for the current pass, persist its row;
 *                       when the last doc lands, aggregate the pass and branch
 *   tune.run.propose  → ask the model for an edit (with rejected memory), then
 *                       begin a PROPOSAL scoring pass (fan out)
 *
 * Aggregation happens inside the finalizing `tune.score.doc` (mirrors validate's
 * maybeFinalize): an atomic phase compare-and-swap guarantees exactly one
 * finisher. No single job scores more than one document, so runs of any corpus
 * size stay under the cap, and `docs_scored/docs_total` give the UI live
 * progress instead of a silent "Starting…". Rejected proposals persist in
 * `tune_run_rounds` as the "don't retread this" memory for later rounds/runs.
 */

import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { schema, withRLS, type Db } from "@koji/db";
import type { StorageProvider } from "../storage/provider";
import type { ParseProvider } from "../parse/provider";
import type { ParseConfig } from "../parse/factory";
import type { QueueProvider, QueuedJob } from "../queue/provider";
import { compileSchema } from "./compiler";
import { resolveTenantProvider } from "../extract/resolve-endpoint";
import { computeValidateResult } from "./validate-scoring";
import {
  pickFocus,
  proposeEdit,
  type CorpusEntryWithGt,
  type ScoreResult,
  type TuneFocus,
} from "./corpus-tune-loop";
import { extractEntryValues, type EntryExtraction } from "./tune";

const MAX_ITERATIONS_CAP = 8;
const NO_IMPROVEMENT_LIMIT = 3;
const TARGET = 100;
/**
 * Accuracy comparison tolerance (percentage points). Covers the float32 the DB
 * stores `best_accuracy` as (83.3333 becomes 83.333336) vs. the float64
 * recomputed each round, plus minor extraction non-determinism — so a genuine
 * lateral/tie proposal isn't rejected on a rounding artifact.
 */
const ACCURACY_EPSILON = 0.05;
/** How much of each doc's markdown we keep — the focus excerpt needs only the head. */
const MARKDOWN_KEEP = 4000;

type Phase = "baseline" | "proposal" | "proposing";

export interface TuneStartPayload {
  runId: string;
}
export interface TuneScoreDocPayload {
  runId: string;
  pass: number;
  entryId: string;
}
export interface TuneProposePayload {
  runId: string;
}
/** Legacy round payload — kept so pre-fanout in-flight runs stop cleanly. */
export interface TuneRoundPayload {
  runId: string;
}

/** Carried-forward best score: what to fix next + the regression baseline. */
interface BestSnapshot {
  focus: TuneFocus | null;
  prevExtracted: Record<string, Record<string, unknown>>;
}

/** What a proposal pass needs to record its round once scoring finishes. */
interface PendingProposal {
  n: number;
  explanation: string;
  thinking: string;
  focus: TuneFocus;
}

// Module deps (mirrors initValidateRunner) — set once at startup; the routes
// enqueue, the worker executes.
let _db: Db | null = null;
let _storage: StorageProvider | null = null;
let _parseProvider: ParseProvider | null = null;
let _parseConfig: ParseConfig | null = null;
let _queue: QueueProvider | null = null;

export function initTuneRunHandlers(
  db: Db,
  storage: StorageProvider,
  parseProvider: ParseProvider,
  queue: QueueProvider,
  parseConfig?: ParseConfig,
) {
  _db = db;
  _storage = storage;
  _parseProvider = parseProvider;
  _queue = queue;
  _parseConfig = parseConfig ?? null;
}

function deps() {
  if (!_db || !_storage || !_parseProvider || !_queue) {
    throw new Error("Tune run handlers not initialized — call initTuneRunHandlers()");
  }
  return {
    db: _db,
    storage: _storage,
    parseProvider: _parseProvider,
    parseConfig: _parseConfig,
    queue: _queue,
  };
}

async function loadEntries(db: Db, tenantId: string, schemaId: string): Promise<CorpusEntryWithGt[]> {
  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.corpusEntries.id,
        filename: schema.corpusEntries.filename,
        storageKey: schema.corpusEntries.storageKey,
        mimeType: schema.corpusEntries.mimeType,
        contentHash: schema.corpusEntries.contentHash,
        groundTruthJson: schema.corpusEntries.groundTruthJson,
      })
      .from(schema.corpusEntries)
      .where(and(eq(schema.corpusEntries.schemaId, schemaId))),
  );
  return rows
    .filter((r) => {
      const gt = r.groundTruthJson as Record<string, unknown> | null;
      return gt != null && typeof gt === "object" && Object.keys(gt).length > 0;
    })
    .map((r) => ({
      id: r.id,
      filename: r.filename,
      storageKey: r.storageKey,
      mimeType: r.mimeType,
      contentHash: r.contentHash,
      groundTruth: r.groundTruthJson as Record<string, unknown>,
    }));
}

const scoreDeps = (tenantId: string) => ({
  db: _db!,
  storage: _storage!,
  scope: tenantId,
  tenantId,
  defaultParseProvider: _parseProvider!,
  parseConfig: _parseConfig,
});

function buildSnapshot(
  result: ScoreResult,
  entryById: Map<string, CorpusEntryWithGt>,
  extractedByEntry: Map<string, EntryExtraction>,
): BestSnapshot {
  return {
    focus: pickFocus(result, entryById, extractedByEntry),
    prevExtracted: Object.fromEntries([...extractedByEntry].map(([id, ex]) => [id, ex.extracted])),
  };
}

async function fail(db: Db, tenantId: string, runId: string, message: string) {
  await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.tuneRuns)
      .set({ status: "failed", stopReason: "error", error: message, phase: null, updatedAt: new Date() })
      .where(eq(schema.tuneRuns.id, runId)),
  );
}

async function finalize(db: Db, tenantId: string, runId: string, stopReason: string) {
  await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.tuneRuns)
      .set({
        status: stopReason === "passed" ? "passed" : "stopped",
        stopReason,
        phase: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.tuneRuns.id, runId)),
  );
}

/**
 * Set up a scoring pass and fan out one `tune.score.doc` job per document. The
 * pass columns are written first (so a doc job that runs immediately sees the
 * right `scoringPass`/`docsTotal`), then the jobs are enqueued.
 */
async function beginScoringPass(
  db: Db,
  queue: QueueProvider,
  tenantId: string,
  runId: string,
  pass: number,
  phase: Extract<Phase, "baseline" | "proposal">,
  pendingYaml: string,
  pendingProposal: PendingProposal | null,
  entries: CorpusEntryWithGt[],
  extra?: Partial<{ currentRound: number }>,
) {
  await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.tuneRuns)
      .set({
        phase,
        scoringPass: pass,
        pendingYaml,
        pendingProposalJson: pendingProposal,
        docsTotal: entries.length,
        docsScored: 0,
        ...(extra?.currentRound != null ? { currentRound: extra.currentRound } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.tuneRuns.id, runId)),
  );
  for (const e of entries) {
    await queue.enqueue(
      "tune.score.doc",
      { runId, pass, entryId: e.id } satisfies TuneScoreDocPayload,
      { tenantId, maxRetries: 2 },
    );
  }
}

// ── tune.run.start ─────────────────────────────────────────────────────────

export async function handleTuneRunStart(job: QueuedJob): Promise<void> {
  const { db, queue } = deps();
  const { runId } = job.payload as unknown as TuneStartPayload;
  const tenantId = job.tenantId;

  const [run] = await withRLS(db, tenantId, (tx) =>
    tx.select().from(schema.tuneRuns).where(eq(schema.tuneRuns.id, runId)).limit(1),
  );
  if (!run || run.status !== "queued") return;

  try {
    const compiled = compileSchema(run.startYaml);
    if (!compiled.ok) {
      await fail(db, tenantId, runId, "starting schema invalid");
      return;
    }
    const entries = await loadEntries(db, tenantId, run.schemaId);
    if (entries.length === 0) {
      await fail(db, tenantId, runId, "no labeled documents to tune against");
      return;
    }
    await withRLS(db, tenantId, (tx) =>
      tx.update(schema.tuneRuns).set({ status: "running", updatedAt: new Date() }).where(eq(schema.tuneRuns.id, runId)),
    );
    await beginScoringPass(db, queue, tenantId, runId, 1, "baseline", run.startYaml, null, entries);
  } catch (err) {
    await fail(db, tenantId, runId, err instanceof Error ? err.message : String(err));
  }
}

// ── tune.score.doc ─────────────────────────────────────────────────────────

export async function handleTuneScoreDoc(job: QueuedJob): Promise<void> {
  const { db, queue } = deps();
  const { runId, pass, entryId } = job.payload as unknown as TuneScoreDocPayload;
  const tenantId = job.tenantId;

  const [run] = await withRLS(db, tenantId, (tx) =>
    tx.select().from(schema.tuneRuns).where(eq(schema.tuneRuns.id, runId)).limit(1),
  );
  // Stale job (pass already finalized, or run stopped) — nothing to do.
  if (!run || run.status !== "running" || run.scoringPass !== pass || !run.pendingYaml) return;

  const compiled = compileSchema(run.pendingYaml);
  const entries = await loadEntries(db, tenantId, run.schemaId);
  const entry = entries.find((e) => e.id === entryId);

  let extractionJson: Record<string, unknown> | null = null;
  let status = "ok";
  if (!entry || !compiled.ok) {
    status = "failed";
  } else {
    try {
      const ex = await extractEntryValues({
        ...scoreDeps(tenantId),
        entry,
        schemaDef: compiled.parsed as Record<string, unknown>,
        model: run.model ?? undefined,
      });
      extractionJson = {
        extracted: ex.extracted,
        confidenceScores: ex.confidenceScores,
        routingPlan: ex.routingPlan,
        markdown: ex.markdown.slice(0, MARKDOWN_KEEP),
      };
    } catch {
      status = "failed"; // parse/extract failure — dropped from scoring, like the in-request loop
    }
  }

  // Upsert this doc's row — a retried job overwrites, never double-counts.
  await withRLS(db, tenantId, (tx) =>
    tx
      .insert(schema.tuneScoreDocs)
      .values({ tenantId, runId, pass, entryId, status, extractionJson })
      .onConflictDoUpdate({
        target: [schema.tuneScoreDocs.runId, schema.tuneScoreDocs.pass, schema.tuneScoreDocs.entryId],
        set: { status, extractionJson, createdAt: new Date() },
      }),
  );

  await maybeFinalizePass(db, queue, tenantId, runId, pass);
}

/**
 * When every document for `pass` has a row, aggregate the pass and advance the
 * run. An atomic phase compare-and-swap (baseline|proposal → proposing) elects
 * exactly one finisher, so concurrent last-doc jobs don't double-finalize.
 */
async function maybeFinalizePass(
  db: Db,
  queue: QueueProvider,
  tenantId: string,
  runId: string,
  pass: number,
): Promise<void> {
  const [run] = await withRLS(db, tenantId, (tx) =>
    tx.select().from(schema.tuneRuns).where(eq(schema.tuneRuns.id, runId)).limit(1),
  );
  if (!run || run.status !== "running" || run.scoringPass !== pass) return;
  const wasPhase = run.phase as Phase | null;
  if (wasPhase !== "baseline" && wasPhase !== "proposal") return;

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        entryId: schema.tuneScoreDocs.entryId,
        status: schema.tuneScoreDocs.status,
        extractionJson: schema.tuneScoreDocs.extractionJson,
      })
      .from(schema.tuneScoreDocs)
      .where(and(eq(schema.tuneScoreDocs.runId, runId), eq(schema.tuneScoreDocs.pass, pass))),
  );
  // Keep the progress counter honest even before completion.
  await withRLS(db, tenantId, (tx) =>
    tx.update(schema.tuneRuns).set({ docsScored: rows.length, updatedAt: new Date() }).where(eq(schema.tuneRuns.id, runId)),
  );
  if (rows.length < run.docsTotal) return;

  // Atomic claim — exactly one finisher proceeds past here.
  const claimed = await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.tuneRuns)
      .set({ phase: "proposing", updatedAt: new Date() })
      .where(
        and(
          eq(schema.tuneRuns.id, runId),
          eq(schema.tuneRuns.scoringPass, pass),
          inArray(schema.tuneRuns.phase, ["baseline", "proposal"]),
        ),
      )
      .returning({ id: schema.tuneRuns.id }),
  );
  if (claimed.length === 0) return;

  // Reconstruct per-doc extractions + entry lookups for scoring/focus.
  const entries = await loadEntries(db, tenantId, run.schemaId);
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const extractedByEntry = new Map<string, EntryExtraction>();
  for (const r of rows) {
    if (r.status !== "ok" || !r.extractionJson) continue;
    const ex = r.extractionJson as Record<string, unknown>;
    extractedByEntry.set(r.entryId, {
      extracted: (ex.extracted as Record<string, unknown>) ?? {},
      confidenceScores: (ex.confidenceScores as Record<string, number>) ?? {},
      routingPlan: ex.routingPlan as Record<string, unknown> | undefined,
      markdown: (ex.markdown as string) ?? "",
    });
  }

  const scoreInputs = [...extractedByEntry].flatMap(([id, ex]) => {
    const e = entryById.get(id);
    if (!e) return [];
    return [
      {
        entryId: id,
        filename: e.filename,
        groundTruth: e.groundTruth,
        extracted: ex.extracted,
        confidenceScores: ex.confidenceScores,
        routingPlan: (ex.routingPlan as never) ?? undefined,
      },
    ];
  });

  const compiled = compileSchema(run.pendingYaml ?? run.bestYaml);
  const schemaFields = compiled.ok
    ? (((compiled.parsed as Record<string, unknown>).fields as Record<string, Record<string, unknown>>) ?? {})
    : {};

  if (wasPhase === "baseline") {
    const result = computeValidateResult(scoreInputs, new Map(), 0, Date.now(), [], schemaFields);
    await finalizeBaseline(db, queue, tenantId, run, result, entryById, extractedByEntry);
  } else {
    const snapshot = run.bestSnapshotJson as BestSnapshot | null;
    const prevMap = new Map(Object.entries(snapshot?.prevExtracted ?? {}));
    const result = computeValidateResult(scoreInputs, prevMap, 0, Date.now(), [], schemaFields);
    await finalizeProposal(db, queue, tenantId, run, result, entryById, extractedByEntry);
  }
}

type RunRow = typeof schema.tuneRuns.$inferSelect;

async function finalizeBaseline(
  db: Db,
  queue: QueueProvider,
  tenantId: string,
  run: RunRow,
  result: ScoreResult,
  entryById: Map<string, CorpusEntryWithGt>,
  extractedByEntry: Map<string, EntryExtraction>,
): Promise<void> {
  const snapshot = buildSnapshot(result, entryById, extractedByEntry);
  const acc = result.overallAccuracy;
  const done = acc >= TARGET || !snapshot.focus;
  await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.tuneRuns)
      .set({
        baselineAccuracy: acc,
        bestAccuracy: acc,
        bestSnapshotJson: snapshot,
        status: done ? "passed" : "running",
        stopReason: done ? "passed" : null,
        phase: done ? null : "proposing",
        updatedAt: new Date(),
      })
      .where(eq(schema.tuneRuns.id, run.id)),
  );
  if (done) return;
  await queue.enqueue("tune.run.propose", { runId: run.id } satisfies TuneProposePayload, { tenantId, maxRetries: 1 });
}

async function finalizeProposal(
  db: Db,
  queue: QueueProvider,
  tenantId: string,
  run: RunRow,
  result: ScoreResult,
  entryById: Map<string, CorpusEntryWithGt>,
  extractedByEntry: Map<string, EntryExtraction>,
): Promise<void> {
  const pending = run.pendingProposalJson as PendingProposal | null;
  if (!pending) {
    // Shouldn't happen — a proposal pass always sets this. Fail loud-ish.
    await fail(db, tenantId, run.id, "proposal pass missing pending proposal");
    return;
  }
  const bestAcc = run.bestAccuracy ?? 0;
  const acc = result.overallAccuracy;
  const improved = acc > bestAcc + ACCURACY_EPSILON;
  const accepted = acc >= bestAcc - ACCURACY_EPSILON && result.regressions.length === 0;

  await recordRound(db, tenantId, run.id, pending.n, {
    accepted,
    focus: pending.focus,
    thinking: pending.thinking,
    explanation: pending.explanation,
    accuracy: acc,
    docsPassed: result.docsPassed,
    docsTotal: result.docsTotal,
    regressions: result.regressions.map((r) => r.name),
    yaml: run.pendingYaml,
  });

  let newBestAcc = bestAcc;
  if (accepted) {
    const newSnapshot = buildSnapshot(result, entryById, extractedByEntry);
    newBestAcc = acc;
    await withRLS(db, tenantId, (tx) =>
      tx
        .update(schema.tuneRuns)
        .set({ bestYaml: run.pendingYaml!, bestAccuracy: acc, bestSnapshotJson: newSnapshot, updatedAt: new Date() })
        .where(eq(schema.tuneRuns.id, run.id)),
    );
  }
  await advance(db, queue, tenantId, run.id, pending.n, newBestAcc, improved);
}

// ── tune.run.propose ───────────────────────────────────────────────────────

export async function handleTuneRunPropose(job: QueuedJob): Promise<void> {
  const { db, queue } = deps();
  const { runId } = job.payload as unknown as TuneProposePayload;
  const tenantId = job.tenantId;

  const [run] = await withRLS(db, tenantId, (tx) =>
    tx.select().from(schema.tuneRuns).where(eq(schema.tuneRuns.id, runId)).limit(1),
  );
  if (!run || run.status !== "running" || run.phase !== "proposing") return;

  const n = run.currentRound + 1;
  try {
    if (n > Math.min(run.maxIterations, MAX_ITERATIONS_CAP)) {
      await finalize(db, tenantId, runId, "max_iterations");
      return;
    }
    const snapshot = run.bestSnapshotJson as BestSnapshot | null;
    if (!snapshot?.focus) {
      await finalize(db, tenantId, runId, "passed");
      return;
    }

    // Rejected proposals so far — the "don't retread" memory.
    const prior = await withRLS(db, tenantId, (tx) =>
      tx
        .select({ accepted: schema.tuneRunRounds.accepted, explanation: schema.tuneRunRounds.explanation })
        .from(schema.tuneRunRounds)
        .where(eq(schema.tuneRunRounds.runId, runId))
        .orderBy(asc(schema.tuneRunRounds.n)),
    );
    const rejected = prior.filter((r) => !r.accepted && r.explanation).map((r) => r.explanation!).slice(-6);

    const { provider } = await resolveTenantProvider(db, tenantId, run.model ? { preferModel: run.model } : undefined);
    let thinking = "";
    const proposal = await proposeEdit(
      provider,
      run.bestYaml,
      run.bestAccuracy ?? 0,
      snapshot.focus,
      (delta) => {
        thinking += delta;
      },
      rejected,
    );

    if (!proposal) {
      await recordRound(db, tenantId, runId, n, {
        accepted: false,
        focus: snapshot.focus,
        thinking,
        explanation: "No valid proposal produced.",
        accuracy: run.bestAccuracy,
        docsPassed: null,
        docsTotal: null,
        regressions: [],
        yaml: null,
      });
      await advance(db, queue, tenantId, runId, n, run.bestAccuracy ?? 0, false);
      return;
    }

    const entries = await loadEntries(db, tenantId, run.schemaId);
    if (entries.length === 0) {
      await fail(db, tenantId, runId, "no labeled documents to tune against");
      return;
    }
    // Begin a PROPOSAL scoring pass — fan out, record the round once it lands.
    await beginScoringPass(
      db,
      queue,
      tenantId,
      runId,
      run.scoringPass + 1,
      "proposal",
      proposal.yaml,
      { n, explanation: proposal.explanation, thinking, focus: snapshot.focus },
      entries,
      { currentRound: n },
    );
  } catch (err) {
    await fail(db, tenantId, runId, err instanceof Error ? err.message : String(err));
  }
}

/** Decide whether to stop or propose again, updating currentRound + stall tracking. */
async function advance(
  db: Db,
  queue: QueueProvider,
  tenantId: string,
  runId: string,
  n: number,
  bestAccuracy: number,
  improved: boolean,
): Promise<void> {
  const [run] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ maxIterations: schema.tuneRuns.maxIterations })
      .from(schema.tuneRuns)
      .where(eq(schema.tuneRuns.id, runId))
      .limit(1),
  );
  const maxIterations = run?.maxIterations ?? 5;

  // Re-derive the trailing non-improving streak from round history (stateless).
  const recent = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ accuracy: schema.tuneRunRounds.accuracy })
      .from(schema.tuneRunRounds)
      .where(eq(schema.tuneRunRounds.runId, runId))
      .orderBy(asc(schema.tuneRunRounds.n)),
  );
  let stall = 0;
  let prevAcc = -1;
  for (const r of recent) {
    if (prevAcc >= 0 && (r.accuracy ?? 0) <= prevAcc) stall++;
    else stall = 0;
    prevAcc = Math.max(prevAcc, r.accuracy ?? 0);
  }

  await withRLS(db, tenantId, (tx) =>
    tx.update(schema.tuneRuns).set({ currentRound: n, phase: "proposing", updatedAt: new Date() }).where(eq(schema.tuneRuns.id, runId)),
  );

  void improved;
  if (bestAccuracy >= TARGET) {
    await finalize(db, tenantId, runId, "passed");
    return;
  }
  if (stall >= NO_IMPROVEMENT_LIMIT) {
    await finalize(db, tenantId, runId, "no_improvement");
    return;
  }
  if (n >= Math.min(maxIterations, MAX_ITERATIONS_CAP)) {
    await finalize(db, tenantId, runId, "max_iterations");
    return;
  }
  await queue.enqueue("tune.run.propose", { runId } satisfies TuneProposePayload, { tenantId, maxRetries: 1 });
}

async function recordRound(
  db: Db,
  tenantId: string,
  runId: string,
  n: number,
  r: {
    accepted: boolean;
    focus: TuneFocus;
    thinking: string;
    explanation: string;
    accuracy: number | null;
    docsPassed: number | null;
    docsTotal: number | null;
    regressions: string[];
    yaml: string | null;
  },
) {
  await withRLS(db, tenantId, (tx) =>
    tx.insert(schema.tuneRunRounds).values({
      tenantId,
      runId,
      n,
      accuracy: r.accuracy,
      docsPassed: r.docsPassed,
      docsTotal: r.docsTotal,
      accepted: r.accepted,
      focusDoc: r.focus.filename,
      fixingJson: r.focus.failing.map((f) => f.name),
      regressionsJson: r.regressions,
      explanation: r.explanation,
      thinking: r.thinking,
      proposedYaml: r.yaml,
      yamlHash: r.yaml ? createHash("sha256").update(r.yaml).digest("hex") : null,
    }),
  );
}

/**
 * Legacy shim: pre-fanout runs enqueued `tune.run.round`. That handler is gone,
 * so any such in-flight job just stops the run cleanly instead of orphaning it.
 */
export async function handleTuneRunRound(job: QueuedJob): Promise<void> {
  const { db } = deps();
  const { runId } = job.payload as unknown as TuneRoundPayload;
  const tenantId = job.tenantId;
  const [run] = await withRLS(db, tenantId, (tx) =>
    tx.select({ status: schema.tuneRuns.status }).from(schema.tuneRuns).where(eq(schema.tuneRuns.id, runId)).limit(1),
  );
  if (run && run.status === "running") await finalize(db, tenantId, runId, "superseded");
}
