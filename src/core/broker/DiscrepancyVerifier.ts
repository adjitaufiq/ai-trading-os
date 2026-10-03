import type { Bar } from "../contracts";
import type { DiscrepancyMetrics, DiscrepancyResult, NormalizedBrokerBar, SymbolSpecification } from "./types";

/** Configurable tolerances. Defaults are placeholders until TRS-03 measures reality. */
export interface DiscrepancyTolerance {
  maxPriceDeltaPoints: number;
  /** null = tick volume not judged. */
  maxTickVolumeDelta: number | null;
  maxOpenTimeDeltaMs: number;
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export function verifyBar(
  internal: Bar | null,
  broker: NormalizedBrokerBar | null,
  spec: SymbolSpecification,
  tol: DiscrepancyTolerance,
): DiscrepancyResult {
  const ref = internal ?? broker;
  const base = { symbol: ref?.symbol ?? spec.symbol, timeframe: ref?.timeframe ?? "M5", open_time: ref?.open_time ?? null } as const;
  if (!internal || !broker) {
    return { ...base, outcome: "INSUFFICIENT_DATA", reason: !internal ? "missing internal candle" : "missing broker candle", metrics: null };
  }
  if (internal.symbol !== broker.symbol || internal.timeframe !== broker.timeframe) {
    return { ...base, outcome: "NOT_COMPARABLE", reason: "symbol/timeframe differ", metrics: null };
  }
  if (internal.status !== "CLOSED") {
    return { ...base, outcome: "NOT_COMPARABLE", reason: "internal candle still FORMING", metrics: null };
  }
  const p = spec.point;
  const d = (a: number, b: number) => r6(a - b);
  const pts = (x: number) => r6(x / p);
  const m: DiscrepancyMetrics = {
    open_delta_price: d(internal.open, broker.open),
    high_delta_price: d(internal.high, broker.high),
    low_delta_price: d(internal.low, broker.low),
    close_delta_price: d(internal.close, broker.close),
    open_delta_points: 0, high_delta_points: 0, low_delta_points: 0, close_delta_points: 0,
    tick_volume_delta: internal.tick_count - broker.tick_volume,
    real_volume_delta: null, // internal aggregator does not track real volume
    open_time_delta_ms: internal.open_time - broker.open_time,
    closure_observation_delta_ms: internal.closed_at === null ? null : internal.closed_at - broker.observed_at,
  };
  m.open_delta_points = pts(m.open_delta_price);
  m.high_delta_points = pts(m.high_delta_price);
  m.low_delta_points = pts(m.low_delta_price);
  m.close_delta_points = pts(m.close_delta_price);

  if (Math.abs(m.open_time_delta_ms) > tol.maxOpenTimeDeltaMs) {
    return { ...base, outcome: "NOT_COMPARABLE", reason: "open_time differs beyond tolerance", metrics: m };
  }
  const ptsAll = [m.open_delta_points, m.high_delta_points, m.low_delta_points, m.close_delta_points].map(Math.abs);
  const volOk = tol.maxTickVolumeDelta === null || Math.abs(m.tick_volume_delta) <= tol.maxTickVolumeDelta;
  const volExact = tol.maxTickVolumeDelta === null || m.tick_volume_delta === 0;
  if (ptsAll.every((x) => x === 0) && volExact && m.open_time_delta_ms === 0) {
    return { ...base, outcome: "EXACT", reason: "all compared fields equal", metrics: m };
  }
  if (ptsAll.every((x) => x <= tol.maxPriceDeltaPoints) && volOk) {
    return { ...base, outcome: "WITHIN_TOLERANCE", reason: `max ${Math.max(...ptsAll)} pts`, metrics: m };
  }
  return { ...base, outcome: "MISMATCH", reason: `max ${Math.max(...ptsAll)} pts, tick vol Δ ${m.tick_volume_delta}`, metrics: m };
}
