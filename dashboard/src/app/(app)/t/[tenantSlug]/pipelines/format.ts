export function statusTone(
  status: string,
): "success" | "warn" | "fail" | "neutral" {
  switch (status) {
    case "active":
      return "success";
    case "paused":
      return "neutral";
    case "errored":
    case "failed":
      return "fail";
    default:
      return "warn";
  }
}

export function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return "never";
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

export function formatAbsoluteTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
