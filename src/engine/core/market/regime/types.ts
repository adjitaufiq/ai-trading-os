// M1B.9 — Market Regime Engine contracts.
// PASSIVE, READ-ONLY, DIAGNOSTIC. Authority: NONE. Classification + evidence only.
import type { MarketStructure } from "../../swing/types";

export type MarketRegimeType =
  | "TREND_CONTINUATION"
  | "RANGE_COMPRESSION"
  | "VOLATILITY_EXPANSION"
  | "TRANSITION"
  | "TREND_EXHAUSTION";

export type TrendAlignment = "ALIGNED" | "CONFLICT" | "NEUTRAL";
export type VolatilityState = "COMPRESSION" | "NORMAL" | "EXPANSION";
export type HigherTfBias = "BULLISH" | "BEARISH" | "NEUTRAL";

export interface StructureContextSummary {
  monthly: HigherTfBias | "UNAVAILABLE";
  weekly: HigherTfBias | "UNAVAILABLE";
  daily: HigherTfBias | "UNAVAILABLE";
  h4: "BULLISH" | "BEARISH" | "RANGE";
  h1: "BULLISH" | "BEARISH" | "PULLBACK" | "EXPANSION" | "CHOP";
}

export interface RangeContextSummary {
  rangeWidth: number;
  atrCurrent: number;
  atrPercentile: number;
  atrState: VolatilityState;
}

export interface MarketRegimeSnapshot {
  readonly symbol: string;
  readonly asOf: number;
  readonly regime: MarketRegimeType;
  readonly trendAlignment: TrendAlignment;
  readonly volatility: VolatilityState;
  readonly structureContext: StructureContextSummary;
  readonly rangeContext: RangeContextSummary;
  readonly evidence: readonly string[];
  readonly algorithmVersion: "m1b9-regime-v1";
}

export interface MarketRegimeInput {
  symbol: string;
  now: number;
  h4Structure: MarketStructure;
  h1Structure: MarketStructure;
  m15Atr: number;
  historicalAtrList: readonly number[];
  higherTfContext?: { daily?: HigherTfBias; weekly?: HigherTfBias; monthly?: HigherTfBias };
}

export const REGIME_ALGORITHM_VERSION = "m1b9-regime-v1" as const;

export const REGIME_PARAMS = {
  /** atrPercentile >= this ⇒ EXPANSION. */
  EXPANSION_PERCENTILE: 0.85,
  /** atrPercentile <= this ⇒ COMPRESSION. */
  COMPRESSION_PERCENTILE: 0.25,
  /** H4 swing-leg overlap (overlap / narrower leg width) >= this ⇒ high overlap. */
  HIGH_SWING_OVERLAP_RATIO: 0.8,
  /** H4 swing progression (|ΔHigh| and |ΔLow|) < this × m15Atr ⇒ momentum flattening. */
  H4_FLATTENING_ATR_MULT: 0.5,
  /** Percentile used when historicalAtrList is empty (treated as NORMAL, flagged in evidence). */
  EMPTY_HISTORY_PERCENTILE: 0.5,
} as const;

export const REGIME_RULES = {
  PERCENTILE: "fraction of historicalAtrList values <= m15Atr (injected; never computed here)",
  PRECEDENCE: "1 VOLATILITY_EXPANSION → 2 TRANSITION → 3 TREND_EXHAUSTION → 4 RANGE_COMPRESSION → 5 TREND_CONTINUATION; no match ⇒ TRANSITION",
  TRANSITION: "H4 vs H1 conflict, MSS detected (structure not yet re-confirmed), or high H4 swing overlap",
  EXHAUSTION: "ALIGNED and (H4 swing progression flattening or ATR COMPRESSION)",
  TEMPORAL: "swings with confirmedAt > now are ignored",
  FORBIDDEN: "no BUY/SELL, no style advice, no SL/TP/lot/risk, no scores/confidence",
} as const;
