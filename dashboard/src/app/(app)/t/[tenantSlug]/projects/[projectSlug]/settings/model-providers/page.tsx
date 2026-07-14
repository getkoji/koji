"use client";

import { useState, useCallback } from "react";
import {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
  Dialog,
  DialogPortal,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@koji/ui";
import { SectionHeader, Badge, Meta } from "@/components/shared/SettingsComponents";
import { PasswordInput } from "@/components/shared/PasswordInput";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { useAuth } from "@/lib/auth-context";
import { inferModelCapabilities, type ModelCapability } from "@/lib/model-capabilities";
import { usePageTitle } from "@/lib/use-page-title";

// ── Types ─────────────────────────────────────────────────────────────────

interface TenantModel {
  id: string;
  model: string;
  capability: "chat" | "vision" | "ocr";
  displayName: string | null;
  status: string;
  createdAt: string;
}

interface Credential {
  id: string;
  slug: string;
  displayName: string;
  provider: string;
  baseUrl: string | null;
  deploymentName: string | null;
  apiVersion: string | null;
  awsRegion: string | null;
  keyHint: string | null;
  status: string;
  healthState: string;
  lastHealthCheckAt: string | null;
  createdAt: string;
  models: TenantModel[];
}

const PROVIDER_TYPES = [
  { value: "openai", label: "OpenAI", defaultUrl: "https://api.openai.com/v1" },
  { value: "anthropic", label: "Anthropic", defaultUrl: "https://api.anthropic.com" },
  { value: "azure-openai", label: "Azure OpenAI", defaultUrl: "" },
  { value: "bedrock", label: "AWS Bedrock", defaultUrl: "" },
  { value: "ollama", label: "Ollama", defaultUrl: "http://localhost:11434" },
  { value: "custom", label: "Custom", defaultUrl: "" },
];

const FALLBACK_SUGGESTIONS: Record<string, string[]> = {
  openai: ["gpt-4o", "gpt-4o-mini"],
  anthropic: ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"],
  ollama: ["llama3.2", "mistral"],
};

interface RegistryModel {
  provider: string;
  modelId: string;
  displayName: string;
  isRecommended: boolean;
  /**
   * Per-model capability tags. Present on responses served by
   * platform-129 and later; falls back to the client-side
   * inferModelCapabilities heuristic when absent (older cached
   * registry payloads, self-populated FALLBACK_SUGGESTIONS).
   */
  capabilities?: ModelCapability[];
}

/** Prefer registry-declared capabilities, fall back to the local heuristic. */
function capsFor(m: { modelId: string; capabilities?: ModelCapability[] }): ModelCapability[] {
  return m.capabilities && m.capabilities.length > 0
    ? m.capabilities
    : inferModelCapabilities(m.modelId);
}

// ── Model picker ──────────────────────────────────────────────────────────
// Searchable model select built on the shared @koji/ui Combobox. The list is
// portaled out of the dialog (it would otherwise be clipped by the dialog's
// `overflow-y-auto`), and we get filtering + keyboard nav for free.

interface ModelOption {
  modelId: string;
  displayName: string;
  isRecommended: boolean;
  capabilities?: ModelCapability[];
}

function ModelCombobox({
  models,
  value,
  onSelect,
  placeholder = "Search models...",
  autoFocus,
}: {
  models: ModelOption[];
  value: string;
  onSelect: (modelId: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const selected = models.find((m) => m.modelId === value) ?? null;
  return (
    <Combobox<ModelOption>
      items={models}
      value={selected}
      onValueChange={(m) => onSelect(m?.modelId ?? "")}
      itemToStringLabel={(m) => m.modelId}
      itemToStringValue={(m) => m.modelId}
      isItemEqualToValue={(a, b) => a.modelId === b.modelId}
      filter={(item, query) => {
        const q = query.trim().toLowerCase();
        if (!q) return true;
        return (
          item.modelId.toLowerCase().includes(q) ||
          item.displayName.toLowerCase().includes(q)
        );
      }}
    >
      <ComboboxInput
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="font-mono text-[13px]"
      />
      <ComboboxContent>
        <ComboboxEmpty>No models found</ComboboxEmpty>
        <ComboboxList>
          {(m: ModelOption) => (
            <ComboboxItem
              key={m.modelId}
              value={m}
              className={`font-mono text-[12px] ${m.isRecommended ? "font-medium" : ""}`}
            >
              <span className="truncate">{m.modelId}</span>
              <span className="ml-auto flex items-center gap-1">
                {capsFor(m).map((c) => (
                  <span
                    key={c}
                    className="text-[9px] uppercase tracking-wider text-ink-3 bg-cream-2 px-1 py-0.5 rounded"
                  >
                    {c}
                  </span>
                ))}
                {m.isRecommended && (
                  <span className="text-[9px] text-vermillion-2 uppercase tracking-wider ml-1">
                    recommended
                  </span>
                )}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

const CAPABILITIES: Array<{ value: TenantModel["capability"]; label: string; hint: string }> = [
  { value: "chat", label: "Chat", hint: "Text-in, text-out. Default for extraction." },
  { value: "vision", label: "Vision", hint: "Accepts page images. Used for bad-scan escalation." },
  { value: "ocr", label: "OCR", hint: "Dedicated OCR engine for scanned PDFs." },
];

function providerConfigSummary(c: Credential): string | null {
  if (c.provider === "azure-openai") {
    const parts: string[] = [];
    if (c.deploymentName) parts.push(c.deploymentName);
    if (c.apiVersion) parts.push(c.apiVersion);
    return parts.length ? parts.join(" · ") : null;
  }
  if (c.provider === "bedrock") return c.awsRegion ?? null;
  return c.baseUrl ?? null;
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function ModelProvidersPage() {
  usePageTitle("Model Providers");
  const { hasPermission } = useAuth();
  const canWrite = hasPermission("endpoint:write");
  const [showAddCredential, setShowAddCredential] = useState(false);
  const [rotateTarget, setRotateTarget] = useState<Credential | null>(null);
  const [deleteCredTarget, setDeleteCredTarget] = useState<Credential | null>(null);
  const [addModelTarget, setAddModelTarget] = useState<Credential | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const { data: credentials, loading, error, refetch } = useApi(
    useCallback(
      () => api.get<{ data: Credential[] }>("/api/credentials").then((r) => r.data),
      [],
    ),
  );

  if (loading) {
    return (
      <section>
        <SectionHeader title="Model Endpoints" />
        <div className="animate-pulse font-mono text-[11px] text-ink-4 py-8">Loading...</div>
      </section>
    );
  }
  if (error) {
    return (
      <section>
        <SectionHeader title="Model Endpoints" />
        <div className="text-[12.5px] text-vermillion-2 py-4">{error.message}</div>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      {successMessage && (
        <div className="border border-green/30 bg-green/5 rounded-sm p-4 flex items-center justify-between">
          <span className="text-[12.5px] text-ink">{successMessage}</span>
          <button
            onClick={() => setSuccessMessage(null)}
            className="text-[11px] text-ink-3 hover:text-ink"
          >
            dismiss
          </button>
        </div>
      )}

      <section>
        <SectionHeader
          title="Model Endpoints"
          action={
            canWrite ? { label: "Add credential", onClick: () => setShowAddCredential(true) } : undefined
          }
        />

        {(credentials ?? []).length > 0 ? (
          <div className="space-y-3">
            {(credentials ?? []).map((cred) => (
              <CredentialCard
                key={cred.id}
                cred={cred}
                canWrite={canWrite}
                onAddModel={() => setAddModelTarget(cred)}
                onRotate={() => setRotateTarget(cred)}
                onDelete={() => setDeleteCredTarget(cred)}
                onModelChanged={refetch}
              />
            ))}
          </div>
        ) : (
          <div className="border border-border rounded-sm py-6 text-center text-[12.5px] text-ink-3">
            No credentials configured. Add one to start running extractions.
          </div>
        )}
      </section>

      {showAddCredential && (
        <AddCredentialDialog
          onClose={() => setShowAddCredential(false)}
          onCreated={() => {
            setShowAddCredential(false);
            setSuccessMessage(
              "Credential added. Your API key has been encrypted and the first model is ready.",
            );
            refetch();
          }}
        />
      )}

      {addModelTarget && (
        <AddModelDialog
          credential={addModelTarget}
          onClose={() => setAddModelTarget(null)}
          onAdded={() => {
            setAddModelTarget(null);
            setSuccessMessage("Model added to the credential.");
            refetch();
          }}
        />
      )}

      {rotateTarget && (
        <RotateKeyDialog
          credential={rotateTarget}
          onClose={() => setRotateTarget(null)}
          onRotated={() => {
            setRotateTarget(null);
            setSuccessMessage("Credentials rotated successfully.");
            refetch();
          }}
        />
      )}

      {deleteCredTarget && (
        <DeleteCredentialDialog
          credential={deleteCredTarget}
          onClose={() => setDeleteCredTarget(null)}
          onDeleted={() => {
            setDeleteCredTarget(null);
            setSuccessMessage("Credential and its models deleted.");
            refetch();
          }}
        />
      )}
    </div>
  );
}

// ── Credential card ──────────────────────────────────────────────────────

function CredentialCard({
  cred,
  canWrite,
  onAddModel,
  onRotate,
  onDelete,
  onModelChanged,
}: {
  cred: Credential;
  canWrite: boolean;
  onAddModel: () => void;
  onRotate: () => void;
  onDelete: () => void;
  onModelChanged: () => void;
}) {
  const configSummary = providerConfigSummary(cred);
  return (
    <div className="border border-border rounded-sm bg-cream">
      <div className="px-4 py-3 flex items-center justify-between border-b border-border">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-[13px] font-medium text-ink truncate">{cred.displayName}</span>
          <Badge>{cred.provider}</Badge>
          {configSummary && (
            <span
              className="font-mono text-[11px] text-ink-4 truncate max-w-[300px]"
              title={configSummary}
            >
              {configSummary}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {cred.keyHint && <Meta>••••{cred.keyHint}</Meta>}
          {cred.healthState === "unhealthy" && (
            <span className="font-mono text-[10px] text-vermillion-2 bg-vermillion-3 px-1.5 py-0.5 rounded">
              unhealthy
            </span>
          )}
          <Badge variant={cred.status === "active" ? "active" : "neutral"}>{cred.status}</Badge>
          {canWrite && (
            <>
              <button
                onClick={onRotate}
                className="font-mono text-[10px] text-ink-3 hover:text-ink transition-colors"
              >
                rotate key
              </button>
              <button
                onClick={onDelete}
                className="font-mono text-[10px] text-vermillion-2 hover:text-ink transition-colors"
              >
                delete
              </button>
            </>
          )}
        </div>
      </div>

      {cred.models.length > 0 ? (
        <div className="divide-y divide-border">
          {groupModelRows(cred.models).map((g) => (
            <ModelRow
              key={g.model}
              credentialId={cred.id}
              rows={g.rows}
              canWrite={canWrite}
              onChanged={onModelChanged}
            />
          ))}
        </div>
      ) : (
        <div className="px-4 py-3 text-[12px] text-ink-4">No models yet.</div>
      )}

      {canWrite && (
        <div className="px-4 py-2 border-t border-border bg-cream-2/40">
          <button
            onClick={onAddModel}
            className="font-mono text-[11px] text-ink-3 hover:text-ink transition-colors"
          >
            + Add model
          </button>
        </div>
      )}
    </div>
  );
}

// ── Model row (one visual row per model) ──────────────────────────────────
// The API stores one tenant_models row per (model, capability) so the
// picker UIs can capability-filter — a chat+vision model arrives here as
// two rows. Collapse them: the model is the row, capabilities are badges.

function groupModelRows(
  models: TenantModel[],
): Array<{ model: string; rows: TenantModel[] }> {
  const groups = new Map<string, TenantModel[]>();
  for (const m of models) {
    const existing = groups.get(m.model);
    if (existing) existing.push(m);
    else groups.set(m.model, [m]);
  }
  const capOrder = (c: TenantModel["capability"]) =>
    CAPABILITIES.findIndex((x) => x.value === c);
  return [...groups.entries()].map(([model, rows]) => ({
    model,
    rows: rows.slice().sort((a, b) => capOrder(a.capability) - capOrder(b.capability)),
  }));
}

function ModelRow({
  credentialId,
  rows,
  canWrite,
  onChanged,
}: {
  credentialId: string;
  rows: TenantModel[];
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const first = rows[0];
  const displayName = rows.find((r) => r.displayName)?.displayName ?? null;
  // Status is stored per (model, capability) row. In practice they move
  // together; when they diverge (API-side PATCH of a single row), reflect
  // it on the capability badge instead of pretending it's uniform.
  const uniformStatus = rows.every((r) => r.status === first.status) ? first.status : null;

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      // One row per capability underneath — removing the model means
      // removing all of them.
      await Promise.all(
        rows.map((r) => api.delete(`/api/credentials/${credentialId}/models/${r.id}`)),
      );
      onChanged();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to delete model");
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  return (
    <div className="px-4 py-2.5 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <span className="font-mono text-[12px] text-ink truncate">{first.model}</span>
        {displayName && displayName !== first.model && (
          <span className="text-[11px] text-ink-4 truncate">{displayName}</span>
        )}
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        <div className="flex items-center gap-1.5">
          {rows.map((r) => {
            const hint = CAPABILITIES.find((c) => c.value === r.capability)?.hint;
            return (
              <span
                key={r.id}
                title={uniformStatus ? hint : `${hint ?? ""} (${r.status})`.trim()}
              >
                <Badge variant={uniformStatus || r.status === "active" ? "neutral" : "destructive"}>
                  {r.capability}
                </Badge>
              </span>
            );
          })}
        </div>
        {uniformStatus && (
          <Badge variant={uniformStatus === "active" ? "active" : "neutral"}>{uniformStatus}</Badge>
        )}
        {canWrite &&
          (confirmDelete ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="font-mono text-[10px] text-ink-3 hover:text-ink"
              >
                cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="font-mono text-[10px] text-vermillion-2 hover:text-ink"
              >
                {deleting ? "deleting..." : "confirm"}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="font-mono text-[10px] text-vermillion-2 hover:text-ink"
            >
              delete
            </button>
          ))}
      </div>
      {error && (
        <div className="text-[11px] text-vermillion-2 ml-2">{error}</div>
      )}
    </div>
  );
}

// ── Add credential dialog (reuses /api/model-providers which dual-writes) ──

function AddCredentialDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [providerType, setProviderType] = useState("openai");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [apiKey, setApiKey] = useState("");

  const { data: registryModels } = useApi(
    useCallback(
      () =>
        api
          .get<{ data: RegistryModel[] }>("/api/model-registry")
          .then((r) => r.data)
          .catch(() => []),
      [],
    ),
  );
  const [deploymentName, setDeploymentName] = useState("");
  const [apiVersion, setApiVersion] = useState("");
  const [awsRegion, setAwsRegion] = useState("");
  const [awsAccessKeyId, setAwsAccessKeyId] = useState("");
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState("");
  const [awsSessionToken, setAwsSessionToken] = useState("");

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerModels = (registryModels ?? []).filter((m) => m.provider === providerType);
  const fallback = (FALLBACK_SUGGESTIONS[providerType] ?? []).map((id) => ({
    provider: providerType,
    modelId: id,
    displayName: id,
    isRecommended: false,
  }));
  const availableModels = providerModels.length > 0 ? providerModels : fallback;

  function handleProviderChange(value: string) {
    setProviderType(value);
    setModel("");
    setApiKey("");
    setAwsAccessKeyId("");
    setAwsSecretAccessKey("");
    setAwsSessionToken("");
    const pt = PROVIDER_TYPES.find((p) => p.value === value);
    setBaseUrl(pt?.defaultUrl ?? "");
    if (value === "azure-openai" && !apiVersion) setApiVersion("2024-02-15-preview");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    try {
      // Prefer capabilities the registry declared for this model
      // (platform-129). Fall back to the client-side heuristic for
      // fallback-suggestion models or when the registry response is
      // missing / doesn't include the field.
      const selectedRegistryModel = availableModels.find((m) => m.modelId === model);
      const capabilities = selectedRegistryModel
        ? capsFor(selectedRegistryModel)
        : inferModelCapabilities(model);

      const payload: Record<string, unknown> = {
        name,
        slug,
        provider: providerType,
        model,
        capabilities,
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
      setError(err instanceof Error ? err.message : "Failed to create credential");
      setCreating(false);
    }
  }

  const isAzure = providerType === "azure-openai";
  const isBedrock = providerType === "bedrock";
  const isOllama = providerType === "ollama";

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      // The ModelCombobox popup portals to <body>. A *modal* Radix dialog both
      // inerts body siblings (pointer-events) AND scroll-locks them — so the
      // popup can't be clicked or scrolled. Go non-modal and render our own
      // dimmed backdrop (Radix only renders DialogOverlay in modal mode).
      modal={false}
    >
      <DialogPortal>
        <div className="fixed inset-0 z-50 bg-black/50" />
      </DialogPortal>
      <DialogContent
        className="bg-cream max-w-[480px] sm:max-w-[480px] max-h-[90vh] overflow-y-auto"
        onOpenAutoFocus={(e) => e.preventDefault()}
        // Clicks inside the portaled combobox popup must not dismiss the dialog.
        onInteractOutside={(e) => {
          const t = e.target as HTMLElement | null;
          if (t?.closest('[data-slot="combobox-content"]')) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Add credential</DialogTitle>
          <DialogDescription>
            One key, many models. The first model is added now — attach more under the credential
            card afterwards. Keys are encrypted at rest.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Display name</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. OpenAI primary"
              autoFocus
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">Provider</label>
              <select
                value={providerType}
                onChange={(e) => handleProviderChange(e.target.value)}
                className="w-full h-[30px] rounded-sm border border-input bg-white px-2 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30"
              >
                {PROVIDER_TYPES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">First model *</label>
              <ModelCombobox
                models={availableModels}
                value={model}
                onSelect={(modelId) => {
                  setModel(modelId);
                  if (!name && modelId) {
                    const picked = availableModels.find((m) => m.modelId === modelId);
                    if (picked) setName(picked.displayName.replace(/ \(.*\)$/, ""));
                  }
                }}
              />
              {model && <p className="text-[10px] text-ink-4 mt-0.5">Selected: {model}</p>}
            </div>
          </div>

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
                  isAzure
                    ? "https://{resource}.openai.azure.com"
                    : isOllama
                      ? "http://localhost:11434"
                      : "https://api.openai.com/v1"
                }
                className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
              />
            </div>
          )}

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
                <p className="text-[11px] text-ink-4">
                  Azure Portal → your resource → Deployments → this name.
                </p>
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
              </div>
            </>
          )}

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
              </div>
              <div className="space-y-1.5">
                <label className="text-[12.5px] font-medium text-ink">
                  Session token (optional)
                </label>
                <PasswordInput
                  value={awsSessionToken}
                  onChange={(e) => setAwsSessionToken(e.target.value)}
                  placeholder="Only for temporary STS credentials"
                  autoComplete="off"
                  className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 pr-8 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
                />
              </div>
            </>
          )}

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
              <p className="text-[11px] text-ink-4">
                Encrypted at rest. Cannot be retrieved — only rotated.
              </p>
            </div>
          )}

          {isOllama && (
            <p className="text-[11px] text-ink-4">Ollama runs locally, no API key required.</p>
          )}

          {error && (
            <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">
              {error}
            </div>
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
              disabled={creating}
              className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50"
            >
              {creating ? "Creating..." : "Add credential"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Add model dialog ──────────────────────────────────────────────────────

function AddModelDialog({
  credential,
  onClose,
  onAdded,
}: {
  credential: Credential;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [model, setModel] = useState("");
  const [label, setLabel] = useState("");
  const [customMode, setCustomMode] = useState(false);
  const [customCapabilities, setCustomCapabilities] = useState<ModelCapability[]>(["chat"]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: registryModels } = useApi(
    useCallback(
      () =>
        api
          .get<{ data: RegistryModel[] }>("/api/model-registry")
          .then((r) => r.data)
          .catch(() => []),
      [],
    ),
  );

  // Only show models for this credential's provider. Filter out models
  // already attached to this credential (collapsed across capabilities)
  // so the dropdown doesn't show duplicates.
  const existingModels = new Set(credential.models.map((m) => m.model));
  const providerRegistryModels = (registryModels ?? []).filter(
    (m) => m.provider === credential.provider && !existingModels.has(m.modelId),
  );
  const fallback = (FALLBACK_SUGGESTIONS[credential.provider] ?? [])
    .filter((id) => !existingModels.has(id))
    .map((id) => ({
      provider: credential.provider,
      modelId: id,
      displayName: id,
      isRecommended: false,
    }));
  const availableModels = providerRegistryModels.length > 0 ? providerRegistryModels : fallback;

  // Capabilities surfaced to the user (and submitted). In catalog mode
  // we prefer the registry-declared value for the chosen row and fall
  // back to the client-side heuristic; in custom mode the user toggles
  // them via checkboxes.
  const selectedRegistryModel = model ? availableModels.find((m) => m.modelId === model) : null;
  const derivedCaps: ModelCapability[] = selectedRegistryModel
    ? capsFor(selectedRegistryModel)
    : model
      ? inferModelCapabilities(model)
      : [];
  const submitCaps = customMode ? customCapabilities : derivedCaps;

  function toggleCustomCap(cap: ModelCapability) {
    setCustomCapabilities((curr) =>
      curr.includes(cap) ? curr.filter((c) => c !== cap) : [...curr, cap],
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (submitCaps.length === 0) {
      setError("Pick at least one capability.");
      return;
    }
    setCreating(true);
    try {
      await api.post(`/api/credentials/${credential.id}/models`, {
        model: model.trim(),
        capabilities: submitCaps,
        label: label.trim() || undefined,
      });
      onAdded();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to add model");
      setCreating(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      // The ModelCombobox popup portals to <body>. A *modal* Radix dialog both
      // inerts body siblings (pointer-events) AND scroll-locks them — so the
      // popup can't be clicked or scrolled. Go non-modal and render our own
      // dimmed backdrop (Radix only renders DialogOverlay in modal mode).
      modal={false}
    >
      <DialogPortal>
        <div className="fixed inset-0 z-50 bg-black/50" />
      </DialogPortal>
      <DialogContent
        className="bg-cream max-w-[460px] sm:max-w-[460px] max-h-[90vh] overflow-y-auto"
        onOpenAutoFocus={(e) => e.preventDefault()}
        // Clicks inside the portaled combobox popup must not dismiss the dialog.
        onInteractOutside={(e) => {
          const t = e.target as HTMLElement | null;
          if (t?.closest('[data-slot="combobox-content"]')) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Add model</DialogTitle>
          <DialogDescription>
            Attach another model to{" "}
            <strong className="text-ink">{credential.displayName}</strong>. Uses the same API key.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {!customMode ? (
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">Model *</label>
              <ModelCombobox
                models={availableModels}
                value={model}
                onSelect={setModel}
                autoFocus
              />
              {model && (
                <div className="flex items-center justify-between pt-1">
                  <p className="text-[10px] text-ink-4">
                    Selected: <span className="font-mono">{model}</span>
                  </p>
                  <div className="flex items-center gap-1">
                    {derivedCaps.map((c) => (
                      <span
                        key={c}
                        className="text-[9px] uppercase tracking-wider text-ink-3 bg-cream-2 px-1.5 py-0.5 rounded"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  setCustomMode(true);
                  setModel("");
                }}
                className="text-[11px] text-ink-3 hover:text-ink underline underline-offset-2"
              >
                Use a custom model id
              </button>
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-[12.5px] font-medium text-ink">Custom model id *</label>
                  <button
                    type="button"
                    onClick={() => {
                      setCustomMode(false);
                      setModel("");
                    }}
                    className="text-[11px] text-ink-3 hover:text-ink underline underline-offset-2"
                  >
                    Back to dropdown
                  </button>
                </div>
                <input
                  required
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={
                    credential.provider === "anthropic" ? "claude-haiku-4-5" : "gpt-4o-mini"
                  }
                  autoFocus
                  className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
                />
                <p className="text-[11px] text-ink-4">
                  For self-hosted, Ollama, or models the registry doesn&apos;t know about.
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-[12.5px] font-medium text-ink">Capabilities *</label>
                <div className="flex items-center gap-3">
                  {(["chat", "vision", "ocr"] as ModelCapability[]).map((cap) => (
                    <label
                      key={cap}
                      className="flex items-center gap-1.5 text-[12px] cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={customCapabilities.includes(cap)}
                        onChange={() => toggleCustomCap(cap)}
                      />
                      <span className="font-mono">{cap}</span>
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Label (optional)</label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Defaults to the model id"
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
              className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating || !model.trim() || submitCaps.length === 0}
              className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50"
            >
              {creating
                ? "Adding..."
                : submitCaps.length > 1
                  ? `Add model (${submitCaps.length} capabilities)`
                  : "Add model"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Rotate key + delete credential dialogs ───────────────────────────────

function RotateKeyDialog({
  credential,
  onClose,
  onRotated,
}: {
  credential: Credential;
  onClose: () => void;
  onRotated: () => void;
}) {
  const [newKey, setNewKey] = useState("");
  const [awsAccessKeyId, setAwsAccessKeyId] = useState("");
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState("");
  const [awsSessionToken, setAwsSessionToken] = useState("");

  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isBedrock = credential.provider === "bedrock";

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
      // The /api/model-providers/:id/rotate route updates both legacy
      // (model_endpoints) and the credential row via the dual-write shim.
      // The "id" here is the credential's first model id (tenant_models.id
      // == model_endpoints.id by construction). To target the credential
      // unambiguously we rotate against the first model's id.
      const firstModelId = credential.models[0]?.id;
      if (!firstModelId) {
        throw new Error("Cannot rotate: credential has no models yet.");
      }
      await api.post(`/api/model-providers/${firstModelId}/rotate`, payload);
      onRotated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to rotate key");
      setRotating(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent
        className="bg-cream max-w-[420px] sm:max-w-[420px] max-h-[90vh] overflow-y-auto"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Rotate credentials</DialogTitle>
          <DialogDescription>
            Replace credentials for{" "}
            <strong className="text-ink">{credential.displayName}</strong>. The old credentials will
            be discarded immediately.
          </DialogDescription>
        </DialogHeader>
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
                <label className="text-[12.5px] font-medium text-ink">
                  Session token (optional)
                </label>
                <PasswordInput
                  value={awsSessionToken}
                  onChange={(e) => setAwsSessionToken(e.target.value)}
                  placeholder="Only for temporary STS credentials"
                  autoComplete="off"
                  className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 pr-8 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
                />
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">New API key</label>
              <PasswordInput
                required
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder="sk-..."
                autoFocus
                autoComplete="off"
                className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 pr-8 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
              />
            </div>
          )}
          {error && (
            <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">
              {error}
            </div>
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
              disabled={rotating}
              className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50"
            >
              {rotating ? "Rotating..." : isBedrock ? "Rotate credentials" : "Rotate key"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteCredentialDialog({
  credential,
  onClose,
  onDeleted,
}: {
  credential: Credential;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    try {
      // Same id-sharing rationale as RotateKeyDialog: the first model's id
      // doubles as the legacy endpoint id, so deleting through
      // /api/model-providers cascades through the dual-write shim and
      // takes the credential + all its models with it.
      const firstModelId = credential.models[0]?.id;
      if (!firstModelId) {
        throw new Error("Cannot delete: credential has no models yet.");
      }
      await api.delete(`/api/model-providers/${firstModelId}`);
      onDeleted();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to delete");
      setDeleting(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="bg-cream max-w-[380px] sm:max-w-[380px]">
        <DialogHeader>
          <DialogTitle>Delete credential</DialogTitle>
          <DialogDescription>
            Delete <strong className="text-ink">{credential.displayName}</strong> and all{" "}
            {credential.models.length} model{credential.models.length === 1 ? "" : "s"} attached to
            it? The encrypted credentials will be permanently removed.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm mb-4">
            {error}
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-vermillion-2 text-cream hover:bg-vermillion transition-colors disabled:opacity-50"
          >
            {deleting ? "Deleting..." : "Delete"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
