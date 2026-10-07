import { describe, expect, it } from "vitest";
import { classifyMtf } from "@/core/technical/operator";
describe("mtf-classification-v1", () => {
  it("H4 bullish + H1 pullback ⇒ WAIT_CONFIRMATION, not HOLD-only", () => {
    const m = classifyMtf("UP", "PULLBACK_AGAINST_H4", "UP", "DOWN", false);
    expect([m.classification, m.h4_bias, m.h1_state, m.action_context]).toEqual(["BULLISH", "BULLISH", "PULLBACK", "WAIT_CONFIRMATION"]);
    expect(m.confidence).toBe(65); expect(m.reasons.length).toBeGreaterThan(0);
  });
  it("H4 bearish + H1 recovery ⇒ COUNTER_TREND_REBOUND", () => {
    const m = classifyMtf("DOWN", "REVERSAL_CANDIDATE", "UP", "UP", false);
    expect([m.classification, m.h4_bias, m.h1_state, m.action_context]).toEqual(["TRANSITION", "BEARISH", "COUNTER_TREND_REBOUND", "WAIT_CONFIRMATION"]);
  });
  it("aligned ⇒ FOLLOW_TREND full confidence; mixed ⇒ SIDEWAYS; insufficient ⇒ NOT_EVALUABLE", () => {
    expect(classifyMtf("DOWN", "ALIGNED", "DOWN", "DOWN", false)).toMatchObject({ classification: "BEARISH", action_context: "FOLLOW_TREND", confidence: 100 });
    expect(classifyMtf("MIXED", "NO_PRIMARY_DIRECTION", "UP", "UP", true)).toMatchObject({ classification: "SIDEWAYS", action_context: "RANGE_ONLY" });
    expect(classifyMtf("INSUFFICIENT", "INSUFFICIENT", "UP", "UP", false)).toMatchObject({ action_context: "NOT_EVALUABLE", confidence: 0 });
  });
});
