"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useApi } from "@/lib/use-api";

/** Resource types the move endpoint accepts (mirrors MovableType on the API). */
export type MovableType =
  | "schema"
  | "pipeline"
  | "source"
  | "classifier"
  | "model_endpoint"
  | "parse_endpoint"
  | "webhook_target"
  | "api_key";

interface Blocker {
  type: string;
  slug: string;
  reason: string;
}

/**
 * Move a project-scoped resource into another project. Previews blockers with
 * a dry run before enabling the confirm, so the user sees *why* a move can't
 * proceed (a referenced resource in another project) instead of a bare error.
 *
 * Self-contained portal dialog (not @koji/ui Dialog) — matches the other
 * dialogs on these pages and sidesteps the Combobox-in-Dialog quirks.
 */
export function MoveToProjectDialog({
  resourceType,
  resourceId,
  resourceName,
  currentProjectSlug,
  onClose,
  onMoved,
}: {
  resourceType: MovableType;
  resourceId: string;
  resourceName: string;
  currentProjectSlug: string;
  onClose: () => void;
  onMoved: (destProjectSlug: string) => void;
}) {
  const { data: projectList } = useApi(
    useCallback(
      () =>
        api
          .get<{ data: Array<{ slug: string; displayName: string }> }>("/api/projects")
          .then((r) => r.data),
      [],
    ),
  );

  const [dest, setDest] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [blockers, setBlockers] = useState<Blocker[] | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  const others = (projectList ?? []).filter((p) => p.slug !== currentProjectSlug);

  // Dry-run whenever a destination is picked so blockers surface immediately.
  useEffect(() => {
    if (!dest) return;
    let cancelled = false;
    setChecking(true);
    setBlockers(null);
    setConflict(null);
    setError(null);
    api
      .post(`/api/projects/${dest}/move`, {
        type: resourceType,
        id: resourceId,
        dry_run: true,
      })
      .then(() => {
        if (!cancelled) setBlockers([]); // empty = clear to move
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 409) {
          const b = err.body.blockers as Blocker[] | undefined;
          if (b) setBlockers(b);
          else setConflict((err.body.conflict as string) ?? resourceName);
        } else {
          setError(err instanceof Error ? err.message : "Check failed");
        }
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dest, resourceId, resourceType, resourceName]);

  const canMove = !!dest && !checking && blockers?.length === 0 && !conflict && !error;

  async function handleMove() {
    if (!dest) return;
    setMoving(true);
    setError(null);
    try {
      await api.post(`/api/projects/${dest}/move`, { type: resourceType, id: resourceId });
      onMoved(dest);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Move failed");
      setMoving(false);
    }
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[440px] p-6">
        <h2 className="text-[15px] font-medium text-ink mb-1">Move to another project</h2>
        <p className="text-[12.5px] text-ink-3 mb-4">
          Move <span className="font-medium text-ink">{resourceName}</span> out of{" "}
          <span className="font-mono text-[11.5px]">{currentProjectSlug}</span>. Its history moves with it.
        </p>

        {others.length === 0 ? (
          <div className="text-[12.5px] text-ink-3 border border-border rounded-sm p-3 mb-4">
            This workspace has no other project to move it to.
          </div>
        ) : (
          <div className="space-y-1.5 mb-4">
            {others.map((p) => (
              <button
                key={p.slug}
                onClick={() => setDest(p.slug)}
                className={`w-full text-left px-3 py-2 rounded-sm border text-[13px] transition-colors ${
                  dest === p.slug
                    ? "border-vermillion-2 bg-vermillion-3/30 text-ink font-medium"
                    : "border-border hover:bg-cream-2 text-ink-2"
                }`}
              >
                <span className="truncate">{p.displayName}</span>
                <span className="text-ink-4 font-mono text-[11px] ml-1.5">{p.slug}</span>
              </button>
            ))}
          </div>
        )}

        {checking && (
          <div className="flex items-center gap-2 text-[12.5px] text-ink-3 mb-4">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking references…
          </div>
        )}

        {conflict && (
          <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-2 rounded-sm mb-4">
            The destination already has a {resourceType.replace("_", " ")} named{" "}
            <span className="font-medium">{conflict}</span>. Rename one first.
          </div>
        )}

        {blockers && blockers.length > 0 && (
          <div className="text-[12px] text-ink-2 bg-vermillion-3/30 border border-vermillion-2/30 px-3 py-2 rounded-sm mb-4">
            <div className="font-medium text-vermillion-2 mb-1">
              Move these into the destination first:
            </div>
            <ul className="space-y-0.5">
              {blockers.map((b, i) => (
                <li key={i}>
                  <span className="font-mono text-[11px]">{b.type}</span>{" "}
                  <span className="font-medium">{b.slug}</span>{" "}
                  <span className="text-ink-4">— {b.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-2 rounded-sm mb-4">
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
            onClick={handleMove}
            disabled={!canMove || moving}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-40"
          >
            {moving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
            {moving ? "Moving…" : "Move"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
