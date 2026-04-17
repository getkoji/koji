"use client";

import { useState } from "react";
import { DetailLayout, Breadcrumbs, PageHeader } from "@/components/layouts";

const CORPUS_DOCS = [
  { group: "REGRESSIONS · 1", items: [
    { name: "invoice-0087.pdf", meta: "1 field", score: "87.5%", status: "regress" as const },
  ]},
  { group: "RECOVERED · 2", items: [
    { name: "invoice-0041.pdf", meta: "8/8 · new", score: "100%", status: "pass" as const },
    { name: "invoice-0059.pdf", meta: "8/8 · new", score: "100%", status: "pass" as const },
  ]},
  { group: "PASSING · 59", items: Array.from({ length: 10 }, (_, i) => ({
    name: `invoice-${String(i + 1).padStart(4, "0")}.pdf`,
    meta: "8/8",
    score: [100, 99.2, 100, 98.7, 100, 97.5, 100, 99.9, 100, 98.3][i] + "%",
    status: "pass" as const,
  }))},
];

const FIELDS_0087 = [
  { name: "invoice_number", expected: '"2026-087"', actual: '"2026-087"', pass: true, conf: 0.99 },
  { name: "invoice_date", expected: '"2026-03-28"', actual: '"2026-03-28"', pass: true, conf: 0.99 },
  { name: "vendor", expected: '"Brighton & Co."', actual: '"Brighton & Co."', pass: true, conf: 0.97 },
  { name: "bill_to", expected: '"Vantage Capital"', actual: '"Vantage Capital"', pass: true, conf: 0.96 },
  { name: "line_items", expected: "2 items", actual: "2 items", pass: true, conf: 0.94 },
  { name: "subtotal", expected: "3950.00", actual: "3950.00", pass: true, conf: 0.99 },
  { name: "tax", expected: "300.00", actual: "300.00", pass: true, conf: 0.99 },
  { name: "total_amount", expected: "4250.00", actual: "500.00", pass: false, conf: 0.92 },
];

export default function ValidateModePage() {
  const [selectedDoc, setSelectedDoc] = useState("invoice-0087.pdf");

  const header = (
    <>
      <Breadcrumbs items={[
        { label: "acme-invoices", href: "#" },
        { label: "Schemas", href: "#" },
        { label: "invoice" },
      ]} />
      <PageHeader
        title="invoice"
        badge={
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[11px] font-medium text-ink-3 px-2 py-0.5 border border-border-strong rounded-sm">v12</span>
            <span className="font-mono text-[10px] font-medium text-vermillion-2 px-2 py-0.5 bg-vermillion-3 rounded-sm uppercase tracking-[0.05em]">2 unsaved</span>
          </div>
        }
        actions={
          <>
            <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-cream text-ink border border-border-strong hover:border-ink transition-colors">History</button>
            <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-cream text-ink border border-border-strong hover:border-ink transition-colors">Discard</button>
            <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-vermillion-2 text-cream hover:bg-ink transition-colors">Save v13</button>
          </>
        }
      />
    </>
  );

  const metricsStrip = (
    <div className="flex flex-col gap-4 mb-1">
      {/* Toolbar */}
      <div className="flex items-center justify-between py-3 border-y border-border">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-ink-4">Mode</span>
          <div className="inline-flex p-[3px] bg-cream-2 border border-border rounded-sm">
            <a href="#" className="inline-flex items-center gap-1.5 px-3.5 py-[7px] rounded-sm text-[12px] font-medium text-ink-3 hover:text-ink transition-colors">
              <span className="font-mono text-[13px] text-ink-4">✦</span>Build
            </a>
            <span className="inline-flex items-center gap-1.5 px-3.5 py-[7px] rounded-sm text-[12px] font-medium bg-cream text-ink shadow-[0_1px_0_rgba(23,20,16,0.04)]">
              <span className="font-mono text-[13px] text-vermillion-2">▦</span>Validate
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button className="inline-flex items-center gap-1.5 px-3 py-[7px] bg-cream-2 border border-border rounded-sm font-mono text-[11px] text-ink-2">
            <span className="text-ink-4 uppercase tracking-[0.1em] text-[9.5px]">Corpus</span>
            <span className="text-ink">acme-invoices · 62 docs</span>
            <span className="text-ink-4 text-[10px]">▾</span>
          </button>
          <button className="inline-flex items-center gap-1.5 px-3 py-[7px] bg-cream-2 border border-border rounded-sm font-mono text-[11px] text-ink-2">
            <span className="text-ink-4 uppercase tracking-[0.1em] text-[9.5px]">Compare to</span>
            <span className="text-ink">v12 (current)</span>
            <span className="text-ink-4 text-[10px]">▾</span>
          </button>
          <button className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-vermillion-2 text-cream rounded-sm text-[12px] font-medium hover:bg-ink transition-colors">
            <span className="text-[11px]">▶</span>Re-run
            <kbd className="font-mono text-[9.5px] px-1 py-px border border-cream/25 rounded-sm text-cream-3 ml-1">⌘↵</kbd>
          </button>
        </div>
      </div>

      {/* Regression callout */}
      <div className="grid items-center gap-4 px-4 py-3.5 bg-vermillion-3 border border-vermillion-2/25 border-l-[3px] border-l-vermillion-2 rounded-r-sm"
           style={{ gridTemplateColumns: "auto 1fr auto" }}>
        <div className="flex flex-col items-center pr-4 border-r border-vermillion-2/20">
          <span className="font-display text-[28px] font-medium text-vermillion-2 leading-none" style={{ fontVariationSettings: "'opsz' 72, 'SOFT' 30" }}>1</span>
          <span className="font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-vermillion-2 mt-0.5">regression</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="font-display text-[15px] font-medium text-ink leading-[1.2]" style={{ fontVariationSettings: "'opsz' 72, 'SOFT' 30" }}>One doc newly failing on v13</span>
          <span className="text-[12px] text-ink-2">
            <span className="font-mono text-[11px] text-ink px-1 py-px bg-cream rounded-sm">invoice-0087.pdf</span> — <span className="font-mono text-[11px] text-ink px-1 py-px bg-cream rounded-sm">total_amount</span> now extracts <span className="font-mono text-[11px] text-ink px-1 py-px bg-cream rounded-sm">$500.00</span> instead of <span className="font-mono text-[11px] text-ink px-1 py-px bg-cream rounded-sm">$4,250.00</span>
          </span>
        </div>
        <div className="flex gap-1.5 shrink-0">
          <button className="px-3 py-1.5 text-[12px] font-medium text-vermillion-2 border border-vermillion-2/30 rounded-sm hover:bg-vermillion-2/[0.08] transition-colors">Ignore</button>
          <button className="px-3 py-1.5 text-[12px] font-medium bg-vermillion-2 text-cream rounded-sm hover:bg-ink transition-colors">Investigate</button>
        </div>
      </div>

      {/* Metrics with deltas */}
      <div className="grid grid-cols-5 gap-px bg-border border border-border rounded-sm">
        {[
          { label: "Accuracy", value: "98.8", unit: "%", delta: "▲ +0.3", vs: "vs v12", ok: true, up: true },
          { label: "Docs passed", value: "61", unit: "/ 62", delta: "▲ +2", vs: "vs v12", ok: true, up: true },
          { label: "Regressions", value: "1", unit: "", delta: "▲ +1", vs: "vs v12", danger: true },
          { label: "Avg latency", value: "2.1", unit: "s", delta: "—", vs: "flat" },
          { label: "Avg cost", value: "$0.0009", unit: "", delta: "—", vs: "flat" },
        ].map((m) => (
          <div key={m.label} className={`bg-cream px-4 py-3.5 flex flex-col gap-0.5 ${m.danger ? "bg-vermillion-3/60" : ""}`}>
            <span className={`font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase ${m.danger ? "text-vermillion-2" : "text-ink-4"}`}>{m.label}</span>
            <span className={`font-display text-[24px] font-medium leading-none tracking-tight ${m.ok ? "text-green" : m.danger ? "text-vermillion-2" : "text-ink"}`} style={{ fontVariationSettings: "'opsz' 72, 'SOFT' 30" }}>
              {m.value}{m.unit && <span className="font-body text-[11px] font-normal text-ink-3 ml-0.5 tracking-normal">{m.unit}</span>}
            </span>
            <span className={`font-mono text-[10px] font-medium mt-1 ${m.up ? "text-green" : m.danger ? "text-vermillion-2" : "text-ink-4"}`}>
              {m.delta} <span className="text-ink-4 font-normal">{m.vs}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );

  const sidebar = (
    <div className="flex flex-col border border-border rounded-sm overflow-hidden bg-cream h-full">
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border">
        <span className="font-mono text-[9.5px] font-medium tracking-[0.14em] uppercase text-ink-4">Corpus</span>
        <span className="font-mono text-[11px] text-ink-2">62 docs</span>
      </div>
      <div className="px-3 py-2 border-b border-border flex items-center gap-2">
        <div className="flex-1 flex items-center gap-1.5 px-2.5 py-1.5 bg-cream-2 border border-border rounded-sm">
          <span className="text-ink-4 text-[12px]">⌕</span>
          <input className="flex-1 bg-transparent border-none outline-none font-mono text-[11px] text-ink placeholder:text-ink-4" placeholder="filter by name or field…" />
        </div>
        <button className="font-mono text-[10px] text-ink-3 px-2 py-1 rounded-sm hover:bg-cream-2 transition-colors">
          <span className="text-ink-4 uppercase tracking-[0.1em] text-[9px]">Sort</span> severity <span className="text-ink-4">▾</span>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {CORPUS_DOCS.map((group) => (
          <div key={group.group}>
            <div className={`px-3.5 py-1.5 font-mono text-[9px] font-medium tracking-[0.12em] uppercase ${group.items[0]?.status === "regress" ? "text-vermillion-2 bg-vermillion-3/40" : "text-ink-4"}`}>
              {group.group}
            </div>
            {group.items.map((doc) => (
              <button
                key={doc.name}
                type="button"
                onClick={() => setSelectedDoc(doc.name)}
                className={`w-full grid items-center gap-2 px-3.5 py-2 border-b border-dotted border-border text-left cursor-pointer transition-colors ${
                  doc.name === selectedDoc ? "bg-cream-2" : "hover:bg-cream-2/50"
                } ${doc.status === "regress" ? "border-l-[3px] border-l-vermillion-2 pl-[calc(0.875rem-3px)]" : ""}`}
                style={{ gridTemplateColumns: "14px 1fr auto auto" }}
              >
                <span className={`font-mono text-[11px] font-medium ${doc.status === "regress" ? "text-vermillion-2" : "text-green"}`}>
                  {doc.status === "regress" ? "!" : "✓"}
                </span>
                <span className="font-mono text-[11px] text-ink truncate">{doc.name}</span>
                <span className="font-mono text-[10px] text-ink-4">{doc.meta}</span>
                <span className={`font-mono text-[10px] font-medium ${doc.status === "regress" ? "text-vermillion-2" : "text-green"}`}>{doc.score}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="px-3.5 py-2 border-t border-border font-mono text-[10px] text-ink-4 flex justify-between">
        <span>scroll for 52 more</span>
        <span>sort: severity</span>
      </div>
    </div>
  );

  return (
    <DetailLayout header={header} metricsStrip={metricsStrip} sidebar={sidebar} sidebarWidth="0.7fr">
      {/* Selected doc detail */}
      <div className="flex flex-col border border-border rounded-sm overflow-hidden bg-cream h-full">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-baseline gap-2.5">
            <span className="font-mono text-[9.5px] font-medium tracking-[0.14em] uppercase text-ink-4">Detail</span>
            <span className="font-mono text-[12px] text-ink font-medium">{selectedDoc}</span>
            <span className={`font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm uppercase tracking-[0.08em] ${selectedDoc === "invoice-0087.pdf" ? "bg-vermillion-3 text-vermillion-2" : "bg-green/[0.12] text-green"}`}>
              {selectedDoc === "invoice-0087.pdf" ? "regressed" : "pass"}
            </span>
          </div>
          <button className="font-mono text-[10px] text-ink-3 px-2 py-1 rounded-sm border border-border hover:border-ink hover:text-ink transition-colors">
            open trace →
          </button>
        </div>

        {/* Field comparison table */}
        <div className="flex-1 overflow-y-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-4 py-2 font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4">Field</th>
                <th className="text-left px-4 py-2 font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4">Expected</th>
                <th className="text-left px-4 py-2 font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4">Actual</th>
                <th className="text-right px-4 py-2 font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4">Conf</th>
                <th className="text-center px-4 py-2 font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4">Pass</th>
              </tr>
            </thead>
            <tbody>
              {FIELDS_0087.map((f) => (
                <tr key={f.name} className={`border-b border-dotted border-border ${!f.pass ? "bg-vermillion-3/50" : ""}`}>
                  <td className="px-4 py-2 font-mono text-[11px] text-ink font-medium">{f.name}</td>
                  <td className="px-4 py-2 font-mono text-[11px] text-ink-2">{f.expected}</td>
                  <td className={`px-4 py-2 font-mono text-[11px] ${f.pass ? "text-ink-2" : "text-vermillion-2 font-medium"}`}>{f.actual}</td>
                  <td className={`px-4 py-2 text-right font-mono text-[10px] ${f.pass ? "text-green" : "text-vermillion-2"}`}>{f.conf.toFixed(2)}</td>
                  <td className="px-4 py-2 text-center font-mono text-[11px]">
                    <span className={f.pass ? "text-green" : "text-vermillion-2"}>{f.pass ? "✓" : "✗"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </DetailLayout>
  );
}
