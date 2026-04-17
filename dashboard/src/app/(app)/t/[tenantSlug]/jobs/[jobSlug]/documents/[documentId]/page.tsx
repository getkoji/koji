"use client";

import { useState } from "react";
import { MOCK_STAGES } from "@/lib/mock-trace";
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
          stages={MOCK_STAGES}
          selectedIndex={selectedStage}
          onSelect={setSelectedStage}
        />
      }
      sidebarWidth="0.42fr"
    >
      <StageDetail
        stage={MOCK_STAGES[selectedStage]!}
        stageIndex={selectedStage}
        totalStages={MOCK_STAGES.length}
        onPrev={() => setSelectedStage((i) => Math.max(0, i - 1))}
        onNext={() => setSelectedStage((i) => Math.min(MOCK_STAGES.length - 1, i + 1))}
      />
    </DetailLayout>
  );
}
