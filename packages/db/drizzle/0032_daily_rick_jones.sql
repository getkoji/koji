-- Per-project roles (oss-372): a grant row now carries the member's role(s)
-- in that project. Column defaults to 'project-member' for NEW rows the app
-- doesn't set explicitly.
--
-- Grandfathering EXISTING oss-370 access-only rows must be NON-ESCALATING:
-- under oss-370 a restricted member's in-project capability was their FULL
-- workspace role (access-gated), so a restricted `viewer` was read-only in
-- their granted project. Derive each grant's project role from the member's
-- workspace role so nobody is silently upgraded to write/admin:
--   owner/tenant-admin        → project-admin   (shouldn't be restricted, but safe)
--   schema-editor/deployer    → project-editor  (had schema/pipeline write)
--   runner/reviewer           → project-member  (had job:run / review:act)
--   viewer (else)             → project-viewer   (read-only)
-- Grandfathering existing workspace ACCESS itself needs no change here —
-- existing members stay project_restricted=false (docs/per-project-roles.md);
-- default-deny applies only to members/projects created after this ships.
ALTER TABLE "project_access" ADD COLUMN "roles" text[] DEFAULT '{project-member}'::text[] NOT NULL;--> statement-breakpoint
UPDATE "project_access" pa SET "roles" = ARRAY[
  CASE
    WHEN m.roles && ARRAY['owner','tenant-admin'] THEN 'project-admin'
    WHEN m.roles && ARRAY['schema-editor','schema-deployer'] THEN 'project-editor'
    WHEN m.roles && ARRAY['runner','reviewer'] THEN 'project-member'
    ELSE 'project-viewer'
  END
]
FROM memberships m
WHERE m.user_id = pa.user_id AND m.tenant_id = pa.tenant_id;
