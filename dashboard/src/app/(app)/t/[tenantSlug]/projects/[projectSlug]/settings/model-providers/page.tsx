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
  deploymentName: string | null;
  apiVersion: string | null;
  awsRegion: string | null;
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

/**
 * Compact one-line summary of a provider's non-secret config, shown
 * next to the provider badge in the list row. Stays under ~40 chars.
 */
function providerConfigSummary(p: ModelProvider): string | null {
  if (p.provider === "azure-openai") {
    const parts: string[] = [];
    if (p.deploymentName) parts.push(p.deploymentName);
    if (p.apiVersion) parts.push(p.apiVersion);
    return parts.length ? parts.join(" · ") : null;
  }
  if (p.provider === "bedrock") {
    return p.awsRegion ?? null;
  }
  return p.baseUrl ?? null;
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
            {(providers ?? []).map((p) => {
              const configSummary = providerConfigSummary(p);
              return (
              <SettingsRow key={p.id}>
                <div className="flex items-center gap-4">
                  <span className="text-[12.5px] text-ink font-medium">{p.displayName}</span>
                  <Badge>{p.provider}</Badge>
                  <span className="font-mono text-[11px] text-ink-3">{p.model}</span>
                  {configSummary && (
                    <span className="font-mono text-[11px] text-ink-4 truncate max-w-[280px]" title={configSummary}>
                      {configSummary}
                    </span>
                  )}
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
              );
            })}
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
            setSuccessMessage("Provider added. Your API key has been encrypted and stored. Click \"fetch models\" to populate the model catalog from this provider.");
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
  const [apiKey, setApiKey] = useState("");
  // Azure-specific
  const [deploymentName, setDeploymentName] = useState("");
  const [apiVersion, setApiVersion] = useState("");
  // Bedrock-specific
  const [awsRegion, setAwsRegion] = useState("");
  const [awsAccessKeyId, setAwsAccessKeyId] = useState("");
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState("");
  const [awsSessionToken, setAwsSessionToken] = useState("");

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
    // Reset secrets so one provider's key never leaks into another's payload.
    setApiKey("");
    setAwsAccessKeyId("");
    setAwsSecretAccessKey("");
    setAwsSessionToken("");
    const pt = PROVIDER_TYPES.find((p) => p.value === value);
    setBaseUrl(pt?.defaultUrl ?? "");
    // Seed a sensible default for the Azure api-version so users don't
    // have to look it up; they can still override.
    if (value === "azure-openai" && !apiVersion) setApiVersion("2024-02-15-preview");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    try {
      // Only send fields that apply to this provider. The backend
      // validates required-per-provider and returns a 400 with a
      // specific message if anything is missing.
      const payload: Record<string, unknown> = {
        name, slug, provider: providerType, model,
      };
      if (providerType === "bedrock") {
        payload.aws_region = awsRegion || undefined;
        payload.aws_access_key_id = awsAccessKeyId || undefined;
        payload.aws_secret_access_key = awsSecretAccessKey || undefined;
        if (awsSessionToken) payload.aws_session_token = awsSessionToken;
      } else {
        payload.base_url = baseUrl || undefined;
        if (providerType === "azure-openai") {
          payload.deployment_name = deploymentName || undefined;
          payload.api_version = apiVersion || undefined;
        }
        if (providerType !== "ollama") {
          payload.api_key = apiKey || undefined;
        }
      }

      await api.post("/api/model-providers", payload);
      onCreated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create provider");
      setCreating(false);
    }
  }

  const isAzure = providerType === "azure-openai";
  const isBedrock = providerType === "bedrock";
  const isOllama = providerType === "ollama";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[480px] p-6 max-h-[90vh] overflow-y-auto">
        <h2 className="text-[15px] font-medium text-ink mb-1">Add model provider</h2>
        <p className="text-[12.5px] text-ink-3 mb-5">
          Configure a model provider for extractions. Credentials are encrypted at rest.
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
              <select value={model} onChange={(e) => setModel(e.target.value)}
                className="w-full h-[30px] rounded-sm border border-input bg-white px-2 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30">
                <option value="">{(catalogModels ?? []).length === 0 ? "No models yet — fetch after adding" : "Select a model..."}</option>
                {(catalogModels ?? []).map((m) => (
                  <option key={m.modelId} value={m.modelId}>{m.displayName}</option>
                ))}
              </select>
              {(catalogModels ?? []).length === 0 && (
                <p className="text-[11px] text-ink-4">
                  Add the provider first, then use &quot;Fetch models&quot; to populate the catalog.
                </p>
              )}
            </div>
          </div>

          {/* Non-Bedrock: base URL (label + required-ness varies by provider) */}
          {!isBedrock && (
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">
                Base URL{isAzure || isOllama ? " *" : ""}
              </label>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                required={isAzure || isOllama}
                placeholder={
                  isAzure ? "https://{resource}.openai.azure.com" :
                  isOllama ? "http://localhost:11434" :
                  "https://api.openai.com/v1"
                }
                className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
              />
            </div>
          )}

          {/* Azure OpenAI: deployment name + api version */}
          {isAzure && (
            <>
              <div className="space-y-1.5">
                <label className="text-[12.5px] font-medium text-ink">Deployment name *</label>
                <input
                  required
                  value={deploymentName}
                  onChange={(e) => setDeploymentName(e.target.value)}
                  placeholder="prod-gpt4o"
                  className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
                />
                <p className="text-[11px] text-ink-4">Azure Portal → your resource → Deployments → this name.</p>
              </div>
              <div className="space-y-1.5">
                <label className="text-[12.5px] font-medium text-ink">API version *</label>
                <input
                  required
                  value={apiVersion}
                  onChange={(e) => setApiVersion(e.target.value)}
                  placeholder="2024-02-15-preview"
                  className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
                />
                <p className="text-[11px] text-ink-4">Typically <span className="font-mono">2024-02-15-preview</span> or newer — check the Azure docs for the latest.</p>
              </div>
            </>
          )}

          {/* Bedrock: region + AWS credential pair (+ optional session token) */}
          {isBedrock && (
            <>
              <div className="space-y-1.5">
                <label className="text-[12.5px] font-medium text-ink">AWS region *</label>
                <input
                  required
                  value={awsRegion}
                  onChange={(e) => setAwsRegion(e.target.value)}
                  placeholder="us-east-1"
                  className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
                />
                <p className="text-[11px] text-ink-4">Example: <span className="font-mono">us-east-1</span>. Bedrock must be enabled in the region.</p>
              </div>
              <div className="space-y-1.5">
                <label className="text-[12.5px] font-medium text-ink">Access key ID *</label>
                <input
                  required
                  value={awsAccessKeyId}
                  onChange={(e) => setAwsAccessKeyId(e.target.value)}
                  placeholder="AKIA..."
                  autoComplete="off"
                  className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
                />
                <p className="text-[11px] text-ink-4">Format: <span className="font-mono">AKIA...</span> (or <span className="font-mono">ASIA...</span> for temporary STS creds).</p>
              </div>
              <div className="space-y-1.5">
                <label className="text-[12.5px] font-medium text-ink">Secret access key *</label>
                <PasswordInput
                  required
                  value={awsSecretAccessKey}
                  onChange={(e) => setAwsSecretAccessKey(e.target.value)}
                  placeholder="40-char secret"
                  autoComplete="off"
                  className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 pr-8 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
                />
                <p className="text-[11px] text-ink-4">Encrypted at rest. Cannot be retrieved — only rotated.</p>
              </div>
              <div className="space-y-1.5">
                <label className="text-[12.5px] font-medium text-ink">Session token (optional)</label>
                <PasswordInput
                  value={awsSessionToken}
                  onChange={(e) => setAwsSessionToken(e.target.value)}
                  placeholder="Only for temporary STS credentials"
                  autoComplete="off"
                  className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 pr-8 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
                />
                <p className="text-[11px] text-ink-4">Only needed if you&apos;re using temporary credentials from AWS STS.</p>
              </div>
            </>
          )}

          {/* Single API key field for non-Bedrock, non-Ollama providers */}
          {!isBedrock && !isOllama && (
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">
                API key{providerType === "custom" ? "" : " *"}
              </label>
              <PasswordInput
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={providerType === "anthropic" ? "sk-ant-..." : "sk-..."}
                required={providerType !== "custom"}
                autoComplete="off"
                className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 pr-8 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
              />
              <p className="text-[11px] text-ink-4">Encrypted at rest. Cannot be retrieved — only rotated.</p>
            </div>
          )}

          {isOllama && (
            <p className="text-[11px] text-ink-4">
              Ollama runs locally, no API key required.
            </p>
          )}

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
  // Single-key flow state (non-Bedrock)
  const [newKey, setNewKey] = useState("");
  // Bedrock flow state — user must re-enter the full credential set.
  // Access key id + secret are required; session token stays optional.
  const [awsAccessKeyId, setAwsAccessKeyId] = useState("");
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState("");
  const [awsSessionToken, setAwsSessionToken] = useState("");

  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isBedrock = provider.provider === "bedrock";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setRotating(true);
    try {
      const payload: Record<string, unknown> = isBedrock
        ? {
            aws_access_key_id: awsAccessKeyId,
            aws_secret_access_key: awsSecretAccessKey,
            ...(awsSessionToken ? { aws_session_token: awsSessionToken } : {}),
          }
        : { api_key: newKey };
      await api.post(`/api/model-providers/${provider.id}/rotate`, payload);
      onRotated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to rotate key");
      setRotating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[420px] p-6 max-h-[90vh] overflow-y-auto">
        <h2 className="text-[15px] font-medium text-ink mb-1">Rotate credentials</h2>
        <p className="text-[12.5px] text-ink-3 mb-5">
          Replace credentials for <strong className="text-ink">{provider.displayName}</strong>. The old credentials will be discarded immediately.
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          {isBedrock ? (
            <>
              <div className="space-y-1.5">
                <label className="text-[12.5px] font-medium text-ink">New access key ID *</label>
                <input
                  required
                  value={awsAccessKeyId}
                  onChange={(e) => setAwsAccessKeyId(e.target.value)}
                  placeholder="AKIA..."
                  autoFocus
                  autoComplete="off"
                  className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[12.5px] font-medium text-ink">New secret access key *</label>
                <PasswordInput
                  required
                  value={awsSecretAccessKey}
                  onChange={(e) => setAwsSecretAccessKey(e.target.value)}
                  placeholder="40-char secret"
                  autoComplete="off"
                  className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 pr-8 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[12.5px] font-medium text-ink">Session token (optional)</label>
                <PasswordInput
                  value={awsSessionToken}
                  onChange={(e) => setAwsSessionToken(e.target.value)}
                  placeholder="Only for temporary STS credentials"
                  autoComplete="off"
                  className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 pr-8 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
                />
                <p className="text-[11px] text-ink-4">Leave blank unless your credentials are temporary STS tokens.</p>
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">New API key</label>
              <PasswordInput required value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="sk-..." autoFocus autoComplete="off"
                className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 pr-8 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4" />
            </div>
          )}
          {error && <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">{error}</div>}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors">Cancel</button>
            <button type="submit" disabled={rotating} className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50">
              {rotating ? "Rotating..." : isBedrock ? "Rotate credentials" : "Rotate key"}
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
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
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
