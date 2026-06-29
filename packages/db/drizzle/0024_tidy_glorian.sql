ALTER TABLE "schema_versions" ADD COLUMN "major" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "schema_versions" ADD COLUMN "minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "schema_versions" ADD COLUMN "patch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "schema_versions" ADD COLUMN "prerelease" varchar(32);--> statement-breakpoint
-- Backfill: existing versions become released v0.0.<versionNumber> (distinct per
-- schema, prerelease NULL) so they don't collide on the released-semver index.
UPDATE "schema_versions" SET "patch" = "version_number";--> statement-breakpoint
CREATE UNIQUE INDEX "schema_versions_released_semver_idx" ON "schema_versions" USING btree ("schema_id","major","minor","patch") WHERE prerelease IS NULL;