// M1B.10 — Adaptive Trading Horizon Classifier contracts.
// PASSIVE market-context observation. Authority: NONE. No BUY/SELL, SL/TP, lot, risk or scores.
import type { MarketStructure } from "../../swing/types";
import type { MarketRegimeSnapshot } from "../regime/types";
import type { InstitutionalFootprints } from "../institutional-radar/types";

export type TradingHorizon = "SCALPING" | "INTRADAY" | "SWING" | "NO_FIT";
export type MarketApproach = "MOMENTUM" | "MEAN_REVERSION" | "TREND_FOLLOW" | "NO_CLEAR_EDGE";
export type HoldingEnvironment = "SHORT_HORIZON" | "SESSION_HORIZON" | "POSITION_HORIZON" | "DEFENSIVE_HOLD";

/** Injected sign-only M5 momentum observation (never computed here). */
export type M5MomentumObservation = "BULLISH" | "BEARISH" | "NONE" | "UNAVAILABLE";

export interface HorizonEvidence {
  readonly macroTrend: "BULLISH" | "BEARISH" | "NEUTRAL";
  readonly intradayStructure: "CLEAN" | "MESSY";
  readonly microCondition: "MOMENTUM" | "RANGE" | "NOISE";
  readonly atrPercentile: number;
  readonly tags: readonly string[];
}

export interface HorizonClassifierInput {
  symbol: string;
  /** Evaluation time (epoch seconds); anything observed after this is ignored. */
  now: number;
  /** M1B.9 frozen snapshot. */
  regime: MarketRegimeSnapshot;
  /** Confirmed M15 structure (M1B.3); used for range boundaries / intraday cleanliness. */
  m15Structure: MarketStructure;
  /** Injected M5 momentum sign; defaults to UNAVAILABLE. */
  m5Momentum?: M5MomentumObservation;
  /** Optional M1B.8 footprints — metadata tags only, never decide horizon. */
  footprints?: InstitutionalFootprints | null;
}

export interface TradingStyleContext {
  readonly symbol: string;
  readonly asOf: number;
  readonly regimeSnapshotId: string;
  readonly recommendedHorizon: TradingHorizon;
  readonly compatibleHorizons: readonly TradingHorizon[];
  readonly marketApproach: MarketApproach;
  readonly holdingEnvironment: HoldingEnvironment;
  readonly horizonEvidence: HorizonEvidence;
  readonly evidence: readonly string[];
  readonly algorithmVersion: "m1b10-style-v1";
}

export const HORIZON_ALGORITHM_VERSION = "m1b10-style-v1" as const;

export const HORIZON_PARAMS = {
  /** atrPercentile <= this (AND narrow range) ⇒ dead market. */
  DEAD_ATR_PERCENTILE: 0.1,
  /** H4 rangeWidth < this × atrCurrent ⇒ range "too small" for dead-market check. */
  DEAD_RANGE_ATR_MULT: 1.0,
  /** M15 boundary width >= this × atrCurrent ⇒ boundaries "clear" for range scalping. */
  MIN_M15_RANGE_ATR_MULT: 1.0,
} as const;

export const HORIZON_RULES = {
  P1: "regime VOLATILITY_EXPANSION | TRANSITION | TREND_EXHAUSTION ⇒ NO_FIT (REGIME_UNSTABLE_VETO)",
  P2: "atrPercentile <= DEAD_ATR_PERCENTILE AND rangeWidth < DEAD_RANGE_ATR_MULT×ATR ⇒ NO_FIT (DEAD_MARKET_NO_EDGE)",
  P3: "RANGE_COMPRESSION AND confirmed M15 high+low (confirmedAt<=now) width >= MIN_M15_RANGE_ATR_MULT×ATR ⇒ SCALPING/MEAN_REVERSION",
  P4: "TREND_CONTINUATION ⇒ INTRADAY/TREND_FOLLOW; daily+weekly == H4 ⇒ SWING/POSITION_HORIZON",
  P5: "P4 AND (daily or, if unavailable, H4) aligned AND M15 trend == H4 without MSS (clean pullback structure) AND M5 momentum == H4 ⇒ +SCALPING, MOMENTUM",
  FALLBACK: "no rule matched ⇒ NO_FIT (NO_COMPATIBLE_HORIZON)",
  TEMPORAL: "regime.asOf > now ⇒ NO_FIT; swings confirmedAt > now and footprints timestamp > now ignored",
  FORBIDDEN: "no BUY/SELL, SL/TP, lot, risk, scores, confidence or probability",
} as const;
