import { describe, expect, it } from "vitest";
import { runAutopsy } from "../../autopsy/autopsyEngine";
import { loss } from "../../autopsy/tests/helpers";
import { computeStressMetrics, emptyCounters } from "../performanceMonitor";
import { buildHealthChecks, snapshotParams } from "../stressReport";

const win = { ...loss({ tradeId: "w1", result: "WIN", profitLossUSD: 60, closeReason: "TP_HIT", exitPrice: 2656 }), excursion: { maximumAdverseExcursion: -1.5, maximumFavorableExcursion: 6 } };
const l1 = { ...loss({ tradeId: "l1" }), excursion: { maximumAdverseExcursion: -3, maximumFavorableExcursion: 1.5 } };
const l2 = { ...loss({ tradeId: "l2", ctx: { priceLocation: "MID_RANGE" } }), excursion: { maximumAdverseExcursion: -3, maximumFavorableExcursion: 0 } };
const mkt = { tradeBars: [{ high: 2651, low: 2646.8 }], futureCandles: [{ high: 2655, low: 2646 }], atr: 2 };

describe("performance monitor", () => {
  const trades = [win, l1, l2];
  const aut = trades.map((t) => runAutopsy(t, mkt, 1));

  it("computes win rate, PF, R expectancy, MAE/MFE in R, DD", () => {
    const c = emptyCounters(); c.plansPlanned = 10; c.riskBlocked = { SPREAD_TOO_HIGH: 2 }; c.paperRejected = { SLIPPAGE_EXCEEDED: 1 };
    const m = computeStressMetrics(trades, aut, c, 10000);
    expect(m.totalTrades).toBe(3);
    expect(m.winRate).toBeCloseTo(1 / 3, 3);
    expect(m.profitFactor).toBe(1);
    expect(m.expectancy).toBeCloseTo(0, 4);
    expect(m.averageMAE).toBeCloseTo(-2.5, 4);
    expect(m.averageMFE).toBeCloseTo(0.8333, 3);
    expect(m.maxDrawdown).toBeGreaterThan(0);
    expect(m.executionRejectRate).toBe(0.3);
    expect(m.failureDistribution).toEqual(["LIQUIDITY_SWEEP: 50%", "WRONG_LOCATION: 50%"]);
  });
  it("empty run is all zeros, no reject divide-by-zero", () => {
    const m = computeStressMetrics([], [], emptyCounters(), 10000);
    expect(m).toMatchObject({ totalTrades: 0, winRate: 0, executionRejectRate: 0, failureDistribution: [] });
  });
  it("health detects param drift, duplicate ids, missing autopsy", () => {
    const c = emptyCounters(); c.tradesClosed = 3;
    const base = { terminalRevivals: 0, riskViolations: 0, minEquity: 9000, counters: c, trades: trades.map((t) => Object.freeze(t)), autopsies: aut, journalHashBefore: "x", journalHashAfter: "x", paramsBefore: snapshotParams(), paramsAfter: snapshotParams() };
    expect(buildHealthChecks(base).every((h) => h.status === "PASS")).toBe(true);
    const bad = buildHealthChecks({ ...base, paramsAfter: "{}", trades: [base.trades[0]!, base.trades[0]!, base.trades[1]!], autopsies: aut.slice(0, 1), terminalRevivals: 1, riskViolations: 1 });
    expect(bad.map((h) => h.status)).toEqual(["FAIL", "FAIL", "FAIL", "FAIL", "FAIL"]);
  });
});
