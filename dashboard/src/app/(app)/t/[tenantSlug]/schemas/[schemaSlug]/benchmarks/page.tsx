"use client";

import { Breadcrumbs, PageHeader, StickyHeader } from "@/components/layouts";

const METRICS = [
  { label: "Overall accuracy", value: "97.4%", detail: "across 8 corpus docs" },
  { label: "Best model", value: "gpt-4o-mini", detail: "98.2% avg accuracy" },
  { label: "Docs tested", value: "8", detail: "5 passing, 3 failing" },
  { label: "Last run", value: "12 min ago", detail: "triggered manually" },
];

const MODELS = [
  { name: "gpt-4o-mini", accuracy: "98.2%", fieldAccuracy: "97.8%", latency: "1.4s", cost: "$0.003", pass: 7, fail: 1 },
  { name: "claude-3.5-sonnet", accuracy: "97.9%", fieldAccuracy: "97.1%", latency: "2.1s", cost: "$0.008", pass: 7, fail: 1 },
  { name: "gpt-4o", accuracy: "97.1%", fieldAccuracy: "96.5%", latency: "3.2s", cost: "$0.012", pass: 6, fail: 2 },
  { name: "llama-3.2", accuracy: "94.3%", fieldAccuracy: "93.1%", latency: "0.9s", cost: "$0.001", pass: 5, fail: 3 },
];

export default function BenchmarksPage() {
  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      <StickyHeader>
        <Breadcrumbs
          items={[
            { label: "acme-invoices", href: "#" },
            { label: "invoice-v2", href: "#" },
            { label: "Benchmarks" },
          ]}
        />
        <PageHeader
          title="Benchmarks"
          meta={<span>Accuracy comparison across models and corpus</span>}
          actions={
            <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors">
              Run benchmark
            </button>
          }
        />
      </StickyHeader>

      <div className="flex-1 overflow-y-auto px-10 pt-6 pb-8">
        {/* Metrics strip */}
        <div className="grid grid-cols-4 gap-4 mb-8">
          {METRICS.map((m) => (
            <div key={m.label} className="border border-border rounded-sm px-4 py-3">
              <div className="font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase text-ink-4 mb-1">{m.label}</div>
              <div className="font-mono text-[20px] font-medium text-ink leading-none mb-1">{m.value}</div>
              <div className="font-mono text-[10px] text-ink-4">{m.detail}</div>
            </div>
          ))}
        </div>

        {/* Model comparison table */}
        <div className="mb-3">
          <span className="font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase text-ink-4">Model comparison</span>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              {["Model", "Doc accuracy", "Field accuracy", "Latency", "Cost / doc", "Pass", "Fail"].map((h) => (
                <th
                  key={h}
                  className={`text-left px-4 py-2 font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4 ${
                    ["Doc accuracy", "Field accuracy", "Latency", "Cost / doc", "Pass", "Fail"].includes(h) ? "text-right" : ""
                  }`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {MODELS.map((m) => (
              <tr key={m.name} className="border-b border-dotted border-border hover:bg-cream-2/50 transition-colors">
                <td className="px-4 py-2 font-mono text-[11px] text-ink">{m.name}</td>
                <td className="px-4 py-2 text-right font-mono text-[11px] text-ink">{m.accuracy}</td>
                <td className="px-4 py-2 text-right font-mono text-[11px] text-ink-2">{m.fieldAccuracy}</td>
                <td className="px-4 py-2 text-right font-mono text-[11px] text-ink-3">{m.latency}</td>
                <td className="px-4 py-2 text-right font-mono text-[11px] text-ink-3">{m.cost}</td>
                <td className="px-4 py-2 text-right">
                  <span className="font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm bg-green/[0.12] text-green">{m.pass}</span>
                </td>
                <td className="px-4 py-2 text-right">
                  <span className={`font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm ${m.fail > 0 ? "bg-vermillion-3 text-vermillion-2" : "bg-cream-2 text-ink-4"}`}>{m.fail}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
