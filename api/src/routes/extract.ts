import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eq, and, desc } from "drizzle-orm";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal } from "../auth/middleware";
import { resolveExtractEndpoint } from "../extract/resolve-endpoint";
import { createProvider, extractFields, extractKVPairs, kvPairsSummary } from "../extract";

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

/** Auth headers for Modal proxy-auth endpoints. */
function modalAuthHeaders(url: string): Record<string, string> {
  if (!url.includes("modal.run")) return {};
  return {
    "Modal-Key": process.env.MODAL_PROXY_KEY ?? process.env.MODAL_TOKEN_ID ?? "",
    "Modal-Secret": process.env.MODAL_PROXY_SECRET ?? process.env.MODAL_TOKEN_SECRET ?? "",
  };
}

// Backwards compat alias
function resolveParseUrl(baseUrl: string, path = "/parse"): string {
  return resolveServiceUrl(baseUrl, path);
}


/** POST multipart/form-data via node:http and read the SSE response as an async iterator. */
function postMultipartSSE(
  url: string,
  filename: string,
  mimeType: string,
  fileBuffer: Buffer,
): AsyncIterable<{ event: string; data: string }> {
  const boundary = `----koji${Date.now()}`;
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);

  const parsed = new URL(url);
  const body = Buffer.concat([header, fileBuffer, footer]);

  return {
    [Symbol.asyncIterator]() {
      let resolveNext: ((val: IteratorResult<{ event: string; data: string }>) => void) | null = null;
      const queue: Array<{ event: string; data: string }> = [];
      let done = false;

      const transport = parsed.protocol === "https:" ? https : http;
      const authHeaders: Record<string, string> = {};
      if (process.env.MODAL_TOKEN_ID && parsed.hostname.includes("modal.run")) {
        authHeaders["Modal-Key"] = process.env.MODAL_TOKEN_ID;
        authHeaders["Modal-Secret"] = process.env.MODAL_TOKEN_SECRET ?? "";
      }
      const req = transport.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
          path: parsed.pathname,
          method: "POST",
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": body.length,
            ...authHeaders,
          },
        },
        (res) => {
          let buffer = "";
          let currentEvent = "message";

          res.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            // Parse SSE lines
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (line.startsWith("event: ")) {
                currentEvent = line.slice(7).trim();
              } else if (line.startsWith("data: ")) {
                const data = line.slice(6);
                const item = { event: currentEvent, data };
                if (resolveNext) {
                  resolveNext({ value: item, done: false });
                  resolveNext = null;
                } else {
                  queue.push(item);
                }
                currentEvent = "message";
              }
            }
          });

          res.on("end", () => {
            done = true;
            if (resolveNext) {
              resolveNext({ value: undefined as any, done: true });
              resolveNext = null;
            }
          });
        },
      );

      req.on("error", () => {
        done = true;
        if (resolveNext) {
          resolveNext({ value: undefined as any, done: true });
          resolveNext = null;
        }
      });

      req.end(body);

      return {
        next(): Promise<IteratorResult<{ event: string; data: string }>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined as any, done: true });
          }
          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },
      };
    },
  };
}

/** POST multipart/form-data via node:http, return the full response. */
function postMultipart(
  url: string,
  filename: string,
  mimeType: string,
  fileBuffer: Buffer,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const boundary = `----koji${Date.now()}`;
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, fileBuffer, footer]);

    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;
    const authHeaders: Record<string, string> = {};
    // Modal proxy auth — required for hosted parse endpoints
    if (parsed.hostname.includes("modal.run")) {
      authHeaders["Modal-Key"] = process.env.MODAL_PROXY_KEY ?? process.env.MODAL_TOKEN_ID ?? "";
      authHeaders["Modal-Secret"] = process.env.MODAL_PROXY_SECRET ?? process.env.MODAL_TOKEN_SECRET ?? "";
    }
    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
          ...authHeaders,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 500,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
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
  let ep1 = null;
  try {
    const requestedModel = (schemaDef.model as string) ?? null;
    const [found] = await withRLS(db, tenantId, (tx) =>
      tx.select({ id: schema.modelEndpoints.id, model: schema.modelEndpoints.model }).from(schema.modelEndpoints)
        .where(and(eq(schema.modelEndpoints.status, "active"), ...(requestedModel ? [eq(schema.modelEndpoints.model, requestedModel)] : [])))
        .limit(1));
    if (found) ep1 = await resolveExtractEndpoint(db, tenantId, found.id);
  } catch {}
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
      // Step 1: Parse with streaming progress
      let parseResult: Record<string, unknown> | null = null;

      for await (const event of postMultipartSSE(
        `${resolveParseUrl(c.get("parseUrl"), "/parse/stream")}`,
        entry.filename,
        entry.mimeType,
        fileBuffer,
      )) {
        if (event.event === "started" || event.event === "progress") {
          await stream.writeSSE({
            event: event.event === "started" ? "parse_started" : "parse_progress",
            data: event.data,
          });
        } else if (event.event === "complete") {
          parseResult = JSON.parse(event.data);
          await stream.writeSSE({
            event: "parse_complete",
            data: JSON.stringify({
              pages: parseResult!.pages,
              elapsed_seconds: parseResult!.elapsed_seconds,
              ocr_skipped: parseResult!.ocr_skipped,
            }),
          });
        } else if (event.event === "error") {
          await stream.writeSSE({ event: "error", data: event.data });
          return;
        }
      }

      if (!parseResult?.markdown) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: "Parse returned no markdown" }),
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
    // Cache miss — parse and store
    try {
      const resp = await postMultipart(
        `${resolveParseUrl(c.get("parseUrl"))}`,
        entry.filename,
        entry.mimeType,
        fileBuffer,
      );
      if (resp.status !== 200) {
        let err: unknown = {};
        try { err = JSON.parse(resp.body); } catch {}
        return c.json({ error: "Parse failed", detail: err }, 502);
      }
      parseResult = JSON.parse(resp.body);
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
    ) as Record<string, unknown>;

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
