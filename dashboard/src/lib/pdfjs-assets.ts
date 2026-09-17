/**
 * Where PDF.js fetches its runtime assets from.
 *
 * These are NOT bundled — pdf.js requests them over HTTP *while rendering*,
 * from the base URLs handed to `getDocument()`. Every one defaults to `null`,
 * and a null base is a silent, per-document failure:
 *
 *   - `wasmUrl` gates the JPEG 2000 (and, from 5.6, JBIG2) image decoders.
 *     Without it `JpxImage#instantiateWasm` throws, and the pure-JS rescue path
 *     can't run either: it builds its module specifier by string concatenation,
 *     so a null base asks for the literal `"nullopenjpeg_nowasm_fallback.js"`.
 *     A scanned page whose only content is a JPX image then paints *blank* —
 *     no error reaches the user, and neighbouring vector-text pages render
 *     fine because they need no decoder, so it reads as a viewer bug rather
 *     than a missing asset. `wasmUrl` also gates qcms, i.e. ICC colour.
 *   - `cMapUrl` gates CJK / non-Latin character maps.
 *   - `standardFontDataUrl` gates the 14 standard fonts when not embedded.
 *
 * Setting all three also flips pdf.js to `useWorkerFetch`, so the worker pulls
 * them directly instead of round-tripping the bytes through the main thread.
 *
 * The files are copied out of node_modules into `public/pdfjs/` by
 * `scripts/copy-pdfjs-assets.mjs` (wired as `prebuild`/`predev`, output
 * committed). They are served unauthenticated — the embed viewer's iframe is
 * cross-origin and cookieless, so an auth redirect on these paths breaks it.
 */

/** Served root for the copied pdfjs-dist asset tree. No trailing slash. */
export const PDFJS_ASSET_BASE = "/pdfjs";

/**
 * `getDocument()` options. Frozen and module-level on purpose: react-pdf treats
 * a fresh `options` identity as a new document and reloads the PDF on every
 * render if this is rebuilt inline.
 *
 * The trailing slashes are REQUIRED — pdf.js concatenates these bases with a
 * filename rather than URL-joining, and `getFactoryUrlProp` throws outright on
 * a base without one.
 */
export const PDFJS_DOCUMENT_OPTIONS = Object.freeze({
  wasmUrl: `${PDFJS_ASSET_BASE}/wasm/`,
  cMapUrl: `${PDFJS_ASSET_BASE}/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${PDFJS_ASSET_BASE}/standard_fonts/`,
  iccUrl: `${PDFJS_ASSET_BASE}/iccs/`,
});

/** Served path of the pdf.js worker, copied alongside the assets above. */
export const PDFJS_WORKER_SRC = "/pdf.worker.mjs";
