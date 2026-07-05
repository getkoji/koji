-- Project isolation, second wave (oss-368): agent_sessions + notifications.
--
-- agent_sessions.project_id is NOT NULL (every session is about a schema, so
-- it inherits that schema's project); added nullable → backfilled → NOT NULL.
-- notifications.project_id is NULLABLE (tenant-level notifications have none);
-- backfilled best-effort from the job/document/pipeline the notification
-- references. The matching RLS policies live in 0001_rls.sql.

ALTER TABLE "agent_sessions" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "project_id" uuid;--> statement-breakpoint

-- agent_sessions: project = the schema the session is about (context_entity_id
-- points at schemas.id), falling back to the tenant's default project for any
-- orphaned session whose schema no longer exists (keeps NOT NULL satisfiable).
UPDATE agent_sessions s SET project_id = sc.project_id
  FROM schemas sc WHERE sc.id::text = s.context_entity_id AND s.project_id IS NULL;--> statement-breakpoint
UPDATE agent_sessions s SET project_id = dp.id
  FROM (SELECT DISTINCT ON (p.tenant_id) p.tenant_id, p.id FROM projects p JOIN tenants t ON t.id = p.tenant_id WHERE p.deleted_at IS NULL ORDER BY p.tenant_id, (p.slug = t.slug) DESC, p.created_at ASC, p.id ASC) dp
  WHERE dp.tenant_id = s.tenant_id AND s.project_id IS NULL;--> statement-breakpoint

-- notifications: best-effort project from the referenced job → document → pipeline.
-- Anything without a resolvable reference stays NULL (tenant-level), which the
-- null-aware RLS policy keeps visible in every project.
UPDATE notifications n SET project_id = j.project_id
  FROM jobs j WHERE (n.data_json->>'jobId')::uuid = j.id AND n.project_id IS NULL;--> statement-breakpoint
UPDATE notifications n SET project_id = j.project_id
  FROM documents d JOIN jobs j ON j.id = d.job_id
  WHERE (n.data_json->>'documentId')::uuid = d.id AND n.project_id IS NULL;--> statement-breakpoint
UPDATE notifications n SET project_id = p.project_id
  FROM pipelines p WHERE (n.data_json->>'pipelineId')::uuid = p.id AND n.project_id IS NULL;--> statement-breakpoint

ALTER TABLE "agent_sessions" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_sessions_project_idx" ON "agent_sessions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "notifications_project_created_idx" ON "notifications" USING btree ("project_id","created_at");
