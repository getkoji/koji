import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eq, and, desc, isNull } from "drizzle-orm";
import crypto from "node:crypto";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal, getProjectId, getRlsScope } from "../auth/middleware";
import { resolveExtractEndpoint, pickActiveTenantModel } from "../extract/resolve-endpoint";
import { createProvider, extractFields, extractKVPairs, kvPairsSummary, toProvenanceTextMap } from "../extract";
import type { FlatTextMapSegment } from "../extract";
import { resolveParse, parseDocument } from "../ingestion/seam";
import type { ParseProvider } from "../parse/provider";
import { checkPreflight, getEffectivePreflightLimits, type PreflightOverrides } from "../billing/plans";
import type { PlanId } from "../billing/adapter";

/**
 * Extraction routes — parse documents and extract structured data.
 *
 * Parse service URL is injected per-request via the Hono context (`c.get("parseUrl")`)
 * so the same handlers run under both the Node self-hosted server (URLs from env) and
 * the hosted platform (URLs from Workers bindings). Extraction runs in-process (TS).
 */

export const extract = new Hono<Env>();

/**
 * Check document against tenant's preflight limits (max pages, max file size).
 * Returns null if OK, or an error string if the document exceeds a limit.
 */
async function checkPreflightLimits(
  db: any,
  tenantId: string,
  pages: number | null | undefined,
  fileSizeMb?: number,
): Promise<string | null> {
  // Tenant-level read (plan limits) — no project narrowing applies.
  const [tenant] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        plan: schema.tenants.plan,
        planOverridesJson: schema.tenants.planOverridesJson,
      })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId))
      .limit(1),
  );
  if (!tenant) return null;

  const baseLimits: PreflightOverrides = {
    max_pages: 20,
    max_size_mb: 10,
  };
  const limits = getEffectivePreflightLimits(
    { plan: (tenant.plan ?? "free") as PlanId, planOverridesJson: tenant.planOverridesJson as any },
    baseLimits,
  );

  return checkPreflight(limits, pages, fileSizeMb);
}

// ── Simple proxy endpoints ──────────────────────────────────────────────

extract.post("/parse", requires("job:run"), async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;

  if (!(file instanceof File)) {
    return c.json({ error: "Missing file" }, 400);
  }

  // Parse through the tenant's BYO parse provider, not the global default parse
  // service — same fix as /process (oss-405). `koji process` (no --schema) and
  // any direct caller hit this on the tenant's configured provider now.
  const { provider: parseProvider } = await resolveParse(c.get("db"), getRlsScope(c), {
    parseProviderId: null,
    defaultProvider: c.get("parseProvider"),
    parseConfig: c.get("parseConfig"),
  });

  const fileBuffer = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || "application/octet-stream";
  const parseStart = Date.now();
  try {
    const result = await parseProvider.parse({ filename: file.name, mimeType, fileBuffer });
    return c.json({ filename: file.name, elapsed_seconds: (Date.now() - parseStart) / 1000, ...result });
  } catch (err) {
    const e = err as { message?: string; status?: number; detail?: string };
    console.error("[parse] Parse failed:", e?.message ?? err, "| detail:", e?.detail ?? "n/a");
    return c.json({ error: "Parse failed", detail: e?.detail ?? e?.message ?? String(err) }, 502);
  }
});

extract.post("/process", requires("job:run"), async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  const schemaField = body.schema;

  if (!(file instanceof File)) {
    return c.json({ error: "Missing file" }, 400);
  }

  // Parse through the tenant's BYO parse provider — matching production — not
  // the global default parse service. The old path POSTed straight to
  // `c.get("parseUrl")`, which bypasses the tenant's configured Doc AI/Textract
  // and 502'd for every document on hosted (where the global backend isn't the
  // tenant's), while `koji corpus add` / build / pipeline test parsed the same
  // PDFs fine because they resolve the tenant provider (oss-405).
  const { provider: parseProvider } = await resolveParse(c.get("db"), getRlsScope(c), {
    parseProviderId: null,
    defaultProvider: c.get("parseProvider"),
    parseConfig: c.get("parseConfig"),
  });

  const fileBuffer = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || "application/octet-stream";
  let parseResult: { markdown: string; pages: number | null; text_map?: unknown; chunks?: unknown };
  const parseStart = Date.now();
  try {
    parseResult = await parseProvider.parse({ filename: file.name, mimeType, fileBuffer });
  } catch (err) {
    const e = err as { message?: string; status?: number; detail?: string };
    console.error(
      "[process] Parse failed:",
      e?.message ?? err,
      "| status:", e?.status ?? "n/a",
      "| detail:", e?.detail ?? "n/a",
    );
    return c.json({ error: "Parse failed", detail: e?.detail ?? e?.message ?? String(err) }, 502);
  }

  // Enforce preflight limits
  const preflightError = await checkPreflightLimits(
    c.get("db"),
    getTenantId(c),
    parseResult.pages as number | null,
    file.size / (1024 * 1024),
  );
  if (preflightError) {
    return c.json({ error: preflightError }, 413);
  }

  if (!schemaField) {
    return c.json({ filename: file.name, ...parseResult });
  }

  let schemaObj: unknown;
  try {
    schemaObj =
      typeof schemaField === "string" ? JSON.parse(schemaField) : schemaField;
  } catch {
    schemaObj = schemaField;
  }

  const schemaDef = schemaObj as Record<string, unknown>;
  const db = c.get("db");
  const tenantId = getTenantId(c);
  let ep1 = null;
  try {
    const requestedModel = (schemaDef.model as string) ?? null;
    const found = await pickActiveTenantModel(db, getRlsScope(c), requestedModel);
    if (found) {
      ep1 = await resolveExtractEndpoint(db, getRlsScope(c), found);
    }
  } catch (err) {
    console.warn("[process] Failed to resolve model endpoint:", err instanceof Error ? err.message : err);
  }
  const modelStr = (schemaDef.model as string) ?? ep1?.model ?? process.env.KOJI_EXTRACT_MODEL ?? "gpt-4o-mini";
  const provider = createProvider(modelStr, ep1);
  const extractResult = await extractFields(
    parseResult.markdown as string,
    schemaDef,
    provider,
    modelStr,
    parseResult.text_map
      ? toProvenanceTextMap(parseResult.text_map as FlatTextMapSegment[])
      : undefined,
    (parseResult.chunks as any[]) ?? undefined,
  );

  return c.json({
    filename: file.name,
    pages: parseResult.pages,
    parse_seconds: (Date.now() - parseStart) / 1000,
    model: extractResult.model,
    schema: extractResult.schema,
    elapsed_ms: extractResult.elapsed_ms,
    extracted: extractResult.extracted,
    confidence: extractResult.confidence,
    confidence_scores: extractResult.confidence_scores,
    fit: extractResult.fit,
  });
});

// ── Build mode extraction (SSE streaming) ───────────────────────────────

extract.post("/extract/run", requires("job:run"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const storage = c.get("storage");

  const body = await c.req.json<{
    corpus_entry_id: string;
    schema_yaml: string;
    model?: string;
    schema_run_id?: string;
    /** Force a fresh parse, bypassing + refreshing the parse cache (oss-298). */
    skip_cache?: boolean;
  }>();

  if (!body.corpus_entry_id || !body.schema_yaml) {
    return c.json(
      { error: "corpus_entry_id and schema_yaml are required" },
      400,
    );
  }

  // Load corpus entry
  const [entry] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({
        storageKey: schema.corpusEntries.storageKey,
        filename: schema.corpusEntries.filename,
        mimeType: schema.corpusEntries.mimeType,
        contentHash: schema.corpusEntries.contentHash,
        schemaId: schema.corpusEntries.schemaId,
      })
      .from(schema.corpusEntries)
      .where(and(eq(schema.corpusEntries.id, body.corpus_entry_id), isNull(schema.corpusEntries.deletedAt)))
      .limit(1),
  );

  if (!entry) {
    return c.json({ error: "Corpus entry not found" }, 404);
  }

  const principal = getPrincipal(c);

  // Existence check — a corpus row whose file was removed from storage 404s
  // before we stream (preserves the prior pre-stream 404 instead of surfacing
  // as a mid-stream parse error).
  const fileResult = await storage.getBuffer(entry.storageKey);
  if (!fileResult) {
    return c.json({ error: "File not found in storage" }, 404);
  }

  // Resolve the tenant's BYO parse provider — test mode must match production.
  // Falls back to the default provider when none is configured (oss-299).
  // Test mode must match production: resolve the tenant's BYO parse provider
  // (the build page is schema-scoped, so no pinned override — pin = null).
  const { provider: parseProvider, fingerprint: parseFingerprint } = await resolveParse(
    db,
    getRlsScope(c),
    {
      parseProviderId: null,
      defaultProvider: c.get("parseProvider"),
      parseConfig: c.get("parseConfig"),
    },
  );

  // Parsing (resolve→parse→cache→flat→nested text_map) runs through the shared
  // seam `parseDocument` (oss-310): one provider-fingerprinted cache for build,
  // ingestion, and validate alike — no more build-private cache copy. `skip_cache`
  // (the build page's "Re-parse" affordance) forces a fresh parse (oss-298).
  const skipCache = body.skip_cache === true;

  // Check Accept header — stream SSE if requested, otherwise JSON
  const accept = c.req.header("accept") ?? "";
  if (!accept.includes("text/event-stream")) {
    // Non-streaming JSON path
    return handleExtractRunJSON(c, entry, body.schema_yaml, body.model, tenantId, db, storage, body.corpus_entry_id, principal.userId, parseProvider, parseFingerprint, skipCache, body.schema_run_id);
  }

  // ── SSE streaming path ──

  return streamSSE(c, async (stream) => {
    try {
      // Step 1: Parse via the shared seam (oss-310) — resolve→parse→cache→shape
      // text_map in one call, the same provider-fingerprinted cache ingestion and
      // validate use (no build-private cache copy, no flat-text_map footgun).
      await stream.writeSSE({
        event: "parse_started",
        data: JSON.stringify({ message: "Parsing document..." }),
      });

      let parsed;
      try {
        parsed = await parseDocument({
          db,
          storage,
          tenantId,
          document: {
            id: body.corpus_entry_id,
            storageKey: entry.storageKey,
            filename: entry.filename,
            mimeType: entry.mimeType,
            contentHash: entry.contentHash,
          },
          provider: parseProvider,
          fingerprint: parseFingerprint,
          skipCache,
        });
      } catch (err: unknown) {
        const e = err as { message?: string; stack?: string; status?: number; detail?: string };
        console.error(
          "[extract/run] Parse failed (SSE path):",
          e?.message ?? err,
          "| status:", e?.status ?? "n/a",
          "| detail:", e?.detail ?? "n/a",
          "\n", e?.stack ?? "(no stack)",
        );
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: err instanceof Error ? err.message : "Parse failed" }),
        });
        return;
      }

      if (!parsed.markdown) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: "Parse returned no markdown" }),
        });
        return;
      }

      await stream.writeSSE({
        event: "parse_complete",
        data: JSON.stringify({
          pages: parsed.pages,
          ocr_skipped: parsed.ocr_skipped,
          cached: parsed.cached,
        }),
      });

      // Enforce preflight limits
      const preflightErr = await checkPreflightLimits(
        db,
        tenantId,
        parsed.pages,
      );
      if (preflightErr) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: preflightErr }),
        });
        return;
      }

      // Step 2: Extract
      await stream.writeSSE({
        event: "extracting",
        data: JSON.stringify({ message: "Running extraction..." }),
      });

      let schemaDef: Record<string, unknown>;
      try {
        const { parse: parseYaml } = await import("yaml");
        schemaDef = parseYaml(body.schema_yaml);
      } catch {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: "Invalid schema YAML" }),
        });
        return;
      }

      let ep2 = null;
      try {
        const requestedModel2 = body.model ?? null;
        const found = await pickActiveTenantModel(db, getRlsScope(c), requestedModel2);
        if (found) ep2 = await resolveExtractEndpoint(db, getRlsScope(c), found);
      } catch {}
      const extractModel = body.model ?? ep2?.model ?? process.env.KOJI_EXTRACT_MODEL ?? "gpt-4o-mini";
      const extractProvider = createProvider(extractModel, ep2);
      const extractResult = await extractFields(
        parsed.markdown,
        schemaDef,
        extractProvider,
        extractModel,
        parsed.textMap,
        parsed.chunks,
      );

      await stream.writeSSE({
        event: "complete",
        data: JSON.stringify({
          filename: entry.filename,
          pages: parsed.pages,
          parse_seconds: null,
          ocr_skipped: parsed.ocr_skipped,
          engine: parsed.engine,
          model: extractResult.model,
          elapsed_ms: extractResult.elapsed_ms,
          extracted: extractResult.extracted,
          confidence: extractResult.confidence,
          confidence_scores: extractResult.confidence_scores,
          fit: extractResult.fit,
          provenance: extractResult.provenance,
          markdown: parsed.markdown,
        }),
      });
    } catch (err: unknown) {
      const e = err as { message?: string; stack?: string; status?: number; detail?: string };
      console.error(
        "[extract/run] Run failed (SSE path):",
        e?.message ?? err,
        "| status:", e?.status ?? "n/a",
        "| detail:", e?.detail ?? "n/a",
        "\n", e?.stack ?? "(no stack)",
      );
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({
          error: err instanceof Error ? err.message : "Unknown error",
        }),
      });
    }
  });
});

/** Non-streaming extract/run — used when client doesn't request SSE */
async function handleExtractRunJSON(
  c: any,
  entry: { storageKey: string; filename: string; mimeType: string; contentHash: string; schemaId: string },
  schemaYaml: string,
  model: string | undefined,
  tenantId: string,
  db: any,
  storage: any,
  corpusEntryId: string,
  userId: string,
  parseProvider: ParseProvider,
  parseFingerprint: string,
  skipCache: boolean,
  schemaRunId?: string,
) {
  // Parse via the shared seam (oss-310) — provider-aware cache + flat→nested
  // text_map shaping, the same path ingestion/validate use. No build-private
  // cache copy. `skipCache` forces a fresh parse (oss-298).
  let parsed;
  try {
    parsed = await parseDocument({
      db,
      storage,
      tenantId,
      document: {
        id: corpusEntryId,
        storageKey: entry.storageKey,
        filename: entry.filename,
        mimeType: entry.mimeType,
        contentHash: entry.contentHash,
      },
      provider: parseProvider,
      fingerprint: parseFingerprint,
      skipCache,
    });
  } catch (err: unknown) {
    const e = err as { message?: string; stack?: string; status?: number; detail?: string };
    console.error(
      "[extract/run] Parse failed (JSON path):",
      e?.message ?? err,
      "| status:", e?.status ?? "n/a",
      "| detail:", e?.detail ?? "n/a",
      "\n", e?.stack ?? "(no stack)",
    );
    return c.json({
      error: "Parse service unreachable",
      detail: err instanceof Error ? err.message : "Connection refused",
    }, 502);
  }

  // Extract
  let schemaDef: Record<string, unknown>;
  try {
    const { parse: parseYaml } = await import("yaml");
    schemaDef = parseYaml(schemaYaml);
  } catch (err: unknown) {
    return c.json({
      error: "Invalid schema YAML",
      detail: err instanceof Error ? err.message : "Parse error",
    }, 422);
  }

  // Resolve model endpoint — look up by model name or use the first active one
  let endpointPayload = null;
  try {
    const found = await pickActiveTenantModel(db, getRlsScope(c), model ?? null);
    if (found) endpointPayload = await resolveExtractEndpoint(db, getRlsScope(c), found);
  } catch (err) {
    console.warn("[extract/run] endpoint resolution failed:", err);
  }

  try {
    const extractModel = model ?? endpointPayload?.model ?? process.env.KOJI_EXTRACT_MODEL ?? "gpt-4o-mini";
    const extractProvider = createProvider(extractModel, endpointPayload);
    const extractResult = await extractFields(
      parsed.markdown,
      schemaDef,
      extractProvider,
      extractModel,
      parsed.textMap,
      parsed.chunks,
    ) as unknown as Record<string, unknown>;

    // Persist the run
    const yamlHash = crypto.createHash("sha256").update(schemaYaml).digest("hex");
    try {
      const [run] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
        tx.insert(schema.extractionRuns).values({
          tenantId,
          schemaId: entry.schemaId,
          corpusEntryId,
          model: String(extractResult.model ?? model ?? "unknown"),
          schemaYamlHash: yamlHash,
          extractedJson: extractResult.extracted,
          confidenceJson: extractResult.confidence,
          confidenceScoresJson: extractResult.confidence_scores,
          provenanceJson: extractResult.provenance ?? null,
          markdownText: parsed.markdown ?? null,
          parseSeconds: null,
          extractMs: extractResult.elapsed_ms as number ?? null,
          ocrSkipped: parsed.ocr_skipped ? "true" : "false",
          cached: parsed.cached ? "true" : "false",
          triggeredBy: userId,
          schemaRunId: schemaRunId ?? null,
        }).returning({ id: schema.extractionRuns.id })
      );
      return c.json({
        id: run!.id,
        filename: entry.filename,
        pages: parsed.pages,
        parse_seconds: null,
        ocr_skipped: parsed.ocr_skipped,
        cached: parsed.cached,
        engine: parsed.engine,
        model: extractResult.model,
        elapsed_ms: extractResult.elapsed_ms,
        extracted: extractResult.extracted,
        confidence: extractResult.confidence,
        confidence_scores: extractResult.confidence_scores,
        fit: extractResult.fit,
        provenance: extractResult.provenance,
        markdown: parsed.markdown,
      });
    } catch (saveErr) {
      console.warn("[extract/run] Failed to save extraction run:", saveErr);
      // Still return results even if save fails
      return c.json({
        filename: entry.filename,
        pages: parsed.pages,
        parse_seconds: null,
        ocr_skipped: parsed.ocr_skipped,
        cached: parsed.cached,
        engine: parsed.engine,
        model: extractResult.model,
        elapsed_ms: extractResult.elapsed_ms,
        extracted: extractResult.extracted,
        confidence: extractResult.confidence,
        confidence_scores: extractResult.confidence_scores,
        fit: extractResult.fit,
        provenance: extractResult.provenance,
        markdown: parsed.markdown,
      });
    }
  } catch (err: unknown) {
    return c.json({
      error: "Extract service unreachable",
      detail: err instanceof Error ? err.message : "Connection refused",
    }, 502);
  }
}

// ── Extraction run history ──────────────────────────────────────────────

/**
 * GET /api/extract/runs/:corpusEntryId — latest extraction run for a corpus entry.
 */
extract.get("/extract/runs/:corpusEntryId", requires("job:run"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const corpusEntryId = c.req.param("corpusEntryId")!;

  const [run] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({
      id: schema.extractionRuns.id,
      model: schema.extractionRuns.model,
      extractedJson: schema.extractionRuns.extractedJson,
      confidenceJson: schema.extractionRuns.confidenceJson,
      confidenceScoresJson: schema.extractionRuns.confidenceScoresJson,
      provenanceJson: schema.extractionRuns.provenanceJson,
      markdownText: schema.extractionRuns.markdownText,
      parseSeconds: schema.extractionRuns.parseSeconds,
      extractMs: schema.extractionRuns.extractMs,
      ocrSkipped: schema.extractionRuns.ocrSkipped,
      cached: schema.extractionRuns.cached,
      createdAt: schema.extractionRuns.createdAt,
    })
      .from(schema.extractionRuns)
      .where(eq(schema.extractionRuns.corpusEntryId, corpusEntryId))
      .orderBy(desc(schema.extractionRuns.createdAt))
      .limit(1),
  );

  if (!run) {
    return c.json({ data: null });
  }

  return c.json({
    data: {
      id: run.id,
      model: run.model,
      extracted: run.extractedJson,
      confidence: run.confidenceJson,
      confidence_scores: run.confidenceScoresJson,
      parse_seconds: run.parseSeconds ? Number(run.parseSeconds) : null,
      elapsed_ms: run.extractMs,
      ocr_skipped: run.ocrSkipped === "true",
      cached: run.cached === "true",
      created_at: run.createdAt,
      provenance: run.provenanceJson ?? null,
      markdown: run.markdownText ?? null,
    },
  });
});

/**
 * POST /api/extract/compare — compare extractions from two documents.
 *
 * Accepts two corpus entry IDs, fetches their latest extraction runs,
 * and returns a field-by-field diff.
 */
extract.post("/extract/compare", requires("job:run"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const body = await c.req.json<{ entry_a: string; entry_b: string }>();

  if (!body.entry_a || !body.entry_b) {
    return c.json({ error: "entry_a and entry_b are required" }, 400);
  }

  // Fetch latest extraction run for each entry
  const fetchRun = async (entryId: string) => {
    const [run] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
      tx.select({
        id: schema.extractionRuns.id,
        extractedJson: schema.extractionRuns.extractedJson,
        confidenceScoresJson: schema.extractionRuns.confidenceScoresJson,
        model: schema.extractionRuns.model,
        createdAt: schema.extractionRuns.createdAt,
      })
        .from(schema.extractionRuns)
        .where(eq(schema.extractionRuns.corpusEntryId, entryId))
        .orderBy(desc(schema.extractionRuns.createdAt))
        .limit(1),
    );
    return run ?? null;
  };

  // Fetch corpus entry filenames
  const fetchEntry = async (entryId: string) => {
    const [entry] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
      tx.select({ id: schema.corpusEntries.id, filename: schema.corpusEntries.filename })
        .from(schema.corpusEntries)
        .where(and(eq(schema.corpusEntries.id, entryId), isNull(schema.corpusEntries.deletedAt)))
        .limit(1),
    );
    return entry ?? null;
  };

  const [runA, runB, entryA, entryB] = await Promise.all([
    fetchRun(body.entry_a),
    fetchRun(body.entry_b),
    fetchEntry(body.entry_a),
    fetchEntry(body.entry_b),
  ]);

  if (!runA || !runB) {
    return c.json({
      error: "Both documents must have extraction runs. Run extraction first.",
    }, 400);
  }

  const extractedA = (runA.extractedJson ?? {}) as Record<string, unknown>;
  const extractedB = (runB.extractedJson ?? {}) as Record<string, unknown>;
  const confidenceA = (runA.confidenceScoresJson ?? {}) as Record<string, number>;
  const confidenceB = (runB.confidenceScoresJson ?? {}) as Record<string, number>;

  // Build diff
  const allFields = new Set([...Object.keys(extractedA), ...Object.keys(extractedB)]);
  const fields: Array<{
    field: string;
    value_a: unknown;
    value_b: unknown;
    confidence_a: number | null;
    confidence_b: number | null;
    status: "match" | "diff" | "added" | "removed";
  }> = [];

  for (const field of allFields) {
    const inA = field in extractedA;
    const inB = field in extractedB;
    const valA = extractedA[field] ?? null;
    const valB = extractedB[field] ?? null;

    let status: "match" | "diff" | "added" | "removed";
    if (!inA || valA == null) {
      status = inB && valB != null ? "added" : "match";
    } else if (!inB || valB == null) {
      status = "removed";
    } else if (String(valA) === String(valB)) {
      status = "match";
    } else {
      status = "diff";
    }

    fields.push({
      field,
      value_a: valA,
      value_b: valB,
      confidence_a: confidenceA[field] ?? null,
      confidence_b: confidenceB[field] ?? null,
      status,
    });
  }

  const summary = {
    total: fields.length,
    matches: fields.filter((f) => f.status === "match").length,
    diffs: fields.filter((f) => f.status === "diff").length,
    added: fields.filter((f) => f.status === "added").length,
    removed: fields.filter((f) => f.status === "removed").length,
  };

  return c.json({
    data: {
      entry_a: { id: body.entry_a, filename: entryA?.filename ?? "Unknown", model: runA.model, run_id: runA.id },
      entry_b: { id: body.entry_b, filename: entryB?.filename ?? "Unknown", model: runB.model, run_id: runB.id },
      fields,
      summary,
    },
  });
});
