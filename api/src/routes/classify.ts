import { Hono } from "hono";
import type { Env } from "../env";
import { requires, getTenantId, getRlsScope } from "../auth/middleware";
import { mimeTypeFor } from "../ingestion/mime";
import {
  classifyWithConfig,
  loadClassifierConfig,
  resolveClassifierConfig,
  ClassifierConfigError,
  ClassifyProviderError,
  UNKNOWN_LABEL,
} from "../classify";
import type { ClassifyOutcome, ClassifierConfig } from "../classify";
import { resolveParse } from "../ingestion/seam";

/**
 * Document classifier route — POST /api/classify.
 *
 * The standalone primitive over the classify cost-cascade engine (see
 * ../classify). Accepts a document (multipart file or a JSON body pointing at a
 * storage key) and **either** an inline classifier config **or** the slug of a
 * registered classifier, runs the cascade, and returns the label with the tier
 * that produced it. Non-persisting by nature, so this doubles as the test
 * surface. See docs/document-classifier.md (playbook).
 *
 * Referencing by slug (`{ classifier: "<slug>" }`) resolves the classifier's
 * **released** version through the same `resolveClassifierConfig` the ingestion
 * DAG's `classifier:` step uses, so a standalone classify and a pipeline route
 * agree on the document, the config, and the version. Without it every consumer
 * had to `GET /api/classifiers/:slug` for `yamlSource` and post it back — two
 * round trips per document, and a re-tune meant redeploying every caller.
 */

export const classify = new Hono<Env>();

// ── Pure response helpers (unit-tested) ─────────────────────────────────────

/** Where this request's classifier config comes from. */
export type ConfigSource =
  | { kind: "inline"; raw: unknown }
  | { kind: "named"; slug: string; version: string | null }
  | { kind: "none" }
  | { kind: "conflict" };

/**
 * Decide the config source from a request body. Inline config and a slug
 * reference are mutually exclusive: honouring one silently while the caller
 * supplied both would classify against a config they did not intend, so that
 * is a `conflict` the route rejects rather than a precedence rule to remember.
 *
 * `classifier_version` is the canonical field (it matches the DAG step's
 * `classifier_version:`); `version` is accepted as an alias.
 */
export function resolveConfigSource(body: {
  config?: unknown;
  classifier?: unknown;
  classifier_version?: unknown;
  version?: unknown;
}): ConfigSource {
  const hasConfig = body.config != null && body.config !== "";
  const slug = typeof body.classifier === "string" ? body.classifier.trim() : "";
  const hasSlug = slug.length > 0;

  if (hasConfig && hasSlug) return { kind: "conflict" };
  if (hasConfig) return { kind: "inline", raw: body.config };
  if (!hasSlug) return { kind: "none" };

  const rawVersion = body.classifier_version ?? body.version;
  const version = typeof rawVersion === "string" && rawVersion.trim() !== "" ? rawVersion.trim() : null;
  return { kind: "named", slug, version };
}

/** Snake-case wire shape for an outcome. */
export function classifyResponseBody(outcome: ClassifyOutcome) {
  return {
    label: outcome.label,
    confidence: outcome.confidence,
    method: outcome.method,
    tier_used: outcome.tierUsed,
    evidence_page: outcome.evidencePage,
    // Only set on an `unknown` — names the tiers that couldn't run and why, so
    // a caller can tell "looked and couldn't tell" from "never got to look".
    reason: outcome.reason,
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

  // Accept either multipart (file + config/classifier) or a JSON body
  // ({storage_key, config/classifier}).
  let fileBuffer: Buffer;
  let filename: string;
  let mimeType: string;
  let source: ConfigSource;

  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) return c.json({ error: "Missing file" }, 400);
    fileBuffer = Buffer.from(await file.arrayBuffer());
    filename = file.name || "document";
    mimeType = file.type || mimeTypeFor(filename);
    source = resolveConfigSource({
      config: typeof body.config === "string" ? body.config : undefined,
      classifier: body.classifier,
      classifier_version: body.classifier_version,
      version: body.version,
    });
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
    source = resolveConfigSource(json);
  }

  // Resolve the config: inline (parsed here) or by slug (the registered
  // classifier's released version, or an explicit pin).
  let config: ClassifierConfig;
  let usedClassifier: { slug: string; version: string } | null = null;

  if (source.kind === "conflict") {
    return c.json(
      {
        error:
          "Provide either `config` (inline) or `classifier` (a registered slug), not both — they would resolve to different configs.",
      },
      400,
    );
  }
  if (source.kind === "none") {
    return c.json(
      { error: "Missing classifier config — provide `config` (inline) or `classifier` (a registered slug)." },
      400,
    );
  }

  if (source.kind === "named") {
    const resolved = await resolveClassifierConfig(db, getRlsScope(c), source.slug, source.version);
    if ("error" in resolved) {
      // A bad pin must fail loud. Falling back to the live release would run a
      // different classifier than the caller named.
      if (resolved.error === "no_version") {
        return c.json(
          { error: `Classifier '${source.slug}' has no version '${resolved.requested}'.` },
          404,
        );
      }
      return c.json({ error: `Classifier '${source.slug}' not found.` }, 404);
    }
    config = resolved.config;
    usedClassifier = { slug: source.slug, version: resolved.version };
  } else {
    // Parse + validate the inline config (bad config is a 400, not a 500).
    try {
      config = loadClassifierConfig(source.raw);
    } catch (err) {
      if (err instanceof ClassifierConfigError) return c.json({ error: err.message }, 400);
      throw err;
    }
  }

  // Resolve the tenant's parse provider through the same seam the DAG and the
  // pipeline dry-run use, rather than reaching for the global default. All
  // three surfaces now render the vision tier's page images from one resolution
  // path, so a standalone classify and a pipeline route can't disagree about
  // which provider looked at the document (oss-489).
  const { provider: resolvedParseProvider } = await resolveParse(db, getRlsScope(c), {
    parseProviderId: null,
    defaultProvider: parseProvider,
    parseConfig: c.get("parseConfig"),
  });

  // Classify through the shared cascade helper — the exact same path the
  // ingestion DAG's `classifier: <slug>` step uses (oss-410), so a standalone
  // classify and a pipeline route agree on the same document + config.
  let outcome: ClassifyOutcome;
  try {
    outcome = await classifyWithConfig(
      db,
      getRlsScope(c),
      { filename, mimeType, fileBuffer },
      config,
      resolvedParseProvider ?? undefined,
    );
  } catch (err) {
    // The classifier never got to look — report the outage instead of an
    // `unknown` the caller would mistake for a real classification.
    if (err instanceof ClassifyProviderError) return c.json({ error: err.message }, 503);
    throw err;
  }

  const { status, body } = applyOnUnknown(outcome, config.onUnknown);
  // Echo which classifier + version actually ran. The point of running by slug
  // is that a re-tune ships via `koji classify release` with no consumer
  // redeploy — so the consumer needs to be able to see what it got.
  if (usedClassifier) {
    body.classifier = usedClassifier.slug;
    body.classifier_version = usedClassifier.version;
  }
  return c.json(body, status);
});
