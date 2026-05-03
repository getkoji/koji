import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { createdAt, deletedAt, primaryKey, tenantId, updatedAt } from "./_shared";
import { schemas } from "./schemas";
import { tenants, users } from "./tenants";

export const formMappings = pgTable(
  "form_mappings",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    schemaId: uuid("schema_id")
      .notNull()
      .references(() => schemas.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 64 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    description: text("description"),
    sampleStorageKey: varchar("sample_storage_key", { length: 500 }),
    samplePageCount: integer("sample_page_count"),
    mappingsJson: jsonb("mappings_json").notNull().default(sql`'{}'::jsonb`),
    fingerprintJson: jsonb("fingerprint_json"),
    version: integer("version").notNull().default(1),
    status: varchar("status", { length: 16 }).notNull().default("draft"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    tenantSchemaSlugIdx: uniqueIndex("form_mappings_tenant_schema_slug_idx")
      .on(t.tenantId, t.schemaId, t.slug)
      .where(sql`deleted_at IS NULL`),
    schemaIdx: index("form_mappings_schema_idx")
      .on(t.schemaId)
      .where(sql`deleted_at IS NULL`),
    tenantStatusIdx: index("form_mappings_tenant_status_idx")
      .on(t.tenantId, t.status)
      .where(sql`deleted_at IS NULL`),
  }),
);
