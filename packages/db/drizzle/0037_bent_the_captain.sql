-- Corpus pool split, phase 1 (oss-449): introduce the FILE pool.
--
-- corpus_documents is one row per (project, content hash). corpus_entries (the
-- LABEL) gains a NOT NULL document_id pointing at it, plus a denormalized
-- project_id + RESTRICTIVE project policy (corpus_entries was tenant-isolated
-- only — the gap this closes). PURELY ADDITIVE: no existing column is relaxed
-- and every read path is unchanged, because entries still carry (and writers
-- still populate) the legacy file columns. A follow-up (oss-450, where
-- classifier-owned labels arrive) moves reads onto document_id and drops them.
--
-- Hand-authored from the drizzle diff: the two `ADD COLUMN ... NOT NULL`
-- statements cannot run against existing rows, so the columns are added
-- nullable, backfilled, then tightened. RLS policies live in 0001_rls.sql
-- (applied after every migrate). See playbook docs/corpus-pool-classifier-backtest.md.

CREATE TABLE "corpus_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"filename" varchar(500) NOT NULL,
	"storage_key" varchar(500) NOT NULL,
	"file_size" bigint NOT NULL,
	"mime_type" varchar(64) NOT NULL,
	"content_hash" char(64) NOT NULL,
	"source" varchar(64) NOT NULL,
	"source_ref" varchar(255),
	"added_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "corpus_documents" ADD CONSTRAINT "corpus_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corpus_documents" ADD CONSTRAINT "corpus_documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corpus_documents" ADD CONSTRAINT "corpus_documents_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "corpus_documents_project_content_idx" ON "corpus_documents" USING btree ("project_id","content_hash") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "corpus_documents_project_idx" ON "corpus_documents" USING btree ("project_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "corpus_documents_tenant_idx" ON "corpus_documents" USING btree ("tenant_id");--> statement-breakpoint

-- Add the new links NULLABLE (populated by the backfill below).
ALTER TABLE "corpus_entries" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "corpus_entries" ADD COLUMN "project_id" uuid;--> statement-breakpoint

-- Backfill. Every pre-split corpus_entries has a NOT NULL schema_id, so the
-- join to schemas (for project_id) is total.
--
-- One pool document per distinct (project, content_hash). Include hashes that
-- appear only on soft-deleted entries — those entries still need a document_id
-- (about to be NOT NULL). Earliest entry by created_at is canonical.
-- Backfilled documents are live (deleted_at NULL): the file is in the pool even
-- if that particular label was deleted.
INSERT INTO "corpus_documents" (id, tenant_id, project_id, filename, storage_key, file_size, mime_type, content_hash, source, source_ref, added_by, created_at, updated_at, deleted_at)
SELECT DISTINCT ON (s.project_id, ce.content_hash)
	gen_random_uuid(), ce.tenant_id, s.project_id, ce.filename, ce.storage_key, ce.file_size, ce.mime_type, ce.content_hash, ce.source, ce.source_ref, ce.added_by, ce.created_at, ce.updated_at, NULL
FROM "corpus_entries" ce
JOIN "schemas" s ON s.id = ce.schema_id
ORDER BY s.project_id, ce.content_hash, ce.created_at ASC;--> statement-breakpoint

-- Denormalize project onto every entry (also the join key for the next step).
UPDATE "corpus_entries" ce SET project_id = s.project_id
FROM "schemas" s WHERE s.id = ce.schema_id;--> statement-breakpoint

-- Point every entry at its pooled document.
UPDATE "corpus_entries" ce SET document_id = cd.id
FROM "corpus_documents" cd
WHERE cd.project_id = ce.project_id AND cd.content_hash = ce.content_hash AND cd.deleted_at IS NULL;--> statement-breakpoint

-- Tighten now that every row is populated, then wire the FKs + index.
ALTER TABLE "corpus_entries" ALTER COLUMN "document_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "corpus_entries" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "corpus_entries" ADD CONSTRAINT "corpus_entries_document_id_corpus_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."corpus_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corpus_entries" ADD CONSTRAINT "corpus_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "corpus_entries_document_idx" ON "corpus_entries" USING btree ("document_id") WHERE deleted_at IS NULL;
