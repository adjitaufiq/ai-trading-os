// M1B.1 — bounded candle storage. Max 500 candles per symbol+timeframe;
// oldest evicted first. Duplicates are never inserted.
import type { ArenaCandle, Timeframe } from "./types";

export const MAX_CANDLES_PER_SERIES = 500;

function keyOf(symbol: string, timeframe: Timeframe): string {
  return `${symbol}_${timeframe}`;
}

export class CandleStore {
  private readonly series = new Map<string, ArenaCandle[]>();

  /** Latest stored candle for a series (feeds RULE B/C/D of the normalizer). */
  last(symbol: string, timeframe: Timeframe): ArenaCandle | undefined {
    const arr = this.series.get(keyOf(symbol, timeframe));
    return arr?.[arr.length - 1];
  }

  /**
   * Insert a normalized candle. Returns false without inserting when a candle
   * with the same symbol+timeframe+timestamp already exists.
   */
  insert(candle: ArenaCandle): boolean {
    const key = keyOf(candle.symbol, candle.timeframe);
    let arr = this.series.get(key);
    if (!arr) {
      arr = [];
      this.series.set(key, arr);
    }
    if (arr.some((c) => c.timestamp === candle.timestamp)) return false;
    arr.push(candle);
    while (arr.length > MAX_CANDLES_PER_SERIES) arr.shift();
    return true;
  }

  get(symbol: string, timeframe: Timeframe): readonly ArenaCandle[] {
    return this.series.get(keyOf(symbol, timeframe)) ?? [];
  }

  size(symbol: string, timeframe: Timeframe): number {
    return this.series.get(keyOf(symbol, timeframe))?.length ?? 0;
  }
}
