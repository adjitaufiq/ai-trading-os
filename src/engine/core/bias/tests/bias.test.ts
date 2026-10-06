import { describe, expect, it } from "vitest";
import type { MarketStructure, SwingPoint } from "../swing/types";
import {
  computeBiasState, deriveAlignment, deriveBiasFromStructure, derivePhase,
} from "../biasEngine";
import { BIAS_POLICY_VERSION } from "../types";

function swing(type: "HIGH" | "LOW", price: number, timestamp: number, confirmedAt?: number): SwingPoint {
  return {
    id: `s_${type}_${price}_${timestamp}`,
    symbol: "XAUUSD",
    timeframe: "H4",
    type,
    price,
    timestamp,
    confirmedAt: confirmedAt ?? timestamp + 1,
    strength: "NORMAL",
    leftBars: 2,
    rightBars: 2,
    rejectionWickRatio: 0,
  };
}

function structure(
  trend: MarketStructure["trend"],
  opts: Partial<MarketStructure> = {},
): MarketStructure {
  return {
    symbol: "XAUUSD",
    timeframe: "H4",
    trend,
    lastConfirmedHigh: null,
    lastConfirmedLow: null,
    previousHigh: null,
    previousLow: null,
    structureShift: "NONE",
    shiftDetected: false,
    lastUpdatedTimestamp: 1000,
    ...opts,
  };
}

describe("M1B.4 — bias engine", () => {
  it("declares a versioned policy", () => {
    expect(BIAS_POLICY_VERSION).toBe("bias-m1b4-v1");
  });

  // ---- H4 bias rule ----
  it("H4 HH_HL returns BULLISH", () => {
    const h4 = structure("HH_HL", { timeframe: "H4" });
    const h1 = structure("HH_HL", { timeframe: "H1" });
    const state = computeBiasState("XAUUSD", h4, h1, 2000);
    expect(state.h4.bias).toBe("BULLISH");
    expect(state.h4.phase).toBe("CONTINUATION");
    expect(state.overallBias).toBe("BULLISH");
  });

  it("H4 LH_LL returns BEARISH", () => {
    const h4 = structure("LH_LL", { timeframe: "H4" });
    const h1 = structure("LH_LL", { timeframe: "H1" });
    const state = computeBiasState("XAUUSD", h4, h1, 2000);
    expect(state.h4.bias).toBe("BEARISH");
    expect(state.overallBias).toBe("BEARISH");
  });

  it("H4 RANGE returns NEUTRAL", () => {
    const state = computeBiasState("XAUUSD", structure("RANGE", { timeframe: "H4" }), structure("HH_HL", { timeframe: "H1" }), 2000);
    expect(state.h4.bias).toBe("NEUTRAL");
    expect(state.overallBias).toBe("NEUTRAL");
    expect(state.alignment).toBe("MIXED");
  });

  // ---- H1 context rule ----
  it("H1 opposite H4 detects PULLBACK", () => {
    const h4Bias = deriveBiasFromStructure("HH_HL");
    const h1 = structure("LH_LL", { timeframe: "H1", shiftDetected: false, structureShift: "NONE" });
    expect(derivePhase(h4Bias, deriveBiasFromStructure(h1.trend), h1)).toBe("PULLBACK");
  });

  it("H1 same as H4 detects CONTINUATION", () => {
    const h4Bias = deriveBiasFromStructure("HH_HL");
    const h1 = structure("HH_HL", { timeframe: "H1" });
    expect(derivePhase(h4Bias, deriveBiasFromStructure(h1.trend), h1)).toBe("CONTINUATION");
  });

  it("MSS transition back to H4 direction detects REVERSAL", () => {
    const h4Bias = deriveBiasFromStructure("HH_HL");
    const h1 = structure("LH_LL", { timeframe: "H1", structureShift: "BULLISH_MSS", shiftDetected: true });
    expect(derivePhase(h4Bias, deriveBiasFromStructure(h1.trend), h1)).toBe("REVERSAL");
  });

  it("symmetric bearish case: H4 BEARISH + H1 HH_HL + BEARISH_MSS → REVERSAL", () => {
    const h4Bias = deriveBiasFromStructure("LH_LL");
    const h1 = structure("HH_HL", { timeframe: "H1", structureShift: "BEARISH_MSS", shiftDetected: true });
    expect(derivePhase(h4Bias, deriveBiasFromStructure(h1.trend), h1)).toBe("REVERSAL");
  });

  it("H1 RANGE structure stays RANGE regardless of H4", () => {
    expect(derivePhase("BULLISH", "BULLISH", structure("RANGE", { timeframe: "H1" }))).toBe("RANGE");
    expect(derivePhase("NEUTRAL", "BULLISH", structure("HH_HL", { timeframe: "H1" }))).toBe("RANGE");
  });

  // ---- alignment rule ----
  it("H4 bullish + H1 bullish → ALIGNED", () => {
    expect(deriveAlignment("BULLISH", "BULLISH")).toBe("ALIGNED");
  });

  it("H4 bullish + H1 bearish → COUNTER_TREND", () => {
    expect(deriveAlignment("BULLISH", "BEARISH")).toBe("COUNTER_TREND");
    expect(deriveAlignment("BEARISH", "BULLISH")).toBe("COUNTER_TREND");
  });

  it("mixed/neutral → MIXED", () => {
    expect(deriveAlignment("NEUTRAL", "BULLISH")).toBe("MIXED");
    expect(deriveAlignment("BEARISH", "NEUTRAL")).toBe("MIXED");
    expect(deriveAlignment("NEUTRAL", "NEUTRAL")).toBe("MIXED");
  });

  // ---- end-to-end through real M1B.3 structures (buildStructure output shape) ----
  it("full spec example: H4 BULLISH, H1 LH_LL → COUNTER_TREND, overall BULLISH", () => {
    const h4 = structure("HH_HL", { timeframe: "H4", lastUpdatedTimestamp: 900 });
    const h1 = structure("LH_LL", { timeframe: "H1", lastUpdatedTimestamp: 950 });
    const state = computeBiasState("XAUUSD", h4, h1, 1000);
    expect(state.overallBias).toBe("BULLISH");
    expect(state.h4.bias).toBe("BULLISH");
    expect(state.h4.phase).toBe("CONTINUATION");
    expect(state.h1.bias).toBe("BEARISH");
    expect(state.h1.phase).toBe("PULLBACK");
    expect(state.alignment).toBe("COUNTER_TREND");
    expect(state.lastUpdated).toBe(1000);
  });

  it("spec example with MSS: H4 BULLISH, H1 LH_LL + BULLISH_MSS → REVERSAL, alignment stays COUNTER_TREND", () => {
    const h1 = structure("LH_LL", { timeframe: "H1", structureShift: "BULLISH_MSS", shiftDetected: true });
    const state = computeBiasState("XAUUSD", structure("HH_HL", { timeframe: "H4" }), h1, 1000);
    expect(state.h1.phase).toBe("REVERSAL");
    expect(state.alignment).toBe("COUNTER_TREND");
    expect(state.overallBias).toBe("BULLISH");
  });

  it("underfilled structure (fewer than 2 swings) behaves as RANGE → NEUTRAL", () => {
    // buildStructure with 1 swing yields RANGE; bias engine treats it as NEUTRAL.
    const h4 = structure("RANGE", { timeframe: "H4", lastConfirmedHigh: swing("HIGH", 2000, 100) });
    const state = computeBiasState("XAUUSD", h4, structure("HH_HL", { timeframe: "H1" }), 2000);
    expect(state.overallBias).toBe("NEUTRAL");
  });
});
