// Runs the PAPER Strategy Lab in the browser: polls broker quotes (15s) and CLOSED M5/M15 bars (60s) through the
// typed BrokerGatewayClient, never ingests evidence, never sends orders. State persists in localStorage.
import { useEffect, useState } from "react";
import type { BrokerGatewayClient } from "@/core/broker/gateway/BrokerGatewayClient";
import type { BridgeBar } from "@/core/broker/bridge/types";
import type { TechBar } from "@/core/technical/indicators";
import { evaluateLab } from "@/core/lab/strategies";
import { emptyLab, markSymbol, openSignals, type LabState } from "@/core/lab/labLedger";

const KEY = "strategy-lab-v1";
const TF_MS = { M5: 300_000, M15: 900_000 } as const;

function toBars(items: readonly BridgeBar[], tf: keyof typeof TF_MS): TechBar[] {
  // pos-mode start=0 includes the forming bar as the newest item: drop it, keep only CLOSED bars.
  return items.slice(0, -1).map((b) => ({ open_time: b.raw_time_s * 1000, close_time: b.raw_time_s * 1000 + TF_MS[tf], available_at: b.raw_time_s * 1000 + TF_MS[tf], open: b.open, high: b.high, low: b.low, close: b.close }));
}

export interface LabRuntime { state: LabState; lastBarAt: Record<string, number>; error: string | null; reset: () => void }

export function useStrategyLab(client: BrokerGatewayClient, symbols: readonly string[]): LabRuntime {
  const [state, setState] = useState<LabState>(emptyLab);
  const [lastBarAt, setLastBarAt] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try { const raw = localStorage.getItem(KEY); if (raw) setState({ ...emptyLab(), ...JSON.parse(raw) }); } catch { /* corrupt ⇒ empty */ }
  }, []);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* quota */ } }, [state]);

  useEffect(() => {
    let active = true;
    const bars: Record<string, { m5: TechBar[]; m15: TechBar[] }> = {};
    const quote = async (symbol: string) => {
      const r = await client.getLatestTick(symbol);
      if (!r.ok || r.data.broker_symbol !== symbol || !(r.data.bid > 0 && r.data.ask >= r.data.bid)) return null;
      return { bid: r.data.bid, ask: r.data.ask };
    };
    const tickLoop = async () => {
      for (const s of symbols) {
        try { const q = await quote(s); if (q && active) setState((st) => markSymbol(st, s, q, Date.now())); } catch { /* skip */ }
      }
    };
    const barLoop = async () => {
      for (const s of symbols) {
        try {
          const [a, b] = await Promise.all([
            client.getBars({ symbol: s, timeframe: "M5", mode: "pos", start: 0, count: 200 }),
            client.getBars({ symbol: s, timeframe: "M15", mode: "pos", start: 0, count: 200 }),
          ]);
          if (!a.ok || !b.ok) { if (active) setError(`${s}: candle broker tidak tersedia`); continue; }
          const m5 = toBars(a.data.items, "M5"), m15 = toBars(b.data.items, "M15");
          const prev = bars[s]?.m5.at(-1)?.open_time;
          bars[s] = { m5, m15 };
          const last = m5.at(-1)?.open_time;
          if (!last || last === prev) continue;
          const q = await quote(s);
          if (!q || !active) continue;
          const signals = evaluateLab(m5, m15);
          setState((st) => openSignals(st, s, signals, q, Date.now()));
          setLastBarAt((o) => ({ ...o, [s]: last }));
          setError(null);
        } catch { if (active) setError(`${s}: gateway tidak terjangkau`); }
      }
    };
    void barLoop(); void tickLoop();
    const t1 = setInterval(tickLoop, 15_000), t2 = setInterval(barLoop, 60_000);
    return () => { active = false; clearInterval(t1); clearInterval(t2); };
  }, [client, symbols]);

  return { state, lastBarAt, error, reset: () => setState(emptyLab()) };
}
