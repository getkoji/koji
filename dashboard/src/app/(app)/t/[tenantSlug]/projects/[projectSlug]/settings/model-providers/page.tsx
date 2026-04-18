"use client";

import { useState, useCallback } from "react";
import { SectionHeader, SettingsTable, SettingsRow, Badge, Meta } from "@/components/shared/SettingsComponents";
import { PasswordInput } from "@/components/shared/PasswordInput";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { useAuth } from "@/lib/auth-context";

interface ModelProvider {
  id: string;
  slug: string;
  displayName: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  keyHint: string | null;
  hasKey: boolean;
  status: string;
  lastHealthCheckAt: string | null;
  createdAt: string;
}

const PROVIDER_TYPES = [
  { value: "openai", label: "OpenAI", defaultUrl: "https://api.openai.com/v1" },
  { value: "anthropic", label: "Anthropic", defaultUrl: "https://api.anthropic.com" },
  { value: "azure-openai", label: "Azure OpenAI", defaultUrl: "" },
  { value: "bedrock", label: "AWS Bedrock", defaultUrl: "" },
  { value: "ollama", label: "Ollama", defaultUrl: "http://localhost:11434" },
  { value: "custom", label: "Custom", defaultUrl: "" },
];

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

export default function ModelProvidersPage() {
  const { hasPermission } = useAuth();
  const [showAdd, setShowAdd] = useState(false);
  const [rotateTarget, setRotateTarget] = useState<ModelProvider | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelProvider | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const { data: providers, loading, error, refetch } = useApi(
    useCallback(() => api.get<{ data: ModelProvider[] }>("/api/model-providers").then((r) => r.data), []),
  );

  if (loading) {
    return (
      <section>
        <SectionHeader title="Model Providers" />
        <div className="animate-pulse font-mono text-[11px] text-ink-4 py-8">Loading...</div>
      </section>
    );
  }

  if (error) {
    return (
      <section>
        <SectionHeader title="Model Providers" />
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
          title="Model Providers"
          action={hasPermission("endpoint:write") ? { label: "Add provider", onClick: () => setShowAdd(true) } : undefined}
        />

        {(providers ?? []).length > 0 ? (
          <SettingsTable>
            {(providers ?? []).map((p) => (
              <SettingsRow key={p.id}>
                <div className="flex items-center gap-4">
                  <span className="text-[12.5px] text-ink font-medium">{p.displayName}</span>
                  <Badge>{p.provider}</Badge>
                  <span className="font-mono text-[11px] text-ink-3">{p.model}</span>
                </div>
                <div className="flex items-center gap-4">
                  {p.keyHint && <Meta>••••{p.keyHint}</Meta>}
                  <Badge variant={p.status === "active" ? "active" : "neutral"}>{p.status}</Badge>
                  {hasPermission("endpoint:write") && (
                    <>
                      <button onClick={() => setRotateTarget(p)} className="font-mono text-[10px] text-ink-3 hover:text-ink transition-colors">
                        rotate key
                      </button>
                      <button onClick={() => setDeleteTarget(p)} className="font-mono text-[10px] text-vermillion-2 hover:text-ink transition-colors">
                        delete
                      </button>
                    </>
                  )}
                </div>
              </SettingsRow>
            ))}
          </SettingsTable>
        ) : (
          <div className="border border-border rounded-sm py-6 text-center text-[12.5px] text-ink-3">
            No model providers configured. Add one to start running extractions.
          </div>
        )}
      </section>

      {showAdd && (
        <AddProviderDialog
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            setSuccessMessage("Provider added. Your API key has been encrypted and stored. It cannot be retrieved — only rotated.");
            refetch();
          }}
        />
      )}

      {rotateTarget && (
        <RotateKeyDialog
          provider={rotateTarget}
          onClose={() => setRotateTarget(null)}
          onRotated={() => {
            setRotateTarget(null);
            setSuccessMessage("Credentials rotated successfully.");
            refetch();
          }}
        />
      )}

      {deleteTarget && (
        <DeleteProviderDialog
          provider={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => { setDeleteTarget(null); refetch(); }}
        />
      )}
    </div>
  );
}

interface CatalogModel {
  id: string;
  provider: string;
  modelId: string;
  displayName: string;
}

function AddProviderDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [providerType, setProviderType] = useState("openai");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [credentials, setCredentials] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch models from catalog filtered by provider
  const { data: catalogModels } = useApi(
    useCallback(
      () => api.get<{ data: CatalogModel[] }>(`/api/model-catalog?provider=${providerType}`).then((r) => r.data),
      [providerType],
    ),
  );

  function handleProviderChange(value: string) {
    setProviderType(value);
    setModel(""); // reset model when switching providers
    const pt = PROVIDER_TYPES.find((p) => p.value === value);
    if (pt?.defaultUrl) setBaseUrl(pt.defaultUrl);
    else setBaseUrl("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    try {
      await api.post("/api/model-providers", {
        name, slug, provider: providerType, model,
        base_url: baseUrl || undefined,
        credentials: credentials || undefined,
      });
      onCreated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create provider");
      setCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[480px] p-6">
        <h2 className="text-[15px] font-medium text-ink mb-1">Add model provider</h2>
        <p className="text-[12.5px] text-ink-3 mb-5">
          Configure a model provider for extractions. Your API key will be encrypted at rest.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Name</label>
            <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. OpenAI Production" autoFocus
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">Provider</label>
              <select value={providerType} onChange={(e) => handleProviderChange(e.target.value)}
                className="w-full h-[30px] rounded-sm border border-input bg-white px-2 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30">
                {PROVIDER_TYPES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">Default model</label>
              {(catalogModels ?? []).length > 0 ? (
                <select required value={model} onChange={(e) => setModel(e.target.value)}
                  className="w-full h-[30px] rounded-sm border border-input bg-white px-2 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30">
                  <option value="">Select a model...</option>
                  {(catalogModels ?? []).map((m) => (
                    <option key={m.modelId} value={m.modelId}>{m.displayName}</option>
                  ))}
                </select>
              ) : (
                <input required value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. gpt-4o"
                  className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4" />
              )}
              {(catalogModels ?? []).length === 0 && (
                <p className="text-[11px] text-ink-4">
                  No models in catalog for this provider. <a href="" onClick={(e) => { e.preventDefault(); }} className="text-vermillion-2">Add models</a> in Organization → Model Catalog first, or type a model ID directly.
                </p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Base URL</label>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1"
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4" />
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">API key</label>
            <PasswordInput value={credentials} onChange={(e) => setCredentials(e.target.value)} placeholder="sk-..." autoComplete="off"
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 pr-8 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4" />
            <p className="text-[11px] text-ink-4">Encrypted at rest. Cannot be retrieved — only rotated.</p>
          </div>

          {error && <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">{error}</div>}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors">Cancel</button>
            <button type="submit" disabled={creating} className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50">
              {creating ? "Creating..." : "Add provider"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function RotateKeyDialog({ provider, onClose, onRotated }: { provider: ModelProvider; onClose: () => void; onRotated: () => void }) {
  const [newKey, setNewKey] = useState("");
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setRotating(true);
    try {
      await api.post(`/api/model-providers/${provider.id}/rotate`, { credentials: newKey });
      onRotated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to rotate key");
      setRotating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[420px] p-6">
        <h2 className="text-[15px] font-medium text-ink mb-1">Rotate credentials</h2>
        <p className="text-[12.5px] text-ink-3 mb-5">
          Replace the API key for <strong className="text-ink">{provider.displayName}</strong>. The old key will be discarded immediately.
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">New API key</label>
            <PasswordInput required value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="sk-..." autoFocus autoComplete="off"
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 pr-8 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4" />
          </div>
          {error && <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">{error}</div>}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors">Cancel</button>
            <button type="submit" disabled={rotating} className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50">
              {rotating ? "Rotating..." : "Rotate key"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DeleteProviderDialog({ provider, onClose, onDeleted }: { provider: ModelProvider; onClose: () => void; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    try {
      await api.delete(`/api/model-providers/${provider.id}`);
      onDeleted();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to delete");
      setDeleting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[380px] p-6">
        <h2 className="text-[15px] font-medium text-ink mb-1">Delete model provider</h2>
        <p className="text-[12.5px] text-ink-3 mb-5">
          Delete <strong className="text-ink">{provider.displayName}</strong>? The encrypted credentials will be permanently removed.
        </p>
        {error && <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm mb-4">{error}</div>}
        <div className="flex items-center justify-end gap-2">
          <button onClick={onClose} className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors">Cancel</button>
          <button onClick={handleDelete} disabled={deleting} className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-vermillion-2 text-cream hover:bg-vermillion transition-colors disabled:opacity-50">
            {deleting ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
