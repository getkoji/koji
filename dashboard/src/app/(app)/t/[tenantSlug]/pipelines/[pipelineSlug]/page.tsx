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
} from "lucide-react";
import { ListLayout, Breadcrumbs, PageHeader } from "@/components/layouts";
import { EmptyState } from "@/components/shared/EmptyState";
import {
  pipelines as pipelinesApi,
  sources as sourcesApi,
  type PipelineDetail,
  type PipelineRecentJob,
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
        <ConfigRow label="Model provider">
          {pipeline.modelProviderName ? (
            <Link
              href={`/t/${tenantSlug}/settings/model-catalog`}
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
