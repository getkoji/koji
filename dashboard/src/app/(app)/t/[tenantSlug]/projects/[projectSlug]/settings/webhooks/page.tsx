"use client";

import { useState, useCallback } from "react";
import { SectionHeader, SettingsTable, SettingsRow, Badge, Meta } from "@/components/shared/SettingsComponents";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { useAuth } from "@/lib/auth-context";

interface WebhookTarget {
  id: string;
  slug: string;
  displayName: string;
  url: string;
  subscribedEvents: string[];
  status: string;
  lastDeliveredAt: string | null;
  lastError: string | null;
  createdAt: string;
}

const EVENT_OPTIONS = [
  { value: "job.succeeded", label: "Job succeeded" },
  { value: "job.failed", label: "Job failed" },
  { value: "document.delivered", label: "Document delivered" },
  { value: "document.failed", label: "Document failed" },
  { value: "schema.deployed", label: "Schema deployed" },
  { value: "*", label: "All events" },
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

export default function WebhooksPage() {
  const { hasPermission } = useAuth();
  const [showAdd, setShowAdd] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WebhookTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: targets, loading, error, refetch } = useApi(
    useCallback(() => api.get<{ data: WebhookTarget[] }>("/api/webhook-targets").then((r) => r.data), []),
  );

  async function handleTest(target: WebhookTarget) {
    setTestingId(target.id);
    setTestResult(null);
    try {
      const result = await api.post<{ ok: boolean; status: number; latencyMs: number; error?: string }>(
        `/api/webhook-targets/${target.id}/test`, {},
      );
      setTestResult(
        result.ok
          ? `OK (${result.status}) in ${result.latencyMs}ms`
          : `Failed: ${result.error ?? `HTTP ${result.status}`} (${result.latencyMs}ms)`,
      );
    } catch (err: unknown) {
      setTestResult(err instanceof Error ? err.message : "Test failed");
    } finally {
      setTestingId(null);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.delete(`/api/webhook-targets/${deleteTarget.id}`);
      setDeleteTarget(null);
      refetch();
    } catch { setDeleting(false); }
  }

  if (loading) {
    return (
      <section>
        <SectionHeader title="Webhooks" />
        <div className="animate-pulse font-mono text-[11px] text-ink-4 py-8">Loading...</div>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      {/* Created secret banner */}
      {createdSecret && (
        <div className="border border-green/30 bg-green/5 rounded-sm p-4">
          <div className="text-[12.5px] text-ink font-medium mb-1">Webhook signing secret</div>
          <p className="text-[12px] text-ink-3 mb-3">Copy this secret now — it won't be shown again. Use it to verify webhook signatures.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-[11px] text-ink bg-cream border border-border rounded-sm px-3 py-2 select-all break-all">{createdSecret}</code>
            <button onClick={() => { navigator.clipboard.writeText(createdSecret); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
              className="inline-flex items-center px-3 py-2 rounded-sm text-[12px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors shrink-0">
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button onClick={() => setCreatedSecret(null)} className="mt-3 text-[11px] text-ink-3 hover:text-ink transition-colors">Dismiss</button>
        </div>
      )}

      {/* Test result banner */}
      {testResult && (
        <div className={`border rounded-sm p-3 flex items-center justify-between ${testResult.startsWith("OK") ? "border-green/30 bg-green/5" : "border-vermillion-2/30 bg-vermillion-3/30"}`}>
          <span className="text-[12px] text-ink font-mono">{testResult}</span>
          <button onClick={() => setTestResult(null)} className="text-[11px] text-ink-3 hover:text-ink">dismiss</button>
        </div>
      )}

      <section>
        <SectionHeader
          title="Webhooks"
          action={hasPermission("webhook:write") ? { label: "Add webhook", onClick: () => setShowAdd(true) } : undefined}
        />

        {(targets ?? []).length > 0 ? (
          <SettingsTable>
            {(targets ?? []).map((t) => (
              <SettingsRow key={t.id}>
                <div className="flex items-center gap-4">
                  <span className="text-[12.5px] text-ink font-medium">{t.displayName}</span>
                  <span className="font-mono text-[11px] text-ink-3 truncate max-w-[300px]">{t.url}</span>
                  <div className="flex items-center gap-1">
                    {t.subscribedEvents.map((e) => (
                      <span key={e} className="font-mono text-[9px] text-ink-4 bg-cream-2 px-1.5 py-0.5 rounded-sm">{e}</span>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <Meta>last: {timeAgo(t.lastDeliveredAt)}</Meta>
                  <Badge variant={t.status === "active" ? "active" : "neutral"}>{t.status}</Badge>
                  {hasPermission("webhook:write") && (
                    <>
                      <button onClick={() => handleTest(t)} disabled={testingId === t.id}
                        className="font-mono text-[10px] text-ink-3 hover:text-ink transition-colors">
                        {testingId === t.id ? "testing..." : "test"}
                      </button>
                      <button onClick={() => setDeleteTarget(t)}
                        className="font-mono text-[10px] text-vermillion-2 hover:text-ink transition-colors">
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
            No webhooks configured. Add one to receive event notifications.
          </div>
        )}
      </section>

      {showAdd && (
        <AddWebhookDialog
          onClose={() => setShowAdd(false)}
          onCreated={(secret) => { setShowAdd(false); setCreatedSecret(secret); refetch(); }}
        />
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-ink/20" onClick={() => setDeleteTarget(null)} />
          <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[380px] p-6">
            <h2 className="text-[15px] font-medium text-ink mb-1">Delete webhook</h2>
            <p className="text-[12.5px] text-ink-3 mb-5">
              Delete <strong className="text-ink">{deleteTarget.displayName}</strong>? Pending deliveries will be cancelled.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors">Cancel</button>
              <button onClick={handleDelete} disabled={deleting} className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-vermillion-2 text-cream hover:bg-vermillion transition-colors disabled:opacity-50">
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AddWebhookDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (secret: string) => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleEvent(value: string) {
    setEvents((prev) => {
      const next = new Set(prev);
      if (value === "*") {
        return next.has("*") ? new Set() : new Set(["*"]);
      }
      next.delete("*");
      if (next.has(value)) next.delete(value); else next.add(value);
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    try {
      const result = await api.post<{ secret: string }>("/api/webhook-targets", {
        name, slug, url, event_filters: [...events],
      });
      onCreated(result.secret);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create webhook");
      setCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[480px] p-6">
        <h2 className="text-[15px] font-medium text-ink mb-1">Add webhook</h2>
        <p className="text-[12.5px] text-ink-3 mb-5">
          Configure an endpoint to receive event notifications. A signing secret will be generated automatically.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Name</label>
            <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Slack notifications" autoFocus
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4" />
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">URL</label>
            <input required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..."
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4" />
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Events</label>
            <div className="grid grid-cols-2 gap-2">
              {EVENT_OPTIONS.map((opt) => (
                <label key={opt.value} className="flex items-center gap-2 text-[12.5px] text-ink-3 cursor-pointer">
                  <input type="checkbox" checked={events.has(opt.value)} onChange={() => toggleEvent(opt.value)} className="rounded border-border" />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>

          {error && <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">{error}</div>}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors">Cancel</button>
            <button type="submit" disabled={creating || events.size === 0}
              className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50">
              {creating ? "Creating..." : "Create webhook"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
