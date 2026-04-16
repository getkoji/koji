import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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
import { schemaVersions, schemas } from "./schemas";
import { tenants, users } from "./tenants";

export const corpusEntries = pgTable(
  "corpus_entries",
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
    contentHash: char("content_hash", { length: 64 }).notNull(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    groundTruthJson: jsonb("ground_truth_json").notNull(),
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
    schemaContentIdx: uniqueIndex("corpus_entries_schema_content_idx")
      .on(t.schemaId, t.contentHash)
      .where(sql`deleted_at IS NULL`),
    schemaIdx: index("corpus_entries_schema_idx")
      .on(t.schemaId)
      .where(sql`deleted_at IS NULL`),
    tagsIdx: index("corpus_entries_tags_idx")
      .using("gin", t.tags)
      .where(sql`deleted_at IS NULL`),
    sourceIdx: index("corpus_entries_source_idx")
      .on(t.source, t.sourceRef)
      .where(sql`deleted_at IS NULL`),
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
