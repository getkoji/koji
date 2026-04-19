"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { KojiLogo } from "@/components/shell/KojiLogo";
import { PasswordInput } from "@/components/shared/PasswordInput";
import { api } from "@/lib/api";

export default function AcceptInvitePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-cream flex items-center justify-center">
          <div className="animate-pulse font-mono text-[11px] text-ink-4">Loading...</div>
        </div>
      }
    >
      <AcceptInviteForm />
    </Suspense>
  );
}

function AcceptInviteForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token") ?? "";

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!token) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center px-4">
        <div className="w-full max-w-[360px] text-center">
          <KojiLogo className="w-10 h-10 text-ink mx-auto mb-4" />
          <p className="text-[13px] text-ink-3">Invalid invite link — no token provided.</p>
        </div>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const result = await api.post<{ ok: boolean; redirect?: string; message?: string }>(
        "/api/invites/accept",
        { token, name: name || undefined, password: password || undefined },
      );
      if (result.redirect) {
        router.push(result.redirect);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to accept invite.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center px-4">
      <div className="w-full max-w-[360px]">
        <div className="flex flex-col items-center mb-8">
          <KojiLogo className="w-10 h-10 text-ink mb-3" />
          <h1
            className="font-display text-[28px] font-medium text-ink tracking-tight"
            style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 30" }}
          >
            Join workspace
          </h1>
          <p className="text-[13.5px] text-ink-3 mt-1 text-center">
            You've been invited to a Koji workspace. Set up your account to get started.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="border border-border rounded-sm bg-cream p-6 space-y-4">
          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Your name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Smith"
              autoFocus
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Password</label>
            <PasswordInput
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 pr-8 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
            />
            <p className="text-[11px] text-ink-4">
              If you already have a Koji account, leave this blank.
            </p>
          </div>

          {error && (
            <div className="text-[12.5px] text-vermillion-2 bg-vermillion-3/50 px-3 py-2 rounded-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-sm text-[13px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50"
          >
            {submitting ? "Joining..." : "Accept & join workspace"}
          </button>
        </form>

        <div className="text-center mt-4">
          <a href="/login" className="text-[12px] text-ink-3 hover:text-vermillion-2 transition-colors">
            Already have an account? Sign in
          </a>
        </div>
      </div>
    </div>
  );
}
