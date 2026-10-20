/**
 * BYO-parse driver registry.
 *
 * Maps a tenant-configured `parse_endpoints.provider` value to a concrete
 * `ParseProvider` implementation. This is the seam where the vendor drivers
 * plug in:
 *
 *   "mistral-ocr"          → MistralOcrProvider          (near pass-through)
 *   "azure-document-intel" → AzureDocIntelProvider       (markdown via prebuilt-layout)
 *   "textract"             → TextractProvider            (JSON→markdown linearizer)
 *   "google-docai"         → GoogleDocAiProvider         (JSON→markdown linearizer)
 *
 * All four drivers are registered. With no *configured endpoint*, the resolver
 * still returns null and the parse factory falls back to the system default
 * heavy provider, so a deployment that configures nothing behaves exactly as
 * before — the surface is additive, not dormant.
 *
 * Two output classes matter to routing: see {@link parseDriverKind}.
 */

import type { ParseProvider } from "./provider";
import type { ParseEndpointPayload } from "./resolve-tenant-parse";
import { MistralOcrProvider } from "./providers/mistral-ocr";
import { AzureDocIntelProvider } from "./providers/azure-doc-intel";
import { GoogleDocAiProvider } from "./providers/google-docai";
import { TextractProvider } from "./providers/textract";

export type ParseDriverFactory = (payload: ParseEndpointPayload) => ParseProvider;

/**
 * Provider slug → driver factory. Each driver implements the existing
 * `ParseProvider` interface so the consumer (`SmartParseProvider`) needs no
 * changes. Vendor drivers only — the credential-free in-process structured
 * path is not a BYO endpoint and is wired through `ParseConfig.structured`
 * instead (see `parse/factory.ts`).
 */
const PARSE_DRIVERS: Record<string, ParseDriverFactory> = {
  "mistral-ocr": (payload) => new MistralOcrProvider(payload),
  // Azure Document Intelligence — `prebuilt-layout` with markdown output
  // (PB-5). Endpoint host arrives as `base_url`; the subscription key as
  // `api_key` (decrypted by the resolver). Model defaults to prebuilt-layout.
  "azure-document-intel": (payload) =>
    new AzureDocIntelProvider({
      endpoint: payload.base_url ?? "",
      apiKey: payload.api_key ?? "",
      model: payload.model,
      apiVersion: typeof payload.config?.api_version === "string"
        ? payload.config.api_version
        : undefined,
    }),
  "google-docai": (payload) => new GoogleDocAiProvider(payload),
  // PB-8: AWS Textract — JSON `Blocks` graph → chunks-with-bbox.
  textract: (payload) => new TextractProvider(payload),
};

/**
 * Build a `ParseProvider` for a resolved (decrypted) parse endpoint, or
 * return null when no driver is registered for the provider. A null return
 * is the inert path: the factory falls back to the default heavy provider.
 */
export function createParseDriver(payload: ParseEndpointPayload): ParseProvider | null {
  const factory = PARSE_DRIVERS[payload.provider];
  if (!factory) {
    console.warn(
      `[resolve-tenant-parse] no driver registered for parse provider ` +
        `"${payload.provider}" — falling back to the default heavy parse provider.`,
    );
    return null;
  }
  return factory(payload);
}

/** Whether a driver exists for a given provider slug. Exported for tests/UI. */
export function hasParseDriver(provider: string): boolean {
  return provider in PARSE_DRIVERS;
}

/**
 * Output class of a parse provider, used by PB-10 doc-type routing to decide
 * which `SmartParseProvider` slot a tenant's resolved provider fills.
 *
 *  - `markdown`   — emits a markdown view (Mistral OCR, Azure DI, docling).
 *                   Fills the `heavy` slot; serves text-heavy docs.
 *  - `structured` — preserves row/column structure / chunks-with-bbox
 *                   (Google Doc AI, Textract, the digital-positional path).
 *                   Fills the `structured` slot; serves table-heavy docs.
 *
 * This is a property of the *vendor output format*, not of any document
 * domain — it never inspects field names or document categories, so it stays
 * inside the engine-generic rule.
 */
export type ParseDriverKind = "markdown" | "structured";

/**
 * Provider slugs whose drivers produce structured (row/column) output, i.e.
 * whose canonicalizer emits `role: "table_cell"` units carrying
 * `table: { tableId, row, col }` and per-cell geometry.
 *
 * **This set was empty from PB-10 until oss-536** — a staged-rollout placeholder
 * ("empty-but-named, matching the dormant driver registry") that was never
 * filled in once PB-7 (#370, Google Doc AI) and PB-8 (#371, AWS Textract)
 * actually shipped their cell-level canonicalizers. The consequence was not a
 * dormant feature but a silently broken one: `parseDriverKind` returned
 * `markdown` for *every* provider, so a tenant who configured Document AI or
 * Textract had it placed in the `heavy` slot. The heavy slot only ever sees
 * non-digital input (source-type routing sends digital PDFs to pdfjs first), so
 * a digital PDF never reached the vendor, doc-type routing never activated, and
 * the whole table path was dead code. Membership here is now derived from one
 * fact about each driver — does its canonicalizer emit cells? — and must be
 * updated in the same PR as any new structured driver.
 */
const STRUCTURED_PROVIDERS = new Set<string>([
  // Cell-granular canonicalizers: `providers/google-docai.ts#tableCells` and
  // `providers/textract-canonicalizer.ts#tableToCells`.
  "google-docai",
  "textract",
  // Credential-free, in-process cell geometry from pdfjs (see
  // `positional-structured.ts`). Not a vendor endpoint — it fills the
  // structured slot from `ParseConfig.structured`, so it has no slug in
  // `PARSE_DRIVERS` and no `parse_endpoints` row. Listed here so
  // `parseDriverKind("positional")` answers correctly for callers that classify
  // an engine/provider name.
  "positional",
]);

/**
 * Classify a provider slug as markdown- or structured-output. Defaults to
 * `markdown` for anything not explicitly listed as structured — the safe slot,
 * since the markdown/docling path is the existing behaviour.
 */
export function parseDriverKind(provider: string): ParseDriverKind {
  return STRUCTURED_PROVIDERS.has(provider) ? "structured" : "markdown";
}
