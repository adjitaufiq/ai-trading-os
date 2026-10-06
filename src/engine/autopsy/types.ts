// M6.5 — Trade autopsy contracts. READ-ONLY forensic layer over M6 journal rows.
// Never modifies trades, SL/TP, parameters or signals; never optimizes.

export type FailureCategory =
  | "LIQUIDITY_SWEEP"
  | "WRONG_LOCATION"
  | "BIAS_CONFLICT"
  | "VOLATILITY_FAILURE"
  | "TRIGGER_FAILURE"
  | "EXECUTION_FAILURE"
  | "NO_FAILURE"
  /** Loss where no rule matched or evidence was missing. Added so unknowns are never forced into a category. */
  | "UNCLASSIFIED";

export type ConfidenceLevel = "LOW" | "MEDIUM" | "HIGH";

export interface AutopsyEvidence {
  metric: string;
  expected: string;
  actual: string;
  passed: boolean;
}

export interface TradeAutopsy {
  tradeId: string;
  result: "WIN" | "LOSS" | "BREAK_EVEN";
  primaryFailure: FailureCategory;
  secondaryFactors: string[];
  confidence: ConfidenceLevel;
  evidence: AutopsyEvidence[];
  recommendation: string;
  analysisTimestamp: number;
  policyVersion: string;
}

export interface Ohlc { high: number; low: number; open?: number; close?: number }

export interface AutopsyMarketData {
  /** CLOSED bars while the trade was open. */
  tradeBars: readonly Ohlc[];
  /** CLOSED bars after the trade closed. */
  futureCandles: readonly Ohlc[];
  atr: number | null;
  spreadAtEntry?: number;
  normalSpread?: number;
  execution?: { plannedEntry: number; actualEntry: number; latencyMs: number };
}

export interface PostTradeMovement {
  maxMoveAgainst: number;
  maxMoveInFavor: number;
  returnedToEntry: boolean;
  continuedDirection: boolean;
}

export interface RuleAudit {
  condition: string;
  sampleSize: number;
  winRate: number;
  failureRate: number;
  expectancy: number;
}

export interface FailureDistribution {
  analyzed: number;
  losses: number;
  /** Fraction 0..1 of losses per category. */
  breakdown: Partial<Record<FailureCategory, number>>;
  highestImpact: FailureCategory | null;
}

export const AUTOPSY_POLICY_VERSION = "autopsy-m6.5-v1";

export const AUTOPSY_PARAMS = {
  SWEEP_LOOKAHEAD_BARS: 10,
  SWEEP_MIN_RECOVERY_R: 1.0,
  INVALID_LOCATIONS: ["MID_RANGE", "NO_TIER"] as readonly string[],
  STRONG_H1_PHASES: ["CONTINUATION"] as readonly string[],
  VOLATILITY_CANDLE_ATR: 3.0,
  VOLATILITY_SPREAD_MULT: 2.0,
  EXECUTION_FILL_DEVIATION_R: 0.2,
  EXECUTION_MAX_LATENCY_MS: 1000,
  TRIGGER_IMMEDIATE_BARS: 3,
  TRIGGER_MAX_FAVOR_R: 0.3,
} as const;

/** Priority when several categories match a LOSS: pre-trade errors first, then market, then execution, then trigger. */
export const FAILURE_PRIORITY: readonly FailureCategory[] = [
  "WRONG_LOCATION", "BIAS_CONFLICT", "VOLATILITY_FAILURE", "EXECUTION_FAILURE", "LIQUIDITY_SWEEP", "TRIGGER_FAILURE",
];

export const RECOMMENDATIONS: Record<FailureCategory, string> = {
  LIQUIDITY_SWEEP: "Review: M15 structural SL buffer parameter. NOT: change entry rule.",
  WRONG_LOCATION: "Review: location gate (tier/MID_RANGE filter).",
  BIAS_CONFLICT: "Review: H4/H1 alignment handling for counter-trend entries.",
  VOLATILITY_FAILURE: "Review: spread/volatility guard thresholds.",
  TRIGGER_FAILURE: "Review: M5 trigger quality criteria.",
  EXECUTION_FAILURE: "Review: fill/slippage/latency assumptions.",
  NO_FAILURE: "No action.",
  UNCLASSIFIED: "Collect more evidence; no rule change.",
};
