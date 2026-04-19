import { sql } from "drizzle-orm";
import {
  bigint,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
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
