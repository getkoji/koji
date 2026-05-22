-- Add provenance and per-field confidence scores to documents.
-- Previously only stored on extraction_runs (build mode).
-- Pipeline-processed documents need these for field highlighting
-- and per-field confidence display in the review UI.
ALTER TABLE "documents" ADD COLUMN "confidence_scores_json" jsonb;
ALTER TABLE "documents" ADD COLUMN "provenance_json" jsonb;
