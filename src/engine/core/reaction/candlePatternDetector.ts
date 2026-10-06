import type { ArenaCandle } from "../normalizer/types";
import { REACTION_PARAMS as P, type CandlePattern, type TriggerDirection } from "./types";

const body = (c: ArenaCandle) => Math.abs(c.close - c.open);
const upper = (c: ArenaCandle) => c.high - Math.max(c.open, c.close);
const lower = (c: ArenaCandle) => Math.min(c.open, c.close) - c.low;
const green = (c: ArenaCandle) => c.close > c.open;
const red = (c: ArenaCandle) => c.close < c.open;

/** Pure detector. Running candles (either input) ⇒ NONE (never pattern-matched). */
export function detectCandlePattern(previous: ArenaCandle, current: ArenaCandle): CandlePattern {
  if (!previous.isClosed || !current.isClosed) return "NONE";
  const range = current.high - current.low;
  if (!(range > 0)) return "NONE";

  if (red(previous) && green(current) && current.open <= previous.close && current.close >= previous.open)
    return "BULLISH_ENGULFING";
  if (green(previous) && red(current) && current.open >= previous.close && current.close <= previous.open)
    return "BEARISH_ENGULFING";

  const b = body(current) / range, u = upper(current) / range, l = lower(current) / range;
  if (b >= P.MARUBOZU_BODY_MIN && u <= P.MARUBOZU_WICK_MAX && l <= P.MARUBOZU_WICK_MAX && current.close !== current.open)
    return "MARUBOZU";
  if (b <= P.PINBAR_BODY_MAX && (l >= P.PINBAR_WICK_MIN || u >= P.PINBAR_WICK_MIN)) return "PINBAR";
  if (l >= P.REJECTION_WICK_MIN && green(current)) return "BULLISH_REJECTION_WICK";
  if (u >= P.REJECTION_WICK_MIN && red(current)) return "BEARISH_REJECTION_WICK";
  if (current.high <= previous.high && current.low >= previous.low) return "INSIDE_BAR";
  return "NONE";
}

export function patternDirection(pattern: CandlePattern, current: ArenaCandle): TriggerDirection {
  switch (pattern) {
    case "BULLISH_ENGULFING":
    case "BULLISH_REJECTION_WICK":
      return "BULLISH";
    case "BEARISH_ENGULFING":
    case "BEARISH_REJECTION_WICK":
      return "BEARISH";
    case "MARUBOZU":
      return green(current) ? "BULLISH" : "BEARISH";
    case "PINBAR":
      return lower(current) >= upper(current) ? "BULLISH" : "BEARISH";
    default:
      return "NEUTRAL";
  }
}
