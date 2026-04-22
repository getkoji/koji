import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { createdAt, deletedAt, primaryKey, tenantId, updatedAt } from "./_shared";
import { tenants, users } from "./tenants";

export const pipelines = pgTable(
  "pipelines",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 64 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    schemaId: uuid("schema_id"),
    activeSchemaVersionId: uuid("active_schema_version_id"),
    modelProviderId: uuid("model_provider_id"),
    configJson: jsonb("config_json").notNull().default(sql`'{}'::jsonb`),
    // Per-pipeline retry policy override. NULL = fall back to platform defaults
    // (see RetryPolicy in @koji/types/db). Wired to the motor/queue in a
    // follow-up once the transient-error classifier (platform-53) lands.
    retryPolicyJson: jsonb("retry_policy_json"),
    reviewThreshold: varchar("review_threshold", { length: 8 }).notNull().default("0.9"),
    yamlSource: text("yaml_source").notNull().default(""),
    parsedJson: jsonb("parsed_json").notNull().default(sql`'{}'::jsonb`),
    triggerType: varchar("trigger_type", { length: 32 }).notNull().default("manual"),
    triggerConfigJson: jsonb("trigger_config_json").notNull().default(sql`'{}'::jsonb`),
    targetSchemas: text("target_schemas").array().notNull().default(sql`'{}'::text[]`),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: "date" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    tenantSlugIdx: uniqueIndex("pipelines_tenant_slug_idx")
      .on(t.tenantId, t.slug)
      .where(sql`deleted_at IS NULL`),
    tenantIdx: index("pipelines_tenant_idx").on(t.tenantId).where(sql`deleted_at IS NULL`),
    statusIdx: index("pipelines_status_idx")
      .on(t.tenantId, t.status)
      .where(sql`deleted_at IS NULL`),
  }),
);

export const sources = pgTable(
  "sources",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 64 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    sourceType: varchar("source_type", { length: 32 }).notNull(),
    configJson: jsonb("config_json").notNull(),
    authJson: jsonb("auth_json"),
    targetPipelineId: uuid("target_pipeline_id").references(() => pipelines.id),
    filterConfigJson: jsonb("filter_config_json"),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    lastIngestedAt: timestamp("last_ingested_at", { withTimezone: true, mode: "date" }),
    webhookSecret: varchar("webhook_secret", { length: 64 }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    tenantSlugIdx: uniqueIndex("sources_tenant_slug_idx")
      .on(t.tenantId, t.slug)
      .where(sql`deleted_at IS NULL`),
    tenantIdx: index("sources_tenant_idx").on(t.tenantId).where(sql`deleted_at IS NULL`),
    pipelineIdx: index("sources_pipeline_idx")
      .on(t.targetPipelineId)
      .where(sql`deleted_at IS NULL`),
  }),
);

export const ingestions = pgTable(
  "ingestions",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    externalKey: varchar("external_key", { length: 500 }),
    filename: varchar("filename", { length: 500 }),
    fileSize: bigint("file_size", { mode: "number" }),
    storageKey: varchar("storage_key", { length: 500 }).notNull(),
    contentHash: char("content_hash", { length: 64 }),
    status: varchar("status", { length: 16 }).notNull(),
    // job_id and doc_id FKs wired in jobs.ts via application-layer joins — we
    // leave them as plain uuid here so the tables can be introduced without a
    // circular reference at migration generation time.
    jobId: uuid("job_id"),
    docId: uuid("doc_id"),
    failureReason: varchar("failure_reason", { length: 255 }),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    sourceReceivedIdx: index("ingestions_source_received_idx").on(
      t.sourceId,
      sql`${t.receivedAt} DESC`,
    ),
    tenantStatusIdx: index("ingestions_tenant_status_idx").on(t.tenantId, t.status),
    dedupeIdx: index("ingestions_dedupe_idx")
      .on(t.sourceId, t.contentHash)
      .where(sql`content_hash IS NOT NULL`),
  }),
);
