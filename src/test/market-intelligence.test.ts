import { describe, expect, it } from "vitest";
import { evaluateMarketIntelligence } from "@/core/intelligence/MarketIntelligenceEngine";
import type { MarketStructure, TrendStructure } from "@/engine/core/swing/types";
const sp = (price: number) => ({ id: String(price), symbol: "X", timeframe: "H4" as const, type: "HIGH" as const, price, timestamp: 0, confirmedAt: 0, strength: "NORMAL" as const, leftBars: 2, rightBars: 2, rejectionWickRatio: 0 });
const st = (trend: TrendStructure, hi: number, lo: number, pHi: number, pLo: number, shift: MarketStructure["structureShift"] = "NONE"): MarketStructure => ({ symbol: "X", timeframe: "H4", trend, lastConfirmedHigh: sp(hi), lastConfirmedLow: sp(lo), previousHigh: sp(pHi), previousLow: sp(pLo), structureShift: shift, shiftDetected: shift !== "NONE", lastUpdatedTimestamp: 0 });
const base = { volatility: "NORMAL" as const, sweepDirection: null };
describe("mtf-intel-v2", () => {
  it("H4 bullish + H1 pullback holding demand ⇒ HEALTHY_PULLBACK, WAIT_CONFIRMATION, not breakdown", () => {
    const r = evaluateMarketIntelligence({ ...base, h4: st("HH_HL", 110, 100, 105, 95), h1: st("LH_LL", 108, 103, 109, 104), m15: st("LH_LL", 106, 103, 107, 104), h1Close: 104, m15Close: 104, m5Momentum: "NONE" });
    expect([r.bias, r.h1_state, r.setup, r.status]).toEqual(["BULLISH", "HEALTHY_PULLBACK", "PULLBACK_BUY", "WAIT_CONFIRMATION"]);
    expect(r.confirmation_needed.length).toBeGreaterThan(0); expect(r.invalidation_conditions[0]).toContain("100");
  });
  it("H1 close below H4 demand ⇒ STRUCTURAL_BREAKDOWN / STAND_ASIDE / HIGH", () => {
    const r = evaluateMarketIntelligence({ ...base, h4: st("HH_HL", 110, 100, 105, 95), h1: st("LH_LL", 108, 99, 109, 101), m15: st("LH_LL", 106, 99, 107, 101), h1Close: 98, m15Close: 98, m5Momentum: "BEARISH" });
    expect([r.h1_state, r.status, r.risk_assessment]).toEqual(["STRUCTURAL_BREAKDOWN", "STAND_ASIDE", "HIGH"]);
  });
  it("full alignment ⇒ READY with 100 confidence; confidence alone never READY", () => {
    const r = evaluateMarketIntelligence({ ...base, h4: st("LH_LL", 110, 100, 115, 105), h1: st("LH_LL", 108, 101, 112, 104), m15: st("LH_LL", 104, 101, 106, 102), h1Close: 103, m15Close: 103, m5Momentum: "BEARISH" });
    expect([r.setup, r.status, r.confidence]).toEqual(["PULLBACK_SELL", "READY", 100]);
    const w = evaluateMarketIntelligence({ ...base, h4: st("LH_LL", 110, 100, 115, 105), h1: st("LH_LL", 108, 101, 112, 104), m15: st("LH_LL", 104, 101, 106, 102), h1Close: 103, m15Close: 103, m5Momentum: "NONE" });
    expect(w.confidence).toBe(90); expect(w.status).toBe("WAIT_CONFIRMATION");
  });
  it("sideways + bullish sweep + H1 higher low ⇒ ACCUMULATION, RANGE_ONLY; missing swings ⇒ NO_DATA", () => {
    const r = evaluateMarketIntelligence({ ...base, sweepDirection: "BULLISH", h4: st("RANGE", 110, 100, 111, 99), h1: st("RANGE", 108, 103, 109, 101), m15: st("RANGE", 106, 103, 107, 104), h1Close: 105, m15Close: 105, m5Momentum: "NONE" });
    expect([r.bias, r.market_phase, r.setup]).toEqual(["SIDEWAYS", "ACCUMULATION", "RANGE_ONLY"]);
    const n = evaluateMarketIntelligence({ ...base, h4: { ...st("RANGE", 1, 1, 1, 1), lastConfirmedHigh: null }, h1: st("RANGE", 1, 1, 1, 1), m15: st("RANGE", 1, 1, 1, 1), h1Close: 1, m15Close: 1, m5Momentum: "NONE" });
    expect(n.status).toBe("NO_DATA");
  });
});
describe("mtf-intel-v2 additions", () => {
  it("TRANSITION phase, key levels, invalidation levels, reasons", () => {
    const t = evaluateMarketIntelligence({ ...base, h4: st("HH_HL", 110, 100, 105, 95, "BEARISH_MSS"), h1: st("LH_LL", 108, 101, 109, 102), m15: st("LH_LL", 106, 101, 107, 102), h1Close: 103, m15Close: 103, m5Momentum: "NONE" });
    expect([t.bias, t.market_phase, t.status]).toEqual(["TRANSITION", "TRANSITION", "STAND_ASIDE"]);
    const r = evaluateMarketIntelligence({ ...base, h4: st("LH_LL", 110, 100, 115, 105), h1: st("LH_LL", 108, 101, 112, 104), m15: st("LH_LL", 104, 101, 106, 102), h1Close: 103, m15Close: 103, m5Momentum: "BEARISH" });
    expect(r.key_levels).toEqual({ support: 100, resistance: 110 });
    expect(r.invalidation_levels).toEqual([110, 104]);
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});
describe("Phase 1 · MTF foundation — 4 engine scenarios", () => {
  it("Test 1 — trend continuation: TRENDING · FOLLOW_TREND · READY|WAIT", () => {
    const r = evaluateMarketIntelligence({ ...base, h4: st("HH_HL", 110, 100, 105, 95), h1: st("HH_HL", 109, 104, 107, 102), m15: st("HH_HL", 108, 105, 107, 104), h1Close: 107, m15Close: 107, m5Momentum: "BULLISH" });
    expect([r.bias, r.market_phase, r.h1_state]).toEqual(["BULLISH", "TRENDING", "FOLLOW_TREND"]);
    expect(["READY", "WAIT_CONFIRMATION"]).toContain(r.status);
  });
  it("Test 2 — healthy pullback: H1 falling but H4 support intact ⇒ never bearish", () => {
    const r = evaluateMarketIntelligence({ ...base, h4: st("HH_HL", 110, 100, 105, 95), h1: st("LH_LL", 108, 102, 109, 104), m15: st("LH_LL", 106, 102, 107, 104), h1Close: 103, m15Close: 103, m5Momentum: "NONE" });
    expect([r.bias, r.h1_state, r.status]).toEqual(["BULLISH", "HEALTHY_PULLBACK", "WAIT_CONFIRMATION"]);
    expect(r.setup).not.toMatch(/SELL/);
  });
  it("Test 3 — structural breakdown: valid H1 close below H4 key support ⇒ STAND_ASIDE", () => {
    const r = evaluateMarketIntelligence({ ...base, h4: st("HH_HL", 110, 100, 105, 95), h1: st("LH_LL", 106, 99.5, 108, 101), m15: st("LH_LL", 103, 99, 104, 100), h1Close: 99.2, m15Close: 99.1, m5Momentum: "NONE" });
    expect([r.h1_state, r.status]).toEqual(["STRUCTURAL_BREAKDOWN", "STAND_ASIDE"]);
  });
  it("Test 4 — transition: H4 range + counter-trend H1 impulse ⇒ phase TRANSITION, not plain SIDEWAYS/RANGE", () => {
    const r = evaluateMarketIntelligence({ ...base, h4: st("RANGE", 110, 100, 111, 99), h1: st("RANGE", 108, 103, 109, 101, "BULLISH_MSS"), m15: st("RANGE", 106, 103, 107, 104), h1Close: 107, m15Close: 107, m5Momentum: "BULLISH" });
    expect(r.market_phase).toBe("TRANSITION");
    const s = evaluateMarketIntelligence({ ...base, h4: st("RANGE", 110, 100, 111, 99, "BEARISH_MSS"), h1: st("RANGE", 108, 103, 109, 101), m15: st("RANGE", 106, 103, 107, 104), h1Close: 104, m15Close: 104, m5Momentum: "NONE" });
    expect([s.bias, s.market_phase]).toEqual(["TRANSITION", "TRANSITION"]);
  });
  it("schema stability: report keys are fixed for AI Copilot ingestion", () => {
    const r = evaluateMarketIntelligence({ ...base, h4: st("HH_HL", 110, 100, 105, 95), h1: st("HH_HL", 109, 104, 107, 102), m15: st("HH_HL", 108, 105, 107, 104), h1Close: 107, m15Close: 107, m5Momentum: "BULLISH" });
    expect(Object.keys(r).sort()).toEqual(["audit_trail", "bias", "confidence", "confidence_breakdown", "confirmation_needed", "h1_state", "h4_state", "invalidation_conditions", "invalidation_levels", "key_levels", "m15_condition", "m5_condition", "market_phase", "reasons", "risk_assessment", "setup", "status", "version"]);
    expect(r.version).toBe("mtf-intel-v2"); expect(Object.isFrozen(r)).toBe(true);
  });
});
