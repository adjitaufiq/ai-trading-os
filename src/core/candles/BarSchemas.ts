// PRE-2D Patch C — R8 canonical bar schema separation.
// InternalAggregatedBar  = what OUR deterministic engine derived from observations it accepted.
// BrokerObservedBar      = what MT5/Exness reported. Authoritative for broker-observed state.
// They are different epistemic objects. Volume fields are never copied across:
//   observed_tick_count != tick_volume != real_volume (no equivalence assumed).
import type { Bar, BarStatus, Timeframe } from "../contracts";
import type { DiscrepancyOutcome, NormalizedBrokerBar, Provenance, SymbolSpecification } from "../broker/types";

export const INTERNAL_AGGREGATION_ALGORITHM_VERSION = "CandleAggregator-bid-v1";

export interface InternalAggregatedBar {
  readonly kind: "INTERNAL_AGGREGATED";
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly open_time: number;
  readonly close_time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** Count of observations this system accepted into the bar. NOT broker tick_volume. */
  readonly observed_tick_count: number;
  readonly effective_at: number;
  readonly closed_at: number | null;
  readonly available_at: number;
  readonly lifecycle: BarStatus;
  readonly algorithm_version: string;
  readonly provenance: { readonly origin: "INTERNAL_AGGREGATION"; readonly source: Bar["source"]; readonly revision: number };
}

export interface BrokerObservedBar {
  readonly kind: "BROKER_OBSERVED";
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly open_time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** Broker-native MT5 tick_volume. Semantics owned by the broker. */
  readonly tick_volume: number;
  /** Broker-native real_volume; null = not provided by the source. */
  readonly real_volume: number | null;
  /** Broker-native spread; null = not provided. */
  readonly spread: number | null;
  readonly observed_at: number;
  readonly provenance: Provenance;
}

/** Projection of the existing canonical Bar. The source Bar is not modified. */
export function toInternalAggregatedBar(b: Bar): InternalAggregatedBar {
  return Object.freeze({
    kind: "INTERNAL_AGGREGATED", symbol: b.symbol, timeframe: b.timeframe, open_time: b.open_time, close_time: b.close_time,
    open: b.open, high: b.high, low: b.low, close: b.close, observed_tick_count: b.tick_count,
    effective_at: b.effective_at, closed_at: b.closed_at, available_at: b.available_at, lifecycle: b.status,
    algorithm_version: INTERNAL_AGGREGATION_ALGORITHM_VERSION,
    provenance: Object.freeze({ origin: "INTERNAL_AGGREGATION", source: b.source, revision: b.revision }),
  });
}

export function toBrokerObservedBar(n: NormalizedBrokerBar, spread: number | null = null): BrokerObservedBar {
  return Object.freeze({
    kind: "BROKER_OBSERVED", symbol: n.symbol, timeframe: n.timeframe, open_time: n.open_time,
    open: n.open, high: n.high, low: n.low, close: n.close,
    tick_volume: n.tick_volume, real_volume: n.real_volume, spread, observed_at: n.observed_at, provenance: n.provenance,
  });
}

export interface BarComparisonTolerance {
  readonly maxPriceDeltaPoints: number;
}

export interface BarDiscrepancyRecord {
  readonly kind: "BAR_DISCREPANCY";
  readonly outcome: DiscrepancyOutcome;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly open_time: number | null;
  readonly reason: string;
  readonly ohlc_delta_points: { readonly open: number; readonly high: number; readonly low: number; readonly close: number } | null;
  /** Volumes are reported side by side, never subtracted: no equivalence is assumed. */
  readonly volume: {
    readonly comparison: "NOT_COMPARED_NO_EQUIVALENCE";
    readonly internal_observed_tick_count: number | null;
    readonly broker_tick_volume: number | null;
    readonly broker_real_volume: number | null;
  };
  /** Identity of both sides; neither object is altered by the comparison. */
  readonly internal_ref: InternalAggregatedBar | null;
  readonly broker_ref: BrokerObservedBar | null;
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * Separate discrepancy record. Does NOT overwrite either source: internal CLOSED candles stay as
 * aggregated, broker history stays as observed (R8.4/R8.5).
 */
export function compareBars(
  internal: InternalAggregatedBar | null,
  broker: BrokerObservedBar | null,
  spec: SymbolSpecification,
  tol: BarComparisonTolerance,
): BarDiscrepancyRecord {
  const ref = internal ?? broker;
  const volume = Object.freeze({
    comparison: "NOT_COMPARED_NO_EQUIVALENCE" as const,
    internal_observed_tick_count: internal?.observed_tick_count ?? null,
    broker_tick_volume: broker?.tick_volume ?? null,
    broker_real_volume: broker?.real_volume ?? null,
  });
  const base = { kind: "BAR_DISCREPANCY" as const, symbol: ref?.symbol ?? spec.symbol, timeframe: ref?.timeframe ?? "M5", open_time: ref?.open_time ?? null,
    volume, internal_ref: internal, broker_ref: broker };
  const done = (outcome: DiscrepancyOutcome, reason: string, d: BarDiscrepancyRecord["ohlc_delta_points"] = null) =>
    Object.freeze<BarDiscrepancyRecord>({ ...base, outcome, reason, ohlc_delta_points: d });
  if (!internal || !broker) return done("INSUFFICIENT_DATA", !internal ? "missing internal aggregated bar" : "missing broker observed bar");
  if (internal.symbol !== broker.symbol || internal.timeframe !== broker.timeframe) return done("NOT_COMPARABLE", "symbol/timeframe differ");
  if (internal.open_time !== broker.open_time) return done("NOT_COMPARABLE", "interval differs");
  if (internal.lifecycle !== "CLOSED") return done("NOT_COMPARABLE", "internal bar still FORMING");
  const pts = (a: number, b: number) => r6(r6(a - b) / spec.point);
  const d = Object.freeze({ open: pts(internal.open, broker.open), high: pts(internal.high, broker.high), low: pts(internal.low, broker.low), close: pts(internal.close, broker.close) });
  const mx = Math.max(...Object.values(d).map(Math.abs));
  if (mx === 0) return done("EXACT", "OHLC equal (volumes not compared)", d);
  if (mx <= tol.maxPriceDeltaPoints) return done("WITHIN_TOLERANCE", `max ${mx} pts`, d);
  return done("MISMATCH", `max ${mx} pts`, d);
}
