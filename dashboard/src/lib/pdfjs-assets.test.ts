import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  PDFJS_ASSET_BASE,
  PDFJS_DOCUMENT_OPTIONS,
  PDFJS_WORKER_SRC,
} from "./pdfjs-assets";

/**
 * Guards the pdf.js runtime assets. The bug this exists to stop recurring:
 * without `wasmUrl`, a scanned (JPEG 2000) page renders BLANK with no error
 * anywhere in the UI — the highlight overlay still draws on top of the empty
 * canvas, so it looks like a viewer bug rather than a missing file. Nothing
 * else in the test suite or the build would notice.
 *
 * So we check both halves of the contract:
 *   1. the option shape pdf.js demands (trailing slashes), and
 *   2. that the files those URLs point at are actually committed under public/
 *      and are the ones the *installed* pdfjs-dist expects.
 */

const require = createRequire(import.meta.url);
const pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
const pdfjsVersion: string = require("pdfjs-dist/package.json").version;
const publicDir = path.resolve(__dirname, "..", "..", "public");

/** "/pdfjs/wasm/" -> "<repo>/dashboard/public/pdfjs/wasm" */
const served = (url: string) => path.join(publicDir, url.replace(/^\/|\/$/g, ""));

const sha256 = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

describe("pdf.js document options", () => {
  // pdf.js concatenates these bases with a filename instead of URL-joining, and
  // getFactoryUrlProp() throws on a base without a trailing slash.
  it.each(["wasmUrl", "cMapUrl", "standardFontDataUrl", "iccUrl"] as const)(
    "%s is an absolute path with a trailing slash",
    (key) => {
      const url = PDFJS_DOCUMENT_OPTIONS[key];
      expect(url.startsWith(`${PDFJS_ASSET_BASE}/`)).toBe(true);
      expect(url.endsWith("/")).toBe(true);
    },
  );

  // cMapUrl without cMapPacked reads the unpacked format and finds nothing.
  it("requests packed cmaps", () => {
    expect(PDFJS_DOCUMENT_OPTIONS.cMapPacked).toBe(true);
  });
});

describe("pdf.js assets are served out of public/", () => {
  // The exact filenames pdf.js builds from wasmUrl. openjpeg.wasm decodes JPX
  // images; the _nowasm_fallback is the pure-JS rescue path; qcms_bg.wasm is
  // ICC colour. jbig2.wasm only exists from pdfjs-dist 5.6 onward.
  it("serves every wasm module the installed pdfjs-dist ships", () => {
    const from = path.join(pdfjsRoot, "wasm");
    const to = served(PDFJS_DOCUMENT_OPTIONS.wasmUrl);
    const expected = readdirSync(from).filter((f) => !f.startsWith("LICENSE"));

    expect(expected).toContain("openjpeg.wasm");
    expect(expected).toContain("openjpeg_nowasm_fallback.js");

    for (const name of expected) {
      const copy = path.join(to, name);
      expect(existsSync(copy), `public${PDFJS_DOCUMENT_OPTIONS.wasmUrl}${name} is missing`).toBe(true);
      expect(sha256(copy), `${name} differs from pdfjs-dist@${pdfjsVersion}`).toBe(
        sha256(path.join(from, name)),
      );
    }
  });

  it.each([
    ["cMapUrl", "cmaps", ".bcmap"],
    ["standardFontDataUrl", "standard_fonts", ".pfb"],
    ["iccUrl", "iccs", ".icc"],
  ] as const)("serves the %s directory", (key, dir, ext) => {
    const to = served(PDFJS_DOCUMENT_OPTIONS[key]);
    expect(existsSync(to), `public/${PDFJS_ASSET_BASE}/${dir} is missing`).toBe(true);
    expect(readdirSync(to).filter((f) => f.endsWith(ext)).length).toBeGreaterThan(0);
  });

  // A hand-copied worker silently drifts on the next pdfjs-dist bump, and an
  // API/worker version mismatch fails the document load outright.
  it("serves the worker from the installed pdfjs-dist", () => {
    const copy = path.join(publicDir, PDFJS_WORKER_SRC.replace(/^\//, ""));
    expect(existsSync(copy)).toBe(true);
    expect(sha256(copy)).toBe(sha256(path.join(pdfjsRoot, "build", "pdf.worker.mjs")));
  });

  // Written by scripts/copy-pdfjs-assets.mjs. If this drifts, the committed
  // tree is from an older pdfjs-dist — re-run `pnpm pdfjs:assets`.
  it("has assets copied from the installed pdfjs-dist version", () => {
    const marker = path.join(served(`${PDFJS_ASSET_BASE}/`), "VERSION");
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8").trim()).toBe(pdfjsVersion);
  });
});
