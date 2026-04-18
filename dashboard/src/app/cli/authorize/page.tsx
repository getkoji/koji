"use client";

import { Suspense, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { KojiLogo } from "@/components/shell/KojiLogo";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";

export default function CliAuthorizePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-cream flex items-center justify-center">
          <div className="animate-pulse font-mono text-[11px] text-ink-4">Loading...</div>
        </div>
      }
    >
      <AuthorizeForm />
    </Suspense>
  );
}

interface TenantInfo {
  id: string;
  slug: string;
  displayName: string;
  roles: string[];
}

function AuthorizeForm() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callback");
  const state = searchParams.get("state");

  const [selectedTenant, setSelectedTenant] = useState<string>("");
  const [authorizing, setAuthorizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const { data: tenants, loading: tenantsLoading, error: tenantsError } = useApi(
    useCallback(() => api.get<{ data: TenantInfo[] }>("/api/tenants").then((r) => r.data), []),
  );

  // If not logged in, redirect to login and come back
  if (tenantsError && typeof window !== "undefined") {
    const returnUrl = window.location.href;
    window.location.href = `/login?return=${encodeURIComponent(returnUrl)}`;
    return null;
  }

  // Auto-select first tenant when loaded
  if (tenants && tenants.length > 0 && !selectedTenant) {
    setSelectedTenant(tenants[0].id);
  }

  if (!callbackUrl || !state) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center px-4">
        <div className="w-full max-w-[400px] text-center">
          <KojiLogo className="w-10 h-10 text-ink mx-auto mb-4" />
          <p className="text-[13px] text-ink-3">
            Invalid authorization request. Run <code className="font-mono text-ink">koji login</code> from
            your terminal to start the flow.
          </p>
        </div>
      </div>
    );
  }

  async function handleAuthorize() {
    if (!selectedTenant) return;
    setError(null);
    setAuthorizing(true);

    try {
      const result = await api.post<{ key: string }>("/api/cli/authorize", {
        tenant_id: selectedTenant,
      });

      // Redirect to the CLI's localhost callback with the key
      const redirect = `${callbackUrl}?key=${encodeURIComponent(result.key)}&state=${encodeURIComponent(state!)}`;
      setDone(true);
      window.location.href = redirect;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Authorization failed");
      setAuthorizing(false);
    }
  }

  if (done) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center px-4">
        <div className="w-full max-w-[400px] text-center">
          <KojiLogo className="w-10 h-10 text-ink mx-auto mb-4" />
          <h1 className="text-[18px] font-medium text-ink mb-2">CLI authorized</h1>
          <p className="text-[13px] text-ink-3">
            Redirecting back to your terminal. You can close this window.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center px-4">
      <div className="w-full max-w-[400px]">
        <div className="flex flex-col items-center mb-8">
          <KojiLogo className="w-10 h-10 text-ink mb-3" />
          <h1
            className="font-display text-[28px] font-medium text-ink tracking-tight"
            style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 30" }}
          >
            Authorize CLI
          </h1>
          <p className="text-[13.5px] text-ink-3 mt-1 text-center">
            The Koji CLI is requesting access to your account.
            This will create an API key for CLI use.
          </p>
        </div>

        <div className="border border-border rounded-sm bg-cream p-6 space-y-4">
          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Workspace</label>
            {tenantsLoading ? (
              <div className="h-[30px] rounded-sm bg-cream-2 animate-pulse" />
            ) : (
              <select
                value={selectedTenant}
                onChange={(e) => setSelectedTenant(e.target.value)}
                className="w-full h-[30px] rounded-sm border border-input bg-white px-2 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30"
              >
                {(tenants ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.displayName}
                  </option>
                ))}
              </select>
            )}
            <p className="text-[11px] text-ink-4">
              The CLI will have access to this workspace's resources.
            </p>
          </div>

          <div className="border border-border rounded-sm p-3 bg-cream-2/50">
            <div className="font-mono text-[10px] font-medium tracking-[0.08em] uppercase text-ink-4 mb-1.5">
              Permissions
            </div>
            <ul className="text-[12px] text-ink-3 space-y-1">
              <li>Read and write schemas, jobs, and pipelines</li>
              <li>Run extractions and access the playground</li>
              <li>Manage project settings and API keys</li>
            </ul>
          </div>

          {error && (
            <div className="text-[12.5px] text-vermillion-2 bg-vermillion-3/50 px-3 py-2 rounded-sm">
              {error}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={handleAuthorize}
              disabled={authorizing || !selectedTenant}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-sm text-[13px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50"
            >
              {authorizing ? "Authorizing..." : "Authorize CLI"}
            </button>
            <button
              onClick={() => window.close()}
              className="inline-flex items-center justify-center px-3.5 py-2.5 rounded-sm text-[13px] text-ink-3 hover:text-ink transition-colors"
            >
              Deny
            </button>
          </div>
        </div>

        <p className="text-center text-[11px] text-ink-4 mt-4">
          The API key will be stored locally on your machine at <code className="font-mono">~/.koji/credentials</code>
        </p>
      </div>
    </div>
  );
}
