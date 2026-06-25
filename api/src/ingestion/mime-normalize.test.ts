import { describe, it, expect } from "vitest";
import { normalizeMimeType, normalizeMimeTypeWithWarning, mimeTypeFor } from "./process";

describe("normalizeMimeType", () => {
  it("passes through a valid MIME type unchanged", () => {
    expect(normalizeMimeType("application/pdf", "doc.pdf")).toBe("application/pdf");
    expect(normalizeMimeType("image/png", "image.png")).toBe("image/png");
    expect(normalizeMimeType("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "x.docx"))
      .toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("falls back to filename when claimed mime is a bare extension", () => {
    // The actual bug — clients setting `Content-Type: pdf` on presigned uploads.
    expect(normalizeMimeType("pdf", "policy.pdf")).toBe("application/pdf");
    expect(normalizeMimeType("png", "screenshot.png")).toBe("image/png");
  });

  it("falls back to filename when claimed mime is empty / null / undefined", () => {
    expect(normalizeMimeType(null, "doc.pdf")).toBe("application/pdf");
    expect(normalizeMimeType(undefined, "doc.pdf")).toBe("application/pdf");
    expect(normalizeMimeType("", "doc.pdf")).toBe("application/pdf");
    expect(normalizeMimeType("   ", "doc.pdf")).toBe("application/pdf");
  });

  it("falls back to filename when claimed mime is non-string nonsense", () => {
    // The slash-required rule rejects anything that's clearly not a MIME.
    expect(normalizeMimeType("garbage", "doc.pdf")).toBe("application/pdf");
    expect(normalizeMimeType("not_a_mime", "doc.pdf")).toBe("application/pdf");
  });

  it("returns octet-stream when both claimed mime and filename are useless", () => {
    expect(normalizeMimeType("pdf", null)).toBe("application/octet-stream");
    expect(normalizeMimeType(null, null)).toBe("application/octet-stream");
    expect(normalizeMimeType(null, "no-extension")).toBe("application/octet-stream");
  });

  it("does not silently 'fix' non-PDF mimes with PDF filenames", () => {
    // If the claimed mime is structurally valid, we trust it — even if it
    // disagrees with the filename. Sniffing PDFs that have been renamed to
    // .pdf but aren't is the parser's job, not ours.
    expect(normalizeMimeType("application/zip", "weird.pdf")).toBe("application/zip");
  });

  it("trims surrounding whitespace before validating", () => {
    expect(normalizeMimeType("  application/pdf  ", "doc.pdf")).toBe("application/pdf");
  });
});

describe("normalizeMimeTypeWithWarning", () => {
  it("returns no warning when the claimed mime is structurally valid", () => {
    const r = normalizeMimeTypeWithWarning("application/pdf", "doc.pdf");
    expect(r.value).toBe("application/pdf");
    expect(r.warning).toBeNull();
  });

  it("warns when the claimed mime is a bare extension", () => {
    const r = normalizeMimeTypeWithWarning("pdf", "policy.pdf");
    expect(r.value).toBe("application/pdf");
    expect(r.warning).toMatch(/"pdf" is not a valid MIME type/);
    expect(r.warning).toMatch(/Coerced to "application\/pdf"/);
    expect(r.warning).toMatch(/"policy\.pdf"/);
  });

  it("warns differently when no Content-Type was supplied", () => {
    const r = normalizeMimeTypeWithWarning(null, "policy.pdf");
    expect(r.value).toBe("application/pdf");
    expect(r.warning).toMatch(/No Content-Type was provided/);
  });

  it("warns even when filename can't help (octet-stream fallback)", () => {
    const r = normalizeMimeTypeWithWarning("pdf", null);
    expect(r.value).toBe("application/octet-stream");
    expect(r.warning).toMatch(/Coerced to "application\/octet-stream"/);
    expect(r.warning).toMatch(/\(no filename\)/);
  });

  it("never warns when whitespace surrounds a valid mime", () => {
    const r = normalizeMimeTypeWithWarning("  application/pdf  ", "doc.pdf");
    expect(r.value).toBe("application/pdf");
    expect(r.warning).toBeNull();
  });
});

describe("mimeTypeFor (regression — unchanged by this PR)", () => {
  it("returns application/pdf for .pdf filenames", () => {
    expect(mimeTypeFor("foo.pdf")).toBe("application/pdf");
  });
  it("returns octet-stream for null / no extension", () => {
    expect(mimeTypeFor(null)).toBe("application/octet-stream");
    expect(mimeTypeFor("no-extension")).toBe("application/octet-stream");
  });
});
