// Attach to the persistent engine host (VPS). Read-only polling; attached only when the host itself reports
// a usable state for this symbol. Otherwise the dashboard stays in BROWSER SESSION mode (explicitly labelled).
import { useEffect, useMemo, useState } from "react";
import { EngineHostClient, engineHostUrlFromEnv } from "@/core/enginehost/client";
import type { RadarHealth, RadarSnapshot } from "@/core/radar/types";
import type { VirtualAccountView } from "@/core/paper/LivePaperLoop";
import type { SymbolEngineHealth } from "@/core/enginehost/types";

export interface EngineHostView {
  readonly configured: boolean;
  readonly attached: boolean;
  readonly symbolHealth: SymbolEngineHealth | null;
  readonly radar: { snapshot: Readonly<RadarSnapshot> | null; health: Readonly<RadarHealth> | null } | null;
  readonly account: Readonly<VirtualAccountView> | null;
  readonly error: string | null;
  readonly checkedAt: number | null;
}

const EMPTY: EngineHostView = { configured: false, attached: false, symbolHealth: null, radar: null, account: null, error: null, checkedAt: null };

export function useEngineHost(symbol: string, pollMs = 5_000, urlOverride?: string | null): EngineHostView {
  const url = urlOverride === undefined ? engineHostUrlFromEnv() : urlOverride;
  const client = useMemo(() => { try { return url ? new EngineHostClient({ baseUrl: url }) : null; } catch { return null; } }, [url]);
  const [view, setView] = useState<EngineHostView>({ ...EMPTY, configured: !!url });
  useEffect(() => {
    if (!client) { setView({ ...EMPTY, configured: !!url, error: url ? "INVALID_ENGINE_HOST_URL" : null }); return; }
    let alive = true;
    const run = async () => {
      const h = await client.health();
      if (!alive) return;
      if (!h.ok) { setView((v) => ({ ...v, configured: true, attached: false, error: h.error, checkedAt: Date.now() })); return; }
      const sh = h.envelope.data.symbols.find((s) => s.symbol === symbol) ?? null;
      const [r, a] = await Promise.all([client.radar(symbol), client.account(symbol)]);
      if (!alive) return;
      const usable = !!sh && sh.state !== "STARTING" && sh.state !== "OFFLINE" && r.ok;
      setView({
        configured: true, attached: usable, symbolHealth: sh,
        radar: r.ok ? { snapshot: r.envelope.data.snapshot, health: r.envelope.data.health } : null,
        account: a.ok ? a.envelope.data.account : null,
        error: !sh ? "SYMBOL_NOT_HOSTED" : !r.ok ? r.error : sh.error, checkedAt: Date.now(),
      });
    };
    void run();
    const t = setInterval(() => void run(), pollMs);
    return () => { alive = false; clearInterval(t); };
  }, [client, symbol, pollMs, url]);
  return view;
}
