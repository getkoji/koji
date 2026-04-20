"use client";

import { useState, useEffect, useCallback, useRef } from "react";

/**
 * Data fetching hook. Re-fetches when the fetcher reference changes
 * (wrap in useCallback with deps to control when).
 *
 * `loading` is true only on the initial fetch (no data yet) and on the
 * first attempt after an error clears the cached data. Background
 * refetches via `refetch()` keep the existing data on screen and surface
 * progress via the separate `refetching` flag — this prevents the
 * skeleton flash that otherwise twitches the page on every poll cycle.
 */
export function useApi<T>(
  fetcher: () => Promise<T>,
): {
  data: T | null;
  loading: boolean;
  refetching: boolean;
  error: { message: string } | null;
  refetch: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [refetching, setRefetching] = useState(false);
  const [error, setError] = useState<{ message: string } | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const hasDataRef = useRef(false);

  const doFetch = useCallback(() => {
    let cancelled = false;
    // Only show the skeleton-style loading state when we have nothing
    // to display yet. Background refetches keep the existing data
    // visible and surface progress via `refetching` instead.
    if (hasDataRef.current) {
      setRefetching(true);
    } else {
      setLoading(true);
    }
    setError(null);

    fetcherRef.current()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          hasDataRef.current = true;
          setLoading(false);
          setRefetching(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError({ message: err.message ?? "API unreachable" });
          setLoading(false);
          setRefetching(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return doFetch();
  }, [fetcher, doFetch]);

  const refetch = useCallback(() => {
    doFetch();
  }, [doFetch]);

  return { data, loading, refetching, error, refetch };
}
