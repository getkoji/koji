import { describe, it, expect } from "vitest";
import { loadPdfjs, __test__ } from "./pdfjs-loader";

const { DOMMatrixPolyfill, ImageDataPolyfill, Path2DPolyfill, installPdfjsGlobals, installPdfjsWorker } =
  __test__;

describe("pdfjs-loader polyfills", () => {
  it("DOMMatrixPolyfill defaults to identity", () => {
    const m = new DOMMatrixPolyfill();
    expect([m.a, m.b, m.c, m.d, m.e, m.f]).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("DOMMatrixPolyfill constructs from a 6-element array", () => {
    const m = new DOMMatrixPolyfill([2, 0, 0, 3, 10, 20]);
    expect([m.a, m.b, m.c, m.d, m.e, m.f]).toEqual([2, 0, 0, 3, 10, 20]);
  });

  it("DOMMatrixPolyfill multiply composes affine transforms correctly", () => {
    // scale(2,3) then translate via second matrix's e/f
    const scale = new DOMMatrixPolyfill([2, 0, 0, 3, 0, 0]);
    const translate = new DOMMatrixPolyfill([1, 0, 0, 1, 5, 7]);
    const r = scale.multiply(translate);
    // scaling applies to the translation components
    expect([r.a, r.b, r.c, r.d, r.e, r.f]).toEqual([2, 0, 0, 3, 10, 21]);
  });

  it("ImageDataPolyfill allocates an RGBA buffer", () => {
    const img = new ImageDataPolyfill(2, 3);
    expect(img.width).toBe(2);
    expect(img.height).toBe(3);
    expect(img.data.length).toBe(2 * 3 * 4);
  });

  it("Path2DPolyfill is constructible and inert", () => {
    const p = new Path2DPolyfill();
    expect(() => {
      p.moveTo();
      p.lineTo();
      p.closePath();
    }).not.toThrow();
  });

  it("installPdfjsGlobals makes the three globals available", () => {
    installPdfjsGlobals();
    expect(typeof (globalThis as Record<string, unknown>).DOMMatrix).toBe("function");
    expect(typeof (globalThis as Record<string, unknown>).ImageData).toBe("function");
    expect(typeof (globalThis as Record<string, unknown>).Path2D).toBe("function");
  });

  it("installPdfjsWorker registers a main-thread WorkerMessageHandler on globalThis", async () => {
    // Regression for oss-305: without globalThis.pdfjsWorker, pdfjs in Node does
    // `await import(this.workerSrc)` to spin up its "fake worker". That dynamic
    // import is untraceable by @vercel/nft, so pdf.worker.mjs never ships into
    // /var/task and the runtime dies with `Setting up fake worker failed:
    // "Cannot find module .../pdf.worker.mjs"`. Registering the handler here
    // makes pdfjs use the main-thread path and skip that import entirely.
    await installPdfjsWorker();
    const g = globalThis as { pdfjsWorker?: { WorkerMessageHandler?: unknown } };
    expect(g.pdfjsWorker).toBeDefined();
    expect(typeof g.pdfjsWorker?.WorkerMessageHandler).toBe("function");
  });

  it("loadPdfjs registers the worker before pdf.mjs is loaded", async () => {
    await loadPdfjs();
    // After loadPdfjs, the worker handler must be present so pdfjs's
    // _setupFakeWorkerGlobal short-circuits on globalThis.pdfjsWorker instead of
    // importing the worker module by (runtime-variable) path.
    const g = globalThis as { pdfjsWorker?: { WorkerMessageHandler?: unknown } };
    expect(typeof g.pdfjsWorker?.WorkerMessageHandler).toBe("function");
  });

  it("loadPdfjs imports pdfjs without throwing and exposes getDocument", async () => {
    // The import is the real regression surface for oss-300: pdfjs's top-level
    // `new DOMMatrix()` runs during module evaluation. loadPdfjs must have the
    // globals installed before this point.
    const pdfjs = await loadPdfjs();
    expect(typeof pdfjs.getDocument).toBe("function");
  });

  it("loadPdfjs memoises the module", async () => {
    const a = await loadPdfjs();
    const b = await loadPdfjs();
    expect(a).toBe(b);
  });
});
