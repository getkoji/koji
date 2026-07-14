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
