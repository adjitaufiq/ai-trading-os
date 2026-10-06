// M1B.7 — M5 reaction & candle trigger evaluator contracts.
// Consumes ONLY CLOSED M5 ArenaCandles, M15 PriceContext (M1B.5), EMAContext (M1B.6)
// and an ATR value. Telemetry only: no BUY/SELL, no SL/TP/lot, never overrides location.

export type CandlePattern =
  | "BULLISH_ENGULFING"
  | "BEARISH_ENGULFING"
  | "BULLISH_REJECTION_WICK"
  | "BEARISH_REJECTION_WICK"
  | "PINBAR"
  | "INSIDE_BAR"
  | "MARUBOZU"
  | "NONE";

export type ReactionQuality = "NONE" | "WEAK" | "MODERATE" | "STRONG";
export type TriggerDirection = "BULLISH" | "BEARISH" | "NEUTRAL";

export interface ReactionResult {
  symbol: string;
  timeframe: "M5";
  pattern: CandlePattern;
  direction: TriggerDirection;
  quality: ReactionQuality;
  isValid: boolean;
  locationConfirmed: boolean;
  emaContextConfirmed: boolean;
  candleTimestamp: number;
  description: string;
}

export type ReactionFailureReason =
  | "RUNNING_CANDLE"
  | "INVALID_TIMEFRAME"
  | "SYMBOL_MISMATCH"
  | "NON_CONSECUTIVE_CANDLES"
  | "INVALID_ATR";

export type ReactionEvaluation = { ok: true; result: ReactionResult } | { ok: false; reason: ReactionFailureReason };

export const REACTION_POLICY_VERSION = "reaction-m1b7-v1";

export const REACTION_PARAMS = {
  REJECTION_WICK_MIN: 0.5,
  PINBAR_BODY_MAX: 0.35,
  PINBAR_WICK_MIN: 0.55,
  MARUBOZU_BODY_MIN: 0.85,
  /** "Minimal wick": each wick <= this fraction of range. */
  MARUBOZU_WICK_MAX: 0.1,
  /** STRONG requires candle range >= this × ATR. */
  STRONG_RANGE_ATR_MULT: 1.0,
} as const;

export const REACTION_RULES = {
  PRIORITY: ["ENGULFING", "MARUBOZU", "PINBAR", "REJECTION_WICK", "INSIDE_BAR", "NONE"],
  BULLISH_ENGULFING: "prev red, cur green, cur.open <= prev.close, cur.close >= prev.open",
  BEARISH_ENGULFING: "prev green, cur red, cur.open >= prev.close, cur.close <= prev.open",
  REJECTION_WICK: "dominant wick/range >= 0.5 AND body colour matches (lower+green ⇒ bullish, upper+red ⇒ bearish)",
  PINBAR: "body/range <= 0.35 AND one wick >= 0.55*range; direction = side of the long wick",
  INSIDE_BAR: "cur.high <= prev.high AND cur.low >= prev.low — compression, NEUTRAL, never valid",
  MARUBOZU: "body/range >= 0.85 AND each wick <= 0.1*range; direction = colour",
  LOCATION_CONFIRMED: "BULLISH at AT_SUPPORT or BEARISH at AT_RESISTANCE (M1B.5); other locations never confirm",
  EMA_CONFIRMED: "BULLISH: EMA21_RETEST|EMA21_REJECT_UP|EMA50_SUPPORT; BEARISH: EMA21_RETEST|EMA21_REJECT_DOWN|EMA50_RESISTANCE",
  STRONG: "directional pattern AND location AND EMA AND range >= 1.0*ATR",
  MODERATE: "directional pattern AND (location OR EMA)",
  WEAK: "pattern exists but no location/EMA support (or neutral pattern)",
  VALID: "quality STRONG or MODERATE",
} as const;
