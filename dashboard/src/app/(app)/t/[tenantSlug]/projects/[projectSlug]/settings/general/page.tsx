"use client";

import { useState, useCallback, useEffect } from "react";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import { Pencil, Trash2 } from "lucide-react";
import { api, schemas as schemasApi, type ProjectRow, type SchemaRow } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { useAuth } from "@/lib/auth-context";
import { emit, on } from "@/lib/events";
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
  const tenantSlug = pathname.match(/^\/t\/([^/]+)/)?.[1] ?? "";
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
      emit("projects:updated");
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

      <SchemasSection tenantSlug={tenantSlug} />

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

// ── Schemas section ──

function SchemasSection({ tenantSlug }: { tenantSlug: string }) {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission("schema:write");

  const { data: schemasList, loading, refetch } = useApi(
    useCallback(() => schemasApi.list(), []),
  );

  useEffect(() => on("schemas:updated", refetch), [refetch]);

  const [showCreate, setShowCreate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SchemaRow | null>(null);
  const [renameTarget, setRenameTarget] = useState<SchemaRow | null>(null);

  return (
    <section>
      <SectionHeader title="Schemas" />

      {loading ? (
        <div className="border border-border rounded-sm px-4 py-6 text-[12px] text-ink-4 animate-pulse">
          Loading schemas...
        </div>
      ) : (schemasList ?? []).length === 0 ? (
        <div className="border border-border rounded-sm px-4 py-8 text-center space-y-3">
          <div className="text-[12.5px] text-ink-3">No schemas in this project.</div>
          {canWrite && (
            <button
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors"
            >
              <span className="text-[14px] leading-none">+</span> Create schema
            </button>
          )}
        </div>
      ) : (
        <div className="border border-border rounded-sm overflow-hidden">
          <div className="grid grid-cols-[1fr_72px_120px_auto] items-center gap-3 px-4 py-2 bg-cream-2/40 border-b border-border">
            <span className="font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase text-ink-4">Name</span>
            <span className="font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase text-ink-4">Version</span>
            <span className="font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase text-ink-4">Corpus</span>
            <span className="font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase text-ink-4 text-right pr-1">Actions</span>
          </div>
          {(schemasList ?? []).map((s) => (
            <SchemaRowItem
              key={s.slug}
              schema={s}
              canWrite={canWrite}
              onRename={() => setRenameTarget(s)}
              onDelete={() => setDeleteTarget(s)}
            />
          ))}
        </div>
      )}

      {showCreate && typeof document !== "undefined" && createPortal(
        <CreateSchemaDialog
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            emit("schemas:updated");
          }}
        />,
        document.body,
      )}

      {renameTarget && typeof document !== "undefined" && createPortal(
        <RenameSchemaDialog
          schema={renameTarget}
          onClose={() => setRenameTarget(null)}
          onRenamed={() => {
            setRenameTarget(null);
            emit("schemas:updated");
          }}
        />,
        document.body,
      )}

      {deleteTarget && typeof document !== "undefined" && createPortal(
        <DeleteSchemaDialog
          schema={deleteTarget}
          tenantSlug={tenantSlug}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            setDeleteTarget(null);
            emit("schemas:updated");
          }}
        />,
        document.body,
      )}
    </section>
  );
}

function SchemaRowItem({
  schema,
  canWrite,
  onRename,
  onDelete,
}: {
  schema: SchemaRow;
  canWrite: boolean;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="grid grid-cols-[1fr_72px_120px_auto] items-center gap-3 px-4 py-2.5 border-b border-dotted border-border last:border-b-0 hover:bg-cream-2/30 transition-colors">
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="text-[12.5px] text-ink font-medium truncate">{schema.displayName}</span>
        <span className="font-mono text-[10.5px] text-ink-4 truncate">{schema.slug}</span>
      </div>
      <span className="font-mono text-[11px] text-ink-3">
        {schema.latestVersion != null ? `v${schema.latestVersion}` : "—"}
      </span>
      <span className="font-mono text-[11px] text-ink-3">
        {schema.corpusCount ?? 0} {schema.corpusCount === 1 ? "entry" : "entries"}
      </span>
      <div className="flex items-center justify-end gap-1">
        {canWrite && (
          <>
            <button
              onClick={onRename}
              className="font-mono text-[10.5px] text-ink-3 hover:text-ink transition-colors px-2 py-1 rounded-sm hover:bg-cream-2"
            >
              Rename
            </button>
            <button
              onClick={onDelete}
              className="font-mono text-[10.5px] text-vermillion-2 hover:bg-vermillion-3/40 transition-colors px-2 py-1 rounded-sm inline-flex items-center gap-1"
            >
              <Trash2 className="w-3 h-3" /> Delete
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function RenameSchemaDialog({
  schema,
  onClose,
  onRenamed,
}: {
  schema: SchemaRow;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const [value, setValue] = useState(schema.displayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = value.trim();
  const canSave = trimmed.length > 0 && trimmed !== schema.displayName;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await schemasApi.update(schema.slug, { display_name: trimmed });
      onRenamed();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to rename schema");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[420px] p-6">
        <h2 className="text-[15px] font-medium text-ink mb-1">Rename schema</h2>
        <p className="text-[12.5px] text-ink-3 mb-5">
          Only the display name changes. The slug{" "}
          <span className="font-mono text-ink">{schema.slug}</span> stays the
          same so URLs and references keep working.
        </p>

        <form onSubmit={handleSave} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Name</label>
            <input
              autoFocus
              value={value}
              disabled={saving}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
              data-1p-ignore
              autoComplete="off"
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
            />
          </div>

          {error && (
            <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSave || saving}
              className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DeleteSchemaDialog({
  schema,
  tenantSlug,
  onClose,
  onDeleted,
}: {
  schema: SchemaRow;
  tenantSlug: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [confirm, setConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canDelete = confirm === schema.slug;

  async function handleDelete() {
    if (!canDelete) return;
    setDeleting(true);
    setError(null);
    try {
      await schemasApi.delete(schema.slug);
      // If the sidebar's stored active schema points at the deleted one,
      // clear it so the sidebar falls back to another schema (or the empty
      // state) without trying to navigate to a dead slug.
      if (typeof window !== "undefined") {
        const key = `koji:schema:${tenantSlug}`;
        if (localStorage.getItem(key) === schema.slug) {
          localStorage.removeItem(key);
        }
      }
      onDeleted();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to delete schema");
      setDeleting(false);
    }
  }

  const versionCount = schema.latestVersion ?? 0;
  const corpusCount = schema.corpusCount ?? 0;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[440px] p-6">
        <h2 className="text-[15px] font-medium text-ink mb-1">
          Delete schema &lsquo;{schema.slug}&rsquo;?
        </h2>
        <p className="text-[12.5px] text-ink-3 mb-4">
          This will permanently delete:
        </p>
        <ul className="text-[12.5px] text-ink-2 mb-4 space-y-1 list-disc list-inside marker:text-ink-4">
          <li>{versionCount} schema {versionCount === 1 ? "version" : "versions"}</li>
          <li>{corpusCount} corpus {corpusCount === 1 ? "entry" : "entries"} and their ground truth</li>
          <li>All validate run history</li>
        </ul>
        <p className="text-[12px] text-ink-3 mb-4">
          Any pipelines using this schema will be unlinked.
        </p>

        <div className="space-y-1.5 mb-4">
          <label className="text-[12px] text-ink-3">
            Type <span className="font-mono font-medium text-ink">{schema.slug}</span> to confirm:
          </label>
          <input
            autoFocus
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && canDelete) handleDelete(); }}
            className="w-full h-[30px] rounded-sm border border-vermillion-2/30 bg-transparent px-2.5 text-[13px] font-mono outline-none focus:border-vermillion-2 placeholder:text-ink-4"
            data-1p-ignore
            autoComplete="off"
            placeholder={schema.slug}
          />
        </div>

        {error && (
          <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm mb-3">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canDelete || deleting}
            onClick={handleDelete}
            className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-vermillion-2 text-cream hover:bg-vermillion transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {deleting ? "Deleting..." : "Delete schema"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateSchemaDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (slug: string) => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!slugTouched && name) {
    const auto = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .replace(/-+/g, "_");
    if (auto !== slug) setSlug(auto);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      await api.post("/api/schemas", {
        slug,
        display_name: name,
        description: description || undefined,
      });
      onCreated(slug);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create schema");
      setCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[420px] p-6">
        <h2 className="text-[15px] font-medium text-ink mb-1">Create schema</h2>
        <p className="text-[12.5px] text-ink-3 mb-5">
          Define a new extraction schema. You&rsquo;ll edit the YAML in build mode.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Name</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Insurance Claim"
              autoFocus
              data-1p-ignore
              autoComplete="off"
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Slug</label>
            <input
              required
              value={slug}
              onChange={(e) => { setSlugTouched(true); setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "")); }}
              data-1p-ignore
              autoComplete="off"
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
            />
            <p className="text-[11px] text-ink-4">Used in the URL and API. Lowercase, underscores.</p>
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">
              Description <span className="text-ink-4 font-normal">(optional)</span>
            </label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this schema extract?"
              data-1p-ignore
              autoComplete="off"
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
            />
          </div>

          {error && (
            <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">{error}</div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors">Cancel</button>
            <button
              type="submit"
              disabled={creating}
              className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50"
            >
              {creating ? "Creating..." : "Create schema"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
