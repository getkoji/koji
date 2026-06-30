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
 * ── The fix ───────────────────────────────────────────────────────────────────
 * Install pure-JS polyfills for the three globals *before* pdfjs is imported, so
 * pdfjs's `if (!globalThis.DOMMatrix)` checks short-circuit and it never needs
 * the native `@napi-rs/canvas` binary. We only ever call `getTextContent()` /
 * `getViewport()` — text extraction and pure-math transforms — never canvas
 * rendering, so a functional-but-minimal `DOMMatrix` plus inert `ImageData` /
 * `Path2D` stubs are sufficient. This is deterministic across platforms (Mac and
 * Linux behave identically) and avoids shipping a fragile ~50 MB native module
 * into a serverless function.
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

type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfjsPromise: Promise<PdfjsModule> | null = null;

/**
 * Load pdfjs with the serverless-safe globals installed first. The import is
 * memoised so the polyfills are installed exactly once and the (relatively
 * heavy) module is parsed once per process.
 */
export function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    installPdfjsGlobals();
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfjsPromise;
}

// Exported for unit tests only.
export const __test__ = {
  DOMMatrixPolyfill,
  ImageDataPolyfill,
  Path2DPolyfill,
  installPdfjsGlobals,
};
