import { describe, expect, it } from "vitest";
import { complianceChecks, overallStatus, stateAt, type ReviewState, type ReviewTrade } from "./compliance";

const trade = (o: Partial<ReviewTrade> = {}): ReviewTrade => ({
  trade_id: "t1", symbol: "XAUUSD", direction: "BUY", result: "LOSS", close_reason: "SL", opened_at: "2026-10-07T08:07:00Z",
  closed_at: "2026-10-07T08:40:00Z", profit_loss_usd: -10, risk_usd: 10, r_multiple: -1, failure_category: null, data_source: "REAL_MT5",
  regime: "TREND_CONTINUATION", approach: null, location: null, trigger_pattern: null, reaction_quality: null,
  payload: { entryPrice: 100, stopLoss: 99 }, ...o,
});
const state = (o: Partial<ReviewState> = {}): ReviewState => ({
  m5_close_at: "2026-10-07T08:05:00Z", regime: "TREND_CONTINUATION", approach: null, bias: "BULLISH", market_phase: null, h4_state: null,
  h1_state: null, setup: null, decision: "READY", confidence: 80, risk: null, support: null, resistance: null, reasons: [], invalidation: [], ...o,
});

describe("trade review compliance", () => {
  it("picks the latest state at or before entry within window", () => {
    const rows = [state({ m5_close_at: "2026-10-07T08:00:00Z" }), state(), state({ m5_close_at: "2026-10-07T08:10:00Z" })];
    expect(stateAt(rows, "2026-10-07T08:07:00Z")?.m5_close_at).toBe("2026-10-07T08:05:00Z");
    expect(stateAt(rows, "2026-10-07T09:00:00Z")).toBeNull();
  });
  it("READY + aligned + defined risk is COMPLIANT", () => {
    expect(overallStatus(complianceChecks(trade(), state()))).toBe("COMPLIANT");
  });
  it("entry while engine STAND_ASIDE or against bias is NON_COMPLIANT", () => {
    expect(overallStatus(complianceChecks(trade(), state({ decision: "STAND_ASIDE", confidence: 43 })))).toBe("NON_COMPLIANT");
    expect(overallStatus(complianceChecks(trade(), state({ bias: "BEARISH" })))).toBe("NON_COMPLIANT");
  });
  it("missing engine state is NOT_EVALUABLE, never assumed compliant", () => {
    expect(overallStatus(complianceChecks(trade(), null))).toBe("NOT_EVALUABLE");
  });
  it("SL on wrong side fails RISK_DEFINED; synthetic source is a note", () => {
    expect(complianceChecks(trade({ payload: { entryPrice: 100, stopLoss: 101 } }), state()).find((c) => c.id === "RISK_DEFINED")?.status).toBe("FAIL");
    expect(overallStatus(complianceChecks(trade({ data_source: "SYNTHETIC" }), state()))).toBe("COMPLIANT_WITH_NOTES");
  });
});
