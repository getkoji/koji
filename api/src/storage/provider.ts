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

  /** Fetch the entire object as a Buffer. Simpler than streaming for small-to-medium files. */
  getBuffer(key: string): Promise<{ data: Buffer; contentType: string } | null>;
}
