import { TIMEFRAME_MS, type Bar, type Timeframe } from "@/core/contracts";
import type { BridgeBar } from "@/core/broker/bridge/types";
import { detectMissingIntervals, type MissingInterval } from "@/core/candles/MissingInterval";
import type { ProbeBar } from "./types";

/** Canonical internal Bar (CandleAggregator output) → probe input. Source Bar is not modified. */
export function fromInternalBars(bars: readonly Bar[]): ProbeBar[] {
  return bars.map((b) => Object.freeze<ProbeBar>({
    symbol: b.symbol, timeframe: b.timeframe, origin: "INTERNAL_REPLAY", open_time: b.open_time, close_time: b.close_time,
    lifecycle: b.status, closed_at: b.closed_at, available_at: b.status === "CLOSED" ? b.available_at : null,
    open: b.open, high: b.high, low: b.low, close: b.close,
  }));
}

/**
 * Broker BACKFILL bars → probe input. Time axis = raw broker clock (raw_time_s × 1000); the broker UTC
 * offset is not exposed by the bar contract, so no offset is applied or guessed.
 * The bar contract exposes no closed/forming flag. A `pos` request starting at 0 includes the bar that is
 * currently forming, so the newest bar of such a request is marked FORMING (conservative, not proven).
 */
export function fromBrokerBars(items: readonly BridgeBar[], opts: { readonly newestMayBeForming: boolean }): ProbeBar[] {
  return items.map((b, i) => {
    const open_time = b.raw_time_s * 1000;
    const close_time = open_time + TIMEFRAME_MS[b.timeframe];
    const forming = opts.newestMayBeForming && i === items.length - 1;
    return Object.freeze<ProbeBar>({
      symbol: b.broker_symbol, timeframe: b.timeframe, origin: "BROKER_OBSERVED", open_time, close_time,
      lifecycle: forming ? "FORMING" : "CLOSED", closed_at: forming ? null : close_time, available_at: forming ? null : close_time,
      open: b.open, high: b.high, low: b.low, close: b.close,
    });
  });
}

export interface PreparedSeries {
  readonly bars: readonly ProbeBar[];
  readonly excluded_forming: number;
  readonly excluded_foreign: number;
  readonly duplicate_open_times: readonly number[];
  readonly out_of_order: boolean;
  readonly gaps: readonly { readonly after_open_time: number; readonly next_open_time: number; readonly missing_count: number }[];
}

/** CLOSED-only, own symbol/timeframe only. Duplicates and ordering are reported, never silently fixed. */
export function prepareSeries(input: readonly ProbeBar[], symbol: string, timeframe: Timeframe): PreparedSeries {
  const own = input.filter((b) => b.symbol === symbol && b.timeframe === timeframe);
  const closed = own.filter((b) => b.lifecycle === "CLOSED" && b.closed_at !== null && b.available_at !== null);
  const out_of_order = closed.some((b, i) => i > 0 && b.open_time < closed[i - 1]!.open_time);
  const sorted = [...closed].sort((a, b) => a.open_time - b.open_time);
  const seen = new Set<number>();
  const dups: number[] = [];
  const bars: ProbeBar[] = [];
  for (const b of sorted) {
    if (seen.has(b.open_time)) { dups.push(b.open_time); continue; } // first kept; duplicate reported
    seen.add(b.open_time);
    bars.push(b);
  }
  const tf = TIMEFRAME_MS[timeframe];
  const gaps = [];
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i]!.open_time - bars[i - 1]!.open_time;
    if (d > tf) gaps.push({ after_open_time: bars[i - 1]!.open_time, next_open_time: bars[i]!.open_time, missing_count: Math.round(d / tf) - 1 });
  }
  return Object.freeze({
    bars: Object.freeze(bars), excluded_forming: own.length - closed.length, excluded_foreign: input.length - own.length,
    duplicate_open_times: Object.freeze(dups), out_of_order, gaps: Object.freeze(gaps),
  });
}

/** Reuses the R5 detector. MissingInterval objects carry no OHLC and never enter indicator input. */
export function missingIntervalsOf(s: PreparedSeries, symbol: string, timeframe: Timeframe, detected_at: number): readonly MissingInterval[] {
  if (s.bars.length < 2) return [];
  const asBars = s.bars.map((b) => ({ symbol: b.symbol, timeframe: b.timeframe, open_time: b.open_time } as Bar));
  return detectMissingIntervals(asBars, s.bars[0]!.open_time, s.bars[s.bars.length - 1]!.close_time, {
    symbol, timeframe, detected_at, source_context: "technical probe CLOSED series",
  });
}

/** index → true if a gap exists between bar i-1 and bar i. */
export function gapBefore(bars: readonly ProbeBar[], timeframe: Timeframe): boolean[] {
  const tf = TIMEFRAME_MS[timeframe];
  return bars.map((b, i) => i > 0 && b.open_time - bars[i - 1]!.open_time > tf);
}
