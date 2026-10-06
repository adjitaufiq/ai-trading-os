import { describe, expect, it } from "vitest";
import { createPaperTrade, simulateFill } from "../paperExecution";
import { input, risk } from "./helpers";

describe("paper creation", () => {
  it("APPROVED risk creates PENDING trade + TRADE_CREATED", () => {
    const r = createPaperTrade(input());
    expect(r.state).toBe("PENDING");
    expect(r.events[0]!.type).toBe("TRADE_CREATED");
    if (r.state === "PENDING") expect(r.trade.audit).toEqual({ executionMode: "PAPER", orderSent: false, brokerTouched: false });
  });
  it.each(["BLOCKED", "WARNING"] as const)("%s risk rejects RISK_NOT_APPROVED", (d) => {
    const r = createPaperTrade(input({ risk: risk({ decision: d }) }));
    expect(r).toMatchObject({ state: "REJECTED", reason: "RISK_NOT_APPROVED" });
    expect(r.events[0]!.type).toBe("TRADE_REJECTED");
  });
  it("slippage over max rejects", () => {
    const r = createPaperTrade(input({ sim: { spread: 0.2, slippage: 0.6, maxSlippage: 0.5, latencyMs: 0, latencyDriftPerMs: 0 } }));
    expect(r).toMatchObject({ state: "REJECTED", reason: "SLIPPAGE_EXCEEDED" });
  });
});

describe("price simulation", () => {
  const sim = { spread: 0.2, slippage: 0.1, maxSlippage: 0.5, latencyMs: 100, latencyDriftPerMs: 0.001 };
  it("BUY fills higher", () => expect(simulateFill("BUY", 2000, sim)!.actualEntry).toBe(2000.4));
  it("SELL fills lower", () => expect(simulateFill("SELL", 2000, sim)!.actualEntry).toBe(1999.6));
  it("records slippage and drift", () => expect(simulateFill("BUY", 2000, sim)).toMatchObject({ slippageApplied: 0.1, latencyDrift: 0.1, spreadApplied: 0.2 }));
});
