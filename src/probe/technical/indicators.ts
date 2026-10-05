import type { Timeframe } from "@/core/contracts";
import { gapBefore } from "./inputs";
import type { ContinuityStatus, ProbeBar, SeriesPoint } from "./types";

// Inputs MUST be a prepared CLOSED-only, single-symbol, single-timeframe series (see prepareSeries).

function continuityTrack(bars: readonly ProbeBar[], tf: Timeframe): ContinuityStatus[] {
  const g = gapBefore(bars, tf);
  let broken = false;
  return bars.map((_, i) => { if (g[i]) broken = true; return broken ? "DISCONTINUOUS_MISSING_INTERVAL" : "CONTINUOUS"; });
}

/** EMA(N): seed = SMA of first N closes; then EMA_t = α·close_t + (1−α)·EMA_(t−1), α = 2/(N+1). No state reset on gaps. */
export function ema(bars: readonly ProbeBar[], period: number, tf: Timeframe): SeriesPoint[] {
  const alpha = 2 / (period + 1);
  const cont = continuityTrack(bars, tf);
  const out: SeriesPoint[] = [];
  let prev: number | null = null;
  let sum = 0;
  bars.forEach((b, i) => {
    let value: number | null = null;
    if (i < period - 1) sum += b.close;
    else if (i === period - 1) { sum += b.close; value = sum / period; }
    else value = alpha * b.close + (1 - alpha) * (prev as number);
    if (value !== null) prev = value;
    out.push(Object.freeze<SeriesPoint>({
      open_time: b.open_time, available_at: b.available_at!, value,
      status: value === null ? "WARMUP_UNSATISFIED" : "VALID", continuity: value === null ? "WARMUP_UNSATISFIED" : cont[i]!,
    }));
  });
  return out;
}

export interface TrPoint {
  readonly open_time: number;
  readonly tr: number | null;
  readonly status: "NO_PREVIOUS_CLOSE" | "VALID";
  /** true if previous_close comes from a bar separated by a missing interval (never fabricated). */
  readonly previous_close_across_gap: boolean;
}

/** TR_t = max(H−L, |H−prevC|, |L−prevC|). Bar 0 has no previous close: tr = null, explicitly. */
export function trueRange(bars: readonly ProbeBar[], tf: Timeframe): TrPoint[] {
  const g = gapBefore(bars, tf);
  return bars.map((b, i) => {
    if (i === 0) return Object.freeze<TrPoint>({ open_time: b.open_time, tr: null, status: "NO_PREVIOUS_CLOSE", previous_close_across_gap: false });
    const pc = bars[i - 1]!.close;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    return Object.freeze<TrPoint>({ open_time: b.open_time, tr, status: "VALID", previous_close_across_gap: g[i]! });
  });
}

/**
 * ATR(N) Wilder/RMA. First valid TR = bar index 1. Initial ATR = SMA of TR at bar indices 1..N,
 * so the first valid ATR is at bar index N (the (N+1)th CLOSED bar). Then ATR_t = (ATR_(t−1)·(N−1) + TR_t)/N.
 */
export function atr(bars: readonly ProbeBar[], period: number, tf: Timeframe): SeriesPoint[] {
  const trs = trueRange(bars, tf);
  const cont = continuityTrack(bars, tf);
  let prev: number | null = null;
  let sum = 0;
  return bars.map((b, i) => {
    const tr = trs[i]!.tr;
    let value: number | null = null;
    if (tr !== null) {
      if (i < period) sum += tr;
      else if (i === period) { sum += tr; value = sum / period; }
      else value = ((prev as number) * (period - 1) + tr) / period;
    }
    if (value !== null) prev = value;
    return Object.freeze<SeriesPoint>({
      open_time: b.open_time, available_at: b.available_at!, value,
      status: value === null ? "WARMUP_UNSATISFIED" : "VALID", continuity: value === null ? "WARMUP_UNSATISFIED" : cont[i]!,
    });
  });
}
