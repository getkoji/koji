/**
 * Minimal Google Cloud Storage (GCS) JSON-API client.
 *
 * Used by the Google Document AI **batch** path (`google-docai.ts`): Document
 * AI batch processing reads its input from GCS and writes sharded `Document`
 * JSON back to GCS, so the driver must upload the source, list/download the
 * output shards, and clean up the temporary objects it created.
 *
 * Auth reuses the existing Bearer-token mechanism — every call takes the same
 * OAuth2 access token (`parse_endpoints.api_key`, decrypted at call time by
 * `resolveTenantParseProvider`) that the Document AI calls use. No service
 * account key handling lives here; the caller supplies a ready access token.
 *
 * Only the four operations the batch flow needs are implemented (upload, list,
 * download, delete), each a thin wrapper over the GCS JSON API
 * (https://cloud.google.com/storage/docs/json_api). The client is intentionally
 * provider-agnostic GCS plumbing — no Document AI or domain logic here.
 *
 * IAM: the service account behind the token needs object-level access to the
 * configured bucket — `roles/storage.objectAdmin` (create + read + delete)
 * covers all four operations. A narrower split (objectCreator + objectViewer +
 * a delete grant) also works but objectAdmin is the simplest correct grant.
 */

/** A parsed `gs://bucket/path/to/object` reference. */
export interface GcsUri {
  bucket: string;
  /** Object name / prefix (no leading slash). May be empty for a bucket root. */
  object: string;
}

/**
 * Parse a `gs://bucket/object` URI into its bucket + object parts. Throws on a
 * non-`gs://` URI so misconfiguration surfaces immediately rather than as an
 * opaque 404 later.
 */
export function parseGcsUri(uri: string): GcsUri {
  const m = /^gs:\/\/([^/]+)\/?(.*)$/.exec(uri.trim());
  if (!m) {
    throw new Error(`gcs: not a gs:// URI: "${uri}"`);
  }
  return { bucket: m[1]!, object: m[2] ?? "" };
}

/** Build a `gs://` URI from a bucket + object. */
export function toGcsUri(bucket: string, object: string): string {
  return `gs://${bucket}/${object}`;
}

/** Join URI path-ish segments with single slashes (no leading/trailing slash). */
export function joinGcsPath(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter((p) => p.length > 0)
    .join("/");
}

const STORAGE_HOST = "https://storage.googleapis.com";

/** Metadata for one stored object, as returned by the JSON list API. */
export interface GcsObject {
  name: string;
}

export interface GcsClientOptions {
  /** OAuth2 access token (Bearer). */
  accessToken: string;
  /** Override the storage host (tests / private endpoints). */
  host?: string;
}

/**
 * Thin GCS JSON-API client scoped to the four operations the Document AI batch
 * flow needs. Every method authenticates with the same Bearer access token.
 */
export class GcsClient {
  private readonly token: string;
  private readonly host: string;

  constructor(opts: GcsClientOptions) {
    if (!opts.accessToken) {
      throw new Error("gcs: accessToken is required");
    }
    this.token = opts.accessToken;
    this.host = (opts.host ?? STORAGE_HOST).replace(/\/+$/, "");
  }

  private authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  /**
   * Upload raw bytes to `gs://{bucket}/{object}` via a simple media upload.
   * Overwrites any existing object at that name.
   */
  async upload(
    bucket: string,
    object: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    const url =
      `${this.host}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o` +
      `?uploadType=media&name=${encodeURIComponent(object)}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        ...this.authHeader(),
        "Content-Type": contentType,
      },
      // Buffer is a Uint8Array subclass — an acceptable fetch body.
      body: body as unknown as BodyInit,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `gcs upload ${resp.status} for gs://${bucket}/${object}: ${text.slice(0, 300)}`,
      );
    }
  }

  /**
   * List every object under `prefix` in `bucket`, following pagination. Returns
   * object names in the order GCS reports them (lexicographic).
   */
  async list(bucket: string, prefix: string): Promise<string[]> {
    const names: string[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({ prefix });
      if (pageToken) params.set("pageToken", pageToken);
      const url =
        `${this.host}/storage/v1/b/${encodeURIComponent(bucket)}/o?${params.toString()}`;
      const resp = await fetch(url, { method: "GET", headers: this.authHeader() });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(
          `gcs list ${resp.status} for gs://${bucket}/${prefix}: ${text.slice(0, 300)}`,
        );
      }
      const json = (await resp.json()) as {
        items?: GcsObject[];
        nextPageToken?: string;
      };
      for (const item of json.items ?? []) {
        if (item?.name) names.push(item.name);
      }
      pageToken = json.nextPageToken;
    } while (pageToken);

    return names;
  }

  /** Download an object's raw bytes. */
  async download(bucket: string, object: string): Promise<Buffer> {
    const url =
      `${this.host}/storage/v1/b/${encodeURIComponent(bucket)}/o/` +
      `${encodeURIComponent(object)}?alt=media`;
    const resp = await fetch(url, { method: "GET", headers: this.authHeader() });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `gcs download ${resp.status} for gs://${bucket}/${object}: ${text.slice(0, 300)}`,
      );
    }
    const buf = await resp.arrayBuffer();
    return Buffer.from(buf);
  }

  /** Download + JSON-parse an object. */
  async downloadJson<T>(bucket: string, object: string): Promise<T> {
    const buf = await this.download(bucket, object);
    return JSON.parse(buf.toString("utf8")) as T;
  }

  /**
   * Delete an object. Treats a 404 as success (already gone) so cleanup is
   * idempotent and never fails a parse on a missing temp object.
   */
  async delete(bucket: string, object: string): Promise<void> {
    const url =
      `${this.host}/storage/v1/b/${encodeURIComponent(bucket)}/o/` +
      `${encodeURIComponent(object)}`;
    const resp = await fetch(url, { method: "DELETE", headers: this.authHeader() });
    if (!resp.ok && resp.status !== 404) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `gcs delete ${resp.status} for gs://${bucket}/${object}: ${text.slice(0, 300)}`,
      );
    }
  }
}
