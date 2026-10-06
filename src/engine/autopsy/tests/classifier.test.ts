import { describe, expect, it } from "vitest";
import { classifyFailure } from "../failureClassifier";
import { loss, market } from "./helpers";

describe("failure classification", () => {
  it("liquidity sweep: SL hit then +≥1R recovery beyond entry ⇒ HIGH", () => {
    const c = classifyFailure(loss(), market({ futureCandles: [{ high: 2649, low: 2646.5 }, { high: 2655, low: 2648 }] }));
    expect(c.primaryFailure).toBe("LIQUIDITY_SWEEP"); expect(c.confidence).toBe("HIGH");
    expect(c.evidence.find((e) => e.metric === "PRICE_RETURN_AFTER_SL")!.actual).toContain("+2.6667R");
  });
  it("wrong location", () => {
    const c = classifyFailure(loss({ ctx: { priceLocation: "MID_RANGE" } }), market());
    expect(c.primaryFailure).toBe("WRONG_LOCATION");
    expect(c.evidence.find((e) => e.metric === "LOCATION_VALID")).toMatchObject({ passed: false, actual: "MID_RANGE / TIER_1" });
  });
  it("bias conflict: SELL vs H4 BULLISH + H1 CONTINUATION", () => {
    const t = loss({ direction: "SELL", entryPrice: 2650, stopLoss: 2653, takeProfit: 2644, exitPrice: 2653, ctx: { h1Phase: "CONTINUATION" } });
    expect(classifyFailure(t, market({ futureCandles: [] })).primaryFailure).toBe("BIAS_CONFLICT");
    expect(classifyFailure({ ...t, context: { ...t.context, h1Phase: "PULLBACK" } }, market({ futureCandles: [] })).primaryFailure).not.toBe("BIAS_CONFLICT");
  });
  it("volatility failure: 3.5×ATR candle + 2× spread ⇒ HIGH", () => {
    const c = classifyFailure(loss(), market({ tradeBars: [{ high: 2651, low: 2644 }], spreadAtEntry: 0.4 }));
    expect(c.primaryFailure).toBe("VOLATILITY_FAILURE"); expect(c.confidence).toBe("HIGH");
  });
  it("execution failure: fill deviation ≥0.2R", () => {
    const c = classifyFailure(loss(), market({ execution: { plannedEntry: 2650, actualEntry: 2650.9, latencyMs: 50 } }));
    expect(c.primaryFailure).toBe("EXECUTION_FAILURE"); expect(c.confidence).toBe("HIGH");
  });
  it("trigger failure: valid context, immediate breakdown", () => {
    const c = classifyFailure(loss(), market({ tradeBars: [{ high: 2650.2, low: 2649 }, { high: 2649.5, low: 2646.8 }] }));
    expect(c.primaryFailure).toBe("TRIGGER_FAILURE");
  });
  it("secondary factors recorded by priority", () => {
    const c = classifyFailure(loss({ ctx: { priceLocation: "MID_RANGE" } }), market({ execution: { plannedEntry: 2650, actualEntry: 2651, latencyMs: 50 } }));
    expect(c.primaryFailure).toBe("WRONG_LOCATION"); expect(c.secondaryFactors).toContain("EXECUTION_FAILURE");
  });
  it("win ⇒ NO_FAILURE", () => {
    expect(classifyFailure(loss({ result: "WIN", profitLossUSD: 60, closeReason: "TP_HIT", exitPrice: 2656 }), market()).primaryFailure).toBe("NO_FAILURE");
  });
});
