import { describe, expect, it } from "vitest";
import { buildEquityCurve } from "../equityAnalytics";
import { calculateExcursion, calculatePerformance } from "../metricsEngine";
import { jt } from "./helpers";

// 11 wins of +20, 9 losses of −15 ⇒ 55% / 45%
const sample = () => [...Array(11)].map(() => jt({ profitLossUSD: 20 })).concat([...Array(9)].map(() => jt({ profitLossUSD: -15 })));

describe("performance metrics", () => {
  it("win rate", () => expect(calculatePerformance(sample()).winRate).toBe(0.55));
  it("profit factor = 220/135", () => expect(calculatePerformance(sample()).profitFactor).toBeCloseTo(1.6296, 3));
  it("expectancy = 0.55×20 − 0.45×15 = 4.25", () => expect(calculatePerformance(sample()).expectancy).toBe(4.25));
  it("expectancyR and averages", () => {
    const p = calculatePerformance(sample());
    expect(p.averageWin).toBe(20); expect(p.averageLoss).toBe(15); expect(p.expectancyR).toBe(0.085);
  });
  it("empty and no-loss edge cases", () => {
    expect(calculatePerformance([]).profitFactor).toBe(0);
    expect(calculatePerformance([jt({ profitLossUSD: 5 })]).profitFactor).toBe(Infinity);
  });
});

describe("MAE / MFE", () => {
  const bars = [{ high: 2652, low: 2647 }, { high: 2656, low: 2649 }];
  it("BUY: MAE −3, MFE +6", () => expect(calculateExcursion("BUY", 2650, bars)).toEqual({ maximumAdverseExcursion: -3, maximumFavorableExcursion: 6 }));
  it("SELL: MAE −6, MFE +3", () => expect(calculateExcursion("SELL", 2650, bars)).toEqual({ maximumAdverseExcursion: -6, maximumFavorableExcursion: 3 }));
});

describe("equity curve", () => {
  it("tracks peak, current and max drawdown", () => {
    const e = buildEquityCurve([jt({ profitLossUSD: 100 }), jt({ profitLossUSD: -220 }), jt({ profitLossUSD: 50 })], 1000);
    expect(e.points.map((p) => p.equity)).toEqual([1100, 880, 930]);
    expect(e.peakEquity).toBe(1100); expect(e.currentEquity).toBe(930); expect(e.maxDrawdownPercent).toBe(20);
  });
});
