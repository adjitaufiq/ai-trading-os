import type { ArenaCandle } from "../normalizer/types";
import { TIMEFRAME_SECONDS } from "../normalizer/types";
import { calculationLockGate } from "../candle-manager/closedCandleManager";
import {
  SWING_PARAMS,
  SWING_TIMEFRAMES,
  type SwingPoint,
  type SwingStrength,
  type SwingTimeframe,
  type SwingType,
} from "./types";

export function classifyStrength(ratio: number): SwingStrength {
  if (ratio >= SWING_PARAMS.STRONG_WICK_RATIO) return "STRONG";
  if (ratio >= SWING_PARAMS.NORMAL_WICK_RATIO) return "NORMAL";
  return "WEAK";
}

/** HIGH → upper wick / range; LOW → lower wick / range. Zero range → 0. */
export function rejectionWickRatio(c: ArenaCandle, type: SwingType): number {
  const range = c.high - c.low;
  if (!(range > 0)) return 0;
  const wick = type === "HIGH" ? c.high - Math.max(c.open, c.close) : Math.min(c.open, c.close) - c.low;
  return wick / range;
}

export function isSwingTimeframe(tf: string): tf is SwingTimeframe {
  return (SWING_TIMEFRAMES as readonly string[]).includes(tf);
}

export const swingKey = (s: Pick<SwingPoint, "symbol" | "timeframe" | "type" | "timestamp">) =>
  `${s.symbol}_${s.timeframe}_${s.type}_${s.timestamp}`;

/**
 * Incremental, non-repainting swing detector for ONE symbol+timeframe.
 * Only CLOSED candles pass the M1B.2 gate; a pivot is published only after
 * RIGHT_BARS closed candles follow it. Published swings are never revised.
 */
export class SwingDetector {
  private readonly buf: ArenaCandle[] = [];
  private readonly seen = new Set<string>();
  private readonly swings: SwingPoint[] = [];
  private readonly L = SWING_PARAMS.LEFT_BARS;
  private readonly R = SWING_PARAMS.RIGHT_BARS;

  constructor(readonly symbol: string, readonly timeframe: SwingTimeframe) {
    if (!isSwingTimeframe(timeframe)) throw new Error(`SWING_TIMEFRAME_NOT_ALLOWED: ${timeframe}`);
  }

  /** Returns newly confirmed swings (possibly empty). Rejected candles return []. */
  push(candle: ArenaCandle): SwingPoint[] {
    if (candle.symbol !== this.symbol || candle.timeframe !== this.timeframe) return [];
    if (!calculationLockGate(candle).canCalculate) return [];
    const last = this.buf[this.buf.length - 1];
    if (last && candle.timestamp <= last.timestamp) return []; // closed history is append-only
    this.buf.push(candle);
    const window = this.L + this.R + 1;
    if (this.buf.length > window) this.buf.shift();
    if (this.buf.length < window) return [];

    const pivot = this.buf[this.L]!;
    const left = this.buf.slice(0, this.L);
    const right = this.buf.slice(this.L + 1);
    const confirmedAt = right[right.length - 1]!.timestamp + TIMEFRAME_SECONDS[this.timeframe];
    const out: SwingPoint[] = [];

    if (left.every((c) => pivot.high > c.high) && right.every((c) => pivot.high >= c.high)) {
      const s = this.make(pivot, "HIGH", pivot.high, confirmedAt);
      if (s) out.push(s);
    }
    if (left.every((c) => pivot.low < c.low) && right.every((c) => pivot.low <= c.low)) {
      const s = this.make(pivot, "LOW", pivot.low, confirmedAt);
      if (s) out.push(s);
    }
    return out;
  }

  private make(c: ArenaCandle, type: SwingType, price: number, confirmedAt: number): SwingPoint | null {
    const ratio = rejectionWickRatio(c, type);
    const s: SwingPoint = Object.freeze({
      id: "",
      symbol: this.symbol,
      timeframe: this.timeframe,
      type,
      price,
      timestamp: c.timestamp,
      confirmedAt,
      strength: classifyStrength(ratio),
      leftBars: this.L,
      rightBars: this.R,
      rejectionWickRatio: ratio,
    });
    const id = swingKey(s);
    if (this.seen.has(id)) return null;
    this.seen.add(id);
    const frozen = Object.freeze({ ...s, id });
    this.swings.push(frozen);
    return frozen;
  }

  getSwings(): readonly SwingPoint[] {
    return this.swings.slice();
  }
}
