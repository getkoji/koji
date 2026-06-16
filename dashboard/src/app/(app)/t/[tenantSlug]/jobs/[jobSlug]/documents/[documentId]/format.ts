/**
 * Pure formatters used by the trace-view page. Extracted from page.tsx
 * so they can be unit-tested without spinning up React / jsdom — the
 * dashboard vitest config restricts test imports to non-component
 * modules.
 */

export const STAGE_LABELS: Record<string, string> = {
  ingress: "Ingress",
  integrity: "Integrity check",
  ocr_quality: "OCR quality",
  parse: "Parse",
  classify: "Classify",
  extract: "Extract",
  normalize: "Normalize",
  validate: "Validate",
  review: "Review queue",
  hitl_router: "Review queue",
  human_review: "Human review",
  emit: "Emit",
  deliver: "Deliver",
};

/**
 * Map a raw stage name to its human-readable label.
 *
 * Defensive backstop: a missing or non-string `name` MUST NOT crash the
 * whole trace page. The SSE handler is supposed to send the full
 * TraceStageRow shape (see `api/src/routes/jobs.ts` :: GET
 * /api/jobs/:slug/documents/:docId/stream), and the initial document
 * payload always does. But if a future server change forgets the
 * `stageName` field again — or any other field a renderer dereferences
 * — render a visible "unknown stage" placeholder instead of unmounting
 * the whole React tree with `TypeError: Cannot read properties of
 * undefined (reading 'replaceAll')`.
 *
 * Production was hitting that exact crash whenever the SSE stream
 * pushed a stage update: the server was emitting `{ name, status,
 * durationMs, summary }` while the client expected the full
 * TraceStageRow shape (`stageName`, `summaryJson`, …). The contract
 * mismatch made `r.stageName` undefined, then `.replaceAll` blew up
 * inside the `useMemo` that builds `stages`. The user saw "This page
 * couldn't load" on every job page that received an SSE push.
 */
export function prettyStageName(
  name: string | null | undefined,
): string {
  if (typeof name !== "string" || name.length === 0) {
    return "unknown stage";
  }
  return STAGE_LABELS[name] ?? name.replaceAll("_", " ");
}
