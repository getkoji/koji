"use client";

/**
 * Documents — the tenant/project-wide document list.
 *
 * Documents were previously reachable only through the job that ingested
 * them; this page makes them findable directly (filename search, status
 * facet, pipeline filter) — the entry point for "find this document and fix
 * it" correction workflows. Rows link to the document detail page under the
 * owning job. Backed by GET /api/documents (same infinite-scroll envelope as
 * the Jobs page).
 */

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { FileText, MessageSquare } from "lucide-react";
import { ListLayout, Breadcrumbs, PageHeader } from "@/components/layouts";
import { EmptyState } from "@/components/shared/EmptyState";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { documents as documentsApi, api, type DocumentListRow } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { formatRelativeTime } from "../jobs/format";
import { usePageTitle } from "@/lib/use-page-title";

type DateRange = "today" | "7d" | "30d" | "all";

const DATE_OPTIONS: { key: DateRange; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "all", label: "All" },
];

/** Human label for a raw document status (statuses are lowercase slugs). */
function statusLabel(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replaceAll("_", " ");
}

const STATUS_TONE: Record<string, string> = {
  delivered: "text-green bg-green/[0.08]",
  review: "text-[#B6861A] bg-[#B6861A]/[0.10]",
  failed: "text-vermillion-2 bg-vermillion-3/40",
};

interface PipelineOption {
  id: string;
  slug: string;
  displayName: string;
}

export default function DocumentsPage() {
  usePageTitle("Documents");
  const params = useParams<{ tenantSlug: string }>();
  const tenantSlug = params?.tenantSlug ?? "";

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [pipelineFilter, setPipelineFilter] = useState<string>("all");
  const [dateFilter, setDateFilter] = useState<DateRange>("30d");
  const [search, setSearch] = useState("");

  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // ── Infinite scroll state (same shape as the Jobs page) ─────────
  const [docs, setDocs] = useState<DocumentListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string } | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [serverCounts, setServerCounts] = useState<{ total: number; byStatus: Record<string, number> } | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const PAGE_SIZE = 50;

  const fetchPage = useCallback(
    (cursor?: string) =>
      documentsApi.list({
        status: statusFilter === "all" ? undefined : statusFilter,
        pipeline: pipelineFilter === "all" ? undefined : pipelineFilter,
        since: dateFilter === "all" ? undefined : dateFilter,
        search: debouncedSearch || undefined,
        cursor,
        limit: PAGE_SIZE,
      }),
    [statusFilter, pipelineFilter, dateFilter, debouncedSearch],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNextCursor(null);
    fetchPage()
      .then((resp) => {
        if (cancelled) return;
        setDocs(resp.data);
        setNextCursor(resp.nextCursor);
        setServerCounts(resp.counts);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError({ message: err instanceof Error ? err.message : "API unreachable" });
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchPage]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const resp = await fetchPage(nextCursor);
      setDocs((prev) => [...prev, ...resp.data]);
      setNextCursor(resp.nextCursor);
    } catch {
      // Silently fail — user can scroll back up and try again
    }
    setLoadingMore(false);
  }, [nextCursor, loadingMore, fetchPage]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  const { data: pipelines } = useApi(
    useCallback(
      () =>
        api
          .get<{ data: PipelineOption[] }>("/api/pipelines")
          .then((r) => r.data.map((p) => ({ id: p.id, slug: p.slug, displayName: p.displayName }))),
      [],
    ),
  );

  // Status pills come from the server's facet counts, so the filter bar
  // always matches the statuses that actually exist in the filtered set.
  const statusOptions = useMemo(() => {
    const keys = Object.keys(serverCounts?.byStatus ?? {}).sort();
    return ["all", ...keys.filter((k) => k !== "all")];
  }, [serverCounts]);

  const metrics = useMemo(() => {
    const bs = serverCounts?.byStatus ?? {};
    return {
      total: serverCounts?.total ?? 0,
      delivered: bs.delivered ?? 0,
      review: bs.review ?? 0,
      failed: bs.failed ?? 0,
    };
  }, [serverCounts]);

  const hasFilters = statusFilter !== "all" || pipelineFilter !== "all" || dateFilter !== "all" || search !== "";

  return (
    <ListLayout
      header={
        <>
          <Breadcrumbs
            items={[
              { label: tenantSlug, href: `/t/${tenantSlug}` },
              { label: "Documents" },
            ]}
          />
          <PageHeader title="Documents" />
        </>
      }
      metricsStrip={
        <div className="grid grid-cols-4 gap-4 border border-border rounded-sm bg-cream overflow-hidden">
          <Metric label="Total" value={metrics.total} />
          <Metric label="Delivered" value={metrics.delivered} tone="success" />
          <Metric label="In review" value={metrics.review} tone={metrics.review > 0 ? "warn" : "neutral"} />
          <Metric label="Failed" value={metrics.failed} tone={metrics.failed > 0 ? "fail" : "neutral"} />
        </div>
      }
      filterBar={
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            {statusOptions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`font-mono text-[11px] px-2 py-1 rounded-sm border transition-colors ${
                  statusFilter === s
                    ? "border-ink bg-ink text-cream"
                    : "border-border text-ink-3 hover:border-ink hover:text-ink"
                }`}
              >
                {s === "all" ? "All" : statusLabel(s)}
              </button>
            ))}
          </div>
          <select
            aria-label="Filter by pipeline"
            value={pipelineFilter}
            onChange={(e) => setPipelineFilter(e.target.value)}
            className="font-mono text-[11px] text-ink bg-cream border border-border rounded-sm px-2 py-1 outline-none focus:border-ink"
          >
            <option value="all">All pipelines</option>
            {(pipelines ?? []).map((p) => (
              <option key={p.id} value={p.slug}>
                {p.displayName}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-1">
            {DATE_OPTIONS.map((d) => (
              <button
                key={d.key}
                type="button"
                onClick={() => setDateFilter(d.key)}
                className={`font-mono text-[11px] px-2 py-1 rounded-sm border transition-colors ${
                  dateFilter === d.key
                    ? "border-ink bg-ink text-cream"
                    : "border-border text-ink-3 hover:border-ink hover:text-ink"
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search filenames…"
            className="flex-1 min-w-[180px] max-w-[320px] font-mono text-[11.5px] text-ink bg-cream border border-border rounded-sm px-2.5 py-1 outline-none focus:border-ink transition-colors"
          />
          <span className="ml-auto font-mono text-[10px] text-ink-4">
            {metrics.total} {metrics.total === 1 ? "document" : "documents"}
          </span>
        </div>
      }
    >
      {error ? (
        <EmptyState
          title="Cannot reach API"
          description={error.message}
        />
      ) : loading ? (
        <TableSkeleton columns={7} rows={8} />
      ) : docs.length === 0 ? (
        <EmptyState
          icon={<FileText className="w-8 h-8" />}
          title={hasFilters ? "No matching documents" : "No documents yet"}
          description={
            hasFilters
              ? "Try clearing filters to see more results."
              : "Documents appear here as pipelines process them."
          }
          action={
            hasFilters ? (
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
            ) : undefined
          }
        />
      ) : (
        <div className="border border-border rounded-sm bg-cream overflow-hidden">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border bg-cream-2/50">
                {["Document", "Status", "Pipeline", "Schema", "Pages", "Confidence", "Created"].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-2 font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase text-ink-4"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-dotted divide-border">
              {docs.map((d) => (
                <tr key={d.id} className="hover:bg-cream-2/40 transition-colors">
                  <td className="px-4 py-2 max-w-[320px]">
                    <Link
                      href={`/t/${tenantSlug}/jobs/${d.jobSlug}/documents/${d.id}`}
                      className="flex items-center gap-1.5 text-[12.5px] text-ink hover:text-vermillion-2 transition-colors min-w-0"
                    >
                      <FileText className="w-3.5 h-3.5 shrink-0 text-ink-4" />
                      <span className="truncate">{d.filename}</span>
                      {d.hasPendingReview && (
                        <span
                          title="Has pending review items"
                          className="shrink-0 inline-flex items-center gap-0.5 font-mono text-[9px] text-[#B6861A] bg-[#B6861A]/[0.12] rounded-sm px-1 py-px uppercase tracking-wide"
                        >
                          <MessageSquare className="w-2.5 h-2.5" />
                          review
                        </span>
                      )}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex font-mono text-[10px] font-medium px-1.5 py-0.5 rounded-sm uppercase tracking-[0.06em] ${
                        STATUS_TONE[d.status] ?? "text-ink-3 bg-cream-2"
                      }`}
                    >
                      {statusLabel(d.status)}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-[11px] text-ink-3 truncate max-w-[160px]">
                    {d.pipelineName ?? "—"}
                  </td>
                  <td className="px-4 py-2 font-mono text-[11px] text-ink-3 truncate max-w-[160px]">
                    {d.schemaName ?? "—"}
                  </td>
                  <td className="px-4 py-2 font-mono text-[11px] text-ink-3 tabular-nums">
                    {d.pageCount ?? "—"}
                  </td>
                  <td className="px-4 py-2 font-mono text-[11px] text-ink-3 tabular-nums">
                    {d.confidence != null ? Number(d.confidence).toFixed(2) : "—"}
                  </td>
                  <td className="px-4 py-2 font-mono text-[11px] text-ink-4 whitespace-nowrap">
                    {formatRelativeTime(d.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div ref={sentinelRef} className="h-px" />
          {loadingMore && (
            <div className="px-4 py-3 font-mono text-[11px] text-ink-4 animate-pulse">Loading more…</div>
          )}
        </div>
      )}
    </ListLayout>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "success" | "warn" | "fail";
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
      <span className={`font-display text-[26px] font-medium leading-none tracking-tight ${valueColor}`}>
        {value}
      </span>
    </div>
  );
}
