import type { ArenaCandle } from "../../core/normalizer/types";
import type { TradePlan } from "../../plan/types";
import type { RiskCheckResult } from "../../risk/types";
import { createPaperTrade, type CreateInput } from "../paperExecution";
import { openPaperTrade } from "../tradeLifecycle";
import type { PaperTrade } from "../types";

export const T = 1700000000;
export const plan = (o: Partial<TradePlan> = {}): TradePlan => ({
  id: "plan_x", signalId: "x", symbol: "XAUUSD", direction: "BUY", status: "PLANNED", entry: 2000, sl: 1995, tp: 2008,
  riskDistance: 5, rewardDistance: 8, rr: 1.6, slSource: "M15_CONFIRMED_SWING", tpSource: "M15_NEAREST_RESISTANCE",
  atrM15: 3, createdAt: T, policyVersion: "plan-m3-v1",
  audit: { executable: false, orderSent: false, lotCalculated: false, mode: "PLAN_ONLY" }, trace: [{ name: "Setup READY", result: "PASS" }], ...o,
});
export const risk = (o: Partial<RiskCheckResult> = {}): RiskCheckResult => ({
  decision: "APPROVED", reasons: [], accountState: "NORMAL", reality: null, policyVersion: "risk-m4-v1",
  positionSize: { rawLot: 0.2, finalLot: 0.2, riskUSD: 100, actualRiskUSD: 100, riskDeviationPercent: 0, forcedMinimumLot: false },
  trace: [{ name: "Spread", result: "PASS" }], audit: { executable: false, orderSent: false, mode: "MONITOR_ONLY" }, ...o,
});
export const input = (o: Partial<CreateInput> = {}): CreateInput => ({
  plan: plan(), risk: risk(), marketPrice: 2000, accountEquity: 10000, now: T,
  sim: { spread: 0.2, slippage: 0.1, maxSlippage: 0.5, latencyMs: 0, latencyDriftPerMs: 0 },
  contract: { tickSize: 0.01, tickValue: 1 },
  signalSource: { bias: "H4_BULLISH_H1_PULLBACK", location: "AT_SUPPORT", trigger: "BULLISH_ENGULFING", reactionQuality: "STRONG", emaContext: "EMA21_RETEST" },
  ...o,
});
export function openTrade(o: Partial<CreateInput> = {}): PaperTrade {
  const c = createPaperTrade(input(o));
  if (c.state !== "PENDING") throw new Error("not created");
  const r = openPaperTrade(c.trade, T);
  if (!r.ok) throw new Error("not opened");
  return r.trade;
}
export const candle = (o: Partial<ArenaCandle>): ArenaCandle => ({
  id: "c", symbol: "XAUUSD", timeframe: "M5", timestamp: T, open: 2000, high: 2001, low: 1999, close: 2000,
  volume: 0, spread: 0, source: "MOCK", isClosed: true, sequence: 1, ...o,
});
