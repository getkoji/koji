"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CheckCheck } from "lucide-react";
import { ListLayout, Breadcrumbs, PageHeader } from "@/components/layouts";
import { EmptyState } from "@/components/shared/EmptyState";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { review as reviewApi, type ReviewRow } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { reasonLabel, reasonTone, formatRelativeTime, urgentThreshold } from "./format";

type StatusFilter = "pending" | "completed" | "all";

const STATUS_OPTIONS: { key: StatusFilter; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "completed", label: "Completed" },
  { key: "all", label: "All" },
];

export default function ReviewPage() {
  const params = useParams<{ tenantSlug: string }>();
  const tenantSlug = params?.tenantSlug ?? "";
  const [status, setStatus] = useState<StatusFilter>("pending");

  const { data: items, loading, error } = useApi(
    useCallback(() => {
      if (status === "all") {
        return Promise.all([
          reviewApi.list({ status: "pending" }),
          reviewApi.list({ status: "completed" }),
        ]).then(([pending, completed]) => [...pending, ...completed]);
      }
      return reviewApi.list({ status });
    }, [status]),
  );

  // Captured on mount so render is pure. Refreshes on remount (e.g. route change).
  const [todayCutoff] = useState(() => Date.now() - 24 * 60 * 60 * 1000);
  const metrics = useMemo(() => {
    const rows = items ?? [];
    const pending = rows.filter((r) => r.status === "pending");
    const urgent = pending.filter(
      (r) => r.confidence !== null && Number(r.confidence) < urgentThreshold,
    );
    const reviewedToday = rows.filter(
      (r) => r.resolvedAt !== null && new Date(r.resolvedAt).getTime() >= todayCutoff,
    );
    return {
      pending: pending.length,
      urgent: urgent.length,
      reviewedToday: reviewedToday.length,
    };
  }, [items, todayCutoff]);

  return (
    <ListLayout
      header={
        <>
          <Breadcrumbs
            items={[
              { label: tenantSlug, href: `/t/${tenantSlug}` },
              { label: "Review" },
            ]}
          />
          <PageHeader
            title="Review queue"
            meta={
              <span>
                Documents flagged for human review — low confidence, validation failures, or
                mandatory checks
              </span>
            }
          />
        </>
      }
      metricsStrip={<MetricsStrip metrics={metrics} />}
      filterBar={
        <div className="flex items-center gap-2">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setStatus(opt.key)}
              className={`font-mono text-[10px] px-2.5 py-1 rounded-sm transition-colors ${
                status === opt.key
                  ? "bg-ink text-cream"
                  : "text-ink-3 hover:bg-cream-2 hover:text-ink"
              }`}
            >
              {opt.label}
            </button>
          ))}
          <span className="flex-1" />
          <span className="font-mono text-[10px] text-ink-4">
            {(items ?? []).length} {(items ?? []).length === 1 ? "item" : "items"}
          </span>
        </div>
      }
    >
      {error ? (
        <EmptyState
          title="Cannot reach API"
          description={`${error.message}. Start the server with: pnpm --filter @koji/api dev`}
        />
      ) : loading && !items ? (
        <TableSkeleton columns={6} rows={5} />
      ) : (items ?? []).length === 0 ? (
        status === "pending" ? (
          <EmptyState
            icon={<CheckCheck className="w-8 h-8" />}
            title="Review queue is clear"
            description="Documents that need human review will appear here when the pipeline flags low-confidence extractions."
          />
        ) : (
          <EmptyState
            title="No items in this filter"
            description="Switch to Pending to see active work."
          />
        )
      ) : (
        <QueueGrid items={items!} tenantSlug={tenantSlug} />
      )}
    </ListLayout>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Metrics strip

function MetricsStrip({
  metrics,
}: {
  metrics: { pending: number; urgent: number; reviewedToday: number };
}) {
  return (
    <div className="grid grid-cols-3 gap-4 border border-border rounded-sm bg-cream overflow-hidden">
      <Metric label="In queue" value={metrics.pending.toString()} />
      <Metric
        label="Urgent"
        value={metrics.urgent.toString()}
        tone={metrics.urgent > 0 ? "warn" : "neutral"}
        sub={`confidence < ${urgentThreshold}`}
      />
      <Metric
        label="Reviewed today"
        value={metrics.reviewedToday.toString()}
        tone="neutral"
      />
    </div>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
  sub,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "warn";
  sub?: string;
}) {
  const valueColor = tone === "warn" ? "text-[#B6861A]" : "text-ink";
  return (
    <div className="flex flex-col gap-1 px-5 py-3 border-r border-border last:border-r-0">
      <span className="font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase text-ink-4">
        {label}
      </span>
      <span
        className={`font-display text-[26px] font-medium leading-none tracking-tight ${valueColor}`}
      >
        {value}
      </span>
      {sub && <span className="font-mono text-[10px] text-ink-4">{sub}</span>}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Queue grid

function QueueGrid({ items, tenantSlug }: { items: ReviewRow[]; tenantSlug: string }) {
  return (
    <div className="border border-border rounded-sm overflow-hidden bg-cream">
      <div className="grid grid-cols-[minmax(240px,1.8fr)_160px_160px_1fr_80px_88px] gap-3 px-4 py-2 border-b border-border bg-cream-2/50">
        <ColHead>Document</ColHead>
        <ColHead>Field</ColHead>
        <ColHead>Reason</ColHead>
        <ColHead>Confidence</ColHead>
        <ColHead className="text-right">Age</ColHead>
        <ColHead className="text-right">Status</ColHead>
      </div>
      {items.map((item) => (
        <QueueRow key={item.id} item={item} tenantSlug={tenantSlug} />
      ))}
    </div>
  );
}

function ColHead({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4 ${className}`}
    >
      {children}
    </span>
  );
}

function QueueRow({ item, tenantSlug }: { item: ReviewRow; tenantSlug: string }) {
  const confidence = item.confidence === null ? null : Number(item.confidence);
  const isUrgent = confidence !== null && confidence < urgentThreshold;
  const isCompleted = item.status === "completed";

  const rowTone = isCompleted
    ? "opacity-70 hover:opacity-100 hover:bg-cream-2/60"
    : isUrgent
    ? "bg-[#B6861A]/[0.06] hover:bg-[#B6861A]/[0.12]"
    : "hover:bg-cream-2/60";

  return (
    <Link
      href={`/t/${tenantSlug}/review/${item.id}`}
      className={`grid grid-cols-[minmax(240px,1.8fr)_160px_160px_1fr_80px_88px] gap-3 px-4 py-2.5 border-b border-dotted border-border last:border-b-0 transition-colors items-center ${rowTone}`}
    >
      <div className="flex flex-col min-w-0 gap-0.5">
        <span className="text-[12.5px] text-ink truncate">
          {item.documentFilename ?? <span className="text-ink-4 italic">unknown</span>}
        </span>
        <span className="font-mono text-[10px] text-ink-4 truncate">
          {item.pipelineName ?? "—"}
          {item.schemaName && (
            <>
              <span className="text-cream-4"> · </span>
              {item.schemaName}
            </>
          )}
        </span>
      </div>
      <code className="font-mono text-[11.5px] text-vermillion-2 truncate">{item.fieldName}</code>
      <ReasonBadge reason={item.reason} />
      <ConfidenceBar confidence={confidence} />
      <span className="text-right font-mono text-[10px] text-ink-4">
        {isCompleted
          ? formatRelativeTime(item.resolvedAt)
          : formatRelativeTime(item.createdAt)}
      </span>
      <ResolutionBadge status={item.status} resolution={item.resolution} />
    </Link>
  );
}

function ReasonBadge({ reason }: { reason: string }) {
  const tone = reasonTone(reason);
  const label = reasonLabel(reason);
  const styles =
    tone === "warn"
      ? "bg-[#B6861A]/[0.14] text-[#B6861A]"
      : tone === "fail"
      ? "bg-vermillion-3 text-vermillion-2"
      : "bg-cream-2 text-ink-3";
  return (
    <span
      className={`inline-flex items-center font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm uppercase tracking-[0.08em] w-fit ${styles}`}
    >
      {label}
    </span>
  );
}

function ConfidenceBar({ confidence }: { confidence: number | null }) {
  if (confidence === null) {
    return <span className="font-mono text-[10px] text-ink-4">—</span>;
  }
  const pct = Math.min(1, Math.max(0, confidence)) * 100;
  const color = confidence < urgentThreshold ? "bg-[#B6861A]" : confidence < 0.9 ? "bg-ink-3" : "bg-green";

  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="flex-1 h-1.5 bg-cream-2 rounded-full overflow-hidden min-w-[40px]">
        <div
          className={`h-full ${color} transition-[width] duration-300`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="shrink-0 font-mono text-[10px] text-ink-3 tabular-nums">
        {confidence.toFixed(2)}
      </span>
    </div>
  );
}

function ResolutionBadge({
  status,
  resolution,
}: {
  status: string;
  resolution: string | null;
}) {
  if (status === "pending") {
    return (
      <span className="inline-flex items-center justify-end font-mono text-[10px] text-ink-4">
        pending
      </span>
    );
  }
  if (resolution === "approved") {
    return (
      <span className="inline-flex items-center justify-end font-mono text-[10px] font-medium text-green uppercase tracking-[0.08em]">
        approved
      </span>
    );
  }
  if (resolution === "rejected") {
    return (
      <span className="inline-flex items-center justify-end font-mono text-[10px] font-medium text-vermillion-2 uppercase tracking-[0.08em]">
        rejected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-end font-mono text-[10px] text-ink-4 uppercase tracking-[0.08em]">
      {status}
    </span>
  );
}
