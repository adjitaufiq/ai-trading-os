import type { ArenaCandle } from "../../normalizer/types";

export const T0 = 1_700_000_000;

export function bar(i: number, open: number, close: number, high?: number, low?: number, isClosed = true): ArenaCandle {
  return {
    id: `c${i}`, symbol: "XAUUSD", timeframe: "M15", timestamp: T0 + i * 900,
    open, high: high ?? Math.max(open, close) + 1, low: low ?? Math.min(open, close) - 1, close,
    volume: 0, spread: 0, source: "MT5", isClosed, sequence: i + 1,
  };
}

export function series(closes: number[]): ArenaCandle[] {
  return closes.map((c, i) => bar(i, i === 0 ? c : closes[i - 1]!, c));
}

export const range = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));
