"use client";

import { useState, useCallback } from "react";
import { useParams, usePathname } from "next/navigation";
import Link from "next/link";
import { ArrowLeftRight, CheckCircle, AlertTriangle, Plus, Minus } from "lucide-react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";

interface CorpusEntry {
  id: string;
  filename: string;
  hasGroundTruth?: boolean;
}

interface CompareField {
  field: string;
  value_a: unknown;
  value_b: unknown;
  confidence_a: number | null;
  confidence_b: number | null;
  status: "match" | "diff" | "added" | "removed";
}

interface CompareResult {
  entry_a: { id: string; filename: string; model: string; run_id: string };
  entry_b: { id: string; filename: string; model: string; run_id: string };
  fields: CompareField[];
  summary: { total: number; matches: number; diffs: number; added: number; removed: number };
}

const STATUS_CONFIG = {
  match: { label: "Match", icon: CheckCircle, color: "text-green", bg: "bg-green/10" },
  diff: { label: "Changed", icon: AlertTriangle, color: "text-vermillion-2", bg: "bg-vermillion-3" },
  added: { label: "New", icon: Plus, color: "text-blue-600", bg: "bg-blue-500/10" },
  removed: { label: "Removed", icon: Minus, color: "text-yellow-600", bg: "bg-yellow-500/10" },
};

export default function ComparePage() {
  const params = useParams();
  const pathname = usePathname();
  const schemaSlug = params.schemaSlug as string;
  const tenantSlug = pathname.match(/^\/t\/([^/]+)/)?.[1] ?? "";

  const [entryA, setEntryA] = useState<string>("");
  const [entryB, setEntryB] = useState<string>("");
  const [comparing, setComparing] = useState(false);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "diff" | "match">("all");

  const { data: entries } = useApi(
    useCallback(
      () => api.get<{ data: CorpusEntry[] }>(`/api/schemas/${schemaSlug}/corpus`).then((r) => r.data),
      [schemaSlug],
    ),
  );

  async function handleCompare() {
    if (!entryA || !entryB) return;
    setComparing(true);
    setError(null);
    try {
      const resp = await api.post<{ data: CompareResult }>("/api/extract/compare", {
        entry_a: entryA,
        entry_b: entryB,
      });
      setResult(resp.data);
    } catch (err: any) {
      setError(err?.message ?? "Comparison failed");
    } finally {
      setComparing(false);
    }
  }

  const filteredFields = result?.fields.filter((f) => {
    if (filter === "all") return true;
    if (filter === "diff") return f.status !== "match";
    return f.status === "match";
  });

  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      {/* Header */}
      <div className="px-6 pt-4 pb-3 border-b border-border shrink-0">
        <nav className="flex items-center gap-1.5 font-mono text-[11px] text-ink-4 mb-1">
          <Link href={pathname.replace("/compare", "/build")} className="text-ink-3 hover:text-ink">{schemaSlug}</Link>
          <span className="text-cream-4">/</span>
          <span className="text-ink font-medium">Compare</span>
        </nav>
        <h1
          className="font-display text-[22px] font-medium leading-none tracking-tight text-ink"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
        >
          Document Comparison
        </h1>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {/* Document selectors */}
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label className="font-mono text-[10px] font-medium tracking-[0.08em] uppercase text-ink-4 mb-1 block">Document A</label>
            <select
              value={entryA}
              onChange={(e) => { setEntryA(e.target.value); setResult(null); }}
              className="w-full h-[32px] rounded-sm border border-input bg-white px-2.5 text-[12px] outline-none focus:border-ring"
            >
              <option value="">Select document...</option>
              {(entries ?? []).map((e) => (
                <option key={e.id} value={e.id}>{e.filename}</option>
              ))}
            </select>
          </div>

          <ArrowLeftRight className="w-5 h-5 text-ink-4 shrink-0 mb-1" />

          <div className="flex-1">
            <label className="font-mono text-[10px] font-medium tracking-[0.08em] uppercase text-ink-4 mb-1 block">Document B</label>
            <select
              value={entryB}
              onChange={(e) => { setEntryB(e.target.value); setResult(null); }}
              className="w-full h-[32px] rounded-sm border border-input bg-white px-2.5 text-[12px] outline-none focus:border-ring"
            >
              <option value="">Select document...</option>
              {(entries ?? []).filter((e) => e.id !== entryA).map((e) => (
                <option key={e.id} value={e.id}>{e.filename}</option>
              ))}
            </select>
          </div>

          <button
            onClick={handleCompare}
            disabled={!entryA || !entryB || comparing}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-sm text-[12px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-30 shrink-0"
          >
            {comparing ? "Comparing..." : "Compare"}
          </button>
        </div>

        {error && (
          <div className="border border-vermillion-2/30 bg-vermillion-3/30 rounded-sm px-3 py-2 text-[12px] text-vermillion-2">
            {error}
          </div>
        )}

        {/* Results */}
        {result && (
          <>
            {/* Summary strip */}
            <div className="flex items-center gap-4 font-mono text-[11px]">
              <span className="text-ink-4">{result.summary.total} fields</span>
              <span className="text-green">{result.summary.matches} match</span>
              {result.summary.diffs > 0 && (
                <span className="text-vermillion-2 font-medium">{result.summary.diffs} changed</span>
              )}
              {result.summary.added > 0 && (
                <span className="text-blue-600">{result.summary.added} new</span>
              )}
              {result.summary.removed > 0 && (
                <span className="text-yellow-600">{result.summary.removed} removed</span>
              )}
            </div>

            {/* Filter tabs */}
            <div className="flex gap-1">
              {(["all", "diff", "match"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`font-mono text-[10px] px-2.5 py-1 rounded-sm transition-colors ${
                    filter === f ? "bg-ink text-cream" : "text-ink-4 hover:bg-cream-2"
                  }`}
                >
                  {f === "all" ? "All" : f === "diff" ? "Discrepancies" : "Matches"}
                </button>
              ))}
            </div>

            {/* Comparison table */}
            <div className="border border-border rounded-sm overflow-hidden">
              {/* Table header */}
              <div className="grid grid-cols-[180px_1fr_1fr_80px] bg-cream-2 border-b border-border">
                <div className="px-3 py-2 font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4">Field</div>
                <div className="px-3 py-2 font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4 border-l border-border truncate" title={result.entry_a.filename}>
                  {result.entry_a.filename.length > 25 ? result.entry_a.filename.slice(0, 25) + "..." : result.entry_a.filename}
                </div>
                <div className="px-3 py-2 font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4 border-l border-border truncate" title={result.entry_b.filename}>
                  {result.entry_b.filename.length > 25 ? result.entry_b.filename.slice(0, 25) + "..." : result.entry_b.filename}
                </div>
                <div className="px-3 py-2 font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4 border-l border-border">Status</div>
              </div>

              {/* Table body */}
              {(filteredFields ?? []).map((f) => {
                const cfg = STATUS_CONFIG[f.status];
                const Icon = cfg.icon;
                return (
                  <div
                    key={f.field}
                    className={`grid grid-cols-[180px_1fr_1fr_80px] border-b border-dotted border-border last:border-b-0 ${
                      f.status === "diff" ? "bg-vermillion-3/10" : ""
                    }`}
                  >
                    <div className="px-3 py-2 font-mono text-[11px] text-vermillion-2 font-medium truncate">{f.field}</div>
                    <div className="px-3 py-2 text-[12px] text-ink border-l border-border break-words">
                      {f.value_a != null ? (typeof f.value_a === "object" ? JSON.stringify(f.value_a) : String(f.value_a)) : <span className="text-ink-4">—</span>}
                    </div>
                    <div className={`px-3 py-2 text-[12px] border-l border-border break-words ${f.status === "diff" ? "text-vermillion-2 font-medium" : "text-ink"}`}>
                      {f.value_b != null ? (typeof f.value_b === "object" ? JSON.stringify(f.value_b) : String(f.value_b)) : <span className="text-ink-4">—</span>}
                    </div>
                    <div className="px-3 py-2 border-l border-border">
                      <span className={`inline-flex items-center gap-1 font-mono text-[9px] font-medium px-1.5 py-0.5 rounded-sm ${cfg.bg} ${cfg.color}`}>
                        <Icon className="w-3 h-3" />
                        {cfg.label}
                      </span>
                    </div>
                  </div>
                );
              })}

              {filteredFields?.length === 0 && (
                <div className="px-3 py-6 text-center text-[12px] text-ink-4">
                  {filter === "diff" ? "No discrepancies found" : "No matching fields"}
                </div>
              )}
            </div>
          </>
        )}

        {!result && !comparing && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <ArrowLeftRight className="w-10 h-10 text-ink-4/30 mb-3" />
            <p className="text-[13px] text-ink-3">Select two documents to compare their extracted fields</p>
            <p className="text-[11px] text-ink-4 mt-1">Both documents must have been extracted with this schema</p>
          </div>
        )}
      </div>
    </div>
  );
}
