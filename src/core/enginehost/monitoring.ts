// Phase 2B monitoring projection. Pure field copy of runtime state: last CLOSED candle per timeframe, feed liveness,
// and the paper loop's last recorded decision. No indicator, bias or decision is computed here.
import type { MarketRuntimeReader } from "../runtime/MarketRuntime";
import type { PaperReadinessView } from "../paper/LivePaperLoop";
import type { EngineBuildInfo } from "./buildInfo";
import type { SymbolEngineHealth } from "./types";

export const MONITORING_SCHEMA = "engine-monitoring-v1" as const;
export const MONITOR_TFS = ["M5", "M15", "H1", "H4"] as const;
export type MonitorTf = (typeof MONITOR_TFS)[number];
const TF_MS: Record<MonitorTf, number> = { M5: 300_000, M15: 900_000, H1: 3_600_000, H4: 14_400_000 };
/** Policy: no LIVE observation for this long ⇒ FEED_STOPPED (same value as health stale_feed_ms). */
export const FEED_STOP_MS = 120_000;

/** FRESH: candle within 2 intervals. NO_NEW_CANDLE: feed alive but candle older. FEED_STOPPED: no live ticks. NO_DATA: nothing. */
export type CandleHealthStatus = "FRESH" | "NO_NEW_CANDLE" | "FEED_STOPPED" | "NO_DATA";
export interface TfHealth { readonly timeframe: MonitorTf; readonly last_closed_at: number | null; readonly age_ms: number | null; readonly source: "LIVE" | "BROKER_HISTORY" | null; readonly status: CandleHealthStatus }

export function feedState(reader: MarketRuntimeReader | null, now: number): { last_tick_at: number | null; alive: boolean } {
  const live = reader?.latestLiveObservation() ?? null;
  const at = live ? live.observed_at : null;
  return { last_tick_at: at, alive: at !== null && now - at <= FEED_STOP_MS };
}

export function marketDataHealth(reader: MarketRuntimeReader | null, now: number): readonly TfHealth[] {
  const feed = feedState(reader, now);
  return MONITOR_TFS.map((tf) => {
    const live = reader?.closedBars(tf).at(-1)?.close_time ?? null;
    const hist = reader?.brokerHistoryBars?.(tf).at(-1)?.close_time ?? null;
    const last = live !== null && (hist === null || live >= hist) ? live : hist;
    const source = last === null ? null : last === live ? "LIVE" as const : "BROKER_HISTORY" as const;
    const age = last === null ? null : now - last;
    const status: CandleHealthStatus = last === null ? "NO_DATA" : !feed.alive ? "FEED_STOPPED" : age! <= 2 * TF_MS[tf] ? "FRESH" : "NO_NEW_CANDLE";
    return Object.freeze({ timeframe: tf, last_closed_at: last, age_ms: age, source, status });
  });
}

export interface DecisionHealth {
  readonly last_analysis_at: number | null;
  readonly arena: string | null;
  readonly h4_bias: string | null;
  readonly m1b: string | null;
  readonly decision: string | null;
  readonly reason: string | null;
}

export function decisionHealth(p: PaperReadinessView | null): DecisionHealth {
  return Object.freeze({
    last_analysis_at: p?.lastEvaluatedAt ?? null,
    arena: p?.gate?.arenaStatus ?? p?.primaryBias?.arenaStatus ?? null,
    h4_bias: p?.primaryBias?.bias ?? null,
    m1b: p?.m3?.status ?? p?.m2?.state ?? null,
    decision: p?.gate?.decision ?? p?.decision ?? null,
    reason: p?.gate?.reason ?? p?.m3?.holdReason ?? p?.m4?.reasons?.[0] ?? null,
  });
}

export interface SymbolMonitoring { readonly symbol: string; readonly engine: SymbolEngineHealth; readonly feed: { readonly last_tick_at: number | null; readonly alive: boolean }; readonly market_data: readonly TfHealth[]; readonly decision: DecisionHealth }
export interface EngineMonitoring {
  readonly schema: typeof MONITORING_SCHEMA;
  readonly engine_status: "ONLINE" | "OFFLINE";
  readonly build: EngineBuildInfo;
  readonly started_at: number;
  readonly last_process_at: number | null;
  readonly last_error: string | null;
  readonly shadow: unknown;
  readonly symbols: readonly SymbolMonitoring[];
}
