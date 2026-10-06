// M1B.6 — Dynamic EMA state engine contracts.
// Consumes ONLY CLOSED M5/M15 ArenaCandles. Context telemetry only:
// no BUY/SELL, no SL/TP, never overrides price location (M1B.5).

export type EMAPeriod = 5 | 21 | 50;
export type EMATimeframe = "M5" | "M15";

export interface EMAValues {
  symbol: string;
  timeframe: EMATimeframe;
  timestamp: number;
  ema5: number;
  ema21: number;
  ema50: number;
}

export type EMASlope = "RISING" | "FALLING" | "FLAT";

export type EMAAction =
  | "EMA5_ABOVE_EMA21"
  | "EMA5_BELOW_EMA21"
  | "EMA21_RETEST"
  | "EMA21_REJECT_UP"
  | "EMA21_REJECT_DOWN"
  | "EMA50_SUPPORT"
  | "EMA50_RESISTANCE"
  | "EMA_COMPRESSION"
  | "EMA_EXPANSION"
  | "NONE";

export type EMAPricePosition = "ABOVE_ALL" | "BELOW_ALL" | "BETWEEN_EMA21_EMA50" | "INSIDE_EMA_ZONE";

export interface EMAContext {
  symbol: string;
  timeframe: EMATimeframe;
  values: EMAValues;
  slope21: EMASlope;
  slope50: EMASlope;
  pricePosition: EMAPricePosition;
  actions: EMAAction[];
  distanceToEMA21: number;
  distanceToEMA50: number;
  compression: boolean;
  expansion: boolean;
  updatedAt: number;
}

export type EMAFailureReason = "INSUFFICIENT_HISTORY" | "INVALID_TIMEFRAME" | "INSUFFICIENT_ATR_HISTORY";
export type EMAContextResult = { ok: true; context: EMAContext } | { ok: false; reason: EMAFailureReason };

export const EMA_POLICY_VERSION = "ema-m1b6-v1";

export const EMA_PARAMS = {
  /** Minimum CLOSED candles per period; otherwise INSUFFICIENT_HISTORY (never estimated). */
  MIN_HISTORY: { 5: 10, 21: 40, 50: 100 } as Record<EMAPeriod, number>,
  /** Fallback minimum for non-standard periods: 2×period. */
  MIN_HISTORY_FALLBACK_MULT: 2,
  /** Seed = SMA of first `period` closes, then standard recursion k=2/(p+1). */
  SEED: "SMA",
  SLOPE_LOOKBACK: 3,
  /** |EMA_now − EMA_lookback| <= this × ATR14 ⇒ FLAT. */
  FLAT_ATR_MULT: 0.05,
  ATR_PERIOD: 14,
  /** |close − EMA21| <= this × ATR ⇒ near EMA21 (retest proximity). */
  RETEST_ATR_MULT: 0.15,
  /** Number of prior bars that must all have been away from EMA21 for a retest. */
  RETEST_AWAY_BARS: 3,
  /** Rejection: current close must be at least this × ATR away from the EMA. */
  REJECT_AWAY_ATR_MULT: 0.15,
  /** Compression/expansion: compare EMA gaps now vs this many bars ago. */
  GAP_LOOKBACK: 3,
} as const;

export const EMA_RULES = {
  TOUCH: "bar touches EMA when low <= EMA(bar) <= high",
  RETEST: "|close-EMA21| <= 0.15*ATR AND previous 3 closes each > 0.15*ATR from their EMA21",
  REJECT_UP: "previous bar touched EMA21 AND current bar bullish (close>open) AND close >= EMA21 + 0.15*ATR",
  REJECT_DOWN: "previous bar touched EMA21 AND current bar bearish AND close <= EMA21 - 0.15*ATR",
  EMA50_SUPPORT: "same as REJECT_UP using EMA50",
  EMA50_RESISTANCE: "same as REJECT_DOWN using EMA50",
  COMPRESSION: "|EMA5-EMA21| AND |EMA21-EMA50| both strictly smaller than 3 bars ago",
  EXPANSION: "|EMA5-EMA21| AND |EMA21-EMA50| both strictly larger than 3 bars ago",
  PRICE_POSITION: "ABOVE_ALL > BELOW_ALL > BETWEEN_EMA21_EMA50 (strictly) > INSIDE_EMA_ZONE (fallback: mixed/touching cluster)",
  DISTANCES: "absolute |close-EMA|",
} as const;
