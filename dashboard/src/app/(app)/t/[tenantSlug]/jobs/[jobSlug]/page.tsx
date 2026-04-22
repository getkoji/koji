"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ChevronRight, Copy, Check } from "lucide-react";
import { ListLayout, Breadcrumbs } from "@/components/layouts";
import { EmptyState } from "@/components/shared/EmptyState";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import {
  jobs as jobsApi,
  type JobDetail,
  type JobDocument,
} from "@/lib/api";
import { useApi } from "@/lib/use-api";
import {
  normalizeJobStatus,
  normalizeDocStatus,
  type UiJobStatus,
  type UiDocStatus,
} from "../status";
import {
  formatDuration,
  formatRelativeTime,
  formatAbsoluteTime,
  successRate,
} from "../format";

type DocStatusFilter = "all" | UiDocStatus | "running";
type DocSort = "status" | "confidence" | "filename";

export default function JobDetailPage() {
  const params = useParams<{ tenantSlug: string; jobSlug: string }>();
  const tenantSlug = params?.tenantSlug ?? "";
  const jobSlug = params?.jobSlug ?? "";

  const [docFilter, setDocFilter] = useState<DocStatusFilter>("all");
  const [docSort, setDocSort] = useState<DocSort>("status");

  const {
    data: job,
    loading: jobLoading,
    error: jobError,
    refetch: refetchJob,
  } = useApi(useCallback(() => jobsApi.get(jobSlug), [jobSlug]));

  const {
    data: documents,
    loading: docsLoading,
    refetch: refetchDocs,
  } = useApi(useCallback(() => jobsApi.documents(jobSlug), [jobSlug]));

  const uiStatus = job ? normalizeJobStatus(job.status) : null;
  const isRunning = uiStatus === "running";

  // Poll every 3s while running; stop on terminal state.
  useEffect(() => {
    if (!isRunning) return;
    const h = setInterval(() => {
      refetchJob();
      refetchDocs();
    }, 3000);
    return () => clearInterval(h);
  }, [isRunning, refetchJob, refetchDocs]);

  const sortedDocs = useMemo(
    () => (documents ? sortDocs(filterDocs(documents, docFilter), docSort) : []),
    [documents, docFilter, docSort],
  );

  if (jobError) {
    return (
      <ListLayout
        header={
          <>
            <Breadcrumbs
              items={[
                { label: tenantSlug, href: `/t/${tenantSlug}` },
                { label: "Jobs", href: `/t/${tenantSlug}/jobs` },
                { label: jobSlug },
              ]}
            />
          </>
        }
      >
        <EmptyState
          title={jobError.message.includes("not found") ? "Job not found" : "Cannot reach API"}
          description={jobError.message}
        />
      </ListLayout>
    );
  }

  if (!job || jobLoading) {
    return (
      <ListLayout
        header={
          <>
            <Breadcrumbs
              items={[
                { label: tenantSlug, href: `/t/${tenantSlug}` },
                { label: "Jobs", href: `/t/${tenantSlug}/jobs` },
                { label: jobSlug },
              ]}
            />
          </>
        }
      >
        <TableSkeleton columns={6} rows={6} />
      </ListLayout>
    );
  }

  const rate = successRate(job);

  return (
    <ListLayout
      header={
        <>
          <Breadcrumbs
            items={[
              { label: tenantSlug, href: `/t/${tenantSlug}` },
              { label: "Jobs", href: `/t/${tenantSlug}/jobs` },
              { label: job.slug },
            ]}
          />
          <JobHeader job={job} tenantSlug={tenantSlug} uiStatus={uiStatus!} />
        </>
      }
      metricsStrip={<MetricsStrip job={job} rate={rate} />}
      filterBar={
        <DocFilterBar
          filter={docFilter}
          onFilter={setDocFilter}
          sort={docSort}
          onSort={setDocSort}
          total={sortedDocs.length}
          allTotal={documents?.length ?? 0}
        />
      }
    >
      {docsLoading && !documents ? (
        <TableSkeleton columns={6} rows={4} />
      ) : sortedDocs.length === 0 ? (
        <div className="flex items-center justify-center py-12 text-[13px] text-ink-3">
          {(documents?.length ?? 0) === 0
            ? "No documents have been recorded for this job yet."
            : "No documents match this filter."}
        </div>
      ) : (
        <DocumentsGrid
          documents={sortedDocs}
          tenantSlug={tenantSlug}
          jobSlug={job.slug}
          onRerun={refetchDocs}
        />
      )}
    </ListLayout>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Header

function JobHeader({
  job,
  tenantSlug,
  uiStatus,
}: {
  job: JobDetail;
  tenantSlug: string;
  uiStatus: UiJobStatus;
}) {
  const [copied, setCopied] = useState(false);
  const durationMs =
    job.startedAt && job.completedAt
      ? new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime()
      : null;
  const cost = job.totalCostUsd === null ? null : Number(job.totalCostUsd);

  return (
    <div className="flex items-start justify-between gap-8">
      <div className="flex flex-col gap-2 min-w-0">
        <div className="flex items-center gap-3 min-w-0 flex-wrap">
          <code className="font-mono text-[22px] font-medium text-ink tracking-tight truncate">
            {job.slug}
          </code>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(job.slug);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
            className="text-ink-4 hover:text-ink transition-colors p-1"
            aria-label="Copy job ID"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-green" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
          <LargeStatusBadge status={uiStatus} />
        </div>

        <div className="flex items-center gap-2 font-mono text-[11px] text-ink-3 flex-wrap">
          {job.pipelineName ? (
            <Link
              href={`/t/${tenantSlug}/pipelines`}
              className="text-ink-2 hover:text-vermillion-2 transition-colors"
            >
              {job.pipelineName}
            </Link>
          ) : (
            <span className="text-ink-4 italic">unknown pipeline</span>
          )}
          {job.schemaSlug && job.schemaName && (
            <>
              <Dot />
              <Link
                href={`/t/${tenantSlug}/schemas/${job.schemaSlug}/build`}
                className="hover:text-vermillion-2 transition-colors"
              >
                {job.schemaName}
                {job.schemaVersion !== null && (
                  <span className="text-ink-4 ml-1">v{job.schemaVersion}</span>
                )}
              </Link>
            </>
          )}
          <Dot />
          <MetaLabel label="Trigger">{job.triggerType}</MetaLabel>
          {job.startedAt && (
            <>
              <Dot />
              <MetaLabel label="Started">{formatAbsoluteTime(job.startedAt)}</MetaLabel>
            </>
          )}
          {job.completedAt && (
            <>
              <Dot />
              <MetaLabel label="Completed">{formatAbsoluteTime(job.completedAt)}</MetaLabel>
            </>
          )}
          <Dot />
          <MetaLabel label="Duration">{formatDuration(durationMs)}</MetaLabel>
          {cost !== null && (
            <>
              <Dot />
              <MetaLabel label="Cost">${cost.toFixed(3)}</MetaLabel>
            </>
          )}
          <Dot />
          <span className="text-ink-4">{formatRelativeTime(job.createdAt)}</span>
        </div>
      </div>
    </div>
  );
}

function Dot() {
  return <span className="text-cream-4 text-[8px]">●</span>;
}

function MetaLabel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span>
      <span className="text-ink-4 uppercase tracking-[0.08em] text-[9.5px] mr-1">{label}</span>
      {children}
    </span>
  );
}

function LargeStatusBadge({ status }: { status: UiJobStatus }) {
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-2 font-mono text-[11px] font-medium tracking-[0.1em] uppercase px-3 py-1 rounded-sm text-[#2B6A9E] bg-[#2B6A9E]/[0.12]">
        <span className="relative flex w-2 h-2">
          <span className="absolute inline-flex h-full w-full rounded-full bg-[#2B6A9E] opacity-60 animate-ping" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-[#2B6A9E]" />
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
      className={`inline-flex items-center font-mono text-[11px] font-medium px-3 py-1 rounded-sm uppercase tracking-[0.1em] ${styles[status]}`}
    >
      {status}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Metrics strip

function MetricsStrip({ job, rate }: { job: JobDetail; rate: number | null }) {
  return (
    <div className="grid grid-cols-5 gap-4 border border-border rounded-sm bg-cream overflow-hidden">
      <Metric label="Total docs" value={job.docsTotal.toString()} />
      <Metric label="Succeeded" value={job.docsPassed.toString()} tone="success" />
      <Metric
        label="Failed"
        value={job.docsFailed.toString()}
        tone={job.docsFailed > 0 ? "fail" : "neutral"}
      />
      <Metric
        label="In review"
        value={job.docsReviewing.toString()}
        tone={job.docsReviewing > 0 ? "warn" : "neutral"}
      />
      <Metric
        label="Success rate"
        value={rate === null ? "—" : `${(rate * 100).toFixed(1)}%`}
        tone={rate !== null && rate >= 0.99 ? "success" : "neutral"}
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
  tone?: "neutral" | "success" | "fail" | "warn";
}) {
  const valueColor =
    tone === "success"
      ? "text-green"
      : tone === "fail"
      ? "text-vermillion-2"
      : tone === "warn"
      ? "text-[#B6861A]"
      : "text-ink";
  return (
    <div className="flex flex-col gap-1 px-5 py-3 border-r border-border last:border-r-0">
      <span className="font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase text-ink-4">
        {label}
      </span>
      <span
        className={`font-display text-[24px] font-medium leading-none tracking-tight ${valueColor}`}
      >
        {value}
      </span>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Document filter bar

const DOC_FILTERS: { key: DocStatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "delivered", label: "Delivered" },
  { key: "failed", label: "Failed" },
  { key: "review", label: "In Review" },
  { key: "running", label: "Running" },
];

const DOC_SORTS: { key: DocSort; label: string }[] = [
  { key: "status", label: "Failures first" },
  { key: "confidence", label: "Lowest confidence" },
  { key: "filename", label: "Filename" },
];

function DocFilterBar({
  filter,
  onFilter,
  sort,
  onSort,
  total,
  allTotal,
}: {
  filter: DocStatusFilter;
  onFilter: (f: DocStatusFilter) => void;
  sort: DocSort;
  onSort: (s: DocSort) => void;
  total: number;
  allTotal: number;
}) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span className="font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase text-ink-4 mr-1">
        Documents
      </span>
      <div className="flex items-center gap-0.5">
        {DOC_FILTERS.map((opt) => (
          <button
            key={opt.key}
            onClick={() => onFilter(opt.key)}
            className={`font-mono text-[10px] px-2.5 py-1 rounded-sm transition-colors ${
              filter === opt.key
                ? "bg-ink text-cream"
                : "text-ink-3 hover:bg-cream-2 hover:text-ink"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <span className="w-px h-4 bg-border" />

      <label className="font-mono text-[9.5px] text-ink-4 uppercase tracking-[0.08em]">
        Sort
      </label>
      <select
        value={sort}
        onChange={(e) => onSort(e.target.value as DocSort)}
        className="font-mono text-[11px] bg-cream-2 border border-border rounded-sm px-2 py-1 text-ink-2 hover:bg-cream-3 transition-colors focus:outline-none focus:border-ink"
      >
        {DOC_SORTS.map((s) => (
          <option key={s.key} value={s.key}>
            {s.label}
          </option>
        ))}
      </select>

      <span className="flex-1" />
      <span className="font-mono text-[10px] text-ink-4">
        {total} of {allTotal}
      </span>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Documents grid

function DocumentsGrid({
  documents,
  tenantSlug,
  jobSlug,
  onRerun,
}: {
  documents: JobDocument[];
  tenantSlug: string;
  jobSlug: string;
  onRerun: () => void;
}) {
  return (
    <div className="border border-border rounded-sm overflow-hidden bg-cream">
      <div className="grid grid-cols-[minmax(220px,1.8fr)_110px_80px_1fr_72px_100px] gap-3 px-4 py-2 border-b border-border bg-cream-2/50">
        <ColHead>Filename</ColHead>
        <ColHead>Status</ColHead>
        <ColHead className="text-right">Pages</ColHead>
        <ColHead>Confidence</ColHead>
        <ColHead className="text-right">Duration</ColHead>
        <ColHead className="text-right">Trace</ColHead>
      </div>
      {documents.map((doc) => (
        <DocumentRow
          key={doc.id}
          doc={doc}
          tenantSlug={tenantSlug}
          jobSlug={jobSlug}
          onRerun={onRerun}
        />
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

function DocumentRow({
  doc,
  tenantSlug,
  jobSlug,
  onRerun,
}: {
  doc: JobDocument;
  tenantSlug: string;
  jobSlug: string;
  onRerun: () => void;
}) {
  const status = normalizeDocStatus(doc.status);
  const isFailed = status === "failed";
  const isReview = status === "review";
  const validation = (doc.validationJson ?? null) as
    | { error_cause?: string; message?: string; reason?: string }
    | null;
  const errorCause = validation?.error_cause ?? null;
  const reviewReason = validation?.reason ?? null;
  const confidence = doc.confidence === null ? null : Number(doc.confidence);

  const rowTone = isFailed
    ? "bg-vermillion-3/40 hover:bg-vermillion-3/60"
    : isReview
    ? "bg-[#B6861A]/[0.08] hover:bg-[#B6861A]/[0.14]"
    : "hover:bg-cream-2/60";

  const [rerunning, setRerunning] = useState(false);

  const handleRerun = useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>) => {
      // The row itself is a <Link> — stop the click from navigating.
      e.preventDefault();
      e.stopPropagation();
      setRerunning(true);
      try {
        await jobsApi.rerunDocument(jobSlug, doc.id);
        onRerun();
      } catch {
        // Refetch will pick up the real state; no modal, no alert.
      } finally {
        setRerunning(false);
      }
    },
    [jobSlug, doc.id, onRerun],
  );

  return (
    <Link
      href={`/t/${tenantSlug}/jobs/${jobSlug}/documents/${doc.id}`}
      className={`grid grid-cols-[minmax(220px,1.8fr)_110px_80px_1fr_72px_100px] gap-3 px-4 py-2.5 border-b border-dotted border-border last:border-b-0 transition-colors items-center ${rowTone}`}
    >
      <div className="flex flex-col min-w-0 gap-0.5">
        <span className="font-mono text-[11.5px] text-ink truncate">{doc.filename}</span>
        {isFailed && errorCause && (
          <span className="font-mono text-[10px] text-vermillion-2 truncate">
            {formatErrorCause(errorCause)}
          </span>
        )}
        {isReview && reviewReason && (
          <span className="font-mono text-[10px] text-[#B6861A] truncate">
            routed to review — {formatReviewReason(reviewReason)}
          </span>
        )}
      </div>
      <DocStatusBadge status={status} />
      <span className="text-right font-mono text-[11px] tabular-nums text-ink-2">
        {doc.pageCount ?? "—"}
      </span>
      <ConfidenceBar confidence={confidence} status={status} />
      <span className="text-right font-mono text-[11px] text-ink-3">
        {formatDuration(doc.durationMs)}
      </span>
      <div className="flex items-center justify-end gap-2 font-mono text-[10px] text-ink-3 group-hover:text-vermillion-2 transition-colors">
        {isFailed && (
          <button
            type="button"
            onClick={handleRerun}
            disabled={rerunning}
            className="font-mono text-[10px] text-ink-3 hover:text-vermillion-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {rerunning ? "…" : "Rerun"}
          </button>
        )}
        <span className="flex items-center gap-0.5">
          view
          <ChevronRight className="w-3 h-3" />
        </span>
      </div>
    </Link>
  );
}

function DocStatusBadge({ status }: { status: UiDocStatus }) {
  const styles: Record<UiDocStatus, string> = {
    received: "bg-cream-2 text-ink-4",
    extracting: "bg-[#2B6A9E]/[0.12] text-[#2B6A9E]",
    delivered: "bg-green/[0.12] text-green",
    failed: "bg-vermillion-3 text-vermillion-2",
    review: "bg-[#B6861A]/[0.14] text-[#B6861A]",
  };
  return (
    <span
      className={`inline-flex items-center font-mono text-[10px] font-medium px-1.5 py-0.5 rounded-sm uppercase tracking-[0.08em] w-fit ${styles[status]}`}
    >
      {status}
    </span>
  );
}

function ConfidenceBar({
  confidence,
  status,
}: {
  confidence: number | null;
  status: UiDocStatus;
}) {
  if (confidence === null || Number.isNaN(confidence)) {
    return <span className="font-mono text-[10px] text-ink-4">—</span>;
  }
  const pct = Math.min(1, Math.max(0, confidence)) * 100;
  let color = "bg-green";
  if (status === "review") color = "bg-[#B6861A]";
  else if (confidence < 0.9) color = "bg-[#B6861A]";
  else if (confidence < 0.95) color = "bg-ink-3";

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

// ──────────────────────────────────────────────────────────────────────
// Filter / sort / formatting helpers

function filterDocs(docs: JobDocument[], filter: DocStatusFilter): JobDocument[] {
  if (filter === "all") return docs;
  if (filter === "running") {
    return docs.filter((d) => {
      const s = normalizeDocStatus(d.status);
      return s === "extracting" || s === "received";
    });
  }
  return docs.filter((d) => normalizeDocStatus(d.status) === filter);
}

function sortDocs(docs: JobDocument[], sort: DocSort): JobDocument[] {
  const out = [...docs];
  if (sort === "filename") {
    out.sort((a, b) => a.filename.localeCompare(b.filename));
  } else if (sort === "confidence") {
    const c = (d: JobDocument) => (d.confidence === null ? 0 : Number(d.confidence));
    out.sort((a, b) => c(a) - c(b));
  } else {
    // status: failures first, then review, then running, then delivered
    const order: Record<UiDocStatus, number> = {
      failed: 0,
      review: 1,
      extracting: 2,
      received: 3,
      delivered: 4,
    };
    out.sort((a, b) => {
      const diff = order[normalizeDocStatus(a.status)] - order[normalizeDocStatus(b.status)];
      if (diff !== 0) return diff;
      return a.filename.localeCompare(b.filename);
    });
  }
  return out;
}

function formatErrorCause(cause: string): string {
  return cause.replaceAll("_", " ");
}

function formatReviewReason(reason: string): string {
  return reason.replaceAll("_", " ");
}
