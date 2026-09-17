#!/usr/bin/env node
/**
 * Copy PDF.js's runtime assets out of node_modules into public/.
 *
 * PDF.js does not bundle these — it fetches them over HTTP at render time from
 * the base URLs handed to `getDocument()` (`wasmUrl`, `cMapUrl`,
 * `standardFontDataUrl`, `iccUrl`). If they are not served, the affected
 * feature fails *silently on that document only*: a JPEG 2000 scan renders as
 * a blank page while the surrounding vector-text pages look fine.
 *
 * The copies are committed, so a deploy path that skips lifecycle scripts still
 * serves them. Re-running is idempotent; run it after bumping pdfjs-dist and
 * commit the diff. `public/pdfjs/VERSION` makes a stale copy visible in review.
 *
 * Keep the worker (public/pdf.worker.mjs) generated from the same package as
 * the assets — the API and worker builds must be the same pdfjs-dist version,
 * and a hand-copied worker silently drifts on the next bump.
 */
import { createRequire } from "node:module";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const pkgJsonPath = require.resolve("pdfjs-dist/package.json");
const pkgRoot = path.dirname(pkgJsonPath);
const { version } = require(pkgJsonPath);

const publicDir = path.resolve(import.meta.dirname, "..", "public");
const assetDir = path.join(publicDir, "pdfjs");

// Directory name in pdfjs-dist -> served at /pdfjs/<name>/. The names are load
// bearing: PdfViewer passes /pdfjs/<name>/ as the matching getDocument option.
const ASSET_DIRS = ["wasm", "cmaps", "standard_fonts", "iccs"];

await rm(assetDir, { recursive: true, force: true });
await mkdir(assetDir, { recursive: true });

for (const name of ASSET_DIRS) {
  const from = path.join(pkgRoot, name);
  // `iccs` only exists in newer pdfjs-dist; skip rather than fail the build.
  await cp(from, path.join(assetDir, name), { recursive: true, force: true }).catch((err) => {
    if (err.code === "ENOENT") {
      console.warn(`[pdfjs-assets] pdfjs-dist@${version} has no ${name}/ — skipped`);
      return;
    }
    throw err;
  });
}

await cp(
  path.join(pkgRoot, "build", "pdf.worker.mjs"),
  path.join(publicDir, "pdf.worker.mjs"),
  { force: true },
);

await writeFile(path.join(assetDir, "VERSION"), `${version}\n`);

console.log(`[pdfjs-assets] copied pdfjs-dist@${version} runtime assets into public/`);
