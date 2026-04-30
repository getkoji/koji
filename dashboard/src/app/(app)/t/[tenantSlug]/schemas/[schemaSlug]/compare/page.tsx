"use client";

import { useState, useCallback, useRef } from "react";
import { useParams, usePathname } from "next/navigation";
import Link from "next/link";
import { ArrowLeftRight, CheckCircle, AlertTriangle, Plus, Minus, Upload, Loader2 } from "lucide-react";
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

function DocumentPicker({
  label,
  entries,
  value,
  onChange,
  onUpload,
  uploading,
  uploadedName,
  schemaSlug,
}: {
  label: string;
  entries: CorpusEntry[];
  value: string;
  onChange: (id: string) => void;
  onUpload: (file: File) => void;
  uploading: boolean;
  uploadedName: string | null;
  schemaSlug: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex-1 min-w-0 overflow-hidden space-y-1.5 w-0">
      <label className="font-mono text-[10px] font-medium tracking-[0.08em] uppercase text-ink-4 block">
        {label}
      </label>
      {uploading ? (
        <div className="w-full h-[32px] rounded-sm border border-vermillion-2/30 bg-vermillion-3/10 px-2.5 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 text-vermillion-2 animate-spin" />
          <span className="text-[12px] text-vermillion-2 font-medium">Uploading...</span>
        </div>
      ) : (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full h-[32px] rounded-sm border border-input bg-white px-2.5 text-[12px] outline-none focus:border-ring"
        >
          <option value="">Select from corpus...</option>
          {entries.map((e) => (
            <option key={e.id} value={e.id}>{e.filename.length > 40 ? e.filename.slice(0, 37) + "..." : e.filename}</option>
          ))}
        </select>
      )}
      <div className="flex items-center gap-2 min-w-0 overflow-hidden">
        <span className="text-[10px] text-ink-4 shrink-0">or</span>
        <label className={`flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] border border-dashed transition-colors min-w-0 overflow-hidden ${
          uploading
            ? "text-vermillion-2 border-vermillion-2/30 cursor-wait"
            : uploadedName
              ? "text-green border-green/30"
              : "text-ink-3 border-border hover:border-ink hover:text-ink cursor-pointer"
        }`}>
          {uploading ? (
            <Loader2 className="w-3 h-3 animate-spin shrink-0" />
          ) : uploadedName ? (
            <CheckCircle className="w-3 h-3 shrink-0" />
          ) : (
            <Upload className="w-3 h-3 shrink-0" />
          )}
          <span className="truncate block">{uploading ? "Uploading..." : uploadedName ?? "Upload file"}</span>
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            accept=".pdf,.png,.jpg,.jpeg,.tiff,.tif"
            disabled={uploading}
            onChange={(e) => {
              if (e.target.files?.[0]) onUpload(e.target.files[0]);
            }}
          />
        </label>
      </div>
    </div>
  );
}

export default function ComparePage() {
  const params = useParams();
  const pathname = usePathname();
  const schemaSlug = params.schemaSlug as string;

  const [entryA, setEntryA] = useState<string>("");
  const [entryB, setEntryB] = useState<string>("");
  const [uploadingA, setUploadingA] = useState(false);
  const [uploadingB, setUploadingB] = useState(false);
  const [uploadedNameA, setUploadedNameA] = useState<string | null>(null);
  const [uploadedNameB, setUploadedNameB] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "diff" | "match">("all");

  const { data: entries, refetch: refetchEntries } = useApi(
    useCallback(
      () => api.get<{ data: CorpusEntry[] }>(`/api/schemas/${schemaSlug}/corpus`).then((r) => r.data),
      [schemaSlug],
    ),
  );

  async function handleUpload(file: File, side: "a" | "b") {
    const setUploading = side === "a" ? setUploadingA : setUploadingB;
    const setEntry = side === "a" ? setEntryA : setEntryB;
    const setUploadedName = side === "a" ? setUploadedNameA : setUploadedNameB;

    setUploading(true);
    setResult(null);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const entry = await api.postForm<CorpusEntry>(`/api/schemas/${schemaSlug}/corpus`, fd);
      setEntry(entry.id);
      setUploadedName(file.name);
      refetchEntries();
    } catch (err: any) {
      setError(`Upload failed: ${err?.message ?? "Unknown error"}`);
    } finally {
      setUploading(false);
    }
  }

  async function handleCompare() {
    if (!entryA || !entryB) return;
    setComparing(true);
    setError(null);
    setResult(null);

    try {
      // First, ensure both documents have extraction runs
      // Run extraction for each if needed
      setStatus("Checking extractions...");

      const [runA, runB] = await Promise.all([
        api.get<{ data: unknown | null }>(`/api/extract/runs/${entryA}`).then((r) => r.data),
        api.get<{ data: unknown | null }>(`/api/extract/runs/${entryB}`).then((r) => r.data),
      ]);

      if (!runA || !runB) {
        // Need to extract first — tell the user
        setError(
          "Both documents need extraction runs before comparing. " +
          "Go to Build mode to extract each document first, then return here to compare."
        );
        setComparing(false);
        setStatus(null);
        return;
      }

      setStatus("Comparing fields...");
      const resp = await api.post<{ data: CompareResult }>("/api/extract/compare", {
        entry_a: entryA,
        entry_b: entryB,
      });
      setResult(resp.data);
    } catch (err: any) {
      setError(err?.message ?? "Comparison failed");
    } finally {
      setComparing(false);
      setStatus(null);
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

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 min-w-0">
        {/* Document selectors with upload */}
        <div className="flex items-start gap-3 min-w-0 overflow-hidden">
          <DocumentPicker
            label="Document A"
            entries={entries ?? []}
            value={entryA}
            onChange={(id) => { setEntryA(id); setResult(null); setUploadedNameA(null); }}
            onUpload={(f) => handleUpload(f, "a")}
            uploading={uploadingA}
            uploadedName={uploadedNameA}
            schemaSlug={schemaSlug}
          />

          <ArrowLeftRight className="w-5 h-5 text-ink-4 shrink-0 mt-7" />

          <DocumentPicker
            label="Document B"
            entries={(entries ?? []).filter((e) => e.id !== entryA)}
            value={entryB}
            onChange={(id) => { setEntryB(id); setResult(null); setUploadedNameB(null); }}
            onUpload={(f) => handleUpload(f, "b")}
            uploading={uploadingB}
            uploadedName={uploadedNameB}
            schemaSlug={schemaSlug}
          />

          <div className="shrink-0 mt-6">
            <button
              onClick={handleCompare}
              disabled={!entryA || !entryB || comparing || uploadingA || uploadingB}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-sm text-[12px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-30"
            >
              {comparing ? (status ?? "Comparing...") : "Compare"}
            </button>
          </div>
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
              <div className="grid grid-cols-[160px_1fr_1fr_100px] bg-cream-2 border-b border-border">
                <div className="px-3 py-2 font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4">Field</div>
                <div className="px-3 py-2 font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4 border-l border-border truncate" title={result.entry_a.filename}>
                  {result.entry_a.filename.length > 25 ? result.entry_a.filename.slice(0, 25) + "..." : result.entry_a.filename}
                </div>
                <div className="px-3 py-2 font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4 border-l border-border truncate" title={result.entry_b.filename}>
                  {result.entry_b.filename.length > 25 ? result.entry_b.filename.slice(0, 25) + "..." : result.entry_b.filename}
                </div>
                <div className="px-3 py-2 font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4 border-l border-border">Status</div>
              </div>

              {(filteredFields ?? []).map((f) => {
                const cfg = STATUS_CONFIG[f.status];
                const Icon = cfg.icon;
                return (
                  <div
                    key={f.field}
                    className={`grid grid-cols-[160px_1fr_1fr_100px] border-b border-dotted border-border last:border-b-0 ${
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
            <p className="text-[13px] text-ink-3">Upload or select two documents to compare</p>
            <p className="text-[11px] text-ink-4 mt-1">Upload directly or pick from the corpus — both documents must be extracted first</p>
          </div>
        )}
      </div>
    </div>
  );
}
