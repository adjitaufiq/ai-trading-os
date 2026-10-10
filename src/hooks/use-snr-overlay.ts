import { useEffect, useMemo, useState } from "react";
import { EngineHostClient, engineHostUrlFromEnv } from "@/core/enginehost/client";
import type { SnrSnapshot } from "@/lib/snrOverlay";

const REFRESH_MS = 15_000;

/** Independent read-only display request. No runtime, indicator or trading state access. */
export function useSnrOverlay(symbol: string) {
  const client = useMemo(() => {
    const baseUrl = engineHostUrlFromEnv();
    try { return baseUrl ? new EngineHostClient({ baseUrl }) : null; }
    catch { return null; }
  }, []);
  const [state, setState] = useState<{ symbol: string; snapshot: SnrSnapshot | null; error: string | null }>({ symbol, snapshot: null, error: null });
  useEffect(() => {
    let active = true;
    let busy = false;
    setState({ symbol, snapshot: null, error: null });
    const refresh = async () => {
      if (busy || !client) return;
      busy = true;
      try {
        const result = await client.snr(symbol);
        if (active) setState({ symbol, snapshot: result.ok ? result.data : null, error: result.ok ? null : result.error });
      } finally { busy = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, REFRESH_MS);
    return () => { active = false; clearInterval(timer); };
  }, [client, symbol]);
  return state.symbol === symbol ? state : { symbol, snapshot: null, error: null };
}