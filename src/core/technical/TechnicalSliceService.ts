// Technical slice consumer of the ONE canonical market reality: MarketRuntimeReader (D2 MarketRuntime → CandleStore).
// It never fetches bars/ticks itself and keeps no candle history of its own; CLOSED/FORMING semantics,
// availability timestamps, bootstrap and missing-interval state all come from the canonical runtime.
// No mock fallback: absent/stale canonical state ⇒ UNAVAILABLE (NOT_EVALUABLE/BLOCKED). MONITOR_ONLY.
import type { Timeframe } from "../contracts";
import type { CanonicalClock } from "../temporal/CanonicalClock";
import type { MarketRuntimeReader, MarketRuntimeSnapshot } from "../runtime/MarketRuntime";
import type { MissingInterval } from "../candles/MissingInterval";
import { Telemetry, type TechBar } from "./indicators";
import { SLICE_ENV, TIMEFRAMES, TransitionTrail, asLastKnown, evaluate, type StateTransition, type TradingSnapshot } from "./tradingState";

export interface CanonicalVisibility {
  readonly lifecycle: MarketRuntimeSnapshot["lifecycle"];
  readonly bootstrap_state: MarketRuntimeSnapshot["bootstrap_state"];
  readonly active_epoch: number | null;
  readonly degraded_reason: string | null;
  readonly history_coverage_status: string | null;
  readonly route_counts: MarketRuntimeSnapshot["route_counts"];
  readonly held_count: number;
  readonly silent_ambiguous_drops: number;
  readonly stream_protocol_errors: number;
  readonly last_stream_error: string | null;
  readonly missing_intervals: Readonly<Record<Timeframe, number>>;
  readonly forming_open_time: Readonly<Record<Timeframe, number | null>>;
}

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
  readonly canonical: CanonicalVisibility | null;
  readonly time_axis: "BROKER_SERVER_TIME_UNRESOLVED_G2";
  readonly data_source: "CANONICAL_MARKET_RUNTIME" | "CANONICAL_RUNTIME_NOT_MOUNTED";
}

/** Canonical CLOSED bar → technical input (identity mapping; available_at preserved from the runtime). */
export const toTechBar = (b: { open_time: number; close_time: number; available_at: number; open: number; high: number; low: number; close: number }): TechBar =>
  Object.freeze({ open_time: b.open_time, close_time: b.close_time, available_at: b.available_at, open: b.open, high: b.high, low: b.low, close: b.close });

export class TechnicalSliceService {
  private current: TradingSnapshot | null = null;
  private lastKnown: TradingSnapshot | null = null;
  private readonly trail = new TransitionTrail(500);
  private readonly spread = new Telemetry(5000);
  private readonly evalMs = new Telemetry(1000);
  private lastSeq: number | null = null;
  private lastError: string | null = null;
  private canonical: CanonicalVisibility | null = null;
  private listeners = new Set<() => void>();
  private version = 0;
  private cached: SliceView | null = null;

  /** reader === null ⇒ canonical runtime not mounted; `unmountedReason` is surfaced verbatim. */
  constructor(private readonly reader: MarketRuntimeReader | null, readonly symbol: string, private readonly clock: CanonicalClock, private readonly unmountedReason = "CANONICAL_RUNTIME_NOT_MOUNTED") {}

  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getVersion = () => this.version;

  /** One evaluation cycle over the canonical read model. Synchronous: no transport here. */
  tick(): TradingSnapshot {
    const asOf = this.clock.now();
    const r = this.reader;
    let marketCurrent = false, barsCurrent = false, quote: TradingSnapshot["quote"] = null;
    const closed = { M5: [], M15: [], H1: [], H4: [] } as Record<Timeframe, TechBar[]>;
    if (!r) this.lastError = this.unmountedReason;
    else {
      const snap = r.snapshot();
      const mi = {} as Record<Timeframe, number>, forming = {} as Record<Timeframe, number | null>;
      for (const tf of TIMEFRAMES) {
        const list: readonly MissingInterval[] = r.missingIntervals(tf);
        mi[tf] = list.length; forming[tf] = r.formingBar(tf)?.open_time ?? null;
        // CLOSED only, and only once knowable at asOf. FORMING is never handed to the technical engine.
        closed[tf] = r.closedBars(tf).filter((b) => b.status === "CLOSED" && b.available_at <= asOf).map(toTechBar);
      }
      this.canonical = Object.freeze({
        lifecycle: snap.lifecycle, bootstrap_state: snap.bootstrap_state, active_epoch: snap.active_epoch, degraded_reason: snap.degraded_reason,
        history_coverage_status: snap.history_coverage_status, route_counts: snap.route_counts, held_count: snap.held.length,
        silent_ambiguous_drops: snap.silent_ambiguous_drops,
        stream_protocol_errors: snap.stream_protocol_errors ?? 0, last_stream_error: snap.last_stream_error ?? null, missing_intervals: Object.freeze(mi), forming_open_time: Object.freeze(forming),
      });
      const live = r.latestLiveObservation();
      const fresh = live !== null && live.seq !== this.lastSeq; // a new LIVE_MUTATION since the previous cycle
      const running = snap.lifecycle === "RUNNING" && snap.bootstrap_state === "SYNCHRONIZED";
      marketCurrent = running && fresh;
      barsCurrent = running;
      if (live && fresh) { this.lastSeq = live.seq; this.spread.push(live.ask - live.bid); }
      if (marketCurrent && live) quote = { bid: live.bid, ask: live.ask, spread: live.ask - live.bid, tick_time_ms: live.event_at, observed_at: live.ingested_at };
      else this.lastError = !running ? `CANONICAL_${snap.lifecycle}_${snap.bootstrap_state}${snap.degraded_reason ? `: ${snap.degraded_reason}` : ""}` : snap.last_stream_error ? `NO_NEW_LIVE_MUTATION · stream protocol errors ${snap.stream_protocol_errors}: ${snap.last_stream_error}` : "NO_NEW_LIVE_MUTATION";
    }
    const snap = evaluate({ symbol: this.symbol, market_current: marketCurrent, bars_current: barsCurrent, quote, closed, as_of: asOf, env: SLICE_ENV }, this.current?.signal ?? null);
    this.evalMs.push(this.clock.now() - asOf);
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
    const live = this.reader?.latestLiveObservation() ?? null;
    const empty = new Telemetry(1).summary();
    this.cached = Object.freeze({
      symbol: this.symbol, current: this.current, last_known: this.lastKnown, transitions: [...this.trail.entries], transitions_total: this.trail.total,
      spread: { ...this.spread.summary(), policy: "RESEARCH_REQUIRED" as const },
      latency_ms: { gateway_roundtrip: empty, evaluate: this.evalMs.summary() },
      last_error: this.lastError,
      feed: { last_tick_event_at: live?.event_at ?? null, last_tick_observed_at: live?.ingested_at ?? null, last_tick_age_ms: live ? now - live.event_at : null, freshness_policy: "RESEARCH_REQUIRED" as const },
      canonical: this.canonical,
      time_axis: "BROKER_SERVER_TIME_UNRESOLVED_G2" as const,
      data_source: this.reader ? "CANONICAL_MARKET_RUNTIME" as const : "CANONICAL_RUNTIME_NOT_MOUNTED" as const,
    });
    return this.cached;
  }
}
