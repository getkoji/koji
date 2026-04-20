import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
  decimal,
} from "drizzle-orm/pg-core";

import { createdAt, primaryKey, tenantId } from "./_shared";
import { corpusEntries } from "./corpus";
import { schemas, schemaVersions } from "./schemas";
import { tenants, users } from "./tenants";

/**
 * extraction_runs — one row per Run button click in Build mode.
 *
 * Stores the full extraction result so it survives page refresh,
 * and feeds into Performance/Validate pages.
 *
 * schema_version_id is nullable — Build mode runs against drafts.
 */
export const extractionRuns = pgTable(
  "extraction_runs",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    schemaId: uuid("schema_id")
      .notNull()
      .references(() => schemas.id, { onDelete: "cascade" }),
    schemaVersionId: uuid("schema_version_id").references(() => schemaVersions.id),
    corpusEntryId: uuid("corpus_entry_id")
      .notNull()
      .references(() => corpusEntries.id, { onDelete: "cascade" }),
    model: varchar("model", { length: 128 }).notNull(),
    schemaYamlHash: varchar("schema_yaml_hash", { length: 64 }),
    extractedJson: jsonb("extracted_json").notNull(),
    confidenceJson: jsonb("confidence_json"),
    confidenceScoresJson: jsonb("confidence_scores_json"),
    parseSeconds: decimal("parse_seconds", { precision: 10, scale: 2 }),
    extractMs: integer("extract_ms"),
    ocrSkipped: varchar("ocr_skipped", { length: 8 }).default("false"),
    cached: varchar("cached", { length: 8 }).default("false"),
    triggeredBy: uuid("triggered_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("extraction_runs_corpus_entry_idx").on(t.corpusEntryId, sql`${t.createdAt} DESC`),
    index("extraction_runs_schema_idx").on(t.schemaId, sql`${t.createdAt} DESC`),
  ],
);
