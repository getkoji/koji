"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { useParams, usePathname } from "next/navigation";
import Link from "next/link";
import { parse as parseYaml } from "yaml";
import { Upload, Search, ExternalLink, Plus, X, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { useAuth } from "@/lib/auth-context";

interface CorpusEntry {
  id: string; filename: string; fileSize: number; mimeType: string;
  source: string; tags: string[]; createdAt: string;
}

interface SchemaField {
  name: string; type: string; required?: boolean; nullable?: boolean;
  values?: string[]; validate?: Record<string, unknown>;
}

function timeAgo(d: string): string {
  const ms = Date.now() - new Date(d).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now"; if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const dy = Math.floor(h / 24);
  return dy < 7 ? `${dy}d ago` : `${Math.floor(dy / 7)}w ago`;
}

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`; if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

const SUGGESTED_TAGS = [
  "production-quality",
  "edge-case",
  "adversarial",
  "hold-out",
  "regression",
  "synthetic",
];

const TAG_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  "production-quality": { bg: "bg-green/15", text: "text-green", dot: "bg-green" },
  "edge-case":          { bg: "bg-yellow-500/15", text: "text-yellow-600", dot: "bg-yellow-500" },
  "adversarial":        { bg: "bg-vermillion-3", text: "text-vermillion-2", dot: "bg-vermillion-2" },
  "hold-out":           { bg: "bg-blue-500/15", text: "text-blue-600", dot: "bg-blue-500" },
  "regression":         { bg: "bg-orange-500/15", text: "text-orange-600", dot: "bg-orange-500" },
  "synthetic":          { bg: "bg-purple-500/15", text: "text-purple-600", dot: "bg-purple-500" },
};

const DEFAULT_TAG_COLOR = { bg: "bg-cream-2", text: "text-ink-3", dot: "bg-ink-4" };

function tagColor(tag: string) { return TAG_COLORS[tag] ?? DEFAULT_TAG_COLOR; }

function parseFields(yaml: string | null): SchemaField[] {
  if (!yaml) return [];
  try {
    const doc = parseYaml(yaml);
    if (!doc?.fields || typeof doc.fields !== "object") return [];
    return Object.entries(doc.fields).map(([name, def]) => {
      const d = (def ?? {}) as Record<string, unknown>;
      return { name, type: (d.type as string) ?? "string", required: d.required as boolean | undefined,
        nullable: d.nullable as boolean | undefined, values: d.values as string[] | undefined,
        validate: d.validate as Record<string, unknown> | undefined };
    });
  } catch { return []; }
}

export default function CorpusPage() {
  const params = useParams();
  const pathname = usePathname();
  const schemaSlug = params.schemaSlug as string;
  const tenantSlug = pathname.match(/^\/t\/([^/]+)/)?.[1] ?? "";
  const { hasPermission } = useAuth();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [srcFilter, setSrcFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [uploading, setUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [showTagInput, setShowTagInput] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [gtValues, setGtValues] = useState<Record<string, string>>({});
  const [savingGt, setSavingGt] = useState(false);
  const [listCollapsed, setListCollapsed] = useState(() =>
    typeof window !== "undefined" && localStorage.getItem("koji:corpus:list-collapsed") === "true"
  );

  const { data: entries, loading, refetch } = useApi(
    useCallback(() => api.get<{ data: CorpusEntry[] }>(`/api/schemas/${schemaSlug}/corpus`).then((r) => r.data), [schemaSlug]),
  );
  const { data: schemaDetail } = useApi(
    useCallback(() => api.get<{ latestVersion?: { yamlSource: string } }>(`/api/schemas/${schemaSlug}`), [schemaSlug]),
  );

  const fields = useMemo(() => parseFields(schemaDetail?.latestVersion?.yamlSource ?? null), [schemaDetail]);

  const filtered = (entries ?? []).filter((e) => {
    if (srcFilter === "Upload" && e.source !== "upload") return false;
    if (srcFilter === "Pipeline" && e.source === "upload") return false;
    if (search && !e.filename.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  useEffect(() => { if (!selectedId && filtered.length > 0) setSelectedId(filtered[0]!.id); }, [filtered, selectedId]);

  const selected = filtered.find((e) => e.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId) { setPreviewUrl(null); return; }
    api.get<{ url: string }>(`/api/schemas/${schemaSlug}/corpus/${selectedId}/url`)
      .then((r) => setPreviewUrl(r.url)).catch(() => setPreviewUrl(null));
  }, [selectedId, schemaSlug]);

  // Load existing GT when selection changes
  useEffect(() => {
    setShowTagInput(false); setNewTag("");
    if (!selectedId) { setGtValues({}); return; }
    api.get<{ data: Array<{ payloadJson: Record<string, unknown> }> }>(`/api/schemas/${schemaSlug}/corpus/${selectedId}/ground-truth`)
      .then((r) => {
        if (r.data.length > 0) {
          const payload = r.data[0]!.payloadJson;
          const vals: Record<string, string> = {};
          for (const [k, v] of Object.entries(payload)) vals[k] = String(v ?? "");
          setGtValues(vals);
        } else {
          setGtValues({});
        }
      })
      .catch(() => setGtValues({}));
  }, [selectedId, schemaSlug]);

  async function handleUpload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData(); fd.append("file", file);
      const r = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:9401"}/api/schemas/${schemaSlug}/corpus`,
        { method: "POST", body: fd, credentials: "include", headers: { "x-koji-tenant": tenantSlug } });
      if (r.ok) { const e = await r.json() as CorpusEntry; refetch(); setSelectedId(e.id); }
    } finally { setUploading(false); }
  }

  async function handleAddTag() {
    if (!newTag.trim() || !selected) return;
    await api.patch(`/api/schemas/${schemaSlug}/corpus/${selected.id}`, { tags: [...selected.tags, newTag.trim().toLowerCase()] });
    setNewTag(""); setShowTagInput(false); refetch();
  }

  async function handleRemoveTag(tag: string) {
    if (!selected) return;
    await api.patch(`/api/schemas/${schemaSlug}/corpus/${selected.id}`, { tags: selected.tags.filter((t) => t !== tag) });
    refetch();
  }

  function toggleList() {
    setListCollapsed((p) => { const n = !p; localStorage.setItem("koji:corpus:list-collapsed", String(n)); return n; });
  }

  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      {/* Header */}
      <div className="px-6 pt-4 pb-3 border-b border-border shrink-0 flex items-start justify-between">
        <div>
          <nav className="flex items-center gap-1.5 font-mono text-[11px] text-ink-4 mb-1">
            <span className="text-ink-3">{schemaSlug}</span><span className="text-cream-4">/</span><span className="text-ink font-medium">Corpus</span>
          </nav>
          <h1 className="font-display text-[22px] font-medium leading-none tracking-tight text-ink" style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}>Corpus</h1>
          <div className="flex items-center gap-3 mt-1.5 font-mono text-[10px] text-ink-4">
            <span>{(entries ?? []).length} entries</span>
            <span>·</span>
            <span>{(entries ?? []).filter((e) => e.tags.includes("hold-out")).length} hold-out</span>
            <span>·</span>
            <span>{(entries ?? []).filter((e) => e.tags.includes("adversarial")).length} adversarial</span>
          </div>
        </div>
        {hasPermission("corpus:write") && (
          <label className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-[12px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors cursor-pointer ${uploading ? "opacity-50 pointer-events-none" : ""}`}>
            <Upload className="w-3.5 h-3.5" />{uploading ? "Uploading..." : "Add document"}
            <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.tiff,.tif" onChange={(e) => { if (e.target.files?.[0]) handleUpload(e.target.files[0]); }} />
          </label>
        )}
      </div>

      {/* Three-panel body */}
      <div className="flex-1 min-h-0 grid" style={{
        gridTemplateColumns: listCollapsed ? "48px 1fr 1fr" : "220px 1fr 1fr",
        transition: "grid-template-columns 300ms cubic-bezier(0.4,0,0.2,1)",
      }}>

        {/* ── LIST ── */}
        <div className="border-r border-border flex flex-col min-h-0 overflow-hidden">
          {listCollapsed ? (
            <div className="flex flex-col items-center pt-2 gap-1">
              <button onClick={toggleList} className="p-2 rounded-sm text-ink-4 hover:text-ink hover:bg-cream-2 transition-colors" title="Expand list">
                <PanelLeftOpen className="w-3.5 h-3.5" />
              </button>
              {filtered.map((e) => (
                <button key={e.id} onClick={() => setSelectedId(e.id)} title={e.filename}
                  className={`w-3 h-3 rounded-full shrink-0 transition-colors ${selectedId === e.id ? "bg-vermillion-2" : "bg-ink-4/20 hover:bg-ink-4/50"}`} />
              ))}
            </div>
          ) : (
            <>
              <div className="px-2 py-2 border-b border-border shrink-0 space-y-1.5">
                <div className="flex items-center gap-1">
                  <div className="relative flex-1">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-ink-4" />
                    <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." data-1p-ignore autoComplete="off"
                      className="w-full h-[24px] rounded-sm border border-input bg-transparent pl-6 pr-2 text-[11px] outline-none focus:border-ring placeholder:text-ink-4" />
                  </div>
                  <button onClick={toggleList} className="p-1 rounded-sm text-ink-4 hover:text-ink hover:bg-cream-2 transition-colors" title="Collapse list">
                    <PanelLeftClose className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex gap-1">
                  {["All", "Upload", "Pipeline"].map((s) => (
                    <button key={s} onClick={() => setSrcFilter(s)}
                      className={`font-mono text-[8px] px-1.5 py-0.5 rounded-sm transition-colors ${srcFilter === s ? "bg-ink text-cream" : "text-ink-4 hover:bg-cream-2"}`}>{s}</button>
                  ))}
                </div>
              </div>
              <div className="flex-1 overflow-y-auto">
                {loading ? <div className="animate-pulse font-mono text-[10px] text-ink-4 py-6 text-center">Loading...</div>
                : filtered.length === 0 ? <div className="py-6 text-center text-[10px] text-ink-4">{search ? "No matches" : "Empty"}</div>
                : filtered.map((e) => (
                  <button key={e.id} onClick={() => setSelectedId(e.id)}
                    className={`w-full text-left px-2 py-2 border-b border-dotted border-border transition-colors ${selectedId === e.id ? "bg-cream-2" : "hover:bg-cream-2/50"}`}>
                    <div className="flex items-center gap-1.5">
                      {e.tags.length > 0 && (
                        <div className="flex items-center gap-0.5 shrink-0">
                          {e.tags.map((t) => (
                            <span key={t} className={`w-2 h-2 rounded-full ${tagColor(t).dot}`} title={t} />
                          ))}
                        </div>
                      )}
                      <span className="font-mono text-[10px] text-ink truncate">{e.filename}</span>
                    </div>
                    <div className="flex items-center gap-1 mt-0.5">
                      <span className={`font-mono text-[8px] px-1 py-0.5 rounded-sm uppercase ${e.source === "upload" ? "bg-cream-2 text-ink-4" : "bg-green/10 text-green"}`}>{e.source}</span>
                      <span className="font-mono text-[8px] text-ink-4">{timeAgo(e.createdAt)}</span>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* ── DOCUMENT PREVIEW ── */}
        <div className="border-r border-border flex flex-col min-h-0 overflow-y-auto">
          {!selected ? (
            <div className="h-full flex items-center justify-center text-[12px] text-ink-4">Select an entry</div>
          ) : (
            <div className="p-3 flex flex-col gap-2 h-full">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="font-mono text-[13px] text-ink font-medium break-all">{selected.filename}</h2>
                  <div className="flex items-center gap-1.5 mt-1 font-mono text-[9px] text-ink-4">
                    <span className={`px-1 py-0.5 rounded-sm uppercase ${selected.source === "upload" ? "bg-cream-2" : "bg-green/10 text-green"}`}>{selected.source}</span>
                    <span>{fmtSize(selected.fileSize)}</span>
                    <span>{selected.mimeType.split("/")[1]}</span>
                    <span>{timeAgo(selected.createdAt)}</span>
                  </div>
                </div>
                <Link href={pathname.replace("/corpus", "/build") + `?doc=${selected.id}`}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] text-ink-3 border border-border hover:border-ink hover:text-ink transition-colors shrink-0">
                  Build <ExternalLink className="w-2.5 h-2.5" />
                </Link>
              </div>

              {/* Tags */}
              <div className="space-y-1.5">
                {/* Active tags */}
                <div className="flex items-center gap-1 flex-wrap">
                  {selected.tags.map((t) => {
                    const c = tagColor(t);
                    return (
                      <span key={t} className={`inline-flex items-center gap-0.5 font-mono text-[9px] font-medium px-1.5 py-0.5 rounded-sm uppercase ${c.bg} ${c.text}`}>
                        {t}
                        {hasPermission("corpus:write") && <button onClick={() => handleRemoveTag(t)} className="opacity-60 hover:opacity-100 ml-0.5"><X className="w-2.5 h-2.5" /></button>}
                      </span>
                    );
                  })}
                </div>
                {/* Suggested + freeform */}
                {hasPermission("corpus:write") && (
                  <div className="flex items-center gap-1 flex-wrap">
                    {SUGGESTED_TAGS.filter((t) => !selected.tags.includes(t)).map((t) => {
                      const c = tagColor(t);
                      return (
                        <button key={t} onClick={async () => {
                          await api.patch(`/api/schemas/${schemaSlug}/corpus/${selected.id}`, { tags: [...selected.tags, t] });
                          refetch();
                        }} className={`font-mono text-[8px] px-1.5 py-0.5 rounded-sm border border-dashed transition-colors uppercase ${c.text} border-current/30 hover:${c.bg} opacity-50 hover:opacity-100`}>
                          + {t}
                        </button>
                      );
                    })}
                    {showTagInput ? (
                      <form onSubmit={(e) => { e.preventDefault(); handleAddTag(); }} className="inline-flex">
                        <input value={newTag} onChange={(e) => setNewTag(e.target.value)} autoFocus placeholder="custom tag" data-1p-ignore autoComplete="off"
                          onBlur={() => { if (!newTag.trim()) setShowTagInput(false); }}
                          onKeyDown={(e) => { if (e.key === "Escape") { setShowTagInput(false); setNewTag(""); } }}
                          className="w-20 h-[20px] rounded-sm border border-input bg-transparent px-1 text-[9px] font-mono outline-none focus:border-ring placeholder:text-ink-4" />
                      </form>
                    ) : (
                      <button onClick={() => setShowTagInput(true)} className="font-mono text-[8px] text-ink-4 hover:text-ink px-1.5 py-0.5 rounded-sm border border-dashed border-border hover:border-ink/30 transition-colors">
                        + custom
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Preview */}
              <div className="flex-1 min-h-0">
                {previewUrl ? (
                  selected.mimeType === "application/pdf" ? (
                    <iframe src={previewUrl} className="w-full h-full border border-border rounded-sm" title={selected.filename} />
                  ) : (
                    <img src={previewUrl} alt={selected.filename} className="w-full h-full object-contain border border-border rounded-sm" />
                  )
                ) : (
                  <div className="h-full min-h-[200px] border border-border rounded-sm flex items-center justify-center">
                    <span className="animate-pulse font-mono text-[10px] text-ink-4">Loading...</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── GROUND TRUTH ── */}
        <div className="flex flex-col min-h-0 overflow-y-auto">
          {!selected ? (
            <div className="h-full flex items-center justify-center text-[12px] text-ink-4">Select an entry</div>
          ) : (
            <div className="p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div className="font-mono text-[10px] font-medium tracking-[0.08em] uppercase text-ink-4">Ground Truth</div>
                <span className={`font-mono text-[9px] px-1.5 py-0.5 rounded-sm uppercase ${
                  Object.values(gtValues).some((v) => v.trim()) ? "bg-cream-2 text-ink-3" : "bg-cream-2 text-ink-4"
                }`}>
                  {Object.values(gtValues).some((v) => v.trim()) ? "draft" : "empty"}
                </span>
              </div>

              {fields.length === 0 ? (
                <div className="text-[11px] text-ink-4 text-center py-4">Define fields in Build mode first.</div>
              ) : (
                <div className="space-y-2.5">
                  {fields.map((f) => (
                    <div key={f.name} className="space-y-0.5">
                      <label className="flex items-center gap-1">
                        <span className="font-mono text-[10px] font-medium text-ink">{f.name}</span>
                        <span className="font-mono text-[8px] text-ink-4 bg-cream-2 px-1 py-0.5 rounded-sm uppercase">{f.type}</span>
                        {f.required && <span className="font-mono text-[7px] text-vermillion-2 uppercase">req</span>}
                      </label>
                      {f.type === "enum" && f.values ? (
                        <select value={gtValues[f.name] ?? ""} onChange={(e) => setGtValues((p) => ({ ...p, [f.name]: e.target.value }))}
                          className="w-full h-[26px] rounded-sm border border-input bg-white px-2 text-[11px] outline-none focus:border-ring">
                          <option value="">—</option>
                          {f.values.map((v) => <option key={v} value={v}>{v}</option>)}
                        </select>
                      ) : f.type === "number" ? (
                        <input type="number" value={gtValues[f.name] ?? ""} onChange={(e) => setGtValues((p) => ({ ...p, [f.name]: e.target.value }))}
                          className="w-full h-[26px] rounded-sm border border-input bg-transparent px-2 text-[11px] font-mono outline-none focus:border-ring placeholder:text-ink-4" />
                      ) : f.type === "date" ? (
                        <input type="date" value={gtValues[f.name] ?? ""} onChange={(e) => setGtValues((p) => ({ ...p, [f.name]: e.target.value }))}
                          className="w-full h-[26px] rounded-sm border border-input bg-transparent px-2 text-[11px] font-mono outline-none focus:border-ring" />
                      ) : Number((f.validate as Record<string, unknown> | undefined)?.min_words) > 10 ? (
                        <textarea value={gtValues[f.name] ?? ""} onChange={(e) => setGtValues((p) => ({ ...p, [f.name]: e.target.value }))} rows={2}
                          className="w-full rounded-sm border border-input bg-transparent px-2 py-1 text-[11px] outline-none focus:border-ring resize-none placeholder:text-ink-4" />
                      ) : (
                        <input type="text" value={gtValues[f.name] ?? ""} onChange={(e) => setGtValues((p) => ({ ...p, [f.name]: e.target.value }))}
                          className="w-full h-[26px] rounded-sm border border-input bg-transparent px-2 text-[11px] outline-none focus:border-ring placeholder:text-ink-4" />
                      )}
                    </div>
                  ))}
                </div>
              )}

              {fields.length > 0 && (
                <div className="flex items-center gap-2 pt-2 border-t border-border">
                  <button disabled={savingGt || !Object.values(gtValues).some((v) => v.trim())}
                    onClick={async () => {
                      if (!selected) return;
                      setSavingGt(true);
                      try {
                        await api.post(`/api/schemas/${schemaSlug}/corpus/${selected.id}/ground-truth`, { values: gtValues });
                      } finally { setSavingGt(false); }
                    }}
                    className="inline-flex items-center px-3 py-1.5 rounded-sm text-[11px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-30">
                    {savingGt ? "Saving..." : "Save ground truth"}
                  </button>
                  <span className="font-mono text-[9px] text-ink-4">
                    {Object.values(gtValues).filter((v) => v.trim()).length}/{fields.length} fields
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
