/**
 * `pipeline.dag.run` worker — executes a DAG pipeline for a document.
 *
 * Similar to `ingestion.process` but walks the pipeline DAG instead of
 * running the legacy single-schema extraction. Persists per-step results
 * to `pipeline_step_runs` and updates the document row with the final
 * extraction result.
 */

import { eq, sql } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import { schema, withRLS } from "@koji/db";
import type { Db } from "@koji/db";
import type { QueuedJob } from "../queue/provider";
import type { StorageProvider } from "../storage/provider";
import type { ParseProvider } from "../parse/provider";
import { resolveExtractEndpoint } from "../extract/resolve-endpoint";
import { createProvider } from "../extract/providers";
import { extractFields } from "../extract/pipeline";
import { TerminalError } from "../queue/worker";

let _db: Db | null = null;
let _storage: StorageProvider | null = null;
let _parseProvider: ParseProvider | null = null;

export function initDagRunner(db: Db, storage: StorageProvider) {
  _db = db;
  _storage = storage;
}

export function setDagParseProvider(provider: ParseProvider) {
  _parseProvider = provider;
}

// Step cost lookup
const STEP_COSTS: Record<string, number> = {
  classify: 0.005, extract: 0.08, ocr: 0.03, split: 0.01,
  tag: 0, filter: 0, webhook: 0, transform: 0, gate: 0,
};

interface TestEdge { from: string; to: string; when?: string; default?: boolean }

function evalCondition(condition: string, context: Record<string, unknown>): boolean {
  const m = condition.match(/^([\w.]+)\s*(==|!=|>=?|<=?|in)\s*(.+)$/);
  if (!m) return true;
  let current: unknown = context;
  for (const part of m[1]!.split(".")) {
    if (current == null || typeof current !== "object") return false;
    current = (current as Record<string, unknown>)[part];
  }
  const left = current;
  const raw = m[3]!.trim();
  let right: unknown;
  if (raw.startsWith("'") && raw.endsWith("'")) right = raw.slice(1, -1);
  else if (!isNaN(Number(raw))) right = Number(raw);
  else right = raw;
  switch (m[2]) {
    case "==": return left === right;
    case "!=": return left !== right;
    case ">": return (left as number) > (right as number);
    case ">=": return (left as number) >= (right as number);
    case "<": return (left as number) < (right as number);
    case "<=": return (left as number) <= (right as number);
    default: return true;
  }
}

function resolveNextStep(edges: TestEdge[], output: Record<string, unknown>): string | null {
  for (const e of edges) {
    if (!e.when && !e.default) return e.to;
    if (e.when && evalCondition(e.when, { output })) return e.to;
  }
  return edges.find(e => e.default)?.to ?? null;
}

export async function handleDagRun(job: QueuedJob): Promise<void> {
  const db = _db!;
  const storage = _storage!;
  const { documentId, pipelineId } = job.payload as { documentId: string; pipelineId: string };
  const tenantId = job.tenantId;

  // Load document
  const [doc] = await withRLS(db, tenantId, (tx) =>
    tx.select({
      id: schema.documents.id,
      filename: schema.documents.filename,
      storageKey: schema.documents.storageKey,
      mimeType: schema.documents.mimeType,
      fileSize: schema.documents.fileSize,
    })
    .from(schema.documents)
    .where(eq(schema.documents.id, documentId))
    .limit(1),
  );
  if (!doc) throw new TerminalError(`Document ${documentId} not found`);

  // Mark document as processing
  await withRLS(db, tenantId, (tx) =>
    tx.update(schema.documents)
      .set({ status: "processing", startedAt: new Date() })
      .where(eq(schema.documents.id, documentId)),
  );

  // Load pipeline YAML
  const [pipeline] = await withRLS(db, tenantId, (tx) =>
    tx.select({
      yamlSource: schema.pipelines.yamlSource,
      modelProviderId: schema.pipelines.modelProviderId,
    })
    .from(schema.pipelines)
    .where(eq(schema.pipelines.id, pipelineId))
    .limit(1),
  );
  if (!pipeline?.yamlSource) throw new TerminalError(`Pipeline ${pipelineId} has no YAML`);

  // Parse YAML into steps + edges
  const parsed = parseYaml(pipeline.yamlSource);
  type PStep = { id: string; type: string; config: Record<string, unknown> };
  const pSteps: PStep[] = (parsed.steps || []).map((s: any) => ({
    id: s.id, type: s.type, config: s.config || {},
  }));
  const pEdges: TestEdge[] = [];
  for (const s of parsed.steps || []) {
    if (Array.isArray(s.routes)) {
      for (const r of s.routes) {
        if (r.goto) pEdges.push({ from: s.id, to: r.goto, when: r.when, default: r.default });
      }
    }
    if (s.next) pEdges.push({ from: s.id, to: s.next });
  }
  if (pEdges.length === 0 && pSteps.length > 1) {
    for (let i = 0; i < pSteps.length - 1; i++) {
      pEdges.push({ from: pSteps[i]!.id, to: pSteps[i + 1]!.id });
    }
  }

  // Parse the document
  let docText: string | undefined;
  let pageCount: number | undefined;
  try {
    if (_parseProvider) {
      const file = await storage.getBuffer(doc.storageKey);
      if (file) {
        const parseResult = await _parseProvider.parse({
          filename: doc.filename,
          mimeType: doc.mimeType,
          fileBuffer: file.data,
        });
        docText = parseResult.markdown;
        pageCount = parseResult.pages ?? undefined;
      }
    }
  } catch (err) {
    console.error(`[dag-runner] Parse failed for ${doc.filename}:`, (err as Error).message);
  }

  // Resolve model endpoint
  const endpoint = await resolveExtractEndpoint(db, tenantId, pipeline.modelProviderId);

  // Walk the DAG
  const withIncoming = new Set(pEdges.map(e => e.to));
  let currentId: string | null = pSteps.find(s => !withIncoming.has(s.id))?.id || pSteps[0]?.id || null;
  const stepOutputs: Record<string, Record<string, unknown>> = {};
  let stepOrder = 0;
  let totalCost = 0;
  let finalExtraction: Record<string, unknown> | null = null;
  let finalConfidence: number | null = null;

  while (currentId && stepOrder < 20) {
    const step = pSteps.find(s => s.id === currentId);
    if (!step) break;
    stepOrder++;

    const stepStart = Date.now();
    let output: Record<string, unknown> = {};
    let status = "completed";
    let error: string | undefined;
    const cost = STEP_COSTS[step.type] ?? 0;

    try {
      switch (step.type) {
        case "classify": {
          const labels = (step.config.labels as Array<{ id: string; description?: string; keywords?: string[] }>) || [];
          const method = (step.config.method as string) || "keyword_then_llm";
          const question = (step.config.question as string) || "What type of document is this?";
          const text = (docText || doc.filename).toLowerCase();

          // Keyword classification
          let classified = false;
          if (method !== "llm") {
            for (const label of labels) {
              if (!label.keywords?.length) continue;
              const hits = label.keywords.filter(kw => text.includes(kw.toLowerCase()));
              if (hits.length >= 2) {
                output = { label: label.id, confidence: 1.0, method: "keyword", reasoning: `Matched: ${hits.join(", ")}` };
                classified = true;
                break;
              }
            }
          }

          // LLM classification
          if (!classified && method !== "keyword" && endpoint) {
            const provider = createProvider(endpoint.model, endpoint);
            const labelDesc = labels.map(l => `- "${l.id}"${l.description ? `: ${l.description}` : ""}`).join("\n");
            const prompt = `${question}\n\nClassify into one category:\n${labelDesc}\n\nText:\n${(docText || doc.filename).slice(0, 3000)}\n\nRespond JSON only: {"label":"<id>","confidence":<0-1>,"reasoning":"<why>"}`;
            const raw = await provider.generate(prompt, true);
            try {
              const p = JSON.parse(raw);
              output = { label: p.label, confidence: p.confidence ?? 0.8, method: "llm", reasoning: p.reasoning };
            } catch {
              output = { label: labels[0]?.id || "unknown", confidence: 0.5, method: "llm", reasoning: "Failed to parse LLM response" };
            }
          } else if (!classified) {
            output = { label: labels[labels.length - 1]?.id || "unknown", confidence: 0.5, method: method === "keyword" ? "keyword" : "no_endpoint" };
          }
          break;
        }

        case "extract": {
          const schemaSlug = (step.config.schema as string) || "";
          if (schemaSlug && docText && endpoint) {
            const srRows = await withRLS(db, tenantId, (tx) =>
              tx.select({ currentVersionId: schema.schemas.currentVersionId })
                .from(schema.schemas).where(eq(schema.schemas.slug, schemaSlug)).limit(1),
            );
            const sr = srRows[0] as { currentVersionId: string | null } | undefined;
            if (sr?.currentVersionId) {
              const verRows = await withRLS(db, tenantId, (tx) =>
                tx.select({ parsedJson: schema.schemaVersions.parsedJson })
                  .from(schema.schemaVersions).where(eq(schema.schemaVersions.id, sr.currentVersionId!)).limit(1),
              );
              const ver = verRows[0] as { parsedJson: Record<string, unknown> | null } | undefined;
              if (ver?.parsedJson) {
                const provider = createProvider(endpoint.model, endpoint);
                const result = await extractFields(docText, ver.parsedJson, provider, endpoint.model);
                const fieldNames = Object.keys(result.extracted || {});
                const nonNull = fieldNames.filter(f => result.extracted[f] != null);
                const scores = Object.values(result.confidence_scores || {});
                const avgConf = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
                output = { schema: schemaSlug, fields: result.extracted, fieldCount: nonNull.length, totalFields: fieldNames.length, confidence: avgConf };
                finalExtraction = result.extracted;
                finalConfidence = avgConf;
              }
            }
          }
          if (!output.schema) output = { schema: schemaSlug, fields: {}, fieldCount: 0, totalFields: 0, note: "Could not run extraction" };
          break;
        }

        case "tag":
          output = { tags: (step.config.tags as Record<string, string>) || {} };
          break;

        case "filter": {
          const passed = evalCondition((step.config.condition as string) || "true", { document: doc, steps: stepOutputs });
          output = { passed };
          if (!passed && step.config.on_fail === "fail") { status = "failed"; error = "Filter blocked"; }
          break;
        }

        case "webhook": {
          const webhookUrl = step.config.url as string;
          if (webhookUrl) {
            const method = ((step.config.method as string) || "POST").toUpperCase();
            const customHeaders = (step.config.headers as Record<string, string>) || {};
            const payloadMode = (step.config.payload as string) || "result";

            // Build payload based on mode
            let payload: Record<string, unknown>;
            if (payloadMode === "document") {
              payload = { document_id: documentId, filename: doc.filename, mime_type: doc.mimeType };
            } else if (payloadMode === "metadata") {
              payload = { document_id: documentId, tenant_id: tenantId, step_outputs: stepOutputs };
            } else {
              // "result" — extraction + document info
              const extractOutput = Object.values(stepOutputs).reverse().find(o => o?.fields);
              payload = {
                document_id: documentId,
                tenant_id: tenantId,
                extraction: extractOutput || {},
                document: { filename: doc.filename, mime_type: doc.mimeType, page_count: pageCount },
              };
            }

            try {
              const resp = await fetch(webhookUrl, {
                method,
                headers: { "Content-Type": "application/json", ...customHeaders },
                body: JSON.stringify(payload),
              });
              output = { status_code: resp.status, delivered: resp.ok };
            } catch (err) {
              output = { status_code: 0, delivered: false, error: (err as Error).message };
            }
          } else {
            output = { skipped: true, reason: "No URL configured" };
          }
          break;
        }

        case "transform": {
          const ops = (step.config.operations as Array<Record<string, unknown>>) || [];
          let fields: Record<string, unknown> = {};
          for (const so of Object.values(stepOutputs)) {
            if (so?.fields && typeof so.fields === "object") {
              fields = { ...fields, ...(so.fields as Record<string, unknown>) };
            }
          }
          const applied: string[] = [];
          for (const op of ops) {
            if (op.rename && typeof op.rename === "object") {
              const { from: f, to: t } = op.rename as { from: string; to: string };
              if (f in fields) { fields[t] = fields[f]; delete fields[f]; applied.push(`rename: ${f} → ${t}`); }
            } else if (op.set && typeof op.set === "object") {
              const { field: f, value: v } = op.set as { field: string; value: unknown };
              fields[f] = typeof v === "string" ? v.replace("{{now}}", new Date().toISOString()) : v;
              applied.push(`set: ${f}`);
            } else if (op.remove && typeof op.remove === "object") {
              const { field: f } = op.remove as { field: string };
              delete fields[f]; applied.push(`remove: ${f}`);
            }
          }
          output = { fields, operations_applied: applied };
          break;
        }

        default:
          output = { note: `Step type "${step.type}" executed` };
      }
    } catch (err) {
      status = "failed";
      error = (err as Error).message;
    }

    const durationMs = Date.now() - stepStart;
    totalCost += cost;

    // Persist step run
    await withRLS(db, tenantId, (tx) =>
      tx.insert(schema.pipelineStepRuns).values({
        tenantId,
        documentId,
        jobId: doc.id, // TODO: use actual jobId
        stepId: step.id,
        stepType: step.type,
        stepOrder,
        status,
        outputJson: output,
        errorMessage: error,
        durationMs,
        costUsd: String(cost),
        startedAt: new Date(Date.now() - durationMs),
        completedAt: new Date(),
      }),
    );

    stepOutputs[step.id] = output;
    if (status === "failed") break;

    // Resolve next step
    const outEdges = pEdges.filter(e => e.from === step.id);
    currentId = resolveNextStep(outEdges, output);
  }

  // Update document with final result
  const updates: Record<string, unknown> = {
    status: finalExtraction ? "completed" : "completed",
    completedAt: new Date(),
    pageCount,
    costUsd: String(totalCost),
    durationMs: Date.now() - (doc as any).startedAt?.getTime?.() || 0,
  };
  if (finalExtraction) {
    updates.extractionJson = finalExtraction;
    updates.confidence = String(finalConfidence ?? 0);
  }

  await withRLS(db, tenantId, (tx) =>
    tx.update(schema.documents).set(updates).where(eq(schema.documents.id, documentId)),
  );

  // Update job stats
  const [jobRow] = await withRLS(db, tenantId, (tx) =>
    tx.select({ jobId: schema.documents.jobId }).from(schema.documents)
      .where(eq(schema.documents.id, documentId)).limit(1),
  );
  if (jobRow?.jobId) {
    await withRLS(db, tenantId, (tx) =>
      tx.update(schema.jobs).set({
        docsProcessed: sql`docs_processed + 1`,
        docsPassed: finalExtraction ? sql`docs_passed + 1` : sql`docs_passed`,
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(schema.jobs.id, jobRow.jobId)),
    );
  }
}
