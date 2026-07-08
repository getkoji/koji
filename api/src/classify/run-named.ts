/**
 * Run a *named* classifier — the single classification path shared by every
 * surface (the standalone POST /api/classify, the ingestion DAG's classify
 * step, and the pipeline test dry-run).
 *
 * Before this, the DAG classify step had its own ad-hoc keyword/LLM logic that
 * diverged from the real classifier engine (`runCascade`): a pipeline could
 * route a document differently than `koji classify run` classified the very
 * same document with the very same config. `resolveClassifierConfig` +
 * `classifyWithConfig` let a DAG step reference a registered classifier by slug
 * (`classifier: <slug>`) and classify through the exact cascade the standalone
 * primitive uses — one implementation, one result.
 */
import { and, eq } from "drizzle-orm";
import { schema, withRLS, type Db, type RlsScope } from "@koji/db";
import { runCascade, type CascadeDeps, type DocumentInput } from "./cascade";
import { loadClassifierConfig, type ClassifierConfig } from "./config";
import { Tier, type ClassifyOutcome } from "./types";
import { formatSemver } from "../schemas/semver";
import { resolveTenantProvider } from "../extract/resolve-endpoint";
import type { ParseProvider } from "../parse/provider";

/**
 * Result of resolving a `classifier: <slug>` (optionally `classifier_version:`)
 * reference. A discriminated union so a caller can tell "no such classifier"
 * apart from "that pinned version doesn't exist" — a bad pin must fail loud,
 * not silently fall back to the live release.
 */
export type ResolvedClassifier =
  | { config: ClassifierConfig; version: string }
  | { error: "no_classifier" }
  | { error: "no_version"; requested: string };

/**
 * Resolve a registered classifier's config by slug, scoped to the caller's
 * tenant + project. With no `version`, resolves the current released version
 * (auto). With a `version` (a semver label like `v0.0.3`, `0.0.3`, or a version
 * id prefix), resolves that exact version and errors if it doesn't match
 * exactly one — a pipeline pinned to a version runs that version or fails,
 * never a surprise different one.
 */
export async function resolveClassifierConfig(
  db: Db,
  scope: RlsScope,
  slug: string,
  version?: string | null,
): Promise<ResolvedClassifier> {
  const [cls] = await withRLS(db, scope, (tx) =>
    tx
      .select({ id: schema.classifiers.id, currentVersionId: schema.classifiers.currentVersionId })
      .from(schema.classifiers)
      .where(eq(schema.classifiers.slug, slug))
      .limit(1),
  );
  if (!cls) return { error: "no_classifier" };

  let versionId: string | null = cls.currentVersionId;
  let versionLabel: string | null = null;

  if (version) {
    const rows = await withRLS(db, scope, (tx) =>
      tx
        .select({
          id: schema.classifierVersions.id,
          major: schema.classifierVersions.major,
          minor: schema.classifierVersions.minor,
          patch: schema.classifierVersions.patch,
          prerelease: schema.classifierVersions.prerelease,
        })
        .from(schema.classifierVersions)
        .where(eq(schema.classifierVersions.classifierId, cls.id)),
    );
    const want = version.startsWith("v") ? version : `v${version}`;
    const matches = rows.filter((r) => formatSemver(r) === want || r.id.startsWith(version));
    if (matches.length !== 1) return { error: "no_version", requested: version };
    versionId = matches[0]!.id;
    versionLabel = formatSemver(matches[0]!);
  }

  if (!versionId) return { error: "no_classifier" };

  const [ver] = await withRLS(db, scope, (tx) =>
    tx
      .select({
        yamlSource: schema.classifierVersions.yamlSource,
        major: schema.classifierVersions.major,
        minor: schema.classifierVersions.minor,
        patch: schema.classifierVersions.patch,
        prerelease: schema.classifierVersions.prerelease,
      })
      .from(schema.classifierVersions)
      .where(and(eq(schema.classifierVersions.id, versionId), eq(schema.classifierVersions.classifierId, cls.id)))
      .limit(1),
  );
  if (!ver?.yamlSource) return version ? { error: "no_version", requested: version } : { error: "no_classifier" };

  // Compile from the resolved YAML — the same normalization the standalone
  // classify route applies to an inline config, so results are identical.
  return { config: loadClassifierConfig(ver.yamlSource), version: versionLabel ?? formatSemver(ver) };
}

/**
 * A classifier whose config admits the LLM tier could not reach a model
 * provider, and the cheaper tiers did not decide the label. Thrown rather than
 * returned as `unknown` because the two are not the same thing: `unknown` means
 * "the classifier looked and could not tell", which routes a DAG down its
 * `default` edge. A provider outage means the classifier never got to look —
 * routing on that is a lie, and it silently extracts the document against the
 * wrong schema. Callers surface this as a failed step, not a default route.
 */
export class ClassifyProviderError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Classifier requires a model provider but none could be resolved: ${detail}`);
    this.name = "ClassifyProviderError";
    this.cause = cause;
  }
}

/**
 * Classify a document with an already-resolved config, wiring the same deps the
 * standalone /api/classify route uses: a tenant model provider (only when the
 * config's cost ceiling admits the LLM/vision tiers) and page-image rendering
 * via the tenant's parse provider (for the vision tier).
 *
 * @throws {ClassifyProviderError} when the provider could not be resolved *and*
 * that is what left the document unclassified. See the class doc.
 */
export async function classifyWithConfig(
  db: Db,
  scope: RlsScope,
  input: DocumentInput,
  config: ClassifierConfig,
  parseProvider?: ParseProvider,
): Promise<ClassifyOutcome> {
  let provider;
  let providerError: unknown;
  if (config.maxTier >= Tier.LLM) {
    try {
      ({ provider } = await resolveTenantProvider(db, scope));
    } catch (err) {
      // Held, not thrown: a keyword hit short-circuits before the LLM tier, so
      // a tenant with no model endpoint still classifies deterministically. We
      // only care that the provider is missing if we fall through to `unknown`.
      providerError = err;
    }
  }

  const renderPageImages: CascadeDeps["renderPageImages"] = parseProvider?.pageImages
    ? async (buf, pageNumbers) => {
        const maxNeeded = Math.min(Math.max(...pageNumbers, 1), 8);
        const { images } = await parseProvider.pageImages!({
          fileBuffer: buf,
          filename: input.filename,
          mimeType: input.mimeType,
          maxPages: maxNeeded,
        });
        return pageNumbers.filter((n) => n >= 1 && n <= images.length).map((n) => images[n - 1]!);
      }
    : undefined;

  const outcome = await runCascade(input, config, { provider, renderPageImages });

  if (providerError && outcome.method === "unknown") {
    // Would a provider have changed the answer? The LLM tier is gated on the
    // document having a text layer (`tierUsed` reaches KEYWORD only when it
    // does); the vision tier is not, but needs rendered page images. If neither
    // tier could have run anyway, the `unknown` is honest — return it.
    const llmTierWasReachable = outcome.tierUsed >= Tier.KEYWORD;
    const visionTierWasReachable = config.maxTier >= Tier.VISION && renderPageImages !== undefined;
    if (llmTierWasReachable || visionTierWasReachable) throw new ClassifyProviderError(providerError);
  }

  return outcome;
}
