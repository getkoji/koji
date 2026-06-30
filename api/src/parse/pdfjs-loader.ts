/**
 * Shared pdfjs loader — the single entry point every parse module uses to pull
 * in `pdfjs-dist`. Importing pdfjs directly is unsafe in serverless/Node
 * runtimes; route through `loadPdfjs()` instead.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * pdfjs-dist's Node build (`legacy/build/pdf.mjs`) references the browser globals
 * `DOMMatrix`, `ImageData`, and `Path2D` at module-evaluation time — e.g.
 * `const SCALE_MATRIX = new DOMMatrix()` runs the moment the module is imported.
 * Those globals don't exist in Node, so pdfjs ships a self-polyfill that pulls
 * them from its optional native dependency `@napi-rs/canvas`:
 *
 *   if (!globalThis.DOMMatrix) {
 *     if (canvas?.DOMMatrix) globalThis.DOMMatrix = canvas.DOMMatrix;
 *     else warn("Cannot polyfill `DOMMatrix`, rendering may be broken.");
 *   }
 *
 * On a dev Mac the platform-matched `@napi-rs/canvas` binary loads fine, so this
 * is invisible. In Vercel's Linux serverless runtime the native binary fails to
 * load ("Cannot load \"@napi-rs/canvas\" package"), the polyfill is skipped, and
 * the very next top-level `new DOMMatrix()` throws **at import time**:
 *
 *   [smart-parse] pdfjs failed ... DOMMatrix is not defined
 *
 * That single throw took out BOTH pdfjs code paths in prod:
 *   - `DigitalPdfProvider` (the fast/free digital text path + PB-6 positional
 *     table reconstruction) — the import threw, SmartParse fell back to heavy
 *     OCR for every digital PDF (oss-300).
 *   - `classifyDocument` — the import threw inside its try/catch, which returned
 *     `digital_pdf` by default, so image-only scans were misrouted to the
 *     (broken) pdfjs path instead of OCR (oss-301).
 *
 * ── The fix (part 1: DOMMatrix) ───────────────────────────────────────────────
 * Install pure-JS polyfills for the three globals *before* pdfjs is imported, so
 * pdfjs's `if (!globalThis.DOMMatrix)` checks short-circuit and it never needs
 * the native `@napi-rs/canvas` binary. We only ever call `getTextContent()` /
 * `getViewport()` — text extraction and pure-math transforms — never canvas
 * rendering, so a functional-but-minimal `DOMMatrix` plus inert `ImageData` /
 * `Path2D` stubs are sufficient. This is deterministic across platforms (Mac and
 * Linux behave identically) and avoids shipping a fragile ~50 MB native module
 * into a serverless function.
 *
 * ── The remaining bug (the worker) — oss-305 ──────────────────────────────────
 * Fixing DOMMatrix unblocked pdfjs's *import*, but pdfjs then failed at runtime
 * in the Vercel `/var/task` bundle with:
 *
 *   Setting up fake worker failed: "Cannot find module
 *   '/var/task/node_modules/.pnpm/pdfjs-dist@.../legacy/build/pdf.worker.mjs'
 *   imported from .../pdf.mjs"
 *
 * Why: in Node, pdfjs forces the "fake worker" (main-thread) path and sets
 * `GlobalWorkerOptions.workerSrc ||= "./pdf.worker.mjs"`. To actually run, it
 * lazily does `await import(this.workerSrc)` — a dynamic import whose specifier
 * is a *runtime variable*. Two things break in the serverless bundle:
 *   1. `@vercel/nft` (the file tracer that decides which files ship into
 *      `/var/task`) cannot statically see `import(this.workerSrc)`, so it never
 *      includes `pdf.worker.mjs` in the deployed function. (`pdfjs-dist` is
 *      marked `external` in platform/apps/api/build.mjs, so the worker would have
 *      to be traced from node_modules — and it isn't.)
 *   2. Even if shipped, that internal import is the only thing standing between
 *      us and a clean main-thread run.
 *
 * The text-extraction code we need actually *lives in the worker module*
 * (`WorkerMessageHandler` is the PDF engine); the "fake worker" just runs it on
 * the main thread via a LoopbackPort. So the worker module is genuinely required
 * — we can't drop it, we have to make it resolvable.
 *
 * pdfjs gives us an escape hatch: `_setupFakeWorkerGlobal` first checks
 * `globalThis.pdfjsWorker?.WorkerMessageHandler` and, if present, uses it
 * directly — skipping the untraceable `import(this.workerSrc)` entirely. So we:
 *   - import the worker ourselves with a **static string-literal specifier**
 *     (`pdfjs-dist/legacy/build/pdf.worker.mjs`). nft *can* trace this, so the
 *     file ships into `/var/task`; and esbuild keeps it external (matching the
 *     build's `pdfjs-dist/*` external rule) so it resolves from node_modules.
 *   - assign the module to `globalThis.pdfjsWorker` before pdfjs needs it.
 * pdfjs then runs main-thread with zero dynamic worker resolution.
 *
 * Ordering matters: the worker module also touches the browser globals at
 * evaluation time, so we install the DOMMatrix polyfills first, then import the
 * worker, then import `pdf.mjs` — all inside `loadPdfjs()`.
 *
 * (The worker entry has no upstream types — see pdfjs-worker.d.ts for the
 * ambient module declaration that lets us import it.)
 */

/**
 * Minimal pure-JS DOMMatrix. Stores the 2-D affine components `a..f` and
 * implements a real `multiply` (the only operation pdfjs touches outside the
 * canvas render paths, which we never enter). Everything else returns `this` so
 * chained calls don't blow up if a future code path reaches them.
 */
class DOMMatrixPolyfill {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  constructor(init?: number[] | string | DOMMatrixPolyfill) {
    if (Array.isArray(init)) {
      // DOMMatrix(array) accepts [a,b,c,d,e,f] (2-D) or a 16-element 3-D matrix.
      // Read defensively: leave the identity default for any missing slot.
      if (init.length >= 6) {
        this.a = init[0] ?? this.a;
        this.b = init[1] ?? this.b;
        this.c = init[2] ?? this.c;
        this.d = init[3] ?? this.d;
        this.e = init[4] ?? this.e;
        this.f = init[5] ?? this.f;
      } else if (init.length === 4) {
        this.a = init[0] ?? this.a;
        this.b = init[1] ?? this.b;
        this.c = init[2] ?? this.c;
        this.d = init[3] ?? this.d;
      }
    } else if (init && typeof init === "object") {
      this.a = init.a;
      this.b = init.b;
      this.c = init.c;
      this.d = init.d;
      this.e = init.e;
      this.f = init.f;
    }
    // String form (CSS transform syntax) is render-only; default to identity.
  }

  multiply(other: DOMMatrixPolyfill): DOMMatrixPolyfill {
    const r = new DOMMatrixPolyfill();
    r.a = this.a * other.a + this.c * other.b;
    r.b = this.b * other.a + this.d * other.b;
    r.c = this.a * other.c + this.c * other.d;
    r.d = this.b * other.c + this.d * other.d;
    r.e = this.a * other.e + this.c * other.f + this.e;
    r.f = this.b * other.e + this.d * other.f + this.f;
    return r;
  }

  multiplySelf(other: DOMMatrixPolyfill): DOMMatrixPolyfill {
    const r = this.multiply(other);
    Object.assign(this, r);
    return this;
  }

  translate(): DOMMatrixPolyfill {
    return this;
  }

  scale(): DOMMatrixPolyfill {
    return this;
  }

  invertSelf(): DOMMatrixPolyfill {
    return this;
  }

  setTransform(): DOMMatrixPolyfill {
    return this;
  }
}

/** Inert ImageData stub — only constructed inside canvas render paths we never enter. */
class ImageDataPolyfill {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  constructor(width = 0, height = 0) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(Math.max(0, width * height * 4));
  }
}

/** Inert Path2D stub — only constructed inside canvas render paths we never enter. */
class Path2DPolyfill {
  constructor(_path?: unknown) {}
  addPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  bezierCurveTo(): void {}
  quadraticCurveTo(): void {}
  closePath(): void {}
  rect(): void {}
  arc(): void {}
}

/**
 * Install the polyfills on `globalThis` if (and only if) the runtime doesn't
 * already provide them. Idempotent and side-effect-only.
 */
function installPdfjsGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.DOMMatrix === "undefined") g.DOMMatrix = DOMMatrixPolyfill;
  if (typeof g.ImageData === "undefined") g.ImageData = ImageDataPolyfill;
  if (typeof g.Path2D === "undefined") g.Path2D = Path2DPolyfill;
}

/**
 * Register the pdfjs worker module on `globalThis.pdfjsWorker` so pdfjs runs the
 * PDF engine on the main thread and never reaches its untraceable
 * `import(this.workerSrc)` (see the file header for the full rationale).
 *
 * The specifier is a static string literal precisely so `@vercel/nft` traces it
 * and ships `pdf.worker.mjs` into the serverless function. Must run AFTER
 * `installPdfjsGlobals()` — the worker module references the browser globals at
 * evaluation time. Idempotent: a runtime that already provides a worker handler
 * (or a repeat call) is left untouched.
 */
async function installPdfjsWorker(): Promise<void> {
  const g = globalThis as { pdfjsWorker?: { WorkerMessageHandler?: unknown } };
  if (g.pdfjsWorker?.WorkerMessageHandler) return;
  g.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
}

type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfjsPromise: Promise<PdfjsModule> | null = null;

/**
 * Load pdfjs with the serverless-safe globals + worker installed first. The
 * import is memoised so setup runs exactly once and the (relatively heavy)
 * module is parsed once per process.
 *
 * Order is load-bearing: DOMMatrix polyfills → worker registration → pdf.mjs.
 */
export function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      installPdfjsGlobals();
      await installPdfjsWorker();
      return import("pdfjs-dist/legacy/build/pdf.mjs");
    })();
  }
  return pdfjsPromise;
}

// Exported for unit tests only.
export const __test__ = {
  DOMMatrixPolyfill,
  ImageDataPolyfill,
  Path2DPolyfill,
  installPdfjsGlobals,
  installPdfjsWorker,
};
