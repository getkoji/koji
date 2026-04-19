"use client";

import { useState, useCallback } from "react";
import { ListLayout, Breadcrumbs, PageHeader } from "@/components/layouts";
import { Badge, Meta } from "@/components/shared/SettingsComponents";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { useAuth } from "@/lib/auth-context";

interface Pipeline {
  id: string;
  slug: string;
  displayName: string;
  schemaId: string | null;
  schemaName: string | null;
  deployedVersion: number | null;
  modelProviderId: string | null;
  reviewThreshold: string;
  status: string;
  lastRunAt: string | null;
  createdAt: string;
}

interface SchemaRow {
  slug: string;
  displayName: string;
}

interface ModelProvider {
  id: string;
  displayName: string;
  provider: string;
  model: string;
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "never";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function PipelinesPage() {
  const { hasPermission } = useAuth();
  const [showCreate, setShowCreate] = useState(false);
  const [statusFilter, setStatusFilter] = useState("All");

  const { data: pipelines, loading, refetch } = useApi(
    useCallback(() => api.get<{ data: Pipeline[] }>("/api/pipelines").then((r) => r.data), []),
  );

  const filtered = (pipelines ?? []).filter(
    (p) => statusFilter === "All" || p.status === statusFilter.toLowerCase(),
  );

  return (
    <ListLayout
      header={
        <>
          <Breadcrumbs items={[{ label: "Pipelines" }]} />
          <PageHeader
            title="Pipelines"
            meta={<span>{(pipelines ?? []).length} configured</span>}
            actions={
              hasPermission("pipeline:write") ? (
                <button onClick={() => setShowCreate(true)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors">
                  Create pipeline
                </button>
              ) : undefined
            }
          />
        </>
      }
      filterBar={
        <div className="flex items-center gap-2">
          {["All", "Active", "Paused"].map((s) => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`font-mono text-[10px] px-2.5 py-1 rounded-sm transition-colors ${statusFilter === s ? "bg-ink text-cream" : "text-ink-3 hover:bg-cream-2 hover:text-ink"}`}>
              {s}
            </button>
          ))}
          <span className="flex-1" />
          <span className="font-mono text-[10px] text-ink-4">{filtered.length} pipeline{filtered.length !== 1 ? "s" : ""}</span>
        </div>
      }
    >
      {loading ? (
        <div className="animate-pulse font-mono text-[11px] text-ink-4 py-8 text-center">Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-[13px] text-ink-3">
          {statusFilter !== "All" ? "No pipelines match this filter." : "No pipelines yet. Create one to start processing documents."}
        </div>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              {["Name", "Schema", "Status", "Last run", ""].map((h) => (
                <th key={h} className="text-left px-4 py-2 font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <tr key={p.id} className="border-b border-dotted border-border hover:bg-cream-2/50 transition-colors">
                <td className="px-4 py-2.5 text-[12.5px] text-ink font-medium">{p.displayName}</td>
                <td className="px-4 py-2.5">
                  {p.schemaName ? (
                    <span className="text-[12px] text-ink-2">
                      {p.schemaName}
                      {p.deployedVersion !== null
                        ? <span className="font-mono text-ink-4 ml-1">v{p.deployedVersion}</span>
                        : <span className="text-ink-4 ml-1">— not deployed</span>}
                    </span>
                  ) : (
                    <span className="text-[12px] text-ink-4">No schema</span>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <Badge variant={
                    p.status === "active" && p.deployedVersion !== null ? "active" :
                    p.status === "active" ? "neutral" : "neutral"
                  }>
                    {p.deployedVersion === null && p.status === "active" ? "not deployed" : p.status}
                  </Badge>
                </td>
                <td className="px-4 py-2.5"><Meta>{timeAgo(p.lastRunAt)}</Meta></td>
                <td className="px-4 py-2.5 text-right">
                  {hasPermission("pipeline:write") && (
                    <div className="flex items-center justify-end gap-3">
                      <button onClick={async () => {
                        await api.post(`/api/pipelines/${p.id}/${p.status === "paused" ? "resume" : "pause"}`, {});
                        refetch();
                      }} className="font-mono text-[10px] text-ink-3 hover:text-ink transition-colors">
                        {p.status === "paused" ? "resume" : "pause"}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showCreate && (
        <CreatePipelineDialog onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); refetch(); }} />
      )}
    </ListLayout>
  );
}

function CreatePipelineDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [schemaId, setSchemaId] = useState("");
  const [modelProviderId, setModelProviderId] = useState("");
  const [reviewThreshold, setReviewThreshold] = useState("0.9");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-slug
  if (!slugTouched && name) {
    const auto = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (auto !== slug) setSlug(auto);
  }

  const { data: schemasList } = useApi(
    useCallback(() => api.get<{ data: SchemaRow[] }>("/api/schemas").then((r) => r.data), []),
  );

  const { data: providersList } = useApi(
    useCallback(() => api.get<{ data: ModelProvider[] }>("/api/model-providers").then((r) => r.data), []),
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      await api.post("/api/pipelines", {
        name,
        slug,
        schema_id: schemaId || undefined,
        model_provider_id: modelProviderId || undefined,
        review_threshold: parseFloat(reviewThreshold),
      });
      onCreated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create pipeline");
      setCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[480px] p-6">
        <h2 className="text-[15px] font-medium text-ink mb-1">Create pipeline</h2>
        <p className="text-[12.5px] text-ink-3 mb-5">
          A pipeline connects a schema to a model provider and processes documents.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">Name</label>
              <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Claims Intake" autoFocus
                data-1p-ignore autoComplete="off"
                className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">Slug</label>
              <input required value={slug} onChange={(e) => { setSlugTouched(true); setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "")); }}
                data-1p-ignore autoComplete="off"
                className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4" />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Schema</label>
            <select value={schemaId} onChange={(e) => setSchemaId(e.target.value)}
              className="w-full h-[30px] rounded-sm border border-input bg-white px-2 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30">
              <option value="">Select a schema...</option>
              {(schemasList ?? []).map((s) => (
                <option key={s.slug} value={s.slug}>{s.displayName}</option>
              ))}
            </select>
            {(schemasList ?? []).length === 0 && (
              <p className="text-[11px] text-ink-4">No schemas yet. Create a schema first.</p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Model provider</label>
            <select value={modelProviderId} onChange={(e) => setModelProviderId(e.target.value)}
              className="w-full h-[30px] rounded-sm border border-input bg-white px-2 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30">
              <option value="">Select a provider...</option>
              {(providersList ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.displayName} ({p.model})</option>
              ))}
            </select>
            {(providersList ?? []).length === 0 && (
              <p className="text-[11px] text-ink-4">No providers configured. Add one in Project Settings.</p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Review threshold</label>
            <div className="flex items-center gap-2">
              <input type="number" step="0.01" min="0" max="1" value={reviewThreshold}
                onChange={(e) => setReviewThreshold(e.target.value)}
                className="w-20 h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30" />
              <span className="text-[11px] text-ink-4">Documents below this confidence route to human review</span>
            </div>
          </div>

          {error && <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">{error}</div>}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors">Cancel</button>
            <button type="submit" disabled={creating}
              className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50">
              {creating ? "Creating..." : "Create pipeline"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
