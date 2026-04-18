"use client";

import { useState, useEffect } from "react";

/**
 * Data fetching hook. No mock fallback — shows loading skeleton while
 * fetching, empty state if the result is empty, error state if the
 * API is unreachable.
 */
export function useApi<T>(
  fetcher: () => Promise<T>,
): { data: T | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

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
  }, []);

  return { data, loading, error };
}
