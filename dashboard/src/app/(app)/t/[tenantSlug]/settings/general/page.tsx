"use client";

import { useState, useCallback, useEffect } from "react";
import { usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { useAuth } from "@/lib/auth-context";
import { Pencil } from "lucide-react";
import { SectionHeader } from "@/components/shared/SettingsComponents";

interface TenantInfo {
  id: string;
  slug: string;
  displayName: string;
  roles: string[];
}

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

export default function GeneralPage() {
  const pathname = usePathname();
  const tenantSlug = pathname.match(/^\/t\/([^/]+)/)?.[1] ?? "";
  const { hasPermission } = useAuth();

  const { data: tenants } = useApi(
    useCallback(() => api.get<{ data: TenantInfo[] }>("/api/tenants").then((r) => r.data), []),
  );

  const tenant = tenants?.find((t) => t.slug === tenantSlug);

  const [displayName, setDisplayName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (tenant) setDisplayName(tenant.displayName);
  }, [tenant]);

  async function handleNameSave() {
    if (!tenant || displayName === tenant.displayName) return;
    setSaving(true);
    try {
      await api.patch(`/api/tenants/${tenantSlug}`, { display_name: displayName });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } finally {
      setSaving(false);
    }
  }

  const [confirmDelete, setConfirmDelete] = useState("");
  const [deleting, setDeleting] = useState(false);

  if (!tenant) {
    return (
      <div className="animate-pulse font-mono text-[11px] text-ink-4 py-8">Loading...</div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Org info */}
      <section>
        <SectionHeader title="Organization" />
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
                      if (e.key === "Enter") { handleNameSave(); setEditingName(false); }
                      if (e.key === "Escape") { setDisplayName(tenant.displayName); setEditingName(false); }
                    }}
                    className="text-[12.5px] text-ink font-medium bg-transparent border border-border rounded-sm outline-none px-2 py-1 w-64 focus:border-ring focus:ring-[2px] focus:ring-ring/30"
                  />
                  <button
                    onClick={() => { handleNameSave(); setEditingName(false); }}
                    disabled={saving}
                    className="inline-flex items-center px-2.5 py-1 rounded-sm text-[12px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50"
                  >
                    {saving ? "Saving..." : "Save"}
                  </button>
                  <button
                    onClick={() => { setDisplayName(tenant.displayName); setEditingName(false); }}
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
              <span className="font-mono text-[12px] text-ink">{tenant.slug}</span>
            </div>
            <div className="flex items-center gap-2">
              <CopyButton value={tenant.slug} />
              <span className="text-[10px] text-ink-4">not editable</span>
            </div>
          </div>

          {/* Tenant ID */}
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="text-[12.5px] text-ink-3 w-28 shrink-0">Tenant ID</span>
              <span className="font-mono text-[11px] text-ink select-all">{tenant.id}</span>
            </div>
            <CopyButton value={tenant.id} />
          </div>
        </div>
      </section>

      {/* Danger zone — owner only */}
      {hasPermission("tenant:delete") && (
        <section>
          <SectionHeader title="Danger zone" />
          <div className="border border-vermillion-2/30 rounded-sm divide-y divide-dotted divide-vermillion-2/20">
            {/* Transfer ownership */}
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <div className="text-[12.5px] text-ink font-medium">Transfer ownership</div>
                <div className="text-[11px] text-ink-3 mt-0.5">
                  Transfer this organization to another member
                </div>
              </div>
              <button className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-[12px] font-medium border border-vermillion-2/40 text-vermillion-2 hover:bg-vermillion-3/30 transition-colors">
                Transfer
              </button>
            </div>

            {/* Delete organization */}
            <div className="px-4 py-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[12.5px] text-ink font-medium">Delete organization</div>
                  <div className="text-[11px] text-ink-3 mt-0.5">
                    Permanently delete this organization and all its data. This cannot be undone.
                  </div>
                </div>
              </div>
              <div className="mt-3 flex items-end gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] text-ink-3">
                    Type <span className="font-mono font-medium text-ink">{tenant.slug}</span> to confirm
                  </label>
                  <input
                    value={confirmDelete}
                    onChange={(e) => setConfirmDelete(e.target.value)}
                    placeholder={tenant.slug}
                    className="w-48 h-[28px] rounded-sm border border-vermillion-2/30 bg-transparent px-2 text-[12px] font-mono outline-none focus:border-vermillion-2 placeholder:text-ink-4"
                  />
                </div>
                <button
                  disabled={confirmDelete !== tenant.slug || deleting}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-[12px] font-medium bg-vermillion-2 text-cream hover:bg-vermillion transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {deleting ? "Deleting..." : "Delete organization"}
                </button>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
