import { Hono, type Context } from "hono";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal, getProjectId, requireProjectId } from "../auth/middleware";
import { loadClassifierConfig, ClassifierConfigError, resolveClassifierConfig } from "../classify";
import type { ClassifierConfig } from "../classify";
import { upsertCorpusDocument } from "../schemas/corpus-pool";
import { validateCorpusLabel } from "../classifiers/corpus-label";
import {
  runClassifyDoc,
  maybeFinalizeClassifierRun,
  type ClassifierRunContext,
  type ClassifierValidateDocJobPayload,
} from "../classifiers/validate-run";
import { mapWithConcurrency } from "../parse/pdf-slice";
import {
  evaluateReleaseGate,
  gateRequested,
  describeBlock,
  type ReleaseGateSpec,
} from "../classifiers/release-gate";
import type { ClassifierValidateResult } from "../classifiers/classify-scoring";
import { resolveMimeType } from "../ingestion/mime";
import { snapshotCandidate, graduateCandidate, releaseDirect } from "../classifiers/versioning";
import { reactivateRefusalBody } from "../schemas/release-policy";
import { parseVersionSelector } from "../schemas/version-selector";
import { parseReleaseInput } from "../schemas/release-input";
import { formatSemver, type Bump } from "../schemas/semver";

/**
 * Classifier config artifact routes — the schema-sibling of ../routes/schemas.ts.
 *
 * A classifier stores YAML defining the document classes the cascade engine can
 * assign (see ../classify). This surface is its CRUD + semver versioning: same
 * released/candidate (`rc.N`) lifecycle as an extraction schema, validated with
 * the engine's own `loadClassifierConfig` so a stored version is always a config
 * the engine can run. Permissions mirror the schema routes exactly.
 */

const DEFAULT_TEMPLATE = `name: my_classifier
description: ""

classes:
  example_class:
    description: "Describe this document class"
    keywords:
      - example
`;

/** Validate YAML with the engine; return the normalized config as parsedJson. */
function compileClassifier(
  yamlSource: string,
): { ok: true; parsed: ClassifierConfig } | { ok: false; error: string } {
  try {
    return { ok: true, parsed: loadClassifierConfig(yamlSource) };
  } catch (err) {
    if (err instanceof ClassifierConfigError) return { ok: false, error: err.message };
    throw err;
  }
}

export const classifiers = new Hono<Env>();

// ── CRUD ──

classifiers.get("/", requires("schema:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({
        id: schema.classifiers.id,
        slug: schema.classifiers.slug,
        displayName: schema.classifiers.displayName,
        description: schema.classifiers.description,
        currentVersionId: schema.classifiers.currentVersionId,
        createdAt: schema.classifiers.createdAt,
      })
      .from(schema.classifiers)
      .where(sql`deleted_at IS NULL`),
  );

  const enriched = [];
  for (const row of rows) {
    let latestVersion: number | null = null;
    let latestVersionLabel: string | null = null;
    const [cv] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
      tx
        .select({
          versionNumber: schema.classifierVersions.versionNumber,
          major: schema.classifierVersions.major,
          minor: schema.classifierVersions.minor,
          patch: schema.classifierVersions.patch,
          prerelease: schema.classifierVersions.prerelease,
        })
        .from(schema.classifierVersions)
        .where(eq(schema.classifierVersions.classifierId, row.id))
        .orderBy(desc(schema.classifierVersions.versionNumber))
        .limit(1),
    );
    if (cv) {
      latestVersion = cv.versionNumber;
      latestVersionLabel = formatSemver(cv);
    }
    enriched.push({ ...row, latestVersion, latestVersionLabel });
  }

  return c.json({ data: enriched });
});

classifiers.get("/:slug", requires("schema:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  const [cls] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select().from(schema.classifiers).where(eq(schema.classifiers.slug, slug)).limit(1),
  );
  if (!cls) return c.json({ error: "Classifier not found" }, 404);

  let latestVersion: {
    versionNumber: number;
    version: string;
    yamlSource: string;
    commitMessage: string | null;
    createdAt: Date;
  } | null = null;
  const [cv] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({
        versionNumber: schema.classifierVersions.versionNumber,
        major: schema.classifierVersions.major,
        minor: schema.classifierVersions.minor,
        patch: schema.classifierVersions.patch,
        prerelease: schema.classifierVersions.prerelease,
        yamlSource: schema.classifierVersions.yamlSource,
        commitMessage: schema.classifierVersions.commitMessage,
        createdAt: schema.classifierVersions.createdAt,
      })
      .from(schema.classifierVersions)
      .where(eq(schema.classifierVersions.classifierId, cls.id))
      .orderBy(desc(schema.classifierVersions.versionNumber))
      .limit(1),
  );
  if (cv) {
    const { major: _ma, minor: _mi, patch: _pa, prerelease: _pr, ...rest } = cv;
    latestVersion = { ...rest, version: formatSemver(cv) };
  }

  // `latestVersion` is the HIGHEST committed version, which is not necessarily
  // what routing runs: a candidate sitting on top of a release would be
  // reported while the release is live. `activeVersion` is the released version
  // `currentVersionId` points at — "what is live" in one call, without a
  // follow-up trip to /versions to find the row flagged `active`.
  let activeVersion: { versionNumber: number; version: string; versionId: string } | null = null;
  const currentVersionId = cls.currentVersionId; // hoisted: narrowing doesn't reach the closure
  if (currentVersionId) {
    const [av] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
      tx
        .select({
          id: schema.classifierVersions.id,
          versionNumber: schema.classifierVersions.versionNumber,
          major: schema.classifierVersions.major,
          minor: schema.classifierVersions.minor,
          patch: schema.classifierVersions.patch,
          prerelease: schema.classifierVersions.prerelease,
        })
        .from(schema.classifierVersions)
        .where(eq(schema.classifierVersions.id, currentVersionId))
        .limit(1),
    );
    if (av) {
      activeVersion = {
        versionId: av.id,
        versionNumber: av.versionNumber,
        version: formatSemver(av),
      };
    }
  }

  return c.json({
    ...cls,
    latestVersion,
    // Mirrors the list endpoint's field so both surfaces agree.
    latestVersionLabel: latestVersion?.version ?? null,
    activeVersion,
    activeVersionLabel: activeVersion?.version ?? null,
  });
});

classifiers.post("/", requires("schema:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const principal = getPrincipal(c);
  const body = await c.req.json<{
    slug: string;
    display_name: string;
    description?: string;
    initial_yaml?: string;
  }>();

  if (!body.slug || !body.display_name) {
    return c.json({ error: "slug and display_name are required" }, 400);
  }

  const yamlSource = body.initial_yaml ?? DEFAULT_TEMPLATE.replace("my_classifier", body.slug);
  const result = compileClassifier(yamlSource);
  if (!result.ok) {
    return c.json({ error: "Invalid initial YAML", details: result.error }, 400);
  }

  const yamlHash = createHash("sha256").update(yamlSource).digest("hex");

  const [newClassifier] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .insert(schema.classifiers)
      .values({
        tenantId,
        projectId: requireProjectId(c),
        slug: body.slug,
        displayName: body.display_name,
        description: body.description ?? null,
        draftYaml: yamlSource,
        createdBy: principal.userId,
      })
      .returning(),
  );

  const [v1] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .insert(schema.classifierVersions)
      .values({
        tenantId,
        classifierId: newClassifier!.id,
        versionNumber: 1,
        // First release is v0.0.1 — same convention as the lifecycle helpers
        // when there is no active release to bump from.
        major: 0,
        minor: 0,
        patch: 1,
        yamlSource,
        yamlHash,
        parsedJson: result.parsed,
        commitMessage: "Initial version",
        committedBy: principal.userId,
      })
      .returning(),
  );

  await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .update(schema.classifiers)
      .set({ currentVersionId: v1!.id })
      .where(eq(schema.classifiers.id, newClassifier!.id)),
  );

  return c.json({ ...newClassifier, latestVersion: 1, latestVersionLabel: formatSemver(v1!) }, 201);
});

classifiers.patch("/:slug", requires("schema:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const body = await c.req.json<{
    display_name?: string;
    description?: string;
    draft_yaml?: string;
  }>();

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.display_name) updates.displayName = body.display_name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.draft_yaml !== undefined) {
    updates.draftYaml = body.draft_yaml;
    updates.draftUpdatedAt = new Date();
  }

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.update(schema.classifiers).set(updates).where(eq(schema.classifiers.slug, slug)).returning(),
  );
  if (rows.length === 0) return c.json({ error: "Classifier not found" }, 404);
  return c.json(rows[0]);
});

classifiers.delete("/:slug", requires("schema:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .update(schema.classifiers)
      .set({ deletedAt: new Date() })
      .where(eq(schema.classifiers.slug, slug)),
  );
  return c.body(null, 204);
});

// ── Versions ──

classifiers.get("/:slug/versions", requires("schema:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  const [cls] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({ id: schema.classifiers.id, currentVersionId: schema.classifiers.currentVersionId })
      .from(schema.classifiers)
      .where(eq(schema.classifiers.slug, slug))
      .limit(1),
  );
  if (!cls) return c.json({ error: "Classifier not found" }, 404);

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({
        id: schema.classifierVersions.id,
        versionNumber: schema.classifierVersions.versionNumber,
        major: schema.classifierVersions.major,
        minor: schema.classifierVersions.minor,
        patch: schema.classifierVersions.patch,
        prerelease: schema.classifierVersions.prerelease,
        commitMessage: schema.classifierVersions.commitMessage,
        committedByName: schema.users.name,
        createdAt: schema.classifierVersions.createdAt,
      })
      .from(schema.classifierVersions)
      .innerJoin(schema.users, eq(schema.users.id, schema.classifierVersions.committedBy))
      .where(eq(schema.classifierVersions.classifierId, cls.id))
      .orderBy(desc(schema.classifierVersions.versionNumber)),
  );

  const data = rows.map((v) => ({
    ...v,
    version: formatSemver(v),
    released: v.prerelease === null,
    active: v.id === cls.currentVersionId,
  }));
  return c.json({ data });
});

classifiers.get("/:slug/versions/:v", requires("schema:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  // Accepts the numeric versionNumber, a semver label (`v0.0.1` / `0.0.1` /
  // `v1.2.0-rc.7`), or a version-id prefix. This used to be parseInt(), so the
  // label the sibling /versions list hands out parsed to NaN and errored.
  const selector = parseVersionSelector(c.req.param("v")!);
  if (!selector) {
    return c.json(
      { error: "Invalid version — use a version number, a semver label (v0.0.1), or a version id." },
      400,
    );
  }

  const [cls] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({ id: schema.classifiers.id })
      .from(schema.classifiers)
      .where(eq(schema.classifiers.slug, slug))
      .limit(1),
  );
  if (!cls) return c.json({ error: "Classifier not found" }, 404);

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select()
      .from(schema.classifierVersions)
      .where(eq(schema.classifierVersions.classifierId, cls.id)),
  );
  const version =
    selector.by === "number"
      ? rows.find((r) => r.versionNumber === selector.versionNumber)
      : selector.by === "semver"
        ? rows.find((r) => formatSemver(r) === selector.label)
        : rows.find((r) => r.id.startsWith(selector.prefix));
  if (!version) return c.json({ error: "Version not found" }, 404);
  return c.json(version);
});

classifiers.post("/:slug/versions", requires("schema:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const principal = getPrincipal(c);
  const body = await c.req.json<{
    yaml_source?: string;
    yaml?: string;
    commit_message?: string;
    candidate?: boolean;
    bump?: Bump;
    allow_reactivate?: boolean;
  }>();

  // Accept `yaml_source` (the artifact-native field name) or `yaml` (schema-route parity).
  const yamlSource = body.yaml_source ?? body.yaml;
  if (!yamlSource) return c.json({ error: "yaml_source is required" }, 400);

  const result = compileClassifier(yamlSource);
  if (!result.ok) {
    return c.json({ error: "Classifier validation failed", details: result.error }, 400);
  }

  const [cls] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({ id: schema.classifiers.id })
      .from(schema.classifiers)
      .where(eq(schema.classifiers.slug, slug))
      .limit(1),
  );
  if (!cls) return c.json({ error: "Classifier not found" }, 404);

  // candidate=true  → snapshot a non-active candidate (Save as candidate)
  // else            → release directly + activate
  if (body.candidate) {
    const snap = await snapshotCandidate(db, tenantId, {
      classifierId: cls.id,
      yaml: yamlSource,
      parsed: result.parsed as unknown as Record<string, unknown>,
      userId: principal.userId,
      bumpOverride: body.bump,
      commitMessage: body.commit_message,
    });
    return c.json(
      { id: snap.id, version: formatSemver(snap), released: false, bump: snap.bump, deduped: snap.deduped },
      201,
    );
  }

  const res = await releaseDirect(db, tenantId, {
    classifierId: cls.id,
    yaml: yamlSource,
    parsed: result.parsed as unknown as Record<string, unknown>,
    userId: principal.userId,
    bumpOverride: body.bump,
    commitMessage: body.commit_message,
    allowReactivate: body.allow_reactivate,
  });
  if ("error" in res) {
    if (res.error === "requires_reactivate") return c.json(reactivateRefusalBody(res), 409);
    return c.json(
      { error: "A release already occupies that version — commit a fresh candidate." },
      409,
    );
  }
  // Match the schema `release` route + the `koji classify release` CLI: 200 with
  // `released` = the version label (not a boolean), plus versionId. `action` and
  // `displaced` tell a no-op apart from a real release or a pointer move.
  return c.json({ released: res.label, versionId: res.id, action: res.action, displaced: res.displaced });
});

/** Latest COMPLETED validate run's scored result for a specific version, or null. */
async function latestCompletedRunResult(
  c: Context<Env>,
  classifierVersionId: string,
): Promise<ClassifierValidateResult | null> {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const [run] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({ resultJson: schema.classifierRuns.resultJson })
      .from(schema.classifierRuns)
      .where(
        and(
          eq(schema.classifierRuns.classifierVersionId, classifierVersionId),
          eq(schema.classifierRuns.status, "completed"),
        ),
      )
      .orderBy(desc(schema.classifierRuns.createdAt))
      .limit(1),
  );
  return (run?.resultJson as ClassifierValidateResult | null) ?? null;
}

/**
 * POST /api/classifiers/:slug/promote — graduate a release candidate to a
 * release and make it live. Defaults to the latest candidate; `versionId`
 * targets a specific one. Gated by schema:deploy.
 *
 * Optionally gated on backtest quality (oss-464): `requireNoRegressions` /
 * `mustNotRegress` / `minRecall` / `minPrecision` refuse the promotion when the
 * candidate's latest backtest shows a named (or any) class regressing vs. the
 * live release, or falling under an absolute floor — so tuning that lifts one
 * class can't quietly cost another. The refusal (409) lists each offending
 * class with its before/after numbers. `koji classify release` is the explicit
 * un-gated bypass (it skips the candidate/backtest loop by design).
 */
classifiers.post("/:slug/promote", requires("schema:deploy"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  type PromoteBody = { versionId?: string } & ReleaseGateSpec;
  const body = await c.req.json<PromoteBody>().catch(() => ({}) as PromoteBody);

  const [cls] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({ id: schema.classifiers.id, currentVersionId: schema.classifiers.currentVersionId })
      .from(schema.classifiers)
      .where(eq(schema.classifiers.slug, slug))
      .limit(1),
  );
  if (!cls) return c.json({ error: "Classifier not found" }, 404);

  let versionId = body.versionId;
  if (!versionId) {
    const [latestRc] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
      tx
        .select({ id: schema.classifierVersions.id })
        .from(schema.classifierVersions)
        .where(
          and(
            eq(schema.classifierVersions.classifierId, cls.id),
            isNotNull(schema.classifierVersions.prerelease),
          ),
        )
        .orderBy(desc(schema.classifierVersions.versionNumber))
        .limit(1),
    );
    if (!latestRc) return c.json({ error: "No release candidate to promote. Commit one first." }, 400);
    versionId = latestRc.id;
  }

  // ── Regression gate (oss-464) ─────────────────────────────────
  const gateSpec: ReleaseGateSpec = {
    requireNoRegressions: body.requireNoRegressions,
    mustNotRegress: body.mustNotRegress,
    minRecall: body.minRecall,
    minPrecision: body.minPrecision,
  };
  if (gateRequested(gateSpec)) {
    const candidateResult = await latestCompletedRunResult(c, versionId);
    if (!candidateResult) {
      // A gate can't be honored without evidence — refuse rather than silently
      // pass a check we couldn't evaluate. (Differs from the schema gate, which
      // pre-dates per-class scoring; here the whole point is the backtest.)
      return c.json(
        {
          error:
            "Refusing to promote: no completed backtest for this candidate to gate on. " +
            "Run `koji classify validate` on it first.",
        },
        409,
      );
    }
    // Baseline = the live release's latest backtest (the "before"). Null when
    // promoting the first-ever release, or when the candidate already IS live —
    // nothing to regress against, so only absolute floors can bite.
    const baselineResult =
      cls.currentVersionId && cls.currentVersionId !== versionId
        ? await latestCompletedRunResult(c, cls.currentVersionId)
        : null;
    const gate = evaluateReleaseGate(candidateResult, baselineResult, gateSpec);
    if (!gate.ok) {
      return c.json(
        {
          error: `Refusing to promote: ${gate.blocks.map(describeBlock).join("; ")}.`,
          blocked: gate.blocks,
        },
        409,
      );
    }
  }

  const res = await graduateCandidate(db, tenantId, cls.id, versionId);
  if ("error" in res) {
    if (res.error === "already_released") {
      return c.json(
        { error: "A release already occupies that version — commit a fresh candidate." },
        409,
      );
    }
    return c.json({ error: "Candidate not found, or it is already a release." }, 404);
  }
  return c.json({ released: res.label });
});

/**
 * POST /api/classifiers/:slug/release — release YAML directly (skip rc) and make
 * it live; defaults to the draft. Gated by schema:deploy.
 */
classifiers.post("/:slug/release", requires("schema:deploy"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const principal = getPrincipal(c);
  // Same rule as the schema route: an uninterpretable body is an error, not a
  // silent fallback to stored draft content the caller never sent.
  const input = parseReleaseInput(await c.req.text());
  if (input.kind === "invalid") return c.json({ error: input.message }, 400);

  const [cls] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({ id: schema.classifiers.id, draftYaml: schema.classifiers.draftYaml })
      .from(schema.classifiers)
      .where(eq(schema.classifiers.slug, slug))
      .limit(1),
  );
  if (!cls) return c.json({ error: "Classifier not found" }, 404);

  const yamlSource = input.kind === "yaml" ? input.yaml : cls.draftYaml;
  if (!yamlSource) {
    return c.json({ error: "No YAML to release — provide yaml_source or save a draft first." }, 400);
  }

  const compiled = compileClassifier(yamlSource);
  if (!compiled.ok) {
    return c.json({ error: "Classifier validation failed", details: compiled.error }, 400);
  }

  const res = await releaseDirect(db, tenantId, {
    classifierId: cls.id,
    yaml: yamlSource,
    parsed: compiled.parsed as unknown as Record<string, unknown>,
    userId: principal.userId,
    allowReactivate: input.allowReactivate,
  });
  if ("error" in res) {
    if (res.error === "requires_reactivate") return c.json(reactivateRefusalBody(res), 409);
    return c.json(
      { error: "A release already occupies that version — commit a fresh candidate." },
      409,
    );
  }
  return c.json({ released: res.label, versionId: res.id, action: res.action, displaced: res.displaced });
});

// ── Classifier corpus (oss-450) ─────────────────────────────────────────────
//
// The schema-sibling of the schema corpus surface (routes/schemas.ts), against
// the shared project document pool (oss-449). A classifier corpus entry is a
// LABEL — `groundTruthJson = { label: "<class id>" }` — owned by the classifier
// (schema_id NULL, classifier_id set). It backs `koji classify validate`
// (oss-453). Ground-truth labels are validated against the classifier's
// released class ids; UNKNOWN_LABEL is legitimate ("should fall through").

/** Resolve the classifier row + its released class ids, or an error response. */
async function loadClassifierForCorpus(c: Context<Env>, slug: string) {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const [cls] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({ id: schema.classifiers.id, projectId: schema.classifiers.projectId })
      .from(schema.classifiers)
      .where(and(eq(schema.classifiers.slug, slug), isNull(schema.classifiers.deletedAt)))
      .limit(1),
  );
  if (!cls) return { error: c.json({ error: "Classifier not found" }, 404) } as const;

  const resolved = await resolveClassifierConfig(db, { tenantId, projectId: cls.projectId }, slug);
  if ("error" in resolved) {
    // No released version → no class vocabulary to validate a label against.
    return {
      error: c.json(
        { error: "Classifier has no released version to validate corpus labels against — release it first." },
        409,
      ),
    } as const;
  }
  const classIds = resolved.config.classes.map((cl) => cl.id);
  return { cls, classIds } as const;
}

/** GET /api/classifiers/:slug/corpus — list the classifier's labelled documents. */
classifiers.get("/:slug/corpus", requires("corpus:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  const [cls] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({ id: schema.classifiers.id })
      .from(schema.classifiers)
      .where(and(eq(schema.classifiers.slug, slug), isNull(schema.classifiers.deletedAt)))
      .limit(1),
  );
  if (!cls) return c.json({ error: "Classifier not found" }, 404);

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({
        id: schema.corpusEntries.id,
        documentId: schema.corpusEntries.documentId,
        filename: schema.corpusEntries.filename,
        fileSize: schema.corpusEntries.fileSize,
        mimeType: schema.corpusEntries.mimeType,
        source: schema.corpusEntries.source,
        groundTruthJson: schema.corpusEntries.groundTruthJson,
        createdAt: schema.corpusEntries.createdAt,
      })
      .from(schema.corpusEntries)
      .where(and(eq(schema.corpusEntries.classifierId, cls.id), isNull(schema.corpusEntries.deletedAt)))
      .orderBy(desc(schema.corpusEntries.createdAt)),
  );

  const data = rows.map((r) => {
    const gt = r.groundTruthJson as { label?: unknown } | null;
    const label = gt && typeof gt.label === "string" ? gt.label : null;
    return {
      id: r.id,
      documentId: r.documentId,
      filename: r.filename,
      fileSize: r.fileSize,
      mimeType: r.mimeType,
      source: r.source,
      label,
      createdAt: r.createdAt,
    };
  });
  return c.json({ data });
});

/**
 * POST /api/classifiers/:slug/corpus — label a document for this classifier.
 *
 * Two input modes:
 *   - multipart `file` (+ `label`): upload a new document, pool it, label it.
 *   - JSON `{ document_id, label }`: attach a document already in the project
 *     pool (uploaded by a schema corpus or another classifier) — no re-upload.
 *
 * `label` must be a released class id or UNKNOWN_LABEL. The entry is owned by
 * the classifier (schema_id NULL). File columns are still copied onto the entry
 * (they stay NOT NULL until oss-476).
 */
classifiers.post("/:slug/corpus", requires("corpus:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const storage = c.get("storage");
  const slug = c.req.param("slug")!;
  const principal = getPrincipal(c);

  const loaded = await loadClassifierForCorpus(c, slug);
  if ("error" in loaded) return loaded.error;
  const { cls, classIds } = loaded;
  const projectId = cls.projectId;

  const contentType = c.req.header("content-type") ?? "";

  // Resolve the (documentId, file fields, label) from whichever input mode.
  let documentId: string;
  let file: { filename: string; storageKey: string; fileSize: number; mimeType: string; contentHash: string };
  let source: string;
  let rawLabel: unknown;

  if (contentType.includes("multipart/form-data")) {
    const body = await c.req.parseBody();
    const upload = body.file;
    if (!(upload instanceof File)) return c.json({ error: "file is required (multipart 'file' field)" }, 400);
    rawLabel = typeof body.label === "string" ? body.label : undefined;

    const check = validateCorpusLabel(rawLabel, classIds);
    if (!check.ok) return c.json({ error: check.message }, 400);

    const fileBuffer = Buffer.from(await upload.arrayBuffer());
    const contentHash = createHash("sha256").update(fileBuffer).digest("hex");
    const mimeType = resolveMimeType(upload.type, upload.name, fileBuffer);
    const storageKey = `corpus/${tenantId}/clf-${cls.id}/${Date.now()}-${upload.name}`;
    await storage.put(storageKey, fileBuffer, { contentType: mimeType });

    documentId = await upsertCorpusDocument(db, { tenantId, projectId }, {
      tenantId,
      projectId,
      filename: upload.name,
      storageKey,
      fileSize: upload.size,
      mimeType,
      contentHash,
      source: "upload",
      addedBy: principal.userId,
    });
    file = { filename: upload.name, storageKey, fileSize: upload.size, mimeType, contentHash };
    source = "upload";
    rawLabel = check.label;
  } else {
    const json = (await c.req.json().catch(() => null)) as { document_id?: unknown; label?: unknown } | null;
    if (!json || typeof json !== "object") return c.json({ error: "Invalid JSON body" }, 400);
    if (typeof json.document_id !== "string") {
      return c.json({ error: "Provide a multipart `file`, or JSON `{ document_id, label }`." }, 400);
    }
    const requestedDocumentId = json.document_id;
    const check = validateCorpusLabel(json.label, classIds);
    if (!check.ok) return c.json({ error: check.message }, 400);

    // The document must already be in THIS project's pool.
    const [doc] = await withRLS(db, { tenantId, projectId }, (tx) =>
      tx
        .select({
          id: schema.corpusDocuments.id,
          filename: schema.corpusDocuments.filename,
          storageKey: schema.corpusDocuments.storageKey,
          fileSize: schema.corpusDocuments.fileSize,
          mimeType: schema.corpusDocuments.mimeType,
          contentHash: schema.corpusDocuments.contentHash,
        })
        .from(schema.corpusDocuments)
        .where(
          and(
            eq(schema.corpusDocuments.id, requestedDocumentId),
            isNull(schema.corpusDocuments.deletedAt),
          ),
        )
        .limit(1),
    );
    if (!doc) return c.json({ error: "Document not found in this project's corpus pool" }, 404);
    documentId = doc.id;
    file = doc;
    source = "pool";
    rawLabel = check.label;
  }

  // One label per (classifier, document): dedup on the owner-scoped partial
  // unique. A re-label of the same document returns the existing entry rather
  // than colliding.
  const [existing] = await withRLS(db, { tenantId, projectId }, (tx) =>
    tx
      .select()
      .from(schema.corpusEntries)
      .where(
        and(
          eq(schema.corpusEntries.classifierId, cls.id),
          eq(schema.corpusEntries.documentId, documentId),
          isNull(schema.corpusEntries.deletedAt),
        ),
      )
      .limit(1),
  );
  if (existing) return c.json(existing, 200);

  const [row] = await withRLS(db, { tenantId, projectId }, (tx) =>
    tx
      .insert(schema.corpusEntries)
      .values({
        tenantId,
        projectId,
        documentId,
        classifierId: cls.id,
        filename: file.filename,
        storageKey: file.storageKey,
        fileSize: file.fileSize,
        mimeType: file.mimeType,
        contentHash: file.contentHash,
        source,
        groundTruthJson: { label: rawLabel },
        addedBy: principal.userId,
      })
      .returning(),
  );
  return c.json(row, 201);
});

/** DELETE /api/classifiers/:slug/corpus/:entryId — soft-delete a label. */
classifiers.delete("/:slug/corpus/:entryId", requires("corpus:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const entryId = c.req.param("entryId")!;

  const [cls] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({ id: schema.classifiers.id })
      .from(schema.classifiers)
      .where(and(eq(schema.classifiers.slug, slug), isNull(schema.classifiers.deletedAt)))
      .limit(1),
  );
  if (!cls) return c.json({ error: "Classifier not found" }, 404);

  const deleted = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .update(schema.corpusEntries)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(schema.corpusEntries.id, entryId),
          eq(schema.corpusEntries.classifierId, cls.id),
          isNull(schema.corpusEntries.deletedAt),
        ),
      )
      .returning({ id: schema.corpusEntries.id }),
  );
  if (deleted.length === 0) return c.json({ error: "Corpus entry not found" }, 404);
  return c.body(null, 204);
});

// ── Validate (backtest) ───────────────────────────────────────────────────
//
// The schema-sibling of the schema validate surface (routes/schemas.ts). A run
// backtests a classifier version against its labelled corpus: classify each
// document through the SAME cascade production uses (`classifyWithConfig`) and
// score predicted vs ground-truth. Both drivers reuse the exact per-document
// units the async queue jobs use (validate-run.ts), so sync and async can never
// drift. No single invocation carries more than one document of classify work
// (the oss-348 lesson) — the sync driver runs them with bounded parallelism,
// the async driver enqueues one `classifier.validate.doc` job each.

/** Bounded parallelism for the sync validate driver. Matches the schema path. */
const CLASSIFIER_VALIDATE_SYNC_CONCURRENCY = 3;

/** The ground-truth label a corpus entry asserts, or null if unlabeled. */
function corpusEntryLabel(groundTruthJson: unknown): string | null {
  const gt = groundTruthJson as { label?: unknown } | null;
  return gt && typeof gt.label === "string" && gt.label.length > 0 ? gt.label : null;
}

/**
 * POST /api/classifiers/:slug/validate — backtest a classifier against its corpus.
 *
 * Runs the RELEASED version by default; `{ version }` pins an explicit one
 * (semver label or version-id prefix), matching classify-run semantics (oss-415)
 * so a backtest and a pipeline route agree on the same config.
 *
 * Two modes, mirroring the schema surface (oss-348):
 *   - default (sync): docs run in-request with bounded parallelism; the full
 *     ClassifierValidateResult is the response.
 *   - `{ async: true }`: one `classifier.validate.doc` job per labelled entry is
 *     enqueued and a 202 `{ runId, ... }` returns immediately. Poll
 *     GET /:slug/validate/runs/:runId for progress + the final result.
 */
classifiers.post("/:slug/validate", requires("job:run"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const principal = getPrincipal(c);

  type ValidateBody = { version?: string; async?: boolean };
  const body = await c.req.json<ValidateBody>().catch((): ValidateBody => ({}));

  const [cls] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({ id: schema.classifiers.id, projectId: schema.classifiers.projectId })
      .from(schema.classifiers)
      .where(and(eq(schema.classifiers.slug, slug), isNull(schema.classifiers.deletedAt)))
      .limit(1),
  );
  if (!cls) return c.json({ error: "Classifier not found" }, 404);
  const projectId = cls.projectId;

  // Resolve the version to backtest: released by default, or the explicit pin.
  // A bad pin fails loud — never a surprise different version.
  const resolved = await resolveClassifierConfig(
    db,
    { tenantId, projectId },
    slug,
    body.version ?? null,
  );
  if ("error" in resolved) {
    if (resolved.error === "no_version") {
      return c.json({ error: `Classifier '${slug}' has no version '${resolved.requested}'.` }, 404);
    }
    return c.json(
      { error: `Classifier '${slug}' has no released version to backtest — release it first.` },
      409,
    );
  }

  // Labelled corpus entries owned by THIS classifier gate the run: an entry with
  // no ground-truth label can't be scored, so it never enters the run.
  const entries = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({
        id: schema.corpusEntries.id,
        groundTruthJson: schema.corpusEntries.groundTruthJson,
      })
      .from(schema.corpusEntries)
      .where(and(eq(schema.corpusEntries.classifierId, cls.id), isNull(schema.corpusEntries.deletedAt))),
  );
  const labelled = entries.filter((e) => corpusEntryLabel(e.groundTruthJson) !== null);
  if (labelled.length === 0) {
    return c.json(
      { error: "No corpus entries have a ground-truth label. Label documents in the Corpus tab first." },
      400,
    );
  }

  const isAsync = body.async === true;

  const [run] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .insert(schema.classifierRuns)
      .values({
        tenantId,
        projectId,
        classifierId: cls.id,
        classifierVersionId: resolved.versionId,
        triggeredBy: principal.userId,
        status: isAsync ? "queued" : "running",
        startedAt: new Date(),
        docsTotal: labelled.length,
      })
      .returning({ id: schema.classifierRuns.id }),
  );
  if (!run) return c.json({ error: "Failed to create classifier run" }, 500);

  // ── Async driver ──────────────────────────────────────────────
  // One job per labelled entry; the last doc to finish finalizes the run
  // (validate-run.ts). The client polls GET /:slug/validate/runs/:runId.
  if (isAsync) {
    const queue = c.get("queue");
    for (const entry of labelled) {
      const payload: ClassifierValidateDocJobPayload = {
        classifierRunId: run.id,
        corpusEntryId: entry.id,
      };
      await queue.enqueue("classifier.validate.doc", payload, { tenantId, maxRetries: 2 });
    }
    return c.json(
      { runId: run.id, status: "queued", docsTotal: labelled.length, version: resolved.version },
      202,
    );
  }

  // ── Sync driver ───────────────────────────────────────────────
  // Same per-doc unit as the async jobs, run in-request with bounded
  // parallelism. The default parse provider drives the vision tier — the exact
  // provider the standalone classify route and the async handler use, so all
  // three surfaces render page images identically.
  const storage = c.get("storage");
  const parseProvider = c.get("parseProvider");
  const ctx: ClassifierRunContext = {
    tenantId,
    projectId,
    classifierRunId: run.id,
    config: resolved.config,
  };

  await mapWithConcurrency(labelled, CLASSIFIER_VALIDATE_SYNC_CONCURRENCY, (entry) =>
    runClassifyDoc(db, storage, parseProvider ?? undefined, ctx, entry.id),
  );

  const outcome = await maybeFinalizeClassifierRun(db, tenantId, run.id);
  if (!outcome.finalized) {
    // Every doc ran in-request, so the finalize claim can only have been lost to
    // a concurrent caller — surface it rather than serving a half-read.
    return c.json({ error: "Validate run was finalized elsewhere" }, 409);
  }
  return c.json({ runId: run.id, version: resolved.version, ...outcome.result });
});

/**
 * GET /api/classifiers/:slug/validate/runs/:runId — poll an async validate run.
 *
 * Cheap DB reads only: run status, per-doc progress (classifier_run_docs vs
 * docs_total), and — once completed — the persisted ClassifierValidateResult.
 */
classifiers.get("/:slug/validate/runs/:runId", requires("job:run"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const runId = c.req.param("runId")!;

  const [cls] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({ id: schema.classifiers.id })
      .from(schema.classifiers)
      .where(and(eq(schema.classifiers.slug, slug), isNull(schema.classifiers.deletedAt)))
      .limit(1),
  );
  if (!cls) return c.json({ error: "Classifier not found" }, 404);

  const [run] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({
        id: schema.classifierRuns.id,
        classifierId: schema.classifierRuns.classifierId,
        status: schema.classifierRuns.status,
        docsTotal: schema.classifierRuns.docsTotal,
        errorMessage: schema.classifierRuns.errorMessage,
        resultJson: schema.classifierRuns.resultJson,
      })
      .from(schema.classifierRuns)
      .where(eq(schema.classifierRuns.id, runId))
      .limit(1),
  );
  if (!run || run.classifierId !== cls.id) return c.json({ error: "Run not found" }, 404);

  const [progress] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.classifierRunDocs)
      .where(eq(schema.classifierRunDocs.classifierRunId, run.id)),
  );

  const failed = run.status === "failed";
  return c.json({
    runId: run.id,
    status: run.status,
    docsTotal: run.docsTotal,
    docsProcessed: progress?.count ?? 0,
    result: run.status === "completed" ? run.resultJson : null,
    error: failed ? (run.errorMessage ?? "Validate run failed") : null,
  });
});

/**
 * GET /api/classifiers/:slug/validate — read the latest backtest result.
 *
 * Returns the most recent COMPLETED run's persisted result (fast — one DB read,
 * no classify). Null when the classifier has never been backtested. This is
 * what the Validate tab loads on open, before any re-run.
 */
classifiers.get("/:slug/validate", requires("job:run"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  const [cls] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({ id: schema.classifiers.id })
      .from(schema.classifiers)
      .where(and(eq(schema.classifiers.slug, slug), isNull(schema.classifiers.deletedAt)))
      .limit(1),
  );
  if (!cls) return c.json({ error: "Classifier not found" }, 404);

  const [latest] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({
        id: schema.classifierRuns.id,
        resultJson: schema.classifierRuns.resultJson,
        classifierVersionId: schema.classifierRuns.classifierVersionId,
        completedAt: schema.classifierRuns.completedAt,
      })
      .from(schema.classifierRuns)
      .where(and(eq(schema.classifierRuns.classifierId, cls.id), eq(schema.classifierRuns.status, "completed")))
      .orderBy(desc(schema.classifierRuns.createdAt))
      .limit(1),
  );
  if (!latest?.resultJson) return c.json(null);

  // Attach the semver label of the version that run scored, for the tab header.
  const [version] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({
        major: schema.classifierVersions.major,
        minor: schema.classifierVersions.minor,
        patch: schema.classifierVersions.patch,
        prerelease: schema.classifierVersions.prerelease,
      })
      .from(schema.classifierVersions)
      .where(eq(schema.classifierVersions.id, latest.classifierVersionId))
      .limit(1),
  );

  return c.json({
    runId: latest.id,
    version: version ? formatSemver(version) : null,
    completedAt: latest.completedAt,
    ...(latest.resultJson as Record<string, unknown>),
  });
});
