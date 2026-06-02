CREATE TABLE IF NOT EXISTS "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "type" varchar(64) NOT NULL,
  "title" varchar(255) NOT NULL,
  "body" text,
  "data_json" jsonb,
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "notifications_tenant_created_idx" ON "notifications" ("tenant_id", "created_at" DESC);

-- RLS
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "notifications"
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
