import { sql } from "drizzle-orm";
import {
  bigint,
  char,
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

import { createdAt, primaryKey, tenantId, updatedAt } from "./_shared";
import { ingestions, pipelines } from "./pipelines";
import { schemaVersions, schemas } from "./schemas";
import { tenants, users } from "./tenants";

export const jobs = pgTable(
  "jobs",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 64 }).notNull(),
    pipelineId: uuid("pipeline_id")
      .notNull()
      .references(() => pipelines.id),
    triggerType: varchar("trigger_type", { length: 32 }).notNull(),
    triggeredBy: uuid("triggered_by").references(() => users.id),
    status: varchar("status", { length: 16 }).notNull(),
    docsTotal: integer("docs_total").notNull().default(0),
    docsProcessed: integer("docs_processed").notNull().default(0),
    docsPassed: integer("docs_passed").notNull().default(0),
    docsFailed: integer("docs_failed").notNull().default(0),
    docsReviewing: integer("docs_reviewing").notNull().default(0),
    avgLatencyMs: integer("avg_latency_ms"),
    totalCostUsd: decimal("total_cost_usd", { precision: 10, scale: 6 }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    tenantSlugIdx: uniqueIndex("jobs_tenant_slug_idx").on(t.tenantId, t.slug),
    tenantCreatedIdx: index("jobs_tenant_created_idx").on(
      t.tenantId,
      sql`${t.createdAt} DESC`,
    ),
    pipelineCreatedIdx: index("jobs_pipeline_created_idx").on(
      t.pipelineId,
      sql`${t.createdAt} DESC`,
    ),
    tenantStatusIdx: index("jobs_tenant_status_idx").on(t.tenantId, t.status),
  }),
);

export const documents = pgTable(
  "documents",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    ingestionId: uuid("ingestion_id").references(() => ingestions.id),
    filename: varchar("filename", { length: 500 }).notNull(),
    storageKey: varchar("storage_key", { length: 500 }).notNull(),
    fileSize: bigint("file_size", { mode: "number" }).notNull(),
    mimeType: varchar("mime_type", { length: 64 }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    pageCount: integer("page_count"),
    schemaId: uuid("schema_id").references(() => schemas.id),
    schemaVersionId: uuid("schema_version_id").references(() => schemaVersions.id),
    status: varchar("status", { length: 16 }).notNull(),
    extractionJson: jsonb("extraction_json"),
    confidence: decimal("confidence", { precision: 6, scale: 4 }),
    validationJson: jsonb("validation_json"),
    durationMs: integer("duration_ms"),
    costUsd: decimal("cost_usd", { precision: 10, scale: 6 }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    emittedAt: timestamp("emitted_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => ({
    jobIdx: index("documents_job_idx").on(t.jobId),
    tenantCreatedIdx: index("documents_tenant_created_idx").on(
      t.tenantId,
      sql`${t.createdAt} DESC`,
    ),
    tenantStatusIdx: index("documents_tenant_status_idx").on(t.tenantId, t.status),
    schemaIdx: index("documents_schema_idx").on(t.schemaId),
    contentHashIdx: index("documents_content_hash_idx").on(t.tenantId, t.contentHash),
  }),
);

export const traces = pgTable(
  "traces",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    traceExternalId: varchar("trace_external_id", { length: 64 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    totalDurationMs: integer("total_duration_ms"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => ({
    externalIdx: uniqueIndex("traces_external_id_idx").on(t.traceExternalId),
    documentIdx: index("traces_document_idx").on(t.documentId),
    jobIdx: index("traces_job_idx").on(t.jobId),
    tenantStartedIdx: index("traces_tenant_started_idx").on(
      t.tenantId,
      sql`${t.startedAt} DESC`,
    ),
  }),
);

export const traceStages = pgTable(
  "trace_stages",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    traceId: uuid("trace_id")
      .notNull()
      .references(() => traces.id, { onDelete: "cascade" }),
    stageName: varchar("stage_name", { length: 64 }).notNull(),
    stageOrder: integer("stage_order").notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    durationMs: integer("duration_ms"),
    summaryJson: jsonb("summary_json"),
    errorMessage: text("error_message"),
  },
  (t) => ({
    traceOrderIdx: index("trace_stages_trace_order_idx").on(t.traceId, t.stageOrder),
    tenantStageIdx: index("trace_stages_tenant_stage_idx").on(
      t.tenantId,
      t.stageName,
      sql`${t.startedAt} DESC`,
    ),
  }),
);
