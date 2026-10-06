import { describe, expect, it } from "vitest";
import { calculateEMA, classifySlope } from "../emaCalculator";
import { bar, range, series } from "./helpers";

function manual(closes: number[], p: number): number {
  let e = closes.slice(0, p).reduce((a, b) => a + b, 0) / p;
  const k = 2 / (p + 1);
  for (let i = p; i < closes.length; i++) e = closes[i]! * k + e * (1 - k);
  return e;
}

describe("M1B.6 EMA calculator", () => {
  it("EMA5 accuracy (SMA seed + k=2/6)", () => {
    const closes = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    const r = calculateEMA(series(closes), 5) as number[];
    // seed=12, then 15→ (15/3+12*2/3)=13 ... hand value for last:
    expect(r[4]).toBe(12);
    expect(r[5]).toBeCloseTo(13, 10);
    expect(r[9]).toBeCloseTo(manual(closes, 5), 10);
    expect(r[9]).toBeCloseTo(17.00274348, 6);
  });

  it("EMA21 accuracy", () => {
    const closes = range(40, (i) => 2600 + Math.sin(i) * 5 + i * 0.3);
    const r = calculateEMA(series(closes), 21) as number[];
    expect(r[39]).toBeCloseTo(manual(closes, 21), 10);
    expect(Number.isNaN(r[19]!)).toBe(true);
  });

  it("EMA50 rejects insufficient history (99 < 100)", () => {
    expect(calculateEMA(series(range(99, () => 2600)), 50)).toBe("INSUFFICIENT_HISTORY");
    expect(Array.isArray(calculateEMA(series(range(100, () => 2600)), 50))).toBe(true);
  });

  it("EMA5/EMA21 minimum history enforced", () => {
    expect(calculateEMA(series(range(9, () => 1)), 5)).toBe("INSUFFICIENT_HISTORY");
    expect(calculateEMA(series(range(39, () => 1)), 21)).toBe("INSUFFICIENT_HISTORY");
  });

  it("ignores running candle", () => {
    const c = series(range(10, (i) => 10 + i));
    const withRun = [...c, bar(10, 19, 999, 999, 19, false)];
    expect(calculateEMA(withRun, 5)).toEqual(calculateEMA(c, 5));
  });

  it("slope classification", () => {
    expect(classifySlope([1, 2, 3, 4], 1)).toBe("RISING");
    expect(classifySlope([4, 3, 2, 1], 1)).toBe("FALLING");
    expect(classifySlope([1, 1.01, 1.02, 1.03], 1)).toBe("FLAT");
  });
});
