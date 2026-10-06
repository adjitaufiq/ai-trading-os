import { describe, expect, it } from "vitest";
import { TradeJournal } from "../../journal/tradeJournal";
import { runAutopsy } from "../autopsyEngine";
import { analyzeFailureDistribution, buildRuleAuditMatrix } from "../patternAnalyzer";
import { generateAutopsyReport, generateDistributionReport } from "../reportGenerator";
import { AUTOPSY_PARAMS } from "../types";
import { loss, market } from "./helpers";

const sweepMkt = market({ futureCandles: [{ high: 2655, low: 2646.5 }] });

describe("autopsy engine", () => {
  it("does not modify journal rows", () => {
    const j = new TradeJournal(); j.saveTrade(loss());
    const row = j.getAll()[0]!; const snap = JSON.stringify(row);
    runAutopsy(row, sweepMkt, 1);
    expect(JSON.stringify(j.getAll()[0])).toBe(snap);
  });
  it("does not modify parameters", () => {
    const snap = JSON.stringify(AUTOPSY_PARAMS);
    runAutopsy(loss(), sweepMkt, 1);
    expect(JSON.stringify(AUTOPSY_PARAMS)).toBe(snap);
    expect(Object.isFrozen(AUTOPSY_PARAMS)).toBe(false); // `as const` only; guarded by test above
  });
  it("deterministic and frozen output", () => {
    const a = runAutopsy(loss(), sweepMkt, 42), b = runAutopsy(loss(), sweepMkt, 42);
    expect(a).toEqual(b);
    expect(() => { (a as { primaryFailure: string }).primaryFailure = "NO_FAILURE"; }).toThrow();
  });
  it("report contains evidence and recommendation", () => {
    const txt = generateAutopsyReport(runAutopsy(loss(), sweepMkt, 1), "XAUUSD BUY #501");
    expect(txt).toContain("Primary Failure: LIQUIDITY_SWEEP");
    expect(txt).toContain("✓ LOCATION_VALID");
    expect(txt).toContain("NOT: change entry rule");
  });
  it("failure distribution and rule audit", () => {
    const rows = [loss({ tradeId: "a" }), loss({ tradeId: "b" }), loss({ tradeId: "c", ctx: { priceLocation: "MID_RANGE" } }),
      loss({ tradeId: "d", result: "WIN", profitLossUSD: 60, closeReason: "TP_HIT" })];
    const aut = rows.map((t) => runAutopsy(t, sweepMkt, 1));
    const d = analyzeFailureDistribution(aut);
    expect(d).toMatchObject({ analyzed: 4, losses: 3, highestImpact: "LIQUIDITY_SWEEP" });
    expect(d.breakdown.LIQUIDITY_SWEEP).toBeCloseTo(0.6667, 3);
    expect(generateDistributionReport(d)).toContain("LIQUIDITY_SWEEP: 67%");
    const audit = buildRuleAuditMatrix(rows).find((r) => r.condition === "AT_SUPPORT + BULLISH_REJECTION_WICK")!;
    expect(audit).toMatchObject({ sampleSize: 3, winRate: 0.3333, failureRate: 0.6667 });
  });
});
