// Real-market technical slice: validated REAL broker observations (BrokerGatewayClient) → CLOSED bars → evidence → four states.
// No mock fallback: a failed or non-REAL observation makes the market state UNAVAILABLE; it is never substituted.
// MONITOR_ONLY. No execution surface.
import { TIMEFRAME_MS, type Timeframe } from "../contracts";
import type { CanonicalClock } from "../temporal/CanonicalClock";
import type { BridgeBar, BridgeTick, GatewayResult, WireHistoryResult } from "../broker/gateway/types";
import { Telemetry, type TechBar } from "./indicators";
import { SLICE_ENV, TIMEFRAMES, TransitionTrail, asLastKnown, evaluate, type StateTransition, type TradingSnapshot } from "./tradingState";

/** Narrow read-only port; BrokerGatewayClient satisfies it. */
export interface SliceGatewayPort {
  getLatestTick(symbol: string): Promise<GatewayResult<BridgeTick>>;
  getBars(req: { symbol: string; timeframe: Timeframe; mode: "pos"; start: number; count: number }): Promise<GatewayResult<WireHistoryResult<BridgeBar>>>;
}

export interface SliceTiming { readonly tick_received: number; readonly technical_state_at: number; readonly decision_at: number; readonly guard_at: number }

export interface SliceView {
  readonly symbol: string;
  readonly current: TradingSnapshot | null;
  readonly last_known: TradingSnapshot | null;
  readonly transitions: readonly StateTransition[];
  readonly transitions_total: number;
  readonly spread: ReturnType<Telemetry["summary"]> & { policy: "RESEARCH_REQUIRED" };
  readonly latency_ms: { readonly gateway_roundtrip: ReturnType<Telemetry["summary"]>; readonly evaluate: ReturnType<Telemetry["summary"]> };
  readonly last_error: string | null;
  readonly feed: { readonly last_tick_event_at: number | null; readonly last_tick_observed_at: number | null; readonly last_tick_age_ms: number | null; readonly freshness_policy: "RESEARCH_REQUIRED" };
  readonly time_axis: "BROKER_SERVER_TIME_UNRESOLVED_G2";
  readonly data_source: "EXNESS_MT5/REAL/BACKFILL_BARS+LIVE_TICK";
}

const isReal = (r: GatewayResult<unknown>, delivery: "LIVE" | "BACKFILL"): boolean =>
  r.ok && r.sequence.disposition !== "QUARANTINE" && r.envelope.source === "EXNESS_MT5" && r.envelope.source_mode === "REAL" && r.envelope.delivery === delivery;

export class TechnicalSliceService {
  private closed: Record<Timeframe, TechBar[]> = { M5: [], M15: [], H1: [], H4: [] };
  private firstSeen = new Map<string, number>();
  private barsCurrent = false;
  private barsLoadedOnce = false;
  private current: TradingSnapshot | null = null;
  private lastKnown: TradingSnapshot | null = null;
  private readonly trail = new TransitionTrail(500);
  private readonly spread = new Telemetry(5000);
  private readonly rtt = new Telemetry(1000);
  private readonly evalMs = new Telemetry(1000);
  private lastTick: BridgeTick | null = null;
  private lastTickObservedAt: number | null = null;
  private lastError: string | null = null;
  private listeners = new Set<() => void>();
  private version = 0;
  private cached: SliceView | null = null;

  constructor(private readonly gw: SliceGatewayPort, readonly symbol: string, private readonly clock: CanonicalClock, private readonly barCount = 200) {}

  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getVersion = () => this.version;

  /** Refresh CLOSED bars for all timeframes. Newest returned bar is treated as FORMING and excluded (G1). */
  async refreshBars(): Promise<void> {
    let all = true;
    for (const tf of TIMEFRAMES) {
      try {
        const r = await this.gw.getBars({ symbol: this.symbol, timeframe: tf, mode: "pos", start: 0, count: this.barCount });
        if (!r.ok || !isReal(r, "BACKFILL")) { all = false; this.lastError = r.ok ? `${tf} bars not REAL/BACKFILL` : `${tf} ${r.error.kind}: ${r.error.message}`; continue; }
        const items = r.data.items;
        const coherent = items.every((b, i) => b.broker_symbol === this.symbol && b.timeframe === tf && (i === 0 || items[i - 1]!.raw_time_s < b.raw_time_s));
        if (!coherent) { all = false; this.lastError = `${tf} bars incoherent (symbol/timeframe/order)`; continue; }
        const now = this.clock.now();
        this.closed[tf] = items.slice(0, -1).map((b) => {
          const open = b.raw_time_s * 1000, key = `${tf}:${open}`;
          if (!this.firstSeen.has(key)) this.firstSeen.set(key, now);
          return Object.freeze({ open_time: open, close_time: open + TIMEFRAME_MS[tf], available_at: this.firstSeen.get(key)!, open: b.open, high: b.high, low: b.low, close: b.close });
        });
      } catch (e) { all = false; this.lastError = `${tf} TRANSPORT: ${(e as Error).message}`; }
    }
    if (this.firstSeen.size > 4 * this.barCount * 4) this.firstSeen = new Map([...this.firstSeen].slice(-4 * this.barCount * 2));
    this.barsCurrent = all;
    if (all) this.barsLoadedOnce = true;
  }

  /** One observation cycle: latest tick → evaluate → transitions. */
  async tick(): Promise<TradingSnapshot> {
    const t0 = this.clock.now();
    let marketCurrent = false;
    try {
      const r = await this.gw.getLatestTick(this.symbol);
      if (r.ok && isReal(r, "LIVE") && r.data.broker_symbol === this.symbol) {
        this.lastTick = r.data; this.lastTickObservedAt = this.clock.now(); marketCurrent = true;
        this.spread.push(r.data.ask - r.data.bid);
      } else this.lastError = r.ok ? "tick not REAL/LIVE for this symbol" : `TICK ${r.error.kind}: ${r.error.message}`;
    } catch (e) { this.lastError = `TICK TRANSPORT: ${(e as Error).message}`; }
    const tReceived = this.clock.now();
    this.rtt.push(tReceived - t0);
    const quote = marketCurrent && this.lastTick ? { bid: this.lastTick.bid, ask: this.lastTick.ask, spread: this.lastTick.ask - this.lastTick.bid, tick_time_ms: this.lastTick.raw_time_msc, observed_at: tReceived } : null;
    const snap = evaluate({
      symbol: this.symbol, market_current: marketCurrent && this.barsLoadedOnce, bars_current: this.barsCurrent, quote,
      closed: this.closed, as_of: tReceived, env: SLICE_ENV,
    }, this.current?.signal ?? null);
    this.evalMs.push(this.clock.now() - tReceived);
    this.apply(snap);
    return snap;
  }

  /** Exposed for tests; production path is tick(). */
  apply(snap: TradingSnapshot): void {
    this.trail.record(this.current, snap);
    if (snap.availability === "UNAVAILABLE") { if (this.current && this.current.availability !== "UNAVAILABLE") this.lastKnown = asLastKnown(this.current); }
    else this.lastKnown = null;
    this.current = snap;
    this.version++; this.cached = null;
    for (const l of this.listeners) l();
  }

  view(): SliceView {
    if (this.cached) return this.cached;
    const now = this.clock.now();
    this.cached = Object.freeze({
      symbol: this.symbol, current: this.current, last_known: this.lastKnown, transitions: [...this.trail.entries], transitions_total: this.trail.total,
      spread: { ...this.spread.summary(), policy: "RESEARCH_REQUIRED" as const },
      latency_ms: { gateway_roundtrip: this.rtt.summary(), evaluate: this.evalMs.summary() },
      last_error: this.lastError,
      feed: { last_tick_event_at: this.lastTick?.raw_time_msc ?? null, last_tick_observed_at: this.lastTickObservedAt, last_tick_age_ms: this.lastTick ? now - this.lastTick.raw_time_msc : null, freshness_policy: "RESEARCH_REQUIRED" as const },
      time_axis: "BROKER_SERVER_TIME_UNRESOLVED_G2" as const,
      data_source: "EXNESS_MT5/REAL/BACKFILL_BARS+LIVE_TICK" as const,
    });
    return this.cached;
  }
}
