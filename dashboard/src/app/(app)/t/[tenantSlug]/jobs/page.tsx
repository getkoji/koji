"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Play, Copy, Check } from "lucide-react";
import { ListLayout, Breadcrumbs, PageHeader } from "@/components/layouts";
import { EmptyState } from "@/components/shared/EmptyState";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { jobs as jobsApi, api, type JobRow } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import {
  JOB_STATUS_ORDER,
  normalizeJobStatus,
  type UiJobStatus,
} from "./status";
import {
  formatDuration,
  formatRelativeTime,
  successRate,
} from "./format";

type StatusFilter = "all" | UiJobStatus;
type DateRange = "today" | "7d" | "30d" | "all";

interface PipelineOption {
  id: string;
  slug: string;
  displayName: string;
}

const STATUS_OPTIONS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  ...JOB_STATUS_ORDER.map((s) => ({
    key: s,
    label: s.charAt(0).toUpperCase() + s.slice(1),
  })),
];

const DATE_OPTIONS: { key: DateRange; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "all", label: "All" },
];

export default function JobsPage() {
  const params = useParams<{ tenantSlug: string }>();
  const tenantSlug = params?.tenantSlug ?? "";

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [pipelineFilter, setPipelineFilter] = useState<string>("all");
  const [dateFilter, setDateFilter] = useState<DateRange>("7d");
  const [search, setSearch] = useState("");

  const apiStatus = statusFilter === "all" ? undefined : uiStatusToApi(statusFilter);

  const {
    data: jobs,
    loading,
    error,
    refetch,
  } = useApi(
    useCallback(
      () =>
        jobsApi.list({
          status: apiStatus,
          pipeline: pipelineFilter === "all" ? undefined : pipelineFilter,
          // Skip the query param when "all" is selected — the API treats the
          // absence of `since` as "no date filter," which is what we want.
          since: dateFilter === "all" ? undefined : dateFilter,
          limit: 100,
        }),
      [apiStatus, pipelineFilter, dateFilter],
    ),
  );

  const { data: pipelines } = useApi(
    useCallback(
      () =>
        api
          .get<{ data: PipelineOption[] }>("/api/pipelines")
          .then((r) => r.data.map((p) => ({ id: p.id, slug: p.slug, displayName: p.displayName }))),
      [],
    ),
  );

  // Poll every 5s if any job is running. The server holds the source of truth,
  // so we just refetch — no client-side tick simulation.
  const hasRunning = useMemo(
    () => (jobs ?? []).some((j) => normalizeJobStatus(j.status) === "running"),
    [jobs],
  );
  useEffect(() => {
    if (!hasRunning) return;
    const h = setInterval(refetch, 5000);
    return () => clearInterval(h);
  }, [hasRunning, refetch]);

  // Status + pipeline + date filtering happens server-side via the list()
  // query params. Only the free-text search still needs to run in the browser.
  const filtered = useMemo(() => {
    if (!search) return jobs ?? [];
    const needle = search.toLowerCase();
    return (jobs ?? []).filter((j) => j.slug.toLowerCase().includes(needle));
  }, [jobs, search]);

  const metrics = useMemo(() => {
    const all = jobs ?? [];
    const count = (s: UiJobStatus) =>
      all.filter((j) => normalizeJobStatus(j.status) === s).length;
    return {
      total: all.length,
      running: count("running"),
      succeeded: count("succeeded"),
      failed: count("failed"),
    };
  }, [jobs]);

  return (
    <ListLayout
      header={
        <>
          <Breadcrumbs
            items={[
              { label: tenantSlug, href: `/t/${tenantSlug}` },
              { label: "Jobs" },
            ]}
          />
          <PageHeader title="Jobs" />
        </>
      }
      metricsStrip={<MetricsStrip metrics={metrics} />}
      filterBar={
        <FilterBar
          status={statusFilter}
          onStatus={setStatusFilter}
          pipeline={pipelineFilter}
          onPipeline={setPipelineFilter}
          pipelineOptions={pipelines ?? []}
          date={dateFilter}
          onDate={setDateFilter}
          search={search}
          onSearch={setSearch}
          total={filtered.length}
        />
      }
    >
      {error ? (
        <EmptyState
          title="Cannot reach API"
          description={`${error.message}. Start the server with: pnpm --filter @koji/api dev`}
          action={
            <button
              onClick={refetch}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-cream text-ink border border-border-strong hover:border-ink transition-colors"
            >
              Retry
            </button>
          }
        />
      ) : loading && !jobs ? (
        <TableSkeleton columns={8} rows={6} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Play className="w-8 h-8" />}
          title={statusFilter === "all" && search === "" ? "No jobs yet" : "No matching jobs"}
          description={
            statusFilter === "all" && search === ""
              ? "Jobs appear here as pipelines process documents."
              : "Try clearing filters to see more results."
          }
          action={
            statusFilter === "all" && search === "" ? undefined : (
              <button
                onClick={() => {
                  setStatusFilter("all");
                  setPipelineFilter("all");
                  setDateFilter("all");
                  setSearch("");
                }}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-cream text-ink border border-border-strong hover:border-ink transition-colors"
              >
                Clear filters
              </button>
            )
          }
        />
      ) : (
        <JobsDataGrid jobs={filtered} tenantSlug={tenantSlug} />
      )}
    </ListLayout>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Metrics strip

function MetricsStrip({
  metrics,
}: {
  metrics: { total: number; running: number; succeeded: number; failed: number };
}) {
  return (
    <div className="grid grid-cols-4 gap-4 border border-border rounded-sm bg-cream overflow-hidden">
      <Metric label="Total jobs" value={metrics.total.toString()} />
      <Metric
        label="Running"
        value={metrics.running.toString()}
        tone={metrics.running > 0 ? "running" : "neutral"}
      />
      <Metric label="Succeeded" value={metrics.succeeded.toString()} tone="success" />
      <Metric
        label="Failed"
        value={metrics.failed.toString()}
        tone={metrics.failed > 0 ? "fail" : "neutral"}
      />
    </div>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "running" | "success" | "fail";
}) {
  const valueColor =
    tone === "success"
      ? "text-green"
      : tone === "fail"
      ? "text-vermillion-2"
      : tone === "running"
      ? "text-[#2B6A9E]"
      : "text-ink";
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
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Filter bar

function FilterBar({
  status,
  onStatus,
  pipeline,
  onPipeline,
  pipelineOptions,
  date,
  onDate,
  search,
  onSearch,
  total,
}: {
  status: StatusFilter;
  onStatus: (s: StatusFilter) => void;
  pipeline: string;
  onPipeline: (p: string) => void;
  pipelineOptions: PipelineOption[];
  date: DateRange;
  onDate: (d: DateRange) => void;
  search: string;
  onSearch: (s: string) => void;
  total: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-0.5">
        {STATUS_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            onClick={() => onStatus(opt.key)}
            className={`font-mono text-[10px] px-2.5 py-1 rounded-sm transition-colors ${
              status === opt.key
                ? "bg-ink text-cream"
                : "text-ink-3 hover:bg-cream-2 hover:text-ink"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <span className="w-px h-4 bg-border" />

      <select
        value={pipeline}
        onChange={(e) => onPipeline(e.target.value)}
        className="font-mono text-[11px] bg-cream-2 border border-border rounded-sm px-2 py-1 text-ink-2 hover:bg-cream-3 transition-colors focus:outline-none focus:border-ink"
      >
        <option value="all">all pipelines</option>
        {pipelineOptions.map((p) => (
          <option key={p.id} value={p.slug}>
            {p.displayName}
          </option>
        ))}
      </select>

      <div className="flex items-center gap-0.5">
        {DATE_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            onClick={() => onDate(opt.key)}
            className={`font-mono text-[10px] px-2 py-1 rounded-sm transition-colors ${
              date === opt.key
                ? "bg-cream-3 text-ink"
                : "text-ink-4 hover:bg-cream-2 hover:text-ink-2"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-1.5 bg-cream-2 border border-border rounded-sm px-2 py-1 focus-within:border-vermillion-2 focus-within:bg-cream transition-colors">
        <span className="font-mono text-[11px] text-vermillion-2 font-medium">⌕</span>
        <input
          type="text"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="search by job ID"
          className="font-mono text-[11px] bg-transparent outline-none placeholder:text-ink-4 w-[200px]"
        />
      </div>

      <span className="font-mono text-[10px] text-ink-4">
        {total} {total === 1 ? "job" : "jobs"}
      </span>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// DataGrid

function JobsDataGrid({ jobs, tenantSlug }: { jobs: JobRow[]; tenantSlug: string }) {
  return (
    <div className="border border-border rounded-sm overflow-hidden bg-cream">
      <div className="grid grid-cols-[220px_minmax(140px,1fr)_96px_80px_1fr_72px_92px_96px] gap-3 px-4 py-2 border-b border-border bg-cream-2/50">
        <ColHead>Job ID</ColHead>
        <ColHead>Pipeline</ColHead>
        <ColHead>Status</ColHead>
        <ColHead className="text-right">Documents</ColHead>
        <ColHead>Progress</ColHead>
        <ColHead className="text-right">Rate</ColHead>
        <ColHead className="text-right">Duration</ColHead>
        <ColHead className="text-right">Created</ColHead>
      </div>
      {jobs.map((job) => (
        <JobRowItem key={job.slug} job={job} tenantSlug={tenantSlug} />
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

function JobRowItem({ job, tenantSlug }: { job: JobRow; tenantSlug: string }) {
  const rate = successRate(job);
  const uiStatus = normalizeJobStatus(job.status);
  const durationMs =
    job.startedAt && job.completedAt
      ? new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime()
      : null;
  return (
    <Link
      href={`/t/${tenantSlug}/jobs/${job.slug}`}
      className="grid grid-cols-[220px_minmax(140px,1fr)_96px_80px_1fr_72px_92px_96px] gap-3 px-4 py-2.5 border-b border-dotted border-border last:border-b-0 hover:bg-cream-2/60 transition-colors items-center"
    >
      <JobIdCell jobId={job.slug} />
      <span className="text-[12.5px] text-ink truncate">
        {job.pipelineName ?? <span className="text-ink-4 italic">unknown</span>}
      </span>
      <StatusBadge status={uiStatus} />
      <span className="text-right font-mono text-[11px] text-ink-2">
        {job.docsTotal} <span className="text-ink-4">docs</span>
      </span>
      <ProgressBar job={job} uiStatus={uiStatus} />
      <span className={`text-right font-mono text-[11px] ${rateColor(rate)}`}>
        {rate === null ? "—" : `${(rate * 100).toFixed(1)}%`}
      </span>
      <span className="text-right font-mono text-[11px] text-ink-3">
        {uiStatus === "running" ? (
          <LiveDuration startedAt={job.startedAt} />
        ) : (
          formatDuration(durationMs)
        )}
      </span>
      <span className="text-right font-mono text-[10px] text-ink-4">
        {formatRelativeTime(job.createdAt)}
      </span>
    </Link>
  );
}

function rateColor(rate: number | null): string {
  if (rate === null) return "text-ink-4";
  if (rate >= 0.99) return "text-green";
  if (rate >= 0.9) return "text-ink-2";
  return "text-vermillion-2";
}

function JobIdCell({ jobId }: { jobId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <code className="font-mono text-[11px] text-ink truncate">{jobId}</code>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          navigator.clipboard?.writeText(jobId);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
        className="shrink-0 text-ink-4 hover:text-ink transition-colors p-0.5"
        aria-label="Copy job ID"
      >
        {copied ? <Check className="w-3 h-3 text-green" /> : <Copy className="w-3 h-3" />}
      </button>
    </div>
  );
}

function StatusBadge({ status }: { status: UiJobStatus }) {
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1.5 font-mono text-[10px] font-medium tracking-[0.08em] uppercase text-[#2B6A9E]">
        <span className="relative flex w-1.5 h-1.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-[#2B6A9E] opacity-60 animate-ping" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-[#2B6A9E]" />
        </span>
        running
      </span>
    );
  }
  const styles: Record<Exclude<UiJobStatus, "running">, string> = {
    succeeded: "bg-green/[0.12] text-green",
    failed: "bg-vermillion-3 text-vermillion-2",
    cancelled: "bg-cream-2 text-ink-4",
  };
  return (
    <span
      className={`inline-flex items-center font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm uppercase tracking-[0.08em] ${styles[status]}`}
    >
      {status}
    </span>
  );
}

function ProgressBar({ job, uiStatus }: { job: JobRow; uiStatus: UiJobStatus }) {
  const pct = job.docsTotal === 0 ? 0 : (job.docsProcessed / job.docsTotal) * 100;
  const failedPct = job.docsTotal === 0 ? 0 : (job.docsFailed / job.docsTotal) * 100;

  let fillColor = "bg-green";
  if (uiStatus === "running") fillColor = "bg-[#2B6A9E]";
  else if (uiStatus === "failed") fillColor = "bg-vermillion-2";
  else if (uiStatus === "cancelled") fillColor = "bg-cream-4";

  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="flex-1 h-1.5 bg-cream-2 rounded-full overflow-hidden relative min-w-[40px]">
        <div
          className={`h-full ${fillColor} transition-[width] duration-500 ease-out ${
            uiStatus === "running" ? "animate-pulse" : ""
          }`}
          style={{ width: `${pct}%` }}
        />
        {failedPct > 0 && (
          <div
            className="h-full bg-vermillion-2 absolute top-0 right-0"
            style={{ width: `${failedPct}%` }}
          />
        )}
      </div>
      <span className="shrink-0 font-mono text-[10px] text-ink-3 tabular-nums">
        {job.docsProcessed}/{job.docsTotal}
      </span>
    </div>
  );
}

function LiveDuration({ startedAt }: { startedAt: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, []);
  if (!startedAt) return <>—</>;
  const ms = now - new Date(startedAt).getTime();
  return <>running for {formatDuration(ms)}</>;
}

// ──────────────────────────────────────────────────────────────────────
// Helpers

function uiStatusToApi(ui: UiJobStatus): string {
  // API uses "complete" + "canceled" while the UI uses the past-tense equivalents.
  switch (ui) {
    case "succeeded":
      return "complete";
    case "cancelled":
      return "canceled";
    default:
      return ui;
  }
}

