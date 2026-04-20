/**
 * Shared formatting + presentation helpers for the Review surface.
 *
 * Structural UI config (label maps, thresholds) — not display data.
 * Actual rows/records come from the /api/review endpoints.
 */

export const urgentThreshold = 0.7;

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

const REASON_LABELS: Record<string, string> = {
  low_confidence: "low confidence",
  mandatory_field_review: "mandatory review",
  sampling: "sampling",
  validation_failed: "validation failed",
  conflicting_values: "conflicting values",
  ambiguous_format: "ambiguous format",
  manual_flag: "manual flag",
};

export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason.replaceAll("_", " ");
}

export function reasonTone(reason: string): "warn" | "fail" | "neutral" {
  switch (reason) {
    case "validation_failed":
    case "conflicting_values":
      return "fail";
    case "low_confidence":
    case "ambiguous_format":
    case "manual_flag":
      return "warn";
    case "mandatory_field_review":
    case "sampling":
    default:
      return "neutral";
  }
}
