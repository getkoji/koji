/**
 * Structured log export — GET /api/projects/:slug/logs
 *
 * Returns a chronologically-sorted stream of structured log entries
 * for SIEM integration (Splunk, Datadog, ELK). Combines extraction
 * traces and audit log entries into a unified format.
 *
 * Filters: since (ISO 8601), level (info|warn|error), kind (audit|trace), limit.
 */

import { Hono } from "hono";
import { eq, and, gte, desc } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId } from "../auth/middleware";

export const logs = new Hono<Env>();

/** Unified log entry shape for SIEM consumers. */
interface LogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  kind: "audit" | "trace";
  action: string;
  resource_type: string;
  resource_id: string;
  actor?: { type: string; id: string | null };
  trace_id?: string;
  duration_ms?: number | null;
  status?: string;
  details?: unknown;
  ip_address?: string | null;
  user_agent?: string | null;
}

/** Map trace status to a log level. */
function traceStatusToLevel(status: string): "info" | "warn" | "error" {
  if (status === "failed" || status === "error") return "error";
  if (status === "timeout" || status === "partial") return "warn";
  return "info";
}

/** Map audit action to a log level. */
function auditActionToLevel(action: string): "info" | "warn" | "error" {
  if (action === "delete" || action === "revoke") return "warn";
  return "info";
}

logs.get("/:slug/logs", requires("trace:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const projectSlug = c.req.param("slug")!;

  // Parse query filters
  const sinceParam = c.req.query("since");
  const levelParam = c.req.query("level") as "info" | "warn" | "error" | undefined;
  const kindParam = c.req.query("kind") as "audit" | "trace" | undefined;
  const limitParam = Math.min(parseInt(c.req.query("limit") ?? "100", 10), 1000);

  const sinceDate = sinceParam ? new Date(sinceParam) : undefined;
  if (sinceParam && isNaN(sinceDate!.getTime())) {
    return c.json({ error: "Invalid 'since' parameter — use ISO 8601 format" }, 400);
  }

  // Resolve project to verify it exists and belongs to this tenant
  const [project] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.slug, projectSlug))
      .limit(1),
  );
  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  const entries: LogEntry[] = [];

  // ── Fetch traces (extraction logs) ──
  // Traces are tenant-scoped (RLS enforced). The project slug verifies the
  // caller has access to this project; trace data is returned at tenant level
  // since the data model doesn't link traces → projects directly.
  if (kindParam !== "audit") {
    const traceConditions = sinceDate
      ? [gte(schema.traces.startedAt, sinceDate)]
      : [];

    const traceRows = await withRLS(db, tenantId, (tx) => {
      const base = tx
        .select({
          traceId: schema.traces.traceExternalId,
          status: schema.traces.status,
          durationMs: schema.traces.totalDurationMs,
          startedAt: schema.traces.startedAt,
          documentId: schema.traces.documentId,
          jobId: schema.traces.jobId,
          filename: schema.documents.filename,
        })
        .from(schema.traces)
        .innerJoin(schema.documents, eq(schema.traces.documentId, schema.documents.id))
        .innerJoin(schema.jobs, eq(schema.traces.jobId, schema.jobs.id));

      const filtered =
        traceConditions.length > 0 ? base.where(and(...traceConditions)) : base;
      return filtered.orderBy(desc(schema.traces.startedAt)).limit(limitParam);
    });

    for (const row of traceRows) {
      const level = traceStatusToLevel(row.status);
      if (levelParam && level !== levelParam) continue;

      entries.push({
        timestamp: row.startedAt.toISOString(),
        level,
        kind: "trace",
        action: "extraction",
        resource_type: "document",
        resource_id: row.documentId,
        trace_id: row.traceId,
        duration_ms: row.durationMs,
        status: row.status,
        details: { filename: row.filename, job_id: row.jobId },
      });
    }
  }

  // ── Fetch audit log entries ──
  if (kindParam !== "trace") {
    const auditConditions: ReturnType<typeof eq>[] = [];
    if (sinceDate) {
      auditConditions.push(gte(schema.auditLog.createdAt, sinceDate));
    }

    const auditRows = await withRLS(db, tenantId, (tx) => {
      const base = tx
        .select({
          action: schema.auditLog.action,
          actorType: schema.auditLog.actorType,
          actorId: schema.auditLog.actorId,
          resourceType: schema.auditLog.resourceType,
          resourceId: schema.auditLog.resourceId,
          traceId: schema.auditLog.traceId,
          ipAddress: schema.auditLog.ipAddress,
          userAgent: schema.auditLog.userAgent,
          detailsJson: schema.auditLog.detailsJson,
          createdAt: schema.auditLog.createdAt,
        })
        .from(schema.auditLog);

      const filtered =
        auditConditions.length > 0 ? base.where(and(...auditConditions)) : base;
      return filtered.orderBy(desc(schema.auditLog.createdAt)).limit(limitParam);
    });

    for (const row of auditRows) {
      const level = auditActionToLevel(row.action);
      if (levelParam && level !== levelParam) continue;

      entries.push({
        timestamp: row.createdAt.toISOString(),
        level,
        kind: "audit",
        action: row.action,
        resource_type: row.resourceType,
        resource_id: row.resourceId,
        actor: { type: row.actorType, id: row.actorId },
        trace_id: row.traceId ?? undefined,
        ip_address: row.ipAddress,
        user_agent: row.userAgent,
        details: row.detailsJson,
      });
    }
  }

  // Sort combined entries by timestamp descending, then trim to limit
  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const result = entries.slice(0, limitParam);

  return c.json({
    data: result,
    meta: {
      count: result.length,
      filters: {
        since: sinceParam ?? null,
        level: levelParam ?? null,
        kind: kindParam ?? null,
        limit: limitParam,
      },
    },
  });
});
