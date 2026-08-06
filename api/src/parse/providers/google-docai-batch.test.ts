/**
 * Google Document AI batch-processing tests (oss-283).
 *
 * Covers the Superkey-blocking path: docs over the synchronous page cap route
 * to async `:batchProcess` (GCS in/out + a long-running operation). The whole
 * REST surface — pdf-lib page counting (real generated PDFs), Document AI
 * process/batchProcess/operation-poll, and the GCS upload/list/download/delete
 * calls — is exercised with a fully mocked `fetch`, so request shapes, size
 * routing, multi-shard merge, and cleanup are verified without a live bucket.
 *
 * Live validation (real GCS bucket + IAM + a real processor) is pending; see
 * the file header in `google-docai.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PDFDocument } from "pdf-lib";

import {
  GoogleDocAiProvider,
  resolveBatchUris,
  mergeShardChunks,
  reportedPageCount,
  reportedPageLimit,
} from "./google-docai";
import type { GoogleDocument } from "./google-docai";
import type { ParseChunk } from "../chunk";
import type { ParseEndpointPayload } from "../resolve-tenant-parse";

/** Build a real PDF buffer with `n` blank pages so pdf-lib can count it. */
async function makePdf(n: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

/** A minimal single-paragraph shard `Document`. */
function paraDoc(text: string, pageNumber: number, shardIndex?: number): GoogleDocument {
  const doc: GoogleDocument = {
    text,
    pages: [
      {
        pageNumber,
        paragraphs: [
          { layout: { textAnchor: { textSegments: [{ startIndex: "0", endIndex: String(text.length) }] } } },
        ],
      },
    ],
  };
  if (shardIndex !== undefined) {
    (doc as GoogleDocument & { shardInfo?: { shardIndex: number } }).shardInfo = { shardIndex };
  }
  return doc;
}

const CONFIG = {
  project_id: "proj",
  processor_id: "proc",
  gcs_bucket: "tenant-bucket",
  // Batch is opt-in now (default is slice+online) — these tests exercise the
  // opt-in batch path, so they enable it explicitly.
  parse_mode: "batch",
  // Make the poll loop instant in tests.
  batch_poll_interval_ms: 0,
};

function payload(overrides: Partial<ParseEndpointPayload> = {}): ParseEndpointPayload {
  return {
    provider: "google-docai",
    api_key: "ya29.token",
    config: CONFIG,
    region: "us",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// URI resolution (pure units). Page counting now lives in `probePdf` — see
// pdf-slice.test.ts; the bare pdf-lib counter it replaced could not tell a
// complete page tree from a partially-traversed one (oss-488).
// ---------------------------------------------------------------------------

describe("resolveBatchUris", () => {
  it("derives input/output prefixes from gcs_bucket", () => {
    expect(resolveBatchUris({ gcsBucket: "b" })).toEqual({
      inputUri: "gs://b/koji-docai/input",
      outputUri: "gs://b/koji-docai/output",
    });
  });

  it("honors explicit gcs_output_uri and derives the bucket from it", () => {
    const { inputUri, outputUri } = resolveBatchUris({ gcsOutputUri: "gs://b/out/here" });
    expect(outputUri).toBe("gs://b/out/here");
    expect(inputUri).toBe("gs://b/koji-docai/input");
  });

  it("throws when no bucket can be determined", () => {
    expect(() => resolveBatchUris({})).toThrow(/requires a GCS bucket/);
  });
});

describe("mergeShardChunks", () => {
  it("rebases each shard's pages onto a running global offset", () => {
    const a: ParseChunk[] = [
      { id: "a-u0", text: "A", page: 1 },
      { id: "a-u1", text: "B", page: 2 },
    ];
    const b: ParseChunk[] = [
      { id: "b-u0", text: "C", page: 1 }, // per-shard numbering restarts at 1
      { id: "b-u1", text: "D", page: 2 },
    ];
    const merged = mergeShardChunks([
      { chunks: a, pageCount: 2, basePage: 1 },
      { chunks: b, pageCount: 2, basePage: 1 },
    ]);
    expect(merged.map((c) => [c.text, c.page])).toEqual([
      ["A", 1],
      ["B", 2],
      ["C", 3],
      ["D", 4],
    ]);
  });

  it("is correct when shards carry global page numbers too", () => {
    const b: ParseChunk[] = [{ id: "b-u0", text: "C", page: 31 }];
    const merged = mergeShardChunks([
      { chunks: [{ id: "a-u0", text: "A", page: 1 }], pageCount: 30, basePage: 1 },
      { chunks: b, pageCount: 1, basePage: 31 },
    ]);
    expect(merged.map((c) => c.page)).toEqual([1, 31]);
  });
});

// ---------------------------------------------------------------------------
// Size routing through parse().
// ---------------------------------------------------------------------------

describe("GoogleDocAiProvider.parse — size routing (batch opted in)", () => {
  function onlineFetch(): void {
    fetchMock.mockResolvedValue(
      jsonResponse({ document: { text: "hi", pages: [{ pageNumber: 1 }] } }),
    );
  }

  it("keeps a doc within one slice (<=15pg) on a single online :process, no batch", async () => {
    onlineFetch();
    const provider = new GoogleDocAiProvider(payload());
    await provider.parse({ filename: "a.pdf", mimeType: "application/pdf", fileBuffer: await makePdf(10) });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain(":process");
    expect(url).not.toContain(":batchProcess");
    expect(JSON.parse(init.body as string).imagelessMode).toBeUndefined();
  });

  it("routes a doc larger than the slice size to batch (not online) when opted in", async () => {
    installBatchRouter([paraDoc("Alpha", 1, 0)]);
    const provider = new GoogleDocAiProvider(payload());
    // 20pg > the 15pg slice size → batch, because parse_mode="batch" is set.
    await provider.parse({ filename: "a.pdf", mimeType: "application/pdf", fileBuffer: await makePdf(20) });

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes(":batchProcess"))).toBe(true);
    expect(urls.some((u) => u.includes(":process"))).toBe(false);
  });

  it("falls back to a single online :process when the page count is unknown (non-PDF)", async () => {
    onlineFetch();
    const provider = new GoogleDocAiProvider(payload());
    await provider.parse({ filename: "a.png", mimeType: "image/png", fileBuffer: Buffer.from("PNGDATA") });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toContain(":process");
  });

  it("routes a >30pg doc to batch (:batchProcess), never online", async () => {
    installBatchRouter([paraDoc("Alpha", 1, 0)]);
    const provider = new GoogleDocAiProvider(payload());
    await provider.parse({ filename: "big.pdf", mimeType: "application/pdf", fileBuffer: await makePdf(40) });

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes(":batchProcess"))).toBe(true);
    expect(urls.some((u) => u.includes(":process"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Full batch flow.
// ---------------------------------------------------------------------------

const OP_NAME = "projects/proj/locations/us/operations/op-12345";

/**
 * Install a fetch mock that emulates the whole batch surface: GCS upload,
 * `:batchProcess`, one "running" operation poll then "done", a GCS list of the
 * provided shards, shard downloads, and deletes. Records the calls for asserts.
 */
function installBatchRouter(shards: GoogleDocument[], opts: { failOp?: boolean } = {}): {
  deletes: string[];
} {
  const deletes: string[] = [];
  // Stable object names for the shards under the output prefix.
  const shardNames = shards.map((_, i) => `koji-docai/output/RUN/0/doc-${i}.json`);
  let polled = 0;

  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";

    if (method === "DELETE") {
      deletes.push(u);
      return new Response(null, { status: 204 });
    }
    if (u.includes("/upload/storage/v1/")) {
      return jsonResponse({});
    }
    if (u.includes(":batchProcess")) {
      return jsonResponse({ name: OP_NAME });
    }
    if (u.includes("/operations/")) {
      polled += 1;
      if (opts.failOp) {
        return jsonResponse({ name: OP_NAME, done: true, error: { code: 3, message: "boom" } });
      }
      // First poll still running, second poll done — exercises the loop.
      if (polled < 2) return jsonResponse({ name: OP_NAME, done: false });
      return jsonResponse({ name: OP_NAME, done: true, metadata: { state: "SUCCEEDED" } });
    }
    if (u.includes("alt=media")) {
      const idx = shardNames.findIndex((n) => u.includes(encodeURIComponent(n)));
      return jsonResponse(shards[idx]!);
    }
    // GCS list (object endpoint with a query string).
    if (u.includes("/o?")) {
      return jsonResponse({ items: shardNames.map((name) => ({ name })) });
    }
    throw new Error(`unexpected fetch in test: ${method} ${u}`);
  });

  return { deletes };
}

describe("GoogleDocAiProvider.parse — full batch flow", () => {
  it("uploads, dispatches, polls, downloads shards, merges, and cleans up", async () => {
    const { deletes } = installBatchRouter([
      paraDoc("Page one body", 1, 0),
      paraDoc("Page two body", 1, 1), // per-shard local page numbering
    ]);

    const provider = new GoogleDocAiProvider(payload());
    const result = await provider.parse({
      filename: "policy.pdf",
      mimeType: "application/pdf",
      fileBuffer: await makePdf(60),
    });

    expect(result.engine).toBe("google-docai");
    // Two shards, one page each → two pages total, globally numbered 1 and 2.
    expect(result.pages).toBe(2);
    expect(result.chunks?.map((c) => [c.text, c.page])).toEqual([
      ["Page one body", 1],
      ["Page two body", 2],
    ]);
    expect(result.markdown).toBe("Page one body\n\nPage two body");

    // Verify the call sequence hit batch, not online.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/upload/storage/v1/"))).toBe(true);
    expect(urls.some((u) => u.includes(":batchProcess"))).toBe(true);
    expect(urls.filter((u) => u.includes("/operations/")).length).toBeGreaterThanOrEqual(2);

    // Cleanup deleted the temp input and the two output shards.
    expect(deletes.length).toBeGreaterThanOrEqual(3);
    expect(deletes.some((d) => d.includes("koji-docai%2Finput"))).toBe(true);
    expect(deletes.some((d) => d.includes("doc-0.json"))).toBe(true);
  });

  it("sends a batchProcess body with the GCS input doc and output prefix", async () => {
    installBatchRouter([paraDoc("x", 1, 0)]);
    const provider = new GoogleDocAiProvider(payload());
    await provider.parse({ filename: "p.pdf", mimeType: "application/pdf", fileBuffer: await makePdf(40) });

    const batchCall = fetchMock.mock.calls.find((c) => String(c[0]).includes(":batchProcess"))!;
    const body = JSON.parse(batchCall[1]!.body as string);
    expect(body.inputDocuments.gcsDocuments.documents[0].gcsUri).toMatch(
      /^gs:\/\/tenant-bucket\/koji-docai\/input\/.+\/p\.pdf$/,
    );
    expect(body.inputDocuments.gcsDocuments.documents[0].mimeType).toBe("application/pdf");
    expect(body.documentOutputConfig.gcsOutputConfig.gcsUri).toMatch(
      /^gs:\/\/tenant-bucket\/koji-docai\/output\/.+\/$/,
    );
  });

  it("throws (and still cleans up) when the operation fails", async () => {
    const { deletes } = installBatchRouter([paraDoc("x", 1, 0)], { failOp: true });
    const provider = new GoogleDocAiProvider(payload());
    await expect(
      provider.parse({ filename: "p.pdf", mimeType: "application/pdf", fileBuffer: await makePdf(40) }),
    ).rejects.toThrow(/batch operation failed: boom/);
    // Cleanup ran in the finally block even on failure (input delete at least).
    expect(deletes.length).toBeGreaterThanOrEqual(1);
  });

  it("throws when batch is opted in but no bucket is configured", async () => {
    const provider = new GoogleDocAiProvider(
      payload({ config: { project_id: "p", processor_id: "q", parse_mode: "batch" } }),
    );
    await expect(
      provider.parse({ filename: "p.pdf", mimeType: "application/pdf", fileBuffer: await makePdf(40) }),
    ).rejects.toThrow(/requires a GCS bucket/);
  });

  it("throws when the operation completes but no output shards exist", async () => {
    // Router with an empty shard list → list returns no items.
    installBatchRouter([]);
    const provider = new GoogleDocAiProvider(payload());
    await expect(
      provider.parse({ filename: "p.pdf", mimeType: "application/pdf", fileBuffer: await makePdf(40) }),
    ).rejects.toThrow(/no output shards/);
  });
});

// ---------------------------------------------------------------------------
// buildBatchResponse — shard ordering.
// ---------------------------------------------------------------------------

describe("GoogleDocAiProvider.buildBatchResponse", () => {
  it("orders shards by shardInfo.shardIndex regardless of input order", () => {
    const provider = new GoogleDocAiProvider(payload());
    // Pass shards out of order; shardIndex must drive the merge order.
    const resp = provider.buildBatchResponse([
      paraDoc("second", 1, 1),
      paraDoc("first", 1, 0),
    ]);
    expect(resp.chunks?.map((c) => c.text)).toEqual(["first", "second"]);
    expect(resp.chunks?.map((c) => c.page)).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Reading Doc AI's own numbers out of a PAGE_LIMIT_EXCEEDED rejection —
// the recount that lets a mis-routed online call recover (oss-488).
// ---------------------------------------------------------------------------

/** The verbatim 400 body from the production failure, as the driver wraps it. */
const PAGE_LIMIT_400 = new Error(
  'google-docai process 400: {   "error": {     "code": 400,     "message": ' +
    '"Document pages exceed the limit: 30 got 76",     "status": "INVALID_ARGUMENT",  ' +
    '   "details": [       {         "@type": "type.googleapis.com/google.rpc.ErrorInfo", ' +
    '        "reason": "PAGE_LIMIT_EXCEEDED",         "domain": "documentai.googleapis.com", ' +
    '        "metadata": {           "page_limit": "30",           "pages": "76"    ' +
    "     }       }     ]   } }",
);

describe("reportedPageCount / reportedPageLimit", () => {
  it("reads both numbers out of the real production 400 body", () => {
    expect(reportedPageCount(PAGE_LIMIT_400)).toBe(76);
    expect(reportedPageLimit(PAGE_LIMIT_400)).toBe(30);
  });

  it("falls back to the message when there is no structured metadata", () => {
    const err = new Error("google-docai process 400: Document pages exceed the limit: 30 got 62");
    expect(reportedPageCount(err)).toBe(62);
    expect(reportedPageLimit(err)).toBe(30);
  });

  it("returns null when the error carries no page numbers", () => {
    const err = new Error("google-docai process 403: permission denied");
    expect(reportedPageCount(err)).toBeNull();
    expect(reportedPageLimit(err)).toBeNull();
  });

  it("does not confuse the limit for the count", () => {
    // "30 got 76" — the driver must never re-route on 30, which would build a
    // slice plan for less than half the document.
    expect(reportedPageCount(PAGE_LIMIT_400)).not.toBe(30);
  });
});
