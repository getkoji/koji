"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useCallback, useState } from "react";
import { BarChart3, FileQuestion } from "lucide-react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { EmptyState } from "@/components/shared/EmptyState";

// ── Types ──

interface PerformanceRun {
  id: string;
  versionNumber: number | null;
  accuracy: string | null;
  docsTotal: number;
  docsPassed: number;
  regressionsCount: number;
  durationMs: number | null;
  completedAt: string | null;
  createdAt: string;
}

interface PerRunFieldAccuracy {
  runId: string;
  fields: Record<string, number>;
}

interface PerformanceData {
  runs: PerformanceRun[];
  perRunFieldAccuracy: PerRunFieldAccuracy[];
  corpusCount: number;
}

// ── Helpers ──

function heatColor(score: number): string {
  if (score >= 98) return "bg-green/25 text-green";
  if (score >= 95) return "bg-green/10 text-green";
  if (score >= 90) return "bg-yellow-500/15 text-yellow-600";
  return "bg-vermillion-3 text-vermillion-2";
}

function timeAgo(d: string): string {
  const ms = Date.now() - new Date(d).getTime();
  const h = Math.floor(ms / 3600000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── SVG Chart with hover ──

function TrendChart({ data }: { data: Array<{ version: number; accuracy: number; label?: string; date?: string }> }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (data.length === 0) return null;

  const w = 600, h = 220, px = 50, py = 24;
  const plotW = w - px * 2, plotH = h - py * 2 - 20;
  const minY = Math.floor(Math.min(90, ...data.map((d) => d.accuracy))) - 1;
  const maxY = Math.ceil(Math.max(100, ...data.map((d) => d.accuracy))) + 0.5;

  function x(i: number) { return px + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW); }
  function y(v: number) { return py + plotH - ((v - minY) / (maxY - minY)) * plotH; }

  if (data.length === 1) {
    return (
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ maxHeight: 260 }}>
        <circle cx={x(0)} cy={y(data[0]!.accuracy)} r={6} fill="#C33520" stroke="#F4EEE2" strokeWidth="2" />
        <text x={x(0)} y={h - 4} textAnchor="middle" className="fill-ink-4" style={{ fontSize: 10, fontFamily: "var(--font-mono)" }}>{data[0]!.label ?? `v${data[0]!.version}`}</text>
        <text x={x(0)} y={y(data[0]!.accuracy) - 14} textAnchor="middle" className="fill-ink" style={{ fontSize: 13, fontFamily: "var(--font-mono)", fontWeight: 600 }}>{data[0]!.accuracy.toFixed(1)}%</text>
        <text x={w / 2} y={h / 2 + 30} textAnchor="middle" className="fill-ink-4" style={{ fontSize: 11 }}>Run validate again to see trends</text>
      </svg>
    );
  }

  const linePath = data.map((d, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(d.accuracy)}`).join(" ");
  const areaPath = `${linePath} L ${x(data.length - 1)} ${y(minY)} L ${x(0)} ${y(minY)} Z`;

  const range = maxY - minY;
  const gridStep = range > 30 ? 10 : range > 15 ? 5 : 2;
  const gridLines = [];
  for (let v = Math.ceil(minY / gridStep) * gridStep; v <= maxY; v += gridStep) gridLines.push(v);

  const hovered = hoverIdx !== null ? data[hoverIdx] : null;
  const hoveredPrev = hoverIdx !== null && hoverIdx > 0 ? data[hoverIdx - 1] : null;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ maxHeight: 260 }}
        onMouseLeave={() => setHoverIdx(null)}>
        <defs>
          <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#C33520" stopOpacity="0.15" />
            <stop offset="100%" stopColor="#C33520" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Grid */}
        {gridLines.map((v) => (
          <g key={v}>
            <line x1={px} y1={y(v)} x2={w - px} y2={y(v)} stroke="#ECE3D0" strokeWidth="1" />
            <text x={px - 8} y={y(v) + 4} textAnchor="end" style={{ fontSize: 10, fontFamily: "var(--font-mono)", fill: "#998E78" }}>{v}%</text>
          </g>
        ))}

        {/* 95% baseline */}
        <line x1={px} y1={y(95)} x2={w - px} y2={y(95)} stroke="#998E78" strokeWidth="1" strokeDasharray="4 3" />
        <text x={w - px + 6} y={y(95) + 4} style={{ fontSize: 9, fontFamily: "var(--font-mono)", fill: "#998E78" }}>95%</text>

        {/* Area + line */}
        <path d={areaPath} fill="url(#areaGrad)" />
        <path d={linePath} fill="none" stroke="#C33520" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

        {/* Hover crosshair */}
        {hoverIdx !== null && (
          <line x1={x(hoverIdx)} y1={py} x2={x(hoverIdx)} y2={py + plotH} stroke="#C33520" strokeWidth="1" strokeDasharray="3 3" opacity="0.4" />
        )}

        {/* Dots */}
        {data.map((d, i) => (
          <g key={`${d.version}-${i}`}>
            <circle cx={x(i)} cy={y(d.accuracy)}
              r={hoverIdx === i ? 6 : i === data.length - 1 ? 5 : 3}
              fill={hoverIdx === i ? "#C33520" : "#C33520"}
              stroke="#F4EEE2" strokeWidth="2"
              style={{ transition: "r 150ms" }} />
            <text x={x(i)} y={h - 4} textAnchor="middle" style={{ fontSize: 10, fontFamily: "var(--font-mono)", fill: hoverIdx === i ? "#171410" : "#998E78" }}>{d.label ?? `v${d.version}`}</text>
            {/* Invisible hover target */}
            <rect x={x(i) - 25} y={py} width={50} height={plotH + 20} fill="transparent"
              onMouseEnter={() => setHoverIdx(i)} />
          </g>
        ))}
      </svg>

      {/* Hover tooltip */}
      {hovered && hoverIdx !== null && (
        <div className="absolute pointer-events-none bg-ink text-cream rounded-sm px-3 py-2 shadow-lg"
          style={{ left: `${(x(hoverIdx) / w) * 100}%`, top: 8, transform: "translateX(-50%)" }}>
          <div className="font-mono text-[12px] font-medium">{hovered.accuracy.toFixed(1)}%</div>
          <div className="font-mono text-[10px] text-cream/60">
            {hovered.label ?? `v${hovered.version}`}
            {hoveredPrev && (
              <span className={hoveredPrev.accuracy < hovered.accuracy ? " text-green" : " text-vermillion-3"}>
                {" "}{hovered.accuracy > hoveredPrev.accuracy ? "+" : ""}{(hovered.accuracy - hoveredPrev.accuracy).toFixed(1)}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ──

export default function PerformancePage() {
  const params = useParams();
  const pathname = usePathname();
  const schemaSlug = params.schemaSlug as string;
  const tenantSlug = (params.tenantSlug as string | undefined) ?? pathname.match(/^\/t\/([^/]+)/)?.[1] ?? "";

  const { data, loading, error } = useApi(
    useCallback(() => api.get<PerformanceData>(`/api/schemas/${schemaSlug}/performance`), [schemaSlug]),
  );

  const [accMode, setAccMode] = useState<"field" | "doc" | "composite">("field");

  const runs = data?.runs ?? [];
  const perRunFieldAccuracy = data?.perRunFieldAccuracy ?? [];
  const corpusCount = data?.corpusCount ?? 0;

  // ── Not found / API error ──
  // Branch before the "no validate runs" empty state — a 404 on the
  // schema itself would otherwise masquerade as "no runs yet", which
  // lies about the breadcrumb.
  if (error) {
    const notFound = error.message.toLowerCase().includes("not found");
    return (
      <div className="flex flex-col h-[calc(100vh-60px)]">
        <div className="px-8 pt-5 pb-4 border-b border-border shrink-0">
          <nav className="flex items-center gap-1.5 font-mono text-[11px] text-ink-4 mb-2">
            <span className="text-ink-3">{schemaSlug}</span>
            <span className="text-cream-4">/</span>
            <span className="text-ink font-medium">Performance</span>
          </nav>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={<FileQuestion className="w-10 h-10" />}
            title={notFound ? "Schema not found" : "Cannot reach API"}
            description={
              notFound
                ? `No schema with slug "${schemaSlug}" exists in this workspace.`
                : error.message
            }
            action={
              <Link
                href={`/t/${tenantSlug}`}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors"
              >
                Back to schemas
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  // ── Empty state ──
  if (!loading && runs.length === 0) {
    return (
      <div className="h-[calc(100vh-60px)] flex items-center justify-center">
        <div className="text-center max-w-[400px]">
          <BarChart3 className="w-10 h-10 text-ink-4 mx-auto mb-4" />
          <h2 className="font-display text-[20px] font-medium text-ink mb-2" style={{ fontVariationSettings: "'opsz' 96, 'SOFT' 50" }}>
            No validate runs yet
          </h2>
          <p className="text-[13px] text-ink-3 mb-4">
            Run validate against your corpus to see accuracy trends, per-field heatmaps, and regression detection.
          </p>
          <p className="text-[11px] text-ink-4">
            Performance data is generated each time you run validate. The more runs, the richer the trends.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-[calc(100vh-60px)] flex items-center justify-center">
        <div className="animate-pulse font-mono text-[11px] text-ink-4">Loading performance data...</div>
      </div>
    );
  }

  // ── Build chart data from runs ──
  const validRuns = runs.filter((r) => r.accuracy !== null);

  const fieldData = validRuns.map((r, i) => ({
    version: r.versionNumber ?? 0,
    accuracy: parseFloat(r.accuracy!) * 100,
    label: `#${i + 1}`,
  }));

  const docData = validRuns.map((r, i) => ({
    version: r.versionNumber ?? 0,
    accuracy: r.docsTotal > 0 ? (r.docsPassed / r.docsTotal) * 100 : 0,
    label: `#${i + 1}`,
  }));

  const compositeData = fieldData.map((d, i) => ({
    version: d.version,
    accuracy: docData[i] ? d.accuracy * 0.6 + docData[i].accuracy * 0.4 : d.accuracy,
    label: `#${i + 1}`,
  }));

  const chartData = accMode === "field" ? fieldData : accMode === "doc" ? docData : compositeData;

  const current = chartData[chartData.length - 1];
  const prev = chartData.length >= 2 ? chartData[chartData.length - 2] : null;
  const delta = prev ? current!.accuracy - prev.accuracy : 0;
  const regressed = delta < 0;

  const latestRun = runs[runs.length - 1]!;

  // Build heatmap from real per-run field accuracy data
  const allFieldNames = new Set<string>();
  for (const prf of perRunFieldAccuracy) {
    for (const f of Object.keys(prf.fields)) allFieldNames.add(f);
  }
  const heatmapVersions = validRuns.map((_, i) => i + 1);
  const heatmapFields = Array.from(allFieldNames).map((name) => ({
    name,
    scores: perRunFieldAccuracy.map((prf) => prf.fields[name] ?? 100),
  }));

  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      {/* ── Fixed header ── */}
      <div className="px-8 pt-5 pb-4 border-b border-border shrink-0">
        <nav className="flex items-center gap-1.5 font-mono text-[11px] text-ink-4 mb-2">
          <span className="text-ink-3">{schemaSlug}</span>
          <span className="text-cream-4">/</span>
          <span className="text-ink font-medium">Performance</span>
        </nav>

        <h1 className="font-display text-[28px] font-medium leading-none tracking-tight text-ink"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}>
          Performance
        </h1>
        <p className="text-[13px] text-ink-3 mt-1.5 max-w-[60ch]">
          Schema health over time — accuracy trends, per-field heatmap, and regression detection across validate runs.
        </p>

        {/* Metrics strip */}
        <div className="grid grid-cols-5 gap-px bg-border border border-border rounded-sm mt-4">
          {[
            { label: "Accuracy", value: current ? `${current.accuracy.toFixed(1)}%` : "—", delta: prev ? `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}` : null, up: !regressed },
            { label: "Corpus", value: String(corpusCount), delta: null, up: true },
            { label: "Runs", value: String(runs.length), delta: null, up: true },
            { label: "Fields tracked", value: `${heatmapFields.length}`, delta: null, up: true },
            { label: "Last run", value: latestRun.completedAt ? timeAgo(latestRun.completedAt) : "—", delta: current ? `v${current.version}` : null, up: true },
          ].map((m) => (
            <div key={m.label} className="bg-cream px-4 py-3.5 flex flex-col gap-0.5">
              <span className="font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4">{m.label}</span>
              <span className="font-display text-[22px] font-medium text-ink leading-none tracking-tight"
                style={{ fontVariationSettings: "'opsz' 72, 'SOFT' 30" }}>{m.value}</span>
              {m.delta && (
                <span className={`font-mono text-[10px] font-medium ${m.up ? "text-green" : "text-vermillion-2"}`}>{m.delta}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── Scrollable content ── */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-8 pt-6 pb-12 max-w-[1100px]">

        {/* ── 2. Accuracy over time ── */}
        <div className="mb-8">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="font-display text-[18px] font-medium tracking-tight text-ink" style={{ fontVariationSettings: "'opsz' 96, 'SOFT' 50" }}>
              Accuracy over time
            </h2>
            {chartData.length >= 2 && (
              <div className="flex gap-1 border border-border rounded-sm p-0.5">
                {([["field", "Field"], ["doc", "Doc"], ["composite", "Composite"]] as const).map(([key, label]) => (
                  <button key={key} onClick={() => setAccMode(key)}
                    className={`px-2.5 py-1 rounded-sm text-[11px] font-medium transition-colors ${accMode === key ? "bg-ink text-cream" : "text-ink-3 hover:text-ink"}`}>{label}</button>
                ))}
              </div>
            )}
          </div>
          <div className="border border-border rounded-sm bg-cream p-4">
            <TrendChart data={chartData} />
          </div>
          {regressed && (
            <div className="mt-3 border-l-2 border-vermillion-2 bg-vermillion-3/20 rounded-r-sm px-4 py-3">
              <div className="font-mono text-[10px] font-medium text-vermillion-2 uppercase tracking-[0.08em] mb-1">Regression detected</div>
              <div className="text-[12px] text-ink">
                v{current!.version} dropped {Math.abs(delta).toFixed(1)}pt from v{prev!.version}.
                Check the Validate page for per-field details.
              </div>
            </div>
          )}
        </div>

        {/* ── 3. Two-column grid ── */}
        {chartData.length >= 2 && (
          <div className="grid gap-6" style={{ gridTemplateColumns: "1.2fr 1fr" }}>
            {/* Per-field heatmap */}
            <div>
              <h2 className="font-display text-[18px] font-medium tracking-tight text-ink mb-4" style={{ fontVariationSettings: "'opsz' 96, 'SOFT' 50" }}>
                Per-field accuracy
              </h2>
              <div className="border border-border rounded-sm overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="bg-cream-2/50">
                      <th className="text-left px-3 py-2 font-mono text-[9px] font-medium tracking-[0.1em] uppercase text-ink-4">Field</th>
                      {heatmapVersions.map((v, i) => (
                        <th key={v} className={`px-2 py-2 font-mono text-[9px] font-medium text-center ${i === heatmapVersions.length - 1 ? "text-ink" : "text-ink-4"}`}>#{v}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {heatmapFields.map((f) => (
                      <tr key={f.name} className="border-t border-border">
                        <td className="px-3 py-1.5 font-mono text-[10px] text-ink">{f.name}</td>
                        {f.scores.map((s, i) => (
                          <td key={i} className="px-1 py-1 text-center">
                            <span className={`inline-block font-mono text-[10px] font-medium px-1.5 py-0.5 rounded-sm ${heatColor(s)}`}>{s.toFixed(0)}</span>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="px-3 py-2 border-t border-border bg-cream-2/30 flex items-center gap-3">
                  <span className="font-mono text-[8px] text-ink-4 uppercase">Accuracy</span>
                  {[["bg-vermillion-3", "<90"], ["bg-yellow-500/15", "90-95"], ["bg-green/10", "95-98"], ["bg-green/25", "98+"]].map(([bg, label]) => (
                    <div key={label} className="flex items-center gap-1">
                      <span className={`w-3 h-3 rounded-sm ${bg}`} />
                      <span className="font-mono text-[8px] text-ink-4">{label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Model info */}
            <div>
              <h2 className="font-display text-[18px] font-medium tracking-tight text-ink mb-4" style={{ fontVariationSettings: "'opsz' 96, 'SOFT' 50" }}>
                Run details
              </h2>
              <div className="border border-border rounded-sm overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="bg-cream-2/50">
                      {["Run", "Accuracy", "Docs", "Duration"].map((h) => (
                        <th key={h} className="text-left px-3 py-2 font-mono text-[9px] font-medium tracking-[0.1em] uppercase text-ink-4">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {runs.filter((r) => r.versionNumber !== null).map((r, i, arr) => (
                      <tr key={r.id} className={`border-t border-border ${i === arr.length - 1 ? "bg-cream-2/30" : ""}`}>
                        <td className="px-3 py-2 font-mono text-[11px] text-ink">
                          v{r.versionNumber}
                          {i === arr.length - 1 && <span className="font-mono text-[8px] text-ink-4 bg-cream-2 px-1 py-0.5 rounded-sm uppercase ml-1.5">latest</span>}
                        </td>
                        <td className="px-3 py-2"><span className={`font-mono text-[11px] font-medium ${r.accuracy && parseFloat(r.accuracy) * 100 >= 97 ? "text-green" : "text-ink-3"}`}>{r.accuracy ? (parseFloat(r.accuracy) * 100).toFixed(1) : "—"}%</span></td>
                        <td className="px-3 py-2 font-mono text-[11px] text-ink-3">{r.docsPassed}/{r.docsTotal}</td>
                        <td className="px-3 py-2 font-mono text-[11px] text-ink-3">{r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
