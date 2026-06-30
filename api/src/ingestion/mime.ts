/**
 * MIME type resolution — a single pure module shared by the ingestion path
 * (where MIME is persisted on a document/corpus row) and the parse path
 * (where a provider hands the MIME to an upstream OCR API).
 *
 * Kept dependency-free (no DB, no storage, no other app modules) so the parse
 * providers can import it without dragging in `ingestion/process.ts` and its
 * heavy transitive graph.
 *
 * Three layers of robustness, cheapest first:
 *   1. Trust a structurally-valid claimed MIME (`type/subtype`).
 *   2. Infer from the filename extension.
 *   3. Sniff the leading magic bytes of the buffer.
 *
 * Why this matters: some clients send `Content-Type: pdf` (the bare
 * extension) on presigned uploads, and Google Doc AI's
 * `rawDocument.mime_type` rejects that with `400 INVALID_ARGUMENT` — which
 * Koji previously wrapped into a generic 502 "Parse service unreachable".
 * Normalizing here means a sloppy stored MIME never hard-fails a parse.
 */

/** Map a filename extension to a canonical MIME type. */
export function mimeTypeFor(filename: string | null): string {
  if (!filename) return "application/octet-stream";
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "tif":
    case "tiff":
      return "image/tiff";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "txt":
      return "text/plain";
    case "html":
    case "htm":
      return "text/html";
    default:
      return "application/octet-stream";
  }
}

/**
 * Sniff a MIME type from the leading magic bytes of a file buffer. Returns
 * null when the signature isn't one we recognize — the caller then keeps
 * whatever it had (filename-derived or octet-stream).
 *
 * Covers the formats document parsers actually receive: PDF, PNG, JPEG,
 * TIFF (both byte orders), GIF, WebP.
 */
export function sniffMimeFromBytes(buffer: Buffer | null | undefined): string | null {
  if (!buffer || buffer.length < 4) return null;

  // PDF: "%PDF" — allow a few leading bytes (BOM / stray whitespace) before it.
  const head = buffer.subarray(0, 8).toString("latin1");
  if (head.includes("%PDF")) return "application/pdf";

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  // TIFF: "II*\0" (little-endian) or "MM\0*" (big-endian)
  if (
    (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
    (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)
  ) {
    return "image/tiff";
  }

  // GIF: "GIF87a" / "GIF89a"
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) {
    return "image/gif";
  }

  // WebP: "RIFF"...."WEBP"
  if (
    buffer.length >= 12 &&
    head.startsWith("RIFF") &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}

/** A claimed value is a structurally-valid MIME if it looks like `type/subtype`. */
function looksLikeMime(value: string): boolean {
  return value.includes("/");
}

/**
 * Result of running a claimed mime type through normalization.
 *
 * `warning` is non-null only when the caller-supplied value was rejected
 * as invalid and replaced with one derived from the filename. Surface it
 * in the API response so the calling client can fix their upload code.
 */
export interface MimeNormalizationResult {
  value: string;
  warning: string | null;
}

/**
 * Normalize a claimed mime type string before we persist it on a
 * document/corpus row, returning both the normalized value and a
 * human-readable warning when a correction was needed.
 *
 * Some API clients send `Content-Type: pdf` (the bare extension) on
 * presigned uploads — R2 stores that verbatim, we read it back via
 * `storage.getBuffer()`, and a wrong value lands in `documents.mimeType`.
 * The dashboard's `pickDocumentRenderer` then can't match it against
 * `"application/pdf"` and falls through to the "Preview not supported"
 * branch.
 *
 * Rule: if the claimed value doesn't look like a real MIME type (must
 * contain a slash, e.g. `type/subtype`), derive one from the filename
 * instead. The MIME spec requires the slash, so this is a conservative
 * validity check that lets through anything genuinely RFC-shaped
 * (including custom vendor types like
 * `application/vnd.openxmlformats-officedocument.wordprocessingml.document`).
 */
export function normalizeMimeTypeWithWarning(
  claimed: string | null | undefined,
  filename: string | null,
): MimeNormalizationResult {
  const trimmed = typeof claimed === "string" ? claimed.trim() : "";
  if (looksLikeMime(trimmed)) return { value: trimmed, warning: null };

  const value = mimeTypeFor(filename);
  const filenameDesc = filename ? `"${filename}"` : "(no filename)";
  const warning = trimmed
    ? `Content-Type "${trimmed}" is not a valid MIME type (must be in the form "type/subtype"). ` +
      `Coerced to "${value}" based on filename ${filenameDesc}. ` +
      `Send an RFC-compliant Content-Type header on upload.`
    : `No Content-Type was provided. Coerced to "${value}" based on filename ${filenameDesc}. ` +
      `Set the Content-Type header on the upload to silence this warning.`;
  return { value, warning };
}

/**
 * Convenience wrapper for callers that just want the normalized value
 * and don't need to surface the warning to the user. Most call sites
 * should prefer {@link normalizeMimeTypeWithWarning} so the warning
 * makes it into the API response.
 */
export function normalizeMimeType(
  claimed: string | null | undefined,
  filename: string | null,
): string {
  return normalizeMimeTypeWithWarning(claimed, filename).value;
}

/**
 * Resolve the MIME type to hand to a parse provider, given everything we
 * know about the document: the claimed/stored MIME, the filename, and the
 * file bytes themselves.
 *
 * This is the buffer-aware counterpart to {@link normalizeMimeType}, used
 * on the parse path where we have the actual bytes and a wrong value
 * hard-fails the upstream OCR API. Resolution order:
 *
 *   1. A structurally-valid, non-generic claimed MIME wins (trust the client).
 *   2. Otherwise infer from the filename extension.
 *   3. Otherwise sniff the magic bytes.
 *   4. Otherwise `application/octet-stream`.
 *
 * `application/octet-stream` is treated as "unknown" rather than a real
 * type, so a generic stored MIME still gets upgraded by filename/bytes.
 */
export function resolveMimeType(
  claimed: string | null | undefined,
  filename: string | null,
  buffer?: Buffer | null,
): string {
  const trimmed = typeof claimed === "string" ? claimed.trim() : "";
  const GENERIC = "application/octet-stream";

  // 1. Trust a real, specific claimed MIME.
  if (looksLikeMime(trimmed) && trimmed !== GENERIC) return trimmed;

  // 2. Filename extension.
  const fromName = mimeTypeFor(filename);
  if (fromName !== GENERIC) return fromName;

  // 3. Magic bytes.
  const sniffed = sniffMimeFromBytes(buffer);
  if (sniffed) return sniffed;

  // 4. Last resort: keep a valid generic claimed value, else octet-stream.
  return looksLikeMime(trimmed) ? trimmed : GENERIC;
}
