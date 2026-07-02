import { sql } from "drizzle-orm";
import {
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { createdAt, primaryKey, tenantId } from "./_shared";
import { corpusEntries } from "./corpus";
import { modelEndpoints } from "./endpoints";
import { schemaVersions, schemas } from "./schemas";
import { tenants, users } from "./tenants";

export const schemaRuns = pgTable(
  "schema_runs",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    schemaId: uuid("schema_id")
      .notNull()
      .references(() => schemas.id, { onDelete: "cascade" }),
    schemaVersionId: uuid("schema_version_id")
      .notNull()
      .references(() => schemaVersions.id),
    runType: varchar("run_type", { length: 32 }).notNull(),
    triggeredBy: uuid("triggered_by").references(() => users.id),
    triggeredReason: varchar("triggered_reason", { length: 64 }),
    baselineVersionId: uuid("baseline_version_id").references(() => schemaVersions.id),
    status: varchar("status", { length: 16 }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    docsTotal: integer("docs_total").notNull().default(0),
    docsPassed: integer("docs_passed").notNull().default(0),
    docsFailed: integer("docs_failed").notNull().default(0),
    regressionsCount: integer("regressions_count").notNull().default(0),
    accuracy: decimal("accuracy", { precision: 6, scale: 4 }),
    costUsd: decimal("cost_usd", { precision: 10, scale: 6 }),
    durationMs: integer("duration_ms"),
    errorMessage: text("error_message"),
    /** Full ValidateResult payload, persisted at finalize so async pollers
     *  (CLI, dashboard) can fetch the finished run without recomputing. */
    resultJson: jsonb("result_json"),
    createdAt: createdAt(),
  },
  (t) => ({
    schemaCreatedIdx: index("schema_runs_schema_created_idx").on(
      t.schemaId,
      sql`${t.createdAt} DESC`,
    ),
    tenantStatusIdx: index("schema_runs_tenant_status_idx")
      .on(t.tenantId, t.status)
      .where(sql`status IN ('queued', 'running')`),
    baselineIdx: index("schema_runs_baseline_idx")
      .on(t.baselineVersionId)
      .where(sql`baseline_version_id IS NOT NULL`),
  }),
);

/**
 * Per-document progress rows for a validate run — one row per corpus entry,
 * written by the `schema.validate.doc` job (or the sync loop) as each doc
 * finishes. Drives poll-time progress (count rows vs docs_total), records
 * per-doc failures, and carries the transient routing plan the finalizer
 * needs for routing diagnosis on failing fields. The extracted values
 * themselves live in extraction_runs (joined on schema_run_id + corpus
 * entry) — this table never duplicates them.
 */
export const schemaRunDocs = pgTable(
  "schema_run_docs",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    schemaRunId: uuid("schema_run_id")
      .notNull()
      .references(() => schemaRuns.id, { onDelete: "cascade" }),
    corpusEntryId: uuid("corpus_entry_id")
      .notNull()
      .references(() => corpusEntries.id, { onDelete: "cascade" }),
    /** "ok" — extraction ran and persisted; "failed" — parse/extract error. */
    status: varchar("status", { length: 16 }).notNull(),
    errorMessage: text("error_message"),
    /** Per-field chunk-routing record from the intelligent pipeline. Consumed
     *  once by the run finalizer for routing diagnosis; not read elsewhere. */
    routingPlanJson: jsonb("routing_plan_json"),
    durationMs: integer("duration_ms"),
    createdAt: createdAt(),
  },
  (t) => ({
    // One row per (run, entry) — a retried job upserts instead of
    // double-counting progress.
    runEntryIdx: uniqueIndex("schema_run_docs_run_entry_idx").on(t.schemaRunId, t.corpusEntryId),
    tenantIdx: index("schema_run_docs_tenant_idx").on(t.tenantId),
  }),
);

export const schemaRunModels = pgTable(
  "schema_run_models",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    schemaRunId: uuid("schema_run_id")
      .notNull()
      .references(() => schemaRuns.id, { onDelete: "cascade" }),
    modelEndpointId: uuid("model_endpoint_id")
      .notNull()
      .references(() => modelEndpoints.id),
    docsTested: integer("docs_tested").notNull(),
    accuracy: decimal("accuracy", { precision: 6, scale: 4 }).notNull(),
    avgLatencyMs: integer("avg_latency_ms").notNull(),
    totalCostUsd: decimal("total_cost_usd", { precision: 10, scale: 6 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    runModelIdx: uniqueIndex("schema_run_models_run_model_idx").on(t.schemaRunId, t.modelEndpointId),
    runIdx: index("schema_run_models_run_idx").on(t.schemaRunId),
    tenantIdx: index("schema_run_models_tenant_idx").on(t.tenantId),
  }),
);

export const corpusVersionResults = pgTable(
  "corpus_version_results",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    corpusEntryId: uuid("corpus_entry_id")
      .notNull()
      .references(() => corpusEntries.id, { onDelete: "cascade" }),
    schemaVersionId: uuid("schema_version_id")
      .notNull()
      .references(() => schemaVersions.id, { onDelete: "cascade" }),
    modelEndpointId: uuid("model_endpoint_id").references(() => modelEndpoints.id),
    overallStatus: varchar("overall_status", { length: 16 }).notNull(),
    fieldsPassed: integer("fields_passed").notNull(),
    fieldsTotal: integer("fields_total").notNull(),
    fieldResultsJson: jsonb("field_results_json").notNull(),
    runId: uuid("run_id").notNull(),
    durationMs: integer("duration_ms").notNull(),
    costUsd: decimal("cost_usd", { precision: 10, scale: 6 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    entryVersionIdx: index("corpus_results_entry_version_idx").on(
      t.corpusEntryId,
      t.schemaVersionId,
      sql`${t.createdAt} DESC`,
    ),
    runIdx: index("corpus_results_run_idx").on(t.runId),
    tenantVersionIdx: index("corpus_results_tenant_version_idx").on(t.tenantId, t.schemaVersionId),
  }),
);
