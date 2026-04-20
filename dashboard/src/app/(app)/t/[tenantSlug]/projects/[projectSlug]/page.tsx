"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { Check, Circle } from "lucide-react";
import {
  api,
  overviewApi,
  type OverviewActivity,
  type OverviewAttention,
  type OverviewMetrics,
  type OverviewOnboarding,
  type ProjectRow,
} from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { emit } from "@/lib/events";

function titleCase(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function buildSubtitle(
  metrics: OverviewMetrics,
  attentionCount: number,
): string {
  if (metrics.reviewPending > 0) {
    return `${metrics.reviewPending} ${metrics.reviewPending === 1 ? "document" : "documents"} waiting for review.`;
  }
  if (attentionCount > 0) {
    return `${attentionCount} ${attentionCount === 1 ? "item needs" : "items need"} attention.`;
  }
  if (metrics.pipelinesActive > 0 || metrics.schemaCount > 0) {
    const parts: string[] = [];
    if (metrics.pipelinesActive > 0) {
      parts.push(
        `${metrics.pipelinesActive} ${metrics.pipelinesActive === 1 ? "pipeline" : "pipelines"} active`,
      );
    }
    if (metrics.schemaCount > 0) {
      parts.push(
        `${metrics.schemaCount} ${metrics.schemaCount === 1 ? "schema" : "schemas"} under measurement`,
      );
    }
    return `${parts.join(". ")}. Nothing on fire.`;
  }
  return "Project overview and recent activity.";
}

export default function ProjectOverviewPage() {
  const pathname = usePathname();
  const tenantSlug = pathname.match(/^\/t\/([^/]+)/)?.[1] ?? "";
  const projectSlug = pathname.match(/\/projects\/([^/]+)/)?.[1] ?? tenantSlug;
  const base = `/t/${tenantSlug}`;
  const projectBase = `${base}/projects/${projectSlug}`;

  const { data: project } = useApi(
    useCallback(
      () => api.get<ProjectRow>(`/api/projects/${projectSlug}`),
      [projectSlug],
    ),
  );

  const { data: overview, loading } = useApi(
    useCallback(() => overviewApi.get(), []),
  );

  const displayName = project?.displayName ?? titleCase(projectSlug);

  const subtitle = overview
    ? buildSubtitle(overview.metrics, overview.needsAttention.length)
    : "Project overview and recent activity.";

  return (
    <div className="px-10 py-8 pb-16">
      {/* Editorial header */}
      <div className="flex items-start justify-between gap-8 mb-8">
        <div>
          <p className="inline-flex items-center gap-2 font-mono text-[10.5px] font-medium tracking-[0.12em] uppercase text-ink-4 mb-2">
            <span className="text-vermillion-2">01</span>
            <span className="text-cream-4">·</span>
            <span>Overview</span>
          </p>
          <h1
            className="font-display text-[34px] font-medium leading-[1.05] tracking-tight text-ink m-0"
            style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
          >
            {displayName}.
            {overview?.accentLine && (
              <>
                <br />
                <em
                  className="text-vermillion-2 italic"
                  style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 100" }}
                >
                  {overview.accentLine}
                </em>
              </>
            )}
          </h1>
          <p className="text-[13.5px] text-ink-3 max-w-[54ch] mt-1.5 m-0">
            {subtitle}
          </p>
        </div>
      </div>

      {/* Metrics strip */}
      <MetricsStrip
        loading={loading}
        metrics={overview?.metrics}
        base={base}
      />

      {/* Onboarding checklist — visible until every step is checked. Lives
          above the content grid so guidance is the first thing a partially-
          set-up user sees, but doesn't displace the activity feed they
          already have. */}
      {overview?.onboarding && !isOnboardingComplete(overview.onboarding) && (
        <OnboardingSection onboarding={overview.onboarding} base={base} />
      )}

      {/* Content grid: activity + attention */}
      <div className="grid gap-8" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
        <ActivityPanel
          loading={loading}
          items={overview?.recentActivity ?? []}
          base={base}
        />
        <AttentionPanel
          loading={loading}
          items={overview?.needsAttention ?? []}
          base={base}
          projectBase={projectBase}
        />
      </div>
    </div>
  );
}

function MetricsStrip({
  loading,
  metrics,
  base,
}: {
  loading: boolean;
  metrics?: OverviewMetrics;
  base: string;
}) {
  const cards: Array<{
    label: string;
    value: string;
    unit?: string;
    href: string;
  }> = [
    {
      label: "Accuracy",
      value:
        metrics?.accuracy != null ? metrics.accuracy.toFixed(1) : "—",
      unit: metrics?.accuracy != null ? "%" : undefined,
      href: `${base}`,
    },
    {
      label: "Processed",
      value:
        metrics?.documentsProcessed != null
          ? metrics.documentsProcessed.toLocaleString()
          : "—",
      unit:
        metrics?.documentsProcessed === 1 ? "doc" : "docs",
      href: `${base}/jobs`,
    },
    {
      label: "Review backlog",
      value:
        metrics?.reviewPending != null
          ? metrics.reviewPending.toLocaleString()
          : "—",
      href: `${base}/review`,
    },
    {
      label: "Pipelines active",
      value:
        metrics?.pipelinesActive != null
          ? metrics.pipelinesActive.toLocaleString()
          : "—",
      href: `${base}/pipelines`,
    },
    {
      label: "Schemas",
      value:
        metrics?.schemaCount != null
          ? metrics.schemaCount.toLocaleString()
          : "—",
      href: `${base}`,
    },
  ];

  return (
    <div
      className="grid gap-px bg-border border border-border rounded-sm mb-9"
      style={{ gridTemplateColumns: "repeat(5, 1fr)" }}
    >
      {cards.map((m) => (
        <Link
          key={m.label}
          href={m.href}
          className="bg-cream px-4 py-4 flex flex-col gap-0.5 hover:bg-cream-2 transition-colors"
        >
          <span className="font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase text-ink-4">
            {m.label}
          </span>
          <span
            className="font-display text-[26px] font-medium text-ink leading-none tracking-tight"
            style={{ fontVariationSettings: "'opsz' 72, 'SOFT' 30" }}
          >
            {loading ? (
              <span className="inline-block w-12 h-5 bg-cream-2 rounded-sm animate-pulse" />
            ) : (
              <>
                {m.value}
                {m.unit && (
                  <span className="font-body text-xs font-normal text-ink-3 ml-1 tracking-normal">
                    {m.unit}
                  </span>
                )}
              </>
            )}
          </span>
        </Link>
      ))}
    </div>
  );
}

function isOnboardingComplete(o: OverviewOnboarding): boolean {
  return (
    o.schemaCreated &&
    o.documentUploaded &&
    o.extractionRun &&
    o.corpusEntries &&
    o.validateRun &&
    o.pipelineConfigured
  );
}

function OnboardingSection({
  onboarding,
  base,
}: {
  onboarding: OverviewOnboarding;
  base: string;
}) {
  return (
    <div className="mb-8 border border-border rounded-sm bg-cream-2/30 p-5">
      <div className="flex items-baseline justify-between pb-3 mb-2 border-b border-border">
        <h2
          className="font-display text-lg font-medium tracking-tight text-ink m-0"
          style={{ fontVariationSettings: "'opsz' 96, 'SOFT' 50" }}
        >
          Getting started
        </h2>
        <span className="font-mono text-[10.5px] tracking-[0.1em] uppercase text-ink-4">
          {completedCount(onboarding)} of 7
        </span>
      </div>
      <OnboardingChecklist onboarding={onboarding} base={base} />
    </div>
  );
}

function completedCount(o: OverviewOnboarding): number {
  let n = 1; // project created is always done
  if (o.schemaCreated) n++;
  if (o.documentUploaded) n++;
  if (o.extractionRun) n++;
  if (o.corpusEntries) n++;
  if (o.validateRun) n++;
  if (o.pipelineConfigured) n++;
  return n;
}

function ActivityPanel({
  loading,
  items,
  base,
}: {
  loading: boolean;
  items: OverviewActivity[];
  base: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between pb-2.5 border-b border-border">
        <h2
          className="font-display text-lg font-medium tracking-tight text-ink m-0"
          style={{ fontVariationSettings: "'opsz' 96, 'SOFT' 50" }}
        >
          Recent activity
        </h2>
        <span className="font-mono text-[11px] text-ink-4">view all →</span>
      </div>
      {loading ? (
        <div className="space-y-2">
          <div className="h-6 bg-cream-2 rounded-sm animate-pulse" />
          <div className="h-6 bg-cream-2 rounded-sm animate-pulse w-4/5" />
          <div className="h-6 bg-cream-2 rounded-sm animate-pulse w-5/6" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-[12.5px] text-ink-3 py-4">
          No activity yet.
        </p>
      ) : (
        <div className="flex flex-col">
          {items.map((a, i) => (
            <Link
              key={`${a.type}-${a.timestamp}-${i}`}
              href={`${base}${a.link}`}
              className="grid items-center gap-3.5 py-2 border-b border-dotted border-border last:border-none text-[12.5px] hover:bg-cream-2/50 transition-colors px-2 -mx-2 rounded-sm"
              style={{ gridTemplateColumns: "auto 1fr auto auto" }}
            >
              <span className="font-mono text-[11px] text-ink-4 min-w-[4.5rem]">
                {relativeTime(a.timestamp)}
              </span>
              <span className="text-ink-2 min-w-0 truncate">
                {a.description}
              </span>
              <span className="font-mono text-[11px] text-ink-4 whitespace-nowrap">
                {a.meta ?? ""}
              </span>
              <span
                className={`font-mono text-[11px] px-1.5 py-0.5 rounded-sm ${
                  a.status === "warn"
                    ? "bg-vermillion/10 text-vermillion-2"
                    : a.status === "pending"
                      ? "bg-cream-2 text-ink-3"
                      : "bg-green/10 text-green"
                }`}
              >
                {a.status === "warn" ? "⚠" : a.status === "pending" ? "…" : "✓"}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function OnboardingChecklist({
  onboarding,
  base,
}: {
  onboarding: OverviewOnboarding;
  base: string;
}) {
  const [showCreate, setShowCreate] = useState(false);
  const schemaSlug = onboarding.firstSchemaSlug;
  const hasSchema = onboarding.schemaCreated;

  // Steps reflect real data. Project-created is always done — the user is
  // looking at a project right now. Subsequent steps require a schema to
  // exist before their actions become meaningful, so actions for those
  // steps are disabled until a schema is created.
  const steps: Array<{
    done: boolean;
    label: string;
    actionLabel: string;
    onClick?: () => void;
    href?: string;
    disabled?: boolean;
  }> = [
    {
      done: true,
      label: "Project created",
      actionLabel: "",
    },
    {
      done: hasSchema,
      label: "Create your first schema",
      actionLabel: hasSchema ? "Edit schema →" : "Create schema →",
      onClick: hasSchema ? undefined : () => setShowCreate(true),
      href: hasSchema ? `${base}/schemas/${schemaSlug}/build` : undefined,
    },
    {
      done: onboarding.documentUploaded,
      label: "Upload a test document",
      actionLabel: "Go to Build →",
      href: schemaSlug ? `${base}/schemas/${schemaSlug}/build` : undefined,
      disabled: !schemaSlug,
    },
    {
      done: onboarding.extractionRun,
      label: "Run your first extraction",
      actionLabel: "Go to Build →",
      href: schemaSlug ? `${base}/schemas/${schemaSlug}/build` : undefined,
      disabled: !schemaSlug,
    },
    {
      done: onboarding.corpusEntries,
      label: "Add corpus entries",
      actionLabel: "Go to Corpus →",
      href: schemaSlug ? `${base}/schemas/${schemaSlug}/corpus` : undefined,
      disabled: !schemaSlug,
    },
    {
      done: onboarding.validateRun,
      label: "Run validate",
      actionLabel: "Go to Validate →",
      href: schemaSlug ? `${base}/schemas/${schemaSlug}/validate` : undefined,
      disabled: !schemaSlug,
    },
    {
      done: onboarding.pipelineConfigured,
      label: "Configure a pipeline",
      actionLabel: "Go to Pipelines →",
      href: `${base}/pipelines`,
    },
  ];

  return (
    <>
      <ul className="flex flex-col">
        {steps.map((s) => (
          <li
            key={s.label}
            className="grid items-center gap-3 py-2.5 border-b border-dotted border-border last:border-none"
            style={{ gridTemplateColumns: "auto 1fr auto" }}
          >
            <span
              className={`inline-flex items-center justify-center w-5 h-5 rounded-full shrink-0 ${
                s.done
                  ? "bg-green text-cream"
                  : "border border-ink-4/40 text-ink-4"
              }`}
              aria-hidden
            >
              {s.done ? <Check className="w-3 h-3" strokeWidth={3} /> : <Circle className="w-2 h-2 opacity-0" />}
            </span>
            <span
              className={`text-[12.5px] ${
                s.done ? "text-ink-3 line-through" : "text-ink-2"
              }`}
            >
              {s.label}
            </span>
            {s.actionLabel && !s.done && (
              s.disabled ? (
                <span className="font-mono text-[11px] text-ink-4/60 cursor-not-allowed">
                  {s.actionLabel}
                </span>
              ) : s.href ? (
                <Link
                  href={s.href}
                  className="font-mono text-[11px] text-vermillion-2 hover:text-ink transition-colors"
                >
                  {s.actionLabel}
                </Link>
              ) : s.onClick ? (
                <button
                  onClick={s.onClick}
                  className="font-mono text-[11px] text-vermillion-2 hover:text-ink transition-colors"
                >
                  {s.actionLabel}
                </button>
              ) : null
            )}
            {s.done && <span />}
          </li>
        ))}
      </ul>

      {showCreate && typeof document !== "undefined" &&
        createPortal(
          <CreateSchemaDialog
            onClose={() => setShowCreate(false)}
            onCreated={() => {
              setShowCreate(false);
              emit("schemas:updated");
            }}
            base={base}
          />,
          document.body,
        )}
    </>
  );
}

function CreateSchemaDialog({
  onClose,
  onCreated,
  base,
}: {
  onClose: () => void;
  onCreated: (slug: string) => void;
  base: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!slugTouched && name) {
    const auto = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .replace(/-+/g, "_");
    if (auto !== slug) setSlug(auto);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      await api.post("/api/schemas", {
        slug,
        display_name: name,
        description: description || undefined,
      });
      onCreated(slug);
      router.push(`${base}/schemas/${slug}/build`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create schema");
      setCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[420px] p-6">
        <h2 className="text-[15px] font-medium text-ink mb-1">Create schema</h2>
        <p className="text-[12.5px] text-ink-3 mb-5">
          Define a new extraction schema. You&rsquo;ll edit the YAML in build mode.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Name</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Insurance Claim"
              autoFocus
              data-1p-ignore
              autoComplete="off"
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Slug</label>
            <input
              required
              value={slug}
              onChange={(e) => { setSlugTouched(true); setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "")); }}
              data-1p-ignore
              autoComplete="off"
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
            />
            <p className="text-[11px] text-ink-4">Used in the URL and API. Lowercase, underscores.</p>
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">
              Description <span className="text-ink-4 font-normal">(optional)</span>
            </label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this schema extract?"
              data-1p-ignore
              autoComplete="off"
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
            />
          </div>

          {error && (
            <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">{error}</div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors">Cancel</button>
            <button
              type="submit"
              disabled={creating}
              className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50"
            >
              {creating ? "Creating..." : "Create schema"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AttentionPanel({
  loading,
  items,
  base,
  projectBase,
}: {
  loading: boolean;
  items: OverviewAttention[];
  base: string;
  projectBase: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between pb-2.5 border-b border-border">
        <h2
          className="font-display text-lg font-medium tracking-tight text-ink m-0"
          style={{ fontVariationSettings: "'opsz' 96, 'SOFT' 50" }}
        >
          Needs attention
        </h2>
      </div>
      {loading ? (
        <div className="space-y-2">
          <div className="h-16 bg-cream-2 rounded-sm animate-pulse" />
          <div className="h-16 bg-cream-2 rounded-sm animate-pulse" />
        </div>
      ) : items.length === 0 ? (
        <div className="px-4 py-3.5 bg-green/10 border-l-[3px] border-green rounded-r-sm">
          <div className="font-mono text-[10px] font-medium tracking-[0.1em] uppercase text-green mb-1">
            All clear
          </div>
          <p className="text-[12.5px] text-ink leading-[1.45] m-0">
            Nothing needs attention right now.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((a, i) => (
            <div
              key={`${a.kind}-${i}`}
              className={`px-4 py-3.5 bg-cream-2 border-l-[3px] rounded-r-sm ${
                a.severity === "warning"
                  ? "border-vermillion-2"
                  : "border-ink-4"
              }`}
            >
              <div
                className={`font-mono text-[10px] font-medium tracking-[0.1em] uppercase mb-1 ${
                  a.severity === "warning" ? "text-vermillion-2" : "text-ink-3"
                }`}
              >
                {a.kind}
              </div>
              <p className="text-[12.5px] text-ink leading-[1.45] m-0">
                {a.description}
              </p>
              <Link
                href={a.link === "/" ? projectBase : `${base}${a.link}`}
                className={`inline-block mt-2 font-mono text-[11px] transition-colors ${
                  a.severity === "warning"
                    ? "text-vermillion-2 hover:text-ink"
                    : "text-ink-3 hover:text-ink"
                }`}
              >
                {actionLabel(a.kind)} →
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function actionLabel(kind: string): string {
  switch (kind) {
    case "Review queue":
      return "open review";
    case "Failed jobs":
      return "view jobs";
    case "Validate regression":
      return "investigate";
    case "Unlinked pipeline":
      return "open pipelines";
    case "Schema needs corpus":
      return "open overview";
    default:
      return "open";
  }
}
