import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { createdAt, primaryKey, tenantId, updatedAt } from "./_shared";
import { tenants, users } from "./tenants";
import { schemas } from "./schemas";

/**
 * A durable, resumable corpus-tuning run. The loop can't run in one request
 * (the API function is capped at 300s; a real corpus blows past it), so a run
 * is persisted here and advanced one round per background job — surviving
 * disconnects and function timeouts, and giving the next run a memory of what
 * was already tried (see `tune_run_rounds`).
 */
export const tuneRuns = pgTable(
  "tune_runs",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    schemaId: uuid("schema_id")
      .notNull()
      .references(() => schemas.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 16 }).notNull().default("queued"), // queued | running | passed | stopped | failed
    startYaml: text("start_yaml").notNull(),
    /** Best schema found so far (starts equal to startYaml). */
    bestYaml: text("best_yaml").notNull(),
    baselineAccuracy: real("baseline_accuracy"),
    bestAccuracy: real("best_accuracy"),
    /**
     * Carried-forward score of the best schema: the failing-doc focus for the
     * next round + the per-entry extracted values (regression baseline). Lets a
     * round score only the PROPOSAL, not re-score the best — so one corpus
     * scoring per round job, keeping each job under the function time cap.
     */
    bestSnapshotJson: jsonb("best_snapshot_json"),
    maxIterations: integer("max_iterations").notNull().default(5),
    currentRound: integer("current_round").notNull().default(0),
    /**
     * Fan-out state machine. A single corpus scoring is itself too big for one
     * job (the baseline pass alone can approach the 300s cap), so scoring fans
     * out one `tune.score.doc` job per document (see `tune_score_docs`). These
     * columns track which pass is in flight, what YAML it's scoring, and how far
     * along it is — so the UI can show live "N/M documents" progress and a
     * finalizer knows what to do when the last doc lands.
     *
     * phase: baseline (scoring startYaml) | proposal (scoring a proposed edit) |
     *        proposing (between passes — a propose job is about to run) | null
     */
    phase: varchar("phase", { length: 16 }),
    /** Monotonic pass counter; keys `tune_score_docs` rows to the current pass. */
    scoringPass: integer("scoring_pass").notNull().default(0),
    /** The YAML being scored this pass (startYaml for baseline, the proposal otherwise). */
    pendingYaml: text("pending_yaml"),
    /** For a proposal pass: {n, explanation, thinking, focus} needed to record the round after scoring. */
    pendingProposalJson: jsonb("pending_proposal_json"),
    /** Progress for the in-flight pass. */
    docsTotal: integer("docs_total").notNull().default(0),
    docsScored: integer("docs_scored").notNull().default(0),
    /** passed | no_improvement | max_iterations | propose_failed | error */
    stopReason: varchar("stop_reason", { length: 32 }),
    model: varchar("model", { length: 128 }),
    error: text("error"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    schemaIdx: index("tune_runs_schema_idx").on(t.schemaId, sql`${t.createdAt} DESC`),
    statusIdx: index("tune_runs_status_idx").on(t.status),
  }),
);

/**
 * One round of a run: the proposal the model made, whether it was kept, and how
 * the corpus scored. Rejected rounds are the "don't retread this" memory fed
 * back into later proposals (this run and future runs on the same schema).
 */
export const tuneRunRounds = pgTable(
  "tune_run_rounds",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => tuneRuns.id, { onDelete: "cascade" }),
    n: integer("n").notNull(),
    accuracy: real("accuracy"),
    docsPassed: integer("docs_passed"),
    docsTotal: integer("docs_total"),
    accepted: boolean("accepted").notNull().default(false),
    focusDoc: varchar("focus_doc", { length: 500 }),
    fixingJson: jsonb("fixing_json"),
    regressionsJson: jsonb("regressions_json"),
    explanation: text("explanation"),
    /** The model's streamed reasoning for this round. */
    thinking: text("thinking"),
    proposedYaml: text("proposed_yaml"),
    /** sha256 of the proposed YAML — dedup identical re-proposals across rounds/runs. */
    yamlHash: char("yaml_hash", { length: 64 }),
    createdAt: createdAt(),
  },
  (t) => ({
    runIdx: index("tune_run_rounds_run_idx").on(t.runId, t.n),
  }),
);

/**
 * One document's extraction within a single scoring pass. Scoring the whole
 * corpus in one job risks the function time cap, so each pass fans out one
 * `tune.score.doc` job per document; each writes its result here, and when every
 * document for the pass has landed a finalizer aggregates them into the pass
 * score. Rows are keyed by (runId, pass, entryId) so a retried job overwrites
 * rather than double-counts. `extractionJson` carries the truncated
 * EntryExtraction (extracted / confidence / routingPlan / markdown head) the
 * aggregator needs to score, pick the next focus, and detect regressions.
 */
export const tuneScoreDocs = pgTable(
  "tune_score_docs",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => tuneRuns.id, { onDelete: "cascade" }),
    pass: integer("pass").notNull(),
    entryId: uuid("entry_id").notNull(),
    /** ok | failed (parse/extract failure — dropped from scoring, like the in-request loop). */
    status: varchar("status", { length: 8 }).notNull().default("ok"),
    extractionJson: jsonb("extraction_json"),
    createdAt: createdAt(),
  },
  (t) => ({
    passIdx: index("tune_score_docs_pass_idx").on(t.runId, t.pass),
    entryUnique: uniqueIndex("tune_score_docs_entry_unique").on(t.runId, t.pass, t.entryId),
  }),
);
