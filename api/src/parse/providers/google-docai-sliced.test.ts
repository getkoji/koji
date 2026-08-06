/**
 * Google Document AI slice→parallel→merge tests (oss-286).
 *
 * Covers the new GCS-free DEFAULT for large docs: a doc within one slice (≤ the
 * configured slice size, default 15pg) goes through a single online `:process`
 * call; anything larger is sliced into ≤-slice-size segments, each run through
 * online `:process` in parallel (bounded by a configurable concurrency cap), and
 * merged with global page renumbering. Batch (`parse_mode: "batch"`) is exercised
 * separately in `google-docai-batch.test.ts`.
 *
 * The whole surface is exercised with real generated PDFs (so `slicePdfPages`
 * actually carves them) and a mocked `fetch` for the Doc AI `:process` endpoint —
 * no live processor. Page-count routing, slice→parallel→merge, page renumbering,
 * bbox preservation, the concurrency cap, oversize-slice bisection, and
 * failure-surfacing are all verified without Google credentials. Live validation
 * against a real processor is pending; see the header in `google-docai.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PDFDocument } from "pdf-lib";

import { GoogleDocAiProvider } from "./google-docai";
import type { GoogleDocument } from "./google-docai";
import type { ParseEndpointPayload } from "../resolve-tenant-parse";

/** Build a real PDF buffer with `n` blank pages so pdf-lib can slice + count it. */
async function makePdf(n: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A single-paragraph online `:process` response `Document`. Local page number 1
 * (a sliced PDF always restarts at page 1); optional normalized bbox so merge
 * can be checked to preserve geometry.
 */
function onlineDoc(text: string, bbox?: { x: number; y: number; w: number; h: number }): GoogleDocument {
  return {
    text,
    pages: [
      {
        pageNumber: 1,
        paragraphs: [
          {
            layout: {
              textAnchor: { textSegments: [{ startIndex: "0", endIndex: String(text.length) }] },
              ...(bbox
                ? {
                    boundingPoly: {
                      normalizedVertices: [
                        { x: bbox.x, y: bbox.y },
                        { x: bbox.x + bbox.w, y: bbox.y },
                        { x: bbox.x + bbox.w, y: bbox.y + bbox.h },
                        { x: bbox.x, y: bbox.y + bbox.h },
                      ],
                    },
                  }
                : {}),
            },
          },
        ],
      },
    ],
  };
}

function payload(config: Record<string, unknown> = {}): ParseEndpointPayload {
  return {
    provider: "google-docai",
    api_key: "ya29.token",
    region: "us",
    // NB: no parse_mode and no gcs_bucket — the slice path is GCS-free.
    config: { project_id: "proj", processor_id: "proc", ...config },
  };
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

/** Count `:process` POSTs and pull their parsed request bodies. */
function processCalls(): Array<{ url: string; body: Record<string, unknown> }> {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes(":process"))
    .map((c) => ({ url: String(c[0]), body: JSON.parse((c[1] as RequestInit).body as string) }));
}

describe("GoogleDocAiProvider.parse — single online call (≤ slice size)", () => {
  it("routes ≤15pg to ONE online :process with no imagelessMode and no GCS", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ document: onlineDoc("hello") }));
    const provider = new GoogleDocAiProvider(payload());
    const res = await provider.parse({
      filename: "small.pdf",
      mimeType: "application/pdf",
      fileBuffer: await makePdf(12),
    });

    const calls = processCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).not.toContain(":batchProcess");
    expect(calls[0]!.body.imagelessMode).toBeUndefined();
    expect(res.engine).toBe("google-docai");
    expect(res.chunks).toHaveLength(1);
    expect(res.chunks![0]!.page).toBe(1);
  });

  it("uses imagelessMode for a single call when the configured slice size exceeds 15", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ document: onlineDoc("hi") }));
    const provider = new GoogleDocAiProvider(payload({ slice_pages: 30 }));
    // 20pg ≤ 30pg slice size → single call; 20 > 15 → imagelessMode lifts the cap.
    await provider.parse({
      filename: "mid.pdf",
      mimeType: "application/pdf",
      fileBuffer: await makePdf(20),
    });

    const calls = processCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.imagelessMode).toBe(true);
  });
});

describe("GoogleDocAiProvider.parse — slice → parallel → merge (default >15pg)", () => {
  it("slices a >15pg doc into ≤15pg online calls and renumbers pages globally", async () => {
    // Return one identifiable paragraph per slice so the merge can be asserted.
    // Fresh Response per call — a Response body can only be read once.
    fetchMock.mockImplementation(async () => jsonResponse({ document: onlineDoc("SLICE") }));
    const provider = new GoogleDocAiProvider(payload());
    // 40pg, default 15 → ranges (1-15, 16-30, 31-40): 3 online calls.
    const res = await provider.parse({
      filename: "policy.pdf",
      mimeType: "application/pdf",
      fileBuffer: await makePdf(40),
    });

    const calls = processCalls();
    expect(calls).toHaveLength(3);
    // No batch, no GCS, all plain online (each slice ≤15pg → no imagelessMode).
    expect(calls.every((c) => c.url.includes(":process") && !c.url.includes(":batchProcess"))).toBe(true);
    expect(calls.every((c) => c.body.imagelessMode === undefined)).toBe(true);

    // Three shards (spans 15, 15, 10), each a local page-1 paragraph → global
    // pages 1, 16, 31 after renumbering by the running page offset.
    expect(res.chunks?.map((c) => c.page)).toEqual([1, 16, 31]);
    expect(res.pages).toBe(40);
    expect(res.markdown).toBe("SLICE\n\nSLICE\n\nSLICE");
  });

  it("honors a configurable slice size", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ document: onlineDoc("X") }));
    const provider = new GoogleDocAiProvider(payload({ slice_pages: 10 }));
    // 25pg / 10 → ranges (1-10, 11-20, 21-25): 3 calls, pages 1, 11, 21.
    const res = await provider.parse({
      filename: "p.pdf",
      mimeType: "application/pdf",
      fileBuffer: await makePdf(25),
    });

    expect(processCalls()).toHaveLength(3);
    expect(res.chunks?.map((c) => c.page)).toEqual([1, 11, 21]);
    expect(res.pages).toBe(25);
  });

  it("preserves per-chunk bbox through the merge", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ document: onlineDoc("box", { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }) }),
    );
    const provider = new GoogleDocAiProvider(payload());
    const res = await provider.parse({
      filename: "p.pdf",
      mimeType: "application/pdf",
      fileBuffer: await makePdf(20),
    });

    expect(res.chunks).toHaveLength(2); // 20pg / 15 → 2 slices
    for (const chunk of res.chunks!) {
      expect(chunk.bbox?.x).toBeCloseTo(0.1, 9);
      expect(chunk.bbox?.y).toBeCloseTo(0.2, 9);
      expect(chunk.bbox?.w).toBeCloseTo(0.3, 9);
      expect(chunk.bbox?.h).toBeCloseTo(0.4, 9);
    }
  });
});

describe("GoogleDocAiProvider.parse — concurrency cap", () => {
  it("never exceeds the configured online concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (!String(url).includes(":process")) throw new Error(`unexpected fetch: ${url}`);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return jsonResponse({ document: onlineDoc("Y") });
    });

    const provider = new GoogleDocAiProvider(payload({ slice_pages: 5, online_concurrency: 2 }));
    // 30pg / 5 → 6 slices, but at most 2 in flight at once.
    await provider.parse({
      filename: "p.pdf",
      mimeType: "application/pdf",
      fileBuffer: await makePdf(30),
    });

    expect(processCalls()).toHaveLength(6);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(1); // confirms parallelism actually happened
  });
});

describe("GoogleDocAiProvider.parse — graceful slice handling", () => {
  it("bisects and retries an oversize slice instead of failing", async () => {
    let calls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (!String(url).includes(":process")) throw new Error(`unexpected fetch: ${url}`);
      calls += 1;
      // The first call (the first 1-2 slice) is rejected as too large.
      if (calls === 1) {
        return jsonResponse({ error: { message: "PAGE_LIMIT_EXCEEDED: too large" } }, 400);
      }
      return jsonResponse({ document: onlineDoc("ok") });
    });

    // slice_pages 2, concurrency 1 (deterministic order), 4pg → ranges (1-2, 3-4).
    const provider = new GoogleDocAiProvider(payload({ slice_pages: 2, online_concurrency: 1 }));
    const res = await provider.parse({
      filename: "p.pdf",
      mimeType: "application/pdf",
      fileBuffer: await makePdf(4),
    });

    // 1 failed (1-2) + 2 bisected halves (1-1, 2-2) + 1 (3-4) = 4 :process calls.
    expect(processCalls()).toHaveLength(4);
    // No page dropped: spans 1 + 1 + 2 = 4 pages total.
    expect(res.pages).toBe(4);
    expect(res.chunks).toHaveLength(3);
    expect(res.chunks?.map((c) => c.page)).toEqual([1, 2, 3]);
  });

  it("surfaces (does not drop pages) when a single-page slice is still rejected", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (!String(url).includes(":process")) throw new Error(`unexpected fetch: ${url}`);
      return jsonResponse({ error: { message: "PAGE_LIMIT_EXCEEDED" } }, 400);
    });

    // slice_pages 1 → single-page slices; an oversize single page can't bisect.
    const provider = new GoogleDocAiProvider(payload({ slice_pages: 1, online_concurrency: 1 }));
    await expect(
      provider.parse({ filename: "p.pdf", mimeType: "application/pdf", fileBuffer: await makePdf(2) }),
    ).rejects.toThrow(/process 400/);
  });

  it("surfaces a non-oversize error without bisecting", async () => {
    let calls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (!String(url).includes(":process")) throw new Error(`unexpected fetch: ${url}`);
      calls += 1;
      return jsonResponse({ error: { message: "permission denied" } }, 403);
    });

    const provider = new GoogleDocAiProvider(payload({ slice_pages: 5, online_concurrency: 1 }));
    await expect(
      provider.parse({ filename: "p.pdf", mimeType: "application/pdf", fileBuffer: await makePdf(20) }),
    ).rejects.toThrow(/process 403/);
    // A 403 isn't retryable → no bisection (the first failing slice aborts).
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Doc AI's own oversize rejection as the last-resort recount (oss-488).
// ---------------------------------------------------------------------------

describe("GoogleDocAiProvider.parse — oversize rejection on the online route", () => {
  it("re-routes to slicing when Doc AI rejects a call we sized as one page-count", async () => {
    // The production shape, reduced: a local count says the document fits one
    // online call, Doc AI disagrees. Before oss-488 the 400 propagated and the
    // document failed outright; now Doc AI's rejection is treated as the
    // authoritative recount and the document is sliced instead.
    // The request body carries only the bytes, so the whole-document call is
    // identified by being the first one.
    let calls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (!String(url).includes(":process")) throw new Error(`unexpected fetch: ${url}`);
      calls += 1;
      if (calls === 1) {
        return jsonResponse(
          {
            error: {
              code: 400,
              message: "Document pages exceed the limit: 30 got 20",
              details: [{ metadata: { page_limit: "30", pages: "20" } }],
            },
          },
          400,
        );
      }
      return jsonResponse({ document: onlineDoc("sliced text") });
    });

    // slice_pages 25 > the real 20 pages, so routing picks a single online call.
    const provider = new GoogleDocAiProvider(payload({ slice_pages: 25, online_concurrency: 1 }));
    const result = await provider.parse({
      filename: "p.pdf",
      mimeType: "application/pdf",
      fileBuffer: await makePdf(20),
    });

    expect(result.markdown).toContain("sliced text");
    // The retry has to be genuinely SMALLER than the rejected call. Re-slicing
    // at the configured 25pg would rebuild the same 20-page request and fail
    // identically, so the recovery halves it: 1 rejected + 2 slices of ≤10pg.
    expect(processCalls().length).toBe(3);
  });

  it("still surfaces a non-oversize failure from the online route", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (!String(url).includes(":process")) throw new Error(`unexpected fetch: ${url}`);
      return jsonResponse({ error: { message: "permission denied" } }, 403);
    });

    const provider = new GoogleDocAiProvider(payload({ slice_pages: 25 }));
    await expect(
      provider.parse({ filename: "p.pdf", mimeType: "application/pdf", fileBuffer: await makePdf(5) }),
    ).rejects.toThrow(/process 403/);
    // A 403 is not fixed by re-routing — exactly one call, no recovery attempt.
    expect(processCalls().length).toBe(1);
  });
});

describe("GoogleDocAiProvider.parse — a bare 400 is not treated as oversize", () => {
  it("fails fast on a malformed-request 400 instead of normalizing and re-slicing", async () => {
    // A bad `rawDocument.mime_type` also comes back as 400 (oss-307). Slicing
    // cannot fix it, so the whole-document route must not spend a normalize
    // round-trip plus N sliced calls discovering that. (Slice-level bisection
    // keeps its looser any-400 rule — a retry there is cheap.)
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/normalize-pdf")) throw new Error("normalize must not be called");
      if (!String(url).includes(":process")) throw new Error(`unexpected fetch: ${url}`);
      return jsonResponse(
        { error: { code: 400, message: "Invalid rawDocument.mime_type", status: "INVALID_ARGUMENT" } },
        400,
      );
    });

    const provider = new GoogleDocAiProvider(payload({ slice_pages: 25 }));
    await expect(
      provider.parse({ filename: "p.pdf", mimeType: "application/pdf", fileBuffer: await makePdf(5) }),
    ).rejects.toThrow(/process 400/);
    expect(processCalls().length).toBe(1);
  });
});
