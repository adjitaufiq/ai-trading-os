// M1B.3 canonical confirmedAt regression tests (see src/engine/core/swing/AGENTS.md).
// Candle timestamp = BAR OPEN TIME. confirmedAt = close of right bar #2 =
// pivot open + (rightBars + 1) × tf. All values come from the production SwingDetector.
import { describe, it, expect } from "vitest";
import type { ArenaCandle } from "../../normalizer/types";
import { SwingDetector } from "../swingDetector";
import { buildStructure } from "../structureEngine";
import type { MarketStructure, SwingPoint, SwingTimeframe } from "../types";
import { classifyPriceLocation } from "../../location/priceLocationEngine";
import { calculateStopLoss } from "../../../plan/slCalculator";

const at = (hhmm: string, day = 5) => {
  const [h, m] = hhmm.split(":").map(Number);
  return Date.UTC(2026, 9, day, h!, m!) / 1000;
};
const TF: Record<SwingTimeframe, number> = { M15: 900, H1: 3600, H4: 14400 };
let seq = 0;
const bar = (tf: SwingTimeframe, open: number, h: number, l: number, closed = true): ArenaCandle => ({
  id: `X_${tf}_${open}`, symbol: "XAUUSD", timeframe: tf, timestamp: open,
  open: l + (h - l) * 0.4, high: h, low: l, close: l + (h - l) * 0.6,
  volume: 0, spread: 0, source: "MT5", isClosed: closed, sequence: ++seq,
});
/** L1, L2, pivot(high=15 / low=…), R1, R2 with pivot open at `pivotOpen`. */
const pivotHighSeries = (tf: SwingTimeframe, pivotOpen: number) => {
  const d = TF[tf];
  const hl: [number, number][] = [[10, 5], [11, 6], [15, 8], [12, 7], [11, 6]];
  return hl.map(([h, l], i) => bar(tf, pivotOpen + (i - 2) * d, h, l));
};
const run = (tf: SwingTimeframe, pivotOpen: number) => {
  const det = new SwingDetector("XAUUSD", tf);
  const out = pivotHighSeries(tf, pivotOpen).flatMap((c) => det.push(c));
  return { det, high: out.find((s) => s.type === "HIGH")! };
};

describe("M1B.3 canonical confirmedAt (timestamp = bar open)", () => {
  it("A. M15 pivot open 10:00 → confirmedAt 10:45", () => {
    const { high } = run("M15", at("10:00"));
    expect(high.timestamp).toBe(at("10:00"));
    expect(high.confirmedAt).toBe(at("10:45"));
    expect(high.confirmedAt).not.toBe(at("10:30"));
  });

  it("B/C. buildStructure: asOf 10:30 excludes the swing, asOf 10:45 includes it", () => {
    const { det } = run("M15", at("10:00"));
    expect(buildStructure("XAUUSD", "M15", det.getSwings(), at("10:30")).lastConfirmedHigh).toBeNull();
    expect(buildStructure("XAUUSD", "M15", det.getSwings(), at("10:44")).lastConfirmedHigh).toBeNull();
    expect(buildStructure("XAUUSD", "M15", det.getSwings(), at("10:45")).lastConfirmedHigh?.price).toBe(15);
  });

  it("D. FORMING right bar #2 that still preserves the pivot does not emit early", () => {
    const det = new SwingDetector("XAUUSD", "M15");
    const cs = pivotHighSeries("M15", at("10:00"));
    expect(cs.slice(0, 4).flatMap((c) => det.push(c))).toHaveLength(0);
    expect(det.push({ ...cs[4]!, isClosed: false })).toHaveLength(0);
    expect(det.getSwings()).toHaveLength(0);
  });

  it("E. right bar #2 invalidating the pivot before close → no swing ever existed", () => {
    const det = new SwingDetector("XAUUSD", "M15");
    const cs = pivotHighSeries("M15", at("10:00"));
    cs.slice(0, 4).forEach((c) => det.push(c));
    det.push({ ...cs[4]!, isClosed: false }); // forming, preserving
    const out = det.push(bar("M15", at("10:30"), 16, 6)); // closes above pivot high 15
    expect(out.some((s) => s.type === "HIGH" && s.timestamp === at("10:00"))).toBe(false);
    expect(det.getSwings().some((s) => s.type === "HIGH" && s.timestamp === at("10:00"))).toBe(false);
  });

  it("F. H1 pivot open 10:00 → confirmedAt 13:00", () => {
    expect(run("H1", at("10:00")).high.confirmedAt).toBe(at("13:00"));
  });

  it("G. H4 pivot open 08:00 → confirmedAt 20:00", () => {
    expect(run("H4", at("08:00")).high.confirmedAt).toBe(at("20:00"));
  });
});

describe("M1B.3 downstream look-ahead guards (confirmedAt > now ⇒ unusable)", () => {
  const swingsFor = () => {
    const det = new SwingDetector("XAUUSD", "M15");
    // high pivot open 10:00 (15), low pivot open 11:00 (2)
    const hl: [number, number][] = [[10, 5], [11, 6], [15, 8], [12, 7], [11, 6], [10, 4], [9, 2], [10, 4], [11, 5]];
    hl.forEach(([h, l], i) => det.push(bar("M15", at("09:30") + i * 900, h, l)));
    const s = det.getSwings();
    return { high: s.find((x) => x.type === "HIGH")!, low: s.find((x) => x.type === "LOW")! };
  };
  const struct = (high: SwingPoint, low: SwingPoint): MarketStructure => ({
    symbol: "XAUUSD", timeframe: "M15", trend: "RANGE",
    lastConfirmedHigh: high, lastConfirmedLow: low, previousHigh: null, previousLow: null,
    structureShift: "NONE", shiftDetected: false, lastUpdatedTimestamp: 0,
  });

  it("fixture: low pivot open 11:00 confirms 11:45", () => {
    const { high, low } = swingsFor();
    expect(high.confirmedAt).toBe(at("10:45"));
    expect(low.timestamp).toBe(at("11:00"));
    expect(low.confirmedAt).toBe(at("11:45"));
  });

  it("priceLocationEngine: unconfirmed swing cannot form S/R", () => {
    const { high, low } = swingsFor();
    const r = classifyPriceLocation({ currentPrice: 8, m15Structure: struct(high, low), m15Candles: [], now: at("11:30") });
    expect(r).toEqual({ ok: false, reason: "NO_CONFIRMED_LEVELS" });
    const r2 = classifyPriceLocation({ currentPrice: 8, m15Structure: struct(high, low), m15Candles: [], now: at("11:45") });
    expect(r2.ok === false && r2.reason).not.toBe("NO_CONFIRMED_LEVELS");
  });

  it("slCalculator: unconfirmed swing cannot anchor SL (so cannot drive sizing)", () => {
    const { high, low } = swingsFor();
    const base = { direction: "BUY" as const, entry: 3, keyLevel: Number.NaN, m15Structure: struct(high, low), atr: 2 };
    expect(calculateStopLoss({ ...base, now: at("11:30") })).toEqual({ ok: false, reason: "NO_SL_ANCHOR" });
    const ok = calculateStopLoss({ ...base, now: at("11:45") });
    expect(ok.ok && ok.source).toBe("M15_CONFIRMED_SWING");
  });
});
