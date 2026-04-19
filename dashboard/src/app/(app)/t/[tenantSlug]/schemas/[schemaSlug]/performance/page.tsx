"use client";

import { useParams } from "next/navigation";

// ── Mock data (swap for real schema_runs when available) ──

const VERSIONS = [
  { version: 9, accuracy: 92.1, date: "Mar 28" },
  { version: 10, accuracy: 94.8, date: "Apr 2" },
  { version: 11, accuracy: 96.3, date: "Apr 7" },
  { version: 12, accuracy: 98.1, date: "Apr 12" },
  { version: 13, accuracy: 97.8, date: "Apr 17" },
];

const FIELDS = [
  { name: "insurer_name",         scores: [88, 92, 95, 98, 98] },
  { name: "named_insured",        scores: [95, 96, 98, 99, 99] },
  { name: "policy_number",        scores: [90, 93, 96, 98, 97] },
  { name: "policy_type",          scores: [85, 90, 94, 97, 96] },
  { name: "effective_date",       scores: [94, 96, 97, 99, 99] },
  { name: "expiration_date",      scores: [93, 95, 97, 98, 98] },
  { name: "total_premium",        scores: [88, 91, 94, 97, 95] },
  { name: "each_occurrence_limit",scores: [90, 93, 95, 98, 98] },
  { name: "general_aggregate",    scores: [87, 90, 93, 96, 94] },
];

const MODELS = [
  { name: "gpt-4o", accuracy: 97.8, latency: "2.3s", cost: "$0.032" },
  { name: "claude-sonnet-4-20250514", accuracy: 98.2, latency: "2.8s", cost: "$0.028" },
  { name: "gpt-4o-mini", accuracy: 94.1, latency: "1.1s", cost: "$0.008" },
];

// ── Helpers ──

function heatColor(score: number): string {
  if (score >= 98) return "bg-green/25 text-green";
  if (score >= 95) return "bg-green/10 text-green";
  if (score >= 90) return "bg-yellow-500/15 text-yellow-600";
  return "bg-vermillion-3 text-vermillion-2";
}

// ── SVG Chart ──

function TrendChart({ data }: { data: typeof VERSIONS }) {
  const w = 600, h = 200, px = 50, py = 20;
  const plotW = w - px * 2, plotH = h - py * 2;
  const minY = 90, maxY = 100;

  function x(i: number) { return px + (i / (data.length - 1)) * plotW; }
  function y(v: number) { return py + plotH - ((v - minY) / (maxY - minY)) * plotH; }

  const linePath = data.map((d, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(d.accuracy)}`).join(" ");
  const areaPath = `${linePath} L ${x(data.length - 1)} ${y(minY)} L ${x(0)} ${y(minY)} Z`;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ maxHeight: 240 }}>
      <defs>
        <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#C33520" stopOpacity="0.15" />
          <stop offset="100%" stopColor="#C33520" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Grid lines */}
      {[92, 94, 96, 98, 100].map((v) => (
        <g key={v}>
          <line x1={px} y1={y(v)} x2={w - px} y2={y(v)} stroke="#ECE3D0" strokeWidth="1" />
          <text x={px - 8} y={y(v) + 4} textAnchor="end" className="fill-ink-4" style={{ fontSize: 10, fontFamily: "var(--font-mono)" }}>{v}%</text>
        </g>
      ))}

      {/* 95% baseline */}
      <line x1={px} y1={y(95)} x2={w - px} y2={y(95)} stroke="#998E78" strokeWidth="1" strokeDasharray="4 3" />
      <text x={w - px + 6} y={y(95) + 4} className="fill-ink-4" style={{ fontSize: 9, fontFamily: "var(--font-mono)" }}>95%</text>

      {/* Area fill */}
      <path d={areaPath} fill="url(#areaGrad)" />

      {/* Line */}
      <path d={linePath} fill="none" stroke="#C33520" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />

      {/* Dots + version labels */}
      {data.map((d, i) => (
        <g key={d.version}>
          <circle cx={x(i)} cy={y(d.accuracy)} r={i === data.length - 1 ? 5 : 3} fill="#C33520" stroke="#F4EEE2" strokeWidth="2" />
          <text x={x(i)} y={h - 4} textAnchor="middle" className="fill-ink-4" style={{ fontSize: 10, fontFamily: "var(--font-mono)" }}>v{d.version}</text>
        </g>
      ))}
    </svg>
  );
}

// ── Page ──

export default function PerformancePage() {
  const params = useParams();
  const schemaSlug = params.schemaSlug as string;

  const current = VERSIONS[VERSIONS.length - 1]!;
  const prev = VERSIONS[VERSIONS.length - 2]!;
  const delta = current.accuracy - prev.accuracy;
  const regressed = delta < 0;

  return (
    <div className="overflow-y-auto h-[calc(100vh-60px)]">
      <div className="px-8 pt-6 pb-12 max-w-[1100px]">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-1.5 font-mono text-[11px] text-ink-4 mb-3">
          <span className="text-ink-3">{schemaSlug}</span>
          <span className="text-cream-4">/</span>
          <span className="text-ink font-medium">Performance</span>
        </nav>

        <h1 className="font-display text-[28px] font-medium leading-none tracking-tight text-ink mb-6"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}>
          Performance
        </h1>

        {/* ── 1. Metrics strip ── */}
        <div className="grid grid-cols-5 gap-px bg-border border border-border rounded-sm mb-8">
          {[
            { label: "Accuracy", value: `${current.accuracy}%`, delta: `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}`, up: !regressed },
            { label: "Corpus", value: "38", delta: "+4", up: true },
            { label: "Active model", value: "gpt-4o", delta: null, up: true },
            { label: "Fields tracked", value: `${FIELDS.length} / ${FIELDS.length}`, delta: null, up: true },
            { label: "Last run", value: current.date, delta: `v${current.version}`, up: true },
          ].map((m) => (
            <div key={m.label} className="bg-cream px-4 py-3.5 flex flex-col gap-0.5">
              <span className="font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4">{m.label}</span>
              <span className="font-display text-[22px] font-medium text-ink leading-none tracking-tight"
                style={{ fontVariationSettings: "'opsz' 72, 'SOFT' 30" }}>
                {m.value}
              </span>
              {m.delta && (
                <span className={`font-mono text-[10px] font-medium ${m.up ? "text-green" : "text-vermillion-2"}`}>
                  {m.delta}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* ── 2. Accuracy over time ── */}
        <div className="mb-8">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="font-display text-[18px] font-medium tracking-tight text-ink"
              style={{ fontVariationSettings: "'opsz' 96, 'SOFT' 50" }}>
              Accuracy over time
            </h2>
            <div className="flex gap-1 border border-border rounded-sm p-0.5">
              {["Field", "Doc", "Composite"].map((t, i) => (
                <button key={t} className={`px-2.5 py-1 rounded-sm text-[11px] font-medium transition-colors ${i === 0 ? "bg-ink text-cream" : "text-ink-3 hover:text-ink"}`}>
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="border border-border rounded-sm bg-cream p-4">
            <TrendChart data={VERSIONS} />
          </div>

          {/* Regression annotation */}
          {regressed && (
            <div className="mt-3 border-l-2 border-vermillion-2 bg-vermillion-3/20 rounded-r-sm px-4 py-3">
              <div className="font-mono text-[10px] font-medium text-vermillion-2 uppercase tracking-[0.08em] mb-1">Regression detected</div>
              <div className="text-[12px] text-ink">
                v{current.version} dropped {Math.abs(delta).toFixed(1)}pt from v{prev.version}.
                Caused by <span className="font-mono font-medium text-vermillion-2">total_premium</span> on{" "}
                <span className="font-mono font-medium">invoice-0087.pdf</span> — alias matched wrong chunk.
              </div>
            </div>
          )}
        </div>

        {/* ── 3. Two-column grid ── */}
        <div className="grid gap-6" style={{ gridTemplateColumns: "1.2fr 1fr" }}>

          {/* Per-field heatmap */}
          <div>
            <h2 className="font-display text-[18px] font-medium tracking-tight text-ink mb-4"
              style={{ fontVariationSettings: "'opsz' 96, 'SOFT' 50" }}>
              Per-field accuracy
            </h2>
            <div className="border border-border rounded-sm overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="bg-cream-2/50">
                    <th className="text-left px-3 py-2 font-mono text-[9px] font-medium tracking-[0.1em] uppercase text-ink-4">Field</th>
                    {VERSIONS.map((v) => (
                      <th key={v.version} className={`px-2 py-2 font-mono text-[9px] font-medium text-center ${v.version === current.version ? "text-ink" : "text-ink-4"}`}>
                        v{v.version}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {FIELDS.map((f) => (
                    <tr key={f.name} className="border-t border-border">
                      <td className="px-3 py-1.5 font-mono text-[10px] text-ink">{f.name}</td>
                      {f.scores.map((s, i) => (
                        <td key={i} className="px-1 py-1 text-center">
                          <span className={`inline-block font-mono text-[10px] font-medium px-1.5 py-0.5 rounded-sm ${heatColor(s)}`}>
                            {s}
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Legend */}
              <div className="px-3 py-2 border-t border-border bg-cream-2/30 flex items-center gap-3">
                <span className="font-mono text-[8px] text-ink-4 uppercase">Accuracy</span>
                <div className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded-sm bg-vermillion-3" />
                  <span className="font-mono text-[8px] text-ink-4">&lt;90</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded-sm bg-yellow-500/15" />
                  <span className="font-mono text-[8px] text-ink-4">90-95</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded-sm bg-green/10" />
                  <span className="font-mono text-[8px] text-ink-4">95-98</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded-sm bg-green/25" />
                  <span className="font-mono text-[8px] text-ink-4">98+</span>
                </div>
              </div>
            </div>
          </div>

          {/* Model comparison */}
          <div>
            <h2 className="font-display text-[18px] font-medium tracking-tight text-ink mb-4"
              style={{ fontVariationSettings: "'opsz' 96, 'SOFT' 50" }}>
              Model comparison
            </h2>
            <div className="border border-border rounded-sm overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="bg-cream-2/50">
                    {["Model", "Accuracy", "Latency", "Cost/doc"].map((h) => (
                      <th key={h} className="text-left px-3 py-2 font-mono text-[9px] font-medium tracking-[0.1em] uppercase text-ink-4">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {MODELS.map((m, i) => (
                    <tr key={m.name} className={`border-t border-border ${i === 0 ? "bg-cream-2/30" : ""}`}>
                      <td className="px-3 py-2 font-mono text-[11px] text-ink">
                        {m.name}
                        {i === 0 && <span className="font-mono text-[8px] text-ink-4 bg-cream-2 px-1 py-0.5 rounded-sm uppercase ml-1.5">active</span>}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`font-mono text-[11px] font-medium ${m.accuracy >= 97 ? "text-green" : m.accuracy >= 95 ? "text-ink" : "text-ink-3"}`}>
                          {m.accuracy}%
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-ink-3">{m.latency}</td>
                      <td className="px-3 py-2 font-mono text-[11px] text-ink-3">{m.cost}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[10px] text-ink-4 mt-2">
              Based on the current corpus ({FIELDS.length} fields, 38 documents).
              Run a benchmark against additional models to compare.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
