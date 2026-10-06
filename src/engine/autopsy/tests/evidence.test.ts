import { describe, expect, it } from "vitest";
import { analyzeAfterTrade } from "../evidenceCollector";
import { classifyFailure } from "../failureClassifier";
import { loss, market } from "./helpers";

describe("evidence", () => {
  it("every diagnosis contains evidence", () => {
    for (const m of [market(), market({ tradeBars: [{ high: 2651, low: 2644 }] }), market({ futureCandles: [{ high: 2655, low: 2646 }] })]) {
      const c = classifyFailure(loss(), m);
      expect(c.evidence.length).toBeGreaterThan(0);
      for (const e of c.evidence) expect(e.metric && e.expected && e.actual).toBeTruthy();
    }
  });
  it("no market diagnosis without data ⇒ UNCLASSIFIED LOW", () => {
    const c = classifyFailure(loss(), { tradeBars: [], futureCandles: [], atr: null });
    expect(c.primaryFailure).toBe("UNCLASSIFIED"); expect(c.confidence).toBe("LOW");
    expect(c.evidence.map((e) => e.metric)).toEqual(["LOCATION_VALID", "BIAS_ALIGNMENT"]);
  });
  it("post-trade replay BUY loss", () => {
    const p = analyzeAfterTrade(loss(), [{ high: 2649, low: 2646 }, { high: 2657, low: 2648 }]);
    expect(p).toEqual({ maxMoveAgainst: 4, maxMoveInFavor: 7, returnedToEntry: true, continuedDirection: true });
  });
  it("post-trade replay SELL, no data", () => {
    const t = loss({ direction: "SELL", entryPrice: 2650, stopLoss: 2653, takeProfit: 2644, exitPrice: 2653 });
    expect(analyzeAfterTrade(t, [{ high: 2654, low: 2652 }])).toEqual({ maxMoveAgainst: 4, maxMoveInFavor: 0, returnedToEntry: false, continuedDirection: false });
    expect(analyzeAfterTrade(t, []).maxMoveInFavor).toBe(0);
  });
});
