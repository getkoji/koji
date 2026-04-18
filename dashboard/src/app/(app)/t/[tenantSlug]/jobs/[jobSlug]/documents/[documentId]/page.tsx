"use client";

import { useState } from "react";
import type { TraceStage, TraceField } from "@/lib/types";
import { Timeline } from "@/components/surfaces/trace/Timeline";
import { StageDetail } from "@/components/surfaces/trace/StageDetail";
import { DetailLayout, Breadcrumbs, PageHeader } from "@/components/layouts";

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="uppercase tracking-[0.08em] text-[9.5px]">{label}</span>
      <span className="text-ink">{value}</span>
    </>
  );
}

function MetaDot() {
  return <span className="text-cream-4 text-[8px]">●</span>;
}

function GhostButton({ children }: { children: React.ReactNode }) {
  return (
    <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-cream text-ink border border-border-strong hover:border-ink transition-colors">
      {children}
    </button>
  );
}

const STAGES: TraceStage[] = [
  { name: "Ingress", durationMs: 212, startPct: 0, widthPct: 1.2, status: "ok", meta: "s3://acme-invoices-inbound · 114 KB" },
  { name: "Integrity check", durationMs: 5, startPct: 1.2, widthPct: 0.6, status: "ok", meta: "valid PDF · 1 page" },
  { name: "OCR quality", durationMs: 20, startPct: 1.8, widthPct: 0.6, status: "ok", meta: "text density 0.94 · en 0.99" },
  { name: "Classify", durationMs: 85, startPct: 2.4, widthPct: 0.6, status: "ok", meta: "invoice 0.89 · receipt 0.06" },
  { name: "Extract", durationMs: 2273, startPct: 3.0, widthPct: 12.7, status: "warn", meta: "gpt-4o-mini · 4 chunks · 8 fields" },
  { name: "Normalize", durationMs: 15, startPct: 15.7, widthPct: 0.6, status: "ok", meta: "3 transforms applied" },
  { name: "Validate", durationMs: 8, startPct: 16.3, widthPct: 0.6, status: "fail", meta: "3 / 4 rules passed" },
  { name: "Review queue", durationMs: 12, startPct: 16.9, widthPct: 0.6, status: "warn", meta: "1 field flagged by validation" },
  { name: "Human review", durationMs: 14423, startPct: 17.5, widthPct: 80.8, status: "ok", meta: "accepted by frank@getkoji.dev · override applied" },
  { name: "Emit", durationMs: 203, startPct: 98.3, widthPct: 1.2, status: "ok", meta: "webhook → acme.com · 200 OK · 145ms" },
];

const FIELDS: TraceField[] = [
  { name: "invoice_number", value: '"2026-087"', chunk: "ch 01", confidence: 0.99 },
  { name: "invoice_date", value: '"2026-03-28"', chunk: "ch 01", confidence: 0.99 },
  { name: "vendor", value: '"Brighton & Co. Contractors"', chunk: "ch 02", confidence: 0.97 },
  { name: "bill_to", value: '"Vantage Capital"', chunk: "ch 02", confidence: 0.96 },
  { name: "line_items", value: "2 items", chunk: "ch 03", confidence: 0.94 },
  { name: "subtotal", value: "3950.00", chunk: "ch 04", confidence: 0.99 },
  { name: "tax", value: "300.00", chunk: "ch 04", confidence: 0.99 },
  { name: "total_amount", value: "500.00", chunk: "ch 03", confidence: 0.92, wrong: true, diagnostic: "Model picked chunk 03 (services) because the new \"BALANCE DUE\" alias matched \"PREVIOUS BALANCE DUE\" in that chunk." },
];

export default function TraceViewPage() {
  const [selectedStage, setSelectedStage] = useState(4);

  const header = (
    <>
      <Breadcrumbs
        items={[
          { label: "acme-invoices", href: "#" },
          { label: "Jobs", href: "#" },
          { label: "job-20260413-1442", href: "#" },
          { label: "invoice-0087.pdf" },
        ]}
      />
      <PageHeader
        title="invoice-0087.pdf"
        badge={
          <span className="font-mono text-[10px] font-medium px-2.5 py-1 rounded-sm tracking-[0.08em] uppercase bg-green/[0.12] text-green">
            resolved
          </span>
        }
        meta={
          <>
            <MetaItem label="Trace" value="trc_8f3a91c2e5d1b7a6" />
            <MetaDot />
            <MetaItem label="Started" value="2026-04-13 15:42:18.203" />
            <MetaDot />
            <MetaItem label="Schema" value="invoice v13" />
          </>
        }
        actions={
          <>
            <GhostButton>Copy trace ID</GhostButton>
            <GhostButton>Download JSON</GhostButton>
            <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors">
              Open doc ↗
            </button>
          </>
        }
      />
    </>
  );

  const metricsStrip = (
    <div className="grid grid-cols-5 gap-px bg-border border border-border rounded-sm mb-1">
      {[
        { label: "Total duration", value: "17.8", unit: "s", sub: "14.4s human review" },
        { label: "Stages", value: "9", unit: "/ 9", sub: "all complete", ok: true },
        { label: "Fields extracted", value: "8", unit: "/ 8", sub: "1 corrected by review", warn: true },
        { label: "LLM cost", value: "$0.00095", unit: "", sub: "gpt-4o-mini · 3,480 tok" },
        { label: "Emit", value: "200", unit: "OK", sub: "acme.com/hooks/extracted", ok: true },
      ].map((m) => (
        <div key={m.label} className="bg-cream px-4 py-3.5 flex flex-col gap-0.5">
          <span className="font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase text-ink-4">
            {m.label}
          </span>
          <span
            className={`font-display text-[22px] font-medium leading-none tracking-tight ${
              m.ok ? "text-green" : "text-ink"
            }`}
            style={{ fontVariationSettings: "'opsz' 72, 'SOFT' 30" }}
          >
            {m.value}
            {m.unit && (
              <span className="font-body text-[11px] font-normal text-ink-3 ml-0.5 tracking-normal">
                {m.unit}
              </span>
            )}
          </span>
          <span className={`font-mono text-[10px] mt-0.5 ${m.warn ? "text-[#B6861A]" : "text-ink-4"}`}>
            {m.sub}
          </span>
        </div>
      ))}
    </div>
  );

  return (
    <DetailLayout
      header={header}
      metricsStrip={metricsStrip}
      sidebar={
        <Timeline
          stages={STAGES}
          selectedIndex={selectedStage}
          onSelect={setSelectedStage}
        />
      }
      sidebarWidth="0.42fr"
    >
      <StageDetail
        stage={STAGES[selectedStage]!}
        stageIndex={selectedStage}
        totalStages={STAGES.length}
        onPrev={() => setSelectedStage((i) => Math.max(0, i - 1))}
        onNext={() => setSelectedStage((i) => Math.min(STAGES.length - 1, i + 1))}
        fields={FIELDS}
      />
    </DetailLayout>
  );
}
