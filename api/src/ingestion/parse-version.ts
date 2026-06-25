/**
 * Version of the parse pipeline's output.
 *
 * Bump this whenever a parse-service change alters the markdown / text_map a
 * given file produces — a new docling backend, an OCR change, a glyph-decode
 * fix, etc. The parse cache is keyed only by (tenant, content-hash), so without
 * a version stamp a parse improvement is silently masked for every
 * already-seen document: the file bytes are unchanged, so the stale cached
 * result keeps coming back.
 *
 * Cached payloads carry `parser_version`; a read whose version != PARSE_VERSION
 * is treated as a miss and re-parsed (overwriting the cache entry). So bumping
 * this invalidates stale entries globally — they re-parse with the current
 * pipeline on next access. There is a one-time re-parse cost per cached
 * document the first time it's touched after a bump; that is the point.
 *
 * History:
 *   1 (implicit / undefined) — original.
 *   2 — glyph-garble pypdfium fallback (oss-221): re-parse Erie/Consolas-class
 *       documents that DoclingParseV2 mangled into /uniXXXX escapes.
 */
export const PARSE_VERSION = 2;

/**
 * Whether a cached parse payload was produced by the current parse pipeline.
 * A payload with a missing or older `parser_version` is stale — the caller
 * should treat it as a cache miss and re-parse.
 */
export function isParseCacheFresh(payload: Record<string, unknown> | null | undefined): boolean {
  return !!payload && payload.parser_version === PARSE_VERSION;
}
