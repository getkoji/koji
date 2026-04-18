"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { KojiLogo } from "@/components/shell/KojiLogo";
import { api } from "@/lib/api";

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-cream flex items-center justify-center">
        <div className="animate-pulse font-mono text-[11px] text-ink-4">Loading...</div>
      </div>
    }>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setSubmitting(true);
    try {
      await api.post("/api/auth/reset-password", {
        token,
        new_password: newPassword,
      });
      setDone(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Reset failed.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center px-4">
        <div className="w-full max-w-[360px] text-center">
          <KojiLogo className="w-10 h-10 text-ink mx-auto mb-4" />
          <p className="text-[13px] text-ink-3">Invalid reset link — no token provided.</p>
          <a href="/forgot-password" className="text-[12px] text-vermillion-2 hover:text-ink transition-colors mt-2 inline-block">
            Request a new reset link
          </a>
        </div>
      </div>
    );
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
            Set new password
          </h1>
        </div>

        {done ? (
          <div className="border border-border rounded-sm bg-cream p-6 text-center">
            <div className="text-[13px] text-ink mb-2">Password updated</div>
            <p className="text-[12px] text-ink-3 mb-4">
              Your password has been changed. You can now sign in with your new password.
            </p>
            <a
              href="/login"
              className="inline-flex items-center justify-center px-3.5 py-2.5 rounded-sm text-[13px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors"
            >
              Sign in
            </a>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="border border-border rounded-sm bg-cream p-6 space-y-4">
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">New password</label>
              <input
                required
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="At least 8 characters"
                autoFocus
                className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">Confirm new password</label>
              <input
                required
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30"
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
              {submitting ? "Updating..." : "Set new password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
