DROP INDEX "corpus_entries_schema_content_idx";--> statement-breakpoint
ALTER TABLE "corpus_entries" ALTER COLUMN "schema_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "corpus_entries_schema_doc_idx" ON "corpus_entries" USING btree ("schema_id","document_id") WHERE schema_id IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "corpus_entries_classifier_doc_idx" ON "corpus_entries" USING btree ("classifier_id","document_id") WHERE classifier_id IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "corpus_entries_classifier_idx" ON "corpus_entries" USING btree ("classifier_id") WHERE deleted_at IS NULL;--> statement-breakpoint
ALTER TABLE "corpus_entries" ADD CONSTRAINT "corpus_entries_one_owner" CHECK (num_nonnulls("corpus_entries"."schema_id", "corpus_entries"."classifier_id") = 1);