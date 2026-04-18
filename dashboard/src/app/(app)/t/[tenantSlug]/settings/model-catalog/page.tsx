"use client";

import { useState, useCallback } from "react";
import { SectionHeader, SettingsTable, SettingsRow, Badge, Meta } from "@/components/shared/SettingsComponents";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { useAuth } from "@/lib/auth-context";

interface CatalogModel {
  id: string;
  provider: string;
  modelId: string;
  displayName: string;
  contextWindow: number | null;
  supportsVision: string;
  source: string;
  createdAt: string;
}

const PROVIDER_OPTIONS = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "azure-openai", label: "Azure OpenAI" },
  { value: "bedrock", label: "AWS Bedrock" },
  { value: "ollama", label: "Ollama" },
  { value: "custom", label: "Custom" },
];

export default function ModelCatalogPage() {
  const { hasPermission } = useAuth();
  const [showAdd, setShowAdd] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CatalogModel | null>(null);
  const [deleting, setDeleting] = useState(false);

  const { data: models, loading, error, refetch } = useApi(
    useCallback(() => api.get<{ data: CatalogModel[] }>("/api/model-catalog").then((r) => r.data), []),
  );

  const grouped = (models ?? []).reduce<Record<string, CatalogModel[]>>((acc, m) => {
    (acc[m.provider] ??= []).push(m);
    return acc;
  }, {});

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.delete(`/api/model-catalog/${deleteTarget.id}`);
      setDeleteTarget(null);
      refetch();
    } catch {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <section>
        <SectionHeader title="Model Catalog" />
        <div className="animate-pulse font-mono text-[11px] text-ink-4 py-8">Loading...</div>
      </section>
    );
  }

  if (error) {
    return (
      <section>
        <SectionHeader title="Model Catalog" />
        <div className="text-[12.5px] text-vermillion-2 py-4">{error.message}</div>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <section>
        <SectionHeader
          title="Model Catalog"
          action={hasPermission("endpoint:write") ? { label: "Add model", onClick: () => setShowAdd(true) } : undefined}
        />
        <p className="text-[12.5px] text-ink-3 mb-4">
          Models available for extraction pipelines. To fetch models automatically, add a provider in Project Settings and use "Fetch models."
        </p>

        {Object.keys(grouped).length > 0 ? (
          <div className="space-y-6">
            {Object.entries(grouped).map(([provider, providerModels]) => (
              <div key={provider}>
                <div className="font-mono text-[10px] font-medium tracking-[0.1em] uppercase text-ink-4 mb-2">
                  {PROVIDER_OPTIONS.find((p) => p.value === provider)?.label ?? provider}
                </div>
                <SettingsTable>
                  {providerModels.map((m) => (
                    <SettingsRow key={m.id}>
                      <div className="flex items-center gap-4">
                        <span className="text-[12.5px] text-ink font-medium">{m.displayName}</span>
                        <span className="font-mono text-[11px] text-ink-3">{m.modelId}</span>
                        {m.contextWindow && <Meta>{(m.contextWindow / 1000).toFixed(0)}k ctx</Meta>}
                        {m.supportsVision === "true" && <Badge variant="active">vision</Badge>}
                      </div>
                      <div className="flex items-center gap-4">
                        <Badge>{m.source}</Badge>
                        {hasPermission("endpoint:write") && (
                          <button onClick={() => setDeleteTarget(m)}
                            className="font-mono text-[10px] text-vermillion-2 hover:text-ink transition-colors">
                            remove
                          </button>
                        )}
                      </div>
                    </SettingsRow>
                  ))}
                </SettingsTable>
              </div>
            ))}
          </div>
        ) : (
          <div className="border border-border rounded-sm py-6 text-center text-[12.5px] text-ink-3">
            No models in the catalog yet. Add a model provider in Project Settings and use "Fetch models," or add models manually.
          </div>
        )}
      </section>

      {showAdd && (
        <AddModelDialog onClose={() => setShowAdd(false)} onAdded={() => { setShowAdd(false); refetch(); }} />
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-ink/20" onClick={() => setDeleteTarget(null)} />
          <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[380px] p-6">
            <h2 className="text-[15px] font-medium text-ink mb-1">Remove model</h2>
            <p className="text-[12.5px] text-ink-3 mb-5">
              Remove <strong className="text-ink">{deleteTarget.displayName}</strong> from the catalog?
              Existing providers using this model will not be affected.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors">Cancel</button>
              <button onClick={handleDelete} disabled={deleting} className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-vermillion-2 text-cream hover:bg-vermillion transition-colors disabled:opacity-50">
                {deleting ? "Removing..." : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Manual add dialog — for custom/self-hosted models. */
function AddModelDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [provider, setProvider] = useState("custom");
  const [modelId, setModelId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [supportsVision, setSupportsVision] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.post("/api/model-catalog", {
        provider,
        model_id: modelId,
        display_name: displayName || modelId,
        context_window: contextWindow ? parseInt(contextWindow, 10) : undefined,
        supports_vision: supportsVision,
      });
      onAdded();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to add model");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[480px] p-6">
        <h2 className="text-[15px] font-medium text-ink mb-1">Add model manually</h2>
        <p className="text-[12.5px] text-ink-3 mb-5">
          For custom or self-hosted models. To import models from OpenAI, Anthropic, or Ollama, use "Fetch models" on a configured provider instead.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">Provider</label>
              <select value={provider} onChange={(e) => setProvider(e.target.value)}
                className="w-full h-[30px] rounded-sm border border-input bg-white px-2 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30">
                {PROVIDER_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">Model ID</label>
              <input required value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="llama3.2:latest" autoFocus
                className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4" />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Display name</label>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Llama 3.2 (defaults to model ID)"
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">Context window</label>
              <input type="number" value={contextWindow} onChange={(e) => setContextWindow(e.target.value)} placeholder="128000"
                className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">Supports vision</label>
              <div className="flex items-center h-[30px]">
                <label className="flex items-center gap-2 text-[13px] text-ink-3 cursor-pointer">
                  <input type="checkbox" checked={supportsVision} onChange={(e) => setSupportsVision(e.target.checked)} className="rounded border-border" />
                  Yes
                </label>
              </div>
            </div>
          </div>

          {error && <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">{error}</div>}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors">Cancel</button>
            <button type="submit" disabled={saving} className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50">
              {saving ? "Adding..." : "Add model"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
