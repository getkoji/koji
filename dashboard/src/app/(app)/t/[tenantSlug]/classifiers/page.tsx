"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Tags, Plus, ChevronRight, Loader2 } from "lucide-react";
import { classifiers as classifiersApi, type ClassifierRow } from "@/lib/api";
import { ListLayout, Breadcrumbs, PageHeader } from "@/components/layouts";
import { EmptyState } from "@/components/shared/EmptyState";
import { usePageTitle } from "@/lib/use-page-title";

export default function ClassifiersPage() {
  usePageTitle("Classifiers");
  const params = useParams();
  const tenantSlug = params.tenantSlug as string;
  const base = `/t/${tenantSlug}`;

  const [rows, setRows] = useState<ClassifierRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await classifiersApi.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load classifiers");
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ListLayout
      header={
        <>
          <Breadcrumbs items={[{ label: "Classifiers" }]} />
          <PageHeader
            title="Classifiers"
            meta={
              <span>
                Sort documents into your own classes with a cost cascade — cheap deterministic
                signals first, model calls only for the hard tail.
              </span>
            }
            actions={
              <button
                onClick={() => setShowCreate(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
                New classifier
              </button>
            }
          />
        </>
      }
    >
      {error && (
        <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm mb-4">
          {error}
        </div>
      )}

      {rows === null ? (
        <div className="flex items-center gap-2 text-[13px] text-ink-3 py-10 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Tags className="h-6 w-6" />}
          title="No classifiers yet"
          description="Create a classifier to route documents into your own classes."
          action={
            <button
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              New classifier
            </button>
          }
        />
      ) : (
        <div className="border border-border rounded-sm divide-y divide-border overflow-hidden">
          {rows.map((c) => (
            <Link
              key={c.slug}
              href={`${base}/classifiers/${c.slug}`}
              className="flex items-center justify-between px-4 py-3 hover:bg-ink/[0.02] transition-colors group"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium text-ink truncate">{c.displayName}</div>
                <div className="text-[12px] text-ink-3 truncate">
                  {c.description || <span className="text-ink-4">No description</span>}
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0 pl-3">
                <span className="text-[11.5px] text-ink-4 font-mono">
                  {c.latestVersion ? (c.latestVersionLabel ?? `v${c.latestVersion}`) : "draft"}
                </span>
                <ChevronRight className="h-4 w-4 text-ink-4 group-hover:text-ink-3" />
              </div>
            </Link>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateClassifierDialog
          existingSlugs={new Set((rows ?? []).map((r) => r.slug))}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void load();
          }}
        />
      )}
    </ListLayout>
  );
}

function CreateClassifierDialog({
  existingSlugs,
  onClose,
  onCreated,
}: {
  existingSlugs: Set<string>;
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
    if (existingSlugs.has(slug)) {
      setError("A classifier with that slug already exists.");
      return;
    }
    setCreating(true);
    try {
      await classifiersApi.create({ slug, display_name: name, description: description || undefined });
      onCreated(slug);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create classifier");
      setCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[420px] p-6">
        <h2 className="text-[15px] font-medium text-ink mb-1">Create classifier</h2>
        <p className="text-[12.5px] text-ink-3 mb-5">
          Define a new classifier. You&apos;ll edit its classes as YAML next.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Name</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Inbound mail"
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
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""));
              }}
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
              placeholder="What does this classifier sort?"
              data-1p-ignore
              autoComplete="off"
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
            />
          </div>

          {error && (
            <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">{error}</div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating || !slug || !name}
              className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50"
            >
              {creating ? "Creating…" : "Create classifier"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
