import { useEffect, useState } from 'react';

/**
 * Fetch a Lakebase-served JSON route (an Express route backed by appkit.lakebase).
 * These reads are sub-second, replacing the SQL-warehouse-backed useAnalyticsQuery
 * for the operational/overview surfaces. `refreshMs` optionally re-polls (used by the
 * live Command Center); omit for a one-shot fetch.
 */
export function useLakebase<T = Record<string, unknown>>(url: string, refreshMs?: number) {
  const [data, setData] = useState<T[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(url)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => {
          if (!alive) return;
          if (Array.isArray(d)) {
            setData(d as T[]);
            setError(null);
          } else if (d && typeof d === 'object' && 'error' in d) {
            setError(String((d as { error: unknown }).error));
          }
          setLoading(false);
        })
        .catch((e) => {
          if (!alive) return;
          setError(String(e));
          setLoading(false);
        });
    void load();
    const id = refreshMs ? setInterval(() => { void load(); }, refreshMs) : undefined;
    return () => {
      alive = false;
      if (id) clearInterval(id);
    };
  }, [url, refreshMs]);

  return { data, loading, error };
}
