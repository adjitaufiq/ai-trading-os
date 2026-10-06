import type { ArenaCandle } from "../normalizer/types";
import { EMA_PARAMS, type EMAPeriod, type EMASlope } from "./types";

export function minHistoryFor(period: number): number {
  return (EMA_PARAMS.MIN_HISTORY as Record<number, number>)[period] ?? period * EMA_PARAMS.MIN_HISTORY_FALLBACK_MULT;
}

/**
 * EMA over CLOSED candles only. Result is aligned to the closed-candle array:
 * index i holds EMA at closed[i], indices < period-1 are NaN (no estimate).
 */
export function calculateEMA(candles: readonly ArenaCandle[], period: EMAPeriod | number): number[] | "INSUFFICIENT_HISTORY" {
  const closed = candles.filter((c) => c.isClosed);
  if (!Number.isInteger(period) || period < 1 || closed.length < minHistoryFor(period)) return "INSUFFICIENT_HISTORY";
  const k = 2 / (period + 1);
  const out: number[] = new Array(closed.length).fill(Number.NaN);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += closed[i]!.close;
  let ema = seed / period;
  out[period - 1] = ema;
  for (let i = period; i < closed.length; i++) {
    ema = closed[i]!.close * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

export function classifySlope(series: readonly number[], atr: number, lookback: number = EMA_PARAMS.SLOPE_LOOKBACK): EMASlope {
  const now = series[series.length - 1]!;
  const then = series[series.length - 1 - lookback]!;
  const diff = now - then;
  if (!Number.isFinite(diff) || Math.abs(diff) <= atr * EMA_PARAMS.FLAT_ATR_MULT) return "FLAT";
  return diff > 0 ? "RISING" : "FALLING";
}
