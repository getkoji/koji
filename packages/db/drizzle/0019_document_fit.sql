-- Add fit_json column to documents.
-- Stores the document-fit verdict (FitReport: ok, action, reason, message,
-- score, extraction_skipped, checks) produced during extraction when the
-- schema declares a `fit` block. Lets the jobs UI surface a "wrong document"
-- signal on processed documents, not just in the build/test flow.
ALTER TABLE "documents" ADD COLUMN "fit_json" jsonb;
