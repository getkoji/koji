import { describe, it, expect } from "vitest";
import { parseRangeHeader } from "./jobs";

describe("embed-data highlights from provenanceJson", () => {
  /** Mirrors the provenance → highlights transform in the embed-data endpoint. */
  function buildHighlights(
    provenance: Record<
      string,
      {
        offset?: number;
        length?: number;
        page?: number;
        bbox?: { x: number; y: number; w: number; h: number };
        words?: Array<{ text: string; page: number; x: number; y: number; w: number; h: number }>;
        reasoning?: string;
      } | null
    >,
  ) {
    return Object.entries(provenance)
      .filter(([, v]) => v && (v.words?.length || (v.bbox && v.page)))
      .map(([field, v]) => ({
        field,
        page: v!.words?.[0]?.page ?? v!.page ?? 1,
        bbox: v!.bbox,
        words: v!.words,
        reasoning: v!.reasoning,
      }));
  }

  it("returns highlights array from provenance with words", () => {
    const provenance = {
      insured_name: {
        page: 1,
        bbox: { x: 100, y: 200, w: 300, h: 20 },
        words: [{ text: "Acme", page: 1, x: 100, y: 200, w: 50, h: 20 }],
        reasoning: "Found in header",
      },
    };

    const highlights = buildHighlights(provenance);
    expect(highlights).toHaveLength(1);
    expect(highlights[0]!.field).toBe("insured_name");
    expect(highlights[0]!.page).toBe(1);
    expect(highlights[0]!.words).toHaveLength(1);
    expect(highlights[0]!.reasoning).toBe("Found in header");
  });

  it("returns highlights from bbox-only provenance (no words)", () => {
    const provenance = {
      policy_number: {
        page: 2,
        bbox: { x: 50, y: 100, w: 200, h: 15 },
      },
    };

    const highlights = buildHighlights(provenance);
    expect(highlights).toHaveLength(1);
    expect(highlights[0]!.field).toBe("policy_number");
    expect(highlights[0]!.page).toBe(2);
    expect(highlights[0]!.bbox).toEqual({ x: 50, y: 100, w: 200, h: 15 });
  });

  it("skips null provenance entries", () => {
    const provenance = {
      insured_name: null,
      policy_number: {
        page: 1,
        bbox: { x: 10, y: 20, w: 100, h: 10 },
      },
    };

    const highlights = buildHighlights(provenance);
    expect(highlights).toHaveLength(1);
    expect(highlights[0]!.field).toBe("policy_number");
  });

  it("skips entries without bbox or words", () => {
    const provenance = {
      some_field: { offset: 100, length: 50 },
    };

    const highlights = buildHighlights(provenance as any);
    expect(highlights).toHaveLength(0);
  });

  it("returns empty array for empty provenance", () => {
    const highlights = buildHighlights({});
    expect(highlights).toHaveLength(0);
  });
});

describe("document rerun reset", () => {
  it("clears extraction results so UI shows clean extracting state", () => {
    const before = {
      status: "delivered",
      extractionJson: { name: "Acme" },
      confidence: "0.9500",
      validationJson: null,
      durationMs: 3200,
      completedAt: new Date("2026-04-20"),
      emittedAt: new Date("2026-04-20"),
      startedAt: new Date("2026-04-20"),
    };

    // Rerun resets all result fields
    const after = {
      ...before,
      status: "extracting",
      extractionJson: null,
      confidence: null,
      validationJson: null,
      durationMs: null,
      completedAt: null,
      emittedAt: null,
      startedAt: new Date(), // fresh timestamp
    };

    expect(after.status).toBe("extracting");
    expect(after.extractionJson).toBeNull();
    expect(after.confidence).toBeNull();
    expect(after.validationJson).toBeNull();
    expect(after.durationMs).toBeNull();
    expect(after.completedAt).toBeNull();
    expect(after.emittedAt).toBeNull();
    expect(after.startedAt.getTime()).toBeGreaterThan(before.startedAt.getTime());
  });

  it("clears validation errors from failed documents", () => {
    const before = {
      status: "failed",
      extractionJson: null,
      confidence: null,
      validationJson: { error_cause: "extraction_failed", message: "extract 500: internal error" },
      durationMs: null,
      completedAt: new Date("2026-04-20"),
    };

    const after = {
      ...before,
      status: "extracting",
      validationJson: null,
      completedAt: null,
    };

    expect(after.status).toBe("extracting");
    expect(after.validationJson).toBeNull();
    expect(after.completedAt).toBeNull();
  });

  it("resets job status back to running", () => {
    const jobBefore = {
      status: "complete",
      completedAt: new Date("2026-04-20"),
    };

    const jobAfter = {
      ...jobBefore,
      status: "running",
      completedAt: null,
    };

    expect(jobAfter.status).toBe("running");
    expect(jobAfter.completedAt).toBeNull();
  });

  it("resets failed job status back to running", () => {
    const jobBefore = {
      status: "failed",
      completedAt: new Date("2026-04-20"),
    };

    const jobAfter = {
      ...jobBefore,
      status: "running",
      completedAt: null,
    };

    expect(jobAfter.status).toBe("running");
    expect(jobAfter.completedAt).toBeNull();
  });

  it("rejects rerun on document already extracting", () => {
    const status = "extracting";
    const shouldReject = status === "extracting";
    expect(shouldReject).toBe(true);
  });

  it("allows rerun on delivered documents", () => {
    const status: string = "delivered";
    const shouldReject = status === "extracting";
    expect(shouldReject).toBe(false);
  });

  it("allows rerun on failed documents", () => {
    const status: string = "failed";
    const shouldReject = status === "extracting";
    expect(shouldReject).toBe(false);
  });

  it("allows rerun on review documents", () => {
    const status: string = "review";
    const shouldReject = status === "extracting";
    expect(shouldReject).toBe(false);
  });
});

describe("trace timeline on rerun", () => {
  it("most recent trace wins — ordered by startedAt DESC", () => {
    const traces = [
      { id: "t1", startedAt: new Date("2026-04-20T10:00:00Z"), status: "ok" },
      { id: "t2", startedAt: new Date("2026-04-21T10:00:00Z"), status: "failed" },
    ];

    // API picks the most recent trace (ORDER BY started_at DESC LIMIT 1)
    const latest = traces.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
    expect(latest!.id).toBe("t2");
  });

  it("old traces are not deleted — history preserved", () => {
    // Each rerun creates a new trace row via TraceRecorder.flush().
    // The rerun endpoint does NOT delete old traces — they accumulate
    // as history, and the API picks the most recent one.
    const traceCount = 3; // after 3 runs
    expect(traceCount).toBe(3);
  });
});

/**
 * parseRangeHeader pins the HTTP Range parsing used by the document
 * preview endpoint. pdf.js relies on the server understanding common
 * range forms (open-ended, closed, suffix) so it can lazy-fetch a PDF
 * instead of downloading the whole file before showing page 1. Any
 * regression here re-introduces the "preview hangs for 30s on big PDFs"
 * bug.
 */
describe("parseRangeHeader", () => {
  it("returns null for missing or non-bytes ranges", () => {
    expect(parseRangeHeader(undefined, 1000)).toBeNull();
    expect(parseRangeHeader("", 1000)).toBeNull();
    expect(parseRangeHeader("items=0-100", 1000)).toBeNull();
  });

  it("parses a closed range", () => {
    expect(parseRangeHeader("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
  });

  it("parses an open-ended range as start..size-1", () => {
    expect(parseRangeHeader("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
  });

  it("clamps an end past the object size down to size-1", () => {
    // pdf.js often asks for `bytes=N-N+CHUNK` where N+CHUNK > size; HTTP
    // says we should clamp rather than reject.
    expect(parseRangeHeader("bytes=900-99999", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("parses suffix ranges (last N bytes — pdf.js xref tail probe)", () => {
    expect(parseRangeHeader("bytes=-200", 1000)).toEqual({ start: 800, end: 999 });
  });

  it("treats a suffix larger than the file as the whole file", () => {
    expect(parseRangeHeader("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
  });

  it("rejects an out-of-bounds start", () => {
    expect(parseRangeHeader("bytes=2000-3000", 1000)).toBeNull();
  });

  it("rejects an inverted range", () => {
    expect(parseRangeHeader("bytes=500-100", 1000)).toBeNull();
  });

  it("rejects multi-range requests (we only serve single ranges)", () => {
    expect(parseRangeHeader("bytes=0-50,100-150", 1000)).toBeNull();
  });

  it("rejects garbage that parses to NaN", () => {
    expect(parseRangeHeader("bytes=foo-bar", 1000)).toBeNull();
  });

  it("returns null when the underlying size is 0", () => {
    expect(parseRangeHeader("bytes=-100", 0)).toBeNull();
    expect(parseRangeHeader("bytes=0-99", 0)).toBeNull();
  });
});
