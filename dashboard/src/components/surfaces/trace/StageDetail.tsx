"use client";

import type { TraceField, TraceStage } from "@/lib/types";

export function StageDetail({
  stage,
  stageIndex,
  totalStages,
  onPrev,
  onNext,
  fields,
}: {
  stage: TraceStage;
  stageIndex: number;
  totalStages: number;
  onPrev: () => void;
  onNext: () => void;
  fields: TraceField[];
}) {
  const isExtract = stage.name === "Extract";

  return (
    <section className="flex flex-col border border-border rounded-sm overflow-hidden bg-cream">
      {/* Header */}
      <header className="flex items-center justify-between gap-4 px-4 py-3.5 border-b border-border">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[10px] font-medium tracking-[0.1em] uppercase text-ink-4">
              stage {String(stageIndex + 1).padStart(2, "0")} of {String(totalStages).padStart(2, "0")}
            </span>
            <h2
              className="font-display text-xl font-medium text-ink m-0 tracking-tight"
              style={{ fontVariationSettings: "'opsz' 96, 'SOFT' 50" }}
            >
              {stage.name}
            </h2>
          </div>
          <div className="font-mono text-[10.5px] text-ink-3 flex items-center gap-2">
            <span>{stage.durationMs.toLocaleString()} ms</span>
            {isExtract && (
              <>
                <span className="text-cream-4 text-[8px]">●</span>
                <span>gpt-4o-mini</span>
              </>
            )}
          </div>
        </div>
        <div className="inline-flex gap-1 font-mono text-[10px]">
          <button
            onClick={onPrev}
            disabled={stageIndex === 0}
            className="px-2 py-1 text-ink-3 rounded-sm border border-border bg-cream hover:border-ink hover:text-ink transition-colors disabled:opacity-30"
          >
            ← prev
          </button>
          <button
            onClick={onNext}
            disabled={stageIndex === totalStages - 1}
            className="px-2 py-1 text-ink-3 rounded-sm border border-border bg-cream hover:border-ink hover:text-ink transition-colors disabled:opacity-30"
          >
            next →
          </button>
        </div>
      </header>

      {/* Extract-specific stats row */}
      {isExtract && (
        <div className="grid grid-cols-4 gap-px bg-border border-b border-border">
          {[
            { k: "Model", v: "gpt-4o-mini" },
            { k: "Chunks", v: "4" },
            { k: "Tokens", v: "3,240 in · 240 out" },
            { k: "Cost", v: "$0.00095" },
          ].map((s) => (
            <div key={s.k} className="bg-cream px-3.5 py-2.5 flex flex-col gap-0.5">
              <span className="font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4">
                {s.k}
              </span>
              <span className="font-mono text-[13px] text-ink font-medium">{s.v}</span>
            </div>
          ))}
        </div>
      )}

      {/* Body */}
      {isExtract ? <ExtractBody fields={fields} /> : <GenericBody stage={stage} />}

      {/* Raw I/O */}
      {isExtract && (
        <div className="border-t border-border bg-cream">
          {[
            { label: "Show raw prompt", sub: "3,240 tokens · 4 chunks" },
            { label: "Show raw response", sub: "240 tokens · JSON" },
            { label: "Show request headers", sub: "openai-api-version, model, temperature: 0" },
          ].map((r) => (
            <button
              key={r.label}
              className="flex items-center gap-2 w-full px-4 py-2 border-b border-border last:border-none font-mono text-[11px] text-ink-3 hover:bg-cream-2 hover:text-ink transition-colors text-left"
            >
              <span className="text-ink-4 text-[9px] w-2.5">▸</span>
              <span className="text-ink font-medium">{r.label}</span>
              <span className="ml-auto text-ink-4 text-[10px]">{r.sub}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function ExtractBody({ fields }: { fields: TraceField[] }) {
  // The Brighton & Co. invoice mockup + chunk overlays that used to live on
  // the left were pure fiction — no chunk→document-region mapping exists in
  // the pipeline yet. The panel comes back when extract emits real bbox
  // coordinates alongside each field.
  return (
    <div className="flex-1 bg-cream flex flex-col overflow-hidden min-h-[420px]">
      <div className="flex items-baseline justify-between px-4 py-3 border-b border-border">
        <span className="font-mono text-[9px] font-medium tracking-[0.14em] uppercase text-ink-4">
          Fields · extracted by model
        </span>
        <span className="font-mono text-[10px] text-ink-3">
          {fields.length} / {fields.length}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {fields.map((f) => (
          <FieldRow key={f.name} field={f} />
        ))}
      </div>
    </div>
  );
}

function FieldRow({ field }: { field: TraceField }) {
  return (
    <div
      className={`grid items-baseline gap-2.5 px-4 py-2 border-b border-dotted border-border text-[11.5px] ${
        field.wrong ? "bg-vermillion-3 border-l-[3px] border-l-vermillion-2 pl-[calc(1rem-3px)]" : ""
      }`}
      style={{ gridTemplateColumns: "auto 1fr auto" }}
    >
      <span className="font-mono text-[11px] text-ink font-medium">{field.name}</span>
      <span className={`font-mono text-[11px] truncate min-w-0 ${field.wrong ? "text-vermillion-2 font-medium" : "text-ink-2"}`}>
        {field.value}
      </span>
      <span className="font-mono text-[9.5px] text-ink-4 tracking-[0.05em] uppercase shrink-0">
        {field.chunk}{" "}
        <span className={field.wrong ? "text-vermillion-2" : "text-green"}>{field.confidence.toFixed(2)}</span>
      </span>
      {field.diagnostic && (
        <div className="col-span-full mt-2 px-3 py-2 bg-cream border-l-2 border-l-vermillion-2 rounded-r-sm text-[11px] text-ink-2 leading-[1.5]">
          <span className="font-mono text-[9px] font-medium tracking-[0.1em] uppercase text-vermillion-2 mr-1.5">
            Why this is wrong
          </span>
          {field.diagnostic}
        </div>
      )}
    </div>
  );
}

function GenericBody({ stage }: { stage: TraceStage }) {
  return (
    <div className="flex-1 flex items-center justify-center p-8 text-ink-4 font-mono text-[11px]">
      Stage detail for "{stage.name}" — {stage.durationMs}ms, {stage.status}
    </div>
  );
}
