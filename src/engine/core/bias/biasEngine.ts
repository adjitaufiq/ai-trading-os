// M1B.4 — H4/H1 bias & market context engine.
// Input: confirmed MarketStructure objects (M1B.3 output, already CLOSED-candle gated).
// Deterministic, no indicators, no EMA, no signals.

import type {
  BiasAlignment, MarketBias, MarketBiasState, MarketPhase, TimeframeContext,
} from "./types";
import { BIAS_RULES } from "./types";
import type { MarketStructure, StructureShiftType, TrendStructure } from "../swing/types";

/** Structure trend → market bias (H4 rule). */
export function deriveBiasFromStructure(trend: TrendStructure): MarketBias {
  if (trend === "HH_HL") return "BULLISH";
  if (trend === "LH_LL") return "BEARISH";
  return "NEUTRAL";
}

/**
 * MSS direction helper: does the confirmed structure shift point back toward
 * the given bias? e.g. H4 BULLISH + H1 LH_LL + BULLISH_MSS = pullback
 * exhausted, H1 structure transitioning back to the macro direction → REVERSAL.
 */
function mssPointsTowardBias(shift: StructureShiftType, bias: MarketBias): boolean {
  if (shift === "BULLISH_MSS") return bias === "BULLISH";
  if (shift === "BEARISH_MSS") return bias === "BEARISH";
  return false;
}

/**
 * H1 context rule (deterministic):
 * - RANGE structure, or NEUTRAL H4 → RANGE
 * - H1 bias same as H4 → CONTINUATION
 * - H1 bias opposite H4 + MSS back toward H4 → REVERSAL
 * - H1 bias opposite H4 → PULLBACK
 */
export function derivePhase(h4Bias: MarketBias, h1Bias: MarketBias, h1Structure: MarketStructure): MarketPhase {
  if (h1Structure.trend === "RANGE") return "RANGE";
  if (h4Bias === "NEUTRAL") return "RANGE";
  if (h1Bias === h4Bias) return "CONTINUATION";
  if (h1Structure.shiftDetected && mssPointsTowardBias(h1Structure.structureShift, h4Bias)) {
    return "REVERSAL";
  }
  return "PULLBACK";
}

export function deriveAlignment(h4Bias: MarketBias, h1Bias: MarketBias): BiasAlignment {
  if (h4Bias === "NEUTRAL" || h1Bias === "NEUTRAL") return "MIXED";
  if (h4Bias === h1Bias) return "ALIGNED";
  return "COUNTER_TREND";
}

function describeTf(bias: MarketBias, phase: MarketPhase, structure: string): string {
  return `${structure} → ${bias} (${phase})`;
}

/**
 * Compute the full H4/H1 bias state from confirmed structures.
 * overallBias follows H4 (macro authority). Alignment is bias-based;
 * a REVERSAL phase is reported on h1.phase and never silently re-labels alignment.
 */
export function computeBiasState(
  symbol: string,
  h4Structure: MarketStructure,
  h1Structure: MarketStructure,
  asOf: number,
): MarketBiasState {
  const h4Bias = deriveBiasFromStructure(h4Structure.trend);
  const h1Bias = deriveBiasFromStructure(h1Structure.trend);
  const h1Phase = derivePhase(h4Bias, h1Bias, h1Structure);

  const h4: TimeframeContext = {
    timeframe: "H4",
    bias: h4Bias,
    phase: h4Bias === "NEUTRAL" ? "RANGE" : "CONTINUATION",
    structure: h4Structure.trend,
    description: describeTf(h4Bias, h4Bias === "NEUTRAL" ? "RANGE" : "CONTINUATION", h4Structure.trend),
  };
  const h1: TimeframeContext = {
    timeframe: "H1",
    bias: h1Bias,
    phase: h1Phase,
    structure: h1Structure.trend,
    description: describeTf(h1Bias, h1Phase, h1Structure.trend),
  };

  return {
    symbol,
    overallBias: h4Bias,
    h4,
    h1,
    alignment: deriveAlignment(h4Bias, h1Bias),
    lastUpdated: Math.max(h4Structure.lastUpdatedTimestamp, h1Structure.lastUpdatedTimestamp, asOf),
  };
}

export { BIAS_RULES };
