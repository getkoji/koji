"use client";

import { useState, useCallback } from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { ClipboardList, Plus, Upload, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";

interface FormMapping {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  samplePageCount: number | null;
  fieldCount: number;
  version: number;
  status: string;
  createdAt: string;
}

export default function FormsListPage() {
  const params = useParams();
  const pathname = usePathname();
  const router = useRouter();
  const schemaSlug = params.schemaSlug as string;
  const tenantSlug = pathname.match(/^\/t\/([^/]+)/)?.[1] ?? "";

  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FormMapping | null>(null);
  const [deleting, setDeleting] = useState(false);

  const { data: forms, loading, refetch } = useApi(
    useCallback(
      () => api.get<{ data: FormMapping[] }>(`/api/forms?schema=${schemaSlug}`).then((r) => r.data),
      [schemaSlug],
    ),
  );

  async function handleCreate() {
    if (!name || !slug) return;
    setCreating(true);
    try {
      const fd = new FormData();
      fd.append("schema_slug", schemaSlug);
      fd.append("display_name", name);
      fd.append("slug", slug);
      if (file) fd.append("file", file);
      const result = await api.postForm<FormMapping>("/api/forms", fd);
      refetch();
      setShowCreate(false);
      setName("");
      setSlug("");
      setFile(null);
      router.push(`${pathname}/${result.slug}`);
    } catch (err: any) {
      alert(err?.message ?? "Failed to create form mapping");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      <div className="px-6 pt-4 pb-3 border-b border-border shrink-0 flex items-start justify-between">
        <div>
          <nav className="flex items-center gap-1.5 font-mono text-[11px] text-ink-4 mb-1">
            <span className="text-ink-3">{schemaSlug}</span>
            <span className="text-cream-4">/</span>
            <span className="text-ink font-medium">Forms</span>
          </nav>
          <h1 className="font-display text-[22px] font-medium leading-none tracking-tight text-ink"
            style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}>
            Form Mappings
          </h1>
          <p className="text-[11px] text-ink-4 mt-1">
            Map fixed-layout PDFs to schema fields by position. Extract by coordinates — no LLM needed.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-[12px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          New form mapping
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {/* Create dialog */}
        {showCreate && (
          <div className="border border-border rounded-sm p-4 mb-4 space-y-3 bg-cream-2/50">
            <h3 className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-ink-4">New Form Mapping</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] text-ink-3 block mb-1">Display name</label>
                <input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!slug || slug === name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")) {
                      setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
                    }
                  }}
                  placeholder="e.g. ACORD 25"
                  className="w-full h-[30px] rounded-sm border border-input bg-white px-2.5 text-[13px] outline-none focus:border-ring"
                />
              </div>
              <div>
                <label className="text-[11px] text-ink-3 block mb-1">Slug</label>
                <input
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="acord-25"
                  className="w-full h-[30px] rounded-sm border border-input bg-white px-2.5 text-[13px] font-mono outline-none focus:border-ring"
                />
              </div>
            </div>
            <div>
              <label className="text-[11px] text-ink-3 block mb-1">Sample PDF</label>
              <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-[12px] text-ink-3 border border-dashed border-border hover:border-ink hover:text-ink transition-colors cursor-pointer">
                <Upload className="w-3.5 h-3.5" />
                {file ? <span className="truncate max-w-[200px]">{file.name}</span> : "Upload a sample PDF"}
                <input type="file" className="hidden" accept=".pdf" onChange={(e) => { if (e.target.files?.[0]) setFile(e.target.files[0]); }} />
              </label>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCreate}
                disabled={!name || !slug || creating}
                className="inline-flex items-center px-3 py-1.5 rounded-sm text-[12px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-30"
              >
                {creating ? "Creating..." : "Create"}
              </button>
              <button
                onClick={() => { setShowCreate(false); setName(""); setSlug(""); setFile(null); }}
                className="px-3 py-1.5 rounded-sm text-[12px] text-ink-3 hover:text-ink transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Forms list */}
        {loading ? (
          <div className="text-center py-12 text-[12px] text-ink-4 animate-pulse">Loading...</div>
        ) : (forms ?? []).length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <ClipboardList className="w-10 h-10 text-ink-4/30 mb-3" />
            <p className="text-[13px] text-ink-3">No form mappings yet</p>
            <p className="text-[11px] text-ink-4 mt-1">Create one to map fixed-layout PDF fields by position</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {(forms ?? []).map((f) => (
              <Link
                key={f.id}
                href={`${pathname}/${f.slug}`}
                className="border border-border rounded-sm p-4 hover:border-vermillion-2 hover:bg-cream-2/30 transition-colors group"
              >
                <div className="flex items-start justify-between">
                  <h3 className="text-[14px] font-medium text-ink group-hover:text-vermillion-2 transition-colors truncate">
                    {f.displayName}
                  </h3>
                  <span className={`font-mono text-[8px] font-medium px-1.5 py-0.5 rounded-sm uppercase ${
                    f.status === "active" ? "bg-green/15 text-green" : "bg-cream-2 text-ink-4"
                  }`}>
                    {f.status}
                  </span>
                </div>
                {f.description && (
                  <p className="text-[11px] text-ink-4 mt-1 line-clamp-2">{f.description}</p>
                )}
                <div className="flex items-center justify-between mt-3">
                  <div className="flex items-center gap-3 font-mono text-[9px] text-ink-4">
                    <span>{f.fieldCount} fields mapped</span>
                    <span>v{f.version}</span>
                  </div>
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDeleteTarget(f);
                    }}
                    className="text-ink-4 hover:text-vermillion-2 transition-colors opacity-0 group-hover:opacity-100"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-cream border border-border rounded-sm shadow-lg w-[380px] p-5">
            <div className="flex items-start justify-between mb-3">
              <h3 className="text-[15px] font-medium text-ink">Delete form mapping</h3>
              <button onClick={() => setDeleteTarget(null)} className="text-ink-4 hover:text-ink">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-[13px] text-ink-3 mb-4">
              Are you sure you want to delete <strong>{deleteTarget.displayName}</strong>? This action cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="px-3 py-1.5 rounded-sm text-[12px] text-ink-3 hover:text-ink transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  setDeleting(true);
                  try {
                    await api.delete(`/api/forms/${deleteTarget.slug}`);
                    setDeleteTarget(null);
                    refetch();
                  } finally {
                    setDeleting(false);
                  }
                }}
                disabled={deleting}
                className="px-3 py-1.5 rounded-sm text-[12px] font-medium bg-vermillion-2 text-cream hover:bg-vermillion-2/90 transition-colors disabled:opacity-50"
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
