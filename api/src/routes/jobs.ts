import { Hono } from "hono";
import { eq, sql, desc } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../index";

const DEFAULT_TENANT = process.env.KOJI_TENANT_ID ?? "00000000-0000-0000-0000-000000000000";

export const jobs = new Hono<Env>();

jobs.get("/", async (c) => {
  const db = c.get("db");
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const status = c.req.query("status");

  const rows = await withRLS(db, DEFAULT_TENANT, (tx) => {
    let q = tx
      .select({
        slug: schema.jobs.slug,
        pipelineId: schema.jobs.pipelineId,
        status: schema.jobs.status,
        docsTotal: schema.jobs.docsTotal,
        docsProcessed: schema.jobs.docsProcessed,
        docsPassed: schema.jobs.docsPassed,
        docsFailed: schema.jobs.docsFailed,
        avgLatencyMs: schema.jobs.avgLatencyMs,
        totalCostUsd: schema.jobs.totalCostUsd,
        startedAt: schema.jobs.startedAt,
        completedAt: schema.jobs.completedAt,
        createdAt: schema.jobs.createdAt,
      })
      .from(schema.jobs)
      .orderBy(desc(schema.jobs.createdAt))
      .limit(limit);

    if (status) {
      q = q.where(eq(schema.jobs.status, status)) as typeof q;
    }
    return q;
  });
  return c.json({ data: rows });
});

jobs.get("/:slug", async (c) => {
  const db = c.get("db");
  const slug = c.req.param("slug");
  const rows = await withRLS(db, DEFAULT_TENANT, (tx) =>
    tx
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.slug, slug))
      .limit(1)
  );
  if (rows.length === 0) {
    return c.json({ error: "Job not found" }, 404);
  }
  return c.json(rows[0]);
});
