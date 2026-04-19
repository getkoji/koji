"use client";

import { useState, useCallback, useEffect } from "react";
import { useParams, usePathname } from "next/navigation";
import Link from "next/link";
import { Upload, Search, ExternalLink, Plus, X } from "lucide-react";
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

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function CorpusPage() {
  const params = useParams();
  const pathname = usePathname();
  const schemaSlug = params.schemaSlug as string;
  const tenantSlug = pathname.match(/^\/t\/([^/]+)/)?.[1] ?? "";
  const { hasPermission } = useAuth();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("All");
  const [sourceFilter, setSourceFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [uploading, setUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [showTagInput, setShowTagInput] = useState(false);
  const [newTag, setNewTag] = useState("");

  const { data: entries, loading, refetch } = useApi(
    useCallback(() => api.get<{ data: CorpusEntry[] }>(`/api/schemas/${schemaSlug}/corpus`).then((r) => r.data), [schemaSlug]),
  );

  const filtered = (entries ?? []).filter((e) => {
    if (sourceFilter === "Upload" && e.source !== "upload") return false;
    if (sourceFilter === "Pipeline" && e.source === "upload") return false;
    if (search && !e.filename.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  // Auto-select first entry if nothing selected
  useEffect(() => {
    if (!selectedId && filtered.length > 0) {
      setSelectedId(filtered[0]!.id);
    }
  }, [filtered, selectedId]);

  const selected = filtered.find((e) => e.id === selectedId) ?? null;

  // Load preview URL when selection changes
  useEffect(() => {
    if (!selectedId) { setPreviewUrl(null); return; }
    api.get<{ url: string }>(`/api/schemas/${schemaSlug}/corpus/${selectedId}/url`)
      .then((r) => setPreviewUrl(r.url))
      .catch(() => setPreviewUrl(null));
  }, [selectedId, schemaSlug]);

  async function handleUpload(file: File) {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const result = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:9401"}/api/schemas/${schemaSlug}/corpus`,
        { method: "POST", body: formData, credentials: "include", headers: { "x-koji-tenant": tenantSlug } },
      );
      if (result.ok) {
        const entry = await result.json() as CorpusEntry;
        refetch();
        setSelectedId(entry.id);
      }
    } finally {
      setUploading(false);
    }
  }

  // Metrics
  const total = (entries ?? []).length;
  const uploadCount = (entries ?? []).filter((e) => e.source === "upload").length;

  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-border shrink-0">
        <nav className="flex items-center gap-1.5 font-mono text-[11px] text-ink-4 mb-3">
          <span className="text-ink-3">{schemaSlug}</span>
          <span className="text-cream-4">/</span>
          <span className="text-ink font-medium">Corpus</span>
        </nav>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-[26px] font-medium leading-none tracking-tight text-ink"
              style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}>
              Corpus
            </h1>
            <div className="flex items-center gap-4 mt-2 font-mono text-[11px] text-ink-4">
              <span>{total} entries</span>
              <span>{uploadCount} uploaded</span>
            </div>
          </div>
          {hasPermission("corpus:write") && (
            <label className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors cursor-pointer shrink-0 ${uploading ? "opacity-50 pointer-events-none" : ""}`}>
              <Upload className="w-3.5 h-3.5" />
              {uploading ? "Uploading..." : "Add document"}
              <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.tiff,.tif" multiple
                onChange={(e) => { if (e.target.files?.[0]) handleUpload(e.target.files[0]); }} />
            </label>
          )}
        </div>
      </div>

      {/* Master-detail */}
      <div className="flex-1 min-h-0 grid" style={{ gridTemplateColumns: "35% 1fr" }}>
        {/* LEFT: Entry list */}
        <div className="border-r border-border flex flex-col min-h-0">
          {/* Search + filters */}
          <div className="px-3 py-2.5 border-b border-border shrink-0 space-y-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-4" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search files..."
                data-1p-ignore autoComplete="off"
                className="w-full h-[28px] rounded-sm border border-input bg-transparent pl-8 pr-2.5 text-[12px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
              />
            </div>
            <div className="flex items-center gap-1">
              {["All", "Upload", "Pipeline"].map((s) => (
                <button key={s} onClick={() => setSourceFilter(s)}
                  className={`font-mono text-[9px] px-2 py-0.5 rounded-sm transition-colors ${sourceFilter === s ? "bg-ink text-cream" : "text-ink-4 hover:bg-cream-2 hover:text-ink"}`}>
                  {s}
                </button>
              ))}
              <span className="flex-1" />
              <span className="font-mono text-[9px] text-ink-4">{filtered.length}</span>
            </div>
          </div>

          {/* Entry list */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="animate-pulse font-mono text-[11px] text-ink-4 py-8 text-center">Loading...</div>
            ) : filtered.length === 0 ? (
              <div className="py-12 text-center text-[12px] text-ink-4">
                {search ? "No matches" : "No documents yet"}
              </div>
            ) : (
              filtered.map((e) => (
                <button key={e.id} onClick={() => setSelectedId(e.id)}
                  className={`w-full text-left px-3 py-2.5 border-b border-dotted border-border flex items-center gap-3 transition-colors ${
                    selectedId === e.id ? "bg-cream-2" : "hover:bg-cream-2/50"
                  }`}>
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[11px] text-ink truncate">{e.filename}</div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className={`font-mono text-[9px] px-1.5 py-0.5 rounded-sm uppercase ${
                        e.source === "upload" ? "bg-cream-2 text-ink-4" : "bg-green/10 text-green"
                      }`}>{e.source}</span>
                      <span className="font-mono text-[9px] text-ink-4">{timeAgo(e.createdAt)}</span>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* RIGHT: Detail */}
        <div className="min-h-0 overflow-y-auto">
          {!selected ? (
            <div className="h-full flex items-center justify-center text-center">
              <div>
                <div className="text-[13px] text-ink-3 mb-1">Select a corpus entry</div>
                <div className="text-[11px] text-ink-4">Click an entry from the list to view details</div>
              </div>
            </div>
          ) : (
            <div className="p-5 flex flex-col gap-5">
              {/* Entry header */}
              <div>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-mono text-[16px] text-ink font-medium">{selected.filename}</h2>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className={`font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm uppercase tracking-[0.08em] ${
                        selected.source === "upload" ? "bg-cream-2 text-ink-3" : "bg-green/10 text-green"
                      }`}>{selected.source}</span>
                      <span className="font-mono text-[10px] text-ink-4">{formatSize(selected.fileSize)}</span>
                      <span className="font-mono text-[10px] text-ink-4">{selected.mimeType.split("/")[1]}</span>
                      <span className="font-mono text-[10px] text-ink-4">{timeAgo(selected.createdAt)}</span>
                    </div>
                  </div>
                  <Link
                    href={pathname.replace("/corpus", "/build") + `?doc=${selected.id}`}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm text-[12px] text-ink-3 border border-border hover:border-ink hover:text-ink transition-colors shrink-0"
                  >
                    Test in Build
                    <ExternalLink className="w-3 h-3" />
                  </Link>
                </div>

                {/* Tags */}
                <div className="flex items-center gap-1.5 mt-3 flex-wrap">
                  {selected.tags.map((t) => (
                    <span key={t} className="inline-flex items-center gap-1 font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm bg-cream-2 text-ink-3 uppercase tracking-[0.08em]">
                      {t}
                      {hasPermission("corpus:write") && (
                        <button onClick={async () => {
                          const updated = selected.tags.filter((tag) => tag !== t);
                          await api.patch(`/api/schemas/${schemaSlug}/corpus/${selected.id}`, { tags: updated });
                          refetch();
                        }} className="text-ink-4 hover:text-vermillion-2 transition-colors ml-0.5">
                          <X className="w-2.5 h-2.5" />
                        </button>
                      )}
                    </span>
                  ))}
                  {hasPermission("corpus:write") && (
                    showTagInput ? (
                      <form onSubmit={async (e) => {
                        e.preventDefault();
                        if (!newTag.trim()) return;
                        const updated = [...selected.tags, newTag.trim().toLowerCase()];
                        await api.patch(`/api/schemas/${schemaSlug}/corpus/${selected.id}`, { tags: updated });
                        setNewTag("");
                        setShowTagInput(false);
                        refetch();
                      }} className="inline-flex items-center gap-1">
                        <input value={newTag} onChange={(e) => setNewTag(e.target.value)} autoFocus
                          placeholder="tag name"
                          data-1p-ignore autoComplete="off"
                          onBlur={() => { if (!newTag.trim()) setShowTagInput(false); }}
                          onKeyDown={(e) => { if (e.key === "Escape") { setShowTagInput(false); setNewTag(""); } }}
                          className="w-20 h-[22px] rounded-sm border border-input bg-transparent px-1.5 text-[10px] font-mono outline-none focus:border-ring placeholder:text-ink-4" />
                      </form>
                    ) : (
                      <button onClick={() => setShowTagInput(true)}
                        className="inline-flex items-center gap-0.5 font-mono text-[10px] text-ink-4 hover:text-ink transition-colors px-1.5 py-0.5 rounded-sm hover:bg-cream-2">
                        <Plus className="w-3 h-3" /> tag
                      </button>
                    )
                  )}
                </div>
              </div>

              {/* Document preview */}
              <div>
                <div className="font-mono text-[10px] font-medium tracking-[0.08em] uppercase text-ink-4 mb-2">Preview</div>
                {previewUrl ? (
                  selected.mimeType === "application/pdf" ? (
                    <iframe src={previewUrl} className="w-full h-[400px] border border-border rounded-sm" title={selected.filename} />
                  ) : (
                    <img src={previewUrl} alt={selected.filename} className="w-full max-h-[400px] object-contain border border-border rounded-sm" />
                  )
                ) : (
                  <div className="h-[200px] border border-border rounded-sm flex items-center justify-center">
                    <span className="animate-pulse font-mono text-[11px] text-ink-4">Loading preview...</span>
                  </div>
                )}
              </div>

              {/* Ground truth section */}
              <div>
                <div className="font-mono text-[10px] font-medium tracking-[0.08em] uppercase text-ink-4 mb-2">Ground truth</div>
                <div className="border border-border rounded-sm p-4 text-center">
                  <div className="text-[12px] text-ink-3 mb-2">No ground truth authored yet</div>
                  <div className="text-[11px] text-ink-4">
                    Run extraction in Build mode, then review and confirm the results to create ground truth.
                  </div>
                </div>
              </div>

              {/* Content hash */}
              <div>
                <div className="font-mono text-[10px] font-medium tracking-[0.08em] uppercase text-ink-4 mb-1">Content hash</div>
                <div className="font-mono text-[10px] text-ink-4 select-all break-all">{selected.id}</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
