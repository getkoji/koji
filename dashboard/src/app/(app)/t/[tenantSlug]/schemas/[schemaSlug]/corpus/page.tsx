"use client";

import { useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { Upload } from "lucide-react";
import { ListLayout, Breadcrumbs, PageHeader } from "@/components/layouts";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { useAuth } from "@/lib/auth-context";

interface CorpusEntry {
  id: string;
  filename: string;
  fileSize: number;
  mimeType: string;
  source: string;
  tags: string[];
  createdAt: string;
}

const TAG_COLORS: Record<string, string> = {
  normal: "bg-green/[0.12] text-green",
  edge: "bg-cream-2 text-ink-3",
  adversarial: "bg-vermillion-3 text-vermillion-2",
  regression: "bg-cream-2 text-ink-4",
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function CorpusPage() {
  const params = useParams();
  const schemaSlug = params.schemaSlug as string;
  const { hasPermission } = useAuth();
  const [uploading, setUploading] = useState(false);
  const [filter, setFilter] = useState("All");

  const { data: entries, loading, refetch } = useApi(
    useCallback(() => api.get<{ data: CorpusEntry[] }>(`/api/schemas/${schemaSlug}/corpus`).then((r) => r.data), [schemaSlug]),
  );

  const filtered = (entries ?? []).filter((e) => {
    if (filter === "All") return true;
    if (filter === "Upload") return e.source === "upload";
    if (filter === "Pipeline") return e.source !== "upload";
    return true;
  });

  async function handleUpload(file: File) {
    setUploading(true);
    try {
      const tenantSlug = window.location.pathname.match(/^\/t\/([^/]+)/)?.[1] ?? "";
      const formData = new FormData();
      formData.append("file", file);
      await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:9401"}/api/schemas/${schemaSlug}/corpus`,
        { method: "POST", body: formData, credentials: "include", headers: { "x-koji-tenant": tenantSlug } },
      );
      refetch();
    } finally {
      setUploading(false);
    }
  }

  return (
    <ListLayout
      header={
        <>
          <Breadcrumbs items={[{ label: schemaSlug }, { label: "Corpus" }]} />
          <PageHeader
            title="Corpus"
            meta={<span>{(entries ?? []).length} document{(entries ?? []).length !== 1 ? "s" : ""}</span>}
            actions={
              hasPermission("corpus:write") ? (
                <label className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors cursor-pointer ${uploading ? "opacity-50 pointer-events-none" : ""}`}>
                  <Upload className="w-3.5 h-3.5" />
                  {uploading ? "Uploading..." : "Add document"}
                  <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.tiff,.tif"
                    onChange={(e) => { if (e.target.files?.[0]) handleUpload(e.target.files[0]); }} />
                </label>
              ) : undefined
            }
          />
        </>
      }
      filterBar={
        <div className="flex items-center gap-2">
          {["All", "Upload", "Pipeline"].map((s) => (
            <button key={s} onClick={() => setFilter(s)}
              className={`font-mono text-[10px] px-2.5 py-1 rounded-sm transition-colors ${filter === s ? "bg-ink text-cream" : "text-ink-3 hover:bg-cream-2 hover:text-ink"}`}>
              {s}
            </button>
          ))}
          <span className="flex-1" />
          <span className="font-mono text-[10px] text-ink-4">{filtered.length} document{filtered.length !== 1 ? "s" : ""}</span>
        </div>
      }
    >
      {loading ? (
        <div className="animate-pulse font-mono text-[11px] text-ink-4 py-8 text-center">Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="py-16 text-center">
          <Upload className="w-8 h-8 text-ink-4 mx-auto mb-3" />
          <div className="text-[13px] text-ink-3 mb-1">
            {filter !== "All" ? "No documents match this filter." : "No documents in the corpus yet."}
          </div>
          {filter === "All" && (
            <div className="text-[12px] text-ink-4">
              Upload documents here or from the Build page to start testing your schema.
            </div>
          )}
        </div>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              {["Filename", "Size", "Type", "Source", "Tags", "Added"].map((h) => (
                <th key={h} className="text-left px-4 py-2 font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => (
              <tr key={c.id} className="border-b border-dotted border-border hover:bg-cream-2/50 transition-colors">
                <td className="px-4 py-2.5 font-mono text-[11px] text-ink">{c.filename}</td>
                <td className="px-4 py-2.5 font-mono text-[10px] text-ink-4">{formatSize(c.fileSize)}</td>
                <td className="px-4 py-2.5">
                  <span className="font-mono text-[10px] text-ink-4 bg-cream-2 px-1.5 py-0.5 rounded-sm uppercase">
                    {c.mimeType.split("/")[1]}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <span className={`font-mono text-[10px] font-medium px-1.5 py-0.5 rounded-sm uppercase tracking-[0.08em] ${
                    c.source === "upload" ? "bg-cream-2 text-ink-3" : "bg-green/[0.12] text-green"
                  }`}>
                    {c.source}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-1">
                    {c.tags.length > 0 ? c.tags.map((t) => (
                      <span key={t}
                        className={`font-mono text-[10px] font-medium px-1.5 py-0.5 rounded-sm uppercase tracking-[0.08em] ${TAG_COLORS[t] || "bg-cream-2 text-ink-4"}`}>
                        {t}
                      </span>
                    )) : (
                      <span className="font-mono text-[10px] text-ink-4">—</span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-2.5 font-mono text-[10px] text-ink-4">{timeAgo(c.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ListLayout>
  );
}
