"use client";

interface StageTimelineProps {
  stages: Array<{
    id: string;
    stageName: string;
    stageOrder: number;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    summaryJson: Record<string, unknown> | null;
    errorMessage: string | null;
  }>;
  documentStatus: string;
}

export function StageTimeline({ stages, documentStatus }: StageTimelineProps) {
  const sorted = [...stages].sort((a, b) => a.stageOrder - b.stageOrder);
  const isExtracting = documentStatus === "extracting";

  return (
    <div className={`flex flex-col gap-0 ${isExtracting ? "animate-pulse" : ""}`}>
      {sorted.map((stage, i) => {
        const isLast = i === sorted.length - 1;
        const icon = statusIcon(stage.status);
        const iconColor = statusColor(stage.status);
        const duration = formatDuration(stage.durationMs);
        const summary = extractStageSummary(stage.stageName, stage.summaryJson);

        return (
          <div key={stage.id} className="flex gap-2.5 min-h-[28px]">
            {/* Vertical line + icon */}
            <div className="flex flex-col items-center w-4 shrink-0">
              <span className={`text-[12px] leading-none ${iconColor}`}>{icon}</span>
              {!isLast && (
                <div className="w-px flex-1 bg-border mt-0.5" />
              )}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0 pb-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-[12px] font-medium text-ink truncate">
                  {stage.stageName}
                </span>
                {duration && (
                  <span className="font-mono text-[11px] text-ink-4 tabular-nums shrink-0">
                    {duration}
                  </span>
                )}
              </div>
              {summary && (
                <div className="font-mono text-[11px] text-ink-3 truncate mt-0.5">
                  {summary}
                </div>
              )}
              {stage.errorMessage && (
                <div className="font-mono text-[11px] text-vermillion-2 mt-0.5 leading-[1.4]">
                  {stage.errorMessage}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function statusIcon(status: string): string {
  switch (status) {
    case "ok":
    case "completed":
      return "\u2713";
    case "fail":
    case "failed":
    case "error":
      return "\u2717";
    case "in_flight":
    case "running":
      return "\u25CB";
    default:
      return "\u25CB";
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "ok":
    case "completed":
      return "text-green";
    case "fail":
    case "failed":
    case "error":
      return "text-vermillion-2";
    case "in_flight":
    case "running":
      return "text-ink-3 animate-spin";
    default:
      return "text-ink-4";
  }
}

function formatDuration(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function extractStageSummary(
  stageName: string,
  summaryJson: Record<string, unknown> | null,
): string | null {
  if (!summaryJson) return null;

  const name = stageName.toLowerCase();

  if (name === "parse" || name.includes("parse")) {
    const pages = summaryJson.pages ?? summaryJson.pageCount ?? summaryJson.page_count;
    if (typeof pages === "number") return `${pages} page${pages !== 1 ? "s" : ""}`;
  }

  if (name === "extract" || name.includes("extract")) {
    const fields = summaryJson.fields ?? summaryJson.fieldCount ?? summaryJson.field_count;
    if (typeof fields === "number") return `${fields} field${fields !== 1 ? "s" : ""}`;
    if (fields && typeof fields === "object") {
      const count = Object.keys(fields).length;
      return `${count} field${count !== 1 ? "s" : ""}`;
    }
  }

  if (name === "deliver" || name.includes("deliver") || name.includes("webhook")) {
    const webhooks = summaryJson.webhooks ?? summaryJson.targets ?? summaryJson.deliveries;
    if (typeof webhooks === "number") return `${webhooks} webhook${webhooks !== 1 ? "s" : ""}`;
  }

  if (name.includes("classify")) {
    const label = summaryJson.label;
    if (typeof label === "string") return label;
  }

  if (name.includes("split")) {
    const groups = summaryJson.groups ?? summaryJson.sections;
    if (typeof groups === "number") return `${groups} section${groups !== 1 ? "s" : ""}`;
    if (Array.isArray(groups)) return `${groups.length} section${groups.length !== 1 ? "s" : ""}`;
  }

  // Fallback: grab first string or number value
  for (const val of Object.values(summaryJson)) {
    if (typeof val === "string" && val.length < 50) return val;
    if (typeof val === "number") return String(val);
  }

  return null;
}
