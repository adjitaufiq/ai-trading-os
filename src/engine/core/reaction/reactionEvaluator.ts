import type { ArenaCandle } from "../normalizer/types";
import { TIMEFRAME_SECONDS } from "../normalizer/types";
import type { PriceContext } from "../location/types";
import type { EMAAction, EMAContext } from "../ema/types";
import { detectCandlePattern, patternDirection } from "./candlePatternDetector";
import {
  REACTION_PARAMS as P,
  type CandlePattern,
  type ReactionEvaluation,
  type ReactionQuality,
  type TriggerDirection,
} from "./types";

const BULL_EMA: EMAAction[] = ["EMA21_RETEST", "EMA21_REJECT_UP", "EMA50_SUPPORT"];
const BEAR_EMA: EMAAction[] = ["EMA21_RETEST", "EMA21_REJECT_DOWN", "EMA50_RESISTANCE"];

export function isLocationConfirmed(dir: TriggerDirection, loc: PriceContext): boolean {
  return (dir === "BULLISH" && loc.priceLocation === "AT_SUPPORT") || (dir === "BEARISH" && loc.priceLocation === "AT_RESISTANCE");
}

export function isEmaConfirmed(dir: TriggerDirection, ema: EMAContext): boolean {
  if (dir === "NEUTRAL") return false;
  const want = dir === "BULLISH" ? BULL_EMA : BEAR_EMA;
  return ema.actions.some((a) => want.includes(a));
}

export function evaluateReactionQuality(
  pattern: CandlePattern, dir: TriggerDirection, loc: boolean, ema: boolean, range: number, atr: number,
): ReactionQuality {
  if (pattern === "NONE") return "NONE";
  if (dir === "NEUTRAL") return "WEAK";
  if (loc && ema && range >= atr * P.STRONG_RANGE_ATR_MULT) return "STRONG";
  if (loc || ema) return "MODERATE";
  return "WEAK";
}

export interface ReactionInput {
  previous: ArenaCandle;
  current: ArenaCandle;
  priceContext: PriceContext;
  emaContext: EMAContext;
  atr: number;
}

export function evaluateReaction(input: ReactionInput): ReactionEvaluation {
  const { previous: p, current: c, priceContext, emaContext, atr } = input;
  if (!p.isClosed || !c.isClosed) return { ok: false, reason: "RUNNING_CANDLE" };
  if (p.timeframe !== "M5" || c.timeframe !== "M5") return { ok: false, reason: "INVALID_TIMEFRAME" };
  if (p.symbol !== c.symbol || emaContext.symbol !== c.symbol) return { ok: false, reason: "SYMBOL_MISMATCH" };
  if (c.timestamp - p.timestamp !== TIMEFRAME_SECONDS.M5) return { ok: false, reason: "NON_CONSECUTIVE_CANDLES" };
  if (!Number.isFinite(atr) || atr <= 0) return { ok: false, reason: "INVALID_ATR" };

  const pattern = detectCandlePattern(p, c);
  const direction = patternDirection(pattern, c);
  const locationConfirmed = pattern !== "NONE" && isLocationConfirmed(direction, priceContext);
  const emaContextConfirmed = pattern !== "NONE" && isEmaConfirmed(direction, emaContext);
  const quality = evaluateReactionQuality(pattern, direction, locationConfirmed, emaContextConfirmed, c.high - c.low, atr);
  const isValid = quality === "STRONG" || quality === "MODERATE";

  const parts = [`M5 ${pattern === "NONE" ? "no pattern" : `${direction.toLowerCase()} ${pattern}`}`];
  parts.push(locationConfirmed ? `at M15 ${priceContext.priceLocation}` : `location ${priceContext.priceLocation} not confirming`);
  if (emaContextConfirmed) parts.push(`EMA ${emaContext.actions.filter((a) => (direction === "BULLISH" ? BULL_EMA : BEAR_EMA).includes(a)).join("/")}`);

  return {
    ok: true,
    result: Object.freeze({
      symbol: c.symbol, timeframe: "M5" as const, pattern, direction, quality, isValid,
      locationConfirmed, emaContextConfirmed, candleTimestamp: c.timestamp, description: parts.join(" | "),
    }),
  };
}
