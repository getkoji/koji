"use client";

import { ListLayout, Breadcrumbs, PageHeader } from "@/components/layouts";

const PIPELINES = [
  { name: "claims-intake", trigger: "S3 upload", status: "active", schemas: 3, lastRun: "2 min ago", throughput: "142 docs" },
  { name: "invoice-ingest", trigger: "SFTP poll (5m)", status: "active", schemas: 2, lastRun: "18 min ago", throughput: "87 docs" },
  { name: "receipt-scan", trigger: "Webhook", status: "paused", schemas: 1, lastRun: "3h ago", throughput: "0 docs" },
  { name: "renewal-processing", trigger: "Manual", status: "active", schemas: 4, lastRun: "1h ago", throughput: "23 docs" },
  { name: "eob-extraction", trigger: "S3 upload", status: "draft", schemas: 2, lastRun: "\u2014", throughput: "0 docs" },
];

export default function PipelinesPage() {
  return (
    <ListLayout
      header={
        <>
          <Breadcrumbs items={[{ label: "acme-invoices", href: "#" }, { label: "Pipelines" }]} />
          <PageHeader
            title="Pipelines"
            meta={<span>5 pipelines configured</span>}
            actions={
              <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors">
                New pipeline
              </button>
            }
          />
        </>
      }
      filterBar={
        <div className="flex items-center gap-2">
          {["All", "Active", "Paused", "Draft"].map((s) => (
            <button
              key={s}
              className={`font-mono text-[10px] px-2.5 py-1 rounded-sm transition-colors ${s === "All" ? "bg-ink text-cream" : "text-ink-3 hover:bg-cream-2 hover:text-ink"}`}
            >
              {s}
            </button>
          ))}
          <span className="flex-1" />
          <span className="font-mono text-[10px] text-ink-4">5 pipelines</span>
        </div>
      }
    >
      <table className="w-full">
        <thead>
          <tr className="border-b border-border">
            {["Name", "Trigger", "Status", "Schemas", "Last run", "Throughput 24h"].map((h) => (
              <th
                key={h}
                className={`text-left px-4 py-2 font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4 ${h === "Schemas" ? "text-right" : ""}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {PIPELINES.map((p) => (
            <tr key={p.name} className="border-b border-dotted border-border hover:bg-cream-2/50 cursor-pointer transition-colors">
              <td className="px-4 py-2 font-mono text-[11px] text-ink">{p.name}</td>
              <td className="px-4 py-2 text-[12.5px] text-ink-2">{p.trigger}</td>
              <td className="px-4 py-2">
                <span
                  className={`font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm uppercase tracking-[0.08em] ${
                    p.status === "active"
                      ? "bg-green/[0.12] text-green"
                      : p.status === "paused"
                        ? "bg-cream-2 text-ink-3"
                        : "bg-cream-2 text-ink-4"
                  }`}
                >
                  {p.status}
                </span>
              </td>
              <td className="px-4 py-2 text-right font-mono text-[11px] text-ink">{p.schemas}</td>
              <td className="px-4 py-2 font-mono text-[10px] text-ink-4">{p.lastRun}</td>
              <td className="px-4 py-2 font-mono text-[11px] text-ink-2">{p.throughput}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListLayout>
  );
}
