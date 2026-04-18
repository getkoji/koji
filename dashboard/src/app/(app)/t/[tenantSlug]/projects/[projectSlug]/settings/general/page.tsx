"use client";

import { useState, useCallback, useEffect } from "react";
import { usePathname } from "next/navigation";
import { Pencil } from "lucide-react";
import { api, type ProjectRow } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { useAuth } from "@/lib/auth-context";
import { SectionHeader } from "@/components/shared/SettingsComponents";

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      onClick={handleCopy}
      className="font-mono text-[10px] text-ink-4 hover:text-ink transition-colors px-1.5 py-0.5 border border-border rounded-sm"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

export default function ProjectGeneralPage() {
  const pathname = usePathname();
  const projectSlug = pathname.match(/\/projects\/([^/]+)/)?.[1] ?? "";
  const { hasPermission } = useAuth();

  const { data: project } = useApi(
    useCallback(
      () => api.get<ProjectRow>(`/api/projects/${projectSlug}`),
      [projectSlug],
    ),
  );

  const [displayName, setDisplayName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (project) setDisplayName(project.displayName);
  }, [project]);

  async function handleNameSave() {
    if (!project || displayName === project.displayName) {
      setEditingName(false);
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/api/projects/${projectSlug}`, { display_name: displayName });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } finally {
      setSaving(false);
      setEditingName(false);
    }
  }

  const [confirmDelete, setConfirmDelete] = useState("");
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (confirmDelete !== projectSlug) return;
    setDeleting(true);
    try {
      await api.delete(`/api/projects/${projectSlug}`);
      window.location.href = pathname.replace(/\/projects\/.*/, "");
    } catch {
      setDeleting(false);
    }
  }

  if (!project) {
    return (
      <div className="animate-pulse font-mono text-[11px] text-ink-4 py-8">Loading...</div>
    );
  }

  return (
    <div className="space-y-8">
      <section>
        <SectionHeader title="Project" />
        <div className="border border-border rounded-sm divide-y divide-dotted divide-border">
          {/* Name */}
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="text-[12.5px] text-ink-3 w-28 shrink-0">Name</span>
              {editingName ? (
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleNameSave();
                      if (e.key === "Escape") { setDisplayName(project.displayName); setEditingName(false); }
                    }}
                    className="text-[12.5px] text-ink font-medium bg-transparent border border-border rounded-sm outline-none px-2 py-1 w-64 focus:border-ring focus:ring-[2px] focus:ring-ring/30"
                  />
                  <button
                    onClick={handleNameSave}
                    disabled={saving}
                    className="inline-flex items-center px-2.5 py-1 rounded-sm text-[12px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50"
                  >
                    {saving ? "Saving..." : "Save"}
                  </button>
                  <button
                    onClick={() => { setDisplayName(project.displayName); setEditingName(false); }}
                    className="inline-flex items-center px-2.5 py-1 rounded-sm text-[12px] text-ink-3 hover:text-ink transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <span className="text-[12.5px] text-ink font-medium">{displayName}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {saved && <span className="font-mono text-[10px] text-green">saved</span>}
              {!editingName && (
                <button
                  onClick={() => setEditingName(true)}
                  className="text-ink-4 hover:text-ink transition-colors p-1 rounded-sm hover:bg-cream-2"
                  aria-label="Edit name"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Slug */}
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="text-[12.5px] text-ink-3 w-28 shrink-0">Slug</span>
              <span className="font-mono text-[12px] text-ink">{project.slug}</span>
            </div>
            <div className="flex items-center gap-2">
              <CopyButton value={project.slug} />
              <span className="text-[10px] text-ink-4">not editable</span>
            </div>
          </div>

          {/* Project ID */}
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="text-[12.5px] text-ink-3 w-28 shrink-0">Project ID</span>
              <span className="font-mono text-[11px] text-ink select-all">{project.id}</span>
            </div>
            <CopyButton value={project.id} />
          </div>

          {/* Created */}
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="text-[12.5px] text-ink-3 w-28 shrink-0">Created</span>
              <span className="text-[12.5px] text-ink">
                {new Date(project.createdAt).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Danger zone — admin only */}
      {hasPermission("tenant:admin") && (
        <section>
          <SectionHeader title="Danger zone" />
          <div className="border border-vermillion-2/30 rounded-sm divide-y divide-dotted divide-vermillion-2/20">
            {/* Delete project */}
            <div className="px-4 py-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[12.5px] text-ink font-medium">Delete project</div>
                  <div className="text-[11px] text-ink-3 mt-0.5">
                    Permanently delete this project and all its schemas, jobs, and data. This cannot be undone.
                  </div>
                </div>
              </div>
              <div className="mt-3 flex items-end gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] text-ink-3">
                    Type <span className="font-mono font-medium text-ink">{project.slug}</span> to confirm
                  </label>
                  <input
                    value={confirmDelete}
                    onChange={(e) => setConfirmDelete(e.target.value)}
                    placeholder={project.slug}
                    className="w-48 h-[28px] rounded-sm border border-vermillion-2/30 bg-transparent px-2 text-[12px] font-mono outline-none focus:border-vermillion-2 placeholder:text-ink-4"
                  />
                </div>
                <button
                  disabled={confirmDelete !== project.slug || deleting}
                  onClick={handleDelete}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-[12px] font-medium bg-vermillion-2 text-cream hover:bg-vermillion transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {deleting ? "Deleting..." : "Delete project"}
                </button>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
