"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Workflow } from "lucide-react";
import { ListLayout, Breadcrumbs, PageHeader } from "@/components/layouts";
import { EmptyState } from "@/components/shared/EmptyState";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { api, pipelines as pipelinesApi, type PipelineRow } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { useAuth } from "@/lib/auth-context";
import { statusTone, statusLabel, formatRelativeTime } from "./format";

interface SchemaOption {
  id: string;
  slug: string;
  displayName: string;
}

interface ProviderOption {
  id: string;
  displayName: string;
  model: string;
}

export default function PipelinesPage() {
  const { hasPermission } = useAuth();
  const params = useParams<{ tenantSlug: string }>();
  const tenantSlug = params?.tenantSlug ?? "";
  const [showCreate, setShowCreate] = useState(false);

  const { data: pipelines, loading, error, refetch } = useApi(
    useCallback(() => pipelinesApi.list(), []),
  );

  const metrics = useMemo(() => {
    const rows = pipelines ?? [];
    const active = rows.filter((p) => p.status === "active").length;
    const docsProcessed = rows.reduce((sum, p) => sum + (p.docsPassed ?? 0), 0);
    return { total: rows.length, active, docsProcessed };
  }, [pipelines]);

  return (
    <ListLayout
      header={
        <>
          <Breadcrumbs
            items={[
              { label: tenantSlug, href: `/t/${tenantSlug}` },
              { label: "Pipelines" },
            ]}
          />
          <PageHeader
            title="Pipelines"
            meta={
              <span>
                Named sequences of stages that documents flow through. A pipeline uses a deployed
                schema version and a model provider to extract.
              </span>
            }
            actions={
              hasPermission("pipeline:write") ? (
                <button
                  onClick={() => setShowCreate(true)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-vermillion-2 text-cream hover:bg-ink transition-colors"
                >
                  + Create pipeline
                </button>
              ) : undefined
            }
          />
        </>
      }
      metricsStrip={<MetricsStrip metrics={metrics} />}
    >
      {error ? (
        <EmptyState
          title="Cannot reach API"
          description={`${error.message}. Start the server with: pnpm --filter @koji/api dev`}
        />
      ) : loading && !pipelines ? (
        <TableSkeleton columns={5} rows={4} />
      ) : (pipelines ?? []).length === 0 ? (
        <EmptyState
          icon={<Workflow className="w-8 h-8" />}
          title="No pipelines yet"
          description="Create a pipeline to start processing documents."
          action={
            hasPermission("pipeline:write") ? (
              <button
                onClick={() => setShowCreate(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors"
              >
                + Create pipeline
              </button>
            ) : undefined
          }
        />
      ) : (
        <PipelineGrid pipelines={pipelines!} tenantSlug={tenantSlug} />
      )}

      {showCreate && (
        <CreatePipelineDialog
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            refetch();
          }}
        />
      )}
    </ListLayout>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Metrics strip

function MetricsStrip({
  metrics,
}: {
  metrics: { total: number; active: number; docsProcessed: number };
}) {
  return (
    <div className="grid grid-cols-3 gap-4 border border-border rounded-sm bg-cream overflow-hidden">
      <Metric label="Pipelines" value={metrics.total.toString()} />
      <Metric
        label="Active"
        value={metrics.active.toString()}
        sub={metrics.total - metrics.active > 0 ? `${metrics.total - metrics.active} paused` : undefined}
      />
      <Metric
        label="Docs processed"
        value={metrics.docsProcessed.toLocaleString()}
        sub="across all pipelines"
      />
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-1 px-5 py-3 border-r border-border last:border-r-0">
      <span className="font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase text-ink-4">
        {label}
      </span>
      <span className="font-display text-[26px] font-medium leading-none tracking-tight text-ink">
        {value}
      </span>
      {sub && <span className="font-mono text-[10px] text-ink-4">{sub}</span>}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Card grid

function PipelineGrid({
  pipelines,
  tenantSlug,
}: {
  pipelines: PipelineRow[];
  tenantSlug: string;
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {pipelines.map((p) => (
        <PipelineCard key={p.id} pipeline={p} tenantSlug={tenantSlug} />
      ))}
    </div>
  );
}

function PipelineCard({ pipeline, tenantSlug }: { pipeline: PipelineRow; tenantSlug: string }) {
  const undeployed = pipeline.deployedVersion === null;
  const successRate =
    pipeline.docsPassed + pipeline.docsFailed > 0
      ? pipeline.docsPassed / (pipeline.docsPassed + pipeline.docsFailed)
      : null;

  return (
    <Link
      href={`/t/${tenantSlug}/pipelines/${pipeline.slug}`}
      className="flex flex-col gap-3 border border-border rounded-sm bg-cream p-4 hover:border-ink/40 hover:bg-cream-2/40 transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1 min-w-0">
          <h2
            className="font-display text-[20px] font-medium leading-none tracking-tight text-ink m-0 truncate"
            style={{ fontVariationSettings: "'opsz' 96, 'SOFT' 50" }}
          >
            {pipeline.displayName}
          </h2>
          <div className="flex items-center gap-2">
            <code className="font-mono text-[10px] text-ink-4 truncate">{pipeline.slug}</code>
            {pipeline.pipelineType === "dag" ? (
              <span className="font-mono text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded bg-vermillion/8 text-vermillion">DAG</span>
            ) : null}
          </div>
        </div>
        <StatusBadge status={pipeline.status} undeployed={undeployed} />
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-[11px]">
        <DefRow label="Schema">
          {pipeline.schemaName ? (
            <span className="text-ink">
              {pipeline.schemaName}
              {pipeline.deployedVersion !== null ? (
                <span className="text-ink-4 ml-1">v{pipeline.deployedVersion}</span>
              ) : (
                <span className="text-vermillion-2 ml-1">· not deployed</span>
              )}
            </span>
          ) : (
            <span className="text-ink-4 italic">none</span>
          )}
        </DefRow>
        <DefRow label="Model">
          {pipeline.modelProviderName ? (
            <span className="text-ink">
              {pipeline.modelProviderName}
              {pipeline.modelProviderModel && (
                <span className="text-ink-4 ml-1">· {pipeline.modelProviderModel}</span>
              )}
            </span>
          ) : (
            <span className="text-ink-4 italic">unset</span>
          )}
        </DefRow>
        <DefRow label="Trigger">
          <span className="text-ink-2">{pipeline.triggerType}</span>
        </DefRow>
        <DefRow label="Last run">
          <span className="text-ink-3">{formatRelativeTime(pipeline.lastRunAt)}</span>
        </DefRow>
      </div>

      <div className="flex items-center gap-4 pt-2 border-t border-border">
        <Stat label="Docs" value={pipeline.docsTotal.toLocaleString()} />
        <Stat
          label="Success"
          value={successRate === null ? "—" : `${(successRate * 100).toFixed(1)}%`}
          tone={successRate !== null && successRate >= 0.99 ? "success" : "neutral"}
        />
        <Stat
          label="Failed"
          value={pipeline.docsFailed.toLocaleString()}
          tone={pipeline.docsFailed > 0 ? "fail" : "neutral"}
        />
      </div>
    </Link>
  );
}

function DefRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="text-[9.5px] tracking-[0.08em] uppercase text-ink-4 shrink-0">
        {label}
      </span>
      <span className="truncate">{children}</span>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "success" | "fail";
}) {
  const valueColor =
    tone === "success" ? "text-green" : tone === "fail" ? "text-vermillion-2" : "text-ink";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[9.5px] tracking-[0.08em] uppercase text-ink-4">
        {label}
      </span>
      <span className={`font-mono text-[13px] tabular-nums ${valueColor}`}>{value}</span>
    </div>
  );
}

function StatusBadge({ status, undeployed }: { status: string; undeployed: boolean }) {
  if (undeployed && status === "active") {
    return (
      <span className="inline-flex items-center font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm uppercase tracking-[0.08em] bg-[#B6861A]/[0.14] text-[#B6861A] shrink-0">
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
      className={`inline-flex items-center font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm uppercase tracking-[0.08em] shrink-0 ${styles}`}
    >
      {statusLabel(status)}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Create dialog (shared create form, unchanged API contract)

interface FormErrors {
  name?: string;
  slug?: string;
  schemaId?: string;
  modelProviderId?: string;
  reviewThreshold?: string;
}

function validatePipelineForm(values: {
  name: string;
  slug: string;
  schemaId: string;
  modelProviderId: string;
  reviewThreshold: string;
}): FormErrors {
  const errors: FormErrors = {};
  if (!values.name.trim()) errors.name = "Name is required";
  if (!values.slug) errors.slug = "Slug is required";
  else if (!/^[a-z0-9][a-z0-9-]*$/.test(values.slug))
    errors.slug = "Lowercase letters, numbers, and hyphens only";
  if (!values.schemaId) errors.schemaId = "Select a schema";
  if (!values.modelProviderId) errors.modelProviderId = "Select a model endpoint";
  const t = Number(values.reviewThreshold);
  if (!Number.isFinite(t)) errors.reviewThreshold = "Must be a number";
  else if (t < 0 || t > 1) errors.reviewThreshold = "Must be between 0 and 1";
  return errors;
}

function CreatePipelineDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [schemaId, setSchemaId] = useState("");
  const [modelProviderId, setModelProviderId] = useState("");
  const [reviewThreshold, setReviewThreshold] = useState("0.9");
  const [creating, setCreating] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { data: schemasList, loading: schemasLoading } = useApi(
    useCallback(() => api.get<{ data: SchemaOption[] }>("/api/schemas").then((r) => r.data), []),
  );
  const { data: providersList, loading: providersLoading } = useApi(
    useCallback(
      () => api.get<{ data: ProviderOption[] }>("/api/model-providers").then((r) => r.data),
      [],
    ),
  );

  const errors = validatePipelineForm({ name, slug, schemaId, modelProviderId, reviewThreshold });
  const hasErrors = Object.keys(errors).length > 0;
  const showErrors = attempted;

  const noSchemas = !schemasLoading && (schemasList ?? []).length === 0;
  const noProviders = !providersLoading && (providersList ?? []).length === 0;
  const blocked = noSchemas || noProviders;

  function handleNameChange(v: string) {
    setName(v);
    if (!slugTouched) {
      setSlug(
        v
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, ""),
      );
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setAttempted(true);
    if (hasErrors) return;

    setSubmitError(null);
    setCreating(true);
    try {
      await api.post("/api/pipelines", {
        name: name.trim(),
        slug,
        schema_id: schemaId,
        model_provider_id: modelProviderId,
        review_threshold: Number(reviewThreshold),
      });
      onCreated();
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : "Failed to create pipeline");
      setCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[480px] p-6">
        <h2
          className="font-display text-[22px] font-medium text-ink leading-tight mb-1"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
        >
          Create pipeline
        </h2>
        <p className="text-[12.5px] text-ink-3 mb-5">
          Connects a schema to a model provider. Deploy a schema version after creating.
        </p>

        {blocked && (
          <div className="flex flex-col gap-1.5 bg-[#B6861A]/[0.08] border border-[#B6861A]/30 rounded-sm px-3 py-2 mb-4">
            <span className="font-mono text-[10.5px] tracking-[0.08em] uppercase text-[#B6861A] font-medium">
              Setup required
            </span>
            <div className="text-[12.5px] text-ink-2">
              {noSchemas && (
                <p>
                  No schemas exist yet.{" "}
                  <span className="text-ink-3">Create one from the Schemas sidebar first.</span>
                </p>
              )}
              {noProviders && (
                <p>
                  No model providers configured.{" "}
                  <span className="text-ink-3">
                    Add one in{" "}
                    <span className="font-mono">Project settings → Model providers</span>.
                  </span>
                </p>
              )}
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" error={showErrors ? errors.name : undefined}>
              <input
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="e.g. Claims Intake"
                autoFocus
                aria-invalid={Boolean(showErrors && errors.name)}
                className={inputClass(showErrors && errors.name)}
              />
            </Field>
            <Field label="Slug" error={showErrors ? errors.slug : undefined}>
              <input
                value={slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
                }}
                placeholder="my-pipeline"
                aria-invalid={Boolean(showErrors && errors.slug)}
                className={`${inputClass(showErrors && errors.slug)} font-mono`}
              />
            </Field>
          </div>

          <Field label="Schema" error={showErrors ? errors.schemaId : undefined}>
            <select
              value={schemaId}
              onChange={(e) => setSchemaId(e.target.value)}
              disabled={noSchemas}
              aria-invalid={Boolean(showErrors && errors.schemaId)}
              className={`${inputClass(showErrors && errors.schemaId)} bg-white`}
            >
              <option value="">
                {schemasLoading ? "Loading schemas…" : noSchemas ? "No schemas available" : "Select a schema…"}
              </option>
              {(schemasList ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Model endpoint" error={showErrors ? errors.modelProviderId : undefined}>
            <select
              value={modelProviderId}
              onChange={(e) => setModelProviderId(e.target.value)}
              disabled={noProviders}
              aria-invalid={Boolean(showErrors && errors.modelProviderId)}
              className={`${inputClass(showErrors && errors.modelProviderId)} bg-white`}
            >
              <option value="">
                {providersLoading
                  ? "Loading endpoints…"
                  : noProviders
                  ? "No endpoints configured"
                  : "Select an endpoint…"}
              </option>
              {(providersList ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName} ({p.model})
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Review threshold"
            error={showErrors ? errors.reviewThreshold : undefined}
            hint="Documents below this confidence route to human review"
          >
            <input
              type="number"
              step="0.01"
              min="0"
              max="1"
              value={reviewThreshold}
              onChange={(e) => setReviewThreshold(e.target.value)}
              aria-invalid={Boolean(showErrors && errors.reviewThreshold)}
              className={`${inputClass(showErrors && errors.reviewThreshold)} w-24 font-mono`}
            />
          </Field>

          {submitError && (
            <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">
              {submitError}
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
              disabled={creating || blocked || (attempted && hasErrors)}
              className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-vermillion-2 text-cream hover:bg-ink transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {creating ? "Creating…" : "Create pipeline"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[12.5px] font-medium text-ink">{label}</label>
      {children}
      {error ? (
        <span className="font-mono text-[10.5px] text-vermillion-2">{error}</span>
      ) : hint ? (
        <span className="text-[11px] text-ink-4">{hint}</span>
      ) : null}
    </div>
  );
}

function inputClass(invalid: string | undefined | false | null): string {
  const base =
    "h-[32px] rounded-sm border px-2.5 text-[13px] outline-none bg-transparent placeholder:text-ink-4 transition-colors";
  if (invalid) {
    return `w-full ${base} border-vermillion-2 focus:border-vermillion-2 focus:ring-[2px] focus:ring-vermillion-2/20`;
  }
  return `w-full ${base} border-input focus:border-ring focus:ring-[2px] focus:ring-ring/30`;
}
