"use client";

import { useState, useCallback, useRef, useEffect } from "react";
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
import { usePageTitle } from "@/lib/use-page-title";

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
  wifConfigured: boolean;
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
  // Whether the provider exposes a user-selectable model/processor. Mistral and
  // Azure pick a real model (mistral-ocr-latest, prebuilt-layout). Google
  // identifies the processor via the separate Processor ID field, and Textract
  // has no model concept — for those the generic `model` field is vestigial and
  // hidden from the Add dialog.
  usesModelField: boolean;
  fields: Array<"base_url" | "region" | "project_id" | "processor_id" | "aws_access_key_id">;
  keyLabel: string;
  keyKind: "api_key" | "aws_secret_access_key";
  keyPlaceholder: string;
  /**
   * GCP-capable provider: render the auth-method selector (keyless WIF /
   * access token / service-account JSON) instead of a single secret field.
   */
  gcpAuth?: boolean;
}

/**
 * The running deployment's OIDC identity — the issuer / audience / subject a
 * customer must trust in their GCP Workload Identity Pool. Sourced live from
 * `GET /api/parse-providers/wif-identity` (decoded from the deployment's own
 * workload OIDC token, or self-host env overrides) — never hardcoded.
 */
interface WifIdentity {
  available: boolean;
  source: "vercel-oidc" | "configured" | "none";
  issuer: string | null;
  audience: string | null;
  subject: string | null;
}

/** Deep link to the keyless-WIF setup guide on the docs site. */
const WIF_GUIDE_URL =
  "https://docs.getkoji.dev/deployments/parse/#step-by-step-set-up-keyless-wif-self-serve";

/**
 * Pre-filled `external_account` template the user pastes into the credential
 * config. Deliberately carries **no `credential_source`** — the workload OIDC
 * token source is auto-detected by Koji's runtime (see the guide). Placeholders
 * (PROJECT_NUMBER / POOL_ID / PROVIDER_ID / SA_EMAIL) are GCP-side values the
 * user fills in after creating their pool.
 */
const WIF_EXTERNAL_ACCOUNT_TEMPLATE = `{
  "type": "external_account",
  "audience": "//iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/providers/PROVIDER_ID",
  "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
  "token_url": "https://sts.googleapis.com/v1/token",
  "service_account_impersonation_url": "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/SA_EMAIL:generateAccessToken"
}`;

/**
 * Auth methods for GCP-capable providers (Google Document AI). WIF is the
 * default and recommended path: keyless, no service-account key, the one that
 * survives enterprise org policies that block SA-key creation.
 */
type GcpAuthMethod = "wif" | "token" | "sa-json";

const GCP_AUTH_METHODS: Array<{ value: GcpAuthMethod; label: string; blurb: string }> = [
  {
    value: "wif",
    label: "Workload Identity Federation (keyless) — recommended",
    blurb:
      "No service-account key. Koji's workload federates into your GCP project and mints short-lived tokens automatically — the enterprise / production path, and the only option when your org blocks SA-key creation.",
  },
  {
    value: "token",
    label: "Access token (dev / testing)",
    blurb:
      "Paste a short-lived OAuth access token (~1h). Fine for a quick test; it expires fast, so it's not for production.",
  },
  {
    value: "sa-json",
    label: "Service-account JSON (self-host fallback)",
    blurb:
      "Paste a downloaded service-account key. Many enterprise org policies block SA-key creation — use WIF for those.",
  },
];

const PROVIDER_TYPES: ProviderDef[] = [
  {
    value: "mistral-ocr",
    label: "Mistral OCR",
    blurb: "Markdown-native OCR. Self-serve key, cheap per page. Good SMB default.",
    defaultModel: "mistral-ocr-latest",
    usesModelField: true,
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
    usesModelField: true,
    fields: ["base_url"],
    keyLabel: "API key",
    keyKind: "api_key",
    keyPlaceholder: "Azure resource key",
  },
  {
    value: "google-docai",
    label: "Google Document AI",
    blurb: "Document AI processor → structured chunks. Uses your GCP project. Keyless (WIF) by default.",
    defaultModel: "documentai",
    usesModelField: false,
    fields: ["project_id", "processor_id", "region"],
    gcpAuth: true,
    // Used by the rotate dialog (only key-based endpoints rotate). The Add
    // dialog uses the auth-method selector instead of this single field.
    keyLabel: "Access token / service-account JSON",
    keyKind: "api_key",
    keyPlaceholder: "Access token (~1h) or service-account JSON",
  },
  {
    value: "textract",
    label: "AWS Textract",
    blurb: "Textract → structured chunks. Runs under your existing AWS account.",
    defaultModel: "textract",
    usesModelField: false,
    fields: ["region", "aws_access_key_id"],
    keyLabel: "Secret access key",
    keyKind: "aws_secret_access_key",
    keyPlaceholder: "40-char secret",
  },
];

// Alphabetical by label so the dropdown order implies no preference between
// vendors, and stays alphabetical as providers are added.
const PROVIDER_TYPES_SORTED: ProviderDef[] = [...PROVIDER_TYPES].sort((a, b) =>
  a.label.localeCompare(b.label),
);

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
  usePageTitle("Parse Providers");
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
          {ep.wifConfigured ? (
            <Badge>keyless · WIF</Badge>
          ) : (
            ep.keyHint && <Meta>••••{ep.keyHint}</Meta>
          )}
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
            {!ep.wifConfigured && (
              <button
                onClick={onRotate}
                className="font-mono text-[10px] text-ink-3 hover:text-ink transition-colors"
              >
                rotate key
              </button>
            )}
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

// ── WIF trust panel ──────────────────────────────────────────────────────────

/** Small copy-to-clipboard button with transient "Copied" feedback. */
function CopyButton({ value, label = "copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="font-mono text-[10px] text-ink-3 hover:text-ink transition-colors flex-shrink-0"
    >
      {copied ? "copied" : label}
    </button>
  );
}

/** One labelled trust value with a monospace display + copy button. */
function TrustValueRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-ink">{label}</span>
        {value && <CopyButton value={value} />}
      </div>
      <code className="block font-mono text-[11px] text-ink-2 bg-cream border border-border rounded-sm px-2 py-1 break-all select-all">
        {value ?? "—"}
      </code>
    </div>
  );
}

/**
 * Surfaces the issuer / audience / subject the customer must trust in their GCP
 * Workload Identity Pool, fetched live from the deployment (never hardcoded),
 * plus a link to the setup guide and a copyable `external_account` template.
 * This is what makes keyless WIF self-serve — the customer reads exactly what to
 * trust straight from the form.
 */
function WifTrustPanel({ onUseTemplate }: { onUseTemplate: (template: string) => void }) {
  const { data: identity, loading } = useApi(
    useCallback(() => api.get<WifIdentity>("/api/parse-providers/wif-identity"), []),
  );

  return (
    <div className="rounded-sm border border-input bg-cream-2 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12.5px] font-medium text-ink">What to trust in GCP</span>
        <a
          href={WIF_GUIDE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-[10px] text-ink-3 hover:text-ink underline transition-colors flex-shrink-0"
        >
          setup guide ↗
        </a>
      </div>
      <p className="text-[11px] text-ink-4">
        Create a Workload Identity Pool + OIDC provider in your GCP project that trusts these exact
        values from Koji&apos;s running deployment. Pin the subject in the provider&apos;s attribute
        condition so only Koji can federate.
      </p>

      {loading ? (
        <div className="animate-pulse font-mono text-[11px] text-ink-4 py-2">
          Loading trust values...
        </div>
      ) : identity?.available ? (
        <div className="space-y-2.5">
          <TrustValueRow label="Issuer (--issuer-uri)" value={identity.issuer} />
          <TrustValueRow label="Audience (--allowed-audiences)" value={identity.audience} />
          <TrustValueRow label="Subject (attribute condition)" value={identity.subject} />
        </div>
      ) : (
        <p className="text-[11px] text-vermillion-2">
          Koji can&apos;t resolve its OIDC identity in this environment. On a self-hosted deployment,
          set <span className="font-mono">KOJI_WIF_ISSUER</span>,{" "}
          <span className="font-mono">KOJI_WIF_AUDIENCE</span>, and{" "}
          <span className="font-mono">KOJI_WIF_SUBJECT</span>, or read the claims from a sample of
          your deployment&apos;s OIDC token. See the setup guide.
        </p>
      )}

      <div className="pt-1 border-t border-border space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-ink">
            Credential config template (no credential_source — auto-detected)
          </span>
          <div className="flex items-center gap-3 flex-shrink-0">
            <button
              type="button"
              onClick={() => onUseTemplate(WIF_EXTERNAL_ACCOUNT_TEMPLATE)}
              className="font-mono text-[10px] text-ink-3 hover:text-ink transition-colors"
            >
              use template
            </button>
            <CopyButton value={WIF_EXTERNAL_ACCOUNT_TEMPLATE} />
          </div>
        </div>
        <p className="text-[11px] text-ink-4">
          Fill <span className="font-mono">PROJECT_NUMBER</span> /{" "}
          <span className="font-mono">POOL_ID</span> / <span className="font-mono">PROVIDER_ID</span>{" "}
          (the pool you create) and <span className="font-mono">SA_EMAIL</span> (the SA Koji
          impersonates). This <span className="font-mono">audience</span> is the WIF provider resource
          name, not the OIDC token audience above.
        </p>
      </div>
    </div>
  );
}

// ── Add provider dialog (branching step wizard) ──────────────────────────────

function inputCls(): string {
  return "w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4";
}

// The wizard splits the (previously one long scrolling) Add form into steps.
// The field set, state bindings, per-provider visibility, and submit payload are
// unchanged — only the layout is paginated. The Authentication step now branches
// into method-specific sub-steps so the (tall) keyless-WIF flow isn't crammed
// onto one scrolly page:
//
//   Provider → Configuration → Authentication (method picker) → …
//     WIF        → Trust setup → Credentials      (5 steps total)
//     Access token → Access token                 (4 steps total)
//     Service-account JSON → Service account      (4 steps total)
//     non-GCP providers → single secret field on the Authentication step (3)
//
// The step list is derived from the provider + selected auth method, so the
// indicator and Next/Back navigation always reflect the actual path.
type StepId =
  | "provider"
  | "config"
  | "auth-method"
  | "wif-trust"
  | "wif-config"
  | "token"
  | "sa-json"
  | "secret";

interface StepDef {
  id: StepId;
  // `label` is the full, descriptive name — used for screen readers (sr-only +
  // aria-label). `short` is the abbreviated text shown visually so the 5-step
  // (WIF) path fits on one line in the 480px dialog.
  label: string;
  short: string;
}

function buildSteps(def: ProviderDef, authMethod: GcpAuthMethod): StepDef[] {
  const steps: StepDef[] = [
    { id: "provider", label: "Provider", short: "Provider" },
    { id: "config", label: "Configuration", short: "Config" },
  ];
  if (!def.gcpAuth) {
    // Non-GCP providers authenticate with a single secret — no method picker, no
    // branching. Authentication stays a single (3rd) step, exactly as before.
    steps.push({ id: "secret", label: "Authentication", short: "Auth" });
    return steps;
  }
  // GCP-capable providers: pick a method, then branch into its sub-step(s).
  steps.push({ id: "auth-method", label: "Authentication", short: "Auth" });
  if (authMethod === "wif") {
    steps.push({ id: "wif-trust", label: "Trust setup", short: "Trust" });
    steps.push({ id: "wif-config", label: "Credentials", short: "Creds" });
  } else if (authMethod === "token") {
    steps.push({ id: "token", label: "Access token", short: "Token" });
  } else {
    steps.push({ id: "sa-json", label: "Service account", short: "Service" });
  }
  return steps;
}

function StepIndicator({ steps, current }: { steps: StepDef[]; current: number }) {
  return (
    <ol
      className="flex flex-wrap items-center gap-x-1 gap-y-1.5"
      aria-label="Add provider progress"
    >
      {steps.map((s, i) => {
        const active = i === current;
        const done = i < current;
        return (
          <li
            key={s.id}
            className="flex items-center gap-1"
            aria-current={active ? "step" : undefined}
          >
            <span
              className={`flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full text-[10px] font-medium transition-colors ${
                active
                  ? "bg-ink text-cream"
                  : done
                    ? "bg-ink/15 text-ink"
                    : "bg-cream-2 text-ink-4 border border-border"
              }`}
            >
              {i + 1}
            </span>
            {/* Visible text is abbreviated to keep all 5 steps on one line; the
                full step name is exposed to screen readers via aria-label +
                sr-only so accessibility is unchanged. */}
            <span
              className={`text-[11px] transition-colors ${active ? "text-ink font-medium" : "text-ink-4"}`}
              aria-label={s.label}
            >
              <span aria-hidden="true">{s.short}</span>
              <span className="sr-only">{s.label}</span>
            </span>
            {i < steps.length - 1 && (
              <span className="h-px w-3 bg-border" aria-hidden="true" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function AddParseProviderDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const [providerType, setProviderType] = useState(PROVIDER_TYPES_SORTED[0]!.value);
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [region, setRegion] = useState("");
  const [projectId, setProjectId] = useState("");
  const [processorId, setProcessorId] = useState("");
  const [awsAccessKeyId, setAwsAccessKeyId] = useState("");
  const [secret, setSecret] = useState("");
  // GCP auth-method state (only used when def.gcpAuth).
  const [authMethod, setAuthMethod] = useState<GcpAuthMethod>("wif");
  const [externalAccount, setExternalAccount] = useState("");
  const [impersonateSa, setImpersonateSa] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The dialog is mounted only while showAdd is true (see ParseProvidersPage),
  // so step state resets to 0 (Provider) every time the dialog reopens.
  const [stepIdx, setStepIdx] = useState(0);

  const def = PROVIDER_TYPES.find((p) => p.value === providerType)!;

  // The active path is derived from the provider + selected auth method. Clamp
  // the index so a path that shrank (e.g. switching off WIF's 2 sub-steps) can
  // never strand the user past the last step.
  const steps = buildSteps(def, authMethod);
  const stepIndex = Math.min(stepIdx, steps.length - 1);
  const currentStep = steps[stepIndex]!;
  const isLastStep = stepIndex === steps.length - 1;

  // Move focus to the first field of the active step whenever the step changes
  // (and on first open). Radix's own autofocus is suppressed via
  // onOpenAutoFocus so we own focus management here — keyboard users land on the
  // right control as they page through. Steps with no focusable field (the WIF
  // trust panel is informational) fall back to the step container so focus still
  // moves into the new step for screen-reader users.
  const stepRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stepRef.current?.querySelector<HTMLElement>(
      "input:not([type=hidden]), select, textarea, [tabindex]",
    );
    if (el) el.focus();
    else stepRef.current?.focus();
  }, [stepIndex]);

  function handleProviderChange(value: string) {
    setProviderType(value);
    setModel("");
    setBaseUrl("");
    setRegion("");
    setProjectId("");
    setProcessorId("");
    setAwsAccessKeyId("");
    setSecret("");
    setAuthMethod("wif");
    setExternalAccount("");
    setImpersonateSa("");
    setError(null);
  }

  // Parse + validate the WIF external_account config. Shared by the wif-config
  // step validation and the final submit so the rules stay in one place.
  function parseExternalAccount(): { error: string } | { value: unknown } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(externalAccount);
    } catch {
      return {
        error:
          "The credential config isn't valid JSON. Paste the full output of `gcloud iam workload-identity-pools create-cred-config`.",
      };
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as Record<string, unknown>).type !== "external_account"
    ) {
      return {
        error:
          'The credential config must be a Google external_account config (its "type" field should be "external_account").',
      };
    }
    return { value: parsed };
  }

  // Per-step validation: returns an inline error message for the given step, or
  // null if the required fields on that step are satisfied. Mirrors the
  // `required` attributes the single-form version relied on. Keyed by step id so
  // the rules stay tied to the step regardless of where it lands in the path.
  function validateStep(id: StepId): string | null {
    switch (id) {
      case "provider":
        if (!name.trim()) return "Enter a display name for this endpoint.";
        return null;
      case "config":
        if (
          def.fields.includes("base_url") &&
          providerType === "azure-document-intel" &&
          !baseUrl.trim()
        )
          return "Enter the Azure endpoint / base URL.";
        if (def.fields.includes("project_id") && !projectId.trim())
          return "Enter your GCP project ID.";
        if (def.fields.includes("processor_id") && !processorId.trim())
          return "Enter the Processor ID.";
        if (def.fields.includes("region") && providerType === "textract" && !region.trim())
          return "Enter the AWS region.";
        if (def.fields.includes("aws_access_key_id") && !awsAccessKeyId.trim())
          return "Enter the access key ID.";
        return null;
      case "auth-method":
        // A method is always selected (WIF by default); nothing to validate.
        return null;
      case "wif-trust":
        // Informational step — the trust values + template are read-only guidance.
        return null;
      case "wif-config": {
        if (!externalAccount.trim()) return "Paste your external_account credential config.";
        const r = parseExternalAccount();
        if ("error" in r) return r.error;
        return null;
      }
      case "token":
        if (!secret) return "Enter the access token.";
        return null;
      case "sa-json":
        if (!secret) return "Enter the service-account JSON.";
        return null;
      case "secret":
        if (!secret) return `Enter the ${def.keyLabel.toLowerCase()}.`;
        return null;
    }
  }

  async function doCreate() {
    setError(null);
    setCreating(true);
    try {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        provider: providerType,
        // Only providers that expose a user-selectable model send one. For the
        // rest (Google Doc AI, Textract) the model field is vestigial, so we
        // send the provider's default identifier and never a user value.
        model: def.usesModelField ? model.trim() || undefined : def.defaultModel,
      };
      if (def.fields.includes("base_url")) payload.base_url = baseUrl.trim() || undefined;
      if (def.fields.includes("region")) payload.region = region.trim() || undefined;
      if (def.fields.includes("project_id")) payload.project_id = projectId.trim() || undefined;
      if (def.fields.includes("processor_id")) payload.processor_id = processorId.trim() || undefined;
      if (def.fields.includes("aws_access_key_id"))
        payload.aws_access_key_id = awsAccessKeyId.trim() || undefined;

      if (def.gcpAuth) {
        // GCP providers pick an auth method. WIF is keyless (config only, no
        // stored secret); token / sa-json reuse the api_key path.
        if (authMethod === "wif") {
          const r = parseExternalAccount();
          if ("error" in r) {
            setError(r.error);
            setCreating(false);
            return;
          }
          payload.wif = {
            external_account: r.value,
            impersonate_service_account: impersonateSa.trim() || undefined,
          };
        } else {
          payload.api_key = secret || undefined;
        }
      } else {
        payload[def.keyKind] = secret || undefined;
      }

      await api.post("/api/parse-providers", payload);
      onCreated(name.trim());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to add parse endpoint");
      setCreating(false);
    }
  }

  // Single submit handler so Enter behaves: on every step but the last it
  // validates and advances (never submits); only on the final sub-step of the
  // active path does it create the endpoint.
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const err = validateStep(currentStep.id);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    if (!isLastStep) {
      setStepIdx(stepIndex + 1);
      return;
    }
    void doCreate();
  }

  function handleBack() {
    setError(null);
    setStepIdx(Math.max(0, stepIndex - 1));
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

        <div className="pb-1">
          <StepIndicator steps={steps} current={stepIndex} />
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Step content. Only the active step is mounted; field state lives on
              the dialog, so paging between steps preserves every value. The
              container is focusable (tabIndex -1) as a focus fallback for steps
              with no input (the WIF trust panel). */}
          <div ref={stepRef} tabIndex={-1} className="space-y-4 outline-none">
            {currentStep.id === "provider" && (
              <>
                <div className="space-y-1.5">
                  <label className="text-[12.5px] font-medium text-ink">Provider</label>
                  <select
                    value={providerType}
                    onChange={(e) => handleProviderChange(e.target.value)}
                    className="w-full h-[30px] rounded-sm border border-input bg-white px-2 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30"
                  >
                    {PROVIDER_TYPES_SORTED.map((p) => (
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
                    className={inputCls()}
                  />
                </div>
              </>
            )}

            {currentStep.id === "config" && (
              <>
                {def.usesModelField && (
                  <div className="space-y-1.5">
                    <label className="text-[12.5px] font-medium text-ink">Model / processor</label>
                    <input
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder={def.defaultModel}
                      className={`${inputCls()} font-mono`}
                    />
                    <p className="text-[11px] text-ink-4">
                      Defaults to {def.defaultModel} if left blank.
                    </p>
                  </div>
                )}

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

                {/* Providers with no dedicated config fields still get a step-2
                    hint so the wizard never shows an empty page. */}
                {!def.usesModelField && def.fields.length === 0 && (
                  <p className="text-[12px] text-ink-3">
                    {def.label} needs no extra configuration. Continue to authentication.
                  </p>
                )}
              </>
            )}

            {/* GCP providers: Authentication is just the method picker; each
                method then branches into its own sub-step(s) below. */}
            {currentStep.id === "auth-method" && (
              <div className="space-y-2.5">
                <label className="text-[12.5px] font-medium text-ink">Authentication</label>
                <div className="space-y-1.5">
                  {GCP_AUTH_METHODS.map((m) => (
                    <label
                      key={m.value}
                      className={`flex items-start gap-2.5 cursor-pointer rounded-sm border px-2.5 py-2 transition-colors ${
                        authMethod === m.value
                          ? "border-ring bg-cream-2"
                          : "border-input hover:border-ink-4"
                      }`}
                    >
                      <input
                        type="radio"
                        name="gcp-auth-method"
                        value={m.value}
                        checked={authMethod === m.value}
                        onChange={() => setAuthMethod(m.value)}
                        className="mt-0.5 flex-shrink-0"
                      />
                      <span className="min-w-0">
                        <span className="block text-[12.5px] text-ink">{m.label}</span>
                        <span className="block text-[11px] text-ink-4 mt-0.5">{m.blurb}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* WIF sub-step 1: what to trust in GCP (values + copy + template). */}
            {currentStep.id === "wif-trust" && (
              <div className="space-y-2.5">
                <label className="text-[12.5px] font-medium text-ink">Trust setup</label>
                <p className="text-[11px] text-ink-4">
                  Set up a Workload Identity Pool in your GCP project that trusts Koji&apos;s running
                  deployment, then continue to paste the credential config. Use the template below as a
                  starting point.
                </p>
                <WifTrustPanel onUseTemplate={setExternalAccount} />
              </div>
            )}

            {/* WIF sub-step 2: paste the external_account config + impersonate SA. */}
            {currentStep.id === "wif-config" && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className="text-[12.5px] font-medium text-ink">
                    Credential config (external_account JSON) *
                  </label>
                  <textarea
                    required
                    value={externalAccount}
                    onChange={(e) => setExternalAccount(e.target.value)}
                    rows={6}
                    placeholder={'{\n  "type": "external_account",\n  "audience": "//iam.googleapis.com/projects/...",\n  ...\n}'}
                    className="w-full rounded-sm border border-input bg-transparent px-2.5 py-2 text-[12px] font-mono leading-snug outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4 resize-y"
                  />
                  <p className="text-[11px] text-ink-4">
                    Paste the JSON from{" "}
                    <span className="font-mono">
                      gcloud iam workload-identity-pools create-cred-config
                    </span>
                    . Keyless — it references your workload&apos;s OIDC identity, not a downloaded
                    secret. Nothing here is stored as a credential.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[12.5px] font-medium text-ink">
                    Impersonation service account
                  </label>
                  <input
                    value={impersonateSa}
                    onChange={(e) => setImpersonateSa(e.target.value)}
                    placeholder="docai@my-project.iam.gserviceaccount.com"
                    autoComplete="off"
                    className={`${inputCls()} font-mono`}
                  />
                  <p className="text-[11px] text-ink-4">
                    The service account Koji impersonates to call Document AI. Optional if your
                    credential config already includes an impersonation URL.
                  </p>
                </div>
              </div>
            )}

            {/* Access token / service-account JSON: single paste sub-step. */}
            {(currentStep.id === "token" || currentStep.id === "sa-json") && (
              <div className="space-y-1.5">
                <label className="text-[12.5px] font-medium text-ink">
                  {authMethod === "token" ? "Access token" : "Service-account JSON"} *
                </label>
                <PasswordInput
                  required
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={
                    authMethod === "token"
                      ? "Short-lived OAuth access token (~1h)"
                      : "Paste the service-account JSON key"
                  }
                  autoComplete="off"
                  className={`${inputCls()} pr-8 font-mono`}
                />
                <p className="text-[11px] text-ink-4">
                  {authMethod === "token"
                    ? "Encrypted at rest. Expires in ~1 hour — for dev / testing, not production."
                    : "Encrypted at rest. Cannot be retrieved — only rotated. Prefer WIF where SA-key creation is blocked."}
                </p>
              </div>
            )}

            {/* Non-GCP providers: single secret field. */}
            {currentStep.id === "secret" && (
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
                <p className="text-[11px] text-ink-4">
                  Encrypted at rest. Cannot be retrieved — only rotated.
                </p>
              </div>
            )}
          </div>

          {error && (
            <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            <div>
              {stepIndex > 0 && (
                <button
                  type="button"
                  onClick={handleBack}
                  disabled={creating}
                  className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors disabled:opacity-50"
                >
                  Back
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors"
              >
                Cancel
              </button>
              {!isLastStep ? (
                <button
                  type="submit"
                  className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors"
                >
                  Next
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={creating}
                  className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50"
                >
                  {creating ? "Adding..." : "Add provider"}
                </button>
              )}
            </div>
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
