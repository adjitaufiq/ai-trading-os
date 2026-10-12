// Attach to the persistent engine host (VPS). One store per dashboard; React subscribes to it
// (SSE → store → render). When no URL is configured the store is DISABLED and the dashboard runs a BROWSER SESSION.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { EngineHostClient, engineHostUrlFromEnv } from "@/core/enginehost/client";
import { EngineHostStore, browserEventSource, type EngineStoreState } from "@/lib/engineHostStore";

export function useEngineHostStore(symbols: readonly string[], urlOverride?: string | null): { store: EngineHostStore; state: EngineStoreState } {
  const url = urlOverride === undefined ? engineHostUrlFromEnv() : urlOverride;
  const key = symbols.join(",");
  const store = useMemo(() => {
    let client: EngineHostClient | null = null;
    try { client = url ? new EngineHostClient({ baseUrl: url, timeoutMs: 20_000 }) : null; } catch { client = null; }
    return new EngineHostStore({ client, symbols: key.split(","), now: () => Date.now(), eventSource: browserEventSource() });
  }, [url, key]);
  useEffect(() => { void store.start(); return () => store.stop(); }, [store]);
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  return { store, state: store.getState() };
}
