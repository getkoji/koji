ALTER TABLE "corpus_entries" ADD COLUMN "ground_truth_provenance_json" jsonb;--> statement-breakpoint
ALTER TABLE "corpus_entry_ground_truth" ADD COLUMN "provenance_json" jsonb;