// Ambient declaration for the pdfjs worker entry. pdfjs-dist ships no types for
// this path (its `exports` map is empty), so `import("pdfjs-dist/legacy/build/
// pdf.worker.mjs")` would otherwise be an implicit-any error. We only read
// `WorkerMessageHandler` off the module — see pdfjs-loader.ts (oss-305).
//
// This must live in its own ambient (no top-level import/export) .d.ts: an
// equivalent `declare module` inside the loader is treated as *augmentation* of
// an untyped module and rejected by TS (TS2665).
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
