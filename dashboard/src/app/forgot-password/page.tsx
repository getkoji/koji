"use client";

import { useState } from "react";
import { KojiLogo } from "@/components/shell/KojiLogo";
import { api } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await api.post("/api/auth/forgot-password", { email });
      setSent(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to send reset email.");
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
            Reset password
          </h1>
          <p className="text-[13.5px] text-ink-3 mt-1 text-center">
            Enter your email and we'll send you a reset link.
          </p>
        </div>

        {sent ? (
          <div className="border border-border rounded-sm bg-cream p-6 text-center">
            <div className="text-[13px] text-ink mb-2">Check your email</div>
            <p className="text-[12px] text-ink-3 mb-4">
              If an account with <span className="font-mono text-ink">{email}</span> exists, we've sent a password reset link. Check your inbox (or Mailpit at <span className="font-mono text-ink">localhost:8025</span> in dev).
            </p>
            <a href="/login" className="text-[12px] text-vermillion-2 hover:text-ink transition-colors">
              ← Back to sign in
            </a>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="border border-border rounded-sm bg-cream p-6 space-y-4">
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">Email</label>
              <input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
                className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
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
              {submitting ? "Sending..." : "Send reset link"}
            </button>

            <div className="text-center">
              <a href="/login" className="text-[12px] text-ink-3 hover:text-vermillion-2 transition-colors">
                ← Back to sign in
              </a>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
