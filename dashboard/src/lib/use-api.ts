"use client";

import { useState, useEffect, useCallback, useRef } from "react";

/**
 * Data fetching hook. Re-fetches when the fetcher reference changes
 * (wrap in useCallback with deps to control when).
 *
 * Shows loading state on initial fetch and on refetch.
 */
export function useApi<T>(
  fetcher: () => Promise<T>,
): { data: T | null; loading: boolean; error: { message: string } | null; refetch: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string } | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const doFetch = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetcherRef.current()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError({ message: err.message ?? "API unreachable" });
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    return doFetch();
  }, [fetcher, doFetch]);

  const refetch = useCallback(() => {
    doFetch();
  }, [doFetch]);

  return { data, loading, error, refetch };
}
