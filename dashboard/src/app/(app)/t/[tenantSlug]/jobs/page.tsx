"use client";

import { ListLayout, Breadcrumbs, PageHeader } from "@/components/layouts";

const JOBS = [
  { slug: "job-20260414-1442-a91c", pipeline: "claims-intake", status: "complete", docs: 47, accuracy: "98.2%", cost: "$0.04", started: "2 min ago" },
  { slug: "job-20260414-0903-b2df", pipeline: "invoice-ingest", status: "running", docs: 12, accuracy: "\u2014", cost: "$0.01", started: "18 min ago" },
  { slug: "job-20260413-2201-c4e1", pipeline: "claims-intake", status: "failed", docs: 3, accuracy: "\u2014", cost: "$0.00", started: "1h ago" },
  { slug: "job-20260413-1442-f891", pipeline: "receipt-scan", status: "complete", docs: 89, accuracy: "99.1%", cost: "$0.08", started: "3h ago" },
  { slug: "job-20260413-1100-d234", pipeline: "claims-intake", status: "complete", docs: 52, accuracy: "97.8%", cost: "$0.05", started: "5h ago" },
  { slug: "job-20260412-1830-e567", pipeline: "invoice-ingest", status: "complete", docs: 31, accuracy: "99.4%", cost: "$0.03", started: "yesterday" },
  { slug: "job-20260412-0900-a123", pipeline: "receipt-scan", status: "canceled", docs: 0, accuracy: "\u2014", cost: "$0.00", started: "yesterday" },
  { slug: "job-20260411-1400-b456", pipeline: "claims-intake", status: "complete", docs: 64, accuracy: "98.5%", cost: "$0.06", started: "2 days ago" },
];

export default function JobsPage() {
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
          {["All", "Running", "Complete", "Failed"].map((s) => (
            <button
              key={s}
              className={`font-mono text-[10px] px-2.5 py-1 rounded-sm transition-colors ${s === "All" ? "bg-ink text-cream" : "text-ink-3 hover:bg-cream-2 hover:text-ink"}`}
            >
              {s}
            </button>
          ))}
          <span className="flex-1" />
          <span className="font-mono text-[10px] text-ink-4">238 total</span>
        </div>
      }
    >
      <table className="w-full">
        <thead>
          <tr className="border-b border-border">
            {["Job", "Pipeline", "Status", "Docs", "Accuracy", "Cost", "Started"].map((h) => (
              <th
                key={h}
                className={`text-left px-4 py-2 font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4 ${h === "Docs" || h === "Accuracy" || h === "Cost" ? "text-right" : ""}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {JOBS.map((j) => (
            <tr key={j.slug} className="border-b border-dotted border-border hover:bg-cream-2/50 cursor-pointer transition-colors">
              <td className="px-4 py-2 font-mono text-[11px] text-ink">{j.slug}</td>
              <td className="px-4 py-2 text-[12.5px] text-ink-2">{j.pipeline}</td>
              <td className="px-4 py-2">
                <span
                  className={`font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm uppercase tracking-[0.08em] ${
                    j.status === "complete"
                      ? "bg-green/[0.12] text-green"
                      : j.status === "running"
                        ? "bg-cream-2 text-ink-3"
                        : j.status === "failed"
                          ? "bg-vermillion-3 text-vermillion-2"
                          : "bg-cream-2 text-ink-4"
                  }`}
                >
                  {j.status}
                </span>
              </td>
              <td className="px-4 py-2 text-right font-mono text-[11px] text-ink">{j.docs}</td>
              <td className="px-4 py-2 text-right font-mono text-[11px] text-ink-2">{j.accuracy}</td>
              <td className="px-4 py-2 text-right font-mono text-[11px] text-ink-3">{j.cost}</td>
              <td className="px-4 py-2 font-mono text-[10px] text-ink-4">{j.started}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListLayout>
  );
}
