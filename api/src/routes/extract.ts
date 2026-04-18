import { Hono } from "hono";
import type { Env } from "../index";

/**
 * Extraction routes — proxies to the Python parse + extract services.
 *
 * The API server doesn't do extraction itself. It forwards to:
 *   koji-parse   (port 9410) — document → markdown
 *   koji-extract (port 9420) — markdown + schema → structured data
 *
 * These services run as separate containers in the Docker Compose cluster.
 */

const PARSE_URL = process.env.KOJI_PARSE_URL ?? "http://koji-parse:9410";
const EXTRACT_URL = process.env.KOJI_EXTRACT_URL ?? "http://koji-extract:9420";

export const extract = new Hono<Env>();

// POST /api/parse — forward file to parse service
extract.post("/parse", async (c) => {
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

// POST /api/process — parse + extract in one call
extract.post("/process", async (c) => {
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

  // If no schema, return parse result only
  if (!schema) {
    return c.json(parseResult);
  }

  // Step 2: Extract
  const extractPayload = {
    markdown: parseResult.markdown,
    schema_def: typeof schema === "string" ? JSON.parse(schema) : schema,
  };

  let schemaObj: unknown;
  try {
    schemaObj = typeof schema === "string" ? JSON.parse(schema) : schema;
  } catch {
    // Try YAML parse on the extract service side
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
