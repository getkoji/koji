/**
 * Extract module — in-process TypeScript extraction pipeline.
 *
 * Re-exports the public API so route handlers can import from
 * `../extract` without reaching into individual files.
 */

export { createProvider } from "./providers";
export type { ModelProvider } from "./providers";
export { extractFields } from "./pipeline";
export type { ExtractionResult } from "./pipeline";
export { normalizeExtracted } from "./normalize";
export { validateExtracted } from "./validate";
export { resolveExtractEndpoint } from "./resolve-endpoint";
export type { ExtractEndpointPayload } from "./resolve-endpoint";
export { extractKVPairs, kvPairsSummary } from "./kv-pairs";
export type { KVPair } from "./kv-pairs";
export { resolveProvenance } from "./provenance";
export type { ProvenanceSpan, ProvenanceMap } from "./provenance";
