"use client";

import { useState, useCallback } from "react";
import { SectionHeader, SettingsTable, SettingsRow, Badge, Meta } from "@/components/shared/SettingsComponents";
import { PasswordInput } from "@/components/shared/PasswordInput";
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
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

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
      {successMessage && (
        <div className="border border-green/30 bg-green/5 rounded-sm p-4 flex items-center justify-between">
          <span className="text-[12.5px] text-ink">{successMessage}</span>
          <button onClick={() => setSuccessMessage(null)} className="text-[11px] text-ink-3 hover:text-ink">dismiss</button>
        </div>
      )}

      <section>
        <SectionHeader
          title="Model Catalog"
          action={hasPermission("endpoint:write") ? { label: "Add models", onClick: () => setShowAdd(true) } : undefined}
        />
        <p className="text-[12.5px] text-ink-3 mb-4">
          Approved models available for use in extraction pipelines. Users select from this list when configuring providers.
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
            No models in the catalog yet. Click "Add models" to fetch from a provider or add custom models.
          </div>
        )}
      </section>

      {showAdd && (
        <AddModelsDialog
          onClose={() => setShowAdd(false)}
          onAdded={(count) => {
            setShowAdd(false);
            setSuccessMessage(`Added ${count} model${count !== 1 ? "s" : ""} to the catalog.`);
            refetch();
          }}
        />
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-ink/20" onClick={() => setDeleteTarget(null)} />
          <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[380px] p-6">
            <h2 className="text-[15px] font-medium text-ink mb-1">Remove model</h2>
            <p className="text-[12.5px] text-ink-3 mb-5">
              Remove <strong className="text-ink">{deleteTarget.displayName}</strong> from the catalog?
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

interface FetchedModel {
  id: string;
  name: string;
  context?: number;
}

function AddModelsDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (count: number) => void }) {
  const [mode, setMode] = useState<"fetch" | "manual">("fetch");

  // Fetch mode
  const [fetchProvider, setFetchProvider] = useState("openai");
  const [fetchApiKey, setFetchApiKey] = useState("");
  const [fetchBaseUrl, setFetchBaseUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<FetchedModel[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  // Manual mode
  const [provider, setProvider] = useState("custom");
  const [modelId, setModelId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [supportsVision, setSupportsVision] = useState(false);
  const [saving, setSaving] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const needsApiKey = fetchProvider === "openai" || fetchProvider === "azure-openai";
  const needsBaseUrl = fetchProvider === "ollama" || fetchProvider === "azure-openai" || fetchProvider === "custom";

  async function handleFetch() {
    setError(null);
    setFetching(true);
    try {
      const result = await api.post<{ data: FetchedModel[] }>("/api/model-catalog/fetch", {
        provider: fetchProvider,
        api_key: fetchApiKey || undefined,
        base_url: fetchBaseUrl || undefined,
      });
      setFetchedModels(result.data);
      setSelected(new Set(result.data.map((m) => m.id)));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to fetch models");
    } finally {
      setFetching(false);
    }
  }

  async function handleAddSelected() {
    if (!fetchedModels || selected.size === 0) return;
    setAdding(true);
    setError(null);
    try {
      const models = fetchedModels.filter((m) => selected.has(m.id));
      await api.post("/api/model-catalog/bulk", { provider: fetchProvider, models });
      onAdded(selected.size);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to add models");
      setAdding(false);
    }
  }

  async function handleManualSubmit(e: React.FormEvent) {
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
      onAdded(1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to add model");
      setSaving(false);
    }
  }

  function toggleModel(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (!fetchedModels) return;
    if (selected.size === fetchedModels.length) setSelected(new Set());
    else setSelected(new Set(fetchedModels.map((m) => m.id)));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[520px] p-6 max-h-[80vh] overflow-y-auto">
        <h2 className="text-[15px] font-medium text-ink mb-4">Add models to catalog</h2>

        <div className="flex gap-1 mb-5 border border-border rounded-sm p-0.5 w-fit">
          <button onClick={() => { setMode("fetch"); setError(null); }}
            className={`px-3 py-1.5 rounded-sm text-[12.5px] font-medium transition-colors ${mode === "fetch" ? "bg-ink text-cream" : "text-ink-3 hover:text-ink"}`}>
            Fetch from provider
          </button>
          <button onClick={() => { setMode("manual"); setError(null); }}
            className={`px-3 py-1.5 rounded-sm text-[12.5px] font-medium transition-colors ${mode === "manual" ? "bg-ink text-cream" : "text-ink-3 hover:text-ink"}`}>
            Add manually
          </button>
        </div>

        {mode === "fetch" ? (
          <div className="space-y-4">
            {!fetchedModels ? (
              <>
                <p className="text-[12.5px] text-ink-3">
                  Enter credentials to query a provider's available models. The key is used for this request only and is not stored.
                </p>

                <div className="space-y-1.5">
                  <label className="text-[12.5px] font-medium text-ink">Provider</label>
                  <select value={fetchProvider} onChange={(e) => { setFetchProvider(e.target.value); setError(null); }}
                    className="w-full h-[30px] rounded-sm border border-input bg-white px-2 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30">
                    {PROVIDER_OPTIONS.filter((p) => p.value !== "custom").map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </div>

                {needsApiKey && (
                  <div className="space-y-1.5">
                    <label className="text-[12.5px] font-medium text-ink">API key</label>
                    <PasswordInput value={fetchApiKey} onChange={(e) => setFetchApiKey(e.target.value)} placeholder="sk-..." autoComplete="off"
                      className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 pr-8 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4" />
                    <p className="text-[11px] text-ink-4">Used for this request only. Not stored.</p>
                  </div>
                )}

                {needsBaseUrl && (
                  <div className="space-y-1.5">
                    <label className="text-[12.5px] font-medium text-ink">Base URL</label>
                    <input value={fetchBaseUrl} onChange={(e) => setFetchBaseUrl(e.target.value)}
                      placeholder={fetchProvider === "ollama" ? "http://localhost:11434" : "https://..."}
                      className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4" />
                  </div>
                )}

                {fetchProvider === "anthropic" && (
                  <p className="text-[12px] text-ink-4">Anthropic doesn't have a public models API. Known current models will be added.</p>
                )}

                {error && <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">{error}</div>}

                <div className="flex items-center justify-end gap-2 pt-1">
                  <button onClick={onClose} className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors">Cancel</button>
                  <button onClick={handleFetch} disabled={fetching || (needsApiKey && !fetchApiKey)}
                    className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50">
                    {fetching ? "Fetching..." : "Fetch models"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[12.5px] text-ink-3">
                    {fetchedModels.length} model{fetchedModels.length !== 1 ? "s" : ""} found. Select which to approve for use.
                  </p>
                  <button onClick={toggleAll} className="text-[11px] text-vermillion-2 hover:text-ink transition-colors font-mono">
                    {selected.size === fetchedModels.length ? "deselect all" : "select all"}
                  </button>
                </div>

                <div className="border border-border rounded-sm max-h-[300px] overflow-y-auto divide-y divide-dotted divide-border">
                  {fetchedModels.map((m) => (
                    <label key={m.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-cream-2 cursor-pointer">
                      <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggleModel(m.id)} className="rounded border-border" />
                      <div className="flex-1 min-w-0">
                        <div className="text-[12.5px] text-ink font-medium truncate">{m.name}</div>
                        <div className="font-mono text-[10px] text-ink-4 truncate">{m.id}</div>
                      </div>
                      {m.context && <span className="font-mono text-[10px] text-ink-4 shrink-0">{(m.context / 1000).toFixed(0)}k</span>}
                    </label>
                  ))}
                </div>

                {error && <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm mt-3">{error}</div>}

                <div className="flex items-center justify-between pt-4">
                  <button onClick={() => setFetchedModels(null)} className="text-[12px] text-ink-3 hover:text-ink transition-colors">← Back</button>
                  <div className="flex items-center gap-2">
                    <button onClick={onClose} className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors">Cancel</button>
                    <button onClick={handleAddSelected} disabled={selected.size === 0 || adding}
                      className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50">
                      {adding ? "Adding..." : `Add ${selected.size} model${selected.size !== 1 ? "s" : ""}`}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        ) : (
          <form onSubmit={handleManualSubmit} className="space-y-4">
            <p className="text-[12.5px] text-ink-3">For custom or self-hosted models not available via a provider API.</p>

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
        )}
      </div>
    </div>
  );
}
