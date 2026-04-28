"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  Pause,
  Play,
  Trash2,
  Upload,
  X,
  ChevronRight,
  RotateCcw,
  Plus,
  Unlink,
  AlertTriangle,
  Send,
} from "lucide-react";
import { ListLayout, Breadcrumbs, PageHeader } from "@/components/layouts";
import { EmptyState } from "@/components/shared/EmptyState";
import {
  pipelines as pipelinesApi,
  sources as sourcesApi,
  DEFAULT_RETRY_POLICY,
  type PipelineDetail,
  type PipelineRecentJob,
  type RetryPolicy,
  type SchemaVersion,
} from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { useAuth } from "@/lib/auth-context";
import { statusTone, statusLabel, formatRelativeTime, formatAbsoluteTime } from "../format";

export default function PipelineDetailPage() {
  const params = useParams<{ tenantSlug: string; pipelineSlug: string }>();
  const router = useRouter();
  const tenantSlug = params?.tenantSlug ?? "";
  const pipelineSlug = params?.pipelineSlug ?? "";
  const { hasPermission } = useAuth();

  const [deployOpen, setDeployOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const {
    data: pipeline,
    loading,
    error,
    refetch,
  } = useApi(useCallback(() => pipelinesApi.get(pipelineSlug), [pipelineSlug]));

  const canWrite = hasPermission("pipeline:write");
  const canDeploy = hasPermission("schema:deploy");

  async function togglePause() {
    if (!pipeline || submitting) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      if (pipeline.status === "paused") {
        await pipelinesApi.resume(pipeline.slug);
      } else {
        await pipelinesApi.pause(pipeline.slug);
      }
      await refetch();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Action failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!pipeline) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await pipelinesApi.delete(pipeline.slug);
      router.push(`/t/${tenantSlug}/pipelines`);
    } catch (err) {
      setSubmitting(false);
      setErrorMsg(err instanceof Error ? err.message : "Delete failed");
    }
  }

  async function handleDeploy(schemaVersionId: string) {
    if (!pipeline) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await pipelinesApi.deploy(pipeline.slug, schemaVersionId);
      setDeployOpen(false);
      await refetch();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Deploy failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (error) {
    return (
      <Shell tenantSlug={tenantSlug} pipelineSlug={pipelineSlug}>
        <EmptyState
          title={error.message.includes("not found") ? "Pipeline not found" : "Cannot reach API"}
          description={error.message}
          action={
            <Link
              href={`/t/${tenantSlug}/pipelines`}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-cream text-ink border border-border-strong hover:border-ink transition-colors"
            >
              Back to pipelines
            </Link>
          }
        />
      </Shell>
    );
  }

  if (!pipeline || loading) {
    return (
      <Shell tenantSlug={tenantSlug} pipelineSlug={pipelineSlug}>
        <div className="animate-pulse font-mono text-[11px] text-ink-4 py-8 text-center">
          Loading…
        </div>
      </Shell>
    );
  }

  const undeployed = pipeline.deployedVersion === null;

  return (
    <ListLayout
      header={
        <>
          <Breadcrumbs
            items={[
              { label: tenantSlug, href: `/t/${tenantSlug}` },
              { label: "Pipelines", href: `/t/${tenantSlug}/pipelines` },
              { label: pipeline.displayName },
            ]}
          />
          <PageHeader
            title={pipeline.displayName}
            badge={<LargeStatusBadge status={pipeline.status} undeployed={undeployed} />}
            meta={
              <>
                <MetaItem label="Slug">
                  <code className="font-mono text-ink-2">{pipeline.slug}</code>
                </MetaItem>
                <Dot />
                <MetaItem label="Trigger">{pipeline.triggerType}</MetaItem>
                {pipeline.creatorName || pipeline.creatorEmail ? (
                  <>
                    <Dot />
                    <MetaItem label="Created by">
                      {pipeline.creatorName ?? pipeline.creatorEmail}
                    </MetaItem>
                  </>
                ) : null}
                <Dot />
                <MetaItem label="Last run">{formatRelativeTime(pipeline.lastRunAt)}</MetaItem>
              </>
            }
            actions={
              canWrite ? (
                <>
                  <button
                    onClick={togglePause}
                    disabled={submitting}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-cream text-ink border border-border-strong hover:border-ink transition-colors disabled:opacity-40"
                  >
                    {pipeline.status === "paused" ? (
                      <>
                        <Play className="w-3.5 h-3.5" />
                        Resume
                      </>
                    ) : (
                      <>
                        <Pause className="w-3.5 h-3.5" />
                        Pause
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => setRunOpen(true)}
                    disabled={submitting || undeployed}
                    title={
                      undeployed
                        ? "Deploy a schema version before running"
                        : "Upload a document and run it through this pipeline"
                    }
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-vermillion-2 text-cream hover:bg-ink transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Send className="w-3.5 h-3.5" />
                    Run pipeline
                  </button>
                </>
              ) : undefined
            }
          />
        </>
      }
    >
      {errorMsg && (
        <div className="mb-4 font-mono text-[11.5px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">
          {errorMsg}
        </div>
      )}

      <div className="flex flex-col gap-5">
        <DeploymentSection
          pipeline={pipeline}
          tenantSlug={tenantSlug}
          canDeploy={canDeploy}
          onOpenDeploy={() => setDeployOpen(true)}
        />
        <ConfigurationSection pipeline={pipeline} tenantSlug={tenantSlug} />
        <RetryPolicySection pipeline={pipeline} canWrite={canWrite} onSaved={refetch} />
        <ConnectedSourcesSection
          pipeline={pipeline}
          tenantSlug={tenantSlug}
          canWrite={canWrite}
          onChanged={refetch}
        />
        <RecentJobsSection jobs={pipeline.recentJobs} tenantSlug={tenantSlug} />
        {canWrite && (
          <DangerZone
            pipeline={pipeline}
            onDelete={() => setDeleteOpen(true)}
          />
        )}
      </div>

      {deployOpen && canDeploy && pipeline.schemaSlug && (
        <DeployDialog
          pipeline={pipeline}
          onClose={() => setDeployOpen(false)}
          onDeploy={handleDeploy}
          submitting={submitting}
        />
      )}
      {deleteOpen && (
        <DeleteDialog
          pipeline={pipeline}
          submitting={submitting}
          onClose={() => setDeleteOpen(false)}
          onConfirm={handleDelete}
        />
      )}
      {runOpen && !undeployed && (
        <RunDialog
          pipeline={pipeline}
          tenantSlug={tenantSlug}
          onClose={() => setRunOpen(false)}
          onStarted={(jobSlug) => router.push(`/t/${tenantSlug}/jobs/${jobSlug}`)}
        />
      )}
    </ListLayout>
  );
}

function Shell({
  tenantSlug,
  pipelineSlug,
  children,
}: {
  tenantSlug: string;
  pipelineSlug: string;
  children: React.ReactNode;
}) {
  return (
    <ListLayout
      header={
        <>
          <Breadcrumbs
            items={[
              { label: tenantSlug, href: `/t/${tenantSlug}` },
              { label: "Pipelines", href: `/t/${tenantSlug}/pipelines` },
              { label: pipelineSlug },
            ]}
          />
        </>
      }
    >
      {children}
    </ListLayout>
  );
}

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span>
      <span className="uppercase tracking-[0.08em] text-[9.5px] text-ink-4 mr-1">{label}</span>
      {children}
    </span>
  );
}

function Dot() {
  return <span className="text-cream-4 text-[8px]">●</span>;
}

function LargeStatusBadge({
  status,
  undeployed,
}: {
  status: string;
  undeployed: boolean;
}) {
  if (undeployed && status === "active") {
    return (
      <span className="inline-flex items-center font-mono text-[11px] font-medium px-3 py-1 rounded-sm uppercase tracking-[0.1em] bg-[#B6861A]/[0.14] text-[#B6861A]">
        not deployed
      </span>
    );
  }
  const tone = statusTone(status);
  const styles =
    tone === "success"
      ? "bg-green/[0.12] text-green"
      : tone === "warn"
      ? "bg-[#B6861A]/[0.14] text-[#B6861A]"
      : tone === "fail"
      ? "bg-vermillion-3 text-vermillion-2"
      : "bg-cream-2 text-ink-3";
  return (
    <span
      className={`inline-flex items-center font-mono text-[11px] font-medium px-3 py-1 rounded-sm uppercase tracking-[0.1em] ${styles}`}
    >
      {statusLabel(status)}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Deployment section

function DeploymentSection({
  pipeline,
  tenantSlug,
  canDeploy,
  onOpenDeploy,
}: {
  pipeline: PipelineDetail;
  tenantSlug: string;
  canDeploy: boolean;
  onOpenDeploy: () => void;
}) {
  const deployed = pipeline.deployedVersion;
  return (
    <Section
      title="Deployment"
      action={
        canDeploy && pipeline.schemaSlug ? (
          <button
            onClick={onOpenDeploy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-[11.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors"
          >
            <Upload className="w-3 h-3" />
            Deploy version
          </button>
        ) : null
      }
    >
      {deployed ? (
        <div className="flex items-start justify-between gap-4 p-4">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="font-display text-[18px] font-medium text-ink">
                {pipeline.schemaName ?? pipeline.schemaSlug ?? "unknown"}
              </span>
              <code className="font-mono text-[12px] text-ink-2 bg-cream-2 px-2 py-0.5 rounded-sm">
                v{deployed.number}
              </code>
            </div>
            {deployed.commitMessage && (
              <p className="text-[12.5px] text-ink-3">{deployed.commitMessage}</p>
            )}
            <span className="font-mono text-[10px] text-ink-4">
              deployed {formatAbsoluteTime(deployed.deployedAt)}
            </span>
          </div>
          {pipeline.schemaSlug && (
            <Link
              href={`/t/${tenantSlug}/schemas/${pipeline.schemaSlug}/build`}
              className="font-mono text-[11px] text-ink-3 hover:text-vermillion-2 transition-colors inline-flex items-center gap-0.5 shrink-0"
            >
              view schema <ChevronRight className="w-3 h-3" />
            </Link>
          )}
        </div>
      ) : (
        <div className="p-4 flex items-start gap-3">
          <div className="w-1.5 h-1.5 mt-2 rounded-full bg-[#B6861A]" />
          <div className="flex flex-col gap-1">
            <span className="text-[13px] text-ink">No schema version deployed</span>
            <p className="text-[12.5px] text-ink-3 max-w-[60ch]">
              {pipeline.schemaSlug
                ? "Deploy a version from the schema's build page to start processing documents."
                : "Attach a schema to this pipeline first, then deploy a version."}
            </p>
          </div>
        </div>
      )}
    </Section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Configuration

function ConfigurationSection({
  pipeline,
  tenantSlug,
}: {
  pipeline: PipelineDetail;
  tenantSlug: string;
}) {
  const config = (pipeline.configJson ?? {}) as {
    stages?: Record<string, Record<string, unknown>>;
  };
  const stages = config.stages ?? {};

  return (
    <Section title="Configuration">
      <div className="divide-y divide-dotted divide-border">
        <ConfigRow label="Schema">
          {pipeline.schemaSlug && pipeline.schemaName ? (
            <Link
              href={`/t/${tenantSlug}/schemas/${pipeline.schemaSlug}/build`}
              className="text-ink hover:text-vermillion-2 transition-colors"
            >
              {pipeline.schemaName}
            </Link>
          ) : (
            <span className="text-ink-4 italic">not set</span>
          )}
        </ConfigRow>
        <ConfigRow label="Model endpoint">
          {pipeline.modelProviderName ? (
            <Link
              href={`/t/${tenantSlug}/settings/model-providers`}
              className="text-ink hover:text-vermillion-2 transition-colors"
            >
              {pipeline.modelProviderName}
              {pipeline.modelProviderModel && (
                <span className="text-ink-4 ml-1">· {pipeline.modelProviderModel}</span>
              )}
            </Link>
          ) : (
            <span className="text-ink-4 italic">not set</span>
          )}
        </ConfigRow>
        <ConfigRow label="Review threshold">
          <code className="font-mono text-ink-2">{pipeline.reviewThreshold}</code>
          <span className="font-mono text-[10px] text-ink-4 ml-2">
            documents below this confidence route to review
          </span>
        </ConfigRow>
        <ConfigRow label="Trigger">
          <span className="text-ink-2">{pipeline.triggerType}</span>
          {pipeline.triggerConfigJson && Object.keys(pipeline.triggerConfigJson).length > 0 && (
            <code className="font-mono text-[10px] text-ink-4 ml-2">
              {JSON.stringify(pipeline.triggerConfigJson)}
            </code>
          )}
        </ConfigRow>
        {Object.keys(stages).length > 0 && (
          <ConfigRow label="Stages" align="start">
            <div className="flex flex-col gap-1.5 w-full">
              {Object.entries(stages).map(([name, settings]) => (
                <div key={name} className="flex items-start gap-3">
                  <code className="font-mono text-[11.5px] text-vermillion-2 min-w-[90px]">
                    {name}
                  </code>
                  <code className="font-mono text-[11px] text-ink-3 break-all">
                    {JSON.stringify(settings)}
                  </code>
                </div>
              ))}
            </div>
          </ConfigRow>
        )}
      </div>
    </Section>
  );
}

function ConfigRow({
  label,
  children,
  align = "center",
}: {
  label: string;
  children: React.ReactNode;
  align?: "center" | "start";
}) {
  return (
    <div
      className={`grid grid-cols-[160px_1fr] gap-4 px-4 py-2.5 ${
        align === "start" ? "items-start" : "items-center"
      }`}
    >
      <span className="font-mono text-[9.5px] tracking-[0.12em] uppercase text-ink-4">
        {label}
      </span>
      <span className="text-[12.5px] min-w-0">{children}</span>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Retry policy

function RetryPolicySection({
  pipeline,
  canWrite,
  onSaved,
}: {
  pipeline: PipelineDetail;
  canWrite: boolean;
  onSaved: () => void | Promise<unknown>;
}) {
  const persisted = pipeline.retryPolicy;
  const initial = persisted ?? DEFAULT_RETRY_POLICY;

  const [maxAttempts, setMaxAttempts] = useState<string>(String(initial.maxAttempts));
  const [backoffBaseMs, setBackoffBaseMs] = useState<string>(String(initial.backoffBaseMs));
  const [backoffMaxMs, setBackoffMaxMs] = useState<string>(String(initial.backoffMaxMs));
  const [retryTransient, setRetryTransient] = useState<boolean>(initial.retryTransient);

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const usingDefaults = persisted === null;

  function validate(): RetryPolicy | string {
    const ma = Number(maxAttempts);
    const bb = Number(backoffBaseMs);
    const bm = Number(backoffMaxMs);
    if (!Number.isFinite(ma) || !Number.isInteger(ma) || ma < 1 || ma > 50) {
      return "Max attempts must be an integer between 1 and 50.";
    }
    if (!Number.isFinite(bb) || bb <= 0) return "Backoff base must be a positive number.";
    if (!Number.isFinite(bm) || bm <= 0) return "Backoff max must be a positive number.";
    if (bm < bb) return "Backoff max must be greater than or equal to backoff base.";
    return { maxAttempts: ma, backoffBaseMs: bb, backoffMaxMs: bm, retryTransient };
  }

  async function handleSave() {
    if (!canWrite || saving) return;
    const parsed = validate();
    if (typeof parsed === "string") {
      setErr(parsed);
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await pipelinesApi.setRetryPolicy(pipeline.slug, parsed);
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (!canWrite || saving) return;
    setSaving(true);
    setErr(null);
    try {
      await pipelinesApi.setRetryPolicy(pipeline.slug, null);
      setMaxAttempts(String(DEFAULT_RETRY_POLICY.maxAttempts));
      setBackoffBaseMs(String(DEFAULT_RETRY_POLICY.backoffBaseMs));
      setBackoffMaxMs(String(DEFAULT_RETRY_POLICY.backoffMaxMs));
      setRetryTransient(DEFAULT_RETRY_POLICY.retryTransient);
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Reset failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title="Retry policy"
      action={
        <span className="font-mono text-[9.5px] tracking-[0.08em] uppercase text-ink-4">
          {usingDefaults ? "platform defaults" : "custom"}
        </span>
      }
    >
      <div className="divide-y divide-dotted divide-border">
        <ConfigRow label="Max attempts">
          <input
            type="number"
            min={1}
            max={50}
            step={1}
            value={maxAttempts}
            disabled={!canWrite || saving}
            onChange={(e) => setMaxAttempts(e.target.value)}
            placeholder={String(DEFAULT_RETRY_POLICY.maxAttempts)}
            className="h-[28px] w-[96px] rounded-sm border border-input bg-white px-2 font-mono text-[12px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 disabled:opacity-50"
          />
          <span className="font-mono text-[10px] text-ink-4 ml-2">
            1–50; default {DEFAULT_RETRY_POLICY.maxAttempts}
          </span>
        </ConfigRow>
        <ConfigRow label="Backoff base (ms)">
          <input
            type="number"
            min={1}
            step={100}
            value={backoffBaseMs}
            disabled={!canWrite || saving}
            onChange={(e) => setBackoffBaseMs(e.target.value)}
            placeholder={String(DEFAULT_RETRY_POLICY.backoffBaseMs)}
            className="h-[28px] w-[120px] rounded-sm border border-input bg-white px-2 font-mono text-[12px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 disabled:opacity-50"
          />
          <span className="font-mono text-[10px] text-ink-4 ml-2">
            starting delay; default {DEFAULT_RETRY_POLICY.backoffBaseMs.toLocaleString()}
          </span>
        </ConfigRow>
        <ConfigRow label="Backoff max (ms)">
          <input
            type="number"
            min={1}
            step={1000}
            value={backoffMaxMs}
            disabled={!canWrite || saving}
            onChange={(e) => setBackoffMaxMs(e.target.value)}
            placeholder={String(DEFAULT_RETRY_POLICY.backoffMaxMs)}
            className="h-[28px] w-[140px] rounded-sm border border-input bg-white px-2 font-mono text-[12px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 disabled:opacity-50"
          />
          <span className="font-mono text-[10px] text-ink-4 ml-2">
            upper cap; default {DEFAULT_RETRY_POLICY.backoffMaxMs.toLocaleString()}
          </span>
        </ConfigRow>
        <ConfigRow label="Retry transient">
          <label className="inline-flex items-center gap-2 text-[12.5px] text-ink-2">
            <input
              type="checkbox"
              checked={retryTransient}
              disabled={!canWrite || saving}
              onChange={(e) => setRetryTransient(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Auto-retry transient errors (network blips, 5xx, rate limits).
          </label>
        </ConfigRow>
      </div>
      {err && (
        <div className="px-4 py-2 font-mono text-[11.5px] text-vermillion-2 bg-vermillion-3/50 border-t border-border">
          {err}
        </div>
      )}
      {canWrite && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-border bg-cream-2/30">
          <button
            type="button"
            onClick={handleReset}
            disabled={saving || usingDefaults}
            className="font-mono text-[11px] text-ink-3 hover:text-vermillion-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Reset to defaults
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-[11.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </Section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Connected sources

function ConnectedSourcesSection({
  pipeline,
  tenantSlug,
  canWrite,
  onChanged,
}: {
  pipeline: PipelineDetail;
  tenantSlug: string;
  canWrite: boolean;
  onChanged: () => void | Promise<unknown>;
}) {
  const [connectOpen, setConnectOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function handleDisconnect(sourceId: string) {
    setBusy(sourceId);
    setErr(null);
    try {
      await sourcesApi.setTargetPipeline(sourceId, null);
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Disconnect failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Section title="Connected sources">
        {err && (
          <div className="px-4 pt-3 font-mono text-[11px] text-vermillion-2">{err}</div>
        )}
        {pipeline.connectedSources.length === 0 ? (
          <div className="px-4 py-4 text-[12.5px] text-ink-3">
            No sources connected.{" "}
            {canWrite
              ? "Connect a source below to feed documents into this pipeline."
              : "A workspace admin can connect a source to feed documents into this pipeline."}
          </div>
        ) : (
          <div className="divide-y divide-dotted divide-border">
            {pipeline.connectedSources.map((s) => (
              <div
                key={s.id}
                className="grid grid-cols-[minmax(0,1fr)_110px_90px_120px_88px] gap-4 px-4 py-2.5 items-center"
              >
                <Link
                  href={`/t/${tenantSlug}/sources`}
                  className="text-[12.5px] text-ink truncate hover:text-vermillion-2 transition-colors"
                >
                  {s.displayName}
                </Link>
                <span className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.08em]">
                  {s.sourceType}
                </span>
                <StatusPill status={s.status} />
                <span className="font-mono text-[10px] text-ink-4">
                  {formatRelativeTime(s.lastIngestedAt)}
                </span>
                {canWrite ? (
                  <button
                    type="button"
                    disabled={busy === s.id}
                    onClick={() => handleDisconnect(s.id)}
                    className="inline-flex items-center justify-end gap-1 font-mono text-[10px] text-ink-3 hover:text-vermillion-2 transition-colors disabled:opacity-40"
                  >
                    <Unlink className="w-3 h-3" />
                    {busy === s.id ? "…" : "disconnect"}
                  </button>
                ) : (
                  <span />
                )}
              </div>
            ))}
          </div>
        )}
        {canWrite && (
          <div className="px-4 py-2.5 border-t border-border bg-cream-2/30">
            <button
              type="button"
              onClick={() => setConnectOpen(true)}
              className="inline-flex items-center gap-1.5 font-mono text-[11px] text-ink-2 hover:text-vermillion-2 transition-colors"
            >
              <Plus className="w-3 h-3" />
              Connect source
            </button>
          </div>
        )}
      </Section>

      {connectOpen && (
        <ConnectSourceDialog
          pipeline={pipeline}
          tenantSlug={tenantSlug}
          onClose={() => setConnectOpen(false)}
          onConnected={async () => {
            setConnectOpen(false);
            await onChanged();
          }}
        />
      )}
    </>
  );
}

function ConnectSourceDialog({
  pipeline,
  tenantSlug,
  onClose,
  onConnected,
}: {
  pipeline: PipelineDetail;
  tenantSlug: string;
  onClose: () => void;
  onConnected: () => void | Promise<unknown>;
}) {
  const { data: allSources, loading } = useApi(useCallback(() => sourcesApi.list(), []));
  const [selected, setSelected] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const sources = (allSources ?? []).filter((s) => s.targetPipelineId !== pipeline.id);
  const chosen = sources.find((s) => s.id === selected) ?? null;
  const reassigning = chosen?.targetPipelineId != null;

  async function handleConnect() {
    if (!chosen || submitting) return;
    setSubmitting(true);
    setErr(null);
    try {
      await sourcesApi.setTargetPipeline(chosen.id, pipeline.id);
      await onConnected();
    } catch (e) {
      setSubmitting(false);
      setErr(e instanceof Error ? e.message : "Connect failed");
    }
  }

  const empty = !loading && sources.length === 0;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[480px] p-6">
        <div className="flex items-start justify-between mb-1">
          <h2
            className="font-display text-[22px] font-medium text-ink leading-tight"
            style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
          >
            Connect source
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-4 hover:text-ink transition-colors p-1 -m-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-[12.5px] text-ink-3 mb-4">
          Pick a source to feed into <strong className="text-ink">{pipeline.displayName}</strong>.
          A source can only target one pipeline at a time.
        </p>

        {loading ? (
          <div className="animate-pulse font-mono text-[11px] text-ink-4 py-6 text-center">
            Loading sources…
          </div>
        ) : empty ? (
          <div className="flex flex-col gap-3 border border-border rounded-sm p-4 bg-cream-2/30">
            <p className="text-[12.5px] text-ink-2">
              No sources in this project. Create a source to feed documents into this pipeline.
            </p>
            <Link
              href={`/t/${tenantSlug}/sources`}
              className="inline-flex items-center gap-1 font-mono text-[11px] text-vermillion-2 hover:text-ink transition-colors self-start"
            >
              Create source
              <ChevronRight className="w-3 h-3" />
            </Link>
          </div>
        ) : (
          <>
            <label className="font-mono text-[9.5px] tracking-[0.08em] uppercase text-ink-4 block mb-1">
              Source
            </label>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="w-full h-[32px] rounded-sm border border-input bg-white px-2 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30"
            >
              <option value="">Select a source…</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName} · {s.sourceType}
                  {s.targetPipelineId ? " · already targeting another pipeline" : ""}
                </option>
              ))}
            </select>

            {reassigning && (
              <div className="mt-3 flex items-start gap-2 rounded-sm bg-[#B6861A]/[0.08] border border-[#B6861A]/30 px-3 py-2">
                <AlertTriangle className="w-3.5 h-3.5 text-[#B6861A] mt-0.5 shrink-0" />
                <p className="text-[12px] text-ink-2">
                  <strong className="text-[#B6861A]">{chosen!.displayName}</strong> is currently
                  connected to another pipeline. Connecting it here will disconnect it from there.
                </p>
              </div>
            )}
          </>
        )}

        {err && (
          <div className="mt-3 text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">
            {err}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConnect}
            disabled={!chosen || submitting || empty}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? "Connecting…" : reassigning ? "Reassign" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone = statusTone(status);
  const styles =
    tone === "success"
      ? "bg-green/[0.12] text-green"
      : tone === "fail"
      ? "bg-vermillion-3 text-vermillion-2"
      : "bg-cream-2 text-ink-3";
  return (
    <span
      className={`inline-flex items-center justify-center font-mono text-[10px] font-medium px-1.5 py-0.5 rounded-sm uppercase tracking-[0.08em] w-fit ${styles}`}
    >
      {statusLabel(status)}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Recent jobs

function RecentJobsSection({
  jobs,
  tenantSlug,
}: {
  jobs: PipelineRecentJob[];
  tenantSlug: string;
}) {
  return (
    <Section
      title="Recent jobs"
      action={
        <Link
          href={`/t/${tenantSlug}/jobs`}
          className="font-mono text-[11px] text-ink-3 hover:text-vermillion-2 transition-colors"
        >
          all jobs →
        </Link>
      }
    >
      {jobs.length === 0 ? (
        <div className="px-4 py-4 text-[12.5px] text-ink-3">No jobs yet.</div>
      ) : (
        <div className="divide-y divide-dotted divide-border">
          {jobs.map((j) => {
            const rate =
              j.docsProcessed > 0 ? ((j.docsPassed / j.docsProcessed) * 100).toFixed(1) : "—";
            return (
              <Link
                key={j.id}
                href={`/t/${tenantSlug}/jobs/${j.slug}`}
                className="grid grid-cols-[minmax(200px,1fr)_92px_80px_72px_110px_20px] gap-4 px-4 py-2.5 items-center hover:bg-cream-2/60 transition-colors"
              >
                <code className="font-mono text-[11.5px] text-ink truncate">{j.slug}</code>
                <StatusPill status={j.status} />
                <span className="font-mono text-[11px] text-ink-2 text-right">
                  {j.docsProcessed}/{j.docsTotal}
                </span>
                <span className="font-mono text-[11px] text-ink-3 text-right">
                  {rate === "—" ? "—" : `${rate}%`}
                </span>
                <span className="font-mono text-[10px] text-ink-4 text-right">
                  {formatRelativeTime(j.createdAt)}
                </span>
                <ChevronRight className="w-3 h-3 text-ink-4" />
              </Link>
            );
          })}
        </div>
      )}
    </Section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Danger zone

function DangerZone({
  pipeline,
  onDelete,
}: {
  pipeline: PipelineDetail;
  onDelete: () => void;
}) {
  const sourceCount = pipeline.connectedSources.length;
  return (
    <div className="border border-vermillion-2/30 rounded-sm bg-vermillion-3/20">
      <div className="px-4 py-2 border-b border-vermillion-2/30 bg-vermillion-3/40">
        <span className="font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase text-vermillion-2">
          Danger zone
        </span>
      </div>
      <div className="p-4 flex items-start justify-between gap-6">
        <div className="flex flex-col gap-1">
          <span className="text-[13px] text-ink font-medium">Delete pipeline</span>
          <p className="text-[12.5px] text-ink-3 max-w-[60ch]">
            {sourceCount > 0
              ? `${sourceCount} source${sourceCount === 1 ? "" : "s"} will be unlinked. `
              : ""}
            Recent jobs and documents stay in history for audit; the pipeline is soft-deleted.
          </p>
        </div>
        <button
          onClick={onDelete}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-vermillion-2 text-cream hover:bg-ink transition-colors shrink-0"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Delete
        </button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Section wrapper

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-border rounded-sm bg-cream overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border bg-cream-2/50">
        <span className="font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase text-ink-4">
          {title}
        </span>
        {action}
      </div>
      {children}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Deploy dialog

function DeployDialog({
  pipeline,
  onClose,
  onDeploy,
  submitting,
}: {
  pipeline: PipelineDetail;
  onClose: () => void;
  onDeploy: (schemaVersionId: string) => void;
  submitting: boolean;
}) {
  const [selected, setSelected] = useState<string>(pipeline.activeSchemaVersionId ?? "");
  const { data: versions, loading } = useApi(
    useCallback(
      () => pipelinesApi.schemaVersions(pipeline.schemaSlug!),
      [pipeline.schemaSlug],
    ),
  );

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[520px] p-6">
        <div className="flex items-start justify-between mb-1">
          <h2
            className="font-display text-[22px] font-medium text-ink leading-tight"
            style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
          >
            Deploy schema version
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-4 hover:text-ink transition-colors p-1 -m-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-[12.5px] text-ink-3 mb-4">
          Pick a version to make active. Documents processed after deployment use this version.
        </p>

        <div className="max-h-[340px] overflow-y-auto border border-border rounded-sm divide-y divide-dotted divide-border">
          {loading ? (
            <div className="animate-pulse px-3 py-4 text-[12px] text-ink-4 text-center">
              Loading…
            </div>
          ) : (versions ?? []).length === 0 ? (
            <div className="px-3 py-4 text-[12.5px] text-ink-3 text-center">
              No versions committed yet. Commit one on the schema&apos;s build page first.
            </div>
          ) : (
            (versions ?? []).map((v: SchemaVersion) => (
              <label
                key={v.id}
                className={`flex items-start gap-3 px-3 py-2.5 cursor-pointer transition-colors ${
                  selected === v.id ? "bg-cream-2" : "hover:bg-cream-2/50"
                }`}
              >
                <input
                  type="radio"
                  name="schemaVersion"
                  value={v.id}
                  checked={selected === v.id}
                  onChange={() => setSelected(v.id)}
                  className="mt-1"
                />
                <div className="flex flex-col gap-0.5 min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-[12px] text-ink">v{v.versionNumber}</code>
                    {pipeline.activeSchemaVersionId === v.id && (
                      <span className="font-mono text-[9.5px] text-green bg-green/10 px-1.5 py-0.5 rounded-sm uppercase tracking-[0.08em]">
                        current
                      </span>
                    )}
                  </div>
                  {v.commitMessage && (
                    <span className="text-[12.5px] text-ink-2 truncate">{v.commitMessage}</span>
                  )}
                  <span className="font-mono text-[10px] text-ink-4">
                    {v.committedByName ? `${v.committedByName} · ` : ""}
                    {formatAbsoluteTime(v.createdAt)}
                  </span>
                </div>
              </label>
            ))
          )}
        </div>

        <div className="flex items-center justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!selected || submitting || selected === pipeline.activeSchemaVersionId}
            onClick={() => onDeploy(selected)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-40"
          >
            {submitting ? (
              "Deploying…"
            ) : selected === pipeline.activeSchemaVersionId ? (
              "Already deployed"
            ) : (
              <>
                <RotateCcw className="w-3.5 h-3.5" />
                Deploy
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Run dialog — upload a single document and route to the new job

function RunDialog({
  pipeline,
  tenantSlug,
  onClose,
  onStarted,
}: {
  pipeline: PipelineDetail;
  tenantSlug: string;
  onClose: () => void;
  onStarted: (jobSlug: string) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; errors: string[] }>({ done: 0, total: 0, errors: [] });
  const [err, setErr] = useState<string | null>(null);
  void tenantSlug;

  function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setFiles((prev) => [...prev, ...Array.from(list)]);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  }

  function removeFile(idx: number) {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (files.length === 0 || submitting) return;
    setSubmitting(true);
    setErr(null);
    setProgress({ done: 0, total: files.length, errors: [] });

    let lastJobSlug = "";
    const errors: string[] = [];

    for (let i = 0; i < files.length; i++) {
      try {
        const result = await pipelinesApi.run(pipeline.slug, files[i]!);
        lastJobSlug = result.jobSlug;
      } catch (e: unknown) {
        errors.push(`${files[i]!.name}: ${e instanceof Error ? e.message : "Failed"}`);
      }
      setProgress({ done: i + 1, total: files.length, errors });
    }

    if (lastJobSlug) {
      onStarted(lastJobSlug);
    } else {
      setSubmitting(false);
      setErr(errors.join("; ") || "All uploads failed");
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[480px] p-6">
        <div className="flex items-start justify-between mb-1">
          <h2
            className="font-display text-[22px] font-medium text-ink leading-tight"
            style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
          >
            Run pipeline
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-4 hover:text-ink transition-colors p-1 -m-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-[12.5px] text-ink-3 mb-4">
          Upload documents to run through{" "}
          <strong className="text-ink">{pipeline.displayName}</strong>. Extraction starts
          immediately for each file.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            className={`flex flex-col items-center justify-center gap-2 px-4 py-6 border border-dashed rounded-sm transition-colors ${
              dragOver
                ? "border-vermillion-2 bg-vermillion-3/20"
                : "border-border-strong bg-cream-2/40"
            }`}
          >
            <Upload className="w-5 h-5 text-ink-4" />
            <span className="text-[12.5px] text-ink font-medium">
              Drop files or pick them
            </span>
            <label className="font-mono text-[11px] text-vermillion-2 hover:text-ink transition-colors cursor-pointer">
              Choose files…
              <input
                type="file"
                className="hidden"
                multiple
                accept=".pdf,.png,.jpg,.jpeg,.tiff,.tif"
                onChange={(e) => handleFiles(e.target.files)}
              />
            </label>
            <span className="font-mono text-[10px] text-ink-4">PDF, PNG, JPG, TIFF</span>
          </div>

          {/* File list */}
          {files.length > 0 && (
            <div className="border border-border rounded-sm divide-y divide-border max-h-[200px] overflow-y-auto">
              {files.map((f, i) => (
                <div key={`${f.name}-${i}`} className="flex items-center justify-between px-3 py-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-[11px] text-ink truncate">{f.name}</span>
                    <span className="font-mono text-[9px] text-ink-4 shrink-0">{formatBytes(f.size)}</span>
                  </div>
                  {!submitting && (
                    <button
                      type="button"
                      onClick={() => removeFile(i)}
                      className="text-ink-4 hover:text-vermillion-2 transition-colors shrink-0 ml-2"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Progress */}
          {submitting && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 animate-spin text-vermillion-2 shrink-0" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="font-mono text-[11px] text-ink">
                  Processing {progress.done} of {progress.total}...
                </span>
              </div>
              <div className="w-full h-1.5 bg-cream-2 rounded-full overflow-hidden">
                <div
                  className="h-full bg-vermillion-2 rounded-full transition-all"
                  style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }}
                />
              </div>
            </div>
          )}

          {err && (
            <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">
              {err}
            </div>
          )}

          <div className="flex items-center justify-between pt-1">
            <span className="font-mono text-[10px] text-ink-4">
              {files.length > 0 ? `${files.length} file${files.length === 1 ? "" : "s"} selected` : ""}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={files.length === 0 || submitting}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-vermillion-2 text-cream hover:bg-ink transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting ? `Processing ${progress.done}/${progress.total}` : `Run ${files.length > 1 ? `${files.length} files` : ""}`}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ──────────────────────────────────────────────────────────────────────
// Delete dialog — type-to-confirm

function DeleteDialog({
  pipeline,
  submitting,
  onClose,
  onConfirm,
}: {
  pipeline: PipelineDetail;
  submitting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [confirm, setConfirm] = useState("");
  const sourceCount = pipeline.connectedSources.length;
  const canDelete = confirm === pipeline.slug;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[460px] p-6">
        <div className="flex items-start justify-between mb-1">
          <h2
            className="font-display text-[22px] font-medium text-ink leading-tight"
            style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
          >
            Delete pipeline
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-4 hover:text-ink transition-colors p-1 -m-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-[12.5px] text-ink-3 mb-4">
          {sourceCount > 0 && (
            <>
              <strong>{sourceCount}</strong> source{sourceCount === 1 ? "" : "s"} will be unlinked.{" "}
            </>
          )}
          This is reversible via database restore only.
        </p>

        <label className="font-mono text-[10px] tracking-[0.08em] uppercase text-ink-4 block mb-1">
          Type the pipeline slug to confirm
        </label>
        <input
          type="text"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder={pipeline.slug}
          autoFocus
          className="w-full h-[32px] rounded-sm border border-input bg-cream-2 px-2.5 font-mono text-[12px] outline-none focus:border-ink focus:bg-cream transition-colors"
        />

        <div className="flex items-center justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canDelete || submitting}
            onClick={onConfirm}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-vermillion-2 text-cream hover:bg-ink transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {submitting ? "Deleting…" : "Delete pipeline"}
          </button>
        </div>
      </div>
    </div>
  );
}
