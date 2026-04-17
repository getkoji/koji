"use client";

import { ListLayout, Breadcrumbs, PageHeader } from "@/components/layouts";

const SOURCES = [
  { name: "s3://acme-claims-inbox", type: "S3 Bucket", status: "active", pipeline: "claims-intake", lastIngestion: "2 min ago", throughput: "142 docs" },
  { name: "sftp://files.globex.net/invoices", type: "SFTP", status: "active", pipeline: "invoice-ingest", lastIngestion: "18 min ago", throughput: "87 docs" },
  { name: "gs://receipt-uploads-prod", type: "GCS Bucket", status: "paused", pipeline: "receipt-scan", lastIngestion: "3h ago", throughput: "0 docs" },
  { name: "https://api.partner.io/webhook", type: "Webhook", status: "active", pipeline: "claims-intake", lastIngestion: "45 min ago", throughput: "31 docs" },
  { name: "az://prudential-drop/claims", type: "Azure Blob", status: "error", pipeline: "claims-intake", lastIngestion: "1 day ago", throughput: "0 docs" },
];

export default function SourcesPage() {
  return (
    <ListLayout
      header={
        <>
          <Breadcrumbs items={[{ label: "acme-invoices", href: "#" }, { label: "Sources" }]} />
          <PageHeader
            title="Sources"
            meta={<span>5 configured sources</span>}
            actions={
              <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors">
                Add source
              </button>
            }
          />
        </>
      }
      filterBar={
        <div className="flex items-center gap-2">
          {["All", "Active", "Paused", "Error"].map((s) => (
            <button
              key={s}
              className={`font-mono text-[10px] px-2.5 py-1 rounded-sm transition-colors ${s === "All" ? "bg-ink text-cream" : "text-ink-3 hover:bg-cream-2 hover:text-ink"}`}
            >
              {s}
            </button>
          ))}
          <span className="flex-1" />
          <span className="font-mono text-[10px] text-ink-4">5 sources</span>
        </div>
      }
    >
      <table className="w-full">
        <thead>
          <tr className="border-b border-border">
            {["Name", "Type", "Status", "Pipeline", "Last ingestion", "Throughput 24h"].map((h) => (
              <th key={h} className="text-left px-4 py-2 font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SOURCES.map((s) => (
            <tr key={s.name} className="border-b border-dotted border-border hover:bg-cream-2/50 cursor-pointer transition-colors">
              <td className="px-4 py-2 font-mono text-[11px] text-ink">{s.name}</td>
              <td className="px-4 py-2 text-[12.5px] text-ink-2">{s.type}</td>
              <td className="px-4 py-2">
                <span
                  className={`font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm uppercase tracking-[0.08em] ${
                    s.status === "active"
                      ? "bg-green/[0.12] text-green"
                      : s.status === "error"
                        ? "bg-vermillion-3 text-vermillion-2"
                        : "bg-cream-2 text-ink-3"
                  }`}
                >
                  {s.status}
                </span>
              </td>
              <td className="px-4 py-2 text-[12.5px] text-ink-2">{s.pipeline}</td>
              <td className="px-4 py-2 font-mono text-[10px] text-ink-4">{s.lastIngestion}</td>
              <td className="px-4 py-2 font-mono text-[11px] text-ink-2">{s.throughput}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListLayout>
  );
}
