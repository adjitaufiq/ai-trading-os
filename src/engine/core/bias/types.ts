// M1B.4 — H4/H1 bias & market context engine contracts.
// Consumes ONLY confirmed MarketStructure output from M1B.3 (swing engine).
// No indicators, no EMA, no signals — structure only.

export type MarketBias = "BULLISH" | "BEARISH" | "NEUTRAL";

export type MarketPhase = "CONTINUATION" | "PULLBACK" | "REVERSAL" | "RANGE";

export type BiasAlignment = "ALIGNED" | "COUNTER_TREND" | "MIXED";

export interface TimeframeContext {
  timeframe: "H4" | "H1";
  bias: MarketBias;
  phase: MarketPhase;
  structure: string;
  description: string;
}

export interface MarketBiasState {
  symbol: string;
  overallBias: MarketBias;
  h4: TimeframeContext;
  h1: TimeframeContext;
  alignment: BiasAlignment;
  lastUpdated: number;
}

/** Every numeric/rule constant is explicit and versioned. */
export const BIAS_POLICY_VERSION = "bias-m1b4-v1";

export const BIAS_RULES = {
  H4_BIAS: {
    HH_HL: "BULLISH",
    LH_LL: "BEARISH",
    RANGE: "NEUTRAL",
  },
  H1_PHASE: {
    SAME_AS_H4: "CONTINUATION",
    OPPOSITE_OF_H4: "PULLBACK",
    OPPOSITE_WITH_MSS_BACK_TO_H4: "REVERSAL",
    RANGE_STRUCTURE: "RANGE",
    NEUTRAL_H4: "RANGE",
  },
  ALIGNMENT: {
    SAME_BIAS: "ALIGNED",
    OPPOSITE_BIAS: "COUNTER_TREND",
    MIXED_OR_NEUTRAL: "MIXED",
  },
  // H4 is the macro authority: overall bias follows H4 unless H4 itself is NEUTRAL.
  OVERALL_BIAS_SOURCE: "H4",
} as const;
