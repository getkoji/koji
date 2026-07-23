import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { createdAt, deletedAt, primaryKey, projectId, tenantId, updatedAt } from "./_shared";
import { classifiers } from "./classifiers";
import { schemaVersions, schemas } from "./schemas";
import { projects, tenants, users } from "./tenants";

/**
 * The project-level document pool — the FILE, split out from `corpus_entries`
 * (the LABEL). Before this, `corpus_entries` conflated the two: the bytes
 * (`storageKey`, `contentHash`, …) lived on the same row as the ground-truth
 * label and its owning schema. That made a document inseparable from a single
 * schema, so a classifier could not reuse a document a schema had already
 * labelled without a second upload, and content-hash dedup was per-schema
 * rather than per-project.
 *
 * A pool document is one file per `(projectId, contentHash)`. A `corpus_entries`
 * row now points at one of these via `documentId` and carries only the label +
 * its owning artifact (a schema OR a classifier). See
 * playbook docs/corpus-pool-classifier-backtest.md.
 *
 * `projectId` is NOT NULL with a RESTRICTIVE project-isolation policy from the
 * start — `corpus_entries` shipped tenant-isolated only and was never added to
 * the project set, an implicit-scoping gap this split closes.
 */
export const corpusDocuments = pgTable(
  "corpus_documents",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    projectId: projectId().references(() => projects.id),
    filename: varchar("filename", { length: 500 }).notNull(),
    storageKey: varchar("storage_key", { length: 500 }).notNull(),
    fileSize: bigint("file_size", { mode: "number" }).notNull(),
    mimeType: varchar("mime_type", { length: 64 }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    source: varchar("source", { length: 64 }).notNull(),
    sourceRef: varchar("source_ref", { length: 255 }),
    addedBy: uuid("added_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    projectContentIdx: uniqueIndex("corpus_documents_project_content_idx")
      .on(t.projectId, t.contentHash)
      .where(sql`deleted_at IS NULL`),
    projectIdx: index("corpus_documents_project_idx")
      .on(t.projectId)
      .where(sql`deleted_at IS NULL`),
    tenantIdx: index("corpus_documents_tenant_idx").on(t.tenantId),
  }),
);

export const corpusEntries = pgTable(
  "corpus_entries",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    /**
     * The pooled file this label is for. NOT NULL after the backfill — every
     * pre-split row gets a `corpus_documents` row created from its own file
     * columns. The file columns below are retained (nullable) only so the
     * split is a non-lossy expand/contract; a follow-up release drops them.
     */
    documentId: uuid("document_id")
      .notNull()
      .references(() => corpusDocuments.id, { onDelete: "cascade" }),
    /**
     * The owning artifact. EXACTLY ONE of `schemaId` / `classifierId` is set,
     * enforced by `corpus_entries_one_owner` (CHECK num_nonnulls = 1). `schemaId`
     * became nullable in phase 2 (oss-475) so a classifier-owned label can
     * exist; every pre-existing row is schema-owned, so the CHECK holds on
     * backfilled data.
     */
    schemaId: uuid("schema_id").references(() => schemas.id, { onDelete: "cascade" }),
    classifierId: uuid("classifier_id").references(() => classifiers.id, {
      onDelete: "cascade",
    }),
    /**
     * Denormalized project, NOT NULL after backfill, with a RESTRICTIVE
     * project-isolation policy. Closes the pre-split gap where `corpus_entries`
     * was tenant-isolated only and relied on the API predicate
     * `eq(schemaId, s.id)` for project scoping.
     */
    projectId: projectId().references(() => projects.id),
    /**
     * File columns — these now duplicate `corpus_documents`. They are kept
     * (and still written) during the expand/contract window so no read path
     * changes in this PR; a follow-up moves reads onto `documentId` and drops
     * them. Unchanged (NOT NULL) here on purpose — relaxing them is read-site
     * churn that belongs with the follow-up, not the one-way-door migration.
     */
    filename: varchar("filename", { length: 500 }).notNull(),
    storageKey: varchar("storage_key", { length: 500 }).notNull(),
    fileSize: bigint("file_size", { mode: "number" }).notNull(),
    mimeType: varchar("mime_type", { length: 64 }).notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    groundTruthJson: jsonb("ground_truth_json").notNull(),
    /**
     * Optional per-field provenance for the denormalized ground truth — a
     * `ProvenanceMap` (field → ProvenanceSpan) mirroring the shape extraction
     * returns alongside its values. Retains page + bbox + source span so a
     * label is auditable (re-parse can check the geometry still resolves) and
     * usable for region-anchored / faithfulness scoring. Nullable and additive:
     * value-only labels (the pre-existing shape) leave it NULL, and the scorer
     * continues to read `groundTruthJson` alone.
     */
    groundTruthProvenanceJson: jsonb("ground_truth_provenance_json"),
    // Also duplicated on the pool document; still written here during the
    // expand/contract window. Unchanged in this PR.
    source: varchar("source", { length: 64 }).notNull(),
    sourceRef: varchar("source_ref", { length: 255 }),
    addedBy: uuid("added_by")
      .notNull()
      .references(() => users.id),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    // One label per (owner, document). Two owner-scoped partial uniques replace
    // the old (schemaId, contentHash) unique, so a document can be labelled once
    // for a schema AND once for a classifier without colliding (oss-475). Keyed
    // on documentId rather than contentHash — the pool document is the identity
    // now, and content_hash is on its way out.
    schemaDocIdx: uniqueIndex("corpus_entries_schema_doc_idx")
      .on(t.schemaId, t.documentId)
      .where(sql`schema_id IS NOT NULL AND deleted_at IS NULL`),
    classifierDocIdx: uniqueIndex("corpus_entries_classifier_doc_idx")
      .on(t.classifierId, t.documentId)
      .where(sql`classifier_id IS NOT NULL AND deleted_at IS NULL`),
    schemaIdx: index("corpus_entries_schema_idx")
      .on(t.schemaId)
      .where(sql`deleted_at IS NULL`),
    classifierIdx: index("corpus_entries_classifier_idx")
      .on(t.classifierId)
      .where(sql`deleted_at IS NULL`),
    documentIdx: index("corpus_entries_document_idx")
      .on(t.documentId)
      .where(sql`deleted_at IS NULL`),
    tagsIdx: index("corpus_entries_tags_idx")
      .using("gin", t.tags)
      .where(sql`deleted_at IS NULL`),
    sourceIdx: index("corpus_entries_source_idx")
      .on(t.source, t.sourceRef)
      .where(sql`deleted_at IS NULL`),
    // Exactly one owner. A schema-owned label has classifier_id NULL; a
    // classifier-owned label has schema_id NULL. Never both, never neither.
    oneOwner: check("corpus_entries_one_owner", sql`num_nonnulls(${t.schemaId}, ${t.classifierId}) = 1`),
  }),
);

export const corpusEntryGroundTruth = pgTable(
  "corpus_entry_ground_truth",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    corpusEntryId: uuid("corpus_entry_id")
      .notNull()
      .references(() => corpusEntries.id, { onDelete: "cascade" }),
    schemaVersionId: uuid("schema_version_id").references(() => schemaVersions.id),
    payloadJson: jsonb("payload_json").notNull(),
    /**
     * Optional per-field provenance for this versioned ground-truth row, same
     * `ProvenanceMap` shape as `corpusEntries.groundTruthProvenanceJson`. Kept
     * on the append-only row so geometry is versioned with the values it
     * anchors. Nullable/additive — value-only rows leave it NULL.
     */
    provenanceJson: jsonb("provenance_json"),
    authoredBy: uuid("authored_by")
      .notNull()
      .references(() => users.id),
    authoredViaAgent: boolean("authored_via_agent").notNull().default(false),
    reviewStatus: varchar("review_status", { length: 16 }).notNull().default("draft"),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "date" }),
    notes: text("notes"),
    supersedesId: uuid("supersedes_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    entryIdx: index("corpus_entry_ground_truth_entry_idx").on(
      t.corpusEntryId,
      sql`${t.createdAt} DESC`,
    ),
  }),
);

export const corpusEntryTags = pgTable(
  "corpus_entry_tags",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    corpusEntryId: uuid("corpus_entry_id")
      .notNull()
      .references(() => corpusEntries.id, { onDelete: "cascade" }),
    tag: varchar("tag", { length: 64 }).notNull(),
    addedBy: uuid("added_by").references(() => users.id),
    addedViaAgent: boolean("added_via_agent").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => ({
    entryTagIdx: uniqueIndex("corpus_entry_tags_entry_tag_idx").on(t.corpusEntryId, t.tag),
    lookupIdx: index("corpus_entry_tags_lookup_idx").on(t.tenantId, t.tag, t.corpusEntryId),
  }),
);
