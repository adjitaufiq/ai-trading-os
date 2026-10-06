import { describe, expect, it } from "vitest";
import { attemptModify } from "../tradeLifecycle";
import { openTrade } from "./helpers";

describe("immutable snapshot", () => {
  it("captures full decision context", () => {
    const s = openTrade().snapshot;
    expect(s).toMatchObject({ symbol: "XAUUSD", direction: "BUY", entryPrice: 2000.3, stopLoss: 1995, takeProfit: 2008, lot: 0.2, riskUSD: 100, executionMode: "PAPER" });
    expect(s.signalSource.trigger).toBe("BULLISH_ENGULFING");
    expect(s.decisionTrace).toContain("RISK Spread: PASS");
  });
  it("SL, TP, lot cannot change (frozen)", () => {
    const t = openTrade();
    expect(() => { (t.snapshot as { stopLoss: number }).stopLoss = 1990; }).toThrow();
    expect(() => { (t.snapshot as { takeProfit: number }).takeProfit = 2020; }).toThrow();
    expect(() => { (t.snapshot as { lot: number }).lot = 1; }).toThrow();
    expect(() => { (t.snapshot.decisionTrace as string[]).push("x"); }).toThrow();
    expect(t.snapshot.stopLoss).toBe(1995);
  });
  it("attemptModify returns IMMUTABLE_TRADE_ERROR", () => {
    expect(attemptModify(openTrade(), { stopLoss: 1990 })).toMatchObject({ ok: false, error: "IMMUTABLE_TRADE_ERROR" });
  });
});
