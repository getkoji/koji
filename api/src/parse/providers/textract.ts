/**
 * AWS Textract parse provider (PB-8).
 *
 * A BYO-parse driver for customers who already run on AWS (steered to their
 * existing cloud's OCR rather than a net-new vendor — see
 * `docs/byo-parse-providers.md`). Textract is JSON-native: it returns a
 * `Blocks` graph, not markdown, so this provider pairs the AWS client with the
 * pure {@link TextractCanonicalizer} (in `./textract-canonicalizer.ts`) that
 * rebuilds tables from cell (row, col) indices and emits chunks-with-bbox.
 *
 * Two call paths, picked by document size:
 *   - **Sync** (`AnalyzeDocument`, `Bytes`) for single-page documents/images.
 *   - **Async** (`StartDocumentAnalysis` → poll `GetDocumentAnalysis`) for
 *     multi-page PDFs, which Textract only accepts via S3. Requires a
 *     `config.s3_bucket`; the document is uploaded there for the duration of
 *     the job. Async also paginates results via `NextToken`, which we
 *     aggregate before canonicalizing.
 *
 * Credentials come from the resolved (decrypted) parse endpoint, never raw env
 * vars: the AWS secret access key is the encrypted `api_key`; the access key id
 * and region are non-secret `config` fields. When no explicit credentials are
 * present we fall back to the AWS default credential chain (instance role /
 * env), so a deploy running on AWS can use its task role.
 *
 * Live validation against real AWS is pending (needs AWS creds); the
 * canonicalizer — the substantive logic — is unit-tested against a sample
 * `Blocks` fixture.
 */

import {
  TextractClient,
  AnalyzeDocumentCommand,
  StartDocumentAnalysisCommand,
  GetDocumentAnalysisCommand,
} from "@aws-sdk/client-textract";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

import type { ParseProvider, ParseResponse } from "../provider";
import type { ParseEndpointPayload } from "../resolve-tenant-parse";
import {
  TextractCanonicalizer,
  chunksToMarkdown,
  type TextractBlocks,
  type TextractBlock,
} from "./textract-canonicalizer";

/** Poll cadence and ceiling for the async multi-page job. */
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 5 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TextractProvider implements ParseProvider {
  private readonly region: string;
  private readonly accessKeyId?: string;
  private readonly secretAccessKey?: string;
  private readonly sessionToken?: string;
  private readonly s3Bucket?: string;
  private readonly canonicalizer = new TextractCanonicalizer();

  constructor(payload: ParseEndpointPayload) {
    const config = (payload.config ?? {}) as Record<string, unknown>;
    this.region = payload.region ?? str(config.region) ?? "us-east-1";
    // AWS secret access key rides in the encrypted api_key slot; the access
    // key id is a non-secret identifier in config.
    this.secretAccessKey = payload.api_key ?? str(config.secret_access_key);
    this.accessKeyId = str(config.access_key_id);
    this.sessionToken = str(config.session_token);
    this.s3Bucket = str(config.s3_bucket);
  }

  /** Explicit credentials when supplied, else AWS's default chain. */
  private credentials() {
    if (this.accessKeyId && this.secretAccessKey) {
      return {
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
        ...(this.sessionToken ? { sessionToken: this.sessionToken } : {}),
      };
    }
    return undefined;
  }

  private textract(): TextractClient {
    return new TextractClient({ region: this.region, credentials: this.credentials() });
  }

  private s3(): S3Client {
    return new S3Client({ region: this.region, credentials: this.credentials() });
  }

  async parse(input: {
    filename: string;
    mimeType: string;
    fileBuffer: Buffer;
  }): Promise<ParseResponse> {
    const blocks = this.s3Bucket
      ? await this.analyzeAsync(input)
      : await this.analyzeSync(input.fileBuffer);

    const chunks = this.canonicalizer.toChunks(blocks);
    const pages =
      blocks.DocumentMetadata?.Pages ??
      (chunks.length ? Math.max(...chunks.map((c) => c.page)) : null);

    return {
      markdown: chunksToMarkdown(chunks),
      pages,
      ocr_skipped: false,
      // "docling" is the canonical label for the heavy/OCR path in ParseEngine;
      // Textract is a heavy provider in that class.
      engine: "docling",
      chunks,
    };
  }

  /** Single-request synchronous analysis for single-page documents/images. */
  private async analyzeSync(fileBuffer: Buffer): Promise<TextractBlocks> {
    const client = this.textract();
    try {
      const out = await client.send(
        new AnalyzeDocumentCommand({
          Document: { Bytes: Uint8Array.from(fileBuffer) },
          FeatureTypes: ["TABLES"],
        }),
      );
      return {
        Blocks: (out.Blocks ?? []) as TextractBlock[],
        DocumentMetadata: out.DocumentMetadata
          ? { Pages: out.DocumentMetadata.Pages }
          : undefined,
      };
    } finally {
      client.destroy();
    }
  }

  /**
   * Multi-page asynchronous analysis. Uploads the document to the configured
   * S3 bucket, starts the job, polls to completion, and aggregates every
   * `NextToken` page of results. Cleans up the uploaded object afterwards.
   */
  private async analyzeAsync(input: {
    filename: string;
    mimeType: string;
    fileBuffer: Buffer;
  }): Promise<TextractBlocks> {
    if (!this.s3Bucket) {
      throw new Error("Textract async analysis requires config.s3_bucket");
    }
    const bucket = this.s3Bucket;
    const key = `textract-tmp/${Date.now()}-${randomToken()}-${safeName(input.filename)}`;

    const s3 = this.s3();
    const textract = this.textract();
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: Uint8Array.from(input.fileBuffer),
          ContentType: input.mimeType || "application/pdf",
        }),
      );

      const started = await textract.send(
        new StartDocumentAnalysisCommand({
          DocumentLocation: { S3Object: { Bucket: bucket, Name: key } },
          FeatureTypes: ["TABLES"],
        }),
      );
      const jobId = started.JobId;
      if (!jobId) throw new Error("Textract StartDocumentAnalysis returned no JobId");

      const blocks = await this.pollJob(textract, jobId);
      return blocks;
    } finally {
      // Best-effort cleanup of the temp object; don't fail the parse on it.
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch {
        /* ignore cleanup failure */
      }
      s3.destroy();
      textract.destroy();
    }
  }

  /** Poll an async job to completion, aggregating all paginated blocks. */
  private async pollJob(textract: TextractClient, jobId: string): Promise<TextractBlocks> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    // Wait for the job to leave IN_PROGRESS.
    for (;;) {
      const first = await textract.send(new GetDocumentAnalysisCommand({ JobId: jobId }));
      const status = first.JobStatus;
      if (status === "SUCCEEDED") {
        return this.collectPages(textract, jobId, first);
      }
      if (status === "FAILED" || status === "PARTIAL_SUCCESS") {
        throw new Error(
          `Textract job ${jobId} ${status}${first.StatusMessage ? `: ${first.StatusMessage}` : ""}`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(`Textract job ${jobId} timed out after ${POLL_TIMEOUT_MS}ms`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /** Aggregate the first page plus every subsequent `NextToken` page. */
  private async collectPages(
    textract: TextractClient,
    jobId: string,
    first: { Blocks?: unknown[]; NextToken?: string; DocumentMetadata?: { Pages?: number } },
  ): Promise<TextractBlocks> {
    const all: TextractBlock[] = [...((first.Blocks ?? []) as TextractBlock[])];
    let token = first.NextToken;
    while (token) {
      const next = await textract.send(
        new GetDocumentAnalysisCommand({ JobId: jobId, NextToken: token }),
      );
      all.push(...((next.Blocks ?? []) as TextractBlock[]));
      token = next.NextToken;
    }
    return {
      Blocks: all,
      DocumentMetadata: first.DocumentMetadata ? { Pages: first.DocumentMetadata.Pages } : undefined,
    };
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function randomToken(): string {
  return Math.random().toString(36).slice(2, 10);
}

function safeName(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80) || "document";
}
