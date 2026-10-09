// SwingDetector tie-rule conformance (rule B): LEFT neighbours strict, RIGHT neighbours allow equality.
// Proves the production M1B.3 detector already implements the canonical tie rule — no production change here.
import { describe, expect, it } from "vitest";
import type { ArenaCandle } from "../../normalizer/types";
import { SwingDetector } from "../swingDetector";

const TF = 900; // M15, seconds (ArenaCandle timestamp = bar open, seconds epoch)
const T0 = 1_700_000_000;
let seq = 0;
const bar = (h: number, l: number, i: number, closed = true): ArenaCandle => {
  const timestamp = T0 + i * TF;
  return {
    id: `X_${timestamp}`, symbol: "XAUUSD", timeframe: "M15", timestamp,
    open: l + (h - l) * 0.3, high: h, low: l, close: l + (h - l) * 0.7,
    volume: 0, spread: 0, source: "MT5", isClosed: closed, sequence: ++seq,
  };
};
const feed = (rows: [number, number][], closedFlags?: boolean[]): { det: SwingDetector; out: ReturnType<SwingDetector["push"]>[] } => {
  const det = new SwingDetector("XAUUSD", "M15");
  const out = rows.map(([h, l], i) => det.push(bar(h, l, i, closedFlags ? closedFlags[i] : true)));
  return { det, out };
};
const highs = (rows: number[]) => rows.map((h) => [h, h - 1] as [number, number]);
const highPivots = (out: ReturnType<SwingDetector["push"]>[]) => out.flat().filter((s) => s.type === "HIGH");
const lowPivots = (out: ReturnType<SwingDetector["push"]>[]) => out.flat().filter((s) => s.type === "LOW");

describe("SwingDetector tie rule B (left strict, right allows equality)", () => {
  it("A. equal HIGH on the right side: the first bar of the run owns the pivot", () => {
    const { out } = feed(highs([10, 11, 15, 15, 12]));
    const hs = highPivots(out);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.timestamp).toBe(T0 + 2 * TF);
    expect(hs[0]!.price).toBe(15);
  });
  it("B. equal LOW on the right side: mirror rule", () => {
    const rows: [number, number][] = [[10, 10], [9.8, 9], [9.6, 5], [9.4, 5], [9.2, 6]];
    const { out } = feed(rows);
    const ls = lowPivots(out);
    expect(ls).toHaveLength(1);
    expect(ls[0]!.timestamp).toBe(T0 + 2 * TF);
    expect(ls[0]!.price).toBe(5);
  });
  it("C/D. HIGH and LOW plateau: exactly one pivot at the first bar of the run", () => {
    const { out } = feed(highs([10, 11, 15, 15, 15, 12, 11]));
    expect(highPivots(out)).toHaveLength(1);
    const rows: [number, number][] = [[12, 10], [12, 9], [13, 5], [13, 5], [13, 5], [13, 8], [13, 9]];
    const { out: outL } = feed(rows);
    expect(lowPivots(outL)).toHaveLength(1);
  });
  it("E. equal LEFT neighbour is still rejected (left stays strict)", () => {
    const { out } = feed(highs([10, 15, 15, 13, 12]));
    expect(out.flat()).toHaveLength(0);
    expect(out.every((p) => p.length === 0)).toBe(true);
  });
  it("F. no duplicate pivots on an equal run", () => {
    const { det } = feed(highs([10, 11, 15, 15, 15, 12, 11]));
    const all = det.getSwings();
    const times = all.filter((s) => s.type === "HIGH").map((s) => s.timestamp);
    expect(new Set(times).size).toBe(times.length);
    expect(times).toHaveLength(1);
  });
  it("G. confirmedAt = close of right bar #2; needs both right bars", () => {
    const { out } = feed(highs([10, 11, 15, 15, 12]));
    const hs = highPivots(out);
    expect(hs[0]!.confirmedAt).toBe(T0 + 4 * TF + TF);
    const short = feed(highs([10, 11, 15, 15]));
    expect(short.out.flat()).toHaveLength(0);
  });
  it("H. FORMING right bar #2 emits nothing early; the closed bar completes the pivot", () => {
    const rows = highs([10, 11, 15, 15, 12]);
    const det = new SwingDetector("XAUUSD", "M15");
    expect(rows.slice(0, 4).map(([h, l], i) => det.push(bar(h, l, i))).flat()).toHaveLength(0);
    expect(det.push({ ...bar(rows[4]![0], rows[4]![1], 4, false) })).toHaveLength(0);
    expect(det.getSwings()).toHaveLength(0);
    expect(det.push(bar(rows[4]![0], rows[4]![1], 4))).toHaveLength(1);
    expect(det.getSwings().filter((s) => s.type === "HIGH")).toHaveLength(1);
  });
});
