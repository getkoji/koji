"use client";

import { useState } from "react";
import { MOCK_STAGES } from "@/lib/mock-trace";
import { Timeline } from "@/components/surfaces/trace/Timeline";
import { StageDetail } from "@/components/surfaces/trace/StageDetail";

export default function TraceViewPage() {
  const [selectedStage, setSelectedStage] = useState(4);

  return (
    <div className="flex flex-col gap-6">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 font-mono text-[11px] text-ink-4">
        <a href="#" className="text-ink-3 hover:text-vermillion-2 transition-colors">acme-invoices</a>
        <span className="text-cream-4">/</span>
        <a href="#" className="text-ink-3 hover:text-vermillion-2 transition-colors">Jobs</a>
        <span className="text-cream-4">/</span>
        <a href="#" className="text-ink-3 hover:text-vermillion-2 transition-colors">job-20260413-1442</a>
        <span className="text-cream-4">/</span>
        <span className="text-ink font-medium">invoice-0087.pdf</span>
      </nav>

      {/* Document header */}
      <div className="flex items-start justify-between gap-8 mt-1">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline gap-3">
            <h1
              className="font-display text-[30px] font-medium leading-none tracking-tight text-ink m-0"
              style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
            >
              invoice-0087.pdf
            </h1>
            <span className="font-mono text-[10px] font-medium px-2.5 py-1 rounded-sm tracking-[0.08em] uppercase bg-green/[0.12] text-green">
              resolved
            </span>
          </div>
          <div className="flex items-center gap-2.5 font-mono text-[11px] text-ink-4">
            <span className="uppercase tracking-[0.08em] text-[9.5px]">Trace</span>
            <span className="text-ink">trc_8f3a91c2e5d1b7a6</span>
            <span className="text-cream-4 text-[8px]">●</span>
            <span className="uppercase tracking-[0.08em] text-[9.5px]">Started</span>
            <span className="text-ink">2026-04-13 15:42:18.203</span>
            <span className="text-cream-4 text-[8px]">●</span>
            <span className="uppercase tracking-[0.08em] text-[9.5px]">Schema</span>
            <span className="text-ink">invoice v13</span>
            <span className="text-cream-4 text-[8px]">●</span>
            <span className="uppercase tracking-[0.08em] text-[9.5px]">Source</span>
            <span className="text-ink">s3://acme-invoices-inbound</span>
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-cream text-ink border border-border-strong hover:border-ink transition-colors">
            Copy trace ID
          </button>
          <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-cream text-ink border border-border-strong hover:border-ink transition-colors">
            Download JSON
          </button>
          <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors">
            Open doc ↗
          </button>
        </div>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-5 gap-px bg-border border border-border rounded-sm">
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

      {/* Two-column workspace: timeline | stage detail */}
      <div className="grid gap-4 min-h-[640px]" style={{ gridTemplateColumns: "0.42fr 1fr" }}>
        <Timeline
          stages={MOCK_STAGES}
          selectedIndex={selectedStage}
          onSelect={setSelectedStage}
        />
        <StageDetail
          stage={MOCK_STAGES[selectedStage]!}
          stageIndex={selectedStage}
          totalStages={MOCK_STAGES.length}
          onPrev={() => setSelectedStage((i) => Math.max(0, i - 1))}
          onNext={() => setSelectedStage((i) => Math.min(MOCK_STAGES.length - 1, i + 1))}
        />
      </div>
    </div>
  );
}
