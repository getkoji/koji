"use client";

import { useState, useCallback } from "react";
import { SectionHeader, SettingsTable, SettingsRow, Badge, Meta } from "@/components/shared/SettingsComponents";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { useAuth } from "@/lib/auth-context";

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  createdBy: string;
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

export default function ApiKeysPage() {
  const { hasPermission } = useAuth();
  const [showCreate, setShowCreate] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [confirmRevoke, setConfirmRevoke] = useState<ApiKey | null>(null);
  const [revoking, setRevoking] = useState(false);

  const { data: keys, loading, error: fetchError, refetch } = useApi(
    useCallback(() => api.get<{ data: ApiKey[] }>("/api/api-keys").then((r) => r.data), []),
  );

  const activeKeys = (keys ?? []).filter((k) => !k.revokedAt);
  const revokedKeys = (keys ?? []).filter((k) => k.revokedAt);

  async function handleRevoke() {
    if (!confirmRevoke) return;
    setRevoking(true);
    try {
      await api.delete(`/api/api-keys/${confirmRevoke.id}`);
      setConfirmRevoke(null);
      refetch();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to revoke key");
    } finally {
      setRevoking(false);
    }
  }

  function handleCopyKey() {
    if (createdKey) {
      navigator.clipboard.writeText(createdKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  if (loading) {
    return (
      <section>
        <SectionHeader title="API Keys" />
        <div className="animate-pulse font-mono text-[11px] text-ink-4 py-8">Loading...</div>
      </section>
    );
  }

  return (
    <div className="space-y-8">
      {/* Created key banner — shown once after creation */}
      {createdKey && (
        <div className="border border-green/30 bg-green/5 rounded-sm p-4">
          <div className="text-[12.5px] text-ink font-medium mb-1">API key created</div>
          <p className="text-[12px] text-ink-3 mb-3">
            Copy this key now — you won't be able to see it again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-[11px] text-ink bg-cream border border-border rounded-sm px-3 py-2 select-all break-all">
              {createdKey}
            </code>
            <button
              onClick={handleCopyKey}
              className="inline-flex items-center px-3 py-2 rounded-sm text-[12px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors shrink-0"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button
            onClick={() => setCreatedKey(null)}
            className="mt-3 text-[11px] text-ink-3 hover:text-ink transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Active keys */}
      <section>
        <SectionHeader
          title="API Keys"
          action={hasPermission("api_key:write") ? { label: "Create key", onClick: () => setShowCreate(true) } : undefined}
        />

        {activeKeys.length > 0 ? (
          <SettingsTable>
            {activeKeys.map((k) => (
              <SettingsRow key={k.id}>
                <div className="flex items-center gap-4">
                  <span className="text-[12.5px] text-ink font-medium">{k.name}</span>
                  <span className="font-mono text-[11px] text-ink-3">{k.keyPrefix}</span>
                </div>
                <div className="flex items-center gap-4">
                  <Meta>created {timeAgo(k.createdAt)}</Meta>
                  <Meta>used {timeAgo(k.lastUsedAt)}</Meta>
                  {hasPermission("api_key:write") && (
                    <button
                      onClick={() => setConfirmRevoke(k)}
                      className="font-mono text-[10px] text-vermillion-2 hover:text-ink transition-colors"
                    >
                      revoke
                    </button>
                  )}
                </div>
              </SettingsRow>
            ))}
          </SettingsTable>
        ) : (
          <div className="border border-border rounded-sm py-6 text-center text-[12.5px] text-ink-3">
            No API keys yet. Create one to get started.
          </div>
        )}
      </section>

      {/* Revoked keys */}
      {revokedKeys.length > 0 && (
        <section>
          <SectionHeader title="Revoked keys" />
          <SettingsTable>
            {revokedKeys.map((k) => (
              <SettingsRow key={k.id}>
                <div className="flex items-center gap-4 opacity-50">
                  <span className="text-[12.5px] text-ink font-medium line-through">{k.name}</span>
                  <span className="font-mono text-[11px] text-ink-3">{k.keyPrefix}</span>
                </div>
                <div className="flex items-center gap-4 opacity-50">
                  <Meta>revoked {timeAgo(k.revokedAt)}</Meta>
                </div>
              </SettingsRow>
            ))}
          </SettingsTable>
        </section>
      )}

      {/* Create key dialog */}
      {showCreate && (
        <CreateKeyDialog
          onClose={() => setShowCreate(false)}
          onCreated={(key) => {
            setShowCreate(false);
            setCreatedKey(key);
            refetch();
          }}
        />
      )}

      {/* Revoke confirmation dialog */}
      {confirmRevoke && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
          <div className="absolute inset-0 bg-ink/20" onClick={() => setConfirmRevoke(null)} />
          <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[380px] p-6">
            <h2 className="text-[15px] font-medium text-ink mb-1">Revoke API key</h2>
            <p className="text-[12.5px] text-ink-3 mb-5">
              Revoke <strong className="text-ink">{confirmRevoke.name}</strong>? Any applications using this key will immediately lose access.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setConfirmRevoke(null)}
                className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleRevoke}
                disabled={revoking}
                className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-vermillion-2 text-cream hover:bg-vermillion transition-colors disabled:opacity-50"
              >
                {revoking ? "Revoking..." : "Revoke key"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CreateKeyDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (key: string) => void;
}) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const result = await api.post<{ key: string }>("/api/api-keys", { name });
      onCreated(result.key);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create key");
      setCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[420px] p-6">
        <h2 className="text-[15px] font-medium text-ink mb-1">Create API key</h2>
        <p className="text-[12.5px] text-ink-3 mb-5">
          Give this key a name so you can identify it later.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Key name</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Production, CI/CD, Staging"
              autoFocus
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
              disabled={creating}
              className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50"
            >
              {creating ? "Creating..." : "Create key"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
