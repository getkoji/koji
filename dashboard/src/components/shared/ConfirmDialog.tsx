"use client";

import { useState } from "react";

/**
 * Styled in-app confirmation dialog for destructive or irreversible actions.
 * Use this instead of window.confirm — never trigger a native browser dialog.
 *
 * Render it conditionally; the caller owns the open/closed state:
 *
 *   {confirm && (
 *     <ConfirmDialog
 *       title="Delete document"
 *       description="Remove this document from the corpus?"
 *       confirmLabel="Delete"
 *       onConfirm={async () => { await api.delete(...); }}
 *       onCancel={() => setConfirm(null)}
 *     />
 *   )}
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setError(null);
    setLoading(true);
    try {
      await onConfirm();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onCancel} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[380px] p-6">
        <h2 className="text-[15px] font-medium text-ink mb-1">{title}</h2>
        <p className="text-[12.5px] text-ink-3 mb-5">{description}</p>

        {error && (
          <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm mb-4">{error}</div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading}
            className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-vermillion-2 text-cream hover:bg-vermillion transition-colors disabled:opacity-50"
          >
            {loading ? "Working..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
