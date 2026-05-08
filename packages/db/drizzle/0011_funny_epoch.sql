ALTER TABLE "documents" ADD COLUMN "parent_document_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "page_range" jsonb;