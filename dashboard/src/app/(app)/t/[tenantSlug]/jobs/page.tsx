"use client";

import { useState, useCallback } from "react";
import { Play } from "lucide-react";
import { ListLayout, Breadcrumbs, PageHeader } from "@/components/layouts";
import { jobs as jobsApi, type JobRow } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { EmptyState } from "@/components/shared/EmptyState";

const FILTERS = ["all", "running", "complete", "failed", "canceled"] as const;
type Filter = (typeof FILTERS)[number];

function formatRow(j: JobRow) {
  return {
    slug: j.slug,
    status: j.status,
    docs: j.docsTotal,
    accuracy: j.docsPassed && j.docsTotal ? `${((j.docsPassed / j.docsTotal) * 100).toFixed(1)}%` : "—",
    cost: j.totalCostUsd ? `$${j.totalCostUsd}` : "—",
    started: j.startedAt ? new Date(j.startedAt).toLocaleString() : "—",
  };
}

export default function JobsPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const { data: rawJobs, loading, error } = useApi(
    useCallback(() => jobsApi.list(filter === "all" ? undefined : { status: filter }), [filter]),
  );
  const rows = rawJobs?.map(formatRow) ?? [];

  return (
    <ListLayout
      header={
        <>
          <Breadcrumbs items={[{ label: "acme-invoices", href: "#" }, { label: "Jobs" }]} />
          <PageHeader
            title="Jobs"
            actions={
              <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors">
                Run pipeline
              </button>
            }
          />
        </>
      }
      filterBar={
        <div className="flex items-center gap-2">
          {FILTERS.map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`font-mono text-[10px] px-2.5 py-1 rounded-sm transition-colors capitalize ${
                f === filter ? "bg-ink text-cream" : "text-ink-3 hover:bg-cream-2 hover:text-ink"
              }`}
            >
              {f}
            </button>
          ))}
          <span className="flex-1" />
          {!loading && <span className="font-mono text-[10px] text-ink-4">{rows.length} total</span>}
        </div>
      }
    >
      {loading ? (
        <TableSkeleton columns={6} rows={5} />
      ) : error ? (
        <EmptyState
          title="Cannot reach API"
          description={`${error.message}. Start the server with: pnpm --filter @koji/api dev`}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Play className="w-8 h-8" />}
          title={filter === "all" ? "No jobs yet" : `No ${filter} jobs`}
          description={filter === "all"
            ? "Run a pipeline to process documents. Jobs will appear here as they execute."
            : `No jobs with status "${filter}" right now.`
          }
          action={filter === "all" ? (
            <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors">
              Run pipeline
            </button>
          ) : (
            <button
              onClick={() => setFilter("all")}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-cream text-ink border border-border-strong hover:border-ink transition-colors"
            >
              Show all jobs
            </button>
          )}
        />
      ) : (
        <table className="w-full">
          <thead><tr className="border-b border-border">
            {["Job", "Status", "Docs", "Accuracy", "Cost", "Started"].map(h => (
              <th key={h} className={`text-left px-4 py-2 font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4 ${h === "Docs" || h === "Accuracy" || h === "Cost" ? "text-right" : ""}`}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {rows.map(j => (
              <tr key={j.slug} className="border-b border-dotted border-border hover:bg-cream-2/50 cursor-pointer transition-colors">
                <td className="px-4 py-2 font-mono text-[11px] text-ink">{j.slug}</td>
                <td className="px-4 py-2"><span className={`font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm uppercase tracking-[0.08em] ${j.status === "complete" ? "bg-green/[0.12] text-green" : j.status === "running" ? "bg-cream-2 text-ink-3" : j.status === "failed" ? "bg-vermillion-3 text-vermillion-2" : "bg-cream-2 text-ink-4"}`}>{j.status}</span></td>
                <td className="px-4 py-2 text-right font-mono text-[11px] text-ink">{j.docs}</td>
                <td className="px-4 py-2 text-right font-mono text-[11px] text-ink-2">{j.accuracy}</td>
                <td className="px-4 py-2 text-right font-mono text-[11px] text-ink-3">{j.cost}</td>
                <td className="px-4 py-2 font-mono text-[10px] text-ink-4">{j.started}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ListLayout>
  );
}
