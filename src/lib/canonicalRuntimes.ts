// Mounts the ONE canonical MarketRuntime per symbol for the dashboard (browser lifecycle).
// Specs come from the gateway (DISCOVERY.SYMBOL_SPEC); the broker-time offset is MEASURED from a real tick,
// never defaulted. History is a finite BACKFILL window that never builds live candles; insufficient evidence
// surfaces as INSUFFICIENT_HISTORY / DEGRADED downstream. MONITOR_ONLY, no execution surface.
import type { BrokerGatewayClient, WebSocketFactory } from "@/core/broker/gateway/BrokerGatewayClient";
import type { GatewayConfig } from "@/core/broker/gateway/config";
import type { ClassifierConfig } from "@/core/broker/AnomalyClassifier";
import type { SymbolSpecification } from "@/core/broker/types";
import { FreshnessPolicy } from "@/core/temporal/TemporalPolicy";
import { createApplicationMarketRuntime } from "@/core/runtime/applicationRuntime";
import type { MarketRuntime, MarketRuntimeReader } from "@/core/runtime/MarketRuntime";

/** Explicit, documented runtime policies (operator configuration, NOT Exness-measured values). */
export const RUNTIME_POLICY = Object.freeze({
  /** Finite history window requested at bootstrap (BACKFILL only; never mutates live candles). */
  history_window_ms: 15 * 60_000,
  /** Bounded positive cross-clock skew accepted and flagged as SOURCE_TIME_SKEW. */
  max_source_time_skew_ms: 10_000,
  /** Offset alignment: a real tick may be at most this old relative to bridge receive time to measure the offset. */
  max_offset_probe_staleness_ms: 60_000,
  max_closed_bars_per_timeframe: 500,
  boundary_check_ms: 1_000,
  retry_ms: 30_000,
  /** Broker /v1/bars CLOSED history per timeframe for technical warmup (BACKFILL provenance only). */
  broker_history_bars: 300,
  broker_history_refresh_ms: 60_000,
});

export const RUNTIME_CLASSIFIER: ClassifierConfig = Object.freeze({
  maxLatencyMs: 60_000,
  maxReorderMs: 90_000,
  maxSourceTimeSkewMs: RUNTIME_POLICY.max_source_time_skew_ms,
  freshness: new FreshnessPolicy({ maxTickAgeMs: 60_000, maxGapMs: 86_400_000 }),
});

export type OffsetMeasurement =
  | { readonly status: "MEASURED"; readonly broker_utc_offset_ms: 0; readonly observed_diff_ms: number }
  | { readonly status: "UNRESOLVED"; readonly reason: string; readonly observed_diff_ms: number | null };

/**
 * G2 measurement from ONE real tick: diff = raw_time_msc − bridge_received_at.
 * Any real broker timezone offset is ≥ 15 min, so a diff within [−staleness, +skew] proves offset 0 for this source.
 * Anything else stays UNRESOLVED (runtime not mounted). The raw diff is reported, never rewritten.
 */
export function measureBrokerOffset(raw_time_msc: number, bridge_received_at: number, p = RUNTIME_POLICY): OffsetMeasurement {
  const diff = raw_time_msc - bridge_received_at;
  if (!Number.isFinite(diff)) return { status: "UNRESOLVED", reason: "non-finite timestamps", observed_diff_ms: null };
  if (diff <= p.max_source_time_skew_ms && diff >= -p.max_offset_probe_staleness_ms) return { status: "MEASURED", broker_utc_offset_ms: 0, observed_diff_ms: diff };
  return { status: "UNRESOLVED", reason: `G2_OFFSET_UNRESOLVED: raw_time_msc − bridge_received_at = ${diff}ms outside [−${p.max_offset_probe_staleness_ms}, +${p.max_source_time_skew_ms}]`, observed_diff_ms: diff };
}

export type ResolveResult =
  | { readonly ok: true; readonly spec: SymbolSpecification; readonly offset: OffsetMeasurement & { status: "MEASURED" } }
  | { readonly ok: false; readonly reason: string };

const accepted = (env: { source: string; source_mode: string }) => env.source === "EXNESS_MT5" && env.source_mode === "REAL";

export async function resolveSymbolSpec(client: Pick<BrokerGatewayClient, "getSymbol" | "getLatestTick">, symbol: string): Promise<ResolveResult> {
  const s = await client.getSymbol(symbol);
  if (!s.ok) return { ok: false, reason: `SPEC_UNAVAILABLE ${s.error.kind}: ${s.error.message}` };
  if (!accepted(s.envelope)) return { ok: false, reason: `SPEC_SOURCE_REJECTED ${s.envelope.source}/${s.envelope.source_mode}` };
  if (s.data.broker_symbol !== symbol) return { ok: false, reason: `SPEC_SYMBOL_MISMATCH ${s.data.broker_symbol}` };
  const t = await client.getLatestTick(symbol);
  if (!t.ok) return { ok: false, reason: `OFFSET_PROBE_UNAVAILABLE ${t.error.kind}: ${t.error.message}` };
  if (!accepted(t.envelope) || t.data.broker_symbol !== symbol) return { ok: false, reason: "OFFSET_PROBE_REJECTED" };
  const offset = measureBrokerOffset(t.data.raw_time_msc, t.envelope.timing.bridge_received_at);
  if (offset.status !== "MEASURED") return { ok: false, reason: offset.reason };
  return {
    ok: true, offset,
    spec: Object.freeze({
      symbol, origin: "BROKER_REPORTED", digits: s.data.digits, point: s.data.point,
      // Gateway 3.0B-1 does not expose trade_tick_size; point is the reported minimum price step.
      tick_size: s.data.point, contract_size: s.data.trade_contract_size, broker_utc_offset_ms: offset.broker_utc_offset_ms,
    }),
  };
}

export interface MountedRuntime { readonly symbol: string; readonly reader: MarketRuntimeReader | null; readonly status: string }

/** Starts one runtime; returns a stop() handle. Never substitutes data on failure. */
export function mountCanonicalRuntime(o: {
  client: Pick<BrokerGatewayClient, "getSymbol" | "getLatestTick"> & Partial<Pick<BrokerGatewayClient, "getBars">>;
  config: GatewayConfig;
  wsFactory: WebSocketFactory;
  symbol: string;
  now?: () => number;
  onChange: (m: MountedRuntime) => void;
  create?: typeof createApplicationMarketRuntime;
  /** Called once per created runtime, before start() (engine host restores persisted paper state here). */
  onRuntime?: (rt: MarketRuntime) => void;
}): () => void {
  let stopped = false;
  let rt: MarketRuntime | null = null;
  let boundary: ReturnType<typeof setInterval> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let historyTimer: ReturnType<typeof setInterval> | null = null;
  const now = o.now ?? (() => Date.now());
  const create = o.create ?? createApplicationMarketRuntime;
  const attempt = async () => {
    if (stopped) return;
    o.onChange({ symbol: o.symbol, reader: null, status: "RESOLVING_SPEC" });
    let r: ResolveResult;
    try { r = await resolveSymbolSpec(o.client, o.symbol); } catch (e) { r = { ok: false, reason: `RESOLVE_FAILED: ${(e as Error).message}` }; }
    if (stopped) return;
    if (!r.ok) { o.onChange({ symbol: o.symbol, reader: null, status: r.reason }); retry = setTimeout(attempt, RUNTIME_POLICY.retry_ms); return; }
    rt = create({
      config: o.config, wsFactory: o.wsFactory, binding: { broker_symbol: o.symbol, canonical_symbol: o.symbol },
      spec: r.spec, classifier: RUNTIME_CLASSIFIER, maxClosedBarsPerTimeframe: RUNTIME_POLICY.max_closed_bars_per_timeframe,
    });
    try { o.onRuntime?.(rt); } catch (e) { o.onChange({ symbol: o.symbol, reader: null, status: `RUNTIME_HOOK_FAILED: ${(e as Error).message}` }); rt.stop(); rt = null; retry = setTimeout(attempt, RUNTIME_POLICY.retry_ms); return; }
    o.onChange({ symbol: o.symbol, reader: rt.reader, status: `MOUNTED offset 0 (measured diff ${r.offset.observed_diff_ms}ms)` });
    boundary = setInterval(() => rt?.checkBoundaries(), RUNTIME_POLICY.boundary_check_ms);
    const to = now();
    const seed = async () => {
      if (stopped || !rt || !o.client.getBars) return;
      for (const tf of ["M5", "M15", "H1", "H4"] as const) {
        try {
          const r = await o.client.getBars({ symbol: o.symbol, timeframe: tf, mode: "pos", start: 0, count: RUNTIME_POLICY.broker_history_bars });
          if (!r.ok || !accepted(r.envelope)) continue; // no substitute: technical stays INSUFFICIENT_HISTORY for this tf
          const items = r.data.items;
          if (!items.every((b) => b.broker_symbol === o.symbol && b.timeframe === tf)) continue;
          // offset 0 measured above (G2); raw_time_s is bar-precision broker time.
          rt.seedBrokerHistory(tf, items.map((b) => ({ open_time: b.raw_time_s * 1000, open: b.open, high: b.high, low: b.low, close: b.close })));
        } catch { /* surfaced downstream as INSUFFICIENT_HISTORY */ }
      }
    };
    void seed();
    historyTimer = setInterval(() => void seed(), RUNTIME_POLICY.broker_history_refresh_ms);
    try { await rt.start({ history_from: to - RUNTIME_POLICY.history_window_ms, history_to: to }); }
    catch (e) { o.onChange({ symbol: o.symbol, reader: rt.reader, status: `START_FAILED: ${(e as Error).message}` }); }
  };
  void attempt();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    if (boundary) clearInterval(boundary);
    if (historyTimer) clearInterval(historyTimer);
    rt?.stop();
  };
}
