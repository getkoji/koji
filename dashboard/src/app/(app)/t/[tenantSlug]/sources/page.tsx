"use client";

import { useState, useCallback } from "react";
import { ListLayout, Breadcrumbs, PageHeader } from "@/components/layouts";
import { Badge, Meta } from "@/components/shared/SettingsComponents";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { useAuth } from "@/lib/auth-context";

interface Source {
  id: string;
  slug: string;
  displayName: string;
  sourceType: string;
  status: string;
  lastIngestedAt: string | null;
  createdAt: string;
}

interface Ingestion {
  id: string;
  filename: string | null;
  fileSize: number | null;
  status: string;
  jobId: string | null;
  docId: string | null;
  failureReason: string | null;
  receivedAt: string;
  completedAt: string | null;
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

const SOURCE_TYPE_LABELS: Record<string, string> = {
  dashboard_upload: "Upload",
  webhook: "Webhook",
  s3: "S3",
  sftp: "SFTP",
  gcs: "GCS",
  azure_blob: "Azure Blob",
  email: "Email",
};

export default function SourcesPage() {
  const { hasPermission } = useAuth();
  const [showAdd, setShowAdd] = useState(false);
  const [viewSource, setViewSource] = useState<Source | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Source | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<{ secret: string; sourceId: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("All");

  const { data: sources, loading, refetch } = useApi(
    useCallback(() => api.get<{ data: Source[] }>("/api/sources").then((r) => r.data), []),
  );

  const filtered = (sources ?? []).filter(
    (s) => statusFilter === "All" || s.status === statusFilter.toLowerCase(),
  );

  async function handlePauseResume(source: Source) {
    const action = source.status === "paused" ? "resume" : "pause";
    await api.post(`/api/sources/${source.id}/${action}`, {});
    refetch();
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.delete(`/api/sources/${deleteTarget.id}`);
      setDeleteTarget(null);
      refetch();
    } catch { setDeleting(false); }
  }

  return (
    <ListLayout
      header={
        <>
          <Breadcrumbs items={[{ label: "Sources" }]} />
          <PageHeader
            title="Sources"
            meta={<span>{(sources ?? []).length} configured</span>}
            actions={
              hasPermission("source:write") ? (
                <button
                  onClick={() => setShowAdd(true)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors"
                >
                  Add source
                </button>
              ) : undefined
            }
          />
        </>
      }
      filterBar={
        <div className="flex items-center gap-2">
          {["All", "Active", "Paused"].map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`font-mono text-[10px] px-2.5 py-1 rounded-sm transition-colors ${
                statusFilter === s ? "bg-ink text-cream" : "text-ink-3 hover:bg-cream-2 hover:text-ink"
              }`}
            >
              {s}
            </button>
          ))}
          <span className="flex-1" />
          <span className="font-mono text-[10px] text-ink-4">{filtered.length} source{filtered.length !== 1 ? "s" : ""}</span>
        </div>
      }
    >
      {/* Created secret banner */}
      {createdSecret && (
        <div className="border border-green/30 bg-green/5 rounded-sm p-4 mx-4 mt-4">
          <div className="text-[12.5px] text-ink font-medium mb-1">Webhook signing secret</div>
          <p className="text-[12px] text-ink-3 mb-3">Copy this secret now — it won't be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-[11px] text-ink bg-cream border border-border rounded-sm px-3 py-2 select-all break-all">{createdSecret.secret}</code>
            <button onClick={() => { navigator.clipboard.writeText(createdSecret.secret); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
              className="inline-flex items-center px-3 py-2 rounded-sm text-[12px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors shrink-0">
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button onClick={() => setCreatedSecret(null)} className="mt-3 text-[11px] text-ink-3 hover:text-ink transition-colors">Dismiss</button>
        </div>
      )}

      {loading ? (
        <div className="animate-pulse font-mono text-[11px] text-ink-4 py-8 text-center">Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-[13px] text-ink-3">
          {statusFilter !== "All" ? "No sources match this filter." : "No sources configured yet."}
        </div>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              {["Name", "Type", "Status", "Last ingestion", ""].map((h) => (
                <th key={h} className="text-left px-4 py-2 font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-ink-4">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr key={s.id} className="border-b border-dotted border-border hover:bg-cream-2/50 transition-colors">
                <td className="px-4 py-2.5">
                  <button onClick={() => setViewSource(s)} className="text-[12.5px] text-ink font-medium hover:text-vermillion-2 transition-colors text-left">
                    {s.displayName}
                  </button>
                </td>
                <td className="px-4 py-2.5">
                  <Badge>{SOURCE_TYPE_LABELS[s.sourceType] ?? s.sourceType}</Badge>
                </td>
                <td className="px-4 py-2.5">
                  <Badge variant={s.status === "active" ? "active" : "neutral"}>{s.status}</Badge>
                </td>
                <td className="px-4 py-2.5">
                  <Meta>{timeAgo(s.lastIngestedAt)}</Meta>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-3">
                    <button onClick={() => setViewSource(s)} className="font-mono text-[10px] text-ink-3 hover:text-ink transition-colors">details</button>
                    {hasPermission("source:write") && (
                      <>
                        <button onClick={() => handlePauseResume(s)} className="font-mono text-[10px] text-ink-3 hover:text-ink transition-colors">
                          {s.status === "paused" ? "resume" : "pause"}
                        </button>
                        {s.sourceType !== "dashboard_upload" && (
                          <button onClick={() => setDeleteTarget(s)} className="font-mono text-[10px] text-vermillion-2 hover:text-ink transition-colors">delete</button>
                        )}
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Add source dialog */}
      {showAdd && (
        <AddSourceDialog
          onClose={() => setShowAdd(false)}
          onCreated={(result) => {
            setShowAdd(false);
            if (result.webhookSecret) {
              setCreatedSecret({ secret: result.webhookSecret, sourceId: result.id });
            }
            refetch();
          }}
        />
      )}

      {/* Source detail dialog */}
      {viewSource && (
        <SourceDetailDialog source={viewSource} onClose={() => setViewSource(null)} />
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
          <div className="absolute inset-0 bg-ink/20" onClick={() => setDeleteTarget(null)} />
          <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[380px] p-6">
            <h2 className="text-[15px] font-medium text-ink mb-1">Delete source</h2>
            <p className="text-[12.5px] text-ink-3 mb-5">
              Delete <strong className="text-ink">{deleteTarget.displayName}</strong>? Ingestion history will be preserved.
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
    </ListLayout>
  );
}

const SOURCE_TYPES = [
  { value: "webhook", label: "Webhook", description: "External systems POST documents to a unique URL", available: true },
  { value: "s3", label: "S3 Bucket", description: "Poll an Amazon S3 bucket for new documents", available: false },
  { value: "sftp", label: "SFTP", description: "Poll an SFTP server for new files", available: false },
  { value: "gcs", label: "Google Cloud Storage", description: "Poll a GCS bucket for new documents", available: false },
  { value: "azure_blob", label: "Azure Blob Storage", description: "Poll an Azure Blob container", available: false },
  { value: "email", label: "Email (IMAP)", description: "Monitor a mailbox for document attachments", available: false },
];

function AddSourceDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (result: { id: string; webhookSecret?: string }) => void }) {
  const [sourceType, setSourceType] = useState("webhook");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    try {
      const result = await api.post<{ id: string; webhookSecret?: string }>("/api/sources", {
        name, slug, source_type: sourceType,
      });
      onCreated(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create source");
      setCreating(false);
    }
  }

  const selectedType = SOURCE_TYPES.find((t) => t.value === sourceType);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[480px] p-6">
        <h2 className="text-[15px] font-medium text-ink mb-1">Add source</h2>
        <p className="text-[12.5px] text-ink-3 mb-5">
          Configure how documents enter the pipeline.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Source type picker */}
          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Source type</label>
            <div className="grid grid-cols-2 gap-2">
              {SOURCE_TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  disabled={!t.available}
                  onClick={() => t.available && setSourceType(t.value)}
                  className={`text-left px-3 py-2.5 rounded-sm border transition-colors ${
                    sourceType === t.value
                      ? "border-ink bg-ink/[0.03]"
                      : t.available
                        ? "border-border hover:border-ink/30"
                        : "border-border opacity-40 cursor-not-allowed"
                  }`}
                >
                  <div className="text-[12.5px] font-medium text-ink flex items-center gap-1.5">
                    {t.label}
                    {!t.available && <span className="font-mono text-[9px] text-ink-4 bg-cream-2 px-1.5 py-0.5 rounded-sm uppercase">soon</span>}
                  </div>
                  <div className="text-[11px] text-ink-3 mt-0.5">{t.description}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Name</label>
            <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Partner API inbound" autoFocus
              data-1p-ignore autoComplete="off"
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4" />
          </div>

          {error && <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">{error}</div>}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors">Cancel</button>
            <button type="submit" disabled={creating}
              className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50">
              {creating ? "Creating..." : "Create source"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SourceDetailDialog({ source, onClose }: { source: Source; onClose: () => void }) {
  const { data: ingestions, loading } = useApi(
    useCallback(
      () => api.get<{ data: Ingestion[] }>(`/api/sources/${source.id}/ingestions`).then((r) => r.data),
      [source.id],
    ),
  );

  const webhookUrl = typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.host.replace(":3002", ":9401")}/api/sources/${source.id}/webhook`
    : "";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[640px] p-6 max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-[15px] font-medium text-ink">{source.displayName}</h2>
          <button onClick={onClose} className="text-ink-4 hover:text-ink transition-colors text-[18px] leading-none">&times;</button>
        </div>
        <div className="flex items-center gap-2 mb-5">
          <Badge>{SOURCE_TYPE_LABELS[source.sourceType] ?? source.sourceType}</Badge>
          <Badge variant={source.status === "active" ? "active" : "neutral"}>{source.status}</Badge>
        </div>

        {/* Webhook URL for webhook sources */}
        {source.sourceType === "webhook" && (
          <div className="border border-border rounded-sm p-3 mb-5">
            <div className="font-mono text-[10px] font-medium tracking-[0.08em] uppercase text-ink-4 mb-1.5">Webhook URL</div>
            <code className="font-mono text-[11px] text-ink break-all select-all">{webhookUrl}</code>
          </div>
        )}

        {source.sourceType === "dashboard_upload" && (
          <div className="border border-border rounded-sm p-3 mb-5 text-[12.5px] text-ink-3">
            Documents uploaded via the dashboard or API are tracked through this source.
          </div>
        )}

        {/* Recent ingestions */}
        <div className="font-mono text-[10px] font-medium tracking-[0.08em] uppercase text-ink-4 mb-2">
          Recent ingestions
        </div>

        {loading ? (
          <div className="animate-pulse font-mono text-[11px] text-ink-4 py-4 text-center">Loading...</div>
        ) : (ingestions ?? []).length === 0 ? (
          <div className="border border-border rounded-sm py-4 text-center text-[12.5px] text-ink-3">
            No ingestions yet.
          </div>
        ) : (
          <div className="border border-border rounded-sm divide-y divide-dotted divide-border">
            <div className="grid grid-cols-[1fr_80px_100px] gap-3 px-4 py-2 text-[10px] font-mono font-medium tracking-[0.08em] uppercase text-ink-4">
              <span>File</span>
              <span>Status</span>
              <span>Received</span>
            </div>
            {(ingestions ?? []).map((i) => (
              <div key={i.id} className="grid grid-cols-[1fr_80px_100px] gap-3 px-4 py-2.5 items-center">
                <span className="text-[12px] text-ink truncate">{i.filename ?? "unknown"}</span>
                <span>
                  <span className={`font-mono text-[10px] font-medium px-1.5 py-0.5 rounded-sm ${
                    i.status === "complete" || i.status === "received" ? "bg-green/10 text-green" :
                    i.status === "failed" ? "bg-vermillion-3/50 text-vermillion-2" :
                    "bg-cream-2 text-ink-3"
                  }`}>
                    {i.status}
                  </span>
                </span>
                <span className="font-mono text-[10px] text-ink-4">{timeAgo(i.receivedAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
