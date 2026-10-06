import { describe, it, expect } from "vitest";
import type { ArenaCandle } from "../../../normalizer/types";
import type { MarketStructure, SwingPoint } from "../../../swing/types";
import { scanInstitutionalFootprints } from "../institutionalRadar";
import { trackFVGs } from "../fvgTracker";
import { detectOrderBlocks } from "../orderBlockDetector";
import { toFootprintSnapshot } from "../types";
import { fromPaperTrade } from "../../../../journal/tradeJournal";
import { openTrade } from "../../../../execution/tests/helpers";

const T0 = 1_760_000_100;
const c = (i: number, o: number, h: number, l: number, cl: number, closed = true): ArenaCandle => ({
  id: `X_M5_${i}`, symbol: "XAUUSD", timeframe: "M5", timestamp: T0 + i * 300,
  open: o, high: h, low: l, close: cl, volume: 0, spread: 0, source: "MT5", isClosed: closed, sequence: i + 1,
});
const sw = (type: "HIGH" | "LOW", price: number): SwingPoint => ({
  id: `S_${type}`, symbol: "XAUUSD", timeframe: "M15", type, price, timestamp: T0 - 3600, confirmedAt: T0 - 1800,
  strength: "NORMAL", leftBars: 2, rightBars: 2, rejectionWickRatio: 0.3,
});
const st = (low: number | null, high: number | null): MarketStructure => ({
  symbol: "XAUUSD", timeframe: "M15", trend: "RANGE",
  lastConfirmedHigh: high === null ? null : sw("HIGH", high), lastConfirmedLow: low === null ? null : sw("LOW", low),
  previousHigh: null, previousLow: null, structureShift: "NONE", shiftDetected: false, lastUpdatedTimestamp: T0,
});

describe("M1B.8 liquidity sweep", () => {
  it("Test 1 valid bullish sweep", () => {
    const f = scanInstitutionalFootprints({ candles: [c(0, 2651, 2653, 2648, 2652)], structure: st(2650, 2700), atr14M15: 2 });
    expect(f).toMatchObject({ sweepDetected: true, sweepDirection: "BULLISH", sweepAgeBars: 0, sweepWickDistance: 2 });
  });
  it("Test 2 false breakout (close below) is not a sweep", () => {
    const f = scanInstitutionalFootprints({ candles: [c(0, 2651, 2652, 2648, 2649)], structure: st(2650, 2700), atr14M15: 2 });
    expect(f.sweepDetected).toBe(false);
  });
  it("bearish sweep", () => {
    const f = scanInstitutionalFootprints({ candles: [c(0, 2699, 2703, 2698, 2698.5)], structure: st(2650, 2700), atr14M15: 2 });
    expect(f).toMatchObject({ sweepDetected: true, sweepDirection: "BEARISH" });
  });
  it("TTL: age 3 still relevant, age 4 dropped", () => {
    const filler = (i: number) => c(i, 2660, 2661, 2659, 2660);
    const s = st(2650, 2700); const sweep = c(0, 2651, 2653, 2648, 2652);
    expect(scanInstitutionalFootprints({ candles: [sweep, filler(1), filler(2), filler(3)], structure: s, atr14M15: 2 }).sweepAgeBars).toBe(3);
    expect(scanInstitutionalFootprints({ candles: [sweep, filler(1), filler(2), filler(3), filler(4)], structure: s, atr14M15: 2 }).sweepDetected).toBe(false);
  });
  it("ignores RUNNING candles", () => {
    const f = scanInstitutionalFootprints({ candles: [c(0, 2651, 2653, 2648, 2652, false)], structure: st(2650, 2700), atr14M15: 2 });
    expect(f.sweepDetected).toBe(false);
    expect(f.timestamp).toBe(0);
  });
});

describe("M1B.8 displacement", () => {
  it("Test 3 body 3 / ATR 1.5 = 2 and breaks swing high", () => {
    const f = scanInstitutionalFootprints({ candles: [c(0, 99, 102.2, 98.9, 102)], structure: st(90, 101), atr14M15: 1.5 });
    expect(f).toMatchObject({ displacementPreceded: true, displacementMagnitude: 2 });
  });
  it("large body without structure break is not displacement", () => {
    const f = scanInstitutionalFootprints({ candles: [c(0, 95, 98.2, 94.9, 98)], structure: st(90, 101), atr14M15: 1.5 });
    expect(f.displacementPreceded).toBe(false);
  });
  it("break with small body is not displacement", () => {
    const f = scanInstitutionalFootprints({ candles: [c(0, 100.5, 101.6, 100.4, 101.5)], structure: st(90, 101), atr14M15: 1.5 });
    expect(f.displacementPreceded).toBe(false);
  });
});

describe("M1B.8 FVG", () => {
  it("Test 4 lifecycle ACTIVE → MITIGATED", () => {
    const base = [c(0, 99, 100, 98, 99.5), c(1, 100, 104, 100, 103.5), c(2, 103.5, 105, 103, 104.5)];
    expect(trackFVGs(base)[0]!).toMatchObject({ direction: "BULLISH", top: 103, bottom: 100, status: "ACTIVE" });
    expect(trackFVGs([...base, c(3, 104, 104.2, 99, 101)])[0]!.status).toBe("MITIGATED");
  });
  it("close beyond far edge before mitigation ⇒ INVALIDATED", () => {
    const base = [c(0, 99, 100, 98, 99.5), c(1, 100, 104, 100, 103.5), c(2, 103.5, 105, 103, 104.5)];
    expect(trackFVGs([...base, c(3, 104, 104.2, 97, 98)])[0]!.status).toBe("INVALIDATED");
  });
  it("bearish FVG detected", () => {
    const z = trackFVGs([c(0, 105, 106, 104, 104.5), c(1, 104, 104, 100, 100.5), c(2, 100.5, 101, 99, 99.5)]);
    expect(z[0]).toMatchObject({ direction: "BEARISH", top: 104, bottom: 101 });
  });
});

describe("M1B.8 strict order block", () => {
  it("Test 5 rejects bearish+bullish without displacement/break", () => {
    expect(detectOrderBlocks([c(0, 100, 100.5, 99, 99.2), c(1, 99.2, 100.4, 99.1, 100.3)], st(90, 101), 1.5)).toHaveLength(0);
  });
  it("Test 5 accepts bearish → displacement → M15 break", () => {
    const obs = detectOrderBlocks([c(0, 100, 100.5, 99, 99.2), c(1, 99.2, 103, 99.1, 102.8)], st(90, 101), 1.5);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ direction: "BULLISH", high: 100.5, low: 99, status: "ACTIVE" });
  });
  it("close below OB.low invalidates; inside reported only when ACTIVE", () => {
    const s = st(90, 101); const cs = [c(0, 100, 100.5, 99, 99.2), c(1, 99.2, 103, 99.1, 102.8), c(2, 102, 102.2, 99.5, 100)];
    expect(scanInstitutionalFootprints({ candles: cs, structure: s, atr14M15: 1.5 }).insideOrderBlock).toBe(true);
    expect(detectOrderBlocks([...cs, c(3, 100, 100.1, 97, 98)], s, 1.5)[0]!.status).toBe("INVALIDATED");
  });
});

describe("M1B.8 boundaries", () => {
  it("output is raw evidence only, frozen, deterministic, input untouched", () => {
    const cs = [c(0, 2651, 2653, 2648, 2652)]; const snap = JSON.stringify(cs); const s = st(2650, 2700);
    const a = scanInstitutionalFootprints({ candles: cs, structure: s, atr14M15: 2 });
    expect(a).toEqual(scanInstitutionalFootprints({ candles: cs, structure: s, atr14M15: 2 }));
    expect(Object.isFrozen(a)).toBe(true);
    expect(JSON.stringify(cs)).toBe(snap);
    for (const k of ["direction", "signal", "stopLoss", "takeProfit", "lot", "risk", "score", "grade"]) expect(a).not.toHaveProperty(k);
  });
  it("M6 journal stores optional footprint snapshot; absent stays absent", () => {
    const t = openTrade();
    const closed = { ...t, state: "CLOSED" as const, openedAt: 1, closedAt: 2, result: { exit: 2008, profitLossUSD: 100, profitLossPercent: 1, closeReason: "TP", durationSeconds: 1 } };
    const fp = toFootprintSnapshot(scanInstitutionalFootprints({ candles: [c(0, 2651, 2653, 2648, 2652)], structure: st(2650, 2700), atr14M15: 2 }));
    const row = fromPaperTrade(closed as never, { h1Phase: "X", locationTier: "A", rr: 1.6 }, undefined, fp)!;
    expect(row.footprints).toEqual({ sweepDetected: true, insideFVG: false, insideOrderBlock: false, displacementPreceded: false });
    expect(row.stopLoss).toBe(1995);
    expect(fromPaperTrade(closed as never, { h1Phase: "X", locationTier: "A", rr: 1.6 })!).not.toHaveProperty("footprints");
  });
});
