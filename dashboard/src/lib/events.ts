/**
 * Lightweight event bus for cross-component cache invalidation.
 *
 * Usage:
 *   emit("projects:updated")   — after a project name changes
 *   useOn("projects:updated", refetch)  — in TopBar to refetch project list
 */

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();

export function emit(event: string) {
  listeners.get(event)?.forEach((fn) => fn());
}

export function on(event: string, fn: Listener): () => void {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(fn);
  return () => { listeners.get(event)?.delete(fn); };
}
