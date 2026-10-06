import { REGIME_PARAMS, type VolatilityState } from "./types";

/** Fraction of history values <= current ATR. Pure; ATR is injected. */
export function atrPercentile(current: number, history: readonly number[]): number {
  const valid = history.filter((v) => Number.isFinite(v));
  if (valid.length === 0) return REGIME_PARAMS.EMPTY_HISTORY_PERCENTILE;
  return valid.filter((v) => v <= current).length / valid.length;
}

export function classifyVolatility(percentile: number): VolatilityState {
  if (percentile >= REGIME_PARAMS.EXPANSION_PERCENTILE) return "EXPANSION";
  if (percentile <= REGIME_PARAMS.COMPRESSION_PERCENTILE) return "COMPRESSION";
  return "NORMAL";
}
