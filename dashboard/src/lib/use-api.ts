"use client";

import { useState, useEffect } from "react";

/**
 * Data fetching hook. Re-fetches when the fetcher reference changes
 * (wrap in useCallback with deps to control when).
 *
 * Shows loading state on initial fetch and on refetch.
 */
export function useApi<T>(
  fetcher: () => Promise<T>,
): { data: T | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetcher()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message ?? "API unreachable");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [fetcher]);

  return { data, loading, error };
}
