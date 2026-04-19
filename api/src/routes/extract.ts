import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId } from "../auth/middleware";

/**
 * Extraction routes — proxies to the Python parse + extract services.
 */

const PARSE_URL = process.env.KOJI_PARSE_URL ?? "http://koji-parse:9410";
const EXTRACT_URL = process.env.KOJI_EXTRACT_URL ?? "http://koji-extract:9420";

export const extract = new Hono<Env>();

extract.post("/parse", requires("job:run"), async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;

  if (!(file instanceof File)) {
    return c.json({ error: "Missing file" }, 400);
  }

  const formData = new FormData();
  formData.append("file", file);

  const resp = await fetch(`${PARSE_URL}/parse`, {
    method: "POST",
    body: formData,
  });

  const result = await resp.json();
  return c.json(result, resp.status as 200);
});

extract.post("/process", requires("job:run"), async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  const schema = body.schema;

  if (!(file instanceof File)) {
    return c.json({ error: "Missing file" }, 400);
  }

  // Step 1: Parse
  const parseForm = new FormData();
  parseForm.append("file", file);

  const parseResp = await fetch(`${PARSE_URL}/parse`, {
    method: "POST",
    body: parseForm,
  });

  if (!parseResp.ok) {
    const err = await parseResp.json().catch(() => ({}));
    return c.json({ error: "Parse failed", detail: err }, 502);
  }

  const parseResult = await parseResp.json() as Record<string, unknown>;

  if (!schema) {
    return c.json(parseResult);
  }

  // Step 2: Extract
  let schemaObj: unknown;
  try {
    schemaObj = typeof schema === "string" ? JSON.parse(schema) : schema;
  } catch {
    schemaObj = schema;
  }

  const extractResp = await fetch(`${EXTRACT_URL}/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      markdown: parseResult.markdown,
      schema_def: schemaObj,
    }),
  });

  if (!extractResp.ok) {
    const err = await extractResp.json().catch(() => ({}));
    return c.json({ error: "Extract failed", detail: err }, 502);
  }

  const extractResult = await extractResp.json() as Record<string, unknown>;

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

/**
 * POST /api/extract/run — Build mode extraction.
 *
 * Takes a corpus entry ID + schema YAML draft. Fetches the document
 * from S3, parses it, extracts with the draft schema, returns results.
 */
extract.post("/extract/run", requires("job:run"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const storage = c.get("storage");

  const body = await c.req.json<{
    corpus_entry_id: string;
    schema_yaml: string;
  }>();

  if (!body.corpus_entry_id || !body.schema_yaml) {
    return c.json({ error: "corpus_entry_id and schema_yaml are required" }, 400);
  }

  // Load corpus entry
  const [entry] = await withRLS(db, tenantId, (tx) =>
    tx.select({
      storageKey: schema.corpusEntries.storageKey,
      filename: schema.corpusEntries.filename,
      mimeType: schema.corpusEntries.mimeType,
    }).from(schema.corpusEntries)
      .where(eq(schema.corpusEntries.id, body.corpus_entry_id))
      .limit(1)
  );

  if (!entry) {
    return c.json({ error: "Corpus entry not found" }, 404);
  }

  // Fetch file from S3
  const fileResult = await storage.get(entry.storageKey);
  if (!fileResult) {
    return c.json({ error: "File not found in storage" }, 404);
  }

  // Convert stream to buffer for the parse service
  const chunks: Uint8Array[] = [];
  const reader = fileResult.data.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const fileBuffer = Buffer.concat(chunks);

  // Step 1: Parse
  const parseBlob = new Blob([fileBuffer], { type: entry.mimeType });
  const parseForm = new FormData();
  parseForm.append("file", parseBlob, entry.filename);

  let parseResult: Record<string, unknown>;
  try {
    const parseResp = await fetch(`${PARSE_URL}/parse`, {
      method: "POST",
      body: parseForm,
    });
    if (!parseResp.ok) {
      const err = await parseResp.json().catch(() => ({}));
      return c.json({ error: "Parse failed", detail: err }, 502);
    }
    parseResult = await parseResp.json() as Record<string, unknown>;
  } catch (err: unknown) {
    return c.json({
      error: "Parse service unreachable",
      detail: err instanceof Error ? err.message : "Connection refused",
    }, 502);
  }

  // Step 2: Extract with draft schema YAML
  try {
    const extractResp = await fetch(`${EXTRACT_URL}/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        markdown: parseResult.markdown,
        schema_def: body.schema_yaml,
      }),
    });

    if (!extractResp.ok) {
      const err = await extractResp.json().catch(() => ({}));
      return c.json({ error: "Extract failed", detail: err }, 502);
    }

    const extractResult = await extractResp.json() as Record<string, unknown>;

    return c.json({
      filename: entry.filename,
      pages: parseResult.pages,
      parse_seconds: parseResult.elapsed_seconds,
      model: extractResult.model,
      elapsed_ms: extractResult.elapsed_ms,
      extracted: extractResult.extracted,
      confidence: extractResult.confidence,
      confidence_scores: extractResult.confidence_scores,
    });
  } catch (err: unknown) {
    return c.json({
      error: "Extract service unreachable",
      detail: err instanceof Error ? err.message : "Connection refused",
    }, 502);
  }
});
