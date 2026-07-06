/**
 * Coerce a user-typed correction back to the JSON shape of the value it
 * replaces — if the original was a number, parse the input as a number; if
 * it was an object/array, parse as JSON; otherwise keep the string.
 *
 * Shared by the review queue's override flow and the document detail's
 * correct-field flow so the two can't drift.
 */
export function parseOverride(raw: string, original: unknown): unknown {
  const trimmed = raw.trim();
  if (typeof original === "number") {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : trimmed;
  }
  if (original !== null && typeof original === "object") {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}
