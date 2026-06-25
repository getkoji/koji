import { sql } from "drizzle-orm";
import {
  bigint,
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

import { createdAt, deletedAt, primaryKey, tenantId, updatedAt } from "./_shared";
import { tenants, users } from "./tenants";

export const modelCatalog = pgTable(
  "model_catalog",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 32 }).notNull(),
    modelId: varchar("model_id", { length: 128 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    contextWindow: integer("context_window"),
    supportsVision: varchar("supports_vision", { length: 8 }).default("false"),
    source: varchar("source", { length: 16 }).notNull().default("manual"),
    createdAt: createdAt(),
  },
  (t) => ({
    tenantProviderModelIdx: uniqueIndex("model_catalog_tenant_provider_model_idx")
      .on(t.tenantId, t.provider, t.modelId),
    tenantProviderIdx: index("model_catalog_tenant_provider_idx")
      .on(t.tenantId, t.provider),
  }),
);

export const modelEndpoints = pgTable(
  "model_endpoints",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 64 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    provider: varchar("provider", { length: 32 }).notNull(),
    model: varchar("model", { length: 64 }).notNull(),
    configJson: jsonb("config_json").notNull(),
    authJson: jsonb("auth_json"),
    pricingMode: varchar("pricing_mode", { length: 16 }).notNull().default("default"),
    pricingOverrideJson: jsonb("pricing_override_json"),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    lastHealthCheckAt: timestamp("last_health_check_at", { withTimezone: true, mode: "date" }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true, mode: "date" }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true, mode: "date" }),
    lastFailureReason: text("last_failure_reason"),
    healthState: varchar("health_state", { length: 16 }).notNull().default("healthy"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    tenantSlugIdx: uniqueIndex("model_endpoints_tenant_slug_idx")
      .on(t.tenantId, t.slug)
      .where(sql`deleted_at IS NULL`),
    tenantIdx: index("model_endpoints_tenant_idx")
      .on(t.tenantId)
      .where(sql`deleted_at IS NULL`),
  }),
);

/**
 * Provider credentials — a single connection (provider + base_url + encrypted
 * key), decoupled from the model. One credential can serve MANY models via
 * `tenant_models`, so a user no longer duplicates their key per model.
 *
 * Expand phase (oss-232): this table is populated by backfill but nothing reads
 * or writes it yet — `model_endpoints` remains the source of truth. The resolver
 * + write-path cutover lands in a follow-up PR.
 */
export const providerCredentials = pgTable(
  "provider_credentials",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 64 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    provider: varchar("provider", { length: 32 }).notNull(),
    configJson: jsonb("config_json").notNull(),
    authJson: jsonb("auth_json"),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    // Health is a property of the connection (key + base_url), not the model.
    lastHealthCheckAt: timestamp("last_health_check_at", { withTimezone: true, mode: "date" }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true, mode: "date" }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true, mode: "date" }),
    lastFailureReason: text("last_failure_reason"),
    healthState: varchar("health_state", { length: 16 }).notNull().default("healthy"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    tenantSlugIdx: uniqueIndex("provider_credentials_tenant_slug_idx")
      .on(t.tenantId, t.slug)
      .where(sql`deleted_at IS NULL`),
    tenantIdx: index("provider_credentials_tenant_idx")
      .on(t.tenantId)
      .where(sql`deleted_at IS NULL`),
  }),
);

/**
 * Tenant models — "this credential is allowed to use this model." A credential
 * has many. `capability` (chat | vision | ocr) drives downstream routing: the
 * bad-scan escalation picks a vision/ocr-capable model, and the OCR path can
 * hand a dedicated OCR engine the whole document instead of page images.
 *
 * On backfill, each old `model_endpoints` row becomes one credential + one
 * tenant_model that REUSES the old endpoint id — so every existing reference
 * (`pipelines.model_provider_id`, runs, usage rollups, the legibility
 * `fallback_model_id`) stays valid by value with no FK rewrite.
 */
export const tenantModels = pgTable(
  "tenant_models",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    credentialId: uuid("credential_id")
      .notNull()
      .references(() => providerCredentials.id, { onDelete: "cascade" }),
    model: varchar("model", { length: 64 }).notNull(),
    capability: varchar("capability", { length: 16 }).notNull().default("chat"),
    slug: varchar("slug", { length: 64 }),
    displayName: varchar("display_name", { length: 255 }),
    pricingMode: varchar("pricing_mode", { length: 16 }).notNull().default("default"),
    pricingOverrideJson: jsonb("pricing_override_json"),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    credentialModelIdx: uniqueIndex("tenant_models_credential_model_idx")
      .on(t.credentialId, t.model)
      .where(sql`deleted_at IS NULL`),
    tenantIdx: index("tenant_models_tenant_idx")
      .on(t.tenantId)
      .where(sql`deleted_at IS NULL`),
    credentialIdx: index("tenant_models_credential_idx").on(t.credentialId),
  }),
);

export const endpointUsageRollups = pgTable(
  "endpoint_usage_rollups",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => modelEndpoints.id, { onDelete: "cascade" }),
    periodStart: timestamp("period_start", { withTimezone: true, mode: "date" }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true, mode: "date" }).notNull(),
    callCount: integer("call_count").notNull().default(0),
    tokensInTotal: bigint("tokens_in_total", { mode: "number" }).notNull().default(0),
    tokensOutTotal: bigint("tokens_out_total", { mode: "number" }).notNull().default(0),
    costUsd: decimal("cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
    avgLatencyMs: integer("avg_latency_ms"),
    errorCount: integer("error_count").notNull().default(0),
  },
  (t) => ({
    endpointPeriodIdx: uniqueIndex("endpoint_usage_endpoint_period_idx")
      .on(t.endpointId, t.periodStart),
    endpointPeriodDescIdx: index("endpoint_usage_endpoint_period_desc_idx").on(
      t.endpointId,
      sql`${t.periodStart} DESC`,
    ),
  }),
);
