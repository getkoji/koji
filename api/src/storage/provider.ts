/**
 * Pluggable storage provider interface.
 *
 * Default: S3-compatible (works with MinIO, AWS S3, Cloudflare R2).
 * All keys are scoped: {type}/{tenantId}/{projectId}/{...}
 */

export interface StorageProvider {
  put(key: string, data: Buffer | ReadableStream, opts?: {
    contentType?: string;
    metadata?: Record<string, string>;
  }): Promise<void>;

  get(key: string): Promise<{
    data: ReadableStream;
    contentType: string;
    size: number;
  } | null>;

  delete(key: string): Promise<void>;

  exists(key: string): Promise<boolean>;

  getSignedUrl(key: string, expiresIn?: number): Promise<string>;

  /** Generate a presigned PUT URL for direct browser-to-S3 uploads. */
  getSignedUploadUrl(key: string, contentType: string, expiresIn?: number): Promise<string>;

  /** Fetch the entire object as a Buffer. Simpler than streaming for small-to-medium files. */
  getBuffer(key: string): Promise<{ data: Buffer; contentType: string } | null>;

  /**
   * Metadata-only lookup. Used by the preview endpoint to answer `HEAD`
   * requests and to fill in `Content-Length` without reading the body —
   * essential for letting pdf.js issue HTTP range requests instead of
   * downloading the full PDF before showing page 1.
   */
  head(key: string): Promise<{ contentType: string; size: number } | null>;

  /**
   * Fetch a byte range from an object. `start` is inclusive, `end` is
   * inclusive (matches HTTP `Range: bytes=start-end` semantics). Returns
   * `null` when the key does not exist; otherwise returns the requested
   * slice plus the object's total size and content type so the caller
   * can build a proper `206 Partial Content` response.
   */
  getRange(
    key: string,
    start: number,
    end: number,
  ): Promise<{
    data: Buffer;
    contentType: string;
    totalSize: number;
  } | null>;
}
