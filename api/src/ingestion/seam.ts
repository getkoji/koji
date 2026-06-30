/**
 * The extraction **seam** — the single shared path every surface uses to turn a
 * stored document + a schema into a correct extraction.
 *
 * The extraction *core* (`extractFields` → `intelligentExtract` →
 * validate/normalize/provenance) was already unified. The drift lived in the
 * glue *in front of* the core — the per-entrypoint sequence:
 *
 *   resolve tenant parse provider
 *     → parse (with provider-aware cache)
 *       → convert text_map (flat {x,y,w,h} → nested {bbox})
 *         → extractFields(markdown, schema, …, textMap, chunks)
 *
 * Every surface (single-doc ingestion, build/test `/extract/run`, schema
 * `validate`, pipeline DAG jobs, the test pipeline + child slicing, and
 * form-fingerprint generation) hand-rolled that sequence, and they drifted.
 * Three production bugs in one day (oss-307/308/309) were all the same shape: a
 * non-`run` surface re-implementing this seam slightly differently.
 *
 * This module owns the seam so there is no per-surface glue left to drift:
 *
 *   - {@link resolveParse}   — the one provider resolver (collapses
 *     `resolveBuildParse` / `resolveDagParse` / the inline `process.ts` block).
 *     Its opts object makes the oss-308 "fell back to the global default by
 *     omission" bug structurally impossible — `defaultProvider` and
 *     `parseConfig` are required arguments, not ambient context.
 *   - {@link parseDocument}  — parse that ALWAYS caches (via `getOrParse`) and
 *     ALWAYS shapes the text_map through `toProvenanceTextMap`, so no caller
 *     touches the flat↔nested boundary (the oss-309 footgun) or re-implements a
 *     cache.
 *   - {@link extractDocument} — the full seam: `parseDocument` then
 *     `extractFields`, always forwarding both `textMap` and `chunks` so every
 *     surface produces provenance uniformly.
 *
 * The orchestration *shell* around the seam (sync+SSE vs async queue,
 * persistence target, billing, webhooks, review gate) stays correctly
 * per-surface — collapsing those is explicitly out of scope (see
 * `docs/extraction-seam-unification.md`).
 *
 * Migration is incremental: this module lands first with no call-site changes;
 * `resolveBuildParse` / `resolveDagParse` become thin adapters over
 * {@link resolveParse}, then each surface cuts over one PR at a time.
 */

import type { Db } from "@koji/db";
import type { StorageProvider } from "../storage/provider";
import type { ParseProvider } from "../parse/provider";
import type { ParseConfig } from "../parse/factory";
import type { ParseChunk } from "../parse/chunk";
import {
  resolveTenantParse,
  type ResolvedTenantParse,
} from "../parse/resolve-tenant-parse";
import { parseCacheFingerprint, DEFAULT_PARSE_FINGERPRINT } from "../parse/cache-fingerprint";
import { buildEffectiveParseProvider, getOrParse } from "./process";
import {
  extractFields,
  toProvenanceTextMap,
  type ExtractionResult,
  type ModelProvider,
  type TextMap,
  type FlatTextMapSegment,
} from "../extract";

/**
 * Resolve the parse provider one tenant should use, plus its parse-cache
 * fingerprint. The single replacement for `resolveBuildParse`,
 * `resolveDagParse`, and the inline block in `handleIngestionProcess` — all
 * three were byte-for-byte identical.
 *
 * Dormant-until-configured: when the tenant has no parse endpoint (or no driver
 * is registered, or `parseConfig` is absent), `resolveTenantParse` returns null
 * and `buildEffectiveParseProvider` hands back the exact `defaultProvider`, so
 * behavior is byte-for-byte identical to pre-BYO-parse. Resolution failures
 * never block the run — we log and fall back to `defaultProvider`.
 *
 * Why an opts object instead of positional args: `defaultProvider` and
 * `parseConfig` are REQUIRED. There is no "use the global default" branch to
 * fall into by omission, which is exactly the oss-308 bug (the `validate`
 * surface had skipped resolution and used the ambient `c.get("parseProvider")`).
 */
export async function resolveParse(
  db: Db,
  tenantId: string,
  opts: {
    /** Pinned endpoint id (e.g. a pipeline's `parse_provider_id`), else null. */
    parseProviderId?: string | null;
    /** The system default provider — returned unchanged when nothing resolves. */
    defaultProvider: ParseProvider;
    /** The factory config used to wrap a resolved tenant provider. */
    parseConfig: ParseConfig | null;
  },
): Promise<{ provider: ParseProvider; fingerprint: string }> {
  let resolved: ResolvedTenantParse | null = null;
  if (opts.parseConfig) {
    try {
      resolved = await resolveTenantParse(db, tenantId, {
        parseProviderId: opts.parseProviderId ?? null,
      });
    } catch (err) {
      console.warn(
        "[seam.resolveParse] parse provider resolution failed, using default:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  const provider = await buildEffectiveParseProvider(
    opts.parseConfig,
    opts.defaultProvider,
    resolved,
  );
  return { provider, fingerprint: parseCacheFingerprint(resolved) };
}

/** A stored document, as the seam needs to locate + parse it. */
export interface SeamDocument {
  /** `documents.id` — used for trace/log correlation; not required by the cache. */
  id?: string;
  storageKey: string;
  filename: string;
  /** MIME as stored. Null/blank is fine — the provider layer sniffs it (oss-307). */
  mimeType: string | null;
  /** Content hash — the parse cache key. Without it, every call re-parses. */
  contentHash: string;
}

export interface ParseDocumentResult {
  markdown: string;
  pages: number | null;
  ocr_skipped: boolean;
  engine: string | undefined;
  /** True when the markdown came from the parse cache rather than a live parse. */
  cached: boolean;
  /** Already NESTED (`{bbox}`) via `toProvenanceTextMap` — never the flat shape. */
  textMap: TextMap | undefined;
  chunks: readonly ParseChunk[] | undefined;
}

/**
 * Parse a stored document through the one shared cache (`getOrParse`) and return
 * a result whose `textMap` is ALREADY converted to the nested provenance shape.
 *
 * This is the only place a caller should obtain markdown for extraction. It
 * replaces:
 *   - build's private `cachedParse` lookup + raw `parseProvider.parse` (extract.ts),
 *   - the test pipeline's un-cached, hardcoded-MIME `.parse` calls (pipelines.ts),
 *   - form-fingerprint gen's raw `.parse` (forms.ts).
 *
 * Callers never see the flat `{x,y,w,h}` text_map (the oss-309 crash) — the
 * conversion happens here, once.
 */
export async function parseDocument(args: {
  db: Db;
  storage: StorageProvider;
  tenantId: string;
  document: SeamDocument;
  provider: ParseProvider;
  fingerprint: string;
  /** Force a fresh parse, bypassing + refreshing the cache (rerun --no-cache). */
  skipCache?: boolean;
}): Promise<ParseDocumentResult> {
  const { db, storage, tenantId, document, provider, fingerprint, skipCache } = args;
  const parsed = await getOrParse(
    db,
    storage,
    provider,
    tenantId,
    {
      id: document.id ?? "",
      storageKey: document.storageKey,
      filename: document.filename,
      mimeType: document.mimeType,
      contentHash: document.contentHash,
    },
    fingerprint || DEFAULT_PARSE_FINGERPRINT,
    { skipCache: skipCache ?? false },
  );

  const flat = parsed.textMap as FlatTextMapSegment[] | undefined;
  return {
    markdown: parsed.markdown,
    pages: parsed.pages ?? null,
    ocr_skipped: parsed.ocr_skipped ?? false,
    engine: parsed.engine,
    cached: parsed.cached ?? false,
    textMap: flat && flat.length > 0 ? toProvenanceTextMap(flat) : undefined,
    chunks: parsed.chunks,
  };
}

export type ExtractDocumentResult = ExtractionResult & {
  markdown: string;
  engine: string | undefined;
  cached: boolean;
  pages: number | null;
  ocr_skipped: boolean;
  /** The nested provenance text_map used for extraction, if any. */
  textMap: TextMap | undefined;
};

/**
 * The full seam: resolve-already-done → {@link parseDocument} → `extractFields`,
 * always forwarding BOTH `textMap` and `chunks`. This is what build, validate,
 * pipeline jobs, and the test pipeline should all call so their extraction
 * results carry provenance uniformly.
 *
 * Surfaces that must interleave steps (e.g. SSE streaming separate
 * parse-then-extract progress events) can call {@link parseDocument} +
 * `extractFields` directly — both still go through the shared cache and
 * converter, so they don't reintroduce drift.
 */
export async function extractDocument(args: {
  db: Db;
  storage: StorageProvider;
  tenantId: string;
  document: SeamDocument;
  provider: ParseProvider;
  fingerprint: string;
  skipCache?: boolean;
  schemaDef: Record<string, unknown>;
  modelProvider: ModelProvider;
  model: string;
}): Promise<ExtractDocumentResult> {
  const parsed = await parseDocument(args);
  const result = await extractFields(
    parsed.markdown,
    args.schemaDef,
    args.modelProvider,
    args.model,
    parsed.textMap,
    parsed.chunks,
  );
  return {
    ...result,
    markdown: parsed.markdown,
    engine: parsed.engine,
    cached: parsed.cached,
    pages: parsed.pages,
    ocr_skipped: parsed.ocr_skipped,
    textMap: parsed.textMap,
  };
}
