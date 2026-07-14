/**
 * Durable, resumable corpus-tuning run (oss — "full background run").
 *
 * The corpus loop can't finish in one request (300s function cap), so it runs
 * as background jobs, one round per job — each job does a single corpus scoring
 * (of the proposal only; the best schema's score is carried forward in
 * `bestSnapshotJson`), staying well under the cap. State lives in `tune_runs` +
 * `tune_run_rounds`, so a run survives disconnects/timeouts, the UI polls it,
 * and rejected proposals become a memory the next round (and next run) avoids.
 *
 *   tune.run.start → score baseline, snapshot, enqueue round 1
 *   tune.run.round → propose (with rejected memory) → score proposal →
 *                    accept if it beats best without regressing → persist →
 *                    enqueue next round or finalize
 */

import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { schema, withRLS, type Db } from "@koji/db";
import type { StorageProvider } from "../storage/provider";
import type { ParseProvider } from "../parse/provider";
import type { ParseConfig } from "../parse/factory";
import type { QueueProvider, QueuedJob } from "../queue/provider";
import { compileSchema } from "./compiler";
import { resolveTenantProvider } from "../extract/resolve-endpoint";
import {
  scoreCorpus,
  pickFocus,
  proposeEdit,
  type CorpusEntryWithGt,
  type TuneFocus,
} from "./corpus-tune-loop";
import type { EntryExtraction } from "./tune";

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

export interface TuneStartPayload {
  runId: string;
}
export interface TuneRoundPayload {
  runId: string;
}

/** Carried-forward best score: what to fix next + the regression baseline. */
interface BestSnapshot {
  focus: TuneFocus | null;
  prevExtracted: Record<string, Record<string, unknown>>;
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
  return { db: _db, storage: _storage, parseProvider: _parseProvider, parseConfig: _parseConfig, queue: _queue };
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
      id: r.id, filename: r.filename, storageKey: r.storageKey, mimeType: r.mimeType, contentHash: r.contentHash,
      groundTruth: r.groundTruthJson as Record<string, unknown>,
    }));
}

const scoreDeps = (tenantId: string) => ({
  db: _db!, storage: _storage!, scope: tenantId, tenantId,
  defaultParseProvider: _parseProvider!, parseConfig: _parseConfig,
});

function buildSnapshot(
  result: Awaited<ReturnType<typeof scoreCorpus>>["result"],
  entryById: Map<string, CorpusEntryWithGt>,
  extractedByEntry: Map<string, EntryExtraction>,
): BestSnapshot {
  return {
    focus: pickFocus(result, entryById, extractedByEntry),
    prevExtracted: Object.fromEntries([...extractedByEntry].map(([id, ex]) => [id, ex.extracted])),
  };
}

async function finalize(db: Db, tenantId: string, runId: string, stopReason: string) {
  await withRLS(db, tenantId, (tx) =>
    tx.update(schema.tuneRuns)
      .set({ status: stopReason === "error" ? "failed" : stopReason === "passed" ? "passed" : "stopped", stopReason, updatedAt: new Date() })
      .where(eq(schema.tuneRuns.id, runId)),
  );
}

export async function handleTuneRunStart(job: QueuedJob): Promise<void> {
  const { db, queue } = deps();
  const { runId } = job.payload as unknown as TuneStartPayload;
  const tenantId = job.tenantId;

  const [run] = await withRLS(db, tenantId, (tx) =>
    tx.select().from(schema.tuneRuns).where(eq(schema.tuneRuns.id, runId)).limit(1),
  );
  if (!run || run.status !== "queued") return;

  try {
    const entries = await loadEntries(db, tenantId, run.schemaId);
    if (entries.length === 0) {
      await finalize(db, tenantId, runId, "error");
      return;
    }
    const entryById = new Map(entries.map((e) => [e.id, e]));
    const compiled = compileSchema(run.startYaml);
    if (!compiled.ok) {
      await withRLS(db, tenantId, (tx) => tx.update(schema.tuneRuns).set({ status: "failed", stopReason: "error", error: "starting schema invalid", updatedAt: new Date() }).where(eq(schema.tuneRuns.id, runId)));
      return;
    }
    const scored = await scoreCorpus(scoreDeps(tenantId), entries, compiled.parsed as Record<string, unknown>, run.model ?? undefined, new Map());
    const snapshot = buildSnapshot(scored.result, entryById, scored.extractedByEntry);
    const acc = scored.result.overallAccuracy;
    await withRLS(db, tenantId, (tx) =>
      tx.update(schema.tuneRuns).set({
        status: acc >= TARGET || !snapshot.focus ? "passed" : "running",
        baselineAccuracy: acc, bestAccuracy: acc, bestSnapshotJson: snapshot,
        stopReason: acc >= TARGET || !snapshot.focus ? "passed" : null,
        updatedAt: new Date(),
      }).where(eq(schema.tuneRuns.id, runId)),
    );
    if (acc >= TARGET || !snapshot.focus) return;
    await queue.enqueue("tune.run.round", { runId } satisfies TuneRoundPayload, { tenantId, maxRetries: 1 });
  } catch (err) {
    await withRLS(db, tenantId, (tx) => tx.update(schema.tuneRuns).set({ status: "failed", stopReason: "error", error: err instanceof Error ? err.message : String(err), updatedAt: new Date() }).where(eq(schema.tuneRuns.id, runId)));
  }
}

export async function handleTuneRunRound(job: QueuedJob): Promise<void> {
  const { db, queue } = deps();
  const { runId } = job.payload as unknown as TuneRoundPayload;
  const tenantId = job.tenantId;

  const [run] = await withRLS(db, tenantId, (tx) =>
    tx.select().from(schema.tuneRuns).where(eq(schema.tuneRuns.id, runId)).limit(1),
  );
  if (!run || run.status !== "running") return;

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

    const entries = await loadEntries(db, tenantId, run.schemaId);
    const entryById = new Map(entries.map((e) => [e.id, e]));

    // Rejected proposals so far — the "don't retread" memory.
    const prior = await withRLS(db, tenantId, (tx) =>
      tx.select({ accepted: schema.tuneRunRounds.accepted, explanation: schema.tuneRunRounds.explanation })
        .from(schema.tuneRunRounds).where(eq(schema.tuneRunRounds.runId, runId)).orderBy(asc(schema.tuneRunRounds.n)),
    );
    const rejected = prior.filter((r) => !r.accepted && r.explanation).map((r) => r.explanation!).slice(-6);

    const { provider } = await resolveTenantProvider(db, tenantId, run.model ? { preferModel: run.model } : undefined);
    let thinking = "";
    const proposal = await proposeEdit(
      provider, run.bestYaml, run.bestAccuracy ?? 0, snapshot.focus,
      (delta) => { thinking += delta; },
      rejected,
    );

    if (!proposal) {
      await recordRound(db, tenantId, runId, n, { accepted: false, focus: snapshot.focus, thinking, explanation: "No valid proposal produced.", accuracy: run.bestAccuracy, docsPassed: null, docsTotal: null, regressions: [], yaml: null });
      await advance(db, queue, tenantId, run, n, false);
      return;
    }

    const compiled = compileSchema(proposal.yaml);
    const prevMap = new Map(Object.entries(snapshot.prevExtracted));
    const scored = compiled.ok
      ? await scoreCorpus(scoreDeps(tenantId), entries, compiled.parsed as Record<string, unknown>, run.model ?? undefined, prevMap)
      : null;
    const bestAcc = run.bestAccuracy ?? 0;
    const improved = scored != null && scored.result.overallAccuracy > bestAcc + ACCURACY_EPSILON;
    const accepted =
      scored != null &&
      scored.result.overallAccuracy >= bestAcc - ACCURACY_EPSILON &&
      scored.result.regressions.length === 0;

    await recordRound(db, tenantId, runId, n, {
      accepted,
      focus: snapshot.focus,
      thinking,
      explanation: proposal.explanation,
      // Record the proposal's ACTUAL corpus score (not the carried-forward best)
      // so a rejected round is diagnosable and the UI shows what was tried.
      accuracy: scored ? scored.result.overallAccuracy : bestAcc,
      docsPassed: scored?.result.docsPassed ?? null,
      docsTotal: scored?.result.docsTotal ?? null,
      regressions: scored ? scored.result.regressions.map((r) => r.name) : [],
      yaml: proposal.yaml,
    });

    if (accepted && scored) {
      const newSnapshot = buildSnapshot(scored.result, entryById, scored.extractedByEntry);
      await withRLS(db, tenantId, (tx) =>
        tx.update(schema.tuneRuns).set({
          bestYaml: proposal.yaml, bestAccuracy: scored.result.overallAccuracy, bestSnapshotJson: newSnapshot, updatedAt: new Date(),
        }).where(eq(schema.tuneRuns.id, runId)),
      );
    }
    await advance(db, queue, tenantId, { ...run, bestAccuracy: accepted ? scored!.result.overallAccuracy : bestAcc }, n, improved);
  } catch (err) {
    await withRLS(db, tenantId, (tx) => tx.update(schema.tuneRuns).set({ status: "failed", stopReason: "error", error: err instanceof Error ? err.message : String(err), updatedAt: new Date() }).where(eq(schema.tuneRuns.id, runId)));
  }
}

/** Decide whether to stop or enqueue the next round, updating currentRound + stall tracking. */
async function advance(
  db: Db, queue: QueueProvider, tenantId: string,
  run: { id: string; currentRound: number; maxIterations: number; bestAccuracy: number | null },
  n: number, improved: boolean,
) {
  // Count consecutive non-improving rounds via a simple stored heuristic: we
  // re-derive it from the round history to stay stateless.
  const recent = await withRLS(db, tenantId, (tx) =>
    tx.select({ n: schema.tuneRunRounds.n, accepted: schema.tuneRunRounds.accepted, accuracy: schema.tuneRunRounds.accuracy })
      .from(schema.tuneRunRounds).where(eq(schema.tuneRunRounds.runId, run.id)).orderBy(asc(schema.tuneRunRounds.n)),
  );
  // Strict-improvement run: how many trailing rounds failed to raise accuracy.
  let stall = 0;
  let prevAcc = -1;
  for (const r of recent) {
    if (prevAcc >= 0 && (r.accuracy ?? 0) <= prevAcc) stall++;
    else stall = 0;
    prevAcc = Math.max(prevAcc, r.accuracy ?? 0);
  }

  await withRLS(db, tenantId, (tx) =>
    tx.update(schema.tuneRuns).set({ currentRound: n, updatedAt: new Date() }).where(eq(schema.tuneRuns.id, run.id)),
  );

  if ((run.bestAccuracy ?? 0) >= TARGET) { await finalize(db, tenantId, run.id, "passed"); return; }
  if (stall >= NO_IMPROVEMENT_LIMIT) { await finalize(db, tenantId, run.id, "no_improvement"); return; }
  if (n >= Math.min(run.maxIterations, MAX_ITERATIONS_CAP)) { await finalize(db, tenantId, run.id, "max_iterations"); return; }
  void improved;
  await queue.enqueue("tune.run.round", { runId: run.id } satisfies TuneRoundPayload, { tenantId, maxRetries: 1 });
}

async function recordRound(
  db: Db, tenantId: string, runId: string, n: number,
  r: { accepted: boolean; focus: TuneFocus; thinking: string; explanation: string; accuracy: number | null; docsPassed: number | null; docsTotal: number | null; regressions: string[]; yaml: string | null },
) {
  await withRLS(db, tenantId, (tx) =>
    tx.insert(schema.tuneRunRounds).values({
      tenantId, runId, n,
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
