"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { KojiLogo } from "@/components/shell/KojiLogo";
import { PasswordInput } from "@/components/shared/PasswordInput";
import { api } from "@/lib/api";

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-cream flex items-center justify-center">
          <div className="animate-pulse font-mono text-[11px] text-ink-4">Loading...</div>
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnUrl = searchParams.get("return");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const result = await api.post<{ redirect: string }>("/api/auth/login", {
        email,
        password,
      });
      // If we have a return URL (e.g. from CLI auth), go there instead
      router.push(returnUrl ?? result.redirect);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Login failed.");
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
            Sign in
          </h1>
        </div>

        <form onSubmit={handleSubmit} className="border border-border rounded-sm bg-cream p-6 space-y-4">
          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Email</label>
            <input
              required
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] font-medium text-ink">Password</label>
            <PasswordInput
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 pr-8 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
            />
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
            {submitting ? (
              <>
                <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Signing in...
              </>
            ) : (
              "Sign in"
            )}
          </button>
        </form>

        <div className="text-center mt-4">
          <a href="/forgot-password" className="text-[12px] text-ink-3 hover:text-vermillion-2 transition-colors">
            Forgot your password?
          </a>
        </div>
      </div>
    </div>
  );
}
