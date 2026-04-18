"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { KojiLogo } from "@/components/shell/KojiLogo";
import { PasswordInput } from "@/components/shared/PasswordInput";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";

export default function SetupPage() {
  const router = useRouter();
  const { data: status, loading: checking } = useApi(
    useCallback(() => api.get<{ needed: boolean; reason?: string }>("/api/setup/status"), []),
  );

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceSlug, setWorkspaceSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-generate slug from workspace name until the user edits it manually
  useEffect(() => {
    if (!slugTouched && workspaceName) {
      const auto = workspaceName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      setWorkspaceSlug(auto);
    }
  }, [workspaceName, slugTouched]);

  // Redirect away if setup isn't needed
  useEffect(() => {
    if (status && !status.needed) {
      router.replace("/");
    }
  }, [status, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (!workspaceSlug || workspaceSlug.length < 2) {
      setError("Workspace URL is required (at least 2 characters).");
      return;
    }

    setSubmitting(true);
    try {
      const result = await api.post<{ redirect: string }>("/api/setup", {
        name,
        email,
        password,
        workspace_name: workspaceName || workspaceSlug,
        workspace_slug: workspaceSlug,
      });
      router.push(result.redirect);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Setup failed.");
      setSubmitting(false);
    }
  }

  if (checking || (status && !status.needed)) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center">
        <div className="animate-pulse font-mono text-[11px] text-ink-4">Checking...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center px-4">
      <div className="w-full max-w-[400px]">
        {/* Brand */}
        <div className="flex flex-col items-center mb-8">
          <KojiLogo className="w-10 h-10 text-ink mb-3" />
          <h1
            className="font-display text-[28px] font-medium text-ink tracking-tight"
            style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 30" }}
          >
            Welcome to Koji
          </h1>
          <p className="text-[13.5px] text-ink-3 mt-1 text-center">
            Create your admin account to get started.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="border border-border rounded-sm bg-cream p-6 space-y-4">
          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Your name</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Smith"
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Email</label>
            <input
              required
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane@example.com"
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Password</label>
            <PasswordInput
              required
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 pr-8 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Confirm password</label>
            <PasswordInput
              required
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 pr-8 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
            />
          </div>

          <div className="border-t border-border pt-4 mt-2 space-y-4">
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">Workspace name</label>
              <input
                required
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                placeholder="Acme Insurance"
                className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">Workspace URL</label>
              <div className="flex items-center gap-0">
                <span className="h-[30px] inline-flex items-center px-2.5 bg-cream-2 border border-r-0 border-input rounded-l-sm text-[12px] text-ink-4 font-mono shrink-0">
                  koji /
                </span>
                <input
                  required
                  value={workspaceSlug}
                  onChange={(e) => {
                    setSlugTouched(true);
                    setWorkspaceSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
                  }}
                  placeholder="acme-insurance"
                  className="flex-1 h-[30px] rounded-r-sm rounded-l-none border border-input bg-transparent px-2.5 text-[13px] font-mono outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
                />
              </div>
              <p className="text-[11px] text-ink-4">Lowercase letters, numbers, and hyphens. This appears in your URL.</p>
            </div>
          </div>

          {error && (
            <div className="text-[12.5px] text-vermillion-2 bg-vermillion-3/50 px-3 py-2 rounded-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-sm text-[13px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50 mt-2"
          >
            {submitting ? (
              <>
                <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Creating account...
              </>
            ) : (
              "Create account & get started"
            )}
          </button>
        </form>

        <p className="text-center text-[11px] text-ink-4 mt-4">
          This creates the admin account for this Koji installation.
          <br />
          Additional team members can be invited from Settings → Members.
        </p>
      </div>
    </div>
  );
}
