import { describe, it, expect } from "vitest";
import { normalizeMimeType, normalizeMimeTypeWithWarning, mimeTypeFor } from "./process";
import { resolveMimeType, sniffMimeFromBytes } from "./mime";

// Minimal magic-byte fixtures for the sniffer.
const PDF_BYTES = Buffer.from("%PDF-1.7\n...", "latin1");
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const TIFF_LE_BYTES = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08]);
const TIFF_BE_BYTES = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x08]);
const GARBAGE_BYTES = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

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
  it("maps text and markdown extensions (oss-446)", () => {
    expect(mimeTypeFor("notes.txt")).toBe("text/plain");
    expect(mimeTypeFor("log.text")).toBe("text/plain");
    expect(mimeTypeFor("README.md")).toBe("text/markdown");
    expect(mimeTypeFor("doc.markdown")).toBe("text/markdown");
    expect(mimeTypeFor("DOC.MD")).toBe("text/markdown");
  });
});

describe("sniffMimeFromBytes", () => {
  it("sniffs PDF from the %PDF signature", () => {
    expect(sniffMimeFromBytes(PDF_BYTES)).toBe("application/pdf");
  });
  it("sniffs PNG from its 8-byte signature", () => {
    expect(sniffMimeFromBytes(PNG_BYTES)).toBe("image/png");
  });
  it("sniffs JPEG from FF D8 FF", () => {
    expect(sniffMimeFromBytes(JPEG_BYTES)).toBe("image/jpeg");
  });
  it("sniffs TIFF in both byte orders", () => {
    expect(sniffMimeFromBytes(TIFF_LE_BYTES)).toBe("image/tiff");
    expect(sniffMimeFromBytes(TIFF_BE_BYTES)).toBe("image/tiff");
  });
  it("returns null for unrecognized bytes, empty, or missing buffers", () => {
    expect(sniffMimeFromBytes(GARBAGE_BYTES)).toBeNull();
    expect(sniffMimeFromBytes(Buffer.from([]))).toBeNull();
    expect(sniffMimeFromBytes(null)).toBeNull();
    expect(sniffMimeFromBytes(undefined)).toBeNull();
  });
});

describe("resolveMimeType (parse-path: claimed → filename → magic bytes)", () => {
  it("trusts a real, specific claimed MIME", () => {
    expect(resolveMimeType("application/pdf", "doc.pdf", PDF_BYTES)).toBe("application/pdf");
    // Trusts even when it disagrees with the filename — sniffing renamed files
    // is the parser's job, not ours.
    expect(resolveMimeType("application/zip", "weird.pdf", PDF_BYTES)).toBe("application/zip");
  });

  it("upgrades a bare extension via the filename — the arts.pdf 502 root cause", () => {
    expect(resolveMimeType("pdf", "arts.pdf", PDF_BYTES)).toBe("application/pdf");
    expect(resolveMimeType("png", "shot.png", PNG_BYTES)).toBe("image/png");
  });

  it("infers from the filename when the claimed MIME is missing/empty", () => {
    expect(resolveMimeType(null, "doc.pdf")).toBe("application/pdf");
    expect(resolveMimeType("", "doc.pdf")).toBe("application/pdf");
    expect(resolveMimeType(undefined, "doc.pdf")).toBe("application/pdf");
  });

  it("treats application/octet-stream as unknown and upgrades it", () => {
    // Filename wins first.
    expect(resolveMimeType("application/octet-stream", "doc.pdf")).toBe("application/pdf");
    // Then bytes, when the filename can't help.
    expect(resolveMimeType("application/octet-stream", "blob", PDF_BYTES)).toBe("application/pdf");
  });

  it("sniffs magic bytes when neither claimed MIME nor filename help", () => {
    expect(resolveMimeType("pdf", null, PDF_BYTES)).toBe("application/pdf");
    expect(resolveMimeType(null, "no-extension", PNG_BYTES)).toBe("image/png");
    expect(resolveMimeType(null, "scan", JPEG_BYTES)).toBe("image/jpeg");
  });

  it("falls back to octet-stream when nothing identifies the file", () => {
    expect(resolveMimeType(null, null)).toBe("application/octet-stream");
    expect(resolveMimeType("pdf", null)).toBe("application/octet-stream");
    expect(resolveMimeType(null, "no-extension", GARBAGE_BYTES)).toBe("application/octet-stream");
  });

  it("trims surrounding whitespace before validating", () => {
    expect(resolveMimeType("  application/pdf  ", "doc.pdf")).toBe("application/pdf");
  });
});
