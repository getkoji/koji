/**
 * Google Document AI — pdf-lib-unreadable PDFs (oss-377).
 *
 * Production incident: a 62-page owner-password-encrypted PDF (empty user
 * password, page tree in compressed object streams) made `countPdfPages`
 * return null, so the driver sent the WHOLE document to a single online
 * `:process` call and Doc AI rejected it with PAGE_LIMIT_EXCEEDED (limit 30,
 * got 62). These tests pin the fixed routing:
 *
 *   - the pdfjs-based probe recovers the true page count;
 *   - a large unsliceable doc is normalized ONCE via the parse service's
 *     `/normalize-pdf`, then sliced as usual;
 *   - normalize failure → ≤30pg retries as a single imageless call, larger
 *     docs surface an actionable error (never the doomed whole-doc call).
 *
 * Same test style as google-docai-sliced.test.ts: real PDF fixtures, stubbed
 * global fetch (which also intercepts the normalize-pdf HTTP call).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { GoogleDocAiProvider } from "./google-docai";
import type { GoogleDocument } from "./google-docai";
import type { ParseEndpointPayload } from "../resolve-tenant-parse";
import {
  ENCRYPTED_OBJSTM_PDF_40,
  ENCRYPTED_OBJSTM_PDF_20,
  ENCRYPTED_OBJSTM_PDF_40_NORMALIZED,
  ENCRYPTED_LOADABLE_PDF_20,
  ENCRYPTED_LOADABLE_PDF_20_NORMALIZED,
} from "../encrypted-pdf.fixture";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A minimal single-paragraph online `:process` response `Document`. */
function onlineDoc(text: string): GoogleDocument {
  return {
    text,
    pages: [
      {
        pageNumber: 1,
        paragraphs: [
          {
            layout: {
              textAnchor: {
                textSegments: [{ startIndex: "0", endIndex: String(text.length) }],
              },
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

function normalizeCalls(): string[] {
  return fetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.includes("/normalize-pdf"));
}

function processCalls(): Array<{ url: string; body: Record<string, unknown> }> {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes(":process"))
    .map((c) => ({
      url: String(c[0]),
      body: JSON.parse((c[1] as RequestInit).body as string),
    }));
}

describe("GoogleDocAiProvider.parse — encrypted/object-stream PDFs (pdf-lib unreadable)", () => {
  it("normalizes once via the parse service, then slices as usual", async () => {
    let slice = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/normalize-pdf")) {
        return jsonResponse({
          pdf_base64: ENCRYPTED_OBJSTM_PDF_40_NORMALIZED.toString("base64"),
          pages: 40,
          byte_size: ENCRYPTED_OBJSTM_PDF_40_NORMALIZED.length,
        });
      }
      slice += 1;
      return jsonResponse({ document: onlineDoc(`segment ${slice}`) });
    });

    const provider = new GoogleDocAiProvider(payload());
    const res = await provider.parse({
      filename: "encrypted-policy.pdf",
      mimeType: "application/pdf",
      fileBuffer: ENCRYPTED_OBJSTM_PDF_40,
    });

    // One normalize round trip, then the standard 40pg → ceil(40/15) = 3 slices.
    expect(normalizeCalls()).toHaveLength(1);
    expect(processCalls()).toHaveLength(3);
    // The original pre-fix failure mode was ONE whole-doc :process call.
    expect(res.pages).toBe(40);
    expect(res.engine).toBe("google-docai");
    expect(res.markdown).toContain("segment 1");
    expect(res.markdown).toContain("segment 3");
  });

  it("surfaces an actionable error when normalize fails and the doc exceeds the online cap", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/normalize-pdf")) {
        return jsonResponse({ error: "normalize failed: boom" }, 422);
      }
      throw new Error("no :process call should be made for an unparseable 40pg doc");
    });

    const provider = new GoogleDocAiProvider(payload());
    await expect(
      provider.parse({
        filename: "encrypted-policy.pdf",
        mimeType: "application/pdf",
        fileBuffer: ENCRYPTED_OBJSTM_PDF_40,
      }),
    ).rejects.toThrow(/40 pages.*cannot be sliced locally.*parse_mode="batch"/s);

    expect(processCalls()).toHaveLength(0);
  });

  it("falls back to ONE imageless online call when normalize fails but the doc fits the 30pg cap", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/normalize-pdf")) {
        return jsonResponse({ error: "normalize failed: boom" }, 422);
      }
      return jsonResponse({ document: onlineDoc("whole doc") });
    });

    const provider = new GoogleDocAiProvider(payload());
    const res = await provider.parse({
      filename: "encrypted-small.pdf",
      mimeType: "application/pdf",
      fileBuffer: ENCRYPTED_OBJSTM_PDF_20,
    });

    const calls = processCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.imagelessMode).toBe(true);
    expect(res.markdown).toContain("whole doc");
  });

  it("decrypts an encrypted-BUT-loadable PDF up front, then slices (oss-448)", async () => {
    // The trap: pdf-lib CAN load this PDF (no object streams) so the pre-fix
    // code skipped normalize and sliced encrypted content streams → blank pages
    // → empty parse. The fix decrypts once up front, then slices as usual.
    let slice = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/normalize-pdf")) {
        return jsonResponse({
          pdf_base64: ENCRYPTED_LOADABLE_PDF_20_NORMALIZED.toString("base64"),
          pages: 20,
          byte_size: ENCRYPTED_LOADABLE_PDF_20_NORMALIZED.length,
        });
      }
      slice += 1;
      return jsonResponse({ document: onlineDoc(`segment ${slice}`) });
    });

    const provider = new GoogleDocAiProvider(payload());
    const res = await provider.parse({
      filename: "encrypted-loadable-policy.pdf",
      mimeType: "application/pdf",
      fileBuffer: ENCRYPTED_LOADABLE_PDF_20,
    });

    // Exactly one decrypt round trip, then 20pg → ceil(20/15) = 2 slices.
    expect(normalizeCalls()).toHaveLength(1);
    expect(processCalls()).toHaveLength(2);
    expect(res.pages).toBe(20);
    expect(res.markdown).toContain("segment 1");
    expect(res.markdown).toContain("segment 2");
  });

  it("proceeds on original bytes when up-front decrypt of a loadable PDF fails", async () => {
    // Parse service down / refuses. The doc is small enough that routing still
    // attempts a single online call rather than throwing — the downstream
    // empty-text guard (dag-runner) surfaces any resulting blank as a failure.
    let normalizeAttempts = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/normalize-pdf")) {
        normalizeAttempts += 1;
        return jsonResponse({ error: "normalize failed: service down" }, 422);
      }
      return jsonResponse({ document: onlineDoc("whole doc fallback") });
    });

    const provider = new GoogleDocAiProvider(payload({ slice_pages: 30 }));
    const res = await provider.parse({
      filename: "encrypted-loadable-small.pdf",
      mimeType: "application/pdf",
      fileBuffer: ENCRYPTED_LOADABLE_PDF_20,
    });

    expect(normalizeAttempts).toBe(1);
    // 20pg ≤ slice_pages(30) → a single online call on the original bytes.
    expect(processCalls()).toHaveLength(1);
    expect(res.markdown).toContain("whole doc fallback");
  });

  it("still routes batch-configured tenants to :batchProcess without normalizing", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/normalize-pdf")) {
        throw new Error("batch path must not normalize — Doc AI reads the original bytes from GCS");
      }
      // Fail fast on the first GCS upload; the batch flow itself is covered
      // by google-docai-batch.test.ts. Reaching GCS proves the routing.
      return new Response("gcs upload rejected", { status: 500 });
    });

    const provider = new GoogleDocAiProvider(
      payload({ parse_mode: "batch", gcs_bucket: "bkt" }),
    );
    await expect(
      provider.parse({
        filename: "encrypted-policy.pdf",
        mimeType: "application/pdf",
        fileBuffer: ENCRYPTED_OBJSTM_PDF_40,
      }),
    ).rejects.toThrow();

    expect(normalizeCalls()).toHaveLength(0);
    expect(processCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A page tree pdf-lib reads but undercounts (oss-488).
// ---------------------------------------------------------------------------

describe("GoogleDocAiProvider.parse — Doc AI contradicts our page count", () => {
  it("normalizes and re-slices when Doc AI reports more pages than we counted", async () => {
    // The production shape: pdf-lib loads the document without complaint and
    // reports far fewer pages than it holds, so routing sends the whole thing
    // to one online call. Doc AI's rejection is the first reliable signal that
    // our page tree is wrong — at which point pdf-lib must not be trusted to
    // slice either, so the bytes go through /normalize-pdf first.
    let calls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/normalize-pdf")) {
        return jsonResponse({
          pdf_base64: ENCRYPTED_OBJSTM_PDF_40_NORMALIZED.toString("base64"),
          pages: 40,
          byte_size: ENCRYPTED_OBJSTM_PDF_40_NORMALIZED.length,
        });
      }
      calls += 1;
      if (calls === 1) {
        return jsonResponse(
          {
            error: {
              code: 400,
              message: "Document pages exceed the limit: 30 got 40",
              details: [{ metadata: { page_limit: "30", pages: "40" } }],
            },
          },
          400,
        );
      }
      return jsonResponse({ document: onlineDoc(`segment ${calls}`) });
    });

    // ENCRYPTED_LOADABLE_PDF_20 is loadable and probes at 20 pages; slice_pages
    // 25 sends it down the single-online route, where Doc AI says it saw 40.
    const provider = new GoogleDocAiProvider(payload({ slice_pages: 25 }));
    const res = await provider.parse({
      filename: "undercounted.pdf",
      mimeType: "application/pdf",
      fileBuffer: ENCRYPTED_LOADABLE_PDF_20,
    });

    // The rejected whole-document call, then normalize, then real slices.
    expect(normalizeCalls().length).toBeGreaterThanOrEqual(1);
    expect(processCalls().length).toBeGreaterThan(1);
    expect(res.markdown).toContain("segment");
  });
});
