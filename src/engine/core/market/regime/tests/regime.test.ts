import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { classifyRegime } from "../regimeClassifier";
import type { MarketRegimeInput } from "../types";
import type { MarketStructure, SwingPoint, TrendStructure } from "../../../swing/types";

const sp = (type: "HIGH" | "LOW", price: number, t: number, tf: "H4" | "H1" = "H4"): SwingPoint => ({
  id: `${tf}-${type}-${t}`, symbol: "XAUUSD", timeframe: tf, type, price, timestamp: t, confirmedAt: t + 10,
  strength: "NORMAL", leftBars: 2, rightBars: 2, rejectionWickRatio: 0.3,
});

function struct(trend: TrendStructure, tf: "H4" | "H1" = "H4", shift = false): MarketStructure {
  const bull = trend === "HH_HL", bear = trend === "LH_LL";
  return {
    symbol: "XAUUSD", timeframe: tf, trend,
    previousHigh: sp("HIGH", 2010, 100, tf), previousLow: sp("LOW", 1990, 110, tf),
    lastConfirmedHigh: sp("HIGH", bull ? 2030 : bear ? 1995 : 2011, 200, tf),
    lastConfirmedLow: sp("LOW", bull ? 2005 : bear ? 1970 : 1991, 210, tf),
    structureShift: shift ? "BEARISH_MSS" : "NONE", shiftDetected: shift, lastUpdatedTimestamp: 300,
  };
}
const hist = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
const base = (o: Partial<MarketRegimeInput> = {}): MarketRegimeInput => ({
  symbol: "XAUUSD", now: 1000, h4Structure: struct("HH_HL"), h1Structure: struct("HH_HL", "H1"),
  m15Atr: 10, historicalAtrList: hist, ...o,
});

describe("M1B.9 regime engine", () => {
  it("1 multi-TF alignment → TREND_CONTINUATION", () => {
    const s = classifyRegime(base());
    expect(s.regime).toBe("TREND_CONTINUATION");
    expect(s.trendAlignment).toBe("ALIGNED");
    expect(s.evidence).toEqual(expect.arrayContaining(["H4_STRUCTURE_VALID", "H1_ALIGNMENT", "ATR_NORMAL"]));
  });
  it("2 H4 bullish vs H1 bearish → TRANSITION/CONFLICT", () => {
    const s = classifyRegime(base({ h1Structure: struct("LH_LL", "H1") }));
    expect(s.regime).toBe("TRANSITION");
    expect(s.trendAlignment).toBe("CONFLICT");
    expect(s.structureContext.h1).toBe("PULLBACK");
  });
  it("3 volatility shock overrides trend", () => {
    const s = classifyRegime(base({ m15Atr: 19, h1Structure: struct("LH_LL", "H1") }));
    expect(s.rangeContext.atrPercentile).toBeGreaterThanOrEqual(0.85);
    expect(s.regime).toBe("VOLATILITY_EXPANSION");
  });
  it("4 tight squeeze → RANGE_COMPRESSION", () => {
    const s = classifyRegime(base({ m15Atr: 3, h4Structure: struct("RANGE"), h1Structure: struct("RANGE", "H1") }));
    expect(s.rangeContext.atrPercentile).toBeLessThanOrEqual(0.25);
    expect(s.regime).toBe("RANGE_COMPRESSION");
  });
  it("5 frozen and deterministic", () => {
    const a = classifyRegime(base()), b = classifyRegime(base());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.isFrozen(a) && Object.isFrozen(a.evidence) && Object.isFrozen(a.structureContext)).toBe(true);
    expect(() => { (a as { regime: string }).regime = "X"; }).toThrow();
  });
  it("6 missing higher TF → UNAVAILABLE", () => {
    const s = classifyRegime(base());
    expect(s.structureContext).toMatchObject({ daily: "UNAVAILABLE", weekly: "UNAVAILABLE", monthly: "UNAVAILABLE" });
    expect(classifyRegime(base({ higherTfContext: { daily: "BULLISH" } })).structureContext.daily).toBe("BULLISH");
  });
  it("7 zero modification / zero score contract", () => {
    const input = base();
    const before = JSON.stringify(input);
    const s = classifyRegime(input);
    expect(JSON.stringify(input)).toBe(before);
    const keys = JSON.stringify(s).toLowerCase();
    for (const k of ["direction", "signal", "\"lot", "\"sl\"", "\"tp", "score", "confidence", "buy", "sell"]) expect(keys).not.toContain(k);
    const dir = join(__dirname, "..");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src).not.toMatch(/from ["'][^"']*(execution|risk|plan|signal)[/"']/);
    }
  });
  it("8 historical freeze: future swings do not alter past snapshot", () => {
    const past = classifyRegime(base());
    const h4 = struct("HH_HL");
    const future = { ...h4, previousHigh: h4.lastConfirmedHigh, lastConfirmedHigh: { ...sp("HIGH", 2031, 5000), confirmedAt: 5010 } };
    const again = classifyRegime(base({ h4Structure: { ...h4 } }));
    classifyRegime(base({ h4Structure: future, now: 6000 }));
    expect(JSON.stringify(again)).toBe(JSON.stringify(past));
    // future-confirmed swing at now=1000 is ignored by overlap/flattening/range logic
    const gated = classifyRegime(base({ h4Structure: future }));
    expect(gated.evidence).not.toContain("H4_MOMENTUM_FLATTENING");
    expect(gated.rangeContext.rangeWidth).toBe(0);
  });
});
