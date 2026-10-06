import { describe, it, expect } from "vitest";
import type { ArenaCandle } from "../../normalizer/types";
import { SwingDetector } from "../swingDetector";
import { buildStructure, detectStructureShift } from "../structureEngine";

const T0 = 1_760_000_400; // aligned to 900
let seq = 0;
const c = (i: number, o: number, h: number, l: number, cl: number, closed = true, tf: ArenaCandle["timeframe"] = "M15"): ArenaCandle => ({
  id: `X_${tf}_${i}`, symbol: "XAUUSD", timeframe: tf, timestamp: T0 + i * 900,
  open: o, high: h, low: l, close: cl, volume: 0, spread: 0, source: "MT5", isClosed: closed, sequence: ++seq,
});
const feed = (d: SwingDetector, cs: ArenaCandle[]) => cs.flatMap((x) => d.push(x));
// series of [high, low] → candle body inside
const series = (hl: [number, number][]) => hl.map(([h, l], i) => c(i, l + (h - l) * 0.4, h, l, l + (h - l) * 0.6));

describe("M1B.3 swing detector", () => {
  it("detects valid swing high with confirmedAt = close of last right bar", () => {
    const d = new SwingDetector("XAUUSD", "M15");
    const out = feed(d, series([[10, 5], [11, 6], [15, 8], [12, 7], [11, 6]]));
    const h = out.find((s) => s.type === "HIGH")!;
    expect(h.price).toBe(15);
    expect(h.timestamp).toBe(T0 + 2 * 900);
    expect(h.confirmedAt).toBe(T0 + 5 * 900);
  });
  it("detects valid swing low", () => {
    const d = new SwingDetector("XAUUSD", "M15");
    const out = feed(d, series([[20, 15], [19, 14], [17, 10], [18, 12], [19, 13]]));
    expect(out.find((s) => s.type === "LOW")!.price).toBe(10);
  });
  it("does not publish before right bars confirmation, nor from running candles", () => {
    const d = new SwingDetector("XAUUSD", "M15");
    const cs = series([[10, 5], [11, 6], [15, 8], [12, 7]]);
    expect(feed(d, cs)).toHaveLength(0);
    expect(d.push(c(4, 7, 11, 6, 8, false))).toHaveLength(0); // RUNNING rejected
    expect(d.push(c(4, 7, 11, 6, 8, true)).some((s) => s.type === "HIGH")).toBe(true);
  });
  it("rejects M5 as swing anchor", () => {
    expect(() => new SwingDetector("XAUUSD", "M5" as never)).toThrow();
  });
  it("classifies strength from rejection wick", () => {
    const d = new SwingDetector("XAUUSD", "M15");
    feed(d, [c(0, 6, 10, 5, 7), c(1, 7, 11, 6, 8), c(2, 9, 20, 8, 10), c(3, 8, 12, 7, 9), c(4, 7, 11, 6, 8)]);
    const h = d.getSwings().find((s) => s.type === "HIGH")!;
    expect(h.rejectionWickRatio).toBeCloseTo(10 / 12);
    expect(h.strength).toBe("STRONG");
  });
  it("prevents duplicate swings on replayed candles", () => {
    const d = new SwingDetector("XAUUSD", "M15");
    const cs = series([[10, 5], [11, 6], [15, 8], [12, 7], [11, 6]]);
    feed(d, cs); feed(d, cs);
    expect(d.getSwings().filter((s) => s.type === "HIGH")).toHaveLength(1);
  });
});

describe("M1B.3 structure engine", () => {
  const up: [number, number][] = [[10, 5], [12, 6], [15, 8], [13, 7], [12, 6], [14, 9], [18, 10], [16, 11], [15, 9], [17, 12], [21, 13], [19, 14], [18, 13]];
  const down: [number, number][] = up.map(([h, l]) => [100 - l, 100 - h]);
  const run = (hl: [number, number][]) => {
    const d = new SwingDetector("XAUUSD", "M15");
    const cs = series(hl); feed(d, cs);
    return buildStructure("XAUUSD", "M15", d.getSwings(), cs.at(-1)!.timestamp + 900);
  };
  it("HH_HL", () => expect(run(up).trend).toBe("HH_HL"));
  it("LH_LL", () => expect(run(down).trend).toBe("LH_LL"));
  it("MSS: bullish structure closing below last low → BEARISH_MSS; running candle ignored", () => {
    const s = run(up);
    const low = s.lastConfirmedLow!.price;
    expect(detectStructureShift(s, c(20, low + 1, low + 2, low - 3, low - 1, false)).shiftDetected).toBe(false);
    const r = detectStructureShift(s, c(20, low + 1, low + 2, low - 3, low - 1));
    expect(r.structureShift).toBe("BEARISH_MSS");
    console.log(JSON.stringify({ swing: s.lastConfirmedHigh, structure: r }, null, 1));
  });
  it("MSS: bearish structure closing above last high → BULLISH_MSS", () => {
    const s = run(down);
    const hi = s.lastConfirmedHigh!.price;
    expect(detectStructureShift(s, c(20, hi - 1, hi + 3, hi - 2, hi + 1)).structureShift).toBe("BULLISH_MSS");
  });
});
