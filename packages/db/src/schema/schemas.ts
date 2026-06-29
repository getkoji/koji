import { sql } from "drizzle-orm";
import {
  bigint,
  char,
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

export const schemas = pgTable(
  "schemas",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 64 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    description: text("description"),
    currentVersionId: uuid("current_version_id"),
    draftYaml: text("draft_yaml"),
    draftUpdatedAt: timestamp("draft_updated_at", { withTimezone: true, mode: "date" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    tenantSlugIdx: uniqueIndex("schemas_tenant_slug_idx")
      .on(t.tenantId, t.slug)
      .where(sql`deleted_at IS NULL`),
    tenantIdx: index("schemas_tenant_idx").on(t.tenantId).where(sql`deleted_at IS NULL`),
  }),
);

export const schemaVersions = pgTable(
  "schema_versions",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    schemaId: uuid("schema_id")
      .notNull()
      .references(() => schemas.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    /**
     * Semver components (sortable columns — semver strings don't sort lexically).
     * A version is **released** iff `prerelease IS NULL`; a **candidate** (e.g.
     * `rc.7`) otherwise. `schemas.currentVersionId` may only point at a released
     * version. See api/src/schemas/semver.ts.
     */
    major: integer("major").notNull().default(0),
    minor: integer("minor").notNull().default(0),
    patch: integer("patch").notNull().default(0),
    prerelease: varchar("prerelease", { length: 32 }),
    yamlSource: text("yaml_source").notNull(),
    yamlHash: char("yaml_hash", { length: 64 }).notNull(),
    parsedJson: jsonb("parsed_json").notNull(),
    commitMessage: varchar("commit_message", { length: 500 }),
    committedBy: uuid("committed_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => ({
    schemaVersionIdx: uniqueIndex("schema_versions_schema_version_idx").on(t.schemaId, t.versionNumber),
    schemaDescIdx: index("schema_versions_schema_idx").on(t.schemaId, sql`${t.versionNumber} DESC`),
    tenantIdx: index("schema_versions_tenant_idx").on(t.tenantId),
    // At most one released version per (schema, x.y.z). Candidates (prerelease
    // set) are excluded; their uniqueness comes from the rc counter.
    releasedSemverIdx: uniqueIndex("schema_versions_released_semver_idx")
      .on(t.schemaId, t.major, t.minor, t.patch)
      .where(sql`prerelease IS NULL`),
  }),
);

export const schemaSamples = pgTable(
  "schema_samples",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    schemaId: uuid("schema_id")
      .notNull()
      .references(() => schemas.id, { onDelete: "cascade" }),
    filename: varchar("filename", { length: 500 }).notNull(),
    storageKey: varchar("storage_key", { length: 500 }).notNull(),
    fileSize: bigint("file_size", { mode: "number" }).notNull(),
    mimeType: varchar("mime_type", { length: 64 }).notNull(),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => ({
    schemaIdx: index("schema_samples_schema_idx").on(t.schemaId),
  }),
);
