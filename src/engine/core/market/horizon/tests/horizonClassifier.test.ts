import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import ts from "typescript";
import { classifyHorizon } from "../horizonClassifier";
import type { HorizonClassifierInput } from "../types";
import type { MarketRegimeSnapshot } from "../../regime/types";
import type { MarketStructure, SwingPoint, TrendStructure } from "../../../swing/types";

const sp = (type: "HIGH" | "LOW", price: number, t: number, conf = t + 10): SwingPoint => ({
  id: `M15-${type}-${t}`, symbol: "XAUUSD", timeframe: "M15", type, price, timestamp: t, confirmedAt: conf,
  strength: "NORMAL", leftBars: 2, rightBars: 2, rejectionWickRatio: 0.3,
});
const m15 = (trend: TrendStructure, hi = 2030, lo = 2000, conf?: number): MarketStructure => ({
  symbol: "XAUUSD", timeframe: "M15", trend,
  previousHigh: sp("HIGH", hi - 5, 100), previousLow: sp("LOW", lo - 5, 110),
  lastConfirmedHigh: sp("HIGH", hi, 200, conf), lastConfirmedLow: sp("LOW", lo, 210, conf),
  structureShift: "NONE", shiftDetected: false, lastUpdatedTimestamp: 300,
});
const regime = (o: Partial<MarketRegimeSnapshot> & { ctx?: Partial<MarketRegimeSnapshot["structureContext"]>; rc?: Partial<MarketRegimeSnapshot["rangeContext"]> } = {}): MarketRegimeSnapshot => ({
  symbol: "XAUUSD", asOf: 1000, regime: "TREND_CONTINUATION", trendAlignment: "ALIGNED", volatility: "NORMAL",
  structureContext: { monthly: "UNAVAILABLE", weekly: "UNAVAILABLE", daily: "UNAVAILABLE", h4: "BULLISH", h1: "BULLISH", ...o.ctx },
  rangeContext: { rangeWidth: 30, atrCurrent: 10, atrPercentile: 0.5, atrState: "NORMAL", ...o.rc },
  evidence: [], algorithmVersion: "m1b9-regime-v1", ...o,
});
const base = (o: Partial<HorizonClassifierInput> = {}): HorizonClassifierInput => ({
  symbol: "XAUUSD", now: 1000, regime: regime(), m15Structure: m15("HH_HL"), ...o,
});

describe("M1B.10 horizon classifier", () => {
  it("1 trend continuation → INTRADAY/TREND_FOLLOW", () => {
    const c = classifyHorizon(base());
    expect(c).toMatchObject({ recommendedHorizon: "INTRADAY", compatibleHorizons: ["INTRADAY", "SWING"], marketApproach: "TREND_FOLLOW", holdingEnvironment: "SESSION_HORIZON" });
  });
  it("2 range scalping → SCALPING/MEAN_REVERSION", () => {
    const c = classifyHorizon(base({ regime: regime({ regime: "RANGE_COMPRESSION", volatility: "COMPRESSION", ctx: { h4: "RANGE", h1: "CHOP" }, rc: { atrPercentile: 0.2 } }), m15Structure: m15("RANGE") }));
    expect(c).toMatchObject({ recommendedHorizon: "SCALPING", compatibleHorizons: ["SCALPING", "INTRADAY"], marketApproach: "MEAN_REVERSION", holdingEnvironment: "SHORT_HORIZON" });
    expect(c.evidence).toEqual(["RANGE_BOUNDARY_AVAILABLE", "ATR_SUPPORTS_MICRO_CYCLE", "MEAN_REVERSION_ENVIRONMENT"]);
    const narrow = classifyHorizon(base({ regime: regime({ regime: "RANGE_COMPRESSION", ctx: { h4: "RANGE" }, rc: { atrPercentile: 0.2 } }), m15Structure: m15("RANGE", 2005, 2000) }));
    expect(narrow.recommendedHorizon).toBe("NO_FIT");
  });
  it("3 trend scalping → +SCALPING, MOMENTUM", () => {
    const c = classifyHorizon(base({ regime: regime({ ctx: { daily: "BULLISH" } }), m5Momentum: "BULLISH" }));
    expect(c.compatibleHorizons).toEqual(["INTRADAY", "SWING", "SCALPING"]);
    expect(c.marketApproach).toBe("MOMENTUM");
    expect(c.evidence).toContain("SCALP_DIRECTIONAL_ALIGNMENT");
    expect(classifyHorizon(base({ m5Momentum: "BEARISH" })).compatibleHorizons).not.toContain("SCALPING");
  });
  it("4 dead market → NO_FIT", () => {
    const c = classifyHorizon(base({ regime: regime({ regime: "RANGE_COMPRESSION", ctx: { h4: "RANGE" }, rc: { atrPercentile: 0.05, rangeWidth: 4 } }), m15Structure: m15("RANGE") }));
    expect(c).toMatchObject({ recommendedHorizon: "NO_FIT", compatibleHorizons: [], marketApproach: "NO_CLEAR_EDGE", holdingEnvironment: "DEFENSIVE_HOLD" });
    expect(c.evidence).toContain("DEAD_MARKET_NO_EDGE");
  });
  it("5 news volatility / unstable regimes → veto", () => {
    for (const rg of ["VOLATILITY_EXPANSION", "TRANSITION", "TREND_EXHAUSTION"] as const) {
      const c = classifyHorizon(base({ regime: regime({ regime: rg }), m5Momentum: "BULLISH" }));
      expect(c.recommendedHorizon).toBe("NO_FIT");
      expect(c.compatibleHorizons).toEqual([]);
      expect(c.evidence).toEqual(["REGIME_UNSTABLE_VETO"]);
    }
  });
  it("6 swing environment → SWING/POSITION_HORIZON", () => {
    const c = classifyHorizon(base({ regime: regime({ ctx: { daily: "BULLISH", weekly: "BULLISH" } }) }));
    expect(c).toMatchObject({ recommendedHorizon: "SWING", compatibleHorizons: ["SWING", "INTRADAY"], holdingEnvironment: "POSITION_HORIZON", marketApproach: "TREND_FOLLOW" });
  });
  it("7 deterministic replay + frozen", () => {
    const a = classifyHorizon(base({ m5Momentum: "BULLISH" })), b = classifyHorizon(base({ m5Momentum: "BULLISH" }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.isFrozen(a) && Object.isFrozen(a.compatibleHorizons) && Object.isFrozen(a.horizonEvidence.tags)).toBe(true);
    expect(() => { (a as { recommendedHorizon: string }).recommendedHorizon = "X"; }).toThrow();
  });
  it("8 future leakage ignored", () => {
    const fut = classifyHorizon(base({ regime: regime({ asOf: 2000 }) }));
    expect(fut.recommendedHorizon).toBe("NO_FIT");
    expect(fut.evidence).toContain("REGIME_SNAPSHOT_FROM_FUTURE");
    const rangeFuture = classifyHorizon(base({ regime: regime({ regime: "RANGE_COMPRESSION", ctx: { h4: "RANGE" }, rc: { atrPercentile: 0.2 } }), m15Structure: m15("RANGE", 2030, 2000, 5000) }));
    expect(rangeFuture.recommendedHorizon).toBe("NO_FIT");
    const fp = { sweepDetected: true, sweepDirection: "BULLISH" as const, sweepWickDistance: 1, sweepAgeBars: 0, displacementPreceded: false, displacementMagnitude: 0, insideFVG: false, activeFVGId: null, insideOrderBlock: false, activeOrderBlockId: null, timestamp: 9999 };
    expect(classifyHorizon(base({ footprints: fp })).horizonEvidence.tags).not.toContain("FOOTPRINT_SWEEP");
    expect(classifyHorizon(base({ footprints: { ...fp, timestamp: 900 } })).horizonEvidence.tags).toContain("FOOTPRINT_SWEEP");
  });
  it("9 architecture purity (AST import scan + no forbidden output keys)", () => {
    const dir = join(__dirname, "..");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const sf = ts.createSourceFile(f, readFileSync(join(dir, f), "utf8"), ts.ScriptTarget.Latest);
      sf.forEachChild((n) => {
        if (ts.isImportDeclaration(n)) {
          const spec = (n.moduleSpecifier as ts.StringLiteral).text;
          expect(spec).not.toMatch(/(signal|plan|risk|execution)(\/|$)/);
        }
      });
    }
    const out = JSON.stringify(classifyHorizon(base({ m5Momentum: "BULLISH" }))).toLowerCase();
    for (const k of ["\"buy", "\"sell", "\"sl\"", "\"tp", "\"lot", "score", "confidence", "probability", "\"direction"]) expect(out).not.toContain(k);
  });
});
