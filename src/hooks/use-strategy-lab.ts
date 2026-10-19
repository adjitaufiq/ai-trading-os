// Runs the PAPER Strategy Lab in the browser: polls broker quotes (15s) and CLOSED M5/M15 bars (60s) through the
// typed BrokerGatewayClient, never ingests evidence, never sends orders. State persists in localStorage.
import { useEffect, useRef, useState } from "react";
import { MODE_SWITCH_KEY, filterEnabled, parseSwitches, defaultSwitches, type ModeSwitches } from "@/core/lab/modeSwitch";
import type { BrokerGatewayClient } from "@/core/broker/gateway/BrokerGatewayClient";
import type { BridgeBar } from "@/core/broker/bridge/types";
import type { TechBar } from "@/core/technical/indicators";
import { evaluateLab } from "@/core/lab/strategies";
import { emptyLab, markSymbol, openSignals, type LabState } from "@/core/lab/labLedger";
import { bookMark, bookOpen, createBook, upgradeBook, type LedgerBook } from "@/core/lab/isolatedLedgers";
import { OPERATOR_KEY, DEFAULT_OPERATOR, capEntries, closeManual, gateState, parseOperator, type OperatorSettings } from "@/core/lab/operatorControl";
import type { LabQuote } from "@/core/lab/labLedger";
import { applySafetyRiders, type SafetyBlock } from "@/core/lab/safetyRiders";
import { applySpv, type SpvBlock } from "@/core/lab/spvTraffic";
import { useLabCloudSync, type LabSyncStatus } from "./use-lab-cloud-sync";

const KEY = "strategy-lab-v1";
const BOOK_KEY = "strategy-lab-ledgers-v1";
const TF_MS = { M5: 300_000, M15: 900_000, H1: 3_600_000 } as const;

function toBars(items: readonly BridgeBar[], tf: keyof typeof TF_MS): TechBar[] {
  // pos-mode start=0 includes the forming bar as the newest item: drop it, keep only CLOSED bars.
  return items.slice(0, -1).map((b) => ({ open_time: b.raw_time_s * 1000, close_time: b.raw_time_s * 1000 + TF_MS[tf], available_at: b.raw_time_s * 1000 + TF_MS[tf], open: b.open, high: b.high, low: b.low, close: b.close }));
}

export interface LabRuntime { state: LabState; lastBarAt: Record<string, number>; error: string | null; sync: LabSyncStatus; book: LedgerBook | null; safety: Record<string, SafetyBlock | SpvBlock | null>; reset: () => void; switches: ModeSwitches; setSwitches: (s: ModeSwitches) => void; operator: OperatorSettings; setOperator: (o: OperatorSettings) => void; closeTrades: (ids: readonly string[] | "ALL") => void }

export function useStrategyLab(client: BrokerGatewayClient, symbols: readonly string[]): LabRuntime {
  const [state, setState] = useState<LabState>(emptyLab);
  const [lastBarAt, setLastBarAt] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [safety, setSafety] = useState<Record<string, SafetyBlock | SpvBlock | null>>({});
  const [hydrated, setHydrated] = useState(false);
  const [book, setBook] = useState<LedgerBook | null>(null);
  const [switches, setSwitchesState] = useState<ModeSwitches>(defaultSwitches);
  const swRef = useRef(switches); swRef.current = switches;
  const [operator, setOperatorState] = useState<OperatorSettings>(DEFAULT_OPERATOR);
  const opRef = useRef(operator); opRef.current = operator;
  const stateRef = useRef(state); stateRef.current = state;
  const quotesRef = useRef<Record<string, LabQuote>>({});
  const { sync, rotate } = useLabCloudSync(state, hydrated);

  useEffect(() => {
    try { const raw = localStorage.getItem(KEY); if (raw) setState({ ...emptyLab(), ...JSON.parse(raw) }); } catch { /* corrupt ⇒ empty */ }
    try { const raw = localStorage.getItem(BOOK_KEY); setBook(raw ? upgradeBook(JSON.parse(raw), Date.now()) : createBook(Date.now())); } catch { setBook(createBook(Date.now())); }
    try { const raw = localStorage.getItem(MODE_SWITCH_KEY); setSwitchesState(parseSwitches(raw ? JSON.parse(raw) : null)); } catch { /* defaults */ }
    try { const raw = localStorage.getItem(OPERATOR_KEY); setOperatorState(parseOperator(raw ? JSON.parse(raw) : null)); } catch { /* defaults */ }
    setHydrated(true);
  }, []);
  useEffect(() => { if (hydrated) { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* quota */ } } }, [state, hydrated]);
  useEffect(() => { if (hydrated && book) { try { localStorage.setItem(BOOK_KEY, JSON.stringify(book)); } catch { /* quota */ } } }, [book, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    let active = true;
    const bars: Record<string, { m5: TechBar[]; m15: TechBar[]; h1: TechBar[] }> = {};
    const quote = async (symbol: string) => {
      const r = await client.getLatestTick(symbol);
      if (!r.ok || r.data.broker_symbol !== symbol || !(r.data.bid > 0 && r.data.ask >= r.data.bid)) return null;
      return { bid: r.data.bid, ask: r.data.ask };
    };
    const tickLoop = async () => {
      for (const s of symbols) {
        try { const q = await quote(s); if (q && active) { quotesRef.current[s] = q; const now = Date.now(); setState((st) => markSymbol(st, s, q, now)); setBook((b) => (b ? bookMark(b, s, q, now) : b)); } } catch { /* skip */ }
      }
    };
    const barLoop = async () => {
      for (const s of symbols) {
        try {
          const [a, b, c] = await Promise.all([
            client.getBars({ symbol: s, timeframe: "M5", mode: "pos", start: 0, count: 200 }),
            client.getBars({ symbol: s, timeframe: "M15", mode: "pos", start: 0, count: 200 }),
            client.getBars({ symbol: s, timeframe: "H1", mode: "pos", start: 0, count: 100 }),
          ]);
          if (!a.ok || !b.ok) { if (active) setError(`${s}: candle broker tidak tersedia`); continue; }
          const m5 = toBars(a.data.items, "M5"), m15 = toBars(b.data.items, "M15");
          // H1 is optional context for modes 6 and 9: unavailable H1 ⇒ those modes reject (H1_HISTORY_INSUFFICIENT).
          const h1 = c.ok ? toBars(c.data.items, "H1") : [];
          const prev = bars[s]?.m5.at(-1)?.open_time;
          bars[s] = { m5, m15, h1 };
          const last = m5.at(-1)?.open_time;
          if (!last || last === prev) continue;
          const q = await quote(s);
          if (!q || !active) continue;
          const now = Date.now();
          quotesRef.current[s] = q;
          // Operator circuit breaker: paused / daily target / daily max loss ⇒ no new Lab positions (open ones keep running).
          // Entry limits (per mode + global) count OPEN entries of the shared journal before opening.
          // Safety Riders: post-SL cooldown 15m per market, spike ATR, whale wick sweep — before entry caps.
          const raw = gateState(stateRef.current, opRef.current, now) === "RUNNING" ? filterEnabled(evaluateLab(m5, m15, h1), swRef.current) : [];
          const safe = applySafetyRiders(raw, stateRef.current, s, m5, now);
          // SPV: drop stale signals, lock one direction per symbol per M5 candle, priority order.
          const spv = applySpv(safe.pass, stateRef.current, s, now);
          if (active) setSafety((o) => ({ ...o, [s]: safe.blocked ?? spv.blocked }));
          const signals = capEntries(spv.pass, stateRef.current, opRef.current, s);
          setState((st) => openSignals(st, s, signals, q, now, "COPET"));
          setBook((b) => (b ? bookOpen(b, s, signals, q, now) : b));
          setLastBarAt((o) => ({ ...o, [s]: last }));
          setError(null);
        } catch { if (active) setError(`${s}: gateway tidak terjangkau`); }
      }
    };
    void barLoop(); void tickLoop();
    const t1 = setInterval(tickLoop, 15_000), t2 = setInterval(barLoop, 60_000);
    return () => { active = false; clearInterval(t1); clearInterval(t2); };
  }, [client, symbols, hydrated]);

  return { state, lastBarAt, error, sync, book, safety, reset: () => { rotate(); setState(emptyLab()); }, switches,
    setSwitches: (sw) => { setSwitchesState(sw); try { localStorage.setItem(MODE_SWITCH_KEY, JSON.stringify(sw)); } catch { /* quota */ } },
    operator, setOperator: (o) => { setOperatorState(o); try { localStorage.setItem(OPERATOR_KEY, JSON.stringify(o)); } catch { /* quota */ } },
    closeTrades: (ids) => { const now = Date.now(); setState((st) => closeManual(st, ids, quotesRef.current, now)); } };
}
