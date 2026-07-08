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
import { eq } from "drizzle-orm";
import { schema, withRLS, type Db, type RlsScope } from "@koji/db";
import { runCascade, type CascadeDeps, type DocumentInput } from "./cascade";
import { loadClassifierConfig, type ClassifierConfig } from "./config";
import { Tier, type ClassifyOutcome } from "./types";
import { resolveTenantProvider } from "../extract/resolve-endpoint";
import type { ParseProvider } from "../parse/provider";

/**
 * Resolve a registered classifier's live (released) config by slug, scoped to
 * the caller's tenant + project. Returns null when the slug doesn't resolve to
 * a classifier with a released version — the caller decides how to surface that
 * (the DAG treats it as an `unknown` outcome rather than a hard failure).
 */
export async function resolveClassifierConfig(
  db: Db,
  scope: RlsScope,
  slug: string,
): Promise<ClassifierConfig | null> {
  const [cls] = await withRLS(db, scope, (tx) =>
    tx
      .select({ currentVersionId: schema.classifiers.currentVersionId })
      .from(schema.classifiers)
      .where(eq(schema.classifiers.slug, slug))
      .limit(1),
  );
  if (!cls?.currentVersionId) return null;

  const [ver] = await withRLS(db, scope, (tx) =>
    tx
      .select({ yamlSource: schema.classifierVersions.yamlSource })
      .from(schema.classifierVersions)
      .where(eq(schema.classifierVersions.id, cls.currentVersionId!))
      .limit(1),
  );
  if (!ver?.yamlSource) return null;

  // Compile from the released YAML — the same normalization the standalone
  // classify route applies to an inline config, so results are identical.
  return loadClassifierConfig(ver.yamlSource);
}

/**
 * Classify a document with an already-resolved config, wiring the same deps the
 * standalone /api/classify route uses: a tenant model provider (only when the
 * config's cost ceiling admits the LLM/vision tiers) and page-image rendering
 * via the tenant's parse provider (for the vision tier).
 */
export async function classifyWithConfig(
  db: Db,
  scope: RlsScope,
  input: DocumentInput,
  config: ClassifierConfig,
  parseProvider?: ParseProvider,
): Promise<ClassifyOutcome> {
  let provider;
  if (config.maxTier >= Tier.LLM) {
    try {
      ({ provider } = await resolveTenantProvider(db, scope));
    } catch (err) {
      console.warn(
        "[classify] could not resolve a model provider; LLM/vision tiers unavailable:",
        err instanceof Error ? err.message : err,
      );
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

  return runCascade(input, config, { provider, renderPageImages });
}
