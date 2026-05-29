import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eq, and, desc } from "drizzle-orm";
import crypto from "node:crypto";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal } from "../auth/middleware";
import { resolveExtractEndpoint } from "../extract/resolve-endpoint";
import { createProvider, extractFields, extractKVPairs, kvPairsSummary } from "../extract";
import { checkPreflight, getEffectivePreflightLimits, type PreflightOverrides } from "../billing/plans";
import type { PlanId } from "../billing/adapter";

/**
 * Extraction routes — proxies to the parse + extract services.
 *
 * Service URLs are injected per-request via the Hono context (`c.get("parseUrl")`,
 * `c.get("extractUrl")`) so the same handlers run under both the Node self-hosted
 * server (URLs from env) and the hosted platform (URLs from Workers bindings).
 */

export const extract = new Hono<Env>();

/**
 * Resolve a service URL. Docker sidecars serve at /parse or /extract,
 * but Modal endpoints serve at the root.
 */
function resolveServiceUrl(baseUrl: string, path: string): string {
  if (baseUrl.includes("modal.run")) return baseUrl;
  return `${baseUrl}${path}`;
}

// Backwards compat alias
function resolveParseUrl(baseUrl: string, path = "/parse"): string {
  return resolveServiceUrl(baseUrl, path);
}

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

  const formData = new FormData();
  formData.append("file", file);

  const resp = await fetch(`${resolveParseUrl(c.get("parseUrl"))}`, {
    method: "POST",
    body: formData,
  });

  const result = await resp.json();
  return c.json(result, resp.status as 200);
});

extract.post("/process", requires("job:run"), async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  const schemaField = body.schema;

  if (!(file instanceof File)) {
    return c.json({ error: "Missing file" }, 400);
  }

  const parseForm = new FormData();
  parseForm.append("file", file);

  const parseResp = await fetch(`${resolveParseUrl(c.get("parseUrl"))}`, {
    method: "POST",
    body: parseForm,
  });

  if (!parseResp.ok) {
    const err = await parseResp.json().catch(() => ({}));
    return c.json({ error: "Parse failed", detail: err }, 502);
  }

  const parseResult = (await parseResp.json()) as Record<string, unknown>;

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
    return c.json(parseResult);
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
    const [found] = await withRLS(db, tenantId, (tx) =>
      tx.select({ id: schema.modelEndpoints.id, model: schema.modelEndpoints.model }).from(schema.modelEndpoints)
        .where(and(eq(schema.modelEndpoints.status, "active"), ...(requestedModel ? [eq(schema.modelEndpoints.model, requestedModel)] : [])))
        .limit(1));
    if (found) {
      ep1 = await resolveExtractEndpoint(db, tenantId, found.id);
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
    (parseResult.text_map as any[]) ?? undefined,
  );

  return c.json({
    filename: parseResult.filename,
    pages: parseResult.pages,
    parse_seconds: parseResult.elapsed_seconds,
    model: extractResult.model,
    schema: extractResult.schema,
    elapsed_ms: extractResult.elapsed_ms,
    extracted: extractResult.extracted,
    confidence: extractResult.confidence,
    confidence_scores: extractResult.confidence_scores,
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
  }>();

  if (!body.corpus_entry_id || !body.schema_yaml) {
    return c.json(
      { error: "corpus_entry_id and schema_yaml are required" },
      400,
    );
  }

  // Load corpus entry
  const [entry] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        storageKey: schema.corpusEntries.storageKey,
        filename: schema.corpusEntries.filename,
        mimeType: schema.corpusEntries.mimeType,
        schemaId: schema.corpusEntries.schemaId,
      })
      .from(schema.corpusEntries)
      .where(eq(schema.corpusEntries.id, body.corpus_entry_id))
      .limit(1),
  );

  if (!entry) {
    return c.json({ error: "Corpus entry not found" }, 404);
  }

  const principal = getPrincipal(c);

  // Fetch file from S3
  const fileResult = await storage.getBuffer(entry.storageKey);
  if (!fileResult) {
    return c.json({ error: "File not found in storage" }, 404);
  }
  const fileBuffer = fileResult.data;

  // Check parse cache
  const fileHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");
  const [cached] = await withRLS(db, tenantId, (tx) =>
    tx.select({
      storageKey: schema.parseCache.storageKey,
      pages: schema.parseCache.pages,
      ocrSkipped: schema.parseCache.ocrSkipped,
    })
      .from(schema.parseCache)
      .where(and(
        eq(schema.parseCache.tenantId, tenantId),
        eq(schema.parseCache.fileHash, fileHash),
      ))
      .limit(1),
  );

  let parseResult: Record<string, unknown> | null = null;
  if (cached) {
    // Cache hit — load parsed result from S3
    const cacheResult = await storage.getBuffer(cached.storageKey);
    if (cacheResult) {
      parseResult = JSON.parse(cacheResult.data.toString());
      (parseResult as any).cached = true;
      (parseResult as any).pages = cached.pages;
      (parseResult as any).ocr_skipped = cached.ocrSkipped === "true";
    }
  }

  // Check Accept header — stream SSE if requested, otherwise JSON
  const accept = c.req.header("accept") ?? "";
  if (!accept.includes("text/event-stream")) {
    // Non-streaming JSON path
    return handleExtractRunJSON(c, entry, fileBuffer, body.schema_yaml, body.model, tenantId, db, storage, fileHash, parseResult, body.corpus_entry_id, principal.userId, body.schema_run_id);
  }

  // ── SSE streaming path ──

  return streamSSE(c, async (stream) => {
    try {
      // Step 1: Parse via ParseProvider (gets LiteParse routing, text_map, etc.)
      let parseResult: Record<string, unknown> | null = null;

      await stream.writeSSE({
        event: "parse_started",
        data: JSON.stringify({ message: "Parsing document..." }),
      });

      try {
        const parseProvider = c.get("parseProvider");
        const parsed = await parseProvider.parse({
          filename: entry.filename,
          mimeType: entry.mimeType,
          fileBuffer,
        });
        parseResult = {
          markdown: parsed.markdown,
          pages: parsed.pages,
          ocr_skipped: parsed.ocr_skipped,
          text_map: parsed.text_map ?? [],
          searchable_pdf_base64: parsed.searchable_pdf_base64,
        };
        await stream.writeSSE({
          event: "parse_complete",
          data: JSON.stringify({
            pages: parsed.pages,
            ocr_skipped: parsed.ocr_skipped,
          }),
        });
      } catch (err: unknown) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: err instanceof Error ? err.message : "Parse failed" }),
        });
        return;
      }

      if (!parseResult?.markdown) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: "Parse returned no markdown" }),
        });
        return;
      }

      // Enforce preflight limits
      const preflightErr = await checkPreflightLimits(
        db,
        tenantId,
        parseResult.pages as number | null,
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
        const [found] = await withRLS(db, tenantId, (tx) =>
          tx.select({ id: schema.modelEndpoints.id, model: schema.modelEndpoints.model }).from(schema.modelEndpoints)
            .where(and(eq(schema.modelEndpoints.status, "active"), ...(requestedModel2 ? [eq(schema.modelEndpoints.model, requestedModel2)] : [])))
            .limit(1));
        if (found) ep2 = await resolveExtractEndpoint(db, tenantId, found.id);
      } catch {}
      const extractModel = body.model ?? ep2?.model ?? process.env.KOJI_EXTRACT_MODEL ?? "gpt-4o-mini";
      const extractProvider = createProvider(extractModel, ep2);
      const extractResult = await extractFields(
        parseResult.markdown as string,
        schemaDef,
        extractProvider,
        extractModel,
        (parseResult.text_map as any[]) ?? undefined,
      );

      await stream.writeSSE({
        event: "complete",
        data: JSON.stringify({
          filename: entry.filename,
          pages: parseResult.pages,
          parse_seconds: parseResult.elapsed_seconds,
          ocr_skipped: parseResult.ocr_skipped,
          model: extractResult.model,
          elapsed_ms: extractResult.elapsed_ms,
          extracted: extractResult.extracted,
          confidence: extractResult.confidence,
          confidence_scores: extractResult.confidence_scores,
          provenance: extractResult.provenance,
          markdown: parseResult.markdown,
        }),
      });
    } catch (err: unknown) {
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
  entry: { storageKey: string; filename: string; mimeType: string; schemaId: string },
  fileBuffer: Buffer,
  schemaYaml: string,
  model: string | undefined,
  tenantId: string,
  db: any,
  storage: any,
  fileHash: string,
  cachedParse: Record<string, unknown> | null,
  corpusEntryId: string,
  userId: string,
  schemaRunId?: string,
) {
  let parseResult: Record<string, unknown>;

  if (cachedParse) {
    // Cache hit
    parseResult = cachedParse;
  } else {
    // Cache miss — parse via ParseProvider (gets LiteParse routing, text_map, etc.)
    try {
      const parseProvider = c.get("parseProvider");
      const parsed = await parseProvider.parse({
        filename: entry.filename,
        mimeType: entry.mimeType,
        fileBuffer,
      });
      parseResult = {
        markdown: parsed.markdown,
        pages: parsed.pages,
        ocr_skipped: parsed.ocr_skipped,
        text_map: parsed.text_map ?? [],
        searchable_pdf_base64: parsed.searchable_pdf_base64,
      };
    } catch (err: unknown) {
      return c.json({
        error: "Parse service unreachable",
        detail: err instanceof Error ? err.message : "Connection refused",
      }, 502);
    }

    // Store in cache
    try {
      const cacheKey = `cache/${tenantId}/${fileHash}.json`;
      const cacheData = Buffer.from(JSON.stringify({
        markdown: parseResult.markdown,
        pages: parseResult.pages,
        elapsed_seconds: parseResult.elapsed_seconds,
        ocr_skipped: parseResult.ocr_skipped,
        text_map: parseResult.text_map ?? [],
      }));
      await storage.put(cacheKey, cacheData, { contentType: "application/json" });

      await withRLS(db, tenantId, (tx) =>
        tx.insert(schema.parseCache).values({
          tenantId,
          fileHash,
          storageKey: cacheKey,
          pages: parseResult.pages as number ?? 0,
          ocrSkipped: parseResult.ocr_skipped ? "true" : "false",
          parseDurationMs: parseResult.elapsed_seconds ? Math.round((parseResult.elapsed_seconds as number) * 1000) : null,
        }).onConflictDoNothing()
      );
    } catch (cacheErr) {
      // Cache write failure is non-fatal
      console.warn("[extract/run] Failed to cache parse result:", cacheErr);
    }
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
    const [ep] = await withRLS(db, tenantId, (tx) =>
      tx.select({ id: schema.modelEndpoints.id })
        .from(schema.modelEndpoints)
        .where(
          and(
            eq(schema.modelEndpoints.status, "active"),
            ...(model ? [eq(schema.modelEndpoints.model, model)] : []),
          ),
        )
        .limit(1),
    );
    if (ep) {
      endpointPayload = await resolveExtractEndpoint(db, tenantId, ep.id);
    }
  } catch (err) {
    console.warn("[extract/run] endpoint resolution failed:", err);
  }

  try {
    const extractModel = model ?? endpointPayload?.model ?? process.env.KOJI_EXTRACT_MODEL ?? "gpt-4o-mini";
    const extractProvider = createProvider(extractModel, endpointPayload);
    const extractResult = await extractFields(
      parseResult.markdown as string,
      schemaDef,
      extractProvider,
      extractModel,
      (parseResult.text_map as any[]) ?? undefined,
    ) as unknown as Record<string, unknown>;

    // Persist the run
    const yamlHash = crypto.createHash("sha256").update(schemaYaml).digest("hex");
    try {
      const [run] = await withRLS(db, tenantId, (tx) =>
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
          markdownText: (parseResult.markdown as string) ?? null,
          parseSeconds: parseResult.elapsed_seconds != null ? String(parseResult.elapsed_seconds) : null,
          extractMs: extractResult.elapsed_ms as number ?? null,
          ocrSkipped: parseResult.ocr_skipped ? "true" : "false",
          cached: cachedParse ? "true" : "false",
          triggeredBy: userId,
          schemaRunId: schemaRunId ?? null,
        }).returning({ id: schema.extractionRuns.id })
      );
      return c.json({
        id: run!.id,
        filename: entry.filename,
        pages: parseResult.pages,
        parse_seconds: parseResult.elapsed_seconds,
        ocr_skipped: parseResult.ocr_skipped,
        cached: !!cachedParse,
        model: extractResult.model,
        elapsed_ms: extractResult.elapsed_ms,
        extracted: extractResult.extracted,
        confidence: extractResult.confidence,
        confidence_scores: extractResult.confidence_scores,
        provenance: extractResult.provenance,
        markdown: parseResult.markdown,
      });
    } catch (saveErr) {
      console.warn("[extract/run] Failed to save extraction run:", saveErr);
      // Still return results even if save fails
      return c.json({
        filename: entry.filename,
        pages: parseResult.pages,
        parse_seconds: parseResult.elapsed_seconds,
        ocr_skipped: parseResult.ocr_skipped,
        cached: !!cachedParse,
        model: extractResult.model,
        elapsed_ms: extractResult.elapsed_ms,
        extracted: extractResult.extracted,
        confidence: extractResult.confidence,
        confidence_scores: extractResult.confidence_scores,
        provenance: extractResult.provenance,
        markdown: parseResult.markdown,
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

  const [run] = await withRLS(db, tenantId, (tx) =>
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
    const [run] = await withRLS(db, tenantId, (tx) =>
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
    const [entry] = await withRLS(db, tenantId, (tx) =>
      tx.select({ id: schema.corpusEntries.id, filename: schema.corpusEntries.filename })
        .from(schema.corpusEntries)
        .where(eq(schema.corpusEntries.id, entryId))
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
