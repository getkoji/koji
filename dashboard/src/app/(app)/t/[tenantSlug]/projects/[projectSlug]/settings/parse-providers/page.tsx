"use client";

import { useState, useCallback } from "react";
import {
  Dialog,
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

// ── Types ─────────────────────────────────────────────────────────────────

interface ParseEndpoint {
  id: string;
  slug: string;
  displayName: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  region: string | null;
  projectId: string | null;
  processorId: string | null;
  awsAccessKeyId: string | null;
  keyHint: string | null;
  hasKey: boolean;
  credentialStatus: "ok" | "invalid" | "none" | "no_master_key";
  status: string;
  isDefault: boolean;
  driverAvailable: boolean;
  healthState: string;
  lastHealthCheckAt: string | null;
  createdAt: string;
}

// Provider catalog. `keyLabel` adapts the secret field per vendor. The fields
// list drives which inputs the Add dialog renders. This mirrors the model
// catalog's provider matrix.
interface ProviderDef {
  value: string;
  label: string;
  blurb: string;
  defaultModel: string;
  fields: Array<"base_url" | "region" | "project_id" | "processor_id" | "aws_access_key_id">;
  keyLabel: string;
  keyKind: "api_key" | "aws_secret_access_key";
  keyPlaceholder: string;
}

const PROVIDER_TYPES: ProviderDef[] = [
  {
    value: "mistral-ocr",
    label: "Mistral OCR",
    blurb: "Markdown-native OCR. Self-serve key, cheap per page. Good SMB default.",
    defaultModel: "mistral-ocr-latest",
    fields: ["base_url"],
    keyLabel: "API key",
    keyKind: "api_key",
    keyPlaceholder: "Mistral API key",
  },
  {
    value: "azure-document-intel",
    label: "Azure Document Intelligence",
    blurb: "prebuilt-layout → markdown. Runs under your existing Azure MSA.",
    defaultModel: "prebuilt-layout",
    fields: ["base_url"],
    keyLabel: "API key",
    keyKind: "api_key",
    keyPlaceholder: "Azure resource key",
  },
  {
    value: "google-docai",
    label: "Google Document AI",
    blurb: "Document AI processor → structured chunks. Uses your GCP project.",
    defaultModel: "documentai",
    fields: ["project_id", "processor_id", "region"],
    keyLabel: "Service-account key / token",
    keyKind: "api_key",
    keyPlaceholder: "Service-account JSON or access token",
  },
  {
    value: "textract",
    label: "AWS Textract",
    blurb: "Textract → structured chunks. Runs under your existing AWS account.",
    defaultModel: "textract",
    fields: ["region", "aws_access_key_id"],
    keyLabel: "Secret access key",
    keyKind: "aws_secret_access_key",
    keyPlaceholder: "40-char secret",
  },
];

function providerLabel(provider: string): string {
  return PROVIDER_TYPES.find((p) => p.value === provider)?.label ?? provider;
}

function configSummary(e: ParseEndpoint): string | null {
  const parts: string[] = [];
  if (e.baseUrl) parts.push(e.baseUrl);
  if (e.region) parts.push(e.region);
  if (e.projectId) parts.push(e.projectId);
  if (e.processorId) parts.push(e.processorId);
  return parts.length ? parts.join(" · ") : null;
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function ParseProvidersPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission("endpoint:write");
  const [showAdd, setShowAdd] = useState(false);
  const [rotateTarget, setRotateTarget] = useState<ParseEndpoint | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ParseEndpoint | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const { data: endpoints, loading, error, refetch } = useApi(
    useCallback(
      () => api.get<{ data: ParseEndpoint[] }>("/api/parse-providers").then((r) => r.data),
      [],
    ),
  );

  if (loading) {
    return (
      <section>
        <SectionHeader title="Parse Endpoints" />
        <div className="animate-pulse font-mono text-[11px] text-ink-4 py-8">Loading...</div>
      </section>
    );
  }
  if (error) {
    return (
      <section>
        <SectionHeader title="Parse Endpoints" />
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
          title="Parse Endpoints"
          action={canWrite ? { label: "Add provider", onClick: () => setShowAdd(true) } : undefined}
        />

        <p className="text-[12.5px] text-ink-3 mb-4 max-w-[680px]">
          Bring your own OCR / parse engine. The vendor key is encrypted at rest and the parse cost
          stays on your bill — Koji never marks it up. Scanned PDFs and images route to your active
          parse endpoint; digital PDFs stay on the free in-process path. With none configured, the
          built-in default engine is used.
        </p>

        {(endpoints ?? []).length > 0 ? (
          <div className="space-y-3">
            {(endpoints ?? []).map((ep) => (
              <ParseEndpointCard
                key={ep.id}
                ep={ep}
                canWrite={canWrite}
                onChanged={refetch}
                onRotate={() => setRotateTarget(ep)}
                onDelete={() => setDeleteTarget(ep)}
                onMessage={setSuccessMessage}
              />
            ))}
          </div>
        ) : (
          <div className="border border-border rounded-sm py-6 text-center text-[12.5px] text-ink-3">
            No parse endpoints configured. Documents use the built-in default parse engine.
          </div>
        )}
      </section>

      {showAdd && (
        <AddParseProviderDialog
          onClose={() => setShowAdd(false)}
          onCreated={(name) => {
            setShowAdd(false);
            setSuccessMessage(`Parse endpoint "${name}" added. The vendor key is encrypted at rest.`);
            refetch();
          }}
        />
      )}

      {rotateTarget && (
        <RotateParseKeyDialog
          endpoint={rotateTarget}
          onClose={() => setRotateTarget(null)}
          onRotated={() => {
            setRotateTarget(null);
            setSuccessMessage("Credentials rotated.");
            refetch();
          }}
        />
      )}

      {deleteTarget && (
        <DeleteParseProviderDialog
          endpoint={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            setDeleteTarget(null);
            setSuccessMessage("Parse endpoint deleted.");
            refetch();
          }}
        />
      )}
    </div>
  );
}

// ── Endpoint card ───────────────────────────────────────────────────────────

function ParseEndpointCard({
  ep,
  canWrite,
  onChanged,
  onRotate,
  onDelete,
  onMessage,
}: {
  ep: ParseEndpoint;
  canWrite: boolean;
  onChanged: () => void;
  onRotate: () => void;
  onDelete: () => void;
  onMessage: (m: string) => void;
}) {
  const [busy, setBusy] = useState<null | "default" | "test">(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const summary = configSummary(ep);

  async function handleSetDefault() {
    setBusy("default");
    setError(null);
    try {
      await api.post(`/api/parse-providers/${ep.id}/default`);
      onMessage(`"${ep.displayName}" is now the default parse engine.`);
      onChanged();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to set default");
    } finally {
      setBusy(null);
    }
  }

  async function handleTest() {
    setBusy("test");
    setError(null);
    setTestResult(null);
    try {
      const r = await api.post<{ ok: boolean; message: string }>(
        `/api/parse-providers/${ep.id}/test`,
      );
      setTestResult(r.message);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Test failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border border-border rounded-sm bg-cream">
      <div className="px-4 py-3 flex items-center justify-between border-b border-border gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-[13px] font-medium text-ink truncate max-w-[220px]" title={ep.displayName}>
            {ep.displayName}
          </span>
          <Badge>{providerLabel(ep.provider)}</Badge>
          <span className="font-mono text-[11px] text-ink-4 truncate max-w-[140px]" title={ep.model}>
            {ep.model}
          </span>
          {summary && (
            <span className="font-mono text-[11px] text-ink-4 truncate max-w-[260px]" title={summary}>
              {summary}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {ep.keyHint && <Meta>••••{ep.keyHint}</Meta>}
          {ep.isDefault ? (
            <Badge variant="active">default</Badge>
          ) : (
            <Badge>standby</Badge>
          )}
        </div>
      </div>

      <div className="px-4 py-2.5 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          {ep.credentialStatus === "invalid" && (
            <span className="font-mono text-[10px] text-vermillion-2 bg-vermillion-3 px-1.5 py-0.5 rounded">
              key won&apos;t decrypt — rotate it
            </span>
          )}
          {ep.credentialStatus === "no_master_key" && (
            <span className="font-mono text-[10px] text-[#B6861A] bg-[#B6861A]/[0.14] px-1.5 py-0.5 rounded">
              master key not set
            </span>
          )}
          {!ep.driverAvailable && (
            <span
              className="font-mono text-[10px] text-ink-3 bg-cream-2 px-1.5 py-0.5 rounded"
              title="The runtime driver for this provider ships separately. Credentials are stored and validated; this endpoint activates automatically once the driver lands."
            >
              driver pending
            </span>
          )}
          {testResult && (
            <span className="text-[11px] text-ink-2">{testResult}</span>
          )}
          {error && <span className="text-[11px] text-vermillion-2">{error}</span>}
        </div>
        {canWrite && (
          <div className="flex items-center gap-3 flex-shrink-0">
            <button
              onClick={handleTest}
              disabled={busy !== null}
              className="font-mono text-[10px] text-ink-3 hover:text-ink transition-colors disabled:opacity-50"
            >
              {busy === "test" ? "testing..." : "test"}
            </button>
            {!ep.isDefault && (
              <button
                onClick={handleSetDefault}
                disabled={busy !== null}
                className="font-mono text-[10px] text-ink-3 hover:text-ink transition-colors disabled:opacity-50"
              >
                {busy === "default" ? "setting..." : "set as default"}
              </button>
            )}
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
          </div>
        )}
      </div>
    </div>
  );
}

// ── Add provider dialog ─────────────────────────────────────────────────────

function inputCls(): string {
  return "w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4";
}

function AddParseProviderDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const [providerType, setProviderType] = useState(PROVIDER_TYPES[0]!.value);
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [region, setRegion] = useState("");
  const [projectId, setProjectId] = useState("");
  const [processorId, setProcessorId] = useState("");
  const [awsAccessKeyId, setAwsAccessKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const def = PROVIDER_TYPES.find((p) => p.value === providerType)!;

  function handleProviderChange(value: string) {
    setProviderType(value);
    setModel("");
    setBaseUrl("");
    setRegion("");
    setProjectId("");
    setProcessorId("");
    setAwsAccessKeyId("");
    setSecret("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        provider: providerType,
        model: model.trim() || undefined,
      };
      if (def.fields.includes("base_url")) payload.base_url = baseUrl.trim() || undefined;
      if (def.fields.includes("region")) payload.region = region.trim() || undefined;
      if (def.fields.includes("project_id")) payload.project_id = projectId.trim() || undefined;
      if (def.fields.includes("processor_id")) payload.processor_id = processorId.trim() || undefined;
      if (def.fields.includes("aws_access_key_id"))
        payload.aws_access_key_id = awsAccessKeyId.trim() || undefined;
      payload[def.keyKind] = secret || undefined;

      await api.post("/api/parse-providers", payload);
      onCreated(name.trim());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to add parse endpoint");
      setCreating(false);
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
        className="bg-cream max-w-[480px] sm:max-w-[480px] max-h-[90vh] overflow-y-auto"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Add parse provider</DialogTitle>
          <DialogDescription>
            Bring your own OCR / parse engine. The key is encrypted at rest and cannot be retrieved —
            only rotated. The first endpoint you add becomes the default.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
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
            <p className="text-[11px] text-ink-4">{def.blurb}</p>
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Display name *</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`e.g. ${def.label} (prod)`}
              autoFocus
              className={inputCls()}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Model / processor</label>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={def.defaultModel}
              className={`${inputCls()} font-mono`}
            />
            <p className="text-[11px] text-ink-4">Defaults to {def.defaultModel} if left blank.</p>
          </div>

          {def.fields.includes("base_url") && (
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">
                Endpoint / base URL{providerType === "azure-document-intel" ? " *" : ""}
              </label>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                required={providerType === "azure-document-intel"}
                placeholder={
                  providerType === "azure-document-intel"
                    ? "https://{resource}.cognitiveservices.azure.com"
                    : "https://api.mistral.ai (optional)"
                }
                className={`${inputCls()} font-mono`}
              />
            </div>
          )}

          {def.fields.includes("project_id") && (
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">GCP project ID *</label>
              <input
                required
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                placeholder="my-gcp-project"
                className={`${inputCls()} font-mono`}
              />
            </div>
          )}

          {def.fields.includes("processor_id") && (
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">Processor ID *</label>
              <input
                required
                value={processorId}
                onChange={(e) => setProcessorId(e.target.value)}
                placeholder="abcdef1234567890"
                className={`${inputCls()} font-mono`}
              />
            </div>
          )}

          {def.fields.includes("region") && (
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">
                Region{providerType === "textract" ? " *" : ""}
              </label>
              <input
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                required={providerType === "textract"}
                placeholder={providerType === "textract" ? "us-east-1" : "us"}
                className={`${inputCls()} font-mono`}
              />
            </div>
          )}

          {def.fields.includes("aws_access_key_id") && (
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">Access key ID *</label>
              <input
                required
                value={awsAccessKeyId}
                onChange={(e) => setAwsAccessKeyId(e.target.value)}
                placeholder="AKIA..."
                autoComplete="off"
                className={`${inputCls()} font-mono`}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">{def.keyLabel} *</label>
            <PasswordInput
              required
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={def.keyPlaceholder}
              autoComplete="off"
              className={`${inputCls()} pr-8 font-mono`}
            />
            <p className="text-[11px] text-ink-4">Encrypted at rest. Cannot be retrieved — only rotated.</p>
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
              disabled={creating}
              className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50"
            >
              {creating ? "Adding..." : "Add provider"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Rotate + delete dialogs ─────────────────────────────────────────────────

function RotateParseKeyDialog({
  endpoint,
  onClose,
  onRotated,
}: {
  endpoint: ParseEndpoint;
  onClose: () => void;
  onRotated: () => void;
}) {
  const def = PROVIDER_TYPES.find((p) => p.value === endpoint.provider);
  const [secret, setSecret] = useState("");
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setRotating(true);
    try {
      const key = def?.keyKind ?? "api_key";
      await api.patch(`/api/parse-providers/${endpoint.id}`, { [key]: secret });
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
        className="bg-cream max-w-[420px] sm:max-w-[420px]"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Rotate credentials</DialogTitle>
          <DialogDescription>
            Replace the key for{" "}
            <strong className="text-ink">{endpoint.displayName}</strong>. The old key is discarded
            immediately.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">New {def?.keyLabel ?? "API key"}</label>
            <PasswordInput
              required
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={def?.keyPlaceholder ?? "new key"}
              autoFocus
              autoComplete="off"
              className={`${inputCls()} pr-8 font-mono`}
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
              disabled={rotating}
              className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50"
            >
              {rotating ? "Rotating..." : "Rotate key"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteParseProviderDialog({
  endpoint,
  onClose,
  onDeleted,
}: {
  endpoint: ParseEndpoint;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      await api.delete(`/api/parse-providers/${endpoint.id}`);
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
          <DialogTitle>Delete parse endpoint</DialogTitle>
          <DialogDescription>
            Delete <strong className="text-ink">{endpoint.displayName}</strong>? The encrypted key is
            permanently removed. Pipelines pinned to it fall back to the tenant default parse engine.
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
