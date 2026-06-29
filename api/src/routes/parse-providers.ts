import type { Context } from "hono";
import { Hono } from "hono";
import { and, eq, ne, sql } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal } from "../auth/middleware";
import { encrypt, decrypt, keyHint } from "../crypto/envelope";
import { hasParseDriver } from "../parse/drivers";

/**
 * Tenant BYO parse-endpoint management — the API behind the dashboard's
 * Settings → Parse Endpoints surface (PB-9). Structural twin of
 * `model-providers.ts`, but against the simpler single-row `parse_endpoints`
 * table (no credential→model split): one row = one configured parse/OCR
 * vendor + its encrypted key.
 *
 * Credentials are encrypted into `auth_json` via `crypto/envelope` exactly
 * like model endpoints, and decrypted at parse time by
 * `resolveTenantParseProvider`. Koji never stores the plaintext key and never
 * echoes it back.
 *
 * Default model: the tenant's single **active** endpoint is the default heavy
 * parse provider (what `pickActiveParseEndpoint` resolves when a pipeline
 * doesn't pin one). All other endpoints are `disabled` — still configured and
 * still usable as an explicit per-pipeline override (`resolveParseEndpoint`
 * resolves by id without a status filter), just not the auto default.
 */

export const PARSE_PROVIDERS = [
  "mistral-ocr",
  "azure-document-intel",
  "google-docai",
  "textract",
] as const;

export type ParseProviderSlug = (typeof PARSE_PROVIDERS)[number];

/** Sensible default model/processor per provider, applied when the client
 *  doesn't supply one. */
const DEFAULT_MODELS: Record<string, string> = {
  "mistral-ocr": "mistral-ocr-latest",
  "azure-document-intel": "prebuilt-layout",
  "google-docai": "documentai",
  textract: "textract",
};

/**
 * config_json shape (all plaintext, non-secret). Which subset applies depends
 * on the provider — drivers (PB-4..8) read the fields they need.
 */
type ParseConfigJson = {
  /** Mistral / Azure DI endpoint host override. */
  base_url?: string;
  /** Cloud region (Textract, Google Doc AI). */
  region?: string;
  /** Google Document AI project + processor. */
  project_id?: string;
  processor_id?: string;
  /** AWS access key id — an identifier, not a secret (mirrors Bedrock). */
  aws_access_key_id?: string;
};

/**
 * auth_json shape. For every provider the single secret (API key, or the AWS
 * secret access key for Textract) is encrypted into `key_blob`; `key_hint` is
 * the last 4 chars for display. Mirrors the `model_endpoints` single-key shape
 * so `resolveTenantParseProvider` decrypts it the same way.
 */
type ParseAuthJson = {
  key_hint?: string;
  key_blob?: string;
};

export function requireMasterKey(c: Context<Env>): string {
  const key = c.get("masterKey");
  if (!key) {
    throw new Error("KOJI_MASTER_KEY is not set. Cannot encrypt parse provider credentials.");
  }
  return key;
}

export const parseProviders = new Hono<Env>();

/**
 * Validate a create body against the provider's required fields. Returns an
 * error string or null. Exported for unit tests.
 */
export function validateParseCreatePayload(body: {
  provider: string;
  base_url?: string;
  api_key?: string;
  project_id?: string;
  processor_id?: string;
  region?: string;
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
}): string | null {
  const { provider } = body;
  if (!PARSE_PROVIDERS.includes(provider as ParseProviderSlug)) {
    return `provider must be one of: ${PARSE_PROVIDERS.join(", ")}`;
  }
  switch (provider) {
    case "mistral-ocr":
      if (!body.api_key) return "api_key is required for mistral-ocr";
      return null;
    case "azure-document-intel":
      if (!body.base_url)
        return "base_url is required for azure-document-intel (e.g. https://{resource}.cognitiveservices.azure.com)";
      if (!body.api_key) return "api_key is required for azure-document-intel";
      return null;
    case "google-docai":
      if (!body.project_id) return "project_id is required for google-docai";
      if (!body.processor_id) return "processor_id is required for google-docai";
      if (!body.api_key)
        return "api_key is required for google-docai (service-account key or access token)";
      return null;
    case "textract":
      if (!body.region) return "region is required for textract (e.g. us-east-1)";
      if (!body.aws_access_key_id) return "aws_access_key_id is required for textract";
      if (!body.aws_secret_access_key) return "aws_secret_access_key is required for textract";
      return null;
    default:
      return null;
  }
}

/**
 * Build config_json from the body, keeping only fields relevant to the
 * provider. Exported for unit tests.
 */
export function buildParseConfigJson(
  provider: string,
  body: {
    base_url?: string;
    region?: string;
    project_id?: string;
    processor_id?: string;
    aws_access_key_id?: string;
  },
): ParseConfigJson {
  const cfg: ParseConfigJson = {};
  switch (provider) {
    case "mistral-ocr":
      if (body.base_url) cfg.base_url = body.base_url;
      break;
    case "azure-document-intel":
      if (body.base_url) cfg.base_url = body.base_url;
      break;
    case "google-docai":
      if (body.project_id) cfg.project_id = body.project_id;
      if (body.processor_id) cfg.processor_id = body.processor_id;
      cfg.region = body.region || "us";
      break;
    case "textract":
      if (body.region) cfg.region = body.region;
      // The AWS access key id is an identifier, not a secret (same call Bedrock
      // makes) — store it plaintext so the driver can read it via config.
      if (body.aws_access_key_id) cfg.aws_access_key_id = body.aws_access_key_id;
      break;
  }
  return cfg;
}

/**
 * Build auth_json, encrypting the single secret. Returns null when no secret
 * was supplied. Exported for unit tests.
 */
export function buildParseAuthJson(
  provider: string,
  body: { api_key?: string; aws_secret_access_key?: string },
  masterKey: string,
  tenantId: string,
): ParseAuthJson | null {
  // Textract authenticates with the AWS secret access key; every other
  // provider with a single API key. Either way the secret lands in key_blob.
  const secret = provider === "textract" ? body.aws_secret_access_key : body.api_key;
  if (!secret) return null;
  return {
    key_hint: keyHint(secret),
    key_blob: encrypt(secret, masterKey, tenantId),
  };
}

/** Public (non-secret) view of config_json for list/detail responses. */
function publicParseConfig(cfg: ParseConfigJson | null | undefined): {
  baseUrl: string | null;
  region: string | null;
  projectId: string | null;
  processorId: string | null;
  awsAccessKeyId: string | null;
} {
  const c = cfg ?? {};
  return {
    baseUrl: c.base_url ?? null,
    region: c.region ?? null,
    projectId: c.project_id ?? null,
    processorId: c.processor_id ?? null,
    awsAccessKeyId: c.aws_access_key_id ?? null,
  };
}

/**
 * GET /api/parse-providers — list configured parse endpoints. Never returns
 * decrypted credentials.
 */
parseProviders.get("/", requires("endpoint:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.parseEndpoints.id,
        slug: schema.parseEndpoints.slug,
        displayName: schema.parseEndpoints.displayName,
        provider: schema.parseEndpoints.provider,
        model: schema.parseEndpoints.model,
        configJson: schema.parseEndpoints.configJson,
        authJson: schema.parseEndpoints.authJson,
        status: schema.parseEndpoints.status,
        healthState: schema.parseEndpoints.healthState,
        lastHealthCheckAt: schema.parseEndpoints.lastHealthCheckAt,
        createdAt: schema.parseEndpoints.createdAt,
      })
      .from(schema.parseEndpoints)
      .where(sql`${schema.parseEndpoints.deletedAt} IS NULL`)
      .orderBy(schema.parseEndpoints.createdAt),
  );

  const masterKey = c.get("masterKey") as string | null;

  return c.json({
    data: rows.map((r) => {
      const auth = r.authJson as ParseAuthJson | null;
      const pub = publicParseConfig(r.configJson as ParseConfigJson | null);

      // Surface whether the stored key actually decrypts with the current
      // master key — same diagnostic the model catalog shows, so a rotated
      // or corrupt key is caught here instead of at parse time.
      let credentialStatus: "ok" | "invalid" | "none" | "no_master_key" = "none";
      const hasBlob = !!auth?.key_blob;
      if (hasBlob && !masterKey) {
        credentialStatus = "no_master_key";
      } else if (hasBlob && masterKey) {
        try {
          decrypt(auth!.key_blob!, masterKey, tenantId);
          credentialStatus = "ok";
        } catch {
          credentialStatus = "invalid";
        }
      }

      return {
        id: r.id,
        slug: r.slug,
        displayName: r.displayName,
        provider: r.provider,
        model: r.model,
        baseUrl: pub.baseUrl,
        region: pub.region,
        projectId: pub.projectId,
        processorId: pub.processorId,
        awsAccessKeyId: pub.awsAccessKeyId,
        keyHint: auth?.key_hint ?? null,
        hasKey: hasBlob,
        credentialStatus,
        status: r.status,
        isDefault: r.status === "active",
        // Whether a runtime driver is registered for this provider yet. The
        // drivers land in separate PRs (PB-4..8); until then a configured
        // endpoint is dormant — credentials are stored and validated, but the
        // parse path keeps using the system default. The UI surfaces this so
        // users aren't surprised.
        driverAvailable: hasParseDriver(r.provider),
        healthState: r.healthState,
        lastHealthCheckAt: r.lastHealthCheckAt,
        createdAt: r.createdAt,
      };
    }),
  });
});

/**
 * POST /api/parse-providers — create a parse endpoint. Encrypts the secret
 * immediately; never echoes it back. The first endpoint a tenant adds becomes
 * the active default; later ones are added disabled (still pinnable per
 * pipeline) until explicitly set as default.
 */
parseProviders.post("/", requires("endpoint:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const principal = getPrincipal(c);
  const masterKey = requireMasterKey(c);

  const body = await c.req.json<{
    name?: string;
    slug?: string;
    provider?: string;
    model?: string;
    // Non-secret config
    base_url?: string;
    region?: string;
    project_id?: string;
    processor_id?: string;
    aws_access_key_id?: string;
    // Secrets
    api_key?: string;
    aws_secret_access_key?: string;
  }>();

  if (!body.name || !body.provider) {
    return c.json({ error: "name and provider are required" }, 400);
  }

  const validationError = validateParseCreatePayload({
    provider: body.provider,
    base_url: body.base_url,
    api_key: body.api_key,
    project_id: body.project_id,
    processor_id: body.processor_id,
    region: body.region,
    aws_access_key_id: body.aws_access_key_id,
    aws_secret_access_key: body.aws_secret_access_key,
  });
  if (validationError) return c.json({ error: validationError }, 400);

  const slug =
    body.slug?.trim() ||
    body.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  const model = body.model?.trim() || DEFAULT_MODELS[body.provider] || body.provider;
  const configJson = buildParseConfigJson(body.provider, body);
  const authJson = buildParseAuthJson(body.provider, body, masterKey, tenantId);

  // First active endpoint is the default; later ones are added disabled.
  const [activeRow] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ id: schema.parseEndpoints.id })
      .from(schema.parseEndpoints)
      .where(and(eq(schema.parseEndpoints.status, "active"), sql`deleted_at IS NULL`))
      .limit(1),
  );
  const status = activeRow ? "disabled" : "active";

  let rows;
  try {
    rows = await withRLS(db, tenantId, (tx) =>
      tx
        .insert(schema.parseEndpoints)
        .values({
          tenantId,
          slug,
          displayName: body.name!,
          provider: body.provider!,
          model,
          configJson,
          authJson,
          status,
          createdBy: principal.userId,
        })
        .returning({
          id: schema.parseEndpoints.id,
          slug: schema.parseEndpoints.slug,
          displayName: schema.parseEndpoints.displayName,
          provider: schema.parseEndpoints.provider,
          model: schema.parseEndpoints.model,
          status: schema.parseEndpoints.status,
          createdAt: schema.parseEndpoints.createdAt,
        }),
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "insert failed";
    if (/parse_endpoints_tenant_slug_idx|duplicate key/i.test(msg)) {
      return c.json({ error: `A parse endpoint with slug "${slug}" already exists.` }, 409);
    }
    throw err;
  }

  const row = rows[0]!;
  const pub = publicParseConfig(configJson);
  return c.json(
    {
      id: row.id,
      slug: row.slug,
      displayName: row.displayName,
      provider: row.provider,
      model: row.model,
      baseUrl: pub.baseUrl,
      region: pub.region,
      projectId: pub.projectId,
      processorId: pub.processorId,
      awsAccessKeyId: pub.awsAccessKeyId,
      keyHint: authJson?.key_hint ?? null,
      hasKey: !!authJson?.key_blob,
      status: row.status,
      isDefault: row.status === "active",
      driverAvailable: hasParseDriver(row.provider),
      createdAt: row.createdAt,
    },
    201,
  );
});

/**
 * PATCH /api/parse-providers/:id — update display name, model, non-secret
 * config, and/or rotate the secret (re-encrypted when supplied).
 */
parseProviders.patch("/:id", requires("endpoint:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const endpointId = c.req.param("id")!;
  const masterKey = requireMasterKey(c);

  const body = await c.req.json<{
    name?: string;
    model?: string;
    base_url?: string;
    region?: string;
    project_id?: string;
    processor_id?: string;
    aws_access_key_id?: string;
    api_key?: string;
    aws_secret_access_key?: string;
  }>();

  const [existing] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        provider: schema.parseEndpoints.provider,
        configJson: schema.parseEndpoints.configJson,
      })
      .from(schema.parseEndpoints)
      .where(and(eq(schema.parseEndpoints.id, endpointId), sql`deleted_at IS NULL`))
      .limit(1),
  );
  if (!existing) return c.json({ error: "Parse provider not found" }, 404);

  const provider = existing.provider;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name) updates.displayName = body.name;
  if (body.model) updates.model = body.model;

  // Merge config — only touch keys the client sent; empty string clears.
  const cfg: ParseConfigJson = { ...((existing.configJson as ParseConfigJson | null) ?? {}) };
  let cfgTouched = false;
  const mergeField = (key: keyof ParseConfigJson, value: string | undefined) => {
    if (value === undefined) return;
    if (value) cfg[key] = value;
    else delete cfg[key];
    cfgTouched = true;
  };
  mergeField("base_url", body.base_url);
  mergeField("region", body.region);
  mergeField("project_id", body.project_id);
  mergeField("processor_id", body.processor_id);
  mergeField("aws_access_key_id", body.aws_access_key_id);
  if (cfgTouched) updates.configJson = cfg;

  // Re-encrypt the secret if supplied.
  const secret = provider === "textract" ? body.aws_secret_access_key : body.api_key;
  if (secret) {
    updates.authJson = buildParseAuthJson(provider, body, masterKey, tenantId);
  }

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.parseEndpoints)
      .set(updates)
      .where(eq(schema.parseEndpoints.id, endpointId))
      .returning({
        id: schema.parseEndpoints.id,
        slug: schema.parseEndpoints.slug,
        displayName: schema.parseEndpoints.displayName,
        provider: schema.parseEndpoints.provider,
        model: schema.parseEndpoints.model,
        status: schema.parseEndpoints.status,
      }),
  );
  if (rows.length === 0) return c.json({ error: "Parse provider not found" }, 404);
  return c.json(rows[0]);
});

/**
 * POST /api/parse-providers/:id/default — make this endpoint the tenant's
 * active parse default. Exactly one endpoint is active at a time: this one is
 * set active and every other is set disabled, so `pickActiveParseEndpoint`
 * resolves deterministically.
 */
parseProviders.post("/:id/default", requires("endpoint:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const endpointId = c.req.param("id")!;
  const now = new Date();

  const result = await withRLS(db, tenantId, async (tx) => {
    const [target] = await tx
      .select({ id: schema.parseEndpoints.id })
      .from(schema.parseEndpoints)
      .where(and(eq(schema.parseEndpoints.id, endpointId), sql`deleted_at IS NULL`))
      .limit(1);
    if (!target) return null;

    // Demote every other endpoint, then promote this one.
    await tx
      .update(schema.parseEndpoints)
      .set({ status: "disabled", updatedAt: now })
      .where(and(ne(schema.parseEndpoints.id, endpointId), sql`deleted_at IS NULL`));
    await tx
      .update(schema.parseEndpoints)
      .set({ status: "active", updatedAt: now })
      .where(eq(schema.parseEndpoints.id, endpointId));
    return target;
  });

  if (!result) return c.json({ error: "Parse provider not found" }, 404);
  return c.json({ ok: true, id: endpointId, isDefault: true });
});

/**
 * POST /api/parse-providers/:id/test — validate a configured endpoint.
 *
 * Confirms the stored secret decrypts with the current master key, and reports
 * whether a runtime driver exists for the provider. When no driver is
 * registered yet (the current state for every provider — drivers land in
 * PB-4..8), this is a credentials-only check, NOT a vendor round-trip: a
 * green "credentials valid, driver pending" result, never a crash. Once a
 * driver ships it can extend this with a real vendor probe.
 */
parseProviders.post("/:id/test", requires("endpoint:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const endpointId = c.req.param("id")!;
  const masterKey = c.get("masterKey") as string | null;

  const [endpoint] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        provider: schema.parseEndpoints.provider,
        authJson: schema.parseEndpoints.authJson,
      })
      .from(schema.parseEndpoints)
      .where(and(eq(schema.parseEndpoints.id, endpointId), sql`deleted_at IS NULL`))
      .limit(1),
  );
  if (!endpoint) return c.json({ error: "Parse provider not found" }, 404);

  const auth = endpoint.authJson as ParseAuthJson | null;
  if (!auth?.key_blob) {
    return c.json({ error: "No credentials stored for this endpoint." }, 400);
  }
  if (!masterKey) {
    return c.json(
      { error: "KOJI_MASTER_KEY is not set — cannot validate stored credentials." },
      400,
    );
  }

  try {
    decrypt(auth.key_blob, masterKey, tenantId);
  } catch {
    return c.json(
      {
        error:
          "Stored credentials could not be decrypted. The master key may have rotated — rotate the key for this endpoint.",
      },
      400,
    );
  }

  const driverAvailable = hasParseDriver(endpoint.provider);
  return c.json({
    ok: true,
    driverAvailable,
    message: driverAvailable
      ? "Credentials valid. The parse driver is available."
      : `Credentials valid and encrypted. The ${endpoint.provider} parse driver isn't available in this build yet — this endpoint will activate automatically once the driver ships.`,
  });
});

/**
 * DELETE /api/parse-providers/:id — soft-delete an endpoint.
 */
parseProviders.delete("/:id", requires("endpoint:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const endpointId = c.req.param("id")!;

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.parseEndpoints)
      .set({ deletedAt: new Date() })
      .where(and(eq(schema.parseEndpoints.id, endpointId), sql`deleted_at IS NULL`))
      .returning({ id: schema.parseEndpoints.id }),
  );
  if (rows.length === 0) return c.json({ error: "Parse provider not found" }, 404);
  return c.body(null, 204);
});
