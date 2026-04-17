"use client";

import type { TraceStage } from "@/lib/mock-trace";

const dotColor = { ok: "bg-green", warn: "bg-[#B6861A]", fail: "bg-vermillion-2" };
const dotRing = {
  ok: "shadow-[0_0_0_2px_rgba(62,122,62,0.12)]",
  warn: "shadow-[0_0_0_2px_rgba(182,134,26,0.14)]",
  fail: "shadow-[0_0_0_2px_rgba(153,39,24,0.14)]",
};
const barColor = { ok: "bg-green", warn: "bg-[#B6861A]", fail: "bg-vermillion-2" };

export function Timeline({
  stages,
  selectedIndex,
  onSelect,
}: {
  stages: TraceStage[];
  selectedIndex: number;
  onSelect: (i: number) => void;
}) {
  return (
    <section className="flex flex-col border border-border rounded-sm overflow-hidden bg-cream">
      <header className="flex items-center justify-between px-4 py-3 border-b border-border">
        <span className="font-mono text-[9.5px] font-medium tracking-[0.14em] uppercase text-ink-4">
          Timeline
        </span>
        <span className="font-mono text-[10.5px] text-ink-2">
          <span className="text-ink font-medium">17,854</span> ms total
        </span>
      </header>
      <div className="flex flex-col py-1">
        {stages.map((s, i) => (
          <button
            key={s.name}
            type="button"
            onClick={() => onSelect(i)}
            className={`grid gap-2.5 px-4 py-2 cursor-pointer transition-colors border-l-[3px] text-left ${
              i === selectedIndex
                ? "bg-cream-2 border-l-vermillion-2"
                : "border-l-transparent hover:bg-cream-2"
            }`}
            style={{ gridTemplateColumns: "14px 1fr" }}
          >
            <span
              className={`w-2.5 h-2.5 rounded-full mt-[5px] shrink-0 ${dotColor[s.status]} ${dotRing[s.status]}`}
            />
            <div className="min-w-0">
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <span className="text-[12.5px] font-medium text-ink truncate">{s.name}</span>
                <span className="font-mono text-[10px] text-ink-3 tabular-nums shrink-0">
                  {s.durationMs.toLocaleString()} ms
                </span>
              </div>
              <div className="relative h-1.5 bg-cream-2 rounded-[1px] mb-1">
                {i === selectedIndex && <div className="absolute inset-0 bg-cream-3 rounded-[1px]" />}
                <div
                  className={`absolute top-0 bottom-0 rounded-[1px] min-w-[2px] ${barColor[s.status]}`}
                  style={{ left: `${s.startPct}%`, width: `${s.widthPct}%` }}
                />
              </div>
              <div className="font-mono text-[10px] text-ink-4 truncate">{s.meta}</div>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
