import { describe, expect, it } from "vitest";
import type { TradePlan } from "../../plan/types";
import { evaluateRisk, type RiskContext } from "../riskEngine";
import type { AccountProfile, BrokerSymbolInfo } from "../types";

const T = 1700000000;
const XAU: BrokerSymbolInfo = { symbol: "XAUUSD", volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, tickSize: 0.01, tickValue: 1, marginPerLot: 1000 };
const acct = (o: Partial<AccountProfile> = {}): AccountProfile => ({
  mode: "STANDARD", state: "NORMAL", equity: 10000, peakEquity: 10000, riskType: "PERCENTAGE", riskValue: 1,
  maxDailyLossPercent: 3, currentDailyDDPercent: 0, recoveryMultiplier: 0.5, ...o,
});
const plan = (o: Partial<TradePlan> = {}): TradePlan => Object.freeze({
  id: "plan_x", signalId: "x", symbol: "XAUUSD", direction: "BUY", status: "PLANNED", entry: 2000, sl: 1995, tp: 2008,
  riskDistance: 5, rewardDistance: 8, rr: 1.6, slSource: "M15_CONFIRMED_SWING", tpSource: "M15_NEAREST_RESISTANCE",
  atrM15: 3, createdAt: T, policyVersion: "plan-m3-v1",
  audit: { executable: false, orderSent: false, lotCalculated: false, mode: "PLAN_ONLY" }, trace: [], ...o,
}) as TradePlan;
const ctx = (o: Partial<RiskContext> = {}): RiskContext => ({
  nowSec: T, positions: [], exposureLimits: { maxSymbolRiskUSD: 500, maxTotalRiskUSD: 1000 },
  spread: { current: 0.2, history: Array(20).fill(0.2) }, lossStreak: { consecutiveLosses: 0, lastLossAt: null },
  strictRiskMode: true, ...o,
});

describe("evaluateRisk pipeline", () => {
  it("APPROVED with 0.2 lot and never mutates the plan", () => {
    const p = plan(); const snap = JSON.stringify(p);
    const r = evaluateRisk(p, acct(), XAU, ctx());
    expect(r.decision).toBe("APPROVED"); expect(r.positionSize!.finalLot).toBe(0.2);
    expect(JSON.stringify(p)).toBe(snap);
    expect(r.audit).toEqual({ executable: false, orderSent: false, mode: "MONITOR_ONLY" });
  });
  it("RECOVERY halves the lot", () => expect(evaluateRisk(plan(), acct({ equity: 8900 }), XAU, ctx()).positionSize!.finalLot).toBe(0.08));
  it("LOCKED ⇒ DAILY_DD_LIMIT", () => expect(evaluateRisk(plan(), acct({ currentDailyDDPercent: 3 }), XAU, ctx()).reasons).toEqual(["DAILY_DD_LIMIT"]));
  it("HOLD plan ⇒ INVALID_RISK", () => expect(evaluateRisk(plan({ status: "HOLD", sl: null }), acct(), XAU, ctx()).reasons).toEqual(["INVALID_RISK"]));
  it("min lot: strict BLOCKED, non-strict WARNING with reality check", () => {
    const tiny = acct({ riskType: "FIXED_USD", riskValue: 2 });
    expect(evaluateRisk(plan(), tiny, XAU, ctx()).decision).toBe("BLOCKED");
    const w = evaluateRisk(plan(), tiny, XAU, ctx({ strictRiskMode: false }));
    expect(w.decision).toBe("WARNING"); expect(w.reality).toMatchObject({ plannedBudgetUSD: 2, actualExecutionRiskUSD: 5, isForcedByMinLot: true });
  });
  it("exposure cluster full ⇒ EXPOSURE_LIMIT", () => {
    const r = evaluateRisk(plan(), acct(), XAU, ctx({ positions: [{ symbol: "XAUUSD", riskUSD: 300 }, { symbol: "XAUUSD", riskUSD: 200 }] }));
    expect(r.reasons).toEqual(["EXPOSURE_LIMIT"]);
  });
  it("spread too high ⇒ SPREAD_TOO_HIGH", () => expect(evaluateRisk(plan(), acct(), XAU, ctx({ spread: { current: 0.4, history: [] } })).reasons).toEqual(["SPREAD_TOO_HIGH"]));
  it("3 losses ⇒ COOLDOWN_ACTIVE", () => expect(evaluateRisk(plan(), acct(), XAU, ctx({ lossStreak: { consecutiveLosses: 3, lastLossAt: T - 60 } })).reasons).toEqual(["COOLDOWN_ACTIVE"]));
  it("slippage ⇒ SLIPPAGE_TOO_HIGH", () => expect(evaluateRisk(plan(), acct(), XAU, ctx({ quote: { ask: 2001, bid: 2000.7, maxSlippage: 0.5 } })).reasons).toEqual(["SLIPPAGE_TOO_HIGH"]));
  it("insufficient margin", () => expect(evaluateRisk(plan(), acct(), XAU, ctx({ freeMargin: 100 })).reasons).toEqual(["INSUFFICIENT_MARGIN"]));
});
