/**
 * S3-compatible storage provider.
 *
 * Works with MinIO (self-hosted), AWS S3, Cloudflare R2, and any
 * S3-compatible provider. Configuration via env vars.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl as s3GetSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageProvider } from "./provider";

export interface S3StorageConfig {
  endpoint?: string;
  bucket: string;
  accessKey?: string;
  secretKey?: string;
  region?: string;
  forcePathStyle?: boolean;
}

export class S3Storage implements StorageProvider {
  private client: S3Client;
  private bucket: string;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint || undefined,
      credentials: config.accessKey && config.secretKey
        ? { accessKeyId: config.accessKey, secretAccessKey: config.secretKey }
        : undefined,
      region: config.region ?? "us-east-1",
      forcePathStyle: config.forcePathStyle ?? false,
    });
  }

  async put(key: string, data: Buffer | ReadableStream, opts?: {
    contentType?: string;
    metadata?: Record<string, string>;
  }): Promise<void> {
    const body = Buffer.isBuffer(data) ? data : await streamToBuffer(data as ReadableStream);
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: opts?.contentType,
      Metadata: opts?.metadata,
    }));
  }

  async get(key: string): Promise<{
    data: ReadableStream;
    contentType: string;
    size: number;
  } | null> {
    try {
      const resp = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));

      if (!resp.Body) return null;

      return {
        data: resp.Body.transformToWebStream(),
        contentType: resp.ContentType ?? "application/octet-stream",
        size: resp.ContentLength ?? 0,
      };
    } catch (err: unknown) {
      if ((err as { name?: string }).name === "NoSuchKey") return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      return true;
    } catch {
      return false;
    }
  }

  async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    return s3GetSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn },
    );
  }
}

async function streamToBuffer(stream: ReadableStream): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}
