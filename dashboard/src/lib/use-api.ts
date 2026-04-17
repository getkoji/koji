"use client";

import { useState, useEffect } from "react";

/**
 * Simple data fetching hook with mock fallback.
 *
 * Tries the real API first. If the API is unreachable (server not
 * running), falls back to the mock data. This lets every page work
 * both in dev (with `pnpm --filter @koji/api dev` running) and in
 * standalone mode (mock data only).
 */
export function useApi<T>(
  fetcher: () => Promise<T>,
  mockData: T,
): { data: T; loading: boolean; error: string | null; live: boolean } {
  const [data, setData] = useState<T>(mockData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetcher()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLive(true);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          // API unreachable — use mock data silently
          setError(err.message);
          setLive(false);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading, error, live };
}
