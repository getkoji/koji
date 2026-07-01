import { Hono } from "hono";
import type { Env } from "../env";
import { requires, getTenantId } from "../auth/middleware";
import { mimeTypeFor } from "../ingestion/mime";
import { resolveTenantProvider } from "../extract/resolve-endpoint";
import type { ModelProvider } from "../extract/providers";
import {
  runCascade,
  loadClassifierConfig,
  ClassifierConfigError,
  Tier,
  UNKNOWN_LABEL,
} from "../classify";
import type { CascadeDeps, RenderPageImages, ClassifyOutcome, ClassifierConfig } from "../classify";

/**
 * Document classifier route — POST /api/classify.
 *
 * The standalone primitive over the classify cost-cascade engine (see
 * ../classify). Accepts a document (multipart file or a JSON body pointing at a
 * storage key) plus an inline classifier config, runs the cascade, and returns
 * the label with the tier that produced it. Non-persisting by nature, so this
 * doubles as the test surface. See docs/document-classifier.md (playbook).
 */

export const classify = new Hono<Env>();

// ── Pure response helpers (unit-tested) ─────────────────────────────────────

/** Snake-case wire shape for an outcome. */
export function classifyResponseBody(outcome: ClassifyOutcome) {
  return {
    label: outcome.label,
    confidence: outcome.confidence,
    method: outcome.method,
    tier_used: outcome.tierUsed,
    evidence_page: outcome.evidencePage,
    scores: outcome.scores?.map((s) => ({
      id: s.id,
      score: s.score,
      hits: s.hits,
      total: s.total,
      evidence_page: s.evidencePage,
    })),
  };
}

/**
 * Map an outcome + the config's on_unknown policy to an HTTP status and body.
 * `reject` turns an unmatched document into 422 (the caller wanted a hard fail),
 * `return` surfaces "unknown" with 200 so the caller can branch on it.
 */
export function applyOnUnknown(
  outcome: ClassifyOutcome,
  onUnknown: ClassifierConfig["onUnknown"],
): { status: 200 | 422; body: Record<string, unknown> } {
  const body = classifyResponseBody(outcome);
  if (outcome.label === UNKNOWN_LABEL && onUnknown === "reject") {
    return { status: 422, body: { error: "no class matched", ...body } };
  }
  return { status: 200, body };
}

// ── Route handler ───────────────────────────────────────────────────────────

classify.post("/", requires("job:run"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const storage = c.get("storage");
  const parseProvider = c.get("parseProvider");

  // Accept either multipart (file + config) or a JSON body ({storage_key, config}).
  let fileBuffer: Buffer;
  let filename: string;
  let mimeType: string;
  let rawConfig: unknown;

  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) return c.json({ error: "Missing file" }, 400);
    fileBuffer = Buffer.from(await file.arrayBuffer());
    filename = file.name || "document";
    mimeType = file.type || mimeTypeFor(filename);
    rawConfig = typeof body.config === "string" ? body.config : undefined;
  } else {
    const json = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json || typeof json !== "object") return c.json({ error: "Invalid JSON body" }, 400);
    const storageKey = json.storage_key;
    if (typeof storageKey !== "string") return c.json({ error: "Missing storage_key" }, 400);
    const blob = await storage.getBuffer(storageKey);
    if (!blob) return c.json({ error: "File not found in storage" }, 404);
    fileBuffer = blob.data;
    filename =
      (typeof json.filename === "string" && json.filename) ||
      storageKey.split("/").pop() ||
      "document";
    mimeType = (typeof json.mime_type === "string" && json.mime_type) || mimeTypeFor(filename);
    rawConfig = json.config;
  }

  if (rawConfig == null) return c.json({ error: "Missing classifier config" }, 400);

  // Parse + validate the config (bad config is a 400, not a 500).
  let config: ClassifierConfig;
  try {
    config = loadClassifierConfig(rawConfig);
  } catch (err) {
    if (err instanceof ClassifierConfigError) return c.json({ error: err.message }, 400);
    throw err;
  }

  // Resolve a model provider only when the cost ceiling admits the LLM/vision
  // tiers — the free tiers (0–2) need no provider and no DB round-trip.
  let provider: ModelProvider | undefined;
  if (config.maxTier >= Tier.LLM) {
    try {
      ({ provider } = await resolveTenantProvider(db, tenantId));
    } catch (err) {
      console.warn(
        "[classify] could not resolve a model provider; LLM/vision tiers unavailable:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Vision tier renders pages via the parse provider's page-images endpoint. It
  // returns the first N pages in order; we pick the requested page numbers that
  // fall within that range (capped so a tail page can't render a whole book).
  const renderPageImages: RenderPageImages | undefined = parseProvider?.pageImages
    ? async (buf, pageNumbers) => {
        const maxNeeded = Math.min(Math.max(...pageNumbers, 1), 8);
        const { images } = await parseProvider.pageImages!({
          fileBuffer: buf,
          filename,
          mimeType,
          maxPages: maxNeeded,
        });
        return pageNumbers.filter((n) => n >= 1 && n <= images.length).map((n) => images[n - 1]!);
      }
    : undefined;

  const deps: CascadeDeps = { provider, renderPageImages };
  const outcome = await runCascade({ filename, mimeType, fileBuffer }, config, deps);

  const { status, body } = applyOnUnknown(outcome, config.onUnknown);
  return c.json(body, status);
});
