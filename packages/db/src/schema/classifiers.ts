import { sql } from "drizzle-orm";
import {
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

/**
 * Classifier config artifact — the schema-sibling of `schemas`.
 *
 * A classifier stores YAML that defines the document classes the cascade engine
 * can assign (see api/src/classify). It mirrors the extraction schema artifact
 * exactly: one row per artifact, an append-only version log, semver components,
 * and released/candidate (`rc.N`) versioning. `currentVersionId` may only point
 * at a released version.
 */
export const classifiers = pgTable(
  "classifiers",
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
    tenantSlugIdx: uniqueIndex("classifiers_tenant_slug_idx")
      .on(t.tenantId, t.slug)
      .where(sql`deleted_at IS NULL`),
    tenantIdx: index("classifiers_tenant_idx").on(t.tenantId).where(sql`deleted_at IS NULL`),
  }),
);

export const classifierVersions = pgTable(
  "classifier_versions",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    classifierId: uuid("classifier_id")
      .notNull()
      .references(() => classifiers.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    /**
     * Semver components (sortable columns — semver strings don't sort lexically).
     * A version is **released** iff `prerelease IS NULL`; a **candidate** (e.g.
     * `rc.7`) otherwise. `classifiers.currentVersionId` may only point at a
     * released version. See api/src/schemas/semver.ts.
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
    classifierVersionIdx: uniqueIndex("classifier_versions_classifier_version_idx").on(
      t.classifierId,
      t.versionNumber,
    ),
    classifierDescIdx: index("classifier_versions_classifier_idx").on(
      t.classifierId,
      sql`${t.versionNumber} DESC`,
    ),
    tenantIdx: index("classifier_versions_tenant_idx").on(t.tenantId),
    // At most one released version per (classifier, x.y.z). Candidates (prerelease
    // set) are excluded; their uniqueness comes from the rc counter.
    releasedSemverIdx: uniqueIndex("classifier_versions_released_semver_idx")
      .on(t.classifierId, t.major, t.minor, t.patch)
      .where(sql`prerelease IS NULL`),
  }),
);
