ALTER TABLE "corpus_entries" ALTER COLUMN "filename" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "corpus_entries" ALTER COLUMN "storage_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "corpus_entries" ALTER COLUMN "file_size" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "corpus_entries" ALTER COLUMN "mime_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "corpus_entries" ALTER COLUMN "content_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "corpus_entries" ALTER COLUMN "source" DROP NOT NULL;